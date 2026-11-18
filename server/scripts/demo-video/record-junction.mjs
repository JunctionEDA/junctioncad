// Records the footage of the README video (render.mjs) from the real application, after build-pico.mjs and
// prepare.mjs.  One window is filmed, Ada's; everyone else works in their own browser and shows in hers as a
// cursor with a name tag, the way a collaborator does.
//
//   schematic  Ada starts the Pico schematic alone; Ben joins, then Maya, then Dev, each taking a part of it.
//              Every item goes in through that person's own editor, with their mouse on it.
//   ai         Ada asks her AI app for the crystal circuit: it points at the gap (highlight) and proposes the
//              circuit (apply_changes with propose), which Ada accepts.
//   build      Ada draws the outline and runs Update PCB; everyone builds their blocks as clusters beside the
//              board, routes inside each cluster, moves the clusters on, and all four route between them.
//   parts      a part found at LCSC and placed in the schematic.
//   history, plugins, fab, viewer3d   short looks at the rest of the product.
//   simulate   the AI's simulate tool on the reset circuit (the plot it returns).
//
//   node record-junction.mjs [scene ...]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { BASE, PG_URL, mintJwt, mcp, share, record, sleep, POINTER } from './lib.mjs';
import { splitTracks, padsOf } from './clusters.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || path.join(here, 'out');
const STATE = path.join(OUT, 'state.json');
const all = ['schematic', 'ai', 'build', 'history', 'parts', 'plugins', 'websim', 'drc', 'fab', 'viewer3d'];
const want = process.argv.slice(2).length ? process.argv.slice(2) : all;
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
const I = JSON.parse(fs.readFileSync(path.join(OUT, 'pico-items.json'), 'utf8'));
const project = I.project;

pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const mkUser = async (ghId, login, name) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name RETURNING id`, [ghId, login, name])).rows[0].id;
const people = {};
for (const [g, login, name] of [[-7701, 'ada', 'Ada'], [-7702, 'ben', 'Ben'], [-7703, 'maya', 'Maya'], [-7704, 'dev', 'Dev']]) {
  const id = await mkUser(g, login, name); people[login] = { id, name, jwt: mintJwt(id, login) };
}
const ada = people.ada.jwt;
const docs = (await (await fetch(`${BASE}/api/projects/${project}`, { headers: { Authorization: `Bearer ${ada}` } })).json()).docs;
const docOf = (type) => docs.find((d) => d.docType === type).docId;
for (const p of ['ben', 'maya', 'dev']) await share(ada, project, people[p].jwt);

// One browser for each person, as on separate computers.  WebGL by software (for the 3D viewer), but not
// --ignore-gpu-blocklist: with it the 2D canvases are composited through the software GPU too, and a page
// taking a stream of remote edits then stops painting for many seconds.
const launch = () => chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const browsers = {};
const MAIN = { width: 1600, height: 900 }, SIDE = { width: 1200, height: 800 };
async function open(login, docId, viewport = SIDE, proj = project) {
  browsers[login] = browsers[login] || await launch();
  // the filmed window (Ada's) is photographed at twice its pixels (DSF=1 for a quick draft); the others are never filmed
  const ctx = await browsers[login].newContext({ viewport, deviceScaleFactor: login === 'ada' ? Number(process.env.DSF || 2) : 1, colorScheme: 'dark' });
  await ctx.addInitScript(POINTER);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  page error:', String(e).slice(0, 200)));
  await page.goto(`${BASE}/auth/dev?jwt=${people[login].jwt}&next=${encodeURIComponent(`/p/${proj}/edit?doc=${docId}`)}`);
  await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.ws && window.CollabEditor.ws.readyState === 1, null, { timeout: 90000 });
  // No project-card thumbnails from these windows: encoding one takes a software-rendered headless page many
  // seconds, during which it paints nothing (a normal browser does it in a moment).
  await page.evaluate(() => { window.KiCadCanvas.renderPng = () => new Promise(() => {}); });
  await sleep(1000);
  return page;
}
async function clearPanels(page) { for (let i = 0; i < 8; i++) { const x = page.locator('button.kx:visible').first(); if (!(await x.count())) break; await x.click(); await sleep(150); } }
async function home(page) { await page.mouse.move(page.viewportSize().width / 2, page.viewportSize().height / 2); await page.keyboard.press('Home'); await sleep(700); }
async function mapOf(page) {
  const [m0, m1] = await page.evaluate(() => { const E = window.CollabEditor; return [E.api.worldMm({ clientX: 0, clientY: 0 }), E.api.worldMm({ clientX: 1000, clientY: 1000 })]; });
  const sx = 1000 / (m1[0] - m0[0]), sy = 1000 / (m1[1] - m0[1]);
  return { to: (p) => [(p[0] - m0[0]) * sx, (p[1] - m0[1]) * sy], from: (q) => [m0[0] + q[0] / sx, m0[1] + q[1] / sy] };
}
// zoom so that the world box [x0, y0, x1, y1] fills the view: Home, then wheel notches at its centre while it fits
async function frame(page, box) {
  await home(page);
  const vp = page.viewportSize();
  for (let i = 0; i < 10; i++) {
    const m = await mapOf(page); const a = m.to([box[0], box[1]]), b = m.to([box[2], box[3]]);
    if ((b[0] - a[0]) * 1.3 > vp.width || (b[1] - a[1]) * 1.3 > vp.height - 120) break;
    await page.mouse.move((a[0] + b[0]) / 2, (a[1] + b[1]) / 2); await page.mouse.wheel(0, -120); await sleep(300);
  }
  await sleep(400);
}
// show exactly the world box [x0, y0, x1, y1]: zoom out until it fits, in while it still fits, then drag the view (middle button) to centre it
async function fitTo(page, box, rec) {
  // with rec, every notch and stroke is photographed: a person zooming out, not a cut
  const pause = async (ms) => { if (rec) { await sleep(ms / 2); await rec.tick(); await rec.tick(); } else await sleep(ms); };
  const vp = page.viewportSize(), H = vp.height - 140;
  const span = async () => { const m = await mapOf(page); const a = m.to([box[0], box[1]]), b = m.to([box[2], box[3]]); return { a, b, w: b[0] - a[0], h: b[1] - a[1] }; };
  for (let i = 0; i < 60; i++) { const s = await span(); if (s.w <= vp.width * 0.98 && s.h <= H) break; await page.mouse.move(vp.width / 2, vp.height / 2); await page.mouse.wheel(0, 120); await pause(250); }
  for (let i = 0; i < 30; i++) { const s = await span(); if (s.w * 1.25 > vp.width * 0.98 || s.h * 1.25 > H) break; await page.mouse.move(vp.width / 2, vp.height / 2); await page.mouse.wheel(0, -120); await pause(250); }
  for (let i = 0; i < 8; i++) {
    const s = await span(); const cx = (s.a[0] + s.b[0]) / 2, cy = (s.a[1] + s.b[1]) / 2, tx = vp.width / 2, ty = 70 + H / 2;
    if (process.env.FIT_LOG) console.log('  fit', i, Math.round(cx), Math.round(cy), '->', tx, ty, Math.round(s.w), Math.round(s.h));
    if (Math.abs(cx - tx) < 4 && Math.abs(cy - ty) < 4) break;
    // drag from the middle of the canvas (never from a toolbar), at most 350 px a stroke
    const dx = Math.max(-350, Math.min(350, tx - cx)), dy = Math.max(-300, Math.min(300, ty - cy)), sx0 = vp.width / 2, sy0 = 70 + H / 2;
    await page.mouse.move(sx0, sy0); await page.mouse.down({ button: 'middle' }); await page.mouse.move(sx0 + dx / 2, sy0 + dy / 2, { steps: 4 }); await page.mouse.move(sx0 + dx, sy0 + dy, { steps: 4 }); await page.mouse.up({ button: 'middle' }); await pause(300);
  }
  await sleep(300);
}
// The camera: the editor's own view (zoom and pan, as View > Zoom to Fit sets them) moved to show exactly the world
// box [x0, y0, x1, y1], in one step, or with rec over `frames` photographs: a slow, even glide (zoom by ratio, centre
// in a straight line), never a jump.
async function camTo(page, box, rec, frames = 40, margin = 0.94) {
  const v = await page.evaluate(() => {
    const E = window.CollabEditor, st = document.getElementById('stage').getBoundingClientRect();
    const a = E.api.worldMm({ clientX: st.left, clientY: st.top }), b = E.api.worldMm({ clientX: st.left + 1000, clientY: st.top + 1000 });
    return { zoom: E.zoom, panX: E.panX, panY: E.panY, a, s: 1000 / (b[0] - a[0]), w: st.width, h: st.height };
  });
  // world at the stage's top-left is a + (-pan)/s for the current zoom: mmX0 = a0 + panX / s
  const mm0 = [v.a[0] + v.panX / v.s, v.a[1] + v.panY / v.s];
  const c0 = [v.a[0] + v.w / 2 / v.s, v.a[1] + v.h / 2 / v.s], c1 = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  const s1 = Math.min(v.w / (box[2] - box[0]), v.h / (box[3] - box[1])) * margin;
  const at = (k) => { const s = v.s * Math.pow(s1 / v.s, k), c = [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k];
    return { zoom: v.zoom * (s / v.s), panX: v.w / 2 - (c[0] - mm0[0]) * s, panY: v.h / 2 - (c[1] - mm0[1]) * s }; };
  const set = (q) => page.evaluate((q2) => { const E = window.CollabEditor; E.zoom = q2.zoom; E.panX = q2.panX; E.panY = q2.panY; E.api.applyView(); E.api.requestRender && E.api.requestRender(); }, q);
  if (!rec) { await set(at(1)); await sleep(400); return; }
  for (let i = 1; i <= frames; i++) { const k = i / frames, e = k * k * (3 - 2 * k); await set(at(e)); await rec.tick(); }
}
const commit = (page, changes, label) => page.evaluate(([c, l]) => window.CollabEditor.api.commitChanges(c, l), [changes, label]);
const settled = (page) => page.waitForFunction(() => window.CollabEditor.pendingOps.size === 0, null, { timeout: 60000 });
async function reset(page, kind, filter = () => true) {
  const ids = (kind === 'sch' ? I.schematic : I.board).filter(filter).map((i) => i.id);
  const n = await page.evaluate(([ids, kind]) => {
    const E = window.CollabEditor, d = E.kdoc, out = [], set = new Set(ids);
    for (const it of d.items.values()) if (set.has(it.id)) out.push(kind === 'sch' ? { id: it.id, kind: 'REMOVED', typeName: window.CollabTools.sch._.typeNameFor(it), properties: [] } : window.PcbTools.removedChange(it));
    if (out.length) E.api.commitChanges(out, 'reset');
    return out.length;
  }, [ids, kind]);
  await settled(page); if (n) console.log('  reset: took out', n);
}
async function menu(rec, page, from, name, entry, sub) {
  const btn = page.locator(`#kmenus [data-menu="${name}"] > button`); const bb = await btn.boundingBox(); let at = [bb.x + bb.width / 2, bb.y + bb.height / 2];
  await rec.glide(page, from, at, 450); await btn.click(); await rec.hold(350);
  for (const [text, last] of [[sub, false], [entry, true]]) {
    if (!text) continue;
    const it = page.locator(`#kmenus [data-menu="${name}"] .dd`).locator(`text=${text}`).first(); await it.waitFor({ timeout: 10000 }); const ib = await it.boundingBox(); const to = [ib.x + 40, ib.y + ib.height / 2];
    // into a submenu sideways first, then down: a diagonal crosses the other entries and the submenu closes
    if (last && sub) { const side = [to[0], at[1]]; await rec.glide(page, at, side, 200); at = side; }
    await rec.glide(page, at, to, 350); at = to; await rec.hold(200);
    if (last) await it.click(); else await it.hover();
  }
  return at;
}
async function clickOn(rec, page, from, locator, ms = 450) { const bb = await locator.boundingBox(); const to = [bb.x + bb.width / 2, bb.y + bb.height / 2]; await rec.glide(page, from, to, ms); await locator.click(); return to; }

function actor(page, steps, start) {
  return { page, steps: steps.slice(), cur: null, pos: start, done: 0 };
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
async function advance(A) {
  if (!A.cur) {
    const s = A.steps.shift(); if (!s) return false;
    const pts = [A.pos, ...s.path]; const legs = []; let total = 0;
    for (let i = 1; i < pts.length; i++) { const l = dist(pts[i - 1], pts[i]); legs.push(l); total += l; }
    const approach = legs[0], along = total - approach;
    const frames = Math.max(3, Math.min(s.max || 14, Math.round(approach / (s.speed || 45)))) + (along > 1 ? Math.max(2, Math.min(s.alongMax || 12, Math.round(along / (s.alongPx || 30)))) : 0);
    A.cur = { s, pts, legs, total, frames, f: 0 };
  }
  const c = A.cur; c.f++;
  const k = c.f / c.frames, e = k * k * (3 - 2 * k); let d = e * c.total, i = 0;
  while (i < c.legs.length - 1 && d > c.legs[i]) { d -= c.legs[i]; i++; }
  const p0 = c.pts[i], p1 = c.pts[i + 1], t = c.legs[i] ? Math.min(1, d / c.legs[i]) : 1;
  const at = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
  await A.page.mouse.move(at[0], at[1]); A.pos = at;
  if (c.f >= c.frames) { if (c.s.commit) await commit(A.page, c.s.commit, c.s.label || 'add'); A.cur = null; A.done++; }
  return true;
}
// Everybody works until all are done; the recorder photographs every frame.
// Whoever runs out of work helps whoever has the most left: the second half of their remaining steps moves over,
// redrawn in the helper's own view (screen -> world -> screen).
function help(actors) {
  for (const X of actors) {
    if (X.cur || X.steps.length || !X.map) continue;
    const Y = actors.filter((q) => q !== X && q.map && q.steps.length > 8).sort((p, q) => q.steps.length - p.steps.length)[0];
    if (!Y) continue;
    const take = Y.steps.splice(Math.ceil(Y.steps.length / 2));
    X.steps.push(...take.map((st) => ({ ...st, path: st.path.map((pt) => X.map.to(Y.map.from(pt))) })));
    X.helped = (X.helped || 0) + take.length;
  }
}
async function together(rec, actors, onFrame) { for (;;) { help(actors); let any = false; for (const A of actors) if (await advance(A)) any = true; await rec.tick(); if (onFrame) await onFrame(); if (!any) break; } }

// ---- turning the exported items into a person's steps
const ORDER = { rectangle: 0, text: 1, symbol: 2, wire: 3, label: 4, global_label: 4, hierarchical_label: 4, junction: 5, no_connect: 6 };
function schSteps(map, blockNames) {
  const steps = [];
  for (const name of blockNames) {
    const its = I.schematic.filter((i) => i.blockName === name);
    const parts = its.filter((i) => i.kind === 'symbol' && !/^power:/.test(i.lib || '')).sort((a, b) => a.pts[0][0] - b.pts[0][0] || a.pts[0][1] - b.pts[0][1]);
    const box = its.filter((i) => i.kind === 'rectangle' || i.kind === 'text');
    let rest = its.filter((i) => !parts.includes(i) && !box.includes(i));
    const ordered = [...box.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]), ...parts];
    // the rest nearest-first from where the hand is, the way a person works round a part
    let at = parts.length ? parts[parts.length - 1].pts[0] : (box[0] ? box[0].pts[0] : [0, 0]);
    while (rest.length) {
      rest.sort((a, b) => dist(at, a.pts[0]) - dist(at, b.pts[0]));
      const n = rest.shift(); ordered.push(n); at = n.pts[n.pts.length - 1];
    }
    for (const i of ordered) steps.push({ path: i.pts.map(map.to), commit: [i.add], label: 'add', max: i.kind === 'symbol' ? 16 : 12 });
  }
  return steps;
}


const scene = async (name, fn) => { if (!want.includes(name)) return; console.log(`== ${name}`); const info = await fn(path.join(OUT, name)); state[name] = info; save(); console.log(JSON.stringify(info).slice(0, 900)); for (const b of Object.values(browsers)) await b.close(); for (const k of Object.keys(browsers)) delete browsers[k]; };
const AI_BLOCK = '12 MHz crystal';
const blockNamed = (re) => Object.values(I.blocks).find((b) => re.test(b.name)).name;
const content = (() => { const b = Object.values(I.blocks).map((x) => x.box); return [Math.min(...b.map((x) => x[0])) - 4, Math.min(...b.map((x) => x[1])) - 8, Math.max(...b.map((x) => x[2])) + 4, Math.max(...b.map((x) => x[3])) + 4]; })();

// ---------------------------------------------------------------- the schematic, one person and then four
await scene('schematic', async (dir) => {
  const a = await open('ada', docOf('kicad_sch'), MAIN);
  await reset(a, 'sch'); await clearPanels(a); await home(a);
  const ma = await mapOf(a);
  const RP = blockNamed(/RP2040/), rpSteps = (map) => schSteps(map, [RP]);
  const third = (steps, k) => { const n = Math.ceil(steps.length / 3); return steps.slice(k * n, (k + 1) * n); };
  // who does what, and when they come in (after Ada has put in so many items)
  const plan = [
    { who: 'ada', at: 0, steps: (m) => [...schSteps(m, [blockNamed(/USB/), blockNamed(/buck/)]), ...third(rpSteps(m), 1)] },
    { who: 'ben', at: 22, steps: (m) => [...schSteps(m, [blockNamed(/QSPI/), blockNamed(/Reset/)]), ...third(rpSteps(m), 2)] },
    { who: 'maya', at: 62, steps: (m) => third(rpSteps(m), 0) },
    { who: 'dev', at: 100, steps: (m) => schSteps(m, [blockNamed(/GPIO/)]) },
  ];
  const A = actor(a, plan[0].steps(ma), [800, 450]); A.map = ma;
  const actors = [A]; const pending = []; const joins = {}, follow = {};
  const rec = await record(a, dir);
  await a.mouse.move(800, 450); await rec.hold(300);
  for (;;) {
    for (const p of plan.slice(1)) if (!p.started && A.done >= p.at) {
      p.started = true;
      pending.push((async () => { const pg = await open(p.who, docOf('kicad_sch'), SIDE); await clearPanels(pg); await home(pg); const m = await mapOf(pg); return { p, pg, m }; })());
    }
    // a person who has finished opening joins: their window is ready, their cursor comes in from the side
    for (let i = pending.length - 1; i >= 0; i--) {
      const r = await Promise.race([pending[i], sleep(0).then(() => null)]);
      if (r) { pending.splice(i, 1); rec.mark(`join-${r.p.who}`); joins[r.p.who] = A.done; const Z = actor(r.pg, r.p.steps(r.m), [1150, 100]); Z.who = r.p.who; Z.map = r.m; Z.joined = rec.now(); follow[r.p.who] = []; actors.push(Z); }
    }
    if (!pending.length && plan.every((p) => p.started || p.at === 0)) help(actors);
    let any = false; for (const X of actors) if (await advance(X)) any = true;
    // a person who is done takes their hand off the drawing (Ada's pointer leaves the sheet: no cursor sitting idle)
    if (!A.cur && !A.steps.length && !A.away) { A.away = true; await a.evaluate(() => { const p = document.getElementById('__demo_ptr'); if (p) p.style.display = 'none'; }); await a.mouse.move(2, 885); }
    // where a newcomer's cursor is on Ada's screen for their first seconds: the video zooms in and follows it
    for (const X of actors) if (X.who && rec.now() - X.joined < 5) { const q = ma.to(X.map.from(X.pos)); follow[X.who].push([rec.now(), Math.round(q[0]), Math.round(q[1])]); }
    await rec.tick();
    if (!any && !pending.length && plan.every((p) => p.started || p.at === 0)) break;
  }
  for (const X of actors) await settled(X.page);
  await rec.hold(900);
  const r = await rec.stop();
  return { ...r, items: Object.fromEntries(actors.map((X) => [X.who || 'ada', X.done])), helped: Object.fromEntries(actors.map((X) => [X.who || 'ada', X.helped || 0])), joins, follow };
});

// ---------------------------------------------------------------- Ada's AI: points at the gap, proposes the crystal, she accepts
await scene('ai', async (dir) => {
  const a = await open('ada', docOf('kicad_sch'), MAIN);
  await reset(a, 'sch', (i) => i.blockName === AI_BLOCK);
  await clearPanels(a); await home(a);
  // the AI app's access key (Connect an AI assistant), warmed up in a scratch project so that it is not in this
  // document before Ada asks (the server starts its worker on the first call)
  await db.query(`UPDATE mcp_tokens SET expires_at = now() WHERE grant_id IN (SELECT id FROM mcp_grants WHERE user_id = $1 AND client_id LIKE 'kcm\\_key\\_%')`, [people.ada.id]);
  const k = await (await fetch(`${BASE}/api/mcp/keys`, { method: 'POST', headers: { Authorization: `Bearer ${ada}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Claude', write: true }) })).json();
  let scratch = (await db.query(`SELECT id FROM projects WHERE owner_id = $1 AND name = 'scratch' AND deleted_at IS NULL`, [people.ada.id])).rows[0];
  scratch = scratch ? scratch.id : (await mcp(k.key, 'create_project', { name: 'scratch' })).data.project_id;
  console.log('  warm-up:', (await mcp(k.key, 'run_python', { project: scratch, code: 'print(1)', timeout_s: 120 })).text.slice(0, 80));
  const box = I.blocks[Object.keys(I.blocks).find((kk) => I.blocks[kk].name === AI_BLOCK)].box;
  const ma = await mapOf(a); const gap = ma.to([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]);
  const rec = await record(a, dir);
  await rec.glide(a, [800, 450], gap, 700); await rec.hold(400);
  await rec.glide(a, gap, [gap[0] + 40, gap[1] - 25], 400); await rec.hold(300);
  rec.mark('ask'); await rec.glide(a, [gap[0] + 40, gap[1] - 25], [1560, 860], 600);
  await rec.hold(2200);
  const sch = docs.find((d) => d.docType === 'kicad_sch').path || 'rp2040-pico.kicad_sch';
  rec.mark('highlight');
  const h = await rec.until(mcp(k.key, 'highlight', { project, document: sch, area: box, note: 'XIN and XOUT need the 12 MHz crystal: 1 kΩ drive resistor, two 15 pF loads', seconds: 60 }));
  await rec.wait(2600);
  const items = I.schematic.filter((i) => i.blockName === AI_BLOCK);
  rec.mark('propose');
  const p = await rec.until(mcp(k.key, 'apply_changes', { project, document: sch, title: 'Add the 12 MHz crystal circuit', rationale: 'The RP2040 hardware design guide\'s crystal: ABM8-272-T3 at 12 MHz, a 1 kΩ series resistor on XOUT and 15 pF to ground on each side.', edits: items.map((i) => ({ op: 'add_item', sexpr: i.plain })), propose: true }));
  await rec.wait(2500);
  // Ada looks at it and accepts
  const accept = a.locator('button[data-act="accept"]').first();
  await accept.waitFor({ timeout: 20000 });
  rec.mark('card');
  await rec.hold(900);
  const at = await clickOn(rec, a, [1560, 860], accept, 700); rec.mark('accept');
  await rec.wait(2500); await settled(a);
  await rec.glide(a, at, [gap[0] + 80, gap[1] + 60], 600); await rec.hold(1200);
  const r = await rec.stop();
  return { ...r, highlight: h.text.slice(0, 200), proposal: p.text.slice(0, 300), items: items.length };
});

// the board scene's helpers, in each person's page
const DEMO = () => {
  const E = window.CollabEditor, P = window.PcbTools, K = window.KiCadCanvas;
  const fp = (ref) => { for (const it of E.kdoc.items.values()) if (it.kind === 'footprint' && it.ref === ref) return it; return null; };
  window.__demo = {
    at: (refs) => { const p = refs.map(fp).filter(Boolean).map((it) => K.atOf(it.node)); return p.length ? [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length] : null; },
    move: (refs, dx, dy) => { const ids = refs.map(fp).filter(Boolean).map((it) => it.id); const c = P.moveChanges(E.kdoc, ids, dx, dy); if (c.length) E.api.commitChanges(c, 'move'); },
    moveGroup: (refs, more, dx, dy) => { const ids = refs.map(fp).filter(Boolean).map((it) => it.id).concat(more.filter((id) => E.kdoc.items.has(id))); const c = P.moveChanges(E.kdoc, ids, dx, dy); if (c.length) E.api.commitChanges(c, 'move'); },
    snap: (ref, node, dx, dy) => {
      const it = fp(ref); if (!it) return false;
      const n = JSON.parse(JSON.stringify(node)); const u = n.find((c) => Array.isArray(c) && c[0] === 'uuid'); if (u) u[1] = it.id;
      P.translateNode(n, dx, dy); E.api.commitChanges([P.replacedChange(it, n)], 'place'); return true;
    },
    count: () => { let n = 0; for (const it of E.kdoc.items.values()) if (it.kind === 'footprint') n++; return n; },
  };
};
// ---- a person's routing steps for a set of tracks: net by net, each run of joined segments drawn in one stroke
function trackSteps(map, tracks) {
  const steps = [];
  for (const n of [...new Set(tracks.map((t) => t.net))]) {
    let rest = tracks.filter((t) => t.net === n); let at = rest.reduce((m, t) => (t.pts[0][1] < m[1] ? t.pts[0] : m), rest[0].pts[0]);
    let chain = []; let chainEnd = null;
    const flush = () => { if (chain.length) { const pts = [chain[0].pts[0], ...chain.flatMap((c) => c.pts.slice(1))]; steps.push({ path: pts.map(map.to), commit: chain.map((c) => c.add), label: 'route', max: 6, speed: 80, alongMax: 8, alongPx: 40 }); chain = []; } };
    while (rest.length) {
      rest.sort((p, q) => Math.min(...p.pts.map((x) => dist(x, at))) - Math.min(...q.pts.map((x) => dist(x, at))));
      let t = rest.shift();
      if (t.kind !== 'via' && dist(t.pts[t.pts.length - 1], at) < dist(t.pts[0], at)) t = { ...t, pts: t.pts.slice().reverse() };
      const joins = chainEnd && dist(t.pts[0], chainEnd) < 0.01 && t.kind !== 'via' && chain.length < 12;
      if (!joins) flush();
      if (t.kind === 'via') { steps.push({ path: [map.to(t.pts[0])], commit: [t.add], label: 'via', max: 5, speed: 80 }); at = t.pts[0]; chainEnd = null; continue; }
      chain.push(t); chainEnd = t.pts[t.pts.length - 1]; at = chainEnd;
    }
    flush();
  }
  return steps;
}
// a track moved by (dx, dy): its points and the change that adds it there
const shiftNum = (v, d) => String(+(Number(v) + d).toFixed(6));
function shifted(t, dx, dy) {
  if (!dx && !dy) return t;
  const sexpr = t.add.sexpr.replace(/\((start|end|mid|at) (-?[\d.]+) (-?[\d.]+)/g, (_, k, x, y) => `(${k} ${shiftNum(x, dx)} ${shiftNum(y, dy)}`);
  return { ...t, pts: t.pts.map((p) => [p[0] + dx, p[1] + dy]), add: { ...t.add, sexpr } };
}

// ---------------------------------------------------------------- the board, block by block
// Ada draws the outline and brings the footprints in with Update PCB from Schematic.  Then everyone builds their
// blocks the way a layout person does: each block as a tight cluster beside the board, its parts round the chip's
// pins as the layout has them, routed inside the cluster first; then the finished cluster, tracks and all, goes
// onto the board.  Dev puts the edge headers on first, since everything else sits between them.  Last, all four
// route between the blocks, and the planes are filled.
await scene('build', async (dir) => {
  const FP = I.footprints, OUTL = { bbox: I.outline.reduce((b, o) => [Math.min(b[0], o.bbox[0]), Math.min(b[1], o.bbox[1]), Math.max(b[2], o.bbox[2]), Math.max(b[3], o.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]), adds: I.outline.map((o) => o.add) };
  const ob = OUTL.bbox;
  const { inside, between } = splitTracks(I);
  const trackById = new Map(I.board.map((t) => [t.id, t]));
  const blockNames = Object.values(I.blocks).map((b) => b.name);
  const named = (re) => blockNames.find((n) => re.test(n));
  // each block's copper extent (its pads), from which the cluster's spot beside the board is worked out
  const padBox = (name) => { const ps = FP.filter((f) => f.block === name).flatMap(padsOf); return [Math.min(...ps.map((p) => p.x - p.r)), Math.min(...ps.map((p) => p.y - p.r)), Math.max(...ps.map((p) => p.x + p.r)), Math.max(...ps.map((p) => p.y + p.r))]; };
  // who builds which block, and where its cluster is built (left or right of the board, stacked)
  const WORK = [
    { who: 'ada', side: -1, blocks: [named(/^USB/), named(/buck/)] },
    { who: 'ben', side: -1, blocks: [named(/QSPI/), named(/crystal/)] },
    { who: 'maya', side: 1, blocks: [named(/RP2040/)] },
    { who: 'dev', side: 1, blocks: [named(/Reset/)], edge: [named(/GPIO/)] },
  ];
  // the edge headers sit on the board from the start: their tracks wait for the routing, so nothing is on the board before it
  for (const W of WORK) for (const n of W.edge || []) { between.push(...(inside[n] || [])); delete inside[n]; }
  const GAP = 5, off = {};
  for (const side of [-1, 1]) {
    let y = ob[1];
    for (const w of WORK.filter((x) => x.side === side)) for (const n of w.blocks) {
      const b = padBox(n), W = b[2] - b[0], H = b[3] - b[1];
      const x0 = side < 0 ? ob[0] - GAP - W : ob[2] + GAP;
      off[n] = [+(x0 - b[0]).toFixed(3), +(y - b[1]).toFixed(3)]; y += H + 4;
    }
  }
  for (const w of WORK) for (const n of w.edge || []) off[n] = [0, 0];
  const allBoxes = Object.entries(off).map(([n, d]) => { const b = padBox(n); return [b[0] + d[0], b[1] + d[1], b[2] + d[0], b[3] + d[1]]; });
  const VIEW = [Math.min(ob[0], ...allBoxes.map((b) => b[0])) - 3, Math.min(ob[1], ...allBoxes.map((b) => b[1])) - 4, Math.max(ob[2], ...allBoxes.map((b) => b[2])) + 3, Math.max(ob[3], ...allBoxes.map((b) => b[3])) + 6];
  console.log('  clusters', JSON.stringify(off), 'view', VIEW.map((v) => v.toFixed(1)).join(','));

  const a = await open('ada', docOf('kicad_pcb'), MAIN);
  // start from an empty board: no footprints, no outline, no copper
  await a.evaluate(() => { const E = window.CollabEditor, P = window.PcbTools; const out = []; for (const it of E.kdoc.items.values()) if (['footprint', 'segment', 'arc', 'via', 'zone'].includes(it.kind) || (/^gr_(rect|line|arc)$/.test(it.kind) && JSON.stringify(it.node).includes('Edge.Cuts'))) out.push(P.removedChange(it)); if (out.length) E.api.commitChanges(out, 'reset'); });
  await settled(a); await clearPanels(a);
  // an empty board's Home zooms onto its one text: zoom out by the wheel twice over before framing
  await camTo(a, VIEW); await a.evaluate(DEMO);
  const others = {};
  for (const w of ['ben', 'maya', 'dev']) { others[w] = await open(w, docOf('kicad_pcb')); await clearPanels(others[w]); await others[w].mouse.move(2, 885); await camTo(others[w], VIEW); await others[w].evaluate(DEMO); }
  const pages = { ada: a, ...others };
  // the editor may still fit its view to the (nearly empty) board after loading: frame the work area again, last thing
  await a.bringToFront(); await sleep(1500); await camTo(a, VIEW);
  const rec = await record(a, dir);
  const m = await mapOf(a);
  await rec.hold(500);
  // 1. the outline: Edge.Cuts, corner to corner
  let at = [800, 450];
  const c0 = m.to([ob[0], ob[1]]), c1 = m.to([ob[2], ob[3]]);
  await rec.glide(a, at, c0, 500); await rec.hold(250); await rec.glide(a, c0, c1, 900); at = c1;
  await commit(a, OUTL.adds, 'outline'); await rec.hold(500); rec.mark('outline');
  // 2. Update PCB from Schematic
  at = await menu(rec, a, at, 'tools', '/Update PCB from Schematic/');
  const upd = a.locator('button', { hasText: /^Update PCB$/ }).first();
  await rec.until(upd.waitFor({ timeout: 60000 })); await rec.hold(900); rec.mark('dialog');
  at = await clickOn(rec, a, at, upd, 450);
  await rec.until(a.waitForFunction((n) => window.__demo.count() >= n, FP.length, { timeout: 60000 }));
  await rec.hold(700);
  const close = a.locator('button', { hasText: /^Close$/ }).first(); if (await close.count()) { at = await clickOn(rec, a, at, close, 350); }
  await a.keyboard.press('Escape'); await rec.hold(300); await a.keyboard.press('Escape');
  await settled(a); await rec.glide(a, at, [800, 470], 500); at = [800, 470]; await rec.hold(300); rec.mark('updated');
  // the footprints landed in rows under the board: the view takes them in while the parts are taken to their blocks
  const row = await a.evaluate(() => { let b = null; for (const it of window.CollabEditor.kdoc.items.values()) if (it.kind === 'footprint') b = b ? [Math.min(b[0], it.bbox[0]), Math.min(b[1], it.bbox[1]), Math.max(b[2], it.bbox[2]), Math.max(b[3], it.bbox[3])] : it.bbox.slice(); return b; });
  const WIDE = row ? [Math.min(VIEW[0], row[0] - 2), Math.min(VIEW[1], row[1] - 2), Math.max(VIEW[2], row[2] + 2), Math.max(VIEW[3], row[3] + 2)] : VIEW.slice();
  console.log('  row', row && row.map((v) => v.toFixed(1)).join(','), 'wide', WIDE.map((v) => v.toFixed(1)).join(','));
  await camTo(a, WIDE, rec);
  for (const w of Object.keys(others)) await camTo(others[w], WIDE);


  const maps = {}; for (const w of Object.keys(pages)) maps[w] = await mapOf(pages[w]);
  const pos = { ada: at, ben: [1300, 200], maya: [300, 700], dev: [1300, 750] };
  const ease = (k) => k * k * (3 - 2 * k);
  async function* glideTo(w, to, frames) { const pg = pages[w], from = pos[w]; for (let f = 1; f <= frames; f++) { const k = ease(f / frames); const p = [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k]; await pg.mouse.move(p[0], p[1]); pos[w] = p; yield; } }
  const bigFirst = (refs) => refs.sort((p, q) => (q.node && /Connector|RP2040|QFN|SOT|SOIC|Crystal/.test(JSON.stringify(q.node[1])) ? 1 : 0) - (p.node && /Connector|RP2040|QFN|SOT|SOIC|Crystal/.test(JSON.stringify(p.node[1])) ? 1 : 0));
  // a part picked up from the row, carried and put down at its spot in the cluster (the layout's spot + the cluster's offset)
  async function* placePart(w, part, d) {
    const pg = pages[w], mp = maps[w];
    const from = await pg.evaluate((r) => window.__demo.at([r]), part.ref); if (!from) return;
    yield* glideTo(w, mp.to(from), 8);
    // picked up the way a person does: a click selects it (everyone sees it selected), then it is carried
    const p0 = mp.to(from); await pg.mouse.click(p0[0], p0[1]); yield; yield;
    const to = [part.at[0] + d[0], part.at[1] + d[1]], frames = 12; let last = from;
    for (let f = 1; f <= frames; f++) {
      const k = ease(f / frames); const now = [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
      const sc = mp.to(now); await pg.mouse.move(sc[0], sc[1]); pos[w] = sc;
      await pg.evaluate(([r, dx, dy]) => window.__demo.move([r], dx, dy), [part.ref, now[0] - last[0], now[1] - last[1]]); last = now; yield;
    }
    await pg.evaluate(([ref, node, dx, dy]) => window.__demo.snap(ref, node, dx, dy), [part.ref, part.node, d[0], d[1]]); yield;
    await pg.keyboard.press('Escape'); yield;
  }
  // routing: the person's cursor draws each run, and the run is committed as it ends
  async function* route(w, tracks) {
    if (!tracks.length) return;
    const A = actor(pages[w], trackSteps(maps[w], tracks), pos[w]);
    while (await advance(A)) yield;
    pos[w] = A.pos;
  }
  // a finished cluster, parts and tracks together, carried onto the board
  async function* moveOn(w, name) {
    const pg = pages[w], mp = maps[w], d = off[name]; if (!d[0] && !d[1]) return;
    const refs = FP.filter((f) => f.block === name).map((f) => f.ref), ids = inside[name] || [];
    const b = padBox(name), c = [(b[0] + b[2]) / 2 + d[0], (b[1] + b[3]) / 2 + d[1]];
    // a box round the cluster selects it, parts and tracks
    const k0 = mp.to([b[0] + d[0] - 1.5, b[1] + d[1] - 1.5]), k1 = mp.to([b[2] + d[0] + 1.5, b[3] + d[1] + 1.5]);
    yield* glideTo(w, k0, 10); await pg.mouse.down(); yield;
    yield* glideTo(w, k1, 14); await pg.mouse.up(); yield; yield; yield;
    yield* glideTo(w, mp.to(c), 8); yield; yield;
    const frames = 24; let last = [0, 0];
    for (let f = 1; f <= frames; f++) {
      const k = ease(f / frames), now = [-d[0] * k, -d[1] * k];
      const sc = mp.to([c[0] + now[0], c[1] + now[1]]); await pg.mouse.move(sc[0], sc[1]); pos[w] = sc;
      await pg.evaluate(([r, i, dx, dy]) => window.__demo.moveGroup(r, i, dx, dy), [refs, ids, now[0] - last[0], now[1] - last[1]]); last = now; yield;
    }
    // land exactly where the layout has them
    for (const f of FP.filter((x) => x.block === name)) await pg.evaluate(([ref, node]) => window.__demo.snap(ref, node, 0, 0), [f.ref, f.node]);
    yield; await pg.keyboard.press('Escape'); yield; yield;
  }
  // a. everyone takes their parts out of the rows and lays out their blocks beside the board (Dev: the edge headers
  //    straight onto the board)
  async function* placeAll(W, wait) {
    for (let i = 0; i < wait; i++) yield;
    for (const n of W.edge || []) for (const part of bigFirst(FP.filter((f) => f.block === n))) yield* placePart(W.who, part, [0, 0]);
    for (const n of W.blocks) for (const part of bigFirst(FP.filter((f) => f.block === n))) yield* placePart(W.who, part, off[n]);
  }
  // b. each routes inside their own blocks
  async function* routeInside(W, wait) {
    for (let i = 0; i < wait; i++) yield;
    for (const n of W.blocks) yield* route(W.who, (inside[n] || []).map((id) => shifted(trackById.get(id), off[n][0], off[n][1])));
  }
  // c. and carries the finished blocks onto the board
  async function* moveAll(W, wait) { for (let i = 0; i < wait; i++) yield; for (const n of W.blocks) yield* moveOn(W.who, n); }
  const runAll = async (list) => { const live = list.slice(); while (live.length) { for (let i = live.length - 1; i >= 0; i--) { const r = await live[i].next(); if (r.done) live.splice(i, 1); } await rec.tick(); } };
  const remap = async () => { for (const w of Object.keys(pages)) maps[w] = await mapOf(pages[w]); };
  rec.mark('build');
  await runAll(WORK.map((W, i) => placeAll(W, [0, 6, 3, 9][i])));
  for (const w of Object.keys(pages)) await settled(pages[w]);
  await rec.hold(500); rec.mark('clustered');
  // closer in for the routing: the board and the blocks round it
  await camTo(a, VIEW, rec); for (const w of Object.keys(others)) await camTo(others[w], VIEW); await remap();
  rec.mark('inner');
  await runAll(WORK.map((W, i) => routeInside(W, [0, 4, 2, 6][i])));
  for (const w of Object.keys(pages)) await settled(pages[w]);
  await rec.hold(600); await camTo(a, VIEW, rec); await remap(); rec.mark('onboard');
  await runAll(WORK.map((W, i) => moveAll(W, [0, 10, 5, 15][i])));
  for (const w of Object.keys(pages)) await settled(pages[w]);
  await rec.hold(700); rec.mark('blocks');
  // 3. all four route between the blocks, each taking the nets of one quarter of the board
  const tracks = between.map((id) => trackById.get(id));
  const nets = [...new Set(tracks.map((t) => t.net))];
  const cOf = (n) => { const t = tracks.filter((x) => x.net === n); return [t.reduce((s2, x) => s2 + x.pts[0][0], 0) / t.length, t.reduce((s2, x) => s2 + x.pts[0][1], 0) / t.length]; };
  const mx = (ob[0] + ob[2]) / 2, my = (ob[1] + ob[3]) / 2;
  const quad = { ada: [], ben: [], maya: [], dev: [] };
  for (const n of nets) { const c = cOf(n); quad[c[1] < my ? (c[0] < mx ? 'ada' : 'ben') : (c[0] < mx ? 'maya' : 'dev')].push(n); }
  // zoomed on the board for the routing, by the wheel (everyone)
  const BOARDV = [ob[0] - 2, ob[1] - 2, ob[2] + 2, ob[3] + 2];
  await camTo(a, BOARDV, rec); for (const w of Object.keys(others)) await camTo(others[w], BOARDV);
  for (const w of Object.keys(pages)) maps[w] = await mapOf(pages[w]);
  const actors = Object.keys(pages).map((w) => { const X = actor(pages[w], trackSteps(maps[w], tracks.filter((t) => quad[w].includes(t.net))), w === 'ada' ? [800, 450] : [600, 400]); X.map = maps[w]; return X; });
  rec.mark('route');
  await together(rec, actors);
  for (const X of actors) await settled(X.page);
  rec.mark('routed'); await rec.hold(500);
  // the planes go back in; the server's fill comes with them
  await commit(a, I.board.filter((i) => i.kind === 'zone').map((z) => z.add), 'zones');
  await a.mouse.move(800, 450); await a.keyboard.press('b');
  await rec.wait(3500); rec.mark('filled'); await rec.hold(800);
  const r = await rec.stop();
  const left = await a.evaluate(() => window.PcbTools.ratsnest(window.CollabEditor.kdoc).length);
  return { ...r, inside: Object.fromEntries(Object.entries(inside).map(([k, v]) => [k, v.length])), between: between.length, unrouted: left, byPerson: Object.fromEntries(Object.entries(quad).map(([k, v]) => [k, v.length])) };
});

// ---------------------------------------------------------------- History: everyone's edits, scrubbable
await scene('history', async (dir) => {
  const a = await open('ada', docOf('kicad_sch'), MAIN);
  await home(a);
  const rec = await record(a, dir);
  await rec.hold(300);
  const at = await menu(rec, a, [800, 450], 'file', '/^History/');
  await rec.hold(1200);
  const rows = a.locator('text=/edits? ·|edits -|edit -/');
  let p = at; const n = Math.min(4, await rows.count());
  for (let i = 0; i < n; i++) { const bb = await rows.nth(i).boundingBox(); if (!bb) continue; const to = [bb.x + 60, bb.y + bb.height / 2]; await rec.glide(a, p, to, 350); p = to; await rows.nth(i).click().catch(() => {}); await rec.hold(700); }
  await rec.hold(600);
  return await rec.stop();
});

// ---------------------------------------------------------------- Parts from vendors
await scene('parts', async (dir) => {
  const a = await open('ada', docOf('kicad_sch'), MAIN);
  await clearPanels(a); await home(a);
  const before = await a.evaluate(() => [...window.CollabEditor.kdoc.items.keys()]);
  // where the part goes: the empty paper between the flash and RP2040 blocks
  const ma = await mapOf(a); const spot = ma.to([157, 160]);
  const rec = await record(a, dir);
  await rec.hold(300);
  let at = await menu(rec, a, [800, 450], 'tools', '/Add Part from Vendor/');
  await rec.hold(600);
  for (const ch of 'TLV62569') { await a.keyboard.type(ch); await rec.hold(90); }
  await a.keyboard.press('Enter'); rec.mark('search');
  await rec.until(a.locator('text=/^TLV62569DBVR$/').first().waitFor({ timeout: 30000 })); await rec.hold(500);
  const row = a.locator('text=/^TLV62569DBVR$/').first();
  at = await clickOn(rec, a, at, row, 500); rec.mark('picked');
  await rec.wait(2500); await rec.hold(900);
  // Place Symbol: the part comes in on the cursor, a click puts it down
  const place = a.locator('button', { hasText: /^Place Symbol$/ }).first();
  at = await clickOn(rec, a, at, place, 600); rec.mark('place');
  await rec.wait(1500);
  await rec.glide(a, at, spot, 1100); await rec.hold(300);
  await a.mouse.click(spot[0], spot[1]); await rec.hold(300);
  const newCount = () => a.evaluate((b) => { const had = new Set(b); let n = 0; for (const id of window.CollabEditor.kdoc.items.keys()) if (!had.has(id)) n++; return n; }, before);
  if (!(await newCount())) { await a.mouse.move(spot[0] + 2, spot[1] + 2); await rec.hold(200); await a.mouse.down(); await a.mouse.up(); await rec.hold(300); }
  rec.mark('placed'); console.log('  placed items:', await newCount());
  await rec.hold(400); await a.keyboard.press('Escape'); await rec.hold(300);
  await settled(a);
  await rec.glide(a, spot, [spot[0] + 120, spot[1] + 90], 700); await rec.hold(1800);
  const r = await rec.stop();
  // take it out again: the Pico's schematic stays as it was
  const added = await a.evaluate((b) => { const E = window.CollabEditor, T = window.CollabTools.sch._, had = new Set(b), out = []; for (const it of E.kdoc.items.values()) if (!had.has(it.id)) out.push({ id: it.id, kind: 'REMOVED', typeName: T.typeNameFor(it), properties: [] }); if (out.length) E.api.commitChanges(out, 'reset'); return out.length; }, before);
  await settled(a);
  return { ...r, added };
});

// ---------------------------------------------------------------- Plugins: one catalog
await scene('plugins', async (dir) => {
  const a = await open('ada', docOf('kicad_pcb'), MAIN);
  await home(a);
  // the recording machine has no route to KiCad's plugin repository, so its "could not be read" note is the rig's, not the product's
  await a.addStyleTag({ content: '#pluginKicadErr { display: none !important; }' });
  const rec = await record(a, dir);
  await rec.hold(300);
  let at = await clickOn(rec, a, [800, 450], a.locator('button').filter({ hasText: /^Junction/ }).first(), 500);
  await rec.hold(400);
  at = await clickOn(rec, a, at, a.locator('text=Plugin and Content Manager').first(), 400);
  await rec.wait(1500);
  at = await clickOn(rec, a, at, a.locator('text=/^Catalog$/').first(), 450);
  await rec.wait(3500);
  // down the catalog, slowly, a notch at a time
  const over = [at[0] + 200, at[1] + 220]; await rec.glide(a, at, over, 700); rec.mark('scroll');
  for (let i = 0; i < 24; i++) { await a.mouse.wheel(0, 40); await rec.tick(); await rec.tick(); await rec.tick(); }
  await rec.hold(900);
  return await rec.stop();
});

// ---------------------------------------------------------------- the web simulator, on the RUN pin's power-on sheet (sim/build.mjs)
await scene('websim', async (dir) => {
  const simProject = JSON.parse(fs.readFileSync(path.join(OUT, 'sim.json'), 'utf8')).project;
  const simDocs = (await (await fetch(`${BASE}/api/projects/${simProject}`, { headers: { Authorization: `Bearer ${ada}` } })).json()).docs;
  const a = await open('ada', simDocs.find((d) => d.docType === 'kicad_sch').docId, MAIN, simProject);
  await home(a);
  const rec = await record(a, dir);
  await rec.hold(500);
  let at = await menu(rec, a, [800, 450], 'inspect', '/Simulator/');
  await rec.wait(2500);
  const run = a.locator('#simframe button[title^="Run Simulation"]').first();
  at = await clickOn(rec, a, at, (await run.count()) ? run : a.locator('#simframe button').nth(4), 500);
  await rec.until(a.waitForFunction(() => /Data Rows/.test(document.querySelector('#sim-console')?.value || ''), null, { timeout: 120000 }));
  await rec.hold(300); rec.mark('ran');
  for (const sig of ['V(3V3)', 'V(/RUN)']) {
    const box = a.locator('#simframe tr', { hasText: sig }).first().locator('input[type=checkbox]').first();
    at = await clickOn(rec, a, at, box, 450); await rec.wait(900);
  }
  rec.mark('plotted');
  await rec.glide(a, at, [700, 420], 900); await rec.hold(1500);
  return await rec.stop();
});

// ---------------------------------------------------------------- Design rules check on the finished board
await scene('drc', async (dir) => {
  const a = await open('ada', docOf('kicad_pcb'), MAIN);
  await clearPanels(a); await home(a);
  const rec = await record(a, dir);
  await rec.hold(300);
  let at = await menu(rec, a, [800, 450], 'inspect', '/Design Rules Checker/');
  await rec.wait(1200);
  const run = a.locator('button', { hasText: /^Run DRC$/ }).first();
  at = await clickOn(rec, a, at, run, 500); rec.mark('run');
  await rec.wait(6000); rec.mark('done');
  await rec.glide(a, at, [at[0] - 200, at[1] - 160], 800); await rec.hold(1500);
  return await rec.stop();
});

// ---------------------------------------------------------------- the AI simulates (the tool's own plot)
await scene('simulate', async (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const k = await (await fetch(`${BASE}/api/mcp/keys`, { method: 'POST', headers: { Authorization: `Bearer ${ada}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Claude', write: true }) })).json();
  // the RUN pin at power-up: 10 kΩ to 3V3, 100 nF to ground (the reset block), 3V3 rising in 1 ms
  const netlist = `* RUN pin power-on
V1 3V3 0 PWL(0 0 1m 3.3)
R10 3V3 RUN 10k
C20 RUN 0 100n
.end`;
  const r = await mcp(k.key, 'simulate', { project, netlist, command: '.tran 10u 6m', probes: ['V(3V3)', 'V(RUN)'], width_px: 1500 });
  // the plot comes back as an image part of the tool result
  const raw = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${k.key}`, 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'simulate', arguments: { project, netlist, command: '.tran 10u 6m', probes: ['V(3V3)', 'V(RUN)'], width_px: 1500 } } }) }).then((x) => x.text());
  const j = raw.trimStart().startsWith('{') ? JSON.parse(raw) : JSON.parse(raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).join(''));
  const img = (j.result.content || []).find((c) => c.type === 'image');
  if (img) fs.writeFileSync(path.join(dir, 'plot.png'), Buffer.from(img.data, 'base64'));
  return { text: r.text.slice(0, 600), plot: !!img, netlist };
});

// ---------------------------------------------------------------- Fabrication outputs
await scene('fab', async (dir) => {
  const a = await open('ada', docOf('kicad_pcb'), MAIN);
  await home(a);
  const rec = await record(a, dir);
  await rec.hold(300);
  await menu(rec, a, [800, 450], 'file', '/^Fabrication Package/', 'Fabrication Outputs');
  await rec.wait(3500); await rec.hold(600);
  return await rec.stop();
});

// ---------------------------------------------------------------- 3D
await scene('viewer3d', async (dir) => {
  const a = await open('ada', docOf('kicad_pcb'), MAIN);
  await home(a);
  const rec = await record(a, dir);
  await rec.hold(300);
  const ib = await menu(rec, a, [800, 450], 'view', '3D Viewer'); rec.mark('open3d');
  await rec.wait(14000); rec.mark('loaded');
  const box = await a.evaluate(() => { const cs = [...document.querySelectorAll('canvas')].filter((c) => c.getBoundingClientRect().width > 200); const c = cs[cs.length - 1].getBoundingClientRect(); return [c.left, c.top, c.width, c.height]; });
  const cx = box[0] + box[2] / 2, cy = box[1] + box[3] / 2;
  await rec.glide(a, ib, [cx - 160, cy], 400); await a.mouse.down();
  await rec.glide(a, [cx - 160, cy], [cx + 170, cy + 70], 2400); await a.mouse.up(); await rec.hold(300);
  await a.mouse.down(); await rec.glide(a, [cx + 170, cy + 70], [cx - 50, cy - 80], 2400); await a.mouse.up(); await rec.hold(900);
  return await rec.stop();
});

await db.end();
