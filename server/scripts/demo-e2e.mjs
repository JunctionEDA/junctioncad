// The Devboard Demo a new account starts with (src/demo.rs), through the real sign-in flow against the
// stand-in GitHub (fake-github.mjs):
//   node scripts/fake-github.mjs &
//   GITHUB_API_URL=http://127.0.0.1:8098 GITHUB_WEB_URL=http://127.0.0.1:8098 GITHUB_CLIENT_ID=x GITHUB_CLIENT_SECRET=y \
//     KC_DEV_LOGIN=1 … ./target/debug/kicad-collab-server &
//   E2E_BASE=http://127.0.0.1:8099 node scripts/demo-e2e.mjs
// Checks: a new account gets exactly one private "Devboard Demo" holding the whole seed, signing in again (also
// two sign-ins at once) adds nothing, another account cannot open it, and every stored file equals the seed.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8099';
const FAKE = process.env.FAKE_GH || 'http://127.0.0.1:8098';
const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed', 'devboard-demo.zip');
let failed = 0, passed = 0;
const check = (name, ok, detail = '') => { if (ok) passed++; else failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' ' + detail}`); };

/** The seed's files, read with the zip's central directory (no dependencies). */
function seedFiles() {
  const z = fs.readFileSync(SEED);
  let eocd = z.length - 22; while (z.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let at = z.readUInt32LE(eocd + 16); const n = z.readUInt16LE(eocd + 10); const out = new Map();
  for (let i = 0; i < n; i++) {
    const method = z.readUInt16LE(at + 10), packed = z.readUInt32LE(at + 20), nameLen = z.readUInt16LE(at + 28);
    const extra = z.readUInt16LE(at + 30), comment = z.readUInt16LE(at + 32), local = z.readUInt32LE(at + 42);
    const name = z.toString('utf8', at + 46, at + 46 + nameLen);
    const data = local + 30 + z.readUInt16LE(local + 26) + z.readUInt16LE(local + 28);
    const raw = z.subarray(data, data + packed);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : raw);
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

/** Sign in through /auth/github/login as `login` on the stand-in GitHub; returns the session cookie. */
async function signIn(login) {
  await fetch(`${FAKE}/__ctl/browser`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login }) });
  let url = `${BASE}/auth/github/login?next=/`, cookies = {}, res;
  for (let i = 0; i < 8; i++) {
    const own = url.startsWith(BASE);
    res = await fetch(url, { redirect: 'manual', headers: own ? { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') } : {} });
    if (own) for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const k = kv.split('=')[0]; cookies[k] = kv.slice(k.length + 1); }
    if (res.status < 300 || res.status >= 400) break;
    url = new URL(res.headers.get('location'), url).toString();
    if (url.startsWith(BASE) && !url.includes('/auth/')) break;
  }
  return cookies.kc_session;
}
const api = async (session, p) => { const r = await fetch(`${BASE}${p}`, { headers: { Cookie: `kc_session=${session}` } }); return { status: r.status, j: await r.json().catch(() => null), r }; };
const demos = async (s) => ((await api(s, '/api/projects')).j?.projects || []).filter((p) => p.name === 'Devboard Demo');

const stamp = Date.now().toString(36);
const all = seedFiles();
// fonts/<face>/<file> become the project's fonts, everything else a project file
const seed = new Map([...all].filter(([p]) => !p.startsWith('fonts/')));
const faces = [...all.keys()].filter((p) => p.startsWith('fonts/')).map((p) => p.split('/')[1]);
const t0 = Date.now();
const alice = await signIn(`demo-alice-${stamp}`);
const signInMs = Date.now() - t0;
check('a new account signs in', !!alice);
let mine = await demos(alice);
check('it has one Devboard Demo', mine.length === 1, JSON.stringify(mine));
const demo = mine[0] || {};
check('the demo is private and its own', demo.public === false && demo.ownerLogin === `demo-alice-${stamp}` && demo.memberCount === 0, JSON.stringify(demo));
check('the demo holds every seed file', demo.docCount === seed.size, `${demo.docCount} of ${seed.size}`);
console.log(`     first sign-in with the copy took ${signInMs} ms`);

const info = await api(alice, `/api/projects/${demo.projectId}`);
const docs = info.j?.docs || info.j?.documents || [];
check('project answers with its documents', info.status === 200 && docs.length === seed.size, `${info.status} ${docs.length}`);
let same = 0; const differ = [];
for (const d of docs) {
  const r = await fetch(`${BASE}/api/docs/${d.docId || d.id}/content`, { headers: { Cookie: `kc_session=${alice}` } });
  const got = Buffer.from(await r.arrayBuffer());
  const want = seed.get(d.path);
  if (want && got.equals(want)) same++; else differ.push(`${d.path} ${r.status} ${got.length}/${want?.length}`);
}
check('every stored file equals the seed', same === seed.size, differ.slice(0, 5).join(', '));
const types = Object.fromEntries(docs.map((d) => [d.path, d.docType || d.doc_type]));
check('board, schematic, libraries and models are typed', types['Devboard_Demo.kicad_pcb'] === 'kicad_pcb' && types['Devboard_Demo.kicad_sch'] === 'kicad_sch'
  && types['lib/lcsc.kicad_sym'] === 'symbol_lib' && types['fp-lib-table'] === 'lib_table'
  && Object.entries(types).some(([p, t]) => p.endsWith('.step') && t === 'model3d')
  && Object.entries(types).some(([p, t]) => p.endsWith('.kicad_mod') && t === 'footprint'), JSON.stringify(types).slice(0, 300));

const fonts = await api(alice, `/api/projects/${demo.projectId}/fonts`);
check('the fonts the text uses come with it', fonts.status === 200 && faces.length === 2 && faces.every((f) => JSON.stringify(fonts.j).includes(f)), JSON.stringify(fonts.j).slice(0, 300));
for (const face of faces) {
  const r = await fetch(`${BASE}/api/projects/${demo.projectId}/fonts/file?family=${encodeURIComponent(face)}&exact=1`, { headers: { Cookie: `kc_session=${alice}` } });
  const got = Buffer.from(await r.arrayBuffer());
  check(`the ${face} font file is served`, r.status === 200 && got.equals(all.get([...all.keys()].find((p) => p.startsWith(`fonts/${face}/`)))), `${r.status} ${got.length}`);
}

const again = await signIn(`demo-alice-${stamp}`);
check('signing in again adds no second copy', !!again && (await demos(again)).length === 1);
const t1 = Date.now();
await signIn(`demo-alice-${stamp}`);
check('a later sign-in is not slowed', Date.now() - t1 < Math.max(1500, signInMs), `${Date.now() - t1} ms`);

// Two first sign-ins of one new account at the same moment.
const bob = `demo-bob-${stamp}`;
const [b1, b2] = await Promise.all([signIn(bob), signIn(bob)]);
check('two sign-ins at once make one copy', (await demos(b1 || b2)).length === 1, JSON.stringify(await demos(b1 || b2)));

const bobDemo = (await demos(b1 || b2))[0];
check('each account has its own copy', bobDemo && bobDemo.projectId !== demo.projectId);
const peek = await api(b1 || b2, `/api/projects/${demo.projectId}`);
check("another account cannot open someone's demo", peek.status === 403 || peek.status === 404, `${peek.status}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
