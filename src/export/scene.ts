// Pure part of the image and HTML export (development plan 3.6, behaviour
// spec 2.3): node text to styled runs and blocks, wrapping, the export box and
// scale, and the SVG string drawn straight from a layout result. No DOM and no
// Obsidian here; the exporter (exporter.ts) supplies measuring, images and theme.

import type { LayoutEdge, NodePlacement } from "../core/layout.ts";
import type { NodeKind } from "../core/types.ts";

// ---------------------------------------------------------------- text model

export interface RunStyle {
	bold?: boolean;
	italic?: boolean;
	code?: boolean;
	strike?: boolean;
	highlight?: boolean;
	link?: boolean;
	/** Formula drawn as its source (the fallback of plan 3.6). */
	math?: boolean;
	/** Secondary text: an image that could not be loaded, or a non-image embed. */
	faint?: boolean;
}

export interface Run {
	text: string;
	style: RunStyle;
}

export type Block =
	| { type: "text"; runs: Run[] }
	/** `src` is the link target as written; width/height from `|300` or `|300x200`. */
	| { type: "image"; src: string; alt: string; wiki: boolean; width: number | null; height: number | null }
	| { type: "code"; lines: string[] }
	| { type: "table"; rows: string[][] };

function sameStyle(a: RunStyle, b: RunStyle): boolean {
	const keys: (keyof RunStyle)[] = ["bold", "italic", "code", "strike", "highlight", "link", "math", "faint"];
	return keys.every((k) => Boolean(a[k]) === Boolean(b[k]));
}

function pushRun(out: Run[], text: string, style: RunStyle): void {
	if (text === "") return;
	const last = out[out.length - 1];
	if (last && sameStyle(last.style, style)) last.text += text;
	else out.push({ text, style: { ...style } });
}

const EMPHASIS: { mark: string; key: keyof RunStyle }[] = [
	{ mark: "**", key: "bold" },
	{ mark: "__", key: "bold" },
	{ mark: "~~", key: "strike" },
	{ mark: "==", key: "highlight" },
	{ mark: "*", key: "italic" },
	{ mark: "_", key: "italic" },
];

/** Simple inline HTML that only styles; the tags are dropped. */
const INLINE_TAG = /^<\/?(?:u|mark|span|b|i|em|strong|sup|sub|font|small|big|s|del|ins|kbd)\b[^>]*>/i;

/** Closing `mark` at or after `from` that ends a non-empty span; -1 if none. */
function findClose(text: string, mark: string, from: number): number {
	let i = from;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "\\") {
			i += 2;
			continue;
		}
		if (ch === "`") {
			const end = codeEnd(text, i);
			if (end > 0) {
				i = end;
				continue;
			}
		}
		if (text.startsWith(mark, i) && i > from && !/\s/.test(text[i - 1])) {
			// `**` must not be read as the close of a single `*`
			if (mark.length === 1 && text[i + 1] === mark) {
				i += 2;
				continue;
			}
			return i;
		}
		i++;
	}
	return -1;
}

/** End (exclusive) of an inline code span starting at `at`, or -1. */
function codeEnd(text: string, at: number): number {
	let n = 0;
	while (text[at + n] === "`") n++;
	const fence = "`".repeat(n);
	let i = text.indexOf(fence, at + n);
	while (i >= 0) {
		if (text[i + n] !== "`") return i + n;
		while (text[i] === "`") i++;
		i = text.indexOf(fence, i);
	}
	return -1;
}

/** Inline Markdown of one node to styled runs. Unknown syntax stays as text. */
export function parseInline(text: string, base: RunStyle = {}): Run[] {
	const out: Run[] = [];
	let plain = "";
	const flush = (): void => {
		pushRun(out, plain, base);
		plain = "";
	};
	const add = (runs: Run[]): void => {
		flush();
		for (const r of runs) pushRun(out, r.text, r.style);
	};
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		const rest = text.slice(i);
		if (ch === "\\" && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1])) {
			plain += text[i + 1];
			i += 2;
			continue;
		}
		if (ch === "`") {
			const end = codeEnd(text, i);
			if (end > 0) {
				let n = 0;
				while (text[i + n] === "`") n++;
				let inner = text.slice(i + n, end - n);
				if (inner.startsWith(" ") && inner.endsWith(" ") && inner.trim() !== "") inner = inner.slice(1, -1);
				add([{ text: inner, style: { ...base, code: true } }]);
				i = end;
				continue;
			}
		}
		if (ch === "$") {
			const m = /^\$\$([\s\S]+?)\$\$/.exec(rest) ?? /^\$(?=\S)([^$\n]*?\S)\$(?!\d)/.exec(rest);
			if (m) {
				add([{ text: m[0], style: { ...base, math: true } }]);
				i += m[0].length;
				continue;
			}
		}
		if (ch === "!" && text.startsWith("[[", i + 1) && text.indexOf("]]", i + 3) > 0) {
			i++;
			continue;
		}
		if (ch === "[" && text[i + 1] === "[") {
			const end = text.indexOf("]]", i + 2);
			if (end > 0) {
				const inner = text.slice(i + 2, end);
				const bar = inner.indexOf("|");
				const shown = bar >= 0 ? inner.slice(bar + 1) : inner.replace(/#\^?/, " > ");
				add([{ text: shown, style: { ...base, link: true } }]);
				i = end + 2;
				continue;
			}
		}
		if (ch === "[") {
			const m = /^\[((?:\\.|[^\]\\])*)\]\((<[^>]*>|[^)\s]*)(?:\s+"[^"]*")?\)/.exec(rest);
			if (m) {
				add(parseInline(m[1], { ...base, link: true }));
				i += m[0].length;
				continue;
			}
		}
		if (ch === "<") {
			const auto = /^<(https?:\/\/[^>\s]+)>/.exec(rest);
			if (auto) {
				add([{ text: auto[1], style: { ...base, link: true } }]);
				i += auto[0].length;
				continue;
			}
			const tag = INLINE_TAG.exec(rest);
			if (tag) {
				i += tag[0].length;
				continue;
			}
		}
		const em = EMPHASIS.find((e) => rest.startsWith(e.mark));
		if (em && !base[em.key] && text[i + em.mark.length] !== undefined && !/\s/.test(text[i + em.mark.length])) {
			// `_` inside a word is not emphasis
			const intraword = em.mark[0] === "_" && i > 0 && /\w/.test(text[i - 1]);
			let close = intraword ? -1 : findClose(text, em.mark, i + em.mark.length);
			// `***` closing `**…*…***`: the inner mark closes first
			while (close > 0 && text[close + em.mark.length] === em.mark[0]) close++;
			if (close > 0) {
				add(parseInline(text.slice(i + em.mark.length, close), { ...base, [em.key]: true }));
				i = close + em.mark.length;
				continue;
			}
		}
		plain += ch;
		i++;
	}
	flush();
	return out;
}

/** Plain text of inline Markdown (table cells). */
export function plainInline(text: string): string {
	return parseInline(text).map((r) => r.text).join("");
}

const IMAGE = /!\[\[([^\]]+)\]\]|!\[([^\]]*)\]\((<[^>]*>|[^)\s]*)(?:\s+"[^"]*")?\)/g;

/** `300` or `300x200` after a `|`. */
function sizeSpec(s: string): { width: number | null; height: number | null } | null {
	const m = /^\s*(\d+)(?:x(\d+))?\s*$/.exec(s);
	return m ? { width: Number(m[1]), height: m[2] ? Number(m[2]) : null } : null;
}

function imageBlock(match: RegExpExecArray): Block {
	if (match[1] !== undefined) {
		const parts = match[1].split("|");
		const spec = parts.length > 1 ? sizeSpec(parts[parts.length - 1]) : null;
		const src = parts[0].trim();
		const alt = parts.length > 1 && !spec ? parts.slice(1).join("|") : src;
		return { type: "image", src, alt, wiki: true, width: spec?.width ?? null, height: spec?.height ?? null };
	}
	const altRaw = match[2] ?? "";
	const bar = altRaw.lastIndexOf("|");
	const spec = bar >= 0 ? sizeSpec(altRaw.slice(bar + 1)) : null;
	const alt = spec ? altRaw.slice(0, bar) : altRaw;
	let src = match[3] ?? "";
	if (src.startsWith("<") && src.endsWith(">")) src = src.slice(1, -1);
	return { type: "image", src, alt, wiki: false, width: spec?.width ?? null, height: spec?.height ?? null };
}

/** Node text to blocks: text with embedded images split out; code and tables by kind. */
export function parseBlocks(text: string, kind: NodeKind): Block[] {
	if (kind === "code") {
		const lines = text.split(/\r?\n/);
		if (/^\s*(```|~~~)/.test(lines[0] ?? "")) lines.shift();
		if (lines.length > 0 && /^\s*(```|~~~)\s*$/.test(lines[lines.length - 1])) lines.pop();
		return [{ type: "code", lines }];
	}
	if (kind === "table") {
		const rows = text
			.split(/\r?\n/)
			.filter((l) => l.trim() !== "" && !/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l))
			.map((l) => splitRow(l).map(plainInline));
		return [{ type: "table", rows }];
	}
	// a quoted paragraph shows its text without the markers
	const body = text.split("\n").map((l) => l.replace(/^\s{0,3}(?:>\s?)+/, "")).join("\n");
	const blocks: Block[] = [];
	let last = 0;
	IMAGE.lastIndex = 0;
	for (let m = IMAGE.exec(body); m; m = IMAGE.exec(body)) {
		const block = imageBlock(m);
		// an embedded note or other file is shown as its link, like an inline link
		if (block.type === "image" && block.wiki && !isImagePath(block.src)) continue;
		pushText(blocks, body.slice(last, m.index));
		blocks.push(block);
		last = m.index + m[0].length;
	}
	pushText(blocks, body.slice(last));
	if (blocks.length === 0) blocks.push({ type: "text", runs: [] });
	return blocks;
}

function pushText(blocks: Block[], text: string): void {
	const trimmed = text.replace(/^[ \t]*\n|\n[ \t]*$/g, "");
	if (trimmed.trim() === "") return;
	blocks.push({ type: "text", runs: parseInline(trimmed) });
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

/** True when a link target names an image file (`#…` and `|…` already removed). */
export function isImagePath(src: string): boolean {
	return IMAGE_EXT.test(src.split("#")[0].split("?")[0].trim());
}

/** MIME type of an image path; null when it is not an image. */
export function imageMime(src: string): string | null {
	const m = IMAGE_EXT.exec(src.split("#")[0].split("?")[0].trim());
	if (!m) return null;
	const ext = m[1].toLowerCase();
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "svg") return "image/svg+xml";
	if (ext === "ico") return "image/x-icon";
	return `image/${ext}`;
}

function splitRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		if (s[i] === "\\" && s[i + 1] === "|") {
			cur += "|";
			i++;
		} else if (s[i] === "|") {
			cells.push(cur.trim());
			cur = "";
		} else {
			cur += s[i];
		}
	}
	cells.push(cur.trim());
	return cells;
}

// ---------------------------------------------------------------- wrapping

export interface Segment {
	text: string;
	style: RunStyle;
	x: number;
	width: number;
}

export interface Line {
	segments: Segment[];
	width: number;
}

export type Measure = (text: string, style: RunStyle) => number;

const CJK = "⺀-鿿　-〿가-힯豈-﫿＀-￯";
const TOKEN = new RegExp(`\\n|[^\\S\\n]+|[${CJK}]|[^\\s${CJK}]+`, "g");

/**
 * Greedy wrap of styled runs, like the node's `pre-wrap; overflow-wrap: anywhere`
 * (same rules as wrapText in measure.ts). Spaces at a soft break are dropped.
 */
export function wrapRuns(runs: readonly Run[], maxWidth: number, measure: Measure): Line[] {
	const max = Math.max(1, maxWidth);
	const lines: Line[] = [];
	let line: Line = { segments: [], width: 0 };
	// whitespace waiting for the next word; dropped at a soft break
	const space = { text: "", style: {} as RunStyle, width: 0 };
	const append = (text: string, style: RunStyle, w: number): void => {
		const tail = line.segments[line.segments.length - 1];
		if (tail && sameStyle(tail.style, style)) {
			tail.text += text;
			tail.width += w;
		} else {
			line.segments.push({ text, style: { ...style }, x: line.width, width: w });
		}
		line.width += w;
	};
	const newLine = (): void => {
		lines.push(line);
		line = { segments: [], width: 0 };
		space.text = "";
		space.width = 0;
	};
	const place = (text: string, style: RunStyle, w: number): void => {
		if (space.text !== "") {
			append(space.text, space.style, space.width);
			space.text = "";
			space.width = 0;
		}
		append(text, style, w);
	};
	for (const run of runs) {
		// a formula shown as source never breaks inside unless it cannot fit
		const tokens = run.style.math ? run.text.split(/(\n)/).filter((x) => x !== "") : run.text.match(TOKEN) ?? [];
		for (const tok of tokens) {
			if (tok === "\n") {
				newLine();
				continue;
			}
			const w = measure(tok, run.style);
			if (/^\s+$/.test(tok)) {
				if (space.text === "") space.style = run.style;
				space.text += tok;
				space.width += w;
				continue;
			}
			if (line.width + space.width + w <= max) {
				place(tok, run.style, w);
			} else if (w <= max) {
				newLine();
				place(tok, run.style, w);
			} else {
				// too long for any line: break between characters
				for (const ch of tok) {
					const cw = measure(ch, run.style);
					if (line.width + space.width + cw > max && line.segments.length > 0) newLine();
					place(ch, run.style, cw);
				}
			}
		}
	}
	lines.push(line);
	return lines;
}

// ---------------------------------------------------------------- export box and scale

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Margin around the nodes' bounding box, in map pixels. */
export const EXPORT_MARGIN = 40;

/** The exported area: the layout's bounding box plus the margin. */
export function exportBox(bounds: Box, margin = EXPORT_MARGIN): Box {
	return {
		x: Math.floor(bounds.x - margin),
		y: Math.floor(bounds.y - margin),
		width: Math.ceil(bounds.width + 2 * margin),
		height: Math.ceil(bounds.height + 2 * margin),
	};
}

/** Pixel size of the image: (bounding box + margin) × scale (spec 2.3). */
export function imageSize(box: Box, scale: number): { width: number; height: number } {
	return { width: Math.max(1, Math.round(box.width * scale)), height: Math.max(1, Math.round(box.height * scale)) };
}

/**
 * The largest scale up to `scale` whose canvas fits the platform's limits
 * (pixel count and side length). Equals `scale` when it fits.
 */
export function fitScale(box: Box, scale: number, maxPixels: number, maxSide: number): number {
	const { width, height } = imageSize(box, scale);
	if (width * height <= maxPixels && width <= maxSide && height <= maxSide) return scale;
	const byArea = Math.sqrt(maxPixels / (box.width * box.height));
	const bySide = maxSide / Math.max(box.width, box.height);
	// floor to 1/100 so rounding cannot push the size back over the limit
	return Math.max(0.01, Math.floor(Math.min(scale, byArea, bySide) * 100) / 100);
}

/** `<folder>/<base>.<ext>`, adding ` 1`, ` 2`… while the path is taken (like the XMind export). */
export function exportPath(folder: string, base: string, ext: string, taken: (path: string) => boolean): string {
	const make = (n: number): string => `${folder ? folder + "/" : ""}${base}${n === 0 ? "" : " " + String(n)}.${ext}`;
	for (let n = 0; n < 1000; n++) {
		const p = make(n);
		if (!taken(p)) return p;
	}
	return make(Date.now());
}

// ---------------------------------------------------------------- scene

/** Colours and fonts, read from the theme by the exporter. Any CSS colour string. */
export interface ExportTheme {
	background: string;
	nodeFill: string;
	rootFill: string;
	border: string;
	accent: string;
	text: string;
	faint: string;
	link: string;
	codeFill: string;
	codeText: string;
	highlight: string;
	badgeText: string;
	fontFamily: string;
	monoFamily: string;
	radius: number;
	rootRadius: number;
}

/** Something drawn inside a node, relative to the node's content box. */
export type ContentItem =
	| { type: "line"; y: number; height: number; segments: Segment[] }
	| { type: "image"; x: number; y: number; width: number; height: number; href: string }
	| { type: "rect"; x: number; y: number; width: number; height: number; fill: string; stroke?: string }
	| { type: "mono"; x: number; y: number; height: number; text: string };

export interface SceneNode {
	placement: NodePlacement;
	root: boolean;
	fontPx: number;
	weight: number;
	/** Branch colour (the edge colour into this node); "" for the root. */
	color: string;
	/** Number of hidden children; 0 when expanded. */
	collapsedCount: number;
	content: ContentItem[];
	/** Per-level box (measure.ts `fontFor`); missing values fall back to the metrics and theme. */
	level?: number;
	padX?: number;
	padY?: number;
	radius?: number;
}

export interface Scene {
	box: Box;
	nodes: SceneNode[];
	edges: LayoutEdge[];
	rootId: string;
	theme: ExportTheme;
}

/** Fallback padding and the border; per-node padding on SceneNode wins (measure.ts NODE_LEVELS). */
export interface ContentMetrics {
	padX: number;
	padY: number;
	border: number;
}

function r2(n: number): string {
	return String(Math.round(n * 100) / 100);
}

export function escapeXml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] as string);
}

/** Characters XML 1.0 does not allow; a node may contain them, the SVG must not. */
function xmlText(s: string): string {
	// eslint-disable-next-line no-control-regex -- these are exactly the characters to remove
	return escapeXml(s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, ""));
}

function segmentSvg(seg: Segment, baseX: number, node: SceneNode, theme: ExportTheme): string {
	const s = seg.style;
	const attrs: string[] = [`x="${r2(baseX + seg.x)}"`];
	if (s.bold && node.weight < 700) attrs.push('font-weight="700"');
	if (s.italic) attrs.push('font-style="italic"');
	if (s.code) attrs.push(`font-family="${escapeXml(theme.monoFamily)}"`, `fill="${escapeXml(theme.codeText)}"`);
	else if (s.link) attrs.push(`fill="${escapeXml(theme.link)}"`);
	else if (s.faint || s.math) attrs.push(`fill="${escapeXml(theme.faint)}"`);
	const deco = [s.link ? "underline" : "", s.strike ? "line-through" : ""].filter(Boolean).join(" ");
	if (deco) attrs.push(`text-decoration="${deco}"`);
	return `<tspan ${attrs.join(" ")}>${xmlText(seg.text)}</tspan>`;
}

function contentSvg(item: ContentItem, ox: number, oy: number, node: SceneNode, theme: ExportTheme): string {
	switch (item.type) {
		case "rect":
			return `<rect x="${r2(ox + item.x)}" y="${r2(oy + item.y)}" width="${r2(item.width)}" height="${r2(item.height)}" rx="2" fill="${escapeXml(item.fill)}"${item.stroke ? ` stroke="${escapeXml(item.stroke)}"` : ""}/>`;
		case "image":
			return `<image x="${r2(ox + item.x)}" y="${r2(oy + item.y)}" width="${r2(item.width)}" height="${r2(item.height)}" href="${escapeXml(item.href)}" preserveAspectRatio="none"/>`;
		case "mono": {
			const cy = oy + item.y + item.height / 2;
			return `<text x="${r2(ox + item.x)}" y="${r2(cy)}" dominant-baseline="central" font-family="${escapeXml(theme.monoFamily)}" font-weight="400" fill="${escapeXml(theme.codeText)}" xml:space="preserve">${xmlText(item.text)}</text>`;
		}
		case "line": {
			if (item.segments.length === 0) return "";
			const cy = oy + item.y + item.height / 2;
			const back: string[] = [];
			for (const seg of item.segments) {
				const fill = seg.style.code ? theme.codeFill : seg.style.highlight ? theme.highlight : null;
				if (!fill) continue;
				back.push(`<rect x="${r2(ox + seg.x - 1)}" y="${r2(oy + item.y + 1)}" width="${r2(seg.width + 2)}" height="${r2(item.height - 2)}" rx="2" fill="${escapeXml(fill)}"/>`);
			}
			const spans = item.segments.map((seg) => segmentSvg(seg, ox, node, theme)).join("");
			return `${back.join("")}<text y="${r2(cy)}" dominant-baseline="central" xml:space="preserve">${spans}</text>`;
		}
	}
}

function nodeSvg(node: SceneNode, scene: Scene, m: ContentMetrics, index: number): string {
	const t = scene.theme;
	const p = node.placement;
	const out: string[] = [];
	const radius = node.radius ?? (node.root ? t.rootRadius : t.radius);
	const fill = node.root ? t.rootFill : t.nodeFill;
	out.push(
		`<rect x="${r2(p.x + 0.5)}" y="${r2(p.y + 0.5)}" width="${r2(p.width - 1)}" height="${r2(p.height - 1)}" rx="${r2(radius)}" fill="${escapeXml(fill)}" stroke="${escapeXml(t.border)}" stroke-width="1"/>`,
	);
	if (!node.root && node.color && (node.level ?? 1) === 1) {
		// First level, like styles.css: the branch colour is deepest along the side facing the parent and
		// fades inwards; an ellipse centred 28 px in makes the front curve in towards that edge in the middle.
		const id = `mapdown-wash-${index}`;
		const left = p.side === "left";
		const band = Math.min(28, p.width);
		const edge = left ? p.x + p.width : p.x;
		const cx = left ? edge - band : edge + band;
		const cy = p.y + p.height / 2;
		const rx = 40;
		const ry = 1.4 * p.height;
		const color = escapeXml(node.color);
		const stop = (offset: number, opacity: number): string =>
			`<stop offset="${offset}" stop-color="${color}" stop-opacity="${opacity}"/>`;
		const fadeX2 = left ? edge - band : edge + band;
		out.push(
			"<defs>",
			`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${r2(cx)}" cy="${r2(cy)}" r="${rx}" gradientTransform="matrix(1 0 0 ${r2(ry / rx)} 0 ${r2(cy * (1 - ry / rx))})">`,
			`${stop(0.36, 0)}${stop(0.46, 0.08)}${stop(0.57, 0.24)}${stop(0.69, 0.45)}${stop(0.83, 0.64)}${stop(1, 0.76)}</radialGradient>`,
			`<linearGradient id="${id}-fade" gradientUnits="userSpaceOnUse" x1="${r2(edge)}" y1="0" x2="${r2(fadeX2)}" y2="0"><stop offset="0.3" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`,
			`<mask id="${id}-mask"><rect x="${r2(p.x)}" y="${r2(p.y)}" width="${r2(p.width)}" height="${r2(p.height)}" fill="url(#${id}-fade)"/></mask>`,
			"</defs>",
			`<rect x="${r2(p.x + 0.5)}" y="${r2(p.y + 0.5)}" width="${r2(p.width - 1)}" height="${r2(p.height - 1)}" rx="${r2(radius)}" fill="url(#${id})" mask="url(#${id}-mask)"/>`,
		);
	}
	const ox = p.x + m.border + (node.padX ?? m.padX);
	const oy = p.y + m.border + (node.padY ?? m.padY);
	const weight = node.weight;
	out.push(`<g font-size="${node.fontPx}" font-weight="${weight}" fill="${escapeXml(t.text)}">`);
	for (const item of node.content) out.push(contentSvg(item, ox, oy, node, t));
	out.push("</g>");
	if (node.collapsedCount > 0) {
		const label = String(node.collapsedCount);
		// outlined pill outside the node, like .mapdown-node-badge in styles.css
		const fs = 11;
		const h = 18;
		const w = Math.max(20, Math.round(label.length * fs * 0.62 + 10));
		const bx = p.side === "left" ? p.x - 6 - w : p.x + p.width + 6;
		const by = p.y + p.height / 2 - h / 2;
		const color = node.color || t.faint;
		out.push(
			`<rect x="${r2(bx + 0.75)}" y="${r2(by + 0.75)}" width="${w - 1.5}" height="${h - 1.5}" rx="${r2(h / 2)}" fill="${escapeXml(t.nodeFill)}" stroke="${escapeXml(color)}" stroke-width="1.5"/>`,
			`<text x="${r2(bx + w / 2)}" y="${r2(by + h / 2)}" text-anchor="middle" dominant-baseline="central" font-size="${fs}" font-weight="600" fill="${escapeXml(t.faint)}">${label}</text>`,
		);
	}
	return out.join("");
}

/**
 * The scene as a standalone SVG document. `pixelScale` sets the intrinsic
 * width and height (the canvas draws it at that size, so text stays sharp).
 */
export function buildSvg(scene: Scene, metrics: ContentMetrics, pixelScale = 1): string {
	const b = scene.box;
	const size = imageSize(b, pixelScale);
	const t = scene.theme;
	const out: string[] = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="${b.x} ${b.y} ${b.width} ${b.height}" font-family="${escapeXml(t.fontFamily)}">`,
		`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="${escapeXml(t.background)}"/>`,
		'<g fill="none" stroke-linecap="round">',
	];
	for (const e of scene.edges) {
		const d = `M ${r2(e.from.x)} ${r2(e.from.y)} C ${r2(e.c1.x)} ${r2(e.c1.y)}, ${r2(e.c2.x)} ${r2(e.c2.y)}, ${r2(e.to.x)} ${r2(e.to.y)}`;
		const width = e.parentId === scene.rootId ? 2.5 : 1.5;
		out.push(`<path d="${d}" stroke="${escapeXml(e.color)}" stroke-width="${width}"/>`);
	}
	out.push("</g>");
	scene.nodes.forEach((node, i) => out.push(nodeSvg(node, scene, metrics, i)));
	out.push("</svg>");
	return out.join("");
}

/** Self-contained HTML page holding the SVG inline (images are data URLs already). */
export function htmlDocument(svg: string, title: string, background: string, lang: string): string {
	return [
		"<!DOCTYPE html>",
		`<html lang="${escapeXml(lang)}">`,
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${xmlText(title)}</title>`,
		"</head>",
		`<body style="margin:0;background:${escapeXml(background)}">`,
		svg,
		"</body>",
		"</html>",
		"",
	].join("\n");
}

// ---------------------------------------------------------------- node content layout

export interface ResolvedImage {
	href: string;
	width: number;
	height: number;
}

export interface ContentInput {
	blocks: Block[];
	/** Content box width (node width minus padding and border). */
	innerWidth: number;
	fontPx: number;
	lineHeight: number;
	measure: Measure;
	/** Monospace width of a string (code blocks, tables). */
	measureMono: (text: string) => number;
	/** Image by block `src`; null when it could not be loaded. */
	image: (block: Extract<Block, { type: "image" }>) => ResolvedImage | null;
	theme: ExportTheme;
}

export interface ContentResult {
	items: ContentItem[];
	height: number;
	/** Images that were missing and drawn as their link text. */
	missingImages: number;
	/** Formulas drawn as source. */
	formulas: number;
}

/** Lays out one node's blocks top to bottom inside its content box. */
export function layoutContent(input: ContentInput): ContentResult {
	const items: ContentItem[] = [];
	const lh = input.lineHeight;
	let y = 0;
	let missing = 0;
	let formulas = 0;
	const pushLines = (runs: Run[]): void => {
		formulas += runs.filter((r) => r.style.math).length;
		for (const line of wrapRuns(runs, input.innerWidth, input.measure)) {
			items.push({ type: "line", y, height: lh, segments: line.segments });
			y += lh;
		}
	};
	for (const block of input.blocks) {
		if (block.type === "text") {
			pushLines(block.runs);
		} else if (block.type === "image") {
			const img = input.image(block);
			if (!img) {
				missing++;
				pushLines([{ text: block.alt || block.src, style: { faint: true } }]);
				continue;
			}
			let w = block.width ?? img.width;
			let h = block.height ?? (block.width ? (img.height * block.width) / Math.max(1, img.width) : img.height);
			const cap = Math.min(input.innerWidth, block.width ?? 300);
			if (w > cap) {
				h = (h * cap) / w;
				w = cap;
			}
			items.push({ type: "image", x: 0, y, width: w, height: h, href: img.href });
			y += h;
		} else if (block.type === "code") {
			const start = y;
			const rows: { text: string; y: number }[] = [];
			for (const raw of block.lines) {
				for (const part of breakChars(raw.replace(/\t/g, "    "), input.innerWidth - 8, input.measureMono)) {
					rows.push({ text: part, y });
					y += lh;
				}
			}
			items.push({ type: "rect", x: 0, y: start, width: input.innerWidth, height: y - start, fill: input.theme.codeFill });
			for (const r of rows) items.push({ type: "mono", x: 4, y: r.y, height: lh, text: r.text });
		} else {
			const cols = Math.max(0, ...block.rows.map((r) => r.length));
			const widths: number[] = [];
			for (let c = 0; c < cols; c++) widths.push(Math.max(0, ...block.rows.map((r) => input.measure(r[c] ?? "", {}))) + 12);
			const start = y;
			const total = widths.reduce((a, b) => a + b, 0);
			block.rows.forEach((row, ri) => {
				let x = 0;
				const segs: Segment[] = [];
				for (let c = 0; c < cols; c++) {
					const text = row[c] ?? "";
					segs.push({ text, style: ri === 0 ? { bold: true } : {}, x: x + 6, width: input.measure(text, {}) });
					x += widths[c];
				}
				items.push({ type: "line", y, height: lh, segments: segs });
				y += lh;
			});
			items.push({ type: "rect", x: 0, y: start, width: total, height: y - start, fill: "none", stroke: input.theme.border });
		}
	}
	return { items, height: y, missingImages: missing, formulas };
}

/** Splits `text` between characters so each part fits `max` (code lines). */
export function breakChars(text: string, max: number, measure: (s: string) => number): string[] {
	if (text === "" || measure(text) <= max) return [text];
	const parts: string[] = [];
	let cur = "";
	let w = 0;
	for (const ch of text) {
		const cw = measure(ch);
		if (w + cw > max && cur !== "") {
			parts.push(cur);
			cur = "";
			w = 0;
		}
		cur += ch;
		w += cw;
	}
	parts.push(cur);
	return parts;
}
