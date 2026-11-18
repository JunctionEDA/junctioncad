//! `/download/{os}`: a stable link to the desktop app's newest release file for one platform.
//!
//! The site's download buttons point here instead of at a file name with a version in it, so they
//! never go stale after a release.  The newest release on GitHub is looked up at most every ten
//! minutes; when GitHub cannot be reached, or the platform has no file, the visitor lands on the
//! releases page instead.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::header;
use axum::response::{IntoResponse, Redirect, Response};

use crate::AppState;

/// The public repository the desktop app is released from.
pub const REPO: &str = "JunctionEDA/junction";
const TTL: Duration = Duration::from_secs(600);

#[derive(Clone, Default)]
struct Release {
    tag: String,       // "v2.2.0"
    published: String, // ISO date
    page: String,      // the release's page on GitHub
    assets: Vec<(String, String)>, // (file name, download address)
}

struct Cached {
    at: Instant,
    release: Release,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

/// Which release file belongs to a platform: its name ends with the platform's suffix.
fn suffix(os: &str) -> Option<&'static str> {
    match os {
        "macos" | "mac" | "osx" => Some("-macos.dmg"),
        "windows" | "win" => Some("-windows-x64.exe"),
        "linux" => Some("-linux-x64.tar.gz"),
        _ => None,
    }
}

fn pick(assets: &[(String, String)], suffix: &str) -> Option<String> {
    assets.iter().find(|(name, _)| name.starts_with("Junction-") && name.ends_with(suffix)).map(|(_, url)| url.clone())
}

async fn latest_assets(state: &AppState) -> Option<Vec<(String, String)>> {
    latest_release(state).await.map(|r| r.assets)
}

async fn latest_release(state: &AppState) -> Option<Release> {
    if let Some(c) = CACHE.lock().ok()?.as_ref() {
        if c.at.elapsed() < TTL {
            return Some(c.release.clone());
        }
    }
    let http = reqwest::Client::builder()
        .user_agent("junction-server")
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    let url = format!("{}/repos/{REPO}/releases/latest", state.cfg.github_api_url.trim_end_matches('/'));
    let fetched = async {
        let v: serde_json::Value = http.get(&url).header("Accept", "application/vnd.github+json").send().await.ok()?.error_for_status().ok()?.json().await.ok()?;
        let assets: Vec<(String, String)> = v["assets"]
            .as_array()?
            .iter()
            .filter_map(|a| Some((a["name"].as_str()?.to_string(), a["browser_download_url"].as_str()?.to_string())))
            .collect();
        Some(Release {
            tag: v["tag_name"].as_str()?.to_string(),
            published: v["published_at"].as_str().unwrap_or_default().to_string(),
            page: v["html_url"].as_str().unwrap_or_default().to_string(),
            assets,
        })
    }
    .await;
    match fetched {
        Some(release) => {
            if let Ok(mut c) = CACHE.lock() {
                *c = Some(Cached { at: Instant::now(), release: release.clone() });
            }
            Some(release)
        }
        // GitHub is down or rate limited: keep using what we had, however old.
        None => CACHE.lock().ok()?.as_ref().map(|c| c.release.clone()),
    }
}

/// GET /download/{os} (macos, windows, linux): redirect to that platform's newest release file.
pub async fn download(State(state): State<AppState>, Path(os): Path<String>) -> Response {
    let fallback = format!("https://github.com/{REPO}/releases/latest");
    let target = match suffix(&os.to_ascii_lowercase()) {
        Some(sfx) => latest_assets(&state).await.and_then(|a| pick(&a, sfx)).unwrap_or(fallback),
        None => fallback,
    };
    ([(header::CACHE_CONTROL, "no-store")], Redirect::to(&target)).into_response()
}

/// GET /api/desktop/latest: what the desktop app's update check asks at start-up.
///
/// `{version, release_date, details_url, downloads_url}`, the newest release's version without the
/// leading "v".  `downloads_url` is the stable `/download/{os}` link when the caller names its
/// platform (`?platform=macos|windows|linux`), else the releases page.  The app compares the version
/// with its own and only then shows its notice, so this never says whether an update is needed.
/// 503 when GitHub has never answered.
pub async fn latest(
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let Some(r) = latest_release(&state).await else {
        return (axum::http::StatusCode::SERVICE_UNAVAILABLE, [(header::CACHE_CONTROL, "no-store")], "release info unavailable").into_response();
    };
    let base = state.cfg.site_url.trim_end_matches('/');
    let platform = q.get("platform").map(|p| p.to_ascii_lowercase());
    let downloads_url = match platform.as_deref().and_then(|p| suffix(p).map(|_| p.to_string())) {
        Some(p) => format!("{base}/download/{p}"),
        None => format!("https://github.com/{REPO}/releases/latest"),
    };
    let details_url = if r.page.is_empty() { format!("https://github.com/{REPO}/releases/latest") } else { r.page.clone() };
    let body = serde_json::json!({
        "version": version_of(&r.tag),
        "release_date": r.published,
        "details_url": details_url,
        "downloads_url": downloads_url,
    });
    ([(header::CACHE_CONTROL, "public, max-age=300")], axum::Json(body)).into_response()
}

/// "v2.2.0" -> "2.2.0".
fn version_of(tag: &str) -> &str {
    tag.strip_prefix('v').or_else(|| tag.strip_prefix('V')).unwrap_or(tag)
}

/// GET /download: the releases page, where every platform's file is listed.
pub async fn releases() -> Response {
    Redirect::to(&format!("https://github.com/{REPO}/releases/latest")).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_each_platform_file() {
        let assets: Vec<(String, String)> = ["Junction-2.1.4-linux-x64.tar.gz", "Junction-2.1.4-macos.dmg", "Junction-2.1.4-windows-x64.exe"]
            .iter()
            .map(|n| (n.to_string(), format!("https://example.test/{n}")))
            .collect();
        assert_eq!(pick(&assets, suffix("macos").unwrap()).unwrap(), "https://example.test/Junction-2.1.4-macos.dmg");
        assert_eq!(pick(&assets, suffix("windows").unwrap()).unwrap(), "https://example.test/Junction-2.1.4-windows-x64.exe");
        assert_eq!(pick(&assets, suffix("linux").unwrap()).unwrap(), "https://example.test/Junction-2.1.4-linux-x64.tar.gz");
        assert!(suffix("amiga").is_none());
    }

    #[test]
    fn version_drops_the_v() {
        assert_eq!(version_of("v2.2.0"), "2.2.0");
        assert_eq!(version_of("2.2.0"), "2.2.0");
    }
}
