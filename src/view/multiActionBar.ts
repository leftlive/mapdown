// The multi-selection actions (behaviour spec 5.11) on the desktop: a bar that
// floats above the selected nodes, and the same buttons as a column at the
// pointer for a right click on a node of the selection. Both are built from
// MULTI_ACTIONS and run existing commands (development plan 3.5).
//
// Following pan and zoom never lays the map out again: the selection's box is
// taken from the last layout (world units) when the map is drawn, and a pan or
// zoom only maps that box to the screen and moves the bar, at most once a
// frame. The available area (spec 5.1) is measured when the map is drawn, not
// while it moves. While a box selection or a node drag is under way the map
// layer carries a class and styles.css hides the bar.

import { setIcon } from "obsidian";
import { t } from "../i18n.ts";
import type { Point } from "../core/types.ts";
import { DOM } from "./contract.ts";
import { isNode } from "./domSafe.ts";
import type { MapView } from "./MapView.ts";
import { setIconFrom } from "./icons.ts";
import { isMultiSelection, multiActionEnabled, MULTI_ACTIONS } from "./multiActions.ts";
import { barPosition, screenRect, type Rect } from "./viewport.ts";

/** Space between the bar and the selection, and between the bar and the edges of the available area. */
const GAP = 8;
const SHOWN = "is-shown";

/**
 * One button per multi-selection action in `parent`, in table order. A click runs the action's command
 * after `before` (which may close a menu). Pressing a button keeps the keyboard focus where it is.
 */
export function addMultiButtons(
	parent: HTMLElement,
	view: Pick<MapView, "run" | "openMarkers">,
	signal: AbortSignal,
	before?: () => void,
): Map<string, HTMLButtonElement> {
	const out = new Map<string, HTMLButtonElement>();
	for (const a of MULTI_ACTIONS) {
		const label = t(a.label);
		const b = parent.createEl("button", { cls: "clickable-icon", attr: { [DOM.actionAttr]: a.action, "aria-label": label } });
		setIconFrom(b, a.icon);
		if (a.icon === "smile-plus" && !b.querySelector("svg")) setIcon(b, "smile");
		b.addEventListener("pointerdown", (e) => e.preventDefault(), { signal });
		b.addEventListener("click", (e) => {
			e.preventDefault();
			// the palette goes below the bar (spec 5.14); read where it is before a menu closes
			const below = a.opensPalette ? parent.getBoundingClientRect() : null;
			before?.();
			if (below) view.openMarkers({ below });
			else view.run(a.command);
		}, { signal });
		out.set(a.action, b);
	}
	return out;
}

/** Greys the buttons that cannot apply to the selection now ("summary" off unless it is adjacent siblings, spec 5.15). */
export function enableMultiButtons(buttons: ReadonlyMap<string, HTMLButtonElement>, view: Pick<MapView, "summaryFits">): void {
	const siblings = view.summaryFits();
	for (const a of MULTI_ACTIONS) {
		const b = buttons.get(a.action);
		if (!b) continue;
		const ok = multiActionEnabled(a, siblings);
		b.disabled = !ok;
		b.toggleClass("is-disabled", !ok);
	}
}

export class MultiActionBar {
	private readonly view: MapView;
	private readonly parent: HTMLElement;
	/** Null on touch devices: the node toolbar takes these buttons there (spec 4.2). */
	private readonly bar: HTMLElement | null;
	private readonly menu: HTMLElement;
	private readonly abort = new AbortController();
	private frame: number | null = null;
	/** Selection box in world units and the available area, from the last time the map was drawn. */
	private box: Rect | null = null;
	private area: Rect | null = null;
	private size = { width: 0, height: 0 };
	private menuShown = false;
	private barButtons = new Map<string, HTMLButtonElement>();
	private menuButtons = new Map<string, HTMLButtonElement>();

	constructor(parent: HTMLElement, view: MapView, floating: boolean) {
		this.parent = parent;
		this.view = view;
		const signal = this.abort.signal;
		this.bar = floating ? parent.createDiv({ cls: DOM.multiBar }) : null;
		if (this.bar) this.barButtons = addMultiButtons(this.bar, view, signal);
		this.menu = parent.createDiv({ cls: DOM.multiMenu });
		this.menu.hide();
		this.menuButtons = addMultiButtons(this.menu, view, signal, () => this.hideMenu());
	}

	get isMenuOpen(): boolean {
		return this.menuShown;
	}

	/** Whether `target` is inside the right-click menu (a press there must not close it). */
	ownsTarget(target: EventTarget | null): boolean {
		return isNode(target) && this.menu.contains(target);
	}

	/** The map was drawn or the selection changed: show or hide, and place the bar on the next frame. */
	update(): void {
		if (!this.bar) return;
		this.area = null;
		if (!this.wanted()) {
			this.bar.removeClass(SHOWN);
			return;
		}
		enableMultiButtons(this.barButtons, this.view);
		this.schedule();
	}

	/** Pan or zoom: only move the bar (nothing is measured or laid out). */
	follow(): void {
		if (this.bar?.hasClass(SHOWN)) this.schedule();
	}

	/** The column of buttons at `at` (client coordinates), kept inside the view. */
	showMenu(at: Point): void {
		const menu = this.menu;
		const box = this.parent.getBoundingClientRect();
		this.menuShown = true;
		this.bar?.removeClass(SHOWN);
		enableMultiButtons(this.menuButtons, this.view);
		menu.show();
		const x = Math.min(at.x - box.left + 4, box.width - menu.offsetWidth - 4);
		const y = Math.min(at.y - box.top, box.height - menu.offsetHeight - 4);
		menu.setCssStyles({ left: `${Math.round(Math.max(0, x))}px`, top: `${Math.round(Math.max(0, y))}px` });
	}

	hideMenu(): void {
		if (!this.menuShown) return;
		this.menuShown = false;
		this.menu.hide();
		this.update();
	}

	destroy(): void {
		this.abort.abort();
		if (this.frame !== null) this.parent.win.cancelAnimationFrame(this.frame);
		this.frame = null;
		this.bar?.remove();
		this.menu.remove();
	}

	private wanted(): boolean {
		const v = this.view;
		return v.canEdit() && !v.isEditing() && !v.isMenuOpen() && !this.menuShown && isMultiSelection(v.session.view.selection.ids);
	}

	private schedule(): void {
		if (this.frame !== null) return;
		this.frame = this.parent.win.requestAnimationFrame(() => {
			this.frame = null;
			this.place();
		});
	}

	private place(): void {
		const bar = this.bar;
		const r = this.view.renderer;
		if (!bar || !r || !this.wanted()) {
			bar?.removeClass(SHOWN);
			return;
		}
		if (this.area === null) {
			this.box = this.selectionBox();
			this.area = r.usableArea();
		}
		bar.addClass(SHOWN);
		// the size never changes: read it once (not while a gesture hides the bar), so a pan reads no layout
		if (this.size.width === 0 && bar.offsetWidth > 0) this.size = { width: bar.offsetWidth, height: bar.offsetHeight };
		const p = barPosition(this.box ? screenRect(r.viewport, this.box) : null, this.size, this.area, GAP);
		bar.setCssStyles({ left: `${Math.round(p.x)}px`, top: `${Math.round(p.y)}px` });
	}

	/** Bounding box (world) of the selected nodes that are laid out; one lookup per selected node. */
	private selectionBox(): Rect | null {
		const nodes = this.view.renderer?.layoutSnapshot()?.nodes;
		if (!nodes) return null;
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		for (const id of this.view.session.view.selection.ids) {
			const p = nodes.get(id);
			if (!p) continue;
			x0 = Math.min(x0, p.x);
			y0 = Math.min(y0, p.y);
			x1 = Math.max(x1, p.x + p.width);
			y1 = Math.max(y1, p.y + p.height);
		}
		return x1 < x0 ? null : { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
	}
}
