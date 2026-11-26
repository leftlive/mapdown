// Reads .xmind files (XMind Zen / 2020+ `content.json` and XMind 8
// `content.xml`) into a topic tree and writes each sheet as a Mapdown note.
// No Obsidian imports, so the unit tests can load it.
import JSZip from 'jszip';
import { MARKER_PRESETS, presetOf } from '../core/markers.ts';
import { collapsedIdsBreadthFirst, writeOutline, type OutlineSource } from '../core/outline.ts';
import { cleanLabel, notesSuffix, planSummaries } from '../core/summary.ts';
import type { FrameMark, SummaryMark } from '../core/types.ts';

export interface TopicNode {
    text: string;
    collapsed: boolean;
    children: TopicNode[];
    blockId?: string;
    /** 1.5: an XMind summary topic, placed after the topics it covers (spec 5.15). */
    summary?: SummaryMark;
    /** 1.5: a boundary around this one topic. */
    frame?: FrameMark;
}

export interface XmindSheet {
    title: string;
    root: TopicNode;
}

/** 1.5: summaries are imported; boundaries only when they enclose a single topic. */
export type SkippedKind = 'boundary' | 'relationship' | 'callout' | 'image';

export interface XmindDocument {
    sheets: XmindSheet[];
    topicCount: number;
    skipped: Record<SkippedKind, number>;
}

export type XmindErrorCode = 'parse' | 'unrecognized';

export class XmindImportError extends Error {
    code: XmindErrorCode;
    constructor(code: XmindErrorCode, message: string) {
        super(message);
        this.code = code;
    }
}

export const NOTE_PREFIX = '📝 ';
/** The old import prefix; export still reads it (notes written by earlier versions). */
export const TASK_DONE = '✅';

// The parts of a topic both file formats provide.
/** A summary or boundary of a topic's children: indices into `attached`, both ends included. */
interface RawRange {
    start: number;
    end: number;
}

interface RawTopic {
    id: string;
    title: string;
    href: string;
    notes: string;
    labels: string[];
    markers: string[];
    folded: boolean;
    attached: RawTopic[];
    detached: RawTopic[];
    /** 1.5: summaries over `attached` with their topics (`children.summary`). */
    summaries: (RawRange & { topic: RawTopic })[];
    /** 1.5: boundaries over `attached`; null for a master or unreadable range. */
    boundaries: ((RawRange & { title: string }) | null)[];
    skipped: Partial<Record<SkippedKind, number>>;
}

interface RawSheet {
    title: string;
    root: RawTopic | null;
    relationships: number;
}

export async function readXmind(
    data: ArrayBuffer | Uint8Array,
    parseXml: (text: string) => Document = (text) => new DOMParser().parseFromString(text, 'application/xml'),
): Promise<XmindDocument> {
    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(data);
    } catch (err) {
        throw new XmindImportError('parse', `Not an XMind archive: ${String(err)}`);
    }
    let raw: RawSheet[];
    const json = zip.file('content.json');
    const xml = zip.file('content.xml');
    if (json) {
        raw = parseZenContent(await json.async('text'));
    } else if (xml) {
        raw = parseLegacyContent(await xml.async('text'), parseXml);
    } else {
        throw new XmindImportError('unrecognized', 'The archive has no content.json or content.xml');
    }
    if (!raw.length || raw.some((s) => !s.root)) {
        throw new XmindImportError('parse', 'A sheet has no central topic');
    }

    const doc: XmindDocument = {
        sheets: [],
        topicCount: 0,
        skipped: { boundary: 0, relationship: 0, callout: 0, image: 0 },
    };
    raw.forEach((sheet, i) => {
        if (!sheet.root) {
            return;
        }
        doc.skipped.relationship += sheet.relationships;
        const root = convertTopic(sheet.root, doc);
        // Floating topics hang under the central topic, after its branches.
        sheet.root.detached.forEach((t) => root.children.push(convertTopic(t, doc)));
        const title = sheet.title.trim() || `Sheet ${i + 1}`;
        // The root is written as a heading: it needs text, and the map never collapses it.
        root.text = root.text || title;
        root.collapsed = false;
        doc.sheets.push({ title, root });
    });
    return doc;
}

function convertTopic(raw: RawTopic, doc: XmindDocument): TopicNode {
    doc.topicCount++;
    (Object.keys(raw.skipped) as SkippedKind[]).forEach((k) => {
        doc.skipped[k] += raw.skipped[k] || 0;
    });
    const node: TopicNode = {
        text: topicText(raw),
        collapsed: raw.folded && (raw.attached.length > 0 || !!raw.notes),
        children: [],
    };
    if (raw.notes) {
        node.children.push({ text: NOTE_PREFIX + raw.notes, collapsed: false, children: [] });
    }
    const attached = raw.attached.map((t) => convertTopic(t, doc));
    // 1.5: a boundary around one topic is its frame; around several (or the whole map) it is skipped
    for (const b of raw.boundaries) {
        const target = b && b.start === b.end ? attached[b.start] : undefined;
        if (!target || target.frame) {
            doc.skipped.boundary++;
            continue;
        }
        const label = cleanLabel(b?.title ?? '');
        target.frame = label ? { label } : {};
    }
    // 1.5: a summary follows the last topic it covers (spec 5.15)
    const summaries = raw.summaries
        .filter((r) => r.start >= 0 && r.start <= r.end && r.end < attached.length)
        .sort((a, b) => a.end - b.end || b.start - a.start);
    let next = 0;
    attached.forEach((child, i) => {
        node.children.push(child);
        for (; next < summaries.length && summaries[next].end === i; next++) {
            const r = summaries[next];
            const topic = convertTopic(r.topic, doc);
            topic.summary = summaryMark(node.children, r.end - r.start + 1);
            node.children.push(topic);
        }
    });
    return node;
}

/** `%%summary%%` when the default range of a summary placed after `siblings` covers exactly `count`, else `:count` (1–99). */
function summaryMark(siblings: readonly TopicNode[], count: number): SummaryMark {
    const marks = [...siblings.map((c) => c.summary), {}];
    const cover = planSummaries(marks).covers[siblings.length];
    const n = Math.min(99, count);
    return cover && cover.last - cover.first + 1 === n ? {} : { count: n };
}

/** `(s,e)` with s <= e; null otherwise (a master boundary says `master`). */
function rangeOf(value: unknown): RawRange | null {
    const m = /^\(\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(typeof value === 'string' ? value.trim() : '');
    if (!m) return null;
    const start = Number(m[1]);
    const end = Number(m[2]);
    return start <= end ? { start, end } : null;
}

/** Summaries whose topic is found; the others are dropped without a count. */
function summariesOf(items: { range: unknown; topicId: string }[], topics: RawTopic[]): RawTopic['summaries'] {
    const byId = new Map(topics.map((t) => [t.id, t]));
    const out: RawTopic['summaries'] = [];
    for (const item of items) {
        const range = rangeOf(item.range);
        const topic = byId.get(item.topicId);
        if (range && topic) out.push({ ...range, topic });
    }
    return out;
}

/** A boundary's title: none when XMind marks it unedited (its default "Boundary" text). */
function boundaryOf(range: unknown, title: string, unedited: boolean): RawTopic['boundaries'][number] {
    const r = rangeOf(range);
    return r ? { ...r, title: unedited ? '' : title } : null;
}

/**
 * Preset markers (other than priorities) with a confirmed XMind marker id: the
 * group-name pattern is the one `priority-n`, `task-done` and `flag-red` already
 * use, the names come from the XMind SDK's marker list. Colour circles, 💡, 🔥 and
 * 👍 have no confirmed counterpart and stay text.
 */
export const XMIND_MARKER_IDS: ReadonlyMap<string, string> = new Map([
    ['\u{1F6A9}', 'flag-red'],
    ['⭐', 'star-yellow'],
    ['❓', 'symbol-question'],
    ['❗', 'symbol-exclam'],
    ['⚠\uFE0F', 'symbol-attention'],
]);
const EMOJI_OF_ID = new Map([...XMIND_MARKER_IDS].map(([emoji, id]) => [id, emoji]));

/** The marker run for imported ids: `n️⃣` for priority-n, then the mapped symbols, in preset order. */
function markerRun(ids: readonly string[]): string[] {
    const found: string[] = [];
    const priority = ids.map((m) => /^priority-([1-9])$/.exec(m)).find(Boolean);
    const keycap = priority ? MARKER_PRESETS.find((p) => p.group === 'priority' && p.arg === Number(priority[1])) : undefined;
    if (keycap) found.push(keycap.emoji);
    const emojis = ids.map((id) => EMOJI_OF_ID.get(id)).filter((e): e is string => !!e);
    const rank = (e: string) => MARKER_PRESETS.findIndex((p) => p === presetOf(e));
    for (const e of [...new Set(emojis)].sort((a, b) => rank(a) - rank(b))) found.push(e);
    return found;
}

function topicText(raw: RawTopic) {
    let title = raw.title;
    const href = raw.href.trim();
    if (/^(https?:|mailto:)/i.test(href)) {
        const label = (title || href).replace(/\n/g, ' ').replace(/[[\]]/g, '\\$&');
        title = `[${label}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
    }
    const prefix: string[] = [];
    // 1.2: task progress comes back as a checkbox, ahead of the other prefixes
    if (raw.markers.includes('task-done')) {
        prefix.push('[x]');
    } else if (raw.markers.some((m) => m.startsWith('task-'))) {
        prefix.push('[ ]');
    }
    // 1.4: priority and the confirmed symbol markers come back as emoji, after the checkbox
    prefix.push(...markerRun(raw.markers));
    const labels = raw.labels.map((l) => l.trim()).filter(Boolean).map((l) => `\`${l.replace(/`/g, '')}\``);
    return [...prefix, title, ...labels].filter(Boolean).join(' ');
}

function normalizeText(value: unknown) {
    return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (typeof value === 'object' && value !== null ? (value as Obj) : {});
const stringOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function parseZenContent(text: string): RawSheet[] {
    let sheets: unknown;
    try {
        sheets = JSON.parse(text);
    } catch (err) {
        throw new XmindImportError('parse', `Invalid content.json: ${String(err)}`);
    }
    if (!Array.isArray(sheets)) {
        throw new XmindImportError('parse', 'content.json is not a list of sheets');
    }
    return sheets.map((item: unknown) => {
        const sheet = obj(item);
        return {
            title: normalizeText(sheet.title),
            root: sheet.rootTopic ? zenTopic(sheet.rootTopic) : null,
            relationships: list(sheet.relationships).length,
        };
    });
}

function zenTopic(item: unknown): RawTopic {
    const topic = obj(item);
    const children = obj(topic.children);
    const summaryTopics = list(children.summary).map(zenTopic);
    return {
        id: stringOf(topic.id),
        title: normalizeText(topic.title),
        href: typeof topic.href === 'string' ? topic.href : '',
        notes: normalizeText(obj(obj(topic.notes).plain).content),
        labels: list(topic.labels).filter((l): l is string => typeof l === 'string'),
        markers: list(topic.markers).map((m) => stringOf(obj(m).markerId)),
        folded: topic.branch === 'folded',
        attached: list(children.attached).map(zenTopic),
        detached: list(children.detached).map(zenTopic),
        summaries: summariesOf(list(topic.summaries).map((s) => ({ range: obj(s).range, topicId: stringOf(obj(s).topicId) })), summaryTopics),
        boundaries: list(topic.boundaries).map((b) => boundaryOf(obj(b).range, normalizeText(obj(b).title), obj(b).titleUnedited === true)),
        skipped: {
            callout: list(children.callout).length,
            image: topic.image ? 1 : 0,
        },
    };
}

function elements(parent: Element, name: string) {
    return Array.from(parent.children).filter((el) => el.localName === name);
}

function parseLegacyContent(text: string, parseXml: (text: string) => Document): RawSheet[] {
    const xml = parseXml(text);
    const root = xml?.documentElement;
    if (!root || root.localName !== 'xmap-content' || xml.getElementsByTagName('parsererror').length) {
        throw new XmindImportError('parse', 'Invalid content.xml');
    }
    return elements(root, 'sheet').map((sheet) => {
        const topic = elements(sheet, 'topic')[0];
        const relationships = elements(sheet, 'relationships')[0];
        return {
            title: normalizeText(elements(sheet, 'title')[0]?.textContent),
            root: topic ? legacyTopic(topic) : null,
            relationships: relationships ? elements(relationships, 'relationship').length : 0,
        };
    });
}

function legacyTopic(topic: Element): RawTopic {
    const childTopics = (type: string) => {
        const children = elements(topic, 'children')[0];
        if (!children) {
            return [];
        }
        return elements(children, 'topics')
            .filter((g) => g.getAttribute('type') === type)
            .reduce((all: Element[], g) => all.concat(elements(g, 'topic')), []);
    };
    const grouped = (group: string, item: string) => {
        const el = elements(topic, group)[0];
        return el ? elements(el, item) : [];
    };
    const notes = elements(topic, 'notes')[0];
    const summaryTopics = childTopics('summary').map(legacyTopic);
    return {
        id: topic.getAttribute('id') || '',
        title: normalizeText(elements(topic, 'title')[0]?.textContent),
        href: topic.getAttribute('xlink:href') || '',
        notes: normalizeText(notes ? elements(notes, 'plain')[0]?.textContent : ''),
        labels: grouped('labels', 'label').map((l) => l.textContent || ''),
        markers: grouped('marker-refs', 'marker-ref').map((m) => m.getAttribute('marker-id') || ''),
        folded: topic.getAttribute('branch') === 'folded',
        attached: childTopics('attached').map(legacyTopic),
        detached: childTopics('detached').map(legacyTopic),
        summaries: summariesOf(grouped('summaries', 'summary').map((s) => ({ range: s.getAttribute('range'), topicId: s.getAttribute('topic-id') || '' })), summaryTopics),
        boundaries: grouped('boundaries', 'boundary').map((b) => boundaryOf(b.getAttribute('range'), normalizeText(elements(b, 'title')[0]?.textContent), false)),
        skipped: {
            callout: childTopics('callout').length,
            image: elements(topic, 'img').length,
        },
    };
}

const topicSource: OutlineSource<TopicNode> = {
    children: (n) => n.children,
    text: (n) => n.text,
    blockId: (n) => n.blockId || '',
    notes: (n) => notesSuffix(n),
};

// A fresh block id: letters, digits and `-` only (format contract 4.8).
function newBlockId() {
    return crypto.randomUUID();
}

// The full note for one sheet, in the form the map itself saves (format
// contract 3 and 6). The root is always a level-1 heading, so headLevel 0 is
// raised to 1; the file ends with one line break (6.5).
export function sheetToNote(sheet: XmindSheet, headLevel: unknown) {
    const visit = (n: TopicNode) => {
        if (n.collapsed && !n.blockId) {
            n.blockId = newBlockId();
        }
        n.children.forEach(visit);
    };
    visit(sheet.root);
    const collapsed = collapsedIdsBreadthFirst(sheet.root, topicSource, (n) => n.collapsed);
    const state = `mindmark-state: ${JSON.stringify({ version: 2, collapsed })}`;
    const level = Math.max(1, Number(headLevel) || 0);
    const body = writeOutline(sheet.root, level, topicSource, '\n');
    return `---\nmindmap-plugin: basic\n${state}\n---\n\n${body}\n`;
}

export function sanitizeNoteName(name: string) {
    return name.replace(/[\\/:*?"<>|#^[\]\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// One sheet keeps the file name; several get `<file> - <sheet>`.
export function sheetNoteNames(baseName: string, sheets: XmindSheet[]) {
    const base = sanitizeNoteName(baseName) || 'XMind';
    if (sheets.length === 1) {
        return [base];
    }
    return sheets.map((s, i) => `${base} - ${sanitizeNoteName(s.title) || `Sheet ${i + 1}`}`);
}
