// Builds the small "rp2040-run-sim" project the simulator shot runs: node sim/build.mjs → out/sim.json { project }
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PG_URL, mintJwt, mcp } from '../lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || path.join(here, '..', 'out');
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false }); await db.connect();
const adaId = (await db.query(`SELECT id FROM users WHERE github_id = -7701`)).rows[0].id;
await db.query(`DELETE FROM projects WHERE owner_id = $1 AND name = 'rp2040-run-sim'`, [adaId]);
// the MCP endpoint takes an access key (Connect an AI assistant), not the session token
const ada = (await (await fetch('http://127.0.0.1:8099/api/mcp/keys', { method: 'POST', headers: { Authorization: `Bearer ${mintJwt(adaId, 'ada')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'demo build', write: true }) })).json()).key;
const project = (await mcp(ada, 'create_project', { name: 'rp2040-run-sim' })).data.project_id;
let r = await mcp(ada, 'run_python', { project, code: fs.readFileSync(path.join(here, 'design.py'), 'utf8'), title: 'RUN pin power-on', live: false, timeout_s: 200 });
while (r.data && r.data.running) r = await mcp(ada, 'get_run', { run_id: r.data.run_id });
console.log(JSON.stringify(r).slice(0, 3000));
if (r.isError || !r.data || !r.data.ok) process.exit(1);
fs.writeFileSync(path.join(OUT, 'sim.json'), JSON.stringify({ project }));
await db.end();
