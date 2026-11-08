// Maps embedded in notes (behaviour spec 5.10). One Markdown post-processor
// sees every section of an embedded map note; once the section is attached it
// decides whether the `.internal-embed` around it is taken over (core/embed.ts).
// A taken-over embed keeps Obsidian's content but hides it and shows a
// read-only renderer (the map view's, with `readOnly`) in a MarkdownRenderChild.
// The renderer exists only while the embed is on screen. Every embed of a file
// shares one parse, refreshed from vault events.

import {
	Component,
	Keymap,
	MarkdownRenderChild,
	Platform,
	TFile,
	resolveSubpath,
	setIcon,
	type MarkdownPostProcessorContext,
	type PaneType,
} from 'obsidian';
import { ActiveSlot, HINT_SHOW_MS, TIP_FADE_MS, TIP_SHOW_MS, TipGate, hintDue, isZoomWheel } from './core/embedActive.ts';
import { embedHeight, embedSubpath, shouldTakeOver, subpathNode } from './core/embed.ts';
import { parseDocument } from './core/parse.ts';
import { taskProgress, type TaskCount } from './core/tasks.ts';
import type { ParsedDoc } from './core/types.ts';
import { nodeLine } from './controller/sourceLines.ts';
import { t } from './i18n.ts';
import type MapdownPlugin from './main.ts';
import { DOM, type MapRenderer } from './view/contract.ts';
import { markdownHost, settingsLook } from './view/MapView.ts';
import { createRenderer } from './view/renderer.ts';
import type { Viewport } from './view/viewport.ts';

/** On Obsidian's `.internal-embed` while the map shows: its own content is hidden (styles.css). */
const HOST = 'mapdown-embed-host';
/** Sections are attached a frame or two after the post-processor runs; map-node renders may never be. */
const ATTACH_FRAMES = 5;

interface Shared {
	embeds: Set<MapEmbed>;
	/** undefined: not read (or stale); null: not shown as a map (unsupported state). */
	doc?: ParsedDoc | null;
	counts?: ReadonlyMap<string, TaskCount>;
	loading?: Promise<void> | null;
}

export class EmbedManager {
	readonly plugin: MapdownPlugin;
	private readonly files = new Map<string, Shared>();
	private readonly taken = new WeakSet<Element>();
	/** The embed being operated on; at most one in the whole app (spec 5.10). */
	private readonly active = new ActiveSlot<MapEmbed>();
	/** The embed showing the first-use tip; at most one, and once ever (the flag is saved in data.json). */
	private readonly tip = new TipGate<MapEmbed>();

	constructor(plugin: MapdownPlugin) {
		this.plugin = plugin;
		const vault = plugin.app.vault;
		plugin.registerMarkdownPostProcessor((el, ctx) => this.process(el, ctx));
		plugin.registerEvent(vault.on('modify', (f) => this.changed(f.path)));
		plugin.registerEvent(vault.on('delete', (f) => this.gone(f.path)));
		plugin.registerEvent(vault.on('rename', (_f, old) => this.gone(old)));
		// the tab showing the note lost focus
		plugin.registerEvent(plugin.app.workspace.on('active-leaf-change', (leaf) => {
			const e = this.active.current;
			if (e && !leaf?.view.containerEl.contains(e.containerEl)) e.setActive(false);
		}));
		// the embeds hang on the note's render context, which the plugin's unload does not reach
		plugin.register(() => this.unloadAll());
	}

	/** Plugin unload (disable or reload): no embed stays on screen with this plugin's listeners. */
	private unloadAll(): void {
		const live = [...this.files.values()].flatMap((s) => [...s.embeds]); // remove() changes the sets
		for (const e of live) e.unload();
		const a = this.active.current;
		if (a) this.active.deactivate(a);
		this.files.clear();
	}

	/** Settings changed: embeds turn on or off, take the new height and redraw. */
	applySettings(): void {
		for (const s of this.files.values()) for (const e of s.embeds) e.apply();
	}

	/** May `e` show the first-use tip now? Then the flag is saved at once, so it never shows again. */
	claimTip(e: MapEmbed): boolean {
		if (!this.tip.claim(e, this.plugin.embedTipShown)) return false;
		void this.plugin.setEmbedTipShown(true);
		return true;
	}

	releaseTip(e: MapEmbed): void {
		this.tip.release(e);
	}

	/** `e` became active (or inactive); the one that was active before goes inactive. */
	setActive(e: MapEmbed, on: boolean): void {
		if (on) this.active.activate(e)?.setActive(false);
		else this.active.deactivate(e);
	}

	private process(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		const path = ctx.sourcePath;
		const app = this.plugin.app;
		if (app.metadataCache.getCache(path)?.frontmatter?.['mindmap-plugin'] !== 'basic') return;
		let frames = 0;
		const check = (): void => {
			if (!el.isConnected) {
				if (++frames < ATTACH_FRAMES) el.win.requestAnimationFrame(check);
				return;
			}
			const host = el.closest<HTMLElement>('.internal-embed');
			const place = {
				inEmbed: host !== null,
				inPopover: !!host?.closest('.hover-popover'),
				inMap: el.closest(`.${DOM.node}, .${DOM.view}`) !== null,
				inMapEmbed: !!host?.parentElement?.closest(`.${DOM.embed}`),
				taken: host !== null && this.taken.has(host),
			};
			if (!host || !shouldTakeOver(place)) return;
			this.taken.add(host);
			const file = app.vault.getAbstractFileByPath(path);
			const cache = app.metadataCache.getCache(path);
			const sub = embedSubpath(host.getAttribute('src'));
			// a heading or block that does not exist: Obsidian's default display
			if (!(file instanceof TFile) || !cache || (sub !== '' && !resolveSubpath(cache, `#${sub}`))) return;
			// Obsidian unloads render children outside the embed's own preview once it renders
			// visibly (embedMaps off); a holder on that element keeps the map's child alive
			const pv = el.closest<HTMLElement>('.markdown-preview-view');
			const holder = new MarkdownRenderChild(pv && host.contains(pv) ? pv : el);
			holder.addChild(new MapEmbed(this, host, file, sub));
			ctx.addChild(holder);
		};
		el.win.requestAnimationFrame(check);
	}

	add(e: MapEmbed): void {
		let s = this.files.get(e.file.path);
		if (!s) this.files.set(e.file.path, (s = { embeds: new Set() }));
		s.embeds.add(e);
	}

	/** An unloaded embed; Live Preview may render the same element again, which is then taken over anew. */
	remove(e: MapEmbed, path: string, host: HTMLElement): void {
		this.taken.delete(host);
		const s = this.files.get(path);
		if (s?.embeds.delete(e) && s.embeds.size === 0) this.files.delete(path);
	}

	/** The parsed file, read once for every embed of it. */
	async load(file: TFile): Promise<Shared | null> {
		const s = this.files.get(file.path);
		if (!s) return null;
		if (s.doc === undefined) {
			if (!s.loading) {
				const p: Promise<void> = this.plugin.app.vault.read(file).then(parseDocument, () => null).then((doc) => {
					if (s.loading !== p) return; // the file changed again meanwhile
					s.doc = doc && !doc.frontmatter?.stateError ? doc : null;
					s.counts = undefined;
					s.loading = null;
				});
				s.loading = p;
			}
			await s.loading;
		}
		return s;
	}

	private changed(path: string): void {
		const s = this.files.get(path);
		if (!s) return;
		s.doc = undefined;
		s.loading = null;
		for (const e of s.embeds) e.refresh();
	}

	/** Deleted or renamed: Obsidian's default display. */
	private gone(path: string): void {
		for (const e of this.files.get(path)?.embeds ?? []) e.unload();
		this.files.delete(path);
	}
}

class MapEmbed extends MarkdownRenderChild {
	readonly file: TFile;
	private readonly manager: EmbedManager;
	private readonly host: HTMLElement;
	private readonly sub: string;
	private readonly path: string;
	private renderer: MapRenderer | null = null;
	/** Owns the Markdown rendered into the nodes; unloaded with the renderer. */
	private parts: Component | null = null;
	private io: IntersectionObserver | null = null;
	private mo: MutationObserver | null = null;
	/** Pan and zoom of a released renderer, put back when it is drawn again. */
	private saved: Viewport | null = null;
	private visible = false;
	/** The subpath was not found in the file: Obsidian's default display until the file changes. */
	private declined = false;
	private dead = false;
	private active = false;
	/** Listeners and observer that exist only while active. */
	private activeAbort: AbortController | null = null;
	private activeIo: IntersectionObserver | null = null;
	private hintEl: HTMLElement | null = null;
	private hintAt: number | null = null;
	private hintTimer: number | null = null;
	private tipEl: HTMLElement | null = null;
	private tipTimer: number | null = null;

	constructor(manager: EmbedManager, host: HTMLElement, file: TFile, sub: string) {
		super(host.createDiv({ cls: DOM.embed }));
		this.manager = manager;
		this.host = host;
		this.file = file;
		this.path = file.path;
		this.sub = sub;
	}

	private get settings(): MapdownPlugin['settings'] {
		return this.manager.plugin.settings;
	}

	onload(): void {
		const el = this.containerEl;
		const win = el.win as Window & { IntersectionObserver: typeof IntersectionObserver; MutationObserver: typeof MutationObserver };
		const bar = el.createDiv({ cls: 'mapdown-embed-actions' });
		const button = (action: string, icon: string, label: string, run: (e: MouseEvent) => void): void => {
			const b = bar.createEl('button', { cls: 'clickable-icon', attr: { [DOM.actionAttr]: action, 'aria-label': label } });
			setIcon(b, icon);
			b.addEventListener('click', (e) => {
				e.preventDefault();
				run(e);
			});
		};
		button('fit', 'maximize', t('fit-view'), () => this.renderer?.fit());
		button('open-map', 'mapdown', t('open-in-map'), (e) => void this.open(Keymap.isModEvent(e), null));
		this.hintEl = el.createDiv({ cls: DOM.embedHint, text: t('embed-hint', Platform.isMacOS ? '⌘' : 'Ctrl') });
		// a mouse press anywhere in the box (buttons and links included) activates it; touch is left alone
		this.registerDomEvent(el, 'pointerdown', (e) => {
			this.clearTip();
			if (e.pointerType !== 'touch') this.setActive(true);
		});
		// a plain wheel while inactive scrolls the note; say how to operate the map
		if (!Platform.isMobile) {
			this.registerDomEvent(el, 'wheel', (e) => {
				if (!this.active && !isZoomWheel(e, Platform.isMacOS)) this.showHint();
			}, { passive: true });
		}
		// Live Preview would move its cursor here; the note's own link handling must not see our clicks
		// (hovering a link is left to the note, which shows its page preview)
		for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick'] as const) {
			this.registerDomEvent(el, type, (e) => e.stopPropagation());
		}
		// Live Preview detaches and reattaches the widget while scrolling without unloading it
		this.io = new win.IntersectionObserver((entries) => this.onVisible(entries[entries.length - 1]?.isIntersecting ?? false), { rootMargin: '200px' });
		this.io.observe(el);
		// Live Preview edits `|300` in place on the same element
		this.mo = new win.MutationObserver(() => this.apply());
		this.mo.observe(this.host, { attributes: true, attributeFilter: ['width', 'height'] });
		this.manager.add(this);
		// a map card's label changed (spec 5.10)
		this.register(this.manager.plugin.cards.subscribe(() => this.apply()));
		this.apply();
	}

	onunload(): void {
		this.dead = true;
		this.setActive(false);
		this.clearHint();
		this.clearTip();
		this.io?.disconnect();
		this.mo?.disconnect();
		this.io = this.mo = null;
		this.release();
		this.host.removeClass(HOST);
		this.containerEl.remove();
		this.manager.remove(this, this.path, this.host);
	}

	/** Show or hide the map for the settings; height from `|N` or the default. */
	apply(): void {
		if (this.dead) return;
		const s = this.settings;
		const on = s.embedMaps && !this.declined;
		this.host.toggleClass(HOST, on);
		this.containerEl.setCssProps({ '--mapdown-embed-height': `${embedHeight(this.host.getAttribute('width'), this.host.getAttribute('height'), s.embedHeight)}px` });
		if (!on) {
			this.setActive(false);
			this.release();
		} else if (this.visible) void this.draw();
	}

	/** The file changed: draw it again (a declined subpath may exist now). */
	refresh(): void {
		this.declined = false;
		this.apply();
	}

	/** Drawn near the screen (200 px ahead), released once it leaves (spec 5.10, performance). */
	private onVisible(visible: boolean): void {
		this.visible = visible;
		if (!visible) this.setActive(false);
		if (visible) void this.draw();
		else this.release();
	}

	/** Active: the plain wheel pans, the border takes the accent colour (spec 5.10). Never saved. */
	setActive(on: boolean): void {
		if (on === this.active || (on && this.dead)) return;
		this.active = on;
		const el = this.containerEl;
		el.toggleClass(DOM.embedActive, on);
		if (this.renderer) this.renderer.wheelPan = on;
		this.manager.setActive(this, on);
		this.activeAbort?.abort();
		this.activeIo?.disconnect();
		this.activeAbort = this.activeIo = null;
		if (!on) return;
		this.clearHint();
		const abort = (this.activeAbort = new AbortController());
		const doc = el.doc;
		// outside press and Esc end it; the events go on to whoever else wants them
		doc.addEventListener('pointerdown', (e) => {
			if (!(e.target instanceof Node) || !el.contains(e.target)) this.setActive(false);
		}, { capture: true, signal: abort.signal });
		doc.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') this.setActive(false);
		}, { capture: true, signal: abort.signal });
		// scrolled out of view (no margin, unlike the drawing observer)
		const IO = (el.win as Window & { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver;
		this.activeIo = new IO((entries) => {
			if (!(entries[entries.length - 1]?.isIntersecting ?? true)) this.setActive(false);
		});
		this.activeIo.observe(el);
	}

	/** Fade the hint in for about 1.5 s; not again while it was shown moments ago. */
	private showHint(): void {
		const win = this.containerEl.win;
		const now = win.performance.now();
		if (!this.hintEl || this.tipEl || !hintDue(this.hintAt, now)) return;
		this.hintAt = now;
		this.hintEl.addClass('is-shown');
		if (this.hintTimer !== null) win.clearTimeout(this.hintTimer);
		this.hintTimer = win.setTimeout(() => this.clearHint(), HINT_SHOW_MS);
	}

	/** The first-use tip (spec 5.10): top centre, Obsidian-notice look, ~6 s, closable. Once ever, one at a time. */
	private showTip(): void {
		if (this.tipEl || !this.manager.claimTip(this)) return;
		const el = this.containerEl;
		const win = el.win;
		this.clearHint();
		const tip = (this.tipEl = el.createDiv({ cls: DOM.embedTip, attr: { role: 'status' } }));
		tip.createSpan({ cls: 'mapdown-embed-tip-text', text: Platform.isMobile ? t('embed-tip-mobile') : t('embed-tip', Platform.isMacOS ? '⌘' : 'Ctrl') });
		const close = tip.createEl('button', { cls: `clickable-icon ${DOM.embedTip}-close`, attr: { 'aria-label': t('embed-tip-close') } });
		setIcon(close, 'x');
		close.addEventListener('click', (e) => {
			e.preventDefault();
			this.clearTip();
		});
		win.requestAnimationFrame(() => this.tipEl === tip && tip.addClass('is-shown'));
		this.tipTimer = win.setTimeout(() => {
			tip.removeClass('is-shown');
			this.tipTimer = win.setTimeout(() => this.clearTip(), TIP_FADE_MS);
		}, TIP_SHOW_MS);
	}

	private clearTip(): void {
		if (this.tipTimer !== null) this.containerEl.win.clearTimeout(this.tipTimer);
		this.tipTimer = null;
		this.tipEl?.remove();
		this.tipEl = null;
		this.manager.releaseTip(this);
	}

	private clearHint(): void {
		if (this.hintTimer !== null) this.containerEl.win.clearTimeout(this.hintTimer);
		this.hintTimer = null;
		this.hintEl?.removeClass('is-shown');
	}

	private release(): void {
		if (!this.renderer) return;
		this.saved = this.renderer.viewport;
		this.renderer.destroy();
		this.renderer = null;
		if (this.parts) this.removeChild(this.parts);
		this.parts = null;
	}

	private async draw(): Promise<void> {
		const shared = await this.manager.load(this.file);
		const s = this.settings;
		if (this.dead || !this.visible || !s.embedMaps || this.declined || !shared) return;
		const doc = shared.doc;
		if (doc === undefined) return; // changed while reading; the refresh draws it
		const focus = doc && this.sub ? subpathNode(doc.root, this.sub) : null;
		if (!doc || (this.sub && !focus)) {
			this.declined = true;
			this.apply();
			return;
		}
		const fresh = !this.renderer;
		const parts = (this.parts ??= this.addChild(new Component()));
		const r = (this.renderer ??= createRenderer(this.containerEl, markdownHost(this.manager.plugin.app, () => this.file.path, parts, this.containerEl), {
			nodeClick: () => {},
			nodeDoubleClick: (id) => void this.open(false, id),
			backgroundClick: () => {},
			boxSelect: () => {},
			drop: () => {},
			contextMenu: () => {},
			editInput: () => {},
			linkClick: (href, evt) => this.manager.plugin.openLink(href, this.file.path, evt),
			cardClick: (link, evt) => void this.manager.plugin.cards.open(link, this.file.path, evt, this.containerEl),
			viewportChange: () => {},
		}));
		r.update({
			root: doc.virtualRoot ? { ...doc.root, text: this.file.basename } : doc.root,
			hidden: doc.collapsed,
			focusId: focus?.id ?? null,
			selection: [],
			primary: null,
			...settingsLook(s),
			taskProgress: s.showTaskProgress ? (shared.counts ??= taskProgress(doc.root)) : undefined,
			mapCards: this.manager.plugin.cards.labels(doc.root, this.file.path),
			readOnly: true,
		});
		r.wheelPan = this.active;
		if (fresh && this.saved) r.restoreViewport(this.saved);
		this.saved = null;
		if (fresh) this.showTip();
	}

	/** "Open in map" and double click: the map in this tab (Mod: a new one), the node selected and centred. */
	private async open(pane: PaneType | boolean, id: string | null): Promise<void> {
		const plugin = this.manager.plugin;
		// "this tab" is the one showing the note, which need not be the active one
		const target = plugin.leafFor(pane, this.containerEl);
		const doc = (await this.manager.load(this.file))?.doc;
		const line = id && doc ? nodeLine(doc, id) : null;
		await plugin.openMapAt(target, this.file, line);
	}
}
