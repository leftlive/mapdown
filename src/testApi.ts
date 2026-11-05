// Read-only test interface (development plan §6.1), exposed as
// `app.plugins.plugins.mapdown.testApi`. It reads the most recently active
// map view. Once settled, do not change it casually: e2e tests depend on it.

export interface TestApi {
	/** Selected node ids, primary first. Empty when no map view is active. */
	selection(): string[];
	/** Visible nodes in depth-first order. */
	visibleNodes(): { id: string; text: string }[];
	/** Number of undo and redo steps in the map's own history. */
	historySize(): { undo: number; redo: number };
	/** Id of the first visible node whose text equals `text`, or null. */
	nodeAt(text: string): string | null;
	/** Ids currently rendered as DOM (virtualization checks). */
	renderedIds(): string[];
	/** True while a node is being edited. */
	isEditing(): boolean;
	/** 0-based file line (frontmatter included) of the node's first line; null for the virtual root or an unknown id. */
	nodeLine(id: string): number | null;
	/** Id of the node whose own lines include 0-based file line `line`; null for frontmatter and blank lines. */
	nodeAtLine(line: number): string | null;
	/** Resolves when pending saves have been written. */
	flush(): Promise<void>;
}
