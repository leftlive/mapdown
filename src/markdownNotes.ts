// Summary and frame comments in the Markdown views of map notes (behaviour spec
// 5.16). Live preview: a CodeMirror ViewPlugin replaces each recognised comment
// with a small tag, except on lines the cursor or selection touches. Reading
// view: a post-processor puts the same tags after the item's or heading's text.
// What counts as a comment comes from core/noteTags.ts (the parser's rules).
// The range lines of 5.16 item 3 are line decorations built in `NotesPlugin.build`
// (live preview) and classes on list items and sections (reading view), from
// core/noteRanges.ts (the map's parser and summary rules).

import { StateEffect, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { MarkdownView, TFile, editorInfoField, editorLivePreviewField } from 'obsidian';
import { blockIdAt, nodeTagsFrom, noteTagsAt, shownTags, skippedLines, type LineAt, type NoteTag } from './core/noteTags.ts';
import { noteRangesOf, rangeStyle, segmentsByLine, type NoteRange, type RangeSegment } from './core/noteRanges.ts';
import { getEditorView } from './editorSync.ts';
import type MapdownPlugin from './main.ts';
import { DOM } from './view/contract.ts';

const refresh = StateEffect.define<null>();

interface Pill {
	text: string;
	/** Offset of the comment from the start of the widget's range. */
	offset: number;
}

function buildTags(pills: readonly Pill[]): HTMLElement {
	const box = createSpan({ cls: DOM.noteTags });
	for (const p of pills) {
		const el = box.createSpan({ cls: DOM.noteTag, text: p.text });
		el.dataset.offset = String(p.offset);
	}
	return box;
}

const pillsOf = (tags: readonly NoteTag[], base: number): Pill[] =>
	shownTags(tags).map((tag) => ({ text: tag.label ?? '', offset: tag.from - base }));

class TagsWidget extends WidgetType {
	private readonly pills: readonly Pill[];

	constructor(pills: readonly Pill[]) {
		super();
		this.pills = pills;
	}

	eq(other: TagsWidget): boolean {
		return this.pills.length === other.pills.length && this.pills.every((p, i) => p.text === other.pills[i]?.text && p.offset === other.pills[i]?.offset);
	}

	toDOM(view: EditorView): HTMLElement {
		const box = buildTags(this.pills);
		// a click puts the cursor inside that comment, which shows the line's text (spec 5.16)
		box.addEventListener('mousedown', (e) => {
			const pill = e.target instanceof Element ? e.target.closest<HTMLElement>(`.${DOM.noteTag}`) : null;
			if (!pill) return;
			e.preventDefault();
			const start = view.posAtDOM(box);
			view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, start + Number(pill.dataset.offset) + 2) } });
			view.focus();
		});
		return box;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

/**
 * The range lines of one line (spec 5.16 item 3), drawn by an element of our
 * own rather than the line's `::after`: themes style the pseudo-elements of
 * heading lines (a fixed height there cut the line down to its top hook), and
 * no theme rule reaches this element. It is absolutely positioned against the
 * line (`rangeLine` makes the line `position: relative`), so it takes no room
 * and spans the whole line box whatever its padding or line height.
 */
class RangeWidget extends WidgetType {
	private readonly style: string;

	constructor(style: string) {
		super();
		this.style = style;
	}

	eq(other: RangeWidget): boolean {
		return other.style === this.style;
	}

	toDOM(): HTMLElement {
		const box = createSpan({ cls: DOM.rangeMarks });
		box.setAttr('aria-hidden', 'true');
		box.createSpan({ cls: DOM.rangeDraw }).setAttr('style', this.style);
		return box;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

class NotesPlugin {
	decorations: DecorationSet = Decoration.none;
	private live = false;
	private skipped: { doc: unknown; ranges: [number, number][] } | null = null;
	/** Range-line segments per line, recomputed when the text changes (spec 5.16 item 3). */
	private segments: { doc: unknown; byLine: Map<number, RangeSegment[]> } | null = null;

	private readonly plugin: MapdownPlugin;

	constructor(plugin: MapdownPlugin, view: EditorView) {
		this.plugin = plugin;
		this.decorations = this.build(view);
	}

	update(u: ViewUpdate): void {
		const live = u.state.field(editorLivePreviewField, false) === true;
		if (u.docChanged || u.selectionSet || u.viewportChanged || live !== this.live || u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))) {
			this.decorations = this.build(u.view);
		}
	}

	private build(view: EditorView): DecorationSet {
		const state = view.state;
		this.live = state.field(editorLivePreviewField, false) === true;
		const file = state.field(editorInfoField, false)?.file ?? null;
		if (!this.live || !this.plugin.settings.markdownNotes || !this.plugin.isMapFileSync(file)) return Decoration.none;
		const doc = state.doc;
		const get: LineAt = (i) => (i < 0 || i >= doc.lines ? undefined : doc.line(i + 1).text);
		if (this.skipped?.doc !== doc) this.skipped = { doc, ranges: skippedLines(get, doc.lines) };
		const skip = this.skipped.ranges;
		if (this.segments?.doc !== doc) this.segments = { doc, byLine: segmentsByLine(noteRangesOf(doc.toString())) };
		const byLine = this.segments.byLine;
		const out: Range<Decoration>[] = [];
		let seen = -1;
		let k = 0;
		for (const r of view.visibleRanges) {
			for (let n = Math.max(doc.lineAt(r.from).number, seen + 2); n <= doc.lineAt(r.to).number; n++) {
				const i = n - 1;
				seen = i;
				const segs = byLine.get(i);
				if (segs) {
					const at = doc.line(n).from;
					out.push(Decoration.line({ class: DOM.rangeLine }).range(at));
					out.push(Decoration.widget({ widget: new RangeWidget(rangeStyle(segs)), side: -1 }).range(at));
				}
				while (k < skip.length && (skip[k]?.[1] ?? 0) < i) k++;
				const s = skip[k];
				if (s && s[0] <= i) continue;
				const line = doc.line(n);
				if (!line.text.includes('%%') && !line.text.includes('^')) continue;
				if (state.selection.ranges.some((sel) => sel.from <= line.to && sel.to >= line.from)) continue;
				const notes = noteTagsAt(get, i);
				const first = notes?.tags[0];
				const last = notes?.tags[notes.tags.length - 1];
				if (notes && first && last) {
					const from = notes.own ? line.from : line.from + first.from;
					const to = notes.own ? line.to : line.from + last.to;
					const pills = pillsOf(notes.tags, from - line.from);
					// nothing to show: the comment (or the whole comment line) is hidden; the range lines say the rest
					if (notes.own) out.push(Decoration.line({ class: pills.length > 0 ? DOM.noteLine : DOM.noteHidden }).range(line.from));
					out.push(Decoration.replace(pills.length > 0 ? { widget: new TagsWidget(pills) } : {}).range(from, to));
				}
				// block ids mean nothing to a reader (contract 4.8); under a table or code block they stand on a line of their own
				const prevEnd = skip.some((r) => r[1] === i - 1 && r[0] > 0);
				const id = blockIdAt(get, i, prevEnd);
				if (id) {
					if (id.from === 0) out.push(Decoration.line({ class: DOM.noteHidden }).range(line.from));
					out.push(Decoration.replace({}).range(line.from + id.from, line.from + id.to));
				}
			}
		}
		return Decoration.set(out, true);
	}
}

/** The live preview extension (registered once with registerEditorExtension). */
export function markdownNotesExtension(plugin: MapdownPlugin): Extension {
	return ViewPlugin.define((view) => new NotesPlugin(plugin, view), { decorations: (v) => v.decorations });
}

/** Settings or a note's front matter changed: editors and reading views take the new state. */
export function refreshMarkdownNotes(plugin: MapdownPlugin, previews = true): void {
	plugin.app.workspace.iterateAllLeaves((leaf) => {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;
		// Each mode keeps its last render while the leaf shows the other one, so both are refreshed.
		if (previews) view.previewMode.rerender(true);
		getEditorView(view)?.dispatch({ effects: refresh.of(null) });
	});
}

// ---------------------------------------------------------------- reading view

const ATTACH_FRAMES = 5;

/** The ranges of the last note text the reading view asked for: every section of a note shares them. */
let lastRanges: { text: string; ranges: NoteRange[] } | null = null;

function rangesOf(text: string): NoteRange[] {
	if (lastRanges?.text !== text) lastRanges = { text, ranges: noteRangesOf(text) };
	return lastRanges.ranges;
}

const RANGE_CLASSES = {
	summary: { item: DOM.rangeSummary, block: DOM.rangeBlockSummary, first: DOM.rangeSummaryFirst, last: DOM.rangeSummaryLast },
	frame: { item: DOM.rangeFrame, block: DOM.rangeBlockFrame, first: DOM.rangeFrameFirst, last: DOM.rangeFrameLast },
} as const;

/**
 * Reading view range lines: a covered list item's `li` (its sublist inside it)
 * gets the kind's class, the first and last ones the end marks; a range that
 * starts at a heading or paragraph marks every section it overlaps, since each
 * section is its own element (so the line has gaps between sections).
 */
function markRanges(el: HTMLElement, items: readonly { li: Element; line: number }[], text: string, lineStart: number, lineEnd: number): void {
	for (const r of rangesOf(text)) {
		if (r.last < lineStart || r.first > lineEnd) continue;
		const c = RANGE_CLASSES[r.kind];
		if (r.item) {
			const firstStart = r.starts[0];
			const lastStart = r.starts[r.starts.length - 1];
			for (const { li, line } of items) {
				if (!r.starts.includes(line)) continue;
				li.addClass(c.item);
				if (line === firstStart) li.addClass(c.first);
				if (line === lastStart) li.addClass(c.last);
			}
		} else {
			el.addClass(c.block);
			if (r.first >= lineStart) el.addClass(c.first);
			if (r.last <= lineEnd) el.addClass(c.last);
		}
	}
}

/**
 * Reading view: the tags go after the text of each list item and heading of
 * the section. Obsidian marks a list item with `data-line`, its source line
 * relative to the section's first line (the way task plugins find the line of
 * a checkbox); items without it are matched by order among the section's list
 * lines.
 */
export function registerReadingTags(plugin: MapdownPlugin): void {
	plugin.registerMarkdownPostProcessor((el, ctx) => {
		const file = plugin.app.vault.getAbstractFileByPath(ctx.sourcePath);
		if (!plugin.settings.markdownNotes || !(file instanceof TFile) || !plugin.isMapFileSync(file)) return;
		// the section may not be attached yet, and then has no source info
		const run = (left: number): void => {
			const info = ctx.getSectionInfo(el);
			if (!info) {
				if (left > 0) el.win.requestAnimationFrame(() => run(left - 1));
				return;
			}
			const lines = info.text.split('\n');
			const get: LineAt = (i) => lines[i];
			// a heading's comment line leaves an empty paragraph: no empty line (spec 5.16 item 2)
			let ownOnly = true;
			for (let i = info.lineStart; i <= info.lineEnd && ownOnly; i++) ownOnly = noteTagsAt(get, i)?.own === true;
			if (ownOnly) el.addClass(DOM.noteHidden);
			const add = (host: Element, before: Element | null, tags: readonly NoteTag[]): void => {
				if (shownTags(tags).length === 0 || host.querySelector(`:scope > .${DOM.noteTags}`)) return;
				host.insertBefore(buildTags(pillsOf(tags, 0)), before);
			};
			for (const h of Array.from(el.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
				if (!h.closest('blockquote')) add(h, null, nodeTagsFrom(get, info.lineStart));
			}
			const items = Array.from(el.querySelectorAll('li')).filter((li) => !li.closest('blockquote'));
			const found: { li: Element; line: number }[] = [];
			let order = info.lineStart - 1;
			for (const li of items) {
				const dl = li.getAttribute('data-line');
				let line = dl !== null ? info.lineStart + Number(dl) : -1;
				if (line < 0) {
					do order++;
					while (order <= info.lineEnd && !/^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/.test(lines[order] ?? ''));
					line = order;
				}
				found.push({ li, line });
				const para = li.querySelector(':scope > p');
				add(para ?? li, para ? null : li.querySelector(':scope > ul, :scope > ol'), nodeTagsFrom(get, line));
			}
			markRanges(el, found, info.text, info.lineStart, info.lineEnd);
		};
		run(ATTACH_FRAMES);
	});
}
