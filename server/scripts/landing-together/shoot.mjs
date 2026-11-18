// node server/scripts/landing-together/shoot.mjs [outDir]
//
// The two pictures of the home page's "Working together" section: the real web editor on the home
// page's STM32 board (web/platform/landing/hero), three people in it.  The pictures are Ada's window: Jun has a
// part selected, Mara's pointer is on the sheet, and there is a comment thread pinned to a part.
// Server and library mirror as in ../demo-video/README.md.  Writes together-pcb.png and
// together-sch.png into outDir (default /tmp); they become static/landing/{board,schematic}.webp.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pg from 'pg';
import { BASE, PG_URL, mintJwt, upload, share } from '../demo-video/lib.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const HERO = path.join(here, '..', '..', 'web', 'platform', 'landing', 'hero');
const OUT = process.argv[2] || '/tmp';
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
const mk = async (gh, login, name) => (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $3) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login, name = EXCLUDED.name RETURNING id`, [gh, login, name])).rows[0].id * 1;
const who = {};
for (const [gh, login, name] of [[-7741, 'ada', 'Ada'], [-7742, 'jun', 'Jun'], [-7743, 'mara', 'Mara']]) { const id = await mk(gh, login, name); who[login] = mintJwt(id, login); await db.query('DELETE FROM projects WHERE owner_id = $1', [id]); }
const made = await upload(who.ada, 'stm32-usbc-devboard', ['kicad_pro', 'kicad_sch', 'kicad_pcb'].map((e) => [`stm32-usbc-devboard.${e}`, fs.readFileSync(path.join(HERO, `stm32.${e}`))]));
await share(who.ada, made.projectId, who.jun); await share(who.ada, made.projectId, who.mara);
const pcb = made.docs.find((d) => d.docType === 'kicad_pcb'), sch = made.docs.find((d) => d.docType === 'kicad_sch');

const browser = await chromium.launch();
async function open(jwt, doc, scale) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: scale, colorScheme: 'dark' });
  const page = await ctx.newPage(); page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`${BASE}/auth/dev?jwt=${jwt}&next=${encodeURIComponent(`/p/${made.projectId}/edit?doc=${doc.docId}`)}`);
  await page.waitForFunction(() => { const E = window.CollabEditor; return E && E.kdoc && E.kdoc.items.size > 1 && E.ws && E.ws.readyState === 1; }, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  return page;
}
const scr = (page, x, y) => page.evaluate(([x, y]) => {
  const E = window.CollabEditor, r = document.querySelector('#world').getBoundingClientRect();
  const w = E.vb[2] / E.vbPerMm, h = E.vb[3] / E.vbPerMm;
  return [r.left + (x - E.vb[0] / E.vbPerMm) / w * r.width, r.top + (y - E.vb[1] / E.vbPerMm) / h * r.height];
}, [x, y]);
const part = (page, ref) => page.evaluate((ref) => {
  for (const it of window.CollabEditor.kdoc.items.values()) if ((it.kind === 'footprint' || it.kind === 'symbol') && it.ref === ref) return { id: it.id, x: it.x, y: it.y, bbox: it.bbox };
  return null;
}, ref);
const mid = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const comment = async (doc, id, label, at, body, unit) => {
  const r = await fetch(`${BASE}/api/docs/${doc.docId}/comments`, { method: 'POST', headers: { Authorization: `Bearer ${who.mara}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ x: Math.round(at[0] * unit), y: Math.round(at[1] * unit), body, anchor: { kind: 'item', id, label } }) });
  if (!r.ok) throw new Error('comment: ' + r.status + ' ' + await r.text());
};

for (const [doc, name, sel, hover, note, unit] of [
  [pcb, 'together-pcb', 'U3', 'SW2', ['C4', 'Is 4.7 uF enough for the regulator output, or should this be 10 uF?'], 1e6],
  [sch, 'together-sch', 'U1', 'J1', ['R3', 'BOOT0 is pulled down here, so the board starts from flash. Good.'], 1e4],
]) {
  const ada = await open(who.ada, doc, 2), jun = await open(who.jun, doc, 1), mara = await open(who.mara, doc, 1);
  const c = await part(ada, note[0]);
  await comment(doc, c.id, note[0], mid(c.bbox), note[1], unit);
  // Jun clicks a part and rests beside it; Mara points somewhere else
  const s = await part(jun, sel), [sx, sy] = await scr(jun, ...mid(s.bbox));
  await jun.mouse.move(sx - 40, sy - 30, { steps: 6 }); await jun.mouse.click(sx, sy); await jun.mouse.move(sx + 26, sy + 22, { steps: 6 });
  const h = await part(mara, hover), [hx, hy] = await scr(mara, ...mid(h.bbox));
  await mara.mouse.move(hx - 60, hy, { steps: 5 }); await mara.mouse.move(hx + 14, hy + 10, { steps: 8 });
  if (doc === sch) {   // the sheet is A3 and mostly empty: closer in on the blocks, the way someone reading it would have it
    await ada.mouse.move(800, 300); for (let i = 0; i < 2; i++) { await ada.mouse.wheel(0, -120); await ada.waitForTimeout(250); }
    await ada.mouse.down({ button: 'middle' }); await ada.mouse.move(900, 400, { steps: 8 }); await ada.mouse.up({ button: 'middle' });
  }
  await ada.mouse.move(1200, 760);
  await ada.waitForTimeout(2500);
  await ada.screenshot({ path: path.join(OUT, name + '.png') });
  console.log(name, 'selected', sel, 'by Jun; comment on', note[0]);
  for (const p of [ada, jun, mara]) await p.context().close();
}
await browser.close(); await db.end();
