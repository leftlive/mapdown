// Session ids across re-parses. parseDocument generates ids positionally, so
// after any edit most of them shift; selection and the renderer's per-id DOM
// cache need ids that follow the node. `reconcile` re-keys a freshly parsed
// tree to the previous tree's ids wherever nodes correspond.

import type { MapNode, ParsedDoc } from './types.ts';

export interface ReconcileHints {
	/**
	 * Offset of a node's first line in next.text -> the id that node should
	 * keep (e.g. moved nodes, from OpResult.anchors). Ids that do not exist in
	 * prev are ignored.
	 */
	keep?: ReadonlyMap<number, string>;
}

/** Largest middle-block product the quadratic LCS is allowed to fill. */
const LCS_CELLS = 250_000;
/** Rounds of the unique-text fallback (each round may unlock more children). */
const FALLBACK_ROUNDS = 3;
const FRESH = /^_s(\d+)$/;

function preorder(root: MapNode): MapNode[] {
	const out: MapNode[] = [];
	const stack: MapNode[] = [root];
	for (let n = stack.pop(); n; n = stack.pop()) {
		out.push(n);
		for (let i = n.children.length - 1; i >= 0; i--) {
			const c = n.children[i];
			if (c) stack.push(c);
		}
	}
	return out;
}

/** The nodes a document lists at its top: a virtual root's children, else the root itself. */
const topOf = (doc: ParsedDoc): MapNode[] => (doc.virtualRoot ? doc.root.children : [doc.root]);

/** Longest common subsequence of two text lists, as increasing index pairs. */
function lcs(a: readonly MapNode[], b: readonly MapNode[], a0: number, a1: number, b0: number, b1: number): [number, number][] {
	const m = a1 - a0;
	const n = b1 - b0;
	const out: [number, number][] = [];
	if (m * n <= LCS_CELLS) {
		const w = n + 1;
		const t = new Uint32Array((m + 1) * w);
		for (let i = m - 1; i >= 0; i--) {
			for (let j = n - 1; j >= 0; j--) {
				t[i * w + j] =
					a[a0 + i]?.text === b[b0 + j]?.text
						? (t[(i + 1) * w + j + 1] ?? 0) + 1
						: Math.max(t[(i + 1) * w + j] ?? 0, t[i * w + j + 1] ?? 0);
			}
		}
		let i = 0;
		let j = 0;
		while (i < m && j < n) {
			if (a[a0 + i]?.text === b[b0 + j]?.text) {
				out.push([a0 + i, b0 + j]);
				i++;
				j++;
			} else if ((t[(i + 1) * w + j] ?? 0) >= (t[i * w + j + 1] ?? 0)) i++;
			else j++;
		}
		return out;
	}
	// Too big for the table: greedy in-order matching on exact text.
	const byText = new Map<string, { at: number[]; cur: number }>();
	for (let i = a0; i < a1; i++) {
		const text = a[i]?.text ?? '';
		const e = byText.get(text);
		if (e) e.at.push(i);
		else byText.set(text, { at: [i], cur: 0 });
	}
	let last = a0 - 1;
	for (let j = b0; j < b1; j++) {
		const e = byText.get(b[j]?.text ?? '');
		if (!e) continue;
		while (e.cur < e.at.length && (e.at[e.cur] ?? 0) <= last) e.cur++;
		const i = e.at[e.cur];
		if (i === undefined) continue;
		out.push([i, j]);
		last = i;
		e.cur++;
	}
	return out;
}

/**
 * Returns `next` with node ids re-keyed to `prev`'s session ids where nodes
 * correspond, and `collapsed` re-keyed the same way.
 *
 * Neither input is mutated: the result is a new tree (node objects and the
 * `collapsed` set are copies; `source` objects are shared with `next`). With
 * no `prev` the result is `next` itself.
 *
 * Nodes correspond, in priority order, by: (1) `hints.keep` (node start
 * offset; absent ids are honoured as described there); (2) the same block id, case-insensitively; (3) structure: the tops
 * of both trees are aligned, then the children of every matched pair, by an
 * LCS on text followed by pairing the equally sized gaps in between
 * positionally (any kind: editing a text can change it), so an edited text keeps its id; (4) a text that exists
 * exactly once among the still unmatched nodes on both sides (handles moves
 * without hints). Each prev id is used at most once.
 *
 * Unmatched nodes keep their block id as id when nothing else claimed it
 * (so deleting and undoing a block-id node restores its id); everything else
 * gets `_s<N>`, N above every `_s` number in prev and next. The prefix cannot
 * collide with block ids (no underscore) or parser ids (`_<digits>`).
 * Without session state, an id of a node deleted earlier than `prev` can be
 * reissued; deterministic by construction.
 */
export function reconcile(prev: ParsedDoc | null, next: ParsedDoc, hints?: ReconcileHints): ParsedDoc {
	if (!prev) return next;

	const prevNodes = preorder(prev.root);
	const nextNodes = preorder(next.root);
	const prevById = new Map<string, MapNode>();
	for (const p of prevNodes) if (!prevById.has(p.id)) prevById.set(p.id, p);

	const match = new Map<MapNode, MapNode>(); // next node -> prev node
	const used = new Set<MapNode>(); // matched prev nodes
	const work: [MapNode, MapNode][] = [];
	const pair = (p: MapNode, n: MapNode): void => {
		match.set(n, p);
		used.add(p);
		work.push([p, n]);
	};

	// (1) hints
	const keep = hints?.keep;
	if (keep && keep.size > 0) {
		// Ids a node of the result will certainly own: block-id nodes that nothing
		// pairs with keep their block id, so a hint cannot take it.
		const claimed = new Set<string>();
		for (const n of nextNodes) if (n.blockId !== null && n.id === n.blockId) claimed.add(n.id);
		if (next.virtualRoot) claimed.add(next.root.id);
		for (const n of nextNodes) {
			const from = n.source?.range.from;
			const id = from === undefined ? undefined : keep.get(from);
			if (id === undefined) continue;
			const p = prevById.get(id);
			if (p) {
				if (!used.has(p) && !(prev.virtualRoot && p === prev.root)) pair(p, n);
			} else if (!claimed.has(id) && !(next.virtualRoot && n === next.root)) {
				// Absent from prev: pair with a stand-in so later passes leave n alone.
				claimed.add(id);
				pair({ ...n, id, children: [] }, n);
			}
		}
	}

	// (2) block ids, paired in document order for duplicates
	const byBlock = new Map<string, { nodes: MapNode[]; cur: number }>();
	for (const p of prevNodes) {
		if (p.blockId === null) continue;
		const key = p.blockId.toLowerCase();
		const e = byBlock.get(key);
		if (e) e.nodes.push(p);
		else byBlock.set(key, { nodes: [p], cur: 0 });
	}
	if (byBlock.size > 0) {
		for (const n of nextNodes) {
			if (n.blockId === null || match.has(n)) continue;
			const e = byBlock.get(n.blockId.toLowerCase());
			if (!e) continue;
			while (e.cur < e.nodes.length && used.has(e.nodes[e.cur])) e.cur++;
			const p = e.nodes[e.cur];
			if (p) pair(p, n);
		}
	}

	// (3) structure
	const align = (ps: readonly MapNode[], ns: readonly MapNode[]): void => {
		const P = ps.filter((k) => !used.has(k));
		const N = ns.filter((k) => !match.has(k));
		if (P.length === 0 || N.length === 0) return;
		const pairs: [number, number][] = [];
		let lo = 0;
		while (lo < P.length && lo < N.length && P[lo]?.text === N[lo]?.text) {
			pairs.push([lo, lo]);
			lo++;
		}
		let pe = P.length;
		let ne = N.length;
		const tail: [number, number][] = [];
		while (pe > lo && ne > lo && P[pe - 1]?.text === N[ne - 1]?.text) {
			pe--;
			ne--;
			tail.push([pe, ne]);
		}
		if (pe > lo && ne > lo) pairs.push(...lcs(P, N, lo, pe, lo, ne));
		for (let i = tail.length - 1; i >= 0; i--) pairs.push(tail[i]);
		pairs.push([P.length, N.length]);
		let pi = 0;
		let ni = 0;
		for (const [qi, qj] of pairs) {
			if (qi - pi === qj - ni) {
				for (let k = 0; k < qi - pi; k++) {
					const p = P[pi + k];
					const n = N[ni + k];
					if (p && n) pair(p, n);
				}
			}
			const p = P[qi];
			const n = N[qj];
			if (p && n) pair(p, n);
			pi = qi + 1;
			ni = qj + 1;
		}
	};
	const drain = (): void => {
		for (let i = 0; i < work.length; i++) {
			const [p, n] = work[i];
			align(p.children, n.children);
		}
		work.length = 0;
	};
	// Pairs made by hints and block ids are already queued; the tops come first.
	align(topOf(prev), topOf(next));
	drain();

	// (4) unique exact text among what is still unmatched
	for (let round = 0; round < FALLBACK_ROUNDS; round++) {
		const free = new Map<string, { p: MapNode | null; pc: number; n: MapNode | null; nc: number }>();
		const slot = (text: string): { p: MapNode | null; pc: number; n: MapNode | null; nc: number } => {
			let e = free.get(text);
			if (!e) free.set(text, (e = { p: null, pc: 0, n: null, nc: 0 }));
			return e;
		};
		let freeP = 0;
		let freeN = 0;
		for (const p of prevNodes) {
			if (used.has(p) || (prev.virtualRoot && p === prev.root) || p.text === '') continue;
			const e = slot(p.text);
			e.p = p;
			e.pc++;
			freeP++;
		}
		if (freeP === 0) break;
		for (const n of nextNodes) {
			if (match.has(n) || (next.virtualRoot && n === next.root) || n.text === '') continue;
			const e = slot(n.text);
			e.n = n;
			e.nc++;
			freeN++;
		}
		if (freeN === 0) break;
		let any = false;
		for (const e of free.values()) {
			if (e.pc === 1 && e.nc === 1 && e.p && e.n) {
				pair(e.p, e.n);
				any = true;
			}
		}
		if (!any) break;
		drain();
	}

	// Ids
	let top = 0;
	for (const nodes of [prevNodes, nextNodes]) {
		for (const x of nodes) {
			const m = FRESH.exec(x.id);
			if (m) top = Math.max(top, Number(m[1]));
		}
	}
	if (keep) {
		for (const id of keep.values()) {
			const m = FRESH.exec(id);
			if (m) top = Math.max(top, Number(m[1]));
		}
	}
	const ids = new Map<MapNode, string>();
	const taken = new Set<string>();
	for (const [n, p] of match) {
		ids.set(n, p.id);
		taken.add(p.id);
	}
	for (const n of nextNodes) {
		if (ids.has(n)) continue;
		let id: string;
		if (next.virtualRoot && n === next.root) id = n.id;
		else if (n.blockId !== null && n.id === n.blockId && !taken.has(n.id)) id = n.id;
		else id = `_s${++top}`;
		ids.set(n, id);
		taken.add(id);
	}

	const rekey = new Map<string, string>();
	const build = (n: MapNode): MapNode => {
		const id = ids.get(n) ?? n.id;
		rekey.set(n.id, id);
		return { ...n, id, children: n.children.map(build) };
	};
	const root = build(next.root);
	const collapsed = new Set<string>();
	for (const id of next.collapsed) collapsed.add(rekey.get(id) ?? id);
	return { ...next, root, collapsed };
}
