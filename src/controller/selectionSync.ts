// Split-view selection sync (behaviour spec 5.6): the bookkeeping that decides
// when a map selection is followed in Markdown and when a Markdown cursor move
// is resolved in the map. Pure; MapView supplies the environment and acts.
//
// No ping-pong: `synced` is the primary both sides agree on. A selection made
// from the editor, or one that survives a text change, is recorded as synced
// before the map renders, so the render does not send it back; the editor's
// cursor listener ignores cursor moves of an unfocused editor, so a reveal
// does not come back either. And a focused editor is never moved.

export interface SyncEnv {
	/** Setting `syncSelection`. */
	enabled: boolean;
	/** The map is the active view or holds focus: the user selected there. */
	mapActive: boolean;
	/** A Markdown editor of the file has focus: the user is working there. */
	editorFocused: boolean;
	/** The Markdown view shows the map's text (else its lines do not match yet). */
	editorCurrent: () => boolean;
}

export class SelectionSync {
	private synced: string | null = null;
	private pendingLine: number | null = null;
	private waiting = false;

	/** A note was (re)loaded with `primary` selected. */
	reset(primary: string | null): void {
		this.synced = primary;
		this.pendingLine = null;
		this.waiting = false;
	}

	/** The text changed elsewhere; whatever selection survives it is not a map selection. */
	adopt(primary: string | null): void {
		this.synced = primary;
	}

	/** The map selected `id` because of the editor's cursor. */
	selectedFromEditor(id: string): void {
		this.synced = id;
		this.waiting = false;
	}

	/** True when `primary` differs from what both sides agree on (a render may have to reveal it). */
	changed(primary: string | null): boolean {
		return primary !== this.synced;
	}

	/** After a render: the node whose line to reveal in Markdown now, or null. */
	afterRender(primary: string | null, env: SyncEnv): string | null {
		if (primary === this.synced) return null;
		this.synced = primary;
		return this.reveal(primary, env);
	}

	/** Retry a waiting reveal (the editor caught up). */
	retry(primary: string | null, env: SyncEnv): string | null {
		this.synced = primary;
		return this.reveal(primary, env);
	}

	private reveal(primary: string | null, env: SyncEnv): string | null {
		this.waiting = false;
		if (primary === null || !env.enabled || !env.mapActive || env.editorFocused) return null;
		if (!env.editorCurrent()) {
			this.waiting = true;
			return null;
		}
		return primary;
	}

	/**
	 * A focused editor's cursor moved to `line`. Returns the line to resolve
	 * now, or null when typed text still waits for its re-parse (then
	 * `afterFlush` hands it back).
	 */
	cursor(line: number, typingPending: boolean): number | null {
		if (typingPending) {
			this.pendingLine = line;
			return null;
		}
		return line;
	}

	/**
	 * Typed text was parsed into the map. `line`: a cursor line to resolve now
	 * (only while the editor still has focus). `reveal`: a map selection that
	 * waited for the editor is due.
	 */
	afterFlush(editorFocused: boolean): { line: number | null; reveal: boolean } {
		const line = editorFocused ? this.pendingLine : null;
		const reveal = this.waiting && !editorFocused;
		this.pendingLine = null;
		this.waiting = false;
		return { line, reveal };
	}
}
