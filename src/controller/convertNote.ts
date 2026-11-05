// Pure part of opening a plain note as a mind map (behaviour spec 6.2): the
// name of the new map, the frontmatter rewrite, and the whole-document text
// the map format asks for (format contract 6: "整篇生成").

import { clampHeadLevel, type LineEnding } from '../core/outline.ts';
import { parseDocument } from '../core/parse.ts';
import { writeDocumentBody } from '../core/serialize.ts';
import type { ParsedDoc } from '../core/types.ts';

/** Base name (no `.md`) of the map saved next to a plain note; numbering on clash is `availablePath`'s. */
export function newMapBaseName(basename: string, chinese: boolean): string {
	return chinese ? `${basename}（导图）` : `${basename} (mind map)`;
}

/** The `mindmark-state` value: version 2 with `collapsed` (block ids, breadth first); other fields kept. */
export function stateJson(collapsed: readonly string[] = [], extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ ...extra, version: 2, collapsed: [...collapsed] });
}

const OWN_KEY = /^(["']?)(mindmap-plugin|mindmark-state)\1[ \t]*:/;
const OPEN_FENCE = /^---[ \t]*\r?\n/;

const isBlank = (line: string): boolean => line.trim() === '';
/** A line that continues the value of the key above it (indented, or a YAML list item at column 0). */
const continues = (line: string): boolean => /^[ \t]/.test(line) || /^-(?:[ \t]|\r?$)/.test(line);

/**
 * The note's frontmatter lines (between the fences, line breaks kept)
 * without `mindmap-plugin` and `mindmark-state`, values spanning several
 * lines included. Every other byte stays as it was.
 */
export function otherFrontmatterLines(doc: ParsedDoc): string[] {
	const fm = doc.frontmatter;
	if (!fm) return [];
	const text = doc.text;
	const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	const open = OPEN_FENCE.exec(text.slice(bom));
	if (!open) return [];
	const innerFrom = bom + open[0].length;
	let end = fm.range.to;
	while (end > innerFrom && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--;
	const closeFrom = text.lastIndexOf('\n', end - 1) + 1;
	if (closeFrom <= innerFrom) return [];
	// Each piece keeps its own line break (`\n` or `\r\n`).
	const lines = text.slice(innerFrom, closeFrom).match(/[^\n]*\n/g) ?? [];
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (!OWN_KEY.test(line)) {
			out.push(line);
			continue;
		}
		// Skip the value's continuation lines; blank lines count only when more of the value follows.
		let last = i;
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j] ?? '';
			if (isBlank(next)) continue;
			if (!continues(next)) break;
			last = j;
		}
		i = last;
	}
	return out;
}

/** Body of the note written whole (contract 6); a virtual root is not written (contract 4.1). */
export function wholeBody(doc: ParsedDoc, headLevel: number): string {
	const eol: LineEnding = doc.lineEnding;
	let body = writeDocumentBody(doc.root, headLevel, eol);
	if (!doc.virtualRoot) return body;
	// The writer puts the root on the first line; its children are at depth 1 already.
	const nl = body.indexOf('\n');
	body = nl < 0 ? '' : body.slice(nl + 1).replace(/^(?:\r?\n)+/, '');
	// With no heading levels the root was a list item, so its children sit one step in.
	if (clampHeadLevel(headLevel) === 0) {
		body = body
			.split(eol)
			.map((l) => (l.startsWith('    ') ? l.slice(4) : l))
			.join(eol);
	}
	return body;
}

export interface MapTextOptions {
	headLevel: number;
	/** The `mindmark-state` value to write (default: version 2, nothing collapsed). */
	state?: string;
	/** End the file with a line break (default true: a new file ends with one, contract 6.5). */
	finalNewline?: boolean;
}

/**
 * `text` in the map format: its frontmatter minus `mindmap-plugin` and
 * `mindmark-state`, then `mindmap-plugin: basic` and the state, a blank line,
 * and the body generated whole. Line breaks follow the note (contract 6.5).
 */
export function toMapText(text: string, opts: MapTextOptions): string {
	const doc = parseDocument(text);
	const eol = doc.lineEnding;
	const bom = text.charCodeAt(0) === 0xfeff ? '\uFEFF' : '';
	const state = opts.state ?? stateJson();
	const fm = `${bom}---${eol}${otherFrontmatterLines(doc).join('')}mindmap-plugin: basic${eol}mindmark-state: ${state}${eol}---${eol}`;
	const body = wholeBody(doc, opts.headLevel);
	if (body === '') return fm;
	return `${fm}${eol}${body}${opts.finalNewline === false ? '' : eol}`;
}
