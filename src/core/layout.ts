// Pure mind-map layout (behaviour spec section 9). Deterministic: the same
// input always gives the same output. A Layouter caches each subtree's
// measurement so a relayout only re-measures changed nodes and their ancestors.

import { planRoot, planSummaries, type BranchSide, type SummaryCover } from "./summary.ts";
import type { LayoutDirection, Point, Size, SummaryMark } from "./types.ts";

export interface LayoutInput {
	id: string;
	size: Size;
	collapsed: boolean;
	children: LayoutInput[];
	/** The node's summary comment (spec 5.15). Whether it holds is decided from its siblings; one that does not is an ordinary node. */
	summary?: SummaryMark;
	/** The node has a frame; `label` is the measured size of its label pill (absent without a label). Ignored on the root. */
	frame?: { label?: Size };
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
	/** A summary that holds (spec 5.15): drawn outside its brace, with no edge from its parent. */
	summary?: true;
	/** In a summary's subtree (the summary included): its border and edges use the neutral colour. */
	muted?: true;
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
	/** Inside a summary's subtree: drawn in the neutral colour instead of `color`. */
	muted?: true;
}

export interface Bounds {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * The brace of one summary (spec 5.15). Horizontal layouts: `from`/`to` are
 * y values (top, bottom) and `base`/`tip` x values; downward: `from`/`to`
 * are x values (left, right) and `base`/`tip` y values. The brace runs along
 * `base` from `from` to `to`, with its point at `tip` halfway; `tip` is on the
 * side away from the covered nodes (right of `base` on the right side, left on
 * the left, below in downward layout).
 */
export interface SummaryBrace {
	summaryId: string;
	parentId: string;
	/** Covered siblings in source order. */
	coveredIds: string[];
	side: "left" | "right" | "down";
	from: number;
	to: number;
	base: number;
	tip: number;
}

/** A frame (spec 5.15): rounded rectangle around a node and its visible subtree. */
export interface FrameBox {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	side: "left" | "right" | "down";
	/** Branch of the framed node (index of its root child) and the branch colour the frame uses. */
	branch: number;
	color: string;
	/** The label pill: on the top edge, at the end towards the parent (top left in downward layout). */
	label: Bounds | null;
}

export interface LayoutResult {
	/** Visible nodes in depth-first order (root first, children in source order). */
	nodes: Map<string, NodePlacement>;
	/** One per visible parent-child pair, in depth-first order; none to a summary that holds. */
	edges: LayoutEdge[];
	/** One per summary that holds, in depth-first order. */
	braces: SummaryBrace[];
	/** One per visible framed node, in depth-first order (outer frames before inner ones). */
	frames: FrameBox[];
	/** Encloses nodes, braces, frames and labels. */
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

/** Summary geometry (spec 5.15): outermost edge of the covered subtrees to the brace. */
export const BRACE_GAP = 16;
/** Brace base line to its point (the mockup's brace: two 8 px curves). */
export const BRACE_DEPTH = 16;
/** Brace point to the summary node. */
export const SUMMARY_GAP = 24;
/** Frame padding around the node and its subtree, and corner radius. */
export const FRAME_PAD = 10;
export const FRAME_RADIUS = 10;
/** Label pill distance from the frame's corner along the top edge. */
export const LABEL_INSET = 12;

/** Cached measurement of one non-root subtree. */
interface Measure {
	id: string;
	width: number;
	height: number;
	collapsed: boolean;
	/** True when measured for downward layout (stacking along x); false for horizontal (along y). */
	down: boolean;
	/** Summary comment: -1 none, 0 the default range, else the count. */
	sum: number;
	frame: boolean;
	/** Label pill size, 0 without a label. */
	lw: number;
	lh: number;
	/** Measurements of the laid-out children (empty when collapsed). */
	children: Measure[];
	/** Footprint along the stacking axis: above (before) and below (after) the node's midline. */
	before: number;
	after: number;
	/** Footprint along the growth axis, from the node's near edge (the one facing the parent). */
	reach: number;
	/** Each child's midline relative to this node's midline. */
	offsets: number[];
	/** Each child's near edge along the growth axis, beyond the children's common near edge (summaries only). */
	shifts: number[];
	/** Per child: a summary that holds. Empty when there is none. */
	held: boolean[];
	braces: BraceRel[];
	/** Frame edges: above and below the midline (label overhang not included), and the far edge from the near edge. */
	fb: number;
	fa: number;
	fu: number;
	/** Generation in which the entry was last visited. */
	seen: number;
}

/** A brace relative to its parent: stacking span from the parent's midline, base from the children's near edge. */
interface BraceRel {
	summary: number;
	first: number;
	last: number;
	from: number;
	to: number;
	base: number;
}

interface Block {
	before: number;
	after: number;
	/** Children in display order. */
	members: number[];
	/** Index of the summary for a group, else -1. */
	summary: number;
	/** Covered span and the deepest reach of the covered subtrees (groups only). */
	span: number;
	reach: number;
}

const NO_CHILDREN: LayoutInput[] = [];
const NO_HELD: boolean[] = [];
const NO_BRACES: BraceRel[] = [];

/**
 * Stack `kids` (indices in display `order`) along the stacking axis with
 * `gap` between them, centred on 0. A summary that holds (`covers`) is not
 * stacked itself: it joins its covered siblings in one block, beside them
 * past the brace and centred on them (spec 5.15). Fills `offsets` and
 * `shifts` (indexed like `kids`) and `braces`; returns the stack's total span
 * and its reach along the growth axis from the children's near edge.
 */
function arrange(
	kids: readonly Measure[],
	order: readonly number[],
	covers: readonly (SummaryCover | null)[] | null,
	gap: number,
	offsets: number[],
	shifts: number[],
	braces: BraceRel[],
): { total: number; reach: number } {
	const blocks: Block[] = [];
	let coveredBy: Int32Array | null = null;
	if (covers) {
		coveredBy = new Int32Array(kids.length).fill(-1);
		for (const k of order) {
			const c = covers[k];
			if (c) for (let j = c.first; j <= c.last; j++) coveredBy[j] = k;
		}
	}
	for (const k of order) {
		const m = kids[k];
		if (!m) continue;
		if (covers?.[k]) continue;
		const s = coveredBy ? (coveredBy[k] ?? -1) : -1;
		const last = blocks[blocks.length - 1];
		if (s >= 0 && last && last.summary === s) last.members.push(k);
		else blocks.push({ before: m.before, after: m.after, members: [k], summary: s, span: 0, reach: 0 });
	}
	let total = 0;
	for (const b of blocks) {
		if (b.summary >= 0) {
			let span = gap * (b.members.length - 1);
			let reach = 0;
			for (const k of b.members) {
				const m = kids[k];
				if (!m) continue;
				span += m.before + m.after;
				if (m.reach > reach) reach = m.reach;
			}
			const sm = kids[b.summary];
			b.span = span;
			b.reach = reach;
			b.before = Math.max(span / 2, sm?.before ?? 0);
			b.after = Math.max(span / 2, sm?.after ?? 0);
		}
		total += b.before + b.after;
	}
	if (blocks.length > 1) total += gap * (blocks.length - 1);
	let top = -total / 2;
	let reach = 0;
	for (const b of blocks) {
		const anchor = top + b.before;
		if (b.summary < 0) {
			const k = b.members[0] ?? 0;
			offsets[k] = anchor;
			shifts[k] = 0;
			const r = kids[k]?.reach ?? 0;
			if (r > reach) reach = r;
		} else {
			let y = anchor - b.span / 2;
			for (const k of b.members) {
				const m = kids[k];
				if (!m) continue;
				offsets[k] = y + m.before;
				shifts[k] = 0;
				y += m.before + m.after + gap;
			}
			const base = b.reach + BRACE_GAP;
			const shift = base + BRACE_DEPTH + SUMMARY_GAP;
			offsets[b.summary] = anchor;
			shifts[b.summary] = shift;
			const r = shift + (kids[b.summary]?.reach ?? 0);
			if (r > reach) reach = r;
			const c = covers?.[b.summary];
			braces.push({
				summary: b.summary,
				first: c?.first ?? 0,
				last: c?.last ?? 0,
				from: anchor - b.span / 2,
				to: anchor + b.span / 2,
				base,
			});
		}
		top += b.before + b.after + gap;
	}
	return { total, reach };
}

const markOf = (m: Measure): SummaryMark | undefined => (m.sum < 0 ? undefined : m.sum === 0 ? {} : { count: m.sum });

const sumOf = (input: LayoutInput): number => (input.summary ? (input.summary.count ?? 0) : -1);

/** Covers among siblings with these summary values (-1 none), or null when none of them is a summary. */
function coversOf(kids: readonly Measure[]): (SummaryCover | null)[] | null {
	let any = false;
	for (let i = 1; i < kids.length; i++) if ((kids[i]?.sum ?? -1) >= 0) any = true;
	if (!any) return null;
	const plan = planSummaries(kids.map(markOf));
	return plan.covers.some((c) => c !== null) ? plan.covers : null;
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
		const sum = sumOf(input);
		const frame = input.frame !== undefined;
		const lw = input.frame?.label?.width ?? 0;
		const lh = input.frame?.label?.height ?? 0;
		let reuse =
			cached !== undefined &&
			cached.down === down &&
			cached.width === input.size.width &&
			cached.height === input.size.height &&
			cached.collapsed === input.collapsed &&
			cached.sum === sum &&
			cached.frame === frame &&
			cached.lw === lw &&
			cached.lh === lh &&
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
		const offsets: number[] = new Array<number>(children.length);
		const shifts: number[] = new Array<number>(children.length);
		const covers = coversOf(children);
		const braces: BraceRel[] = covers ? [] : NO_BRACES;
		const order: number[] = [];
		for (let i = 0; i < children.length; i++) order.push(i);
		const arranged = arrange(children, order, covers, down ? DOWN_H_GAP : V_GAP, offsets, shifts, braces);
		const span = down ? input.size.width : input.size.height;
		const depth = down ? input.size.height : input.size.width;
		const half = Math.max(span, arranged.total) / 2;
		let before = half;
		let after = half;
		let reach = children.length > 0 ? Math.max(depth, depth + (down ? DOWN_V_GAP : H_GAP) + arranged.reach) : depth;
		let fb = 0;
		let fa = 0;
		let fu = 0;
		if (frame) {
			const minWidth = lw > 0 ? lw + 2 * LABEL_INSET : 0;
			if (down) {
				fb = before + FRAME_PAD;
				fa = Math.max(after + FRAME_PAD, minWidth - fb);
				fu = reach + FRAME_PAD;
				before = fb;
				after = fa;
			} else {
				fb = before + FRAME_PAD + lh / 2;
				fa = after + FRAME_PAD;
				fu = Math.max(reach + FRAME_PAD, minWidth - FRAME_PAD);
				before = fb + lh / 2;
				after = fa;
			}
			reach = fu;
		}
		const entry: Measure = {
			id: input.id,
			width: input.size.width,
			height: input.size.height,
			collapsed: input.collapsed,
			down,
			sum,
			frame,
			lw,
			lh,
			children,
			before,
			after,
			reach,
			offsets,
			shifts,
			held: covers ? covers.map((c) => c !== null) : NO_HELD,
			braces,
			fb,
			fa,
			fu,
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
		const plan = planRoot(top.map(markOf), direction);
		const covers = plan.covers.some((c) => c !== null) ? plan.covers : null;
		const sides = plan.sides;

		const nodes = new Map<string, NodePlacement>();
		const edges: LayoutEdge[] = [];
		const braces: SummaryBrace[] = [];
		const frames: FrameBox[] = [];
		let minX = 0;
		let minY = 0;
		let maxX = root.size.width;
		let maxY = root.size.height;
		const extend = (x0: number, y0: number, x1: number, y1: number): void => {
			if (x0 < minX) minX = x0;
			if (y0 < minY) minY = y0;
			if (x1 > maxX) maxX = x1;
			if (y1 > maxY) maxY = y1;
		};

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

		/** Braces of `rels` under `parent`, whose children's near edge is at `near` and midline at `mid`. */
		function addBraces(rels: readonly BraceRel[], kidsOf: readonly Measure[], parentId: string, side: BranchSide, near: number, mid: number): void {
			const sign = side === "left" ? -1 : 1;
			for (const b of rels) {
				const base = near + sign * b.base;
				const tip = base + sign * BRACE_DEPTH;
				const coveredIds: string[] = [];
				for (let i = b.first; i <= b.last; i++) coveredIds.push(kidsOf[i]?.id ?? "");
				const from = mid + b.from;
				const to = mid + b.to;
				braces.push({ summaryId: kidsOf[b.summary]?.id ?? "", parentId, coveredIds, side, from, to, base, tip });
				const lo = Math.min(base, tip);
				const hi = Math.max(base, tip);
				if (side === "down") extend(from, lo, to, hi);
				else extend(lo, from, hi, to);
			}
		}

		function addFrame(m: Measure, p: NodePlacement, side: BranchSide, branch: number, color: string): void {
			let x: number;
			let y: number;
			let w: number;
			let h: number;
			let lx: number;
			if (side === "down") {
				x = p.x + p.width / 2 - m.fb;
				w = m.fb + m.fa;
				const topPad = FRAME_PAD + m.lh / 2;
				y = p.y - topPad;
				h = topPad + m.fu;
				lx = x + LABEL_INSET;
			} else {
				y = p.y + p.height / 2 - m.fb;
				h = m.fb + m.fa;
				w = m.fu + FRAME_PAD;
				x = side === "right" ? p.x - FRAME_PAD : p.x + p.width + FRAME_PAD - w;
				lx = side === "right" ? x + LABEL_INSET : x + w - LABEL_INSET - m.lw;
			}
			const label = m.lw > 0 ? { x: lx, y: y - m.lh / 2, width: m.lw, height: m.lh } : null;
			frames.push({ id: m.id, x, y, width: w, height: h, side, branch, color, label });
			extend(x, y, x + w, y + h);
			if (label) extend(label.x, label.y, label.x + label.width, label.y + label.height);
		}

		/**
		 * Place `m` and its subtree. `mid` is its midline on the stacking axis
		 * (y, or x in downward layout); its near edge is `gap + shift` past the
		 * parent's facing edge.
		 */
		function place(
			m: Measure,
			parent: NodePlacement,
			mid: number,
			side: BranchSide,
			branch: number,
			color: string,
			gap: number,
			shift: number,
			muted: boolean,
			summary: boolean,
		): void {
			const isDown = side === "down";
			const x = isDown
				? mid - m.width / 2
				: side === "right"
					? parent.x + parent.width + gap + shift
					: parent.x - gap - shift - m.width;
			const y = isDown ? parent.y + parent.height + gap + shift : mid - m.height / 2;
			const p: NodePlacement = { id: m.id, x, y, width: m.width, height: m.height, side, depth: parent.depth + 1, branch };
			if (summary) p.summary = true;
			if (muted) p.muted = true;
			nodes.set(m.id, p);
			extend(x, y, x + m.width, y + m.height);

			if (!summary) {
				let from: Point;
				let c1: Point;
				let c2: Point;
				let to: Point;
				if (isDown) {
					from = { x: parent.x + parent.width / 2, y: parent.y + parent.height };
					const midY = from.y + gap / 2;
					c1 = { x: from.x, y: midY };
					c2 = { x: mid, y: midY };
					to = { x: mid, y };
				} else {
					from = { x: side === "right" ? parent.x + parent.width : parent.x, y: parent.y + parent.height / 2 };
					to = { x: side === "right" ? x : x + m.width, y: mid };
					const cx = (from.x + to.x) / 2;
					c1 = { x: cx, y: from.y };
					c2 = { x: cx, y: mid };
				}
				const e: LayoutEdge = { parentId: parent.id, childId: m.id, from, c1, c2, to, color };
				if (muted) e.muted = true;
				edges.push(e);
			}
			if (m.frame) addFrame(m, p, side, branch, color);
			const kidGap = isDown ? DOWN_V_GAP : H_GAP;
			if (m.braces.length > 0) {
				const near = isDown ? y + m.height + kidGap : side === "right" ? x + m.width + kidGap : x - kidGap;
				addBraces(m.braces, m.children, m.id, side, near, mid);
			}
			for (let i = 0; i < m.children.length; i++) {
				const held = m.held[i] === true;
				place(m.children[i], p, mid + m.offsets[i], side, branch, color, kidGap, m.shifts[i] ?? 0, muted || held, held);
			}
		}

		// midline of each root child, per side; then place in source order
		const offsets = new Array<number>(n);
		const shifts = new Array<number>(n);
		const rootMid = down ? root.size.width / 2 : root.size.height / 2;
		const groups: [BranchSide, number[]][] = down ? [["down", []]] : [["right", []], ["left", []]];
		for (let i = 0; i < n; i++) (sides[i] === "left" ? groups[1] : groups[0])?.[1].push(i);
		if (direction === "clockwise") groups[1]?.[1].reverse();
		const rels: BraceRel[][] = groups.map(([, order]) => {
			const list: BraceRel[] = [];
			arrange(top, order, covers, down ? DOWN_ROOT_H_GAP : ROOT_V_GAP, offsets, shifts, list);
			return list;
		});
		for (let i = 0; i < n; i++) {
			const held = covers?.[i] != null;
			const side = sides[i] ?? "right";
			place(top[i], rootPlacement, rootMid + offsets[i], side, i, colours[(plan.colours[i] ?? i) % colours.length], down ? DOWN_ROOT_V_GAP : ROOT_H_GAP, shifts[i] ?? 0, held, held);
		}
		groups.forEach(([side], g) => {
			const near = down ? root.size.height + DOWN_ROOT_V_GAP : side === "right" ? root.size.width + ROOT_H_GAP : -ROOT_H_GAP;
			addBraces(rels[g] ?? [], top, root.id, side, near, rootMid);
		});

		// forget nodes that have left the tree once they dominate the cache
		if (cache.size > visited * 2 + 64) {
			for (const [id, m] of cache) if (m.seen !== generation) cache.delete(id);
		}

		return {
			nodes,
			edges,
			braces,
			frames,
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

/**
 * Side and colour of the branch that root child `topIndex` (of `n`) starts,
 * as the full layout gives them. Focus mode lays a subtree out on this side
 * in this colour, so it keeps the look it has in the whole map (spec 5.3).
 * `marks` are the root children's summary comments: summaries take no part
 * in the split or the colour numbering (spec 5.15).
 */
export function branchLook(
	topIndex: number,
	n: number,
	direction: LayoutDirection,
	palette: readonly string[],
	marks?: readonly (SummaryMark | undefined)[],
): { side: BranchSide; color: string } {
	const colours = palette.length > 0 ? palette : DEFAULT_PALETTE;
	const plan = planRoot(marks && marks.length === n ? marks : new Array<undefined>(n), direction);
	return { side: plan.sides[topIndex] ?? (direction === "down" ? "down" : "right"), color: colours[(plan.colours[topIndex] ?? topIndex) % colours.length] };
}

/** Full layout without a persistent cache. */
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

/**
 * SVG path `d` for a summary brace (spec 5.15): two 8 px bends at each end,
 * the point at `tip` halfway along. On a short brace the bends shrink to a
 * quarter of its length. Shared with the export.
 */
export function bracePath(b: SummaryBrace): string {
	const d = (b.tip - b.base) / 2;
	const len = Math.max(0, b.to - b.from);
	const r = Math.min(Math.abs(d), len / 4);
	const m = (b.from + b.to) / 2;
	const n = b.base + d;
	// points as (along, across): along runs from `from` to `to`, across from `base` to `tip`
	const pts: [number, number][] = [
		[b.from, b.base],
		[b.from, n],
		[b.from + r, n],
		[m - r, n],
		[m, n],
		[m, b.tip],
		[m, n],
		[m + r, n],
		[b.to - r, n],
		[b.to, n],
		[b.to, b.base],
	];
	const xy = b.side === "down" ? pts.map(([a, c]) => `${r2(a)} ${r2(c)}`) : pts.map(([a, c]) => `${r2(c)} ${r2(a)}`);
	return `M ${xy[0]} Q ${xy[1]}, ${xy[2]} L ${xy[3]} Q ${xy[4]}, ${xy[5]} Q ${xy[6]}, ${xy[7]} L ${xy[8]} Q ${xy[9]}, ${xy[10]}`;
}
