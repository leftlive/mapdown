// Map operations as minimal text edits (format contract section 7).
//
// Every operation is a pure function of a parsed document. It returns the
// edits against `doc.text`, the inverse edits that restore `doc.text` when
// applied to the result, and `anchors`: where each created or moved node's
// first line starts in the result, so the caller can find it again after
// re-parsing (`findNodeAt`). An operation that cannot be expressed in the
// text returns null and changes nothing.
//
// Placement rules (the parser's structure decides them):
// - Under a heading or the root, every non-heading child comes before every
//   heading child, and sibling headings never get deeper in document order.
//   A node placed after a heading sibling is written as a heading; a heading
//   placed before a non-heading sibling is written as a list item.
// - Under a list item, everything is a list item (or an indented block).
// - Sibling list items never get more indented in document order, and are
//   indented further than their parent item.
// - Moved lines are copied verbatim. Only when a node has to change level or
//   kind is its line prefix rewritten (hashes, indent, `- ` marker).
// - A blank line is added only where the parser would otherwise merge two
//   blocks (a paragraph or list item swallowing the next line), and before a
//   heading.

import { clampHeadLevel } from './outline.ts';
import { parseDocument } from './parse.ts';
import {
	headingLine,
	isBlockText,
	isCodeText,
	listLine,
	encodeText,
	nextListMarker,
	writeNode,
	writeSubtree,
	type Form,
	type NewNode,
} from './serialize.ts';
import type { EditResult, MapNode, ParsedDoc, Range, TextEdit } from './types.ts';

export interface OpOptions {
	/** The `headLevel` setting, used only for nodes with no sibling to copy (default 1). */
	headLevel?: number;
}

export interface OpResult extends EditResult {
	/**
	 * Offsets into the resulting text where the first line of each created or
	 * moved node starts, in document order. After re-parsing, `findNodeAt`
	 * turns each into the node.
	 */
	anchors: number[];
}

/** A place in the tree: before the `index`-th child of `parentId`. */
export interface Position {
	parentId: string;
	/** Index among the parent's children, not counting nodes being moved. Clamped. */
	index: number;
}

/** A node to create. */
export interface NodeInput {
	text: string;
	blockId?: string | null;
	children?: NodeInput[];
}

// ---------------------------------------------------------------- edits

function sortEdits(edits: readonly TextEdit[]): TextEdit[] {
	return edits
		.map((e, i) => ({ e, i }))
		.sort((a, b) => a.e.from - b.e.from || a.e.to - b.e.to || a.i - b.i)
		.map((x) => x.e);
}

/** Apply edits given against `text` (any order; they must not overlap). */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
	let out = '';
	let pos = 0;
	for (const e of sortEdits(edits)) {
		if (e.from < pos || e.to < e.from) throw new RangeError('overlapping edits');
		out += text.slice(pos, e.from) + e.insert;
		pos = e.to;
	}
	return out + text.slice(pos);
}

/** Sort, merge touching edits, drop no-ops and trim unchanged ends. */
function normalize(text: string, edits: readonly TextEdit[]): TextEdit[] {
	const merged: TextEdit[] = [];
	for (const e of sortEdits(edits)) {
		const last = merged[merged.length - 1];
		if (last && e.from < last.to) throw new RangeError('overlapping edits');
		if (last && e.from === last.to) {
			merged[merged.length - 1] = { from: last.from, to: e.to, insert: last.insert + e.insert };
		} else {
			merged.push({ ...e });
		}
	}
	const out: TextEdit[] = [];
	for (const e of merged) {
		let { from, to, insert } = e;
		while (from < to && insert.length > 0 && text[from] === insert[0]) {
			from++;
			insert = insert.slice(1);
		}
		while (from < to && insert.length > 0 && text[to - 1] === insert[insert.length - 1]) {
			to--;
			insert = insert.slice(0, -1);
		}
		if (from !== to || insert !== '') out.push({ from, to, insert });
	}
	return out;
}

function invert(text: string, edits: readonly TextEdit[]): TextEdit[] {
	let delta = 0;
	return edits.map((e) => {
		const from = e.from + delta;
		delta += e.insert.length - (e.to - e.from);
		return { from, to: from + e.insert.length, insert: text.slice(e.from, e.to) };
	});
}

function result(text: string, edits: readonly TextEdit[], anchors: number[]): OpResult {
	const normal = normalize(text, edits);
	return { edits: normal, inverse: invert(text, normal), anchors };
}

/** Position `pos` of the original text in the text after `edits` (sorted). */
function mapForward(pos: number, edits: readonly TextEdit[]): number {
	let delta = 0;
	for (const e of edits) if (e.to <= pos) delta += e.insert.length - (e.to - e.from);
	return pos + delta;
}

/** Position `q` of the edited text back in the original (sorted edits). */
function mapBack(q: number, edits: readonly TextEdit[]): number {
	let delta = 0;
	for (const e of edits) {
		const start = e.from + delta;
		if (q < start) break;
		if (q < start + e.insert.length) return e.from;
		delta += e.insert.length - (e.to - e.from);
	}
	return q - delta;
}

// ---------------------------------------------------------------- lines

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t';
const isBlank = (s: string): boolean => /^[ \t]*$/.test(s);

function lineStartOf(text: string, pos: number): number {
	return text.lastIndexOf('\n', pos - 1) + 1;
}

/** End of the content of the line containing `pos` (before "\r\n" or "\n"). */
function lineEndOf(text: string, pos: number): number {
	const nl = text.indexOf('\n', pos);
	if (nl < 0) return text.length;
	return nl > pos && text[nl - 1] === '\r' ? nl - 1 : nl;
}

/** Start of the line after the one whose content ends at `end`, or -1. */
function nextLineStart(text: string, end: number): number {
	const nl = text.indexOf('\n', end);
	return nl < 0 ? -1 : nl + 1;
}

interface Found {
	line: Range | null;
	/** Whether blank lines lie between the starting point and `line`. */
	blank: boolean;
}

/** The nearest non-blank line before the line starting at `start`, not before `floor`. */
function prevContent(text: string, start: number, floor: number): Found {
	let blank = false;
	let p = start;
	while (p > floor) {
		const end = lineEndOf(text, lineStartOf(text, p - 1));
		const from = lineStartOf(text, p - 1);
		if (from < floor) break;
		if (!isBlank(text.slice(from, end))) return { line: { from, to: end }, blank };
		blank = true;
		p = from;
	}
	return { line: null, blank };
}

/** The nearest non-blank line after the line whose content ends at `end`. */
function nextContent(text: string, end: number): Found {
	let blank = false;
	let p = nextLineStart(text, end);
	while (p >= 0 && p <= text.length) {
		const e = lineEndOf(text, p);
		if (!isBlank(text.slice(p, e))) return { line: { from: p, to: e }, blank };
		blank = true;
		if (e >= text.length) break;
		p = nextLineStart(text, e);
	}
	return { line: null, blank };
}

/** The last non-blank line at or after `floor`. */
function lastContent(text: string, floor: number): Range | null {
	const start = lineStartOf(text, text.length);
	if (start >= floor && !isBlank(text.slice(start))) return { from: start, to: text.length };
	return prevContent(text, start, floor).line;
}

/** Lines of [from, to) with their own line breaks; the last one may have none. */
function splitRegion(text: string, from: number, to: number): { text: string; brk: string }[] {
	const out: { text: string; brk: string }[] = [];
	let p = from;
	while (p < to) {
		const nl = text.indexOf('\n', p);
		if (nl < 0 || nl >= to) {
			out.push({ text: text.slice(p, to), brk: '' });
			break;
		}
		const end = nl > p && text[nl - 1] === '\r' ? nl - 1 : nl;
		out.push({ text: text.slice(p, end), brk: text.slice(end, nl + 1) });
		p = nl + 1;
	}
	return out;
}

function leadLength(s: string): number {
	let i = 0;
	while (isSpace(s[i])) i++;
	return i;
}

function columns(ws: string): number {
	let col = 0;
	for (const c of ws) col = c === '\t' ? col + 4 - (col % 4) : col + 1;
	return col;
}

/** Move a line `d` columns right (or left when negative), keeping tabs when the result is exact. */
function shiftLine(line: string, d: number): string {
	if (d === 0 || isBlank(line)) return line;
	const lead = leadLength(line);
	const ws = line.slice(0, lead);
	const rest = line.slice(lead);
	const target = Math.max(0, columns(ws) + d);
	if (!ws.includes('\t')) return d > 0 ? ' '.repeat(d) + line : ws.slice(Math.min(lead, -d)) + rest;
	if (d > 0 && d % 4 === 0) return ' '.repeat(d) + line;
	if (d < 0 && -d % 4 === 0 && /^\t*$/.test(ws)) return ws.slice(Math.min(lead, -d / 4)) + rest;
	return ' '.repeat(target) + rest;
}

// ---------------------------------------------------------------- merging hazards

/** What the line before an insertion belongs to, as far as continuation lines go. */
type Owner = 'item' | 'para' | 'table' | 'other';
/** How a line starts, as far as interrupting the previous block goes. */
type Start = 'strong' | 'list' | 'weak' | 'para';

const HEADING_LINE = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const HR_LINE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE_LINE = /^[ \t]*(?:`{3,}|~{3,})/;
const LIST_LINE = /^[ \t]*([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;

function classify(line: string): Start {
	if (HEADING_LINE.test(line) || HR_LINE.test(line) || FENCE_LINE.test(line)) return 'strong';
	const m = LIST_LINE.exec(line);
	if (m) return !isBlank(m[2] ?? '') && /^(?:[-*+]|1[.)])$/.test(m[1] ?? '') ? 'list' : 'weak';
	return 'para';
}

/** Whether a line starting like `next` right after a line of `prev` would be swallowed by it. */
function swallows(prev: Owner, next: Start): boolean {
	if (prev === 'para') return next === 'para' || next === 'weak';
	if (prev === 'item' || prev === 'table') return next === 'para';
	return false;
}

function ownerKind(node: MapNode | null): Owner {
	switch (node?.kind) {
		case 'list':
			return 'item';
		case 'paragraph':
			return 'para';
		case 'table':
			return 'table';
		default:
			return 'other';
	}
}

// ---------------------------------------------------------------- index

interface Info {
	node: MapNode;
	parent: MapNode | null;
	depth: number;
	index: number;
	/** Pre-order number. */
	seq: number;
}

interface DocIndex {
	doc: ParsedDoc;
	info: Map<string, Info>;
	/** Nodes with a source, in document order. */
	order: MapNode[];
	/** Indent step between nested list items (2 or 4 usually). */
	unit: number;
}

const indexes = new WeakMap<ParsedDoc, DocIndex>();

function indexDoc(doc: ParsedDoc): DocIndex {
	const cached = indexes.get(doc);
	if (cached) return cached;
	const info = new Map<string, Info>();
	const order: MapNode[] = [];
	let unit = Infinity;
	let seq = 0;
	const visit = (node: MapNode, parent: MapNode | null, depth: number, index: number): void => {
		info.set(node.id, { node, parent, depth, index, seq: seq++ });
		if (node.source) order.push(node);
		if (node.kind === 'list' && parent?.kind === 'list') {
			const d = colOf(doc.text, node) - colOf(doc.text, parent);
			if (d > 0) unit = Math.min(unit, d);
		}
		node.children.forEach((c, i) => visit(c, node, depth + 1, i));
	};
	visit(doc.root, null, 0, 0);
	const index: DocIndex = { doc, info, order, unit: Number.isFinite(unit) ? Math.min(8, Math.max(2, unit)) : 4 };
	indexes.set(doc, index);
	return index;
}

function src(node: MapNode): NonNullable<MapNode['source']> {
	if (!node.source) throw new Error(`node ${node.id} has no source`);
	return node.source;
}

function firstLine(text: string, node: MapNode): string {
	const from = src(node).range.from;
	return text.slice(from, lineEndOf(text, from));
}

function leadOf(text: string, node: MapNode): string {
	const line = firstLine(text, node);
	return line.slice(0, leadLength(line));
}

function colOf(text: string, node: MapNode): number {
	return columns(leadOf(text, node));
}

/** The node whose own lines contain `pos`, if any. */
function ownerAt(idx: DocIndex, pos: number): MapNode | null {
	const order = idx.order;
	let lo = 0;
	let hi = order.length - 1;
	let found: MapNode | null = null;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const node = order[mid];
		if (!node) break;
		if (src(node).range.from <= pos) {
			found = node;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return found && pos <= src(found).range.to ? found : null;
}

/** The node whose own lines (children excluded) contain `offset`, if any. */
export function nodeAtOffset(doc: ParsedDoc, offset: number): MapNode | null {
	return ownerAt(indexDoc(doc), offset);
}

/** The node whose first line starts at `offset`, if any. */
export function findNodeAt(doc: ParsedDoc, offset: number): MapNode | null {
	const node = ownerAt(indexDoc(doc), offset);
	return node && src(node).range.from === offset ? node : null;
}

function isInside(idx: DocIndex, id: string, ancestors: ReadonlySet<string>): boolean {
	for (let n: MapNode | null = idx.info.get(id)?.node ?? null; n; n = idx.info.get(n.id)?.parent ?? null) {
		if (ancestors.has(n.id)) return true;
	}
	return false;
}

/** The given nodes without those inside another given node, in document order. */
function topmost(idx: DocIndex, ids: readonly string[]): MapNode[] | null {
	const set = new Set(ids);
	const out: Info[] = [];
	for (const id of set) {
		const info = idx.info.get(id);
		if (!info) return null;
		const parent = info.parent;
		if (parent && isInside(idx, parent.id, set)) continue;
		out.push(info);
	}
	return out.sort((a, b) => a.seq - b.seq).map((i) => i.node);
}

// ---------------------------------------------------------------- siblings and parents

/** What a sibling looks like, so new and moved nodes can follow it. */
interface Sib {
	heading: boolean;
	level: number;
	/** A list item: the only kind that takes the lines after it as children. */
	list: boolean;
	col: number;
	indent: string;
	marker: string | null;
}

function sibOf(text: string, node: MapNode): Sib {
	const s = src(node);
	if (node.kind === 'heading') {
		return { heading: true, level: s.headingLevel ?? 1, list: false, col: 0, indent: '', marker: null };
	}
	const indent = s.list?.indent ?? leadOf(text, node);
	const list = node.kind === 'list';
	return { heading: false, level: 0, list, col: columns(indent), indent, marker: list ? (s.list?.marker ?? null) : null };
}

interface ParentDesc {
	node: MapNode;
	list: boolean;
	/** Heading level (0 for the virtual root). */
	level: number;
	col: number;
	depth: number;
	/** A paragraph becomes a list item before it can have children. */
	convert: TextEdit | null;
}

function describeParent(idx: DocIndex, id: string): ParentDesc | null {
	const info = idx.info.get(id);
	if (!info) return null;
	const node = info.node;
	const text = idx.doc.text;
	const base = { node, depth: info.depth, convert: null, col: 0, level: 0 };
	switch (node.kind) {
		case 'root':
			return { ...base, list: false };
		case 'heading':
			return { ...base, list: false, level: src(node).headingLevel ?? 1 };
		case 'list':
			return { ...base, list: true, col: colOf(text, node) };
		case 'paragraph': {
			// `- ` in front keeps the text; continuation lines must not start list items.
			const s = src(node);
			const lines = splitRegion(text, s.range.from, s.range.to).slice(1);
			if (lines.some((l) => LIST_LINE.test(l.text))) return null;
			// A later sibling indented deeper would become the new item's child.
			const col = colOf(text, node);
			const later = info.parent?.children.slice(info.index + 1) ?? [];
			if (later.some((c) => c.kind !== 'heading' && colOf(text, c) > col)) return null;
			const at = s.range.from + leadLength(firstLine(text, node));
			return { ...base, list: true, col, convert: { from: at, to: at, insert: '- ' } };
		}
		default:
			return null;
	}
}

function childList(pd: ParentDesc, moved: ReadonlySet<string>): MapNode[] {
	return pd.node.children.filter((c) => !moved.has(c.id));
}

/**
 * Columns a non-heading node can start at between `prev` and `next`: deeper
 * than a list parent, not deeper than a list item before it (or it would
 * become that item's child), and, when it is a list item itself, not
 * shallower than a block after it (or that block would become its child).
 */
function colRange(pd: ParentDesc, isList: boolean, prev?: Sib, next?: Sib): { lo: number; hi: number } {
	const lo = Math.max(pd.list ? pd.col + 1 : 0, isList && next && !next.heading ? next.col : 0);
	const hi = prev?.list ? prev.col : Infinity;
	return { lo, hi };
}

/** An indent in range: a sibling's exact indent if it fits, else spaces (section 6 step). */
function pickIndent(idx: DocIndex, pd: ParentDesc, range: { lo: number; hi: number }, prev?: Sib, next?: Sib): string {
	for (const s of [prev, next]) if (s && !s.heading && s.col >= range.lo && s.col <= range.hi) return s.indent;
	return ' '.repeat(Math.min(range.hi, Math.max(range.lo, pd.list ? pd.col + idx.unit : 0)));
}

/** The marker of a neighbouring list item (the next number after an ordered one), else `-`. */
function pickMarker(prev?: Sib, next?: Sib): string {
	if (prev?.list && prev.marker) return nextListMarker(prev.marker);
	if (next?.list && next.marker) return next.marker;
	return '-';
}

/** Form of an existing node moved between `prev` and `next` under `pd`. */
function formForExisting(idx: DocIndex, x: MapNode, pd: ParentDesc, prev?: Sib, next?: Sib): Form | null {
	const text = idx.doc.text;
	const headingPrev = !pd.list && prev?.heading === true;
	const blockNext = next !== undefined && !next.heading;
	if (headingPrev && blockNext) return null;
	if (!pd.list && (headingPrev || (!blockNext && x.kind === 'heading'))) {
		const lo = Math.max(pd.level + 1, next?.heading ? next.level : 1);
		const hi = headingPrev && prev ? prev.level : 6;
		if (lo <= hi) {
			const cur = x.kind === 'heading' ? (src(x).headingLevel ?? 1) : hi;
			return { kind: 'heading', level: Math.min(hi, Math.max(lo, cur)) };
		}
		if (headingPrev) return null;
	}
	if (x.kind === 'heading') {
		const range = colRange(pd, true, prev, next);
		return { kind: 'list', indent: pickIndent(idx, pd, range, prev, next), marker: pickMarker(prev, next) };
	}
	const range = colRange(pd, x.kind === 'list', prev, next);
	const cur = colOf(text, x);
	const indent = cur >= range.lo && cur <= range.hi ? leadOf(text, x) : pickIndent(idx, pd, range, prev, next);
	return { kind: 'list', indent, marker: src(x).list?.marker ?? '-' };
}

/** Form of a new node between `prev` and `next` under `pd` (contract section 7: follow the siblings, else section 6). */
function formForNew(idx: DocIndex, n: NewNode, pd: ParentDesc, headLevel: number, prev?: Sib, next?: Sib): Form | null {
	const block = isBlockText(n.text);
	const listForm = (): Form => {
		const range = colRange(pd, !block, prev, next);
		return { kind: 'list', indent: pickIndent(idx, pd, range, prev, next), marker: pickMarker(prev, next) };
	};
	if (pd.list) return listForm();
	if (prev?.heading) return block ? null : { kind: 'heading', level: prev.level };
	if (prev) return listForm();
	if (next?.heading && !block) return { kind: 'heading', level: next.level };
	if (next) return listForm();
	const level = Math.max(pd.depth + 2, pd.level + 1);
	if (!block && pd.depth + 1 < clampHeadLevel(headLevel) && level <= 6) return { kind: 'heading', level };
	return listForm();
}

function sibFromForm(form: Form, list: boolean, marker: string | null): Sib {
	if (form.kind === 'heading') return { heading: true, level: form.level, list: false, col: 0, indent: '', marker: null };
	return { heading: false, level: 0, list, col: columns(form.indent), indent: form.indent, marker: list ? marker : null };
}

// ---------------------------------------------------------------- reflowing an existing subtree

/** A piece of text ready to insert: one subtree. */
interface Block {
	text: string;
	first: string;
	last: Owner;
	heading: boolean;
}

type Tx =
	| { t: 'keep' }
	| { t: 'shift'; d: number; indent?: string }
	| { t: 'heading'; level: number }
	| { t: 'list'; indent: string; marker: string };

const KEEP: Tx = { t: 'keep' };

function preorder(node: MapNode, out: MapNode[] = []): MapNode[] {
	out.push(node);
	for (const c of node.children) preorder(c, out);
	return out;
}

/**
 * The text of `x`'s subtree placed with `form`: lines copied verbatim, and
 * only the prefixes of nodes that change level or kind rewritten.
 */
function reflow(idx: DocIndex, x: MapNode, form: Form): Block | null {
	const text = idx.doc.text;
	const eol = idx.doc.lineEnding;
	const tx = new Map<MapNode, Tx>();
	const setAll = (node: MapNode, t: Tx): void => {
		for (const n of preorder(node)) tx.set(n, t);
	};

	const asHeading = (node: MapNode, level: number): boolean => {
		if (node.kind === 'heading') {
			const old = src(node).headingLevel ?? 1;
			tx.set(node, level === old ? KEEP : { t: 'heading', level });
			for (const c of node.children) {
				if (c.kind !== 'heading') setAll(c, KEEP);
				else {
					const l = (src(c).headingLevel ?? 1) + level - old;
					if (!(l <= 6 ? asHeading(c, l) : asList(c, '', '-'))) return false;
				}
			}
			return true;
		}
		if (node.kind !== 'list' && node.kind !== 'paragraph') return false;
		if (node.kind === 'paragraph' && src(node).textRange === null) return false;
		tx.set(node, { t: 'heading', level });
		const d = node.children.length > 0 ? -Math.min(...node.children.map((c) => colOf(text, c))) : 0;
		for (const c of node.children) setAll(c, d === 0 ? KEEP : { t: 'shift', d });
		return true;
	};

	const asList = (node: MapNode, indent: string, marker: string): boolean => {
		if (node.kind === 'heading') {
			if (isCodeText(node.text)) return false;
			tx.set(node, { t: 'list', indent, marker });
			const childCol = columns(indent) + idx.unit;
			for (const c of node.children) {
				if (c.kind === 'heading') {
					if (!asList(c, ' '.repeat(childCol), '-')) return false;
				} else {
					setAll(c, { t: 'shift', d: childCol });
				}
			}
			return true;
		}
		const d = columns(indent) - colOf(text, node);
		setAll(node, d === 0 ? KEEP : { t: 'shift', d });
		// The exact sibling indent only on a marker line: block rows must keep one common indent.
		if (src(node).list && indent !== leadOf(text, node)) tx.set(node, { t: 'shift', d, indent });
		return true;
	};

	const ok = form.kind === 'heading' ? asHeading(x, form.level) : asList(x, form.indent, form.marker);
	if (!ok) return null;

	const nodes = preorder(x);
	const out: { text: string; brk: string }[] = [];
	let lastOwner: Owner = 'other';
	let prevConverted = false;
	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		if (!node) continue;
		const s = src(node);
		const next = nodes[i + 1];
		const lines = splitRegion(text, s.range.from, next ? src(next).range.from : src(x).subtreeTo);
		const own = splitRegion(text, s.range.from, s.range.to).length;
		const t = tx.get(node) ?? KEEP;
		const converted = t.t === 'heading' || t.t === 'list';
		let owner = ownerKind(node);
		if (t.t === 'shift') {
			lines.forEach((l, k) => {
				l.text = k === 0 && t.indent !== undefined ? t.indent + l.text.slice(leadLength(l.text)) : shiftLine(l.text, t.d);
			});
		} else if (t.t === 'heading') {
			owner = 'other';
			if (node.kind === 'heading') {
				const first = lines[0];
				if (first) first.text = first.text.replace(/^([ \t]*)#+/, (_m, lead: string) => lead + '#'.repeat(t.level));
			} else {
				const brk = lines[own - 1]?.brk ?? '';
				lines.splice(0, own, { text: headingLine(t.level, node.text, node.blockId), brk });
			}
		} else if (t.t === 'list') {
			owner = 'item';
			const first = lines[0];
			if (first) first.text = listLine(t.indent, t.marker, node.text, node.blockId);
		}
		const head = lines[0];
		const before = out[out.length - 1];
		if (head && before && !isBlank(before.text) && (converted || prevConverted) && swallows(lastOwner, classify(head.text))) {
			out.push({ text: '', brk: eol });
		}
		lines.forEach((l, k) => {
			out.push(l);
			if (k < own) lastOwner = owner;
			else if (!isBlank(l.text)) lastOwner = 'other';
		});
		prevConverted = converted;
	}
	return {
		text: out.map((l) => l.text + l.brk).join(''),
		first: out[0]?.text ?? '',
		last: lastOwner,
		heading: form.kind === 'heading',
	};
}

function writtenBlock(n: NewNode, form: Form, idx: DocIndex, depth: number, headLevel: number): Block | null {
	const w = writeSubtree(n, form, { headLevel, depth, eol: idx.doc.lineEnding });
	if (!w) return null;
	const last: Owner = w.lastIsHeading || isCodeText(w.last.text) ? 'other' : isBlockText(w.last.text) ? 'table' : 'item';
	return { text: w.text, first: w.text.slice(0, lineEndOf(w.text, 0)), last, heading: form.kind === 'heading' };
}

// ---------------------------------------------------------------- deleting

function deletionEdits(idx: DocIndex, tops: readonly MapNode[], shifted = new Map<MapNode, number>()): TextEdit[] {
	const text = idx.doc.text;
	const spans = tops.map((n) => ({ from: src(n).range.from, to: src(n).subtreeTo })).sort((a, b) => a.from - b.from);
	const runs: Range[] = [];
	for (const s of spans) {
		const last = runs[runs.length - 1];
		if (last && /^\s*$/.test(text.slice(last.to, s.from))) last.to = Math.max(last.to, s.to);
		else runs.push({ ...s });
	}
	const dels = runs.map((r) => deleteSpan(idx, r.from, r.to));
	return [...dels, ...uncaptureEdits(idx, tops, dels, shifted)];
}

/**
 * A paragraph, code block or table between a list item and a deeper sibling
 * keeps that sibling out of the item. When it goes, the deeper siblings move
 * left to the item's column so they stay siblings (only their indent changes).
 */
function uncaptureEdits(
	idx: DocIndex,
	tops: readonly MapNode[],
	dels: readonly TextEdit[],
	shifted: Map<MapNode, number>,
): TextEdit[] {
	const text = idx.doc.text;
	const gone = new Set(tops.map((n) => n.id));
	const targets = new Map<MapNode, number>();
	for (const top of tops) {
		const info = idx.info.get(top.id);
		const siblings = info?.parent?.children ?? [];
		const at = info?.index ?? 0;
		const before = siblings.slice(0, at).filter((c) => !gone.has(c.id));
		const w = before[before.length - 1];
		if (w?.kind !== 'list') continue;
		const wcol = colOf(text, w);
		// Up to the first sibling that already sits at or left of the item.
		for (const n of siblings.slice(at + 1)) {
			if (gone.has(n.id)) continue;
			if (n.kind === 'heading' || colOf(text, n) <= wcol) break;
			targets.set(n, Math.min(targets.get(n) ?? Infinity, wcol));
		}
	}
	const inDeletion = (pos: number): boolean => dels.some((e) => pos >= e.from && pos < e.to);
	const edits: TextEdit[] = [];
	for (const [n, col] of targets) {
		const d = col - colOf(text, n);
		const s = src(n);
		shifted.set(n, d);
		let p = s.range.from;
		while (p >= 0 && p <= s.subtreeTo) {
			const end = lineEndOf(text, p);
			const line = text.slice(p, end);
			if (!inDeletion(p) && !isBlank(line)) {
				const moved = shiftLine(line, d);
				const lead = leadLength(line);
				edits.push({ from: p, to: p + lead, insert: moved.slice(0, leadLength(moved)) });
			}
			if (end >= text.length) break;
			p = nextLineStart(text, end);
		}
	}
	return edits;
}

/**
 * Remove the lines [from, to] (a line start to a content end). The blank
 * lines on one side go with them, so the gap left is the one that was there;
 * a blank line is kept where the neighbours would otherwise merge.
 */
function deleteSpan(idx: DocIndex, from: number, to: number): TextEdit {
	const { text, bodyFrom, lineEnding } = idx.doc;
	const prev = prevContent(text, from, bodyFrom);
	const next = nextContent(text, to);
	if (!next.line) return prev.line ? { from: prev.line.to, to, insert: '' } : { from, to, insert: '' };
	if (!prev.line || prev.blank) return { from, to: next.line.from, insert: '' };
	const end = nextLineStart(text, to);
	const merge =
		!next.blank &&
		swallows(ownerKind(ownerAt(idx, prev.line.from)), classify(text.slice(next.line.from, next.line.to)));
	return { from, to: end < 0 ? to : end, insert: merge ? lineEnding : '' };
}

// ---------------------------------------------------------------- placing blocks

function effectiveEnd(node: MapNode, moved: ReadonlySet<string>): number {
	let end = src(node).range.to;
	for (const c of node.children) if (!moved.has(c.id)) end = Math.max(end, effectiveEnd(c, moved));
	return end;
}

/**
 * Insert `blocks` as consecutive children of `pd` before `next` (after
 * `prev`), on top of `pre` (deletions and conversions, all in original
 * coordinates). Returns the combined result.
 */
function place(
	idx: DocIndex,
	pd: ParentDesc,
	prev: MapNode | undefined,
	next: MapNode | undefined,
	moved: ReadonlySet<string>,
	blocks: readonly Block[],
	pre: readonly TextEdit[],
): OpResult {
	const { text, lineEnding: eol, bodyFrom } = idx.doc;
	const edits = sortEdits(pre);
	let pos: number;
	let mode: 'after' | 'before' | 'empty';
	if (prev) {
		pos = effectiveEnd(prev, moved);
		mode = 'after';
	} else if (next) {
		pos = src(next).range.from;
		mode = 'before';
	} else if (pd.node.source) {
		pos = src(pd.node).range.to;
		mode = 'after';
	} else {
		// The virtual root of an empty body (other lines, such as rules, may be there).
		const last = lastContent(text, bodyFrom);
		pos = last ? last.to : text.length;
		mode = last ? 'after' : 'empty';
	}

	const t1 = applyEdits(text, edits);
	const p1 = mapForward(pos, edits);

	let body = '';
	const offsets: number[] = [];
	blocks.forEach((b, i) => {
		const before = blocks[i - 1];
		if (before) body += eol + (b.heading || swallows(before.last, classify(b.first)) ? eol : '');
		offsets.push(body.length);
		body += b.text;
	});
	const first = blocks[0];
	const last = blocks[blocks.length - 1];
	if (!first || !last) return result(text, pre, []);

	let lead = '';
	let insert: string;
	if (mode === 'after') {
		const owner = ownerKind(ownerAt(idx, mapBack(lineStartOf(t1, p1), edits)));
		const after = nextContent(t1, p1);
		const gapBefore = first.heading || swallows(owner, classify(first.first));
		lead = eol + (gapBefore ? eol : '');
		let gapAfter = false;
		if (after.line && !after.blank) {
			const line = t1.slice(after.line.from, after.line.to);
			gapAfter = swallows(last.last, classify(line)) || (last.heading && HEADING_LINE.test(line));
		}
		insert = lead + body + (gapAfter ? eol : '');
	} else if (mode === 'before') {
		const before = prevContent(t1, p1, bodyFrom);
		const line = t1.slice(p1, lineEndOf(t1, p1));
		const owner = before.line ? ownerKind(ownerAt(idx, mapBack(before.line.from, edits))) : 'other';
		lead = before.line && !before.blank && (first.heading || swallows(owner, classify(first.first))) ? eol : '';
		const gapAfter = last.heading || swallows(last.last, classify(line));
		insert = lead + body + eol + (gapAfter ? eol : '');
	} else {
		const tail = text.slice(bodyFrom);
		lead = (text.length > 0 && !text.endsWith('\n') ? eol : '') + (idx.doc.frontmatter && !tail.includes('\n') ? eol : '');
		insert = lead + body + eol;
	}
	const anchors = offsets.map((o) => p1 + lead.length + o);
	return result(text, [...pre, { from: pos, to: pos, insert }], anchors);
}

// ---------------------------------------------------------------- operations

/**
 * Move the nodes `ids` (with their subtrees; nested selections count once)
 * to `target`, keeping their document order. Covers drag and drop, move
 * up/down/left/right and "move siblings as children".
 */
export function moveNodes(doc: ParsedDoc, ids: readonly string[], target: Position): OpResult | null {
	const idx = indexDoc(doc);
	const tops = topmost(idx, ids);
	if (!tops || tops.length === 0 || tops.some((n) => n.source === null)) return null;
	const moved = new Set(tops.map((n) => n.id));
	if (isInside(idx, target.parentId, moved)) return null;
	const pd = describeParent(idx, target.parentId);
	if (!pd) return null;
	const siblings = childList(pd, moved);
	const index = Math.max(0, Math.min(siblings.length, Math.trunc(target.index)));
	const prev = siblings[index - 1];
	const next = siblings[index];

	// Already there: nothing to do.
	const at = pd.node.children.indexOf(tops[0]);
	if (at >= 0 && at === index && tops.every((n, i) => pd.node.children[at + i] === n)) {
		return { edits: [], inverse: [], anchors: tops.map((n) => src(n).range.from) };
	}

	const text = doc.text;
	const shifted = new Map<MapNode, number>();
	const pre = deletionEdits(idx, tops, shifted);
	// Nodes moved left by the deletion (with their subtrees) are seen at their new indent.
	const deltaOf = (n: MapNode): number => {
		for (let a: MapNode | null = n; a; a = idx.info.get(a.id)?.parent ?? null) {
			const d = shifted.get(a);
			if (d !== undefined) return d;
		}
		return 0;
	};
	const look = (n: MapNode): Sib => {
		const sib = sibOf(text, n);
		const d = deltaOf(n);
		if (d === 0 || sib.heading) return sib;
		const head = shiftLine(firstLine(text, n), d);
		const indent = head.slice(0, leadLength(head));
		return { ...sib, indent, col: columns(indent) };
	};
	pd.col += deltaOf(pd.node);
	const blocks: Block[] = [];
	let prevSib = prev ? look(prev) : undefined;
	const nextSib = next ? look(next) : undefined;
	for (const top of tops) {
		const form = formForExisting(idx, top, pd, prevSib, nextSib);
		if (!form) return null;
		const block = reflow(idx, top, form);
		if (!block) return null;
		blocks.push(block);
		prevSib = sibFromForm(form, top.kind === 'list' || top.kind === 'heading', form.kind === 'list' ? form.marker : null);
	}
	if (pd.convert) pre.push(pd.convert);
	return place(idx, pd, prev, next, moved, blocks, pre);
}

function toNewNode(n: NodeInput): NewNode {
	return { text: n.text, blockId: n.blockId ?? null, children: (n.children ?? []).map(toNewNode) };
}

/** Create `nodes` (with children) at `target`. */
export function insertNodes(
	doc: ParsedDoc,
	nodes: readonly NodeInput[],
	target: Position,
	opts: OpOptions = {},
): OpResult | null {
	const idx = indexDoc(doc);
	const pd = describeParent(idx, target.parentId);
	if (!pd || nodes.length === 0) return null;
	const siblings = pd.node.children;
	const index = Math.max(0, Math.min(siblings.length, Math.trunc(target.index)));
	const prev = siblings[index - 1];
	const next = siblings[index];
	const headLevel = opts.headLevel ?? 1;
	const blocks: Block[] = [];
	let prevSib = prev ? sibOf(doc.text, prev) : undefined;
	const nextSib = next ? sibOf(doc.text, next) : undefined;
	for (const input of nodes) {
		const n = toNewNode(input);
		const form = formForNew(idx, n, pd, headLevel, prevSib, nextSib);
		if (!form) return null;
		const block = writtenBlock(n, form, idx, pd.depth + 1, headLevel);
		if (!block) return null;
		blocks.push(block);
		prevSib = sibFromForm(form, !isBlockText(n.text), form.kind === 'list' ? form.marker : null);
	}
	return place(idx, pd, prev, next, new Set(), blocks, pd.convert ? [pd.convert] : []);
}

export type ChildAt = 'first' | 'last' | number;

/** Where a new child of `parentId` goes. */
export function childPosition(doc: ParsedDoc, parentId: string, at: ChildAt): Position | null {
	const info = indexDoc(doc).info.get(parentId);
	if (!info) return null;
	const count = info.node.children.length;
	return { parentId, index: at === 'first' ? 0 : at === 'last' ? count : at };
}

/** Where a new sibling before or after `id` goes; null for the root. */
export function siblingPosition(doc: ParsedDoc, id: string, side: 'before' | 'after'): Position | null {
	const info = indexDoc(doc).info.get(id);
	if (!info?.parent) return null;
	return { parentId: info.parent.id, index: info.index + (side === 'after' ? 1 : 0) };
}

export function insertChild(doc: ParsedDoc, parentId: string, text: string, at: ChildAt = 'last', opts?: OpOptions): OpResult | null {
	const pos = childPosition(doc, parentId, at);
	return pos ? insertNodes(doc, [{ text }], pos, opts) : null;
}

export function insertSibling(
	doc: ParsedDoc,
	id: string,
	text: string,
	side: 'before' | 'after' = 'after',
	opts?: OpOptions,
): OpResult | null {
	const pos = siblingPosition(doc, id, side);
	return pos ? insertNodes(doc, [{ text }], pos, opts) : null;
}

/**
 * Paste a Markdown fragment at `target`: one line becomes one node, an
 * outline becomes subtrees (contract section 4 decides the shape). Block ids
 * already used in the document are dropped from the copy.
 */
export function pasteMarkdown(doc: ParsedDoc, markdown: string, target: Position, opts?: OpOptions): OpResult | null {
	// A leading line break keeps a fragment starting with `---` from reading as frontmatter.
	const frag = parseDocument('\n' + markdown.replace(/\r\n?/g, '\n'));
	const tops = frag.virtualRoot ? frag.root.children : [frag.root];
	if (tops.length === 0) return null;
	const used = new Set<string>();
	for (const info of indexDoc(doc).info.values()) if (info.node.blockId) used.add(info.node.blockId.toLowerCase());
	const convert = (n: MapNode): NodeInput => {
		const key = n.blockId?.toLowerCase();
		const keep = key !== undefined && !used.has(key);
		if (key !== undefined) used.add(key);
		return { text: n.text, blockId: keep ? n.blockId : null, children: n.children.map(convert) };
	};
	return insertNodes(doc, tops.map(convert), target, opts);
}

/** Delete the nodes `ids` with their subtrees. The root cannot be deleted. */
export function deleteNodes(doc: ParsedDoc, ids: readonly string[]): OpResult | null {
	const idx = indexDoc(doc);
	const tops = topmost(idx, ids);
	if (!tops || tops.length === 0 || tops.some((n) => n === doc.root || n.source === null)) return null;
	return result(doc.text, deletionEdits(idx, tops), []);
}

function siblingsOf(doc: ParsedDoc, id: string): { info: Info; parent: MapNode } | null {
	const info = indexDoc(doc).info.get(id);
	return info?.parent ? { info, parent: info.parent } : null;
}

/** Swap with the previous sibling. */
export function moveUp(doc: ParsedDoc, id: string): OpResult | null {
	const s = siblingsOf(doc, id);
	if (!s || s.info.index === 0) return null;
	return moveNodes(doc, [id], { parentId: s.parent.id, index: s.info.index - 1 });
}

/** Swap with the next sibling. */
export function moveDown(doc: ParsedDoc, id: string): OpResult | null {
	const s = siblingsOf(doc, id);
	if (!s || s.info.index >= s.parent.children.length - 1) return null;
	return moveNodes(doc, [id], { parentId: s.parent.id, index: s.info.index + 1 });
}

/** Become the last child of the previous sibling (one level deeper). */
export function indentNode(doc: ParsedDoc, id: string): OpResult | null {
	const s = siblingsOf(doc, id);
	const prev = s ? s.parent.children[s.info.index - 1] : undefined;
	if (!prev) return null;
	return moveNodes(doc, [id], { parentId: prev.id, index: prev.children.length });
}

/** Become the next sibling of the parent (one level up). */
export function outdentNode(doc: ParsedDoc, id: string): OpResult | null {
	const s = siblingsOf(doc, id);
	if (!s) return null;
	const grand = siblingsOf(doc, s.parent.id);
	if (!grand) return null;
	return moveNodes(doc, [id], { parentId: grand.parent.id, index: grand.info.index + 1 });
}

/** "Move next siblings as children" / "Move all siblings as children". */
export function adoptSiblings(doc: ParsedDoc, id: string, which: 'next' | 'all'): OpResult | null {
	const s = siblingsOf(doc, id);
	if (!s) return null;
	const others = s.parent.children.filter((c, i) => c.id !== id && (which === 'all' || i > s.info.index));
	if (others.length === 0) return null;
	return moveNodes(
		doc,
		others.map((c) => c.id),
		{ parentId: id, index: s.info.node.children.length },
	);
}

// ---------------------------------------------------------------- text

/** Replace a single-line text span, adding or dropping the separating space. */
function spanEdit(text: string, span: Range, enc: string): TextEdit {
	if (enc === '') {
		let from = span.from;
		while (from > 0 && isSpace(text[from - 1])) from--;
		return { from, to: span.to, insert: '' };
	}
	if (span.from === span.to) {
		const end = lineEndOf(text, span.to);
		const before = span.from > 0 && !isSpace(text[span.from - 1]) && text[span.from - 1] !== '\n' ? ' ' : '';
		const after = span.to < end && !isSpace(text[span.to]) ? ' ' : '';
		return { from: span.from, to: span.to, insert: before + enc + after };
	}
	return { from: span.from, to: span.to, insert: enc };
}

const BLOCK_ID_TAIL = /[ \t]+\^[A-Za-z0-9-]+[ \t]*$/;

/** Where the text of a node's last line ends (before a block id and trailing space). */
function textEnd(text: string, node: MapNode): number {
	const s = src(node);
	const line = text.slice(lineStartOf(text, s.range.to), s.range.to);
	const m = node.blockId !== null ? BLOCK_ID_TAIL.exec(line) : null;
	let end = m ? s.range.to - (line.length - m.index) : s.range.to;
	while (end > s.range.from && isSpace(text[end - 1])) end--;
	return end;
}

/** Lines of a code block or table written directly at `lead` (not in a list item). */
function bareBlock(lead: string, value: string, blockId: string | null, eol: string): string {
	const lines = value.replace(/\r/g, '').trim().split('\n').map((l) => (l === '' ? l : lead + l));
	if (blockId) lines.push(`${lead}^${blockId}`);
	return lines.join(eol);
}

function wrappedBlock(idx: DocIndex, indent: string, value: string, blockId: string | null): string {
	const w = writeNode({ text: value, blockId, children: [] }, { kind: 'list', indent, marker: '-' }, {
		headLevel: 0,
		depth: 0,
		eol: idx.doc.lineEnding,
	});
	return w?.text ?? '';
}

/**
 * Indent for a paragraph, code block or table that becomes a list item: no shallower than
 * the later non-heading siblings (they would become its children) and no
 * deeper than a list item before it. Null when no column fits.
 */
function emptyItemIndent(idx: DocIndex, node: MapNode): string | null {
	const text = idx.doc.text;
	const info = idx.info.get(node.id);
	const siblings = info?.parent?.children ?? [];
	const at = info?.index ?? 0;
	const own = colOf(text, node);
	let need = own;
	for (const c of siblings.slice(at + 1)) {
		const col = colOf(text, c);
		if (c.kind === 'heading' || col <= need) break;
		need = col;
	}
	if (need === own) return leadOf(text, node);
	const prev = siblings[at - 1];
	if (prev?.kind === 'list' && colOf(text, prev) < need) return null;
	return ' '.repeat(need);
}

function textEdits(idx: DocIndex, node: MapNode, value: string): TextEdit[] | null {
	const { text, lineEnding: eol } = idx.doc;
	const s = src(node);
	const block = isBlockText(value);
	const lead = leadOf(text, node);
	const indent = s.list?.indent ?? lead;
	switch (node.kind) {
		case 'heading':
			return s.textRange ? [spanEdit(text, s.textRange, encodeText(value, 'heading'))] : null;
		case 'list': {
			if (block && node.children.length === 0) {
				return [{ from: s.range.from, to: s.range.to, insert: wrappedBlock(idx, indent, value, node.blockId) }];
			}
			// A code block cannot keep children; `<br>` keeps it on the item's line instead.
			if (block && value.trim().startsWith('~~~')) return null;
			const enc = encodeText(value, 'list');
			if (s.textRange) return [spanEdit(text, s.textRange, enc)];
			const m = LIST_LINE.exec(firstLine(text, node));
			const start = s.range.from + (m ? firstLine(text, node).length - (m[2] ?? '').length : lead.length);
			return [spanEdit(text, { from: start, to: textEnd(text, node) }, enc)];
		}
		case 'paragraph': {
			if (block) return [{ from: s.range.from, to: s.range.to, insert: bareBlock(lead, value, node.blockId, eol) }];
			// An empty paragraph line would be a blank line; keep the node as an empty list item.
			if (value.trim() === '') {
				const indent = emptyItemIndent(idx, node);
				return indent === null ? null : [{ from: s.range.from, to: s.range.to, insert: listLine(indent, '-', '', node.blockId) }];
			}
			const enc = encodeText(value, 'paragraph');
			if (s.textRange) return [spanEdit(text, s.textRange, enc)];
			return [{ from: s.range.from + lead.length, to: textEnd(text, node), insert: enc }];
		}
		case 'code':
		case 'table': {
			if (!block) {
				const indent = emptyItemIndent(idx, node);
				if (indent === null && (s.list || value.trim() === '')) return null;
				const line = s.list
					? listLine(indent ?? s.list.indent, s.list.marker, value, node.blockId)
					: value.trim() === ''
						? listLine(indent ?? lead, '-', '', node.blockId)
						: lead + encodeText(value, 'paragraph') + (node.blockId ? ` ^${node.blockId}` : '');
				return [{ from: s.range.from, to: s.range.to, insert: line }];
			}
			if (!s.list) return [{ from: s.range.from, to: s.range.to, insert: bareBlock(lead, value, node.blockId, eol) }];
			const wrapped = wrappedBlock(idx, s.list.indent, value, node.blockId);
			const markerLine = firstLine(text, node);
			if (!isBlank(markerLine.slice(s.list.indent.length + s.list.marker.length))) {
				// `- ```js` on the marker line: rewrite the whole item.
				return [{ from: s.range.from, to: s.range.to, insert: wrapped }];
			}
			// Keep the bare marker line; rewrite the block under it.
			const from = nextLineStart(text, lineEndOf(text, s.range.from));
			const body = wrapped.slice(wrapped.indexOf(eol) + eol.length);
			return [{ from, to: s.range.to, insert: body }];
		}
		default:
			return null;
	}
}

/**
 * Set a node's text. Only the text span changes; the marker, indent, number
 * and block id stay. Setting the virtual root's text writes it as the first
 * line, a level-1 heading, and moves the existing headings one level down
 * (contract 4.1).
 */
export function setText(doc: ParsedDoc, id: string, value: string): OpResult | null {
	const idx = indexDoc(doc);
	const node = idx.info.get(id)?.node;
	if (!node) return null;
	if (!node.source) return virtualRootText(idx, value);
	if (value === node.text) return { edits: [], inverse: [], anchors: [node.source.range.from] };
	const edits = textEdits(idx, node, value);
	return edits ? result(doc.text, edits, [node.source.range.from]) : null;
}

function virtualRootText(idx: DocIndex, value: string): OpResult | null {
	const { doc } = idx;
	const { text, lineEnding: eol, bodyFrom } = doc;
	if (value.trim() === '' || isBlockText(value)) return null;
	const children = doc.root.children;
	const levels = children.filter((c) => c.kind === 'heading').map((c) => src(c).headingLevel ?? 1);
	const delta = levels.length > 0 ? Math.max(0, 2 - Math.min(...levels)) : 0;
	const edits: TextEdit[] = [];
	if (delta > 0) {
		for (const c of children) {
			if (c.kind !== 'heading') continue;
			const block = reflow(idx, c, { kind: 'heading', level: (src(c).headingLevel ?? 1) + delta });
			if (!block) return null;
			edits.push({ from: src(c).range.from, to: src(c).subtreeTo, insert: block.text });
		}
	}
	const line = headingLine(1, value, null);
	const first = children[0];
	let at: number;
	let insert: string;
	if (first) {
		at = src(first).range.from;
		insert = line + eol + eol;
	} else {
		const last = lastContent(text, bodyFrom);
		at = last ? last.to : text.length;
		insert = last
			? eol + eol + line
			: (text.length > 0 && !text.endsWith('\n') ? eol : '') + (doc.frontmatter && !text.slice(bodyFrom).includes('\n') ? eol : '') + line + eol;
	}
	const anchor = mapForward(at, sortEdits(edits)) + insert.indexOf('#');
	edits.push({ from: at, to: at, insert });
	return result(text, edits, [anchor]);
}

const BLOCK_ID = /^[A-Za-z0-9-]+$/;

/**
 * Give a node the block id `blockId`: ` ^id` at the end of its line, or a
 * `^id` line after a code block or table. Null when the node already has one
 * (block ids never change), for the virtual root, or for an unclosed fence.
 */
export function assignBlockId(doc: ParsedDoc, id: string, blockId: string): OpResult | null {
	if (!BLOCK_ID.test(blockId)) return null;
	const idx = indexDoc(doc);
	const node = idx.info.get(id)?.node;
	if (!node?.source || node.blockId !== null) return null;
	const { text, lineEnding: eol } = doc;
	const s = node.source;
	if (node.kind === 'code' || node.kind === 'table') {
		if (node.kind === 'code') {
			const lines = node.text.split('\n');
			const open = /^(`{3,}|~{3,})/.exec(lines[0] ?? '')?.[1] ?? '```';
			const close = lines.length > 1 ? (lines[lines.length - 1] ?? '') : '';
			if (close.length < open.length || close !== (open[0] ?? '`').repeat(close.length)) return null;
		}
		const lastLine = text.slice(lineStartOf(text, s.range.to), s.range.to);
		const lead = lastLine.slice(0, leadLength(lastLine));
		return result(text, [{ from: s.range.to, to: s.range.to, insert: `${eol}${lead}^${blockId}` }], [s.range.from]);
	}
	let end = s.range.to;
	while (end > s.range.from && isSpace(text[end - 1])) end--;
	return result(text, [{ from: end, to: end, insert: ` ^${blockId}` }], [s.range.from]);
}

/** A block id not used in the document (lowercase letters and digits). */
export function uniqueBlockId(doc: ParsedDoc, random: () => number = Math.random): string {
	const used = new Set<string>();
	for (const info of indexDoc(doc).info.values()) if (info.node.blockId) used.add(info.node.blockId.toLowerCase());
	// Random tries first; a counter suffix always ends the search.
	for (let attempt = 0; attempt < 64; attempt++) {
		let id = String.fromCharCode(97 + Math.floor(random() * 26));
		for (let i = 0; i < 5; i++) id += Math.floor(random() * 36).toString(36);
		if (!used.has(id)) return id;
	}
	let n = used.size;
	while (used.has(`b${n}`)) n++;
	return `b${n}`;
}
