//! JSON item documents: the files of the domains that are not KiCad's (a part studio
//! `.jpart`, an assembly `.jasm`).
//!
//! Such a file is one JSON object, `{"junction": <kind>, "version": 1, "items": [...]}`,
//! and every item is an object with a stable string `id`.  Its edits travel over the same
//! op path as KiCad's (`ws.rs`, `doc_actor.rs`): an op is an array of changes with `id` and
//! `kind`, which is all the server checks.  For these documents a change is
//!
//!   ADDED     `item`: the whole item (an existing id is replaced)
//!   MODIFIED  `props`: `[{ "path": ["params", "depth"], "value": 12 }, { "path": [...], "del": true }]`
//!   REMOVED   nothing else
//!
//! applied in sequence order, last writer wins per path; a change to an unknown id does
//! nothing.  The browser applies them in `web/shared/itemdoc/itemdoc.ts` (keep the two in
//! step); this module applies them to the stored file, so the journal can be folded into a
//! snapshot without a client (`compact.rs`) and every reader of "the file" (archive
//! download, GitHub sync, a new branch) reads the document as it is.

use serde_json::{Map, Value};

/// The document types stored as JSON item documents.
pub fn is_item_doc(doc_type: &str) -> bool {
    matches!(doc_type, "part_studio" | "assembly" | "project_shell")
}

/// Apply one change to the items (keyed by id).
fn apply_change(items: &mut Map<String, Value>, change: &Value) {
    let Some(id) = change.get("id").and_then(Value::as_str) else { return };
    match change.get("kind").and_then(Value::as_str) {
        Some("ADDED") => {
            if let Some(item) = change.get("item").filter(|i| i.is_object()) {
                let mut item = item.clone();
                item["id"] = Value::String(id.to_string());
                items.insert(id.to_string(), item);
            }
        }
        Some("REMOVED") => {
            items.remove(id);
        }
        Some("MODIFIED") => {
            let Some(item) = items.get_mut(id) else { return };
            for prop in change.get("props").and_then(Value::as_array).into_iter().flatten() {
                let path: Vec<&str> = prop.get("path").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
                // the id is the item's identity: no path may replace it or the item itself
                if path.is_empty() || path == ["id"] {
                    continue;
                }
                let del = prop.get("del").and_then(Value::as_bool).unwrap_or(false);
                set_path(item, &path, if del { None } else { Some(prop.get("value").cloned().unwrap_or(Value::Null)) });
            }
        }
        _ => {}
    }
}

/// Set (or with `None` remove) the value at a path of object keys, making the objects on the way.
pub(crate) fn set_path(root: &mut Value, path: &[&str], value: Option<Value>) {
    let mut at = root;
    for key in &path[..path.len() - 1] {
        if !at.is_object() {
            *at = Value::Object(Map::new());
        }
        let obj = at.as_object_mut().unwrap();
        if value.is_none() && !obj.contains_key(*key) {
            return;
        }
        at = obj.entry(key.to_string()).or_insert_with(|| Value::Object(Map::new()));
    }
    if !at.is_object() {
        if value.is_none() {
            return;
        }
        *at = Value::Object(Map::new());
    }
    let obj = at.as_object_mut().unwrap();
    let last = path[path.len() - 1];
    match value {
        Some(v) => {
            obj.insert(last.to_string(), v);
        }
        None => {
            obj.remove(last);
        }
    }
}

/// The stored file with the ops' changes applied, written one item per line in id order
/// (so a line diff of two versions shows the items that changed).
pub fn fold_text(file: &str, ops: &[&Value]) -> Result<String, String> {
    let mut doc: Value = serde_json::from_str(file).map_err(|e| format!("the stored file is not JSON: {e}"))?;
    let root = doc.as_object_mut().ok_or("the stored file is not a JSON object")?;
    if !root.get("junction").is_some_and(Value::is_string) {
        return Err("the stored file is not a Junction document".into());
    }
    let mut items = Map::new();
    for item in root.get("items").and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            items.insert(id.to_string(), item.clone());
        }
    }
    for changes in ops {
        for change in changes.as_array().into_iter().flatten() {
            apply_change(&mut items, change);
        }
    }
    root.remove("items");
    // serde_json's map is ordered by key: the head keys and the items both come out sorted
    let mut out = String::from("{");
    for (k, v) in root.iter() {
        out.push_str(&serde_json::to_string(k).unwrap());
        out.push(':');
        out.push_str(&serde_json::to_string(v).map_err(|e| e.to_string())?);
        out.push(',');
    }
    out.push_str("\"items\":[");
    for (i, item) in items.values().enumerate() {
        out.push_str(if i == 0 { "\n" } else { ",\n" });
        out.push_str(&serde_json::to_string(item).map_err(|e| e.to_string())?);
    }
    out.push_str("\n]}\n");
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FILE: &str = r#"{"junction":"part-studio","version":1,"items":[
{"id":"b","type":"feature","featureType":"extrude","params":{"depth":5}},
{"id":"a","type":"feature","featureType":"sketch","name":"Sketch 1"}
]}"#;

    #[test]
    fn folds_added_modified_removed() {
        let ops = [
            json!([{ "id": "b", "kind": "MODIFIED", "props": [
                { "path": ["params", "depth"], "value": 12 },
                { "path": ["params", "draft", "angle"], "value": 3 },
                { "path": ["name"], "value": "Extrude 1" }] }]),
            json!([{ "id": "c", "kind": "ADDED", "item": { "type": "feature", "featureType": "fillet" } },
                   { "id": "a", "kind": "REMOVED" },
                   { "id": "zz", "kind": "MODIFIED", "props": [{ "path": ["name"], "value": "nobody" }] }]),
            json!([{ "id": "b", "kind": "MODIFIED", "props": [{ "path": ["params", "draft"], "del": true },
                                                               { "path": ["id"], "value": "hijack" }] }]),
        ];
        let text = fold_text(FILE, &ops.iter().collect::<Vec<_>>()).unwrap();
        let doc: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(doc["junction"], "part-studio");
        assert_eq!(doc["version"], 1);
        let items = doc["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0], json!({ "id": "b", "type": "feature", "featureType": "extrude", "name": "Extrude 1", "params": { "depth": 12 } }));
        assert_eq!(items[1], json!({ "id": "c", "type": "feature", "featureType": "fillet" }));
        // one item per line, and folding nothing changes nothing
        assert_eq!(text.lines().count(), 4);
        assert_eq!(fold_text(&text, &[]).unwrap(), text);
    }

    #[test]
    fn refuses_what_is_not_a_document() {
        assert!(fold_text("(kicad_pcb)", &[]).is_err());
        assert!(fold_text("[]", &[]).is_err());
        assert!(fold_text("{\"items\":[]}", &[]).is_err());
    }

    #[test]
    fn knows_its_types() {
        assert!(is_item_doc("part_studio") && is_item_doc("assembly"));
        assert!(!is_item_doc("kicad_pcb") && !is_item_doc("other"));
    }
}
