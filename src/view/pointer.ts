// Gesture recognition for mouse, pen and touch (behaviour spec 4.1, 4.2).
// Turns raw pointer input into semantic gestures. Pure: the clock is
// injected so long press and double tap are testable, and every timer is
// cancelled on the next transition.

import type { Point } from "../core/types.ts";
import type { Modifiers } from "./contract.ts";

export type Target = { kind: "node"; id: string } | { kind: "background" };

export interface PointerInput {
	id: number;
	type: "mouse" | "pen" | "touch";
	/** 0 left, 1 middle, 2 right. */
	button: number;
	/** Screen position relative to the map viewport. */
	x: number;
	y: number;
	time: number;
	target: Target;
	mods: Modifiers;
	/** Click count reported by the browser (2 on the second click of a double click). */
	detail?: number;
}

export interface BoxRect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

export interface GestureSink {
	click(target: Target, mods: Modifiers): void;
	doubleClick(id: string): void;
	contextMenu(id: string, at: Point): void;
	panBy(dx: number, dy: number): void;
	zoomAt(factor: number, at: Point): void;
	/** A gesture that needs pointer capture started (pan, box, drag, pinch). */
	capture(pointerId: number): void;
	boxUpdate(rect: BoxRect): void;
	boxEnd(rect: BoxRect, additive: boolean): void;
	boxCancel(): void;
	dragStart(id: string, at: Point): void;
	dragMove(at: Point, mods: Modifiers): void;
	dragEnd(at: Point, mods: Modifiers): void;
	dragCancel(): void;
}

export interface Clock {
	setTimeout(fn: () => void, ms: number): number;
	clearTimeout(handle: number): void;
}

export const MOUSE_SLOP = 4;
export const TOUCH_SLOP = 8;
export const LONG_PRESS_MS = 500;
export const DOUBLE_MS = 400;
export const DOUBLE_DIST = 12;
/** Background clicks right after a box selection are ignored (spec 4.1). */
export const AFTER_BOX_MS = 300;
/** A native contextmenu this soon after touch input belongs to the touch gesture. */
const TOUCH_MENU_MS = 1000;

type Mode =
	| "idle"
	| "pending" // pressed, not moved yet
	| "armed" // touch long press reached, not moved yet
	| "pan"
	| "rightPending" // right button down on background
	| "box"
	| "drag"
	| "pinch"
	| "settle"; // pinch ended; wait for every finger to lift

interface Active {
	id: number;
	x: number;
	y: number;
}

export class GestureRecognizer {
	private mode: Mode = "idle";
	private start: PointerInput | null = null;
	private last: Point = { x: 0, y: 0 };
	private pointers = new Map<number, Active>();
	private timer: number | null = null;
	private lastClick: { id: string; time: number; x: number; y: number; plain: boolean } | null = null;
	private lastBoxEnd = -Infinity;
	private lastTouch = -Infinity;
	private rightPanned = false;
	private pinchDist = 0;
	private pinchMid: Point = { x: 0, y: 0 };

	private readonly sink: GestureSink;
	private readonly clock: Clock;
	private readonly now: () => number;
	private readonly isMac: boolean;

	constructor(sink: GestureSink, clock: Clock, now: () => number, isMac: boolean) {
		this.sink = sink;
		this.clock = clock;
		this.now = now;
		this.isMac = isMac;
	}

	get busy(): boolean {
		return this.mode !== "idle";
	}

	down(p: PointerInput): void {
		if (p.type === "touch") this.lastTouch = p.time;
		// a mouse or pen release we never saw (window lost focus): start over
		if (p.type !== "touch" && this.mode !== "idle" && this.start?.id === p.id) this.abort();
		this.pointers.set(p.id, { id: p.id, x: p.x, y: p.y });
		if (this.mode !== "idle") {
			if (p.type === "touch" && this.pointers.size === 2 && this.start?.type === "touch") this.beginPinch();
			return;
		}
		// macOS: Ctrl+left click is a right click
		const button = this.isMac && p.button === 0 && p.mods.ctrl && p.type === "mouse" ? 2 : p.button;
		this.start = p;
		this.last = { x: p.x, y: p.y };
		if (button === 1) {
			this.mode = "pan";
			this.sink.capture(p.id);
		} else if (button === 2) {
			this.rightPanned = false;
			this.mode = p.target.kind === "background" ? "rightPending" : "idle";
			if (this.mode === "idle") this.pointers.delete(p.id);
		} else if (button === 0) {
			this.mode = "pending";
			if (p.type === "touch") {
				this.clearTimer();
				this.timer = this.clock.setTimeout(() => {
					this.timer = null;
					if (this.mode === "pending") this.mode = "armed";
				}, LONG_PRESS_MS);
			}
		} else {
			this.pointers.delete(p.id);
		}
	}

	move(p: PointerInput): void {
		const active = this.pointers.get(p.id);
		if (!active) return;
		active.x = p.x;
		active.y = p.y;
		const s = this.start;
		if (this.mode === "pinch") {
			this.updatePinch();
			return;
		}
		if (!s || s.id !== p.id) return;
		const dist = Math.hypot(p.x - s.x, p.y - s.y);
		const slop = s.type === "touch" ? TOUCH_SLOP : MOUSE_SLOP;
		switch (this.mode) {
			case "pan":
				this.sink.panBy(p.x - this.last.x, p.y - this.last.y);
				break;
			case "rightPending":
				if (dist >= MOUSE_SLOP) {
					this.mode = "pan";
					this.rightPanned = true;
					this.sink.capture(p.id);
					this.sink.panBy(p.x - s.x, p.y - s.y);
				}
				break;
			case "pending":
				if (dist < slop) return;
				this.clearTimer();
				this.sink.capture(p.id);
				if (s.type === "touch") {
					this.mode = "pan";
					this.sink.panBy(p.x - s.x, p.y - s.y);
				} else this.beginDragOrBox(s, p);
				break;
			case "armed":
				if (dist < slop) return;
				this.sink.capture(p.id);
				this.beginDragOrBox(s, p);
				break;
			case "box":
				this.sink.boxUpdate(rectOf(s, p));
				break;
			case "drag":
				this.sink.dragMove({ x: p.x, y: p.y }, p.mods);
				break;
			default:
				break;
		}
		this.last = { x: p.x, y: p.y };
	}

	up(p: PointerInput): void {
		if (p.type === "touch") this.lastTouch = p.time;
		if (!this.pointers.has(p.id)) return;
		this.pointers.delete(p.id);
		if (this.mode === "pinch" || this.mode === "settle") {
			this.mode = this.pointers.size === 0 ? "idle" : "settle";
			if (this.mode === "idle") this.start = null;
			return;
		}
		const s = this.start;
		if (!s || s.id !== p.id) return;
		const mode = this.mode;
		this.reset();
		switch (mode) {
			case "pending":
				this.tap(s, p);
				break;
			case "armed":
				if (s.target.kind === "node") this.sink.contextMenu(s.target.id, { x: p.x, y: p.y });
				break;
			case "box":
				this.lastBoxEnd = p.time;
				this.sink.boxEnd(rectOf(s, p), s.mods.mod || s.mods.shift || p.mods.mod || p.mods.shift);
				break;
			case "drag":
				this.sink.dragEnd({ x: p.x, y: p.y }, p.mods);
				break;
			default:
				break;
		}
	}

	cancel(p: PointerInput): void {
		if (!this.pointers.has(p.id)) return;
		this.pointers.delete(p.id);
		if (this.mode === "pinch" || this.mode === "settle") {
			this.mode = this.pointers.size === 0 ? "idle" : "settle";
			return;
		}
		if (this.start?.id === p.id) this.abort();
	}

	/**
	 * A native `contextmenu` event. Returns the node id the menu is for, or
	 * null when the event belongs to a pan, a touch gesture or the background.
	 */
	nativeContextMenu(target: Target): string | null {
		if (this.now() - this.lastTouch < TOUCH_MENU_MS) return null;
		const panned = this.rightPanned;
		this.rightPanned = false;
		if (panned || this.mode === "pan") return null;
		return target.kind === "node" ? target.id : null;
	}

	/** Ends whatever is in progress without committing it. */
	abort(): void {
		const mode = this.mode;
		this.reset();
		this.pointers.clear();
		if (mode === "box") this.sink.boxCancel();
		if (mode === "drag") this.sink.dragCancel();
	}

	private reset(): void {
		this.clearTimer();
		this.mode = "idle";
		this.start = null;
	}

	private clearTimer(): void {
		if (this.timer !== null) this.clock.clearTimeout(this.timer);
		this.timer = null;
	}

	private beginDragOrBox(s: PointerInput, p: PointerInput): void {
		if (s.target.kind === "node") {
			this.mode = "drag";
			this.sink.dragStart(s.target.id, { x: s.x, y: s.y });
			this.sink.dragMove({ x: p.x, y: p.y }, p.mods);
		} else {
			this.mode = "box";
			this.sink.boxUpdate(rectOf(s, p));
		}
	}

	private tap(s: PointerInput, p: PointerInput): void {
		if (s.target.kind === "background") {
			this.lastClick = null;
			if (p.time - this.lastBoxEnd < AFTER_BOX_MS) return;
			this.sink.click(s.target, s.mods);
			return;
		}
		const id = s.target.id;
		const prev = this.lastClick;
		const near = prev !== null && Math.hypot(prev.x - p.x, prev.y - p.y) <= (s.type === "touch" ? DOUBLE_DIST * 2 : DOUBLE_DIST);
		// Mod or Shift clicks toggle and extend; they never make a double click
		const plain = !s.mods.mod && !s.mods.shift;
		const isDouble =
			plain &&
			prev !== null &&
			prev.plain &&
			prev.id === id &&
			((p.time - prev.time <= DOUBLE_MS && near) || (s.type !== "touch" && (p.detail ?? 0) >= 2));
		if (isDouble) {
			this.lastClick = null;
			this.sink.doubleClick(id);
			return;
		}
		this.lastClick = { id, time: p.time, x: p.x, y: p.y, plain };
		this.sink.click(s.target, s.mods);
	}

	private beginPinch(): void {
		const s = this.start;
		if (this.mode === "box") this.sink.boxCancel();
		if (this.mode === "drag") this.sink.dragCancel();
		this.clearTimer();
		this.mode = "pinch";
		if (s) this.sink.capture(s.id);
		const [a, b] = [...this.pointers.values()];
		this.pinchDist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
		this.pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	}

	private updatePinch(): void {
		const pts = [...this.pointers.values()];
		if (pts.length < 2) return;
		const [a, b] = pts;
		const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
		const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
		this.sink.panBy(mid.x - this.pinchMid.x, mid.y - this.pinchMid.y);
		if (dist !== this.pinchDist) this.sink.zoomAt(dist / this.pinchDist, mid);
		this.pinchDist = dist;
		this.pinchMid = mid;
	}
}

function rectOf(a: Point, b: Point): BoxRect {
	return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

/** Wheel input to a zoom factor or a pan (behaviour spec 4.1: Mod+wheel zooms, plain wheel pans). */
export function wheelAction(
	deltaX: number,
	deltaY: number,
	deltaMode: number,
	zoomKey: boolean,
	shift: boolean,
): { zoom: number } | { dx: number; dy: number } {
	const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
	let dx = deltaX * unit;
	let dy = deltaY * unit;
	if (zoomKey) {
		const d = Math.max(-50, Math.min(50, dy));
		return { zoom: Math.exp(-d * 0.006) };
	}
	if (shift && dx === 0) {
		dx = dy;
		dy = 0;
	}
	return { dx: -dx, dy: -dy };
}
