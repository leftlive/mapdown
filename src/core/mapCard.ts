// Map embeds inside map nodes (behaviour spec 5.10, "节点里的导图嵌入"): where
// `![[…]]` sits in a node's text, and the label of the card drawn for an
// embedded map instead of Obsidian's full rendering. Which embeds are maps is
// decided outside (the plugin's metadata cache); here they arrive as labels
// keyed by the link written between the brackets. No DOM, no Obsidian.

/** One `![[…]]` in a node's text. */
export interface EmbedSpan {
	/** Offsets of `![[` and just after `]]`. */
	start: number;
	end: number;
	/** What is written between the brackets (the key of a card's label). */
	raw: string;
	/** Link path before `#`. */
	target: string;
	/** After the first `#` (`Goals`, `^id`, `A#B`); '' for the whole note. */
	subpath: string;
	/** Display text after `|`; null when none, empty, or digits only (the embed height). */
	alias: string | null;
}

/** Longest block line shown on a card, in characters. */
export const CARD_LABEL_MAX = 20;
/**
 * First of the private-use characters that stand for cards in a node's text
 * while it is drawn: the n-th card is `CARD_MARK + n`.
 */
export const CARD_MARK = 0xe000;
export const CARD_MAX = 256;
/** Matches any card mark. */
export const CARD_MARKS = /[-]/;

const EMBED = /!\[\[([^[\]]+?)\]\]/g;

/** Ranges of inline code spans (an embed inside one is text). */
function codeRanges(text: string): [number, number][] {
	const out: [number, number][] = [];
	let i = text.indexOf("`");
	while (i >= 0) {
		let n = 0;
		while (text[i + n] === "`") n++;
		const fence = "`".repeat(n);
		let j = text.indexOf(fence, i + n);
		while (j >= 0 && text[j + n] === "`") {
			while (text[j] === "`") j++;
			j = text.indexOf(fence, j);
		}
		if (j < 0) {
			i = text.indexOf("`", i + n);
			continue;
		}
		out.push([i, j + n]);
		i = text.indexOf("`", j + n);
	}
	return out;
}

/** Every `![[…]]` of `text` in order, outside inline code and not escaped. */
export function findEmbeds(text: string): EmbedSpan[] {
	if (!text.includes("![[")) return [];
	const code = text.includes("`") ? codeRanges(text) : [];
	const out: EmbedSpan[] = [];
	EMBED.lastIndex = 0;
	for (let m = EMBED.exec(text); m; m = EMBED.exec(text)) {
		const start = m.index;
		if (start > 0 && text[start - 1] === "\\") continue;
		if (code.some(([a, b]) => start >= a && start < b)) continue;
		const raw = m[1];
		const bar = raw.indexOf("|");
		let link = bar >= 0 ? raw.slice(0, bar) : raw;
		// `\|` inside a table cell
		if (bar >= 0 && link.endsWith("\\")) link = link.slice(0, -1);
		const aliasText = bar >= 0 ? raw.slice(bar + 1).trim() : "";
		const hash = link.indexOf("#");
		const target = (hash >= 0 ? link.slice(0, hash) : link).trim();
		if (target === "" && hash < 0) continue;
		out.push({
			start,
			end: start + m[0].length,
			raw,
			target,
			subpath: hash >= 0 ? link.slice(hash + 1).trim() : "",
			alias: aliasText === "" || /^\d+$/.test(aliasText) ? null : aliasText,
		});
	}
	return out;
}

/** First line of a node's text without inline markup, at most CARD_LABEL_MAX characters (then "…"). */
export function firstLineLabel(text: string, max = CARD_LABEL_MAX): string {
	const line = (text.split(/\r?\n|<br\s*\/?>/i)[0] ?? "")
		.replace(/\*\*|__|==|~~|`|\[\[|\]\]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const chars = Array.from(line);
	return chars.length > max ? `${chars.slice(0, max).join("")}…` : line;
}

/**
 * The card's text: `name`, `name › Heading`, `name › <block's first line>`
 * (`^id` while the block is unknown), or the `|alias` instead of all of it.
 * `blockText` is the text of the node a `#^id` names; null or undefined when not found.
 */
export function cardLabel(name: string, span: Pick<EmbedSpan, "subpath" | "alias">, blockText?: string | null): string {
	if (span.alias !== null) return span.alias;
	const parts = span.subpath.split("#").map((p) => p.trim()).filter((p) => p !== "");
	const last = parts[parts.length - 1];
	if (last === undefined) return name;
	if (last.startsWith("^")) return `${name} › ${blockText != null ? firstLineLabel(blockText) : last}`;
	return `${name} › ${last}`;
}

/** The block id of a `#^id` subpath, else null. */
export function blockOf(subpath: string): string | null {
	const parts = subpath.split("#").map((p) => p.trim()).filter((p) => p !== "");
	const last = parts[parts.length - 1];
	return last?.startsWith("^") ? last.slice(1) : null;
}

/** One card of a node, in text order. */
export interface CardSlot {
	raw: string;
	label: string;
}

/**
 * The node's text with each map embed (an embed with a label) replaced by its
 * card mark, and the cards in order; null when the text has no map embed.
 */
export function cardSlots(text: string, labels: ReadonlyMap<string, string>): { text: string; cards: CardSlot[] } | null {
	if (labels.size === 0) return null;
	const spans = findEmbeds(text);
	if (spans.length === 0) return null;
	const cards: CardSlot[] = [];
	let out = "";
	let last = 0;
	for (const s of spans) {
		const label = labels.get(s.raw);
		if (label === undefined || cards.length >= CARD_MAX) continue;
		out += text.slice(last, s.start) + String.fromCharCode(CARD_MARK + cards.length);
		cards.push({ raw: s.raw, label });
		last = s.end;
	}
	if (cards.length === 0) return null;
	return { text: out + text.slice(last), cards };
}

/** The text as the cards show it: each map embed replaced by its label (search, drag preview). */
export function cardShownText(text: string, labels: ReadonlyMap<string, string>): string {
	const slots = cardSlots(text, labels);
	if (!slots) return text;
	return slots.text.replace(new RegExp(CARD_MARKS.source, "g"), (c) => slots.cards[c.charCodeAt(0) - CARD_MARK]?.label ?? c);
}
