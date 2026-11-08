// Pure rules of the embedded map's "active" state (behaviour spec 5.10, operation).

/** How long the hint stays up, including the fade-out (ms). */
export const HINT_SHOW_MS = 1500;
/** The hint is not shown again before this much time has passed since it appeared (ms). */
export const HINT_GAP_MS = 2500;

/** Whether a plain wheel at `now` should show the hint; `last` is when it was last shown (null: never). */
export function hintDue(last: number | null, now: number): boolean {
	return last === null || now - last >= HINT_GAP_MS || now < last;
}

/** Whether a wheel event zooms (Mod+wheel, pinch) rather than scrolls; Mod is Ctrl, and Cmd on macOS. */
export function isZoomWheel(e: { ctrlKey: boolean; metaKey: boolean }, isMac: boolean): boolean {
	return e.ctrlKey || (isMac && e.metaKey);
}

/** How long the first-use tip stays before it fades out (ms). */
export const TIP_SHOW_MS = 6000;
/** The fade-out of the tip (ms); the element goes away after it. */
export const TIP_FADE_MS = 400;

/**
 * Who may show the first-use tip: only when it was never shown (`shownBefore`, the saved flag)
 * and no embed shows it right now. Holder-type slot: `claim` grants at most one embed at a time.
 */
export class TipGate<T> {
	private cur: T | null = null;

	get current(): T | null {
		return this.cur;
	}

	/** Whether `item` may show the tip now; when true it holds the slot until `release`. */
	claim(item: T, shownBefore: boolean): boolean {
		if (shownBefore || this.cur !== null) return false;
		this.cur = item;
		return true;
	}

	release(item: T): void {
		if (this.cur === item) this.cur = null;
	}
}

/** The one active embed of the app. Activating one returns the one that must go inactive. */
export class ActiveSlot<T> {
	private cur: T | null = null;

	get current(): T | null {
		return this.cur;
	}

	/** Make `item` the active one; returns the previous active one when it was another. */
	activate(item: T): T | null {
		const prev = this.cur !== item ? this.cur : null;
		this.cur = item;
		return prev;
	}

	/** `item` goes inactive; returns whether it was the active one. */
	deactivate(item: T): boolean {
		if (this.cur !== item) return false;
		this.cur = null;
		return true;
	}
}
