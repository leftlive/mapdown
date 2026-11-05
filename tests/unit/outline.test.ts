import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
	clampHeadLevel,
	collapsedIdsBreadthFirst,
	writeMapOutline,
	writeOutline,
	type OutlineSource,
} from '../../src/core/outline.ts';
import type { MapNode } from '../../src/core/types.ts';

interface TreeJson {
	text: string;
	blockId?: string;
	children?: TreeJson[];
}

const jsonSource: OutlineSource<TreeJson> = {
	children: (n) => n.children ?? [],
	text: (n) => n.text,
	blockId: (n) => n.blockId ?? '',
};

const write = (tree: TreeJson, headLevel: unknown, eol: '\n' | '\r\n' = '\n'): string =>
	writeOutline(tree, headLevel, jsonSource, eol);

const node = (text: string, children: TreeJson[] = [], blockId?: string): TreeJson => ({ text, children, blockId });

function bodyOf(md: string): string {
	const lines = md.split(/\r?\n/);
	if (lines[0] !== '---') return md.trim();
	const close = lines.indexOf('---', 1);
	return lines.slice(close + 1).join('\n').trim();
}

const COMPAT = join(import.meta.dirname, '../../fixtures/compat');
const SPECIAL = new Set(['table', 'table-in-list', 'table-block-id', 'crlf']);

for (const name of readdirSync(COMPAT).sort()) {
	const dir = join(COMPAT, name);
	const treeFile = join(dir, 'tree-0.3.0.json');
	if (SPECIAL.has(name) || !existsSync(treeFile)) continue;
	const tree = JSON.parse(readFileSync(treeFile, 'utf8')) as TreeJson;
	for (let level = 0; level <= 6; level++) {
		const saved = join(dir, `saved-0.3.0.headLevel-${level}.md`);
		if (!existsSync(saved)) continue;
		test(`compat ${name} headLevel ${level}`, () => {
			assert.equal(write(tree, level), bodyOf(readFileSync(saved, 'utf8')));
		});
	}
}

test('compat crlf: all output uses CRLF when asked', () => {
	const tree = JSON.parse(readFileSync(join(COMPAT, 'crlf/tree-0.3.0.json'), 'utf8')) as TreeJson;
	const lf = write(tree, 1);
	const crlf = write(tree, 1, '\r\n');
	assert.equal(crlf, lf.replace(/\n/g, '\r\n'));
	assert.ok(crlf.includes('\r\n'));
	assert.ok(!/(^|[^\r])\n/.test(crlf));
});

const TABLE = '| a | b |\n| --- | --- |\n| 1 | 2 |';

test('table fixture: heading-depth table has blank lines around it', () => {
	const tree = JSON.parse(readFileSync(join(COMPAT, 'table/tree-0.3.0.json'), 'utf8')) as TreeJson;
	assert.equal(write(tree, 1), `# Root\n- ## T\n-\n    ${TABLE.split('\n').join('\n    ')}`);
	// The table has an earlier sibling, so contract 6.4 keeps it out of heading depth.
	assert.equal(write(tree, 2), write(tree, 1));
});

test('table fixture: list-depth table sits under a bare marker', () => {
	const tree = JSON.parse(readFileSync(join(COMPAT, 'table-in-list/tree-0.3.0.json'), 'utf8')) as TreeJson;
	assert.equal(write(tree, 1), '# Root\n- - item\n-\n    | a | b |\n    | --- | --- |\n    | 1 | 2 |');
});

test('table: heading depth, with block id and followers', () => {
	const tree = node('Root', [node(TABLE, [], 'tbl1'), node('Next', [node('leaf')])]);
	assert.equal(
		write(tree, 2),
		`# Root\n\n${TABLE}\n^tbl1\n\n## Next\n- leaf`,
	);
	// A list item right after a heading-depth table keeps one blank line.
	assert.equal(write(node('Root', [node(TABLE), node('x')]), 2), `# Root\n\n${TABLE}\n\n## x`);
});

test('table: with an earlier sibling headLevel drops to its depth; a first child stays raw', () => {
	const rows = TABLE.split('\n');
	const withSibling = node('Root', [node('A', [node('x'), node(TABLE)])]);
	const expected = '# Root\n\n## A\n- x\n-\n' + rows.map((r) => `    ${r}`).join('\n');
	for (const level of [2, 3, 6]) {
		assert.equal(write(withSibling, level), expected);
	}
	const first = node('Root', [node('A', [node(TABLE), node('x')])]);
	assert.equal(write(first, 3), `# Root\n\n## A\n\n${TABLE}\n\n### x`);
});

test('table: root table at heading depth has no blank before', () => {
	assert.equal(write(node(TABLE, [node('c')]), 1), `${TABLE}\n\n- c`);
});

test('table: list depth, block id after the table, nested indent', () => {
	const tree = node('Root', [node('A', [node(TABLE, [], 'tbl1'), node('B')])]);
	assert.equal(
		write(tree, 1),
		'# Root\n- A\n    -\n        | a | b |\n        | --- | --- |\n        | 1 | 2 |\n        ^tbl1\n    - B',
	);
});

test('table: CRLF applies to table output', () => {
	const out = write(node('Root', [node(TABLE, [], 't')]), 2, '\r\n');
	assert.equal(out, `# Root\r\n\r\n${TABLE.split('\n').join('\r\n')}\r\n^t`);
});

test('not a table: no delimiter row, or first line without pipe', () => {
	assert.equal(write(node('Root', [node('| a | b |\nplain')]), 1), '# Root\n- | a | b |<br>plain');
	assert.equal(write(node('Root', [node('a\n| --- |')]), 1), '# Root\n- a<br>| --- |');
});

test('clampHeadLevel: boundaries and invalid input', () => {
	assert.equal(clampHeadLevel(0), 0);
	assert.equal(clampHeadLevel(6), 6);
	assert.equal(clampHeadLevel(7), 6);
	assert.equal(clampHeadLevel(99), 6);
	assert.equal(clampHeadLevel(-3), 0);
	assert.equal(clampHeadLevel(2.9), 2);
	assert.equal(clampHeadLevel(Number.NaN), 1);
	assert.equal(clampHeadLevel('abc'), 1);
	assert.equal(clampHeadLevel(undefined), 1);
});

test('headLevel 0 writes the root as a list item', () => {
	const tree = node('Root', [node('a', [node('b')])]);
	assert.equal(write(tree, 0), '- Root\n    - a\n        - b');
});

test('headLevel 6 and out-of-range values', () => {
	let tree = node('d6');
	for (let i = 5; i >= 0; i--) tree = node(`d${i}`, [tree]);
	const six = write(tree, 6);
	assert.ok(six.includes('###### d5'));
	assert.ok(six.endsWith('\n- d6'));
	assert.equal(write(tree, 50), six);
	assert.equal(write(tree, -4), write(tree, 0));
});

test('NaN headLevel falls back to 1', () => {
	const tree = node('Root', [node('a')]);
	assert.equal(write(tree, Number.NaN), '# Root\n- a');
	assert.equal(write(tree, 'x'), '# Root\n- a');
});

test('empty text: heading and list', () => {
	const tree = node('Root', [node('', [node('')])]);
	assert.equal(write(tree, 2), '# Root\n\n## \n-');
	assert.equal(write(tree, 1), '# Root\n-\n    -');
});

test('text starting with > is escaped in lists only', () => {
	const tree = node('Root', [node('> quote', [node('>')])]);
	assert.equal(write(tree, 1), '# Root\n- \\> quote\n    - \\>');
	assert.equal(write(tree, 2), '# Root\n\n## > quote\n- \\>');
});

test('multi-line text becomes <br>, with block id', () => {
	const tree = node('Root', [node('a\nb', [], 'x1')]);
	assert.equal(write(tree, 1), '# Root\n- a<br>b ^x1');
	assert.equal(write(tree, 2), '# Root\n\n## a<br>b ^x1');
});

test('code block: list item with indented lines and block id after fence', () => {
	const tree = node('Root', [node('```js\nlet a;\n```', [], 'c1')]);
	assert.equal(write(tree, 1), '# Root\n-\n  ```js\n  let a;\n  ```\n  ^c1');
});

test('code block at depth < headLevel lowers the heading cutoff', () => {
	const tree = node('Root', [node('A', [node('```\nx\n```'), node('B')]), node('C')]);
	// Code is at depth 2, so headLevel 4 behaves as 2.
	assert.equal(write(tree, 4), write(tree, 2));
	assert.equal(write(tree, 4), '# Root\n\n## A\n-\n  ```\n  x\n  ```\n- B\n\n## C');
	// A code block at depth 1 forces everything below the root into lists.
	const top = node('Root', [node('```\nx\n```'), node('D')]);
	assert.equal(write(top, 3), '# Root\n-\n  ```\n  x\n  ```\n- D');
	// A code root forces headLevel 0.
	assert.equal(write(node('```\nx\n```', [node('a')]), 3), '-\n  ```\n  x\n  ```\n    - a');
});

test('written() reports body line ranges', () => {
	const ranges: Array<[string, number, number]> = [];
	const src: OutlineSource<TreeJson> = {
		...jsonSource,
		written: (n, r) => ranges.push([n.text, r.start, r.end]),
	};
	const out = writeOutline(node('Root', [node('A', [node('a1')]), node('B')]), 2, src);
	assert.equal(out, '# Root\n\n## A\n- a1\n\n## B');
	assert.deepEqual(ranges, [
		['Root', 0, 1],
		['A', 2, 3],
		['a1', 3, 4],
		['B', 5, 6],
	]);
});

test('writeMapOutline writes MapNode trees', () => {
	const mk = (text: string, blockId: string | null, children: MapNode[]): MapNode => ({
		id: blockId ?? text,
		kind: 'heading',
		text,
		blockId,
		children,
		source: null,
	});
	const root = mk('Root', 'r', [mk('A', null, [])]);
	assert.equal(writeMapOutline(root, 1, '\n'), '# Root ^r\n- A');
	assert.equal(writeMapOutline(root, 1, '\r\n'), '# Root ^r\r\n- A');
});

test('collapsedIdsBreadthFirst', () => {
	const tree = node('r', [node('a', [node('c', [], 'cc')], 'aa'), node('b', [], 'bb')], 'rr');
	const ids = collapsedIdsBreadthFirst(tree, jsonSource, (n) => n.text !== 'b');
	assert.deepEqual(ids, ['rr', 'aa', 'cc']);
});
