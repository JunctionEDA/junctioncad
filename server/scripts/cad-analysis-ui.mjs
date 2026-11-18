// Browser test of the inspection and analysis tools in the real app: the measure readout (exact values from the
// worker, click to copy, the Measure tool's dimension lines, pins), the section view (planes, offset, flip, a
// face's plane, capped and hatched, picking past the cut), mass properties (a material from the document's
// library, mass, centre of mass, inertia), appearance (part and face colours and opacity stored in the document,
// view modes, perspective, hide / isolate / show all, named views), all on a part with several features and
// two parts; and the assembly's interference check and bill of materials on an assembly of two part instances.
//
// Setup as cad-ui.mjs: a local server with KC_DEV_LOGIN=1 on a throwaway database, Playwright, and psql on the
// PATH.  It tests the bundles the server serves (compiled into its binary, src/pages.rs include_str!: build the
// server after `npm run build`).  E2E_LOCAL_BUNDLES=1 instead builds mechanical.js, assembly.js, cad-worker.js
// and ui.css from web/ and hands those to the browser, for a server that was built before a change.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev E2E_BASE=http://127.0.0.1:8108 [SHOTS=/some/dir] node scripts/cad-analysis-ui.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { tool, toolTitles, openPanel } = await import(new URL('./cad-chrome.mjs', import.meta.url));
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

// ---------------------------------------------------------------- the bundles under test
const bundles = {};
if (process.env.E2E_LOCAL_BUNDLES) {
  execFileSync(process.execPath, [path.join(server, 'scripts', 'gen-cad-registry.mjs')]);
  const esbuild = require(path.join(server, 'node_modules', 'esbuild'));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-analysis-'));
  const common = { bundle: true, format: 'iife', minify: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error', legalComments: 'none' };
  esbuild.buildSync({ ...common, entryPoints: [path.join(server, 'web/domains/mechanical/index.tsx')], target: 'es2020', external: ['node:*'], define: { ...common.define, 'import.meta.url': '""' }, outfile: path.join(out, 'mechanical.js') });
  esbuild.buildSync({ ...common, entryPoints: [path.join(server, 'web/domains/assembly/index.tsx')], target: 'es2020', outfile: path.join(out, 'assembly.js') });
  esbuild.buildSync({ ...common, entryPoints: [path.join(server, 'web/domains/mechanical/kernel/worker.ts')], target: 'es2022', external: ['node:*'], define: { 'import.meta.url': '""' }, outfile: path.join(out, 'cad-worker.js') });
  // and the chrome's stylesheet, which Tailwind builds from the classes the .tsx files use
  execFileSync(path.join(server, 'node_modules', '.bin', 'tailwindcss'), ['-i', 'web/shared/styles/tailwind.css', '-o', path.join(out, 'ui.css'), '--minify'], { cwd: server, stdio: 'ignore' });
  for (const n of ['mechanical.js', 'assembly.js', 'cad-worker.js', 'ui.css']) bundles[n] = fs.readFileSync(path.join(out, n), 'utf8');
  fs.rmSync(out, { recursive: true, force: true });
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
const sql = (text) => execFileSync('psql', [PG_URL, '-Atc', text], { encoding: 'utf8' }).trim();
function user(login, githubId) {
  sql(`INSERT INTO users (github_id, login, name) VALUES (${githubId}, '${login}', '${login}') ON CONFLICT (github_id) DO NOTHING`);
  return Number(sql(`SELECT id FROM users WHERE github_id = ${githubId}`));
}

// ---------------------------------------------------------------- the part: several features, two parts
const rect = (x0, y0, x1, y1, p) => ({
  [`${p}1`]: { type: 'point', x: x0, y: y0 }, [`${p}2`]: { type: 'point', x: x1, y: y0 }, [`${p}3`]: { type: 'point', x: x1, y: y1 }, [`${p}4`]: { type: 'point', x: x0, y: y1 },
  [`${p}a`]: { type: 'line', a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: 'line', a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: 'line', a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: 'line', a: `${p}4`, b: `${p}1` },
});
let order = 0;
const feature = (id, featureType, params) => ({ id, type: 'feature', featureType, name: id, order: String.fromCharCode(66 + order++), params });
const sketch = (id, entities, plane = { kind: 'plane', plane: 'top' }) => feature(id, 'sketch', { plane, sketch: { version: 1, entities, constraints: {} } });
const extrude = (id, sk, o = {}) => feature(id, 'extrude', { profile: { sketch: sk, regions: null }, operation: 'new', endType: 'blind', depth: 10, flip: false, targets: [], ...o });
const onFace = (body, name) => ({ kind: 'face', ref: { kind: 'face', body, name } });
const partText = () => JSON.stringify({ junction: 'part-studio', version: 1, items: [
  { id: 'studio', type: 'studio', units: 'mm', rollback: null },
  // a 60 × 40 × 10 plate with a 10 mm hole, a 20 × 20 boss 15 high on it with an 8 mm pocket, and a separate block
  sketch('Sketch 1', { ...rect(0, 0, 60, 40, 'r'), hc: { type: 'point', x: 15, y: 20 }, hole: { type: 'circle', center: 'hc', r: 5 } }),
  extrude('Plate', 'Sketch 1'),
  sketch('Sketch 2', rect(35, 10, 55, 30, 'b'), onFace('Plate', 'Plate:end:ra')),
  extrude('Boss', 'Sketch 2', { operation: 'add', depth: 15, targets: ['Plate'] }),
  sketch('Sketch 3', { pc: { type: 'point', x: 45, y: 20 }, pocket: { type: 'circle', center: 'pc', r: 4 } }, onFace('Plate', 'Boss:end:ba')),
  extrude('Pocket', 'Sketch 3', { operation: 'remove', depth: 8, flip: true }),
  sketch('Sketch 4', rect(80, 0, 100, 20, 'k')),
  extrude('Block', 'Sketch 4', { depth: 20 }),
] });

const fp = (lib, ref, val, x, extra = '') => `  (footprint "${lib}" (layer "F.Cu") (uuid "u-${ref}") (at ${x} 10)
    (property "Reference" "${ref}" (at 0 -1.5 0) (layer "F.SilkS") (uuid "r-${ref}") (effects (font (size 1 1) (thickness 0.15))))
    (property "Value" "${val}" (at 0 1.5 0) (layer "F.Fab") (uuid "v-${ref}") (effects (font (size 1 1) (thickness 0.15))))${extra}
  )`;
const boardText = `(kicad_pcb (version 20240108) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
${fp('Resistor_SMD:R_0603_1608Metric', 'R1', '10k', 10, ' (property "LCSC" "C25804" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "l-R1"))')}
${fp('Resistor_SMD:R_0603_1608Metric', 'R2', '10k', 20, ' (property "LCSC" "C25804" (at 0 0 0) (layer "F.Fab") (hide yes) (uuid "l-R2"))')}
${fp('Capacitor_SMD:C_0402_1005Metric', 'C1', '100n', 30)}
${fp('MountingHole:MountingHole_3.2mm_M3', 'H1', 'MountingHole', 40, ' (attr exclude_from_bom)')}
)`;

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function open(uid, login) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  for (const [name, body] of Object.entries(bundles)) await ctx.route(new RegExp(`/static/dist/${name.replace('.', '\\.')}(\\?.*)?$`), (route) => route.fulfill({ status: 200, contentType: name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', body }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${login} console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${login} ${r.status()} ${r.url()}`); });
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}

const S = (page, fn, arg) => page.evaluate(fn, arg);
const ready = (page, bodies) => page.waitForFunction((n) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.bodies.length === n && s.features.every((f) => s.reports[f.id]);
}, bodies, { timeout: 90000 });
/** Where on the screen a click lands on this face (or edge, or vertex) of this body, checked with the studio's own picking. */
const spot = (page, kind, body, name) => page.evaluate(({ kind, body, name }) => {
  const st = window.JunctionPartStudio, b = st.getState().bodies.find((x) => x.id === body), m = b && b.mesh; if (!m) return null;
  const r = st.viewport.canvas.getBoundingClientRect();
  const cands = [];
  if (kind === 'face') {
    const i = m.faces.names.indexOf(name); if (i < 0) return null;
    for (let t = m.faces.start[i]; t < m.faces.start[i] + m.faces.count[i]; t += 3) {
      const c = [0, 0, 0]; for (let k = 0; k < 3; k++) for (let a = 0; a < 3; a++) c[a] += m.positions[m.indices[t + k] * 3 + a] / 3;
      cands.push(c);
    }
  } else if (kind === 'edge') {
    const i = m.edges.names.indexOf(name); if (i < 0) return null;
    for (let s = m.edges.start[i]; s < m.edges.start[i] + m.edges.count[i]; s += 2) cands.push([0, 1, 2].map((a) => (m.edges.positions[s * 3 + a] + m.edges.positions[(s + 1) * 3 + a]) / 2));
  } else {
    const i = m.vertices.names.indexOf(name); if (i < 0) return null;
    cands.push([0, 1, 2].map((a) => m.vertices.positions[i * 3 + a]));
  }
  for (const c of cands) {
    const p = window.__cadProject(c);
    const ev = { clientX: r.left + p.x, clientY: r.top + p.y };
    if (ev.clientX < r.left + 30 || ev.clientX > r.right - 30 || ev.clientY < r.top + 30 || ev.clientY > r.bottom - 30) continue;
    const hit = st.view.pick(ev);
    if (hit && hit.kind === kind && hit.body === body && hit.name === name) return { x: ev.clientX, y: ev.clientY };
  }
  return null;
}, { kind, body, name });
const clickAt = async (page, p, shift = false) => {
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
};
/** The measure readout's rows: key → copied value. */
const rows = (page) => page.$$eval('.cad-measure tr[data-key]', (els) => Object.fromEntries(els.map((e) => [e.dataset.key, Number(e.querySelector('[data-copy]').dataset.copy)])));
const measured = (page) => page.waitForFunction(() => { const el = document.querySelector('.cad-measure'); return el && el.dataset.measure === 'ready' && el.querySelectorAll('tr[data-key]').length > 0; }, null, { timeout: 30000 });

try {
  const uid = user('cad-analysis', 990401);
  const page = await open(uid, 'cad-analysis');
  const made = await S(page, async (text) => {
    const r = await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'CAD analysis test', template: 'pcb' }) });
    const pid = (await r.json()).projectId;
    const d = await (await fetch(`/api/projects/${pid}/docs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'Bracket.jpart' }) })).json();
    const up = await fetch(`/api/docs/${d.docId}/snapshots?seq=0`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: text });
    return { pid, docId: d.docId, ok: up.ok };
  }, partText());
  check('a project with a part studio of eight features is created', made.ok, JSON.stringify(made));
  await page.goto(`${BASE}/p/${made.pid}/edit?doc=${made.docId}`);
  await page.waitForSelector('.cad-root[data-doc-kind=part-studio]', { timeout: 30000 });
  await ready(page, 2);
  // a helper the spot() function above uses: model point → canvas pixels, with three's own Vector3
  await S(page, () => { const st = window.JunctionPartStudio; const V = st.viewport.target.constructor; window.__cadProject = (c) => st.viewport.project(new V(c[0], c[1], c[2])); });
  const bodies = await S(page, () => window.JunctionPartStudio.getState().bodies.map((b) => `${b.id}:${b.name}`));
  check('the part studio builds two parts', bodies.length === 2, bodies.join(' | '));
  const statuses = await S(page, () => Object.values(window.JunctionPartStudio.getState().reports).map((r) => r.status));
  check('every feature built', statuses.every((s) => s === 'ok'), statuses.join(','));
  await shot(page, '01-part');
  check('the toolbar has Measure and Section in the inspect group and Display, Perspective in the view group',
    await page.isVisible('[data-group=inspect] [data-tool=Measure]') && await page.isVisible('[data-group=inspect] [data-tool=Section]') && await page.isVisible('[data-group=view] [data-tool=Display]') && await page.isVisible('[data-group=view] [data-tool=Perspective]'));
  check('the right dock has the Appearance and Mass properties panels', await page.isVisible('[data-panel=appearance]') && await page.isVisible('[data-panel=mass-properties]'));
  // both start folded (the dock has more panels than fit open at once): unfold them, as a person would
  await openPanel(page, 'appearance'); await openPanel(page, 'mass-properties');

  // ---------------------------------------------------------------- measure
  const top = await spot(page, 'face', 'Plate', 'Plate:end:ra');
  check('the plate\'s top face can be clicked', !!top);
  await clickAt(page, top); await measured(page);
  let r = await rows(page);
  const topArea = 60 * 40 - Math.PI * 25 - 20 * 20;
  check('one face: its exact area', near(r['item.area'], topArea, 1e-9), `${r['item.area']} vs ${topArea}`);
  check('one face: its perimeter (the plate\'s edge, the hole and the boss\'s footprint)', near(r['item.perimeter'], 200 + 10 * Math.PI + 80, 1e-9), String(r['item.perimeter']));
  check('the readout is titled by what is measured', (await page.textContent('.cad-measure header span')) === 'Plane face');

  const bossTop = await spot(page, 'face', 'Plate', 'Boss:end:ba');
  await clickAt(page, bossTop, true); await page.waitForFunction(() => document.querySelectorAll('.cad-measure tr[data-key=normal], .cad-measure tr[data-key=min]').length > 0, null, { timeout: 20000 }); await measured(page);
  r = await rows(page);
  check('two parallel faces: the distance between them is the boss height', near(r.min, 15, 1e-9) || near(r.normal, 15, 1e-9), JSON.stringify(r));
  check('two parallel faces: the angle is 0°', r.angle === 0, String(r.angle));
  await shot(page, '02-measure-two-faces');

  // a click copies the value
  await page.click('.cad-measure tr[data-key=angle]');
  const copied = await S(page, () => navigator.clipboard.readText().catch(() => ''));
  check('a click on a value copies the number', copied === '0', JSON.stringify(copied));

  // the hole: radius and diameter, exact
  const hole = await spot(page, 'face', 'Plate', 'Plate:side:hole');
  if (hole) {
    await clickAt(page, hole); await page.waitForFunction(() => !!document.querySelector('.cad-measure tr[data-key="item.radius"]'), null, { timeout: 20000 });
    r = await rows(page);
    check('a hole: radius 5 and diameter 10', near(r['item.radius'], 5, 1e-9) && near(r['item.diameter'], 10, 1e-9), JSON.stringify(r));
  } else check('the hole can be clicked', false);

  // an edge and a vertex
  const edge = await spot(page, 'edge', 'Block', 'edge(Block:end:ka|Block:side:ka)');
  if (edge) { await clickAt(page, edge); await page.waitForFunction(() => !!document.querySelector('.cad-measure tr[data-key="item.length"]'), null, { timeout: 20000 }); r = await rows(page); check('an edge: its length', near(r['item.length'], 20, 1e-9), JSON.stringify(r)); }
  else check('the block\'s top edge can be clicked', false);

  // the Measure tool draws dimension lines on the model; Pin keeps one
  const plateSide = await spot(page, 'face', 'Plate', 'Plate:side:rb'), blockSide = await spot(page, 'face', 'Block', 'Block:side:ka');
  await clickAt(page, plateSide); await clickAt(page, blockSide, true);
  await page.waitForFunction(() => !!document.querySelector('.cad-measure tr[data-key=min]'), null, { timeout: 20000 });
  r = await rows(page);
  check('faces of two parts: the gap between them', near(r.min, 20, 1e-9), `min ${r.min}`);
  await page.click('[data-tool=Measure]');
  await page.waitForSelector('.cad-dims .cad-dim', { timeout: 10000 });
  const dimText = await page.$$eval('.cad-dims .cad-dim', (els) => els.map((e) => e.textContent));
  check('with Measure on, the distance is drawn on the model', dimText.some((t) => t === '20 mm'), dimText.join(' | '));
  await shot(page, '03-measure-tool-dimension');
  await page.click('.cad-measure header button:has-text("Pin")');
  await page.focus('.cad-stage canvas');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.JunctionPartStudio.getState().selection.length === 0);
  await page.waitForFunction(() => document.querySelectorAll('.cad-dims .cad-dim').length === 2, null, { timeout: 5000 }).catch(() => {});
  const pinned = await page.$$eval('.cad-dims .cad-dim', (els) => els.map((e) => e.textContent));
  check('a pinned measurement stays on the model after the selection is cleared', pinned.length === 2 && pinned.includes('20 mm') && await page.isVisible('.cad-measure [data-pin]'), pinned.join(' | '));
  await page.click('[data-tool=Measure]');
  check('Measure is a toggle: the button is pressed while it is on', (await page.getAttribute('[data-tool=Measure]', 'aria-pressed')) === null);
  await page.click('.cad-measure [data-pin] button');
  await page.waitForFunction(() => !document.querySelector('.cad-measure'), null, { timeout: 5000 }).catch(() => {});
  check('unpinning the last measurement clears the readout', !(await page.isVisible('.cad-measure')));

  // ---------------------------------------------------------------- section
  await page.click('.cad-stage canvas', { position: { x: 5, y: 5 } }).catch(() => {});
  await S(page, () => window.JunctionPartStudio.select([]));
  await page.focus('.cad-stage canvas');
  await page.keyboard.press('x');
  await page.waitForSelector('.cad-section', { timeout: 10000 });
  const sec = () => S(page, () => window.__sectionState());
  await S(page, () => { window.__sectionState = () => { const el = document.querySelector('.cad-section'); return { on: !!el, offset: Number(el?.querySelector('input[type=number]')?.value), plane: el?.querySelector('[role=radio][aria-checked=true]')?.textContent }; }; });
  let ss = await sec();
  check('X opens a section on the Front plane through the middle of the model', ss.on && ss.plane === 'Front', JSON.stringify(ss));
  await page.waitForTimeout(300);
  await shot(page, '04-section-front');
  // a section plane at y = 20 (the hole's axis): picking at the hole goes past the cut
  const setOffset = async (v) => { await page.fill('.cad-section input[type=number]', String(v)); await page.press('.cad-section input[type=number]', 'Enter'); };
  await setOffset(-20);
  await page.waitForTimeout(200);
  ss = await sec();
  check('the offset can be typed', near(ss.offset, -20), JSON.stringify(ss));
  await shot(page, '05-section-offset');
  // the cut is clipping: a click where the front part was removed picks what lies behind the cut
  const clipped = await S(page, () => {
    const st = window.JunctionPartStudio, V = st.viewport.target.constructor;
    const r = st.viewport.canvas.getBoundingClientRect();
    const p = st.viewport.project(new V(5, 0, 5));   // the front face of the plate, which is cut away
    const hit = st.view.pick({ clientX: r.left + p.x, clientY: r.top + p.y });
    return hit ? `${hit.kind}:${hit.name}` : 'nothing';
  });
  check('picking skips what the section cuts away', !clipped.includes('Plate:side:ra'), clipped);
  await page.check('.cad-section input[type=checkbox] >> nth=0');
  await page.waitForTimeout(200);
  await shot(page, '06-section-flipped');
  // the frame rate while dragging the plane
  const fps = await S(page, async () => {
    const range = document.querySelector('.cad-section input[type=range]');
    const lo = Number(range.min), hi = Number(range.max), n = 30, t0 = performance.now();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    for (let i = 0; i < n; i++) {
      setter.call(range, String(lo + ((hi - lo) * i) / n)); range.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    }
    return (n / (performance.now() - t0)) * 1000 * 2;
  });
  check('dragging the section plane redraws every frame (software rendering here)', fps > 3, `${fps.toFixed(1)} frames/s with SwiftShader`);
  // moving the plane costs the page almost nothing: no kernel call, no geometry rebuilt, only uniforms change
  const perMove = await S(page, () => {
    const range = document.querySelector('.cad-section input[type=range]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const lo = Number(range.min), hi = Number(range.max), n = 200, t0 = performance.now();
    for (let i = 0; i < n; i++) { setter.call(range, String(lo + ((hi - lo) * i) / n)); range.dispatchEvent(new Event('input', { bubbles: true })); }
    return (performance.now() - t0) / n;
  });
  check('moving the section plane takes well under a frame of work on the page', perMove < 4, `${perMove.toFixed(2)} ms a move`);
  // the plane of a picked flat face
  await page.click('.cad-section button:has-text("Close")');
  const bossTop2 = await spot(page, 'face', 'Plate', 'Boss:end:ba');
  await clickAt(page, bossTop2);
  await page.keyboard.press('x');
  await page.waitForFunction(() => document.querySelector('.cad-section [role=radio][aria-checked=true]')?.textContent === 'Face', null, { timeout: 10000 });
  await setOffset(-7);
  await page.waitForTimeout(300);
  await shot(page, '07-section-face');
  check('a section on a picked flat face', (await sec()).plane === 'Face');
  await page.keyboard.press('Escape');
  await page.focus('.cad-stage canvas');
  await page.keyboard.press('x');
  await page.waitForFunction(() => !document.querySelector('.cad-section'), null, { timeout: 5000 });
  check('X again ends the section view', true);

  // ---------------------------------------------------------------- mass properties
  await S(page, () => window.JunctionPartStudio.select([]));
  await page.selectOption('[data-panel=mass-properties] select[aria-label="Material of Part 1"]', 'steel');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-panel=mass-properties] tr[data-key=Mass]')].length > 0 || true);
  await page.waitForFunction(() => { const el = document.querySelector('[data-mass]'); return el && el.dataset.mass === 'ready' && el.textContent.includes('Give'); }, null, { timeout: 30000 });
  check('with one of two parts given a material, the total has no mass yet', true);
  await page.selectOption('[data-panel=mass-properties] select[aria-label="Material of Part 2"]', 'aluminium');
  await page.waitForFunction(() => !!document.querySelector('[data-panel=mass-properties] tr[data-key=Mass]'), null, { timeout: 30000 });
  const doc1 = await S(page, () => { const d = window.JunctionPartStudio.doc; return JSON.parse(JSON.stringify(d.items.get('materials') || null)); });
  check('materials are stored in the document, library included', doc1 && doc1.assign.Plate === 'steel' && doc1.assign.Block === 'aluminium' && doc1.library.steel.density === 7.85, JSON.stringify(doc1 && doc1.assign));
  const volumes = await S(page, async () => { const st = window.JunctionPartStudio; const r = await st.kernel.call('mass-properties', { bodies: null, density: { Plate: 7.85, Block: 2.7 } }); return r; });
  const plateVol = 60 * 40 * 10 - Math.PI * 25 * 10 + 20 * 20 * 15 - Math.PI * 16 * 8;
  check('the plate\'s volume is exact', near(volumes.parts[0].volume, plateVol, 1e-9), `${volumes.parts[0].volume} vs ${plateVol}`);
  const massText = await page.textContent('[data-panel=mass-properties] tr[data-key=Mass] td:last-child');
  const expectKg = plateVol * 7.85e-6 + 8000 * 2.7e-6;
  check('the panel shows the total mass from the materials', massText === `${Math.round(expectKg * 1e6) / 1e3} g`, `${massText} vs ${expectKg} kg`);
  await page.check('[data-panel=mass-properties] input[type=checkbox]');
  await page.waitForTimeout(300);
  const com = await S(page, () => !!window.JunctionPartStudio.viewport.scene.getObjectByName('centre-of-mass'));
  check('the centre of mass is marked in the viewport', com);
  // only the selected part
  await clickAt(page, await spot(page, 'face', 'Block', 'Block:end:ka'));
  await page.waitForFunction(() => document.querySelector('[data-panel=mass-properties] [data-mass-title]')?.textContent === 'Part 2', null, { timeout: 20000 });
  const blockMass = await page.textContent('[data-panel=mass-properties] tr[data-key=Mass] td:last-child');
  check('with a part selected, its own mass', blockMass === `${8000 * 2.7e-3} g`, blockMass);
  const izz = await page.$eval('[data-panel=mass-properties] tr[data-key=Izz] td:last-child', (e) => e.textContent);
  const blockIzz = (8000 * 2.7e-6 * (20 * 20 + 20 * 20)) / 12;
  check('and its moment of inertia about Z through its centre', izz === `${Math.round(blockIzz * 1000) / 1000} kg·mm²`, `${izz} vs ${blockIzz}`);
  await shot(page, '08-mass-properties');
  await page.uncheck('[data-panel=mass-properties] input[type=checkbox]');

  // ---------------------------------------------------------------- appearance
  await page.fill('[data-panel=appearance] [data-body=Block] input[type=color]', '#3d7bd9');
  await page.waitForFunction(() => { const d = window.JunctionPartStudio.doc.items.get('appearance'); return d && d.bodies.Block && d.bodies.Block.color === '#3d7bd9'; }, null, { timeout: 10000 });
  check('a part\'s colour is stored in the document', true);
  const drawn = await S(page, () => { const o = window.JunctionPartStudio.view.bodyObjects('Block'); return '#' + (Array.isArray(o.mesh.material) ? o.mesh.material[0] : o.mesh.material).color.getHexString(); });
  check('and the part is drawn in it', drawn === '#3d7bd9', drawn);
  const steel = await S(page, () => { const o = window.JunctionPartStudio.view.bodyObjects('Plate'); return '#' + (Array.isArray(o.mesh.material) ? o.mesh.material[0] : o.mesh.material).color.getHexString(); });
  check('a part with a material and no colour of its own is drawn in the material\'s colour', steel === '#8c9198', steel);
  // a face colour
  await clickAt(page, await spot(page, 'face', 'Plate', 'Boss:end:ba'));
  await page.waitForSelector('[data-panel=appearance] input[aria-label="Colour of the selected faces"]');
  await page.fill('[data-panel=appearance] input[aria-label="Colour of the selected faces"]', '#d94a3d');
  await page.waitForFunction(() => { const d = window.JunctionPartStudio.doc.items.get('appearance'); return d && d.bodies.Plate && d.bodies.Plate.faces && d.bodies.Plate.faces['Boss:end:ba'] === '#d94a3d'; }, null, { timeout: 10000 });
  const groups = await S(page, () => { const o = window.JunctionPartStudio.view.bodyObjects('Plate'); return { mats: Array.isArray(o.mesh.material) ? o.mesh.material.length : 1, groups: o.mesh.geometry.groups.length }; });
  check('a face colour: stored by the face\'s name and drawn as its own material', groups.mats === 2 && groups.groups > 1, JSON.stringify(groups));
  // opacity of the selected part
  await page.fill('[data-panel=appearance] input[aria-label="Opacity of the selected parts"]', '0.5');
  await page.waitForFunction(() => { const d = window.JunctionPartStudio.doc.items.get('appearance'); return d && d.bodies.Plate && d.bodies.Plate.opacity === 0.5; }, null, { timeout: 10000 });
  check('opacity is stored for the selected part', true);
  await S(page, () => window.JunctionPartStudio.select([]));
  await page.waitForTimeout(250);
  await shot(page, '09-appearance-colours');

  // view modes
  for (const mode of ['shaded', 'wireframe', 'hidden-line', 'shaded-edges']) {
    await page.selectOption('[data-panel=appearance] select[aria-label="View mode"]', mode);
    await page.waitForTimeout(200);
    const st = await S(page, () => { const o = window.JunctionPartStudio.view.bodyObjects('Plate'); return { mesh: o.mesh.visible, edges: o.edges.visible }; });
    const want = { 'shaded': { mesh: true, edges: false }, 'wireframe': { mesh: false, edges: true }, 'hidden-line': { mesh: true, edges: true }, 'shaded-edges': { mesh: true, edges: true } }[mode];
    check(`view mode ${mode}`, st.mesh === want.mesh && st.edges === want.edges, JSON.stringify(st));
    if (mode !== 'shaded-edges') await shot(page, `10-mode-${mode}`);
  }
  // perspective
  await page.focus('.cad-stage canvas');
  await page.click('.cad-toolbar [data-tool=Perspective]');   // P is the planes now, as in Onshape; the projection is a button and in the view cube's menu
  check('the Perspective button switches to perspective', (await S(page, () => window.JunctionPartStudio.viewport.projection)) === 'perspective' && (await page.getAttribute('[data-tool=Perspective]', 'aria-pressed')) === 'true');
  const persHit = await spot(page, 'face', 'Block', 'Block:end:ka');
  check('picking works in perspective', !!persHit);
  await page.waitForTimeout(200);
  await shot(page, '11-perspective');
  await page.click('.cad-toolbar [data-tool=Perspective]');
  // hide, isolate, show all
  await clickAt(page, await spot(page, 'face', 'Block', 'Block:end:ka'));
  await page.keyboard.press('h');
  await page.waitForTimeout(100);
  const hidden = await S(page, () => { const o = window.JunctionPartStudio.view.bodyObjects('Block'); return { visible: o.group.visible, layer: o.mesh.layers.mask }; });
  check('H hides the selected part', hidden.visible === false, JSON.stringify(hidden));
  const throughHidden = await S(page, () => { const st = window.JunctionPartStudio, V = st.viewport.target.constructor, r = st.viewport.canvas.getBoundingClientRect(); const p = st.viewport.project(new V(90, 10, 20)); const h = st.view.pick({ clientX: r.left + p.x, clientY: r.top + p.y }); return h ? h.body || h.kind : 'nothing'; });
  check('a hidden part cannot be picked', throughHidden !== 'Block', throughHidden);
  await page.keyboard.press('h');
  check('H with nothing selected shows every part again', await S(page, () => window.JunctionPartStudio.view.bodyObjects('Block').group.visible));
  await clickAt(page, await spot(page, 'face', 'Block', 'Block:end:ka'));
  await page.keyboard.press('i');
  await page.waitForTimeout(100);
  check('I isolates the selected part', await S(page, () => !window.JunctionPartStudio.view.bodyObjects('Plate').group.visible && window.JunctionPartStudio.view.bodyObjects('Block').group.visible));
  await shot(page, '12-isolate');
  await page.keyboard.press('i');
  check('I again shows everything', await S(page, () => window.JunctionPartStudio.view.bodyObjects('Plate').group.visible));
  // named views
  await S(page, () => window.JunctionPartStudio.viewport.setView('top', false));
  await page.fill('[data-panel=appearance] input[aria-label="Name of the view"]', 'From above');
  await page.click('[data-panel=appearance] button:has-text("Save view")');
  await page.waitForSelector('[data-panel=appearance] [data-view="From above"]');
  await S(page, () => window.JunctionPartStudio.viewport.setView('iso', false));
  await page.click('[data-panel=appearance] [data-view="From above"] button >> nth=0');
  await page.waitForTimeout(400);
  const dir = await S(page, () => { const q = window.JunctionPartStudio.viewport.camera.quaternion; const V = window.JunctionPartStudio.viewport.target.constructor; const d = new V(0, 0, -1).applyQuaternion(q); return [d.x, d.y, d.z].map((v) => Math.round(v * 1000) / 1000); });
  check('a named view is stored in the document and brings the camera back', dir[2] === -1, dir.join(','));

  // ---------------------------------------------------------------- everything stored survives a reload
  await page.reload();
  await page.waitForSelector('.cad-root[data-doc-kind=part-studio]', { timeout: 30000 });
  await ready(page, 2);
  const after = await S(page, () => { const v = window.JunctionPartStudio.view; const c = (id) => { const o = v.bodyObjects(id); const m = Array.isArray(o.mesh.material) ? o.mesh.material : [o.mesh.material]; return m.map((x) => '#' + x.color.getHexString() + '@' + x.opacity); }; return { block: c('Block'), plate: c('Plate') }; });
  check('after a reload: the colours, the face colour and the opacity are back', after.block[0] === '#3d7bd9@1' && after.plate[0] === '#8c9198@0.5' && after.plate[1] === '#d94a3d@0.5', JSON.stringify(after));
  check('after a reload: the named view is listed', await page.isVisible('[data-panel=appearance] [data-view="From above"]'));
  await shot(page, '13-after-reload');

  // ---------------------------------------------------------------- the assembly: interference and the bill of materials
  const asm = await S(page, async ({ pid, partDoc, board }) => {
    const post = (url, body, type = 'application/json') => fetch(url, { method: 'POST', headers: { 'content-type': type }, body });
    // a small board with three parts on the BOM and a mounting hole that is not
    const b = await (await post(`/api/projects/${pid}/docs`, JSON.stringify({ path: 'Controller.kicad_pcb' }))).json();
    await post(`/api/docs/${b.docId}/snapshots?seq=0`, board, 'application/octet-stream');
    const inst = (id, name, x, body) => ({ id, type: 'instance', name, order: id, source: { kind: 'part', docId: partDoc, body }, transform: [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0] });
    const pcb = (id, name) => ({ id, type: 'instance', name, order: id, source: { kind: 'board', docId: b.docId }, transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 50] });
    const text = JSON.stringify({ junction: 'assembly', version: 1, items: [
      { id: 'assembly', type: 'assembly', units: 'mm' },
      inst('i1', 'Bracket <1>', 0, 'Plate'), inst('i2', 'Bracket <2>', 50, 'Plate'), inst('i3', 'Block <1>', -150, 'Block'),
      pcb('i4', 'Controller <1>'), pcb('i5', 'Controller <2>'),
    ] });
    const d = await (await fetch(`/api/projects/${pid}/docs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'Frame.jasm' }) })).json();
    const up = await fetch(`/api/docs/${d.docId}/snapshots?seq=0`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: text });
    return { docId: d.docId, ok: up.ok };
  }, { pid: made.pid, partDoc: made.docId, board: boardText });
  check('an assembly with three part instances and two boards is created', asm.ok);
  await page.goto(`${BASE}/p/${made.pid}/edit?doc=${asm.docId}`);
  await page.waitForSelector('.cad-root[data-doc-kind=assembly]', { timeout: 30000 });
  await page.waitForFunction(() => window.JunctionAssembly && window.JunctionAssembly.getState().loaded && window.JunctionAssembly.getState().instances.length === 5, null, { timeout: 30000 });
  check('the assembly toolbar has Interference and Bill of materials', await page.isVisible('.cad-toolbar [data-tool="Interference"]') && await page.isVisible('.cad-toolbar [data-tool="Bill of materials"]'));
  await page.click('.cad-toolbar [data-tool="Interference"]');
  await page.waitForSelector('.asm-interference[data-state=done]', { timeout: 120000 });
  const clash = await page.$$eval('.asm-interference [data-clash]', (els) => els.map((e) => ({ pair: e.dataset.clash, volume: Number(e.dataset.volume) })));
  // the second bracket starts at x = 50: its plate overlaps the first plate's last 10 mm
  const overlap = 10 * 40 * 10;   // x 50 … 60 of the plates; the first boss only touches the second plate's top, and the holes are outside
  // boards are solids in an assembly too: the two controllers were placed in the same spot, and that is found
  const brackets = clash.find((c) => c.pair === 'i1|i2'), boards = clash.find((c) => c.pair === 'i4|i5');
  check('interference: two clashes, the two brackets and the two boards standing in one place', clash.length === 2 && !!brackets && !!boards, JSON.stringify(clash));
  check('interference: the brackets\' exact volume', !!brackets && near(brackets.volume, overlap, 1e-6), `${brackets && brackets.volume} vs ${overlap}`);
  check('interference: the boards overlap by a whole board', !!boards && boards.volume > 100, `${boards && boards.volume} mm³`);
  const clashMeshes = await S(page, () => { let n = 0; window.JunctionAssembly.viewport.scene.traverse((o) => { if (o.name === 'clash') n++; }); return n; });
  check('the clashes are highlighted in the viewport', clashMeshes === 2);
  const pictures = await S(page, () => ({ boards: window.JunctionAssembly.boards.stats, marked: [...window.JunctionAssembly.scene.marked].sort().join() }));
  check('the boards are drawn as they look, and the instances that clash are marked where they stand', pictures.boards.drawn === 2 && pictures.marked === 'i1,i2,i4,i5', JSON.stringify(pictures));
  check('the check ran in the editor\'s own workers: no part studio was opened or built a second time', (await S(page, () => window.JunctionAssembly.sources.kernels.workers)) === 2, 'one worker for the part studio, one for the board');
  await shot(page, '14-interference');
  // clearance between the bracket and the block
  await page.selectOption('.asm-interference select[aria-label="First instance"]', 'i1');
  await page.selectOption('.asm-interference select[aria-label="Second instance"]', 'i3');
  await page.click('.asm-interference button:has-text("Clearance")');
  await page.waitForSelector('.asm-interference [data-clearance]', { timeout: 60000 });
  const gap = Number(await page.getAttribute('.asm-interference [data-clearance]', 'data-clearance'));
  check('clearance: the block, moved to x −70 … −50, is 50 mm from the bracket', near(gap, 50, 1e-9), String(gap));
  await page.click('[data-panel=interference] button[aria-label="Close Interference"]');
  // the bill of materials
  await page.click('.cad-toolbar [data-tool="Bill of materials"]');
  await page.waitForSelector('.asm-bom[data-state=done]', { timeout: 60000 });
  const bom = await page.$$eval('.asm-bom tbody tr', (els) => els.map((e) => [...e.querySelectorAll('td')].map((t) => t.textContent.trim())));
  const row = (item) => (bom.find((r) => r[0] === item) || []).slice(0, 5).join('|');
  check('the bill of materials: each body once with its quantity and material', row('1') === '1|Part 1|Bracket|2|' && bom[0][7] === 'Steel' && row('2') === '2|Part 2|Bracket|1|' && bom[1][7] === 'Aluminium 6061', JSON.stringify(bom.slice(0, 2)));
  check('the bill of materials: the board, and its parts times the two boards', row('3') === '3|Controller|Board|2|' && row('3.1') === '3.1|100n|100n|2|C1' && row('3.2') === '3.2|10k|10k|4|R1 R2' && bom.length === 5, JSON.stringify(bom.slice(2)));
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.asm-bom button:has-text("Export CSV")')]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  check('the bill of materials exports as CSV', csv.startsWith('Item,') && csv.trim().split('\n').length === 6 && download.suggestedFilename() === 'Frame BOM.csv', csv.trim().split('\n').join(' / '));
  await shot(page, '15-bom');
} catch (e) {
  console.error(e);
  fail++;
} finally {
  if (errors.length) { console.log('page errors:\n  ' + errors.slice(0, 20).join('\n  ')); }
  check('no page errors', errors.filter((e) => !/favicon|ERR_ABORTED|status of 40[134]|preview\.svg/.test(e)).length === 0, `${errors.length}`);
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
