import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "../../src/core/parse.ts";
import type { MapNode, ParsedDoc } from "../../src/core/types.ts";

const fixtureDir = fileURLToPath(new URL("../../fixtures/compat/", import.meta.url));

interface Shape {
	text: string;
	blockId?: string;
	collapsed?: boolean;
	children?: Shape[];
}

function shape(node: MapNode, collapsed: Set<string>): Shape {
	const out: Shape = { text: node.text };
	if (node.blockId !== null) out.blockId = node.blockId;
	if (collapsed.has(node.id)) out.collapsed = true;
	if (node.children.length > 0) out.children = node.children.map((c) => shape(c, collapsed));
	return out;
}

const T = "| a | b |\n| --- | --- |\n| 1 | 2 |";

// Contract section 8: the new behaviour differs from 0.3.0 here.
const corrected: Record<string, Shape> = {
	table: { text: "Root", children: [{ text: "T", children: [{ text: T }] }] },
	"table-in-list": { text: "Root", children: [{ text: "item", children: [{ text: T }] }] },
	"table-block-id": { text: "Root", children: [{ text: T, blockId: "tbl1" }] },
	"code-block-top": { text: "Root", children: [{ text: "```\nplain\n```" }] },
	blockquote: {
		text: "Root",
		children: [{ text: "> quoted text" }, { text: "> escaped item" }, { text: "> item quote" }],
	},
	"empty-item": { text: "Root", children: [{ text: "", children: [{ text: "child" }] }] },
	"list-then-heading-para": {
		text: "Root",
		children: [
			{ text: "a\ncontinued lazily" },
			{ text: "b", children: [{ text: "indented para under b" }] },
		],
	},
	"list-only": {
		text: "",
		children: [{ text: "one", children: [{ text: "two" }] }, { text: "three" }],
	},
	"multiple-h1": {
		text: "",
		children: [
			{ text: "First", children: [{ text: "A" }] },
			{ text: "Second", children: [{ text: "B" }] },
		],
	},
	"no-root-heading": {
		text: "",
		children: [{ text: "A" }, { text: "B", children: [{ text: "b1" }] }],
	},
	paragraphs: {
		text: "",
		children: [
			{ text: "Intro before heading." },
			{
				text: "Root",
				children: [
					{ text: "Para under root.\nSecond line." },
					{
						text: "A",
						children: [
							{ text: "Para under A." },
							{ text: "a1" },
							{ text: "Trailing para after list." },
						],
					},
				],
			},
		],
	},
	"empty-body": { text: "" },
};
const virtualRootCases = new Set(["list-only", "multiple-h1", "no-root-heading", "paragraphs", "empty-body"]);

function fixtures(): string[] {
	return readdirSync(fixtureDir).filter((d) => existsSync(join(fixtureDir, d, "input.md"))).sort();
}

function load(name: string): string {
	return readFileSync(join(fixtureDir, name, "input.md"), "utf8");
}

function walk(node: MapNode, visit: (n: MapNode, parent: MapNode | null) => void, parent: MapNode | null = null): void {
	visit(node, parent);
	for (const c of node.children) walk(c, visit, node);
}

/** Undo the inline encoding a textRange slice carries: `<br>` and a list item's leading `\>`. */
function decodeSlice(node: MapNode, slice: string): string {
	let s = slice.replace(/<br>/g, "\n");
	if (node.kind === "list" && s.startsWith("\\>")) s = s.slice(1);
	return s;
}

const opensAsMap = (doc: ParsedDoc): boolean =>
	doc.frontmatter !== null && doc.frontmatter.isMindmap && doc.frontmatter.stateError === null;

for (const name of fixtures()) {
	const treeFile = join(fixtureDir, name, "tree-0.3.0.json");
	const expectedFile = join(fixtureDir, name, "expected-0.3.0.json");

	if (existsSync(treeFile)) {
		test(`fixture ${name}: tree`, () => {
			const doc = parseDocument(load(name));
			const expected = corrected[name] ?? (JSON.parse(readFileSync(treeFile, "utf8")) as Shape);
			assert.deepEqual(shape(doc.root, doc.collapsed), expected);
			assert.equal(doc.virtualRoot, virtualRootCases.has(name));
			assert.ok(opensAsMap(doc), "opens as a map");
		});
	}

	if (existsSync(expectedFile)) {
		test(`fixture ${name}: opens as Markdown`, () => {
			const doc = parseDocument(load(name));
			assert.equal(opensAsMap(doc), false);
			if (name === "no-frontmatter-key") assert.equal(doc.frontmatter, null);
			if (name === "state-invalid") assert.equal(doc.frontmatter?.stateError, "invalid");
			if (name === "state-v3") assert.equal(doc.frontmatter?.stateError, "unsupported");
			if (doc.frontmatter?.stateError) {
				assert.equal(doc.frontmatter.state, null);
				assert.equal(doc.collapsed.size, 0);
			}
		});
	}

	test(`fixture ${name}: source ranges`, () => {
		const text = load(name);
		const doc = parseDocument(text);
		assert.ok(!doc.root.text.includes("\r"));
		walk(doc.root, (node, parent) => {
			assert.ok(!node.text.includes("\r"), "no CR in text");
			const src = node.source;
			if (node.kind === "root") {
				assert.equal(src, null);
				return;
			}
			assert.ok(src, "source present");
			assert.ok(src.range.from >= doc.bodyFrom && src.range.from <= src.range.to);
			assert.ok(src.range.to <= src.subtreeTo && src.subtreeTo <= text.length);
			assert.ok(src.range.from === 0 || text[src.range.from - 1] === "\n", "range starts a line");
			if (parent?.source) {
				assert.ok(src.range.from >= parent.source.range.to, "child after parent's own lines");
				assert.ok(src.subtreeTo <= parent.source.subtreeTo, "child within parent subtree");
			}
			const singleLine = !text.slice(src.range.from, src.range.to).includes("\n");
			if (singleLine && (node.kind === "heading" || node.kind === "list" || node.kind === "paragraph")) {
				assert.ok(src.textRange, `textRange for single-line ${node.kind}`);
			}
			if (src.textRange) {
				assert.ok(src.textRange.from >= src.range.from && src.textRange.to <= src.range.to);
				assert.equal(decodeSlice(node, text.slice(src.textRange.from, src.textRange.to)), node.text);
			}
		});
	});
}

test("collapsed comes from the state version", () => {
	assert.deepEqual([...parseDocument(load("collapsed")).collapsed], ["ha"]);
	assert.deepEqual([...parseDocument(load("state-v1")).collapsed], ["ha"]);
	assert.deepEqual([...parseDocument(load("state-missing")).collapsed], ["ha"]);
	assert.equal(parseDocument(load("block-ids")).collapsed.size, 0);
});

function texts(node: MapNode): unknown {
	return [node.text, node.children.map(texts)];
}

for (const name of ["headings-and-lists", "ordered-list"]) {
	test(`fixture ${name}: replacing a textRange changes only that text`, () => {
		const text = load(name);
		const doc = parseDocument(text);
		const targets: number[][] = [];
		const collect = (node: MapNode, path: number[]): void => {
			const src = node.source;
			if (src?.textRange && !text.slice(src.range.from, src.range.to).includes("\n")) targets.push(path);
			node.children.forEach((c, i) => collect(c, [...path, i]));
		};
		collect(doc.root, []);
		assert.ok(targets.length >= 4);
		const at = (root: MapNode, path: number[]): MapNode => path.reduce((n, i) => n.children[i], root);
		for (const path of targets) {
			const tr = at(doc.root, path).source!.textRange!;
			const edited = text.slice(0, tr.from) + "new *text*" + text.slice(tr.to);
			const re = parseDocument(edited);
			at(doc.root, path).text = "new *text*";
			assert.deepEqual(texts(re.root), texts(doc.root));
			at(doc.root, path).text = at(parseDocument(text).root, path).text;
		}
	});
}

test("frontmatter detection and stateRange", () => {
	const text = "﻿--- \t\nmindmap-plugin: basic\nmindmark-state: {\"version\":2,\"collapsed\":[\"x\"],\"zoom\":1}\n\n---\t\n# R ^x\n- a\n";
	const doc = parseDocument(text);
	const fm = doc.frontmatter!;
	assert.ok(fm.isMindmap);
	assert.equal(fm.range.from, 0);
	assert.equal(text.slice(fm.range.to - 5, fm.range.to), "---\t\n");
	assert.equal(doc.bodyFrom, fm.range.to);
	assert.equal(text.slice(fm.stateRange!.from, fm.stateRange!.to), "mindmark-state: {\"version\":2,\"collapsed\":[\"x\"],\"zoom\":1}");
	assert.deepEqual(fm.state, { version: 2, collapsed: ["x"], extra: { zoom: 1 } });
	assert.deepEqual([...doc.collapsed], []); // the root is never collapsed
	assert.equal(doc.root.text, "R");
});

test("multi-line state value and YAML flow style", () => {
	const text = "---\nmindmark-state: {version: 2,\n  collapsed: [a, 'b']}\n\naliases:\n  - x\n---\n# R\n";
	const fm = parseDocument(text).frontmatter!;
	assert.equal(fm.isMindmap, false);
	assert.equal(text.slice(fm.stateRange!.from, fm.stateRange!.to), "mindmark-state: {version: 2,\n  collapsed: [a, 'b']}");
	assert.deepEqual(fm.state, { version: 2, collapsed: ["a", "b"], extra: {} });
});

test("state errors", () => {
	const err = (value: string): string | null =>
		parseDocument(`---\nmindmap-plugin: basic\nmindmark-state: ${value}\n---\n# R\n`).frontmatter!.stateError;
	assert.equal(err('{"version":2,"collapsed":[]}'), null);
	assert.equal(err('{"version":1}'), null);
	assert.equal(err('{"version":0,"collapsed":[]}'), "unsupported");
	assert.equal(err('{"version":2.5,"collapsed":[]}'), "invalid");
	assert.equal(err('{"version":"2","collapsed":[]}'), "invalid");
	assert.equal(err('{"collapsed":[]}'), "invalid");
	assert.equal(err('{"version":2,"collapsed":[1]}'), "invalid");
	assert.equal(err('{"version":2,"collapsed":"a"}'), "invalid");
	assert.equal(err("[1, 2]"), "invalid");
	assert.equal(err('{"version":2,'), "invalid");
	assert.equal(err(""), "invalid");
	const missing = parseDocument("---\nmindmap-plugin: basic\n---\n# R\n").frontmatter!;
	assert.equal(missing.stateRange, null);
	assert.deepEqual(missing.state, { version: 1, collapsed: [], extra: {} });
	assert.equal(parseDocument("---\nmindmap-plugin: basic\n# R\n").frontmatter, null, "unclosed frontmatter");
});

test("CRLF offsets refer to the original text", () => {
	const text = load("crlf");
	assert.ok(text.includes("\r\n"));
	const doc = parseDocument(text);
	assert.equal(doc.lineEnding, "\r\n");
	const a = doc.root.children[0].source!;
	assert.equal(text.slice(a.range.from, a.range.to), "- a");
	assert.equal(text.slice(a.textRange!.from, a.textRange!.to), "a");
	assert.equal(text.slice(doc.root.source!.range.from, doc.root.source!.range.to), "# Root");
});

test("list styles, heading levels and block ids", () => {
	const text = "# R\n\n## H ^h1\n\n  * a\n    3) b ^B-2\n- [ ] c\n\t- d\n";
	const doc = parseDocument(text);
	const h = doc.root.children[0];
	assert.equal(h.source!.headingLevel, 2);
	assert.equal(h.id, "h1");
	const a = h.children[0];
	assert.deepEqual(a.source!.list, { indent: "  ", marker: "*", ordered: false });
	const b = a.children[0];
	assert.deepEqual(b.source!.list, { indent: "    ", marker: "3)", ordered: true });
	assert.equal(b.text, "b");
	assert.equal(b.blockId, "B-2");
	const c = h.children[1];
	assert.equal(c.text, "[ ] c");
	assert.equal(c.children[0].text, "d");
	assert.equal(doc.root.source!.subtreeTo, text.length - 1);
	assert.equal(h.source!.subtreeTo, text.length - 1);
});

test("code blocks: top level, wrapped in a list item, and as a child", () => {
	const text = "# R\n\n- x\n  ~~~~\n  ## not a heading\n  ```\n  ~~~~\n\n-\n    | a |\n    | - |\n    ^t1\n\n```\nunclosed\n";
	const doc = parseDocument(text);
	const [x, table, code] = doc.root.children;
	assert.equal(x.text, "x");
	assert.equal(x.children[0].kind, "code");
	assert.equal(x.children[0].text, "~~~~\n## not a heading\n```\n~~~~");
	assert.equal(table.kind, "table");
	assert.equal(table.text, "| a |\n| - |");
	assert.equal(table.blockId, "t1");
	assert.deepEqual(table.source!.list, { indent: "", marker: "-", ordered: false });
	assert.equal(text.slice(table.source!.range.from, table.source!.range.to), "-\n    | a |\n    | - |\n    ^t1");
	assert.equal(code.text, "```\nunclosed");
	assert.equal(code.source!.textRange, null);
});

test("duplicate block ids still give unique node ids", () => {
	const doc = parseDocument("# R\n- a ^x\n- b ^X\n- c\n");
	const ids = new Set<string>();
	walk(doc.root, (n) => {
		assert.ok(!ids.has(n.id));
		ids.add(n.id);
	});
	assert.equal(doc.root.children[0].id, "x");
	assert.equal(doc.root.children[1].blockId, "X");
});

test("empty heading and list item have an empty textRange at line end", () => {
	const text = "# R\n-\n- \n";
	const doc = parseDocument(text);
	for (const n of doc.root.children) {
		assert.equal(n.text, "");
		assert.equal(n.source!.textRange!.from, n.source!.textRange!.to);
		assert.equal(n.source!.textRange!.to, n.source!.range.to);
	}
});

function bigDoc(nodes: number): string {
	const out = ["---", "mindmap-plugin: basic", 'mindmark-state: {"version":2,"collapsed":[]}', "---", "", "# Root"];
	let count = 1;
	let section = 0;
	while (count < nodes) {
		section++;
		out.push("", `## Section **${section}** with [[Link ${section}]]`);
		count++;
		for (let i = 0; i < 9 && count < nodes; i++) {
			const depth = i % 3;
			out.push(`${"    ".repeat(depth)}- item ${i} **bold** [ext](https://x.y/${i}) ==mark== ^b${section}-${i}`);
			count++;
		}
	}
	return out.join("\n") + "\n";
}

test("parses 1,000 nodes in under 20 ms (median of 5)", (t) => {
	const text = bigDoc(1000);
	let total = 0;
	walk(parseDocument(text).root, () => total++);
	assert.equal(total, 1000);
	const times: number[] = [];
	for (let i = 0; i < 5; i++) {
		const start = performance.now();
		parseDocument(text);
		times.push(performance.now() - start);
	}
	times.sort((a, b) => a - b);
	const median = times[2];
	t.diagnostic(`parse 1,000 nodes: median ${median.toFixed(2)} ms, max ${times[4].toFixed(2)} ms`);
	assert.ok(median < 20, `median ${median} ms`);
});

test('root with a block id is never collapsed (v1 and v2)', () => {
	for (const state of ['{"version":1}', '{"version":2,"collapsed":["r1","a1"]}']) {
		const doc = parseDocument(`---\nmindmap-plugin: basic\nmindmark-state: ${state}\n---\n# Root ^r1\n\n## A ^a1\n\n- x\n`);
		assert.equal(doc.collapsed.has(doc.root.id), false);
		assert.equal(doc.collapsed.has('a1'), true);
	}
});
