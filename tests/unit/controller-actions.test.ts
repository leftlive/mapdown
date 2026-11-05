import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "../../src/core/parse.ts";
import { createViewState } from "../../src/core/state.ts";
import type { MapNode } from "../../src/core/types.ts";
import {
	fromClipboardJson,
	joinedText,
	joinSteps,
	jsonFromClipboardHtml,
	levelInSubtree,
	navigate,
	showToLevel,
	sidesOf,
	toClipboardHtml,
	toClipboardJson,
	toClipboardOutline,
	toggleWrap,
} from "../../src/controller/actions.ts";
import { DocSession } from "../../src/controller/session.ts";
import { availablePath, fileNameFromRoot } from "../../src/controller/fileNames.ts";
import { KEY_TABLE } from "../../src/keymap.ts";
import { DEFAULT_SETTINGS, normalizeSettings, settingsForSave } from "../../src/settings.ts";

const FM = "---\nmindmap-plugin: basic\nmindmark-state: {\"version\":2,\"collapsed\":[]}\n---\n";

function id(root: MapNode, text: string): string {
	const walk = (n: MapNode): string | null => (n.text === text ? n.id : n.children.map(walk).find((x) => x !== null) ?? null);
	const hit = walk(root);
	assert.ok(hit, text);
	return hit;
}

test("sides: mindmap puts the first half right", () => {
	const doc = parseDocument(FM + "# R\n\n## a\n\n## b\n\n## c\n");
	const s = sidesOf(doc.root, "mindmap");
	assert.equal(s.get(id(doc.root, "a")), "right");
	assert.equal(s.get(id(doc.root, "b")), "right");
	assert.equal(s.get(id(doc.root, "c")), "left");
	assert.equal(sidesOf(doc.root, "left").get(id(doc.root, "a")), "left");
});

test("navigate: away from root opens a collapsed node; towards root selects the parent", () => {
	const doc = parseDocument(FM + "# R\n\n## A\n\n### A1\n\n## B\n");
	const a = id(doc.root, "A");
	const a1 = id(doc.root, "A1");
	const open = createViewState();
	assert.deepEqual(navigate(doc, open, a, "right", "right"), { select: a1, expand: null });
	assert.deepEqual(navigate(doc, createViewState([a]), a, "right", "right"), { select: a1, expand: a });
	assert.deepEqual(navigate(doc, open, a1, "left", "right"), { select: a, expand: null });
	assert.deepEqual(navigate(doc, open, a, "down", "right"), { select: id(doc.root, "B"), expand: null });
	assert.deepEqual(navigate(doc, open, null, "down", "right"), { select: doc.root.id, expand: null });
});

test("showToLevel collapses exactly the nodes at that depth", () => {
	const doc = parseDocument(FM + "# R\n\n## A\n\n### A1\n\n#### A1a\n\n## B\n\n### B1\n");
	const l1 = showToLevel(doc.root, new Set(), 1);
	assert.deepEqual([...l1].sort(), [id(doc.root, "A"), id(doc.root, "B")].sort());
	const l2 = showToLevel(doc.root, l1, 2);
	assert.deepEqual([...l2], [id(doc.root, "A1")]);
	assert.equal(showToLevel(doc.root, l2, 4).size, 0);
});

test("levelInSubtree opens and closes the deepest shown level", () => {
	const doc = parseDocument(FM + "# R\n\n## A\n\n### A1\n\n#### A1a\n");
	const a = id(doc.root, "A");
	const a1 = id(doc.root, "A1");
	const view = createViewState([a1]);
	assert.deepEqual([...(levelInSubtree(doc, view, a, 1) ?? [])], []);
	assert.deepEqual([...(levelInSubtree(doc, view, a, -1) ?? [])].sort(), [a, a1].sort());
});

test("join: strips PDF link, page and emoji; one undo step", () => {
	assert.equal(joinedText("quote [🔗](x/y.pdf) (p. 12)", "📌 next", false), "quote\nnext");
	assert.equal(joinedText("a", "b", true), "a (…)\nb");
	const text = FM + "# Root\n\n## A\n\n## B\n\n### B1\n\n## C\n";
	const s = new DocSession(text, "f");
	const a = id(s.doc.root, "A");
	const steps = joinSteps(s.doc, a, false);
	assert.ok(steps);
	assert.ok(s.run(steps, { reveal: false }));
	assert.equal(s.text, FM + "# Root\n\n## A<br>B\n\n### B1\n\n## C\n");
	assert.equal(s.history.undoSize, 1);
	s.undo();
	assert.equal(s.text, text);
});

test("toggleWrap wraps and unwraps", () => {
	assert.equal(toggleWrap("x", "**"), "**x**");
	assert.equal(toggleWrap("**x**", "**"), "x");
});

test("clipboard: 0.3.0 JSON round trip, HTML carrier and outline", () => {
	const doc = parseDocument(FM + "# Root\n\n## Src\n\n### Leaf\n\n## Dst\n");
	const src = doc.root.children[0];
	assert.ok(src);
	const json = toClipboardJson([src], new Set([src.id]));
	const back = fromClipboardJson(json);
	assert.deepEqual(back, [{ text: "Src", collapsed: true, children: [{ text: "Leaf", collapsed: false, children: [] }] }]);
	assert.equal(jsonFromClipboardHtml(toClipboardHtml([src], json)), json);
	assert.equal(toClipboardOutline([src]), "- Src\n    - Leaf");
	assert.equal(fromClipboardJson("- not json"), null);
	// 0.3.0's own shape (numeric pid null at the top)
	const old = '{"type":"copyNode","text":[{"id":"a","text":"P","pid":null,"expanded":true,"note":""},{"id":"b","text":"C","pid":"a","expanded":true,"note":""}]}';
	assert.deepEqual(fromClipboardJson(old), [{ text: "P", collapsed: false, children: [{ text: "C", collapsed: false, children: [] }] }]);
});

test("file names from the root", () => {
	assert.equal(fileNameFromRoot('  A: b/c?  "d"  [e]#  '), "A bc d e");
	assert.equal(fileNameFromRoot("x".repeat(100)).length, 80);
	const taken = new Set(["f/Name.md", "f/Name 1.md"]);
	assert.equal(availablePath("f", "Name", (p) => taken.has(p)), "f/Name 2.md");
	assert.equal(availablePath("", "Name", () => false), "Name.md");
});

test("settings: defaults, clamping, wrong types, unknown keys kept", () => {
	assert.deepEqual(normalizeSettings(null), { ...DEFAULT_SETTINGS });
	const s = normalizeSettings({ headLevel: 9, fontSize: "x", nodeMaxWidth: 1250, canvasSize: 7000, layoutDirect: "up", focusOverlayOpacity: 2, strokeArray: ["#fff"] });
	assert.equal(s.headLevel, 6);
	assert.equal(s.fontSize, 16);
	assert.equal(s.nodeMaxWidth, 1200);
	assert.equal(s.canvasSize, 6000);
	assert.equal(s.layoutDirect, "mindmap");
	assert.equal(s.focusOverlayOpacity, 0.8);
	assert.deepEqual(s.strokeArray, ["#fff"]);
	const saved = settingsForSave({ theme: "dark", color: 1, exportMdModel: "x", headLevel: 2 }, s);
	assert.equal(saved.theme, "dark");
	assert.equal(saved.exportMdModel, "x");
	assert.equal(saved.headLevel, 6);
});

test("key table: one binding per combination", () => {
	const seen = new Set<string>();
	for (const b of KEY_TABLE) {
		for (const k of b.keys) {
			const combo = [...b.mods].sort().join("+") + "+" + k;
			assert.ok(!seen.has(combo), combo);
			seen.add(combo);
		}
	}
});
