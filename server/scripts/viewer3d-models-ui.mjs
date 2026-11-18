// The web 3D viewer's models (web/domains/pcb/viewer3d/models.ts, src/kicadlib.rs): a part's own model from KiCad's 3D library,
// the closest library model when its own is not there, one found for a footprint that names none, and a model
// drawn from the footprint itself (src/modelgen) when nothing comes close.  Needs the server to reach KiCad's libraries (or a mirror).
//
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node viewer3d-models-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL, SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000), head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const uid = (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [9803, 'v3d-alice', 'Alice'])).rows[0].id;
await db.query('DELETE FROM projects WHERE owner_id = $1', [uid]);
const jwt = mintJwt(uid, 'v3d-alice');

let n = 0;
const fp = (lib, ref, x, model) => `  (footprint "${lib}" (layer "F.Cu") (uuid "00000000-0000-0000-0000-0000000000${(++n).toString().padStart(2, '0')}") (at ${x} 100)
    (property "Reference" "${ref}" (at 0 -2) (layer "F.SilkS") (uuid "00000000-0000-0000-0000-0000000001${n.toString().padStart(2, '0')}") (effects (font (size 1 1) (thickness 0.15))))
    (attr smd)
    (fp_rect (start -1.5 -0.8) (end 1.5 0.8) (stroke (width 0.05) (type default)) (fill no) (layer "F.CrtYd") (uuid "00000000-0000-0000-0000-0000000002${n.toString().padStart(2, '0')}"))
    (pad "1" smd rect (at -0.8 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (uuid "00000000-0000-0000-0000-0000000003${n.toString().padStart(2, '0')}"))
    (pad "2" smd rect (at 0.8 0) (size 0.9 0.95) (layers "F.Cu" "F.Paste" "F.Mask") (uuid "00000000-0000-0000-0000-0000000004${n.toString().padStart(2, '0')}"))
    ${model ? `(model "\${KICAD10_3DMODEL_DIR}/${model}.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))` : ''}
  )`;
const board = `(kicad_pcb (version 20241229) (generator "pcbnew") (generator_version "9.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (paper "A4")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user "F.Silkscreen") (1 "F.Mask" user) (13 "F.Paste" user) (25 "Edge.Cuts" user) (31 "F.CrtYd" user "F.Courtyard") (35 "F.Fab" user))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
  (gr_rect (start 90 92) (end 130 108) (stroke (width 0.1) (type default)) (fill no) (layer "Edge.Cuts") (uuid "00000000-0000-0000-0000-0000000009ff"))
${fp('Resistor_SMD:R_0603_1608Metric', 'R1', 96, 'Resistor_SMD.3dshapes/R_0603_1608Metric')}
${fp('Custom:R_0603_1608Metric_Pad0.98x0.95mm_HandSolder', 'R2', 104, 'Resistor_SMD.3dshapes/R_0603_1608Metric_Pad0.98x0.95mm_HandSolder')}
${fp('Capacitor_SMD:C_0805_2012Metric', 'C1', 112, '')}
${fp('Custom:Widget_XYZ', 'U1', 120, '')}
)
`;
const dir = fs.mkdtempSync('/tmp/v3d-ui-');
fs.writeFileSync(path.join(dir, 'models.kicad_pcb'), board);
fs.writeFileSync(path.join(dir, 'models.kicad_pro'), JSON.stringify({ meta: { filename: 'models.kicad_pro', version: 3 } }));
execSync(`cd "${dir}" && zip -qr p.zip models.kicad_pro models.kicad_pcb`);
const form = new FormData(); form.append('name', '3D models'); form.append('archive', new Blob([fs.readFileSync(path.join(dir, 'p.zip'))]), 'p.zip');
const res = await fetch(BASE + '/api/projects', { method: 'POST', headers: { Authorization: `Bearer ${jwt}` }, body: form });
const created = await res.json();
const pcb = created.docs && created.docs.find((d) => d.path === 'models.kicad_pcb');
check('project uploaded', res.status === 200 && !!pcb, JSON.stringify(created).slice(0, 200));

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: 'dark' });
const page = await ctx.newPage(); page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
try {
  await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=${encodeURIComponent(`/p/${created.projectId}/edit?doc=${pcb.docId}`)}`);
  await page.waitForFunction(() => { const E = window.CollabEditor; return E && E.kdoc && E.kdoc.items.size > 1 && E.ws && E.ws.readyState === 1 && window.PcbTools; }, null, { timeout: 60000 });
  await page.evaluate(() => window.CollabApp.dispatch({ type: 'action', id: 'show3DViewer' }));
  await page.waitForFunction(() => window.KiCadViewer3D && window.KiCadViewer3D.current && window.KiCadViewer3D.current.viewer && window.KiCadViewer3D.current.viewer.stats, null, { timeout: 60000 });
  await page.evaluate(() => window.KiCadViewer3D.current.viewer.modelsSettled());
  await page.waitForTimeout(800);
  const st = await page.evaluate(() => { const s = window.KiCadViewer3D.current.viewer.stats; return { bodies: s.bodies, models: s.models, missing: s.missingModels, replaced: s.replacedModels, generated: s.generatedModels || [], status: (document.querySelector('.v3d-status') || {}).textContent || '' }; });
  check('four parts are on the board', st.bodies === 4, JSON.stringify(st));
  check('all four show a model: its own, the closest for a missing one, one found for a footprint that names none, one drawn from its footprint', st.models === 4, JSON.stringify(st));
  check('the replaced one is named as such', JSON.stringify(st.replaced.slice().sort()) === JSON.stringify(['R2']), JSON.stringify(st));
  check('a part nothing comes close to gets a model drawn from its footprint', JSON.stringify(st.generated) === JSON.stringify(['U1']), JSON.stringify(st));
  check('the status line says which part was drawn from its footprint', /drawn from the footprint for\s*U1/.test(st.status), st.status);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'viewer3d-models.png') });
  // the references in the status line are links that select the part on the board
  const links = await page.locator('.v3d-status a.v3d-ref').allTextContents();
  check('the status line names R2 and U1 as links', links.includes('R2') && links.includes('U1'), links.join(','));
  await page.locator('.v3d-status a.v3d-ref', { hasText: /^U1$/ }).click();
  const picked = await page.evaluate(() => { const E = window.CollabEditor; const ids = [...(E.selection || [])]; if (E.selected && E.selected.id) ids.push(E.selected.id); const sel = window.PcbTools && window.PcbTools.state && window.PcbTools.state.sel; if (sel) ids.push(...sel); return ids.map((id) => (E.kdoc.items.get(id) || {}).ref).filter(Boolean); });
  check('clicking U1 selects U1 on the board', picked.includes('U1'), JSON.stringify(picked));
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) { check('test ran to the end', false, (e.stack || String(e)) + ' ERRORS ' + errors.join(' | ')); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'viewer3d-models-failure.png') }); }
await browser.close(); await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
