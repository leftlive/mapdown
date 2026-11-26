// Icons that not every Obsidian version ships (its Lucide set changes with
// the version): each list names the icons to try in order. Pure, so unit
// tests can load it; icons.ts applies it.

/** "Add summary" (spec 5.15): Obsidian 1.15's set has no `brackets`; `curly-braces` draws the brace itself. */
export const SUMMARY_ICONS = ["brackets", "curly-braces", "braces", "code"] as const;
/** "Toggle boundary" (spec 5.15): `square-dashed` was `box-select` in older Lucide sets. */
export const FRAME_ICONS = ["square-dashed", "box-select", "square"] as const;

/** Names to try for an icon named in an action list. */
const FALLBACKS: Readonly<Record<string, readonly string[]>> = { brackets: SUMMARY_ICONS, "square-dashed": FRAME_ICONS };

/** The names to try for `icon`, in order. */
export function iconNames(icon: string): readonly string[] {
	return FALLBACKS[icon] ?? [icon];
}

/** First of `names` that `has`, else the last one. */
export function pickIcon(names: readonly string[], has: (name: string) => boolean): string {
	for (const n of names) if (has(n)) return n;
	return names[names.length - 1] ?? "";
}
