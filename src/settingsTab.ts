// The settings tab (behaviour spec section 8, and 5.7 for the link preview
// hint). The tab is described once, as setting definitions. Obsidian 1.13+
// renders them itself and uses them for settings search. On older versions
// (the plugin supports 1.5.7) it never calls getSettingDefinitions(), so
// display() draws the same definitions with the classic Setting API.

import {
	PluginSettingTab,
	Setting,
	type App,
	type SettingControl,
	type SettingDefinition,
	type SettingDefinitionItem,
} from 'obsidian';
import { DEFAULT_PALETTE } from './core/layout.ts';
import { t, type StringKey } from './i18n.ts';
import type MapdownPlugin from './main.ts';
import { CANVAS_SIZES, PALETTES } from './settings.ts';
import {
	applySetting,
	controlValue,
	DEFAULT_PALETTE_KEY,
	DIRECTION_VALUES,
	LINK_MODE_VALUES,
	parseFontSize,
	paletteKey,
	type SettingKey,
} from './settingsModel.ts';

/** Whether the core "Page preview" plugin is on (not part of the public API, so read defensively). */
export function pagePreviewEnabled(app: App): boolean {
	const internal = (app as unknown as { internalPlugins?: { getPluginById?: (id: string) => { enabled?: boolean } | undefined } }).internalPlugins;
	return internal?.getPluginById?.('page-preview')?.enabled === true;
}

type Row = SettingDefinition<SettingKey>;

export class MapdownSettingTab extends PluginSettingTab {
	private readonly mapdown: MapdownPlugin;

	constructor(app: App, plugin: MapdownPlugin) {
		super(app, plugin);
		this.mapdown = plugin;
	}

	// ------------------------------------------------------------ shared storage

	override getControlValue(key: string): unknown {
		return controlValue(this.mapdown.settings, key as SettingKey);
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const next = applySetting(this.mapdown.settings, key as SettingKey, value);
		if (next === null) return; // invalid input is not saved
		this.mapdown.settings = next;
		await this.mapdown.saveSettings(); // applies to open maps immediately
	}

	// ------------------------------------------------------------ definitions

	private row(key: SettingKey, control: { type: string } & Record<string, unknown>): Row {
		return {
			name: t(`set-${key}` as StringKey),
			desc: t(`set-${key}-desc` as StringKey),
			control: { key, ...control } as SettingControl<SettingKey>,
		};
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		const nums = (values: readonly number[]): Record<string, string> => Object.fromEntries(values.map((v) => [String(v), String(v)]));
		const labelled = (prefix: string, values: readonly string[]): Record<string, string> =>
			Object.fromEntries(values.map((v) => [v, t(`set-${prefix}-${v}` as StringKey)]));
		const slider = (key: SettingKey, min: number, max: number, step: number, suffix = ''): Row =>
			this.row(key, { type: 'slider', min, max, step, displayFormat: (v: number) => `${v}${suffix}` });

		return [
			{
				type: 'group',
				heading: t('set-group-text'),
				items: [
					this.row('headLevel', { type: 'dropdown', options: nums([0, 1, 2, 3, 4, 5, 6]) }),
					this.row('fontSize', {
						type: 'text',
						placeholder: '16',
						validate: (v: string) => (parseFontSize(v) === null ? t('set-fontSize-invalid') : undefined),
					}),
					this.row('layoutDirect', { type: 'dropdown', options: labelled('dir', DIRECTION_VALUES) }),
					slider('nodeMaxWidth', 240, 1200, 20),
				],
			},
			{
				type: 'group',
				heading: t('set-group-appearance'),
				items: [
					this.row('canvasSize', { type: 'dropdown', options: nums(CANVAS_SIZES) }),
					this.row('background', {
						type: 'text',
						placeholder: 'transparent',
						validate: (v: string) => (v.trim() === '' || CSS.supports('color', v.trim()) ? undefined : t('set-background-desc')),
					}),
					{
						name: t('set-strokeArray'),
						desc: t('set-strokeArray-desc'),
						aliases: Object.keys(PALETTES),
						render: (setting) => this.renderPalette(setting),
					},
					slider('nodeGlowSize', 0, 24, 1),
				],
			},
			{
				type: 'group',
				heading: t('set-group-focus'),
				items: [
					this.row('focusOnMove', { type: 'toggle' }),
					slider('focusOverlayOpacity', 0, 80, 5, '%'),
					slider('focusGlowSize', 0, 400, 10),
				],
			},
			{
				type: 'group',
				heading: t('set-group-links'),
				items: [
					this.row('enableLinkPreview', { type: 'toggle' }),
					{
						name: t('set-page-preview-off'),
						searchable: false,
						visible: () => !pagePreviewEnabled(this.app),
						render: (setting) => {
							setting.settingEl.addClass('mapdown-setting-hint');
							setting.setName(t('set-page-preview-off'));
						},
					},
					this.row('linkOpenMode', { type: 'dropdown', options: labelled('link', LINK_MODE_VALUES) }),
					this.row('syncSelection', { type: 'toggle' }),
				],
			},
		];
	}

	// ------------------------------------------------------------ palette

	private renderPalette(setting: Setting): void {
		const box = setting.controlEl.createDiv({ cls: 'mapdown-palettes' });
		const options: [string, string, readonly string[]][] = [
			[DEFAULT_PALETTE_KEY, t('set-palette-default'), DEFAULT_PALETTE],
			...Object.entries(PALETTES).map(([name, colours]): [string, string, readonly string[]] => [name, name, colours]),
		];
		const buttons: [string, HTMLButtonElement][] = [];
		const mark = (): void => {
			const now = paletteKey(this.mapdown.settings.strokeArray);
			for (const [key, el] of buttons) {
				el.toggleClass('is-selected', key === now);
				el.setAttribute('aria-pressed', String(key === now));
			}
		};
		for (const [key, label, colours] of options) {
			const btn = box.createEl('button', { cls: 'mapdown-palette', attr: { type: 'button', 'aria-label': label, title: label } });
			const strip = btn.createDiv({ cls: 'mapdown-palette-strip' });
			for (const c of colours) strip.createSpan({ cls: 'mapdown-swatch' }).setCssProps({ '--mapdown-swatch': c });
			btn.createSpan({ cls: 'mapdown-palette-name', text: label });
			btn.addEventListener('click', () => {
				void this.setControlValue('strokeArray', key).then(mark);
			});
			buttons.push([key, btn]);
		}
		mark();
	}

	// ------------------------------------------------------------ fallback for Obsidian before 1.13

	override display(): void {
		const el = this.containerEl;
		el.empty();
		for (const item of this.getSettingDefinitions()) this.drawItem(el, item);
	}

	private drawItem(parent: HTMLElement, item: SettingDefinitionItem): void {
		if ('type' in item && (item.type === 'group' || item.type === 'list')) {
			if (item.heading) new Setting(parent).setName(item.heading).setHeading();
			for (const child of item.items ?? []) this.drawItem(parent, child);
			return;
		}
		const def = item as SettingDefinition<SettingKey>;
		const visible = typeof def.visible === 'function' ? def.visible() : def.visible;
		if (visible === false) return;
		const setting = new Setting(parent).setName(def.name);
		if (typeof def.desc === 'string') setting.setDesc(def.desc);
		if (def.render) {
			def.render(setting, undefined as never);
			return;
		}
		const c = def.control;
		if (!c) return;
		const current = this.getControlValue(c.key);
		const save = (v: unknown): void => void this.setControlValue(c.key, v);
		switch (c.type) {
			case 'dropdown':
				setting.addDropdown((d) => d.addOptions(c.options).setValue(String(current)).onChange(save));
				break;
			case 'toggle':
				setting.addToggle((tg) => tg.setValue(current === true).onChange(save));
				break;
			case 'slider':
				setting.addSlider((s) => s.setLimits(c.min, c.max, c.step).setValue(Number(current)).onChange(save));
				break;
			case 'text':
				setting.addText((x) => {
					x.setValue(String(current));
					if (c.placeholder) x.setPlaceholder(c.placeholder);
					x.onChange((v) => {
						const error = c.validate?.(v);
						x.inputEl.toggleClass('mapdown-invalid', typeof error === 'string' && error !== '');
						if (!error) save(v);
					});
				});
				break;
			default:
				break;
		}
	}
}
