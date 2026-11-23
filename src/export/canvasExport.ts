// Export of the open map as an Obsidian canvas (behaviour spec 2.2
// `export-canvas`, 2.3 "白板导出", 5.1 export menu). canvas.ts builds the
// JSON; this file measures and writes it. A canvas only opens inside the vault,
// so it is always saved next to the note (never the "Save as" dialog, whatever
// `exportLocation` says), then opened in a new tab and focused. Progress and
// the completion notice are the same as the other exports (save.ts). The map
// and the note are not changed.

import { Notice } from 'obsidian';
import { DEFAULT_PALETTE } from '../core/layout.ts';
import { folderOf } from '../controller/fileNames.ts';
import { t } from '../i18n.ts';
import type { MapView } from '../view/MapView.ts';
import { buildCanvas, hasFoldedBranch } from './canvas.ts';
import { canvasNodeSizes } from './exporter.ts';
import { progressNotice, showDone, writeTarget, type Target } from './save.ts';
import { exportPath } from './scene.ts';

/** Always next to the note: not a fallback, so no "saved next to the note" explanation. */
const NEXT_TO_NOTE: Target = { kind: 'note', fellBack: false };

/**
 * Write the whole map (collapsed branches expanded) as `<note>.canvas` next to
 * the note and open it in a new tab. Resolves quietly when the view closes;
 * failures end in a notice, never a rejection.
 */
export async function exportCanvas(view: MapView, signal: AbortSignal): Promise<void> {
	const first = view.file;
	if (!first || !view.canEdit()) return;
	const win = view.contentEl.ownerDocument.defaultView ?? window;
	const settings = view.plugin.settings;
	const closed = (): boolean => signal.aborted || !view.contentEl.isConnected;
	let progress: { stop(): void } | null = null;
	try {
		// spec 6.5: commit the active edit and save first
		await view.flush();
		const file = view.file;
		if (!file || closed()) return;
		progress = progressNotice(win);
		const sizes = await canvasNodeSizes(view, file, signal);
		if (closed()) {
			progress.stop();
			return;
		}
		const session = view.session;
		const root = session.doc.root;
		const json = buildCanvas(root, {
			direction: view.direction(),
			palette: settings.strokeArray && settings.strokeArray.length > 0 ? settings.strokeArray : DEFAULT_PALETTE,
			branchStyle: settings.branchStyle,
			sizes,
			rootText: session.doc.virtualRoot ? session.rootName : undefined,
		});
		const vault = view.app.vault;
		const folder = folderOf(file.path);
		const saved = await writeTarget(view.app, NEXT_TO_NOTE, () => exportPath(folder, file.basename, 'canvas', (p) => vault.getAbstractFileByPath(p) !== null), json);
		progress.stop();
		showDone(view.app, saved, 'export-done', { fellBack: false, expanded: hasFoldedBranch(root, session.view.collapsed) });
			// a new tab with the canvas, focused; the map's own tab stays
			if (saved.file) await view.app.workspace.getLeaf('tab').openFile(saved.file, { active: true });
	} catch (err) {
		progress?.stop();
		if (closed()) return;
		new Notice(t('export-failed', err instanceof Error ? err.message : String(err)));
	}
}
