// End-to-end test of GitHub sync for repositories that hold more than one project:
// several projects in separate folders sharing a library outside them, projects
// nested in projects, the library (or a project) as a git submodule, and files and
// folders that are renamed, moved or deleted on either side.
//
// The repository is laid out like a real one (two boards and panels that share
// hardware/lib through ${KIPRJMOD}/../lib).  Runs against fake-github.mjs; start the
// fake and a LOCAL server on a THROWAWAY database exactly as github-e2e.mjs says, then:
//
//   E2E_PG_URL=postgres://postgres@127.0.0.1:55432/collabtest E2E_JWT_SECRET=testsecret \
//     node github-multi-e2e.mjs
//
import crypto from 'node:crypto';
import pg from 'pg';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const GH = (process.env.E2E_FAKE_GH || 'http://127.0.0.1:8098').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET;
const PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required (see the header comment).'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const canon = (v) => Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const eq = (name, got, want) => check(name, JSON.stringify(canon(got)) === JSON.stringify(canon(want)), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}

pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();

// ---------------------------------------------------------------- helpers
const ctl = async (what, body) => (await fetch(`${GH}/__ctl/${what}`, body
  ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
const ghFiles = (repo, branch) => ctl(`files?repo=${encodeURIComponent(repo)}${branch ? '&branch=' + encodeURIComponent(branch) : ''}`);
const commit = (fullName, files, message) => ctl('commit', { fullName, files, message });

async function call(token, method, path, body) {
  const r = await fetch(BASE + path, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
const status = async (token, id) => (await call(token, 'GET', `/api/projects/${id}/github`)).j;
const states = (st) => Object.fromEntries((st.files || []).map((f) => [f.path, f.state]));
const file = (st, path) => (st.files || []).find((f) => f.path === path) || {};
const notSynced = (st) => Object.fromEntries((st.files || []).filter((f) => f.state !== 'synced').map((f) => [f.path, f.state + (f.deleted ? ':deleted-' + f.deleted : '') + (f.renamedFrom ? ':was-' + f.renamedFrom : '')]));
const push = (token, id, body = {}) => call(token, 'POST', `/api/projects/${id}/github/push`, body);
const pull = (token, id, body = {}) => call(token, 'POST', `/api/projects/${id}/github/pull`, body);

async function connect(jwt) {
  let url = `${BASE}/auth/github/connect?next=/github`;
  let last = null;
  for (let hop = 0; hop < 6; hop++) {
    last = await fetch(url, { redirect: 'manual', headers: url.startsWith(BASE) ? { Cookie: `kc_session=${jwt}` } : {} });
    if (last.status < 300 || last.status >= 400) break;
    url = new URL(last.headers.get('location'), url).toString();
  }
  return last.status;
}
async function localFile(token, docId) {
  const r = await fetch(`${BASE}/api/docs/${docId}/content`, { headers: { Authorization: `Bearer ${token}` } });
  return r.text();
}
/** Play an editor saving a new version of a document: a snapshot at the next seq. */
async function saveOnline(docId, content) {
  const { rows } = await db.query(
    `SELECT GREATEST(COALESCE((SELECT MAX(seq) FROM ops WHERE doc_id = $1), 0),
                     COALESCE((SELECT MAX(seq) FROM snapshots WHERE doc_id = $1), 0)) AS head`, [docId]);
  await db.query('INSERT INTO snapshots (doc_id, seq, content) VALUES ($1, $2, $3)', [docId, rows[0].head + 1, Buffer.from(content)]);
}
const docsOf = async (token, id) => Object.fromEntries((await call(token, 'GET', `/api/projects/${id}`)).j.docs.map((d) => [d.path, d.docId]));

// ---------------------------------------------------------------- fixtures
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fpItem = (ref, n, x, model) => `\t(footprint "lcsc:${ref}"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uuid(n)}")\n\t\t(at ${x} 50)\n${model ? `\t\t(model "${model}"\n\t\t\t(offset (xyz 0 0 0))\n\t\t)\n` : ''}\t)\n`;
const board = (items) => `(kicad_pcb\n\t(version 20241229)\n\t(generator "pcbnew")\n\t(generator_version "9.0")\n\t(general\n\t\t(thickness 1.6)\n\t)\n\t(paper "A4")\n${items.join('')})\n`;
const sch = (n, extra = '') => `(kicad_sch\n\t(version 20250114)\n\t(generator "eeschema")\n\t(uuid "${uuid(n)}")\n\t(paper "A4")\n${extra})\n`;
const sheet = (n, fileName) => `\t(sheet\n\t\t(at 10 10)\n\t\t(size 20 10)\n\t\t(uuid "${uuid(n)}")\n\t\t(property "Sheetname" "s${n}"\n\t\t\t(at 0 0 0)\n\t\t)\n\t\t(property "Sheetfile" "${fileName}"\n\t\t\t(at 0 0 0)\n\t\t)\n\t)\n`;
const pro = (name) => `{\n  "meta": { "filename": "${name}.kicad_pro", "version": 3 }\n}\n`;
const FP_TABLE = '(fp_lib_table\n  (version 7)\n  (lib (name "lcsc")(type "KiCad")(uri "${KIPRJMOD}/../lib/lcsc.pretty")(options "")(descr ""))\n)\n';
const SYM_TABLE = '(sym_lib_table\n  (version 7)\n  (lib (name "lcsc")(type "KiCad")(uri "${KIPRJMOD}/../lib/lcsc.kicad_sym")(options "")(descr ""))\n)\n';
const mod = (name) => `(footprint "${name}"\n\t(version 20241229)\n\t(generator "pcbnew")\n\t(layer "F.Cu")\n\t(attr smd)\n)\n`;
const SYM0 = '(kicad_symbol_lib\n\t(version 20241209)\n\t(generator "kicad_symbol_editor")\n\t(symbol "R"\n\t\t(property "Reference" "R"\n\t\t\t(at 0 0 0)\n\t\t)\n\t)\n)\n';
const SYM1 = SYM0.replace('(symbol "R"', '(symbol "C"\n\t\t(property "Reference" "C"\n\t\t\t(at 0 0 0)\n\t\t)\n\t)\n\t(symbol "R"');
const MODEL = '${KIPRJMOD}/../lib/lcsc.3dshapes/SW.wrl';
const KEYBIT_PCB = board([fpItem('SW', 1, 100, MODEL), fpItem('R', 2, 110)]);
const KEYWORD_PCB = board([fpItem('R', 3, 100), fpItem('C', 4, 110)]);

/** The shared library, as files under `prefix` ('' when it is a repository of its own). */
const lib = (prefix) => ({
  [`${prefix}lcsc.kicad_sym`]: SYM0,
  [`${prefix}lcsc.pretty/R.kicad_mod`]: mod('R'),
  [`${prefix}lcsc.pretty/C.kicad_mod`]: mod('C'),
  [`${prefix}lcsc.pretty/SW.kicad_mod`]: mod('SW'),
  [`${prefix}lcsc.3dshapes/SW.wrl`]: '#VRML V2.0 utf8\n# switch\n',
  [`${prefix}lcsc.3dshapes/unused.wrl`]: '#VRML V2.0 utf8\n# nobody uses this\n',
  [`${prefix}lcsc.bak`]: 'backup, not a KiCad file',
});
/** One board project in `dir`. */
const project = (dir, name, pcb, n) => ({
  [`${dir}/${name}.kicad_pro`]: pro(name), [`${dir}/${name}.kicad_pcb`]: pcb, [`${dir}/${name}.kicad_sch`]: sch(n),
  [`${dir}/fp-lib-table`]: FP_TABLE, [`${dir}/sym-lib-table`]: SYM_TABLE,
});
const SHARED = ['../lib/lcsc.kicad_sym', '../lib/lcsc.pretty/C.kicad_mod', '../lib/lcsc.pretty/R.kicad_mod', '../lib/lcsc.pretty/SW.kicad_mod'];
const own = (name) => [`${name}.kicad_pcb`, `${name}.kicad_pro`, `${name}.kicad_sch`, 'fp-lib-table', 'sym-lib-table'];

// ---------------------------------------------------------------- users
await ctl('reset', {});
const GH_ALICE = 9201, GH_BOB = 9202;
const mkUser = async (ghId, login) => (await db.query(
  `INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2)
   ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [ghId, login])).rows[0].id;
const aliceId = await mkUser(GH_ALICE, 'gh-alice'), bobId = await mkUser(GH_BOB, 'gh-bob');
await db.query('DELETE FROM github_tokens WHERE user_id = ANY($1)', [[aliceId, bobId]]);
const alice = mintJwt(aliceId, 'gh-alice'), bob = mintJwt(bobId, 'gh-bob');
await ctl('user', { login: 'gh-alice', id: GH_ALICE });
await ctl('user', { login: 'gh-bob', id: GH_BOB });
await ctl('browser', { login: 'gh-alice' }); await connect(alice);
await ctl('browser', { login: 'gh-bob' }); await connect(bob);

try {
  let r, st, gh, docs;

  // ============================================================ two projects, one shared library (plain folders)
  await ctl('repo', { fullName: 'gh-alice/keys', isPrivate: true, collaborators: ['gh-bob'], files: {
    'README.md': '# keys\n', 'firmware/main.c': 'int main(){}',
    ...project('hardware/keybit', 'keybit', KEYBIT_PCB, 11),
    ...project('hardware/keyword', 'keyword', KEYWORD_PCB, 12),
    ...lib('hardware/lib/'),
    // three project files in one folder
    'hardware/spacer/spacer-1u.kicad_pro': pro('spacer-1u'), 'hardware/spacer/spacer-1u.kicad_pcb': board([]),
    'hardware/spacer/spacer-0.5u.kicad_pro': pro('spacer-0.5u'), 'hardware/spacer/spacer-0.5u.kicad_pcb': board([fpItem('R', 5, 1)]),
    // a panel that keeps copies of the boards it is made of in src/: projects inside a project
    'hardware/panels/p1/p1.kicad_pro': pro('p1'), 'hardware/panels/p1/p1.kicad_pcb': board([fpItem('R', 6, 1)]),
    'hardware/panels/p1/p1.kicad_sch': sch(13, sheet(14, 'src/psu.kicad_sch')),
    'hardware/panels/p1/src/keybit.kicad_pro': pro('keybit'), 'hardware/panels/p1/src/keybit.kicad_pcb': KEYBIT_PCB,
    'hardware/panels/p1/src/psu.kicad_sch': sch(15),
    'hardware/panels/p1/src/fp-lib-table': FP_TABLE,
    'hardware/panels/p1/src/keyword/keyword.kicad_pro': pro('keyword'), 'hardware/panels/p1/src/keyword/keyword.kicad_pcb': KEYWORD_PCB,
  } });

  r = await call(alice, 'GET', '/api/github/scan?repo=gh-alice/keys');
  const found = Object.fromEntries(r.j.projects.map((p) => [p.path, p]));
  eq('scan finds every project folder, nested ones too', Object.keys(found).sort(),
    ['hardware/keybit', 'hardware/keyword', 'hardware/panels/p1', 'hardware/panels/p1/src', 'hardware/panels/p1/src/keyword', 'hardware/spacer']);
  eq('a project counts only its own files, not those of projects inside it',
    [found['hardware/keybit'].files, found['hardware/panels/p1'].files, found['hardware/panels/p1/src'].files, found['hardware/panels/p1/src/keyword'].files], [5, 3, 4, 2]);
  eq('a nested project says which project it is inside', [found['hardware/panels/p1/src'].inside, found['hardware/panels/p1/src/keyword'].inside, found['hardware/keybit'].inside],
    ['hardware/panels/p1', 'hardware/panels/p1/src', undefined]);
  eq('several project files in one folder are one entry that lists them', found['hardware/spacer'].projectFiles, ['spacer-0.5u', 'spacer-1u']);
  eq('a project says which libraries it shares from outside its folder', found['hardware/keybit'].shared, [
    { path: '../lib/lcsc.kicad_sym', repoPath: 'hardware/lib/lcsc.kicad_sym', found: true },
    { path: '../lib/lcsc.pretty', repoPath: 'hardware/lib/lcsc.pretty', found: true }]);
  check('a library table that points at a folder that is not there says so', found['hardware/panels/p1/src'].shared.every((s) => s.found === false) && found['hardware/panels/p1/src'].shared.length === 1, JSON.stringify(found['hardware/panels/p1/src'].shared));

  // ---- bring two online at once
  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/keys', paths: ['hardware/keybit', 'hardware/keyword'] });
  check('two folders become two online projects in one go', r.status === 200 && r.j.projects.length === 2 && r.j.projects.every((p) => p.projectId && !p.error), JSON.stringify(r.j));
  const keybit = r.j.projects[0].projectId, keyword = r.j.projects[1].projectId;
  eq('each is named after its project file', r.j.projects.map((p) => p.name), ['keybit', 'keyword']);
  docs = await docsOf(alice, keybit);
  eq('a project brings its own files and the shared library it names — footprints, symbols and the one 3D model its board uses',
    Object.keys(docs).sort(), [...SHARED, '../lib/lcsc.3dshapes/SW.wrl', ...own('keybit')].sort());
  let kwDocs = await docsOf(alice, keyword);
  eq('the other project has the same library, without the model only the first one uses', Object.keys(kwDocs).sort(), [...SHARED, ...own('keyword')].sort());
  check('shared files arrive byte for byte', await localFile(alice, docs['../lib/lcsc.kicad_sym']) === SYM0);
  st = await status(alice, keybit);
  eq('a fresh import is in sync, shared files included', st.summary, { push: 0, pull: 0, conflict: 0, synced: 10, unsaved: 0 });
  check('shared files are marked as such', file(st, '../lib/lcsc.kicad_sym').shared === true && !file(st, 'keybit.kicad_pcb').shared);
  check('each project is linked to its own folder', st.link.path === 'hardware/keybit' && (await status(alice, keyword)).link.path === 'hardware/keyword');

  // ---- no second copy of a folder that is online already
  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/keys', path: 'hardware/keybit' });
  check('importing a folder that is already online is refused, naming the project', r.status === 409 && r.j.error === 'already_online' && /keybit/.test(r.j.message), JSON.stringify(r.j));
  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/keys', paths: ['hardware/keybit', 'hardware/spacer'] });
  check('…and in a group it is pointed at instead of duplicated', r.j.projects[0].existing === true && r.j.projects[0].projectId === keybit && !r.j.projects[1].existing, JSON.stringify(r.j));
  const spacer = r.j.projects[1].projectId;
  eq('a folder with several project files is one online project holding all of them', Object.keys(await docsOf(alice, spacer)).sort(),
    ['spacer-0.5u.kicad_pcb', 'spacer-0.5u.kicad_pro', 'spacer-1u.kicad_pcb', 'spacer-1u.kicad_pro']);
  r = await call(alice, 'GET', '/api/github/scan?repo=gh-alice/keys');
  eq('scan shows which folders are online', r.j.projects.filter((p) => p.online).map((p) => [p.path, p.online.projectId]).sort(),
    [['hardware/keybit', keybit], ['hardware/keyword', keyword], ['hardware/spacer', spacer]].sort());
  check('someone who cannot open those projects is not told about them', !(await call(bob, 'GET', '/api/github/scan?repo=gh-alice/keys')).j.projects.some((p) => p.online));

  // ---- nested projects stay apart; a sheet the outer project uses from the inner folder comes along
  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/keys', path: 'hardware/panels/p1' });
  const panel = r.j.projectId;
  eq('the outer project leaves the projects inside it alone, except the sheet it uses from there', Object.keys(await docsOf(alice, panel)).sort(),
    ['p1.kicad_pcb', 'p1.kicad_pro', 'p1.kicad_sch', 'src/psu.kicad_sch']);
  st = await status(alice, panel);
  eq('…and says which folders are projects of their own', st.nested, ['src']);
  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/keys', path: 'hardware/panels/p1/src' });
  const inner = r.j.projectId;
  eq('the inner project has its files, not those of the project inside it in turn', Object.keys(await docsOf(alice, inner)).sort(), ['fp-lib-table', 'keybit.kicad_pcb', 'keybit.kicad_pro', 'psu.kicad_sch']);
  check('a library its table names that is not in the repository is reported, not fatal', r.status === 200 && r.j.notes.some((n) => n.kind === 'missing_ref' && /lcsc\.pretty/.test(n.path)), JSON.stringify(r.j.notes));

  // ============================================================ the shared library, edited from one project, reaches the other
  await saveOnline(docs['../lib/lcsc.kicad_sym'], SYM1);
  eq('an edit to a shared file shows as "push" in the project that made it', notSynced(await status(alice, keybit)), { '../lib/lcsc.kicad_sym': 'push' });
  const before = await ghFiles('gh-alice/keys');
  r = await push(alice, keybit, { message: 'Add C to the shared symbols' });
  check('it is pushed', r.status === 200 && r.j.pushed.length === 1, JSON.stringify(r.j));
  gh = await ghFiles('gh-alice/keys');
  check('…to the library\'s real place in the repository', gh.files['hardware/lib/lcsc.kicad_sym'] === SYM1 && !Object.keys(gh.files).some((p) => p.includes('..')));
  check('…and nothing else in the repository moved', Object.keys(gh.files).length === Object.keys(before.files).length
    && Object.keys(gh.files).every((p) => p === 'hardware/lib/lcsc.kicad_sym' || gh.files[p] === before.files[p]));
  eq('the other project sees the shared file changed on GitHub', notSynced(await status(alice, keyword)), { '../lib/lcsc.kicad_sym': 'pull' });
  r = await pull(alice, keyword);
  check('…and pulls it', r.status === 200 && await localFile(alice, kwDocs['../lib/lcsc.kicad_sym']) === SYM1, JSON.stringify(r.j));
  eq('both projects are level again', [(await status(alice, keybit)).summary.synced, (await status(alice, keyword)).summary.synced], [10, 9]);

  // ---- a push from one project never touches the other's folder
  await saveOnline(kwDocs['keyword.kicad_pcb'], KEYWORD_PCB.replace('(at 100 50)', '(at 101 51)'));
  r = await push(bob, keyword).catch(() => null);
  await db.query(`INSERT INTO permissions (project_id, user_id, role) VALUES ($1, $2, 'editor') ON CONFLICT DO NOTHING`, [keyword, bobId]);
  r = await push(bob, keyword, { message: 'Move R' });
  check('a second person pushes the other project with their own account', r.status === 200, JSON.stringify(r.j));
  gh = await ghFiles('gh-alice/keys');
  check('only that project\'s folder changed', gh.files['hardware/keybit/keybit.kicad_pcb'] === KEYBIT_PCB && gh.files['hardware/keyword/keyword.kicad_pcb'].includes('(at 101 51)'));
  eq('…and the first project has nothing to pull from it', (await status(alice, keybit)).summary.pull, 0);

  // ============================================================ deletes
  // ---- deleted on GitHub
  await commit('gh-alice/keys', { 'hardware/lib/lcsc.pretty/C.kicad_mod': null }, 'Drop C');
  st = await status(alice, keybit);
  eq('a file deleted on GitHub is a delete to pull, not something to push back', notSynced(st), { '../lib/lcsc.pretty/C.kicad_mod': 'pull:deleted-github' });
  r = await push(alice, keybit);
  check('pushing does not put it back', r.status === 409 && r.j.error === 'nothing_to_push' && !(await ghFiles('gh-alice/keys')).files['hardware/lib/lcsc.pretty/C.kicad_mod'], JSON.stringify(r.j));
  r = await pull(alice, keybit);
  check('pulling removes it online', r.status === 200 && r.j.updated[0].action === 'removed' && !(await docsOf(alice, keybit))['../lib/lcsc.pretty/C.kicad_mod'], JSON.stringify(r.j));
  st = await status(alice, keybit);
  check('…and keeps its content to put back', st.removed && st.removed[0].path === '../lib/lcsc.pretty/C.kicad_mod' && st.summary.synced === 9 && st.summary.pull === 0, JSON.stringify(st.removed));
  r = await call(alice, 'POST', `/api/projects/${keybit}/github/restore-file`, { id: st.removed[0].id });
  docs = await docsOf(alice, keybit);
  check('putting it back restores the file', r.status === 200 && await localFile(alice, docs['../lib/lcsc.pretty/C.kicad_mod']) === mod('C'), JSON.stringify(r.j));
  st = await status(alice, keybit);
  eq('…as a file that is new online', notSynced(st), { '../lib/lcsc.pretty/C.kicad_mod': 'push' });
  check('…and the kept copy is gone from the list', !st.removed);
  r = await push(alice, keybit, { message: 'C is needed after all' });
  check('pushing then returns it to GitHub', r.status === 200 && (await ghFiles('gh-alice/keys')).files['hardware/lib/lcsc.pretty/C.kicad_mod'] === mod('C'));
  eq('the other project, which still had the file, is simply in sync again', notSynced(await status(alice, keyword)), {});

  // ---- deleted on GitHub, changed online: asks
  await saveOnline(docs['../lib/lcsc.pretty/R.kicad_mod'], mod('R').replace('smd', 'through_hole'));
  await commit('gh-alice/keys', { 'hardware/lib/lcsc.pretty/R.kicad_mod': null }, 'Drop R');
  eq('deleted on GitHub but changed online is a conflict', notSynced(await status(alice, keybit)), { '../lib/lcsc.pretty/R.kicad_mod': 'conflict:deleted-github' });
  r = await pull(alice, keybit);
  check('a pull leaves it alone until told', r.j.updated.length === 0 && /choose/.test(r.j.skipped[0].reason) && !!(await docsOf(alice, keybit))['../lib/lcsc.pretty/R.kicad_mod'], JSON.stringify(r.j));
  r = await pull(alice, keybit, { resolve: { '../lib/lcsc.pretty/R.kicad_mod': 'online' } });
  eq('keeping it makes it a file to push', notSynced(await status(alice, keybit)), { '../lib/lcsc.pretty/R.kicad_mod': 'push' });
  r = await push(alice, keybit);
  check('…which puts the edited file on GitHub', (await ghFiles('gh-alice/keys')).files['hardware/lib/lcsc.pretty/R.kicad_mod'].includes('through_hole'));
  await pull(alice, keyword);

  // ---- deleted online
  kwDocs = await docsOf(alice, keyword);
  r = await call(alice, 'DELETE', `/api/docs/${kwDocs['../lib/lcsc.pretty/SW.kicad_mod']}`);
  check('a library file can be deleted online', r.status === 200, JSON.stringify(r.j));
  eq('a file deleted online is a delete to push, not something to pull back', notSynced(await status(alice, keyword)), { '../lib/lcsc.pretty/SW.kicad_mod': 'push:deleted-online' });
  r = await pull(alice, keyword);
  check('pulling does not bring it back', !(await docsOf(alice, keyword))['../lib/lcsc.pretty/SW.kicad_mod']);
  r = await push(alice, keyword, { message: 'Remove SW' });
  gh = await ghFiles('gh-alice/keys');
  check('pushing deletes it on GitHub, in a normal commit', r.status === 200 && r.j.deleted.length === 1 && !('hardware/lib/lcsc.pretty/SW.kicad_mod' in gh.files) && gh.message === 'Remove SW', JSON.stringify(r.j));
  eq('the other project sees the delete', notSynced(await status(alice, keybit)), { '../lib/lcsc.pretty/SW.kicad_mod': 'pull:deleted-github' });
  await pull(alice, keybit);

  // ---- deleted online, changed on GitHub: asks
  r = await call(alice, 'DELETE', `/api/docs/${kwDocs['../lib/lcsc.pretty/C.kicad_mod']}`);
  await commit('gh-alice/keys', { 'hardware/lib/lcsc.pretty/C.kicad_mod': mod('C').replace('smd', 'through_hole') }, 'C is through hole');
  eq('deleted online but changed on GitHub is a conflict', notSynced(await status(alice, keyword)), { '../lib/lcsc.pretty/C.kicad_mod': 'conflict:deleted-online' });
  r = await push(alice, keyword);
  check('a push does not delete what someone just changed', r.status === 409 && !!(await ghFiles('gh-alice/keys')).files['hardware/lib/lcsc.pretty/C.kicad_mod']);
  r = await pull(alice, keyword, { resolve: { '../lib/lcsc.pretty/C.kicad_mod': 'github' } });
  kwDocs = await docsOf(alice, keyword);
  check('taking GitHub\'s brings the file back', r.j.updated[0].action === 'added' && (await localFile(alice, kwDocs['../lib/lcsc.pretty/C.kicad_mod'])).includes('through_hole'), JSON.stringify(r.j));
  await pull(alice, keybit);
  eq('everything level', [notSynced(await status(alice, keybit)), notSynced(await status(alice, keyword))], [{}, {}]);

  // ============================================================ renames
  // ---- renamed on GitHub, content untouched
  const schId = kwDocs['keyword.kicad_sch'];
  await commit('gh-alice/keys', { 'hardware/keyword/keyword.kicad_sch': null, 'hardware/keyword/main.kicad_sch': sch(12) }, 'Rename the schematic');
  st = await status(alice, keyword);
  eq('a file renamed on GitHub is one renamed file, not a delete and a new file', notSynced(st), { 'main.kicad_sch': 'pull:was-keyword.kicad_sch' });
  check('…still the same online document', file(st, 'main.kicad_sch').docId === schId && file(st, 'main.kicad_sch').renamedOn === 'github');
  r = await pull(alice, keyword);
  kwDocs = await docsOf(alice, keyword);
  check('pulling renames the document in place: same id, so its history and comments stay', r.j.updated[0].action === 'renamed' && kwDocs['main.kicad_sch'] === schId && !kwDocs['keyword.kicad_sch'], JSON.stringify(r.j));
  eq('…and the project is in sync, with no duplicate', [notSynced(await status(alice, keyword)), Object.keys(kwDocs).length], [{}, 8]);

  // ---- renamed and edited on GitHub
  const pcbId = kwDocs['keyword.kicad_pcb'];
  const pcbNow = (await ghFiles('gh-alice/keys')).files['hardware/keyword/keyword.kicad_pcb'];
  await commit('gh-alice/keys', { 'hardware/keyword/keyword.kicad_pcb': null, 'hardware/keyword/main.kicad_pcb': pcbNow.replace('(at 110 50)', '(at 120 60)') }, 'Rename and move C');
  st = await status(alice, keyword);
  eq('a file renamed and edited on GitHub is still recognised as the same file', notSynced(st), { 'main.kicad_pcb': 'pull:was-keyword.kicad_pcb' });
  r = await pull(alice, keyword);
  kwDocs = await docsOf(alice, keyword);
  check('pulling renames it and takes the edit, same document', kwDocs['main.kicad_pcb'] === pcbId && (await localFile(alice, pcbId)).includes('(at 120 60)'), JSON.stringify(r.j));

  // ---- the project file renamed: the online project follows
  await commit('gh-alice/keys', { 'hardware/keyword/keyword.kicad_pro': null, 'hardware/keyword/main.kicad_pro': pro('keyword') }, 'Rename the project');
  r = await pull(alice, keyword);
  check('a renamed project file renames the online project with it', r.j.updated[0].project === 'main' && (await status(alice, keyword)).project.name === 'main', JSON.stringify(r.j));
  r = await call(alice, 'GET', '/api/github/scan?repo=gh-alice/keys');
  check('…and it is still the one online project of that folder', r.j.projects.find((p) => p.path === 'hardware/keyword').online.projectId === keyword);
  eq('in sync', notSynced(await status(alice, keyword)), {});

  // ---- renamed on GitHub while edited online
  await saveOnline(kwDocs['main.kicad_sch'], sch(12, '\t(text "online note")\n'));
  await commit('gh-alice/keys', { 'hardware/keyword/main.kicad_sch': null, 'hardware/keyword/top.kicad_sch': sch(12) }, 'Rename again');
  st = await status(alice, keyword);
  eq('renamed on GitHub and edited online: the rename comes over, the edit stays', notSynced(st), { 'top.kicad_sch': 'pull:was-main.kicad_sch' });
  r = await pull(alice, keyword);
  check('…the online edit survives the rename', (await localFile(alice, schId)).includes('online note'));
  eq('…and is then a plain change to push', notSynced(await status(alice, keyword)), { 'top.kicad_sch': 'push' });
  r = await push(alice, keyword);
  gh = await ghFiles('gh-alice/keys');
  check('…which lands under the new name only', gh.files['hardware/keyword/top.kicad_sch'].includes('online note') && !('hardware/keyword/main.kicad_sch' in gh.files));

  // ---- renamed online (a library file moved in the web editor)
  docs = await docsOf(alice, keybit);
  const cId = docs['../lib/lcsc.pretty/C.kicad_mod'];
  await db.query('UPDATE documents SET path = $2 WHERE id = $1', [cId, '../lib/lcsc.pretty/C_0402.kicad_mod']);
  st = await status(alice, keybit);
  eq('a file renamed online is one renamed file to push', notSynced(st), { '../lib/lcsc.pretty/C_0402.kicad_mod': 'push:was-../lib/lcsc.pretty/C.kicad_mod' });
  r = await push(alice, keybit, { message: 'Rename C' });
  gh = await ghFiles('gh-alice/keys');
  check('pushing renames it on GitHub in one commit', r.status === 200 && 'hardware/lib/lcsc.pretty/C_0402.kicad_mod' in gh.files && !('hardware/lib/lcsc.pretty/C.kicad_mod' in gh.files) && gh.message === 'Rename C', JSON.stringify(r.j));
  eq('…and is not reported as a deletion', r.j.deleted, []);
  eq('the other project sees a rename too, and pulls it as one', notSynced(await status(alice, keyword)), { '../lib/lcsc.pretty/C_0402.kicad_mod': 'pull:was-../lib/lcsc.pretty/C.kicad_mod' });
  await pull(alice, keyword);
  eq('everything level again', [notSynced(await status(alice, keybit)), notSynced(await status(alice, keyword))], [{}, {}]);

  // ============================================================ folders moved and deleted
  // ---- the project folder renamed on GitHub: the link follows
  const kb = await ghFiles('gh-alice/keys');
  const moveDir = (files, from, to) => Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith(from + '/')).flatMap(([p, c]) => [[p, null], [to + p.slice(from.length), c]]));
  await commit('gh-alice/keys', moveDir(kb.files, 'hardware/keybit', 'hardware/keybit-v2'), 'Rename the keybit folder');
  st = await status(alice, keybit);
  eq('a renamed project folder is found and the link follows it', [st.moved, st.link.path], [{ from: 'hardware/keybit', to: 'hardware/keybit-v2' }, 'hardware/keybit-v2']);
  eq('…with every file still in sync and no duplicate project', [notSynced(st), st.summary.synced, Object.keys(await docsOf(alice, keybit)).length], [{}, 9, 9]);
  docs = await docsOf(alice, keybit);
  await saveOnline(docs['keybit.kicad_sch'], sch(11, '\t(text "after the move")\n'));
  r = await push(alice, keybit);
  gh = await ghFiles('gh-alice/keys');
  check('the next push goes to the new folder and does not recreate the old one', gh.files['hardware/keybit-v2/keybit.kicad_sch'].includes('after the move') && !Object.keys(gh.files).some((p) => p.startsWith('hardware/keybit/')));

  // ---- moved somewhere its library path no longer reaches
  await commit('gh-alice/keys', moveDir(gh.files, 'hardware/keybit-v2', 'boards/keybit'), 'Move keybit out of hardware');
  st = await status(alice, keybit);
  check('a folder moved elsewhere is followed too', st.link.path === 'boards/keybit' && st.moved.to === 'boards/keybit');
  check('…and the library it can no longer reach from there is called out', st.notes.some((n) => n.kind === 'missing_ref'), JSON.stringify(st.notes));
  await commit('gh-alice/keys', moveDir((await ghFiles('gh-alice/keys')).files, 'boards/keybit', 'hardware/keybit'), 'Move it back');
  st = await status(alice, keybit);
  eq('moved back: linked and level again', [st.link.path, notSynced(st)], ['hardware/keybit', {}]);

  // ---- the project folder deleted on GitHub: nothing is wiped, syncing pauses
  await call(alice, 'POST', `/api/projects/${spacer}/github/settings`, { autoPush: true });
  await commit('gh-alice/keys', { 'hardware/spacer': null }, 'Remove the spacers');
  st = await status(alice, spacer);
  check('a deleted project folder is reported as missing', st.missing && st.missing.reason === 'folder' && st.files.length === 0, JSON.stringify(st.missing));
  r = await pull(alice, spacer);
  check('a pull deletes nothing online', r.status === 409 && r.j.error === 'project_missing' && Object.keys(await docsOf(alice, spacer)).length === 4, JSON.stringify(r.j));
  r = await push(alice, spacer);
  check('a push does not quietly recreate the folder', r.status === 409 && r.j.error === 'project_missing' && !Object.keys((await ghFiles('gh-alice/keys')).files).some((p) => p.startsWith('hardware/spacer/')));
  r = await call(alice, 'POST', `/api/projects/${spacer}/checkpoints`, { name: 'after delete' });
  for (let i = 0; i < 40; i++) { await new Promise((ok) => setTimeout(ok, 150)); st = await status(alice, spacer); if (st.link.lastAuto && st.link.lastAuto.checkpoint === 'after delete') break; }
  check('nor does push-on-checkpoint; it says why', st.link.lastAuto && st.link.lastAuto.ok === false && /no longer/.test(st.link.lastAuto.message)
    && !Object.keys((await ghFiles('gh-alice/keys')).files).some((p) => p.startsWith('hardware/spacer/')), JSON.stringify(st.link.lastAuto));
  r = await push(alice, spacer, { restore: true, message: 'Put the spacers back' });
  gh = await ghFiles('gh-alice/keys');
  check('choosing to restore puts the project back on GitHub', r.status === 200 && r.j.pushed.length === 4 && gh.files['hardware/spacer/spacer-1u.kicad_pro'] === pro('spacer-1u'), JSON.stringify(r.j));
  eq('…and it is in sync again', notSynced(await status(alice, spacer)), {});

  // ---- only the project file deleted (the folder still has other files): also paused, never a silent wipe
  await commit('gh-alice/keys', { 'hardware/spacer/spacer-1u.kicad_pro': null, 'hardware/spacer/spacer-0.5u.kicad_pro': null }, 'Remove the project files');
  st = await status(alice, spacer);
  check('a folder whose project files are gone is missing too', st.missing && st.missing.reason === 'project', JSON.stringify(st.missing));
  await push(alice, spacer, { restore: true });

  // ---- moved, but two folders look like it: the person chooses
  gh = await ghFiles('gh-alice/keys');
  const sp = Object.entries(gh.files).filter(([p]) => p.startsWith('hardware/spacer/'));
  await commit('gh-alice/keys', Object.fromEntries(sp.flatMap(([p, c]) => [[p, null], ['a/spacer' + p.slice(15), c], ['b/spacer' + p.slice(15), c]])), 'Copy the spacers to two places');
  st = await status(alice, spacer);
  eq('two possible new homes: not guessed, both offered', [st.missing.reason, st.missing.candidates, st.link.path], ['folder', ['a/spacer', 'b/spacer'], 'hardware/spacer']);
  r = await call(alice, 'POST', `/api/projects/${spacer}/github/relocate`, { path: 'b/spacer' });
  st = await status(alice, spacer);
  eq('choosing one relinks without losing what was synced', [r.status, st.link.path, notSynced(st), st.summary.synced], [200, 'b/spacer', {}, 4]);

  // ---- the branch deleted
  await ctl('commit', { fullName: 'gh-alice/keys', branch: 'rev-b', files: { 'x.txt': 'x' } });
  r = await call(alice, 'PUT', `/api/projects/${panel}/github`, { repo: 'gh-alice/keys', branch: 'rev-b', path: 'hardware/panels/p1' });
  r = await push(alice, panel);
  check('a project pushed to its own branch', r.status === 200, JSON.stringify(r.j));
  await ctl('delete-branch', { fullName: 'gh-alice/keys', branch: 'rev-b' });
  st = await status(alice, panel);
  eq('a deleted branch whose project is on the default branch: the link moves there (a branch that leaves nothing behind is in github-multi-edge-e2e)', [st.missing, st.branchMoved, st.link.branch, !(await ctl('state?repo=gh-alice/keys')).branches['rev-b']], [undefined, { from: 'rev-b', to: 'main' }, 'main', true]);

  // ---- the repository renamed on GitHub
  await ctl('rename-repo', { fullName: 'gh-alice/keys', to: 'gh-alice/keyboards' });
  st = await status(alice, keyword);
  eq('a renamed repository keeps its projects linked, under the new name', [st.link.repo, st.renamedRepo, notSynced(st)], ['gh-alice/keyboards', { from: 'gh-alice/keys', to: 'gh-alice/keyboards' }, {}]);

  // ============================================================ the shared library as a submodule
  await ctl('repo', { fullName: 'gh-alice/parts', isPrivate: true, files: { 'README.md': '# parts\n', ...lib('') } });
  const GITMODULES = '[submodule "hardware/lib"]\n\tpath = hardware/lib\n\turl = ../parts.git\n';
  await ctl('repo', { fullName: 'gh-alice/keys-sub', isPrivate: true, files: {
    '.gitmodules': GITMODULES, 'hardware/lib': { submodule: 'gh-alice/parts' },
    ...project('hardware/keybit', 'keybit', KEYBIT_PCB, 21), ...project('hardware/keyword', 'keyword', KEYWORD_PCB, 22),
  } });
  r = await call(alice, 'GET', '/api/github/scan?repo=gh-alice/keys-sub');
  eq('scan reads the shared library through the submodule', r.j.projects.map((p) => [p.path, p.shared.map((s) => s.found)]), [['hardware/keybit', [true, true]], ['hardware/keyword', [true, true]]]);
  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/keys-sub', paths: ['hardware/keybit', 'hardware/keyword'] });
  const sKeybit = r.j.projects[0].projectId, sKeyword = r.j.projects[1].projectId;
  docs = await docsOf(alice, sKeybit);
  eq('a project brings the library in from the submodule\'s repository', Object.keys(docs).sort(), [...SHARED, '../lib/lcsc.3dshapes/SW.wrl', ...own('keybit')].sort());
  st = await status(alice, sKeybit);
  check('files say which repository they are really in', file(st, '../lib/lcsc.kicad_sym').submodule === 'gh-alice/parts' && !file(st, 'keybit.kicad_pcb').submodule && st.submodules[0].path === 'hardware/lib', JSON.stringify(st.submodules));
  eq('in sync', notSynced(st), {});

  // ---- an edit to the library goes to the library's repository, and the parent follows
  await saveOnline(docs['../lib/lcsc.kicad_sym'], SYM1);
  await saveOnline(docs['keybit.kicad_sch'], sch(21, '\t(text "uses C")\n'));
  const partsBefore = await ghFiles('gh-alice/parts');
  r = await push(alice, sKeybit, { message: 'Add C' });
  check('a push with a change inside the submodule succeeds', r.status === 200 && r.j.pushed.length === 2 && r.j.submodules.length === 1 && r.j.submodules[0].repo === 'gh-alice/parts', JSON.stringify(r.j));
  const parts = await ghFiles('gh-alice/parts');
  check('the library\'s own repository gets the commit', parts.files['lcsc.kicad_sym'] === SYM1 && parts.parents[0] === partsBefore.head && parts.message === 'Add C');
  gh = await ghFiles('gh-alice/keys-sub');
  check('the parent repository is moved to that commit, with its own file, in one commit', gh.files['hardware/lib'] === '@commit:' + parts.head && gh.files['hardware/keybit/keybit.kicad_sch'].includes('uses C') && gh.message === 'Add C');
  check('nothing was written into the parent where the submodule is', !Object.keys(gh.files).some((p) => p.startsWith('hardware/lib/')));
  eq('in sync after it', notSynced(await status(alice, sKeybit)), {});
  eq('the other project sees the library change through the submodule', notSynced(await status(alice, sKeyword)), { '../lib/lcsc.kicad_sym': 'pull' });
  await pull(alice, sKeyword);
  eq('…and pulls it', notSynced(await status(alice, sKeyword)), {});

  // ---- the library's repository moved on without the parent: a push is held back, the rest goes
  await commit('gh-alice/parts', { 'NOTES.md': 'someone else\n' }, 'Unrelated change in parts');
  await saveOnline(docs['../lib/lcsc.pretty/R.kicad_mod'], mod('R').replace('smd', 'through_hole'));
  await saveOnline(docs['keybit.kicad_sch'], sch(21, '\t(text "uses C and R")\n'));
  r = await push(alice, sKeybit);
  check('files in a submodule that is behind its branch are held back with the reason; the project\'s own files go', r.status === 200 && r.j.pushed.length === 1 && r.j.pushed[0] === 'keybit.kicad_sch'
    && r.j.blocked.length === 1 && /not the tip/.test(r.j.blocked[0].reason), JSON.stringify(r.j));
  check('…and nothing was written to the library', !(await ghFiles('gh-alice/parts')).files['lcsc.pretty/R.kicad_mod'].includes('through_hole'));
  await commit('gh-alice/keys-sub', { 'hardware/lib': { submodule: 'gh-alice/parts' } }, 'Update the submodule');
  r = await push(alice, sKeybit);
  check('once the parent is updated to the library\'s tip the push goes through', r.status === 200 && (await ghFiles('gh-alice/parts')).files['lcsc.pretty/R.kicad_mod'].includes('through_hole'), JSON.stringify(r.j));

  // ---- deletes and renames inside the submodule
  await db.query('UPDATE documents SET path = $2 WHERE id = $1', [docs['../lib/lcsc.pretty/C.kicad_mod'], '../lib/lcsc.pretty/C_0402.kicad_mod']);
  r = await push(alice, sKeybit, { message: 'Rename C' });
  const parts2 = await ghFiles('gh-alice/parts');
  check('a rename inside the submodule is committed there', r.status === 200 && 'lcsc.pretty/C_0402.kicad_mod' in parts2.files && !('lcsc.pretty/C.kicad_mod' in parts2.files), JSON.stringify(r.j));
  eq('the other project pulls it as a rename', notSynced(await status(alice, sKeyword)), { '../lib/lcsc.pretty/C_0402.kicad_mod': 'pull:was-../lib/lcsc.pretty/C.kicad_mod', '../lib/lcsc.pretty/R.kicad_mod': 'pull' });
  await pull(alice, sKeyword);
  eq('level', notSynced(await status(alice, sKeyword)), {});

  // ---- a pull request cannot carry a submodule change
  await saveOnline(docs['../lib/lcsc.kicad_sym'], SYM0);
  r = await push(alice, sKeybit, { pullRequest: true });
  check('a pull request with only submodule changes is refused with the reason', r.status === 409 && r.j.error === 'push_blocked' && /pull request/.test(r.j.message), JSON.stringify(r.j));
  await push(alice, sKeybit);

  // ---- no write access to the library's repository
  await ctl('access', { fullName: 'gh-alice/keys-sub', login: 'gh-bob', push: true });
  await ctl('access', { fullName: 'gh-alice/parts', login: 'gh-bob', push: false });
  await db.query(`INSERT INTO permissions (project_id, user_id, role) VALUES ($1, $2, 'editor') ON CONFLICT DO NOTHING`, [sKeybit, bobId]);
  await saveOnline(docs['../lib/lcsc.kicad_sym'], SYM1);
  r = await push(bob, sKeybit);
  check('someone who cannot write to the library\'s repository is told so, and nothing is half pushed', r.status === 409 && r.j.error === 'push_blocked' && /can't write/.test(r.j.message)
    && (await ghFiles('gh-alice/parts')).files['lcsc.kicad_sym'] === SYM0, JSON.stringify(r.j));
  await push(alice, sKeybit);

  // ---- a submodule the connection cannot read at all
  await ctl('repo', { fullName: 'gh-bob/secret-parts', isPrivate: true, files: lib('') });
  await ctl('repo', { fullName: 'gh-alice/keys-locked', isPrivate: true, files: {
    '.gitmodules': '[submodule "lib"]\n\tpath = hardware/lib\n\turl = https://github.com/gh-bob/secret-parts.git\n\tbranch = main\n',
    'hardware/lib': { submodule: 'gh-bob/secret-parts' }, ...project('hardware/keybit', 'keybit', KEYBIT_PCB, 31),
  } });
  r = await call(alice, 'GET', '/api/github/scan?repo=gh-alice/keys-locked');
  check('scan names a submodule it cannot read, and the repository to add', r.j.notes.some((n) => n.kind === 'submodule_no_access' && n.repo === 'gh-bob/secret-parts' && n.path === 'hardware/lib'), JSON.stringify(r.j.notes));
  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/keys-locked', path: 'hardware/keybit' });
  const locked = r.j.projectId;
  check('the project still comes online, without the library, and says what is missing', r.status === 200 && r.j.files === 5 && r.j.notes[0].kind === 'submodule_no_access' && /gh-bob\/secret-parts/.test(r.j.notes[0].message), JSON.stringify(r.j));
  await ctl('access', { fullName: 'gh-bob/secret-parts', login: 'gh-alice', push: false });
  st = await status(alice, locked);
  eq('once access is given the library shows up as files to pull', [st.notes, st.summary.pull], [undefined, 5]);
  await pull(alice, locked);
  eq('…and pulls', notSynced(await status(alice, locked)), {});

  // ---- a submodule that is not on GitHub
  await ctl('repo', { fullName: 'gh-alice/keys-elsewhere', files: {
    '.gitmodules': '[submodule "lib"]\n\tpath = hardware/lib\n\turl = https://gitlab.com/someone/parts.git\n',
    'hardware/lib': { submodule: 'gh-alice/parts' }, ...project('hardware/keybit', 'keybit', KEYBIT_PCB, 41),
  } });
  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/keys-elsewhere', path: 'hardware/keybit' });
  check('a submodule kept somewhere other than GitHub is explained', r.status === 200 && r.j.notes[0].kind === 'submodule_not_github' && /gitlab\.com/.test(r.j.notes[0].message), JSON.stringify(r.j));

  // ============================================================ a whole project as a submodule
  await ctl('repo', { fullName: 'gh-alice/amp-board', files: { 'amp.kicad_pro': pro('amp'), 'amp.kicad_pcb': board([fpItem('R', 7, 1)]), 'amp.kicad_sch': sch(51), 'docs/readme.txt': 'x' } });
  await ctl('repo', { fullName: 'gh-alice/mono', files: {
    '.gitmodules': '[submodule "boards/amp"]\n\tpath = boards/amp\n\turl = git@github.com:gh-alice/amp-board.git\n',
    'boards/amp': { submodule: 'gh-alice/amp-board' }, 'boards/top/top.kicad_pro': pro('top'), 'boards/top/top.kicad_pcb': board([]),
  } });
  r = await call(alice, 'GET', '/api/github/scan?repo=gh-alice/mono');
  eq('a project that is itself a submodule is found, and says so', r.j.projects.map((p) => [p.path, p.submodule]), [['boards/amp', 'gh-alice/amp-board'], ['boards/top', undefined]]);
  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/mono', paths: ['boards/amp', 'boards/top'] });
  const amp = r.j.projects[0].projectId;
  docs = await docsOf(alice, amp);
  eq('it comes online with its files', Object.keys(docs).sort(), ['amp.kicad_pcb', 'amp.kicad_pro', 'amp.kicad_sch']);
  await saveOnline(docs['amp.kicad_sch'], sch(51, '\t(text "from junction")\n'));
  r = await push(alice, amp, { message: 'Note' });
  const ampRepo = await ghFiles('gh-alice/amp-board');
  gh = await ghFiles('gh-alice/mono');
  check('its pushes go to its own repository, and the parent points at the new commit', r.status === 200 && ampRepo.files['amp.kicad_sch'].includes('from junction') && gh.files['boards/amp'] === '@commit:' + ampRepo.head, JSON.stringify(r.j));
  eq('in sync', notSynced(await status(alice, amp)), {});
  await commit('gh-alice/amp-board', { 'amp.kicad_pcb': board([fpItem('R', 7, 2)]) }, 'Edit in the board repository');
  eq('a change in its repository is not seen until the parent takes it (the parent pins a commit)', notSynced(await status(alice, amp)), {});
  await commit('gh-alice/mono', { 'boards/amp': { submodule: 'gh-alice/amp-board' } }, 'Update amp');
  eq('…then it is a change to pull', notSynced(await status(alice, amp)), { 'amp.kicad_pcb': 'pull' });
  await pull(alice, amp);
  eq('pulled', notSynced(await status(alice, amp)), {});

  // ---- history of a file in a submodule comes from the submodule's repository
  r = await call(alice, 'GET', `/api/projects/${amp}/github/commits?path=amp.kicad_sch`);
  check('a file\'s history is read from the repository it is in', r.status === 200 && r.j.repo === 'gh-alice/amp-board' && r.j.commits.length === 2 && r.j.commits[0].message === 'Note', JSON.stringify(r.j));
  const old = await fetch(`${BASE}/api/projects/${amp}/github/file?path=amp.kicad_sch&sha=${r.j.commits[1].sha}`, { headers: { Authorization: `Bearer ${alice}` } });
  check('…and so is an old version of it', old.status === 200 && (await old.text()) === sch(51));
  r = await call(alice, 'GET', `/api/projects/${sKeybit}/github/diff?path=${encodeURIComponent('../lib/lcsc.kicad_sym')}`);
  check('the change list works for a shared file', r.status === 200 && r.j.path === '../lib/lcsc.kicad_sym', JSON.stringify(r.j));

  // ============================================================ files renamed in a local copy (the desktop app reports them)
  const before2 = await docsOf(alice, panel);
  r = await call(alice, 'POST', `/api/projects/${panel}/renamed`, { renames: [{ from: 'p1.kicad_pcb', to: 'panel.kicad_pcb' }] });
  const after2 = await docsOf(alice, panel);
  check('a file renamed in a local copy is the same online document under its new name', r.status === 200 && r.j.renamed.length === 1 && after2['panel.kicad_pcb'] === before2['p1.kicad_pcb'] && !after2['p1.kicad_pcb']
    && Object.keys(after2).length === Object.keys(before2).length, JSON.stringify(r.j));
  r = await call(alice, 'POST', `/api/projects/${panel}/renamed`, { renames: [{ from: 'p1.kicad_pcb', to: 'panel.kicad_pcb' }] });
  check('reporting it again changes nothing', r.status === 200 && r.j.renamed.length === 0, JSON.stringify(r.j));
  st = await status(alice, panel);
  check('…and GitHub sync sees one renamed file to push, not a new file and a deleted one', file(st, 'panel.kicad_pcb').renamedFrom === 'p1.kicad_pcb' && file(st, 'panel.kicad_pcb').state === 'push', JSON.stringify(notSynced(st)));
  r = await call(alice, 'POST', `/api/projects/${panel}/renamed`, { renames: [{ from: 'p1.kicad_pro', to: 'panel.kicad_pcb' }] });
  check('a rename onto an existing file, or to another file type, is refused', r.status === 400, JSON.stringify(r.j));
  r = await call(alice, 'POST', `/api/projects/${panel}/renamed`, { renames: [{ from: 'panel.kicad_pcb', to: '../panel.kicad_pcb' }] });
  check('…and so is one that leaves the project folder', r.status === 400, JSON.stringify(r.j));
  r = await call(bob, 'POST', `/api/projects/${panel}/renamed`, { renames: [{ from: 'panel.kicad_pcb', to: 'x.kicad_pcb' }] });
  check('…and one from someone who cannot edit the project', r.status === 403, JSON.stringify(r.j));

  // ============================================================ a download keeps the shared library beside the project
  const zip = await fetch(`${BASE}/api/projects/${keybit}/archive`, { headers: { Authorization: `Bearer ${alice}` } });
  const zipText = Buffer.from(await zip.arrayBuffer()).toString('latin1');
  check('the project download holds the project in its folder and the shared library beside it, as in the repository',
    zip.status === 200 && zipText.includes('keybit/keybit.kicad_pcb') && zipText.includes('lib/lcsc.kicad_sym') && zipText.includes('keybit/collab-manifest.json'), String(zip.status));
  // entry names from the zip's central directory (compressed bytes can hold any three characters by chance)
  const zipBuf = Buffer.from(zipText, 'latin1'), zipNames = [];
  for (let i = zipBuf.indexOf('PK\x01\x02', 0, 'latin1'); i >= 0; i = zipBuf.indexOf('PK\x01\x02', i + 46, 'latin1')) zipNames.push(zipBuf.toString('utf8', i + 46, i + 46 + zipBuf.readUInt16LE(i + 28)));
  check('…with no entry that climbs out of where it is unpacked', zipNames.length > 5 && !zipNames.some((n) => n.startsWith('/') || n.split('/').includes('..')), JSON.stringify(zipNames));
  const flat = await fetch(`${BASE}/api/projects/${panel}/archive`, { headers: { Authorization: `Bearer ${alice}` } });
  const flatText = Buffer.from(await flat.arrayBuffer()).toString('latin1');
  check('a project that shares nothing still downloads as its plain folder', flat.status === 200 && flatText.includes('p1.kicad_pro') && !flatText.includes('p1/p1.kicad_pro'));
} finally {
  await db.query('DELETE FROM projects WHERE owner_id = ANY($1)', [[aliceId, bobId]]).catch(() => {});
  await db.query('DELETE FROM ops WHERE author_id = ANY($1)', [[aliceId, bobId]]).catch(() => {});
  await db.query('DELETE FROM users WHERE id = ANY($1)', [[aliceId, bobId]]).catch((e) => console.error('cleanup:', e.message));
  await db.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
