// The search bar (behaviour spec 5.4). Lives on the view's content element,
// next to the toolbar, never inside the pannable map.
//
// - Results refresh 120 ms after typing and show "current / total".
// - Enter goes to the next match, Shift+Enter to the previous one; neither
//   does anything while an input method is composing.
// - Going to a match inside collapsed branches opens them through
//   ViewState.tempExpanded only: nothing is written to the text (so not to
//   mindmark-state) and nothing goes into the undo history. Closing the bar
//   folds them back.
// - Keys typed in the box belong to the box: they never reach the map's key
//   scope (MapView.isComposing asks `ownsEvent`).

import { setIcon } from 'obsidian';
import { clearTempExpanded, pruneSelection, type ViewState } from '../core/state.ts';
import type { MapNode } from '../core/types.ts';
import { t } from '../i18n.ts';
import { DOM } from './contract.ts';
import { findMatches, revealMatch, stepMatch } from './searchMatch.ts';

export const SEARCH_REFRESH_MS = 120;

export interface SearchHost {
	/** The view's content element; the bar is appended to it. */
	readonly container: HTMLElement;
	tree(): MapNode;
	/** Text shown for the root when it differs from its node text (virtual root). */
	rootText(): string | undefined;
	view(): ViewState;
	setView(view: ViewState): void;
	render(): void;
	centerOn(id: string): void;
	/** Give the map keyboard focus back. */
	focusMap(): void;
}

export class SearchBar {
	private el: HTMLElement | null = null;
	private input: HTMLInputElement | null = null;
	private countEl: HTMLElement | null = null;
	private prevBtn: HTMLButtonElement | null = null;
	private nextBtn: HTMLButtonElement | null = null;
	private timer: number | null = null;
	private composing = false;
	private query = '';
	private matchList: string[] = [];
	private matchSet: ReadonlySet<string> = new Set();
	private currentId: string | null = null;

	private readonly host: SearchHost;

	constructor(host: SearchHost) {
		this.host = host;
	}

	get isOpen(): boolean {
		return this.el !== null;
	}

	/** Matching node ids (for highlighting); empty when closed. */
	get matches(): ReadonlySet<string> {
		return this.matchSet;
	}

	get current(): string | null {
		return this.currentId;
	}

	/** True while the input method is composing in the search box. */
	isComposing(): boolean {
		return this.composing;
	}

	/** The event comes from inside the bar (its keys are not map keys). */
	ownsEvent(evt: Event): boolean {
		// no `instanceof Node`: a popout window has its own Node
		return this.el !== null && this.el.contains(evt.target as Node | null);
	}

	open(): void {
		if (this.input) {
			this.input.focus();
			this.input.select();
			return;
		}
		const bar = this.host.container.createDiv({ cls: DOM.search, attr: { role: 'search' } });
		this.el = bar;
		const input = bar.createEl('input', {
			cls: DOM.searchInput,
			attr: { type: 'search', placeholder: t('Search nodes placeholder'), 'aria-label': t('Search nodes'), spellcheck: 'false' },
		});
		this.input = input;
		this.countEl = bar.createSpan({ cls: DOM.searchCount, attr: { 'aria-live': 'polite' } });
		const button = (action: string, icon: string, label: string, run: () => void): HTMLButtonElement => {
			const b = bar.createEl('button', { cls: 'clickable-icon', attr: { [DOM.actionAttr]: action, 'aria-label': label, type: 'button' } });
			setIcon(b, icon);
			b.addEventListener('click', (evt) => {
				evt.preventDefault();
				run();
			});
			return b;
		};
		this.prevBtn = button('search-prev', 'chevron-up', t('Previous match'), () => this.go(-1));
		this.nextBtn = button('search-next', 'chevron-down', t('Next match'), () => this.go(1));
		button('search-close', 'x', t('Close search'), () => this.close(true));

		input.addEventListener('input', () => {
			if (!this.composing) this.schedule();
		});
		input.addEventListener('compositionstart', () => {
			this.composing = true;
		});
		input.addEventListener('compositionend', () => {
			this.composing = false;
			this.schedule();
		});
		// No stopPropagation: map keys are kept out by MapView.isComposing (ownsEvent), global hotkeys still work.
		input.addEventListener('keydown', (evt) => {
			if (evt.isComposing || this.composing || evt.key === 'Process') return;
			if (evt.key === 'Enter') {
				evt.preventDefault();
				this.go(evt.shiftKey ? -1 : 1);
			} else if (evt.key === 'Escape') {
				evt.preventDefault();
				this.close(true);
			}
		});
		this.updateCount();
		input.focus();
	}

	/** Close the bar and fold back what it opened; `refocus` gives the map keyboard focus. */
	close(refocus: boolean): void {
		if (!this.el) return;
		this.clearTimer();
		this.el.remove();
		this.el = null;
		this.input = null;
		this.countEl = null;
		this.prevBtn = null;
		this.nextBtn = null;
		this.composing = false;
		this.query = '';
		this.matchList = [];
		this.matchSet = new Set();
		this.currentId = null;
		const view = this.host.view();
		this.host.setView(pruneSelection(this.host.tree(), clearTempExpanded(view)));
		this.host.render();
		if (refocus) this.host.focusMap();
	}

	/** Run the search now. `render` false when the caller renders anyway. */
	refresh(render = true): void {
		if (!this.input) return;
		this.clearTimer();
		const query = this.input.value;
		const changed = query !== this.query;
		this.query = query;
		const view = this.host.view();
		this.matchList = findMatches(this.host.tree(), query, { rootText: this.host.rootText(), scopeId: view.focus });
		this.matchSet = new Set(this.matchList);
		if (changed || (this.currentId !== null && !this.matchSet.has(this.currentId))) {
			// A new query starts over: nothing current, earlier branches folded back.
			this.currentId = null;
			this.host.setView(clearTempExpanded(view));
		}
		this.updateCount();
		if (render) this.host.render();
	}

	/** Go to the next (1) or previous (-1) match. */
	go(dir: 1 | -1): void {
		if (!this.input) return;
		if (this.timer !== null || this.input.value !== this.query) this.refresh(false);
		const id = stepMatch(this.matchList, this.currentId, dir);
		if (id === null) {
			this.host.render();
			return;
		}
		this.currentId = id;
		this.host.setView(revealMatch(this.host.tree(), this.host.view(), id));
		this.host.render();
		this.host.centerOn(id);
		this.updateCount();
		if (this.input.ownerDocument.activeElement !== this.input) this.input.focus();
	}

	destroy(): void {
		this.clearTimer();
		this.el?.remove();
		this.el = null;
		this.input = null;
	}

	private schedule(): void {
		this.clearTimer();
		this.timer = this.host.container.win.setTimeout(() => {
			this.timer = null;
			this.refresh();
		}, SEARCH_REFRESH_MS);
	}

	private clearTimer(): void {
		if (this.timer !== null) this.host.container.win.clearTimeout(this.timer);
		this.timer = null;
	}

	private updateCount(): void {
		const total = this.matchList.length;
		const at = this.currentId === null ? 0 : this.matchList.indexOf(this.currentId) + 1;
		if (this.countEl) this.countEl.setText(`${at} / ${total}`);
		if (this.prevBtn) this.prevBtn.disabled = total === 0;
		if (this.nextBtn) this.nextBtn.disabled = total === 0;
	}
}
