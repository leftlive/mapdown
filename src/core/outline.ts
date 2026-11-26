// Markdown outline writer shared by the live map and the importers, so an
// imported note is written exactly as the map would save it.
import { notesSuffix } from './summary.ts';
import type { MapNode } from './types.ts';

export type LineEnding = '\n' | '\r\n';

export interface OutlineSource<T> {
	children(node: T): T[];
	text(node: T): string;
	// Block id written as ` ^id` ('' for none).
	blockId(node: T): string;
	// Summary and frame comments written before the block id, with their leading space (contract 4.11.5); '' or absent for none.
	notes?(node: T): string;
	// Body lines [start, end) the node was written to.
	written?(node: T, range: { start: number; end: number }): void;
}

const CODE_FENCE = /^(`{3,}|~{3,})/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Text holding a closed `$$ ... $$` span that crosses lines (contract 6.3,
 * "multi-line formula"). An unclosed `$$` does not count.
 */
export function hasMultilineFormula(text: string): boolean {
	const spans = text.match(/\$\$[\s\S]*?\$\$/g);
	return !!spans && spans.some((s) => s.includes('\n'));
}

/** A quote (contract 6.3): non-empty text whose every line starts with `>`. */
export function isQuoteLines(text: string): boolean {
	return text !== '' && text.split('\n').every((l) => l.startsWith('>'));
}

/** Text written as real lines in list items and paragraphs, not joined with `<br>`: a multi-line formula or a multi-line quote. */
export function hasRealLines(text: string): boolean {
	return hasMultilineFormula(text) || (text.includes('\n') && isQuoteLines(text));
}

/** Text of a multi-line formula as real lines: `pad` in front of every line after the first. */
export function formulaLines(text: string, eol: string, pad: string): string {
	return text
		.replace(/\r/g, '')
		.split('\n')
		.map((l, i) => (i === 0 || l === '' ? l : pad + l))
		.join(eol);
}

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
		const text = source.text(n).trim();
		const table = isTable(text);
		// Code blocks and tables cannot carry summary or frame comments (4.11.1).
		const notes = table || CODE_FENCE.test(text) ? '' : (source.notes?.(n) ?? '');
		const ending = notes + (blockId ? ` ^${blockId}` : '');
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
			// a heading's comments go on their own line under it, so links and the outline never see them (4.11.6)
			const head = text.replace(/\n/g, '<br>');
			md += '#'.repeat(l) + (head || !notes ? ' ' + head : '') + (blockId ? ` ^${blockId}` : '') + eol;
			if (notes) md += notes.trim() + eol;
		} else {
			const space = '    '.repeat(depth - level);
			// A quote is written `- > text`; other text starting with `>` is escaped, else the first line would
			// be read as a quote and swallow the lines after it (contract 6.3).
			const item = text.startsWith('>') && !isQuoteLines(text) ? `\\${text}` : text;
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
				const multi = hasRealLines(text);
				md += `${space}- ${multi ? formulaLines(item, eol, space + '  ') : item.replace(/\n/g, '<br>')}${ending}${eol}`;
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
	notes: (node) => notesSuffix(node),
};

export function writeMapOutline(root: MapNode, headLevel: number, lineEnding: LineEnding): string {
	return writeOutline(root, headLevel, MAP_SOURCE, lineEnding);
}
