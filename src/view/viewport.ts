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

export function centerOnRect(vp: Viewport, r: Rect, width: number, height: number): Viewport {
	const cx = r.x + r.width / 2;
	const cy = r.y + r.height / 2;
	return { scale: vp.scale, x: width / 2 - cx * vp.scale, y: height / 2 - cy * vp.scale };
}

/** Viewport showing all of `bounds` with `pad` screen pixels around; never zooms in past 1. */
export function fitBounds(bounds: Rect, width: number, height: number, pad: number): Viewport {
	const w = Math.max(1, width - 2 * pad);
	const h = Math.max(1, height - 2 * pad);
	const s = clampZoom(Math.min(1, w / Math.max(1, bounds.width), h / Math.max(1, bounds.height)));
	return centerOnRect({ x: 0, y: 0, scale: s }, bounds, width, height);
}

/** Smallest pan that brings `r` on screen with `pad` pixels to spare; the same object when already visible. */
export function revealRect(vp: Viewport, r: Rect, width: number, height: number, pad: number): Viewport {
	const tl = toScreen(vp, { x: r.x, y: r.y });
	const w = r.width * vp.scale;
	const h = r.height * vp.scale;
	const dx = axisShift(tl.x, w, width, pad);
	const dy = axisShift(tl.y, h, height, pad);
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

/** Translation that keeps a point that moved from `before` to `after` (world) on the same screen spot. */
export function anchorShift(vp: Viewport, before: Point, after: Point): Viewport {
	return { scale: vp.scale, x: vp.x + (before.x - after.x) * vp.scale, y: vp.y + (before.y - after.y) * vp.scale };
}
