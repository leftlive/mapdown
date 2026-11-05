import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_PALETTE,
	createLayouter,
	layout,
	type LayoutInput,
	type LayoutResult,
	type NodePlacement,
} from "../../src/core/layout.ts";

function leaf(id: string, width = 100, height = 30): LayoutInput {
	return { id, size: { width, height }, collapsed: false, children: [] };
}

function node(id: string, children: LayoutInput[], width = 100, height = 30): LayoutInput {
	return { id, size: { width, height }, collapsed: false, children };
}

function get(result: LayoutResult, id: string): NodePlacement {
	const p = result.nodes.get(id);
	assert.ok(p, `node ${id} is placed`);
	return p;
}

function mid(p: NodePlacement): number {
	return p.y + p.height / 2;
}

/** Root with n leaf children c0..c(n-1), all 100x30 except the root (120x40). */
function star(n: number): LayoutInput {
	const children: LayoutInput[] = [];
	for (let i = 0; i < n; i++) children.push(leaf(`c${i}`));
	return node("root", children, 120, 40);
}

/** Deterministic pseudo-random tree with `count` nodes. */
function bigTree(count: number): { root: LayoutInput; leaves: LayoutInput[] } {
	let seed = 12345;
	const rand = (): number => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed / 2147483648;
	};
	const all: LayoutInput[] = [node("n0", [], 160, 40)];
	for (let i = 1; i < count; i++) {
		// prefer recent nodes as parents so the tree gets some depth
		const parentIndex = Math.floor(all.length - 1 - rand() * Math.min(all.length, 40));
		const parent = all[Math.max(0, parentIndex)];
		const child = leaf(`n${i}`, 60 + Math.floor(rand() * 200), 24 + Math.floor(rand() * 3) * 20);
		parent.children.push(child);
		all.push(child);
	}
	return { root: all[0], leaves: all.filter((n) => n.children.length === 0) };
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

function clone(input: LayoutInput): LayoutInput {
	return {
		id: input.id,
		size: { ...input.size },
		collapsed: input.collapsed,
		children: input.children.map(clone),
	};
}

test("same input gives identical output", () => {
	const { root } = bigTree(300);
	const a = layout(root, "mindmap", []);
	const b = layout(clone(root), "mindmap", []);
	assert.deepEqual([...a.nodes.entries()], [...b.nodes.entries()]);
	assert.deepEqual(a.edges, b.edges);
	assert.deepEqual(a.bounds, b.bounds);
});

test("root is placed at the origin", () => {
	const r = layout(star(3), "mindmap", []);
	const root = get(r, "root");
	assert.deepEqual([root.x, root.y, root.side], [0, 0, "root"]);
});

test("mindmap puts the first ceil(n/2) children on the right, both sides top to bottom", () => {
	const r = layout(star(5), "mindmap", []);
	const sides = [0, 1, 2, 3, 4].map((i) => get(r, `c${i}`).side);
	assert.deepEqual(sides, ["right", "right", "right", "left", "left"]);
	assert.ok(get(r, "c0").y < get(r, "c1").y && get(r, "c1").y < get(r, "c2").y);
	assert.ok(get(r, "c3").y < get(r, "c4").y);
});

test("clockwise reverses the left side so it reads bottom to top", () => {
	const r = layout(star(5), "clockwise", []);
	const sides = [0, 1, 2, 3, 4].map((i) => get(r, `c${i}`).side);
	assert.deepEqual(sides, ["right", "right", "right", "left", "left"]);
	assert.ok(get(r, "c0").y < get(r, "c1").y && get(r, "c1").y < get(r, "c2").y);
	assert.ok(get(r, "c4").y < get(r, "c3").y);
});

test("right and left put every child on one side, in order", () => {
	const right = layout(star(4), "right", []);
	const left = layout(star(4), "left", []);
	for (let i = 0; i < 4; i++) {
		assert.equal(get(right, `c${i}`).side, "right");
		assert.equal(get(left, `c${i}`).side, "left");
	}
	for (let i = 0; i < 3; i++) {
		assert.ok(get(right, `c${i}`).y < get(right, `c${i + 1}`).y);
		assert.ok(get(left, `c${i}`).y < get(left, `c${i + 1}`).y);
	}
});

test("subtrees stay on their branch's side", () => {
	const input = node("root", [node("a", [node("a1", [leaf("a11")])]), node("b", [leaf("b1")])]);
	const r = layout(input, "mindmap", []);
	for (const id of ["a", "a1", "a11"]) assert.equal(get(r, id).side, "right");
	for (const id of ["b", "b1"]) assert.equal(get(r, id).side, "left");
	assert.ok(get(r, "b1").x + 100 < get(r, "b").x);
});

test("root level uses 90 px horizontal and 20 px vertical spacing", () => {
	const r = layout(star(2), "right", []);
	const root = get(r, "root");
	const c0 = get(r, "c0");
	const c1 = get(r, "c1");
	assert.equal(c0.x, root.x + root.width + 90);
	assert.equal(c1.y - (c0.y + c0.height), 20);

	const l = layout(star(2), "left", []);
	assert.equal(get(l, "c0").x + get(l, "c0").width, get(l, "root").x - 90);
});

test("deeper levels use 48 px horizontal and 14 px vertical spacing", () => {
	const input = node("root", [node("a", [leaf("a1"), leaf("a2")])]);
	const r = layout(input, "right", []);
	const a = get(r, "a");
	const a1 = get(r, "a1");
	const a2 = get(r, "a2");
	assert.equal(a1.x, a.x + a.width + 48);
	assert.equal(a2.y - (a1.y + a1.height), 14);

	const l = layout(input, "left", []);
	assert.equal(get(l, "a1").x + get(l, "a1").width, get(l, "a").x - 48);
});

test("a child block is centred on its parent's midline", () => {
	const input = node("root", [node("a", [leaf("a1", 100, 30), leaf("a2", 100, 50), leaf("a3", 100, 20)])]);
	const r = layout(input, "right", []);
	const top = get(r, "a1").y;
	const bottom = get(r, "a3").y + get(r, "a3").height;
	assert.equal((top + bottom) / 2, mid(get(r, "a")));
});

test("each side of the root is centred on the root's midline", () => {
	const input = node(
		"root",
		[leaf("r0", 100, 30), leaf("r1", 100, 70), leaf("l0", 100, 30), leaf("l1", 100, 30)],
		120,
		40,
	);
	const r = layout(input, "mindmap", []);
	const rootMid = mid(get(r, "root"));
	assert.equal((get(r, "r0").y + get(r, "r1").y + get(r, "r1").height) / 2, rootMid);
	assert.equal((get(r, "l0").y + get(r, "l1").y + get(r, "l1").height) / 2, rootMid);
	// the sides are stacked independently
	assert.notEqual(get(r, "r0").y, get(r, "l0").y);
});

test("subtree height is the larger of the node's own height and its children stack", () => {
	// tall node with small children: the node's own height reserves the slot
	const tall = node("root", [node("a", [leaf("a1", 100, 10)], 100, 100), leaf("b", 100, 30)]);
	const r1 = layout(tall, "right", []);
	assert.equal(get(r1, "b").y - (get(r1, "a").y + 100), 20);
	assert.equal(mid(get(r1, "a1")), mid(get(r1, "a")));

	// short node with a tall children stack: the stack reserves the slot
	const wide = node("root", [node("a", [leaf("a1", 100, 50), leaf("a2", 100, 50)], 100, 20), leaf("b")]);
	const r2 = layout(wide, "right", []);
	const stackBottom = get(r2, "a2").y + 50;
	assert.equal(get(r2, "b").y - stackBottom, 20);
	assert.equal(mid(get(r2, "a")), (get(r2, "a1").y + stackBottom) / 2);
});

test("collapsed nodes keep their place but drop descendants and edges", () => {
	const input = node("root", [node("a", [node("a1", [leaf("a11")])]), leaf("b")]);
	input.children[0].collapsed = true;
	const r = layout(input, "right", []);
	assert.deepEqual([...r.nodes.keys()].sort(), ["a", "b", "root"]);
	assert.deepEqual(r.edges.map((e) => e.childId).sort(), ["a", "b"]);
	// a collapsed node reserves only its own height
	assert.equal(get(r, "b").y - (get(r, "a").y + 30), 20);

	const collapsedRoot = node("root", [leaf("a")]);
	collapsedRoot.collapsed = true;
	const rr = layout(collapsedRoot, "mindmap", []);
	assert.deepEqual([...rr.nodes.keys()], ["root"]);
	assert.equal(rr.edges.length, 0);
	assert.deepEqual(rr.bounds, { x: 0, y: 0, width: 100, height: 30 });
});

test("edges run between facing edge midpoints with control points at the horizontal midpoint", () => {
	const input = node("root", [node("a", [leaf("a1")]), node("b", [leaf("b1")])], 120, 40);
	const r = layout(input, "mindmap", []);
	assert.equal(r.edges.length, 4);
	for (const e of r.edges) {
		const parent = get(r, e.parentId);
		const child = get(r, e.childId);
		const right = child.side === "right";
		assert.deepEqual(e.from, { x: right ? parent.x + parent.width : parent.x, y: mid(parent) });
		assert.deepEqual(e.to, { x: right ? child.x : child.x + child.width, y: mid(child) });
		const mx = (e.from.x + e.to.x) / 2;
		assert.deepEqual(e.c1, { x: mx, y: e.from.y });
		assert.deepEqual(e.c2, { x: mx, y: e.to.y });
	}
});

test("bounds enclose every visible node", () => {
	const { root } = bigTree(200);
	const r = layout(root, "mindmap", []);
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of r.nodes.values()) {
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x + p.width);
		maxY = Math.max(maxY, p.y + p.height);
	}
	assert.deepEqual(r.bounds, { x: minX, y: minY, width: maxX - minX, height: maxY - minY });
});

test("branch colours follow the root child index and cycle through the palette", () => {
	const input = node("root", [node("c0", [node("c0a", [leaf("c0b")])]), leaf("c1"), leaf("c2")]);
	const r = layout(input, "clockwise", ["#111", "#222"]);
	const colour = (id: string): string => {
		const e = r.edges.find((x) => x.childId === id);
		assert.ok(e);
		return e.color;
	};
	assert.equal(colour("c0"), "#111");
	assert.equal(colour("c0a"), "#111");
	assert.equal(colour("c0b"), "#111");
	assert.equal(colour("c1"), "#222");
	assert.equal(colour("c2"), "#111");
	assert.equal(get(r, "c2").branch, 2);
	assert.equal(get(r, "root").branch, -1);
});

test("an empty palette falls back to the eight default colours", () => {
	assert.deepEqual(DEFAULT_PALETTE, [
		"#D28282", "#D4A373", "#C2B07A", "#8CB398", "#7BAEB5", "#86A2C2", "#A192B8", "#C795AB",
	]);
	const r = layout(star(9), "mindmap", []);
	for (let i = 0; i < 9; i++) {
		const e = r.edges.find((x) => x.childId === `c${i}`);
		assert.equal(e?.color, DEFAULT_PALETTE[i % 8]);
	}
});

test("incremental relayout after one leaf change matches a fresh layout and measures far less", () => {
	const { root, leaves } = bigTree(2000);
	const layouter = createLayouter();
	layouter.layout(root, "mindmap", []);
	assert.equal(layouter.lastMeasured, 1999); // the root is never cached

	const target = leaves[Math.floor(leaves.length / 2)];
	target.size = { width: target.size.width + 37, height: target.size.height + 25 };
	const incremental = layouter.layout(root, "mindmap", []);
	const measured = layouter.lastMeasured;
	const fresh = layout(clone(root), "mindmap", []);

	assert.deepEqual([...incremental.nodes.entries()], [...fresh.nodes.entries()]);
	assert.deepEqual(incremental.edges, fresh.edges);
	assert.deepEqual(incremental.bounds, fresh.bounds);
	// exactly the changed leaf and its non-root ancestors
	assert.equal(measured, get(fresh, target.id).depth);
	assert.ok(measured < 2000 / 20, `measured ${measured} subtrees`);

	// unchanged input measures nothing, even when the caller rebuilds the objects
	layouter.layout(clone(root), "mindmap", []);
	assert.equal(layouter.lastMeasured, 0);

	// collapsing and changing direction stay correct with a warm cache
	root.children[0].collapsed = true;
	const collapsed = layouter.layout(root, "clockwise", []);
	assert.deepEqual([...collapsed.nodes.entries()], [...layout(clone(root), "clockwise", []).nodes.entries()]);
	assert.equal(layouter.lastMeasured, 1);
});

test("performance: full and incremental layout stay within budget", () => {
	const timeFull = (count: number): number => {
		const { root } = bigTree(count);
		const runs: number[] = [];
		for (let i = 0; i < 5; i++) {
			const t = performance.now();
			layout(root, "mindmap", []);
			runs.push(performance.now() - t);
		}
		return median(runs);
	};
	// warm up the JIT
	timeFull(1000);
	const full1k = timeFull(1000);
	const full5k = timeFull(5000);

	const { root, leaves } = bigTree(5000);
	const layouter = createLayouter();
	layouter.layout(root, "mindmap", []);
	const runs: number[] = [];
	for (let i = 0; i < 5; i++) {
		const target = leaves[(i * 997) % leaves.length];
		target.size = { width: target.size.width + 1, height: target.size.height + 1 };
		const t = performance.now();
		layouter.layout(root, "mindmap", []);
		runs.push(performance.now() - t);
	}
	const incremental5k = median(runs);

	process.stdout.write(
		`# layout perf: 1k full ${full1k.toFixed(2)} ms, 5k full ${full5k.toFixed(2)} ms, ` +
			`5k incremental ${incremental5k.toFixed(2)} ms\n`,
	);
	assert.ok(full1k < 10, `1k full ${full1k} ms`);
	assert.ok(full5k < 40, `5k full ${full5k} ms`);
	assert.ok(incremental5k < 8, `5k incremental ${incremental5k} ms`);
});

test("branchLook gives the side and colour a root child has in the whole map", async () => {
	const { branchLook, DEFAULT_PALETTE } = await import("../../src/core/layout.ts");
	assert.deepEqual(branchLook(0, 5, "mindmap", []), { side: "right", color: DEFAULT_PALETTE[0] });
	assert.deepEqual(branchLook(3, 5, "mindmap", []), { side: "left", color: DEFAULT_PALETTE[3] });
	assert.deepEqual(branchLook(3, 5, "clockwise", ["#a", "#b"]), { side: "left", color: "#b" });
	assert.equal(branchLook(4, 5, "right", []).side, "right");
	assert.equal(branchLook(0, 5, "left", []).side, "left");
});
