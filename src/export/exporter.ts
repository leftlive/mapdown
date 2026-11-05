// PNG, JPEG and HTML export of a map view (development plan 3.6, behaviour
// spec 2.2, 2.3). The picture is an SVG built from the renderer's current
// layout (scene.ts), drawn onto a canvas through a data-URL image. The
// displayed map is only read, never moved or zoomed.
//
// Text is drawn as SVG text with the theme's font stack; only fonts installed
// on the system are visible inside an SVG image, so a theme's web font falls
// back to the next family. Images become data URLs. Formulas are drawn as
// their source (Obsidian ships MathJax's CHTML output only) and the user is
// told at the end.

import { Menu, Notice, Platform, TFile, arrayBufferToBase64, requestUrl, type App } from 'obsidian';
import type { LayoutResult } from '../core/layout.ts';
import { indexNodes } from '../controller/session.ts';
import { folderOf } from '../controller/fileNames.ts';
import { isChinese, t } from '../i18n.ts';
import { LINE_HEIGHT, NODE_BORDER, NODE_LEVELS, extraW, fontFor } from '../view/measure.ts';
import type { MapView } from '../view/MapView.ts';
import {
	buildSvg,
	exportBox,
	exportPath,
	fitScale,
	htmlDocument,
	imageMime,
	imageSize,
	layoutContent,
	parseBlocks,
	type Block,
	type ExportTheme,
	type ResolvedImage,
	type RunStyle,
	type Scene,
	type SceneNode,
} from './scene.ts';

export type ExportFormat = 'png' | 'jpeg' | 'html';

/** Thrown inside the pipeline when the view closed; never reaches the user. */
class Cancelled extends Error {}

/** Fallback only: every scene node carries its own level padding. */
const METRICS = { padX: NODE_LEVELS[2].padX, padY: NODE_LEVELS[2].padY, border: NODE_BORDER };
const REMOTE_TIMEOUT_MS = 10000;
/** Canvas limits: iOS/Android WebViews refuse canvases above ~16.7 M pixels. */
const MAX_PIXELS = Platform.isMobile ? 16_777_216 : 268_435_456;
const MAX_SIDE = Platform.isMobile ? 16_384 : 32_767;

interface Context {
	view: MapView;
	app: App;
	file: TFile;
	doc: Document;
	win: Window;
	signal: AbortSignal;
}

/**
 * Export the map in `view`. Resolves quietly when `signal` aborts (the view
 * closed); other failures end in a notice, never a rejection.
 */
export async function exportMap(view: MapView, format: ExportFormat, scale: number, signal: AbortSignal): Promise<void> {
	try {
		// spec 6.5: commit the active edit and save first
		await view.flush();
		if (signal.aborted || !view.contentEl.isConnected) return;
		const file = view.file;
		const lay = view.renderer?.layoutSnapshot() ?? null;
		if (!file || !lay || !view.canEdit()) return;
		const doc = view.contentEl.ownerDocument;
		const ctx: Context = { view, app: view.app, file, doc, win: doc.defaultView ?? window, signal };
		await runExport(ctx, lay, format, scale);
	} catch (err) {
		if (err instanceof Cancelled || signal.aborted || !view.contentEl.isConnected) return;
		new Notice(t('export-failed', err instanceof Error ? err.message : String(err)));
	}
}

/** The toolbar's export menu (spec 5.1): PNG (HQ), JPEG (HQ), HTML, XMind. "HQ" is scale 4 (fix B2). */
export function showExportMenu(view: MapView): void {
	if (!view.canEdit()) return;
	const button = view.contentEl.querySelector<HTMLElement>('.mapdown-toolbar [data-action="export"]');
	const menu = new Menu();
	const add = (label: string, icon: string, run: () => void): void => {
		menu.addItem((item) => item.setTitle(label).setIcon(icon).onClick(run));
	};
	add(t('export-menu-png'), 'image', () => void view.exportImage('png', 4));
	add(t('export-menu-jpeg'), 'image', () => void view.exportImage('jpeg', 4));
	add(t('export-menu-html'), 'file-code', () => void view.exportImage('html', 1));
	add(t('export-menu-xmind'), 'file-output', () => {
		// registered by the XMind export with addCommand; it saves first itself
		view.app.workspace.setActiveLeaf(view.leaf, { focus: true });
		(view.app as unknown as { commands: { executeCommandById(id: string): boolean } }).commands.executeCommandById('mapdown:export-xmind');
	});
	const r = button?.getBoundingClientRect();
	if (r) menu.showAtPosition({ x: r.left, y: r.bottom }, view.contentEl.ownerDocument);
	else menu.showAtPosition({ x: 0, y: 0 }, view.contentEl.ownerDocument);
}

/** Stops the pipeline once the view closed (its element leaves the document on detach). */
function check(ctx: Context): void {
	if (ctx.signal.aborted || !ctx.view.contentEl.isConnected) throw new Cancelled();
}

async function runExport(ctx: Context, lay: LayoutResult, format: ExportFormat, scale: number): Promise<void> {
	const theme = readTheme(ctx);
	const index = indexNodes(ctx.view.session.doc.root);
	const settings = ctx.view.plugin.settings;
	const measurer = createMeasurer(ctx.doc, theme);

	// blocks of every visible node, then every image they embed
	const blocksOf = new Map<string, Block[]>();
	const imageBlocks: Extract<Block, { type: 'image' }>[] = [];
	for (const id of lay.nodes.keys()) {
		const entry = index.get(id);
		if (!entry) continue;
		const isVirtualRoot = entry.node === ctx.view.session.doc.root && ctx.view.session.doc.virtualRoot;
		const text = isVirtualRoot ? ctx.view.session.rootName : entry.node.text;
		const blocks = parseBlocks(text, entry.node.kind);
		blocksOf.set(id, blocks);
		for (const b of blocks) if (b.type === 'image') imageBlocks.push(b);
	}
	const images = new Map<string, ResolvedImage | null>();
	for (const b of imageBlocks) {
		const key = imageKey(b);
		if (images.has(key)) continue;
		images.set(key, await loadImage(ctx, b));
		check(ctx);
	}

	const rootId = lay.nodes.keys().next().value as string;
	const colors = new Map(lay.edges.map((e) => [e.childId, e.color]));
	const nodes: SceneNode[] = [];
	let missing = 0;
	let formulas = 0;
	for (const [id, p] of lay.nodes) {
		const entry = index.get(id);
		const blocks = blocksOf.get(id);
		if (!entry || !blocks) continue;
		const font = fontFor(entry.depth, settings.fontSize);
		const content = layoutContent({
			blocks,
			innerWidth: Math.max(1, p.width - extraW(font)),
			fontPx: font.px,
			lineHeight: font.px * LINE_HEIGHT,
			measure: (s, style) => measurer.text(s, style, font.px, font.weight),
			measureMono: (s) => measurer.mono(s, font.px),
			image: (b) => images.get(imageKey(b)) ?? null,
			theme,
		});
		missing += content.missingImages;
		formulas += content.formulas;
		const hasShownChild = entry.node.children.some((c) => lay.nodes.has(c.id));
		nodes.push({
			placement: p,
			root: id === rootId,
			fontPx: font.px,
			weight: font.weight,
			color: colors.get(id) ?? '',
			collapsedCount: hasShownChild ? 0 : entry.node.children.length,
			content: content.items,
			level: font.level,
			padX: font.padX,
			padY: font.padY,
			radius: font.radius,
		});
	}
	const scene: Scene = { box: exportBox(lay.bounds), nodes, edges: lay.edges, rootId, theme };
	const folder = folderOf(ctx.file.path);
	const taken = (path: string): boolean => ctx.app.vault.getAbstractFileByPath(path) !== null;

	let path: string;
	if (format === 'html') {
		const html = htmlDocument(buildSvg(scene, METRICS, 1), ctx.file.basename, theme.background, isChinese() ? 'zh' : 'en');
		check(ctx);
		path = exportPath(folder, ctx.file.basename, 'html', taken);
		await ctx.app.vault.create(path, html);
	} else {
		const used = fitScale(scene.box, scale, MAX_PIXELS, MAX_SIDE);
		const data = await rasterize(ctx, buildSvg(scene, METRICS, used), scene, used, format, theme.background);
		check(ctx);
		path = exportPath(folder, ctx.file.basename, format === 'png' ? 'png' : 'jpg', taken);
		await ctx.app.vault.createBinary(path, data);
		if (used !== scale) new Notice(t('export-scale-reduced', used));
	}
	if (formulas > 0) new Notice(t('export-math-source', formulas));
	if (missing > 0) new Notice(t('export-images-missing', missing));
	new Notice(t('export-done', path));
}

// ---------------------------------------------------------------- raster

async function rasterize(ctx: Context, svg: string, scene: Scene, scale: number, format: 'png' | 'jpeg', background: string): Promise<ArrayBuffer> {
	const size = imageSize(scene.box, scale);
	// a data URL, not a blob URL: Chromium keeps the canvas exportable then
	const img = ctx.doc.createElement('img');
	img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
	await img.decode();
	check(ctx);
	const canvas = ctx.doc.createElement('canvas');
	canvas.width = size.width;
	canvas.height = size.height;
	try {
		const c2d = canvas.getContext('2d');
		if (!c2d) throw new Error(t('export-canvas-failed'));
		// JPEG has no alpha: fill first so transparent parts do not turn black
		c2d.fillStyle = background;
		c2d.fillRect(0, 0, size.width, size.height);
		c2d.drawImage(img, 0, 0, size.width, size.height);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, format === 'png' ? 'image/png' : 'image/jpeg', 0.92));
		if (!blob) throw new Error(t('export-canvas-failed'));
		check(ctx);
		return await blob.arrayBuffer();
	} finally {
		// release the bitmap at once; large canvases are scarce on mobile
		canvas.width = 0;
		canvas.height = 0;
	}
}

// ---------------------------------------------------------------- theme and fonts

function readTheme(ctx: Context): ExportTheme {
	const el = ctx.view.contentEl.querySelector<HTMLElement>('.mapdown-map') ?? ctx.view.contentEl;
	const cs = ctx.win.getComputedStyle(el);
	const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
	const px = (name: string, fallback: number): number => {
		const n = parseFloat(cs.getPropertyValue(name));
		return Number.isFinite(n) ? n : fallback;
	};
	const primary = v('--background-primary', '#ffffff');
	// a transparent map background exports on the note background
	const bg = cs.backgroundColor;
	const background = !bg || bg === 'transparent' || /^rgba\(.*,\s*0\)$/.test(bg) ? primary : bg;
	return {
		background,
		nodeFill: primary,
		rootFill: v('--background-secondary', primary),
		border: v('--background-modifier-border', '#dddddd'),
		accent: v('--interactive-accent', '#7b6cd9'),
		text: cs.color || v('--text-normal', '#222222'),
		faint: v('--text-faint', '#999999'),
		link: v('--link-color', v('--text-accent', '#7b6cd9')),
		codeFill: v('--code-background', 'rgba(0, 0, 0, 0.05)'),
		codeText: v('--code-normal', cs.color || '#222222'),
		highlight: v('--text-highlight-bg', 'rgba(255, 208, 0, 0.4)'),
		badgeText: v('--text-on-accent', '#ffffff'),
		fontFamily: cs.fontFamily || 'sans-serif',
		monoFamily: v('--font-monospace', 'monospace'),
		radius: px('--radius-s', 4),
		rootRadius: px('--radius-m', 8),
	};
}

function createMeasurer(doc: Document, theme: ExportTheme): {
	text(s: string, style: RunStyle, px: number, weight: number): number;
	mono(s: string, px: number): number;
} {
	const c2d = doc.createElement('canvas').getContext('2d');
	let current = '';
	const width = (font: string, s: string): number => {
		if (!c2d) return s.length * 0.6 * (parseFloat(font.split('px')[0].split(' ').pop() ?? '16') || 16);
		if (font !== current) {
			c2d.font = font;
			current = font;
		}
		return c2d.measureText(s).width;
	};
	return {
		text: (s, style, px, weight) => {
			const w = style.bold ? Math.max(weight, 700) : weight;
			const family = style.code ? theme.monoFamily : theme.fontFamily;
			return width(`${style.italic ? 'italic ' : ''}${w} ${px}px ${family}`, s);
		},
		mono: (s, px) => width(`400 ${px}px ${theme.monoFamily}`, s),
	};
}

// ---------------------------------------------------------------- images

function imageKey(b: Extract<Block, { type: 'image' }>): string {
	return `${b.wiki ? 'w' : 'm'}|${b.src}`;
}

/** The image as a data URL with its natural size; null when it cannot be loaded. */
async function loadImage(ctx: Context, b: Extract<Block, { type: 'image' }>): Promise<ResolvedImage | null> {
	try {
		let data: ArrayBuffer | null = null;
		let mime: string | null = null;
		if (b.src.startsWith('data:image/')) {
			return await decodeSize(ctx, b.src);
		}
		if (/^https?:\/\//i.test(b.src)) {
			const res = await withTimeout(ctx, requestUrl({ url: b.src, throw: false }), REMOTE_TIMEOUT_MS);
			if (!res || res.status >= 400) return null;
			data = res.arrayBuffer;
			mime = (res.headers['content-type'] ?? res.headers['Content-Type'] ?? '').split(';')[0].trim() || imageMime(b.src);
		} else {
			let link = b.src.split('#')[0];
			if (!b.wiki) {
				try {
					link = decodeURIComponent(link);
				} catch {
					// keep the raw text
				}
			}
			const file = ctx.app.metadataCache.getFirstLinkpathDest(link, ctx.file.path) ?? ctx.app.vault.getAbstractFileByPath(link);
			if (!(file instanceof TFile)) return null;
			mime = imageMime(file.path);
			if (!mime) return null;
			data = await ctx.app.vault.readBinary(file);
		}
		check(ctx);
		if (!data || !mime || !mime.startsWith('image/')) return null;
		return await decodeSize(ctx, `data:${mime};base64,${arrayBufferToBase64(data)}`);
	} catch (err) {
		if (err instanceof Cancelled) throw err;
		return null;
	}
}

async function decodeSize(ctx: Context, href: string): Promise<ResolvedImage | null> {
	const img = ctx.doc.createElement('img');
	img.src = href;
	try {
		await img.decode();
	} catch {
		return null;
	}
	check(ctx);
	// an SVG without its own size decodes as 0 × 0
	const width = img.naturalWidth || 300;
	const height = img.naturalHeight || 150;
	return { href, width, height };
}

async function withTimeout<T>(ctx: Context, p: Promise<T>, ms: number): Promise<T | null> {
	let timer = 0;
	const timeout = new Promise<null>((resolve) => {
		timer = ctx.win.setTimeout(() => resolve(null), ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		ctx.win.clearTimeout(timer);
	}
}
