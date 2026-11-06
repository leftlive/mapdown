// The mind-map view: an Obsidian TextFileView whose data is the note's text.
//
// The text is the single source of truth (development plan 3.1). The view
// owns a DocSession (text, parsed tree, view state, history) and a renderer
// (src/view/renderer.ts, through the contract). Every map operation becomes
// edits on the text; they are written
// - through the Markdown editor's transaction when the same file is open in
//   one (`addToHistory: false`, so the editor's own undo does not see it),
// - otherwise into this view's data, saved by Obsidian after a short delay.
// Text changed elsewhere comes back in through `incoming` (disk) or
// `onEditorChange` (a Markdown editor), is re-parsed and reconciled, and the
// map keeps its selection.

import { Annotation, Transaction, type ChangeSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { MarkdownRenderer, MarkdownView, Notice, Platform, Scope, TextFileView, setIcon, type HoverParent, type HoverPopover, type Menu, type TFile, type WorkspaceLeaf } from 'obsidian';
import { DEFAULT_PALETTE } from '../core/layout.ts';
import { childPosition, findNodeAt, insertNodes, insertSibling, moveNodes, pasteMarkdown, setText, type NodeInput, type Position } from '../core/ops.ts';
import { parseDocument } from '../core/parse.ts';
import {
	clearFocus,
	clearSelection,
	pruneSelection,
	selectOnly,
	selectRange,
	selectedInOrder,
	setFocus,
	toggleSelection,
	topmostSelected,
	visibleNodes,
	collapsedIdsForSave,
} from '../core/state.ts';
import type { LayoutDirection, MapNode, TextEdit } from '../core/types.ts';
import {
	fromClipboardJson,
	jsonFromClipboardHtml,
	navigate,
	sidesOf,
	toClipboardHtml,
	toClipboardJson,
	toClipboardOutline,
	type Arrow,
	type ClipNode,
} from '../controller/actions.ts';
import { collapseSteps, DocSession, indexNodes, keepSelection, type RunOptions, type SessionChange, type StepFn } from '../controller/session.ts';
import { applyTextEdits, composeEdits, diffTexts } from '../controller/textEdits.ts';
import { COMMAND_BY_ID, deleteSelection, runCommand } from '../commands.ts';
import { SelectionSync, type SyncEnv } from '../controller/selectionSync.ts';
import { stateJson, toMapText } from '../controller/convertNote.ts';
import { cursorTarget, nodeLine } from '../controller/sourceLines.ts';
import { getEditorView, revealLineInMarkdown } from '../editorSync.ts';
import { FileSuggest } from '../fileSuggest.ts';
import { t } from '../i18n.ts';
import { installKeymap, type KeyTarget } from '../keymap.ts';
import { availablePath, fileNameFromRoot, folderOf, writeSafetyCopy } from '../save.ts';
import type MapdownPlugin from '../main.ts';
import { DOM, type EditorHandle, type MapRenderer, type Modifiers, type DropPlace, type RenderEvents, type RenderHost } from './contract.ts';
import { MobileToolbar } from './mobileToolbar.ts';
import { addImageFiles, installImageDrop, openImagePicker } from './nodeImages.ts';
import { appendLine, extensionForMime, pastedImageName } from '../nodeImage.ts';
import { createRenderer } from './renderer.ts';
import { SearchBar } from './search.ts';
import type { Viewport } from './viewport.ts';
import { exportMap, showExportMenu, type ExportFormat } from '../export/exporter.ts';

export const VIEW_TYPE = 'mindmapViewUpgraded';

/** Marks transactions this plugin dispatches, so the editor listener ignores their echo. */
export const mapdownEdit = Annotation.define<boolean>();

/** Delay before text typed in a Markdown editor is re-parsed into the map. */
const EDITOR_REPARSE_MS = 120;
const TEXT_UPDATE = 'mapdown:text-update';
const TEXT_UPDATE_START = 'mapdown:text-update-start';
const DRAFT_MS = 1000;
const ARROW_KEYS: Record<string, Arrow> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

interface Editing {
	id: string;
	handle: EditorHandle;
	original: string;
}

export class MapView extends TextFileView implements KeyTarget, HoverParent {
	readonly plugin: MapdownPlugin;
	/** Owned by Obsidian's page preview (hover-link); makes the view a HoverParent. */
	hoverPopover: HoverPopover | null = null;
	readonly session = new DocSession('', '');
	renderer: MapRenderer | null = null;

	private editing: Editing | null = null;
	/** Text of each node before its last edit in the map ("Replace by the previous text"). */
	private readonly previousText = new Map<string, string>();
	private suggest: FileSuggest | null = null;
	private search: SearchBar | null = null;
	/** Focus node of the last render (to notice focus mode ending because its node went away). */
	private focusShown: string | null = null;
	/** Pan and zoom when focus mode was entered, put back on leaving it (spec 5.3). */
	private focusSavedViewport: Viewport | null = null;
	private toolbarEl: HTMLElement | null = null;
	private mobileBar: MobileToolbar | null = null;
	private mapEl: HTMLElement | null = null;
	private menuEl: HTMLElement | null = null;
	private menuFor: string | null = null;
	private pendingArrow: Arrow | null = null;
	/** Text known to be on disk (loaded, saved by us, or read back). */
	private savedText = '';
	/** Text of a save in progress (its modify event is an echo, not an outside change). */
	private writing: string | null = null;
	/** Disk text whose conflict copy is being written. */
	private handling: string | null = null;
	private loaded = false;
	private unsupported = false;
	private renamePending = false;
	/** 6.2 convert in place: the first save backs up the note and writes it in the map format. */
	private convertPending = false;
	private converting: Promise<boolean> | null = null;
	private lastBoxSelect = 0;
	private draftTimer: number | null = null;
	private editorTimer: number | null = null;
	private editorBase: string | null = null;
	private editorEdits: TextEdit[] = [];
	private editorText = '';
	/** The last write went through this Markdown view's editor. */
	private lastEditorView: MarkdownView | null = null;
	/** Split-view selection sync with a Markdown view of the same note (spec 5.6). */
	private readonly sync = new SelectionSync();
	/** Exports in progress; closing the view cancels them quietly. */
	private readonly exports = new Set<AbortController>();

	constructor(leaf: WorkspaceLeaf, plugin: MapdownPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.session.onChange((c) => this.onSessionChange(c));
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.basename ?? t('Untitled mindmap');
	}

	getIcon(): string {
		return 'mapdown';
	}

	/** The "..." menu (spec 5.5): switch this tab back to Markdown. */
	override onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		menu.addItem((item) =>
			item
				.setTitle(t('Open as markdown'))
				.setIcon('file-text')
				.setSection('pane')
				.onClick(() => void this.plugin.setMarkdownView(this.leaf)),
		);
	}

	canEdit(): boolean {
		return this.loaded && !this.unsupported && this.file !== null;
	}

	isEditing(): boolean {
		return this.editing !== null;
	}

	editingHandle(): EditorHandle | null {
		return this.editing?.handle ?? null;
	}

	isComposing(evt: KeyboardEvent): boolean {
		if (evt.isComposing || evt.key === 'Process') return true;
		if (this.editing?.handle.isComposing()) return true;
		// Keys typed in the search box belong to it, composing or not: never map keys.
		return this.search !== null && (this.search.isComposing() || this.search.ownsEvent(evt));
	}

	headLevel(): number {
		return this.plugin.settings.headLevel;
	}

	direction(): LayoutDirection {
		return this.plugin.settings.layoutDirect;
	}

	// ------------------------------------------------------------ lifecycle

	async onOpen(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass(DOM.view);
		el.tabIndex = -1;
		// The renderer's layer fills the view; toolbar and menu sit above it.
		this.mapEl = el;
		this.renderer = createRenderer(el, this.renderHost(), this.renderEvents());
		this.buildToolbar(el);
		if (Platform.isMobile) this.mobileBar = new MobileToolbar(el, this);
		this.menuEl = el.createDiv({ cls: DOM.nodeMenu });
		this.menuEl.hide();
		this.buildMenu(this.menuEl);
		installImageDrop(this);
		this.scope = new Scope(this.app.scope);
		installKeymap(this.scope, this);
		const doc = el.ownerDocument;
		this.registerDomEvent(doc, 'keyup', (evt) => this.onKeyUp(evt));
		this.registerDomEvent(doc, 'pointerdown', (evt) => {
			if (this.menuEl && !this.menuEl.contains(evt.target as Node)) this.hideMenu();
		});
		this.applySettings();
		if (this.loaded) this.render();
		await super.onOpen();
	}

	async onClose(): Promise<void> {
		for (const c of this.exports) c.abort();
		this.exports.clear();
		this.commitEdit();
		this.clearTimers();
		this.suggest?.destroy();
		this.suggest = null;
		this.search?.destroy();
		this.search = null;
		this.mobileBar?.destroy();
		this.mobileBar = null;
		this.renderer?.destroy();
		this.renderer = null;
		await super.onClose();
	}

	async onUnloadFile(file: TFile): Promise<void> {
		this.commitEdit();
		this.flushEditorChanges();
		await super.onUnloadFile(file);
	}

	onRename(file: TFile): Promise<void> {
		this.session.rootName = file.basename;
		this.render();
		return super.onRename(file);
	}

	/** The window this view is shown in (a popout window has its own timers, frames and media queries). */
	private get win(): Window {
		return this.contentEl.win;
	}

	private clearTimers(): void {
		if (this.draftTimer !== null) this.win.clearTimeout(this.draftTimer);
		if (this.editorTimer !== null) this.win.clearTimeout(this.editorTimer);
		this.draftTimer = null;
		this.editorTimer = null;
	}

	getViewData(): string {
		return this.unsupported ? this.data : this.session.text;
	}

	setViewData(data: string, clear: boolean): void {
		if (clear || !this.loaded) this.loadText(data);
		else void this.incoming(data);
	}

	clear(): void {
		this.commitEdit();
		this.clearTimers();
		this.search?.close(false);
		this.focusShown = null;
		this.focusSavedViewport = null;
		this.editing = null;
		this.previousText.clear();
		this.loaded = false;
		this.unsupported = false;
		this.renamePending = false;
		this.convertPending = false;
		this.editorBase = null;
	}

	private loadText(data: string): void {
		this.data = data;
		this.savedText = data;
		this.editorBase = null;
		const parsed = parseDocument(data);
		if (parsed.frontmatter?.stateError) {
			// Contract 3.1: open as Markdown, tell the user, leave the file alone.
			this.unsupported = true;
			this.loaded = true;
			new Notice(t('Unsupported mindmark-state'));
			const file = this.file;
			if (file) this.win.setTimeout(() => void this.plugin.openAsMarkdown(this.leaf, file, 'once'), 0);
			return;
		}
		this.unsupported = false;
		this.session.rootName = this.file?.basename ?? '';
		this.session.load(data);
		const root = this.session.doc.root.id;
		this.session.setSelection([root], root);
		// Opening is not a selection to follow in Markdown.
		this.sync.reset(root);
		this.loaded = true;
		this.render();
		this.renderer?.centerOn(root);
		if (this.app.workspace.getActiveViewOfType(MapView) === (this as MapView)) this.focusMap();
		const file = this.file;
		if (file) void this.checkRecovery(file, data);
	}

	/** The file's text changed on disk (sync, another program, a Markdown view that saved). */
	private async incoming(disk: string): Promise<void> {
		if (!this.canEdit()) {
			this.data = disk;
			return;
		}
		this.flushEditorChanges();
		if (disk === this.session.text) {
			this.savedText = disk;
			return;
		}
		if (disk === this.savedText || disk === this.writing || disk === this.handling) return;
		// An edit in progress is an unsaved change too: write it first so the conflict copy keeps it.
		this.commitEdit();
		const file = this.file;
		const dirty = this.session.text !== this.savedText;
		if (dirty && file) {
			// 6.5: keep both sides. The map's version goes to a conflict copy.
			const mine = this.session.text;
			this.handling = disk;
			try {
				const path = await writeSafetyCopy(this.app, file, 'conflict', mine);
				new Notice(t('Conflict saved', path));
			} catch {
				// Could not write the copy: keep the map's version instead of losing it.
				return;
			} finally {
				this.handling = null;
			}
		}
		this.savedText = disk;
		this.data = disk;
		this.session.external(disk);
		void this.plugin.recovery.remove(file?.path ?? '');
	}

	/** Called by the plugin when the vault reports a modification of this file. */
	async onFileModified(): Promise<void> {
		const file = this.file;
		if (!file || !this.canEdit() || this.markdownEditor()) return;
		const disk = await this.app.vault.read(file);
		await this.incoming(disk);
	}

	private async checkRecovery(file: TFile, disk: string): Promise<void> {
		const draft = await this.plugin.recovery.read(file.path);
		if (draft === null) return;
		if (draft !== disk) {
			const path = await writeSafetyCopy(this.app, file, 'recovered', draft);
			new Notice(t('Recovered draft', path));
		}
		await this.plugin.recovery.remove(file.path);
	}

	async save(clear?: boolean): Promise<void> {
		if (!this.canEdit()) return;
		if (this.converting) {
			if (!(await this.converting)) return;
		} else if (this.convertPending) {
			this.converting = this.convertBeforeSave();
			try {
				if (!(await this.converting)) return;
			} finally {
				this.converting = null;
			}
		}
		const text = this.session.text;
		this.writing = text;
		try {
			await super.save(clear);
		} finally {
			this.writing = null;
		}
		this.savedText = text;
		const file = this.file;
		if (file && this.session.text === text) await this.plugin.recovery.remove(file.path);
		if (this.renamePending && !this.editing) await this.renameToRoot();
	}

	/** 6.2: this plain note was opened as a map to be converted in place. */
	beginConversion(): void {
		// The text decides, not the metadata cache (it may not have indexed a map note yet).
		if (this.canEdit() && !this.session.doc.frontmatter?.isMindmap) this.convertPending = true;
	}

	/**
	 * Before the first save that writes a change: back up the note as it is on
	 * disk, then turn the text into the map format (whole, contract 6). False
	 * when the backup could not be written; nothing is saved then.
	 */
	private async convertBeforeSave(): Promise<boolean> {
		const file = this.file;
		if (!file || this.session.text === this.savedText) return true;
		this.convertPending = false;
		const original = this.savedText;
		try {
			const path = await writeSafetyCopy(this.app, file, 'backup', original);
			new Notice(t('Backup saved', path));
		} catch {
			this.convertPending = true;
			return false;
		}
		const collapsed = collapsedIdsForSave(this.session.doc.root, this.session.view).ids;
		const state = stateJson(collapsed, this.session.doc.frontmatter?.state?.extra ?? {});
		const finalNewline = original === '' || original.endsWith('\n');
		this.session.external(toMapText(this.session.text, { headLevel: this.headLevel(), state, finalNewline }));
		this.data = this.session.text;
		return true;
	}

	/** Write pending changes (test API, export, close). */
	async flush(): Promise<void> {
		this.commitEdit();
		this.flushEditorChanges();
		const md = this.lastEditorView;
		if (md && md.file === this.file) await md.save();
		if (this.session.text !== this.savedText || this.renamePending) await this.save();
	}

	/** 6.3: a real level-1 root renames the file after its text changed in the map. */
	private async renameToRoot(): Promise<void> {
		this.renamePending = false;
		const file = this.file;
		const doc = this.session.doc;
		if (!file || doc.virtualRoot) return;
		const name = fileNameFromRoot(doc.root.text);
		if (!name || name === file.basename) return;
		const path = availablePath(folderOf(file.path), name, (p) => this.app.vault.getAbstractFileByPath(p) !== null, file.path);
		if (path === file.path) return;
		try {
			await this.app.fileManager.renameFile(file, path);
		} catch (err) {
			new Notice(t('Rename failed', err instanceof Error ? err.message : String(err)));
		}
	}

	// ------------------------------------------------------------ text in and out

	/** The Markdown views (with an editor) that show this file. */
	private markdownEditor(): { view: MarkdownView; cm: EditorView } | null {
		const file = this.file;
		if (!file) return null;
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === file.path) {
				const cm = getEditorView(view);
				if (cm) return { view, cm };
			}
		}
		return null;
	}

	/** Before an operation: take in text typed in a Markdown editor, so edits apply to the current text. */
	private prepare(): void {
		this.flushEditorChanges();
		const md = this.markdownEditor();
		if (md) {
			const text = md.cm.state.doc.toString();
			if (text !== this.session.text) this.session.external(text);
		}
	}

	/** A Markdown editor showing this file changed (not by us). */
	onEditorChange(edits: TextEdit[], text: string): void {
		if (!this.canEdit()) return;
		if (this.editorBase === null) {
			this.editorBase = this.session.text;
			this.editorEdits = [];
		}
		const base = this.editorBase;
		try {
			this.editorEdits = composeEdits(base, this.editorEdits, edits);
		} catch {
			this.editorEdits = diffTexts(base, text);
		}
		this.editorText = text;
		this.data = text;
		if (this.editorTimer !== null) this.win.clearTimeout(this.editorTimer);
		this.editorTimer = this.win.setTimeout(() => {
			this.editorTimer = null;
			this.flushEditorChanges();
		}, EDITOR_REPARSE_MS);
	}

	private flushEditorChanges(): void {
		if (this.editorTimer !== null) {
			this.win.clearTimeout(this.editorTimer);
			this.editorTimer = null;
		}
		const base = this.editorBase;
		if (base === null) return;
		this.editorBase = null;
		performance.mark(TEXT_UPDATE_START);
		const text = this.editorText;
		const edits = applyTextEdits(base, this.editorEdits) === text ? this.editorEdits : diffTexts(base, text);
		if (base === this.session.text) this.session.external(text, edits);
		else this.session.external(text);
		// The editor saves the file itself; what it shows is what will be on disk.
		this.savedText = text;
		this.afterEditorFlush();
		// Plan §4: plugin time of one typing update (only the latest entry is kept).
		performance.clearMeasures(TEXT_UPDATE);
		performance.measure(TEXT_UPDATE, TEXT_UPDATE_START);
		performance.clearMarks(TEXT_UPDATE_START);
	}

	// ------------------------------------------------------------ split-view sync (spec 5.6)

	/** The cursor of a focused Markdown editor of this file moved to `line` (0-based). */
	onEditorCursor(line: number): void {
		if (!this.canEdit()) return;
		// While typed text is not parsed yet, the line is resolved after the flush.
		const now = this.sync.cursor(line, this.editorBase !== null);
		if (now !== null) this.applyCursorLine(now);
	}

	private applyCursorLine(line: number): void {
		if (!this.canEdit() || this.editing || !this.plugin.settings.syncSelection) return;
		const id = cursorTarget(this.session.doc, this.session.view, line);
		if (id === null) return;
		// Recorded first, so the render below does not send the selection back.
		this.sync.selectedFromEditor(id);
		const sel = this.session.view.selection;
		if (sel.primary === id && sel.ids.length === 1) return;
		this.select([id], id);
	}

	private afterEditorFlush(): void {
		const md = this.markdownView();
		const { line, reveal } = this.sync.afterFlush(md?.cm?.hasFocus ?? false);
		if (line !== null) this.applyCursorLine(line);
		if (reveal) this.syncToText(true);
	}

	/** After a render: a changed map selection scrolls the Markdown view to the node's line. */
	private syncToText(retry = false): void {
		const primary = this.session.view.selection.primary;
		if (!retry && !this.sync.changed(primary)) return;
		const md = this.markdownView();
		const env: SyncEnv = {
			enabled: this.plugin.settings.syncSelection && this.canEdit() && md !== null,
			mapActive:
				this.app.workspace.getActiveViewOfType(MapView) === (this as MapView) ||
				this.contentEl.contains(this.contentEl.ownerDocument.activeElement),
			editorFocused: md?.cm?.hasFocus ?? false,
			editorCurrent: () => (md?.cm ? md.cm.state.doc.toString() : md?.view.getViewData()) === this.session.text,
		};
		const id = retry ? this.sync.retry(primary, env) : this.sync.afterRender(primary, env);
		const line = id === null ? null : nodeLine(this.session.doc, id);
		if (md && line !== null) revealLineInMarkdown(md.view, line);
	}

	/** A Markdown view of this file, in any mode (reading mode has no editor to type in). */
	private markdownView(): { view: MarkdownView; cm: EditorView | null } | null {
		const file = this.file;
		if (!file) return null;
		const active = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (active?.file?.path === file.path) return { view: active, cm: getEditorView(active) };
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === file.path) return { view, cm: getEditorView(view) };
		}
		return null;
	}

	private onSessionChange(c: SessionChange): void {
		if (c.origin === 'op' || c.origin === 'undo' || c.origin === 'redo') {
			this.writeOut(c.edits, c.previousText);
			if (c.rootTextChanged && !this.session.doc.virtualRoot) this.renamePending = true;
			this.scheduleDraft();
		}
		// Text changed elsewhere: whatever selection survives it is not a map selection to follow.
		if (c.origin === 'external' || c.origin === 'load') this.sync.adopt(this.session.view.selection.primary);
		// The text changed: matches may have too (the current one is kept while it still matches).
		this.search?.refresh(false);
		if (c.origin !== 'load') this.render();
	}

	private writeOut(edits: TextEdit[], previousText: string): void {
		const md = this.markdownEditor();
		this.data = this.session.text;
		if (md) {
			const cur = md.cm.state.doc.toString();
			const specs: ChangeSpec[] =
				cur === previousText
					? edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert }))
					: diffTexts(cur, this.session.text).map((e) => ({ from: e.from, to: e.to, insert: e.insert }));
			md.cm.dispatch({ changes: specs, annotations: [Transaction.addToHistory.of(false), mapdownEdit.of(true)] });
			this.lastEditorView = md.view;
			md.view.requestSave();
			return;
		}
		this.lastEditorView = null;
		this.requestSave();
	}

	private scheduleDraft(): void {
		if (this.draftTimer !== null) this.win.clearTimeout(this.draftTimer);
		this.draftTimer = this.win.setTimeout(() => {
			this.draftTimer = null;
			const file = this.file;
			if (file && this.canEdit() && this.session.text !== this.savedText) {
				void this.plugin.recovery.write(file.path, this.session.text);
			}
		}, DRAFT_MS);
	}

	// ------------------------------------------------------------ rendering

	applySettings(): void {
		const s = this.plugin.settings;
		this.mapEl?.setCssProps({
			'--mapdown-background': s.background,
			// focus mode (spec 5.3, settings 8)
			'--mapdown-focus-overlay': `${Math.round(s.focusOverlayOpacity * 100)}%`,
			'--mapdown-focus-glow-size': `${s.focusGlowSize}px`,
		});
		this.render();
	}

	render(anchorId: string | null = this.session.view.selection.primary): void {
		const r = this.renderer;
		if (!r || !this.loaded || this.unsupported) return;
		const doc = this.session.doc;
		const v = this.session.view;
		const root: MapNode = doc.virtualRoot ? { ...doc.root, text: this.session.rootName } : doc.root;
		const hidden = new Set([...v.collapsed].filter((id) => !v.tempExpanded.has(id)));
		// Read before the update: a deleted focus node still holds keyboard focus here.
		const hadFocus = this.contentEl.contains(this.contentEl.ownerDocument.activeElement);
		const s = this.plugin.settings;
		r.update(
			{
				root,
				hidden,
				focusId: v.focus,
				selection: v.selection.ids,
				primary: v.selection.primary,
				direction: s.layoutDirect,
				palette: s.strokeArray && s.strokeArray.length > 0 ? s.strokeArray : DEFAULT_PALETTE,
				fontSize: s.fontSize,
				nodeMaxWidth: s.nodeMaxWidth,
				nodeGlowSize: s.nodeGlowSize,
				placeholder: t('Placeholder'),
				searchMatches: this.search?.matches,
				searchCurrent: this.search?.current ?? null,
			},
			{ anchorId },
		);
		// Focus mode follows the view state, so it also ends when the focus node is deleted.
		const lostFocus = this.focusShown !== null && v.focus === null;
		this.focusShown = v.focus;
		this.contentEl.toggleClass(DOM.focusMode, v.focus !== null);
		if (lostFocus) {
			this.focusSavedViewport = null;
			this.centerOnPrimary();
			// Only take keyboard focus back when the map had it (not from a Markdown editor typing in a split).
			if (hadFocus) this.focusMap();
		}
		this.updateToolbar();
		this.mobileBar?.update();
		this.syncToText();
	}

	private renderHost(): RenderHost {
		return {
			renderMarkdown: (text, el) => MarkdownRenderer.render(this.app, text, el, this.file?.path ?? '', this),
			reducedMotion: () => this.win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
		};
	}

	private renderEvents(): RenderEvents {
		return {
			nodeClick: (id, mods) => this.onNodeClick(id, mods),
			toggleCollapse: (id) => {
				this.hideMenu();
				const next = new Set(this.session.view.collapsed);
				if (next.has(id)) next.delete(id);
				else next.add(id);
				this.setCollapsed(next);
			},
			nodeDoubleClick: (id) => {
				this.select([id], id, false);
				this.startEdit(id, 'end');
			},
			backgroundClick: () => {
				this.hideMenu();
				this.commitEdit();
				if (Date.now() - this.lastBoxSelect < 300) return;
				this.session.setView(clearSelection(this.session.view));
				this.render();
			},
			boxSelect: (ids, additive) => {
				this.commitEdit();
				this.lastBoxSelect = Date.now();
				const cur = this.session.view.selection;
				const all = additive ? [...cur.ids.filter((x) => !ids.includes(x)), ...ids] : ids;
				this.select(all, all[all.length - 1] ?? null, false);
			},
			drop: (ids, targetId, place, copy) => this.onDrop(ids, targetId, place, copy),
			contextMenu: (id) => this.showMenu(id),
			editInput: () => this.updateSuggest(),
			pasteFiles: (id, files) => void addImageFiles(this, id, files, true),
			linkClick: (href, evt) => this.plugin.openLink(href, this.file?.path ?? '', evt),
			linkHover: (href, el, evt) => this.hoverLink(href, el, evt),
			viewportChange: () => {},
		};
	}

	/** Hand a hovered internal link to Obsidian's page preview (spec 5.7); the core plugin is not switched on here. */
	private hoverLink(href: string, el: HTMLElement, evt: MouseEvent): void {
		if (!this.plugin.settings.enableLinkPreview) return;
		this.app.workspace.trigger('hover-link', {
			event: evt,
			source: 'mapdown',
			hoverParent: this,
			targetEl: el,
			linktext: href,
			sourcePath: this.file?.path ?? '',
		});
	}

	// ------------------------------------------------------------ toolbar and menu

	private buildToolbar(parent: HTMLElement): void {
		const bar = parent.createDiv({ cls: DOM.toolbar });
		this.toolbarEl = bar;
		const button = (group: HTMLElement, action: string, icon: string, label: string, run: () => void): void => {
			const b = group.createEl('button', { cls: 'clickable-icon', attr: { [DOM.actionAttr]: action, 'aria-label': label } });
			setIcon(b, icon);
			b.addEventListener('click', (evt) => {
				evt.preventDefault();
				run();
			});
		};
		const edit = bar.createDiv({ cls: 'mapdown-toolbar-group' });
		button(edit, 'new-map', 'file-plus-2', t('Create New MindMap'), () => void this.plugin.newMindMap());
		button(edit, 'search', 'search', t('Search nodes'), () => this.openSearch());
		button(edit, 'undo', 'undo-2', t('Undo'), () => this.undo());
		button(edit, 'redo', 'redo-2', t('Redo'), () => this.redo());
		button(edit, 'export', 'download', t('Export'), () => showExportMenu(this));
		const view = bar.createDiv({ cls: 'mapdown-toolbar-group' });
		button(view, 'zoom-in', 'zoom-in', t('Zoom in'), () => this.renderer?.zoomBy(1.2));
		button(view, 'zoom-out', 'zoom-out', t('Zoom out'), () => this.renderer?.zoomBy(1 / 1.2));
		button(view, 'fit', 'maximize', t('fit-view'), () => this.renderer?.fit());
	}

	private updateToolbar(): void {
		const bar = this.toolbarEl;
		if (!bar) return;
		const set = (action: string, enabled: boolean): void => {
			const b = bar.querySelector<HTMLButtonElement>(`[${DOM.actionAttr}="${action}"]`);
			if (!b) return;
			b.disabled = !enabled;
			b.toggleClass('is-disabled', !enabled);
		};
		set('search', this.canEdit());
		set('export', this.canEdit());
		set('undo', this.session.history.undoSize > 0);
		set('redo', this.session.history.redoSize > 0);
	}

	private buildMenu(menu: HTMLElement): void {
		const item = (action: string, icon: string, label: string, run: (id: string) => void): void => {
			const b = menu.createEl('button', { cls: 'clickable-icon', attr: { [DOM.actionAttr]: action, 'aria-label': label } });
			setIcon(b, icon);
			b.createSpan({ text: label });
			b.addEventListener('click', (evt) => {
				evt.preventDefault();
				const id = this.menuFor;
				this.hideMenu();
				if (id !== null) run(id);
			});
		};
		item('add-child', 'plus', t('Add child node'), (id) => {
			this.select([id], id, false);
			runCommand(this, 'Insert child');
		});
		item('delete', 'trash-2', t('Delete node'), (id) => {
			const sel = this.session.view.selection.ids;
			deleteSelection(this, sel.includes(id) ? [...sel] : [id]);
		});
		item('focus', 'focus', t('Focus node'), (id) => {
			if (this.session.view.focus === id) this.exitFocus();
			else this.enterFocus(id);
		});
		item('insert-image', 'image-plus', t('insert-image'), (id) => {
			this.select([id], id, false);
			runCommand(this, 'insert-image');
		});
	}

	private showMenu(id: string): void {
		const menu = this.menuEl;
		if (!menu || !this.canEdit()) return;
		this.commitEdit();
		const sel = this.session.view.selection.ids;
		if (!sel.includes(id)) this.select([id], id, false);
		this.menuFor = id;
		const nodeEl = this.renderer?.nodeElement(id);
		const box = this.contentEl.getBoundingClientRect();
		const rect = nodeEl?.getBoundingClientRect();
		menu.show();
		if (rect) {
			// Outer side of the node (5.2): left of a node left of the root, else right.
			const left = sidesOf(this.session.doc.root, this.direction()).get(id) === 'left';
			const top = rect.top - box.top;
			const x = left ? rect.left - box.left - menu.offsetWidth - 8 : rect.right - box.left + 8;
			menu.setCssStyles({ top: `${Math.round(top)}px`, left: `${Math.round(Math.max(0, x))}px` });
		}
	}

	private hideMenu(): void {
		this.menuFor = null;
		this.menuEl?.hide();
	}

	// ------------------------------------------------------------ selection

	select(ids: readonly string[], primary: string | null, reveal = true): void {
		this.session.setSelection(ids, primary);
		this.render(primary);
		if (reveal && primary !== null) this.revealPrimary();
	}

	revealPrimary(): void {
		const id = this.session.view.selection.primary;
		if (id === null || !this.renderer) return;
		this.renderer.scrollIntoView(id);
		if (this.contentEl.contains(this.contentEl.ownerDocument.activeElement) || this.app.workspace.getActiveViewOfType(MapView) === (this as MapView)) {
			this.renderer.focusNode(id);
		}
	}

	centerOnPrimary(): void {
		const id = this.session.view.selection.primary;
		if (id !== null) this.renderer?.centerOn(id);
	}

	selectedInOrder(): MapNode[] {
		return selectedInOrder(this.session.doc.root, this.session.view);
	}

	/** Give the map keyboard focus (after open or when its tab becomes active). */
	focusMap(): void {
		if (!this.loaded || this.unsupported || this.editing) return;
		this.win.requestAnimationFrame(() => {
			if (this.editing || this.contentEl.contains(this.contentEl.ownerDocument.activeElement)) return;
			const id = this.session.view.selection.primary ?? this.session.doc.root.id;
			if (this.renderer?.nodeElement(id)) this.renderer.focusNode(id);
			else this.contentEl.focus({ preventScroll: true });
		});
	}

	private onNodeClick(id: string, mods: Modifiers): void {
		this.hideMenu();
		if (this.editing && this.editing.id === id) return;
		// A modifier click while editing ends the edit and selects only the clicked node.
		const wasEditing = this.editing !== null;
		this.commitEdit();
		const v = this.session.view;
		const next = wasEditing ? selectOnly(v, id) : mods.mod ? toggleSelection(v, id) : mods.shift ? selectRange(this.session.doc.root, v, id) : selectOnly(v, id);
		this.select(next.selection.ids, next.selection.primary, false);
		this.renderer?.focusNode(id);
	}

	private onKeyUp(evt: KeyboardEvent): void {
		const arrow = this.pendingArrow;
		if (arrow === null || ARROW_KEYS[evt.key] !== arrow) return;
		this.pendingArrow = null;
		this.navigate(arrow);
	}

	armArrow(arrow: Arrow): void {
		this.pendingArrow = arrow;
	}

	private navigate(arrow: Arrow): void {
		if (!this.canEdit() || this.editing) return;
		this.prepare();
		const res = navigate(this.session.doc, this.session.view, this.session.view.selection.primary, arrow, this.direction());
		if (res.expand !== null) {
			const target = new Set(this.session.view.collapsed);
			target.delete(res.expand);
			const sel = res.select;
			this.setCollapsed(target, sel === null ? undefined : (_d, _a, id) => ({ ids: [id(sel)], primary: id(sel) }));
			this.revealPrimary();
			return;
		}
		if (res.select !== null) this.select([res.select], res.select);
	}

	// ------------------------------------------------------------ operations

	run(commandId: string): void {
		runCommand(this, commandId);
	}

	/** Apply a chain of ops as one undo step. */
	runSteps(steps: StepFn[], opts?: RunOptions): boolean {
		if (!this.canEdit()) return false;
		this.commitEdit();
		this.prepare();
		return this.session.run(steps, opts);
	}

	/** Make `target` the collapsed set (one undo step). */
	setCollapsed(target: ReadonlySet<string>, select?: RunOptions['select']): boolean {
		if (!this.canEdit()) return false;
		this.commitEdit();
		this.prepare();
		const index = indexNodes(this.session.doc.root);
		const root = this.session.doc.root;
		const clean = new Set([...target].filter((id) => id !== root.id && (index.get(id)?.node.children.length ?? 0) > 0));
		const cur = this.session.view.collapsed;
		// Collapsed leaves stay as they are (they hide nothing).
		for (const id of cur) if ((index.get(id)?.node.children.length ?? 0) === 0) clean.add(id);
		if (clean.size === cur.size && [...clean].every((id) => cur.has(id))) {
			if (select) {
				const s = select(this.session.doc, [], (x) => x);
				if (s) this.select(s.ids, s.primary);
			}
			return false;
		}
		return this.session.run(collapseSteps(clean), { reveal: false, select: select ?? keepSelection(this.session) });
	}

	undo(): void {
		if (!this.canEdit()) return;
		this.commitEdit();
		this.prepare();
		if (this.session.undo()) this.revealPrimary();
	}

	redo(): void {
		if (!this.canEdit()) return;
		this.commitEdit();
		this.prepare();
		if (this.session.redo()) this.revealPrimary();
	}

	/** F (spec 3.1, 5.3): the selected node enters focus mode; pressed again, focus mode ends. */
	toggleFocus(): void {
		if (this.session.view.focus !== null) {
			this.exitFocus();
			return;
		}
		const id = this.session.view.selection.primary;
		if (id !== null) this.enterFocus(id);
	}

	/** Show only `id` and its subtree, with `id` selected and the subtree fitted on screen (spec 5.3). */
	enterFocus(id: string): void {
		if (!this.loaded || this.unsupported) return;
		this.commitEdit();
		this.hideMenu();
		const v = setFocus(this.session.doc.root, this.session.view, id);
		if (v.focus !== id) return;
		// Switching focus from the menu keeps the viewport of the first entry.
		if (this.session.view.focus === null) this.focusSavedViewport = this.renderer?.viewport ?? null;
		this.session.setView(pruneSelection(this.session.doc.root, v));
		this.session.setSelection([id], id);
		this.search?.refresh(false);
		this.render(id);
		this.renderer?.fitFocus();
		this.renderer?.focusNode(id);
	}

	/** Leave focus mode: the viewport from before is put back and the former focus node selected (spec 5.3). */
	exitFocus(): void {
		const former = this.session.view.focus;
		if (former === null) return;
		this.commitEdit();
		this.session.setView(clearFocus(this.session.view));
		this.focusShown = null;
		this.search?.refresh(false);
		// render first: the anchor rule moves the viewport while the full map is laid out
		this.select([former], former, false);
		const saved = this.focusSavedViewport;
		this.focusSavedViewport = null;
		if (saved) this.renderer?.restoreViewport(saved);
		// moved while focused, it may be off screen now
		this.renderer?.scrollIntoView(former);
		this.renderer?.focusNode(former);
	}

	/** Open the search bar (spec 5.4), or focus it when it is open. */
	openSearch(): void {
		if (!this.canEdit()) return;
		this.commitEdit();
		this.hideMenu();
		this.search ??= new SearchBar({
			container: this.contentEl,
			tree: () => this.session.doc.root,
			rootText: () => (this.session.doc.virtualRoot ? this.session.rootName : undefined),
			view: () => this.session.view,
			setView: (view) => this.session.setView(view),
			render: () => this.render(),
			centerOn: (id) => this.renderer?.centerOn(id),
			focusMap: () => this.focusMap(),
		});
		this.search.open();
	}

	escape(): void {
		if (this.suggest?.isOpen) {
			this.suggest.close();
			return;
		}
		if (this.editing) {
			this.cancelEdit();
			return;
		}
		if (this.menuFor !== null) {
			this.hideMenu();
			return;
		}
		if (this.search?.isOpen) {
			this.search.close(true);
			return;
		}
		if (this.session.view.focus !== null) {
			this.exitFocus();
			return;
		}
		this.session.setView(clearSelection(this.session.view));
		this.render();
	}

	private onDrop(ids: string[], targetId: string, place: DropPlace, copy: boolean): void {
		if (!this.canEdit()) return;
		this.commitEdit();
		this.prepare();
		const doc = this.session.doc;
		const index = indexNodes(doc.root);
		const target = index.get(targetId);
		if (!target) return;
		const tops = topmostSelected(doc.root, { ...this.session.view, selection: { ids, primary: null } });
		const moving = new Set(tops.map((n) => n.id));
		let pos: Position;
		if (place === 'child' || !target.parent) {
			pos = { parentId: targetId, index: target.node.children.filter((c) => copy || !moving.has(c.id)).length };
		} else {
			const sibs = target.parent.children.filter((c) => copy || !moving.has(c.id) || c.id === targetId);
			const at = sibs.indexOf(target.node);
			pos = { parentId: target.parent.id, index: at + (place === 'after' ? 1 : 0) };
		}
		if (copy) {
			const toInput = (n: MapNode): NodeInput => ({ text: n.text, children: n.children.map(toInput) });
			this.runSteps([(d) => {
				const result = insertNodes(d, tops.map(toInput), pos, { headLevel: this.headLevel() });
				return result ? { result } : null;
			}]);
			return;
		}
		const topIds = tops.map((n) => n.id);
		this.runSteps([(d) => {
			const result = moveNodes(d, topIds, pos);
			return result ? { result, keep: topIds } : null;
		}], { select: (_d, _a, id) => ({ ids: topIds.map(id), primary: id(topIds[topIds.length - 1] ?? '') }) });
	}

	// ------------------------------------------------------------ editing

	startEditPrimary(caret: 'end' | 'all'): void {
		const id = this.session.view.selection.primary ?? this.session.doc.root.id;
		this.startEdit(id, caret);
	}

	startEdit(id: string, caret: 'end' | 'all'): void {
		if (!this.canEdit() || !this.renderer) return;
		this.commitEdit();
		this.prepare();
		const doc = this.session.doc;
		const node = indexNodes(doc.root).get(id)?.node;
		if (!node) return;
		if (!visibleNodes(doc.root, this.session.view).some((n) => n.id === id)) return;
		const text = node === doc.root && doc.virtualRoot ? this.session.rootName : node.text;
		this.hideMenu();
		try {
			const handle = this.renderer.startEditing(id, text, caret);
			this.editing = { id, handle, original: text };
			this.mobileBar?.update();
		} catch {
			this.editing = null;
		}
	}

	/** End editing and write the text (one undo step). */
	commitEdit(): void {
		const e = this.editing;
		if (!e) return;
		const value = e.handle.getText();
		this.editing = null;
		this.suggest?.close();
		this.renderer?.stopEditing();
		const doc = this.session.doc;
		const isVirtualRoot = e.id === doc.root.id && doc.virtualRoot;
		if (value === e.original || (isVirtualRoot && value.trim() === '')) {
			this.render(e.id);
			return;
		}
		this.writeText(e.id, value, e.original);
		this.renderer?.focusNode(this.session.view.selection.primary ?? e.id);
	}

	private writeText(id: string, value: string, previous: string): boolean {
		const ok = this.session.run(
			[(d, idOf) => {
				const result = setText(d, idOf(id), value);
				return result ? { result, keep: [idOf(id)] } : null;
			}],
			{ reveal: false, select: (_d, anchors) => ({ ids: [anchors[0] ?? id], primary: anchors[0] ?? id }) },
		);
		if (ok) {
			const now = this.session.view.selection.primary ?? id;
			this.previousText.set(now, previous);
		} else {
			this.render(id);
		}
		return ok;
	}

	/** Spec 5.8: the image picker for the primary node. */
	insertImage(): void {
		openImagePicker(this);
	}

	/**
	 * Spec 5.8: add an image embed to node `id`. While that node is edited it
	 * goes into the editor (at the caret, or on a new line at the end);
	 * otherwise on a new line at the end of the node's text, one undo step.
	 */
	addImageLink(id: string, link: string, atCaret: boolean): boolean {
		const e = this.editing;
		if (e && e.id === id) {
			if (atCaret) e.handle.insertText(link);
			else {
				const text = appendLine(e.handle.getText(), link);
				e.handle.setText(text, text.length);
			}
			return true;
		}
		if (!this.canEdit()) return false;
		this.commitEdit();
		this.prepare();
		const doc = this.session.doc;
		const node = indexNodes(doc.root).get(id)?.node;
		if (!node) return false;
		// A code or table node keeps its text (a line after it would change what it is, spec 5.8) and cannot have children: the image becomes the next sibling.
		if (node.kind === 'code' || node.kind === 'table') {
			return this.runSteps([(d, idOf) => {
				const result = insertSibling(d, idOf(id), link, 'after', { headLevel: this.headLevel() });
				return result ? { result } : null;
			}]);
		}
		const current = node === doc.root && doc.virtualRoot ? this.session.rootName : node.text;
		return this.writeText(id, appendLine(current, link), current);
	}

	cancelEdit(): void {
		const e = this.editing;
		if (!e) return;
		this.editing = null;
		this.suggest?.close();
		this.renderer?.stopEditing();
		this.render(e.id);
		this.renderer?.focusNode(e.id);
	}

	/** "Replace by the previous text": the node's text before its last edit; while editing, cancel. */
	replaceByPreviousText(): void {
		if (this.editing) {
			this.cancelEdit();
			return;
		}
		const id = this.session.view.selection.primary;
		if (id === null) return;
		const prev = this.previousText.get(id);
		const node = indexNodes(this.session.doc.root).get(id)?.node;
		if (prev === undefined || !node) return;
		this.prepare();
		this.writeText(id, prev, node.text);
	}

	private updateSuggest(): void {
		const e = this.editing;
		if (!e) return;
		if (!this.suggest) this.suggest = new FileSuggest(this.app, this.contentEl.ownerDocument, () => this.file?.path ?? '');
		const el = e.handle.element;
		this.suggest.update({
			read: () => (this.editing === e ? { text: e.handle.getText(), caret: e.handle.getSelection().to } : null),
			write: (text, caret) => e.handle.setText(text, caret),
			anchorRect: () => el.getBoundingClientRect(),
		});
	}

	// ------------------------------------------------------------ clipboard (spec 7)

	async copySelection(cut: boolean): Promise<void> {
		if (!this.canEdit()) return;
		this.prepare();
		const doc = this.session.doc;
		let nodes = topmostSelected(doc.root, this.session.view);
		const primary = this.session.view.selection.primary;
		if (nodes.length === 0 && primary === doc.root.id) nodes = [doc.root];
		if (nodes.length === 0) return;
		const plain = toClipboardOutline(nodes);
		const json = toClipboardJson(nodes, this.session.view.collapsed);
		try {
			if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
				await navigator.clipboard.write([
					new ClipboardItem({
						'text/plain': new Blob([plain], { type: 'text/plain' }),
						'text/html': new Blob([toClipboardHtml(nodes, json)], { type: 'text/html' }),
					}),
				]);
			} else {
				await navigator.clipboard.writeText(plain);
			}
		} catch {
			await navigator.clipboard.writeText(plain);
		}
		if (cut) deleteSelection(this, nodes.filter((n) => n !== doc.root).map((n) => n.id));
	}

	async pasteClipboard(): Promise<void> {
		if (!this.canEdit()) return;
		let nodes: ClipNode[] | null = null;
		let plain = '';
		let image: Blob | null = null;
		try {
			if (navigator.clipboard.read) {
				for (const item of await navigator.clipboard.read()) {
					const type = item.types.find((x) => extensionForMime(x) !== null);
					if (!image && type) image = await item.getType(type);
					if (!nodes && item.types.includes('text/html')) {
						const json = jsonFromClipboardHtml(await (await item.getType('text/html')).text());
						if (json) nodes = fromClipboardJson(json);
					}
					if (!plain && item.types.includes('text/plain')) plain = await (await item.getType('text/plain')).text();
				}
			} else {
				plain = await navigator.clipboard.readText();
			}
		} catch {
			try {
				plain = await navigator.clipboard.readText();
			} catch {
				new Notice(t('Clipboard unavailable'));
				return;
			}
		}
		if (!nodes && plain) nodes = fromClipboardJson(plain);
		// Spec 5.8: only an image on the clipboard, no text: add it to the selected node.
		const target = this.session.view.selection.primary;
		if (image && !nodes && plain.trim() === '' && target !== null) {
			const name = pastedImageName(new Date(), extensionForMime(image.type) ?? 'png');
			await addImageFiles(this, target, [new File([image], name, { type: image.type })], false);
			return;
		}
		this.pasteInto(nodes, plain);
	}

	/** Paste nodes (0.3.0 JSON, collapse kept) or Markdown text as children of the primary node. */
	pasteInto(nodes: ClipNode[] | null, plain: string): boolean {
		if (!this.canEdit()) return false;
		this.commitEdit();
		this.prepare();
		const parentId = this.session.view.selection.primary ?? this.session.doc.root.id;
		const pos = childPosition(this.session.doc, parentId, 'last');
		if (!pos) return false;
		if (!nodes && plain.trim() === '') {
			new Notice(t('Nothing to paste'));
			return false;
		}
		let anchors: number[] = [];
		const insert: StepFn = (d) => {
			const result = nodes ? insertNodes(d, nodes, pos, { headLevel: this.headLevel() }) : pasteMarkdown(d, plain, pos, { headLevel: this.headLevel() });
			if (result) anchors = result.anchors;
			return result ? { result } : null;
		};
		const steps: StepFn[] = [insert];
		if (nodes?.some(function hasCollapsed(n: ClipNode): boolean {
			return n.collapsed === true || (n.children ?? []).some(hasCollapsed);
		})) {
			steps.push(...collapseSteps((d) => {
				const out = new Set(d.collapsed);
				const pair = (clip: ClipNode, node: MapNode): void => {
					if (clip.collapsed && node.children.length > 0) out.add(node.id);
					(clip.children ?? []).forEach((c, i) => {
						const child = node.children[i];
						if (child) pair(c, child);
					});
				};
				(nodes ?? []).forEach((clip, i) => {
					const at = anchors[i];
					const node = at === undefined ? null : findNodeAt(d, at);
					if (node) pair(clip, node);
				});
				return out;
			}));
		}
		return this.runSteps(steps);
	}

	/** Export next to the note (spec 2.2, 2.3); resolves quietly when the view closes first. */
	exportImage(format: ExportFormat, scale = 1): Promise<void> {
		const controller = new AbortController();
		this.exports.add(controller);
		return exportMap(this, format, scale, controller.signal).finally(() => this.exports.delete(controller));
	}

	/** Command registry lookup for other modules (toolbar, tests). */
	hasCommand(id: string): boolean {
		return COMMAND_BY_ID.has(id);
	}
}
