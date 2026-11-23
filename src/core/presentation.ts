// Presentation mode (behaviour spec 5.13). Pure: the route through a map, the
// "current node" state and how it moves, what each node looks like and what
// the camera frames. The view (src/view/presentation.ts) draws the result.
//
// The route is the preorder list of nodes that have visible children (the
// root always first); leaves never take a step of their own. A level limit k
// keeps only nodes of depth < k (the root is depth 0). After the route comes
// the overview, as the ending.

import type { MapNode } from './types.ts';

/** Camera zoom limits of spec 5.13. */
export const PRESENT_MAX_ZOOM = 2;
export const OVERVIEW_MAX_ZOOM = 1.6;
export const PRESENT_MIN_ZOOM = 0.25;
/** A horizontal swipe shorter than this (screen pixels) does not turn the page. */
export const SWIPE_MIN = 48;
/** Longest breadcrumb segment, in characters, before it is cut with "…". */
export const CRUMB_MAX_CHARS = 24;

/** Parent, depth and node of every node of a tree. */
export interface TreeIndex {
	root: string;
	node: ReadonlyMap<string, MapNode>;
	parent: ReadonlyMap<string, string | null>;
	depth: ReadonlyMap<string, number>;
}

export function indexTree(root: MapNode): TreeIndex {
	const node = new Map<string, MapNode>();
	const parent = new Map<string, string | null>();
	const depth = new Map<string, number>();
	const stack: { n: MapNode; p: string | null; d: number }[] = [{ n: root, p: null, d: 0 }];
	while (stack.length > 0) {
		const { n, p, d } = stack.pop() as { n: MapNode; p: string | null; d: number };
		node.set(n.id, n);
		parent.set(n.id, p);
		depth.set(n.id, d);
		for (const c of n.children) stack.push({ n: c, p: n.id, d: d + 1 });
	}
	return { root: root.id, node, parent, depth };
}

/** The ids from the root down to `id` (empty for an unknown id). */
export function pathTo(index: TreeIndex, id: string): string[] {
	if (!index.node.has(id)) return [];
	const out: string[] = [];
	for (let at: string | null | undefined = id; at != null; at = index.parent.get(at)) out.push(at);
	return out.reverse();
}

/** Drawn under the fold state `hidden` (collapsed ids): no ancestor is collapsed. */
export function isShown(index: TreeIndex, hidden: ReadonlySet<string>, id: string): boolean {
	if (!index.node.has(id)) return false;
	for (let at = index.parent.get(id); at != null; at = index.parent.get(at)) if (hidden.has(at)) return false;
	return true;
}

/** The children of `id` that are drawn (none when it is collapsed). */
export function visibleChildren(index: TreeIndex, hidden: ReadonlySet<string>, id: string): string[] {
	const n = index.node.get(id);
	if (!n || hidden.has(id)) return [];
	return n.children.map((c) => c.id);
}

/**
 * The default route (spec 5.13): in text order (preorder; layout direction plays no part), every
 * node with visible children and a depth below `limit` (null: no limit). The root is always the
 * first step, even without children.
 */
export function presentRoute(root: MapNode, hidden: ReadonlySet<string>, limit: number | null): string[] {
	const out: string[] = [root.id];
	const stack: { n: MapNode; d: number }[] = [];
	if (!hidden.has(root.id)) for (let i = root.children.length - 1; i >= 0; i--) stack.push({ n: root.children[i], d: 1 });
	while (stack.length > 0) {
		const { n, d } = stack.pop() as { n: MapNode; d: number };
		if (n.children.length === 0 || hidden.has(n.id)) continue;
		if (limit === null || d < limit) out.push(n.id);
		for (let i = n.children.length - 1; i >= 0; i--) stack.push({ n: n.children[i], d: d + 1 });
	}
	return out;
}

/** Step (0-based) of `id` on the route: its own, or that of its nearest ancestor on the route; 0 when none is. */
export function stepOf(route: readonly string[], index: TreeIndex, id: string): number {
	for (let at: string | null | undefined = id; at != null; at = index.parent.get(at)) {
		const i = route.indexOf(at);
		if (i >= 0) return i;
	}
	return 0;
}

/**
 * Where the presentation stands. `leaf`: a clicked leaf, ringed, shown from its parent's step
 * (`current`). `overview`: off, opened with O (`open`), or the ending after the route (`end`).
 */
export interface PresentState {
	current: string;
	leaf: string | null;
	overview: 'off' | 'open' | 'end';
}

export type PresentMove = 'next' | 'prev' | 'up' | 'first' | 'last' | 'overview';
export type PresentAction = PresentMove | 'exit';

/** A click on `id` (spec 5.13 "点击跳转"): a node with visible children becomes current; a leaf rings itself from its parent's step. */
export function jumpTo(index: TreeIndex, hidden: ReadonlySet<string>, id: string): PresentState {
	const parent = index.parent.get(id) ?? null;
	if (visibleChildren(index, hidden, id).length > 0 || parent === null) return { current: id, leaf: null, overview: 'off' };
	return { current: parent, leaf: id, overview: 'off' };
}

/** A key, button or swipe (spec 5.13 "操作" and "全图"). */
export function presentStep(s: PresentState, move: PresentMove, route: readonly string[], index: TreeIndex): PresentState {
	const last = route[route.length - 1] ?? index.root;
	switch (move) {
		case 'first':
			return { current: route[0] ?? index.root, leaf: null, overview: 'off' };
		case 'last':
			return { current: last, leaf: null, overview: 'end' };
		case 'overview':
			return s.overview === 'off' ? { ...s, overview: 'open' } : { ...s, overview: 'off' };
		case 'up': {
			if (s.overview !== 'off') return s;
			// a ringed leaf is shown from its parent's step already: going up only drops the ring
			if (s.leaf !== null) return { ...s, leaf: null };
			const parent = index.parent.get(s.current) ?? null;
			return parent === null ? s : { current: parent, leaf: null, overview: 'off' };
		}
		case 'next': {
			if (s.overview === 'end') return s;
			const i = stepOf(route, index, s.current);
			if (i + 1 < route.length) return { current: route[i + 1], leaf: null, overview: 'off' };
			return { current: last, leaf: null, overview: 'end' };
		}
		case 'prev': {
			if (s.overview === 'end') return { current: last, leaf: null, overview: 'off' };
			const i = stepOf(route, index, s.current);
			if (i > 0) return { current: route[i - 1], leaf: null, overview: 'off' };
			return s.overview === 'open' ? { ...s, overview: 'off' } : s;
		}
	}
}

/** The step shown in the progress (0-based), or null on the overview. */
export function shownStep(s: PresentState, route: readonly string[], index: TreeIndex): number | null {
	return s.overview === 'off' ? stepOf(route, index, s.current) : null;
}

/**
 * After the map changed (text edited elsewhere, a fold toggled): the current node stays when it is
 * still there and drawn, else the nearest of its former ancestors (`path`, root first) that is,
 * else the root. A ringed leaf stays only while it is still a drawn child of the current node.
 */
export function relocate(s: PresentState, index: TreeIndex, hidden: ReadonlySet<string>, path: readonly string[]): PresentState {
	let current = index.root;
	const candidates = [...path, s.current];
	for (let i = candidates.length - 1; i >= 0; i--) {
		if (isShown(index, hidden, candidates[i])) {
			current = candidates[i];
			break;
		}
	}
	const leaf = s.leaf !== null && current === s.current && index.parent.get(s.leaf) === current && visibleChildren(index, hidden, current).includes(s.leaf) ? s.leaf : null;
	return { current, leaf, overview: s.overview };
}

/** How nodes and edges look (an edge as its child): `normal` drawn normally (null: all), the rest faded; rings on `current` and `leaf`. */
export interface PresentLook {
	normal: ReadonlySet<string> | null;
	current: string | null;
	leaf: string | null;
}

/** The current node, its ancestors and its visible children are normal; the overview shows everything without rings. */
export function presentLook(s: PresentState, index: TreeIndex, hidden: ReadonlySet<string>): PresentLook {
	if (s.overview !== 'off') return { normal: null, current: null, leaf: null };
	const normal = new Set([...pathTo(index, s.current), ...visibleChildren(index, hidden, s.current)]);
	return { normal, current: s.current, leaf: s.leaf };
}

/** What the camera frames: node ids (null: the whole map) and the zoom limits. */
export interface PresentFrame {
	camera: readonly string[] | null;
	maxZoom: number;
	minZoom: number;
}

/** The current node, its visible children and its parent; the overview frames everything, at most 160%. */
export function presentFrame(s: PresentState, index: TreeIndex, hidden: ReadonlySet<string>): PresentFrame {
	if (s.overview !== 'off') return { camera: null, maxZoom: OVERVIEW_MAX_ZOOM, minZoom: PRESENT_MIN_ZOOM };
	const ids = [s.current, ...visibleChildren(index, hidden, s.current)];
	const parent = index.parent.get(s.current);
	if (parent != null) ids.push(parent);
	return { camera: ids, maxZoom: PRESENT_MAX_ZOOM, minZoom: PRESENT_MIN_ZOOM };
}

/** What a key does while presenting (spec 5.13); null for every other key and for keys with a modifier. */
export function presentKeyAction(key: string, mods: { mod: boolean; alt: boolean; shift: boolean }): PresentAction | null {
	if (mods.mod || mods.alt || mods.shift) return null;
	switch (key) {
		case 'ArrowRight':
		case 'ArrowDown':
		case ' ':
		case 'Enter':
		case 'PageDown':
			return 'next';
		case 'ArrowLeft':
		case 'Backspace':
		case 'PageUp':
			return 'prev';
		case 'ArrowUp':
			return 'up';
		case 'Home':
			return 'first';
		case 'End':
			return 'last';
		case 'o':
		case 'O':
			return 'overview';
		case 'Escape':
			return 'exit';
		default:
			return null;
	}
}

/** A one-finger swipe of `dx`, `dy` screen pixels: left is the next step, right the previous; short or mostly vertical ones nothing. */
export function swipeAction(dx: number, dy: number): 'next' | 'prev' | null {
	if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < 1.5 * Math.abs(dy)) return null;
	return dx < 0 ? 'next' : 'prev';
}

/**
 * A node's text as a breadcrumb segment: plain text (Markdown marks dropped; images, embeds and
 * formulas become "…"), whitespace folded, at most `max` characters, cut with "…".
 */
export function plainLabel(text: string, max = CRUMB_MAX_CHARS): string {
	let s = text
		.replace(/^\[[ xX\-/>]\]\s+/, '')
		.replace(/!\[\[[^\]]*\]\]/g, '…')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, '…')
		.replace(/\$\$[\s\S]*?\$\$/g, '…')
		.replace(/\$[^$\n]+\$/g, '…')
		.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
		.replace(/\[\[([^\]]*)\]\]/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]+>/g, ' ')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/(\*\*|__|~~|==)/g, '')
		.replace(/(^|[^\w*])[*_]([^*_\s][^*_]*)[*_](?![\w*])/g, '$1$2')
		.replace(/\s+/g, ' ')
		.trim();
	const chars = Array.from(s);
	if (chars.length > max) s = chars.slice(0, max).join('') + '…';
	return s;
}

/**
 * Which breadcrumb segments fit in `max` pixels (spec 5.13): all when they do; else the first, an
 * ellipsis (-1) and as many of the last segments as fit (at least the last one).
 */
export function fitCrumbs(widths: readonly number[], max: number, ellipsis: number): number[] {
	const all = widths.map((_, i) => i);
	const total = widths.reduce((a, b) => a + b, 0);
	if (widths.length <= 2 || total <= max) return all;
	let used = widths[0] + ellipsis + widths[widths.length - 1];
	const tail = [widths.length - 1];
	for (let i = widths.length - 2; i >= 1; i--) {
		if (used + widths[i] > max) break;
		used += widths[i];
		tail.unshift(i);
	}
	return tail[0] === 1 ? all : [0, -1, ...tail];
}
