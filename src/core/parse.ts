// Markdown text -> node tree, per docs/Markdown格式契约.md sections 2-4.
// A single line-based pass; every node records where it lives in the text.

import type {
	Frontmatter,
	ListStyle,
	MapNode,
	MindmarkState,
	NodeKind,
	NodeSource,
	ParsedDoc,
	Range,
} from './types.ts';

interface Line {
	from: number;
	/** End of the line content, before "\r\n" or "\n". */
	to: number;
	/** Line content without the line break. */
	text: string;
	/** Offset after the line break (text.length for the last line). */
	next: number;
}

function splitLines(text: string, start: number): Line[] {
	const lines: Line[] = [];
	let from = start;
	while (from < text.length) {
		let nl = text.indexOf('\n', from);
		const next = nl < 0 ? text.length : nl + 1;
		if (nl < 0) nl = text.length;
		const to = nl > from && text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
		lines.push({ from, to, text: text.slice(from, to), next });
		from = next;
	}
	return lines;
}

const HEADING = /^(#{1,6})(?:[ \t]+|$)/;
const HR = /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/s;
const FENCE = /^(`{3,}|~{3,})(.*)$/s;
const DELIMITER_ROW = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/;
const BLOCK_ID_LINE = /^[ \t]*\^([A-Za-z0-9-]+)[ \t]*$/;
/** ` ^id` at the end; headings and list items also accept a bare `^id` as the whole text. */
const BLOCK_ID_TAIL = /(?:^|[ \t]+)\^([A-Za-z0-9-]+)$/;
const BLOCK_ID_TAIL_SPACED = /[ \t]+\^([A-Za-z0-9-]+)$/;
const CLOSING_HASHES = /(?:^|[ \t]+)#+$/;

const isBlank = (s: string): boolean => /^[ \t]*$/.test(s);
const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t';

function leadLength(s: string): number {
	let i = 0;
	while (isSpace(s[i])) i++;
	return i;
}

/** Visual column after the first `upTo` characters (tabs stop every 4 columns). */
function columnAt(s: string, upTo: number): number {
	let col = 0;
	for (let i = 0; i < upTo; i++) col = s[i] === '\t' ? col + 4 - (col % 4) : col + 1;
	return col;
}

const indentCol = (s: string): number => columnAt(s, leadLength(s));

/** Remove leading whitespace worth at most `cols` columns. */
function stripCols(s: string, cols: number): string {
	let col = 0;
	let i = 0;
	while (i < s.length && isSpace(s[i])) {
		const w = s[i] === '\t' ? 4 - (col % 4) : 1;
		if (col + w > cols) break;
		col += w;
		i++;
	}
	return s.slice(i);
}

const decodeBreaks = (s: string): string => s.replace(/<br>/g, '\n');

interface Span {
	/** Offsets into the line text. */
	from: number;
	to: number;
	blockId: string | null;
}

/** Trim [from, to) of a line and cut a trailing block id off it. */
function spanOf(s: string, from: number, to: number, bareId: boolean): Span {
	while (from < to && isSpace(s[from])) from++;
	while (to > from && isSpace(s[to - 1])) to--;
	let blockId: string | null = null;
	const m = (bareId ? BLOCK_ID_TAIL : BLOCK_ID_TAIL_SPACED).exec(s.slice(from, to));
	if (m) {
		blockId = m[1] ?? null;
		to = from + m.index;
	}
	return { from, to, blockId };
}

function openFence(rest: string): { char: string; len: number } | null {
	const m = FENCE.exec(rest);
	if (!m) return null;
	const fence = m[1] ?? '';
	if (fence[0] === '`' && (m[2] ?? '').includes('`')) return null;
	return { char: fence[0] ?? '`', len: fence.length };
}

function cellCount(row: string): number {
	let s = row.trim();
	if (s.startsWith('|')) s = s.slice(1);
	if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
	// No regex lookbehind (unsupported before iOS 16.4): count unescaped pipes by hand.
	let n = 1;
	for (let i = 0; i < s.length; i++) {
		if (s[i] === '|' && s[i - 1] !== '\\') n++;
	}
	return n;
}

// ---------------------------------------------------------------------------
// Frontmatter

const FM_FENCE = /^---[ \t]*$/;
const FM_KEY = /^(["']?)([^\s"':#][^"':]*?)\1[ \t]*:(?:[ \t]+(.*))?$/;

function parseFrontmatter(text: string): Frontmatter | null {
	const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	const lines = splitLines(text, start);
	if (lines.length === 0 || !FM_FENCE.test(lines[0]?.text ?? '')) return null;
	let close = -1;
	for (let i = 1; i < lines.length; i++) {
		if (FM_FENCE.test(lines[i]?.text ?? '')) {
			close = i;
			break;
		}
	}
	const closeLine = lines[close];
	if (!closeLine) return null;

	let isMindmap = false;
	let stateRange: Range | null = null;
	let stateValue: string | null = null;
	for (let i = 1; i < close; i++) {
		const line = lines[i];
		if (!line) continue;
		const m = FM_KEY.exec(line.text);
		if (!m) continue;
		const key = m[2] ?? '';
		const value = (m[3] ?? '').trim();
		if (key === 'mindmap-plugin') {
			isMindmap = unquote(value.replace(/[ \t]+#.*$/, '')) === 'basic';
		} else if (key === 'mindmark-state' && stateRange === null) {
			// Continuation lines run until the next top-level key or the closing ---;
			// trailing blank lines are not part of the value.
			let last = i;
			const parts = [value];
			for (let j = i + 1; j < close; j++) {
				const t = lines[j]?.text ?? '';
				if (isBlank(t)) continue;
				if (!isSpace(t[0])) break;
				last = j;
				parts.push(t.trim());
			}
			stateRange = { from: line.from, to: lines[last]?.to ?? line.to };
			stateValue = parts.join(' ').trim();
		}
	}

	let state: MindmarkState | null = { version: 1, collapsed: [], extra: {} };
	let stateError: Frontmatter['stateError'] = null;
	if (stateValue !== null) {
		const read = readState(stateValue);
		state = typeof read === 'string' ? null : read;
		stateError = typeof read === 'string' ? read : null;
	}
	return {
		range: { from: 0, to: closeLine.next },
		isMindmap,
		stateRange,
		state,
		stateError,
	};
}

function unquote(s: string): string {
	const m = /^"(.*)"$|^'(.*)'$/.exec(s);
	return m ? (m[1] ?? m[2] ?? '') : s;
}

function readState(value: string): MindmarkState | 'invalid' | 'unsupported' {
	const parsed = parseYamlFlow(value);
	if (!parsed.ok) return 'invalid';
	const obj = parsed.value;
	if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return 'invalid';
	const record = obj as Record<string, unknown>;
	const version = record['version'];
	if (typeof version !== 'number' || !Number.isInteger(version)) return 'invalid';
	if (version !== 1 && version !== 2) return 'unsupported';
	const collapsed = record['collapsed'] ?? [];
	if (!Array.isArray(collapsed) || !collapsed.every((c) => typeof c === 'string')) return 'invalid';
	const extra: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(record)) if (k !== 'version' && k !== 'collapsed') Object.defineProperty(extra, k, { value: v, enumerable: true, writable: true, configurable: true });
	return { version, collapsed: collapsed, extra };
}

type Flow = { ok: true; value: unknown } | { ok: false };

/** JSON, or a one-value YAML flow node (`{version: 2, collapsed: [a, 'b']}`). */
function parseYamlFlow(src: string): Flow {
	try {
		return { ok: true, value: JSON.parse(src) as unknown };
	} catch {
		// not JSON; fall through to YAML flow syntax
	}
	if (!src.startsWith('{') && !src.startsWith('[')) return { ok: true, value: src === '' ? null : unquote(src) };
	let i = 0;
	const fail = (): never => {
		throw new SyntaxError('flow');
	};
	const ws = (): void => {
		while (i < src.length && /\s/.test(src[i] ?? '')) i++;
	};
	const scalar = (stop: RegExp): unknown => {
		const c = src[i];
		if (c === '"') {
			const m = /^"(?:[^"\\]|\\.)*"/.exec(src.slice(i)) ?? fail();
			i += m[0].length;
			return JSON.parse(m[0]) as unknown;
		}
		if (c === "'") {
			const m = /^'(?:[^']|'')*'/.exec(src.slice(i)) ?? fail();
			i += m[0].length;
			return m[0].slice(1, -1).replace(/''/g, "'");
		}
		const begin = i;
		while (i < src.length && !stop.test(src[i] ?? '')) i++;
		const plain = src.slice(begin, i).trim();
		if (/^[-+]?\d+$/.test(plain)) return Number(plain);
		if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/.test(plain)) return Number(plain);
		if (/^(?:true|True|TRUE)$/.test(plain)) return true;
		if (/^(?:false|False|FALSE)$/.test(plain)) return false;
		if (plain === '' || /^(?:null|Null|NULL|~)$/.test(plain)) return null;
		return plain;
	};
	const node = (): unknown => {
		ws();
		const c = src[i];
		if (c === '{') {
			i++;
			const out: Record<string, unknown> = {};
			ws();
			if (src[i] === '}') {
				i++;
				return out;
			}
			for (;;) {
				ws();
				const key = scalar(/[:,{}[\]]/);
				ws();
				if (src[i] !== ':') fail();
				i++;
				out[String(key)] = node();
				ws();
				if (src[i] === ',') i++;
				else if (src[i] === '}') {
					i++;
					return out;
				} else fail();
			}
		}
		if (c === '[') {
			i++;
			const out: unknown[] = [];
			ws();
			if (src[i] === ']') {
				i++;
				return out;
			}
			for (;;) {
				out.push(node());
				ws();
				if (src[i] === ',') i++;
				else if (src[i] === ']') {
					i++;
					return out;
				} else fail();
			}
		}
		if (c === ']' || c === '}' || c === ',' || c === undefined) fail();
		return scalar(/[,{}[\]]/);
	};
	try {
		const value = node();
		ws();
		if (i < src.length && src[i] !== '#') return { ok: false };
		return { ok: true, value };
	} catch {
		return { ok: false };
	}
}

// ---------------------------------------------------------------------------
// Body

interface Built {
	kind: NodeKind;
	text: string;
	blockId: string | null;
	range: Range;
	textRange: Range | null;
	headingLevel?: number;
	list?: ListStyle;
}

type ContinueMode = 'para' | 'item' | 'quote';

class BodyParser {
	private readonly lines: Line[];
	private readonly usedIds = new Set<string>();
	private counter = 0;
	readonly root: MapNode;
	private readonly headings: { level: number; node: MapNode }[] = [];
	private list: { col: number; node: MapNode }[] = [];

	constructor(lines: Line[]) {
		this.lines = lines;
		this.root = { id: '_root', kind: 'root', text: '', blockId: null, children: [], source: null };
	}

	private make(b: Built): MapNode {
		let id: string;
		const key = b.blockId?.toLowerCase();
		if (b.blockId !== null && key !== undefined && !this.usedIds.has(key)) {
			this.usedIds.add(key);
			id = b.blockId;
		} else {
			id = `_${++this.counter}`;
		}
		const source: NodeSource = { range: b.range, subtreeTo: b.range.to, textRange: b.textRange };
		if (b.headingLevel !== undefined) source.headingLevel = b.headingLevel;
		if (b.list !== undefined) source.list = b.list;
		return { id, kind: b.kind, text: b.text, blockId: b.blockId, children: [], source };
	}

	/** Attach a non-heading node at a column; list items stay open for children. */
	private attach(node: MapNode, col: number, open: boolean): void {
		while (this.list.length > 0 && (this.list[this.list.length - 1]?.col ?? 0) >= col) this.list.pop();
		const parent =
			this.list[this.list.length - 1]?.node ?? this.headings[this.headings.length - 1]?.node ?? this.root;
		parent.children.push(node);
		if (open) this.list.push({ col, node });
	}

	private isTableStart(i: number): boolean {
		const head = this.lines[i]?.text;
		const delim = this.lines[i + 1]?.text;
		if (head === undefined || delim === undefined || !head.includes('|') || !delim.includes('|')) return false;
		return DELIMITER_ROW.test(delim.trim()) && cellCount(head) === cellCount(delim);
	}

	/** Whether line j ends the paragraph, list-item text or blockquote before it. */
	private interrupts(j: number, mode: ContinueMode): boolean {
		const t = this.lines[j]?.text ?? '';
		if (isBlank(t)) return true;
		const lead = leadLength(t);
		const rest = t.slice(lead);
		if (columnAt(t, lead) <= 3 && HEADING.test(rest)) return true;
		if (HR.test(rest) || openFence(rest) || this.isTableStart(j)) return true;
		if (rest.startsWith('>')) return mode !== 'quote';
		const m = LIST.exec(t);
		if (m) {
			if (mode !== 'para') return true;
			const marker = m[2] ?? '';
			const hasText = !isBlank(m[4] ?? '');
			return hasText && (/^[-*+]$/.test(marker) || /^1[.)]$/.test(marker));
		}
		return false;
	}

	parse(): MapNode {
		const lines = this.lines;
		let i = 0;
		while (i < lines.length) {
			const line = lines[i];
			if (!line) break;
			const t = line.text;
			if (isBlank(t)) {
				i++;
				continue;
			}
			const lead = leadLength(t);
			const col = columnAt(t, lead);
			const rest = t.slice(lead);
			const h = col <= 3 ? HEADING.exec(rest) : null;
			if (h) {
				this.heading(line, lead + h[0].length, (h[1] ?? '#').length);
				i++;
				continue;
			}
			if (HR.test(rest)) {
				i++;
				continue;
			}
			const m = LIST.exec(t);
			if (m) {
				i = this.listItem(i, m);
				continue;
			}
			if (openFence(rest)) {
				const r = this.fence(i, rest, col, line.from);
				this.attach(this.make(r.built), col, false);
				i = r.next;
				continue;
			}
			if (this.isTableStart(i)) {
				const r = this.table(i, line.from);
				this.attach(this.make(r.built), col, false);
				i = r.next;
				continue;
			}
			const mode: ContinueMode = rest.startsWith('>') ? 'quote' : 'para';
			let j = i + 1;
			while (j < lines.length && !this.interrupts(j, mode)) j++;
			this.attach(this.make(this.paragraph(i, j)), col, false);
			i = j;
		}
		return this.root;
	}

	private heading(line: Line, contentStart: number, level: number): void {
		this.list = [];
		while (this.headings.length > 0 && (this.headings[this.headings.length - 1]?.level ?? 0) >= level) {
			this.headings.pop();
		}
		const span = spanOf(line.text, contentStart, line.text.length, true);
		const hashes = CLOSING_HASHES.exec(line.text.slice(span.from, span.to));
		if (hashes) span.to = span.from + hashes.index;
		const node = this.make({
			kind: 'heading',
			text: decodeBreaks(line.text.slice(span.from, span.to)),
			blockId: span.blockId,
			range: { from: line.from, to: line.to },
			textRange: { from: line.from + span.from, to: line.from + span.to },
			headingLevel: level,
		});
		const parent = this.headings[this.headings.length - 1]?.node ?? this.root;
		parent.children.push(node);
		this.headings.push({ level, node });
	}

	private listItem(i: number, m: RegExpExecArray): number {
		const lines = this.lines;
		const line = lines[i];
		if (!line) return i + 1;
		const indent = m[1] ?? '';
		const marker = m[2] ?? '-';
		const spaces = m[3] ?? '';
		const content = m[4] ?? '';
		const col = columnAt(line.text, indent.length);
		const contentStart = indent.length + marker.length + spaces.length;
		const list: ListStyle = { indent, marker, ordered: /^\d/.test(marker) };

		if (isBlank(content)) {
			// A bare marker directly followed by an indented code block or table is that block (contract 6.3).
			const next = lines[i + 1];
			if (next && !isBlank(next.text) && indentCol(next.text) > col) {
				const nlead = leadLength(next.text);
				const nrest = next.text.slice(nlead);
				const r = openFence(nrest)
					? this.fence(i + 1, nrest, columnAt(next.text, nlead), line.from)
					: this.isTableStart(i + 1)
						? this.table(i + 1, line.from)
						: null;
				if (r) {
					this.attach(this.make({ ...r.built, list }), col, false);
					return r.next;
				}
			}
		} else if (openFence(content)) {
			const r = this.fence(i, content, columnAt(line.text, contentStart), line.from);
			this.attach(this.make({ ...r.built, list }), col, false);
			return r.next;
		}

		const first = spanOf(line.text, contentStart, line.text.length, true);
		const quote = line.text.startsWith('>', first.from);
		let j = i + 1;
		while (j < lines.length && !this.interrupts(j, quote ? 'quote' : 'item')) j++;
		const last = lines[j - 1] ?? line;
		let text: string;
		let blockId = first.blockId;
		let textRange: Range | null = null;
		if (j === i + 1) {
			text = line.text.slice(first.from, first.to);
			textRange = { from: line.from + first.from, to: line.from + first.to };
		} else {
			const parts = [line.text.slice(first.from).trimEnd()];
			for (let k = i + 1; k < j - 1; k++) parts.push((lines[k]?.text ?? '').trim());
			const tail = spanOf(last.text, 0, last.text.length, false);
			parts.push(last.text.slice(tail.from, tail.to));
			blockId = tail.blockId;
			text = parts.join('\n');
		}
		text = decodeBreaks(text);
		if (text.startsWith('\\>')) text = text.slice(1);
		const node = this.make({
			kind: 'list',
			text,
			blockId,
			range: { from: line.from, to: last.to },
			textRange,
			list,
		});
		this.attach(node, col, true);
		return j;
	}

	/** Paragraph or blockquote over lines [i, j). */
	private paragraph(i: number, j: number): Built {
		const lines = this.lines;
		const first = lines[i];
		const last = lines[j - 1];
		if (!first || !last) throw new Error('empty paragraph');
		const parts: string[] = [];
		for (let k = i; k < j - 1; k++) parts.push((lines[k]?.text ?? '').trim());
		const tail = spanOf(last.text, 0, last.text.length, false);
		parts.push(last.text.slice(tail.from, tail.to));
		return {
			kind: 'paragraph',
			text: decodeBreaks(parts.join('\n')),
			blockId: tail.blockId,
			range: { from: first.from, to: last.to },
			textRange: i === j - 1 ? { from: last.from + tail.from, to: last.from + tail.to } : null,
		};
	}

	/** Fenced code block whose opening fence text (from the fence characters on) is `opening`. */
	private fence(i: number, opening: string, fenceCol: number, rangeFrom: number): { built: Built; next: number } {
		const lines = this.lines;
		const open = openFence(opening) ?? { char: '`', len: 3 };
		const parts = [opening.trimEnd()];
		let j = i + 1;
		let closed = false;
		for (; j < lines.length; j++) {
			const t = lines[j]?.text ?? '';
			const rest = t.trim();
			if (rest.length >= open.len && rest === open.char.repeat(rest.length)) {
				parts.push(rest);
				closed = true;
				j++;
				break;
			}
			parts.push(stripCols(t, fenceCol));
		}
		let blockId: string | null = null;
		const idLine = closed ? lines[j] : undefined;
		const idMatch = idLine ? BLOCK_ID_LINE.exec(idLine.text) : null;
		if (idMatch) {
			blockId = idMatch[1] ?? null;
			j++;
		}
		const last = lines[j - 1] ?? lines[i];
		return {
			built: {
				kind: 'code',
				text: parts.join('\n'),
				blockId,
				range: { from: rangeFrom, to: last?.to ?? rangeFrom },
				textRange: null,
			},
			next: j,
		};
	}

	private table(i: number, rangeFrom: number): { built: Built; next: number } {
		const lines = this.lines;
		let j = i;
		const rows: string[] = [];
		while (j < lines.length) {
			const t = lines[j]?.text ?? '';
			if (isBlank(t) || !t.includes('|')) break;
			const rest = t.trimStart();
			if (j > i + 1 && !rest.startsWith('|') && (LIST.test(t) || HEADING.test(rest))) break;
			rows.push(t);
			j++;
		}
		const common = Math.min(...rows.map(leadLength));
		const text = rows.map((r) => r.slice(common).trimEnd()).join('\n');
		let blockId: string | null = null;
		const idLine = lines[j];
		const idMatch = idLine ? BLOCK_ID_LINE.exec(idLine.text) : null;
		if (idMatch) {
			blockId = idMatch[1] ?? null;
			j++;
		}
		const last = lines[j - 1];
		return {
			built: { kind: 'table', text, blockId, range: { from: rangeFrom, to: last?.to ?? rangeFrom }, textRange: null },
			next: j,
		};
	}
}

function fillSubtree(node: MapNode): number {
	let end = node.source?.range.to ?? 0;
	for (const c of node.children) end = Math.max(end, fillSubtree(c));
	if (node.source) node.source.subtreeTo = end;
	return end;
}

export function parseDocument(text: string): ParsedDoc {
	const frontmatter = parseFrontmatter(text);
	const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
	const bodyFrom = frontmatter ? frontmatter.range.to : bom;
	const nl = text.indexOf('\n');
	const lineEnding = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';

	const parser = new BodyParser(splitLines(text, bodyFrom));
	let root = parser.parse();
	const only = root.children[0];
	const virtualRoot = !(root.children.length === 1 && only?.kind === 'heading' && only.source?.headingLevel === 1);
	if (!virtualRoot && only) root = only;
	fillSubtree(root);

	const collapsed = new Set<string>();
	const state = frontmatter ? frontmatter.state : { version: 1, collapsed: [], extra: {} };
	if (state) {
		const listed = new Set(state.collapsed.map((id) => id.toLowerCase()));
		const visit = (node: MapNode): void => {
			// The root is never collapsed: it is the map's only entry point.
			// A duplicate block id belongs to its first node only (4.10).
			if (node !== root && node.blockId !== null && node.id === node.blockId && (state.version === 1 || listed.has(node.blockId.toLowerCase()))) {
				collapsed.add(node.id);
			}
			node.children.forEach(visit);
		};
		visit(root);
	}

	return { text, lineEnding, frontmatter, bodyFrom, root, virtualRoot, collapsed };
}
