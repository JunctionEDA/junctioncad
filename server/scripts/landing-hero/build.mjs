// node server/scripts/landing-hero/build.mjs
//
// Designs the board the home page's hero editor shows (an STM32F042 USB-C devboard) the way
// the AI chapter's board is made: the two harness scripts in ./design (the schematic, then
// the board) run through the real MCP endpoint of a local server, and the finished files are
// kept in server/web/platform/landing/hero/.  Server and library mirror as in ../demo-video/README.md.
// Then `node server/scripts/landing-hero/meta.mjs` works out what the hero needs to know about
// the board (parts, connections in routing order, the pile).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { BASE, PG_URL, mintJwt, mcp } from '../demo-video/lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', '..', 'web', 'platform', 'landing', 'hero');
fs.mkdirSync(OUT, { recursive: true });
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const id = (await db.query(`INSERT INTO users (github_id, login, name) VALUES (-7732, 'hero-demo', 'Hero demo') ON CONFLICT (github_id) DO UPDATE SET name = EXCLUDED.name RETURNING id`)).rows[0].id * 1;
const jwt = mintJwt(id, 'hero-demo');
const api = async (p) => { const r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${jwt}` } }); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r; };

await db.query('DELETE FROM projects WHERE owner_id = $1', [id]);
const project = (await mcp(jwt, 'create_project', { name: 'stm32-usbc-devboard' })).data.project_id;
const runs = {};
for (const [file, title] of [['design.py', 'STM32 USB-C devboard schematic'], ['board.py', 'Place and route the board']]) {
  let r = await mcp(jwt, 'run_python', { project, code: fs.readFileSync(path.join(here, 'design', file), 'utf8'), title, live: false, timeout_s: 400 });
  while (r.data && r.data.running) { await new Promise((ok) => setTimeout(ok, 1000)); r = await mcp(jwt, 'get_run', { run_id: r.data.run_id }); }
  if (r.isError || !r.data || !r.data.ok) throw new Error(`${file}: ${r.text.slice(0, 1500)}`);
  runs[file] = String(r.data.output);
  console.log(file + '\n' + runs[file].slice(0, 2500));
}
if (!/\ndrc 0 /.test(runs['board.py']) || !/final unrouted \{\}/.test(runs['board.py'])) throw new Error('the board is not clean: see the output above');
fs.writeFileSync(path.join(here, 'runs.json'), JSON.stringify(runs, null, 1));
await (await api(`/api/projects/${project}/archive`)).arrayBuffer();     // makes the server fold the journals first
for (const type of ['kicad_sch', 'kicad_pcb', 'kicad_pro']) {
  const row = (await db.query('SELECT id FROM documents WHERE project_id = $1 AND doc_type = $2', [project, type])).rows[0];
  if (!row) { console.log('no', type); continue; }
  const text = await (await api(`/api/docs/${row.id}/content`)).text();
  fs.writeFileSync(path.join(OUT, 'stm32.' + type), text);
  console.log(type, text.length, 'bytes');
}
console.log('project', project);
await db.end();
