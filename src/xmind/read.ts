// Reads .xmind files (XMind Zen / 2020+ `content.json` and XMind 8
// `content.xml`) into a topic tree and writes each sheet as a Mapdown note.
// No Obsidian imports, so the unit tests can load it.
import JSZip from 'jszip';
import { collapsedIdsBreadthFirst, writeOutline, type OutlineSource } from '../core/outline.ts';

export interface TopicNode {
    text: string;
    collapsed: boolean;
    children: TopicNode[];
    blockId?: string;
}

export interface XmindSheet {
    title: string;
    root: TopicNode;
}

export type SkippedKind = 'summary' | 'boundary' | 'relationship' | 'callout' | 'image';

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
export const TASK_DONE = '✅';

// The parts of a topic both file formats provide.
interface RawTopic {
    title: string;
    href: string;
    notes: string;
    labels: string[];
    markers: string[];
    folded: boolean;
    attached: RawTopic[];
    detached: RawTopic[];
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
        skipped: { summary: 0, boundary: 0, relationship: 0, callout: 0, image: 0 },
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
    raw.attached.forEach((t) => node.children.push(convertTopic(t, doc)));
    return node;
}

function topicText(raw: RawTopic) {
    let title = raw.title;
    const href = raw.href.trim();
    if (/^(https?:|mailto:)/i.test(href)) {
        const label = (title || href).replace(/\n/g, ' ').replace(/[[\]]/g, '\\$&');
        title = `[${label}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
    }
    const prefix: string[] = [];
    const priority = raw.markers.map((m) => /^priority-(\d+)$/.exec(m)).find(Boolean);
    if (priority) {
        prefix.push(`(P${priority[1]})`);
    }
    if (raw.markers.includes('task-done')) {
        prefix.push(TASK_DONE);
    }
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
    return {
        title: normalizeText(topic.title),
        href: typeof topic.href === 'string' ? topic.href : '',
        notes: normalizeText(obj(obj(topic.notes).plain).content),
        labels: list(topic.labels).filter((l): l is string => typeof l === 'string'),
        markers: list(topic.markers).map((m) => stringOf(obj(m).markerId)),
        folded: topic.branch === 'folded',
        attached: list(children.attached).map(zenTopic),
        detached: list(children.detached).map(zenTopic),
        skipped: {
            summary: list(topic.summaries).length,
            boundary: list(topic.boundaries).length,
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
    return {
        title: normalizeText(elements(topic, 'title')[0]?.textContent),
        href: topic.getAttribute('xlink:href') || '',
        notes: normalizeText(notes ? elements(notes, 'plain')[0]?.textContent : ''),
        labels: grouped('labels', 'label').map((l) => l.textContent || ''),
        markers: grouped('marker-refs', 'marker-ref').map((m) => m.getAttribute('marker-id') || ''),
        folded: topic.getAttribute('branch') === 'folded',
        attached: childTopics('attached').map(legacyTopic),
        detached: childTopics('detached').map(legacyTopic),
        skipped: {
            summary: grouped('summaries', 'summary').length,
            boundary: grouped('boundaries', 'boundary').length,
            callout: childTopics('callout').length,
            image: elements(topic, 'img').length,
        },
    };
}

const topicSource: OutlineSource<TopicNode> = {
    children: (n) => n.children,
    text: (n) => n.text,
    blockId: (n) => n.blockId || '',
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
