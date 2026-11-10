// Pure part of choosing where an export goes (behaviour spec 2.3 "导出位置",
// "导出进度和完成提示"): the options of the system "Save as" dialog, what a
// failed dialog means, and the lines of the completion notice. No DOM and no
// Obsidian here; save.ts opens the dialog and writes the file.

import { t, type StringKey } from '../i18n.ts';
import type { ExportLocation } from '../settings.ts';

/** File extensions the exports write. */
export type ExportExt = 'png' | 'jpg' | 'svg' | 'pdf' | 'html' | 'xmind';

/** One `id` for every format, so the dialog opens in the folder used last time. At most 32 of [A-Za-z0-9_-]. */
export const PICKER_ID = 'mapdown-export';

const FILE_TYPES: Record<ExportExt, { description: string; mime: string; exts: string[] }> = {
	png: { description: 'PNG', mime: 'image/png', exts: ['.png'] },
	jpg: { description: 'JPEG', mime: 'image/jpeg', exts: ['.jpg', '.jpeg'] },
	svg: { description: 'SVG', mime: 'image/svg+xml', exts: ['.svg'] },
	pdf: { description: 'PDF', mime: 'application/pdf', exts: ['.pdf'] },
	html: { description: 'HTML', mime: 'text/html', exts: ['.html'] },
	xmind: { description: 'XMind', mime: 'application/vnd.xmind.workbook', exts: ['.xmind'] },
};

export interface PickerOptions {
	id: string;
	suggestedName: string;
	types: { description: string; accept: Record<string, string[]> }[];
}

/** The options of `showSaveFilePicker` for `<note>.<ext>`. */
export function pickerOptions(basename: string, ext: ExportExt): PickerOptions {
	const type = FILE_TYPES[ext];
	return {
		id: PICKER_ID,
		suggestedName: `${basename}.${ext}`,
		types: [{ description: type.description, accept: { [type.mime]: [...type.exts] } }],
	};
}

/**
 * How to start: `ask` opens the dialog, `note` writes next to the note, and
 * `fallback` writes next to the note because this platform has no dialog
 * (phones and tablets) and says so.
 */
export function startPlan(location: ExportLocation, hasPicker: boolean): 'ask' | 'note' | 'fallback' {
	if (location !== 'ask') return 'note';
	return hasPicker ? 'ask' : 'fallback';
}

/** A rejected dialog: AbortError is the user cancelling (write nothing, say nothing); anything else falls back to the note. */
export function pickerFailure(err: unknown): 'cancel' | 'fallback' {
	const name = err !== null && typeof err === 'object' ? (err as { name?: unknown }).name : undefined;
	return name === 'AbortError' ? 'cancel' : 'fallback';
}

/** What happened besides the file being written; each becomes one more line of the completion notice. */
export interface DoneExtras {
	/** Formulas drawn as their source. */
	formulas?: number;
	/** Images that could not be loaded. */
	missing?: number;
	/** The scale used when the requested one was too large; null or absent when it was not reduced. */
	scaleUsed?: number | null;
	/** Saved next to the note because the dialog was not available. */
	fellBack?: boolean;
}

/** The completion notice: `heading` with what was written (a vault path or a file name), then the extras. */
export function doneLines(heading: StringKey, shown: string, extras: DoneExtras = {}): string[] {
	const lines = [t(heading, shown)];
	if (extras.fellBack) lines.push(t('export-saved-near-note'));
	if (extras.scaleUsed !== undefined && extras.scaleUsed !== null) lines.push(t('export-scale-reduced', extras.scaleUsed));
	if (extras.formulas) lines.push(t('export-math-source', extras.formulas));
	if (extras.missing) lines.push(t('export-images-missing', extras.missing));
	return lines;
}

/** How long the completion notice stays (spec 2.3). */
export const DONE_NOTICE_MS = 8000;
/** Generating for longer than this shows "Exporting…". */
export const PROGRESS_DELAY_MS = 500;
