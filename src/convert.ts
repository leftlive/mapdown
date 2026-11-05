// Opening a plain note as a mind map (behaviour spec 6.2, entry points 5.5):
// the dialog, converting in place (the map view backs the note up on its
// first save, see MapView.convertBeforeSave), saving a new map next to the
// note, the file-menu item and the "Save as a new mind map" command.

import { MarkdownView, TFile, type WorkspaceLeaf } from 'obsidian';
import { askConvertMode } from './convertModal.ts';
import { newMapBaseName, toMapText } from './controller/convertNote.ts';
import { isChinese, t } from './i18n.ts';
import type MapdownPlugin from './main.ts';
import { availablePath, folderOf } from './save.ts';
import { MapView, VIEW_TYPE } from './view/MapView.ts';

/** A Markdown note that does not open as a map. */
export function isPlainNote(plugin: MapdownPlugin, file: TFile | null): file is TFile {
	return file !== null && file.extension === 'md' && !plugin.isMapFileSync(file);
}

/** Ask how to open `file`, then do it; `leaf` is where an in-place conversion opens (default: the current tab). */
export async function openPlainNoteAsMap(plugin: MapdownPlugin, file: TFile, leaf?: WorkspaceLeaf): Promise<void> {
	const choice = await askConvertMode(plugin.app, file.basename);
	if (choice === 'in-place') await convertInPlace(plugin, file, leaf ?? plugin.app.workspace.getLeaf(false));
	else if (choice === 'copy') await saveAsNewMap(plugin, file);
}

/** Open the note itself as a map; nothing is written until the map saves a change. */
export async function convertInPlace(plugin: MapdownPlugin, file: TFile, leaf: WorkspaceLeaf): Promise<void> {
	plugin.setFileMode(leaf, file.path, 'mindmap');
	await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
	plugin.app.workspace.setActiveLeaf(leaf, { focus: true });
	const view = leaf.view;
	if (view instanceof MapView && view.file === file) view.beginConversion();
}

/** A new map `<name> (mind map).md` in the same folder, the note left untouched; opened in a new tab. */
export async function saveAsNewMap(plugin: MapdownPlugin, file: TFile): Promise<TFile> {
	const { app } = plugin;
	const text = await app.vault.read(file);
	const out = toMapText(text, { headLevel: plugin.settings.headLevel });
	const base = newMapBaseName(file.basename, isChinese());
	const path = availablePath(folderOf(file.path), base, (p) => app.vault.getAbstractFileByPath(p) !== null);
	const created = await app.vault.create(path, out);
	const leaf = app.workspace.getLeaf('tab');
	// The metadata cache has not seen the new file yet: name the view type.
	await leaf.setViewState({ type: VIEW_TYPE, state: { file: created.path }, active: true });
	app.workspace.setActiveLeaf(leaf, { focus: true });
	return created;
}

/** The "Save as a new mind map" command (spec 2.2) and the file-menu item (spec 5.5). */
export function registerConvert(plugin: MapdownPlugin): void {
	plugin.addCommand({
		id: 'convert-to-new-mindmap',
		name: t('convert-to-new-mindmap'),
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveViewOfType(MarkdownView)?.file ?? null;
			if (!isPlainNote(plugin, file)) return false;
			if (!checking) void saveAsNewMap(plugin, file);
			return true;
		},
	});
	plugin.registerEvent(
		plugin.app.workspace.on('file-menu', (menu, file) => {
			if (!(file instanceof TFile) || !isPlainNote(plugin, file)) return;
			menu.addItem((item) =>
				item
					.setTitle(t('Open as a mind map…'))
					.setIcon('mapdown')
					.onClick(() => void openPlainNoteAsMap(plugin, file)),
			);
		}),
	);
}
