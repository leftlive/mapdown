// Pure rules of maps embedded in notes (behaviour spec 5.10): the height
// written as `![[Map|300]]`, the `#Heading` / `#^block` subpath and the node it
// names, and when an embed is taken over. No DOM, no Obsidian.

import type { MapNode } from './types.ts';

export const EMBED_HEIGHT_MIN = 150;
export const EMBED_HEIGHT_MAX = 1200;

/**
 * Height of an embed from the `width` and `height` attributes Obsidian puts on
 * `.internal-embed` for `|300` (or `|300x200`): digits only, and no height,
 * is the height in pixels, clamped to 150-1200; anything else is `def`.
 */
export function embedHeight(width: string | null, height: string | null, def: number): number {
	if (width === null || height !== null || !/^\d+$/.test(width)) return def;
	return Math.max(EMBED_HEIGHT_MIN, Math.min(EMBED_HEIGHT_MAX, Number(width)));
}

/** The subpath of an embed's `src` (`Map#Plan` gives `Plan`), or '' for the whole note. */
export function embedSubpath(src: string | null): string {
	const i = src?.indexOf('#') ?? -1;
	return src && i >= 0 ? src.slice(i + 1) : '';
}

// Obsidian drops these from heading links; case and runs of spaces do not count.
const norm = (s: string): string => s.replace(/[#|^:%[\]\\]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The node a subpath names: `^id` is the first node with that block id; `A#B`
 * is a heading B under a heading A (any depth). Null when nothing matches.
 */
export function subpathNode(root: MapNode, subpath: string): MapNode | null {
	const parts = subpath.split('#').filter((p) => p.trim() !== '');
	const last = parts.pop();
	if (last === undefined) return null;
	const block = last.startsWith('^') ? last.slice(1).toLowerCase() : null;
	const path = parts.map(norm);
	const want = norm(last);
	const visit = (node: MapNode, heads: string[]): MapNode | null => {
		const isHead = node.kind === 'heading';
		const text = isHead ? norm(node.text) : '';
		if (block !== null ? node.blockId?.toLowerCase() === block : isHead && text === want) {
			// earlier parts must be headings above it, in order
			let i = 0;
			for (const h of heads) if (h === path[i]) i++;
			if (block !== null || i === path.length) return node;
		}
		const below = isHead ? [...heads, text] : heads;
		for (const c of node.children) {
			const hit = visit(c, below);
			if (hit) return hit;
		}
		return null;
	};
	return visit(root, []);
}

/** Where an embed of a map note sits (read from the DOM once it is attached). */
export interface EmbedPlace {
	/** Inside an Obsidian `.internal-embed` (the note is not rendered on its own). */
	inEmbed: boolean;
	/** In a page preview popover. */
	inPopover: boolean;
	/** In a map node or a map view. */
	inMap: boolean;
	/** Inside another embedded map. */
	inMapEmbed: boolean;
	/** The embed was already handled (an earlier section of the same note). */
	taken: boolean;
}

/** Spec 5.10: take over embeds in notes, not in popovers, map nodes or embedded maps; each once. */
export function shouldTakeOver(p: EmbedPlace): boolean {
	return p.inEmbed && !p.inPopover && !p.inMap && !p.inMapEmbed && !p.taken;
}
