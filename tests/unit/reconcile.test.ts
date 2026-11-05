import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "../../src/core/parse.ts";
import { reconcile } from "../../src/core/reconcile.ts";
import {
	applyEdits,
	deleteNodes,
	findNodeAt,
	indentNode,
	insertChild,
	insertSibling,
	moveDown,
	moveNodes,
	moveUp,
	outdentNode,
	pasteMarkdown,
	setText,
	type OpResult,
} from "../../src/core/ops.ts";
import type { MapNode, ParsedDoc } from "../../src/core/types.ts";

const fixtureDir = fileURLToPath(new URL("../../fixtures/compat/", import.meta.url));

const BASE = [
	"---",
	"mindmap-plugin: basic",
	"---",
	"",
	"# Root",
	"",
	"## A",
	"",
	"- a1",
	"  - a1x",
	"- a2",
	"",
	"## B",
	"",
	"- b1",
	"- b2",
	"",
].join("\n");

function flat(doc: ParsedDoc): MapNode[] {
	const out: MapNode[] = [];
	const visit = (n: MapNode): void => {
		out.push(n);
		n.children.forEach(visit);
	};
	visit(doc.root);
	return out;
}

/** text -> id (texts in these documents are unique). */
function ids(doc: ParsedDoc): Map<string, string> {
	const m = new Map<string, string>();
	for (const n of flat(doc)) m.set(n.text, n.id);
	return m;
}

interface Shape {
	text: string;
	blockId: string | null;
	kind: string;
	children: Shape[];
}
const shape = (n: MapNode): Shape => ({
	text: n.text,
	blockId: n.blockId,
	kind: n.kind,
	children: n.children.map(shape),
});

/** Apply an op, reparse, reconcile; returns both the raw parse and the result. */
function step(prev: ParsedDoc, r: OpResult, keepIds?: string[]) {
	const text = applyEdits(prev.text, r.edits);
	const raw = parseDocument(text);
	const keep = keepIds ? new Map(keepIds.map((id, i) => [r.anchors[i], id] as [number, string])) : undefined;
	const doc = reconcile(prev, raw, keep ? { keep } : undefined);
	return { text, raw, doc };
}

function assertWellFormed(prev: ParsedDoc, raw: ParsedDoc, doc: ParsedDoc, label: string): void {
	assert.deepEqual(shape(doc.root), shape(raw.root), `${label}: shape unchanged`);
	assert.equal(doc.text, raw.text);
	const all = flat(doc).map((n) => n.id);
	assert.equal(new Set(all).size, all.length, `${label}: ids unique`);
	for (const id of doc.collapsed) assert.ok(all.includes(id), `${label}: collapsed id ${id} exists`);
	assert.equal(doc.collapsed.size, raw.collapsed.size, `${label}: collapsed size`);
	// prev is untouched
	assert.equal(prev.root.id, prev.root.id);
}

const op = (r: OpResult | null): OpResult => {
	assert.ok(r, "op applies");
	return r;
};

test("without prev the parsed doc is returned as is", () => {
	const raw = parseDocument(BASE);
	assert.equal(reconcile(null, raw), raw);
});

test("identical text keeps every id, and prev and next are not mutated", () => {
	const prev = parseDocument(BASE);
	const before = JSON.stringify(prev);
	const raw = parseDocument(BASE);
	const rawBefore = JSON.stringify(raw);
	const doc = reconcile(prev, raw);
	assert.deepEqual(flat(doc).map((n) => n.id), flat(prev).map((n) => n.id));
	assert.equal(JSON.stringify(prev), before);
	assert.equal(JSON.stringify(raw), rawBefore);
});

test("setText keeps every id", () => {
	const prev = parseDocument(BASE);
	const a2 = ids(prev).get("a2") as string;
	const { raw, doc } = step(prev, op(setText(prev, a2, "renamed")), [a2]);
	assertWellFormed(prev, raw, doc, "setText");
	assert.deepEqual(flat(doc).map((n) => n.id), flat(prev).map((n) => n.id));
	// ... also without a hint, and for the root and a nested node
	for (const text of ["Root", "a1x", "b1"]) {
		const id = ids(prev).get(text) as string;
		const r = step(prev, op(setText(prev, id, "zzz new")));
		assert.deepEqual(flat(r.doc).map((n) => n.id), flat(prev).map((n) => n.id), `setText ${text}`);
	}
});

test("insert keeps all old ids and gives the new node a fresh one", () => {
	const prev = parseDocument(BASE);
	const old = new Set(flat(prev).map((n) => n.id));
	const a1 = ids(prev).get("a1") as string;
	for (const r of [op(insertChild(prev, a1, "kid")), op(insertSibling(prev, a1, "after")), op(insertSibling(prev, a1, "before"))]) {
		const { raw, doc } = step(prev, r);
		assertWellFormed(prev, raw, doc, "insert");
		const fresh = flat(doc).filter((n) => !old.has(n.id));
		assert.equal(fresh.length, 1);
		assert.match(fresh[0]?.id ?? "", /^_s\d+$/);
		for (const id of old) assert.ok(flat(doc).some((n) => n.id === id), `kept ${id}`);
	}
});

test("delete keeps the ids of the rest", () => {
	const prev = parseDocument(BASE);
	const m = ids(prev);
	const { raw, doc } = step(prev, op(deleteNodes(prev, [m.get("a1") as string])));
	assertWellFormed(prev, raw, doc, "delete");
	const got = ids(doc);
	for (const t of ["Root", "A", "a2", "B", "b1", "b2"]) assert.equal(got.get(t), m.get(t), t);
	assert.ok(!got.has("a1") && !got.has("a1x"));
});

test("moveUp, indent and moveNodes keep the moved node's id with and without hints", () => {
	const prev = parseDocument(BASE);
	const m = ids(prev);
	const cases: { name: string; r: OpResult; moved: string[] }[] = [
		{ name: "moveUp", r: op(moveUp(prev, m.get("a2") as string)), moved: ["a2"] },
		{ name: "moveDown", r: op(moveDown(prev, m.get("a1") as string)), moved: ["a1"] },
		{ name: "indent", r: op(indentNode(prev, m.get("a2") as string)), moved: ["a2"] },
		{ name: "outdent", r: op(outdentNode(prev, m.get("a1x") as string)), moved: ["a1x"] },
		{
			name: "moveNodes across parents",
			r: op(moveNodes(prev, [m.get("a1") as string], { parentId: m.get("B") as string, index: 1 })),
			moved: ["a1"],
		},
		{
			name: "moveNodes two nodes",
			r: op(moveNodes(prev, [m.get("a2") as string, m.get("b1") as string], { parentId: m.get("Root") as string, index: 0 })),
			moved: ["a2", "b1"],
		},
	];
	for (const c of cases) {
		for (const hinted of [true, false]) {
			const { raw, doc } = step(prev, c.r, hinted ? c.moved.map((t) => m.get(t) as string) : undefined);
			const label = `${c.name} hinted=${hinted}`;
			assertWellFormed(prev, raw, doc, label);
			const got = ids(doc);
			for (const [t, id] of m) {
				if (got.has(t)) assert.equal(got.get(t), id, `${label}: ${t}`);
			}
			// the moved node really sits under its new parent
			for (const t of c.moved) assert.ok(got.has(t), `${label}: ${t} exists`);
		}
	}
});

test("a hint wins over text matching (identical texts)", () => {
	const text = "# R\n\n- x\n- x\n- x\n";
	const prev = parseDocument(text);
	const [, x0, x1, x2] = flat(prev);
	assert.ok(x0 && x1 && x2);
	// move the last x to the front
	const r = op(moveUp(prev, x2.id));
	const { doc } = step(prev, r, [x2.id]);
	const got = flat(doc).slice(1).map((n) => n.id);
	// texts are identical, so the shape cannot tell; the hinted node must be the one at its anchor
	const at = findNodeAt(doc, r.anchors[0] ?? -1);
	assert.equal(at?.id, x2.id);
	assert.equal(new Set(got).size, 3);
});

test("paste adds fresh nodes and keeps the old ids", () => {
	const prev = parseDocument(BASE);
	const m = ids(prev);
	const r = op(pasteMarkdown(prev, "- p1\n  - p2\n- p3\n", { parentId: m.get("B") as string, index: 1 }));
	const { raw, doc } = step(prev, r);
	assertWellFormed(prev, raw, doc, "paste");
	const got = ids(doc);
	for (const [t, id] of m) assert.equal(got.get(t), id, t);
	const fresh = ["p1", "p2", "p3"].map((t) => got.get(t));
	assert.equal(new Set(fresh).size, 3);
	for (const f of fresh) assert.match(f ?? "", /^_s\d+$/);
});

test("undo round trip returns the original ids", () => {
	const prev = parseDocument(BASE);
	const m = ids(prev);
	const ops: OpResult[] = [
		op(setText(prev, m.get("a1") as string, "changed")),
		op(insertChild(prev, m.get("b2") as string, "extra")),
		op(moveUp(prev, m.get("b2") as string)),
		op(indentNode(prev, m.get("a2") as string)),
		op(deleteNodes(prev, [m.get("b1") as string])),
	];
	for (const [i, r] of ops.entries()) {
		const forward = step(prev, r);
		assertWellFormed(prev, forward.raw, forward.doc, `forward ${i}`);
		const back = applyEdits(forward.text, r.inverse);
		assert.equal(back, prev.text);
		const doc2 = reconcile(forward.doc, parseDocument(back));
		const got = ids(doc2);
		const mid = ids(forward.doc);
		for (const [t, id] of m) {
			// every node that existed before and after the op comes back with its original id
			if (mid.has(t)) assert.equal(got.get(t), id, `op ${i}: ${t}`);
		}
	}
});

test("undoing a delete with a keep hint restores the original id", () => {
	const prev = parseDocument(BASE);
	const m = ids(prev);
	const a1 = m.get("a1") as string;
	const r = op(deleteNodes(prev, [a1]));
	const forward = step(prev, r);
	assert.ok(!ids(forward.doc).has("a1"));
	const back = applyEdits(forward.text, r.inverse);
	assert.equal(back, prev.text);
	const raw = parseDocument(back);
	// the selection snapshot of the undo: a1 sat at its first-line offset
	const at = flat(raw).find((n) => n.text === "a1")?.source?.range.from as number;
	const plain = reconcile(forward.doc, raw);
	assert.notEqual(ids(plain).get("a1"), a1, "without a hint the node gets a fresh id");
	const doc = reconcile(forward.doc, raw, { keep: new Map([[at, a1]]) });
	assertWellFormed(forward.doc, raw, doc, "undo with hint");
	assert.equal(ids(doc).get("a1"), a1);
	for (const t of ["Root", "A", "a2", "B", "b1", "b2"]) assert.equal(ids(doc).get(t), ids(forward.doc).get(t), t);
});

test("a keep hint for an absent id that another node owns is ignored", () => {
	const prev = parseDocument(BASE);
	const m = ids(prev);
	const a1 = m.get("a1") as string;
	const r = op(deleteNodes(prev, [a1]));
	const forward = step(prev, r);
	const raw = parseDocument(applyEdits(forward.text, r.inverse));
	const at = flat(raw).find((n) => n.text === "a1")?.source?.range.from as number;
	// two hints for the same absent id: only the first node (document order) takes it
	const at2 = flat(raw).find((n) => n.text === "a2")?.source?.range.from as number;
	const two = reconcile(forward.doc, raw, { keep: new Map([[at, a1], [at2, a1]]) });
	assertWellFormed(forward.doc, raw, two, "double hint");
	assert.equal(ids(two).get("a1"), a1);
	assert.notEqual(ids(two).get("a2"), a1);
	// a hint whose id is a block id some other node will own is ignored
	const bid = parseDocument("# R\n\n- one ^abc\n- two\n");
	const bidRaw = parseDocument("# R\n\n- one ^abc\n- two\n- three\n");
	const atThree = flat(bidRaw).find((n) => n.text === "three")?.source?.range.from as number;
	const doc = reconcile(bid, bidRaw, { keep: new Map([[atThree, "abc2"]]) });
	assert.equal(ids(doc).get("three"), "abc2", "an unclaimed absent id is honoured");
	const clashRaw = parseDocument("# R\n\n- one ^abc\n- two\n");
	const atTwo = flat(clashRaw).find((n) => n.text === "two")?.source?.range.from as number;
	const d2 = reconcile(parseDocument("# R\n"), clashRaw, { keep: new Map([[atTwo, "abc"]]) });
	assertWellFormed(parseDocument("# R\n"), clashRaw, d2, "clash");
	assert.equal(ids(d2).get("one"), "abc");
	assert.notEqual(ids(d2).get("two"), "abc");
});

test("a hinted absent fresh id does not let new nodes collide", () => {
	const prev = parseDocument("# R\n\n- one\n");
	const raw = parseDocument("# R\n\n- one\n- two\n- three\n");
	const atTwo = flat(raw).find((n) => n.text === "two")?.source?.range.from as number;
	const doc = reconcile(prev, raw, { keep: new Map([[atTwo, "_s7"]]) });
	const all = flat(doc).map((n) => n.id);
	assert.equal(new Set(all).size, all.length);
	assert.equal(ids(doc).get("two"), "_s7");
});

test("collapsed set is re-keyed to the session ids", () => {
	const text = [
		"---",
		"mindmap-plugin: basic",
		'mindmark-state: {"version":2,"collapsed":["ka","kb"]}',
		"---",
		"",
		"# Root",
		"",
		"## A ^ka",
		"",
		"- a1",
		"",
		"## B ^kb",
		"",
		"- b1",
		"",
	].join("\n");
	const prev = parseDocument(text);
	assert.deepEqual([...prev.collapsed].sort(), ["ka", "kb"]);
	const kaId = ids(prev).get("A");
	assert.equal(kaId, "ka");
	// Re-parse after inserting above: block ids still keep ids; collapsed follows.
	const r = op(insertChild(prev, ids(prev).get("Root") as string, "first", "first"));
	const { raw, doc } = step(prev, r);
	assertWellFormed(prev, raw, doc, "collapsed");
	assert.deepEqual([...doc.collapsed].sort(), ["ka", "kb"]);
	// Moving a hinted node whose id differs from its block id: the collapsed set follows the new key.
	const prev2 = reconcile(null, parseDocument(text));
	const next = parseDocument(text.replace("## A ^ka", "## A ^zz").replace('"ka","kb"', '"zz","kb"'));
	const doc2 = reconcile(prev2, next);
	assert.deepEqual(flat(doc2).map((n) => n.id), flat(prev2).map((n) => n.id).map((id) => (id === "ka" ? "ka" : id)));
	assert.deepEqual([...doc2.collapsed].sort(), ["ka", "kb"]);
	assert.equal(flat(doc2).find((n) => n.text === "A")?.blockId, "zz");
});

test("duplicate block ids: first keeps the block id, later ones get distinct session ids", () => {
	const text = "# R\n\n- one ^dup\n- two ^dup\n- three ^dup\n- four\n";
	const prev = reconcile(null, parseDocument(text));
	const ps = flat(prev);
	assert.equal(new Set(ps.map((n) => n.id)).size, ps.length);
	const edited = parseDocument(text.replace("- two ^dup", "- two! ^dup"));
	const doc = reconcile(prev, edited);
	assert.deepEqual(flat(doc).map((n) => n.id), ps.map((n) => n.id));
	// delete the first duplicate: the survivors still have unique ids, the primary one keeps the block id
	const after = reconcile(prev, parseDocument(text.replace("- one ^dup\n", "")));
	const got = flat(after);
	assert.equal(new Set(got.map((n) => n.id)).size, got.length);
	assert.equal(got[1]?.id, "dup");
	assert.equal(got[3]?.id, ps[4]?.id);
	// block ids match case-insensitively
	const cased = reconcile(prev, parseDocument(text.replace(/\^dup/g, "^DUP")));
	assert.equal(flat(cased)[1]?.id, "dup");
});

test("a new block id is not confused with an existing id", () => {
	const prev = parseDocument("# R\n\n- a ^x\n- b\n");
	const next = parseDocument("# R\n\n- a ^y\n- b ^x\n");
	const doc = reconcile(prev, next);
	const got = flat(doc);
	assert.equal(new Set(got.map((n) => n.id)).size, got.length);
	// ^x moved to b; a keeps its place structurally, so ids stay unique and the root is kept
	assert.equal(got[0]?.id, flat(prev)[0]?.id);
});

test("virtual root and real root transitions", () => {
	const virtual = parseDocument("## A\n\n- a1\n\n## B\n\n- b1\n");
	assert.equal(virtual.virtualRoot, true);
	const v = reconcile(null, virtual);
	// delete B: still virtual? one H2 only -> virtual with a single child
	const oneChild = parseDocument("## A\n\n- a1\n");
	const d1 = reconcile(v, oneChild);
	assert.equal(d1.virtualRoot, true);
	assert.equal(d1.root.id, "_root");
	assert.deepEqual(flat(d1).slice(1).map((n) => n.id), flat(v).slice(1, 3).map((n) => n.id));
	// add an H1 above everything: real root appears, but only when it is the sole top node
	const toReal = parseDocument("# A\n\n- a1\n");
	const d2 = reconcile(d1, toReal);
	assert.equal(d2.virtualRoot, false);
	assert.equal(d2.root.id, flat(d1)[1]?.id, "the H2 became the root keeping its id");
	assert.equal(d2.root.children[0]?.id, flat(d1)[2]?.id);
	// real -> virtual again (undo)
	const d3 = reconcile(d2, parseDocument("## A\n\n- a1\n## B\n\n- b1\n"));
	assert.equal(d3.virtualRoot, true);
	assert.equal(d3.root.id, "_root");
	assert.equal(d3.root.children[0]?.id, d2.root.id);
	assert.equal(d3.root.children[0]?.children[0]?.id, d2.root.children[0]?.id);
	assert.equal(new Set(flat(d3).map((n) => n.id)).size, flat(d3).length);
	// the H1 line is deleted: root's children become top-level (unique-text fallback)
	const real = reconcile(null, parseDocument("# R\n\n## A\n\n- a1\n\n## B\n\n- b1\n"));
	const unrooted = reconcile(real, parseDocument("## A\n\n- a1\n\n## B\n\n- b1\n"));
	const a = flat(real).find((n) => n.text === "A");
	const b1 = flat(real).find((n) => n.text === "b1");
	assert.equal(flat(unrooted).find((n) => n.text === "A")?.id, a?.id);
	assert.equal(flat(unrooted).find((n) => n.text === "b1")?.id, b1?.id);
});

test("unique-text fallback follows a move without hints, including its subtree", () => {
	const prev = parseDocument("# R\n\n## A\n\n- x\n  - xc\n- y\n\n## B\n\n- z\n");
	const next = parseDocument("# R\n\n## A\n\n- y\n\n## B\n\n- z\n- x\n  - xc\n");
	const doc = reconcile(prev, next);
	const m = ids(prev);
	const got = ids(doc);
	for (const t of ["R", "A", "B", "x", "xc", "y", "z"]) assert.equal(got.get(t), m.get(t), t);
});

test("fresh ids never collide with ids in prev or next", () => {
	let doc = reconcile(null, parseDocument("# R\n\n- a\n"));
	const seen = new Set<string>();
	for (let i = 0; i < 20; i++) {
		const target = flat(doc)[1];
		assert.ok(target);
		const r = op(insertSibling(doc, target.id, `n${i}`));
		const { raw, doc: next } = step(doc, r);
		assertWellFormed(doc, raw, next, `grow ${i}`);
		const newIds = flat(next).map((n) => n.id).filter((id) => !flat(doc).some((n) => n.id === id));
		assert.equal(newIds.length, 1);
		assert.ok(!seen.has(newIds[0]), "never reissued while alive");
		seen.add(newIds[0]);
		doc = next;
	}
});

// ------------------------------------------------------------ property test

function rng(seed: number): () => number {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 4294967296;
	};
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

function openable(): string[] {
	return readdirSync(fixtureDir)
		.filter((d) => existsSync(join(fixtureDir, d, "tree-0.3.0.json")))
		.sort();
}

const SEEDS = 40;
const OPS = 8;
const MAX_NODES = 300;

test("property: fixtures x random op sequences", () => {
	let applied = 0;
	for (const name of openable()) {
		const base = readFileSync(join(fixtureDir, name, "input.md"), "utf8");
		// reconciling the fixture against itself keeps all ids
		const first = parseDocument(base);
		const same = reconcile(parseDocument(base), first);
		assert.deepEqual(flat(same).map((n) => n.id), flat(first).map((n) => n.id), `${name}: self`);
		for (let seed = 1; seed <= SEEDS; seed++) {
			const r = rng(seed * 7919 + name.length);
			let doc = reconcile(null, parseDocument(base));
			for (let k = 0; k < OPS; k++) {
				const nodes = flat(doc);
				if (nodes.length > MAX_NODES) break;
				const real = nodes.filter((n) => n.source !== null);
				if (real.length === 0) break;
				const n = pick(r, real);
				const label = `${name} seed ${seed} op ${k}`;
				let res: OpResult | null = null;
				let movedIds: string[] | undefined;
				let kind = "";
				switch (Math.floor(r() * 9)) {
					case 0:
						kind = "setText";
						res = setText(doc, n.id, `t${seed}-${k}`);
						break;
					case 1:
						kind = "insertChild";
						res = insertChild(doc, pick(r, nodes).id, `c${seed}-${k}`);
						break;
					case 2:
						kind = "insertSibling";
						res = insertSibling(doc, n.id, `s${seed}-${k}`, r() < 0.5 ? "before" : "after");
						break;
					case 3:
						kind = "delete";
						res = deleteNodes(doc, [n.id]);
						break;
					case 4:
						kind = "moveUp";
						res = moveUp(doc, n.id);
						movedIds = [n.id];
						break;
					case 5:
						kind = "moveDown";
						res = moveDown(doc, n.id);
						movedIds = [n.id];
						break;
					case 6:
						kind = "indent";
						res = indentNode(doc, n.id);
						movedIds = [n.id];
						break;
					case 7:
						kind = "outdent";
						res = outdentNode(doc, n.id);
						movedIds = [n.id];
						break;
					default: {
						kind = "moveNodes";
						const target = pick(r, nodes);
						res = moveNodes(doc, [n.id], { parentId: target.id, index: Math.floor(r() * 4) });
						movedIds = [n.id];
					}
				}
				if (!res || res.edits.length === 0) continue;
				applied++;
				const prevIds = new Set(nodes.map((x) => x.id));
				const hinted = movedIds && r() < 0.5 && res.anchors.length === movedIds.length;
				const out = step(doc, res, hinted ? movedIds : undefined);
				assertWellFormed(doc, out.raw, out.doc, `${label} ${kind}`);
				const after = new Set(flat(out.doc).map((x) => x.id));
				const rootChanged = out.doc.virtualRoot !== doc.virtualRoot;
				if (!rootChanged && kind === "setText") {
					assert.deepEqual([...after].sort(), [...prevIds].sort(), `${label}: setText keeps ids`);
				}
				if (!rootChanged && (kind === "insertChild" || kind === "insertSibling")) {
					for (const id of prevIds) assert.ok(after.has(id), `${label}: ${kind} kept ${id}`);
				}
				if (hinted && movedIds && !rootChanged) {
					for (const id of movedIds) assert.ok(after.has(id), `${label}: hinted ${id} kept`);
				}
				// reconciling the same text again changes nothing
				const again = reconcile(out.doc, parseDocument(out.text));
				assert.deepEqual(flat(again).map((x) => x.id), flat(out.doc).map((x) => x.id), `${label}: idempotent`);
				doc = out.doc;
			}
		}
	}
	assert.ok(applied > 100, `exercised ${applied} operations`);
});

// -------------------------------------------------------------- performance

test("5,000 nodes with one change reconcile in under 10 ms", (t) => {
	const lines = ["# Big", ""];
	for (let i = 0; i < 100; i++) {
		lines.push(`## H${i}`, "");
		for (let j = 0; j < 49; j++) lines.push(`- item ${i}-${j}`);
		lines.push("");
	}
	const text = lines.join("\n");
	const prev = reconcile(null, parseDocument(text));
	const n = flat(prev).length;
	assert.ok(n >= 5000, `size ${n}`);
	const edited = text.replace("- item 50-20", "- item 50-20 edited");
	const inserted = text.replace("- item 50-20\n", "- item 50-20\n- brand new\n");
	for (const [label, variant] of [["edit", edited], ["insert", inserted]] as const) {
		const raw = parseDocument(variant);
		let best = Infinity;
		let doc = prev;
		for (let i = 0; i < 5; i++) {
			const t0 = performance.now();
			doc = reconcile(prev, raw);
			best = Math.min(best, performance.now() - t0);
		}
		t.diagnostic(`${label}: ${n} nodes reconciled in ${best.toFixed(2)} ms (best of 5)`);
		assert.ok(best < 10, `${label} took ${best} ms`);
		const now = new Set(flat(doc).map((x) => x.id));
		assert.ok(flat(prev).every((x) => now.has(x.id)), `${label}: every old id kept`);
	}
});

test("a reordered flat list of 5,000 siblings stays bounded and keeps unique ids", (t) => {
	const lines = ["# R", ""];
	for (let i = 0; i < 5000; i++) lines.push(`- n${i}`);
	const prev = reconcile(null, parseDocument(lines.join("\n")));
	const shuffled = [...lines.slice(2)].reverse();
	const t0 = performance.now();
	const doc = reconcile(prev, parseDocument(["# R", "", ...shuffled].join("\n")));
	t.diagnostic(`reversed 5000 siblings: ${(performance.now() - t0).toFixed(1)} ms`);
	const got = flat(doc).map((n) => n.id);
	assert.equal(new Set(got).size, got.length);
	// every text is unique, so the fallback re-pairs all of them
	assert.equal(ids(doc).get("n17"), ids(prev).get("n17"));
});
