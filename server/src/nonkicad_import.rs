//! Designs from other EDA tools uploaded to the web: converted to a KiCad project by the desktop's own importers
//! (`kicad-cli import`, common/io/* and the pcb_io / sch_io plugins), so a design opened in the browser is the same
//! KiCad project the desktop's File > Import Non-KiCad Project makes from it.
//!
//! EasyEDA in every version: Standard Edition source files (.json, one sheet, a multi-sheet project or a board,
//! from the 2015 format without `editorVersion` to 6.5), the Standard Edition backup (.zip of those), Pro projects
//! (.epro and its .zip export, Pro 2.x's .eprj database, Pro 3's .epro2) and Pro libraries (.elibz, .elibz2).
//! And every other format KiCad reads: Altium Designer / CircuitStudio / CircuitMaker / Solidworks PCB, Cadence
//! Allegro and OrCAD Capture, Autodesk Eagle, Zuken CADSTAR, Siemens PADS, P-CAD, DipTrace, Easy-PC / DesignSpark,
//! TARGET 3001!, Sprint Layout, Protel Autotrax, Fabmaster, gEDA / Lepton, LTspice, IPC-2581 (what Flux exports) and
//! ODB++ (Flux and most commercial tools).

use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long one conversion may take; a 500-part board takes a few seconds.
const CONVERT_TIMEOUT: Duration = Duration::from_secs(240);

/// One conversion at a time: an importer holds the whole design in memory.
static CONVERTING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// The kicad-cli that converts: `KICAD_IMPORT_CLI`, else the one the Docker image installs, else `KICAD_CLI`.
pub fn cli() -> Option<String> {
    if let Some(p) = std::env::var("KICAD_IMPORT_CLI").ok().filter(|s| !s.is_empty()) {
        return Some(p);
    }
    for p in ["/opt/junction/kicad-cli", "/usr/local/bin/junction-kicad-cli"] {
        if Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    std::env::var("KICAD_CLI").ok().filter(|s| !s.is_empty())
}

/// A file name that is another tool's design by its extension alone.
pub fn is_source_ext(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(
        ext.as_str(),
        // EasyEDA / JLCEDA
        "epro" | "epro2" | "eprj" | "elibz" | "elibz2" | "esch" | "epcb" | "esym" | "efoo" | "eblob" | "ecop"
        // Altium Designer, CircuitStudio, CircuitMaker, Solidworks PCB
        | "pcbdoc" | "schdoc" | "cmpcbdoc" | "cspcbdoc" | "swpcbdoc" | "cmschdoc" | "csschdoc" | "prjpcb"
        // Cadence Allegro / OrCAD (Eagle 6+ XML boards are .brd as well)
        | "brd" | "mdd" | "dsn"
        // Autodesk Eagle schematics, P-CAD, gEDA, Easy-PC and legacy KiCad 4/5 schematics
        | "sch"
        // Zuken CADSTAR archives
        | "cpa" | "csa"
        // DipTrace, Sprint Layout, TARGET 3001!, Fabmaster
        | "dip" | "dch" | "lay6" | "lay" | "t3001" | "fab"
        // P-CAD, gEDA, Easy-PC, Autotrax and PADS binary boards; Easy-PC projects
        | "pcb" | "prj"
        // PADS ASCII, LTspice
        | "asc"
        // IPC-2581 (Flux, Altium, Allegro, Xpedition exports)
        | "cvg"
    )
}

/// A file whose extension other tools share with unrelated files (.txt, .xml, .json): decided by its start.
pub fn is_source_text(name: &str, head: &[u8]) -> bool {
    let lower = name.to_ascii_lowercase();
    let text = String::from_utf8_lossy(&head[..head.len().min(8192)]);
    if lower.ends_with(".json") {
        // an unpacked EasyEDA Pro project keeps its index in project.json
        let pro_index = lower.rsplit('/').next() == Some("project.json")
            && text.contains("\"schematics\"") && text.contains("\"pcbs\"");
        return pro_index || is_std_json(head);
    }
    if lower.ends_with(".xml") {
        return text.contains("<IPC-2581") || text.contains("IPC-2581");
    }
    if lower.ends_with(".txt") {
        // PADS ASCII (!PADS-POWERPCB, *PADS-LOGIC*) and Fabmaster extracts (A!...)
        let t = text.trim_start();
        return t.starts_with("!PADS") || t.starts_with("*PADS") || t.starts_with("A!");
    }
    false
}

/// An EasyEDA Standard source file: JSON with the document header EasyEDA writes.  Only the start is read.
pub fn is_std_json(head: &[u8]) -> bool {
    let text = String::from_utf8_lossy(&head[..head.len().min(8192)]);
    let t = text.trim_start_matches('\u{feff}').trim_start();
    t.starts_with('{')
        && (text.contains("\"docType\"") || text.contains("\"editorVersion\""))
        && (text.contains("\"head\"") || text.contains("\"schematics\"") || text.contains("\"canvas\"")
            || text.contains("\"dataStr\""))
}

/// Whether an upload part named `name` (already spooled at `at`) is another tool's design.
pub fn is_source(name: &str, at: &Path) -> bool {
    if is_source_ext(name) {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".json") || lower.ends_with(".xml") || lower.ends_with(".txt") {
        return std::fs::File::open(at)
            .ok()
            .and_then(|f| {
                use std::io::Read;
                let mut buf = Vec::with_capacity(8192);
                f.take(8192).read_to_end(&mut buf).ok()?;
                Some(is_source_text(name, &buf))
            })
            .unwrap_or(false);
    }
    if lower.ends_with(".zip") {
        return zip_is_source(at);
    }
    false
}

/// What an upload part's name may be before its content is looked at.
pub fn may_be_source(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    is_source_ext(&l) || l.ends_with(".json") || l.ends_with(".xml") || l.ends_with(".txt") || l.ends_with(".zip")
}

/// A .zip that is another tool's design rather than a zipped KiCad project: an EasyEDA Pro project export
/// (project.json at the top), an EasyEDA Standard backup (source JSON files), an ODB++ job (matrix/matrix), or a
/// zipped folder of another tool's files, with no KiCad project files.
pub fn zip_is_source(at: &Path) -> bool {
    let Ok(file) = std::fs::File::open(at) else { return false };
    zip_reader_is_source(std::io::BufReader::new(file), 0)
}

fn zip_reader_is_source<R: std::io::Read + std::io::Seek>(reader: R, depth: u8) -> bool {
    let Ok(mut zip) = zip::ZipArchive::new(reader) else { return false };
    let mut kicad = false;
    let mut easyeda = false;
    for i in 0..zip.len() {
        let Ok(mut f) = zip.by_index(i) else { continue };
        let name = f.name().to_string();
        let base = name.rsplit('/').next().unwrap_or(&name).to_ascii_lowercase();
        if base.ends_with(".kicad_pro") || base.ends_with(".kicad_sch") || base.ends_with(".kicad_pcb") {
            kicad = true;
        } else if (base == "project.json" && !name.contains('/')) || is_source_ext(&base)
            || name.to_ascii_lowercase().ends_with("matrix/matrix")
        {
            easyeda = true;
        } else if base.ends_with(".zip") && depth == 0 && !easyeda && f.size() < 256 * 1024 * 1024 {
            // EasyEDA Standard's "Backup Projects" zips each project's own zip of source files
            use std::io::Read;
            let mut inner = Vec::new();
            if (&mut f).take(256 * 1024 * 1024).read_to_end(&mut inner).is_ok()
                && zip_reader_is_source(std::io::Cursor::new(inner), 1)
            {
                easyeda = true;
            }
        } else if (base.ends_with(".json") || base.ends_with(".xml") || base.ends_with(".txt")) && !easyeda {
            use std::io::Read;
            let mut buf = Vec::with_capacity(8192);
            if (&mut f).take(8192).read_to_end(&mut buf).is_ok() && is_source_text(&base, &buf) {
                easyeda = true;
            }
        }
    }
    easyeda && !kicad
}

/// The tool a set of uploaded files most likely came from, for the "Converted from ..." line.
pub fn format_name(inputs: &[(String, PathBuf)]) -> String {
    let ext = |n: &str| n.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    for (n, _) in inputs {
        let name = match ext(n).as_str() {
            "epro" | "epro2" | "eprj" | "elibz" | "elibz2" | "esch" | "epcb" | "json" => "EasyEDA",
            "pcbdoc" | "schdoc" | "cmpcbdoc" | "cspcbdoc" | "cmschdoc" | "csschdoc" | "prjpcb" => "Altium",
            "swpcbdoc" => "Solidworks PCB",
            "mdd" | "dsn" => "Cadence OrCAD / Allegro",
            "cpa" | "csa" => "CADSTAR",
            "dip" | "dch" => "DipTrace",
            "lay6" | "lay" => "Sprint Layout",
            "t3001" => "TARGET 3001!",
            "fab" => "Fabmaster",
            "cvg" | "xml" => "IPC-2581",
            "asc" | "txt" => "PADS",
            "brd" => "Eagle / Allegro",
            "sch" => "Eagle",
            "pcb" | "prj" => "another EDA tool",
            "zip" => {
                let l = n.to_ascii_lowercase();
                let at = inputs.iter().find(|(m, _)| m == n).map(|(_, p)| p.as_path()).unwrap_or(Path::new(""));
                if l.contains("odb") { "ODB++" } else if zip_needs_unpacking(at) {
                    // the tool of the design files inside
                    let inner: Vec<(String, PathBuf)> = std::fs::File::open(at)
                        .ok()
                        .and_then(|f| zip::ZipArchive::new(std::io::BufReader::new(f)).ok())
                        .map(|z| z.file_names().filter(|m| is_source_ext(m)).map(|m| (m.to_string(), PathBuf::new())).collect())
                        .unwrap_or_default();
                    return format_name(&inner);
                } else { "EasyEDA" }
            }
            _ => continue,
        };
        return name.to_string();
    }
    "another EDA tool".into()
}

/// The project name an EasyEDA export's file name suggests: "ProProject_Yuzuki Chameleon_2023-09-02.epro" is
/// "Yuzuki Chameleon", "PCB_MUSICA.json" is "MUSICA".
pub fn project_name_for(file_name: &str) -> String {
    let base = file_name.rsplit('/').next().unwrap_or(file_name);
    let mut stem = match base.rfind('.') {
        Some(i) if i > 0 => &base[..i],
        _ => base,
    }
    .to_string();
    for prefix in ["ProProject_", "ProPrj_", "ProDoc_", "BackupProjects_", "PCB_PCB_", "SCH_SCH_", "PCB_", "SCH_", "Schematic_"] {
        if stem.len() > prefix.len() && stem.starts_with(prefix) {
            stem = stem[prefix.len()..].to_string();
            break;
        }
    }
    // a trailing export date (and the time some exports add)
    if let Some(at) = stem.rfind('_') {
        let tail = &stem[at + 1..];
        let date = tail.len() >= 10 && tail.as_bytes()[4] == b'-' && tail.as_bytes()[7] == b'-'
            && tail[..4].chars().all(|c| c.is_ascii_digit());
        if date && at > 0 {
            stem.truncate(at);
        }
    }
    let stem = stem.trim().to_string();
    if stem.is_empty() { "EasyEDA import".to_string() } else { stem }
}

/// A file name safe to hand kicad-cli (it sees the extension to pick the importer).
fn safe_file_name(name: &str, n: usize) -> String {
    let base = name.rsplit('/').next().unwrap_or(name);
    let clean: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ' | '(' | ')') { c } else { '_' })
        .collect();
    let clean = clean.trim_start_matches('.').to_string();
    if clean.is_empty() { format!("input-{n}") } else { clean }
}

/// The project-file-safe stem for the converted files.
fn safe_stem(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | ' ') { c } else { '_' })
        .collect();
    let s = s.trim().to_string();
    if s.is_empty() { "imported".into() } else { s }
}

/// Whether a .zip is a plain zipped folder of another tool's files that `kicad-cli import` cannot read as it is
/// (Altium, Eagle, OrCAD ..., or an unpacked EasyEDA Pro project inside a folder).  EasyEDA Pro exports
/// (project.json at the top), EasyEDA Standard zips and ODB++ jobs are read as zips by their importers.
fn zip_needs_unpacking(at: &Path) -> bool {
    let Ok(file) = std::fs::File::open(at) else { return false };
    let Ok(mut zip) = zip::ZipArchive::new(std::io::BufReader::new(file)) else { return false };
    let mut foreign = false;
    for i in 0..zip.len() {
        let Ok(f) = zip.by_index_raw(i) else { continue };
        let name = f.name().to_ascii_lowercase();
        let base = name.rsplit('/').next().unwrap_or(&name);
        if name == "project.json" || name.ends_with("matrix/matrix") {
            return false;
        }
        let easyeda_part = ["esch", "epcb", "esym", "efoo", "eblob", "ecop", "json"].iter().any(|e| base.ends_with(&format!(".{e}")));
        if (base == "project.json" && name.contains('/')) || (is_source_ext(base) && !easyeda_part) {
            foreign = true;
        }
    }
    foreign
}

/// The files of a zipped folder, extracted under `dest` and named by their path in the zip.
fn unpack_zip(at: &Path, dest: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    use std::io::Read;
    const MAX_TOTAL: u64 = 1024 * 1024 * 1024;
    let file = std::fs::File::open(at).map_err(|e| format!("open zip: {e}"))?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| format!("read zip: {e}"))?;
    let mut out = Vec::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| format!("read zip: {e}"))?;
        if f.is_dir() { continue; }
        let Some(rel) = f.enclosed_name() else { continue };
        let name = rel.to_string_lossy().replace('\\', "/");
        if name.starts_with("__MACOSX/") || name.rsplit('/').next().is_some_and(|b| b.starts_with("._")) { continue; }
        total += f.size();
        if total > MAX_TOTAL { return Err("The zip unpacks to more than 1 GB.".into()); }
        let to = dest.join(format!("{i}"));
        let mut w = std::fs::File::create(&to).map_err(|e| format!("unpack zip: {e}"))?;
        std::io::copy(&mut (&mut f).take(MAX_TOTAL), &mut w).map_err(|e| format!("unpack zip: {e}"))?;
        out.push((name, to));
    }
    Ok(out)
}

/// `inputs` with each zipped folder replaced by the design files inside it.
fn unpack_folder_zips(inputs: &[(String, PathBuf)], work: &Path) -> Result<Option<Vec<(String, PathBuf)>>, String> {
    if !inputs.iter().any(|(n, at)| n.to_ascii_lowercase().ends_with(".zip") && zip_needs_unpacking(at)) {
        return Ok(None);
    }
    let mut out = Vec::new();
    for (k, (n, at)) in inputs.iter().enumerate() {
        if !(n.to_ascii_lowercase().ends_with(".zip") && zip_needs_unpacking(at)) {
            out.push((n.clone(), at.clone()));
            continue;
        }
        let dest = work.join(format!("unzip-{k}"));
        std::fs::create_dir_all(&dest).map_err(|e| format!("unpack zip: {e}"))?;
        for (name, file) in unpack_zip(at, &dest)? {
            // the project folder's Pro parts go to pack_unpacked_pro whatever their content; the rest only when
            // they are a design
            let top_part = name.split('/').any(|seg| matches!(seg, "SHEET" | "PCB" | "SYMBOL" | "FOOTPRINT" | "POUR" | "BLOB" | "INSTANCE" | "PANEL" | "FONT"));
            if top_part || is_source(&name, &file) {
                out.push((name, file));
            }
        }
    }
    if out.is_empty() {
        return Err("The zip holds no design files that can be imported.".into());
    }
    Ok(Some(out))
}

/// When `inputs` hold an unpacked EasyEDA Pro project, the .epro made from it (and the other inputs).
fn pack_unpacked_pro(inputs: &[(String, PathBuf)], work: &Path) -> Result<Option<Vec<(String, PathBuf)>>, String> {
    let Some((index, _)) = inputs.iter().find(|(n, _)| n.rsplit('/').next().map(|b| b.eq_ignore_ascii_case("project.json")) == Some(true)) else {
        return Ok(None);
    };
    let root = match index.rfind('/') { Some(i) => &index[..=i], None => "" };
    let name = root.trim_end_matches('/').rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or("project");
    let epro = work.join(format!("{}.epro", safe_stem(name)));
    let file = std::fs::File::create(&epro).map_err(|e| format!("pack project: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut rest = Vec::new();
    for (n, at) in inputs {
        let Some(rel) = n.strip_prefix(root) else { rest.push((n.clone(), at.clone())); continue };
        let top = rel.split('/').next().unwrap_or("");
        let part = rel == "project.json"
            || matches!(top, "SHEET" | "PCB" | "SYMBOL" | "FOOTPRINT" | "POUR" | "BLOB" | "INSTANCE" | "PANEL" | "FONT");
        if !part { rest.push((n.clone(), at.clone())); continue; }
        zip.start_file(rel, opts).map_err(|e| format!("pack project: {e}"))?;
        let mut f = std::fs::File::open(at).map_err(|e| format!("pack project: {e}"))?;
        std::io::copy(&mut f, &mut zip).map_err(|e| format!("pack project: {e}"))?;
    }
    zip.finish().map_err(|e| format!("pack project: {e}"))?;
    rest.insert(0, (format!("{name}.epro"), epro));
    Ok(Some(rest))
}

pub struct Converted {
    /// The KiCad project's files, project-relative, each in its own file under the work folder.
    pub files: Vec<(String, PathBuf)>,
    /// What the importer reported (substituted fonts, parts it could not place, ...).
    pub notes: Vec<String>,
    /// The work folder; the caller removes it once the files are stored.
    pub work: PathBuf,
}

/// Convert EasyEDA `inputs` (original name, spooled file) into a KiCad project named `stem`.
pub async fn convert(inputs: &[(String, PathBuf)], stem: &str) -> Result<Converted, String> {
    let Some(cli) = cli() else {
        return Err("Importing designs from other tools is not available on this server (no kicad-cli).".into());
    };
    let _turn = CONVERTING.acquire().await.map_err(|e| e.to_string())?;

    let work = std::env::temp_dir().join(format!("junction-import-{}", uuid::Uuid::new_v4()));
    let input_dir = work.join("in");
    let out_dir = work.join("out");
    let home = work.join("home");
    for d in [&input_dir, &out_dir, &home] {
        tokio::fs::create_dir_all(d).await.map_err(|e| format!("work folder: {e}"))?;
    }
    let fail = |work: &Path, msg: String| {
        let _ = std::fs::remove_dir_all(work);
        msg
    };

    // An unpacked EasyEDA Pro project (project.json beside SHEET/, PCB/, SYMBOL/, FOOTPRINT/ ...), as people commit
    // it to git: zipped back into the .epro it came from.
    // A zipped folder of another tool's files: the design files inside it
    let unpacked;
    let inputs: &[(String, PathBuf)] = match unpack_folder_zips(inputs, &work) {
        Ok(Some(u)) => {
            unpacked = u;
            &unpacked
        }
        Ok(None) => inputs,
        Err(e) => return Err(fail(&work, e)),
    };
    let packed;
    let inputs: &[(String, PathBuf)] = match pack_unpacked_pro(inputs, &work) {
        Ok(Some(p)) => {
            packed = p;
            &packed
        }
        Ok(None) => inputs,
        Err(e) => return Err(fail(&work, e)),
    };
    if inputs.iter().all(|(n, _)| { let l = n.to_ascii_lowercase(); l.ends_with(".esch") || l.ends_with(".epcb") || l.ends_with(".esym") || l.ends_with(".efoo") }) {
        return Err(fail(&work, "These are documents from inside an EasyEDA Pro project, without the project's parts. \
            Upload the whole project instead: the .epro (or .eprj / .epro2) file, or the folder that holds project.json.".into()));
    }

    // Board files first: `kicad-cli import` tries each input as a board, then as a schematic.
    let mut ordered: Vec<&(String, PathBuf)> = inputs.iter().collect();
    ordered.sort_by_key(|(name, _)| {
        let l = name.to_ascii_lowercase();
        if l.contains("pcb") || l.ends_with(".epcb") { 0 } else { 1 }
    });
    let mut args: Vec<PathBuf> = Vec::new();
    let mut used = std::collections::HashSet::new();
    for (n, (name, at)) in ordered.iter().enumerate() {
        let mut file_name = safe_file_name(name, n);
        while !used.insert(file_name.to_ascii_lowercase()) {
            file_name = format!("{n}-{file_name}");
        }
        let to = input_dir.join(&file_name);
        if tokio::fs::hard_link(at, &to).await.is_err() {
            tokio::fs::copy(at, &to).await.map_err(|e| fail(&work, format!("copy input: {e}")))?;
        }
        args.push(to);
    }

    // Several Altium sheets are one hierarchy: they go in as an Altium project listing them (written afresh, as the
    // uploaded .PrjPcb names the documents by the paths they had on the designer's computer)
    let has_ext = |p: &Path, e: &str| p.extension().is_some_and(|x| x.eq_ignore_ascii_case(e));
    let sheets: Vec<PathBuf> = args.iter().filter(|p| has_ext(p, "schdoc")).cloned().collect();
    if sheets.len() > 1 || args.iter().any(|p| has_ext(p, "prjpcb")) {
        args.retain(|p| !has_ext(p, "prjpcb"));
        if !sheets.is_empty() {
            let mut prj = String::from("[Design]\r\n");
            let docs = args.iter().filter(|p| has_ext(p, "pcbdoc")).take(1).chain(sheets.iter());
            for (k, doc) in docs.enumerate() {
                let name = doc.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                prj.push_str(&format!("\r\n[Document{}]\r\nDocumentPath={}\r\n", k + 1, name));
            }
            let at = input_dir.join("project.PrjPcb");
            tokio::fs::write(&at, prj).await.map_err(|e| fail(&work, format!("write project: {e}")))?;
            args.retain(|p| !has_ext(p, "schdoc"));
            args.push(at);
        }
    }

    let stem = safe_stem(stem);
    let mut cmd = tokio::process::Command::new(&cli);
    cmd.arg("import").arg("-o").arg(out_dir.join(&stem)).args(&args);
    // settings and caches of the importer stay in the work folder
    cmd.env("HOME", &home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .current_dir(&work)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = match tokio::time::timeout(CONVERT_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(fail(&work, format!("Could not run the importer: {e}"))),
        Err(_) => return Err(fail(&work, "The import took too long and was stopped.".into())),
    };
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let notes: Vec<String> = stdout
        .lines()
        .chain(stderr.lines())
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty() && !l.starts_with("Created project") && !l.contains("Gtk-") && !l.contains("dbus"))
        .take(200)
        .collect();
    if !output.status.success() {
        let why = notes.iter().rev().find(|l| !l.is_empty()).cloned().unwrap_or_else(|| "unknown error".into());
        tracing::warn!(status = ?output.status, %stderr, "non-KiCad import failed");
        return Err(fail(&work, format!("This file could not be converted: {why}")));
    }

    let mut files = Vec::new();
    let mut stack = vec![out_dir.clone()];
    while let Some(dir) = stack.pop() {
        let mut rd = tokio::fs::read_dir(&dir).await.map_err(|e| fail(&work, format!("read output: {e}")))?;
        while let Ok(Some(entry)) = rd.next_entry().await {
            let path = entry.path();
            let Ok(kind) = entry.file_type().await else { continue };
            if kind.is_dir() {
                stack.push(path);
                continue;
            }
            let Ok(rel) = path.strip_prefix(&out_dir) else { continue };
            let rel = rel.to_string_lossy().replace('\\', "/");
            // the importer's backups and lock files are not part of the project
            if rel.ends_with(".lck") || rel.contains("-backups/") || rel.starts_with(".history/") {
                continue;
            }
            if !crate::http::allowed_file(&rel) {
                continue;
            }
            files.push((rel, path));
        }
    }
    files.sort();
    if !files.iter().any(|(n, _)| n.ends_with(".kicad_pcb") || n.ends_with(".kicad_sch")) {
        return Err(fail(&work, "The importer made no board or schematic from this file.".into()));
    }
    Ok(Converted { files, notes, work })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_from_exports() {
        assert_eq!(project_name_for("ProProject_Yuzuki Chameleon_2023-09-02.epro"), "Yuzuki Chameleon");
        assert_eq!(project_name_for("PCB_MUSICA.json"), "MUSICA");
        assert_eq!(project_name_for("hardware/Athena.eprj"), "Athena");
        assert_eq!(project_name_for("ProPrj_Entrylens_2026-11-04.epro2"), "Entrylens");
        assert_eq!(project_name_for("BackupProjects_ESP32-PICO-D4_smart_watch.zip"), "ESP32-PICO-D4_smart_watch");
    }

    #[test]
    fn sniffs_std_json() {
        assert!(is_std_json(br#"{"head":{"docType":"3","editorVersion":"6.5.42"},"canvas":"CA~"}"#));
        assert!(is_std_json(br#"{"editorVersion":"6.4.7","docType":"5","title":"x","schematics":[]}"#));
        assert!(!is_std_json(br#"{"name":"package","version":"1.0.0"}"#));
        assert!(!is_std_json(b"(kicad_pcb (version 20240108))"));
    }

    #[test]
    fn source_extensions() {
        for n in ["a.epro", "b.EPRJ", "c.epro2", "d.elibz", "e.elibz2", "x.PcbDoc", "y.SchDoc", "z.brd", "w.cpa", "v.T3001"] {
            assert!(is_source_ext(n), "{n}");
        }
        assert!(!is_source_ext("board.kicad_pcb"));
        assert!(is_source_text("job.xml", br#"<?xml version="1.0"?><IPC-2581 revision="C">"#));
        assert!(!is_source_text("pom.xml", br#"<?xml version="1.0"?><project>"#));
        assert!(is_source_text("board.txt", b"!PADS-POWERPCB-V9.0-MILS!"));
        assert!(!is_source_text("README.txt", b"hello"));
    }

    #[test]
    fn unpacks_only_folder_zips() {
        let dir = std::env::temp_dir().join(format!("nk-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let make = |name: &str, entries: &[&str]| {
            let at = dir.join(name);
            let mut z = zip::ZipWriter::new(std::fs::File::create(&at).unwrap());
            for e in entries {
                z.start_file(*e, zip::write::SimpleFileOptions::default()).unwrap();
                std::io::Write::write_all(&mut z, b"x").unwrap();
            }
            z.finish().unwrap();
            at
        };
        assert!(zip_needs_unpacking(&make("altium.zip", &["proj/board.PcbDoc", "proj/a.SchDoc", "proj/readme.pdf"])));
        assert!(zip_needs_unpacking(&make("eagle.zip", &["x/board.brd", "x/board.sch"])));
        assert!(zip_needs_unpacking(&make("pro-folder.zip", &["athena/project.json", "athena/SHEET/1/1.esch"])));
        assert!(!zip_needs_unpacking(&make("pro.zip", &["project.json", "SHEET/1/1.esch"])));
        assert!(!zip_needs_unpacking(&make("odb.zip", &["job/matrix/matrix", "job/steps/pcb/profile"])));
        assert!(!zip_needs_unpacking(&make("std.zip", &["PCB_x.json", "SCH_x.json"])));
        let files = unpack_zip(&dir.join("altium.zip"), &dir).unwrap();
        assert_eq!(files.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["proj/board.PcbDoc", "proj/a.SchDoc", "proj/readme.pdf"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
