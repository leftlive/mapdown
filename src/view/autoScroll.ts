// Auto-scroll while dragging a node near the edge of the map (behaviour spec
// 4.1, drag to move). Pure: the renderer calls it once per animation frame
// with the pointer position and pans the map by the result.

import type { Point, Size } from '../core/types.ts';

/** Distance from an edge, in screen pixels, where dragging starts to scroll. */
export const EDGE_MARGIN = 40;
/** Pan per frame at the very edge (and beyond it). */
export const EDGE_MAX_SPEED = 16;

function axis(pos: number, length: number, margin: number, max: number): number {
	if (length < margin * 2) return 0;
	if (pos < margin) return Math.round(max * Math.min(1, (margin - pos) / margin));
	if (pos > length - margin) return -Math.round(max * Math.min(1, (pos - (length - margin)) / margin));
	return 0;
}

/**
 * Pan for one frame (the amount the map content moves) for a pointer at `at`
 * inside a view of `size`. Near the right edge the content moves left, so
 * what lies beyond the edge comes into view. Zero away from the edges.
 */
export function edgeScroll(at: Point, size: Size, margin = EDGE_MARGIN, max = EDGE_MAX_SPEED): { dx: number; dy: number } {
	return { dx: axis(at.x, size.width, margin, max), dy: axis(at.y, size.height, margin, max) };
}
