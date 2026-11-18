// The Devboard Demo opened the way a new account opens it (src/demo.rs): the project list shows it, the schematic
// and board editors load it, and the 3D view finds a real model for every part (the project's own lcsc models
// and KiCad's library ones).  Needs a server that reaches KiCad's 3D library (KC_EXTRA_CA_FILE in the cloud rig).
//
//   E2E_JWT_SECRET=… E2E_USER=<id of an account that has its demo> E2E_LOGIN=<its login> [SHOTS=dir] node demo-ui.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, SHOTS = process.env.SHOTS || '';
const UID = +process.env.E2E_USER, LOGIN = process.env.E2E_LOGIN || 'demo';
if (!SECRET || !UID) { console.error('E2E_JWT_SECRET and E2E_USER are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000), head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub: UID, login: LOGIN, iat: now, exp: now + 3600 });
const jwt = `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;

const list = await (await fetch(`${BASE}/api/projects`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
const demo = list.projects.find((p) => p.name === 'Devboard Demo');
check('the account has its Devboard Demo', !!demo);
const info = await (await fetch(`${BASE}/api/projects/${demo.projectId}`, { headers: { Authorization: `Bearer ${jwt}` } })).json();
const doc = (p) => info.docs.find((d) => d.path === p);

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: 'dark' });
const page = await ctx.newPage(); page.setDefaultTimeout(30000);
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
const loaded = () => page.waitForFunction(() => { const E = window.CollabEditor; return E && E.kdoc && E.kdoc.items.size > 1 && E.ws && E.ws.readyState === 1; }, null, { timeout: 90000 });
try {
  await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=/`);
  await page.getByText('Devboard Demo').first().waitFor();
  check('the project list shows Devboard Demo', true);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '01-project-list.png') });

  await page.goto(`${BASE}/p/${demo.projectId}/edit?doc=${doc('Devboard_Demo.kicad_sch').docId}`);
  await loaded();
  await page.waitForTimeout(1500);
  const sch = await page.evaluate(() => { const E = window.CollabEditor; let syms = 0; for (const it of E.kdoc.items.values()) if (it.kind === 'symbol' || it.type === 'symbol') syms++; return { items: E.kdoc.items.size, syms }; });
  check('the schematic opens', sch.items > 100, JSON.stringify(sch));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '02-schematic.png') });

  await page.goto(`${BASE}/p/${demo.projectId}/edit?doc=${doc('Devboard_Demo.kicad_pcb').docId}`);
  await loaded();
  await page.waitForFunction(() => window.PcbTools, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const pcb = await page.evaluate(() => window.CollabEditor.kdoc.items.size);
  check('the board opens', pcb > 100, String(pcb));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '03-board.png') });

  await page.evaluate(() => window.CollabApp.dispatch({ type: 'action', id: 'show3DViewer' }));
  await page.waitForFunction(() => window.KiCadViewer3D?.current?.viewer?.stats, null, { timeout: 90000 });
  await page.evaluate(() => window.KiCadViewer3D.current.viewer.modelsSettled());
  await page.waitForTimeout(1500);
  const st = await page.evaluate(() => { const s = window.KiCadViewer3D.current.viewer.stats; return { bodies: s.bodies, models: s.models, missing: s.missingModels, replaced: s.replacedModels, status: (document.querySelector('.v3d-status') || {}).textContent || '' }; });
  console.log('      3D:', JSON.stringify(st));
  check('every part on the board shows a 3D model', st.bodies > 60 && st.models === st.bodies && st.missing.length === 0, JSON.stringify(st));
  check('no part needed a stand-in model', st.replaced.length === 0, JSON.stringify(st.replaced));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '04-3d-view.png') });
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) { check('test ran to the end', false, (e.stack || String(e)) + ' ERRORS ' + errors.join(' | ')); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'failure.png') }); }
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
