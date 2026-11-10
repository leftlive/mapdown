// Interfaces between the renderer (src/view/renderer.ts and friends) and the
// controller (src/view/MapView.ts, commands, saving). Also the DOM contract
// the e2e tests rely on. Change only together with every user.

import type { LayoutResult } from '../core/layout.ts';
import type { TaskCount } from '../core/tasks.ts';
import type { BranchStyle } from '../settings.ts';
import type { LayoutDirection, MapNode, Point } from '../core/types.ts';
import type { Rect, Viewport } from './viewport.ts';

/** CSS classes and attributes. e2e tests select by these; keep them stable. */
export const DOM = {
	/** On the view's contentEl. */
	view: 'mapdown-view',
	/**
	 * Root of a map embedded in a note (spec 5.10), appended to Obsidian's `.internal-embed`; never carries `view`.
	 * Its buttons carry data-action fit, open-map.
	 */
	embed: 'mapdown-embed',
	/** On the embed's root while it is active (spec 5.10): the plain wheel pans it. */
	embedActive: 'is-active',
	/** The hint inside an embed telling to click it first; `is-shown` while it shows. */
	embedHint: 'mapdown-embed-hint',
	/** The first-use tip inside an embed (spec 5.10); `is-shown` while visible; holds a close button (`mapdown-embed-tip-close`). */
	embedTip: 'mapdown-embed-tip',
	/**
	 * On the map layer (`.mapdown-map`, in map views and embeds alike) for the branch colour style (spec 5.12):
	 * `branchBorder` or `branchTint`; neither for `line`. Set by the renderer from `RenderModel.branchStyle`.
	 */
	branchBorder: 'mapdown-branch-border',
	branchTint: 'mapdown-branch-tint',
	/** The pannable, zoomable layer (CSS transform). */
	canvas: 'mapdown-canvas',
	/** One per rendered node; carries `data-node-id`, role="treeitem", tabindex. */
	node: 'mapdown-node',
	nodeIdAttr: 'data-node-id',
	selected: 'is-selected',
	primary: 'is-primary',
	collapsed: 'is-collapsed',
	editing: 'is-editing',
	/** The contenteditable element while a node is being edited. */
	editor: 'mapdown-node-editor',
	/** The single SVG holding every edge path. */
	edges: 'mapdown-edges',
	/** Toolbar; each button has `data-action` (undo, redo, zoom-in, zoom-out, fit, new-map, search, export). */
	toolbar: 'mapdown-toolbar',
	actionAttr: 'data-action',
	/** The node menu (spec 5.2, one node selected), rendered inside the view; items carry data-action add-child, delete, focus, insert-image. */
	nodeMenu: 'mapdown-node-menu',
	/**
	 * Floating bar of the multi-selection actions (spec 5.11, desktop), inside the view; `is-shown` while
	 * it shows. Buttons carry data-action make-tasks, bold, highlight, fold, copy, cut, delete.
	 */
	multiBar: 'mapdown-multi-bar',
	/** The same buttons as a column at the pointer: right click on a node of a multi-selection. */
	multiMenu: 'mapdown-multi-menu',
	/** On the map layer (`.mapdown-map`) while a box selection is being dragged. */
	boxSelecting: 'is-box-selecting',
	/** Collapse dot on an expanded node with children (shown on hover); the count pill is `.mapdown-node-badge`. */
	collapseToggle: 'mapdown-node-toggle',
	collapseBadge: 'mapdown-node-badge',
	/** Task checkbox (spec 5.9): the click target inside a task node's content; holds an `input[type=checkbox]` with `data-task`. */
	taskCheckbox: 'mapdown-task-checkbox',
	/**
	 * A map embedded in a node's text (`![[Map]]`, spec 5.10), drawn as a card inside the node's content;
	 * `data-map-link` holds what is written between the brackets. Clicking it opens the map.
	 */
	mapCard: 'mapdown-map-card',
	mapCardLink: 'data-map-link',
	/** "done/total" after the text of a node with task descendants; `is-complete` when all are done. */
	taskProgress: 'mapdown-task-progress',
	/** On a task node whose task is done. */
	taskDone: 'is-task-done',
	/** Line decoration in the Markdown editor, shown briefly after a map selection (spec 5.6). */
	syncLine: 'mapdown-sync-line',
	/**
	 * Node toolbar of the touch UI (spec 4.2); buttons carry data-action: add-child, add-sibling, edit, delete, promote,
	 * demote, move-up, move-down, toggle-collapse, insert-image, toggle-task, undo, redo. With two or more nodes selected
	 * these hide (except undo, redo) and the multi-selection buttons (5.11, class `is-multi`, data-action as on the bar) show.
	 */
	mobileToolbar: 'mapdown-mobile-toolbar',
	/** Overview of a map above 300 nodes (plan 3.4); clicking it moves the view. */
	minimap: 'mapdown-minimap',
	/** The rectangle inside the minimap that marks the visible area. */
	minimapView: 'mapdown-minimap-view',
	/** Search bar (spec 5.4) on the view; buttons carry data-action search-prev, search-next, search-close. */
	search: 'mapdown-search',
	searchInput: 'mapdown-search-input',
	/** "current / total". */
	searchCount: 'mapdown-search-count',
	/** On nodes matching the search, and on the current match. */
	searchMatch: 'is-search-match',
	searchCurrent: 'is-search-current',
	/** On the view's contentEl while focus mode (spec 5.3) is on. */
	focusMode: 'is-focus-mode',
	/** On the focus node. */
	focusRoot: 'is-focus-root',
	/** The Mapdown button in a Markdown view's header (spec 5.5). */
	headerAction: 'mapdown-header-action',
	splitAction: 'mapdown-split-action',
	/** Dialog for opening a plain note as a map (spec 6.2); buttons carry data-action convert, save-as-new, cancel. */
	convertModal: 'mapdown-convert-modal',
	/** Image picker (spec 5.8) on the modal; each item has this class and `data-action="choose-device"` or `data-path` (vault path). */
	imagePicker: 'mapdown-image-picker',
	imagePickerItem: 'mapdown-image-pick',
	/** Map picker of "Insert mind map…" (spec 5.10) on the modal; each item has this class and `data-action="new-map"` or `data-path` (vault path). */
	mapPicker: 'mapdown-map-picker',
	mapPickerItem: 'mapdown-map-pick',
} as const;

/** Everything the renderer needs to draw one frame. */
export interface RenderModel {
	root: MapNode;
	/** Ids of nodes whose children are hidden (collapsed and not temporarily expanded). */
	hidden: ReadonlySet<string>;
	/** When set, only this subtree is shown (focus mode). */
	focusId: string | null;
	selection: readonly string[];
	primary: string | null;
	direction: LayoutDirection;
	palette: readonly string[];
	fontSize: number;
	nodeMaxWidth: number;
	nodeGlowSize: number;
	/** Branch colour style (spec 5.12); absent means `line`. Switching it only changes classes, no layout. */
	branchStyle?: BranchStyle;
	/** Placeholder text for empty nodes (never written to the file). */
	placeholder: string;
	/** Search highlight (spec 5.4): matching ids and the current match. */
	searchMatches?: ReadonlySet<string>;
	searchCurrent?: string | null;
	/** Task progress by node id (spec 5.9); absent when `showTaskProgress` is off. */
	taskProgress?: ReadonlyMap<string, TaskCount>;
	/**
	 * Embedded map (spec 5.10): nothing changes the note. Task checkboxes show but do not toggle, there are
	 * no collapse dots, drags pan, a plain wheel and one finger are left to the page, no context menu, no
	 * tab stop, and the first view fits the drawing (never above 100%) instead of centring the root.
	 */
	readOnly?: boolean;
	/**
	 * Map embeds in node texts drawn as cards (spec 5.10): card label by what is written between the
	 * brackets of `![[…]]`. Embeds missing here (images, notes, missing files) render as before.
	 */
	mapCards?: ReadonlyMap<string, string>;
}

export interface Modifiers {
	mod: boolean;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
}

export type DropPlace = 'before' | 'after' | 'child';

/** Semantic input the renderer reports; the controller decides what it means. */
export interface RenderEvents {
	nodeClick(id: string, mods: Modifiers): void;
	nodeDoubleClick(id: string): void;
	backgroundClick(): void;
	/** Box selection finished (mouse drag on background, or long-press drag on touch). */
	boxSelect(ids: string[], additive: boolean): void;
	/** A node drag ended over a target. `copy` when Ctrl was held. */
	drop(ids: string[], targetId: string, place: DropPlace, copy: boolean): void;
	/** Right click or long press on a node. */
	contextMenu(id: string, at: Point): void;
	/** The text of the node being edited changed (every input event). */
	editInput(id: string, text: string): void;
	/** A link inside a node was clicked. */
	linkClick(href: string, evt: MouseEvent): void;
	/** Image files were pasted into the node editor without text (spec 5.8). */
	pasteFiles?(id: string, files: File[]): void;
	/** The pointer entered an internal link inside a node (for the page preview). */
	linkHover?(href: string, el: HTMLElement, evt: MouseEvent): void;
	/** The collapse dot or the hidden-count pill of a node was clicked: toggle that node. */
	toggleCollapse?(id: string): void;
	/** The task checkbox of a node was clicked or tapped (never in a read-only model): toggle that task. */
	taskToggle?(id: string): void;
	/** A map card was clicked (spec 5.10, also in read-only maps): open that map. `link` is the text inside `![[…]]`. */
	cardClick?(link: string, evt: MouseEvent): void;
	/** Viewport changed (pan/zoom), e.g. to update toolbar state. */
	viewportChange(): void;
	/** Nodes were laid out again (also after sizes settled on a later frame). */
	layoutChange?(): void;
}

/** Services the renderer gets from Obsidian through the controller. */
export interface RenderHost {
	/** Render Markdown into `el` (wraps MarkdownRenderer.render with the right component and source path). */
	renderMarkdown(text: string, el: HTMLElement): Promise<void>;
	/** True if the user asked the OS to reduce motion. */
	reducedMotion(): boolean;
}

export interface EditorHandle {
	readonly element: HTMLElement;
	getText(): string;
	/** Selected range inside the text, in characters. */
	getSelection(): { from: number; to: number };
	insertText(text: string): void;
	/** Replace the whole text and put the caret at `caret` (character offset). Fires the same editInput as typing. */
	setText(text: string, caret: number): void;
	/** Wrap the selection with `marker` (e.g. `**`), or unwrap if already wrapped. */
	toggleWrap(marker: string): void;
	/** True while an IME composition is in progress; map keys must not fire then. */
	isComposing(): boolean;
}

export interface MapRenderer {
	/** Draw the model. Only changed nodes are re-rendered and re-measured. `anchorId` stays fixed on screen. */
	update(model: RenderModel, opts?: { anchorId?: string | null; animate?: boolean }): void;
	/** The DOM element of a rendered node (null when virtualized away or hidden). */
	nodeElement(id: string): HTMLElement | null;
	/** Ids of nodes currently rendered as DOM (for tests and virtualization checks). */
	renderedIds(): string[];
	/** The last layout (read-only; the export draws from it). Null before the first render. */
	layoutSnapshot(): LayoutResult | null;
	/**
	 * What the last layout used besides the node sizes (focus mode lays out on its branch's side, in its
	 * colour) and the node max width; the export lays out again with these (spec 2.3). Null before the first render.
	 */
	layoutParams(): { direction: LayoutDirection; palette: readonly string[]; nodeMaxWidth: number } | null;
	scrollIntoView(id: string): void;
	/**
	 * The part of the map not covered by floating UI (spec 5.1, available area), in map pixels. Measures
	 * the covering elements, so call it for one-off placements, not on every frame.
	 */
	usableArea(): Rect;
	/** Current pan and zoom (a copy). */
	readonly viewport: Viewport;
	/** Put back a viewport read from `viewport` (leaving focus mode, spec 5.3). */
	restoreViewport(vp: Viewport): void;
	/** Show the focused subtree on entering focus mode (spec 5.3); no-op before the first layout. */
	fitFocus(): void;
	centerOn(id: string | null): void;
	/** Put the world point `p` in the middle of the view (minimap jump). */
	centerOnPoint(p: Point): void;
	zoomBy(factor: number, at?: Point): void;
	fit(): void;
	/** Read-only maps only: true lets the plain wheel pan the map (an active embed, spec 5.10) instead of scrolling the page. */
	wheelPan: boolean;
	readonly zoom: number;
	/** Turn a node into an inline editor; caret at end, or all text selected. */
	startEditing(id: string, text: string, caret: 'end' | 'all'): EditorHandle;
	stopEditing(): void;
	/** Move keyboard focus to the node element (for focus ring and screen readers). */
	focusNode(id: string): void;
	destroy(): void;
}

export type CreateRenderer = (container: HTMLElement, host: RenderHost, events: RenderEvents) => MapRenderer;
