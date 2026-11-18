//! What the platform needs to know about a kind of document, in one place.
//!
//! Projects hold documents of several domains: KiCad's schematics and boards, part studios,
//! assemblies, and files that only ride along (a 3D model, a library table).  The platform
//! features that are the same for every domain (version history, branches, merging, the
//! journal fold, thumbnails, the AI tools) ask here how a kind behaves instead of naming
//! document types themselves.  A new kind is one entry in `KINDS` (and, for its files to be
//! accepted at all, `http.rs` `doc_type_for` / `allowed_file`).
//!
//! This is the first part of the roadmap's "document interface".  KiCad's own paths are
//! described here, not rewritten: every answer for `kicad_sch` and `kicad_pcb` is what the
//! code that asked used to decide for itself.

use crate::merge::{self, Prefer};
use crate::itemmerge;

/// How a document's edits are stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Journal {
    /// Item by item, as ops after a snapshot (`ws.rs`, `doc_actor.rs`).
    Ops,
    /// Whole: each edit is a new snapshot.
    Whole,
}

/// Who can fold a journal of ops into a new stored file (`compact.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fold {
    /// The headless editor (`mcp_host.rs`): only it can read and write the format.
    Editor,
    /// This server: the changes are plain JSON (`itemdoc.rs`).
    Server,
    None,
}

/// How a branch's work on a journalled document is brought to the other side (`versions.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BranchMerge {
    /// The ops are replayed; an item both sides touched is a conflict (KiCad).
    Items,
    /// The net effect per item and path is replayed; a path both sides touched is a
    /// conflict (`itemmerge.rs`).
    Paths,
    /// Not journalled: the whole file is taken, or kept.
    File,
}

/// How two stored files of the kind are merged with a common ancestor (a GitHub pull).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileMerge {
    /// KiCad's s-expressions (`merge.rs`).
    Sexpr,
    /// JSON item documents (`itemmerge.rs`).
    Items,
    None,
}

#[derive(Debug)]
pub struct DocKind {
    /// What a person (and an AI assistant) calls a document of this kind.
    pub name: &'static str,
    pub journal: Journal,
    pub fold: Fold,
    pub branch_merge: BranchMerge,
    pub file_merge: FileMerge,
    /// A picture of it can stand for the project when the project has no board or schematic
    /// picture (`http.rs` `preview_svg`).
    pub thumbnail: bool,
}

const KICAD_DESIGN: DocKind = DocKind { name: "", journal: Journal::Ops, fold: Fold::Editor, branch_merge: BranchMerge::Items, file_merge: FileMerge::Sexpr, thumbnail: true };
const ITEM_DOC: DocKind = DocKind { name: "", journal: Journal::Ops, fold: Fold::Server, branch_merge: BranchMerge::Paths, file_merge: FileMerge::Items, thumbnail: true };
const SEXPR_FILE: DocKind = DocKind { name: "", journal: Journal::Whole, fold: Fold::None, branch_merge: BranchMerge::File, file_merge: FileMerge::Sexpr, thumbnail: false };
const PLAIN_FILE: DocKind = DocKind { name: "other", journal: Journal::Whole, fold: Fold::None, branch_merge: BranchMerge::File, file_merge: FileMerge::None, thumbnail: false };

const KINDS: &[(&str, DocKind)] = &[
    ("kicad_sch", DocKind { name: "schematic", ..KICAD_DESIGN }),
    ("kicad_pcb", DocKind { name: "board", ..KICAD_DESIGN }),
    ("part_studio", DocKind { name: "part studio", ..ITEM_DOC }),
    ("assembly", DocKind { name: "assembly", ..ITEM_DOC }),
    ("project_shell", DocKind { name: "project", thumbnail: false, ..ITEM_DOC }),
    ("kicad_pro", DocKind { name: "project file", ..PLAIN_FILE }),
    ("symbol_lib", DocKind { name: "symbol library", ..SEXPR_FILE }),
    ("footprint", DocKind { name: "footprint", ..SEXPR_FILE }),
    ("worksheet", DocKind { name: "drawing sheet", ..SEXPR_FILE }),
];

/// The kind of a document type (`documents.doc_type`).  A type not listed is a plain file.
pub fn of(doc_type: &str) -> &'static DocKind {
    KINDS.iter().find(|(t, _)| *t == doc_type).map(|(_, k)| k).unwrap_or(&PLAIN_FILE)
}

impl DocKind {
    pub fn journalled(&self) -> bool {
        self.journal == Journal::Ops
    }
    pub fn file_mergeable(&self) -> bool {
        self.file_merge != FileMerge::None
    }
}

/// Whether a stored file is a JSON item document, whatever it is called.
fn is_item_text(text: &str) -> bool {
    text.trim_start().starts_with('{') && itemmerge::items_of(text).is_some()
}

/// Merge `theirs` into `ours` with `base` as the common ancestor, by the rules of the kind
/// the files are (told by their content: an s-expression or a JSON item document).
pub fn merge3_text(base: Option<&str>, ours: &str, theirs: &str, prefer: Prefer) -> Option<merge::Merged> {
    if !is_item_text(ours) {
        return merge::merge3(base, ours, theirs, prefer);
    }
    let m = itemmerge::merge3_text(base, ours, theirs, prefer == Prefer::Theirs)?;
    Some(merge::Merged {
        text: m.text,
        conflicts: m.conflicts.into_iter().map(|(item, kept)| merge::Conflict { item, kept }).collect(),
        from_theirs: m.from_theirs,
        from_ours: m.from_ours,
    })
}

/// What turned one stored file into another, item by item.
pub fn diff_text(old: &str, new: &str) -> Option<Vec<merge::ItemChange>> {
    if !is_item_text(new) {
        return merge::diff(old, new);
    }
    Some(itemmerge::diff_text(old, new)?.into_iter().map(|(kind, item, parts)| merge::ItemChange { kind, item, parts }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::itemdoc;

    #[test]
    fn kicad_kinds_answer_as_the_platform_always_decided() {
        for t in ["kicad_sch", "kicad_pcb"] {
            let k = of(t);
            assert!(k.journalled() && k.fold == Fold::Editor && k.branch_merge == BranchMerge::Items && k.file_mergeable());
        }
        // exactly the types merge.rs calls mergeable, plus the item documents
        for t in ["kicad_sch", "kicad_pcb", "symbol_lib", "footprint", "worksheet", "kicad_pro", "model3d", "lib_table", "other", "spice_model"] {
            assert_eq!(of(t).file_merge == FileMerge::Sexpr, merge::mergeable(t), "{t}");
        }
        assert!(!of("kicad_pro").journalled() && !of("model3d").journalled());
    }

    #[test]
    fn item_documents_are_journalled_and_folded_here() {
        for t in ["part_studio", "assembly"] {
            let k = of(t);
            assert!(itemdoc::is_item_doc(t));
            assert!(k.journalled() && k.fold == Fold::Server && k.branch_merge == BranchMerge::Paths && k.file_merge == FileMerge::Items && k.thumbnail);
        }
        assert_eq!(of("part_studio").name, "part studio");
    }

    #[test]
    fn files_are_merged_by_what_they_are() {
        let base = "{\"junction\":\"part-studio\",\"version\":1,\"items\":[\n{\"id\":\"b\",\"name\":\"Extrude 1\",\"params\":{\"depth\":5,\"draft\":0},\"type\":\"feature\"}\n]}\n";
        let ours = base.replace("\"depth\":5", "\"depth\":9");
        let theirs = base.replace("\"draft\":0", "\"draft\":2");
        let m = merge3_text(Some(base), &ours, &theirs, Prefer::Theirs).unwrap();
        assert!(m.text.contains("\"depth\":9") && m.text.contains("\"draft\":2") && m.conflicts.is_empty());
        let d = diff_text(base, &m.text).unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!((d[0].kind, d[0].item.as_str()), ("changed", "Extrude 1"));
        // an s-expression still goes to merge.rs
        let sexpr = "(kicad_pcb (version 1) (segment (uuid \"a\")))";
        assert!(merge3_text(Some(sexpr), sexpr, sexpr, Prefer::Ours).is_some());
        assert!(diff_text(sexpr, sexpr).is_some_and(|d| d.is_empty()));
    }
}
