import { test } from "node:test";
import assert from "node:assert/strict";
import { MINIMAP_THRESHOLD, minimapGeometry, minimapPointToWorld, shouldShowMinimap, viewRectInMinimap } from "../../src/view/minimap.ts";

const bounds = { x: -100, y: -50, width: 2000, height: 1000 };

test("the minimap appears above 300 nodes only", () => {
	assert.equal(MINIMAP_THRESHOLD, 300);
	assert.equal(shouldShowMinimap(300), false);
	assert.equal(shouldShowMinimap(301), true);
});

test("geometry fits the bounds inside the box and keeps the aspect ratio", () => {
	const g = minimapGeometry(bounds, 200, 120);
	assert.ok(g.scale > 0);
	assert.ok(bounds.width * g.scale <= 200 + 1e-9 && bounds.height * g.scale <= 120 + 1e-9);
	// the wider axis touches the box
	assert.ok(Math.abs(bounds.width * g.scale - 200) < 1e-9);
	// centred on the other axis
	assert.ok(Math.abs(g.offsetY - (120 - bounds.height * g.scale) / 2) < 1e-9);
});

test("a click maps back to the world point and round-trips", () => {
	const g = minimapGeometry(bounds, 200, 120);
	const world = minimapPointToWorld(g, { x: 0 + g.offsetX, y: g.offsetY });
	assert.ok(Math.abs(world.x - bounds.x) < 1e-6 && Math.abs(world.y - bounds.y) < 1e-6);
	const mid = minimapPointToWorld(g, { x: 100, y: 60 });
	assert.ok(Math.abs(mid.x - (bounds.x + bounds.width / 2)) < 1e-6);
	assert.ok(Math.abs(mid.y - (bounds.y + bounds.height / 2)) < 1e-6);
});

test("the view rectangle is the visible world rect in minimap pixels", () => {
	const g = minimapGeometry(bounds, 200, 120);
	const r = viewRectInMinimap(g, { x: 0, y: 0, width: 400, height: 200 });
	assert.ok(Math.abs(r.width - 400 * g.scale) < 1e-9);
	assert.ok(Math.abs(r.x - ((0 - bounds.x) * g.scale + g.offsetX)) < 1e-9);
});

test("empty bounds do not divide by zero", () => {
	const g = minimapGeometry({ x: 0, y: 0, width: 0, height: 0 }, 200, 120);
	assert.ok(Number.isFinite(g.scale) && g.scale > 0);
});
