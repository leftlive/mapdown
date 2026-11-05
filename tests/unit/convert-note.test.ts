import { test } from "node:test";
import assert from "node:assert/strict";
import { newMapBaseName, otherFrontmatterLines, stateJson, toMapText, wholeBody } from "../../src/controller/convertNote.ts";
import { availablePath, timestamp } from "../../src/controller/fileNames.ts";
import { parseDocument } from "../../src/core/parse.ts";
import type { MapNode } from "../../src/core/types.ts";

const EMPTY_STATE = 'mindmark-state: {"version":2,"collapsed":[]}';

const shape = (n: MapNode): unknown => [n.text, n.children.map(shape)];
const tree = (text: string): unknown => {
	const doc = parseDocument(text);
	return { virtual: doc.virtualRoot, root: shape(doc.root) };
};

test("new map name: English and Chinese, numbered on clash", () => {
	assert.equal(newMapBaseName("Plan", false), "Plan (mind map)");
	assert.equal(newMapBaseName("Plan", true), "Plan（导图）");
	const taken = new Set(["dir/Plan (mind map).md"]);
	assert.equal(availablePath("dir", newMapBaseName("Plan", false), (p) => taken.has(p)), "dir/Plan (mind map) 1.md");
	assert.equal(availablePath("", newMapBaseName("Plan", true), () => false), "Plan（导图）.md");
});

test("backup timestamp format", () => {
	assert.equal(timestamp(new Date(2026, 10, 4, 21, 30, 45)), "2026-11-04 213045");
	assert.equal(timestamp(new Date(2026, 0, 2, 3, 4, 5)), "2026-01-02 030405");
});

test("state value: version 2, extra fields kept, version and collapsed overwritten", () => {
	assert.equal(stateJson(), '{"version":2,"collapsed":[]}');
	assert.equal(stateJson(["a", "b"], { theme: "x", version: 1 }), '{"theme":"x","version":2,"collapsed":["a","b"]}');
});

test("frontmatter rewrite keeps other keys byte for byte and drops both own keys", () => {
	const text = "---\ntitle: Plan\nmindmap-plugin: other\ntags:\n  - a\n\n  - b\nmindmark-state: {\"version\": 3,\n  \"collapsed\": []}\n\nalias: x\n---\n\n# Plan\n";
	assert.deepEqual(otherFrontmatterLines(parseDocument(text)), ["title: Plan\n", "tags:\n", "  - a\n", "\n", "  - b\n", "\n", "alias: x\n"]);
	assert.equal(
		toMapText(text, { headLevel: 1 }),
		`---\ntitle: Plan\ntags:\n  - a\n\n  - b\n\nalias: x\nmindmap-plugin: basic\n${EMPTY_STATE}\n---\n\n# Plan\n`,
	);
});

test("frontmatter rewrite: quoted key, YAML list value at column 0", () => {
	const text = "---\n'mindmark-state':\n- x\nkeep: 1\n---\n- a\n";
	assert.equal(toMapText(text, { headLevel: 1 }), `---\nkeep: 1\nmindmap-plugin: basic\n${EMPTY_STATE}\n---\n\n- a\n`);
});

test("no frontmatter: one is created; empty body writes only the frontmatter", () => {
	assert.equal(toMapText("# Root\n- a\n", { headLevel: 1 }), `---\nmindmap-plugin: basic\n${EMPTY_STATE}\n---\n\n# Root\n- a\n`);
	assert.equal(toMapText("", { headLevel: 1 }), `---\nmindmap-plugin: basic\n${EMPTY_STATE}\n---\n`);
	assert.equal(toMapText("---\ntags: x\n---\n", { headLevel: 1 }), `---\ntags: x\nmindmap-plugin: basic\n${EMPTY_STATE}\n---\n`);
	assert.equal(toMapText("---\n---\n\n- a", { headLevel: 1 }), `---\nmindmap-plugin: basic\n${EMPTY_STATE}\n---\n\n- a\n`);
});

test("BOM, CRLF and the final line break follow the note", () => {
	const text = "\uFEFF---\r\ntags: x\r\n---\r\n\r\n# Root\r\n\r\n## A\r\n";
	assert.equal(
		toMapText(text, { headLevel: 1 }),
		`\uFEFF---\r\ntags: x\r\nmindmap-plugin: basic\r\n${EMPTY_STATE}\r\n---\r\n\r\n# Root\r\n- A\r\n`,
	);
	assert.equal(toMapText("# Root\n- a", { headLevel: 1, finalNewline: false }), `---\nmindmap-plugin: basic\n${EMPTY_STATE}\n---\n\n# Root\n- a`);
});

test("the given state is written", () => {
	const out = toMapText("# R\n- a ^x\n", { headLevel: 1, state: stateJson(["x"]) });
	assert.ok(out.includes('mindmark-state: {"version":2,"collapsed":["x"]}\n'));
	assert.deepEqual([...parseDocument(out).collapsed], ["x"]);
});

test("a virtual root is not written; its children start at depth 1", () => {
	assert.equal(wholeBody(parseDocument("- a\n- b\n"), 1), "- a\n- b");
	assert.equal(wholeBody(parseDocument("# A\ntext\n# B\n- x\n"), 2), "## A\n- text\n\n## B\n- x");
	assert.equal(wholeBody(parseDocument("- a\n    - b\n"), 0), "- a\n    - b");
	assert.equal(wholeBody(parseDocument(""), 1), "");
	assert.equal(wholeBody(parseDocument("# Only\n- a\n"), 1), "# Only\n- a");
});

test("the converted note reads back as the same tree", () => {
	const notes = [
		"# Plan\n\nBackground text.\n\n## Goals\n\n1. First\n2. Second\n\n## Tasks\n\n- [ ] Open\n- [x] Done\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nClosing words.\n",
		"- a\n  - b\n- c\n",
		"# A\n- x\n# B\n- y\n",
		"intro\n\n## H2\n- y\n",
		"",
	];
	for (const note of notes) {
		for (const headLevel of [0, 1, 2, 3, 4, 5, 6]) {
			const out = toMapText(note, { headLevel });
			const doc = parseDocument(out);
			assert.ok(doc.frontmatter?.isMindmap, `map key for ${JSON.stringify(note)}`);
			const before = tree(note) as { virtual: boolean; root: unknown };
			// With no heading levels a real root is written as a list item, so it reads back under a virtual root.
			const expected = headLevel === 0 && !before.virtual ? { virtual: true, root: ["", [before.root]] } : before;
			assert.deepEqual(tree(out), expected, `same tree for ${JSON.stringify(note)} at headLevel ${headLevel}`);
			assert.equal(toMapText(out, { headLevel }), out, "converting again changes nothing");
		}
	}
});
