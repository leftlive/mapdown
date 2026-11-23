// Pure mind-map layout (behaviour spec section 9). Deterministic: the same
// input always gives the same output. A Layouter caches each subtree's
// measurement so a relayout only re-measures changed nodes and their ancestors.

import type { LayoutDirection, Point, Size } from "./types.ts";

export interface LayoutInput {
	id: string;
	size: Size;
	collapsed: boolean;
	children: LayoutInput[];
}

export type Side = "root" | "left" | "right" | "down";

export interface NodePlacement {
	id: string;
	/** Top-left corner. The root sits at (0, 0). */
	x: number;
	y: number;
	width: number;
	height: number;
	side: Side;
	depth: number;
	/** Index of the root child this node descends from; -1 for the root. */
	branch: number;
}

export interface LayoutEdge {
	parentId: string;
	childId: string;
	/** Midpoint of the parent's edge that faces the child. */
	from: Point;
	c1: Point;
	c2: Point;
	/** Midpoint of the child's edge that faces the parent. */
	to: Point;
	color: string;
}

export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LayoutResult {
	/** Visible nodes in depth-first order (root first, children in source order). */
	nodes: Map<string, NodePlacement>;
	/** One per visible parent-child pair, in depth-first order. */
	edges: LayoutEdge[];
	bounds: Bounds;
}

export interface Layouter {
	layout(root: LayoutInput, direction: LayoutDirection, palette: readonly string[]): LayoutResult;
	/** Non-root subtrees measured (not reused from the cache) by the last call. */
	readonly lastMeasured: number;
	/** Drops every cached measurement. */
	clear(): void;
}

/** Colours used when `strokeArray` is not set (behaviour spec section 8). */
export const DEFAULT_PALETTE: readonly string[] = [
	"#D28282", "#D4A373", "#C2B07A", "#8CB398", "#7BAEB5", "#86A2C2", "#A192B8", "#C795AB",
];

export const ROOT_H_GAP = 90;
export const ROOT_V_GAP = 20;
export const H_GAP = 48;
export const V_GAP = 14;

/** Downward (org chart) spacing (behaviour spec 9.1). */
export const DOWN_ROOT_V_GAP = 64;
export const DOWN_ROOT_H_GAP = 28;
export const DOWN_V_GAP = 44;
export const DOWN_H_GAP = 16;

/** Cached measurement of one non-root subtree. */
interface Measure {
	id: string;
	width: number;
	height: number;
	collapsed: boolean;
	/** True when measured for downward layout (span is width); false for horizontal (height). */
	down: boolean;
	/** Measurements of the laid-out children (empty when collapsed). */
	children: Measure[];
	/** Span reserved for the whole subtree (height in horizontal, width in downward). */
	subtree: number;
	/** Each child's midline relative to this node's midline. */
	offsets: number[];
	/** Generation in which the entry was last visited. */
	seen: number;
}

const NO_CHILDREN: LayoutInput[] = [];

/** Stacks blocks top to bottom with `gap` between them, centred on 0. */
function stack(blocks: readonly Measure[], gap: number, offsets: number[]): number {
	let total = 0;
	for (const b of blocks) total += b.subtree;
	if (blocks.length > 1) total += gap * (blocks.length - 1);
	let top = -total / 2;
	for (const b of blocks) {
		offsets.push(top + b.subtree / 2);
		top += b.subtree + gap;
	}
	return total;
}

export function createLayouter(): Layouter {
	const cache = new Map<string, Measure>();
	let generation = 0;
	let measured = 0;
	let visited = 0;

	function measure(input: LayoutInput, down: boolean): Measure {
		visited++;
		const cached = cache.get(input.id);
		const kids = input.collapsed ? NO_CHILDREN : input.children;
		let reuse =
			cached !== undefined &&
			cached.down === down &&
			cached.width === input.size.width &&
			cached.height === input.size.height &&
			cached.collapsed === input.collapsed &&
			cached.children.length === kids.length;
		let fresh: Measure[] | null = reuse ? null : [];
		for (let i = 0; i < kids.length; i++) {
			const m = measure(kids[i], down);
			if (fresh === null) {
				// reuse is still possible: compare against the cached child
				if (cached !== undefined && cached.children[i] === m) continue;
				reuse = false;
				fresh = cached === undefined ? [] : cached.children.slice(0, i);
			}
			fresh.push(m);
		}
		if (reuse && cached !== undefined) {
			cached.seen = generation;
			return cached;
		}
		measured++;
		const children = fresh ?? [];
		const offsets: number[] = [];
		const block = stack(children, down ? DOWN_H_GAP : V_GAP, offsets);
		const entry: Measure = {
			id: input.id,
			width: input.size.width,
			height: input.size.height,
			collapsed: input.collapsed,
			down,
			children,
			subtree: Math.max(down ? input.size.width : input.size.height, block),
			offsets,
			seen: generation,
		};
		cache.set(input.id, entry);
		return entry;
	}

	function run(root: LayoutInput, direction: LayoutDirection, palette: readonly string[]): LayoutResult {
		generation++;
		measured = 0;
		visited = 0;
		const down = direction === "down";
		const colours = palette.length > 0 ? palette : DEFAULT_PALETTE;

		const kids = root.collapsed ? NO_CHILDREN : root.children;
		const top: Measure[] = [];
		for (const k of kids) top.push(measure(k, down));

		// split the root's children into sides; branch = index in source order
		const n = top.length;
		const rightCount = direction === "right" ? n : direction === "left" ? 0 : Math.ceil(n / 2);
		const right: number[] = [];
		const left: number[] = [];
		for (let i = 0; i < n; i++) (i < rightCount ? right : left).push(i);
		if (direction === "clockwise") left.reverse();

		const nodes = new Map<string, NodePlacement>();
		const edges: LayoutEdge[] = [];
		let minX = 0;
		let minY = 0;
		let maxX = root.size.width;
		let maxY = root.size.height;

		const rootPlacement: NodePlacement = {
			id: root.id,
			x: 0,
			y: 0,
			width: root.size.width,
			height: root.size.height,
			side: "root",
			depth: 0,
			branch: -1,
		};
		nodes.set(root.id, rootPlacement);

		function place(
			m: Measure,
			parent: NodePlacement,
			mid: number,
			side: "left" | "right",
			branch: number,
			color: string,
			hGap: number,
		): void {
			const x = side === "right" ? parent.x + parent.width + hGap : parent.x - hGap - m.width;
			const y = mid - m.height / 2;
			const p: NodePlacement = {
				id: m.id,
				x,
				y,
				width: m.width,
				height: m.height,
				side,
				depth: parent.depth + 1,
				branch,
			};
			nodes.set(m.id, p);
			if (x < minX) minX = x;
			if (y < minY) minY = y;
			if (x + m.width > maxX) maxX = x + m.width;
			if (y + m.height > maxY) maxY = y + m.height;

			const pMid = parent.y + parent.height / 2;
			const fromX = side === "right" ? parent.x + parent.width : parent.x;
			const toX = side === "right" ? x : x + m.width;
			const cx = (fromX + toX) / 2;
			edges.push({
				parentId: parent.id,
				childId: m.id,
				from: { x: fromX, y: pMid },
				c1: { x: cx, y: pMid },
				c2: { x: cx, y: mid },
				to: { x: toX, y: mid },
				color,
			});

			for (let i = 0; i < m.children.length; i++) {
				place(m.children[i], p, mid + m.offsets[i], side, branch, color, H_GAP);
			}
		}

		function placeDown(
			m: Measure,
			parent: NodePlacement,
			midX: number,
			branch: number,
			color: string,
			vGap: number,
		): void {
			const x = midX - m.width / 2;
			const y = parent.y + parent.height + vGap;
			const p: NodePlacement = {
				id: m.id,
				x,
				y,
				width: m.width,
				height: m.height,
				side: "down",
				depth: parent.depth + 1,
				branch,
			};
			nodes.set(m.id, p);
			if (x < minX) minX = x;
			if (y < minY) minY = y;
			if (x + m.width > maxX) maxX = x + m.width;
			if (y + m.height > maxY) maxY = y + m.height;

			const fromX = parent.x + parent.width / 2;
			const fromY = parent.y + parent.height;
			const midY = fromY + vGap / 2;
			edges.push({
				parentId: parent.id,
				childId: m.id,
				from: { x: fromX, y: fromY },
				c1: { x: fromX, y: midY },
				c2: { x: midX, y: midY },
				to: { x: midX, y },
				color,
			});

			for (let i = 0; i < m.children.length; i++) {
				placeDown(m.children[i], p, midX + m.offsets[i], branch, color, DOWN_V_GAP);
			}
		}

		if (down) {
			const rootMidX = root.size.width / 2;
			const offsets: number[] = [];
			stack(top, DOWN_ROOT_H_GAP, offsets);
			for (let i = 0; i < n; i++) {
				placeDown(top[i], rootPlacement, rootMidX + offsets[i], i, colours[i % colours.length], DOWN_ROOT_V_GAP);
			}
		} else {
			// midline of each root child, per side; then place in source order
			const rootMid = root.size.height / 2;
			const mids = new Array<number>(n);
			for (const indices of [right, left]) {
				const offsets: number[] = [];
				stack(indices.map((i) => top[i]), ROOT_V_GAP, offsets);
				for (let j = 0; j < indices.length; j++) mids[indices[j]] = rootMid + offsets[j];
			}
			for (let i = 0; i < n; i++) {
				const side = i < rightCount ? "right" : "left";
				place(top[i], rootPlacement, mids[i], side, i, colours[i % colours.length], ROOT_H_GAP);
			}
		}

		// forget nodes that have left the tree once they dominate the cache
		if (cache.size > visited * 2 + 64) {
			for (const [id, m] of cache) if (m.seen !== generation) cache.delete(id);
		}

		return {
			nodes,
			edges,
			bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
		};
	}

	return {
		layout: run,
		get lastMeasured() {
			return measured;
		},
		clear() {
			cache.clear();
		},
	};
}

/** Full layout without a persistent cache. */
/**
 * Side and colour of the branch that root child `topIndex` (of `n`) starts,
 * as the full layout gives them. Focus mode lays a subtree out on this side
 * in this colour, so it keeps the look it has in the whole map (spec 5.3).
 */
export function branchLook(
	topIndex: number,
	n: number,
	direction: LayoutDirection,
	palette: readonly string[],
): { side: "left" | "right" | "down"; color: string } {
	const colours = palette.length > 0 ? palette : DEFAULT_PALETTE;
	const color = colours[topIndex % colours.length];
	if (direction === "down") return { side: "down", color };
	const rightCount = direction === "right" ? n : direction === "left" ? 0 : Math.ceil(n / 2);
	return { side: topIndex < rightCount ? "right" : "left", color };
}

export function layout(root: LayoutInput, direction: LayoutDirection, palette: readonly string[]): LayoutResult {
	return createLayouter().layout(root, direction, palette);
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * SVG path `d` for one edge (behaviour spec 9 and 9.1). Shared between the
 * screen renderer and SVG/PNG/JPEG/PDF/HTML export so both draw identical paths.
 */
export function edgePath(e: LayoutEdge): string {
	return `M ${r2(e.from.x)} ${r2(e.from.y)} C ${r2(e.c1.x)} ${r2(e.c1.y)}, ${r2(e.c2.x)} ${r2(e.c2.y)}, ${r2(e.to.x)} ${r2(e.to.y)}`;
}
