// PNG, JPEG, SVG and HTML export of a map view (development plan 3.6, behaviour
// spec 2.2, 2.3). The picture is an SVG built from the renderer's current
// layout (scene.ts), drawn onto a canvas through a data-URL image. The
// displayed map is only read, never moved or zoomed.
//
// Text is drawn as SVG text with the theme's font stack; only fonts installed
// on the system are visible inside an SVG image, so a theme's web font falls
// back to the next family. Images become data URLs. Formulas are drawn as
// their source (Obsidian ships MathJax's CHTML output only) and the user is
// told at the end.
//
// Where the file goes (spec 2.3): the "Save as" dialog opens first, straight
// from the command or menu, and the file is built only after a place was
// chosen (save.ts).

import { Menu, Notice, Platform, TFile, arrayBufferToBase64, requestUrl, type App } from 'obsidian';
import type { LayoutResult } from '../core/layout.ts';
import { indexNodes } from '../controller/session.ts';
import { folderOf } from '../controller/fileNames.ts';
import { isChinese, t } from '../i18n.ts';
import type { DoneExtras, ExportExt } from './location.ts';
import { buildPdf } from './pdf.ts';
import { chooseTarget, discardTarget, explainFallback, progressNotice, showDone, writeTarget, type Saved, type Target } from './save.ts';
import { taskOf, taskProgress } from '../core/tasks.ts';
import type { Size } from '../core/types.ts';
import { LINE_HEIGHT, NODE_BORDER, NODE_LEVELS, PROGRESS_SCALE, TASK_BOX_EM, boxSize, decorWidths, extraW, fontFor, progressFont, textWrapWidth } from '../view/measure.ts';
import type { MapView } from '../view/MapView.ts';
import {
	buildSvg,
	cleanFontStack,
	exportBox,
	exportLayout,
	exportPath,
	fitScale,
	htmlDocument,
	imageMime,
	imageSize,
	layoutContent,
	markTaskDone,
	markCards,
	parseBlocks,
	svgDocument,
	type Block,
	type ContentInput,
	type ContentMetrics,
	type ExportTheme,
	type FontEm,
	type ResolvedImage,
	type RunStyle,
	type Scene,
	type SceneNode,
} from './scene.ts';

export type ExportFormat = 'png' | 'jpeg' | 'svg' | 'pdf' | 'html';

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

const EXT: Record<ExportFormat, ExportExt> = { png: 'png', jpeg: 'jpg', svg: 'svg', pdf: 'pdf', html: 'html' };

/**
 * Export the map in `view`. Call it straight from the command or menu
 * handler: the "Save as" dialog opens before anything is awaited (spec 2.3).
 * Resolves quietly when the user cancels the dialog or `signal` aborts (the
 * view closed); other failures end in a notice, never a rejection.
 */
export async function exportMap(view: MapView, format: ExportFormat, scale: number, signal: AbortSignal): Promise<void> {
	const first = view.file;
	if (!first || !view.renderer || !view.canEdit()) return;
	const doc = view.contentEl.ownerDocument;
	const win = doc.defaultView ?? window;
	const picked = chooseTarget(win, view.plugin.settings.exportLocation, first.basename, EXT[format]);
	let target: Target | null = null;
	let progress: { stop(): void } | null = null;
	try {
		// spec 6.5: commit the active edit and save first (while the dialog is open)
		await view.flush();
		target = await picked;
		if (!target) return;
		check({ view, signal });
		const file = view.file;
		const lay = view.renderer?.layoutSnapshot() ?? null;
		if (!file || !lay || !view.canEdit()) throw new Cancelled();
		const ctx: Context = { view, app: view.app, file, doc, win, signal };
		progress = progressNotice(win);
		const done = await runExport(ctx, lay, format, scale, target);
		progress.stop();
		showDone(view.app, done.saved, 'export-done', done.extras);
	} catch (err) {
		progress?.stop();
		// the dialog may still be open when saving the note failed: wait for it, then remove what it created
		await discardTarget(target ?? (await picked));
		if (err instanceof Cancelled || signal.aborted || !view.contentEl.isConnected) return;
		new Notice(t('export-failed', err instanceof Error ? err.message : String(err)));
	}
}

/** The toolbar's export menu (spec 5.1): PNG (HQ), JPEG (HQ), SVG, PDF, HTML, XMind. "HQ" is scale 4 (fix B2). */
export function showExportMenu(view: MapView): void {
	if (!view.canEdit()) return;
	const button = view.contentEl.querySelector<HTMLElement>('.mapdown-toolbar [data-action="export"]');
	const menu = new Menu();
	const add = (label: string, icon: string, run: () => void): void => {
		menu.addItem((item) => item.setTitle(label).setIcon(icon).onClick(run));
	};
	add(t('export-menu-png'), 'image', () => void view.exportImage('png', 4));
	add(t('export-menu-jpeg'), 'image', () => void view.exportImage('jpeg', 4));
	add(t('export-menu-svg'), 'image', () => void view.exportImage('svg', 1));
	add(t('export-menu-pdf'), 'file-text', () => void view.exportImage('pdf', 4));
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
function check(ctx: Pick<Context, 'view' | 'signal'>): void {
	if (ctx.signal.aborted || !ctx.view.contentEl.isConnected) throw new Cancelled();
}

async function runExport(ctx: Context, lay: LayoutResult, format: ExportFormat, scale: number, target: Target): Promise<{ saved: Saved; extras: DoneExtras }> {
	const theme = readTheme(ctx);
	const index = indexNodes(ctx.view.session.doc.root);
	const settings = ctx.view.plugin.settings;
	const measurer = createMeasurer(ctx.doc, theme);
	// SVG text sits on explicit baselines from the fonts' ascent and descent (spec 2.3)
	const metrics: ContentMetrics = { ...METRICS, text: measurer.em(theme.fontFamily), mono: measurer.em(theme.monoFamily) };
	// PNG, JPEG and SVG draw task checkboxes, the done style and progress; HTML stays as before (spec 5.9)
	const tasks = format !== 'html';
	const counts = tasks && settings.showTaskProgress ? taskProgress(ctx.view.session.doc.root) : null;
	const cards = format !== 'html' ? ctx.view.cardLabels() : null;

	// blocks of every visible node, then every image they embed
	const blocksOf = new Map<string, Block[]>();
	const imageBlocks: Extract<Block, { type: 'image' }>[] = [];
	for (const id of lay.nodes.keys()) {
		const entry = index.get(id);
		if (!entry) continue;
		const isVirtualRoot = entry.node === ctx.view.session.doc.root && ctx.view.session.doc.virtualRoot;
		const text = isVirtualRoot ? ctx.view.session.rootName : entry.node.text;
		const task = tasks ? taskOf(text, entry.node.kind) : null;
		const own = task ? text.slice(task.length) : text;
		// PNG, JPEG and SVG draw map embeds as cards (spec 5.10); HTML keeps the text as before
		const parsed = parseBlocks(entry.node.kind === 'code' ? own : markCards(own, cards), entry.node.kind);
		const blocks = task?.done ? markTaskDone(parsed) : parsed;
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

	// Text wraps at the content box's max width, as on screen (spec 2.3): the placed width is offsetWidth,
	// rounded to whole pixels, and is often a fraction narrower than the text it holds.
	const params = ctx.view.renderer?.layoutParams() ?? null;
	const maxWidth = params?.nodeMaxWidth ?? settings.nodeMaxWidth;
	interface Prepared {
		id: string;
		font: ReturnType<typeof fontFor>;
		side: { lead: number; tail: number };
		task: ReturnType<typeof taskOf>;
		count: { done: number; total: number } | undefined;
		label: string | null;
		lineHeight: number;
		input: ContentInput;
		content: ReturnType<typeof layoutContent>;
	}
	const prepared: Prepared[] = [];
	// nodes drawn differently from the screen (formulas as source) get the size of what is drawn
	const sizes = new Map<string, Size>();
	let missing = 0;
	let formulas = 0;
	for (const [id, p] of lay.nodes) {
		const entry = index.get(id);
		const blocks = blocksOf.get(id);
		if (!entry || !blocks) continue;
		const font = fontFor(entry.depth, settings.fontSize);
		const task = tasks ? taskOf(entry.node.text, entry.node.kind) : null;
		const count = counts?.get(id);
		const label = count ? `${count.done}/${count.total}` : null;
		const lf = progressFont(font);
		const side = decorWidths(task || label ? { task: task !== null, progress: label } : null, font, (s) => measurer.text(s, {}, lf.px, lf.weight));
		const lineHeight = font.px * LINE_HEIGHT;
		const wrapWidth = Math.max(1, textWrapWidth(maxWidth, font, side));
		const input: ContentInput = {
			blocks,
			innerWidth: Math.max(1, p.width - extraW(font) - side.lead - side.tail),
			wrapWidth,
			fontPx: font.px,
			lineHeight,
			measure: (s, style) => measurer.text(s, style, font.px, font.weight),
			measureMono: (s) => measurer.mono(s, font.px),
			image: (b) => images.get(imageKey(b)) ?? null,
			theme,
		};
		let content = layoutContent(input);
		if (content.formulas > 0) {
			// measure at the full width first; images and code then fit the box that results
			const natural = layoutContent({ ...input, innerWidth: wrapWidth });
			const size = boxSize(natural.width + side.lead + side.tail, natural.height, font, maxWidth);
			sizes.set(id, size);
			input.innerWidth = Math.max(1, size.width - extraW(font) - side.lead - side.tail);
			content = layoutContent(input);
		}
		missing += content.missingImages;
		formulas += content.formulas;
		prepared.push({ id, font, side, task, count, label, lineHeight, input, content });
	}
	const childrenOf = (id: string): string[] => index.get(id)?.node.children.map((c) => c.id) ?? [];
	const drawn = params ? exportLayout(lay, childrenOf, sizes, params.direction, params.palette) : lay;

	const rootId = drawn.nodes.keys().next().value as string;
	const colors = new Map(drawn.edges.map((e) => [e.childId, e.color]));
	const nodes: SceneNode[] = [];
	for (const { id, font, side, task, count, label, lineHeight, content } of prepared) {
		const entry = index.get(id);
		const p = drawn.nodes.get(id);
		if (!entry || !p) continue;
		const hasShownChild = entry.node.children.some((c) => drawn.nodes.has(c.id));
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
			task: task ? { done: task.done, size: font.px * TASK_BOX_EM, lead: side.lead, cy: lineHeight / 2 } : null,
			progress: count && label ? { label, complete: count.done === count.total, fontPx: font.px * PROGRESS_SCALE, cy: lineHeight / 2 } : null,
		});
	}
	const scene: Scene = { box: exportBox(drawn.bounds), nodes, edges: drawn.edges, rootId, theme, branchStyle: settings.branchStyle };
	const folder = folderOf(ctx.file.path);
	const taken = (path: string): boolean => ctx.app.vault.getAbstractFileByPath(path) !== null;

	let data: string | ArrayBuffer;
	let scaleUsed: number | null = null;
	if (format === 'svg') {
		data = svgDocument(buildSvg(scene, metrics, 1));
	} else if (format === 'html') {
		data = htmlDocument(buildSvg(scene, metrics, 1), ctx.file.basename, theme.background, isChinese() ? 'zh' : 'en');
	} else {
		const used = fitScale(scene.box, scale, MAX_PIXELS, MAX_SIDE);
		if (format === 'pdf') {
			// one JPEG page; a CSS pixel is 0.75 pt (spec 2.3)
			const jpeg = await rasterize(ctx, buildSvg(scene, metrics, used), scene, used, 'jpeg', theme.background);
			const px = imageSize(scene.box, used);
			data = buildPdf(new Uint8Array(jpeg), px.width, px.height, scene.box.width * 0.75, scene.box.height * 0.75, ctx.file.basename).buffer as ArrayBuffer;
		} else {
			data = await rasterize(ctx, buildSvg(scene, metrics, used), scene, used, format, theme.background);
		}
		if (used !== scale) scaleUsed = used;
	}
	check(ctx);
	const saved = await writeTarget(ctx.app, target, () => exportPath(folder, ctx.file.basename, EXT[format], taken), data);
	return { saved, extras: { formulas, missing, scaleUsed, fellBack: explainFallback(target) } };
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
	// Theme colours may be hsl(... calc(...)) over several lines; exports must hold concrete rgb()/rgba()
	// values that SVG editors and other renderers understand.
	const probe = el.createDiv();
	probe.setCssProps({ display: 'none' });
	const canvas = probe.createEl('canvas').getContext('2d');
	const concrete = (value: string, fallback: string): string => {
		for (const candidate of [value, fallback]) {
			probe.setCssProps({ color: '' });
			probe.setCssProps({ color: candidate.replace(/\s+/g, ' ').trim() });
			if (!probe.style.color) continue;
			let out = ctx.win.getComputedStyle(probe).color;
			if (!/^rgba?\(/.test(out) && canvas) {
				// color(srgb …), lab() and the like: the canvas reads back as #rrggbb or rgba()
				canvas.fillStyle = '#000000';
				canvas.fillStyle = probe.style.color;
				out = String(canvas.fillStyle);
			}
			if (/^(#|rgba?\()/.test(out)) return out;
		}
		return fallback;
	};
	try {
		const v = (name: string, fallback: string): string => concrete(cs.getPropertyValue(name).trim() || fallback, fallback);
		const px = (name: string, fallback: number): number => {
			const n = parseFloat(cs.getPropertyValue(name));
			return Number.isFinite(n) ? n : fallback;
		};
		const primary = v('--background-primary', '#ffffff');
		const textNormal = concrete(cs.color || '', v('--text-normal', '#222222'));
		// a transparent map background exports on the note background
		const bg = cs.backgroundColor;
		const background = !bg || bg === 'transparent' || /^rgba\(.*,\s*0\)$/.test(bg) ? primary : concrete(bg, primary);
		return {
			background,
			nodeFill: primary,
			rootFill: v('--background-secondary', primary),
			border: v('--background-modifier-border', '#dddddd'),
			accent: v('--interactive-accent', '#7b6cd9'),
			text: textNormal,
			faint: v('--text-faint', '#999999'),
			link: v('--link-color', v('--text-accent', '#7b6cd9')),
			codeFill: v('--code-background', 'rgba(0, 0, 0, 0.05)'),
			codeText: v('--code-normal', textNormal),
			highlight: v('--text-highlight-bg', 'rgba(255, 208, 0, 0.4)'),
			badgeText: v('--text-on-accent', '#ffffff'),
			fontFamily: cleanFontStack(cs.fontFamily, 'sans-serif'),
			monoFamily: cleanFontStack(cs.getPropertyValue('--font-monospace'), 'monospace'),
			radius: px('--radius-s', 4),
			rootRadius: px('--radius-m', 8),
			taskDone: v('--checklist-done-color', v('--text-muted', '#888888')),
			muted: v('--text-muted', '#888888'),
			success: v('--text-success', v('--color-green', '#08b94e')),
		};
	} finally {
		probe.remove();
	}
}

/** Fonts are measured this large for their ascent and descent: canvas rounds them to whole pixels. */
const EM_PROBE_PX = 1000;

function createMeasurer(doc: Document, theme: ExportTheme): {
	text(s: string, style: RunStyle, px: number, weight: number): number;
	mono(s: string, px: number): number;
	/** Ascent and descent of the family's first available font, per em; undefined when the canvas cannot tell. */
	em(family: string): FontEm | undefined;
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
		em: (family) => {
			if (!c2d) return undefined;
			const font = `400 ${EM_PROBE_PX}px ${family}`;
			if (font !== current) {
				c2d.font = font;
				current = font;
			}
			const m = c2d.measureText('H');
			const ascent = m.fontBoundingBoxAscent;
			const descent = m.fontBoundingBoxDescent;
			if (!Number.isFinite(ascent) || !Number.isFinite(descent) || ascent <= 0) return undefined;
			return { ascent: ascent / EM_PROBE_PX, descent: descent / EM_PROBE_PX };
		},
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
