// The buttons of the multi-selection actions (behaviour spec 5.11): one table
// for the floating bar, the right-click menu on a multi-selection and the
// touch node toolbar's multi-selection set. Every button runs an existing
// command (development plan 3.5). Pure, so unit tests can load it.

import type { StringKey } from "../i18n.ts";

export interface MultiAction {
	/** The button's `data-action`. */
	action: string;
	icon: string;
	/** Hover tooltip (the button shows only its icon). */
	label: StringKey;
	/** Id of the command the button runs. */
	command: string;
	/** Opens the marker palette (spec 5.14) below the bar or menu holding the button, instead of running `command` there. */
	opensPalette?: boolean;
	/** Usable only while the selection is adjacent siblings that can take a summary (spec 5.15); greyed otherwise. */
	needsSiblings?: boolean;
}

/** In the order of spec 5.11. */
export const MULTI_ACTIONS: readonly MultiAction[] = [
	{ action: "make-tasks", icon: "list-checks", label: "multi-make-tasks", command: "key:make-tasks" },
	{ action: "bold", icon: "bold", label: "multi-bold", command: "Bold the node's text" },
	{ action: "highlight", icon: "highlighter", label: "multi-highlight", command: "Highlight the node's text" },
	{ action: "quote", icon: "quote", label: "multi-quote", command: "toggle-quote" },
	{ action: "markers", icon: "smile-plus", label: "markers", command: "open-markers", opensPalette: true },
	{ action: "summary", icon: "brackets", label: "summary", command: "add-summary", needsSiblings: true },
	{ action: "frame", icon: "square-dashed", label: "frame", command: "toggle-frame" },
	{ action: "fold", icon: "chevrons-down-up", label: "multi-fold", command: "key:fold-selection" },
	{ action: "copy", icon: "copy", label: "multi-copy", command: "Copy Node" },
	{ action: "cut", icon: "scissors", label: "multi-cut", command: "Cut Node" },
	{ action: "delete", icon: "trash-2", label: "multi-delete", command: "Delete node & child" },
];

/**
 * Whether button `a` is usable. `siblings`: the selection is adjacent siblings
 * that can take a summary (summaryRefusal is not "siblings"). A selection a
 * summary already covers keeps the button usable: running it says why it does nothing.
 */
export function multiActionEnabled(a: Pick<MultiAction, "needsSiblings">, siblings: boolean): boolean {
	return a.needsSiblings !== true || siblings;
}

/** The multi-selection actions apply from two selected nodes on. */
export const isMultiSelection = (ids: readonly string[]): boolean => ids.length >= 2;
