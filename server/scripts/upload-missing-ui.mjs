// The upload dialog's limits and its "the project names files that were not uploaded" step
// (web/platform/home/UploadDialog.tsx, src/projectlibs.rs missing_project_files, GET /api/limits).
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node upload-missing-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL, SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demos/ecc83');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-missing-'));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000), head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const uid = (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [9811, 'upl-alice', 'Alice'])).rows[0].id;
await db.query('DELETE FROM projects WHERE owner_id = $1', [uid]);
const jwt = mintJwt(uid, 'upl-alice');
const get = async (p) => { const r = await fetch(BASE + p, { headers: { authorization: `Bearer ${jwt}` } }); return { status: r.status, body: await r.json().catch(() => null) }; };

const limits = (await get('/api/limits')).body;
check('the server says what an upload may hold', limits && limits.maxFileBytes >= 100 * 1048576 && limits.maxTotalBytes >= limits.maxFileBytes && limits.maxFiles === 200, JSON.stringify(limits));

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=/`);
await page.waitForSelector('.hp-head-acts .btn.primary');

// the project's top-level files only: no footprints.pretty, no 3d_shapes
const top = fs.readdirSync(DEMO).filter((f) => fs.statSync(path.join(DEMO, f)).isFile() && !/_v2\./.test(f) && f !== 'ecc83-pp.kicad_sym').map((f) => path.join(DEMO, f));
await page.click('.hp-head-acts .btn.primary');
await page.locator('.hp-modal input[type=file]').first().setInputFiles(top);
await page.waitForSelector('.hp-summary');
await page.locator('.hp-field input').fill('Valve amp');
await page.click('.hp-modal-f .btn.primary');
await page.waitForSelector('.hp-missing');
const listed = await page.locator('.hp-missing li').allTextContents();
check('the dialog stays and lists the footprint library', listed.some((t) => /footprint library\s+footprints\.pretty/.test(t)), listed.join(' | '));
check('…the symbol library', listed.some((t) => /symbol library\s+ecc83-pp\.kicad_sym/.test(t)), listed.join(' | '));
check('…and the 3D models the board names', listed.some((t) => /3D model\s+3d_shapes\//.test(t)), listed.join(' | '));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/upload-missing.png` });

// a file that is not one of them
const stray = path.join(TMP, 'other.kicad_mod'); fs.writeFileSync(stray, '(footprint "other")');
await page.locator('.hp-modal input[type=file]').first().setInputFiles(stray);
await page.waitForSelector('.hp-note.err');
check('a file the project does not miss is refused with a reason', /missing/.test(await page.locator('.hp-note.err').textContent()));

// the missing ones: the library folder, the symbol library, the models
const pretty = fs.readdirSync(path.join(DEMO, 'footprints.pretty')).map((f) => path.join(DEMO, 'footprints.pretty', f));
const shapes = fs.readdirSync(path.join(DEMO, '3d_shapes')).map((f) => path.join(DEMO, '3d_shapes', f));
await page.locator('.hp-modal input[type=file]').nth(1).setInputFiles(DEMO).catch(async () => {
  // a browser build that cannot take a directory here: the files themselves, by name
  await page.locator('.hp-modal input[type=file]').first().setInputFiles([...pretty, ...shapes, path.join(DEMO, 'ecc83-pp.kicad_sym')]);
});
await page.waitForFunction(() => /added/.test(document.querySelector('.hp-modal')?.textContent || ''), null, { timeout: 30000 });
await page.waitForTimeout(300);
const after = await page.locator('.hp-missing li').allTextContents();
const mine = (await get('/api/projects')).body.projects.find((p) => p.name === 'Valve amp');
const docs = (await get(`/api/projects/${mine.projectId}`)).body.docs.map((d) => d.path);
check('the footprint library is stored with the project', pretty.every((f) => docs.includes('footprints.pretty/' + path.basename(f))), docs.join(','));
check('the symbol library is stored', docs.includes('ecc83-pp.kicad_sym'));
const stored = shapes.filter((f) => docs.includes('3d_shapes/' + path.basename(f))).length;
check('the 3D models the board names are stored', stored > 0 && !after.some((t) => /3D model/.test(t) && shapes.some((f) => t.includes(path.basename(f)))), `${stored} of ${shapes.length}; left: ${after.join(' | ')}`);
check('nothing that was not missing was added', !docs.some((d) => /_v2\./.test(d)), docs.join(','));
if (SHOTS) await page.screenshot({ path: `${SHOTS}/upload-missing-added.png` });
await page.click('.hp-modal-f .btn.primary');
await page.waitForSelector('.hp-item-name:has-text("Valve amp")');
check('closing the step shows the project in the list', true);

// too large: said before anything is sent
const MB = Math.round(limits.maxFileBytes / 1048576);
const big = path.join(TMP, 'big.kicad_pcb'); const fd = fs.openSync(big, 'w'); fs.ftruncateSync(fd, limits.maxFileBytes + 1024); fs.closeSync(fd);
await page.click('.hp-head-acts .btn.primary');
await page.locator('.hp-modal input[type=file]').first().setInputFiles(big);
await page.waitForSelector('.hp-note.err');
const said = await page.locator('.hp-note.err').textContent();
check('a file over the limit is refused before upload, with the size and the limit', new RegExp(`big\\.kicad_pcb is ${MB}\\.0 MB.*at most ${MB} MB`).test(said) && await page.locator('.hp-modal-f .btn.primary').isDisabled(), said);
if (SHOTS) await page.screenshot({ path: `${SHOTS}/upload-too-large.png` });

// the server says the same to a client that sends it anyway
const form = new FormData(); form.append('file', new Blob([fs.readFileSync(big)]), 'big.kicad_pcb');
const r = await fetch(BASE + '/api/projects', { method: 'POST', headers: { authorization: `Bearer ${jwt}` }, body: form });
const text = await r.text();
check('the server answers a too-large file with a readable reason, not a dropped connection', r.status === 400 && new RegExp(`big\\.kicad_pcb is ${MB}\\.0 MB`).test(text), `${r.status} ${text.slice(0, 200)}`);

await browser.close();
await db.query('DELETE FROM projects WHERE owner_id = $1', [uid]);
await db.end();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
