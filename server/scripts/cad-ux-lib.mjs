// What the cad-ux-ui.mjs script (and anything else that drives a part studio as a person would) shares: signing
// in, a new project with a part studio, where a named face or edge is on screen, and waiting on the part
// studio's own state rather than on timers.
//
// Needs what the other cad-*-ui.mjs scripts need: a server with KC_DEV_LOGIN=1, Playwright, psql.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');

export const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
export const sql = (text) => execFileSync('psql', [PG_URL, '-Atc', text], { encoding: 'utf8' }).trim();
export function user(login, githubId) {
  sql(`INSERT INTO users (github_id, login, name) VALUES (${githubId}, '${login}', '${login}') ON CONFLICT (github_id) DO NOTHING`);
  return Number(sql(`SELECT id FROM users WHERE github_id = ${githubId}`));
}

export const launch = () => chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

/** A signed-in page of the given size and theme. */
export async function signedIn(browser, uid, login, o = {}) {
  const ctx = await browser.newContext({ viewport: { width: o.width || 1500, height: o.height || 900 }, colorScheme: o.dark ? 'dark' : 'light' });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`${login}: ${e.message}`));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  if (o.dark) await page.evaluate(() => { try { localStorage.setItem('kui.theme', 'dark'); } catch (e) { /* no storage */ } });
  return page;
}

/** A blank project with a new part studio open in it.  Returns the project id. */
export async function newPartStudio(page, name) {
  const project = await page.evaluate(async (name) => {
    const r = await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    return r.json();
  }, name);
  await page.goto(`${BASE}/p/${project.projectId}/edit`);
  await page.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await page.click('[data-doc-add]');
  await page.click('text=New part studio');
  await page.waitForSelector('.cad-root[data-doc-kind=part-studio]', { timeout: 30000 });
  await page.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  return project.projectId;
}

/** Run a function in the page with the open part studio. */
export const S = (page, fn, arg) => page.evaluate(fn, arg);
export const state = (page) => S(page, () => { const s = window.JunctionPartStudio.getState(); return { features: s.features.map((f) => ({ id: f.id, type: f.featureType, name: f.name, params: f.params })), rollback: s.rollback, bodies: s.bodies.length, editing: s.editing ? { type: s.editing.draft.featureType, field: s.editing.field, params: s.editing.draft.params } : null, sketch: s.sketch ? s.sketch.featureId : null, selection: s.selection.length, units: s.units, visibility: s.visibility }; });

/** The part studio has `n` features, no dialog is open, the kernel is idle and every built feature has reported. */
export const settled = (page, n) => page.waitForFunction((n) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, n, { timeout: 90000 });
/** The preview of the open dialog has been built. */
export const previewed = (page) => page.waitForFunction(() => {
  const s = window.JunctionPartStudio.getState();
  return s.editing && s.kernel.state === 'ready' && !!s.reports[s.editing.draft.id];
}, null, { timeout: 90000 });

/** A model point on screen. */
export const screenOf = (page, p) => S(page, (p) => {
  const st = window.JunctionPartStudio, c = st.viewport.canvas.getBoundingClientRect();
  const q = st.viewport.project(st.viewport.target.clone().set(p[0], p[1], p[2]));
  return { x: c.left + q.x, y: c.top + q.y };
}, p);
/** A point of the open sketch's plane on screen. */
export const sketchPoint = (page, x, y) => S(page, ([x, y]) => {
  const st = window.JunctionPartStudio, f = window.JunctionSketch.frame, c = st.viewport.canvas.getBoundingClientRect();
  const q = st.viewport.project(st.viewport.target.clone().set(f.origin[0] + x * f.x[0] + y * f.y[0], f.origin[1] + x * f.x[1] + y * f.y[1], f.origin[2] + x * f.x[2] + y * f.y[2]));
  return { x: c.left + q.x, y: c.top + q.y };
}, [x, y]);
/** The middle of an edge of the model whose name holds every string of `match`, on screen; `nth` among those. */
export const edgeOnScreen = (page, match = [], nth = 0) => S(page, ([match, nth]) => {
  const st = window.JunctionPartStudio, s = st.getState(), c = st.viewport.canvas.getBoundingClientRect();
  let k = 0;
  for (const b of s.bodies) {
    const m = b.mesh; if (!m) continue;
    for (let i = 0; i < m.edges.names.length; i++) {
      if (!match.every((x) => m.edges.names[i].includes(x)) || k++ !== nth) continue;
      const a = m.edges.start[i], n = m.edges.count[i], seg = Math.floor(n / 2) & ~1;
      const p = (j) => [m.edges.positions[(a + j) * 3], m.edges.positions[(a + j) * 3 + 1], m.edges.positions[(a + j) * 3 + 2]];
      const q0 = p(seg), q1 = p(seg + 1);
      const q = st.viewport.project(st.viewport.target.clone().set((q0[0] + q1[0]) / 2, (q0[1] + q1[1]) / 2, (q0[2] + q1[2]) / 2));
      return { name: m.edges.names[i], body: b.id, x: c.left + q.x, y: c.top + q.y };
    }
  }
  return null;
}, [match, nth]);
/**
 * A point inside a face of the model whose name holds every string of `match`, on screen.  A string that begins
 * with ^ must be where the name starts (a face a feature made, not one made from it later).
 */
export const faceOnScreen = (page, match = []) => S(page, (match) => {
  const st = window.JunctionPartStudio, s = st.getState(), c = st.viewport.canvas.getBoundingClientRect();
  for (const b of s.bodies) {
    const m = b.mesh; if (!m) continue;
    const i = m.faces.names.findIndex((n) => match.every((x) => (x[0] === '^' ? n.startsWith(x.slice(1)) : n.includes(x))));
    if (i < 0) continue;
    let best = null, area = -1;
    for (let t = m.faces.start[i]; t < m.faces.start[i] + m.faces.count[i]; t += 3) {
      const v = [0, 1, 2].map((k) => { const j = m.indices[t + k] * 3; return [m.positions[j], m.positions[j + 1], m.positions[j + 2]]; });
      const u = v[1].map((x, k) => x - v[0][k]), w = v[2].map((x, k) => x - v[0][k]);
      const a = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]);
      if (a > area) { area = a; best = [0, 1, 2].map((k) => (v[0][k] + v[1][k] + v[2][k]) / 3); }
    }
    const q = st.viewport.project(st.viewport.target.clone().set(best[0], best[1], best[2]));
    return { name: m.faces.names[i], body: b.id, x: c.left + q.x, y: c.top + q.y };
  }
  return null;
}, match);

export const click = async (page, p, o = {}) => { await page.mouse.move(p.x, p.y, { steps: 2 }); if (o.shift) await page.keyboard.down('Shift'); await page.mouse.down(); await page.mouse.up(); if (o.shift) await page.keyboard.up('Shift'); await page.waitForTimeout(60); };
/** Give the viewport the keyboard without clicking anything in it. */
export const focusViewport = (page) => S(page, () => window.JunctionPartStudio.viewport.canvas.focus());
/** Which way the camera looks, rounded: [0, 0, -1] is from above. */
export const viewDir = (page) => S(page, () => { const st = window.JunctionPartStudio, v = st.viewport.target.clone().set(0, 0, -1).applyQuaternion(st.viewport.camera.quaternion); return [v.x, v.y, v.z].map((n) => Math.round(n * 1000) / 1000); });
/** Wait until the view has stopped turning (the viewport eases from one view to the next). */
export const viewStill = async (page) => {
  await page.waitForTimeout(60);
  await page.waitForFunction(() => !window.JunctionPartStudio.viewport.anim, null, { timeout: 10000 });
  await page.waitForTimeout(60);
};
