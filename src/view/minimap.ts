// Overview of a large map in a corner of the view (development plan 3.4).
// A canvas with one small rectangle per node, redrawn only when the layout
// changes, and a plain element for the visible area that is moved on every
// pan and zoom (a style write, no canvas painting). Click or drag jumps the
// view. The geometry is pure and unit-tested.

import type { Point } from "../core/types.ts";
import { DOM } from "./contract.ts";
import type { Rect } from "./viewport.ts";

/** The overview shows above this many visible nodes. */
export const MINIMAP_THRESHOLD = 300;
export const MINIMAP_WIDTH = 180;
export const MINIMAP_HEIGHT = 120;

export function shouldShowMinimap(nodeCount: number): boolean {
	return nodeCount > MINIMAP_THRESHOLD;
}

export interface MinimapGeometry {
	bounds: Rect;
	/** Minimap pixels per world unit. */
	scale: number;
	offsetX: number;
	offsetY: number;
}

/** Fit `bounds` into a `width` x `height` box, centred, keeping the aspect ratio. */
export function minimapGeometry(bounds: Rect, width: number, height: number): MinimapGeometry {
	const bw = Math.max(1, bounds.width);
	const bh = Math.max(1, bounds.height);
	const scale = Math.min(width / bw, height / bh);
	return { bounds, scale, offsetX: (width - bw * scale) / 2, offsetY: (height - bh * scale) / 2 };
}

/** The world point under minimap pixel `p`. */
export function minimapPointToWorld(g: MinimapGeometry, p: Point): Point {
	return { x: g.bounds.x + (p.x - g.offsetX) / g.scale, y: g.bounds.y + (p.y - g.offsetY) / g.scale };
}

/** A world rect in minimap pixels. */
export function viewRectInMinimap(g: MinimapGeometry, r: Rect): Rect {
	return {
		x: (r.x - g.bounds.x) * g.scale + g.offsetX,
		y: (r.y - g.bounds.y) * g.scale + g.offsetY,
		width: r.width * g.scale,
		height: r.height * g.scale,
	};
}

export class Minimap {
	private readonly el: HTMLElement;
	private readonly canvas: HTMLCanvasElement;
	private readonly box: HTMLElement;
	private readonly win: Window;
	private readonly abort = new AbortController();
	private geometry: MinimapGeometry | null = null;
	private nodes: readonly Rect[] = [];
	private view: Rect | null = null;
	private shown = false;
	private paintFrame: number | null = null;
	private dragging: number | null = null;

	private readonly jump: (world: Point) => void;

	constructor(parent: HTMLElement, jump: (world: Point) => void) {
		this.jump = jump;
		this.win = parent.win;
		this.el = parent.createDiv({ cls: DOM.minimap });
		this.el.setAttr("aria-hidden", "true");
		this.canvas = this.el.createEl("canvas", { cls: "mapdown-minimap-canvas" });
		this.box = this.el.createDiv({ cls: DOM.minimapView });
		this.el.hide();
		const opts = { signal: this.abort.signal };
		// the overview is not part of the map: its pointer input never reaches the map's gestures
		const stop = (e: Event): void => e.stopPropagation();
		for (const type of ["click", "dblclick", "contextmenu", "wheel", "pointerup", "pointercancel"]) this.el.addEventListener(type, stop, opts);
		this.el.addEventListener("pointerdown", (e) => {
			e.stopPropagation();
			e.preventDefault();
			this.dragging = e.pointerId;
			this.el.setPointerCapture(e.pointerId);
			this.jumpTo(e);
		}, opts);
		this.el.addEventListener("pointermove", (e) => {
			e.stopPropagation();
			if (this.dragging === e.pointerId) this.jumpTo(e);
		}, opts);
		const end = (e: PointerEvent): void => {
			if (this.dragging === e.pointerId) this.dragging = null;
		};
		this.el.addEventListener("pointerup", end, opts);
		this.el.addEventListener("pointercancel", end, opts);
	}

	get visible(): boolean {
		return this.shown;
	}

	setVisible(on: boolean): void {
		if (on === this.shown) return;
		this.shown = on;
		if (on) {
			this.el.show();
			this.schedulePaint();
		} else this.el.hide();
	}

	/** New layout: the node rectangles (world) and their bounds. Repainted on the next frame. */
	setLayout(nodes: readonly Rect[], bounds: Rect): void {
		this.nodes = nodes;
		this.geometry = minimapGeometry(bounds, MINIMAP_WIDTH, MINIMAP_HEIGHT);
		if (this.shown) this.schedulePaint();
		this.placeView();
	}

	/** The visible area changed (world rect). Moves one element; never paints the canvas. */
	setView(view: Rect): void {
		this.view = view;
		this.placeView();
	}

	destroy(): void {
		this.abort.abort();
		if (this.paintFrame !== null) this.win.cancelAnimationFrame(this.paintFrame);
		this.paintFrame = null;
		this.el.remove();
	}

	private jumpTo(e: PointerEvent): void {
		const g = this.geometry;
		if (!g) return;
		const r = this.el.getBoundingClientRect();
		this.jump(minimapPointToWorld(g, { x: e.clientX - r.left, y: e.clientY - r.top }));
	}

	private placeView(): void {
		const g = this.geometry;
		const v = this.view;
		if (!g || !v || !this.shown) return;
		const r = viewRectInMinimap(g, v);
		const s = this.box.style;
		s.setProperty("transform", `translate(${Math.round(r.x)}px, ${Math.round(r.y)}px)`);
		s.setProperty("width", `${Math.max(2, Math.round(r.width))}px`);
		s.setProperty("height", `${Math.max(2, Math.round(r.height))}px`);
	}

	private schedulePaint(): void {
		if (this.paintFrame !== null) return;
		this.paintFrame = this.win.requestAnimationFrame(() => {
			this.paintFrame = null;
			this.paint();
		});
	}

	private paint(): void {
		const g = this.geometry;
		if (!g || !this.shown) return;
		const dpr = Math.max(1, this.win.devicePixelRatio || 1);
		const w = Math.round(MINIMAP_WIDTH * dpr);
		const h = Math.round(MINIMAP_HEIGHT * dpr);
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
		}
		const ctx = this.canvas.getContext("2d");
		if (!ctx) return;
		ctx.clearRect(0, 0, w, h);
		ctx.fillStyle = this.win.getComputedStyle(this.el).getPropertyValue("--mapdown-minimap-node").trim() || "#888";
		for (const n of this.nodes) {
			const x = ((n.x - g.bounds.x) * g.scale + g.offsetX) * dpr;
			const y = ((n.y - g.bounds.y) * g.scale + g.offsetY) * dpr;
			ctx.fillRect(x, y, Math.max(1, n.width * g.scale * dpr), Math.max(1, n.height * g.scale * dpr));
		}
	}
}
