// Pure logic of the search bar (behaviour spec 5.4): which nodes match, which
// match comes next, and which collapsed branches open for the current match.
// No DOM; the bar itself is src/view/search.ts.

import { hidingAncestors, setTempExpanded, type ViewState } from '../core/state.ts';
import type { MapNode } from '../core/types.ts';

/** Lower case, inline markup and link brackets dropped, whitespace (and line breaks) collapsed. */
export function normalizeSearchText(text: string): string {
	return text
		.replace(/<br\s*\/?>/gi, ' ')
		.replace(/\*\*|__|==|~~|`|\[\[|\]\]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.toLocaleLowerCase();
}

export interface MatchOptions {
	/** Text shown for the root (a virtual root shows the file name). */
	rootText?: string;
	/** Search only this subtree (focus mode); unknown ids search the whole tree. */
	scopeId?: string | null;
}

function findNode(tree: MapNode, id: string): MapNode | null {
	const stack = [tree];
	while (stack.length > 0) {
		const node = stack.pop() as MapNode;
		if (node.id === id) return node;
		for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
	}
	return null;
}

/**
 * Ids of the nodes whose text contains `query`, in document order. Nodes
 * inside collapsed branches count too (navigating to them opens the branch).
 */
export function findMatches(tree: MapNode, query: string, opts: MatchOptions = {}): string[] {
	const q = normalizeSearchText(query);
	if (q === '') return [];
	const start = (opts.scopeId ? findNode(tree, opts.scopeId) : null) ?? tree;
	const out: string[] = [];
	const stack = [start];
	while (stack.length > 0) {
		const node = stack.pop() as MapNode;
		const text = node === tree && opts.rootText !== undefined ? opts.rootText : node.text;
		if (normalizeSearchText(text).includes(q)) out.push(node.id);
		for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
	}
	return out;
}

/** The match after (`dir` 1) or before (-1) `current`, wrapping; with no current, the first or last. */
export function stepMatch(matches: readonly string[], current: string | null, dir: 1 | -1): string | null {
	if (matches.length === 0) return null;
	const at = current === null ? -1 : matches.indexOf(current);
	if (at < 0) return (dir > 0 ? matches[0] : matches[matches.length - 1]) ?? null;
	return matches[(at + dir + matches.length) % matches.length] ?? null;
}

/**
 * Opens the collapsed ancestors of `id` for now (ViewState.tempExpanded) and
 * folds back branches opened for an earlier match. The collapsed set, which
 * mindmark-state is written from, stays as it is.
 */
export function revealMatch(tree: MapNode, view: ViewState, id: string): ViewState {
	const open = hidingAncestors(tree, view, id);
	const cur = view.tempExpanded;
	if (open.length === cur.size && open.every((x) => cur.has(x))) return view;
	return setTempExpanded(view, open);
}
