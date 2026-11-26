// The Properties panel of a map note (behaviour spec 5.16 item 4): the rows
// `mindmap-plugin` and `mindmark-state` mean nothing to a reader, so they are
// hidden and one line says "Mind map · 3 collapsed · Right"; a click opens the
// note as a map. Hiding is done by a class on the view (styles.css), so it
// holds whenever Obsidian re-renders the rows. The line is a node of ours inside
// Obsidian's panel and does not survive a re-render, so a MutationObserver on
// the view puts it back whenever a properties element is added. The note's text
// decides (core/noteInfo.ts): an unreadable `mindmark-state` hides nothing.

import { MarkdownView, setIcon } from 'obsidian';
import { noteInfoOf, noteInfoText } from './core/noteInfo.ts';
import { t, type StringKey } from './i18n.ts';
import type MapdownPlugin from './main.ts';
import { DOM } from './view/contract.ts';

/** Classes of the elements Obsidian adds when it (re)draws the panel. */
const PANEL = ['metadata-container', 'metadata-content', 'metadata-properties', 'metadata-property'];

export class PropertiesInfo {
	private readonly plugin: MapdownPlugin;
	private readonly observers = new WeakMap<MarkdownView, MutationObserver>();
	private readonly live = new Set<MutationObserver>();
	private readonly pending = new WeakSet<MarkdownView>();

	constructor(plugin: MapdownPlugin) {
		this.plugin = plugin;
		const ws = plugin.app.workspace;
		plugin.registerEvent(ws.on('layout-change', () => this.sync()));
		plugin.registerEvent(ws.on('file-open', () => this.sync()));
		plugin.registerEvent(plugin.app.metadataCache.on('changed', () => this.sync()));
		plugin.register(() => {
			for (const o of this.live) o.disconnect();
			this.live.clear();
			ws.iterateAllLeaves((leaf) => {
				if (leaf.view instanceof MarkdownView) this.clear(leaf.view);
			});
		});
	}

	/** Every Markdown view takes the current setting and note text. */
	sync(): void {
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) return;
			this.watch(view);
			this.update(view);
		});
	}

	private watch(view: MarkdownView): void {
		if (this.observers.has(view)) return;
		const o = new MutationObserver((records) => {
			const panel = records.some((r) => Array.from(r.addedNodes).some((n) => n.instanceOf(Element) && PANEL.some((c) => n.classList.contains(c))));
			if (!panel || this.pending.has(view)) return;
			this.pending.add(view);
			view.containerEl.win.requestAnimationFrame(() => {
				this.pending.delete(view);
				this.update(view);
			});
		});
		o.observe(view.contentEl, { childList: true, subtree: true });
		this.observers.set(view, o);
		this.live.add(o);
	}

	private clear(view: MarkdownView): void {
		view.containerEl.removeClass(DOM.propsHidden);
		view.containerEl.querySelectorAll(`.${DOM.noteInfo}`).forEach((e) => e.remove());
	}

	private update(view: MarkdownView): void {
		const info = this.plugin.settings.markdownNotes && this.plugin.isMapFileSync(view.file) ? noteInfoOf(view.getViewData()) : null;
		if (!info) {
			this.clear(view);
			return;
		}
		view.containerEl.addClass(DOM.propsHidden);
		const text = noteInfoText(info, {
			map: t('info-map'),
			collapsed: (n) => t('info-collapsed', n),
			direction: (d) => t(`set-dir-${d}` as StringKey),
		});
		for (const box of Array.from(view.contentEl.querySelectorAll('.metadata-container'))) {
			if (box.closest('.internal-embed')) continue;
			const props = box.querySelector('.metadata-properties');
			if (!props?.parentElement) continue;
			let line = box.querySelector<HTMLElement>(`.${DOM.noteInfo}`);
			if (!line) {
				line = createDiv({ cls: DOM.noteInfo });
				setIcon(line.createSpan(), 'git-fork');
				line.createSpan();
				line.addEventListener('click', () => void this.plugin.setMindmapView(view.leaf));
				props.parentElement.insertBefore(line, props);
			}
			const label = line.lastElementChild;
			if (label && label.textContent !== text) label.textContent = text;
		}
	}
}
