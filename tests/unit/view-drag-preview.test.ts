import { test } from "node:test";
import assert from "node:assert/strict";
import { createLayouter, layout, type LayoutInput } from "../../src/core/layout.ts";
import { connectorEnds, isPhantom, phantomId, previewInput, realId } from "../../src/view/dragPreview.ts";

// tree spec: "id" leaf, or [id, ...children]
type Spec = string | [string, ...Spec[]];

function build(s: Spec, collapsed: Set<string> = new Set()): LayoutInput {
	const [id, ...kids] = typeof s === "string" ? [s] : s;
	return { id, size: { width: 40 + id.length * 5, height: 20 }, collapsed: collapsed.has(id), children: kids.map((k) => build(k, collapsed)) };
}

/** Tree as nested ids, phantoms shown as "~id". */
function shape(n: LayoutInput): unknown {
	const name = isPhantom(n.id) ? `~${realId(n.id)}` : n.id;
	return n.children.length === 0 ? name : [name, ...n.children.map(shape)];
}

const tree: Spec = ["r", ["a", "a1", "a2", "a3"], ["b", "b1"], "c"];

test("phantom ids are distinct from real ids and round-trip", () => {
	assert.notEqual(phantomId("a"), "a");
	assert.equal(isPhantom(phantomId("a")), true);
	assert.equal(isPhantom("a"), false);
	assert.equal(realId(phantomId("a")), "a");
	assert.equal(realId("a"), "a");
});

test("move before and after a sibling in another parent", () => {
	const before = previewInput(build(tree), { ids: ["a2"], targetId: "b1", place: "before", copy: false });
	assert.deepEqual(shape(before?.input as LayoutInput), ["r", ["a", "a1", "a3"], ["b", "~a2", "b1"], "c"]);
	assert.equal(before?.parentId, "b");
	assert.deepEqual(before?.tops, ["a2"]);
	const after = previewInput(build(tree), { ids: ["a2"], targetId: "b1", place: "after", copy: false });
	assert.deepEqual(shape(after?.input as LayoutInput), ["r", ["a", "a1", "a3"], ["b", "b1", "~a2"], "c"]);
});

test("move within the same parent counts siblings without the moving node", () => {
	const p = previewInput(build(tree), { ids: ["a1"], targetId: "a3", place: "after", copy: false });
	assert.deepEqual(shape(p?.input as LayoutInput), ["r", ["a", "a2", "a3", "~a1"], ["b", "b1"], "c"]);
	const q = previewInput(build(tree), { ids: ["a3"], targetId: "a1", place: "before", copy: false });
	assert.deepEqual(shape(q?.input as LayoutInput), ["r", ["a", "~a3", "a1", "a2"], ["b", "b1"], "c"]);
});

test("child drop appends at the end; the root always takes a child", () => {
	const p = previewInput(build(tree), { ids: ["c"], targetId: "a", place: "child", copy: false });
	assert.deepEqual(shape(p?.input as LayoutInput), ["r", ["a", "a1", "a2", "a3", "~c"], ["b", "b1"]]);
	const own = previewInput(build(tree), { ids: ["a1"], targetId: "a", place: "child", copy: false });
	assert.deepEqual(shape(own?.input as LayoutInput), ["r", ["a", "a2", "a3", "~a1"], ["b", "b1"], "c"]);
	const root = previewInput(build(tree), { ids: ["b1"], targetId: "r", place: "before", copy: false });
	assert.deepEqual(shape(root?.input as LayoutInput), ["r", ["a", "a1", "a2", "a3"], "b", "c", "~b1"]);
	assert.equal(root?.parentId, "r");
});

test("a child drop opens a collapsed target", () => {
	const input = build(["r", ["a", "a1"], "b"], new Set(["a"]));
	input.children[0].children = []; // the renderer leaves hidden children out
	const p = previewInput(input, { ids: ["b"], targetId: "a", place: "child", copy: false });
	const a = (p?.input as LayoutInput).children[0];
	assert.equal(a.collapsed, false);
	assert.deepEqual(shape(a), ["a", "~b"]);
});

test("copy keeps the originals", () => {
	const p = previewInput(build(tree), { ids: ["a1"], targetId: "a3", place: "after", copy: true });
	assert.deepEqual(shape(p?.input as LayoutInput), ["r", ["a", "a1", "a2", "a3", "~a1"], ["b", "b1"], "c"]);
});

test("multi-select moves the topmost nodes in tree order, with their children", () => {
	const p = previewInput(build(tree), { ids: ["c", "b1", "a", "a2"], targetId: "b", place: "child", copy: false });
	assert.deepEqual(p?.tops, ["a", "b1", "c"]);
	assert.deepEqual(shape(p?.input), ["r", ["b", ["~a", "~a1", "~a2", "~a3"], "~b1", "~c"]]);
});

test("no preview for a drop into a dragged subtree or without anything to move", () => {
	assert.equal(previewInput(build(tree), { ids: ["a"], targetId: "a2", place: "child", copy: false }), null);
	assert.equal(previewInput(build(tree), { ids: ["a"], targetId: "a", place: "after", copy: false }), null);
	assert.equal(previewInput(build(tree), { ids: ["a"], targetId: "nope", place: "after", copy: false }), null);
	assert.equal(previewInput(build(tree), { ids: ["r"], targetId: "a", place: "child", copy: false }), null);
	assert.equal(previewInput(build(tree), { ids: ["zz"], targetId: "a", place: "child", copy: false }), null);
});

test("unchanged subtrees keep their input objects", () => {
	const input = build(tree);
	const p = previewInput(input, { ids: ["a2"], targetId: "a1", place: "before", copy: false });
	const out = p?.input as LayoutInput;
	assert.notEqual(out, input);
	assert.equal(out.children[1], input.children[1]); // b untouched
	assert.equal(out.children[2], input.children[2]); // c untouched
	assert.equal(input.children[0].children.length, 3); // the input is not mutated
});

test("the placeholder sits where the moved node lands", () => {
	const input = build(tree);
	const p = previewInput(input, { ids: ["a2"], targetId: "b1", place: "after", copy: false });
	const preview = layout(p?.input as LayoutInput, "right", []);
	const final = layout(build(["r", ["a", "a1", "a3"], ["b", "b1", "a2"], "c"]), "right", []);
	const ph = preview.nodes.get(phantomId("a2"));
	const real = final.nodes.get("a2");
	assert.deepEqual({ x: ph?.x, y: ph?.y }, { x: real?.x, y: real?.y });
	assert.deepEqual(preview.nodes.get("c"), final.nodes.get("c"));
});

test("re-laying out a preview on a large map only re-measures the changed paths", () => {
	// 10 branches x 10 children x 10 leaves: 1,111 nodes
	const kids: Spec[] = [];
	for (let i = 0; i < 10; i++) {
		const mid: Spec[] = [];
		for (let j = 0; j < 10; j++) {
			const leaves: Spec[] = [];
			for (let k = 0; k < 10; k++) leaves.push(`n${i}-${j}-${k}`);
			mid.push([`n${i}-${j}`, ...leaves]);
		}
		kids.push([`n${i}`, ...mid]);
	}
	const input = build(["r", ...kids]);
	const layouter = createLayouter();
	layouter.layout(input, "mindmap", []);
	const spec = { ids: ["n0-0"], targetId: "n5-5", place: "after" as const, copy: false };
	layouter.layout((previewInput(input, spec) as { input: LayoutInput }).input, "mindmap", []);
	const first = layouter.lastMeasured;
	// old parent chain (n0) + new chain (n5) + the phantom subtree (11 nodes)
	assert.ok(first <= 2 + 11, `measured ${first}`);
	layouter.layout((previewInput(input, { ...spec, targetId: "n7-1" }) as { input: LayoutInput }).input, "mindmap", []);
	assert.ok(layouter.lastMeasured <= 3, `measured ${layouter.lastMeasured}`);
});

test("connector ends sit on the facing borders", () => {
	const ends = connectorEnds({ x: 0, y: 0, width: 10, height: 10 }, { x: 30, y: 0, width: 10, height: 10 });
	assert.deepEqual(ends, { from: { x: 10, y: 5 }, to: { x: 30, y: 5 } });
	const diag = connectorEnds({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 40, width: 10, height: 10 });
	assert.deepEqual(diag, { from: { x: 5, y: 10 }, to: { x: 5, y: 40 } });
	assert.equal(connectorEnds({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }), null);
});

test("phantoms take their size at the depth they land on", () => {
	const seen: string[] = [];
	const sizeAt = (id: string, depth: number) => {
		seen.push(`${id}@${depth}`);
		return { width: 100 - depth * 10, height: 30 - depth };
	};
	const p = previewInput(build(tree), { ids: ["a"], targetId: "b1", place: "child", copy: false, sizeAt });
	assert.deepEqual(seen.sort(), ["a1@4", "a2@4", "a3@4", "a@3"]);
	const b1 = (p?.input as LayoutInput).children[0].children[0];
	assert.equal(b1.id, "b1");
	assert.deepEqual(b1.children[0].size, { width: 70, height: 27 });
	assert.deepEqual(b1.children[0].children[0].size, { width: 60, height: 26 });
});
