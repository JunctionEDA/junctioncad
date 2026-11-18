// End-to-end test of the mechanical domain's AI tools on the real MCP endpoint: a JSON-RPC session that makes a
// part studio, adds a sketch and an extrude, reads the result back from the kernel, breaks a feature and reads
// the error, undoes and redoes, measures, and gets a picture.  A second collaboration client (a plain
// WebSocket, as a browser tab is) watches the document, so "the edit appears for everyone" is checked.
//
// Server as for the other *-e2e scripts, with node on its PATH (the tool host runs in it) and the modelling
// kernel in static/dist/pyodide/occ-kernel.wasm (npm run build puts it there):
//   DATABASE_URL=… JWT_SECRET=testsecret PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 KC_DEV_LOGIN=1 cargo run
//   E2E_PG_URL=… E2E_JWT_SECRET=testsecret [E2E_BASE=http://127.0.0.1:8099] [SHOTS=dir] node scripts/cad-history-mcp.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); ok ? pass++ : fail++; return ok; };
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const adaId = user('cad-mcp-ada', 990601), token = jwt(adaId, 'cad-mcp-ada');
const eveId = user('cad-mcp-eve', 990602), eveToken = jwt(eveId, 'cad-mcp-eve');

let rpcId = 0;
async function rpc(method, params, tok = token) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
/** Call a tool; returns { data (the JSON text, parsed), image (a Buffer or null), error (the message of a failed call) }. */
async function tool(name, args, tok = token) {
  const r = await rpc('tools/call', { name, arguments: args }, tok);
  const text = r.content.find((c) => c.type === 'text'), image = r.content.find((c) => c.type === 'image');
  if (r.isError) return { error: text ? text.text : 'failed', data: null, image: null };
  let data = null; try { data = JSON.parse(text.text); } catch { data = text.text; }
  return { data, image: image ? Buffer.from(image.data, 'base64') : null, mime: image && image.mimeType, error: null };
}

try {
  // ---------------------------------------------------------------- the catalog
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cad-history-mcp', version: '1' } });
  check('the server greets, and its instructions speak of part studios', /part studio/.test(init.instructions) && /cad_edit_features/.test(init.instructions));
  const listed = (await rpc('tools/list', {})).tools;
  const cad = listed.filter((t) => t.name.startsWith('cad_')).map((t) => t.name);
  check('the catalog offers the cad tools beside the electronics ones', ['cad_feature_types', 'cad_get_features', 'cad_get_bodies', 'cad_edit_features', 'cad_render_view', 'cad_create_part_studio'].every((n) => cad.includes(n)) && listed.some((t) => t.name === 'apply_changes'), cad.join(' '));
  const editTool = listed.find((t) => t.name === 'cad_edit_features');
  check('the edit tool is marked as changing things, the read tools as read-only', editTool.annotations.readOnlyHint === false && listed.find((t) => t.name === 'cad_get_features').annotations.readOnlyHint === true);

  // ---------------------------------------------------------------- a project and a part studio
  const made = await tool('create_project', { name: `cad-mcp-${Date.now().toString(36)}` });
  check('a project is created', !made.error && !!made.data, made.error || '');
  const project = made.data.id || made.data.project_id || made.data.projectId || made.data.name;
  const studio = await tool('cad_create_part_studio', { project, name: 'Bracket' });
  check('a part studio is added to it', !studio.error && studio.data.document === 'Bracket.jpart', studio.error || JSON.stringify(studio.data));
  const info = await tool('get_project', { project });
  const docs = info.data.documents;
  check('get_project lists it as a part studio beside the schematic and the board', docs.some((d) => d.path === 'Bracket.jpart' && d.type === 'part studio') && docs.some((d) => d.type === 'board') && docs.some((d) => d.type === 'schematic'), JSON.stringify(docs));
  const pid = info.data.id;
  const docId = sql(`SELECT id FROM documents WHERE project_id = '${pid}' AND path = 'Bracket.jpart'`);

  // a second client in the document, as a browser tab would be
  const seen = [];
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
  await new Promise((resolve, reject) => {
    ws.onerror = reject;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', proto: 1, token, clientId: 'watcher-1', linkToken: null, client: 'web' }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'hello_ok') ws.send(JSON.stringify({ type: 'join_doc', docId }));
      if (m.type === 'snapshot') resolve();
      if (m.type === 'op') seen.push(m);
      if (m.type === 'ops') seen.push(...m.ops);
    };
  });

  // ---------------------------------------------------------------- the feature registry
  const types = await tool('cad_feature_types', {});
  const extrude = types.data.feature_types.find((f) => f.type === 'extrude');
  check('the feature types and their parameters come from the registry', !!extrude && extrude.parameters.some((p) => p.key === 'depth' && p.kind === 'number') && types.data.feature_types.some((f) => f.type === 'sketch'),
    types.data.feature_types.map((f) => f.type).join(' '));

  const empty = await tool('cad_get_features', { project, document: 'Bracket.jpart' });
  check('a new part studio has no features and no bodies', !empty.error && empty.data.features.length === 0 && empty.data.bodies.length === 0, empty.error || '');

  // ---------------------------------------------------------------- a sketch and an extrude
  const edits = [
    { op: 'add', type: 'sketch', ref: 's', plane: 'top', shapes: [{ type: 'rectangle', x1: 0, y1: 0, x2: 40, y2: 20 }, { type: 'circle', cx: 10, cy: 10, r: 3 }] },
    { op: 'add', type: 'extrude', params: { profile: '$s', depth: 10 } },
  ];
  const dry = await tool('cad_edit_features', { project, document: 'Bracket', edits, dry_run: true });
  check('a dry run says what would be built and changes nothing', !dry.error && dry.data.dry_run === true && dry.data.features.length === 2 && dry.data.bodies.length === 1 && seen.length === 0, dry.error || '');
  check('…and the part studio is still empty', (await tool('cad_get_features', { project })).data.features.length === 0);

  const added = await tool('cad_edit_features', { project, document: 'Bracket.jpart', edits });
  check('a sketch and an extrude are added in one call', !added.error && added.data.applied.length === 2 && typeof added.data.change_id === 'number', added.error || JSON.stringify(added.data.applied));
  const expect = (40 * 20 - Math.PI * 9) * 10;
  const body0 = added.data.bodies[0];
  check('the kernel built one body with the volume the numbers give', added.data.bodies.length === 1 && Math.abs(body0.volume_mm3 - expect) < 0.01, `${body0 && body0.volume_mm3} vs ${expect.toFixed(3)}`);
  check('every feature reports ok', added.data.features.every((f) => f.status === 'ok') && !added.data.problems, JSON.stringify(added.data.features.map((f) => f.status)));
  for (let i = 0; i < 40 && !seen.length; i++) await sleep(50);
  check('the other client in the document saw the edit arrive as one op', seen.length === 1 && seen[0].changes.length === 2 && seen[0].changes.every((c) => c.kind === 'ADDED'), `${seen.length} ops`);
  const who = sql(`SELECT u.login || ':' || o.client_id FROM ops o JOIN users u ON u.id = o.author_id WHERE o.doc_id = '${docId}' ORDER BY o.seq DESC LIMIT 1`);
  check('the op is journalled as the person the assistant acts for', /^cad-mcp-ada:/.test(who), who);

  // ---------------------------------------------------------------- read it back
  const tree = await tool('cad_get_features', { project });
  check('the tree reads back: Sketch 1 then Extrude 1, with parameters', tree.data.features.map((f) => `${f.name}:${f.type}`).join() === 'Sketch 1:sketch,Extrude 1:extrude' && tree.data.features[1].params.depth === 10 && tree.data.features[0].params.sketch.lines === 4,
    JSON.stringify(tree.data.features.map((f) => f.name)));
  const bodies = await tool('cad_get_bodies', { project, names: true });
  const b = bodies.data.bodies[0];
  check('the body is measured: bounding box 40 × 20 × 10, seven faces, named', b.bbox_mm.max.join() === '40,20,10' && b.bbox_mm.min.join() === '0,0,0' && b.faces === 7 && b.face_names.some((n) => /:end:/.test(n)), JSON.stringify(b.bbox_mm));
  check('…with its surface area and centre of mass', b.area_mm2 > 2000 && Math.abs(b.centre_of_mass[2] - 5) < 1e-3, `${b.area_mm2} ${b.centre_of_mass}`);

  // ---------------------------------------------------------------- a picture
  const pic = await tool('cad_render_view', { project, view: 'iso', width_px: 800 });
  const png = pic.image;
  check('a view is rendered to a PNG of the asked size', !!png && pic.mime === 'image/png' && png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 800 && png.readUInt32BE(20) === 600, pic.error || '');
  if (SHOTS && png) fs.writeFileSync(`${SHOTS}/mcp-iso.png`, png);
  const top = await tool('cad_render_view', { project, view: 'top' });
  if (SHOTS && top.image) fs.writeFileSync(`${SHOTS}/mcp-top.png`, top.image);
  check('…and from above', !!top.image && top.data.view === 'top');
  check('an unknown view is refused with the list', /view is one of iso, top/.test((await tool('cad_render_view', { project, view: 'sideways' })).error || ''));

  // ---------------------------------------------------------------- edit, break, read the error
  const deeper = await tool('cad_edit_features', { project, edits: [{ op: 'set', feature: 'Extrude 1', params: { depth: 25 } }, { op: 'rename', feature: 'Extrude 1', name: 'Base' }] });
  check('a parameter is changed and the feature renamed; the volume follows', !deeper.error && Math.abs(deeper.data.bodies[0].volume_mm3 - expect * 2.5) < 0.01 && deeper.data.features[1].name === 'Base', deeper.error || '');
  const refused = await tool('cad_edit_features', { project, edits: [{ op: 'set', feature: 'Base', params: { depth: -1 } }, { op: 'add', type: 'lathe' }] });
  check('invalid edits change nothing and say why, each one', /Nothing was changed/.test(refused.error || '') && /depth must be at least/.test(refused.error) && /unknown feature type "lathe"/.test(refused.error), refused.error || 'no error');
  const broken = await tool('cad_edit_features', { project, edits: [{ op: 'set', feature: 'Sketch 1', shapes: [{ type: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }] }] });
  check('a feature the kernel cannot build reports its error in words', !broken.error && broken.data.features[1].status === 'error' && /closed region/.test(broken.data.features[1].message) && broken.data.bodies.length === 0 && broken.data.problems.length === 1,
    broken.error || JSON.stringify(broken.data.features[1]));

  // ---------------------------------------------------------------- undo and redo
  const undone = await tool('undo_changes', { project, change_id: broken.data.change_id });
  check('undo_changes takes the change back: the body is there again', !undone.error && undone.data.bodies.length === 1 && undone.data.features[1].status === 'ok', undone.error || '');
  const redone = await tool('redo_changes', { project, change_id: broken.data.change_id });
  check('redo_changes puts it back: the error is there again', !redone.error && redone.data.features[1].status === 'error', redone.error || '');
  await tool('undo_changes', { project, change_id: broken.data.change_id });

  // ---------------------------------------------------------------- more features: reorder, suppress, rollback, delete
  const pocket = await tool('cad_edit_features', { project, edits: [
    { op: 'add', type: 'sketch', name: 'Pocket sketch', ref: 'p', plane: { kind: 'face', ref: { kind: 'face', body: b.id, name: b.face_names.find((n) => /:end:/.test(n)) } }, shapes: [{ type: 'circle', cx: 30, cy: 10, r: 4 }] },
    { op: 'add', type: 'extrude', name: 'Pocket', params: { profile: '$p', operation: 'remove', depth: 5, flip: true } },
  ] });
  const withPocket = expect * 2.5 - Math.PI * 16 * 5;
  check('a sketch on a face and a removing extrude cut a pocket', !pocket.error && pocket.data.bodies.length === 1 && Math.abs(pocket.data.bodies[0].volume_mm3 - withPocket) < 0.01, pocket.error || `${pocket.data.bodies[0] && pocket.data.bodies[0].volume_mm3} vs ${withPocket}`);
  const rolled = await tool('cad_edit_features', { project, edits: [{ op: 'rollback', before: 'Pocket sketch' }] });
  check('the rollback bar is moved: the pocket is not built', !rolled.error && rolled.data.rollback_before === 'Pocket sketch' && rolled.data.features[3].status === 'rolled-back' && Math.abs(rolled.data.bodies[0].volume_mm3 - expect * 2.5) < 0.01, rolled.error || '');
  const back = await tool('cad_edit_features', { project, edits: [{ op: 'rollback', before: null }, { op: 'suppress', feature: 'Pocket', suppressed: true }] });
  check('a feature is suppressed', !back.error && back.data.features[3].status === 'suppressed' && back.data.features[3].suppressed === true, back.error || '');
  const moved = await tool('cad_edit_features', { project, edits: [{ op: 'suppress', feature: 'Pocket', suppressed: false }, { op: 'move', feature: 'Pocket', index: 0 }] });
  check('a feature moved above what it uses fails with a reason', !moved.error && moved.data.features[0].name === 'Pocket' && moved.data.features[0].status === 'error', moved.error || JSON.stringify(moved.data.features.map((f) => `${f.name}:${f.status}`)));
  const gone = await tool('cad_edit_features', { project, edits: [{ op: 'delete', feature: 'Pocket' }, { op: 'delete', feature: 'Pocket sketch' }] });
  check('features are deleted', !gone.error && gone.data.features.map((f) => f.name).join() === 'Sketch 1,Base', gone.error || '');
  if (SHOTS) { const after = await tool('cad_render_view', { project, view: 'front' }); if (after.image) fs.writeFileSync(`${SHOTS}/mcp-front.png`, after.image); }

  // ---------------------------------------------------------------- what is stored, and the record of changes
  const changes = await tool('list_changes', { project });
  check('the changes are in the record list_changes shows', !changes.error && changes.data.count >= 5, changes.error || '');
  const stored = await (await fetch(`${BASE}/api/projects/${pid}/archive`, { headers: { authorization: `Bearer ${token}`, cookie: `kc_session=${token}` } })).arrayBuffer().catch(() => null);
  check('the project archive can be downloaded with the part studio folded in', !!stored && Buffer.from(stored).includes('Bracket.jpart'), stored ? `${stored.byteLength} bytes` : 'no archive');

  // ---------------------------------------------------------------- the electronics tools beside them, each undoing its own
  const sch = docs.find((d) => d.type === 'schematic').path;
  const wire = await tool('apply_changes', { project, document: sch, title: 'A wire', edits: [{ op: 'add_wire', points: [[100.33, 100.33], [110.49, 100.33]] }] });
  check('an electronics change is applied by the same host', !wire.error && typeof wire.data.change_id === 'number', wire.error || '');
  const renamed = await tool('cad_edit_features', { project, edits: [{ op: 'rename', feature: 'Base', name: 'Plate' }] });
  const newest = await tool('undo_changes', { project });
  check('undo_changes without an id takes back the newest change, the part studio\'s, by its own domain', !newest.error && newest.data.change_id === renamed.data.change_id && newest.data.features[1].name === 'Base', newest.error || JSON.stringify(newest.data).slice(0, 200));
  const unwire = await tool('undo_changes', { project, change_id: wire.data.change_id });
  check('…and the schematic\'s change is undone by the electronics code', !unwire.error && unwire.data.undone === 'A wire' && unwire.data.document === sch, unwire.error || JSON.stringify(unwire.data).slice(0, 200));

  // ---------------------------------------------------------------- roles
  sql(`INSERT INTO permissions (project_id, user_id, role, created_by) VALUES ('${pid}', ${eveId}, 'viewer', ${adaId})`);
  const eveRead = await tool('cad_get_features', { project: pid }, eveToken);
  check('a viewer\'s assistant can read the part studio', !eveRead.error && eveRead.data.features.length === 2, eveRead.error || '');
  const eveEdit = await tool('cad_edit_features', { project: pid, edits: [{ op: 'rename', feature: 'Base', name: 'Mine' }] }, eveToken);
  check('…and is refused an edit, with the reason', /can only view/.test(eveEdit.error || ''), eveEdit.error || 'no error');
  ws.close();
} catch (e) {
  check('the session ran to the end', false, e.stack || e.message);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
