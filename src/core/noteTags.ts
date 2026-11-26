// Summary and frame comments as seen from single lines of a note (behaviour
// spec 5.16). The Markdown views show them as small tags; this module only
// answers "which comments does this line hold", with the parser's own rules
// (readNotes, notableText, the heading's comment line of contract 4.11.6), so
// the live preview and the reading view agree with the map. Pure: no DOM, no
// Obsidian, so tests run it in Node.

import { notableText, readNotes } from './summary.ts';

/** One recognised comment: what it is and where it stands in its line. */
export interface NoteTag {
	kind: 'summary' | 'frame';
	/** `%%summary:N%%`. */
	count?: number;
	/** `%%frame: label%%`. */
	label?: string;
	/** Offsets in the line: the comment from its first `%` to after its last. */
	from: number;
	to: number;
}

export interface LineNotes {
	tags: NoteTag[];
	/** The line holds nothing but comments and sits under a heading (4.11.6): it is the heading's comment line. */
	own: boolean;
}

/** Read access to the lines of a note (0-based); undefined past the ends. */
export type LineAt = (i: number) => string | undefined;

const HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/;
const LIST = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})/;
const BLOCK_ID_TAIL = /[ \t]+\^[A-Za-z0-9-]+$/;

const blank = (s: string): boolean => s.trim() === '';

/** A line that cannot continue the paragraph or list item above it. */
function startsBlock(s: string): boolean {
	return HEADING.test(s) || LIST.test(s) || RULE.test(s) || FENCE.test(s) || /^[ \t]*>/.test(s) || s.startsWith('|');
}

/** End of the text before a block id, trailing spaces cut. */
function textEnd(s: string, from: number): number {
	let to = s.length;
	while (to > from && (s[to - 1] === ' ' || s[to - 1] === '\t')) to--;
	const id = BLOCK_ID_TAIL.exec(s.slice(from, to));
	if (id) {
		to = from + id.index;
		while (to > from && (s[to - 1] === ' ' || s[to - 1] === '\t')) to--;
	}
	return to;
}

function toTags(r: NonNullable<ReturnType<typeof readNotes>>): NoteTag[] {
	const tags: NoteTag[] = [];
	if (r.summary) {
		const t: NoteTag = { kind: 'summary', from: r.summary.from, to: r.summary.to };
		if (r.summary.mark.count !== undefined) t.count = r.summary.mark.count;
		tags.push(t);
	}
	if (r.frame) {
		const t: NoteTag = { kind: 'frame', from: r.frame.from, to: r.frame.to };
		if (r.frame.mark.label !== undefined) t.label = r.frame.mark.label;
		tags.push(t);
	}
	return tags.sort((a, b) => a.from - b.from);
}

/** The comments at the end of heading line `i`, or null. */
function headingNotes(line: string): NoteTag[] | null {
	const m = HEADING.exec(line);
	if (!m) return null;
	const from = m[0].length;
	const r = readNotes(line, from, textEnd(line, from), true);
	if (!r || !notableText('heading', line.slice(from, r.to))) return null;
	return toTags(r);
}

/** Whether `prev` is a heading that can carry comments (its text before any comments is notable). */
function carriesNotes(prev: string | undefined): boolean {
	if (prev === undefined) return false;
	const m = HEADING.exec(prev);
	if (!m) return false;
	const from = m[0].length;
	const to = textEnd(prev, from);
	const r = readNotes(prev, from, to, true);
	return notableText('heading', prev.slice(from, r ? r.to : to));
}

/**
 * The comments line `i` shows as tags, or null. The comments of a list item,
 * heading or paragraph stand at the end of its last line (contract 4.11.1-2),
 * so a line that the next line continues has none; a heading's comment line
 * (4.11.6) is the line under the heading that holds only comments.
 */
export function noteTagsAt(get: LineAt, i: number): LineNotes | null {
	const line = get(i);
	if (line === undefined || blank(line) || line.startsWith('|')) return null;
	const prev = get(i - 1);
	const head = HEADING.test(line);
	const item = !head && LIST.test(line);
	if (!head && !item) {
		if (/^[ \t]*>/.test(line) || FENCE.test(line) || RULE.test(line)) return null;
		let from = 0;
		while (line[from] === ' ' || line[from] === '\t') from++;
		const to = textEnd(line, from);
		if (carriesNotes(prev)) {
			const r = readNotes(line, from, to, true);
			if (r && r.to === from) return { tags: toTags(r), own: true };
		}
		// a paragraph (or the last line of one); deeper indents are code unless the line goes on a paragraph
		if (from >= 4 && (prev === undefined || blank(prev))) return null;
		const next = get(i + 1);
		if (next !== undefined && !blank(next) && !startsBlock(next)) return null;
		const r = readNotes(line, from, to, false);
		return r && notableText('paragraph', line.slice(from, r.to)) ? { tags: toTags(r), own: false } : null;
	}
	if (head) {
		const tags = headingNotes(line);
		return tags ? { tags, own: false } : null;
	}
	const next = get(i + 1);
	if (next !== undefined && !blank(next) && !startsBlock(next)) return null;
	const from = (LIST.exec(line) ?? [''])[0].length;
	const r = readNotes(line, from, textEnd(line, from), true);
	return r && notableText('list', line.slice(from, r.to)) ? { tags: toTags(r), own: false } : null;
}

/**
 * The tags to show on the item or heading starting at line `i` (reading view):
 * a list item's own comments (found on its last line), a heading's comments
 * from its line and from the comment line under it.
 */
export function nodeTagsFrom(get: LineAt, i: number): NoteTag[] {
	const line = get(i);
	if (line === undefined) return [];
	if (HEADING.test(line)) {
		const own = noteTagsAt(get, i + 1);
		return [...(noteTagsAt(get, i)?.tags ?? []), ...(own && own.own ? own.tags : [])];
	}
	let last = i;
	for (;;) {
		const next = get(last + 1);
		if (next === undefined || blank(next) || startsBlock(next)) break;
		last++;
	}
	const n = noteTagsAt(get, last);
	return n && !n.own ? n.tags : [];
}

/** Lines that hold no comments: the front matter, fenced code and `$$` math blocks. Inclusive 0-based ranges, ascending. */
export function skippedLines(get: LineAt, count: number): [number, number][] {
	const out: [number, number][] = [];
	let i = 0;
	if (get(0)?.trim() === '---') {
		for (let j = 1; j < count; j++) {
			const s = get(j)?.trim();
			if (s === '---' || s === '...') {
				out.push([0, j]);
				i = j + 1;
				break;
			}
		}
	}
	for (; i < count; i++) {
		const s = get(i) ?? '';
		const f = FENCE.exec(s);
		if (f && !(f[2]?.startsWith('`') && s.slice(f[0].length).includes('`'))) {
			const ch = f[2]?.[0] ?? '`';
			const len = f[2]?.length ?? 3;
			let j = i + 1;
			while (j < count) {
				const c = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${len},}[ \\t]*$`).test(get(j) ?? '');
				if (c) break;
				j++;
			}
			out.push([i, Math.min(j, count - 1)]);
			i = j;
		} else if (s.trim().startsWith('$$') && !(s.trim().length > 2 && s.trim().endsWith('$$'))) {
			let j = i + 1;
			while (j < count && !(get(j) ?? '').includes('$$')) j++;
			out.push([i, Math.min(j, count - 1)]);
			i = j;
		}
	}
	return out;
}

/** The tags that show as a pill: only a frame with a label (spec 5.16). Summaries and plain frames are drawn by the range lines. */
export function shownTags(tags: readonly NoteTag[]): NoteTag[] {
	return tags.filter((tag) => tag.kind === 'frame' && tag.label !== undefined);
}

/**
 * The block id (contract 4.8) to hide on line `i` of a map note: ` ^id` at the
 * end of the last line of a list item, heading, paragraph or quote, with the
 * spaces before it, or the whole line when it holds only an id under a table
 * (`afterFence`: or under a code block, which the caller knows from skippedLines).
 * Offsets are in the line; null when there is none.
 */
export function blockIdAt(get: LineAt, i: number, afterFence = false): { from: number; to: number } | null {
	const line = get(i);
	if (line === undefined || blank(line)) return null;
	if (/^[ \t]*\^[A-Za-z0-9-]+[ \t]*$/.test(line)) {
		const prev = get(i - 1);
		return afterFence || (prev !== undefined && prev.startsWith('|')) ? { from: 0, to: line.length } : null;
	}
	if (line.startsWith('|') || FENCE.test(line) || RULE.test(line)) return null;
	if (!HEADING.test(line)) {
		const next = get(i + 1);
		if (next !== undefined && !blank(next) && !startsBlock(next)) return null;
	}
	let end = line.length;
	while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
	const m = BLOCK_ID_TAIL.exec(line.slice(0, end));
	return m ? { from: m.index, to: line.length } : null;
}
