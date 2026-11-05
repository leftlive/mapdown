// Pure helpers over TextEdit lists: apply, invert, map positions, compose two
// sequential edit lists, diff two texts, and rebase an edit list over an
// unrelated change.
//
// The map keeps its own text as a plain string and its edits as TextEdit
// lists rather than @codemirror/state ChangeSets: CodeMirror's Text splits
// lines on "\r\n", so a ChangeSet built from a CRLF document would count each
// line break as one character and every offset after it would drift. A
// ChangeSet is built only at the boundary, when an edit is dispatched to a
// Markdown editor (whose document is the session text then).

import type { TextEdit } from '../core/types.ts';

/** Sorted by position; stable for equal positions. */
export function sortEdits(edits: readonly TextEdit[]): TextEdit[] {
	return edits
		.map((e, i) => ({ e, i }))
		.sort((a, b) => a.e.from - b.e.from || a.e.to - b.e.to || a.i - b.i)
		.map((x) => x.e);
}

/** Apply edits given against `text` (any order; they must not overlap). */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
	let out = '';
	let pos = 0;
	for (const e of sortEdits(edits)) {
		if (e.from < pos || e.to < e.from || e.to > text.length) throw new RangeError('overlapping or out-of-range edits');
		out += text.slice(pos, e.from) + e.insert;
		pos = e.to;
	}
	return out + text.slice(pos);
}

/** Edits that turn the result of `edits` (on `text`) back into `text`. */
export function invertEdits(text: string, edits: readonly TextEdit[]): TextEdit[] {
	let delta = 0;
	return sortEdits(edits).map((e) => {
		const from = e.from + delta;
		delta += e.insert.length - (e.to - e.from);
		return { from, to: from + e.insert.length, insert: text.slice(e.from, e.to) };
	});
}

/**
 * Where `pos` of the original text ends up after `edits`. A position inside a
 * replaced range goes to the range's start (assoc < 0) or end (assoc > 0).
 */
export function mapPos(pos: number, edits: readonly TextEdit[], assoc: -1 | 1 = -1): number {
	let delta = 0;
	for (const e of sortEdits(edits)) {
		if (e.from > pos || (e.from === pos && e.to === pos && assoc < 0)) break;
		if (e.to < pos || (e.to === pos && !(e.from === pos && assoc < 0))) {
			delta += e.insert.length - (e.to - e.from);
			continue;
		}
		// pos is inside [from, to]
		return assoc < 0 ? e.from + delta : e.from + delta + e.insert.length;
	}
	return pos + delta;
}

/** One edit covering everything that differs between `a` and `b` (none when equal). */
export function diffTexts(a: string, b: string): TextEdit[] {
	if (a === b) return [];
	let start = 0;
	const min = Math.min(a.length, b.length);
	while (start < min && a.charCodeAt(start) === b.charCodeAt(start)) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
		endA--;
		endB--;
	}
	return [{ from: start, to: endA, insert: b.slice(start, endB) }];
}

/**
 * Compose `first` (on t0) and `second` (on the result t1) into one edit list
 * on t0. When an edit of `second` overlaps text inserted by `first`, falls
 * back to one edit spanning the whole difference.
 */
export function composeEdits(t0: string, first: readonly TextEdit[], second: readonly TextEdit[]): TextEdit[] {
	if (second.length === 0) return sortEdits(first);
	if (first.length === 0) return sortEdits(second);
	const a = sortEdits(first);
	// Inserted regions of `first`, in t1 coordinates.
	const inserted: { from: number; to: number }[] = [];
	let delta = 0;
	for (const e of a) {
		const from = e.from + delta;
		inserted.push({ from, to: from + e.insert.length });
		delta += e.insert.length - (e.to - e.from);
	}
	const back: TextEdit[] = [];
	for (const e of sortEdits(second)) {
		const hits = inserted.some((r) => e.from <= r.to && e.to >= r.from);
		if (hits) {
			const t1 = applyTextEdits(t0, a);
			return diffTexts(t0, applyTextEdits(t1, second));
		}
		back.push({ from: mapBackPos(e.from, a), to: mapBackPos(e.to, a), insert: e.insert });
	}
	return sortEdits([...a, ...back]);
}

/** A position of the edited text (outside any inserted region) back in the original. */
function mapBackPos(q: number, edits: readonly TextEdit[]): number {
	let delta = 0;
	for (const e of edits) {
		const start = e.from + delta;
		if (q < start) break;
		delta += e.insert.length - (e.to - e.from);
	}
	return q - delta;
}

/** True when the two edit lists (on the same text) touch or overlap anywhere. */
export function editsTouch(a: readonly TextEdit[], b: readonly TextEdit[]): boolean {
	for (const x of a) for (const y of b) if (x.from <= y.to && x.to >= y.from) return true;
	return false;
}

/**
 * Rebase `edits` (on text D) over `other` (also on D, not touching): returns
 * `edits` expressed on D after `other`, and `other` expressed on D after
 * `edits`. Null when they touch (the caller drops what cannot be mapped).
 */
export function rebaseEdits(
	edits: readonly TextEdit[],
	other: readonly TextEdit[],
): { edits: TextEdit[]; other: TextEdit[] } | null {
	if (editsTouch(edits, other)) return null;
	const shift = (list: readonly TextEdit[], by: readonly TextEdit[]): TextEdit[] =>
		list.map((e) => ({ from: mapPos(e.from, by, -1), to: mapPos(e.to, by, 1), insert: e.insert }));
	return { edits: shift(edits, other), other: shift(other, edits) };
}
