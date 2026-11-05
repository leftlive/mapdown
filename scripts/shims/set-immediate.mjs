// Injected for JSZip's bare `setImmediate` calls (lib/utils.js `delay`):
// native where it exists (desktop), else a zero-delay timeout (mobile).
const g = globalThis;
export const setImmediate =
	typeof g.setImmediate === "function" ? g.setImmediate.bind(g) : (fn) => setTimeout(fn, 0);
