// Presentation mode of a map view (behaviour spec 5.13): where the presentation
// stands (src/core/presentation.ts holds the rules), the breadcrumb, progress
// bar and exit hint built for it, their scale, and full screen. The renderer
// draws the look (classes only) and flies the camera. The view owns the
// presentation's fold state and saves and restores pan, zoom and selection
// around it (src/view/MapView.ts).

import { setIcon } from 'obsidian';
import {
	fitCrumbs,
	indexTree,
	jumpTo,
	pathTo,
	plainLabel,
	presentFrame,
	presentLook,
	presentRoute,
	presentStep,
	relocate,
	shownStep,
	type PresentMove,
	type PresentState,
	type TreeIndex,
} from '../core/presentation.ts';
import type { MapNode } from '../core/types.ts';
import { t } from '../i18n.ts';
import { DOM, type MapRenderer } from './contract.ts';

/** View width at which the breadcrumb, bar and hint are drawn at 1×, and their largest scale (spec 5.13). */
const SCALE_WIDTH = 1440;
const SCALE_MAX = 1.6;
/** The breadcrumb collapses its middle beyond this share of the view width. */
const CRUMBS_SHARE = 0.6;
const LEVELS = [null, 1, 2, 3] as const;

export interface PresentHost {
	/** The view's content element: the bar, breadcrumb and hint go in here, and it is what goes full screen. */
	readonly container: HTMLElement;
	renderer(): MapRenderer | null;
	/** The map's root as it is now. */
	root(): MapNode | null;
	/** The presentation's fold state: ids whose children are not drawn. */
	hidden(): ReadonlySet<string>;
	/** Asked to end the presentation (full screen was left, the × was tapped); the view then calls `destroy`. */
	exit(): void;
}

export class Presentation {
	private readonly host: PresentHost;
	/** Phones and tablets: no full screen, an exit button instead of the Esc hint. */
	private readonly touch: boolean;
	private readonly abort = new AbortController();
	private index: TreeIndex | null = null;
	private route: string[] = [];
	private state: PresentState = { current: '', leaf: null, overview: 'off' };
	/** Ids from the root to the current node when last shown, to fall back on after the map changed. */
	private path: string[] = [];
	/** Level limit of the route: null for all. */
	private level: number | null = null;
	/** The "…" of the breadcrumb was clicked: the full path shows until the next move. */
	private crumbsOpen = false;
	private bar: HTMLElement | null = null;
	private crumbs: HTMLElement | null = null;
	private hint: HTMLElement | null = null;
	private prev: HTMLButtonElement | null = null;
	private next: HTMLButtonElement | null = null;
	private overview: HTMLButtonElement | null = null;
	private count: HTMLElement | null = null;
	private fill: HTMLElement | null = null;
	private select: HTMLSelectElement | null = null;
	private resize: ResizeObserver | null = null;
	private scale = '';
	/** The container is (or was during this presentation) full screen because we asked. */
	private fullscreen = false;
	private closed = false;

	constructor(host: PresentHost, touch: boolean) {
		this.host = host;
		this.touch = touch;
	}

	/** Build the bar, breadcrumb and hint, go full screen (desktop), and show `from` (a click on it), else the root, without a flight. */
	start(from: string | null): void {
		this.build();
		if (!this.touch) this.requestFullscreen();
		this.reindex();
		const index = this.index;
		if (!index) return;
		this.state = from !== null && from !== index.root && index.node.has(from) ? jumpTo(index, this.host.hidden(), from) : jumpTo(index, this.host.hidden(), index.root);
		this.show(false);
	}

	get current(): PresentState {
		return this.state;
	}

	/** A key, button or swipe. */
	act(move: PresentMove): void {
		if (this.closed || !this.index) return;
		this.go(presentStep(this.state, move, this.route, this.index));
	}

	/** A click on a node or a breadcrumb segment. */
	jump(id: string): void {
		if (this.closed || !this.index || !this.index.node.has(id)) return;
		const next = jumpTo(this.index, this.host.hidden(), id);
		const s = this.state;
		// the same place again (after panning away, say): only the camera comes back
		if (next.current === s.current && next.leaf === s.leaf && next.overview === s.overview) this.aim(true);
		else this.go(next);
	}

	/**
	 * The map was drawn again: its text changed elsewhere, or a fold was toggled (`aim`). The route is
	 * recomputed; the current node stays, or falls back to its nearest remaining ancestor. The camera
	 * is re-aimed when `aim` or when the current node changed.
	 */
	refresh(aim: boolean): void {
		if (this.closed) return;
		this.reindex();
		if (!this.index) return;
		const before = this.state;
		this.state = relocate(before, this.index, this.host.hidden(), this.path);
		const moved = this.state.current !== before.current;
		if (aim || moved) {
			this.show(true);
			return;
		}
		this.host.renderer()?.setPresentation(presentLook(this.state, this.index, this.host.hidden()));
		this.updateUi();
	}

	/** Remove the bar, breadcrumb and hint, stop listening, end the renderer's presentation (it restores pan and zoom) and leave full screen. */
	destroy(): void {
		if (this.closed) return;
		this.closed = true;
		this.abort.abort();
		this.resize?.disconnect();
		this.resize = null;
		this.bar?.remove();
		this.crumbs?.remove();
		this.hint?.remove();
		this.bar = this.crumbs = this.hint = this.prev = this.next = this.overview = this.count = this.fill = this.select = null;
		const el = this.host.container;
		el.setCssProps({ '--mapdown-present-scale': '' });
		this.host.renderer()?.setPresentation(null);
		const doc = el.ownerDocument;
		if (doc.fullscreenElement === el) void doc.exitFullscreen().catch(() => undefined);
	}

	private reindex(): void {
		const root = this.host.root();
		if (!root) return;
		this.index = indexTree(root);
		this.route = presentRoute(root, this.host.hidden(), this.level);
	}

	private go(next: PresentState): void {
		const s = this.state;
		if (next.current === s.current && next.leaf === s.leaf && next.overview === s.overview) return;
		this.state = next;
		this.show(true);
	}

	private show(animate: boolean): void {
		const r = this.host.renderer();
		const index = this.index;
		if (!r || !index) return;
		const hidden = this.host.hidden();
		this.path = pathTo(index, this.state.current);
		this.crumbsOpen = false;
		r.setPresentation(presentLook(this.state, index, hidden));
		// the breadcrumb first: the camera measures the area it leaves
		this.updateUi();
		r.presentCamera(presentFrame(this.state, index, hidden), animate);
	}

	/** Aim the camera at the current state again, e.g. after node sizes settled. */
	aim(animate: boolean): void {
		const r = this.host.renderer();
		if (this.closed || !r || !this.index) return;
		r.presentCamera(presentFrame(this.state, this.index, this.host.hidden()), animate);
	}

	private updateUi(): void {
		this.updateBar();
		this.updateCrumbs();
	}

	private build(): void {
		const el = this.host.container;
		const signal = this.abort.signal;
		const button = (parent: HTMLElement, action: string, icon: string | null, label: string, run: () => void): HTMLButtonElement => {
			const b = parent.createEl('button', { cls: 'clickable-icon', attr: { [DOM.actionAttr]: action, 'aria-label': label } });
			if (icon) setIcon(b, icon);
			// keep keyboard focus on the map, so the page keys keep working after a click
			b.addEventListener('pointerdown', (evt) => evt.preventDefault(), { signal });
			b.addEventListener('click', (evt) => {
				evt.preventDefault();
				run();
			}, { signal });
			return b;
		};
		const bar = el.createDiv({ cls: DOM.presentBar });
		this.prev = button(bar, 'present-prev', 'arrow-left', t('present-prev'), () => this.act('prev'));
		this.fill = bar.createDiv({ cls: 'mapdown-present-track' }).createDiv({ cls: DOM.presentFill });
		this.count = bar.createSpan({ cls: DOM.presentCount });
		this.next = button(bar, 'present-next', 'arrow-right', t('present-next'), () => this.act('next'));
		bar.createSpan({ cls: 'mapdown-present-divider' });
		this.overview = button(bar, 'present-overview', null, t('present-overview'), () => this.act('overview'));
		this.overview.addClass('mapdown-present-overview');
		this.overview.createEl('kbd', { text: 'O' });
		this.overview.createSpan({ text: t('present-overview') });
		// a native select, not an Obsidian menu: menus attach to the body and do not show over a full-screen element
		const level = bar.createEl('label', { cls: 'mapdown-present-level-label' });
		level.createSpan({ text: t('present-level') });
		const select = level.createEl('select', { cls: `dropdown ${DOM.presentLevel}` });
		for (const k of LEVELS) select.createEl('option', { value: k === null ? 'all' : String(k), text: k === null ? t('present-level-all') : t('present-level-upto', k) });
		select.value = 'all';
		select.addEventListener('change', () => {
			this.setLevel(select.value === 'all' ? null : Number(select.value));
			this.host.container.focus();
		}, { signal });
		this.select = select;
		this.bar = bar;
		this.crumbs = el.createDiv({ cls: DOM.presentCrumbs, attr: { 'aria-label': t('present-crumbs') } });
		this.crumbs.addEventListener('pointerdown', (evt) => evt.preventDefault(), { signal });
		this.crumbs.addEventListener('click', (evt) => this.onCrumbClick(evt), { signal });
		if (this.touch) {
			this.hint = button(el, 'present-exit', 'x', t('present-exit'), () => this.host.exit());
			this.hint.addClass(DOM.presentHint);
		} else {
			this.hint = el.createDiv({ cls: DOM.presentHint, text: t('present-esc-hint') });
		}
		this.setScale();
		const RO = el.ownerDocument.defaultView?.ResizeObserver;
		if (RO) {
			this.resize = new RO(() => {
				const changed = this.setScale();
				this.updateCrumbs();
				// the bar and breadcrumb changed size after the renderer re-aimed for the new view size
				if (changed) this.aim(false);
			});
			this.resize.observe(el);
		}
	}

	/** The level select (spec 5.13 "层级"): the route is recomputed, the current node stays. */
	private setLevel(level: number | null): void {
		if (this.closed || level === this.level) return;
		this.level = level;
		this.reindex();
		this.updateBar();
	}

	/** Breadcrumb, bar and hint grow with the view: 1× at 1440 px wide, at most 1.6×, never smaller. */
	private setScale(): boolean {
		const w = this.host.container.clientWidth;
		const value = Math.min(SCALE_MAX, Math.max(1, w / SCALE_WIDTH)).toFixed(3);
		if (value === this.scale) return false;
		this.scale = value;
		this.host.container.setCssProps({ '--mapdown-present-scale': value });
		return true;
	}

	private updateBar(): void {
		const index = this.index;
		if (!index) return;
		const n = this.route.length;
		const i = shownStep(this.state, this.route, index);
		if (this.count) this.count.textContent = i === null ? t('present-overview') : `${i + 1} / ${n}`;
		const done = i === null ? 1 : n > 0 ? (i + 1) / n : 0;
		this.fill?.setCssProps({ '--mapdown-present-progress': `${done * 100}%` });
		const set = (b: HTMLButtonElement | null, enabled: boolean): void => {
			if (!b) return;
			b.disabled = !enabled;
			b.toggleClass('is-disabled', !enabled);
		};
		set(this.prev, !(this.state.overview === 'off' && i !== null && i <= 0));
		set(this.next, this.state.overview !== 'end');
		this.overview?.toggleClass('is-active', this.state.overview !== 'off');
		this.overview?.setAttr('aria-pressed', String(this.state.overview !== 'off'));
	}

	/** The path from the root to the current node (or the ringed leaf); the middle collapses to "…" when too wide. */
	private updateCrumbs(): void {
		const box = this.crumbs;
		const index = this.index;
		if (!box || !index) return;
		box.empty();
		if (this.state.overview !== 'off') {
			box.addClass('is-hint');
			box.createSpan({ text: t('present-overview-hint') });
			return;
		}
		box.removeClass('is-hint');
		const ids = pathTo(index, this.state.current);
		if (this.state.leaf !== null) ids.push(this.state.leaf);
		const items = ids.map((id, i) => this.crumbItem(box, i > 0, id, plainLabel(index.node.get(id)?.text ?? ''), i === ids.length - 1));
		const max = this.host.container.clientWidth * CRUMBS_SHARE;
		if (this.crumbsOpen || items.length <= 2 || max <= 0) return;
		const widths = items.map((el) => el.getBoundingClientRect().width);
		if (widths.reduce((a, b) => a + b, 0) <= max) return;
		const more = this.crumbItem(box, true, null, '…', false);
		const keep = fitCrumbs(widths, max, more.getBoundingClientRect().width);
		box.empty();
		for (const k of keep) {
			if (k < 0) box.appendChild(more);
			else box.appendChild(items[k]);
		}
	}

	private crumbItem(box: HTMLElement, sep: boolean, id: string | null, text: string, last: boolean): HTMLElement {
		const item = box.createSpan({ cls: 'mapdown-present-crumb-item' });
		if (sep) item.createSpan({ cls: 'mapdown-present-crumb-sep', text: '›' });
		const seg = item.createSpan({ cls: id === null ? DOM.presentCrumbMore : DOM.presentCrumb, text });
		if (id !== null) seg.dataset.id = id;
		if (last) seg.addClass('is-last');
		return item;
	}

	private onCrumbClick(evt: MouseEvent): void {
		const target = evt.target instanceof Element ? evt.target : null;
		if (!target) return;
		if (target.closest(`.${DOM.presentCrumbMore}`)) {
			this.crumbsOpen = true;
			this.updateCrumbs();
			return;
		}
		const id = target.closest<HTMLElement>(`.${DOM.presentCrumb}`)?.dataset.id;
		if (id) this.jump(id);
	}

	/** Desktop: the view's content goes full screen; a refusal or no support leaves it in place, silently (spec 5.13). */
	private requestFullscreen(): void {
		const el = this.host.container;
		const doc = el.ownerDocument;
		if (typeof el.requestFullscreen !== 'function' || doc.fullscreenElement) return;
		doc.addEventListener('fullscreenchange', () => {
			if (doc.fullscreenElement === el) {
				this.fullscreen = true;
				return;
			}
			// left full screen by the system or the user: the presentation ends too
			if (this.fullscreen && !this.closed) this.host.exit();
		}, { signal: this.abort.signal });
		el.requestFullscreen().then(
			() => {
				this.fullscreen = true;
				// ended before full screen came on
				if (this.closed && doc.fullscreenElement === el) void doc.exitFullscreen().catch(() => undefined);
			},
			() => undefined,
		);
	}
}
