// usage: SWEEP_TOKEN=… [SWEEP_SERVER=…] node webedit.mjs <projectId>
// One real edit from the web editor in every schematic and board of the project (a part is moved),
// then an archive download, which folds the edits into the stored files.  Needs playwright-core
// and an installed Chrome.  KiCadCanvas.moveItem takes an absolute position, so the part does move.
import { chromium } from 'playwright-core';
const BASE = (process.env.SWEEP_SERVER || 'http://127.0.0.1:8125').replace(/\/$/, ''), token = process.env.SWEEP_TOKEN, pid = process.argv[2];
const auth = { authorization: `Bearer ${token}` };
const info = await (await fetch(`${BASE}/api/projects/${pid}/info`, { headers: auth })).json();
const browser = await chromium.launch({ channel: 'chrome', headless: true }); const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const p0 = await ctx.newPage(); await p0.goto(`${BASE}/auth/dev?jwt=${token}&next=/api/me`); await p0.close();
const out = [];
for (const d of info.docs.filter((d) => d.docType === 'kicad_sch' || d.docType === 'kicad_pcb')) {
  const r = { path: d.path, errors: [] }; const p = await ctx.newPage(); p.on('pageerror', (e) => r.errors.push(e.message.slice(0, 200)));
  try {
    await p.goto(`${BASE}/p/${pid}/edit?doc=${d.docId}`);
    await p.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.CollabEditor.joinedDocId && window.CollabEditor.lastSeq !== undefined, null, { timeout: 60000 });
    await p.waitForTimeout(600);
    r.edit = await p.evaluate(async (kind) => {
      const E = window.CollabEditor, K = window.KiCadCanvas; const it = [...E.kdoc.items.values()].find((i) => i.kind === kind && !i.id.startsWith('anon-'));
      if (!it) return { items: E.kdoc.items.size, moved: null };
      for (const dx of [1.27, -1.27]) { K.moveItem(E.kdoc, E.kdoc.items.get(it.id), dx, 0); E.api.commitChanges([K.replaceChange(E.kdoc, E.kdoc.items.get(it.id))], 'nudge'); await new Promise((r) => setTimeout(r, 400)); }
      return { items: E.kdoc.items.size, moved: it.id };
    }, d.docType === 'kicad_sch' ? 'symbol' : 'footprint');
    await p.waitForTimeout(1200);
    r.pending = await p.evaluate(() => window.CollabEditor.pendingOps.size);
  } catch (e) { r.errors.push(String(e).slice(0, 300)); }
  await p.close(); out.push(r);
}
await browser.close();
const zip = await fetch(`${BASE}/api/projects/${pid}/archive`, { headers: auth }); await zip.arrayBuffer();
console.log(JSON.stringify({ archive: zip.status, docs: out }));
