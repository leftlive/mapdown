// Markdown outline writer shared by the live map and the importers, so an
// imported note is written exactly as the map would save it.
import type { MapNode } from './types.ts';

export type LineEnding = '\n' | '\r\n';

export interface OutlineSource<T> {
	children(node: T): T[];
	text(node: T): string;
	// Block id written as ` ^id` ('' for none).
	blockId(node: T): string;
	// Body lines [start, end) the node was written to.
	written?(node: T, range: { start: number; end: number }): void;
}

const CODE_FENCE = /^(`{3,}|~{3,})/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function clampHeadLevel(value: unknown): number {
	const level = Number(value);
	return Number.isNaN(level) ? 1 : Math.max(0, Math.min(6, Math.trunc(level)));
}

// A table: the first line starts with `|` and the second is a delimiter row.
function isTable(text: string): boolean {
	const lines = text.split('\n');
	return lines.length >= 2 && lines[0].startsWith('|') && TABLE_DELIMITER.test(lines[1]);
}

function forEachWithDepth<T>(root: T, source: OutlineSource<T>, visit: (node: T, depth: number) => void): void {
	const recurse = (node: T, depth: number): void => {
		visit(node, depth);
		source.children(node).forEach((c) => recurse(c, depth + 1));
	};
	recurse(root, 0);
}

export function writeOutline<T>(
	root: T,
	headLevel: unknown,
	source: OutlineSource<T>,
	lineEnding: LineEnding = '\n',
): string {
	const eol = lineEnding;
	let md = '';
	let level = clampHeadLevel(headLevel);
	// A code block can only be written as a list item, so headings stop above it.
	forEachWithDepth(root, source, (node, depth) => {
		if (CODE_FENCE.test(source.text(node).trim())) {
			level = Math.min(level, depth);
		}
	});
	// Likewise a table with an earlier sibling: raw under a heading it would read back as that sibling's child.
	const lowerForTables = (node: T, depth: number): void => {
		source.children(node).forEach((child, i) => {
			if (i > 0 && isTable(source.text(child).trim())) {
				level = Math.min(level, depth + 1);
			}
			lowerForTables(child, depth + 1);
		});
	};
	lowerForTables(root, 0);
	let lineCount = 0;
	// A table written at heading depth is followed by a blank line.
	let blankBefore = false;
	const countLines = (text: string): number => (text.match(/\n/g) || []).length;
	forEachWithDepth(root, source, (n, depth) => {
		const l = depth + 1;
		const blockId = source.blockId(n);
		const ending = blockId ? ` ^${blockId}` : '';
		const text = source.text(n).trim();
		const table = isTable(text);
		const isHeading = depth < level;

		const chunkStart = md.length;
		if (md && ((isHeading && l > 1) || blankBefore) && !md.endsWith(eol + eol)) {
			md += eol;
		}
		blankBefore = false;

		if (isHeading && table) {
			md += text.split('\n').join(eol) + eol;
			if (blockId) {
				md += `^${blockId}${eol}`;
			}
			blankBefore = true;
		} else if (isHeading) {
			md += '#'.repeat(l) + ' ' + text.replace(/\n/g, '<br>') + ending + eol;
		} else {
			const space = '    '.repeat(depth - level);
			// `- > quote` would swallow the next items as continuation lines.
			const item = text.startsWith('>') ? `\\${text}` : text;
			if (!text) {
				// An empty node keeps its block id (contract 4.8.3: ids are never dropped).
				md += `${space}-${ending}${eol}`;
			} else if (table || CODE_FENCE.test(text)) {
				// Table rows sit 4 spaces in, code lines 2; the block id follows the block.
				const pad = table ? '    ' : '  ';
				md += `${space}-${eol}`;
				text.split('\n').forEach((line) => {
					md += `${space}${pad}${line}${eol}`;
				});
				if (blockId) {
					md += `${space}${pad}^${blockId}${eol}`;
				}
			} else if (!text.includes('\n')) {
				md += `${space}- ${item}${ending}${eol}`;
			} else {
				md += `${space}- ${item.replace(/\n/g, '<br>')}${ending}${eol}`;
			}
		}
		const chunk = md.slice(chunkStart);
		const leadingBlankLines = countLines(chunk) - countLines(chunk.replace(/^(\r?\n)+/, ''));
		source.written?.(n, {
			start: lineCount + leadingBlankLines,
			end: lineCount + countLines(chunk),
		});
		lineCount += countLines(chunk);
	});
	return md.trim();
}

// Collapsed block ids in breadth-first order, as saved in `mindmark-state`.
export function collapsedIdsBreadthFirst<T>(root: T, source: OutlineSource<T>, isCollapsed: (node: T) => boolean): string[] {
	const ids: string[] = [];
	const queue: T[] = [root];
	for (let i = 0; i < queue.length; i++) {
		const node = queue[i];
		if (isCollapsed(node)) {
			ids.push(source.blockId(node));
		}
		queue.push(...source.children(node));
	}
	return ids;
}

const MAP_SOURCE: OutlineSource<MapNode> = {
	children: (node) => node.children,
	text: (node) => node.text,
	blockId: (node) => node.blockId ?? '',
};

export function writeMapOutline(root: MapNode, headLevel: number, lineEnding: LineEnding): string {
	return writeOutline(root, headLevel, MAP_SOURCE, lineEnding);
}
