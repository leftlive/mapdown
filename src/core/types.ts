// Shared data model for the pure core. Every core module builds on these
// types; change them only together with all users.
//
// Offsets are UTF-16 code-unit offsets into the full document text
// (frontmatter included), the same unit @codemirror/state uses.

/** Half-open range [from, to) in the document text. */
export interface Range {
	from: number;
	to: number;
}

/** One text replacement; a list of these maps directly onto a ChangeSet. */
export interface TextEdit {
	from: number;
	to: number;
	insert: string;
}

export type NodeKind =
	| 'root'      // virtual root (no source); see the format contract 4.1
	| 'heading'
	| 'list'      // list item (bullet, ordered or task)
	| 'paragraph' // loose text block, embed, or standalone blockquote
	| 'table'
	| 'code';     // fenced code block

/** How a list item is written, so untouched siblings keep their style. */
export interface ListStyle {
	/** Leading whitespace before the marker, exactly as in the source. */
	indent: string;
	/** The marker: "-", "*", "+", or an ordered marker like "1." / "2)". */
	marker: string;
	ordered: boolean;
}

/** Where a node lives in the source text. Absent on the virtual root. */
export interface NodeSource {
	/**
	 * The node's own lines: from the start of its first line to the end of its
	 * last line (excluding the final line break), including a trailing block-id
	 * line for tables and code blocks. Children are not included.
	 */
	range: Range;
	/** End of the node's last descendant's range (equals range.to for leaves). */
	subtreeTo: number;
	/**
	 * The span holding the node's text inside its line, without the marker,
	 * heading hashes, or the trailing " ^id". Replacing exactly this span
	 * changes the text and nothing else. Null when the text is not a single
	 * contiguous span (multi-line paragraph, table, code block).
	 * Holds the encoded form (`<br>`, a list item's leading `\\>`). For an empty
	 * node it is empty, at the end of the line; when the line is a bare `-` or
	 * `#`, the writer inserts a space before the new text.
	 */
	textRange: Range | null;
	/** 1–6 for headings. */
	headingLevel?: number;
	list?: ListStyle;
	/**
	 * Summary and frame comments on the node's last line (format contract
	 * 4.11): the span of each `%%…%%`, without the space before it. Absent when
	 * the node has none.
	 */
	notes?: NotesSource;
}

/** A summary comment (contract 4.11): `count` from `%%summary:N%%`, absent for the default range. */
export interface SummaryMark {
	count?: number;
}

/** A frame comment: `label` from `%%frame: label%%`, absent when there is none. */
export interface FrameMark {
	label?: string;
}

/** Where a node's comments sit in the text (document offsets, `%%` to `%%`). */
export interface NotesSource {
	summary?: Range;
	frame?: Range;
	/**
	 * A heading's own comment line (contract 4.11.6): the line right under the heading holding only these
	 * comments, from its start to its end (line break not included). It is part of the heading's `range`.
	 */
	line?: Range;
}

export interface MapNode {
	/**
	 * Stable for the lifetime of a parsed document session. Equals the block id
	 * when the node has one; otherwise generated (any unique string).
	 */
	id: string;
	kind: NodeKind;
	/** Node text per the format contract: `<br>` read as "\n", no block id. */
	text: string;
	blockId: string | null;
	children: MapNode[];
	source: NodeSource | null;
	/** Present when the node is written as a summary (`%%summary%%`, spec 5.15); whether it holds depends on its siblings. */
	summary?: SummaryMark;
	/** Present when the node has a frame (`%%frame%%`). */
	frame?: FrameMark;
}

/** `mindmark-state` as read from the frontmatter. */
export interface MindmarkState {
	version: number;
	collapsed: string[];
	/** Per-map layout direction (spec 9.2, contract 3); absent when following the default or unrecognised. */
	layout?: LayoutDirection;
	/** Other fields of the state object, kept as-is when writing (including an unrecognised `layout`). */
	extra: Record<string, unknown>;
}

export interface Frontmatter {
	/** The whole frontmatter block including both `---` lines and the final line break. */
	range: Range;
	/** True when `mindmap-plugin: basic` is present. */
	isMindmap: boolean;
	/** The `mindmark-state` line(s), if present. */
	stateRange: Range | null;
	/**
	 * Parsed state. Absent state reads as version 1 with no ids (contract 3.1).
	 * Null when the state exists but is unsupported or invalid; see stateError.
	 */
	state: MindmarkState | null;
	stateError: 'unsupported' | 'invalid' | null;
}

export interface ParsedDoc {
	text: string;
	lineEnding: '\n' | '\r\n';
	frontmatter: Frontmatter | null;
	/** Offset where the body (after frontmatter) starts. */
	bodyFrom: number;
	root: MapNode;
	/** True when root is synthetic (kind 'root', source null). */
	virtualRoot: boolean;
	/** Ids of nodes that start collapsed, resolved from the state. */
	collapsed: Set<string>;
}

/** Result of applying an operation to the text. */
export interface EditResult {
	edits: TextEdit[];
	/** Edits that undo `edits` when applied to the resulting text. */
	inverse: TextEdit[];
}

export type LayoutDirection = 'mindmap' | 'right' | 'left' | 'clockwise' | 'down';

export interface Size {
	width: number;
	height: number;
}

export interface Point {
	x: number;
	y: number;
}
