// Text transforms for the inline node editor. Pure.

export interface TextSel {
	text: string;
	from: number;
	to: number;
}

function runBefore(text: string, at: number, ch: string): number {
	let n = 0;
	while (at - n - 1 >= 0 && text[at - n - 1] === ch) n++;
	return n;
}

function runAfter(text: string, at: number, ch: string): number {
	let n = 0;
	while (at + n < text.length && text[at + n] === ch) n++;
	return n;
}

/** True when `n` repeated marker characters contain the marker (`*` inside `***` counts, `*` inside `**` does not). */
function hasMarker(n: number, len: number): boolean {
	if (len === 1) return n % 2 === 1;
	return n >= len;
}

/**
 * Wrap the selection in `marker` (`**`, `*`, `==`, `~~`), or remove it when
 * the selection is already wrapped, either just outside or just inside.
 */
export function toggleWrap(s: TextSel, marker: string): TextSel {
	const { text } = s;
	const from = Math.min(s.from, s.to);
	const to = Math.max(s.from, s.to);
	const m = marker.length;
	const uniform = m > 0 && [...marker].every((c) => c === marker[0]);
	if (m === 0) return { text, from, to };

	// outside: **|sel|**
	if (uniform) {
		const ch = marker[0];
		const n = Math.min(runBefore(text, from, ch), runAfter(text, to, ch));
		if (from !== to || n > 0) {
			if (hasMarker(n, m)) {
				return { text: text.slice(0, from - m) + text.slice(from, to) + text.slice(to + m), from: from - m, to: to - m };
			}
		}
	} else if (text.slice(from - m, from) === marker && text.slice(to, to + m) === marker) {
		return { text: text.slice(0, from - m) + text.slice(from, to) + text.slice(to + m), from: from - m, to: to - m };
	}

	// inside: |**sel**|
	const sel = text.slice(from, to);
	if (sel.length >= 2 * m && sel.startsWith(marker) && sel.endsWith(marker)) {
		const inner = sel.slice(m, sel.length - m);
		const lead = uniform ? runAfter(sel, 0, marker[0]) : m;
		const trail = uniform ? runBefore(sel, sel.length, marker[0]) : m;
		if (!uniform || (hasMarker(Math.min(lead, trail), m) && inner.length > 0)) {
			return { text: text.slice(0, from) + inner + text.slice(to), from, to: from + inner.length };
		}
	}

	return {
		text: text.slice(0, from) + marker + sel + marker + text.slice(to),
		from: from + m,
		to: to + m,
	};
}

/** Replace the selection with `insert`; the caret ends after it. */
export function insertAt(s: TextSel, insert: string): TextSel {
	const from = Math.min(s.from, s.to);
	const to = Math.max(s.from, s.to);
	const at = from + insert.length;
	return { text: s.text.slice(0, from) + insert + s.text.slice(to), from: at, to: at };
}
