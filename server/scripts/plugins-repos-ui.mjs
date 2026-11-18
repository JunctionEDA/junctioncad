// Browser test of plugin repositories (Plugin Manager > Catalog > Manage Repositories), as in KiCad's Plugin and
// Content Manager: the catalog has no "Built in" section (the example plugins live in server/plugins/examples), a
// person adds a repository by the address of its repository.json, its plugins join the catalog under its name with
// their icons, one installs through the consent sheet with the repository as its source, and removing the repository
// keeps what was installed.  Addresses that are not repositories are refused with the reason.
//
// This test serves KiCad's stand-in repository on 8096 and a second repository on 8095.
// Server: KC_DEV_LOGIN=1 KC_PLUGIN_NETWORK=test KC_PCM_REPOSITORY=http://127.0.0.1:8096/repository.json
//   E2E_PG_URL=… E2E_JWT_SECRET=… [SHOTS=/some/dir] node plugins-repos-ui.mjs
//
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import pg from 'pg';

const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = (process.env.E2E_BASE || 'http://127.0.0.1:8099').replace(/\/$/, '');
const SECRET = process.env.E2E_JWT_SECRET, PG_URL = process.env.E2E_PG_URL;
const SHOTS = process.env.SHOTS || '';
if (!SECRET || !PG_URL) { console.error('E2E_JWT_SECRET and E2E_PG_URL are required.'); process.exit(2); }
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(sub, login) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' }), body = b64({ sub, login, iat: now, exp: now + 3600 });
  return `${head}.${body}.${crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
}

/** A zip archive (stored, no compression) of {name: Buffer}. */
function zip(files) {
  const parts = [], central = []; let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const n = Buffer.from(name), crc = zlib.crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n); offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
function png(size, rgb) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0); return Buffer.concat([len, body, crc]); };
  const head = Buffer.alloc(13); head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4); head[8] = 8; head[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from(rgb)))]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

/** A KiCad-format repository served at http://127.0.0.1:<port>: repository.json, packages.json, resources.zip, zips. */
function repository(port, name, plugins) {
  const base = `http://127.0.0.1:${port}`; const zips = {}; const icons = {};
  const packages = plugins.map((p) => {
    const meta = { $schema: 'https://go.kicad.org/pcm/schemas/v1', name: p.name, description: p.description, description_full: p.description, identifier: p.id, type: 'plugin', author: { name: p.author, contact: {} }, license: 'MIT', resources: {}, versions: [{ version: p.version, status: 'stable', kicad_version: '8.0' }] };
    const body = zip({ 'metadata.json': Buffer.from(JSON.stringify(meta)), 'plugins/__init__.py': Buffer.from('from .tool import *\n'), 'plugins/tool.py': Buffer.from(`import pcbnew\n\nclass Tool(pcbnew.ActionPlugin):\n    def defaults(self):\n        self.name = ${JSON.stringify(p.name)}\n        self.category = "Test"\n        self.description = ${JSON.stringify(p.description)}\n    def Run(self):\n        pass\n\nTool().register()\n`) });
    zips[`${p.id}.zip`] = body; if (p.icon) icons[`${p.id}/icon.png`] = png(64, p.icon);
    return Object.assign(meta, { versions: [Object.assign(meta.versions[0], { download_url: `${base}/zips/${p.id}.zip`, download_sha256: crypto.createHash('sha256').update(body).digest('hex'), download_size: body.length, install_size: body.length })] });
  });
  // a theme and a library are in KiCad repositories too; the web catalog lists plugins only
  packages.push({ name: 'A colour theme', description: 'not a plugin', identifier: `${name}.theme`.replace(/\s/g, ''), type: 'colortheme', author: { name: 'x' }, license: 'MIT', versions: [{ version: '1', status: 'stable', kicad_version: '8.0', download_url: `${base}/none.zip` }] });
  const list = Buffer.from(JSON.stringify({ packages })); const resources = zip(icons);
  const repo = JSON.stringify({ $schema: 'https://go.kicad.org/pcm/schemas/v1#/definitions/Repository', name, maintainer: { name: `${name} maintainers`, contact: {} },
    packages: { url: name === 'KiCad stand-in' ? `${base}/packages.json` : 'packages.json', sha256: crypto.createHash('sha256').update(list).digest('hex'), update_timestamp: 1767225600 },
    resources: { url: `${base}/resources.zip`, sha256: crypto.createHash('sha256').update(resources).digest('hex'), update_timestamp: 1767225600 } });
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/repository.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(repo); return; }
    // the same repository behind a redirect, as a GitHub "raw" or release link often is
    if (url === '/moved/repository.json') { res.writeHead(302, { location: '/repository.json' }); res.end(); return; }
    if (url === '/packages.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(list); return; }
    if (url === '/resources.zip') { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(resources); return; }
    if (url === '/not-json') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>hello</html>'); return; }
    if (url === '/no-packages.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"name":"x"}'); return; }
    const z = url.startsWith('/zips/') ? zips[url.slice(6)] : null;
    if (z) { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(z); return; }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', () => ok({ server, url: `${base}/repository.json`, base })); });
}

const kicadRepo = await repository(8096, 'KiCad stand-in', [{ id: 'org.kicad.test.official', name: 'Official Tool', description: 'From the stand-in for KiCad\'s repository.', author: 'KiCad', version: '1.0' }]);
const other = await repository(8095, 'Acme Plugins', [
  { id: 'com.acme.panelizer', name: 'Acme Panelizer', description: 'Panelizes the board.', author: 'Acme', version: '2.1.0', icon: [200, 90, 40] },
  { id: 'com.acme.teardrops', name: 'Acme Teardrops', description: 'Adds teardrops.', author: 'Acme', version: '0.9' },
]);

pg.types.setTypeParser(20, (v) => parseInt(v, 10));
const db = new pg.Client({ connectionString: PG_URL, ssl: false });
await db.connect();
async function user(githubId, login) {
  return (await db.query(`INSERT INTO users (github_id, login, name) VALUES ($1, $2, $2) ON CONFLICT (github_id) DO UPDATE SET login = EXCLUDED.login RETURNING id`, [githubId, login])).rows[0].id;
}
const rae = await user(9501, 'repo-rae'), sam = await user(9502, 'repo-sam');
await db.query('DELETE FROM plugins WHERE user_id = ANY($1)', [[rae, sam]]);
await db.query('DELETE FROM plugin_repositories WHERE user_id = ANY($1)', [[rae, sam]]);
await db.query('DELETE FROM projects WHERE owner_id = $1', [rae]);
const projectId = (await db.query(`INSERT INTO projects (owner_id, name) VALUES ($1, 'repos') RETURNING id`, [rae])).rows[0].id;
const demo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../demos/ecc83');
const docId = (await db.query(`INSERT INTO documents (project_id, path, doc_type) VALUES ($1, 'ecc83-pp.kicad_pcb', 'kicad_pcb') RETURNING id`, [projectId])).rows[0].id;
await db.query('INSERT INTO snapshots (doc_id, seq, content) VALUES ($1, 0, $2)', [docId, fs.readFileSync(path.join(demo, 'ecc83-pp.kicad_pcb'))]);

const call = (method, url, token, body) => fetch(`${BASE}${url}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
const tRae = mintJwt(rae, 'repo-rae'), tSam = mintJwt(sam, 'repo-sam');

// ---------------------------------------------------------------- the API
let r = await call('POST', '/api/plugins/repositories', tRae, { url: `${other.base}/not-json` });
check('an address that is not JSON is refused with the reason', r.status === 400 && /not JSON/.test((await r.json()).message || ''));
r = await call('POST', '/api/plugins/repositories', tRae, { url: `${other.base}/no-packages.json` });
check('a JSON file that is not a repository is refused with the reason', r.status === 400 && /names no package list/.test((await r.json()).message || ''));
r = await call('POST', '/api/plugins/repositories', tRae, { url: 'ftp://example.com/repository.json' });
check('only https (here: the test server) addresses are read', r.status === 400);
r = await call('POST', '/api/plugins/repositories', tRae, { url: 'https://repository.kicad.org/repository.json' });
check("KiCad's official repository cannot be added twice", r.status === 400);
check('nothing was kept for those', (await db.query('SELECT count(*)::int AS n FROM plugin_repositories WHERE user_id = $1', [rae])).rows[0].n === 0);
r = await call('POST', '/api/plugins/repositories', tSam, { url: `${other.base}/moved/repository.json` });
const samRepo = await r.json();
check('a repository behind a redirect is followed', r.ok && samRepo.name === 'Acme Plugins' && samRepo.plugins === 2, JSON.stringify(samRepo));
r = await call('GET', `/api/plugins/repositories/${samRepo.id}/plugins`, tRae);
check("one person cannot read another's repository", r.status === 404);
r = await call('DELETE', `/api/plugins/repositories/${samRepo.id}`, tRae);
check("nor remove it", (await r.json()).removed === false && (await db.query('SELECT count(*)::int AS n FROM plugin_repositories WHERE id = $1', [samRepo.id])).rows[0].n === 1);

// ---------------------------------------------------------------- the catalog
const browser = await chromium.launch();
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: SHOTS ? 2 : 1, colorScheme: 'light' });
const a = await ctx.newPage();
a.on('pageerror', (e) => errors.push(String(e)));
await a.goto(`${BASE}/auth/dev?jwt=${tRae}&next=${encodeURIComponent(`/p/${projectId}/edit?doc=${docId}`)}`);
await a.waitForFunction(() => window.CollabEditor && window.CollabEditor.kdoc && window.KcPlugins, null, { timeout: 30000 });
await a.evaluate(() => window.KcPlugins.openManager());
await a.waitForSelector('#pluginCatalog');
check('the Plugin Manager opens on the Catalog', await a.locator('#pluginManager [data-tab="catalog"].on').count() === 1);
await a.waitForSelector('#pluginCatalog .plg-card[data-source="kicad"]');
const chips = await a.locator('#pluginCatalog [data-source-filter]').evaluateAll((els) => els.map((e) => e.getAttribute('data-source-filter')));
check('there is no Built in section', !chips.includes('builtin') && (await a.locator('#pluginCatalog .plg-card[data-source="builtin"]').count()) === 0, chips.join(','));
check('the filters are All, KiCad and Community before a repository is added', chips.join(',') === 'all,kicad,community', chips.join(','));
const shot = async (name) => { if (SHOTS) await a.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
await shot('01-catalog');

await a.click('#pluginManageRepos');
await a.waitForSelector('#pluginRepos');
check('Manage Repositories lists KiCad\'s official repository', /KiCad official repository/.test(await a.locator('#pluginReposTable').innerText()));
await a.fill('#pluginRepoUrl', `${other.base}/not-json`); await a.click('#pluginRepoAdd');
await a.waitForSelector('#pluginRepoErr');
check('a wrong address says why in the dialog', /not JSON/.test(await a.locator('#pluginRepoErr').innerText()));
await a.fill('#pluginRepoUrl', other.url); await a.click('#pluginRepoAdd');
await a.waitForSelector('#pluginReposTable tr[data-repo]:not([data-repo="kicad"])');
check('the added repository is listed by its name', /Acme Plugins/.test(await a.locator('#pluginReposTable').innerText()) && (await a.inputValue('#pluginRepoUrl')) === '');
await shot('02-manage-repositories');
await a.keyboard.press('Escape');
await a.waitForSelector('#pluginRepos', { state: 'detached' });
check('Escape closes Manage Repositories and leaves the manager open', await a.locator('#pluginManager').isVisible());
const row = await db.query('SELECT id, name, maintainer FROM plugin_repositories WHERE user_id = $1', [rae]);
check('the repository is kept with the account', row.rows.length === 1 && row.rows[0].name === 'Acme Plugins' && row.rows[0].maintainer === 'Acme Plugins maintainers');
const repoId = row.rows[0].id;

await a.waitForSelector('#pluginCatalog .plg-card[data-source="repo"]');
const cards = await a.locator('#pluginCatalog .plg-card[data-source="repo"]').count();
check('its plugins join the catalog (plugins only, not themes)', cards === 2, String(cards));
check('a filter chip carries its name', (await a.locator(`#pluginCatalog [data-source-filter="repo:${repoId}"]`).innerText()).startsWith('Acme Plugins'));
const names = await a.locator('#pluginCatalog .plg-card b').allInnerTexts();
check('the catalog stays one list in name order', names.every((n, i) => i === 0 || names[i - 1].localeCompare(n) <= 0) && names.includes('Official Tool'), names.join(' | '));
await a.click(`#pluginCatalog [data-source-filter="repo:${repoId}"]`);
check('its filter shows only its plugins', (await a.locator('#pluginCatalog .plg-card').count()) === 2 && (await a.locator('#pluginCatalog .plg-card[data-source="kicad"]').count()) === 0);
check('the note names the repository and its maintainer', /Acme Plugins maintainers/.test(await a.locator('#pluginCatalog .plg-source-note').innerText()));
// the icon comes from the repository's resources archive (fetched in the background)
await a.waitForFunction(() => { const img = document.querySelector('#pluginCatalog .plg-card[data-plugin="com.acme.panelizer"] img.plg-icon'); return img && img.complete && img.naturalWidth > 0; }, null, { timeout: 40000 }).catch(() => {});
check('a plugin shows the icon its repository has for it', await a.locator('#pluginCatalog .plg-card[data-plugin="com.acme.panelizer"] img.plg-icon').evaluate((i) => i.naturalWidth === 64).catch(() => false));
await a.fill('#pluginSearch', 'teardrop');
check('search covers the repository', (await a.locator('#pluginCatalog .plg-card').count()) === 1);
await a.fill('#pluginSearch', '');
await shot('03-repository-filter');

await a.click('#pluginCatalog [data-install="com.acme.panelizer"]');
await a.waitForSelector('#pluginConsent');
check('installing shows the consent sheet naming the repository', /the repository "Acme Plugins", version 2\.1\.0/.test(await a.locator('#pluginConsent').innerText()));
await shot('04-consent');
await a.click('#pluginConsentOk');
await a.waitForFunction(() => window.KcPlugins.store.get().installed.some((p) => p.identifier === 'com.acme.panelizer'));
const inst = (await db.query('SELECT source FROM plugins WHERE user_id = $1 AND identifier = $2', [rae, 'com.acme.panelizer'])).rows[0];
check('it is installed with the repository as its source', inst && inst.source === `repo:${repoId}:2.1.0`, JSON.stringify(inst));

await a.click('#pluginManager [data-tab="catalog"]');
await a.click('#pluginManageRepos'); await a.waitForSelector('#pluginRepos');
await a.click(`#pluginRepos [data-remove-repo="${repoId}"]`);
await a.locator('.kd-dialog button', { hasText: /^Remove$/ }).last().click();
await a.waitForSelector(`#pluginReposTable tr[data-repo="${repoId}"]`, { state: 'detached' });
check('removing the repository takes it out of the account', (await db.query('SELECT count(*)::int AS n FROM plugin_repositories WHERE user_id = $1', [rae])).rows[0].n === 0);
await a.click('#pluginReposClose');
check('its plugins leave the catalog', (await a.locator('#pluginCatalog .plg-card[data-source="repo"]').count()) === 0 && (await a.locator('#pluginCatalog [data-source-filter^="repo:"]').count()) === 0);
check('what was installed from it stays', (await db.query('SELECT count(*)::int AS n FROM plugins WHERE user_id = $1 AND identifier = $2', [rae, 'com.acme.panelizer'])).rows[0].n === 1);

// dark theme picture of the dialog
await a.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await a.click('#pluginManageRepos'); await a.waitForSelector('#pluginRepos');
await a.fill('#pluginRepoUrl', other.url); await a.click('#pluginRepoAdd');
await a.waitForSelector('#pluginReposTable tr[data-repo]:not([data-repo="kicad"])');
await shot('05-manage-repositories-dark');
await a.click('#pluginReposClose');

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close(); await db.end(); kicadRepo.server.close(); other.server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
