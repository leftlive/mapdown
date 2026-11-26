// Sets an icon from the fallback lists of iconNames.ts: the first name the
// running Obsidian has.

import { getIcon, setIcon } from "obsidian";
import { iconNames, pickIcon } from "./iconNames.ts";

/** `setIcon` with the first existing name for `icon` (just `icon` when it has no fallbacks). */
export function setIconFrom(el: HTMLElement, icon: string): void {
	const names = iconNames(icon);
	setIcon(el, names.length > 1 ? pickIcon(names, (n) => getIcon(n) !== null) : icon);
}
