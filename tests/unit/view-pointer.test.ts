import { test } from "node:test";
import assert from "node:assert/strict";
import type { Modifiers } from "../../src/view/contract.ts";
import {
	GestureRecognizer,
	LONG_PRESS_MS,
	wheelAction,
	type GestureSink,
	type PointerInput,
	type Target,
} from "../../src/view/pointer.ts";

const NO: Modifiers = { mod: false, shift: false, alt: false, ctrl: false };
const NODE: Target = { kind: "node", id: "a" };
const BG: Target = { kind: "background" };

function rig(isMac = false) {
	const log: string[] = [];
	let t = 0;
	let nextTimer = 1;
	const timers = new Map<number, { at: number; fn: () => void }>();
	const sink: GestureSink = {
		click: (target, mods) => log.push(`click ${target.kind === "node" ? target.id : "bg"}${mods.mod ? " mod" : ""}`),
		doubleClick: (id) => log.push(`double ${id}`),
		contextMenu: (id) => log.push(`menu ${id}`),
		panBy: (dx, dy) => log.push(`pan ${dx},${dy}`),
		zoomAt: (f) => log.push(`zoom ${f.toFixed(2)}`),
		capture: () => {},
		boxUpdate: () => log.push("boxUpdate"),
		boxEnd: (_r, additive) => log.push(`boxEnd${additive ? " additive" : ""}`),
		boxCancel: () => log.push("boxCancel"),
		dragStart: (id) => log.push(`dragStart ${id}`),
		dragMove: () => log.push("dragMove"),
		dragEnd: (_at, mods) => log.push(`dragEnd${mods.ctrl ? " copy" : ""}`),
		dragCancel: () => log.push("dragCancel"),
	};
	const clock = {
		setTimeout(fn: () => void, ms: number) {
			const h = nextTimer++;
			timers.set(h, { at: t + ms, fn });
			return h;
		},
		clearTimeout(h: number) {
			timers.delete(h);
		},
	};
	const g = new GestureRecognizer(sink, clock, () => t, isMac);
	function advance(ms: number) {
		t += ms;
		for (const [h, timer] of [...timers]) {
			if (timer.at <= t) {
				timers.delete(h);
				timer.fn();
			}
		}
	}
	function ev(over: Partial<PointerInput>): PointerInput {
		return { id: 1, type: "mouse", button: 0, x: 0, y: 0, time: t, target: NODE, mods: NO, ...over };
	}
	return { g, log, advance, ev, timers, get t() { return t; } };
}

test("click selects; a second click soon after is a double click", () => {
	const r = rig();
	r.g.down(r.ev({}));
	r.g.up(r.ev({}));
	r.advance(100);
	r.g.down(r.ev({}));
	r.g.up(r.ev({ detail: 2 }));
	assert.deepEqual(r.log, ["click a", "double a"]);
});

test("two slow clicks are two clicks", () => {
	const r = rig();
	r.g.down(r.ev({}));
	r.g.up(r.ev({}));
	r.advance(1000);
	r.g.down(r.ev({}));
	r.g.up(r.ev({}));
	assert.deepEqual(r.log, ["click a", "click a"]);
});

test("moving less than 4 px is still a click; Mod is reported", () => {
	const r = rig();
	const mods = { ...NO, mod: true };
	r.g.down(r.ev({ mods }));
	r.g.move(r.ev({ x: 3, mods }));
	r.g.up(r.ev({ x: 3, mods }));
	assert.deepEqual(r.log, ["click a mod"]);
});

test("dragging a node moves it; Ctrl at release copies", () => {
	const r = rig();
	r.g.down(r.ev({}));
	r.g.move(r.ev({ x: 10 }));
	r.g.move(r.ev({ x: 20 }));
	r.g.up(r.ev({ x: 20, mods: { ...NO, ctrl: true } }));
	assert.deepEqual(r.log, ["dragStart a", "dragMove", "dragMove", "dragEnd copy"]);
});

test("left drag on background box-selects; a click right after is ignored", () => {
	const r = rig();
	r.g.down(r.ev({ target: BG, mods: { ...NO, shift: true } }));
	r.g.move(r.ev({ target: BG, x: 30, y: 30 }));
	r.g.up(r.ev({ target: BG, x: 30, y: 30 }));
	r.advance(100);
	r.g.down(r.ev({ target: BG }));
	r.g.up(r.ev({ target: BG }));
	r.advance(400);
	r.g.down(r.ev({ target: BG }));
	r.g.up(r.ev({ target: BG }));
	assert.deepEqual(r.log, ["boxUpdate", "boxEnd additive", "click bg"]);
});

test("middle drag pans anywhere", () => {
	const r = rig();
	r.g.down(r.ev({ button: 1 }));
	r.g.move(r.ev({ x: 5, y: 2 }));
	r.g.up(r.ev({ x: 5, y: 2 }));
	assert.deepEqual(r.log, ["pan 5,2"]);
});

test("right drag on background pans and suppresses the menu; a plain right click on a node opens it", () => {
	const r = rig();
	r.g.down(r.ev({ button: 2, target: BG }));
	r.g.move(r.ev({ button: 2, target: BG, x: 10 }));
	r.g.up(r.ev({ button: 2, target: BG, x: 10 }));
	// Windows fires contextmenu after the release, over whatever is below
	assert.equal(r.g.nativeContextMenu(NODE), null);
	assert.deepEqual(r.log, ["pan 10,0"]);
	r.g.down(r.ev({ button: 2 }));
	assert.equal(r.g.nativeContextMenu(NODE), "a");
	r.g.up(r.ev({ button: 2 }));
	assert.equal(r.g.nativeContextMenu(BG), null);
});

test("macOS Ctrl+click is a right click, not a node click", () => {
	const r = rig(true);
	r.g.down(r.ev({ mods: { ...NO, ctrl: true } }));
	r.g.up(r.ev({ mods: { ...NO, ctrl: true } }));
	assert.deepEqual(r.log, []);
	assert.equal(r.g.nativeContextMenu(NODE), "a");
});

test("touch: tap, double tap, one-finger pan", () => {
	const r = rig();
	const touch = { type: "touch" as const };
	r.g.down(r.ev(touch));
	r.g.up(r.ev(touch));
	r.advance(150);
	r.g.down(r.ev(touch));
	r.g.up(r.ev(touch));
	r.advance(600);
	r.g.down(r.ev({ ...touch, target: BG }));
	r.g.move(r.ev({ ...touch, target: BG, y: 20 }));
	r.g.up(r.ev({ ...touch, target: BG, y: 20 }));
	assert.deepEqual(r.log, ["click a", "double a", "pan 0,20"]);
	assert.equal(r.timers.size, 0, "no timer left behind");
});

test("touch: long press on a node opens the menu; long press then drag moves it", () => {
	const r = rig();
	const touch = { type: "touch" as const };
	r.g.down(r.ev(touch));
	r.advance(LONG_PRESS_MS + 10);
	r.g.up(r.ev(touch));
	assert.deepEqual(r.log, ["menu a"]);
	r.log.length = 0;
	r.advance(2000);
	r.g.down(r.ev(touch));
	r.advance(LONG_PRESS_MS + 10);
	r.g.move(r.ev({ ...touch, x: 30 }));
	r.g.up(r.ev({ ...touch, x: 30 }));
	assert.deepEqual(r.log, ["dragStart a", "dragMove", "dragEnd"]);
	assert.equal(r.g.nativeContextMenu(NODE), null, "native menu after touch is ignored");
});

test("touch: long press on background then drag box-selects", () => {
	const r = rig();
	const touch = { type: "touch" as const, target: BG };
	r.g.down(r.ev(touch));
	r.advance(LONG_PRESS_MS + 10);
	r.g.move(r.ev({ ...touch, x: 30, y: 30 }));
	r.g.up(r.ev({ ...touch, x: 30, y: 30 }));
	assert.deepEqual(r.log, ["boxUpdate", "boxEnd"]);
});

test("touch: pinch zooms and cancels the one-finger gesture", () => {
	const r = rig();
	r.g.down(r.ev({ type: "touch", id: 1, x: 0, y: 0, target: BG }));
	r.g.down(r.ev({ type: "touch", id: 2, x: 100, y: 0, target: BG }));
	r.g.move(r.ev({ type: "touch", id: 2, x: 200, y: 0, target: BG }));
	r.g.up(r.ev({ type: "touch", id: 1, target: BG }));
	r.g.move(r.ev({ type: "touch", id: 2, x: 300, y: 0, target: BG }));
	r.g.up(r.ev({ type: "touch", id: 2, x: 300, target: BG }));
	assert.deepEqual(r.log, ["pan 50,0", "zoom 2.00"]);
	assert.equal(r.g.busy, false);
	assert.equal(r.timers.size, 0);
});

test("pointercancel aborts a drag", () => {
	const r = rig();
	r.g.down(r.ev({}));
	r.g.move(r.ev({ x: 10 }));
	r.g.cancel(r.ev({ x: 10 }));
	assert.deepEqual(r.log, ["dragStart a", "dragMove", "dragCancel"]);
	assert.equal(r.g.busy, false);
});

test("wheel: Mod zooms, plain wheel pans, Shift scrolls sideways", () => {
	const z = wheelAction(0, -100, 0, true, false);
	assert.ok("zoom" in z && z.zoom > 1);
	assert.deepEqual(wheelAction(0, 30, 0, false, false), { dx: -0, dy: -30 });
	assert.deepEqual(wheelAction(0, 30, 0, false, true), { dx: -30, dy: -0 });
	assert.deepEqual(wheelAction(0, 3, 1, false, false), { dx: -0, dy: -48 });
});

test("click then Mod-click on the same node is not a double click", () => {
	const r = rig();
	const mods = { ...NO, mod: true };
	r.g.down(r.ev({}));
	r.g.up(r.ev({}));
	r.advance(100);
	r.g.down(r.ev({ mods }));
	r.g.up(r.ev({ mods, detail: 2 }));
	assert.deepEqual(r.log, ["click a", "click a mod"]);
});

test("a lost mouse release does not swallow the next press", () => {
	const r = rig();
	r.g.down(r.ev({ target: BG }));
	// pointerup never arrives; the next press is on a node
	r.advance(1000);
	r.g.down(r.ev({}));
	r.g.up(r.ev({}));
	assert.deepEqual(r.log, ["click a"]);
});

test("a right-drag pan suppresses only the next context menu", () => {
	const r = rig();
	r.g.down(r.ev({ button: 2, target: BG }));
	r.g.move(r.ev({ button: 2, target: BG, x: 10 }));
	r.g.up(r.ev({ button: 2, target: BG, x: 10 }));
	assert.equal(r.g.nativeContextMenu(NODE), null);
	assert.equal(r.g.nativeContextMenu(NODE), "a", "keyboard menu later still works");
});
