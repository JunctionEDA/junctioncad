// Browser test of reference geometry, patterns, mirror, sweep and variables in the real app, done as a person
// does it: toolbar buttons, the generated dialogs, and clicks on faces, edges, sketch curves and reference planes
// found on screen.  It builds
//
//   a plate with a grid of holes   sketch, extrude, a hole on the top face, Linear pattern in two directions
//   a variable driving it          Variables panel, "pitch" typed into the pattern's spacing, then changed
//   mirrored ribs                  a rib on the top face, a Plane midway between two side faces, Mirror about it
//   a swept handle                 a Plane offset from Front, a polyline path on it, a Plane normal to the path,
//                                  a circle on that plane, Sweep added to the plate
//
// then reloads and checks the server kept it all.  Setup as scripts/cad-ui.mjs:
//
//   DATABASE_URL=postgres://… JWT_SECRET=testsecret PUBLIC_URL=http://127.0.0.1:8103 PORT=8103 KC_DEV_LOGIN=1 cargo run
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret E2E_BASE=http://127.0.0.1:8103 [SHOTS=/some/dir] node scripts/cad-patterns-ui.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { tool, toolTitles, openPanel } = await import(new URL('./cad-chrome.mjs', import.meta.url));

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8103').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(300); await page.screenshot({ path: `${SHOTS}/${name}.png` }); } };

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

const S = (page, fn, arg) => page.evaluate(fn, arg);
const state = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return { features: s.features.map((f) => ({ id: f.id, type: f.featureType, name: f.name, params: f.params })), reports: s.reports, bodies: s.bodies.map((b) => ({ id: b.id, faces: b.mesh ? b.mesh.faces.names : [], bbox: b.mesh ? b.mesh.bbox : null })), datums: s.datums }; });
/** The kernel is idle with `n` features, no dialog open, and every built feature has reported. */
const settled = (page, n) => page.waitForFunction((n) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, n, { timeout: 240000, polling: 250 });
/** The dialog's preview has been built (its draft has a report) and the kernel is idle. */
const previewed = (page) => page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.editing && s.reports[s.editing.draft.id]; }, null, { timeout: 240000, polling: 250 });
const click = async (page, at) => { await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.up(); await page.waitForTimeout(60); };
/** Make a dialog field the one viewport clicks fill (a new dialog arms its first empty pick field itself). */
const arm = async (page, key) => { if (!(await page.$(`.cad-dialog [data-param=${key}][data-armed]`))) await page.click(`.cad-dialog [data-param=${key}]`); };
const statusOf = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return s.features.map((f) => `${f.name}:${s.reports[f.id]?.status}${s.reports[f.id]?.message ? ' (' + s.reports[f.id].message + ')' : ''}`); });

/** Where a model point is on screen. */
const screen = (page, p) => S(page, (p) => {
  const st = window.JunctionPartStudio, cam = st.viewport.camera;
  cam.updateMatrixWorld();
  const v = cam.position.clone().set(p[0], p[1], p[2]).project(cam);
  const r = st.viewport.canvas.getBoundingClientRect();
  return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
}, p);

/**
 * A point on screen where the viewport's own picking finds what `want` describes: a face or an edge (by a test on
 * its name and points), a sketch curve, or a reference plane.  Candidates are sampled over the geometry and each
 * is tried with the same pick() the pointer uses, so a click there selects that thing.
 */
const findOnScreen = (page, want) => S(page, (want) => {
  const st = window.JunctionPartStudio, s = st.getState(), cam = st.viewport.camera, r = st.viewport.canvas.getBoundingClientRect();
  cam.updateMatrixWorld();
  const toScreen = (x, y, z) => { const v = cam.position.clone().set(x, y, z).project(cam); return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height }; };
  const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;
  const tests = {
    // a face whose every vertex satisfies the axis test, e.g. { axis: 2, value: 5 } for the top face of a 5 mm plate
    face: (b, i) => { const m = b.mesh; const ok = []; let all = true;
      for (let t = m.faces.start[i]; t < m.faces.start[i] + m.faces.count[i]; t += 3) {
        const v = [0, 1, 2].map((j) => { const vi = m.indices[t + j]; if (!near(m.positions[vi * 3 + want.axis], want.value)) all = false; return [m.positions[vi * 3], m.positions[vi * 3 + 1], m.positions[vi * 3 + 2]]; });
        // points spread over the triangle, so one that the dialog does not cover is found
        for (const [a, b] of [[1 / 3, 1 / 3], [0.6, 0.2], [0.2, 0.6], [0.2, 0.2], [0.45, 0.45], [0.1, 0.45], [0.45, 0.1]]) ok.push([0, 1, 2].map((k) => v[0][k] * (1 - a - b) + v[1][k] * a + v[2][k] * b));
      }
      return all ? ok : []; },
    edge: (b, i) => { const m = b.mesh, out = []; let all = true;
      for (let q = m.edges.start[i]; q < m.edges.start[i] + m.edges.count[i]; q++) { const p = [m.edges.positions[q * 3], m.edges.positions[q * 3 + 1], m.edges.positions[q * 3 + 2]]; for (const [a, v] of want.at) if (!near(p[a], v)) all = false; out.push(p); }
      if (!all || out.length < 2) return [];
      const pts = []; for (let k = 1; k < 8; k++) { const f = k / 8, a = out[0], c = out[out.length - 1]; pts.push([a[0] + (c[0] - a[0]) * f, a[1] + (c[1] - a[1]) * f, a[2] + (c[2] - a[2]) * f]); }
      return pts; },
  };
  // only where the canvas is on top: the feature dialog floats over it
  const tryAt = (pts, accept) => { for (const p of pts) { const sp = toScreen(...p); if (document.elementFromPoint(sp.x, sp.y) !== st.viewport.canvas) continue; const hit = st.view.pick({ clientX: sp.x, clientY: sp.y }); if (hit && accept(hit)) return { x: sp.x, y: sp.y, hit }; } return null; };
  if (want.kind === 'face' || want.kind === 'edge') {
    for (const b of s.bodies) {
      const names = want.kind === 'face' ? b.mesh.faces.names : b.mesh.edges.names;
      for (let i = 0; i < names.length; i++) {
        const pts = tests[want.kind](b, i);
        const got = tryAt(pts, (h) => h.kind === want.kind && h.name === names[i]);
        if (got) return got;
      }
    }
    return null;
  }
  if (want.kind === 'sketch') {
    const v = s.sketches.find((x) => x.featureId === want.feature); if (!v) return null;
    const c = v.curves.find((x) => x.entity === want.entity); if (!c) return null;
    const pts = []; for (let i = 0; i + 5 < c.points.length; i += 3) for (const f of [0.3, 0.5, 0.7]) pts.push([0, 1, 2].map((a) => c.points[i + a] + (c.points[i + 3 + a] - c.points[i + a]) * f));
    return tryAt(pts, (h) => h.kind === 'sketch' && h.featureId === want.feature && h.entity === want.entity);
  }
  if (want.kind === 'datum') {
    const d = s.datums.find((x) => x.featureId === want.feature); if (!d) return null;
    const pts = [];
    if (d.kind === 'plane') for (const u of [-0.4, -0.2, 0, 0.2, 0.4]) for (const v of [0.45, 0.35, 0.25, -0.25, -0.35, -0.45, 0]) pts.push([0, 1, 2].map((a) => d.centre[a] + d.frame.x[a] * u * d.size + d.frame.y[a] * v * d.size));
    return tryAt(pts, (h) => h.kind === 'datum' && h.featureId === want.feature);
  }
  return null;
}, want);

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [], missing = [];
try {
  const uid = user('cad-patterns-ui', 990301);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) missing.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, 'cad-patterns-ui')}&next=/`);
  await page.waitForLoadState('networkidle');
  const project = await page.evaluate(async () => (await (await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Patterns UI test', template: 'pcb' }) })).json()));
  await page.goto(`${BASE}/p/${project.projectId}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  check('a part studio opens', true);
  const toolbar = await toolTitles(page, 'feature');
  check('the toolbar has the new features', ['Plane', 'Axis', 'Point', 'Mirror', 'Linear pattern', 'Circular pattern', 'Sweep', 'Loft', 'Helix'].every((t) => toolbar.includes(t)), toolbar.join(', '));

  // ---------------------------------------------------------------- the plate
  const drawRect = async (a, b) => { await page.click('[data-tool=Rectangle]'); await click(page, await screen(page, a)); await page.mouse.move((await screen(page, b)).x, (await screen(page, b)).y, { steps: 4 }); await click(page, await screen(page, b)); };
  const finishSketch = async () => { await page.click("[data-tool='Finish sketch']"); };
  const openNewSketch = async (plane) => {
    await page.click('[data-tool=Sketch]');
    // with a plane or a flat face selected the sketch starts at once; otherwise the dialog asks for the plane:
    // a click on one starts the sketch on it, ✓ takes the plane the dialog shows (Top)
    await page.waitForSelector('.cad-dialog[data-feature=sketch], .cad-sketch-dialog');
    if (await page.locator('.cad-dialog[data-feature=sketch]').count()) { if (plane) await page.click(`.cad-dialog [data-plane=${plane}]`); else await page.click('.cad-dialog [data-accept]'); }
    await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.sketch && s.kernel.state === 'ready'; }, null, { timeout: 60000 });
    await page.waitForTimeout(700);
  };
  const sketchEntities = () => S(page, () => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return f.params.sketch.entities; });
  await openNewSketch(null);
  await drawRect([-50, -30, 0], [50, 30, 0]);
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return Object.keys(f.params.sketch.entities).length === 8; }, null, { timeout: 10000 });
  const xs = Object.values(await sketchEntities()).filter((e) => e.type === 'point').map((p) => `${p.x},${p.y}`);
  check('the plate outline is drawn where it was clicked', xs.includes('-50,-30') && xs.includes('50,30'), xs.join(' '));
  await finishSketch();
  await page.click('[data-tool=Extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  await page.fill('.cad-dialog input[data-param=depth]', '5');
  await previewed(page);
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 2);
  let st = await state(page);
  check('a 100 × 60 × 5 plate', st.bodies.length === 1 && Math.abs(st.bodies[0].bbox[5] - 5) < 1e-6, JSON.stringify(st.bodies[0]?.bbox));
  const plateId = st.bodies[0].id;

  // ---------------------------------------------------------------- one hole, on the top face
  const top = await findOnScreen(page, { kind: 'face', axis: 2, value: 5 });
  check('the top face is found on screen', !!top, JSON.stringify(top?.hit));
  await click(page, top);
  await openNewSketch(null);
  check('a sketch started with the top face selected lies on it', (await S(page, () => { const s = window.JunctionPartStudio.getState(); return s.features.find((f) => f.id === s.sketch.featureId).params.plane.kind; })) === 'face');
  await page.click('[data-tool=Circle]');
  await click(page, await screen(page, [-40, -20, 5]));
  await page.mouse.move((await screen(page, [-37, -20, 5])).x, (await screen(page, [-37, -20, 5])).y, { steps: 3 });
  await click(page, await screen(page, [-37, -20, 5]));
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return Object.values(f.params.sketch.entities).some((e) => e.type === 'circle'); }, null, { timeout: 10000 });
  const circ = Object.values(await sketchEntities()).find((e) => e.type === 'circle');
  check('a circle for the hole', circ && circ.r > 1 && circ.r < 5, `r = ${circ?.r}`);
  await finishSketch();
  await page.click('[data-tool=Extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  await page.click('.cad-dialog [data-param=operation] >> text=Remove');
  await page.fill('.cad-dialog input[data-param=depth]', '5');
  await page.check('.cad-dialog input[data-param=flip]');
  await previewed(page);
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 4);
  st = await state(page);
  const cutId = st.features[3].id;
  check('the hole is cut through the plate', st.bodies.length === 1 && st.bodies[0].faces.some((n) => n.startsWith(`${cutId}:side:`)), st.bodies[0].faces.join(' '));

  // ---------------------------------------------------------------- Linear pattern, two directions
  await tool(page, 'Linear pattern');
  await page.waitForSelector('.cad-dialog[data-feature=linear-pattern]');
  await page.click(`.cad-dialog [data-feature-option='${cutId}']`);
  await arm(page, 'direction');
  const alongX = await findOnScreen(page, { kind: 'edge', at: [[1, -30], [2, 5]] });
  check('an edge along the plate is found on screen', !!alongX, JSON.stringify(alongX?.hit));
  await click(page, alongX);
  await page.fill('.cad-dialog input[data-param=spacing]', '20');
  await page.fill('.cad-dialog input[data-param=count]', '5');
  await page.check('.cad-dialog input[data-param=second]');
  await arm(page, 'direction2');
  const alongY = await findOnScreen(page, { kind: 'edge', at: [[0, -50], [2, 5]] });
  await click(page, alongY);
  await page.fill('.cad-dialog input[data-param=spacing2]', '20');
  await page.fill('.cad-dialog input[data-param=count2]', '3');
  await previewed(page);
  const draft = await S(page, () => window.JunctionPartStudio.getState().editing.draft.params);
  check('the dialog holds what was clicked and typed', draft.features[0] === cutId && draft.direction?.kind === 'edge' && draft.direction2?.kind === 'edge' && draft.count === 5 && draft.count2 === 3, JSON.stringify({ d: draft.direction, d2: draft.direction2 }));
  const ms = (await S(page, () => { const s = window.JunctionPartStudio.getState(); return s.reports[s.editing.draft.id]; })).ms;
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 5);
  st = await state(page);
  const lpId = st.features[4].id;
  const holeWalls = st.bodies[0].faces.filter((n) => n.includes(`${cutId}:side:`));
  check('a 5 × 3 grid of holes: the original and 14 copies, each named by its place', holeWalls.length === 15 && holeWalls.some((n) => n.startsWith(`${lpId}:i5.3:`)), `${holeWalls.length} hole walls`);
  check('the pattern rebuilds quickly', ms !== undefined && ms < 3000, `${ms} ms`);
  await S(page, () => window.JunctionPartStudio.viewport.fit());
  await shot(page, '01-hole-grid');

  // ---------------------------------------------------------------- a variable drives the spacing
  await page.click('[data-add-variable]');
  await page.waitForSelector('[data-variable=v1]');
  await page.fill('[data-variable=v1] input[aria-label="Variable name"]', 'pitch');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-variable=pitch]');
  await page.fill('[data-variable=pitch] input[aria-label="Value of pitch"]', '20 mm');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-variable=pitch] [data-value]')?.getAttribute('data-value') === '20');
  check('a variable is added in the Variables panel', true);
  await page.dblclick(`[data-feature-row][data-feature-type=linear-pattern]`);
  await page.waitForSelector('.cad-dialog[data-feature=linear-pattern]');
  await page.fill('.cad-dialog input[data-param=spacing]', 'pitch');
  await page.fill('.cad-dialog input[data-param=spacing2]', 'pitch');
  await previewed(page);
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 5);
  let lp = (await state(page)).features[4].params;
  check('a number field takes the variable\'s name', lp.$expr?.spacing === 'pitch' && lp.spacing === 20, JSON.stringify(lp.$expr));
  const holeAt = (name) => S(page, (name) => { const b = window.JunctionPartStudio.getState().bodies[0].mesh; const i = b.faces.names.indexOf(name); let x = 0, n = 0; for (let t = b.faces.start[i]; t < b.faces.start[i] + b.faces.count[i]; t++) { x += b.positions[b.indices[t] * 3]; n++; } return x / n; }, name);
  const copyName = (await state(page)).bodies[0].faces.find((n) => n.startsWith(`${lpId}:i2.1:`) && n.includes(':side:'));
  const x20 = await holeAt(copyName);
  await page.fill('[data-variable=pitch] input[aria-label="Value of pitch"]', '19');
  await page.keyboard.press('Enter');
  await page.waitForFunction((id) => window.JunctionPartStudio.getState().features.find((f) => f.id === id).params.spacing === 19, lpId, { timeout: 60000 });
  await page.waitForFunction((name) => { const b = window.JunctionPartStudio.getState().bodies[0].mesh; const i = b.faces.names.indexOf(name); let x = 0, n = 0; for (let t = b.faces.start[i]; t < b.faces.start[i] + b.faces.count[i]; t++) { x += b.positions[b.indices[t] * 3]; n++; } return Math.abs(x / n - -21) < 0.2; }, copyName, { timeout: 240000, polling: 250 }).catch(() => {});
  await settled(page, 5);
  const x19 = await holeAt(copyName);
  check('changing the variable moves the copies, and the stored number follows', Math.abs(x20 - -20) < 0.2 && Math.abs(x19 - -21) < 0.2, `copy 2 at x ${x20.toFixed(2)} then ${x19.toFixed(2)}`);
  await shot(page, '02-variable');

  // ---------------------------------------------------------------- a rib, a midplane, Mirror
  const topAgain = await findOnScreen(page, { kind: 'face', axis: 2, value: 5 });
  await click(page, topAgain);
  await openNewSketch(null);
  await drawRect([10, 8, 5], [45, 12, 5]);
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return Object.keys(f.params.sketch.entities).length === 8; }, null, { timeout: 10000 });
  await finishSketch();
  await page.click('[data-tool=Extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  await page.click('.cad-dialog [data-param=operation] >> text=Add');
  await page.fill('.cad-dialog input[data-param=depth]', '10');
  await previewed(page);
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 7);
  st = await state(page);
  const ribId = st.features[6].id;
  check('a rib is added to the plate', st.bodies.length === 1 && Math.abs(st.bodies[0].bbox[5] - 15) < 1e-6, JSON.stringify(st.bodies[0].bbox));

  await tool(page, 'Plane');
  await page.waitForSelector('.cad-dialog[data-feature=plane]');
  await page.selectOption('.cad-dialog select[data-param=method]', 'midplane');
  await arm(page, 'faces');
  const turn = (d) => S(page, (d) => { const vp = window.JunctionPartStudio.viewport, v = vp.camera.position.clone(); vp.lookAlong(v.clone().set(d[0], d[1], d[2]), v.clone().set(0, 0, 1), false); vp.fit(); }, d);
  const turned = async (d) => { await turn(d); await page.waitForTimeout(600); };   // fit() eases the camera in
  await turned([1, 0.5, -0.5]);
  const left = await findOnScreen(page, { kind: 'face', axis: 0, value: -50 });
  check('the left side face is found after turning the view', !!left, JSON.stringify(left?.hit));
  await click(page, left);
  await turned([-1, 0.5, -0.5]);
  const rightFace = await findOnScreen(page, { kind: 'face', axis: 0, value: 50 });
  await click(page, rightFace);
  await previewed(page);
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 8);
  st = await state(page);
  const planeId = st.features[7].id;
  const mid = st.datums.find((d) => d.featureId === planeId);
  check('a Plane midway between the two side faces', mid && Math.abs(mid.frame.origin[0]) < 1e-6 && Math.abs(Math.abs(mid.frame.normal[0]) - 1) < 1e-9, JSON.stringify(mid?.frame));
  await S(page, () => { const vp = window.JunctionPartStudio.viewport; vp.setView('iso', false); vp.fit(); });
  await shot(page, '03-midplane');

  await tool(page, 'Mirror');
  await page.waitForSelector('.cad-dialog[data-feature=mirror]');
  await page.click(`.cad-dialog [data-feature-option='${ribId}']`);
  await arm(page, 'plane');
  const onPlane = await findOnScreen(page, { kind: 'datum', feature: planeId });
  check('the reference plane is picked in the viewport', !!onPlane, JSON.stringify(onPlane?.hit));
  await click(page, onPlane);
  await previewed(page);
  const mirrorDraft = await S(page, () => window.JunctionPartStudio.getState().editing.draft.params.plane);
  check('the mirror plane is the reference plane', mirrorDraft?.kind === 'datum' && mirrorDraft.feature === planeId, JSON.stringify(mirrorDraft));
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 9);
  st = await state(page);
  const miId = st.features[8].id;
  const mirrored = st.bodies[0].faces.filter((n) => n.startsWith(`${miId}:m:`));
  check('the rib is mirrored onto the other half', st.bodies.length === 1 && mirrored.length >= 3 && Math.abs(st.bodies[0].bbox[0] - -50) < 1e-6, `${mirrored.length} mirrored faces`);
  await shot(page, '04-mirrored-ribs');

  // ---------------------------------------------------------------- a swept handle
  await tool(page, 'Plane');
  await page.waitForSelector('.cad-dialog[data-feature=plane]');
  await page.click('.cad-dialog [data-plane=front]');
  await page.fill('.cad-dialog input[data-param=distance]', '10');
  await previewed(page);
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 10);
  st = await state(page);
  const offsetId = st.features[9].id;
  const off = st.datums.find((d) => d.featureId === offsetId);
  check('a Plane offset 10 from Front', off && Math.abs(off.frame.origin[1] - -10) < 1e-9, JSON.stringify(off?.frame.origin));
  // a sketch on it: select the plane in the viewport, then Sketch
  const offAt = await findOnScreen(page, { kind: 'datum', feature: offsetId });
  await click(page, offAt);
  await openNewSketch(null);
  const pathSketch = await S(page, () => window.JunctionPartStudio.getState().sketch.featureId);
  check('a sketch started with the reference plane selected lies on it', (await S(page, (id) => window.JunctionPartStudio.getState().features.find((f) => f.id === id).params.plane, pathSketch)).kind === 'datum');
  await page.click('[data-tool=Line]');
  for (const p of [[-20, -10, 5], [-20, -10, 25], [20, -10, 25], [20, -10, 5]]) await click(page, await screen(page, p));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return Object.values(f.params.sketch.entities).filter((e) => e.type === 'line').length === 3; }, null, { timeout: 10000 });
  const pathEntities = await sketchEntities();
  const firstLine = Object.entries(pathEntities).find(([, e]) => e.type === 'line' && (() => { const a = pathEntities[e.a], b = pathEntities[e.b]; return a.x === -20 && b.x === -20; })())?.[0];
  check('a three-line path is drawn on the reference plane', !!firstLine, Object.keys(pathEntities).join(' '));
  await finishSketch();
  await settled(page, 11);

  await tool(page, 'Plane');
  await page.waitForSelector('.cad-dialog[data-feature=plane]');
  await page.selectOption('.cad-dialog select[data-param=method]', 'normal');
  await arm(page, 'curve');
  const onPath = await findOnScreen(page, { kind: 'sketch', feature: pathSketch, entity: firstLine });
  check('the path\'s first line is picked in the viewport', !!onPath, JSON.stringify(onPath?.hit));
  await click(page, onPath);
  await page.fill('.cad-dialog input[data-param=position]', '0');
  await previewed(page);
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 12);
  st = await state(page);
  const normalId = st.features[11].id;
  const nrm = st.datums.find((d) => d.featureId === normalId);
  check('a Plane normal to the path at its start', nrm && Math.abs(Math.abs(nrm.frame.normal[2]) - 1) < 1e-9 && Math.abs(nrm.frame.origin[2] - 5) < 1e-6, JSON.stringify(nrm?.frame));

  await click(page, await findOnScreen(page, { kind: 'datum', feature: normalId }));
  await openNewSketch(null);
  await page.click('[data-tool=Circle]');
  const o = nrm.frame.origin, rim = [o[0] + nrm.frame.x[0] * 3, o[1] + nrm.frame.x[1] * 3, o[2] + nrm.frame.x[2] * 3];
  await click(page, await screen(page, o));
  await page.mouse.move((await screen(page, rim)).x, (await screen(page, rim)).y, { steps: 3 });
  await click(page, await screen(page, rim));
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return Object.values(f.params.sketch.entities).some((e) => e.type === 'circle'); }, null, { timeout: 10000 });
  await finishSketch();
  await settled(page, 13);
  const profileId = (await state(page)).features[12].id;

  await tool(page, 'Sweep');
  await page.waitForSelector('.cad-dialog[data-feature=sweep]');
  await page.selectOption('.cad-dialog select[data-param=profile]', profileId);
  await arm(page, 'path');
  await click(page, await findOnScreen(page, { kind: 'sketch', feature: pathSketch, entity: firstLine }));
  await page.click('.cad-dialog [data-param=operation] >> text=Add');
  await previewed(page);
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 14);
  st = await state(page);
  const swId = st.features[13].id;
  const swept = st.bodies[0].faces.filter((n) => n.startsWith(`${swId}:`));
  check('the handle is swept along the path and joined to the plate', st.bodies.length === 1 && swept.length >= 3 && st.bodies[0].bbox[5] > 27, `${swept.length} handle faces, top ${st.bodies[0].bbox[5]}`);
  const statuses = await statusOf(page);
  check('every feature built', statuses.every((s) => s.endsWith(':ok')), statuses.join(', '));
  await S(page, () => { const vp = window.JunctionPartStudio.viewport; vp.setView('iso', false); vp.fit(); });
  await shot(page, '05-swept-handle');
  await S(page, (d) => { const vp = window.JunctionPartStudio.viewport, v = vp.camera.position.clone(); vp.lookAlong(v.clone().set(d[0], d[1], d[2]), v.clone().set(0, 0, 1), false); vp.fit(); }, [0.6, 1, -0.7]);
  await shot(page, '06-from-behind');

  // ---------------------------------------------------------------- the server kept it
  const before = await state(page);
  await page.reload();
  await settled(page, 14);
  const after = await state(page);
  check('after a reload the model is rebuilt the same', after.bodies.length === 1 && JSON.stringify(after.bodies[0].faces.slice().sort()) === JSON.stringify(before.bodies[0].faces.slice().sort()) && after.datums.length === before.datums.length);
  check('the variable came back from the server', (await page.getAttribute('[data-variable=pitch] [data-value]', 'data-value')) === '19');
  check('no page errors', !errors.length, errors.slice(0, 5).join(' | '));
  if (missing.length) console.log('requests that failed:', Array.from(new Set(missing)).join(', '));
} catch (e) {
  check('the script ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' / ') : String(e));
} finally {
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
