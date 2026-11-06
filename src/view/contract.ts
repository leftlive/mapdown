// Interfaces between the renderer (src/view/renderer.ts and friends) and the
// controller (src/view/MapView.ts, commands, saving). Also the DOM contract
// the e2e tests rely on. Change only together with every user.

import type { LayoutResult } from '../core/layout.ts';
import type { LayoutDirection, MapNode, Point } from '../core/types.ts';
import type { Viewport } from './viewport.ts';

/** CSS classes and attributes. e2e tests select by these; keep them stable. */
export const DOM = {
	/** On the view's contentEl. */
	view: 'mapdown-view',
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
	/** The node menu (spec 5.2), rendered inside the view; items carry data-action add-child, delete, focus, insert-image. */
	nodeMenu: 'mapdown-node-menu',
	/** Collapse dot on an expanded node with children (shown on hover); the count pill is `.mapdown-node-badge`. */
	collapseToggle: 'mapdown-node-toggle',
	collapseBadge: 'mapdown-node-badge',
	/** Line decoration in the Markdown editor, shown briefly after a map selection (spec 5.6). */
	syncLine: 'mapdown-sync-line',
	/** Node toolbar of the touch UI (spec 4.2); buttons carry data-action: add-child, add-sibling, edit, delete, promote, demote, move-up, move-down, toggle-collapse, insert-image, undo, redo. */
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
	/** Dialog for opening a plain note as a map (spec 6.2); buttons carry data-action convert, save-as-new, cancel. */
	convertModal: 'mapdown-convert-modal',
	/** Image picker (spec 5.8) on the modal; each item has this class and `data-action="choose-device"` or `data-path` (vault path). */
	imagePicker: 'mapdown-image-picker',
	imagePickerItem: 'mapdown-image-pick',
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
	/** Placeholder text for empty nodes (never written to the file). */
	placeholder: string;
	/** Search highlight (spec 5.4): matching ids and the current match. */
	searchMatches?: ReadonlySet<string>;
	searchCurrent?: string | null;
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
	/** Viewport changed (pan/zoom), e.g. to update toolbar state. */
	viewportChange(): void;
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
	scrollIntoView(id: string): void;
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
	readonly zoom: number;
	/** Turn a node into an inline editor; caret at end, or all text selected. */
	startEditing(id: string, text: string, caret: 'end' | 'all'): EditorHandle;
	stopEditing(): void;
	/** Move keyboard focus to the node element (for focus ring and screen readers). */
	focusNode(id: string): void;
	destroy(): void;
}

export type CreateRenderer = (container: HTMLElement, host: RenderHost, events: RenderEvents) => MapRenderer;
