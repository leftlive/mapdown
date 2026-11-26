// Pan and zoom math. Screen point = world point * scale + (x, y), where
// "screen" is relative to the map viewport's top-left corner. Pure.

import type { Point } from "../core/types.ts";

export interface Viewport {
	x: number;
	y: number;
	scale: number;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

export function clampZoom(s: number): number {
	if (!Number.isFinite(s)) return 1;
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s));
}

export function toScreen(vp: Viewport, p: Point): Point {
	return { x: p.x * vp.scale + vp.x, y: p.y * vp.scale + vp.y };
}

export function toWorld(vp: Viewport, p: Point): Point {
	return { x: (p.x - vp.x) / vp.scale, y: (p.y - vp.y) / vp.scale };
}

/** Zoom by `factor` keeping the world point under `at` (screen) fixed. */
export function zoomAt(vp: Viewport, factor: number, at: Point): Viewport {
	const scale = clampZoom(vp.scale * factor);
	const w = toWorld(vp, at);
	return { scale, x: at.x - w.x * scale, y: at.y - w.y * scale };
}

/** World rect shown on a `width` x `height` screen, grown by `margin` screens on every side. */
export function visibleRect(vp: Viewport, width: number, height: number, margin: number): Rect {
	const tl = toWorld(vp, { x: -width * margin, y: -height * margin });
	return {
		x: tl.x + 0,
		y: tl.y + 0,
		width: (width * (1 + 2 * margin)) / vp.scale,
		height: (height * (1 + 2 * margin)) / vp.scale,
	};
}

export function intersects(a: Rect, b: Rect): boolean {
	return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

export function contains(outer: Rect, inner: Rect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.width <= outer.x + outer.width &&
		inner.y + inner.height <= outer.y + outer.height
	);
}

/** The whole `width` x `height` screen as an area. */
export function screenArea(width: number, height: number): Rect {
	return { x: 0, y: 0, width, height };
}

/**
 * The part of a `width` x `height` screen not covered by floating UI (spec 5.1, available area).
 * Each cover (screen rect, clipped to the screen; empty ones are skipped) takes its depth off the
 * one edge where that costs least: a bar hugging the right edge narrows the right, a wide bar at the
 * bottom lowers the bottom, a box in a corner takes whichever side is smaller. A cover that would
 * take more than half of the screen on its cheapest side does not hug an edge and is ignored.
 */
export function uncoveredArea(width: number, height: number, covers: readonly Rect[]): Rect {
	const inset = { left: 0, right: 0, top: 0, bottom: 0 };
	for (const c of covers) {
		const x0 = Math.max(0, c.x);
		const y0 = Math.max(0, c.y);
		const x1 = Math.min(width, c.x + c.width);
		const y1 = Math.min(height, c.y + c.height);
		if (x1 <= x0 || y1 <= y0) continue;
		const cuts = [
			{ edge: "left" as const, depth: x1, max: width },
			{ edge: "right" as const, depth: width - x0, max: width },
			{ edge: "top" as const, depth: y1, max: height },
			{ edge: "bottom" as const, depth: height - y0, max: height },
		];
		let best = cuts[0];
		for (const cut of cuts) if (cut.depth < best.depth) best = cut;
		if (best.depth > best.max / 2) continue;
		inset[best.edge] = Math.max(inset[best.edge], best.depth);
	}
	return {
		x: inset.left,
		y: inset.top,
		width: Math.max(1, width - inset.left - inset.right),
		height: Math.max(1, height - inset.top - inset.bottom),
	};
}

/** Viewport at `vp`'s scale with the centre of `r` in the middle of `area` (screen). */
export function centerOnRect(vp: Viewport, r: Rect, area: Rect): Viewport {
	const cx = r.x + r.width / 2;
	const cy = r.y + r.height / 2;
	return { scale: vp.scale, x: area.x + area.width / 2 - cx * vp.scale, y: area.y + area.height / 2 - cy * vp.scale };
}

/** Viewport at `vp`'s scale with `r` horizontally centred in `area` and its top edge `margin` screen pixels below the top of `area`. */
export function topOnRect(vp: Viewport, r: Rect, area: Rect, margin: number): Viewport {
	const cx = r.x + r.width / 2;
	return { scale: vp.scale, x: area.x + area.width / 2 - cx * vp.scale, y: area.y + margin - r.y * vp.scale };
}

/** Viewport showing all of `bounds` inside `area` with `pad` screen pixels around; never zooms in past `maxZoom` (default 1). */
export function fitBounds(bounds: Rect, area: Rect, pad: number, maxZoom = 1): Viewport {
	const w = Math.max(1, area.width - 2 * pad);
	const h = Math.max(1, area.height - 2 * pad);
	const s = clampZoom(Math.min(maxZoom, w / Math.max(1, bounds.width), h / Math.max(1, bounds.height)));
	return centerOnRect({ x: 0, y: 0, scale: s }, bounds, area);
}

/** Smallest pan that brings `r` into `area` with `pad` pixels to spare; the same object when already inside. */
export function revealRect(vp: Viewport, r: Rect, area: Rect, pad: number): Viewport {
	const tl = toScreen(vp, { x: r.x, y: r.y });
	const w = r.width * vp.scale;
	const h = r.height * vp.scale;
	const dx = axisShift(tl.x - area.x, w, area.width, pad);
	const dy = axisShift(tl.y - area.y, h, area.height, pad);
	if (dx === 0 && dy === 0) return vp;
	return { scale: vp.scale, x: vp.x + dx, y: vp.y + dy };
}

function axisShift(start: number, size: number, screen: number, pad: number): number {
	if (start >= 0 && start + size <= screen) return 0;
	// too big to fit: align the start
	if (size + 2 * pad > screen) return pad - start;
	if (start < pad) return pad - start;
	return screen - pad - (start + size);
}

/**
 * The point of a node that stays put on screen when the node changes size (spec 3.1, 9.1): the edge
 * facing its parent (left edge on the right side, right edge on the left side, centre for the root),
 * at the node's vertical centre; in downward layout, the top edge at the horizontal centre.
 */
export function anchorPoint(r: Rect, side: "root" | "left" | "right" | "down"): Point {
	if (side === "down") return { x: r.x + r.width / 2, y: r.y };
	const x = side === "right" ? r.x : side === "left" ? r.x + r.width : r.x + r.width / 2;
	return { x, y: r.y + r.height / 2 };
}

/** Translation that keeps a point that moved from `before` to `after` (world) on the same screen spot. */
export function anchorShift(vp: Viewport, before: Point, after: Point): Viewport {
	return { scale: vp.scale, x: vp.x + (before.x - after.x) * vp.scale, y: vp.y + (before.y - after.y) * vp.scale };
}

/**
 * Viewport on entering focus mode (spec 5.3, 9.1). The subtree `box` is centred in `area` with `pad`
 * pixels around. The scale is a readable one: at least 1 (a larger current zoom is kept), shrunk to
 * fit the box, but not below `minScale`. When the box is still wider than the area (horizontal), the
 * focus node (`focus`) is kept `pad` pixels from the area's edge on its parent-facing side; in
 * downward layout, when the box is taller than the area, the box is centred horizontally and the
 * focus node is kept `pad` pixels from the top edge.
 */
export function focusViewport(
	vp: Viewport,
	box: Rect,
	focus: Rect,
	side: "root" | "left" | "right" | "down",
	area: Rect,
	pad: number,
	minScale: number,
): Viewport {
	const fitScale = Math.min(
		Math.max(1, area.width - 2 * pad) / Math.max(1, box.width),
		Math.max(1, area.height - 2 * pad) / Math.max(1, box.height),
	);
	const scale = clampZoom(Math.max(minScale, Math.min(Math.max(vp.scale, 1), fitScale)));
	const centred = centerOnRect({ x: 0, y: 0, scale }, box, area);
	if (side === "down") {
		if (box.height * scale + 2 * pad <= area.height) return centred;
		const ay = anchorPoint(focus, "down").y * scale;
		return { scale, x: centred.x, y: area.y + pad - ay };
	}
	if (side === "root" || box.width * scale + 2 * pad <= area.width) return centred;
	const ax = anchorPoint(focus, side).x * scale;
	return { scale, y: centred.y, x: side === "right" ? area.x + pad - ax : area.x + area.width - pad - ax };
}

/** Screen rect of the world rect `r`. */
export function screenRect(vp: Viewport, r: Rect): Rect {
	return { x: r.x * vp.scale + vp.x, y: r.y * vp.scale + vp.y, width: r.width * vp.scale, height: r.height * vp.scale };
}

/**
 * Top-left of the multi-selection bar (spec 5.11), `bar` wide and high, for the selection's screen box
 * `sel` inside the available `area`: centred `gap` above the part of the box that is in the area, below
 * it when there is no room above, kept `gap` inside the area's left and right edges. With no part of the
 * box in the area (or no box), the bar sits at the top of the area, centred. When neither above nor
 * below has room, it goes to the top of the area too.
 */
export function barPosition(sel: Rect | null, bar: { width: number; height: number }, area: Rect, gap: number): Point {
	const x0 = sel ? Math.max(sel.x, area.x) : 0;
	const y0 = sel ? Math.max(sel.y, area.y) : 0;
	const x1 = sel ? Math.min(sel.x + sel.width, area.x + area.width) : -1;
	const y1 = sel ? Math.min(sel.y + sel.height, area.y + area.height) : -1;
	const lo = area.x + gap;
	const hi = area.x + area.width - gap - bar.width;
	const clampX = (x: number): number => Math.max(lo, Math.min(hi, x));
	const top = area.y + gap;
	if (!sel || x1 < x0 || y1 < y0) return { x: clampX(area.x + (area.width - bar.width) / 2), y: top };
	const x = clampX((x0 + x1) / 2 - bar.width / 2);
	const above = y0 - gap - bar.height;
	if (above >= area.y) return { x, y: above };
	const below = y1 + gap;
	if (below + bar.height <= area.y + area.height) return { x, y: below };
	return { x, y: top };
}

/** Where the marker palette (spec 5.14) is opened from: beside a node (outer side), left of a toolbar button, below a bar. */
export interface PaletteAnchor {
	side: "right" | "left" | "below";
	rect: Rect;
}

/**
 * Top-left corner of the marker palette (spec 5.14): `gap` away from the anchor on its side (top edges
 * aligned beside it, centred below or above it). Order: right anchor: right, left, below, above; left
 * anchor: left, below, above; below anchor: below, above. The first spot that fits `area` (with `gap`
 * to spare) is used; beside spots are only moved vertically to fit. Nothing fits: the preferred spot
 * pushed inside the area (top-left corner at the area's when it is too large).
 */
export function palettePosition(anchor: PaletteAnchor, size: { width: number; height: number }, area: Rect, gap: number): Point {
	const r = anchor.rect;
	const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
	const minX = area.x + gap;
	const maxX = Math.max(minX, area.x + area.width - gap - size.width);
	const minY = area.y + gap;
	const maxY = Math.max(minY, area.y + area.height - gap - size.height);
	const clampX = (x: number): number => clamp(x, minX, maxX);
	const clampY = (y: number): number => clamp(y, minY, maxY);
	const fits = (p: Point): boolean => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;
	const midX = r.x + r.width / 2 - size.width / 2;
	const rightOf: Point = { x: r.x + r.width + gap, y: r.y };
	const leftOf: Point = { x: r.x - gap - size.width, y: r.y };
	// below / above: centred on the anchor, then pushed sideways (never vertically, so the anchor stays free)
	const under: Point = { x: clampX(midX), y: r.y + r.height + gap };
	const over: Point = { x: clampX(midX), y: r.y - gap - size.height };
	// beside: top edges aligned, the vertical clamp may not push it onto the anchor (it is beside it)
	const beside = (p: Point): Point => ({ x: p.x, y: clampY(p.y) });
	const order: Point[] =
		anchor.side === "right" ? [beside(rightOf), beside(leftOf), under, over]
		: anchor.side === "left" ? [beside(leftOf), under, over]
		: [under, over];
	for (const p of order) if (fits(p)) return p;
	// nothing fits completely: the preferred spot, pushed inside the area
	const first: Point = anchor.side === "right" ? rightOf : anchor.side === "left" ? leftOf : { x: midX, y: r.y + r.height + gap };
	return { x: clampX(first.x), y: clampY(first.y) };
}

/**
 * Presentation camera (spec 5.13): `box` centred in `area` with `pad` pixels around, at the largest
 * zoom that fits, kept within [minScale, maxScale] (and the general zoom limits).
 */
export function presentViewport(box: Rect, area: Rect, pad: number, minScale: number, maxScale: number): Viewport {
	const fit = Math.min(
		Math.max(1, area.width - 2 * pad) / Math.max(1, box.width),
		Math.max(1, area.height - 2 * pad) / Math.max(1, box.height),
	);
	const scale = clampZoom(Math.max(minScale, Math.min(maxScale, fit)));
	return centerOnRect({ x: 0, y: 0, scale }, box, area);
}

/** Ease-in-out (cubic) of `t` in [0, 1]. */
export function easeInOut(t: number): number {
	const c = Math.max(0, Math.min(1, t));
	return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}

/**
 * A camera flight (spec 5.13) at progress `t` (0 to 1, eased here): the scale and the world point
 * under the screen point `centre` move together, so the view glides instead of swinging about.
 */
export function flightViewport(from: Viewport, to: Viewport, centre: Point, t: number): Viewport {
	const e = easeInOut(t);
	if (e <= 0) return from;
	if (e >= 1) return to;
	const a = toWorld(from, centre);
	const b = toWorld(to, centre);
	const scale = from.scale + (to.scale - from.scale) * e;
	const wx = a.x + (b.x - a.x) * e;
	const wy = a.y + (b.y - a.y) * e;
	return { scale, x: centre.x - wx * scale, y: centre.y - wy * scale };
}
