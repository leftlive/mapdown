// Export to an Obsidian canvas (behaviour spec 2.3 "白板导出", JSON Canvas):
// one text card per map node, one edge per parent-child pair. Pure: the caller
// supplies the whole tree (collapsed branches included), the map size of every
// node, the direction, palette and branch colour style. No DOM, no Obsidian.
//
// Placement reuses the map layout (spec section 9) on the fully expanded tree.
// Cards are width = map width × 1.25 + 24, height = map height × 1.25 (rounded
// up, at least 120 × 50). The gaps grow by 2.5 (wider than the cards, so the
// connectors Obsidian draws between levels stay straight): the layout is linear
// in sizes and gaps, so laying out card size / 2.5 and multiplying the result
// by 2.5 gives cards of that size with gaps 2.5 times the map's.

import { layout, type LayoutInput } from "../core/layout.ts";
import { taskOf } from "../core/tasks.ts";
import type { LayoutDirection, NodeKind, Size } from "../core/types.ts";
import type { BranchStyle } from "../settings.ts";
import { mixBranch } from "./scene.ts";

/** Card growth over the map size, and the extra width added after it. */
export const CANVAS_SCALE = 1.25;
export const CANVAS_PAD_WIDTH = 24;
/** Growth of the gaps between cards (positions are the layout's × this). */
export const CANVAS_GAP_SCALE = 2.5;
export const CANVAS_MIN_WIDTH = 120;
export const CANVAS_MIN_HEIGHT = 50;

/** The parts of a map node the export reads (MapNode fits). */
export interface CanvasTree {
	id: string;
	kind: NodeKind;
	/** Node text as the map holds it: `<br>` already read as "\n", code with its fences. */
	text: string;
	children: readonly CanvasTree[];
}

export interface CanvasOptions {
	direction: LayoutDirection;
	palette: readonly string[];
	branchStyle: BranchStyle;
	/** Map size of each node; a node missing here gets the smallest card. */
	sizes: ReadonlyMap<string, Size>;
	/** Text of a virtual root (the note name); the root's own text otherwise. */
	rootText?: string;
}

type CanvasSide = "top" | "right" | "bottom" | "left";

interface CanvasNode {
	id: string;
	type: "text";
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
	color?: string;
}

interface CanvasEdge {
	id: string;
	fromNode: string;
	fromSide: CanvasSide;
	toNode: string;
	toSide: CanvasSide;
	toEnd: "none";
	color?: string;
}

/** Card size for a node of map size `s`: width × 1.25 + 24, height × 1.25, rounded up, at least 120 × 50 (spec 2.3). */
export function canvasSize(s: Size): Size {
	return {
		width: Math.max(CANVAS_MIN_WIDTH, Math.ceil(s.width * CANVAS_SCALE + CANVAS_PAD_WIDTH - 1e-9)),
		height: Math.max(CANVAS_MIN_HEIGHT, Math.ceil(s.height * CANVAS_SCALE - 1e-9)),
	};
}

/** Whether exporting expands anything: a collapsed node in `collapsed` that has children. */
export function hasFoldedBranch(root: CanvasTree, collapsed: ReadonlySet<string>): boolean {
	if (collapsed.size === 0) return false;
	const stack: CanvasTree[] = [root];
	while (stack.length > 0) {
		const node = stack.pop() as CanvasTree;
		if (node.children.length > 0 && collapsed.has(node.id)) return true;
		stack.push(...node.children);
	}
	return false;
}

/** The card text (spec 2.3): `# ` before the root, `- [ ] ` / `- [x] ` before a task. */
export function canvasText(node: Pick<CanvasTree, "kind" | "text">, isRoot: boolean, rootText?: string): string {
	if (isRoot) return `# ${rootText ?? node.text}`;
	const task = taskOf(node.text, node.kind);
	if (!task) return node.text;
	return `- [${task.done ? "x" : " "}] ${node.text.slice(task.length)}`;
}

/** FNV-1a over UTF-16 code units from `seed`, as 8 lowercase hex digits. */
function fnv(s: string, seed: number): string {
	let h = seed >>> 0;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/** 16 lowercase hex digits from `key`, unique within `taken` (a clash is hashed again, deterministically). */
function uniqueId(key: string, taken: Set<string>): string {
	for (let attempt = 0; ; attempt++) {
		const k = attempt === 0 ? key : `${key}#${attempt}`;
		const id = fnv(k, 0x811c9dc5) + fnv(k, 0x6a09e667);
		if (!taken.has(id)) {
			taken.add(id);
			return id;
		}
	}
}

/** `#rrggbb` for a palette colour; null when it is not a colour that can be read. */
function hexOf(color: string): string | null {
	return color ? mixBranch(color, 100, color) : null;
}

/** The canvas as a JSON string (tab-indented, like Obsidian writes it). */
export function buildCanvas(root: CanvasTree, opts: CanvasOptions): string {
	// card sizes and the ids, from each node's path of child indices (session ids are not stable)
	const cards = new Map<string, { node: CanvasTree; size: Size; path: string; isRoot: boolean }>();
	const toInput = (node: CanvasTree, path: string, isRoot: boolean): LayoutInput => {
		const size = canvasSize(opts.sizes.get(node.id) ?? { width: 0, height: 0 });
		cards.set(node.id, { node, size, path, isRoot });
		return {
			id: node.id,
			size: { width: size.width / CANVAS_GAP_SCALE, height: size.height / CANVAS_GAP_SCALE },
			collapsed: false,
			children: node.children.map((c, i) => toInput(c, path === "" ? String(i) : `${path}.${i}`, false)),
		};
	};
	const lay = layout(toInput(root, "", true), opts.direction, opts.palette);

	const taken = new Set<string>();
	const ids = new Map<string, string>();
	for (const [id, card] of cards) ids.set(id, uniqueId(`node:${card.path}`, taken));

	const colorOf = new Map<string, string | null>();
	const edges: CanvasEdge[] = [];
	for (const e of lay.edges) {
		const child = lay.nodes.get(e.childId);
		const card = cards.get(e.childId);
		if (!child || !card) continue;
		const color = hexOf(e.color);
		colorOf.set(e.childId, color);
		// widened to string: the downward layout (spec 9.1) adds "down" to Side
		const side: string = child.side;
		const [fromSide, toSide]: [CanvasSide, CanvasSide] = side === "down" ? ["bottom", "top"] : side === "left" ? ["left", "right"] : ["right", "left"];
		const edge: CanvasEdge = {
			id: uniqueId(`edge:${card.path}`, taken),
			fromNode: ids.get(e.parentId) as string,
			fromSide,
			toNode: ids.get(e.childId) as string,
			toSide,
			toEnd: "none",
		};
		if (color) edge.color = color;
		edges.push(edge);
	}

	const tinted = opts.branchStyle === "border" || opts.branchStyle === "tint";
	const nodes: CanvasNode[] = [];
	for (const [id, p] of lay.nodes) {
		const card = cards.get(id);
		if (!card) continue;
		const node: CanvasNode = {
			id: ids.get(id) as string,
			type: "text",
			text: canvasText(card.node, card.isRoot, opts.rootText),
			x: Math.round(p.x * CANVAS_GAP_SCALE),
			y: Math.round(p.y * CANVAS_GAP_SCALE),
			width: card.size.width,
			height: card.size.height,
		};
		const color = colorOf.get(id);
		if (tinted && !card.isRoot && color) node.color = color;
		nodes.push(node);
	}
	return JSON.stringify({ nodes, edges }, null, "\t");
}
