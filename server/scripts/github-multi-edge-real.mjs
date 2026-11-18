#!/usr/bin/env node
// github-multi-edge-real.mjs — the odd corners of GitHub sync against the real github.com,
// on a throwaway repository: a project that reaches its library through symbolic links,
// a Git LFS pointer, paths written on Windows or by a file dialog, a file renamed on both
// sides, a branch renamed and then deleted, a history rewritten with a force-push, the
// library turned into a submodule and back, a project file appearing in a subfolder.
//
// github-multi-edge-e2e.mjs covers these against the stand-in; this run checks that the
// real API behaves the way the stand-in says.  Run it through github-real.sh:
//
//   REAL_REPO=owner/throwaway REAL_TEST=github-multi-edge-real.mjs server/scripts/github-real.sh
//
// Everything it writes is under edge/<stamp>/ on the default branch, one entry in
// .gitmodules, and branches edge-<stamp>* and edgelib-<stamp>; all are removed at the end.
// The default branch itself is never renamed, deleted or forced.
//
//   GH_API   another API root for the "collaborator on github.com" calls (the stand-in,
//            to try the script without the real thing); REAL_LOGIN then names its user.
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pg = createRequire(here + '/')('pg');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8096').replace(/\/$/, '');
const FAKE = (process.env.E2E_FAKE_GH || 'http://127.0.0.1:8098').replace(/\/$/, '');
const API = (process.env.GH_API || 'https://api.github.com').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const REPO = process.env.REAL_REPO, GH_ID = Number(process.env.REAL_GH_ID);
const LOGIN = process.env.REAL_LOGIN || 'whoever';
if (!SECRET || !PG_URL || !REPO || !GH_ID) { console.error('E2E_JWT_SECRET, E2E_PG_URL, REAL_REPO and REAL_GH_ID are required.'); process.exit(2); }
// REAL_STAMP with REAL_CLEAN_ONLY=1 removes what an interrupted run of that stamp left behind.
const STAMP = process.env.REAL_STAMP || new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const ROOT = `edge/${STAMP}`, A = `${ROOT}/hw/a`, COMMON = `${ROOT}/hw/common`, LIB_BRANCH = `edgelib-${STAMP}`, BR = `edge-${STAMP}`;
let directToken = process.env.GH_TOKEN || '';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + String(detail).slice(0, 700) : ''}`); ok ? pass++ : fail++; };
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const eq = (name, got, want) => check(name, JSON.stringify(canon(got)) === JSON.stringify(canon(want)), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const mint = (sub, login) => { const n = Math.floor(Date.now() / 1000); const h = b64({ alg: 'HS256', typ: 'JWT' }), b = b64({ sub, login, iat: n, exp: n + 3600 });
  return `${h}.${b}.${crypto.createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}`; };

// ---- GitHub, directly: "a collaborator working on github.com"
function gh(method, p, body) {
  const args = ['-sS', '-X', method, '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', '-w', '\n%{http_code}'];
  if (directToken) args.push('-H', `Authorization: Bearer ${directToken}`);
  if (body) args.push('-H', 'Content-Type: application/json', '--data-binary', '@-');
  args.push(API + p);
  const out = execFileSync('curl', args, { input: body ? JSON.stringify(body) : undefined, maxBuffer: 1 << 28 }).toString();
  const i = out.lastIndexOf('\n');
  let j = null; try { j = JSON.parse(out.slice(0, i)); } catch {}
  return { status: Number(out.slice(i + 1)), j };
}
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.j).slice(0, 300)}`); return r.j; };
const ghHead = (branch = MAIN) => gh('GET', `/repos/${REPO}/git/ref/heads/${branch}`).j?.object?.sha;
/** Every file of a branch under `prefix`: path -> blob sha (gitlinks as "commit:<sha>"). */
function ghTree(prefix = ROOT + '/', branch = MAIN) {
  const head = ok(gh('GET', `/repos/${REPO}/git/commits/${ghHead(branch)}`), 'commit');
  const t = ok(gh('GET', `/repos/${REPO}/git/trees/${head.tree.sha}?recursive=1`), 'tree');
  return Object.fromEntries(t.tree.filter((e) => e.type !== 'tree' && e.path.startsWith(prefix)).map((e) => [e.path, e.type === 'commit' ? 'commit:' + e.sha : e.sha]));
}
const ghText = (p, branch = MAIN) => {
  const sha = ghTree(p, branch)[p];
  return sha ? Buffer.from(ok(gh('GET', `/repos/${REPO}/git/blobs/${sha}`), 'blob').content, 'base64').toString() : null;
};
/**
 * One commit on `branch`.  `changes` maps a path to its new text, to null (delete), to
 * { sha } (an existing blob: a move) or to { gitlink } (a submodule at that commit).
 * `orphan` starts a branch with no history instead.
 */
function ghCommit(changes, message, { branch = MAIN, orphan = false, rewrite = false } = {}) {
  const head = orphan ? null : ghHead(branch);
  const tree = Object.entries(changes).map(([p, v]) => {
    if (v === null) return { path: p, mode: '100644', type: 'blob', sha: null };
    if (typeof v === 'object' && v.gitlink) return { path: p, mode: '160000', type: 'commit', sha: v.gitlink };
    if (typeof v === 'object' && v.symlink) return { path: p, mode: '120000', type: 'blob', sha: ok(gh('POST', `/repos/${REPO}/git/blobs`, { content: v.symlink, encoding: 'utf-8' }), 'blob').sha };
    if (typeof v === 'object') return { path: p, mode: '100644', type: 'blob', sha: v.sha };
    return { path: p, mode: '100644', type: 'blob', sha: ok(gh('POST', `/repos/${REPO}/git/blobs`, { content: Buffer.from(v).toString('base64'), encoding: 'base64' }), 'blob').sha };
  });
  const base = head ? ok(gh('GET', `/repos/${REPO}/git/commits/${head}`), 'commit').tree.sha : undefined;
  const t = ok(gh('POST', `/repos/${REPO}/git/trees`, { ...(base ? { base_tree: base } : {}), tree }), 'new tree');
  const c = ok(gh('POST', `/repos/${REPO}/git/commits`, { message, tree: t.sha, parents: head && !rewrite ? [head] : [] }), 'new commit');
  if (rewrite) ok(gh('PATCH', `/repos/${REPO}/git/refs/heads/${branch}`, { sha: c.sha, force: true }), 'force branch');
  else if (orphan) ok(gh('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${branch}`, sha: c.sha }), 'new branch');
  else ok(gh('PATCH', `/repos/${REPO}/git/refs/heads/${branch}`, { sha: c.sha }), 'move branch');
  return c.sha;
}
const moveDir = (from, to) => Object.fromEntries(Object.entries(ghTree(from + '/')).flatMap(([p, sha]) => [[p, null], [to + p.slice(from.length), { sha }]]));
const dropDir = (dir) => Object.fromEntries(Object.keys(ghTree(dir + '/')).map((p) => [p, null]));

// ---- the server
const db = new pg.Client({ connectionString: PG_URL });
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
await db.connect();
const mkUser = async (ghId, login) => (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2)
  ON CONFLICT (github_id) DO UPDATE SET login = users.login RETURNING id`, [ghId, login])).rows[0].id;
// A second person needs a second GitHub account (the server only connects the account a
// person signed in with); without one, the first person works in both projects.
const GH_ID_2 = Number(process.env.REAL_GH_ID_2 || 0), LOGIN_2 = process.env.REAL_LOGIN_2 || LOGIN;
const aliceId = await mkUser(GH_ID, 'real-test'), bobId = GH_ID_2 ? await mkUser(GH_ID_2, 'real-test-2') : aliceId;
const alice = mint(aliceId, 'real-test'), bob = GH_ID_2 ? mint(bobId, 'real-test-2') : alice;
const call = async (jwt, method, p, body) => {
  const r = await fetch(BASE + p, { method, headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
async function connect(jwt, login = LOGIN) {
  await fetch(`${FAKE}/__ctl/browser`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login }) });
  let url = `${BASE}/auth/github/connect?next=/github`, last;
  for (let i = 0; i < 6; i++) { last = await fetch(url, { redirect: 'manual', headers: url.startsWith(BASE) ? { Cookie: `kc_session=${jwt}` } : {} }); if (last.status < 300 || last.status >= 400) break; url = new URL(last.headers.get('location'), url).toString(); }
  return last.status === 200 && (await call(jwt, 'GET', '/api/github')).j.connected;
}
const status = async (jwt, id) => (await call(jwt, 'GET', `/api/projects/${id}/github`)).j;
const file = (st, p) => (st.files || []).find((f) => f.path === p) || {};
const notSynced = (st) => Object.fromEntries((st.files || []).filter((f) => f.state !== 'synced').map((f) => [f.path, f.state + (f.deleted ? ':deleted-' + f.deleted : '') + (f.renamedFrom ? ':was-' + f.renamedFrom : '')]));
const push = (jwt, id, body = {}) => call(jwt, 'POST', `/api/projects/${id}/github/push`, body);
const pull = (jwt, id, body = {}) => call(jwt, 'POST', `/api/projects/${id}/github/pull`, body);
const docsOf = async (jwt, id) => Object.fromEntries((await call(jwt, 'GET', `/api/projects/${id}`)).j.docs.map((d) => [d.path, d.docId]));
const online = async (jwt, docId) => (await fetch(`${BASE}/api/docs/${docId}/content`, { headers: { Authorization: `Bearer ${jwt}` } })).text();
async function saveOnline(docId, content) {
  const { rows } = await db.query(`SELECT GREATEST(COALESCE((SELECT MAX(seq) FROM ops WHERE doc_id = $1), 0),
    COALESCE((SELECT MAX(seq) FROM snapshots WHERE doc_id = $1), 0)) AS head`, [docId]);
  await db.query('INSERT INTO snapshots (doc_id, seq, content) VALUES ($1, $2, $3)', [docId, rows[0].head + 1, Buffer.from(content)]);
}


/** path -> mode of every entry under the test folder. */
function ghModes(branch = MAIN) {
  const head = ok(gh('GET', `/repos/${REPO}/git/commits/${ghHead(branch)}`), 'commit');
  const t = ok(gh('GET', `/repos/${REPO}/git/trees/${head.tree.sha}?recursive=1`), 'tree');
  return Object.fromEntries(t.tree.filter((e) => e.path.startsWith(ROOT + '/')).map((e) => [e.path.slice(ROOT.length + 1), e.mode]));
}
const newBranch = (name, from = MAIN) => ok(gh('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${name}`, sha: ghHead(from) }), 'new branch');
const dropBranch = (name) => gh('DELETE', `/repos/${REPO}/git/refs/heads/${name}`);
const branches = () => ok(gh('GET', `/repos/${REPO}/branches?per_page=100`), 'branches').map((b) => b.name);

// ---- fixtures
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${STAMP.replace(/\D/g, '').slice(-12).padStart(12, '0')}`;
const fpItem = (ref, n, x, models = []) => `\t(footprint "lcsc:${ref}"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uuid(n)}")\n\t\t(at ${x} 50)\n${models.map((m) => `\t\t(model "${m}"\n\t\t\t(offset (xyz 0 0 0))\n\t\t)\n`).join('')}\t)\n`;
const board = (items) => `(kicad_pcb\n\t(version 20241229)\n\t(generator "pcbnew")\n\t(generator_version "9.0")\n\t(general\n\t\t(thickness 1.6)\n\t)\n\t(paper "A4")\n${items.join('')})\n`;
const sch = (n, note = '') => `(kicad_sch\n\t(version 20250114)\n\t(generator "eeschema")\n\t(uuid "${uuid(n)}")\n\t(paper "A4")\n${note ? `\t(text "${note}"\n\t\t(at 10 10 0)\n\t\t(uuid "${uuid(n + 500 + note.length)}")\n\t)\n` : ''})\n`;
const pro = (name, sheet = '') => `{\n  "meta": { "filename": "${name}.kicad_pro", "version": 3 },\n  "pcbnew": { "page_layout_descr_file": "${sheet}" },\n  "text_variables": { "RUN": "${STAMP}" }\n}\n`;
const mod = (name) => `(footprint "${name}"\n\t(version 20241229)\n\t(generator "pcbnew")\n\t(descr "${STAMP}")\n\t(layer "F.Cu")\n\t(attr smd)\n)\n`;
const sym = (names) => `(kicad_symbol_lib\n\t(version 20241209)\n\t(generator "kicad_symbol_editor")\n${names.map((n) => `\t(symbol "${n}_${STAMP}"\n\t\t(property "Reference" "${n[0]}"\n\t\t\t(at 0 0 0)\n\t\t)\n\t)\n`).join('')})\n`;
const wrl = (n) => `#VRML V2.0 utf8\n# ${n} ${STAMP}\n`, step = (n) => `ISO-10303-21;\n/* ${n} ${STAMP} */\nEND-ISO-10303-21;\n`;
const LFS = `version https://git-lfs.github.com/spec/v1\noid sha256:${crypto.createHash('sha256').update(STAMP).digest('hex')}\nsize 12345\n`;
const TABLE = '(sym_lib_table\n  (version 7)\n  (lib (name "shared")(type "KiCad")(uri "${KIPRJMOD}/lib/shared.kicad_sym")(options "")(descr ""))\n'
  + '  (lib (name "win")(type "KiCad")(uri "${KIPRJMOD}\\\\..\\\\parts\\\\win.kicad_sym")(options "")(descr ""))\n'
  + '  (lib (name "std")(type "KiCad")(uri "${KICAD10_SYMBOL_DIR}/Device.kicad_sym")(options "")(descr ""))\n)\n';
const MODELS = ['${KIPRJMOD}/../common/shapes/SW.wrl', `/Users/someone/Documents/GitHub/${REPO.split('/')[1]}/${COMMON}/shapes/ABS.wrl`, '${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603.step'];
const PCB = (x) => board([fpItem('SW', 1, x, MODELS), fpItem('R', 2, 110)]);
const libFiles = (prefix) => ({ [`${prefix}lib/shared.kicad_sym`]: sym(['S']), [`${prefix}lib/fp.pretty/R.kicad_mod`]: mod('R'),
  [`${prefix}shapes/SW.wrl`]: wrl('SW'), [`${prefix}shapes/SW.step`]: step('SW'), [`${prefix}shapes/ABS.wrl`]: wrl('ABS'), [`${prefix}shapes/ABS.step`]: step('ABS') });
const A_DOCS = ['../common/shapes/ABS.step', '../common/shapes/ABS.wrl', '../common/shapes/SW.step', '../common/shapes/SW.wrl', '../parts/win.kicad_sym', '../shared/frame.kicad_wks',
  'a.kicad_pcb', 'a.kicad_pro', 'a.kicad_sch', 'alias.kicad_sym', 'lib/fp.pretty/R.kicad_mod', 'lib/shared.kicad_sym', 'sym-lib-table'];

const made = [], madeBranches = [];
let modulesBefore = null, mainBefore = null, MAIN = 'main';
try {
  check('the person connects their GitHub account', await connect(alice));
  if (process.env.GH_API) directToken = (await (await fetch(`${FAKE}/__ctl/tokens`)).json()).find((t) => t.login === LOGIN).token;
  MAIN = ok(gh('GET', `/repos/${REPO}`), 'repo').default_branch;
  mainBefore = ghHead();
  modulesBefore = ghText('.gitmodules');
  if (process.env.REAL_CLEAN_ONLY) throw Object.assign(new Error('clean only'), { cleanOnly: true });

  // ============================================================ symbolic links, a Git LFS pointer, paths of every kind
  ghCommit({
    [`${A}/a.kicad_pro`]: pro('a', '../shared/frame.kicad_wks'), [`${A}/a.kicad_pcb`]: PCB(100), [`${A}/a.kicad_sch`]: sch(11), [`${A}/sym-lib-table`]: TABLE,
    [`${A}/models/big.step`]: LFS,
    [`${A}/lib`]: { symlink: '../common/lib' }, [`${A}/alias.kicad_sym`]: { symlink: '../common/lib/shared.kicad_sym' },
    [`${A}/away.kicad_sym`]: { symlink: '../../../../../elsewhere/x.kicad_sym' }, [`${A}/gone.kicad_sym`]: { symlink: 'nothing-here.kicad_sym' }, [`${A}/round`]: { symlink: '.' },
    ...libFiles(`${COMMON}/`), [`${ROOT}/hw/parts/win.kicad_sym`]: sym(['W']), [`${ROOT}/hw/shared/frame.kicad_wks`]: `(kicad_wks (version 20231118) (generator "pl_editor") (setup (textsize 1.5 1.5)) (tbtext "${STAMP}" (name "") (pos 10 10)))\n`,
  }, `Sync edge test ${STAMP}: a project with links, an LFS pointer, a library two folders away`);
  let r = await call(alice, 'POST', '/api/github/import', { repo: REPO, paths: [A] });
  const pa = r.j.projects?.[0]?.projectId; made.push(pa);
  let docs = await docsOf(alice, pa);
  eq('real GitHub: links to a folder and a file are followed; a link out of the repository, a dangling one, a loop and an LFS pointer are left out; Windows, absolute and drawing-sheet paths are found',
    Object.keys(docs).sort(), A_DOCS);
  check('a linked file has the real content', await online(alice, docs['alias.kicad_sym']) === sym(['S']));
  let st = await status(alice, pa);
  eq('each thing left out is said', [...new Set((st.notes || []).map((n) => n.kind))].sort(), ['lfs', 'symlink_broken', 'symlink_loop', 'symlink_outside']);
  eq('in sync', notSynced(st), {});

  await saveOnline(docs['lib/shared.kicad_sym'], sym(['S', 'T']));
  const newMod = (await db.query(`INSERT INTO documents (project_id, path, doc_type) VALUES ($1, 'lib/fp.pretty/C.kicad_mod', 'footprint') RETURNING id`, [pa])).rows[0].id;
  await saveOnline(newMod, mod('C'));
  r = await push(alice, pa, { message: `Sync edge test ${STAMP}: through the link` });
  let modes = ghModes();
  eq('a push through a link writes the real files and leaves the links and the LFS pointer alone',
    [r.status, ghText(`${COMMON}/lib/shared.kicad_sym`) === sym(['S', 'T']), ghText(`${COMMON}/lib/fp.pretty/C.kicad_mod`) === mod('C'), modes['hw/a/lib'], modes['hw/a/alias.kicad_sym'], ghText(`${A}/models/big.step`) === LFS],
    [200, true, true, '120000', '120000', true]);
  eq('the same file under its other name is then a pull', notSynced(await status(alice, pa)), { 'alias.kicad_sym': 'pull' });
  await pull(alice, pa);
  eq('…and all is in sync', notSynced(await status(alice, pa)), {});

  // ============================================================ renames made with git, and on both sides at once
  const tree = ghTree(`${COMMON}/`);
  ghCommit({ [`${COMMON}/shapes/SW.wrl`]: null, [`${COMMON}/shapes/sw.wrl`]: { sha: tree[`${COMMON}/shapes/SW.wrl`] },
    [`${A}/a.kicad_pcb`]: PCB(100).replace('/shapes/SW.wrl', '/shapes/sw.wrl') }, `Sync edge test ${STAMP}: a rename that only changes case`);
  st = await status(alice, pa);
  eq('a rename that only changes case is a rename', notSynced(st), { '../common/shapes/sw.wrl': 'pull:was-../common/shapes/SW.wrl', 'a.kicad_pcb': 'pull' });
  await pull(alice, pa);
  check('…and keeps the online document', (await docsOf(alice, pa))['../common/shapes/sw.wrl'] === docs['../common/shapes/SW.wrl']);
  await db.query('UPDATE documents SET path = $2 WHERE id = $1', [docs['../parts/win.kicad_sym'], '../parts/win_online.kicad_sym']);
  ghCommit({ [`${ROOT}/hw/parts/win.kicad_sym`]: null, [`${ROOT}/hw/parts/win_github.kicad_sym`]: sym(['W']) }, `Sync edge test ${STAMP}: rename win`);
  st = await status(alice, pa);
  eq('a file renamed to one name online and another on GitHub is one file', notSynced(st), { '../parts/win_online.kicad_sym': 'push:was-../parts/win_github.kicad_sym' });
  r = await push(alice, pa, { message: `Sync edge test ${STAMP}: one name` });
  eq('a push leaves one file, under the online name', [r.status, Object.keys(ghTree(`${ROOT}/hw/parts/`)).map((p) => p.slice(ROOT.length + 1)), notSynced(await status(alice, pa))], [200, ['hw/parts/win_online.kicad_sym'], {}]);

  // ============================================================ a branch renamed, then deleted
  newBranch(BR); madeBranches.push(BR, `${BR}-renamed`, `${BR}-rewritten`);
  r = await call(alice, 'POST', '/api/github/import', { repo: REPO, branch: BR, paths: [A], duplicate: true });
  const pb = r.j.projects?.[0]?.projectId; made.push(pb);
  let docsB = await docsOf(alice, pb);
  eq('a second online project of the same folder, on a branch', [r.status, notSynced(st = await status(alice, pb)), st.link?.branch], [200, {}, BR]);
  r = gh('POST', `/repos/${REPO}/branches/${BR}/rename`, { new_name: `${BR}-renamed` });
  check('(the branch is renamed on GitHub)', r.status < 300, JSON.stringify(r.j));
  // github.com can go on serving the old name for a few seconds after a rename; the link moves at the first look after that
  let movedTo = null;
  for (let i = 0; i < 20; i++) {
    st = await status(alice, pb);
    movedTo = movedTo || st.branchMoved;
    if (st.link?.branch === `${BR}-renamed`) break;
    await new Promise((res) => setTimeout(res, 1500));
  }
  eq('a branch renamed on GitHub: the link follows it, in sync', [movedTo, st.link?.branch, st.missing, notSynced(st)], [{ from: BR, to: `${BR}-renamed` }, `${BR}-renamed`, undefined, {}]);
  await saveOnline(docsB['a.kicad_sch'], sch(11, 'on the renamed branch'));
  r = await push(alice, pb, { message: `Sync edge test ${STAMP}: on the renamed branch` });
  check('…a push goes to the new name', r.status === 200 && (ghText(`${A}/a.kicad_sch`, `${BR}-renamed`) || '').includes('on the renamed branch') && !branches().includes(BR), JSON.stringify(r.j));
  dropBranch(`${BR}-renamed`);
  st = await status(alice, pb);
  eq('that branch deleted (as after a merge): the link moves to the default branch, where the project is; nothing is recreated', [st.branchMoved, st.link?.branch, notSynced(st), branches().includes(`${BR}-renamed`)],
    [{ from: `${BR}-renamed`, to: MAIN }, MAIN, { 'a.kicad_sch': 'pull' }, false]);
  await pull(alice, pb);
  eq('(level again)', notSynced(await status(alice, pb)), {});

  // ============================================================ history rewritten with a force-push
  newBranch(`${BR}-rewritten`);
  r = await call(alice, 'PUT', `/api/projects/${pb}/github`, { repo: REPO, branch: `${BR}-rewritten`, path: A });
  eq('(the second project on a branch of its own)', [r.status, notSynced(await status(alice, pb))], [200, {}]);
  await saveOnline(docsB['a.kicad_pro'], pro('a', '../shared/frame.kicad_wks').replace('"RUN"', '"EDITED"'));
  ghCommit({ [`${A}/a.kicad_sch`]: sch(11, 'rewritten') }, `Sync edge test ${STAMP}: squashed`, { branch: `${BR}-rewritten`, rewrite: true });
  st = await status(alice, pb);
  eq('history rewritten: files are compared by content, so only what differs shows', notSynced(st), { 'a.kicad_pro': 'push', 'a.kicad_sch': 'pull' });
  r = await pull(alice, pb);
  const r2 = await push(alice, pb, { message: `Sync edge test ${STAMP}: after the rewrite` });
  const parents = ok(gh('GET', `/repos/${REPO}/git/commits/${ghHead(`${BR}-rewritten`)}`), 'commit').parents.length;
  check('…pull and push go on from the rewritten branch', r.status === 200 && r2.status === 200 && (ghText(`${A}/a.kicad_pro`, `${BR}-rewritten`) || '').includes('EDITED') && parents === 1, JSON.stringify([r.j, r2.j]));

  // ============================================================ the library turned into a submodule, and back
  const now = Object.fromEntries(Object.keys(ghTree(`${COMMON}/`)).map((p) => [p.slice(COMMON.length + 1), ghText(p)]));
  const libTip = ghCommit(now, `Sync edge test ${STAMP}: the library on its own`, { branch: LIB_BRANCH, orphan: true });
  ghCommit({ ...dropDir(COMMON) }, `Sync edge test ${STAMP}: drop the library folder`);
  ghCommit({ [COMMON]: { gitlink: libTip },
    '.gitmodules': (modulesBefore || '') + `[submodule "${COMMON}"]\n\tpath = ${COMMON}\n\turl = https://github.com/${REPO}.git\n\tbranch = ${LIB_BRANCH}\n` }, `Sync edge test ${STAMP}: the library as a submodule`);
  st = await status(alice, pa);
  const docsNow = await docsOf(alice, pa);
  eq('the library folder turned into a submodule, reached through a symbolic link: the same files, in sync', [notSynced(st), !!file(st, 'lib/shared.kicad_sym').submodule, Object.keys(docsNow).length], [{}, true, A_DOCS.length + 1]);
  check('…still the same online documents', docsNow['lib/shared.kicad_sym'] === docs['lib/shared.kicad_sym']);
  await saveOnline(docs['lib/shared.kicad_sym'], sym(['S', 'T', 'U']));
  r = await push(alice, pa, { message: `Sync edge test ${STAMP}: into the submodule` });
  check('…a change to it is committed to the submodule\'s own branch', r.status === 200 && r.j.submodules?.length === 1 && ghText('lib/shared.kicad_sym', LIB_BRANCH) === sym(['S', 'T', 'U']), JSON.stringify(r.j));
  await pull(alice, pa);
  const back = Object.fromEntries(Object.keys(ghTree('', LIB_BRANCH)).map((p) => [`${COMMON}/${p}`, ghText(p, LIB_BRANCH)]));
  ghCommit({ [COMMON]: null, '.gitmodules': modulesBefore }, `Sync edge test ${STAMP}: drop the submodule`);
  ghCommit(back, `Sync edge test ${STAMP}: the library as a folder again`);
  st = await status(alice, pa);
  eq('…and turned back into a plain folder: in sync, nothing duplicated', [notSynced(st), !!file(st, 'lib/shared.kicad_sym').submodule, Object.keys(await docsOf(alice, pa)).length], [{}, false, A_DOCS.length + 1]);

  // ============================================================ a project appearing inside the project, line endings
  ghCommit({ [`${A}/panel/panel.kicad_sch`]: sch(41) }, `Sync edge test ${STAMP}: a sheet in a subfolder`);
  await pull(alice, pa);
  ghCommit({ [`${A}/panel/panel.kicad_pro`]: pro('panel'), [`${A}/panel/panel.kicad_pcb`]: board([]) }, `Sync edge test ${STAMP}: the subfolder becomes a project`);
  st = await status(alice, pa);
  eq('a project file appearing beside a sheet later takes nothing away', [notSynced(st), st.nested, !!(await docsOf(alice, pa))['panel/panel.kicad_sch']], [{}, ['panel'], true]);
  ghCommit({ [`${A}/a.kicad_sch`]: sch(11).replace(/\n/g, '\r\n') }, `Sync edge test ${STAMP}: Windows line endings`);
  eq('a file re-saved with Windows line endings is a change like any other', notSynced(await status(alice, pa)), { 'a.kicad_sch': 'pull' });
  r = await pull(alice, pa);
  eq('…pulled once, then quiet', [r.status, notSynced(await status(alice, pa))], [200, {}]);

  // ============================================================ nothing was forced
  const log = ok(gh('GET', `/repos/${REPO}/commits?sha=${MAIN}&per_page=60`), 'log').map((c) => c.sha);
  check('the default branch only ever moved forward', log.includes(mainBefore));
} catch (e) {
  if (!e.cleanOnly) check('run completed', false, e.stack || String(e));
} finally {
  // leave the repository as it was found
  try {
    if (mainBefore) {
      const drop = dropDir(ROOT);
      // (a path that is not there cannot be removed: GitHub answers 422 BadObjectState)
      const mods = ghText('.gitmodules');
      const entry = `[submodule "${COMMON}"]`;
      if (mods && mods.includes(entry)) drop['.gitmodules'] = mods.slice(0, mods.indexOf(entry)) || null;
      if (Object.keys(drop).length) ghCommit(drop, `Sync edge test ${STAMP}: clean up`);
    }
    for (const b of [BR, `${BR}-renamed`, `${BR}-rewritten`, LIB_BRANCH]) dropBranch(b);
    const left = branches().filter((b) => b.includes(STAMP));
    check('the repository is tidied up', Object.keys(ghTree(ROOT + '/')).length === 0 && !(ghText('.gitmodules') || '').includes(COMMON) && left.length === 0, JSON.stringify(left));
  } catch (e) { check('the repository is tidied up', false, String(e)); }
  for (const id of made) if (id) await call(alice, 'DELETE', `/api/projects/${id}`).catch(() => {});
  await db.query('DELETE FROM projects WHERE owner_id = ANY($1)', [[aliceId, bobId]]).catch(() => {});
  await db.query('DELETE FROM users WHERE id = ANY($1)', [[aliceId, bobId]]).catch(() => {});
  await db.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
