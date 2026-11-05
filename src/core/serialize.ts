// Text encoding and the writer for nodes newly written into an existing
// document (format contract section 6). Whole documents are written by
// outline.ts; this module adapts that writer's output to one position inside
// a document: a heading level offset, or a list indent and marker that follow
// the neighbouring siblings.

import { clampHeadLevel, writeMapOutline, writeOutline, type LineEnding, type OutlineSource } from './outline.ts';
import type { MapNode } from './types.ts';

/** The line kinds a node's text can be written into. */
export type TextKind = 'heading' | 'list' | 'paragraph';

/** A node that does not exist in the document yet. */
export interface NewNode {
	text: string;
	blockId: string | null;
	children: NewNode[];
}

/**
 * How the top node of a written subtree is placed: a heading of a given
 * level, or a list item with an exact indent string and marker. Descendants
 * follow section 6 relative to it.
 */
export type Form = { kind: 'heading'; level: number } | { kind: 'list'; indent: string; marker: string };

export interface WriteContext {
	/** The `headLevel` setting (contract section 5). */
	headLevel: number;
	/** Tree depth of the top node (the root is 0). */
	depth: number;
	eol: LineEnding;
}

export interface Written {
	/** Lines joined with `eol`, without a final line break. */
	text: string;
	/** The node written last (document order), and whether it became a heading. */
	last: NewNode;
	lastIsHeading: boolean;
}

const CODE_FENCE = /^(`{3,}|~{3,})/;
const TABLE_DELIMITER_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Text that is a fenced code block (written as `-` plus indented lines, never as a heading). */
export function isCodeText(text: string): boolean {
	return CODE_FENCE.test(text.trim());
}

/** Text that is a Markdown table (same test as the outline writer). */
export function isTableText(text: string): boolean {
	const lines = text.trim().split('\n');
	return lines.length >= 2 && (lines[0] ?? '').startsWith('|') && TABLE_DELIMITER_ROW.test(lines[1] ?? '');
}

export function isBlockText(text: string): boolean {
	return isCodeText(text) || isTableText(text);
}

/**
 * Node text as it is written inside one line: line breaks become `<br>`, and
 * a list item starting with `>` is escaped as `\>` so it is not read as a
 * quote (contract 6.3). Surrounding whitespace is dropped; the parser would
 * drop it anyway.
 */
export function encodeText(text: string, kind: TextKind): string {
	const s = text.replace(/\r/g, '').trim().replace(/\n/g, '<br>');
	return kind === 'list' && s.startsWith('>') ? `\\${s}` : s;
}

export function blockIdSuffix(blockId: string | null): string {
	return blockId ? ` ^${blockId}` : '';
}

/** `## text ^id`; an empty heading is just the hashes. */
export function headingLine(level: number, text: string, blockId: string | null): string {
	const enc = encodeText(text, 'heading');
	return '#'.repeat(level) + (enc ? ` ${enc}` : '') + blockIdSuffix(blockId);
}

/** `<indent><marker> text ^id`; an empty item is just the marker. */
export function listLine(indent: string, marker: string, text: string, blockId: string | null): string {
	const enc = encodeText(text, 'list');
	return indent + marker + (enc ? ` ${enc}` : '') + blockIdSuffix(blockId);
}

/** The marker for the item after one with `marker`: `3.` after `2.`, else the same bullet. */
export function nextListMarker(marker: string): string {
	const m = /^(\d+)([.)])$/.exec(marker);
	return m ? `${Number(m[1]) + 1}${m[2] ?? '.'}` : marker;
}

/**
 * Write `node` and its subtree for insertion at a position whose top form is
 * already decided. Delegates to the outline writer (section 6) and shifts its
 * output: heading levels by `form.level - 1`, list lines by `form.indent`.
 * Returns null when the form is impossible: a code block or table cannot be
 * a heading (6.4).
 */
export function writeSubtree(node: NewNode, form: Form, ctx: WriteContext): Written | null {
	const starts: { line: number; node: NewNode }[] = [];
	const source: OutlineSource<NewNode> = {
		children: (n) => n.children,
		text: (n) => n.text,
		blockId: (n) => n.blockId ?? '',
		written: (n, range) => starts.push({ line: range.start, node: n }),
	};
	const eol = ctx.eol;
	let lines: string[];
	if (form.kind === 'heading') {
		if (isBlockText(node.text)) return null;
		// Descendants at depth < headLevel are headings too, but never deeper than 6.
		const rel = Math.max(1, Math.min(clampHeadLevel(ctx.headLevel) - ctx.depth, 7 - form.level));
		lines = writeOutline(node, rel, source, eol).split(eol);
		const extra = '#'.repeat(form.level - 1);
		for (const s of starts) {
			const line = lines[s.line];
			if (line !== undefined && line.startsWith('#')) lines[s.line] = extra + line;
		}
	} else {
		lines = writeOutline(node, 0, source, eol).split(eol);
		const first = lines[0] ?? '-';
		if (form.marker !== '-' && !isBlockText(node.text)) lines[0] = form.marker + first.slice(1);
		lines = lines.map((l) => (l.trim() === '' ? l : form.indent + l));
	}
	const last = starts[starts.length - 1] ?? { line: 0, node };
	return {
		text: lines.join(eol),
		last: last.node,
		lastIsHeading: (lines[last.line] ?? '').startsWith('#'),
	};
}

/** Write one node without its children (see writeSubtree). */
export function writeNode(node: NewNode, form: Form, ctx: WriteContext): Written | null {
	return writeSubtree({ ...node, children: [] }, form, ctx);
}

/**
 * Whole-document body generation (save as new map, converting a plain note,
 * clipboard outline). Kept in outline.ts so importers share it.
 */
export function writeDocumentBody(root: MapNode, headLevel: number, eol: LineEnding): string {
	return writeMapOutline(root, headLevel, eol);
}
