import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "../../src/core/parse.ts";
import {
	encodeText,
	headingLine,
	isBlockText,
	isCodeText,
	isTableText,
	listLine,
	nextListMarker,
	writeDocumentBody,
	writeNode,
	writeSubtree,
	type NewNode,
} from "../../src/core/serialize.ts";
import { writeMapOutline } from "../../src/core/outline.ts";

const leaf = (text: string, blockId: string | null = null): NewNode => ({ text, blockId, children: [] });
const ctx = { headLevel: 1, depth: 1, eol: "\n" as const };

test("encodeText: <br> for line breaks, \\> for a leading > in list items only", () => {
	assert.equal(encodeText("a\nb", "list"), "a<br>b");
	assert.equal(encodeText("a\r\nb", "heading"), "a<br>b");
	assert.equal(encodeText("> q", "list"), "\\> q");
	assert.equal(encodeText("> q", "heading"), "> q");
	assert.equal(encodeText("> q", "paragraph"), "> q");
	assert.equal(encodeText("  x  ", "list"), "x");
});

test("single lines: hashes or marker, text, block id; empty is the bare prefix", () => {
	assert.equal(headingLine(3, "T", "id1"), "### T ^id1");
	assert.equal(headingLine(2, "", null), "##");
	assert.equal(headingLine(2, "", "k"), "## ^k");
	assert.equal(listLine("  ", "*", "a\nb", null), "  * a<br>b");
	assert.equal(listLine("", "-", "", null), "-");
	assert.equal(listLine("", "-", "", "k"), "- ^k");
	for (const line of ["- a<br>b ^x", "- \\> q", "- ^k"]) {
		const doc = parseDocument(`# R\n${line}\n`);
		assert.equal(doc.root.children.length, 1, line);
	}
});

test("block text detection matches the outline writer", () => {
	assert.ok(isCodeText("```js\nx\n```"));
	assert.ok(isCodeText("~~~\nx\n~~~"));
	assert.ok(isTableText("| a |\n| - |"));
	assert.ok(!isTableText("a | b\n- | -"));
	assert.ok(isBlockText("| a |\n| --- |\n| 1 |"));
	assert.ok(!isBlockText("plain"));
});

test("nextListMarker counts ordered markers and keeps bullets", () => {
	assert.equal(nextListMarker("2."), "3.");
	assert.equal(nextListMarker("9)"), "10)");
	assert.equal(nextListMarker("*"), "*");
});

test("writeSubtree as a list item: indent and marker apply to the top, children nest by 4", () => {
	const tree: NewNode = { text: "p", blockId: "b1", children: [leaf("q"), leaf("> r"), leaf("```\nc\n```", "c1")] };
	const w = writeSubtree(tree, { kind: "list", indent: "  ", marker: "3." }, ctx);
	assert.ok(w);
	assert.equal(w.text, "  3. p ^b1\n      - q\n      - \\> r\n      -\n        ```\n        c\n        ```\n        ^c1");
	assert.equal(w.last.text, "```\nc\n```");
	assert.equal(w.lastIsHeading, false);
});

test("writeSubtree as a heading: levels offset, descendants below headLevel become list items", () => {
	const tree: NewNode = { text: "H", blockId: null, children: [{ text: "S", blockId: null, children: [leaf("x")] }] };
	assert.equal(writeSubtree(tree, { kind: "heading", level: 3 }, { headLevel: 3, depth: 1, eol: "\n" })?.text, "### H\n\n#### S\n- x");
	assert.equal(writeSubtree(tree, { kind: "heading", level: 2 }, ctx)?.text, "## H\n- S\n    - x");
	// Never deeper than 6.
	assert.equal(writeSubtree(tree, { kind: "heading", level: 6 }, { headLevel: 6, depth: 0, eol: "\n" })?.text, "###### H\n- S\n    - x");
	// Tables under a heading stay tables (D6), code becomes a list item (6.4).
	const t = writeSubtree({ text: "H", blockId: null, children: [leaf("| a |\n| - |")] }, { kind: "heading", level: 2 }, { headLevel: 3, depth: 1, eol: "\r\n" });
	assert.equal(t?.text, "## H\r\n\r\n| a |\r\n| - |");
});

test("code and tables are never headings", () => {
	assert.equal(writeNode(leaf("```\nx\n```"), { kind: "heading", level: 2 }, ctx), null);
	assert.equal(writeNode(leaf("| a |\n| - |"), { kind: "heading", level: 2 }, ctx), null);
	assert.equal(writeNode(leaf("| a |\n| - |"), { kind: "list", indent: "", marker: "-" }, ctx)?.text, "-\n    | a |\n    | - |");
});

test("writeNode drops the children", () => {
	assert.equal(writeNode({ text: "a", blockId: null, children: [leaf("b")] }, { kind: "list", indent: "", marker: "-" }, ctx)?.text, "- a");
});

test("whole documents go through the outline writer", () => {
	const doc = parseDocument("# R\n\n## A\n\n- a1\n- ^e1\n");
	assert.equal(writeDocumentBody(doc.root, 2, "\n"), writeMapOutline(doc.root, 2, "\n"));
	// An empty node keeps its block id.
	assert.ok(writeDocumentBody(doc.root, 2, "\n").endsWith("- ^e1"));
});
