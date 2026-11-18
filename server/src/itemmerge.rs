//! Three-way merge of JSON item documents (a part studio, an assembly), item by item and
//! path by path.
//!
//! The change model of these documents (itemdoc.rs) is already a merge rule for people
//! editing at the same moment: a change names an item and the paths it sets, and the last
//! writer of a path wins.  A branch is the same thing with a long delay, except that
//! "last" no longer means anything, so where the two sides touched the same thing a person
//! chooses.  This module is that step, and nothing else:
//!
//! - `net_of_ops` / `net_of_diff`: what one side did since the two last agreed, as one net
//!   effect per item (added or replaced whole, removed, or a set of paths set or deleted).
//! - `conflicts`: where two net effects meet.  The rules:
//!     * different items never conflict, and neither do different paths of one item
//!       (two parameters of one feature, two entities of one sketch);
//!     * the same path set to the same value on both sides is not a conflict;
//!     * the same path set differently, or a path on one side that lies inside a path
//!       the other side set, is a conflict at the shorter path;
//!     * an item removed on one side and changed on the other is a conflict on the item,
//!       and so is an item replaced whole on one side and touched on the other;
//!     * removed on both sides is not a conflict.
//! - `resolve`: the incoming side's changes with the conflicts a person gave to the
//!   current side left out, as ordinary item changes for the op path.
//! - `merge3_text`: the same for three stored files (a GitHub pull).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use crate::itemdoc;

pub type Path = Vec<String>;

/// What one side did to one item.
#[derive(Debug, Clone, PartialEq)]
pub enum ItemNet {
    /// Added, or replaced whole (the item as that side left it).
    Whole(Value),
    Removed,
    /// Paths set (`Some`) or deleted (`None`).  No path here lies inside another.
    Paths(BTreeMap<Path, Option<Value>>),
}

/// The net effect of one side, by item id.
pub type Net = BTreeMap<String, ItemNet>;

fn starts_with(path: &[String], prefix: &[String]) -> bool {
    path.len() >= prefix.len() && path[..prefix.len()] == *prefix
}

/// Lay one path change over the ones recorded so far.
fn record(paths: &mut BTreeMap<Path, Option<Value>>, path: Path, value: Option<Value>) {
    // what was recorded inside this path is replaced by it
    paths.retain(|p, _| !starts_with(p, &path));
    // a path recorded above this one takes the change into its own value
    if let Some(above) = paths.keys().find(|p| starts_with(&path, p)).cloned() {
        let rest: Vec<&str> = path[above.len()..].iter().map(String::as_str).collect();
        let slot = paths.get_mut(&above).expect("the key was just found");
        match (slot.as_mut(), value) {
            (Some(v), value) => itemdoc::set_path(v, &rest, value),
            // deleted and then set inside: the object exists again, with that alone in it
            (None, Some(value)) => {
                let mut made = Value::Object(Map::new());
                itemdoc::set_path(&mut made, &rest, Some(value));
                *slot = Some(made);
            }
            (None, None) => {}
        }
        return;
    }
    paths.insert(path, value);
}

/// The net effect of a run of ops (each an array of changes), in order.
pub fn net_of_ops<'a>(ops: impl IntoIterator<Item = &'a Value>) -> Net {
    let mut net = Net::new();
    for change in ops {
        let Some(id) = change.get("id").and_then(Value::as_str) else { continue };
        match change.get("kind").and_then(Value::as_str) {
            Some("ADDED") => {
                if let Some(item) = change.get("item").filter(|i| i.is_object()) {
                    let mut item = item.clone();
                    item["id"] = Value::String(id.to_string());
                    net.insert(id.to_string(), ItemNet::Whole(item));
                }
            }
            Some("REMOVED") => {
                net.insert(id.to_string(), ItemNet::Removed);
            }
            Some("MODIFIED") => {
                let entry = net.entry(id.to_string()).or_insert_with(|| ItemNet::Paths(BTreeMap::new()));
                for prop in change.get("props").and_then(Value::as_array).into_iter().flatten() {
                    let path: Path = prop.get("path").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
                    if path.is_empty() || path == ["id"] {
                        continue;
                    }
                    let del = prop.get("del").and_then(Value::as_bool).unwrap_or(false);
                    let value = if del { None } else { Some(prop.get("value").cloned().unwrap_or(Value::Null)) };
                    match entry {
                        // a change to an item that is gone does nothing
                        ItemNet::Removed => {}
                        ItemNet::Whole(item) => {
                            let p: Vec<&str> = path.iter().map(String::as_str).collect();
                            itemdoc::set_path(item, &p, value);
                        }
                        ItemNet::Paths(paths) => record(paths, path, value),
                    }
                }
                if matches!(entry, ItemNet::Paths(p) if p.is_empty()) {
                    net.remove(id);
                }
            }
            _ => {}
        }
    }
    net
}

/// The path changes that turn `before` into `after`: descends into objects, everything
/// else (numbers, strings, arrays) is one value.  The mirror of itemdoc.ts `diffProps`.
fn diff_paths(before: Option<&Value>, after: Option<&Value>, base: &mut Path, out: &mut BTreeMap<Path, Option<Value>>) {
    match (before, after) {
        (Some(Value::Object(b)), Some(Value::Object(a))) => {
            for k in b.keys().filter(|k| !a.contains_key(*k)) {
                base.push(k.clone());
                out.insert(base.clone(), None);
                base.pop();
            }
            for (k, v) in a {
                base.push(k.clone());
                diff_paths(b.get(k), Some(v), base, out);
                base.pop();
            }
        }
        (_, None) => {
            if !base.is_empty() {
                out.insert(base.clone(), None);
            }
        }
        (b, Some(a)) => {
            if b != Some(a) && !base.is_empty() {
                out.insert(base.clone(), Some(a.clone()));
            }
        }
    }
}

/// The items of a stored file, by id.  None when the text is not an item document.
pub fn items_of(text: &str) -> Option<BTreeMap<String, Value>> {
    let doc: Value = serde_json::from_str(text).ok()?;
    doc.get("junction")?.as_str()?;
    let mut out = BTreeMap::new();
    for item in doc.get("items").and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            out.insert(id.to_string(), item.clone());
        }
    }
    Some(out)
}

/// The net effect that turns one set of items into another.
pub fn net_of_diff(base: &BTreeMap<String, Value>, side: &BTreeMap<String, Value>) -> Net {
    let mut net = Net::new();
    for id in base.keys().filter(|id| !side.contains_key(*id)) {
        net.insert(id.clone(), ItemNet::Removed);
    }
    for (id, item) in side {
        match base.get(id) {
            None => {
                net.insert(id.clone(), ItemNet::Whole(item.clone()));
            }
            Some(was) if was != item => {
                let mut paths = BTreeMap::new();
                diff_paths(Some(was), Some(item), &mut Vec::new(), &mut paths);
                paths.remove(&vec!["id".to_string()]);
                if !paths.is_empty() {
                    net.insert(id.clone(), ItemNet::Paths(paths));
                }
            }
            _ => {}
        }
    }
    net
}

/// What one side did at the place of a conflict.
#[derive(Debug, Clone, PartialEq)]
pub enum Did {
    Removed,
    /// added or replaced the whole item
    Replaced,
    /// set the path to this value
    Set(Value),
    /// deleted the path
    Unset,
    /// changed something inside the path
    Inside,
}

impl Did {
    pub fn to_json(&self) -> Value {
        match self {
            Did::Removed => json!({ "did": "removed" }),
            Did::Replaced => json!({ "did": "replaced" }),
            Did::Set(v) => json!({ "did": "set", "value": v }),
            Did::Unset => json!({ "did": "unset" }),
            Did::Inside => json!({ "did": "changed" }),
        }
    }
}

/// One place both sides touched.
#[derive(Debug, Clone, PartialEq)]
pub struct Conflict {
    pub id: String,
    /// None: the item as a whole (one side removed or replaced it).
    pub path: Option<Path>,
    pub incoming: Did,
    pub current: Did,
}

impl Conflict {
    /// A stable name for the conflict, for a person's choice to refer to.
    pub fn key(&self) -> String {
        match &self.path {
            None => self.id.clone(),
            Some(p) => format!("{}#{}", self.id, p.join("/")),
        }
    }
}

fn did_at(paths: &BTreeMap<Path, Option<Value>>, at: &Path) -> Did {
    match paths.get(at) {
        Some(Some(v)) => Did::Set(v.clone()),
        Some(None) => Did::Unset,
        None => Did::Inside,
    }
}

/// Where the incoming side's net effect meets the current side's.
pub fn conflicts(incoming: &Net, current: &Net) -> Vec<Conflict> {
    let mut out = Vec::new();
    for (id, a) in incoming {
        let Some(b) = current.get(id) else { continue };
        let whole = |incoming: Did, current: Did| Conflict { id: id.clone(), path: None, incoming, current };
        match (a, b) {
            (ItemNet::Removed, ItemNet::Removed) => {}
            (ItemNet::Whole(x), ItemNet::Whole(y)) => {
                if x != y {
                    out.push(whole(Did::Replaced, Did::Replaced));
                }
            }
            (ItemNet::Removed, ItemNet::Whole(_)) => out.push(whole(Did::Removed, Did::Replaced)),
            (ItemNet::Removed, ItemNet::Paths(_)) => out.push(whole(Did::Removed, Did::Inside)),
            (ItemNet::Whole(_), ItemNet::Removed) => out.push(whole(Did::Replaced, Did::Removed)),
            (ItemNet::Paths(_), ItemNet::Removed) => out.push(whole(Did::Inside, Did::Removed)),
            (ItemNet::Whole(_), ItemNet::Paths(_)) => out.push(whole(Did::Replaced, Did::Inside)),
            (ItemNet::Paths(_), ItemNet::Whole(_)) => out.push(whole(Did::Inside, Did::Replaced)),
            (ItemNet::Paths(pa), ItemNet::Paths(pb)) => {
                let mut seen: BTreeSet<Path> = BTreeSet::new();
                for (x, vx) in pa {
                    for (y, vy) in pb {
                        if !(starts_with(x, y) || starts_with(y, x)) || (x == y && vx == vy) {
                            continue;
                        }
                        let at = if x.len() <= y.len() { x } else { y };
                        if seen.insert(at.clone()) {
                            out.push(Conflict { id: id.clone(), path: Some(at.clone()), incoming: did_at(pa, at), current: did_at(pb, at) });
                        }
                    }
                }
            }
        }
    }
    out
}

/// The incoming side's changes as item changes for the receiving document, leaving out
/// what lies under a conflict `keep_current` answers true for.
pub fn resolve(incoming: &Net, found: &[Conflict], keep_current: impl Fn(&Conflict) -> bool) -> Vec<Value> {
    let kept: Vec<&Conflict> = found.iter().filter(|c| keep_current(c)).collect();
    let mut out = Vec::new();
    for (id, a) in incoming {
        if kept.iter().any(|c| c.id == *id && c.path.is_none()) {
            continue;
        }
        match a {
            ItemNet::Removed => out.push(json!({ "id": id, "kind": "REMOVED" })),
            ItemNet::Whole(item) => out.push(json!({ "id": id, "kind": "ADDED", "typeName": item.get("type").cloned().unwrap_or(Value::Null), "item": item })),
            ItemNet::Paths(paths) => {
                let props: Vec<Value> = paths
                    .iter()
                    .filter(|(p, _)| !kept.iter().any(|c| c.id == *id && c.path.as_ref().is_some_and(|at| starts_with(p, at))))
                    .map(|(p, v)| match v {
                        Some(v) => json!({ "path": p, "value": v }),
                        None => json!({ "path": p, "del": true }),
                    })
                    .collect();
                if !props.is_empty() {
                    out.push(json!({ "id": id, "kind": "MODIFIED", "props": props }));
                }
            }
        }
    }
    out
}

/// A name a person recognises for an item: its own `name`, else its type and the start of its id.
pub fn item_label(item: Option<&Value>, id: &str) -> String {
    if let Some(name) = item.and_then(|i| i.get("name")).and_then(Value::as_str).filter(|n| !n.is_empty()) {
        return name.to_string();
    }
    let kind = item.and_then(|i| i.get("type")).and_then(Value::as_str).filter(|t| !t.is_empty()).unwrap_or("item");
    if kind == id {
        return format!("{kind} settings");
    }
    format!("{kind} {}", id.chars().take(8).collect::<String>())
}

/// "Extrude 1 › depth": the item and, for a path, where in it (the leading `params` is left out).
pub fn conflict_label(c: &Conflict, item: Option<&Value>) -> String {
    let name = item_label(item, &c.id);
    match &c.path {
        None => name,
        Some(p) => {
            let shown: Vec<&str> = p.iter().map(String::as_str).skip(usize::from(p.len() > 1 && p[0] == "params")).collect();
            format!("{name} › {}", shown.join(" › "))
        }
    }
}

pub struct MergedText {
    pub text: String,
    /// (label, the side whose version went into the result: "ours" or "theirs")
    pub conflicts: Vec<(String, &'static str)>,
    pub from_theirs: usize,
    pub from_ours: usize,
}

/// Merge three stored files: `theirs` into `ours`, with `base` the version both started
/// from.  Without a base every difference of an item both have is a both-sides change and
/// items only one side has are kept.  None when a file is not an item document.
pub fn merge3_text(base: Option<&str>, ours: &str, theirs: &str, prefer_theirs: bool) -> Option<MergedText> {
    let (o, t) = (items_of(ours)?, items_of(theirs)?);
    let (incoming, found, from_ours) = match base.and_then(items_of) {
        Some(b) => {
            let (incoming, current) = (net_of_diff(&b, &t), net_of_diff(&b, &o));
            let found = conflicts(&incoming, &current);
            let from_ours = current.keys().filter(|id| !incoming.contains_key(*id) || found.iter().any(|c| c.id == **id)).count();
            (incoming, found, from_ours)
        }
        None => {
            // two-way: nothing is deleted, and every path that differs is a conflict
            let mut incoming = net_of_diff(&o, &t);
            incoming.retain(|_, n| *n != ItemNet::Removed);
            let mut found = Vec::new();
            for (id, n) in &incoming {
                if let ItemNet::Paths(paths) = n {
                    for (p, v) in paths {
                        let incoming = v.clone().map(Did::Set).unwrap_or(Did::Unset);
                        found.push(Conflict { id: id.clone(), path: Some(p.clone()), incoming, current: Did::Inside });
                    }
                }
            }
            let from_ours = found.iter().map(|c| &c.id).collect::<BTreeSet<_>>().len();
            (incoming, found, from_ours)
        }
    };
    let changes = resolve(&incoming, &found, |_| !prefer_theirs);
    let op = Value::Array(changes.clone());
    let text = itemdoc::fold_text(ours, &[&op]).ok()?;
    let conflicts = found
        .iter()
        .map(|c| (conflict_label(c, o.get(&c.id).or_else(|| t.get(&c.id))), if prefer_theirs { "theirs" } else { "ours" }))
        .collect();
    Some(MergedText { text, conflicts, from_theirs: changes.len(), from_ours })
}

/// What turned one stored file into another, item by item: (kind, label, the parts that differ).
pub fn diff_text(old: &str, new: &str) -> Option<Vec<(&'static str, String, Vec<String>)>> {
    let (o, n) = (items_of(old)?, items_of(new)?);
    let mut out = Vec::new();
    for (id, net) in net_of_diff(&o, &n) {
        let label = item_label(n.get(&id).or_else(|| o.get(&id)), &id);
        match net {
            ItemNet::Whole(_) => out.push(("added", label, Vec::new())),
            ItemNet::Removed => out.push(("removed", label, Vec::new())),
            ItemNet::Paths(paths) => {
                let parts = paths.keys().map(|p| p.iter().skip(usize::from(p.len() > 1 && p[0] == "params")).cloned().collect::<Vec<_>>().join(" › ")).collect();
                out.push(("changed", label, parts));
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(path: &[&str]) -> Path {
        path.iter().map(|s| s.to_string()).collect()
    }
    fn modified(id: &str, props: Value) -> Value {
        json!({ "id": id, "kind": "MODIFIED", "props": props })
    }
    fn net(changes: &[Value]) -> Net {
        net_of_ops(changes.iter())
    }

    #[test]
    fn a_run_of_ops_is_one_net_effect_per_item() {
        let n = net(&[
            modified("e", json!([{ "path": ["params", "depth"], "value": 5 }, { "path": ["name"], "value": "Boss" }])),
            modified("e", json!([{ "path": ["params", "depth"], "value": 8 }])),
            // a whole object set, then a path inside it: the object carries the later change
            modified("s", json!([{ "path": ["params", "sketch"], "value": { "entities": { "p1": { "x": 0 } } } }])),
            modified("s", json!([{ "path": ["params", "sketch", "entities", "p1", "x"], "value": 4 }])),
            // paths inside, then the whole: the whole replaces them
            modified("t", json!([{ "path": ["params", "a", "b"], "value": 1 }])),
            modified("t", json!([{ "path": ["params", "a"], "del": true }])),
            json!({ "id": "new", "kind": "ADDED", "item": { "type": "feature", "params": { "depth": 1 } } }),
            modified("new", json!([{ "path": ["params", "depth"], "value": 2 }])),
            json!({ "id": "gone", "kind": "REMOVED" }),
            modified("gone", json!([{ "path": ["name"], "value": "ghost" }])),
        ]);
        assert_eq!(n["e"], ItemNet::Paths(BTreeMap::from([(p(&["params", "depth"]), Some(json!(8))), (p(&["name"]), Some(json!("Boss")))])));
        assert_eq!(n["s"], ItemNet::Paths(BTreeMap::from([(p(&["params", "sketch"]), Some(json!({ "entities": { "p1": { "x": 4 } } })))])));
        assert_eq!(n["t"], ItemNet::Paths(BTreeMap::from([(p(&["params", "a"]), None)])));
        assert_eq!(n["new"], ItemNet::Whole(json!({ "id": "new", "type": "feature", "params": { "depth": 2 } })));
        assert_eq!(n["gone"], ItemNet::Removed);
    }

    #[test]
    fn different_items_and_different_paths_do_not_conflict() {
        let incoming = net(&[modified("e", json!([{ "path": ["params", "depth"], "value": 8 }])), modified("s", json!([{ "path": ["params", "sketch", "entities", "p1"], "value": { "x": 1 } }]))]);
        let current = net(&[
            modified("e", json!([{ "path": ["params", "draft"], "value": 3 }, { "path": ["name"], "value": "Boss" }])),
            modified("s", json!([{ "path": ["params", "sketch", "entities", "p2"], "value": { "x": 9 } }])),
            modified("other", json!([{ "path": ["params", "depth"], "value": 1 }])),
        ]);
        assert!(conflicts(&incoming, &current).is_empty());
        // everything incoming is carried over
        let changes = resolve(&incoming, &[], |_| true);
        assert_eq!(changes.len(), 2);
    }

    #[test]
    fn the_same_path_set_alike_is_not_a_conflict_and_set_differently_is() {
        let incoming = net(&[modified("e", json!([{ "path": ["params", "depth"], "value": 8 }, { "path": ["params", "angle"], "value": 30 }]))]);
        let current = net(&[modified("e", json!([{ "path": ["params", "depth"], "value": 8 }, { "path": ["params", "angle"], "value": 45 }]))]);
        let found = conflicts(&incoming, &current);
        assert_eq!(found, vec![Conflict { id: "e".into(), path: Some(p(&["params", "angle"])), incoming: Did::Set(json!(30)), current: Did::Set(json!(45)) }]);
        assert_eq!(found[0].key(), "e#params/angle");
        // the incoming side has the last word: both paths are sent; the current side: only the one that agrees
        assert_eq!(resolve(&incoming, &found, |_| false)[0]["props"].as_array().unwrap().len(), 2);
        let kept = resolve(&incoming, &found, |_| true);
        assert_eq!(kept, vec![modified("e", json!([{ "path": ["params", "depth"], "value": 8 }]))]);
    }

    #[test]
    fn a_path_inside_a_path_the_other_side_set_conflicts_at_the_shorter_one() {
        let incoming = net(&[modified("s", json!([{ "path": ["params", "sketch", "entities", "p1", "x"], "value": 4 }, { "path": ["params", "sketch", "entities", "p2", "x"], "value": 5 }]))]);
        let current = net(&[modified("s", json!([{ "path": ["params", "sketch", "entities", "p1"], "del": true }]))]);
        let found = conflicts(&incoming, &current);
        assert_eq!(found, vec![Conflict { id: "s".into(), path: Some(p(&["params", "sketch", "entities", "p1"])), incoming: Did::Inside, current: Did::Unset }]);
        // kept current: the change inside the deleted entity is left out, the other entity's is carried
        assert_eq!(resolve(&incoming, &found, |_| true), vec![modified("s", json!([{ "path": ["params", "sketch", "entities", "p2", "x"], "value": 5 }]))]);
        // and the other way round
        let found = conflicts(&current, &incoming);
        assert_eq!(found[0].incoming, Did::Unset);
        assert_eq!(found[0].current, Did::Inside);
    }

    #[test]
    fn removed_against_changed_is_a_conflict_on_the_item() {
        let incoming = net(&[json!({ "id": "e", "kind": "REMOVED" }), json!({ "id": "f", "kind": "REMOVED" })]);
        let current = net(&[modified("e", json!([{ "path": ["params", "depth"], "value": 8 }])), json!({ "id": "f", "kind": "REMOVED" })]);
        let found = conflicts(&incoming, &current);
        assert_eq!(found, vec![Conflict { id: "e".into(), path: None, incoming: Did::Removed, current: Did::Inside }]);
        // removed on both sides is no conflict, and is still sent (it does nothing there)
        assert_eq!(resolve(&incoming, &found, |_| true), vec![json!({ "id": "f", "kind": "REMOVED" })]);
        assert_eq!(resolve(&incoming, &found, |_| false).len(), 2);
        // seen from the other side
        let found = conflicts(&current, &incoming);
        assert_eq!(found, vec![Conflict { id: "e".into(), path: None, incoming: Did::Inside, current: Did::Removed }]);
    }

    #[test]
    fn a_choice_is_made_conflict_by_conflict() {
        let incoming = net(&[modified("e", json!([{ "path": ["params", "depth"], "value": 8 }, { "path": ["name"], "value": "Theirs" }]))]);
        let current = net(&[modified("e", json!([{ "path": ["params", "depth"], "value": 9 }, { "path": ["name"], "value": "Ours" }]))]);
        let found = conflicts(&incoming, &current);
        assert_eq!(found.len(), 2);
        let changes = resolve(&incoming, &found, |c| c.key() == "e#name");
        assert_eq!(changes, vec![modified("e", json!([{ "path": ["params", "depth"], "value": 8 }]))]);
    }

    const BASE: &str = r#"{"junction":"part-studio","version":1,"items":[
{"id":"a","type":"feature","featureType":"sketch","name":"Sketch 1","order":"V","params":{"sketch":{"entities":{"p1":{"type":"point","x":0,"y":0},"p2":{"type":"point","x":10,"y":0}}}}},
{"id":"b","type":"feature","featureType":"extrude","name":"Extrude 1","order":"k","params":{"depth":5,"operation":"new"}},
{"id":"studio","type":"studio","units":"mm","rollback":null}
]}"#;

    fn edit(text: &str, changes: Value) -> String {
        itemdoc::fold_text(text, &[&changes]).unwrap()
    }

    #[test]
    fn three_files_merge_item_by_item() {
        let ours = edit(BASE, json!([modified("b", json!([{ "path": ["params", "depth"], "value": 12 }])), modified("a", json!([{ "path": ["params", "sketch", "entities", "p1", "x"], "value": -5 }]))]));
        let theirs = edit(BASE, json!([
            modified("b", json!([{ "path": ["params", "operation"], "value": "add" }, { "path": ["name"], "value": "Boss" }])),
            modified("a", json!([{ "path": ["params", "sketch", "entities", "p2", "x"], "value": 20 }])),
            { "id": "c", "kind": "ADDED", "item": { "type": "feature", "featureType": "fillet", "name": "Fillet 1", "order": "s", "params": {} } },
        ]));
        let m = merge3_text(Some(BASE), &ours, &theirs, true).unwrap();
        assert!(m.conflicts.is_empty());
        let items = items_of(&m.text).unwrap();
        assert_eq!(items["b"]["params"], json!({ "depth": 12, "operation": "add" }));
        assert_eq!(items["b"]["name"], "Boss");
        assert_eq!(items["a"]["params"]["sketch"]["entities"]["p1"]["x"], -5);
        assert_eq!(items["a"]["params"]["sketch"]["entities"]["p2"]["x"], 20);
        assert_eq!(items["c"]["name"], "Fillet 1");
        // merging what is already merged changes nothing
        assert_eq!(merge3_text(Some(BASE), &m.text, &theirs, true).unwrap().text, m.text);
    }

    #[test]
    fn three_files_with_a_conflict_take_the_preferred_side() {
        let ours = edit(BASE, json!([modified("b", json!([{ "path": ["params", "depth"], "value": 12 }]))]));
        let theirs = edit(BASE, json!([modified("b", json!([{ "path": ["params", "depth"], "value": 7 }])), { "id": "a", "kind": "REMOVED" }]));
        let m = merge3_text(Some(BASE), &ours, &theirs, true).unwrap();
        assert_eq!(m.conflicts, vec![("Extrude 1 › depth".to_string(), "theirs")]);
        let items = items_of(&m.text).unwrap();
        assert_eq!(items["b"]["params"]["depth"], 7);
        assert!(!items.contains_key("a"));
        let m = merge3_text(Some(BASE), &ours, &theirs, false).unwrap();
        assert_eq!(m.conflicts, vec![("Extrude 1 › depth".to_string(), "ours")]);
        assert_eq!(items_of(&m.text).unwrap()["b"]["params"]["depth"], 12);
    }

    #[test]
    fn two_files_without_a_base_delete_nothing() {
        let ours = edit(BASE, json!([{ "id": "mine", "kind": "ADDED", "item": { "type": "feature", "name": "Mine" } }]));
        let theirs = edit(BASE, json!([{ "id": "a", "kind": "REMOVED" }, modified("b", json!([{ "path": ["params", "depth"], "value": 7 }]))]));
        let m = merge3_text(None, &ours, &theirs, true).unwrap();
        let items = items_of(&m.text).unwrap();
        assert!(items.contains_key("a") && items.contains_key("mine"));
        assert_eq!(items["b"]["params"]["depth"], 7);
        assert_eq!(m.conflicts.len(), 1);
        assert_eq!(items_of(&merge3_text(None, &ours, &theirs, false).unwrap().text).unwrap()["b"]["params"]["depth"], 5);
    }

    #[test]
    fn a_diff_names_the_items_and_the_parts() {
        let new = edit(BASE, json!([modified("b", json!([{ "path": ["params", "depth"], "value": 7 }, { "path": ["name"], "value": "Boss" }])), { "id": "a", "kind": "REMOVED" },
                                    { "id": "c", "kind": "ADDED", "item": { "type": "feature", "name": "Fillet 1" } }]));
        let d = diff_text(BASE, &new).unwrap();
        assert_eq!(d, vec![("removed", "Sketch 1".to_string(), vec![]), ("changed", "Boss".to_string(), vec!["name".to_string(), "depth".to_string()]), ("added", "Fillet 1".to_string(), vec![])]);
        assert!(diff_text("(kicad_pcb)", BASE).is_none());
        assert_eq!(item_label(Some(&json!({ "id": "studio", "type": "studio" })), "studio"), "studio settings");
    }
}
