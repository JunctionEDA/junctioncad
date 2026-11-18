// Assign Footprints (KiCad's CvPcb, web/domains/pcb/dialogs/assign-footprints.ts and web/domains/pcb/dialogs/cvpcb/*) in the web editor:
// the frame and its menu bar, the top toolbar from KiCad's own config with the "Footprint Filters:" tools, the three
// panes and their keyboard, the status lines, assigning / deleting / undo / redo / cut / paste, next / previous
// unassigned, the context menu, the footprint viewer, Apply / Cancel / OK, Automatically Assign Footprints from the
// project's association file, Manage Footprint Association Files, and the Preferences dialogs the frame opens
// (Manage Footprint Libraries, Configure Paths).  One Chromium window on KiCad's pic_programmer demo.
//
// Needs a local server with KC_DEV_LOGIN=1 on a throwaway database, able to fetch the KiCad libraries
// (behind a proxy with its own certificate authority: KC_LIBS_CACHE_DIR=<dir> KC_EXTRA_CA_FILE=<bundle> on the server).
// `pg` and `playwright` are resolved from the script's node_modules or NODE_PATH.  E2E_STATIC=<server/static> serves
// the web bundles from that folder instead of the ones built into the server.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [E2E_STATIC=…] [SHOTS=/some/dir] node assign-footprints-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const pg = require('pg');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL, SHOTS = process.env.SHOTS || '', STATIC = process.env.E2E_STATIC || '';
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
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const uid = (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [9801, 'af-alice', 'Alice'])).rows[0].id;
await db.query('DELETE FROM projects WHERE owner_id = $1', [uid]);
const jwt = mintJwt(uid, 'af-alice');

// the demo, with a footprint association file the project lists (.kicad_pro cvpcb.equivalence_files)
const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'demos', 'pic_programmer');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ui-'));
for (const f of ['pic_programmer.kicad_sch', 'pic_sockets.kicad_sch', 'pic_programmer.kicad_sym', 'pic_programmer.kicad_pcb', 'sym-lib-table', 'fp-lib-table']) fs.copyFileSync(path.join(demo, f), path.join(dir, f));
const pro = JSON.parse(fs.readFileSync(path.join(demo, 'pic_programmer.kicad_pro'), 'utf8'));
pro.cvpcb = { equivalence_files: ['${KIPRJMOD}/parts.equ'] };
fs.writeFileSync(path.join(dir, 'pic_programmer.kicad_pro'), JSON.stringify(pro, null, 2));
fs.writeFileSync(path.join(dir, 'parts.equ'), "# test association file\n'22uF/25V' 'Capacitor_THT:CP_Radial_D5.0mm_P2.50mm'\n");
execSync(`cd "${dir}" && zip -qr p.zip pic_programmer.kicad_pro pic_programmer.kicad_sch pic_sockets.kicad_sch pic_programmer.kicad_sym pic_programmer.kicad_pcb sym-lib-table fp-lib-table parts.equ`);
const form = new FormData(); form.append('name', 'Assign footprints'); form.append('archive', new Blob([fs.readFileSync(path.join(dir, 'p.zip'))]), 'p.zip');
const res = await fetch(BASE + '/api/projects', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form });
const created = await res.json();
fs.rmSync(dir, { recursive: true, force: true });
const sch = created.docs && created.docs.find((d) => d.path === 'pic_programmer.kicad_sch');
check('project uploaded', res.status === 200 && !!sch, JSON.stringify(created).slice(0, 200));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: 'dark' });
const page = await ctx.newPage(); page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
if (STATIC) await serveStatic(page, STATIC);
await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=${encodeURIComponent(`/p/${created.projectId}/edit?doc=${sch.docId}`)}`);
await page.waitForFunction(() => { const E = window.CollabEditor; return E && E.kdoc && E.kdoc.items.size > 1 && E.ws && E.ws.readyState === 1; }, null, { timeout: 60000 });
await page.waitForTimeout(800);

const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const until = async (fn, ms = 60000) => { const t = Date.now(); for (;;) { if (await fn()) return true; if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 150)); } };
const text = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const status = (n = 1) => text('#cv-status' + n).then((t) => t || '');
const count = async () => Number((/: (\d+) matching footprints$/.exec(await status()) || [])[1]);
const symRows = () => page.evaluate(() => { const E = window.CollabEditor; const out = []; for (const it of E.kdoc.items.values()) if (it.kind === 'symbol') { const p = (n) => { const q = it.node.find((c) => Array.isArray(c) && c[0] === 'property' && c[1] === n); return q ? String(q[2]) : ''; }; out.push({ ref: p('Reference'), value: p('Value'), fp: p('Footprint') }); } return out; });
// a symbol row's text, scrolled into the virtual list first
const symLine = (i) => page.evaluate((i) => new Promise((r) => {
  const el = document.querySelector('#cv-syms'); const row0 = el.querySelector('.cv-row'); const hgt = row0 ? row0.getBoundingClientRect().height || 18 : 18;
  el.scrollTop = Math.max(0, i * hgt - 40); el.dispatchEvent(new Event('scroll'));
  requestAnimationFrame(() => requestAnimationFrame(() => { const row = el.querySelector(`.cv-row[data-i="${i}"]`); r(row ? row.textContent : null); }));
}), i);
const clickSym = async (i, opts) => { await symLine(i); await page.locator(`#cv-syms .cv-row[data-i="${i}"]`).click(opts); };
const selected = () => page.evaluate(() => [...document.querySelectorAll('#cv-syms .cv-row.sel')].map((e) => Number(e.dataset.i)));
const tool = (id) => `#cv-toolbar button[data-act="${id}"]`;
const pressed = (id) => page.evaluate((s) => { const b = document.querySelector(s); return !!b && b.classList.contains('on') && b.getAttribute('aria-pressed') === 'true'; }, tool(id));
const disabled = (sel) => page.evaluate((s) => { const b = document.querySelector(s); return !b || b.disabled; }, sel);
// a menu row's label: the row without its icon and its shortcut
const menuRows = () => page.evaluate(() => [...document.querySelectorAll('.se-menu .se-mi')].map((r) => { const c = r.cloneNode(true); c.querySelectorAll('svg, .k').forEach((e) => e.remove()); return c.textContent.trim(); }));
const topDialogTitle = () => page.evaluate(() => { const d = [...document.querySelectorAll('.kd-dialog')].pop(); return d ? (d.querySelector('.kd-title span, .kd-title') || {}).textContent || '' : ''; });
const openFrame = async () => {
  await page.evaluate(() => window.CollabApp.dispatch({ type: 'action', id: 'assignFootprints' }));
  await page.waitForSelector('#cvpcb');
  return until(async () => /matching footprints$/.test(await status()), 180000);
};

try {
  await page.evaluate(() => { localStorage.removeItem('kui.cvpcb'); localStorage.removeItem('kui.geom.cvpcb'); });
  // ---- the menu entry
  check('Tools > Assign Footprints... is published to the schematic menus', await page.evaluate(() => window.CollabApp.getState().tool.handled.includes('assignFootprints')));
  check('every library is loaded and listed', await openFrame(), await status());

  // ---- the frame
  const f = await page.evaluate(() => {
    const q = (s) => [...document.querySelectorAll(s)];
    const c = document.querySelector('#canvas'); const r = c ? c.getBoundingClientRect() : null;
    const hit = r ? document.elementFromPoint(r.left + 20, r.top + r.height / 2) : null;
    return {
      title: document.querySelector('#cvpcb .cv-title span')?.textContent,
      tb: q('#cv-toolbar button[data-act]').map((b) => b.dataset.act + (b.disabled ? '(off)' : '')),
      icons: q('#cv-toolbar button[data-act]').every((b) => { const s = b.querySelector('svg'); return !!s && s.innerHTML.length > 20; }),
      caps: q('#cvpcb .cv-cap').map((e) => e.textContent), menus: q('#cvpcb .se-mb').map((e) => e.textContent),
      label: document.querySelector('#cv-toolbar .cv-flabel')?.textContent, bold: +getComputedStyle(document.querySelector('#cv-toolbar .cv-flabel')).fontWeight,
      filter: !!document.querySelector('#cv-toolbar #cv-filter'), modal: hit ? !!hit.closest('.kd-overlay') : null,
      buttons: q('#cvpcb .cv-buttons button').map((b) => b.textContent),
    };
  });
  check('titled "Assign Footprints"', f.title === 'Assign Footprints', f.title);
  check("toolbar is CvPcb's, in KiCad's order, Save / Undo / Redo off at first",
    f.tb.join(',').startsWith('saveAssociationsToSchematic(off),showFootprintLibTable,showFootprintViewer,gotoPreviousNA,gotoNextNA,undo(off),redo(off),autoAssociate,deleteAll,FilterFPbyFPFilters,filterFPbyPin,FilterFPbyLibrary'), f.tb.join(','));
  check('every tool draws its icon', f.icons);
  check('menu bar is File, Edit, Preferences, Help', f.menus.join(',') === 'File,Edit,Preferences,Help', f.menus.join(','));
  check('"Footprint Filters:" (bold) and the search text are in the toolbar', f.label === 'Footprint Filters:' && f.bold >= 600 && f.filter);
  check('pane captions are KiCad\'s', f.caps.join('|') === 'Footprint Libraries|Symbol : Footprint Assignments|Filtered Footprints', f.caps.join('|'));
  check('the frame is not modal: the schematic canvas stays reachable', f.modal === false);
  check('bottom buttons are Apply, Save Schematic & Continue / Cancel / OK', f.buttons.join('|') === 'Apply, Save Schematic & Continue|Cancel|OK', f.buttons.join('|'));
  check('no filter tool is pressed at first', !(await pressed('FilterFPbyFPFilters')) && !(await pressed('filterFPbyPin')) && !(await pressed('FilterFPbyLibrary')));
  check('the unfiltered status reads "No Filtering: n matching footprints"', /^No Filtering: \d{4,} matching footprints$/.test(await status()), await status());
  const all = await count();
  check('the unfiltered list is the whole footprint set', all > 10000, String(all));
  const first = await symLine(0);
  check('symbol rows read "  1      REF -            VALUE : footprint"', /^ {2}1 +\S+ - +\S.* : /.test(first || ''), JSON.stringify(first));
  check('the first unassigned symbol is selected on open', await page.evaluate(() => { const r = document.querySelector('#cv-syms .cv-row.sel'); return !r || / : $/.test(r.textContent); }));
  await shot('01-assign-footprints');

  // ---- filters
  await page.click(tool('FilterFPbyLibrary'));
  check('Filter by library is pressed and remembered', (await pressed('FilterFPbyLibrary')) && await page.evaluate(() => (JSON.parse(localStorage.getItem('kui.cvpcb') || '{}').filter_footprint & 4) === 4));
  await page.locator('#cv-libs .cv-row', { hasText: /^Capacitor_THT$/ }).first().click();
  check('picking a library narrows the list to it', await until(async () => { const n = await count(); return n > 0 && n < all && (await status()).includes('Library (Capacitor_THT)'); }, 5000), await status());
  const inLib = await count();
  await clickSym(0);
  await page.click(tool('filterFPbyPin'));
  check('Filter by pin count shows the symbol\'s pin count', await until(async () => /Pin Count \(\d+\)/.test(await status()) && (await count()) <= inLib, 5000), await status());
  await page.click(tool('FilterFPbyFPFilters'));
  check('Use symbol footprint filters is named "Keywords" in the status bar', (await status()).startsWith('Filtered by Keywords'), await status());
  await page.click(tool('FilterFPbyFPFilters')); await page.click(tool('filterFPbyPin'));
  await page.fill('#cv-filter', 'radial d5.0mm p2.50'); await page.keyboard.press('Enter');
  check('search text filters and is named in the status bar', await until(async () => (await status()).includes('Search Text (radial d5.0mm p2.50)') && (await count()) >= 1, 5000), await status());
  await shot('02-filtered');

  // ---- assigning
  await page.locator('#cv-fps .cv-row[data-i="0"]').click();
  const fpLine = await text('#cv-fps .cv-row[data-i="0"]');
  const fpid = fpLine.trim().replace(/^\d+ /, '');
  check('footprint rows read "  1 Library:Name"', /^ {2}1 Capacitor_THT:/.test(fpLine), JSON.stringify(fpLine));
  check('status lines show the footprint\'s description and its library', (await status(2)).startsWith('Description: ') && (await status(3)) === 'Library location: ${KICAD10_FOOTPRINT_DIR}/Capacitor_THT.pretty', `${await status(2)} | ${await status(3)}`);
  // the demo assigns every symbol: clear row 5 so there is an unassigned one to move to
  await clickSym(5); await page.keyboard.press('Delete');
  check('Delete on the symbol list clears an assignment', (await symLine(5)).endsWith(' : '), String(await symLine(5)));
  await clickSym(0);
  const before0 = await symLine(0), ref0 = before0.trim().split(/\s+/)[1];
  await page.locator('#cv-fps .cv-row[data-i="0"]').dblclick();
  check('double-click assigns the footprint to the selected symbol', (await symLine(0)).endsWith(' : ' + fpid), String(await symLine(0)));
  check('and moves on to the next unassigned symbol', JSON.stringify(await selected()) === '[5]', JSON.stringify(await selected()));
  check('Save and Undo are enabled, Redo is not', !(await disabled(tool('saveAssociationsToSchematic'))) && !(await disabled(tool('undo'))) && (await disabled(tool('redo'))));
  await page.click(tool('undo'));
  check('Undo puts the old footprint back', (await symLine(0)) === before0 && (await symLine(5)).endsWith(' : '), String(await symLine(0)));
  await page.click(tool('redo'));
  check('Redo assigns it again', (await symLine(0)).endsWith(' : ' + fpid));
  await clickSym(1);
  const second = await symLine(1);
  await page.keyboard.press('Delete');
  check('Delete removes the selected assignment and keeps the others', (await symLine(1)).endsWith(' : ') && second !== (await symLine(1)), String(await symLine(1)));
  await page.keyboard.press('Control+z');
  check('Ctrl+Z undoes the delete', (await symLine(1)) === second, String(await symLine(1)));
  await page.keyboard.press('Control+y'); await page.keyboard.press('Control+z');
  check('Ctrl+Y redoes and Ctrl+Z undoes again', (await symLine(1)) === second);
  // Enter on the footprint list assigns too
  await clickSym(2);
  await page.locator('#cv-fps .cv-row[data-i="0"]').click(); await page.keyboard.press('Enter');
  check('Enter in the footprint list assigns the footprint', (await symLine(2)).endsWith(' : ' + fpid), String(await symLine(2)));
  await page.keyboard.press('Control+z');
  // copy / paste of an assignment
  await clickSym(0); await page.keyboard.press('Control+c');
  await clickSym(3); const third = await symLine(3); await page.keyboard.press('Control+v');
  check('Ctrl+C / Ctrl+V copy one symbol\'s footprint to another', (await symLine(3)).endsWith(' : ' + fpid), String(await symLine(3)));
  await page.keyboard.press('Control+z');
  check('and undo takes the paste back', (await symLine(3)) === third);
  // keyboard: arrows and shift ranges, focus cycling
  await clickSym(0); await page.keyboard.press('ArrowDown');
  check('ArrowDown moves the symbol selection', JSON.stringify(await selected()) === '[1]', JSON.stringify(await selected()));
  await clickSym(3, { modifiers: ['Shift'] });
  check('Shift-click selects a range', JSON.stringify(await selected()) === '[1,2,3]', JSON.stringify(await selected()));
  await clickSym(1);
  await page.keyboard.press('Tab');
  check('Tab moves the focus to the footprint list', await page.evaluate(() => document.querySelector('[data-pane=fp]').classList.contains('cv-focus')));
  await page.keyboard.press('Tab');
  check('Tab again cycles to the libraries', await page.evaluate(() => document.querySelector('[data-pane=lib]').classList.contains('cv-focus')));
  await page.keyboard.press('Shift+Tab');
  check('Shift+Tab goes back', await page.evaluate(() => document.querySelector('[data-pane=fp]').classList.contains('cv-focus')));
  // next / previous unassigned (row 5 is the one without a footprint)
  await clickSym(0); await page.click(tool('gotoNextNA'));
  check('next unassigned selects the next symbol without a footprint', JSON.stringify(await selected()) === '[5]', JSON.stringify(await selected()));
  await clickSym(9); await page.click(tool('gotoPreviousNA'));
  check('previous unassigned selects the one before', JSON.stringify(await selected()) === '[5]', JSON.stringify(await selected()));
  await page.click(tool('gotoPreviousNA'));
  check('with none before it the selection stays', JSON.stringify(await selected()) === '[5]', JSON.stringify(await selected()));

  // ---- context menu
  await clickSym(2, { button: 'right' });
  const ctxm = await menuRows();
  check('the symbol context menu is View Selected Footprint, Cut, Copy, Paste, Delete Footprint Assignment', ctxm.length === 5 && /View Selected Footprint/.test(ctxm[0]) && /Delete Footprint Assignment/.test(ctxm[4]), ctxm.join('|'));
  await page.keyboard.press('Escape');
  check('Escape closes only the menu', await page.evaluate(() => !document.querySelector('.se-menu') && !!document.querySelector('#cvpcb')));

  // ---- view selected footprint
  await clickSym(0);
  await page.click(tool('showFootprintViewer'));
  check('View Selected Footprint opens the footprint viewer window', await until(() => page.evaluate(() => { const c = document.querySelector('#cv-fpviewer #cv-fpcanvas'); return !!c && c.width > 50; }), 15000));
  check('the viewer names the footprint\'s library', await until(async () => ((await text('#cv-fplib')) || '').length > 0, 5000), String(await text('#cv-fplib')));
  check('the viewer has its toolbars', await page.evaluate(() => document.querySelectorAll('#cv-fptb [data-act], #cv-fptbl [data-act]').length > 5));
  await shot('03-view-footprint');
  await page.click('#cv-fpviewer .cv-title .cv-x');
  check('its close box closes the viewer and Assign Footprints stays', await until(() => page.evaluate(() => !document.querySelector('#cv-fpviewer') && !!document.querySelector('#cvpcb')), 3000));

  // ---- menus
  await page.click('#cvpcb .se-mb[data-menu="Edit"]');
  check('Edit menu lists Undo, Redo, Cut, Copy, Paste', (await menuRows()).join(',') === 'Undo,Redo,Cut,Copy,Paste', (await menuRows()).join('|'));
  await page.keyboard.press('Escape');
  await page.click('#cvpcb .se-mb[data-menu="Preferences"]');
  check('Preferences menu has CvPcb\'s entries', (await menuRows()).join('|') === 'Configure Paths...|Manage Footprint Libraries...|Manage Footprint Association Files...|Preferences...|Set Language', (await menuRows()).join('|'));
  await page.keyboard.press('Escape');
  await page.click('#cvpcb .se-mb[data-menu="File"]');
  check('File menu has Save to Schematic and Close', (await menuRows()).join('|') === 'Save to Schematic|Close', (await menuRows()).join('|'));
  await page.keyboard.press('Escape');

  // ---- saving
  await page.click('#cv-apply');
  check('Apply, Save Schematic & Continue writes the Footprint field', await until(async () => (await symRows()).some((r) => r.ref === ref0 && r.fp === fpid), 8000), JSON.stringify((await symRows()).find((r) => r.ref === ref0)));
  check('and keeps the frame open with Save disabled', await until(async () => !!(await page.$('#cvpcb')) && await disabled(tool('saveAssociationsToSchematic')), 5000),
    JSON.stringify(await page.evaluate(() => ({ frame: !!document.querySelector('#cvpcb'), save: document.querySelector('#cv-toolbar button[data-act="saveAssociationsToSchematic"]')?.disabled }))));

  // ---- automatic assignment from the project's association file
  const target = (await symRows()).find((r) => r.value === '22uF/25V');
  if (target) {
    let at = -1; for (let i = 0; i < 200; i++) { const l = await symLine(i); if (l === null) break; if (l.trim().split(/\s+/)[1] === target.ref) { at = i; break; } }
    await clickSym(at); await page.keyboard.press('Delete');
    check('the 22uF/25V capacitor has no footprint before', (await symLine(at)).endsWith(' : '), String(await symLine(at)));
    await page.click(tool('autoAssociate'));
    check('Automatically Assign Footprints reads the project\'s .equ file', await until(async () => ((await symLine(at)) || '').endsWith(' : Capacitor_THT:CP_Radial_D5.0mm_P2.50mm'), 8000), String(await symLine(at)));
    check('and reports the equivalences found', (await status()) === '1 footprint/symbol equivalences found.', await status());
  } else check('the demo has a 22uF/25V part for the association test', false);
  await page.click('#cvpcb .se-mb[data-menu="Preferences"]');
  await page.locator('.se-menu .se-mi', { hasText: 'Manage Footprint Association Files' }).click();
  check('Manage Footprint Association Files lists the project\'s file', await until(async () => ((await text('#cv-equ-list')) || '').includes('parts.equ'), 5000), String(await text('#cv-equ-list')));
  check('and shows the path substitutions', await page.evaluate(() => (document.querySelector('#cv-equ-vars') || {}).textContent?.includes('KIPRJMOD')));
  await shot('04-association-files');
  await page.keyboard.press('Escape');

  // ---- Cancel with changes asks, Discard closes
  await page.click('#cv-cancel');
  check('Cancel with unsaved changes asks to save', await until(async () => (await text('#cv-ask-text')) === 'Symbol to Footprint links have been modified. Save changes?', 3000), String(await text('#cv-ask-text')));
  await page.click('.cv-ask button[data-btn="2"]');
  check('Cancel in the question keeps the frame', await page.evaluate(() => !!document.querySelector('#cvpcb') && !document.querySelector('.cv-ask')));
  await page.click('#cv-cancel'); await page.click('.cv-ask button[data-btn="1"]');
  check('Discard Changes closes the frame', await until(() => page.evaluate(() => !document.querySelector('#cvpcb')), 3000));
  check('discarded assignments are not written', !(await symRows()).some((r) => r.value === '22uF/25V' && r.fp === 'Capacitor_THT:CP_Radial_D5.0mm_P2.50mm'));

  // ---- OK writes and closes
  await openFrame();
  const line4 = await symLine(4), ref4 = line4.trim().split(/\s+/)[1], fp4 = (await symRows()).find((r) => r.ref === ref4).fp;
  await clickSym(4);
  await page.fill('#cv-filter', ''); await page.keyboard.press('Enter');
  check('the search text is cleared and the library filter is kept on reopening', await until(async () => /^Filtered by Library: \d+ matching footprints$/.test(await status()), 5000), await status());
  await page.locator('#cv-libs .cv-row', { hasText: /^Capacitor_THT$/ }).first().click();
  await until(async () => (await status()).includes('Library (Capacitor_THT)'), 5000);
  await clickSym(4);
  // the list shows the symbol's own footprint selected (CVPCB_MAINFRAME::OnSelectComponent); take another one in view
  check('the footprint list selects the symbol\'s current footprint', await page.evaluate((fp) => { const r = document.querySelector('#cv-fps .cv-row.sel'); return !!r && r.textContent.trim().replace(/^\d+ /, '') === fp; }, fp4), fp4);
  await page.locator('#cv-fps .cv-row:not(.sel)').nth(1).click(); await page.keyboard.press('Enter');
  const want = (await symLine(4)).split(' : ')[1];
  check('a different footprint is assigned in the frame', !!want && want !== fp4, `${fp4} -> ${want}`);
  await page.click('#cv-ok');
  check('OK writes the assignment and closes the frame', await until(async () => !(await page.$('#cvpcb')) && (await symRows()).some((r) => r.ref === ref4 && r.fp === want), 8000), JSON.stringify((await symRows()).find((r) => r.ref === ref4)));
  await page.locator('#canvas').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Control+z');
  check('one schematic undo takes the OK back', await until(async () => (await symRows()).some((r) => r.ref === ref4 && r.fp === fp4), 5000), JSON.stringify((await symRows()).find((r) => r.ref === ref4)));

  // ---- Manage Footprint Libraries, Configure Paths (the frame's Preferences entries, and the editor's actions)
  await openFrame();
  await page.click(tool('showFootprintLibTable'));
  check('Manage Footprint Libraries opens on the footprint tables', await until(async () => /Footprint Libraries/.test(await topDialogTitle()), 5000), await topDialogTitle());
  check('with the library table columns', await page.evaluate(() => { const d = [...document.querySelectorAll('.kd-dialog')].pop(); const t = [...d.querySelectorAll('th')].map((x) => x.textContent).join('|'); return t.includes('Nickname') && t.includes('Library Path'); }));
  await shot('05-footprint-libraries');
  await page.keyboard.press('Escape');
  await page.click('#cvpcb .se-mb[data-menu="Preferences"]');
  await page.locator('.se-menu .se-mi', { hasText: 'Configure Paths' }).click();
  check('Configure Paths lists the environment variables', await until(async () => /Configure Paths/.test(await topDialogTitle()), 5000) && await page.evaluate(() => { const d = [...document.querySelectorAll('.kd-dialog')].pop(); return d.textContent.includes('KICAD10_FOOTPRINT_DIR') && d.textContent.includes('Environment Variables'); }));
  await shot('06-configure-paths');
  await page.keyboard.press('Escape');
  await page.locator('#cvpcb').click({ position: { x: 300, y: 12 } });
  await page.keyboard.press('Escape');
  check('Escape closes an unchanged frame without asking', await until(() => page.evaluate(() => !document.querySelector('#cvpcb') && !document.querySelector('.cv-ask')), 3000));
  check('the library and path handlers are published to the menus', await page.evaluate(() => { const h = window.CollabApp.getState().tool.handled; return ['configurePaths', 'showFootprintLibTable', 'showSymbolLibTable'].every((i) => h.includes(i)); }));
  await page.evaluate(() => window.CollabApp.dispatch({ type: 'action', id: 'showSymbolLibTable' }));
  check('Manage Symbol Libraries opens', await until(async () => /Symbol Libraries/.test(await topDialogTitle()), 5000), await topDialogTitle());
  await page.keyboard.press('Escape');
} catch (e) {
  check('run completed', false, String(e.message).split('\n').slice(0, 4).join(' / '));
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'failure.png') });
}
check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close(); await db.query('DELETE FROM projects WHERE owner_id = $1', [uid]); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/** Serve /static/** and the app page from a local static folder (the server inlines dist/boot.js into the page). */
async function serveStatic(page, root) {
  const types = { '.css': 'text/css', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.png': 'image/png', '.woff2': 'font/woff2' };
  await page.route('**/static/**', (route) => {
    const f = path.join(root, new URL(route.request().url()).pathname.replace(/^\/static/, ''));
    if (!f.startsWith(root) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return route.continue();
    route.fulfill({ body: fs.readFileSync(f), contentType: types[path.extname(f)] || 'application/javascript; charset=utf-8' });
  });
  let html = fs.readFileSync(path.join(root, 'app.html'), 'utf8');
  const boot = path.join(root, 'dist', 'boot.js');
  if (html.includes('/*BOOT*/') && fs.existsSync(boot)) html = html.replace('/*BOOT*/', 'window.__kcAssetV="e2e";' + fs.readFileSync(boot, 'utf8').trimEnd());
  await page.route((u) => /^\/p\//.test(new URL(u).pathname), (r) => (r.request().resourceType() === 'document' ? r.fulfill({ body: html, contentType: 'text/html; charset=utf-8' }) : r.continue()));
}
