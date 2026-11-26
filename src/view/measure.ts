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

const QUOTE_LINE = /^ *>/;

/** True when every line of the text starts with `>` (a blockquote or callout, spec 5.6). */
export function isQuoteText(text: string): boolean {
	const lines = text.replace(/(\r?\n)+$/, "").split(/\r?\n/);
	return lines.every((l) => QUOTE_LINE.test(l));
}

/** Estimated width of a quote's bar (`--blockquote-border-thickness` is 2px by default); the DOM size replaces it. */
export const QUOTE_BAR_PX = 2;
/** The gap between a quote's bar and its text, in em (spec 5.6). */
export const QUOTE_GAP_EM = 0.6;

/** A callout's first line: `> [!type]`. Callouts have no quote bar (spec 5.6). */
const CALLOUT_LINE = /^ *>[ \t]*\[!/;

/**
 * How many quote bars the text shows: 0 when it is no quote or a callout,
 * otherwise the deepest nesting (`> > a` is 2). Every level has a bar and a gap.
 */
export function quoteBarLevels(text: string): number {
	if (!isQuoteText(text) || CALLOUT_LINE.test(text)) return 0;
	let levels = 1;
	for (const line of text.replace(/(\r?\n)+$/, "").split(/\r?\n/)) {
		const m = /^ *((?:> ?)+)/.exec(line);
		const n = m ? (m[1].match(/>/g) ?? []).length : 1;
		if (n > levels) levels = n;
	}
	return levels;
}

/** Width the bars and gaps of a quote take left of its text. */
export function quoteInset(levels: number, fontPx: number, barPx = QUOTE_BAR_PX): number {
	return levels * (barPx + QUOTE_GAP_EM * fontPx);
}

/** A closed `$$ … $$` span; line breaks inside it must stay real newlines for MathJax. */
const DISPLAY_MATH = /\$\$[\s\S]*?\$\$/g;

/**
 * Source handed to renderMarkdown: line breaks inside one block become `<br>`
 * (except inside a closed `$$ … $$` span); a quote keeps its lines.
 */
export function markdownSource(text: string, kind: NodeKind): string {
	if (kind === "code" || kind === "table") return text;
	if (isQuoteText(text)) return text;
	const br = (s: string): string => s.replace(/\r?\n/g, "<br>");
	let out = "";
	let last = 0;
	for (const m of text.matchAll(DISPLAY_MATH)) {
		out += br(text.slice(last, m.index)) + m[0];
		last = m.index + m[0].length;
	}
	return out + br(text.slice(last));
}

/**
 * The text a quote or callout shows, for the size estimate: no `>` markers,
 * and a callout's `[!type]+ Title` line as its title (the type when untitled).
 */
export function quoteShown(text: string): string {
	const lines = text
		.replace(/(\r?\n)+$/, "")
		.split(/\r?\n/)
		.map((l) => l.replace(/^ *(?:> ?)+/, ""));
	const m = /^\[!([^\]\s]+)\][+-]?[ \t]*(.*)$/.exec(lines[0] ?? "");
	if (m) {
		const type = m[1];
		lines[0] = m[2].trim() !== "" ? m[2].trim() : type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
	}
	return lines.join("\n");
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

/**
 * Task checkbox and progress label (spec 5.9), in em of the node's font. Keep
 * in sync with `.mapdown-task-checkbox` and `.mapdown-task-progress` in styles.css.
 */
export const TASK_BOX_EM = 1;
export const TASK_GAP_EM = 0.4;
/** The label's font size relative to the node's; it is drawn at weight 400. */
export const PROGRESS_SCALE = 0.75;
/** Gap before the label, in em of the label's own (smaller) font. */
export const PROGRESS_GAP_EM = 0.6;
export const PROGRESS_WEIGHT = 400;

/**
 * Node markers (spec 5.14), in em of the node's font: each emoji at 1.15 times
 * the font size (weight 400), 0.25em between two, 0.4em before the text. Keep
 * in sync with `.mapdown-node-markers` in styles.css.
 */
export const MARKER_SCALE = 1.15;
export const MARKER_GAP_EM = 0.25;
export const MARKER_AFTER_EM = 0.4;
export const MARKER_WEIGHT = 400;

/** What sits beside a node's text: a checkbox and markers in front, a "done/total" label after. */
export interface NodeDecor {
	task: boolean;
	/** E.g. "2/5"; null when the node shows no progress. */
	progress: string | null;
	/** Markers before the text (after the checkbox); absent or empty for none. */
	markers?: readonly string[];
	/** Nothing follows the markers: no gap after the last one. */
	markersOnly?: boolean;
}

/** Font of a node's markers (for measuring them). */
export function markerFont(font: NodeFont): NodeFont {
	return { ...font, px: font.px * MARKER_SCALE, weight: MARKER_WEIGHT };
}

/**
 * Offsets of the markers from the start of their run, and the run's width
 * including the gap before the text (none when `alone`). `measure` measures
 * at the markers' font.
 */
export function markerRun(markers: readonly string[], font: NodeFont, measure: (s: string) => number, alone = false): { xs: number[]; width: number } {
	const xs: number[] = [];
	let x = 0;
	markers.forEach((m, i) => {
		if (i > 0) x += MARKER_GAP_EM * font.px;
		xs.push(x);
		x += measure(m);
	});
	if (markers.length > 0 && !alone) x += MARKER_AFTER_EM * font.px;
	return { xs, width: x };
}

/**
 * Widths taken in front of (`lead`) and after (`tail`) the text; `measureLabel` measures at the label's
 * font, `measureMarker` at the markers' (`markerFont`; without it an emoji is taken as 1em of that font).
 */
export function decorWidths(
	decor: NodeDecor | null,
	font: NodeFont,
	measureLabel: (s: string) => number,
	measureMarker: (s: string) => number = () => font.px * MARKER_SCALE,
): { lead: number; tail: number } {
	if (!decor) return { lead: 0, tail: 0 };
	const markers = decor.markers && decor.markers.length > 0 ? markerRun(decor.markers, font, measureMarker, decor.markersOnly).width : 0;
	return {
		lead: (decor.task ? (TASK_BOX_EM + TASK_GAP_EM) * font.px : 0) + markers,
		tail: decor.progress !== null ? PROGRESS_GAP_EM * PROGRESS_SCALE * font.px + measureLabel(decor.progress) : 0,
	};
}

/** The decor's part of a size key: done or open draws the same width, so it is left out. */
export function decorKey(decor: NodeDecor | null): string {
	if (!decor) return "";
	const markers = decor.markers && decor.markers.length > 0 ? `${decor.markers.join(" ")}${decor.markersOnly ? "!" : ""}` : "";
	return `${decor.task ? "t" : "-"}${decor.progress ?? ""}|${markers ? `${markers}|` : ""}`;
}

/**
 * A frame's label pill (spec 5.15): 0.8 times the framed node's font, padding
 * 4 px by 8 px, line height 1. Keep in sync with `.mapdown-frame-label` in styles.css.
 */
export const LABEL_SCALE = 0.8;
export const LABEL_WEIGHT = 500;
export const LABEL_PAD_X = 8;
export const LABEL_PAD_Y = 4;

/** Font of the frame label of a node with `font`. */
export function labelFont(font: NodeFont): NodeFont {
	return { ...font, px: Math.round(font.px * LABEL_SCALE), weight: LABEL_WEIGHT };
}

/** Size of a frame's label pill; `measure` measures at `labelFont(font)`. */
export function labelSize(label: string, font: NodeFont, measure: (s: string) => number): Size {
	const px = labelFont(font).px;
	return { width: Math.ceil(measure(label)) + 2 * LABEL_PAD_X, height: px + 2 * LABEL_PAD_Y };
}

/** Font of the progress label of a node with `font` (for measuring it). */
export function progressFont(font: NodeFont): NodeFont {
	return { ...font, px: font.px * PROGRESS_SCALE, weight: PROGRESS_WEIGHT };
}

/**
 * A map card inside a node's text (spec 5.10): [icon][gap][label][gap][arrow]
 * with padding on both sides, in em of the node's font. Keep in sync with
 * `.mapdown-map-card` in styles.css. The export draws icon and label only.
 */
export const CARD_PAD_EM = 0.3;
export const CARD_ICON_EM = 1;
export const CARD_GAP_EM = 0.25;
export const CARD_ARROW_EM = 0.8;

/** Width of a card whose label measures `labelWidth`, at font size `px`. */
export function cardWidth(labelWidth: number, px: number): number {
	return (2 * CARD_PAD_EM + CARD_ICON_EM + 2 * CARD_GAP_EM + CARD_ARROW_EM) * px + labelWidth;
}

/**
 * A text measurer for text in which card marks (`mark + n`, core/mapCard.ts)
 * stand for the cards labelled `labels[n]`: each mark measures as its whole card.
 */
export function withCardMarks(measure: (s: string) => number, labels: readonly string[], px: number, mark: number): (s: string) => number {
	if (labels.length === 0) return measure;
	const widths = new Map<string, number>();
	const re = new RegExp(`[${String.fromCharCode(mark)}-${String.fromCharCode(mark + labels.length - 1)}]`, "g");
	return (s) => {
		re.lastIndex = 0;
		if (!re.test(s)) return measure(s);
		re.lastIndex = 0;
		let w = 0;
		let last = 0;
		for (let m = re.exec(s); m; m = re.exec(s)) {
			if (m.index > last) w += measure(s.slice(last, m.index));
			const c = m[0];
			let cw = widths.get(c);
			if (cw === undefined) widths.set(c, (cw = cardWidth(measure(labels[c.charCodeAt(0) - mark] ?? ""), px)));
			w += cw;
			last = m.index + 1;
		}
		if (last < s.length) w += measure(s.slice(last));
		return w;
	};
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

/**
 * Width at which a node's text wraps: the content box's CSS max width
 * (`.mapdown-node-content` in styles.css) less the checkbox and progress label.
 * The node's laid-out width is no substitute: it comes from offsetWidth, rounded
 * to whole pixels, so text measuring 210.36 sits in a 210 px box on one line.
 */
export function textWrapWidth(maxWidth: number, font: NodeFont, decor: { lead: number; tail: number } = { lead: 0, tail: 0 }): number {
	return maxWidth - extraW(font) - decor.lead - decor.tail;
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

/**
 * Estimated border-box size of a node; integers, like offsetWidth. `decor`
 * (checkbox in front, progress after, see `decorWidths`) sits beside the text
 * in a row, so the text wraps in what is left of the width.
 */
export function estimateSize(
	text: string,
	font: NodeFont,
	maxWidth: number,
	measure: (s: string) => number,
	decor: { lead: number; tail: number } = { lead: 0, tail: 0 },
): Size {
	// a quote's bars and gaps sit left of the text like a checkbox does
	const lead = decor.lead + quoteInset(quoteBarLevels(text), font.px);
	const side = lead + decor.tail;
	const shown = isQuoteText(text) ? quoteShown(text) : text;
	const r = wrapText(shown, textWrapWidth(maxWidth, font, { lead, tail: decor.tail }), measure);
	return boxSize(r.width + side, r.lines * font.px * LINE_HEIGHT, font, maxWidth);
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
