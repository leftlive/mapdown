import { test } from "node:test";
import assert from "node:assert/strict";
import { MOBILE_ACTIONS, keyboardInset } from "../../src/view/mobileActions.ts";

// commands.ts imports the view (type only at runtime), so it loads in node.
import { COMMAND_BY_ID } from "../../src/commands.ts";

test("the node toolbar has the buttons of spec 4.2 and 5.8, each running an existing command", () => {
	const actions = MOBILE_ACTIONS.map((a) => a.action);
	assert.deepEqual(actions, [
		"add-child", "add-sibling", "edit", "delete", "promote", "demote",
		"move-up", "move-down", "toggle-collapse", "insert-image", "undo", "redo",
	]);
	assert.equal(new Set(actions).size, actions.length);
	for (const a of MOBILE_ACTIONS) assert.ok(COMMAND_BY_ID.has(a.command), `${a.action} -> ${a.command}`);
});

test("promote and demote run the indent commands; undo and redo the history ones", () => {
	const by = new Map(MOBILE_ACTIONS.map((a) => [a.action, a.command]));
	assert.equal(by.get("promote"), "key:outdent");
	assert.equal(by.get("demote"), "key:indent");
	assert.equal(by.get("undo"), "Undo");
	assert.equal(by.get("redo"), "Redo");
});

test("keyboardInset is how far the soft keyboard reaches into the view", () => {
	// view bottom at 800; the visual viewport ends at 500 -> 300 covered
	assert.equal(keyboardInset(800, 0, 500), 300);
	// viewport scrolled down by 40
	assert.equal(keyboardInset(800, 40, 460), 300);
	// keyboard closed
	assert.equal(keyboardInset(800, 0, 800), 0);
	// the view ends above the keyboard
	assert.equal(keyboardInset(400, 0, 500), 0);
});
