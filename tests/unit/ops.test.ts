import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "../../src/core/parse.ts";
import {
	adoptSiblings,
	applyEdits,
	assignBlockId,
	deleteNodes,
	findNodeAt,
	indentNode,
	insertChild,
	insertNodes,
	insertSibling,
	moveDown,
	moveNodes,
	moveUp,
	outdentNode,
	pasteMarkdown,
	setText,
	uniqueBlockId,
	type OpResult,
} from "../../src/core/ops.ts";
import type { MapNode, ParsedDoc, TextEdit } from "../../src/core/types.ts";

const fixtureDir = fileURLToPath(new URL("../../fixtures/compat/", import.meta.url));

function openable(): string[] {
	return readdirSync(fixtureDir)
		.filter((d) => existsSync(join(fixtureDir, d, "tree-0.3.0.json")))
		.sort();
}

const load = (name: string): string => readFileSync(join(fixtureDir, name, "input.md"), "utf8");

// ------------------------------------------------------------------ model

interface Shape {
	text: string;
	blockId: string | null;
	children: Shape[];
}

interface Model {
	root: Shape;
	virtual: boolean;
}

function shapeOf(node: MapNode): Shape {
	return { text: node.text, blockId: node.blockId, children: node.children.map(shapeOf) };
}

function modelOf(doc: ParsedDoc): Model {
	return { root: shapeOf(doc.root), virtual: doc.virtualRoot };
}

function clone(m: Model): Model {
	return structuredClone(m);
}

/** Path (child indexes from the root) of every node, in document order. */
function paths(node: MapNode, at: number[] = [], out: number[][] = []): number[][] {
	out.push(at);
	node.children.forEach((c, i) => paths(c, [...at, i], out));
	return out;
}

const nodeAt = (root: MapNode, path: number[]): MapNode => path.reduce((n, i) => n.children[i], root);
const shapeAt = (root: Shape, path: number[]): Shape => path.reduce((n, i) => n.children[i], root);

/** The reparsed tree must equal the model; a virtual root left with one H1 child is replaced by it. */
function assertShape(after: ParsedDoc, model: Model, label: string): void {
	const got = shapeOf(after.root);
	if (model.virtual && !after.virtualRoot) {
		assert.equal(model.root.children.length, 1, `${label}: root became real`);
		assert.deepEqual(got, model.root.children[0], label);
		return;
	}
	assert.equal(after.virtualRoot, model.virtual, `${label}: virtual root`);
	if (model.virtual) assert.deepEqual(got.children, model.root.children, label);
	else assert.deepEqual(got, model.root, label);
}

function assertEditsWellFormed(text: string, edits: readonly TextEdit[], label: string): void {
	let pos = 0;
	for (const e of edits) {
		assert.ok(e.from >= pos && e.to >= e.from && e.to <= text.length, `${label}: edits sorted and disjoint`);
		pos = e.to;
	}
}

/** Apply, check the inverse restores the text byte for byte, and return the result. */
function check(doc: ParsedDoc, r: OpResult, label: string): { text: string; doc: ParsedDoc } {
	assertEditsWellFormed(doc.text, r.edits, label);
	const text = applyEdits(doc.text, r.edits);
	assertEditsWellFormed(text, r.inverse, `${label} (inverse)`);
	assert.equal(applyEdits(text, r.inverse), doc.text, `${label}: inverse restores the text`);
	if (doc.lineEnding === "\r\n") assert.ok(!/(^|[^\r])\n/.test(text), `${label}: CRLF kept`);
	const after = parseDocument(text);
	for (const a of r.anchors) assert.ok(findNodeAt(after, a), `${label}: anchor ${a} starts a node`);
	return { text, doc: after };
}

const TEXTS = ["new *text* [[L]]", "", "two\nlines", "```\ncode\n```", "| a | b |\n| --- | --- |\n| 1 | 2 |", "[ ] task"];

const expectedText = (value: string): string => value.trim();

interface Stats {
	[op: string]: { ok: number; none: number };
}
const stats: Stats = {};
function count(op: string, r: unknown): void {
	stats[op] ??= { ok: 0, none: 0 };
	if (r) stats[op].ok++;
	else stats[op].none++;
}

function removeAt(m: Model, path: number[]): Shape {
	const parent = shapeAt(m.root, path.slice(0, -1));
	return parent.children.splice(path[path.length - 1], 1)[0];
}

/** Runs every operation on every node of one document and checks the properties. */
function exercise(name: string, text: string): void {
	const doc = parseDocument(text);
	const all = paths(doc.root);
	const base = modelOf(doc);

	for (const path of all) {
		const node = nodeAt(doc.root, path);
		const label = (op: string): string => `${name} ${op} [${path.join(",")}] "${node.text.slice(0, 20)}"`;

		// setText
		for (const value of TEXTS) {
			const r = setText(doc, node.id, value);
			count("setText", r);
			if (!r) continue;
			const out = check(doc, r, label(`setText ${JSON.stringify(value)}`));
			const m = clone(base);
			const s = shapeAt(m.root, path);
			s.text = expectedText(value);
			if (node.source === null && value.trim() !== "") m.virtual = false;
			assertShape(out.doc, m, label(`setText ${JSON.stringify(value)}`));
			if (node.source) {
				const s0 = node.source;
				// Only the node's own lines change.
				for (const e of r.edits) assert.ok(e.from >= s0.range.from && e.to <= s0.range.to, label("setText stays in its lines"));
			}
		}

		// insert child and sibling
		for (const at of ["first", "last"] as const) {
			const r = insertChild(doc, node.id, "fresh", at);
			count("insertChild", r);
			if (!r) continue;
			const out = check(doc, r, label(`insertChild ${at}`));
			const m = clone(base);
			const s = shapeAt(m.root, path);
			s.children.splice(at === "first" ? 0 : s.children.length, 0, { text: "fresh", blockId: null, children: [] });
			assertShape(out.doc, m, label(`insertChild ${at}`));
			assert.equal(findNodeAt(out.doc, r.anchors[0])?.text, "fresh");
			for (const e of r.edits) assert.ok(e.from === e.to || doc.text.slice(e.from, e.to) === "", label("insert only inserts"));
		}
		if (path.length > 0) {
			for (const side of ["before", "after"] as const) {
				const r = insertSibling(doc, node.id, "sib", side);
				count("insertSibling", r);
				if (!r) continue;
				const out = check(doc, r, label(`insertSibling ${side}`));
				const m = clone(base);
				const parent = shapeAt(m.root, path.slice(0, -1));
				parent.children.splice(path[path.length - 1] + (side === "after" ? 1 : 0), 0, { text: "sib", blockId: null, children: [] });
				assertShape(out.doc, m, label(`insertSibling ${side}`));
				assert.equal(findNodeAt(out.doc, r.anchors[0])?.text, "sib");
			}
		}

		if (path.length === 0) continue;

		// delete
		{
			const r = deleteNodes(doc, [node.id]);
			count("delete", r);
			assert.ok(r, label("delete"));
			const out = check(doc, r, label("delete"));
			const m = clone(base);
			removeAt(m, path);
			assertShape(out.doc, m, label("delete"));
			// Only the subtree's lines and blank lines go.
			for (const e of r.edits) {
				const gone = doc.text.slice(e.from, e.to);
				const sub = doc.text.slice(node.source!.range.from, node.source!.subtreeTo);
				assert.ok(gone.trim() === "" || sub.includes(gone.trim()), label("delete removes only the subtree"));
			}
		}

		// moves
		const moves: [string, (d: ParsedDoc, id: string) => OpResult | null, (m: Model) => void][] = [
			["moveUp", moveUp, (m) => {
				const p = shapeAt(m.root, path.slice(0, -1));
				const i = path[path.length - 1];
				[p.children[i - 1], p.children[i]] = [p.children[i], p.children[i - 1]];
			}],
			["moveDown", moveDown, (m) => {
				const p = shapeAt(m.root, path.slice(0, -1));
				const i = path[path.length - 1];
				[p.children[i + 1], p.children[i]] = [p.children[i], p.children[i + 1]];
			}],
			["indent", indentNode, (m) => {
				const i = path[path.length - 1];
				const p = shapeAt(m.root, path.slice(0, -1));
				const prev = p.children[i - 1];
				prev.children.push(removeAt(m, path));
			}],
			["outdent", outdentNode, (m) => {
				const pPath = path.slice(0, -1);
				const moved = removeAt(m, path);
				const g = shapeAt(m.root, pPath.slice(0, -1));
				g.children.splice(pPath[pPath.length - 1] + 1, 0, moved);
			}],
		];
		for (const [op, fn, apply] of moves) {
			const r = fn(doc, node.id);
			count(op, r);
			if (!r) continue;
			const out = check(doc, r, label(op));
			const m = clone(base);
			apply(m);
			assertShape(out.doc, m, label(op));
			assert.equal(findNodeAt(out.doc, r.anchors[0])?.text, node.text, label(`${op} anchor`));
		}

		// drag and drop to every place
		for (const target of all) {
			const parent = nodeAt(doc.root, target);
			const inside = target.length >= path.length && path.every((v, i) => target[i] === v);
			if (inside) continue;
			const remaining = parent.children.filter((c) => c !== node).length;
			for (let index = 0; index <= remaining; index++) {
				const r = moveNodes(doc, [node.id], { parentId: parent.id, index });
				count("moveNodes", r);
				if (!r) continue;
				const lbl = label(`move to [${target.join(",")}]@${index}`);
				const out = check(doc, r, lbl);
				const m = clone(base);
				const moved = removeAt(m, path);
				// The parent's path may shift when the moved node came before it.
				const p = shapeAt(m.root, shiftedPath(target, path));
				p.children.splice(index, 0, moved);
				assertShape(out.doc, m, lbl);
			}
		}

		// block id
		{
			const r = assignBlockId(doc, node.id, "zq9");
			count("assignBlockId", r);
			if (r) {
				const out = check(doc, r, label("assignBlockId"));
				const m = clone(base);
				shapeAt(m.root, path).blockId = "zq9";
				assertShape(out.doc, m, label("assignBlockId"));
			} else {
				assert.ok(node.blockId !== null || node.kind === "code", label("assignBlockId refused"));
			}
		}

		// adopt siblings
		for (const which of ["next", "all"] as const) {
			const r = adoptSiblings(doc, node.id, which);
			count("adoptSiblings", r);
			if (!r) continue;
			const lbl = label(`adopt ${which}`);
			const out = check(doc, r, lbl);
			const m = clone(base);
			const p = shapeAt(m.root, path.slice(0, -1));
			const i = path[path.length - 1];
			const me = p.children[i];
			const others = p.children.filter((_c, k) => k !== i && (which === "all" || k > i));
			p.children = p.children.filter((c) => !others.includes(c));
			me.children.push(...others);
			assertShape(out.doc, m, lbl);
		}
	}

	// paste under every node
	for (const path of all) {
		const node = nodeAt(doc.root, path);
		for (const frag of ["one line", "- p\n    - q\n- r ^zz1", "# H\n\n## H2\n\n- x\n\ntext"]) {
			const r = pasteMarkdown(doc, frag, { parentId: node.id, index: node.children.length });
			count("paste", r);
			if (!r) continue;
			const lbl = `${name} paste ${JSON.stringify(frag)} under [${path.join(",")}]`;
			const out = check(doc, r, lbl);
			const m = clone(base);
			const f = parseDocument("\n" + frag);
			const tops = f.virtualRoot ? f.root.children : [f.root];
			shapeAt(m.root, path).children.push(...tops.map(shapeOf));
			assertShape(out.doc, m, lbl);
		}
	}

	// delete pairs
	for (let i = 1; i < all.length; i++) {
		for (let j = i + 1; j < all.length; j++) {
			const a = nodeAt(doc.root, all[i]);
			const b = nodeAt(doc.root, all[j]);
			const r = deleteNodes(doc, [a.id, b.id]);
			count("deletePair", r);
			assert.ok(r);
			const out = check(doc, r, `${name} delete ${all[i].join(",")} + ${all[j].join(",")}`);
			const m = clone(base);
			const nested = all[j].length > all[i].length && all[i].every((v, k) => all[j][k] === v);
			if (!nested) removeAt(m, all[j]);
			removeAt(m, all[i]);
			assertShape(out.doc, m, `${name} delete ${all[i].join(",")} + ${all[j].join(",")}`);
		}
	}
}

/** `target` after removing the node at `removed` (a later sibling on the way shifts up by one). */
function shiftedPath(target: number[], removed: number[]): number[] {
	const out = [...target];
	const depth = removed.length - 1;
	const samePrefix = removed.slice(0, depth).every((v, i) => target[i] === v);
	if (samePrefix && target.length > depth && target[depth] > removed[depth]) out[depth]--;
	return out;
}

for (const name of openable()) {
	test(`ops on fixture ${name}: inverse restores, re-parse matches the model`, () => {
		exercise(name, load(name));
	});
}

test("operation coverage", (t) => {
	for (const [op, s] of Object.entries(stats)) t.diagnostic(`${op}: ${s.ok} done, ${s.none} refused`);
	for (const op of ["setText", "insertChild", "insertSibling", "moveNodes", "paste"]) {
		const s = stats[op];
		assert.ok(s && s.ok > 4 * s.none, `${op} mostly applies: ${JSON.stringify(s)}`);
	}
});

// ------------------------------------------------------------------ generated documents

function rng(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/** A random but well-formed note mixing headings, list styles, paragraphs, code and tables. */
function generate(seed: number): string {
	const r = rng(seed);
	const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
	const eol = r() < 0.25 ? "\r\n" : "\n";
	const unit = pick(["  ", "    ", "\t"]);
	const marker = pick(["-", "*", "+", "1."]);
	const lines: string[] = ["---", "mindmap-plugin: basic", "---", ""];
	if (r() < 0.6) lines.push("# Root", "");
	let level = 1;
	let n = 0;
	for (let s = 0; s < 3; s++) {
		if (r() < 0.7) {
			level = Math.min(6, Math.max(2, level + pick([-1, 0, 1])));
			lines.push(`${"#".repeat(level)} H${s}${r() < 0.2 ? ` ^h${s}` : ""}`, "");
		}
		if (r() < 0.3) lines.push(`Para ${s} text.`, "");
		let depth = 0;
		for (let i = 0; i < 4; i++) {
			depth = Math.max(0, Math.min(depth + pick([-1, 0, 1]), 3));
			const m = marker === "1." ? `${i + 1}.` : marker;
			const kind = r();
			const pad = unit.repeat(depth);
			if (kind < 0.1) {
				lines.push(`${pad}-`, `${pad}  \`\`\`js`, `${pad}  x = ${n++}`, `${pad}  \`\`\``);
			} else if (kind < 0.15) {
				lines.push(`${pad}${m}`);
			} else {
				lines.push(`${pad}${m} item ${n++}${r() < 0.15 ? ` ^b${n}` : ""}`);
			}
		}
		lines.push("");
		if (r() < 0.2) lines.push("| a | b |", "| --- | --- |", "| 1 | 2 |", "");
	}
	return lines.join(eol);
}

test("generated documents: every operation inverts and keeps the structure", () => {
	for (let seed = 1; seed <= 80; seed++) {
		const text = generate(seed);
		exercise(`seed ${seed}`, text);
	}
});

// ------------------------------------------------------------------ minimal change

function changedLines(before: string, after: string): { removed: string[]; added: string[] } {
	const a = before.split(/\r?\n/);
	const b = after.split(/\r?\n/);
	const removed = a.filter((l) => !b.includes(l));
	const added = b.filter((l) => !a.includes(l));
	return { removed, added };
}

const DOC = "---\nmindmap-plugin: basic\n---\n\n# Root\n\n## A\n\n* star\n+ plus\n\n## B\n\n1. one\n2. two\n    3) inner\n\n## C\n\n- a\n  - b\n  - c\n";

function byText(doc: ParsedDoc, text: string): MapNode {
	let found: MapNode | null = null;
	const visit = (n: MapNode): void => {
		if (n.text === text) found ??= n;
		n.children.forEach(visit);
	};
	visit(doc.root);
	assert.ok(found, `node "${text}"`);
	return found;
}

function run(text: string, op: (doc: ParsedDoc) => OpResult | null): string {
	const doc = parseDocument(text);
	const r = op(doc);
	assert.ok(r);
	return check(doc, r, "minimal").text;
}

test("setText changes only the text span: markers, numbers, indent, block id stay", () => {
	const text = "# Root\n\n  * star ^s1\n3) third\n\t- [ ] task\n";
	assert.equal(run(text, (d) => setText(d, byText(d, "star").id, "STAR")), "# Root\n\n  * STAR ^s1\n3) third\n\t- [ ] task\n");
	assert.equal(run(text, (d) => setText(d, byText(d, "third").id, "")), "# Root\n\n  * star ^s1\n3)\n\t- [ ] task\n");
	assert.equal(run(text, (d) => setText(d, byText(d, "[ ] task").id, "[x] task")), "# Root\n\n  * star ^s1\n3) third\n\t- [x] task\n");
	assert.equal(run("# R\n-\n- ^k\n", (d) => setText(d, d.root.children[0].id, "a")), "# R\n- a\n- ^k\n");
	assert.equal(run("# R\n-\n- ^k\n", (d) => setText(d, d.root.children[1].id, "b")), "# R\n-\n- b ^k\n");
	assert.equal(run("# R\n- \\> q\n", (d) => setText(d, d.root.children[0].id, "> z")), "# R\n- \\> z\n");
	assert.equal(run("# R\n- x\n", (d) => setText(d, d.root.children[0].id, "a\nb")), "# R\n- a<br>b\n");
	assert.equal(run("# R\n\n## H ^h\n", (d) => setText(d, d.root.children[0].id, "")), "# R\n\n## ^h\n");
});

test("setText on code blocks, tables and multi-line items", () => {
	const code = "# R\n\n-\n  ```js\n  let a = 1;\n  ```\n  ^code1\n";
	assert.equal(
		run(code, (d) => setText(d, "code1", "```js\nlet b = 2;\n```")),
		"# R\n\n-\n  ```js\n  let b = 2;\n  ```\n  ^code1\n",
	);
	assert.equal(run(code, (d) => setText(d, "code1", "plain")), "# R\n\n- plain ^code1\n");
	assert.equal(run("# R\n\n- a\ncontinued\n- b\n", (d) => setText(d, d.root.children[0].id, "one")), "# R\n\n- one\n- b\n");
	assert.equal(run("# R\n\nline one\nline two\n", (d) => setText(d, d.root.children[0].id, "x")), "# R\n\nx\n");
	assert.equal(
		run("# R\n\n- item\n", (d) => setText(d, d.root.children[0].id, "| a |\n| - |")),
		"# R\n\n-\n    | a |\n    | - |\n",
	);
});

test("new items follow their siblings: marker, next number, indent width", () => {
	const after = (text: string, name: string, side: "before" | "after" = "after"): string =>
		run(text, (d) => insertSibling(d, byText(d, name).id, "new", side));
	assert.ok(after(DOC, "star").includes("* star\n* new\n+ plus\n"));
	assert.ok(after(DOC, "two").includes("1. one\n2. two\n    3) inner\n3. new\n"));
	assert.ok(after(DOC, "inner").includes("    3) inner\n    4) new\n"));
	assert.ok(after(DOC, "b").includes("- a\n  - b\n  - new\n  - c\n"));
	assert.ok(after(DOC, "one", "before").includes("## B\n\n1. new\n1. one\n"));
	const child = run(DOC, (d) => insertChild(d, byText(d, "c").id, "deeper"));
	assert.ok(child.includes("  - c\n    - deeper\n"), "2-space document keeps 2-space steps");
	const { removed } = changedLines(DOC, child);
	assert.deepEqual(removed, []);
});

test("new nodes without siblings follow section 6 and headLevel", () => {
	const empty = "---\nmindmap-plugin: basic\n---\n";
	const doc = parseDocument(empty);
	let r = insertChild(doc, doc.root.id, "first");
	assert.ok(r);
	assert.equal(applyEdits(empty, r.edits), "---\nmindmap-plugin: basic\n---\n\n- first\n");
	r = insertChild(doc, doc.root.id, "first", "last", { headLevel: 2 });
	assert.ok(r);
	assert.equal(applyEdits(empty, r.edits), "---\nmindmap-plugin: basic\n---\n\n## first\n");
	const fixture = load("empty-body");
	const fd = parseDocument(fixture);
	r = insertChild(fd, fd.root.id, "x");
	assert.ok(r);
	assert.ok(applyEdits(fixture, r.edits).endsWith("---\n\n- x\n"));
	const h = "# Root\n";
	assert.equal(run(h, (d) => insertChild(d, d.root.id, "a", "last", { headLevel: 2 })), "# Root\n\n## a\n");
	assert.equal(run(h, (d) => insertChild(d, d.root.id, "a")), "# Root\n- a\n");
	assert.equal(run(h, (d) => insertChild(d, d.root.id, "```\nc\n```", "last", { headLevel: 3 })), "# Root\n-\n  ```\n  c\n  ```\n");
	assert.equal(run("# R\n\n## A\n", (d) => insertSibling(d, byText(d, "A").id, "B")), "# R\n\n## A\n\n## B\n");
});

test("CRLF documents get CRLF in every inserted line", () => {
	const text = load("crlf");
	const out = run(text, (d) => pasteMarkdown(d, "- p\n    - q", { parentId: d.root.id, index: 1 }));
	assert.ok(out.includes("- a\r\n- p\r\n    - q\r\n- b\r\n"));
	assert.ok(!/(^|[^\r])\n/.test(out));
});

test("move up and down keep every line byte for byte at the same depth", () => {
	for (const name of ["star", "plus", "one", "two", "b", "c"]) {
		for (const op of [moveUp, moveDown]) {
			const doc = parseDocument(DOC);
			const r = op(doc, byText(doc, name).id);
			if (!r) continue;
			const out = applyEdits(DOC, r.edits);
			const sorted = (s: string): string[] => s.split("\n").filter((l) => l.trim() !== "").sort();
			assert.deepEqual(sorted(out), sorted(DOC), `${op.name} ${name}`);
		}
	}
	assert.ok(run(DOC, (d) => moveDown(d, byText(d, "star").id)).includes("+ plus\n* star\n"));
	assert.ok(run(DOC, (d) => moveUp(d, byText(d, "B").id)).includes("## B\n\n1. one\n2. two\n    3) inner\n\n## A\n\n* star\n+ plus\n\n## C"));
});

test("depth changes rewrite only the prefixes", () => {
	assert.equal(run(DOC, (d) => indentNode(d, byText(d, "c").id)), DOC.replace("  - c\n", "    - c\n"));
	assert.equal(run(DOC, (d) => outdentNode(d, byText(d, "b").id)), DOC.replace("- a\n  - b\n  - c\n", "- a\n  - c\n- b\n"));
	// A heading moved under a list item becomes a list item; its content moves along.
	const text = "# R\n\n## A\n\n- a1\n\n## B\n\nPara\n\n- b1\n";
	const out = run(text, (d) => moveNodes(d, [byText(d, "B").id], { parentId: byText(d, "a1").id, index: 0 }));
	assert.equal(out, "# R\n\n## A\n\n- a1\n    - B\n\n        Para\n\n        - b1\n");
	// A list item placed after a heading sibling becomes a heading; its children move left.
	const back = run(text, (d) => moveNodes(d, [byText(d, "a1").id], { parentId: d.root.id, index: 2 }));
	assert.equal(back, "# R\n\n## A\n\n## B\n\nPara\n\n- b1\n\n## a1\n");
	// Headings keep their level when it fits between the new siblings.
	const skip = load("heading-skip-level");
	const moved = run(skip, (d) => moveDown(d, byText(d, "Deep").id));
	assert.ok(moved.endsWith("## Back\n\n## Deep\n"), JSON.stringify(moved));
});

test("paragraph parents become list items to take children; code and table cannot", () => {
	const text = "# R\n\nPara line.\n";
	assert.equal(run(text, (d) => insertChild(d, byText(d, "Para line.").id, "kid")), "# R\n\n- Para line.\n    - kid\n");
	const code = parseDocument("# R\n\n```\nx\n```\n");
	assert.equal(insertChild(code, code.root.children[0].id, "kid"), null);
});

test("deleting keeps the gap that was there and never merges neighbours", () => {
	assert.equal(run("# R\n\n## A\n\n## B\n\n## C\n", (d) => deleteNodes(d, [byText(d, "B").id])), "# R\n\n## A\n\n## C\n");
	assert.equal(run("# R\n\n## A\n\n## B\n", (d) => deleteNodes(d, [byText(d, "B").id])), "# R\n\n## A\n");
	assert.equal(run("# R\n\nPara\n- x\n2. y\n", (d) => deleteNodes(d, [byText(d, "x").id])), "# R\n\nPara\n\n2. y\n");
	assert.equal(run("# R\n- a\n- b\n- c", (d) => deleteNodes(d, [byText(d, "c").id, byText(d, "b").id])), "# R\n- a");
	assert.equal(deleteNodes(parseDocument("# R\n"), ["_1"])?.edits.length ?? null, null);
});

test("block ids go at the end of the line, or on the line after a block", () => {
	assert.equal(run("# R\n- a  \n", (d) => assignBlockId(d, byText(d, "a").id, "k1")), "# R\n- a ^k1  \n");
	assert.equal(run("# R\n\n## T ##\n", (d) => assignBlockId(d, byText(d, "T").id, "k1")), "# R\n\n## T ## ^k1\n");
	assert.equal(
		run("# R\n\n-\n  ```\n  x\n  ```\n", (d) => assignBlockId(d, d.root.children[0].id, "k1")),
		"# R\n\n-\n  ```\n  x\n  ```\n  ^k1\n",
	);
	assert.equal(run("# R\n\n| a |\n| - |\n", (d) => assignBlockId(d, d.root.children[0].id, "k1")), "# R\n\n| a |\n| - |\n^k1\n");
	const d = parseDocument("# R\n- a ^x\n");
	assert.equal(assignBlockId(d, "x", "y"), null);
	assert.equal(assignBlockId(d, d.root.id, "_bad"), null);
	const id = uniqueBlockId(d, rng(3));
	assert.match(id, /^[a-z][a-z0-9]{5}$/);
});

test("the virtual root's text becomes the first heading; existing headings move down", () => {
	const multi = load("multiple-h1");
	const out = run(multi, (d) => setText(d, d.root.id, "Top"));
	assert.ok(out.endsWith("---\n\n# Top\n\n## First\n\n### A\n\n## Second\n\n### B\n"), JSON.stringify(out));
	const list = load("list-only");
	assert.ok(run(list, (d) => setText(d, d.root.id, "Top")).endsWith("---\n\n# Top\n\n- one\n    - two\n- three\n"));
});

test("multi-node moves keep document order and produce disjoint edits", () => {
	const text = "# R\n\n- a\n- b\n- c\n- d\n";
	const out = run(text, (d) => moveNodes(d, [byText(d, "d").id, byText(d, "b").id], { parentId: byText(d, "a").id, index: 0 }));
	assert.equal(out, "# R\n\n- a\n    - b\n    - d\n- c\n");
	const cut = run(text, (d) => deleteNodes(d, [byText(d, "a").id, byText(d, "c").id]));
	assert.equal(cut, "# R\n\n- b\n- d\n");
});

test("insertNodes writes whole subtrees per section 6", () => {
	const out = run("# R\n", (d) =>
		insertNodes(d, [{ text: "p", children: [{ text: "q", blockId: "id1" }, { text: "> r" }] }], { parentId: d.root.id, index: 0 }),
	);
	assert.equal(out, "# R\n- p\n    - q ^id1\n    - \\> r\n");
});

// ------------------------------------------------------------------ performance

function bigDoc(nodes: number): string {
	const out = ["---", "mindmap-plugin: basic", "---", "", "# Root"];
	let count = 1;
	for (let section = 1; count < nodes; section++) {
		out.push("", `## Section ${section}`, "");
		count++;
		for (let i = 0; i < 9 && count < nodes; i++) {
			out.push(`${"    ".repeat(i % 3)}- item ${section}.${i} ^b${section}-${i}`);
			count++;
		}
	}
	return out.join("\n") + "\n";
}

test("each operation on 1,000 nodes takes well under 5 ms (median of 5)", (t) => {
	const text = bigDoc(1000);
	const ops: [string, (d: ParsedDoc) => OpResult | null][] = [
		["setText", (d) => setText(d, "b50-1", "changed")],
		["insertChild", (d) => insertChild(d, "b50-1", "new")],
		["delete", (d) => deleteNodes(d, ["b50-0", "b70-3"])],
		["moveUp", (d) => moveUp(d, "b50-3")],
		["indent", (d) => indentNode(d, "b60-3")],
		["moveNodes", (d) => moveNodes(d, ["b20-0"], { parentId: "b90-0", index: 0 })],
		["paste", (d) => pasteMarkdown(d, "- a\n    - b", { parentId: "b30-0", index: 0 })],
	];
	for (const [name, op] of ops) {
		const times: number[] = [];
		for (let i = 0; i < 5; i++) {
			const doc = parseDocument(text); // fresh doc: no cached index
			const start = performance.now();
			const r = op(doc);
			times.push(performance.now() - start);
			assert.ok(r, name);
		}
		times.sort((a, b) => a - b);
		t.diagnostic(`${name}: median ${times[2].toFixed(2)} ms, max ${times[4].toFixed(2)} ms`);
		assert.ok(times[2] < 5, `${name} median ${times[2]} ms`);
	}
});
