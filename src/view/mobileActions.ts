// Table and geometry of the node toolbar (see mobileToolbar.ts). Pure, so unit tests can load it.

import type { StringKey } from "../i18n.ts";

export interface MobileAction {
	/** The button's `data-action`. */
	action: string;
	icon: string;
	label: StringKey;
	/** Id of the command the button runs. */
	command: string;
}

export const MOBILE_ACTIONS: readonly MobileAction[] = [
	{ action: "add-child", icon: "corner-down-right", label: "Insert child", command: "Insert child" },
	{ action: "add-sibling", icon: "plus", label: "Add sibling/end editing", command: "key:add-sibling" },
	{ action: "edit", icon: "pencil", label: "Edit node", command: "Edit node" },
	{ action: "delete", icon: "trash-2", label: "Delete node & child", command: "Delete node & child" },
	{ action: "promote", icon: "outdent", label: "Promote node", command: "key:outdent" },
	{ action: "demote", icon: "indent", label: "Demote node", command: "key:indent" },
	{ action: "move-up", icon: "arrow-up", label: "Move the current node above", command: "Move the current node above" },
	{ action: "move-down", icon: "arrow-down", label: "Move the current node below", command: "Move the current node below" },
	{ action: "toggle-collapse", icon: "chevrons-down-up", label: "Toggle expand/collapse node", command: "Toggle expand/collapse node" },
	{ action: "insert-image", icon: "image-plus", label: "insert-image", command: "insert-image" },
	{ action: "undo", icon: "undo-2", label: "Undo", command: "Undo" },
	{ action: "redo", icon: "redo-2", label: "Redo", command: "Redo" },
];

/** How far the soft keyboard reaches up into a view whose bottom edge is at `viewBottom` (client px). */
export function keyboardInset(viewBottom: number, viewportTop: number, viewportHeight: number): number {
	return Math.max(0, Math.round(viewBottom - (viewportTop + viewportHeight)));
}
