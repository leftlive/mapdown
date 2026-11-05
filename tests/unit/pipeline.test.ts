// Phase 1 acceptance: parse + layout together (development plan §4/§5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "../../src/core/parse.ts";
import { createLayouter, layout, DEFAULT_PALETTE, type LayoutInput } from "../../src/core/layout.ts";
import type { MapNode } from "../../src/core/types.ts";

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

function toInput(node: MapNode, collapsed: Set<string>): LayoutInput {
	return {
		id: node.id,
		// Fixed-size estimate, as the plan prescribes for the Node benchmark.
		size: { width: 20 + node.text.length * 7, height: 24 },
		collapsed: collapsed.has(node.id),
		children: node.children.map((c) => toInput(c, collapsed)),
	};
}

function count(node: MapNode): number {
	return 1 + node.children.reduce((s, c) => s + count(c), 0);
}

test("parse + layout of 1,000 nodes stays within 50 ms (median of 5)", (t) => {
	const text = bigDoc(1000);
	const run = (): number => {
		const start = performance.now();
		const doc = parseDocument(text);
		layout(toInput(doc.root, doc.collapsed), "mindmap", DEFAULT_PALETTE);
		return performance.now() - start;
	};
	assert.equal(count(parseDocument(text).root), 1000);
	run();
	const runs = Array.from({ length: 5 }, run).sort((a, b) => a - b);
	t.diagnostic(`parse+layout 1,000 nodes: median ${runs[2].toFixed(2)} ms, max ${runs[4].toFixed(2)} ms`);
	assert.ok(runs[2] <= 50, `median ${runs[2]} ms`);
});

test("layout is deterministic across fresh and reused layouters", () => {
	const doc = parseDocument(bigDoc(500));
	const input = toInput(doc.root, doc.collapsed);
	for (const dir of ["mindmap", "right", "left", "clockwise"] as const) {
		const a = layout(input, dir, DEFAULT_PALETTE);
		const b = layout(toInput(parseDocument(bigDoc(500)).root, doc.collapsed), dir, DEFAULT_PALETTE);
		const reused = createLayouter();
		reused.layout(input, dir, DEFAULT_PALETTE);
		const c = reused.layout(input, dir, DEFAULT_PALETTE);
		assert.deepEqual([...a.nodes.entries()], [...b.nodes.entries()]);
		assert.deepEqual([...a.nodes.entries()], [...c.nodes.entries()]);
		assert.deepEqual(a.edges, c.edges);
		assert.deepEqual(a.bounds, c.bounds);
	}
});
