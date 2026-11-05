// Writes a map as an XMind Zen / 2020+ file: the reverse of the import rules
// in ./read.ts. No Obsidian imports, so the unit tests can load it.
import JSZip from 'jszip';
import type { LayoutDirection, MapNode } from '../core/types.ts';
import { NOTE_PREFIX, TASK_DONE } from './read.ts';

const uuid = () => crypto.randomUUID();

/** What the exporter reads of a node; `ExportNode`s are built from the core tree by `toExportTree`. */
export interface ExportNode {
    text: string;
    collapsed: boolean;
    children: ExportNode[];
}

/**
 * The core tree as the exporter reads it. A virtual root shows the file name
 * (`rootName`). Folding is the saved folding (`collapsed` ids), so a branch
 * opened temporarily by search still counts as folded; focus mode is not involved.
 */
export function toExportTree(root: MapNode, collapsed: ReadonlySet<string>, rootName?: string): ExportNode {
    const convert = (node: MapNode, isRoot: boolean): ExportNode => ({
        text: isRoot && node.kind === 'root' && rootName !== undefined ? rootName : node.text,
        collapsed: !isRoot && collapsed.has(node.id),
        children: node.children.map((c) => convert(c, false)),
    });
    return convert(root, true);
}

const STRUCTURES: Record<string, string> = {
    right: 'org.xmind.ui.logic.right',
    left: 'org.xmind.ui.logic.left',
    clockwise: 'org.xmind.ui.map.clockwise',
};

const LINK = /\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)\)/g;

export interface TitleParts {
    title: string;
    href: string;
    labels: string[];
    markers: string[];
}

// Splits node text into an XMind title, link, labels and markers.
export function parseTitle(text: string): TitleParts {
    let title = text.replace(/<br\s*\/?>/gi, '\n').trim();
    const markers: string[] = [];
    for (let changed = true; changed;) {
        changed = false;
        const priority = /^\(P([1-9])\)\s*/.exec(title);
        if (priority && !markers.some((m) => m.startsWith('priority-'))) {
            markers.unshift(`priority-${priority[1]}`);
            title = title.slice(priority[0].length);
            changed = true;
        }
        if (title.startsWith(TASK_DONE) && !markers.includes('task-done')) {
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
    children?: { attached: XmindTopic[] };
}

function toTopic(node: ExportNode): XmindTopic {
    let children = node.children;
    let notes = '';
    const first = children[0];
    if (first && !first.children.length && first.text.startsWith(NOTE_PREFIX)) {
        notes = first.text.slice(NOTE_PREFIX.length).replace(/<br\s*\/?>/gi, '\n').trim();
        children = children.slice(1);
    }
    const parts = parseTitle(node.text);
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
    if (node.collapsed && (children.length || notes)) {
        topic.branch = 'folded';
    }
    if (children.length) {
        topic.children = { attached: children.map(toTopic) };
    }
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
