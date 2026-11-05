// Node sizes: Markdown detection, per-depth font, a text-wrap estimate for
// nodes without DOM, and the size cache keyed by content + max width + font.
// Pure; the renderer injects a canvas-based `measure` function.

import type { NodeKind, Size } from "../core/types.ts";

/** Border width of every node; keep in sync with `.mapdown-node` in styles.css. */
export const NODE_BORDER = 1;
/** Unitless line height used by `.mapdown-node`; keep in sync with styles.css. */
export const LINE_HEIGHT = 1.45;

/**
 * The four visual levels: root, first level, second level, everything deeper.
 * `scale` multiplies the base font size; `padX`/`padY` must match the
 * `--mapdown-pad-x`/`--mapdown-pad-y` of the level classes in styles.css,
 * `radius` their border radius (the export draws it).
 */
export const NODE_LEVELS: readonly { scale: number; weight: number; padX: number; padY: number; radius: number }[] = [
	{ scale: 1.4375, weight: 700, padX: 28, padY: 14, radius: 6 },
	{ scale: 1.0625, weight: 600, padX: 18, padY: 9, radius: 4 },
	{ scale: 0.9375, weight: 400, padX: 14, padY: 6, radius: 3 },
	{ scale: 0.875, weight: 400, padX: 11, padY: 4, radius: 3 },
];

/**
 * Characters that may start Markdown or HTML syntax. Conservative: a false
 * "rich" only costs one renderMarkdown call, a false "plain" shows raw syntax.
 */
const SYNTAX = /[*_`[\]!<>=~$#\\|&^]|:\/\//;

/** True when the node can be drawn by writing its text directly. */
export function isPlainText(text: string, kind: NodeKind): boolean {
	if (kind === "code" || kind === "table") return false;
	return !SYNTAX.test(text);
}

/** Source handed to renderMarkdown: line breaks inside one block become `<br>`. */
export function markdownSource(text: string, kind: NodeKind): string {
	if (kind === "code" || kind === "table") return text;
	return text.replace(/\r?\n/g, "<br>");
}

export interface NodeFont {
	px: number;
	weight: number;
	/** Visual level: 0 root, 1 first level, 2 second level, 3 deeper. */
	level: number;
	padX: number;
	padY: number;
	radius: number;
}

/** Font and box metrics of a node at `depth` (feature doc: per-level look). */
export function fontFor(depth: number, base: number): NodeFont {
	const level = Math.min(Math.max(0, depth), NODE_LEVELS.length - 1);
	const l = NODE_LEVELS[level];
	return { px: Math.round(base * l.scale), weight: l.weight, level, padX: l.padX, padY: l.padY, radius: l.radius };
}

/** Horizontal padding plus border of a node, both sides. */
export function extraW(font: NodeFont): number {
	return 2 * (font.padX + NODE_BORDER);
}

/** Vertical padding plus border of a node, both sides. */
export function extraH(font: NodeFont): number {
	return 2 * (font.padY + NODE_BORDER);
}

export function sizeKey(text: string, font: NodeFont, maxWidth: number): string {
	return `${font.px}|${font.weight}|${font.level}|${maxWidth}|${text}`;
}

const CJK = "⺀-鿿　-〿가-힯豈-﫿＀-￯";
const TOKEN = new RegExp(`\\s+|[${CJK}]|[^\\s${CJK}]+`, "g");

/**
 * Greedy wrap like CSS `white-space: pre-wrap; overflow-wrap: anywhere`.
 * Returns the line count and the widest line (content box, no padding).
 */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): { lines: number; width: number } {
	const max = Math.max(1, maxWidth);
	let lines = 0;
	let widest = 0;
	for (const hard of text.split("\n")) {
		lines++;
		const whole = measure(hard);
		if (whole <= max) {
			if (whole > widest) widest = whole;
			continue;
		}
		let line = 0;
		let space = 0;
		const tokens = hard.match(TOKEN) ?? [];
		for (const tok of tokens) {
			const w = measure(tok);
			if (/^\s/.test(tok)) {
				space += w;
				continue;
			}
			if (line + space + w <= max) {
				line += space + w;
			} else if (w <= max) {
				if (line > widest) widest = line;
				lines++;
				line = w;
			} else {
				// too long for any line: break between characters
				line += space;
				for (const ch of tok) {
					const cw = measure(ch);
					if (line + cw > max && line > 0) {
						if (line > widest) widest = line;
						lines++;
						line = 0;
					}
					line += cw;
				}
			}
			space = 0;
		}
		if (line > widest) widest = line;
	}
	return { lines, width: Math.min(widest, max) };
}

/** Border-box size from a content-box size, clamped like the node's max width; integers. */
export function boxSize(contentW: number, contentH: number, font: NodeFont, maxWidth: number): Size {
	const ew = extraW(font);
	return {
		width: Math.min(Math.max(Math.ceil(contentW), font.px) + ew, Math.max(maxWidth, font.px + ew)),
		height: Math.ceil(contentH) + extraH(font),
	};
}

/**
 * Size from a measured content box, or null when the box is not laid out
 * (inside `display: none`, or detached): offsetWidth and offsetHeight are then 0.
 */
export function domSize(contentW: number, contentH: number, font: NodeFont, maxWidth: number): Size | null {
	if (contentW === 0 && contentH === 0) return null;
	return boxSize(contentW, contentH, font, maxWidth);
}

/** Estimated border-box size of a node; integers, like offsetWidth. */
export function estimateSize(text: string, font: NodeFont, maxWidth: number, measure: (s: string) => number): Size {
	const r = wrapText(text, maxWidth - extraW(font), measure);
	return boxSize(r.width, r.lines * font.px * LINE_HEIGHT, font, maxWidth);
}

interface Entry {
	width: number;
	height: number;
	real: boolean;
	gen: number;
}

/** Sizes by `sizeKey`. A real (DOM-measured) size is never replaced by an estimate. */
export class SizeCache {
	private map = new Map<string, Entry>();
	private gen = 0;

	beginGeneration(): void {
		this.gen++;
	}

	get(key: string): { width: number; height: number; real: boolean } | undefined {
		const e = this.map.get(key);
		if (!e) return undefined;
		e.gen = this.gen;
		return { width: e.width, height: e.height, real: e.real };
	}

	setReal(key: string, size: Size): void {
		this.map.set(key, { width: size.width, height: size.height, real: true, gen: this.gen });
	}

	setEstimate(key: string, size: Size): void {
		const e = this.map.get(key);
		if (e?.real) return;
		this.map.set(key, { width: size.width, height: size.height, real: false, gen: this.gen });
	}

	/** Forgets every estimate; real sizes stay. */
	dropEstimates(): void {
		for (const [k, e] of this.map) if (!e.real) this.map.delete(k);
	}

	delete(key: string): void {
		this.map.delete(key);
	}

	get size(): number {
		return this.map.size;
	}

	/** Drops entries not used in the current generation once there are more than `limit`. */
	prune(limit: number): void {
		if (this.map.size <= limit) return;
		for (const [k, e] of this.map) if (e.gen !== this.gen) this.map.delete(k);
	}

	clear(): void {
		this.map.clear();
	}
}

/** Custom property that styles.css sets on `.mapdown-map`; while it is missing the plugin CSS is not applied. */
export const MEASURE_SENTINEL = "--mapdown-css-ready";

/**
 * Decides when DOM sizes can be trusted. Without the plugin CSS a node's content
 * fills its block parent (every node measures at the max width), and a map that
 * is hidden measures 0; a size read then would be cached as real for good. The
 * renderer skips such reads, keeps the estimates, and measures again once
 * `retry` says it can.
 */
export class MeasureGate {
	private css = false;
	private pending = false;
	private readonly probeCss: () => boolean;
	private readonly laidOut: () => boolean;

	constructor(probeCss: () => boolean, laidOut: () => boolean) {
		this.probeCss = probeCss;
		this.laidOut = laidOut;
	}

	/** Once per read phase, and only when there is something to read. False: skip the reads. */
	canMeasure(): boolean {
		if (!this.css) this.css = this.probeCss();
		const ok = this.css && this.laidOut();
		if (!ok) this.pending = true;
		return ok;
	}

	/** A read was skipped for want of the CSS; only a poll can tell when it arrives. */
	get waitingForCss(): boolean {
		return this.pending && !this.css;
	}

	/** True once, when a skipped read can be made now (the CSS arrived, the map was laid out). */
	retry(): boolean {
		if (!this.pending) return false;
		if (!this.css) this.css = this.probeCss();
		if (!this.css || !this.laidOut()) return false;
		this.pending = false;
		return true;
	}
}
