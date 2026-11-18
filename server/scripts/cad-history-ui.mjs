// Browser test of the platform features for part studios, in the real app: the version history beside the
// viewport (save a version, look at an earlier one read-only, restore it), the Compare window on two versions
// (the feature diff and the 3D diff with its slider), branches (start one, switch, merge with a conflict put to
// a choice, update from main), and the thumbnail (drawn from the viewport's context, on the project page and
// over a document tab).
//
// Setup as the other *-ui.mjs scripts: a local server with KC_DEV_LOGIN=1 on a throwaway database, Playwright,
// and psql on the PATH:
//
//   DATABASE_URL=postgres://… JWT_SECRET=testsecret PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 KC_DEV_LOGIN=1 cargo run
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/cad-history-ui.mjs
//
// The part is made through the studio's own commit path (window.JunctionPartStudio.commit, the one way a part
// studio changes), not by drawing with the mouse: scripts/cad-ui.mjs covers drawing.
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
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + String(detail).slice(0, 400) : ''}`); ok ? pass++ : fail++; return ok; };
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(350); await page.screenshot({ path: `${SHOTS}/${name}.png` }); } };

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

/** The studio is loaded, the kernel is idle and every built feature has reported; with `n`, it has that many features. */
const settled = (page, n) => page.waitForFunction((n) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && !s.kernel.working && (n === null || s.features.length === n) && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, n === undefined ? null : n, { timeout: 60000 });
const studioState = (page) => page.evaluate(() => {
  const st = window.JunctionPartStudio, s = st.getState();
  return { features: s.features.map((f) => ({ id: f.id, name: f.name, type: f.featureType, depth: f.params.depth })), bodies: s.bodies.length, canEdit: s.canEdit, past: s.past ? s.past.label : null,
    status: s.features.map((f) => (s.reports[f.id] || {}).status) };
});
const commit = (page, changes) => page.evaluate((changes) => window.JunctionPartStudio.commit(changes), changes);
/** The volume of every body, from the kernel's mass-properties service. */
const volume = (page) => page.evaluate(async () => {
  const st = window.JunctionPartStudio; let v = 0;
  for (const b of st.getState().bodies) v += (await st.kernel.call('mass-properties', { body: b.id })).volume;
  return v;
});

const rect = (x0, y0, x1, y1) => ({
  p1: { type: 'point', x: x0, y: y0 }, p2: { type: 'point', x: x1, y: y0 }, p3: { type: 'point', x: x1, y: y1 }, p4: { type: 'point', x: x0, y: y1 },
  l1: { type: 'line', a: 'p1', b: 'p2' }, l2: { type: 'line', a: 'p2', b: 'p3' }, l3: { type: 'line', a: 'p3', b: 'p4' }, l4: { type: 'line', a: 'p4', b: 'p1' },
});
const sketchItem = (id, name, order, entities) => ({ id, kind: 'ADDED', typeName: 'feature', item: { id, type: 'feature', featureType: 'sketch', name, order, params: { plane: { kind: 'plane', plane: 'top' }, sketch: { version: 1, entities, constraints: {} } } } });
const extrudeItem = (id, name, order, sketch, o = {}) => ({ id, kind: 'ADDED', typeName: 'feature', item: { id, type: 'feature', featureType: 'extrude', name, order, params: { profile: { sketch, regions: null }, operation: 'new', endType: 'blind', depth: 10, flip: false, targets: [], ...o } } });
const setDepth = (id, depth) => ({ id, kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['params', 'depth'], value: depth }] });

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
const api = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (e) { /* no body */ }
  return { status: r.status, json };
}, { method, url, body });
const row = (page, name) => page.locator(`[data-history-row="version"][data-history-name="${name}"]`);

try {
  const aliceId = user('cad-hist-alice', 990021), bobId = user('cad-hist-bob', 990022);
  const alice = await open(aliceId, 'cad-hist-alice');

  // ---------------------------------------------------------------- a project with a part
  const project = await api(alice, 'POST', '/api/projects/blank', { name: `CAD history ${Date.now().toString(36)}`, template: 'pcb' });
  check('a blank project is created', project.status === 200 && !!project.json?.projectId, `status ${project.status}`);
  const pid = project.json.projectId;
  await alice.goto(`${BASE}/p/${pid}/edit`);
  await alice.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await alice.click('[data-doc-add]');
  await alice.click('[role=menuitem]:has-text("New part studio")');
  await settled(alice, 0);
  const docId = new URL(alice.url()).searchParams.get('doc');
  check('a part studio is added from the tabs', !!docId && await alice.locator('#doctabs [role=tab][aria-selected=true]').innerText() === 'Part Studio 1');

  await commit(alice, [sketchItem('sk1', 'Sketch 1', 'F', { ...rect(0, 0, 40, 20), pc: { type: 'point', x: 10, y: 10 }, c1: { type: 'circle', center: 'pc', r: 3 } }), extrudeItem('ex1', 'Extrude 1', 'V', 'sk1')]);
  await settled(alice, 2);
  const v1Volume = await volume(alice);
  check('a sketch and an extrude make the plate', Math.abs(v1Volume - (40 * 20 - Math.PI * 9) * 10) < 1e-3, v1Volume);

  // ---------------------------------------------------------------- history: save a version
  await alice.click('[data-tool="History"]');
  await alice.waitForSelector('[data-history]');
  await alice.waitForSelector('[data-history-row="run"]');
  check('the History drawer opens beside the viewport, with the edits made so far', await alice.locator('[data-history-row="now"]').getAttribute('aria-current') === 'true' && /1 edit/.test(await alice.locator('[data-history-row="run"]').first().innerText()));
  check('the History button reads as pressed', await alice.locator('[data-tool="History"]').getAttribute('aria-pressed') === 'true');
  await alice.click('[data-history-save]');
  await alice.fill('[data-history-form="save"] input', 'Plate, first cut');
  await alice.click('[data-history-form="save"] button[type=submit]');
  await row(alice, 'Plate, first cut').waitFor();
  check('a named version is saved and listed', await row(alice, 'Plate, first cut').count() === 1);
  await shot(alice, 'history-1-saved');

  // ---------------------------------------------------------------- more work: deeper, and a boss
  await commit(alice, [setDepth('ex1', 25)]);
  await commit(alice, [sketchItem('sk2', 'Boss sketch', 'k', { q1: { type: 'point', x: 30, y: 10 }, c2: { type: 'circle', center: 'q1', r: 5 } }), extrudeItem('ex2', 'Boss', 'r', 'sk2', { operation: 'add', depth: 32 })]);
  await settled(alice, 4);
  const nowVolume = await volume(alice);
  check('the plate is deepened and a boss added', Math.abs(nowVolume - ((40 * 20 - Math.PI * 9) * 25 + Math.PI * 25 * 7)) < 1e-2, nowVolume);

  // ---------------------------------------------------------------- look at the earlier version
  await row(alice, 'Plate, first cut').click();
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.past && s.features.length === 2; });
  await settled(alice, 2);
  const past = await studioState(alice);
  check('opening the version shows the part as it was: two features, depth 10', past.past === 'Plate, first cut' && past.features.length === 2 && past.features[1].depth === 10 && past.bodies === 1, JSON.stringify(past));
  check('…rebuilt by the kernel from the old document', Math.abs(await volume(alice) - v1Volume) < 1e-3);
  check('…and read-only: the feature list, the toolbar and commit all refuse', past.canEdit === false && await commit(alice, [setDepth('ex1', 99)]) === false && (await studioState(alice)).features[1].depth === 10);
  check('a banner says which version is on screen', /Viewing\s+Plate, first cut\s+· read-only/.test((await alice.locator('[data-history-banner]').innerText()).replace(/\n/g, ' ')), await alice.locator('[data-history-banner]').innerText());
  check('the feature list shows the old tree', (await alice.locator('[data-panel="features"]').innerText()).includes('Extrude 1') && !(await alice.locator('[data-panel="features"]').innerText()).includes('Boss'));
  await shot(alice, 'history-2-viewing-past');

  // ---------------------------------------------------------------- compare it with now
  await alice.click('[data-history-compare]');
  await alice.waitForSelector('[data-compare][data-compare-kind="part_studio"]');
  await alice.waitForSelector('[data-compare-state="done"]', { timeout: 90000 });
  const rows = await alice.$$eval('[data-compare] .rv-row', (els) => els.map((e) => `${e.dataset.change}:${e.querySelector('.rv-label').textContent}`));
  check('the Compare window lists the feature changes', rows.join() === 'added:Boss sketch,added:Boss,modified:Extrude 1', rows.join(' | '));
  await alice.click('[data-compare] .rv-row[data-change="modified"]');
  const props = await alice.$$eval('[data-compare] .rv-props tbody tr', (els) => els.map((e) => Array.from(e.children).map((c) => c.textContent).join('|')));
  check('…and the parameter that changed, before and after', props.join() === 'Depth|10 mm|25 mm', props.join(' ; '));
  const legend = (await alice.locator('[data-compare-legend]').innerText()).replace(/\n/g, ' ');
  const added = (40 * 20 - Math.PI * 9) * 15 + Math.PI * 25 * 7;
  check('the 3D diff measures the material added and removed', legend.includes(`Added ${(added / 1000).toFixed(2)} cm³`) && /Removed 0\.00 mm³/.test(legend), legend);
  const drawn = await alice.evaluate(() => {
    const c = document.querySelector('[data-compare] .rv-stage canvas'); const r = c.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  check('the 3D diff has a viewport of its own to draw in', drawn.w > 400 && drawn.h > 250, JSON.stringify(drawn));
  check('the footer sums it up', /3 changes: 2 added, 1 modified · .* of material added/.test(await alice.locator('#rvSummary').innerText()), await alice.locator('#rvSummary').innerText());
  await shot(alice, 'compare-1-both');
  await alice.click('[data-compare-show="before"]'); await shot(alice, 'compare-2-before');
  await alice.click('[data-compare-show="after"]'); await shot(alice, 'compare-3-after');
  const versions = await alice.$$eval('[data-compare] k-select, [data-compare] select', (els) => els.length);
  check('both sides can be chosen from the versions', versions >= 2);
  await alice.click('#rvClose');
  await alice.waitForSelector('[data-compare]', { state: 'detached' });

  // ---------------------------------------------------------------- restore it
  await alice.click('[data-history-restore]');
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return !s.past && s.features.length === 2 && s.canEdit; }, null, { timeout: 30000 });
  await settled(alice, 2);
  check('restoring makes the live document read as the version again', Math.abs(await volume(alice) - v1Volume) < 1e-3 && (await studioState(alice)).features[1].depth === 10);
  await row(alice, 'Before restoring "Plate, first cut"').waitFor({ timeout: 15000 }).catch(() => {});
  const names = await alice.$$eval('[data-history-row="version"]', (els) => els.map((e) => e.dataset.historyName));
  check('the state before the restore is kept as a version of its own', names.some((n) => /^Before restoring/.test(n)), names.join(' | '));
  // and that one can be restored in turn: the boss comes back
  await alice.locator('[data-history-row="version"]', { hasText: 'Before restoring' }).first().click();
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.past && s.features.length === 4; });
  await alice.click('[data-history-restore]');
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return !s.past && s.features.length === 4 && s.canEdit; }, null, { timeout: 30000 });
  await settled(alice, 4);
  check('a restore can itself be taken back', Math.abs(await volume(alice) - nowVolume) < 1e-2);
  const stored = await api(alice, 'GET', `/api/docs/${docId}/at/head`);
  check('the server stores the restored document (snapshot and ops)', stored.status === 200 && stored.json.file.includes('"junction":"part-studio"'));

  // ---------------------------------------------------------------- a second person, view-only
  sql(`INSERT INTO permissions (project_id, user_id, role, created_by) VALUES ('${pid}', ${bobId}, 'viewer', ${aliceId})`);
  const bob = await open(bobId, 'cad-hist-bob');
  await bob.goto(`${BASE}/p/${pid}/edit?doc=${docId}`);
  await settled(bob, 4);
  await bob.click('[data-tool="History"]');
  await row(bob, 'Plate, first cut').waitFor();
  check('a viewer sees the history but is offered no Save', await bob.locator('[data-history-save]').count() === 0);
  await row(bob, 'Plate, first cut').click();
  await bob.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.past && s.features.length === 2; });
  check('…can look at a version, and is offered Compare but not Restore', await bob.locator('[data-history-compare]').count() === 1 && await bob.locator('[data-history-restore]').count() === 0);
  await bob.click('[data-history-back]');
  await bob.waitForFunction(() => !window.JunctionPartStudio.getState().past);
  await bob.context().close();

  // ---------------------------------------------------------------- a branch
  await alice.click('[data-history-new-branch]');
  await alice.fill('[data-history-form="branch"] input', 'taller-boss');
  await Promise.all([alice.waitForURL((u) => !u.pathname.includes(pid), { timeout: 30000 }), alice.click('[data-history-form="branch"] button[type=submit]')]);
  await settled(alice, 4);
  const branchPid = new URL(alice.url()).pathname.split('/')[2], branchDoc = new URL(alice.url()).searchParams.get('doc');
  check('a branch is started and opened on the same part studio', branchPid !== pid && !!branchDoc && branchDoc !== docId && await alice.locator('#doctabs [role=tab][aria-selected=true]').innerText() === 'Part Studio 1');
  // on the branch: a taller boss, a thicker plate, and a new name
  await commit(alice, [setDepth('ex2', 45), setDepth('ex1', 30), { id: 'ex2', kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['name'], value: 'Tall boss' }] }]);
  await settled(alice, 4);
  await alice.click('[data-tool="History"]');
  await alice.waitForSelector('[data-history-branches] select');
  check('the drawer says which branch is open, with Merge and Update', await alice.locator('[data-history-branches] select').inputValue() === branchPid && await alice.locator('[data-history-merge="into_main"]').count() === 1);

  // meanwhile on main: the plate is made thicker too (the same parameter), and the hole wider (another one)
  const main = await open(aliceId, 'cad-hist-alice');
  await main.goto(`${BASE}/p/${pid}/edit?doc=${docId}`);
  await settled(main, 4);
  await commit(main, [setDepth('ex1', 28), { id: 'sk1', kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['params', 'sketch', 'entities', 'c1', 'r'], value: 4 }] }]);
  await settled(main, 4);

  // ---------------------------------------------------------------- merge, with the conflict put to a choice
  await alice.reload(); await settled(alice, 4);
  await alice.click('[data-tool="History"]');
  await alice.waitForSelector('[data-history-merge="into_main"]');
  await alice.click('[data-history-merge="into_main"]');
  await alice.waitForSelector('[data-merge-conflicts]');
  const conflicts = await alice.$$eval('[data-conflict]', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  check('the merge finds the one parameter both sides changed, and only that', conflicts.length === 1 && /Extrude 1 › depth in Part Studio 1\.jpart Branch: 30 Main: 28/.test(conflicts[0]), conflicts.join(' || '));
  await shot(alice, 'merge-1-conflict');
  await alice.click('[data-conflict] [data-side="current"] input');
  await alice.click('[data-merge-go]');
  await alice.waitForSelector('[data-merge-dialog]', { state: 'detached', timeout: 30000 });
  await main.waitForFunction(() => window.JunctionPartStudio.getState().features.some((f) => f.name === 'Tall boss'), null, { timeout: 30000 });
  await settled(main, 4);
  const merged = await main.evaluate(() => { const s = window.JunctionPartStudio.getState(); const f = (id) => s.features.find((x) => x.id === id); return { plate: f('ex1').params.depth, boss: f('ex2').params.depth, name: f('ex2').name, hole: f('sk1').params.sketch.entities.c1.r }; });
  check('main gets the branch\'s work live, keeps its own value where it was chosen, and keeps its own other edits', merged.plate === 28 && merged.boss === 45 && merged.name === 'Tall boss' && merged.hole === 4, JSON.stringify(merged));
  const mainVersions = (await api(main, 'GET', `/api/projects/${pid}/versions`)).json.versions.map((v) => v.name);
  check('main as it was before the merge is kept as a version', mainVersions.includes('Before merging "taller-boss"'), mainVersions.join(' | '));

  // ---------------------------------------------------------------- update the branch from main
  await alice.waitForSelector('[data-history-merge="from_main"]');
  await alice.click('[data-history-merge="from_main"]');
  await alice.waitForSelector('[data-merge-docs]');
  check('updating from main has no conflict left', await alice.locator('[data-conflict]').count() === 0, await alice.locator('[data-merge-dialog]').innerText());
  await alice.click('[data-merge-go]');
  await alice.waitForSelector('[data-merge-dialog]', { state: 'detached', timeout: 30000 });
  await alice.waitForFunction(() => { const f = window.JunctionPartStudio.getState().features.find((x) => x.id === 'ex1'); return f && f.params.depth === 28; }, null, { timeout: 30000 });
  await settled(alice, 4);
  const synced = await alice.evaluate(() => { const s = window.JunctionPartStudio.getState(); const f = (id) => s.features.find((x) => x.id === id); return { plate: f('ex1').params.depth, boss: f('ex2').params.depth, hole: f('sk1').params.sketch.entities.c1.r }; });
  check('the branch now reads as main: main\'s plate and hole, its own boss', synced.plate === 28 && synced.boss === 45 && synced.hole === 4, JSON.stringify(synced));
  check('both lines build the same solid', Math.abs(await volume(alice) - await volume(main)) < 1e-3);
  // back to main from the drawer
  await Promise.all([alice.waitForURL((u) => u.pathname.includes(pid), { timeout: 30000 }), alice.selectOption('[data-history-branches] select', pid)]);
  await settled(alice, 4);
  check('the branch selector goes back to main', new URL(alice.url()).searchParams.get('doc') === docId);

  // ---------------------------------------------------------------- the thumbnail
  // the studio sends its picture by itself a few seconds after the model settles; ask for it now instead of waiting
  await main.evaluate(() => window.JunctionPartStudio.thumbnail.send());
  const preview = await main.evaluate(async (docId) => { const r = await fetch(`/api/docs/${docId}/preview.svg`); return { status: r.status, text: await r.text() }; }, docId);
  check('the part studio sends a picture of itself, and the server serves it as the document\'s preview', preview.status === 200 && /<image width="960" height="600" href="data:image\/png;base64,/.test(preview.text), `status ${preview.status}`);
  if (SHOTS && preview.status === 200) fs.writeFileSync(`${SHOTS}/thumbnail.png`, Buffer.from(/base64,([^"]+)"/.exec(preview.text)[1], 'base64'));
  const pixels = await main.evaluate(async (svg) => {
    const img = new Image(); img.src = /href="([^"]+)"/.exec(svg)[1]; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; const corner = [d[0], d[1], d[2]]; let other = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - corner[0]) + Math.abs(d[i + 1] - corner[1]) + Math.abs(d[i + 2] - corner[2]) > 30) other++;
    return { share: other / (d.length / 4), corner };
  }, preview.text);
  check('the picture shows the part on the paper colour, filling a good part of the frame', pixels.share > 0.12 && pixels.share < 0.9, JSON.stringify(pixels));
  const info = await api(main, 'GET', `/api/projects/${pid}/info`);
  check('the project lists the part studio as having a preview', info.json.docs.some((d) => d.docId === docId && d.hasPreview === true));
  const projectPreview = await main.evaluate(async (pid) => (await fetch(`/api/projects/${pid}/preview.svg`)).status, pid);
  check('a project with no board picture shows the part studio\'s', projectPreview === 200, `status ${projectPreview}`);
  await main.reload(); await settled(main, 4);
  await main.hover(`#doctabs [data-doc-tab="${docId}"]`);
  await main.waitForSelector('[data-doc-thumb] img', { timeout: 10000 });
  const thumbShown = await main.evaluate(async () => { const img = document.querySelector('[data-doc-thumb] img'); try { await img.decode(); } catch (e) { /* not loaded */ } return img.naturalWidth; });
  check('hovering the tab shows the thumbnail', thumbShown > 0, `natural width ${thumbShown}`);
  await shot(main, 'thumbnail-tab');
  const page2 = await main.context().newPage();
  await page2.goto(`${BASE}/p/${pid}/about`);
  check('the project page shows the picture', await page2.locator(`img[src="/api/projects/${pid}/preview.svg"]`).count() === 1);
  await page2.waitForTimeout(500); if (SHOTS) await page2.screenshot({ path: `${SHOTS}/thumbnail-project-page.png` });

  // ---------------------------------------------------------------- from the electronics editor's History, and an assembly
  await main.click('#doctabs [data-doc-type="kicad_sch"]');
  await main.waitForFunction(() => window.CollabApp.getState().view === 'editor' && window.CollabApp.getState().document.hasDoc, null, { timeout: 30000 });
  // the point the first version pinned: the plate alone
  const firstRun = { to: (await api(main, 'GET', `/api/projects/${pid}/versions`)).json.versions.find((v) => v.name === 'Plate, first cut').docs.find((d) => d.docId === docId).seq };
  await main.evaluate((at) => window.CollabApp.dispatch({ type: 'versions', cmd: 'view', docId: at.docId, seq: at.seq }), { docId, seq: firstRun.to });
  await main.waitForFunction(() => { const st = window.JunctionPartStudio; const s = st && st.getState(); return s && s.past && s.features.length === 2; }, null, { timeout: 60000 });
  check('an edit of the part studio picked in the electronics editor\'s History opens the part studio at that point', (await studioState(main)).past === `edit ${firstRun.to}` && await main.locator('[data-history]').count() === 1);
  await main.click('[data-history-back]');
  await main.waitForFunction(() => !window.JunctionPartStudio.getState().past);

  await main.click('[data-doc-add]');
  await main.click('[role=menuitem]:has-text("New assembly")');
  await main.waitForFunction(() => window.JunctionAssembly && window.JunctionAssembly.getState().loaded, null, { timeout: 30000 });
  await main.click('[data-doc-kind="assembly"] [role=toolbar] button:has-text("History")');
  await row(main, 'Plate, first cut').waitFor({ timeout: 15000 });
  check('the assembly has the same History drawer: the project\'s versions, Save, branches', await main.locator('[data-history-save]').count() === 1 && await main.locator('[data-history-branches] select').count() === 1);
  await main.click('[data-history-save]');
  await main.fill('[data-history-form="save"] input', 'With an assembly');
  await main.click('[data-history-form="save"] button[type=submit]');
  await row(main, 'With an assembly').waitFor();
  const kept = (await api(main, 'GET', `/api/projects/${pid}/versions`)).json.versions.find((v) => v.name === 'With an assembly');
  check('a version saved there pins every document of the project, the assembly and the part studio included', kept.docs.some((d) => d.path === 'Assembly 1.jasm') && kept.docs.some((d) => d.path === 'Part Studio 1.jpart') && kept.docs.some((d) => /\.kicad_pcb$/.test(d.path)), kept.docs.map((d) => d.path).join(' '));
  await shot(main, 'assembly-history');

  // ---------------------------------------------------------------- compare, asked for where the part studio's code is not loaded yet
  const fresh = await open(aliceId, 'cad-hist-alice');
  await fresh.goto(`${BASE}/p/${pid}/edit`);
  await fresh.waitForFunction(() => window.CollabApp && window.CollabApp.getState().view === 'editor' && window.CollabApp.getState().document.hasDoc, null, { timeout: 30000 });
  check('on the schematic, the part studio\'s bundle is not on the page', await fresh.evaluate(() => !window.JunctionCompareRenderers));
  await fresh.evaluate((at) => window.CollabReview.openCompare({ docId: at.docId, a: { kind: 'at', docId: at.docId, seq: at.seq, label: 'Plate, first cut' }, b: { kind: 'at', docId: at.docId, seq: 'head', label: 'Current' } }), { docId, seq: firstRun.to });
  await fresh.waitForSelector('[data-compare][data-compare-kind="part_studio"] [data-compare-state="done"]', { timeout: 90000 });
  check('the Compare window loads it and compares the part studio from there', await fresh.locator('[data-compare] .rv-row').count() >= 3 && /Added [\d.]+ cm³/.test(await fresh.locator('[data-compare-legend]').innerText()));
  await fresh.click('#rvClose');
  await fresh.context().close();

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  check('the script ran to the end', false, e.stack || e.message);
  if (errors.length) console.log(errors.join('\n'));
}
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
