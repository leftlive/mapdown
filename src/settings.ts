// Settings (behaviour spec section 8): key names, types and defaults are those
// of 0.3.0. Values read from data.json are kept as they are when valid,
// clamped to range when out of range, and replaced by the default when of the
// wrong type. Keys this version does not define (theme, color, exportMdModel,
// anything else) are carried through untouched when saving.

import type { LayoutDirection } from './core/types.ts';

export type LinkOpenMode = 'current' | 'tab' | 'window';

export interface MapdownSettings {
	headLevel: number;
	fontSize: number;
	canvasSize: number;
	background: string;
	layoutDirect: LayoutDirection;
	layout: string;
	strokeArray?: string[];
	nodeGlowSize: number;
	nodeMaxWidth: number;
	focusOnMove: boolean;
	focusOverlayOpacity: number;
	focusGlowSize: number;
	enableLinkPreview: boolean;
	linkOpenMode: LinkOpenMode;
	syncSelection: boolean;
}

export const DEFAULT_SETTINGS: Readonly<MapdownSettings> = {
	headLevel: 1,
	fontSize: 16,
	canvasSize: 8000,
	background: 'transparent',
	layoutDirect: 'mindmap',
	layout: 'mindmap',
	nodeGlowSize: 10,
	nodeMaxWidth: 800,
	focusOnMove: false,
	focusOverlayOpacity: 0.4,
	focusGlowSize: 150,
	enableLinkPreview: true,
	linkOpenMode: 'window',
	syncSelection: true,
};

export const CANVAS_SIZES = [4000, 6000, 8000, 10000, 12000, 16000, 20000, 30000, 36000] as const;
const DIRECTIONS: readonly LayoutDirection[] = ['mindmap', 'right', 'left', 'clockwise'];
const LINK_MODES: readonly LinkOpenMode[] = ['current', 'tab', 'window'];

/** The seven preset palettes (section 8). */
export const PALETTES: Readonly<Record<string, readonly string[]>> = {
	Classic: ['#e63946', '#f4a261', '#e9c46a', '#2a9d8f', '#264653'],
	Pastel: ['#cdb4db', '#ffc8dd', '#ffafcc', '#bde0fe', '#a2d2ff'],
	Bright: ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93'],
	Ocean: ['#03045e', '#0077b6', '#00b4d8', '#90e0ef', '#caf0f8'],
	Forest: ['#d8f3dc', '#b7e4c7', '#95d5b2', '#74c69d', '#52b788', '#40916c', '#2d6a4f', '#1b4332'],
	Earth: ['#cb997e', '#ddbea9', '#ffe8d6', '#b7b7a4', '#a5a58d', '#6b705c'],
	Vintage: ['#22223b', '#4a4e69', '#9a8c98', '#c9ada7', '#f2e9e4'],
};

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function num(v: unknown, def: number, min: number, max: number, step?: number, integer = false): number {
	if (!isNum(v)) return def;
	let x = Math.max(min, Math.min(max, v));
	if (integer) x = Math.round(x);
	if (step !== undefined) x = Math.max(min, Math.min(max, min + Math.round((x - min) / step) * step));
	return x;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
	return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def;
}

const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);

/**
 * Settings from the raw contents of data.json. headLevel follows the format
 * contract 5 (not a number: 1). Out-of-list canvas sizes snap to the nearest
 * allowed size.
 */
export function normalizeSettings(raw: unknown): MapdownSettings {
	const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
	const d = DEFAULT_SETTINGS;
	const canvas = isNum(r.canvasSize)
		? CANVAS_SIZES.reduce((best, s) => (Math.abs(s - (r.canvasSize as number)) < Math.abs(best - (r.canvasSize as number)) ? s : best), CANVAS_SIZES[0] as number)
		: d.canvasSize;
	const out: MapdownSettings = {
		headLevel: num(r.headLevel, d.headLevel, 0, 6, undefined, true),
		fontSize: num(r.fontSize, d.fontSize, 8, 72),
		canvasSize: canvas,
		background: typeof r.background === 'string' ? r.background : d.background,
		layoutDirect: oneOf(r.layoutDirect, DIRECTIONS, d.layoutDirect),
		layout: typeof r.layout === 'string' ? r.layout : d.layout,
		nodeGlowSize: num(r.nodeGlowSize, d.nodeGlowSize, 0, 24, 1),
		nodeMaxWidth: num(r.nodeMaxWidth, d.nodeMaxWidth, 240, 1200, 20),
		focusOnMove: bool(r.focusOnMove, d.focusOnMove),
		focusOverlayOpacity: num(r.focusOverlayOpacity, d.focusOverlayOpacity, 0, 0.8),
		focusGlowSize: num(r.focusGlowSize, d.focusGlowSize, 0, 400, 10),
		enableLinkPreview: bool(r.enableLinkPreview, d.enableLinkPreview),
		linkOpenMode: oneOf(r.linkOpenMode, LINK_MODES, d.linkOpenMode),
		syncSelection: bool(r.syncSelection, d.syncSelection),
	};
	if (Array.isArray(r.strokeArray) && r.strokeArray.every((c) => typeof c === 'string')) {
		out.strokeArray = [...r.strokeArray];
	}
	return out;
}

/** What to write to data.json: the raw object with this version's keys replaced. */
export function settingsForSave(raw: unknown, settings: MapdownSettings): Record<string, unknown> {
	const base = raw !== null && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {};
	const out: Record<string, unknown> = { ...base, ...settings };
	if (settings.strokeArray === undefined) delete out.strokeArray;
	return out;
}
