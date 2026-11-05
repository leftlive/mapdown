#!/usr/bin/env node
// Runtime interaction tests for Mapdown 1.0 against a running Obsidian,
// driven through its CLI. Clean-room rewrite of the 0.3.0 harness: scenarios
// are black-box (DOM, keys, mouse, file contents). The only internals used are
// the ones in src/view/contract.ts (DOM class names) and the read-only
// `plugin.testApi` (src/testApi.ts), plus the documented command ids and
// `plugin.newMindMap(folder)`.
//
// Usage:
//   npm run e2e                       build, deploy, reload, run phase 1-2 scenarios
//   npm run e2e -- --no-deploy        test the plugin already loaded in Obsidian
//   npm run e2e -- --only smoke,new-map
//   npm run e2e -- --phase 3          also run scenarios of phase 3 (and below)
//   npm run e2e -- --slow             also run slow release checks
//
// Run it only when the computer is idle and the Obsidian window can stay in
// front. Every scenario works on temporary notes named __mapdown_e2e_* in
// 00-INBOX, which are removed at the end even when a scenario fails.

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VAULT = process.env.MAPDOWN_VAULT ||
  '/Users/ian/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian';
const PLUGIN_DIR = path.join(VAULT, '.obsidian/plugins/mapdown');
const INBOX = '00-INBOX';
const PREFIX = '__mapdown_e2e_';
const VIEW_TYPE = 'mindmapViewUpgraded';
const MOD = process.platform === 'darwin' ? 4 : 2; // CDP modifier for Cmd/Ctrl
const META = MOD; // name used by the phase 3-5 scenarios
const ALT = 1;
const SHIFT = 8;

const args = process.argv.slice(2);
const deploy = !args.includes('--no-deploy');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1].split(',') : null;
const phaseIndex = args.indexOf('--phase');
const maxPhase = phaseIndex >= 0 ? Number(args[phaseIndex + 1]) : 2;
const includeSlow = args.includes('--slow');

// ---------------------------------------------------------------------------
// Obsidian CLI wrappers

function cli(cliArgs, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile('obsidian', cliArgs, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`obsidian ${cliArgs[0]} failed: ${err.killed ? 'timeout' : err.message}\n${stderr}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// Helpers available as `H` inside every evaluated snippet. They read only the
// DOM (class names from src/view/contract.ts) and plugin.testApi.
const PAGE_HELPERS = `
const VT = ${JSON.stringify(VIEW_TYPE)};
const H = {
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  frames: async (n = 2) => { for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r)); },
  // Poll instead of sleeping a fixed time; returns false on timeout.
  async until(cond, timeoutMs = 5000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try { if (cond()) return true; } catch (e) {}
      await H.wait(50);
    }
    return false;
  },
  api: () => app.plugins.plugins.mapdown.testApi,
  file: (p) => app.vault.getAbstractFileByPath(p),
  // The visible map view: the active leaf's, else the first one on screen.
  root() {
    const v = app.workspace.activeLeaf && app.workspace.activeLeaf.view;
    if (v && v.getViewType() === VT) return v.contentEl;
    return Array.from(document.querySelectorAll('.mapdown-view')).find((e) => e.offsetParent) || null;
  },
  canvas: () => H.root().querySelector('.mapdown-canvas'),
  visible: () => H.api().visibleNodes(),
  texts: () => H.api().visibleNodes().map((n) => n.text),
  ids: (text) => H.api().visibleNodes().filter((n) => n.text === text).map((n) => n.id),
  el(text, index = 0) {
    const id = H.ids(text)[index];
    const r = H.root();
    return id && r ? r.querySelector('.mapdown-node[data-node-id="' + id + '"]') : null;
  },
  rect(text, index = 0) {
    const e = H.el(text, index);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height,
      x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  },
  selTexts() {
    const by = new Map(H.api().visibleNodes().map((n) => [n.id, n.text]));
    return H.api().selection().map((id) => by.get(id));
  },
  collapsed(text, index = 0) { const e = H.el(text, index); return !!e && e.classList.contains('is-collapsed'); },
  // True when the node is rendered and inside the map area (below the toolbar).
  inView(text, index = 0) {
    const r = H.rect(text, index);
    if (!r) return false;
    const c = H.root().getBoundingClientRect();
    if (!(r.top >= c.top && r.bottom <= c.bottom && r.left >= c.left && r.right <= c.right)) return false;
    // A node under a toolbar group (bottom right) is not usable.
    const hit = (b) => r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top;
    return !Array.from(H.root().querySelectorAll('.mapdown-toolbar-group')).some((g) => hit(g.getBoundingClientRect()));
  },
  isEmptyPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    return !!el && H.root().contains(el) && !el.closest('.mapdown-node') && !el.closest('.mapdown-toolbar');
  },
  emptyPoint() {
    const c = H.root().getBoundingClientRect();
    for (const fy of [0.85, 0.7, 0.5, 0.3, 0.2]) {
      for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const x = Math.round(c.left + c.width * fx), y = Math.round(c.top + c.height * fy);
        if (H.isEmptyPoint(x, y)) return { x, y };
      }
    }
    return null;
  },
  // Centre of the smallest element whose own text is exactly \`str\` (menus).
  // data-action of each visible item of the node menu.
  menuItems() {
    const m = (H.root() || document).querySelector('.mapdown-node-menu');
    if (!m || m.offsetParent === null) return [];
    return Array.from(m.querySelectorAll('[data-action]')).filter((e) => e.offsetParent !== null).map((e) => e.getAttribute('data-action'));
  },
  textRect(str) {
    const hits = Array.from(document.body.querySelectorAll('*'))
      .filter((e) => e.children.length === 0 && e.textContent.trim() === str && e.offsetParent !== null);
    if (!hits.length) return null;
    const b = hits[0].getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  },
  selectEditorText() {
    const e = H.root().querySelector('.mapdown-node-editor');
    e.focus();
    const range = document.createRange();
    range.selectNodeContents(e);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
  },
  editorText: () => { const e = H.root().querySelector('.mapdown-node-editor'); return e ? e.innerText : null; },
  // Notes are written from outside Obsidian; wait until the vault has indexed
  // the frontmatter, otherwise the file opens as plain Markdown.
  async indexed(p) {
    for (let i = 0; i < 50; i++) {
      const f = H.file(p);
      if (f && app.metadataCache.getFileCache(f)?.frontmatter?.['mindmap-plugin']) return f;
      await H.wait(100);
    }
    throw new Error('not indexed: ' + p);
  },
  async open(p) {
    await H.indexed(p);
    const leaf = app.workspace.getLeaf('tab');
    await leaf.openFile(H.file(p));
    app.workspace.setActiveLeaf(leaf, { focus: true });
    const ok = await H.until(() => {
      const r = H.root();
      return leaf.view.getViewType() === VT && r && r.querySelector('.mapdown-node');
    }, 8000);
    if (!ok) throw new Error('map did not render: ' + p);
    // Let the deferred focus and first layouts settle.
    await H.wait(300);
    await H.frames(2);
    return leaf;
  },
};
`;


async function evalWith(helpers, body, timeoutMs = 30000) {
  const code = `(async()=>{${helpers}\nconst __r = await (async()=>{${body}})();return JSON.stringify(__r === undefined ? null : __r);})()`;
  const out = await cli(['eval', `code=${code}`], timeoutMs);
  const line = out.split('\n').find((l) => l.startsWith('=> ') || l.startsWith('Error'));
  if (!line || line.startsWith('Error')) {
    throw new Error(`eval failed: ${out}`);
  }
  const value = line.slice(3);
  return value === 'null' || value === 'undefined' ? null : JSON.parse(value);
}

const evalJs = (body, timeoutMs) => evalWith(PAGE_HELPERS, body, timeoutMs);

async function cdp(method, params) {
  await cli(['dev:cdp', `method=${method}`, `params=${JSON.stringify(params)}`]);
}

async function cdpResult(method, params = {}) {
  return JSON.parse(await cli(['dev:cdp', `method=${method}`, `params=${JSON.stringify(params)}`]));
}

// Event listeners on the window, document and body, by type.
async function globalListeners() {
  const counts = {};
  for (const expression of ['window', 'document', 'document.body']) {
    const { result } = await cdpResult('Runtime.evaluate', { expression, objectGroup: 'mmE2e' });
    const { listeners } = await cdpResult('DOMDebugger.getEventListeners', { objectId: result.objectId });
    for (const l of listeners) {
      const key = `${expression}:${l.type}`;
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  await cdpResult('Runtime.releaseObjectGroup', { objectGroup: 'mmE2e' });
  return counts;
}

// ---------------------------------------------------------------------------
// Input

const KEYS = {
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Enter: 13, Escape: 27, Tab: 9, Delete: 46, Backspace: 8, Space: 32,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45,
  Equal: 187, Minus: 189,
  KeyF: 70, KeyZ: 90, KeyY: 89, KeyA: 65,
};

function keyInfo(code, modifiers) {
  let key = code;
  let vk = KEYS[code];
  const letter = /^Key([A-Z])$/.exec(code);
  const digit = /^Digit(\d)$/.exec(code);
  if (letter) {
    key = modifiers & SHIFT ? letter[1] : letter[1].toLowerCase();
    vk = letter[1].charCodeAt(0);
  } else if (digit) {
    key = digit[1];
    vk = 48 + Number(digit[1]);
  } else if (code === 'Space') {
    key = ' ';
  } else if (code === 'Equal') {
    key = '=';
  } else if (code === 'Minus') {
    key = '-';
  }
  return { key, code, windowsVirtualKeyCode: vk, modifiers };
}

async function press(code, modifiers = 0) {
  await ensureForeground();
  const base = keyInfo(code, modifiers);
  await cdp('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
  await cdp('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  // Focus tracking settles after 100 ms; layouts run in the next frames.
  await evalJs('await H.wait(150); await H.frames(2);');
}

async function typeText(text) {
  await cdp('Input.insertText', { text });
  await sleep(300);
}

async function mouse(type, x, y, extra = {}) {
  const button = extra.button || 'left';
  const buttons = type === 'mouseReleased' ? 0 : { left: 1, right: 2, middle: 4 }[button];
  await cdp('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: 1, ...extra });
}

async function wheel(x, y, deltaY, modifiers = 0) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers });
  await sleep(300);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll a condition from the runner side; returns false on timeout.
async function waitFor(check, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (await check()) return true; } catch (e) {}
    await sleep(100);
  }
  return false;
}

// Animation frames pause while the window is hidden, which stalls layout.
async function ensureForeground() {
  for (let attempt = 0; attempt < 5; attempt++) {
    // Hidden windows pause animation frames; unfocused windows report no focus.
    const state = await evalJs('return { hidden: document.hidden, focused: document.hasFocus() };');
    if ((!state.hidden && state.focused) || process.platform !== 'darwin') {
      return;
    }
    execFileSync('open', ['-a', 'Obsidian']);
    // With several Obsidian windows open, activating the app may focus another one.
    await evalJs(`require('electron').remote?.getCurrentWindow?.().focus();`).catch(() => {});
    await sleep(1000);
  }
  throw new Error('Obsidian window stays hidden or unfocused; keep it in front while e2e runs');
}

// ---------------------------------------------------------------------------
// Scenario building blocks (all black-box; see the header comment)

const open = (p) => evalJs(`await H.open('${p}');`);
const texts = () => evalJs('return H.texts();');
const selection = () => evalJs('return H.selTexts();');
const history = () => evalJs('return H.api().historySize();');
const flush = async () => { await evalJs('await H.api().flush();'); await sleep(300); };
const isEditing = () => evalJs('return H.api().isEditing();');
const waitEditing = async (on = true) => {
  const ok = await waitFor(async () => (await isEditing()) === on, 4000);
  expect(ok, on ? 'a node enters edit mode' : 'edit mode ends');
};

async function rectOf(text, index = 0) {
  const r = await evalJs(`return H.rect(${JSON.stringify(text)}, ${index});`);
  expect(r, `node "${text}" is rendered`);
  return r;
}

// Mouse click on a node's centre; `clickCount` 2 sends a real double click.
// A node outside the pane (under a sidebar, say) cannot be clicked or dragged: fit the map first.
async function ensureHittable(textsToHit, index = 0) {
  const ok = await evalJs(`return ${JSON.stringify(textsToHit)}.every((t) => {
    const r = H.rect(t, ${index}); const e = r && document.elementFromPoint(r.x, r.y);
    return !!e && !!H.el(t, ${index})?.contains(e); });`);
  if (!ok) await evalJs(`H.root().querySelector('.mapdown-toolbar [data-action="fit"]')?.click(); await H.wait(400);`);
}

async function clickNode(text, { button = 'left', clickCount = 1, modifiers = 0, index = 0 } = {}) {
  await ensureHittable([text], index);
  const r = await rectOf(text, index);
  await mouse('mouseMoved', r.x, r.y);
  for (let n = 1; n <= clickCount; n++) {
    await mouse('mousePressed', r.x, r.y, { button, clickCount: n, modifiers });
    await mouse('mouseReleased', r.x, r.y, { button, clickCount: n, modifiers });
  }
  await sleep(350);
}

// Select a node with the mouse, then edit it: Space, replace all text, Enter.
async function editText(text, newText, index = 0) {
  await clickNode(text, { index });
  await press('Space');
  await waitEditing(true);
  await evalJs('H.selectEditorText();');
  await typeText(newText);
  await press('Enter');
  await waitEditing(false);
}

// Presses Mod+Z until the undo stack is `base` deep (steps may be split finer
// than the test assumes); fails if it never gets there.
async function undoTo(base, max = 8) {
  for (let i = 0; i < max; i++) {
    if ((await history()).undo <= base) return;
    await press('KeyZ', MOD);
  }
  expect((await history()).undo <= base, `undo reaches history depth ${base}`, await history());
}

async function redoAll(max = 8) {
  for (let i = 0; i < max && (await history()).redo > 0; i++) {
    await press('KeyY', MOD);
  }
  expect((await history()).redo === 0, 'redo stack is empty after redoing everything', await history());
}

// Which arrow key leads away from the root for this node (it sits on the right
// or left of the root, depending on the layout).
async function outwardKey(text) {
  const r = await evalJs(`const a = H.rect(${JSON.stringify(text)}); const b = H.rect(H.visible()[0].text);
    return { right: a.x > b.x };`);
  return r.right ? 'ArrowRight' : 'ArrowLeft';
}

// Node list of a note body as {depth, text}: headings by level, list items by
// indentation under the last heading. Block ids are stripped.
function outline(md) {
  const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const lines = body.split(/\r?\n/);
  const indents = lines
    .map((l) => /^(\s+)(?:[-*+]|\d+\.)\s/.exec(l))
    .filter(Boolean)
    .map((m) => m[1].replace(/\t/g, '    ').length);
  const unit = indents.length ? Math.min(...indents) : 4;
  const out = [];
  let head = -1;
  for (const line of lines) {
    let m = /^(#{1,6})\s+(.*?)(?:\s+\^[\w-]+)?\s*$/.exec(line);
    if (m) {
      head = m[1].length - 1;
      out.push({ depth: head, text: m[2] });
      continue;
    }
    m = /^(\s*)(?:[-*+]|\d+\.)\s+(.*?)(?:\s+\^[\w-]+)?\s*$/.exec(line);
    if (m) {
      const indent = m[1].replace(/\t/g, '    ').length;
      out.push({ depth: head + 1 + Math.round(indent / unit), text: m[2] });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Temporary notes

function notePath(name) {
  return `${INBOX}/${PREFIX}${name}.md`;
}

// `state` null omits mindmark-state altogether.
function writeNote(name, body, state = '{"version":2,"collapsed":[]}') {
  const header = state === null
    ? '---\nmindmap-plugin: basic\n---\n\n'
    : `---\nmindmap-plugin: basic\nmindmark-state: ${state}\n---\n\n`;
  fs.writeFileSync(path.join(VAULT, notePath(name)), header + body);
  return notePath(name);
}

function readNote(relPath) {
  return fs.readFileSync(path.join(VAULT, relPath), 'utf8');
}

// Files a scenario created under a name without the prefix (new-map).
const trackedPaths = new Set();

// Safety net for cleanup: every file in the vault when the run started is the
// user's and is never deleted, whatever a scenario tracked (Obsidian's file
// list can gain old files mid-run, e.g. while iCloud syncs).
const RUN_START = Date.now();
let preexisting = null;
function walkVault() {
  const out = new Set();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(path.join(VAULT, dir), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (dir === '' && (e.name === '.obsidian' || e.name === '.trash' || e.name === '.git')) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else out.add(rel);
    }
  };
  walk('');
  return out;
}
function safeToDelete(rel) {
  if (!preexisting) return false;
  const full = path.join(VAULT, rel);
  let st;
  try { st = fs.statSync(full); } catch { return false; }
  if (path.basename(rel).includes(PREFIX)) return true; // test-named files and folders are ours
  if (st.isDirectory()) return false;
  if (preexisting.has(rel)) return false;
  return st.birthtimeMs >= RUN_START - 2000;
}

function listTempFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(VAULT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.name.includes(PREFIX)) {
        found.push(rel);
      } else if (entry.isDirectory() && rel.startsWith(INBOX)) {
        walk(rel);
      }
    }
  };
  walk(INBOX);
  return found;
}

// Backup, conflict and recovery copies are Mapdown's data-safety fallbacks;
// a scenario that produces one has hit an unexpected save path.
function safetyCopies() {
  return listTempFiles().filter((rel) => / Mapdown (backup|conflict|recovered) /.test(rel));
}

async function vaultPaths() {
  return evalJs('return app.vault.getFiles().map((f) => f.path);');
}

async function cleanup() {
  try {
    await evalJs(`
      const tracked = ${JSON.stringify([...trackedPaths])};
      const mine = (l) => { const p = l.view.file?.path || ''; return p.includes('${PREFIX}') || tracked.includes(p); };
      for (const type of ['markdown', '${VIEW_TYPE}']) {
        app.workspace.getLeavesOfType(type).filter(mine).forEach((l) => l.detach());
      }
    `);
  } catch (err) {
    console.warn('cleanup: could not detach leaves:', err.message);
  }
  await sleep(500);
  // Delete files before folders so nested temp folders can be removed.
  const paths = [...listTempFiles(), ...trackedPaths].sort((a, b) => b.length - a.length);
  for (const rel of paths) {
    if (!safeToDelete(rel)) {
      if (fs.existsSync(path.join(VAULT, rel))) console.warn(`cleanup: kept ${rel} (it was in the vault before this run)`);
      continue;
    }
    fs.rmSync(path.join(VAULT, rel), { recursive: true, force: true });
  }
  trackedPaths.clear();
}

// ---------------------------------------------------------------------------
// Assertions

class AssertionFailure extends Error {}

function expect(condition, message, detail) {
  if (!condition) {
    throw new AssertionFailure(`${message}${detail === undefined ? '' : `\n      got: ${JSON.stringify(detail)}`}`);
  }
}

// Something worth a look that is not a failure.
function note(message) {
  console.log(`      note: ${message}`);
}

// ---------------------------------------------------------------------------
// Scenario registry

// Scenarios not in phase 2. Anything not listed here is phase 2.
const LATER_PHASE = {
  'sync-map-to-text': 3, 'sync-map-click': 3, 'sync-map-to-text-modes': 3, 'sync-text-to-map': 3,
  'sync-typing-keeps-selection': 3, 'sync-no-ping-pong': 3, 'sync-focus-and-toggle': 3,
  'split-typing-keeps-focus': 3, 'split-type-then-map-edit': 3, 'source-lines': 3, 'patch-in-place': 3,
  'ime-composition': 3, 'multi-select': 3, 'multi-select-move': 3, 'undo-delete-shortcut': 3,
  'undo-every-destructive-op': 3, 'paste-outline-as-subtree': 3, 'collapse-dot': 3, 'focus-keeps-side': 3,
  'search-layout': 3, 'focus-delete': 3, 'popout-window': 3,
  'large-map-virtualized': 3, 'size-estimate-settles': 3,
  'plain-note-convert': 4, 'xmind-import-drop': 4, 'xmind-import-command': 4, 'xmind-export': 4,
  'export-commits-edit': 4, 'export-missing-and-close': 4, 'node-image': 4,
  'perf-benchmark': 5, 'leak-loop': 5, 'compat-roundtrip': 5,
};

const scenarios = [];
// Slow scenarios run only with --slow or when named in --only. Scenarios may
// allow Mapdown's backup/conflict copies when the test provokes them.
function scenario(name, run, options = {}) {
  scenarios.push({
    name, run,
    phase: LATER_PHASE[name] || 2,
    slow: Boolean(options.slow),
    allowCopies: Boolean(options.allowCopies),
  });
}

// ---------------------------------------------------------------------------
// Phase 2 scenarios

scenario('smoke', async () => {
  const p = writeNote('smoke', '# Root\n\n## A\n\n### A1\n\n## B\n');
  const r = await evalJs(`
    const leaf = await H.open('${p}');
    const root = H.root();
    return {
      type: leaf.view.getViewType(),
      view: root.classList.contains('mapdown-view'),
      canvas: !!root.querySelector('.mapdown-canvas'),
      nodes: root.querySelectorAll('.mapdown-node').length,
      visible: H.texts(),
      paths: root.querySelectorAll('.mapdown-edges path').length,
      roles: Array.from(root.querySelectorAll('.mapdown-node')).every((n) => n.getAttribute('role') === 'treeitem' && n.getAttribute('data-node-id')),
      toolbar: ['undo', 'redo', 'zoom-in', 'zoom-out', 'fit', 'new-map', 'search', 'export']
        .filter((a) => !root.querySelector('.mapdown-toolbar [data-action="' + a + '"]')),
    };
  `);
  expect(r.type === VIEW_TYPE && r.view && r.canvas, 'opens in the mind map view with a canvas', r);
  expect(r.nodes === 4 && JSON.stringify(r.visible) === JSON.stringify(['Root', 'A', 'A1', 'B']), 'renders every node, depth first', r);
  expect(r.roles, 'every node is a treeitem with a node id', r);
  expect(r.paths === 3, 'draws one edge per child', r);
  expect(r.toolbar.length === 0, 'toolbar has every action button', r.toolbar);
});

scenario('open-keyboard', async () => {
  const p = writeNote('openkb', '# Root\n\n## A\n');
  // No click or selection: shortcuts must work right after opening.
  await open(p);
  await sleep(300);
  await press('Tab');
  await waitEditing(true);
  const r = await texts();
  expect(r.length === 3, 'Tab adds a child right after opening the map', r);
  await press('Escape');
  await waitEditing(false);
});

scenario('arrow-history', async () => {
  const p = writeNote('arrow', '# Root\n\n## A\n\n### A1\n\n## B\n');
  await open(p);
  await clickNode('A');
  const base = (await history()).undo;
  const out = await outwardKey('A');
  await press(out);
  await press(out);
  let sel = await selection();
  expect(sel.length === 1 && sel[0] === 'A1' && (await history()).undo === base,
    'arrow keys on expanded nodes and leaves add no history', { sel, history: await history() });

  // Collapse A (one undoable step), select it again and arrow outwards.
  await clickNode('A');
  await press('Space', MOD | SHIFT);
  expect(await evalJs(`return H.collapsed('A');`), 'Mod+Shift+Space collapses the selected node');
  const collapsedAt = (await history()).undo;
  expect(collapsedAt === base + 1, 'collapsing is one undo step', await history());
  await press(out);
  sel = await selection();
  const r = await evalJs(`return { collapsed: H.collapsed('A'), texts: H.texts() };`);
  expect(!r.collapsed && sel[0] === 'A1' && (await history()).undo === collapsedAt + 1,
    'arrow on a collapsed node expands it once and selects the first child', { r, sel, history: await history() });
});

scenario('reveal-on-arrow', async () => {
  const body = '# Root\n\n' + Array.from({ length: 40 }, (_, i) => `## N${i + 1}\n`).join('\n');
  const p = writeNote('reveal', body);
  await open(p);
  await clickNode('N1');
  expect((await selection())[0] === 'N1', 'N1 is selected');
  // Scroll the selection off-screen with the plain wheel (pans the canvas).
  const centre = await evalJs(`const c = H.root().getBoundingClientRect(); return { x: Math.round(c.left + c.width / 2), y: Math.round(c.top + c.height / 2) };`);
  let off = false;
  for (let i = 0; i < 8 && !off; i++) {
    await wheel(centre.x, centre.y, 600);
    off = !(await evalJs(`return H.inView('N1');`));
  }
  expect(off, 'precondition: wheel scrolling moved N1 out of view');
  const trace = [];
  for (const key of ['ArrowDown', 'ArrowUp']) {
    await press(key);
    await sleep(300);
    trace.push(await evalJs(`const s = H.selTexts()[0]; return { key: '${key}', sel: s, inView: H.inView(s) };`));
  }
  expect(trace.every((t) => t.sel && t.inView), 'keyboard navigation scrolls the new selection into view', trace);
  expect(trace[0].sel !== trace[1].sel, 'down then up moves between two different nodes', trace);
});

scenario('undo-while-editing', async () => {
  const p = writeNote('undo', '# Root\n\n## B\n');
  await open(p);
  await clickNode('B');
  await press('Tab');
  await waitEditing(true);
  await typeText('abc');
  const before = { history: await history(), nodes: (await texts()).length };
  await press('KeyZ', MOD);
  const after = { history: await history(), nodes: (await texts()).length, editing: await isEditing() };
  expect(after.editing && after.nodes === before.nodes && after.history.undo === before.history.undo,
    'Cmd+Z while editing leaves the node and the map history alone', { before, after });
  await press('Escape');
});

scenario('suggest-escape', async () => {
  const p = writeNote('suggest', '# Root\n\n## B\n');
  await open(p);
  await clickNode('B');
  await press('Space');
  await waitEditing(true);
  await typeText(' [[');
  await sleep(500);
  const suggest = `return { open: !!document.querySelector('.suggestion-container'), text: H.editorText() };`;
  let r = await evalJs(suggest);
  expect(r.open, 'typing [[ opens the file suggestion', r);
  await press('Escape');
  r = { ...(await evalJs(suggest)), editing: await isEditing() };
  expect(!r.open && r.editing && r.text.endsWith('[['), 'Esc closes the suggestion and keeps the edit', r);
  await press('Escape');
});

scenario('replace-previous-text', async () => {
  const p = writeNote('replace', '# Root\n\n## B\n');
  await open(p);
  await editText('B', 'B2');
  let r = await texts();
  expect(r.includes('B2') && !r.includes('B'), 'the edit is applied', r);
  await cli(['command', 'id=mapdown:Replace by the previous text']);
  await sleep(600);
  r = await texts();
  expect(r.includes('B') && !r.includes('B2'), 'command restores the text before the last edit', r);
  await press('KeyZ', MOD);
  await sleep(800);
  r = await texts();
  expect(r.includes('B2'), 'the restore is undoable', r);
  await flush();
  expect(readNote(p).includes('## B2'), 'the result is saved to disk');
});

scenario('undo-restores-collapse', async () => {
  const p = writeNote('undocollapse', '# Root\n\n## P ^p1\n\n- P child\n\n## S\n\n## Q\n', '{"version":2,"collapsed":["p1"]}');
  const state = () => evalJs(`return { collapsed: H.collapsed('P'), texts: H.texts() };`);
  await open(p);
  await clickNode('P');
  let r = await state();
  expect(r.collapsed && !r.texts.includes('P child'), 'P starts collapsed', r);
  const base = (await history()).undo;

  // Tab adds a child to the collapsed node: undo must collapse it again.
  await press('Tab');
  await waitEditing(true);
  await typeText('new');
  await press('Enter');
  await waitEditing(false);
  r = await state();
  expect(!r.collapsed && r.texts.includes('new') && r.texts.includes('P child'), 'Tab opens P and adds a child', r);
  await undoTo(base);
  r = await state();
  expect(r.collapsed && !r.texts.includes('new') && !r.texts.includes('P child'), 'undo removes the child and collapses P again', r);
  await redoAll();
  r = await state();
  expect(!r.collapsed && r.texts.includes('new'), 'redo opens P again', r);
  await undoTo(base);

  // Paste into the collapsed node.
  await clickNode('Q');
  await press('KeyC', MOD);
  await sleep(300);
  await clickNode('P');
  const beforePaste = (await history()).undo;
  await press('KeyV', MOD);
  await sleep(600);
  r = await state();
  expect(!r.collapsed && r.texts.filter((t) => t === 'Q').length === 2, 'pasting into a collapsed node opens it', r);
  await undoTo(beforePaste);
  r = await state();
  expect(r.collapsed && r.texts.filter((t) => t === 'Q').length === 1, 'undoing a paste into a collapsed node collapses it again', r);

  // Moving a node into the collapsed one (S sits right after P) opens it.
  await clickNode('S');
  const beforeMove = (await history()).undo;
  const rightSide = await evalJs(`return H.rect('S').x > H.rect('Root').x;`);
  await press(rightSide ? 'ArrowRight' : 'ArrowLeft', ALT | SHIFT);
  await sleep(500);
  r = await state();
  expect(!r.collapsed && r.texts.includes('S') && r.texts.includes('P child'), 'moving a node into a collapsed node opens it', r);
  await undoTo(beforeMove);
  r = await state();
  expect(r.collapsed && r.texts.includes('S'), 'undoing the move collapses it again', r);
});

scenario('paste-redo', async () => {
  const p = writeNote('paste', '# Root\n\n## Src\n\n### Leaf\n\n## Dst\n');
  await open(p);
  await clickNode('Src');
  await press('KeyC', MOD);
  await sleep(300);
  await clickNode('Dst');
  await press('KeyV', MOD);
  await sleep(800);
  const count = async (t) => (await texts()).filter((x) => x === t).length;
  expect((await count('Src')) === 2 && (await count('Leaf')) === 2, 'paste copies the subtree', await texts());
  const afterPaste = (await history()).undo;

  // Add a child to the pasted copy (the second "Src" in depth-first order).
  await clickNode('Src', { index: 1 });
  await press('Tab');
  await waitEditing(true);
  await typeText('extra');
  await press('Enter');
  await waitEditing(false);
  expect((await count('extra')) === 1, 'child added to the pasted copy', await texts());
  const full = await texts();

  await undoTo(afterPaste);
  expect((await count('extra')) === 0 && (await count('Src')) === 2, 'undo removes the added child, keeps the paste', await texts());
  await undoTo(afterPaste - 1);
  expect((await count('Src')) === 1, 'undo removes the pasted subtree', await texts());
  await redoAll();
  const r = await evalJs(`return { texts: H.texts(), dom: H.root().querySelectorAll('.mapdown-node').length };`);
  expect(JSON.stringify(r.texts) === JSON.stringify(full), 'redo re-attaches the pasted subtree and its child', { expected: full, got: r.texts });
  expect(r.dom === r.texts.length, 'no orphan nodes remain in the DOM', r);
});

scenario('unsupported-state', async () => {
  const p = writeNote('badstate', '# Bad\n\n## X\n', '{"version":3,"collapsed":[]}');
  const original = readNote(p);
  const r = await evalJs(`
    await H.indexed('${p}');
    const leaf = app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: '${VIEW_TYPE}', state: { file: '${p}' } });
    await H.wait(1500);
    return { type: leaf.view.getViewType() };
  `);
  expect(r.type === 'markdown', 'unwritable mindmark-state falls back to Markdown', r);
  expect(readNote(p) === original, 'the file is left untouched');
});

scenario('new-map', async () => {
  const before = new Set(await vaultPaths());
  let created = [];
  try {
    await evalJs(`await app.plugins.plugins.mapdown.newMindMap(H.file('${INBOX}')); await H.wait(800);`);
    const rendered = await waitFor(() => evalJs(`return !!H.root() && !!H.root().querySelector('.mapdown-node');`), 6000);
    expect(rendered, 'the new map opens in the mind map view');
    if (!(await isEditing())) {
      // Not auto-editing: select the root and edit it ourselves.
      await press('Home');
      await press('Space');
    }
    await waitEditing(true);
    await evalJs('H.selectEditorText();');
    await typeText(`${PREFIX}newmap`);
    await press('Enter');
    await waitEditing(false);
    await flush();
    await sleep(800);
    created = (await vaultPaths()).filter((x) => !before.has(x));
    for (const c of created) trackedPaths.add(c);
    const root = await evalJs(`return { texts: H.texts(), collapsed: H.collapsed(H.texts()[0]) };`);
    expect(created.length === 1, 'creating and editing a new map adds exactly one file and no backup', created);
    if (created[0] !== notePath('newmap')) {
      note(`the new map kept its name (${created[0]}); the spec renames only a real level-1 root (6.3)`);
    }
    const disk = readNote(created[0]);
    expect(disk.includes(`# ${PREFIX}newmap`), 'the typed root text is written as the level-1 title', disk);
    expect(root.texts[0] === `${PREFIX}newmap` && !root.collapsed, 'new root starts expanded', root);
    expect(disk.includes('"collapsed":[]'), 'nothing is saved as collapsed', disk);
  } finally {
    for (const c of (await vaultPaths().catch(() => [])).filter((x) => !before.has(x))) trackedPaths.add(c);
  }
});

scenario('file-mode-per-file', async () => {
  const a = writeNote('mode_a', '# A\n\n## x\n');
  const b = writeNote('mode_b', '# B\n\n## y\n');
  const r = await evalJs(`
    await H.indexed('${b}');
    const leaf = await H.open('${a}');
    app.commands.executeCommandById('mapdown:Set to markdown view');
    // leaf.working: Obsidian ignores openFile while the tab is still switching.
    await H.until(() => leaf.view.getViewType() === 'markdown' && !leaf.working, 3000);
    const first = leaf.view.getViewType();
    await leaf.openFile(H.file('${b}'));
    await H.wait(1200);
    const other = leaf.view.getViewType();
    await leaf.openFile(H.file('${a}'));
    await H.wait(1200);
    return { first, other, again: leaf.view.getViewType() };
  `);
  expect(r.first === 'markdown', 'the set-to-Markdown command switches the tab', r);
  expect(r.other === VIEW_TYPE && r.again === 'markdown', 'Markdown mode is remembered per file, not per tab', r);
});

scenario('external-edit-during-save', async () => {
  const p = writeNote('external', '# Root\n\n## child\n');
  const modify = (suffix) => evalJs(`
    const f = H.file('${p}');
    const disk = await app.vault.read(f);
    await app.vault.modify(f, disk.trimEnd() + '\\n\\n## ${suffix}\\n');`);
  await open(p);

  // 1. An external edit after a save is picked up; nothing local is lost.
  await editText('child', 'local');
  await flush();
  await modify('external');
  const picked = await waitFor(async () => (await texts()).includes('external'), 8000);
  let t = await texts();
  expect(picked && t.includes('local'), 'view shows both the saved local edit and the external edit', t);
  let disk = readNote(p);
  expect(disk.includes('## local') && disk.includes('## external'), 'disk keeps both edits', disk);

  // 2. An external edit right after a local edit, before the save has settled
  //    (6.5): neither side may be lost. Mapdown either merges, or keeps the
  //    local version in a conflict copy and loads the external one.
  await editText('local', 'local2');
  await modify('external2');
  await sleep(2500);
  await flush().catch(() => {});
  t = await texts();
  disk = readNote(p);
  const copies = safetyCopies().map((rel) => readNote(rel));
  const hasExternal = t.includes('external2') || disk.includes('## external2');
  const hasLocal = t.includes('local2') || disk.includes('## local2') || copies.some((c) => c.includes('local2'));
  expect(hasExternal && hasLocal, 'no edit is lost when the file changes during a save', { texts: t, copies: copies.length });
  expect(t.includes('external2'), 'the view ends up showing the external version', t);
}, { allowCopies: true });

scenario('rename-sync', async () => {
  const p = writeNote('rename', '# Root\n\n## child\n');
  const dir = `${INBOX}/${PREFIX}dir`;
  const moved = `${dir}/${PREFIX}renamed.md`;
  await open(p);
  const r = await evalJs(`
    if (!H.file('${dir}')) await app.vault.createFolder('${dir}');
    await app.fileManager.renameFile(H.file('${p}'), '${moved}');
    await H.wait(800);
    const v = app.workspace.activeLeaf.view;
    return { type: v.getViewType(), file: v.file.path, texts: H.texts() };
  `);
  expect(r.type === VIEW_TYPE && r.file === moved && r.texts.length === 2, 'the open map follows a move', r);
  await editText('child', 'kid');
  await flush();
  expect(readNote(moved).includes('## kid'), 'edits after the move are saved to the new path');
  expect(!fs.existsSync(path.join(VAULT, p)), 'nothing is written back to the old path');
});

scenario('wheel-zoom-scope', async () => {
  const p = writeNote('wheel', '# Root\n\n## child\n');
  await open(p);
  const rect = await evalJs(`const r = H.root().getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height };`);
  // Root node width is a scale proxy that does not depend on how zoom is applied.
  const scale = async () => (await rectOf('Root')).width;
  const inside = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  // Just above the map: the tab header, which belongs to Obsidian.
  const outside = { x: inside.x, y: Math.round(rect.top - 10) };
  const isOutside = await evalJs(`return !H.root().contains(document.elementFromPoint(${outside.x}, ${outside.y}));`);
  expect(isOutside, 'precondition: the probe point lies outside the map');

  const start = await scale();
  await wheel(outside.x, outside.y, -120, MOD);
  const afterOutside = await scale();
  expect(afterOutside === start, 'Ctrl+wheel outside the map does not zoom it', { start, afterOutside });
  await wheel(inside.x, inside.y, -120);
  const afterPlain = await scale();
  expect(afterPlain === start, 'a plain wheel over the map scrolls instead of zooming', { start, afterPlain });
  await wheel(inside.x, inside.y, -120, MOD);
  const zoomedIn = await scale();
  expect(zoomedIn > start, 'Ctrl+wheel up over the map zooms in', { start, zoomedIn });
  await wheel(inside.x, inside.y, 120, MOD);
  await wheel(inside.x, inside.y, 120, MOD);
  const zoomedOut = await scale();
  expect(zoomedOut < zoomedIn, 'Ctrl+wheel down zooms out', { zoomedIn, zoomedOut });
});

scenario('pointer-basics', async () => {
  const p = writeNote('pointer', '# Root\n\n## A\n\n## B\n');
  await open(p);

  await clickNode('B');
  let sel = await selection();
  expect(sel.length === 1 && sel[0] === 'B', 'clicking a node selects only it', sel);

  await clickNode('B', { clickCount: 2 });
  expect(await isEditing(), 'double-clicking a node edits it');
  await press('Escape');
  await waitEditing(false);

  const empty = await evalJs(`return H.emptyPoint();`);
  expect(empty, 'found an empty canvas point to drag from');
  await mouse('mouseMoved', empty.x, empty.y);
  await mouse('mousePressed', empty.x, empty.y);
  await mouse('mouseReleased', empty.x, empty.y);
  await sleep(400);
  sel = await selection();
  expect(sel.length === 0, 'clicking empty canvas clears the selection', sel);

  // Left drag over empty canvas box-selects and does not pan.
  const a = await rectOf('A');
  const rootBefore = await rectOf('Root');
  const start = { x: Math.round(a.right + 25), y: Math.round(a.bottom + 25) };
  const startEmpty = await evalJs(`return H.isEmptyPoint(${start.x}, ${start.y});`);
  expect(startEmpty, 'precondition: the box starts on empty canvas', start);
  const end = { x: Math.round(a.left + 3), y: Math.round(a.top + 3) };
  await mouse('mouseMoved', start.x, start.y);
  await mouse('mousePressed', start.x, start.y);
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', start.x + (end.x - start.x) * i / 6, start.y + (end.y - start.y) * i / 6, { buttons: 1 });
  }
  await mouse('mouseReleased', end.x, end.y);
  await sleep(500);
  sel = await selection();
  const rootAfter = await rectOf('Root');
  expect(sel.length === 1 && sel[0] === 'A', 'dragging a box over empty canvas selects the nodes it touches', sel);
  expect(Math.abs(rootAfter.x - rootBefore.x) < 1 && Math.abs(rootAfter.y - rootBefore.y) < 1, 'box selection does not pan the map', { rootBefore, rootAfter });

  // Right and middle drag pan; releasing after a pan opens no menu.
  for (const button of ['right', 'middle']) {
    const empty = await evalJs(`return H.emptyPoint();`);
    const before = await rectOf('Root');
    await mouse('mouseMoved', empty.x, empty.y);
    await mouse('mousePressed', empty.x, empty.y, { button });
    for (let i = 1; i <= 6; i++) {
      await mouse('mouseMoved', empty.x - 10 * i, empty.y - 20 * i, { button, buttons: button === 'right' ? 2 : 4 });
    }
    await mouse('mouseReleased', empty.x - 60, empty.y - 120, { button });
    await sleep(400);
    const after = await rectOf('Root');
    const menu = await evalJs(`return H.menuItems().length > 0;`);
    expect(Math.abs(after.x - before.x) > 20 || Math.abs(after.y - before.y) > 20, `${button}-dragging empty canvas pans the map`, { before, after });
    expect(!menu, `releasing after a ${button}-drag opens no node menu`);
    // Put the map back so later points stay valid.
    await evalJs(`(H.root() || document).querySelector('.mapdown-toolbar [data-action="fit"]')?.click();`);
    await sleep(500);
  }

  // Right click on a node opens the node menu with its three items.
  await clickNode('B', { button: 'right' });
  // By data-action, not label: the labels follow Obsidian's language.
  const items = await evalJs(`const a = H.menuItems(); return ['add-child', 'delete', 'focus'].map((s) => a.includes(s));`);
  expect(items.every(Boolean), 'right-clicking a node opens the menu: add child, delete, focus', items);
  expect((await selection())[0] === 'B', 'right-click selects the node', await selection());
  const before = (await texts()).length;
  const add = await evalJs(`const b = (H.root() || document).querySelector('.mapdown-node-menu [data-action="add-child"]').getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };`);
  await mouse('mouseMoved', add.x, add.y);
  await mouse('mousePressed', add.x, add.y);
  await mouse('mouseReleased', add.x, add.y);
  await sleep(500);
  expect((await texts()).length === before + 1, 'the menu button adds a child', await texts());
  await press('Escape');
});

// Opens the map in a tab and the same note as Markdown in a split.
async function openMapAndMarkdown(p) {
  await evalJs(`
    const map = await H.open('${p}');
    const md = app.workspace.getLeaf('split', 'vertical');
    await md.openFile(H.file('${p}'), { active: true });
    await H.until(() => md.view.getViewType() === VT, 4000);
    app.workspace.setActiveLeaf(md, { focus: true });
    app.commands.executeCommandById('mapdown:Set to markdown view');
    await H.until(() => md.view.getViewType() === 'markdown' && md.view.editor, 4000);
    window.__mdE2e = { map, md };
    await H.wait(300);
  `);
}

// Puts the keyboard in the Markdown editor, cursor at the end.
const focusEditor = () => evalJs(`
  const { md } = window.__mdE2e;
  app.workspace.setActiveLeaf(md, { focus: true });
  const e = md.view.editor;
  e.focus();
  const last = e.lineCount() - 1;
  e.setCursor({ line: last, ch: e.getLine(last).length });
  await H.wait(300);
`);

scenario('scope-keys-not-leaking', async () => {
  const p = writeNote('scope', '# Root\n\n## A\n\n### A1\n\n## B\n');
  await openMapAndMarkdown(p);
  const snapshot = () => evalJs(`
    const { md } = window.__mdE2e;
    return { texts: H.texts(), sel: H.selTexts(), history: H.api().historySize(),
      editor: md.view.editor.getValue(), collapsed: H.texts().filter((t) => H.collapsed(t)) };`);

  // Map keys pressed while the Markdown editor has focus leave the map alone.
  await evalJs(`app.workspace.setActiveLeaf(window.__mdE2e.map, { focus: true });`);
  await clickNode('A');
  const before = await snapshot();
  const diskBefore = readNote(p);
  await focusEditor();
  await press('Digit1', ALT);       // map: collapse to level 1
  await press('KeyA', MOD);         // map: select all nodes (editor: select all text)
  await press('KeyY', MOD);         // map: redo
  await press('ArrowRight');        // map: select first child (editor: move caret)
  const after = await snapshot();
  expect(JSON.stringify(after.texts) === JSON.stringify(before.texts) && after.collapsed.length === before.collapsed.length,
    'map shortcuts typed in the editor do not collapse or change the map', { before, after });
  expect(JSON.stringify(after.sel) === JSON.stringify(before.sel) && after.history.undo === before.history.undo && after.history.redo === before.history.redo,
    'map shortcuts typed in the editor do not change its selection or history', { before: before.sel, after: after.sel });
  expect(after.editor === before.editor && readNote(p) === diskBefore, 'and the Markdown text is untouched', after.editor);

  // Editor shortcuts pressed while the map has focus leave the Markdown alone.
  await evalJs(`app.workspace.setActiveLeaf(window.__mdE2e.map, { focus: true });`);
  await clickNode('A');
  const editorBefore = (await snapshot()).editor;
  await press('KeyB', MOD);         // editor: toggle bold
  await press('KeyI', MOD);         // editor: toggle italic
  await press('KeyK', MOD);         // editor: insert link
  await sleep(500);
  const end = await snapshot();
  expect(end.editor === editorBefore && end.texts.includes('A') && end.texts.length === before.texts.length,
    'editor shortcuts pressed in the map do not edit the Markdown or the map', end);
  expect(readNote(p) === diskBefore, 'the note on disk is unchanged', readNote(p));
});

scenario('keyboard-only-tree', async () => {
  const p = writeNote('kbtree', '# Root\n');
  await open(p);
  const type = async (s) => { await waitEditing(true); await typeText(s); await press('Enter'); await waitEditing(false); };
  await press('Home');
  expect((await selection())[0] === 'Root', 'Home selects the root', await selection());
  await press('Tab');           // child of Root
  await type('Alpha');
  await press('Enter');         // sibling below Alpha
  await type('Beta');
  await press('Tab');           // child of Beta
  await type('Beta1');
  await press('Tab');           // child of Beta1: third level
  await type('Beta1a');
  expect((await selection())[0] === 'Beta1a', 'the newest node stays selected', await selection());
  const full = await texts();
  expect(JSON.stringify(full) === JSON.stringify(['Root', 'Alpha', 'Beta', 'Beta1', 'Beta1a']), 'the tree has five nodes in depth-first order', full);

  // Delete and undo with the keyboard only.
  await press('Delete');
  expect(!(await texts()).includes('Beta1a'), 'Delete removes the selected node', await texts());
  await press('KeyZ', MOD);
  await sleep(500);
  expect(JSON.stringify(await texts()) === JSON.stringify(full), 'Cmd+Z brings it back', await texts());
  await press('Escape');

  await flush();
  const got = outline(readNote(p)).map((o) => `${o.depth}:${o.text}`);
  expect(JSON.stringify(got) === JSON.stringify(['0:Root', '1:Alpha', '1:Beta', '2:Beta1', '3:Beta1a']), 'the file holds the same three-level tree', { got, disk: readNote(p) });
});

scenario('minimal-text-edit', async () => {
  const body = [
    '# Root', '',
    '## Alpha', '',
    '* star item',
    '* second ^blk1',
    '  - deep', '',
    '1. one',
    '2. two', '',
    '## Beta', '',
  ].join('\n');
  const p = writeNote('minimal', body);
  const original = readNote(p);
  await open(p);
  const diff = (a, b) => {
    const x = a.split('\n'), y = b.split('\n');
    return { sameLength: x.length === y.length, changed: x.map((l, i) => [l, y[i]]).filter(([l, m]) => l !== m) };
  };

  // Opening and flushing without an edit must not touch the file.
  await flush();
  expect(readNote(p) === original, 'opening a note changes nothing on disk');

  await clickNode('second');
  await press('Space');
  await waitEditing(true);
  await typeText(' edited');
  await press('Enter');
  await waitEditing(false);
  await flush();
  let d = diff(original, readNote(p));
  expect(d.sameLength && d.changed.length === 1 && d.changed[0][0] === '* second ^blk1' && d.changed[0][1] === '* second edited ^blk1',
    'editing a bullet changes only its own line and keeps marker and block id', d);

  const afterFirst = readNote(p);
  await clickNode('two');
  await press('Space');
  await waitEditing(true);
  await typeText('!');
  await press('Enter');
  await waitEditing(false);
  await flush();
  d = diff(afterFirst, readNote(p));
  expect(d.sameLength && d.changed.length === 1 && d.changed[0][0] === '2. two' && d.changed[0][1] === '2. two!',
    'editing a numbered item changes only that line and keeps its number', d);
});

scenario('collapse-to-level', async () => {
  const p = writeNote('levels', '# Root\n\n## A\n\n### A1\n\n#### A1a\n\n## B\n\n### B1\n');
  await open(p);
  await press('Home');
  const full = (await texts()).length;
  expect(full === 6, 'six nodes to start with', await texts());
  const state = async () => evalJs(`return { n: H.texts().length, root: H.texts()[0], collapsed: H.texts().filter((t) => H.collapsed(t)) };`);
  const counts = {};
  for (let level = 1; level <= 4; level++) {
    await press(`Digit${level}`, ALT);
    await sleep(300);
    counts[level] = await state();
  }
  expect(counts[1].root === 'Root' && counts[1].n < counts[2].n && counts[2].n < counts[3].n && counts[3].n <= counts[4].n,
    'Alt+1..4 show a growing number of levels', counts);
  expect(counts[1].n < full && counts[1].collapsed.length > 0, 'level 1 collapses branches', counts[1]);
  expect(counts[4].n === full && counts[4].collapsed.length === 0, 'a level at or beyond the tree depth shows everything', counts[4]);

  // The collapse is saved in mindmark-state.
  await press('Digit2', ALT);
  await flush();
  expect(!readNote(p).includes('"collapsed":[]'), 'collapsed branches are written to mindmark-state', readNote(p));

  // The command does the same as the key.
  await press('Digit6', ALT);
  expect((await state()).n === full, 'Alt+6 expands everything again');
  await cli(['command', 'id=mapdown:collapse-to-level-2']);
  await sleep(500);
  expect((await state()).n === counts[2].n, 'the collapse-to-level-2 command matches Alt+2', await state());
  await press('Digit6', ALT);
  await flush();
  expect(readNote(p).includes('"collapsed":[]'), 'expanding everything clears the saved collapse', readNote(p));
});

// ---------------------------------------------------------------------------
// Later phases. Registered with their phase from LATER_PHASE and skipped
// unless --phase N (or --only) selects them.

// Search bar and focus mode helpers (spec 5.3, 5.4). DOM classes from
// src/view/contract.ts; texts come from testApi.visibleNodes.
const SEARCH_STATE = `
  const root = H.root();
  const bar = root.querySelector('.mapdown-search');
  const input = bar ? bar.querySelector('.mapdown-search-input') : null;
  const by = new Map(H.visible().map((n) => [n.id, n.text]));
  const textOf = (e) => by.get(e.getAttribute('data-node-id'));
  const cur = root.querySelector('.mapdown-node.is-search-current');
  const active = document.activeElement;
  return {
    open: !!bar,
    query: input ? input.value : null,
    count: bar ? bar.querySelector('.mapdown-search-count').textContent.trim() : null,
    current: cur ? textOf(cur) : null,
    matches: Array.from(root.querySelectorAll('.mapdown-node.is-search-match')).map(textOf),
    inputFocused: !!input && active === input,
    mapFocused: root.contains(active) && !(bar && bar.contains(active)),
    focusMode: root.classList.contains('is-focus-mode'),
    texts: H.texts(),
  };`;
const searchState = () => evalJs(SEARCH_STATE);

// Opens the search bar with its toolbar button (a real mouse click).
async function searchOpen() {
  const r = await evalJs(`const b = H.root().querySelector('.mapdown-toolbar [data-action="search"]');
    const x = b.getBoundingClientRect();
    return { x: Math.round(x.left + x.width / 2), y: Math.round(x.top + x.height / 2), disabled: b.disabled };`);
  expect(!r.disabled, 'the toolbar search button is enabled', r);
  await mouse('mouseMoved', r.x, r.y);
  await mouse('mousePressed', r.x, r.y);
  await mouse('mouseReleased', r.x, r.y);
  const ok = await waitFor(async () => (await searchState()).inputFocused, 3000);
  expect(ok, 'the search box opens with keyboard focus', await searchState());
}

// Waits for the debounced (120 ms) result count.
async function searchWaitCount(count) {
  const ok = await waitFor(async () => (await searchState()).count === count, 3000);
  expect(ok, `search shows "${count}"`, await searchState());
}

// Focus mode as the user sees it: view class, drawn nodes, the focus node.
const FOCUS_STATE = `
  await H.frames(2);
  const v = H.root();
  const c = v.getBoundingClientRect();
  const center = (t) => { const r = H.rect(t); return !!r && Math.abs(r.x - (c.left + c.width / 2)) < 10 && Math.abs(r.y - (c.top + c.height / 2)) < 10; };
  const by = new Map(H.visible().map((n) => [n.id, n.text]));
  const rootEl = v.querySelector('.mapdown-node.is-focus-root');
  const active = document.activeElement;
  return {
    focusMode: v.classList.contains('is-focus-mode'),
    texts: H.texts(),
    rendered: Array.from(v.querySelectorAll('.mapdown-node')).map((e) => by.get(e.getAttribute('data-node-id')) || '?').sort(),
    paths: v.querySelectorAll('.mapdown-edges path').length,
    focusRoot: rootEl ? by.get(rootEl.getAttribute('data-node-id')) : null,
    sel: H.selTexts(),
    centredA: center('A'),
    keyboardInMap: !!active && v.contains(active),
  };`;
const focusState = () => evalJs(FOCUS_STATE);

// Focus mode settings as saved in the plugin's data.json (defaults from spec 8).
function focusSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'data.json'), 'utf8')); } catch (e) {}
  const num = (v, d, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  return { focusOverlayOpacity: num(saved.focusOverlayOpacity, 0.4, 0, 0.8), focusGlowSize: Math.round(num(saved.focusGlowSize, 150, 0, 400) / 10) * 10 };
}

scenario('focus-delete', async () => {
  const p = writeNote('focus', '# Root\n\n## A\n\n### A1\n\n## B\n');
  await open(p);
  await clickNode('A');
  await press('KeyF');
  let r = await focusState();
  expect(r.focusMode && JSON.stringify(r.texts) === '["A","A1"]' && JSON.stringify(r.rendered) === '["A","A1"]' && r.paths === 1,
    'F shows only the focus node, its subtree and their edge', r);
  expect(r.focusRoot === 'A' && r.centredA && JSON.stringify(r.sel) === '["A"]', 'the focus node is marked, selected and centred', r);
  const data = focusSettings();
  const look = await evalJs(`
    const v = H.root(), cs = getComputedStyle(v);
    return { overlay: cs.getPropertyValue('--mapdown-focus-overlay').trim(), wantOverlay: ${JSON.stringify(Math.round(data.focusOverlayOpacity * 100) + '%')},
      glow: cs.getPropertyValue('--mapdown-focus-glow-size').trim(), wantGlow: ${JSON.stringify(data.focusGlowSize + 'px')},
      tinted: getComputedStyle(v.querySelector('.mapdown-map')).boxShadow !== 'none' };`);
  expect(look.overlay === look.wantOverlay && look.glow === look.wantGlow && look.tinted, 'overlay opacity and glow size come from the settings', look);

  await press('KeyF');
  r = await focusState();
  expect(!r.focusMode && r.texts.length === 4 && JSON.stringify(r.sel) === '["A"]' && r.centredA && r.keyboardInMap,
    'F again leaves focus mode with the former focus node selected and centred', r);

  await press('KeyF');
  r = await focusState();
  expect(r.focusMode && r.focusRoot === 'A', 'F enters focus mode again', r);
  await press('Delete');
  r = await focusState();
  expect(!r.focusMode && JSON.stringify(r.texts) === '["Root","B"]' && r.focusRoot === null,
    'deleting the focus node leaves focus mode and shows the whole map', r);
  expect(r.keyboardInMap && r.sel.length === 1, 'keyboard focus and a selection stay in the map', r);
  await press('KeyZ', META);
  r = await focusState();
  expect(r.texts.includes('A') && r.texts.includes('A1'), 'undo restores the deleted node (so map keys still reach the map)', r);
});

scenario('undo-delete-shortcut', async () => {
  const p = writeNote('undodel', '# Root\n\n## A\n\n## B\n\n## C\n');
  await open(p);
  await ensureForeground();
  const has = async (t) => (await texts()).includes(t);

  await clickNode('A');
  await press('Delete');
  expect(!(await has('A')), 'clicking A and pressing Delete removes it', await texts());
  await press('KeyZ', MOD);
  expect(await has('A'), 'Cmd/Ctrl+Z restores a node deleted with the Delete key after a click', await texts());

  await clickNode('B', { button: 'right' });
  const del = await evalJs(`const b = (H.root() || document).querySelector('.mapdown-node-menu [data-action="delete"]');
    if (!b || b.offsetParent === null) return null;
    const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`);
  expect(del, 'the node menu shows a delete button');
  await mouse('mouseMoved', del.x, del.y, { buttons: 0 });
  await mouse('mousePressed', del.x, del.y);
  await mouse('mouseReleased', del.x, del.y);
  await sleep(400);
  expect(!(await has('B')), 'the node menu delete button removes B', await texts());
  await press('KeyZ', MOD);
  expect(await has('B'), 'Cmd/Ctrl+Z restores a node deleted from the node menu', await texts());

  // Box-select A and B by dragging on empty canvas, then delete both.
  await msBox(['A', 'B']);
  let s = await msSel();
  expect(s.sel.join() === 'A,B', 'dragging on the canvas box-selects A and B', s);
  await press('Delete');
  expect(!(await has('A')) && !(await has('B')), 'Delete removes the box-selected nodes', await texts());
  await press('KeyZ', MOD);
  expect((await has('A')) && (await has('B')), 'Cmd/Ctrl+Z restores box-selected nodes deleted together', await texts());

  await press('KeyA', MOD);
  await press('Delete');
  expect((await texts()).join() === 'Root', 'Cmd/Ctrl+A then Delete removes the children', await texts());
  await press('KeyZ', MOD);
  expect((await texts()).join() === 'Root,A,B,C', 'Cmd/Ctrl+Z restores nodes deleted after select all', await texts());
  await flush();
  expect(readNote(p).includes('## A\n\n## B\n\n## C'), 'the file has every node back', readNote(p));
});

scenario('search-layout', async () => {
  const p = writeNote('search', '# Root\n\n## Branch ^b1\n\n### Zeta\n\n## Other zeta\n', '{"version":2,"collapsed":["b1"]}');
  await open(p);
  let s = await searchState();
  expect(!s.texts.includes('Zeta') && s.texts.includes('Other zeta'), 'the collapsed child starts hidden', s);
  const base = await history();
  await searchOpen();
  await typeText('zeta');
  await searchWaitCount('0 / 2');
  s = await searchState();
  expect(!s.texts.includes('Zeta') && s.current === null && JSON.stringify(s.matches) === '["Other zeta"]',
    'typing counts every match, highlights the visible ones and goes nowhere yet', s);
  // Map keys pressed in the box must not act on the map.
  await press('KeyF');
  await press('Space');
  await press('Delete');
  s = await searchState();
  expect(!s.focusMode && !(await isEditing()) && s.texts.includes('Other zeta') && s.inputFocused,
    'map keys pressed in the search box do not reach the map', s);

  await press('Enter');
  s = await searchState();
  expect(s.current === 'Zeta' && s.count === '1 / 2' && s.texts.includes('Zeta'), 'Enter goes to the first match and opens its collapsed branch', s);
  const geo = await evalJs(`await H.frames(2);
    const r = H.rect('Root'), b = H.rect('Branch'), z = H.rect('Zeta');
    return { laidOut: !!z && Math.abs(z.x - r.x) > Math.abs(b.x - r.x), inView: H.inView('Zeta'),
      paths: H.root().querySelectorAll('.mapdown-edges path').length, visible: H.texts().length };`);
  expect(geo.laidOut && geo.inView && geo.paths === geo.visible - 1, 'the revealed match is laid out, connected and on screen', geo);
  expect(s.inputFocused, 'focus stays in the search box', s);

  await press('Enter');
  s = await searchState();
  expect(s.current === 'Other zeta' && s.count === '2 / 2' && !s.texts.includes('Zeta'), 'the next match folds the earlier branch back', s);
  await press('Enter', SHIFT);
  s = await searchState();
  expect(s.current === 'Zeta' && s.count === '1 / 2' && s.texts.includes('Zeta'), 'Shift+Enter goes back and reopens the branch', s);

  await flush();
  const h = await history();
  expect(readNote(p).includes('"collapsed":["b1"]') && h.undo === base.undo,
    'the temporary expansion is neither saved to mindmark-state nor an undo step', { h, base, text: readNote(p) });

  await press('Escape');
  s = await searchState();
  expect(!s.open && !s.texts.includes('Zeta') && s.matches.length === 0 && s.mapFocused,
    'closing search folds the branch back, clears the highlight and gives focus back to the map', s);
  expect(await evalJs(`return H.collapsed('Branch');`), 'the branch shows as collapsed again');
});

// ---------------------------------------------------------------------------
// Split-view sync and in-place updates (spec 5.6). Black-box: map DOM and
// testApi on one side, Obsidian's Editor API of the Markdown split on the
// other. The highlighted line carries DOM.syncLine ('mapdown-sync-line').

// openMapAndMarkdown, then make the map the active view once, so testApi
// reads this map (the split briefly opened as a map before it switched).
async function syncOpen(p) {
  await openMapAndMarkdown(p);
  await evalJs(`app.workspace.setActiveLeaf(window.__mdE2e.map, { focus: true }); await H.wait(300);`);
}

// A note long enough that the Markdown view has to scroll.
function syncNote(name) {
  const body = '# Root\n\n' + Array.from({ length: 30 }, (_, i) => `## N${i + 1}\n\nParagraph ${i + 1}\n`).join('\n');
  return writeNote(name, body);
}

// Select a node in the map with a real click (fit first if it is off screen).
async function syncClickNode(text, options = {}) {
  await ensureForeground();
  await evalJs(`app.workspace.setActiveLeaf(window.__mdE2e.map, { focus: true }); await H.wait(200);`);
  if (!(await evalJs(`return H.inView(${JSON.stringify(text)});`))) {
    await evalJs(`H.root().querySelector('.mapdown-toolbar [data-action="fit"]')?.click(); await H.wait(500); await H.frames(2);`);
  }
  await clickNode(text, options);
}

// Put the Markdown cursor on the first line equal to `text` (editor focused).
async function syncCursorTo(text, ch = 2) {
  await ensureForeground();
  await evalJs(`
    const { md } = window.__mdE2e;
    app.workspace.setActiveLeaf(md, { focus: true });
    const e = md.view.editor;
    e.focus();
    const line = e.getValue().split('\\n').findIndex((l) => l === ${JSON.stringify(text)});
    if (line < 0) throw new Error('no line ' + ${JSON.stringify(text)});
    e.setCursor({ line, ch: ${ch} });
    await H.wait(400);
  `);
}

// Both sides at a glance. `sel` is the map's primary selection (by text).
const SYNC_STATE = `
  const { map, md } = window.__mdE2e;
  const e = md.view.editor, cm = e.cm;
  const api = H.api();
  const byId = new Map(api.visibleNodes().map((n) => [n.id, n.text]));
  const primary = api.selection()[0] ?? null;
  const nodeLine = primary === null ? null : api.nodeLine(primary);
  const cursor = e.getCursor();
  let lineVisible = false;
  if (nodeLine !== null && cm) {
    const box = cm.coordsAtPos(cm.state.doc.line(nodeLine + 1).from);
    const sc = cm.scrollDOM.getBoundingClientRect();
    lineVisible = !!box && box.top >= sc.top && box.bottom <= sc.bottom;
  }
  const state = {
    sel: primary === null ? null : byId.get(primary) ?? null,
    nodeLine,
    cursorLine: cursor.line,
    cursor,
    lineText: e.getLine(cursor.line),
    lineVisible,
    flashed: !!(cm && cm.contentDOM.querySelector('.mapdown-sync-line')),
    focusInMap: map.view.contentEl.contains(document.activeElement),
    editorFocused: e.hasFocus(),
    texts: H.texts(),
    history: api.historySize(),
  };
`;

// Every visible node's line holds its text, and that line resolves back to it.
const SYNC_CHECK_LINES = `
  const checkLines = (text) => {
    const lines = text.split('\\n');
    const api = H.api();
    const bad = [];
    for (const n of api.visibleNodes()) {
      const l = api.nodeLine(n.id);
      if (l === null) { bad.push({ node: n.text, line: null }); continue; }
      const first = n.text.split('\\n')[0];
      const line = lines[l] ?? '';
      if (first && !line.includes(first)) bad.push({ node: first, line });
      if (api.nodeAtLine(l) !== n.id) bad.push({ node: first, owner: api.nodeAtLine(l) });
    }
    return bad;
  };
`;

scenario('split-typing-keeps-focus', async () => {
  const p = writeNote('splitfocus', '# Root\n\n## A\n\n## B\n');
  await syncOpen(p);
  await focusEditor();
  await typeText('x');
  await sleep(1000);
  let r = await evalJs(`${SYNC_STATE} return state;`);
  expect(r.texts.includes('x'), 'typing in Markdown updates the map', r.texts);
  expect(r.editorFocused && !r.focusInMap, 'typing in Markdown keeps focus in the editor after the map updates', r);
  const undo = r.history.undo;
  await press('Tab');
  await press('Enter');
  await sleep(1000);
  r = await evalJs(`${SYNC_STATE} return state;`);
  expect(r.editorFocused && !r.focusInMap && r.history.undo === undo, 'Tab and Enter typed in Markdown are not handled by the map', r);
});

scenario('split-type-then-map-edit', async () => {
  const p = writeNote('splitedit', '# Root\n\n## A\n\n## B\n');
  await syncOpen(p);
  await evalJs(`
    const e = window.__mdE2e.md.view.editor;
    const last = e.lineCount() - 1;
    e.replaceRange('\\n\\n## Typed', { line: last, ch: e.getLine(last).length });
    await H.until(() => H.texts().includes('Typed'), 3000);
  `);
  // Edit in the map as soon as it shows the typing, before Obsidian autosaves it.
  await syncClickNode('A');
  await press('Space');
  await waitEditing(true);
  await evalJs('H.selectEditorText();');
  await typeText('A edited');
  await press('Enter');
  await waitEditing(false);
  await flush();
  await waitFor(() => { const d = readNote(p); return d.includes('## A edited') && d.includes('## Typed'); }, 9000);
  const r = await evalJs(`const e = window.__mdE2e.md.view.editor; return { texts: H.texts(), editor: e.getValue() };`);
  const disk = readNote(p);
  expect(disk.includes('## A edited') && disk.includes('## Typed'), 'disk keeps both the typed text and the map edit', disk);
  expect(r.texts.includes('A edited') && r.texts.includes('Typed'), 'map shows both edits', r.texts);
  expect(r.editor.includes('## A edited') && r.editor.includes('## Typed'), 'editor shows both edits', r.editor);
});

// Every node's file line must hold that node, after opening, after a map edit,
// and after typing in the Markdown split.
scenario('source-lines', async () => {
  const p = writeNote('lines', '# Root\n\n## A\n\n- item\n    - sub\n\n## B\n');
  await open(p);
  let r = await evalJs(`${SYNC_CHECK_LINES} return checkLines(await app.vault.read(H.file('${p}')));`);
  expect(r.length === 0, 'node lines match the file after opening', r);

  await editText('A', 'A renamed');
  await clickNode('B');
  await press('Tab');
  await waitEditing(true);
  await typeText('B child');
  await press('Enter');
  await waitEditing(false);
  await flush();
  r = await evalJs(`${SYNC_CHECK_LINES} return { bad: checkLines(await app.vault.read(H.file('${p}'))), texts: H.texts() };`);
  expect(r.texts.includes('A renamed') && r.texts.includes('B child'), 'the map edits are in', r.texts);
  expect(r.bad.length === 0, 'node lines match the file after editing the map', r);

  await syncOpen(p);
  await focusEditor();
  await typeText('\n\n## Typed');
  await evalJs(`await H.until(() => H.texts().includes('Typed'), 6000); await H.wait(200);`);
  r = await evalJs(`
    ${SYNC_CHECK_LINES}
    const text = window.__mdE2e.md.view.editor.getValue();
    const typedLine = text.split('\\n').findIndex((l) => l === '## Typed');
    const api = H.api();
    return {
      bad: checkLines(text),
      atTyped: api.nodeAtLine(typedLine) === H.ids('Typed')[0],
      inFrontmatter: api.nodeAtLine(1),
    };
  `);
  expect(r.bad.length === 0, 'node lines match the editor text after typing in Markdown', r);
  expect(r.atTyped, 'cursor line resolves to the node on that line', r);
  expect(r.inFrontmatter === null, 'frontmatter lines resolve to no node', r);
});

scenario('sync-map-to-text', async () => {
  const p = syncNote('syncmap');
  await syncOpen(p);
  await syncClickNode('N25');
  await sleep(300);
  let r = await evalJs(`${SYNC_STATE} return state;`);
  expect(r.sel === 'N25' && r.cursorLine === r.nodeLine && r.lineVisible, 'selecting a node moves the Markdown cursor to its line and scrolls it into view', r);
  expect(r.flashed, 'the line is briefly highlighted', r);
  expect(r.focusInMap && !r.editorFocused, 'focus stays in the map', r);

  await press('ArrowDown');
  await sleep(300);
  r = await evalJs(`${SYNC_STATE} return state;`);
  expect(r.sel !== 'N25' && r.cursorLine === r.nodeLine && r.lineVisible, 'keyboard navigation in the map follows in Markdown', r);

  // A node added in the map is followed once the editor has the text.
  await press('Tab');
  await waitEditing(true);
  await typeText('Fresh child');
  await press('Enter');
  await waitEditing(false);
  r = await evalJs(`
    await H.until(() => { ${SYNC_STATE} return state.sel === 'Fresh child' && state.cursorLine === state.nodeLine; }, 6000);
    ${SYNC_STATE} return state;
  `);
  expect(r.sel === 'Fresh child' && r.cursorLine === r.nodeLine && r.lineText.includes('Fresh child'), 'a new node is followed in Markdown', r);
  expect(r.focusInMap && !r.editorFocused, 'and focus is still in the map', r);
});

// Real mouse clicks: left click, the same node again, right click.
scenario('sync-map-click', async () => {
  const p = syncNote('syncclick');
  await syncOpen(p);
  await syncClickNode('N2');
  await sleep(300);

  await syncClickNode('N12');
  let r = await evalJs(`
    const flashed = await H.until(() => window.__mdE2e.md.view.editor.cm.contentDOM.querySelector('.mapdown-sync-line'), 1500);
    await H.wait(200);
    ${SYNC_STATE} return { ...state, flashed };`);
  expect(r.sel === 'N12' && r.cursorLine === r.nodeLine && r.lineVisible, 'clicking a node moves the Markdown cursor to its line', r);
  expect(r.flashed, "the clicked node's line is highlighted", r);

  // Clicking the node that is already selected does not sync again: the
  // highlight does not come back and the cursor stays where it was put.
  r = await evalJs(`
    const e = window.__mdE2e.md.view.editor;
    await H.until(() => !e.cm.contentDOM.querySelector('.mapdown-sync-line'), 4000);
    e.setCursor({ line: e.lineCount() - 1, ch: 0 });
    await H.wait(200);
    return { line: e.getCursor().line };`);
  const parked = r.line;
  await syncClickNode('N12');
  r = await evalJs(`await H.wait(400); ${SYNC_STATE} return state;`);
  expect(r.sel === 'N12' && !r.flashed && r.cursorLine === parked, 'clicking the selected node again does not sync again', { ...r, parked });

  await syncClickNode('N20', { button: 'right' });
  r = await evalJs(`await H.wait(300); ${SYNC_STATE} return { ...state, menu: H.menuItems() };`);
  expect(r.sel === 'N20' && r.menu.length > 0 && r.cursorLine === r.nodeLine, 'right-clicking a node selects it and syncs', r);
  await press('Escape');
});

scenario('sync-map-to-text-modes', async () => {
  const p = syncNote('syncmodes');
  await syncOpen(p);

  // Reading mode: scroll to the line.
  await evalJs(`
    const { md } = window.__mdE2e;
    await md.setViewState({ type: 'markdown', state: { ...md.view.getState(), mode: 'preview' } });
    await H.wait(800);
  `);
  await syncClickNode('N15');
  await sleep(800);
  let r = await evalJs(`
    const md = window.__mdE2e.md.view;
    // The reading view reports no scroll until it has rendered.
    for (let i = 0; i < 20 && md.currentMode.getScroll() == null; i++) await H.wait(100);
    const id = H.api().selection()[0];
    return { mode: md.getMode(), scroll: md.currentMode.getScroll(), nodeLine: H.api().nodeLine(id), sel: H.selTexts()[0] };
  `);
  expect(r.sel === 'N15' && r.mode === 'preview' && Math.abs(r.scroll - r.nodeLine) <= 3, 'reading mode scrolls to the node line', r);

  // Turned off: nothing moves.
  await evalJs(`
    const { md } = window.__mdE2e;
    await md.setViewState({ type: 'markdown', state: { ...md.view.getState(), mode: 'source' } });
    await H.wait(800);
    const e = md.view.editor;
    e.setCursor({ line: e.lineCount() - 1, ch: 0 });
    await H.wait(300);
    app.commands.executeCommandById('mapdown:toggle-selection-sync');
    await H.wait(300);
  `);
  try {
    const before = await evalJs(`return window.__mdE2e.md.view.editor.getCursor().line;`);
    await syncClickNode('N10');
    await sleep(500);
    r = await evalJs(`${SYNC_STATE} return state;`);
    expect(r.sel === 'N10' && r.cursorLine === before && !r.flashed, 'with sync turned off the Markdown cursor stays put', { before, ...r });
  } finally {
    await evalJs(`
      const plugin = app.plugins.plugins.mapdown;
      if (!plugin.settings.syncSelection) app.commands.executeCommandById('mapdown:toggle-selection-sync');
      await H.wait(300);
    `);
  }
});

scenario('sync-text-to-map', async () => {
  const body = '# Root\n\n' +
    Array.from({ length: 12 }, (_, i) => `## N${i + 1}\n\nParagraph ${i + 1}\n`).join('\n') +
    '\n## Folded ^f1\n\n### Hidden\n';
  const p = writeNote('synctext', body, '{"version":2,"collapsed":["f1"]}');
  await syncOpen(p);
  const STATE = `${SYNC_STATE} return { ...state, visible: state.sel !== null && H.inView(state.sel) };`;

  await syncCursorTo('## N9', 2);
  let r = await evalJs(STATE);
  expect(r.sel === 'N9' && r.visible, 'cursor on a heading selects that node and reveals it', r);
  expect(r.editorFocused && !r.focusInMap, 'focus stays in the editor', r);
  expect(r.cursor.ch === 2 && !r.flashed, 'map selection does not echo back and move the cursor', r);

  await syncCursorTo('Paragraph 4', 5);
  r = await evalJs(STATE);
  expect(r.sel === 'Paragraph 4', 'a paragraph line selects its own node', r);

  await syncCursorTo('## N7', 0);
  for (let i = 0; i < 4; i++) await press('ArrowDown');
  await sleep(300);
  r = await evalJs(STATE);
  expect(r.sel === 'N8' && r.editorFocused, 'arrow keys in the editor move the map selection', r);

  await syncCursorTo('### Hidden');
  r = await evalJs(`${SYNC_STATE} return { ...state, foldedCollapsed: H.collapsed('Folded') };`);
  expect(r.sel === 'Folded' && r.foldedCollapsed && !r.texts.includes('Hidden'), 'a hidden node resolves to its visible ancestor without expanding it', r);

  await evalJs(`window.__mdE2e.md.view.editor.setCursor({ line: 2, ch: 0 }); await H.wait(400);`);
  r = await evalJs(STATE);
  expect(r.sel === 'Folded', 'frontmatter lines leave the selection unchanged', r);
});

scenario('sync-typing-keeps-selection', async () => {
  const p = syncNote('synctyping');
  await syncOpen(p);
  await syncCursorTo('## N5', 5);
  let r = await evalJs(`${SYNC_STATE} return state;`);
  expect(r.sel === 'N5', 'cursor on N5 selects it', r);
  const startLine = r.cursorLine;

  // Type a character at a time; the cursor must never be moved by the sync.
  const samples = [];
  for (const ch of ' edit') {
    await typeText(ch);
    await sleep(250);
    samples.push(await evalJs(`${SYNC_STATE} return { sel: state.sel, cursor: state.cursor, editorFocused: state.editorFocused };`));
  }
  expect(samples.every((s) => s.cursor.line === startLine && s.editorFocused), 'typing keeps the cursor on its line and focus in the editor', samples);
  await evalJs(`await H.until(() => { ${SYNC_STATE} return state.sel === 'N5 edit'; }, 6000); await H.wait(200);`);
  r = await evalJs(`${SYNC_STATE} return state;`);
  expect(r.sel === 'N5 edit' && r.cursor.ch === 10, 'after the map updates it still selects the node being typed', r);

  // A heading typed on a new line becomes the selected node.
  await press('Enter');
  await press('Enter');
  await typeText('## Fresh');
  await evalJs(`await H.until(() => { ${SYNC_STATE} return state.sel === 'Fresh'; }, 6000); await H.wait(200);`);
  r = await evalJs(`${SYNC_STATE} return state;`);
  expect(r.sel === 'Fresh' && r.editorFocused, 'a newly typed heading is selected in the map', r);
});

scenario('sync-no-ping-pong', async () => {
  const p = syncNote('syncpingpong');
  await syncOpen(p);
  // Select in the map, then move to the editor right away.
  await syncClickNode('N20');
  await evalJs(`
    const { md } = window.__mdE2e;
    app.workspace.setActiveLeaf(md, { focus: true });
    const e = md.view.editor;
    e.focus();
    const line = e.getValue().split('\\n').findIndex((l) => l === 'Paragraph 3');
    e.setCursor({ line, ch: 4 });
  `);
  const samples = [];
  for (let i = 0; i < 5; i++) {
    await sleep(300);
    samples.push(await evalJs(`${SYNC_STATE} return { sel: state.sel, lineText: state.lineText, ch: state.cursor.ch, editorFocused: state.editorFocused };`));
  }
  expect(samples.every((s) => s.lineText === 'Paragraph 3' && s.ch === 4 && s.editorFocused),
    'a map selection never pulls the cursor away from where the user clicked', samples);
  expect(samples.every((s) => s.sel === 'Paragraph 3'), 'the map settles on the node at the cursor and stays there', samples);
});

scenario('sync-focus-and-toggle', async () => {
  const p = writeNote('syncfocus', '# Root\n\n## A\n\n### A1\n\n### A2\n\n## B\n\n### B1\n');
  await syncOpen(p);

  // Focus mode: lines outside the focused branch leave the map alone.
  await syncClickNode('A');
  await press('KeyF');
  let r = await evalJs(`${SYNC_STATE} return state;`);
  expect(JSON.stringify(r.texts) === JSON.stringify(['A', 'A1', 'A2']), 'F enters focus mode on A', r.texts);
  await syncCursorTo('### A2');
  r = await evalJs(`${SYNC_STATE} return state;`);
  expect(r.sel === 'A2' && r.texts[0] === 'A', 'a line inside the focused branch selects its node', r);
  await syncCursorTo('### B1');
  r = await evalJs(`${SYNC_STATE} return state;`);
  expect(r.sel === 'A2' && r.texts[0] === 'A' && r.texts.length === 3, 'a line outside the focused branch keeps the selection and focus mode', r);
  // Leave focus mode: select the focused node and press F again.
  await syncClickNode('A');
  await press('KeyF');
  r = await evalJs(`return H.texts();`);
  expect(r.includes('B1'), 'F on the focused node leaves focus mode', r);

  // The command turns sync off; both directions are then independent.
  const command = async () => evalJs(`
    app.commands.executeCommandById('mapdown:toggle-selection-sync');
    await H.wait(300);
    return (await app.plugins.plugins.mapdown.loadData())?.syncSelection;
  `);
  try {
    r = await command();
    expect(r === false, 'the command turns sync off and saves it', r);
    await syncCursorTo('### B1');
    r = await evalJs(`${SYNC_STATE} return state;`);
    expect(r.sel !== 'B1', 'with sync off the Markdown cursor does not select in the map', r);
    await syncClickNode('A1');
    await sleep(500);
    r = await evalJs(`${SYNC_STATE} return state;`);
    expect(r.sel === 'A1' && r.lineText === '### B1', 'with sync off map selection does not move the Markdown cursor', r);
    r = await command();
    expect(r === true, 'running the command again turns sync back on', r);
    await syncCursorTo('## B');
    r = await evalJs(`${SYNC_STATE} return state;`);
    expect(r.sel === 'B', 'sync works again after turning it back on', r);
  } finally {
    await evalJs(`
      const plugin = app.plugins.plugins.mapdown;
      if (!plugin.settings.syncSelection) app.commands.executeCommandById('mapdown:toggle-selection-sync');
      await H.wait(300);
    `);
  }
});

scenario('patch-in-place', async () => {
  const p = writeNote('patch', '# Root\n\n## A\n\n- a1\n- a2\n\n## B ^b1\n\n- b1 child\n\n## C\n\n- c1\n', '{"version":2,"collapsed":["b1"]}');
  await syncOpen(p);
  // Mark every node element so a re-created element is detectable.
  await evalJs(`for (const t of H.texts()) H.el(t).__mdKeep = t;`);
  const STATE = `
    ${SYNC_CHECK_LINES}
    const e = window.__mdE2e.md.view.editor;
    const texts = H.texts();
    const nodeEls = Array.from(H.root().querySelectorAll('.mapdown-node'));
    return {
      texts,
      kept: texts.filter((t) => H.el(t) && H.el(t).__mdKeep),
      sel: H.selTexts()[0],
      editorFocused: e.hasFocus(),
      bad: checkLines(e.getValue()),
      bCollapsed: H.collapsed('B') && !texts.includes('b1 child'),
      edges: H.root().querySelectorAll('.mapdown-edges path').length,
      c1Element: nodeEls.some((el) => el.textContent.trim() === 'c1'),
      newMarked: !!(H.el('a3 new') && H.el('a3 new').__mdKeep),
    };
  `;
  await syncCursorTo('- a1', 4);
  await typeText(' typed');
  await sleep(1000);
  let r = await evalJs(STATE);
  expect(['Root', 'A', 'a1 typed', 'a2', 'B', 'C', 'c1'].every((t) => r.kept.includes(t)), 'typing updates the map in place: every node keeps its element, including the edited one', r);
  expect(r.sel === 'a1 typed' && r.editorFocused, 'the edited node stays selected and focus stays in the editor', r);

  // Insert a bullet and delete a heading's child through the editor.
  await evalJs(`
    const e = window.__mdE2e.md.view.editor;
    const a2 = e.getValue().split('\\n').findIndex((l) => l === '- a2');
    e.replaceRange('\\n- a3 new', { line: a2, ch: 4 });
    await H.wait(600);
    const c1 = e.getValue().split('\\n').findIndex((l) => l === '- c1');
    e.replaceRange('', { line: c1 - 1, ch: e.getLine(c1 - 1).length }, { line: c1, ch: 4 });
    await H.wait(600);
  `);
  r = await evalJs(STATE);
  expect(r.kept.includes('a2') && r.texts.includes('a3 new') && !r.newMarked && !r.texts.includes('c1') && !r.c1Element,
    'inserted and deleted lines add and remove only those nodes', r);
  expect(r.bad.length === 0, 'every node maps to its line after the edits', r);
  expect(r.bCollapsed, 'a collapsed branch stays collapsed', r);
  expect(r.texts.length === 7 && r.edges === r.texts.length - 1, 'the tree and its edges match the text', r);

  // Changing the state metadata in the text: the collapse state follows it.
  await evalJs(`
    const e = window.__mdE2e.md.view.editor;
    e.setValue(e.getValue().replace('"collapsed":["b1"]', '"collapsed":[]'));
    await H.wait(800);
  `);
  r = await evalJs(`return { bExpanded: !H.collapsed('B') && H.texts().includes('b1 child'), aKept: !!H.el('A')?.__mdKeep };`);
  expect(r.bExpanded, 'a change of mindmark-state in the text expands the branch', r);
});

// Composition through CDP's IME API: Enter while a candidate is open belongs
// to the input method, not to the map or the search box.
async function composeThenCommit(composing, committed) {
  await ensureForeground();
  await cdp('Input.imeSetComposition', { text: composing, selectionStart: composing.length, selectionEnd: composing.length });
  await sleep(150);
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'Enter', windowsVirtualKeyCode: 229 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(200);
  const during = await evalJs(`const a = document.activeElement;
    return { editing: H.api().isEditing(), searchFocused: !!a && a.classList.contains('mapdown-search-input'), texts: H.texts() };`);
  await cdp('Input.insertText', { text: committed });
  await sleep(200);
  return during;
}

scenario('ime-composition', async () => {
  const p = writeNote('ime', '# Root\n\n## Alpha\n\n## 你好 node\n\n## Beta\n');
  await open(p);
  await clickNode('Alpha');
  await press('Space');
  await waitEditing(true);
  const during = await composeThenCommit('ni', '你');
  expect(during.editing && during.texts.length === 4, 'Enter during composition neither commits the node nor adds one', during);
  let r = await evalJs(`return { editing: H.api().isEditing(), text: H.editorText(), texts: H.texts() };`);
  expect(r.editing && r.text.endsWith('你') && r.texts.length === 4, 'the composed text lands in the node and editing continues', r);
  await press('Enter');
  await waitEditing(false);
  r = await texts();
  expect(r.includes('Alpha你'), 'Enter after composition commits the node', r);

  // Search box: Enter while composing must not jump to a result.
  await clickNode('Beta');
  await searchOpen();
  const searchDuring = await composeThenCommit('ni', '你');
  await sleep(300);
  let s = await searchState();
  expect(searchDuring.searchFocused && !searchDuring.editing && s.inputFocused, 'focus stays in the search box while composing', { searchDuring, s });
  expect(s.query === '你' && s.current === null && s.count === '0 / 2', 'Enter during composition does not go to a result', s);
  await press('Enter');
  s = await searchState();
  expect(s.current !== null && s.current.includes('你') && s.count === '1 / 2', 'Enter after composition goes to a match', s);
  await press('Escape');
  s = await searchState();
  expect(!s.open, 'Escape closes the search bar', s);
});

// A note of `nodes` nodes (## / ### / - levels), plain or rich text (bold, links, code).
function benchBody(nodes, rich) {
  const fmt = (i) => rich ? `Item ${i} **bold** [[Note ${i % 7}]] \`code ${i}\`` : `Item ${i} plain text`;
  let body = '# Root\n\n', n = 1;
  for (let a = 1; n < nodes; a++) {
    body += `## ${fmt(n++)}\n\n`;
    for (let b = 1; b <= 6 && n < nodes; b++) {
      body += `### ${fmt(n++)}\n\n`;
      for (let c = 1; c <= 3 && n < nodes; c++) body += `- ${fmt(n++)}\n`;
      body += '\n';
    }
  }
  return body;
}

// Phase 5 performance budgets (plan §4). Every row is measured 5 times; the
// table shows median and max, and each budget is checked at the end so one
// run reports every row that misses. Times are taken inside the page
// (performance.now), so the Obsidian CLI round trip is not part of them.
const P5_RUNS = 5;

function p5Stats(xs) {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return { median: null, max: null, n: 0 };
  return { median: s[Math.floor(s.length / 2)], max: s[s.length - 1], n: s.length };
}

const p5Round = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);

// Opens `p` in a new tab and times openFile → the first frame in which the
// primary node (the root, selected on open) is laid out on screen. With
// `settleMs` the long-task observer keeps running that long after it.
async function p5OpenOnce(p, settleMs = 300) {
  return evalJs(`
    await H.indexed('${p}');
    const tasks = [];
    let po = null;
    try {
      po = new PerformanceObserver((l) => l.getEntries().forEach((e) => tasks.push(Math.round(e.duration))));
      po.observe({ type: 'longtask' });
    } catch (e) { po = null; }
    const leaf = app.workspace.getLeaf('tab');
    app.workspace.setActiveLeaf(leaf, { focus: true });
    const t0 = performance.now();
    const opening = leaf.openFile(H.file('${p}'));
    let ms = null;
    while (performance.now() - t0 < 30000) {
      await new Promise((r) => requestAnimationFrame(r));
      const v = leaf.view;
      if (!v || v.getViewType() !== VT) continue;
      const el = v.contentEl.querySelector('.mapdown-node.is-primary');
      if (el && el.getBoundingClientRect().width > 0) { ms = performance.now() - t0; break; }
    }
    await opening;
    await H.wait(${settleMs});
    if (po) po.disconnect();
    const dom = leaf.view.contentEl ? leaf.view.contentEl.querySelectorAll('.mapdown-node').length : 0;
    leaf.detach();
    await H.wait(400);
    return { ms, longTasks: tasks, maxLong: tasks.length ? Math.max(...tasks) : 0, observer: !!po, dom };
  `, 90000);
}

// Times one CDP key press inside the page: from the keydown (seen first, in
// the capture phase on window) to two animation frames after it.
async function p5TimedKey(code, modifiers = 0) {
  await evalJs(`
    window.__p5k = null;
    const h = (e) => {
      if (e.code !== ${JSON.stringify(code)}) return;
      window.removeEventListener('keydown', h, true);
      const t0 = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => { window.__p5k = performance.now() - t0; }));
    };
    window.addEventListener('keydown', h, true);
  `);
  await press(code, modifiers);
  return evalJs('await H.until(() => window.__p5k !== null, 3000); const ms = window.__p5k; window.__p5k = null; return ms;');
}

// Selects a first-level node (a "## Item" heading of benchBody, which has
// children) with the keyboard; returns its id.
async function p5SelectFirstLevel() {
  for (const key of ['ArrowRight', 'ArrowLeft']) {
    await press('Home');
    await press(key);
    const r = await evalJs(`const id = H.api().selection()[0]; const root = H.visible()[0].id;
      return { id, root, text: (H.visible().find((n) => n.id === id) || {}).text };`);
    if (r.id && r.id !== r.root) return r;
  }
  throw new AssertionFailure('could not select a first-level node with Home and an arrow key');
}

const p5Detach = (p) => evalJs(`
  for (const type of ['markdown', VT]) app.workspace.getLeavesOfType(type).filter((l) => l.view.file?.path === '${p}').forEach((l) => l.detach());
  await H.wait(400);
`);

scenario('perf-benchmark', async () => {
  const rows = [];
  const failures = [];
  // `limit` checks the median (latency rows), `maxLimit` every run ("no long task" rows); `extra` is a check over all runs.
  const row = (metric, unit, values, { limit = null, maxLimit = null, extra = null, budget }) => {
    const s = p5Stats(values);
    const missing = s.n < values.length || s.n === 0;
    const bad = [];
    if (missing) bad.push(`only ${s.n}/${values.length} runs measured`);
    if (limit !== null && s.median !== null && s.median > limit) bad.push(`median ${p5Round(s.median)} ${unit} > ${limit}`);
    if (maxLimit !== null && s.max !== null && s.max > maxLimit) bad.push(`max ${p5Round(s.max)} ${unit} > ${maxLimit}`);
    if (extra) bad.push(...extra);
    rows.push({ metric, budget, median: p5Round(s.median), max: p5Round(s.max), unit, result: bad.length ? 'FAIL' : 'ok' });
    if (bad.length) failures.push(`${metric}: ${bad.join('; ')}`);
  };

  // 1. Open 1,000 nodes, plain and rich; 5,000 nodes with long tasks.
  for (const [size, rich, limit] of [[1000, false, 400], [1000, true, 700], [5000, false, 1500]]) {
    const kind = rich ? 'rich' : 'plain';
    const p = writeNote(`p5_open_${size}_${kind}`, benchBody(size, rich));
    const runs = [];
    for (let run = 0; run < P5_RUNS; run++) runs.push(await p5OpenOnce(p, size === 5000 ? 1000 : 300));
    if (size === 5000) {
      const extra = [];
      if (!runs.every((r) => r.observer)) extra.push('PerformanceObserver longtask is not available');
      row(`open ${size} ${kind}`, 'ms', runs.map((r) => r.ms), { limit, budget: '≤1500 ms median', extra });
      row(`open ${size} longest task`, 'ms', runs.map((r) => r.maxLong), { maxLimit: 200, budget: '≤200 ms' });
      note(`open 5000: DOM nodes ${runs.map((r) => r.dom).join('/')}, long tasks per run ${runs.map((r) => r.longTasks.length).join('/')}`);
    } else {
      row(`open ${size} ${kind}`, 'ms', runs.map((r) => r.ms), { limit, budget: `≤${limit} ms median` });
    }
    await p5Detach(p);
  }

  // 2. One character typed in the Markdown editor of a split, 1,000 nodes.
  // Plugin time is the 'mapdown:text-update' measure the view records around
  // the re-parse and render of typed text (src/view/MapView.ts).
  {
    const p = writeNote('p5_type_1000', benchBody(1000, false));
    await openMapAndMarkdown(p);
    await ensureForeground();
    await evalJs(`
      const { md } = window.__mdE2e;
      app.workspace.setActiveLeaf(md, { focus: true });
      const e = md.view.editor;
      e.focus();
      const line = e.getValue().split('\\n').findIndex((l) => l.includes('Item 500 '));
      if (line < 0) throw new Error('no Item 500 line');
      e.setCursor({ line, ch: e.getLine(line).length });
      await H.wait(400);
    `);
    const runs = [];
    for (let run = 0; run < P5_RUNS; run++) {
      await evalJs(`performance.clearMeasures('mapdown:text-update');`);
      await cdp('Input.insertText', { text: 'x' });
      runs.push(await evalJs(`
        await H.until(() => performance.getEntriesByName('mapdown:text-update', 'measure').length > 0, 3000);
        const m = performance.getEntriesByName('mapdown:text-update', 'measure').pop();
        await H.wait(200);
        return m ? m.duration : null;
      `));
    }
    const typed = await evalJs(`return window.__mdE2e.md.view.editor.getValue().includes('Item 500 plain textxxxxx');`);
    row('type 1 char in Markdown (plugin)', 'ms', runs, { limit: 16, budget: '≤16 ms median', extra: typed ? [] : ['the typed text did not reach the editor'] });
    await p5Detach(p);
  }

  // 3. Edit, collapse and undo one node with CDP keys, 1,000 nodes.
  {
    const p = writeNote('p5_keys_1000', benchBody(1000, false));
    await open(p);
    const target = await p5SelectFirstLevel();
    const edit = [], collapse = [], undo = [];
    const problems = [];
    for (let run = 0; run < P5_RUNS; run++) {
      await press('Space');
      await waitEditing(true);
      await typeText('x');
      edit.push(await p5TimedKey('Enter'));
      await waitEditing(false);
      collapse.push(await p5TimedKey('Space', MOD | SHIFT));
      const c = await evalJs(`const e = H.root().querySelector('.mapdown-node[data-node-id="' + CSS.escape(${JSON.stringify(target.id)}) + '"]'); return !!e && e.classList.contains('is-collapsed');`);
      if (!c) problems.push(`run ${run + 1}: Mod+Shift+Space did not collapse the node`);
      undo.push(await p5TimedKey('KeyZ', MOD));
      const u = await evalJs(`const e = H.root().querySelector('.mapdown-node[data-node-id="' + CSS.escape(${JSON.stringify(target.id)}) + '"]'); return !!e && !e.classList.contains('is-collapsed');`);
      if (!u) problems.push(`run ${run + 1}: Mod+Z did not undo the collapse`);
    }
    const text = await evalJs(`return (H.visible().find((n) => n.id === ${JSON.stringify(target.id)}) || {}).text;`);
    if (text !== `${target.text}${'x'.repeat(P5_RUNS)}`) problems.push(`node text is ${JSON.stringify(text)}, expected ${P5_RUNS} x appended`);
    row('edit node (Enter commit)', 'ms', edit, { limit: 50, budget: '≤50 ms median', extra: problems.filter((x) => /text/.test(x)) });
    row('collapse node', 'ms', collapse, { limit: 50, budget: '≤50 ms median', extra: problems.filter((x) => /collapse the node/.test(x)) });
    row('undo', 'ms', undo, { limit: 50, budget: '≤50 ms median', extra: problems.filter((x) => /undo/.test(x)) });
    await flush();

    // 4. Pan (middle-button drag and wheel), zoom (Mod+wheel) and typing in a
    // node for about 2 s; frame intervals and long tasks recorded in the page.
    const frameRuns = [];
    for (let run = 0; run < P5_RUNS; run++) {
      await ensureForeground();
      const pt = await evalJs(`const c = H.root().getBoundingClientRect(); return H.emptyPoint() || { x: Math.round(c.left + c.width / 2), y: Math.round(c.top + c.height / 2) };`);
      await evalJs(`
        const rec = window.__p5f = { intervals: [], long: [], stop: false, done: false };
        let po = null;
        try { po = new PerformanceObserver((l) => l.getEntries().forEach((e) => rec.long.push(Math.round(e.duration)))); po.observe({ type: 'longtask' }); } catch (e) {}
        rec.observer = !!po;
        let last = null;
        const t0 = performance.now();
        const tick = (t) => {
          if (last !== null) rec.intervals.push(t - last);
          last = t;
          if (!rec.stop && t - t0 < 15000) requestAnimationFrame(tick);
          else { if (po) po.disconnect(); rec.done = true; }
        };
        requestAnimationFrame(tick);
      `);
      const started = Date.now();
      // Pan: middle-button drag on the background.
      await mouse('mouseMoved', pt.x, pt.y);
      await mouse('mousePressed', pt.x, pt.y, { button: 'middle' });
      for (let i = 1; Date.now() - started < 700 && i < 200; i++) {
        await mouse('mouseMoved', pt.x + Math.round(80 * Math.sin(i / 3)), pt.y + Math.round(60 * Math.cos(i / 3)), { button: 'middle' });
      }
      await mouse('mouseReleased', pt.x, pt.y, { button: 'middle' });
      // Pan: a smooth wheel gesture (plain wheel pans, spec 4.1).
      try {
        await cdp('Input.synthesizeScrollGesture', { x: pt.x, y: pt.y, yDistance: -400, xDistance: 0, speed: 800, gestureSourceType: 'mouse' });
      } catch (e) {
        if (run === 0) note(`Input.synthesizeScrollGesture failed, wheel gesture skipped: ${e.message.split('\n')[0]}`);
      }
      // Zoom: Mod+wheel, in and out.
      const zoomStart = Date.now();
      for (let i = 0; Date.now() - zoomStart < 700 && i < 200; i++) {
        await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pt.x, y: pt.y, deltaX: 0, deltaY: i % 6 < 3 ? -40 : 40, modifiers: MOD });
      }
      // Typing in a node.
      await press('Space');
      await waitEditing(true);
      for (let i = 0; i < 3; i++) await cdp('Input.insertText', { text: 'y' });
      await press('Escape');
      await waitEditing(false);
      const r = await evalJs(`
        window.__p5f.stop = true;
        await H.until(() => window.__p5f.done, 2000);
        const rec = window.__p5f;
        const s = [...rec.intervals].sort((a, b) => a - b);
        return { frames: s.length, p95: s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] : null,
          maxLong: rec.long.length ? Math.max(...rec.long) : 0, longCount: rec.long.length, observer: rec.observer };
      `);
      r.seconds = (Date.now() - started) / 1000;
      frameRuns.push(r);
    }
    const extra = [];
    if (!frameRuns.every((r) => r.observer)) extra.push('PerformanceObserver longtask is not available');
    row('pan/zoom/type: 95th pct frame interval', 'ms', frameRuns.map((r) => r.p95), { maxLimit: 20, budget: '95% of frames ≤20 ms', extra });
    row('pan/zoom/type: longest task', 'ms', frameRuns.map((r) => r.maxLong), { maxLimit: 50, budget: 'no long task >50 ms' });
    note(`pan/zoom/type: ${frameRuns.map((r) => `${r.frames} frames in ${r.seconds.toFixed(1)} s`).join(', ')}`);

    // 5. Search one character, 1,000 nodes: keystroke → count and highlight
    // updated. The search refreshes 120 ms after input (spec 5.4); that
    // fixed delay is subtracted.
    await searchOpen();
    const searchRuns = [];
    const searchProblems = [];
    for (let run = 0; run < P5_RUNS; run++) {
      await evalJs(`
        const bar = H.root().querySelector('.mapdown-search');
        const input = bar.querySelector('.mapdown-search-input');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await H.wait(400);
        input.focus();
        const count = bar.querySelector('.mapdown-search-count');
        const before = count.textContent;
        window.__p5s = null;
        const root = H.root();
        input.addEventListener('input', () => {
          const t0 = performance.now();
          const mo = new MutationObserver(() => {
            if (count.textContent === before || !root.querySelector('.mapdown-node.is-search-match')) return;
            mo.disconnect();
            window.__p5s = { ms: performance.now() - t0, count: count.textContent.trim() };
          });
          mo.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
          setTimeout(() => mo.disconnect(), 3000);
        }, { once: true });
      `);
      await cdp('Input.insertText', { text: 'e' });
      const r = await evalJs('await H.until(() => window.__p5s !== null, 3000); return window.__p5s;');
      if (!r) searchProblems.push(`run ${run + 1}: count and highlight never updated`);
      searchRuns.push(r ? Math.max(0, r.ms - 120) : null);
      if (run === 0 && r) note(`search "e": ${r.count}, raw ${Math.round(r.ms)} ms including the 120 ms refresh delay`);
    }
    row('search 1 char (minus 120 ms delay)', 'ms', searchRuns, { limit: 50, budget: '≤50 ms median', extra: searchProblems });
    await press('Escape');
    await p5Detach(p);
  }

  console.log(`      perf budgets (plan §4), median and max over ${P5_RUNS} runs`);
  console.table(rows);
  for (const f of failures) console.log(`      FAIL ${f}`);
  expect(failures.length === 0, `${failures.length} performance budget(s) missed`, failures);
}, { slow: true });

scenario('popout-window', async () => {
  // The map works in a popout window: pointer events, keys (Scope), editing and
  // the link suggestions all use that window's own document. Everything is
  // read from the popout's own DOM, not from the main window's.
  const p = writeNote('popout', '# Root\n\n## A\n\n## B\n');
  const r = await evalJs(`
    const f = await H.indexed('${p}');
    const leaf = app.workspace.openPopoutLeaf();
    try {
      await leaf.openFile(f);
      const v = leaf.view;
      const root = v.contentEl;
      await H.until(() => root.querySelector('.mapdown-node'), 8000);
      await H.wait(400);
      const doc = root.ownerDocument, win = doc.defaultView;
      const nodeEl = (text) => Array.from(root.querySelectorAll('.mapdown-node')).find((e) => e.getAttribute('aria-label') === text);
      const mkPointer = (type, el) => {
        const b = el.getBoundingClientRect();
        return new win.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: b.left + b.width / 2, clientY: b.top + b.height / 2,
          button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, pointerType: 'mouse', isPrimary: true });
      };
      // 1. A click in the popout selects the node (event targets belong to the popout's realm).
      const a = nodeEl('A');
      a.dispatchEvent(mkPointer('pointerdown', a));
      a.dispatchEvent(mkPointer('pointerup', a));
      await H.wait(200);
      const selectedByClick = nodeEl('A').classList.contains('is-primary');

      // 2. A key goes through the view's Scope in that window: Space starts editing.
      const focused = nodeEl('A');
      focused.focus();
      const key = (type) => new win.KeyboardEvent(type, { key: ' ', code: 'Space', bubbles: true, cancelable: true });
      focused.dispatchEvent(key('keydown'));
      focused.dispatchEvent(key('keyup'));
      await H.wait(200);
      const editor = root.querySelector('.mapdown-node-editor');
      const sel = win.getSelection();
      const caretAtEnd = !!editor && sel.rangeCount > 0 && sel.isCollapsed && editor.contains(sel.anchorNode) &&
        (() => { const pre = doc.createRange(); pre.selectNodeContents(editor); pre.setEnd(sel.anchorNode, sel.anchorOffset); return pre.toString().length === editor.textContent.length; })();

      // 3. Typing [[ opens the file suggestions in the popout document.
      let suggestInPopout = false, suggestInMain = false;
      if (editor) {
        editor.textContent = 'see [[';
        const range = doc.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
        editor.dispatchEvent(new win.InputEvent('input', { bubbles: true, inputType: 'insertText', data: '[' }));
        await H.wait(200);
        const box = doc.querySelector('.mapdown-file-suggest');
        suggestInPopout = !!box && box.isConnected && box.ownerDocument === doc;
        suggestInMain = !!document.querySelector('.mapdown-file-suggest');
      }
      // Escape closes the suggestions, then cancels the edit.
      const esc = (type) => new win.KeyboardEvent(type, { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
      (root.querySelector('.mapdown-node-editor') || root).dispatchEvent(esc('keydown'));
      (root.querySelector('.mapdown-node-editor') || root).dispatchEvent(esc('keyup'));
      await H.wait(200);
      (root.querySelector('.mapdown-node-editor') || root).dispatchEvent(esc('keydown'));
      await H.wait(200);
      const stillEditing = !!root.querySelector('.mapdown-node-editor');
      return { popout: win !== window, selectedByClick, editing: !!editor, caretAtEnd, suggestInPopout, suggestInMain, stillEditing };
    } finally {
      leaf.detach();
      await H.wait(300);
    }
  `);
  expect(r.popout, 'the map opened in a separate window', r);
  expect(r.selectedByClick, 'a click on a node in the popout selects it', r);
  expect(r.editing, 'a key in the popout reaches the map (Space starts editing)', r);
  expect(r.caretAtEnd, 'editing a node in a popout puts the caret at the end of that node', r);
  expect(r.suggestInPopout && !r.suggestInMain, 'link suggestions open in the popout window', r);
  expect(!r.stillEditing, 'Escape in the popout ends the edit', r);
});

// Large maps (plan 3.4, 6.3). 5,000 nodes: only nodes near the screen get DOM.
// "Item N" is the depth-first number of the node, so positions can be checked
// against it: in one column on one side, N grows with the node's y.
const largeMapCheck = `
  const root = H.root();
  const box = root.getBoundingClientRect();
  const nodes = Array.from(root.querySelectorAll('.mapdown-node')).map((e) => {
    const b = e.getBoundingClientRect();
    const m = /^Item (\\d+) /.exec(e.getAttribute('aria-label') || '');
    return { n: m ? Number(m[1]) : null, left: Math.round(b.left), top: b.top, bottom: b.bottom, right: b.right, isLeft: e.classList.contains('is-left') };
  });
  const onScreen = nodes.filter((x) => x.n !== null && x.bottom > box.top && x.top < box.bottom && x.right > box.left && x.left < box.right);
  const columns = new Map();
  for (const x of onScreen) if (!x.isLeft) columns.set(x.left, [...(columns.get(x.left) || []), x]);
  const col = [...columns.values()].sort((a, b) => b.length - a.length)[0] || [];
  col.sort((a, b) => a.top - b.top);
  let ordered = true;
  for (let i = 1; i < col.length; i++) if (col[i].n <= col[i - 1].n) ordered = false;
  const top = onScreen.filter((x) => x.top < box.top + box.height / 3).length;
  const bottom = onScreen.filter((x) => x.bottom > box.bottom - box.height / 3).length;
  return { dom: nodes.length, rendered: H.api().renderedIds().length, onScreen: onScreen.length, colLength: col.length,
    ordered, top, bottom, first: col.length ? col[0].n : null, last: col.length ? col[col.length - 1].n : null };
`;

scenario('large-map-virtualized', async () => {
  const p = writeNote('large5000', benchBody(5000, false));
  await evalJs(`
    await H.indexed('${p}');
    const leaf = app.workspace.getLeaf('tab');
    await leaf.openFile(H.file('${p}'));
    app.workspace.setActiveLeaf(leaf, { focus: true });
    if (!await H.until(() => H.root() && H.root().querySelector('.mapdown-node'), 30000)) throw new Error('map did not render');
    await H.wait(500);
    await H.frames(3);
  `, 60000);
  const first = await evalJs(largeMapCheck);
  expect(first.dom > 0 && first.dom < 5000, 'only part of the 5,000 nodes has DOM', first);
  expect(first.dom <= 1500, 'the DOM node count stays under the cap', first);
  expect(first.dom === first.rendered, 'testApi.renderedIds matches the DOM', first);
  expect(first.onScreen > 0 && first.ordered && first.top > 0 && first.bottom > 0, 'the first screen shows nodes top to bottom, in order', first);

  const c = await evalJs(`const r = H.root().getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };`);
  for (let i = 0; i < 12; i++) await wheel(c.x, c.y, 600);
  await evalJs('await H.wait(300); await H.frames(3);');
  const second = await evalJs(largeMapCheck);
  expect(second.dom > 0 && second.dom <= 1500 && second.dom < 5000, 'the DOM node count stays capped after panning', second);
  expect(second.onScreen > 0 && second.top > 0 && second.bottom > 0, 'after panning the screen is filled with nodes, not blank', second);
  expect(second.ordered, 'after panning the nodes sit in the right order', second);
  expect(second.first !== first.first, 'panning showed different nodes', { first, second });

  // The keyboard reaches a far node: it gets DOM and is brought on screen.
  await press('Home');
  for (let i = 0; i < 30; i++) await press('ArrowDown');
  const third = await evalJs(`
    const id = H.api().selection()[0];
    const el = id && H.root().querySelector('.mapdown-node[data-node-id="' + id + '"]');
    const box = H.root().getBoundingClientRect();
    const b = el && el.getBoundingClientRect();
    return { rendered: !!el, onScreen: !!b && b.bottom > box.top && b.top < box.bottom && b.right > box.left && b.left < box.right, dom: H.root().querySelectorAll('.mapdown-node').length };
  `);
  expect(third.rendered && third.onScreen && third.dom <= 1500, 'a node reached by keyboard far away is rendered and on screen', third);
});

scenario('size-estimate-settles', async () => {
  // Rich nodes (bold, links, code) start with an estimated size and get their
  // real size once rendered. The selected node (the root, on open) must not
  // move on screen while that happens (plan 3.4).
  const p = writeNote('settle', benchBody(400, true));
  const r = await evalJs(`
    await H.indexed('${p}');
    const leaf = app.workspace.getLeaf('tab');
    app.workspace.setActiveLeaf(leaf, { focus: true });
    const opened = leaf.openFile(H.file('${p}'));
    const rootOf = () => { const v = leaf.view; return v && v.contentEl && v.contentEl.querySelector && v.contentEl; };
    let first = null, drift = 0, sizes = new Set(), samples = 0, seen = 0, id = null, rich = null, sawPending = false;
    const end = Date.now() + 15000;
    let settledFrames = 0;
    while (Date.now() < end) {
      await new Promise((res) => requestAnimationFrame(res));
      const el = rootOf();
      if (!el) continue;
      // From the DOM: the test API may still point at a view another scenario closed.
      id = id || (el.querySelector('.mapdown-node.is-primary')?.getAttribute('data-node-id') ?? null);
      const node = id && el.querySelector('.mapdown-node[data-node-id="' + id + '"]');
      if (!node) continue;
      const b = node.getBoundingClientRect();
      // Sizes are watched from the first frame; position drift only after the initial centring.
      rich = rich && rich.isConnected ? rich : el.querySelector('.mapdown-node-content.is-rich');
      if (rich) sizes.add(Math.round(rich.parentElement.getBoundingClientRect().width) + 'x' + Math.round(rich.parentElement.getBoundingClientRect().height));
      const renderedAll = Array.from(el.querySelectorAll('.mapdown-node-content.is-rich')).every((c) => c.querySelector('strong, a, code'));
      if (!renderedAll) sawPending = true;
      if (++seen <= 2) continue;
      if (!first) first = { left: b.left, top: b.top };
      drift = Math.max(drift, Math.abs(b.left - first.left), Math.abs(b.top - first.top));
      samples++;
      settledFrames = renderedAll ? settledFrames + 1 : 0;
      if (settledFrames >= 20) break;
    }
    await opened;
    return { drift, samples, sawPending, sizeChanges: sizes.size, settled: settledFrames >= 20, richNodes: rootOf().querySelectorAll('.mapdown-node-content.is-rich').length };
  `, 60000);
  expect(r.richNodes > 0 && r.samples > 0, 'rich nodes were rendered', r);
  expect(r.settled, 'every rich node on screen got rendered', r);
  // Markdown can finish before the first sampled frame; only then is there no change to see.
  expect(!r.sawPending || r.sizeChanges > 1, 'a rich node changed from its estimated to its real size', r);
  expect(r.drift <= 1, 'the selected node did not move on screen while sizes settled', r);
});

// JS heap after garbage collection: CDP HeapProfiler.collectGarbage (and
// window.gc when Obsidian exposes it), then the minimum of a few samples.
async function p5Heap(samples = 5) {
  const values = [];
  for (let i = 0; i < samples; i++) {
    try { await cdpResult('HeapProfiler.collectGarbage'); } catch { /* not available: the minimum still helps */ }
    values.push(await evalJs(`
      if (typeof window.gc === 'function') window.gc();
      await H.wait(300);
      return performance.memory ? performance.memory.usedJSHeapSize : null;
    `));
  }
  const ok = values.filter((v) => typeof v === 'number');
  return ok.length ? Math.min(...ok) : null;
}

scenario('leak-loop', async () => {
  // Plan §4: open and close a map 20 times, with a few edits, collapses and a
  // search each time; the heap ends within ±5% of where it started and no
  // DOM or global listeners pile up.
  const p = writeNote('leak', '# Root\n\n## Alpha\n\n- a1\n- a2\n\n## Beta\n\n- b1\n\n## Gamma **bold** [[link]]\n');
  const cycle = async (i) => {
    await open(p);
    await clickNode('Alpha');
    await press('Space', MOD | SHIFT);
    await press('Space', MOD | SHIFT);
    await clickNode('Beta');
    const base = (await history()).undo;
    await press('Space');
    await waitEditing(true);
    await typeText(` ${i}`);
    await press('Enter');
    await waitEditing(false);
    await undoTo(base);
    await evalJs(`H.root().querySelector('.mapdown-toolbar [data-action="search"]').click(); await H.wait(200);`);
    await typeText('a');
    await press('Escape');
    await flush();
    await evalJs(`app.workspace.getLeavesOfType(VT).filter((l) => l.view.file?.path === '${p}').forEach((l) => l.detach()); await H.wait(300);`);
  };
  const snapshot = async () => {
    const heap = await p5Heap();
    const page = await evalJs(`return {
      bodyChildren: document.body.children.length,
      views: document.querySelectorAll('.mapdown-view').length,
      nodes: document.querySelectorAll('.mapdown-node').length,
      menus: document.querySelectorAll('.mapdown-node-menu').length,
    };`);
    return { ...page, heap, listeners: await globalListeners() };
  };
  // Two warm-up cycles first: lazy setup (caches, first-open work) is not a leak.
  for (let i = 0; i < 2; i++) await cycle(i);
  const before = await snapshot();
  for (let i = 2; i < 22; i++) await cycle(i);
  const after = await snapshot();
  expect(readNote(p).includes('## Beta\n') && !/## Beta \d/.test(readNote(p)), 'every edit was undone before closing', readNote(p));
  const grown = Object.keys(after.listeners).filter((k) => (after.listeners[k] || 0) > (before.listeners[k] || 0))
    .map((k) => `${k}: ${before.listeners[k] || 0} -> ${after.listeners[k]}`);
  expect(grown.length === 0, 'no global event listeners accumulate', grown);
  expect(after.bodyChildren <= before.bodyChildren && after.views <= before.views && after.nodes <= before.nodes && after.menus <= before.menus,
    'no orphaned DOM accumulates', { before, after });
  expect(before.heap !== null && after.heap !== null, 'performance.memory is available', { before: before.heap, after: after.heap });
  const change = (after.heap - before.heap) / before.heap;
  const mb = (x) => (x / 1048576).toFixed(1);
  console.log(`      heap ${mb(before.heap)} MB -> ${mb(after.heap)} MB after 20 cycles (${(change * 100).toFixed(1)}%)`);
  expect(Math.abs(change) <= 0.05, `heap returns within ±5% of the start (measured ${(change * 100).toFixed(1)}%)`,
    { beforeMB: mb(before.heap), afterMB: mb(after.heap) });
}, { slow: true });

// fixtures/compat (format contract §1, §7.4): every sample that opens as a
// map is copied into the vault byte for byte; opening and flushing without an
// edit leaves the file byte-identical, and editing one node's text changes
// only that node's line. Samples with expected-0.3.0.json open as Markdown
// and stay unchanged.
const P5_COMPAT = path.join(ROOT, 'fixtures/compat');

// The node to edit: not the root, one line of its own, its text on that line.
// Headings and list items with plain text first.
function p5CompatPick(nodes, lines) {
  const marker = /^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/;
  const usable = nodes.filter((n) => {
    if (n.line === null || !n.text || n.text.includes('\n') || n.next === n.id) return false;
    const line = (lines[n.line] || '').replace(/\r$/, '');
    return line.includes(n.text);
  });
  const plain = usable.filter((n) => marker.test(lines[n.line]) && /^[\p{L}\p{N} _.,-]+$/u.test(n.text));
  return plain[0] || usable[0] || null;
}

async function p5CompatClick(id) {
  const q = `H.root().querySelector('.mapdown-node[data-node-id="' + CSS.escape(${JSON.stringify(id)}) + '"]')`;
  const where = `const e = ${q}; if (!e) return null; const b = e.getBoundingClientRect();
    const x = Math.round(b.left + 4), y = Math.round(b.top + b.height / 2); const hit = document.elementFromPoint(x, y);
    return { x, y, ok: !!hit && e.contains(hit) };`;
  let r = await evalJs(where);
  if (!r || !r.ok) {
    await evalJs(`H.root().querySelector('.mapdown-toolbar [data-action="fit"]')?.click(); await H.wait(400);`);
    r = await evalJs(where);
  }
  if (!r || !r.ok) return false;
  await mouse('mouseMoved', r.x, r.y);
  await mouse('mousePressed', r.x, r.y);
  await mouse('mouseReleased', r.x, r.y);
  await sleep(350);
  return (await evalJs('return H.api().selection()[0] || null;')) === id;
}

scenario('compat-roundtrip', async () => {
  const samples = fs.readdirSync(P5_COMPAT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  expect(samples.length > 0, 'fixtures/compat has samples', P5_COMPAT);
  const failures = [];
  const skipped = [];
  let maps = 0;
  for (const name of samples) {
    const dir = path.join(P5_COMPAT, name);
    const input = fs.readFileSync(path.join(dir, 'input.md'));
    const p = notePath(`compat_${name}`);
    fs.writeFileSync(path.join(VAULT, p), input);
    const asMarkdown = fs.existsSync(path.join(dir, 'expected-0.3.0.json'));
    try {
      if (asMarkdown) {
        const type = await evalJs(`
          for (let i = 0; i < 50 && !H.file('${p}'); i++) await H.wait(100);
          await H.wait(1000);
          const leaf = app.workspace.getLeaf('tab');
          await leaf.openFile(H.file('${p}'));
          await H.wait(1500);
          const t = leaf.view.getViewType();
          leaf.detach();
          await H.wait(300);
          return t;
        `);
        await sleep(300);
        if (type !== 'markdown') failures.push(`${name}: opened as ${type}, expected Markdown`);
        if (!fs.readFileSync(path.join(VAULT, p)).equals(input)) failures.push(`${name}: file changed though it opens as Markdown`);
        continue;
      }
      maps++;
      await open(p);
      await flush();
      if (!fs.readFileSync(path.join(VAULT, p)).equals(input)) {
        failures.push(`${name}: open and flush without an edit changed the file`);
        continue;
      }

      const text = input.toString('utf8');
      const lines = text.split('\n');
      const nodes = await evalJs(`const api = H.api(); return api.visibleNodes().slice(1).map((n) => {
        const line = api.nodeLine(n.id);
        return { id: n.id, text: n.text, line, next: line === null ? null : api.nodeAtLine(line + 1) };
      });`);
      const pick = p5CompatPick(nodes, lines);
      if (!pick) {
        skipped.push(name);
        continue;
      }
      if (!(await p5CompatClick(pick.id))) {
        failures.push(`${name}: could not select "${pick.text}" with the mouse`);
        continue;
      }
      await press('Space');
      await waitEditing(true);
      await typeText('Z9');
      await press('Enter');
      await waitEditing(false);
      await flush();
      const after = fs.readFileSync(path.join(VAULT, p), 'utf8').split('\n');
      const changed = lines.map((l, i) => i).filter((i) => lines[i] !== after[i]);
      const old = lines[pick.line];
      // Expected: the text gets "Z9" right after it; marker, indent, number and block id stay.
      const m = /^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)?/.exec(old)[0].length;
      const at = old.indexOf(pick.text, m);
      const want = at < 0 ? null : old.slice(0, at + pick.text.length) + 'Z9' + old.slice(at + pick.text.length);
      if (after.length !== lines.length || changed.length !== 1 || changed[0] !== pick.line) {
        failures.push(`${name}: editing "${pick.text}" (line ${pick.line + 1}) changed lines ${JSON.stringify(changed.map((i) => i + 1))}` +
          `, ${lines.length} -> ${after.length} lines: ${JSON.stringify(changed.slice(0, 4).map((i) => [lines[i], after[i]]))}`);
      } else if (want !== null && after[pick.line] !== want) {
        failures.push(`${name}: line ${pick.line + 1} is ${JSON.stringify(after[pick.line])}, expected ${JSON.stringify(want)}`);
      }
    } catch (err) {
      failures.push(`${name}: ${err.message.split('\n')[0]}`);
    } finally {
      await evalJs(`for (const type of ['markdown', VT]) app.workspace.getLeavesOfType(type).filter((l) => l.view.file?.path === '${p}').forEach((l) => l.detach()); await H.wait(200);`).catch(() => {});
    }
  }
  if (skipped.length) note(`no single-line node to edit in: ${skipped.join(', ')} (no-edit check only)`);
  expect(maps >= 30, 'most samples open as maps', { maps, samples: samples.length });
  for (const f of failures) console.log(`      FAIL ${f}`);
  expect(failures.length === 0, `${failures.length} of ${samples.length} compat samples failed`, failures);
});


// ---------------------------------------------------------------------------
// Multi-select helpers (phase 3: selection, box select, drag, clipboard)

// Selection as sorted texts, the primary, and what the DOM marks.
const msSel = () => evalJs(`
  const by = new Map(H.visible().map((n) => [n.id, n.text]));
  const s = H.selTexts();
  const els = Array.from(H.root().querySelectorAll('.mapdown-node.is-selected'));
  return { sel: [...s].sort(), primary: s[0] ?? null, ringed: els.length,
    secondary: els.filter((e) => !e.classList.contains('is-primary')).map((e) => by.get(e.getAttribute('data-node-id'))).sort(),
    boxes: H.root().querySelectorAll('.mapdown-box-select').length };`);

// Tree of a note body as "Root(A(A1) B)", from the file.
function msTreeOf(md) {
  const top = { text: '', kids: [] };
  const stack = [{ depth: -1, node: top }];
  for (const it of outline(md)) {
    while (stack[stack.length - 1].depth >= it.depth) stack.pop();
    const n = { text: it.text, kids: [] };
    stack[stack.length - 1].node.kids.push(n);
    stack.push({ depth: it.depth, node: n });
  }
  const s = (n) => n.text + (n.kids.length ? '(' + n.kids.map(s).join(' ') + ')' : '');
  return top.kids.map(s).join(' ');
}
const msTree = async (p) => { await flush(); return msTreeOf(readNote(p)); };

// Left drag on empty canvas around the nodes (12 px margin), from whichever
// corner of that box is empty canvas to the opposite one.
async function msBox(nodeTexts, modifiers = 0) {
  const c = await evalJs(`
    const rs = ${JSON.stringify(nodeTexts)}.map((t) => H.rect(t));
    if (rs.some((x) => !x)) return null;
    const l = Math.min(...rs.map((x) => x.left)) - 12, t = Math.min(...rs.map((x) => x.top)) - 12;
    const r = Math.max(...rs.map((x) => x.right)) + 12, b = Math.max(...rs.map((x) => x.bottom)) + 12;
    return [[l, t, r, b], [r, t, l, b], [l, b, r, t], [r, b, l, t]].map((q) => q.map(Math.round))
      .find(([x, y]) => H.isEmptyPoint(x, y)) || null;`);
  expect(c, `an empty canvas corner to box-select ${nodeTexts.join(', ')} from`);
  const [x0, y0, x1, y1] = c;
  await mouse('mouseMoved', x0, y0, { buttons: 0 });
  await mouse('mousePressed', x0, y0, { modifiers });
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', Math.round(x0 + (x1 - x0) * i / 6), Math.round(y0 + (y1 - y0) * i / 6), { buttons: 1, modifiers });
  }
  await mouse('mouseReleased', x1, y1, { modifiers });
  await sleep(400);
}

// Drag node `from` onto `to`: the top tenth (before), bottom tenth (after) or
// centre (child). Ctrl is pressed at the release (copy). Returns the drop
// feedback seen just before the release.
async function msDrag(from, to, place, { ctrl = false } = {}) {
  await ensureHittable([from, to]);
  const a = await rectOf(from);
  const b = await rectOf(to);
  const aim = (r) => ({ x: r.x, y: Math.round(place === 'before' ? r.top + r.height * 0.1 : place === 'after' ? r.bottom - r.height * 0.1 : r.y) });
  let end = aim(b);
  await mouse('mouseMoved', a.x, a.y, { buttons: 0 });
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', Math.round(a.x + (end.x - a.x) * i / 6), Math.round(a.y + (end.y - a.y) * i / 6), { buttons: 1 });
  }
  const seen = await evalJs(`const i = H.root().querySelector('.mapdown-drop-indicator');
    const t = H.rect(${JSON.stringify(to)});
    return { indicator: i ? (['before', 'after', 'child'].find((c) => i.classList.contains('is-' + c)) || 'hidden') : null,
      ghost: !!H.root().querySelector('.mapdown-drag-ghost'),
      debug: { from: ${JSON.stringify(a)}, end: ${JSON.stringify(end)}, targetNow: t, under: (document.elementFromPoint(${end.x}, ${end.y})?.className || '').toString().slice(0, 60), pane: H.root().getBoundingClientRect().toJSON() } };`);
  if (seen.indicator === 'hidden' || seen.indicator === null) note(`msDrag ${from} -> ${to} ${place}: ${JSON.stringify(seen.debug)}`);
  delete seen.debug;
  await mouse('mouseReleased', end.x, end.y, { modifiers: ctrl ? 2 : 0 });
  await sleep(500);
  return seen;
}

const msBold = () => evalJs(`app.commands.executeCommandById("mapdown:Bold the node's text"); await H.wait(300);`);

scenario('multi-select', async () => {
  const p = writeNote('multi', '# Root\n\n## A\n\n- A1\n\n## B\n\n- B1\n\n## C\n\n## D\n');
  const ALL = 'Root,A,A1,B,B1,C,D';
  await open(p);
  await ensureForeground();
  await press('Escape');

  // Cmd/Ctrl+click adds; the last clicked node is primary, the others lighter.
  await clickNode('B');
  await clickNode('D', { modifiers: MOD });
  let r = await msSel();
  expect(r.sel.join() === 'B,D' && r.primary === 'D' && r.secondary.join() === 'B' && r.ringed === 2,
    'Cmd/Ctrl+click adds a node to the selection', r);
  await clickNode('B', { modifiers: MOD });
  r = await msSel();
  expect(r.sel.join() === 'D' && r.primary === 'D' && r.ringed === 1, 'Cmd/Ctrl+click on a selected node removes it', r);

  // Shift+click selects the sibling range; a plain click returns to one node.
  await clickNode('B');
  await clickNode('D', { modifiers: SHIFT });
  r = await msSel();
  expect(r.sel.join() === 'B,C,D' && r.primary === 'D', 'Shift+click selects the sibling range', r);
  await clickNode('C');
  r = await msSel();
  expect(r.sel.join() === 'C' && r.ringed === 1, 'a plain click inside the selection keeps only that node', r);

  // Esc clears; Cmd/Ctrl+A selects every visible node.
  await press('Escape');
  r = await msSel();
  expect(r.sel.length === 0 && r.ringed === 0, 'Esc clears the selection', r);
  await clickNode('C');
  await press('KeyA', MOD);
  r = await msSel();
  expect(r.sel.length === 7 && r.primary === 'C', 'Cmd/Ctrl+A selects every visible node', r);

  // Arrow keys move a single selection from the primary node.
  await clickNode('C');
  await clickNode('A', { modifiers: MOD });
  await press('ArrowDown');
  r = await msSel();
  expect(r.sel.join() === 'B' && r.ringed === 1, 'an arrow key collapses the selection and moves from the primary', r);

  // Deleting several nodes is one undo step.
  await clickNode('A1');
  await clickNode('C', { modifiers: MOD });
  await clickNode('D', { modifiers: MOD });
  let h0 = (await history()).undo;
  await press('Delete');
  expect((await texts()).join() === 'Root,A,B,B1' && (await history()).undo === h0 + 1, 'Delete removes every selected node in one step',
    { texts: await texts(), history: await history(), h0 });
  expect(await waitFor(async () => { await flush(); return !/## C|- A1/.test(readNote(p)); }), 'the deletion reaches the file', readNote(p));
  await press('KeyZ', MOD);
  r = await msSel();
  expect((await texts()).join() === ALL, 'one undo restores every deleted node in order', await texts());
  expect(r.sel.join() === 'A1,C,D' && r.primary === 'D', 'undo restores the selection', r);
  await press('KeyY', MOD);
  expect((await texts()).join() === 'Root,A,B,B1', 'redo deletes them again', await texts());
  await press('KeyZ', MOD);

  // A selected parent covers its selected child; the root is never deleted.
  await clickNode('A');
  await clickNode('A1', { modifiers: MOD });
  await press('Delete');
  expect((await texts()).join() === 'Root,B,B1,C,D', 'deleting a parent with its selected child', await texts());
  await press('KeyZ', MOD);
  await clickNode('C');
  await press('KeyA', MOD);
  await press('Delete');
  expect((await texts()).join() === 'Root', 'Cmd/Ctrl+A then Delete keeps only the root', await texts());
  await press('KeyZ', MOD);
  expect((await texts()).join() === ALL, 'undo brings the whole map back', await texts());

  // Formatting and collapsing apply to every selected node as one step.
  await clickNode('B');
  await clickNode('C', { modifiers: MOD });
  h0 = (await history()).undo;
  await msBold();
  await flush();
  let md = readNote(p);
  r = await msSel();
  expect(/## \*\*B\*\*/.test(md) && /## \*\*C\*\*/.test(md) && (await history()).undo === h0 + 1 && r.sel.length === 2,
    'bold applies to every selected node in one step', { md, r });
  await press('KeyZ', MOD);
  await flush();
  expect(!readNote(p).includes('**'), 'one undo removes the bold from both', readNote(p));

  await clickNode('A');
  await clickNode('B', { modifiers: MOD });
  h0 = (await history()).undo;
  await press('Space', MOD | SHIFT);
  await sleep(300);
  r = await evalJs(`return { a: H.collapsed('A'), b: H.collapsed('B'), texts: H.texts() };`);
  const sel = await msSel();
  expect(r.a && r.b && !r.texts.includes('A1') && !r.texts.includes('B1') && sel.sel.join() === 'A,B' && (await history()).undo === h0 + 1,
    'collapse applies to every selected node in one step', { r, sel });
  await press('KeyZ', MOD);
  r = await evalJs(`return { a: H.collapsed('A'), b: H.collapsed('B'), texts: H.texts() };`);
  expect(!r.a && !r.b && r.texts.join() === ALL, 'one undo opens both again', r);

  // A modifier click while editing ends the edit and selects only the clicked node.
  await clickNode('B');
  await press('Space');
  await waitEditing(true);
  await clickNode('C', { modifiers: MOD });
  r = await msSel();
  expect(!(await isEditing()) && r.sel.join() === 'C' && (await texts()).join() === ALL,
    'Cmd/Ctrl+click while editing commits the edit and selects one node', { r, texts: await texts() });
});

scenario('multi-select-move', async () => {
  const p = writeNote('multimove', '# Root\n\n## A\n\n- A1\n\n## B\n\n- B1\n\n## C\n\n## D\n');
  const BASE = 'Root(A(A1) B(B1) C D)';
  await open(p);
  await ensureForeground();

  // Copying several nodes pastes every subtree, in order, as one undo step.
  await clickNode('A');
  await clickNode('C', { modifiers: MOD });
  await press('KeyC', MOD);
  await sleep(300);
  await clickNode('B1');
  let h0 = (await history()).undo;
  await press('KeyV', MOD);
  await sleep(600);
  let tree = await msTree(p);
  expect(tree === 'Root(A(A1) B(B1(A(A1) C)) C D)' && (await history()).undo === h0 + 1, 'pasting a multiple selection inserts every subtree in one step', tree);
  await press('KeyZ', MOD);
  expect((await msTree(p)) === BASE, 'one undo removes every pasted subtree', await msTree(p));

  // Dragging a selected node drags the whole selection.
  await clickNode('C');
  await clickNode('D', { modifiers: MOD });
  h0 = (await history()).undo;
  let seen = await msDrag('C', 'A1', 'after');
  expect(seen.indicator === 'after' && seen.ghost, 'while dragging, the drop indicator shows "after" and a ghost follows the pointer', seen);
  tree = await msTree(p);
  let s = await msSel();
  expect(tree === 'Root(A(A1 C D) B(B1))' && s.sel.join() === 'C,D' && (await history()).undo === h0 + 1,
    'dropping moves every selected node after the target, in order, in one step', { tree, s });
  await press('KeyZ', MOD);
  expect((await msTree(p)) === BASE, 'one undo moves them all back', await msTree(p));

  await clickNode('A1');
  await clickNode('D', { modifiers: MOD });
  seen = await msDrag('D', 'B', 'child');
  tree = await msTree(p);
  expect(seen.indicator === 'child' && tree === 'Root(A B(B1 A1 D) C)', 'dropping onto the middle of a node makes the selection its children', { seen, tree });
  await press('KeyZ', MOD);

  await clickNode('C');
  await clickNode('D', { modifiers: MOD });
  seen = await msDrag('C', 'B1', 'before');
  tree = await msTree(p);
  expect(seen.indicator === 'before' && tree === 'Root(A(A1) B(C D B1))', 'dropping on the top quarter puts the selection before the target', { seen, tree });
  await press('KeyZ', MOD);

  await clickNode('A');
  await clickNode('B', { modifiers: MOD });
  h0 = (await history()).undo;
  await msDrag('A', 'A1', 'child');
  expect((await msTree(p)) === BASE && (await history()).undo === h0, 'dropping a selection inside itself changes nothing', await msTree(p));

  await clickNode('C');
  await clickNode('D', { modifiers: MOD });
  await msDrag('C', 'B1', 'child', { ctrl: true });
  tree = await msTree(p);
  expect(tree === 'Root(A(A1) B(B1(C D)) C D)', 'Ctrl at the drop copies every selected node', tree);
  await press('KeyZ', MOD);
  expect((await msTree(p)) === BASE, 'one undo removes the copies', await msTree(p));

  await clickNode('A');
  await msDrag('C', 'D', 'after');
  tree = await msTree(p);
  s = await msSel();
  expect(tree === 'Root(A(A1) B(B1) D C)' && !s.sel.includes('A'), 'dragging an unselected node moves it alone', { tree, s });
  await press('KeyZ', MOD);

  // Dropping near an edge of the map scrolls it.
  await press('Escape');
  const before = await rectOf('Root');
  const c = await rectOf('C');
  const edge = await evalJs(`const b = H.root().getBoundingClientRect(); return { x: Math.round(b.left + 4), y: Math.round(b.top + b.height / 2) };`);
  await mouse('mouseMoved', c.x, c.y, { buttons: 0 });
  await mouse('mousePressed', c.x, c.y);
  for (let i = 1; i <= 4; i++) {
    await mouse('mouseMoved', Math.round(c.x + (edge.x - c.x) * i / 4), Math.round(c.y + (edge.y - c.y) * i / 4), { buttons: 1 });
  }
  await sleep(700);
  const during = await rectOf('Root');
  h0 = (await history()).undo;
  await mouse('mouseReleased', edge.x, edge.y);
  await sleep(400);
  expect(during.x - before.x > 20, 'holding a dragged node at the left edge scrolls the map', { before, during });
  if ((await history()).undo > h0) await press('KeyZ', MOD);
  await evalJs(`(H.root() || document).querySelector('.mapdown-toolbar [data-action="fit"]')?.click(); await H.wait(400);`);
  expect((await msTree(p)) === BASE, 'the map is unchanged after the edge drag', await msTree(p));

  // Dragging on the canvas selects the nodes inside the box, at any zoom.
  await press('Escape');
  await msBox(['C', 'D']);
  s = await msSel();
  expect(s.sel.join() === 'C,D' && s.boxes === 0, 'dragging on the canvas selects the boxed nodes', s);
  const wide = (await rectOf('C')).width;
  for (let i = 0; i < 4; i++) await evalJs(`(H.root() || document).querySelector('.mapdown-toolbar [data-action="zoom-out"]').click();`);
  await sleep(500);
  expect((await rectOf('C')).width < wide * 0.7, 'zoomed out', { wide, now: (await rectOf('C')).width });
  await press('Escape');
  await msBox(['C', 'D']);
  s = await msSel();
  expect(s.sel.join() === 'C,D' && s.boxes === 0, 'box selection works zoomed out', s);
  await evalJs(`(H.root() || document).querySelector('.mapdown-toolbar [data-action="fit"]')?.click(); await H.wait(400);`);

  await clickNode('A1');
  await msBox(['C', 'D'], SHIFT);
  s = await msSel();
  expect(s.sel.join() === 'A1,C,D', 'Shift+drag adds the boxed nodes', s);
  await clickNode('B1');
  await msBox(['C', 'D'], MOD);
  s = await msSel();
  expect(s.sel.join() === 'B1,C,D', 'Cmd/Ctrl+drag adds the boxed nodes', s);

  // A box that only crosses the nodes selects them too: start on empty
  // canvas beside C and end in the middle of D.
  const cross = await evalJs(`
    const c = H.rect('C'), d = H.rect('D');
    const y = Math.round(c.y);
    const x = [Math.round(Math.max(c.right, d.right) + 20), Math.round(Math.min(c.left, d.left) - 20)].find((v) => H.isEmptyPoint(v, y));
    return x === undefined ? null : { x1: x, y1: y, x2: d.x, y2: d.y };`);
  expect(cross, 'found empty canvas beside C');
  await press('Escape');
  await mouse('mouseMoved', cross.x1, cross.y1, { buttons: 0 });
  await mouse('mousePressed', cross.x1, cross.y1);
  await mouse('mouseMoved', Math.round((cross.x1 + cross.x2) / 2), Math.round((cross.y1 + cross.y2) / 2), { buttons: 1 });
  await mouse('mouseMoved', cross.x2, cross.y2, { buttons: 1 });
  await mouse('mouseReleased', cross.x2, cross.y2);
  await sleep(400);
  s = await msSel();
  expect(s.sel.join() === 'C,D', 'a box crossing nodes selects them without enclosing them', s);
});

// Every op that changes content, from every way of selecting, is one undo
// step: Mod+Z restores the file exactly, Mod+Y redoes it exactly.
scenario('undo-every-destructive-op', async () => {
  // The root heading is the file name, so bolding it (select all) renames nothing.
  const name = `${PREFIX}undoevery`;
  const p = writeNote('undoevery', `# ${name}\n\n## A\n\n- A1\n\n## B\n\n- B1\n\n## C\n\n## D\n`);
  await open(p);
  await ensureForeground();
  await evalJs(`await navigator.clipboard.writeText('Pasted');`);
  await flush();
  const base = readNote(p);

  const modes = {
    'single': async (t) => { await clickNode(t[0]); },
    'mod-click': async (t) => { await clickNode(t[0]); for (const x of t.slice(1)) await clickNode(x, { modifiers: MOD }); },
    'box': async (t) => { await clickNode(t[0]); await msBox(t); },
    'select-all': async (t) => { await clickNode(t[0]); await press('KeyA', MOD); },
  };
  const ops = {
    delete: { targets: ['C', 'D'], run: async () => { await press('Delete'); } },
    move: {
      targets: ['C', 'D'],
      // Keyboard moves the primary; a drag moves the whole selection (select all includes the root, which cannot move).
      run: async (mode) => {
        if (mode === 'single' || mode === 'select-all') await press('ArrowUp', ALT | SHIFT);
        else {
          // Keep the targets away from the pane edges, where a held drag scrolls the map.
          await evalJs(`H.root().querySelector('.mapdown-toolbar [data-action="fit"]')?.click(); await H.wait(300);
            H.root().querySelector('.mapdown-toolbar [data-action="zoom-out"]')?.click(); await H.wait(400);`);
          const seen = await msDrag('C', 'A1', 'after');
          expect(seen.ghost && seen.indicator === 'after', `move via ${mode}: the drag shows a ghost and an "after" indicator`, seen);
        }
        await sleep(300);
      },
    },
    paste: { targets: ['C', 'D'], run: async () => { await press('KeyV', MOD); await sleep(600); } },
    'edit text': {
      targets: ['C', 'D'],
      run: async () => {
        await press('Space');
        await waitEditing(true);
        await evalJs('H.selectEditorText();');
        await typeText('Edited');
        await press('Enter');
        await waitEditing(false);
      },
    },
    format: { targets: ['C', 'D'], run: msBold },
    collapse: { targets: ['A', 'B'], run: async () => { await press('Space', MOD | SHIFT); await sleep(300); } },
  };

  for (const [opName, op] of Object.entries(ops)) {
    for (const [modeName, select] of Object.entries(modes)) {
      const label = `${opName} via ${modeName}`;
      expect(readNote(p) === base, `${label}: starts from the original file`, readNote(p));
      await select(op.targets);
      const s = await msSel();
      if (modeName === 'single') expect(s.sel.join() === op.targets[0], `${label}: one node selected`, { ...s, under: await evalJs(`const r = H.rect(${JSON.stringify(op.targets[0])}); const e = r && document.elementFromPoint(r.x, r.y); return { r, under: e && (e.className || e.tagName).toString(), editing: H.api().isEditing(), active: document.activeElement && document.activeElement.className };`) });
      else expect(op.targets.every((t) => s.sel.includes(t)), `${label}: ${op.targets.join(' and ')} selected`, s);
      const h0 = (await history()).undo;
      await op.run(modeName);
      await flush();
      const after = readNote(p);
      const h1 = (await history()).undo;
      expect(after !== base && h1 === h0 + 1, `${label}: changes the file as one undo step`, { h0, h1, changed: after !== base });
      await press('KeyZ', MOD);
      await flush();
      expect(readNote(p) === base, `${label}: Mod+Z restores the file`, readNote(p));
      await press('KeyY', MOD);
      await flush();
      expect(readNote(p) === after, `${label}: Mod+Y redoes it`, { want: after, got: readNote(p) });
      await press('KeyZ', MOD);
      await flush();
    }
  }
  expect(readNote(p) === base, 'the file ends as it started', readNote(p));
});

// The collapse dot and the count pill (spec 4.1): click to collapse, click
// the count to expand; neither changes the selection; each is one undo step.
const dotNode = (text) => `[...H.root().querySelectorAll('.mapdown-node')].find((n) => n.getAttribute('aria-label') === ${JSON.stringify(text)})`;
scenario('collapse-dot', async () => {
  const p = writeNote('collapsedot', '# Root\n\n## A\n\n- A1\n- A2\n\n## B\n');
  await open(p);
  await ensureForeground();
  await clickNode('B');
  const a = await rectOf('A');
  await mouse('mouseMoved', a.x, a.y, { buttons: 0 });
  await sleep(400);
  let r = await evalJs(`
    const t = ${dotNode('A')}.querySelector('.mapdown-node-toggle');
    const b = t && t.getBoundingClientRect();
    return { dot: b ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : null,
      shown: t ? getComputedStyle(t).opacity : null,
      leafDot: !!${dotNode('A1')}.querySelector('.mapdown-node-toggle'), rootDot: !!${dotNode('Root')}.querySelector('.mapdown-node-toggle') };`);
  expect(r.dot && r.shown === '1', 'hovering a node with children shows its collapse dot', r);
  expect(!r.leafDot && !r.rootDot, 'leaves and the root have no collapse dot', r);
  const h0 = (await history()).undo;
  await mouse('mouseMoved', r.dot.x, r.dot.y, { buttons: 0 });
  await mouse('mousePressed', r.dot.x, r.dot.y);
  await mouse('mouseReleased', r.dot.x, r.dot.y);
  await sleep(500);
  r = await evalJs(`const a = ${dotNode('A')}; const b = a.querySelector('.mapdown-node-badge'); const bb = b && b.getBoundingClientRect();
    return { hidden: !${dotNode('A1')}, count: b ? b.textContent : null, sel: H.selTexts(),
      pill: bb ? { x: Math.round(bb.x + bb.width / 2), y: Math.round(bb.y + bb.height / 2) } : null };`);
  expect(r.hidden && r.count === '2', 'clicking the dot collapses the node and shows the hidden count', r);
  expect(r.sel.join() === 'B' && (await history()).undo === h0 + 1, 'the selection stays and the collapse is one undo step', { ...r, h0 });
  await mouse('mouseMoved', r.pill.x, r.pill.y, { buttons: 0 });
  await mouse('mousePressed', r.pill.x, r.pill.y);
  await mouse('mouseReleased', r.pill.x, r.pill.y);
  await sleep(500);
  r = await evalJs(`return { shown: !!${dotNode('A1')}, sel: H.selTexts() };`);
  expect(r.shown && r.sel.join() === 'B' && (await history()).undo === h0 + 2, 'clicking the count expands it again', r);
  await press('KeyZ', MOD);
  await sleep(300);
  expect(await evalJs(`return !${dotNode('A1')};`), 'undo collapses it again');
});

// Focus mode keeps the subtree on its side, in its order and colour (spec 5.3).
scenario('focus-keeps-side', async () => {
  const p = writeNote('focusside', '# Root\n\n## R1\n\n## R2\n\n## L1\n\n- c1\n- c2\n- c3\n\n## L2\n');
  await open(p);
  await ensureForeground();
  const before = await evalJs(`const l = ${dotNode('L1')}; return { left: l.classList.contains('is-left'), color: l.style.getPropertyValue('--mapdown-branch-color') };`);
  expect(before.left && before.color, 'L1 starts on the left with a branch colour', before);
  await clickNode('L1');
  await press('KeyF');
  await sleep(800);
  const r = await evalJs(`
    const kids = ['c1', 'c2', 'c3'].map((t) => ${'[...H.root().querySelectorAll(".mapdown-node")]'}.find((n) => n.getAttribute('aria-label') === t));
    const l = ${dotNode('L1')};
    return { focus: !!H.root().closest('.is-focus-mode') || !!document.querySelector('.mapdown-view.is-focus-mode'),
      allLeft: kids.every((k) => k && k.classList.contains('is-left')), rootLeft: l.classList.contains('is-left'),
      leftOfFocus: kids.every((k) => k.getBoundingClientRect().right < l.getBoundingClientRect().left),
      ordered: kids[0].getBoundingClientRect().top < kids[1].getBoundingClientRect().top && kids[1].getBoundingClientRect().top < kids[2].getBoundingClientRect().top,
      colors: kids.map((k) => k.style.getPropertyValue('--mapdown-branch-color')), focusColor: l.style.getPropertyValue('--mapdown-branch-color') };`);
  expect(r.focus, 'focus mode is on', r);
  expect(r.allLeft && r.rootLeft && r.leftOfFocus && r.ordered, 'the children stay on the left, top to bottom in source order', r);
  expect(r.colors.every((c) => c === before.color) && r.focusColor === before.color, 'the branch keeps its colour', { before, ...r });
  await press('KeyF');
});

scenario('paste-outline-as-subtree', async () => {
  const p = writeNote('pasteoutline', '# Root\n\n## Dst\n\n## Other\n');
  const BASE = 'Root(Dst Other)';
  await open(p);
  await ensureForeground();
  const paste = async (text, target = 'Dst') => {
    if (text !== null) await evalJs(`await navigator.clipboard.writeText(${JSON.stringify(text)});`);
    await clickNode(target);
    const h0 = (await history()).undo;
    await press('KeyV', MOD);
    await sleep(600);
    const tree = await msTree(p);
    const steps = (await history()).undo - h0;
    const clip = await evalJs('return await navigator.clipboard.readText();');
    return { tree, steps, clip };
  };
  const undo = async (what) => {
    await press('KeyZ', MOD);
    expect((await msTree(p)) === BASE, `one undo removes ${what}`, await msTree(p));
  };

  const list = '- P1\n    - P1a\n    - P1b\n- P2\n';
  let r = await paste(list);
  expect(r.tree === 'Root(Dst(P1(P1a P1b) P2) Other)' && r.steps === 1, 'a multi-line list pastes as subtrees in one step', r);
  expect(r.clip === list, 'pasting leaves the clipboard as it was', r);
  await undo('the pasted list');

  r = await paste('# H\n\n## H1\n\n## H2\n');
  expect(r.tree === 'Root(Dst(H(H1 H2)) Other)' && r.steps === 1, 'a heading outline pastes as a subtree', r);
  await undo('the pasted headings');

  r = await paste('just one line');
  expect(r.tree === 'Root(Dst(just one line) Other)' && r.steps === 1, 'one line pastes as one child', r);
  await undo('the pasted line');

  // 0.3.0 copy format on text/plain: structure and collapse state come back.
  r = await paste(JSON.stringify({ type: 'copyNode', text: [
    { id: '1', text: 'J', pid: null, expanded: false, note: '' },
    { id: '2', text: 'J1', pid: '1', expanded: true, note: '' },
  ] }));
  const collapsed = await evalJs(`return H.collapsed('J');`);
  expect(r.tree === 'Root(Dst(J(J1)) Other)' && collapsed && r.steps === 1, 'the 0.3.0 JSON format pastes with its collapse state', { r, collapsed });
  await undo('the pasted 0.3.0 nodes');

  // Copy writes a Markdown outline and an HTML list carrying the nodes; pasting it restores the subtree.
  await paste(list);
  await clickNode('P1');
  await press('KeyC', MOD);
  await sleep(300);
  const clip = await evalJs(`
    const out = { types: [], plain: '', html: '' };
    for (const item of await navigator.clipboard.read()) {
      out.types.push(...item.types);
      if (item.types.includes('text/plain')) out.plain = await (await item.getType('text/plain')).text();
      if (item.types.includes('text/html')) out.html = await (await item.getType('text/html')).text();
    }
    return out;`);
  expect(/^[-*+] P1$/m.test(clip.plain) && /^\s+[-*+] P1b$/m.test(clip.plain), 'copy writes the subtree as a Markdown outline', clip);
  expect(clip.html.includes('data-mapdown'), 'copy also writes an HTML list with data-mapdown', clip);
  r = await paste(null, 'Other');
  expect(r.tree === 'Root(Dst(P1(P1a P1b) P2) Other(P1(P1a P1b)))' && r.steps === 1, 'pasting a copied node restores its subtree', r);
});

// ---------------------------------------------------------------------------
// XMind import. Archives are built here and handed to the page as base64.

async function xmindBase64(files) {
  const JSZip = require('jszip');
  const zip = new JSZip();
  Object.entries(files).forEach(([name, text]) => zip.file(name, text));
  return zip.generateAsync({ type: 'base64' });
}

const ZEN_SHEETS = [{
  title: 'Main',
  rootTopic: {
    id: 'r', title: 'X Root',
    children: {
      attached: [
        { id: 'a', title: 'Alpha', href: 'https://example.com', notes: { plain: { content: 'remember' } } },
        { id: 'b', title: 'Beta', branch: 'folded', children: { attached: [{ id: 'b1', title: 'Beta child' }] } },
      ],
      detached: [{ id: 'f', title: 'Floating' }],
    },
  },
  relationships: [{ id: 'rel', end1Id: 'a', end2Id: 'b' }],
}];

const LEGACY_XML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0">
<sheet id="s1"><topic id="t0"><title>Legacy Root</title><children><topics type="attached">
<topic id="t1" xlink:href="https://example.com/old"><title>Linked</title><notes><plain>Note &amp; more</plain></notes></topic>
<topic id="t2" branch="folded"><title>Folded</title><children><topics type="attached"><topic id="t3"><title>Inner</title></topic></topics></children></topic>
</topics><topics type="detached"><topic id="t4"><title>Free</title></topic></topics></children></topic><title>Sheet 1</title>
<relationships><relationship id="r1" end1="t1" end2="t2"/></relationships></sheet></xmap-content>`;

// xmind helpers. Page snippet: the vault's temp files, to see what an import created.
const XMIND_FILES = `app.vault.getFiles().filter((f) => f.basename.startsWith('${PREFIX}')).map((f) => f.path)`;
const XMIND_BYTES = (b64) => `Uint8Array.from(atob('${b64}'), (c) => c.charCodeAt(0))`;

// Page snippet: runs the import command and answers its file picker with the
// data, the way a user choosing a file would. Reports the notes it created.
function xmindCommandSnippet(b64, name, expected) {
  return `
    const before = ${XMIND_FILES};
    const proto = HTMLInputElement.prototype;
    let input = null;
    proto.click = function () { if (this.type === 'file') input = this; else HTMLElement.prototype.click.call(this); };
    try {
      app.commands.executeCommandById('mapdown:import-xmind');
      await H.until(() => input, 2000);
    } finally { delete proto.click; }
    if (!input) return { picked: false, created: [] };
    const dt = new DataTransfer();
    dt.items.add(new File([${XMIND_BYTES(b64)}], '${name}'));
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    await H.until(() => ${XMIND_FILES}.length >= before.length + ${expected}, 8000);
    await H.wait(${expected} ? 800 : 1200);
    return { picked: true, created: ${XMIND_FILES}.filter((p) => !before.includes(p)).sort() };`;
}

// Page snippet: what the active map shows once it has rendered, and whether
// saving would change the note.
const XMIND_STATE = `
  await H.until(() => H.root() && H.root().querySelector('.mapdown-node'), 8000);
  await H.wait(300);
  const leaf = app.workspace.activeLeaf;
  const file = leaf.view.file;
  const before = await app.vault.read(file);
  await H.api().flush();
  await H.wait(400);
  return {
    type: leaf.view.getViewType(), path: file.path,
    texts: H.texts(),
    collapsed: H.texts().filter((x) => H.collapsed(x)),
    unchanged: (await app.vault.read(file)) === before,
  };`;

const xmindName = (p) => p.split('/').pop();

// Opens note `p` as Markdown in a new tab, clicks the Mapdown header button and
// the dialog button `action` (convert, save-as-new, cancel); reports where it ended up.
function convertChoose(p, action) {
  return evalJs(`
    await H.until(() => H.file('${p}') && app.metadataCache.getFileCache(H.file('${p}')), 5000);
    const leaf = app.workspace.getLeaf('tab');
    await leaf.openFile(H.file('${p}'));
    app.workspace.setActiveLeaf(leaf, { focus: true });
    const header = () => leaf.view.containerEl.querySelector('.mapdown-header-action');
    if (!(await H.until(() => header() && header().offsetParent !== null, 3000))) {
      return { error: 'no Mapdown header button on the plain note', type: leaf.view.getViewType() };
    }
    header().click();
    const sel = '.mapdown-convert-modal [data-action]';
    await H.until(() => document.querySelectorAll(sel).length === 3, 3000);
    const actions = Array.from(document.querySelectorAll(sel)).map((b) => b.getAttribute('data-action')).sort();
    const button = document.querySelector('.mapdown-convert-modal [data-action="${action}"]');
    if (!button) return { error: 'no ${action} button', actions };
    button.click();
    await H.until(() => !document.querySelector('.mapdown-convert-modal'), 3000);
    if (${JSON.stringify(action)} !== 'cancel') {
      await H.until(() => app.workspace.activeLeaf.view.getViewType() === VT && H.root()?.querySelector('.mapdown-node'), 8000);
    }
    await H.wait(300);
    await H.frames(2);
    const v = app.workspace.activeLeaf.view;
    return { actions, type: v.getViewType(), path: v.file?.path, sameLeaf: app.workspace.activeLeaf === leaf };`);
}

scenario('plain-note-convert', async () => {
  // The expected bodies use the default headLevel (1); the vault may use another.
  const prevHead = await evalJs(`const s = app.plugins.plugins.mapdown.settings; const v = s.headLevel; s.headLevel = 1; return v;`);
  try {
  const p = `${INBOX}/${PREFIX}plain.md`;
  const body = '---\ntags: [demo]\n---\n\n# Plan\n\nBackground text.\nSecond line.\n\n## Goals\n\n1. First\n2. Second\n\n## Tasks\n\n- [ ] Open\n- [x] Done\n\n> Quoted\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nClosing words.\n';
  const mapHeader = '---\ntags: [demo]\nmindmap-plugin: basic\nmindmark-state: ';
  fs.writeFileSync(path.join(VAULT, p), body);

  // Cancel: nothing happens.
  let r = await convertChoose(p, 'cancel');
  expect(!r.error && JSON.stringify(r.actions) === '["cancel","convert","save-as-new"]',
    'the header button of a plain note opens the dialog with its three choices', r);
  expect(r.type === 'markdown' && r.path === p, 'cancelling keeps the note in Markdown', r);
  expect(listTempFiles().length === 1 && readNote(p) === body, 'cancelling writes nothing', listTempFiles());

  // Save as a new map: `<name> (mind map).md` (Chinese UI: `<name>（导图）.md`) in a new tab.
  r = await convertChoose(p, 'save-as-new');
  const copyNames = [`${INBOX}/${PREFIX}plain (mind map).md`, `${INBOX}/${PREFIX}plain（导图）.md`];
  expect(r.type === VIEW_TYPE && copyNames.includes(r.path) && !r.sameLeaf, 'saving as a new map opens the new note in a new tab', r);
  const copyPath = r.path;
  const copyText = readNote(copyPath);
  expect(copyText.startsWith(`${mapHeader}{"version":2,"collapsed":[]}\n---\n\n# Plan\n- `),
    'the new map keeps the other properties, adds mindmap-plugin and an empty state, and has a generated body', copyText);
  const copy = await evalJs(`
    const texts = H.texts();
    const table = texts.find((t) => t.startsWith('| A'));
    return { texts, tableRendered: !!(table && H.el(table)?.querySelector('table')) };`);
  expect(copy.texts[0] === 'Plan' && ['Background text.\nSecond line.', 'Goals', 'First', 'Second', 'Tasks', '> Quoted', 'Closing words.'].every((t) => copy.texts.includes(t)),
    'paragraphs, lists, quote and table become nodes', copy.texts);
  expect(copy.tableRendered, 'a table node renders as a table', copy);
  await flush();
  expect(readNote(copyPath) === copyText, 'the new map saves without changes');
  expect(readNote(p) === body, 'saving as a new map leaves the note unchanged');
  r = await convertChoose(p, 'save-as-new');
  expect(r.path === copyPath.replace(/\.md$/, ' 1.md'), 'a second new map gets a number instead of overwriting', r);

  // Convert in place: the note itself opens as a map; nothing is written before an edit.
  // Close the earlier tabs, so the map view is the note's only writer (no Markdown editor of it).
  const closeTabsOf = (file) => evalJs(`
    for (const type of ['markdown', VT]) app.workspace.getLeavesOfType(type).filter((l) => l.view.file?.path === '${file}').forEach((l) => l.detach());
    await H.wait(500);`);
  await closeTabsOf(p);
  r = await convertChoose(p, 'convert');
  expect(r.type === VIEW_TYPE && r.path === p && r.sameLeaf, 'converting opens the note itself as a map in its tab', r);
  const inPlace = await texts();
  expect(JSON.stringify(inPlace) === JSON.stringify(copy.texts), 'converting in place shows the same nodes', { inPlace, copy: copy.texts });
  await flush();
  expect(readNote(p) === body && safetyCopies().length === 0, 'nothing is written or backed up before an edit', safetyCopies());
  await closeTabsOf(p);
  expect(readNote(p) === body && safetyCopies().length === 0, 'closing an unedited conversion writes nothing', safetyCopies());
  r = await convertChoose(p, 'convert');
  expect(r.type === VIEW_TYPE && r.path === p, 'the note converts again after an unedited close', r);

  // The first save backs the original up next to it, says where, then writes the map format.
  await editText('Goals', 'Aims');
  await flush();
  const backups = safetyCopies();
  try {
    expect(backups.length === 1 && /^__mapdown_e2e_plain Mapdown backup \d{4}-\d\d-\d\d \d{6}\.md$/.test(path.basename(backups[0])) && path.dirname(backups[0]) === INBOX,
      'the first save writes one backup next to the note', backups);
    expect(readNote(backups[0]) === body, 'the backup holds the original text');
    const noticed = await evalJs(`return Array.from(document.querySelectorAll('.notice')).some((n) => n.textContent.includes(${JSON.stringify(path.basename(backups[0]))}));`);
    expect(noticed, 'a notice names the backup');
    let disk = readNote(p);
    expect(disk.startsWith(mapHeader) && disk.includes('\n---\n\n# Plan\n- ') && disk.includes('Aims') && !disk.includes('Goals'),
      'the note is rewritten in the map format, with the edit', disk);
    await editText('Aims', 'Targets');
    await flush();
    disk = readNote(p);
    expect(safetyCopies().length === 1 && disk.includes('Targets'), 'later saves make no second backup', safetyCopies());
    const isMap = await evalJs(`return await H.until(() => app.metadataCache.getFileCache(H.file('${p}'))?.frontmatter?.['mindmap-plugin'] === 'basic', 5000);`);
    expect(isMap, 'the converted note is a map note now');
    await open(p);
    expect((await texts()).includes('Targets'), 'the converted note opens as a map');
  } finally {
    // The backups are expected here; remove them so the runner's leftover-copy check still guards the rest.
    for (const b of safetyCopies()) fs.rmSync(path.join(VAULT, b), { force: true });
  }
  } finally {
    await evalJs(`app.plugins.plugins.mapdown.settings.headLevel = ${JSON.stringify(prevHead)};`);
  }
});

scenario('xmind-import-drop', async () => {
  const p = writeNote('xmind_target', '# Target\n\n## keep\n');
  const original = readNote(p);
  const b64 = await xmindBase64({ 'content.json': JSON.stringify(ZEN_SHEETS) });
  await open(p);
  const targetTexts = await texts();
  const drop = await evalJs(`
    const before = ${XMIND_FILES};
    const dt = new DataTransfer();
    dt.items.add(new File([${XMIND_BYTES(b64)}], '${PREFIX}dropped.xmind'));
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
    H.root().dispatchEvent(over);
    const dropped = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    H.root().dispatchEvent(dropped);
    await H.until(() => app.workspace.getActiveFile()?.basename === '${PREFIX}dropped', 8000);
    return { created: ${XMIND_FILES}.filter((x) => !before.includes(x)), overAccepted: over.defaultPrevented, dropHandled: dropped.defaultPrevented };`);
  drop.created.forEach((c) => trackedPaths.add(c));
  expect(drop.overAccepted && drop.dropHandled, 'the map accepts a dragged file and handles the drop', drop);
  expect(drop.created.length === 1 && xmindName(drop.created[0]) === `${PREFIX}dropped.md`, 'a dropped .xmind creates exactly one new note', drop);
  const r = await evalJs(XMIND_STATE);
  expect(r.type === VIEW_TYPE && r.path === drop.created[0], 'the new note opens as a map', r);
  expect(JSON.stringify(r.texts) === JSON.stringify(['X Root', '[Alpha](https://example.com)', '📝 remember', 'Beta', 'Floating']),
    'topics, link, note and floating topic are imported', r.texts);
  expect(JSON.stringify(r.collapsed) === '["Beta"]', 'a folded topic stays collapsed', r.collapsed);
  expect(r.unchanged, 'the imported note is stable when the map saves', r);

  // The map the file was dropped on is untouched and still open.
  const target = await evalJs(`
    const leaf = app.workspace.getLeavesOfType(VT).find((l) => l.view.file?.path === '${p}');
    if (!leaf) return null;
    app.workspace.setActiveLeaf(leaf, { focus: true });
    await H.wait(300);
    return H.texts();`);
  expect(target && JSON.stringify(target) === JSON.stringify(targetTexts) && readNote(p) === original,
    'the map it was dropped on is unchanged', { target, targetTexts });

  // Other files are not taken.
  const other = await evalJs(`
    const before = ${XMIND_FILES};
    const dt = new DataTransfer();
    dt.items.add(new File(['hello'], '${PREFIX}other.txt'));
    const dropped = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    H.root().dispatchEvent(dropped);
    await H.wait(1000);
    return { created: ${XMIND_FILES}.filter((x) => !before.includes(x)), handled: dropped.defaultPrevented };`);
  expect(other.created.length === 0 && !other.handled, 'dropping a file that is not .xmind does nothing', other);
});

scenario('xmind-import-command', async () => {
  const base = writeNote('xmind_cmd_base', '# Base\n');
  await open(base);
  const run = async (files, name, expected) => {
    const r = await evalJs(xmindCommandSnippet(files, name, expected));
    r.created = oursOnly(r.created);
  r.created.forEach((c) => trackedPaths.add(c));
    return r;
  };
  const zen = await xmindBase64({ 'content.json': JSON.stringify(ZEN_SHEETS) });
  const first = await run(zen, `${PREFIX}dup.xmind`, 1);
  const second = await run(zen, `${PREFIX}dup.xmind`, 1);
  const dupNames = [...first.created, ...second.created].map(xmindName);
  expect(first.picked && JSON.stringify(dupNames) === JSON.stringify([`${PREFIX}dup.md`, `${PREFIX}dup 1.md`]),
    'importing the same name twice adds a number instead of overwriting', { first, second });

  const two = await xmindBase64({ 'content.json': JSON.stringify([...ZEN_SHEETS, { title: 'Second', rootTopic: { id: 's', title: 'S' } }]) });
  let r = await run(two, `${PREFIX}multi.xmind`, 2);
  expect(JSON.stringify(r.created.map(xmindName)) === JSON.stringify([`${PREFIX}multi - Main.md`, `${PREFIX}multi - Second.md`]),
    'each sheet becomes its own note', r);

  r = await run(await xmindBase64({ 'content.xml': LEGACY_XML }), `${PREFIX}legacy.xmind`, 1);
  expect(r.created.length === 1, 'an XMind 8 file imports', r);
  const state = await evalJs(XMIND_STATE);
  expect(JSON.stringify(state.texts) === JSON.stringify(['Legacy Root', '[Linked](https://example.com/old)', '📝 Note & more', 'Folded', 'Free']),
    'XMind 8 titles, links, notes and floating topics are imported', state.texts);
  expect(JSON.stringify(state.collapsed) === '["Folded"]' && state.unchanged, 'XMind 8 folding is kept and the note is stable', state);

  const broken = await run(Buffer.from('not a zip').toString('base64'), `${PREFIX}broken.xmind`, 0);
  const unknown = await run(await xmindBase64({ 'readme.txt': 'x' }), `${PREFIX}unknown.xmind`, 0);
  expect(broken.picked && unknown.picked && broken.created.length === 0 && unknown.created.length === 0,
    'broken or unknown files create no notes', { broken, unknown });
});

scenario('xmind-export', async () => {
  const p = writeNote('xexport', '# Export Root\n\n## [Linked site](https://example.com) `tag`\n\n- 📝 a note\n\n## Folded ^xf1\n\n- hidden child\n\n## Plain\n', '{"version":2,"collapsed":["xf1"]}');
  const exportCommand = "app.commands.executeCommandById('mapdown:export-xmind');";
  const listXmind = () => evalJs(`return app.vault.getFiles().filter((f) => f.extension === 'xmind' && f.basename.startsWith('${PREFIX}xexport')).map((f) => f.path).sort();`);
  await open(p);

  // An edit in progress is committed and saved before the file is written.
  await clickNode('Plain');
  await press('Space');
  await waitEditing(true);
  await evalJs('H.selectEditorText();');
  await typeText('Plain edited');
  await evalJs(exportCommand);
  expect(await waitFor(async () => (await listXmind()).length === 1, 8000), 'the export command writes an .xmind file');
  await sleep(500);
  expect(!(await isEditing()), 'exporting ends the edit in progress');
  expect(readNote(p).includes('## Plain edited'), 'the edit was saved to the note before exporting');
  const before = await evalJs('return { texts: H.texts(), collapsed: H.texts().filter((x) => H.collapsed(x)) };');

  await evalJs(exportCommand);
  expect(await waitFor(async () => (await listXmind()).length === 2, 8000), 'a second export is numbered');
  const exported = await listXmind();
  expect(JSON.stringify(exported) === JSON.stringify([`${INBOX}/${PREFIX}xexport 1.xmind`, `${INBOX}/${PREFIX}xexport.xmind`]),
    'export writes next to the note without overwriting', exported);

  // The file is a Zen archive with the map in it.
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(VAULT, exported[1])));
  expect(Object.keys(zip.files).sort().join() === 'content.json,manifest.json,metadata.json', 'the archive has the three XMind entries', Object.keys(zip.files));
  const sheets = JSON.parse(await zip.file('content.json').async('text'));
  const top = sheets[0].rootTopic;
  const [linked, folded, plain] = top.children.attached;
  expect(sheets.length === 1 && sheets[0].title === `${PREFIX}xexport` && top.title === 'Export Root', 'one sheet named after the note, with the root topic', sheets);
  expect(linked.title === 'Linked site' && linked.href === 'https://example.com' && JSON.stringify(linked.labels) === '["tag"]'
    && linked.notes.plain.content === 'a note' && !linked.children, 'link, label and note are exported as XMind fields', linked);
  expect(folded.title === 'Folded' && folded.branch === 'folded' && folded.children.attached[0].title === 'hidden child', 'a collapsed branch is exported folded', folded);
  expect(plain.title === 'Plain edited', 'the committed edit is in the export', plain);

  // Importing the exported file (file menu entry) gives the same map back.
  const menu = await evalJs(`
    const file = H.file('${exported[1]}');
    const items = [];
    const menu = {
      addItem(cb) {
        const item = { icon: '', setTitle() { return item; }, setIcon(i) { item.icon = i; return item; }, setSection() { return item; }, setSectionSubmenu() { return item; }, setSubmenu() { return menu; }, onClick(fn) { item.fn = fn; return item; } };
        cb(item);
        items.push(item);
        return menu;
      },
      addSeparator() { return menu; },
      setSectionSubmenu() { return menu; },
    };
    app.workspace.trigger('file-menu', menu, file, 'test');
    const ours = items.filter((i) => i.icon === 'mapdown');
    if (ours.length !== 1) return { ours: ours.length };
    await ours[0].fn();
    await H.until(() => app.workspace.getActiveFile()?.basename.startsWith('${PREFIX}xexport') && app.workspace.getActiveFile().extension === 'md' && app.workspace.getActiveFile().path !== '${p}', 8000);
    return { ours: 1, path: app.workspace.getActiveFile().path };`);
  expect(menu.ours === 1, 'the file menu of an .xmind file offers one import item', menu);
  trackedPaths.add(menu.path);
  const after = await evalJs(XMIND_STATE);
  expect(JSON.stringify(after.texts) === JSON.stringify(before.texts) && JSON.stringify(after.collapsed) === JSON.stringify(before.collapsed),
    'importing the exported file gives back the same map', { before, after });
  expect(readNote(p).includes('## Plain edited') && !readNote(p).includes('## Plain\n'), 'exporting only saved the edit and changed nothing else in the note');
});

scenario('export-commits-edit', async () => {
  const p = writeNote('export', '# Root\n\n## child\n');
  await open(p);
  await clickNode('child');
  await press('Space');
  await waitEditing(true);
  await evalJs('H.selectEditorText();');
  await typeText('**bold edit**');
  expect(await isEditing(), 'the node is still being edited when the export starts');
  const r = await evalJs(`
    const view = app.workspace.activeLeaf.view;
    const transform = () => H.canvas().style.transform;
    const before = transform();
    await view.exportImage('png', 1);
    const f = H.file('${INBOX}/${PREFIX}export.png');
    let size = null;
    if (f) {
      const bmp = await createImageBitmap(new Blob([await app.vault.readBinary(f)], { type: 'image/png' }));
      size = { w: bmp.width, h: bmp.height };
      bmp.close();
    }
    return { editing: H.api().isEditing(), png: !!f, size, moved: transform() !== before };
  `, 60000);
  expect(!r.editing, 'export ends the active edit', r);
  expect(readNote(p).includes('## **bold edit**'), 'the edit is committed and saved before the export', readNote(p));
  expect(r.png && r.size && r.size.w > 0 && r.size.h > 0, 'export writes a readable PNG next to the note', r);
  expect(!r.moved, 'export does not move or zoom the displayed map', r);
});

scenario('export-missing-and-close', async () => {
  // A missing embedded image must not block the export.
  const p = writeNote('exportmissing', '# Root\n\n## child ![[__mapdown_e2e_missing.png]]\n\n## other\n');
  let r = await evalJs(`
    const leaf = await H.open('${p}');
    await leaf.view.exportImage('png', 1);
    return { png: !!H.file('${INBOX}/${PREFIX}exportmissing.png') };
  `, 60000);
  expect(r.png, 'export completes when an embedded image is missing', r);

  // Closing the map while the export is running cancels it quietly.
  const q = writeNote('exportclose', '# Root\n\n## child\n');
  r = await evalJs(`
    const leaf = await H.open('${q}');
    const errors = [];
    const origError = console.error;
    console.error = (...a) => { errors.push(a.map((x) => String(x?.stack || x)).join(' | ').slice(0, 600)); origError(...a); };
    let rejected = null;
    try {
      const pending = leaf.view.exportImage('png', 2);
      leaf.detach();
      await pending.catch((e) => { rejected = String(e); });
      await H.wait(800);
    } finally {
      console.error = origError;
    }
    return { png: !!H.file('${INBOX}/${PREFIX}exportclose.png'), errors, rejected };
  `, 60000);
  expect(!r.png, 'closing the map during export writes no image', r);
  expect(r.rejected === null, 'a cancelled export resolves instead of failing', r);
  expect(r.errors.length === 0, 'a cancelled export is not reported as an error', r);
});


// Images in nodes (spec 5.8) -------------------------------------------------

// A solid PNG of the given size (real pixels, so the 300 px cap is visible).
function imagePng(width, height) {
  const zlib = require('zlib');
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([200, 60, 60], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const IMAGE_FILES = `app.vault.getFiles().map((f) => f.path)`;
// Of the files that appeared during a step, the ones this test could have made (others sync in).
const oursOnly = (list) => (list || []).filter((x) => /__mapdown_e2e_|(^|\/)Pasted image \d{14}[^/]*$/.test(x));

// Page snippet: geometry of the first image in the node with text `text`, once it has loaded and the box settled.
const imageInNode = (text) => `
  const img = await (async () => {
    let found = null;
    await H.until(() => { const e = H.el(${JSON.stringify(text)}); found = e && e.querySelector('img'); return found && found.complete && found.naturalWidth > 0; }, 8000);
    return found;
  })();
  if (!img) return { img: false };
  const inside = () => {
    const n = H.el(${JSON.stringify(text)}).getBoundingClientRect(), i = img.getBoundingClientRect();
    return i.left >= n.left - 1 && i.right <= n.right + 1 && i.top >= n.top - 1 && i.bottom <= n.bottom + 1;
  };
  await H.until(inside, 4000);
  await H.frames(2);
  const n = H.el(${JSON.stringify(text)}).getBoundingClientRect(), i = img.getBoundingClientRect();
  const zoom = n.width / H.el(${JSON.stringify(text)}).offsetWidth;
  return { img: true, inside: inside(), cssWidth: Math.round(i.width / zoom), natural: img.naturalWidth,
    node: [n.left, n.top, n.right, n.bottom].map(Math.round), image: [i.left, i.top, i.right, i.bottom].map(Math.round) };`;

scenario('node-image', async () => {
  const imgName = `${PREFIX}img.png`;
  const imgPath = `${INBOX}/${imgName}`;
  const png = imagePng(400, 40);
  fs.writeFileSync(path.join(VAULT, imgPath), png);
  const p = writeNote('image', '# Root\n\n## child\n\n## other\n');
  await open(p);
  expect(await evalJs(`return await H.until(() => H.file('${imgPath}'), 5000);`), 'the test image is in the vault');
  // The link follows the vault's link settings (spec 5.8), so ask Obsidian what it should be.
  const imgEmbed = '!' + await evalJs(`return app.fileManager.generateMarkdownLink(H.file('${imgPath}'), '${p}');`);

  // 1. Command -> vault list -> pick the image: appended to the selected node, one undo step.
  await clickNode('child');
  const before = await history();
  let r = await evalJs(`
    app.commands.executeCommandById('mapdown:insert-image');
    const shown = await H.until(() => document.querySelector('.mapdown-image-picker'), 3000);
    if (!shown) return { shown };
    const modal = document.querySelector('.mapdown-image-picker');
    const input = modal.querySelector('input');
    input.value = '${PREFIX}img';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const sel = '.mapdown-image-pick[data-path="${imgPath}"]';
    await H.until(() => modal.querySelector(sel), 3000);
    const first = modal.querySelector('.mapdown-image-pick');
    const device = !!first && first.getAttribute('data-action') === 'choose-device';
    const item = modal.querySelector(sel);
    if (!item) return { shown, device, item: false };
    item.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    item.click();
    const closed = await H.until(() => !document.querySelector('.mapdown-image-picker'), 3000);
    return { shown, device, item: true, closed };`);
  expect(r.shown && r.item && r.closed, 'the image picker opens, lists the vault image and closes on pick', r);
  expect(r.device, 'the first item of the picker is "choose from this device"', r);
  await flush();
  expect(readNote(p).includes(`## child<br>${imgEmbed}`), 'the image is written on a new line of the node text', readNote(p));
  const after = await history();
  expect(after.undo === before.undo + 1, 'adding the image is one undo step', { before, after });

  r = await evalJs(imageInNode(`child\n${imgEmbed}`));
  expect(r.img, 'the node shows the image', r);
  expect(r.inside, 'the node box contains the loaded image', r);
  expect(r.natural === 400 && r.cssWidth <= 300, 'the image is at most 300 px wide by default', r);

  await press('KeyZ', MOD);
  await flush();
  expect(!readNote(p).includes('![['), 'one undo removes the image from the node', readNote(p));
  expect(fs.existsSync(path.join(VAULT, imgPath)), 'undo keeps the image file', imgPath);

  // 2. Drop an OS image file onto a node: saved as an attachment, appended to that node.
  const b64 = png.toString('base64');
  r = await evalJs(`
    const before = ${IMAGE_FILES};
    const dt = new DataTransfer();
    dt.items.add(new File([${XMIND_BYTES(b64)}], '${PREFIX}drop.png', { type: 'image/png' }));
    const target = H.el('other');
    const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(over);
    const dropped = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(dropped);
    await H.until(() => ${IMAGE_FILES}.some((x) => !before.includes(x)), 5000);
    await H.until(() => H.texts().some((t) => t.startsWith('other\\n![[')), 3000);
    return { created: ${IMAGE_FILES}.filter((x) => !before.includes(x)), over: over.defaultPrevented, handled: dropped.defaultPrevented, texts: H.texts() };`);
  r.created = oursOnly(r.created);
  r.created.forEach((c) => trackedPaths.add(c));
  expect(r.over && r.handled, 'the node accepts a dragged image', r);
  expect(r.created.length === 1 && r.created[0].endsWith(`${PREFIX}drop.png`), 'the dropped image is saved as one attachment', r);
  await flush();
  expect(/## other<br>!\[\[[^\]]*__mapdown_e2e_drop\.png\]\]/.test(readNote(p)), 'the dropped image is appended to the node it was dropped on', readNote(p));

  // Dropping on empty canvas does nothing.
  const text = readNote(p);
  r = await evalJs(`
    const before = ${IMAGE_FILES};
    const pt = H.emptyPoint();
    if (!pt) return { pt: null };
    const dt = new DataTransfer();
    dt.items.add(new File([${XMIND_BYTES(b64)}], '${PREFIX}nowhere.png', { type: 'image/png' }));
    document.elementFromPoint(pt.x, pt.y).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await H.wait(1000);
    return { pt, created: ${IMAGE_FILES}.filter((x) => !before.includes(x)) };`);
  if (r.created) r.created = oursOnly(r.created);
  r.created?.forEach((c) => trackedPaths.add(c));
  expect(r.pt && r.created.length === 0, 'an image dropped on empty canvas is not saved', r);
  await flush();
  expect(readNote(p) === text, 'an image dropped on empty canvas changes nothing', readNote(p));

  // 3. Paste an image while editing: saved, embed inserted at the caret.
  await clickNode('child');
  await press('Space');
  await waitEditing(true);
  r = await evalJs(`
    const before = ${IMAGE_FILES};
    const dt = new DataTransfer();
    dt.items.add(new File([${XMIND_BYTES(b64)}], 'image.png', { type: 'image/png' }));
    H.selectEditorText();
    window.getSelection().collapseToEnd();
    const ed = H.root().querySelector('.mapdown-node-editor');
    ed.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    await H.until(() => /!\\[\\[[^\\]]+\\.png\\]\\]/.test(H.editorText() || ''), 5000);
    return { created: ${IMAGE_FILES}.filter((x) => !before.includes(x)), editor: H.editorText() };`);
  r.created = oursOnly(r.created);
  r.created.forEach((c) => trackedPaths.add(c));
  const pastedName = r.created.length === 1 ? path.basename(r.created[0]) : null;
  expect(pastedName && /\.png$/.test(pastedName), 'a pasted image is saved as one attachment', r);
  const pastedEmbed = '!' + await evalJs(`return app.fileManager.generateMarkdownLink(H.file(${JSON.stringify(r.created[0])}), '${p}');`);
  expect(r.editor === `child${pastedEmbed}`, 'the embed is inserted at the caret', r);
  await press('Enter');
  await waitEditing(false);
  await flush();
  expect(readNote(p).includes(`## child${pastedEmbed}`), 'the edit with the pasted image is saved', readNote(p));

  // 4. Paste with a node selected (not editing) and only an image on the clipboard.
  await clickNode('child' + pastedEmbed);
  const base = await history();
  r = await evalJs(`
    const blob = new Blob([${XMIND_BYTES(b64)}], { type: 'image/png' });
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); } catch (e) { return { written: false, error: String(e) }; }
    return { written: true, before: ${IMAGE_FILES} };`);
  if (!r.written) {
    note(`could not put an image on the clipboard: ${r.error}`);
    return;
  }
  const filesBefore = r.before;
  await press('KeyV', MOD);
  r = await evalJs(`
    const before = ${JSON.stringify(filesBefore)};
    await H.until(() => ${IMAGE_FILES}.some((x) => !before.includes(x)), 5000);
    await H.wait(300);
    return { created: ${IMAGE_FILES}.filter((x) => !before.includes(x)), texts: H.texts() };`);
  r.created = oursOnly(r.created);
  r.created.forEach((c) => trackedPaths.add(c));
  expect(r.created.length === 1, 'pasting a clipboard image on a selected node saves one attachment', r);
  await flush();
  const secondEmbed = '!' + await evalJs(`return app.fileManager.generateMarkdownLink(H.file(${JSON.stringify(r.created[0])}), '${p}');`);
  expect(readNote(p).includes(`## child${pastedEmbed}<br>${secondEmbed}`), 'the pasted image is appended to the selected node on a new line', readNote(p));
  expect((await history()).undo === base.undo + 1, 'the paste is one undo step', await history());
  expect((await texts()).length === 3, 'an image paste adds no node', await texts());
});

// ---------------------------------------------------------------------------

async function main() {
  if (deploy) {
    console.log('Building and deploying…');
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'ignore' });
    for (const file of ['main.js', 'manifest.json', 'styles.css']) {
      const from = path.join(ROOT, file);
      // styles.css may not exist yet in early phases.
      if (fs.existsSync(from)) {
        fs.copyFileSync(from, path.join(PLUGIN_DIR, file));
      }
    }
    await cli(['plugin:reload', 'id=mapdown']);
    await sleep(1500);
  }

  preexisting = walkVault();
  await cleanup();
  await cli(['dev:errors', 'clear']);
  await cli(['dev:debug', 'on']);

  const selected = only
    ? scenarios.filter((s) => only.includes(s.name))
    : scenarios.filter((s) => s.phase <= maxPhase && (includeSlow || !s.slow));
  const failures = [];
  // Stop early when the plugin cannot open maps at all, instead of retrying every scenario.
  let notRendered = 0;
  for (const s of selected) {
    const started = Date.now();
    try {
      await ensureForeground();
      await s.run();
      await sleep(500);
      if (!s.allowCopies) {
        const copies = safetyCopies();
        expect(copies.length === 0, 'no backup, conflict or recovery copies are created', copies);
      }
      console.log(`  ✓ ${s.name} (${Date.now() - started} ms)`);
    } catch (err) {
      failures.push(s.name);
      console.log(`  ✗ ${s.name}\n      ${err.message}`);
      notRendered = /map did not render/.test(err.message) ? notRendered + 1 : 0;
      if (s.name === 'smoke' || notRendered >= 3) {
        console.log('  ! stopping: maps do not open; fix this before running the rest');
        break;
      }
    } finally {
      await cleanup();
    }
  }

  const errors = await cli(['dev:errors']);
  await cli(['dev:debug', 'off']).catch(() => {});
  // Errors whose stack names only other plugins (plugin:<id>) are theirs, not ours.
  const entries = /No errors captured/.test(errors) ? [] : errors.split(/\n(?=\d\d:\d\d:\d\d )/).filter((e) => e.trim());
  const foreign = (e) => /plugin:(?!mapdown\b)[\w-]+/.test(e) && !/plugin:mapdown\b/.test(e);
  const ours = entries.filter((e) => !foreign(e));
  const runtimeErrorsFree = ours.length === 0;
  if (entries.length > ours.length) {
    console.log(`  · ignored ${entries.length - ours.length} runtime errors from other plugins`);
  }
  if (!runtimeErrorsFree) {
    console.log(`  ✗ runtime errors captured:\n${ours.join('\n')}`);
  }

  const leftovers = listTempFiles();
  if (leftovers.length) {
    console.log(`  ✗ temporary files left behind: ${leftovers.join(', ')}`);
  }

  const passed = selected.length - failures.length;
  console.log(`\n${passed}/${selected.length} scenarios passed`);
  if (failures.length || !runtimeErrorsFree || leftovers.length) {
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exitCode = 1;
});
