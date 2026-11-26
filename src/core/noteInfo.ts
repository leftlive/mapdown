// What the one-line replacement of a map note's two property rows says (behaviour
// spec 5.16 item 4): "Mind map · 3 collapsed · Right". Pure, read from the note's
// text with the same front matter reader as the map.

import { parseFrontmatter } from './parse.ts';
import type { LayoutDirection } from './types.ts';

export interface NoteInfo {
	/** Distinct collapsed node ids in `mindmark-state`. */
	collapsed: number;
	/** The map's own layout direction, when it has one. */
	layout?: LayoutDirection;
}

/** The info of a map note, or null when the text is no map note or its `mindmark-state` cannot be read (contract 3.1): then nothing is hidden. */
export function noteInfoOf(text: string): NoteInfo | null {
	const fm = parseFrontmatter(text);
	if (!fm || !fm.isMindmap || fm.stateError !== null || !fm.state) return null;
	const info: NoteInfo = { collapsed: new Set(fm.state.collapsed).size };
	if (fm.state.layout !== undefined) info.layout = fm.state.layout;
	return info;
}

/** The line's text: the name, then " · " and each part that applies. */
export function noteInfoText(info: NoteInfo, words: { map: string; collapsed: (n: number) => string; direction: (d: LayoutDirection) => string }): string {
	const parts = [words.map];
	if (info.collapsed > 0) parts.push(words.collapsed(info.collapsed));
	if (info.layout !== undefined) parts.push(words.direction(info.layout));
	return parts.join(' · ');
}
