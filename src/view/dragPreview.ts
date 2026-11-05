// Snap preview while dragging nodes (behaviour spec 4.1, "拖动反馈"). Pure.
//
// The preview is the layout the map will have after the drop: the dragged
// subtrees are taken out of their old place (unless the drop copies) and
// inserted at the drop place under phantom ids, with their real sizes and
// children, so the placeholder is exactly where the node lands. The insertion
// arithmetic mirrors MapView.onDrop. Unchanged subtrees keep their LayoutInput
// objects (copy-on-write), and phantom ids are stable for the whole drag, so
// the layouter's cache only re-measures the ancestors of what changed.

import type { LayoutInput } from "../core/layout.ts";
import type { Point, Size } from "../core/types.ts";
import type { DropPlace } from "./contract.ts";
import type { Rect } from "./viewport.ts";

/** Node ids never contain NUL, so phantom ids cannot collide with real ones. */
export const PHANTOM_PREFIX = "\u0000drop:";

export function phantomId(id: string): string {
	return PHANTOM_PREFIX + id;
}

export function isPhantom(id: string): boolean {
	return id.startsWith(PHANTOM_PREFIX);
}

export function realId(id: string): string {
	return isPhantom(id) ? id.slice(PHANTOM_PREFIX.length) : id;
}

export interface PreviewSpec {
	/** Dragged node ids (the selection); nested and unknown ids are allowed. */
	ids: readonly string[];
	targetId: string;
	place: DropPlace;
	copy: boolean;
	/**
	 * Size of node `id` at `depth` (0 = the root of the input). Node size depends on the level
	 * (font, padding), so a node dropped at another depth changes size; without it sizes are kept.
	 */
	sizeAt?: (id: string, depth: number) => Size;
}

export interface Preview {
	input: LayoutInput;
	/** Node the phantoms become children of (highlighted while dragging). */
	parentId: string;
	/** Topmost dragged ids in tree order; each has a phantom top `phantomId(id)`. */
	tops: string[];
}

interface Entry {
	input: LayoutInput;
	parent: LayoutInput | null;
}

/**
 * Layout input as it will be after dropping `spec.ids` on `spec.targetId`, or null when there is no
 * such drop (unknown target, target inside a dragged subtree, nothing to move).
 */
export function previewInput(root: LayoutInput, spec: PreviewSpec): Preview | null {
	const index = new Map<string, Entry>();
	const order: string[] = [];
	const stack: Entry[] = [{ input: root, parent: null }];
	while (stack.length > 0) {
		const e = stack.pop() as Entry;
		index.set(e.input.id, e);
		order.push(e.input.id);
		const kids = e.input.children;
		for (let i = kids.length - 1; i >= 0; i--) stack.push({ input: kids[i], parent: e.input });
	}
	const target = index.get(spec.targetId);
	if (!target) return null;

	// topmost dragged nodes in tree order; the root of what is laid out never moves
	const dragged = new Set(spec.ids);
	const covered = (id: string): boolean => {
		for (let p = index.get(id)?.parent ?? null; p && p !== root; p = index.get(p.id)?.parent ?? null) {
			if (dragged.has(p.id)) return true;
		}
		return false;
	};
	const tops = order.filter((id) => dragged.has(id) && id !== root.id && !covered(id));
	if (tops.length === 0) return null;
	const moving = new Set(tops);
	// not into a dragged subtree
	for (let p: LayoutInput | null = target.input; p; p = index.get(p.id)?.parent ?? null) {
		if (moving.has(p.id)) return null;
	}

	const asChild = spec.place === "child" || target.parent === null;
	const parent = asChild ? target.input : (target.parent as LayoutInput);
	const keep = (c: LayoutInput): boolean => spec.copy || !moving.has(c.id);
	let at: number;
	if (asChild) {
		at = parent.children.filter(keep).length;
	} else {
		const sibs = parent.children.filter((c) => keep(c) || c.id === spec.targetId);
		at = sibs.indexOf(target.input) + (spec.place === "after" ? 1 : 0);
	}
	let depth = 1;
	for (let p = index.get(parent.id)?.parent ?? null; p; p = index.get(p.id)?.parent ?? null) depth++;
	const phantoms = tops.map((id) => clonePhantom((index.get(id) as Entry).input, depth, spec.sizeAt));

	// rebuild only the paths from the root to the changed parents
	const dirty = new Set<string>();
	const mark = (from: LayoutInput | null): void => {
		for (let p = from; p && !dirty.has(p.id); p = index.get(p.id)?.parent ?? null) dirty.add(p.id);
	};
	mark(parent);
	if (!spec.copy) for (const id of tops) mark((index.get(id) as Entry).parent);

	const rebuild = (n: LayoutInput): LayoutInput => {
		if (!dirty.has(n.id)) return n;
		const kids: LayoutInput[] = [];
		for (const c of n.children) if (keep(c)) kids.push(rebuild(c));
		if (n === parent) {
			kids.splice(at, 0, ...phantoms);
			// the drop opens a collapsed target (its hidden children are not in the input)
			return { id: n.id, size: n.size, collapsed: false, children: kids };
		}
		return { id: n.id, size: n.size, collapsed: n.collapsed, children: kids };
	};
	return { input: rebuild(root), parentId: parent.id, tops };
}

function clonePhantom(n: LayoutInput, depth: number, sizeAt: PreviewSpec["sizeAt"]): LayoutInput {
	return {
		id: phantomId(n.id),
		size: sizeAt ? sizeAt(n.id, depth) : n.size,
		collapsed: n.collapsed,
		children: n.children.map((c) => clonePhantom(c, depth + 1, sizeAt)),
	};
}

/**
 * Ends of the line from rect `a` to rect `b` along the line between their centres, cut at each
 * rect's border. Null when the rects overlap (nothing to draw).
 */
export function connectorEnds(a: Rect, b: Rect): { from: Point; to: Point } | null {
	if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) return null;
	const ca = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
	const cb = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
	const dx = cb.x - ca.x;
	const dy = cb.y - ca.y;
	// fraction of the centre line inside a box of half-size (w, h) around its centre
	const exit = (w: number, h: number): number => {
		const tx = dx === 0 ? Infinity : w / Math.abs(dx);
		const ty = dy === 0 ? Infinity : h / Math.abs(dy);
		return Math.min(tx, ty);
	};
	const ta = exit(a.width / 2, a.height / 2);
	const tb = exit(b.width / 2, b.height / 2);
	return {
		from: { x: ca.x + dx * ta, y: ca.y + dy * ta },
		to: { x: cb.x - dx * tb, y: cb.y - dy * tb },
	};
}
