import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteNodes, insertChild, moveDown, setText } from "../../src/core/ops.ts";
import type { MapNode, ParsedDoc, TextEdit } from "../../src/core/types.ts";
import { History } from "../../src/history.ts";
import { collapseSteps, DocSession, keepSelection } from "../../src/controller/session.ts";
import {
	applyTextEdits,
	composeEdits,
	diffTexts,
	invertEdits,
	mapPos,
	rebaseEdits,
} from "../../src/controller/textEdits.ts";

const FM = "---\nmindmap-plugin: basic\nmindmark-state: {\"version\":2,\"collapsed\":[]}\n---\n";

function find(root: MapNode, text: string): MapNode {
	const walk = (n: MapNode): MapNode | null => {
		if (n.text === text) return n;
		for (const c of n.children) {
			const hit = walk(c);
			if (hit) return hit;
		}
		return null;
	};
	const hit = walk(root);
	assert.ok(hit, `node ${text}`);
	return hit;
}

const byText = (doc: ParsedDoc, text: string): string => find(doc.root, text).id;

test("mapPos follows insertions and replacements", () => {
	const edits: TextEdit[] = [{ from: 2, to: 4, insert: "xyz" }];
	assert.equal(mapPos(1, edits), 1);
	assert.equal(mapPos(5, edits), 6);
	assert.equal(mapPos(3, edits, -1), 2);
	assert.equal(mapPos(3, edits, 1), 5);
	assert.equal(mapPos(2, [{ from: 2, to: 2, insert: "ab" }], -1), 2);
	assert.equal(mapPos(2, [{ from: 2, to: 2, insert: "ab" }], 1), 4);
});

test("composeEdits equals applying both in turn, CRLF included", () => {
	const t0 = "a\r\nbb\r\nccc\r\n";
	const e1: TextEdit[] = [{ from: 3, to: 5, insert: "BBBB" }];
	const t1 = applyTextEdits(t0, e1);
	const e2: TextEdit[] = [{ from: 0, to: 1, insert: "A" }, { from: t1.length, to: t1.length, insert: "d\r\n" }];
	const t2 = applyTextEdits(t1, e2);
	const c = composeEdits(t0, e1, e2);
	assert.equal(applyTextEdits(t0, c), t2);
	assert.equal(applyTextEdits(t2, invertEdits(t0, c)), t0);
	// Overlapping the inserted text falls back to one diff edit.
	const e3: TextEdit[] = [{ from: 4, to: 6, insert: "q" }];
	assert.equal(applyTextEdits(t0, composeEdits(t0, e1, e3)), applyTextEdits(t1, e3));
});

test("diffTexts is minimal around one change", () => {
	assert.deepEqual(diffTexts("abcdef", "abXdef"), [{ from: 2, to: 3, insert: "X" }]);
	assert.deepEqual(diffTexts("same", "same"), []);
});

test("rebaseEdits refuses touching edits and shifts the rest", () => {
	assert.equal(rebaseEdits([{ from: 2, to: 4, insert: "" }], [{ from: 4, to: 4, insert: "x" }]), null);
	const r = rebaseEdits([{ from: 10, to: 12, insert: "" }], [{ from: 0, to: 0, insert: "xx" }]);
	assert.deepEqual(r?.edits, [{ from: 12, to: 14, insert: "" }]);
	assert.deepEqual(r?.other, [{ from: 0, to: 0, insert: "xx" }]);
});

test("history maps through outside edits and drops what it cannot map", () => {
	const t0 = "hello world";
	const forward: TextEdit[] = [{ from: 6, to: 11, insert: "there" }];
	const t1 = applyTextEdits(t0, forward);
	const sel = { ids: [], primary: null, offsets: [] };
	const h = new History();
	h.push({ forward, inverse: invertEdits(t0, forward), before: sel, after: sel });
	// Typing at the start, far from the step.
	const outside: TextEdit[] = [{ from: 0, to: 0, insert: ">> " }];
	const t2 = applyTextEdits(t1, outside);
	h.mapOutside(outside);
	const step = h.peekUndo();
	assert.ok(step);
	assert.equal(applyTextEdits(t2, step.inverse), ">> hello world");
	// Typing inside the changed word drops the step.
	h.mapOutside([{ from: 10, to: 10, insert: "!" }]);
	assert.equal(h.undoSize, 0);
});

test("session: op, undo, redo restore text and selection", () => {
	const text = FM + "# Root\n\n## A\n\n## B\n";
	const s = new DocSession(text, "file");
	const a = byText(s.doc, "A");
	s.setSelection([a], a);
	assert.ok(s.run([(d) => {
		const result = insertChild(d, a, "");
		return result ? { result } : null;
	}]));
	assert.equal(s.history.undoSize, 1);
	const created = s.view.selection.primary;
	assert.ok(created && created !== a);
	assert.ok(s.undo());
	assert.equal(s.text, text);
	assert.deepEqual(s.view.selection.ids, [a]);
	assert.ok(s.redo());
	assert.notEqual(s.text, text);
	assert.equal(s.history.redoSize, 0);
});

test("session: undo of delete selects the restored node by offset", () => {
	const text = FM + "# Root\n\n## A\n\n## B\n";
	const s = new DocSession(text, "file");
	const b = byText(s.doc, "B");
	s.setSelection([b], b);
	assert.ok(s.run([(d) => {
		const result = deleteNodes(d, [b]);
		return result ? { result } : null;
	}], { select: () => ({ ids: [], primary: null }) }));
	assert.ok(s.undo());
	assert.equal(s.text, text);
	const restored = byText(s.doc, "B");
	assert.deepEqual(s.view.selection.ids, [restored]);
});

test("session: collapsing a node without a block id is one undoable step", () => {
	const text = FM + "# Root\n\n## P\n\n- child\n\n## Q\n";
	const s = new DocSession(text, "file");
	const p = byText(s.doc, "P");
	s.setSelection([p], p);
	assert.ok(s.run(collapseSteps(new Set([p]), () => 0.5), { select: keepSelection(s) }));
	assert.equal(s.history.undoSize, 1);
	assert.match(s.text, /## P \^[a-z0-9]+\n/);
	assert.match(s.text, /"collapsed":\["[a-z0-9]+"\]/);
	const pNow = s.view.selection.primary;
	assert.ok(pNow && s.view.collapsed.has(pNow));
	assert.ok(s.undo());
	assert.equal(s.text, text);
	assert.equal(s.view.collapsed.size, 0);
});

test("session: adding a child to a collapsed node opens it; undo collapses it again", () => {
	const text = "---\nmindmap-plugin: basic\nmindmark-state: {\"version\":2,\"collapsed\":[\"p1\"]}\n---\n# Root\n\n## P ^p1\n\n- P child\n\n## Q\n";
	const s = new DocSession(text, "file");
	assert.ok(s.view.collapsed.has("p1"));
	assert.ok(s.run([(d) => {
		const result = insertChild(d, "p1", "");
		return result ? { result } : null;
	}]));
	assert.equal(s.history.undoSize, 1);
	assert.equal(s.view.collapsed.size, 0);
	assert.ok(s.undo());
	assert.equal(s.text, text);
	assert.ok(s.view.collapsed.has("p1"));
});

test("session: a chain of ops is one step (join-like)", () => {
	const text = FM + "# Root\n\n## A\n\n## B\n\n## C\n";
	const s = new DocSession(text, "file");
	const a = byText(s.doc, "A");
	const b = byText(s.doc, "B");
	assert.ok(s.run([
		(d, id) => {
			const result = setText(d, id(a), "A\nB");
			return result ? { result, keep: [id(a)] } : null;
		},
		(d, id) => {
			const result = deleteNodes(d, [id(b)]);
			return result ? { result } : null;
		},
	], { select: (_d, _x, id) => ({ ids: [id(a)], primary: id(a) }) }));
	assert.equal(s.history.undoSize, 1);
	assert.equal(s.text, FM + "# Root\n\n## A<br>B\n\n## C\n");
	assert.deepEqual(s.view.selection.ids, [a]);
	assert.ok(s.undo());
	assert.equal(s.text, text);
});

test("session: outside edits keep ids and map history", () => {
	const text = FM + "# Root\n\n## A\n\n## B\n";
	const s = new DocSession(text, "file");
	const a = byText(s.doc, "A");
	const b = byText(s.doc, "B");
	assert.ok(s.run([(d) => {
		const result = moveDown(d, a);
		return result ? { result, keep: [a] } : null;
	}]));
	assert.equal(byText(s.doc, "A"), a);
	const moved = s.text;
	s.external(moved + "\n## Z\n");
	assert.equal(byText(s.doc, "B"), b);
	assert.equal(s.history.undoSize, 1);
	assert.ok(s.undo());
	assert.equal(s.text, text + "\n## Z\n");
});
