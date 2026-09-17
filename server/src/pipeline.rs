//! GPX pipeline: parse, break detection, timezone detection, route_data build.
//! Ports build/gpx2route.js — output must match the Node CLI byte-for-byte.

use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::f64::consts::PI;

pub const WINDOW_SEC: f64 = 600.0;   // sliding window length (10 min)
pub const BREAK_DRIFT_M: f64 = 200.0; // max meters of movement in the window to count as a break
pub const MIN_BREAK_SEC: i64 = 600;   // minimum break duration (10 min) to keep

#[derive(Clone)]
pub struct Pt {
    pub lon: f64,
    pub lat: f64,
    pub ele: f64,
    pub t: f64, // ms since epoch, NaN if missing
}

pub struct RouteData {
    pub data: Value,
    pub points: Vec<Pt>,
}

fn hav(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6371008.8;
    let to_r = |x: f64| x * PI / 180.0;
    let dlat = to_r(lat2 - lat1);
    let dlon = to_r(lon2 - lon1);
    let a = (dlat / 2.0).sin() * (dlat / 2.0).sin()
        + to_r(lat1).cos() * to_r(lat2).cos() * (dlon / 2.0).sin() * (dlon / 2.0).sin();
    2.0 * R * (a.sqrt().min(1.0)).asin()
}

fn fmt_dur(s: f64) -> String {
    let s = s.round() as i64;
    let h = s / 3600;
    let m = (s % 3600) / 60;
    if h > 0 {
        format!("{}h {}m", h, m)
    } else if m > 0 {
        format!("{}m", m)
    } else {
        format!("{}s", s)
    }
}

// "YYYY-MM-DDTHH:MM:SS(.sss)?(Z|+HH:MM|+HHMM)" -> ms since epoch
fn try_parse_time_utc_ms(s: &str) -> Option<f64> {
    let b = s.trim().as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return None;
    }
    let get = |a: usize, n: usize| -> Option<i64> {
        std::str::from_utf8(&b[a..a + n]).ok()?.parse::<i64>().ok()
    };
    let y = get(0, 4)?;
    let mo = get(5, 2)?;
    let d = get(8, 2)?;
    let hh = get(11, 2)?;
    let mi = get(14, 2)?;
    let se = get(17, 2)?;
    let mut i = 19usize;
    let mut frac_ms = 0i64;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let mut digs = String::new();
        while i < b.len() && b[i].is_ascii_digit() && digs.len() < 3 {
            digs.push(b[i] as char);
            i += 1;
        }
        while digs.len() < 3 {
            digs.push('0');
        }
        frac_ms = digs.parse().unwrap_or(0);
    }
    let mut off_sec = 0i64;
    if i < b.len() {
        match b[i] {
            b'Z' | b'z' => {}
            b'+' | b'-' => {
                let sign = if b[i] == b'+' { 1 } else { -1 };
                let rest = std::str::from_utf8(&b[i + 1..]).unwrap_or("");
                let digits: String = rest.trim_end().chars().filter(|c| c.is_ascii_digit()).take(4).collect();
                if digits.len() >= 4 {
                    let oh: i64 = digits[..2].parse().unwrap_or(0);
                    let om: i64 = digits[2..4].parse().unwrap_or(0);
                    off_sec = sign * (oh * 3600 + om * 60);
                }
            }
            _ => return None,
        }
    }
    let days = days_from_civil(y, mo, d);
    Some((days * 86400 + hh * 3600 + mi * 60 + se - off_sec) as f64 * 1000.0 + frac_ms as f64)
}

fn parse_time_utc_ms(s: &str) -> f64 {
    try_parse_time_utc_ms(s).unwrap_or(f64::NAN)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn utc_str(ms: f64) -> String {
    if ms.is_nan() {
        return "NaN".into();
    }
    let secs = (ms / 1000.0).round() as i64;
    let (y, mo, d) = civil_from_days(secs / 86400);
    let rem = secs % 86400;
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
        y,
        mo,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

pub fn parse_gpx(xml: &str) -> (String, Vec<Pt>) {
    let name_re = Regex::new(r#"<trk>\s*<name>([^<]*)</name>"#).unwrap();
    let any_name = Regex::new(r#"<name>([^<]*)</name>"#).unwrap();
    let name = name_re
        .captures(xml)
        .or_else(|| any_name.captures(xml))
        .map(|c| c[1].to_string())
        .unwrap_or_default();
    let trkpt = Regex::new(
        r#"<trkpt\s+lat="(-?[\d.]+)"\s+lon="(-?[\d.]+)">(?:\s*<ele>([\d.]+)</ele>)?(?:\s*<time>([^<]*)</time>)?</trkpt>"#,
    )
    .unwrap();
    let mut pts = Vec::new();
    for c in trkpt.captures_iter(xml) {
        pts.push(Pt {
            lat: c[1].parse().unwrap_or(0.0),
            lon: c[2].parse().unwrap_or(0.0),
            ele: c.get(3).map(|m| m.as_str().parse().unwrap_or(0.0)).unwrap_or(0.0),
            t: c
                .get(4)
                .map(|m| parse_time_utc_ms(m.as_str()))
                .unwrap_or(f64::NAN),
        });
    }
    (name, pts)
}

struct Brk {
    start: usize,
    end: usize,
    dur_sec: i64,
}

fn detect_breaks(pts: &[Pt]) -> (Vec<Brk>, f64, Vec<f64>) {
    let n = pts.len();
    let mut seg_d = vec![0f64; n];
    let mut seg_t = vec![0f64; n];
    let mut total_m = 0.0;
    for j in 1..n {
        let d = hav(pts[j - 1].lat, pts[j - 1].lon, pts[j].lat, pts[j].lon);
        total_m += d;
        seg_d[j] = d;
        seg_t[j] = (pts[j].t - pts[j - 1].t) / 1000.0;
    }
    let mut p_d = vec![0f64; n];
    let mut p_t = vec![0f64; n];
    for j in 1..n {
        p_d[j] = p_d[j - 1] + seg_d[j];
        p_t[j] = p_t[j - 1] + seg_t[j];
    }
    // stationary[i]: total drift within WINDOW_SEC from point i < BREAK_DRIFT_M
    let mut stationary = vec![false; n];
    for i in 0..n {
        let mut lo = i;
        let mut hi = n - 1;
        while lo < hi {
            let mid = (lo + hi + 1) / 2;
            if p_t[mid] - p_t[i] <= WINDOW_SEC {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        let j = lo;
        stationary[i] = p_d[j] - p_d[i] < BREAK_DRIFT_M;
    }
    let mut brks = Vec::new();
    let mut i = 0;
    while i < n {
        if !stationary[i] {
            i += 1;
            continue;
        }
        let s = i;
        let mut e = i;
        while e + 1 < n && stationary[e + 1] {
            e += 1;
        }
        let dur_sec = ((p_t[e] - p_t[s]) / 1.0).round() as i64;
        if dur_sec >= MIN_BREAK_SEC {
            brks.push(Brk { start: s, end: e, dur_sec });
        }
        i = e + 1;
    }
    (brks, total_m, p_d)
}

// Node's JSON.stringify renders integral f64 as integers (320, not 320.0).
fn num(v: f64) -> Value {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        json!(v as i64)
    } else {
        json!(v)
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

pub struct TzGrid {
    res: f64,
    zones: Vec<String>,
    rows: Vec<Vec<[i32; 3]>>, // [startCol, code, len]
}

impl TzGrid {
    pub fn load(path: &std::path::Path) -> Option<TzGrid> {
        let raw = std::fs::read(path).ok()?;
        let v: Value = serde_json::from_slice(&raw).ok()?;
        let res = v["res"].as_f64()?;
        let zones = v["zones"].as_array()?.iter().filter_map(|x| x.as_str().map(String::from)).collect();
        // rows[r] is a list of runs, each run = [startCol, zoneCode, len]
        let rows: Vec<Vec<[i32; 3]>> = v["rows"]
            .as_array()?
            .iter()
            .map(|r| {
                r.as_array()?
                    .iter()
                    .map(|run| {
                        let ra = run.as_array()?;
                        Some([ra[0].as_i64()? as i32, ra[1].as_i64()? as i32, ra[2].as_i64()? as i32])
                    })
                    .collect::<Option<Vec<_>>>()
            })
            .collect::<Option<Vec<_>>>()?;
        Some(TzGrid { res, zones, rows })
    }

    pub fn at(&self, lat: f64, lon: f64) -> Option<String> {
        let rows_n = (180.0 / self.res).round() as usize;
        let cols_n = (360.0 / self.res).round() as usize;
        let r = (((90.0 - lat) / self.res).floor() as usize).min(rows_n - 1).max(0);
        let c = (((lon + 180.0) / self.res).floor() as usize).min(cols_n - 1).max(0);
        for run in &self.rows[r] {
            if (c as i32) >= run[0] && (c as i32) < run[0] + run[2] {
                if run[1] < 0 {
                    return None;
                }
                return Some(self.zones[run[1] as usize].clone());
            }
        }
        None
    }
}

pub fn process(xml: &str, tz_grid: Option<&TzGrid>) -> Result<RouteData, String> {
    let (name, pts) = parse_gpx(xml);
    if pts.is_empty() {
        return Err("no <trkpt> points found in GPX".into());
    }
    let t0 = pts[0].t;
    let (brks, total_m, p_d) = detect_breaks(&pts);
    let total_sec = ((pts[pts.len() - 1].t - t0) / 1000.0).round() as i64;
    let total_miles = total_m / 1609.34;
    let mid = pts.len() / 2;

    let route: Vec<Value> = pts
        .iter()
        .map(|p| {
            let off = if (p.t - t0).is_finite() {
                json!(((p.t - t0) / 1000.0).round() as i64)
            } else {
                Value::Null
            };
            json!([num(p.lon), num(p.lat), num(p.ele), off])
        })
        .collect();

    let breaks: Vec<Value> = brks
        .iter()
        .map(|b| {
            json!({
                "type": "break",
                "lon": num(pts[b.start].lon),
                "lat": num(pts[b.start].lat),
                "mile": format!("{:.2}", p_d[b.start] / 1609.34),
                "durSec": b.dur_sec,
                "durStr": fmt_dur(b.dur_sec as f64),
                "startUTC": utc_str(t0 + b.start as f64 * 1000.0),
            })
        })
        .collect();

    let timezone = tz_grid
        .and_then(|g| g.at(pts[0].lat, pts[0].lon))
        .unwrap_or_default();

    let data = json!({
        "name": name,
        "timezone": if timezone.is_empty() { Value::Null } else { Value::String(timezone) },
        "totalDistanceMiles": round1(total_miles),
        "totalDistanceKm": round1(total_m / 1000.0),
        "totalDurationSec": total_sec,
        "totalDurationStr": fmt_dur(total_sec as f64),
        "startUTC": utc_str(t0),
        "centerLat": num(pts[mid].lat),
        "centerLon": num(pts[mid].lon),
        "breaks": breaks,
        "route": route,
    });
    Ok(RouteData { data, points: pts })
}

#[allow(dead_code)]
fn _unused_map() -> HashMap<String, u8> {
    HashMap::new()
}
