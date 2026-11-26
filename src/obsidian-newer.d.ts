// Types for the Obsidian 1.13+ "setting definitions" API, which
// src/settingsTab.ts uses as progressive enhancement. The `obsidian` package
// is pinned to the minimum supported version (1.8.7), so these are not in its
// types. Copied and trimmed from obsidian 1.14.4 to what settingsTab.ts uses.
//
// Everything here is type-only. On Obsidian before 1.13 none of it exists at
// runtime, so the PluginSettingTab members are optional: code may call them
// only on a subclass that implements them itself.

import type { Setting } from 'obsidian';

declare module 'obsidian' {
	interface PluginSettingTab {
		/** @since 1.13.0 */
		getSettingDefinitions?(): SettingDefinitionItem[];
		/** @since 1.13.0 */
		getControlValue?(key: string): unknown;
		/** @since 1.13.0 */
		setControlValue?(key: string, value: unknown): void | Promise<void>;
	}

	/** @since 1.13.0 (trimmed: only the control types this plugin uses) */
	export type SettingControl<K extends string = string> =
		| SettingToggleControl<K>
		| SettingDropdownControl<K>
		| SettingTextControl<K>
		| SettingSliderControl<K>;

	export interface SettingControlBase<V, K extends string = string> {
		key: K;
		defaultValue?: V;
		validate?: (value: V) => string | void | Promise<string | void>;
		disabled?: boolean | (() => boolean);
	}

	export interface SettingToggleControl<K extends string = string> extends SettingControlBase<boolean, K> {
		type: 'toggle';
	}

	export interface SettingDropdownControl<K extends string = string> extends SettingControlBase<string, K> {
		type: 'dropdown';
		options: Record<string, string>;
	}

	export interface SettingTextControl<K extends string = string> extends SettingControlBase<string, K> {
		type: 'text';
		placeholder?: string;
	}

	export interface SettingSliderControl<K extends string = string> extends SettingControlBase<number, K> {
		type: 'slider';
		min: number;
		max: number;
		step: number;
		displayFormat?: (value: number) => string;
	}

	/** @since 1.13.0 (trimmed: no action rows) */
	export type SettingDefinition<K extends string = string> = SettingDefinitionControl<K> | SettingDefinitionRender | SettingDefinitionEmpty;

	export interface SettingDefinitionBase {
		name: string;
		desc?: string | DocumentFragment;
		aliases?: string[];
		searchable?: boolean | (() => boolean);
		visible?: boolean | (() => boolean);
	}

	export interface SettingDefinitionControl<K extends string = string> extends SettingDefinitionBase {
		control: SettingControl<K>;
		render?: never;
	}

	export interface SettingDefinitionRender extends SettingDefinitionBase {
		control?: never;
		render: (setting: Setting, group: SettingGroup) => void | (() => void);
	}

	export interface SettingDefinitionEmpty extends SettingDefinitionBase {
		control?: never;
		render?: never;
	}

	/** @since 1.13.0 (trimmed: groups hold settings only, no pages, search or buttons) */
	export interface SettingDefinitionGroup<K extends string = string> {
		type: 'group' | 'list';
		heading?: string;
		cls?: string;
		items?: SettingDefinition<K>[];
		visible?: boolean | (() => boolean);
	}

	/** @since 1.13.0 (trimmed: no pages) */
	export type SettingDefinitionItem<K extends string = string> = SettingDefinition<K> | SettingDefinitionGroup<K>;

	/**
	 * @since 1.13.0. Declared as an interface, not a class: it does not exist
	 * at runtime before 1.13, so it must never be constructed.
	 */
	export interface SettingGroup {
		listEl: HTMLElement;
		setHeading(text: string | DocumentFragment): this;
		addClass(...classes: string[]): this;
		addSetting(cb: (setting: Setting) => void): this;
	}
}
