// The map's single key table (behaviour spec 3), registered on the view's
// Obsidian Scope. A Scope is active only while its view has focus, so these
// keys never reach the Markdown editor or other views, and keys typed in an
// editor never reach the map.
//
// A handler returns false to consume the key (Obsidian then prevents the
// default) and true to let it through to the focused element; the latter is
// how keys behave while a node is being edited, apart from the few that the
// spec keeps active there (Enter/Tab commit, Esc cancels, five formatting
// combos). Arrow keys act on key-up (0.3.0 behaviour): key-down only arms them.

import type { Modifier, Scope } from 'obsidian';
import type { Arrow } from './controller/actions.ts';

export interface KeyTarget {
	isEditing(): boolean;
	/** True while an IME composition is running (no map key may fire). */
	isComposing(evt: KeyboardEvent): boolean;
	run(commandId: string): void;
	commitEdit(): void;
	escape(): void;
	armArrow(arrow: Arrow): void;
}

type Action = string | ((t: KeyTarget) => void);

export interface KeyBinding {
	mods: Modifier[];
	/** Key values; Obsidian also matches the layout-independent key from `code`. */
	keys: string[];
	action: Action;
	/** Also active while a node is being edited. */
	editing?: boolean;
}

const enterOrSibling = (t: KeyTarget): void => (t.isEditing() ? t.commitEdit() : t.run('key:add-sibling'));
const lineBreakOrNothing = (t: KeyTarget): void => {
	if (t.isEditing()) t.run('Add line break (<br>)');
};
const tabOrChild = (t: KeyTarget): void => (t.isEditing() ? t.commitEdit() : t.run('key:add-child'));

export const KEY_TABLE: readonly KeyBinding[] = [
	// 3.1, from 0.3.0
	{ mods: [], keys: [' ', 'Space'], action: 'Edit node' },
	{ mods: [], keys: ['F2'], action: 'Edit node' },
	{ mods: [], keys: ['Enter'], action: enterOrSibling, editing: true },
	{ mods: ['Shift'], keys: ['Enter'], action: lineBreakOrNothing, editing: true },
	{ mods: ['Mod'], keys: ['Enter'], action: lineBreakOrNothing, editing: true },
	{ mods: [], keys: ['Tab', 'Insert'], action: tabOrChild, editing: true },
	{ mods: [], keys: ['Delete', 'Backspace'], action: 'Delete node & child' },
	{ mods: [], keys: ['Escape'], action: (t) => t.escape(), editing: true },
	{ mods: [], keys: ['F'], action: 'key:focus' },
	{ mods: [], keys: ['ArrowUp'], action: (t) => t.armArrow('up') },
	{ mods: [], keys: ['ArrowDown'], action: (t) => t.armArrow('down') },
	{ mods: [], keys: ['ArrowLeft'], action: (t) => t.armArrow('left') },
	{ mods: [], keys: ['ArrowRight'], action: (t) => t.armArrow('right') },
	{ mods: [], keys: ['Home'], action: 'key:home' },
	{ mods: ['Mod'], keys: ['Home'], action: 'key:home' },
	{ mods: ['Mod'], keys: ['Z'], action: 'Undo' },
	{ mods: ['Mod'], keys: ['Y'], action: 'Redo' },
	{ mods: ['Mod', 'Shift'], keys: ['Z'], action: 'Redo' },
	{ mods: ['Mod'], keys: ['A'], action: 'key:select-all' },
	{ mods: ['Mod'], keys: ['C'], action: 'Copy Node' },
	{ mods: ['Mod'], keys: ['X'], action: 'Cut Node' },
	{ mods: ['Mod'], keys: ['V'], action: 'Paste Node' },
	{ mods: ['Shift'], keys: ['Tab'], action: 'key:outdent' },

	// 3.2, the 24 former command hotkeys
	{ mods: ['Shift'], keys: ['F2'], action: 'Edit node' },
	{ mods: ['Shift'], keys: ['Delete'], action: 'Delete node & child' },
	{ mods: ['Alt', 'Shift'], keys: ['B'], action: "Bold the node's text", editing: true },
	{ mods: ['Alt', 'Shift'], keys: ['I'], action: "Italicize the node's text", editing: true },
	{ mods: ['Alt', 'Shift'], keys: ['H'], action: "Highlight the node's text", editing: true },
	{ mods: ['Alt', 'Shift'], keys: ['T'], action: 'Add tabulation', editing: true },
	{ mods: ['Alt', 'Ctrl', 'Shift'], keys: ['L'], action: 'Add line break (<br>)', editing: true },
	{ mods: ['Alt', 'Shift'], keys: ['L'], action: 'Remove line breaks (<br>)' },
	{ mods: ['Alt'], keys: ['ArrowDown'], action: 'Expand one level' },
	{ mods: ['Alt'], keys: ['PageDown'], action: 'Expand one level from the max. displayed level' },
	{ mods: ['Alt'], keys: ['ArrowUp'], action: 'Collapse one level' },
	{ mods: ['Alt'], keys: ['PageUp'], action: 'Collapse one level from the max. displayed level' },
	{ mods: ['Mod', 'Shift'], keys: [' ', 'Space'], action: 'Toggle expand/collapse node' },
	{ mods: ['Alt', 'Shift'], keys: ['ArrowUp'], action: 'Move the current node above' },
	{ mods: ['Alt', 'Shift'], keys: ['ArrowDown'], action: 'Move the current node below' },
	{ mods: ['Alt', 'Shift'], keys: ['ArrowLeft'], action: 'Move the current node left' },
	{ mods: ['Alt', 'Shift'], keys: ['ArrowRight'], action: 'Move the current node right' },
	{ mods: ['Alt', 'Shift'], keys: ['D'], action: 'Move next siblings as children' },
	{ mods: ['Alt', 'Ctrl', 'Shift'], keys: ['D'], action: 'Move all siblings as children' },
	{ mods: ['Alt', 'Shift'], keys: ['J'], action: 'Join with the node below' },
	{ mods: ['Alt', 'Ctrl', 'Shift'], keys: ['J'], action: 'Join as citation with the node below' },
	{ mods: ['Alt'], keys: ['E'], action: 'Center mindmap view on the current node' },
	{ mods: ['Alt'], keys: ['='], action: 'Zoom in' },
	{ mods: ['Alt'], keys: ['-'], action: 'Zoom out' },

	// 3.3, new
	...[1, 2, 3, 4, 5, 6].map((n): KeyBinding => ({ mods: ['Alt'], keys: [String(n)], action: `collapse-to-level-${n}` })),
];

/** Register every binding of the table on `scope`. */
export function installKeymap(scope: Scope, target: KeyTarget): void {
	for (const binding of KEY_TABLE) {
		const handler = (evt: KeyboardEvent): boolean => {
			if (evt.isComposing || target.isComposing(evt)) return true;
			if (target.isEditing() && !binding.editing) return true;
			if (typeof binding.action === 'string') target.run(binding.action);
			else binding.action(target);
			return false;
		};
		for (const key of binding.keys) scope.register(binding.mods, key, handler);
	}
}
