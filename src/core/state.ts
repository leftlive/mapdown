// View state over a MapNode tree: collapse, search expansion, focus mode and
// selection. Everything is immutable; functions return new ViewState values.
// Node ids are MapNode.id; the tree is passed in wherever structure matters.
import type { Frontmatter, MapNode, TextEdit } from './types.ts';

export interface Selection {
	/** Selected ids in the order they were selected. */
	readonly ids: readonly string[];
	/** Last clicked node (editing and keyboard navigation act on it). */
	readonly primary: string | null;
}

export interface ViewState {
	/** Persistent collapsed ids (written to mindmark-state). */
	readonly collapsed: ReadonlySet<string>;
	/** Collapsed ids that search has opened temporarily; never persisted. */
	readonly tempExpanded: ReadonlySet<string>;
	readonly focus: string | null;
	readonly selection: Selection;
}

export function createViewState(collapsed: Iterable<string> = []): ViewState {
	return {
		collapsed: new Set(collapsed),
		tempExpanded: new Set(),
		focus: null,
		selection: { ids: [], primary: null },
	};
}

// ---------------------------------------------------------------- tree utils

function findNode(tree: MapNode, id: string): MapNode | null {
	if (tree.id === id) return tree;
	for (const child of tree.children) {
		const hit = findNode(child, id);
		if (hit) return hit;
	}
	return null;
}

/** Parent of every node (the root is absent from the map). */
function parentMap(tree: MapNode): Map<string, MapNode> {
	const parents = new Map<string, MapNode>();
	const walk = (node: MapNode): void => {
		for (const child of node.children) {
			parents.set(child.id, node);
			walk(child);
		}
	};
	walk(tree);
	return parents;
}

function withCollapsed(state: ViewState, collapsed: Set<string>): ViewState {
	return { ...state, collapsed };
}

// ------------------------------------------------------------------ collapse

export function isCollapsed(state: ViewState, id: string): boolean {
	return state.collapsed.has(id);
}

export function collapseNode(state: ViewState, id: string): ViewState {
	if (state.collapsed.has(id)) return state;
	return withCollapsed(state, new Set(state.collapsed).add(id));
}

/** Expanding also drops any temporary expansion of the node. */
export function expandNode(state: ViewState, id: string): ViewState {
	if (!state.collapsed.has(id) && !state.tempExpanded.has(id)) return state;
	const collapsed = new Set(state.collapsed);
	collapsed.delete(id);
	const tempExpanded = new Set(state.tempExpanded);
	tempExpanded.delete(id);
	return { ...state, collapsed, tempExpanded };
}

export function toggleCollapse(state: ViewState, id: string): ViewState {
	// A node that only looks open because of search counts as collapsed.
	return state.collapsed.has(id) ? expandNode(state, id) : collapseNode(state, id);
}

/**
 * Collapses nodes at depth >= level (root is depth 0) and expands shallower
 * ones. Only nodes with children are collapsed, so leaves never need a block
 * id. Replaces the whole collapsed set and clears temporary expansion.
 */
export function collapseToLevel(tree: MapNode, state: ViewState, level: number): ViewState {
	const collapsed = new Set<string>();
	const walk = (node: MapNode, depth: number): void => {
		// The root never collapses (contract 3.1).
		if (depth > 0 && depth >= level && node.children.length > 0) collapsed.add(node.id);
		for (const child of node.children) walk(child, depth + 1);
	};
	walk(tree, 0);
	return { ...state, collapsed, tempExpanded: new Set() };
}

export function expandAll(state: ViewState): ViewState {
	if (state.collapsed.size === 0 && state.tempExpanded.size === 0) return state;
	return { ...state, collapsed: new Set(), tempExpanded: new Set() };
}

/** Search opens these branches for now; replaces earlier temporary expansion. */
export function setTempExpanded(state: ViewState, ids: Iterable<string>): ViewState {
	return { ...state, tempExpanded: new Set(ids) };
}

export function clearTempExpanded(state: ViewState): ViewState {
	return state.tempExpanded.size === 0 ? state : { ...state, tempExpanded: new Set() };
}

/** Ancestor ids (root first, excluding the node) that hide `id` from view. */
export function hidingAncestors(tree: MapNode, state: ViewState, id: string): string[] {
	const parents = parentMap(tree);
	const out: string[] = [];
	for (let p = parents.get(id); p; p = parents.get(p.id)) {
		if (state.collapsed.has(p.id)) out.unshift(p.id);
	}
	return out;
}

// --------------------------------------------------------------------- focus

/** Unknown ids are ignored (focus cleared). */
export function setFocus(tree: MapNode, state: ViewState, id: string | null): ViewState {
	const focus = id !== null && findNode(tree, id) ? id : null;
	return focus === state.focus ? state : { ...state, focus };
}

export function clearFocus(state: ViewState): ViewState {
	return state.focus === null ? state : { ...state, focus: null };
}

// ---------------------------------------------------------------- visibility

function isOpen(state: ViewState, node: MapNode): boolean {
	return !state.collapsed.has(node.id) || state.tempExpanded.has(node.id);
}

/**
 * Visible nodes in document order. With a focus node only its subtree is
 * shown (collapse still applies inside it, starting at the focus node).
 */
export function visibleNodes(tree: MapNode, state: ViewState): MapNode[] {
	const start = state.focus !== null ? findNode(tree, state.focus) ?? tree : tree;
	const out: MapNode[] = [];
	const walk = (node: MapNode): void => {
		out.push(node);
		if (!isOpen(state, node)) return;
		for (const child of node.children) walk(child);
	};
	walk(start);
	return out;
}

export function isVisible(tree: MapNode, state: ViewState, id: string): boolean {
	return visibleNodes(tree, state).some((n) => n.id === id);
}

// ----------------------------------------------------------------- selection

function withSelection(state: ViewState, ids: readonly string[], primary: string | null): ViewState {
	return { ...state, selection: { ids, primary } };
}

export function clearSelection(state: ViewState): ViewState {
	return state.selection.ids.length === 0 && state.selection.primary === null
		? state
		: withSelection(state, [], null);
}

/** Plain click. */
export function selectOnly(state: ViewState, id: string): ViewState {
	return withSelection(state, [id], id);
}

/** Mod+click: add (becoming primary) or remove. */
export function toggleSelection(state: ViewState, id: string): ViewState {
	const { ids, primary } = state.selection;
	if (!ids.includes(id)) return withSelection(state, [...ids, id], id);
	const rest = ids.filter((x) => x !== id);
	// Removing the primary hands it to the most recently selected node.
	return withSelection(state, rest, primary === id ? rest[rest.length - 1] ?? null : primary);
}

/**
 * Shift+click: when the primary node and the clicked node share a parent,
 * adds the sibling range between them (visible siblings only, existing
 * selection kept) and makes the clicked node primary; otherwise toggles.
 */
export function selectRange(tree: MapNode, state: ViewState, id: string): ViewState {
	const anchor = state.selection.primary;
	if (anchor === null || anchor === id) return toggleSelection(state, id);
	const parents = parentMap(tree);
	const parent = parents.get(id);
	if (!parent || parents.get(anchor) !== parent) return toggleSelection(state, id);
	const from = parent.children.findIndex((c) => c.id === anchor);
	const to = parent.children.findIndex((c) => c.id === id);
	const visible = new Set(visibleNodes(tree, state).map((n) => n.id));
	const ids = [...state.selection.ids.filter((x) => x !== id)];
	for (const child of parent.children.slice(Math.min(from, to), Math.max(from, to) + 1)) {
		if (child.id !== id && visible.has(child.id) && !ids.includes(child.id)) ids.push(child.id);
	}
	ids.push(id);
	return withSelection(state, ids, id);
}

/** Mod+A: every visible node; keeps the primary when visible, else focus node or root. */
export function selectAllVisible(tree: MapNode, state: ViewState): ViewState {
	const nodes = visibleNodes(tree, state);
	const visible = new Set(nodes.map((n) => n.id));
	const { primary } = state.selection;
	const next = primary !== null && visible.has(primary) ? primary : nodes[0]?.id ?? null;
	return withSelection(state, nodes.map((n) => n.id), next);
}

/** Drops selected ids that are gone or hidden (after delete, collapse, focus). */
export function pruneSelection(tree: MapNode, state: ViewState): ViewState {
	const visible = new Set(visibleNodes(tree, state).map((n) => n.id));
	const { ids, primary } = state.selection;
	const kept = ids.filter((id) => visible.has(id));
	if (kept.length === ids.length) return state;
	return withSelection(
		state,
		kept,
		primary !== null && kept.includes(primary) ? primary : kept[kept.length - 1] ?? null,
	);
}

/** Selected nodes in document order. */
export function selectedInOrder(tree: MapNode, state: ViewState): MapNode[] {
	const set = new Set(state.selection.ids);
	const out: MapNode[] = [];
	const walk = (node: MapNode): void => {
		if (set.has(node.id)) out.push(node);
		node.children.forEach(walk);
	};
	walk(tree);
	return out;
}

/**
 * Selected nodes with no selected ancestor, in document order. The root is
 * left out and does not cover its children.
 */
export function topmostSelected(tree: MapNode, state: ViewState): MapNode[] {
	const set = new Set(state.selection.ids);
	const out: MapNode[] = [];
	const walk = (node: MapNode, covered: boolean): void => {
		const selected = set.has(node.id);
		if (selected && !covered && node !== tree) out.push(node);
		for (const child of node.children) walk(child, covered || (selected && node !== tree));
	};
	walk(tree, false);
	return out;
}

// ------------------------------------------------------------- saving state

export interface CollapsedForSave {
	/** Collapsed nodes in breadth-first order, with their block id if any. */
	entries: { nodeId: string; blockId: string | null }[];
	/** Block ids of the entries that have one, in the same order. */
	ids: string[];
	/** Node ids of collapsed nodes without a block id; the serializer assigns them. */
	needsBlockId: string[];
}

/**
 * Collapsed nodes to persist (contract 3.2.2). Temporary expansion is
 * ignored: a node opened by search still counts as collapsed. Ids not in the
 * tree and the virtual root are skipped.
 */
export function collapsedIdsForSave(tree: MapNode, state: ViewState): CollapsedForSave {
	const result: CollapsedForSave = { entries: [], ids: [], needsBlockId: [] };
	let level: MapNode[] = [tree];
	while (level.length > 0) {
		const next: MapNode[] = [];
		for (const node of level) {
			if (node !== tree && state.collapsed.has(node.id)) {
				result.entries.push({ nodeId: node.id, blockId: node.blockId });
				if (node.blockId !== null) result.ids.push(node.blockId);
				else result.needsBlockId.push(node.id);
			}
			next.push(...node.children);
		}
		level = next;
	}
	return result;
}

// -------------------------------------------------------------- state line

function sameIds(a: readonly string[], b: readonly string[]): boolean {
	const set = new Set(a);
	return set.size === new Set(b).size && b.every((id) => set.has(id));
}

const STATE_KEY = 'mindmark-state';

function detectEol(text: string): '\n' | '\r\n' {
	const i = text.indexOf('\n');
	return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * Edits that write the `mindmark-state` line (version 2) and nothing else in
 * the frontmatter. Returns [] when the stored state already means the same
 * thing (version 2, same set of ids; spelling and key order don't matter), or
 * when the existing state is unsupported or invalid (the file is left alone).
 * Call it only after the user changed the collapse state: with no state line,
 * any call writes one.
 */
export function stateLineEdit(
	text: string,
	frontmatter: Frontmatter | null,
	collapsedIds: readonly string[],
): TextEdit[] {
	if (frontmatter?.stateError) return [];
	const current = frontmatter?.stateRange ? frontmatter.state : null;
	if (current && current.version === 2 && sameIds(current.collapsed, collapsedIds)) return [];
	const extra = frontmatter?.state?.extra ?? {};
	const line = `${STATE_KEY}: ${JSON.stringify({ ...extra, version: 2, collapsed: [...collapsedIds] })}`;
	const eol = detectEol(text);

	if (!frontmatter) {
		// After a BOM; the body's bytes stay as they are (7).
		const at = text.startsWith('\uFEFF') ? 1 : 0;
		return [{ from: at, to: at, insert: `---${eol}${line}${eol}---${eol}` }];
	}

	if (frontmatter.stateRange) {
		const from = frontmatter.stateRange.from;
		// Ranges may include the line break after the value; leave it alone.
		let to = frontmatter.stateRange.to;
		while (to > from && (text[to - 1] === '\n' || text[to - 1] === '\r')) to--;
		if (text.slice(from, to) === line) return [];
		return [{ from, to, insert: line }];
	}

	// Insert right before the closing `---` line.
	const { from, to } = frontmatter.range;
	let end = to;
	while (end > from && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--;
	const closeFrom = text.lastIndexOf('\n', end - 1) + 1;
	return [{ from: closeFrom, to: closeFrom, insert: `${line}${eol}` }];
}
