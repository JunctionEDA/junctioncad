//! Project libraries that a project's library table names but the project does not hold.
//!
//! A project uploaded as loose files (the web upload) can arrive with its `sym-lib-table` and
//! without the `${KIPRJMOD}/<name>.kicad_sym` the table points at.  The desktop then reports the
//! library as missing on every open and the rules check warns once per symbol.  A schematic keeps
//! a full copy of every symbol it uses (`lib_symbols`), so the library can be written back from
//! those copies: `rebuild_symbol_libraries` returns the files to add to a download.  Nothing
//! stored is changed, and a library the project does hold is never touched.
//!
//! Footprint libraries are rebuilt by the desktop, not here: a footprint on a board is a placed
//! instance (moved texts, pad nets, a side and a rotation), and KiCad's own code turns it back
//! into a library footprint (COLLAB_PROJECT::EnsureLibraryFolders, then pcbnew's
//! KIFACE_REBUILD_FOOTPRINT_LIBRARIES).  `MissingScan` lists what an upload left out.

use std::collections::{BTreeMap, HashSet};

/// The index just past the list that opens at `open` (which must be a `(`), strings respected.
fn list_end(text: &[u8], open: usize) -> Option<usize> {
    let (mut depth, mut i, mut quoted) = (0usize, open, false);
    while i < text.len() {
        let c = text[i];
        if quoted {
            if c == b'\\' { i += 1; } else if c == b'"' { quoted = false; }
        } else if c == b'"' {
            quoted = true;
        } else if c == b'(' {
            depth += 1;
        } else if c == b')' {
            depth = depth.checked_sub(1)?;
            if depth == 0 { return Some(i + 1); }
        }
        i += 1;
    }
    None
}

/// The first quoted string at or after `from`, unescaped, and the index just past it.
fn quoted_at(text: &str, from: usize) -> Option<(String, usize)> {
    let b = text.as_bytes();
    let start = from + text[from..].find('"')? + 1;
    let (mut i, mut out) = (start, Vec::new());
    while i < b.len() {
        match b[i] {
            b'\\' if i + 1 < b.len() => { out.push(b[i + 1]); i += 2; }
            b'"' => return Some((String::from_utf8(out).ok()?, i + 1)),
            c => { out.push(c); i += 1; }
        }
    }
    None
}

/// The lists directly inside the list `text[open..end]`, as (start, end) byte ranges.
fn children(text: &[u8], open: usize, end: usize) -> Vec<(usize, usize)> {
    let (mut out, mut i, mut quoted) = (Vec::new(), open + 1, false);
    while i + 1 < end {
        let c = text[i];
        if quoted {
            if c == b'\\' { i += 1; } else if c == b'"' { quoted = false; }
        } else if c == b'"' {
            quoted = true;
        } else if c == b'(' {
            match list_end(text, i) { Some(e) if e <= end => { out.push((i, e)); i = e; continue; } _ => break }
        }
        i += 1;
    }
    out
}

/// `(name "X") … (uri "${KIPRJMOD}/path.kicad_sym")` rows of a sym-lib-table: nickname → project path.
fn project_symbol_libs(table: &str) -> Vec<(String, String)> {
    project_libs(table, ".kicad_sym")
}

/// The rows of a library table that point inside the project at a path ending in `suffix`:
/// nickname → project-relative path.  Values may be quoted or bare (older tables).
fn project_libs(table: &str, suffix: &str) -> Vec<(String, String)> {
    let b = table.as_bytes();
    let Some(root) = table.find('(') else { return Vec::new() };
    let Some(end) = list_end(b, root) else { return Vec::new() };
    let mut out = Vec::new();
    for (s, e) in children(b, root, end) {
        let row = &table[s..e];
        if !row.starts_with("(lib") { continue; }
        let field = |key: &str| {
            let at = row.find(&format!("({key} "))? + key.len() + 2;
            let rest = row[at..].trim_start();
            if rest.starts_with('"') { quoted_at(rest, 0).map(|(v, _)| v) } else { rest.split(')').next().map(|v| v.trim().to_string()) }
        };
        let (Some(name), Some(uri)) = (field("name"), field("uri")) else { continue };
        if let Some(t) = field("type") { if !t.eq_ignore_ascii_case("kicad") { continue; } }
        let Some(rel) = uri.strip_prefix("${KIPRJMOD}/").or_else(|| uri.strip_prefix("$(KIPRJMOD)/")) else { continue };
        let rel = rel.replace('\\', "/");
        if rel.is_empty() || !rel.to_ascii_lowercase().ends_with(suffix) || rel.split('/').any(|p| p.is_empty() || p == "." || p == "..") { continue; }
        out.push((name, rel));
    }
    out
}

/// The symbol library file format this server writes; a schematic older than it keeps its own date.
const SYMBOL_LIB_VERSION: u64 = 20241209;
const OLDEST_SYMBOL_LIB_VERSION: u64 = 20211014;

/// The files to add to a download of `entries` (path, content): one `.kicad_sym` per project
/// symbol library that a `sym-lib-table` names and the project does not hold, holding every
/// symbol of that library the schematics use.  A library no schematic uses is left out.
pub fn rebuild_symbol_libraries(entries: &[(String, Vec<u8>)]) -> Vec<(String, Vec<u8>)> {
    let have: HashSet<&str> = entries.iter().map(|(p, _)| p.as_str()).collect();
    let mut out = Vec::new();
    for (table_path, table) in entries.iter().filter(|(p, _)| p.rsplit('/').next() == Some("sym-lib-table")) {
        let Ok(table) = std::str::from_utf8(table) else { continue };
        let dir = table_path.rsplit_once('/').map(|(d, _)| format!("{d}/")).unwrap_or_default();
        let wanted: Vec<(String, String)> = project_symbol_libs(table).into_iter()
            .map(|(n, rel)| (n, format!("{dir}{rel}"))).filter(|(_, p)| !have.contains(p.as_str())).collect();
        if wanted.is_empty() { continue; }
        // nickname → symbol name → its text with the library prefix taken off the name
        let mut found: BTreeMap<&str, BTreeMap<String, String>> = BTreeMap::new();
        let mut version = SYMBOL_LIB_VERSION;
        for (path, content) in entries.iter().filter(|(p, _)| p.to_ascii_lowercase().ends_with(".kicad_sch")) {
            let _ = path;
            let Ok(text) = std::str::from_utf8(content) else { continue };
            let b = text.as_bytes();
            let Some(at) = text.find("(lib_symbols") else { continue };
            let Some(end) = list_end(b, at) else { continue };
            if let Some(v) = text.find("(version ").and_then(|i| text[i + 9..].split(')').next()).and_then(|v| v.trim().parse::<u64>().ok()) {
                version = version.min(v.max(OLDEST_SYMBOL_LIB_VERSION));
            }
            for (s, e) in children(b, at, end) {
                let sym = &text[s..e];
                if !sym.starts_with("(symbol") { continue; }
                let Some((id, after)) = quoted_at(sym, 0) else { continue };
                let Some((nick, name)) = id.split_once(':') else { continue };
                let Some((lib, _)) = wanted.iter().find(|(n, _)| n == nick) else { continue };
                let quote = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
                let body = format!("(symbol {}{}", quote(name), &sym[after..]);
                found.entry(lib.as_str()).or_default().entry(name.to_string()).or_insert(body);
            }
        }
        for (nick, path) in &wanted {
            let Some(symbols) = found.get(nick.as_str()) else { continue };
            let mut file = format!("(kicad_symbol_lib\n\t(version {version})\n\t(generator \"junction\")\n\t(generator_version \"10.0\")\n");
            for body in symbols.values() { file.push('\t'); file.push_str(body); file.push('\n'); }
            file.push_str(")\n");
            out.push((path.clone(), file.into_bytes()));
        }
    }
    out
}

/// What a project names as its own and did not bring along: `${KIPRJMOD}` symbol and footprint
/// libraries of its library tables, and `${KIPRJMOD}` 3D models of its boards.  Files are added
/// one at a time (an upload never holds them all), and `finish` answers
/// `{ "kind": "symbol_library" | "footprint_library" | "model", "path": … }`, at most 200.
#[derive(Default)]
pub struct MissingScan {
    have: HashSet<String>,
    /// (kind, path) a file named, in the order met
    named: Vec<(&'static str, String)>,
}

impl MissingScan {
    pub fn add(&mut self, path: &str, content: &[u8]) {
        self.have.insert(path.to_lowercase());
        let base = path.rsplit('/').next().unwrap_or(path);
        let dir = path.rsplit_once('/').map(|(d, _)| format!("{d}/")).unwrap_or_default();
        let is_board = base.to_ascii_lowercase().ends_with(".kicad_pcb");
        if base != "sym-lib-table" && base != "fp-lib-table" && !is_board { return; }
        let text = String::from_utf8_lossy(content);
        if base == "sym-lib-table" {
            for (_, rel) in project_libs(&text, ".kicad_sym") { self.named.push(("symbol_library", format!("{dir}{rel}"))); }
        } else if base == "fp-lib-table" {
            for (_, rel) in project_libs(&text, ".pretty") { self.named.push(("footprint_library", format!("{dir}{rel}"))); }
        } else {
            // a board's ${KIPRJMOD} is its own folder
            let mut at = 0;
            while let Some(i) = text[at..].find("(model ") {
                at += i + 7;
                let rest = text[at..].trim_start();
                let name = if rest.starts_with('"') { quoted_at(rest, 0).map(|(v, _)| v) } else { rest.split(|c: char| c.is_whitespace() || c == ')').next().map(str::to_string) };
                let Some(name) = name else { continue };
                let Some(rel) = name.strip_prefix("${KIPRJMOD}/").or_else(|| name.strip_prefix("$(KIPRJMOD)/")) else { continue };
                let rel = rel.replace('\\', "/");
                if rel.is_empty() || rel.split('/').any(|p| p.is_empty() || p == "." || p == "..") { continue; }
                self.named.push(("model", format!("{dir}{rel}")));
            }
        }
    }

    pub fn finish(self) -> Vec<serde_json::Value> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for (kind, path) in self.named {
            let lower = path.to_lowercase();
            let held = if kind == "footprint_library" { let folder = format!("{lower}/"); self.have.iter().any(|p| p.starts_with(&folder)) } else { self.have.contains(&lower) };
            if !held && out.len() < 200 && seen.insert(lower) {
                out.push(serde_json::json!({ "kind": kind, "path": path }));
            }
        }
        out
    }
}

#[cfg(test)]
pub fn missing_project_files(entries: &[(String, Vec<u8>)]) -> Vec<serde_json::Value> {
    let mut scan = MissingScan::default();
    for (path, content) in entries { scan.add(path, content); }
    scan.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLE: &str = "(sym_lib_table\n  (version 7)\n  (lib (name \"mine\")(type \"KiCad\")(uri \"${KIPRJMOD}/mine.kicad_sym\")(options \"\")(descr \"\"))\n  (lib (name \"std\")(type \"KiCad\")(uri \"${KICAD9_SYMBOL_DIR}/Device.kicad_sym\")(options \"\")(descr \"\"))\n  (lib (name \"up\")(type \"KiCad\")(uri \"${KIPRJMOD}/../x.kicad_sym\")(options \"\")(descr \"\"))\n)\n";
    const SCH: &str = "(kicad_sch\n\t(version 20250114)\n\t(generator \"eeschema\")\n\t(lib_symbols\n\t\t(symbol \"mine:VALVE (odd)\"\n\t\t\t(property \"Reference\" \"U\" (at 0 0 0))\n\t\t\t(symbol \"VALVE (odd)_1_1\" (pin input line (at 0 0 0) (length 2.54) (name \"a)\\\"b\") (number \"1\")))\n\t\t)\n\t\t(symbol \"Device:R\" (property \"Reference\" \"R\" (at 0 0 0)))\n\t\t(symbol \"mine:B\" (property \"Reference\" \"B\" (at 0 0 0)))\n\t)\n\t(symbol (lib_id \"mine:B\") (at 1 1 0))\n)\n";

    fn entry(p: &str, c: &str) -> (String, Vec<u8>) { (p.to_string(), c.as_bytes().to_vec()) }

    #[test]
    fn a_missing_project_symbol_library_is_written_from_the_schematic() {
        let out = rebuild_symbol_libraries(&[entry("sym-lib-table", TABLE), entry("a.kicad_sch", SCH)]);
        assert_eq!(out.len(), 1, "only the project's own library, and never a path that leaves the project");
        assert_eq!(out[0].0, "mine.kicad_sym");
        let text = String::from_utf8(out[0].1.clone()).unwrap();
        assert!(text.starts_with("(kicad_symbol_lib\n\t(version 20241209)"), "{text}");
        assert!(text.contains("(symbol \"B\" (property \"Reference\" \"B\""), "{text}");
        assert!(text.contains("(symbol \"VALVE (odd)\"\n") && text.contains("(symbol \"VALVE (odd)_1_1\"") && text.contains("(name \"a)\\\"b\")"), "{text}");
        assert!(!text.contains("Device") && !text.contains("mine:"), "{text}");
        assert_eq!(list_end(text.as_bytes(), 0), Some(text.len() - 1), "one balanced list");
    }

    #[test]
    fn a_library_the_project_holds_or_does_not_use_is_left_alone() {
        assert!(rebuild_symbol_libraries(&[entry("sym-lib-table", TABLE), entry("a.kicad_sch", SCH), entry("mine.kicad_sym", "(kicad_symbol_lib)")]).is_empty());
        assert!(rebuild_symbol_libraries(&[entry("sym-lib-table", TABLE), entry("a.kicad_sch", "(kicad_sch (version 20211123) (lib_symbols))")]).is_empty());
        assert!(rebuild_symbol_libraries(&[entry("a.kicad_sch", SCH)]).is_empty());
        // a table in a sub-folder names files beside itself; an older schematic keeps its own format date
        let out = rebuild_symbol_libraries(&[entry("sub/sym-lib-table", TABLE), entry("sub/a.kicad_sch", &SCH.replace("20250114", "20230121"))]);
        assert_eq!(out[0].0, "sub/mine.kicad_sym");
        assert!(String::from_utf8(out[0].1.clone()).unwrap().contains("(version 20230121)"));
    }

    #[test]
    fn what_a_project_names_and_did_not_bring_is_listed() {
        let fp = "(fp_lib_table\n  (lib (name mine)(type KiCad)(uri \"$(KIPRJMOD)/mine.pretty\")(options \"\")(descr \"\"))\n  (lib (name \"here\")(type \"KiCad\")(uri \"${KIPRJMOD}/here.pretty\"))\n)";
        let pcb = "(kicad_pcb (footprint \"mine:A\" (model \"${KIPRJMOD}/3d/a.step\" (offset (xyz 0 0 0))) (model \"${KIPRJMOD}/3d/b.step\") (model \"${KICAD9_3DMODEL_DIR}/R.3dshapes/R.step\") (model \"${KIPRJMOD}/3d/a.step\")))";
        let out = missing_project_files(&[entry("sym-lib-table", TABLE), entry("fp-lib-table", fp), entry("b.kicad_pcb", pcb),
                                          entry("here.pretty/X.kicad_mod", "(footprint \"X\")"), entry("3d/B.step", "x")]);
        let got: Vec<String> = out.iter().map(|m| format!("{}:{}", m["kind"].as_str().unwrap(), m["path"].as_str().unwrap())).collect();
        assert_eq!(got, ["symbol_library:mine.kicad_sym", "footprint_library:mine.pretty", "model:3d/a.step"]);
        assert!(missing_project_files(&[entry("a.kicad_sch", SCH)]).is_empty());
    }
}
