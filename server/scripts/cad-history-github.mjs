// End-to-end test that part studios sync with a GitHub repository as files like any other document, against the
// stand-in GitHub in fake-github.mjs (no real repository is touched): a .jpart comes in with an import, a live
// edit (ops in the journal, no desktop editor to save them) is folded by the server and pushed, a commit on
// GitHub is pulled, and when both sides changed the file the two are merged item by item and path by path.
//
//   FAKE_GH_PORT=8098 node scripts/fake-github.mjs &
//   DATABASE_URL=… JWT_SECRET=testsecret PUBLIC_URL=http://127.0.0.1:8099 PORT=8099 KC_DEV_LOGIN=1 \
//     GITHUB_CLIENT_ID=test GITHUB_CLIENT_SECRET=test GITHUB_API_URL=http://127.0.0.1:8098 GITHUB_WEB_URL=http://127.0.0.1:8098 cargo run
//   E2E_PG_URL=… E2E_JWT_SECRET=testsecret [E2E_BASE=…] [E2E_FAKE_GH=http://127.0.0.1:8098] node scripts/cad-history-github.mjs
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const GH = (process.env.E2E_FAKE_GH || 'http://127.0.0.1:8098').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + String(detail).slice(0, 500) : ''}`); ok ? pass++ : fail++; return ok; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
const sql = (text) => execFileSync('psql', [PG_URL, '-Atc', text], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctl = async (what, body) => (await fetch(`${GH}/__ctl/${what}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
const ghFiles = (repo) => ctl(`files?repo=${encodeURIComponent(repo)}`);
async function call(token, method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* no body */ }
  return { status: r.status, j };
}
async function connect(token) {
  let url = `${BASE}/auth/github/connect?next=/github`, last = null;
  for (let hop = 0; hop < 6; hop++) {
    last = await fetch(url, { redirect: 'manual', headers: url.startsWith(BASE) ? { Cookie: `kc_session=${token}` } : {} });
    if (last.status < 300 || last.status >= 400) break;
    url = new URL(last.headers.get('location'), url).toString();
  }
  return last.status;
}
const status = async (token, id) => (await call(token, 'GET', `/api/projects/${id}/github`)).j;
const states = (st) => Object.fromEntries((st.files || []).map((f) => [f.path, f.state]));
const items = (text) => Object.fromEntries(JSON.parse(text).items.map((i) => [i.id, i]));

/** Edit a document the way a browser tab does: one op over the collaboration socket. */
async function liveEdit(token, docId, changes) {
  const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/ws');
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the edit was not acknowledged')), 10000);
    ws.onerror = reject;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', proto: 1, token, clientId: 'gh-test-' + crypto.randomBytes(3).toString('hex'), linkToken: null, client: 'web' }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'hello_ok') ws.send(JSON.stringify({ type: 'join_doc', docId }));
      if (m.type === 'snapshot') ws.send(JSON.stringify({ type: 'op', docId, clientOpId: 'e' + Date.now(), baseSeq: null, changes }));
      if (m.type === 'ack') { clearTimeout(t); resolve(); }
      if (m.type === 'error') { clearTimeout(t); reject(new Error(JSON.stringify(m))); }
    };
  });
  ws.close();
}
const modified = (id, ...props) => ({ id, kind: 'MODIFIED', typeName: 'feature', props });

const PART = `{"junction":"part-studio","version":1,"items":[
{"featureType":"extrude","id":"ex1","name":"Extrude 1","order":"V","params":{"depth":10,"endType":"blind","flip":false,"operation":"new","profile":{"regions":null,"sketch":"sk1"},"targets":[]},"type":"feature"},
{"featureType":"sketch","id":"sk1","name":"Sketch 1","order":"F","params":{"plane":{"kind":"plane","plane":"top"},"sketch":{"constraints":{},"entities":{"c1":{"center":"pc","r":3,"type":"circle"},"pc":{"type":"point","x":10,"y":10}},"version":1}},"type":"feature"},
{"id":"studio","rollback":null,"type":"studio","units":"mm"}
]}
`;
const line = (uuid, x) => `\t(gr_line\n\t\t(start ${x} 0)\n\t\t(end ${x} 10)\n\t\t(layer "F.SilkS")\n\t\t(uuid "${uuid}")\n\t)\n`;
const board = (a, b) => `(kicad_pcb\n\t(version 20241229)\n\t(generator "pcbnew")\n\t(layers\n\t\t(0 "F.Cu" signal)\n\t)\n${line('11111111-0000-4000-8000-000000000001', a)}${line('11111111-0000-4000-8000-000000000002', b)})\n`;
const PCB = board(1, 2);

try {
  await ctl('reset', {});
  sql(`INSERT INTO users (github_id, login, name) VALUES (990031, 'cad-gh-ada', 'cad-gh-ada') ON CONFLICT (github_id) DO NOTHING`);
  const adaId = Number(sql(`SELECT id FROM users WHERE github_id = 990031`));
  sql(`DELETE FROM github_tokens WHERE user_id = ${adaId}`);
  sql(`DELETE FROM projects WHERE owner_id = ${adaId}`);
  const ada = jwt(adaId, 'cad-gh-ada');
  await ctl('user', { login: 'cad-gh-ada', id: 990031 });
  await ctl('repo', { fullName: 'cad-gh-ada/bracket', isPrivate: true, files: { 'bracket.kicad_pro': '{}', 'bracket.kicad_pcb': PCB, 'Bracket.jpart': PART, 'README.md': '# bracket\n' } });
  await ctl('browser', { login: 'cad-gh-ada' });
  check('the account connects to the stand-in GitHub', await connect(ada) === 200);

  // ---------------------------------------------------------------- import
  let r = await call(ada, 'POST', '/api/github/import', { repo: 'cad-gh-ada/bracket', path: '' });
  check('importing the repository brings the part studio with the KiCad files', r.status === 200 && r.j.files === 3, JSON.stringify(r.j));
  const pid = r.j.projectId;
  const docs = Object.fromEntries((await call(ada, 'GET', `/api/projects/${pid}/info`)).j.docs.map((d) => [d.path, d]));
  check('…as a part studio document', docs['Bracket.jpart'] && docs['Bracket.jpart'].docType === 'part_studio', JSON.stringify(Object.keys(docs)));
  const docId = docs['Bracket.jpart'].docId;
  let st = await status(ada, pid);
  check('a fresh import is in sync, and the part studio is marked as a file that merges', st.summary.synced === 3 && st.files.find((f) => f.path === 'Bracket.jpart').mergeable === true, JSON.stringify(st.summary));

  // ---------------------------------------------------------------- a live edit is folded and pushed
  await liveEdit(ada, docId, [modified('ex1', { path: ['params', 'depth'], value: 25 })]);
  st = await status(ada, pid);
  check('a live edit shows the part studio as changed online', states(st)['Bracket.jpart'] === 'push', JSON.stringify(states(st)));
  r = await call(ada, 'POST', `/api/projects/${pid}/github/push`, { message: 'Deeper plate' });
  check('pushing succeeds', r.status === 200 && r.j.pushed.length === 1, JSON.stringify(r.j));
  let gh = await ghFiles('cad-gh-ada/bracket');
  const pushed = gh.files['Bracket.jpart'];
  check('GitHub has the part studio with the edit folded in, one item per line', items(pushed).ex1.params.depth === 25 && pushed.trim().split('\n').length === 5 && pushed.startsWith('{"junction":"part-studio","version":1,"items":['), pushed.slice(0, 120));
  check('nothing else in the repository changed', gh.files['README.md'] === '# bracket\n' && gh.files['bracket.kicad_pcb'] === PCB && gh.message === 'Deeper plate');
  check('in sync again after the push', (await status(ada, pid)).summary.push === 0);

  // ---------------------------------------------------------------- a commit on GitHub is pulled
  const hole4 = pushed.replace('"r":3', '"r":4');
  await ctl('commit', { fullName: 'cad-gh-ada/bracket', files: { 'Bracket.jpart': hole4 }, message: 'Wider hole', author: 'cad-gh-ada' });
  st = await status(ada, pid);
  const row = st.files.find((f) => f.path === 'Bracket.jpart');
  check('a commit on GitHub shows as a change to pull', row.state === 'pull', JSON.stringify(row).slice(0, 300));
  const diff = (await call(ada, 'GET', `/api/projects/${pid}/github/diff?path=${encodeURIComponent('Bracket.jpart')}`)).j;
  check('…and what changed there is told feature by feature', diff && diff.github && diff.github.total === 1 && diff.github.changes[0].item === 'Sketch 1' && diff.github.changes[0].kind === 'changed' && diff.github.changes[0].parts.join() === 'sketch › entities › c1 › r', JSON.stringify(diff).slice(0, 400));
  r = await call(ada, 'POST', `/api/projects/${pid}/github/pull`, {});
  check('the pull updates the part studio', r.status === 200 && r.j.updated.some((u) => u.path === 'Bracket.jpart' && u.action === 'updated'), JSON.stringify(r.j));
  let now = (await call(ada, 'GET', `/api/docs/${docId}/at/head`)).j;
  check('the document reads as the commit', items(now.file).sk1.params.sketch.entities.c1.r === 4 && items(now.file).ex1.params.depth === 25 && now.ops.every((o) => !o.changes.length));

  // ---------------------------------------------------------------- both sides changed: merged item by item, path by path
  await liveEdit(ada, docId, [modified('ex1', { path: ['params', 'flip'], value: true }), modified('sk1', { path: ['params', 'sketch', 'entities', 'pc', 'x'], value: 12 })]);
  const theirs = hole4.replace('"depth":25', '"depth":40').replace('"name":"Sketch 1"', '"name":"Outline"');
  await ctl('commit', { fullName: 'cad-gh-ada/bracket', files: { 'Bracket.jpart': theirs }, message: 'Deeper still', author: 'cad-gh-ada' });
  st = await status(ada, pid);
  check('changed on both sides: a conflict the server can merge', states(st)['Bracket.jpart'] === 'conflict' && st.files.find((f) => f.path === 'Bracket.jpart').mergeable === true, JSON.stringify(states(st)));
  r = await call(ada, 'POST', `/api/projects/${pid}/github/pull`, {});
  const merged = r.j.updated.find((u) => u.path === 'Bracket.jpart');
  check('the pull merges them with no conflict: different parameters and different entities', r.status === 200 && merged && merged.action === 'merged' && merged.conflicts.length === 0, JSON.stringify(r.j));
  now = items((await call(ada, 'GET', `/api/docs/${docId}/at/head`)).j.file);
  check('the merged part studio has both sides\' work', now.ex1.params.depth === 40 && now.ex1.params.flip === true && now.sk1.name === 'Outline' && now.sk1.params.sketch.entities.pc.x === 12 && now.sk1.params.sketch.entities.c1.r === 4, JSON.stringify(now.ex1.params));
  const versions = (await call(ada, 'GET', `/api/projects/${pid}/versions`)).j.versions;
  check('the document as it was before each pull is kept as a version', versions.filter((v) => /^Before GitHub pull/.test(v.name) && v.docs.some((d) => d.path === 'Bracket.jpart')).length >= 1, versions.map((v) => v.name).join(' | '));
  r = await call(ada, 'POST', `/api/projects/${pid}/github/push`, { message: 'Merged' });
  gh = await ghFiles('cad-gh-ada/bracket');
  check('the merge is pushed back', r.status === 200 && items(gh.files['Bracket.jpart']).ex1.params.flip === true && items(gh.files['Bracket.jpart']).ex1.params.depth === 40, JSON.stringify(r.j));

  // ---------------------------------------------------------------- the same parameter on both sides: one side is preferred, and it is said
  await liveEdit(ada, docId, [modified('ex1', { path: ['params', 'depth'], value: 50 })]);
  await ctl('commit', { fullName: 'cad-gh-ada/bracket', files: { 'Bracket.jpart': gh.files['Bracket.jpart'].replace('"depth":40', '"depth":60') }, message: 'Sixty', author: 'cad-gh-ada' });
  await sleep(200);
  r = await call(ada, 'POST', `/api/projects/${pid}/github/pull`, { prefer: 'github' });
  const again = r.j.updated.find((u) => u.path === 'Bracket.jpart');
  check('a parameter both changed is reported as a conflict, by name', again && again.action === 'merged' && again.conflicts.length === 1 && again.conflicts[0].item === 'Extrude 1 › depth' && again.conflicts[0].kept === 'theirs', JSON.stringify(again));
  check('…and the preferred side wins it', items((await call(ada, 'GET', `/api/docs/${docId}/at/head`)).j.file).ex1.params.depth === 60);

  // ---------------------------------------------------------------- and KiCad's files still merge their own way
  const pcbDoc = docs['bracket.kicad_pcb'].docId;
  const head = Number(sql(`SELECT GREATEST(COALESCE((SELECT MAX(seq) FROM ops WHERE doc_id = '${pcbDoc}'), 0), COALESCE((SELECT MAX(seq) FROM snapshots WHERE doc_id = '${pcbDoc}'), 0))`));
  sql(`INSERT INTO snapshots (doc_id, seq, content) VALUES ('${pcbDoc}', ${head + 1}, convert_to($kc$${board(5, 2)}$kc$, 'UTF8'))`);
  await ctl('commit', { fullName: 'cad-gh-ada/bracket', files: { 'bracket.kicad_pcb': board(1, 7) }, message: 'Move the second line', author: 'cad-gh-ada' });
  r = await call(ada, 'POST', `/api/projects/${pid}/github/pull`, {});
  const pcb = r.j.updated.find((u) => u.path === 'bracket.kicad_pcb');
  const text = await (await fetch(`${BASE}/api/docs/${pcbDoc}/content`, { headers: { Authorization: `Bearer ${ada}` } })).text();
  check('a board changed on both sides is merged as before, by KiCad\'s own rules', pcb && pcb.action === 'merged' && pcb.conflicts.length === 0 && text === board(5, 7), JSON.stringify(pcb));
} catch (e) {
  check('the script ran to the end', false, e.stack || e.message);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
