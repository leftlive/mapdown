import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createViewState, setFocus, visibleNodes } from '../../src/core/state.ts';
import type { MapNode } from '../../src/core/types.ts';
import { findMatches, normalizeSearchText, revealMatch, stepMatch } from '../../src/view/searchMatch.ts';

function n(id: string, text: string, children: MapNode[] = []): MapNode {
	return { id, kind: 'list', text, blockId: null, children, source: null };
}

// root
//   a "Alpha" (a1 "alpha one", a2 "Beta **bold**" (a21 "deep Zeta"))
//   b "Zeta"
const tree = n('root', 'Root', [
	n('a', 'Alpha', [n('a1', 'alpha one'), n('a2', 'Beta **bold**', [n('a21', 'deep Zeta')])]),
	n('b', 'Zeta'),
]);

test('normalizeSearchText: case, markup, line breaks and spaces', () => {
	assert.equal(normalizeSearchText('  Foo **Bar**\n[[Baz]]  ==hi== ~~x~~ `c` '), 'foo bar baz hi x c');
	assert.equal(normalizeSearchText('你好 Node'), '你好 node');
});

test('findMatches: document order, case-insensitive, hidden nodes included', () => {
	assert.deepEqual(findMatches(tree, 'zeta'), ['a21', 'b']);
	assert.deepEqual(findMatches(tree, 'ALPHA'), ['a', 'a1']);
	assert.deepEqual(findMatches(tree, 'beta bold'), ['a2']);
	assert.deepEqual(findMatches(tree, '   '), []);
	assert.deepEqual(findMatches(tree, ''), []);
	assert.deepEqual(findMatches(tree, 'nothing'), []);
});

test('findMatches: the displayed root text and a focus subtree', () => {
	assert.deepEqual(findMatches(tree, 'my file', { rootText: 'My file' }), ['root']);
	assert.deepEqual(findMatches(tree, 'root', { rootText: 'My file' }), []);
	assert.deepEqual(findMatches(tree, 'zeta', { scopeId: 'a' }), ['a21']);
	assert.deepEqual(findMatches(tree, 'zeta', { scopeId: 'gone' }), ['a21', 'b']);
});

test('stepMatch: Enter goes to the first, Shift+Enter to the last, both wrap', () => {
	const m = ['x', 'y', 'z'];
	assert.equal(stepMatch(m, null, 1), 'x');
	assert.equal(stepMatch(m, null, -1), 'z');
	assert.equal(stepMatch(m, 'x', 1), 'y');
	assert.equal(stepMatch(m, 'z', 1), 'x');
	assert.equal(stepMatch(m, 'x', -1), 'z');
	assert.equal(stepMatch(m, 'gone', 1), 'x');
	assert.equal(stepMatch([], null, 1), null);
});

test('revealMatch: only the collapsed ancestors of the match open, temporarily', () => {
	const view = createViewState(['a', 'a2']);
	assert.deepEqual(visibleNodes(tree, view).map((x) => x.id), ['root', 'a', 'b']);
	const next = revealMatch(tree, view, 'a21');
	assert.deepEqual([...next.tempExpanded].sort(), ['a', 'a2']);
	// collapse itself (what mindmark-state is written from) does not change
	assert.deepEqual([...next.collapsed].sort(), ['a', 'a2']);
	assert.deepEqual(visibleNodes(tree, next).map((x) => x.id), ['root', 'a', 'a1', 'a2', 'a21', 'b']);
	// moving to another match folds the earlier branch back
	const other = revealMatch(tree, next, 'b');
	assert.equal(other.tempExpanded.size, 0);
	assert.deepEqual(visibleNodes(tree, other).map((x) => x.id), ['root', 'a', 'b']);
});

test('revealMatch keeps focus mode', () => {
	const view = setFocus(tree, createViewState(['a2']), 'a');
	const next = revealMatch(tree, view, 'a21');
	assert.equal(next.focus, 'a');
	assert.deepEqual(visibleNodes(tree, next).map((x) => x.id), ['a', 'a1', 'a2', 'a21']);
});

test('findMatches on 1,000 nodes stays well inside the 50 ms search budget', () => {
	const kids: MapNode[] = [];
	for (let i = 0; i < 100; i++) {
		const sub: MapNode[] = [];
		for (let j = 0; j < 9; j++) sub.push(n(`n${i}-${j}`, `Item ${i}-${j} **some** text [[Note ${j}]]`));
		kids.push(n(`n${i}`, `Branch ${i}`, sub));
	}
	const big = n('root', 'Root', kids);
	findMatches(big, 'item 5');
	const t0 = performance.now();
	const hits = findMatches(big, 'item 5');
	const ms = performance.now() - t0;
	// "Item 5-j" (9) and "Item 50-j" … "Item 59-j" (90)
	assert.equal(hits.length, 99);
	assert.ok(ms < 25, `search took ${ms.toFixed(1)} ms`);
});
