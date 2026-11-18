// "Loads in desktop": every kind of file the server writes is opened by the desktop's own
// reader (kicad-cli from a Junction build), so a writer bug is caught here and not by a user.
//
// The files come from a running server, the way people get them:
//   - a blank project and every template
//   - KiCad's demo projects uploaded without their library folders, downloaded again
//     (the download writes the missing symbol libraries back from the schematics)
//   - the same projects after an assistant's edits to a sheet and to the board, downloaded
//     again (the download folds the journalled edits into the stored files)
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… KICAD_CLI="/path/to/junction kicad-cli" [OUT=dir] [DEMOS=a,b]
//     node desktop-load-check.mjs
//
// Without KICAD_CLI the corpus is still built and checked for balanced files, and the script
// says that the desktop check was skipped (exit 0 locally, exit 1 when CI=true).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
const CLI = (process.env.KICAD_CLI || '').trim().split(/\s+/).filter(Boolean);
const DEMOS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../demos');
const WANT = (process.env.DEMOS || 'ecc83,interf_u,complex_hierarchy,pic_programmer,video,microwave,multichannel,stickhub,sonde xilinx').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = process.env.OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-load-'));
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + String(detail).slice(0, 600) : ''}`); ok ? pass++ : fail++; return ok; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000), head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 7200 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const uid = (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [9831, 'load-alice', 'Alice'])).rows[0].id;
await db.query('DELETE FROM projects WHERE owner_id = $1', [uid]);
const jwt = mintJwt(uid, 'load-alice');
const auth = { authorization: `Bearer ${jwt}` };
const json = async (p, opts = {}) => { const r = await fetch(BASE + p, { ...opts, headers: { ...auth, ...(opts.json ? { 'content-type': 'application/json' } : {}) }, body: opts.json ? JSON.stringify(opts.json) : opts.body }); const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; } };

/** Download a project as people do and unpack it; returns the folder that holds its files. */
async function download(projectId, name) {
  const r = await fetch(`${BASE}/api/projects/${projectId}/archive`, { headers: auth });
  if (!r.ok) throw new Error(`archive ${r.status}`);
  const dir = path.join(OUT, name.replace(/[^\w.-]+/g, '_')); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'p.zip'), Buffer.from(await r.arrayBuffer()));
  execSync(`cd "${dir}" && unzip -qo p.zip && rm p.zip`);
  return dir;
}
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

/** One list from the first "(" to the last ")", strings respected: what any reader needs before anything else. */
function balanced(text) {
  let depth = 0, quoted = false, closedAt = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true; else if (c === '(') depth++; else if (c === ')') { depth--; if (depth < 0) return false; if (depth === 0) closedAt = i; }
  }
  return depth === 0 && !quoted && closedAt >= 0 && text.slice(closedAt + 1).trim() === '';
}

/** The desktop reader's verdict on one file: '' when it loads, else what it said. */
function desktopLoads(file) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-out-'));
  const ext = path.extname(file);
  const args = ext === '.kicad_sch' ? ['sch', 'export', 'netlist', '-o', path.join(tmp, 'n.net'), file]
    : ext === '.kicad_pcb' ? ['pcb', 'export', 'svg', '--layers', 'F.Cu,Edge.Cuts', '-o', path.join(tmp, 'b.svg'), file]
    : ext === '.kicad_sym' ? ['sym', 'export', 'svg', '-o', tmp, file]
    : ['fp', 'export', 'svg', '-o', tmp, path.dirname(file)];
  let out = '', code = 0;
  try { out = execFileSync(CLI[0], [...CLI.slice(1), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 }); }
  catch (e) { code = e.status ?? 1; out = String(e.stdout || '') + String(e.stderr || '') + (e.signal ? ` (signal ${e.signal})` : ''); }
  const wrote = fs.readdirSync(tmp).length > 0; fs.rmSync(tmp, { recursive: true, force: true });
  // A sheet that belongs to a hierarchy is refused by name and read when its root is loaded.
  if (ext === '.kicad_sch' && /is a hierarchical subsheet/i.test(out)) return '';
  const bad = /Failed to load|Error loading|Expecting|Unable to (load|open|read)|could not be (loaded|read|opened)|IO_ERROR|Parse error|invalid/i.exec(out);
  return code === 0 && wrote && !bad ? '' : `exit ${code}${wrote ? '' : ', nothing written'}: ${out.trim().split('\n').slice(-6).join(' | ')}`;
}

/** Check every design and library file under a downloaded project. */
function verify(label, dir) {
  const files = walk(dir).filter((f) => /\.(kicad_sch|kicad_pcb|kicad_sym|kicad_mod)$/.test(f));
  const broken = files.filter((f) => !balanced(fs.readFileSync(f, 'utf8')));
  check(`${label}: ${files.length} files are whole`, files.length > 0 && !broken.length, broken.map((f) => path.relative(dir, f)).join(', '));
  if (!CLI.length) return;
  const seenLibs = new Set(); const failures = [];
  for (const f of files) {
    if (f.endsWith('.kicad_mod')) { const lib = path.dirname(f); if (seenLibs.has(lib)) continue; seenLibs.add(lib); }
    const said = desktopLoads(f); if (said) failures.push(`${path.relative(dir, f)}: ${said}`);
  }
  check(`${label}: the desktop opens every one`, !failures.length, failures.join(' ;; '));
}

// ---------------------------------------------------------------- blank project and templates
{
  const blank = await json('/api/projects/blank', { method: 'POST', json: { name: 'load blank', template: 'pcb' } });
  if (check('a blank project is made', blank.status === 200 && !!blank.body.projectId, JSON.stringify(blank.body))) verify('blank project', await download(blank.body.projectId, 'blank'));
  const list = await json('/api/templates');
  const templates = Array.isArray(list.body) ? list.body : (list.body && list.body.templates) || [];
  check('the server lists its templates', templates.length > 0, JSON.stringify(list.body).slice(0, 200));
  for (const t of templates) {
    const made = await json('/api/projects/from-template', { method: 'POST', json: { template: t.id, name: `load ${t.id}` } });
    if (check(`template ${t.id} makes a project`, made.status === 200 && !!made.body.projectId, JSON.stringify(made.body).slice(0, 200))) verify(`template ${t.id}`, await download(made.body.projectId, `template-${t.id}`));
  }
}

// ---------------------------------------------------------------- demos without their libraries, then edited
const key = await json('/api/mcp/keys', { method: 'POST', json: { name: 'desktop load check', write: true } });
check('an access key for the edits', key.status === 200 && /^kcm_at_/.test(key.body.key || ''), JSON.stringify(key.body).slice(0, 200));
let rpcId = 0;
async function tool(name, args) {
  const r = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${key.body.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  const text = await r.text();
  const msgs = (r.headers.get('content-type') || '').includes('event-stream') ? text.split(/\n\n/).map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')).filter(Boolean).map((d) => JSON.parse(d)) : [JSON.parse(text)];
  const res = msgs.find((m) => m.id !== undefined) || {};
  const body = res.result ? (res.result.content.find((c) => c.type === 'text') || {}).text || '' : JSON.stringify(res.error);
  return { isError: !res.result || !!res.result.isError, text: body };
}

for (const demo of WANT) {
  const src = path.join(DEMOS_DIR, demo);
  if (!fs.existsSync(src)) { check(`demo ${demo} is in the repository`, false); continue; }
  // web-style: the design files and tables, without the project's own library folders and files
  const files = walk(src).filter((f) => /\.(kicad_pro|kicad_sch|kicad_pcb)$/.test(f) || /(^|\/)(sym|fp)-lib-table$/.test(f));
  const form = new FormData(); form.append('name', `load ${demo}`);
  for (const f of files) form.append('file', new Blob([fs.readFileSync(f)]), path.relative(src, f).split(path.sep).join('/'));
  const up = await fetch(BASE + '/api/projects', { method: 'POST', headers: auth, body: form });
  const made = await up.json().catch(() => ({}));
  if (!check(`demo ${demo} uploads without its libraries`, up.status === 200 && !!made.projectId, JSON.stringify(made).slice(0, 300))) continue;
  verify(`demo ${demo}, as uploaded`, await download(made.projectId, `demo-${demo}`));

  // an edit on the first sheet and on the first board, folded into the files by the next download
  const sch = made.docs.find((d) => d.docType === 'kicad_sch'), pcb = made.docs.find((d) => d.docType === 'kicad_pcb');
  let edited = 0;
  if (sch) { const r = await tool('apply_changes', { project: made.projectId, document: sch.path, title: 'Load check', edits: [{ op: 'add_text', text: 'Edited for the desktop load check', x: 25.4, y: 25.4 }] }); if (check(`demo ${demo}: an edit to ${sch.path}`, !r.isError, r.text)) edited++; }
  if (pcb) { const r = await tool('apply_changes', { project: made.projectId, document: pcb.path, title: 'Load check', edits: [{ op: 'add_text', text: 'LOAD CHECK', x: 20, y: 20 }] }); if (check(`demo ${demo}: an edit to ${pcb.path}`, !r.isError, r.text)) edited++; }
  if (edited) {
    const dir = await download(made.projectId, `demo-${demo}-edited`);
    const kept = walk(dir).filter((f) => /\.(kicad_sch|kicad_pcb)$/.test(f)).some((f) => /Edited for the desktop load check|LOAD CHECK/.test(fs.readFileSync(f, 'utf8')));
    check(`demo ${demo}: the downloaded files hold the edits`, kept);
    verify(`demo ${demo}, edited`, dir);
  }
}

await db.query('DELETE FROM projects WHERE owner_id = $1', [uid]);
await db.end();
if (!CLI.length) console.log(`\nKICAD_CLI is not set: the files were made and checked for wholeness, but no desktop reader opened them.`);
console.log(`\n${pass} passed, ${fail} failed  (files kept in ${OUT})`);
process.exit(fail || (!CLI.length && process.env.CI === 'true') ? 1 : 0);
