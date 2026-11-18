// Browser test of the sketcher in the real app (web/domains/mechanical/sketch): a plate with holes drawn, fully
// constrained and dimensioned by clicking and typing as a person would; the extruded solid following a changed
// dimension; dragging under the solver; conflicts and reference dimensions; undo; every drawing and modifying
// tool; regions where curves cross; using an edge of the model in a sketch.
//
// Setup as scripts/cad-ui.mjs: a local server with KC_DEV_LOGIN=1 on a throwaway database, Playwright, psql.
//
//   DATABASE_URL=postgres://… JWT_SECRET=dev PUBLIC_URL=http://127.0.0.1:8101 PORT=8101 KC_DEV_LOGIN=1 cargo run
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev E2E_BASE=http://127.0.0.1:8101 [SHOTS=/some/dir] node scripts/cad-sketch-ui.mjs
//
// E2E_STATIC=<dir>: serve mechanical.js, cad-worker.js and ui.css from <dir> (a static/dist you have just
// built) in place of the ones compiled into the server, to test a change without rebuilding the server.
//
// Positions are given in sketch millimetres and turned into screen positions through the editor itself
// (window.JunctionSketch), so the test does not depend on the window size or the zoom.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { tool as chromeTool } from './cad-chrome.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8101').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '', STATIC = process.env.E2E_STATIC || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
const sql = (text) => execFileSync('psql', [PG_URL, '-Atc', text], { encoding: 'utf8' }).trim();
sql(`INSERT INTO users (github_id, login, name) VALUES (990101, 'sketch-ui', 'sketch-ui') ON CONFLICT (github_id) DO NOTHING`);
const uid = Number(sql(`SELECT id FROM users WHERE github_id = 990101`));

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
if (STATIC) {
  for (const f of ['mechanical.js', 'cad-worker.js', 'ui.css']) {
    await ctx.route(`**/static/dist/${f}*`, (route) => route.fulfill({ status: 200, contentType: f.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8', body: fs.readFileSync(path.join(STATIC, f)) }));
  }
}
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
const shot = async (name) => { if (SHOTS) { await page.waitForTimeout(120); await page.screenshot({ path: `${SHOTS}/${name}.png` }); } };

// ---------------------------------------------------------------- helpers: the studio and the sketch editor
const studio = (fn, arg) => page.evaluate(fn, arg);
const sk = () => page.evaluate(() => {
  const e = window.JunctionSketch; if (!e) return null;
  const s = e.getState();
  const kinds = {}; for (const x of Object.values(s.data.entities)) kinds[x.type] = (kinds[x.type] || 0) + 1;
  const cons = {}; for (const x of Object.values(s.data.constraints)) cons[x.type] = (cons[x.type] || 0) + 1;
  return { ready: s.ready, dof: s.dof, health: s.health, tool: s.tool, kinds, cons, selection: s.selection, conflicting: s.conflicting, redundant: s.redundant, entities: Object.keys(s.data.entities).length, constraints: Object.keys(s.data.constraints).length, defined: s.defined ? s.defined.size : null, hint: s.hint };
});
const data = () => page.evaluate(() => window.JunctionSketch.getState().data);
/** A sketch position (mm) as a screen position. */
const at = (x, y) => page.evaluate(([x, y]) => {
  const st = window.JunctionPartStudio, f = window.JunctionSketch.frame;
  const w = st.viewport.target.clone().set(f.origin[0] + x * f.x[0] + y * f.y[0], f.origin[1] + x * f.x[1] + y * f.y[1], f.origin[2] + x * f.x[2] + y * f.y[2]);
  const p = st.viewport.project(w), r = st.viewport.canvas.getBoundingClientRect();
  return { x: r.left + p.x, y: r.top + p.y };
}, [x, y]);
const move = async (x, y) => { const p = await at(x, y); await page.mouse.move(p.x, p.y, { steps: 4 }); };
const click = async (x, y, o = {}) => { const p = await at(x, y); await page.mouse.move(p.x, p.y, { steps: 3 }); if (o.shift) await page.keyboard.down('Shift'); await page.mouse.down(); await page.mouse.up(); if (o.shift) await page.keyboard.up('Shift'); await page.waitForTimeout(30); };
const drag = async (x0, y0, x1, y1) => { const a = await at(x0, y0), b = await at(x1, y1); await page.mouse.move(a.x, a.y, { steps: 2 }); await page.mouse.down(); await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 }); await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up(); await page.waitForTimeout(60); };
const key = async (k) => { await page.keyboard.press(k); await page.waitForTimeout(30); };
const type = async (text) => { await page.keyboard.type(text); await page.waitForTimeout(30); };
// the sketch tools are the toolbar while a sketch is open; a family (Rectangle ▾, Arc ▾) is a drop-down
const tool = async (title) => { await chromeTool(page, title); await page.waitForTimeout(40); };
/** Wait until the sketch has settled after an edit: solved, and the settled entities worked out. */
const settledSketch = () => page.waitForFunction(() => { const e = window.JunctionSketch; if (!e) return false; const s = e.getState(); return s.ready && (s.health !== 'ok' || s.dof === 0 || s.defined !== null); }, null, { timeout: 15000 });
/** The id of the one entity of a type that matches. */
const find = (type, test) => page.evaluate(([type, test]) => { const d = window.JunctionSketch.getState().data, f = new Function('e', 'd', 'return ' + test); return Object.keys(d.entities).filter((id) => d.entities[id].type === type && f(d.entities[id], d)); }, [type, test]);
const pt = async (id) => { const d = await data(); const e = d.entities[id]; return [e.x, e.y]; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
/** Type a value into the dimension input that is open, and wait for the edit to land. */
const enter = async (text) => { await page.waitForSelector('.cad-dim-input'); await page.fill('.cad-dim-input', text); await page.keyboard.press('Enter'); await page.waitForSelector('.cad-dim-input', { state: 'detached' }); await settledSketch(); };
/** Dimension: click the things to measure, click where the text goes, type the value. */
const dimension = async (picks, label, value) => { await key('d'); for (const p of picks) await click(p[0], p[1]); await click(label[0], label[1]); if (value !== null) await enter(String(value)); };
const featuresSettled = (n) => page.waitForFunction((n) => { const s = window.JunctionPartStudio.getState(); return s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]); }, n, { timeout: 60000 });
const volume = () => studio(async () => { const st = window.JunctionPartStudio; const m = await st.kernel.call('mass-properties', { body: st.getState().bodies[0].id }); return m.volume; });
const newSketch = async (n) => {
  await page.click('[data-tool=Sketch]');
  await page.waitForSelector('.cad-dialog[data-feature=sketch]');
  await page.click('.cad-dialog [data-accept]');
  await page.waitForFunction((n) => { const s = window.JunctionPartStudio.getState(); return s.sketch && s.features.length === n && window.JunctionSketch && window.JunctionSketch.getState().ready && window.JunctionSketch.frame; }, n, { timeout: 90000 });
  await page.waitForTimeout(700);   // the camera turns to face the plane
};

try {
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, 'sketch-ui')}&next=/`);
  await page.waitForLoadState('networkidle');
  const project = await page.evaluate(async () => { const r = await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sketch UI test', template: 'pcb' }) }); return r.json(); });
  await page.goto(`${BASE}/p/${project.projectId}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });

  // ================================================================ a plate with two holes, fully constrained
  await newSketch(1);
  // the sketch's dialog folds to its title, out of the drawing's way (it stays folded for the sketches that follow)
  await page.click('.cad-sketch-dialog [data-dialog-fold]');
  check('opening a sketch starts the solver and shows the sketch tools', (await sk()).ready && await page.isVisible('.cad-toolbar[data-mode=sketch] [data-group=sketch] [data-tool=Line]') && await page.isVisible("[data-tool='Finish sketch']"));
  await shot('01-empty-sketch');

  await key('r');
  check('R takes the Rectangle tool', (await sk()).tool === 'sketch-rectangle');
  await click(0, 0);
  await move(52, 34);
  await shot('02-rectangle-rubber-band');
  await click(52, 34);
  await settledSketch();
  let s = await sk();
  check('a rectangle from the origin: four lines held horizontal and vertical, a corner on the origin', s.kinds.line === 4 && s.kinds.point === 4 && s.cons.horizontal === 2 && s.cons.vertical === 2 && s.cons.coincident === 1, JSON.stringify(s.cons));
  check('it has two degrees of freedom left: its width and its height', s.dof === 2 && s.health === 'ok', `dof ${s.dof}`);
  check('the status line says so', (await page.textContent('.cad-sketch-status')).includes('Under-constrained') && (await page.textContent('.cad-sketch-status')).includes('2 degrees of freedom'));
  await key('Escape');
  await shot('03-rectangle-under-constrained');

  // drag the free corner: the rectangle follows and stays a rectangle on the origin
  await drag(52, 34, 60, 40);
  await settledSketch();
  let d = await data();
  let corners = Object.values(d.entities).filter((e) => e.type === 'point').map((e) => [e.x, e.y]);
  const has = (x, y) => corners.some((c) => near(c[0], x, 0.6) && near(c[1], y, 0.6));
  check('dragging a corner resizes the rectangle under the solver', has(0, 0) && has(60, 40) && has(60, 0) && has(0, 40), JSON.stringify(corners));
  const far = corners.reduce((a, c) => (c[0] + c[1] > a[0] + a[1] ? c : a));
  const W0 = far[0], H0 = far[1];

  // dimensions: the width along the bottom, the height up the right side
  await dimension([[W0 / 2, 0]], [W0 / 2, -9], 80);
  s = await sk();
  check('a dimension is placed by clicking and its value typed', s.cons.distance === 1 && s.dof === 1, `dof ${s.dof}`);
  await dimension([[80, H0 / 2]], [92, H0 / 2], 50);
  s = await sk();
  check('with width and height the rectangle is fully constrained', s.dof === 0 && s.health === 'ok' && s.cons.distance === 2);
  check('the status line says fully constrained', (await page.textContent('.cad-sketch-status')).includes('Fully constrained'));
  d = await data();
  corners = Object.values(d.entities).filter((e) => e.type === 'point').map((e) => [e.x, e.y]);
  check('the geometry took the typed values: 80 × 50', corners.some((c) => near(c[0], 80) && near(c[1], 50)) && corners.some((c) => near(c[0], 0) && near(c[1], 0)), JSON.stringify(corners));
  await key('Escape');
  await shot('04-rectangle-fully-constrained');

  // a hole: a circle, its diameter, and its place from the left and bottom sides
  await key('c');
  await click(21, 26); await click(27, 26);
  await settledSketch();
  s = await sk();
  check('C draws a circle; the sketch is under-constrained again by three', s.kinds.circle === 1 && s.dof === 3, `dof ${s.dof}`);
  await dimension([[27, 26]], [34, 36], 10);
  await dimension([[21, 26], [0, 12]], [10, 31], 20);
  await dimension([[20, 26], [40, 0]], [14, 12], 25);
  s = await sk();
  check('diameter and two distances settle the hole', s.dof === 0 && s.cons.diameter === 1 && s.cons.distance === 4, `dof ${s.dof} ${JSON.stringify(s.cons)}`);
  let hole = (await find('circle', 'true'))[0];
  d = await data();
  check('the hole is Ø10 at (20, 25)', near(d.entities[hole].r, 5) && near(d.entities[d.entities[hole].center].x, 20) && near(d.entities[d.entities[hole].center].y, 25), JSON.stringify(d.entities[d.entities[hole].center]));

  // a second hole, tied to the first: equal, level with it, 40 apart
  await key('c');
  await click(57, 31); await click(61, 31);
  await key('Escape');
  await click(25, 25); await click(61, 31, { shift: true });   // the two circles, by their rims
  check('clicking with Shift selects both circles', (await sk()).selection.length === 2);
  await key('e');
  await settledSketch();
  d = await data();
  const circles = Object.values(d.entities).filter((e) => e.type === 'circle');
  check('E makes the selected circles equal', (await sk()).cons.equal === 1 && near(circles[0].r, 5) && near(circles[1].r, 5), circles.map((c) => c.r).join());
  // press the tool first, then click: horizontal between the two centres
  await key('h');
  check('H with nothing selected takes the Horizontal tool and waits', (await sk()).tool === 'sketch-horizontal');
  const c2 = Object.keys(d.entities).find((id) => d.entities[id].type === 'circle' && id !== hole);
  const c2c = d.entities[d.entities[c2].center];
  await click(20, 25); await click(c2c.x, c2c.y);
  await settledSketch();
  await key('Escape');
  d = await data();
  check('then two clicks put the centres level', (await sk()).cons.horizontal === 3 && near(d.entities[d.entities[c2].center].y, 25));
  await dimension([[20, 25], [d.entities[d.entities[c2].center].x, 25]], [40, 36], 40);
  await key('Escape');
  await settledSketch();
  s = await sk();
  check('the plate with two holes is fully constrained', s.dof === 0 && s.health === 'ok', `dof ${s.dof}`);
  await shot('05-plate-fully-constrained');
  // the drawing is laid over the 3D view and follows it: turned, and in the dark theme
  const facing = await at(80, 50);   // where the point is while the view faces the sketch
  await studio(() => window.JunctionPartStudio.viewport.setView('iso', false));
  const turned = await at(80, 50), flat = await studio(() => { const p = window.JunctionSketch.painter.screen([80, 50]), r = window.JunctionPartStudio.viewport.canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; });
  await page.waitForTimeout(150);
  const flat2 = await studio(() => { const p = window.JunctionSketch.painter.screen([80, 50]), r = window.JunctionPartStudio.viewport.canvas.getBoundingClientRect(); return { x: r.left + p.x, y: r.top + p.y }; });
  check('the sketch is drawn where the 3D view puts it when the view is turned', near(flat2.x, turned.x, 0.5) && near(flat2.y, turned.y, 0.5) && !(near(facing.x, turned.x, 0.5) && near(facing.y, turned.y, 0.5)), JSON.stringify([facing, flat, flat2, turned]));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.waitForTimeout(300);
  await shot('05b-turned-dark');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await studio(() => window.JunctionPartStudio.viewport.setView('top', false));
  await page.waitForTimeout(200);

  // ================================================================ extrude, then change a dimension
  await page.click("[data-tool='Finish sketch']");
  await page.click('[data-tool=Extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  await page.fill('.cad-dialog input[data-param=depth]', '8');
  await page.click('.cad-dialog [data-accept]');
  await featuresSettled(2);
  let v = await volume();
  check('the plate extrudes: 80 × 50 × 8 less two Ø10 holes', near(v, (80 * 50 - 2 * Math.PI * 25) * 8, 0.5), `volume ${v.toFixed(1)}`);
  await page.waitForTimeout(500);
  await shot('06-plate-solid');

  await page.dblclick('[data-feature-row][data-feature-type=sketch]');
  await page.waitForFunction(() => window.JunctionSketch && window.JunctionSketch.getState().ready && Object.keys(window.JunctionSketch.getState().data.entities).length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(700);
  // double-click the width dimension's text and type a new value
  /** The dimension with a value, and where its text is on screen. */
  const labelOf = (value) => page.evaluate((value) => {
    const e = window.JunctionSketch, dd = e.getState().data, id = Object.keys(dd.constraints).find((k) => dd.constraints[k].value === value);
    const b = e.painter.boxes.find((x) => x.id === id), r = window.JunctionPartStudio.viewport.canvas.getBoundingClientRect();
    return { id, x: r.left + b.x + b.w / 2, y: r.top + b.y + b.h / 2 };
  }, value);
  const dblclickLabel = async (lab) => { await page.mouse.move(lab.x, lab.y); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(60); await page.mouse.down(); await page.mouse.up(); };
  let lab = await labelOf(80);
  await dblclickLabel(lab);
  await shot('07-dimension-being-edited');
  await enter('100');
  d = await data();
  check('double-clicking a dimension and typing 100 widens the plate', Object.values(d.entities).some((e) => e.type === 'point' && near(e.x, 100) && near(e.y, 50)) && (await sk()).dof === 0);
  await shot('08-plate-widened');
  await page.click("[data-tool='Finish sketch']");
  await featuresSettled(2);
  await page.waitForFunction(() => window.JunctionPartStudio.getState().bodies.length === 1 && window.JunctionPartStudio.getState().kernel.state === 'ready');
  v = await volume();
  check('the extruded solid follows: 100 × 50 × 8 less the holes', near(v, (100 * 50 - 2 * Math.PI * 25) * 8, 0.5), `volume ${v.toFixed(1)}`);
  await page.waitForTimeout(500);
  await shot('09-solid-follows');

  // ================================================================ a second sketch: the other tools
  await newSketch(3);
  await studio(() => { const st = window.JunctionPartStudio, b = st.viewport.contentBox(); b.min.set(-135, -75, -1); b.max.set(135, 75, 1); st.viewport.fit(b); });
  await page.waitForTimeout(300);
  const dblclickAt = async (x, y) => { const p = await at(x, y); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(60); await page.mouse.down(); await page.mouse.up(); };
  const points = async () => Object.values((await data()).entities).filter((e) => e.type === 'point').map((e) => [e.x, e.y]);
  const hasPoint = async (x, y, eps = 1e-4) => (await points()).some((c) => near(c[0], x, eps) && near(c[1], y, eps));
  const count = async (type) => Object.values((await data()).entities).filter((e) => e.type === type).length;
  const regions = () => page.waitForFunction(() => { const st = window.JunctionPartStudio.getState(); return st.kernel.state === 'ready' && st.sketch; }, null, { timeout: 20000 }).then(() => studio(() => { const st = window.JunctionPartStudio.getState(); const v = st.sketches.find((x) => x.featureId === st.sketch.featureId); return v ? v.regions.length : -1; }));

  // ---- a chain of lines with a typed length, closed on its start
  await key('l');
  await click(-100, 10);
  await move(-62, 10.6);
  await shot('10-line-horizontal-inference');
  await type('30');
  await shot('11-line-typed-length');
  await key('Enter');
  await settledSketch();
  check('a line drawn nearly level with 30 typed: horizontal, 30 long, and dimensioned', await hasPoint(-70, 10) && (await sk()).cons.horizontal === 1 && (await sk()).cons.distance === 1, JSON.stringify(await points()));
  await click(-70.4, 40); await click(-100, 40.5); await click(-100, 10);
  await settledSketch();
  s = await sk();
  check('the chain goes on from each end and closes on the start: four lines, their directions inferred', s.kinds.line === 4 && s.kinds.point === 4 && s.cons.horizontal === 2 && s.cons.vertical === 2, JSON.stringify(s.cons));
  check('the closed outline is a region', (await regions()) === 1);
  check('closing the outline ended the chain', (await sk()).tool === 'sketch-line' && (await sk()).hint.includes('starts'));
  await key('Escape');

  // ---- fillet a corner, undo, redo
  await key('f');
  await type('4'); await key('Enter');
  check('typing while the Fillet tool is in hand sets its radius', (await sk()).hint.includes('Radius 4 mm'), (await sk()).hint);
  await click(-70, 10);
  await settledSketch();
  s = await sk();
  check('a click on a corner rounds it: an arc tangent to both lines with its radius dimensioned', s.kinds.arc === 1 && s.cons.tangent === 2 && s.cons.radius === 1 && s.health === 'ok' && await hasPoint(-74, 10) && await hasPoint(-70, 14) && await hasPoint(-74, 14), JSON.stringify(s.cons));
  await shot('12-fillet');
  await key('Escape');
  await page.keyboard.press('Control+z'); await settledSketch();
  check('Ctrl+Z takes the fillet back in one step', (await count('arc')) === 0 && await hasPoint(-70, 10));
  await page.keyboard.press('Control+y'); await settledSketch();
  check('Ctrl+Y brings it back', (await count('arc')) === 1 && await hasPoint(-74, 14));

  // ---- trim and extend
  await key('l'); await click(-86, 0); await click(-86, 50); await key('Escape');
  check('a line across the outline splits its region in two', (await regions()) === 2);
  await key('t');
  await click(-86, 46); await settledSketch();
  await click(-86, 4); await settledSketch();
  d = await data();
  let wall = Object.values(d.entities).find((e) => e.type === 'line' && near(d.entities[e.a].x, -86) && near(d.entities[e.b].x, -86));
  check('Trim cuts the ends that stick out back to the outline', !!wall && near(Math.min(d.entities[wall.a].y, d.entities[wall.b].y), 10) && near(Math.max(d.entities[wall.a].y, d.entities[wall.b].y), 40) && (await sk()).health === 'ok', JSON.stringify(wall && [d.entities[wall.a], d.entities[wall.b]]));
  check('the trimmed ends are held on the outline', (await sk()).cons.coincident === 4, JSON.stringify((await sk()).cons));   // two here, two that keep the filleted corner's sharp point on its lines
  await key('Escape');
  await key('l'); await click(-96, 32); await click(-92, 32); await key('Escape');
  await key('x'); await click(-92.5, 32); await settledSketch();
  check('Extend lengthens a line to the next curve', await hasPoint(-86, 32) && await hasPoint(-96, 32), JSON.stringify(await points()));
  await key('Escape');
  await shot('13-trim-extend');

  // ---- circle, offset, mirror about a construction line
  await key('c'); await click(-40, 50); await click(-34, 50); await key('Escape');
  await key('o'); await click(-34, 50); await move(-40, 58.2);
  await shot('14-offset-preview');
  await click(-40, 58.2); await settledSketch();
  d = await data();
  let radii = Object.values(d.entities).filter((e) => e.type === 'circle').map((e) => e.r).sort((a, b) => a - b);
  check('Offset makes a concentric circle on the side clicked', radii.length === 2 && near(radii[0], 6) && near(radii[1], 8), radii.join());
  await key('Escape');
  await key('q');
  check('Q with nothing selected switches to construction geometry', await page.evaluate(() => window.JunctionSketch.getState().construction));
  await key('l'); await click(-20, 0); await click(-20, 60); await key('Escape'); await key('Escape');
  check('Esc ends the chain, and Esc again puts the tool down', (await sk()).tool === 'select');
  await key('q');
  d = await data();
  check('the next line is construction geometry', Object.values(d.entities).filter((e) => e.type === 'line' && e.construction).length === 1);
  await click(-34, 50);
  await key('m');
  await click(-20, 30); await settledSketch();
  d = await data();
  let centres = Object.values(d.entities).filter((e) => e.type === 'circle').map((e) => [d.entities[e.center].x, d.entities[e.center].y, e.r]);
  check('Mirror copies the selected circle across the line and keeps it its image', centres.length === 3 && centres.some((c) => near(c[0], 0, 1e-3) && near(c[1], 50, 1e-3) && near(c[2], 6, 1e-3)) && (await sk()).cons.symmetric === 1, JSON.stringify(centres));
  await shot('15-offset-mirror');

  // ---- arcs and a slot
  await key('a'); await click(-110, -20); await click(-90, -20); await move(-100, -12); await shot('16-arc-rubber-band'); await click(-100, -12); await key('Escape');
  d = await data();
  let arcs = Object.values(d.entities).filter((e) => e.type === 'arc');
  const arcOf = (a) => { const c = d.entities[a.center], st = d.entities[a.start], en = d.entities[a.end]; return { c: [c.x, c.y], s: [st.x, st.y], e: [en.x, en.y], r: Math.hypot(st.x - c.x, st.y - c.y) }; };
  let a3 = arcs.map(arcOf).find((a) => near(a.c[0], -100, 1e-3) && a.c[1] < -12);
  check('a three-point arc passes through the three clicks', !!a3 && near(Math.hypot(-100 - a3.c[0], -12 - a3.c[1]), a3.r, 1e-6) && near(a3.s[0], -90) && near(a3.e[0], -110), JSON.stringify(a3));
  await key('l'); await click(-80, -40); await click(-60, -40); await key('Escape');
  await tool('Tangent arc'); await click(-60, -40); await move(-50, -30); await click(-50, -30); await settledSketch(); await key('Escape');
  d = await data(); arcs = Object.values(d.entities).filter((e) => e.type === 'arc');
  let at2 = arcs.map(arcOf).find((a) => near(a.c[0], -60, 1e-3) && near(a.c[1], -30, 1e-3));
  check('a tangent arc leaves the end of the line smoothly', !!at2 && near(at2.r, 10, 1e-3) && (await sk()).cons.tangent === 3, JSON.stringify(arcs.map(arcOf)));
  await tool('Centre arc'); await click(-30, -30); await click(-20, -30); await move(-23, -23); await move(-28, -20.5); await click(-30, -20); await key('Escape');
  d = await data(); arcs = Object.values(d.entities).filter((e) => e.type === 'arc');
  let ac = arcs.map(arcOf).find((a) => near(a.c[0], -30) && near(a.c[1], -30));
  check('a centre arc runs the way the pointer went round', !!ac && near(ac.s[0], -20) && near(ac.e[1], -20) && near(ac.e[0], -30, 1e-6), JSON.stringify(ac));
  await tool('Slot'); await click(-120, -55); await click(-100, -55); await move(-100, -51); await shot('17-slot-rubber-band'); await click(-100, -51); await settledSketch(); await key('Escape');
  s = await sk();
  check('a slot is two lines and two arcs, tangent where they join and equal at the ends', s.kinds.arc === 6 && s.cons.tangent === 7 && s.cons.equal === 2 && s.health === 'ok', JSON.stringify([s.kinds, s.cons]));
  await shot('18-arcs-slot');

  // ---- an angle, an expression, a reference dimension, a conflict
  await key('l'); await click(10, -60); await click(40, -60); await click(56, -40); await key('Escape');
  await dimension([[24, -60], [48, -50]], [46, -56], 120);
  d = await data();
  const ang = Object.values(d.constraints).find((k) => k.type === 'angle');
  const [la, lb] = ang ? ang.refs.map((r) => d.entities[r.entity]) : [];
  const corner = ang && [la.a, la.b].find((p) => p === lb.a || p === lb.b);
  const away = (l) => { const o = d.entities[corner], f = d.entities[l.a === corner ? l.b : l.a]; return [f.x - o.x, f.y - o.y]; };
  const between = ang ? Math.acos((away(la)[0] * away(lb)[0] + away(la)[1] * away(lb)[1]) / (Math.hypot(...away(la)) * Math.hypot(...away(lb)))) * 180 / Math.PI : 0;
  check('an angle between two lines is the one at their corner: 120°', near(between, 120, 1e-4) && (await sk()).health === 'ok', String(between));
  await key('Escape');
  lab = await labelOf(30);
  await dblclickLabel(lab);
  await enter('1 in + 4.6');
  check('a dimension takes arithmetic with units: 1 in + 4.6 is 30 mm', (await data()).constraints[lab.id].value === 30 && (await data()).constraints[lab.id].expr === '1 in + 4.6');
  await dblclickLabel(await labelOf(30));
  await enter('32');
  const xs = (await points()).filter((c) => near(c[1], 40) && c[0] < -60 && !near(c[0], -86)).map((c) => c[0]);
  check('and a new value moves the geometry', near(Math.max(...xs) - Math.min(...xs), 32) && (await sk()).health === 'ok', JSON.stringify(xs));
  // the top of the box is as long as the bottom already: a dimension on it can only be a reference
  await key('d'); await click(-90, 40); await click(-90, 56);   // the text well clear of the constraint marks on that edge
  await page.waitForTimeout(200);
  d = await data();
  let ref = Object.keys(d.constraints).find((k) => d.constraints[k].driving === false);
  check('a dimension the sketch already settles is added as a reference dimension', !!ref && near(d.constraints[ref].value, 32) && !(await page.$('.cad-dim-input')), JSON.stringify(ref && d.constraints[ref]));
  await key('Escape');
  await shot('19-reference-dimension');
  await dblclickAt(-90, 56);
  await page.waitForSelector('.cad-dim-input'); await page.fill('.cad-dim-input', '40'); await page.keyboard.press('Enter'); await page.waitForSelector('.cad-dim-input', { state: 'detached' });
  await page.waitForFunction(() => window.JunctionSketch.getState().health === 'conflict', null, { timeout: 10000 }).catch(() => {});
  s = await sk();
  check('typing a value that cannot hold puts the sketch in conflict, and names the constraints', s.health === 'conflict' && s.conflicting.includes(ref) && s.conflicting.length >= 2, JSON.stringify(s.conflicting));
  check('the status line says over-constrained', (await page.textContent('.cad-sketch-status')).includes('Over-constrained'));
  await shot('20-conflict');
  await studio((id) => window.JunctionSketch.select([id]), ref);
  await key('Delete');
  await settledSketch();
  s = await sk();
  check('deleting the offending dimension puts it right', s.health === 'ok' && s.conflicting.length === 0);

  // ---- a constraint's glyph is picked and deleted like anything else; a dimension's text is dragged
  const glyphOf = (type) => page.evaluate((type) => {
    const e = window.JunctionSketch, dd = e.getState().data, r = window.JunctionPartStudio.viewport.canvas.getBoundingClientRect();
    for (const b of e.painter.boxes) if (b.kind === 'glyph' && dd.constraints[b.id].type === type) return { id: b.id, x: r.left + b.x + b.w / 2, y: r.top + b.y + b.h / 2 };
    return null;
  }, type);
  const g = await glyphOf('symmetric');
  const dofBefore = (await sk()).dof;
  await page.mouse.move(g.x, g.y); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(40);
  check('a click on a constraint glyph selects the constraint', (await sk()).selection.join() === g.id);
  await shot('20b-glyph-selected');
  await key('Delete'); await settledSketch();
  check('Delete removes it, and the sketch gains the freedom it held', !(await data()).constraints[g.id] && (await sk()).dof === dofBefore + 2, `dof ${dofBefore} → ${(await sk()).dof}`);
  await page.keyboard.press('Control+z'); await settledSketch();
  check('and undo brings the constraint back', !!(await data()).constraints[g.id] && (await sk()).dof === dofBefore);
  lab = await labelOf(32);
  await page.mouse.move(lab.x, lab.y); await page.mouse.down(); await page.mouse.move(lab.x + 10, lab.y + 20, { steps: 4 }); await page.mouse.move(lab.x + 30, lab.y + 40, { steps: 4 }); await page.mouse.up(); await settledSketch();
  const moved = await labelOf(32);
  check('dragging a dimension moves its text and changes nothing else', near(moved.x, lab.x + 30, 2) && near(moved.y, lab.y + 40, 2) && (await data()).constraints[lab.id].value === 32 && (await sk()).health === 'ok', JSON.stringify([lab, moved]));

  // ---- an edge of the model, used in the sketch
  const before = (await sk()).entities;
  await key('u');
  await click(50, 50);
  await page.waitForFunction((n) => Object.keys(window.JunctionSketch.getState().data.entities).length > n, before, { timeout: 15000 });
  await settledSketch();
  d = await data();
  let used = Object.values(d.entities).find((e) => e.type === 'line' && e.from);
  check('Use draws an edge of the plate in the sketch, pinned', !!used && near(d.entities[used.a].y, 50) && near(d.entities[used.b].y, 50) && near(Math.abs(d.entities[used.a].x - d.entities[used.b].x), 100) && (await sk()).cons.fix === 1, JSON.stringify(used));
  await key('Escape');

  // ---- box selection and delete
  const n0 = (await sk()).entities;
  await drag(5, -66, 62, -34);
  check('a box drawn over geometry selects what lies inside it', (await sk()).selection.length >= 5, String((await sk()).selection.length));
  await key('Delete'); await settledSketch();
  check('Delete removes the selection and the constraints on it', (await sk()).entities === n0 - 5 && !(await sk()).cons.angle, `${n0} → ${(await sk()).entities}`);

  // ---- sizes typed while drawing a rectangle; a rectangle about its centre
  await key('r'); await click(64, -56); await move(78, -48);
  await type('40'); await key('Tab'); await type('20');
  await shot('21-rectangle-typed-size');
  await key('Enter'); await settledSketch();
  check('width, Tab, height typed while drawing: a 40 × 20 rectangle with both dimensions', await hasPoint(104, -36) && (await sk()).cons.distance === 3, JSON.stringify((await sk()).cons));
  await tool('Centre rectangle'); await click(90, -20); await click(100, -14); await settledSketch(); await key('Escape'); await key('Escape'); await key('Escape');
  check('Esc puts the tool down and clears the selection, and never leaves the sketch', !!(await sk()) && (await sk()).tool === 'select');
  check('a centre rectangle: its centre is held at the middle of a construction diagonal', await hasPoint(80, -26) && await hasPoint(100, -14) && (await sk()).cons.midpoint === 1);
  await drag(100, -14, 104, -12); await settledSketch();
  const cr = (await points()).filter((c) => c[0] > 70 && c[1] > -30 && c[1] < 0);
  const lo = cr.reduce((a, c) => (c[0] + c[1] < a[0] + a[1] ? c : a)), hi = cr.reduce((a, c) => (c[0] + c[1] > a[0] + a[1] ? c : a));
  check('dragging its corner: the corner follows, and the centre stays the middle', near(hi[0], 104, 0.3) && near(hi[1], -12, 0.3) && cr.some((c) => near(c[0], (lo[0] + hi[0]) / 2, 1e-4) && near(c[1], (lo[1] + hi[1]) / 2, 1e-4)), JSON.stringify(cr));

  // ---- how long a drag step takes on this sketch (about forty points and as many constraints)
  const perf = await page.evaluate(() => {
    const e = window.JunctionSketch, d = e.getState().data;
    const id = Object.keys(d.entities).find((k) => d.entities[k].type === 'point' && Math.abs(d.entities[k].x - 104) < 0.5 && Math.abs(d.entities[k].y + 12) < 0.5);
    const t0 = performance.now(); let n = 0;
    for (let i = 0; i < 40; i++) { if (e.drag([{ point: id, to: [104 + i * 0.05, -12 + i * 0.03] }])) n++; }
    const ms = (performance.now() - t0) / 40;
    e.endDrag(false);
    return { ms, n, points: Object.values(d.entities).filter((x) => x.type === 'point').length, constraints: Object.keys(d.constraints).length };
  });
  check('a drag step solves within a frame', perf.n === 40 && perf.ms < 16, `${perf.ms.toFixed(2)} ms per step, ${perf.points} points, ${perf.constraints} constraints`);
  await shot('22-second-sketch');
  s = await sk();
  check('the sketch is healthy at the end', s.health === 'ok', JSON.stringify(s));
  const nRegions = await regions();
  // the box cut in two by the trimmed line, the ring between the two concentric circles, the mirrored circle, the slot
  check('the worker finds the regions, crossing curves included', nRegions === 7, String(nRegions));   // … and the two rectangles
  await page.click("[data-tool='Finish sketch']");
  await page.click('[data-tool=Extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  await page.click('.cad-dialog [data-accept]');
  await featuresSettled(4);
  const rep = await studio(() => { const st = window.JunctionPartStudio.getState(); return { status: st.features.map((f) => st.reports[f.id].status).join(), bodies: st.bodies.length, message: st.features.map((f) => st.reports[f.id].message || '').join('') }; });
  check('every region of the second sketch extrudes', rep.status === 'ok,ok,ok,ok' && rep.bodies === 1 + nRegions, JSON.stringify(rep));
  await page.waitForTimeout(600);
  await shot('23-everything-extruded');
} catch (e) {
  check('the script ran to the end', false, e.stack || String(e));
  await shot('zz-failure');
}

check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
