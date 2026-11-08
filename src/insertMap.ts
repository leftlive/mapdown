// "Insert mind map…" (behaviour spec 5.10, "Insert"): a picker of the vault's
// map notes, then `![[link]]` on a line of its own at the caret of a note's
// editor. Offered in plain notes only (not in a map note opened as Markdown).

import { MarkdownView, SuggestModal, TFile, prepareFuzzySearch, type Editor, type MarkdownFileInfo } from 'obsidian';
import { embedInsertion } from './core/insertEmbed.ts';
import { isPlainNote } from './convert.ts';
import { t } from './i18n.ts';
import type MapdownPlugin from './main.ts';
import { DOM } from './view/contract.ts';

type Pick = { kind: 'new' } | { kind: 'file'; file: TFile };

/** Position of `offset` in `text` (lines split at `\n`). */
function posIn(text: string, offset: number): { line: number; ch: number } {
	const before = text.slice(0, offset);
	const start = before.lastIndexOf('\n') + 1;
	return { line: before.split('\n').length - 1, ch: offset - start };
}

/** Write `![[link]]` on a line of its own as one edit (one undo step); the caret ends on that line. */
function insertEmbed(editor: Editor, link: string): void {
	const text = editor.getValue();
	const from = editor.posToOffset(editor.getCursor('from'));
	const to = editor.posToOffset(editor.getCursor('to'));
	const edit = embedInsertion(text, from, to, `![[${link}]]`);
	const after = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
	editor.transaction({
		changes: [{ from: editor.offsetToPos(edit.from), to: editor.offsetToPos(edit.to), text: edit.insert }],
		selection: { from: posIn(after, edit.cursor) },
	});
}

class MapPickerModal extends SuggestModal<Pick> {
	private readonly plugin: MapdownPlugin;
	private readonly editor: Editor;
	private readonly note: TFile;

	constructor(plugin: MapdownPlugin, editor: Editor, note: TFile) {
		super(plugin.app);
		this.plugin = plugin;
		this.editor = editor;
		this.note = note;
		this.modalEl.addClass(DOM.mapPicker);
		this.setPlaceholder(t('insert-map-placeholder'));
	}

	getSuggestions(query: string): Pick[] {
		const maps = this.app.vault
			.getMarkdownFiles()
			.filter((f) => f !== this.note && this.plugin.isMapFileSync(f));
		let files: TFile[];
		if (query.trim() === '') {
			files = maps.sort((a, b) => b.stat.mtime - a.stat.mtime);
		} else {
			const fuzzy = prepareFuzzySearch(query);
			files = maps
				.map((file) => ({ file, match: fuzzy(file.path) }))
				.filter((x) => x.match !== null)
				.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
				.map((x) => x.file);
		}
		return [{ kind: 'new' }, ...files.map((file): Pick => ({ kind: 'file', file }))];
	}

	renderSuggestion(pick: Pick, el: HTMLElement): void {
		el.addClass(DOM.mapPickerItem);
		if (pick.kind === 'new') {
			el.setAttr(DOM.actionAttr, 'new-map');
			el.createDiv({ text: t('insert-map-new') });
			return;
		}
		el.setAttr('data-path', pick.file.path);
		el.createDiv({ text: pick.file.name });
		const dir = pick.file.parent && !pick.file.parent.isRoot() ? pick.file.parent.path : '';
		if (dir) el.createEl('small', { cls: 'mapdown-map-picker-path', text: dir });
	}

	onChooseSuggestion(pick: Pick): void {
		void this.choose(pick);
	}

	private async choose(pick: Pick): Promise<void> {
		const { app } = this.plugin;
		let file: TFile;
		if (pick.kind === 'file') {
			file = pick.file;
		} else {
			// 6.1, in the folder the "new note" setting gives for this note; opens in a new tab
			file = await this.plugin.newMindMap(app.fileManager.getNewFileParent(this.note.path));
		}
		insertEmbed(this.editor, app.metadataCache.fileToLinktext(file, this.note.path));
	}
}

function openPicker(plugin: MapdownPlugin, editor: Editor, note: TFile): void {
	new MapPickerModal(plugin, editor, note).open();
}

/** The command and the editor's context menu item. */
export function registerInsertMap(plugin: MapdownPlugin): void {
	plugin.addCommand({
		id: 'insert-map-embed',
		name: t('insert-map-embed'),
		editorCheckCallback: (checking, editor, ctx: MarkdownView | MarkdownFileInfo) => {
			const file = ctx.file;
			if (!isPlainNote(plugin, file)) return false;
			if (!checking) openPicker(plugin, editor, file);
			return true;
		},
	});
	plugin.registerEvent(
		plugin.app.workspace.on('editor-menu', (menu, editor, info) => {
			const file = info.file;
			if (!isPlainNote(plugin, file)) return;
			menu.addItem((item) =>
				item
					.setTitle(t('insert-map-embed'))
					.setIcon('mapdown')
					.onClick(() => openPicker(plugin, editor, file)),
			);
		}),
	);
}
