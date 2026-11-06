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

/** Viewport showing all of `bounds` inside `area` with `pad` screen pixels around; never zooms in past 1. */
export function fitBounds(bounds: Rect, area: Rect, pad: number): Viewport {
	const w = Math.max(1, area.width - 2 * pad);
	const h = Math.max(1, area.height - 2 * pad);
	const s = clampZoom(Math.min(1, w / Math.max(1, bounds.width), h / Math.max(1, bounds.height)));
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
 * The point of a node that stays put on screen when the node changes size (spec 3.1): the edge facing
 * its parent (left edge on the right side, right edge on the left side, centre for the root),
 * at the node's vertical centre.
 */
export function anchorPoint(r: Rect, side: "root" | "left" | "right"): Point {
	const x = side === "right" ? r.x : side === "left" ? r.x + r.width : r.x + r.width / 2;
	return { x, y: r.y + r.height / 2 };
}

/** Translation that keeps a point that moved from `before` to `after` (world) on the same screen spot. */
export function anchorShift(vp: Viewport, before: Point, after: Point): Viewport {
	return { scale: vp.scale, x: vp.x + (before.x - after.x) * vp.scale, y: vp.y + (before.y - after.y) * vp.scale };
}

/**
 * Viewport on entering focus mode (spec 5.3). The subtree `box` is centred in `area` with `pad` pixels
 * around. The scale is a readable one: at least 1 (a larger current zoom is kept), shrunk to fit the
 * box, but not below `minScale`. When the box is still wider than the area, the focus node (`focus`)
 * is kept `pad` pixels from the area's edge on its parent-facing side and the subtree runs off the
 * other side; a root focus (`side` "root") is always centred. Vertically the box is always centred.
 */
export function focusViewport(
	vp: Viewport,
	box: Rect,
	focus: Rect,
	side: "root" | "left" | "right",
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
	if (side === "root" || box.width * scale + 2 * pad <= area.width) return centred;
	const ax = anchorPoint(focus, side).x * scale;
	return { scale, y: centred.y, x: side === "right" ? area.x + pad - ax : area.x + area.width - pad - ax };
}
