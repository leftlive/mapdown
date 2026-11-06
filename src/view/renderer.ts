// The map renderer: draws a RenderModel as absolutely positioned node
// elements plus one SVG of edges inside a CSS-transformed canvas, and turns
// pointer input into RenderEvents (development plan 3.4, 3.5; behaviour
// spec 4). DOM is keyed by MapNode.id; an update only rewrites what changed.
//
// Frame order: write node contents, read every needed size in one pass,
// lay out, then write positions. Maps with more than VIRTUALIZE_THRESHOLD
// visible nodes only get DOM near the viewport; the rest use estimates.

import { Platform } from "obsidian";
import type { MapNode, Point, Size } from "../core/types.ts";
import { branchLook, createLayouter, type LayoutInput, type LayoutResult, type NodePlacement } from "../core/layout.ts";
import {
	DOM,
	type CreateRenderer,
	type DropPlace,
	type EditorHandle,
	type MapRenderer,
	type Modifiers,
	type RenderEvents,
	type RenderHost,
	type RenderModel,
} from "./contract.ts";
import { isElement, isNode } from "./domSafe.ts";
import { insertAt, toggleWrap as toggleWrapText, type TextSel } from "./editText.ts";
import {
	MEASURE_SENTINEL,
	MeasureGate,
	SizeCache,
	boxSize,
	domSize,
	estimateSize,
	fontFor,
	isPlainText,
	markdownSource,
	sizeKey,
	type NodeFont,
} from "./measure.ts";
import { Minimap, shouldShowMinimap } from "./minimap.ts";
import { edgeScroll } from "./autoScroll.ts";
import { connectorEnds, isPhantom, phantomId, previewInput, realId, type PreviewSpec } from "./dragPreview.ts";
import { GestureRecognizer, wheelAction, type BoxRect, type GestureSink, type PointerInput, type Target } from "./pointer.ts";
import {
	anchorPoint,
	anchorShift,
	centerOnRect,
	clampZoom,
	focusViewport,
	fitBounds,
	revealRect,
	uncoveredArea,
	toWorld,
	visibleRect,
	zoomAt,
	type Rect,
	type Viewport,
} from "./viewport.ts";
import {
	REFRESH_MARGIN,
	VIRTUALIZE_THRESHOLD,
	WINDOW_MARGIN,
	MAX_DOM_NODES,
	boxHits,
	capWindow,
	dropPlace,
	edgeInWindow,
	hitTest,
	needsWindowRefresh,
	pickAnchor,
	selectWindow,
} from "./virtualize.ts";
import { isImageFile } from "../nodeImage.ts";

/** Keep in sync with the transition duration in styles.css. */
const ANIMATION_MS = 200;
const REVEAL_PAD = 40;
const FIT_PAD = 40;
/** Focus mode never zooms out further than this to show the subtree (spec 5.3). */
const FOCUS_MIN_ZOOM = 0.5;
/** Floating UI over the map; "show on screen" moves use only the area they leave free (spec 5.1). */
const COVERING_UI = [DOM.toolbar, DOM.mobileToolbar, DOM.minimap];
const EDGE_PAD = 20;

const CLS = {
	map: "mapdown-map",
	content: "mapdown-node-content",
	badge: "mapdown-node-badge",
	toggle: "mapdown-node-toggle",
	root: "is-root",
	level1: "is-level-1",
	level2: "is-level-2",
	deep: "is-level-deep",
	empty: "is-empty",
	rich: "is-rich",
	left: "is-left",
	entering: "is-entering",
	animating: "is-animating",
	dragging: "is-dragging",
	box: "mapdown-box-select",
	drop: "mapdown-drop-indicator",
	ghost: "mapdown-drag-ghost",
	ghostCard: "mapdown-drag-ghost-card",
	ghostCount: "mapdown-drag-ghost-count",
	connector: "mapdown-drag-connector",
	dragSource: "is-drag-source",
	dropParent: "is-drop-parent",
	dropEdge: "is-drop-edge",
	nodeDragging: "is-node-dragging",
	dropPreview: "has-drop-preview",
	rootEdge: "is-root-edge",
	panning: "is-panning",
} as const;

/** One visible node in the current model. */
interface Item {
	node: MapNode;
	depth: number;
	parent: string | null;
	plain: boolean;
	font: NodeFont;
	key: string;
	/** Has children that are hidden. */
	collapsed: boolean;
	/** Visible children, in order. */
	kids: string[];
}

/** DOM of one rendered node and what was last written to it. */
interface NodeView {
	id: string;
	el: HTMLElement;
	content: HTMLElement;
	badge: HTMLElement | null;
	/** Collapse dot on the outer side (expanded nodes with children). */
	toggle: HTMLElement | null;
	/** Content key currently shown; null forces a rewrite. */
	key: string | null;
	rich: boolean;
	/** Rendered Markdown (or plain text) is in place and can be measured. */
	ready: boolean;
	token: number;
	x: number;
	y: number;
	w: number;
	h: number;
	fontPx: number;
	color: string;
	selected: boolean;
	primary: boolean;
	collapsed: boolean;
	count: number;
	level: number;
	side: string;
	expanded: string;
	tab: number;
}

interface PathView {
	el: SVGPathElement;
	d: string;
	color: string;
	fromRoot: boolean;
	/** Dashed edge from the drop parent to a placeholder. */
	drop: boolean;
}

interface EditState {
	id: string;
	el: HTMLElement;
	abort: AbortController;
	composing: boolean;
	size: Size | null;
}

interface DragState {
	ids: string[];
	/** The node under the pointer at drag start; the ghost and the placeholder show it. */
	grabbed: string;
	/** Dragged nodes and their descendants: never drop targets, kept in place (faded) while dragging. */
	exclude: Set<string>;
	/** Layout at drag start. Hit-testing uses it, so the preview making room never moves the target. */
	frozen: LayoutResult;
	/** Grab point relative to the grabbed node's top-left corner, world units. */
	grab: Point;
	ghost: HTMLElement;
	/** The placeholder box (is-before / is-after / is-child, or is-hidden). */
	indicator: HTMLElement;
	connector: SVGSVGElement;
	line: SVGLineElement;
	target: { id: string; place: DropPlace } | null;
	copy: boolean;
	/** Drop the preview layout was made for ("" while there is none); re-laid out only when it changes. */
	key: string;
	preview: PreviewSpec | null;
	/** Highlighted parent of the placeholder. */
	parentId: string | null;
}

/** The moved node flies from the ghost to its new place in the next update (spec 4.1). */
interface DropFlight {
	id: string;
	/** World top-left of the ghost card at release. */
	from: Point;
}

interface RenderOpts {
	anchorId: string | null;
	/** Anchor position before the change (world); defaults to its last placement. */
	anchorBefore?: NodePlacement | null;
	animate: boolean;
}

export const createRenderer: CreateRenderer = (container, host, events) => new Renderer(container, host, events);

class Renderer implements MapRenderer {
	private readonly host: RenderHost;
	private readonly events: RenderEvents;
	private readonly container: HTMLElement;
	// Read on use: the leaf can move to a popout window after the renderer is built.
	private get doc(): Document {
		return this.container.ownerDocument;
	}
	private get win(): Window & { ResizeObserver: typeof ResizeObserver } {
		return this.doc.defaultView ?? window;
	}
	private readonly minimap: Minimap;
	private minimapSig = "";
	private readonly rootEl: HTMLElement;
	private readonly canvas: HTMLElement;
	private readonly svg: SVGSVGElement;
	private readonly abort = new AbortController();
	private readonly resizeObserver: ResizeObserver;
	private readonly richObserver: ResizeObserver;
	private readonly gestures: GestureRecognizer;
	private readonly layouter = createLayouter();
	private readonly sizes = new SizeCache();
	private readonly gate: MeasureGate;
	/** Frame of the poll that waits for styles.css (only while a read was skipped for it). */
	private cssPoll: number | null = null;
	private readonly cssD: boolean;
	private readonly timers = new Set<number>();

	private model: RenderModel | null = null;
	private items = new Map<string, Item>();
	private order: string[] = [];
	private layoutRoot: string | null = null;
	/** Depth in the whole tree of the root of what is drawn (focus mode); fonts follow the real depth. */
	private baseDepth = 0;
	/** Pointer that went down on a collapse handle; the click that follows toggles. */
	private toggleDown: number | null = null;
	/** Focus mode on a non-root node: the side and colour its branch has in the whole map. */
	private focusLook: { side: "left" | "right"; color: string } | null = null;
	private lay: LayoutResult | null = null;
	private colors = new Map<string, string>();
	private views = new Map<string, NodeView>();
	private paths = new Map<string, PathView>();
	private vp: Viewport = { x: 0, y: 0, scale: 1 };
	private width = 0;
	private height = 0;
	private covered: Rect | null = null;
	/** Zoom of the last window when it was capped at MAX_DOM_NODES; null when not capped. */
	private cappedScale: number | null = null;
	private virtual = false;
	private edit: EditState | null = null;
	/** Node being edited; set before the editor exists so the node stays pinned. */
	private editId: string | null = null;
	private drag: DragState | null = null;
	/** Last pointer position of a node drag, and the auto-scroll frame. */
	private dragAt: Point | null = null;
	private dragFrame: number | null = null;
	private dropFlight: DropFlight | null = null;
	private box: HTMLElement | null = null;
	private gestureRect: DOMRect | null = null;
	private lastEvent: PointerEvent | null = null;
	private linkDown: { pointerId: number; href: string } | null = null;
	private settleIds = new Set<string>();
	private frame: number | null = null;
	private windowCheck = false;
	private animTimer: number | null = null;
	private centered = false;
	private userMoved = false;
	private destroyed = false;
	private measureCtx: CanvasRenderingContext2D | null = null;
	private measureFont = "";
	private fontFamily = "";
	private svgBox = "";

	constructor(container: HTMLElement, host: RenderHost, events: RenderEvents) {
		this.host = host;
		this.events = events;
		this.container = container;
		this.minimap = new Minimap(container, (p) => this.centerOnPoint(p));
		this.cssD = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("d", 'path("M 0 0")');

		this.rootEl = container.createDiv({ cls: CLS.map });
		this.rootEl.setAttr("role", "tree");
		this.rootEl.setAttr("aria-multiselectable", "true");
		this.canvas = this.rootEl.createDiv({ cls: DOM.canvas });
		this.svg = this.canvas.createSvg("svg", { cls: DOM.edges });
		this.svg.setAttr("aria-hidden", "true");
		this.gate = new MeasureGate(
			() => this.probeCss(),
			() => this.rootEl.offsetWidth > 0 && this.rootEl.offsetHeight > 0,
		);

		const isMac = Platform.isMacOS;
		const sink = this.gestureSink();
		this.gestures = new GestureRecognizer(
			sink,
			{
				setTimeout: (fn, ms) => this.setTimer(fn, ms),
				clearTimeout: (h) => this.clearTimer(h),
			},
			() => this.win.performance.now(),
			isMac,
		);

		const opts = { signal: this.abort.signal };
		const el = this.rootEl;
		el.addEventListener("pointerdown", (e) => this.onPointerDown(e), opts);
		el.addEventListener("pointermove", (e) => this.onPointer(e, "move"), opts);
		el.addEventListener("pointerup", (e) => this.onPointer(e, "up"), opts);
		el.addEventListener("pointercancel", (e) => this.onPointer(e, "cancel"), opts);
		// only a capture taken away from the map itself ends a gesture; the implicit
		// touch capture moving from a node to the map must not
		el.addEventListener("lostpointercapture", (e) => {
			if (e.target === el) this.onPointer(e, "cancel");
		}, opts);
		this.win.addEventListener("blur", () => this.gestures.abort(), opts);
		el.addEventListener("wheel", (e) => this.onWheel(e), { signal: this.abort.signal, passive: false });
		el.addEventListener("contextmenu", (e) => this.onContextMenu(e), opts);
		el.addEventListener("click", (e) => this.onNativeClick(e), opts);
		el.addEventListener("mouseover", (e) => this.onLinkHover(e), opts);
		el.addEventListener("auxclick", (e) => this.onNativeClick(e), opts);
		el.addEventListener("dragstart", (e) => {
			if (!this.inEditor(e.target)) e.preventDefault();
		}, opts);
		// the map never scrolls natively; a focus() or caret move must not shift it
		el.addEventListener("scroll", () => {
			el.scrollTop = 0;
			el.scrollLeft = 0;
		}, opts);

		this.resizeObserver = new this.win.ResizeObserver((entries) => {
			const oldW = this.width;
			const oldH = this.height;
			for (const entry of entries) {
				this.width = entry.contentRect.width;
				this.height = entry.contentRect.height;
			}
			if (!this.centered && !this.userMoved && this.width > 0 && this.lay) this.centerOn(null);
			else if (oldW > 0 && oldH > 0 && this.width > 0 && this.height > 0) {
				// Keep the point at the middle of the view in the middle when the pane resizes (split, sidebar).
				const dx = (this.width - oldW) / 2;
				const dy = (this.height - oldH) / 2;
				if (dx !== 0 || dy !== 0) this.setViewport({ x: this.vp.x + dx, y: this.vp.y + dy, scale: this.vp.scale });
			}
			// a map laid out while hidden kept its estimates; measure them now that it shows
			if (this.gate.retry()) this.remeasure();
			this.scheduleWindowCheck();
		});
		this.resizeObserver.observe(el);
		this.richObserver = new this.win.ResizeObserver((entries) => {
			for (const entry of entries) {
				const id = entry.target.parentElement?.getAttribute(DOM.nodeIdAttr);
				if (id) this.settleIds.add(id);
			}
			this.scheduleFrame();
		});
		this.width = el.clientWidth;
		this.height = el.clientHeight;
		this.fontFamily = this.win.getComputedStyle(el).fontFamily;
	}

	// ---- public API ---------------------------------------------------------

	get zoom(): number {
		return this.vp.scale;
	}

	update(model: RenderModel, opts?: { anchorId?: string | null; animate?: boolean }): void {
		if (this.destroyed) return;
		const anchorId = opts?.anchorId ?? null;
		const anchorBefore = anchorId ? this.lay?.nodes.get(anchorId) ?? null : null;
		const settingsChanged =
			this.model === null ||
			this.model.nodeMaxWidth !== model.nodeMaxWidth ||
			this.model.nodeGlowSize !== model.nodeGlowSize;
		this.model = model;
		const flight = this.dropFlight;
		this.dropFlight = null;
		if (flight) this.startFlight(flight);
		if (settingsChanged) {
			// each level subtracts its own padding from this (styles.css)
			this.rootEl.style.setProperty("--mapdown-node-max-width", `${model.nodeMaxWidth}px`);
			this.rootEl.style.setProperty("--mapdown-glow-size", `${model.nodeGlowSize}px`);
		}
		this.buildItems(model);
		if (this.edit && !this.items.has(this.edit.id)) this.stopEditing();
		this.render({ anchorId, anchorBefore, animate: (opts?.animate ?? false) || flight !== null });
		if (!this.centered && !this.userMoved && this.width > 0) this.centerOn(null);
	}

	nodeElement(id: string): HTMLElement | null {
		return this.views.get(id)?.el ?? null;
	}

	layoutSnapshot(): LayoutResult | null {
		return this.lay;
	}

	renderedIds(): string[] {
		return [...this.views.keys()];
	}

	scrollIntoView(id: string): void {
		const p = this.lay?.nodes.get(id);
		if (!p) return;
		const next = revealRect(this.vp, p, this.area(), REVEAL_PAD);
		if (next !== this.vp) this.setViewport(next);
		this.refreshWindowNow();
	}

	get viewport(): Viewport {
		return { ...this.vp };
	}

	restoreViewport(vp: Viewport): void {
		this.setViewport({ x: vp.x, y: vp.y, scale: clampZoom(vp.scale) });
		this.refreshWindowNow();
	}

	fitFocus(): void {
		const lay = this.lay;
		const focus = this.layoutRoot ? lay?.nodes.get(this.layoutRoot) : undefined;
		if (!lay || !focus || this.width <= 0 || this.height <= 0) return;
		this.centered = true;
		const side = this.focusLook?.side ?? "root";
		this.setViewport(focusViewport(this.vp, lay.bounds, focus, side, this.area(), FIT_PAD, FOCUS_MIN_ZOOM));
		this.refreshWindowNow();
	}

	centerOn(id: string | null): void {
		const lay = this.lay;
		if (!lay) return;
		const p = lay.nodes.get(id ?? this.layoutRoot ?? "") ?? (this.layoutRoot ? lay.nodes.get(this.layoutRoot) : undefined);
		if (!p) return;
		if (this.width > 0) this.centered = true;
		this.setViewport(centerOnRect(this.vp, p, this.area()));
		this.refreshWindowNow();
	}

	centerOnPoint(p: Point): void {
		if (!this.lay) return;
		this.userMoved = true;
		this.setViewport(centerOnRect(this.vp, { x: p.x, y: p.y, width: 0, height: 0 }, this.area()));
		this.refreshWindowNow();
	}

	zoomBy(factor: number, at?: Point): void {
		this.userMoved = true;
		this.setViewport(zoomAt(this.vp, factor, at ?? { x: this.width / 2, y: this.height / 2 }));
	}

	fit(): void {
		if (!this.lay) return;
		this.userMoved = true;
		this.setViewport(fitBounds(this.lay.bounds, this.area(), FIT_PAD));
		this.refreshWindowNow();
	}

	startEditing(id: string, text: string, caret: "end" | "all"): EditorHandle {
		this.stopEditing();
		const item = this.items.get(id);
		if (!item) throw new Error(`Node ${id} is not visible`);
		this.editId = id;
		this.scrollIntoView(id); // pins the node and gives it DOM
		const view = this.views.get(id) ?? this.ensureView(id);
		const editor = view.el.createDiv({ cls: DOM.editor });
		try {
			editor.contentEditable = "plaintext-only";
		} catch {
			editor.contentEditable = "true";
		}
		if (editor.contentEditable !== "plaintext-only") editor.contentEditable = "true";
		editor.setAttr("role", "textbox");
		editor.setAttr("aria-multiline", "true");
		editor.textContent = text;
		view.el.addClass(DOM.editing);

		const state: EditState = { id, el: editor, abort: new AbortController(), composing: false, size: null };
		this.edit = state;
		const handle = this.makeHandle(state);
		const opts = { signal: state.abort.signal };
		editor.addEventListener("input", () => this.onEditInput(state), opts);
		editor.addEventListener("beforeinput", (e) => {
			// Enter belongs to the controller's key scope, which inserts line breaks through insertText("\n").
			// Fallback: with a Chinese IME on macOS, Shift+Enter can arrive without key === "Enter", so the
			// scope never matches and the browser fires insertLineBreak instead; insert the break ourselves.
			// No double insertion: when the scope handles the key, Obsidian calls preventDefault on keydown,
			// so no beforeinput fires. Plain Enter (insertParagraph) stays cancelled with nothing inserted.
			if (e.inputType !== "insertParagraph" && e.inputType !== "insertLineBreak") return;
			e.preventDefault();
			if (e.inputType === "insertLineBreak" && !state.composing && !e.isComposing) handle.insertText("\n");
		}, opts);
		editor.addEventListener("paste", (e) => {
			e.preventDefault();
			const pasted = e.clipboardData?.getData("text/plain") ?? "";
			// an image without text (spec 5.8): the controller saves it and inserts the embed at the caret
			const files = pasted ? [] : Array.from(e.clipboardData?.files ?? []).filter(isImageFile);
			if (files.length > 0 && this.events.pasteFiles) this.events.pasteFiles(id, files);
			else if (pasted) handle.insertText(pasted.replace(/\r\n?/g, "\n"));
		}, opts);
		editor.addEventListener("drop", (e) => {
			// an image drop was already taken by the view (spec 5.8)
			if (e.defaultPrevented) return;
			e.preventDefault();
			const dropped = e.dataTransfer?.getData("text/plain") ?? "";
			if (dropped) handle.insertText(dropped);
		}, opts);
		editor.addEventListener("compositionstart", () => {
			state.composing = true;
		}, opts);
		editor.addEventListener("compositionend", () => {
			state.composing = false;
		}, opts);

		editor.focus({ preventScroll: true });
		const len = text.length;
		this.setEditorSelection(editor, caret === "all" ? 0 : len, len);
		this.measureEditor(state);
		this.render({ anchorId: id, animate: false });
		return handle;
	}

	stopEditing(): void {
		const state = this.edit;
		this.editId = null;
		if (!state) return;
		this.edit = null;
		state.abort.abort();
		const hadFocus = state.el.contains(this.doc.activeElement);
		state.el.remove();
		const view = this.views.get(state.id);
		if (view) {
			view.el.removeClass(DOM.editing);
			if (hadFocus) view.el.focus({ preventScroll: true });
		}
		if (this.model && this.items.has(state.id)) this.render({ anchorId: state.id, animate: false });
	}

	focusNode(id: string): void {
		if (!this.views.has(id)) this.scrollIntoView(id);
		this.views.get(id)?.el.focus({ preventScroll: true });
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.edit?.abort.abort();
		this.edit = null;
		this.editId = null;
		this.gestures.abort();
		this.abort.abort();
		this.resizeObserver.disconnect();
		this.richObserver.disconnect();
		this.minimap.destroy();
		if (this.frame !== null) this.win.cancelAnimationFrame(this.frame);
		this.frame = null;
		if (this.cssPoll !== null) this.win.cancelAnimationFrame(this.cssPoll);
		this.cssPoll = null;
		if (this.dragFrame !== null) this.win.cancelAnimationFrame(this.dragFrame);
		this.dragFrame = null;
		for (const t of this.timers) this.win.clearTimeout(t);
		this.timers.clear();
		this.rootEl.remove();
		this.views.clear();
		this.paths.clear();
		this.items.clear();
		this.order = [];
		this.settleIds.clear();
		this.layouter.clear();
		this.sizes.clear();
		this.lay = null;
		this.model = null;
		this.measureCtx = null;
	}

	// ---- model --------------------------------------------------------------

	private buildItems(model: RenderModel): void {
		const start = (model.focusId ? findNode(model.root, model.focusId) : null) ?? model.root;
		const items = new Map<string, Item>();
		const order: string[] = [];
		const stack: { node: MapNode; depth: number; parent: string | null }[] = [{ node: start, depth: 0, parent: null }];
		// depth of the real tree decides the font, so focus mode keeps sizes
		const baseDepth = start === model.root ? 0 : depthOf(model.root, start.id);
		while (stack.length > 0) {
			const { node, depth, parent } = stack.pop() as { node: MapNode; depth: number; parent: string | null };
			const font = fontFor(baseDepth + depth, model.fontSize);
			const shown = node.text === "" ? model.placeholder : node.text;
			const plain = node.text === "" || isPlainText(node.text, node.kind);
			const hidden = model.hidden.has(node.id) && node.children.length > 0;
			const item: Item = {
				node,
				depth,
				parent,
				plain,
				font,
				key: contentKey(node, plain, shown, font, model.nodeMaxWidth),
				collapsed: hidden,
				kids: [],
			};
			items.set(node.id, item);
			order.push(node.id);
			if (parent !== null) items.get(parent)?.kids.push(node.id);
			if (!hidden) {
				for (let i = node.children.length - 1; i >= 0; i--) {
					stack.push({ node: node.children[i], depth: depth + 1, parent: node.id });
				}
			}
		}
		this.items = items;
		this.order = order;
		this.layoutRoot = start.id;
		this.baseDepth = baseDepth;
		const top = start === model.root ? -1 : model.root.children.findIndex((c) => c === start || depthOf(c, start.id) > 0);
		this.focusLook = top < 0 ? null : branchLook(top, model.root.children.length, model.direction, model.palette);
	}

	private layoutInput(): LayoutInput | null {
		if (!this.layoutRoot) return null;
		const inputs = new Map<string, LayoutInput>();
		let root: LayoutInput | null = null;
		for (const id of this.order) {
			const item = this.items.get(id) as Item;
			const input: LayoutInput = { id, size: this.sizeOf(item), collapsed: item.collapsed, children: [] };
			inputs.set(id, input);
			if (item.parent === null) root = input;
			else inputs.get(item.parent)?.children.push(input);
		}
		const d = this.drag;
		if (root && d?.preview) {
			// the map as it will be after the drop (spec 4.1, snap preview)
			const p = previewInput(root, { ...d.preview, sizeAt: (id, depth) => this.sizeAtDepth(id, depth) });
			d.parentId = p?.parentId ?? null;
			if (p) return p.input;
		}
		return root;
	}

	/** Size of a visible node if it sat at layout depth `depth` (a drop can change its level). */
	private sizeAtDepth(id: string, depth: number): Size {
		const item = this.items.get(id) as Item;
		const model = this.model as RenderModel;
		const font = fontFor(this.baseDepth + depth, model.fontSize);
		if (font.level === item.font.level) return this.sizeOf(item);
		const node = item.node;
		const shown = node.text === "" ? model.placeholder : node.text;
		const key = contentKey(node, item.plain, shown, font, model.nodeMaxWidth);
		return this.sizes.get(key) ?? estimateSize(shown, font, model.nodeMaxWidth, this.measureFn(font));
	}

	private sizeOf(item: Item): Size {
		if (this.edit?.id === item.node.id && this.edit.size) return this.edit.size;
		const cached = this.sizes.get(item.key);
		if (cached) return cached;
		const shown = item.node.text === "" ? (this.model?.placeholder ?? "") : item.node.text;
		const est = estimateSize(shown, item.font, this.model?.nodeMaxWidth ?? 800, this.measureFn(item.font));
		this.sizes.setEstimate(item.key, est);
		return est;
	}

	private measureFn(font: NodeFont): (s: string) => number {
		if (!this.measureCtx) {
			const canvas = this.doc.createElement("canvas"); // detached: Document.createEl would append to the document
			this.measureCtx = canvas.getContext("2d");
		}
		const ctx = this.measureCtx;
		if (!ctx) return (s) => s.length * font.px * 0.6;
		const spec = `${font.weight} ${font.px}px ${this.fontFamily || "sans-serif"}`;
		if (spec !== this.measureFont) {
			ctx.font = spec;
			this.measureFont = spec;
		}
		return (s) => ctx.measureText(s).width;
	}

	// ---- frame --------------------------------------------------------------

	private render(opts: RenderOpts): void {
		const model = this.model;
		if (!model || this.destroyed) return;
		this.sizes.beginGeneration();
		this.virtual = this.order.length > VIRTUALIZE_THRESHOLD;
		const vp0 = this.vp;
		const before = opts.anchorId ? opts.anchorBefore ?? this.lay?.nodes.get(opts.anchorId) ?? null : null;
		const prevLay = this.lay;
		let lay: LayoutResult | null = null;
		let vp = vp0;
		let dom = new Set<string>();
		const created = new Set<string>();

		// at most three layouts: provisional sizes, real sizes, and once more if the window grew
		for (let pass = 0; ; pass++) {
			const input = this.layoutInput();
			if (!input) return;
			// focus mode keeps the subtree on its side, in its order and colour (spec 5.3)
			const look = this.focusLook;
			lay = this.layouter.layout(input, look ? look.side : model.direction, look ? [look.color] : model.palette);
			vp = vp0;
			const after = opts.anchorId ? lay.nodes.get(opts.anchorId) : undefined;
			if (before && after) vp = anchorShift(vp0, this.anchorOf(before), this.anchorOf(after));
			if (pass >= 2) break;

			const window = visibleRect(vp, this.width, this.height, WINDOW_MARGIN);
			const pinned = this.pinned(model);
			dom = selectWindow(lay.nodes, window, pinned);
			this.covered = this.virtual ? window : null;
			this.cappedScale = null;
			if (dom.size > MAX_DOM_NODES) {
				dom = capWindow(lay.nodes, dom, toWorld(vp, { x: this.width / 2, y: this.height / 2 }), MAX_DOM_NODES, pinned);
				// only the area around the screen is covered, and only at this zoom
				this.covered = visibleRect(vp, this.width, this.height, 0.25);
				this.cappedScale = vp.scale;
			}

			// placeholders of a drag preview have no DOM
			if (this.drag?.preview) for (const id of dom) if (isPhantom(id)) dom.delete(id);

			// write: create views and contents
			const measure: NodeView[] = [];
			for (const id of dom) {
				const item = this.items.get(id) as Item;
				let view = this.views.get(id);
				if (!view) {
					view = this.ensureView(id);
					created.add(id);
				}
				if (view.key !== item.key) this.writeContent(view, item);
				if (view.ready && (!this.virtual || !item.plain) && !this.sizes.get(item.key)?.real && !this.isEditing(id)) {
					measure.push(view);
				}
			}
			// read: every size in one pass; none while the sizes would be bogus (no CSS, hidden)
			if (measure.length > 0 && !this.gate.canMeasure()) {
				this.awaitMeasure();
				break;
			}
			let changed = false;
			for (const view of measure) {
				const item = this.items.get(view.id) as Item;
				const size = this.readSize(view, item);
				if (!size) continue;
				const old = lay.nodes.get(view.id);
				this.sizes.setReal(item.key, size);
				if (!old || old.width !== size.width || old.height !== size.height) changed = true;
			}
			if (!changed) break;
		}
		if (!lay) return;

		// drop DOM that left the window or the tree
		for (const [id, view] of this.views) {
			// dragged nodes stay where they were (faded) while the preview leaves them out
			if (dom.has(id) || this.isEditing(id) || this.drag?.exclude.has(id)) continue;
			this.removeView(view);
		}

		const animate = opts.animate && prevLay !== null && !this.virtual && !this.host.reducedMotion();
		this.setAnimating(animate);
		this.lay = lay;
		this.updateMinimap(lay);
		this.colors.clear();
		for (const e of lay.edges) this.colors.set(e.childId, e.color);
		if (this.focusLook && this.layoutRoot) this.colors.set(this.layoutRoot, this.focusLook.color);
		this.writeNodes(model, lay, dom, animate ? created : null);
		this.writeEdges(lay);
		if (vp !== this.vp) this.setViewport(vp);
		else this.applyTransform();
		this.sizes.prune(Math.max(4 * this.order.length, 2000));
	}

	private pinned(model: RenderModel): string[] {
		const out: string[] = [];
		if (model.primary) out.push(model.primary);
		if (this.editId) out.push(this.editId);
		if (this.layoutRoot) out.push(this.layoutRoot);
		return out;
	}

	private isEditing(id: string): boolean {
		return this.editId === id;
	}

	private ensureView(id: string): NodeView {
		const existing = this.views.get(id);
		if (existing) return existing;
		const el = this.canvas.createDiv({ cls: DOM.node });
		el.setAttr(DOM.nodeIdAttr, id);
		el.setAttr("role", "treeitem");
		el.setAttr("aria-selected", "false");
		const content = el.createDiv({ cls: CLS.content });
		const view: NodeView = {
			id,
			el,
			content,
			badge: null,
			toggle: null,
			key: null,
			rich: false,
			ready: false,
			token: 0,
			x: NaN,
			y: NaN,
			w: NaN,
			h: NaN,
			fontPx: 0,
			color: "",
			selected: false,
			primary: false,
			collapsed: false,
			count: -1,
			level: -1,
			side: "",
			expanded: "",
			tab: 2,
		};
		this.views.set(id, view);
		return view;
	}

	private removeView(view: NodeView): void {
		view.token++;
		if (view.rich) this.richObserver.unobserve(view.content);
		view.el.remove();
		this.views.delete(view.id);
	}

	private writeContent(view: NodeView, item: Item): void {
		const model = this.model as RenderModel;
		view.key = item.key;
		view.token++;
		const token = view.token;
		if (view.fontPx !== item.font.px) {
			view.el.style.setProperty("font-size", `${item.font.px}px`);
			view.fontPx = item.font.px;
		}
		view.el.toggleClass(CLS.root, item.font.level === 0);
		view.el.toggleClass(CLS.level1, item.font.level === 1);
		view.el.toggleClass(CLS.level2, item.font.level === 2);
		view.el.toggleClass(CLS.deep, item.font.level >= 3);
		const text = item.node.text;
		view.content.toggleClass(CLS.empty, text === "");
		view.content.toggleClass(CLS.rich, text !== "" && !item.plain);
		if (view.rich && item.plain) this.richObserver.unobserve(view.content);
		if (text === "" || item.plain) {
			view.content.textContent = text === "" ? model.placeholder : text;
			view.rich = false;
			view.ready = true;
			return;
		}
		// rich: raw text until the Markdown is rendered
		view.content.textContent = text;
		view.ready = false;
		if (!view.rich) this.richObserver.observe(view.content);
		view.rich = true;
		const staging = this.doc.createElement("div"); // detached, same realm as the view
		const done = (ok: boolean) => {
			if (this.destroyed || view.token !== token || this.views.get(view.id) !== view) return;
			if (ok) view.content.replaceChildren(...Array.from(staging.childNodes));
			view.ready = true;
			this.settleIds.add(view.id);
			this.scheduleFrame();
		};
		this.host.renderMarkdown(markdownSource(text, item.node.kind), staging).then(
			() => done(true),
			() => done(false),
		);
	}

	/** Border-box size of a node from its content box; integers like the estimate. */
	private readSize(view: NodeView, item: Item): Size | null {
		if (!view.content.isConnected) return null;
		const w = view.content.offsetWidth;
		const h = view.content.offsetHeight;
		return domSize(w, h, item.font, this.model?.nodeMaxWidth ?? 800);
	}

	/** True when styles.css applies to the map; probed by the gate until it does. */
	private probeCss(): boolean {
		const cs = this.win.getComputedStyle(this.rootEl);
		const ready = cs.getPropertyValue(MEASURE_SENTINEL).trim() !== "";
		if (ready) {
			// side effect on purpose: the stylesheet sets the map's font, so estimates made with the one before are off
			const family = cs.fontFamily;
			if (family !== this.fontFamily) {
				this.fontFamily = family;
				this.sizes.dropEstimates();
			}
		}
		return ready;
	}

	/** Polls once a frame for styles.css after a read was skipped for it; stops when it applies. */
	private awaitMeasure(): void {
		if (!this.gate.waitingForCss || this.cssPoll !== null || this.destroyed) return;
		this.cssPoll = this.win.requestAnimationFrame(() => {
			this.cssPoll = null;
			if (this.destroyed) return;
			if (this.gate.retry()) this.remeasure();
			else this.awaitMeasure();
		});
	}

	/** Lays out again; every node in the DOM without a real size is measured on the way. */
	private remeasure(): void {
		if (this.destroyed || !this.model) return;
		this.render({ anchorId: this.settleAnchor(), animate: false });
	}

	private writeNodes(model: RenderModel, lay: LayoutResult, dom: ReadonlySet<string>, entering: Set<string> | null): void {
		const selected = new Set(model.selection);
		const focusTarget = model.primary && dom.has(model.primary) ? model.primary : this.layoutRoot;
		for (const id of dom) {
			const view = this.views.get(id);
			const p = lay.nodes.get(id);
			const item = this.items.get(id);
			if (!view || !p || !item) continue;
			if (entering?.has(id)) view.el.addClass(CLS.entering);
			const x = Math.round(p.x);
			const y = Math.round(p.y);
			if (x !== view.x || y !== view.y) {
				view.el.style.setProperty("transform", `translate(${x}px, ${y}px)`);
				view.x = x;
				view.y = y;
			}
			if (p.width !== view.w || p.height !== view.h) {
				view.el.style.setProperty("width", `${p.width}px`);
				view.el.style.setProperty("height", `${p.height}px`);
				view.w = p.width;
				view.h = p.height;
			}
			const color = this.colors.get(id) ?? "";
			if (color !== view.color) {
				if (color) view.el.style.setProperty("--mapdown-branch-color", color);
				else view.el.style.removeProperty("--mapdown-branch-color");
				view.color = color;
			}
			const side = id === this.layoutRoot && this.focusLook ? this.focusLook.side : p.side;
			if (side !== view.side) {
				view.el.toggleClass(CLS.left, side === "left");
				view.side = side;
			}
			const level = item.depth + 1;
			if (level !== view.level) {
				view.el.setAttr("aria-level", String(level));
				view.level = level;
			}
			const isSel = selected.has(id);
			if (isSel !== view.selected) {
				view.el.toggleClass(DOM.selected, isSel);
				view.el.setAttr("aria-selected", isSel ? "true" : "false");
				view.selected = isSel;
			}
			const isPrimary = model.primary === id;
			if (isPrimary !== view.primary) {
				view.el.toggleClass(DOM.primary, isPrimary);
				view.primary = isPrimary;
			}
			// search highlight and focus node (classList.toggle with force is a no-op when unchanged)
			view.el.classList.toggle(DOM.searchMatch, model.searchMatches?.has(id) ?? false);
			view.el.classList.toggle(DOM.searchCurrent, model.searchCurrent === id);
			view.el.classList.toggle(DOM.focusRoot, model.focusId === id);
			const tab = id === focusTarget ? 0 : -1;
			if (tab !== view.tab) {
				view.el.tabIndex = tab;
				view.tab = tab;
			}
			const expanded = item.node.children.length === 0 ? "" : item.collapsed ? "false" : "true";
			if (expanded !== view.expanded) {
				if (expanded) view.el.setAttr("aria-expanded", expanded);
				else view.el.removeAttribute("aria-expanded");
				view.expanded = expanded;
			}
			const count = item.collapsed ? item.node.children.length : 0;
			if (item.collapsed !== view.collapsed || count !== view.count) {
				view.el.toggleClass(DOM.collapsed, item.collapsed);
				if (item.collapsed) {
					if (!view.badge) view.badge = view.el.createSpan({ cls: CLS.badge });
					view.badge.textContent = String(count);
				} else if (view.badge) {
					view.badge.remove();
					view.badge = null;
				}
				view.collapsed = item.collapsed;
				view.count = count;
			}
			// collapse dot: expanded nodes with children, not the root of what is drawn
			const canToggle = item.node.children.length > 0 && !item.collapsed && id !== this.layoutRoot;
			if (canToggle && !view.toggle) {
				view.toggle = view.el.createSpan({ cls: CLS.toggle });
				view.toggle.setAttr("aria-hidden", "true");
			} else if (!canToggle && view.toggle) {
				view.toggle.remove();
				view.toggle = null;
			}
		}
	}

	private writeEdges(lay: LayoutResult): void {
		const window = this.covered;
		const seen = new Set<string>();
		const root = this.layoutRoot;
		const preview = this.drag?.preview != null;
		for (const e of lay.edges) {
			if (window && !edgeInWindow(e.from, e.to, window)) continue;
			// a preview draws only the dashed edges into the placeholders, not inside the moved subtrees
			if (preview && isPhantom(e.parentId)) continue;
			seen.add(e.childId);
			const d = `M ${r2(e.from.x)} ${r2(e.from.y)} C ${r2(e.c1.x)} ${r2(e.c1.y)}, ${r2(e.c2.x)} ${r2(e.c2.y)}, ${r2(e.to.x)} ${r2(e.to.y)}`;
			let pv = this.paths.get(e.childId);
			if (!pv) {
				pv = { el: this.svg.createSvg("path"), d: "", color: "", fromRoot: false, drop: false };
				this.paths.set(e.childId, pv);
			}
			const drop = preview && isPhantom(e.childId);
			if (drop !== pv.drop) {
				pv.el.toggleClass(CLS.dropEdge, drop);
				pv.drop = drop;
			}
			const fromRoot = e.parentId === root;
			if (fromRoot !== pv.fromRoot) {
				pv.el.toggleClass(CLS.rootEdge, fromRoot);
				pv.fromRoot = fromRoot;
			}
			if (pv.d !== d) {
				if (this.cssD) pv.el.style.setProperty("d", `path("${d}")`);
				else pv.el.setAttribute("d", d);
				pv.d = d;
			}
			if (pv.color !== e.color) {
				pv.el.setAttribute("stroke", e.color);
				pv.color = e.color;
			}
		}
		for (const [id, pv] of this.paths) {
			if (seen.has(id)) continue;
			pv.el.remove();
			this.paths.delete(id);
		}
		const b = lay.bounds;
		const box = `${r2(b.x - EDGE_PAD)} ${r2(b.y - EDGE_PAD)} ${r2(b.width + 2 * EDGE_PAD)} ${r2(b.height + 2 * EDGE_PAD)}`;
		if (box !== this.svgBox) {
			this.svgBox = box;
			this.svg.setAttribute("viewBox", box);
			this.svg.setAttribute("width", String(r2(b.width + 2 * EDGE_PAD)));
			this.svg.setAttribute("height", String(r2(b.height + 2 * EDGE_PAD)));
			this.svg.style.setProperty("transform", `translate(${r2(b.x - EDGE_PAD)}px, ${r2(b.y - EDGE_PAD)}px)`);
		}
	}

	private setAnimating(on: boolean): void {
		if (this.animTimer !== null) {
			this.clearTimer(this.animTimer);
			this.animTimer = null;
		}
		if (!on) {
			this.endAnimation();
			return;
		}
		this.rootEl.addClass(CLS.animating);
		this.animTimer = this.setTimer(() => {
			this.animTimer = null;
			this.endAnimation();
		}, ANIMATION_MS + 50);
	}

	private endAnimation(): void {
		this.rootEl.removeClass(CLS.animating);
		for (const view of this.views.values()) view.el.removeClass(CLS.entering);
	}

	// ---- viewport -----------------------------------------------------------

	/**
	 * The screen area not covered by the floating UI (spec 5.1, available area): the map toolbar, the
	 * touch node toolbar and the minimap, where shown. Measured on each call, so only for one-off
	 * viewport moves, never from the render loop.
	 */
	private area(): Rect {
		const covers: Rect[] = [];
		const map = this.rootEl.getBoundingClientRect();
		for (const cls of COVERING_UI) {
			for (const el of Array.from(this.container.getElementsByClassName(cls))) {
				const r = el.getBoundingClientRect();
				if (r.width <= 0 || r.height <= 0) continue; // hidden
				covers.push({ x: r.left - map.left, y: r.top - map.top, width: r.width, height: r.height });
			}
		}
		return uncoveredArea(this.width, this.height, covers);
	}

	private setViewport(vp: Viewport): void {
		if (vp.x === this.vp.x && vp.y === this.vp.y && vp.scale === this.vp.scale) return;
		this.vp = vp;
		this.applyTransform();
		this.events.viewportChange();
		this.scheduleWindowCheck();
	}

	private applyTransform(): void {
		const { x, y, scale } = this.vp;
		this.canvas.style.setProperty("transform", `translate(${r2(x)}px, ${r2(y)}px) scale(${scale})`);
		if (this.minimap.visible) this.minimap.setView(visibleRect(this.vp, this.width, this.height, 0));
	}

	/** The overview follows the layout (repainted on the next frame) and shows only for large maps. */
	private updateMinimap(lay: LayoutResult): void {
		const on = shouldShowMinimap(this.order.length);
		this.minimap.setVisible(on);
		if (!on) {
			this.minimapSig = "";
			return;
		}
		// a window refresh after a pan lays out the same map again: repaint only when something moved
		let h = lay.nodes.size;
		for (const n of lay.nodes.values()) h = (Math.imul(h, 31) + Math.round(n.x) * 7 + Math.round(n.y) * 13 + Math.round(n.width) + Math.round(n.height) * 3) | 0;
		const b = lay.bounds;
		const sig = `${h}|${b.x}|${b.y}|${b.width}|${b.height}`;
		if (sig === this.minimapSig) return;
		this.minimapSig = sig;
		this.minimap.setLayout([...lay.nodes.values()], lay.bounds);
	}

	private panBy(dx: number, dy: number): void {
		if (dx === 0 && dy === 0) return;
		this.userMoved = true;
		this.setViewport({ x: this.vp.x + dx, y: this.vp.y + dy, scale: this.vp.scale });
	}

	private scheduleWindowCheck(): void {
		if (!this.virtual) return;
		this.windowCheck = true;
		this.scheduleFrame();
	}

	private refreshWindowNow(): void {
		if (!this.virtual || !this.model) return;
		const view = visibleRect(this.vp, this.width, this.height, this.cappedScale === null ? REFRESH_MARGIN : 0);
		const stale = this.cappedScale !== null && this.cappedScale !== this.vp.scale;
		if (stale || needsWindowRefresh(this.covered, view)) this.render({ anchorId: this.settleAnchor(), animate: false });
	}

	/** Anchor point of a placed node; the focus-mode root counts as a node on its branch's side. */
	private anchorOf(p: NodePlacement): Point {
		return anchorPoint(p, p.id === this.layoutRoot && this.focusLook ? this.focusLook.side : p.side);
	}

	/**
	 * The node that must not move on screen when sizes settle (plan 3.4): the selection while it is on
	 * screen, else the on-screen node nearest the middle. Anchoring on an off-screen selection would
	 * shift what the user is looking at.
	 */
	private settleAnchor(): string | null {
		const primary = this.model?.primary ?? null;
		const lay = this.lay;
		if (!lay) return primary;
		return pickAnchor(lay.nodes, this.views.keys(), primary, visibleRect(this.vp, this.width, this.height, 0)) ?? primary;
	}

	private scheduleFrame(): void {
		if (this.frame !== null || this.destroyed) return;
		this.frame = this.win.requestAnimationFrame(() => {
			this.frame = null;
			this.onFrame();
		});
	}

	/** Settle rich nodes whose rendering finished or resized, and move the DOM window after a pan. */
	private onFrame(): void {
		if (this.destroyed || !this.model) return;
		let changed = false;
		// whether sizes can be read this frame; asked once, at the first node to read
		let open: boolean | null = null;
		if (this.settleIds.size > 0) {
			const ids = [...this.settleIds];
			this.settleIds.clear();
			for (const id of ids) {
				const view = this.views.get(id);
				const item = this.items.get(id);
				if (!view || !item || !view.ready || view.key !== item.key || this.isEditing(id)) continue;
				open ??= this.gate.canMeasure();
				// the gate re-measures once it can; a rich node that resized also reports again
				if (!open) break;
				const size = this.readSize(view, item);
				if (!size) continue;
				const old = this.sizes.get(item.key);
				if (!old || !old.real || old.width !== size.width || old.height !== size.height) {
					this.sizes.setReal(item.key, size);
					const placed = this.lay?.nodes.get(id);
					if (!placed || placed.width !== size.width || placed.height !== size.height) changed = true;
				}
			}
		}
		if (open === false) this.awaitMeasure();
		const windowCheck = this.windowCheck;
		this.windowCheck = false;
		if (changed) {
			this.render({ anchorId: this.settleAnchor(), animate: false });
		} else if (windowCheck) {
			this.refreshWindowNow();
		}
	}

	// ---- editing ------------------------------------------------------------

	private makeHandle(state: EditState): EditorHandle {
		const editor = state.el;
		const read = (): TextSel => {
			const sel = this.getEditorSelection(editor);
			return { text: editor.textContent ?? "", from: sel.from, to: sel.to };
		};
		const write = (s: TextSel) => {
			editor.textContent = s.text;
			this.setEditorSelection(editor, s.from, s.to);
			this.onEditInput(state);
		};
		return {
			element: editor,
			getText: () => editor.textContent ?? "",
			getSelection: () => this.getEditorSelection(editor),
			insertText: (text: string) => write(insertAt(read(), text)),
			setText: (text: string, caret: number) => {
				const at = Math.max(0, Math.min(caret, text.length));
				write({ text, from: at, to: at });
			},
			toggleWrap: (marker: string) => write(toggleWrapText(read(), marker)),
			isComposing: () => state.composing,
		};
	}

	private onEditInput(state: EditState): void {
		if (this.edit !== state || this.destroyed) return;
		this.measureEditor(state);
		this.render({ anchorId: state.id, animate: false });
		this.revealEditor(state);
		this.events.editInput(state.id, state.el.textContent ?? "");
	}

	/** Pan just enough to bring the edited node back on screen (spec 3.1). */
	private revealEditor(state: EditState): void {
		if (this.edit !== state || this.destroyed) return;
		const p = this.lay?.nodes.get(state.id);
		if (!p) return;
		const next = revealRect(this.vp, p, this.area(), REVEAL_PAD);
		if (next === this.vp) return;
		this.setViewport(next);
		this.refreshWindowNow();
	}

	private measureEditor(state: EditState): void {
		const item = this.items.get(state.id);
		if (!item) return;
		state.size = boxSize(state.el.offsetWidth, Math.max(state.el.offsetHeight, 1), item.font, this.model?.nodeMaxWidth ?? 800);
	}

	private getEditorSelection(editor: HTMLElement): { from: number; to: number } {
		const len = (editor.textContent ?? "").length;
		const sel = this.doc.getSelection();
		if (!sel || sel.rangeCount === 0) return { from: len, to: len };
		const range = sel.getRangeAt(0);
		if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return { from: len, to: len };
		const offset = (node: Node, off: number) => {
			const r = this.doc.createRange();
			r.setStart(editor, 0);
			r.setEnd(node, off);
			return r.toString().length;
		};
		return { from: offset(range.startContainer, range.startOffset), to: offset(range.endContainer, range.endOffset) };
	}

	private setEditorSelection(editor: HTMLElement, from: number, to: number): void {
		const sel = this.doc.getSelection();
		if (!sel) return;
		const locate = (target: number): [Node, number] => {
			const walker = this.doc.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
			let seen = 0;
			let last: Text | null = null;
			for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
				const t = n as Text;
				if (seen + t.length >= target) return [t, target - seen];
				seen += t.length;
				last = t;
			}
			return last ? [last, last.length] : [editor, 0];
		};
		const [a, ao] = locate(from);
		const [b, bo] = locate(to);
		const range = this.doc.createRange();
		range.setStart(a, ao);
		range.setEnd(b, bo);
		sel.removeAllRanges();
		sel.addRange(range);
	}

	// ---- input --------------------------------------------------------------

	private inEditor(target: EventTarget | null): boolean {
		return this.edit !== null && isNode(target) && this.edit.el.contains(target);
	}

	private targetOf(target: EventTarget | null): Target {
		if (isElement(target)) {
			const el = target.closest(`.${DOM.node}`);
			const id = el?.getAttribute(DOM.nodeIdAttr);
			if (el && id && this.canvas.contains(el) && this.items.has(id)) return { kind: "node", id };
		}
		return { kind: "background" };
	}

	private mods(e: MouseEvent): Modifiers {
		return {
			mod: Platform.isMacOS ? e.metaKey : e.ctrlKey,
			shift: e.shiftKey,
			alt: e.altKey,
			ctrl: e.ctrlKey,
		};
	}

	private input(e: PointerEvent, target: Target): PointerInput {
		const rect = this.gestureRect ?? this.rootEl.getBoundingClientRect();
		return {
			id: e.pointerId,
			type: e.pointerType === "touch" ? "touch" : e.pointerType === "pen" ? "pen" : "mouse",
			button: e.button,
			x: e.clientX - rect.left,
			y: e.clientY - rect.top,
			time: e.timeStamp,
			target,
			mods: this.mods(e),
			detail: e.detail,
		};
	}

	private onPointerDown(e: PointerEvent): void {
		if (this.inEditor(e.target)) return;
		// the collapse dot and the count pill toggle on click; they never select or drag
		if (this.collapseHandle(e.target) && e.button === 0 && !this.gestures.busy) {
			e.preventDefault();
			e.stopPropagation();
			this.toggleDown = e.pointerId;
			return;
		}
		if (!this.gestures.busy) {
			this.gestureRect = this.rootEl.getBoundingClientRect();
			this.setAnimating(false);
		}
		const target = this.targetOf(e.target);
		const link = isElement(e.target) ? e.target.closest("a") : null;
		this.linkDown = link && target.kind === "node" ? { pointerId: e.pointerId, href: link.getAttribute("data-href") ?? link.getAttribute("href") ?? "" } : null;
		this.lastEvent = e;
		// no middle-click autoscroll
		if (e.button === 1) e.preventDefault();
		this.gestures.down(this.input(e, target));
	}

	private onPointer(e: PointerEvent, kind: "move" | "up" | "cancel"): void {
		if (!this.gestures.busy) return;
		this.lastEvent = e;
		const p = this.input(e, this.targetOf(e.target));
		if (kind === "move") this.gestures.move(p);
		else if (kind === "up") this.gestures.up(p);
		else this.gestures.cancel(p);
		if (!this.gestures.busy) {
			this.gestureRect = null;
			this.rootEl.removeClass(CLS.panning);
		}
	}

	private onWheel(e: WheelEvent): void {
		e.preventDefault();
		const zoomKey = e.ctrlKey || (Platform.isMacOS && e.metaKey);
		const action = wheelAction(e.deltaX, e.deltaY, e.deltaMode, zoomKey, e.shiftKey);
		if ("zoom" in action) {
			const rect = this.rootEl.getBoundingClientRect();
			this.zoomBy(action.zoom, { x: e.clientX - rect.left, y: e.clientY - rect.top });
		} else {
			this.panBy(action.dx, action.dy);
		}
	}

	private onContextMenu(e: MouseEvent): void {
		if (this.inEditor(e.target)) return;
		e.preventDefault();
		const id = this.gestures.nativeContextMenu(this.targetOf(e.target));
		if (id) this.events.contextMenu(id, { x: e.clientX, y: e.clientY });
	}

	/** The pointer entered an internal link of a node: the controller hands it to the page preview. */
	private onLinkHover(e: MouseEvent): void {
		if (this.inEditor(e.target) || !isElement(e.target)) return;
		const link = e.target.closest<HTMLElement>("a.internal-link");
		if (!link || !this.canvas.contains(link) || !this.events.linkHover) return;
		const href = link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
		if (href) this.events.linkHover(href, link, e);
	}

	private collapseHandle(target: EventTarget | null): boolean {
		return isElement(target) && target.closest(`.${CLS.toggle}, .${CLS.badge}`) !== null;
	}

	private onNativeClick(e: MouseEvent): void {
		if (this.inEditor(e.target)) return;
		if (this.collapseHandle(e.target)) {
			e.preventDefault();
			const t = this.targetOf(e.target);
			if (this.toggleDown !== null && t.kind === "node") this.events.toggleCollapse?.(t.id);
			this.toggleDown = null;
			return;
		}
		const link = isElement(e.target) ? e.target.closest("a") : null;
		if (link && this.canvas.contains(link)) e.preventDefault();
	}

	private gestureSink(): GestureSink {
		const clientPoint = (p: Point): Point => {
			const rect = this.gestureRect ?? this.rootEl.getBoundingClientRect();
			return { x: p.x + rect.left, y: p.y + rect.top };
		};
		return {
			click: (target, mods) => {
				if (target.kind === "background") {
					this.events.backgroundClick();
					return;
				}
				const link = this.linkDown;
				const evt = this.lastEvent;
				if (link && evt && link.pointerId === evt.pointerId && link.href) {
					this.events.linkClick(link.href, evt);
					return;
				}
				this.events.nodeClick(target.id, mods);
			},
			doubleClick: (id) => this.events.nodeDoubleClick(id),
			contextMenu: (id, at) => this.events.contextMenu(id, clientPoint(at)),
			panBy: (dx, dy) => {
				this.rootEl.addClass(CLS.panning);
				this.panBy(dx, dy);
			},
			zoomAt: (factor, at) => this.zoomBy(factor, at),
			capture: (pointerId) => {
				try {
					this.rootEl.setPointerCapture(pointerId);
				} catch {
					// the pointer is already gone
				}
			},
			boxUpdate: (r) => this.drawBox(r),
			boxEnd: (r, additive) => {
				this.clearBox();
				const lay = this.lay;
				if (!lay) return;
				const a = toWorld(this.vp, { x: r.x0, y: r.y0 });
				const b = toWorld(this.vp, { x: r.x1, y: r.y1 });
				this.events.boxSelect(boxHits(lay.nodes, { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y }), additive);
			},
			boxCancel: () => this.clearBox(),
			dragStart: (id, at) => this.dragStart(id, at),
			dragMove: (at, mods) => this.dragMove(at, mods),
			dragEnd: (at, mods) => {
				this.dragMove(at, mods);
				this.dragDrop(mods);
			},
			dragCancel: () => this.dragClear(),
		};
	}

	private drawBox(r: BoxRect): void {
		if (!this.box) this.box = this.rootEl.createDiv({ cls: CLS.box });
		this.box.style.setProperty("transform", `translate(${r.x0}px, ${r.y0}px)`);
		this.box.style.setProperty("width", `${r.x1 - r.x0}px`);
		this.box.style.setProperty("height", `${r.y1 - r.y0}px`);
	}

	private clearBox(): void {
		this.box?.remove();
		this.box = null;
	}

	// ---- node drag (spec 4.1, drag feedback) ---------------------------------

	private dragStart(id: string, at: Point): void {
		const model = this.model;
		const frozen = this.lay;
		const p = frozen?.nodes.get(id);
		if (!model || !frozen || !p) return;
		const ids = model.selection.includes(id) ? model.selection.filter((s) => this.items.has(s)) : [id];
		const exclude = new Set<string>();
		const stack = [...ids];
		while (stack.length > 0) {
			const cur = stack.pop() as string;
			if (exclude.has(cur)) continue;
			exclude.add(cur);
			for (const k of this.items.get(cur)?.kids ?? []) stack.push(k);
		}
		const world = toWorld(this.vp, at);
		const ghost = this.makeGhost(id, p, ids.length);
		for (const s of ids) this.views.get(s)?.el.addClass(CLS.dragging);
		for (const s of exclude) this.views.get(s)?.el.addClass(CLS.dragSource);
		const indicator = this.canvas.createDiv({ cls: [CLS.drop, "is-hidden"] });
		const connector = this.rootEl.createSvg("svg", { cls: CLS.connector });
		connector.setAttr("aria-hidden", "true");
		const line = connector.createSvg("line");
		this.rootEl.addClass(CLS.nodeDragging);
		this.drag = {
			ids,
			grabbed: id,
			exclude,
			frozen,
			grab: { x: world.x - p.x, y: world.y - p.y },
			ghost,
			indicator,
			connector,
			line,
			target: null,
			copy: false,
			key: "",
			preview: null,
			parentId: null,
		};
	}

	/** A translucent copy of the grabbed node's card: same level look and branch colour (spec 4.1). */
	private makeGhost(id: string, p: NodePlacement, count: number): HTMLElement {
		const ghost = this.rootEl.createDiv({ cls: CLS.ghost });
		ghost.style.setProperty("width", `${p.width}px`);
		ghost.style.setProperty("height", `${p.height}px`);
		const card = ghost.createDiv({ cls: CLS.ghostCard });
		const view = this.views.get(id);
		if (view) {
			// computed styles: the card looks like the node without carrying the node's class (e2e counts nodes)
			const cs = this.win.getComputedStyle(view.el);
			for (const prop of GHOST_STYLE) card.style.setProperty(prop, cs.getPropertyValue(prop));
			card.appendChild(view.content.cloneNode(true));
		} else {
			card.textContent = this.items.get(id)?.node.text ?? "";
		}
		if (count > 1) ghost.createSpan({ cls: CLS.ghostCount, text: String(count) });
		return ghost;
	}

	private dragMove(at: Point, mods?: Modifiers): void {
		const d = this.drag;
		if (!d) return;
		this.dragAt = at;
		// Ctrl at release copies (spec 4.1): show it while dragging.
		if (mods) {
			d.copy = mods.ctrl;
			d.ghost.toggleClass("is-copy", mods.ctrl);
		}
		this.dragTarget(at);
		this.dragScroll();
	}

	/** Pan while the pointer is near an edge of the map, one step per frame. */
	private dragScroll(): void {
		const step = (): { dx: number; dy: number } | null => {
			const at = this.dragAt;
			if (!this.drag || !at || this.destroyed) return null;
			const rect = this.gestureRect ?? this.rootEl.getBoundingClientRect();
			const d = edgeScroll(at, { width: rect.width, height: rect.height });
			return d.dx === 0 && d.dy === 0 ? null : d;
		};
		const tick = (): void => {
			this.dragFrame = null;
			const d = step();
			const at = this.dragAt;
			if (!d || !at) return;
			this.panBy(d.dx, d.dy);
			this.dragTarget(at);
			this.dragFrame = this.win.requestAnimationFrame(tick);
		};
		if (this.dragFrame === null && step()) this.dragFrame = this.win.requestAnimationFrame(tick);
	}

	/** Ghost position, drop target, snap preview, placeholder and connector for the pointer at `at`. */
	private dragTarget(at: Point): void {
		const d = this.drag;
		if (!d) return;
		const { scale } = this.vp;
		const gx = at.x - d.grab.x * scale;
		const gy = at.y - d.grab.y * scale;
		d.ghost.style.setProperty("transform", `translate(${r2(gx)}px, ${r2(gy)}px) scale(${scale})`);
		d.ghost.style.setProperty("--mapdown-ghost-scale", String(scale));

		// hit-test the layout from drag start: siblings making room never change the target
		const world = toWorld(this.vp, at);
		const hit = hitTest(d.frozen.nodes, world, d.exclude);
		const target = hit && this.items.has(hit.id) ? { id: hit.id, place: dropPlace(hit, world, hit.id === this.layoutRoot) } : null;
		const key = target ? `${target.id}|${target.place}|${d.copy ? "copy" : "move"}` : "";
		if (key !== d.key) {
			d.key = key;
			d.preview = target ? { ids: d.ids, targetId: target.id, place: target.place, copy: d.copy } : null;
			d.parentId = null;
			this.rootEl.toggleClass(CLS.dropPreview, d.preview !== null);
			this.render({ anchorId: null, animate: true });
			this.setDropParent(d.parentId);
		}
		const ph = d.preview ? this.lay?.nodes.get(phantomId(d.grabbed)) : undefined;
		d.target = ph ? target : null;
		d.ghost.toggleClass("is-invalid", !d.target);
		if (!d.target || !ph) {
			d.indicator.removeClass("is-before", "is-after", "is-child");
			d.indicator.addClass("is-hidden");
			d.connector.addClass("is-hidden");
			return;
		}
		const wasHidden = d.indicator.hasClass("is-hidden");
		d.indicator.removeClass("is-hidden", "is-before", "is-after", "is-child");
		d.indicator.addClass(`is-${d.target.place}`);
		const color = this.colors.get(phantomId(d.grabbed)) ?? "";
		if (color) d.indicator.style.setProperty("--mapdown-branch-color", color);
		else d.indicator.style.removeProperty("--mapdown-branch-color");
		// the placeholder is where the node lands: the grabbed node's place in the preview layout
		d.indicator.toggleClass("is-placing", wasHidden);
		d.indicator.style.setProperty("transform", `translate(${r2(ph.x)}px, ${r2(ph.y)}px)`);
		d.indicator.style.setProperty("width", `${r2(ph.width)}px`);
		d.indicator.style.setProperty("height", `${r2(ph.height)}px`);
		if (wasHidden) {
			void d.indicator.offsetWidth; // appear in place; glide only between drop places
			d.indicator.removeClass("is-placing");
		}
		// faint line from the ghost card to the placeholder (screen space)
		const ends = connectorEnds(
			{ x: gx, y: gy, width: ph.width * scale, height: ph.height * scale },
			{ x: ph.x * scale + this.vp.x, y: ph.y * scale + this.vp.y, width: ph.width * scale, height: ph.height * scale },
		);
		d.connector.toggleClass("is-hidden", ends === null);
		if (ends) {
			d.line.setAttribute("x1", String(r2(ends.from.x)));
			d.line.setAttribute("y1", String(r2(ends.from.y)));
			d.line.setAttribute("x2", String(r2(ends.to.x)));
			d.line.setAttribute("y2", String(r2(ends.to.y)));
			if (color) d.line.setAttribute("stroke", color);
			else d.line.removeAttribute("stroke");
		}
	}

	private setDropParent(id: string | null): void {
		for (const el of this.canvas.querySelectorAll(`.${CLS.dropParent}`)) el.removeClass(CLS.dropParent);
		if (id) this.views.get(id)?.el.addClass(CLS.dropParent);
	}

	/**
	 * Release: the moved node starts at the ghost and glides to the placeholder in the update the drop
	 * causes. The preview layout equals that update's layout, so nothing else moves.
	 */
	private dragDrop(mods: Modifiers): void {
		const d = this.drag;
		if (!d) return;
		const target = d.target;
		const { scale } = this.vp;
		const at = this.dragAt;
		const from = at ? toWorld(this.vp, { x: at.x - d.grab.x * scale, y: at.y - d.grab.y * scale }) : null;
		this.dragClear(false);
		this.dragAt = null;
		if (!target) {
			if (d.key !== "") this.render({ anchorId: null, animate: true });
			return;
		}
		// a copy gets new ids: it fades in at the placeholder instead
		this.dropFlight = from && !mods.ctrl ? { id: d.grabbed, from } : null;
		const before = this.lay;
		this.events.drop(d.ids, target.id, target.place, mods.ctrl);
		this.dropFlight = null;
		// nothing changed (read-only view, no-op move): slide back to the map without the preview
		if (this.lay === before && !this.destroyed) this.render({ anchorId: null, animate: true });
	}

	/** Before the update after a drop: put the moved node (and its subtree) at the ghost, without transition. */
	private startFlight(flight: DropFlight): void {
		const view = this.views.get(flight.id);
		if (!view || Number.isNaN(view.x)) return;
		// the dashed edges become the real ones (same curve: the preview is the final layout)
		for (const [key, pv] of [...this.paths]) {
			if (!isPhantom(key)) continue;
			this.paths.delete(key);
			const id = realId(key);
			this.paths.get(id)?.el.remove();
			pv.el.removeClass(CLS.dropEdge);
			pv.drop = false;
			this.paths.set(id, pv);
		}
		this.setAnimating(false);
		const dx = Math.round(flight.from.x) - view.x;
		const dy = Math.round(flight.from.y) - view.y;
		const stack = [flight.id];
		while (stack.length > 0) {
			const id = stack.pop() as string;
			const v = this.views.get(id);
			if (v && !Number.isNaN(v.x)) {
				v.x += dx;
				v.y += dy;
				v.el.style.setProperty("transform", `translate(${v.x}px, ${v.y}px)`);
			}
			for (const k of this.items.get(id)?.kids ?? []) stack.push(k);
		}
		void view.el.offsetWidth; // commit the start position before the transition starts
	}

	/** Ends a drag; `restore` lays the map out again without the preview. */
	private dragClear(restore = true): void {
		const d = this.drag;
		if (this.dragFrame !== null) this.win.cancelAnimationFrame(this.dragFrame);
		this.dragFrame = null;
		if (!d) {
			this.dragAt = null;
			return;
		}
		this.drag = null;
		d.ghost.remove();
		d.indicator.remove();
		d.connector.remove();
		this.rootEl.removeClass(CLS.nodeDragging, CLS.dropPreview);
		this.setDropParent(null);
		for (const s of d.ids) this.views.get(s)?.el.removeClass(CLS.dragging);
		for (const s of d.exclude) this.views.get(s)?.el.removeClass(CLS.dragSource);
		if (restore) {
			this.dragAt = null;
			if (d.key !== "") this.render({ anchorId: null, animate: true });
		}
	}

	// ---- timers -------------------------------------------------------------

	private setTimer(fn: () => void, ms: number): number {
		const h = this.win.setTimeout(() => {
			this.timers.delete(h);
			if (!this.destroyed) fn();
		}, ms);
		this.timers.add(h);
		return h;
	}

	private clearTimer(h: number): void {
		this.win.clearTimeout(h);
		this.timers.delete(h);
	}
}

/** Size-cache key of a node's content at `font`. */
function contentKey(node: MapNode, plain: boolean, shown: string, font: NodeFont, maxWidth: number): string {
	return sizeKey((plain ? "p" : "r") + node.kind[0] + (node.text === "" ? "\u0000" : "") + shown, font, maxWidth);
}

/** What the ghost card copies from the grabbed node's computed style. */
const GHOST_STYLE = [
	"box-sizing",
	"padding-top",
	"padding-right",
	"padding-bottom",
	"padding-left",
	"border-top",
	"border-right",
	"border-bottom",
	"border-left",
	"border-radius",
	"background-color",
	"background-image",
	"box-shadow",
	"color",
	"font-family",
	"font-size",
	"font-weight",
	"font-style",
	"line-height",
	"text-align",
	"white-space",
	"overflow-wrap",
	"word-break",
] as const;

function r2(n: number): number {
	return Math.round(n * 100) / 100;
}

function findNode(root: MapNode, id: string): MapNode | null {
	const stack = [root];
	while (stack.length > 0) {
		const n = stack.pop() as MapNode;
		if (n.id === id) return n;
		for (const c of n.children) stack.push(c);
	}
	return null;
}

function depthOf(root: MapNode, id: string): number {
	const stack: { n: MapNode; d: number }[] = [{ n: root, d: 0 }];
	while (stack.length > 0) {
		const { n, d } = stack.pop() as { n: MapNode; d: number };
		if (n.id === id) return d;
		for (const c of n.children) stack.push({ n: c, d: d + 1 });
	}
	return 0;
}
