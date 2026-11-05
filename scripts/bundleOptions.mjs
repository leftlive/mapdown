// esbuild options shared by the plugin build and the bundle unit test.
//
// JSZip's package `browser` field points at dist/jszip.min.js, which carries
// its own copies of a Promise polyfill, a setImmediate polyfill and a stream
// shim. Building from lib/ and replacing those three with the tiny shims in
// scripts/shims keeps the same JSZip code but drops the dead polyfills. pako
// is cut to its inflate half, since export writes uncompressed entries.
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export const jszipOptions = {
	// lib/ has no licence header (dist/ had one); keep the notice in main.js.
	banner: { js: "/*! JSZip v3.10.2 - (c) 2009-2016 Stuart Knightley - Dual licenced under the MIT license or GPLv3 - github.com/Stuk/jszip. Includes pako inflate (MIT) - github.com/nodeca/pako */" },
	alias: {
		jszip: here("../node_modules/jszip/lib/index.js"),
		lie: here("./shims/promise.cjs"),
		setimmediate: here("./shims/empty.cjs"),
		"readable-stream": here("./shims/empty.cjs"),
		// Inflate only: XMind export writes STORE entries (src/xmind/write.ts).
		pako: here("./shims/pako-inflate.cjs"),
	},
	inject: [here("./shims/set-immediate.mjs")],
};

export const sizeOptions = {
	// Keep non-ASCII (the Chinese UI strings) as UTF-8 instead of \uXXXX escapes.
	charset: "utf8",
	// Native public class fields (Safari 14.5+, all Obsidian desktop builds)
	// instead of the __publicField helper.
	supported: { "class-field": true, "class-static-field": true },
};
