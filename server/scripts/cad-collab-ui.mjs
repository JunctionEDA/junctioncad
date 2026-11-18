// Browser test of live collaboration in a part studio, with two and three people signed in as different users
// in separate browser contexts against a running server:
//
//   presence     who is here (the Collaborators panel, the avatars), each person's pointer, view rectangle and
//                selection in the viewport, who has which feature selected or open in the feature list
//   follow       following a person's camera, stopping by moving one's own, following them to another tab
//   editing      two people in different features (one rebuild per edit), two people in the same feature's
//                dialog (field-by-field merge, a conflict on one field, taking theirs), a delete under an open
//                dialog (the feature is offered back), a reorder under an open dialog, bursts of edits from two
//                and three people at once, edits made while offline, a delete while the other is offline
//   tabs         a document added, renamed or deleted by one person appears for the others without a reload,
//                and each tab shows who is on it
//   comments     a thread pinned to a face and one on a feature, seen live by the other person, replies,
//                resolving, and the pin following its face through a rebuild
//
// Setup as scripts/cad-ui.mjs: a local server with KC_DEV_LOGIN=1, Playwright, and psql on the PATH.
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=dev [E2E_BASE=http://127.0.0.1:8104] [SHOTS=/some/dir] node scripts/cad-collab-ui.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8104').replace(/\/$/, '');
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
function user(login, githubId, name) {
  sql(`INSERT INTO users (github_id, login, name) VALUES (${githubId}, '${login}', '${name}') ON CONFLICT (github_id) DO NOTHING`);
  return Number(sql(`SELECT id FROM users WHERE github_id = ${githubId}`));
}

/** The part studio has `n` features, nothing is open, the kernel is idle and every built feature has reported. */
const settled = (page, n) => page.waitForFunction((n) => {
  const s = window.JunctionPartStudio && window.JunctionPartStudio.getState();
  return s && s.loaded && s.kernel.state === 'ready' && s.features.length === n && !s.editing && s.features.slice(0, s.rollback).every((f) => s.reports[f.id]);
}, n, { timeout: 60000 });
/** A wait that reports instead of throwing, so one failure does not end the run. */
const until = async (page, fn, arg, ms = 15000) => { try { await page.waitForFunction(fn, arg, { timeout: ms }); return true; } catch { return false; } };
const click = async (page, x, y, o = {}) => { await page.mouse.move(x, y); await page.mouse.down(o); await page.mouse.up(o); };
const menu = async (page, row, entry) => { await page.click(row, { button: 'right' }); await page.click(`[role=menu] >> text=${entry}`); };
const collab = (page, fn, arg) => page.evaluate(fn, arg);
/** The document as this page has it: every item, keys sorted, so two pages can be compared. */
const docText = (page) => page.evaluate(() => {
  const sort = (v) => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
  const doc = window.JunctionPartStudio.doc;
  return JSON.stringify(Array.from(doc.items.keys()).sort().map((k) => sort(doc.items.get(k))));
});
const unsaved = (page) => page.evaluate(() => window.JunctionPartStudio.session.unsaved);
/** Everybody has sent everything and holds the same document. */
async function converged(pages, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const pending = await Promise.all(pages.map(unsaved));
    const texts = await Promise.all(pages.map(docText));
    if (pending.every((n) => n === 0) && texts.every((t) => t === texts[0])) return true;
    if (Date.now() - t0 > ms) return false;
    await pages[0].waitForTimeout(150);
  }
}
/** Count the rebuilds that evaluated a feature from here on (window.__regens). */
const countRegens = (page) => page.evaluate(() => {
  const st = window.JunctionPartStudio; window.__regens = [];
  if (st.kernel.__counted) return;
  const orig = st.kernel.regenerate.bind(st.kernel);
  st.kernel.regenerate = async (...a) => { const r = await orig(...a); if (r) window.__regens.push({ from: r.rebuiltFrom, n: r.features.length }); return r; };
  st.kernel.__counted = true;
});
const regens = (page) => page.evaluate(() => window.__regens.filter((r) => r.from < r.n).length);
const allRegens = (page) => page.evaluate(() => window.__regens.length);
const set = (page, id, path, value) => page.evaluate(({ id, path, value }) => window.JunctionPartStudio.commit([{ id, kind: 'MODIFIED', typeName: 'feature', props: [{ path, value }] }]), { id, path, value });
const feature = (page, id) => page.evaluate((id) => window.JunctionPartStudio.getState().features.find((f) => f.id === id) || null, id);
const center = (page) => page.$eval('.cad-stage canvas', (c) => { const r = c.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top }; });

const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
/** One part of the run.  A part that throws fails and the next one still runs.  ONLY=a,b runs just those. */
async function section(name, fn) {
  if (ONLY.length && !ONLY.includes(name)) return;
  console.log(`\n— ${name}`);
  try { await fn(); } catch (e) { check(`${name}: ran to the end`, false, String(e && e.message || e).split('\n')[0]); }
}
const cam = (page) => page.evaluate(() => { const v = window.JunctionPartStudio.viewport; return { q: v.camera.quaternion.toArray(), t: v.target.toArray(), z: v.camera.zoom }; });
const near = (a, b) => Math.abs(a.q.reduce((s, x, i) => s + x * b.q[i], 0)) > 0.9999 && Math.hypot(a.t[0] - b.t[0], a.t[1] - b.t[1], a.t[2] - b.t[2]) < 0.05 && Math.abs(a.z / b.z - 1) < 0.01;
const openDialog = async (page, id) => { await page.dblclick(`[data-feature-row="${id}"]`); await page.waitForSelector('.cad-dialog[data-feature=extrude]'); };
const burst = (page, id, who, n) => page.evaluate(async ({ id, who, n }) => {
  const st = window.JunctionPartStudio;
  for (let i = 0; i < n; i++) {
    st.commit([{ id, kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['params', 'depth'], value: 5 + ((i * 7 + who) % 20) }, { path: ['params', 'note' + who], value: i }] }]);
    await new Promise((r) => setTimeout(r, 3 + ((i * 13 + who * 5) % 9)));
  }
}, { id, who, n });
const entity = (page, id, key, value) => page.evaluate(({ id, key, value }) => window.JunctionPartStudio.commit([{ id, kind: 'MODIFIED', typeName: 'feature', props: [value === null ? { path: ['params', 'sketch', 'entities', key], del: true } : { path: ['params', 'sketch', 'entities', key], value }] }]), { id, key, value });
const offline = async (page) => {
  await page.context().setOffline(true);
  await page.evaluate(() => window.JunctionPartStudio.session.ws && window.JunctionPartStudio.session.ws.close());
  await until(page, () => window.JunctionPartStudio.getState().status.state !== 'live');
};

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
  const aliceId = user('collab-alice', 991001, 'Alice Liddell'), bobId = user('collab-bob', 991002, 'Bob Stone'), carolId = user('collab-carol', 991003, 'Carol Reed');
  const alice = await open(aliceId, 'collab-alice');
  const project = await alice.evaluate(async () => {
    const r = await fetch('/api/projects/blank', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'CAD collab test', template: 'pcb' }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  const pid = project.body.projectId;
  for (const login of ['collab-bob', 'collab-carol']) {
    await alice.evaluate(async ({ pid, login }) => (await fetch(`/api/projects/${pid}/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, role: 'editor' }) })).status, { pid, login });
  }
  await alice.goto(`${BASE}/p/${pid}/edit`);
  await alice.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
  await alice.click('[data-doc-add]');
  await alice.click('text=New part studio');
  await alice.waitForFunction(() => window.JunctionPartStudio && window.JunctionPartStudio.getState().loaded, null, { timeout: 30000 });

  // a model to work on: two blocks, each a sketch and an extrude
  const ids = await alice.evaluate(() => {
    const st = window.JunctionPartStudio, id = () => crypto.randomUUID();
    const rect = (x0, y0, x1, y1) => ({ p1: { type: 'point', x: x0, y: y0 }, p2: { type: 'point', x: x1, y: y0 }, p3: { type: 'point', x: x1, y: y1 }, p4: { type: 'point', x: x0, y: y1 },
      l1: { type: 'line', a: 'p1', b: 'p2' }, l2: { type: 'line', a: 'p2', b: 'p3' }, l3: { type: 'line', a: 'p3', b: 'p4' }, l4: { type: 'line', a: 'p4', b: 'p1' } });
    const feat = (id, featureType, name, order, params) => ({ id, kind: 'ADDED', typeName: 'feature', item: { id, type: 'feature', featureType, name, order, params } });
    const sketch = (x0, y0, x1, y1) => ({ plane: { kind: 'plane', plane: 'top' }, sketch: { version: 1, entities: rect(x0, y0, x1, y1), constraints: {} } });
    const extrude = (s, depth) => ({ profile: { sketch: s, regions: null }, operation: 'new', endType: 'blind', depth, flip: false, targets: [] });
    const s1 = id(), e1 = id(), s2 = id(), e2 = id();
    st.commit([feat(s1, 'sketch', 'Sketch 1', 'F', sketch(-40, -25, 0, 25)), feat(e1, 'extrude', 'Extrude 1', 'K', extrude(s1, 20)), feat(s2, 'sketch', 'Sketch 2', 'P', sketch(15, -15, 45, 15)), feat(e2, 'extrude', 'Extrude 2', 'U', extrude(s2, 10))]);
    return { s1, e1, s2, e2 };
  });
  await settled(alice, 4);
  await alice.click('.v3-views [data-view=fit]');
  check('the model is built: two bodies', (await alice.evaluate(() => window.JunctionPartStudio.getState().bodies.length)) === 2);
  const url = alice.url(), docId = new URL(url).searchParams.get('doc');
  check('alone, the panel says so', /No one else is here/.test(await alice.textContent('#cadPeers')));
  const bob = await open(bobId, 'collab-bob');
  await bob.goto(url);
  await settled(bob, 4);
  await bob.click('.v3-views [data-view=fit]');
  await until(alice, () => !!document.querySelector('#cadPeers [data-peer=collab-bob]'));
  const ac = await center(alice), bc = await center(bob);
  let carol = null;
  const withCarol = async () => {
    if (carol) return carol;
    carol = await open(carolId, 'collab-carol');
    await carol.goto(`${BASE}/p/${pid}/edit`);
    await carol.waitForSelector('#doctabs [role=tab]', { timeout: 30000 });
    return carol;
  };

  // ================================================================ presence
  await section('presence', async () => {
    check('each sees the other in the Collaborators panel', await until(alice, () => !!document.querySelector('#cadPeers [data-peer=collab-bob]')) && await until(bob, () => !!document.querySelector('#cadPeers [data-peer=collab-alice]')));
    check('and as an avatar over the viewport', await alice.isVisible('.cad-avatars [data-avatar=collab-bob]') && (await alice.textContent('.cad-avatars [data-avatar=collab-bob]')) === 'BS');
    const colors = await Promise.all([alice, bob].map((p) => p.evaluate(() => { const c = window.JunctionCadCollab.collab.getState(); return { mine: c.myColor, theirs: c.people[0]?.color }; })));
    check('a person has one colour everywhere: what Bob sees for Alice is what Alice has', !!colors[0].mine && colors[0].mine === colors[1].theirs && colors[1].mine === colors[0].theirs, JSON.stringify(colors));

    // the pointer
    await bob.mouse.move(bc.x - 120, bc.y + 10, { steps: 4 });
    await bob.mouse.move(bc.x - 100, bc.y, { steps: 4 });
    const bobHover = await bob.evaluate(() => window.JunctionPartStudio.getState().hover);
    check('Bob\'s pointer is on the model', !!bobHover && !!bobHover.point, JSON.stringify(bobHover && bobHover.kind));
    const sees = await until(alice, () => { const el = document.querySelector('.peer-cursor[data-peer=collab-bob]'); return el && el.style.display !== 'none' && /Bob Stone/.test(el.textContent); });
    check('Alice sees Bob\'s pointer with his name', sees);
    await alice.waitForTimeout(400);
    const where = await alice.evaluate(() => {
      const st = window.JunctionPartStudio, c = window.JunctionCadCollab.collab.getState().people[0];
      const el = document.querySelector('.peer-cursor[data-peer=collab-bob]'), m = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(el.style.transform);
      const at = st.viewport.project(st.viewport.target.clone().set(...c.state.cur.p));
      return { drawn: [Number(m[1]), Number(m[2])], at: [at.x, at.y], hit: c.state.cur.hit };
    });
    check('it is drawn where his model point is on her screen', Math.hypot(where.drawn[0] - where.at[0], where.drawn[1] - where.at[1]) < 3 && where.hit, JSON.stringify(where));

    // the selection
    await click(bob, bc.x - 100, bc.y);
    const bobSel = await bob.evaluate(() => window.JunctionPartStudio.getState().selection.map((p) => p.kind + ':' + p.name));
    check('Bob selects a face', bobSel.length === 1, bobSel.join());
    const drawn = await until(alice, () => {
      const c = window.JunctionCadCollab.collab, p = c.getState().people[0];
      if (!p || !p.state.sel || p.state.sel.length !== 1) return false;
      let n = 0; c.overlay.people.get(p.cid).sel.traverse((o) => { if (o.isMesh || o.isLineSegments2 || o.isPoints) n++; });
      return n > 0;
    });
    check('Alice gets his selection and it is drawn in his colour', drawn);
    await alice.waitForTimeout(300);
    await shot(alice, '01-bob-pointer-and-selection');
    await bob.keyboard.press('Escape');

    // the view rectangle
    const viewShown = () => { const c = window.JunctionCadCollab.collab, p = c.getState().people[0]; return !!p && !!p.state.cam && c.overlay.people.get(p.cid).view.visible; };
    check('while Bob looks at what Alice looks at, his view is not drawn over hers', !(await alice.evaluate(viewShown)));
    await bob.click('.v3-views [data-view=front]');
    await bob.mouse.move(bc.x, bc.y); await bob.mouse.wheel(0, -400);
    check('he turns to the front and zooms in: Alice sees the rectangle of what he sees, with his name', await until(alice, viewShown) && await until(alice, () => /Bob Stone's view/i.test(document.querySelector('.peer-view[data-peer-view=collab-bob]')?.textContent || '')));
    await alice.waitForTimeout(300);
    await shot(alice, '01b-bob-view');
    await alice.uncheck('#cadPeers input[type=checkbox]');
    check('the view rectangles can be switched off', await until(alice, () => { const c = window.JunctionCadCollab.collab, p = c.getState().people[0]; return !c.overlay.people.get(p.cid).view.visible; }));
    await alice.check('#cadPeers input[type=checkbox]');
    await bob.click('.v3-views [data-view=iso]'); await bob.click('.v3-views [data-view=fit]');
    await bob.waitForTimeout(400);

    // the feature list
    await bob.click(`[data-feature-row="${ids.e2}"]`);
    check('a dot on the row Bob has selected', await until(alice, (id) => !!document.querySelector(`[data-feature-row="${id}"] [data-row-selected=collab-bob]`), ids.e2));
    await bob.dblclick(`[data-feature-row="${ids.e2}"]`);
    await bob.waitForSelector('.cad-dialog[data-feature=extrude]');
    check('a pencil on the row Bob has open', await until(alice, (id) => !!document.querySelector(`[data-feature-row="${id}"] [data-row-editing=collab-bob]`), ids.e2));
    check('the panel says what he is doing', await until(alice, () => /editing Extrude 2/.test(document.querySelector('#cadPeers [data-peer=collab-bob] [data-peer-doing]')?.textContent || '')));
    await alice.mouse.move(700, 500);
    await shot(alice, '02-bob-editing-extrude-2');
    await bob.keyboard.press('Escape');
    await bob.click('.cad-dialog >> text=Cancel').catch(() => {});
    check('the pencil goes when he closes the dialog', await until(alice, (id) => !document.querySelector(`[data-feature-row="${id}"] [data-row-editing]`), ids.e2));

    // presence must never rebuild anything
    await countRegens(alice);
    await bob.mouse.move(bc.x - 60, bc.y + 30, { steps: 10 });
    await click(bob, bc.x - 100, bc.y);
    await bob.click(`[data-feature-row="${ids.e1}"]`);
    await bob.keyboard.press('Escape');
    await alice.waitForTimeout(600);
    check('presence costs no rebuild on the other side', (await allRegens(alice)) === 0, `${await allRegens(alice)} regenerations`);
  });

  // ================================================================ follow
  await section('follow', async () => {
    await alice.click('.cad-avatars [data-avatar=collab-bob]');
    check('clicking an avatar follows', await until(alice, () => !!document.querySelector('[data-following=collab-bob]')));
    await alice.waitForTimeout(900);
    check('Alice\'s camera is Bob\'s', near(await cam(alice), await cam(bob)), JSON.stringify([await cam(alice), await cam(bob)]));
    await bob.click('.v3-views [data-view=top]');
    await bob.waitForTimeout(500);
    await bob.mouse.move(bc.x, bc.y); await bob.mouse.wheel(0, -300);
    await alice.waitForTimeout(1200);
    check('when he turns and zooms, her view follows', near(await cam(alice), await cam(bob)), JSON.stringify([await cam(alice), await cam(bob)]));
    check('Bob is told he is followed', /followed by Alice Liddell/.test(await bob.textContent('#cadPeers')));
    check('the Follow button in the panel shows it', (await alice.textContent('#cadPeers [data-peer=collab-bob] [data-follow]')) === 'Following');
    await shot(alice, '03-following-bob');
    await alice.mouse.move(ac.x, ac.y); await alice.mouse.wheel(0, 200);
    check('moving her own view stops it', await until(alice, () => !document.querySelector('[data-following]')));
    await bob.click('.v3-views [data-view=iso]'); await bob.click('.v3-views [data-view=fit]');
    await alice.click('.v3-views [data-view=iso]'); await alice.click('.v3-views [data-view=fit]');
    await alice.waitForTimeout(400);
  });

  // ================================================================ editing: different features
  await section('editing-different-features', async () => {
    await countRegens(alice); await countRegens(bob);
    await Promise.all([set(alice, ids.e1, ['params', 'depth'], 24), set(bob, ids.e2, ['params', 'depth'], 14)]);
    check('two people edit different features at once: both edits hold', await converged([alice, bob]) && (await feature(alice, ids.e1)).params.depth === 24 && (await feature(alice, ids.e2)).params.depth === 14);
    await settled(alice, 4); await settled(bob, 4);
    await alice.waitForTimeout(300);
    const built = [await regens(alice), await regens(bob)];
    check('each side rebuilds once per edit (its own and the other\'s), not more', built.every((n) => n >= 1 && n <= 2), `alice ${built[0]}, bob ${built[1]}`);
    const tops = await Promise.all([alice, bob].map((p) => p.evaluate(() => window.JunctionPartStudio.getState().bodies.map((b) => Math.round(b.mesh ? b.mesh.bbox[5] : -1)).sort().join())));
    check('and both show both results', tops[0] === '14,24' && tops[1] === '14,24', tops.join(' | '));
  });

  // ================================================================ editing: the same feature
  await section('editing-the-same-feature', async () => {
    await openDialog(alice, ids.e1); await openDialog(bob, ids.e1);
    check('both have Extrude 1 open, and each is told who else has', await until(alice, () => document.querySelector('[data-also-editing]')?.getAttribute('data-also-editing') === 'collab-bob') && await until(bob, () => document.querySelector('[data-also-editing]')?.getAttribute('data-also-editing') === 'collab-alice'));
    await shot(alice, '04-both-in-extrude-1');
    await bob.fill('.cad-dialog input[data-param=depth]', '30');
    await bob.click('.cad-dialog [data-accept]');
    check('Bob changes the depth and is done: Alice\'s open dialog takes his value', await until(alice, () => document.querySelector('.cad-dialog input[data-param=depth]')?.value === '30'));
    await alice.check('.cad-dialog input[data-param=flip]');
    await alice.click('.cad-dialog [data-accept]');
    await converged([alice, bob]);
    const merged = await feature(bob, ids.e1);
    check('Alice changes another field and is done: his depth and her field both hold', merged.params.depth === 30 && merged.params.flip === true, JSON.stringify(merged.params));

    // the same field
    await openDialog(alice, ids.e1);
    await alice.fill('.cad-dialog input[data-param=depth]', '11');
    await set(bob, ids.e1, ['params', 'depth'], 22);
    check('both change the same field: Alice is shown the conflict, with whose value it is', await until(alice, () => /Bob Stone changed Depth to 22/.test(document.querySelector('[data-conflict="params.depth"]')?.textContent || '')));
    check('her dialog still holds what she typed', (await alice.inputValue('.cad-dialog input[data-param=depth]')) === '11');
    await shot(alice, '05-conflict-on-depth');
    await alice.click('[data-conflict] [data-take-theirs]');
    check('"Use Bob\'s" puts his value in her dialog and ends the conflict', await until(alice, () => document.querySelector('.cad-dialog input[data-param=depth]').value === '22' && !document.querySelector('[data-conflict]')));
    await alice.fill('.cad-dialog input[data-param=depth]', '12');
    await set(bob, ids.e1, ['params', 'depth'], 23);
    await until(alice, () => !!document.querySelector('[data-conflict="params.depth"]'));
    await alice.click('[data-conflict] [data-keep-mine]');
    await alice.click('.cad-dialog [data-accept]');
    await converged([alice, bob]);
    check('"Keep mine" and Done: her value replaces his, knowingly, for both', (await feature(bob, ids.e1)).params.depth === 12 && (await feature(alice, ids.e1)).params.depth === 12);
    await set(alice, ids.e1, ['params', 'flip'], false);
  });

  // ================================================================ editing: delete under an open dialog
  await section('editing-delete-under-an-open-dialog', async () => {
    await openDialog(alice, ids.e2);
    await alice.fill('.cad-dialog input[data-param=depth]', '17');
    await menu(bob, `[data-feature-row="${ids.e2}"]`, 'Delete');
    check('Bob deletes the feature Alice is editing: her dialog closes and she is told, with her values kept', await until(alice, () => /Bob Stone deleted Extrude 2 while you were editing it/.test(document.querySelector('[data-rescue]')?.textContent || '')) && !(await alice.$('.cad-dialog')));
    await shot(alice, '06-deleted-under-dialog');
    await alice.click('[data-rescue] [data-restore]');
    await converged([alice, bob]);
    const back = await feature(bob, ids.e2);
    check('"Put it back" returns it for both, with what she had typed', !!back && back.params.depth === 17 && back.name === 'Extrude 2', JSON.stringify(back && back.params));
    await settled(alice, 4); await settled(bob, 4);

    // a dialog nothing was typed in loses nothing: no offer, just the news (once her last edit is well past)
    await alice.waitForTimeout(4500);
    await openDialog(alice, ids.e2);
    await menu(bob, `[data-feature-row="${ids.e2}"]`, 'Delete');
    await until(alice, () => !document.querySelector('.cad-dialog'));
    check('a delete under an untouched dialog offers nothing back', !(await alice.$('[data-rescue]')));
    await bob.focus('.cad-stage canvas'); await bob.keyboard.press('Control+z');
    await settled(alice, 4); await settled(bob, 4);
  });

  // ================================================================ editing: reorder under an open dialog
  await section('editing-reorder-under-an-open-dialog', async () => {
    await openDialog(alice, ids.e2);
    await alice.fill('.cad-dialog input[data-param=depth]', '9');
    await set(bob, ids.s2, ['order'], 'H');      // Sketch 2 moves above Extrude 1
    await until(alice, (id) => window.JunctionPartStudio.getState().features[1].id === id, ids.s2);
    check('Bob reorders while Alice edits: her dialog stays open with her value', (await alice.inputValue('.cad-dialog input[data-param=depth]')) === '9');
    await alice.click('.cad-dialog [data-accept]');
    await converged([alice, bob]);
    const order = await bob.evaluate(() => window.JunctionPartStudio.getState().features.map((f) => f.name).join());
    check('both the reorder and the edit hold', order === 'Sketch 1,Sketch 2,Extrude 1,Extrude 2' && (await feature(bob, ids.e2)).params.depth === 9, order);
    await settled(alice, 4); await settled(bob, 4);
  });

  // ================================================================ editing: bursts
  await section('editing-bursts', async () => {
    await Promise.all([burst(alice, ids.e1, 1, 40), burst(bob, ids.e1, 2, 40)]);
    const same = await converged([alice, bob]);
    const after = await feature(alice, ids.e1);
    check('forty rapid edits each to one parameter of one feature: both end on the same document', same && after.params.note1 === 39 && after.params.note2 === 39, `depth ${after.params.depth}`);
    await settled(alice, 4); await settled(bob, 4);
    const shown = await Promise.all([alice, bob].map((p) => p.evaluate((id) => { const s = window.JunctionPartStudio.getState(); return s.features.find((f) => f.id === id).params.depth + '/' + s.bodies.map((b) => Math.round((b.mesh || { bbox: [] }).bbox[5])).sort().join(); }, ids.e1)));
    check('and the same model', shown[0] === shown[1], shown.join(' | '));
  });

  // ================================================================ editing: offline
  await section('editing-offline', async () => {
    await offline(alice);
    await set(alice, ids.e1, ['params', 'depth'], 31);
    await set(alice, ids.e2, ['params', 'depth'], 6);
    await set(bob, ids.e2, ['params', 'flip'], true);
    await bob.evaluate((id) => window.JunctionPartStudio.commit([{ id, kind: 'MODIFIED', typeName: 'feature', props: [{ path: ['name'], value: 'Tall block' }] }]), ids.e1);
    check('offline, Alice goes on editing: her edits wait', (await unsaved(alice)) === 2 && (await feature(alice, ids.e1)).params.depth === 31);
    await alice.context().setOffline(false);
    check('back online, her edits are sent and his arrive: one document', await converged([alice, bob], 40000));
    const e1 = await feature(bob, ids.e1), e2 = await feature(bob, ids.e2);
    check('nothing either of them did is lost', e1.params.depth === 31 && e1.name === 'Tall block' && e2.params.depth === 6 && e2.params.flip === true, JSON.stringify([e1.name, e1.params.depth, e2.params.depth, e2.params.flip]));
    check('and they see each other again', await until(alice, () => !!document.querySelector('#cadPeers [data-peer=collab-bob]')) && await until(bob, () => !!document.querySelector('#cadPeers [data-peer=collab-alice]')));

    // a delete while the other is offline with an edit to the same feature
    await offline(alice);
    await set(alice, ids.e2, ['params', 'depth'], 8);
    await menu(bob, `[data-feature-row="${ids.e2}"]`, 'Delete');
    await alice.context().setOffline(false);
    check('Alice edits offline a feature Bob deletes meanwhile: on return she is told and offered it back', await until(alice, () => /Bob Stone deleted Extrude 2/.test(document.querySelector('[data-rescue]')?.textContent || ''), null, 40000));
    await alice.click('[data-rescue] [data-restore]');
    check('and it returns with her edit', await converged([alice, bob]) && (await feature(bob, ids.e2))?.params.depth === 8);
    await settled(alice, 4); await settled(bob, 4);
  });

  // ================================================================ a sketch, two people in it
  await section('a-sketch-two-people-in-it', async () => {
    await alice.dblclick(`[data-feature-row="${ids.s2}"]`);
    await bob.dblclick(`[data-feature-row="${ids.s2}"]`);
    check('both open one sketch: each is told', await until(alice, () => /in this sketch too/.test(document.querySelector('[data-also-editing]')?.textContent || '')) && await until(bob, () => /in this sketch too/.test(document.querySelector('[data-also-editing]')?.textContent || '')));
    await Promise.all([entity(alice, ids.s2, 'a1', { type: 'point', x: 20, y: 0 }), entity(bob, ids.s2, 'b1', { type: 'point', x: 40, y: 0 })]);
    await Promise.all([entity(alice, ids.s2, 'a2', { type: 'circle', center: 'a1', r: 2 }), entity(bob, ids.s2, 'b2', { type: 'circle', center: 'b1', r: 2 })]);
    await converged([alice, bob]);
    const ents = Object.keys((await feature(alice, ids.s2)).params.sketch.entities).sort().join();
    check('each draws in it at once: every entity of both is there', ents === 'a1,a2,b1,b2,l1,l2,l3,l4,p1,p2,p3,p4', ents);
    // one deletes a point the other's new curve uses
    await Promise.all([entity(alice, ids.s2, 'b1', null), entity(bob, ids.s2, 'b3', { type: 'circle', center: 'b1', r: 4 })]);
    await converged([alice, bob]);
    await alice.waitForTimeout(800);
    const state = await Promise.all([alice, bob].map((p) => p.evaluate((id) => { const s = window.JunctionPartStudio.getState(); return s.kernel.state + ':' + (s.reports[id] ? s.reports[id].status : '?'); }, ids.s2)));
    check('a point deleted under another person\'s new circle does not break the kernel for either', state.every((s) => /^ready:/.test(s)), state.join(' | '));
    await entity(alice, ids.s2, 'b2', null); await entity(alice, ids.s2, 'b3', null);
    await alice.focus('.cad-stage canvas'); await alice.click("[data-tool='Finish sketch']");
    await bob.click("[data-tool='Finish sketch']");
    await converged([alice, bob]);
    await settled(alice, 4); await settled(bob, 4);
  });

  // ================================================================ tabs
  await section('tabs', async () => {
    await withCarol();
    const tabNames = (page) => page.$$eval('#doctabs [role=tab]', (els) => els.map((e) => e.querySelector('.truncate').textContent.trim()).join());
    // (one tab per element: Home, the PCB with its views inside it, the part studio)
    const openTabs = (page) => page.$$eval('#doctabs [role=tab][aria-selected=true]', (els) => els.map((e) => e.querySelector('.truncate').textContent.trim()).join());
    check('Carol opens the project on the schematic', /^Home,CAD_collab_test,Schematic,Board,BOM,Part Studio 1$/.test(await tabNames(carol)) && (await openTabs(carol)) === 'CAD_collab_test,Schematic', `${await tabNames(carol)} / open: ${await openTabs(carol)}`);
    const on = (page, type) => page.evaluate((type) => document.querySelector(`#doctabs [role=tab][data-doc-type=${type}] [data-tab-people]`)?.getAttribute('data-tab-people') || '', type);
    check('her tabs show who is in the part studio', await until(carol, () => (document.querySelector('#doctabs [role=tab][data-doc-type=part_studio] [data-tab-people]')?.getAttribute('data-tab-people') || '').split(' ').sort().join() === 'collab-alice,collab-bob'), await on(carol, 'part_studio'));
    check('and theirs show her on the schematic', await until(alice, () => document.querySelector('#doctabs [role=tab][data-doc-type=kicad_sch] [data-tab-people]')?.getAttribute('data-tab-people') === 'collab-carol'), await on(alice, 'kicad_sch'));
    check('the panel lists her as elsewhere in the project', await until(alice, () => /in the schematic/.test(document.querySelector('#cadPeers [data-peer-elsewhere=collab-carol]')?.textContent || '')));
    await shot(alice, '07-tabs-and-people');

    await alice.click('[data-doc-add]');
    await alice.click('text=New assembly');
    await alice.waitForFunction(() => window.JunctionAssembly && window.JunctionAssembly.getState().loaded, null, { timeout: 30000 });
    check('Alice adds an assembly: it appears in Bob\'s tabs and in Carol\'s without a reload', await until(bob, () => !!document.querySelector('#doctabs [role=tab][data-doc-type=assembly]')) && await until(carol, () => !!document.querySelector('#doctabs [role=tab][data-doc-type=assembly]')), `${await tabNames(bob)} | ${await tabNames(carol)}`);
    check('they are told who did it', /Alice Liddell added Assembly 1/.test((await bob.textContent('[data-docs-notice]').catch(() => '')) || ''));
    check('and the tabs show Alice went there', await until(bob, () => document.querySelector('#doctabs [role=tab][data-doc-type=assembly] [data-tab-people]')?.getAttribute('data-tab-people') === 'collab-alice'));
    await alice.dblclick('#doctabs [role=tab][data-doc-type=assembly]');
    await alice.fill("#doctabs input[aria-label='Document name']", 'Gearbox');
    await alice.keyboard.press('Enter');
    check('she renames it: the others see the new name', await until(bob, () => /Gearbox/.test(document.querySelector('#doctabs [role=tab][data-doc-type=assembly]')?.textContent || '')) && await until(carol, () => /Gearbox/.test(document.querySelector('#doctabs [role=tab][data-doc-type=assembly]')?.textContent || '')));
    await shot(bob, '08-bob-sees-new-tab');

    // follow to another tab
    await bob.click('#cadPeers [data-peer-elsewhere=collab-alice] [data-follow]');
    check('Bob follows Alice from the panel: he is taken to the tab she is on', await until(bob, () => !!window.JunctionAssembly && document.querySelector('#doctabs [role=tab][data-doc-type=assembly]')?.getAttribute('aria-selected') === 'true'));
    await alice.click('#doctabs [role=tab][data-doc-type=part_studio]');
    await settled(alice, 4);
    check('she goes back to the part studio: he follows her there and keeps following', await until(bob, () => !!window.JunctionPartStudio && !!document.querySelector('[data-following=collab-alice]'), null, 30000),
      await bob.evaluate(() => JSON.stringify({ studio: !!window.JunctionPartStudio, memo: window.JunctionFollow || null, follow: window.JunctionCadCollab?.collab.getState().follow, people: window.JunctionCadCollab?.collab.getState().people.map((p) => p.key), room: window.JunctionRoom?.getState().members.map((m) => m.key + '@' + m.tab) })));
    await bob.waitForTimeout(1200);
    check('with her camera', near(await cam(bob), await cam(alice)), JSON.stringify([await cam(bob), await cam(alice)]));
    await bob.click('[data-follow-stop]');
    await settled(bob, 4);

    // delete
    await carol.click('#doctabs [role=tab][data-doc-type=assembly]');
    await carol.waitForFunction(() => window.JunctionAssembly && window.JunctionAssembly.getState().loaded, null, { timeout: 30000 });
    await alice.click('#doctabs [role=tab][data-doc-type=assembly]', { button: 'right' });
    await alice.click('[role=menu] >> text=Delete');
    await alice.click('[data-k=confirm-ok]');
    check('Alice deletes the assembly: its tab goes for Bob', await until(bob, () => !document.querySelector('#doctabs [role=tab][data-doc-type=assembly]')));
    const told = (await carol.textContent('[data-docs-notice]').catch(() => '')) || '';
    check('Carol, who had it open, is moved to another document and told who deleted it', await until(carol, () => !document.querySelector('#doctabs [role=tab][data-doc-type=assembly]') && !document.querySelector('.cad-root[data-doc-kind=assembly]') && window.CollabApp.getState().view === 'editor') && /Alice Liddell deleted Gearbox/.test(told), told);
    await carol.click('#doctabs [role=tab][data-doc-type=part_studio]');
    await settled(carol, 4);
  });

  // ================================================================ three people
  await section('three-people', async () => {
    await withCarol();
    if (!(await carol.evaluate(() => !!window.JunctionPartStudio))) { await carol.click('#doctabs [role=tab][data-doc-type=part_studio]'); await settled(carol, 4); }
    check('three people in one part studio: each sees the other two', (await Promise.all([alice, bob, carol].map((p) => until(p, () => document.querySelectorAll('#cadPeers [data-peer]').length === 2)))).every(Boolean));
    await carol.click('.v3-views [data-view=fit]');
    const cc = await center(carol);
    await carol.mouse.move(cc.x + 150, cc.y - 20, { steps: 5 });
    await click(carol, cc.x + 150, cc.y - 20);
    await bob.mouse.move(bc.x - 100, bc.y + 10, { steps: 5 });
    await alice.waitForTimeout(600);
    await alice.mouse.move(ac.x, ac.y + 200);
    await shot(alice, '09-three-people');
    const hues = await alice.evaluate(() => { const s = window.JunctionCadCollab.collab.getState(); return [s.myColor, ...s.people.map((p) => p.color)]; });
    check('the three have three colours (the room settles it when the server hands out one twice)', new Set(hues).size === 3 && hues.every(Boolean), hues.join(' '));
    // the same in the dark theme
    await alice.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await alice.waitForTimeout(500);
    await shot(alice, '09b-three-people-dark');
    await alice.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await Promise.all([burst(alice, ids.e1, 1, 25), burst(bob, ids.e1, 2, 25), burst(carol, ids.e1, 3, 25), set(carol, ids.e2, ['params', 'depth'], 13)]);
    const three = await converged([alice, bob, carol]);
    const f3 = await feature(carol, ids.e1);
    check('three people edit one feature in bursts: one document for all', three && f3.params.note1 === 24 && f3.params.note2 === 24 && f3.params.note3 === 24);
    await settled(alice, 4); await settled(bob, 4); await settled(carol, 4);
  });

  // ================================================================ comments
  await section('comments', async () => {
    await alice.click('.v3-views [data-view=iso]'); await alice.click('.v3-views [data-view=fit]');
    await alice.waitForTimeout(400);
    const topFace = await alice.evaluate((e1) => {
      const st = window.JunctionPartStudio, b = st.getState().bodies.find((x) => x.createdBy === e1) || st.getState().bodies[0];
      const mesh = window.JunctionCadCollab.meshes.get(b.id).mesh, name = mesh.faces.names.find((n) => n.includes(':end:'));
      st.select([{ kind: 'face', body: b.id, name, point: [-20, 0, mesh.bbox[5]] }]);
      return { body: b.id, name, top: mesh.bbox[5] };
    }, ids.e1);
    await alice.click('[data-tool=Comment]');
    await alice.waitForSelector('[data-compose] textarea');
    await alice.fill('[data-compose] textarea', 'Is this face flat enough for the gasket?');
    await shot(alice, '10-writing-a-comment');
    await alice.click('[data-compose] button[type=submit]');
    check('Alice comments on a face: a pin on it and a card in the panel', await until(alice, () => document.querySelectorAll('.cad-pins [data-pin]').length === 1 && /Face of/.test(document.querySelector('#cadComments [data-thread]')?.textContent || '')));
    check('Bob gets the thread without a reload, pinned to the same face', await until(bob, () => document.querySelectorAll('.cad-pins [data-pin]').length === 1 && /gasket/.test(document.querySelector('#cadComments [data-thread]')?.textContent || '')));
    const stored = await alice.evaluate(async (docId) => (await (await fetch(`/api/docs/${docId}/comments`)).json()).comments[0], docId);
    check('it is a platform comment, anchored to the face by its stable name', stored.anchor && stored.anchor.kind === 'item' && stored.anchor.id === 'face:' + topFace.name && stored.anchor.item === topFace.body, JSON.stringify(stored.anchor));
    const pinAt = (page) => page.evaluate(() => { const el = document.querySelector('.cad-pins [data-pin]'), m = /translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(el.style.transform); return [Number(m[1]), Number(m[2])]; });
    await bob.click('.v3-views [data-view=iso]'); await bob.click('.v3-views [data-view=fit]');
    await bob.waitForTimeout(400);
    const before = await pinAt(bob);
    await bob.click('.cad-pins [data-pin]');
    await bob.waitForSelector('[data-thread-open] textarea');
    await bob.fill('[data-thread-open] textarea', 'It is. 0.05 mm over the whole face.');
    await bob.click('[data-thread-open] button[type=submit]');
    check('Bob opens the pin and replies: Alice sees the reply', await until(alice, () => /1 reply/.test(document.querySelector('#cadComments [data-thread]')?.textContent || '')));
    await shot(bob, '11-thread-open');
    await bob.click('[data-thread-open] .cmt-x');
    await set(alice, ids.e1, ['params', 'depth'], 40);
    await until(bob, (top) => { const b = window.JunctionPartStudio.getState().bodies.find((x) => x.mesh && Math.abs(x.mesh.bbox[5] - 40) < 1e-6); return !!b; }, null);
    await bob.waitForTimeout(500);
    const moved = await pinAt(bob);
    check('the face moves when the depth changes: the pin moves with it', before[1] - moved[1] > 8, `${before.join()} → ${moved.join()}`);
    // a feature
    await alice.keyboard.press('Escape');
    await alice.evaluate(() => window.JunctionPartStudio.select([]));
    await alice.click(`[data-feature-row="${ids.e2}"]`);
    await alice.click('#cadComments [data-add-comment]');
    await alice.waitForSelector('[data-compose] textarea');
    await alice.fill('[data-compose] textarea', 'Should this be 12 mm?');
    await alice.keyboard.press('Control+Enter');
    check('a comment on a feature shows as a count on its row, for both', await until(alice, (id) => document.querySelector(`[data-feature-row="${id}"] [data-row-comments]`)?.textContent === '1', ids.e2) && await until(bob, (id) => document.querySelector(`[data-feature-row="${id}"] [data-row-comments]`)?.textContent === '1', ids.e2));
    await bob.click(`[data-feature-row="${ids.e2}"] [data-row-comments]`);
    await bob.waitForSelector('[data-thread-open] [data-resolve]');
    await bob.click('[data-thread-open] [data-resolve]');
    check('Bob resolves it: the count goes for Alice and the thread is under Resolved', await until(alice, (id) => !document.querySelector(`[data-feature-row="${id}"] [data-row-comments]`), ids.e2) && await until(alice, () => /Resolved1/.test(document.querySelector('#cadComments .cmt-tabs')?.textContent || '')));
    // nothing selected: the tool waits for a click on the model
    for (const p of [alice, bob]) if (await p.$('[data-thread-open] .cmt-x')) await p.click('[data-thread-open] .cmt-x');
    await until(alice, () => document.querySelectorAll('.cad-pins [data-pin]').length === 1);
    await bob.evaluate(() => { window.JunctionPartStudio.select([]); window.JunctionPartStudio.selectFeature(null); });
    await bob.click('[data-tool=Comment]');
    check('with nothing selected the Comment tool asks for a click', await until(bob, () => !!document.querySelector('[data-comment-picking]')));
    await click(bob, bc.x + 130, bc.y + 60);
    await bob.waitForSelector('[data-compose] textarea');
    const label = await bob.textContent('[data-compose] .cmt-anchor');
    await bob.fill('[data-compose] textarea', 'Chamfer here.');
    await bob.click('[data-compose] button[type=submit]');
    check('the click names what the thread is about, and the thread appears for Alice', /^(Face|Edge|Vertex) of /.test(label || '') && await until(alice, () => document.querySelectorAll('.cad-pins [data-pin]').length === 2), label || '');
    await bob.waitForSelector('[data-thread-open] .acts .del', { state: 'attached' });
    await bob.hover('[data-thread-open] .cmt-item');
    await bob.click('[data-thread-open] .acts .del');
    check('Bob deletes his comment: its pin goes for Alice too', await until(alice, () => document.querySelectorAll('.cad-pins [data-pin]').length === 1),
      JSON.stringify(await Promise.all([alice, bob].map((p) => p.evaluate(() => { const s = window.JunctionCadCollab.comments.getState(); return { n: s.comments.map((c) => c.id + (c.resolved ? 'r' : '')), open: s.open, error: s.error, pins: document.querySelectorAll('.cad-pins [data-pin]').length }; })))));
    // the geometry goes
    await menu(alice, `[data-feature-row="${ids.e1}"]`, 'Suppress');
    check('when the face is gone the pin stays where the thread was started, marked as lost', await until(bob, () => !!document.querySelector('.cad-pins [data-pin][data-pin-lost]')));
    await menu(alice, `[data-feature-row="${ids.e1}"]`, 'Unsuppress');
    check('and is on the face again when the face is back', await until(bob, () => !!document.querySelector('.cad-pins [data-pin]:not([data-pin-lost])')));
    await bob.mouse.move(bc.x, bc.y + 250);
    await bob.waitForTimeout(400);
    await shot(bob, '12-pins-and-panel');
  });

  // ================================================================ the stored file
  await section('the-stored-file', async () => {
    await converged(carol ? [alice, bob, carol] : [alice, bob]);
    const file = await alice.evaluate(async ({ pid, docId }) => {
      const a = await fetch(`/api/projects/${pid}/archive`); await a.arrayBuffer();
      const r = await fetch(`/api/docs/${docId}/content?v=${Date.now()}`);
      return { snap: r.headers.get('x-snapshot-seq'), head: r.headers.get('x-head-seq'), text: await r.text() };
    }, { pid, docId });
    const mine = JSON.parse(await docText(alice));
    let theirs = null; try { theirs = JSON.parse(file.text).items; } catch { /* not JSON */ }
    const sort = (v) => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v;
    check('after all of that, the file the server folded is the document the browsers hold', !!theirs && file.snap === file.head && JSON.stringify(sort(theirs.slice().sort((a, b) => (a.id < b.id ? -1 : 1)))) === JSON.stringify(mine), `snapshot ${file.snap} of ${file.head}`);
  });

  check('no script errors on any page', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  console.error('the run stopped:', e);
  fail++;
} finally {
  await browser.close();
  try { sql("DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE github_id IN (991001, 991002, 991003))"); } catch { /* left for the next run */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
