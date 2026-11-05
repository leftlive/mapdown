import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, PALETTES } from "../../src/settings.ts";
import { applySetting, controlValue, paletteKey, parseFontSize } from "../../src/settingsModel.ts";

const S = { ...DEFAULT_SETTINGS };

test("fontSize: only numbers from 8 to 72 are accepted", () => {
	assert.equal(parseFontSize("16"), 16);
	assert.equal(parseFontSize(" 12.5 "), 12.5);
	for (const bad of ["", "abc", "7", "73", "-5", "1e1", "16px"]) assert.equal(parseFontSize(bad), null, bad);
	assert.equal(applySetting(S, "fontSize", "abc"), null);
	assert.equal(applySetting(S, "fontSize", "40")?.fontSize, 40);
});

test("sliders are clamped and snapped to their steps", () => {
	assert.equal(applySetting(S, "nodeMaxWidth", 5000)?.nodeMaxWidth, 1200);
	assert.equal(applySetting(S, "nodeMaxWidth", 505)?.nodeMaxWidth, 500);
	assert.equal(applySetting(S, "nodeGlowSize", -3)?.nodeGlowSize, 0);
	assert.equal(applySetting(S, "focusGlowSize", 155)?.focusGlowSize, 160);
});

test("focusOverlayOpacity: slider 0-80 in steps of 5 is stored divided by 100", () => {
	assert.equal(applySetting(S, "focusOverlayOpacity", 35)?.focusOverlayOpacity, 0.35);
	assert.equal(applySetting(S, "focusOverlayOpacity", 100)?.focusOverlayOpacity, 0.8);
	assert.equal(controlValue({ ...S, focusOverlayOpacity: 0.4 }, "focusOverlayOpacity"), 40);
});

test("dropdowns take strings and reject values outside the list", () => {
	assert.equal(applySetting(S, "headLevel", "3")?.headLevel, 3);
	assert.equal(applySetting(S, "headLevel", "9")?.headLevel, 6);
	assert.equal(applySetting(S, "canvasSize", "12000")?.canvasSize, 12000);
	assert.equal(applySetting(S, "canvasSize", "5000"), null);
	assert.equal(applySetting(S, "layoutDirect", "left")?.layoutDirect, "left");
	assert.equal(applySetting(S, "layoutDirect", "up"), null);
	assert.equal(applySetting(S, "linkOpenMode", "tab")?.linkOpenMode, "tab");
	assert.equal(applySetting(S, "linkOpenMode", "x"), null);
	assert.equal(controlValue(S, "canvasSize"), "8000");
});

test("toggles need booleans; empty background means transparent", () => {
	assert.equal(applySetting(S, "syncSelection", false)?.syncSelection, false);
	assert.equal(applySetting(S, "syncSelection", "no"), null);
	assert.equal(applySetting(S, "background", "  ")?.background, "transparent");
	assert.equal(applySetting(S, "background", "#fafafa")?.background, "#fafafa");
});

test("palette: a preset sets strokeArray, default removes it, custom colours match nothing", () => {
	const ocean = applySetting(S, "strokeArray", "Ocean");
	assert.ok(ocean);
	assert.deepEqual(ocean.strokeArray, [...PALETTES.Ocean]);
	assert.equal(paletteKey(ocean.strokeArray), "Ocean");
	const back = applySetting(ocean, "strokeArray", "default");
	assert.ok(back);
	assert.equal(back.strokeArray, undefined);
	assert.ok(back && !("strokeArray" in back));
	assert.equal(paletteKey(undefined), "default");
	assert.equal(paletteKey(["#E63946", "#F4A261", "#E9C46A", "#2A9D8F", "#264653"]), "Classic");
	assert.equal(paletteKey(["#123456"]), null);
	assert.equal(applySetting(S, "strokeArray", "toString"), null);
	assert.equal(S.strokeArray, undefined, "input is not mutated");
});
