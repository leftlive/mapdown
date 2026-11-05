// Node <-> file line mapping for split-view sync (behaviour spec 5.6).
//
// Lines are 0-based lines of the whole file, frontmatter included, the same
// numbering as Obsidian's Editor API. A node's line is the first line of its
// own source (children excluded). Pure: no Obsidian, no DOM.

import { nodeAtOffset } from '../core/ops.ts';
import type { ViewState } from '../core/state.ts';
import type { MapNode, ParsedDoc } from '../core/types.ts';

const startsCache = new WeakMap<ParsedDoc, number[]>();
const byIdCache = new WeakMap<ParsedDoc, Map<string, { node: MapNode; parent: MapNode | null }>>();

/** Offset where each line of the document starts. */
export function lineStarts(doc: ParsedDoc): number[] {
	const cached = startsCache.get(doc);
	if (cached) return cached;
	const text = doc.text;
	const out = [0];
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) out.push(i + 1);
	startsCache.set(doc, out);
	return out;
}

/** 0-based line holding `offset`. */
export function lineOfOffset(doc: ParsedDoc, offset: number): number {
	const starts = lineStarts(doc);
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if ((starts[mid] ?? 0) <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

function nodeIndex(doc: ParsedDoc): Map<string, { node: MapNode; parent: MapNode | null }> {
	const cached = byIdCache.get(doc);
	if (cached) return cached;
	const out = new Map<string, { node: MapNode; parent: MapNode | null }>();
	const stack: { node: MapNode; parent: MapNode | null }[] = [{ node: doc.root, parent: null }];
	for (let e = stack.pop(); e; e = stack.pop()) {
		out.set(e.node.id, e);
		for (const c of e.node.children) stack.push({ node: c, parent: e.node });
	}
	byIdCache.set(doc, out);
	return out;
}

/** The file line of a node's first line; null for the virtual root or an unknown id. */
export function nodeLine(doc: ParsedDoc, id: string): number | null {
	const node = nodeIndex(doc).get(id)?.node;
	if (!node?.source) return null;
	return lineOfOffset(doc, node.source.range.from);
}

/**
 * The node whose own lines include file line `line`. Null for frontmatter
 * lines, blank lines between blocks, and lines outside the text.
 */
export function nodeAtLine(doc: ParsedDoc, line: number): MapNode | null {
	if (!Number.isInteger(line) || line < 0) return null;
	const from = lineStarts(doc)[line];
	if (from === undefined || from < doc.bodyFrom) return null;
	return nodeAtOffset(doc, from);
}

const isClosed = (view: ViewState, id: string): boolean => view.collapsed.has(id) && !view.tempExpanded.has(id);

/**
 * What the map should select when the Markdown cursor is on `line`:
 * the node on that line, or its nearest visible ancestor when a collapsed
 * branch hides it (without expanding anything). Null means "leave the
 * selection alone": no node on the line, or the node is outside focus mode.
 */
export function cursorTarget(doc: ParsedDoc, view: ViewState, line: number): string | null {
	const node = nodeAtLine(doc, line);
	if (!node) return null;
	const index = nodeIndex(doc);
	// Path from the node up to the root.
	const path: MapNode[] = [];
	for (let n: MapNode | null = node; n; n = index.get(n.id)?.parent ?? null) path.push(n);
	path.reverse();
	let start = 0;
	if (view.focus !== null) {
		start = path.findIndex((n) => n.id === view.focus);
		if (start < 0) return null;
	}
	for (let i = start; i < path.length - 1; i++) {
		const n = path[i];
		if (n && isClosed(view, n.id)) return n.id;
	}
	return node.id;
}
