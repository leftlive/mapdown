// Node markers (behaviour spec 5.14): a run of emoji at the start of a node's
// text, each followed by one space, e.g. `🔥 设计` or `[ ] 1️⃣ ⭐ 键盘`. They are
// plain text in the Markdown (format contract unchanged); this module finds
// them, knows the presets and their groups, and rewrites the run when a
// marker is added, removed or cleared. Pure, so tests run it in Node.

import type { StringKey } from '../i18n.ts';
import { taskOf } from './tasks.ts';
import type { MapNode, NodeKind } from './types.ts';

export type MarkerGroup = 'priority' | 'color' | 'symbol';

const MARKER_GROUPS: readonly MarkerGroup[] = ['priority', 'color', 'symbol'];

/** A stored palette tab, or the symbols when it is missing or not a group. */
export function parseMarkerTab(value: unknown): MarkerGroup {
	return MARKER_GROUPS.find((g) => g === value) ?? 'symbol';
}

export interface MarkerPreset {
	/** As written into the text (with U+FE0F where the emoji has it). */
	emoji: string;
	group: MarkerGroup;
	/** Tooltip; `arg` fills `{0}`. */
	label: StringKey;
	arg?: number;
}

const VS16 = '️';
const keycap = (n: number): string => `${n}${VS16}⃣`;

/** In the order of spec 5.14; the run of markers is rewritten in this order. */
export const MARKER_PRESETS: readonly MarkerPreset[] = [
	...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): MarkerPreset => ({ emoji: keycap(n), group: 'priority', label: 'marker-priority', arg: n })),
	{ emoji: '\u{1F534}', group: 'color', label: 'marker-red' },
	{ emoji: '\u{1F7E0}', group: 'color', label: 'marker-orange' },
	{ emoji: '\u{1F7E1}', group: 'color', label: 'marker-yellow' },
	{ emoji: '\u{1F7E2}', group: 'color', label: 'marker-green' },
	{ emoji: '\u{1F535}', group: 'color', label: 'marker-blue' },
	{ emoji: '\u{1F7E3}', group: 'color', label: 'marker-purple' },
	{ emoji: '⭐', group: 'symbol', label: 'marker-star' },
	{ emoji: '\u{1F6A9}', group: 'symbol', label: 'marker-flag' },
	{ emoji: '\u{1F4CC}', group: 'symbol', label: 'marker-pin' },
	{ emoji: '\u{1F3AF}', group: 'symbol', label: 'marker-goal' },
	{ emoji: '\u{1F4A1}', group: 'symbol', label: 'marker-idea' },
	{ emoji: '\u{1F4DD}', group: 'symbol', label: 'marker-note' },
	{ emoji: '❓', group: 'symbol', label: 'marker-question' },
	{ emoji: '❗', group: 'symbol', label: 'marker-important' },
	{ emoji: `⚠${VS16}`, group: 'symbol', label: 'marker-warning' },
	{ emoji: '❌', group: 'symbol', label: 'marker-no' },
	{ emoji: '⏳', group: 'symbol', label: 'marker-waiting' },
	{ emoji: '\u{1F512}', group: 'symbol', label: 'marker-blocked' },
	{ emoji: '\u{1F525}', group: 'symbol', label: 'marker-hot' },
	{ emoji: '\u{1F680}', group: 'symbol', label: 'marker-launch' },
	{ emoji: '\u{1F44D}', group: 'symbol', label: 'marker-good' },
	{ emoji: '\u{1F44E}', group: 'symbol', label: 'marker-bad' },
	{ emoji: `❤${VS16}`, group: 'symbol', label: 'marker-love' },
	{ emoji: '\u{1F4C5}', group: 'symbol', label: 'marker-date' },
	{ emoji: '\u{1F4B0}', group: 'symbol', label: 'marker-cost' },
	{ emoji: '\u{1F41B}', group: 'symbol', label: 'marker-bug' },
	{ emoji: '\u{1F517}', group: 'symbol', label: 'marker-link' },
	{ emoji: '\u{1F440}', group: 'symbol', label: 'marker-watch' },
	{ emoji: '\u{1F9EA}', group: 'symbol', label: 'marker-test' },
	{ emoji: '\u{1F3C1}', group: 'symbol', label: 'marker-finish' },
];

/** Groups in which a node keeps at most one marker. */
const SINGLE: ReadonlySet<MarkerGroup> = new Set(['priority', 'color']);

/** The palette's rows (spec 5.14): priority 1–5 only, every colour and symbol. */
export const PALETTE_GROUPS: readonly { group: MarkerGroup; title: StringKey; markers: readonly MarkerPreset[] }[] = [
	{ group: 'priority', title: 'markers-group-priority', markers: MARKER_PRESETS.slice(0, 5) },
	{ group: 'color', title: 'markers-group-color', markers: MARKER_PRESETS.filter((p) => p.group === 'color') },
	{ group: 'symbol', title: 'markers-group-symbol', markers: MARKER_PRESETS.filter((p) => p.group === 'symbol') },
];

/** Identity of an emoji for matching: U+FE0F left out, so a hand-typed `⚠` is the preset `⚠️`. */
const keyOf = (emoji: string): string => emoji.replace(/️/g, '');

const PRESET_BY_KEY = new Map(MARKER_PRESETS.map((p) => [keyOf(p.emoji), p]));
/** Position in the fixed order; emoji outside the presets come after all of them. */
const RANK = new Map(MARKER_PRESETS.map((p, i) => [keyOf(p.emoji), i]));

export function presetOf(emoji: string): MarkerPreset | null {
	return PRESET_BY_KEY.get(keyOf(emoji)) ?? null;
}

// One emoji (spec 5.14): an Extended_Pictographic character with an optional
// U+FE0F or skin tone (and tag characters, for subdivision flags), joined by
// U+200D into sequences; a keycap; or a pair of regional indicators (a flag).
const PIC = '\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?(?:[\\u{E0020}-\\u{E007E}]+\\u{E007F})?';
const EMOJI = new RegExp(`(?:${PIC}(?:\\u200D${PIC})*|[0-9#*]\\uFE0F?\\u20E3|\\p{Regional_Indicator}{2})`, 'uy');
/** First characters that can never start an emoji: ASCII except digits, `#` and `*`. */
const NOT_EMOJI_START = /^[\0-"$-)+-/:-\x7F]/;

export interface Marker {
	emoji: string;
	/** The emoji's span in the text (the space after it not included). */
	from: number;
	to: number;
}

export interface MarkerSplit {
	/** A task's `[ ] ` (with its one space) in front of the markers; "" for other nodes. */
	prefix: string;
	markers: Marker[];
	/** The text after the markers and the space after the last one. */
	rest: string;
	restFrom: number;
}

/** Kinds whose text can start with markers (quotes and callouts are paragraphs starting with `>`). */
function markableKind(kind: NodeKind): boolean {
	return kind === 'list' || kind === 'heading' || kind === 'paragraph';
}

/**
 * The markers at the start of a node's text. A list item's task marker comes
 * first; a heading's text has no hashes. Nodes that cannot have markers get
 * none, and their whole text (after a task marker) is `rest`.
 */
export function splitMarkers(text: string, kind: NodeKind): MarkerSplit {
	const task = taskOf(text, kind);
	const start = task ? task.length : 0;
	const prefix = text.slice(0, start);
	const none: MarkerSplit = { prefix, markers: [], rest: text.slice(start), restFrom: start };
	if (!markableKind(kind) || start >= text.length || NOT_EMOJI_START.test(text.slice(start, start + 1))) return none;
	if (text.startsWith('>', start)) return none;
	const markers: Marker[] = [];
	let at = start;
	while (at < text.length) {
		EMOJI.lastIndex = at;
		const m = EMOJI.exec(text);
		if (!m) break;
		const to = at + m[0].length;
		// a marker is followed by one space or ends the text; `🔥设计` is text
		if (to < text.length && text[to] !== ' ') break;
		markers.push({ emoji: m[0], from: at, to });
		at = to < text.length ? to + 1 : to;
	}
	if (markers.length === 0) return none;
	return { prefix, markers, rest: text.slice(at), restFrom: at };
}

/**
 * Whether markers can be added to the node: list items, headings and plain paragraphs, not the
 * document root (virtual or a real heading; `root` is the document's root node, spec 5.14).
 */
export function canHaveMarkers(node: Pick<MapNode, 'kind' | 'text' | 'source'>, root?: object): boolean {
	if (node === root || !node.source || !markableKind(node.kind)) return false;
	const task = taskOf(node.text, node.kind);
	return !node.text.startsWith('>', task ? task.length : 0);
}

export function hasMarker(text: string, kind: NodeKind, emoji: string): boolean {
	const key = keyOf(emoji);
	return splitMarkers(text, kind).markers.some((m) => keyOf(m.emoji) === key);
}

/** What a click on a marker does: add it, remove it from every target, or clear the whole run. */
export type MarkerOp = { add: string } | { remove: string } | { clear: true };

/** Clicking `emoji` (spec 5.14): removed when every target has it, otherwise added. */
export function markerOp(targets: readonly { text: string; kind: NodeKind }[], emoji: string): MarkerOp {
	return targets.length > 0 && targets.every((t) => hasMarker(t.text, t.kind, emoji)) ? { remove: emoji } : { add: emoji };
}

/**
 * The text after `op` (spec 5.14). Only the run of markers changes; it is
 * written again in the fixed order (priority, colour, symbols, then emoji
 * outside the presets in their old order), one space after each. When `op`
 * changes nothing the text comes back unchanged, unordered as it was.
 */
export function applyMarker(text: string, kind: NodeKind, op: MarkerOp): string {
	const task = taskOf(text, kind);
	if (!markableKind(kind) || text.startsWith('>', task ? task.length : 0)) return text;
	const s = splitMarkers(text, kind);
	let list = s.markers.map((m) => m.emoji);
	if ('clear' in op) {
		if (list.length === 0) return text;
		list = [];
	} else if ('remove' in op) {
		const key = keyOf(op.remove);
		const kept = list.filter((e) => keyOf(e) !== key);
		if (kept.length === list.length) return text;
		list = kept;
	} else {
		const key = keyOf(op.add);
		if (list.some((e) => keyOf(e) === key)) return text;
		const preset = presetOf(op.add);
		if (preset && SINGLE.has(preset.group)) list = list.filter((e) => presetOf(e)?.group !== preset.group);
		list.push(preset ? preset.emoji : op.add);
	}
	const rank = (e: string): number => RANK.get(keyOf(e)) ?? MARKER_PRESETS.length;
	const sorted = list.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map((x) => x.e);
	return compose(s.prefix, sorted, s.rest);
}

function compose(prefix: string, markers: readonly string[], rest: string): string {
	if (markers.length === 0) return rest === '' ? prefix.trimEnd() : prefix + rest;
	const head = prefix !== '' && !/\s$/.test(prefix) ? `${prefix} ` : prefix;
	const run = markers.join(' ');
	return rest === '' ? head + run : `${head}${run} ${rest}`;
}

/**
 * The markers every target carries, in the first target's order (spec 5.14: the palette's
 * "added" chips). Emoji outside the presets count too; empty when there are no targets.
 */
export function commonMarkers(targets: readonly { text: string; kind: NodeKind }[]): string[] {
	const [first, ...others] = targets;
	if (!first) return [];
	const sets = others.map((t) => new Set(splitMarkers(t.text, t.kind).markers.map((m) => keyOf(m.emoji))));
	const seen = new Set<string>();
	const out: string[] = [];
	for (const m of splitMarkers(first.text, first.kind).markers) {
		const key = keyOf(m.emoji);
		if (seen.has(key) || !sets.every((set) => set.has(key))) continue;
		seen.add(key);
		out.push(presetOf(m.emoji)?.emoji ?? m.emoji);
	}
	return out;
}
