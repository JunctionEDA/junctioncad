// scripts/modelgen-eval.mjs — how close are generated models to KiCad's own?
//
//   node scripts/modelgen-eval.mjs <sample.json> <report.json from the eval_dump test> <ref dir> [out.json]
//
// sample.json lists footprints of KiCad's library with the model their footprint names ({lib, name, path, mlib,
// mname}); the reference model is <ref dir>/<mlib>__<mname>.step.  Both models are tessellated with occt-import-js (as
// the web viewer does) and compared: the seated height, the outline seen from above (overlap of the two boxes), and
// whether the generated model's pins sit on the footprint's pads.  A part passes when the height is within 0.2 mm or
// 15 %, the outlines overlap by 80 % or more, and every pad has a pin.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const occt = await require("occt-import-js")();

const [sampleFile, reportFile, refDir, outFile] = process.argv.slice(2);
const sample = JSON.parse(fs.readFileSync(sampleFile, "utf8"));
const report = new Map(JSON.parse(fs.readFileSync(reportFile, "utf8")).map((r) => [`${r.lib}/${r.name}`, r]));

function load(file) {
  if (!file || !fs.existsSync(file)) return null;
  const r = occt.ReadStepFile(new Uint8Array(fs.readFileSync(file)), { linearUnit: "millimeter", linearDeflectionType: "absolute_value", linearDeflection: 0.05, angularDeflection: 0.5 });
  if (!r.success || !r.meshes?.length) return null;
  const pts = [];
  for (const m of r.meshes) { const p = m.attributes.position.array; for (let i = 0; i < p.length; i += 3) pts.push([p[i], p[i + 1], p[i + 2]]); }
  return pts;
}
function bbox(pts, zmin = -Infinity) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) { if (p[2] < zmin) continue; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); } }
  return { lo, hi };
}
const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.hi[0], b.hi[0]) - Math.max(a.lo[0], b.lo[0])), iy = Math.max(0, Math.min(a.hi[1], b.hi[1]) - Math.max(a.lo[1], b.lo[1]));
  const ar = (r) => (r.hi[0] - r.lo[0]) * (r.hi[1] - r.lo[1]);
  const i = ix * iy; return i / (ar(a) + ar(b) - i || 1);
};
// the reference model is placed with its footprint's (offset)(rotate)(scale)
function placement(text) {
  const m = /\(model\s[^\n]*\n?([\s\S]*?)\n\s*\)\s*\n?\s*(?:\(|$)/.exec(text) || [];
  const grab = (k) => { const r = new RegExp(`\\(${k}\\s*\\(xyz\\s+([-\\d.e]+)\\s+([-\\d.e]+)\\s+([-\\d.e]+)`).exec(text.slice(text.indexOf("(model"))); return r ? r.slice(1).map(Number) : null; };
  return { offset: grab("offset") || [0, 0, 0], rotate: grab("rotate") || [0, 0, 0], scale: grab("scale") || [1, 1, 1] };
}
function place(pts, pl) {
  const rad = Math.PI / 180, [rx, ry, rz] = pl.rotate.map((v) => -v * rad);
  return pts.map(([x, y, z]) => {
    x *= pl.scale[0]; y *= pl.scale[1]; z *= pl.scale[2];
    let t = y * Math.cos(rx) - z * Math.sin(rx); z = y * Math.sin(rx) + z * Math.cos(rx); y = t;
    t = x * Math.cos(ry) + z * Math.sin(ry); z = -x * Math.sin(ry) + z * Math.cos(ry); x = t;
    t = x * Math.cos(rz) - y * Math.sin(rz); y = x * Math.sin(rz) + y * Math.cos(rz); x = t;
    return [x + pl.offset[0], y + pl.offset[1], z + pl.offset[2]];
  });
}
function pads(text) {
  const out = [];
  for (const m of text.matchAll(/\(pad\s+"?([^"\s]*)"?\s+(smd|thru_hole|connect|np_thru_hole)\s+\S+[\s\S]*?\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?\)[\s\S]*?\(size\s+([-\d.]+)\s+([-\d.]+)\)[\s\S]*?\(layers([^)]*)\)/g)) {
    if (m[2] === "np_thru_hole" || !/\.Cu|\*\.Cu/.test(m[8])) continue;
    let w = +m[6], h = +m[7]; if (Math.abs(((+m[5] || 0) % 180)) === 90) [w, h] = [h, w];
    out.push({ num: m[1], x: +m[3], y: -+m[4], w, h, tht: m[2] === "thru_hole" });
  }
  // thermal vias (drilled pads sharing a surface pad's number) are not leads
  const smd = new Set(out.filter((p) => !p.tht).map((p) => p.num));
  return out.filter((p) => !(p.tht && (smd.has(p.num) || p.num === "")) );
}
// is there model material where each pad is (the bottom 0.35 mm, or below the board for a drilled pad)?
function pinsOnPads(pts, ps) {
  let missing = 0;
  for (const p of ps) {
    const hit = pts.some(([x, y, z]) => (p.tht ? z < -0.2 : z <= 0.35 && z >= -0.05) && Math.abs(x - p.x) <= p.w / 2 + 0.2 && Math.abs(y - p.y) <= p.h / 2 + 0.2);
    if (!hit) missing++;
  }
  return missing;
}

const rows = [];
for (const s of sample) {
  const gen = report.get(`${s.lib}/${s.name}`);
  const text = fs.readFileSync(s.path, "utf8");
  // the reference's outline is kept beside it (tessellating KiCad's models is most of the run's time)
  const refFile = path.join(refDir, `${s.mlib}__${s.mname}.step`), cacheFile = refFile + ".bbox.json";
  let rb = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : null;
  if (!rb) {
    const refPts0 = load(refFile);
    if (refPts0) { rb = bbox(place(refPts0, placement(text)), 0.0); fs.writeFileSync(cacheFile, JSON.stringify(rb)); }
  }
  if (!rb) { rows.push({ lib: s.lib, name: s.name, skip: "no reference model" }); continue; }
  const genPts = gen && gen.file ? load(gen.file) : null;
  if (!genPts) { rows.push({ lib: s.lib, name: s.name, family: gen?.family, pass: false, why: "not generated" }); continue; }
  const gb = bbox(genPts, 0.0);
  const rh = rb.hi[2], gh = gb.hi[2];
  const dh = Math.abs(gh - rh), hOk = dh <= Math.max(0.2, 0.15 * rh);
  const ov = iou(rb, gb);
  const ps = pads(text); const miss = pinsOnPads(genPts, ps);
  const pass = hOk && ov >= 0.8 && miss === 0;
  const why = [!hOk && `height ${gh.toFixed(2)} vs ${rh.toFixed(2)}`, ov < 0.8 && `outline overlap ${(ov * 100).toFixed(0)}%`, miss && `${miss} of ${ps.length} pads without a pin`].filter(Boolean).join("; ");
  rows.push({ lib: s.lib, name: s.name, family: gen.family, sources: gen.sources, pass, why, height: [+gh.toFixed(3), +rh.toFixed(3)], overlap: +ov.toFixed(3), missing: miss });
}
const done = rows.filter((r) => !r.skip);
const byFam = {};
for (const r of done) { const f = (byFam[r.family || "none"] ||= { n: 0, pass: 0 }); f.n++; if (r.pass) f.pass++; }
const summary = { compared: done.length, passed: done.filter((r) => r.pass).length, skipped: rows.length - done.length, families: byFam };
console.log(JSON.stringify(summary, null, 1));
for (const r of done.filter((r) => !r.pass)) console.log(`FAIL ${r.lib}/${r.name} [${r.family}] ${r.why}`);
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ summary, rows }, null, 1));
