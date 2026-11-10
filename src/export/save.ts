// Where an export is written (behaviour spec 2.3 "导出位置", "导出进度和完成
// 提示"), shared by the image, SVG and HTML export (exporter.ts) and the XMind
// export (xmind/entries.ts).
//
// The order matters: chooseTarget() is called straight from the command or
// menu handler, before anything is awaited, because the browser opens the
// "Save as" dialog only during a user action. The file is built afterwards and
// written through the handle at the end. Only the web-standard
// showSaveFilePicker is used, from the view's own window (popouts).
//
// Chromium may create the chosen file, empty, when the dialog closes. A failed
// or cancelled export removes such an empty file again; a file that had
// content when the dialog closed is never removed. The
// data goes through createWritable(), which writes to a temporary file and
// replaces the target only on close(), so a half-written file never appears.

import { Notice, TFile, type App } from 'obsidian';
import { t, type StringKey } from '../i18n.ts';
import type { ExportLocation } from '../settings.ts';
import { DONE_NOTICE_MS, PROGRESS_DELAY_MS, doneLines, pickerFailure, pickerOptions, startPlan, type DoneExtras, type ExportExt, type PickerOptions } from './location.ts';

/** The parts of FileSystemFileHandle used here (showSaveFilePicker is not in TypeScript's DOM types). */
interface FileHandle {
	readonly name: string;
	getFile(): Promise<Blob>;
	createWritable(): Promise<{ write(data: string | ArrayBuffer): Promise<void>; close(): Promise<void>; abort(reason?: unknown): Promise<void> }>;
	remove?(): Promise<void>;
}
type SaveFilePicker = (options: PickerOptions) => Promise<FileHandle>;

export type Target =
	/** Next to the note; `fellBack`: the platform has no dialog (`unsupported`) or it could not be opened (`failed`). */
	| { kind: 'note'; fellBack: false | 'unsupported' | 'failed' }
	/** A file chosen in the dialog; `hadContent`: it existed and was not empty when the dialog closed. */
	| { kind: 'file'; handle: FileHandle; hadContent: boolean };

export interface Saved {
	/** The vault file; null for a file outside Obsidian's reach (chosen in the dialog). */
	file: TFile | null;
	/** What the completion notice shows: the vault path, or the file name. */
	shown: string;
}

/** On a platform without the dialog the explanation is given once per session; a dialog that failed is explained each time. */
let explainedUnsupported = false;

/** Whether the completion notice says the file went next to the note instead of asking. */
export function explainFallback(target: Target): boolean {
	if (target.kind !== 'note' || target.fellBack === false) return false;
	if (target.fellBack === 'failed') return true;
	if (explainedUnsupported) return false;
	explainedUnsupported = true;
	return true;
}

async function sizeOf(handle: FileHandle): Promise<number> {
	try {
		return (await handle.getFile()).size;
	} catch {
		return -1; // not there (yet)
	}
}

/**
 * Where to write `<basename>.<ext>`. Call it synchronously from the command
 * or menu handler. Never rejects; resolves to null when the user cancels.
 */
export function chooseTarget(win: Window, location: ExportLocation, basename: string, ext: ExportExt): Promise<Target | null> {
	const picker = (win as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
	const plan = startPlan(location, typeof picker === 'function');
	if (plan === 'note' || !picker) return Promise.resolve({ kind: 'note', fellBack: plan === 'note' ? false : 'unsupported' });
	const failed = (err: unknown): Target | null => {
		if (pickerFailure(err) === 'cancel') return null;
		console.warn('Mapdown: the save dialog could not be opened; saving next to the note.', err);
		return { kind: 'note', fellBack: 'failed' };
	};
	let opened: Promise<FileHandle>;
	try {
		opened = picker.call(win, pickerOptions(basename, ext));
	} catch (err) {
		return Promise.resolve(failed(err));
	}
	return opened.then(async (handle): Promise<Target> => ({ kind: 'file', handle, hadContent: (await sizeOf(handle)) > 0 }), failed);
}

/** Write the data: next to the note at `notePath()`, or through the dialog's handle. */
export async function writeTarget(app: App, target: Target, notePath: () => string, data: string | ArrayBuffer): Promise<Saved> {
	if (target.kind === 'note') {
		const path = notePath();
		const file = typeof data === 'string' ? await app.vault.create(path, data) : await app.vault.createBinary(path, data);
		return { file, shown: file.path };
	}
	const writable = await target.handle.createWritable();
	try {
		await writable.write(data);
		await writable.close();
	} catch (err) {
		await writable.abort().catch(() => undefined);
		throw err;
	}
	return { file: null, shown: target.handle.name };
}

/** After a failed or cancelled export: remove the empty file the dialog created; never a file that had content. */
export async function discardTarget(target: Target | null): Promise<void> {
	if (!target || target.kind !== 'file' || target.hadContent) return;
	try {
		if ((await sizeOf(target.handle)) === 0) await target.handle.remove?.();
	} catch {
		// nothing more can be done; the file stays empty
	}
}

/** "Exporting…" while generating takes longer than about half a second; stop() hides it. */
export function progressNotice(win: Window): { stop(): void } {
	let notice: Notice | null = null;
	const timer = win.setTimeout(() => {
		notice = new Notice(t('export-progress'), 0);
	}, PROGRESS_DELAY_MS);
	return {
		stop: () => {
			win.clearTimeout(timer);
			notice?.hide();
			notice = null;
		},
	};
}

/** The completion notice (8 s): a vault file opens in a new tab when the notice is clicked. */
export function showDone(app: App, saved: Saved, heading: StringKey, extras: DoneExtras): void {
	const lines = doneLines(heading, saved.shown, extras);
	const file = saved.file;
	const fragment = createFragment((f) => {
		const box = f.createDiv();
		for (const line of lines) box.createDiv({ text: line });
		if (!(file instanceof TFile)) return;
		box.addClass('mapdown-export-done');
		box.addEventListener('click', () => {
			void app.workspace.getLeaf('tab').openFile(file);
		});
	});
	new Notice(fragment, DONE_NOTICE_MS);
}
