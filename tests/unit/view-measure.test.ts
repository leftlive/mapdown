import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	LINE_HEIGHT,
	MEASURE_SENTINEL,
	MeasureGate,
	NODE_BORDER,
	NODE_LEVELS,
	SizeCache,
	boxSize,
	domSize,
	estimateSize,
	extraH,
	extraW,
	fontFor,
	isPlainText,
	markdownSource,
	sizeKey,
	wrapText,
} from "../../src/view/measure.ts";

/** Every character is half the font size wide. */
const half = (px: number) => (s: string) => s.length * px * 0.5;

test("plain text detection", () => {
	assert.equal(isPlainText("Hello world", "list"), true);
	assert.equal(isPlainText("line one\nline two", "list"), true);
	assert.equal(isPlainText("中文节点，没有语法", "heading"), true);
	assert.equal(isPlainText("snake case 3.14 - done", "list"), true);
	for (const rich of ["**bold**", "*it*", "`code`", "[[Note]]", "![[img.png]]", "==hl==", "~~s~~", "$x$", "a <b>", "see https://x.y", "#tag", "a\\*b", "[x](y)"]) {
		assert.equal(isPlainText(rich, "list"), false, rich);
	}
	assert.equal(isPlainText("plain", "code"), false);
	assert.equal(isPlainText("plain", "table"), false);
});

test("markdown source keeps structure for tables and code, re-encodes line breaks elsewhere", () => {
	assert.equal(markdownSource("**a**\nb", "list"), "**a**<br>b");
	assert.equal(markdownSource("```js\nx\n```", "code"), "```js\nx\n```");
	assert.equal(markdownSource("|a|\n|-|", "table"), "|a|\n|-|");
});

test("levels: each step down is smaller, lighter and has less padding", () => {
	assert.deepEqual([0, 1, 2, 3, 7].map((d) => fontFor(d, 16).px), [23, 17, 15, 14, 14]);
	assert.deepEqual([0, 1, 2, 3].map((d) => fontFor(d, 16).weight), [700, 600, 400, 400]);
	assert.deepEqual([0, 1, 2, 3, 9].map((d) => fontFor(d, 16).level), [0, 1, 2, 3, 3]);
	assert.deepEqual([0, 1, 2, 3].map((d) => [fontFor(d, 16).padY, fontFor(d, 16).padX]), [[14, 28], [9, 18], [6, 14], [4, 11]]);
	assert.equal(fontFor(7, 10).px, 9);
	assert.equal(extraW(fontFor(0, 16)), 2 * (28 + NODE_BORDER));
	assert.equal(extraH(fontFor(3, 16)), 2 * (4 + NODE_BORDER));
});

test("styles.css matches the level metrics in measure.ts", () => {
	const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
	const block = (sel: string): string => {
		const i = css.indexOf(`${sel} {`);
		assert.ok(i >= 0, `missing rule ${sel}`);
		return css.slice(i, css.indexOf("}", i));
	};
	const sels = [".mapdown-node.is-root", ".mapdown-node.is-level-1", ".mapdown-node.is-level-2", ".mapdown-node.is-level-deep"];
	sels.forEach((sel, i) => {
		const b = block(sel);
		const l = NODE_LEVELS[i];
		assert.match(b, new RegExp(`--mapdown-pad-x: ${l.padX}px;`), sel);
		assert.match(b, new RegExp(`--mapdown-pad-y: ${l.padY}px;`), sel);
		assert.match(b, new RegExp(`border-radius: ${l.radius}px;`), sel);
	});
	const base = block(".mapdown-node");
	assert.match(base, /padding: var\(--mapdown-pad-y\) var\(--mapdown-pad-x\);/);
	assert.match(base, new RegExp(`border: ${NODE_BORDER}px solid`));
	assert.match(base, new RegExp(`line-height: ${LINE_HEIGHT};`));
});

test("wrapText: short text is one line", () => {
	const r = wrapText("abcd", 100, half(10));
	assert.deepEqual(r, { lines: 1, width: 20 });
});

test("wrapText: hard line breaks and the widest line", () => {
	const r = wrapText("ab\nabcdef\n", 100, half(10));
	assert.equal(r.lines, 3);
	assert.equal(r.width, 30);
});

test("wrapText: breaks at spaces when too wide", () => {
	// each word 5 chars = 25px, space 5px; max 60 fits "aaaaa bbbbb" (55)
	const r = wrapText("aaaaa bbbbb ccccc ddddd", 60, half(10));
	assert.equal(r.lines, 2);
	assert.ok(r.width <= 60);
});

test("wrapText: long words and CJK break anywhere", () => {
	const long = wrapText("x".repeat(50), 100, half(10)); // 250px
	assert.equal(long.lines, 3);
	assert.ok(long.width <= 100);
	const cjk = wrapText("中".repeat(30), 50, half(10)); // 10 per line
	assert.equal(cjk.lines, 3);
});

test("wrapText terminates on degenerate widths", () => {
	assert.ok(wrapText("abc def", 0, half(10)).lines >= 1);
	assert.ok(wrapText("abc", 5, () => 1000).lines >= 1);
	assert.deepEqual(wrapText("", 100, half(10)), { lines: 1, width: 0 });
});

test("estimateSize adds padding, rounds up, and respects max width", () => {
	const f = fontFor(2, 16); // 15px
	const s = estimateSize("abc", f, 400, half(15));
	assert.equal(s.width, Math.ceil(22.5) + extraW(f));
	assert.equal(s.height, Math.ceil(15 * LINE_HEIGHT) + extraH(f));
	const wide = estimateSize("word ".repeat(200), f, 300, half(15));
	assert.ok(wide.width <= 300, `width ${wide.width}`);
	assert.ok(wide.height > s.height);
	const empty = estimateSize("", f, 400, half(15));
	assert.equal(empty.width, 15 + extraW(f), "empty text keeps room for the caret");
	assert.ok(Number.isInteger(wide.width) && Number.isInteger(wide.height));
	// the root has more padding than a deep node with the same text
	const root = estimateSize("abc", fontFor(0, 16), 400, half(15));
	const deep = estimateSize("abc", fontFor(5, 16), 400, half(15));
	assert.equal(root.width - deep.width, extraW(fontFor(0, 16)) - extraW(fontFor(5, 16)));
});

test("boxSize: a measured content box gets the level's padding and border", () => {
	const f = fontFor(1, 16);
	assert.deepEqual(boxSize(100, 25, f, 800), { width: 100 + extraW(f), height: 25 + extraH(f) });
	assert.equal(boxSize(5000, 25, f, 800).width, 800, "clamped to the max width");
});

test("sizeKey distinguishes text, width and font", () => {
	const f = fontFor(2, 16);
	const a = sizeKey("x", f, 800);
	assert.notEqual(a, sizeKey("x", { ...f, px: 17 }, 800));
	assert.notEqual(a, sizeKey("x", f, 820));
	assert.notEqual(a, sizeKey("x", { ...f, weight: 600 }, 800));
	assert.notEqual(a, sizeKey("y", f, 800));
	assert.equal(a, sizeKey("x", f, 800));
	// base 9: second and deeper levels share 8px/400 but not their padding
	assert.equal(fontFor(2, 9).px, fontFor(3, 9).px);
	assert.notEqual(sizeKey("x", fontFor(2, 9), 800), sizeKey("x", fontFor(3, 9), 800));
});

test("SizeCache: real sizes win over estimates and pruning keeps used entries", () => {
	const c = new SizeCache();
	c.setEstimate("a", { width: 10, height: 10 });
	assert.deepEqual(c.get("a"), { width: 10, height: 10, real: false });
	c.setReal("a", { width: 12, height: 10 });
	c.setEstimate("a", { width: 99, height: 99 });
	assert.deepEqual(c.get("a"), { width: 12, height: 10, real: true });
	c.beginGeneration();
	for (let i = 0; i < 100; i++) c.setEstimate(`k${i}`, { width: i, height: 1 });
	c.beginGeneration();
	c.get("a");
	c.prune(10);
	assert.ok(c.get("a"));
	assert.equal(c.get("k5"), undefined);
});

test("SizeCache.dropEstimates keeps real sizes only", () => {
	const c = new SizeCache();
	c.setEstimate("e", { width: 10, height: 10 });
	c.setReal("r", { width: 20, height: 10 });
	c.dropEstimates();
	assert.equal(c.get("e"), undefined);
	assert.deepEqual(c.get("r"), { width: 20, height: 10, real: true });
});

test("domSize: a content box that is not laid out gives no size", () => {
	const f = fontFor(2, 16);
	assert.equal(domSize(0, 0, f, 340), null);
	assert.deepEqual(domSize(40, 20, f, 340), boxSize(40, 20, f, 340));
	// an empty line still has a height and is measured
	assert.deepEqual(domSize(0, 20, f, 340), boxSize(0, 20, f, 340));
});

test("styles.css sets the measurement sentinel on the map", () => {
	const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
	const i = css.indexOf(".mapdown-map {");
	assert.ok(i >= 0);
	assert.match(css.slice(i, css.indexOf("}", i)), new RegExp(`${MEASURE_SENTINEL}: 1;`));
});

function gate(css: boolean, laidOut: boolean) {
	const g = { css, laidOut, probes: 0 };
	const m = new MeasureGate(
		() => {
			g.probes++;
			return g.css;
		},
		() => g.laidOut,
	);
	return { g, m };
}

test("MeasureGate: measures when the CSS is applied and the map is laid out", () => {
	const { g, m } = gate(true, true);
	assert.equal(m.canMeasure(), true);
	assert.equal(m.canMeasure(), true);
	assert.equal(g.probes, 1, "the CSS is probed until it is found, then never again");
	assert.equal(m.waitingForCss, false);
	assert.equal(m.retry(), false, "nothing was skipped");
});

test("MeasureGate: without the CSS sizes are skipped until it arrives, then once re-measured", () => {
	const { g, m } = gate(false, true);
	assert.equal(m.canMeasure(), false);
	assert.equal(m.waitingForCss, true);
	assert.equal(m.retry(), false);
	assert.equal(m.waitingForCss, true);
	g.css = true;
	assert.equal(m.retry(), true, "the skipped measurement can be made now");
	assert.equal(m.waitingForCss, false);
	assert.equal(m.retry(), false, "only once");
	assert.equal(m.canMeasure(), true);
});

test("MeasureGate: a hidden map skips sizes and is re-measured when it is laid out", () => {
	const { g, m } = gate(true, false);
	assert.equal(m.canMeasure(), false);
	assert.equal(m.waitingForCss, false, "the CSS is there; a resize brings the map back");
	assert.equal(m.retry(), false);
	g.laidOut = true;
	assert.equal(m.retry(), true);
	assert.equal(m.retry(), false);
});

test("MeasureGate: CSS arriving while the map is hidden waits for the layout", () => {
	const { g, m } = gate(false, false);
	assert.equal(m.canMeasure(), false);
	g.css = true;
	assert.equal(m.retry(), false);
	assert.equal(m.waitingForCss, false, "no more CSS polling");
	g.laidOut = true;
	assert.equal(m.retry(), true);
});
