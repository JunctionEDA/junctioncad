// Browser test of the mechanical foundation in the real app: the document tabs, a part studio from "+" to a
// solid (sketch a rectangle and a circle, extrude), hover and selection by geometry name, switching to the board
// and back, reload, rename, an assembly; then two people in one part studio (edit, rename, suppress, undo), a
// sketch on a face with a Remove, the rollback bar, a feature's error state, and the server folding the edits
// into the stored .jpart.
//
// Setup as the other *-ui.mjs scripts: a local server with KC_DEV_LOGIN=1 on a throwaway database, Playwright,
// and psql on the PATH (it makes the two test users):
//
//   DATABASE_URL=postgres://… JWT_SECRET=testsecret PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 KC_DEV_LOGIN=1 cargo run
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/cad-ui.mjs
//
// Waits are on the part studio's own state (window.JunctionPartStudio.getState()), not on timers, except the
// short pauses before screenshots.  Without a GPU, Chromium draws WebGL in software (the flags below).
import crypto from 'node:crypto';
import fs from 'node:fs';
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
function user(login, githubId) {
  sql(`INSERT INTO users (github_id, login, name) VALUES (${githubId}, '${login}', '${login}') ON CONFLICT (github_id) DO NOTHING`);
  return Number(sql(`SELECT id FROM users WHERE github_id = ${githubId}`));
}

const studio = (page, fn, arg) => page.evaluate(fn, arg);
/** The part studio has `n` features, the kernel is idle, and every built feature has reported. */
const settled = (page, n) => page.waitForFunction((n) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, n, { timeout: 60000 });
const click = async (page, x, y) => { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up(); };

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function open(uid, login) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}

try {
  const aliceId = user('cad-ui-alice', 990001), bobId = user('cad-ui-bob', 990002);
  const alice = await open(aliceId, 'cad-ui-alice');

  // ---------------------------------------------------------------- tabs, and a part studio from "+"
  const project = await alice.evaluate(async () => {
    const r = await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'CAD UI test', template: 'pcb' }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  check('a blank project is created', project.status === 200 && !!project.body?.projectId, `status ${project.status}`);
  const pid = project.body.projectId;
  await alice.goto(`${BASE}/p/${pid}/edit`);
  await alice.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  // one tab per element (Home, the PCB, each part studio and assembly); the PCB's tab holds its views
  const tabs = () => alice.$$eval('#doctabs [data-doc-tab=home], #doctabs [data-el-tab]', (els) => els.map((e) => `${e.dataset.elTab ? e.dataset.tabName : 'Home'}:${e.getAttribute('aria-selected')}`));
  const pcbViews = () => alice.$$eval('#doctabs [data-el-tab][data-doc-type=pcb] [data-pcb-view]', (els) => els.map((e) => `${e.textContent.trim()}:${e.getAttribute('aria-selected')}`));
  check('the tabs list Home and the PCB; the PCB\'s tab holds the schematic, the board and the BOM', (await tabs()).join() === 'Home:false,CAD_UI_test:true' && (await pcbViews()).join() === 'Schematic:true,Board:false,BOM:false', `${(await tabs()).join(' | ')} / ${(await pcbViews()).join(' | ')}`);

  await alice.click('[data-doc-add]');
  await alice.click('text=New part studio');
  await alice.waitForSelector('.cad-root[data-doc-kind=part-studio]', { timeout: 30000 });
  await alice.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });
  check('"+" adds a part studio and opens it', (await tabs()).includes('Part Studio 1:true'), (await tabs()).join(' | '));
  check('the status bar shows the session', (await alice.evaluate(() => window.CollabApp.getState().connection.status)) === 'live');
  check('the chrome is the project\'s: its name in the menu bar, the status bar below', (await alice.textContent('#projName')) === 'CAD UI test' && await alice.isVisible('#statusbar'));
  await shot(alice, '01-empty-part-studio');

  // ---------------------------------------------------------------- sketch, extrude
  await alice.click('[data-tool=Sketch]');
  await alice.waitForSelector('.cad-dialog[data-feature=sketch]');
  await alice.click('.cad-dialog [data-accept]');
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.sketch && s.features.length === 1 && s.kernel.state === 'ready'; }, null, { timeout: 90000 });
  await alice.waitForTimeout(700);   // the camera turns to face the plane
  check('accepting the Sketch dialog opens the sketch with its tools', await alice.isVisible('[data-group=sketch] [data-tool=Rectangle]'));
  const canvas = await alice.$eval('.cad-stage canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await alice.click('[data-tool=Rectangle]');
  await click(alice, canvas.x - 150, canvas.y + 80);
  await alice.mouse.move(canvas.x + 50, canvas.y - 40, { steps: 5 });
  await shot(alice, '02-rectangle-rubber-band');
  await click(alice, canvas.x + 50, canvas.y - 40);
  const entities = (n) => alice.waitForFunction((n) => { const s = window.JunctionPartStudio.getState(); const f = s.features.find((x) => x.id === s.sketch.featureId); return Object.keys(f.params.sketch.entities).length === n; }, n, { timeout: 10000 });
  await entities(8);
  await alice.keyboard.press('c');
  await click(alice, canvas.x - 50, canvas.y + 20);
  await alice.mouse.move(canvas.x - 20, canvas.y + 20, { steps: 3 });
  await click(alice, canvas.x - 20, canvas.y + 20);
  await entities(10);
  await alice.waitForFunction(() => { const v = window.JunctionPartStudio.getState().sketches[0]; return v && v.regions.length === 1 && v.regions[0].holes.length === 1; }, null, { timeout: 20000 });
  check('a rectangle and a circle make one region with one hole', true);
  await shot(alice, '03-sketch');
  await alice.click("[data-tool='Finish sketch']");

  await alice.click('[data-tool=Extrude]');
  await alice.waitForSelector('.cad-dialog[data-feature=extrude]');
  await alice.fill('.cad-dialog input[data-param=depth]', '25');
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.bodies.length === 1 && s.kernel.state === 'ready'; }, null, { timeout: 30000 });
  check('the Extrude dialog previews the solid before it is accepted', (await studio(alice, () => window.JunctionPartStudio.getState().features.length)) === 1);
  await shot(alice, '04-extrude-preview');
  await alice.click('.cad-dialog [data-accept]');
  await settled(alice, 2);
  const model = await studio(alice, () => { const s = window.JunctionPartStudio.getState(), m = s.bodies[0].mesh; return { status: s.features.map((f) => s.reports[f.id].status).join(), faces: m.faces.names.length, top: m.bbox[5] }; });
  check('Extrude builds a solid: seven named faces, 25 mm tall', model.status === 'ok,ok' && model.faces === 7 && Math.abs(model.top - 25) < 1e-6, JSON.stringify(model));
  const mass = await studio(alice, () => window.JunctionPartStudio.kernel.call('mass-properties', { body: window.JunctionPartStudio.getState().bodies[0].id }));
  check('a worker service answers about the model', mass.volume > 0, `volume ${Math.round(mass.volume)} mm³`);
  await alice.waitForTimeout(500);
  await shot(alice, '05-solid');

  await alice.mouse.move(canvas.x, canvas.y); await alice.waitForTimeout(150);
  const hover = await studio(alice, () => window.JunctionPartStudio.getState().hover);
  check('hovering finds geometry by its name', !!hover && ['face', 'edge', 'vertex'].includes(hover.kind) && typeof hover.name === 'string', JSON.stringify(hover));
  await click(alice, canvas.x, canvas.y);
  check('a click selects it', (await studio(alice, () => window.JunctionPartStudio.getState().selection.length)) === 1);
  await shot(alice, '06-selected');
  await alice.keyboard.press('Escape');

  // ---------------------------------------------------------------- to the board and back, reload, rename, an assembly
  await alice.click('#doctabs [role=tab][data-doc-type=kicad_pcb]');
  await alice.waitForFunction(() => { const s = window.CollabApp.getState(); return s.view === 'editor' && s.document.editor === 'pcb'; }, null, { timeout: 40000 });
  check('the board tab opens the board editor in place', await alice.evaluate(() => document.getElementById('editor').classList.contains('active') && !document.getElementById('cad').classList.contains('active') && !window.JunctionPartStudio));
  await alice.waitForTimeout(800);
  await shot(alice, '07-board');
  await alice.click('#doctabs [role=tab][data-doc-type=part_studio]');
  await settled(alice, 2);
  check('back on the part studio, the model is there', (await studio(alice, () => { const s = window.JunctionPartStudio.getState(); return s.features.map((f) => f.name).join() + '/' + s.bodies.length; })) === 'Sketch 1,Extrude 1/1');
  const url = alice.url();
  check('the address names the document', /\/edit\?doc=[0-9a-f-]{36}$/.test(url), url);
  await alice.reload();
  await settled(alice, 2);
  check('a reload opens the same part studio from the server', (await studio(alice, () => window.JunctionPartStudio.getState().bodies.length)) === 1);

  await alice.dblclick('#doctabs [role=tab][data-doc-type=part_studio]');
  await alice.fill("#doctabs input[aria-label='Document name']", 'Enclosure');
  await alice.keyboard.press('Enter');
  await alice.waitForFunction(() => Array.from(document.querySelectorAll('#doctabs [role=tab]')).some((e) => e.textContent.trim() === 'Enclosure'), null, { timeout: 10000 });
  check('a tab is renamed in place', true);
  await alice.click('[data-doc-add]');
  await alice.click('text=New assembly');
  await alice.waitForFunction(() => window.JunctionAssembly && window.JunctionAssembly.getState().loaded, null, { timeout: 30000 });
  check('"+" adds an assembly and opens its editor', await alice.isVisible('.cad-root[data-doc-kind=assembly]'));
  await shot(alice, '08-assembly');
  await alice.click('#doctabs [role=tab][data-doc-type=part_studio]');
  await settled(alice, 2);

  // ---------------------------------------------------------------- two people
  const invited = await alice.evaluate(async (pid) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'cad-ui-bob', role: 'editor' }) })).status, pid);
  check('the second person is invited as an editor', invited === 200, `status ${invited}`);
  const bob = await open(bobId, 'cad-ui-bob');
  await bob.goto(url);
  await settled(bob, 2);
  check('a link to a part studio opens it for someone else', (await studio(bob, () => window.JunctionPartStudio.getState().canEdit)) === true);
  await alice.waitForFunction(() => window.JunctionPartStudio.getState().peers.length === 1, null, { timeout: 10000 }).catch(() => {});
  check('each sees the other in the session', (await studio(alice, () => window.JunctionPartStudio.getState().peers.map((p) => p.login).join())) === 'cad-ui-bob');

  await alice.dblclick('[data-feature-row][data-feature-type=extrude]');
  await alice.waitForSelector('.cad-dialog[data-feature=extrude]');
  await alice.fill('.cad-dialog input[data-param=depth]', '12');
  await alice.click('.cad-dialog [data-accept]');
  await bob.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.features[1].params.depth === 12 && s.bodies[0]?.mesh && Math.abs(s.bodies[0].mesh.bbox[5] - 12) < 1e-6; }, null, { timeout: 30000 });
  check('an edit by one person rebuilds the other\'s model', true);

  const menu = async (page, row, entry) => { await page.click(row, { button: 'right' }); await page.click(`[role=menu] >> text=${entry}`); };
  await menu(bob, '[data-feature-row][data-feature-type=extrude]', 'Rename');
  await bob.fill(".cad-features input[aria-label='Feature name']", 'Base block');
  await bob.keyboard.press('Enter');
  await alice.waitForFunction(() => window.JunctionPartStudio.getState().features[1].name === 'Base block', null, { timeout: 10000 });
  check('a rename reaches the other person', true);
  await menu(bob, '[data-feature-row][data-feature-type=extrude]', 'Suppress');
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.features[1].suppressed && s.bodies.length === 0 && s.reports[s.features[1].id]?.status === 'suppressed'; }, null, { timeout: 30000 });
  await bob.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.kernel.state === 'ready' && s.reports[s.features[1].id]?.status === 'suppressed'; }, null, { timeout: 30000 });
  check('suppressing a feature removes its body for both', (await studio(bob, () => window.JunctionPartStudio.getState().bodies.length)) === 0);
  await bob.focus('.cad-stage canvas');
  await bob.keyboard.press('Control+z');
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return !s.features[1].suppressed && s.bodies.length === 1; }, null, { timeout: 30000 });
  check('an undo is an edit everyone sees', true);

  // ---------------------------------------------------------------- a sketch on a face, Remove
  await settled(alice, 2);
  await alice.click('.v3-views [data-view=fit]');
  const top = await studio(alice, () => { const st = window.JunctionPartStudio, b = st.getState().bodies[0]; const name = b.mesh.faces.names.find((n) => n.includes(':end:')); st.select([{ kind: 'face', body: b.id, name, point: [0, 0, 0] }]); return name; });
  // with a flat face selected, Sketch needs to ask nothing: drawing starts on that face
  await alice.click('[data-tool=Sketch]');
  await alice.waitForSelector('.cad-sketch-dialog');
  const onFace = await studio(alice, () => { const s = window.JunctionPartStudio.getState(); return s.features.find((f) => f.id === s.sketch.featureId).params.plane; });
  check('a selected face is taken as the sketch plane', onFace.kind === 'face' && onFace.ref.name === top && (await alice.textContent('.cad-sketch-dialog [data-sketch-plane]')).includes('face'), top);
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.sketch && s.sketches.some((v) => v.featureId === s.sketch.featureId) && s.kernel.state === 'ready'; }, null, { timeout: 30000 });
  await alice.waitForTimeout(900);
  const frame = await studio(alice, () => { const s = window.JunctionPartStudio.getState(); return s.sketches.find((v) => v.featureId === s.sketch.featureId).frame; });
  check('the sketch lies on the top face', Math.abs(frame.origin[2] - 12) < 1e-6 && Math.abs(frame.normal[2] - 1) < 1e-6, JSON.stringify(frame));
  const px = await studio(alice, () => window.JunctionPartStudio.viewport.pixelSize());
  await alice.click('[data-tool=Circle]');
  await click(alice, canvas.x + 30, canvas.y);
  await alice.mouse.move(canvas.x + 30 + 6 / px, canvas.y, { steps: 4 });
  await click(alice, canvas.x + 30 + 6 / px, canvas.y);
  await entities(2);
  await shot(alice, '09-sketch-on-face');
  await alice.click("[data-tool='Finish sketch']");
  await alice.click('[data-tool=Extrude]');
  await alice.waitForSelector('.cad-dialog[data-feature=extrude]');
  await alice.click('.cad-dialog [data-param=operation] >> text=Remove');
  await alice.fill('.cad-dialog input[data-param=depth]', '5');
  await alice.check('.cad-dialog input[data-param=flip]');
  await alice.click('.cad-dialog [data-accept]');
  await settled(alice, 4); await settled(bob, 4);
  const cut = await studio(bob, () => { const s = window.JunctionPartStudio.getState(); return { status: s.features.map((f) => s.reports[f.id].status).join(), faces: s.bodies[0].mesh.faces.names.length, bodies: s.bodies.length }; });
  check('Remove cuts a pocket, and the other person has it too', cut.status === 'ok,ok,ok,ok' && cut.bodies === 1 && cut.faces === 9, JSON.stringify(cut));
  await alice.waitForTimeout(600);
  await shot(alice, '10-pocket');

  // ---------------------------------------------------------------- rollback, error state
  await menu(alice, '[data-feature-row][data-feature-type=extrude] >> nth=0', 'Roll back to here');
  await bob.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.rollback === 2 && s.bodies[0]?.mesh.faces.names.length === 7 && s.reports[s.features[3].id]?.status === 'rolled-back'; }, null, { timeout: 30000 });
  check('rolling back shows the model as it was, for both', await bob.isVisible('[data-rollback]'));
  await shot(alice, '11-rolled-back');
  await menu(alice, '[data-feature-row] >> nth=0', 'Roll to end');
  await alice.waitForFunction(() => window.JunctionPartStudio.getState().bodies[0]?.mesh.faces.names.length === 9, null, { timeout: 30000 });

  await menu(alice, '[data-feature-row][data-feature-type=sketch] >> nth=1', 'Delete');
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.features.length === 3 && s.reports[s.features[2].id]?.status === 'error'; }, null, { timeout: 30000 });
  // the row carries the message (its "error" mark shows it on hover and looks at the feature when clicked)
  const why = await alice.getAttribute('[data-feature-row][data-state=error]', 'data-message');
  check('a feature whose sketch is gone says so', /sketch/i.test(why || ''), why);
  await shot(alice, '12-error');
  await alice.focus('.cad-stage canvas');
  await alice.keyboard.press('Control+z');
  await settled(alice, 4);
  check('undo brings the sketch back and the error clears', (await studio(alice, () => { const s = window.JunctionPartStudio.getState(); return s.features.map((f) => s.reports[f.id].status).join(); })) === 'ok,ok,ok,ok');

  // ---------------------------------------------------------------- the stored file
  const docId = new URL(url).searchParams.get('doc');
  const stored = await alice.evaluate(async ({ pid, docId }) => {
    const a = await fetch(`/api/projects/${pid}/archive`); await a.arrayBuffer();   // reading the project folds its journals
    const r = await fetch(`/api/docs/${docId}/content?v=${Date.now()}`);
    return { archive: a.status, snap: r.headers.get('x-snapshot-seq'), head: r.headers.get('x-head-seq'), text: await r.text() };
  }, { pid, docId });
  let parsed = null; try { parsed = JSON.parse(stored.text); } catch { /* not JSON */ }
  check('the server folds the edits into the stored .jpart', stored.archive === 200 && stored.snap === stored.head && Number(stored.head) > 0 && parsed?.junction === 'part-studio' && parsed.items.filter((i) => i.type === 'feature').length === 4,
    `snapshot ${stored.snap} of ${stored.head}, ${stored.text.length} bytes`);

  check('no script errors on either page', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  console.error('the run stopped:', e);
  fail++;
} finally {
  await browser.close();
  try { sql("DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id IN (990001, 990002))"); } catch { /* left for the next run */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
