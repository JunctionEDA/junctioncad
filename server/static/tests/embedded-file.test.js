// embedded-file.test.js — adding a file on the Embedded Files page (web/domains/pcb/library/embedded-file.ts): the type AddFile
// picks, the MMH3 checksum KiCad writes, the zstd frame KiCad's reader takes (content size known), the (file …) form,
// and the board serializer writing its (data |…|) lines bare, as EMBEDDED_FILES::WriteEmbeddedFiles does.
// Run: node server/static/tests/embedded-file.test.js
"use strict";
const path = require("path"), assert = require("assert/strict"), zlib = require("zlib");
const { webPath } = require("./web-path");
const esbuild = require(path.join(__dirname, "..", "..", "node_modules", "esbuild"));
function load(file) {
  const out = esbuild.buildSync({ entryPoints: [webPath(file)], bundle: true, format: "cjs", write: false, platform: "node", logLevel: "silent" });
  const m = { exports: {} }; new Function("module", "exports", "require", out.outputFiles[0].text)(m, m.exports, require); return m.exports;
}
const F = load("library/embedded-file.ts"), Z = load("dialogs/zstd.ts"), C = load("dialogs/zstd-compress.ts"), B = load("canvas/board-setup.ts"), S = load("canvas/sexpr.ts"), X = load("canvas/export.ts");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log("  ok   " + name); } catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e.stack || String(e)).split("\n").slice(0, 6).join("\n       ")); } }
console.log("embedded-file: Embedded Files > Add");

test("AddFile's types by extension", () => {
  assert.equal(F.embeddedFileType("a.STEP"), "model"); assert.equal(F.embeddedFileType("a.stp"), "model"); assert.equal(F.embeddedFileType("b.wrz"), "model");
  assert.equal(F.embeddedFileType("f.woff2"), "font"); assert.equal(F.embeddedFileType("f.ttf"), "font");
  assert.equal(F.embeddedFileType("d.pdf"), "datasheet"); assert.equal(F.embeddedFileType("p.kicad_wks"), "worksheet");
  assert.equal(F.embeddedFileType("notes.txt"), "other"); assert.equal(F.embeddedFileType("README"), "other");
});
test("MurmurHash3_x64_128 as MMH3_HASH / HASH_128::ToString", () => {
  // the reference vector of MurmurHash3_x64_128 (seed 0)
  assert.equal(F.mmh3Hash(Buffer.from("The quick brown fox jumps over the lazy dog"), 0), "E34BBC7BBC071B6C7A433CA9C49A9347");
  assert.equal(F.mmh3Hash(new Uint8Array(0), 0), "00000000000000000000000000000000");
  // KiCad's V1 hash (MMH3_HASH::addDataV1) is this hash over the data zero-padded to four bytes whenever the padded
  // length still leaves a tail: qa/data/pcbnew/issue22102's SchematicTemplate.kicad_wks (1977 bytes) carries one
  const qa = path.join(__dirname, "..", "..", "..", "qa", "data", "pcbnew", "issue22102.kicad_pcb");
  if (require("fs").existsSync(qa)) {
    const m = /\(name "SchematicTemplate\.kicad_wks"\)[\s\S]*?\(data\s+([\s\S]*?)\)\s*\(checksum "([0-9A-F]+)"/.exec(require("fs").readFileSync(qa, "utf8"));
    const ws = Buffer.from(Z.zstdDecompress(new Uint8Array(Buffer.from(m[1].replace(/[|\s]/g, ""), "base64"))));
    assert.equal(ws.length, 1977);
    assert.equal(F.mmh3Hash(Buffer.concat([ws, Buffer.alloc(3)])), m[2]);
  }
});
// a deterministic stand-in for incompressible bytes (xorshift32)
function noise(n, seed = 2463534242) { const b = Buffer.alloc(n); let x = seed >>> 0; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 255; } return b; }
// STEP-like text: what a 3D model is, and what CompressAndEncode shrinks several times over
function stepText(n) { let s = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n", i = 1; while (s.length < n) { s += `#${i}=CARTESIAN_POINT('',(${(i * 0.137 % 9).toFixed(3)},${(i * 0.071 % 5).toFixed(3)},0.));\n#${i + 1}=DIRECTION('',(0.,0.,1.));\n`; i += 2; } return Buffer.from(s.slice(0, n)); }
test("the frame (ZSTD_compress) reads back through zstd.ts and node's zstd, with its content size", () => {
  const inputs = [new Uint8Array(0), Buffer.from("x"), Buffer.from("abcabcabcabcabcabcabcabc"), Buffer.alloc(131072, 5), Buffer.alloc(300001).map((_, i) => (i * 7) & 255),
    noise(200000), noise(5000).map((x) => 48 + (x % 10)), noise(3000).map((x) => x % 129), stepText(1023), stepText(1024), stepText(16384), stepText(400000)];
  for (const inp of inputs) {
    const fr = C.zstdCompress(inp);
    assert.deepEqual(Array.from(fr.subarray(0, 5)), [0x28, 0xb5, 0x2f, 0xfd, 0xe0]);
    assert.equal(Number(Buffer.from(fr.subarray(5, 13)).readBigUInt64LE()), inp.length, "Frame_Content_Size");
    assert.ok(Buffer.from(Z.zstdDecompress(fr)).equals(Buffer.from(inp)), "zstd.ts, length " + inp.length);
    if (typeof zlib.zstdDecompressSync === "function") assert.ok(zlib.zstdDecompressSync(Buffer.from(fr)).equals(Buffer.from(inp)), "node zstd, length " + inp.length);
  }
});
test("a block stored raw leaves the repeat offsets as the decoder has them", () => {
  // block 1 sets offset 3; block 2 is noise with one 5-byte repeat 1000 back (not worth a compressed block, so stored
  // raw); block 3 repeats with period 1000 from its start: offset 1000 is a repeat offset only if block 2's match counted
  const B = 131072, b1 = Buffer.from("abc".repeat(B / 3 + 1)).subarray(0, B), b2 = noise(B, 99); b2.copy(b2, 2000, 1000, 1005);
  const b3 = Buffer.alloc(B); noise(1000, 7).copy(b3, 0); for (let i = 1000; i < B; i++) b3[i] = i % 50 === 0 ? b3[i - 1000] ^ 0x55 : b3[i - 1000];
  const inp = Buffer.concat([b1, b2, b3]), fr = C.zstdCompress(inp);
  assert.ok(Buffer.from(Z.zstdDecompress(fr)).equals(inp), "zstd.ts");
  if (typeof zlib.zstdDecompressSync === "function") assert.ok(zlib.zstdDecompressSync(Buffer.from(fr)).equals(inp), "node zstd");
});
test("the data is compressed as KiCad's is: a STEP model takes a fraction of its size, noise about its own size", () => {
  const step = stepText(400000), fr = C.zstdCompress(step);
  assert.ok(fr.length * 4 < step.length, `STEP text ${step.length} -> ${fr.length}`);
  if (typeof zlib.zstdCompressSync === "function") { const ref = zlib.zstdCompressSync(step).length; assert.ok(fr.length < ref * 2.5, `within reach of libzstd (${fr.length} vs ${ref})`); }
  // a real model (a vendor part's STEP file): KiCad's level-15 frame is about an eighth of it
  const real = path.join(__dirname, "..", "..", "tests", "fixtures", "vendor", "model_C25804.step");
  if (require("fs").existsSync(real)) {
    const b = require("fs").readFileSync(real), f = C.zstdCompress(b);
    assert.ok(f.length * 5 < b.length, `model_C25804.step ${b.length} -> ${f.length}`);
    assert.ok(Buffer.from(Z.zstdDecompress(f)).equals(b));
  }
  const n = noise(100000); assert.ok(C.zstdCompress(n).length < n.length + 64, "incompressible data is stored, not grown");
  const t = F.embeddedFileSexpr("m.step", step); assert.ok(t.length * 3 < step.length, `the (file …) form ${t.length} for ${step.length} bytes`);
});
test("the (file …) form: name, type, bar-delimited base64 lines of 76, checksum", () => {
  const data = Buffer.alloc(500).map((_, i) => (i * 13) & 255);
  const t = F.embeddedFileSexpr('my "part".step', data);
  const node = S.parse(t);
  assert.equal(node[0], "file"); assert.equal(S.kid(node, "name")[1], 'my "part".step'); assert.equal(S.kid(node, "type")[1], "model");
  assert.equal(S.kid(node, "checksum")[1], F.mmh3Hash(data));
  const d = S.kid(node, "data"); assert.ok(String(d[1]).startsWith("|") && String(d[d.length - 1]).endsWith("|"));
  assert.ok(d.slice(1).every((x, i, a) => String(x).replace(/\|/g, "").length === (i < a.length - 1 ? 76 : String(x).replace(/\|/g, "").length)));
  assert.ok(Buffer.from(Z.zstdDecompress(new Uint8Array(Buffer.from(d.slice(1).join("").replace(/\|/g, ""), "base64")))).equals(data));
});
test("the serializer keeps (data |…|) bare, as KiCad's NeedBAR reader requires; image data and quoted slots are unchanged", () => {
  const t = F.embeddedFileSexpr("a.step", Buffer.alloc(400).map((_, i) => (i * 101) & 255));
  const out = X.serialize(S.parse(`(footprint "L:F" (embedded_files ${t}))`));
  const data = /\(data ([^)]*)\)/.exec(out)[1];
  assert.ok(!data.includes('"'), "no quotes: " + data.slice(0, 80));
  assert.ok(data.startsWith("|KLUv/") && data.endsWith("|"));
  assert.equal(X.serialize(S.parse(out)), out, "stable round trip");
  // 40 lines: past the reader's 30-slot quote mask, still bare
  const big = F.embeddedFileSexpr("b.bin", noise(2400));
  assert.ok(!/\(data [^)]*"/.test(X.serialize(S.parse(big))));
  // a reference image's data is not an embedded file: its quoted lines stay quoted
  assert.match(X.serialize(S.parse('(image (data "iVBO/+w=" "AA+A"))')), /^\(image \(data "iVBO\/\+w=" "AA\+A"\)\)$/);
});
// a board KiCad saved (CTL_FOR_BOARD): the footprint's (file …) without data, the data once in the board's own section
const BOARD_FILE = (data) => S.parse(`(embedded_files ${F.embeddedFileSexpr("m.step", data)} ${F.embeddedFileSexpr("other.pdf", Buffer.from("%PDF-1.4"))})`);
const FP_NO_DATA = () => S.parse('(footprint "L:F" (embedded_fonts no) (embedded_files (file (name "m.step") (type model) (checksum "0"))) (model "kicad-embed://m.step"))');
test("FixupEmbeddedData: a footprint file without data reads the board's file of its name", () => {
  const step = stepText(5000), board = BOARD_FILE(step), fp = FP_NO_DATA();
  assert.equal(F.embeddedFileData(fp, "m.step"), null, "the footprint alone has none");
  assert.ok(Buffer.from(F.decodeEmbedded(F.embeddedFileData(fp, "m.step", board))).equals(step));
  assert.equal(F.embeddedFileData(fp, "other.pdf", board), null, "a board file the footprint does not have is not its file");
  // the board's copy wins over the footprint's own, as FixupEmbeddedData overwrites it on load
  const own = S.parse(`(footprint "L:F" (embedded_files ${F.embeddedFileSexpr("m.step", Buffer.from("old"))}))`);
  assert.ok(Buffer.from(F.decodeEmbedded(F.embeddedFileData(own, "m.step", board))).equals(step));
  assert.ok(Buffer.from(F.decodeEmbedded(F.embeddedFileData(own, "m.step", null))).equals(Buffer.from("old")));
  // onto a copy: data and checksum taken, the footprint's other children kept
  const c = FP_NO_DATA(); assert.ok(F.fixupEmbeddedData(c, board));
  const f = S.kid(S.kid(c, "embedded_files"), "file");
  assert.equal(S.kid(f, "checksum")[1], F.mmh3Hash(step)); assert.equal(S.kid(f, "type")[1], "model");
  assert.match(X.serialize(c), /\(file \(name "m\.step"\) \(type model\) \(data \|KLUv\//);
});
test("the 3D viewer finds a KiCad-saved board footprint's embedded model in the board's section", () => {
  const M = load("viewer3d/models.ts"), step = stepText(5000), fp = FP_NO_DATA();
  global.URL.createObjectURL = (b) => "blob:" + b.size;
  assert.equal(M.footprintModels(fp, false).length, 0, "no data: nothing to show");
  const refs = M.footprintModels(fp, false, BOARD_FILE(step));
  assert.equal(refs.length, 1); assert.equal(refs[0].source, "embedded"); assert.equal(refs[0].url, "blob:" + step.length);
});
test("an embedded_file board setup change replaces the board's file of its name, or adds it", () => {
  const step = stepText(3000), doc = { type: "pcb", layers: new Map(), copper: [], embeddedFiles: BOARD_FILE(step) };
  const next = F.embeddedFileSexpr("m.step", Buffer.from("new content"));
  const ch = B.embeddedFilesChange([next]);
  assert.equal(ch.typeName, "BOARD_SETUP"); assert.equal(ch.properties[0].name, "embedded_file");
  assert.ok(B.applyBoardSetup(doc, ch));
  const files = S.kids(doc.embeddedFiles, "file");
  assert.deepEqual(files.map((f) => S.kid(f, "name")[1]), ["m.step", "other.pdf"], "in place");
  assert.ok(Buffer.from(F.decodeEmbedded(F.fileData(files[0]))).equals(Buffer.from("new content")));
  assert.equal(doc.copper.length, 0, "the layer table is not touched");
  const fresh = { type: "pcb", layers: new Map(), copper: [] };
  B.applyBoardSetup(fresh, B.embeddedFilesChange([next])); assert.equal(S.kids(fresh.embeddedFiles, "file").length, 1);
});
console.log(`${passed} passed, ${failed} failed`); if (failed) process.exit(1);
