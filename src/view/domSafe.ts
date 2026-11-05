// Type checks that work for DOM objects of any window. A map shown in a popout
// window gets events whose targets belong to that window's realm, so
// `target instanceof Element` (the main window's Element) is false for them.

export function isNode(x: unknown): x is Node {
	return typeof x === "object" && x !== null && typeof (x as Node).nodeType === "number";
}

export function isElement(x: unknown): x is Element {
	return isNode(x) && x.nodeType === 1;
}
