// Pure part of the settings tab (behaviour spec section 8): converting what a
// control produces (strings, slider positions, palette names) into validated
// settings, and back. No Obsidian imports, so it is unit-tested directly.

import { CANVAS_SIZES, DEFAULT_SETTINGS, PALETTES, type MapdownSettings } from './settings.ts';

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 72;

/** The palette choice that means "strokeArray not set". */
export const DEFAULT_PALETTE_KEY = 'default';

export const DIRECTION_VALUES = ['mindmap', 'right', 'left', 'clockwise'] as const;
export const LINK_MODE_VALUES = ['current', 'tab', 'window'] as const;

/** Setting keys that have a control (`layout` is kept in data.json but not shown). */
export type SettingKey = Exclude<keyof MapdownSettings, 'layout'>;

/** A font size typed in the text box: null when it is not a number from 8 to 72. */
export function parseFontSize(input: string): number | null {
	const s = input.trim();
	if (s === '' || !/^\d+(\.\d+)?$/.test(s)) return null;
	const n = Number(s);
	return n >= FONT_SIZE_MIN && n <= FONT_SIZE_MAX ? n : null;
}

function clampStep(n: number, min: number, max: number, step: number): number {
	const x = Math.max(min, Math.min(max, n));
	return Math.max(min, Math.min(max, min + Math.round((x - min) / step) * step));
}

const finite = (v: unknown): number | null => {
	const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * The settings with one key changed to the value a control produced, or null
 * when the value is invalid and must not be saved. Numbers are clamped to the
 * range of section 8 (except fontSize, whose invalid input is rejected).
 */
export function applySetting(current: MapdownSettings, key: SettingKey, value: unknown): MapdownSettings | null {
	const next: MapdownSettings = { ...current };
	switch (key) {
		case 'headLevel': {
			const n = finite(value);
			if (n === null) return null;
			next.headLevel = Math.max(0, Math.min(6, Math.round(n)));
			return next;
		}
		case 'fontSize': {
			const n = typeof value === 'number' ? (value >= FONT_SIZE_MIN && value <= FONT_SIZE_MAX ? value : null) : typeof value === 'string' ? parseFontSize(value) : null;
			if (n === null) return null;
			next.fontSize = n;
			return next;
		}
		case 'canvasSize': {
			const n = finite(value);
			if (n === null || !(CANVAS_SIZES as readonly number[]).includes(n)) return null;
			next.canvasSize = n;
			return next;
		}
		case 'background':
			if (typeof value !== 'string') return null;
			next.background = value.trim() === '' ? DEFAULT_SETTINGS.background : value.trim();
			return next;
		case 'layoutDirect':
			if (!(DIRECTION_VALUES as readonly unknown[]).includes(value)) return null;
			next.layoutDirect = value as MapdownSettings['layoutDirect'];
			return next;
		case 'linkOpenMode':
			if (!(LINK_MODE_VALUES as readonly unknown[]).includes(value)) return null;
			next.linkOpenMode = value as MapdownSettings['linkOpenMode'];
			return next;
		case 'strokeArray':
			if (value === DEFAULT_PALETTE_KEY || value === undefined) {
				delete next.strokeArray;
				return next;
			}
			if (typeof value !== 'string' || !Object.hasOwn(PALETTES, value)) return null;
			next.strokeArray = [...PALETTES[value]];
			return next;
		case 'nodeGlowSize': {
			const n = finite(value);
			if (n === null) return null;
			next.nodeGlowSize = clampStep(n, 0, 24, 1);
			return next;
		}
		case 'nodeMaxWidth': {
			const n = finite(value);
			if (n === null) return null;
			next.nodeMaxWidth = clampStep(n, 240, 1200, 20);
			return next;
		}
		case 'focusGlowSize': {
			const n = finite(value);
			if (n === null) return null;
			next.focusGlowSize = clampStep(n, 0, 400, 10);
			return next;
		}
		case 'focusOverlayOpacity': {
			// The slider runs 0-80 in steps of 5; the stored value is that divided by 100.
			const n = finite(value);
			if (n === null) return null;
			next.focusOverlayOpacity = clampStep(n, 0, 80, 5) / 100;
			return next;
		}
		case 'focusOnMove':
		case 'enableLinkPreview':
		case 'syncSelection':
			if (typeof value !== 'boolean') return null;
			next[key] = value;
			return next;
	}
}

/** Which palette strokeArray is: 'default' when unset, a preset name, or null for custom colours. */
export function paletteKey(strokeArray: readonly string[] | undefined): string | null {
	if (strokeArray === undefined || strokeArray.length === 0) return DEFAULT_PALETTE_KEY;
	const same = (a: readonly string[]) => a.length === strokeArray.length && a.every((c, i) => c.toLowerCase() === strokeArray[i]?.toLowerCase());
	for (const [name, colours] of Object.entries(PALETTES)) if (same(colours)) return name;
	return null;
}

/** The value a control shows for a key (dropdown values are strings, the opacity slider is 0-80). */
export function controlValue(s: MapdownSettings, key: SettingKey): unknown {
	switch (key) {
		case 'headLevel':
		case 'canvasSize':
		case 'fontSize':
			return String(s[key]);
		case 'focusOverlayOpacity':
			return Math.round(s.focusOverlayOpacity * 100);
		case 'strokeArray':
			return paletteKey(s.strokeArray);
		default:
			return s[key];
	}
}
