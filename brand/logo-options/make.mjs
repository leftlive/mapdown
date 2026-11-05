// Generates the logo candidates: a colour tile and a monochrome glyph for each.
// Run: node brand/logo-options/make.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = dirname(fileURLToPath(import.meta.url));

// Obsidian dark ground and the branch colours seen in the plugin's maps.
const C = {
  bg: '#1e1e1e',
  ink: '#dcddde',
  dim: '#8a8a8a',
  lav: '#c9b3e6',
  pink: '#f2a6c2',
  blue: '#a8cdf0',
};

// Each concept returns SVG content for a 128 grid; `c` maps roles to colours.
const concepts = {
  page: {
    name: 'Page that branches',
    idea: 'A note page whose text lines grow out of its edge as map branches.',
    draw: (c) => {
      const lines = [
        [50, 34, c.lav],
        [64, 64, c.pink],
        [78, 94, c.blue],
      ];
      const curves = lines.map(([y, ty]) =>
        `M32 ${y} H58 C80 ${y} 80 ${ty} 96 ${ty}`);
      return `
  <path d="M22 30 a6 6 0 0 1 6 -6 H58 L70 36 V98 a6 6 0 0 1 -6 6 H28 a6 6 0 0 1 -6 -6 Z" fill="none" stroke="${c.ink}" stroke-width="5" stroke-linejoin="round"/>
  ${curves.map((d) => `<path d="${d}" fill="none" stroke="${c.gap}" stroke-width="13" stroke-linecap="round"/>`).join('')}
  ${lines.map(([, ty, col], i) => `<path d="${curves[i]}" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round"/>
  <circle cx="102" cy="${ty}" r="7" fill="${col}"/>`).join('')}`;
    },
  },
  mmap: {
    name: 'M as a map',
    idea: 'The letter M drawn as mind-map edges between five nodes.',
    draw: (c) => `
  <path d="M26 96 V34 C46 34 44 74 64 74" fill="none" stroke="${c.lav}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M64 74 C84 74 82 34 102 34 V96" fill="none" stroke="${c.pink}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="26" cy="96" r="7" fill="${c.lav}"/>
  <circle cx="102" cy="96" r="7" fill="${c.pink}"/>
  <rect x="52" y="65" width="24" height="18" rx="6" fill="${c.gap}" stroke="${c.ink}" stroke-width="5"/>`,
  },
  mark: {
    name: 'Markdown mark, branching',
    idea: 'The Markdown badge (M and down arrow); the arrow splits into branches.',
    draw: (c) => `
  <rect x="14" y="32" width="100" height="64" rx="11" fill="none" stroke="${c.ink}" stroke-width="5"/>
  <path d="M30 80 V48 L42 63 L54 48 V80" fill="none" stroke="${c.ink}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M84 44 V58" fill="none" stroke="${c.ink}" stroke-width="7" stroke-linecap="round"/>
  <path d="M84 58 C84 70 72 68 72 80" fill="none" stroke="${c.lav}" stroke-width="6" stroke-linecap="round"/>
  <path d="M84 58 V80" fill="none" stroke="${c.pink}" stroke-width="6" stroke-linecap="round"/>
  <path d="M84 58 C84 70 96 68 96 80" fill="none" stroke="${c.blue}" stroke-width="6" stroke-linecap="round"/>
  <circle cx="72" cy="81" r="5" fill="${c.lav}"/>
  <circle cx="84" cy="81" r="5" fill="${c.pink}"/>
  <circle cx="96" cy="81" r="5" fill="${c.blue}"/>`,
  },
  hash: {
    name: 'Heading that branches',
    idea: 'A Markdown # whose bars run on into map branches: headings are the map.',
    draw: (c) => `
  <path d="M48 26 L40 102 M74 26 L66 102" fill="none" stroke="${c.ink}" stroke-width="7" stroke-linecap="round"/>
  <path d="M22 52 H78 C92 52 90 36 104 36" fill="none" stroke="${c.lav}" stroke-width="7" stroke-linecap="round"/>
  <path d="M20 78 H76 C90 78 88 94 102 94" fill="none" stroke="${c.blue}" stroke-width="7" stroke-linecap="round"/>
  <circle cx="106" cy="36" r="7" fill="${c.lav}"/>
  <circle cx="104" cy="94" r="7" fill="${c.blue}"/>`,
  },
  mirror: {
    name: 'Two views of one note',
    idea: 'One root node: text lines on the left, map branches on the right.',
    draw: (c) => `
  <path d="M28 42 H46 M18 64 H46 M32 86 H46" fill="none" stroke="${c.dim}" stroke-width="6" stroke-linecap="round"/>
  <path d="M76 64 C92 64 88 40 104 40" fill="none" stroke="${c.lav}" stroke-width="6" stroke-linecap="round"/>
  <path d="M76 64 H104" fill="none" stroke="${c.pink}" stroke-width="6" stroke-linecap="round"/>
  <path d="M76 64 C92 64 88 88 104 88" fill="none" stroke="${c.blue}" stroke-width="6" stroke-linecap="round"/>
  <circle cx="106" cy="40" r="6" fill="${c.lav}"/>
  <circle cx="108" cy="64" r="6" fill="${c.pink}"/>
  <circle cx="106" cy="88" r="6" fill="${c.blue}"/>
  <rect x="50" y="54" width="26" height="20" rx="7" fill="${c.gap}" stroke="${c.ink}" stroke-width="5"/>`,
  },
};

const colour = { ...C, gap: C.bg };
const mono = { bg: 'none', ink: 'currentColor', dim: 'currentColor', lav: 'currentColor', pink: 'currentColor', blue: 'currentColor', gap: 'var(--gap, #fff)' };

const svg = (body, tile) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${tile ? `\n  <rect width="128" height="128" rx="28" fill="${C.bg}"/>` : ''}${body}\n</svg>\n`;

const ids = Object.keys(concepts);
for (const id of ids) {
  writeFileSync(join(out, `${id}.svg`), svg(concepts[id].draw(colour), true));
  writeFileSync(join(out, `${id}-mono.svg`), svg(concepts[id].draw(mono), false));
}

// Comparison sheet: tile at app-icon size, small sizes, mono glyph on light
// and dark, and a wordmark lockup.
const card = (id, i) => {
  const k = concepts[id];
  const tile = svg(k.draw(colour), true);
  const m = svg(k.draw(mono), false);
  return `<section>
  <h2><b>${String.fromCharCode(65 + i)}</b> ${k.name}</h2>
  <p>${k.idea}</p>
  <div class="row">
    <div class="big">${tile}</div>
    <div class="col">
      <div class="sizes">${[64, 32, 16].map((s) => `<span style="width:${s}px;height:${s}px">${tile}</span>`).join('')}</div>
      <div class="sizes light">${[48, 24].map((s) => `<span style="width:${s}px;height:${s}px">${m}</span>`).join('')}</div>
      <div class="sizes dark">${[48, 24].map((s) => `<span style="width:${s}px;height:${s}px">${m}</span>`).join('')}</div>
    </div>
  </div>
  <div class="lockup"><span class="lk">${tile}</span><span class="word">Map<i>down</i></span></div>
</section>`;
};

writeFileSync(join(out, 'sheet.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>Mapdown logo options</title>
<style>
  body { margin: 0; padding: 36px 48px; background: #161616; color: ${C.ink}; font-family: -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif; width: 1920px; box-sizing: border-box; }
  h1 { font-weight: 600; font-size: 34px; margin: 0 0 22px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 22px; }
  section { background: #222; border-radius: 20px; padding: 20px 26px; }
  h2 { font-size: 24px; font-weight: 600; margin: 0 0 6px; }
  h2 b { color: ${C.pink}; margin-right: 6px; }
  p { margin: 0 0 12px; color: #a0a0a0; font-size: 16px; line-height: 1.4; min-height: 44px; }
  .row { display: flex; gap: 26px; align-items: center; }
  .big { width: 180px; height: 180px; }
  .big svg, span svg { width: 100%; height: 100%; display: block; }
  .col { display: flex; flex-direction: column; gap: 14px; }
  .sizes { display: flex; gap: 14px; align-items: center; padding: 10px 14px; border-radius: 12px; }
  .light { background: #f4f4f2; color: #2b2b2b; --gap: #f4f4f2; }
  .dark { background: #111; color: #d0d0d0; --gap: #111; }
  .lockup { display: flex; align-items: center; gap: 16px; margin-top: 14px; }
  .lk { width: 56px; height: 56px; display: block; }
  .word { font-size: 40px; font-weight: 700; letter-spacing: -0.5px; }
  .word i { font-style: normal; font-weight: 400; color: #b8b8b8; }
</style></head><body>
<h1>Mapdown logo options</h1>
<div class="grid">
${ids.map(card).join('\n')}
</div>
</body></html>
`);
console.log('wrote', ids.length, 'concepts');
