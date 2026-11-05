// Adversarial tests for parse.ts and state.ts, written against
// docs/Markdown格式契约.md (sections 2-4, 4.10, 8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument } from '../../src/core/parse.ts';
import { collapsedIdsForSave, createViewState, stateLineEdit } from '../../src/core/state.ts';
import type { MapNode, ParsedDoc, TextEdit } from '../../src/core/types.ts';

// ------------------------------------------------------------------ helpers

type Shape = [string, Shape[]];

function shape(n: MapNode): Shape {
	return [n.text, n.children.map(shape)];
}

function flat(n: MapNode): MapNode[] {
	return [n, ...n.children.flatMap(flat)];
}

function byText(doc: ParsedDoc, text: string): MapNode {
	const hit = flat(doc.root).find((n) => n.text === text);
	assert.ok(hit, `no node with text ${JSON.stringify(text)}`);
	return hit;
}

/** Top-level children of the root as [text, kind] pairs. */
function kids(doc: ParsedDoc): [string, string][] {
	return doc.root.children.map((c) => [c.text, c.kind]);
}

function apply(text: string, edits: TextEdit[]): string {
	let out = text;
	for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
	return out;
}

const P = parseDocument;

// --------------------------------------------------- offsets / unicode / eol

test('textRange slices are UTF-16 offsets over emoji and CJK', () => {
	const text = '# 根😀 ^r1\n- 𝒳 é中 ^k\n  - 👨‍👩‍👧 family\n';
	const doc = P(text);
	for (const n of flat(doc.root)) {
		const tr = n.source?.textRange;
		assert.ok(tr);
		assert.equal(text.slice(tr.from, tr.to), n.text);
	}
	assert.equal(byText(doc, '𝒳 é中').blockId, 'k');
});

test('CRLF everywhere: ranges exclude the \\r, texts contain no \\r', () => {
	const text = '# T\r\n- a\r\n  b\r\n- c ^x\r\n\r\n| h | i |\r\n| - | - |\r\n| 1 | 2 |\r\n```\r\ncode\r\n```\r\n';
	const doc = P(text);
	assert.equal(doc.lineEnding, '\r\n');
	for (const n of flat(doc.root)) {
		assert.ok(!n.text.includes('\r'), JSON.stringify(n.text));
		const s = n.source;
		assert.ok(s);
		assert.notEqual(text[s.range.to - 1], '\r');
		assert.ok(text[s.range.to] === '\r' || s.range.to === text.length);
	}
	assert.equal(byText(doc, 'a\nb').source?.textRange, null);
	assert.equal(doc.root.children[1]?.blockId, 'x');
});

test('line ending is the first line break; none means \\n (4.10)', () => {
	assert.equal(P('a\r\nb\nc').lineEnding, '\r\n');
	assert.equal(P('a\nb\r\nc').lineEnding, '\n');
	assert.equal(P('single line').lineEnding, '\n');
	assert.equal(P('\r\n# T').lineEnding, '\r\n');
	assert.equal(P('').lineEnding, '\n');
});

test('tab-indented list items nest and keep their indent string', () => {
	const doc = P('- a\n\t- b\n\t\t- c\n\t- d\n');
	assert.deepEqual(shape(doc.root), ['', [['a', [['b', [['c', []]]], ['d', []]]]]]);
	assert.equal(byText(doc, 'b').source?.list?.indent, '\t');
	assert.equal(byText(doc, 'c').source?.list?.indent, '\t\t');
});

test('mixed bullet markers keep per-item style and nest by indent', () => {
	const doc = P('* a\n  + b\n    - c\n* d\n');
	assert.deepEqual(shape(doc.root), ['', [['a', [['b', [['c', []]]]]], ['d', []]]]);
	assert.deepEqual(
		['a', 'b', 'c', 'd'].map((t) => byText(doc, t).source?.list?.marker),
		['*', '+', '-', '*'],
	);
});

test('ordered lists with ) and . : no number in text, style recorded', () => {
	const doc = P('1) one\n2) two\n   1. nested\n10) ten\n');
	assert.deepEqual(shape(doc.root), ['', [['one', []], ['two', [['nested', []]]], ['ten', []]]]);
	assert.deepEqual(byText(doc, 'two').source?.list, { indent: '', marker: '2)', ordered: true });
	assert.equal(byText(doc, 'nested').source?.list?.marker, '1.');
	assert.equal(byText(doc, 'one').source?.textRange?.from, 3);
});

test('non-markers: "1.5 x", "-x", "*em*", "+" inside words are paragraphs', () => {
	const doc = P('1.5 is a number\n\n-x\n\n*em* text\n');
	assert.deepEqual(kids(doc), [['1.5 is a number', 'paragraph'], ['-x', 'paragraph'], ['*em* text', 'paragraph']]);
});

test('12 levels of nesting with 2-space and 4-space indents', () => {
	for (const step of ['  ', '    ']) {
		const lines = Array.from({ length: 12 }, (_, i) => `${step.repeat(i)}- n${i}`);
		const doc = P(lines.join('\n'));
		let node: MapNode = doc.root;
		for (let i = 0; i < 12; i++) {
			assert.equal(node.children.length, 1);
			node = node.children[0];
			assert.equal(node.text, `n${i}`);
		}
		assert.equal(node.children.length, 0);
	}
});

test('irregular indent: dedent to a column between levels becomes a sibling of the deeper-than-it parent chain', () => {
	const doc = P('- a\n    - b\n  - c\n        - d\n- e\n');
	assert.deepEqual(shape(doc.root), ['', [['a', [['b', []], ['c', [['d', []]]]]], ['e', []]]]);
});

// ------------------------------------------------------------------ headings

test('heading level skips attach to the nearest shallower heading (4.2.2)', () => {
	const doc = P('# A\n### B\n## C\n#### D\n# E\n###### F\n');
	assert.equal(doc.virtualRoot, true); // two H1
	assert.deepEqual(shape(doc.root), [
		'',
		[
			['A', [['B', []], ['C', [['D', []]]]]],
			['E', [['F', []]]],
		],
	]);
});

test('single H1 is the root even when everything below skips levels', () => {
	const doc = P('# R\n#### deep\n- item\n');
	assert.equal(doc.virtualRoot, false);
	assert.deepEqual(shape(doc.root), ['R', [['deep', [['item', []]]]]]);
});

test('a heading after list items closes the list: later items belong to the heading', () => {
	const doc = P('# R\n- a\n  - a1\n## H\n- b\n');
	assert.deepEqual(shape(doc.root), ['R', [['a', [['a1', []]]], ['H', [['b', []]]]]]);
});

test('an indented (<=3) heading inside a list item interrupts it and is a heading', () => {
	const doc = P('# R\n- a\n  ## h\n');
	assert.deepEqual(shape(doc.root), ['R', [['a', []], ['h', []]]]);
	assert.equal(byText(doc, 'h').kind, 'heading');
});

test('a 4-space-indented "# x" under a list item is continuation text (4.10)', () => {
	const doc = P('- a\n    # x\n');
	assert.deepEqual(shape(doc.root), ['', [['a\n# x', []]]]);
});

test('#tag, ####### and "#" glued to text are not headings', () => {
	const doc = P('#tag\n\n####### seven\n\n#\u00a0nbsp\n');
	assert.ok(flat(doc.root).every((n) => n.kind !== 'heading'));
});

test('heading text: surrounding whitespace, tabs, <br> variants, block id', () => {
	const text = '#\t  Title<br>two<br/>x<BR>y  ^Ab-9  \n';
	const doc = P(text);
	const h = doc.root;
	assert.equal(h.text, 'Title\ntwo<br/>x<BR>y');
	assert.equal(h.blockId, 'Ab-9');
	const tr = h.source?.textRange;
	assert.ok(tr);
	assert.equal(text.slice(tr.from, tr.to), 'Title<br>two<br/>x<BR>y');
});

test('empty heading "#" is a node with empty text', () => {
	const doc = P('#\n- a\n');
	assert.equal(doc.virtualRoot, false);
	assert.equal(doc.root.text, '');
	assert.equal(doc.root.kind, 'heading');
});

test('setext: "Title\\n---" is a paragraph plus an ignored rule; "===" is plain text (4.10)', () => {
	assert.deepEqual(kids(P('Title\n---\n')), [['Title', 'paragraph']]);
	assert.deepEqual(kids(P('Title\n===\n')), [['Title\n===', 'paragraph']]);
});

test('rules before the only H1 do not make the root virtual (4.10)', () => {
	const doc = P('***\n\n___\n# T\n- a\n');
	assert.equal(doc.virtualRoot, false);
	assert.equal(doc.root.text, 'T');
	const doc2 = P('- - -\n# T\n---\n- a\n');
	assert.equal(doc2.virtualRoot, false);
	assert.deepEqual(shape(doc2.root), ['T', [['a', []]]]);
});

test('content before the single H1, or only an H2, makes a virtual root', () => {
	assert.equal(P('intro\n# T\n').virtualRoot, true);
	assert.equal(P('## only\n').virtualRoot, true);
	assert.equal(P('```\n# not a heading\n```\n# T\n').virtualRoot, true);
});

// ------------------------------------------------------------- code fences

test('fence content with #, -, --- and * is not parsed as structure', () => {
	const doc = P('# R\n- a\n```md\n# h\n- x\n---\n* y\n| a | b |\n| - | - |\n```\n- b\n');
	assert.deepEqual(
		flat(doc.root).map((n) => n.kind),
		['heading', 'list', 'code', 'list'],
	);
	assert.equal(byText(doc, '```md\n# h\n- x\n---\n* y\n| a | b |\n| - | - |\n```').kind, 'code');
});

test('tilde fence is not closed by backticks and the reverse', () => {
	const a = P('~~~\n```\nx\n```\n~~~\n# after\n');
	assert.equal(a.root.children.filter((c) => c.kind === 'code').length, 1);
	assert.equal(a.root.children[0]?.text, '~~~\n```\nx\n```\n~~~');
	const b = P('```\n~~~\nx\n~~~\n```\n');
	assert.deepEqual(kids(b), [['```\n~~~\nx\n~~~\n```', 'code']]);
});

test('a shorter closing fence does not close; a longer one does (CommonMark)', () => {
	const a = P('````\n```\nstill code\n````\n# H\n');
	assert.deepEqual(kids(a), [['````\n```\nstill code\n````', 'code'], ['H', 'heading']]);
	const b = P('```\ncode\n`````\n# H\n');
	assert.deepEqual(kids(b), [['```\ncode\n`````', 'code'], ['H', 'heading']]);
});

test('closing fence with trailing text does not close', () => {
	const doc = P('```\na\n``` not closing\nb\n```\n');
	assert.deepEqual(kids(doc), [['```\na\n``` not closing\nb\n```', 'code']]);
});

test('unclosed fence swallows the rest of the file as one code node', () => {
	const doc = P('# T\n```js\n# not heading\n- not item\n');
	assert.deepEqual(flat(doc.root).map((n) => n.kind), ['heading', 'code']);
	assert.equal(doc.root.children[0]?.text, '```js\n# not heading\n- not item');
});

test('indented fence: text drops the indent of the fence column only', () => {
	const doc = P('  ```\n  a\n    b\n  ```\n');
	assert.equal(doc.root.children[0]?.text, '```\na\n  b\n```');
});

test('code node block id is on the line after the closing fence; a gap makes ^id a paragraph', () => {
	const text = '```\nx\n```\n^c1\n\n```\ny\n```\n\n^c2\n';
	const doc = P(text);
	const [c1, c2, stray] = doc.root.children;
	assert.equal(c1?.blockId, 'c1');
	assert.equal(text.slice(c1?.source?.range.from, c1?.source?.range.to), '```\nx\n```\n^c1');
	assert.equal(c2?.blockId, null);
	assert.deepEqual([stray?.kind, stray?.text, stray?.blockId], ['paragraph', '^c2', null]);
});

test('"- ```js" and bare "-" + indented fence are one code node with the list line in range (4.10)', () => {
	const t1 = '- ```js\n  x\n  ```\n  ^k\n- next\n';
	const d1 = P(t1);
	assert.deepEqual(d1.root.children.map((c) => c.kind), ['code', 'list']);
	assert.equal(d1.root.children[0]?.blockId, 'k');
	assert.equal(t1.slice(d1.root.children[0]?.source?.range.from, d1.root.children[0]?.source?.range.to), '- ```js\n  x\n  ```\n  ^k');
	const t2 = '-\n  ```\n  x\n  ```\n';
	const d2 = P(t2);
	assert.deepEqual(d2.root.children.map((c) => [c.kind, c.text]), [['code', '```\nx\n```']]);
	assert.equal(d2.root.children[0]?.source?.range.from, 0);
});

test('bare "-" with a blank line before the fence is an empty node with a code child (4.10)', () => {
	const doc = P('-\n\n  ```\n  x\n  ```\n');
	assert.deepEqual(doc.root.children.map((c) => [c.kind, c.text]), [['list', '']]);
	assert.deepEqual(doc.root.children[0]?.children.map((c) => [c.kind, c.text]), [['code', '```\nx\n```']]);
});

test('a fence interrupts a paragraph', () => {
	assert.deepEqual(kids(P('text\n```\nc\n```\n')), [['text', 'paragraph'], ['```\nc\n```', 'code']]);
});

// -------------------------------------------------------------------- tables

test('table cells with escaped \\| stay one table; no leading pipe works', () => {
	const t = '| a \\| b | c |\n| --- | --- |\n| 1 \\| 2 | 3 |';
	const doc = P(`# H\n\n${t}\n`);
	assert.deepEqual(doc.root.children.map((c) => [c.kind, c.text]), [['table', t]]);
	const bare = 'a | b\n--|--\n1 | 2';
	assert.deepEqual(kids(P(bare)), [[bare, 'table']]);
});

test('table with trailing \\| in the last cell keeps its column count', () => {
	const t = '| a | b \\|\n| - | - |\n| 1 | 2 \\|';
	assert.deepEqual(kids(P(t)), [[t, 'table']]);
});

test('a table interrupts a paragraph and ends at the first non-pipe blank line', () => {
	const doc = P('intro\n| a | b |\n| - | - |\n| 1 | 2 |\n\nafter\n');
	assert.deepEqual(kids(doc), [['intro', 'paragraph'], ['| a | b |\n| - | - |\n| 1 | 2 |', 'table'], ['after', 'paragraph']]);
});

test('table block id on the next line, uppercase and hyphen; range includes the id line', () => {
	const text = '# H\n| a | b |\n| - | - |\n^Tbl-A\n';
	const doc = P(text);
	const t = doc.root.children[0];
	assert.deepEqual([t.kind, t.blockId], ['table', 'Tbl-A']);
	assert.equal(text.slice(t.source?.range.from, t.source?.range.to), '| a | b |\n| - | - |\n^Tbl-A');
	assert.equal(t.source?.textRange, null);
});

// ---------------------------------------------------------------- block ids

test('block ids: uppercase and hyphens are kept, id equals blockId, text excludes it', () => {
	const doc = P('# R ^Root-1\n- x ^Ab-C1\n- y ^lower\n');
	assert.equal(doc.root.id, 'Root-1');
	const x = byText(doc, 'x');
	assert.deepEqual([x.id, x.blockId], ['Ab-C1', 'Ab-C1']);
});

test('"^id" without a preceding space or with illegal characters is text (4.8)', () => {
	const doc = P('# R\n- x^id\n- y ^a_b\n- z ^ id\n\npara^pid\n');
	assert.deepEqual(flat(doc.root).slice(1).map((n) => [n.text, n.blockId]), [
		['x^id', null],
		['y ^a_b', null],
		['z ^ id', null],
		['para^pid', null],
	]);
});

test('a paragraph consisting only of ^id is text, not a block id (4.10)', () => {
	const doc = P('# R\n\n^lonely\n');
	assert.deepEqual(flat(doc.root).slice(1).map((n) => [n.kind, n.text, n.blockId]), [['paragraph', '^lonely', null]]);
});

test('paragraph and quote block ids need a preceding space', () => {
	const doc = P('para text ^pid\n\n> quoted ^qid\n');
	assert.deepEqual(doc.root.children.map((c) => [c.text, c.blockId]), [['para text', 'pid'], ['> quoted', 'qid']]);
});

test('duplicate ids (case-insensitive): only the first node uses it as id; blockId is unchanged (4.10)', () => {
	const doc = P('# R\n- a ^dup\n- b ^DUP\n- c ^Dup\n');
	const [a, b, c] = doc.root.children as [MapNode, MapNode, MapNode];
	assert.equal(a.id, 'dup');
	assert.notEqual(b.id, 'dup');
	assert.notEqual(b.id.toLowerCase(), 'dup');
	assert.equal(b.blockId, 'DUP');
	assert.equal(c.blockId, 'Dup');
	const ids = flat(doc.root).map((n) => n.id);
	assert.equal(new Set(ids).size, ids.length);
});

test('a table block id duplicating a heading id is also deduplicated', () => {
	const doc = P('# R ^x\n\n| a |\n| - |\n^X\n');
	const ids = flat(doc.root).map((n) => n.id);
	assert.equal(new Set(ids.map((i) => i.toLowerCase())).size, ids.length);
});

// -------------------------------------------------------- text inside items

test('lazy and indented continuation lines are joined; last-line ^id is the block id', () => {
	const text = '- a\n  b <br>c\nlazy ^z\n- d\n';
	const doc = P(text);
	const a = doc.root.children[0];
	assert.equal(a.text, 'a\nb \nc\nlazy');
	assert.equal(a.blockId, 'z');
	assert.equal(a.source?.textRange, null);
	assert.equal(text.slice(a.source?.range.from, a.source?.range.to), '- a\n  b <br>c\nlazy ^z');
});

test('item text is "- [ ] task" and "- [x] done ^id" with the checkbox inside textRange', () => {
	const text = '- [ ] todo\n- [x] done ^d1\n';
	const doc = P(text);
	const [a, b] = doc.root.children as [MapNode, MapNode];
	assert.equal(a.text, '[ ] todo');
	assert.equal(b.text, '[x] done');
	assert.equal(text.slice(b.source?.textRange?.from, b.source?.textRange?.to), '[x] done');
});

test('top-level paragraph: only "-"/"*"/"+"/"1."/"1)" with text interrupt (4.10)', () => {
	assert.deepEqual(kids(P('p\n2. x\n')), [['p\n2. x', 'paragraph']]);
	assert.deepEqual(kids(P('p\n-\n')), [['p\n-', 'paragraph']]);
	assert.deepEqual(kids(P('p\n1. x\n')), [['p', 'paragraph'], ['x', 'list']]);
	assert.deepEqual(kids(P('p\n1) x\n')), [['p', 'paragraph'], ['x', 'list']]);
	assert.deepEqual(kids(P('p\n+ x\n')), [['p', 'paragraph'], ['x', 'list']]);
});

test('inside item text any list marker interrupts, including "2."', () => {
	assert.deepEqual(kids(P('- a\n2. b\n')), [['a', 'list'], ['b', 'list']]);
});

test('a `>` line and a rule interrupt a paragraph or item without creating a node for the rule', () => {
	assert.deepEqual(kids(P('p\n> q\n')), [['p', 'paragraph'], ['> q', 'paragraph']]);
	assert.deepEqual(kids(P('- a\n***\n- b\n')), [['a', 'list'], ['b', 'list']]);
});

test('paragraph lines are trimmed and joined with \\n; unindented paragraph after a list goes to the heading', () => {
	const doc = P('# R\n- a\n\n  line1  \n\t line2\t\n\nafter\n');
	assert.deepEqual(shape(doc.root), ['R', [['a', [['line1\nline2', []]]], ['after', []]]]);
});

test('<br> reads as newline in list items and paragraphs; other spellings stay (4.10)', () => {
	const doc = P('- a<br>b<br/>c\n\np<br>q<BR>r\n');
	assert.deepEqual(doc.root.children.map((c) => c.text), ['a\nb<br/>c', 'p\nq<BR>r']);
});

test('"- \\> x" reads as "> x" and "- > x" is one node "> x"', () => {
	const doc = P('- \\> esc\n- > real\n- after\n');
	assert.deepEqual(doc.root.children.map((c) => [c.text, c.children.length]), [['> esc', 0], ['> real', 0], ['after', 0]]);
});

test('textRange of an empty item with text-less spaces and of trailing-space items', () => {
	const text = '- \n-   x   \n';
	const doc = P(text);
	const [a, b] = doc.root.children as [MapNode, MapNode];
	assert.equal(a.text, '');
	assert.equal(text.slice(b.source?.textRange?.from, b.source?.textRange?.to), 'x');
});

test('empty nodes have an empty textRange at the end of the line (types.ts NodeSource.textRange)', () => {
	for (const text of ['# R\n-\n- b\n', '#\n- b\n']) {
		const doc = P(text);
		const node = doc.root.kind === 'heading' && doc.root.text === '' ? doc.root : doc.root.children[0];
		const tr = node.source?.textRange;
		assert.ok(tr);
		assert.equal(tr.from, tr.to);
		assert.equal(tr.to, node.source?.range.to);
	}
});

test('U+2028 / U+2029 inside a list item line do not stop it being a list item', () => {
	const d1 = P('# R\n- a\u2028b\n- c\u2029d\n');
	assert.deepEqual(d1.root.children.map((c) => [c.kind, c.text]), [['list', 'a\u2028b'], ['list', 'c\u2029d']]);
});

test('U+2028 in a fence info string does not stop it being a fence', () => {
	const d2 = P('```js\u2028x\ncode\n```\n');
	assert.deepEqual(kids(d2), [['```js\u2028x\ncode\n```', 'code']]);
});

// --------------------------------------------------------------- frontmatter

test('minimal frontmatter "---\\n---" and variants', () => {
	const d = P('---\n---\n# T\n');
	assert.deepEqual(d.frontmatter?.range, { from: 0, to: 8 });
	assert.equal(d.frontmatter?.isMindmap, false);
	assert.equal(d.frontmatter?.stateRange, null);
	assert.equal(d.bodyFrom, 8);
	assert.equal(d.root.text, 'T');
	const e = P('---\n---');
	assert.deepEqual(e.frontmatter?.range, { from: 0, to: 7 });
	assert.equal(e.virtualRoot, true);
	assert.equal(e.root.children.length, 0);
});

test('file of only frontmatter without trailing newline, or only an unclosed "---"', () => {
	const a = P('---\nmindmap-plugin: basic\n---');
	assert.equal(a.frontmatter?.isMindmap, true);
	assert.equal(a.frontmatter?.range.to, a.text.length);
	assert.equal(a.root.children.length, 0);
	const b = P('---\nmindmap-plugin: basic\n# T\n');
	assert.equal(b.frontmatter, null); // no closing line: "---" is a rule, the rest is body
	assert.deepEqual(kids(b), [['mindmap-plugin: basic', 'paragraph'], ['T', 'heading']]);
});

test('fence lines may carry trailing spaces/tabs; "----" or "--- x" are not fences', () => {
	const a = P('---  \t\nmindmap-plugin: basic\n--- \t\n# T\n');
	assert.equal(a.frontmatter?.isMindmap, true);
	assert.equal(a.root.text, 'T');
	assert.equal(P('----\nmindmap-plugin: basic\n---\n').frontmatter, null);
	assert.equal(P('--- x\nmindmap-plugin: basic\n---\n').frontmatter, null);
});

test('BOM + CRLF frontmatter', () => {
	const text = '\uFEFF---\r\nmindmap-plugin: basic\r\nmindmark-state: {"version":2,"collapsed":["k"]}\r\n---\r\n# T\r\n- a ^k\r\n';
	const d = P(text);
	assert.equal(d.lineEnding, '\r\n');
	assert.equal(d.frontmatter?.isMindmap, true);
	assert.equal(d.bodyFrom, text.indexOf('# T'));
	assert.equal(text.slice(d.frontmatter?.stateRange?.from, d.frontmatter?.stateRange?.to), 'mindmark-state: {"version":2,"collapsed":["k"]}');
	assert.deepEqual([...d.collapsed], ['k']);
});

test('BOM without frontmatter: the first line still parses as a heading', () => {
	const d = P('\uFEFF# T\n- a\n');
	assert.equal(d.virtualRoot, false);
	assert.equal(d.root.text, 'T');
	assert.equal(d.bodyFrom, 1);
});

test('empty, whitespace-only and BOM-only files', () => {
	for (const text of ['', ' ', '\n\n', '  \t\r\n \r\n', '\uFEFF']) {
		const d = P(text);
		assert.equal(d.virtualRoot, true, JSON.stringify(text));
		assert.equal(d.root.children.length, 0);
		assert.equal(d.root.source, null);
		assert.equal(d.frontmatter, null);
		assert.equal(d.collapsed.size, 0);
	}
});

test('keys that merely contain "mindmark-state" are not the state key', () => {
	const text = [
		'---',
		'x-mindmark-state: {"version":3}',
		'mindmark-state-old: {"version":3}',
		'# mindmark-state: {"version":3}',
		'note: "mindmark-state: {\\"version\\":3}"',
		'nested:',
		'  mindmark-state: {"version":3}',
		'---',
		'# T',
		'- a ^a',
		'',
	].join('\n');
	const d = P(text);
	assert.equal(d.frontmatter?.stateRange, null);
	assert.equal(d.frontmatter?.stateError, null);
	assert.equal(d.frontmatter?.state?.version, 1);
	assert.ok(d.collapsed.has('a'));
});

test('state value spanning several lines is one value; the next key ends it', () => {
	const text = '---\nmindmap-plugin: basic\nmindmark-state: {"version":2,\n  "collapsed": [\n    "a"\n  ]}\ntags: [x]\n---\n# T\n- a ^a\n- b ^b\n';
	const d = P(text);
	assert.equal(d.frontmatter?.stateError, null);
	assert.deepEqual(d.frontmatter?.state?.collapsed, ['a']);
	assert.equal(text.slice(d.frontmatter?.stateRange?.from, d.frontmatter?.stateRange?.to), 'mindmark-state: {"version":2,\n  "collapsed": [\n    "a"\n  ]}');
	assert.deepEqual([...d.collapsed], ['a']);
});

test('YAML flow state: unquoted keys, single quotes, mixed', () => {
	const d = P("---\nmindmark-state: {version: 2, collapsed: [a, 'B-1', \"c\"], extra: 1}\n---\n# T\n- x ^a\n- y ^b-1\n- z ^c\n");
	assert.equal(d.frontmatter?.stateError, null);
	assert.deepEqual(d.frontmatter?.state?.collapsed, ['a', 'B-1', 'c']);
	assert.deepEqual([...d.collapsed].sort(), ['a', 'b-1', 'c']);
	assert.deepEqual(d.frontmatter?.state?.extra, { extra: 1 });
});

test('state matching is case-insensitive; ids not in the tree are dropped; root never collapses', () => {
	const d = P('---\nmindmark-state: {"version":2,"collapsed":["ABC","gone","rt"]}\n---\n# R ^rt\n- x ^abc\n- y ^other\n');
	assert.deepEqual([...d.collapsed], ['abc']);
	const v1 = P('# R ^rt\n- x ^abc\n- y\n');
	assert.deepEqual([...v1.collapsed], ['abc']);
});

test('unsupported and invalid state (3.1)', () => {
	const cases: [string, 'unsupported' | 'invalid'][] = [
		['{"version":3,"collapsed":[]}', 'unsupported'],
		['{"version":0,"collapsed":[]}', 'unsupported'],
		['{"version":"2","collapsed":[]}', 'invalid'],
		['{"version":2.5,"collapsed":[]}', 'invalid'],
		['{"version":2,"collapsed":"a"}', 'invalid'],
		['{"version":2,"collapsed":[1,2]}', 'invalid'],
		['{"version":2,"collapsed":[["a"]]}', 'invalid'],
		['[]', 'invalid'],
		['"str"', 'invalid'],
		['null', 'invalid'],
		['{"version":2,"collapsed":["a"]', 'invalid'],
		['{}', 'invalid'],
	];
	for (const [value, err] of cases) {
		const d = P(`---\nmindmark-state: ${value}\n---\n# T\n- a ^a\n`);
		assert.equal(d.frontmatter?.stateError, err, value);
		assert.equal(d.frontmatter?.state, null, value);
		assert.equal(d.collapsed.size, 0, value);
	}
});

test('block-style YAML state mapping is invalid (4.10)', () => {
	const d = P('---\nmindmark-state:\n  version: 2\n  collapsed: []\n---\n# T\n');
	assert.equal(d.frontmatter?.stateError, 'invalid');
});

test('v2 state: JSON number forms 2.0 / 2e0 are integers', () => {
	assert.equal(P('---\nmindmark-state: {"version":2.0,"collapsed":[]}\n---\n').frontmatter?.stateError, null);
	assert.equal(P('---\nmindmark-state: {"version":2e0,"collapsed":[]}\n---\n').frontmatter?.stateError, null);
});

test('duplicate block id with v2 state collapses only the node that owns the id (4.10)', () => {
	const d = P('---\nmindmark-state: {"version":2,"collapsed":["dup"]}\n---\n# R\n- a ^dup\n- b ^dup\n');
	assert.deepEqual([...d.collapsed], ['dup']);
});

test('unknown state fields survive in extra, including "__proto__" (3.2.1)', () => {
	const d = P('---\nmindmark-state: {"version":2,"collapsed":[],"keep":{"a":[1]},"__proto__":{"p":1}}\n---\n# T\n');
	const text = d.text;
	const out = apply(text, stateLineEdit(text, d.frontmatter, ['q']));
	assert.ok(out.includes('"keep":{"a":[1]}'));
	assert.ok(out.includes('"__proto__"'), out);
});

// -------------------------------------------------------- stateLineEdit cases

const FM = '---\nmindmap-plugin: basic\n';

test('stateLineEdit leaves blank lines and neighbouring keys alone (3.2.5)', () => {
	const text = `${FM}mindmark-state: {"version":2,"collapsed":[]}\n\ntags: [a]\n\n---\n\n# T\n- a ^a\n`;
	const d = P(text);
	const out = apply(text, stateLineEdit(text, d.frontmatter, ['a']));
	assert.equal(out, text.replace('"collapsed":[]', '"collapsed":["a"]'));
});

test('stateLineEdit replaces a multi-line value completely', () => {
	const text = `${FM}mindmark-state: {"version":2,\n  "collapsed":["a"]}\ntags: [x]\n---\n# T\n- a ^a\n- b ^b\n`;
	const d = P(text);
	const out = apply(text, stateLineEdit(text, d.frontmatter, ['a', 'b']));
	assert.equal(out, `${FM}mindmark-state: {"version":2,"collapsed":["a","b"]}\ntags: [x]\n---\n# T\n- a ^a\n- b ^b\n`);
});

test('stateLineEdit without a state line inserts right before the closing ---, after existing blank lines', () => {
	const text = `${FM}tags: [a]\n\n---\n# T\n`;
	const d = P(text);
	const out = apply(text, stateLineEdit(text, d.frontmatter, ['x']));
	assert.equal(out, `${FM}tags: [a]\n\nmindmark-state: {"version":2,"collapsed":["x"]}\n---\n# T\n`);
});

test('stateLineEdit inserts into "---\\n---" and into frontmatter lacking a final newline', () => {
	for (const [text, want] of [
		['---\n---\n# T\n', '---\nmindmark-state: {"version":2,"collapsed":[]}\n---\n# T\n'],
		['---\n---', '---\nmindmark-state: {"version":2,"collapsed":[]}\n---'],
		['---\r\nk: v\r\n---', '---\r\nk: v\r\nmindmark-state: {"version":2,"collapsed":[]}\r\n---'],
	] as const) {
		const d = P(text);
		assert.equal(apply(text, stateLineEdit(text, d.frontmatter, [])), want);
	}
});

test('stateLineEdit uses CRLF throughout for a CRLF file, with and without frontmatter', () => {
	const t1 = '---\r\nk: v\r\n---\r\n# T\r\n';
	const o1 = apply(t1, stateLineEdit(t1, P(t1).frontmatter, ['a']));
	assert.equal(o1.replace(/\r\n/g, ''), o1.replace(/\r\n/g, '').replace(/\n/g, '')); // no bare \n
	const t2 = '# T\r\n- a ^a\r\n';
	const o2 = apply(t2, stateLineEdit(t2, P(t2).frontmatter, ['a']));
	assert.ok(!/(?<!\r)\n/.test(o2), JSON.stringify(o2));
	assert.ok(o2.endsWith(t2));
});

function noopFor(value: string): TextEdit[] {
	const text = `${FM}mindmark-state: ${value}\n---\n# T\n- a ^a\n`;
	return stateLineEdit(text, P(text).frontmatter, ['a']);
}

test('stateLineEdit is a no-op when the same state is already written with different spacing (3.2.6)', () => {
	assert.deepEqual(noopFor('{"version": 2, "collapsed": ["a"]}'), []);
});

test('stateLineEdit is a no-op for the same state written as YAML flow (3.2.6)', () => {
	assert.deepEqual(noopFor('{version: 2, collapsed: [a]}'), []);
});

test('stateLineEdit is a no-op when an extra field makes the canonical key order differ (3.2.6)', () => {
	assert.deepEqual(noopFor('{"version":2,"collapsed":["a"],"foo":1}'), []);
});

test('stateLineEdit leaves unsupported / invalid state files untouched (3.1)', () => {
	for (const v of ['{"version":3,"collapsed":[]}', '{"version":2,"collapsed":"x"}', '[1]']) {
		const text = `${FM}mindmark-state: ${v}\n---\n# T\n`;
		assert.deepEqual(stateLineEdit(text, P(text).frontmatter, ['a']), []);
	}
});

test('stateLineEdit on a BOM file without frontmatter keeps the BOM first and the heading a heading', () => {
	const text = '\uFEFF# T\n- a ^a\n';
	const d = P(text);
	const out = apply(text, stateLineEdit(text, d.frontmatter, ['a']));
	const again = P(out);
	assert.equal(out.charCodeAt(0), 0xfeff);
	assert.equal(again.frontmatter?.state?.version, 2);
	assert.equal(again.virtualRoot, false);
	assert.equal(again.root.text, 'T');
});

test('stateLineEdit only decoy keys: the real state is inserted, decoys untouched', () => {
	const text = '---\nx-mindmark-state: 1\n# mindmark-state: 2\n---\n# T\n- a ^a\n';
	const d = P(text);
	const out = apply(text, stateLineEdit(text, d.frontmatter, ['a']));
	assert.equal(out, '---\nx-mindmark-state: 1\n# mindmark-state: 2\nmindmark-state: {"version":2,"collapsed":["a"]}\n---\n# T\n- a ^a\n');
});

test('collapsedIdsForSave never lists the document root, even a real heading root (3.1 root never collapses)', () => {
	const doc = P('# R ^root\n- a ^a\n');
	const s = createViewState(['root', 'a']);
	const out = collapsedIdsForSave(doc.root, s);
	assert.deepEqual(out.ids, ['a']);
	assert.deepEqual(out.needsBlockId, []);
});

// ------------------------------------------------------- generated invariants

function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const PIECES = ['alpha', '中文', '😀 smile', 'a|b', 'x#y', 'é', '**bold**', '[[link]]', 'a<br>b', 'p^q r', 'tag #t', '👨‍👩‍👧', '\u{1D4B3} z', 'k=v'];

function genBody(rand: () => number, opts: { uniqueIds: boolean; eol: string }): string {
	const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
	let idc = 0;
	const id = (): string => {
		if (rand() > 0.35) return '';
		return opts.uniqueIds ? ` ^k${++idc}` : ` ^${pick(['a', 'A', 'b-1', 'a'])}`;
	};
	const lines: string[] = [];
	const n = 3 + Math.floor(rand() * 22);
	for (let i = 0; i < n; i++) {
		const r = rand();
		if (r < 0.15) lines.push(`${'#'.repeat(1 + Math.floor(rand() * 6))} ${pick(PIECES)}${id()}`);
		else if (r < 0.55) {
			const check = rand() < 0.15 ? '[ ] ' : '';
			lines.push(`${pick(['', '', '  ', '    ', '\t', '      ', '        '])}${pick(['-', '*', '+', '1.', '2)', '-'])} ${check}${pick(PIECES)}${id()}`);
		} else if (r < 0.65) lines.push(pick(PIECES) + id());
		else if (r < 0.75) lines.push('');
		else if (r < 0.78) lines.push(pick(['---', '***', '- - -']));
		else if (r < 0.86) {
			const f = pick(['```', '~~~', '````']);
			lines.push(f, `# ${pick(PIECES)}`, '- x', f);
			const i2 = id();
			if (i2) lines.push(i2.trim());
		} else if (r < 0.92) {
			lines.push(`${pick(['', '  '])}| h | i |`, `${pick(['', '  '])}| - | - |`, `${pick(['', '  '])}| ${pick(PIECES)} | 2 |`);
			const i2 = id();
			if (i2) lines.push(i2.trim());
		} else if (r < 0.96) lines.push(`> ${pick(PIECES)}${id()}`);
		else lines.push(`  ${pick(PIECES)}`);
	}
	return lines.join(opts.eol) + (rand() < 0.8 ? opts.eol : '');
}

function checkInvariants(doc: ParsedDoc): void {
	const text = doc.text;
	const all = flat(doc.root);
	const ids = all.map((n) => n.id);
	assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${JSON.stringify(text)}`);

	const walk = (n: MapNode, prevEnd: number): number => {
		let end = prevEnd;
		const s = n.source;
		if (s) {
			const where = JSON.stringify(text);
			assert.ok(s.range.from >= doc.bodyFrom && s.range.from < s.range.to + 1 && s.range.to <= text.length, where);
			assert.ok(s.range.from === doc.bodyFrom || text[s.range.from - 1] === '\n', `range start not at a line start: ${where}`);
			assert.ok(s.range.to === text.length || text[s.range.to] === '\n' || text[s.range.to] === '\r', `range end not at a line end: ${where}`);
			assert.ok(text[s.range.to - 1] !== '\r' || s.range.to === s.range.from, where);
			assert.ok(s.range.from >= end, `ranges overlap or are out of order: ${where}`);
			assert.ok(s.subtreeTo >= s.range.to, where);
			if (s.textRange) {
				assert.ok(s.textRange.from >= s.range.from && s.textRange.to <= s.range.to && s.textRange.from <= s.textRange.to, where);
				if (n.kind === 'heading' || n.kind === 'list' || n.kind === 'paragraph') {
					assert.equal(text.slice(s.textRange.from, s.textRange.to).replace(/<br>/g, '\n'), n.text, where);
				}
			}
			end = s.range.to;
		}
		let childEnd = end;
		for (const c of n.children) {
			const e = walk(c, childEnd);
			assert.ok(e >= childEnd);
			childEnd = Math.max(childEnd, c.source?.subtreeTo ?? e);
			if (s) assert.ok((c.source?.range.from ?? 0) > s.range.to - 1, 'child starts before parent ends');
		}
		if (s) assert.equal(s.subtreeTo, Math.max(s.range.to, ...n.children.map((c) => c.source?.subtreeTo ?? 0)), JSON.stringify(text));
		return s ? s.subtreeTo : childEnd;
	};
	walk(doc.root, doc.bodyFrom);

	assert.ok(!doc.collapsed.has(doc.root.id));
	for (const c of doc.collapsed) assert.ok(ids.includes(c));
	for (const n of all) assert.ok(!n.text.includes('\r'));
}

test('invariants over 400 generated documents (LF and CRLF, with and without frontmatter)', () => {
	const rand = rng(12345);
	for (let i = 0; i < 400; i++) {
		const eol = rand() < 0.4 ? '\r\n' : '\n';
		const fm = rand() < 0.4 ? `---${eol}mindmap-plugin: basic${eol}---${eol}` : '';
		const doc = P(fm + genBody(rand, { uniqueIds: false, eol }));
		checkInvariants(doc);
	}
});

test('descendant ranges lie inside the parent subtree and siblings are ordered, on a hand-built nested doc', () => {
	const text = '# R\n- a\n  - a1\n    para\n  - a2 ^x\n- b\n\n## H\n```\nc\n```\n^cid\n| a |\n| - |\n';
	const doc = P(text);
	checkInvariants(doc);
	const a = byText(doc, 'a');
	assert.equal(a.source?.subtreeTo, text.indexOf('\n- b'));
	assert.equal(doc.root.source?.subtreeTo, text.length - 1);
});

test('state round trip over 300 generated documents: only the state line changes; collapsed set round-trips', () => {
	const rand = rng(777);
	const variants = [
		(e: string) => '',
		(e: string) => `---${e}mindmap-plugin: basic${e}---${e}`,
		(e: string) => `---${e}mindmap-plugin: basic${e}mindmark-state: {"version":2,"collapsed":["k1"]}${e}---${e}`,
		(e: string) => `---${e}mindmark-state: {"version":2,${e}  "collapsed":["k2",${e}  "k3"],"keep":[1]}${e}tags: [a]${e}${e}---${e}`,
		(e: string) => `---${e}mindmark-state: {"version":1}${e}${e}other: x${e}---${e}`,
		(e: string) => `---${e}k: v${e}${e}---${e}`,
	];
	for (let i = 0; i < 300; i++) {
		const eol = rand() < 0.4 ? '\r\n' : '\n';
		const head = (variants[i % variants.length])(eol);
		const text = head + genBody(rand, { uniqueIds: true, eol });
		const doc = P(text);
		const where = JSON.stringify(text);
		const candidates = flat(doc.root).filter((n) => n !== doc.root && n.blockId !== null);
		const chosen = candidates.filter(() => rand() < 0.5);
		const save = collapsedIdsForSave(doc.root, createViewState(chosen.map((n) => n.id)));
		const edits = stateLineEdit(text, doc.frontmatter, save.ids);
		const out = apply(text, edits);

		assert.ok(edits.length <= 1, where);
		for (const e of edits) {
			assert.equal(out.length, text.length - (e.to - e.from) + e.insert.length);
			assert.equal(out.slice(0, e.from), text.slice(0, e.from));
			assert.equal(out.slice(e.from + e.insert.length), text.slice(e.to));
			const fmEnd = doc.frontmatter ? doc.frontmatter.range.to : 0;
			assert.ok(e.to <= fmEnd || !doc.frontmatter, `edit leaves the frontmatter: ${where}`);
			if (doc.frontmatter?.stateRange) {
				assert.ok(e.from >= doc.frontmatter.stateRange.from && e.to <= doc.frontmatter.stateRange.to, where);
			}
			if (eol === '\r\n') assert.ok(!/(?<!\r)\n/.test(e.insert), where);
		}

		const next = P(out);
		assert.equal(next.frontmatter?.stateError ?? null, null, where);
		assert.equal(next.frontmatter?.isMindmap, doc.frontmatter?.isMindmap ?? false, where);
		assert.deepEqual(next.root.children.map(shape), doc.root.children.map(shape), where);
		assert.equal(next.text.slice(next.bodyFrom), text.slice(doc.bodyFrom), `body changed: ${where}`);
		assert.deepEqual([...next.collapsed].sort(), chosen.map((n) => n.id).sort(), where);
		if (doc.frontmatter?.state?.extra['keep'] !== undefined) {
			assert.deepEqual(next.frontmatter?.state?.extra['keep'], [1], where);
		}
		assert.deepEqual(stateLineEdit(out, next.frontmatter, save.ids), [], `not idempotent: ${where}`);
	}
});
