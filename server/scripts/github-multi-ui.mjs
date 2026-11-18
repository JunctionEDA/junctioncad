// Browser test of the GitHub page for a repository with several projects: the picker
// that brings more than one online, shared libraries and submodules in the file list,
// renames and deletes, and a project whose folder is gone.  Same setup as
// github-ui.mjs (local server with KC_DEV_LOGIN=1, throwaway database, fake-github.mjs).
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node github-multi-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const GH = (process.env.E2E_FAKE_GH || 'http://127.0.0.1:8098').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

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
const ctl = async (what, body) => (await fetch(`${GH}/__ctl/${what}`, body
  ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
const commit = (fullName, files, message) => ctl('commit', { fullName, files, message });

// ---------------------------------------------------------------- fixtures: two boards sharing hardware/lib
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fpItem = (ref, n, x) => `\t(footprint "lcsc:${ref}"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uuid(n)}")\n\t\t(at ${x} 50)\n\t)\n`;
const board = (items) => `(kicad_pcb\n\t(version 20241229)\n\t(generator "pcbnew")\n\t(generator_version "9.0")\n\t(paper "A4")\n${items.join('')})\n`;
const sch = (n, extra = '') => `(kicad_sch\n\t(version 20250114)\n\t(generator "eeschema")\n\t(uuid "${uuid(n)}")\n\t(paper "A4")\n${extra})\n`;
const pro = (name) => `{\n  "meta": { "filename": "${name}.kicad_pro", "version": 3 }\n}\n`;
const FP_TABLE = '(fp_lib_table\n  (version 7)\n  (lib (name "lcsc")(type "KiCad")(uri "${KIPRJMOD}/../lib/lcsc.pretty")(options "")(descr ""))\n)\n';
const SYM_TABLE = '(sym_lib_table\n  (version 7)\n  (lib (name "lcsc")(type "KiCad")(uri "${KIPRJMOD}/../lib/lcsc.kicad_sym")(options "")(descr ""))\n)\n';
const mod = (name) => `(footprint "${name}"\n\t(version 20241229)\n\t(generator "pcbnew")\n\t(layer "F.Cu")\n\t(attr smd)\n)\n`;
const SYM0 = '(kicad_symbol_lib\n\t(version 20241209)\n\t(generator "kicad_symbol_editor")\n\t(symbol "R"\n\t\t(property "Reference" "R"\n\t\t\t(at 0 0 0)\n\t\t)\n\t)\n)\n';
const lib = (prefix) => ({ [`${prefix}lcsc.kicad_sym`]: SYM0, [`${prefix}lcsc.pretty/R.kicad_mod`]: mod('R'), [`${prefix}lcsc.pretty/C.kicad_mod`]: mod('C') });
const project = (dir, name, n) => ({
  [`${dir}/${name}.kicad_pro`]: pro(name), [`${dir}/${name}.kicad_pcb`]: board([fpItem('R', n, 100), fpItem('C', n + 1, 110)]), [`${dir}/${name}.kicad_sch`]: sch(n),
  [`${dir}/fp-lib-table`]: FP_TABLE, [`${dir}/sym-lib-table`]: SYM_TABLE });

await ctl('reset', {});
const GH_ID = 9301;
const userId = (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, 'ui-noor', 'Noor')
   ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [GH_ID])).rows[0].id;
await db.query('DELETE FROM github_tokens WHERE user_id = $1', [userId]);
await db.query('DELETE FROM projects WHERE owner_id = $1', [userId]);
const jwt = mintJwt(userId, 'ui-noor');
await ctl('user', { login: 'ui-noor', id: GH_ID });
await ctl('user', { login: 'someone-else', id: 9302 });
await ctl('browser', { login: 'ui-noor' });
await ctl('repo', { fullName: 'ui-noor/parts', isPrivate: true, files: { 'README.md': '# parts\n', ...lib('') } });
await ctl('repo', { fullName: 'someone-else/private-models', isPrivate: true, files: { 'a.step': 'x' } });
await ctl('repo', { fullName: 'ui-noor/keyboard', isPrivate: true, files: {
  'README.md': '# keyboard\n', 'firmware/main.c': 'int main(){}',
  '.gitmodules': '[submodule "hardware/lib"]\n\tpath = hardware/lib\n\turl = ../parts.git\n[submodule "hardware/models"]\n\tpath = hardware/models\n\turl = https://github.com/someone-else/private-models.git\n',
  'hardware/lib': { submodule: 'ui-noor/parts' }, 'hardware/models': { submodule: 'someone-else/private-models' },
  ...project('hardware/keybit', 'keybit', 10), ...project('hardware/keyword', 'keyword', 20),
  'hardware/spacer/spacer-1u.kicad_pro': pro('spacer-1u'), 'hardware/spacer/spacer-1u.kicad_pcb': board([]),
  'hardware/spacer/spacer-0.5u.kicad_pro': pro('spacer-0.5u'), 'hardware/spacer/spacer-0.5u.kicad_pcb': board([fpItem('R', 5, 1)]),
  'hardware/panels/p1/p1.kicad_pro': pro('p1'), 'hardware/panels/p1/p1.kicad_pcb': board([fpItem('R', 6, 1)]),
  'hardware/panels/p1/src/keybit.kicad_pro': pro('keybit-copy'), 'hardware/panels/p1/src/keybit.kicad_pcb': board([]),
} });

const saveOnline = async (docId, content) => {
  const { rows } = await db.query(
    `SELECT GREATEST(COALESCE((SELECT MAX(seq) FROM ops WHERE doc_id = $1), 0),
                     COALESCE((SELECT MAX(seq) FROM snapshots WHERE doc_id = $1), 0)) AS head`, [docId]);
  await db.query('INSERT INTO snapshots (doc_id, seq, content) VALUES ($1, $2, $3)', [docId, rows[0].head + 1, Buffer.from(content)]);
};
const docsOf = async (pid) => Object.fromEntries((await db.query('SELECT path, id FROM documents WHERE project_id = $1', [pid])).rows.map((r) => [r.path, r.id]));

// ---------------------------------------------------------------- browser
const browser = await chromium.launch();
const errors = [];
async function open(viewport, scale, scheme = 'light') {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, colorScheme: scheme });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|fonts\.g|ERR_|40[0-9]|status of 4/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', (d) => d.accept());
  await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=/github`);
  return page;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const row = (page, path) => page.locator('table.files tr', { has: page.locator('td.path', { hasText: path }) }).first();
const refresh = async (page) => { await page.click('#refresh'); await page.waitForFunction(() => !document.querySelector('#refresh')?.disabled); };

try {
  const page = await open({ width: 1180, height: 900 }, 2);
  await page.click('#ghConnect');
  await page.waitForSelector('[data-repo="ui-noor/keyboard"]');
  await page.click('[data-repo="ui-noor/keyboard"]');
  await page.waitForSelector('[data-pick]');

  // ---- the picker
  check('every project folder of the repository is listed', await page.locator('#scanList .it').count() === 5, String(await page.locator('#scanList .it').count()));
  const text = await page.textContent('#scanList');
  check('a project says which library it shares from outside its folder', /shares\s+hardware\/lib\/lcsc\.pretty/.test(text));
  check('a nested project says which project it is inside', /inside the project in\s+hardware\/panels\/p1/.test(text));
  check('a folder with several project files says they stay together', /2 project files in this folder/.test(text));
  check('a submodule that cannot be read is named, with the repository to add', /someone-else\/private-models/.test(await page.textContent('[data-note="submodule_no_access"]')));
  check('nothing is picked and the button waits', await page.isDisabled('#doImport'));
  await page.check('[data-pick="0"]'); await page.check('[data-pick="1"]');
  check('the button counts what is picked', (await page.textContent('#doImport')).trim() === 'Bring 2 projects online');
  await shot(page, '01-pick-projects');
  await page.click('#doImport');
  await page.waitForSelector('#importResult');
  check('both come online and are listed with links', await page.locator('#importResult li a').count() === 2 && /shared from outside its folder/.test(await page.textContent('#importResult')));
  check('the folders now show as online instead of pickable', await page.locator('#scanList .isOnline').count() === 2 && await page.locator('[data-pick]').count() === 3);
  check('select all picks the rest', await (async () => { await page.check('#pickAll'); return (await page.textContent('#doImport')).trim() === 'Bring 3 projects online'; })());
  await shot(page, '02-imported');
  check('the header has a way back to the projects', await page.isVisible('#toProjects'));

  // ---- one project's page: shared files, the submodule
  const pids = (await db.query('SELECT p.id, p.name FROM projects p WHERE owner_id = $1', [userId])).rows;
  const keybit = pids.find((p) => p.name === 'keybit').id, keyword = pids.find((p) => p.name === 'keyword').id;
  await page.goto(`${BASE}/p/${keybit}/github`);
  await page.waitForSelector('table.files');
  check('the shared library\'s files are in the list, tagged as shared and with their repository', (await row(page, '../lib/lcsc.kicad_sym').textContent()).includes('shared')
    && (await row(page, '../lib/lcsc.kicad_sym').textContent()).includes('ui-noor/parts'));
  check('the page explains where submodule files go on a push', /hardware\/lib/.test(await page.textContent('#submodules')));
  check('the project page has both the way back and Open project', await page.isVisible('#toProjects') && await page.isVisible('#back') && (await page.textContent('#back')).trim() === 'Open project');
  await shot(page, '03-shared-and-submodule');

  // ---- push into the submodule
  let docs = await docsOf(keybit);
  await saveOnline(docs['../lib/lcsc.kicad_sym'], SYM0.replace('"R"', '"R_new"'));
  await refresh(page);
  await page.click('#push');
  await page.waitForSelector('#result');
  check('a push says the library\'s files went to the library\'s repository', /went to\s+ui-noor\/parts/.test((await page.textContent('#result')).replace(/\s+/g, ' ')), await page.textContent('#result'));
  await shot(page, '04-pushed-into-submodule');

  // ---- the other project: rename + delete from GitHub
  await commit('ui-noor/keyboard', { 'hardware/keyword/keyword.kicad_sch': null, 'hardware/keyword/main.kicad_sch': sch(20), 'hardware/keyword/sym-lib-table': null }, 'Rename the schematic, drop the symbol table');
  await page.goto(`${BASE}/p/${keyword}/github`);
  await page.waitForSelector('table.files');
  check('a renamed file is one row that says what it was', (await row(page, 'main.kicad_sch').textContent()).includes('was keyword.kicad_sch') && await page.locator('td.path', { hasText: /^keyword\.kicad_sch/ }).count() === 0);
  check('a file deleted on GitHub is a delete to pull', /deleted on GitHub/.test(await row(page, 'sym-lib-table').textContent()));
  await shot(page, '05-renamed-and-deleted');
  await page.click('#pull');
  await page.waitForSelector('#result');
  check('the pull reports the rename and the removal', /renamed/.test(await page.textContent('#result')) && /removed/.test(await page.textContent('#result')));
  await page.waitForSelector('#removed');
  check('the removed file is kept, with a way to put it back', await page.locator('[data-putback]').count() === 1);
  await shot(page, '06-pulled-removed-kept');
  await page.click('[data-putback]');
  await page.waitForFunction(() => !document.querySelector('#removed'));
  check('putting it back makes it a file to push', /new online/.test(await row(page, 'sym-lib-table').textContent()));

  // ---- deleted on GitHub while changed online: asks
  docs = await docsOf(keyword);
  await saveOnline(docs['fp-lib-table'], FP_TABLE.replace('(descr "")', '(descr "edited")'));
  await commit('ui-noor/keyboard', { 'hardware/keyword/fp-lib-table': null }, 'Drop the footprint table');
  await refresh(page);
  const sel = page.locator('k-select[data-resolve="fp-lib-table"]');
  check('deleted on GitHub but changed online asks which to keep', await sel.count() === 1 && /Keep it online/.test(await sel.innerHTML()));
  await shot(page, '07-delete-conflict');

  // ---- the folder deleted on GitHub
  await commit('ui-noor/keyboard', { 'hardware/keyword': null }, 'Remove keyword');
  await refresh(page);
  await page.waitForSelector('#missing');
  check('a deleted folder pauses sync: no push or pull buttons, an explanation instead', await page.locator('#push').count() === 0 && await page.locator('#pull').count() === 0 && /Nothing online was changed/.test(await page.textContent('#missing')));
  await shot(page, '08-folder-missing');
  await page.click('#restoreProject');
  await page.waitForSelector('#result');
  await page.waitForSelector('table.files');
  check('putting it back restores the folder on GitHub', Object.keys((await ctl('files?repo=ui-noor/keyboard')).files).some((p) => p === 'hardware/keyword/keyword.kicad_pro'));

  // ---- the folder moved: followed, with a note
  const files = (await ctl('files?repo=ui-noor/keyboard')).files;
  await commit('ui-noor/keyboard', Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith('hardware/keyword/')).flatMap(([p, c]) => [[p, null], ['hardware/keyword-v2' + p.slice(16), c]])), 'Rename the folder');
  await refresh(page);
  await page.waitForSelector('#moved');
  check('a moved folder is followed and said so', /hardware\/keyword-v2/.test(await page.textContent('#moved')));
  await shot(page, '09-folder-moved');

  // ---- phone width and dark theme
  const phone = await open({ width: 390, height: 844 }, 2, 'dark');
  await phone.goto(`${BASE}/github`);
  await phone.waitForSelector('[data-repo="ui-noor/keyboard"]');
  await phone.click('[data-repo="ui-noor/keyboard"]');
  await phone.waitForSelector('#scanList');
  check('phone: the picker fits the screen width', await fits(phone));
  await shot(phone, '10-phone-picker-dark');
  await phone.goto(`${BASE}/p/${keybit}/github`);
  await phone.waitForSelector('table.files');
  check('phone: a project with shared files fits the screen width', await fits(phone));
  await shot(phone, '11-phone-project-dark');

  check('no script errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  await db.query('DELETE FROM projects WHERE owner_id = $1', [userId]).catch(() => {});
  await db.query('DELETE FROM users WHERE id = $1', [userId]).catch(() => {});
  await db.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
