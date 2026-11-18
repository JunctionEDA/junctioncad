#!/usr/bin/env node
// github-multi-real.mjs — the several-projects-per-repository paths of GitHub sync against
// the real github.com, on a throwaway repository: two boards sharing a library folder, a
// project nested in another, the library as a submodule, and files and folders renamed,
// moved and deleted on either side, with two people syncing.
//
// github-multi-e2e.mjs covers every path against the stand-in; this run checks that the
// real API behaves the way the stand-in says.  Run it through github-real.sh:
//
//   REAL_REPO=owner/throwaway REAL_TEST=github-multi-real.mjs server/scripts/github-real.sh
//
// Everything it writes is under multi/<stamp>/ on main, one entry in .gitmodules and a
// branch lib-<stamp>; all three are removed at the end.  The submodule is the throwaway
// repository itself (its lib-<stamp> branch), so no second repository is needed.
//
//   REAL_GH_ID_2, REAL_LOGIN_2   a second GitHub account, for the second person
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
const STAMP = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const ROOT = `multi/${STAMP}`, HW = `${ROOT}/hardware`, LIB_BRANCH = `lib-${STAMP}`;
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
const ghHead = (branch = 'main') => gh('GET', `/repos/${REPO}/git/ref/heads/${branch}`).j?.object?.sha;
/** Every file of a branch under `prefix`: path -> blob sha (gitlinks as "commit:<sha>"). */
function ghTree(prefix = ROOT + '/', branch = 'main') {
  const head = ok(gh('GET', `/repos/${REPO}/git/commits/${ghHead(branch)}`), 'commit');
  const t = ok(gh('GET', `/repos/${REPO}/git/trees/${head.tree.sha}?recursive=1`), 'tree');
  return Object.fromEntries(t.tree.filter((e) => e.type !== 'tree' && e.path.startsWith(prefix)).map((e) => [e.path, e.type === 'commit' ? 'commit:' + e.sha : e.sha]));
}
const ghText = (p, branch = 'main') => {
  const sha = ghTree(p, branch)[p];
  return sha ? Buffer.from(ok(gh('GET', `/repos/${REPO}/git/blobs/${sha}`), 'blob').content, 'base64').toString() : null;
};
/**
 * One commit on `branch`.  `changes` maps a path to its new text, to null (delete), to
 * { sha } (an existing blob: a move) or to { gitlink } (a submodule at that commit).
 * `orphan` starts a branch with no history instead.
 */
function ghCommit(changes, message, { branch = 'main', orphan = false } = {}) {
  const head = orphan ? null : ghHead(branch);
  const tree = Object.entries(changes).map(([p, v]) => {
    if (v === null) return { path: p, mode: '100644', type: 'blob', sha: null };
    if (typeof v === 'object' && v.gitlink) return { path: p, mode: '160000', type: 'commit', sha: v.gitlink };
    if (typeof v === 'object') return { path: p, mode: '100644', type: 'blob', sha: v.sha };
    return { path: p, mode: '100644', type: 'blob', sha: ok(gh('POST', `/repos/${REPO}/git/blobs`, { content: Buffer.from(v).toString('base64'), encoding: 'base64' }), 'blob').sha };
  });
  const base = head ? ok(gh('GET', `/repos/${REPO}/git/commits/${head}`), 'commit').tree.sha : undefined;
  const t = ok(gh('POST', `/repos/${REPO}/git/trees`, { ...(base ? { base_tree: base } : {}), tree }), 'new tree');
  const c = ok(gh('POST', `/repos/${REPO}/git/commits`, { message, tree: t.sha, parents: head ? [head] : [] }), 'new commit');
  if (orphan) ok(gh('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${branch}`, sha: c.sha }), 'new branch');
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

// ---- fixtures: small but well-formed KiCad files, laid out like a keyboard repository
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${STAMP.replace(/\D/g, '').slice(-12).padStart(12, '0')}`;
const fpItem = (ref, n, x) => `\t(footprint "lcsc:${ref}"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uuid(n)}")\n\t\t(at ${x} 50)\n\t)\n`;
const board = (items) => `(kicad_pcb\n\t(version 20241229)\n\t(generator "pcbnew")\n\t(generator_version "9.0")\n\t(general\n\t\t(thickness 1.6)\n\t)\n\t(paper "A4")\n${items.join('')})\n`;
const sch = (n, extra = '') => `(kicad_sch\n\t(version 20250114)\n\t(generator "eeschema")\n\t(uuid "${uuid(n)}")\n\t(paper "A4")\n${extra})\n`;
const pro = (name) => `{\n  "meta": { "filename": "${name}.kicad_pro", "version": 3 }\n}\n`;
const tables = (lib) => ({
  'fp-lib-table': `(fp_lib_table\n  (version 7)\n  (lib (name "lcsc")(type "KiCad")(uri "\${KIPRJMOD}/../${lib}/lcsc.pretty")(options "")(descr ""))\n)\n`,
  'sym-lib-table': `(sym_lib_table\n  (version 7)\n  (lib (name "lcsc")(type "KiCad")(uri "\${KIPRJMOD}/../${lib}/lcsc.kicad_sym")(options "")(descr ""))\n)\n` });
const mod = (name) => `(footprint "${name}"\n\t(version 20241229)\n\t(generator "pcbnew")\n\t(layer "F.Cu")\n\t(attr smd)\n)\n`;
const SYM0 = `(kicad_symbol_lib\n\t(version 20241209)\n\t(generator "kicad_symbol_editor")\n\t(symbol "R_${STAMP}"\n\t\t(property "Reference" "R"\n\t\t\t(at 0 0 0)\n\t\t)\n\t)\n)\n`;
const addSym = (text, name) => text.replace('\t(symbol "R_', `\t(symbol "${name}"\n\t\t(property "Reference" "${name[0]}"\n\t\t\t(at 0 0 0)\n\t\t)\n\t)\n\t(symbol "R_`);
const project = (dir, name, n, lib = 'lib') => Object.fromEntries(Object.entries({
  [`${name}.kicad_pro`]: pro(name), [`${name}.kicad_pcb`]: board([fpItem('R', n, 100), fpItem('C', n + 1, 110)]), [`${name}.kicad_sch`]: sch(n + 2),
  [`${name}.kicad_dru`]: `(version 1)\n# rules of ${name} ${STAMP}\n`, ...tables(lib) }).map(([p, c]) => [`${dir}/${p}`, c]));
const libFiles = (prefix) => ({ [`${prefix}lcsc.kicad_sym`]: SYM0, [`${prefix}lcsc.pretty/R.kicad_mod`]: mod('R'), [`${prefix}lcsc.pretty/C.kicad_mod`]: mod('C') });
const SHARED = ['../lib/lcsc.kicad_sym', '../lib/lcsc.pretty/C.kicad_mod', '../lib/lcsc.pretty/R.kicad_mod'];
const own = (name) => [`${name}.kicad_dru`, `${name}.kicad_pcb`, `${name}.kicad_pro`, `${name}.kicad_sch`, 'fp-lib-table', 'sym-lib-table'];

const made = [];
let modulesBefore = null, mainBefore = null;
try {
  check('the first person connects their GitHub account', await connect(alice));
  if (GH_ID_2) check('a second person connects theirs', await connect(bob, LOGIN_2));
  if (process.env.GH_API) directToken = (await (await fetch(`${FAKE}/__ctl/tokens`)).json()).find((t) => t.login === LOGIN).token;

  // ============================================================ the repository, as someone set it up with git
  mainBefore = ghHead();
  modulesBefore = ghText('.gitmodules');
  const libTip = ghCommit(libFiles(''), `Parts library ${STAMP}`, { branch: LIB_BRANCH, orphan: true });
  ghCommit({
    ...project(`${HW}/keybit`, 'keybit', 10), ...project(`${HW}/keyword`, 'keyword', 20), ...libFiles(`${HW}/lib/`),
    [`${HW}/panels/p1/p1.kicad_pro`]: pro('p1'), [`${HW}/panels/p1/p1.kicad_pcb`]: board([fpItem('R', 30, 1)]),
    [`${HW}/panels/p1/src/keybit.kicad_pro`]: pro('keybit'), [`${HW}/panels/p1/src/keybit.kicad_pcb`]: board([fpItem('R', 31, 1)]),
    ...project(`${ROOT}/sub/keyhall`, 'keyhall', 40, 'parts'),
    [`${ROOT}/sub/parts`]: { gitlink: libTip },
    '.gitmodules': (modulesBefore || '') + `[submodule "${ROOT}/sub/parts"]\n\tpath = ${ROOT}/sub/parts\n\turl = https://github.com/${REPO}.git\n\tbranch = ${LIB_BRANCH}\n`,
  }, `Sync test ${STAMP}: two boards, a shared library, a panel, a submodule`);

  let r = await call(alice, 'GET', `/api/github/scan?repo=${REPO}`);
  const found = Object.fromEntries((r.j.projects || []).filter((p) => p.path.startsWith(ROOT + '/')).map((p) => [p.path.slice(ROOT.length + 1), p]));
  eq('scan finds each project of the repository, the nested one too', Object.keys(found).sort(),
    ['hardware/keybit', 'hardware/keyword', 'hardware/panels/p1', 'hardware/panels/p1/src', 'sub/keyhall']);
  eq('the two boards say they share the library beside them', [found['hardware/keybit']?.shared, found['hardware/keyword']?.shared].map((s) => (s || []).map((x) => [x.repoPath, x.found])),
    [[[`${HW}/lib/lcsc.kicad_sym`, true], [`${HW}/lib/lcsc.pretty`, true]], [[`${HW}/lib/lcsc.kicad_sym`, true], [`${HW}/lib/lcsc.pretty`, true]]]);
  eq('the nested project says what it is inside', found['hardware/panels/p1/src']?.inside, `${HW}/panels/p1`);
  check('the library that is a submodule is read through', (found['sub/keyhall']?.shared || []).length === 2 && found['sub/keyhall'].shared.every((s) => s.found), JSON.stringify(found['sub/keyhall']));

  // ============================================================ several projects online at once
  r = await call(alice, 'POST', '/api/github/import', { repo: REPO, paths: [`${HW}/keybit`, `${HW}/keyword`, `${ROOT}/sub/keyhall`, `${HW}/panels/p1`] });
  check('four folders become four online projects in one go', r.status === 200 && r.j.projects?.length === 4 && r.j.projects.every((p) => p.projectId && !p.error), JSON.stringify(r.j));
  const [keybit, keyword, keyhall, panel] = r.j.projects.map((p) => p.projectId);
  made.push(keybit, keyword, keyhall, panel);
  let docs = await docsOf(alice, keybit), kwDocs = await docsOf(alice, keyword);
  eq('each board has its own files and the shared library', [Object.keys(docs).sort(), Object.keys(kwDocs).sort()], [[...SHARED, ...own('keybit')].sort(), [...SHARED, ...own('keyword')].sort()]);
  eq('the panel leaves the project inside it alone', [Object.keys(await docsOf(alice, panel)).sort(), (await status(alice, panel)).nested], [['p1.kicad_pcb', 'p1.kicad_pro'], ['src']]);
  let st = await status(alice, keybit);
  eq('a fresh import is in sync', [st.summary.synced, notSynced(st), st.link.path], [9, {}, `${HW}/keybit`]);
  r = await call(alice, 'POST', '/api/github/import', { repo: REPO, paths: [`${HW}/keybit`] });
  check('bringing a folder online twice points at the project instead of copying it', r.j.projects?.[0]?.existing === true && r.j.projects[0].projectId === keybit, JSON.stringify(r.j));

  // ============================================================ the shared library travels between the two boards
  await db.query(`INSERT INTO permissions (project_id, user_id, role) VALUES ($1, $2, 'editor') ON CONFLICT DO NOTHING`, [keyword, bobId]);
  const SYM1 = addSym(SYM0, `C_${STAMP}`);
  await saveOnline(docs['../lib/lcsc.kicad_sym'], SYM1);
  r = await push(alice, keybit, { message: `Sync test ${STAMP}: add C to the shared symbols` });
  check('an edit to the shared library is pushed from one board', r.status === 200 && r.j.pushed?.length === 1, JSON.stringify(r.j));
  check('…to the library\'s real place in the repository', ghText(`${HW}/lib/lcsc.kicad_sym`) === SYM1);
  eq('the second person, in the other board, sees it to pull', notSynced(await status(bob, keyword)), { '../lib/lcsc.kicad_sym': 'pull' });
  r = await pull(bob, keyword);
  check('…and pulls it', r.status === 200 && await online(bob, kwDocs['../lib/lcsc.kicad_sym']) === SYM1, JSON.stringify(r.j));
  await saveOnline(kwDocs['keyword.kicad_pcb'], (await online(bob, kwDocs['keyword.kicad_pcb'])).replace('(at 100 50)', '(at 101 51)'));
  const keybitBefore = ghTree(`${HW}/keybit/`);
  r = await push(bob, keyword, { message: `Sync test ${STAMP}: move R` });
  check('the second person pushes their board', r.status === 200, JSON.stringify(r.j));
  eq('…which leaves the first board\'s folder untouched', ghTree(`${HW}/keybit/`), keybitBefore);
  eq('both boards are level', [notSynced(await status(alice, keybit)), notSynced(await status(bob, keyword))], [{}, {}]);

  // ============================================================ renamed and deleted on GitHub
  const schId = docs['keybit.kicad_sch'];
  ghCommit({ [`${HW}/keybit/keybit.kicad_sch`]: null, [`${HW}/keybit/main.kicad_sch`]: { sha: keybitBefore[`${HW}/keybit/keybit.kicad_sch`] }, [`${HW}/keybit/keybit.kicad_dru`]: null },
    `Sync test ${STAMP}: rename the schematic, drop the rules`);
  st = await status(alice, keybit);
  eq('a rename and a delete on GitHub are seen as exactly that', notSynced(st), { 'main.kicad_sch': 'pull:was-keybit.kicad_sch', 'keybit.kicad_dru': 'pull:deleted-github' });
  r = await pull(alice, keybit);
  docs = await docsOf(alice, keybit);
  check('pulling renames the document in place and removes the other', r.status === 200 && docs['main.kicad_sch'] === schId && !docs['keybit.kicad_sch'] && !docs['keybit.kicad_dru'], JSON.stringify(r.j));
  st = await status(alice, keybit);
  check('the removed file is kept to put back', st.removed?.[0]?.path === 'keybit.kicad_dru' && Object.keys(notSynced(st)).length === 0, JSON.stringify(st.removed));
  r = await call(alice, 'POST', `/api/projects/${keybit}/github/restore-file`, { id: st.removed[0].id });
  r = await push(alice, keybit, { message: `Sync test ${STAMP}: the rules are needed after all` });
  check('put back and pushed, it is on GitHub again', r.status === 200 && (ghText(`${HW}/keybit/keybit.kicad_dru`) || '').includes(STAMP), JSON.stringify(r.j));

  // ============================================================ renamed and deleted online
  await db.query('UPDATE documents SET path = $2 WHERE id = $1', [kwDocs['../lib/lcsc.pretty/C.kicad_mod'], '../lib/lcsc.pretty/C_0402.kicad_mod']);
  r = await call(bob, 'DELETE', `/api/docs/${kwDocs['../lib/lcsc.pretty/R.kicad_mod']}`);
  st = await status(bob, keyword);
  eq('a rename and a delete online are a rename and a delete to push', notSynced(st), { '../lib/lcsc.pretty/C_0402.kicad_mod': 'push:was-../lib/lcsc.pretty/C.kicad_mod', '../lib/lcsc.pretty/R.kicad_mod': 'push:deleted-online' });
  const headBefore = ghHead();
  r = await push(bob, keyword, { message: `Sync test ${STAMP}: rename C, drop R` });
  const after = ghTree(HW + '/');
  check('one ordinary commit renames and deletes on GitHub', r.status === 200 && `${HW}/lib/lcsc.pretty/C_0402.kicad_mod` in after && !(`${HW}/lib/lcsc.pretty/C.kicad_mod` in after) && !(`${HW}/lib/lcsc.pretty/R.kicad_mod` in after)
    && ok(gh('GET', `/repos/${REPO}/git/commits/${ghHead()}`), 'commit').parents[0].sha === headBefore, JSON.stringify(r.j));
  eq('the first board sees the library file renamed and the other one gone', notSynced(await status(alice, keybit)),
    { '../lib/lcsc.pretty/C_0402.kicad_mod': 'pull:was-../lib/lcsc.pretty/C.kicad_mod', '../lib/lcsc.pretty/R.kicad_mod': 'pull:deleted-github' });
  await pull(alice, keybit);
  eq('level again', [notSynced(await status(alice, keybit)), notSynced(await status(bob, keyword))], [{}, {}]);

  // ============================================================ the project folder renamed, then deleted, on GitHub
  ghCommit(moveDir(`${HW}/keyword`, `${HW}/keyword-v2`), `Sync test ${STAMP}: rename the keyword folder`);
  st = await status(bob, keyword);
  eq('a renamed project folder is followed, nothing duplicated', [st.moved, st.link?.path, notSynced(st), Object.keys(await docsOf(bob, keyword)).length],
    [{ from: `${HW}/keyword`, to: `${HW}/keyword-v2` }, `${HW}/keyword-v2`, {}, 8]);
  ghCommit(dropDir(`${HW}/keyword-v2`), `Sync test ${STAMP}: delete the keyword folder`);
  st = await status(bob, keyword);
  check('a deleted project folder is reported as missing', st.missing?.reason === 'folder', JSON.stringify(st.missing));
  r = await pull(bob, keyword);
  check('a pull then deletes nothing online', r.status === 409 && r.j.error === 'project_missing' && Object.keys(await docsOf(bob, keyword)).length === 8, JSON.stringify(r.j));
  r = await push(bob, keyword);
  check('a push does not quietly recreate it', r.status === 409 && r.j.error === 'project_missing' && Object.keys(ghTree(`${HW}/keyword-v2/`)).length === 0, JSON.stringify(r.j));
  r = await push(bob, keyword, { restore: true, message: `Sync test ${STAMP}: put keyword back` });
  check('choosing to put it back does', r.status === 200 && Object.keys(ghTree(`${HW}/keyword-v2/`)).length === 6, JSON.stringify(r.j));
  eq('…and it is level', notSynced(await status(bob, keyword)), {});

  // ============================================================ the library as a submodule
  const hallDocs = await docsOf(alice, keyhall);
  st = await status(alice, keyhall);
  eq('the board whose library is a submodule has that library too', [Object.keys(hallDocs).filter((p) => p.startsWith('../')).sort(), file(st, '../parts/lcsc.kicad_sym').submodule?.toLowerCase(), notSynced(st)],
    [['../parts/lcsc.kicad_sym', '../parts/lcsc.pretty/C.kicad_mod', '../parts/lcsc.pretty/R.kicad_mod'], REPO.toLowerCase(), {}]);
  await saveOnline(hallDocs['../parts/lcsc.kicad_sym'], addSym(SYM0, `H_${STAMP}`));
  await saveOnline(hallDocs['keyhall.kicad_sch'], sch(42, '\t(text "hall")\n'));
  r = await push(alice, keyhall, { message: `Sync test ${STAMP}: a hall sensor symbol` });
  const libNow = ghHead(LIB_BRANCH);
  check('a push commits the library file to the submodule\'s own branch', r.status === 200 && libNow !== libTip && (ghText('lcsc.kicad_sym', LIB_BRANCH) || '').includes(`H_${STAMP}`), JSON.stringify(r.j));
  eq('…and moves the main repository to that commit, with its own file in the same commit', [ghTree(`${ROOT}/sub/`)[`${ROOT}/sub/parts`], (ghText(`${ROOT}/sub/keyhall/keyhall.kicad_sch`) || '').includes('"hall"')], ['commit:' + libNow, true]);
  eq('level afterwards', notSynced(await status(alice, keyhall)), {});
  // someone moves the library on without updating the main repository
  ghCommit({ 'lcsc.pretty/D.kicad_mod': mod('D') }, `Parts library ${STAMP}: add D`, { branch: LIB_BRANCH });
  await saveOnline(hallDocs['../parts/lcsc.kicad_sym'], addSym(addSym(SYM0, `H_${STAMP}`), `Q_${STAMP}`));
  r = await push(alice, keyhall);
  const tip = ghHead(LIB_BRANCH);
  check('when the library has moved on, its file is held back with the reason, nothing forced', (r.j.blocked?.length === 1 || r.j.error === 'push_blocked') && ghHead(LIB_BRANCH) === tip
    && !(ghText('lcsc.kicad_sym', LIB_BRANCH) || '').includes(`Q_${STAMP}`), JSON.stringify(r.j));

  // ============================================================ nothing was forced
  const log = ok(gh('GET', `/repos/${REPO}/commits?sha=main&per_page=40`), 'log').map((c) => c.sha);
  check('main only ever moved forward', log.includes(mainBefore));
} catch (e) {
  check('run completed', false, e.stack || String(e));
} finally {
  // leave the repository as it was found: the test folder, the .gitmodules entry and the library branch go
  try {
    if (mainBefore) ghCommit({ ...dropDir(ROOT), '.gitmodules': modulesBefore }, `Sync test ${STAMP}: clean up`);
    gh('DELETE', `/repos/${REPO}/git/refs/heads/${LIB_BRANCH}`);
    check('the repository is tidied up', Object.keys(ghTree(ROOT + '/')).length === 0 && ghText('.gitmodules') === modulesBefore);
  } catch (e) { check('the repository is tidied up', false, String(e)); }
  for (const id of made) await call(alice, 'DELETE', `/api/projects/${id}`).catch(() => {});
  await db.query('DELETE FROM projects WHERE owner_id = ANY($1)', [[aliceId, bobId]]).catch(() => {});
  await db.query('DELETE FROM users WHERE id = ANY($1)', [[aliceId, bobId]]).catch(() => {});
  await db.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
