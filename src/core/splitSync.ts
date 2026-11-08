// One-click split with sync (behaviour spec 5.6): which tab is "the other form"
// of a note. Pure; main.ts supplies the real tabs.

export type SplitKind = 'markdown' | 'map';

/** One tab with a Markdown or map view, as far as the decision needs it. */
export interface SplitLeaf<L, R, P> {
	leaf: L;
	kind: SplitKind;
	/** The note's path, null for an empty tab. */
	path: string | null;
	/** The window's root split: only tabs of one window count. */
	root: R;
	/** The split holding the tab: the partner sits in another one. */
	parent: P;
}

/**
 * The tabs of `self`'s note in the other form, in another split of the same
 * window. Non-empty means the button is pressed, and pressing it closes them.
 */
export function splitPartners<L, R, P>(self: SplitLeaf<L, R, P>, all: readonly SplitLeaf<L, R, P>[]): L[] {
	if (self.path === null) return [];
	return all
		.filter((o) => o.leaf !== self.leaf && o.kind !== self.kind && o.path === self.path && o.root === self.root && o.parent !== self.parent)
		.map((o) => o.leaf);
}

/** What the command or button does: close the partners, or open the other form. */
export function splitAction(partners: readonly unknown[]): 'close' | 'open' {
	return partners.length > 0 ? 'close' : 'open';
}
