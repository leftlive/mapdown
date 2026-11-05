// Pure building blocks for map commands: which side of the root a node is
// on, keyboard navigation, collapse targets for the level commands, joining,
// text formatting and the clipboard formats. Commands (src/commands.ts) turn
// these into session steps.

import { writeOutline } from '../core/outline.ts';
import {
	deleteNodes,
	findNodeAt,
	moveNodes,
	setText,
	type NodeInput,
} from '../core/ops.ts';
import { visibleNodes, type ViewState } from '../core/state.ts';
import type { LayoutDirection, MapNode, ParsedDoc } from '../core/types.ts';
import { indexNodes, type StepFn } from './session.ts';
import { mapPos } from './textEdits.ts';

export type Side = 'root' | 'left' | 'right';

/** Side of the root each node is drawn on (behaviour spec 9). */
export function sidesOf(root: MapNode, direction: LayoutDirection): Map<string, Side> {
	const out = new Map<string, Side>([[root.id, 'root']]);
	const n = root.children.length;
	const rightCount = direction === 'right' ? n : direction === 'left' ? 0 : Math.ceil(n / 2);
	root.children.forEach((c, i) => {
		const side: Side = i < rightCount ? 'right' : 'left';
		const walk = (node: MapNode): void => {
			out.set(node.id, side);
			node.children.forEach(walk);
		};
		walk(c);
	});
	return out;
}

const isOpen = (view: ViewState, id: string): boolean => !view.collapsed.has(id) || view.tempExpanded.has(id);

export type Arrow = 'up' | 'down' | 'left' | 'right';

export interface NavResult {
	/** Node to select. */
	select: string | null;
	/** A collapsed node to open first (one undoable step). */
	expand: string | null;
}

/** Root children on the same side as `id`, in on-screen order (top to bottom). */
function sideSiblings(root: MapNode, id: string, sides: Map<string, Side>, direction: LayoutDirection): MapNode[] {
	const side = sides.get(id);
	const list = root.children.filter((c) => sides.get(c.id) === side);
	return direction === 'clockwise' && side === 'left' ? list.reverse() : list;
}

/**
 * Arrow keys (spec 3.1). Up/down: previous or next sibling; at either end,
 * the parent's previous or next sibling. Towards the root: the parent. Away
 * from the root: the first child, opening the node first when collapsed. On
 * the root, left/right go to the first child on that side.
 */
export function navigate(doc: ParsedDoc, view: ViewState, from: string | null, arrow: Arrow, direction: LayoutDirection): NavResult {
	const root = doc.root;
	const index = indexNodes(root);
	if (from === null || !index.has(from)) return { select: root.id, expand: null };
	const sides = sidesOf(root, direction);
	const node = index.get(from)?.node ?? root;
	const parent = index.get(from)?.parent ?? null;
	const side = sides.get(from) ?? 'root';

	const siblingsOf = (n: MapNode, p: MapNode | null): MapNode[] =>
		p === null ? [] : p === root ? sideSiblings(root, n.id, sides, direction) : p.children;

	if (arrow === 'up' || arrow === 'down') {
		const step = arrow === 'up' ? -1 : 1;
		const sibs = siblingsOf(node, parent);
		const at = sibs.indexOf(node);
		const next = sibs[at + step];
		if (next) return { select: next.id, expand: null };
		if (parent && parent !== root) {
			const grand = index.get(parent.id)?.parent ?? null;
			const psibs = siblingsOf(parent, grand);
			const pnext = psibs[psibs.indexOf(parent) + step];
			if (pnext) return { select: pnext.id, expand: null };
		}
		return { select: from, expand: null };
	}

	const towardsRoot = (side === 'right' && arrow === 'left') || (side === 'left' && arrow === 'right');
	if (side !== 'root' && towardsRoot) return { select: parent?.id ?? from, expand: null };
	let children = node.children;
	if (side === 'root') {
		const want: Side = arrow === 'left' ? 'left' : 'right';
		children = sideSiblings(root, root.children.find((c) => sides.get(c.id) === want)?.id ?? '', sides, direction);
	}
	const first = children[0];
	if (!first) return { select: from, expand: null };
	return { select: first.id, expand: side !== 'root' && !isOpen(view, node.id) ? node.id : null };
}

/** Depth of every node (root 0). */
function depths(root: MapNode): Map<string, number> {
	const out = new Map<string, number>();
	const walk = (n: MapNode, d: number): void => {
		out.set(n.id, d);
		n.children.forEach((c) => walk(c, d + 1));
	};
	walk(root, 0);
	return out;
}

/**
 * Collapsed set that shows the whole map down to depth `level`: nodes at that
 * depth with children are collapsed, shallower ones opened, deeper ones keep
 * their state (so as few lines as possible change). The root never collapses.
 */
export function showToLevel(root: MapNode, collapsed: ReadonlySet<string>, level: number): Set<string> {
	const L = Math.max(1, level);
	const out = new Set<string>();
	const walk = (n: MapNode, d: number): void => {
		if (d === L && n.children.length > 0) out.add(n.id);
		else if (d > L && collapsed.has(n.id)) out.add(n.id);
		n.children.forEach((c) => walk(c, d + 1));
	};
	walk(root, 0);
	return out;
}

/** Expand or collapse one level of the whole map, relative to the node's depth (spec 2.2). */
export function levelFromNode(root: MapNode, collapsed: ReadonlySet<string>, id: string, delta: 1 | -1): Set<string> | null {
	const d = depths(root).get(id);
	if (d === undefined) return null;
	return showToLevel(root, collapsed, d + delta);
}

/**
 * Within the node's subtree, open the deepest shown level one further
 * (delta 1), or hide the deepest shown level (delta -1).
 */
export function levelInSubtree(doc: ParsedDoc, view: ViewState, id: string, delta: 1 | -1): Set<string> | null {
	const info = indexNodes(doc.root).get(id);
	if (!info) return null;
	const shown: { node: MapNode; depth: number }[] = [];
	const walk = (n: MapNode, d: number): void => {
		shown.push({ node: n, depth: d });
		if (!isOpen(view, n.id)) return;
		n.children.forEach((c) => walk(c, d + 1));
	};
	walk(info.node, 0);
	const max = Math.max(...shown.map((s) => s.depth));
	const out = new Set(view.collapsed);
	if (delta > 0) {
		for (const s of shown) if (s.depth === max) out.delete(s.node.id);
	} else {
		if (max === 0) return null;
		for (const s of shown) {
			if (s.depth === max - 1 && s.node.children.length > 0 && s.node !== doc.root) out.add(s.node.id);
		}
	}
	return out;
}

// ------------------------------------------------------------------ joining

const PDF_LINK = /\s*\[🔗\]\([^)]*\.pdf[^)]*\)\s*$/u;
const PAGE = /\s*\(p\.\s*\d+\)\s*$/u;
const LEADING_EMOJI = /^\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}]*\s*/u;

/** The text of a join (spec 2.3). */
export function joinedText(current: string, next: string, citation: boolean): string {
	let cur = current;
	for (let i = 0; i < 4; i++) {
		const stripped = cur.replace(PDF_LINK, '').replace(PAGE, '');
		if (stripped === cur) break;
		cur = stripped;
	}
	const below = next.replace(LEADING_EMOJI, '');
	return `${cur}${citation ? ' (…)' : ''}\n${below}`;
}

/**
 * Join `id` with its next sibling as one chain: move the sibling's children
 * under `id`, set the joined text, delete the sibling. Null when there is no
 * next sibling.
 */
export function joinSteps(doc: ParsedDoc, id: string, citation: boolean): StepFn[] | null {
	const info = indexNodes(doc.root).get(id);
	const parent = info?.parent;
	if (!info || !parent) return null;
	const next = parent.children[parent.children.indexOf(info.node) + 1];
	if (!next?.source) return null;
	const value = joinedText(info.node.text, next.text, citation);
	const nextStart = next.source.range.from;
	let nextAt = nextStart;
	const kids = next.children.map((c) => c.id);
	return [
		(d, idOf) => {
			if (kids.length === 0) return { result: { edits: [], inverse: [], anchors: [] } };
			const cur = indexNodes(d.root).get(idOf(id))?.node;
			if (!cur) return null;
			const result = moveNodes(d, kids.map(idOf), { parentId: cur.id, index: cur.children.length });
			if (!result) return null;
			nextAt = mapPos(nextAt, result.edits, 1);
			return { result, keep: kids.map(idOf) };
		},
		(d, idOf) => {
			const result = setText(d, idOf(id), value);
			if (!result) return null;
			nextAt = mapPos(nextAt, result.edits, 1);
			return { result, keep: [idOf(id)] };
		},
		(d) => {
			const n = findNodeAt(d, nextAt);
			if (!n) return null;
			const result = deleteNodes(d, [n.id]);
			return result ? { result } : null;
		},
	];
}

// --------------------------------------------------------------- formatting

/** Wrap the whole text in `marker`, or unwrap when it is already wrapped (spec 2.2). */
export function toggleWrap(text: string, marker: string): string {
	if (text.length >= marker.length * 2 && text.startsWith(marker) && text.endsWith(marker)) {
		return text.slice(marker.length, text.length - marker.length);
	}
	return marker + text + marker;
}

/** "Remove line breaks": every line break becomes a space. */
export function removeLineBreaks(text: string): string {
	return text.replace(/\s*\n\s*/g, ' ');
}

// ---------------------------------------------------------------- clipboard

interface ClipItem {
	id: string;
	text: string;
	pid: string | null;
	expanded: boolean;
	note: string;
}

/** The 0.3.0 copy format: `{"type":"copyNode","text":[{id,text,pid,expanded,note}]}`. */
export function toClipboardJson(nodes: readonly MapNode[], collapsed: ReadonlySet<string>): string {
	const items: ClipItem[] = [];
	let n = 0;
	const walk = (node: MapNode, pid: string | null): void => {
		const id = `n${++n}`;
		items.push({ id, text: node.text, pid, expanded: !collapsed.has(node.id), note: '' });
		node.children.forEach((c) => walk(c, id));
	};
	nodes.forEach((node) => walk(node, null));
	return JSON.stringify({ type: 'copyNode', text: items });
}

export interface ClipNode extends NodeInput {
	collapsed?: boolean;
	children?: ClipNode[];
}

/** Read the 0.3.0 copy format; null when `text` is anything else. */
export function fromClipboardJson(text: string): ClipNode[] | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith('{')) return null;
	let data: unknown;
	try {
		data = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (!data || typeof data !== 'object') return null;
	const d = data as { type?: unknown; text?: unknown };
	if (d.type !== 'copyNode' || !Array.isArray(d.text)) return null;
	const byId = new Map<string, ClipNode>();
	const tops: ClipNode[] = [];
	const items = d.text.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
	const key = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? String(v) : null);
	items.forEach((it, i) => {
		const node: ClipNode = { text: typeof it.text === 'string' ? it.text : '', children: [], collapsed: it.expanded === false };
		byId.set(key(it.id) ?? `#${i}`, node);
	});
	items.forEach((it, i) => {
		const node = byId.get(key(it.id) ?? `#${i}`);
		if (!node) return;
		const pid = key(it.pid);
		const parent = pid === null ? undefined : byId.get(pid);
		if (parent && parent !== node) parent.children?.push(node);
		else tops.push(node);
	});
	return tops.length > 0 ? tops : null;
}

/** Markdown outline of the nodes, as list items (format contract 6), without block ids. */
export function toClipboardOutline(nodes: readonly MapNode[]): string {
	return nodes
		.map((n) => writeOutline(n, 0, { children: (x) => x.children, text: (x) => x.text, blockId: () => '' }, '\n'))
		.join('\n');
}

const escapeHtml = (s: string): string =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The outline as an HTML list whose root carries `data-mapdown` with the 0.3.0 JSON. */
export function toClipboardHtml(nodes: readonly MapNode[], json: string): string {
	const list = (items: readonly MapNode[]): string =>
		`<ul>${items.map((n) => `<li>${escapeHtml(n.text).replace(/\n/g, '<br>')}${n.children.length ? list(n.children) : ''}</li>`).join('')}</ul>`;
	const inner = list(nodes);
	return `<ul data-mapdown="${escapeHtml(json)}">${inner.slice(4)}`;
}

/** The JSON inside `data-mapdown` of an HTML clipboard payload, if any. */
export function jsonFromClipboardHtml(html: string): string | null {
	const m = /data-mapdown="([^"]*)"/.exec(html);
	if (!m) return null;
	return (m[1] ?? '')
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, '&');
}

/** Visible nodes (helper for tests and the test API). */
export function visibleList(doc: ParsedDoc, view: ViewState): MapNode[] {
	return visibleNodes(doc.root, view);
}
