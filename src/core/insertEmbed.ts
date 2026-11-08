// Where and how a map embed is written into a note (behaviour spec 5.10,
// "Insert"): the embed takes a line of its own. Pure text and offsets; no
// DOM, no Obsidian. The note editor text uses `\n` line breaks.

/** One replacement in the note text and where the caret goes afterwards (all offsets in the old text, `cursor` in the new). */
export interface EmbedInsertion {
	from: number;
	to: number;
	insert: string;
	/** Caret offset in the text after the edit: the end of the embed line. */
	cursor: number;
}

/**
 * The edit that puts `embed` (for example `![[Map]]`) on a line of its own.
 * `from`..`to` is the selection (equal for a bare caret).
 * - The caret sits on an empty (or blank) line: the embed takes the line.
 * - Otherwise a line break and the embed go after the last line the selection
 *   touches; a selection is never replaced. A selection that ends at the very
 *   start of a line does not touch that line.
 * - A line with text right above or below the embed gets one blank line in
 *   between, so the embed never joins a neighbouring paragraph (whitespace-only
 *   lines are blank).
 */
export function embedInsertion(text: string, from: number, to: number, embed: string): EmbedInsertion {
	const start = Math.max(0, Math.min(from, to, text.length));
	let end = Math.max(0, Math.min(Math.max(from, to), text.length));
	const hasSelection = end > start;
	if (hasSelection && end > 0 && text[end - 1] === '\n') end--; // ends on a line start: the line before is the last one touched
	const lineStart = end === 0 ? 0 : text.lastIndexOf('\n', end - 1) + 1;
	const nl = text.indexOf('\n', end);
	const lineEnd = nl === -1 ? text.length : nl;
	const hasText = (a: number, b: number): boolean => text.slice(a, b).trim() !== '';
	// the line after `lineEnd`, if there is one
	const nextText = (): boolean => {
		if (lineEnd >= text.length) return false;
		const n = text.indexOf('\n', lineEnd + 1);
		return hasText(lineEnd + 1, n === -1 ? text.length : n);
	};
	const below = nextText() ? '\n' : '';
	if (!hasSelection && !hasText(lineStart, lineEnd)) {
		let above = '';
		if (lineStart > 0) {
			const p = lineStart < 2 ? 0 : text.lastIndexOf('\n', lineStart - 2) + 1;
			if (hasText(p, lineStart - 1)) above = '\n';
		}
		return { from: lineStart, to: lineEnd, insert: above + embed + below, cursor: lineStart + above.length + embed.length };
	}
	const gap = hasText(lineStart, lineEnd) ? '\n' : '';
	const insert = `\n${gap}${embed}${below}`;
	return { from: lineEnd, to: lineEnd, insert, cursor: lineEnd + 1 + gap.length + embed.length };
}
