// The node toolbar of the touch UI (behaviour spec 4.2): a row of buttons shown
// while a node is selected, for the keys a phone does not have (Tab, Enter,
// shortcuts). Every button runs an existing command (development plan 3.5).
// The bar sits at the bottom of the view and hides while a node is being
// edited, which is exactly when the soft keyboard is up (plan 3.7); the
// keyboard inset is also tracked so the bar never lies under it. With two or
// more nodes selected the bar shows the multi-selection actions (spec 5.11)
// instead, followed by undo and redo.

import { setIcon } from "obsidian";
import { available, COMMAND_BY_ID } from "../commands.ts";
import { t } from "../i18n.ts";
import { DOM } from "./contract.ts";
import type { MapView } from "./MapView.ts";
import { keyboardInset, MOBILE_ACTIONS } from "./mobileActions.ts";
import { setIconFrom } from "./icons.ts";
import { addMultiButtons, enableMultiButtons } from "./multiActionBar.ts";
import { isMultiSelection } from "./multiActions.ts";

/** Kept in both sets: the history buttons. */
const ALWAYS = new Set(["undo", "redo"]);

export class MobileToolbar {
	private readonly el: HTMLElement;
	private readonly abort = new AbortController();
	private readonly buttons = new Map<string, HTMLButtonElement>();
	/** The multi-selection set; shown instead of the others (except undo and redo). */
	private multi = new Map<string, HTMLButtonElement>();
	private multiShown: boolean | null = null;
	private readonly parent: HTMLElement;
	private readonly view: MapView;

	constructor(parent: HTMLElement, view: MapView) {
		this.parent = parent;
		this.view = view;
		this.el = parent.createDiv({ cls: DOM.mobileToolbar });
		this.el.hide();
		parent.addClass("has-mobile-toolbar");
		for (const a of MOBILE_ACTIONS) {
			if (!COMMAND_BY_ID.has(a.command)) continue;
			if (a.action === "undo" && this.multi.size === 0) this.multi = this.addMulti();
			const b = this.el.createEl("button", { cls: "clickable-icon", attr: { [DOM.actionAttr]: a.action, "aria-label": t(a.label) } });
			setIconFrom(b, a.icon);
			// older Obsidian versions have no "smile-plus" icon
			if (a.icon === "smile-plus" && !b.querySelector("svg")) setIcon(b, "smile");
			// keep the focus (and the soft keyboard) where it is
			b.addEventListener("pointerdown", (e) => e.preventDefault(), { signal: this.abort.signal });
			b.addEventListener("click", (e) => {
				e.preventDefault();
				view.run(a.command);
			}, { signal: this.abort.signal });
			this.buttons.set(a.action, b);
		}
		if (this.multi.size === 0) this.multi = this.addMulti();
		const vv = parent.win.visualViewport;
		if (vv) {
			const onResize = (): void => this.trackKeyboard();
			vv.addEventListener("resize", onResize, { signal: this.abort.signal });
			vv.addEventListener("scroll", onResize, { signal: this.abort.signal });
		}
	}

	/** Show for a selected node (not while editing); enable what can run now. */
	update(): void {
		const show = this.view.canEdit() && this.view.session.view.selection.primary !== null && !this.view.isEditing();
		if (show) this.el.show();
		else this.el.hide();
		if (!show) return;
		const multi = isMultiSelection(this.view.session.view.selection.ids);
		if (multi !== this.multiShown) {
			this.multiShown = multi;
			for (const [action, b] of this.buttons) b.toggle(!multi || ALWAYS.has(action));
			for (const b of this.multi.values()) b.toggle(multi);
		}
		for (const a of MOBILE_ACTIONS) {
			const b = this.buttons.get(a.action);
			const cmd = COMMAND_BY_ID.get(a.command);
			if (!b || !cmd) continue;
			const ok = available(cmd, this.view) && this.enabledFor(a.action);
			b.disabled = !ok;
			b.toggleClass("is-disabled", !ok);
		}
		if (multi) enableMultiButtons(this.multi, this.view);
		this.trackKeyboard();
	}

	private addMulti(): Map<string, HTMLButtonElement> {
		const set = addMultiButtons(this.el, this.view, this.abort.signal);
		for (const b of set.values()) {
			b.addClass("is-multi");
			b.hide();
		}
		return set;
	}

	private enabledFor(action: string): boolean {
		if (action === "undo") return this.view.session.history.undoSize > 0;
		if (action === "redo") return this.view.session.history.redoSize > 0;
		if (action === "summary") return this.view.summaryFits();
		return true;
	}

	/** Lift the bar above the soft keyboard when it overlaps the view. */
	private trackKeyboard(): void {
		const vv = this.parent.win.visualViewport;
		const inset = vv ? keyboardInset(this.parent.getBoundingClientRect().bottom, vv.offsetTop, vv.height) : 0;
		this.parent.style.setProperty("--mapdown-bottom-inset", `${inset}px`);
	}

	destroy(): void {
		this.abort.abort();
		this.parent.removeClass("has-mobile-toolbar");
		this.el.remove();
	}
}
