// Browser test of the board in CAD (web/domains/mechanical/board, features/board-*.ts): two people, one project.
//
//   1. Alice opens the Devboard Demo, adds a part studio, and brings the board in with the Board feature: it is
//      drawn as the board looks (laminate, face images, part models) over invisible reference solids with names.
//   2. She puts an Opening in front of the USB connector's envelope and an enclosure wall around the board.
//   3. Bob opens the board in the board editor, sees "Used in Part Studio 1", and drags the USB connector along
//      the edge with the mouse.  Alice's part studio follows: the connector in the display model at once, the
//      opening in the wall after the regeneration.  The latency of both is measured.
//   4. Bob follows the "Used in" button into the part studio.
//   5. The same on a synthetic board with a few hundred footprints (E2E_BIG, default 320), for the numbers,
//      with Standoffs under two of its mounting holes.
//
// Setup as scripts/cad-ui.mjs: a server with KC_DEV_LOGIN=1 on a throwaway database, Playwright, psql.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/cad-board-ui.mjs
//
// E2E_ONLY_BIG=1 skips 1 to 4.  E2E_STATIC_DIR=<a checkout's server/static> serves the page's bundles from that folder instead of from the
// server, for testing a build against a server binary that was compiled from another checkout (the bundles are
// compiled into the binary).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { tool, toolTitles, openPanel } = await import(new URL('./cad-chrome.mjs', import.meta.url));

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '', STATIC = process.env.E2E_STATIC_DIR || '';
const BIG = Number(process.env.E2E_BIG || 320);
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
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const ms = (v) => `${v.toFixed(v < 10 ? 1 : 0)} ms`;

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
async function open(uid, login) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  if (STATIC) await ctx.route('**/static/**', (route) => {
    const file = path.join(STATIC, new URL(route.request().url()).pathname.replace(/^\/static\//, ''));
    if (TYPES[path.extname(file)] && fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(file)] });
    return route.continue();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}

// ---------------------------------------------------------------- the part studio, as a person drives it
/** The studio is loaded, no dialog is open, the kernel is idle and every built feature has reported. */
const settled = (page, n) => page.waitForFunction((n) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, n, { timeout: 120000 });
const click = async (page, x, y) => { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up(); };

async function newPartStudio(page) {
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForSelector('.cad-root[data-doc-kind=part-studio]', { timeout: 60000 });
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 60000 });
}

/** Board feature through its dialog: choose the board, lift it `z` mm, Done. */
async function addBoard(page, z, minHole) {
  await tool(page, 'Board');
  await page.waitForSelector('.cad-dialog[data-feature=board-reference]');
  const boards = await page.$$eval('.cad-dialog select[data-param=board] option', (els) => els.map((e) => e.value).filter(Boolean));
  await page.selectOption('.cad-dialog select[data-param=board]', boards[0]);
  await page.fill('.cad-dialog input[data-param=z]', String(z));
  if (minHole !== undefined) await page.fill('.cad-dialog input[data-param=minHole]', String(minHole));
  // the preview: the board has been read and built while the dialog is still open
  await page.waitForFunction((minHole) => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.bodies.some((b) => b.id.endsWith(':board') && b.mesh && (!minHole || b.mesh.faces.names.some((n) => n.includes(':hole:')))) && s.editing && Array.isArray(s.editing.draft.params.origin); }, minHole, { timeout: 180000 });
  return boards;
}

/** Where a named face of a body is on screen (its centre, moved by `offset` mm), after framing a box of `pad` mm around it. */
async function faceOnScreen(page, bodySuffix, pick, pad, offset = [0, 0, 0]) {
  return page.evaluate(({ bodySuffix, pick, pad, offset }) => {
    const studio = window.JunctionPartStudio, s = studio.getState();
    const body = s.bodies.find((b) => b.id.endsWith(bodySuffix)), m = body.mesh;
    const centre = (i) => { const c = [0, 0, 0]; let n = 0; for (let k = m.faces.start[i]; k < m.faces.start[i] + m.faces.count[i]; k++) { const v = m.indices[k] * 3; c[0] += m.positions[v]; c[1] += m.positions[v + 1]; c[2] += m.positions[v + 2]; n++; } return c.map((x) => x / n); };
    // `pick` is a name ending, or "+x": the side face of the part named before it that looks furthest along x
    let index = -1;
    if (pick.side) { let best = -Infinity; m.faces.names.forEach((name, i) => { if (!name.includes(`:part:${pick.part}:`) || !/:[xy][+-]$/.test(name)) return; const c = centre(i); if (c[0] > best) { best = c[0]; index = i; } }); }
    else index = m.faces.names.findIndex((name) => name.endsWith(pick.name));
    if (index < 0) return null;
    const c = centre(index), v = studio.viewport.target.clone();
    const box = studio.viewport.contentBox(); box.makeEmpty();
    box.expandByPoint(v.clone().set(c[0] - pad, c[1] - pad, c[2] - pad)); box.expandByPoint(v.clone().set(c[0] + pad, c[1] + pad, c[2] + pad));
    studio.viewport.setView('iso', false); studio.viewport.fit(box);
    const p = studio.viewport.project(v.clone().set(c[0] + offset[0], c[1] + offset[1], c[2] + offset[2])), r = studio.viewport.canvas.getBoundingClientRect();
    return { x: r.left + p.x, y: r.top + p.y, name: m.faces.names[index], body: body.id, centre: c };
  }, { bodySuffix, pick, pad, offset });
}

/** Opening feature through its dialog: click the face on screen, set the reach, Done. */
async function addOpening(page, at, reach, back) {
  await tool(page, 'Opening');
  await page.waitForSelector('.cad-dialog[data-feature=board-cutout]');
  await page.waitForTimeout(300);
  await click(page, at.x, at.y);
  await page.waitForFunction(() => { const e = window.JunctionPartStudio.getState().editing; return e && e.draft.params.face; }, null, { timeout: 10000 });
  await page.fill('.cad-dialog input[data-param=depth]', String(reach));
  await page.fill('.cad-dialog input[data-param=back]', String(back));
  const face = await page.evaluate(() => window.JunctionPartStudio.getState().editing.draft.params.face);
  await page.click('.cad-dialog [data-accept]');
  return face;
}

/**
 * An enclosure wall around the board, inserted before the Opening: a ring `gap` mm clear of the board's outline
 * box and `t` thick, `h` tall.  The sketch and the extrusion are committed as the Sketch and Extrude tools would
 * (drawing two exact rectangles with the mouse is scripts/cad-ui.mjs's subject, not this script's).
 */
async function addWall(page, gap, t, h) {
  return page.evaluate(({ gap, t, h }) => {
    const studio = window.JunctionPartStudio, s = studio.getState();
    const board = s.bodies.find((b) => b.id.endsWith(':board')).mesh.bbox;
    const rect = (x0, y0, x1, y1, p) => ({
      [`${p}1`]: { type: 'point', x: x0, y: y0 }, [`${p}2`]: { type: 'point', x: x1, y: y0 }, [`${p}3`]: { type: 'point', x: x1, y: y1 }, [`${p}4`]: { type: 'point', x: x0, y: y1 },
      [`${p}a`]: { type: 'line', a: `${p}1`, b: `${p}2` }, [`${p}b`]: { type: 'line', a: `${p}2`, b: `${p}3` }, [`${p}c`]: { type: 'line', a: `${p}3`, b: `${p}4` }, [`${p}d`]: { type: 'line', a: `${p}4`, b: `${p}1` },
    });
    const inner = [board[0] - gap, board[1] - gap, board[3] + gap, board[4] + gap], outer = [inner[0] - t, inner[1] - t, inner[2] + t, inner[3] + t];
    const first = s.features[0].order, sketch = crypto.randomUUID(), extrude = crypto.randomUUID();
    studio.commit([
      { id: sketch, kind: 'ADDED', typeName: 'feature', item: { id: sketch, type: 'feature', featureType: 'sketch', name: 'Wall sketch', order: first + 'F', params: { plane: { kind: 'plane', plane: 'top' }, sketch: { version: 1, entities: { ...rect(...outer, 'o'), ...rect(...inner, 'i') }, constraints: {} } } } },
      { id: extrude, kind: 'ADDED', typeName: 'feature', item: { id: extrude, type: 'feature', featureType: 'extrude', name: 'Wall', order: first + 'V', params: { profile: { sketch, regions: null }, operation: 'new', endType: 'blind', depth: h, flip: false, targets: [] } } },
    ]);
    return { wall: extrude, order: window.JunctionPartStudio.getState().features.map((f) => f.featureType), outer };
  }, { gap, t, h });
}

/** The opening in the wall: the box of the four faces the Opening left in it, and the wall's volume. */
const openingBox = (page) => page.evaluate(() => {
  const s = window.JunctionPartStudio.getState();
  const opening = s.features.find((f) => f.featureType === 'board-cutout'), wall = s.features.find((f) => f.featureType === 'extrude');
  const body = s.bodies.find((b) => b.id === wall.id); if (!body || !body.mesh) return null;
  const m = body.mesh, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let faces = 0;
  m.faces.names.forEach((name, i) => {
    if (!name.startsWith(`${opening.id}:side:`)) return;
    faces++;
    for (let k = m.faces.start[i]; k < m.faces.start[i] + m.faces.count[i]; k++) for (let a = 0; a < 3; a++) { const v = m.positions[m.indices[k] * 3 + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; }
  });
  return { faces, lo, hi, centre: lo.map((v, a) => (v + hi[a]) / 2), status: s.features.map((f) => `${f.featureType}:${s.reports[f.id] ? s.reports[f.id].status : '?'}`).join(' ') };
});
/** Where a part is on the board as the part studio's reader has it (board millimetres). */
const partAt = (page, ref) => page.evaluate((ref) => {
  const link = window.JunctionBoardLink, b = link.boards()[0], c = link.reader(b.docId).components().find((x) => x.ref === ref);
  return c ? { x: c.x, y: c.y } : null;
}, ref);
const linkStats = (page) => page.evaluate(() => {
  const l = window.JunctionBoardLink;
  return JSON.parse(JSON.stringify({ stats: l.stats, boards: l.boards(), display: Array.from(l.shown.values()).map((x) => x.display.stats) }));
});

// ---------------------------------------------------------------- the board editor, as a person drives it
async function openBoardEditor(page, url) {
  await page.goto(url);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 60000 });
  await page.click('#doctabs [role=tab][data-doc-type=kicad_pcb]');
  await page.waitForFunction(() => { const s = window.CollabApp.getState(); return s.view === 'editor' && s.document.editor === 'pcb' && s.connection.status === 'live'; }, null, { timeout: 90000 });
  await page.waitForTimeout(1500);
}
/** Board millimetres → screen pixels, read off the status bar's cursor position at two places. */
async function calibrate(page) {
  const stage = await page.$eval('#stage', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  const read = async (x, y) => {
    await page.mouse.move(x, y); await page.waitForTimeout(250);
    const m = /X\s*(-?[\d.]+)\s*Y\s*(-?[\d.]+)/.exec(await page.$eval('#statusbar', (el) => el.innerText.replace(/\s+/g, ' ')));
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const a = [stage.x + stage.w * 0.15, stage.y + stage.h * 0.2], b = [stage.x + stage.w * 0.85, stage.y + stage.h * 0.8];
  const ma = await read(...a), mb = await read(...b);
  if (!ma || !mb) return null;
  const kx = (b[0] - a[0]) / (mb[0] - ma[0]), ky = (b[1] - a[1]) / (mb[1] - ma[1]);
  return { px: (x, y) => [a[0] + (x - ma[0]) * kx, a[1] + (y - ma[1]) * ky], scale: kx };
}
/** Drag whatever is at `from` (board mm) to `to`, in steps, as a hand would.  Returns when the button went up. */
async function drag(page, cal, from, to, steps = 8) {
  const [x0, y0] = cal.px(...from), [x1, y1] = cal.px(...to);
  // as in KiCad, a drag moves what is selected: the first click selects, the second press drags
  await page.mouse.move(x0, y0); await page.waitForTimeout(120);
  await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(200);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await page.waitForTimeout(25); }
  const t = Date.now();
  await page.mouse.up();
  return t;
}

// ---------------------------------------------------------------- a synthetic board with a few hundred footprints
function bigBoard(n) {
  let id = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;
  const W = 200, H = 140, X0 = 50, Y0 = 40;
  const out = [`(kicad_pcb (version 20241229) (generator "pcbnew") (general (thickness 1.6))`,
    ` (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (7 "B.SilkS" user) (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user) (31 "F.CrtYd" user) (29 "B.CrtYd" user) (35 "F.Fab" user) (36 "B.Fab" user))`,
    ` (net 0 "") (net 1 "GND") (net 2 "VCC")`];
  const edge = (a, b) => out.push(` (gr_line (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "${uuid()}"))`);
  const c = [[X0, Y0], [X0 + W, Y0], [X0 + W, Y0 + H], [X0, Y0 + H]];
  c.forEach((p, i) => edge(p, c[(i + 1) % 4]));
  const fp = (lib, ref, x, y, rot, attr, w, h, pads) => out.push(` (footprint "${lib}" (layer "F.Cu") (uuid "${uuid()}") (at ${x} ${y}${rot ? ' ' + rot : ''})
  (property "Reference" "${ref}" (at 0 ${-h / 2 - 1} ${rot}) (layer "F.SilkS") (uuid "${uuid()}") (effects (font (size 0.8 0.8) (thickness 0.12))))
  (attr ${attr})
  (fp_rect (start ${-w / 2} ${-h / 2}) (end ${w / 2} ${h / 2}) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "${uuid()}"))
  (fp_rect (start ${-w / 2 + 0.2} ${-h / 2 + 0.2}) (end ${w / 2 - 0.2} ${h / 2 - 0.2}) (stroke (width 0.12) (type default)) (fill no) (layer "F.SilkS") (uuid "${uuid()}"))
  ${pads})`);
  const smd = (num, x, y, w, h, net) => `(pad "${num}" smd roundrect (at ${x} ${y}) (size ${w} ${h}) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (net ${net} "${net === 1 ? 'GND' : 'VCC'}") (uuid "${uuid()}"))`;
  const npth = (d) => `(pad "" np_thru_hole circle (at 0 0) (size ${d} ${d}) (drill ${d}) (layers "*.Cu" "*.Mask") (uuid "${uuid()}"))`;
  const tht = (num, x, y) => `(pad "${num}" thru_hole circle (at ${x} ${y}) (size 1.7 1.7) (drill 1) (layers "*.Cu" "*.Mask") (net 1 "GND") (uuid "${uuid()}"))`;
  [[5, 5], [W - 5, 5], [W - 5, H - 5], [5, H - 5]].forEach((p, i) => fp('MountingHole:MountingHole_3.2mm_M3', `H${i + 1}`, X0 + p[0], Y0 + p[1], 0, 'exclude_from_pos_files exclude_from_bom', 6.4, 6.4, npth(3.2)));
  // the connector the test drags, at the right edge
  fp('Connector_USB:USB_C_Receptacle_Test', 'J1', X0 + W - 4.5, Y0 + 70, 90, 'smd', 9.5, 8, [smd(1, -3, -3, 0.6, 1.2, 1), smd(2, -1, -3, 0.6, 1.2, 2), smd(3, 1, -3, 0.6, 1.2, 2), smd(4, 3, -3, 0.6, 1.2, 1)].join(' '));
  let made = 5, row = 0;
  for (let y = 14; y < H - 10 && made < n; y += 6.5, row++) {
    for (let x = 14; x < W - 16 && made < n; x += 7) {
      const k = made % 9;
      if (k === 0) fp('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', `U${made}`, X0 + x, Y0 + y, 0, 'smd', 6.2, 5.4, [0, 1, 2, 3].map((i) => smd(i + 1, -2.7, -1.9 + i * 1.27, 1.5, 0.6, 1) + ' ' + smd(8 - i, 2.7, -1.9 + i * 1.27, 1.5, 0.6, 2)).join(' '));
      else if (k === 4) fp('Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical', `J${made}`, X0 + x, Y0 + y, 0, 'through_hole', 3, 5.6, tht(1, 0, -1.27) + ' ' + tht(2, 0, 1.27));
      else fp(k % 2 ? 'Resistor_SMD:R_0603_1608Metric' : 'Capacitor_SMD:C_0603_1608Metric', `${k % 2 ? 'R' : 'C'}${made}`, X0 + x, Y0 + y, (made % 4) * 90, 'smd', 3, 1.6, smd(1, -0.8, 0, 0.9, 0.95, 1) + ' ' + smd(2, 0.8, 0, 0.9, 0.95, 2));
      made++;
    }
    // a track along each row, and vias
    out.push(` (segment (start ${X0 + 12} ${Y0 + y + 2.6}) (end ${X0 + W - 18} ${Y0 + y + 2.6}) (width 0.25) (layer "F.Cu") (net 2) (uuid "${uuid()}"))`);
    for (let x = 20; x < W - 20; x += 15) out.push(` (via (at ${X0 + x} ${Y0 + y + 2.6}) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 2) (uuid "${uuid()}"))`);
  }
  out.push(')');
  return { text: out.join('\n'), footprints: made, connector: [X0 + W - 4.5, Y0 + 70] };
}

try {
  // new people every run: each gets a Devboard Demo of their own, as it ships
  const run = Date.now() % 400000000, ALICE = `cad-board-alice-${run}`, BOB = `cad-board-bob-${run}`;
  const aliceId = user(ALICE, 1000000000 + run * 2), bobId = user(BOB, 1000000001 + run * 2);
  const alice = await open(aliceId, ALICE);

  // ================================================================ 1. the demo board in a part studio
  let bob = null;
  if (!process.env.E2E_ONLY_BIG) {
  const demo = await alice.evaluate(async () => { const r = await fetch('/api/projects/demo', { method: 'POST' }); return { status: r.status, body: await r.json().catch(() => null) }; });
  check('the Devboard Demo opens', demo.status === 200 && !!demo.body?.projectId, `status ${demo.status}`);
  const pid = demo.body.projectId;
  await alice.goto(`${BASE}/p/${pid}/edit`);
  await alice.waitForSelector('#doctabs [role=tab]', { timeout: 60000 });
  await newPartStudio(alice);
  check('the part studio has the Board, Opening and Standoffs tools', (await toolTitles(alice)).filter((t) => ['Board', 'Opening', 'Standoffs'].includes(t)).length === 3);
  check('the Board panel says how to start', /Choose Board/.test(await alice.textContent('[data-panel=boardlink]')));

  const t0 = Date.now();
  const boards = await addBoard(alice, 4, 0.9);
  check('the Board dialog lists the project\'s board and previews it', boards.length === 1, `${Date.now() - t0} ms from the click to the preview (kernel start included)`);
  await alice.waitForTimeout(1200);
  await shot(alice, '01-board-dialog');
  await alice.click('.cad-dialog [data-accept]');
  await settled(alice, 1);
  await alice.waitForFunction(() => { const l = window.JunctionBoardLink, d = Array.from(l.shown.values())[0]; return d && d.display.group.visible && d.display.stats.faceBuilds >= 2; }, null, { timeout: 120000 });
  const built = await alice.evaluate(() => {
    const studio = window.JunctionPartStudio, s = studio.getState(), f = s.features[0];
    const board = s.bodies.find((b) => b.id === `${f.id}:board`), parts = s.bodies.find((b) => b.id === `${f.id}:parts`);
    const display = studio.viewport.scene.getObjectByName('board-display');
    let meshes = 0, tris = 0, hidden = 0;
    display.traverse((o) => { if (o.isMesh) { meshes++; tris += (o.geometry.index ? o.geometry.index.count : 0) / 3; } });
    studio.viewport.scene.traverse((o) => { if (o.isMesh && !o.visible && o.geometry.index && o.material.type === 'MeshStandardMaterial') hidden++; });
    return { status: s.reports[f.id].status, message: s.reports[f.id].message || '', origin: f.params.origin, hasTransient: JSON.stringify(studio.session.doc).includes('$board'),
      board: board && board.mesh ? { faces: board.mesh.faces.names.length, holes: board.mesh.faces.names.filter((n) => n.includes(':hole:')).length, named: board.mesh.faces.names.includes(`${f.id}:hole:J1:1`) && board.mesh.faces.names.includes(`${f.id}:front`), bbox: board.mesh.bbox.map((v) => Math.round(v * 100) / 100) } : null,
      parts: parts && parts.mesh ? { faces: parts.mesh.faces.names.length, usb: parts.mesh.faces.names.filter((n) => n.includes(':part:USB1:')).length } : null, meshes, tris, hidden };
  });
  // the parts' 3D models arrive one by one; their envelopes are measured from them, so wait until they are in
  await alice.evaluate(() => window.JunctionBoardLink.modelsSettled());
  await alice.waitForTimeout(600);
  await settled(alice, 1);
  const st = await linkStats(alice);
  check('the Board feature builds two reference bodies with named faces', built.status !== 'error' && !!built.board && built.board.named && !!built.parts && built.parts.usb === 6, JSON.stringify({ status: built.status, board: built.board, parts: built.parts }));
  check('the board lies 4 mm above the Top plane', !!built.board && built.board.bbox[2] === 4, JSON.stringify(built.board && built.board.bbox));
  check('the feature keeps the board\'s origin; the board itself is not stored in the part studio', Array.isArray(built.origin) && !built.hasTransient, JSON.stringify(built.origin));
  check('the display model is drawn (a mesh per part, the laminate, two face images) over hidden solids', built.meshes >= 60 && built.hidden >= 2 && st.display[0].faceBuilds >= 2, `${built.meshes} meshes, ${Math.round(built.tris)} triangles, ${st.display[0].realModels} parts from their 3D models; laminate ${ms(st.display[0].slabMs)}, a face image ${ms(st.display[0].facesMs)}`);
  check('the Board panel shows the board live', (await alice.getAttribute('[data-panel=boardlink] [data-board]', 'data-state')) === 'live', await alice.textContent('[data-panel=boardlink]'));
  await alice.evaluate(() => { window.JunctionPartStudio.setPlanesVisible(false); window.JunctionPartStudio.viewport.fit(); });
  await alice.waitForTimeout(900);
  await shot(alice, '02-board-in-part-studio');

  // hovering the display model finds the reference solid underneath, by name
  const usbFace = await faceOnScreen(alice, ':parts', { side: true, part: 'USB1' }, 9);
  check('the USB connector\'s envelope has a face that looks out of the board', !!usbFace, usbFace ? usbFace.name.split(':').slice(-3).join(':') : '');
  await alice.waitForTimeout(500);
  await alice.mouse.move(usbFace.x, usbFace.y); await alice.waitForTimeout(250);
  const hover = await alice.evaluate(() => window.JunctionPartStudio.getState().hover);
  check('hovering the connector finds that face by name', !!hover && hover.kind === 'face' && hover.name === usbFace.name, JSON.stringify(hover && { kind: hover.kind, name: hover.name.split(':').slice(-3).join(':') }));
  await shot(alice, '03-hover-connector-face');

  // ================================================================ 2. an opening in front of it, and a wall to cut
  const face = await addOpening(alice, usbFace, 8, 3);
  check('the Opening dialog takes the clicked face as a named reference', !!face && face.name === usbFace.name && face.body === usbFace.body);
  await settled(alice, 2);
  const wall = await addWall(alice, 1, 2, 12);
  check('the wall goes in before the opening', wall.order.join() === 'board-reference,sketch,extrude,board-cutout', wall.order.join());
  await settled(alice, 4);
  let box = await openingBox(alice);
  check('the opening is cut through the wall', !!box && box.faces === 4 && /board-cutout:ok/.test(box.status), JSON.stringify(box && { status: box.status, lo: box.lo.map((v) => Math.round(v * 100) / 100), hi: box.hi.map((v) => Math.round(v * 100) / 100) }));
  const usb0 = await partAt(alice, 'USB1');
  await alice.evaluate(() => { window.JunctionPartStudio.viewport.setView('iso', false); window.JunctionPartStudio.viewport.fit(); });
  await alice.waitForTimeout(900);
  await shot(alice, '04-enclosure-with-opening');

  // ================================================================ 3. Bob drags the connector in the board editor
  const invited = await alice.evaluate(async ({ pid, login }) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, role: 'editor' }) })).status, { pid, login: BOB });
  check('Bob is invited as an editor', invited === 200 || invited === 201 || invited === 204, `status ${invited}`);
  bob = await open(bobId, BOB);
  await openBoardEditor(bob, `${BASE}/p/${pid}/edit`);
  await bob.waitForSelector('#cadUsage [data-cad-usage]', { timeout: 60000 }).catch(() => {});
  const usedIn = await bob.$eval('#cadUsage [data-cad-usage]', (el) => el.textContent).catch(() => '');
  check('the board editor says which part studio uses the board', /Used in Part Studio 1/.test(usedIn), usedIn);
  const cal = await calibrate(bob);
  check('the board editor\'s cursor position calibrates the mouse', !!cal, cal ? `${cal.scale.toFixed(2)} px/mm` : '');
  await shot(bob, '05-bob-board-editor');

  const before = await linkStats(alice);
  const up = await drag(bob, cal, [usb0.x, usb0.y], [usb0.x, usb0.y - 3]);
  // the display follows at once …
  await alice.waitForFunction((n) => window.JunctionBoardLink.stats.updates > n, before.stats.updates, { timeout: 30000, polling: 5 });
  const seen = Date.now();
  const usb1 = await partAt(alice, 'USB1');
  check('Alice\'s part studio sees the connector move', !!usb1 && Math.abs(usb1.y - usb0.y) > 1 && Math.abs(usb1.x - usb0.x) < 0.5, `USB1 ${usb0.x}, ${usb0.y} → ${usb1.x}, ${usb1.y}`);
  // … and the opening after the regeneration
  await alice.waitForFunction((n) => window.JunctionBoardLink.stats.regens > n && window.JunctionPartStudio.getState().kernel.state === 'ready', before.stats.regens, { timeout: 60000 });
  await alice.waitForFunction(() => !window.JunctionBoardLink.busy && window.JunctionPartStudio.getState().kernel.state === 'ready', null, { timeout: 60000 });
  await settled(alice, 4);
  const box2 = await openingBox(alice);
  const dBoard = usb1.y - usb0.y;                    // board Y is down; the part studio's Y is up
  const dOpening = box2.centre[1] - box.centre[1];
  check('the opening in the wall follows the connector', box2.faces === 4 && /board-cutout:ok/.test(box2.status) && Math.abs(dOpening + dBoard) < 0.02, `connector ${dBoard.toFixed(2)} mm on the board, opening ${dOpening.toFixed(2)} mm in the part studio`);
  const after = await linkStats(alice);
  const sample = after.stats.samples[after.stats.samples.length - 1];
  console.log(`      demo board (${after.boards[0].parts} footprints): the op took ${ms(sample.apply)} to apply and ${ms(sample.read)} to read; display updated ${ms(sample.display)} after it arrived (${sample.parts} part mesh rebuilt); ` +
    `dependent features on screen ${ms(after.stats.lastRegenMs)} after the first op of the drag arrived (worker ${ms(after.stats.lastWorkerMs)} inside a round trip of ${ms(after.stats.lastRoundtripMs)}; the rest is the drag itself and the 260 ms wait for edits to stop); mouse-up to display ≤ ${seen - up} ms end to end`);
  check('one moved footprint rebuilds one part mesh', after.stats.samples.slice(before.stats.samples.length).every((x) => x.parts === 1), `${after.stats.samples.length - before.stats.samples.length} updates (the editor sends a dragged footprint's place as it goes)`);
  await alice.waitForFunction((n) => Array.from(window.JunctionBoardLink.shown.values())[0].display.stats.faceBuilds > n, before.display[0].faceBuilds, { timeout: 30000 });
  await alice.waitForTimeout(600);
  await shot(alice, '06-opening-followed');
  await shot(bob, '07-bob-after-drag');
  const drawn = (await linkStats(alice)).display[0];
  // this connector has drilled shell tabs, so its holes in the laminate move too: once the drag is over
  check('the laminate and the face images are redone after the drag, not for every step of it', drawn.faceBuilds > before.display[0].faceBuilds && drawn.faceBuilds - before.display[0].faceBuilds <= 4 && drawn.slabBuilds - before.display[0].slabBuilds <= 2,
    `laminate ${drawn.slabBuilds - before.display[0].slabBuilds}× (${ms(drawn.slabMs)}), a face image ${drawn.faceBuilds - before.display[0].faceBuilds}× (${ms(drawn.facesMs)} each)`);
  const peers = await bob.evaluate(() => window.CollabApp.getState().peers.list.map((p) => p.name));
  console.log(`      in the board editor Bob's people list shows: ${peers.length ? peers.join(', ') : 'nobody'} (Alice follows the board from her part studio)`);

  // an edit that changes nothing the features use (a low part) regenerates nothing
  const r1 = await partAt(alice, 'R1');
  const beforeLow = await linkStats(alice);
  if (r1) {
    await drag(bob, cal, [r1.x, r1.y], [r1.x + 1.5, r1.y]);
    await alice.waitForFunction((n) => window.JunctionBoardLink.stats.updates > n, beforeLow.stats.updates, { timeout: 30000 }).catch(() => {});
    await alice.waitForTimeout(800);
    const afterLow = await linkStats(alice);
    check('moving a low part updates the display and regenerates nothing', afterLow.stats.updates > beforeLow.stats.updates && afterLow.stats.regens === beforeLow.stats.regens, `updates ${beforeLow.stats.updates} → ${afterLow.stats.updates}, regenerations ${beforeLow.stats.regens} → ${afterLow.stats.regens}`);
  }

  // ================================================================ 4. from the board to the part studio
  await bob.click('#cadUsage [data-cad-usage]');
  await bob.waitForSelector('.cad-root[data-doc-kind=part-studio]', { timeout: 60000 });
  await settled(bob, 4);
  const bobBox = await openingBox(bob);
  check('"Used in" opens the part studio, and Bob sees the same opening', !!bobBox && bobBox.faces === 4 && Math.abs(bobBox.centre[1] - box2.centre[1]) < 0.02);
  await bob.evaluate(() => { window.JunctionPartStudio.setPlanesVisible(false); window.JunctionPartStudio.viewport.fit(); });
  await bob.waitForTimeout(1500);
  await shot(bob, '08-bob-in-part-studio');
  // and back, from the Boards panel
  await bob.click('[data-panel=boardlink] [data-open-board]');
  await bob.waitForFunction(() => { const s = window.CollabApp.getState(); return s.view === 'editor' && s.document.editor === 'pcb'; }, null, { timeout: 60000 });
  check('the Boards panel\'s Open goes to the board editor', true);

  }

  // ================================================================ 5. a few hundred footprints
  if (!bob) bob = await open(bobId, BOB);
  if (BIG > 0) {
    const big = bigBoard(BIG);
    const made = await alice.evaluate(async ({ text }) => {
      const form = new FormData();
      form.append('name', 'Board in CAD: big');
      form.append('file', new Blob([text]), 'big/big.kicad_pcb');
      form.append('file', new Blob(['{}']), 'big/big.kicad_pro');
      form.append('file', new Blob(['(kicad_sch (version 20250114) (generator "eeschema") (uuid "00000000-0000-4000-8000-00000000aaaa") (paper "A4") (lib_symbols) (sheet_instances (path "/" (page "1"))))']), 'big/big.kicad_sch');
      const r = await fetch('/api/projects', { method: 'POST', body: form });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, { text: big.text });
    check(`a board with ${big.footprints} footprints is uploaded`, made.status === 200 && !!made.body?.projectId, `status ${made.status}`);
    const bigId = made.body.projectId;
    await alice.goto(`${BASE}/p/${bigId}/edit`);
    await alice.waitForSelector('#doctabs [role=tab]', { timeout: 60000 });
    await newPartStudio(alice);
    await addBoard(alice, 4);
    await alice.click('.cad-dialog [data-accept]');
    await settled(alice, 1);
    await alice.waitForFunction(() => { const d = Array.from(window.JunctionBoardLink.shown.values())[0]; return d && d.display.group.visible && d.display.stats.faceBuilds >= 2; }, null, { timeout: 120000 });
    await alice.evaluate(() => window.JunctionBoardLink.modelsSettled());
    await alice.waitForTimeout(600);
    await settled(alice, 1);
    const jFace = await faceOnScreen(alice, ':parts', { side: true, part: 'J1' }, 9);
    await alice.waitForTimeout(400);
    await addOpening(alice, jFace, 8, 3);
    await settled(alice, 2);
    // standoffs under two of the mounting holes, before the wall is there to hide them: the wall of a hole is
    // clicked through the display model.  From the
    // iso view the far side of a hole's wall shows through its mouth; the face's centre is on the axis, in the air.
    await tool(alice, 'Standoffs');
    await alice.waitForSelector('.cad-dialog[data-feature=board-standoffs]');
    for (const h of ['H2', 'H3']) {
      const at = await faceOnScreen(alice, ':board', { name: `:hole:${h}` }, 5, [-1.6 * Math.SQRT1_2, 1.6 * Math.SQRT1_2, 0]);
      await alice.waitForTimeout(400);
      await click(alice, at.x, at.y);
      await alice.waitForFunction((name) => { const e = window.JunctionPartStudio.getState().editing; return e && e.draft.params.holes.some((r) => r.name === name); }, at.name, { timeout: 10000 });
    }
    await alice.fill('.cad-dialog input[data-param=height]', '4');
    await alice.click('.cad-dialog [data-accept]');
    await settled(alice, 3);
    await addWall(alice, 1, 2, 20);   // tall enough for whatever model the connector's library name is given
    await settled(alice, 5);
    const posts = await alice.evaluate(() => { const s = window.JunctionPartStudio.getState(), f = s.features.find((x) => x.featureType === 'board-standoffs'); return { status: s.reports[f.id].status, message: s.reports[f.id].message || '', boxes: s.bodies.filter((b) => b.createdBy === f.id && b.mesh).map((b) => b.mesh.bbox.map((v) => Math.round(v * 100) / 100)) }; });
    check('Standoffs puts a post under each clicked mounting hole, from the plane up to the board\'s back', posts.status === 'ok' && posts.boxes.length === 2 && posts.boxes.every((b) => b[2] === 0 && b[5] === 4 && Math.abs(b[3] - b[0] - 6) < 0.01), JSON.stringify(posts));
    const bigBox = await openingBox(alice);
    const first = await linkStats(alice);
    check('the big board is in the part studio with an opening at its connector', !!bigBox && bigBox.faces === 4 && first.boards[0].parts === big.footprints, `${first.boards[0].parts} footprints, opening ${JSON.stringify(bigBox && { faces: bigBox.faces, status: bigBox.status })}; first draw: laminate ${ms(first.display[0].slabMs)}, a face image ${ms(first.display[0].facesMs)}`);
    await alice.evaluate(() => { window.JunctionPartStudio.setPlanesVisible(false); window.JunctionPartStudio.viewport.setView('iso', false); window.JunctionPartStudio.viewport.fit(); });
    await alice.waitForTimeout(900);
    await shot(alice, '09-big-board');

    await alice.evaluate(async ({ pid, login }) => { await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, role: 'editor' }) }); }, { pid: bigId, login: BOB });
    await openBoardEditor(bob, `${BASE}/p/${bigId}/edit`);
    const cal2 = await calibrate(bob);
    const e2e = [], regen = [], worker = [], trip = [];
    let at = big.connector.slice(), n0 = (await linkStats(alice)).stats.updates, moved = 0;
    for (let i = 0; i < 8; i++) {
      const to = [at[0], at[1] + (i % 2 ? -4 : 4) * (1 + (i >> 1) * 0.25)];
      const s0 = await linkStats(alice);
      const up = await drag(bob, cal2, at, to, 6);
      try { await alice.waitForFunction((n) => window.JunctionBoardLink.stats.updates > n, s0.stats.updates, { timeout: 15000, polling: 5 }); } catch (e) { continue; }
      e2e.push(Date.now() - up);
      await alice.waitForFunction((n) => window.JunctionBoardLink.stats.regens > n && window.JunctionPartStudio.getState().kernel.state === 'ready', s0.stats.regens, { timeout: 60000 });
      const s1 = await linkStats(alice);
      regen.push(s1.stats.lastRegenMs); worker.push(s1.stats.lastWorkerMs); trip.push(s1.stats.lastRoundtripMs);
      const now = await partAt(alice, 'J1');
      at = [now.x, now.y]; moved++;
    }
    await alice.waitForFunction(() => !window.JunctionBoardLink.busy && window.JunctionPartStudio.getState().kernel.state === 'ready', null, { timeout: 60000 });
    await settled(alice, 5);
    const end = await linkStats(alice), samples = end.stats.samples.slice(-(end.stats.updates - n0));
    const bigBox2 = await openingBox(alice), j = await partAt(alice, 'J1');
    check('eight drags of the connector on the big board all arrive, and the opening ends where the connector is', moved === 8 && !!bigBox2 && bigBox2.faces === 4 && Math.abs((bigBox2.centre[1] - bigBox.centre[1]) + (j.y - big.connector[1])) < 0.02, `${moved} of 8`);
    check('a surface-mount part dragged on the front never recomposes the back face', end.display[0].backBuilds === first.display[0].backBuilds && end.display[0].faceBuilds - first.display[0].faceBuilds <= 16, `${end.display[0].faceBuilds - first.display[0].faceBuilds} compositions of the front for 8 drags, ${end.display[0].backBuilds - first.display[0].backBuilds} of the back`);
    check('on the big board a drag rebuilds one part mesh and never the laminate', samples.every((s) => s.parts <= 1) && end.display[0].slabBuilds === first.display[0].slabBuilds, `laminate builds ${first.display[0].slabBuilds} → ${end.display[0].slabBuilds}`);
    console.log(`      ${big.footprints} footprints, ${samples.length} updates: apply op median ${ms(median(samples.map((s) => s.apply)))}, read ${ms(median(samples.map((s) => s.read)))}, ` +
      `display updated median ${ms(median(samples.map((s) => s.display)))} / max ${ms(Math.max(...samples.map((s) => s.display)))} after the op arrived; ` +
      `mouse-up in one browser to display in the other median ${ms(median(e2e))} (includes the server and the test's polling); ` +
      `dependent features (Board → wall → Opening) on screen median ${ms(median(regen))} after the first op of a drag arrived, of which the worker ${ms(median(worker))} inside a round trip of ${ms(median(trip))} from handing it the input to the model on screen; ` +
      `the front face image recomposed ${end.display[0].faceBuilds - first.display[0].faceBuilds} times in ${ms(end.display[0].facesMs)} each, after the drags (the back never: nothing on it moved)`);
    await alice.waitForTimeout(700);
    await shot(alice, '10-big-board-after-drags');
  }

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.error(e);
  fail++;
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
