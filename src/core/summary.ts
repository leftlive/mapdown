// Summaries and frames (behaviour spec 5.15, format contract 4.11). Both are
// Obsidian comments at the end of a node's last line, before the block id:
// `%%summary%%`, `%%summary:N%%`, `%%frame%%`, `%%frame: label%%`. This module
// reads them off a line, writes their canonical form, decides which nodes can
// carry them, and computes which siblings each summary covers. Pure, so tests
// run it in Node; the parser, the ops and the layout share it.

import { taskOf } from './tasks.ts';
import type { FrameMark, LayoutDirection, MapNode, NodeKind, SummaryMark } from './types.ts';

export type { FrameMark, NotesSource, SummaryMark } from './types.ts';

/** Comments read off the end of a span (offsets relative to the string they were read from). */
export interface ReadNotes {
	/** End of the text before the comments, trailing spaces not included. */
	to: number;
	summary?: { mark: SummaryMark; from: number; to: number };
	frame?: { mark: FrameMark; from: number; to: number };
}

const NOTE_BODY = /^[ \t]*(summary|frame)[ \t]*(?::[ \t]*(.*?))?[ \t]*$/i;
const COUNT = /^[1-9][0-9]?$/;

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t';

/**
 * Read summary and frame comments from the end of `s.slice(from, to)` (the
 * block id already cut off, ends trimmed). Contract 4.11.2-3: a run read
 * backwards, each comment preceded by at least one space (or, with `bare`,
 * standing at `from`: an empty heading or list item); the run stops at the
 * first thing that is not one of them, including a second comment of a kind
 * already read. Null when there is none. No lookbehind (iOS before 16.4).
 */
export function readNotes(s: string, from: number, to: number, bare: boolean): ReadNotes | null {
	let end = to;
	let out: ReadNotes | null = null;
	while (end - from >= 4 && s.charCodeAt(end - 1) === 37 && s.charCodeAt(end - 2) === 37) {
		const open = s.lastIndexOf('%%', end - 3);
		if (open < from || open + 2 > end - 2) break;
		const body = s.slice(open + 2, end - 2);
		if (body.includes('%')) break;
		const m = NOTE_BODY.exec(body);
		if (!m) break;
		if (!(open === from ? bare : isSpace(s[open - 1]))) break;
		const kind = (m[1] ?? '').toLowerCase();
		const arg = m[2];
		const r: ReadNotes = out ?? { to };
		if (kind === 'summary') {
			if (r.summary) break;
			if (arg !== undefined && !COUNT.test(arg)) break;
			r.summary = { mark: arg === undefined ? {} : { count: Number(arg) }, from: open, to: end };
		} else {
			if (r.frame) break;
			const label = (arg ?? '').trim();
			r.frame = { mark: label === '' ? {} : { label }, from: open, to: end };
		}
		out = r;
		let t = open;
		while (t > from && isSpace(s[t - 1])) t--;
		end = t;
		r.to = t;
	}
	return out;
}

/** A frame label as written: `%` removed, ends trimmed (spec 5.15, "外框标签"). */
export function cleanLabel(label: string): string {
	return label.replace(/%/g, '').replace(/[\r\n]+/g, ' ').trim();
}

/** Canonical `%%summary%%` / `%%summary:N%%` (contract 4.11.5). */
export function summaryComment(mark: SummaryMark): string {
	return mark.count !== undefined ? `%%summary:${mark.count}%%` : '%%summary%%';
}

/** Canonical `%%frame%%` / `%%frame: label%%`. */
export function frameComment(mark: FrameMark): string {
	const label = cleanLabel(mark.label ?? '');
	return label === '' ? '%%frame%%' : `%%frame: ${label}%%`;
}

/** The canonical comments of a node written anew: ` %%summary…%% %%frame…%%` ('' for none). */
export function notesSuffix(marks: { summary?: SummaryMark; frame?: FrameMark }): string {
	let s = '';
	if (marks.summary) s += ` ${summaryComment(marks.summary)}`;
	if (marks.frame) s += ` ${frameComment(marks.frame)}`;
	return s;
}

/**
 * The node's comments exactly as in `text` (lenient spellings and inner
 * spacing kept), with one leading space; '' when it has none. Used when a
 * line is rewritten from the node's text, so the comments stay as they were.
 */
export function rawNotes(text: string, node: Pick<MapNode, 'source'>): string {
	const n = node.source?.notes;
	if (!n) return '';
	const parts = [n.summary, n.frame].filter((r): r is { from: number; to: number } => r !== undefined).sort((a, b) => a.from - b.from);
	const first = parts[0];
	const last = parts[parts.length - 1];
	if (!first || !last) return '';
	// on one line: as written, inner spacing included; a heading's may sit on two lines (4.11.6)
	const span = text.slice(first.from, last.to);
	return span.includes('\n') ? ` ${parts.map((r) => text.slice(r.from, r.to)).join(' ')}` : ` ${span}`;
}

/** A heading's comment line for `notes` (a ` %%…%%` suffix as from notesSuffix or rawNotes): the comments alone. */
export function notesLine(notes: string): string {
	return notes.trim();
}

/**
 * Kinds and texts that can be a summary or carry a frame: list items,
 * headings and plain paragraphs, not quotes or callouts (text starting with
 * `>` after a task marker). The same set as node markers (spec 5.14).
 */
export function notableText(kind: NodeKind, text: string): boolean {
	if (kind !== 'list' && kind !== 'heading' && kind !== 'paragraph') return false;
	const task = taskOf(text, kind);
	return !text.startsWith('>', task ? task.length : 0);
}

/** Whether the node can be a summary or get a frame; never the document root (spec 5.15). */
export function canHaveNotes(node: Pick<MapNode, 'kind' | 'text' | 'source'>, root?: object): boolean {
	return node !== root && node.source !== null && notableText(node.kind, node.text);
}

// ---------------------------------------------------------------- ranges

export type BranchSide = 'left' | 'right' | 'down';

/** Siblings that a summary covers: indices `first..last` (inclusive) in the sibling list. */
export interface SummaryCover {
	first: number;
	last: number;
}

export interface SummaryPlan {
	/** Per sibling: what it covers when it is a summary that holds, else null. */
	covers: (SummaryCover | null)[];
	/** Per sibling: its side (only differs from the input for summaries moved next to what they cover). */
	sides: BranchSide[];
}

export interface RootPlan extends SummaryPlan {
	/** Per root child: its branch colour index. Summaries that hold use the one of the node before them. */
	colours: number[];
}

/**
 * Sides, branch colours and summary ranges of the root's children (spec 9,
 * 5.15). Summaries that hold take no part in the split: the other children
 * are split by the usual rule (the first ceil(n/2) on the right in two-sided
 * layouts) and numbered for colours in their order; a summary then goes to
 * the side of the node before it (the last one it covers) and covers only
 * that side. Adding or removing a summary never moves another child.
 */
export function planRoot(marks: readonly (SummaryMark | undefined)[], direction: LayoutDirection): RootPlan {
	const held = planSummaries(marks).covers;
	const n = marks.length;
	let others = 0;
	for (let i = 0; i < n; i++) if (!held[i]) others++;
	const right = direction === 'right' ? others : direction === 'left' ? 0 : Math.ceil(others / 2);
	const sides: BranchSide[] = new Array<BranchSide>(n);
	const colours: number[] = new Array<number>(n);
	let k = 0;
	for (let i = 0; i < n; i++) {
		if (held[i]) {
			sides[i] = sides[i - 1] ?? 'right';
			colours[i] = colours[i - 1] ?? 0;
			continue;
		}
		sides[i] = direction === 'down' ? 'down' : k < right ? 'right' : 'left';
		colours[i] = k++;
	}
	const twoSided = direction === 'mindmap' || direction === 'clockwise';
	return { ...(twoSided ? planSummaries(marks, sides) : { covers: held, sides }), colours };
}

/**
 * Which siblings each summary covers (spec 5.15). `marks[i]` is sibling i's
 * summary comment (undefined for an ordinary node). A summary covers the
 * siblings right before it: back to the previous summary (excluded) or the
 * first sibling, or only the last N; fewer than N when it meets a summary or
 * the start first. With nothing to cover it does not hold and is an ordinary
 * node (coverable by a later summary). With `sides` (root children of a
 * two-sided layout), a summary goes to the side of the sibling right before
 * it and covers only siblings on that side; a summary that does not hold
 * keeps its own side. Left to right, so a summary that does not hold never
 * stops a later one.
 */
export function planSummaries(marks: readonly (SummaryMark | undefined)[], sides?: readonly BranchSide[]): SummaryPlan {
	const n = marks.length;
	const covers: (SummaryCover | null)[] = new Array<SummaryCover | null>(n).fill(null);
	const out: BranchSide[] = sides ? sides.slice() : [];
	for (let i = 1; i < n; i++) {
		const mark = marks[i];
		if (!mark) continue;
		const side = sides ? out[i - 1] : undefined;
		const limit = mark.count ?? Infinity;
		let first = i;
		for (let j = i - 1; j >= 0 && i - j <= limit; j--) {
			if (covers[j] !== null || (sides && out[j] !== side)) break;
			first = j;
		}
		if (first === i) continue;
		covers[i] = { first, last: i - 1 };
		if (sides && side !== undefined) out[i] = side;
	}
	return { covers, sides: out };
}

