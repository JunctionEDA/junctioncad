// Edit > Edit Track & Via Properties (KiCad's DIALOG_GLOBAL_EDIT_TRACKS_AND_VIAS) and Global Deletions' greyed
// filters in the web board editor (web/domains/pcb/editor/pcbdialogs/global-tracks.ts, global-delete.ts), on KiCad's pic_programmer
// demo: scope, every filter, both actions, Apply / Apply and Close, undo.  `pg` and `playwright` come from the script's
// node_modules or NODE_PATH; E2E_STATIC=<server/static> serves the web bundles from that folder.
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [E2E_STATIC=…] [SHOTS=/some/dir] node global-tracks-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
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
const uid = (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [9802, 'gtv-alice', 'Alice'])).rows[0].id;
await db.query('DELETE FROM projects WHERE owner_id = $1', [uid]);
const jwt = mintJwt(uid, 'gtv-alice');


const demo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'demos', 'pic_programmer');
const dir = fs.mkdtempSync('/tmp/gtv-ui-');
execSync(`cd "${demo}" && zip -qr "${dir}/p.zip" pic_programmer.kicad_pro pic_programmer.kicad_sch pic_sockets.kicad_sch pic_programmer.kicad_sym pic_programmer.kicad_pcb sym-lib-table fp-lib-table`);
const form = new FormData(); form.append('name', 'Global tracks'); form.append('archive', new Blob([fs.readFileSync(path.join(dir, 'p.zip'))]), 'p.zip');
const res = await fetch(BASE + '/api/projects', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form });
const created = await res.json();
const pcb = created.docs && created.docs.find((d) => d.path === 'pic_programmer.kicad_pcb');
check('project uploaded', res.status === 200 && !!pcb, JSON.stringify(created).slice(0, 200));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: 'dark' });
const page = await ctx.newPage(); page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
if (STATIC) await serveStatic(page, STATIC);
await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=${encodeURIComponent(`/p/${created.projectId}/edit?doc=${pcb.docId}`)}`);
await page.waitForFunction(() => { const E = window.CollabEditor; return E && E.kdoc && E.kdoc.items.size > 1 && E.ws && E.ws.readyState === 1 && window.PcbTools; }, null, { timeout: 60000 });
await page.waitForTimeout(1500);
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
// the board's tracks and vias as data
const stats = () => page.evaluate(() => {
  const E = window.CollabEditor, kid = (n, k) => n.find((c) => Array.isArray(c) && c[0] === k);
  const w = {}, v = {}, layers = {}; let rings = 0;
  for (const it of E.kdoc.items.values()) {
    if (it.kind === 'segment' || it.kind === 'arc') { const x = String(kid(it.node, 'width')[1]); w[x] = (w[x] || 0) + 1; const l = String(kid(it.node, 'layer')[1]); layers[l] = (layers[l] || 0) + 1; }
    if (it.kind === 'via') { const x = kid(it.node, 'size')[1] + '/' + kid(it.node, 'drill')[1]; v[x] = (v[x] || 0) + 1; if (kid(it.node, 'remove_unused_layers')) rings++; }
  }
  const so = (o) => Object.fromEntries(Object.entries(o).sort());
  return { w: so(w), v: so(v), layers: so(layers), rings };
});
const open = async () => { await page.evaluate(() => window.CollabApp.dispatch({ type: 'action', id: 'module:editTracksAndVias' })); await page.waitForSelector('[data-k="setToSpecifiedValues"]'); };
const dlg = '.kd-dialog:has([data-k="setToSpecifiedValues"])';
const val = (k) => page.evaluate((k) => { const e = document.querySelector(`[data-k="${k}"]`); return e.type === 'checkbox' || e.type === 'radio' ? e.checked : e.value; }, k);
const options = (k) => page.evaluate((k) => [...document.querySelector(`[data-k="${k}"]`).querySelectorAll('option')].map((o) => o.textContent), k);
const pick = (k, label) => page.evaluate(([k, label]) => { const e = document.querySelector(`[data-k="${k}"]`); const i = [...e.querySelectorAll('option')].findIndex((o) => o.textContent === label); e.selectedIndex = i; e.dispatchEvent(new Event('change', { bubbles: true })); return i; }, [k, label]);
// every filter off, the specified-values action, the given scope (the dialog keeps its controls between openings)
const fresh = async (scope = { tracks: true, vias: true }) => {
  for (const k of ['netFilterOpt', 'netclassFilterOpt', 'layerFilterOpt', 'filterByTrackWidth', 'filterByViaSize', 'selectedItemsFilter']) if (await val(k)) await page.click(`[data-k="${k}"]`);
  if (!(await val('setToSpecifiedValues'))) await page.click('[data-k="setToSpecifiedValues"]');
  for (const k of ['tracks', 'vias']) if ((await val(k)) !== scope[k]) await page.click(`[data-k="${k}"]`);
  if (scope.vias && !(await val('vias'))) await page.click('[data-k="vias"]');
};
const applyClose = async () => { await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Apply and Close'); b.click(); }); await page.waitForSelector('[data-k="setToSpecifiedValues"]', { state: 'detached' }); await page.waitForTimeout(300); };

try {
  const before = await stats();
  check('the demo board has tracks and vias', Object.keys(before.w).length > 0 && Object.keys(before.v).length > 0, JSON.stringify(before));
  await open();
  check('title is "Set Track and Via Properties"', await page.evaluate(() => [...document.querySelectorAll('.kd-title, .kd-head, .kd-dialog header')].some((e) => /Set Track and Via Properties/.test(e.textContent)) || /Set Track and Via Properties/.test(document.body.textContent)));
  check('buttons are Apply and Close / Close', await page.evaluate(() => { const t = [...document.querySelectorAll('button')].map((b) => b.textContent.trim()); return t.includes('Apply and Close') && t.includes('Close'); }));
  check('scope starts with Tracks and every via type checked', (await val('tracks')) && (await val('vias')) && (await val('throughVias')) && (await val('microVias')) && (await val('blindVias')) && (await val('buriedVias')));
  await page.click('[data-k="microVias"]');
  check('Vias turns undetermined when one via type is off', await page.evaluate(() => document.querySelector('[data-k="vias"]').indeterminate));
  await page.click('[data-k="vias"]');
  const allSame = await page.evaluate(() => ['throughVias', 'microVias', 'blindVias', 'buriedVias'].map((k) => document.querySelector(`[data-k="${k}"]`).checked));
  check('clicking Vias sets the four via types together', allSame.every((x) => x === allSame[0]), JSON.stringify(allSame));
  if (!allSame[0]) await page.click('[data-k="vias"]');
  const tw = await options('trackWidth'), vs = await options('viaSizes');
  check('track width choice lists the pre-defined widths and ends with "-- leave unchanged --"', tw.length > 1 && tw.at(-1) === '-- leave unchanged --' && tw.slice(0, -1).every((t) => /^Track: /.test(t)), JSON.stringify(tw));
  check('via size choice lists the pre-defined sizes and ends with "-- leave unchanged --"', vs.at(-1) === '-- leave unchanged --' && vs.slice(0, -1).every((t) => /^Via: /.test(t)), JSON.stringify(vs));
  check('every action value starts at "-- leave unchanged --"', await page.evaluate(() => ['layerCtrl', 'trackWidth', 'viaSizes', 'annularRings', 'protectionFeatures'].every((k) => { const e = document.querySelector(`[data-k="${k}"]`); return e.options[e.selectedIndex].textContent === '-- leave unchanged --'; })));
  check('annular rings choice is KiCad\'s', JSON.stringify((await options('annularRings')).slice(0, 4)) === JSON.stringify(['All copper layers', 'Start, end, and connected layers', 'Connected layers only', 'Start and end layers only']));
  await page.click('[data-k="setToDesignRuleValues"]');
  check('net class action disables the specified values', await page.evaluate(() => ['layerCtrl', 'trackWidth', 'viaSizes', 'annularRings'].every((k) => document.querySelector(`[data-k="${k}"]`).hasAttribute('disabled'))));
  await page.click('[data-k="setToSpecifiedValues"]');
  check('specified action enables them again', await page.evaluate(() => ['layerCtrl', 'trackWidth', 'viaSizes', 'annularRings'].every((k) => !document.querySelector(`[data-k="${k}"]`).hasAttribute('disabled'))));
  await shot('06-edit-track-via-properties');
  // nothing chosen: nothing changes
  await applyClose();
  check('Apply with everything left unchanged changes nothing', JSON.stringify(await stats()) === JSON.stringify(before));

  // a width filter + a pre-defined width
  const widths = Object.entries(before.w).sort((a, b) => b[1] - a[1]);
  const [fromW, fromN] = widths[0];
  await open();
  const target = tw.find((t) => t !== '-- leave unchanged --' && !t.startsWith(`Track: ${Number(fromW).toFixed(3)} mm`) && !t.startsWith(`Track: ${Number(fromW)} mm`));
  await page.fill('[data-k="trackWidthFilter"]', String(fromW));
  check('typing a width checks "Filter tracks by width"', await val('filterByTrackWidth'));
  await pick('trackWidth', target);
  await applyClose();
  const after = await stats();
  const tgtMm = String(Number(/Track: ([\d.]+) mm/.exec(target)[1]));
  check(`the ${fromN} tracks ${fromW} mm wide became ${tgtMm} mm, the others kept theirs`, !after.w[fromW] && after.w[tgtMm] === (before.w[tgtMm] || 0) + fromN && JSON.stringify(after.v) === JSON.stringify(before.v), JSON.stringify(after.w));
  await page.keyboard.press('Control+z'); await page.waitForTimeout(400);
  check('one undo takes the whole edit back', JSON.stringify(await stats()) === JSON.stringify(before), JSON.stringify(await stats()));

  // vias only: annular rings
  await open();
  await page.click('[data-k="tracks"]');
  await pick('annularRings', 'Start, end, and connected layers');
  await applyClose();
  const a2 = await stats(); const nVias = Object.values(before.v).reduce((a, b) => a + b, 0);
  check('annular rings set on every via, tracks untouched', a2.rings === nVias && JSON.stringify(a2.w) === JSON.stringify(before.w), JSON.stringify(a2));
  await page.keyboard.press('Control+z'); await page.waitForTimeout(400);

  // net class values
  await open();
  if (!(await val('tracks'))) await page.click('[data-k="tracks"]');
  await page.click('[data-k="setToDesignRuleValues"]');
  check('the width filter is remembered while the editor is open, as KiCad keeps a dialog\'s controls', (await val('filterByTrackWidth')) && (await val('trackWidthFilter')) === String(fromW));
  await page.click('[data-k="filterByTrackWidth"]');
  await applyClose();
  const a3 = await stats();
  const nc = await page.evaluate(() => { const P = window.PcbTools, s = P.designSettings(window.CollabEditor.proSettings || null); return Object.values(s.netclasses).map((c) => String(c.track_width)); });
  check('net class action leaves only net class track widths', Object.keys(a3.w).every((w) => nc.includes(w)), JSON.stringify({ w: a3.w, nc }));
  await page.keyboard.press('Control+z'); await page.waitForTimeout(400);
  check('undo restores the board', JSON.stringify(await stats()) === JSON.stringify(before));

  // the via diameter filter ticks itself on typing too (OnViaSizeText), the protection features follow KiCad
  await open();
  await page.fill('[data-k="viaSizeFilter"]', '0.8');
  check('typing a via diameter checks "Filter vias by diameter"', await val('filterByViaSize'));
  await page.click('[data-k="filterByViaSize"]');
  const prot = await options('protectionFeatures');
  check('via protection features list IPC-4761 types and end with "-- leave unchanged --"', prot.length > 3 && prot.at(-1) === '-- leave unchanged --', JSON.stringify(prot));
  await page.click('[data-k="setToDesignRuleValues"]');
  check('the protection features choice stays enabled under the net class action, as KiCad leaves it', await page.evaluate(() => !document.querySelector('[data-k="protectionFeatures"]').hasAttribute('disabled')));
  await page.click('[data-k="setToSpecifiedValues"]');
  if (await val('filterByTrackWidth')) await page.click('[data-k="filterByTrackWidth"]');

  // Apply keeps the dialog: vias only, annular rings (and a pre-defined via size when the board has one)
  await fresh({ tracks: false, vias: true });
  const vsTarget = vs.find((t) => t !== '-- leave unchanged --');
  if (vsTarget) await pick('viaSizes', vsTarget);
  await pick('annularRings', 'Connected layers only');
  await page.evaluate(() => { const b = [...document.querySelectorAll('.kd-dialog button')].find((x) => x.textContent.trim() === 'Apply'); b.click(); });
  await page.waitForTimeout(500);
  const a4 = await stats();
  const m = vsTarget ? /Via: ([\d.]+)[^/]*\/\s*([\d.]+)/.exec(vsTarget) : null;
  check('Apply keeps the dialog open', await page.evaluate(() => !!document.querySelector('[data-k="setToSpecifiedValues"]')));
  check('Apply writes every via (annular rings' + (vsTarget ? ', ' + vsTarget : '') + '), tracks untouched',
    a4.rings === nVias && JSON.stringify(a4.w) === JSON.stringify(before.w) && (!m || (Object.keys(a4.v).length === 1 && Object.keys(a4.v)[0] === `${Number(m[1])}/${Number(m[2])}`)), JSON.stringify({ v: a4.v, rings: a4.rings, vsTarget }));
  await page.evaluate(() => { const b = [...document.querySelectorAll('.kd-dialog button')].find((x) => x.textContent.trim() === 'Close'); b.click(); });
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(400);
  check('undo restores the vias', JSON.stringify(await stats()) === JSON.stringify(before));

  // a layer filter and the Layer action: B.Cu tracks move to F.Cu, the rest stay
  const bName = await page.evaluate(() => window.PcbTools.boardLayerName(window.CollabEditor.kdoc, 'B.Cu'));
  const fName = await page.evaluate(() => window.PcbTools.boardLayerName(window.CollabEditor.kdoc, 'F.Cu'));
  await open(); await fresh({ tracks: true, vias: false });
  await pick('layerFilter', bName);
  check('picking a layer checks "Filter items by layer"', await val('layerFilterOpt'));
  await pick('layerCtrl', fName);
  await applyClose();
  const a5 = await stats();
  check('the B.Cu tracks moved to F.Cu, nothing else changed', !a5.layers['B.Cu'] && a5.layers['F.Cu'] === (before.layers['F.Cu'] || 0) + (before.layers['B.Cu'] || 0) && JSON.stringify(a5.v) === JSON.stringify(before.v), JSON.stringify(a5.layers));
  await page.keyboard.press('Control+z'); await page.waitForTimeout(400);
  check('undo moves them back', JSON.stringify(await stats()) === JSON.stringify(before));

  // a net filter: only that net's tracks take the width
  const netOf = () => page.evaluate(() => { const E = window.CollabEditor, kid = (n, k) => n.find((c) => Array.isArray(c) && c[0] === k); const by = {};
    for (const it of E.kdoc.items.values()) if (it.kind === 'segment' || it.kind === 'arc') { const nn = kid(it.node, 'net'); const net = nn ? String(nn[1]) : ''; const nm = /^\d+$/.test(net) ? (E.kdoc.nets && E.kdoc.nets.get(Number(net))) || net : net; (by[nm] = by[nm] || []).push(String(kid(it.node, 'width')[1])); }
    return by; });
  const byNet0 = await netOf();
  const netName = Object.entries(byNet0).filter(([n]) => n && n !== '0').sort((a, b) => b[1].length - a[1].length)[0][0];
  await open(); await fresh({ tracks: true, vias: false });
  await pick('netFilter', netName);
  check('picking a net checks "Filter items by net"', await val('netFilterOpt'));
  const tgt2 = tw.find((t) => t !== '-- leave unchanged --' && byNet0[netName].some((w) => !t.startsWith(`Track: ${Number(w).toFixed(3)} mm`)));
  await pick('trackWidth', tgt2);
  await applyClose();
  const byNet1 = await netOf(); const w2 = String(Number(/Track: ([\d.]+) mm/.exec(tgt2)[1]));
  check(`every ${netName} track is ${w2} mm, other nets kept theirs`, byNet1[netName].every((w) => w === w2) && Object.keys(byNet0).filter((n) => n !== netName).every((n) => JSON.stringify(byNet0[n]) === JSON.stringify(byNet1[n])), JSON.stringify(byNet1[netName].slice(0, 5)));
  await page.keyboard.press('Control+z'); await page.waitForTimeout(400);
  check('the net filter is remembered for the session (g_netFilter)', await (async () => { await open(); const v = await page.evaluate(() => { const e = document.querySelector('[data-k="netFilter"]'); return e.options[e.selectedIndex].textContent; }); await page.keyboard.press('Escape'); await page.waitForTimeout(300); return v === netName; })());

  // Selected items only: one selected track changes
  const one = await page.evaluate(() => { const E = window.CollabEditor; const it = [...E.kdoc.items.values()].find((i) => i.kind === 'segment'); E.api.toolCtx().setSelection([it.id]); return it.id; });
  await open(); await fresh({ tracks: true, vias: false });
  await page.click('[data-k="selectedItemsFilter"]');
  const w3 = Number(await page.evaluate((id) => window.CollabEditor.kdoc.items.get(id).node.find((c) => Array.isArray(c) && c[0] === 'width')[1], one));
  const tgt3 = tw.find((t) => t !== '-- leave unchanged --' && !t.startsWith('Track: ' + w3.toFixed(3)) && !t.startsWith(`Track: ${w3} mm`));
  await pick('trackWidth', tgt3);
  await applyClose();
  const changed = await page.evaluate((id) => String(window.CollabEditor.kdoc.items.get(id).node.find((c) => Array.isArray(c) && c[0] === 'width')[1]), one);
  const a6 = await stats(); const diff = Object.keys({ ...a6.w, ...before.w }).reduce((n, k) => n + Math.abs((a6.w[k] || 0) - (before.w[k] || 0)), 0);
  check('"Selected items only" changes just the selected track', diff === 2 && changed === String(Number(/Track: ([\d.]+) mm/.exec(tgt3)[1])), JSON.stringify({ diff, changed }));
  await page.keyboard.press('Control+z'); await page.waitForTimeout(400);
  check('the board is back to where it started', JSON.stringify(await stats()) === JSON.stringify(before));

  // Global Deletions: the filters grey out with their item kind
  await page.evaluate(() => window.CollabApp.dispatch({ type: 'action', id: 'module:globalDeletions' }));
  await page.waitForSelector('[data-k="lockedTracks"]');
  const grey = () => page.evaluate(() => { const e = document.querySelector('[data-k="lockedTracks"]'), o = document.querySelector('[data-k="zones"]'); return { disabled: e.disabled, dim: getComputedStyle(e.closest('label')).color !== getComputedStyle(o.closest('label')).color }; });
  const g0 = await grey();
  check('Global Deletions: track filters are disabled and greyed while Tracks is off', g0.disabled && g0.dim, JSON.stringify(g0));
  await page.click('[data-k="tracks"]');
  const g1 = await grey();
  check('…and enabled in the normal colour once Tracks is on', !g1.disabled && !g1.dim, JSON.stringify(g1));
  await shot('07-global-deletions');
  await page.keyboard.press('Escape');
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) { check('test ran to the end', false, (e.stack || String(e)) + ' ERRORS ' + errors.join(' | ')); await shot('gtv-failure'); }
await browser.close(); await db.end();
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
