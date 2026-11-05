// The one registry of map operations (development plan 3.5). The command
// palette, the map's key table, the toolbar and the node menu all run these.
// Ids of 0.3.0 commands are kept exactly (behaviour spec 2.2); new ones are
// kebab-case. None has a default hotkey.

import {
	adoptSiblings,
	childPosition,
	deleteNodes,
	insertNodes,
	moveDown,
	moveNodes,
	moveUp,
	setText,
	siblingPosition,
} from './core/ops.ts';
import { selectAllVisible, topmostSelected } from './core/state.ts';
import type { MapNode } from './core/types.ts';
import {
	joinSteps,
	levelFromNode,
	levelInSubtree,
	removeLineBreaks,
	showToLevel,
	sidesOf,
	toggleWrap,
} from './controller/actions.ts';
import { collapseToggleTarget } from './controller/selectionOps.ts';
import { indexNodes, keepSelection, type StepFn } from './controller/session.ts';
import type { StringKey } from './i18n.ts';
import type { MapView } from './view/MapView.ts';

/** When a command is available (the "需要" column of spec 2.2). */
export type Need = 'map' | 'selection' | 'editing';

export interface MapCommand {
	id: string;
	/** i18n key of the name; `nameArg` fills `{0}`. */
	name: StringKey;
	nameArg?: number;
	need: Need;
	/** Shown in the command palette (internal key actions are not). */
	palette: boolean;
	/** Runs the command; the view is the active map view. */
	run(view: MapView): void;
}

const step = (fn: StepFn): StepFn[] => [fn];

function primaryNode(v: MapView): MapNode | null {
	const id = v.session.view.selection.primary;
	return id === null ? null : indexNodes(v.session.doc.root).get(id)?.node ?? null;
}

function topSelected(v: MapView): MapNode[] {
	return topmostSelected(v.session.doc.root, v.session.view);
}

function addSibling(v: MapView): void {
	const node = primaryNode(v);
	if (!node) return;
	if (node === v.session.doc.root) return; // Enter on the root adds nothing (spec 3.1)
	const pos = siblingPosition(v.session.doc, node.id, 'after');
	if (!pos) return;
	if (v.runSteps(step((d) => {
		const result = insertNodes(d, [{ text: '' }], pos, { headLevel: v.headLevel() });
		return result ? { result } : null;
	}))) v.startEditPrimary('end');
}

function addChild(v: MapView, id?: string): void {
	const parentId = id ?? v.session.view.selection.primary ?? v.session.doc.root.id;
	const pos = childPosition(v.session.doc, parentId, 'last');
	if (!pos) return;
	if (v.runSteps(step((d) => {
		const result = insertNodes(d, [{ text: '' }], pos, { headLevel: v.headLevel() });
		return result ? { result } : null;
	}))) v.startEditPrimary('end');
}

/** Delete the selection; select the previous sibling, else the next, else the parent. */
export function deleteSelection(v: MapView, ids?: string[]): void {
	const doc = v.session.doc;
	const tops = ids ? ids.map((id) => indexNodes(doc.root).get(id)?.node).filter((n): n is MapNode => !!n) : topSelected(v);
	const targets = tops.filter((n) => n !== doc.root);
	if (targets.length === 0) return;
	const index = indexNodes(doc.root);
	const first = targets[0];
	const removed = new Set(targets.map((n) => n.id));
	let after: string | null = null;
	if (first) {
		const parent = index.get(first.id)?.parent;
		const sibs = parent?.children ?? [];
		const at = sibs.indexOf(first);
		const prev = sibs.slice(0, at).reverse().find((s) => !removed.has(s.id));
		const next = sibs.slice(at + 1).find((s) => !removed.has(s.id));
		after = prev?.id ?? next?.id ?? parent?.id ?? null;
	}
	v.runSteps(
		step((d) => {
			const result = deleteNodes(d, targets.map((n) => n.id));
			return result ? { result } : null;
		}),
		{ reveal: false, select: (_d, _a, id) => (after ? { ids: [id(after)], primary: id(after) } : { ids: [], primary: null }) },
	);
}

/** Move left/right by screen side (spec 2.2): outdent towards the root, indent away from it. */
function moveSide(v: MapView, arrow: 'left' | 'right'): void {
	const node = primaryNode(v);
	if (!node) {
		v.select([v.session.doc.root.id], v.session.doc.root.id);
		return;
	}
	if (node === v.session.doc.root) return;
	const side = sidesOf(v.session.doc.root, v.direction()).get(node.id);
	const outdent = (side === 'right' && arrow === 'left') || (side === 'left' && arrow === 'right');
	moveBy(v, outdent ? 'outdent' : 'indent');
}

function moveBy(v: MapView, how: 'up' | 'down' | 'indent' | 'outdent'): void {
	const node = primaryNode(v);
	if (!node || node === v.session.doc.root) return;
	const doc = v.session.doc;
	const index = indexNodes(doc.root);
	const parent = index.get(node.id)?.parent;
	if (!parent) return;
	const at = parent.children.indexOf(node);
	const ok = v.runSteps(step((d) => {
		let result = null;
		if (how === 'up') result = moveUp(d, node.id);
		else if (how === 'down') result = moveDown(d, node.id);
		else if (how === 'indent') {
			const prev = parent.children[at - 1];
			if (prev) result = moveNodes(d, [node.id], { parentId: prev.id, index: prev.children.length });
		} else {
			const grand = index.get(parent.id)?.parent;
			if (grand) result = moveNodes(d, [node.id], { parentId: grand.id, index: grand.children.indexOf(parent) + 1 });
		}
		return result ? { result, keep: [node.id] } : null;
	}), { select: (_d, _a, id) => ({ ids: [id(node.id)], primary: id(node.id) }) });
	if (ok && v.plugin.settings.focusOnMove) v.centerOnPrimary();
	else if (ok) v.revealPrimary();
}

/** Bold/italic/highlight/strike (spec 2.2). */
function format(v: MapView, marker: string): void {
	const handle = v.editingHandle();
	if (handle) {
		handle.toggleWrap(marker);
		return;
	}
	const nodes = v.selectedInOrder();
	if (nodes.length === 0) return;
	v.runSteps(textSteps(nodes, (t) => toggleWrap(t, marker)), { select: keepSelection(v.session) });
}

function textSteps(nodes: readonly MapNode[], change: (text: string) => string): StepFn[] {
	return nodes.map((n) => (d, id) => {
		const cur = indexNodes(d.root).get(id(n.id))?.node;
		if (!cur) return null;
		const value = change(cur.text);
		const result = setText(d, cur.id, value);
		return result ? { result, keep: [cur.id] } : null;
	});
}

/** Every selected node with children follows the primary (one undo step). */
function toggleCollapse(v: MapView): void {
	const sel = v.session.view.selection;
	const target = collapseToggleTarget(v.session.doc.root, v.session.view.collapsed, v.selectedInOrder(), sel.primary);
	if (target) v.setCollapsed(target);
}

export const COMMANDS: MapCommand[] = [
	{ id: 'Copy Node', name: 'Copy Node', need: 'selection', palette: true, run: (v) => void v.copySelection(false) },
	{ id: 'Cut Node', name: 'Cut Node', need: 'selection', palette: true, run: (v) => void v.copySelection(true) },
	{ id: 'Paste Node', name: 'Paste Node', need: 'selection', palette: true, run: (v) => void v.pasteClipboard() },
	{ id: 'Undo', name: 'Undo', need: 'map', palette: true, run: (v) => v.undo() },
	{ id: 'Redo', name: 'Redo', need: 'map', palette: true, run: (v) => v.redo() },
	// export (spec 2.2, 2.3): LQ = scale 1, plain = 2, HQ = 4
	{ id: 'Export to html', name: 'Export to html', need: 'map', palette: true, run: (v) => void v.exportImage('html', 1) },
	{ id: 'Export to JPEG (LQ)', name: 'Export to JPEG (LQ)', need: 'map', palette: true, run: (v) => void v.exportImage('jpeg', 1) },
	{ id: 'Export to PNG (LQ)', name: 'Export to PNG (LQ)', need: 'map', palette: true, run: (v) => void v.exportImage('png', 1) },
	{ id: 'Export to JPEG', name: 'Export to JPEG', need: 'map', palette: true, run: (v) => void v.exportImage('jpeg', 2) },
	{ id: 'Export to PNG', name: 'Export to PNG', need: 'map', palette: true, run: (v) => void v.exportImage('png', 2) },
	{ id: 'Export to JPEG (HQ)', name: 'Export to JPEG (HQ)', need: 'map', palette: true, run: (v) => void v.exportImage('jpeg', 4) },
	{ id: 'Export to PNG (HQ)', name: 'Export to PNG (HQ)', need: 'map', palette: true, run: (v) => void v.exportImage('png', 4) },
	{
		id: 'Replace by the previous text',
		name: 'Replace by the previous text',
		need: 'selection',
		palette: true,
		run: (v) => v.replaceByPreviousText(),
	},
	{ id: 'Edit node', name: 'Edit node', need: 'selection', palette: true, run: (v) => v.startEditPrimary('end') },
	{
		id: 'Add sibling/end editing',
		name: 'Add sibling/end editing',
		need: 'selection',
		palette: true,
		run: (v) => (v.isEditing() ? v.commitEdit() : addSibling(v)),
	},
	{ id: 'Insert child', name: 'Insert child', need: 'selection', palette: true, run: (v) => addChild(v) },
	{ id: 'insert-image', name: 'insert-image', need: 'selection', palette: true, run: (v) => v.insertImage() },
	{ id: 'Delete node & child', name: 'Delete node & child', need: 'selection', palette: true, run: (v) => deleteSelection(v) },
	{ id: "Select the node's text", name: "Select the node's text", need: 'selection', palette: true, run: (v) => v.startEditPrimary('all') },
	{ id: "Bold the node's text", name: "Bold the node's text", need: 'selection', palette: true, run: (v) => format(v, '**') },
	{ id: "Italicize the node's text", name: "Italicize the node's text", need: 'selection', palette: true, run: (v) => format(v, '*') },
	{ id: "Highlight the node's text", name: "Highlight the node's text", need: 'selection', palette: true, run: (v) => format(v, '==') },
	{ id: "Strike through the node's text", name: "Strike through the node's text", need: 'selection', palette: true, run: (v) => format(v, '~~') },
	{ id: 'Add tabulation', name: 'Add tabulation', need: 'editing', palette: true, run: (v) => v.editingHandle()?.insertText('    ') },
	{ id: 'Add line break (<br>)', name: 'Add line break (<br>)', need: 'editing', palette: true, run: (v) => v.editingHandle()?.insertText('\n') },
	{
		id: 'Remove line breaks (<br>)',
		name: 'Remove line breaks (<br>)',
		need: 'selection',
		palette: true,
		run: (v) => {
			const nodes = v.selectedInOrder();
			if (nodes.length > 0) v.runSteps(textSteps(nodes, removeLineBreaks), { select: keepSelection(v.session) });
		},
	},
	{ id: 'Cancel edit', name: 'Cancel edit', need: 'editing', palette: true, run: (v) => v.cancelEdit() },
	{
		id: 'Expand one level',
		name: 'Expand one level',
		need: 'selection',
		palette: true,
		run: (v) => {
			const id = v.session.view.selection.primary;
			const t = id === null ? null : levelFromNode(v.session.doc.root, v.session.view.collapsed, id, 1);
			if (t) v.setCollapsed(t);
		},
	},
	{
		id: 'Expand one level from the max. displayed level',
		name: 'Expand one level from the max. displayed level',
		need: 'selection',
		palette: true,
		run: (v) => {
			const id = v.session.view.selection.primary;
			const t = id === null ? null : levelInSubtree(v.session.doc, v.session.view, id, 1);
			if (t) v.setCollapsed(t);
		},
	},
	{
		id: 'Collapse one level',
		name: 'Collapse one level',
		need: 'selection',
		palette: true,
		run: (v) => {
			const id = v.session.view.selection.primary;
			const t = id === null ? null : levelFromNode(v.session.doc.root, v.session.view.collapsed, id, -1);
			if (t) v.setCollapsed(t);
		},
	},
	{
		id: 'Collapse one level from the max. displayed level',
		name: 'Collapse one level from the max. displayed level',
		need: 'selection',
		palette: true,
		run: (v) => {
			const id = v.session.view.selection.primary;
			const t = id === null ? null : levelInSubtree(v.session.doc, v.session.view, id, -1);
			if (t) v.setCollapsed(t);
		},
	},
	{ id: 'Toggle expand/collapse node', name: 'Toggle expand/collapse node', need: 'selection', palette: true, run: toggleCollapse },
	{ id: 'Move the current node above', name: 'Move the current node above', need: 'selection', palette: true, run: (v) => moveBy(v, 'up') },
	{ id: 'Move the current node below', name: 'Move the current node below', need: 'selection', palette: true, run: (v) => moveBy(v, 'down') },
	{ id: 'Move the current node left', name: 'Move the current node left', need: 'selection', palette: true, run: (v) => moveSide(v, 'left') },
	{ id: 'Move the current node right', name: 'Move the current node right', need: 'selection', palette: true, run: (v) => moveSide(v, 'right') },
	{
		id: 'Move next siblings as children',
		name: 'Move next siblings as children',
		need: 'selection',
		palette: true,
		run: (v) => adopt(v, 'next'),
	},
	{
		id: 'Move all siblings as children',
		name: 'Move all siblings as children',
		need: 'selection',
		palette: true,
		run: (v) => adopt(v, 'all'),
	},
	{ id: 'Join with the node below', name: 'Join with the node below', need: 'selection', palette: true, run: (v) => join(v, false) },
	{
		id: 'Join as citation with the node below',
		name: 'Join as citation with the node below',
		need: 'selection',
		palette: true,
		run: (v) => join(v, true),
	},
	{
		id: 'Center mindmap view on the current node',
		name: 'Center mindmap view on the current node',
		need: 'selection',
		palette: true,
		run: (v) => v.centerOnPrimary(),
	},
	{ id: 'Center mindmap view', name: 'Center mindmap view', need: 'map', palette: true, run: (v) => v.renderer?.centerOn(v.session.doc.root.id) },
	{ id: 'Zoom in', name: 'Zoom in', need: 'map', palette: true, run: (v) => v.renderer?.zoomBy(1.2) },
	{ id: 'Zoom out', name: 'Zoom out', need: 'map', palette: true, run: (v) => v.renderer?.zoomBy(1 / 1.2) },
	{ id: 'Search mindmap nodes', name: 'Search nodes', need: 'map', palette: true, run: (v) => v.openSearch() },
	...[1, 2, 3, 4, 5, 6].map(
		(n): MapCommand => ({
			id: `collapse-to-level-${n}`,
			name: 'collapse-to-level',
			nameArg: n,
			need: 'map',
			palette: true,
			run: (v) => v.setCollapsed(showToLevel(v.session.doc.root, v.session.view.collapsed, n)),
		}),
	),
	{ id: 'expand-all', name: 'expand-all', need: 'map', palette: true, run: (v) => v.setCollapsed(new Set()) },
	{ id: 'fit-view', name: 'fit-view', need: 'map', palette: true, run: (v) => v.renderer?.fit() },

	// Map keys without a palette command of their own (spec 3).
	{ id: 'key:add-sibling', name: 'Add sibling/end editing', need: 'map', palette: false, run: (v) => addSibling(v) },
	{ id: 'key:add-child', name: 'Insert child', need: 'map', palette: false, run: (v) => addChild(v) },
	{ id: 'key:outdent', name: 'Move the current node left', need: 'selection', palette: false, run: (v) => moveBy(v, 'outdent') },
	{ id: 'key:indent', name: 'Move the current node right', need: 'selection', palette: false, run: (v) => moveBy(v, 'indent') },
	{
		id: 'key:select-all',
		name: 'Center mindmap view',
		need: 'map',
		palette: false,
		run: (v) => {
			const next = selectAllVisible(v.session.doc.root, v.session.view);
			v.select([...next.selection.ids], next.selection.primary);
		},
	},
	{
		id: 'key:home',
		name: 'Center mindmap view',
		need: 'map',
		palette: false,
		run: (v) => {
			const root = v.session.doc.root.id;
			v.select([root], root);
			v.renderer?.centerOn(root);
		},
	},
	{ id: 'key:focus', name: 'Focus node', need: 'map', palette: false, run: (v) => v.toggleFocus() },
	{ id: 'key:escape', name: 'Cancel edit', need: 'map', palette: false, run: (v) => v.escape() },
];

function adopt(v: MapView, which: 'next' | 'all'): void {
	const node = primaryNode(v);
	if (!node) return;
	const sibs = indexNodes(v.session.doc.root).get(node.id)?.parent?.children ?? [];
	const at = sibs.indexOf(node);
	const others = sibs.filter((c, i) => c !== node && (which === 'all' || i > at)).map((c) => c.id);
	v.runSteps(
		step((d) => {
			const result = adoptSiblings(d, node.id, which);
			return result ? { result, keep: others } : null;
		}),
		{ select: (_d, _a, id) => ({ ids: [id(node.id)], primary: id(node.id) }) },
	);
}

function join(v: MapView, citation: boolean): void {
	const node = primaryNode(v);
	if (!node) return;
	const steps = joinSteps(v.session.doc, node.id, citation);
	if (steps) v.runSteps(steps, { reveal: false, select: (_d, _a, id) => ({ ids: [id(node.id)], primary: id(node.id) }) });
}

export const COMMAND_BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

/** Whether `command` can run in `view` now. */
export function available(command: MapCommand, view: MapView): boolean {
	if (!view.canEdit()) return false;
	if (command.need === 'editing') return view.isEditing();
	if (command.need === 'selection') return view.session.view.selection.primary !== null || view.isEditing();
	return true;
}

/** Run a command by id in `view`; false when unknown or unavailable. */
export function runCommand(view: MapView, id: string): boolean {
	const command = COMMAND_BY_ID.get(id);
	if (!command || !available(command, view)) return false;
	command.run(view);
	return true;
}
