// Browser test of the board editor's right dock: Appearance with Presets and Viewports on one row, the Selection
// Filter in three columns that folds to its caption, Chat and History sharing one tabbed pane, and no pane drawing
// over the next when a sash squeezes it (the overlap this layout replaced).
//
// Needs a local server with KC_DEV_LOGIN=1 on a throwaway database:
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node dock-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demos/pic_programmer');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const uid = (await db.query(`INSERT INTO users (github_id, login, name) VALUES (9801, 'dk-alice', 'Alice') ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`)).rows[0].id;
await db.query('DELETE FROM projects WHERE owner_id = $1', [uid]);
const jwt = mintJwt(uid, 'dk-alice');

const zip = path.join(fs.mkdtempSync('/tmp/dock-ui-'), 'p.zip');
execSync(`cd "${DEMO}" && zip -qr "${zip}" . -i '*.kicad_pro' '*.kicad_sch' '*.kicad_pcb'`);
const form = new FormData(); form.append('name', 'Dock test'); form.append('archive', new Blob([fs.readFileSync(zip)]), 'p.zip');
const created = await (await fetch(BASE + '/api/projects', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form })).json();
const pid = created.projectId, pcb = created.docs.find((d) => d.docType === 'kicad_pcb');
check('project uploaded', !!pcb);
await fetch(`${BASE}/api/projects/${pid}/chat`, { method: 'POST', headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'can someone check the USB pair?' }) });

const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const page = await ctx.newPage(); page.setDefaultTimeout(10000);
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
await page.addInitScript(() => { try { if (!sessionStorage.getItem('dk')) { localStorage.clear(); sessionStorage.setItem('dk', '1'); } } catch (e) { /* none */ } });
await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=${encodeURIComponent(`/p/${pid}/edit?doc=${pcb.docId}`)}`);
await page.waitForFunction(() => { const E = window.CollabEditor; return E && E.kdoc && E.kdoc.items.size > 1 && E.ws && E.ws.readyState === 1; }, null, { timeout: 60000 });
await page.waitForTimeout(700);
const shot = async (name) => { if (SHOTS) await page.locator('#dockR').screenshot({ path: path.join(SHOTS, name + '.png') }); };
const box = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height }; }, sel);
const visible = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); return !!e && !!(e.offsetWidth || e.offsetHeight) && !e.closest('[hidden]'); }, sel);

// ---------------------------------------------------------------- Appearance and Selection Filter
{
  const p = await box('[data-label=presets]'), v = await box('[data-label=viewports]');
  check('Presets and Viewports sit on one row', !!p && !!v && Math.abs(p.top - v.top) < 3 && v.left > p.right, JSON.stringify({ p, v }));
  check('the labels keep KiCad\'s wording and keys in their tooltips', /^Presets \(.*Tab/.test(await page.getAttribute('[data-label=presets]', 'title')) && /^Viewports \(.*Tab\)/.test(await page.getAttribute('[data-label=viewports]', 'title')));
  const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.kfgrid')).gridTemplateColumns.split(' ').length);
  check('the Selection Filter grid has three columns in a 300 px dock', cols === 3, String(cols));
  await shot('01-appearance-filter');
  await page.click('[data-pane=filter] header');
  check('a click on its caption folds the Selection Filter', !(await visible('.kfgrid')) && (await page.textContent('[data-filter-summary]')) === 'All items');
  await page.click('[data-pane=filter] header');
  check('…and another opens it', await visible('.kfgrid'));
}

// ---------------------------------------------------------------- Chat and History in one tabbed pane
{
  await page.evaluate(() => window.CollabApp.dispatch({ type: 'showPane', pane: 'history', show: true }));
  await page.click('#chatBtn');
  await page.waitForSelector('[data-tabs="chat+history"]');
  check('with Chat and History both open they share one pane with tabs', (await page.locator('#dockR > .kpane:not([hidden])').count()) === 3 && (await page.locator('[data-ptab]').count()) === 2);
  check('the Chat button brought Chat to the front', await visible('#chatPane') && !(await visible('[data-pane-tab=history]')));
  await shot('02-chat-tab');
  await page.click('[data-ptab=history]');
  check('the History tab shows History, with its buttons', await visible('[data-pane-tab=history]') && await visible('[data-uiact=save]') && !(await visible('#chatPane')));
  check('Chat behind the History tab: its button is not pressed', (await page.getAttribute('#chatBtn', 'aria-pressed')) === 'false');
  await shot('03-history-tab');
  await page.click('#chatBtn');
  check('the Chat button brings it back to the front instead of closing it', await visible('#chatPane') && (await page.evaluate(() => !!window.CollabApp.getState().panes.chat)));
  await page.click('[data-pane-close=chat]');
  check('closing the Chat tab leaves History as an ordinary pane', !(await page.locator('[data-tabs]').count()) && await visible('[data-pane-tab=history]') && !(await page.evaluate(() => window.CollabApp.getState().panes.chat)));
  await page.click('#chatBtn');
  await page.waitForSelector('[data-tabs="chat+history"]');
}

// ---------------------------------------------------------------- squeezing Appearance never spills it over the filter
{
  const sash = await box('[data-sash="chat+history"]');
  // drag the sash above the tabbed pane far up: Appearance gets as small as it may
  await page.mouse.move((sash.left + sash.right) / 2, sash.top + 2); await page.mouse.down();
  await page.mouse.move((sash.left + sash.right) / 2, 40, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(200);
  const app = await box('[data-pane=appearance]'), row = await box('[data-label=viewports]'), filt = await box('[data-pane=filter]');
  check('Appearance keeps its least height (tabs, a few layers, the presets row)', app.h >= 168, String(app.h));
  check('the presets row stays inside Appearance, above the filter', row.bottom <= app.bottom + 0.5 && app.bottom <= filt.top + 0.5, JSON.stringify({ row, app, filt }));
  await shot('04-squeezed');
  // a short window: everything clips inside its own pane
  await page.setViewportSize({ width: 1100, height: 560 });
  await page.waitForTimeout(300);
  const overlap = await page.evaluate(() => {
    const ps = Array.from(document.querySelectorAll('#dockR > .kpane')).filter((p) => !p.hidden);
    return ps.some((p) => Array.from(p.querySelectorAll('*')).some((c) => { const r = c.getBoundingClientRect(), q = p.getBoundingClientRect(); return r.height > 0 && r.bottom > q.bottom + 1 && getComputedStyle(c).position !== 'fixed' && r.top < q.bottom; }) && getComputedStyle(p).overflow !== 'hidden');
  });
  check('in a short window no pane draws past its own edge', !overlap);
  await shot('05-short-window');
}

check('no errors in the page', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
