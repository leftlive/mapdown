import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { isElement, isNode } from "../../src/view/domSafe.ts";

// A popout window is another realm: its elements are not `instanceof` our globals.
test("isElement and isNode accept objects from another realm", () => {
	class Element {}
	const foreign = vm.runInNewContext("({ nodeType: 1, closest() { return null; } })") as object;
	assert.equal(foreign instanceof Element, false);
	assert.equal(isElement(foreign), true);
	assert.equal(isNode(foreign), true);
});

test("isElement rejects text nodes, null and plain values", () => {
	assert.equal(isElement({ nodeType: 3 }), false);
	assert.equal(isNode({ nodeType: 3 }), true);
	assert.equal(isElement(null), false);
	assert.equal(isNode(undefined), false);
	assert.equal(isElement("div"), false);
	assert.equal(isNode({}), false);
});
