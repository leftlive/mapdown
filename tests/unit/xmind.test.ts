// XMind import and export (development plan phase 4): topic tree, skipped
// content, errors, the note written for a sheet, the title mapping of the
// export, and export -> import round trips on the core tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { parseDocument } from "../../src/core/parse.ts";
import { stateLineEdit } from "../../src/core/state.ts";
import { writeMapOutline } from "../../src/core/outline.ts";
import {
	readXmind,
	sheetNoteNames,
	sheetToNote,
	XmindImportError,
	type XmindDocument,
} from "../../src/xmind/read.ts";
import { buildXmindArchive, mapToXmindSheet, parseTitle, toExportTree } from "../../src/xmind/write.ts";
import { availableSiblingPath } from "../../src/xmind/paths.ts";

async function zip(files: Record<string, string>, compression: "STORE" | "DEFLATE" = "STORE"): Promise<Uint8Array> {
	const z = new JSZip();
	for (const [name, text] of Object.entries(files)) z.file(name, text);
	return z.generateAsync({ type: "uint8array", compression });
}

// The compression method of every local file header in a zip (0 STORE, 8 DEFLATE).
function zipMethods(data: ArrayBuffer | Uint8Array): number[] {
	const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const methods: number[] = [];
	let at = 0;
	while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
		methods.push(view.getUint16(at + 8, true));
		at += 30 + view.getUint32(at + 18, true) + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
	}
	return methods;
}

const topic = (title: string, extra: Record<string, unknown> = {}) => ({ id: title, title, ...extra });
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const SHEETS = [
	{
		title: "Main",
		rootTopic: topic("Root", {
			children: {
				attached: [
					topic("A", {
						href: "https://example.com/a",
						notes: { plain: { content: "line 1\r\nline 2" } },
						labels: ["tag"],
						markers: [{ markerId: "priority-1" }, { markerId: "task-done" }, { markerId: "flag-red" }],
					}),
					topic("B", {
						branch: "folded",
						children: { attached: [topic("B1")], callout: [topic("note")] },
						summaries: [{ id: "s", range: "(0,0)", topicId: "x" }],
						boundaries: [{ id: "b", range: "(0,0)" }],
					}),
					topic("Jump", { href: "xmind:#abc", image: { src: "xap:resources/a.png" } }),
					topic("Two\nlines"),
				],
				detached: [topic("Floating")],
			},
		}),
		relationships: [{ id: "r", end1Id: "A", end2Id: "B" }],
	},
	{ title: "Other/Sheet", rootTopic: topic("Second") },
];

async function readSheets(sheets: unknown): Promise<XmindDocument> {
	return readXmind(await zip({ "content.json": JSON.stringify(sheets) }));
}

test("import reads topics, link, note, labels, markers and floating topics", async () => {
	const doc = await readSheets(SHEETS);
	assert.equal(doc.sheets.length, 2);
	assert.equal(doc.topicCount, 8);
	assert.deepEqual(plain(doc.skipped), { summary: 1, boundary: 1, relationship: 1, callout: 1, image: 1 });
	assert.deepEqual(sheetNoteNames("Plan", doc.sheets), ["Plan - Main", "Plan - Other Sheet"]);
	assert.deepEqual(sheetNoteNames("Plan", doc.sheets.slice(0, 1)), ["Plan"]);

	const note = sheetToNote(doc.sheets[0], 1);
	const blockId = doc.sheets[0].root.children[1].blockId ?? "";
	assert.match(blockId, /^[a-z0-9-]+$/);
	const body = [
		"# Root",
		"- (P1) ✅ [A](https://example.com/a) `tag`",
		"    - 📝 line 1<br>line 2",
		`- B ^${blockId}`,
		"    - B1",
		"- Jump",
		"- Two<br>lines",
		"- Floating",
	].join("\n");
	assert.equal(
		note,
		`---\nmindmap-plugin: basic\nmindmark-state: {"version":2,"collapsed":["${blockId}"]}\n---\n\n${body}\n`,
	);
});

test("an imported note is a map the core saves unchanged", async () => {
	const doc = await readSheets(SHEETS);
	const note = sheetToNote(doc.sheets[0], 1);
	const parsed = parseDocument(note);
	assert.equal(parsed.frontmatter?.isMindmap, true);
	assert.equal(parsed.virtualRoot, false);
	assert.equal(parsed.root.text, "Root");
	assert.deepEqual(
		parsed.root.children.map((c) => c.text),
		["(P1) ✅ [A](https://example.com/a) `tag`", "B", "Jump", "Two\nlines", "Floating"],
	);
	// The folded node is the one the state names.
	const folded = parsed.root.children.find((c) => parsed.collapsed.has(c.id));
	assert.equal(folded?.text, "B");
	// Writing the body again gives the same text; the state line needs no change.
	const ids = [...parsed.collapsed].map((id) => parsed.root.children.find((c) => c.id === id)?.blockId ?? "");
	assert.deepEqual(stateLineEdit(note, parsed.frontmatter, ids), []);
	assert.equal(`${writeMapOutline(parsed.root, 1, "\n")}\n`, note.slice(parsed.bodyFrom).replace(/^\n+/, ""));
});

test("headLevel 0 still writes the root as a heading; deeper levels write headings", async () => {
	const doc = await readSheets(SHEETS);
	assert.match(sheetToNote(doc.sheets[0], 0), /\n# Root\n- /);
	const deep = sheetToNote(doc.sheets[0], 2);
	assert.match(deep, /\n# Root\n\n## \(P1\) ✅ \[A\]/);
	assert.equal(parseDocument(deep).root.children.length, 5);
});

test("an empty central topic takes the sheet title; the root is never collapsed", async () => {
	const doc = await readSheets([{ title: "Named", rootTopic: { id: "r", title: "", branch: "folded", children: { attached: [topic("x")] } } }]);
	assert.equal(doc.sheets[0].root.text, "Named");
	assert.equal(doc.sheets[0].root.collapsed, false);
	assert.match(sheetToNote(doc.sheets[0], 1), /"collapsed":\[\]/);
});

test("import errors carry a code", async () => {
	const failure = async (bytes: Uint8Array): Promise<string> => {
		try {
			await readXmind(bytes);
		} catch (err) {
			return err instanceof XmindImportError ? err.code : "other";
		}
		return "none";
	};
	assert.equal(await failure(new TextEncoder().encode("not a zip")), "parse");
	assert.equal(await failure(await zip({ "other.txt": "x" })), "unrecognized");
	assert.equal(await failure(await zip({ "content.json": "{oops" })), "parse");
	assert.equal(await failure(await zip({ "content.json": JSON.stringify([{ title: "Empty" }]) })), "parse");
	assert.equal(await failure(await zip({ "content.json": "[]" })), "parse");
	assert.equal(await failure(await zip({ "content.json": '{"a":1}' })), "parse");
});

// A tiny XML reader for the XMind 8 test file (Node has no DOMParser).
interface FakeEl {
	localName: string;
	children: FakeEl[];
	textContent: string;
	attrs: Record<string, string>;
	getAttribute(name: string): string | null;
}

function parseFakeXml(text: string): Document {
	const root: FakeEl = { localName: "#doc", children: [], textContent: "", attrs: {}, getAttribute: () => null };
	const stack: FakeEl[] = [root];
	const unescape = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
	for (const m of text.matchAll(/<(\/?)([\w:-]+)([^>]*?)(\/?)>|([^<]+)/g)) {
		const top = stack[stack.length - 1];
		if (m[5] !== undefined) {
			top.textContent += unescape(m[5]);
		} else if (m[1]) {
			const done = stack.pop();
			if (done) stack[stack.length - 1].textContent += done.textContent;
		} else {
			const attrs: Record<string, string> = {};
			for (const a of m[3].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
			const el: FakeEl = { localName: m[2].replace(/^.*:/, ""), children: [], textContent: "", attrs, getAttribute: (n) => attrs[n] ?? null };
			top.children.push(el);
			if (!m[4]) stack.push(el);
		}
	}
	const documentElement = root.children[0];
	return { documentElement, getElementsByTagName: () => [] } as unknown as Document;
}

test("XMind 8 content.xml imports like the new format", async () => {
	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmap-content version="2.0"><sheet id="s1"><topic id="t0"><title>Legacy Root</title><children><topics type="attached">
<topic id="t1" xlink:href="https://example.com/old"><title>Linked</title><notes><plain>Note &amp; more</plain></notes><labels><label>l1</label></labels><marker-refs><marker-ref marker-id="priority-2"/></marker-refs></topic>
<topic id="t2" branch="folded"><title>Folded</title><children><topics type="attached"><topic id="t3"><title>Inner</title></topic></topics></children></topic>
</topics><topics type="detached"><topic id="t4"><title>Free</title></topic></topics></children></topic><title>Sheet 1</title>
<relationships><relationship id="r1" end1="t1" end2="t2"/></relationships></sheet></xmap-content>`;
	const doc = await readXmind(await zip({ "content.xml": xml }), parseFakeXml);
	assert.equal(doc.sheets.length, 1);
	assert.equal(doc.skipped.relationship, 1);
	const texts: string[] = [];
	const walk = (n: { text: string; children: unknown[] }): void => {
		texts.push(n.text);
		(n.children as (typeof n)[]).forEach(walk);
	};
	walk(doc.sheets[0].root);
	assert.deepEqual(texts, [
		"Legacy Root",
		"(P2) [Linked](https://example.com/old) `l1`",
		"📝 Note & more",
		"Folded",
		"Inner",
		"Free",
	]);
	assert.equal(doc.sheets[0].root.children[1].collapsed, true);
});

test("title mapping: link, markers, labels, wiki links and formatting", () => {
	assert.deepEqual(plain(parseTitle("(P2) ✅ See [the **docs**](https://x.y/a) `a` `b`")), {
		title: "See the docs",
		href: "https://x.y/a",
		labels: ["a", "b"],
		markers: ["priority-2", "task-done"],
	});
	assert.deepEqual(plain(parseTitle("[[Note|Alias]] and [[Other]] ==hi== ~~no~~ *it* ![[pic.png]]")), {
		title: "Alias and Other hi no it ![[pic.png]]",
		href: "",
		labels: [],
		markers: [],
	});
	assert.equal(parseTitle("`only code`").title, "`only code`");
	assert.equal(parseTitle("a<br>b").title, "a\nb");
	assert.equal(parseTitle("[doc](file.pdf)").href, "");
});

const NOTE = [
	"---",
	"mindmap-plugin: basic",
	'mindmark-state: {"version":2,"collapsed":["fold-1"]}',
	"---",
	"",
	"# Root",
	"- (P1) ✅ [A](https://example.com/a) `tag`",
	"    - 📝 line 1<br>line 2",
	"- B ^fold-1",
	"    - B1",
	"- Two<br>lines",
	"",
].join("\n");

test("export maps the core tree to a Zen sheet", async () => {
	const doc = parseDocument(NOTE);
	const tree = toExportTree(doc.root, doc.collapsed);
	assert.equal(tree.collapsed, false);
	const sheet = mapToXmindSheet(tree, "Plan", "right");
	assert.equal(sheet.rootTopic.structureClass, "org.xmind.ui.logic.right");
	assert.equal(mapToXmindSheet(tree, "Plan", "mindmap").rootTopic.structureClass, "org.xmind.ui.map.unbalanced");
	assert.equal(mapToXmindSheet(tree, "Plan", "clockwise").rootTopic.structureClass, "org.xmind.ui.map.clockwise");
	const a = sheet.rootTopic.children?.attached[0];
	assert.deepEqual(plain({ title: a?.title, href: a?.href, labels: a?.labels, markers: a?.markers, notes: a?.notes, children: a?.children }), {
		title: "A",
		href: "https://example.com/a",
		labels: ["tag"],
		markers: [{ markerId: "priority-1" }, { markerId: "task-done" }],
		notes: { plain: { content: "line 1\nline 2" } },
	});
	assert.equal(sheet.rootTopic.children?.attached[1].branch, "folded");
	assert.equal(sheet.rootTopic.children?.attached[2].title, "Two\nlines");

	const archive = await buildXmindArchive(sheet, "1.0");
	const loaded = await JSZip.loadAsync(archive);
	assert.deepEqual(Object.keys(loaded.files).sort(), ["content.json", "manifest.json", "metadata.json"]);
	const content = JSON.parse(await loaded.file("content.json")!.async("text")) as { title: string }[];
	assert.equal(content.length, 1);
	assert.equal(content[0].title, "Plan");
	const meta = JSON.parse(await loaded.file("metadata.json")!.async("text")) as { creator: { name: string; version: string } };
	assert.deepEqual(meta.creator, { name: "Mapdown", version: "1.0" });
});

test("a virtual root exports under the file name; temporary expansion still counts as folded", async () => {
	const doc = parseDocument("---\nmindmap-plugin: basic\n---\n\n- one ^o1\n    - child\n- two\n");
	assert.equal(doc.virtualRoot, true);
	const one = doc.root.children[0];
	const tree = toExportTree(doc.root, new Set([one.id]), "File name");
	assert.equal(tree.text, "File name");
	assert.equal(tree.children[0].collapsed, true);
	const sheet = mapToXmindSheet(tree, "File name");
	assert.equal(sheet.rootTopic.title, "File name");
	assert.equal(sheet.rootTopic.children?.attached[0].branch, "folded");
	// A node that folds nothing (no children) is not marked folded.
	assert.equal(sheet.rootTopic.children?.attached[1].branch, undefined);
});

const withoutIds = (text: string): string =>
	text.replace(/\^[a-z0-9-]+/g, "^id").replace(/"collapsed":\["[^"]+"\]/, '"collapsed":["id"]');

test("export writes uncompressed entries; import still reads XMind's DEFLATE archives", async () => {
	const sheet = mapToXmindSheet(toExportTree(parseDocument(NOTE).root, new Set()), "Plan");
	// The plugin bundle carries only pako's inflate half (scripts/bundleOptions.mjs).
	assert.deepEqual(zipMethods(await buildXmindArchive(sheet, "1.0")), [0, 0, 0]);

	const deflated = await zip({ "content.json": JSON.stringify(SHEETS) }, "DEFLATE");
	assert.deepEqual(zipMethods(deflated), [8]);
	const doc = await readXmind(deflated);
	assert.equal(doc.topicCount, 8);
	assert.deepEqual(doc, await readSheets(SHEETS));
});

test("export then import gives back the same note", async () => {
	const doc = parseDocument(NOTE);
	const sheet = mapToXmindSheet(toExportTree(doc.root, doc.collapsed), "Plan", "right");
	const back = await readXmind(await buildXmindArchive(sheet, "1.0"));
	assert.equal(back.topicCount, 5);
	assert.equal(withoutIds(sheetToNote(back.sheets[0], 1)), withoutIds(NOTE));
});

test("round trip keeps depth, order, folding, notes and multi-line titles", async () => {
	const lines = [
		"---", "mindmap-plugin: basic", 'mindmark-state: {"version":2,"collapsed":["f2"]}', "---", "",
		"# Top", "", "## One", "- a", "    - a1", "    - a2 ^f2", "        - deep", "", "## Two",
		"- 📝 a note<br>second line", "- x<br>y", "",
	];
	const note = lines.join("\n");
	const doc = parseDocument(note);
	const back = await readXmind(await buildXmindArchive(mapToXmindSheet(toExportTree(doc.root, doc.collapsed), "T"), ""));
	const again = parseDocument(sheetToNote(back.sheets[0], 2));
	const flat = (root: typeof doc.root, collapsed: Set<string>): string[] => {
		const out: string[] = [];
		const walk = (n: typeof doc.root, d: number): void => {
			out.push(`${"  ".repeat(d)}${n.text.replace(/\n/g, "\\n")}${collapsed.has(n.id) ? " [folded]" : ""}`);
			n.children.forEach((c) => walk(c, d + 1));
		};
		walk(root, 0);
		return out;
	};
	assert.deepEqual(flat(again.root, again.collapsed), flat(doc.root, doc.collapsed));
});

test("XMind-visible text is plain: formatting marks are dropped on export", async () => {
	const doc = parseDocument("---\nmindmap-plugin: basic\n---\n\n# R\n- **bold** and ==mark== [[Page|shown]]\n");
	const sheet = mapToXmindSheet(toExportTree(doc.root, doc.collapsed), "R");
	assert.equal(sheet.rootTopic.children?.attached[0].title, "bold and mark shown");
});

test("export file name is next to the note and numbered when taken", () => {
	const taken = new Set(["a/Plan.xmind", "a/Plan 1.xmind"]);
	assert.equal(availableSiblingPath("a", "Plan", "xmind", (p) => taken.has(p)), "a/Plan 2.xmind");
	assert.equal(availableSiblingPath("", "Plan", "xmind", () => false), "Plan.xmind");
});
