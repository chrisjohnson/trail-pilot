//! Durable pull-through cache: file-backed, 1-year TTL, in-flight dedupe.
//!
//! Layout: <dir>/<2-hex shard>/<16-hex hash>.bin  +  .meta.json
//! Writes are atomic (tmp + rename) so a crash mid-write never corrupts an entry.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{watch, Mutex};

pub const TTL_SECS: i64 = 31_536_000; // 1 year — tile/CDN data effectively never changes

#[derive(Clone)]
pub struct Cache {
    inner: Arc<Inner>,
}

struct Inner {
    dir: PathBuf,
    http: reqwest::Client,
    offline: Arc<AtomicBool>,
    inflight: Mutex<HashMap<String, Arc<Inflight>>>,
}

struct Inflight {
    tx: watch::Sender<Option<Result<Arc<Entry>, String>>>,
}

pub struct Entry {
    pub body: Vec<u8>,
    pub content_type: String,
    pub stored_at: i64,
}

pub struct CacheResponse {
    pub body: Vec<u8>,
    pub content_type: String,
    pub hit: bool,
}

fn hash64(s: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn walk_dir(dir: &Path, files: &mut u64, bytes: &mut u64) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk_dir(&p, files, bytes);
            } else if p.extension().map(|x| x == "bin").unwrap_or(false) {
                *files += 1;
                *bytes += p.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
}

impl Cache {
    pub fn new(dir: PathBuf, http: reqwest::Client, offline: bool) -> Result<Cache, String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create cache dir: {e}"))?;
        Ok(Cache {
            inner: Arc::new(Inner {
                dir,
                http,
                offline: Arc::new(AtomicBool::new(offline)),
                inflight: Mutex::new(HashMap::new()),
            }),
        })
    }

    pub fn set_offline(&self, v: bool) {
        self.inner.offline.store(v, Ordering::SeqCst);
    }

    pub fn is_offline(&self) -> bool {
        self.inner.offline.load(Ordering::SeqCst)
    }

    fn paths(&self, key: &str) -> (PathBuf, PathBuf) {
        let h = format!("{:016x}", hash64(key));
        let shard = &h[..2];
        let base = self.inner.dir.join(shard);
        (base.join(format!("{h}.bin")), base.join(format!("{h}.meta.json")))
    }

    /// Serve from cache if fresh; otherwise fetch upstream (deduped), store, return.
    pub async fn get_or_fetch(&self, url: &str) -> Result<CacheResponse, String> {
        let (bin, meta) = self.paths(url);
        // 1) cache hit?
        if meta.is_file() && bin.is_file() {
            if let Ok(m) = std::fs::read_to_string(&meta) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&m) {
                    let stored_at = v["stored_at"].as_i64().unwrap_or(0);
                    if now_secs() - stored_at < TTL_SECS {
                        if let Ok(body) = std::fs::read(&bin) {
                            return Ok(CacheResponse {
                                body,
                                content_type: v["content_type"].as_str().unwrap_or("application/octet-stream").to_string(),
                                hit: true,
                            });
                        }
                    }
                }
            }
        }
        // 2) inflight dedupe
        loop {
            let mut map = self.inner.inflight.lock().await;
            if let Some(ig) = map.get(url) {
                let mut rx = ig.tx.subscribe();
                drop(map);
                // wait for the fetcher's result
                loop {
                    if let Some(r) = rx.borrow().clone() {
                        return r.map(|e| CacheResponse { body: e.body.clone(), content_type: e.content_type.clone(), hit: false });
                    }
                    if rx.changed().await.is_err() {
                        break; // fetcher task died — retry as fetcher
                    }
                }
                continue;
            }
            // we are the fetcher
            let (tx, _) = watch::channel(None);
            let ig = Arc::new(Inflight { tx });
            map.insert(url.to_string(), ig.clone());
            drop(map);

            let result = self.fetch_and_store(url, &bin, &meta).await;
            ig.tx.send_replace(Some(result.clone()));
            let mut map = self.inner.inflight.lock().await;
            if map.get(url).map(|v| Arc::ptr_eq(v, &ig)) == Some(true) {
                map.remove(url);
            }
            return result
                .map(|e| CacheResponse { body: e.body.clone(), content_type: e.content_type.clone(), hit: false });
        }
    }

    async fn fetch_and_store(&self, url: &str, bin: &Path, meta: &Path) -> Result<Arc<Entry>, String> {
        if self.inner.offline.load(Ordering::SeqCst) {
            return Err("offline: not fetching upstream".into());
        }
        // retry transient upstream failures (rate limits, resets) with backoff
        let mut last_err = String::new();
        let mut resp = None;
        for attempt in 0..3u32 {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(400 * 2u64.pow(attempt))).await;
            }
            match self.inner.http.get(url).timeout(Duration::from_secs(25)).send().await {
                Ok(r) if (200..300).contains(&r.status().as_u16()) => {
                    resp = Some(r);
                    break;
                }
                Ok(r) => {
                    let status = r.status();
                    // 404 is permanent (out-of-range tile etc.) — don't retry
                    if status.as_u16() == 404 {
                        return Err(format!("upstream returned {status}"));
                    }
                    last_err = format!("upstream returned {status}");
                }
                Err(e) => last_err = format!("upstream fetch failed: {e}"),
            }
        }
        let resp = resp.ok_or_else(|| last_err)?;
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let body = resp.bytes().await.map_err(|e| format!("reading upstream body: {e}"))?;
        let body = body.to_vec();
        // durable store: tmp + rename
        if let Some(parent) = bin.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp = bin.with_extension("bin.tmp");
        std::fs::write(&tmp, &body).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, bin).map_err(|e| e.to_string())?;
        let stored_at = now_secs();
        let mv = serde_json::json!({ "url": url, "content_type": content_type, "stored_at": stored_at, "bytes": body.len() });
        let mtmp = meta.with_extension("meta.json.tmp");
        std::fs::write(&mtmp, mv.to_string()).map_err(|e| e.to_string())?;
        std::fs::rename(&mtmp, meta).map_err(|e| e.to_string())?;
        Ok(Arc::new(Entry { body, content_type, stored_at }))
    }

    /// Approximate stats for /healthz: file count + total bytes.
    pub fn stats(&self) -> (u64, u64) {
        let mut files = 0u64;
        let mut bytes = 0u64;
        walk_dir(&self.inner.dir, &mut files, &mut bytes);
        (files, bytes)
    }
}
