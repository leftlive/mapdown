import { test } from "node:test";
import assert from "node:assert/strict";
import {
	VIRTUALIZE_THRESHOLD,
	boxHits,
	capWindow,
	dropPlace,
	edgeInWindow,
	hitTest,
	needsWindowRefresh,
	selectWindow,
} from "../../src/view/virtualize.ts";

interface Box {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

function grid(n: number): Map<string, Box> {
	const m = new Map<string, Box>();
	for (let i = 0; i < n; i++) m.set(`n${i}`, { id: `n${i}`, x: 0, y: i * 40, width: 100, height: 30 });
	return m;
}

test("small maps render every node", () => {
	const all = grid(VIRTUALIZE_THRESHOLD);
	const ids = selectWindow(all, { x: 0, y: 0, width: 10, height: 10 }, []);
	assert.equal(ids.size, VIRTUALIZE_THRESHOLD);
});

test("large maps render only the window plus pinned ids", () => {
	const all = grid(5000);
	const ids = selectWindow(all, { x: 0, y: 0, width: 200, height: 400 }, ["n4999", "missing"]);
	assert.ok(ids.has("n0") && ids.has("n10") && !ids.has("n11"));
	assert.ok(ids.has("n4999"), "pinned id kept");
	assert.ok(!ids.has("missing"), "pinned ids must be placed");
	assert.equal(ids.size, 12);
});

test("selecting the window for 5,000 nodes is fast", () => {
	const all = grid(5000);
	const t = performance.now();
	for (let i = 0; i < 20; i++) selectWindow(all, { x: 0, y: i * 1000, width: 800, height: 600 }, []);
	assert.ok((performance.now() - t) / 20 < 5);
});

test("edges are drawn when their box meets the window", () => {
	const w = { x: 0, y: 0, width: 100, height: 100 };
	assert.equal(edgeInWindow({ x: -50, y: 50 }, { x: 150, y: 60 }, w), true);
	assert.equal(edgeInWindow({ x: 200, y: 50 }, { x: 300, y: 60 }, w), false);
});

test("window refresh only when the view leaves the covered area", () => {
	const covered = { x: -500, y: -500, width: 2000, height: 2000 };
	assert.equal(needsWindowRefresh(covered, { x: 0, y: 0, width: 800, height: 600 }), false);
	assert.equal(needsWindowRefresh(covered, { x: 900, y: 0, width: 800, height: 600 }), true);
	assert.equal(needsWindowRefresh(null, { x: 0, y: 0, width: 1, height: 1 }), true);
});

test("hitTest finds the node under a point, skipping excluded ids", () => {
	const all = grid(10);
	assert.equal(hitTest(all, { x: 50, y: 45 }, null)?.id, "n1");
	assert.equal(hitTest(all, { x: 50, y: 35 }, null), null, "gap between nodes");
	assert.equal(hitTest(all, { x: 50, y: 45 }, new Set(["n1"])), null);
});

test("dropPlace: quarter rule", () => {
	const r = { x: 0, y: 100, width: 100, height: 40 };
	assert.equal(dropPlace(r, { x: 50, y: 105 }, false), "before");
	assert.equal(dropPlace(r, { x: 50, y: 120 }, false), "child");
	assert.equal(dropPlace(r, { x: 50, y: 112 }, false), "child", "just below the top quarter");
	assert.equal(dropPlace(r, { x: 50, y: 128 }, false), "child", "just above the bottom quarter");
	assert.equal(dropPlace(r, { x: 50, y: 135 }, false), "after");
	assert.equal(dropPlace(r, { x: 50, y: 105 }, true), "child", "root accepts only children");
});

test("boxHits returns every node the rectangle touches", () => {
	const all = grid(10);
	assert.deepEqual(boxHits(all, { x: 90, y: 50, width: 50, height: 60 }), ["n1", "n2"]);
	assert.deepEqual(boxHits(all, { x: 200, y: 0, width: 10, height: 10 }), []);
});

test("capWindow keeps pinned ids and the nodes nearest the centre", () => {
	const all = grid(100);
	const ids = new Set(all.keys());
	const kept = capWindow(all, ids, { x: 50, y: 15 }, 5, ["n99"]);
	assert.equal(kept.size, 5);
	assert.ok(kept.has("n99"));
	for (const id of ["n0", "n1", "n2", "n3"]) assert.ok(kept.has(id), id);
	assert.equal(capWindow(all, ids, { x: 0, y: 0 }, 1000, []), ids, "under the cap nothing changes");
});

import { pickAnchor } from "../../src/view/virtualize.ts";

test("pickAnchor keeps the selected node while it is on screen", () => {
	const nodes = grid(10);
	const view = { x: 0, y: 0, width: 200, height: 200 };
	assert.equal(pickAnchor(nodes, nodes.keys(), "n1", view), "n1");
});

test("pickAnchor falls back to the node nearest the centre when the selection is off screen", () => {
	const nodes = grid(30);
	const view = { x: 0, y: 400, width: 200, height: 200 }; // rows 10..15, centre y=500
	const id = pickAnchor(nodes, nodes.keys(), "n0", view);
	assert.equal(id, "n12");
});

test("pickAnchor returns null when nothing is on screen", () => {
	const nodes = grid(5);
	assert.equal(pickAnchor(nodes, nodes.keys(), null, { x: 5000, y: 5000, width: 10, height: 10 }), null);
});
