// The plugin bundle builds JSZip from lib/ with its Promise, setImmediate and
// stream polyfills replaced by the shims in scripts/shims (build size budget,
// development plan §4). These tests bundle the XMind reader and writer the way
// the plugin build does and round-trip an archive through that bundle, once as
// on desktop and once as on mobile (no setImmediate, no Buffer). pako is cut
// to its inflate half, so the bundle must still read archives XMind deflated.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import JSZip from "jszip";
// @ts-expect-error -- plain .mjs build helper without type declarations
import { jszipOptions, sizeOptions } from "../../scripts/bundleOptions.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

const ENTRY = `
import { readXmind } from "./src/xmind/read.ts";
import { buildXmindArchive, mapToXmindSheet } from "./src/xmind/write.ts";
const tree = { text: "Root", collapsed: false, children: [
		{ text: "A ✅ 中文", collapsed: true, children: [{ text: "A1", collapsed: false, children: [] }] },
		{ text: "B\\nline", collapsed: false, children: [] },
	] };
export const writeArchive = () => buildXmindArchive(mapToXmindSheet(tree, "Plan"), "1.0");
export const readArchive = (data) => readXmind(data);
export async function roundTrip() {
	return readXmind(await writeArchive());
}
`;

async function bundle(): Promise<string> {
	const out = await esbuild.build({
		stdin: { contents: ENTRY, resolveDir: root, sourcefile: "entry.ts", loader: "js" },
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		target: "es2020",
		minify: true,
		logLevel: "silent",
		...jszipOptions,
		...sizeOptions,
	});
	return out.outputFiles?.[0]?.text ?? "";
}

type Doc = { topicCount: number; sheets: { title: string; root: { text: string; children: { text: string; collapsed: boolean }[] } }[] };

type Bundle = { roundTrip: () => Promise<Doc>; writeArchive: () => Promise<ArrayBuffer>; readArchive: (data: Uint8Array) => Promise<Doc> };

async function load(code: string, tag: string): Promise<Bundle> {
	const url = `data:text/javascript,${encodeURIComponent(`${code}\n// ${tag}`)}`;
	// eslint-disable-next-line no-unsanitized/method -- the code is the bundle this test just built
	return (await import(url)) as Bundle;
}

function check(doc: Doc): void {
	assert.equal(doc.topicCount, 4);
	assert.equal(doc.sheets[0].title, "Plan");
	assert.deepEqual(
		doc.sheets[0].root.children.map((c) => [c.text, c.collapsed]),
		[["A ✅ 中文", true], ["B\nline", false]],
	);
}

test("the bundle keeps JSZip but none of its polyfills", async () => {
	const code = await bundle();
	assert.doesNotMatch(code, /require\(["'](stream|readable-stream|lie|setimmediate)["']\)/);
	check(await (await load(code, "desktop")).roundTrip());
});

// What XMind itself writes: the same archive with DEFLATE entries, made by the
// full JSZip (with pako's deflate) that the tests load from node_modules.
async function deflated(archive: ArrayBuffer): Promise<Uint8Array> {
	return (await JSZip.loadAsync(archive)).generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

test("the bundle reads DEFLATE archives with its inflate-only pako", async () => {
	const b = await load(await bundle(), "deflate");
	check(await b.readArchive(await deflated(await b.writeArchive())));
});

test("the bundled XMind round trip works without setImmediate or Buffer", async () => {
	const code = await bundle();
	const desktop = await load(code, "desktop-writer");
	const xmindFile = await deflated(await desktop.writeArchive());
	const g = globalThis as Record<string, unknown>;
	const saved = { setImmediate: g.setImmediate, Buffer: g.Buffer };
	g.setImmediate = undefined;
	g.Buffer = undefined;
	try {
		const mobile = await load(code, "mobile");
		check(await mobile.roundTrip());
		check(await mobile.readArchive(xmindFile));
	} finally {
		g.setImmediate = saved.setImmediate;
		g.Buffer = saved.Buffer;
	}
});
