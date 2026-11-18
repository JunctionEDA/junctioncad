//! The last way to get a package's numbers when the datasheet's text has no readable table (its drawing is
//! a picture): a free vision model reads the package drawing page and answers a few numbers as JSON.
//!
//! Any OpenAI-compatible chat endpoint works.  The default is Google's free Gemini API running Gemma 3
//! (an open-weight model, so the same weights can be run on our own machine later with Ollama or llama.cpp
//! by pointing MODELGEN_AI_URL at it):
//!
//! - `MODELGEN_AI_KEY` (or `GEMINI_API_KEY`): the key; without one this step is skipped.
//! - `MODELGEN_AI_URL`: the endpoint base (default `https://generativelanguage.googleapis.com/v1beta/openai`).
//! - `MODELGEN_AI_MODEL`: models to try in order, comma separated (default `gemma-3-27b-it,gemini-2.5-flash-lite`).
//!
//! The answer is never trusted on its own: package.rs checks it against the footprint's pads, and a refused
//! answer is asked again once with the reasons; still wrong, and the model is drawn from the footprint alone.

use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};

use super::package::Dims;

pub fn configured() -> bool { key().is_some() }

fn key() -> Option<String> {
    std::env::var("MODELGEN_AI_KEY").or_else(|_| std::env::var("GEMINI_API_KEY")).ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())
}
fn base() -> String {
    std::env::var("MODELGEN_AI_URL").ok().map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty()).unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta/openai".into())
}
pub fn models() -> Vec<String> {
    std::env::var("MODELGEN_AI_MODEL").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "gemma-3-27b-it,gemini-2.5-flash-lite".into()).split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
}
fn http() -> &'static reqwest::Client {
    static H: OnceLock<reqwest::Client> = OnceLock::new();
    H.get_or_init(|| reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).timeout(Duration::from_secs(90)).build().expect("http client"))
}

/// What the model is told about the footprint, so it picks the right drawing when a datasheet has several.
pub struct Ask<'a> {
    pub family: &'a str,
    pub package_words: &'a str,
    pub pins: usize,
    pub pitch: Option<f64>,
    pub pad_span: (f64, f64),
}

pub const PROMPT: &str = "You read IC package drawings. From the datasheet page(s) given, find the mechanical drawing or dimension table of the package described below and answer ONLY a JSON object, millimetres, with these keys (null when the page does not give it):\n\
a: overall seated height, the MAXIMUM value of A\n\
a1: standoff A1, nominal\n\
d: body length D, nominal (along a row of pins)\n\
e1: body width, nominal (E1 for leaded packages; E for leadless QFN/DFN/SON/LGA/BGA)\n\
e_span: overall width over the leads tip to tip, E (leaded packages only, else null)\n\
pitch: lead pitch e\n\
b: lead width b, nominal\n\
l: foot length L, nominal\n\
d2, e2: exposed pad size, nominal\n\
package: the package name the drawing is titled with\n\
Rules: nominal = the NOM column, else the middle of MIN and MAX. Use the millimetre column, never inches. If the page draws several packages, use only the one matching the description. Do not guess numbers that are not on the page.";

/// Pulls the first JSON object out of a model's answer (it may wrap it in a code fence or prose).
pub fn parse_answer(text: &str) -> Option<(Dims, Option<String>)> {
    let start = text.find('{')?;
    let mut depth = 0;
    let mut end = None;
    for (i, c) in text[start..].char_indices() {
        match c { '{' => depth += 1, '}' => { depth -= 1; if depth == 0 { end = Some(start + i + 1); break; } } _ => {} }
    }
    let v: Value = serde_json::from_str(&text[start..end?]).ok()?;
    let f = |k: &str| v.get(k).and_then(|x| x.as_f64().or_else(|| x.as_str().and_then(|s| s.trim().trim_end_matches("mm").trim().parse().ok()))).filter(|x| x.is_finite() && *x >= 0.0 && *x < 200.0);
    let d = Dims { a: f("a"), a1: f("a1"), d: f("d"), e1: f("e1"), e_span: f("e_span"), pitch: f("pitch"), b: f("b"), l: f("l"), d2: f("d2"), e2: f("e2") };
    let pkg = v.get("package").and_then(|p| p.as_str()).map(|s| s.to_string());
    if d.is_empty() { None } else { Some((d, pkg)) }
}

fn describe(a: &Ask) -> String {
    format!(
        "Package: {} ({}), {} pins{}, the footprint's pads span {:.2} x {:.2} mm.",
        a.package_words, a.family, a.pins,
        a.pitch.map(|p| format!(", pitch {p} mm")).unwrap_or_default(),
        a.pad_span.0, a.pad_span.1
    )
}

/// One question: the page pictures and their text, plus what was wrong with the last answer.
pub async fn ask(a: &Ask<'_>, images: &[(usize, Vec<u8>)], texts: &[(usize, String)], retry_because: Option<&str>) -> Result<(Dims, Option<String>, String), String> {
    let Some(k) = key() else { return Err("no AI key configured".into()) };
    let mut content: Vec<Value> = vec![json!({ "type": "text", "text": format!("{PROMPT}\n\n{}", describe(a)) })];
    for (n, t) in texts { content.push(json!({ "type": "text", "text": format!("Text of page {n}:\n{}", t.chars().take(6000).collect::<String>()) })); }
    for (_, png) in images { content.push(json!({ "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)) } })); }
    if let Some(why) = retry_because { content.push(json!({ "type": "text", "text": format!("Your last answer did not match the footprint: {why}. Look again for the drawing of this exact package and answer the JSON again.") })); }
    let mut last = String::new();
    for model in models() {
        let body = json!({ "model": model, "temperature": 0, "messages": [{ "role": "user", "content": content }] });
        let resp = match http().post(format!("{}/chat/completions", base())).bearer_auth(&k).json(&body).send().await { Ok(r) => r, Err(e) => { last = format!("{model}: {e}"); continue; } };
        let status = resp.status();
        let v: Value = match resp.json().await { Ok(v) => v, Err(e) => { last = format!("{model}: {e}"); continue; } };
        if !status.is_success() { last = format!("{model}: {status} {}", v.get("error").map(|e| e.to_string()).unwrap_or_default().chars().take(300).collect::<String>()); continue; }
        let text = v.pointer("/choices/0/message/content").and_then(|c| c.as_str()).unwrap_or("");
        match parse_answer(text) { Some((d, p)) => return Ok((d, p, model)), None => { last = format!("{model}: no numbers in the answer"); } }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_are_read_leniently() {
        let (d, p) = parse_answer("Here it is:\n```json\n{\"a\": 1.0, \"a1\": \"0.02\", \"d\": 3.0, \"e1\": 3.0, \"e_span\": null, \"pitch\": 0.5, \"b\": 0.25, \"l\": \"0.4 mm\", \"package\": \"VSON-10 DRC\"}\n```").unwrap();
        assert_eq!(d.a, Some(1.0));
        assert_eq!(d.a1, Some(0.02));
        assert_eq!(d.l, Some(0.4));
        assert_eq!(d.e_span, None);
        assert_eq!(p.as_deref(), Some("VSON-10 DRC"));
        assert!(parse_answer("I cannot find it").is_none());
        assert!(parse_answer("{\"a\": null}").is_none());
    }
}
