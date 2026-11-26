// Writes a map as an XMind Zen / 2020+ file: the reverse of the import rules
// in ./read.ts. No Obsidian imports, so the unit tests can load it.
import JSZip from 'jszip';
import { presetOf, splitMarkers } from '../core/markers.ts';
import { planSummaries } from '../core/summary.ts';
import { taskOf } from '../core/tasks.ts';
import type { FrameMark, LayoutDirection, MapNode, NodeKind, SummaryMark } from '../core/types.ts';
import { NOTE_PREFIX, TASK_DONE, XMIND_MARKER_IDS } from './read.ts';

const uuid = () => crypto.randomUUID();

/** What the exporter reads of a node; `ExportNode`s are built from the core tree by `toExportTree`. */
export interface ExportNode {
    text: string;
    /** Only list items can be tasks (behaviour spec 5.9); leave it out and a `[ ]` stays text. */
    kind?: NodeKind;
    collapsed: boolean;
    children: ExportNode[];
    /** 1.5 (spec 5.15): written to the parent's `summaries` when it covers siblings. */
    summary?: SummaryMark;
    /** 1.5: written to the parent's `boundaries`, the label as the title. */
    frame?: FrameMark;
}

/**
 * The core tree as the exporter reads it. A virtual root shows the file name
 * (`rootName`). Folding is the saved folding (`collapsed` ids), so a branch
 * opened temporarily by search still counts as folded; focus mode is not involved.
 */
export function toExportTree(root: MapNode, collapsed: ReadonlySet<string>, rootName?: string): ExportNode {
    const convert = (node: MapNode, isRoot: boolean): ExportNode => {
        const out: ExportNode = {
            text: isRoot && node.kind === 'root' && rootName !== undefined ? rootName : node.text,
            kind: node.kind,
            collapsed: !isRoot && collapsed.has(node.id),
            children: node.children.map((c) => convert(c, false)),
        };
        if (!isRoot && node.summary) out.summary = node.summary;
        if (!isRoot && node.frame) out.frame = node.frame;
        return out;
    };
    return convert(root, true);
}

const STRUCTURES: Record<string, string> = {
    right: 'org.xmind.ui.logic.right',
    left: 'org.xmind.ui.logic.left',
    clockwise: 'org.xmind.ui.map.clockwise',
    down: 'org.xmind.ui.org-chart.down',
};

const LINK = /\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g;

// Formulas, following Obsidian's inline-math rules: `$$…$$` (may span lines) is a
// block; `$…$` needs a non-space right after the opening `$` and right before the
// closing one, and no digit straight after the closing `$` (so "$5 and $6" is
// text). A `\$` is never a delimiter. Inline formulas stay on one line.
const BLOCK_MATH = /(^|[^\\])\$\$(\s*[^\s$][\s\S]*?)\$\$/g;
const INLINE_MATH = /(^|[^\\])\$[^\s$](?:[^$\n]*?[^\s\\$])?\$(?!\d)/g;

export interface TitleParts {
    title: string;
    href: string;
    labels: string[];
    markers: string[];
}

// Splits node text into an XMind title, link, labels and markers. `kind` is the
// node kind: only a list item's leading `[ ]` / `[x]` is a task (same rule as the map).
export function parseTitle(text: string, kind?: NodeKind): TitleParts {
    let title = text.replace(/<br\s*\/?>/gi, '\n').trim();
    const markers: string[] = [];
    const task = kind ? taskOf(title, kind) : null;
    if (task) {
        markers.push(task.done ? 'task-done' : 'task-start');
        title = title.slice(task.length).trimStart();
    }
    const markable = !kind || kind === 'list' || kind === 'heading' || kind === 'paragraph';
    for (let changed = true; changed;) {
        changed = false;
        // 1.4: leading emoji markers with an XMind id become markers; the rest stay in the title
        const run = markable ? splitMarkers(title, 'paragraph') : null;
        if (run && run.markers.length) {
            const keep: string[] = [];
            for (const { emoji } of run.markers) {
                const preset = presetOf(emoji);
                const id = preset?.group === 'priority' ? `priority-${preset.arg}` : preset ? XMIND_MARKER_IDS.get(preset.emoji) : undefined;
                if (!id || markers.includes(id) || (id.startsWith('priority-') && markers.some((m) => m.startsWith('priority-')))) {
                    keep.push(emoji);
                    continue;
                }
                if (id.startsWith('priority-')) markers.unshift(id);
                else markers.push(id);
            }
            if (keep.length < run.markers.length) {
                title = keep.length ? `${keep.join(' ')} ${run.rest}`.trimEnd() : run.rest.trimStart();
                changed = true;
            }
        }
        const priority = /^\(P([1-9])\)\s*/.exec(title);
        if (priority) {
            // a keycap earlier in the text already set the priority; this `(P1)` is dropped
            if (!markers.some((m) => m.startsWith('priority-'))) markers.unshift(`priority-${priority[1]}`);
            title = title.slice(priority[0].length);
            changed = true;
        }
        if (title.startsWith(TASK_DONE) && !markers.includes('task-done')) {
            // an old-style ✅ means done, also on top of an open `[ ]`
            const open = markers.indexOf('task-start');
            if (open >= 0) markers.splice(open, 1);
            markers.push('task-done');
            title = title.slice(TASK_DONE.length).trimStart();
            changed = true;
        }
    }

    const labels: string[] = [];
    for (let m = /\s+`([^`\n]+)`$/.exec(title); m && title.length > m[0].length; m = /\s+`([^`\n]+)`$/.exec(title)) {
        labels.unshift(m[1]);
        title = title.slice(0, -m[0].length);
    }

    // Code spans and formulas are set aside so nothing below touches their content.
    const kept: string[] = [];
    const keep = (text: string) => `\uE000${kept.push(text) - 1}\uE001`;
    title = title
        .replace(/(`{1,2})(?!`)([^\n]*?[^`\n])\1(?!`)/g, (_m, _t: string, code: string) => keep(code))
        .replace(BLOCK_MATH, (_m, before: string, tex: string) => before + keep(`$${tex.trim()}$`))
        .replace(INLINE_MATH, (m, before: string) => before + keep(m.slice(before.length)));

    let href = '';
    title = title.replace(LINK, (match, label: string, url: string) => {
        if (!/^(https?:|mailto:)/i.test(url)) {
            return match;
        }
        href = href || url;
        return label.replace(/\\([[\]])/g, '$1');
    });
    title = title
        .replace(/(^|[^!])\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, before: string, target: string, alias?: string) => before + (alias || target))
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/__([^_\n]+)__/g, '$1')
        .replace(/==([^=\n]+)==/g, '$1')
        .replace(/~~([^~\n]+)~~/g, '$1')
        .replace(/(^|[^*])\*([^*\s][^*\n]*)\*(?!\*)/g, '$1$2');
    title = title.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => kept[Number(i)] ?? '');
    return { title: title.trim(), href, labels, markers };
}

interface XmindTopic {
    id: string;
    class: 'topic';
    title: string;
    href?: string;
    labels?: string[];
    markers?: { markerId: string }[];
    notes?: { plain: { content: string } };
    branch?: 'folded';
    structureClass?: string;
    children?: { attached: XmindTopic[]; summary?: XmindTopic[] };
    summaries?: { id: string; range: string; topicId: string }[];
    boundaries?: { id: string; range: string; title?: string }[];
}

function toTopic(node: ExportNode): XmindTopic {
    const children = node.children;
    let notes = '';
    let skip = 0;
    const first = children[0];
    if (first && !first.children.length && first.text.startsWith(NOTE_PREFIX)) {
        notes = first.text.slice(NOTE_PREFIX.length).replace(/<br\s*\/?>/gi, '\n').trim();
        skip = 1;
    }
    const parts = parseTitle(node.text, node.kind);
    const topic: XmindTopic = { id: uuid(), class: 'topic', title: parts.title };
    if (parts.href) {
        topic.href = parts.href;
    }
    if (parts.labels.length) {
        topic.labels = parts.labels;
    }
    if (parts.markers.length) {
        topic.markers = parts.markers.map((markerId) => ({ markerId }));
    }
    if (notes) {
        topic.notes = { plain: { content: notes } };
    }
    if (node.collapsed && (children.length > skip || notes)) {
        topic.branch = 'folded';
    }
    // 1.5: summaries that cover siblings become XMind summaries over the attached topics they cover
    const plan = planSummaries(children.map((c) => c.summary));
    const attached: XmindTopic[] = [];
    const indexOf: number[] = [];
    const summaryTopics: XmindTopic[] = [];
    const summaries: NonNullable<XmindTopic['summaries']> = [];
    const boundaries: NonNullable<XmindTopic['boundaries']> = [];
    children.forEach((c, i) => {
        if (i < skip) return;
        const cover = plan.covers[i];
        const t = toTopic(c);
        // the note child (a summary may cover it) is no topic: the range starts at the first topic
        const from = cover ? indexOf.slice(cover.first, cover.last + 1).find((x) => x !== undefined) : undefined;
        if (cover && from !== undefined) {
            summaryTopics.push(t);
            summaries.push({ id: uuid(), range: `(${from},${indexOf[cover.last] ?? from})`, topicId: t.id });
            return;
        }
        indexOf[i] = attached.length;
        if (c.frame) {
            const b: NonNullable<XmindTopic['boundaries']>[number] = { id: uuid(), range: `(${attached.length},${attached.length})` };
            if (c.frame.label) b.title = c.frame.label;
            boundaries.push(b);
        }
        attached.push(t);
    });
    if (attached.length) {
        topic.children = { attached };
        if (summaryTopics.length) topic.children.summary = summaryTopics;
    }
    if (summaries.length) topic.summaries = summaries;
    if (boundaries.length) topic.boundaries = boundaries;
    return topic;
}

export function mapToXmindSheet(root: ExportNode, title: string, layoutDirect?: LayoutDirection) {
    const rootTopic = toTopic(root);
    rootTopic.structureClass = STRUCTURES[layoutDirect ?? ''] || 'org.xmind.ui.map.unbalanced';
    return { id: uuid(), class: 'sheet', title, rootTopic };
}

export function buildXmindArchive(sheet: ReturnType<typeof mapToXmindSheet>, version = ''): Promise<ArrayBuffer> {
    const zip = new JSZip();
    zip.file('content.json', JSON.stringify([sheet]));
    zip.file('metadata.json', JSON.stringify({ creator: { name: 'Mapdown', version } }));
    zip.file('manifest.json', JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }));
    // STORE: the bundle carries only pako's inflate half (scripts/bundleOptions.mjs).
    // The entries are a few small JSON files, so compression gains little.
    return zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' });
}
