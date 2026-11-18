// End-to-end test of the MCP tools that make the assistant a visible collaborator (web/domains/pcb/mcp/teammate.ts):
// highlight, get_selection, trace_net and the scoped pictures of render_view.  Two real clients are in the
// documents while the tools run: a browser signed in as a second person (Playwright), and a bare
// collaboration socket, so that "everyone sees it" is checked on the wire and on the canvas.
//
// Server and libraries as for mcp-e2e.mjs (see its header), then:
//   E2E_PG_URL=… E2E_JWT_SECRET=testsecret [SHOTS=dir] [KEEP=1] node mcp-teammate-e2e.mjs
// KEEP=1 reuses the project of an earlier run instead of designing the board again (about two minutes).
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import pg from 'pg';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL, SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ' — ' + String(detail).slice(0, 500) : ''}`); ok ? pass++ : fail++; return ok; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100); } return false; };
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000); const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 7200 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false }); await db.connect();
const user = async (gid, login, name) => (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3)
  ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name RETURNING id`, [gid, login, name])).rows[0].id;
const ada = await user(9521, 'tm-ada', 'Ada'), bob = await user(9522, 'tm-bob', 'Bob');
const adaJwt = mintJwt(ada, 'tm-ada'), bobJwt = mintJwt(bob, 'tm-bob');

let rpcId = 0;
async function call(name, args) {
  const r = await (await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${adaJwt}`, 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) })).json();
  if (!r.result) return { isError: true, text: JSON.stringify(r.error) };
  const text = (r.result.content.find((c) => c.type === 'text') || {}).text || ''; let data = null; try { data = JSON.parse(text); } catch { /* prose */ }
  return { isError: !!r.result.isError, text, data, image: r.result.content.find((c) => c.type === 'image') };
}
const savePng = (r, name) => { if (SHOTS && r.image) fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.image.data, 'base64')); };
/** Width and height of a PNG, from its header. */
const pngSize = (r) => { const b = Buffer.from(r.image.data, 'base64'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

// ------------------------------------------------------------------ a design to point at

const NAME = 'teammate-e2e';
let projectId = (await db.query(`SELECT id FROM projects WHERE owner_id = $1 AND name = $2 AND deleted_at IS NULL`, [ada, NAME])).rows[0]?.id;
if (!projectId || !process.env.KEEP) {
  await db.query(`DELETE FROM projects WHERE owner_id = $1`, [ada]);
  const made = await call('create_project', { name: NAME }); projectId = made.data && made.data.project_id;
  check('create_project', !!projectId, made.text);
  const here = path.dirname(new URL(import.meta.url).pathname);
  const code = fs.readFileSync(path.join(here, '../harness/examples/rp2040_devboard.py'), 'utf8').replace(/^project = kh\.new.*$/m, '');
  let r = await call('run_python', { project: NAME, code, live: false, timeout_s: 400, keep_on_error: true });
  while (r.data && r.data.running) r = await call('get_run', { run_id: r.data.run_id });
  check('the example board is designed through run_python', !r.isError && r.data && r.data.changed && r.data.changed.length === 2, r.text.slice(0, 600));
}
await db.query(`INSERT INTO permissions (project_id, user_id, role, created_by) VALUES ($1, $2, 'editor', $3) ON CONFLICT DO NOTHING`, [projectId, bob, ada]);
const docs = (await db.query(`SELECT id, doc_type, path FROM documents WHERE project_id = $1`, [projectId])).rows;
const sch = docs.find((d) => d.doc_type === 'kicad_sch'), pcb = docs.find((d) => d.doc_type === 'kicad_pcb');

// ------------------------------------------------------------------ the second and third client

/** A collaboration client as the desktop is one: joins a document, remembers the presence it is sent. */
function watch(docId, jwt, kind = 'desktop') {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws'); const w = { presence: {}, ws, docId };
  w.ready = new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', proto: 1, token: jwt, clientId: 'watch-' + crypto.randomBytes(4).toString('hex'), linkToken: null, client: kind }));
    ws.onerror = () => reject(new Error('watcher socket failed'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'hello_ok') ws.send(JSON.stringify({ type: 'join_doc', docId }));
      else if (m.type === 'snapshot') resolve(w);
      else if (m.type === 'presence') for (const [k, v] of Object.entries(m.peers)) { if (v === null) delete w.presence[k]; else w.presence[k] = v; }
      else if (m.type === 'peer_left') delete w.presence[m.clientId];
    };
  });
  w.say = (state) => ws.send(JSON.stringify({ type: 'presence', docId, state }));
  /** The assistant's presence as this client has it. */
  w.agent = () => Object.values(w.presence).find((p) => p && p.user && p.user.client === 'mcp');
  return w.ready;
}

const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: SHOTS ? 2 : 1 });
const page = await ctx.newPage();
await page.goto(`${BASE}/auth/dev?jwt=${bobJwt}&next=/`);
const open = async (docId) => { await page.goto(`${BASE}/p/${projectId}/edit?doc=${docId}`); await page.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc, null, { timeout: 30000 }); await page.waitForTimeout(1500); };
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) }); };
/** What the browser has drawn for the assistant: its outlines, its lines, its note. */
const drawn = () => page.evaluate(() => {
  const E = window.CollabEditor; const agent = Object.values(E.peerState || {}).find((p) => p.user && p.user.client === 'mcp');
  return { marks: document.querySelectorAll('rect.ai-mark').length, note: (document.querySelector('g.ai-note') || { textContent: '' }).textContent, name: agent && agent.user.name,
    lines: agent && agent.state && agent.state.ghost ? agent.state.ghost.length : 0, selection: agent && agent.state && agent.state.selection ? agent.state.selection.length : 0 };
});

// ------------------------------------------------------------------ the board

await open(pcb.id);
const desk = await watch(pcb.id, bobJwt);
// a client is announced to the others by its first presence message: the desktop sends one as it opens the board, the browser on the first mouse move
desk.say({ cursor: [110e6, 80e6], viewport: [80e6, 40e6, 70e6, 70e6], selection: [], sheetFile: pcb.path });
await page.mouse.move(640, 400); await page.mouse.move(660, 420); await sleep(500);
{
  const h = await call('highlight', { project: NAME, document: 'board', refs: ['U1', 'Y1'], note: 'The crystal sits 9 mm from the MCU: move it closer to pins 20 and 21', seconds: 40 });
  check('highlight: parts on the board', !h.isError && h.data.highlighted.join() === 'U1,Y1' && h.data.clears_in_s === 40, h.text);
  check('highlight says who has the board open', !h.isError && Array.isArray(h.data.seen_by) && h.data.seen_by.some((n) => /Bob \(browser\)/.test(n)) && h.data.seen_by.some((n) => /Bob \(desktop\)/.test(n)), h.text);
  const seen = await until(async () => (await drawn()).marks === 2);
  const d = await drawn();
  check('the browser outlines each highlighted part in the assistant\'s colour', seen && d.selection === 2, JSON.stringify(d));
  check('with the note beside its name tag', /crystal sits 9 mm/.test(d.note) && /Ada \(/.test(d.name || ''), JSON.stringify(d));
  await shot('01-board-parts-highlighted.png');
  const a = desk.agent();
  check('a desktop client gets it as ordinary presence: cursor, selection by id, the sheet', !!a && a.state.selection.length === 2 && Array.isArray(a.state.cursor) && a.state.sheetFile === pcb.path && !a.state.boxes && a.state.viewport.length === 4, JSON.stringify(a && a.state).slice(0, 300));

  const nets = (await call('list_nets', { project: NAME, document: 'board' })).data.nets;
  const net = nets.filter((n) => n.tracks >= 4 && n.pads.length >= 3 && n.pads.length <= 5 && !n.zones).sort((p, q) => q.routed_length_mm - p.routed_length_mm)[0];
  const t = await call('trace_net', { project: NAME, document: 'board', net: net.name, highlight: true, note: `${net.name}: ${net.routed_length_mm} mm of track` });
  check('trace_net: pads, length per layer, vias, open connections', !t.isError && t.data.pad_count === net.pads.length && Math.abs(t.data.routed_length_mm - net.routed_length_mm) < 0.01 && Object.keys(t.data.by_layer).length >= 1 && t.data.vias === net.vias && Array.isArray(t.data.box), t.text.slice(0, 500));
  check('trace_net is a small answer', t.text.length < 6000, `${t.text.length} characters`);
  const lit = await until(async () => { const x = await drawn(); return x.lines >= net.tracks && /mm of track/.test(x.note); });
  check('trace_net with highlight lights the net for the browser: its tracks as lines, its pads outlined', lit, JSON.stringify(await drawn()));
  const a2 = desk.agent();
  check('and for the desktop, inside the 8 KB the server takes', !!a2 && a2.state.ghost.length >= net.tracks + 4 * net.pads.length && JSON.stringify(a2.state).length < 8192, a2 && `${a2.state.ghost.length} lines, ${JSON.stringify(a2.state).length} bytes`);
  await shot('02-board-net-highlighted.png');

  const big = await call('highlight', { project: NAME, document: 'board', nets: ['GND'], seconds: 20 });
  const a3 = desk.agent();
  check('a net too large for one presence message is marked in part, and says so', !big.isError && JSON.stringify(a3.state).length < 8192 && (big.data.partly === undefined || /large/.test(big.data.partly)), big.text.slice(0, 300));

  const area = await call('highlight', { project: NAME, document: 'board', area: [t.data.box[0], t.data.box[1], t.data.box[0] + 6, t.data.box[1] + 4], at: [t.data.box[2], t.data.box[3]], seconds: 5 });
  check('highlight: a region and a point', !area.isError && area.data.highlighted.length === 2 && await until(() => desk.agent().state.ghost.length === 8, 3000), area.text);
  const gone = await until(async () => { const s = desk.agent(); return !!s && !s.state.cursor && !(s.state.ghost || []).length && (await drawn()).lines === 0; }, 9000);
  check('the highlight clears by itself when its time is up', gone, JSON.stringify(desk.agent()));
  const again = await call('highlight', { project: NAME, document: 'board', refs: ['U2'] });
  const cleared = await call('highlight', { project: NAME, document: 'board', clear: true });
  check('clear: true removes it at once', !again.isError && cleared.data.cleared === true && await until(async () => (await drawn()).marks === 0, 3000), cleared.text);
  const nothing = await call('highlight', { project: NAME, document: 'board', refs: ['U99'] });
  check('a part that is not there is an error the model can read', nothing.isError && /Not on .*U99/.test(nothing.text), nothing.text);

  // Bob selects something in his browser and looks at a corner of the board; the assistant is asked "what is this?"
  const picked = await page.evaluate(() => {
    const E = window.CollabEditor; const it = Array.from(E.kdoc.items.values()).find((i) => i.ref === 'U3');
    E.selection = new Set([it.id]); return it.id;
  });
  await page.mouse.move(700, 450); await page.mouse.move(720, 470); await page.waitForTimeout(400);
  const who = await call('get_selection', { project: NAME, document: 'board' });
  const bobWeb = who.data && who.data.people.find((p) => p.name === 'Bob' && p.with === 'browser');
  check('get_selection: the person in the browser, their selection by reference, cursor and view', !who.isError && !!bobWeb && bobWeb.selected && bobWeb.selected[0].ref === 'U3' && bobWeb.looking_at.length === 4 && bobWeb.cursor.length === 2, who.text.slice(0, 600));
  check('get_selection lists the desktop client too, and not the assistant itself', who.data.people.some((p) => p.with === 'desktop') && !who.data.people.some((p) => p.with === 'assistant'), who.text.slice(0, 400));
  const all = await call('get_selection', { project: NAME });
  check('get_selection without a document covers the project', !all.isError && all.data.documents.some((d) => d.document === pcb.path && d.people.length >= 2), all.text.slice(0, 400));
  const view = await call('render_view', { project: NAME, document: 'board', view_of: 'bob', width_px: 900 });
  check('render_view view_of: what Bob is looking at, his selection named', !view.isError && !!view.image && view.data.view_of === 'Bob' && view.data.their_selection.includes('U3') && Math.abs(view.data.shown_mm[0] - bobWeb.looking_at[0]) < 0.01, view.text.slice(0, 400));
  savePng(view, '03-render-view-of-bob.png');
  const nobody = await call('render_view', { project: NAME, document: 'board', view_of: 'carol' });
  check('view_of someone who is not there names who is', nobody.isError && /Bob/.test(nobody.text), nobody.text);

  const whole = await call('render_view', { project: NAME, document: 'board', width_px: 800 });
  const scoped = await call('render_view', { project: NAME, document: 'board', nets: [net.name], width_px: 800 });
  check('render_view nets: cropped to the net, which is named as emphasised', !scoped.isError && scoped.data.emphasized[0] === `net ${net.name}` && (scoped.data.shown_mm[2] - scoped.data.shown_mm[0]) < (whole.data.shown_mm[2] - whole.data.shown_mm[0]), scoped.text.slice(0, 300));
  check('pictures are PNG at the size asked for', Math.max(...pngSize(scoped)) === 800 && Math.max(...pngSize(whole)) === 800);
  savePng(scoped, '04-render-net-emphasised.png'); savePng(whole, '05-render-whole-board.png');
  const parts = await call('render_view', { project: NAME, document: 'board', refs: ['U1'], emphasize: true, layers: ['F.Cu', 'Edge.Cuts'], width_px: 800 });
  check('render_view refs with emphasize and layers', !parts.isError && parts.data.emphasized[0] === 'U1' && !!parts.image, parts.text.slice(0, 300));
  savePng(parts, '06-render-part-emphasised.png');
  const viol = await call('render_view', { project: NAME, document: 'board', violations: true, width_px: 1200 });
  const checks = await call('run_checks', { project: NAME, document: 'board' });
  check('render_view violations: the findings of the rules check, numbered as run_checks lists them', !viol.isError && viol.data.violations_total === checks.data.errors + checks.data.warnings && (viol.data.violations.length === 0 || viol.data.violations[0].message === checks.data.violations[viol.data.violations[0].n - 1].message), viol.text.slice(0, 400));
  savePng(viol, '07-render-violations.png');
}

// ------------------------------------------------------------------ the schematic

await open(sch.id);
{
  const nets = (await call('list_nets', { project: NAME, document: sch.path })).data.nets;
  const net = nets.find((n) => /XIN|XOUT|QSPI|USB/i.test(n.name) && n.pins.length >= 2) || nets.find((n) => n.pins.length >= 3);
  const ref = net.pins[0].split('.')[0];
  const h = await call('highlight', { project: NAME, document: sch.path, refs: [ref], nets: [net.name], note: `${net.name} and ${ref}` });
  check('highlight on a sheet: a part and a net together', !h.isError && h.data.highlighted.length === 2, h.text);
  const seen = await until(async () => { const d = await drawn(); return d.marks >= 1 && d.lines >= 4; });
  check('the browser shows it on the sheet', seen, JSON.stringify(await drawn()));
  await shot('08-schematic-highlighted.png');
  const follow = await page.evaluate(() => {
    const E = window.CollabEditor; const cid = Object.keys(E.peerState).find((c) => E.peerState[c].user && E.peerState[c].user.client === 'mcp');
    const before = [E.zoom, E.panX, E.panY].join(); window.CollabApp && window.CollabApp.followPeer ? window.CollabApp.followPeer(cid) : (E.followPeer = cid);
    return { cid, before };
  });
  const moved = await call('highlight', { project: NAME, document: sch.path, refs: ['J1'], note: 'Following me takes you here' });
  const took = await until(() => page.evaluate((b) => { const E = window.CollabEditor; return [E.zoom, E.panX, E.panY].join() !== b; }, follow.before), 5000);
  check('someone following the assistant has their view brought to what it points at', !moved.isError && took);
  await page.waitForTimeout(500); await shot('09-schematic-following-the-assistant.png');
  const t = await call('trace_net', { project: NAME, document: sch.path, net: net.name });
  check('trace_net on a sheet: pins with types, labels', !t.isError && t.data.pins.length === net.pins.length && Array.isArray(t.data.labels), t.text.slice(0, 400));
  const pic = await call('render_view', { project: NAME, document: sch.path, nets: [net.name], width_px: 1000 });
  check('render_view nets on a sheet', !pic.isError && !!pic.image && pic.data.emphasized[0] === `net ${net.name}`, pic.text.slice(0, 300));
  savePng(pic, '10-render-schematic-net.png');
  const v = await call('render_view', { project: NAME, document: sch.path, violations: true, width_px: 1400 });
  check('render_view violations on a sheet', !v.isError && typeof v.data.violations_total === 'number', v.text.slice(0, 300));
  savePng(v, '11-render-schematic-violations.png');
  await call('highlight', { project: NAME, document: sch.path, clear: true });
}

// ------------------------------------------------------------------ compare with a checkpoint, the BOM, datasheet pages

{
  const cp = await call('create_checkpoint', { project: NAME, name: `before-${Date.now()}` });
  const same = await call('compare_versions', { project: NAME, document: 'board' });
  check('compare_versions right after a checkpoint: nothing differs', !cp.isError && !same.isError && same.data.added + same.data.removed + same.data.modified === 0 && !same.image, same.text.slice(0, 300));
  const comp = (await call('get_component', { project: NAME, document: 'board', ref: 'SW2' })).data;
  const moved = await call('apply_changes', { project: NAME, document: 'board', title: 'Nudge SW2, add a note', edits: [{ op: 'move', ref: 'SW2', x: (comp.x ?? comp.position?.x ?? comp.at?.[0]) + 1.5, y: comp.y ?? comp.position?.y ?? comp.at?.[1] }, { op: 'add_text', text: 'REV B', x: 100, y: 55 }] });
  const diff = await call('compare_versions', { project: NAME, document: 'board', width_px: 900 });
  check('compare_versions lists what changed since the checkpoint, with a picture', !moved.isError && !diff.isError && diff.data.added >= 1 && diff.data.modified >= 1 && diff.data.changes.some((c) => c.change === 'modified' && /SW2/.test(c.what + (c.ref || ''))) && !!diff.image && /before-/.test(diff.data.compared_with), (moved.isError ? moved.text : diff.text).slice(0, 600));
  savePng(diff, '12-compare-with-checkpoint.png');
  const r = await (await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adaJwt}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'compare_versions', arguments: { project: NAME, document: 'board', side_by_side: true, width_px: 700 } } }) })).json();
  check('side_by_side returns the saved version and now as two pictures', r.result && r.result.content.filter((c) => c.type === 'image').length === 2);
  const none = await call('compare_versions', { project: NAME, document: 'board', with: 'no such checkpoint' });
  check('an unknown checkpoint names the ones there are', none.isError && /before-/.test(none.text), none.text);
  await call('undo_changes', { project: NAME });

  const plain = await call('get_bom', { project: NAME, prices: false });
  const caps = plain.data && plain.data.lines.find((l) => l.value === '100nF');
  check('get_bom: one line per part, references as runs, without asking vendors', !plain.isError && plain.data.totals.parts >= 30 && !!caps && caps.qty >= 8 && /C\d+-C\d+/.test(caps.refs), plain.text.slice(0, 500));
  // one part gets a vendor number (the fake vendor has C25804), then the BOM is priced
  await call('apply_changes', { project: NAME, document: sch.path, title: 'Choose the 10k resistor', edits: [{ op: 'set_field', ref: 'R5', field: 'LCSC', value: 'C25804' }, { op: 'set_field', ref: 'R8', field: 'LCSC', value: 'C25804' }] });
  const bom = await call('get_bom', { project: NAME, boards: 10 });
  const line = bom.data && bom.data.lines.find((l) => l.part === 'lcsc C25804');
  if (bom.data && bom.data.lines.some((l) => /lookup/.test(Object.keys(l).join())) && !line?.unit) console.log('  (the vendor lookup did not answer: start the server with the fake vendors to test prices)');
  else check('get_bom prices a chosen part at the break for the quantity and totals the cost', !bom.isError && !!line && line.qty === 2 && line.unit > 0 && Math.abs(line.total - line.unit * 20) < 1e-6 && /for 10 boards/.test(bom.data.totals.cost) && bom.data.no_part_chosen.length > 3, bom.text.slice(0, 700));
  check('get_bom is a small answer', bom.text.length < 9000, `${bom.text.length} characters`);
  await call('undo_changes', { project: NAME });

  const http = await import('node:http');
  const pdfPage = await ctx.newPage();
  await pdfPage.setContent('<style>section{break-after:page;font:16px sans-serif}</style><section><h1>XR1 Datasheet</h1></section><section><h2>Pin configuration</h2><svg width="300" height="200"><rect x="60" y="20" width="180" height="160" fill="none" stroke="black" stroke-width="3"/><text x="110" y="105">XR1</text><text x="10" y="50">1 VIN</text><text x="250" y="50">8 VOUT</text></svg></section><section><h2>Typical application</h2><p>Place 10 uF at VIN.</p></section>');
  const bytes = await pdfPage.pdf({ format: 'A4' }); await pdfPage.close();
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(bytes); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/xr1.pdf?t=${Date.now()}`;
  const pic = await call('view_datasheet', { url, query: 'pin configuration', width_px: 900 });
  if (pic.isError && /https link/.test(pic.text)) console.log('  (skipped: start the server with AI_DATASHEET_ALLOW_LOCAL=1 to test view_datasheet)');
  else {
    check('view_datasheet draws the page that answers the query', !pic.isError && !!pic.image && pic.data.pages_shown[0] === 2 && pic.data.page_count === 3 && Math.max(...pngSize(pic)) === 900, pic.text.slice(0, 300));
    savePng(pic, '13-datasheet-page.png');
    const two = await (await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adaJwt}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'view_datasheet', arguments: { url, pages: [1, 3], width_px: 600 } } }) })).json();
    check('view_datasheet by page numbers returns each page', two.result.content.filter((c) => c.type === 'image').length === 2);
    const off = await call('view_datasheet', { url, query: 'zzzqqq nonexistent' });
    check('a query no page answers says so', off.isError && /No page has those words/.test(off.text), off.text);
  }
  srv.close();
}

// ------------------------------------------------------------------ fabrication files

{
  const fab = await call('export_fab', { project: NAME, preset: 'jlcpcb' });
  check('export_fab: a package with Gerbers, drill, BOM and placement, and a link', !fab.isError && /\/api\/exports\/[0-9a-f-]{36}$/.test(fab.data.download) && fab.data.contains.some((n) => /F_Cu|\.GTL|\.gtl/i.test(n)) && fab.data.contains.some((n) => /drl|DRL/.test(n)) && fab.data.contains.some((n) => /bom/i.test(n)) && fab.data.board.copper_layers >= 2 && fab.data.board.parts >= 30, fab.text.slice(0, 900));
  check('export_fab says whether the board is ready to order', fab.data && (fab.data.ready === true || /Not ready to order/.test(fab.data.ready)), fab.text.slice(0, 300));
  const dl = await fetch(fab.data.download.replace(/^https?:\/\/[^/]+/, BASE), { headers: { authorization: `Bearer ${bobJwt}` } });
  const bytes = Buffer.from(await dl.arrayBuffer());
  check('a member of the project downloads the zip from the link', dl.ok && bytes.slice(0, 2).toString() === 'PK' && /attachment; filename=".*jlcpcb\.zip"/.test(dl.headers.get('content-disposition') || '') && bytes.length > 5000, `${dl.status} ${bytes.length} bytes`);
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, 'teammate-e2e-jlcpcb.zip'), bytes);
  const eve = await user(9523, 'tm-eve', 'Eve');
  const no = await fetch(fab.data.download.replace(/^https?:\/\/[^/]+/, BASE), { headers: { authorization: `Bearer ${mintJwt(eve, 'tm-eve')}` } });
  check('someone outside the project cannot', no.status === 404 || no.status === 403, String(no.status));
  const kicad = await call('export_fab', { project: NAME, preset: 'kicad', bom: false, placement: false });
  check('export_fab preset kicad without BOM and placement', !kicad.isError && !kicad.data.contains.some((n) => /bom|pos|cpl/i.test(n)), kicad.text.slice(0, 400));
}

// ------------------------------------------------------------------ proposals a person accepts or rejects

{
  await db.query(`DELETE FROM design_proposals WHERE project_id = $1`, [projectId]);
  page.on('console', (m) => { if (process.env.DEBUG) console.log('  console:', m.text().slice(0, 300)); });
  await open(sch.id);
  const before = await call('get_component', { project: NAME, document: sch.path, ref: 'R5' }); if (process.env.DEBUG) console.log(before.text.slice(0, 400));
  const prop = await call('apply_changes', { project: NAME, document: sch.path, propose: true, title: 'Stronger pull-up on R5', rationale: 'A 4.7k pull-up gives faster edges on this bus.',
    edits: [{ op: 'set_field', ref: 'R5', field: 'Value', value: '4k7' }] });
  check('apply_changes propose: true changes nothing and returns a pending proposal', !prop.isError && prop.data.applied === false && prop.data.proposed === true && /^[0-9a-f-]{36}$/.test(prop.data.proposal), prop.text.slice(0, 400));
  const same = await call('get_component', { project: NAME, document: sch.path, ref: 'R5' });
  check('the design is untouched while the proposal waits', same.text === before.text);
  check('the person sees the proposal listed with its author, title and edits', await until(() => page.evaluate(() => { const c = document.querySelector('#propPanel.open .prop-card'); return !!c && /Ada's assistant/.test(c.querySelector('.meta')?.textContent || '') && /Stronger pull-up on R5/.test(c.textContent || '') && c.querySelectorAll('.prop-lines li').length === 1; })), await page.evaluate(() => document.querySelector('#propPanel')?.outerHTML.slice(0, 600)));
  check('and it is drawn over the sheet without being applied', await until(() => page.evaluate(() => document.querySelectorAll('#aiG rect').length >= 1 && document.querySelectorAll('#aiG svg').length === 1)));
  await sleep(400); await shot('14-proposal-preview.png');
  // what the desktop app reads: the outline of each touched item, and whether the design moved on since
  const asBob = (id) => fetch(`${BASE}/api/proposals/${id}`, { headers: { authorization: `Bearer ${bobJwt}` } }).then((r) => r.json());
  const full = await asBob(prop.data.proposal); const pv = full.body && full.body.preview;
  check('the stored proposal carries a preview a desktop client can draw, and is not stale', !!pv && pv.boxes.length === 1 && pv.boxes[0].length === 5 && pv.boxes[0][4] === 'modify' && pv.boxes[0][2] > pv.boxes[0][0] && Array.isArray(pv.segs) && full.stale === null, JSON.stringify({ pv, stale: full.stale }).slice(0, 300));
  const waiting = call('list_proposals', { project: NAME, proposal: prop.data.proposal, wait_s: 20 });
  await sleep(600);
  await page.click('#propPanel .prop-card [data-act="accept"]');
  const outcome = await waiting;
  check('list_proposals wait_s returns as soon as the person accepts', !outcome.isError && outcome.data.status === 'accepted' && outcome.data.decided_by === 'Bob', outcome.text);
  const after = await until(async () => /4k7/.test((await call('get_component', { project: NAME, document: sch.path, ref: 'R5' })).text));
  check('accepting applies the change as the person\'s edit', after, await page.evaluate(() => document.body.innerText.split('\n').filter((l) => /proposal|edited|Open |applied|deleted|decision/i.test(l)).join(' | ')));
  check('the card and the preview go away', await until(() => page.evaluate(() => !document.querySelector('#propPanel.open') && document.querySelectorAll('#aiG *').length === 0)));
  await page.keyboard.press('Control+z');
  check('it is one undo step for the person who accepted', await until(async () => !/4k7/.test((await call('get_component', { project: NAME, document: sch.path, ref: 'R5' })).text)));
  await shot('15-proposal-accepted.png');

  const two = await call('apply_changes', { project: NAME, document: sch.path, propose: true, title: 'Remove R8', edits: [{ op: 'remove', ref: 'R8' }] });
  check('a second proposal', !two.isError && two.data.proposed === true, two.text.slice(0, 300));
  await page.waitForSelector('#propPanel.open .prop-card [data-act="reject"]');
  await page.click('#propPanel .prop-card [data-act="reject"]');
  await page.fill('#propPanel .prop-card [data-act="why"]', 'R8 is needed for boot');
  await shot('16-proposal-reject.png');
  await page.click('#propPanel .prop-card [data-act="reject-send"]');
  const rej = await call('list_proposals', { project: NAME, proposal: two.data.proposal, wait_s: 10 });
  check('a rejection reaches the assistant with the reason', rej.data.status === 'rejected' && rej.data.reason === 'R8 is needed for boot' && rej.data.decided_by === 'Bob', rej.text);
  check('and nothing was removed', !(await call('get_component', { project: NAME, document: sch.path, ref: 'R8' })).isError);

  const three = await call('apply_changes', { project: NAME, document: sch.path, propose: true, title: 'R5 to 2k2', edits: [{ op: 'set_field', ref: 'R5', field: 'Value', value: '2k2' }] });
  const gone = await call('list_proposals', { project: NAME, withdraw: three.data.proposal });
  check('a pending proposal can be withdrawn, and leaves the person\'s screen', gone.data.status === 'withdrawn' && await until(() => page.evaluate(() => !document.querySelector('#propPanel.open'))), gone.text);
  const again = await call('list_proposals', { project: NAME, withdraw: three.data.proposal });
  check('a decided proposal cannot be decided again', again.isError && /already withdrawn/.test(again.text), again.text);
  const four = await call('apply_changes', { project: NAME, document: sch.path, propose: true, title: 'Smaller R8', edits: [{ op: 'set_field', ref: 'R8', field: 'Value', value: '1k' }] });
  const fresh = await asBob(four.data.proposal);
  await call('apply_changes', { project: NAME, document: sch.path, edits: [{ op: 'set_field', ref: 'R8', field: 'Value', value: '2k2' }] });
  const moved = await asBob(four.data.proposal);
  check('a proposal whose item was edited since is reported stale', !four.isError && fresh.stale === null && typeof moved.stale === 'string' && /edited since/.test(moved.stale), JSON.stringify({ fresh: fresh.stale, moved: moved.stale }));
  await call('list_proposals', { project: NAME, withdraw: four.data.proposal });
  const all = await call('list_proposals', { project: NAME, document: sch.path });
  check('list_proposals lists them newest first with their outcome', all.data.proposals.length >= 3 && all.data.proposals[0].status === 'withdrawn' && all.data.proposals.some((r) => r.status === 'accepted') && all.text.length < 3000, all.text.slice(0, 400));
  const eve = await user(9523, 'tm-eve', 'Eve');
  const peek = await fetch(`${BASE}/api/proposals/${prop.data.proposal}`, { headers: { authorization: `Bearer ${mintJwt(eve, 'tm-eve')}` } });
  check('someone outside the project cannot read a proposal', peek.status === 404 || peek.status === 403, String(peek.status));
}

// ------------------------------------------------------------------ rule violations fixed through proposals

{
  const codes = async (document) => { const r = await call('run_checks', { project: NAME, document }); const m = {}; for (const v of r.data.violations) m[v.code] = (m[v.code] || 0) + 1; return m; };
  // a label on nothing, on the sheet the person has open
  await call('apply_changes', { project: NAME, document: sch.path, title: 'A stray label', edits: [{ op: 'add_label', kind: 'label', text: 'STRAY', x: 250.19, y: 180.34 }] });
  const had = await codes(sch.path);
  const fix = await call('propose_fixes', { project: NAME, document: sch.path, codes: ['label_dangling'] });
  if (process.env.DEBUG) console.log(fix.text.slice(0, 1500));
  check('propose_fixes offers the stray label\'s removal as one proposal and changes nothing', !fix.isError && had.label_dangling === 1 && fix.data.proposed.length === 1 && /Remove 1 label or flag that connects/.test(fix.data.proposed[0].title) && (await codes(sch.path)).label_dangling === 1, fix.text.slice(0, 600));
  const twice = await call('propose_fixes', { project: NAME, document: sch.path, codes: ['label_dangling'] });
  check('the same fix is not offered twice while it waits', twice.data.proposed.length === 0 && /already waiting/.test(JSON.stringify(twice.data.could_not_plan)), twice.text.slice(0, 400));
  await page.waitForSelector('#propPanel.open .prop-card [data-act="accept"]');
  await sleep(500); await shot('17-fix-proposal.png');
  await page.click('#propPanel .prop-card [data-act="accept"]');
  check('accepting the fix clears the violation', await until(async () => !(await codes(sch.path)).label_dangling, 10000));
  const whole = await call('propose_fixes', { project: NAME, document: sch.path });
  check('violations without a mechanical fix come back with a hint, in a small answer', !whole.isError && whole.text.length < 6000 && (whole.data.violations === 0 || !!whole.data.left_for_you || whole.data.proposed.length > 0), whole.text.slice(0, 600));
  for (const pr of whole.data.proposed || []) await call('list_proposals', { project: NAME, withdraw: pr.proposal });

  // the board: one track taken out leaves an open connection, which the fix routes again
  await open(pcb.id);
  const net = await call('trace_net', { project: NAME, document: 'board', net: 'RUN' });
  const items = await call('get_items', { project: NAME, document: 'board', kind: 'segment', net: 'RUN' });
  const seg = items.data && (items.data.items || [])[0];
  if (!seg) console.log('  (no RUN track to remove: ' + items.text.slice(0, 200) + ')');
  else {
    await call('apply_changes', { project: NAME, document: 'board', title: 'Take a track out', edits: [{ op: 'remove', id: seg.id }] });
    const open1 = (await codes('board')).unconnected_items || 0;
    const bfix = await call('propose_fixes', { project: NAME, document: 'board', codes: ['unconnected_items'] });
    if (process.env.DEBUG) console.log(bfix.text.slice(0, 1200));
    check('propose_fixes offers to route the open connection', !bfix.isError && open1 >= 1 && bfix.data.proposed.length === 1 && /^Route \d+ open connection/.test(bfix.data.proposed[0].title), bfix.text.slice(0, 600));
    await page.waitForSelector('#propPanel.open .prop-card [data-act="accept"]');
    await sleep(600); await shot('18-fix-route-proposal.png');
    await page.click('#propPanel .prop-card [data-act="accept"]');
    check('accepted, the board has no open connection left from it', await until(async () => ((await codes('board')).unconnected_items || 0) < open1, 15000));
    await shot('19-fix-route-accepted.png');
    void net;
  }
}

// ------------------------------------------------------------------ simulation

{
  const rc = '* RC low-pass\nV1 in 0 dc 0 ac 1 pulse(0 5 1m 1u 1u 50m 100m)\nR1 in out 1k\nC1 out 0 1u\n';
  const ac = await call('simulate', { project: NAME, netlist: rc, command: '.ac dec 20 1 100k', probes: ['V(out)'] });
  if (process.env.DEBUG) console.log(ac.text.slice(0, 1500));
  const f3 = ac.data && ac.data.signals && ac.data.signals['v(out)'] && ac.data.signals['v(out)'].minus_3db_at;
  check('simulate: an AC sweep of a netlist reports the -3 dB point (159 Hz for 1k and 1u)', !ac.isError && !!f3 && /^1(5\d|6\d)Hz$/.test(f3[0]) && ac.data.points > 50, ac.text.slice(0, 600));
  check('with a plot as a picture, and a small answer', !!ac.image && Math.max(...pngSize(ac)) >= 1000 && ac.text.length < 1500, `${ac.text.length} characters`);
  savePng(ac, '20-simulate-ac.png');
  const tr = await call('simulate', { project: NAME, netlist: rc, command: '.tran 20u 10m', probes: ['V(in)', 'V(out)', 'I(V1)'], width_px: 1200 });
  if (process.env.DEBUG) console.log(tr.text.slice(0, 1500));
  const out = tr.data && tr.data.signals && tr.data.signals['v(out)'];
  check('a transient reports where each signal starts, ends and settles', !tr.isError && !!out && out.start === '0V' && /^(4\.9\d|5)V$/.test(out.end) && /ms$/.test(out.settles_within_2pct_at || '') && Object.keys(tr.data.signals).length === 3 && Math.max(...pngSize(tr)) === 1200, tr.text.slice(0, 700));
  savePng(tr, '21-simulate-tran.png');
  const op = await call('simulate', { project: NAME, netlist: 'divider\nV1 a 0 9\nR1 a mid 2k\nR2 mid 0 1k\n', command: '.op' });
  check('.op gives every node voltage without a picture', !op.isError && op.data.signals['v(mid)'] === '3V' && !op.image, op.text.slice(0, 400));
  const bad = await call('simulate', { project: NAME, netlist: 'broken\nR1 a b\n', command: '.op' });
  check('a netlist ngspice refuses comes back as an error with its message', bad.isError && bad.text.length < 2500, bad.text.slice(0, 300));
  const none = await call('simulate', { project: NAME, netlist: rc });
  check('no analysis: asks for a command', none.isError && /command/.test(none.text), none.text.slice(0, 200));

  // the schematic itself: a divider drawn with the harness, simulated from KiCad's own netlist
  await db.query(`DELETE FROM projects WHERE owner_id = $1 AND name = 'teammate-sim'`, [ada]);
  await call('create_project', { name: 'teammate-sim' });
  const code = `sch = project.schematic()
sch.build(parts={
  "V1": {"lib": "Simulation_SPICE:VDC", "fields": {"Sim.Params": "dc=9"}},
  "R1": {"lib": "Device:R", "value": "2k"},
  "R2": {"lib": "Device:R", "value": "1k"},
}, nets={"VIN": ["V1.1", "R1.1"], "MID": ["R1.2", "R2.1"], "GND": ["V1.2", "R2.2"]}, labels=["MID"], review=False)
print("ok")`;
  let r = await call('run_python', { project: 'teammate-sim', code, live: false, timeout_s: 200 });
  while (r.data && r.data.running) r = await call('get_run', { run_id: r.data.run_id });
  if (r.isError) console.log('  (the test schematic could not be drawn: ' + r.text.slice(0, 500) + ')');
  if (process.env.DEBUG) console.log((await call('get_component', { project: 'teammate-sim', document: 'teammate-sim.kicad_sch', ref: 'V1' })).text.slice(0, 700));
  const text = await call('simulate', { project: 'teammate-sim', command: '.op', netlist_only: true });
  if (process.env.DEBUG) console.log(text.text.slice(0, 1200));
  const sim = await call('simulate', { project: 'teammate-sim', command: '.op' });
  if (process.env.DEBUG) console.log(sim.text.slice(0, 1200));
  const mid = sim.data && sim.data.signals && Object.entries(sim.data.signals).find(([n]) => /mid/i.test(n));
  check('the schematic is simulated from KiCad\'s own SPICE netlist (9 V over 2k and 1k: 3 V)', !sim.isError && !!mid && mid[1] === '3V', sim.text.slice(0, 700));
  const sweep = await call('simulate', { project: 'teammate-sim', command: '.dc V1 0 9 0.5', probes: ['V(MID)'] });
  check('a DC sweep of the schematic, probed by net name', !sweep.isError && !!sweep.image && Object.values(sweep.data.signals)[0].end === '3V', sweep.text.slice(0, 500));
  savePng(sweep, '22-simulate-schematic-dc.png');
}

// ------------------------------------------------------------------ a connection that may only read

{
  const tools = (await (await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adaJwt}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).json()).result.tools;
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  check('the new tools are in the catalog as read-only tools', ['highlight', 'get_selection', 'trace_net', 'compare_versions', 'get_bom', 'view_datasheet', 'export_fab', 'list_proposals', 'simulate'].every((n) => by[n] && by[n].annotations.readOnlyHint === true), Object.keys(by).join(' '));
}

desk.ws.close(); await browser.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
