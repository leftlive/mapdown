import { test } from "node:test";
import assert from "node:assert/strict";
import { childPosition, deleteNodes, pasteMarkdown } from "../../src/core/ops.ts";
import { parseDocument } from "../../src/core/parse.ts";
import type { MapNode, ParsedDoc } from "../../src/core/types.ts";
import { collapseSteps, DocSession, keepSelection } from "../../src/controller/session.ts";
import { collapseToggleTarget } from "../../src/controller/selectionOps.ts";
import { edgeScroll, EDGE_MARGIN, EDGE_MAX_SPEED } from "../../src/view/autoScroll.ts";

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
const shape = (n: MapNode): string => n.text + (n.children.length ? `(${n.children.map(shape).join(" ")})` : "");

// ------------------------------------------------------------ collapse toggle

test("collapseToggleTarget: every selected node with children follows the primary", () => {
	const doc = parseDocument(FM + "# Root\n\n## A\n\n- A1\n\n## B\n\n- B1\n\n## C\n");
	const [a, b, c] = ["A", "B", "C"].map((t) => find(doc.root, t));
	// primary open: collapse all selected parents; the leaf C and the root are ignored
	const shut = collapseToggleTarget(doc.root, new Set(), [doc.root, a, b, c], b.id);
	assert.deepEqual([...(shut ?? [])].sort(), [a.id, b.id].sort());
	// primary collapsed: open every selected node, keep unrelated collapsed ones
	const open = collapseToggleTarget(doc.root, new Set([a.id, "other"]), [a, b], a.id);
	assert.deepEqual([...(open ?? [])], ["other"]);
	// primary is a leaf: the first selected node with children decides
	const viaFirst = collapseToggleTarget(doc.root, new Set([b.id]), [c, b, a], c.id);
	assert.deepEqual([...(viaFirst ?? [])], []);
	// nothing to toggle
	assert.equal(collapseToggleTarget(doc.root, new Set(), [c], c.id), null);
});

// ------------------------------------------------------------ drag auto-scroll

test("edgeScroll: pans towards the edge the pointer is near, faster when closer", () => {
	const size = { width: 800, height: 600 };
	assert.deepEqual(edgeScroll({ x: 400, y: 300 }, size), { dx: 0, dy: 0 });
	const right = edgeScroll({ x: 800 - EDGE_MARGIN / 2, y: 300 }, size);
	assert.ok(right.dx < 0 && right.dy === 0, "near the right edge the map moves left");
	const nearer = edgeScroll({ x: 799, y: 300 }, size);
	assert.ok(nearer.dx < right.dx, "closer is faster");
	assert.ok(Math.abs(edgeScroll({ x: 2000, y: 300 }, size).dx) <= EDGE_MAX_SPEED, "speed is capped");
	const topLeft = edgeScroll({ x: 1, y: 1 }, size);
	assert.ok(topLeft.dx > 0 && topLeft.dy > 0, "near the top-left corner the map moves right and down");
	// a view smaller than two margins never scrolls from its centre
	assert.deepEqual(edgeScroll({ x: 30, y: 30 }, { width: 60, height: 60 }), { dx: 0, dy: 0 });
});

// ------------------------------------------------------------ paste shapes (spec 7)

test("pasteMarkdown: one line is one child; an outline becomes a subtree", () => {
	const base = FM + "# Root\n\n## Dst\n";
	const paste = (md: string): string => {
		const s = new DocSession(base, "f");
		const dst = byText(s.doc, "Dst");
		const pos = childPosition(s.doc, dst, "last");
		assert.ok(pos);
		assert.ok(s.run([(d) => {
			const result = pasteMarkdown(d, md, pos);
			return result ? { result } : null;
		}]));
		return shape(s.doc.root);
	};
	assert.equal(paste("hello"), "Root(Dst(hello))");
	assert.equal(paste("- a\n  - b\n- c"), "Root(Dst(a(b) c))");
	assert.equal(paste("# A\n## B\n## C\n"), "Root(Dst(A(B C)))");
	assert.equal(paste("* x\n\t* y\n\t\t* z\n"), "Root(Dst(x(y(z))))");
});

// ------------------------------------------------------------ undo of delete

test("undo of a multi delete restores the selection, and collapse inside the deleted subtree", () => {
	const text = FM + "# Root\n\n## A\n\n- A1\n\t- A1a\n\n## B\n\n## C\n";
	const s = new DocSession(text, "f");
	const a1 = byText(s.doc, "A1");
	assert.ok(s.run(collapseSteps(new Set([a1]), () => 0.5), { select: keepSelection(s) }));
	assert.equal(s.view.collapsed.size, 1);
	const collapsedText = s.text;
	const a = byText(s.doc, "A");
	const c = byText(s.doc, "C");
	s.setSelection([a, c], c);
	assert.ok(s.run([(d) => {
		const result = deleteNodes(d, [a, c]);
		return result ? { result } : null;
	}], { select: () => ({ ids: [], primary: null }) }));
	assert.equal(shape(s.doc.root), "Root(B)");
	assert.ok(s.undo());
	assert.equal(s.text, collapsedText);
	assert.deepEqual(s.view.selection.ids, [byText(s.doc, "A"), byText(s.doc, "C")]);
	assert.equal(s.view.selection.primary, byText(s.doc, "C"));
	assert.deepEqual([...s.view.collapsed], [byText(s.doc, "A1")]);
	// (A1 may come back under a new id; collapse lives in the text, so it is restored anyway.)
	assert.ok(s.redo());
	assert.equal(shape(s.doc.root), "Root(B)");
	assert.ok(s.undo());
	assert.deepEqual([...s.view.collapsed], [byText(s.doc, "A1")]);
});
