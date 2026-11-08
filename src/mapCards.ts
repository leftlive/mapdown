// Map embeds inside map nodes (behaviour spec 5.10, "节点里的导图嵌入"): which
// `![[…]]` in a map's node texts name map notes, the label of each card, and
// opening the map a card names. Map views and embedded maps put the labels in
// their render model; the renderer draws the cards (src/view/renderer.ts).
// Whether a note is a map is the plugin's own check (isMapFileSync).

import { Keymap, TFile, type PaneType } from 'obsidian';
import { subpathNode } from './core/embed.ts';
import { blockOf, cardLabel, findEmbeds, type EmbedSpan } from './core/mapCard.ts';
import { parseDocument } from './core/parse.ts';
import type { MapNode } from './core/types.ts';
import { nodeLine } from './controller/sourceLines.ts';
import type MapdownPlugin from './main.ts';

/** Block texts of a map note by lower-case block id; `loading` while (re)reading it. */
interface Blocks {
	texts: Map<string, string> | null;
	loading: boolean;
}

/** Lower-case file name of a link path or vault path, without folder and `.md`. */
function nameOf(path: string): string {
	return (path.split('/').pop() ?? '').replace(/\.md$/i, '').toLowerCase();
}

export class MapCards {
	private readonly plugin: MapdownPlugin;
	private readonly blocks = new Map<string, Blocks>();
	/** Names of every embed target looked up, so only changes to those notes redraw. */
	private readonly names = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private timer: number | null = null;
	/** Changes whenever a label may have changed; views cache their labels by it. */
	version = 0;

	constructor(plugin: MapdownPlugin) {
		this.plugin = plugin;
		const { vault, metadataCache } = plugin.app;
		plugin.registerEvent(vault.on('modify', (f) => {
			if (f instanceof TFile && this.blocks.has(f.path)) this.readBlocks(f);
		}));
		plugin.registerEvent(vault.on('create', (f) => this.touched(f.path)));
		plugin.registerEvent(vault.on('delete', (f) => {
			this.blocks.delete(f.path);
			this.touched(f.path);
		}));
		plugin.registerEvent(vault.on('rename', (f, old) => {
			this.blocks.delete(old);
			this.touched(old);
			this.touched(f.path);
		}));
		// a note became a map, or stopped being one
		plugin.registerEvent(metadataCache.on('changed', (f) => this.touched(f.path)));
		plugin.register(() => {
			if (this.timer !== null) window.clearTimeout(this.timer);
			this.timer = null;
			this.listeners.clear();
		});
	}

	/** Call `fn` (soon, once per batch) when labels may have changed; returns the unsubscribe. */
	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	/** Card labels of the map embeds in the node texts under `root`, keyed by the link inside the brackets. */
	labels(root: MapNode, sourcePath: string): ReadonlyMap<string, string> {
		const out = new Map<string, string>();
		const seen = new Set<string>();
		const stack: MapNode[] = [root];
		while (stack.length > 0) {
			const node = stack.pop() as MapNode;
			if (node.text.includes('![[')) {
				for (const e of findEmbeds(node.text)) {
					if (seen.has(e.raw)) continue;
					seen.add(e.raw);
					const label = this.label(e, sourcePath);
					if (label !== null) out.set(e.raw, label);
				}
			}
			for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
		}
		return out;
	}

	/** Open the map a card names (spec 5.10): like an internal link (`linkOpenMode`), then select and centre its node. */
	async open(link: string, sourcePath: string, evt: MouseEvent, from: HTMLElement): Promise<void> {
		const e = findEmbeds(`![[${link}]]`)[0];
		const file = e ? this.resolve(e.target, sourcePath) : null;
		if (!e || !file) return;
		const plugin = this.plugin;
		const mode = plugin.settings.linkOpenMode;
		const pane: PaneType | boolean = Keymap.isModEvent(evt) || (mode === 'current' ? false : mode);
		let line: number | null = null;
		if (e.subpath !== '') {
			const doc = parseDocument(await plugin.app.vault.cachedRead(file));
			const node = subpathNode(doc.root, e.subpath);
			line = node ? nodeLine(doc, node.id) : null;
		}
		await plugin.openMapAt(plugin.leafFor(pane, from), file, line);
	}

	/** The map note a link target names from `sourcePath`; null when it is no map (or missing). */
	private resolve(target: string, sourcePath: string): TFile | null {
		const app = this.plugin.app;
		this.names.add(nameOf(target === '' ? sourcePath : target));
		const f = target === '' ? app.vault.getAbstractFileByPath(sourcePath) : app.metadataCache.getFirstLinkpathDest(target, sourcePath);
		return f instanceof TFile && this.plugin.isMapFileSync(f) ? f : null;
	}

	private label(e: EmbedSpan, sourcePath: string): string | null {
		const file = this.resolve(e.target, sourcePath);
		if (!file) return null;
		const block = blockOf(e.subpath);
		return cardLabel(file.basename, e, block === null ? undefined : this.blockText(file, block));
	}

	/** Text of the node with block id `id`; null until the note was read, or when there is none (`^id` shows). */
	private blockText(file: TFile, id: string): string | null {
		const b = this.blocks.get(file.path);
		if (!b) {
			this.readBlocks(file);
			return null;
		}
		return b.texts?.get(id.toLowerCase()) ?? null;
	}

	/** (Re)read the block texts of a map note; labels change (and views redraw) only when they differ. */
	private readBlocks(file: TFile): void {
		const prev = this.blocks.get(file.path);
		if (prev?.loading) return;
		const entry: Blocks = { texts: prev?.texts ?? null, loading: true };
		this.blocks.set(file.path, entry);
		void this.plugin.app.vault.cachedRead(file).then(
			(text) => {
				if (this.blocks.get(file.path) !== entry) return; // renamed or deleted meanwhile
				const texts = new Map<string, string>();
				const stack: MapNode[] = [parseDocument(text).root];
				while (stack.length > 0) {
					const node = stack.pop() as MapNode;
					const id = node.blockId?.toLowerCase();
					if (id && !texts.has(id)) texts.set(id, node.text);
					for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
				}
				const old = entry.texts;
				entry.texts = texts;
				entry.loading = false;
				const same = old !== null && old.size === texts.size && [...texts].every(([k, v]) => old.get(k) === v);
				if (!same) this.changed();
			},
			() => {
				entry.loading = false;
			},
		);
	}

	/** A note was created, deleted, renamed or re-indexed: redraw if a card may name it. */
	private touched(path: string): void {
		if (this.names.has(nameOf(path))) this.changed();
	}

	private changed(): void {
		this.version++;
		if (this.timer !== null) return;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			for (const fn of [...this.listeners]) fn();
		}, 0);
	}
}
