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
}

/** In the order of spec 5.11. */
export const MULTI_ACTIONS: readonly MultiAction[] = [
	{ action: "make-tasks", icon: "list-checks", label: "multi-make-tasks", command: "key:make-tasks" },
	{ action: "bold", icon: "bold", label: "multi-bold", command: "Bold the node's text" },
	{ action: "highlight", icon: "highlighter", label: "multi-highlight", command: "Highlight the node's text" },
	{ action: "fold", icon: "chevrons-down-up", label: "multi-fold", command: "key:fold-selection" },
	{ action: "copy", icon: "copy", label: "multi-copy", command: "Copy Node" },
	{ action: "cut", icon: "scissors", label: "multi-cut", command: "Cut Node" },
	{ action: "delete", icon: "trash-2", label: "multi-delete", command: "Delete node & child" },
];

/** The multi-selection actions apply from two selected nodes on. */
export const isMultiSelection = (ids: readonly string[]): boolean => ids.length >= 2;
