// The assistant's tools in a project with several PCBs, over the real /mcp endpoint: every electronics tool
// works on ONE PCB, the one the call names, and neither reads nor writes another's schematic or board.
//
// A project with two PCBs is made over the API: "Alpha", whose schematic has one resistor (R1), and "Beta", which
// is empty.  Then, with an access key: get_project lists both; the components of Alpha are R1 and Beta has none;
// "<PCB>/board" and "<PCB>/schematic" name a PCB's documents; a call that names no PCB works on the one used last
// and says so; an edit to Beta's schematic lands in Beta's file and leaves Alpha's as it was; and a project with
// KiCad's files at its root answers as it always did.
//
// Setup as the *-ui.mjs scripts (no browser needed): a local server with KC_DEV_LOGIN=1 on a throwaway database,
// node on the server's PATH (it runs the tool host), and psql here (it makes the test user):
//
//   E2E_PG_URL=postgres://… E2E_JWT_SECRET=testsecret [E2E_BASE=http://127.0.0.1:8099] node scripts/shell-mcp.mjs
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + String(detail).replace(/\s+/g, ' ').slice(0, 420) : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
const sql = (text) => execFileSync('psql', [PG_URL, '-Atc', text], { encoding: 'utf8' }).trim();
sql(`INSERT INTO users (github_id, login, name) VALUES (978201, 'shell-mcp-ada', 'Ada Lovelace') ON CONFLICT (github_id) DO NOTHING`);
const ada = jwt(Number(sql(`SELECT id FROM users WHERE github_id = 978201`)), 'shell-mcp-ada');

async function api(method, path, body, raw) {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${ada}`, 'content-type': raw ? 'application/octet-stream' : 'application/json' }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${t.slice(0, 200)}`);
  return j;
}
/** A document as it is now: the stored file and every edit made since, as text to search. */
async function now(docId) {
  const r = await fetch(`${BASE}/api/docs/${docId}/content`, { headers: { authorization: `Bearer ${ada}` } });
  const seq = Number(r.headers.get('x-snapshot-seq')) || 0, head = Number(r.headers.get('x-head-seq')) || 0, text = await r.text();
  const ops = head > seq ? await api('GET', `/api/docs/${docId}/ops?since=${seq}`) : { ops: [] };
  return { head, text: text + JSON.stringify(ops.ops || []) };
}

const uuid = () => crypto.randomUUID();
const prop = (k, v, hide) => `(property "${k}" "${v}" (at 0 0 0) (effects (font (size 1.27 1.27))${hide ? ' (hide yes)' : ''}))`;
const rootUuid = uuid();
const alphaSch = `(kicad_sch (version 20250114) (generator "eeschema") (generator_version "9.0") (uuid "${rootUuid}") (paper "A4")
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
    (property "Footprint" "Resistor_SMD:R_0603_1608Metric" (at 98.552 80.01 90) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Datasheet" "~" (at 100.33 80.01 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Description" "Resistor" (at 100.33 80.01 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (pin "1" (uuid "${uuid()}")) (pin "2" (uuid "${uuid()}"))
    (instances (project "Alpha" (path "/${rootUuid}" (reference "R1") (unit 1)))))
  (sheet_instances (path "/" (page "1")))
  (embedded_fonts no))
`;

let rpcId = 0, key = '';
async function call(name, args) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}`, 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json();
  if (!j.result) return { isError: true, text: JSON.stringify(j.error), data: null };
  const text = (j.result.content.find((c) => c.type === 'text') || {}).text || ''; let data = null; try { data = JSON.parse(text); } catch { /* prose */ }
  return { isError: !!j.result.isError, text, data };
}
const refsOf = (r) => JSON.stringify(r.data || r.text).match(/"R\d+"/g) || [];

try {
  // ---- the project: two PCBs.  Beta is made by the shell's route; Alpha's schematic comes with a part in it.
  const name = `Shell MCP ${Date.now().toString(36)}`;
  const project = await api('POST', '/api/projects/blank', { name });
  const pid = project.projectId;
  const beta = await api('POST', `/api/projects/${pid}/pcbs`, { name: 'Beta' });
  const alpha = await api('POST', `/api/projects/${pid}/pcbs`, { name: 'Alpha', only: ['kicad_pro', 'kicad_pcb'] });
  const sch = await api('POST', `/api/projects/${pid}/docs`, { path: 'Alpha/Alpha.kicad_sch' });
  await api('POST', `/api/docs/${sch.docId}/snapshots?seq=0`, alphaSch, true);
  const id = (list, type) => list.docs.find((d) => d.docType === type).docId;
  const alphaSchId = sch.docId, alphaPcbId = id(alpha, 'kicad_pcb'), betaSchId = id(beta, 'kicad_sch'), betaPcbId = id(beta, 'kicad_pcb');
  check('a project with two PCBs, each in its folder', beta.dir === 'Beta' && alpha.dir === 'Alpha' && alpha.docs.length === 2, JSON.stringify([alpha.docs.map((d) => d.path), beta.docs.map((d) => d.path)]));

  key = (await api('POST', '/api/mcp/keys', { name: 'shell-mcp test', write: true })).key;
  check('an access key that may write', /^kcm_at_/.test(key || ''));

  const listed = await call('get_project', { project: name });
  const paths = (listed.data && listed.data.documents || []).map((d) => d.path);
  check('get_project lists the documents of both PCBs by their paths', ['Alpha/Alpha.kicad_sch', 'Alpha/Alpha.kicad_pcb', 'Beta/Beta.kicad_sch', 'Beta/Beta.kicad_pcb'].every((p) => paths.includes(p)), paths.join(', '));

  // ---- reading: each PCB by name
  const a = await call('list_components', { project: name, document: 'Alpha/schematic' });
  check('list_components on "Alpha/schematic" finds R1', !a.isError && refsOf(a).includes('"R1"') && a.data && a.data.pcb === 'Alpha', a.text);
  check('and the result says which PCB it worked on, and that there are others', /2 PCBs/.test((a.data && a.data.pcbs) || '') && /"Beta"/.test(a.data.pcbs), a.data && a.data.pcbs);
  const b = await call('list_components', { project: name, document: 'Beta/schematic' });
  check('list_components on "Beta/schematic" finds nothing: Alpha\'s R1 is not Beta\'s', !b.isError && !refsOf(b).includes('"R1"') && b.data && b.data.pcb === 'Beta', b.text);
  const byPath = await call('list_components', { project: name, document: 'Alpha/Alpha.kicad_sch' });
  check('a path as get_project lists it names the PCB too', !byPath.isError && refsOf(byPath).includes('"R1"') && byPath.data.pcb === 'Alpha', byPath.text);
  const sticky = await call('get_design_overview', { project: name });
  check('a call that names no PCB works on the one used last, and says none was named', !sticky.isError && sticky.data && sticky.data.pcb === 'Alpha' && /none was named/.test(sticky.data.pcbs || '') && /Alpha\.kicad_sch/.test(sticky.text) && !/Beta\.kicad/.test(sticky.text), sticky.text);
  const which = await call('list_components', { project: name });
  check('a tool that needs a document and gets none offers that PCB\'s documents only', which.isError && /Alpha\.kicad_sch/.test(which.text) && !/Beta/.test(which.text), which.text);
  const overviewB = await call('get_design_overview', { project: name, document: 'Beta/board' });
  check('get_design_overview on "Beta/board" is about Beta', !overviewB.isError && overviewB.data && overviewB.data.pcb === 'Beta' && !/R1/.test(overviewB.text.replace(/"pcbs":"[^"]*"/, '')), overviewB.text);
  const boardA = await call('get_board_info', { project: name, document: 'Alpha/board' });
  check('get_board_info on "Alpha/board" opens Alpha\'s board', !boardA.isError && boardA.data && boardA.data.pcb === 'Alpha', boardA.text);
  const bomA = await call('get_bom', { project: name, document: 'Alpha/schematic' }), bomB = await call('get_bom', { project: name, document: 'Beta/schematic' });
  check('get_bom: Alpha has R1, Beta has no line', !bomA.isError && /R1/.test(bomA.text) && !bomB.isError && !/R1/.test(bomB.text.replace(/"pcbs":"[^"]*"/, '')), `${bomA.text.slice(0, 160)} // ${bomB.text.slice(0, 160)}`);
  const nowhere = await call('list_components', { project: name, document: 'Gamma/schematic' });
  check('a PCB that is not there is an error that lists what is, not a guess', nowhere.isError, nowhere.text);

  // ---- writing: an edit to Beta lands in Beta
  const before = { a: await now(alphaSchId), ap: await now(alphaPcbId), b: await now(betaSchId), bp: await now(betaPcbId) };
  const edit = await call('apply_changes', { project: name, document: 'Beta/schematic', title: 'a note on Beta', edits: [{ op: 'add_text', text: 'beta only', x: 50, y: 50 }] });
  check('apply_changes on "Beta/schematic" is applied', !edit.isError && edit.data && edit.data.pcb === 'Beta', edit.text);
  await new Promise((r) => setTimeout(r, 1500));
  const after = { a: await now(alphaSchId), ap: await now(alphaPcbId), b: await now(betaSchId), bp: await now(betaPcbId) };
  check('the text is in Beta\'s schematic', /beta only/.test(after.b.text) && after.b.head > before.b.head, `head ${before.b.head} → ${after.b.head}`);
  check('Alpha\'s schematic and both boards are exactly as they were', after.a.text === before.a.text && after.ap.text === before.ap.text && after.bp.text === before.bp.text && !/beta only/.test(after.a.text));
  const editA = await call('apply_changes', { project: name, document: 'schematic', title: 'a note, no PCB named', edits: [{ op: 'add_text', text: 'last used', x: 60, y: 60 }] });
  await new Promise((r) => setTimeout(r, 1500));
  check('"schematic" with no PCB named is the schematic of the PCB used last (Beta), and the result says so', !editA.isError && editA.data.pcb === 'Beta' && /last used/.test((await now(betaSchId)).text) && !/last used/.test((await now(alphaSchId)).text), editA.text);

  // ---- a project from before: KiCad's files at the root
  const oldName = `Shell MCP old ${Date.now().toString(36)}`;
  const old = await api('POST', '/api/projects/blank', { name: oldName, template: 'pcb' });
  const o = await call('get_design_overview', { project: oldName });
  check('a project with KiCad\'s files at its root answers as it always did: no PCB to name, nothing added to the result', !o.isError && o.data && o.data.pcb === undefined && o.data.pcbs === undefined, o.text.slice(0, 200));
  const oEdit = await call('apply_changes', { project: oldName, document: 'schematic', title: 'old', edits: [{ op: 'add_text', text: 'old project', x: 50, y: 50 }] });
  await new Promise((r) => setTimeout(r, 1200));
  check('and its schematic is edited by "schematic"', !oEdit.isError && /old project/.test((await now(old.docs.find((d) => d.docType === 'kicad_sch').docId)).text), oEdit.text);
  const made = await call('create_project', { name: `Shell MCP made ${Date.now().toString(36)}` });
  check('create_project still makes a project with a schematic and a board', !made.isError && made.data && made.data.documents.some((p) => p.endsWith('.kicad_sch')) && made.data.documents.some((p) => p.endsWith('.kicad_pcb')), made.text);
  for (const p of [pid, old.projectId, made.data && made.data.project_id]) if (p) await fetch(`${BASE}/api/projects/${p}?permanent=true`, { method: 'DELETE', headers: { authorization: `Bearer ${ada}` } });
} catch (e) {
  check('the script ran to its end', false, String(e && e.stack || e));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
