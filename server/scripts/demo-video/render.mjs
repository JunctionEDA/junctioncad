// Turns the footage in out/ into the demo video: builds the timeline (which take, which part of it,
// how fast, which caption), has compose.html draw every frame in a browser, and encodes with ffmpeg.
// Numbers in the captions are read from what the recorded runs returned (out/state.json), not typed in.
//
//   node render.mjs [--stills] [--music piece.wav [--from-start]] [--out name]   → out/<name>.mp4 (default junction-demo) and its poster
//   --music: the soundtrack; every cut lands on one of its beats (beats.py), and by default the piece is started so its
//   closing chord comes with the end card (--from-start: from its beginning); --measures: each feature fills whole bars,
//   sped up to fit, and every cut falls on a bar line
//
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || path.join(here, 'out');
const FPS = 30;
const state = JSON.parse(fs.readFileSync(path.join(OUT, 'state.json'), 'utf8'));
const take = (name) => { const dir = path.join(OUT, name); const m = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8')); return { dir: pathToFileURL(dir).href, ...m }; };
// when the drawing first changes in a take: the first photograph whose JPEG is noticeably larger than the opening one
const firstChange = (name, after) => { const dir = path.join(OUT, name); const m = JSON.parse(fs.readFileSync(path.join(dir, 'frames.json'), 'utf8')); const size = (f) => fs.statSync(path.join(dir, f.file)).size; const base = size(m.frames[0]);
  const hit = m.frames.find((f) => f.t >= after && size(f) > base * 1.03); return hit ? hit.t : after; };
const num = (text, re) => { const m = re.exec(text || ''); if (!m) throw new Error(`a caption number is missing: ${re}`); return m.slice(1); };

const ONE = { x: 160, y: 50, w: 1600, h: 900 };
const scenes = []; let at = 0;
const add = (s) => { s.start = +at.toFixed(3); at += s.length; scenes.push(s); return s; };
// a stretch [from, to] of a take, shown for `show` seconds (so its speed is what it has to be)
// several windows of one take, each with its own place on screen (and where it slides from): wins [{ dir, x, y, w, h, from, label, toasts }]
function multi(name, { from, to, show, captions, cutIn, cutOut, wins }) {
  const windows = wins.map((w) => { const t = take(w.dir ? `${name}/${w.dir}` : name); return { ...w, dir: t.dir, frames: t.frames }; });
  const speed = (to - from) / show;
  return add({ kind: 'footage', name, from, speed: +speed.toFixed(3), length: show, windows, cutIn: !!cutIn, cutOut: !!cutOut,
    captions: captions.map((c, i) => ({ text: c, at: (show * i) / captions.length, until: (show * (i + 1)) / captions.length })) });
}
function footage(name, { from, to, show, captions, split, cutIn, cutOut, chat, toasts, zoom, follows }) {
  const takes = split ? split.map((s) => take(`${name}/${s.dir}`)) : [take(name)];
  from = from ?? 0; to = to ?? takes[0].length;
  const windows = split
    ? takes.map((t, i) => ({ x: 10 + i * 956, y: 110, w: 944, h: 800, dir: t.dir, frames: t.frames, label: split[i].label, chat: split[i].chat }))
    : [{ ...ONE, dir: takes[0].dir, frames: takes[0].frames, chat, toasts, zoom: zoom && zoom.s !== 1 ? zoom : null, follows }];
  const speed = (to - from) / show;
  // cutIn / cutOut: this stretch continues the one before / after it (same take, another speed), so no fade there
  return add({ kind: 'footage', name, from, speed: +speed.toFixed(3), length: show, windows, cutIn: !!cutIn, cutOut: !!cutOut,
    captions: captions.map((c, i) => ({ text: c, at: (show * i) / captions.length, until: (show * (i + 1)) / captions.length })) });
}

const S = state.schematic, AI = state.ai, R = state.route, H = state.history;
const COL = { ben: '#2a9d63', maya: '#9a63d1', dev: '#1f9fb8', ada: '#d9822b' };
const NAME = { ben: 'Ben', maya: 'Maya', dev: 'Dev' };
const BOARD_ZOOM = { s: 1.0, x: 0.5, y: 0.5 };
const beat = (name, opts) => fs.existsSync(path.join(OUT, name, 'frames.json')) && footage(name, opts);

const frameOf = (name, t) => { const m = take(name); const f = m.frames.filter((x) => x.t <= t).pop() || m.frames[m.frames.length - 1]; return `${m.dir}/${f.file}`; };
// Everything plays at the speed it was recorded (1×): the people working together are shown whole, the other
// features are short cuts from the middle of their takes.
const cut = (name, from, len, opts = {}) => { const t = take(name); from = Math.max(0, Math.min(from, t.length - 0.2)); len = Math.min(len, t.length - from); return footage(name, { from, to: from + len, show: len, ...opts }); };
const beatAt = (name, from, len, captions) => fs.existsSync(path.join(OUT, name, 'frames.json')) && cut(name, from, len, { captions });
// Straight into the schematic: Ada starts alone, and each time someone joins, the view closes in on their cursor.
{
  const follows = ['ben', 'maya', 'dev'].filter((w) => S.follow && S.follow[w] && S.follow[w].length)
    .map((w) => { const tr = S.follow[w].filter((q) => q[0] <= S.follow[w][0][0] + 3); const mx = tr.reduce((s2, q) => s2 + q[1], 0) / tr.length, my = tr.reduce((s2, q) => s2 + q[2], 0) / tr.length;
      // a slow push-in towards where the newcomer works: one fixed point, no following
      return { who: w, t0: S.follow[w][0][0], len: 4.2, in: 1.6, out: 1.6, s: 1.2, sx: 1, track: [[0, mx, my]] }; });
  const toasts = follows.map((f) => ({ at: f.t0 + 0.25, text: `${NAME[f.who]} joined`, color: COL[f.who] }));
  cut('schematic', 0, S.length, { follows, toasts, captions: [''] });
}
// the board: outline and Update PCB; each block built as a cluster and routed inside, then put on the board;
// all four route between the blocks; the planes fill
{
  const B = state.build, M = B.marks;
  cut('build', 0, M.updated, { cutOut: true, captions: ['Edge.Cuts', 'Update PCB from Schematic'] });
  const fast = (from, to, max) => { const len = to - from; return Math.min(len, max); };
  footage('build', { from: M.updated, to: M.clustered, show: fast(M.updated, M.clustered, 22), cutIn: true, cutOut: true, captions: ['Placement, block by block'] });
  footage('build', { from: M.clustered, to: M.onboard, show: fast(M.clustered, M.onboard, 20), cutIn: true, cutOut: true, captions: ['Routing inside each block'] });
  footage('build', { from: M.onboard, to: M.route, show: fast(M.onboard, M.route, 8), cutIn: true, cutOut: true, captions: ['Blocks onto the board'] });
  footage('build', { from: M.route, to: M.routed, show: fast(M.route, M.routed, 24), cutIn: true, cutOut: true, zoom: BOARD_ZOOM, captions: ['Routing'] });
  cut('build', M.routed, Math.min(3.5, B.length - M.routed), { cutIn: true, zoom: BOARD_ZOOM, captions: ['Zone fill'] });
}
// the rest: cuts of their own
{
  const from = Math.max(0, AI.marks.ask - 1.2), len = Math.min(AI.length, AI.marks.accept + 3) - from, at = (m) => AI.marks[m] - from;
  cut('ai', from, len, { chat: { x: 1010, y: 560, head: 'AI CHAT', at: 0, until: at('card') - 0.2,
    lines: [{ who: 'Ada', text: 'Can you add the 12 MHz crystal circuit from the RP2040 design guide?', at: at('ask'), typing: 1.4 },
            { who: 'Claude', ai: true, text: 'Here is where it goes. I\'ll propose it for you to check.', at: at('highlight') + 0.3, typing: 0.9 }] },
    captions: ['AI assistant over MCP'] });
}
beatAt('history', 0, state.history.length, ['History']);
if (state.parts) { const P = state.parts, from = Math.max(0, (P.marks.search || 0) - 1.5); beatAt('parts', from, P.length - from, ['LCSC, Mouser and DigiKey parts']); }
beatAt('plugins', 0.5, state.plugins.length - 0.5, ['Plugins']);
if (state.websim) beatAt('websim', Math.max(0, state.websim.marks.ran - 4), state.websim.length - Math.max(0, state.websim.marks.ran - 4), ['SPICE simulation']);
if (state.drc) beatAt('drc', 0, state.drc.length, ['Design rules check']);
beat('github', { show: 12, captions: ['GitHub sync'] });
beatAt('fab', 0, state.fab.length, ['Fabrication outputs']);
beatAt('viewer3d', state.viewer3d.marks.loaded - 0.2, state.viewer3d.length - state.viewer3d.marks.loaded + 0.2, ['3D viewer']);
add({ kind: 'end', length: 4.5, bg: '', title: 'Junction', sub: 'Real-time collaborative KiCAD', links: ['junctioneda.com'] });

// On the beat: every cut lands on a beat of the music (a strong one when one is near), by stretching or squeezing
// the scene before it a little; a join's zoom starts on a beat too.
const MUSIC = (() => { const i = process.argv.indexOf('--music'); return i > 0 ? process.argv[i + 1] : null; })();
let music = null;
// --measures: every feature gets whole bars of the music (4 beats each), its footage sped up to fill them, and every
// cut falls on a bar line; the run of bars is the piece's last ones, so the closing chord comes with the end card.
const BARS = (sc) => {
  const cap = (sc.captions[0] || {}).text || '';
  if (sc.kind === 'end') return 0;
  if (sc.name === 'schematic') return 8;
  if (sc.name === 'build') return /Update PCB|Edge/.test(sc.captions.map((c) => c.text).join()) ? 2 : /^Routing$/.test(cap) ? 3 : /Placement/.test(cap) ? 4 : /Inside|inside/.test(cap) ? 3 : /Blocks onto/.test(cap) ? 2 : 1;
  if (sc.name === 'github') return 5;
  if (sc.name === 'ai' || sc.name === 'parts' || sc.name === 'plugins') return 3;
  if (sc.name === 'history' || sc.name === 'fab') return 1;
  return 2;
};
if (MUSIC && process.argv.includes('--measures')) {
  const bj = MUSIC.replace(/\.[^.]+$/, '.beats.json');
  if (!fs.existsSync(bj)) execFileSync('python3', [path.join(here, 'beats.py'), MUSIC, bj], { stdio: 'inherit' });
  const B = JSON.parse(fs.readFileSync(bj, 'utf8'));
  // the bar lines: every fourth beat, on the phase where the accents fall
  const strong = new Set(B.strong.map((t) => t.toFixed(3)));
  let phase = 0, bestN = -1;
  for (let ph = 0; ph < 4; ph++) { const n = B.beats.filter((t, i) => i % 4 === ph && strong.has(t.toFixed(3))).length; if (n > bestN) { bestN = n; phase = ph; } }
  let bars = B.beats.filter((_, i) => i % 4 === phase);
  // the last bar line at or before the closing chord ends the footage
  const end = B.last_hit; bars = bars.filter((t) => t <= end + 0.15);
  if (Math.abs(bars[bars.length - 1] - end) > 0.15) bars.push(end);
  const feats = scenes.filter((sc) => sc.kind !== 'end'); const need = feats.reduce((n, sc) => n + BARS(sc), 0);
  if (bars.length - 1 < need) throw new Error(`the piece has ${bars.length - 1} bars before its last chord, the video needs ${need}`);
  const lines = bars.slice(bars.length - 1 - need); const offset = lines[0];
  let k = 0, t = 0;
  for (const sc of scenes) {
    let len;
    if (sc.kind === 'end') len = sc.length;
    else { const n = BARS(sc); len = lines[k + n] - lines[k]; k += n; }
    if (sc.kind === 'footage') {
      const ratio = len / sc.length;
      sc.speed = +((sc.speed * sc.length) / len).toFixed(4);
      for (const c of sc.captions) { c.at *= ratio; c.until *= ratio; }
      for (const w of sc.windows) {
        for (const ts of w.toasts || []) ts.at *= ratio;
        if (w.chat) { w.chat.at *= ratio; w.chat.until *= ratio; for (const l of w.chat.lines) { l.at *= ratio; if (l.typing) l.typing *= ratio; } }
        // a join's push-in lasts as long in the video whatever the speed
        for (const f of w.follows || []) f.len *= sc.speed;
      }
    }
    sc.length = +len.toFixed(3); sc.start = +t.toFixed(3); t += len;
  }
  at = t; music = { file: MUSIC, offset };
  console.log(`music ${path.basename(MUSIC)} from ${offset.toFixed(2)} s, ${need} bars, phase ${phase}; cuts on`, scenes.map((s2) => s2.start.toFixed(2)).join(' '));
} else if (MUSIC) {
  const bj = MUSIC.replace(/\.[^.]+$/, '.beats.json');
  if (!fs.existsSync(bj)) execFileSync('python3', [path.join(here, 'beats.py'), MUSIC, bj], { stdio: 'inherit' });
  const B = JSON.parse(fs.readFileSync(bj, 'utf8'));
  // where in the piece the video starts: the closing chord falls as the end card comes up, if the piece is long enough
  const endAt = scenes[scenes.length - 1].start;
  const offset = process.argv.includes('--from-start') ? 0 : Math.max(0, B.last_hit - endAt);
  const beats = B.beats.map((t) => t - offset).filter((t) => t > 0.5), strong = new Set(B.strong.map((t) => +(t - offset).toFixed(3)));
  const near = (t, win) => { let best = null; for (const b of beats) { const d = Math.abs(b - t), w = strong.has(+b.toFixed(3)) ? d * 0.6 : d; if (d <= win && (!best || w < best.w)) best = { b, w }; } return best ? best.b : t; };
  let t = 0;
  for (const sc of scenes) {
    const want = t + sc.length; const isLast = sc === scenes[scenes.length - 1];
    const land = isLast ? want : near(want, Math.min(0.6, sc.length * 0.12));
    const len = Math.max(0.5, land - t);
    if (sc.kind === 'footage') {
      sc.speed = +((sc.speed * sc.length) / len).toFixed(4);
      for (const c of sc.captions) { c.at *= len / sc.length; c.until *= len / sc.length; }
      for (const w of sc.windows) {
        for (const ts of w.toasts || []) ts.at *= len / sc.length;
        if (w.chat) { const k = len / sc.length; w.chat.at *= k; w.chat.until *= k; for (const l of w.chat.lines) l.at *= k; }
        // a zoom starts on a beat
        for (const f of w.follows || []) { const v = t + (f.t0 - sc.from) / sc.speed, vb = near(v, 0.3); f.t0 = sc.from + (vb - t) * sc.speed; }
      }
    }
    sc.length = +len.toFixed(3); sc.start = +t.toFixed(3); t += len;
  }
  at = t;
  music = { file: MUSIC, offset };
  console.log(`music ${path.basename(MUSIC)} from ${offset.toFixed(2)} s, tempo ${B.tempo.toFixed(0)}; cuts on`, scenes.map((s2) => s2.start.toFixed(2)).join(' '));
}
// straight cuts only, on the music: no fade into or out of any scene
if (!process.argv.includes("--fades")) for (const sc of scenes) { sc.cutIn = true; sc.cutOut = true; }   // --fades: keep the fades
const timeline = { length: +at.toFixed(3), fps: FPS, icon: pathToFileURL(path.join(here, '..', '..', 'static', 'icon.svg')).href, scenes };
fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({ ...timeline, scenes: scenes.map((s) => ({ ...s, windows: s.windows && s.windows.map((w) => ({ ...w, frames: w.frames.length })) })) }, null, 1));
console.log(`timeline ${timeline.length.toFixed(1)} s:`, scenes.map((s) => `${s.name || s.kind} ${s.length.toFixed(1)}s${s.speed ? ' ×' + s.speed.toFixed(1) : ''}`).join(', '));

const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
// --final draws the stage at twice its size: a 3840 x 2160 master (the footage is photographed at 2x too)
const SCALE = process.argv.includes('--final') ? 2 : 1;
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: SCALE, colorScheme: 'dark' })).newPage();
await page.goto(pathToFileURL(path.join(here, 'compose.html')).href);
await page.evaluate((t) => window.load(t), timeline);
const stills = process.argv.includes('--stills');
// the README's poster: a frame of the AI scene (both people and the AI's cursor), with a play button on it
const posterAt = scenes.filter((s) => s.name === 'schematic').pop(); await page.evaluate((t) => window.seek(t), posterAt.start + posterAt.length * 0.8);
await page.evaluate(() => { const d = document.createElement('div'); d.id = 'play'; d.style.cssText = 'position:absolute;left:50%;top:50%;width:150px;height:150px;margin:-75px 0 0 -75px;border-radius:50%;background:rgba(10,10,12,.78);box-shadow:0 0 0 2px rgba(255,255,255,.85)';
  d.innerHTML = '<div style="position:absolute;left:60px;top:45px;border-left:46px solid #fff;border-top:30px solid transparent;border-bottom:30px solid transparent"></div>'; document.getElementById('stage').appendChild(d); });
await page.screenshot({ path: path.join(OUT, `${(() => { const i = process.argv.indexOf('--out'); return i > 0 ? process.argv[i + 1] : 'junction-demo'; })()}-poster.jpg`), type: 'jpeg', quality: 86 });
await page.evaluate(() => document.getElementById('play').remove());
const tag = (() => { const i = process.argv.indexOf('--out'); return i > 0 ? process.argv[i + 1] : 'junction-demo'; })();
const mp4 = path.join(OUT, `${tag}.mp4`);
if (stills) {
  for (const s of scenes) for (const k of [0.3, 0.75]) { await page.evaluate((t) => window.seek(t), s.start + s.length * k); await page.screenshot({ path: path.join(OUT, `still-${String(scenes.indexOf(s)).padStart(2, '0')}-${k}.jpg`), type: 'jpeg', quality: 80 }); }
} else {
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', process.argv.includes('--final') ? 'slow' : 'veryfast', '-crf', process.argv.includes('--final') ? '16' : '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = Math.round(timeline.length * FPS);
  for (let i = 0; i < total; i++) {
    await page.evaluate((t) => window.seek(t), i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: process.argv.includes('--final') ? 100 : 95 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 300 === 0) console.log(`  frame ${i} of ${total}`);
  }
  ff.stdin.end(); await new Promise((r) => ff.on('close', r));
  if (music) {
    // the soundtrack: from the chosen point of the piece, faded in briefly and out under the end card
    const silent = mp4.replace(/\.mp4$/, '.video.mp4'); fs.renameSync(mp4, silent);
    const L = timeline.length, fade = 2.5;
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', silent, '-ss', String(music.offset), '-i', music.file, '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
      '-af', `afade=t=in:st=0:d=0.4,afade=t=out:st=${(L - fade).toFixed(2)}:d=${fade},volume=0.9`, '-c:a', 'aac', '-b:a', '256k', '-t', String(L), '-movflags', '+faststart', mp4]);
    fs.rmSync(silent);
  }
  if (SCALE > 1) {
    // the web copy: 1920 x 1080, small enough for the repository (GitHub refuses files over 100 MB)
    const web = mp4.replace(/\.mp4$/, '-1080p.mp4');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', mp4, '-vf', 'scale=1920:1080:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', web]);
    console.log(web, (fs.statSync(web).size / 1e6).toFixed(1), 'MB');
  }
  console.log(mp4, (fs.statSync(mp4).size / 1e6).toFixed(1), 'MB');
}
await browser.close();
