// Task list items (behaviour spec 5.9): which nodes are tasks, what they show,
// how toggling changes their text, and the "done/total" progress of every node
// over all of its descendants. Pure; the text keeps `[ ]` and `[x]` (format
// contract 4.3), only the display and the toggle operation know about them.

import type { MapNode, NodeKind } from './types.ts';

export interface TaskMark {
	/** Anything but a space inside the brackets counts as done (like Obsidian). */
	done: boolean;
	/** The character inside the brackets (one code point). */
	char: string;
	/** Length of `[c]` plus the one following space, if any: what the checkbox replaces. */
	length: number;
}

/** `[` + one character + `]`, followed by whitespace or the end of the text. */
const TASK = /^\[([^\n\r])\](?=\s|$)/u;

/** The task marker of a node's text; null for non-tasks and for nodes that are not list items. */
export function taskOf(text: string, kind: NodeKind): TaskMark | null {
	if (kind !== 'list') return null;
	const m = TASK.exec(text);
	if (!m) return null;
	const char = m[1] ?? ' ';
	const next = text[m[0].length];
	return { done: char !== ' ', char, length: m[0].length + (next === ' ' || next === '\t' ? 1 : 0) };
}

/** The text a node shows: a task's marker and the space after it are drawn as a checkbox instead. */
export function taskDisplayText(text: string, kind: NodeKind): string {
	const t = taskOf(text, kind);
	return t ? text.slice(t.length) : text;
}

/** The text after "toggle task": not a task gets `[ ] `, open becomes `[x]`, done becomes `[ ]`. */
export function toggleTaskText(text: string): string {
	const t = taskOf(text, 'list');
	if (!t) return text === '' ? '[ ]' : `[ ] ${text}`;
	return `[${t.done ? ' ' : 'x'}]${text.slice(2 + t.char.length)}`;
}

/**
 * What "make tasks" (spec 5.11) does with a node: `add` a marker (a list item
 * that is no task yet, or a paragraph that becomes a list-item task), nothing
 * because it is a `task` already (open or done), or `skip` it (headings, quoted
 * paragraphs, code, tables, the root).
 */
export function makeTaskKind(node: Pick<MapNode, 'kind' | 'text' | 'source'>): 'add' | 'task' | 'skip' {
	if (!node.source) return 'skip';
	if (node.kind === 'list') return taskOf(node.text, 'list') ? 'task' : 'add';
	if (node.kind === 'paragraph' && !node.text.startsWith('>')) return 'add';
	return 'skip';
}

export interface TaskCount {
	done: number;
	total: number;
}

/**
 * Task counts over all descendants (any depth, collapsed branches included,
 * the node itself excluded), for every node that has at least one task below
 * it. One pass over the tree.
 */
export function taskProgress(root: MapNode): Map<string, TaskCount> {
	const out = new Map<string, TaskCount>();
	// iterative post-order: maps can be deep enough to overflow recursion
	const stack: { node: MapNode; next: number; done: number; total: number }[] = [{ node: root, next: 0, done: 0, total: 0 }];
	while (stack.length > 0) {
		const top = stack[stack.length - 1];
		const child = top.node.children[top.next];
		if (child) {
			top.next++;
			stack.push({ node: child, next: 0, done: 0, total: 0 });
			continue;
		}
		stack.pop();
		if (top.total > 0) out.set(top.node.id, { done: top.done, total: top.total });
		const parent = stack[stack.length - 1];
		if (!parent) continue;
		const own = taskOf(top.node.text, top.node.kind);
		parent.done += top.done + (own?.done ? 1 : 0);
		parent.total += top.total + (own ? 1 : 0);
	}
	return out;
}
