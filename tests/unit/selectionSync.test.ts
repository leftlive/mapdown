// The rules of split-view selection sync (behaviour spec 5.6): when a map
// selection is followed in Markdown, when a cursor move is resolved, and why
// the two never echo each other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SelectionSync, type SyncEnv } from "../../src/controller/selectionSync.ts";

const env = (over: Partial<SyncEnv> = {}): SyncEnv => ({
	enabled: true,
	mapActive: true,
	editorFocused: false,
	editorCurrent: () => true,
	...over,
});

test("a changed map selection is revealed once; the same selection again is not", () => {
	const s = new SelectionSync();
	s.reset("root");
	assert.equal(s.afterRender("root", env()), null, "opening is not a selection");
	assert.equal(s.afterRender("a", env()), "a");
	assert.equal(s.afterRender("a", env()), null, "clicking the selected node again does not sync again");
	assert.equal(s.afterRender(null, env()), null);
	assert.equal(s.afterRender("a", env()), "a", "re-selecting after a clear syncs");
});

test("nothing is revealed when sync is off, the map is not active, or the editor has focus", () => {
	for (const over of [{ enabled: false }, { mapActive: false }, { editorFocused: true }]) {
		const s = new SelectionSync();
		s.reset("root");
		assert.equal(s.afterRender("a", env(over)), null, JSON.stringify(over));
		// And it does not fire later either: the selection is taken as seen.
		assert.equal(s.afterRender("a", env()), null);
	}
});

test("a selection coming from the editor is not sent back (no ping-pong)", () => {
	const s = new SelectionSync();
	s.reset("root");
	assert.equal(s.cursor(4, false), 4);
	s.selectedFromEditor("n4");
	assert.equal(s.afterRender("n4", env({ editorFocused: false })), null);
});

test("text changed elsewhere: the surviving selection is not a map selection", () => {
	const s = new SelectionSync();
	s.reset("a");
	s.adopt("b");
	assert.equal(s.afterRender("b", env()), null);
});

test("a cursor move while typed text waits for its re-parse is resolved after it, only if the editor still has focus", () => {
	const s = new SelectionSync();
	s.reset("root");
	assert.equal(s.cursor(7, true), null);
	assert.equal(s.cursor(8, true), null);
	assert.deepEqual(s.afterFlush(true), { line: 8, reveal: false });
	assert.deepEqual(s.afterFlush(true), { line: null, reveal: false }, "used once");
	assert.equal(s.cursor(9, true), null);
	assert.deepEqual(s.afterFlush(false), { line: null, reveal: false }, "the user moved to the map meanwhile");
});

test("a map selection made while the editor lags behind is revealed after the editor catches up", () => {
	const s = new SelectionSync();
	s.reset("root");
	assert.equal(s.afterRender("a", env({ editorCurrent: () => false })), null);
	assert.deepEqual(s.afterFlush(false), { line: null, reveal: true });
	assert.deepEqual(s.afterFlush(false), { line: null, reveal: false });
	// A cursor selection in between cancels the waiting reveal.
	assert.equal(s.afterRender("b", env({ editorCurrent: () => false })), null);
	s.selectedFromEditor("c");
	assert.deepEqual(s.afterFlush(false), { line: null, reveal: false });
	// So does the editor taking focus.
	assert.equal(s.afterRender("d", env({ editorCurrent: () => false })), null);
	assert.deepEqual(s.afterFlush(true), { line: null, reveal: false });
});

test("the editor text is compared only when a reveal is due", () => {
	const s = new SelectionSync();
	s.reset("root");
	let calls = 0;
	const e = env({ editorCurrent: () => (calls++, true) });
	s.afterRender("root", e);
	s.afterRender("a", env({ enabled: false, editorCurrent: e.editorCurrent }));
	assert.equal(calls, 0);
	s.afterRender("b", e);
	assert.equal(calls, 1);
});

test("changed() tells whether a render has anything to consider", () => {
	const s = new SelectionSync();
	s.reset("a");
	assert.equal(s.changed("a"), false);
	assert.equal(s.changed("b"), true);
	s.afterRender("b", env({ enabled: false }));
	assert.equal(s.changed("b"), false);
});
