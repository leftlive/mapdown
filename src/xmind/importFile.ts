// Turns an .xmind file into new Mapdown notes. Every entry point (drop,
// command, file menu) ends here; nothing existing is ever overwritten
// (behaviour spec 2.2, 4.1, 5.5).
import { Notice, normalizePath, type TFile, type TFolder } from 'obsidian';
import { availablePath } from '../controller/fileNames.ts';
import { t, type StringKey } from '../i18n.ts';
import type MapdownPlugin from '../main.ts';
import { VIEW_TYPE } from '../view/MapView.ts';
import { readXmind, sheetNoteNames, sheetToNote, XmindImportError, type SkippedKind, type XmindDocument } from './read.ts';

const SKIPPED_LABELS: Record<SkippedKind, StringKey> = {
	summary: 'xmind-skip-summary',
	boundary: 'xmind-skip-boundary',
	relationship: 'xmind-skip-relationship',
	callout: 'xmind-skip-callout',
	image: 'xmind-skip-image',
};

export function importSummary(doc: XmindDocument): string {
	const skipped = (Object.keys(SKIPPED_LABELS) as SkippedKind[])
		.filter((k) => doc.skipped[k] > 0)
		.map((k) => `${t(SKIPPED_LABELS[k])} ${doc.skipped[k]}`);
	const imported = t('xmind-imported', doc.topicCount);
	return skipped.length ? `${imported} ${t('xmind-skipped', skipped.join(t('xmind-list-separator')))}` : imported;
}

/** Create one note per sheet in `folder` and open each as a map. Returns the new files ([] on failure, nothing left behind). */
export async function importXmindFile(plugin: MapdownPlugin, data: ArrayBuffer, baseName: string, folder: TFolder): Promise<TFile[]> {
	let doc: XmindDocument;
	try {
		doc = await readXmind(data);
	} catch (err) {
		console.error('Failed to read XMind file:', err);
		const unrecognized = err instanceof XmindImportError && err.code === 'unrecognized';
		new Notice(t(unrecognized ? 'xmind-unrecognized' : 'xmind-parse-error'));
		return [];
	}

	// Build every note before creating any, so a failure leaves nothing behind.
	const names = sheetNoteNames(baseName.replace(/\.xmind$/i, ''), doc.sheets);
	const contents = doc.sheets.map((sheet) => sheetToNote(sheet, plugin.settings.headLevel));
	const vault = plugin.app.vault;
	const dir = folder.isRoot() ? '' : normalizePath(folder.path);
	const created: TFile[] = [];
	try {
		for (let i = 0; i < contents.length; i++) {
			const path = availablePath(dir, names[i], (p) => vault.getAbstractFileByPath(p) !== null);
			created.push(await vault.create(path, contents[i]));
		}
	} catch (err) {
		console.error('Failed to create the imported note:', err);
		for (const file of created) {
			// Our own file, created a moment ago: remove it for good (trashFile needs Obsidian 1.6.6).
			await vault.delete(file).catch(() => undefined);
		}
		new Notice(t('xmind-create-failed'));
		return [];
	}

	for (const file of created) {
		const leaf = plugin.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path }, active: true });
	}
	new Notice(importSummary(doc));
	return created;
}

/** The command entry: the system file picker (no fs, so it works on mobile too). */
export function pickXmindFile(plugin: MapdownPlugin, folder: TFolder): void {
	const input = createEl('input');
	input.type = 'file';
	input.accept = '.xmind';
	input.addEventListener('change', () => {
		const file = input.files?.[0];
		if (file) void file.arrayBuffer().then((data) => importXmindFile(plugin, data, file.name, folder));
	});
	input.click();
}
