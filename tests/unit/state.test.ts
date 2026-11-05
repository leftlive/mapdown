import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	clearFocus, clearSelection, clearTempExpanded, collapseNode, collapseToLevel,
	collapsedIdsForSave, createViewState, expandAll, expandNode, hidingAncestors,
	isCollapsed, isVisible, pruneSelection, selectAllVisible, selectOnly,
	selectRange, selectedInOrder, setFocus, setTempExpanded, stateLineEdit,
	toggleCollapse, toggleSelection, topmostSelected, visibleNodes,
} from '../../src/core/state.ts';
import type { Frontmatter, MapNode, TextEdit } from '../../src/core/types.ts';

function n(id: string, children: MapNode[] = [], blockId: string | null = null, kind: MapNode['kind'] = 'list'): MapNode {
	return { id, kind, text: id, blockId, children, source: null };
}

// root
//   a (a1, a2 (a21, a22), a3)
//   b (b1)
//   c
const tree = n('root', [
	n('a', [n('a1'), n('a2', [n('a21'), n('a22')], 'x2'), n('a3')], 'xa'),
	n('b', [n('b1')]),
	n('c'),
], null, 'root');

const ids = (nodes: MapNode[]): string[] => nodes.map((x) => x.id);

test('collapse, expand, toggle', () => {
	let s = createViewState(['a']);
	assert.ok(isCollapsed(s, 'a'));
	s = toggleCollapse(s, 'a');
	assert.ok(!isCollapsed(s, 'a'));
	s = toggleCollapse(s, 'b');
	assert.ok(isCollapsed(s, 'b'));
	assert.equal(collapseNode(s, 'b'), s);
	assert.equal(expandNode(s, 'zzz'), s);
	assert.ok(!isCollapsed(expandNode(s, 'b'), 'b'));
});

test('immutability', () => {
	const s = createViewState();
	const t = collapseNode(s, 'a');
	assert.equal(s.collapsed.size, 0);
	assert.equal(t.collapsed.size, 1);
});

test('visibleNodes hides descendants of collapsed nodes', () => {
	const s = createViewState(['a2', 'b']);
	assert.deepEqual(ids(visibleNodes(tree, s)), ['root', 'a', 'a1', 'a2', 'a3', 'b', 'c']);
	assert.ok(isVisible(tree, s, 'a2'));
	assert.ok(!isVisible(tree, s, 'a21'));
	assert.ok(!isVisible(tree, s, 'nope'));
});

test('temporary expansion opens a collapsed node without changing collapsed', () => {
	let s = createViewState(['a', 'a2']);
	s = setTempExpanded(s, ['a', 'a2']);
	assert.ok(isVisible(tree, s, 'a22'));
	assert.ok(isCollapsed(s, 'a'));
	s = clearTempExpanded(s);
	assert.ok(!isVisible(tree, s, 'a1'));
	assert.equal(clearTempExpanded(s), s);
});

test('toggle on a search-opened node collapses state-wise and drops temp expansion', () => {
	let s = setTempExpanded(createViewState(['a']), ['a']);
	s = toggleCollapse(s, 'a');
	assert.ok(!isCollapsed(s, 'a'));
	assert.equal(s.tempExpanded.size, 0);
});

test('hidingAncestors lists collapsed ancestors, root first', () => {
	const s = createViewState(['a', 'a2']);
	assert.deepEqual(hidingAncestors(tree, s, 'a21'), ['a', 'a2']);
	assert.deepEqual(hidingAncestors(tree, s, 'c'), []);
});

test('collapseToLevel', () => {
	const s0 = createViewState(['b', 'zzz']);
	const s1 = collapseToLevel(tree, setTempExpanded(s0, ['b']), 1);
	assert.deepEqual([...s1.collapsed].sort(), ['a', 'a2', 'b']); // c is a leaf
	assert.equal(s1.tempExpanded.size, 0);
	const s2 = collapseToLevel(tree, s1, 2);
	assert.deepEqual([...s2.collapsed], ['a2']);
	assert.deepEqual(ids(visibleNodes(tree, s2)), ['root', 'a', 'a1', 'a2', 'a3', 'b', 'b1', 'c']);
	assert.equal(collapseToLevel(tree, s1, 0).collapsed.has('root'), false); // root never collapses
	assert.equal(collapseToLevel(tree, s1, 9).collapsed.size, 0);
});

test('expandAll', () => {
	const s = setTempExpanded(createViewState(['a', 'b']), ['a']);
	const e = expandAll(s);
	assert.equal(e.collapsed.size + e.tempExpanded.size, 0);
	assert.equal(expandAll(e), e);
});

test('focus limits visibility to the subtree', () => {
	let s = createViewState();
	s = setFocus(tree, s, 'a');
	assert.deepEqual(ids(visibleNodes(tree, s)), ['a', 'a1', 'a2', 'a21', 'a22', 'a3']);
	assert.ok(!isVisible(tree, s, 'root'));
	assert.ok(!isVisible(tree, s, 'b'));
	// collapse inside the focus applies; ancestors outside it do not
	s = collapseNode(collapseNode(s, 'a2'), 'root');
	assert.deepEqual(ids(visibleNodes(tree, s)), ['a', 'a1', 'a2', 'a3']);
	assert.deepEqual(ids(visibleNodes(tree, clearFocus(s))), ['root']);
	assert.equal(setFocus(tree, s, 'missing').focus, null);
	assert.equal(clearFocus(clearFocus(s)).focus, null);
});

test('selectOnly, toggle and primary rules', () => {
	let s = selectOnly(createViewState(), 'a1');
	assert.deepEqual(s.selection, { ids: ['a1'], primary: 'a1' });
	s = toggleSelection(s, 'b');
	s = toggleSelection(s, 'c');
	assert.deepEqual(s.selection, { ids: ['a1', 'b', 'c'], primary: 'c' });
	s = toggleSelection(s, 'b'); // not primary: primary stays
	assert.deepEqual(s.selection, { ids: ['a1', 'c'], primary: 'c' });
	s = toggleSelection(s, 'c'); // primary removed: last remaining
	assert.deepEqual(s.selection, { ids: ['a1'], primary: 'a1' });
	s = toggleSelection(s, 'a1');
	assert.deepEqual(s.selection, { ids: [], primary: null });
	assert.equal(clearSelection(s), s);
	assert.deepEqual(clearSelection(selectOnly(s, 'c')).selection, { ids: [], primary: null });
});

test('selectRange: siblings from primary', () => {
	let s = selectOnly(createViewState(), 'a1');
	s = selectRange(tree, s, 'a3');
	assert.deepEqual(s.selection.ids, ['a1', 'a2', 'a3']);
	assert.equal(s.selection.primary, 'a3');
	// reverse direction
	s = selectRange(tree, selectOnly(createViewState(), 'a3'), 'a1');
	assert.deepEqual([...s.selection.ids].sort(), ['a1', 'a2', 'a3']);
	assert.equal(s.selection.primary, 'a1');
});

test('selectRange: skips hidden siblings, falls back to toggle', () => {
	const hidden = createViewState(['a']);
	// a1..a3 are hidden under collapsed a, but selecting among siblings a, b, c works
	let s = selectRange(tree, selectOnly(hidden, 'a'), 'c');
	assert.deepEqual(s.selection.ids, ['a', 'b', 'c']);
	// different parents: toggle
	s = selectRange(tree, selectOnly(createViewState(), 'a1'), 'b1');
	assert.deepEqual(s.selection, { ids: ['a1', 'b1'], primary: 'b1' });
	// no primary: toggle
	s = selectRange(tree, createViewState(), 'a1');
	assert.deepEqual(s.selection, { ids: ['a1'], primary: 'a1' });
	// same node as primary: toggles off
	s = selectRange(tree, selectOnly(createViewState(), 'a1'), 'a1');
	assert.deepEqual(s.selection.ids, []);
	// root has no parent: toggle
	s = selectRange(tree, selectOnly(createViewState(), 'a'), 'root');
	assert.deepEqual(s.selection.ids, ['a', 'root']);
	// hidden middle sibling is skipped
	const withHiddenFocus = setFocus(tree, createViewState(), 'a2');
	s = selectRange(tree, selectOnly(withHiddenFocus, 'a21'), 'a22');
	assert.deepEqual(s.selection.ids, ['a21', 'a22']);
});

test('selectAllVisible', () => {
	let s = collapseNode(createViewState(), 'a');
	s = selectAllVisible(tree, selectOnly(s, 'b'));
	assert.deepEqual(s.selection.ids, ['root', 'a', 'b', 'b1', 'c']);
	assert.equal(s.selection.primary, 'b');
	// hidden primary falls back to the first visible (root)
	s = selectAllVisible(tree, selectOnly(collapseNode(createViewState(), 'a'), 'a1'));
	assert.equal(s.selection.primary, 'root');
	// with focus: the focus node
	const f = selectAllVisible(tree, setFocus(tree, createViewState(), 'b'));
	assert.deepEqual(f.selection.ids, ['b', 'b1']);
	assert.equal(f.selection.primary, 'b');
});

test('pruneSelection', () => {
	let s = toggleSelection(selectOnly(createViewState(), 'a1'), 'b');
	s = collapseNode(s, 'a');
	const p = pruneSelection(tree, s);
	assert.deepEqual(p.selection, { ids: ['b'], primary: 'b' });
	assert.equal(pruneSelection(tree, p), p);
	const q = pruneSelection(tree, selectOnly(createViewState(), 'gone'));
	assert.deepEqual(q.selection, { ids: [], primary: null });
	// primary kept when still visible
	const keep = toggleSelection(toggleSelection(selectOnly(createViewState(), 'c'), 'gone'), 'b');
	const kp = selectOnly(keep, 'b');
	assert.equal(pruneSelection(tree, kp).selection.primary, 'b');
});

test('topmostSelected and selectedInOrder', () => {
	let s = createViewState();
	for (const id of ['c', 'a22', 'a', 'a2', 'b1', 'root']) s = toggleSelection(s, id);
	assert.deepEqual(ids(selectedInOrder(tree, s)), ['root', 'a', 'a2', 'a22', 'b1', 'c']);
	// root is excluded and does not cover its children
	assert.deepEqual(ids(topmostSelected(tree, s)), ['a', 'b1', 'c']);
	assert.deepEqual(ids(topmostSelected(tree, createViewState())), []);
});

test('collapsedIdsForSave: breadth-first, block ids and needsBlockId', () => {
	const s = setTempExpanded(createViewState(['a2', 'b', 'a', 'unknown', 'root']), ['a']);
	const r = collapsedIdsForSave(tree, s);
	// BFS: a, b (level 1), then a2 (level 2)
	assert.deepEqual(r.entries.map((e) => e.nodeId), ['a', 'b', 'a2']);
	assert.deepEqual(r.ids, ['xa', 'x2']);
	assert.deepEqual(r.needsBlockId, ['b']);
	assert.deepEqual(collapsedIdsForSave(tree, createViewState()).entries, []);
});

// ---- stateLineEdit

function apply(text: string, edits: TextEdit[]): string {
	return [...edits].sort((x, y) => y.from - x.from)
		.reduce((t, e) => t.slice(0, e.from) + e.insert + t.slice(e.to), text);
}

function fm(text: string, state: Frontmatter['state'] = null, withState = true, stateError: Frontmatter['stateError'] = null): Frontmatter {
	const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(text);
	assert.ok(m);
	const s = /mindmark-state:[^\r\n]*/.exec(text);
	return {
		range: { from: 0, to: m[0].length },
		isMindmap: true,
		stateRange: withState && s ? { from: s.index, to: s.index + s[0].length } : null,
		state,
		stateError,
	};
}

const st = (extra: Record<string, unknown> = {}) => ({ version: 2, collapsed: ['old'], extra });

test('stateLineEdit: replaces an existing line', () => {
	const text = '---\nmindmap-plugin: basic\nmindmark-state: {"version":2,"collapsed":["old"]}\n---\n# T\n';
	const out = apply(text, stateLineEdit(text, fm(text, st()), ['ha', 'x9k2']));
	assert.equal(out, '---\nmindmap-plugin: basic\nmindmark-state: {"version":2,"collapsed":["ha","x9k2"]}\n---\n# T\n');
});

test('stateLineEdit: preserves a blank line after the state line (D13)', () => {
	const text = '---\nmindmark-state: {"version":2,"collapsed":["old"]}\n\nmindmap-plugin: basic\n---\n# T\n';
	const out = apply(text, stateLineEdit(text, fm(text, st()), []));
	assert.equal(out, '---\nmindmark-state: {"version":2,"collapsed":[]}\n\nmindmap-plugin: basic\n---\n# T\n');
});

test('stateLineEdit: range that includes the trailing line break keeps it', () => {
	const text = '---\nmindmark-state: {"version":2,"collapsed":["old"]}\n\n---\n';
	const f = fm(text, st());
	f.stateRange = { from: 4, to: text.indexOf('\n\n---') + 1 };
	assert.equal(apply(text, stateLineEdit(text, f, ['n'])), '---\nmindmark-state: {"version":2,"collapsed":["n"]}\n\n---\n');
});

test('stateLineEdit: inserts before the closing --- when absent, blank lines stay', () => {
	const text = '---\nmindmap-plugin: basic\n\n---\n# T\n';
	const out = apply(text, stateLineEdit(text, fm(text, null, false), ['a']));
	assert.equal(out, '---\nmindmap-plugin: basic\n\nmindmark-state: {"version":2,"collapsed":["a"]}\n---\n# T\n');
});

test('stateLineEdit: CRLF', () => {
	const text = '---\r\nmindmap-plugin: basic\r\n---\r\n# T\r\n';
	const out = apply(text, stateLineEdit(text, fm(text, null, false), ['a']));
	assert.equal(out, '---\r\nmindmap-plugin: basic\r\nmindmark-state: {"version":2,"collapsed":["a"]}\r\n---\r\n# T\r\n');
	const text2 = '---\r\nmindmark-state: {"version":2,"collapsed":[]}\r\n\r\n---\r\n';
	const out2 = apply(text2, stateLineEdit(text2, fm(text2, st()), ['b']));
	assert.equal(out2, '---\r\nmindmark-state: {"version":2,"collapsed":["b"]}\r\n\r\n---\r\n');
});

test('stateLineEdit: closing --- with trailing spaces and no final break', () => {
	const text = '---\na: 1\n---  ';
	const out = apply(text, stateLineEdit(text, fm(text, null, false), []));
	assert.equal(out, '---\na: 1\nmindmark-state: {"version":2,"collapsed":[]}\n---  ');
});

test('stateLineEdit: creates frontmatter when absent', () => {
	assert.equal(apply('# T\n', stateLineEdit('# T\n', null, ['a'])), '---\nmindmark-state: {"version":2,"collapsed":["a"]}\n---\n# T\n');
	const crlf = '# T\r\n- x\r\n';
	assert.equal(apply(crlf, stateLineEdit(crlf, null, [])), '---\r\nmindmark-state: {"version":2,"collapsed":[]}\r\n---\r\n# T\r\n- x\r\n');
	assert.equal(apply('', stateLineEdit('', null, [])), '---\nmindmark-state: {"version":2,"collapsed":[]}\n---\n');
});

test('stateLineEdit: keeps extra fields, version and collapsed override in place', () => {
	const text = '---\nmindmark-state: {"zoom":2,"version":1,"collapsed":["q"],"tail":{"k":[1]}}\n---\n';
	const f = fm(text, { version: 2, collapsed: ['q'], extra: { zoom: 2, version: 1, collapsed: ['q'], tail: { k: [1] } } });
	assert.equal(
		apply(text, stateLineEdit(text, f, ['z'])),
		'---\nmindmark-state: {"zoom":2,"version":2,"collapsed":["z"],"tail":{"k":[1]}}\n---\n',
	);
	const text2 = '---\nmindmark-state: {"version":2,"collapsed":["q"],"zoom":2}\n---\n';
	const f2 = fm(text2, { version: 2, collapsed: ['q'], extra: { zoom: 2 } });
	assert.equal(
		apply(text2, stateLineEdit(text2, f2, ['z'])),
		'---\nmindmark-state: {"zoom":2,"version":2,"collapsed":["z"]}\n---\n',
	);
});

test('stateLineEdit: no-op when the line is identical', () => {
	const text = '---\nmindmark-state: {"version":2,"collapsed":["a","b"]}\n\n---\n';
	assert.deepEqual(stateLineEdit(text, fm(text, st()), ['a', 'b']), []);
	const crlf = '---\r\nmindmark-state: {"version":2,"collapsed":[]}\r\n---\r\n';
	assert.deepEqual(stateLineEdit(crlf, fm(crlf, st()), []), []);
});

test('stateLineEdit: unsupported or invalid state is left alone', () => {
	const text = '---\nmindmark-state: {"version":3}\n---\n';
	assert.deepEqual(stateLineEdit(text, fm(text, null, true, 'unsupported'), ['a']), []);
	assert.deepEqual(stateLineEdit(text, fm(text, null, true, 'invalid'), ['a']), []);
});

test('stateLineEdit: older version 1 line is rewritten as version 2', () => {
	const text = '---\nmindmark-state: {"version":1}\n---\n';
	const f = fm(text, { version: 1, collapsed: [], extra: {} });
	assert.equal(apply(text, stateLineEdit(text, f, [])), '---\nmindmark-state: {"version":2,"collapsed":[]}\n---\n');
});
