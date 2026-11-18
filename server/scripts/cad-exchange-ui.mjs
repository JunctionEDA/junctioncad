// Browser test of the part studio's import and export in the real app: a STEP assembly opened from the document
// tabs ("+" › Open STEP file…) becomes a part studio with named parts; the Export dialog downloads STEP, STL, 3MF
// and GLB files (checked byte by byte); a sketch and a flat face come out as DXF and SVG; the Import tool brings
// the exported STEP back as a feature beside an extrusion; a second person, and a reload, see the imported parts.
//
// Setup as cad-ui.mjs (a local server with KC_DEV_LOGIN=1 on a throwaway database, Playwright, psql):
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=… [E2E_BASE=http://127.0.0.1:8109] [SHOTS=/some/dir] node scripts/cad-exchange-ui.mjs
//
// The STEP assembly is the demos' USB connector (demos/cm5_minima/CM5IO.3dshapes/USB3stacked.STEP, 4.4 MB, 22 solids).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const ASSEMBLY = path.join(here, '..', '..', 'demos', 'cm5_minima', 'CM5IO.3dshapes', 'USB3stacked.STEP');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-exchange-'));

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
const settled = (page, n, timeout = 120000) => page.waitForFunction((n) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, n, { timeout });
const click = async (page, x, y) => { await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.up(); };

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function open(uid, login) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}

/** Open the Export dialog, set it up with `setup`, press Export, and return the downloaded file. */
async function exportFile(page, setup, label) {
  await page.click('[data-tool=Export]');
  await page.waitForSelector('[data-export-dialog]');
  await setup();
  await page.waitForTimeout(100);
  if (label) await shot(page, label);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('.kd-dialog .kd-foot button.primary')]);
  const file = path.join(tmp, dl.suggestedFilename());
  await dl.saveAs(file);
  await page.waitForSelector('[data-export-dialog]', { state: 'detached', timeout: 10000 });
  return { name: dl.suggestedFilename(), data: fs.readFileSync(file), file };
}

try {
  const aliceId = user('cad-x-alice', 990701), bobId = user('cad-x-bob', 990702);
  const alice = await open(aliceId, 'cad-x-alice');
  const project = await alice.evaluate(async () => {
    const r = await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'CAD exchange test', template: 'pcb' }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  check('a blank project is created', project.status === 200 && !!project.body?.projectId, `status ${project.status}`);
  const pid = project.body.projectId;
  await alice.goto(`${BASE}/p/${pid}/edit`);
  await alice.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });

  // ---------------------------------------------------------------- a STEP file opened as a document
  await alice.click('[data-doc-add]');
  await shot(alice, '01-plus-menu');
  const [chooser] = await Promise.all([alice.waitForEvent('filechooser'), alice.click('text=Open STEP file…')]);
  const t0 = Date.now();
  await chooser.setFiles(ASSEMBLY);
  await alice.waitForSelector('.cad-root[data-doc-kind=part-studio]', { timeout: 60000 });
  await settled(alice, 1, 180000);
  const opened = await studio(alice, () => { const s = window.JunctionPartStudio.getState(); return { status: s.reports[s.features[0].id].status, ms: s.reports[s.features[0].id].ms, type: s.features[0].featureType, name: s.features[0].name, bodies: s.bodies.map((b) => b.name), meshed: s.bodies.every((b) => b.mesh && b.mesh.indices.length) }; });
  const tabs = await alice.$$eval('#doctabs [role=tab]', (els) => els.map((e) => `${e.textContent.trim()}:${e.getAttribute('aria-selected')}`));
  check('"+" › Open STEP file… makes a part studio named after the file and opens it', tabs.includes('USB3stacked:true'), tabs.join(' | '));
  check('it holds one Import feature that built every solid of the assembly', opened.type === 'import' && opened.status === 'ok' && opened.bodies.length === 22 && opened.meshed, JSON.stringify({ ...opened, bodies: opened.bodies.length }));
  check('the parts are named after the assembly\'s products', opened.bodies.includes('USB30-DOUBLE-SHELL.stp.STEP') && opened.bodies.includes('USB30-DOUBLE-HOUSING.stp.STEP'), opened.bodies.slice(0, 4).join(', '));
  console.log(`      (4.4 MB STEP: upload + open + read + tessellate ${((Date.now() - t0) / 1000).toFixed(1)} s, of which the import feature ${(opened.ms / 1000).toFixed(1)} s)`);
  const stored = await alice.evaluate(async (pid) => (await (await fetch(`/api/projects/${pid}/info`)).json()).docs.map((d) => `${d.path}:${d.docType}`), pid);
  check('the STEP file is stored with the project, beside the part studio', stored.includes('models/USB3stacked.STEP:model3d') && stored.includes('USB3stacked.jpart:part_studio'), stored.join(' | '));
  await alice.waitForTimeout(600);
  await shot(alice, '02-step-opened');

  // ---------------------------------------------------------------- Export: STEP, with names
  const step = await exportFile(alice, async () => {
    await alice.selectOption('[data-param=format]', 'step');
    await alice.click('[data-param=schema] >> text=AP242');
  }, '03-export-step-dialog');
  const stepText = step.data.toString('latin1');
  check('Export › STEP downloads a STEP file named after the document', step.name === 'USB3stacked.step' && stepText.startsWith('ISO-10303-21;'), `${step.name}, ${step.data.length} bytes`);
  check('the STEP file is AP242 with one named product per part', /AP242_MANAGED_MODEL_BASED_3D_ENGINEERING/.test(stepText) && (stepText.match(/PRODUCT\('USB30-DOUBLE-SHELL\.stp\.STEP'/g) || []).length === 1 && (stepText.match(/=\s*PRODUCT\(/g) || []).length === 22, `${(stepText.match(/=\s*PRODUCT\(/g) || []).length} products`);

  // ---------------------------------------------------------------- Export: STL of two selected parts, 3MF, GLB
  const two = await studio(alice, () => { const s = window.JunctionPartStudio.getState(); return [s.bodies[0], s.bodies[1]].map((b) => ({ id: b.id, name: b.name })); });
  await studio(alice, (two) => window.JunctionPartStudio.select(two.map((b) => ({ kind: 'face', body: b.id, name: window.JunctionPartStudio.getState().bodies.find((x) => x.id === b.id).mesh.faces.names[0], point: [0, 0, 0] }))), two);
  let checked = -1;
  const stl = await exportFile(alice, async () => {
    checked = await alice.$$eval('[data-param=bodies] [data-body] input:checked', (els) => els.length);
    await alice.selectOption('[data-param=format]', 'stl');
    await alice.click('[data-param=resolution] >> text=Coarse');
    await alice.click('[data-param=encoding] >> text=Binary');
  }, '04-export-stl-dialog');
  const tris = stl.data.length >= 84 ? stl.data.readUInt32LE(80) : -1;
  check('Export › STL of the selected parts downloads a binary STL', stl.data.length === 84 + 50 * tris && tris > 100, `${stl.name}, ${tris} triangles, ${stl.data.length} bytes`);
  check('the dialog starts from the selection: the two selected parts are the ones ticked', checked === 2, `${checked} ticked`);
  await studio(alice, () => window.JunctionPartStudio.select([]));
  const fine = await exportFile(alice, async () => {
    await alice.selectOption('[data-param=format]', 'stl');
    await alice.click('[data-param=resolution] >> text=Custom');
    await alice.fill('[data-param=deflection]', '0.01');
    await alice.fill('[data-param=angle]', '5');
  });
  check('a finer resolution gives more triangles (all parts)', fine.data.readUInt32LE(80) > tris, `${fine.data.readUInt32LE(80)} > ${tris}`);
  const mf = await exportFile(alice, async () => { await alice.selectOption('[data-param=format]', '3mf'); await alice.click('[data-param=resolution] >> text=Medium'); });
  check('Export › 3MF downloads a ZIP package', mf.name.endsWith('.3mf') && mf.data.subarray(0, 2).toString() === 'PK' && mf.data.includes(Buffer.from('3D/3dmodel.model')), `${mf.data.length} bytes`);
  const glb = await exportFile(alice, async () => { await alice.selectOption('[data-param=format]', 'glb'); });
  const json = glb.data.length > 20 ? JSON.parse(glb.data.subarray(20, 20 + glb.data.readUInt32LE(12)).toString()) : null;
  check('Export › glTF downloads a GLB with a mesh per part', glb.data.readUInt32LE(0) === 0x46546c67 && json && json.meshes.length === 22, `${glb.data.length} bytes`);

  // ---------------------------------------------------------------- a new part studio: sketch, extrude, DXF / SVG
  await alice.click('[data-doc-add]');
  await alice.click('text=New part studio');
  await alice.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded && window.JunctionPartStudio.getState().features.length === 0, null, { timeout: 30000 });
  await alice.click('[data-tool=Sketch]');
  await alice.waitForSelector('.cad-dialog[data-feature=sketch]');
  await alice.click('.cad-dialog [data-accept]');
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return s.sketch && s.features.length === 1 && s.kernel.state === 'ready'; }, null, { timeout: 90000 });
  await alice.waitForTimeout(700);
  const canvas = await alice.$eval('.cad-stage canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await alice.click('[data-tool=Rectangle]');
  await click(alice, canvas.x - 150, canvas.y + 80);
  await alice.mouse.move(canvas.x + 50, canvas.y - 40, { steps: 5 });
  await click(alice, canvas.x + 50, canvas.y - 40);
  await alice.keyboard.press('c');
  await click(alice, canvas.x - 50, canvas.y + 20);
  await alice.mouse.move(canvas.x - 20, canvas.y + 20, { steps: 3 });
  await click(alice, canvas.x - 20, canvas.y + 20);
  await alice.waitForFunction(() => { const v = window.JunctionPartStudio.getState().sketches[0]; return v && v.regions.length === 1 && v.regions[0].holes.length === 1; }, null, { timeout: 20000 });
  await alice.click("[data-tool='Finish sketch']");
  await alice.click('[data-tool=Extrude]');
  await alice.waitForSelector('.cad-dialog[data-feature=extrude]');
  await alice.fill('.cad-dialog input[data-param=depth]', '6');
  await alice.click('.cad-dialog [data-accept]');
  await settled(alice, 2);
  const sketchSize = await studio(alice, () => { const s = window.JunctionPartStudio.getState(); return s.bodies[0].mesh.bbox; });
  const dxf = await exportFile(alice, async () => {
    await alice.selectOption('[data-param=format]', 'dxf');
    const sk = await studio(alice, () => window.JunctionPartStudio.getState().features[0].id);
    await alice.selectOption('[data-param=source]', sk);
  }, '05-export-dxf-dialog');
  const dxfText = dxf.data.toString();
  check('Export › DXF of the sketch: four lines and a circle', dxf.name.endsWith('.dxf') && (dxfText.match(/\n0\nLINE\n/g) || []).length === 4 && (dxfText.match(/\n0\nCIRCLE\n/g) || []).length === 1 && /\n0\nEOF\n$/.test(dxfText), dxf.name);
  // the top face of the solid, selected, as SVG
  const top = await studio(alice, () => { const s = window.JunctionPartStudio.getState(), b = s.bodies[0]; return { body: b.id, name: b.mesh.faces.names.find((n) => /:end:/.test(n)) }; });
  await studio(alice, (top) => window.JunctionPartStudio.select([{ kind: 'face', body: top.body, name: top.name, point: [0, 0, 0] }]), top);
  const svg = await exportFile(alice, async () => {
    const src = await alice.$eval('[data-param=source]', (e) => e.value);
    if (src !== 'face') throw new Error(`the dialog did not start from the selected face (${src})`);
    await alice.selectOption('[data-param=format]', 'svg');
  }, '06-export-svg-face');
  const svgText = svg.data.toString();
  const w = Number((/width="([\d.]+)mm"/.exec(svgText) || [])[1]);
  check('Export › SVG of a selected flat face: its outline at true size, with the hole', /<circle /.test(svgText) && (svgText.match(/<line /g) || []).length === 4 && Math.abs(w - 2 - (sketchSize[3] - sketchSize[0])) < 0.01, `width ${w} mm`);

  // ---------------------------------------------------------------- Import: the exported STEP back, as a base for a cut
  await studio(alice, () => window.JunctionPartStudio.select([]));
  const before = await studio(alice, () => window.JunctionPartStudio.getState().bodies.length);
  const [chooser2] = await Promise.all([alice.waitForEvent('filechooser'), alice.click('[data-tool=Import]')]);
  await chooser2.setFiles(step.file);
  await settled(alice, 3, 180000);
  const imported = await studio(alice, () => { const s = window.JunctionPartStudio.getState(), f = s.features[2]; return { type: f.featureType, name: f.name, status: s.reports[f.id].status, message: s.reports[f.id].message || '', bodies: s.bodies.length, file: f.params.file }; });
  check('the Import tool stores the file and adds an Import feature', imported.type === 'import' && imported.status === 'ok' && imported.file && /^models\//.test(imported.file.path), JSON.stringify(imported));
  check('the exported STEP comes back with every part, named', imported.bodies === before + 22, `${imported.bodies} bodies`);
  await alice.waitForTimeout(500);
  await shot(alice, '07-imported-beside-extrude');

  // ---------------------------------------------------------------- someone else sees the imported parts, after a reload too
  const url = alice.url();
  const invited = await alice.evaluate(async (pid) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'cad-x-bob', role: 'editor' }) })).status, pid);
  check('a second person is invited', invited === 200, `status ${invited}`);
  const bob = await open(bobId, 'cad-x-bob');
  const tBob = Date.now();
  await bob.goto(url);
  await settled(bob, 3, 180000);
  const coldMs = Date.now() - tBob;
  const seen = await studio(bob, () => window.JunctionPartStudio.getState().bodies.length);
  check('a collaborator opening the part studio builds the same imported parts from the stored file', seen === imported.bodies, `${seen} bodies`);
  // Alice's browser has read the file: a reload takes the bodies from the B-rep it kept and does not download the file again
  const fetched = [];
  alice.context().on('request', (r) => { if (r.url().includes(`/api/docs/${imported.file.docId}/content`)) fetched.push(r.url()); });
  const tAlice = Date.now();
  await alice.reload();
  await settled(alice, 3, 180000);
  const warmMs = Date.now() - tAlice;
  const again = await studio(alice, () => { const s = window.JunctionPartStudio.getState(), f = s.features[2]; return { bodies: s.bodies.length, names: s.bodies.map((b) => b.name).join('|'), ms: s.reports[f.id].ms, faces: s.bodies.reduce((n, b) => n + b.mesh.faces.names.length, 0) }; });
  const first = await studio(bob, () => { const s = window.JunctionPartStudio.getState(), f = s.features[2]; return { names: s.bodies.map((b) => b.name).join('|'), ms: s.reports[f.id].ms, faces: s.bodies.reduce((n, b) => n + b.mesh.faces.names.length, 0) }; });
  check('a reload rebuilds them too', again.bodies === imported.bodies);
  check('…from the B-rep kept in the browser: the file is not downloaded again, and the parts and faces are the same', fetched.length === 0 && again.names === first.names && again.faces === first.faces, `${fetched.length} downloads; ${again.faces} faces against ${first.faces}`);
  console.log(`      (4.4 MB STEP, 22 parts: the import feature ${(first.ms / 1000).toFixed(1)} s reading the file in a browser that never had it, ${(again.ms / 1000).toFixed(1)} s from the kept B-rep; page load to model on screen ${(coldMs / 1000).toFixed(1)} s and ${(warmMs / 1000).toFixed(1)} s)`);
  await shot(bob, '08-bob-sees-import');

  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
