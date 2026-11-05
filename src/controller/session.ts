// A document session: the map's text (the single source of truth), its parsed
// tree with ids that stay stable across re-parses, the view state, and the
// undo history. No Obsidian and no DOM here, so it runs under `node --test`.
//
// Every change goes through one of four doors:
// - `run`: one user operation, made of one or more core ops applied in a
//   chain (re-parse and reconcile between them) and recorded as ONE history
//   step with the composed edits;
// - `undo` / `redo`;
// - `external`: the text changed elsewhere (Markdown editor, another program);
// - `load`: a different file, or a full reset.
// After each, the tree is re-parsed, reconciled against the previous tree,
// the collapsed set is taken from the new text's `mindmark-state`, and the
// selection is kept by id.

import { findNodeAt, assignBlockId, uniqueBlockId, type OpResult } from '../core/ops.ts';
import { parseDocument } from '../core/parse.ts';
import { reconcile } from '../core/reconcile.ts';
import { createViewState, pruneSelection, stateLineEdit, type ViewState } from '../core/state.ts';
import type { MapNode, ParsedDoc, TextEdit } from '../core/types.ts';
import { History, type SelectionSnapshot } from '../history.ts';
import { applyTextEdits, composeEdits, diffTexts, invertEdits, sortEdits } from './textEdits.ts';

export type ChangeOrigin = 'op' | 'undo' | 'redo' | 'external' | 'load';

export interface SessionChange {
	origin: ChangeOrigin;
	/** Edits on the previous text (empty for load). */
	edits: TextEdit[];
	previousText: string;
	/** The root's text changed (only reported for op, undo and redo). */
	rootTextChanged: boolean;
	/** Ids the step created or moved, in the new tree (op only). */
	anchorIds: string[];
}

/** Gives the current id of a node named before an earlier step of the chain. */
export type IdOf = (id: string) => string;

/** One core operation of a chain; null aborts the whole chain. */
export type StepFn = (doc: ParsedDoc, id: IdOf) => StepResult | null;

export interface StepResult {
	result: OpResult;
	/** Ids (from before this step) that the anchors of `result` belong to, same order. */
	keep?: readonly string[];
	/** The anchors only name nodes to keep; they are not the nodes the user created or moved. */
	passive?: boolean;
}

export interface RunOptions {
	/** Expand collapsed ancestors of the created or moved nodes (default true). */
	reveal?: boolean;
	/** Selection after the step; default: the first created or moved node. */
	select?: (doc: ParsedDoc, anchorIds: string[], id: IdOf) => { ids: string[]; primary: string | null } | null;
}

/** RunOptions.select that keeps the current selection (following renamed ids). */
export function keepSelection(session: { view: ViewState }): NonNullable<RunOptions['select']> {
	const { ids, primary } = session.view.selection;
	return (_doc, _anchors, id) => ({ ids: ids.map(id), primary: primary === null ? null : id(primary) });
}

export function indexNodes(root: MapNode): Map<string, { node: MapNode; parent: MapNode | null; depth: number }> {
	const out = new Map<string, { node: MapNode; parent: MapNode | null; depth: number }>();
	const walk = (node: MapNode, parent: MapNode | null, depth: number): void => {
		out.set(node.id, { node, parent, depth });
		for (const c of node.children) walk(c, node, depth + 1);
	};
	walk(root, null, 0);
	return out;
}

/** Position where `pos` of the text before `edits` lands; a line start stays before a replacement starting there. */
function mapAnchor(pos: number, edits: readonly TextEdit[]): number {
	let delta = 0;
	for (const e of sortEdits(edits)) {
		if (e.from > pos) break;
		if (e.from === pos && e.to === pos) {
			delta += e.insert.length;
			continue;
		}
		if (e.from === pos) break;
		if (e.to <= pos) {
			delta += e.insert.length - (e.to - e.from);
			continue;
		}
		return e.from + delta;
	}
	return pos + delta;
}

/**
 * Two steps that make exactly `target` (node ids, or a function giving them
 * when the chain reaches this point) the collapsed set: first every target
 * node without a block id gets one (contract 3.2.3), then the state line is
 * written. Ids follow renames made earlier in the chain.
 */
export function collapseSteps(
	target: ReadonlySet<string> | ((doc: ParsedDoc) => ReadonlySet<string>),
	random: () => number = Math.random,
): StepFn[] {
	const resolve = (doc: ParsedDoc): ReadonlySet<string> => (typeof target === 'function' ? target(doc) : target);
	let wanted: string[] = [];
	return [
		(doc, id) => {
			wanted = [...resolve(doc)];
			const index = indexNodes(doc.root);
			const used = new Set<string>();
			const pairs: { at: number; id: string; edits: TextEdit[] }[] = [];
			for (const raw of wanted) {
				const node = index.get(id(raw))?.node;
				if (!node || node === doc.root || node.blockId !== null || node.source === null) continue;
				let bid = uniqueBlockId(doc, random);
				for (let i = 0; used.has(bid) && i < 100; i++) bid = uniqueBlockId(doc, random) + String(i);
				used.add(bid);
				const r = assignBlockId(doc, node.id, bid);
				if (!r) return null;
				pairs.push({ at: node.source.range.from, id: node.id, edits: r.edits });
			}
			pairs.sort((a, b) => a.at - b.at);
			const edits = sortEdits(pairs.flatMap((p) => p.edits));
			return {
				result: { edits, inverse: invertEdits(doc.text, edits), anchors: pairs.map((p) => p.at) },
				keep: pairs.map((p) => p.id),
				passive: true,
			};
		},
		(doc, id) => {
			const set = new Set(wanted.map(id));
			const blockIds: string[] = [];
			let level: MapNode[] = [doc.root];
			while (level.length > 0) {
				const next: MapNode[] = [];
				for (const n of level) {
					if (n !== doc.root && set.has(n.id) && n.blockId !== null) blockIds.push(n.blockId);
					next.push(...n.children);
				}
				level = next;
			}
			const edits = stateLineEdit(doc.text, doc.frontmatter, blockIds);
			return { result: { edits, inverse: invertEdits(doc.text, edits), anchors: [] }, passive: true };
		},
	];
}

export class DocSession {
	text = '';
	doc: ParsedDoc;
	view: ViewState;
	readonly history = new History();
	/** Text shown for a virtual root (the file name). */
	rootName = '';
	private listeners: ((c: SessionChange) => void)[] = [];

	constructor(text = '', rootName = '') {
		this.rootName = rootName;
		this.doc = parseDocument('');
		this.view = createViewState();
		this.load(text);
	}

	onChange(fn: (c: SessionChange) => void): void {
		this.listeners.push(fn);
	}

	private emit(c: SessionChange): void {
		for (const fn of this.listeners) fn(c);
	}

	/** Display text of the root: the file name for a virtual root. */
	rootText(doc: ParsedDoc = this.doc): string {
		return doc.virtualRoot ? this.rootName : doc.root.text;
	}

	load(text: string): void {
		const previousText = this.text;
		this.text = text;
		this.doc = parseDocument(text);
		this.view = createViewState(this.doc.collapsed);
		this.history.clear();
		this.emit({ origin: 'load', edits: [], previousText, rootTextChanged: false, anchorIds: [] });
	}

	setSelection(ids: readonly string[], primary: string | null): void {
		this.view = { ...this.view, selection: { ids: [...ids], primary } };
	}

	setView(view: ViewState): void {
		this.view = view;
	}

	snapshot(doc: ParsedDoc = this.doc, sel = this.view.selection): SelectionSnapshot {
		const index = indexNodes(doc.root);
		const ids = sel.ids.filter((id) => index.has(id));
		return {
			ids,
			primary: sel.primary !== null && index.has(sel.primary) ? sel.primary : null,
			offsets: ids.map((id) => index.get(id)?.node.source?.range.from ?? -1),
		};
	}

	/** Re-derive view state after the tree changed: collapsed from the text, selection kept by id. */
	private adopt(doc: ParsedDoc, selection?: { ids: string[]; primary: string | null }): void {
		this.doc = doc;
		const index = indexNodes(doc.root);
		const sel = selection ?? this.view.selection;
		const ids = sel.ids.filter((id) => index.has(id));
		const primary = sel.primary !== null && index.has(sel.primary) ? sel.primary : ids[ids.length - 1] ?? null;
		const focus = this.view.focus !== null && index.has(this.view.focus) ? this.view.focus : null;
		const tempExpanded = new Set([...this.view.tempExpanded].filter((id) => doc.collapsed.has(id)));
		this.view = pruneSelection(doc.root, {
			collapsed: new Set(doc.collapsed),
			tempExpanded,
			focus,
			selection: { ids, primary },
		});
	}

	private restore(doc: ParsedDoc, snap: SelectionSnapshot): { ids: string[]; primary: string | null } {
		const index = indexNodes(doc.root);
		const resolve = (id: string, offset: number): string | null => {
			if (index.has(id)) return id;
			if (offset < 0) return doc.virtualRoot ? doc.root.id : null;
			return findNodeAt(doc, offset)?.id ?? null;
		};
		const ids: string[] = [];
		let primary: string | null = null;
		snap.ids.forEach((id, i) => {
			const r = resolve(id, snap.offsets[i] ?? -1);
			if (r !== null && !ids.includes(r)) ids.push(r);
			if (id === snap.primary) primary = r;
		});
		return { ids, primary };
	}

	private keepHints(snap: SelectionSnapshot): Map<number, string> {
		const keep = new Map<number, string>();
		snap.ids.forEach((id, i) => {
			const o = snap.offsets[i] ?? -1;
			if (o >= 0) keep.set(o, id);
		});
		return keep;
	}

	/**
	 * Apply a chain of operations as one history step. Returns false (and
	 * changes nothing) when any step cannot be expressed in the text or the
	 * chain changes nothing.
	 */
	run(steps: readonly StepFn[], opts: RunOptions = {}): boolean {
		const t0 = this.text;
		const doc0 = this.doc;
		const before = this.snapshot();
		const renames = new Map<string, string>();
		const idOf: IdOf = (id) => {
			let cur = id;
			for (let i = 0; i < 16 && renames.has(cur); i++) cur = renames.get(cur) ?? cur;
			return cur;
		};
		let doc = doc0;
		let edits: TextEdit[] = [];
		let anchors: number[] = [];

		const step = (fn: StepFn, ownAnchors = true): boolean => {
			const r = fn(doc, idOf);
			if (!r) return false;
			const res = r.result;
			if (r.passive) ownAnchors = false;
			if (res.edits.length === 0) {
				if (ownAnchors && res.anchors.length > 0) anchors = res.anchors.slice();
				return true;
			}
			const nextText = applyTextEdits(doc.text, res.edits);
			const keep = new Map<number, string>();
			(r.keep ?? []).forEach((id, i) => {
				const at = res.anchors[i];
				if (at !== undefined) keep.set(at, id);
			});
			const next = reconcile(doc, parseDocument(nextText), { keep });
			// Ids may change (a node that gains a block id takes it as its id).
			keep.forEach((id, at) => {
				const found = findNodeAt(next, at);
				if (found && found.id !== id) renames.set(id, found.id);
			});
			edits = composeEdits(t0, edits, res.edits);
			anchors = ownAnchors && res.anchors.length > 0 ? res.anchors.slice() : anchors.map((a) => mapAnchor(a, res.edits));
			doc = next;
			return true;
		};

		for (const fn of steps) if (!step(fn)) return false;

		const anchorIds = (): string[] =>
			anchors.map((a) => findNodeAt(doc, a)?.id).filter((id): id is string => id !== undefined);

		// New or moved nodes must be visible: open their collapsed ancestors.
		if (opts.reveal !== false && anchors.length > 0) {
			const index = indexNodes(doc.root);
			const open = new Set<string>();
			for (const id of anchorIds()) {
				for (let p = index.get(id)?.parent ?? null; p; p = index.get(p.id)?.parent ?? null) {
					if (doc.collapsed.has(p.id)) open.add(p.id);
				}
			}
			if (open.size > 0) {
				const target = new Set([...doc.collapsed].filter((id) => !open.has(id)));
				for (const fn of collapseSteps(target)) if (!step(fn, false)) return false;
			}
		}
		if (edits.length === 0) return false;

		const ids = anchorIds();
		const selection = opts.select
			? opts.select(doc, ids, idOf)
			: ids.length > 0
				? { ids: [ids[0] ?? ''], primary: ids[0] ?? null }
				: {
						ids: this.view.selection.ids.map(idOf),
						primary: this.view.selection.primary === null ? null : idOf(this.view.selection.primary),
					};
		const rootBefore = this.rootText(doc0);
		this.text = doc.text;
		this.adopt(doc, selection ?? undefined);
		const after = this.snapshot();
		this.history.push({ forward: edits, inverse: invertEdits(t0, edits), before, after });
		this.emit({ origin: 'op', edits, previousText: t0, rootTextChanged: rootBefore !== this.rootText(), anchorIds: ids });
		return true;
	}

	undo(): boolean {
		const step = this.history.peekUndo();
		if (!step) return false;
		this.history.didUndo();
		this.replay(step.inverse, step.before, 'undo');
		return true;
	}

	redo(): boolean {
		const step = this.history.peekRedo();
		if (!step) return false;
		this.history.didRedo();
		this.replay(step.forward, step.after, 'redo');
		return true;
	}

	private replay(edits: TextEdit[], sel: SelectionSnapshot, origin: 'undo' | 'redo'): void {
		const previousText = this.text;
		const rootBefore = this.rootText();
		const text = applyTextEdits(previousText, edits);
		const doc = reconcile(this.doc, parseDocument(text), { keep: this.keepHints(sel) });
		this.text = text;
		this.adopt(doc, this.restore(doc, sel));
		this.emit({ origin, edits, previousText, rootTextChanged: rootBefore !== this.rootText(), anchorIds: [] });
	}

	/** The text was changed elsewhere. `edits` (on the current text) default to a diff. */
	external(text: string, edits?: TextEdit[]): void {
		if (text === this.text) return;
		const previousText = this.text;
		const changes = edits ?? diffTexts(previousText, text);
		this.history.mapOutside(changes);
		const doc = reconcile(this.doc, parseDocument(text));
		this.text = text;
		this.adopt(doc);
		this.emit({ origin: 'external', edits: changes, previousText, rootTextChanged: false, anchorIds: [] });
	}
}
