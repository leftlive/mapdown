// Which nodes get DOM, plus the spatial queries the pointer code needs
// (hit test, drop place, box selection). Pure; works on layout placements.

import type { Point } from "../core/types.ts";
import type { DropPlace } from "./contract.ts";
import { contains, intersects, type Rect } from "./viewport.ts";

/** Above this many visible nodes only nodes near the viewport get DOM. */
export const VIRTUALIZE_THRESHOLD = 300;
/** The DOM window reaches this many screens beyond the viewport on each side. */
export const WINDOW_MARGIN = 0.75;
/** The window is rebuilt once the viewport (grown by this many screens) leaves it. */
export const REFRESH_MARGIN = 0.15;

interface Placed {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Ids that get DOM: all when the map is small, else the ones meeting `window` plus the pinned ones. */
export function selectWindow(nodes: ReadonlyMap<string, Placed>, window: Rect, pinned: Iterable<string>): Set<string> {
	const out = new Set<string>();
	if (nodes.size <= VIRTUALIZE_THRESHOLD) {
		for (const id of nodes.keys()) out.add(id);
		return out;
	}
	for (const p of nodes.values()) if (intersects(p, window)) out.add(p.id);
	for (const id of pinned) if (nodes.has(id)) out.add(id);
	return out;
}

export function edgeInWindow(from: Point, to: Point, window: Rect): boolean {
	const x = Math.min(from.x, to.x);
	const y = Math.min(from.y, to.y);
	return intersects({ x, y, width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) }, window);
}

export function needsWindowRefresh(covered: Rect | null, view: Rect): boolean {
	return covered === null || !contains(covered, view);
}

/** The node under world point `p`, or null. */
export function hitTest(nodes: ReadonlyMap<string, Placed>, p: Point, exclude: ReadonlySet<string> | null): Placed | null {
	for (const n of nodes.values()) {
		if (p.x < n.x || p.x > n.x + n.width || p.y < n.y || p.y > n.y + n.height) continue;
		if (exclude?.has(n.id)) continue;
		return n;
	}
	return null;
}

/** Quarter rule (behaviour spec 4.1): top quarter before, bottom quarter after, middle child. */
export function dropPlace(target: Rect, p: Point, isRoot: boolean): DropPlace {
	if (isRoot) return "child";
	const rel = (p.y - target.y) / Math.max(1, target.height);
	if (rel < 0.25) return "before";
	if (rel > 0.75) return "after";
	return "child";
}

/** Ids of nodes touched by world rect `r`, in placement order. */
export function boxHits(nodes: ReadonlyMap<string, Placed>, r: Rect): string[] {
	const out: string[] = [];
	for (const n of nodes.values()) if (intersects(n, r)) out.push(n.id);
	return out;
}

/** Most nodes that get DOM at once; when zoomed far out the ones nearest the centre win. */
export const MAX_DOM_NODES = 1500;

/** Trims `ids` to `max`, keeping the pinned ids and then the nodes nearest `center`. */
export function capWindow(
	nodes: ReadonlyMap<string, Placed>,
	ids: Set<string>,
	center: Point,
	max: number,
	pinned: Iterable<string>,
): Set<string> {
	if (ids.size <= max) return ids;
	const keep = new Set<string>();
	for (const id of pinned) if (ids.has(id)) keep.add(id);
	const rest: { id: string; d: number }[] = [];
	for (const id of ids) {
		if (keep.has(id)) continue;
		const n = nodes.get(id);
		if (!n) continue;
		const dx = n.x + n.width / 2 - center.x;
		const dy = n.y + n.height / 2 - center.y;
		rest.push({ id, d: dx * dx + dy * dy });
	}
	rest.sort((a, b) => a.d - b.d);
	for (const r of rest) {
		if (keep.size >= max) break;
		keep.add(r.id);
	}
	return keep;
}

/**
 * The node that stays put on screen when a relayout changes sizes: `preferred` (the selection) while it is
 * on screen, else the on-screen node among `ids` nearest the view centre, else null.
 */
export function pickAnchor(nodes: ReadonlyMap<string, Placed>, ids: Iterable<string>, preferred: string | null, view: Rect): string | null {
	const pref = preferred === null ? undefined : nodes.get(preferred);
	if (pref && intersects(pref, view)) return preferred;
	const cx = view.x + view.width / 2;
	const cy = view.y + view.height / 2;
	let best: string | null = null;
	let bestD = Infinity;
	for (const id of ids) {
		const n = nodes.get(id);
		if (!n || !intersects(n, view)) continue;
		const dx = n.x + n.width / 2 - cx;
		const dy = n.y + n.height / 2 - cy;
		const d = dx * dx + dy * dy;
		if (d < bestD) {
			bestD = d;
			best = id;
		}
	}
	return best;
}
