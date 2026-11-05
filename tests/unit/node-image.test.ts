import { test } from "node:test";
import assert from "node:assert/strict";
import { insertSibling, setText } from "../../src/core/ops.ts";
import { parseDocument } from "../../src/core/parse.ts";
import type { MapNode } from "../../src/core/types.ts";
import { applyTextEdits } from "../../src/controller/textEdits.ts";
import {
	appendLine,
	attachmentName,
	embedFor,
	embedLink,
	extensionForMime,
	isImageFile,
	isImageName,
	linkQueryAt,
	pastedImageName,
} from "../../src/nodeImage.ts";

test("image extensions are the ones Obsidian shows (spec 5.8)", () => {
	for (const n of ["a.png", "a.JPG", "b.jpeg", "c.gif", "d.webp", "e.svg", "f.bmp", "g.avif", "dir/x.y/h.PnG"]) assert.ok(isImageName(n), n);
	for (const n of ["a.md", "a.pdf", "a.ico", "png", ".png", "a.png.md", "dir.png/a"]) assert.ok(!isImageName(n), n);
	assert.equal(extensionForMime("image/png"), "png");
	assert.equal(extensionForMime("image/jpeg"), "jpg");
	assert.equal(extensionForMime("image/svg+xml"), "svg");
	assert.equal(extensionForMime("text/plain"), null);
	assert.ok(isImageFile({ name: "blob", type: "image/webp" }));
	assert.ok(!isImageFile({ name: "notes.txt", type: "text/plain" }));
});

test("pasted images are named like Obsidian's editor names them", () => {
	const at = new Date(2026, 10, 5, 9, 3, 7);
	assert.equal(pastedImageName(at, "png"), "Pasted image 20261105090307.png");
	// a file keeps its own name; the browser's generic clipboard name does not
	assert.equal(attachmentName({ name: "photo.JPG", type: "image/jpeg" }, at), "photo.JPG");
	assert.equal(attachmentName({ name: "image.png", type: "image/png" }, at), "Pasted image 20261105090307.png");
	assert.equal(attachmentName({ name: "", type: "image/gif" }, at), "Pasted image 20261105090307.gif");
	assert.equal(attachmentName({ name: "x.txt", type: "text/plain" }, at), null);
});

test("the embed goes on a new line at the end of the text", () => {
	assert.equal(embedLink("a.png"), "![[a.png]]");
	assert.equal(appendLine("", "![[a.png]]"), "![[a.png]]");
	assert.equal(appendLine("Title", "![[a.png]]"), "Title\n![[a.png]]");
	assert.equal(appendLine("two\nlines\n", "![[a.png]]"), "two\nlines\n![[a.png]]");
});

test("`![[` asks for attachments, `[[` for notes", () => {
	assert.deepEqual(linkQueryAt("see [[no"), { start: 4, query: "no", embed: false });
	assert.deepEqual(linkQueryAt("![[pic"), { start: 1, query: "pic", embed: true });
	assert.deepEqual(linkQueryAt("x ![["), { start: 3, query: "", embed: true });
	assert.equal(linkQueryAt("![[a]] b"), null);
	assert.equal(linkQueryAt("no link"), null);
});

function find(root: MapNode, text: string): MapNode {
	let found: MapNode | null = null;
	const visit = (n: MapNode): void => {
		if (n.text === text) found ??= n;
		n.children.forEach(visit);
	};
	visit(root);
	assert.ok(found, `node "${text}"`);
	return found;
}

/** Append the embed to the node through setText, write, re-parse: the node keeps its place and has the new text. */
function roundTrip(text: string, nodeText: string): string {
	const doc = parseDocument(text);
	const node = find(doc.root, nodeText);
	const value = appendLine(node.text, embedLink("pic.png"));
	const r = setText(doc, node.id, value);
	assert.ok(r, "setText applies");
	const out = applyTextEdits(text, r.edits);
	const again = parseDocument(out);
	const same = find(again.root, value);
	assert.equal(same.kind, node.kind);
	assert.equal(same.children.length, node.children.length, "children stay");
	return out;
}

test("an image added to a heading node is written with <br> and reads back the same", () => {
	const out = roundTrip("# Root\n\n## child ^c1\n\n- sub\n\n## other\n", "child");
	assert.equal(out, "# Root\n\n## child<br>![[pic.png]] ^c1\n\n- sub\n\n## other\n");
});

test("an image added to a list item reads back as the same item", () => {
	const out = roundTrip("# Root\n\n- one\n  - two\n- three\n", "two");
	assert.ok(out.includes("![[pic.png]]"), out);
	const doc = parseDocument(out);
	assert.deepEqual(doc.root.children.map((c) => c.text), ["one", "three"]);
	assert.equal(doc.root.children[0].children[0].text, "two\n![[pic.png]]");
});

test("an image added to a multi-line list item and to a paragraph stays in that node", () => {
	roundTrip("# Root\n\n- first<br>second\n- next\n", "first\nsecond");
	roundTrip("# Root\n\nA paragraph\nwith two lines\n\n## H\n", "A paragraph\nwith two lines");
	// an empty node gets just the embed
	const doc = parseDocument("# Root\n\n- \n- b\n");
	const empty = doc.root.children[0];
	const r = setText(doc, empty.id, appendLine(empty.text, embedLink("pic.png")));
	assert.ok(r);
	assert.equal(applyTextEdits(doc.text, r.edits), "# Root\n\n- ![[pic.png]]\n- b\n");
});

test("the embed is built by the injected link builder, so the user's link settings apply", () => {
	// stand-ins for generateMarkdownLink: wikilink shortest, wikilink absolute, Markdown link
	const wiki = (f: string, alias?: string): string => `[[${f}${alias ? `|${alias}` : ""}]]`;
	const abs = (f: string, alias?: string): string => `[[assets/${f}${alias ? `|${alias}` : ""}]]`;
	const md = (f: string, alias?: string): string => `[${alias ?? f}](assets/${f.replace(/ /g, "%20")})`;
	assert.equal(embedFor("a.png", wiki), "![[a.png]]");
	assert.equal(embedFor("a.png", abs), "![[assets/a.png]]");
	assert.equal(embedFor("a b.png", md), "![a b.png](assets/a%20b.png)");
	// an explicit width is the alias: Obsidian's size syntax in both forms
	assert.equal(embedFor("a.png", wiki, 200), "![[a.png|200]]");
	assert.equal(embedFor("a.png", md, 200), "![200](assets/a.png)");
	// a builder that already returns an embed is not given a second "!"
	assert.equal(embedFor("a.png", (f) => `![[${f}]]`), "![[a.png]]");
});

test("a Markdown-link embed added to a node reads back as the same node", () => {
	const out = roundTrip("# Root\n\n- one\n- two\n", "one");
	assert.ok(out.includes("![[pic.png]]"));
	const doc = parseDocument("# Root\n\n- one\n- two\n");
	const node = find(doc.root, "one");
	const value = appendLine(node.text, embedFor("a b.png", (f) => `[${f}](assets/${f.replace(/ /g, "%20")})`));
	const r = setText(doc, node.id, value);
	assert.ok(r);
	const again = parseDocument(applyTextEdits(doc.text, r.edits));
	assert.equal(again.root.children[0].text, value);
	assert.equal(again.root.children.length, 2);
});

function siblingImage(text: string, kind: string): void {
	const doc = parseDocument(text);
	const all: MapNode[] = [];
	const walk = (n: MapNode): void => {
		all.push(n);
		n.children.forEach(walk);
	};
	walk(doc.root);
	const node = all.find((n) => n.kind === kind)!;
	const r = insertSibling(doc, node.id, embedLink("pic.png"), "after", { headLevel: 1 });
	assert.ok(r, "the sibling is inserted");
	const out = applyTextEdits(text, r.edits);
	const again = parseDocument(out);
	const same = find(again.root, node.text);
	assert.equal(same.kind, kind, "the node keeps its kind and text");
	assert.equal(same.children.length, 0);
	const parent = again.root.children.concat(again.root).find((p) => p.children.includes(same))!;
	const next = parent.children[parent.children.indexOf(same) + 1];
	assert.equal(next.text, "![[pic.png]]");
	assert.equal(applyTextEdits(out, r.inverse), text, "undo restores the original text");
}

test("an image for a code node or a table node becomes its next sibling; undo restores the text", () => {
	siblingImage("# Root\n\n- \n  ```js\n  let a = 1;\n  ```\n- b\n", "code");
	siblingImage("# Root\n\n## T\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n## c\n", "table");
});
