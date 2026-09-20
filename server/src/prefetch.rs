//! Prefetch jobs: compute the tile set for a route corridor and warm the cache.

use std::f64::consts::PI;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use crate::cache::Cache;
use crate::pipeline::Pt;
use serde_json::{json, Value};

pub const CONCURRENCY: usize = 12;

pub struct Job {
    pub id: u64,
    pub params: String,
    pub created: i64,
    pub total: usize,
    pub by_zoom: Vec<(u32, usize)>,
    pub done: AtomicUsize,
    /// Cumulative count of failed fetch ATTEMPTS (a tile retried on 3 passes
    /// counts 3 times). Not the number of tiles still failing.
    pub failed: AtomicUsize,
    /// Tiles we gave up on: upstream 404 (no coverage — e.g. open water at a
    /// route edge) or still failing after the retry-pass cap. Monotonic.
    pub skipped: AtomicUsize,
    pub finished: AtomicBool,
}

impl Job {
    pub fn new(id: u64, params: String, total: usize, by_zoom: Vec<(u32, usize)>) -> Arc<Job> {
        Arc::new(Job {
            id,
            params,
            created: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
            total,
            by_zoom,
            done: AtomicUsize::new(0),
            failed: AtomicUsize::new(0),
            skipped: AtomicUsize::new(0),
            finished: AtomicBool::new(false),
        })
    }

    pub fn status(&self) -> Value {
        let done = self.done.load(Ordering::SeqCst);
        let failed = self.failed.load(Ordering::SeqCst);
        let skipped = self.skipped.load(Ordering::SeqCst);
        let pct = if self.total == 0 {
            100
        } else {
            (done * 100 / self.total).min(100)
        };
        json!({
            "job": self.id,
            "state": if self.finished.load(Ordering::SeqCst) { "done" } else { "running" },
            "params": self.params,
            "created": self.created,
            "total": self.total,
            "byZoom": {
                "z": self.by_zoom.iter().map(|(z, n)| json!({ "z": z, "tiles": n })).collect::<Vec<_>>(),
            },
            "done": done,
            "failed": failed,
            "skipped": skipped,
            "pct": pct,
        })
    }
}

fn lonlat_to_tile(lon: f64, lat: f64, z: u32) -> (u64, u64) {
    let n = 1u64 << z;
    let x = ((lon + 180.0) / 360.0 * n as f64).floor() as i64;
    let lat_r = lat.to_radians().clamp(-85.0511220_f64.to_radians(), 85.0511220_f64.to_radians());
    let y = ((1.0 - (lat_r.tan() + lat_r.cos().recip()).ln() / PI) / 2.0 * n as f64).floor() as i64;
    (x.clamp(0, (n - 1) as i64) as u64, y.clamp(0, (n - 1) as i64) as u64)
}

/// All tiles (z/x/y) covering every route point ± margin_km, for z in zmin..=zmax.
pub fn tile_urls(points: &[Pt], origin: &str, zmin: u32, zmax: u32, margin_km: f64) -> Vec<String> {
    let origin = origin.trim_end_matches('/');
    let mut out = Vec::new();
    for z in zmin..=zmax.min(22) {
        let mut set: std::collections::HashSet<(u32, u32, u32)> = std::collections::HashSet::new();
        let n = 1u64 << z;
        for p in points {
            let (tx, ty) = lonlat_to_tile(p.lon, p.lat, z);
            let tile_w = 40_075_016.686 * p.lat.to_radians().cos() / n as f64; // meters
            let d = ((margin_km * 1000.0).max(0.0) / tile_w).ceil() as i64;
            for yo in (ty as i64 - d)..=(ty as i64 + d) {
                for xo in (tx as i64 - d)..=(tx as i64 + d) {
                    if xo >= 0 && xo < n as i64 && yo >= 0 && yo < n as i64 {
                        set.insert((z, xo as u32, yo as u32));
                    }
                }
            }
        }
        for (z, x, y) in set {
            out.push(format!("{origin}/{z}/{x}/{y}.png"));
        }
    }
    out
}

/// One pass: fetch every URL through the cache with bounded concurrency.
/// Returns (retry, permanent): failures that look transient (5xx, reset,
/// timeout) vs. failures that will never succeed (upstream 404 — the tile
/// has no coverage, e.g. open water at a route edge).
async fn pass(job: &Arc<Job>, urls: &[String], cache: &Arc<Cache>) -> (Vec<String>, Vec<String>) {
    let sem = Arc::new(tokio::sync::Semaphore::new(CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for url in urls {
        let sem = sem.clone();
        let job = job.clone();
        let cache = cache.clone();
        let url = url.clone();
        set.spawn(async move {
            let _permit = sem.acquire().await;
            match cache.get_or_fetch(&url).await {
                Ok(_) => {
                    job.done.fetch_add(1, Ordering::SeqCst);
                    None
                }
                Err(e) => {
                    job.failed.fetch_add(1, Ordering::SeqCst);
                    Some((url, is_permanent(&e)))
                }
            }
        });
    }
    let mut retry = Vec::new();
    let mut permanent = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(Some((u, perm))) = res {
            if perm { permanent.push(u) } else { retry.push(u) }
        }
    }
    (retry, permanent)
}

/// The cache layer already distinguishes these: a 404 is returned
/// immediately (no internal retries) with this exact wording, while 5xx,
/// resets, and timeouts get 3 backoff attempts before failing.
fn is_permanent(err: &str) -> bool {
    err.contains("upstream returned 404")
}

/// Retry passes after the first. The cache layer already gives each URL 3
/// backoff attempts per pass, so a URL still failing after the cap is
/// treated as permanently bad: it is reported as skipped and the job ends.
/// The job ALWAYS terminates, even if every URL is a permanent failure.
const MAX_RETRY_PASSES: usize = 3;

/// Run the job: fetch every URL through the cache with bounded concurrency,
/// then retry transient failures (rate-limit recovery), capping the number
/// of passes so a permanently-bad URL cannot pin the job forever.
pub async fn run(job: Arc<Job>, urls: Vec<String>, cache: Arc<Cache>) {
    let (mut retry, mut permanent) = pass(&job, &urls, &cache).await;
    job.skipped.fetch_add(permanent.len(), Ordering::SeqCst);
    let mut pass_no = 0;
    while !retry.is_empty() && pass_no < MAX_RETRY_PASSES {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        pass_no += 1;
        let (r, p) = pass(&job, &retry, &cache).await;
        job.skipped.fetch_add(p.len(), Ordering::SeqCst);
        retry = r;
        permanent.clear();
    }
    // Give up on whatever still fails — the job must finish.
    job.skipped.fetch_add(retry.len(), Ordering::SeqCst);
    job.finished.store(true, Ordering::SeqCst);
}
