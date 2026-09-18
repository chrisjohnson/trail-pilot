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
    pub failed: AtomicUsize,
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
            finished: AtomicBool::new(false),
        })
    }

    pub fn status(&self) -> Value {
        let done = self.done.load(Ordering::SeqCst);
        let failed = self.failed.load(Ordering::SeqCst);
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
/// Returns the URLs that still failed.
async fn pass(job: &Arc<Job>, urls: &[String], cache: &Arc<Cache>) -> Vec<String> {
    let sem = Arc::new(tokio::sync::Semaphore::new(CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for url in urls {
        let sem = sem.clone();
        let job = job.clone();
        let cache = cache.clone();
        let url = url.clone();
        set.spawn(async move {
            let _permit = sem.acquire().await;
            let r = cache.get_or_fetch(&url).await;
            if r.is_err() {
                job.failed.fetch_add(1, Ordering::SeqCst);
                Some(url)
            } else {
                None
            }
        });
    }
    let mut failed = Vec::new();
    while let Some(res) = set.join_next().await {
        if let Ok(Some(u)) = res {
            failed.push(u);
        }
    }
    failed
}

/// Run the job: fetch every URL through the cache with bounded concurrency,
/// then give any failures one sequential retry pass (rate-limit recovery).
pub async fn run(job: Arc<Job>, urls: Vec<String>, cache: Arc<Cache>) {
    let mut failed = pass(&job, &urls, &cache).await;
    while !failed.is_empty() {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        failed = pass(&job, &failed, &cache).await;
    }
    job.finished.store(true, Ordering::SeqCst);
}
