// Browser test of assemblies in the real app: insert parts from two part studios, fix one, hinge a lid on a box
// with a Revolute mate picked in the viewport, limits, dragging within them, the manipulator, the instance tree
// (rename, hide, suppress, group, replace, delete, undo), instancing, a part studio edited by someone else while
// the assembly is open (the assembly follows live), two people in one assembly, the mesh cache, named
// positions, the exploded view, a conflict, and a sub-assembly.
//
// Setup as scripts/cad-ui.mjs: a local server with KC_DEV_LOGIN=1 on a throwaway database, Playwright, psql:
//
//   DATABASE_URL=postgres://… JWT_SECRET=testsecret PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 KC_DEV_LOGIN=1 cargo run
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret [E2E_BASE=http://127.0.0.1:8099] [SHOTS=/some/dir] node scripts/cad-assembly-ui.mjs
//
// The server binary has the bundles compiled in.  To test bundles newer than the binary (after `npm run build`
// without a `cargo build`), set E2E_LOCAL_DIST=static/dist: the CAD bundles and the stylesheet are then served
// to the browser from that folder instead.
//
// Waits are on the assembly's own state (window.JunctionAssembly), not on timers, except short pauses before
// screenshots.  Without a GPU, Chromium draws WebGL in software (the flags below).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
const LOCAL = process.env.E2E_LOCAL_DIST ? path.resolve(process.env.E2E_LOCAL_DIST) : '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
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

// ---- part studios as files: a sketch on the Top plane and an extrusion (the format of mechanical/CONTRACT.md)
const rect = (x0, y0, x1, y1) => ({
  p1: { type: 'point', x: x0, y: y0 }, p2: { type: 'point', x: x1, y: y0 }, p3: { type: 'point', x: x1, y: y1 }, p4: { type: 'point', x: x0, y: y1 },
  la: { type: 'line', a: 'p1', b: 'p2' }, lb: { type: 'line', a: 'p2', b: 'p3' }, lc: { type: 'line', a: 'p3', b: 'p4' }, ld: { type: 'line', a: 'p4', b: 'p1' },
});
const studioText = (features) => JSON.stringify({ junction: 'part-studio', version: 1, items: [{ id: 'studio', type: 'studio', units: 'mm', rollback: null }, ...features] });
const sketch = (id, order, entities) => ({ id, type: 'feature', featureType: 'sketch', name: 'Sketch', order, params: { plane: { kind: 'plane', plane: 'top' }, sketch: { version: 1, entities, constraints: {} } } });
const extrude = (id, order, sk, depth, name) => ({ id, type: 'feature', featureType: 'extrude', name, order, params: { profile: { sketch: sk, regions: null }, operation: 'new', endType: 'blind', depth, flip: false, targets: [] } });
// a 100 × 60 × 40 box with a ⌀8 hole through it; a 100 × 60 × 5 lid drawn beside it (y from 100); a ⌀8 × 30 pin
const BOX = studioText([sketch('bs', 'V', { ...rect(0, 0, 100, 60), hc: { type: 'point', x: 20, y: 30 }, hole: { type: 'circle', center: 'hc', r: 4 } }), extrude('box', 'h', 'bs', 40, 'Box')]);
const LID = studioText([sketch('ls', 'V', rect(0, 100, 100, 160)), extrude('lid', 'h', 'ls', 5, 'Lid'), sketch('ps', 'm', { pc: { type: 'point', x: 150, y: 30 }, pin: { type: 'circle', center: 'pc', r: 4 } }), extrude('pin', 'p', 'ps', 30, 'Pin')]);

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
async function open(uid, login) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  if (LOCAL) {
    for (const f of ['assembly.js', 'mechanical.js', 'cad-worker.js', 'ui.css']) {
      await ctx.route(new RegExp(`/static/dist/${f.replace('.', '\\.')}(\\?.*)?$`), (route) => route.fulfill({ path: path.join(LOCAL, f), contentType: f.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' }));
    }
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${login}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`${login} console: ${m.text()}`); });
  await page.goto(`${BASE}/auth/dev?jwt=${jwt(uid, login)}&next=/`);
  await page.waitForLoadState('networkidle');
  return page;
}

const asm = (page, fn, arg) => page.evaluate(fn, arg);
/** Where a point of the assembly is on the page. */
const at = (page, p) => page.evaluate((p) => { const v = window.JunctionAssembly.viewport, s = v.project(v.target.clone().set(p[0], p[1], p[2])), r = v.canvas.getBoundingClientRect(); return { x: r.left + s.x, y: r.top + s.y }; }, p);
/** The assembly is loaded, nothing is being built, every instance has its geometry, and what is on screen is what is stored. */
const settled = (page, n) => page.waitForFunction((n) => {
  const a = window.JunctionAssembly, s = a && a.getState();
  return !!s && s.loaded && !s.building && s.instances.length === n && s.instances.every((i) => i.suppressed || s.instanceInfo[i.id]?.status === 'ready') && (!s.canEdit || a.unsettled < 1e-6) && a.session.unsaved === 0;
}, n, { timeout: 90000 });
const inst = (page, name) => page.evaluate((name) => { const a = window.JunctionAssembly, i = a.getState().instances.find((x) => x.name === name); return i ? { id: i.id, t: a.transformOf(i.id), stored: i.transform, info: a.getState().instanceInfo[i.id], fixed: !!i.fixed, hidden: !!i.hidden, suppressed: !!i.suppressed } : null; }, name);
const mate = (page, name) => page.evaluate((name) => { const s = window.JunctionAssembly.getState(), m = s.mates.find((x) => x.name === name); return m ? { id: m.id, params: m.params, values: m.values || null, info: s.mateInfo[m.id], a: m.a, b: m.b } : null; }, name);
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const click = async (page, p) => { await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up(); };
const drag = async (page, from, to, steps = 12) => { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps }); await page.waitForTimeout(120); await page.mouse.up(); };
const menu = async (page, row, entry) => { await page.click(row, { button: 'right' }); await page.click(`[role=menu] >> text="${entry}"`); };
/** Look from behind and above (the back of the parts and their tops), then fit. */
const lookFromBehind = (page) => page.evaluate(() => { const a = window.JunctionAssembly, v = a.viewport; v.lookAlong(v.target.clone().set(-0.55, -1, -0.6), v.target.clone().set(0, 0, 1), false); a.fit(); });

try {
  const aliceId = user('asm-ui-alice', 990011), bobId = user('asm-ui-bob', 990012);
  const alice = await open(aliceId, 'asm-ui-alice');

  // ---------------------------------------------------------------- a project with two part studios and an assembly
  const project = await alice.evaluate(async () => (await (await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Assembly UI test', template: 'pcb' }) })).json()));
  const pid = project.projectId;
  const newDoc = (page, name, text) => page.evaluate(async ({ pid, name, text }) => {
    const made = await (await fetch(`/api/projects/${pid}/docs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: name }) })).json();
    const r = await fetch(`/api/docs/${made.docId}/snapshots?seq=0`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: text });
    return { docId: made.docId, status: r.status };
  }, { pid, name, text });
  const boxDoc = await newDoc(alice, 'Enclosure.jpart', BOX), lidDoc = await newDoc(alice, 'Cover.jpart', LID);
  check('two part studios are stored', !!boxDoc.docId && boxDoc.status < 300 && lidDoc.status < 300, `${boxDoc.status} ${lidDoc.status}`);
  await alice.goto(`${BASE}/p/${pid}/edit`);
  await alice.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await alice.click('[data-doc-add]');
  await alice.click('text=New assembly');
  await alice.waitForFunction(() => window.JunctionAssembly && window.JunctionAssembly.getState().loaded, null, { timeout: 30000 });
  const url = alice.url();
  check('an empty assembly opens with its tools', await alice.isVisible('[data-tool=Insert]') && await alice.isVisible('[data-mate-tool=revolute]') && (await alice.$$('[data-mate-tool]')).length === 9);
  await shot(alice, '01-empty');

  // ---------------------------------------------------------------- insert: one part of one studio, the whole of another
  await alice.click('[data-tool=Insert]');
  await alice.waitForSelector('[data-insert-dialog] [data-offer]', { timeout: 90000 });   // the first studio is opened and built: the kernel starts here
  const firstOpen = await alice.$$eval('[data-insert-dialog] [data-offer]', (els) => els.map((e) => e.getAttribute('data-offer')));
  check('Insert lists the parts of a part studio that was never opened in a tab', firstOpen.length >= 1, firstOpen.join());
  for (const name of ['Enclosure', 'Cover']) if (!(await alice.$(`[data-source-doc=${name}][data-open]`))) await alice.click(`[data-source-doc=${name}] >> text=${name}`);
  await alice.waitForSelector('[data-source-doc=Enclosure] [data-offer=Enclosure]', { timeout: 90000 });
  await alice.waitForSelector("[data-source-doc=Cover] [data-offer='Part 2']", { timeout: 90000 });
  await shot(alice, '02-insert');
  await alice.click('[data-source-doc=Enclosure] [data-offer=Enclosure]');
  await alice.click('[data-source-doc=Cover] [data-all]');
  await alice.click('[data-insert-dialog] [data-accept]');
  await settled(alice, 3);
  const names = await asm(alice, () => window.JunctionAssembly.getState().instances.map((i) => i.name).join());
  check('the three parts are placed; a studio with one part gives its own name', names === 'Enclosure,Part 1,Part 2', names);
  // the names a person would give them (renaming in the list is tried further down)
  await asm(alice, () => { const a = window.JunctionAssembly; a.getState().instances.forEach((i, n) => a.rename(i.id, ['Box', 'Lid', 'Pin'][n])); });
  await alice.waitForSelector('[data-instance=Pin]');
  check('nothing holds them yet: 18 freedoms', (await asm(alice, () => window.JunctionAssembly.getState().dof)) === 18);
  await shot(alice, '03-inserted');

  // ---------------------------------------------------------------- fix the box
  await alice.click('[data-instance=Box]');
  await alice.click('[data-tool=Fix]');
  await alice.waitForFunction(() => window.JunctionAssembly.getState().instances[0].fixed === true);
  check('Fix holds the box', (await inst(alice, 'Box')).info.grounded === true && (await alice.textContent('[data-instance=Box] [data-badge]')) === 'fixed');

  // ---------------------------------------------------------------- a Revolute mate, picked in the viewport
  await lookFromBehind(alice);
  await alice.waitForTimeout(300);
  await alice.click('[data-mate-tool=revolute]');
  await alice.waitForSelector('[data-mate-dialog=revolute] [data-connector=a][data-armed]');
  // hover the box's back top edge: its connector (the edge's midpoint) lights up
  const boxEdge = await at(alice, [50, 60, 40]);
  await alice.mouse.move(boxEdge.x, boxEdge.y, { steps: 4 });
  await shot(alice, '04-hover-connector');
  await click(alice, boxEdge);
  await alice.waitForSelector('[data-mate-dialog] [data-connector=a][data-set]');
  const a = await asm(alice, () => window.JunctionAssembly.getState().mating.a);
  check('a click on the back top edge of the box takes it as the first connector', a.ref.kind === 'edge' && /end/.test(a.ref.name) && /side:lc/.test(a.ref.name), JSON.stringify(a.ref));
  // the lid's back bottom edge
  const lidEdge = await at(alice, [50, 160, 0]);
  await alice.mouse.move(lidEdge.x, lidEdge.y, { steps: 4 });
  await click(alice, lidEdge);
  await alice.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return s.mating && s.mating.b && s.mateInfo[s.mating.id]?.state === 'ok'; }, null, { timeout: 10000 });
  let lid = await inst(alice, 'Lid');
  check('the lid jumps onto the box while the mate is still a draft', near(lid.t[7], -100) && near(lid.t[11], 40), lid.t.map((v) => Math.round(v * 100) / 100).join(' '));
  check('…and the document is untouched until Done', lid.stored[11] === 0);
  await shot(alice, '05-mate-draft');
  // limits: the lid opens to 110° and no further
  await alice.check('[data-mate-dialog] input[data-param=limits]');
  await alice.fill('[data-mate-dialog] input[data-param=angleMin]', '-110');
  await alice.fill('[data-mate-dialog] input[data-param=angleMax]', '0');
  await alice.fill("[data-mate-dialog] input[aria-label='Mate name']", 'Hinge');
  await alice.click('[data-mate-dialog] [data-accept]');
  await settled(alice, 3);
  let hinge = await mate(alice, 'Hinge');
  lid = await inst(alice, 'Lid');
  check('Done stores the mate and the solved placement in one step', !!hinge && hinge.info.state === 'ok' && hinge.params.limits === true && near(lid.stored[11], 40) && near(lid.stored[7], -100), JSON.stringify(hinge?.params));
  check('the hinge leaves the lid one freedom', lid.info.dof === 1 && (await alice.textContent('[data-instance=Lid] [data-badge]')) === '1 free', `dof ${lid.info.dof}`);
  check('the mate list shows the angle', /^-?0°$/.test((await alice.textContent('[data-mate=Hinge] [data-value]')).trim()), await alice.textContent('[data-mate=Hinge] [data-value]'));
  await alice.keyboard.press('Escape');
  await shot(alice, '06-hinged');

  // ---------------------------------------------------------------- drag the lid within its limits
  await alice.evaluate(() => { const a = window.JunctionAssembly, v = a.viewport; v.setView('iso', false); a.fit(); });
  await alice.waitForTimeout(300);
  const grab = await at(alice, [50, 5, 45]);        // on the lid's top, near its front edge
  const up = await at(alice, [50, 30, 95]);
  await drag(alice, grab, up);
  await settled(alice, 3);
  hinge = await mate(alice, 'Hinge'); lid = await inst(alice, 'Lid');
  const opened = hinge.info.values.angle;
  check('dragging the lid opens it about the hinge', opened < -20 && opened > -110 && hinge.info.state === 'ok', `angle ${opened.toFixed(2)}°`);
  check('the hinge line has not moved, and the drag is stored', near(lid.t[7] + 160 * lid.t[5] + 0 * lid.t[6], 60, 1e-3) && near(lid.stored[11], lid.t[11], 1e-6), `stored z ${lid.stored[11]}`);
  await shot(alice, '07-lid-open');
  // far past the limit: it stops at 110°
  const tip = await asm(alice, () => { const a = window.JunctionAssembly, i = a.getState().instances[1], t = a.transformOf(i.id); const p = [50, 105, 5]; return [t[0] * p[0] + t[1] * p[1] + t[2] * p[2] + t[3], t[4] * p[0] + t[5] * p[1] + t[6] * p[2] + t[7], t[8] * p[0] + t[9] * p[1] + t[10] * p[2] + t[11]]; });
  await drag(alice, await at(alice, tip), await at(alice, [50, 200, 60]), 20);
  await settled(alice, 3);
  hinge = await mate(alice, 'Hinge');
  check('dragged far past its limit, the lid stops at 110°', near(hinge.info.values.angle, -110, 0.05), `angle ${hinge.info.values.angle.toFixed(3)}°`);
  await shot(alice, '08-lid-at-limit');
  await alice.focus('.cad-stage canvas');
  await alice.keyboard.press('Control+z');
  await settled(alice, 3);
  check('undo takes the last drag back', near((await mate(alice, 'Hinge')).info.values.angle, opened, 0.01));

  // ---------------------------------------------------------------- a value typed in the mate's dialog, and animated
  await alice.dblclick('[data-mate=Hinge]');
  await alice.waitForSelector('[data-mate-dialog=revolute] input[data-param=value-angle]');
  await alice.fill('[data-mate-dialog] input[data-param=value-angle]', '-45');
  await alice.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return Math.abs(s.mateInfo[s.mating.id].values.angle + 45) < 1e-3; });
  check('typing the angle moves the lid there', true);
  await alice.click('[data-mate-dialog] [data-animate=angle]');
  const seen = new Set();
  for (let i = 0; i < 12; i++) { await alice.waitForTimeout(120); seen.add(Math.round(await asm(alice, () => { const s = window.JunctionAssembly.getState(); return s.mateInfo[s.mating.id].values.angle; }))); }
  await shot(alice, '09-animating');
  await alice.click('[data-mate-dialog] [data-animate=angle]');
  check('Animate sweeps the angle between the limits', seen.size >= 4 && Math.min(...seen) >= -110 && Math.max(...seen) <= 0, Array.from(seen).join(' '));
  await alice.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return !s.animating && Math.abs(s.mateInfo[s.mating.id].values.angle + 45) < 1e-3; });
  await alice.click('[data-mate-dialog] [data-accept]');
  await settled(alice, 3);
  check('…and stops where it started; Done stores 45°', near((await mate(alice, 'Hinge')).info.values.angle, -45, 1e-3));

  // ---------------------------------------------------------------- the pin in the hole: Cylindrical, then the manipulator
  await alice.click('[data-mate-tool=cylindrical]');
  await alice.waitForSelector('[data-mate-dialog=cylindrical] [data-connector=a][data-armed]');
  const rim = await at(alice, [20, 26, 40]);           // the rim of the box's hole (its seam vertex is at x = 24: not there)
  await alice.mouse.move(rim.x, rim.y, { steps: 3 }); await click(alice, rim);
  await alice.waitForSelector('[data-mate-dialog] [data-connector=a][data-set]');
  const pinTop = await at(alice, [150, 26, 30]);       // the rim of the pin's top
  await alice.mouse.move(pinTop.x, pinTop.y, { steps: 3 }); await click(alice, pinTop);
  await alice.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return s.mating && s.mating.b && s.mateInfo[s.mating.id]?.state === 'ok'; }, null, { timeout: 10000 });
  await alice.click('[data-mate-dialog] [data-accept]');
  await settled(alice, 3);
  let pin = await inst(alice, 'Pin');
  const cyl = await mate(alice, 'Cylindrical 1');
  check('the two rims were taken as circular edges: their connectors are the circles\' centres', cyl.a.ref.kind === 'edge' && cyl.b.ref.kind === 'edge', `${cyl.a.ref.name} / ${cyl.b.ref.name}`);
  check('a Cylindrical mate puts the pin on the hole\'s axis with two freedoms', near(pin.t[3], -130, 1e-3) && near(pin.t[7], 0, 1e-3) && pin.info.dof === 2, `x ${pin.t[3]} dof ${pin.info.dof}`);
  // the manipulator: slide the pin up its axis by a round step
  await alice.click('[data-instance=Pin]');
  await alice.waitForFunction(() => !!window.JunctionAssembly.scene.triad.shown);
  const handle = await asm(alice, () => { const a = window.JunctionAssembly, t = a.scene.triad.shown, v = a.viewport, px = v.pixelSize(); const s = v.project(v.target.clone().set(t.p[0], t.p[1], t.p[2] + 60 * px)), r = v.canvas.getBoundingClientRect(); return { x: r.left + s.x, y: r.top + s.y, z: a.transformOf(a.getState().selection[0])[11] }; });
  await alice.mouse.move(handle.x, handle.y); await alice.mouse.down();
  await alice.mouse.move(handle.x, handle.y - 60, { steps: 8 });
  await alice.waitForTimeout(150);
  const readout = await alice.textContent('[data-status-note]');
  await shot(alice, '10-triad');
  await alice.mouse.up();
  await settled(alice, 3);
  pin = await inst(alice, 'Pin');
  const moved = pin.t[11] - handle.z;
  check('the manipulator slides the pin along its axis in round steps', moved > 1 && near(moved / 5, Math.round(moved / 5), 1e-6) && near(pin.t[3], -130, 1e-3) && /mm$/.test(readout.trim()), `moved ${moved} mm, readout "${readout}"`);

  // ---------------------------------------------------------------- the instance tree
  await alice.click('[data-instance=Pin] [data-eye]');
  await alice.waitForFunction(() => window.JunctionAssembly.getState().instances[2].hidden === true);
  check('the eye hides an instance', true);
  await alice.click('[data-instance=Pin] [data-eye]');
  await menu(alice, '[data-instance=Pin]', 'Rename');
  await alice.fill("[data-panel=instances] input[aria-label='Name']", 'Hinge pin');
  await alice.keyboard.press('Enter');
  await alice.waitForSelector("[data-instance='Hinge pin']");
  await menu(alice, "[data-instance='Hinge pin']", 'Suppress');
  await alice.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return s.instances[2].suppressed && s.mateInfo[s.mates[1].id].state === 'inactive'; });
  check('a suppressed instance turns its mates off', (await asm(alice, () => window.JunctionAssembly.scene.stats.instances)) === 2);
  await menu(alice, "[data-instance='Hinge pin']", 'Unsuppress');
  await settled(alice, 3);
  await alice.click('[data-instance=Lid]');
  await alice.click("[data-instance='Hinge pin']", { modifiers: ['Control'] });
  await menu(alice, "[data-instance='Hinge pin']", 'Group');
  await alice.fill("[data-panel=instances] input[aria-label='Name']", 'Moving parts');
  await alice.keyboard.press('Enter');
  await alice.waitForSelector("[data-group='Moving parts']");
  check('two instances are grouped', (await asm(alice, () => { const s = window.JunctionAssembly.getState(); return s.instances.filter((i) => i.group === s.groups[0].id).length; })) === 2);
  await shot(alice, '11-tree');
  // instancing: copies of the lid share its geometry
  await alice.click('[data-instance=Lid]');
  await menu(alice, '[data-instance=Lid]', 'Copy in a row…');
  await alice.fill('[data-form] input[data-param=count]', '4');
  await alice.fill('[data-form] input[data-param=x]', '0');
  await alice.fill('[data-form] input[data-param=z]', '30');
  await alice.click('[data-form] [data-accept]');
  await settled(alice, 7);
  const stats = await asm(alice, () => window.JunctionAssembly.scene.stats);
  check('seven instances are drawn from three geometries', stats.instances === 7 && stats.geometries === 3, JSON.stringify(stats));
  await shot(alice, '12-copies');
  // replace one copy with the pin, then delete the copies and take that back
  await alice.click("[data-instance='Lid 2']");
  await menu(alice, "[data-instance='Lid 2']", 'Replace…');
  await alice.waitForSelector("[data-insert-dialog] [data-offer='Part 2']", { timeout: 60000 });
  await alice.click("[data-insert-dialog] [data-offer='Part 2']");
  await alice.waitForFunction(() => window.JunctionAssembly.getState().instances.find((i) => i.name === 'Lid 2').source.body === 'pin');
  check('Replace points an instance at another part', true);
  for (const n of ['Lid 2', 'Lid 3', 'Lid 4', 'Lid 5']) await alice.click(`[data-instance='${n}']`, { modifiers: n === 'Lid 2' ? [] : ['Control'] });
  await alice.focus('.cad-stage canvas');
  await alice.keyboard.press('Delete');
  await settled(alice, 3);
  check('Delete removes the selected instances', true);

  // ---------------------------------------------------------------- named positions, exploded view
  await alice.click("[data-tool=Position]");
  await alice.fill('[data-form] input[data-param=name]', 'Half open');
  await alice.click('[data-form] [data-accept]');
  await alice.waitForSelector("[data-position='Half open']");
  await alice.dblclick('[data-mate=Hinge]');
  await alice.fill('[data-mate-dialog] input[data-param=value-angle]', '0');
  await alice.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return Math.abs(s.mateInfo[s.mating.id].values.angle) < 1e-3; });
  await alice.click('[data-mate-dialog] [data-accept]');
  await settled(alice, 3);
  await alice.click("[data-position='Half open']");
  await alice.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return Math.abs(s.mateInfo[s.mates[0].id].values.angle + 45) < 1e-3; });
  await settled(alice, 3);
  check('a named position brings the lid back to 45°', true);
  await alice.click('[data-tool=Explode]');
  await alice.waitForSelector('[data-explode]');
  const apart = await asm(alice, () => { const a = window.JunctionAssembly, s = a.getState(); return s.instances.map((i) => { const shown = a.scene.transformOf(i.id), solved = a.transformOf(i.id); return Math.hypot(shown[3] - solved[3], shown[7] - solved[7], shown[11] - solved[11]); }); });
  check('the exploded view pulls the parts apart on screen only', apart.every((d) => d > 1) && (await asm(alice, () => window.JunctionAssembly.unsettled)) < 1e-6, apart.map((d) => d.toFixed(1)).join(' '));
  await shot(alice, '13-exploded');
  await alice.click('[data-explode] >> text=Done');

  // ---------------------------------------------------------------- a conflict is named
  await alice.click('[data-mate-tool=fastened]');
  await alice.waitForSelector('[data-mate-dialog=fastened] [data-connector=a][data-armed]');
  await click(alice, await at(alice, [100, 30, 20]));   // the box's +x face
  await alice.waitForSelector('[data-mate-dialog] [data-connector=a][data-set]');
  const lidTop = await asm(alice, () => { const a = window.JunctionAssembly, i = a.getState().instances[1], t = a.transformOf(i.id); const p = [70, 130, 5]; return [t[0] * p[0] + t[1] * p[1] + t[2] * p[2] + t[3], t[4] * p[0] + t[5] * p[1] + t[6] * p[2] + t[7], t[8] * p[0] + t[9] * p[1] + t[10] * p[2] + t[11]]; });
  await click(alice, await at(alice, lidTop));
  await alice.waitForSelector('[data-mate-dialog] [data-mate-error]', { timeout: 10000 });
  const why = await alice.textContent('[data-mate-dialog] [data-mate-error]');
  check('a mate that cannot hold with the hinge says so before it is accepted', /conflict/i.test(why), why);
  await shot(alice, '14-conflict');
  await alice.click('[data-mate-dialog] [data-accept]');
  await alice.waitForSelector('[data-mate][data-state=conflict]');
  check('accepted anyway, it is listed as a conflict and the hinge still holds', (await mate(alice, 'Hinge')).info.state === 'ok' && (await alice.textContent('[data-panel=mates] [data-conflicts]')) === '1 with a problem');
  await menu(alice, '[data-mate][data-state=conflict]', 'Delete');
  await alice.waitForFunction(() => window.JunctionAssembly.getState().mates.length === 2);
  await settled(alice, 3);

  // ---------------------------------------------------------------- an explicit mate connector, and a mate that uses it
  await alice.click("[data-tool=Connector]");
  const side = await at(alice, [100, 30, 20]);
  await alice.mouse.move(side.x, side.y, { steps: 3 });
  await click(alice, side);
  await alice.waitForSelector('[data-connector-row]');
  await menu(alice, '[data-connector-row]', 'Move or turn…');
  await alice.fill('[data-form] input[data-param=z]', '12');
  await alice.click('[data-form] [data-accept]');
  await alice.waitForFunction(() => window.JunctionAssembly.getState().connectors[0]?.offset?.[2] === 12);
  check('a click on the box\'s side keeps a mate connector there, 12 mm off the face', (await asm(alice, () => { const c = window.JunctionAssembly.getState().connectors[0]; return c.ref.kind + ':' + c.name; })) === 'face:Mate connector 1');
  // a second pin, joined to that connector by a ball mate
  await alice.click('[data-tool=Insert]');
  await alice.waitForSelector("[data-insert-dialog] [data-offer='Part 2']", { timeout: 60000 });
  await alice.click("[data-insert-dialog] [data-offer='Part 2']");
  await alice.click('[data-insert-dialog] [data-accept]');
  await settled(alice, 4);
  const second = await inst(alice, 'Part 2');
  check('a part that is already there is set beside the first one, not on it', second.t[3] > 5, `x ${second.t[3]}`);
  // Tangent: the pin's round side against the box's flat side
  await alice.click('[data-mate-tool=tangent]');
  await alice.waitForSelector('[data-mate-dialog=tangent] [data-connector=a][data-armed]');
  await click(alice, await at(alice, [100, 12, 30]));
  await alice.waitForSelector('[data-mate-dialog] [data-connector=a][data-set]');
  await click(alice, await at(alice, [150 + second.t[3] + 2.83, 30 - 2.83, 15]));
  await alice.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return s.mating && s.mating.b && s.mateInfo[s.mating.id]?.state === 'ok'; }, null, { timeout: 10000 });
  await alice.click('[data-mate-dialog] [data-accept]');
  await settled(alice, 4);
  const rolled = await inst(alice, 'Part 2');
  check('a Tangent mate slides the pin until its round side rests on the box\'s flat side (its axis one radius from the face), without turning it', near(rolled.t[0] * 150 + rolled.t[1] * 30 + rolled.t[3], 104, 1e-3) && near(Math.abs(rolled.t[2]), 0, 1e-6) && near(rolled.t[0], 1, 1e-6) && rolled.info.dof === 4, `axis x ${(rolled.t[0] * 150 + rolled.t[1] * 30 + rolled.t[3]).toFixed(3)}, dof ${rolled.info.dof}`);
  await menu(alice, "[data-mate='Tangent 1']", 'Delete');
  await alice.waitForFunction(() => window.JunctionAssembly.getState().mates.length === 2);
  await alice.click('[data-mate-tool=ball]');
  await alice.waitForSelector('[data-mate-dialog=ball] [data-connector=a][data-armed]');
  const glyph = await at(alice, [112, 30, 20]);
  await alice.mouse.move(glyph.x, glyph.y, { steps: 3 });
  await click(alice, glyph);
  await alice.waitForSelector('[data-mate-dialog] [data-connector=a][data-set]');
  check('the connector\'s mark is picked as a mate\'s first connector', (await alice.textContent('[data-mate-dialog] [data-connector=a]')).includes('Mate connector 1'), await alice.textContent('[data-mate-dialog] [data-connector=a]'));
  const pin2 = await at(alice, [rolled.t[0] * 150 + rolled.t[1] * 26 + rolled.t[2] * 30 + rolled.t[3], rolled.t[4] * 150 + rolled.t[5] * 26 + rolled.t[6] * 30 + rolled.t[7], rolled.t[8] * 150 + rolled.t[9] * 26 + rolled.t[10] * 30 + rolled.t[11]]);
  await alice.mouse.move(pin2.x, pin2.y, { steps: 3 });
  await click(alice, pin2);
  await alice.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return s.mating && s.mating.b && s.mateInfo[s.mating.id]?.state === 'ok'; }, null, { timeout: 10000 });
  await shot(alice, '14b-explicit-connector');
  await alice.click('[data-mate-dialog] [data-accept]');
  await settled(alice, 4);
  const ball = await inst(alice, 'Part 2');
  const centre = [ball.t[0] * 150 + ball.t[1] * 30 + ball.t[2] * 30 + ball.t[3], ball.t[4] * 150 + ball.t[5] * 30 + ball.t[6] * 30 + ball.t[7], ball.t[8] * 150 + ball.t[9] * 30 + ball.t[10] * 30 + ball.t[11]];
  check('the ball mate holds the pin\'s end on the connector and leaves it three freedoms', near(centre[0], 112, 1e-3) && near(centre[1], 30, 1e-3) && near(centre[2], 20, 1e-3) && ball.info.dof === 3, centre.map((v) => v.toFixed(3)).join(' '));
  await alice.click("[data-instance='Part 2']");
  await alice.focus('.cad-stage canvas');
  await alice.keyboard.press('Delete');
  await settled(alice, 3);
  check('deleting the pin takes its mate with it', (await asm(alice, () => window.JunctionAssembly.getState().mates.length)) === 2);

  // ---------------------------------------------------------------- someone else changes the box: the assembly follows, live
  const invited = await alice.evaluate(async (pid) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'asm-ui-bob', role: 'editor' }) })).status, pid);
  check('a second person is invited', invited === 200);
  const bob = await open(bobId, 'asm-ui-bob');
  await bob.goto(`${BASE}/p/${pid}/edit?doc=${boxDoc.docId}`);
  await bob.waitForFunction(() => { const s = window.JunctionPartStudio && window.JunctionPartStudio.getState(); return s && s.loaded && s.kernel.state === 'ready' && s.bodies.length === 1; }, null, { timeout: 90000 });
  const before = await inst(alice, 'Lid');
  await shot(alice, '15-before-box-change');
  await bob.dblclick('[data-feature-row][data-feature-type=extrude]');
  await bob.waitForSelector('.cad-dialog[data-feature=extrude]');
  await bob.fill('.cad-dialog input[data-param=depth]', '70');
  await bob.click('.cad-dialog [data-accept]');
  await alice.waitForFunction((z) => { const a = window.JunctionAssembly, i = a.getState().instances[1]; return Math.abs(a.transformOf(i.id)[11] - z) < 1e-3; }, before.t[11] + 30, { timeout: 60000 });
  await settled(alice, 3);
  const after = await inst(alice, 'Lid');
  check('the box grows 30 mm in its part studio (edited by someone else): the lid rises with it, still hinged at 45°', near(after.t[11] - before.t[11], 30, 1e-3) && near((await mate(alice, 'Hinge')).info.values.angle, -45, 1e-3) && near(after.stored[11], after.t[11], 1e-6), `z ${before.t[11].toFixed(2)} → ${after.t[11].toFixed(2)}`);
  pin = await inst(alice, 'Hinge pin');
  check('the pin is still in its hole', near(pin.t[3], -130, 1e-3) && pin.info.dof === 2);
  await shot(alice, '16-after-box-change');

  // ---------------------------------------------------------------- two people in the assembly
  await bob.goto(url);
  await settled(bob, 3);
  check('the second person sees the same assembly', (await asm(bob, () => window.JunctionAssembly.getState().mates.map((m) => m.name).join())) === (await asm(alice, () => window.JunctionAssembly.getState().mates.map((m) => m.name).join())) && near((await inst(bob, 'Lid')).t[11], after.t[11], 1e-6));
  await bob.evaluate(() => { const a = window.JunctionAssembly, v = a.viewport; v.setView('iso', false); a.fit(); });
  await bob.waitForTimeout(300);
  const bobLid = await asm(bob, () => { const a = window.JunctionAssembly, i = a.getState().instances[1], t = a.transformOf(i.id); const p = [50, 105, 5]; return [t[0] * p[0] + t[1] * p[1] + t[2] * p[2] + t[3], t[4] * p[0] + t[5] * p[1] + t[6] * p[2] + t[7], t[8] * p[0] + t[9] * p[1] + t[10] * p[2] + t[11]]; });
  await drag(bob, await at(bob, bobLid), await at(bob, [50, -40, 60]), 16);
  await settled(bob, 3);
  const closed = (await mate(bob, 'Hinge')).info.values.angle;
  await alice.waitForFunction((angle) => Math.abs(window.JunctionAssembly.getState().mateInfo[window.JunctionAssembly.getState().mates[0].id].values.angle - angle) < 1e-3, closed, { timeout: 15000 });
  check('a drag by one person moves the lid for the other', closed > -45 + 1, `angle ${closed.toFixed(2)}°`);
  await menu(alice, '[data-instance=Box]', 'Rename');
  await alice.fill("[data-panel=instances] input[aria-label='Name']", 'Enclosure base');
  await alice.keyboard.press('Enter');
  await bob.waitForSelector("[data-instance='Enclosure base']", { timeout: 15000 });
  check('a rename by one person reaches the other', true);
  await shot(bob, '17-second-person');

  // ---------------------------------------------------------------- reload: the parts come from the cache, no kernel
  await alice.reload();
  await settled(alice, 3);
  const started = await asm(alice, () => window.JunctionAssembly.sources.kernels.started);
  check('after a reload the parts come from the mesh cache: the kernel is not started', started === 0, `workers started: ${started}`);
  check('…and the assembly is as it was left', near((await mate(alice, 'Hinge')).info.values.angle, closed, 1e-3) && (await inst(alice, 'Enclosure base')).fixed);

  // ---------------------------------------------------------------- the same person: edit the box in its tab, come back
  await alice.dblclick('[data-mate=Hinge]');
  await alice.fill('[data-mate-dialog] input[data-param=value-angle]', '-30');
  await alice.waitForFunction(() => { const s = window.JunctionAssembly.getState(); return Math.abs(s.mateInfo[s.mating.id].values.angle + 30) < 1e-3; });
  await alice.click('[data-mate-dialog] [data-accept]');
  await settled(alice, 3);
  check('the mate\'s value is stored with the placements', near((await mate(alice, 'Hinge')).values.angle, -30, 1e-5), JSON.stringify((await mate(alice, 'Hinge')).values));
  await alice.click('#doctabs [role=tab] >> text=Enclosure');
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio && window.JunctionPartStudio.getState(); return s && s.loaded && s.kernel.state === 'ready' && s.bodies.length === 1; }, null, { timeout: 90000 });
  await alice.dblclick('[data-feature-row][data-feature-type=extrude]');
  await alice.waitForSelector('.cad-dialog[data-feature=extrude]');
  await alice.fill('.cad-dialog input[data-param=depth]', '55');
  await alice.click('.cad-dialog [data-accept]');
  await alice.waitForFunction(() => { const s = window.JunctionPartStudio.getState(); return !s.editing && s.kernel.state === 'ready' && Math.abs(s.bodies[0]?.mesh?.bbox[5] - 55) < 1e-6; }, null, { timeout: 60000 });
  await alice.click('#doctabs [role=tab] >> text=Assembly 1');
  await alice.waitForFunction(() => window.JunctionAssembly && window.JunctionAssembly.getState().loaded, null, { timeout: 30000 });
  await settled(alice, 3);
  const back = await inst(alice, 'Lid');
  check('the box is made 55 mm tall in its own tab; back in the assembly the lid is hinged at 55, still open 30°', near(back.t[9] * 160 + back.t[11], 55, 1e-3) && near(back.stored[11], back.t[11], 1e-6) && near((await mate(alice, 'Hinge')).info.values.angle, -30, 1e-3), `hinge z ${(back.t[9] * 160 + back.t[11]).toFixed(3)}, angle ${(await mate(alice, 'Hinge')).info.values.angle.toFixed(3)}°`);
  await shot(alice, '17b-after-own-edit');

  // ---------------------------------------------------------------- a sub-assembly
  await alice.click('[data-doc-add]');
  await alice.click('text=New assembly');
  await alice.waitForFunction((u) => location.href !== u && window.JunctionAssembly && window.JunctionAssembly.getState().loaded && window.JunctionAssembly.getState().instances.length === 0, url, { timeout: 30000 });
  await alice.click('[data-tool=Insert]');
  await alice.waitForSelector('[data-insert-dialog] [data-source-doc]');
  const subRow = await alice.$$eval('[data-insert-dialog] [data-source-doc]', (els) => els.map((e) => e.getAttribute('data-source-doc')));
  const asmName = subRow.find((n) => /^Assembly/.test(n));
  await alice.click(`[data-source-doc='${asmName}'] >> text=${asmName}`);
  await alice.click('[data-insert-dialog] [data-accept]');
  await settled(alice, 1);
  const sub = await asm(alice, () => { const a = window.JunctionAssembly; return { pieces: a.placed()[0].pieces.length, stats: a.scene.stats, dof: a.getState().dof }; });
  check('another assembly comes in as one rigid instance with its three parts', sub.pieces === 3 && sub.stats.instances === 1 && sub.dof === 6, JSON.stringify(sub));
  await shot(alice, '18-sub-assembly');

  // ---------------------------------------------------------------- a few hundred instances
  await alice.click('[data-panel=instances] [data-instance]');
  await menu(alice, '[data-panel=instances] [data-instance]', 'Copy in a row…');
  await alice.fill('[data-form] input[data-param=count]', '119');
  await alice.fill('[data-form] input[data-param=x]', '0');
  await alice.fill('[data-form] input[data-param=y]', '130');
  await alice.click('[data-form] [data-accept]');
  await settled(alice, 120);
  await alice.evaluate(() => window.JunctionAssembly.fit());
  const many = await asm(alice, () => { const a = window.JunctionAssembly; return { ...a.scene.stats, solveMs: a.getState().solveMs }; });
  check('120 sub-assemblies (360 parts) are drawn from three geometries', many.instances === 120 && many.pieces === 360 && many.geometries === 3, JSON.stringify(many));
  await shot(alice, '19-many');
  const first = await asm(alice, () => { const a = window.JunctionAssembly, i = a.getState().instances[0]; return { id: i.id, y: a.transformOf(i.id)[7] }; });
  const p0 = await at(alice, [50, 30, 70]);
  await alice.mouse.move(p0.x, p0.y); await alice.mouse.down();
  const steps = [];
  for (let k = 1; k <= 10; k++) { await alice.mouse.move(p0.x - 12 * k, p0.y + 4 * k); await alice.waitForTimeout(60); steps.push(await asm(alice, () => window.JunctionAssembly.stepMs)); }
  await alice.mouse.up();
  await settled(alice, 120);
  const movedY = (await asm(alice, (id) => window.JunctionAssembly.transformOf(id), first.id))[7];
  const worstStep = Math.max(...steps);
  check('dragging one of them stays quick: each step (solve and redraw of 360 parts) is a few milliseconds of script', Math.abs(movedY - first.y) > 1 && worstStep < 50, `worst step ${worstStep.toFixed(1)} ms, full solve ${many.solveMs.toFixed(1)} ms`);

  check('no script errors on either page', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  console.error('the run stopped:', e);
  fail++;
  if (errors.length) console.error('page errors:', errors.slice(0, 8).join('\n'));
  for (const ctx of browser.contexts()) for (const page of ctx.pages()) {
    const state = await page.evaluate(() => { const a = window.JunctionAssembly; if (!a) return null; const s = a.getState(); return { instances: s.instances.map((i) => [i.name, s.instanceInfo[i.id]?.status, s.instanceInfo[i.id]?.message, (a.transformOf(i.id) || []).map((v) => Math.round(v * 100) / 100).join(' ')]), mates: s.mates.map((m) => [m.name, s.mateInfo[m.id]?.state, s.mateInfo[m.id]?.message]), building: s.building, unsettled: a.unsettled, unsaved: a.session.unsaved, status: s.status.text }; }).catch(() => null);
    if (state) console.error('assembly state:', JSON.stringify(state));
  }
} finally {
  await browser.close();
  try { sql("DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id IN (990011, 990012))"); } catch { /* left for the next run */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
