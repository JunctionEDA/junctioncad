// The whole mechanical story in one project, with two people, against a running server: what the slices' own
// scripts each test alone, here together.
//
//   1. Alice makes a part studio and sketches a tray: a rectangle from the origin, width and height dimensioned
//      (fully constrained by the solver).
//   2. Extrude, Shell (open at the top), Fillet on the four outer corners.
//   3. A boss on the floor and a Linear pattern that makes it four.
//   4. The project's board comes into the model as a Board feature, standing on the bosses.
//   5. One click links the board to the model (it is placed by the Board feature); the tray's floor drives the
//      board's outline and the boss tops drive its mounting holes.  Bob, in the board editor, sees them arrive.
//   6. An Opening in the tray wall in front of the board's connector.  Bob drags the connector along the board
//      edge; the opening in Alice's tray follows.
//   7. Alice widens the tray by its sketch dimension; the board's outline in Bob's editor follows.
//   8. An assembly: the tray, a lid from a second part studio and the board; the lid is hinged to the tray with a
//      Revolute mate picked in the viewport.
//   9. Interference (the lid closed on the tray: nothing clashes; the board is checked too), the combined bill of
//      materials (the two parts, the board, the board's electronic parts).
//  10. Back in the part studio: a distance measured between two faces; a version saved, the tray deepened, the two
//      compared; a STEP file exported.
//
// Setup as the other cad-*-ui.mjs scripts: a server with KC_DEV_LOGIN=1 on a throwaway database (build it after
// `npm run build`: it serves the bundles compiled into it), Playwright, and `psql` and `zip` on the PATH.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/cad-e2e.mjs
//
// E2E_UNTIL=<step number> stops after that step (for working on the script).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { tool, openPanel } = await import(new URL('./cad-chrome.mjs', import.meta.url));

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
const UNTIL = Number(process.env.E2E_UNTIL || 99);
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0, step = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(250); await page.screenshot({ path: `${SHOTS}/${name}.png` }); } };
const begin = (n, title) => { step = n; console.log(`\n— ${n}. ${title}`); };
class Stop extends Error {}
const until = (n) => { if (UNTIL <= n) throw new Stop(); };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 7200 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
const sql = (text) => execFileSync('psql', [PG_URL, '-Atc', text], { encoding: 'utf8' }).trim();
function user(login, githubId, name) {
  sql(`INSERT INTO users (github_id, login, name) VALUES (${githubId}, '${login}', '${name}') ON CONFLICT (github_id) DO NOTHING`);
  return Number(sql(`SELECT id FROM users WHERE github_id = ${githubId}`));
}

// ---------------------------------------------------------------- the project: a board with parts and no outline yet
// The tray's pocket will be 66 × 46 mm; the board's outline is driven from its floor, 1 mm inside the walls, and
// lands on the sheet as x 102 … 166, y 62 … 106 (the Board feature is placed so).  J1 is the connector at the
// right edge, looking out (+x); H1…H4 do not exist yet: the mounting holes come from the bosses.
let n = 0;
const uu = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const smd = (num, x, y, w, h) => `(pad "${num}" smd roundrect (at ${x} ${y}) (size ${w} ${h}) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (uuid "${uu()}"))`;
const fp = (lib, ref, value, x, y, w, h, pads, attr = 'smd') => `  (footprint "${lib}" (layer "F.Cu") (uuid "${uu()}") (at ${x} ${y})
    (property "Reference" "${ref}" (at 0 ${-h / 2 - 1}) (layer "F.SilkS") (uuid "${uu()}") (effects (font (size 0.8 0.8) (thickness 0.12))))
    (property "Value" "${value}" (at 0 ${h / 2 + 1}) (layer "F.Fab") (uuid "${uu()}") (effects (font (size 0.8 0.8) (thickness 0.12))))
    (attr ${attr})
    (fp_rect (start ${-w / 2} ${-h / 2}) (end ${w / 2} ${h / 2}) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "${uu()}"))
    (fp_rect (start ${-w / 2 + 0.2} ${-h / 2 + 0.2}) (end ${w / 2 - 0.2} ${h / 2 - 0.2}) (stroke (width 0.12) (type default)) (fill no) (layer "F.SilkS") (uuid "${uu()}"))
    ${pads}
  )`;
const J1 = { x: 161.5, y: 84 };
const board = `(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (paper "A4")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user "F.Silkscreen") (1 "F.Mask" user) (3 "B.Mask" user) (13 "F.Paste" user) (25 "Edge.Cuts" user) (31 "F.CrtYd" user "F.Courtyard") (35 "F.Fab" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
${fp('Connector_USB:USB_C_Receptacle_Test', 'J1', 'USB-C', J1.x, J1.y, 8, 9.5, [smd(1, -3, -3, 1.2, 0.6), smd(2, -3, -1, 1.2, 0.6), smd(3, -3, 1, 1.2, 0.6), smd(4, -3, 3, 1.2, 0.6)].join(' '))}
${fp('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm', 'U1', 'MCU', 130, 84, 6.2, 5.4, [0, 1, 2, 3].map((i) => smd(i + 1, -2.7, -1.9 + i * 1.27, 1.5, 0.6) + ' ' + smd(8 - i, 2.7, -1.9 + i * 1.27, 1.5, 0.6)).join(' '))}
${fp('Resistor_SMD:R_0603_1608Metric', 'R1', '10k', 120, 76, 3, 1.6, smd(1, -0.8, 0, 0.9, 0.95) + ' ' + smd(2, 0.8, 0, 0.9, 0.95))}
${fp('Resistor_SMD:R_0603_1608Metric', 'R2', '10k', 120, 92, 3, 1.6, smd(1, -0.8, 0, 0.9, 0.95) + ' ' + smd(2, 0.8, 0, 0.9, 0.95))}
${fp('Capacitor_SMD:C_0603_1608Metric', 'C1', '100n', 140, 76, 3, 1.6, smd(1, -0.8, 0, 0.9, 0.95) + ' ' + smd(2, 0.8, 0, 0.9, 0.95))}
)
`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-e2e-'));
fs.writeFileSync(path.join(dir, 'controller.kicad_pcb'), board);
fs.writeFileSync(path.join(dir, 'controller.kicad_pro'), JSON.stringify({ meta: { filename: 'controller.kicad_pro', version: 3 } }));
execFileSync('zip', ['-qr', 'p.zip', 'controller.kicad_pro', 'controller.kicad_pcb'], { cwd: dir });

const run = Date.now() % 100000000;
const ALICE = `e2e-alice-${run}`, BOB = `e2e-bob-${run}`;
const aliceId = user(ALICE, 1500000000 + run * 2, 'Alice'), bobId = user(BOB, 1500000001 + run * 2, 'Bob');
const form = new FormData(); form.append('name', 'Controller in a tray'); form.append('archive', new Blob([fs.readFileSync(path.join(dir, 'p.zip'))]), 'p.zip');
const created = await (await fetch(`${BASE}/api/projects`, { method: 'POST', headers: { Authorization: `Bearer ${jwt(aliceId, ALICE)}` }, body: form })).json();
const pid = created.projectId;
const pcbDoc = created.docs && created.docs.find((d) => d.path === 'controller.kicad_pcb');
check('a project with a board (five parts, no outline) is uploaded', !!pid && !!pcbDoc, JSON.stringify(created).slice(0, 160));

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function open(uid, login) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage(); page.setDefaultTimeout(45000);
  page.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`${login} console: ${m.text()}`); });
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}

// ---------------------------------------------------------------- helpers: the part studio
const S = (page, fn, arg) => page.evaluate(fn, arg);
/** `count` features, no dialog, no sketch, the kernel idle, every built feature reported (not as left behind by a dialog's preview, which builds up to its feature only). */
const settled = (page, count, timeout = 120000) => page.waitForFunction((count) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === count && !s.editing && !s.sketch && s.features.slice(0, s.rollback).every((f) => s.reports[f.id] && s.reports[f.id].status !== 'rolled-back');
}, count, { timeout });
const previewed = (page) => page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.editing && s.kernel.state === 'ready' && !!s.reports[s.editing.draft.id]; }, null, { timeout: 90000 });
const statuses = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return s.features.map((f) => `${f.name}:${s.reports[f.id]?.status}`).join(', '); });
const click = async (page, p, o = {}) => { if (o.shift) await page.keyboard.down('Shift'); await page.mouse.move(p.x, p.y, { steps: 3 }); await page.mouse.down(); await page.mouse.up(); if (o.shift) await page.keyboard.up('Shift'); await page.waitForTimeout(60); };
const screenOf = (page, p) => S(page, (p) => { const st = window.JunctionPartStudio, c = st.viewport.canvas.getBoundingClientRect(), q = st.viewport.project(st.viewport.target.clone().set(p[0], p[1], p[2])); return { x: c.left + q.x, y: c.top + q.y }; }, p);
const view = async (page, name) => { await S(page, (name) => { const st = window.JunctionPartStudio; st.viewport.setView(name, false); st.viewport.fit(); }, name); await page.waitForTimeout(350); };
/** Named geometry of the tray (or of the body whose id ends in `body`): what a test may ask the mesh. */
const geometry = (page, body = '') => S(page, (body) => {
  const s = window.JunctionPartStudio.getState();
  const b = body ? s.bodies.find((x) => x.id.endsWith(body)) : s.bodies.find((x) => !x.reference);
  if (!b || !b.mesh) return null;
  const m = b.mesh;
  const faces = m.faces.names.map((name, i) => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], c = [0, 0, 0]; let k = 0, best = null, area = -1;
    for (let t = m.faces.start[i]; t < m.faces.start[i] + m.faces.count[i]; t += 3) {
      const v = [0, 1, 2].map((j) => { const q = m.indices[t + j] * 3; return [m.positions[q], m.positions[q + 1], m.positions[q + 2]]; });
      for (const p of v) { for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); c[a] += p[a]; } k++; }
      const u = v[1].map((x, a) => x - v[0][a]), w = v[2].map((x, a) => x - v[0][a]);
      const ar = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
      if (ar > area) { area = ar; best = [0, 1, 2].map((a) => (v[0][a] + v[1][a] + v[2][a]) / 3); }
    }
    return { name, lo, hi, centre: c.map((x) => x / k), inside: best };
  });
  const edges = m.edges.names.map((name, i) => {
    const a = m.edges.start[i], cnt = m.edges.count[i], seg = Math.floor(cnt / 2) & ~1;
    const p = (j) => [m.edges.positions[(a + j) * 3], m.edges.positions[(a + j) * 3 + 1], m.edges.positions[(a + j) * 3 + 2]];
    const q0 = p(seg), q1 = p(seg + 1), first = p(0), last = p(cnt - 1);
    return { name, mid: [(q0[0] + q1[0]) / 2, (q0[1] + q1[1]) / 2, (q0[2] + q1[2]) / 2], first, last };
  });
  return { id: b.id, name: b.name, bbox: Array.from(m.bbox), faces, edges };
}, body);
/** Rest the pointer on a point of the model and say what is under it. */
const hoverAt = async (page, world) => { const p = await screenOf(page, world); await page.mouse.move(p.x, p.y, { steps: 3 }); await page.waitForTimeout(140); return { p, hover: await S(page, () => window.JunctionPartStudio.getState().hover) }; };
/** Click named geometry where a person would: at a point of it that the pointer really finds; turn the view if it is hidden. */
async function clickGeometry(page, kind, name, world, o = {}) {
  for (const v of [null, 'iso', 'top', 'front', 'right']) {
    if (v) await view(page, v);
    const { p, hover } = await hoverAt(page, world);
    if (hover && hover.kind === kind && hover.name === name) { await click(page, p, o); return true; }
  }
  // behind something from every standard view: look from the other side
  await S(page, () => { const st = window.JunctionPartStudio, v = st.viewport; v.lookAlong(v.target.clone().set(0.6, 0.7, 0.4), v.target.clone().set(0, 0, 1), false); v.fit(); });
  await page.waitForTimeout(350);
  const { p, hover } = await hoverAt(page, world);
  if (hover && hover.kind === kind && hover.name === name) { await click(page, p, o); return true; }
  return false;
}
const volume = (page) => S(page, async () => { const st = window.JunctionPartStudio; const b = st.getState().bodies.find((x) => !x.reference); const m = await st.kernel.call('mass-properties', { body: b.id }); return m.volume; });

// ---- helpers: the sketcher
const sk = (page) => S(page, () => { const e = window.JunctionSketch; if (!e) return null; const s = e.getState(); const cons = {}; for (const x of Object.values(s.data.constraints)) cons[x.type] = (cons[x.type] || 0) + 1; return { ready: s.ready, dof: s.dof, health: s.health, tool: s.tool, cons, points: Object.values(s.data.entities).filter((x) => x.type === 'point').map((x) => [x.x, x.y]) }; });
const skAt = (page, x, y) => S(page, ([x, y]) => { const st = window.JunctionPartStudio, f = window.JunctionSketch.frame; const w = st.viewport.target.clone().set(f.origin[0] + x * f.x[0] + y * f.y[0], f.origin[1] + x * f.x[1] + y * f.y[1], f.origin[2] + x * f.x[2] + y * f.y[2]); const p = st.viewport.project(w), r = st.viewport.canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; }, [x, y]);
const skClick = async (page, x, y) => click(page, await skAt(page, x, y));
const skSettled = (page) => page.waitForFunction(() => { const e = window.JunctionSketch; if (!e) return false; const s = e.getState(); return s.ready && (s.health !== 'ok' || s.dof === 0 || s.defined !== null); }, null, { timeout: 20000 });
const enter = async (page, text) => { await page.waitForSelector('.cad-dim-input'); await page.fill('.cad-dim-input', text); await page.keyboard.press('Enter'); await page.waitForSelector('.cad-dim-input', { state: 'detached' }); await skSettled(page); };
const dimension = async (page, pick, label, value) => { await page.keyboard.press('d'); await skClick(page, ...pick); await skClick(page, ...label); await enter(page, String(value)); };
async function newSketch(page, count) {
  // with a plane or a flat face selected the sketch starts at once; otherwise the dialog asks, and ✓ takes Top
  await tool(page, 'Sketch');
  await page.waitForSelector('.cad-dialog[data-feature=sketch], .cad-sketch-dialog');
  if (await page.locator('.cad-dialog[data-feature=sketch]').count()) await page.click('.cad-dialog [data-accept]');
  await page.waitForFunction((count) => { const s = window.JunctionPartStudio.getState(); return s.sketch && s.features.length === count && window.JunctionSketch && window.JunctionSketch.getState().ready && window.JunctionSketch.frame; }, count, { timeout: 120000 });
  await page.waitForTimeout(800);   // the camera turns to face the plane
}
const finishSketch = async (page, count) => { await page.keyboard.press('Escape'); await tool(page, 'Finish sketch'); await settled(page, count); };

// ---- helpers: the link and the board editor
const linkOf = (page) => S(page, () => { for (const i of window.JunctionPartStudio.doc.items.values()) if (i.type === 'board-link') return JSON.parse(JSON.stringify(i)); return null; });
const linkIs = (page, fn, arg) => page.waitForFunction(([src, arg]) => { const st = window.JunctionPartStudio; if (!st || !st.doc) return false; for (const i of st.doc.items.values()) if (i.type === 'board-link') return (0, eval)(`(${src})`)(i, arg); return false; }, [fn.toString(), arg], { timeout: 60000 });
/** What the model made on the board: the Edge.Cuts box and the mounting holes, in board millimetres. */
const driven = (page) => S(page, () => {
  const doc = window.JunctionBoardMech.mech.board(), K = window.KiCadCanvas;
  const out = { edges: 0, box: [Infinity, Infinity, -Infinity, -Infinity], holes: [], locked: 0, driven: 0 };
  if (!doc) return out;
  for (const it of doc.items.values()) {
    if (!it.id.startsWith('6a756e63-')) continue;
    out.driven++;
    const lock = K.kid(it.node, 'locked'); if (lock && K.str(lock[1]) !== 'no') out.locked++;
    if (/^gr_/.test(it.kind)) { out.edges++; const a = K.kid(it.node, 'start'), b = K.kid(it.node, 'end'); for (const p of [a, b]) { out.box[0] = Math.min(out.box[0], p[1]); out.box[1] = Math.min(out.box[1], p[2]); out.box[2] = Math.max(out.box[2], p[1]); out.box[3] = Math.max(out.box[3], p[2]); } }
    else if (it.kind === 'footprint') out.holes.push([Math.round(it.x * 100) / 100, Math.round(it.y * 100) / 100]);
  }
  out.box = out.box.map((v) => Math.round(v * 100) / 100); out.holes.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out;
});
const drivenIs = (page, fn, arg) => page.waitForFunction(([src, arg]) => {
  const api = window.JunctionBoardMech, doc = api && api.mech.board(); if (!doc) return false;
  const K = window.KiCadCanvas, c = { edges: 0, holes: 0, x0: Infinity, x1: -Infinity };
  for (const it of doc.items.values()) {
    if (!it.id.startsWith('6a756e63-')) continue;
    if (/^gr_/.test(it.kind)) { c.edges++; const a = K.kid(it.node, 'start'), b = K.kid(it.node, 'end'); c.x0 = Math.min(c.x0, a[1], b[1]); c.x1 = Math.max(c.x1, a[1], b[1]); }
    else if (it.kind === 'footprint') c.holes++;
  }
  return (0, eval)(`(${src})`)(c, arg);
}, [fn.toString(), arg], { timeout: 60000 });
/** Drag what is at a board position to another, as a hand would (KiCad: the first click selects, the next press drags). */
async function dragOnBoard(page, from, to, steps = 10) {
  const a = await S(page, ([x, y]) => window.JunctionBoardMech.clientOf(x, y), from), b = await S(page, ([x, y]) => window.JunctionBoardMech.clientOf(x, y), to);
  await page.mouse.move(a.x, a.y); await page.waitForTimeout(150);
  await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(250);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps); await page.waitForTimeout(30); }
  await page.mouse.up();
}
/** The opening the Opening feature left in the tray: the box of its faces. */
const openingBox = (page) => S(page, () => {
  const s = window.JunctionPartStudio.getState(), opening = s.features.find((f) => f.featureType === 'board-cutout'), tray = s.bodies.find((b) => !b.reference);
  if (!opening || !tray || !tray.mesh) return null;
  const m = tray.mesh, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; let faces = 0;
  m.faces.names.forEach((name, i) => { if (!name.startsWith(`${opening.id}:side:`)) return; faces++; for (let k = m.faces.start[i]; k < m.faces.start[i] + m.faces.count[i]; k++) for (let a = 0; a < 3; a++) { const v = m.positions[m.indices[k] * 3 + a]; if (v < lo[a]) lo[a] = v; if (v > hi[a]) hi[a] = v; } });
  return faces ? { faces, lo, hi, centre: lo.map((v, a) => (v + hi[a]) / 2) } : null;
});

// ---- helpers: the assembly
const A = (page, fn, arg) => page.evaluate(fn, arg);
const asmSettled = (page, count, timeout = 180000) => page.waitForFunction((count) => {
  const a = window.JunctionAssembly, s = a && a.getState();
  return !!s && s.loaded && !s.building && s.instances.length === count && s.instances.every((i) => i.suppressed || s.instanceInfo[i.id]?.status === 'ready') && (!s.canEdit || a.unsettled < 1e-6) && a.session.unsaved === 0;
}, count, { timeout });
const asmAt = (page, p) => A(page, (p) => { const v = window.JunctionAssembly.viewport, s = v.project(v.target.clone().set(p[0], p[1], p[2])), r = v.canvas.getBoundingClientRect(); return { x: r.left + s.x, y: r.top + s.y }; }, p);
const inst = (page, name) => A(page, (name) => { const a = window.JunctionAssembly, i = a.getState().instances.find((x) => x.name === name); return i ? { id: i.id, t: a.transformOf(i.id), info: a.getState().instanceInfo[i.id], source: i.source } : null; }, name);

let alice = null, bob = null;
try {
  alice = await open(aliceId, ALICE);
  const invited = await alice.evaluate(async ([pid, login]) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, role: 'editor' }) })).status, [pid, BOB]);
  check('Bob is invited as an editor', invited === 200, `status ${invited}`);

  // ================================================================ 1. a part studio; the tray's outline, constrained and dimensioned
  begin(1, 'a part studio, and a sketch held by constraints and dimensions');
  await alice.goto(`${BASE}/p/${pid}/edit`);
  await alice.waitForSelector('#doctabs [role=tab]', { timeout: 60000 });
  await alice.click('[data-doc-add]');
  await alice.click('text=New part studio');
  await alice.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 60000 });
  const studioUrl = alice.url();
  const studioDoc = await S(alice, () => window.JunctionPartStudio.host.doc.docId);
  const bar = await S(alice, () => { const t = document.querySelector('.cad-toolbar'); return { scrolls: t.scrollWidth > t.clientWidth + 1, sections: [...t.querySelectorAll('[data-section]')].map((e) => e.dataset.section).join(' ') }; });
  check('"+" makes a part studio; its toolbar is grouped and fits the window', !bar.scrolls && bar.sections === 'edit sketch solid pattern reference board inspect view file', JSON.stringify(bar));
  await newSketch(alice, 1);
  await alice.keyboard.press('r');
  await skClick(alice, 0, 0);
  await skClick(alice, 58, 41);
  await skSettled(alice);
  await alice.keyboard.press('Escape');
  let s = await sk(alice);
  check('a rectangle from the origin: horizontal and vertical lines, one corner on the origin, two freedoms left', s.cons.horizontal === 2 && s.cons.vertical === 2 && s.cons.coincident === 1 && s.dof === 2, JSON.stringify(s.cons) + ` dof ${s.dof}`);
  await dimension(alice, [29, 0], [29, -8], 70);
  s = await sk(alice);
  const top = s.points.reduce((a, c) => (c[0] + c[1] > a[0] + a[1] ? c : a));
  await dimension(alice, [70, top[1] / 2], [80, top[1] / 2], 50);
  s = await sk(alice);
  check('with its width (70) and height (50) dimensioned the sketch is fully constrained', s.dof === 0 && s.health === 'ok' && s.cons.distance === 2 && s.points.some((p) => near(p[0], 70) && near(p[1], 50)), `dof ${s.dof}, ${JSON.stringify(s.points)}`);
  check('the status line says so', (await alice.textContent('.cad-sketch-status')).includes('Fully constrained'));
  await shot(alice, '01-sketch-constrained');
  await finishSketch(alice, 1);
  until(1);

  // ================================================================ 2. extrude, shell, fillet
  begin(2, 'extrude, shell, fillet');
  await tool(alice, 'Extrude');
  await alice.waitForSelector('.cad-dialog[data-feature=extrude]');
  await alice.fill('.cad-dialog input[data-param=depth]', '14');
  await previewed(alice);
  await alice.click('.cad-dialog [data-accept]');
  await settled(alice, 2);
  check('Extrude: a 70 × 50 × 14 block', near(await volume(alice), 70 * 50 * 14, 1e-3), `${await volume(alice)} mm³`);
  await view(alice, 'iso');
  await tool(alice, 'Shell');
  await alice.waitForSelector('.cad-dialog[data-feature=shell] [data-param=faces][data-armed]');
  let g = await geometry(alice);
  const topFace = g.faces.find((f) => f.name.includes(':end:'));
  check('the top face is clicked for the Shell', await clickGeometry(alice, 'face', topFace.name, topFace.inside));
  await alice.fill('.cad-dialog input[data-param=thickness]', '2');
  await previewed(alice);
  await alice.click('.cad-dialog [data-accept]');
  await settled(alice, 3);
  const shelled = 70 * 50 * 14 - 66 * 46 * 12;
  check('Shell: 2 mm walls and floor, open at the top', near(await volume(alice), shelled, 1e-3), `${await volume(alice)} vs ${shelled}`);
  await tool(alice, 'Fillet');
  await alice.waitForSelector('.cad-dialog[data-feature=fillet] [data-param=edges][data-armed]');
  g = await geometry(alice);
  // the four outer corners: vertical edges on the outline of the tray
  const corners = g.edges.filter((e) => Math.abs(e.first[2] - e.last[2]) > 10 && [0, 70].some((x) => near(e.mid[0], x, 1e-6)) && [0, 50].some((y) => near(e.mid[1], y, 1e-6)));
  let rounded = 0;
  for (const e of corners) if (await clickGeometry(alice, 'edge', e.name, e.mid)) rounded++;
  await alice.fill('.cad-dialog input[data-param=radius]', '1.5');
  await previewed(alice);
  check('the four outer corners are clicked for the Fillet', corners.length === 4 && rounded === 4 && (await S(alice, () => window.JunctionPartStudio.getState().editing.draft.params.edges.length)) === 4, `${rounded} of ${corners.length}`);
  await alice.click('.cad-dialog [data-accept]');
  await settled(alice, 4);
  const filleted = shelled - 4 * (1.5 * 1.5 - Math.PI * 1.5 * 1.5 / 4) * 14;
  check('Fillet: the corners are rounded by 1.5 mm', near(await volume(alice), filleted, 1e-2) && (await statuses(alice)).endsWith('Fillet 1:ok'), `${await volume(alice)} vs ${filleted}; ${await statuses(alice)}`);
  await view(alice, 'iso');
  await shot(alice, '02-tray');
  until(2);

  // ================================================================ 3. a boss on the floor, and a pattern of four
  begin(3, 'bosses with a pattern');
  g = await geometry(alice);
  const floor = g.faces.find((f) => near(f.lo[2], 2, 1e-6) && near(f.hi[2], 2, 1e-6));
  check('the floor of the tray is found and clicked', !!floor && await clickGeometry(alice, 'face', floor.name, [35, 25, 2]));
  await newSketch(alice, 5);
  const onFloor = await S(alice, () => { const f = window.JunctionSketch.frame; return { z: f.origin[2] + 0, normal: f.normal }; });
  check('Sketch with the floor selected draws on the floor', near(Math.abs(onFloor.normal[2]), 1, 1e-9), JSON.stringify(onFloor));
  // a circle of radius 2.5 centred 8 mm from the two walls: placed by the model's own coordinates on the floor
  const toSketch = (x, y) => S(alice, ([x, y]) => { const f = window.JunctionSketch.frame, d = [x - f.origin[0], y - f.origin[1], 2 - f.origin[2]]; return [d[0] * f.x[0] + d[1] * f.x[1] + d[2] * f.x[2], d[0] * f.y[0] + d[1] * f.y[1] + d[2] * f.y[2]]; }, [x, y]);
  const c0 = await toSketch(8, 8), c1 = await toSketch(10.5, 8);
  await alice.keyboard.press('c');
  await skClick(alice, c0[0], c0[1]);
  const rim = await skAt(alice, c1[0], c1[1]);
  await alice.mouse.move(rim.x, rim.y, { steps: 3 });
  await alice.keyboard.type('5');           // its diameter, typed while the circle is being drawn
  await alice.keyboard.press('Enter');
  await skSettled(alice);
  await alice.keyboard.press('Escape');
  const typed = await sk(alice);
  await finishSketch(alice, 5);
  const bossSketch = await S(alice, () => { const s = window.JunctionPartStudio.getState(), f = s.features[4], e = Object.values(f.params.sketch.entities); const c = e.find((x) => x.type === 'circle'); return { id: f.id, r: c && c.r, n: e.filter((x) => x.type === 'circle').length }; });
  check('a circle is drawn on the floor, its diameter typed (5) and kept as a dimension', bossSketch.n === 1 && near(bossSketch.r, 2.5, 1e-9) && typed.cons.diameter === 1, JSON.stringify(bossSketch) + JSON.stringify(typed.cons));
  await tool(alice, 'Extrude');
  await alice.waitForSelector('.cad-dialog[data-feature=extrude]');
  await alice.click('.cad-dialog [data-param=operation] >> text=Add');
  await alice.fill('.cad-dialog input[data-param=depth]', '4');
  await previewed(alice);
  await alice.click('.cad-dialog [data-accept]');
  await settled(alice, 6);
  const bossId = await S(alice, () => window.JunctionPartStudio.getState().features[5].id);
  g = await geometry(alice);
  check('Extrude › Add: a boss 4 mm high stands on the floor', g.faces.some((f) => f.name.startsWith(`${bossId}:end:`) && near(f.lo[2], 6, 1e-6)), await statuses(alice));
  await tool(alice, 'Linear pattern');
  await alice.waitForSelector('.cad-dialog[data-feature=linear-pattern]');
  await alice.click(`.cad-dialog [data-feature-option='${bossId}']`);
  // along X (the Right plane's normal) and along Y (against the Front plane's): the planes are offered as buttons
  await alice.click('.cad-dialog [data-param=direction] ~ .seg [data-plane=right]').catch(async () => { await alice.locator('.cad-dialog [data-plane=right]').first().click(); });
  await alice.fill('.cad-dialog input[data-param=spacing]', '54');
  await alice.fill('.cad-dialog input[data-param=count]', '2');
  await alice.check('.cad-dialog input[data-param=second]');
  await alice.locator('.cad-dialog [data-plane=front]').last().click();
  await alice.fill('.cad-dialog input[data-param=spacing2]', '34');
  await alice.fill('.cad-dialog input[data-param=count2]', '2');
  await alice.check('.cad-dialog input[data-param=flip2]');
  await previewed(alice);
  await alice.click('.cad-dialog [data-accept]');
  await settled(alice, 7);
  g = await geometry(alice);
  const bossTops = g.faces.filter((f) => near(f.lo[2], 6, 1e-6) && near(f.hi[2], 6, 1e-6));
  const centres = bossTops.map((f) => [Math.round((f.lo[0] + f.hi[0]) / 2), Math.round((f.lo[1] + f.hi[1]) / 2)].join()).sort().join(' ');
  check('Linear pattern, two directions: four bosses, 54 × 34 apart', bossTops.length === 4 && centres === '62,42 62,8 8,42 8,8', `${centres}; ${await statuses(alice)}`);
  await view(alice, 'iso');
  await shot(alice, '03-bosses');
  until(3);

  // ================================================================ 4. the board, in the model
  begin(4, 'the project\'s board as a Board feature');
  await tool(alice, 'Board');
  await alice.waitForSelector('.cad-dialog[data-feature=board-reference]');
  const boards = await alice.$$eval('.cad-dialog select[data-param=board] option', (els) => els.map((e) => e.value).filter(Boolean));
  await alice.selectOption('.cad-dialog select[data-param=board]', boards[0]);
  await alice.fill('.cad-dialog input[data-param=z]', '6');
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.editing && Array.isArray(s.editing.draft.params.origin) && s.bodies.some((b) => b.id.endsWith(':board') && b.mesh); }, null, { timeout: 120000 });
  // where the middle of the outline-to-be (sheet 134, 84) must be: the middle of the tray (35, 25)
  const origin = await S(alice, () => window.JunctionPartStudio.getState().editing.draft.params.origin);
  await alice.fill('.cad-dialog input[data-param=x]', String(Math.round((35 - 134 + origin[0]) * 1000) / 1000));
  await alice.fill('.cad-dialog input[data-param=y]', String(Math.round((25 + 84 - origin[1]) * 1000) / 1000));
  await previewed(alice);
  await alice.click('.cad-dialog [data-accept]');
  await settled(alice, 8);
  const boardFeature = await S(alice, () => { const s = window.JunctionPartStudio.getState(), f = s.features[7]; return { id: f.id, name: f.name, status: s.reports[f.id].status, stored: JSON.stringify(window.JunctionPartStudio.session.doc).includes('$board'), bodies: s.bodies.map((b) => `${b.name}${b.reference ? '*' : ''}`).join() }; });
  check('the Board feature is built: two reference bodies beside the tray, the board itself not stored in the part studio', boardFeature.status !== 'error' && !boardFeature.stored && /Board 1\*,Board 1 parts\*/.test(boardFeature.bodies), JSON.stringify(boardFeature));
  await alice.evaluate(() => window.JunctionBoardLink.modelsSettled());
  await settled(alice, 8);
  const shown = await S(alice, () => { const l = window.JunctionBoardLink, d = Array.from(l.shown.values())[0]; let hiddenSolids = 0; const st = window.JunctionPartStudio; for (const b of st.getState().bodies) { const o = st.view.bodyObjects(b.id); if (b.reference && o && !o.mesh.visible) hiddenSolids++; } return { visible: d.display.group.visible, hiddenSolids, panel: document.querySelector('[data-panel=boardlink]').hasAttribute('data-open') }; });
  check('the board is drawn as it looks over its hidden solids, and the Board panel has unfolded', shown.visible && shown.hiddenSolids === 2 && shown.panel, JSON.stringify(shown));
  const j1 = await geometry(alice, ':parts');
  const j1top = j1.faces.find((f) => f.name.endsWith(':part:J1:top'));
  check('the connector stands at the tray\'s right wall, on a board 6 mm up', !!j1top && j1top.hi[0] > 60 && j1top.hi[0] < 68 && j1top.lo[2] > 7.6, JSON.stringify(j1top && [j1top.lo, j1top.hi]));
  await view(alice, 'iso');
  await shot(alice, '04-board-in-tray');
  until(4);

  // ================================================================ 5. link: the tray drives the board's outline and holes
  begin(5, 'the tray drives the board\'s outline and mounting holes');
  bob = await open(bobId, BOB);
  await bob.goto(`${BASE}/p/${pid}/edit`);
  await bob.waitForSelector('#doctabs [role=tab]', { timeout: 60000 });
  await bob.click('#doctabs [role=tab][data-doc-type=kicad_pcb]');
  await bob.waitForFunction(() => { const s = window.CollabApp.getState(); return s.view === 'editor' && s.document.editor === 'pcb' && s.connection.status === 'live'; }, null, { timeout: 90000 });
  await bob.waitForFunction(() => window.JunctionBoardMech && window.JunctionBoardMech.mech.getState().complete, null, { timeout: 60000 });
  check('Bob has the board open; nothing drives it yet', (await driven(bob)).driven === 0 && (await bob.$$eval('#doctabs [role=tab]', (els) => els.map((e) => e.textContent.trim()).join())).includes('Part Studio 1'));

  await alice.click('[data-panel=boardlink] [data-act=link]');
  await alice.waitForSelector('[data-panel=boardlink] [data-section=placement][data-placed-by]');
  let link = await linkOf(alice);
  check('Link this board is one step: the link is placed by the Board feature, with no second placement to set', !!link && link.feature === boardFeature.id && (await alice.textContent('[data-panel=boardlink] [data-field=plane]')) === 'Board 1' && !(await alice.$('[data-panel=boardlink] input[data-field=lift]')), JSON.stringify(link && { feature: link.feature }));
  // the outline: the floor of the tray, 1 mm clear of the walls
  await S(alice, (name) => { const st = window.JunctionPartStudio, b = st.getState().bodies.find((x) => !x.reference); st.select([{ kind: 'face', body: b.id, name, point: [35, 25, 2] }]); }, floor.name);
  await alice.click('[data-panel=boardlink] [data-add=outline]');
  await alice.waitForSelector('[data-panel=boardlink] [data-drive-kind=outline]');
  const setField = async (scope, name, value) => { const input = alice.locator(`${scope} input[data-field="${name}"]`); await input.fill(String(value)); await input.press('Enter'); };
  await setField('[data-panel=boardlink] [data-drive-kind=outline]', 'inset', 1);
  // the holes: the four boss tops, clicked
  g = await geometry(alice);
  const tops = g.faces.filter((f) => near(f.lo[2], 6, 1e-6) && near(f.hi[2], 6, 1e-6));
  await S(alice, () => window.JunctionPartStudio.select([]));
  await S(alice, (names) => { const st = window.JunctionPartStudio, b = st.getState().bodies.find((x) => !x.reference); st.select(names.map((name) => ({ kind: 'face', body: b.id, name, point: [0, 0, 6] }))); }, tops.map((f) => f.name));
  await alice.click('[data-panel=boardlink] [data-add=holes]');
  await alice.waitForSelector('[data-panel=boardlink] [data-drive-kind=holes]');
  await setField('[data-panel=boardlink] [data-drive-kind=holes]', 'diameter', 2.2);
  await linkIs(alice, (l) => { const d = Object.values(l.solved.drives); return d.length === 2 && d.every((x) => (x.kind === 'outline' ? x.curves.length >= 4 : x.holes.length === 4 && x.holes[0][2] === 2200000)) && !Object.keys(l.solved.errors).length; });
  await drivenIs(bob, (c) => c.edges >= 4 && c.holes === 4 && Math.abs(c.x0 - 102) < 0.01);
  let onBoard = await driven(bob);
  check('Bob sees the outline arrive on Edge.Cuts: the floor less 1 mm, where the Board feature places the board', onBoard.box.join() === '102,62,166,106' && onBoard.edges >= 4, JSON.stringify(onBoard.box));
  check('…and four mounting holes under the bosses, all of it locked', onBoard.holes.map((h) => h.join()).join(' ') === '107,67 107,101 161,67 161,101' && onBoard.locked === onBoard.driven, JSON.stringify(onBoard.holes));
  await settled(alice, 8);
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(), b = s.bodies.find((x) => x.id.endsWith(':board')); return s.kernel.state === 'ready' && b && b.mesh && Math.abs(b.mesh.bbox[0] - 3) < 0.01 && Math.abs(b.mesh.bbox[3] - 67) < 0.01 && b.mesh.faces.names.filter((n) => n.includes(':hole:')).length === 4; }, null, { timeout: 90000 });
  check('the loop closes: the Board feature now shows the board with the outline and holes the tray gave it', true);
  await view(alice, 'top');
  await shot(alice, '05-alice-linked');
  await shot(bob, '05-bob-board-driven');
  until(5);

  // ================================================================ 6. an opening for the connector; Bob moves the connector
  begin(6, 'an opening that follows the connector');
  await tool(alice, 'Opening');
  await alice.waitForSelector('.cad-dialog[data-feature=board-cutout]');
  const parts = await geometry(alice, ':parts');
  // the connector's face that looks out of the tray (+x)
  const outFace = parts.faces.filter((f) => f.name.includes(':part:J1:') && /:[xy][+-]$/.test(f.name)).sort((a, b) => b.centre[0] - a.centre[0])[0];
  await S(alice, (ref) => window.JunctionPartStudio.setDraft({ params: { face: ref } }), { kind: 'face', body: parts.id, name: outFace.name });
  await alice.fill('.cad-dialog input[data-param=depth]', '8');
  await previewed(alice);
  await alice.click('.cad-dialog [data-accept]');
  await settled(alice, 9);
  let hole = await openingBox(alice);
  check('Opening: the wall in front of the connector is cut through', !!hole && hole.faces >= 4 && hole.hi[0] >= 70 - 1e-6 && near(hole.centre[1], 25, 0.05), JSON.stringify(hole) + ' ' + await statuses(alice));
  await view(alice, 'iso');
  await shot(alice, '06-opening');
  // Bob drags the connector 6 mm down the sheet: 6 mm towards -y in the model
  await dragOnBoard(bob, [J1.x, J1.y], [J1.x, J1.y + 6]);
  const moved = await S(bob, () => { const doc = window.JunctionBoardMech.mech.board(); for (const it of doc.items.values()) if (it.kind === 'footprint' && it.ref === 'J1') return [it.x, it.y]; return null; });
  check('Bob drags the connector along the board edge', !!moved && Math.abs(moved[1] - (J1.y + 6)) < 0.6, JSON.stringify(moved));
  await alice.waitForFunction((y) => {
    const s = window.JunctionPartStudio.getState(), opening = s.features.find((f) => f.featureType === 'board-cutout'), tray = s.bodies.find((b) => !b.reference);
    if (s.kernel.state !== 'ready' || !tray || !tray.mesh) return false;
    const m = tray.mesh; let lo = Infinity, hi = -Infinity;
    m.faces.names.forEach((name, i) => { if (!name.startsWith(`${opening.id}:side:`)) return; for (let k = m.faces.start[i]; k < m.faces.start[i] + m.faces.count[i]; k++) { const v = m.positions[m.indices[k] * 3 + 1]; if (v < lo) lo = v; if (v > hi) hi = v; } });
    return Math.abs((lo + hi) / 2 - y) < 0.7;
  }, 25 - (moved[1] - J1.y), { timeout: 60000 });
  const after = await openingBox(alice);
  check('…and the opening in Alice\'s tray follows it, without her touching anything', near(after.centre[1], 25 - (moved[1] - J1.y), 0.7) && near(after.hi[1] - after.lo[1], hole.hi[1] - hole.lo[1], 0.01), `${hole.centre[1].toFixed(2)} → ${after.centre[1].toFixed(2)}`);
  await shot(alice, '06-opening-followed');
  await shot(bob, '06-bob-moved-connector');
  until(6);

  // ================================================================ 7. Alice widens the tray; the board's outline follows
  begin(7, 'the board follows a dimension of the tray');
  await alice.dblclick('[data-feature-row][data-feature-type=sketch]');
  await alice.waitForFunction(() => window.JunctionSketch && window.JunctionSketch.getState().ready && Object.keys(window.JunctionSketch.getState().data.entities).length > 0 && window.JunctionPartStudio.getState().sketch, null, { timeout: 30000 });
  await alice.waitForTimeout(900);
  const label = await S(alice, () => { const e = window.JunctionSketch, dd = e.getState().data, id = Object.keys(dd.constraints).find((k) => dd.constraints[k].value === 70); const b = e.painter.boxes.find((x) => x.id === id), r = window.JunctionPartStudio.viewport.canvas.getBoundingClientRect(); return b ? { x: r.left + b.x + b.w / 2, y: r.top + b.y + b.h / 2 } : null; });
  check('the width dimension is on screen in the reopened sketch', !!label);
  await alice.mouse.move(label.x, label.y); await alice.mouse.down(); await alice.mouse.up(); await alice.waitForTimeout(60); await alice.mouse.down(); await alice.mouse.up();
  await enter(alice, '76');
  await finishSketch(alice, 9);
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(), b = s.bodies.find((x) => !x.reference); return s.kernel.state === 'ready' && b && b.mesh && Math.abs(b.mesh.bbox[3] - 76) < 1e-6; }, null, { timeout: 90000 });
  check('the dimension is edited to 76: the tray is wider, and every feature after the sketch still builds', (await statuses(alice)).split(', ').every((x) => /:(ok|warning)$/.test(x)), await statuses(alice));
  await drivenIs(bob, (c) => c.edges >= 4 && Math.abs(c.x1 - 172) < 0.01);
  onBoard = await driven(bob);
  check('Bob sees the board\'s outline grow by the same 6 mm', onBoard.box.join() === '102,62,172,106', JSON.stringify(onBoard.box));
  await shot(bob, '07-bob-outline-followed');
  await view(alice, 'iso');
  await shot(alice, '07-alice-wider-tray');
  until(7);

  // ================================================================ 8. an assembly: tray, lid, board; the lid on a hinge
  begin(8, 'an assembly of the tray, a lid and the board');
  // the lid is a part studio of its own: a 76 × 50 × 2 plate, drawn beside the tray (y from 60)
  const lidText = JSON.stringify({ junction: 'part-studio', version: 1, items: [
    { id: 'studio', type: 'studio', units: 'mm', rollback: null },
    { id: 'ls', type: 'feature', featureType: 'sketch', name: 'Lid outline', order: 'V', params: { plane: { kind: 'plane', plane: 'top' }, sketch: { version: 1, entities: { p1: { type: 'point', x: 0, y: 60 }, p2: { type: 'point', x: 76, y: 60 }, p3: { type: 'point', x: 76, y: 110 }, p4: { type: 'point', x: 0, y: 110 }, la: { type: 'line', a: 'p1', b: 'p2' }, lb: { type: 'line', a: 'p2', b: 'p3' }, lc: { type: 'line', a: 'p3', b: 'p4' }, ld: { type: 'line', a: 'p4', b: 'p1' } }, constraints: {} } } },
    { id: 'lid', type: 'feature', featureType: 'extrude', name: 'Lid', order: 'h', params: { profile: { sketch: 'ls', regions: null }, operation: 'new', endType: 'blind', depth: 2, flip: false, targets: [] } },
  ] });
  const lidDoc = await alice.evaluate(async ({ pid, text }) => { const made = await (await fetch(`/api/projects/${pid}/docs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'Lid.jpart' }) })).json(); const r = await fetch(`/api/docs/${made.docId}/snapshots?seq=0`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: text }); return { docId: made.docId, status: r.status }; }, { pid, text: lidText });
  check('a second part studio, the lid, is stored; its tab appears for both without a reload (the server says so)', lidDoc.status < 300 && await bob.waitForFunction(() => [...document.querySelectorAll('#doctabs [role=tab]')].some((e) => e.textContent.trim() === 'Lid'), null, { timeout: 15000 }).then(() => true, () => false));
  await alice.click('[data-doc-add]');
  await alice.click('text=New assembly');
  await alice.waitForFunction(() => window.JunctionAssembly && window.JunctionAssembly.getState().loaded, null, { timeout: 60000 });
  await alice.click('[data-tool=Insert]');
  await alice.waitForSelector('[data-insert-dialog]');
  for (const name of ['Part Studio 1', 'Lid']) if (!(await alice.$(`[data-source-doc="${name}"][data-open]`))) await alice.click(`[data-source-doc="${name}"] >> text="${name}"`);
  await alice.waitForSelector('[data-source-doc="Part Studio 1"] [data-offer]', { timeout: 180000 });
  await alice.waitForSelector('[data-source-doc="Lid"] [data-offer]', { timeout: 180000 });
  const offers = await alice.$$eval('[data-source-doc="Part Studio 1"] [data-offer]', (els) => els.map((e) => e.getAttribute('data-offer')));
  check('Insert builds the tray\'s part studio outside its tab, board and all: it offers the tray (by the studio\'s name: it is its one part) and the board\'s bodies', offers.join() === 'Part Studio 1,Board 1,Board 1 parts', offers.join());
  await alice.click('[data-source-doc="Part Studio 1"] [data-offer="Part Studio 1"]');
  await alice.click('[data-source-doc="Lid"] [data-offer]');
  await alice.click('[data-source-doc="controller"] >> text=controller');
  await shot(alice, '08-insert');
  await alice.click('[data-insert-dialog] [data-accept]');
  await asmSettled(alice, 3);
  const names = await A(alice, () => window.JunctionAssembly.getState().instances.map((i) => `${i.name}:${i.source.kind}`).join());
  check('the tray, the lid and the board are placed', names === 'Part Studio 1:part,Lid:part,controller:board', names);
  await A(alice, () => { const a = window.JunctionAssembly; a.getState().instances.forEach((i, k) => a.rename(i.id, ['Tray', 'Lid', 'Board'][k])); });
  await alice.waitForSelector('[data-instance=Board]');
  const boardInst = await A(alice, () => { const a = window.JunctionAssembly, p = a.placed().find((x) => x.item.source.kind === 'board'); return { pieces: p.pieces.map((x) => x.id).join(), holes: p.pieces[0].mesh.faces.names.filter((n) => n.startsWith('board:hole:')).length, back: p.pieces[0].mesh.faces.names.includes('board:back'), drawn: a.boards.stats, t: p.transform.map((v) => Math.round(v * 100) / 100) }; });
  check('the board instance is real geometry with named holes and faces, drawn as the board looks, its middle at the origin', boardInst.pieces === 'board:board,board:parts' && boardInst.holes === 4 && boardInst.back && boardInst.drawn.drawn === 1 && boardInst.t[3] === -137 && boardInst.t[7] === 84, JSON.stringify(boardInst));
  // ---- the tray is fixed; the board is fastened to it: its back face over the floor, 4 mm up (on the bosses).
  // The connectors are named, not clicked: the board's faces have the names its README promises ("board:back").
  await alice.click('[data-instance=Tray]');
  await alice.click('[data-tool=Fix]');
  await alice.waitForFunction(() => window.JunctionAssembly.getState().instances[0].fixed === true);
  const trayId = (await inst(alice, 'Tray')).id, boardId = (await inst(alice, 'Board')).id;
  const trayBody = (await inst(alice, 'Tray')).source.body;
  await alice.click('[data-mate-tool=fastened]');
  await alice.waitForSelector('[data-mate-dialog=fastened] [data-connector=a][data-armed]');
  await A(alice, ({ trayId, boardId, trayBody, floorName }) => {
    window.JunctionAssembly.setMateDraft({ a: { instance: trayId, ref: { kind: 'face', body: trayBody, name: floorName } }, b: { instance: boardId, ref: { kind: 'face', body: 'board:board', name: 'board:back' }, flip: true }, field: null }, true);
  }, { trayId, boardId, trayBody, floorName: floor.name });
  await alice.waitForSelector('[data-mate-dialog] [data-connector=b][data-set]');
  await alice.fill('[data-mate-dialog] input[data-param=offset]', '4');
  await alice.fill("[data-mate-dialog] input[aria-label='Mate name']", 'Board on bosses');
  await alice.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return s.mating && s.mateInfo[s.mating.id]?.state === 'ok'; }, null, { timeout: 20000 });
  await alice.click('[data-mate-dialog] [data-accept]');
  await asmSettled(alice, 3);
  let placedBoard = await inst(alice, 'Board');
  const round = (t) => t.map((v) => Math.round(v * 1000) / 1000);
  // where the part studio shows the board: the sheet's origin at (35 − 134, 25 + 84) = (−99, 109), 6 mm up
  check('Fastened by its named back face, the board sits in the tray exactly where the part studio shows it', round(placedBoard.t).join() === '1,0,0,-99,0,1,0,109,0,0,1,6' && placedBoard.info.dof === 0, round(placedBoard.t).join(' '));
  await A(alice, () => { const a = window.JunctionAssembly, v = a.viewport; v.setView('iso', false); a.fit(); });
  await shot(alice, '08-board-fastened');

  // ---- the lid: a Revolute mate, picked in the viewport: the tray's back top edge, the lid's back bottom edge
  await A(alice, () => { const a = window.JunctionAssembly, v = a.viewport; v.lookAlong(v.target.clone().set(-0.55, -1, -0.6), v.target.clone().set(0, 0, 1), false); a.fit(); });
  await alice.waitForTimeout(400);
  await alice.click('[data-mate-tool=revolute]');
  await alice.waitForSelector('[data-mate-dialog=revolute] [data-connector=a][data-armed]');
  const trayEdge = await asmAt(alice, [38, 50, 14]);
  await alice.mouse.move(trayEdge.x, trayEdge.y, { steps: 4 });
  await shot(alice, '08-hover-connector');
  await click(alice, trayEdge);
  await alice.waitForSelector('[data-mate-dialog] [data-connector=a][data-set]');
  const lidEdge = await asmAt(alice, [38, 110, 0]);
  await alice.mouse.move(lidEdge.x, lidEdge.y, { steps: 4 });
  await click(alice, lidEdge);
  await alice.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return s.mating && s.mating.a && s.mating.b && s.mateInfo[s.mating.id]?.state === 'ok'; }, null, { timeout: 20000 });
  const ends = await A(alice, () => { const m = window.JunctionAssembly.getState().mating; return `${m.a.ref.kind}/${m.b.ref.kind}`; });
  await alice.check('[data-mate-dialog] input[data-param=limits]');
  await alice.fill('[data-mate-dialog] input[data-param=angleMin]', '-110');
  await alice.fill('[data-mate-dialog] input[data-param=angleMax]', '0');
  await alice.fill("[data-mate-dialog] input[aria-label='Mate name']", 'Hinge');
  await alice.click('[data-mate-dialog] [data-accept]');
  await asmSettled(alice, 3);
  const lid = await inst(alice, 'Lid');
  check('the lid is hinged to the tray by two edges clicked in the viewport: it closes the tray and has one freedom left', ends === 'edge/edge' && near(lid.t[7], -60, 1e-3) && near(lid.t[11], 14, 1e-3) && lid.info.dof === 1, `${ends} ${round(lid.t).join(' ')} dof ${lid.info.dof}`);
  // open it by its angle, and close it again
  await alice.dblclick('[data-mate=Hinge]');
  await alice.waitForSelector('[data-mate-dialog=revolute] input[data-param=value-angle]');
  await alice.fill('[data-mate-dialog] input[data-param=value-angle]', '-60');
  await alice.waitForFunction(() => { const a = window.JunctionAssembly, i = a.getState().instances.find((x) => x.name === 'Lid'), t = a.transformOf(i.id); return Math.abs(t[10] - Math.cos(Math.PI / 3)) < 1e-3; }, null, { timeout: 20000 });
  await A(alice, () => { const a = window.JunctionAssembly; a.viewport.setView('iso', false); a.fit(); });
  await shot(alice, '08-lid-open');
  check('typing the hinge angle opens the lid 60°', true);
  await alice.fill('[data-mate-dialog] input[data-param=value-angle]', '0');
  await alice.click('[data-mate-dialog] [data-accept]');
  await asmSettled(alice, 3);
  await alice.keyboard.press('Escape');
  until(8);

  // ================================================================ 9. interference and the bill of materials
  begin(9, 'interference and the combined bill of materials');
  await alice.click('.cad-toolbar [data-tool="Interference"]');
  await alice.waitForSelector('.asm-interference[data-state=done]', { timeout: 180000 });
  let clashes = await alice.$$eval('.asm-interference [data-clash]', (els) => els.map((e) => ({ pair: e.dataset.clash, volume: Number(e.dataset.volume) })));
  const summary = await alice.textContent('.asm-interference');
  check('Interference, with the lid closed and the board on its bosses: nothing overlaps, and all three are checked (the board too)', clashes.length === 0 && /No parts overlap/.test(summary) && /3 parts/.test(summary) && !/Not checked/.test(summary), summary.replace(/\s+/g, ' ').slice(0, 200));
  const workers = await A(alice, () => window.JunctionAssembly.sources.kernels.workers);
  check('the check used the assembly editor\'s own workers: one per source document, none opened again', workers === 3, `${workers} workers`);
  // sink the board 1 mm into the bosses: now they clash, by the bosses' material less the holes
  await alice.dblclick('[data-mate="Board on bosses"]');
  await alice.waitForSelector('[data-mate-dialog=fastened] input[data-param=offset]');
  await alice.fill('[data-mate-dialog] input[data-param=offset]', '3');
  await alice.click('[data-mate-dialog] [data-accept]');
  await asmSettled(alice, 3);
  await alice.keyboard.press('Escape');
  await alice.click('.asm-interference [data-act=check]');
  await alice.waitForFunction(() => document.querySelector('.asm-interference[data-state=done]') && document.querySelectorAll('.asm-interference [data-clash]').length > 0, null, { timeout: 180000 });
  clashes = await alice.$$eval('.asm-interference [data-clash]', (els) => els.map((e) => ({ pair: e.dataset.clash, volume: Number(e.dataset.volume) })));
  const sunk = 4 * (Math.PI * 2.5 * 2.5 - Math.PI * 1.1 * 1.1) * 1;
  const marked = await A(alice, () => ({ marked: [...window.JunctionAssembly.scene.marked].length, drawn: (() => { let k = 0; window.JunctionAssembly.viewport.scene.traverse((o) => { if (o.name === 'clash') k++; }); return k; })() }));
  check('with the board sunk 1 mm into the bosses: one clash, tray against board, its exact volume', clashes.length === 1 && [trayId, boardId].every((id) => clashes[0].pair.includes(id)) && near(clashes[0].volume, sunk, 0.02), `${JSON.stringify(clashes)} vs ${sunk.toFixed(3)}`);
  check('the clash is drawn on the model and the two instances are marked', marked.marked === 2 && marked.drawn === 1, JSON.stringify(marked));
  await shot(alice, '09-interference');
  // put it back, and close the panel: the marks go
  await alice.dblclick('[data-mate="Board on bosses"]');
  await alice.waitForSelector('[data-mate-dialog=fastened] input[data-param=offset]');
  await alice.fill('[data-mate-dialog] input[data-param=offset]', '4');
  await alice.click('[data-mate-dialog] [data-accept]');
  await asmSettled(alice, 3);
  await alice.keyboard.press('Escape');
  await alice.click('[data-panel=interference] button[aria-label="Close Interference"]');
  check('closing the panel clears the marks', (await A(alice, () => [...window.JunctionAssembly.scene.marked].length)) === 0);

  await alice.click('.cad-toolbar [data-tool="Bill of materials"]');
  await alice.waitForSelector('.asm-bom[data-state=done]', { timeout: 120000 });
  const bom = await alice.$$eval('.asm-bom tbody tr', (els) => els.map((e) => [...e.querySelectorAll('td')].map((t) => t.textContent.trim())));
  const row = (name) => bom.find((r) => r[1] === name);
  check('the bill of materials lists the tray and the lid (each by its studio\'s name: it is that studio\'s one part) and the board', !!row('Part Studio 1') && !!row('Lid') && row('Lid')[3] === '1' && !!row('controller') && row('controller')[2].startsWith('Board'), bom.map((r) => r.slice(0, 4).join('|')).join('  '));
  check('…and under the board its electronic parts with their quantities: two 10k resistors, the connector', !!row('10k') && row('10k')[3] === '2' && /R1 R2/.test(row('10k')[4]) && !!row('USB-C') && !!row('MCU') && !!row('100n'), bom.filter((r) => r[0].includes('.')).map((r) => `${r[1]}×${r[3]} ${r[4]}`).join(', '));
  check('the table is docked under the viewport, not floating over it', await alice.$eval('.cad-dock[data-side=bottom] [data-panel=bom]', (el) => el.getBoundingClientRect().width > 600));
  await shot(alice, '09-bom');
  await alice.click('[data-panel=bom] button[aria-label="Close Bill of materials"]');
  until(9);

  // ================================================================ 10. measure; a version, a change, a comparison; export
  begin(10, 'measure, compare two versions, export STEP');
  await alice.click('#doctabs [role=tab] >> text="Part Studio 1"');
  await alice.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded && window.JunctionPartStudio.getState().features.length === 9, null, { timeout: 60000 });
  await settled(alice, 9);
  g = await geometry(alice);
  // the tray's width, between its two outer side walls (the views are turned until each can be clicked)
  const flat = (f, axis, v) => near(f.lo[axis], v, 1e-6) && near(f.hi[axis], v, 1e-6);
  const leftWall = g.faces.find((f) => flat(f, 0, 0)), rightWall = g.faces.find((f) => flat(f, 0, 76));
  check('the two outer side walls of the tray are clicked', !!leftWall && !!rightWall && await clickGeometry(alice, 'face', rightWall.name, rightWall.inside) && await clickGeometry(alice, 'face', leftWall.name, leftWall.inside, { shift: true }));
  await alice.waitForFunction(() => { const el = document.querySelector('.cad-measure'); return el && el.dataset.measure === 'ready' && el.querySelectorAll('tr[data-key=normal], tr[data-key=min]').length > 0; }, null, { timeout: 30000 });
  const measured = await alice.$$eval('.cad-measure tr[data-key]', (els) => Object.fromEntries(els.map((e) => [e.dataset.key, Number(e.querySelector('[data-copy]').dataset.copy)])));
  check('Measure: the distance between them is the tray\'s width as dimensioned, 76 mm', near(measured.normal ?? measured.min, 76, 1e-9), JSON.stringify(measured));
  await shot(alice, '10-measure');
  await S(alice, () => window.JunctionPartStudio.select([]));

  await alice.click('[data-tool="History"]');
  await alice.waitForSelector('[data-history]');
  await alice.click('[data-history-save]');
  await alice.fill('[data-history-form="save"] input', 'Tray, 14 deep');
  await alice.click('[data-history-form="save"] button[type=submit]');
  const saved = alice.locator('[data-history-row="version"][data-history-name="Tray, 14 deep"]');
  await saved.waitFor({ timeout: 30000 });
  check('a version is saved', await saved.count() === 1);
  // deepen the tray: Extrude 1 from 14 to 18
  await alice.dblclick('[data-feature-row][data-feature-type=extrude]');
  await alice.waitForSelector('.cad-dialog[data-feature=extrude]');
  await alice.fill('.cad-dialog input[data-param=depth]', '18');
  await previewed(alice);
  await alice.click('.cad-dialog [data-accept]');
  await settled(alice, 9);
  check('the tray is deepened to 18 mm and everything after it still builds', (await statuses(alice)).split(', ').every((x) => /:(ok|warning)$/.test(x)) && near((await geometry(alice)).bbox[5], 18, 1e-6), await statuses(alice));
  await saved.click();
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(), b = s.bodies.find((x) => !x.reference); return !!s.past && s.kernel.state === 'ready' && b && b.mesh && Math.abs(b.mesh.bbox[5] - 14) < 1e-6; }, null, { timeout: 90000 });
  await settled(alice, 9);
  const past = await S(alice, () => { const s = window.JunctionPartStudio.getState(); const b = s.bodies.find((x) => !x.reference); return { z: b.mesh.bbox[5], board: s.reports[s.features[7].id].status, canEdit: s.canEdit }; });
  check('looking at the saved version shows the tray 14 deep, read-only, with its board (read live, as it is not stored)', near(past.z, 14, 1e-6) && past.board !== 'error' && past.canEdit === false, JSON.stringify(past));
  await alice.click('[data-history-compare]');
  await alice.waitForSelector('[data-compare][data-compare-kind="part_studio"]');
  await alice.waitForSelector('[data-compare-state="done"]', { timeout: 180000 });
  const changes = await alice.$$eval('[data-compare] .rv-row', (els) => els.map((e) => `${e.dataset.change}:${e.querySelector('.rv-label').textContent}`));
  const legend = (await alice.locator('[data-compare-legend]').innerText()).replace(/\n/g, ' ');
  check('Compare: one feature differs, Extrude 1, and material was added', changes.join() === 'modified:Extrude 1' && /added/i.test(legend), `${changes.join(' | ')} — ${legend}`);
  const built = await S(alice, () => { const el = document.querySelector('[data-compare]'); return el ? el.textContent : ''; });
  check('both versions were built with their board: no feature failed on either side', !/failed to build|could not be built/i.test(built), built.replace(/\s+/g, ' ').slice(0, 160));
  await shot(alice, '10-compare');
  await alice.keyboard.press('Escape');
  await alice.waitForSelector('[data-compare]', { state: 'detached' }).catch(async () => { await alice.click('[data-compare] [aria-label=Close]').catch(() => {}); });
  await alice.locator('[data-history-row="now"]').click();
  await alice.waitForFunction(() => !window.JunctionPartStudio.getState().past, null, { timeout: 30000 });
  await settled(alice, 9);

  // export the tray as STEP
  const trayNow = await geometry(alice);
  await S(alice, (b) => { const st = window.JunctionPartStudio; st.select([{ kind: 'face', body: b.id, name: b.face, point: [0, 0, 0] }]); }, { id: trayNow.id, face: trayNow.faces[0].name });
  await tool(alice, 'Export');
  await alice.waitForSelector('[data-export-dialog]');
  await alice.selectOption('[data-param=format]', 'step');
  const ticked = await alice.$$eval('[data-param=bodies] [data-body] input:checked', (els) => els.length);
  await shot(alice, '10-export');
  const [dl] = await Promise.all([alice.waitForEvent('download', { timeout: 180000 }), alice.click('.kd-dialog .kd-foot button.primary')]);
  const file = path.join(dir, dl.suggestedFilename());
  await dl.saveAs(file);
  const stepText = fs.readFileSync(file, 'latin1');
  check('Export › STEP of the selected tray downloads a STEP file with one product', ticked === 1 && /\.step$/.test(dl.suggestedFilename()) && stepText.startsWith('ISO-10303-21;') && (stepText.match(/=\s*PRODUCT\(/g) || []).length === 1 && stepText.length > 20000, `${dl.suggestedFilename()}, ${stepText.length} bytes, ${ticked} ticked`);
  await S(alice, () => window.JunctionPartStudio.select([]));
  await view(alice, 'iso');
  await shot(alice, '10-done');
} catch (e) {
  if (!(e instanceof Stop)) { check(`step ${step} ran to its end`, false, String(e && e.stack || e).split('\n').slice(0, 4).join(' | ')); for (const [who, page] of [['alice', alice], ['bob', bob]]) if (page) await shot(page, `failed-${step}-${who}`).catch(() => {}); }
} finally {
  const real = errors.filter((e) => !/ERR_ABORTED|status of 40[134]|preview\.svg/.test(e));
  if (real.length) console.log('page errors:\n  ' + real.slice(0, 12).join('\n  '));
  check('no script errors on either page', real.length === 0, `${real.length}`);
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
