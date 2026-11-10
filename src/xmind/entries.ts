// XMind entry points (behaviour spec 2.2, 4.1, 5.5): the `import-xmind`
// command, the file-menu item for .xmind files, dropping a .xmind file onto a
// map, and the export of the open map (command `export-xmind`, registered here
// with addCommand, not in the map command table of src/commands.ts).

import { Notice, TFile, type TFolder } from 'obsidian';
import { folderOf } from '../controller/fileNames.ts';
import { t } from '../i18n.ts';
import type MapdownPlugin from '../main.ts';
import { availableSiblingPath } from './paths.ts';
import { importXmindFile, pickXmindFile } from './importFile.ts';
import { buildXmindArchive, mapToXmindSheet, toExportTree } from './write.ts';
import { MapView } from '../view/MapView.ts';
import { chooseTarget, discardTarget, explainFallback, progressNotice, showDone, writeTarget, type Target } from '../export/save.ts';

const isXmind = (name: string): boolean => /\.xmind$/i.test(name);

/** Where imported notes go: next to the active note, or the vault's "new note" location. */
function importFolder(plugin: MapdownPlugin, near?: string): TFolder {
	return plugin.app.fileManager.getNewFileParent(near ?? plugin.app.workspace.getActiveFile()?.path ?? '');
}

/**
 * Write the open map as `<note>.xmind`: through the "Save as" dialog, or next
 * to the note (numbered when taken), per `exportLocation` (spec 2.3). Call it
 * straight from the command: the dialog opens before anything is awaited. An
 * edit in progress is committed and saved first (spec 2.3, 6.5). The map and
 * the note are not changed. Resolves to the vault file, or null when the file
 * went outside the vault, the export was cancelled or it failed.
 */
export async function exportXmind(view: MapView): Promise<TFile | null> {
	const first = view.file;
	if (!first) return null;
	const win = view.contentEl.ownerDocument.defaultView ?? window;
	const picked = chooseTarget(win, view.plugin.settings.exportLocation, first.basename, 'xmind');
	const closed = (): boolean => !view.contentEl.isConnected;
	let target: Target | null = null;
	let progress: { stop(): void } | null = null;
	try {
		await view.flush();
		target = await picked;
		if (!target) return null;
		const file = view.file;
		if (!file || closed()) {
			await discardTarget(target);
			return null;
		}
		progress = progressNotice(win);
		const session = view.session;
		const tree = toExportTree(session.doc.root, session.view.collapsed, session.doc.virtualRoot ? session.rootName : undefined);
		const vault = view.app.vault;
		const sheet = mapToXmindSheet(tree, file.basename, view.direction());
		const data = await buildXmindArchive(sheet, view.plugin.manifest.version);
		if (closed()) {
			progress.stop();
			await discardTarget(target);
			return null;
		}
		const saved = await writeTarget(view.app, target, () => availableSiblingPath(folderOf(file.path), file.basename, 'xmind', (p) => vault.getAbstractFileByPath(p) !== null), data);
		progress.stop();
		showDone(view.app, saved, 'xmind-exported', { fellBack: explainFallback(target) });
		return saved.file;
	} catch (err) {
		progress?.stop();
		await discardTarget(target ?? (await picked));
		console.error('Failed to export to XMind:', err);
		new Notice(t('xmind-export-failed', err instanceof Error ? err.message : String(err)));
		return null;
	}
}

/** 4.1: a .xmind file dropped onto a map becomes a new note; the map stays as it is. */
function installDrop(plugin: MapdownPlugin, view: MapView): void {
	const el = view.contentEl;
	const hasFiles = (evt: DragEvent): boolean => Array.from(evt.dataTransfer?.types ?? []).includes('Files');
	view.registerDomEvent(el, 'dragover', (evt) => {
		if (hasFiles(evt)) evt.preventDefault();
	});
	view.registerDomEvent(el, 'drop', (evt) => {
		const files = Array.from(evt.dataTransfer?.files ?? []).filter((f) => isXmind(f.name));
		if (files.length === 0) return;
		evt.preventDefault();
		evt.stopPropagation();
		const folder = importFolder(plugin, view.file?.path);
		for (const f of files) void f.arrayBuffer().then((data) => importXmindFile(plugin, data, f.name, folder));
	});
}

export function registerXmind(plugin: MapdownPlugin): void {
	plugin.addCommand({
		id: 'import-xmind',
		name: t('import-xmind'),
		callback: () => pickXmindFile(plugin, importFolder(plugin)),
	});
	// Registered here, not in the map command table: it needs the vault and the file picker.
	plugin.addCommand({
		id: 'export-xmind',
		name: t('export-xmind'),
		checkCallback: (checking) => {
			const view = plugin.activeMapView();
			if (!view || !view.canEdit()) return false;
			if (!checking) void exportXmind(view);
			return true;
		},
	});

	plugin.registerEvent(
		plugin.app.workspace.on('file-menu', (menu, file) => {
			if (!(file instanceof TFile) || !isXmind(file.name)) return;
			menu.addItem((item) =>
				item
					.setTitle(t('Import as mindmap'))
					.setIcon('mapdown')
					.onClick(async () => {
						const data = await plugin.app.vault.readBinary(file);
						await importXmindFile(plugin, data, file.name, importFolder(plugin, file.path));
					}),
			);
		}),
	);

	// Every map view gets the drop handler once, whenever it appears.
	const seen = new WeakSet<MapView>();
	const attach = (): void => {
		for (const view of plugin.mapViews()) {
			if (seen.has(view)) continue;
			seen.add(view);
			installDrop(plugin, view);
		}
	};
	plugin.registerEvent(plugin.app.workspace.on('layout-change', attach));
	plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', attach));
	plugin.app.workspace.onLayoutReady(attach);
}
