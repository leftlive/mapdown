// Toggling a quote (behaviour spec 5.6 "引用的样式和切换"): which nodes can be
// quotes, and the text with `> ` added to or one level taken off every line.
// Pure, so tests run it in Node; `setQuote` in ops.ts writes the same change
// into the Markdown line by line (block ids and indentation stay untouched).

import { isQuoteLines } from './outline.ts';
import { isBlockText } from './serialize.ts';
import { taskOf } from './tasks.ts';
import type { MapNode } from './types.ts';

/** First line of a callout: `> [!type]`. Callouts are skipped by the toggle. */
const CALLOUT = /^>[ \t]*\[!/;

/** True when every line of a non-empty text starts with `>` (a quote or callout). */
export const isQuote = isQuoteLines;

/**
 * Plain paragraphs and non-task list items with text; headings, tasks, callouts, code, tables, the root and empty nodes
 * cannot be toggled, nor summaries and framed nodes (a quote would turn their comment into text, spec 5.15).
 */
export function canToggleQuote(node: Pick<MapNode, 'kind' | 'text' | 'source' | 'summary' | 'frame'>, root?: object): boolean {
	if (node === root || !node.source || node.summary || node.frame) return false;
	if (node.kind !== 'paragraph' && node.kind !== 'list') return false;
	if (node.text.trim() === '' || isBlockText(node.text)) return false;
	if (taskOf(node.text, node.kind) || CALLOUT.test(node.text)) return false;
	return true;
}

/** One line with a level of quote added: `> ` in front (just `>` for an empty line). */
export const addQuoteLine = (line: string): string => (line === '' ? '>' : `> ${line}`);

/** One line with a level of quote taken off: the first `>` and the space after it. */
export const removeQuoteLine = (line: string): string => (line.startsWith('>') ? line.slice(line.startsWith('> ') ? 2 : 1) : line);

/** The text after adding (`remove` false) or removing a level of quote on every line. */
export function quoteText(text: string, remove: boolean): string {
	return text.split('\n').map(remove ? removeQuoteLine : addQuoteLine).join('\n');
}

export interface QuotePlan {
	/** The nodes that change, in the order given. */
	targets: MapNode[];
	/** True when every toggleable node already was a quote: a level comes off. Otherwise a level goes on the nodes that are no quote yet. */
	remove: boolean;
	/** Nodes that cannot be toggled. */
	skipped: number;
}

/** What "toggle quote" does with `nodes` (spec 5.6). */
export function planQuote(nodes: readonly MapNode[], root?: object): QuotePlan {
	const ok = nodes.filter((n) => canToggleQuote(n, root));
	const remove = ok.length > 0 && ok.every((n) => isQuote(n.text));
	return { targets: remove ? ok : ok.filter((n) => !isQuote(n.text)), remove, skipped: nodes.length - ok.length };
}
