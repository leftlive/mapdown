// Range lines of summaries and frames in the Markdown views (behaviour spec
// 5.16 item 3): which lines each line covers. Computed from the parsed note
// with the map's own rules (parseDocument, planSummaries), so the Markdown
// views and the map always agree. Pure: no DOM, no Obsidian.

import { parseDocument } from './parse.ts';
import { planSummaries } from './summary.ts';
import type { MapNode, ParsedDoc } from './types.ts';

export interface NoteRange {
	kind: 'summary' | 'frame';
	/** 0-based lines, both included: a summary's covered nodes, a frame's node, each through its subtree's last line. */
	first: number;
	last: number;
	/** List nesting of the first node (0 for a top-level item, a heading or a paragraph). */
	level: number;
	/** Column of its list marker (heading and paragraph: its first column). */
	col: number;
	/** How deep ranges of the same kind and level nest inside this one (nested headings): each step pushes this line further left, so outer lines stand left of inner ones. */
	outer: number;
	/** The first node is a list item (the reading view marks its `li`), otherwise a block. */
	item: boolean;
	/** Ids of the nodes it covers (the framed node alone for a frame). */
	ids: string[];
	/** First line of each of those nodes (the reading view finds their `li` by it). */
	starts: number[];
}

/** Offsets to 0-based lines. */
function lineIndex(text: string): (offset: number) => number {
	const starts: number[] = [0];
	for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
	return (offset) => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if ((starts[mid] ?? 0) <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
}

/**
 * The range lines of a parsed map note, in document order of their first
 * line (outer ranges before the ranges they hold). Summaries follow
 * `planSummaries` over each parent's children in document order; the root's
 * children too (Markdown has no sides, so a two-sided map's split plays no
 * part). The root can have neither.
 */
export function noteRanges(doc: ParsedDoc): NoteRange[] {
	const lineOf = lineIndex(doc.text);
	const out: NoteRange[] = [];
	const start = (n: MapNode): number => lineOf(n.source?.range.from ?? 0);
	const end = (n: MapNode): number => {
		const to = n.source?.subtreeTo ?? n.source?.range.to ?? 0;
		// subtreeTo is the end of the last line (before its break)
		return lineOf(Math.max(n.source?.range.from ?? 0, to));
	};
	const col = (n: MapNode): number => {
		const from = n.source?.range.from ?? 0;
		let i = from;
		while (doc.text[i] === ' ' || doc.text[i] === '\t') i++;
		return i - from;
	};
	const visit = (node: MapNode, level: number): void => {
		const kids = node.children;
		const plan = planSummaries(kids.map((c) => c.summary));
		kids.forEach((c, i) => {
			const cover = plan.covers[i];
			if (cover) {
				const covered = kids.slice(cover.first, cover.last + 1);
				const head = covered[0];
				const tail = covered[covered.length - 1];
				if (head?.source && tail?.source) {
					out.push({ kind: 'summary', first: start(head), last: end(tail), level, col: col(head), outer: 0, item: !!head.source.list, ids: covered.map((x) => x.id), starts: covered.map(start) });
				}
			}
			if (c.frame && c.source) {
				out.push({ kind: 'frame', first: start(c), last: end(c), level, col: col(c), outer: 0, item: !!c.source.list, ids: [c.id], starts: [start(c)] });
			}
		});
		for (const c of kids) visit(c, c.kind === 'list' || c.source?.list ? level + 1 : level);
	};
	visit(doc.root, 0);
	out.sort((a, b) => a.first - b.first || b.last - a.last || (a.kind === 'frame' ? -1 : 1));
	// inner ranges sort after the ones holding them, so walking backwards sees them first
	for (let i = out.length - 1; i >= 0; i--) {
		const r = out[i];
		if (!r) continue;
		for (let j = i + 1; j < out.length; j++) {
			const o = out[j];
			if (o && o.kind === r.kind && o.level === r.level && o.first >= r.first && o.last <= r.last) r.outer = Math.max(r.outer, o.outer + 1);
		}
	}
	return out;
}

/** The ranges of note text `text` (parsed with the map's parser). */
export function noteRangesOf(text: string): NoteRange[] {
	return noteRanges(parseDocument(text));
}

/** One range on one line: what the line decoration draws there. */
export interface RangeSegment {
	kind: NoteRange['kind'];
	level: number;
	outer: number;
	/** The range starts or ends on this line (the curled ends). */
	top: boolean;
	bottom: boolean;
}

/** Per line (0-based), the segments that pass through it; lines without any are absent. */
export function segmentsByLine(ranges: readonly NoteRange[]): Map<number, RangeSegment[]> {
	const out = new Map<number, RangeSegment[]>();
	for (const r of ranges) {
		for (let l = r.first; l <= r.last; l++) {
			let list = out.get(l);
			if (!list) out.set(l, (list = []));
			list.push({ kind: r.kind, level: r.level, outer: r.outer, top: l === r.first, bottom: l === r.last });
		}
	}
	return out;
}

/** Room left of the line box the drawing may use (px): the frame's 10 px plus a few nesting steps. */
export const RANGE_ROOM = 40;
/** Distance left of the list marker (px): summary 6, frame 10; each nesting step outwards adds 8. */
export const RANGE_OFFSET = { summary: 6, frame: 10, step: 8 } as const;

/**
 * The inline style of a line holding `segs`: background layers of its
 * line-drawing element (styles.css `.mapdown-range-draw`), one vertical line per segment
 * plus the 6 px hooks at the ends (a summary's at its bottom, a frame's at
 * both ends). Colours and the indent per level are CSS variables, so the
 * theme decides them.
 */
export function rangeStyle(segs: readonly RangeSegment[]): string {
	const img: string[] = [];
	const pos: string[] = [];
	const size: string[] = [];
	let levels = 0;
	for (const s of segs) {
		levels = Math.max(levels, s.level);
		const color = s.kind === 'summary' ? 'var(--mapdown-range-summary)' : 'var(--mapdown-range-frame)';
		const x = `calc(var(--mapdown-range-indent) * ${s.level} + ${RANGE_ROOM - RANGE_OFFSET[s.kind] - RANGE_OFFSET.step * s.outer}px)`;
		img.push(s.kind === 'summary' ? `linear-gradient(${color}, ${color})` : `repeating-linear-gradient(${color} 0 4px, transparent 4px 7px)`);
		pos.push(`${x} 0`);
		size.push('1.5px 100%');
		const solid = `linear-gradient(${color}, ${color})`;
		if (s.bottom) {
			img.push(solid);
			pos.push(`${x} 100%`);
			size.push('6px 1.5px');
		}
		if (s.top && s.kind === 'frame') {
			img.push(solid);
			pos.push(`${x} 0`);
			size.push('6px 1.5px');
		}
	}
	return `--mapdown-range-levels: ${levels}; --mapdown-range-img: ${img.join(', ')}; --mapdown-range-pos: ${pos.join(', ')}; --mapdown-range-size: ${size.join(', ')}`;
}
