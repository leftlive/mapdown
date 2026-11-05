import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_ZOOM,
	MIN_ZOOM,
	anchorShift,
	centerOnRect,
	fitBounds,
	intersects,
	revealRect,
	toScreen,
	toWorld,
	visibleRect,
	zoomAt,
	type Viewport,
} from "../../src/view/viewport.ts";

const vp: Viewport = { x: 100, y: 50, scale: 2 };

test("screen and world are inverse", () => {
	const s = toScreen(vp, { x: 10, y: 20 });
	assert.deepEqual(s, { x: 120, y: 90 });
	assert.deepEqual(toWorld(vp, s), { x: 10, y: 20 });
});

test("zoomAt keeps the point under the cursor and clamps", () => {
	const at = { x: 300, y: 200 };
	const before = toWorld(vp, at);
	const z = zoomAt(vp, 1.5, at);
	assert.equal(z.scale, 3);
	const after = toWorld(z, at);
	assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9);
	assert.equal(zoomAt(vp, 1000, at).scale, MAX_ZOOM);
	assert.equal(zoomAt(vp, 1e-6, at).scale, MIN_ZOOM);
});

test("visibleRect covers the screen with a margin", () => {
	const r = visibleRect({ x: 0, y: 0, scale: 0.5 }, 400, 200, 0);
	assert.deepEqual(r, { x: 0, y: 0, width: 800, height: 400 });
	const m = visibleRect({ x: 0, y: 0, scale: 1 }, 400, 200, 0.5);
	assert.deepEqual(m, { x: -200, y: -100, width: 800, height: 400 });
});

test("centerOnRect puts the rect centre in the middle", () => {
	const c = centerOnRect({ x: 0, y: 0, scale: 1 }, { x: 100, y: 100, width: 50, height: 20 }, 800, 600);
	const s = toScreen(c, { x: 125, y: 110 });
	assert.deepEqual(s, { x: 400, y: 300 });
});

test("fitBounds fits and never zooms in past 1", () => {
	const f = fitBounds({ x: -500, y: -100, width: 1000, height: 200 }, 540, 400, 20);
	assert.equal(f.scale, 0.5);
	const tl = toScreen(f, { x: -500, y: -100 });
	assert.equal(tl.x, 20);
	const small = fitBounds({ x: 0, y: 0, width: 10, height: 10 }, 800, 600, 20);
	assert.equal(small.scale, 1);
	assert.deepEqual(toScreen(small, { x: 5, y: 5 }), { x: 400, y: 300 });
});

test("revealRect moves only when the rect is off screen", () => {
	const v: Viewport = { x: 0, y: 0, scale: 1 };
	assert.equal(revealRect(v, { x: 10, y: 10, width: 50, height: 20 }, 800, 600, 20), v);
	const moved = revealRect(v, { x: 1000, y: 10, width: 50, height: 20 }, 800, 600, 20);
	const s = toScreen(moved, { x: 1050, y: 30 });
	assert.ok(s.x <= 780 && s.x >= 0, `right edge on screen: ${s.x}`);
	assert.equal(moved.y, 0, "no vertical move needed");
	const up = revealRect(v, { x: 10, y: -300, width: 50, height: 20 }, 800, 600, 20);
	assert.equal(toScreen(up, { x: 10, y: -300 }).y, 20);
});

test("anchorShift keeps a node on the same screen spot", () => {
	const shifted = anchorShift(vp, { x: 10, y: 20 }, { x: 40, y: -10 });
	assert.deepEqual(toScreen(shifted, { x: 40, y: -10 }), toScreen(vp, { x: 10, y: 20 }));
});

test("intersects", () => {
	const a = { x: 0, y: 0, width: 10, height: 10 };
	assert.equal(intersects(a, { x: 5, y: 5, width: 10, height: 10 }), true);
	assert.equal(intersects(a, { x: 11, y: 0, width: 10, height: 10 }), false);
});
