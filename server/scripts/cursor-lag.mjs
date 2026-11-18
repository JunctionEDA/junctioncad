// How far behind is a collaborator's cursor?  Two browsers open the same document; one moves the mouse round a
// circle at a steady speed while the other reports, frame by frame, where it draws that person's pointer.  The
// angle the drawn pointer trails the real one by, over the angular speed, is the age of what is on screen.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [E2E_BASE=http://127.0.0.1:8099] [DEMO=stickhub] [BOARD=1] [SECS=6] [SPEED=900] [OPS=1] node cursor-lag.mjs
//
// SPEED is the pointer's speed in px/s.  OPS=1 has a third client send edits meanwhile (the cursor must not wait
// for them).  Prints the age of the drawn pointer (mean, median, p95, worst), how far off it is in pixels, and
// how many times a second it moved.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
const DEMO = process.env.DEMO || 'stickhub', BOARD = !!process.env.BOARD, SECS = Number(process.env.SECS) || 6, SPEED = Number(process.env.SPEED) || 900;
const DEMOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demos');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-'));
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' }), b = b64({ sub, login, iat: now, exp: now + 36000 });
  return `${h}.${b}.${crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
await db.query('DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id IN (-9321, -9322))');
await db.query('DELETE FROM users WHERE github_id IN (-9321, -9322)').catch(() => {});
const mk = async (gid, login) => (await db.query('INSERT INTO users (github_id, login, name, email) VALUES ($1, $2, $2, $3) RETURNING id', [gid, login, `${login}@example.com`])).rows[0].id;
// the same person in two browsers: two clients as far as the session goes
const alice = await mk(-9321, 'alice');
const tokA = jwt(alice, 'alice'), tokB = tokA;
const zip = path.join(TMP, 'p.zip');
execSync(`cd "${path.join(DEMOS, DEMO)}" && zip -qr "${zip}" . -i '*.kicad_pro' '*.kicad_sch' '*.kicad_pcb'`);
const form = new FormData(); form.append('name', DEMO); form.append('archive', new Blob([fs.readFileSync(zip)]), 'p.zip');
const projectId = (await (await fetch(BASE + '/api/projects', { method: 'POST', headers: { authorization: `Bearer ${tokA}` }, body: form })).json()).projectId;

const browser = await chromium.launch();
async function open(token) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p0 = await ctx.newPage(); await p0.goto(`${BASE}/auth/dev?jwt=${token}&next=${encodeURIComponent('/api/me')}`); await p0.close();
  const page = await ctx.newPage();
  // PLAYOUT=0: draw each update as it arrives (the replay switch, peercursors.ts), to compare
  if (process.env.PLAYOUT === '0') await page.addInitScript(() => { try { localStorage.setItem('junction.cursorPlayout', '0'); } catch {} });
  page.on('pageerror', (e) => console.log('pageerror: ' + e.message));
  await page.goto(`${BASE}/p/${projectId}/edit`);
  await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.joinedDocId, null, { timeout: 30000 })
    .catch(async (e) => { console.log('editor did not open:', await page.evaluate(() => ({ title: document.title, E: !!window.CollabEditor, kdoc: !!(window.CollabEditor && window.CollabEditor.kdoc), joined: window.CollabEditor && window.CollabEditor.joinedDocId, ws: window.CollabEditor && window.CollabEditor.ws && window.CollabEditor.ws.readyState }))); throw e; });
  if (BOARD) {
    await page.evaluate(() => { const E = window.CollabEditor; E.api.openDoc(E.api.state.docs.find((d) => d.docType === 'kicad_pcb')); });
    await page.waitForFunction(() => document.body.dataset.editor === 'pcb' && window.CollabEditor.kdoc && window.CollabEditor.joinedDocId, null, { timeout: 30000 });
  }
  await page.waitForTimeout(1500);
  return page;
}
const A = await open(tokA), B = await open(tokB);
// JITTER_FLAG=<file>: a test proxy (an uneven network) reads this file to start misbehaving once both editors are open
if (process.env.JITTER_FLAG) fs.writeFileSync(process.env.JITTER_FLAG, '1');
const docId = await A.evaluate(() => window.CollabEditor.joinedDocId);

// where the drawing area is, and a circle inside it
const box = await A.evaluate(() => { const r = document.querySelector('#stage').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
const CX = box.x + box.w / 2, CY = box.y + box.h / 2, R = Math.min(box.w, box.h) * 0.3, OMEGA = SPEED / R;   // rad/s

// the sender notes every pointer move it gets; the receiver notes where the peer's pointer is on every frame
await A.evaluate(() => { window.__moves = []; document.addEventListener('pointermove', (e) => window.__moves.push([performance.timeOrigin + performance.now(), e.clientX, e.clientY]), true); });
const probe = () => {
  window.__seen = [];
  const tick = () => {
    const el = document.querySelector('#peerCursorG .peer-cursor path') || document.querySelector('#peersG path');
    if (el) { const r = el.getBoundingClientRect(); window.__seen.push([performance.timeOrigin + performance.now(), r.x, r.y]); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
// the drawn pointer's offset from the real one at rest (stroke, and any difference between the two views)
await A.mouse.move(CX + R, CY); await A.waitForTimeout(100); await A.mouse.move(CX + R, CY + 1); await A.waitForTimeout(100); await A.mouse.move(CX + R, CY);
await A.waitForTimeout(1500);
await B.evaluate(probe); await B.waitForTimeout(300);
const rest = await B.evaluate(() => window.__seen[window.__seen.length - 1]);
if (!rest) { console.error('the second browser never drew the first one\'s pointer'); process.exit(1); }
const OFF = [rest[1] - (CX + R), rest[2] - CY];
await A.evaluate(() => { window.__moves.length = 0; }); await B.evaluate(() => { window.__seen.length = 0; });

// OPS=1: somebody else edits meanwhile
let ws = null, opTimer = null;
if (process.env.OPS) {
  ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws'); const inbox = [];
  ws.onmessage = (ev) => inbox.push(JSON.parse(ev.data));
  await new Promise((r) => { ws.onopen = r; });
  const until = async (f) => { const t = Date.now(); while (!f()) { if (Date.now() - t > 20000) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } };
  ws.send(JSON.stringify({ type: 'hello', proto: 1, token: tokA, clientId: 'cursor-script', client: 'script' }));
  await until(() => inbox.some((m) => m.type === 'hello_ok'));
  ws.send(JSON.stringify({ type: 'join_doc', docId })); await until(() => inbox.some((m) => m.type === 'doc_info'));
  let i = 0;
  opTimer = setInterval(() => {
    const id = crypto.randomUUID(), x = 20 + (i % 100) * 1.27, y = 250 + Math.floor(i / 100) * 2.54; i++;
    const change = BOARD
      ? { id, typeName: 'PCB_TRACK', kind: 'ADDED', sexpr: `(kicad_pcb (segment (start ${x} ${y}) (end ${x + 1} ${y}) (width 0.2) (layer "F.Cu") (net 0) (uuid "${id}")))` }
      : { id, typeName: 'SCH_LINE', kind: 'ADDED', sexpr: `(wire (pts (xy ${x} ${y}) (xy ${x + 1.27} ${y})) (stroke (width 0) (type default)) (uuid "${id}"))` };
    ws.send(JSON.stringify({ type: 'op', docId, clientOpId: `cur:${i}`, baseSeq: null, changes: [change] }));
  }, 50);
}

// round the circle at a steady speed, a move every ~8 ms (a 120 Hz mouse)
const t0 = Date.now();
for (;;) {
  const t = (Date.now() - t0) / 1000; if (t > SECS) break;
  await A.mouse.move(CX + R * Math.cos(OMEGA * t), CY + R * Math.sin(OMEGA * t));
  await new Promise((r) => setTimeout(r, 8));
}
// then stop dead: how long until the drawn pointer is where the real one stopped
const stopAt = await A.evaluate(() => performance.timeOrigin + performance.now());
if (process.env.DEBUG) console.log('  replay state while moving', JSON.stringify(await B.evaluate(() => window.__peerCursorState && window.__peerCursorState())));
await A.waitForTimeout(1200);
if (opTimer) clearInterval(opTimer);
const moves = await A.evaluate(() => window.__moves), seen = await B.evaluate(() => window.__seen);
if (process.env.DEBUG) console.log('  replay state', JSON.stringify(await B.evaluate(() => window.__peerCursorState && window.__peerCursorState())));

// angle of the real pointer over time (unwrapped), then for each frame the drawn pointer's angle against it
const ang = (x, y) => Math.atan2(y - CY, x - CX);
const real = []; let prev = null, turns = 0;
for (const [t, x, y] of moves) { let a = ang(x, y); if (prev !== null && a - prev < -Math.PI) turns++; else if (prev !== null && a - prev > Math.PI) turns--; prev = a; real.push([t, a + turns * 2 * Math.PI, x, y]); }
const realAt = (t) => {   // [angle, x, y] of the real pointer at time t
  let lo = 0, hi = real.length - 1; if (t <= real[0][0]) return real[0].slice(1); if (t >= real[hi][0]) return real[hi].slice(1);
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (real[m][0] <= t) lo = m; else hi = m; }
  const f = (t - real[lo][0]) / (real[hi][0] - real[lo][0] || 1);
  return [1, 2, 3].map((k) => real[lo][k] + (real[hi][k] - real[lo][k]) * f);
};
const ages = [], errs = [], speeds = []; let updates = 0, last = null, prevA = null; const first = real[0][0] + 500, end = real[real.length - 1][0];
let frames = 0;
for (const [t, sx, sy] of seen) {
  if (t < first || t > end) continue;
  frames++;
  const x = sx - OFF[0], y = sy - OFF[1];
  if (!last || Math.abs(x - last[0]) > 0.01 || Math.abs(y - last[1]) > 0.01) updates++;
  last = [x, y];
  const [ra, rx, ry] = realAt(t);
  let d = ra - ang(x, y); d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;   // how far behind, in radians
  ages.push(d / OMEGA * 1000); errs.push(Math.hypot(rx - x, ry - y));
  // how even the drawn motion is: its speed from one frame to the next, as a share of the real speed
  const da = ang(x, y); if (prevA) { let s = da - prevA[1]; s -= Math.round(s / (2 * Math.PI)) * 2 * Math.PI; if (t > prevA[0]) speeds.push(s / ((t - prevA[0]) / 1000) / OMEGA); } prevA = [t, da];
}
const stats = (v) => { const s = [...v].sort((a, b) => a - b), q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { mean: v.reduce((a, b) => a + b, 0) / v.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] }; };
const fmt = (s, u) => `mean ${s.mean.toFixed(1)}${u}, median ${s.p50.toFixed(1)}${u}, p95 ${s.p95.toFixed(1)}${u}, worst ${s.max.toFixed(1)}${u}`;
const secs = (end - first) / 1000;
// settle: first frame after the stop from which the drawn pointer stays within 1.5 px of where the real one rests
const fin = real[real.length - 1]; let settle = null;
for (let i = seen.length - 1; i >= 0; i--) { const [t, sx, sy] = seen[i]; if (Math.hypot(sx - OFF[0] - fin[2], sy - OFF[1] - fin[3]) > 1.5) { settle = i + 1 < seen.length ? seen[i + 1][0] - fin[0] : null; break; } }
console.log(`${DEMO} ${BOARD ? 'board' : 'schematic'}, pointer at ${SPEED} px/s for ${SECS} s${process.env.OPS ? ', with edits arriving' : ''}`);
console.log(`  sender got                 ${(moves.length / ((stopAt - real[0][0]) / 1000)).toFixed(0)} pointer moves a second`);
console.log(`  drawn pointer moved        ${(updates / secs).toFixed(1)} times a second (${(frames / secs).toFixed(0)} frames a second)`);
console.log(`  age of what is drawn       ${fmt(stats(ages), ' ms')}`);
console.log(`  distance from the real one ${fmt(stats(errs), ' px')}`);
{ const m = speeds.reduce((p, c) => p + c, 0) / speeds.length, sd = Math.sqrt(speeds.reduce((p, c) => p + (c - m) ** 2, 0) / speeds.length);
  console.log(`  unevenness of the motion     ${(sd * 100).toFixed(0)}% (frame-to-frame speed, spread around the real speed; 0% is perfectly smooth)`); }
console.log(`  settled after the stop in  ${settle === null ? 'never (still off after 1.2 s)' : Math.max(0, settle).toFixed(0) + ' ms'}`);
if (process.env.JSON_OUT) fs.writeFileSync(process.env.JSON_OUT, JSON.stringify({ age: stats(ages), err: stats(errs), updates: updates / secs, settle }));

if (ws) ws.close();
if (process.env.JITTER_FLAG) fs.rmSync(process.env.JITTER_FLAG, { force: true });
await browser.close();
await db.query('DELETE FROM projects WHERE id = $1', [projectId]).catch(() => {});
await db.end();
