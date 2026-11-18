// Browser test of the part studio's solid features in the real app, done as a person would: build a small
// enclosure from the toolbar and the viewport (sketch a rectangle, extrude it, round its corners by clicking the
// edges, shell it open at the top, sketch bosses on the floor, extrude them onto the floor, sketch on a boss top
// and put tapped holes there), then edit the first extrude and see every later feature follow; a fillet too big
// to build shows its error in the dialog; Extrude's end conditions show and hide their fields.
//
// Setup as scripts/cad-ui.mjs: a server with KC_DEV_LOGIN=1, Playwright, psql.  A server binary embeds the
// mechanical bundles at build time; to test bundles built from this tree without rebuilding the server, build
// them with `node scripts/cad-features-build.mjs DIR` and pass CAD_DIST=DIR: the page is then served those two
// files in place of the embedded ones.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev E2E_BASE=http://127.0.0.1:8102 [CAD_DIST=dir] [SHOTS=dir] node scripts/cad-features-ui.mjs
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
const SHOTS = process.env.SHOTS || '', DIST = process.env.CAD_DIST || '';
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

const S = (page, fn, arg) => page.evaluate(fn, arg);
/** `n` features, the kernel idle, no dialog, and every built feature has reported. */
const settled = (page, n) => page.waitForFunction((n) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, n, { timeout: 60000 });
/** The open dialog's draft has been built (its report is in), whatever the result. */
const previewed = (page) => page.waitForFunction(() => {
  const s = window.JunctionPartStudio.getState();
  return s.editing && s.kernel.state === 'ready' && !!s.reports[s.editing.draft.id];
}, null, { timeout: 60000 });
const statuses = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return s.features.map((f) => `${f.featureType}:${s.reports[f.id]?.status}`).join(' '); });
const click = async (page, p) => { await page.mouse.move(p.x, p.y, { steps: 2 }); await page.mouse.down(); await page.mouse.up(); };

/** Where a world point is on the screen. */
const screenOf = (page, p) => S(page, (p) => {
  const st = window.JunctionPartStudio, c = st.viewport.canvas.getBoundingClientRect();
  const v = new (Object.getPrototypeOf(st.viewport.camera.position).constructor)(p[0], p[1], p[2]);
  const q = st.viewport.project(v);
  return { x: c.left + q.x, y: c.top + q.y };
}, p);
/** The middle of a named edge of the mesh, in the world. */
const edgeMid = (page, match) => S(page, (match) => {
  const s = window.JunctionPartStudio.getState();
  for (const b of s.bodies) {
    const m = b.mesh; if (!m) continue;
    const i = m.edges.names.findIndex((n) => match.every((x) => n.includes(x)));
    if (i < 0) continue;
    const a = m.edges.start[i], n = m.edges.count[i], seg = Math.floor(n / 2) & ~1;
    const p = (j) => [m.edges.positions[(a + j) * 3], m.edges.positions[(a + j) * 3 + 1], m.edges.positions[(a + j) * 3 + 2]];
    const q0 = p(seg), q1 = p(seg + 1);
    return { name: m.edges.names[i], body: b.id, at: [(q0[0] + q1[0]) / 2, (q0[1] + q1[1]) / 2, (q0[2] + q1[2]) / 2] };
  }
  return null;
}, match);
/** A point inside a named face of the mesh: the centre of its largest triangle. */
const facePoint = (page, match) => S(page, (match) => {
  const s = window.JunctionPartStudio.getState();
  for (const b of s.bodies) {
    const m = b.mesh; if (!m) continue;
    const i = m.faces.names.findIndex((n) => match.every((x) => n.includes(x)));
    if (i < 0) continue;
    let best = null, area = -1;
    for (let t = m.faces.start[i]; t < m.faces.start[i] + m.faces.count[i]; t += 3) {
      const v = [0, 1, 2].map((k) => { const j = m.indices[t + k] * 3; return [m.positions[j], m.positions[j + 1], m.positions[j + 2]]; });
      const u = v[1].map((x, k) => x - v[0][k]), w = v[2].map((x, k) => x - v[0][k]);
      const a = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
      if (a > area) { area = a; best = [0, 1, 2].map((k) => (v[0][k] + v[1][k] + v[2][k]) / 3); }
    }
    return { name: m.faces.names[i], body: b.id, at: best };
  }
  return null;
}, match);
/** The hovered pick once the pointer rests at p. */
const hoverAt = async (page, p) => { await page.mouse.move(p.x, p.y, { steps: 3 }); await page.waitForTimeout(120); return S(page, () => window.JunctionPartStudio.getState().hover); };

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function open(uid, login) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  if (DIST) {
    for (const f of ['mechanical.js', 'cad-worker.js']) {
      const body = fs.readFileSync(path.join(DIST, f));
      await ctx.route(new RegExp(`/static/dist/${f.replace('.', '\\.')}(\\?.*)?$`), (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body }));
    }
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}

try {
  const uid = user('cad-features-ui', 990201);
  const page = await open(uid, 'cad-features-ui');
  const project = await page.evaluate(async () => {
    const r = await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Enclosure test', template: 'pcb' }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  const pid = project.body.projectId;
  await page.goto(`${BASE}/p/${pid}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  const tools = await toolTitles(page, 'feature');
  check('the toolbar has a button for every feature', ['Extrude', 'Revolve', 'Fillet', 'Chamfer', 'Shell', 'Draft', 'Hole', 'Boolean', 'Split', 'Transform', 'Delete body'].every((t) => tools.includes(t)), tools.join(', '));

  // ---------------------------------------------------------------- the box: a 60 × 40 rectangle, 25 tall
  await page.click('[data-tool=Sketch]');
  await page.waitForSelector('.cad-dialog[data-feature=sketch]');
  await page.click('.cad-dialog [data-accept]');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.sketch && s.features.length === 1 && s.kernel.state === 'ready'; }, null, { timeout: 90000 });
  await page.waitForTimeout(700);
  const entities = (n) => page.waitForFunction((n) => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return Object.keys(f.params.sketch.entities).length === n; }, n, { timeout: 10000 });
  await page.click('[data-tool=Rectangle]');
  await click(page, await screenOf(page, [-30, -20, 0]));
  await page.mouse.move(...Object.values(await screenOf(page, [30, 20, 0])), { steps: 5 });
  await click(page, await screenOf(page, [30, 20, 0]));
  await entities(8);
  const rect = await S(page, () => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return Object.values(f.params.sketch.entities).filter((e) => e.type === 'point').map((p) => [p.x, p.y]); });
  const xs = rect.map((p) => p[0]), ys = rect.map((p) => p[1]);
  const W = Math.max(...xs) - Math.min(...xs), D = Math.max(...ys) - Math.min(...ys);
  check('a rectangle is drawn by clicking its corners', W > 40 && D > 25, `${W} × ${D}`);
  await page.click("[data-tool='Finish sketch']");

  await page.click('[data-tool=Extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  await page.fill('.cad-dialog input[data-param=depth]', '25');
  // the end conditions show their own fields
  await page.selectOption('.cad-dialog select[data-param=endType]', 'upToFace');
  check('Up to face asks for the face', await page.isVisible('.cad-dialog [data-param=face]') && !(await page.isVisible('.cad-dialog input[data-param=depth]')));
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.reports[s.editing.draft.id]?.status === 'error'; }, null, { timeout: 30000 }).catch(() => {});
  const why = await S(page, () => { const s = window.JunctionPartStudio.getState(); return s.reports[s.editing.draft.id]; });
  check('without a face the dialog says what to do', why.status === 'error' && /Pick the face/.test(why.message) && /Pick the face/.test(await page.textContent('.cad-dialog [role=status]')), JSON.stringify(why));
  await shot(page, '01-extrude-up-to-face-empty');
  await page.selectOption('.cad-dialog select[data-param=endType]', 'blind');
  await page.check('.cad-dialog input[data-param=thin]');
  check('Thin shows its wall fields', await page.isVisible('.cad-dialog input[data-param=thickness]'));
  await page.uncheck('.cad-dialog input[data-param=thin]');
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 2);
  await page.click('.v3-views [data-view=fit]');
  await page.waitForTimeout(300);
  check('the box is built', (await statuses(page)) === 'sketch:ok extrude:ok', await statuses(page));
  await shot(page, '02-box');

  // ---------------------------------------------------------------- round the four vertical edges, by clicking them
  await tool(page, 'Fillet');
  await page.waitForSelector('.cad-dialog[data-feature=fillet] [data-param=edges][data-armed]');
  let clicked = 0;
  const verticals = await S(page, () => {
    const s = window.JunctionPartStudio.getState(), m = s.bodies[0].mesh;
    // vertical edges: the ones between two side faces
    return m.edges.names.filter((n) => (n.match(/:side:/g) || []).length === 2);
  });
  const done = new Set();
  for (let turn = 0; turn < 3 && done.size < verticals.length; turn++) {
    for (const name of verticals) {
      if (done.has(name)) continue;
      const e = await edgeMid(page, [name]);
      const p = await screenOf(page, e.at);
      const h = await hoverAt(page, p);
      if (h && h.kind === 'edge' && h.name === name) { await click(page, p); clicked++; done.add(name); }
    }
    if (done.size < verticals.length) {
      // an edge behind the box: turn the view with a right-drag, as a person would, and look again
      const c = await S(page, () => { const r = window.JunctionPartStudio.viewport.canvas.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      await page.mouse.move(c.x - 150, c.y + 200); await page.mouse.down({ button: 'right' });
      await page.mouse.move(c.x + 150, c.y + 200, { steps: 10 }); await page.mouse.up({ button: 'right' });
      await page.waitForTimeout(150);
    }
  }
  await page.fill('.cad-dialog input[data-param=radius]', '5');
  await previewed(page);
  const picked = await S(page, () => window.JunctionPartStudio.getState().editing.draft.params.edges.length);
  check('clicking edges in the viewport (turning it to reach the hidden one) fills the Fillet dialog', picked === 4 && picked === clicked,`${picked} of ${verticals.length} vertical edges`);
  await shot(page, '03-fillet-preview');
  // too large a radius: the dialog says so, the model is left as it was
  await page.fill('.cad-dialog input[data-param=radius]', '40');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); const r = s.reports[s.editing.draft.id]; return s.kernel.state === 'ready' && r && r.status === 'error'; }, null, { timeout: 30000 });
  check('a radius too large shows an error in the dialog', /smaller radius/.test(await page.textContent('.cad-dialog [role=status]')));
  await shot(page, '04-fillet-error');
  await page.fill('.cad-dialog input[data-param=radius]', '5');
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 3);

  // ---------------------------------------------------------------- shell it, open at the top
  await page.click('[data-tool=Shell]');
  await page.waitForSelector('.cad-dialog[data-feature=shell] [data-param=faces][data-armed]');
  const topFace = await facePoint(page, [':end:']);
  await click(page, await screenOf(page, topFace.at));
  await page.fill('.cad-dialog input[data-param=thickness]', '2');
  await previewed(page);
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 4);
  check('Shell opens the top', (await statuses(page)).endsWith('shell:ok') && (await S(page, () => window.JunctionPartStudio.getState().bodies[0].mesh.faces.names.some((n) => n.includes(':from(')))), await statuses(page));
  await page.waitForTimeout(300);
  await shot(page, '05-shelled');

  // ---------------------------------------------------------------- four bosses on the floor
  const floor = await S(page, () => window.JunctionPartStudio.getState().bodies[0].mesh.faces.names.find((n) => /:from\(.*:start:/.test(n)));
  await S(page, (name) => { const st = window.JunctionPartStudio, b = st.getState().bodies[0]; st.select([{ kind: 'face', body: b.id, name, point: [0, 0, 0] }]); }, floor);
  // a flat face is selected: Sketch asks nothing and drawing starts on it
  await page.click('[data-tool=Sketch]');
  await page.waitForSelector('.cad-sketch-dialog');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.sketch && s.sketches.some((v) => v.featureId === s.sketch.featureId) && s.kernel.state === 'ready'; }, null, { timeout: 30000 });
  await page.waitForTimeout(900);
  const frameNow = () => S(page, () => { const s = window.JunctionPartStudio.getState(); return s.sketches.find((v) => v.featureId === s.sketch.featureId).frame; });
  let fr = await frameNow();
  const world = (f, u, v) => [0, 1, 2].map((k) => f.origin[k] + u * f.x[k] + v * f.y[k]);
  const inPlane = (f, p) => { const d = [0, 1, 2].map((k) => p[k] - f.origin[k]); return [d[0] * f.x[0] + d[1] * f.x[1] + d[2] * f.x[2], d[0] * f.y[0] + d[1] * f.y[1] + d[2] * f.y[2]]; };
  const centres = [[-20, -10], [20, -10], [-20, 10], [20, 10]];
  await page.click('[data-tool=Circle]');
  let n = 0;
  for (const [x, y] of centres) {
    const c = inPlane(fr, [x, y, 2]);
    await click(page, await screenOf(page, world(fr, c[0], c[1])));
    const edgeAt = await screenOf(page, world(fr, c[0] + 4, c[1]));
    await page.mouse.move(edgeAt.x, edgeAt.y, { steps: 3 });
    await click(page, edgeAt);
    n += 2; await entities(n);
  }
  await shot(page, '06-boss-sketch');
  await page.click("[data-tool='Finish sketch']");
  await page.click('[data-tool=Extrude]');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  await page.click('.cad-dialog [data-param=operation] >> text=Add');
  await page.fill('.cad-dialog input[data-param=depth]', '12');
  await previewed(page);
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 6);
  check('the bosses join the box', (await statuses(page)).endsWith('sketch:ok extrude:ok') && (await S(page, () => window.JunctionPartStudio.getState().bodies.length)) === 1, await statuses(page));

  // ---------------------------------------------------------------- holes: a sketch on a boss top, a circle on each boss
  const bossTop = await S(page, () => { const s = window.JunctionPartStudio.getState(), f = s.features[5]; return s.bodies[0].mesh.faces.names.find((n) => n.startsWith(`${f.id}:end:`)); });
  await S(page, (name) => { const st = window.JunctionPartStudio, b = st.getState().bodies[0]; st.select([{ kind: 'face', body: b.id, name, point: [0, 0, 0] }]); }, bossTop);
  // a flat face is selected: Sketch asks nothing and drawing starts on it
  await page.click('[data-tool=Sketch]');
  await page.waitForSelector('.cad-sketch-dialog');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.sketch && s.sketches.some((v) => v.featureId === s.sketch.featureId) && s.kernel.state === 'ready'; }, null, { timeout: 30000 });
  await page.waitForTimeout(900);
  fr = await frameNow();
  check('the hole sketch lies on the boss tops', Math.abs(fr.origin[2] - 14) < 1e-6, JSON.stringify(fr.origin));
  await page.click('[data-tool=Circle]');
  n = 0;
  for (const [x, y] of centres) {
    const c = inPlane(fr, [x, y, 14]);
    await click(page, await screenOf(page, world(fr, c[0], c[1])));
    const edgeAt = await screenOf(page, world(fr, c[0] + 1.5, c[1]));
    await page.mouse.move(edgeAt.x, edgeAt.y, { steps: 3 });
    await click(page, edgeAt);
    n += 2; await entities(n);
  }
  await page.click("[data-tool='Finish sketch']");
  await page.click('[data-tool=Hole]');
  await page.waitForSelector('.cad-dialog[data-feature=hole]');
  await page.selectOption('.cad-dialog select[data-param=standard]', 'M3');
  await page.click('.cad-dialog [data-param=fit] >> text=Tapped');
  await page.click('.cad-dialog [data-param=endType] >> text=Depth');
  await page.fill('.cad-dialog input[data-param=depth]', '10');
  await previewed(page);
  await shot(page, '07-hole-dialog');
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 8);
  const all = await statuses(page);
  check('the holes are drilled', all === 'sketch:ok extrude:ok fillet:ok shell:ok sketch:ok extrude:ok sketch:ok hole:ok', all);
  const holes = await S(page, () => window.JunctionPartStudio.getState().bodies[0].mesh.faces.names.filter((n) => n.endsWith(':wall')).length);
  check('four hole walls, named', holes === 4, `${holes}`);
  const mass1 = await S(page, () => window.JunctionPartStudio.kernel.call('mass-properties', { body: window.JunctionPartStudio.getState().bodies[0].id }));
  await page.click('.v3-views [data-view=iso]');
  await page.waitForTimeout(500);
  await shot(page, '08-enclosure');
  // look into it from above
  await page.click('.v3-views [data-view=top]');
  await page.waitForTimeout(500);
  await shot(page, '09-enclosure-top');
  await page.click('.v3-views [data-view=iso]');

  // ---------------------------------------------------------------- edit the box: every later feature follows
  await page.dblclick('[data-feature-row][data-feature-type=extrude] >> nth=0');
  await page.waitForSelector('.cad-dialog[data-feature=extrude]');
  await page.fill('.cad-dialog input[data-param=depth]', '32');
  await page.click('.cad-dialog [data-accept]');
  // (while the dialog is open the model is shown as of that feature; after Done everything after it is built)
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return !s.editing && s.kernel.state === 'ready' && s.features[1].params.depth === 32 && s.features.every((f) => s.reports[f.id] && s.reports[f.id].status !== 'rolled-back'); }, null, { timeout: 60000 });
  const after = await statuses(page);
  const mass2 = await S(page, () => window.JunctionPartStudio.kernel.call('mass-properties', { body: window.JunctionPartStudio.getState().bodies[0].id }));
  check('a taller box rebuilds fillet, shell, bosses and holes from their names', after === all && mass2.volume > mass1.volume, `${after}; ${Math.round(mass1.volume)} → ${Math.round(mass2.volume)} mm³`);
  await page.waitForTimeout(400);
  await shot(page, '10-taller');

  // ---------------------------------------------------------------- a second part studio: revolve, chamfer, transform
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio && window.JunctionPartStudio.getState(); return s && s.loaded && s.features.length === 0; }, null, { timeout: 30000 });
  await page.click('[data-tool=Sketch]');
  await page.waitForSelector('.cad-dialog[data-feature=sketch]');
  // a click on a plane is all a new sketch needs: drawing starts on it
  await page.click('.cad-dialog [data-plane=front]');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.sketch && s.features.length === 1 && s.kernel.state === 'ready'; }, null, { timeout: 90000 });
  await page.waitForTimeout(700);
  await page.click('[data-tool=Rectangle]');
  await click(page, await screenOf(page, [5, 0, 0]));
  await page.mouse.move(...Object.values(await screenOf(page, [15, 0, 20])), { steps: 5 });
  await click(page, await screenOf(page, [15, 0, 20]));
  await entities(8);
  await page.click("[data-tool='Finish sketch']");
  await page.click('[data-tool=Revolve]');
  await page.waitForSelector('.cad-dialog[data-feature=revolve]');
  await previewed(page);
  const noLine = await S(page, () => { const s = window.JunctionPartStudio.getState(); return s.reports[s.editing.draft.id]; });
  check('Revolve without an axis line says what to draw', noLine.status === 'error' && /Draw a line/.test(noLine.message), noLine.message);
  await page.click('.cad-dialog [data-param=axisType] >> text=Sketch Y');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.reports[s.editing.draft.id]?.status === 'ok' && s.bodies.length === 1; }, null, { timeout: 30000 });
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 2);
  await page.click('.v3-views [data-view=fit]');
  await page.waitForTimeout(300);
  const tube = await S(page, () => window.JunctionPartStudio.kernel.call('mass-properties', { body: window.JunctionPartStudio.getState().bodies[0].id }));
  check('Revolve about the sketch\'s vertical axis makes a tube', Math.abs(tube.volume - Math.PI * (225 - 25) * 20) < 1, `${Math.round(tube.volume)} mm³`);
  await shot(page, '11-revolve');

  // chamfer the top outer rim: click it
  await tool(page, 'Chamfer');
  await page.waitForSelector('.cad-dialog[data-feature=chamfer] [data-param=edges][data-armed]');
  // the outer top circle: the highest edge, and of those the widest
  const outer = await S(page, () => {
    const m = window.JunctionPartStudio.getState().bodies[0].mesh;
    let best = null;
    m.edges.names.forEach((n, i) => {
      let zmax = -1e9, rmax = 0;
      for (let j = m.edges.start[i]; j < m.edges.start[i] + m.edges.count[i]; j++) { const x = m.edges.positions[j * 3], y = m.edges.positions[j * 3 + 1], z = m.edges.positions[j * 3 + 2]; zmax = Math.max(zmax, z); rmax = Math.max(rmax, Math.hypot(x, y)); }
      if (!best || zmax > best.z + 1e-6 || (Math.abs(zmax - best.z) < 1e-6 && rmax > best.r)) best = { name: n, z: zmax, r: rmax };
    });
    return best;
  });
  const oe = await edgeMid(page, [outer.name]);
  const op = await screenOf(page, oe.at);
  await hoverAt(page, op);
  await click(page, op);
  await page.fill('.cad-dialog input[data-param=distance]', '1.5');
  await previewed(page);
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 3);
  const bevel = await S(page, () => { const s = window.JunctionPartStudio.getState(); return { st: s.features.map((f) => s.reports[f.id].status).join(), faces: s.bodies[0].mesh.faces.names.filter((n) => n.includes(':from(')) }; });
  check('clicking the rim and Chamfer bevels it', bevel.st === 'ok,ok,ok' && bevel.faces.length === 1, JSON.stringify(bevel));

  // transform: a copy, 40 mm along X
  await S(page, () => { const st = window.JunctionPartStudio, b = st.getState().bodies[0]; st.select([{ kind: 'face', body: b.id, name: b.mesh.faces.names[0], point: [0, 0, 0] }]); });
  await tool(page, 'Transform');
  await page.waitForSelector('.cad-dialog[data-feature=transform]');
  await page.click('.cad-dialog [data-param=bodies]');
  const b0 = await facePoint(page, ['side:']);
  await click(page, await screenOf(page, b0.at));
  await page.fill('.cad-dialog input[data-param=dx]', '40');
  await page.check('.cad-dialog input[data-param=copy]');
  await page.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.bodies.length === 2; }, null, { timeout: 30000 });
  await page.click('.cad-dialog [data-accept]');
  await settled(page, 4);
  await page.click('.v3-views [data-view=fit]');
  await page.waitForTimeout(400);
  check('Transform copies the body', (await S(page, () => window.JunctionPartStudio.getState().bodies.map((b) => b.name).join())) === 'Part 1,Part 1 copy');
  await shot(page, '12-revolve-chamfer-copy');

  check('no script errors', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  console.error('the run stopped:', e);
  fail++;
} finally {
  await browser.close();
  try { sql('DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id = 990201)'); } catch { /* left for the next run */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
