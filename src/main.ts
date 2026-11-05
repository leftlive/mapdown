// Mapdown: edit a Markdown note as a mind map (development plan, behaviour spec).
//
// The plugin object wires Obsidian to the map views: the view type, which
// notes open as maps (and the per tab + file memory of 6.4), commands, menus,
// the ribbon and header buttons, settings, recovery drafts, the editor
// listener that feeds Markdown typing back into open maps, and the read-only
// test API (development plan 6.1).

import { EditorView } from '@codemirror/view';
import {
	Keymap,
	MarkdownView,
	Plugin,
	TFile,
	TFolder,
	WorkspaceLeaf,
	addIcon,
	editorInfoField,
	type ViewState,
} from 'obsidian';
import { visibleNodes } from './core/state.ts';
import type { TextEdit } from './core/types.ts';
import { available, COMMANDS } from './commands.ts';
import { isPlainNote, openPlainNoteAsMap, registerConvert } from './convert.ts';
import { nodeAtLine, nodeLine } from './controller/sourceLines.ts';
import { createCursorListener, editorSyncExtension } from './editorSync.ts';
import { setLanguage, t } from './i18n.ts';
import { availablePath, RecoveryStore } from './save.ts';
import { MapdownSettingTab } from './settingsTab.ts';
import { registerXmind } from './xmind/entries.ts';
import { DEFAULT_SETTINGS, normalizeSettings, settingsForSave, type MapdownSettings } from './settings.ts';
import type { TestApi } from './testApi.ts';
import { mapdownEdit, MapView, VIEW_TYPE } from './view/MapView.ts';
import { DOM } from './view/contract.ts';

/** The glyph of brand/mapdown-glyph.svg on Obsidian's 100×100 icon canvas. */
const ICON = `<g transform="scale(4.1667)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<path d="M4.5 7.5H6M2 12H6M3 16.5H6"/>
<rect x="8.5" y="9.5" width="6" height="5" rx="1.5"/>
<path d="M14.5 12C17.5 12 16.5 7 19.5 7"/>
<path d="M14.5 12H19.5"/>
<path d="M14.5 12C17.5 12 16.5 17 19.5 17"/>
<circle cx="21" cy="7" r="1" fill="currentColor"/>
<circle cx="21" cy="12" r="1" fill="currentColor"/>
<circle cx="21" cy="17" r="1" fill="currentColor"/>
</g>`;

/** A new map: an empty body (virtual root showing the file name) and an empty state. */
const NEW_MAP_TEXT = '---\nmindmap-plugin: basic\nmindmark-state: {"version":2,"collapsed":[]}\n---\n';

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const MAP_KEY = /^mindmap-plugin:[ \t]*basic[ \t]*$/m;

export type OpenMode = 'markdown' | 'mindmap';

export default class MapdownPlugin extends Plugin {
	settings: MapdownSettings = { ...DEFAULT_SETTINGS };
	recovery!: RecoveryStore;
	/** Raw data.json, so keys this version does not define survive a save. */
	private rawData: unknown = null;
	/** 6.4: per tab, the files the user switched to Markdown. In memory only. */
	private modes = new WeakMap<WorkspaceLeaf, Set<string>>();
	/** One-shot: open this path in this leaf as Markdown without remembering it. */
	private bypass = new WeakMap<WorkspaceLeaf, string>();
	private lastMapView: MapView | null = null;
	private headerButtons = new WeakMap<MarkdownView, HTMLElement>();

	readonly testApi: TestApi = {
		selection: () => {
			const v = this.lastMapView;
			if (!v) return [];
			const { ids, primary } = v.session.view.selection;
			return primary === null ? [...ids] : [primary, ...ids.filter((id) => id !== primary)];
		},
		visibleNodes: () => {
			const v = this.lastMapView;
			if (!v) return [];
			const doc = v.session.doc;
			return visibleNodes(doc.root, v.session.view).map((n) => ({
				id: n.id,
				text: n === doc.root && doc.virtualRoot ? v.session.rootName : n.text,
			}));
		},
		historySize: () => {
			const h = this.lastMapView?.session.history;
			return { undo: h?.undoSize ?? 0, redo: h?.redoSize ?? 0 };
		},
		nodeAt: (text) => this.testApi.visibleNodes().find((n) => n.text === text)?.id ?? null,
		renderedIds: () => this.lastMapView?.renderer?.renderedIds() ?? [],
		isEditing: () => this.lastMapView?.isEditing() ?? false,
		nodeLine: (id) => {
			const doc = this.lastMapView?.session.doc;
			return doc ? nodeLine(doc, id) : null;
		},
		nodeAtLine: (line) => {
			const doc = this.lastMapView?.session.doc;
			return doc ? nodeAtLine(doc, line)?.id ?? null : null;
		},
		flush: async () => {
			await this.lastMapView?.flush();
		},
	};

	async onload(): Promise<void> {
		// Obsidian keeps the interface language here (getLanguage() needs 1.8.7).
		setLanguage(window.localStorage.getItem('language') ?? 'en');
		await this.loadSettings();
		this.recovery = new RecoveryStore(this.app.vault.adapter, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`);
		addIcon('mapdown', ICON);

		this.registerView(VIEW_TYPE, (leaf) => new MapView(leaf, this));
		this.registerHoverLinkSource('mapdown', { display: 'Mapdown', defaultMod: true });
		this.patchSetViewState();

		this.addRibbonIcon('mapdown', t('Create New MindMap'), () => void this.newMindMap());
		this.addSettingTab(new MapdownSettingTab(this.app, this));
		this.registerCommands();
		this.registerMenus();
		// Order matters: a typed character reaches the map (editorListener) before
		// the cursor move of the same transaction (cursor listener).
		this.registerEditorExtension([editorSyncExtension, this.editorListener(), this.cursorListener()]);

		this.registerEvent(this.app.vault.on('modify', (file) => {
			if (!(file instanceof TFile)) return;
			for (const v of this.mapViews()) if (v.file === file) void v.onFileModified();
		}));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onRename(file.path, oldPath)));
		this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
			const view = leaf?.view;
			if (view instanceof MapView) {
				this.lastMapView = view;
				view.focusMap();
			}
			this.updateHeaderButtons();
		}));
		this.registerEvent(this.app.workspace.on('layout-change', () => this.updateHeaderButtons()));
		this.registerEvent(this.app.workspace.on('file-open', () => this.updateHeaderButtons()));
		this.app.workspace.onLayoutReady(() => this.updateHeaderButtons());
	}

	onunload(): void {
		// Views are left open (community rules); Obsidian restores them on reload.
	}

	// ------------------------------------------------------------ settings

	async loadSettings(): Promise<void> {
		this.rawData = await this.loadData();
		this.settings = normalizeSettings(this.rawData);
	}

	async saveSettings(): Promise<void> {
		const out = settingsForSave(this.rawData, this.settings);
		this.rawData = out;
		await this.saveData(out);
		for (const v of this.mapViews()) v.applySettings();
	}

	// ------------------------------------------------------------ views

	mapViews(): MapView[] {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view).filter((v): v is MapView => v instanceof MapView);
	}

	activeMapView(): MapView | null {
		return this.app.workspace.getActiveViewOfType(MapView);
	}

	/** A note opens as a map when its frontmatter has `mindmap-plugin: basic` (contract 2). */
	async isMapFile(file: TFile): Promise<boolean> {
		if (file.extension !== 'md') return false;
		const cache = this.app.metadataCache.getFileCache(file);
		if (cache) return cache.frontmatter?.['mindmap-plugin'] === 'basic';
		const text = await this.app.vault.cachedRead(file);
		const fm = FRONTMATTER.exec(text);
		return fm !== null && MAP_KEY.test(fm[1] ?? '');
	}

	isMapFileSync(file: TFile | null): boolean {
		if (!file || file.extension !== 'md') return false;
		return this.app.metadataCache.getFileCache(file)?.frontmatter?.['mindmap-plugin'] === 'basic';
	}

	/** Route Markdown opens of map notes to the map view, unless this tab remembers Markdown for the file. */
	private patchSetViewState(): void {
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- the patched method needs both the leaf (this) and the plugin
		const plugin = this;
		const proto = WorkspaceLeaf.prototype;
		const original = Object.getOwnPropertyDescriptor(proto, 'setViewState')?.value as (
			this: WorkspaceLeaf,
			state: ViewState,
			eState?: unknown,
		) => Promise<void>;
		let active = true;
		const patched = async function (this: WorkspaceLeaf, state: ViewState, eState?: unknown): Promise<void> {
			if (!active) return original.call(this, state, eState);
			const path = state.state?.file;
			if (state.type === 'markdown' && typeof path === 'string') {
				if (plugin.bypass.get(this) === path) {
					plugin.bypass.delete(this);
				} else if (!plugin.modes.get(this)?.has(path)) {
					const file = plugin.app.vault.getAbstractFileByPath(path);
					// The metadata cache answers without awaiting, so no other setViewState can slip in
					// between; read the file only when the cache has nothing yet.
					const cached = file instanceof TFile ? plugin.app.metadataCache.getFileCache(file) : null;
					const isMap = file instanceof TFile && (cached ? plugin.isMapFileSync(file) : await plugin.isMapFile(file));
					if (isMap) {
						return original.call(this, { ...state, type: VIEW_TYPE }, eState);
					}
				}
			}
			return original.call(this, state, eState);
		};
		proto.setViewState = patched;
		this.register(() => {
			active = false;
			// Restore only if nobody patched on top of us; otherwise leave their patch alone.
			if (proto.setViewState === patched) proto.setViewState = original;
		});
	}

	/** Remember (or forget) Markdown for this tab and file (6.4). */
	setFileMode(leaf: WorkspaceLeaf, path: string, mode: OpenMode): void {
		let set = this.modes.get(leaf);
		if (mode === 'markdown') {
			if (!set) this.modes.set(leaf, (set = new Set()));
			set.add(path);
		} else {
			set?.delete(path);
		}
	}

	/** Switch a map tab to Markdown and remember it for this tab and file. */
	async setMarkdownView(leaf: WorkspaceLeaf): Promise<void> {
		const view = leaf.view;
		const file = view instanceof MapView ? view.file : null;
		if (!file) return;
		await this.openAsMarkdown(leaf, file, 'remember');
	}

	/** Switch a Markdown tab showing a map note to the map. */
	async setMindmapView(leaf: WorkspaceLeaf): Promise<void> {
		const view = leaf.view;
		const file = view instanceof MarkdownView ? view.file : null;
		if (!file) return;
		this.setFileMode(leaf, file.path, 'mindmap');
		await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
	}

	async openAsMarkdown(leaf: WorkspaceLeaf, file: TFile, how: 'remember' | 'once'): Promise<void> {
		const view = leaf.view;
		if (view instanceof MapView) await view.flush();
		if (how === 'remember') this.setFileMode(leaf, file.path, 'markdown');
		else this.bypass.set(leaf, file.path);
		await leaf.setViewState({ type: 'markdown', state: { file: file.path }, active: true });
	}

	private onRename(path: string, oldPath: string): void {
		this.app.workspace.iterateAllLeaves((leaf) => {
			const set = this.modes.get(leaf);
			if (set?.delete(oldPath)) set.add(path);
		});
	}

	/** 6.1: a new map note in the folder (or the "new note" location), opened in a new tab with the root in edit mode. */
	async newMindMap(folder?: TFolder): Promise<TFile> {
		const parent = folder ?? this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? '');
		const dir = parent.isRoot() ? '' : parent.path;
		const path = availablePath(dir, t('Untitled mindmap'), (p) => this.app.vault.getAbstractFileByPath(p) !== null);
		const file = await this.app.vault.create(path, NEW_MAP_TEXT);
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
		const view = leaf.view;
		if (view instanceof MapView) {
			this.lastMapView = view;
			view.startEdit(view.session.doc.root.id, 'all');
		}
		return file;
	}

	openLink(href: string, sourcePath: string, evt: MouseEvent): void {
		if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
			window.open(href, '_blank');
			return;
		}
		const mode = this.settings.linkOpenMode;
		const pane = Keymap.isModEvent(evt) || (mode === 'current' ? false : mode);
		void this.app.workspace.openLinkText(href, sourcePath, pane);
	}

	// ------------------------------------------------------------ commands, menus, buttons

	private registerCommands(): void {
		this.addCommand({ id: 'Create New MindMap', name: t('Create New MindMap'), callback: () => void this.newMindMap() });
		this.addCommand({
			id: 'Toggle to markdown or mindmap',
			name: t('Toggle to markdown or mindmap'),
			checkCallback: (checking) => {
				const leaf = this.app.workspace.getMostRecentLeaf();
				const view = leaf?.view;
				if (!leaf || !view) return false;
				if (view instanceof MapView) {
					if (!checking) void this.setMarkdownView(leaf);
					return true;
				}
				if (view instanceof MarkdownView && this.isMapFileSync(view.file)) {
					if (!checking) void this.setMindmapView(leaf);
					return true;
				}
				return false;
			},
		});
		this.addCommand({
			id: 'toggle-selection-sync',
			name: t('toggle-selection-sync'),
			callback: () => {
				this.settings.syncSelection = !this.settings.syncSelection;
				void this.saveSettings();
			},
		});
		this.addCommand({
			id: 'Set to mindmap view',
			name: t('Set to mindmap view'),
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view || !this.isMapFileSync(view.file)) return false;
				if (!checking) void this.setMindmapView(view.leaf);
				return true;
			},
		});
		this.addCommand({
			id: 'Set to markdown view',
			name: t('Set to markdown view'),
			checkCallback: (checking) => {
				const view = this.activeMapView();
				if (!view) return false;
				if (!checking) void this.setMarkdownView(view.leaf);
				return true;
			},
		});
		registerXmind(this);
		registerConvert(this);
		for (const command of COMMANDS) {
			if (!command.palette) continue;
			this.addCommand({
				id: command.id,
				name: command.nameArg === undefined ? t(command.name) : t(command.name, command.nameArg),
				checkCallback: (checking) => {
					const view = this.activeMapView();
					if (!view || !available(command, view)) return false;
					if (!checking) command.run(view);
					return true;
				},
			});
		}
	}

	private registerMenus(): void {
		this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
			if (file instanceof TFolder) {
				menu.addItem((item) => item.setTitle(t('New mindmap board')).setIcon('mapdown').onClick(() => void this.newMindMap(file)));
			} else if (file instanceof TFile && this.isMapFileSync(file)) {
				menu.addItem((item) =>
					item.setTitle(t('Open as mindmap board')).setIcon('mapdown').onClick(async () => {
						const leaf = this.app.workspace.getLeaf(false);
						this.setFileMode(leaf, file.path, 'mindmap');
						await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
					}),
				);
			}
		}));
	}

	/** 5.5: a Mapdown button in the header of Markdown views: map notes switch to the map, plain notes ask (6.2). */
	private updateHeaderButtons(): void {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) continue;
			let button = this.headerButtons.get(view);
			if (!button) {
				button = view.addAction('mapdown', t('Open as mind map'), () => {
					const file = view.file;
					if (this.isMapFileSync(file)) void this.setMindmapView(view.leaf);
					else if (isPlainNote(this, file)) void openPlainNoteAsMap(this, file, view.leaf);
				});
				button.addClass(DOM.headerAction);
				this.headerButtons.set(view, button);
			}
			const isMap = this.isMapFileSync(view.file);
			button.toggle(isMap || isPlainNote(this, view.file));
			button.setAttribute('aria-label', isMap ? t('Open as mind map') : t('Open as a mind map…'));
		}
	}

	// ------------------------------------------------------------ editor -> map

	/** Spec 5.6: the cursor of a focused Markdown editor selects in the map views of the same file. */
	private cursorListener(): ReturnType<typeof createCursorListener> {
		return createCursorListener((cm) => {
			if (!this.settings.syncSelection) return;
			const path = cm.state.field(editorInfoField, false)?.file?.path;
			if (!path) return;
			const views = this.mapViews().filter((v) => v.file?.path === path);
			if (views.length === 0) return;
			const line = cm.state.doc.lineAt(cm.state.selection.main.head).number - 1;
			for (const v of views) v.onEditorCursor(line);
		});
	}

	/** Text typed in a Markdown editor reaches the map views of the same file. */
	private editorListener(): ReturnType<typeof EditorView.updateListener.of> {
		return EditorView.updateListener.of((update) => {
			if (!update.docChanged) return;
			if (update.transactions.some((tr) => tr.annotation(mapdownEdit))) return;
			const path = update.state.field(editorInfoField, false)?.file?.path;
			if (!path) return;
			const views = this.mapViews().filter((v) => v.file?.path === path);
			if (views.length === 0) return;
			const edits: TextEdit[] = [];
			update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
				edits.push({ from: fromA, to: toA, insert: inserted.toString() });
			});
			const text = update.state.doc.toString();
			for (const v of views) v.onEditorChange(edits, text);
		});
	}
}
