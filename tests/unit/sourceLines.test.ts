// Split-view sync (behaviour spec 5.6): node <-> file line mapping, the
// cursor -> node rule, and the in-place typing update (plan §4: ≤ 16 ms of
// plugin time for one typed character in a 1,000-node note).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "../../src/core/parse.ts";
import { createViewState, setFocus } from "../../src/core/state.ts";
import { createLayouter, DEFAULT_PALETTE, type LayoutInput } from "../../src/core/layout.ts";
import type { MapNode, ParsedDoc } from "../../src/core/types.ts";
import { DocSession } from "../../src/controller/session.ts";
import { cursorTarget, lineOfOffset, nodeAtLine, nodeLine } from "../../src/controller/sourceLines.ts";
import { applyTextEdits } from "../../src/controller/textEdits.ts";

const FM = "---\nmindmap-plugin: basic\nmindmark-state: {\"version\":2,\"collapsed\":[]}\n---\n";

function all(root: MapNode): MapNode[] {
	const out: MapNode[] = [];
	const walk = (n: MapNode): void => {
		out.push(n);
		n.children.forEach(walk);
	};
	walk(root);
	return out;
}

const find = (doc: ParsedDoc, text: string): MapNode => {
	const hit = all(doc.root).find((n) => n.text === text);
	assert.ok(hit, `node ${text}`);
	return hit;
};

/** Every node's line holds the first line of its text (the e2e source-lines check). */
function badLines(doc: ParsedDoc): { text: string; line: string }[] {
	const lines = doc.text.split(/\r?\n/);
	const bad: { text: string; line: string }[] = [];
	for (const n of all(doc.root)) {
		const l = nodeLine(doc, n.id);
		if (l === null) {
			if (n.source) bad.push({ text: n.text, line: "<null>" });
			continue;
		}
		const first = n.text.split("\n")[0] ?? "";
		const line = lines[l] ?? "";
		if (first && !line.includes(first)) bad.push({ text: n.text, line });
		if (nodeAtLine(doc, l)?.id !== n.id) bad.push({ text: n.text, line: `owner ${nodeAtLine(doc, l)?.text}` });
	}
	return bad;
}

test("node lines are file lines, frontmatter included", () => {
	const doc = parseDocument(FM + "# Root\n\n## A\n\n- item\n    - sub\n\n## B\n");
	assert.equal(nodeLine(doc, find(doc, "Root").id), 4);
	assert.equal(nodeLine(doc, find(doc, "A").id), 6);
	assert.equal(nodeLine(doc, find(doc, "item").id), 8);
	assert.equal(nodeLine(doc, find(doc, "sub").id), 9);
	assert.equal(nodeLine(doc, find(doc, "B").id), 11);
	assert.deepEqual(badLines(doc), []);
});

test("CRLF, paragraphs before headings, code blocks, tables and multi-line nodes", () => {
	const body = [
		"Intro paragraph",
		"second line",
		"",
		"# Root",
		"",
		"```js",
		"code()",
		"```",
		"",
		"| a | b |",
		"| - | - |",
		"| 1 | 2 |",
		"",
		"## Last ^last",
		"",
	].join("\r\n");
	const doc = parseDocument(FM.replace(/\n/g, "\r\n") + body);
	assert.deepEqual(badLines(doc), []);
	const intro = all(doc.root).find((n) => n.text.startsWith("Intro"));
	assert.ok(intro);
	assert.equal(nodeLine(doc, intro.id), 4);
	assert.equal(nodeAtLine(doc, 5)?.id, intro.id, "the second line of a paragraph belongs to it");
	assert.equal(nodeLine(doc, find(doc, "Last").id), 17);
});

test("frontmatter lines, blank lines and lines past the end resolve to no node", () => {
	const doc = parseDocument(FM + "# Root\n\n## A\n");
	for (const line of [0, 1, 2, 3]) assert.equal(nodeAtLine(doc, line), null, `frontmatter line ${line}`);
	assert.equal(nodeAtLine(doc, 5), null, "blank line between blocks");
	assert.equal(nodeAtLine(doc, 99), null);
	assert.equal(nodeAtLine(doc, -1), null);
	assert.equal(nodeAtLine(doc, 6)?.text, "A");
});

test("the virtual root has no line", () => {
	const doc = parseDocument(FM + "## A\n\n## B\n");
	assert.ok(doc.virtualRoot);
	assert.equal(nodeLine(doc, doc.root.id), null);
	assert.equal(lineOfOffset(doc, doc.text.length), doc.text.split("\n").length - 1);
});

test("cursor target: hidden node -> nearest visible ancestor, without expanding", () => {
	const doc = parseDocument(FM + "# Root\n\n## Folded ^f1\n\n### Hidden\n\n#### Deeper\n\n## Open\n");
	const view = createViewState(["f1"]);
	assert.equal(cursorTarget(doc, view, 8), find(doc, "Folded").id);
	assert.equal(cursorTarget(doc, view, 10), find(doc, "Folded").id);
	assert.equal(cursorTarget(doc, view, 12), find(doc, "Open").id);
	assert.equal(cursorTarget(doc, view, 1), null, "frontmatter leaves the selection");
	assert.ok(view.collapsed.has("f1"));
	// Temporarily expanded (search) counts as open.
	const temp = { ...view, tempExpanded: new Set(["f1"]) };
	assert.equal(cursorTarget(doc, temp, 8), find(doc, "Hidden").id);
});

test("cursor target: outside the focused branch leaves the selection alone", () => {
	const doc = parseDocument(FM + "# Root\n\n## A\n\n### A1\n\n### A2\n\n## B\n\n### B1\n");
	const a = find(doc, "A").id;
	const view = setFocus(doc.root, createViewState(), a);
	assert.equal(cursorTarget(doc, view, 10), find(doc, "A2").id);
	assert.equal(cursorTarget(doc, view, 6), a);
	assert.equal(cursorTarget(doc, view, 14), null, "B1 is outside the focus");
	assert.equal(cursorTarget(doc, view, 4), null, "the root is outside the focus");
});

test("typing in Markdown keeps ids and selection, and lines stay current", () => {
	const text = FM + "# Root\n\n## A\n\n- a1\n- a2\n\n## B ^b1\n\n- b1 child\n\n## C\n\n- c1\n";
	const s = new DocSession(text, "file");
	const before = new Map(all(s.doc.root).map((n) => [n.text, n.id]));
	const a1 = before.get("a1");
	assert.ok(a1);
	s.setSelection([a1], a1);
	let cur = s.text;
	const at = cur.indexOf("- a1") + 4;
	for (const ch of " typed") {
		// One character at a time at the end of the a1 line.
		const end = cur.indexOf("\n", at);
		const edits = [{ from: end, to: end, insert: ch }];
		cur = applyTextEdits(cur, edits);
		s.external(cur, edits);
	}
	const after = new Map(all(s.doc.root).map((n) => [n.text, n.id]));
	assert.equal(after.get("a1 typed"), a1, "the edited node keeps its id");
	for (const t of ["Root", "A", "a2", "B", "b1 child", "C", "c1"]) assert.equal(after.get(t), before.get(t), t);
	assert.deepEqual(s.view.selection, { ids: [a1], primary: a1 });
	assert.deepEqual(badLines(s.doc), []);
	// The collapsed state follows a change of the state line.
	assert.ok(s.view.collapsed.has("b1") === false);
	const folded = s.text.replace('"collapsed":[]', '"collapsed":["b1"]');
	s.external(folded);
	assert.ok(s.view.collapsed.has("b1"));
});

function bigDoc(count: number): string {
	const lines = ["---", "mindmap-plugin: basic", "---", "# Root"];
	let n = 1;
	for (let h = 0; n < count; h++) {
		lines.push("", `## Section ${h}`);
		n++;
		for (let i = 0; i < 9 && n < count; i++) {
			lines.push(`- item ${h}.${i}`);
			n++;
			for (let j = 0; j < 4 && n < count; j++) {
				lines.push(`    - leaf ${h}.${i}.${j} with some longer text`);
				n++;
			}
		}
	}
	return lines.join("\n") + "\n";
}

function toInput(node: MapNode): LayoutInput {
	return {
		id: node.id,
		size: { width: 20 + node.text.length * 7, height: 24 },
		collapsed: false,
		children: node.children.map(toInput),
	};
}

test("one typed character in a 1,000-node note: re-parse + reconcile + layout + cursor lookup ≤ 16 ms (median of 9)", (t) => {
	const text = bigDoc(1000);
	const s = new DocSession(text, "file");
	assert.equal(all(s.doc.root).length, 1000);
	const layouter = createLayouter();
	layouter.layout(toInput(s.doc.root), "mindmap", DEFAULT_PALETTE);
	const target = find(s.doc, "leaf 10.4.2 with some longer text").id;
	s.setSelection([target], target);
	const parseRuns: number[] = [];
	const runs: number[] = [];
	let cur = s.text;
	for (let i = 0; i < 9; i++) {
		const end = cur.indexOf("\n", cur.indexOf("leaf 10.4.2 with some longer text"));
		const edits = [{ from: end, to: end, insert: "x" }];
		cur = applyTextEdits(cur, edits);
		const start = performance.now();
		s.external(cur, edits);
		const parsed = performance.now();
		layouter.layout(toInput(s.doc.root), "mindmap", DEFAULT_PALETTE);
		cursorTarget(s.doc, s.view, lineOfOffset(s.doc, end));
		runs.push(performance.now() - start);
		parseRuns.push(parsed - start);
	}
	assert.equal(s.view.selection.primary, target, "the typed-in node stays selected");
	runs.sort((a, b) => a - b);
	parseRuns.sort((a, b) => a - b);
	t.diagnostic(`typing update 1,000 nodes: median ${runs[4]?.toFixed(2)} ms, max ${runs[8]?.toFixed(2)} ms; session.external alone median ${parseRuns[4]?.toFixed(2)} ms`);
	assert.ok((runs[4] ?? Infinity) <= 16, `median ${runs[4]} ms`);
});
