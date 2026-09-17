//! trailpilot — the trail-pilot server.
//!
//! Hosts the route pipeline in-process and serves the web viewer, with a
//! durable pull-through file cache for topo/imagery tiles (/tiles) and CDN
//! assets (/cdn), plus prefetch jobs that pre-warm the cache for a route.

mod cache;
mod pipeline;
mod prefetch;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

pub struct Cfg {
    pub port: u16,
    pub web_dir: PathBuf,
    pub data_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub offline: bool,
    pub ingest: Option<PathBuf>,
    pub tile_origin: String,
    pub cdn_allow: Vec<String>,
    pub tz_grid: PathBuf,
}

impl Clone for Cfg {
    fn clone(&self) -> Self {
        Cfg {
            port: self.port,
            web_dir: self.web_dir.clone(),
            data_dir: self.data_dir.clone(),
            cache_dir: self.cache_dir.clone(),
            offline: self.offline,
            ingest: self.ingest.clone(),
            tile_origin: self.tile_origin.clone(),
            cdn_allow: self.cdn_allow.clone(),
            tz_grid: self.tz_grid.clone(),
        }
    }
}

pub struct RouteEntry {
    pub slug: String,
    pub data: Value,
    pub points: Vec<pipeline::Pt>,
}

pub struct Registry {
    pub current: Option<String>,
    pub entries: HashMap<String, Arc<RouteEntry>>,
}

#[derive(Clone)]
pub struct App {
    pub cfg: Cfg,
    pub web_root: PathBuf,
    pub cache: cache::Cache,
    pub routes: Arc<Mutex<Registry>>,
    pub jobs: Arc<Mutex<HashMap<u64, Arc<prefetch::Job>>>>,
    pub job_ids: Arc<AtomicU64>,
    pub http: reqwest::Client,
    pub tz_grid: Option<Arc<pipeline::TzGrid>>,
}

// ---------------- config ----------------

fn parse_args() -> Cfg {
    let mut cfg = Cfg {
        port: 8137,
        web_dir: PathBuf::from("web"),
        data_dir: PathBuf::from("data"),
        cache_dir: PathBuf::from("cache"),
        offline: false,
        ingest: None,
        tile_origin: "https://tile.opentopomap.org".into(),
        cdn_allow: vec!["unpkg.com".into()],
        tz_grid: PathBuf::from("build/tz-grid.json"),
    };
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    while let Some(a) = args.first() {
        let a = a.clone();
        args.remove(0);
        let mut need = |name: &str| -> String {
            if let Some(v) = args.first().cloned() {
                args.remove(0);
                v
            } else {
                eprintln!("missing value for {name}");
                std::process::exit(2);
            }
        };
        match a.as_str() {
            "--port" => cfg.port = need("--port").parse().expect("port"),
            "--web" => cfg.web_dir = PathBuf::from(need("--web")),
            "--data" => cfg.data_dir = PathBuf::from(need("--data")),
            "--cache" => cfg.cache_dir = PathBuf::from(need("--cache")),
            "--tile-origin" => cfg.tile_origin = need("--tile-origin"),
            "--cdn-allow" => cfg.cdn_allow = need("--cdn-allow").split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
            "--tz-grid" => cfg.tz_grid = PathBuf::from(need("--tz-grid")),
            "--offline" => cfg.offline = true,
            "--ingest" => cfg.ingest = Some(PathBuf::from(need("--ingest"))),
            h if h.starts_with("--") => {
                eprintln!("unknown flag {h}");
                std::process::exit(2);
            }
            _ => {}
        }
    }
    cfg
}

// ---------------- helpers ----------------

fn slugify(name: &str) -> String {
    let mut out = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let t = out.trim_matches('-');
    if t.is_empty() { "route".into() } else { t.into() }
}

fn content_type(p: &std::path::Path) -> &'static str {
    match p.extension().and_then(|x| x.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        "terrain" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

fn cached_response(body: Vec<u8>, ctype: String, hit: bool) -> Response {
    (
        [
            (axum::http::header::CONTENT_TYPE, ctype),
            (axum::http::header::CACHE_CONTROL, "public, max-age=31536000".to_string()),
            ("x-cache".parse().unwrap(), if hit { "HIT".to_string() } else { "MISS".to_string() }),
            (axum::http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".to_string()),
        ],
        body,
    )
        .into_response()
}

fn err_response(status: StatusCode, msg: &str) -> Response {
    (status, msg.to_string()).into_response()
}

// ---------------- route registry / ingest ----------------

async fn ingest_gpx(state: &App, gpx: &[u8]) -> Result<Value, String> {
    let xml = String::from_utf8_lossy(gpx).to_string();
    let res = pipeline::process(&xml, state.tz_grid.as_deref())?;
    let name = res.data["name"].as_str().unwrap_or("route").to_string();
    let slug = slugify(&name);
    let dir = state.cfg.data_dir.join("routes").join(&slug);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    tokio::fs::write(dir.join("route.gpx"), gpx).await.map_err(|e| e.to_string())?;
    let data_str = serde_json::to_string(&res.data).map_err(|e| e.to_string())?;
    tokio::fs::write(dir.join("route_data.json"), data_str).await.map_err(|e| e.to_string())?;
    {
        let mut reg = state.routes.lock().await;
        reg.entries.insert(
            slug.clone(),
            Arc::new(RouteEntry { slug: slug.clone(), data: res.data.clone(), points: res.points.clone() }),
        );
        reg.current = Some(slug.clone());
    }
    tokio::fs::write(state.cfg.data_dir.join("current"), &slug).await.ok();
    Ok(json!({
        "slug": slug,
        "name": name,
        "timezone": res.data["timezone"],
        "totalDistanceMiles": res.data["totalDistanceMiles"],
        "totalDurationStr": res.data["totalDurationStr"],
        "startUTC": res.data["startUTC"],
        "points": res.data["route"].as_array().map(|a| a.len()).unwrap_or(0),
        "breaks": res.data["breaks"].as_array().map(|a| a.len()).unwrap_or(0),
        "message": "ok",
    }))
}

async fn load_registry(state: &App) {
    let routes_dir = state.cfg.data_dir.join("routes");
    if let Ok(rd) = std::fs::read_dir(&routes_dir) {
        for e in rd.flatten() {
            let gpx_p = e.path().join("route.gpx");
            let data_p = e.path().join("route_data.json");
            if !gpx_p.is_file() || !data_p.is_file() {
                continue;
            }
            let gpx = match std::fs::read(&gpx_p) {
                Ok(b) => b,
                Err(_) => continue,
            };
            let data_str = match std::fs::read_to_string(&data_p) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let data: Value = match serde_json::from_str(&data_str) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let xml = String::from_utf8_lossy(&gpx).to_string();
            let (_name, points) = pipeline::parse_gpx(&xml);
            let slug = e.file_name().to_string_lossy().to_string();
            state.routes.lock().await.entries.insert(
                slug.clone(),
                Arc::new(RouteEntry { slug, data, points }),
            );
        }
    }
    if let Ok(cur) = std::fs::read_to_string(state.cfg.data_dir.join("current")) {
        let cur = cur.trim().to_string();
        if state.routes.lock().await.entries.contains_key(&cur) {
            state.routes.lock().await.current = Some(cur);
        }
    } else if let Some(first) = state.routes.lock().await.entries.keys().next().cloned() {
        state.routes.lock().await.current = Some(first);
    }
}

// ---------------- handlers ----------------

async fn static_file(State(state): State<App>, uri: axum::http::Uri) -> Response {
    let raw = uri.path();
    let rel = raw.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let p = state.web_root.join(rel);
    let p = match p.canonicalize() {
        Ok(p) => p,
        Err(_) => return err_response(StatusCode::NOT_FOUND, "not found"),
    };
    if !p.starts_with(&state.web_root) {
        return err_response(StatusCode::NOT_FOUND, "not found");
    }
    let p = if p.is_dir() { p.join("index.html") } else { p };
    if !p.is_file() {
        return err_response(StatusCode::NOT_FOUND, "not found");
    }
    let body = match tokio::fs::read(&p).await {
        Ok(b) => b,
        Err(_) => return err_response(StatusCode::INTERNAL_SERVER_ERROR, "read error"),
    };
    ([(axum::http::header::CONTENT_TYPE, content_type(&p).to_string())], body).into_response()
}

async fn route_data_current(State(state): State<App>) -> Response {
    let reg = state.routes.lock().await;
    match reg.current.as_ref().and_then(|s| reg.entries.get(s)) {
        Some(e) => Json(e.data.clone()).into_response(),
        None => err_response(StatusCode::NOT_FOUND, "no route ingested yet — POST /routes/ingest"),
    }
}

async fn routes_list(State(state): State<App>) -> Response {
    let reg = state.routes.lock().await;
    let mut items: Vec<Value> = reg
        .entries
        .values()
        .map(|e| {
            json!({
                "slug": e.slug,
                "name": e.data["name"],
                "timezone": e.data["timezone"],
                "totalDistanceMiles": e.data["totalDistanceMiles"],
                "totalDurationStr": e.data["totalDurationStr"],
                "startUTC": e.data["startUTC"],
                "current": Some(&e.slug) == reg.current.as_ref(),
            })
        })
        .collect();
    items.sort_by(|a, b| a["slug"].as_str().unwrap().cmp(b["slug"].as_str().unwrap()));
    Json(json!({ "current": reg.current, "routes": items })).into_response()
}

async fn route_data_slug(State(state): State<App>, Path(slug): Path<String>) -> Response {
    let reg = state.routes.lock().await;
    match reg.entries.get(&slug) {
        Some(e) => Json(e.data.clone()).into_response(),
        None => err_response(StatusCode::NOT_FOUND, "no such route"),
    }
}

async fn routes_ingest(State(state): State<App>, body: Bytes) -> Response {
    match ingest_gpx(&state, &body).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => err_response(StatusCode::BAD_REQUEST, &e),
    }
}

async fn tile(State(state): State<App>, rest: Path<String>) -> Response {
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() != 4 {
        return err_response(StatusCode::BAD_REQUEST, "expected /tiles/<provider>/<z>/<x>/<y>.png");
    }
    let origin = match parts[0] {
        "otm" => Some(state.cfg.tile_origin.clone()),
        _ => None,
    };
    let Some(origin) = origin else {
        return err_response(StatusCode::NOT_FOUND, "unknown tile provider");
    };
    let z: u32 = match parts[1].parse() {
        Ok(z) if (1..=22).contains(&z) => z,
        _ => return err_response(StatusCode::BAD_REQUEST, "bad z"),
    };
    let x: i64 = match parts[2].parse() {
        Ok(x) if x >= 0 => x,
        _ => return err_response(StatusCode::BAD_REQUEST, "bad x"),
    };
    let ypart = parts[3].split('.').next().unwrap_or("");
    let y: i64 = match ypart.parse() {
        Ok(y) if y >= 0 => y,
        _ => return err_response(StatusCode::BAD_REQUEST, "bad y"),
    };
    let n = 1i64 << z;
    if x >= n || y >= n {
        return err_response(StatusCode::NOT_FOUND, "tile out of range");
    }
    let url = format!("{}/{}/{}/{}", origin.trim_end_matches('/'), z, x, parts[3]);
    match state.cache.get_or_fetch(&url).await {
        Ok(r) => cached_response(r.body, r.content_type, r.hit),
        Err(_) if state.cache.is_offline() => err_response(StatusCode::NOT_FOUND, "tile not cached (offline)"),
        Err(e) => err_response(StatusCode::BAD_GATEWAY, &e),
    }
}

async fn cdn(State(state): State<App>, rest: Path<String>) -> Response {
    let mut it = rest.splitn(2, '/');
    let host = it.next().unwrap_or("");
    let path = it.next().unwrap_or("");
    if !state.cfg.cdn_allow.iter().any(|h| h == host) || host.is_empty() {
        return err_response(StatusCode::FORBIDDEN, "origin not allowed for /cdn");
    }
    let url = format!("https://{host}/{path}");
    match state.cache.get_or_fetch(&url).await {
        Ok(r) => cached_response(r.body, r.content_type, r.hit),
        Err(_) if state.cache.is_offline() => err_response(StatusCode::NOT_FOUND, "asset not cached (offline)"),
        Err(e) => err_response(StatusCode::BAD_GATEWAY, &e),
    }
}

#[derive(Deserialize)]
struct PrefetchReq {
    route: Option<String>,
    zmin: Option<u32>,
    zmax: Option<u32>,
    #[serde(rename = "marginKm")]
    margin_km: Option<f64>,
}

async fn prefetch_start(State(state): State<App>, Json(req): Json<PrefetchReq>) -> Response {
    let slug = match req.route {
        Some(s) => s,
        None => state.routes.lock().await.current.clone().unwrap_or_default(),
    };
    let entry = {
        let reg = state.routes.lock().await;
        reg.entries.get(&slug).cloned()
    };
    let Some(entry) = entry else {
        return err_response(StatusCode::NOT_FOUND, "no such route");
    };
    let zmin = req.zmin.unwrap_or(10).max(2);
    let zmax = req.zmax.unwrap_or(15).min(17);
    if zmin > zmax {
        return err_response(StatusCode::BAD_REQUEST, "zmin > zmax");
    }
    let margin_km = req.margin_km.unwrap_or(1.0);
    let urls = prefetch::tile_urls(&entry.points, &state.cfg.tile_origin, zmin, zmax, margin_km);
    let total = urls.len();
    let id = state.job_ids.fetch_add(1, Ordering::SeqCst) + 1;
    let params = format!("route={} z={}..{} marginKm={}", slug, zmin, zmax, margin_km);
    let job = prefetch::Job::new(id, params, total);
    state.jobs.lock().await.insert(id, job.clone());
    let cache = state.cache.clone();
    tokio::spawn(prefetch::run(job, urls, Arc::new(cache)));
    Json(json!({ "job": id, "total": total })).into_response()
}

async fn prefetch_status(State(state): State<App>, Path(id): Path<u64>) -> Response {
    match state.jobs.lock().await.get(&id) {
        Some(j) => Json(j.status()).into_response(),
        None => err_response(StatusCode::NOT_FOUND, "no such job"),
    }
}

async fn prefetch_list(State(state): State<App>) -> Response {
    let jobs = state.jobs.lock().await;
    let items: Vec<Value> = jobs.values().map(|j| j.status()).collect();
    Json(json!({ "jobs": items })).into_response()
}

async fn healthz(State(state): State<App>) -> Response {
    let (files, bytes) = state.cache.stats();
    let reg = state.routes.lock().await;
    Json(json!({
        "ok": true,
        "offline": state.cache.is_offline(),
        "cacheFiles": files,
        "cacheBytes": bytes,
        "routes": reg.entries.len(),
        "current": reg.current,
    }))
        .into_response()
}

#[derive(Deserialize)]
struct ModeReq {
    offline: bool,
}

async fn mode_get(State(state): State<App>) -> Response {
    Json(json!({ "offline": state.cache.is_offline() })).into_response()
}

async fn mode_set(State(state): State<App>, Json(req): Json<ModeReq>) -> Response {
    state.cache.set_offline(req.offline);
    Json(json!({ "offline": req.offline })).into_response()
}

// ---------------- main ----------------

#[tokio::main]
async fn main() {
    let cfg = parse_args();
    let http = reqwest::Client::builder()
        .user_agent("trailpilot/0.1 (local tile cache)")
        .timeout(Duration::from_secs(25))
        .pool_max_idle_per_host(32)
        .build()
        .expect("http client");
    let cache = cache::Cache::new(cfg.cache_dir.clone(), http.clone(), cfg.offline).expect("cache");

    let web_root = cfg
        .web_dir
        .canonicalize()
        .unwrap_or_else(|e| panic!("web dir {:?} not found: {e}", cfg.web_dir));
    std::fs::create_dir_all(&cfg.data_dir).ok();

    let tz_grid = pipeline::TzGrid::load(&cfg.tz_grid).map(Arc::new);
    if tz_grid.is_none() {
        eprintln!("warning: tz grid {:?} not found — timezone detection disabled", cfg.tz_grid);
    }

    let state = App {
        web_root: web_root.clone(),
        cache,
        routes: Arc::new(Mutex::new(Registry { current: None, entries: HashMap::new() })),
        jobs: Arc::new(Mutex::new(HashMap::new())),
        job_ids: Arc::new(AtomicU64::new(0)),
        http,
        tz_grid,
        cfg: cfg.clone(),
    };

    load_registry(&state).await;

    if let Some(p) = &cfg.ingest {
        match tokio::fs::read(p).await {
            Ok(b) => match ingest_gpx(&state, &b).await {
                Ok(v) => println!("ingested: {}", v),
                Err(e) => eprintln!("ingest failed: {e}"),
            },
            Err(e) => eprintln!("cannot read ingest file {:?}: {e}", p),
        }
    }

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/mode", get(mode_get).post(mode_set))
        .route("/route_data.json", get(route_data_current))
        .route("/routes", get(routes_list))
        .route("/routes/ingest", post(routes_ingest))
        .route("/routes/:slug/data.json", get(route_data_slug))
        .route("/tiles/*rest", get(tile))
        .route("/cdn/*rest", get(cdn))
        .route("/prefetch", get(prefetch_list).post(prefetch_start))
        .route("/prefetch/:id", get(prefetch_status))
        .fallback(static_file)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    println!("trailpilot listening on http://0.0.0.0:{}/  (offline={})", cfg.port, cfg.offline);
    println!("  web:   {}", web_root.display());
    println!("  data:  {}", cfg.data_dir.display());
    println!("  cache: {}", cfg.cache_dir.display());
    let listener = tokio::net::TcpListener::bind(addr).await.expect("bind");
    axum::serve(listener, app).await.expect("serve");
}
