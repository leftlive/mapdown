// The marker palette (behaviour spec 5.14): a small panel with a header (the
// markers every target carries, as chips, and "Clear"), pill tabs for
// priority, colour and symbol markers, one fixed-height grid and a hint. It always
// acts on the nodes selected at the moment of the click (a click on a node's
// marker selects that node first), runs `applyMarkers` (one undo step per
// click) and stays open, showing as pressed the markers every target has.
// It closes on Esc, a press outside it, a change of the selection, editing,
// focus mode and presenting (the view closes it with its menus).

import { applyMarkers } from "../commands.ts";
import { PALETTE_GROUPS, canHaveMarkers, commonMarkers, hasMarker, parseMarkerTab, type MarkerGroup } from "../core/markers.ts";
import { Platform } from "obsidian";
import { t } from "../i18n.ts";
import { DOM } from "./contract.ts";
import { isNode } from "./domSafe.ts";
import type { MapView } from "./MapView.ts";
import { palettePosition, type PaletteAnchor, type Rect } from "./viewport.ts";

/** Where the palette was opened from (client coordinates): beside the primary node, left of a toolbar button, below a bar. */
export type PaletteOrigin = { node: true } | { left: DOMRect } | { below: DOMRect };

const GAP = 8;
const ACTIVE = "is-active";
/** Grid geometry in px (the CSS has the same numbers): button size, gap and the panel's side padding. */
const CELL = { desktop: 34, mobile: 40 };
const CELL_GAP = 2;
const PAD = 16;
const MAX_COLS = 8;

/** The tab shown last is kept per vault and device in the app's local storage (spec 5.14). The first time it is the symbols. */
const TAB_KEY = "mapdown-marker-tab";

export class MarkerPalette {
	private readonly view: MapView;
	private readonly parent: HTMLElement;
	private readonly el: HTMLElement;
	private readonly abort = new AbortController();
	private readonly head: HTMLElement;
	private readonly chips: HTMLElement;
	private readonly clearButton: HTMLButtonElement;
	private readonly grid: HTMLElement;
	private readonly tabs = new Map<MarkerGroup, HTMLButtonElement>();
	/** Preset buttons of the current tab by emoji. */
	private readonly buttons = new Map<string, HTMLButtonElement>();
	private tab: MarkerGroup;
	private shown = false;
	/** The selection the palette was opened for; another one closes it. */
	private selKey = "";
	/** Set while the palette's own click is applied, so the render it causes does not close it. */
	private applying = false;
	private readonly signal: AbortSignal;

	constructor(parent: HTMLElement, view: MapView) {
		this.parent = parent;
		this.view = view;
		this.tab = parseMarkerTab(view.app.loadLocalStorage(TAB_KEY));
		const signal = (this.signal = this.abort.signal);
		this.el = parent.createDiv({ cls: DOM.markerPalette });
		this.el.hide();
		this.head = this.el.createDiv({ cls: "mapdown-marker-head" });
		this.head.createSpan({ cls: "mapdown-marker-added", text: t("markers-added") });
		this.chips = this.head.createDiv({ cls: "mapdown-marker-chips" });
		this.clearButton = this.head.createEl("button", { cls: "mapdown-marker-clear", text: t("markers-clear"), attr: { [DOM.actionAttr]: "clear-markers" } });
		this.press(this.clearButton, () => this.pick(null));
		const tabs = this.el.createDiv({ cls: "mapdown-marker-tabs", attr: { role: "tablist" } });
		for (const g of PALETTE_GROUPS) {
			const tab = tabs.createEl("button", { cls: "mapdown-marker-tab", text: t(g.title), attr: { "data-tab": g.group, role: "tab" } });
			this.press(tab, () => this.showTab(g.group));
			this.tabs.set(g.group, tab);
		}
		this.grid = this.el.createDiv({ cls: "mapdown-marker-grid" });
		if (!Platform.isMobile) this.el.createDiv({ cls: "mapdown-marker-hint", text: t("markers-hint") });
		signal.addEventListener("abort", () => this.buttons.clear());
		this.showTab(this.tab);
	}

	/** Buttons keep the keyboard focus on the map: its keys (1–5, Esc) still reach the palette. */
	private press(b: HTMLButtonElement, run: () => void): void {
		b.addEventListener("pointerdown", (e) => e.preventDefault(), { signal: this.signal });
		b.addEventListener("click", (e) => {
			e.preventDefault();
			run();
		}, { signal: this.signal });
	}

	private showTab(group: MarkerGroup): void {
		this.tab = group;
		this.view.app.saveLocalStorage(TAB_KEY, group);
		for (const [g, tab] of this.tabs) {
			tab.toggleClass(ACTIVE, g === group);
			tab.setAttr("aria-selected", g === group ? "true" : "false");
		}
		this.grid.empty();
		this.buttons.clear();
		for (const p of PALETTE_GROUPS.find((g) => g.group === group)?.markers ?? []) {
			const label = p.arg === undefined ? t(p.label) : t(p.label, p.arg);
			const b = this.grid.createEl("button", {
				cls: "mapdown-marker-button",
				text: p.emoji,
				attr: { [DOM.markerAttr]: p.emoji, "aria-label": label, "aria-pressed": "false" },
			});
			this.press(b, () => this.pick(p.emoji));
			this.buttons.set(p.emoji, b);
		}
		this.updatePressed();
	}

	/** Columns that fit the usable width (fewer than 8 on a narrow screen) and the grid's three rows of the symbols. */
	private fitGrid(width: number): void {
		const cell = Platform.isMobile ? CELL.mobile : CELL.desktop;
		const cols = Math.max(1, Math.min(MAX_COLS, Math.floor((width - 2 - PAD + CELL_GAP) / (cell + CELL_GAP))));
		const most = Math.max(...PALETTE_GROUPS.map((g) => g.markers.length));
		this.el.setCssProps({ "--mapdown-marker-cols": String(cols), "--mapdown-marker-rows": String(Math.max(3, Math.ceil(most / cols))) });
	}

	get isOpen(): boolean {
		return this.shown;
	}

	/** Whether `target` is inside the palette (a press there must not close it). */
	owns(target: EventTarget | null): boolean {
		return isNode(target) && this.el.contains(target);
	}

	open(origin: PaletteOrigin): void {
		const r = this.view.renderer;
		if (!r) return;
		this.shown = true;
		this.selKey = this.selectionKey();
		const area = r.usableArea();
		this.fitGrid(area.width - 2 * GAP);
		this.showTab(this.tab);
		this.el.show();
		const box = this.parent.getBoundingClientRect();
		const local = (c: DOMRect): Rect => ({ x: c.left - box.left, y: c.top - box.top, width: c.width, height: c.height });
		let anchor: PaletteAnchor;
		if ("left" in origin) anchor = { side: "left", rect: local(origin.left) };
		else if ("below" in origin) anchor = { side: "below", rect: local(origin.below) };
		else {
			const id = this.view.session.view.selection.primary;
			const nodeEl = id === null ? null : r.nodeElement(id);
			// the outer side of the node, as the node menu (spec 5.2); centred in the area when it is not drawn
			anchor = nodeEl
				? { side: this.view.nodeSide(id ?? "") === "left" ? "left" : "right", rect: local(nodeEl.getBoundingClientRect()) }
				: { side: "below", rect: { x: area.x + area.width / 2, y: area.y + area.height / 3, width: 0, height: 0 } };
		}
		const p = palettePosition(anchor, { width: this.el.offsetWidth, height: this.el.offsetHeight }, area, GAP);
		this.el.setCssStyles({ left: `${Math.round(p.x)}px`, top: `${Math.round(p.y)}px` });
	}

	close(): void {
		if (!this.shown) return;
		this.shown = false;
		this.el.hide();
	}

	/** The map was drawn: close when the selection changed (or went), else show the pressed markers again. */
	refresh(): void {
		if (!this.shown || this.applying) return;
		const sel = this.view.session.view.selection;
		if (sel.primary === null || !this.view.canEdit() || this.view.isPresenting() || this.selectionKey() !== this.selKey) {
			this.close();
			return;
		}
		this.updatePressed();
	}

	/** `1`–`5` while the palette is open: the priority marker (spec 5.14). False when it is closed. */
	digit(n: number): boolean {
		const p = PALETTE_GROUPS[0]?.markers[n - 1];
		if (!this.shown || !p) return false;
		this.pick(p.emoji);
		return true;
	}

	destroy(): void {
		this.abort.abort();
		this.el.remove();
	}

	private pick(emoji: string | null): void {
		this.applying = true;
		try {
			applyMarkers(this.view, emoji);
		} finally {
			this.applying = false;
		}
		// ids follow the change (keepSelection); take them as they are now
		this.selKey = this.selectionKey();
		this.refresh();
	}

	private selectionKey(): string {
		return this.view.session.view.selection.ids.join("\n");
	}

	private updatePressed(): void {
		const targets = this.view.selectedInOrder().filter((n) => canHaveMarkers(n, this.view.session.doc.root));
		for (const [emoji, b] of this.buttons) {
			const on = targets.length > 0 && targets.every((n) => hasMarker(n.text, n.kind, emoji));
			b.toggleClass(ACTIVE, on);
			b.setAttr("aria-pressed", on ? "true" : "false");
		}
		const common = commonMarkers(targets);
		this.chips.empty();
		if (common.length === 0) this.chips.createSpan({ cls: "mapdown-marker-none", text: t("markers-none") });
		for (const emoji of common) {
			const chip = this.chips.createEl("button", { cls: "mapdown-marker-chip", text: emoji, attr: { [DOM.markerAttr]: emoji } });
			this.press(chip, () => this.pick(emoji));
		}
		this.clearButton.disabled = common.length === 0;
	}
}
