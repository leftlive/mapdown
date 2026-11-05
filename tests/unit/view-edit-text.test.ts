import { test } from "node:test";
import assert from "node:assert/strict";
import { insertAt, toggleWrap, type TextSel } from "../../src/view/editText.ts";

/** "a [b] c" notation: brackets mark the selection. */
function sel(marked: string): TextSel {
	const from = marked.indexOf("[");
	const to = marked.indexOf("]") - 1;
	return { text: marked.replace("[", "").replace("]", ""), from, to };
}

function show(s: TextSel): string {
	return s.text.slice(0, s.from) + "[" + s.text.slice(s.from, s.to) + "]" + s.text.slice(s.to);
}

test("wraps the selection and keeps it selected", () => {
	assert.equal(show(toggleWrap(sel("a [word] c"), "**")), "a **[word]** c");
	assert.equal(show(toggleWrap(sel("a [word] c"), "==")), "a ==[word]== c");
	assert.equal(show(toggleWrap(sel("a [word] c"), "~~")), "a ~~[word]~~ c");
});

test("unwraps markers just outside the selection", () => {
	assert.equal(show(toggleWrap(sel("a **[word]** c"), "**")), "a [word] c");
	assert.equal(show(toggleWrap(sel("a *[word]* c"), "*")), "a [word] c");
});

test("unwraps markers inside the selection", () => {
	assert.equal(show(toggleWrap(sel("a [**word**] c"), "**")), "a [word] c");
	assert.equal(show(toggleWrap(sel("a [==w==] c"), "==")), "a [w] c");
});

test("italic and bold do not unwrap each other", () => {
	assert.equal(show(toggleWrap(sel("a **[word]** c"), "*")), "a ***[word]*** c");
	assert.equal(show(toggleWrap(sel("a *[word]* c"), "**")), "a ***[word]*** c");
	assert.equal(show(toggleWrap(sel("a ***[word]*** c"), "*")), "a **[word]** c");
	assert.equal(show(toggleWrap(sel("a ***[word]*** c"), "**")), "a *[word]* c");
});

test("an empty selection inserts a pair with the caret inside", () => {
	assert.equal(show(toggleWrap(sel("ab[]"), "**")), "ab**[]**");
});

test("insertAt replaces the selection", () => {
	assert.equal(show(insertAt(sel("a [bc] d"), "XY")), "a XY[] d");
	assert.equal(show(insertAt(sel("[]"), "line\nnext")), "line\nnext[]");
});
