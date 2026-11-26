// Type checks that work for DOM objects of any window. A map shown in a popout
// window gets events whose targets belong to that window's realm, so
// `target instanceof Element` (the main window's Element) is false for them.

export function isNode(x: unknown): x is Node {
	return typeof x === "object" && x !== null && typeof (x as Node).nodeType === "number";
}

export function isElement(x: unknown): x is Element {
	return isNode(x) && x.nodeType === 1;
}

/**
 * A detached element (not in any document) made by the window that owns `doc`, so it
 * belongs to the right realm in a popout window. Obsidian defines `createEl` on every
 * window but its typings only declare the global one.
 */
export function detachedEl<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K): HTMLElementTagNameMap[K] {
	return (doc.win as unknown as typeof window).createEl(tag);
}
