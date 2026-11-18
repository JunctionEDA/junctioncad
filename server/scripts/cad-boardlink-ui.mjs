// Browser test of the board link in the real app: a part studio drives a board.
//
// Two browser contexts of one person: one has the part studio open, the other the board.  In the part studio an
// enclosure tray is modelled (through the document's own edit path), then, with the Board panel and real
// clicks: the board is linked, its outline is taken from the tray's floor with a clearance, mounting holes
// from the boss tops, a keep-out from the underside of a rib.  The board in the other context follows live:
// Edge.Cuts, hole footprints and a rule area appear, locked, under a "Driven by" badge; widening the tray moves
// them; a tall component dragged under the rib is flagged; the 3D viewer shows the tray around the board;
// Break link releases the outline; and a board opened later is reconciled on open.
//
// Setup as scripts/cad-ui.mjs: a local server with KC_DEV_LOGIN=1 on a throwaway database, Playwright, psql.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/cad-boardlink-ui.mjs
//
// E2E_STATIC=1 serves this checkout's static/ bundles over the server's own (a server binary has the bundles
// it was built with compiled in; this tests the ones `npm run build` just wrote without rebuilding the server).
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

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
const STATIC = process.env.E2E_STATIC ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static') : '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
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

// ---------------------------------------------------------------- a project: a board with three parts and no outline
let n = 0;
const uu = (k) => `00000000-0000-0000-0000-${String(k).padStart(4, '0')}${String(n).padStart(8, '0')}`;
function fp(lib, ref, x, y, tht, w, l) {
  n++;
  const pad = tht
    ? (num, px) => `(pad "${num}" thru_hole circle (at ${px} 0) (size 1.6 1.6) (drill 0.8) (layers "*.Cu" "*.Mask") (uuid "${uu(3 + Number(num))}"))`
    : (num, px) => `(pad "${num}" smd rect (at ${px} 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (uuid "${uu(3 + Number(num))}"))`;
  return `  (footprint "${lib}" (layer "F.Cu") (uuid "${uu(1)}") (at ${x} ${y})
    (property "Reference" "${ref}" (at 0 ${-l / 2 - 1}) (layer "F.SilkS") (uuid "${uu(2)}") (effects (font (size 1 1) (thickness 0.15))))
    (attr ${tht ? 'through_hole' : 'smd'})
    (fp_rect (start ${-w / 2} ${-l / 2}) (end ${w / 2} ${l / 2}) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "${uu(3)}"))
    ${pad(1, -w / 4)}
    ${pad(2, w / 4)}
  )`;
}
const board = `(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (paper "A4")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user "F.Silkscreen") (1 "F.Mask" user) (3 "B.Mask" user) (13 "F.Paste" user) (25 "Edge.Cuts" user) (31 "F.CrtYd" user "F.Courtyard") (35 "F.Fab" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
${fp('Capacitor_THT:C_Rect_L7.0mm_W6.0mm', 'C1', 145, 85, true, 6, 6)}
${fp('Resistor_SMD:R_0603_1608Metric', 'R1', 125, 75, false, 3, 1.6)}
${fp('Package_SO:SOIC-8', 'U1', 110, 80, false, 5, 6)}
)
`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boardlink-ui-'));
fs.writeFileSync(path.join(dir, 'gadget.kicad_pcb'), board);
fs.writeFileSync(path.join(dir, 'gadget.kicad_pro'), JSON.stringify({ meta: { filename: 'gadget.kicad_pro', version: 3 } }));
execFileSync('zip', ['-qr', 'p.zip', 'gadget.kicad_pro', 'gadget.kicad_pcb'], { cwd: dir });

const aliceId = user('boardlink-alice', 990501);
const token = jwt(aliceId, 'boardlink-alice');
const form = new FormData(); form.append('name', 'Board link test'); form.append('archive', new Blob([fs.readFileSync(path.join(dir, 'p.zip'))]), 'p.zip');
const created = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })).json();
const pcbDoc = created.docs && created.docs.find((d) => d.path === 'gadget.kicad_pcb');
check('a project with a board is uploaded', !!pcbDoc, JSON.stringify(created).slice(0, 200));
const pid = created.projectId;

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const MIME = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8' };
async function open(label) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  if (STATIC) {
    await ctx.route('**/static/**', (route) => {
      const u = new URL(route.request().url());
      const file = path.join(STATIC, u.pathname.replace(/^\/static\//, ''));
      if (u.pathname.startsWith('/static/pyodide/') || !MIME[path.extname(file)] || !file.startsWith(STATIC) || !fs.existsSync(file)) return route.continue();
      return route.fulfill({ status: 200, contentType: MIME[path.extname(file)], body: fs.readFileSync(file) });
    });
  }
  const page = await ctx.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  await page.goto(`${BASE}/auth/dev?jwt=${token}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}

// ---- helpers: the part studio
/** The part studio is loaded, idle, and every built feature has reported. */
const settled = (page, count) => page.waitForFunction((count) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === count && !s.editing && !s.sketch && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, count, { timeout: 90000 });
/** The link in the part studio's document. */
const linkOf = (page) => page.evaluate(() => { for (const i of window.JunctionPartStudio.doc.items.values()) if (i.type === 'board-link') return JSON.parse(JSON.stringify(i)); return null; });
/** Wait until the link's answer says `fn(link)` (a string of a function of the link). */
const linkIs = (page, fn, arg) => page.waitForFunction(([src, arg]) => {
  const st = window.JunctionPartStudio; if (!st || !st.doc) return false;
  for (const i of st.doc.items.values()) if (i.type === 'board-link') return (0, eval)(`(${src})`)(i, arg);
  return false;
}, [fn.toString(), arg], { timeout: 30000 });
/** Click in the model at a point of model space (a person clicking a face they see). */
async function clickAt(page, point, mods = {}) {
  const at = await page.evaluate((point) => {
    const st = window.JunctionPartStudio;
    const p = st.viewport.project(st.viewport.camera.position.clone().set(point[0], point[1], point[2]));
    const r = st.viewport.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y };
  }, point);
  if (mods.shift) await page.keyboard.down('Shift');
  await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.up();
  if (mods.shift) await page.keyboard.up('Shift');
}
const selection = (page) => page.evaluate(() => window.JunctionPartStudio.getState().selection.map((p) => `${p.kind}:${p.name || p.featureId || p.plane}`));
/** Type a value into a number field of the Board panel and commit it. */
async function setField(page, scope, name, value) {
  const input = page.locator(`${scope} input[data-field="${name}"]`);
  await input.fill(String(value)); await input.press('Enter');
}

// ---- helpers: the board
const mech = (page) => page.evaluate(() => { const s = window.JunctionBoardMech.mech.getState(); return JSON.parse(JSON.stringify({ ...s, sources: s.sources.map((x) => ({ studio: x.studio, link: x.link.id, drives: Object.keys(x.link.drives), errors: x.link.solved.errors })) })); });
const boardItems = (page) => page.evaluate(() => {
  const doc = window.JunctionBoardMech.mech.board();
  const out = { edges: [], holes: [], zones: [], groups: [], locked: 0, driven: 0 };
  if (!doc) return out;
  const K = window.KiCadCanvas;
  for (const it of doc.items.values()) {
    if (!it.id.startsWith('6a756e63-')) continue;
    out.driven++;
    const lock = K.kid(it.node, 'locked'); if (lock && K.str(lock[1]) !== 'no') out.locked++;
    if (/^gr_/.test(it.kind) && K.str(K.kid(it.node, 'layer')[1]) === 'Edge.Cuts') { const a = K.kid(it.node, 'start'), b = K.kid(it.node, 'end'); out.edges.push({ kind: it.kind, bbox: [Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[1], b[1]), Math.max(a[2], b[2])] }); }
    else if (it.kind === 'footprint') out.holes.push({ x: it.x, y: it.y, ref: it.ref });
    else if (it.kind === 'zone') out.zones.push({ name: K.str(K.kid(it.node, 'name')[1]), bbox: it.bbox });
    else if (it.kind === 'group') out.groups.push(K.str(it.node[1]));
  }
  return out;
});
const outlineBox = (items) => {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const e of items.edges) if (e.bbox) b = [Math.min(b[0], e.bbox[0]), Math.min(b[1], e.bbox[1]), Math.max(b[2], e.bbox[2]), Math.max(b[3], e.bbox[3])];
  return b.map((v) => Math.round(v * 100) / 100);
};
/** Wait for the board's driven items to satisfy `fn(counts)`. */
const boardIs = (page, fn, arg) => page.waitForFunction(([src, arg]) => {
  const api = window.JunctionBoardMech; const doc = api && api.mech.board(); if (!doc) return false;
  const K = window.KiCadCanvas; const c = { edges: 0, holes: 0, zones: 0, groups: 0, x1: -Infinity, holeXs: [], unlockedEdges: 0 };
  for (const it of doc.items.values()) {
    if (!it.id.startsWith('6a756e63-')) continue;
    if (/^gr_/.test(it.kind)) { c.edges++; if (it.bbox) c.x1 = Math.max(c.x1, it.bbox[2]); const l = K.kid(it.node, 'locked'); if (!l || K.str(l[1]) === 'no') c.unlockedEdges++; }
    else if (it.kind === 'footprint') { c.holes++; c.holeXs.push(Math.round(it.x * 100) / 100); }
    else if (it.kind === 'zone') c.zones++;
    else if (it.kind === 'group') c.groups++;
  }
  c.clashes = api.mech.getState().clashes.map((x) => x.ref);
  c.checked = api.mech.getState().checked;
  return (0, eval)(`(${src})`)(c, arg);
}, [fn.toString(), arg], { timeout: 30000 });
/** Where a board position (mm) is on screen. */
const onScreen = (page, x, y) => page.evaluate(([x, y]) => window.JunctionBoardMech.clientOf(x, y), [x, y]);

try {
  // ================================================================ the part studio: a tray
  const cad = await open('cad');
  await cad.goto(`${BASE}/p/${pid}/edit`);
  await cad.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await cad.click('[data-doc-add]');
  await cad.click('text=New part studio');
  await cad.waitForSelector('.cad-root[data-doc-kind=part-studio]', { timeout: 30000 });
  await cad.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  const studioDocId = await cad.evaluate(() => window.JunctionPartStudio.host.doc.docId);

  // The tray, as the document's own edits (what the sketch tools and the feature dialog commit): a 60 × 40 × 12
  // block, a pocket that leaves a 2 mm floor, four bosses 5 mm above the floor, and a rib across the top.
  await cad.evaluate(() => {
    const st = window.JunctionPartStudio;
    const rect = (x0, y0, x1, y1, p) => ({
      [`${p}1`]: { type: 'point', x: x0, y: y0 }, [`${p}2`]: { type: 'point', x: x1, y: y0 }, [`${p}3`]: { type: 'point', x: x1, y: y1 }, [`${p}4`]: { type: 'point', x: x0, y: y1 },
      [`${p}a`]: { type: 'line', a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: 'line', a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: 'line', a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: 'line', a: `${p}4`, b: `${p}1` },
    });
    const circle = (id, x, y, r) => ({ [`${id}c`]: { type: 'point', x, y }, [id]: { type: 'circle', center: `${id}c`, r } });
    const top = { kind: 'face', ref: { kind: 'face', body: 'e1', name: 'e1:end:ra' } };
    const sketch = (id, name, order, entities, plane = { kind: 'plane', plane: 'top' }) => ({ id, type: 'feature', featureType: 'sketch', name, order, params: { plane, sketch: { version: 1, entities, constraints: {} } } });
    const extrude = (id, name, order, sk, o) => ({ id, type: 'feature', featureType: 'extrude', name, order, params: { profile: { sketch: sk, regions: null }, operation: 'new', endType: 'blind', depth: 10, flip: false, targets: [], ...o } });
    const items = [
      sketch('s1', 'Footprint', 'B', rect(0, 0, 60, 40, 'r')), extrude('e1', 'Block', 'C', 's1', { depth: 12 }),
      sketch('s2', 'Pocket', 'D', rect(2, 2, 58, 38, 'p'), top), extrude('e2', 'Hollow', 'E', 's2', { operation: 'remove', depth: 10, flip: true }),
      sketch('s3', 'Boss positions', 'F', { ...circle('b1', 8, 8, 3), ...circle('b2', 52, 8, 3), ...circle('b3', 52, 32, 3), ...circle('b4', 8, 32, 3) }), extrude('e3', 'Bosses', 'G', 's3', { operation: 'add', depth: 7 }),
      sketch('s4', 'Rib profile', 'H', rect(20, 0, 30, 40, 'k'), top), extrude('e4', 'Rib', 'I', 's4', { operation: 'add', depth: 2, flip: true }),
    ];
    st.commit(items.map((item) => ({ id: item.id, kind: 'ADDED', typeName: 'feature', item })));
  });
  await settled(cad, 8);
  check('the tray is built: one body, eight features, none failed', await cad.evaluate(() => { const s = window.JunctionPartStudio.getState(); return s.bodies.length === 1 && s.features.every((f) => s.reports[f.id].status === 'ok'); }));
  // look straight down into the tray, so its floor and the boss tops can be clicked
  await cad.evaluate(() => { const st = window.JunctionPartStudio; st.viewport.setView('top', false); st.viewport.fit(); });
  await cad.waitForTimeout(400);

  // ================================================================ the board, in a second context
  const pcb = await open('pcb');
  await pcb.goto(`${BASE}/p/${pid}/edit?doc=${pcbDoc.docId}`);
  await pcb.waitForFunction(() => window.JunctionBoardMech && window.JunctionBoardMech.mech.getState().active && window.JunctionBoardMech.mech.getState().complete, null, { timeout: 60000 });
  check('the board editor watches the project\'s part studio and finds no link yet', (await mech(pcb)).sources.length === 0 && !(await pcb.isVisible('#mechBadge')));

  // ================================================================ link the board; outline from the floor
  check('the Board panel names the project\'s board', (await cad.textContent('[data-panel=boardlink]')).includes('gadget'));
  await openPanel(cad, 'boardlink');   // folded until the part studio has to do with a board
  // the board will stand on the bosses: lay it on the floor of the pocket and raise it by their height
  await clickAt(cad, [45, 20, 2]);
  check('a click in the model selects the floor of the pocket', (await selection(cad)).join() === 'face:e2:end:pa', (await selection(cad)).join());
  await cad.click('[data-panel=boardlink] [data-act=link]');
  await cad.waitForSelector('[data-panel=boardlink] [data-section=placement]');
  check('linking lays the board on the selected face', (await cad.textContent('[data-panel=boardlink] [data-field=plane]')) === 'A face of the model' && (await linkOf(cad)).plane.ref.name === 'e2:end:pa');
  await setField(cad, '[data-panel=boardlink] [data-section=placement]', 'lift', 5);
  await linkIs(cad, (l) => l.solved && l.solved.frame && Math.abs(l.solved.frame.origin[2] - 7) < 1e-6);
  check('raised by 5: the board\'s back face is at the top of the bosses (z = 7)', true);

  // the outline: the floor face, 0.5 mm clear of the walls
  check('the floor is still selected', (await selection(cad)).join() === 'face:e2:end:pa');
  await cad.click('[data-panel=boardlink] [data-add=outline]');
  await cad.waitForSelector('[data-panel=boardlink] [data-drive-kind=outline][data-drive-state=ok]');
  await setField(cad, '[data-panel=boardlink] [data-drive-kind=outline]', 'inset', 0.5);
  await linkIs(cad, (l) => { const d = Object.values(l.solved.drives).find((x) => x.kind === 'outline'); return d && d.curves.length === 4 && Math.min(...d.curves.map((c) => c[1])) === 102500000; });
  check('the part studio solves the outline: four lines, 0.5 mm inside the pocket, in nanometres', true);
  await shot(cad, '01-studio-outline');

  await boardIs(pcb, (c) => c.edges === 4 && c.groups === 1);
  let items = await boardItems(pcb);
  // the board had the outline without the clearance a moment before: wait for the one just solved to arrive
  for (let i = 0; i < 100 && outlineBox(items)[0] !== 102.5; i++) { await pcb.waitForTimeout(100); items = await boardItems(pcb); }
  check('the board follows live: four Edge.Cuts lines appear', items.edges.length === 4 && items.edges.every((e) => e.kind === 'gr_line'));
  check('the outline is the pocket less the clearance, where the link places it (Y down)', outlineBox(items).join() === '102.5,62.5,157.5,97.5', outlineBox(items).join());
  check('every driven item is locked and grouped under the part studio\'s name', items.locked === items.driven && items.groups[0] === 'Board outline (driven by Part Studio 1)', `${items.locked}/${items.driven} ${items.groups.join()}`);
  await pcb.waitForSelector('#mechBadge');
  check('the board shows it is driven', (await pcb.textContent('#mechBadge')).includes('Driven by Part Studio 1'), await pcb.textContent('#mechBadge'));
  await pcb.evaluate(() => window.CollabApp.dispatch({ type: 'action', id: 'zoomFitScreen' }));
  await pcb.waitForTimeout(500);
  await shot(pcb, '02-board-outline');

  // ================================================================ mounting holes from the boss tops
  await clickAt(cad, [8, 8, 7]);
  for (const at of [[52, 8, 7], [52, 32, 7], [8, 32, 7]]) await clickAt(cad, at, { shift: true });
  check('four boss tops are selected by clicking them', (await selection(cad)).length === 4, (await selection(cad)).join());
  await cad.click('[data-panel=boardlink] [data-add=holes]');
  await cad.waitForSelector('[data-panel=boardlink] [data-drive-kind=holes][data-drive-state=ok]');
  await boardIs(pcb, (c) => c.holes === 4);
  items = await boardItems(pcb);
  check('four mounting holes appear on the board at the bosses', items.holes.map((h) => `${h.x},${h.y}`).sort().join(' ') === '108,68 108,92 152,68 152,92', items.holes.map((h) => `${h.x},${h.y}`).join(' '));
  check('the holes are 3.2 mm unplated footprints', await pcb.evaluate(() => { const K = window.KiCadCanvas; const doc = window.JunctionBoardMech.mech.board(); return Array.from(doc.items.values()).filter((i) => i.kind === 'footprint' && i.id.startsWith('6a756e63-')).every((i) => { const p = K.kid(i.node, 'pad'); return K.str(p[2]) === 'np_thru_hole' && K.kid(p, 'drill')[1] === 3.2; }); }));

  // ================================================================ the model changes: the board follows
  // widen the tray by 20 mm: the block, the pocket and the two right-hand bosses (edits of three sketches)
  await cad.evaluate(() => {
    const st = window.JunctionPartStudio;
    const move = (feature, moves) => ({ id: feature, kind: 'MODIFIED', typeName: 'feature', props: Object.entries(moves).map(([entity, x]) => ({ path: ['params', 'sketch', 'entities', entity, 'x'], value: x })) });
    st.commit([move('s1', { r2: 80, r3: 80 }), move('s2', { p2: 78, p3: 78 }), move('s3', { b2c: 72, b3c: 72 })]);
  });
  await boardIs(pcb, (c) => Math.abs(c.x1 - 177.5) < 0.06 && c.holeXs.filter((x) => x === 172).length === 2);
  items = await boardItems(pcb);
  check('widening the tray moves the outline on the board', outlineBox(items).join() === '102.5,62.5,177.5,97.5', outlineBox(items).join());
  check('and the two mounting holes on that side', items.holes.map((h) => h.x).sort().join() === '108,108,172,172', items.holes.map((h) => h.x).join());
  check('the same items moved: still four edges, four holes, two groups', items.edges.length === 4 && items.holes.length === 4 && items.groups.length === 2);
  await pcb.evaluate(() => window.CollabApp.dispatch({ type: 'action', id: 'zoomFitScreen' }));
  await pcb.waitForTimeout(500);
  await shot(pcb, '03-board-wider');
  // undo in the part studio takes the board back: the board is driven, its own undo list is untouched
  check('the board\'s own undo list has no step for what the model did', (await pcb.evaluate(() => window.CollabApp.getState().undo.undo)) === 0);
  await cad.evaluate(() => window.JunctionPartStudio.undo());
  await boardIs(pcb, (c) => Math.abs(c.x1 - 157.5) < 0.06);
  check('undo in the part studio moves the board\'s outline back', true);
  await cad.evaluate(() => window.JunctionPartStudio.redo());
  await boardIs(pcb, (c) => Math.abs(c.x1 - 177.5) < 0.06);

  // ================================================================ a keep-out under the rib, and the check
  // the rib's underside cannot be clicked from above: it is selected by name, then driven from the panel
  await cad.evaluate(() => window.JunctionPartStudio.select([{ kind: 'face', body: 'e1', name: 'e4:end:ka', point: [25, 20, 10] }]));
  await cad.click('[data-panel=boardlink] [data-add=keepout]');
  await cad.waitForSelector('[data-panel=boardlink] [data-drive-kind=keepout][data-drive-state=ok]');
  check('the keep-out takes its height from the model: the rib is 3 mm above the board\'s back', (await cad.textContent('[data-panel=boardlink] [data-drive-kind=keepout]')).includes('3.00 mm from the board'), await cad.textContent('[data-panel=boardlink] [data-drive-kind=keepout]'));
  await shot(cad, '04-studio-drives');
  await boardIs(pcb, (c) => c.zones === 1 && c.checked);
  items = await boardItems(pcb);
  check('a rule area appears under the rib, named with the room it leaves (3 − 1.6 board − 0.5 clearance)', items.zones.length === 1 && items.zones[0].name === 'Height ≤ 0.9 mm: Keep-out', items.zones.map((z) => z.name).join());
  check('the rule area spans the rib: x 120…130', items.zones[0].bbox && Math.abs(items.zones[0].bbox[0] - 120) < 0.3 && Math.abs(items.zones[0].bbox[2] - 130) < 0.3, JSON.stringify(items.zones[0].bbox));
  await boardIs(pcb, (c) => c.checked && c.clashes.length === 0);
  check('R1 (0.5 mm) stands under the rib and fits; nothing is flagged', (await mech(pcb)).clashes.length === 0);

  // drag the tall capacitor under the rib, as a person does (by one of its pads)
  const from = await onScreen(pcb, 143.5, 85), to = await onScreen(pcb, 123.5, 88);
  await pcb.mouse.move(from.x, from.y); await pcb.mouse.down(); await pcb.mouse.up();   // a click selects it; a drag of the selection moves it
  await pcb.waitForTimeout(200);
  await pcb.mouse.down();
  await pcb.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 }); await pcb.mouse.move(to.x, to.y, { steps: 6 });
  await pcb.mouse.up();
  const c1 = await pcb.evaluate(() => { const doc = window.JunctionBoardMech.mech.board(); for (const it of doc.items.values()) if (it.ref === 'C1') return [it.x, it.y]; return null; });
  check('C1 is dragged under the rib', c1 && Math.abs(c1[0] - 125) < 2 && Math.abs(c1[1] - 88) < 2, JSON.stringify(c1));
  await boardIs(pcb, (c) => c.clashes.length === 1 && c.clashes[0] === 'C1');
  const state = await mech(pcb);
  check('the check flags C1: taller than the rib allows', state.clashes.length === 1 && state.clashes[0].height > 0.9 && Math.abs(state.clashes[0].limit - 0.9) < 1e-6, JSON.stringify(state.clashes.map((c) => [c.ref, c.height, c.limit])));
  check('a marker is on the canvas at C1', await pcb.evaluate(() => (window.CollabApp.getState().viewport.renderOpts.markers || []).some((m) => m.code === 'enclosure_height' && /C1 is/.test(m.text))));
  check('the badge counts it', (await pcb.textContent('#mechBadge')).includes('1 too tall'), await pcb.textContent('#mechBadge'));
  await pcb.click('#mechBadge');
  await pcb.waitForSelector('#mechPanel [data-clash=C1]');
  check('the panel lists the clash in words', /C1 is [\d.]+ mm tall \(estimated\): “Keep-out” allows 0.9 mm/.test(await pcb.textContent('#mechPanel [data-clash=C1]')), await pcb.textContent('#mechPanel [data-clash=C1]'));
  // from the clash to the items on the board
  await pcb.evaluate(() => window.JunctionBoardMech.mech.select([], false));
  await pcb.click('#mechPanel [data-clash=C1] >> text=Part');
  check('"Part" selects the component', await pcb.evaluate(() => { const s = window.CollabApp.getState().selection.ids; const doc = window.JunctionBoardMech.mech.board(); return s.length === 1 && doc.items.get(s[0]).ref === 'C1'; }));
  await pcb.waitForSelector('#mechPanel [data-room]');
  check('the selected component\'s room under the enclosure is said', /C1 stands [\d.]+ mm above the front.*too tall/.test(await pcb.textContent('#mechPanel [data-room]')), await pcb.textContent('#mechPanel [data-room]'));
  await shot(pcb, '05-board-clash');

  // ================================================================ the enclosure in the 3D viewer
  await pcb.click('#mechPanel >> text=3D');
  await pcb.waitForSelector('.v3d-win', { timeout: 30000 });
  await pcb.waitForFunction(() => { const e = window.JunctionBoardMech.enclosure; return e.lastBodies === 1 && window.KiCadViewer3D.current && window.KiCadViewer3D.current.viewer.extraCount >= 1; }, null, { timeout: 120000 });
  check('the 3D viewer draws the tray around the board (a headless modelling worker on the board page)', true);
  const where = await pcb.evaluate(() => {
    // the tray's mesh in the viewer's scene: its extent against the board's
    const v = window.KiCadViewer3D.current.viewer;
    const extras = v.extras, board = v.board;
    extras.updateWorldMatrix(true, true);
    const pos = extras.children[0].geometry.getAttribute('position');
    let b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.count; i++) { const p = [pos.getX(i) + extras.position.x, pos.getY(i) + extras.position.y, pos.getZ(i)]; for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], p[k]); b[k + 3] = Math.max(b[k + 3], p[k]); } }
    return { tray: b.map((x) => Math.round(x * 100) / 100), size: board.size };
  });
  // board 75 × 35 centred on the origin; the tray is 80 × 40 around it, its floor 5 mm under the board's back (z = −1.6)
  check('the tray sits around the board: 2.5 mm proud on each side', Math.abs((where.tray[3] - where.tray[0]) - 80) < 0.01 && Math.abs((where.tray[4] - where.tray[1]) - 40) < 0.01 && Math.abs(where.tray[0] + 40) < 0.2, JSON.stringify(where));
  check('its underside is 7 mm below the board\'s back face and its rim 5 mm above', Math.abs(where.tray[2] - (-1.6 - 7)) < 0.01 && Math.abs(where.tray[5] - (-1.6 + 5)) < 0.01, JSON.stringify(where.tray));
  check('the selected component is marked, with the height the rib allows', await pcb.evaluate(() => window.KiCadViewer3D.current.viewer.extraCount === 3));
  await pcb.waitForTimeout(800);
  await shot(pcb, '06-viewer3d-see-through');
  await pcb.selectOption('.v3d-enclosure select', 'section');
  await pcb.evaluate(() => { const w = window.KiCadViewer3D.current; w.viewer.view('front'); });
  await pcb.waitForTimeout(1200);
  await shot(pcb, '07-viewer3d-section');
  // the model changes while the viewer is open
  const drawsBefore = await pcb.evaluate(() => window.JunctionBoardMech.enclosure.draws);
  await cad.evaluate(() => { const st = window.JunctionPartStudio; st.commit([{ id: 'e1', kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['params', 'depth'], value: 16 }] }]); });
  await pcb.waitForFunction((n) => {
    const e = window.JunctionBoardMech.enclosure, v = window.KiCadViewer3D.current.viewer; if (e.draws <= n || !v.extras.children.length) return false;
    // the pocket is cut from the top, so its floor (which the board stands on) rises by 4 and the underside is 11 + 1.6 below the front
    const pos = v.extras.children[0].geometry.getAttribute('position'); let low = Infinity; for (let i = 0; i < pos.count; i++) low = Math.min(low, pos.getZ(i));
    return Math.abs(low - (-1.6 - 11)) < 0.01;
  }, drawsBefore, { timeout: 60000 });
  check('a deeper tray in the part studio is a deeper tray in the board\'s 3D viewer', true);
  await pcb.selectOption('.v3d-enclosure select', 'see-through');
  await pcb.evaluate(() => window.KiCadViewer3D.current.close());

  // ================================================================ a lost reference; break link
  // make the rib 1 mm thinner: its underside is 1 mm further from the board, and the limit follows
  await cad.evaluate(() => { const st = window.JunctionPartStudio; st.commit([{ id: 'e4', kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['params', 'depth'], value: 1 }] }]); });
  await boardIs(pcb, (c) => c.zones === 1);
  await pcb.waitForFunction(() => { const K = window.KiCadCanvas, doc = window.JunctionBoardMech.mech.board(); for (const it of doc.items.values()) if (it.kind === 'zone' && it.id.startsWith('6a756e63-')) return K.str(K.kid(it.node, 'name')[1]) === 'Height ≤ 1.9 mm: Keep-out'; return false; }, null, { timeout: 30000 });
  check('the height limit follows the model: a thinner rib leaves 1.9 mm under it', true);
  // suppress the rib: its face is gone; the keep-out stays and is reported as not following
  await cad.evaluate(() => { const st = window.JunctionPartStudio; st.commit([{ id: 'e4', kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['suppressed'], value: true }] }]); });
  await cad.waitForSelector('[data-panel=boardlink] [data-drive-kind=keepout][data-drive-state=error]');
  await pcb.waitForSelector('#mechPanel [data-drive-kind=keepout][data-stale]');
  check('a drive whose face is gone says so in both editors, and the board keeps its rule area', (await boardItems(pcb)).zones.length === 1 && (await pcb.textContent('#mechPanel [data-drive-kind=keepout]')).includes('Not following'));
  await cad.evaluate(() => { const st = window.JunctionPartStudio; st.commit([{ id: 'e4', kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['suppressed'], del: true }] }]); });
  await cad.waitForSelector('[data-panel=boardlink] [data-drive-kind=keepout][data-drive-state=ok]');

  // jump from the clash to the model: the part studio opens at the rib's face, with C1 drawn where it stands
  await boardIs(pcb, (c) => c.clashes.length === 1);
  await pcb.click('#mechPanel [data-clash=C1] >> text=Model');
  await pcb.waitForSelector('.cad-root[data-doc-kind=part-studio]', { timeout: 60000 });
  await pcb.waitForFunction(() => { const st = window.JunctionPartStudio; return st && st.getState().selection.some((p) => p.name === 'e4:end:ka'); }, null, { timeout: 60000 });
  check('"Model" on a clash opens the part studio with the face that makes the keep-out selected', true);
  await pcb.waitForSelector('[data-panel=boardlink] [data-probe]');
  check('and says which component is too tall there', /C1 is [\d.]+ mm tall/.test(await pcb.textContent('[data-panel=boardlink] [data-probe]')), await pcb.textContent('[data-panel=boardlink] [data-probe]'));
  await pcb.waitForFunction(() => window.JunctionPartStudio.view.overlay.children.length > 0, null, { timeout: 10000 });
  const boxAt = await pcb.evaluate(() => { const g = window.JunctionPartStudio.view.overlay.children[0].geometry; g.computeBoundingBox(); const b = g.boundingBox; return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => Math.round(v * 100) / 100); });
  // C1 is at (125, 88) on the sheet, its body 5.5 × 5.5: x 22.25…27.75, y 9.25…14.75 in the model; it stands on the board's front (z = 11 + 1.6) and is 4.95 tall
  check('the component is drawn in the model where it stands on the board', boxAt.join() === '22.25,9.25,12.6,27.75,14.75,17.55', boxAt.join());
  await settled(pcb, 8);
  await pcb.evaluate(() => { const st = window.JunctionPartStudio; st.viewport.setView('iso', false); st.viewport.fit(); });
  await pcb.waitForTimeout(600);
  await shot(pcb, '08-jump-to-model');
  // and back: Open in the Board panel returns to the board, which is reconciled on open
  await pcb.click('[data-panel=boardlink] [data-act=open-board]');
  await pcb.waitForFunction(() => window.JunctionBoardMech.mech.getState().active && window.JunctionBoardMech.mech.getState().complete && window.JunctionBoardMech.mech.getState().sources.length === 1, null, { timeout: 60000 });
  await pcb.waitForSelector('#mechPanel', { state: 'visible' });
  check('"Open" in the Board panel returns to the board with the link\'s panel open', true);

  // break the outline's link from the board
  await pcb.click('#mechPanel [data-drive-kind=outline] >> text=Break link');
  await boardIs(pcb, (c) => c.edges === 4 && c.unlockedEdges === 4 && c.groups === 2);
  check('Break link: the outline stays on the board, unlocked, and is no longer grouped as driven', true);
  check('the part studio no longer drives an outline', (await cad.evaluate(() => { for (const i of window.JunctionPartStudio.doc.items.values()) if (i.type === 'board-link') return Object.values(i.drives).map((d) => d.kind).sort().join(); })) === 'holes,keepout');
  await shot(pcb, '09-board-link-broken');

  // ================================================================ reconciled on open
  // close the board, change the model, open the board again
  await pcb.goto(`${BASE}/`);
  await cad.evaluate(() => { const st = window.JunctionPartStudio; st.commit([{ id: 's3', kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['params', 'sketch', 'entities', 'b1c', 'x'], value: 12 }, { path: ['params', 'sketch', 'entities', 'b4c', 'x'], value: 12 }] }]); });
  await linkIs(cad, (l) => { const d = Object.values(l.solved.drives).find((x) => x.kind === 'holes'); return d && d.holes.filter((h) => h[0] === 112000000).length === 2; });
  check('with no browser on the board, the part studio still solves the link (the answer waits in its document)', true);
  await pcb.goto(`${BASE}/p/${pid}/edit?doc=${pcbDoc.docId}`);
  await pcb.waitForFunction(() => window.JunctionBoardMech && window.JunctionBoardMech.mech.getState().complete, null, { timeout: 60000 });
  await boardIs(pcb, (c) => c.holeXs.filter((x) => x === 112).length === 2);
  check('opening the board reconciles it: the two holes are where the bosses now are', true);
  // a third browser finds the board as it was left: the driven items came through the board's stored ops, and
  // being a function of the link, there is nothing for its reconciler to write
  const late = await open('late');
  await late.goto(`${BASE}/p/${pid}/edit?doc=${pcbDoc.docId}`);
  await late.waitForFunction(() => window.JunctionBoardMech && window.JunctionBoardMech.mech.getState().complete && window.JunctionBoardMech.mech.getState().checked, null, { timeout: 60000 });
  await late.waitForTimeout(1200);
  const lateItems = await boardItems(late);
  check('another browser opening the board finds the same driven items and writes nothing', lateItems.holes.length === 4 && lateItems.zones.length === 1 && (await late.evaluate(() => window.JunctionBoardMech.mech.getState().writes)) === 0, JSON.stringify([lateItems.holes.length, lateItems.zones.length]));
  await late.evaluate(() => window.CollabApp.dispatch({ type: 'action', id: 'zoomFitScreen' }));
  await late.waitForTimeout(500);
  await shot(late, '10-board-reopened');
  void studioDocId;
} catch (e) {
  check('the run completes', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
} finally {
  check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
