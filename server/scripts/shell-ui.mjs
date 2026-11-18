// Browser test of the project shell in the real app, as two people use it: a blank project that opens on its
// Home tab; two PCBs, a part studio and an assembly made from "+" and from Home; a PCB as one tab with Schematic,
// Board and BOM inside it; a KiCad project folder imported as a third PCB; and then the part that matters most:
// that each PCB's board is updated from ITS schematic and no other's.  After that the tab bar (reorder, rename,
// duplicate, folders, the tab manager, the keyboard, delete and undo), deep links, and that the second person
// sees all of it without reloading.
//
// Setup as the other *-ui.mjs scripts: a local server with KC_DEV_LOGIN=1 on a throwaway database, Playwright,
// and psql on the PATH (it makes the two test users):
//
//   DATABASE_URL=postgres://… JWT_SECRET=testsecret PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 KC_DEV_LOGIN=1 \
//     KC_LIBS_FOOTPRINTS_URL=$PWD/scripts/fixtures/shell-ui/footprints cargo run
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/shell-ui.mjs
//
// SHOTS also gets the same screens in the dark theme and at 1100 px.  Nothing here needs the network:
// KC_LIBS_FOOTPRINTS_URL points the server's footprint libraries at a folder beside this script that holds the one
// footprint the imported PCB uses (Update PCB from Schematic takes footprints from the libraries the server serves).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
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
function user(login, name, githubId) {
  sql(`INSERT INTO users (github_id, login, name) VALUES (${githubId}, '${login}', '${name}') ON CONFLICT (github_id) DO NOTHING`);
  return Number(sql(`SELECT id FROM users WHERE github_id = ${githubId}`));
}
/** Wait until `fn` is true in the page.  Opening another PCB loads the page again: a wait that the reload cuts short starts over. */
const until = async (page, fn, arg, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    try { await page.waitForFunction(fn, arg, { timeout: Math.max(1, end - Date.now()) }); return true; }
    catch (e) { if (Date.now() >= end || /Timeout/.test(String(e))) return false; await new Promise((r) => setTimeout(r, 150)); }
  }
};
const app = (page) => page.evaluate(() => { const s = window.appState(); return { view: s.view, docId: s.document.docId, docType: s.document.doc && s.document.doc.docType, hasDoc: s.document.hasDoc, pcb: s.project && s.project.pcb, docs: s.project ? s.project.docs.map((d) => d.path) : [], all: s.project ? (s.project.allDocs || s.project.docs).map((d) => ({ id: d.docId, path: d.path, type: d.docType })) : [] }; });
/** The tabs as the bar shows them: "Home", "PCB 1[Schematic*|Board|BOM]", "Lid"; the open one in capitals after ">". */
const tabs = (page) => page.$$eval('#doctabs [data-doc-tab=home], #doctabs [data-el-tab]', (els) => els.map((e) => (e.getAttribute('aria-selected') === 'true' ? '>' : '') + (e.dataset.elTab ? e.dataset.tabName : 'Home')));
const views = (page, name) => page.$$eval(`#doctabs [data-el-tab][data-tab-name="${name}"] [data-pcb-view]`, (els) => els.map((e) => (e.getAttribute('aria-selected') === 'true' ? '>' : '') + e.textContent.trim()));
const view = (page, pcb, which) => page.click(`#doctabs [data-el-tab][data-tab-name="${pcb}"] [data-pcb-view=${which}]`);
const tab = (name) => `#doctabs [data-el-tab][data-tab-name="${name}"]`;
/** The schematic or board editor has a document on screen: the one the tab says, read, drawn. */
const drawn = (page, type) => until(page, (type) => { const s = window.appState(); return s.view === 'editor' && s.document.hasDoc && s.document.doc && s.document.doc.docType === type && !!document.querySelector('#doctabs [data-el-tab][aria-selected=true]'); }, type, 40000);
/** What the open KiCad document holds: its symbols or footprints by reference. */
const refs = (page) => page.evaluate(() => window.appState().document.items.map((i) => i.ref).filter(Boolean).sort());
const rowNames = (page) => page.$$eval('[data-home-rows] [data-row-id]', (els) => els.map((e) => `${e.dataset.rowKind[0]}:${e.dataset.rowName}`));

// ---------------------------------------------------------------- a small KiCad project on disk, to import
// One resistor, R1, with a library and a library table of the project's own beside it (they must come along and stay this PCB's).
const uuid = () => crypto.randomUUID();
const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'junction-shell-'));
const ampDir = path.join(fx, 'Amp');
fs.mkdirSync(path.join(ampDir, 'mylib.pretty'), { recursive: true });
const rootUuid = uuid();
const prop = (k, v, hide) => `(property "${k}" "${v}" (at 0 0 0) (effects (font (size 1.27 1.27))${hide ? ' (hide yes)' : ''}))`;
fs.writeFileSync(path.join(ampDir, 'Amp.kicad_pro'), JSON.stringify({ board: { design_settings: { defaults: {}, rules: {} } }, boards: [], libraries: { pinned_footprint_libs: [], pinned_symbol_libs: [] }, meta: { filename: 'Amp.kicad_pro', version: 1 }, net_settings: { classes: [{ name: 'Default', clearance: 0.2, track_width: 0.2, via_diameter: 0.6, via_drill: 0.3 }], meta: { version: 0 } }, sheets: [], text_variables: {} }, null, 2));
fs.writeFileSync(path.join(ampDir, 'Amp.kicad_sch'), `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "${rootUuid}") (paper "A4")
  (lib_symbols
    (symbol "Device:R" (pin_numbers (hide yes)) (pin_names (offset 0)) (exclude_from_sim no) (in_bom yes) (on_board yes)
      ${prop('Reference', 'R')} ${prop('Value', 'R')} ${prop('Footprint', '', true)} ${prop('Datasheet', '~', true)} ${prop('Description', 'Resistor', true)}
      (symbol "R_0_1" (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254) (type default)) (fill (type none))))
      (symbol "R_1_1"
        (pin passive line (at 0 3.81 270) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 0 -3.81 90) (length 1.27) (name "~" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27))))))
      (embedded_fonts no)))
  (symbol (lib_id "Device:R") (at 100.33 80.01 0) (unit 1) (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no) (uuid "${uuid()}")
    (property "Reference" "R1" (at 102.87 78.74 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Value" "4k7" (at 102.87 81.28 0) (effects (font (size 1.27 1.27)) (justify left)))
    (property "Footprint" "Shell_Test:R_test" (at 98.552 80.01 90) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Datasheet" "~" (at 100.33 80.01 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Description" "Resistor" (at 100.33 80.01 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (pin "1" (uuid "${uuid()}")) (pin "2" (uuid "${uuid()}"))
    (instances (project "Amp" (path "/${rootUuid}" (reference "R1") (unit 1)))))
  (sheet_instances (path "/" (page "1")))
  (embedded_fonts no))
`);
fs.writeFileSync(path.join(ampDir, 'fp-lib-table'), '(fp_lib_table\n  (version 7)\n  (lib (name "mylib")(type "KiCad")(uri "${KIPRJMOD}/mylib.pretty")(options "")(descr ""))\n)\n');
fs.writeFileSync(path.join(ampDir, 'mylib.pretty', 'R_test.kicad_mod'), `(footprint "R_test" (version 20241229) (generator "pcbnew") (generator_version "9.0") (layer "F.Cu")
  (property "Reference" "REF**" (at 0 -1.43 0) (layer "F.SilkS") (uuid "${uuid()}") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "R_test" (at 0 1.43 0) (layer "F.Fab") (uuid "${uuid()}") (effects (font (size 1 1) (thickness 0.15))))
  (attr smd)
  (fp_line (start -1.5 -0.8) (end 1.5 -0.8) (stroke (width 0.05) (type solid)) (layer "F.CrtYd") (uuid "${uuid()}"))
  (pad "1" smd roundrect (at -0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (uuid "${uuid()}"))
  (pad "2" smd roundrect (at 0.825 0) (size 0.8 0.95) (layers "F.Cu" "F.Mask" "F.Paste") (roundrect_rratio 0.25) (uuid "${uuid()}")))
`);

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function open(uid, login, size = { width: 1500, height: 900 }) {
  const ctx = await browser.newContext({ viewport: size });
  const page = await ctx.newPage();
  // the app's state, or an empty one while the page is still loading (opening another PCB loads the page again)
  await page.addInitScript(() => { window.appState = () => (window.CollabApp ? window.CollabApp.getState() : { view: '', project: { pcb: null, docs: [], allDocs: [] }, document: { docId: null, doc: null, hasDoc: false, items: [] }, viewport: {} }); });
  page.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${login} (console): ${m.text().slice(0, 300)}`); });
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}
/** "Update PCB from Schematic" on the open board: run it, read the report, close it. */
async function updateFromSchematic(page) {
  await page.mouse.move(760, 420);
  await page.keyboard.press('F8');   // Tools > Update PCB from Schematic…
  await page.waitForSelector('.kd-dialog:has-text("Update PCB from Schematic")', { timeout: 20000 });
  const ok = page.locator('.kd-dialog:has-text("Update PCB from Schematic") button:has-text("Update PCB")');
  await until(page, () => { const b = Array.from(document.querySelectorAll('.kd-dialog button')).find((x) => x.textContent.trim() === 'Update PCB'); return !!b && !b.disabled; }, null, 30000);
  const report = await page.locator('.kd-dialog:has-text("Update PCB from Schematic")').innerText();
  if (await ok.isEnabled()) await ok.click();
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.kd-dialog:has-text("Update PCB from Schematic")', { state: 'detached', timeout: 10000 }).catch(() => {});
  await page.keyboard.press('Escape');   // the new footprints ride the cursor after the dialog: put the tool down
  return report;
}

try {
  const aliceId = user('shell-alice', 'Alice Liddell', 978101), bobId = user('shell-bob', 'Bob Kahn', 978102);
  const alice = await open(aliceId, 'shell-alice');

  // ---------------------------------------------------------------- 1. a blank project is empty and opens on Home
  await alice.click('button:has-text("New project")');
  await alice.locator('.hp-modes button', { hasText: 'Blank project' }).click();
  const blurb = await alice.locator('.hp-modal').innerText();
  check('"Blank project" says what it is: an empty project, and nothing about a board by default', /empty project/i.test(blurb) && /Home tab/.test(blurb) && !/empty schematic and board/i.test(blurb), blurb.replace(/\s+/g, ' ').slice(0, 160));
  await alice.fill('.hp-modal input.hp-input', 'Rover');
  await shot(alice, '01-new-blank');
  await alice.click('.hp-modal button:has-text("Create and open")');
  await alice.waitForSelector('[data-project-home]', { timeout: 30000 });
  const pid = /\/p\/([0-9a-f-]{36})/.exec(alice.url())[1];
  let s = await app(alice);
  check('it opens on the Home tab', s.docId === 'home' && /doc=home/.test(alice.url()) && (await tabs(alice)).join() === '>Home', `${alice.url()} ${await tabs(alice)}`);
  check('it holds no schematic and no board: only the project\'s own document', s.all.length === 1 && s.all[0].type === 'project_shell', JSON.stringify(s.all.map((d) => d.path)));
  check('Home says how to start: a card each for a PCB, a part studio and an assembly', (await alice.$$eval('[data-home-create=cards] [data-create]', (els) => els.map((e) => e.dataset.create))).join() === 'pcb,part_studio,assembly');
  check('the Home tab cannot be closed, renamed or deleted (it has no menu)', await alice.evaluate(() => { const h = document.querySelector('#doctabs [data-doc-tab=home]'); h.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); return !document.querySelector('.hp-menu'); }));
  await shot(alice, '02-home-empty');

  // ---------------------------------------------------------------- 2. "+" and Home make any element, any number of times
  await alice.click('[data-home-create=cards] [data-create=pcb]');
  check('a PCB from Home: it opens on its schematic', await drawn(alice, 'kicad_sch'));
  check('the bar shows ONE tab for the PCB, with Schematic, Board and BOM inside it', (await tabs(alice)).join() === 'Home,>PCB 1' && (await views(alice, 'PCB 1')).join() === '>Schematic,Board,BOM', `${await tabs(alice)} / ${await views(alice, 'PCB 1')}`);
  s = await app(alice);
  check('it is a KiCad project in its own folder', ['PCB 1/PCB 1.kicad_pro', 'PCB 1/PCB 1.kicad_sch', 'PCB 1/PCB 1.kicad_pcb'].every((p) => s.all.some((d) => d.path === p)), JSON.stringify(s.all.map((d) => d.path)));
  check('whose editor sees that folder as the whole project', s.pcb && s.pcb.dir === 'PCB 1' && s.docs.includes('PCB 1.kicad_sch') && s.docs.includes('PCB 1.kicad_pro') && !s.docs.some((p) => p.startsWith('PCB 1/')), JSON.stringify(s.docs));
  await shot(alice, '03-pcb-schematic');

  await alice.click('[data-doc-add]');
  await shot(alice, '04-add-menu');
  check('"+" offers a PCB, a part studio, an assembly, a folder and files', (await alice.$$eval('[role=menu] [data-add]', (els) => els.map((e) => e.dataset.add))).join() === 'pcb,part_studio,assembly,folder,import,import-folder');
  await alice.click('[data-add=pcb]');
  await until(alice, () => { const s = window.appState(); return !!s.project && !!s.project.pcb && s.project.pcb.name === 'PCB 2' && s.document.hasDoc && !!document.querySelector('#doctabs [data-el-tab][aria-selected=true]'); }, null, 40000);
  check('a second PCB from "+"', (await tabs(alice)).join() === 'Home,PCB 1,>PCB 2' && (await views(alice, 'PCB 2')).join() === '>Schematic,Board,BOM', `${await tabs(alice)}`);
  check('with several PCBs, only the open one shows its views', (await views(alice, 'PCB 1')).length === 0);
  await alice.click('[data-doc-add]'); await alice.click('[data-add=part_studio]');
  await alice.waitForSelector('.cad-root[data-doc-kind=part-studio]', { timeout: 60000 });
  await alice.click('[data-doc-add]'); await alice.click('[data-add=assembly]');
  await alice.waitForSelector('.cad-root[data-doc-kind=assembly]', { timeout: 60000 });
  await alice.click('[data-doc-add]'); await alice.click('[data-add=part_studio]');
  await until(alice, () => (document.querySelector('#doctabs [data-el-tab][aria-selected=true]') || { dataset: {} }).dataset.tabName === 'Part Studio 2', null, 60000);
  check('a part studio, an assembly and a second part studio', (await tabs(alice)).join() === 'Home,PCB 1,PCB 2,Part Studio 1,>Part Studio 2,Assembly 1', `${await tabs(alice)}`);
  await shot(alice, '05-five-tabs');

  // ---------------------------------------------------------------- 3. the second person, live
  const invited = await alice.evaluate(async (pid) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'shell-bob', role: 'editor' }) })).status, pid);
  check('Bob is invited as an editor', invited === 200, `status ${invited}`);
  const bob = await open(bobId, 'shell-bob');
  await bob.goto(`${BASE}/p/${pid}/edit`);
  await bob.waitForSelector('[data-project-home]', { timeout: 30000 });
  check('Bob opens the project: Home, and the same tabs', (await tabs(bob)).join() === '>Home,PCB 1,PCB 2,Part Studio 1,Part Studio 2,Assembly 1', `${await tabs(bob)}`);
  check('Home shows him who else is here and where', await until(bob, () => { const p = document.querySelector('[data-home-person="shell-alice"] [data-home-where]'); return !!p && p.textContent === 'Part Studio 2'; }), (await bob.locator('[data-home-people]').innerText().catch(() => '')).replace(/\s+/g, ' '));
  check('and a dot on the tab she is on', await until(bob, () => (document.querySelector('#doctabs [data-el-tab][data-tab-name="Part Studio 2"] [data-tab-people]') || { dataset: {} }).dataset.tabPeople === 'shell-alice'));
  check('Alice sees Bob on Home', await until(alice, () => (document.querySelector('#doctabs [data-doc-tab=home] [data-tab-people]') || { dataset: {} }).dataset.tabPeople === 'shell-bob'));
  await shot(bob, '06-bob-home');

  // ---------------------------------------------------------------- 4. a KiCad project folder becomes a third PCB
  await alice.click('#doctabs [data-doc-tab=home]');
  await alice.waitForSelector('[data-project-home]');
  {
    const chooser = alice.waitForEvent('filechooser');
    await alice.click('[data-home-import-folder]');
    await (await chooser).setFiles(ampDir);
  }
  check('importing a KiCad project folder makes a PCB and opens its schematic', await drawn(alice, 'kicad_sch') && (await app(alice)).pcb?.name === 'Amp', JSON.stringify((await app(alice)).pcb));
  s = await app(alice);
  check('its files keep their places inside the PCB; the board it lacked was made empty beside them', ['Amp/Amp.kicad_pro', 'Amp/Amp.kicad_sch', 'Amp/Amp.kicad_pcb', 'Amp/fp-lib-table', 'Amp/mylib.pretty/R_test.kicad_mod'].every((p) => s.all.some((d) => d.path === p)) && s.all.filter((d) => d.type === 'kicad_pro').length === 3, JSON.stringify(s.all.map((d) => d.path)));
  check('the imported schematic is the one on screen', (await refs(alice)).join() === 'R1', `${await refs(alice)}`);
  check('Bob gets the new tab without reloading, and is told who made it', await until(bob, () => !!document.querySelector('#doctabs [data-el-tab][data-tab-name="Amp"]')) && /Alice Liddell added Amp/.test((await bob.textContent('[data-docs-notice]').catch(() => '')) || ''), (await bob.textContent('[data-docs-notice]').catch(() => '')) || '');
  await shot(alice, '07-amp-schematic');

  // ---------------------------------------------------------------- 5. views of a PCB; each remembers where it was
  await alice.mouse.move(700, 420); await alice.mouse.wheel(0, -600); await alice.waitForTimeout(250); await alice.mouse.wheel(0, -600); await alice.waitForTimeout(400);
  const zoomed = await alice.evaluate(() => window.appState().viewport.zoom);
  await view(alice, 'Amp', 'board');
  check('Board: the PCB\'s own board opens, in the board editor', await drawn(alice, 'kicad_pcb') && (await views(alice, 'Amp')).join() === 'Schematic,>Board,BOM' && (await app(alice)).all.find((d) => d.id === (alice.url().split('doc=')[1]))?.path === 'Amp/Amp.kicad_pcb', `${await views(alice, 'Amp')} ${alice.url()}`);
  check('the board is empty before anything is brought over', (await refs(alice)).length === 0, `${await refs(alice)}`);
  const report = await updateFromSchematic(alice);
  check('Update PCB from Schematic reads THIS PCB\'s schematic: it adds R1', /R1/.test(report) && await until(alice, () => window.appState().document.items.some((i) => i.ref === 'R1')), report.replace(/\s+/g, ' ').slice(-260));
  await shot(alice, '08-amp-board-updated');
  await view(alice, 'Amp', 'schematic');
  await drawn(alice, 'kicad_sch');
  await alice.waitForTimeout(500);
  const back = await alice.evaluate(() => window.appState().viewport.zoom);
  check('back on Schematic, the view is where it was left (zoomed in), not fitted again', Math.abs(back - zoomed) < 1e-6 && zoomed > 0, `${zoomed} → ${back}`);
  await view(alice, 'Amp', 'bom');
  await alice.waitForSelector('[data-bom-view] [data-bom-table] [data-bom-line]', { timeout: 30000 });
  const line = await alice.$eval('[data-bom-line]', (tr) => Array.from(tr.children).map((td) => td.textContent.trim()));
  check('BOM: the PCB\'s parts as a full view: references, quantity, value, footprint', line[1] === 'R1' && line[2] === '1' && line[3] === '4k7' && line[4] === 'R_test' && (await views(alice, 'Amp')).join() === 'Schematic,Board,>BOM', line.join(' | '));
  check('with its totals and the CSV export', /1 part in 1 line/.test(await alice.textContent('[data-bom-summary]')) && await alice.isEnabled('[data-bom-csv]'), await alice.textContent('[data-bom-summary]'));
  {
    const dl = alice.waitForEvent('download');
    await alice.click('[data-bom-csv]');
    const file = await (await dl).path();
    const csv = fs.readFileSync(file, 'utf8');
    check('Export CSV writes the lines', /R1/.test(csv) && /4k7/.test(csv) && /R_test/.test(csv), csv.split('\n').slice(0, 2).join(' / '));
  }
  await shot(alice, '09-amp-bom');
  await alice.fill('#bomv-boards', '10');
  check('the quantity follows the number of boards', await until(alice, () => document.querySelector('[data-bom-line] td:nth-child(3)').textContent === '10'));

  // ---------------------------------------------------------------- 6. THE POINT: PCB 2 is not Amp
  await alice.click(tab('PCB 2'));
  check('opening another PCB opens ITS schematic', await drawn(alice, 'kicad_sch') && (await app(alice)).pcb?.name === 'PCB 2' && (await refs(alice)).length === 0, JSON.stringify((await app(alice)).pcb));
  s = await app(alice);
  check('its editor sees none of Amp\'s files: no sheet, no board, no library table, no footprint', !s.docs.some((p) => /Amp|mylib|fp-lib-table/.test(p)) && s.docs.filter((p) => p.endsWith('.kicad_pro')).join() === 'PCB 2.kicad_pro', JSON.stringify(s.docs));
  await view(alice, 'PCB 2', 'board');
  await drawn(alice, 'kicad_pcb');
  check('PCB 2\'s board is untouched by the update of Amp\'s', (await refs(alice)).length === 0 && /PCB%202|PCB 2/.test((await app(alice)).all.find((d) => d.id === alice.url().split('doc=')[1])?.path || ''), `${await refs(alice)}`);
  const report2 = await updateFromSchematic(alice);
  check('and Update PCB from Schematic there reads PCB 2\'s (empty) schematic: nothing to add, no R1', !/R1/.test(report2) && (await refs(alice)).length === 0, report2.replace(/\s+/g, ' ').slice(-200));
  await view(alice, 'PCB 2', 'bom');
  await alice.waitForSelector('[data-bom-view] [data-bom-empty]', { timeout: 30000 });
  check('PCB 2\'s BOM is empty; Amp\'s line is not in it', !(await alice.$('[data-bom-line]')) && /PCB 2/.test(await alice.textContent('[data-bom-title]')));
  // the stored files say the same
  const text = async (p) => alice.evaluate(async (id) => { const r = await fetch(`/api/docs/${id}/content`); const head = Number(r.headers.get('x-head-seq')) || 0, seq = Number(r.headers.get('x-snapshot-seq')) || 0; const ops = head > seq ? await (await fetch(`/api/docs/${id}/ops?since=${seq}`)).json() : { ops: [] }; return (await r.text()) + JSON.stringify(ops.ops); }, (await app(alice)).all.find((d) => d.path === p).id);
  const ampBoard = await text('Amp/Amp.kicad_pcb'), pcb2Board = await text('PCB 2/PCB 2.kicad_pcb'), pcb1Board = await text('PCB 1/PCB 1.kicad_pcb');
  check('on the server: Amp\'s board has the footprint, PCB 1\'s and PCB 2\'s have none', /R_test/.test(ampBoard) && !/R_test|footprint/.test(pcb2Board.replace(/allow_soldermask_bridges_in_footprints/g, '')) && !/R_test/.test(pcb1Board));
  await alice.click(tab('Amp'));
  await until(alice, () => { const s = window.appState(); return !!s.project.pcb && s.project.pcb.name === 'Amp' && s.document.hasDoc; }, null, 40000);
  await view(alice, 'Amp', 'board'); await drawn(alice, 'kicad_pcb');
  check('back in Amp: its board still has R1', (await refs(alice)).join() === 'R1', `${await refs(alice)}`);

  // ---------------------------------------------------------------- 7. deep links
  s = await app(alice);
  const idOf = (p) => s.all.find((d) => d.path === p).id;
  const carol = await open(aliceId, 'shell-alice');
  await carol.goto(`${BASE}/p/${pid}/edit?doc=${idOf('PCB 1/PCB 1.kicad_pcb')}`);
  const linked = await drawn(carol, 'kicad_pcb') && await until(carol, () => !!document.querySelector('#doctabs [data-el-tab][data-tab-name="PCB 1"] [data-pcb-view=board][aria-selected=true]'));
  check('a link to a board opens that PCB on Board', linked && (await tabs(carol)).includes('>PCB 1') && (await views(carol, 'PCB 1')).join() === 'Schematic,>Board,BOM' && (await app(carol)).pcb?.name === 'PCB 1', `${linked} ${await tabs(carol)} / ${await views(carol, 'PCB 1')} / ${JSON.stringify((await app(carol)).pcb)}`);
  await carol.goto(`${BASE}/p/${pid}/edit?doc=${idOf('Amp/Amp.kicad_sch')}`);
  check('a link to a schematic opens that PCB on Schematic', await drawn(carol, 'kicad_sch') && (await views(carol, 'Amp')).join() === '>Schematic,Board,BOM' && (await refs(carol)).join() === 'R1');
  await carol.goto(`${BASE}/p/${pid}/edit`);
  check('a link to the project opens Home', await until(carol, () => !!document.querySelector('[data-project-home]')) && (await tabs(carol))[0] === '>Home');
  await carol.close();

  // ---------------------------------------------------------------- 8. the tab bar: reorder, rename, duplicate, folders, manager, keyboard
  const box = async (page, name) => page.locator(tab(name)).boundingBox();
  {
    const from = await box(alice, 'Assembly 1'), to = await box(alice, 'Amp');
    await alice.mouse.move(from.x + 20, from.y + from.height / 2); await alice.mouse.down();
    await alice.mouse.move(from.x - 40, from.y + from.height / 2, { steps: 4 }); await alice.mouse.move(to.x + 6, to.y + to.height / 2, { steps: 8 });
    await shot(alice, '10-dragging-a-tab');
    await alice.mouse.up();
  }
  check('dragging a tab moves it: the assembly is now the first tab after Home', await until(alice, () => Array.from(document.querySelectorAll('#doctabs [data-el-tab]')).map((e) => e.dataset.tabName).join() === 'Assembly 1,Amp,PCB 1,PCB 2,Part Studio 1,Part Studio 2'), `${await tabs(alice)}`);
  const order = (await tabs(alice)).map((t) => t.replace('>', ''));
  check('the order is the project\'s: Bob\'s tabs move too, without a reload', await until(bob, (want) => Array.from(document.querySelectorAll('#doctabs [data-el-tab]')).map((e) => e.dataset.tabName).join() === want, order.slice(1).join()), `${await tabs(bob)}`);
  await bob.reload(); await bob.waitForSelector('#doctabs [data-el-tab]', { timeout: 30000 });
  check('and it is still that order after a reload', await until(bob, (want) => Array.from(document.querySelectorAll('#doctabs [data-el-tab]')).map((e) => e.dataset.tabName).join() === want, order.slice(1).join()), `${await tabs(bob)}`);

  await alice.dblclick(`${tab('PCB 2')} [data-tab-label]`);
  await alice.fill("#doctabs input[aria-label='Document name']", 'Sensor');
  await alice.keyboard.press('Enter');
  check('double-click renames a PCB (one that is not open: the page stays where it is)', (await app(alice)).pcb?.name === 'Amp' && await until(alice, () => !!document.querySelector('#doctabs [data-el-tab][data-tab-name="Sensor"]')), `${await tabs(alice)}`);
  s = await app(alice);
  check('its folder and its own three files take the name', ['Sensor/Sensor.kicad_pro', 'Sensor/Sensor.kicad_sch', 'Sensor/Sensor.kicad_pcb'].every((p) => s.all.some((d) => d.path === p)) && !s.all.some((d) => d.path.startsWith('PCB 2')), JSON.stringify(s.all.map((d) => d.path).filter((p) => /Sensor|PCB 2/.test(p))));
  check('Bob sees the new name', await until(bob, () => !!document.querySelector('#doctabs [data-el-tab][data-tab-name="Sensor"]')));

  // the other domains list the boards of every PCB, by the PCB's name (now that one was renamed)
  await alice.click(tab('Assembly 1'));
  await alice.waitForSelector('.cad-root[data-doc-kind=assembly] [data-tool=Insert]', { timeout: 60000 });
  await alice.click('[data-tool=Insert]');
  await alice.waitForSelector('[data-insert-dialog]', { timeout: 30000 });
  const offered = await until(alice, () => { const t = document.querySelector('[data-insert-dialog]').innerText; return ['Amp', 'PCB 1', 'Sensor', 'Part Studio 1', 'Part Studio 2'].every((n) => t.includes(n)) && !t.includes('PCB 2'); }, null, 60000);
  check('the assembly\'s Insert lists the board of every PCB by the PCB\'s name, and the part studios', offered, (await alice.locator('[data-insert-dialog]').innerText()).replace(/\s+/g, ' ').slice(0, 300));
  await shot(alice, '11a-insert-lists-pcbs');
  await alice.keyboard.press('Escape');
  if (await alice.$('[data-insert-dialog]')) await alice.evaluate(() => window.JunctionAssembly && window.JunctionAssembly.closeInsert && window.JunctionAssembly.closeInsert());

  await alice.click(tab('Part Studio 1'), { button: 'right' });
  await shot(alice, '11-tab-menu');
  await alice.click('.hp-menu button:has-text("Duplicate")');
  check('Duplicate makes a copy beside it and opens it', await until(alice, () => (document.querySelector('#doctabs [data-el-tab][aria-selected=true]') || { dataset: {} }).dataset.tabName === 'Part Studio 1 copy', null, 60000), `${await tabs(alice)}`);
  await alice.click(tab('Amp'), { button: 'right' });
  await alice.click('.hp-menu button:has-text("Duplicate")');
  await until(alice, () => { const s = window.appState(); return !!s.project && !!s.project.pcb && s.project.pcb.name === 'Amp copy' && s.document.hasDoc; }, null, 60000);
  await view(alice, 'Amp copy', 'board'); await drawn(alice, 'kicad_pcb');
  check('a duplicated PCB is a whole copy: its board has R1 as the original had, with the edits that were not yet stored', (await refs(alice)).join() === 'R1', `${await refs(alice)}`);
  s = await app(alice);
  check('and its own library and library table came with it', ['Amp copy/Amp copy.kicad_pro', 'Amp copy/fp-lib-table', 'Amp copy/mylib.pretty/R_test.kicad_mod'].every((p) => s.all.some((d) => d.path === p)), JSON.stringify(s.all.map((d) => d.path).filter((p) => p.startsWith('Amp copy'))));

  // a folder, from "+"; tabs go into it from their menu
  await alice.click('[data-doc-add]'); await alice.click('[data-add=folder]');
  await alice.fill('[data-k=ask-name-input]', 'Enclosure'); await alice.click('[data-k=ask-name-ok]');
  await alice.click(tab('Part Studio 1'), { button: 'right' });
  await alice.click('.hp-menu button:has-text("Move to folder")');
  await alice.click('.hp-menu button:has-text("Enclosure")');
  await until(alice, () => !!document.querySelector('#doctabs [data-tab-folder="Enclosure"] [data-el-tab][data-tab-name="Part Studio 1"]'));
  await alice.click(tab('Part Studio 2'), { button: 'right' });
  await alice.click('.hp-menu button:has-text("Move to folder")');
  await alice.click('.hp-menu button:has-text("Enclosure")');
  check('tabs moved to a folder stand together behind its name in the bar', await until(alice, () => document.querySelectorAll('#doctabs [data-tab-folder="Enclosure"] [data-el-tab]').length === 2), `${await tabs(alice)}`);
  s = await app(alice);
  check('and are files in that folder', s.all.some((d) => d.path === 'Enclosure/Part Studio 1.jpart') && s.all.some((d) => d.path === 'Enclosure/Part Studio 2.jpart'));
  check('Bob\'s bar groups them too', await until(bob, () => document.querySelectorAll('#doctabs [data-tab-folder="Enclosure"] [data-el-tab]').length === 2));
  await shot(alice, '12-folder-group');

  // the tab manager
  await alice.click('[data-tab-manager]');
  await alice.waitForSelector('[data-tab-list]');
  check('the tab manager lists every tab', (await alice.$$eval('[data-tab-list] [data-list-tab]', (els) => els.length)) === (await tabs(alice)).length);
  await shot(alice, '13-tab-manager');
  await alice.keyboard.type('sens');
  check('typing narrows it', (await alice.$$eval('[data-tab-list] [data-list-tab]', (els) => els.map((e) => e.textContent))).length === 1);
  await alice.keyboard.press('Enter');
  check('Enter opens the tab found', await until(alice, () => { const s = window.appState(); return !!s.project.pcb && s.project.pcb.name === 'Sensor' && s.document.hasDoc; }, null, 40000) && !(await alice.$('[data-tab-list]')), `${await tabs(alice)}`);
  // the keyboard
  const before = (await tabs(alice)).findIndex((t) => t.startsWith('>'));
  await alice.keyboard.press('Alt+PageDown');
  check('Alt+PageDown goes to the next tab', await until(alice, (i) => Array.from(document.querySelectorAll('#doctabs [data-doc-tab=home], #doctabs [data-el-tab]')).findIndex((e) => e.getAttribute('aria-selected') === 'true') === i, before + 1, 40000), `${await tabs(alice)}`);
  await alice.keyboard.press('Alt+PageUp');
  check('Alt+PageUp goes back', await until(alice, (i) => Array.from(document.querySelectorAll('#doctabs [data-doc-tab=home], #doctabs [data-el-tab]')).findIndex((e) => e.getAttribute('aria-selected') === 'true') === i, before, 40000), `${await tabs(alice)}`);

  // ---------------------------------------------------------------- 9. Home: the tree, search, sort, rename, move, delete and undo
  await alice.click('#doctabs [data-doc-tab=home]');
  await alice.waitForSelector('[data-project-home]');
  await until(alice, () => !!document.querySelector('[data-row-modified]') && document.querySelector('[data-row-modified]').textContent !== '');
  let rows = await rowNames(alice);
  check('Home lists the folder, every element and the loose files', rows.includes('f:Enclosure') && ['Amp', 'Amp copy', 'PCB 1', 'Sensor', 'Assembly 1', 'Part Studio 1 copy'].every((n) => rows.includes('e:' + n)), rows.join(' '));
  check('each row says its kind, when it last changed and who changed it', await alice.$eval('[data-row-name="Amp"]', (r) => /PCB/.test(r.children[1].textContent) && /ago|just now/.test(r.children[2].textContent) && /Alice Liddell/.test(r.children[3].textContent)), await alice.$eval('[data-row-name="Amp"]', (r) => r.innerText.replace(/\s+/g, ' ')));
  await alice.click('[data-row-name="Amp"] [data-row-toggle]');
  rows = await rowNames(alice);
  check('a PCB opens to show its own files: schematic, board, library table, footprints', ['f:Amp.kicad_sch', 'f:Amp.kicad_pcb', 'f:fp-lib-table', 'f:mylib.pretty/R_test.kicad_mod'].every((n) => rows.includes(n)), rows.join(' '));
  await shot(alice, '14-home-tree');
  await alice.fill('[data-home-search]', 'r_test');
  check('search finds a file inside a PCB and shows where it is', await until(alice, () => { const r = Array.from(document.querySelectorAll('[data-home-rows] [data-row-id]')).map((e) => e.dataset.rowName); return r.length === 4 && r.includes('Amp') && r.includes('Amp copy'); }), (await rowNames(alice)).join(' '));
  await alice.fill('[data-home-search]', '');
  const byName = await rowNames(alice);
  rows = await rowNames(alice);
  const at = (list, n) => list.indexOf('e:' + n);
  check('sorted by name, the assembly comes before the PCBs', at(byName, 'Assembly 1') > at(byName, 'Amp copy') && at(byName, 'Assembly 1') < at(byName, 'PCB 1'), byName.join(' '));
  await alice.selectOption('[data-home-sort]', 'kind');
  rows = await rowNames(alice);
  check('sorted by kind, the PCBs come together, then the part studios, then the assemblies', at(rows, 'Sensor') < at(rows, 'Part Studio 1 copy') && at(rows, 'PCB 1') < at(rows, 'Part Studio 1 copy') && at(rows, 'Part Studio 1 copy') < at(rows, 'Assembly 1'), rows.join(' '));
  await alice.selectOption('[data-home-sort]', 'name');
  // drag a row onto the folder
  {
    const from = await alice.locator('[data-row-name="Part Studio 1 copy"]').boundingBox(), to = await alice.locator('[data-row-name="Enclosure"]').boundingBox();
    await alice.mouse.move(from.x + 200, from.y + from.height / 2); await alice.mouse.down();
    await alice.mouse.move(from.x + 210, from.y + from.height / 2 - 10, { steps: 3 }); await alice.mouse.move(to.x + 200, to.y + to.height / 2, { steps: 8 });
    await alice.mouse.up();
  }
  check('dragging a row onto a folder moves it there', await until(alice, () => (window.appState().project.allDocs || []).some((d) => d.path === 'Enclosure/Part Studio 1 copy.jpart')), JSON.stringify((await app(alice)).all.map((d) => d.path).filter((p) => /copy.jpart/.test(p))));
  // rename a file from its menu
  await alice.click('[data-row-name="Part Studio 1 copy"] [data-row-menu]');
  await alice.click('.hp-menu button:has-text("Rename")');
  await alice.fill('[data-home-rows] input[aria-label=Name]', 'Lid');
  await alice.keyboard.press('Enter');
  check('rename from the row\'s menu', await until(alice, () => !!document.querySelector('#doctabs [data-el-tab][data-tab-name="Lid"]')) && await until(bob, () => !!document.querySelector('#doctabs [data-el-tab][data-tab-name="Lid"]')));
  // delete, undo, delete
  await alice.click('[data-row-name="Amp copy"] [data-row-menu]');
  await alice.click('.hp-menu button:has-text("Delete")');
  await alice.waitForSelector('[data-k=confirm]');
  await shot(alice, '15-delete-confirm');
  await alice.click('[data-k=confirm-ok]');
  check('delete asks first, then the PCB is gone from the list and the bar', await until(alice, () => !document.querySelector('[data-row-name="Amp copy"]') && !document.querySelector('#doctabs [data-el-tab][data-tab-name="Amp copy"]')));
  await alice.click('.hp-toast button:has-text("Undo")');
  check('Undo brings it back: nothing was deleted', await until(alice, () => !!document.querySelector('[data-row-name="Amp copy"]')) && (await app(alice)).all.some((d) => d.path === 'Amp copy/Amp copy.kicad_pcb'));
  await alice.click('[data-row-name="Amp copy"] [data-row-menu]');
  await alice.click('.hp-menu button:has-text("Delete")');
  await alice.click('[data-k=confirm-ok]');
  check('deleted and left alone, it goes for everybody after a few seconds: Bob\'s tab disappears', await until(bob, () => !document.querySelector('#doctabs [data-el-tab][data-tab-name="Amp copy"]'), null, 20000));
  check('with every file of it, and nothing of the PCB it was copied from', await until(alice, () => { const d = window.appState().project.allDocs; return !d.some((x) => x.path.startsWith('Amp copy/')) && d.some((x) => x.path === 'Amp/mylib.pretty/R_test.kicad_mod'); }));
  await shot(alice, '16-home-after');

  // drop a STEP file on Home: it opens as a part studio that imports it
  await alice.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n'], 'bracket.step', { type: 'model/step' }));
    const el = document.querySelector('[data-project-home]');
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  });
  check('a STEP file dropped on Home becomes a part studio (and the file is kept in models/)', await until(alice, () => { const d = window.appState().project.allDocs; return d.some((x) => x.path === 'bracket.jpart') && d.some((x) => x.path === 'models/bracket.step'); }, null, 30000) && await until(alice, () => !!document.querySelector('#doctabs [data-el-tab][data-tab-name="bracket"]')));

  // ---------------------------------------------------------------- 10. a project from before still opens as it did
  const old = await alice.evaluate(async () => (await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Old amp', template: 'pcb' }) })).json());
  const legacy = await open(aliceId, 'shell-alice');
  await legacy.goto(`${BASE}/p/${old.projectId}/edit`);
  check('a project with KiCad\'s files at its root opens on its schematic, as it always did', await drawn(legacy, 'kicad_sch') && (await tabs(legacy)).join() === 'Home,>Old_amp' && (await views(legacy, 'Old_amp')).join() === '>Schematic,Board,BOM', `${await tabs(legacy)} ${await views(legacy, 'Old_amp')}`);
  s = await app(legacy);
  check('its editor sees the project\'s files where they are, and nothing was added to it', s.docs.join() === s.all.map((d) => d.path).join() && s.all.length === 3 && s.pcb.dir === '', JSON.stringify(s.all.map((d) => d.path)));
  await view(legacy, 'Old_amp', 'board');
  check('Board is one click away, in the same page', await drawn(legacy, 'kicad_pcb') && (await views(legacy, 'Old_amp')).join() === 'Schematic,>Board,BOM');
  await legacy.click('[data-doc-add]'); await legacy.click('[data-add=pcb]');
  await until(legacy, () => { const s = window.appState(); return !!s.project.pcb && s.project.pcb.name === 'PCB 1' && s.document.hasDoc; }, null, 40000);
  s = await app(legacy);
  check('a second PCB can be added to it: the new one in its folder, the old one untouched at the root', s.all.some((d) => d.path === 'PCB 1/PCB 1.kicad_pcb') && s.all.some((d) => d.path === 'Old_amp.kicad_pcb') && s.docs.join() === 'PCB 1.kicad_pcb,PCB 1.kicad_pro,PCB 1.kicad_sch', JSON.stringify(s.docs));
  await legacy.click(tab('Old_amp'));
  await until(legacy, () => { const s = window.appState(); return !!s.project.pcb && s.project.pcb.dir === '' && s.document.hasDoc; }, null, 40000);
  s = await app(legacy);
  check('and the old PCB\'s editor does not see the new one\'s files', !s.docs.some((p) => /PCB 1/.test(p)) && s.docs.includes('Old_amp.kicad_sch'), JSON.stringify(s.docs));
  await legacy.close();

  // ---------------------------------------------------------------- the same screens, dark and narrow
  if (SHOTS) {
    for (const [name, size, theme] of [['dark-1500', { width: 1500, height: 900 }, 'dark'], ['light-1100', { width: 1100, height: 760 }, 'light'], ['dark-1100', { width: 1100, height: 760 }, 'dark']]) {
      const p = await open(aliceId, 'shell-alice', size);
      await p.evaluate((t) => { localStorage.setItem('kui.theme', t); }, theme);
      await p.goto(`${BASE}/p/${pid}/edit`);
      await p.waitForSelector('[data-project-home]', { timeout: 30000 });
      await p.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await p.waitForTimeout(900);
      await p.screenshot({ path: `${SHOTS}/20-${name}-home.png` });
      await p.click(tab('Amp'));
      await drawn(p, 'kicad_sch'); await p.waitForTimeout(600);
      await p.screenshot({ path: `${SHOTS}/21-${name}-schematic.png` });
      await p.click(`${tab('Amp')} [data-pcb-view=bom]`);
      await p.waitForSelector('[data-bom-line]', { timeout: 30000 }); await p.waitForTimeout(300);
      await p.screenshot({ path: `${SHOTS}/22-${name}-bom.png` });
      await p.click('[data-doc-add]'); await p.waitForTimeout(200);
      await p.screenshot({ path: `${SHOTS}/23-${name}-add.png` });
      await p.close();
    }
  }
  check('no page error on the way', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('the script ran to its end', false, String(e && e.stack || e).slice(0, 600) + (errors.length ? ' | page errors: ' + Array.from(new Set(errors)).slice(0, 8).join(' | ') : ''));
} finally {
  await browser.close();
  fs.rmSync(fx, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
