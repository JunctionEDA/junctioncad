// End-to-end test of the odd corners of GitHub sync for repositories with several projects:
// "what if" cases that real repositories produce.  Library folders with any name and at
// any depth, paths written on Windows or picked through a file dialog, drawing sheets and
// simulation models outside the project, the library folder renamed in stock KiCad and
// pushed with git, case-only renames, a rename on both sides, a rewritten history, the
// default branch renamed, a folder turned into a submodule and back, symbolic links,
// Git LFS pointers, two projects racing on the library they share.
//
// Runs against fake-github.mjs; start the fake and a LOCAL server on a THROWAWAY database
// exactly as github-e2e.mjs says, then:
//
//   E2E_PG_URL=postgres://postgres@127.0.0.1:55432/collabtest E2E_JWT_SECRET=testsecret \
//     node github-multi-edge-e2e.mjs
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
const fpItem = (ref, n, x, model) => `\t(footprint "lcsc:${ref}"\n\t\t(layer "F.Cu")\n\t\t(uuid "${uuid(n)}")\n\t\t(at ${x} 50)\n${(model ? [].concat(model) : []).map((m) => `\t\t(model "${m}"\n\t\t\t(offset (xyz 0 0 0))\n\t\t)\n`).join('')}\t)\n`;
const board = (items) => `(kicad_pcb\n\t(version 20241229)\n\t(generator "pcbnew")\n\t(generator_version "9.0")\n\t(general\n\t\t(thickness 1.6)\n\t)\n\t(paper "A4")\n${items.join('')})\n`;
const sch = (n, extra = '') => `(kicad_sch\n\t(version 20250114)\n\t(generator "eeschema")\n\t(uuid "${uuid(n)}")\n\t(paper "A4")\n${extra})\n`;
const pro = (name, sheet = '') => `{\n  "meta": { "filename": "${name}.kicad_pro", "version": 3 },\n  "pcbnew": { "page_layout_descr_file": "${sheet}" }\n}\n`;
const fpTable = (dir) => `(fp_lib_table\n  (version 7)\n  (lib (name "lcsc")(type "KiCad")(uri "\${KIPRJMOD}/../${dir}/lcsc.pretty")(options "")(descr ""))\n)\n`;
const symTable = (dir, more = '') => `(sym_lib_table\n  (version 7)\n  (lib (name "lcsc")(type "KiCad")(uri "\${KIPRJMOD}/../${dir}/lcsc.kicad_sym")(options "")(descr ""))\n${more})\n`;
const mod = (name) => `(footprint "${name}"\n\t(version 20241229)\n\t(generator "pcbnew")\n\t(layer "F.Cu")\n\t(attr smd)\n)\n`;
const sym = (names) => `(kicad_symbol_lib\n\t(version 20241209)\n\t(generator "kicad_symbol_editor")\n${names.map((n) => `\t(symbol "${n}"\n\t\t(property "Reference" "${n[0]}"\n\t\t\t(at 0 0 0)\n\t\t)\n\t)\n`).join('')})\n`;
const wrl = (n) => `#VRML V2.0 utf8\n# ${n}\n`, step = (n) => `ISO-10303-21;\n/* ${n} */\nEND-ISO-10303-21;\n`;
const moveDir = (files, from, to) => Object.fromEntries(Object.entries(files).filter(([p]) => p.startsWith(from + '/')).flatMap(([p, c]) => [[p, null], [to + p.slice(from.length), c]]));

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
  // ============================================================ libraries anywhere, named any way
  const KB_MODELS = ['${KIPRJMOD}/../parts/lcsc.3dshapes/SW.wrl', '/Users/someone/Documents/GitHub/edge/hw/parts/lcsc.3dshapes/ABS.wrl',
    'Legacy.3dshapes/R_0603.wrl', '${KICAD10_3DMODEL_DIR}/Resistor_SMD.3dshapes/R_0603.step', '/usr/share/kicad/3dmodels/X.wrl'];
  const MORE_SYMS = '  (lib (name "extra")(type "KiCad")(uri "../../common/sym/extra.kicad_sym")(options "")(descr ""))\n'
    + '  (lib (name "win")(type "KiCad")(uri "${KIPRJMOD}\\\\..\\\\parts\\\\win.kicad_sym")(options "")(descr ""))\n'
    + '  (lib (name "std")(type "KiCad")(uri "${KICAD10_SYMBOL_DIR}/Device.kicad_sym")(options "")(descr ""))\n';
  const kbFiles = (dir) => ({
    'hw/kb/kb.kicad_pro': pro('kb', '../shared/frame.kicad_wks'), 'hw/kb/kb.kicad_pcb': board([fpItem('SW', 1, 100, KB_MODELS.map((m) => m.replace('/parts/', `/${dir}/`))), fpItem('R', 2, 110)]),
    'hw/kb/kb.kicad_sch': sch(11, '\t(symbol\n\t\t(lib_id "lcsc:U")\n\t\t(uuid "' + uuid(12) + '")\n\t\t(property "Sim.Library" "../models/opamp.lib"\n\t\t\t(at 0 0 0)\n\t\t)\n\t)\n'),
    'hw/kb/fp-lib-table': fpTable(dir), 'hw/kb/sym-lib-table': symTable(dir, MORE_SYMS.replace('parts', dir)),
  });
  const kwFiles = (dir) => ({
    'hw/kw/kw.kicad_pro': pro('kw'), 'hw/kw/kw.kicad_pcb': board([fpItem('R', 3, 100), fpItem('C', 4, 110)]), 'hw/kw/kw.kicad_sch': sch(21),
    'hw/kw/fp-lib-table': fpTable(dir), 'hw/kw/sym-lib-table': symTable(dir),
  });
  const parts = (prefix) => ({
    [`${prefix}lcsc.kicad_sym`]: sym(['R', 'U']), [`${prefix}win.kicad_sym`]: sym(['W']),
    [`${prefix}lcsc.pretty/R.kicad_mod`]: mod('R'), [`${prefix}lcsc.pretty/C.kicad_mod`]: mod('C'), [`${prefix}lcsc.pretty/SW.kicad_mod`]: mod('SW'),
    [`${prefix}lcsc.3dshapes/SW.wrl`]: wrl('SW'), [`${prefix}lcsc.3dshapes/SW.step`]: step('SW'),
    [`${prefix}lcsc.3dshapes/ABS.wrl`]: wrl('ABS'), [`${prefix}lcsc.3dshapes/ABS.step`]: step('ABS'),
    [`${prefix}lcsc.3dshapes/unused.step`]: step('unused'),
  });
  await ctl('repo', { fullName: 'gh-alice/edge', isPrivate: true, collaborators: ['gh-bob'], files: {
    'README.md': '# edge\n', ...kbFiles('parts'), ...kwFiles('parts'), ...parts('hw/parts/'),
    'hw/shared/frame.kicad_wks': '(kicad_wks (version 20231118) (generator "pl_editor"))\n', 'hw/models/opamp.lib': '* opamp\n.subckt OPAMP 1 2 3\n.ends\n',
    'common/sym/extra.kicad_sym': sym(['X']),
  } });
  const KB_OWN = ['fp-lib-table', 'kb.kicad_pcb', 'kb.kicad_pro', 'kb.kicad_sch', 'sym-lib-table'];
  const kbShared = (dir) => ['../../common/sym/extra.kicad_sym', '../models/opamp.lib', '../shared/frame.kicad_wks',
    ...['lcsc.kicad_sym', 'win.kicad_sym', 'lcsc.pretty/R.kicad_mod', 'lcsc.pretty/C.kicad_mod', 'lcsc.pretty/SW.kicad_mod',
      'lcsc.3dshapes/SW.wrl', 'lcsc.3dshapes/SW.step', 'lcsc.3dshapes/ABS.wrl', 'lcsc.3dshapes/ABS.step'].map((p) => `../${dir}/${p}`)];
  r = await call(alice, 'GET', '/api/github/scan?repo=gh-alice/edge');
  eq('scan: a shared folder needs no particular name or depth', r.j.projects.find((p) => p.path === 'hw/kb').shared.map((s) => [s.path, s.found]).sort(),
    [['../../common/sym/extra.kicad_sym', true], ['../parts/lcsc.kicad_sym', true], ['../parts/lcsc.pretty', true], ['../parts/win.kicad_sym', true]]);
  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/edge', paths: ['hw/kb', 'hw/kw'] });
  const kb = r.j.projects[0].projectId, kw = r.j.projects[1].projectId;
  docs = await docsOf(alice, kb);
  eq('the project brings what it names wherever it is: a library two folders up, a path written on Windows, the drawing sheet of the project file, a simulation model, the STEP file beside a VRML model, and a model named by its absolute path on someone\'s machine',
    Object.keys(docs).sort(), [...KB_OWN, ...kbShared('parts')].sort());
  eq('…and says nothing about paths that are not the repository\'s business (KiCad\'s own folders, a bare legacy model name)', r.j.projects[0].notes, undefined);
  eq('in sync', [notSynced(await status(alice, kb)), notSynced(await status(alice, kw))], [{}, {}]);

  // ---- the download keeps every one of those where the project expects it
  const zipNames = async (id) => { const z = Buffer.from(await (await fetch(`${BASE}/api/projects/${id}/archive`, { headers: { Authorization: `Bearer ${alice}` } })).arrayBuffer()).toString('latin1');
    return (p) => z.includes(p); };
  let has = await zipNames(kb);
  check('a download of a project that reaches two folders up keeps that whole shape', has('hw/kb/kb.kicad_pro') && has('hw/parts/lcsc.kicad_sym') && has('common/sym/extra.kicad_sym') && has('hw/shared/frame.kicad_wks') && !has('../'));

  // ============================================================ the library folder renamed in stock KiCad, pushed with git
  const kbDocs0 = docs;
  gh = await ghFiles('gh-alice/edge');
  await commit('gh-alice/edge', { ...moveDir(gh.files, 'hw/parts', 'hw/library'), ...kbFiles('library'), ...kwFiles('library') }, 'Rename parts to library');
  st = await status(alice, kb);
  const renamed = Object.fromEntries(st.files.filter((f) => f.renamedFrom).map((f) => [f.path, f.renamedFrom]));
  eq('a renamed library folder is seen as its files renamed, not as a library deleted and another added',
    renamed, Object.fromEntries(kbShared('library').filter((p) => p.startsWith('../library/')).map((p) => [p, p.replace('/library/', '/parts/')])));
  eq('…beside the tables and the board that now name the new folder', Object.entries(notSynced(st)).filter(([, v]) => !v.includes('was-')).map(([p, v]) => `${p} ${v}`).sort(),
    ['fp-lib-table pull', 'kb.kicad_pcb pull', 'sym-lib-table pull']);
  r = await pull(alice, kb);
  docs = await docsOf(alice, kb);
  check('pulling keeps every library file the same online document under its new path', r.status === 200 && kbShared('parts').filter((p) => p.startsWith('../parts/')).every((p) => docs[p.replace('/parts/', '/library/')] === kbDocs0[p]) && !Object.keys(docs).some((p) => p.startsWith('../parts/')), JSON.stringify(r.j).slice(0, 400));
  st = await status(alice, kb);
  eq('…with nothing left over and nothing set aside as removed', [notSynced(st), st.removed, Object.keys(docs).length], [{}, undefined, KB_OWN.length + kbShared('x').length]);
  await pull(alice, kw);
  eq('the other project follows the same way', [notSynced(await status(alice, kw)), Object.keys(await docsOf(alice, kw)).filter((p) => p.startsWith('../parts/'))], [{}, []]);

  // ============================================================ renames that differ only in case
  const schId = docs['kb.kicad_sch'];
  gh = await ghFiles('gh-alice/edge');
  await commit('gh-alice/edge', { 'hw/kb/kb.kicad_sch': null, 'hw/kb/KB.kicad_sch': gh.files['hw/kb/kb.kicad_sch'] }, 'Capitalise');
  st = await status(alice, kb);
  eq('a rename that only changes capitals is a rename', notSynced(st), { 'KB.kicad_sch': 'pull:was-kb.kicad_sch' });
  r = await pull(alice, kb);
  docs = await docsOf(alice, kb);
  check('…pulled in place', r.status === 200 && docs['KB.kicad_sch'] === schId && !docs['kb.kicad_sch'], JSON.stringify(r.j));
  eq('…and level', notSynced(await status(alice, kb)), {});

  // ============================================================ two files swap names
  gh = await ghFiles('gh-alice/edge');
  await commit('gh-alice/edge', { 'hw/library/lcsc.pretty/R.kicad_mod': gh.files['hw/library/lcsc.pretty/C.kicad_mod'], 'hw/library/lcsc.pretty/C.kicad_mod': gh.files['hw/library/lcsc.pretty/R.kicad_mod'] }, 'Swap R and C');
  eq('two files that swapped names are two changed files', notSynced(await status(alice, kb)), { '../library/lcsc.pretty/C.kicad_mod': 'pull', '../library/lcsc.pretty/R.kicad_mod': 'pull' });
  r = await pull(alice, kb);
  check('…and pull as that', await localFile(alice, docs['../library/lcsc.pretty/R.kicad_mod']) === mod('C') && await localFile(alice, docs['../library/lcsc.pretty/C.kicad_mod']) === mod('R'), JSON.stringify(r.j));
  await pull(alice, kw);

  // ============================================================ the same file renamed differently on each side
  const swId = docs['../library/lcsc.pretty/SW.kicad_mod'];
  await db.query('UPDATE documents SET path = $2 WHERE id = $1', [swId, '../library/lcsc.pretty/SW_online.kicad_mod']);
  await commit('gh-alice/edge', { 'hw/library/lcsc.pretty/SW.kicad_mod': null, 'hw/library/lcsc.pretty/SW_github.kicad_mod': mod('SW') }, 'Rename SW');
  st = await status(alice, kb);
  eq('a file renamed to one name online and another on GitHub is still one file', notSynced(st), { '../library/lcsc.pretty/SW_online.kicad_mod': 'push:was-../library/lcsc.pretty/SW_github.kicad_mod' });
  r = await pull(alice, kb);
  eq('a pull does not bring it in a second time', [r.j.updated, Object.keys(await docsOf(alice, kb)).filter((p) => p.includes('SW_'))], [[], ['../library/lcsc.pretty/SW_online.kicad_mod']]);
  eq('…and asking again later sees the same thing', notSynced(await status(alice, kb)), { '../library/lcsc.pretty/SW_online.kicad_mod': 'push:was-../library/lcsc.pretty/SW_github.kicad_mod' });
  r = await push(alice, kb, { message: 'One name for SW' });
  gh = await ghFiles('gh-alice/edge');
  eq('a push leaves one file, under the online name', [r.status, Object.keys(gh.files).filter((p) => p.includes('SW_')), notSynced(await status(alice, kb))], [200, ['hw/library/lcsc.pretty/SW_online.kicad_mod'], {}]);
  check('…still the same online document', (await docsOf(alice, kb))['../library/lcsc.pretty/SW_online.kicad_mod'] === swId);
  eq('the other project sees one rename', notSynced(await status(alice, kw)), { '../library/lcsc.pretty/SW_online.kicad_mod': 'pull:was-../library/lcsc.pretty/SW.kicad_mod' });
  await pull(alice, kw);

  // ============================================================ renamed on GitHub without telling the table, deleted online
  docs = await docsOf(alice, kb);
  r = await call(alice, 'DELETE', `/api/docs/${docs['../library/win.kicad_sym']}`);
  await commit('gh-alice/edge', { 'hw/library/win.kicad_sym': null, 'hw/library/windows.kicad_sym': sym(['W']) }, 'Rename win');
  st = await status(alice, kb);
  eq('a file gone from both sides is simply gone', notSynced(st), {});
  check('…and the table that still names it is pointed out', (st.notes || []).some((n) => n.kind === 'missing_ref' && /win\.kicad_sym/.test(n.message)), JSON.stringify(st.notes));
  r = await push(alice, kb);
  check('…with nothing to push and the renamed file on GitHub untouched', r.status === 409 && 'hw/library/windows.kicad_sym' in (await ghFiles('gh-alice/edge')).files);

  // ============================================================ symbolic links, Git LFS
  const LFS = 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n';
  const aTable = '(sym_lib_table\n  (version 7)\n  (lib (name "shared")(type "KiCad")(uri "${KIPRJMOD}/lib/shared.kicad_sym")(options "")(descr ""))\n)\n';
  const oddFiles = {
    'hw/a/a.kicad_pro': pro('a'), 'hw/a/a.kicad_pcb': board([fpItem('R', 31, 100, '${KIPRJMOD}/models/big.step')]), 'hw/a/a.kicad_sch': sch(32),
    'hw/a/sym-lib-table': aTable, 'hw/a/models/big.step': LFS,
    'hw/a/lib': { symlink: '../common/lib' }, 'hw/a/alias.kicad_sym': { symlink: '../common/lib/shared.kicad_sym' },
    'hw/a/away.kicad_sym': { symlink: '../../../elsewhere/x.kicad_sym' }, 'hw/a/abs.kicad_sym': { symlink: '/usr/share/kicad/x.kicad_sym' },
    'hw/a/gone.kicad_sym': { symlink: 'nothing-here.kicad_sym' }, 'hw/a/round': { symlink: '.' }, 'hw/a/up': { symlink: '../..' },
    'hw/common/lib/shared.kicad_sym': sym(['S']), 'hw/common/lib/fp.pretty/R.kicad_mod': mod('R'),
  };
  await ctl('repo', { fullName: 'gh-alice/odd', isPrivate: true, collaborators: ['gh-bob'], files: { 'README.md': '# odd\n', ...oddFiles } });
  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/odd', paths: ['hw/a'] });
  const pa = r.j.projects[0].projectId;
  docs = await docsOf(alice, pa);
  const A_DOCS = ['a.kicad_pcb', 'a.kicad_pro', 'a.kicad_sch', 'alias.kicad_sym', 'lib/fp.pretty/R.kicad_mod', 'lib/shared.kicad_sym', 'sym-lib-table'];
  eq('a symbolic link to a folder or a file is followed; one that leaves the repository, points at nothing or loops is left out; a Git LFS pointer is not taken for the file',
    Object.keys(docs).sort(), A_DOCS);
  check('…a linked file has the real content, not the link', await localFile(alice, docs['alias.kicad_sym']) === sym(['S']));
  st = await status(alice, pa);
  eq('…each of those is said once', (st.notes || []).map((n) => `${n.kind} ${n.path}`).sort(),
    ['lfs models/big.step', 'symlink_broken hw/a/gone.kicad_sym', 'symlink_loop hw/a/round', 'symlink_loop hw/a/up', 'symlink_outside hw/a/abs.kicad_sym', 'symlink_outside hw/a/away.kicad_sym']);
  eq('in sync', notSynced(st), {});

  await saveOnline(docs['lib/shared.kicad_sym'], sym(['S', 'T']));
  const newMod = (await db.query(`INSERT INTO documents (project_id, path, doc_type) VALUES ($1, 'lib/fp.pretty/C.kicad_mod', 'footprint') RETURNING id`, [pa])).rows[0].id;
  await saveOnline(newMod, mod('C'));
  const bigStep = (await db.query(`INSERT INTO documents (project_id, path, doc_type) VALUES ($1, 'models/big.step', 'model3d') RETURNING id`, [pa])).rows[0].id;
  await saveOnline(bigStep, step('big'));
  eq('a file changed and a file added below a linked folder are pushes; a file online where GitHub keeps an LFS pointer is left alone', notSynced(await status(alice, pa)),
    { 'lib/shared.kicad_sym': 'push', 'lib/fp.pretty/C.kicad_mod': 'push' });
  r = await push(alice, pa, { message: 'Through the link' });
  gh = await ghFiles('gh-alice/odd');
  eq('a push writes them where they really are and leaves the links and the LFS pointer as they were',
    [r.status, gh.files['hw/common/lib/shared.kicad_sym'] === sym(['S', 'T']), gh.files['hw/common/lib/fp.pretty/C.kicad_mod'] === mod('C'), gh.files['hw/a/lib'], gh.files['hw/a/alias.kicad_sym'], gh.files['hw/a/models/big.step'] === LFS],
    [200, true, true, '->../common/lib', '->../common/lib/shared.kicad_sym', true]);
  eq('the same file under its other name is then a pull', notSynced(await status(alice, pa)), { 'alias.kicad_sym': 'pull' });
  await pull(alice, pa);
  eq('…and all is in sync', notSynced(await status(alice, pa)), {});
  await db.query('DELETE FROM documents WHERE id = $1', [bigStep]);

  // ============================================================ a second online project on the same folder
  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/odd', paths: ['hw/a'] });
  check('importing the folder again points at the project already online', r.status === 409 || r.j.projects?.[0]?.existing === true, JSON.stringify(r.j));
  r = await call(alice, 'POST', '/api/github/import', { repo: 'gh-alice/odd', paths: ['hw/a'], duplicate: true });
  const pb = r.j.projects[0].projectId;
  check('…unless a second copy is asked for', r.status === 200 && pb && pb !== pa, JSON.stringify(r.j));
  let docsB = await docsOf(alice, pb);
  eq('each of two projects on one folder is told about the other', [(await status(alice, pa)).alsoLinked?.map((o) => o.projectId), (await status(alice, pb)).alsoLinked?.map((o) => o.projectId), (await status(alice, kb)).alsoLinked], [[pb], [pa], undefined]);
  await saveOnline(docs['a.kicad_pcb'], board([fpItem('R', 31, 120)]));
  await saveOnline(docsB['a.kicad_sch'], sch(32, '\t(text "from b"\n\t\t(at 10 10 0)\n\t\t(uuid "' + uuid(33) + '")\n\t)\n'));
  r = await push(alice, pa, { message: 'A moves R' });
  eq('two online projects on one folder: after the first pushes, the second sees that as a pull beside its own push', [r.status, notSynced(await status(alice, pb))], [200, { 'a.kicad_pcb': 'pull', 'a.kicad_sch': 'push' }]);
  r = await push(alice, pb, { message: 'B adds a note' });
  gh = await ghFiles('gh-alice/odd');
  check('…and its push keeps the first one\'s work', r.status === 200 && gh.files['hw/a/a.kicad_pcb'] === board([fpItem('R', 31, 120)]) && gh.files['hw/a/a.kicad_sch'].includes('from b'), JSON.stringify(r.j));
  await pull(alice, pb); await pull(alice, pa);
  await saveOnline(docs['a.kicad_pro'], pro('a', 'one.kicad_wks'));
  await saveOnline(docsB['a.kicad_pro'], pro('a', 'two.kicad_wks'));
  await push(alice, pa, { message: 'A sets a sheet' });
  st = await status(alice, pb);
  eq('both changing the same file is a conflict for the second, never a silent overwrite', notSynced(st), { 'a.kicad_pro': 'conflict' });
  r = await push(alice, pb, { message: 'B sets a sheet' });
  check('…its push is refused', r.status === 409 && (await ghFiles('gh-alice/odd')).files['hw/a/a.kicad_pro'] === pro('a', 'one.kicad_wks'), JSON.stringify(r.j));
  await saveOnline(docsB['a.kicad_pro'], pro('a', 'one.kicad_wks'));
  eq('…and once it agrees there is nothing left to do', notSynced(await status(alice, pb)), {});

  // ============================================================ the branch renamed, or merged and deleted
  await ctl('rename-branch', { fullName: 'gh-alice/odd', branch: 'main', to: 'trunk' });
  st = await status(alice, pa);
  eq('the branch renamed on GitHub (main to trunk): the link follows it, in sync', [st.branchMoved, st.link.branch, st.missing, notSynced(st)], [{ from: 'main', to: 'trunk' }, 'trunk', undefined, {}]);
  eq('…and says so once', (await status(alice, pa)).branchMoved, undefined);
  await saveOnline(docs['a.kicad_sch'], sch(32, '\t(text "on trunk"\n\t\t(at 10 10 0)\n\t\t(uuid "' + uuid(34) + '")\n\t)\n'));
  r = await push(alice, pa, { message: 'On trunk' });
  check('…a push goes to the new name', r.status === 200 && (await ghFiles('gh-alice/odd', 'trunk')).files['hw/a/a.kicad_sch'].includes('on trunk') && !(await ctl('state?repo=gh-alice/odd')).branches.main, JSON.stringify(r.j));
  await ctl('branch', { fullName: 'gh-alice/odd', from: 'trunk', to: 'feature' });
  await pull(alice, pb);
  r = await call(alice, 'PUT', `/api/projects/${pb}/github`, { repo: 'gh-alice/odd', branch: 'feature', path: 'hw/a' });
  eq('a project on a feature branch', [r.status, notSynced(await status(alice, pb))], [200, {}]);
  await commit('gh-alice/odd', { 'hw/a/a.kicad_sch': sch(32, '\t(text "after the merge"\n\t\t(at 10 10 0)\n\t\t(uuid "' + uuid(35) + '")\n\t)\n') }, 'More on trunk');
  await ctl('delete-branch', { fullName: 'gh-alice/odd', branch: 'feature' });
  st = await status(alice, pb);
  eq('the feature branch merged and deleted: the link moves to the default branch, where the project is', [st.branchMoved, st.link.branch, notSynced(st)], [{ from: 'feature', to: 'trunk' }, 'trunk', { 'a.kicad_sch': 'pull' }]);
  await pull(alice, pb); await pull(alice, pa);
  // a branch that is gone with nothing like the project on the default branch stays a question
  await ctl('branch', { fullName: 'gh-alice/odd', from: 'trunk', to: 'wild' });
  await call(alice, 'PUT', `/api/projects/${pb}/github`, { repo: 'gh-alice/odd', branch: 'wild', path: 'hw/a' });
  eq('(on another branch, in sync)', notSynced(await status(alice, pb)), {});
  await ctl('default-branch', { fullName: 'gh-alice/odd', branch: 'docs' });
  await ctl('commit', { fullName: 'gh-alice/odd', branch: 'docs', files: { 'README.md': '# docs only\n' }, message: 'Docs' });
  await ctl('delete-branch', { fullName: 'gh-alice/odd', branch: 'wild' });
  st = await status(alice, pb);
  eq('a deleted branch with no sign of the project on the default branch is not followed anywhere', [st.missing?.reason, st.branchMoved], ['branch', undefined]);
  r = await push(alice, pb);
  check('…a push needs the person to say so', r.status === 409 && !(await ctl('state?repo=gh-alice/odd')).branches.wild, JSON.stringify(r.j));
  r = await push(alice, pb, { restore: true });
  check('…and then recreates the branch', r.status === 200 && !!(await ctl('state?repo=gh-alice/odd')).branches.wild, JSON.stringify(r.j));
  await ctl('delete-branch', { fullName: 'gh-alice/odd', branch: 'wild' });
  await ctl('default-branch', { fullName: 'gh-alice/odd', branch: 'trunk' });
  eq('…until the project is there again', [(st = await status(alice, pb)).branchMoved, notSynced(st)], [{ from: 'wild', to: 'trunk' }, {}]);

  // ============================================================ history rewritten (force-push)
  gh = await ghFiles('gh-alice/odd', 'trunk');
  const asCommitted = (files) => Object.fromEntries(Object.entries(files).map(([p, c]) => [p, c.startsWith('->') ? { symlink: c.slice(2) } : c]));
  await saveOnline(docs['a.kicad_pcb'], board([fpItem('R', 31, 130)]));
  await ctl('delete-branch', { fullName: 'gh-alice/odd', branch: 'trunk' });
  await ctl('commit', { fullName: 'gh-alice/odd', branch: 'trunk', files: { ...asCommitted(gh.files), 'hw/a/a.kicad_sch': sch(32, '\t(text "rewritten"\n\t\t(at 10 10 0)\n\t\t(uuid "' + uuid(36) + '")\n\t)\n') }, message: 'Squashed' });
  st = await status(alice, pa);
  eq('history rewritten with a force-push: files are compared by content, so only what differs shows', notSynced(st), { 'a.kicad_pcb': 'push', 'a.kicad_sch': 'pull' });
  r = await pull(alice, pa);
  const r2 = await push(alice, pa, { message: 'After the rewrite' });
  gh = await ghFiles('gh-alice/odd', 'trunk');
  check('…pull and push go on from the rewritten branch', r.status === 200 && r2.status === 200 && gh.files['hw/a/a.kicad_pcb'] === board([fpItem('R', 31, 130)]) && gh.files['hw/a/a.kicad_sch'].includes('rewritten') && gh.parents.length === 1, JSON.stringify([r.j, r2.j]));
  await pull(alice, pb);

  // ============================================================ the library folder turned into a submodule, and back
  gh = await ghFiles('gh-alice/odd', 'trunk');
  const common = Object.fromEntries(Object.entries(gh.files).filter(([p]) => p.startsWith('hw/common/')).map(([p, c]) => [p.slice('hw/common/'.length), c]));
  await ctl('repo', { fullName: 'gh-alice/common', isPrivate: true, files: common });
  await commit('gh-alice/odd', { 'hw/common': null, '.gitmodules': '[submodule "hw/common"]\n\tpath = hw/common\n\turl = ../common.git\n', 'hw/common ': null }, 'Drop the folder');
  await commit('gh-alice/odd', { 'hw/common': { submodule: 'gh-alice/common' } }, 'Library as a submodule');
  st = await status(alice, pa);
  eq('the library folder turned into a submodule (reached through a symbolic link): the same files, in sync', [notSynced(st), file(st, 'lib/shared.kicad_sym').submodule, Object.keys(await docsOf(alice, pa)).sort()],
    [{}, 'gh-alice/common', [...A_DOCS, 'lib/fp.pretty/C.kicad_mod'].sort()]);
  check('…still the same online documents', (await docsOf(alice, pa))['lib/shared.kicad_sym'] === docs['lib/shared.kicad_sym']);
  await saveOnline(docs['lib/shared.kicad_sym'], sym(['S', 'T', 'U']));
  r = await push(alice, pa, { message: 'Into the submodule' });
  check('…a change to it is committed to the submodule\'s repository', r.status === 200 && r.j.submodules?.[0]?.repo === 'gh-alice/common' && (await ghFiles('gh-alice/common')).files['lib/shared.kicad_sym'] === sym(['S', 'T', 'U']), JSON.stringify(r.j));
  await pull(alice, pa);
  const back = (await ghFiles('gh-alice/common')).files;
  await commit('gh-alice/odd', { 'hw/common': null, '.gitmodules': null }, 'Drop the submodule');
  await commit('gh-alice/odd', Object.fromEntries(Object.entries(back).map(([p, c]) => ['hw/common/' + p, c])), 'Library as a folder again');
  st = await status(alice, pa);
  eq('…and turned back into a plain folder: in sync again, nothing duplicated', [notSynced(st), file(st, 'lib/shared.kicad_sym').submodule, Object.keys(await docsOf(alice, pa)).length], [{}, undefined, A_DOCS.length + 1]);

  // ============================================================ a project appearing inside the project, and dissolving
  await commit('gh-alice/odd', { 'hw/a/panel/panel.kicad_sch': sch(41) }, 'A sheet in a subfolder');
  await pull(alice, pa);
  docs = await docsOf(alice, pa);
  check('a sheet in a subfolder is part of the project', !!docs['panel/panel.kicad_sch']);
  await commit('gh-alice/odd', { 'hw/a/panel/panel.kicad_pro': pro('panel'), 'hw/a/panel/panel.kicad_pcb': board([]) }, 'The subfolder becomes a project');
  st = await status(alice, pa);
  eq('a project file appearing beside it later takes nothing away: the sheet stays, the new project\'s own files do not come in', [notSynced(st), st.nested], [{}, ['panel']]);
  await commit('gh-alice/odd', { 'hw/a/panel/panel.kicad_sch': sch(41, '\t(text "edited"\n\t\t(at 1 1 0)\n\t\t(uuid "' + uuid(42) + '")\n\t)\n') }, 'Edit the sheet');
  eq('…and it keeps syncing', notSynced(await status(alice, pa)), { 'panel/panel.kicad_sch': 'pull' });
  await pull(alice, pa);
  await commit('gh-alice/odd', { 'hw/a/panel/panel.kicad_pro': null }, 'The inner project dissolves');
  eq('the inner project file deleted: what is left in the folder joins the project as new files', notSynced(await status(alice, pa)), { 'panel/panel.kicad_pcb': 'pull' });
  await pull(alice, pa);

  // ============================================================ line endings, unlink and link again
  await commit('gh-alice/odd', { 'hw/a/a.kicad_sch': (await ghFiles('gh-alice/odd', 'trunk')).files['hw/a/a.kicad_sch'].replace(/\n/g, '\r\n') }, 'CRLF');
  eq('a file re-saved with Windows line endings is a change like any other', notSynced(await status(alice, pa)), { 'a.kicad_sch': 'pull' });
  r = await pull(alice, pa);
  eq('…pulled once, then quiet', [r.status, notSynced(await status(alice, pa))], [200, {}]);
  r = await call(alice, 'DELETE', `/api/projects/${pa}/github`);
  const n = Object.keys(await docsOf(alice, pa)).length;
  r = await call(alice, 'PUT', `/api/projects/${pa}/github`, { repo: 'gh-alice/odd', branch: 'trunk', path: 'hw/a' });
  st = await status(alice, pa);
  eq('unlinked and linked again to the same folder: identical files are simply in sync, nothing doubled', [r.status, notSynced(st), Object.keys(await docsOf(alice, pa)).length], [200, {}, n]);
  await call(alice, 'DELETE', `/api/projects/${pa}/github`);
  docs = await docsOf(alice, pa);
  await saveOnline(docs['a.kicad_pcb'], board([fpItem('R', 31, 140)]));
  await commit('gh-alice/odd', { 'hw/a/sym-lib-table': aTable.replace('(descr "")', '(descr "meanwhile")') }, 'Meanwhile on GitHub');
  await call(alice, 'PUT', `/api/projects/${pa}/github`, { repo: 'gh-alice/odd', branch: 'trunk', path: 'hw/a' });
  st = await status(alice, pa);
  eq('unlinked, edited, and linked again to the same folder: the edit is a push and what changed on GitHub meanwhile a pull, not conflicts', [notSynced(st), st.summary.push, st.summary.conflict], [{ 'a.kicad_pcb': 'push', 'sym-lib-table': 'pull' }, 1, 0]);
  r = await push(alice, pa, { message: 'After linking again' });
  check('…and the push goes through', r.status === 200 && (await ghFiles('gh-alice/odd', 'trunk')).files['hw/a/a.kicad_pcb'] === board([fpItem('R', 31, 140)]), JSON.stringify(r.j));
  await call(alice, 'DELETE', `/api/projects/${pa}/github`);
  await saveOnline(docs['a.kicad_pcb'], board([fpItem('R', 31, 150)]));
  await call(alice, 'PUT', `/api/projects/${pa}/github`, { repo: 'gh-alice/odd', branch: 'trunk', path: 'hw' });
  await call(alice, 'PUT', `/api/projects/${pa}/github`, { repo: 'gh-alice/odd', branch: 'trunk', path: 'hw/a' });
  eq('linked somewhere else in between: what was known is forgotten, so a file that differs is a question again', notSynced(await status(alice, pa))['a.kicad_pcb'], 'conflict');
//BODY
} finally {
  await db.query('DELETE FROM projects WHERE owner_id = ANY($1)', [[aliceId, bobId]]).catch(() => {});
  await db.query('DELETE FROM ops WHERE author_id = ANY($1)', [[aliceId, bobId]]).catch(() => {});
  await db.query('DELETE FROM users WHERE id = ANY($1)', [[aliceId, bobId]]).catch((e) => console.error('cleanup:', e.message));
  await db.end();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
