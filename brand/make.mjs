// Generates the Mapdown logo files (concept E, "two views of one note").
// Run: node brand/make.mjs   (PNG exports need rsvg-convert)
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = dirname(fileURLToPath(import.meta.url));

// Obsidian dark ground and the branch colours seen in the plugin's maps.
const C = {
  bg: '#1e1e1e',
  ink: '#dcddde',
  text: '#8f8f8f',
  lav: '#c9b3e6',
  pink: '#f2a6c2',
  blue: '#a8cdf0',
};

// The mark on a 128 grid: text lines flow into one root node, branches leave it.
const mark = (w = 7) => `
  <path d="M30 44 H40 M16 64 H40 M24 84 H40" fill="none" stroke="${C.text}" stroke-width="${w}" stroke-linecap="round"/>
  <path d="M78 64 C94 64 88 38 104 38" fill="none" stroke="${C.lav}" stroke-width="${w}" stroke-linecap="round"/>
  <path d="M78 64 H104" fill="none" stroke="${C.pink}" stroke-width="${w}" stroke-linecap="round"/>
  <path d="M78 64 C94 64 88 90 104 90" fill="none" stroke="${C.blue}" stroke-width="${w}" stroke-linecap="round"/>
  <circle cx="106" cy="38" r="${w + 1}" fill="${C.lav}"/>
  <circle cx="108" cy="64" r="${w + 1}" fill="${C.pink}"/>
  <circle cx="106" cy="90" r="${w + 1}" fill="${C.blue}"/>
  <rect x="50" y="53" width="28" height="22" rx="8" fill="${C.bg}" stroke="${C.ink}" stroke-width="${w - 1}"/>`;

const icon = (w) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="${C.bg}"/>${mark(w)}
</svg>
`;

// Monochrome glyph in the 24 px, 2 px-stroke style of Obsidian's own icons.
const glyph = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4.5 7.5H6M2 12H6M3 16.5H6"/>
  <rect x="8.5" y="9.5" width="6" height="5" rx="1.5"/>
  <path d="M14.5 12C17.5 12 16.5 7 19.5 7"/>
  <path d="M14.5 12H19.5"/>
  <path d="M14.5 12C17.5 12 16.5 17 19.5 17"/>
  <circle cx="21" cy="7" r="1" fill="currentColor"/>
  <circle cx="21" cy="12" r="1" fill="currentColor"/>
  <circle cx="21" cy="17" r="1" fill="currentColor"/>
</svg>
`;

// Lockup for README headers and the film's end card (wordmark uses the system font).
const lockup = (fg, sub) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 128">
  <g>${icon(7).replace(/<\/?svg[^>]*>/g, '')}</g>
  <text x="152" y="84" font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif" font-size="68" font-weight="700" letter-spacing="-1" fill="${fg}">Map<tspan font-weight="400" fill="${sub}">down</tspan></text>
</svg>
`;

const files = {
  'mapdown-icon.svg': icon(7),
  'mapdown-icon-small.svg': icon(9),
  'mapdown-glyph.svg': glyph,
  'mapdown-logo-dark.svg': lockup(C.ink, '#a8a8a8'),
  'mapdown-logo-light.svg': lockup('#1e1e1e', '#6b6b6b'),
};
for (const [name, body] of Object.entries(files)) writeFileSync(join(out, name), body);

// App-icon PNGs; the heavier small variant is used at 64 px and below.
for (const s of [1024, 512, 256, 128]) {
  execFileSync('rsvg-convert', ['-w', s, '-h', s, '-o', join(out, `mapdown-icon-${s}.png`), join(out, 'mapdown-icon.svg')]);
}
for (const s of [64, 32]) {
  execFileSync('rsvg-convert', ['-w', s, '-h', s, '-o', join(out, `mapdown-icon-${s}.png`), join(out, 'mapdown-icon-small.svg')]);
}

// Review sheet.
writeFileSync(join(out, 'sheet.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>Mapdown logo</title>
<style>
  body { margin: 0; padding: 48px 64px; width: 1920px; height: 1080px; box-sizing: border-box; background: #161616; color: ${C.ink}; font-family: -apple-system, sans-serif; }
  h1 { font-size: 30px; font-weight: 600; margin: 0 0 36px; }
  .row { display: flex; gap: 40px; align-items: flex-end; margin-bottom: 44px; }
  .row img { display: block; }
  figure { margin: 0; text-align: center; }
  figcaption { font-size: 14px; color: #8a8a8a; margin-top: 10px; }
  .pad { padding: 18px 22px; border-radius: 14px; display: flex; gap: 22px; align-items: center; }
  .light { background: #f4f4f2; color: #2b2b2b; }
  .dark { background: #0e0e0e; color: #d0d0d0; }
  .pad svg { display: block; }
</style></head><body>
<h1>Mapdown logo — concept E, refined</h1>
<div class="row">
  <figure><img src="mapdown-icon.svg" width="300" height="300"><figcaption>App icon</figcaption></figure>
  <figure><img src="mapdown-icon-128.png" width="128"><figcaption>128</figcaption></figure>
  <figure><img src="mapdown-icon-64.png" width="64"><figcaption>64</figcaption></figure>
  <figure><img src="mapdown-icon-32.png" width="32"><figcaption>32</figcaption></figure>
  <figure><img src="mapdown-icon-small.svg" width="16"><figcaption>16</figcaption></figure>
  <figure><div class="pad light">${[48, 24, 16].map((s) => glyph.replace('<svg ', `<svg width="${s}" height="${s}" `)).join('')}</div><figcaption>Obsidian glyph, light</figcaption></figure>
  <figure><div class="pad dark">${[48, 24, 16].map((s) => glyph.replace('<svg ', `<svg width="${s}" height="${s}" `)).join('')}</div><figcaption>Obsidian glyph, dark</figcaption></figure>
</div>
<div class="row">
  <figure><div class="pad dark" style="padding:28px 36px"><img src="mapdown-logo-dark.svg" height="96"></div><figcaption>Lockup on dark</figcaption></figure>
  <figure><div class="pad light" style="padding:28px 36px"><img src="mapdown-logo-light.svg" height="96"></div><figcaption>Lockup on light</figcaption></figure>
</div>
</body></html>
`);
console.log('wrote', Object.keys(files).length, 'SVGs and 6 PNGs');
