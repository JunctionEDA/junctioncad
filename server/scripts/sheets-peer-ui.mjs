// New sheets reach the other people in a project: a sheet one person draws opens for everybody at once (double-click
// and the Schematic Hierarchy), without a reload; a sheet whose file is in nobody's copy is made on entering it (as
// eeschema gives a missing file an empty screen), and a viewer is told instead.
//
// Needs a local server with KC_DEV_LOGIN=1 on a throwaway database:
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node sheets-peer-ui.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL, SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000), head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false }); await db.connect();
const mkUser = async (ghId, login, name) => (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [ghId, login, name])).rows[0].id;
const aliceId = await mkUser(9801, 'sp-alice', 'Alice'), bobId = await mkUser(9802, 'sp-bob', 'Bob'), carolId = await mkUser(9803, 'sp-carol', 'Carol');
await db.query('DELETE FROM projects WHERE owner_id = ANY($1)', [[aliceId, bobId, carolId]]);
const alice = mintJwt(aliceId, 'sp-alice'), bob = mintJwt(bobId, 'sp-bob'), carol = mintJwt(carolId, 'sp-carol');
const api = async (tok, url, o = {}) => {
  const r = await fetch(BASE + url, { method: o.method || (o.json ? 'POST' : 'GET'), headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(o.json ? { 'Content-Type': 'application/json' } : {}) }, body: o.json ? JSON.stringify(o.json) : o.body });
  const t = await r.text(); let j = t; try { j = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, j, text: t };
};

// a root sheet holding one sheet whose file was never uploaded (what a tool or an older app could leave behind)
const SCH = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "7a1c1d6e-0000-4000-8000-000000000001") (paper "A4")
  (lib_symbols)
  (sheet (at 30 120) (size 40 25) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (fields_autoplaced yes)
    (stroke (width 0.1524) (type solid)) (fill (color 0 0 0 0.0000)) (uuid "7a1c1d6e-0000-4000-8000-000000000002")
    (property "Sheetname" "lost sheet" (at 30 119.29 0) (effects (font (size 1.27 1.27)) (justify left bottom)))
    (property "Sheetfile" "lost.kicad_sch" (at 30 145.59 0) (effects (font (size 1.27 1.27)) (justify left top)))
    (instances (project "hub" (path "/7a1c1d6e-0000-4000-8000-000000000001" (page "2")))))
  (sheet_instances (path "/" (page "1")))
  (embedded_fonts no)
)
`;
const dir = fs.mkdtempSync('/tmp/sheets-peer-');
fs.writeFileSync(path.join(dir, 'hub.kicad_pro'), JSON.stringify({ meta: { filename: 'hub.kicad_pro', version: 3 } }));
fs.writeFileSync(path.join(dir, 'hub.kicad_sch'), SCH);
execSync(`cd "${dir}" && zip -qr p.zip hub.kicad_pro hub.kicad_sch`);
const form = new FormData(); form.append('name', 'usb hub'); form.append('archive', new Blob([fs.readFileSync(path.join(dir, 'p.zip'))]), 'p.zip');
const created = await api(alice, '/api/projects', { method: 'POST', body: form });
const pid = created.j.projectId;
check('project uploaded', created.status === 200 && !!pid, created.text.slice(0, 200));
const link = await api(alice, `/api/projects/${pid}/links`, { json: { role: 'editor' } });
await api(bob, `/api/join/${link.j.token}`, { method: 'POST' });
const vlink = await api(alice, `/api/projects/${pid}/links`, { json: { role: 'viewer' } });
await api(carol, `/api/join/${vlink.j.token}`, { method: 'POST' });

const browser = await chromium.launch();
async function open(tok) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  pageerror:', e.message));
  await page.goto(`${BASE}/auth/dev?jwt=${tok}&next=${encodeURIComponent(`/p/${pid}/edit`)}`);
  await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.kdoc.items.size > 0, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  return page;
}
// the client point of a schematic point (mm), from two samples of the editor's own mapping
const clientOf = (page, mm) => page.evaluate(([x, y]) => {
  const E = window.CollabEditor, a = E.api.worldMm({ clientX: 0, clientY: 0 }), b = E.api.worldMm({ clientX: 1000, clientY: 1000 });
  return [(x - a[0]) / (b[0] - a[0]) * 1000, (y - a[1]) / (b[1] - a[1]) * 1000];
}, mm);
const docPath = (page) => page.evaluate(() => { const s = window.CollabEditor && window.CollabEditor.api.store.get(); return s && s.document && s.document.doc ? s.document.doc.path : null; });
const hierRows = (page) => page.evaluate(() => [...document.querySelectorAll('[data-path]')].map((r) => ({ text: r.textContent.trim(), doc: r.getAttribute('data-doc') })));
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) }); };

const pa = await open(alice), pb = await open(bob);
check('both open the root sheet', (await docPath(pa)) === 'hub.kicad_sch' && (await docPath(pb)) === 'hub.kicad_sch');

// ---- Alice draws a new sheet (S, two clicks, Sheet Properties OK) while Bob's page is already open
const p0 = await clientOf(pa, [110, 60]), p1 = await clientOf(pa, [170, 100]);
await pa.mouse.move(p0[0], p0[1]); await pa.keyboard.press('s');
await pa.mouse.click(p0[0], p0[1]); await pa.mouse.move(p1[0], p1[1], { steps: 4 }); await pa.mouse.click(p1[0], p1[1]);
await pa.waitForTimeout(800);
const ok = pa.locator('button', { hasText: /^OK$/ }).last();
if (await ok.count()) await ok.click(); else check('Sheet Properties opened', false);
await pa.waitForFunction(() => [...window.CollabEditor.kdoc.items.values()].filter((i) => i.kind === 'sheet').length === 2, null, { timeout: 15000 }).catch(() => {});
const files = (await api(alice, `/api/projects/${pid}`)).j.docs.map((d) => d.path);
check('the new sheet file is in the project', files.includes('untitled.kicad_sch'), files.join(','));
await pb.waitForFunction(() => [...window.CollabEditor.kdoc.items.values()].filter((i) => i.kind === 'sheet').length === 2, null, { timeout: 15000 }).catch(() => {});
await pb.waitForTimeout(2500);
const rowsB = await hierRows(pb);
check("Bob's hierarchy lists the new sheet as openable without a reload", rowsB.some((r) => /Untitled Sheet/.test(r.text) && r.doc), JSON.stringify(rowsB));
await shot(pa, '01-alice-drew-sheet.png'); await shot(pb, '02-bob-sees-it-live.png');

// ---- Bob double-clicks it and is inside
const c = await clientOf(pb, [140, 80]);
await pb.mouse.dblclick(c[0], c[1]);
await pb.waitForFunction(() => { const s = window.CollabEditor.api.store.get(); return s.document.doc && s.document.doc.path === 'untitled.kicad_sch'; }, null, { timeout: 15000 }).catch(() => {});
check('Bob enters the new sheet by double-click', (await docPath(pb)) === 'untitled.kicad_sch', await docPath(pb));
await pb.waitForTimeout(1200); await shot(pb, '03-bob-inside-new-sheet.png');

// ---- a sheet whose file nobody has: Carol (viewer) is told, Bob (editor) gets an empty sheet made and enters it
const pc = await open(carol);
const cl = await clientOf(pc, [50, 132]);
await pc.mouse.dblclick(cl[0], cl[1]); await pc.waitForTimeout(2000);
const toastC = await pc.evaluate(() => document.body.innerText);
check('a viewer is told the file is missing', /lost\.kicad_sch' is not in this project/.test(toastC) && (await docPath(pc)) === 'hub.kicad_sch');
await shot(pc, '04-viewer-missing-file.png');
const root = await pb.evaluate(() => window.CollabEditor.api.store.get().document.docs.find((d) => d.path === 'hub.kicad_sch'));
await pb.evaluate((d) => window.CollabEditor.api.openDoc(d), root); await pb.waitForTimeout(1500);
const lostRow = pb.locator('[data-path]', { hasText: 'lost sheet' });
await lostRow.first().dblclick().catch(() => {}); await lostRow.first().click().catch(() => {});
await pb.waitForFunction(() => { const s = window.CollabEditor.api.store.get(); return s.document.doc && s.document.doc.path === 'lost.kicad_sch'; }, null, { timeout: 15000 }).catch(() => {});
check('an editor entering a sheet with no file gets it made and opened', (await docPath(pb)) === 'lost.kicad_sch', await docPath(pb));
await pb.waitForTimeout(1000); await shot(pb, '05-editor-missing-file-made.png');
const files2 = (await api(alice, `/api/projects/${pid}`)).j.docs.map((d) => d.path);
check('lost.kicad_sch is now a project file', files2.includes('lost.kicad_sch'), files2.join(','));
await pa.waitForTimeout(2000);
const rowsA = await hierRows(pa);
check("Alice's hierarchy picks up the made file live", rowsA.some((r) => /lost sheet/.test(r.text) && r.doc), JSON.stringify(rowsA));
await shot(pa, '06-alice-hierarchy-updated.png');

await browser.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
