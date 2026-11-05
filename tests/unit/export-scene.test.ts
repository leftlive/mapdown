import { test } from "node:test";
import assert from "node:assert/strict";
import { createLayouter, DEFAULT_PALETTE, type LayoutInput } from "../../src/core/layout.ts";
import {
	breakChars,
	buildSvg,
	escapeXml,
	exportBox,
	exportPath,
	fitScale,
	htmlDocument,
	imageMime,
	imageSize,
	isImagePath,
	layoutContent,
	parseBlocks,
	parseInline,
	wrapRuns,
	type ExportTheme,
	type Scene,
	type SceneNode,
} from "../../src/export/scene.ts";

/** Every character is 10 px wide. */
const tenPx = (s: string) => [...s].length * 10;

const THEME: ExportTheme = {
	background: "#fff",
	nodeFill: "#fff",
	rootFill: "#eee",
	border: "#ccc",
	accent: "#70f",
	text: "#222",
	faint: "#999",
	link: "#00f",
	codeFill: "#f4f4f4",
	codeText: "#c00",
	highlight: "#ff0",
	badgeText: "#fff",
	fontFamily: '"Inter", sans-serif',
	monoFamily: "Menlo, monospace",
	radius: 4,
	rootRadius: 8,
};
const METRICS = { padX: 12, padY: 6, border: 1 };

test("inline runs: bold, italic, code, strike, highlight, links", () => {
	const runs = parseInline("a **b** *c* `d` ~~e~~ ==f== [g](http://x) [[h|H]] [[i#j]]");
	const by = (text: string) => runs.find((r) => r.text === text)?.style;
	assert.deepEqual(by("b"), { bold: true });
	assert.deepEqual(by("c"), { italic: true });
	assert.deepEqual(by("d"), { code: true });
	assert.deepEqual(by("e"), { strike: true });
	assert.deepEqual(by("f"), { highlight: true });
	assert.deepEqual(by("g"), { link: true });
	assert.deepEqual(by("H"), { link: true });
	assert.deepEqual(by("i > j"), { link: true });
	assert.equal(runs.map((r) => r.text).join(""), "a b c d e f g H i > j");
});

test("inline runs: nesting, escapes and things that are not markup", () => {
	assert.deepEqual(parseInline("**bold *both***"), [
		{ text: "bold ", style: { bold: true } },
		{ text: "both", style: { bold: true, italic: true } },
	]);
	assert.deepEqual(parseInline("\\*not\\*"), [{ text: "*not*", style: {} }]);
	assert.deepEqual(parseInline("snake_case_name"), [{ text: "snake_case_name", style: {} }]);
	assert.deepEqual(parseInline("2 * 3 * 4"), [{ text: "2 * 3 * 4", style: {} }]);
	assert.deepEqual(parseInline("`a ** b`"), [{ text: "a ** b", style: { code: true } }]);
	assert.deepEqual(parseInline("<u>under</u>"), [{ text: "under", style: {} }]);
	assert.deepEqual(parseInline("**unclosed"), [{ text: "**unclosed", style: {} }]);
});

test("formulas are kept as source runs; prices are not formulas", () => {
	assert.deepEqual(parseInline("x $a^2$ y"), [
		{ text: "x ", style: {} },
		{ text: "$a^2$", style: { math: true } },
		{ text: " y", style: {} },
	]);
	assert.deepEqual(parseInline("$$\\frac{1}{2}$$"), [{ text: "$$\\frac{1}{2}$$", style: { math: true } }]);
	assert.deepEqual(parseInline("costs $5 and $6"), [{ text: "costs $5 and $6", style: {} }]);
});

test("blocks: images split out with size, embeds of notes stay links", () => {
	const blocks = parseBlocks("child ![[pic.png|300]] after ![alt|20x10](a%20b.jpg) ![[Some note]]", "list");
	assert.deepEqual(blocks.map((b) => b.type), ["text", "image", "text", "image", "text"]);
	assert.deepEqual(blocks[1], { type: "image", src: "pic.png", alt: "pic.png", wiki: true, width: 300, height: null });
	assert.deepEqual(blocks[3], { type: "image", src: "a%20b.jpg", alt: "alt", wiki: false, width: 20, height: 10 });
	const last = blocks[4];
	assert.ok(last.type === "text" && last.runs.some((r) => r.text === "Some note" && r.style.link));
});

test("blocks: code fences, tables, quotes, empty text", () => {
	assert.deepEqual(parseBlocks("```js\nlet a;\n```", "code"), [{ type: "code", lines: ["let a;"] }]);
	assert.deepEqual(parseBlocks("| A | **B** |\n|---|:-:|\n| 1 | a\\|b |", "table"), [{ type: "table", rows: [["A", "B"], ["1", "a|b"]] }]);
	const q = parseBlocks("> quoted", "paragraph")[0];
	assert.ok(q.type === "text" && q.runs[0].text === "quoted");
	assert.deepEqual(parseBlocks("", "list"), [{ type: "text", runs: [] }]);
});

test("image paths and MIME types", () => {
	assert.equal(isImagePath("a/b.PNG"), true);
	assert.equal(isImagePath("note"), false);
	assert.equal(isImagePath("doc.pdf"), false);
	assert.equal(imageMime("x.jpg"), "image/jpeg");
	assert.equal(imageMime("x.svg#frag"), "image/svg+xml");
	assert.equal(imageMime("x.md"), null);
});

test("wrapping keeps styles, drops spaces at soft breaks, breaks CJK per character", () => {
	const lines = wrapRuns(parseInline("aa **bb** cc"), 50, tenPx);
	assert.deepEqual(
		lines.map((l) => l.segments.map((s) => [s.text, s.x, Boolean(s.style.bold)])),
		[[["aa ", 0, false], ["bb", 30, true]], [["cc", 0, false]]],
	);
	const cjk = wrapRuns(parseInline("中文换行测试"), 40, tenPx);
	assert.deepEqual(cjk.map((l) => l.segments.map((s) => s.text).join("")), ["中文换行", "测试"]);
	const hard = wrapRuns(parseInline("a\nb"), 100, tenPx);
	assert.equal(hard.length, 2);
	const long = wrapRuns(parseInline("abcdefgh"), 30, tenPx);
	assert.deepEqual(long.map((l) => l.segments[0].text), ["abc", "def", "gh"]);
	const math = wrapRuns(parseInline("$a b$"), 100, tenPx);
	assert.deepEqual(math[0].segments.map((s) => s.text), ["$a b$"]);
});

test("export box and image size: (bounds + margin) × scale", () => {
	const box = exportBox({ x: -100, y: -50, width: 200, height: 100 }, 40);
	assert.deepEqual(box, { x: -140, y: -90, width: 280, height: 180 });
	assert.deepEqual(imageSize(box, 1), { width: 280, height: 180 });
	assert.deepEqual(imageSize(box, 4), { width: 1120, height: 720 });
});

test("scale is lowered only when the canvas would exceed the limits", () => {
	const box = { x: 0, y: 0, width: 1000, height: 1000 };
	assert.equal(fitScale(box, 4, 16_777_216, 16_384), 4);
	const s = fitScale(box, 8, 16_777_216, 16_384);
	assert.ok(s < 8 && s > 4);
	const size = imageSize(box, s);
	assert.ok(size.width * size.height <= 16_777_216);
	assert.ok(fitScale({ x: 0, y: 0, width: 20000, height: 10 }, 2, 1e9, 16_384) <= 16_384 / 20000);
});

test("export file names: next to the note, numbered on a clash", () => {
	const taken = new Set(["f/n.png", "f/n 1.png"]);
	assert.equal(exportPath("f", "n", "png", (p) => taken.has(p)), "f/n 2.png");
	assert.equal(exportPath("", "n", "html", () => false), "n.html");
});

test("content layout: images fit the box, missing images and formulas are counted", () => {
	const blocks = parseBlocks("x ![[big.png]] ![[gone.png]] $y$", "list");
	const r = layoutContent({
		blocks,
		innerWidth: 100,
		fontPx: 10,
		lineHeight: 15,
		measure: tenPx,
		measureMono: tenPx,
		image: (b) => (b.src === "big.png" ? { href: "data:image/png;base64,AA==", width: 400, height: 200 } : null),
		theme: THEME,
	});
	const img = r.items.find((i) => i.type === "image");
	assert.ok(img && img.type === "image");
	assert.equal(img.width, 100);
	assert.equal(img.height, 50);
	assert.equal(r.missingImages, 1);
	assert.equal(r.formulas, 1);
	const faint = r.items.find((i) => i.type === "line" && i.segments.some((s) => s.style.faint));
	assert.ok(faint, "a missing image shows its link text");
	assert.equal(r.height, 15 + 50 + 15 + 15);
});

test("code lines break between characters", () => {
	assert.deepEqual(breakChars("abcdef", 30, tenPx), ["abc", "def"]);
	assert.deepEqual(breakChars("", 30, tenPx), [""]);
});

function sceneOf(texts: Record<string, string>, collapsed: Record<string, number> = {}): Scene {
	const input: LayoutInput = {
		id: "r",
		size: { width: 80, height: 40 },
		collapsed: false,
		children: [
			{ id: "a", size: { width: 60, height: 30 }, collapsed: false, children: [] },
			{ id: "b", size: { width: 60, height: 30 }, collapsed: false, children: [] },
		],
	};
	const lay = createLayouter().layout(input, "right", DEFAULT_PALETTE);
	const colors = new Map(lay.edges.map((e) => [e.childId, e.color]));
	const nodes: SceneNode[] = [...lay.nodes.values()].map((p) => ({
		placement: p,
		root: p.id === "r",
		fontPx: 16,
		weight: p.id === "r" ? 700 : 400,
		color: colors.get(p.id) ?? "",
		collapsedCount: collapsed[p.id] ?? 0,
		content: layoutContent({
			blocks: parseBlocks(texts[p.id] ?? "", "list"),
			innerWidth: p.width - 26,
			fontPx: 16,
			lineHeight: 24,
			measure: tenPx,
			measureMono: tenPx,
			image: () => null,
			theme: THEME,
		}).items,
	}));
	return { box: exportBox(lay.bounds), nodes, edges: lay.edges, rootId: "r", theme: THEME };
}

test("SVG: one path per edge, root edges thicker, a box per node, escaped text", () => {
	const scene = sceneOf({ r: "Root", a: "**A** <&>", b: "`b`" }, { b: 3 });
	const svg = buildSvg(scene, METRICS, 2);
	assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" /);
	assert.equal((svg.match(/<path /g) ?? []).length, 2);
	assert.equal((svg.match(/stroke-width="2.5"/g) ?? []).length, 2);
	const size = imageSize(scene.box, 2);
	assert.ok(svg.includes(`width="${size.width}" height="${size.height}"`));
	assert.ok(svg.includes(`viewBox="${scene.box.x} ${scene.box.y} ${scene.box.width} ${scene.box.height}"`));
	assert.ok(svg.includes("&lt;&amp;&gt;"));
	assert.ok(!svg.includes("<&>"));
	assert.ok(svg.includes('font-weight="700">A</tspan>'));
	assert.ok(svg.includes(`font-family="${escapeXml(THEME.monoFamily)}"`));
	assert.ok(svg.includes(">3</text>"), "collapsed badge shows the hidden child count");
	assert.ok(svg.includes('font-family="&quot;Inter&quot;, sans-serif"'));
	assert.ok(!/<foreignObject|<style|<script/.test(svg));
	assert.ok(!svg.includes("\u0001"));
});

test("SVG drops characters XML forbids", () => {
	const svg = buildSvg(sceneOf({ a: "x\u0001y" }), METRICS);
	assert.ok(svg.includes(">xy</tspan>"));
});

test("HTML export is a self-contained page around the SVG", () => {
	const svg = buildSvg(sceneOf({ r: "R" }), METRICS);
	const html = htmlDocument(svg, "My <map>", "#fff", "en");
	assert.ok(html.startsWith("<!DOCTYPE html>"));
	assert.ok(html.includes("<title>My &lt;map&gt;</title>"));
	assert.ok(html.includes(svg));
	assert.ok(!/<script|<link /.test(html));
});
