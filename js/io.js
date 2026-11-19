// 読み込み（CSV / GPX / NMEA / VBO）と書き出し（CSV / 解析CSV / GPX / KML）
import { fmtLap } from './core.js';

// ---------- 読み込み ----------
export function parseFile(text, name = '') {
  const head = text.slice(0, 4000);
  if (/\.vbo$/i.test(name) || /^\s*\[header\]/mi.test(head) && /\[data\]/i.test(text)) return { samples: parseVBO(text), format: 'VBO' };
  if (/<gpx[\s>]/i.test(head) || /\.gpx$/i.test(name)) return { samples: parseGPX(text), format: 'GPX' };
  if (/^\s*\$G[PNLAB][A-Z]{3},/m.test(head) || /\.(nmea|nma|log)$/i.test(name) && /\$G/.test(head)) return { samples: parseNMEA(text), format: 'NMEA' };
  return { samples: parseCSV(text), format: 'CSV' };
}

export function parseGPX(text) {
  const out = [];
  const re = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/gi;
  let m;
  const num = (re2, s) => { const r = re2.exec(s); return r ? parseFloat(r[1]) : NaN; };
  while ((m = re.exec(text))) {
    const lat = num(/lat=["']([^"']+)["']/, m[1]);
    const lon = num(/lon=["']([^"']+)["']/, m[1]);
    const time = (/<time>([^<]+)<\/time>/.exec(m[2]) || [])[1];
    if (!time) continue;
    const ele = num(/<ele>([^<]+)<\/ele>/, m[2]);
    const spd = num(/<(?:\w+:)?speed>([^<]+)<\/(?:\w+:)?speed>/, m[2]);
    const crs = num(/<(?:\w+:)?(?:course|bearing)>([^<]+)<\/(?:\w+:)?(?:course|bearing)>/, m[2]);
    const hdop = num(/<hdop>([^<]+)<\/hdop>/, m[2]);
    out.push({ t: Date.parse(time), lat, lon, alt: ele, spd: Number.isFinite(spd) ? spd : undefined, hdg: Number.isFinite(crs) ? crs : undefined, acc: Number.isFinite(hdop) ? hdop * 3 : undefined });
  }
  return out;
}

function nmeaDeg(v, hemi) {
  if (!v) return NaN;
  const dot = v.indexOf('.') >= 0 ? v.indexOf('.') : v.length;
  const deg = parseFloat(v.slice(0, dot - 2)), min = parseFloat(v.slice(dot - 2));
  const r = deg + min / 60;
  return hemi === 'S' || hemi === 'W' ? -r : r;
}
function todMs(hhmmss) {
  if (!hhmmss || hhmmss.length < 6) return NaN;
  return ((+hhmmss.slice(0, 2)) * 3600 + (+hhmmss.slice(2, 4)) * 60 + parseFloat(hhmmss.slice(4))) * 1000;
}
export function parseNMEA(text) {
  const byTime = new Map();
  let dayBase = null, lastTod = -1;
  const get = (tod) => {
    if (!byTime.has(tod)) byTime.set(tod, { tod });
    return byTime.get(tod);
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/\*[0-9A-F]{2}$/i, '');
    const f = line.split(',');
    const type = f[0].slice(3);
    if (type === 'RMC') {
      if (f[2] !== 'A') continue;
      const tod = todMs(f[1]);
      const d = f[9];
      if (d && d.length >= 6) dayBase = Date.UTC(2000 + +d.slice(4, 6), +d.slice(2, 4) - 1, +d.slice(0, 2));
      const e = get(tod);
      e.lat = nmeaDeg(f[3], f[4]); e.lon = nmeaDeg(f[5], f[6]);
      const sp = parseFloat(f[7]); if (Number.isFinite(sp)) e.spd = sp * 0.514444;
      const hd = parseFloat(f[8]); if (Number.isFinite(hd)) e.hdg = hd;
      e.day = dayBase;
    } else if (type === 'GGA') {
      if (!(+f[6] > 0)) continue;
      const tod = todMs(f[1]);
      const e = get(tod);
      if (!Number.isFinite(e.lat)) { e.lat = nmeaDeg(f[2], f[3]); e.lon = nmeaDeg(f[4], f[5]); }
      const hdop = parseFloat(f[8]); if (Number.isFinite(hdop)) e.acc = hdop * 3;
      const alt = parseFloat(f[9]); if (Number.isFinite(alt)) e.alt = alt;
      e.sats = +f[7];
      if (dayBase !== null && e.day === undefined) e.day = dayBase;
    } else if (type === 'VTG') {
      // 速度だけの文。直前の時刻に紐付けられないので無視
    }
    void lastTod;
  }
  const entries = [...byTime.values()].filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lon)).sort((a, b) => a.tod - b.tod);
  const base0 = entries.find(e => e.day !== undefined && e.day !== null)?.day ?? Date.UTC(2000, 0, 1);
  let day = base0, prev = -1;
  return entries.map(e => {
    if (e.day !== undefined && e.day !== null) day = e.day;
    else if (prev >= 0 && e.tod < prev - 3600e3) day += 86400e3; // 日付またぎ
    prev = e.tod;
    return { t: day + e.tod, lat: e.lat, lon: e.lon, spd: e.spd, hdg: e.hdg, alt: e.alt, acc: e.acc };
  });
}

// Racelogic VBOX (.vbo): 緯度・経度は「分」単位、経度は西が＋
export function parseVBO(text) {
  const lines = text.split(/\r?\n/);
  let cols = null, inData = false, dateBase = Date.UTC(2000, 0, 1);
  const dm = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text.slice(0, 500));
  if (dm) dateBase = Date.UTC(+dm[3], +dm[2] - 1, +dm[1]);
  const out = [];
  let day = dateBase, prevTod = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (/^\[column names\]/i.test(l)) { cols = (lines[i + 1] || '').trim().toLowerCase().split(/\s+/); i++; continue; }
    if (/^\[data\]/i.test(l)) { inData = true; continue; }
    if (/^\[/.test(l)) { inData = false; continue; }
    if (!inData || !cols) continue;
    const f = l.split(/\s+/);
    const g = (name) => { const k = cols.indexOf(name); return k >= 0 ? f[k] : undefined; };
    const lat = parseFloat(g('lat')) / 60, lon = -parseFloat(g('long')) / 60;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const tod = todMs(g('time'));
    if (!Number.isFinite(tod)) continue;
    if (prevTod >= 0 && tod < prevTod - 3600e3) day += 86400e3;
    prevTod = tod;
    const v = parseFloat(g('velocity'));
    out.push({ t: day + tod, lat, lon, spd: Number.isFinite(v) ? v / 3.6 : undefined, hdg: parseFloat(g('heading')), alt: parseFloat(g('height')) });
  }
  return out;
}

const RE = {
  lat: /^(gps[ _]?)?(lat|latitude)\b|緯度/,
  lon: /^(gps[ _]?)?(lon|lng|long|longitude)\b|経度/,
  spd: /^(gps[ _]?)?(speed|spd|velocity|速度)/,
  alt: /^(gps[ _]?)?(alt|altitude|elevation|height|ele)\b|高度|標高/,
  hdg: /^(gps[ _]?)?(heading|bearing|course|hdg)\b|方位/,
  acc: /^(accuracy|hacc|horizontal.?accuracy|gps.?accuracy|精度)/,
  iso: /^(time_iso|utc|datetime|date.?time|gps.?time|time.?utc|日時)/,
  epoch: /^(timestamp|timestamp_ms|unix|epoch)/,
  rel: /^(time|elapsed|elapsed.?time|time.?\(s\)|seconds|session.?time|経過)/,
};
function unitFactor(u) {
  u = (u || '').toLowerCase();
  if (/km\/?h|kph|kmh/.test(u)) return 1 / 3.6;
  if (/mph/.test(u)) return 0.44704;
  if (/knot|kts?\b/.test(u)) return 0.514444;
  if (/m\/s|mps/.test(u)) return 1;
  return null;
}
export function parseCSV(text) {
  const rows = text.split(/\r?\n/);
  const sample = rows.slice(0, 80).join('\n');
  const delim = [',', ';', '\t'].map(d => [d, (sample.match(new RegExp(d === '\t' ? '\\t' : d, 'g')) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
  const split = (l) => l.split(delim).map(s => s.trim().replace(/^"(.*)"$/, '$1'));
  let hi = -1, cols = null;
  for (let i = 0; i < Math.min(rows.length, 80); i++) {
    const c = split(rows[i]).map(s => s.toLowerCase());
    if (c.some(s => RE.lat.test(s)) && c.some(s => RE.lon.test(s))) { hi = i; cols = c; break; }
  }
  if (hi < 0) throw new Error('緯度・経度の列が見つかりません');
  const find = (re) => cols.findIndex(s => re.test(s));
  const iLat = find(RE.lat), iLon = find(RE.lon), iSpd = find(RE.spd), iAlt = find(RE.alt), iHdg = find(RE.hdg), iAcc = find(RE.acc);
  const iIso = find(RE.iso), iEpoch = find(RE.epoch), iRel = find(RE.rel);
  // 見出しの直後に単位行・補足行がある形式（RaceChrono / AiM など）
  let start = hi + 1;
  const units = new Array(cols.length).fill('');
  for (let q = 0; q < 3 && hi + 1 + q < rows.length; q++) {
    const c = split(rows[hi + 1 + q]);
    const numeric = c.filter(v => v !== '' && Number.isFinite(Number(v))).length;
    if (numeric < Math.max(2, c.length * 0.4)) { c.forEach((v, k) => { if (!units[k]) units[k] = v; }); start = hi + 2 + q; } else break;
  }
  const spdK = iSpd >= 0 ? (unitFactor(cols[iSpd]) ?? unitFactor(units[iSpd]) ?? 1 / 3.6) : 1;
  const out = [];
  const base = Date.UTC(2000, 0, 1);
  for (let i = start; i < rows.length; i++) {
    if (!rows[i].trim()) continue;
    const c = split(rows[i]);
    const lat = parseFloat(c[iLat]), lon = parseFloat(c[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    let t = NaN;
    if (iEpoch >= 0) { const v = parseFloat(c[iEpoch]); if (Number.isFinite(v)) t = v > 1e11 ? v : v > 1e8 ? v * 1000 : base + v * 1000; }
    if (!Number.isFinite(t) && iIso >= 0) {
      const s = c[iIso];
      t = Date.parse(s);
      if (!Number.isFinite(t) && /^\d{1,2}:\d{2}:\d{2}/.test(s)) { const [h, m, sec] = s.split(':').map(parseFloat); t = base + ((h * 60 + m) * 60 + sec) * 1000; }
    }
    if (!Number.isFinite(t) && iRel >= 0) {
      const s = c[iRel];
      if (/^\d{1,2}:\d{2}:\d{2}/.test(s)) { const [h, m, sec] = s.split(':').map(parseFloat); t = base + ((h * 60 + m) * 60 + sec) * 1000; }
      else if (/\d{4}-\d{2}-\d{2}/.test(s)) t = Date.parse(s);
      else { const v = parseFloat(s); if (Number.isFinite(v)) t = v > 1e11 ? v : v > 1e8 ? v * 1000 : base + v * 1000; }
    }
    if (!Number.isFinite(t)) continue;
    const sp = iSpd >= 0 ? parseFloat(c[iSpd]) * spdK : NaN;
    const hd = iHdg >= 0 ? parseFloat(c[iHdg]) : NaN;
    out.push({ t, lat, lon, spd: Number.isFinite(sp) ? sp : undefined, alt: iAlt >= 0 ? parseFloat(c[iAlt]) : undefined, hdg: Number.isFinite(hd) ? hd : undefined, acc: iAcc >= 0 ? parseFloat(c[iAcc]) : undefined });
  }
  return out;
}

// ---------- 書き出し ----------
const f = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '');
export function toCSV(session) {
  const lines = ['time_iso,timestamp_ms,lat,lon,alt_m,accuracy_m,speed_kmh,heading_deg'];
  for (const s of session.samples) {
    lines.push([new Date(s.t).toISOString(), s.t, f(s.lat, 7), f(s.lon, 7), f(s.alt, 1), f(s.acc, 1), Number.isFinite(s.spd) ? (s.spd * 3.6).toFixed(2) : '', f(s.hdg, 1)].join(','));
  }
  return lines.join('\n') + '\n';
}

// 解析済みチャンネル（コース距離 2m 刻み）
export function toAnalysisCSV(res, { step = 2 } = {}) {
  const best = res.best;
  const head = ['lap', 'lap_time_s', 'valid', 'distance_m', 'time_s', 'speed_kmh', 'long_g', 'lat_g', 'combined_g', 'line_offset_m', 'delta_to_best_s', 'lat', 'lon', 'alt_m'];
  const lines = [head.join(',')];
  for (const l of res.laps) {
    if (!l.ch) continue;
    const ch = l.ch, stride = Math.max(1, Math.round(step / ch.step));
    for (let g = 0; g < ch.t.length; g += stride) {
      const d = best && best.ch ? ch.t[g] - best.ch.t[Math.min(g, best.ch.t.length - 1)] : NaN;
      lines.push([l.no, l.time.toFixed(3), l.valid ? 1 : 0, (g * ch.step).toFixed(1), ch.t[g].toFixed(3), (ch.v[g] * 3.6).toFixed(2), ch.lg[g].toFixed(3), ch.la[g].toFixed(3), ch.comb[g].toFixed(3), ch.off[g].toFixed(2), f(d, 3), ch.lat[g].toFixed(7), ch.lon[g].toFixed(7), f(ch.alt[g], 1)].join(','));
    }
  }
  return lines.join('\n') + '\n';
}

// ラップ・コーナーの表
export function toLapReportCSV(res) {
  const cn = res.corners.map(c => c.name);
  const head = ['lap', 'time_s', 'valid', 'flags', ...cn.map(n => `${n}_seg_s`), ...cn.map(n => `${n}_min_kmh`), ...cn.map(n => `${n}_brake_m`), 'vmax_kmh', 'max_brake_g', 'max_lat_g'];
  const lines = [head.join(',')];
  for (const l of res.laps) {
    if (!l.ch) { lines.push([l.no, l.time.toFixed(3), 0, l.flags.join('|')].join(',')); continue; }
    lines.push([l.no, l.time.toFixed(3), l.valid ? 1 : 0, l.flags.join('|'),
      ...l.segTimes.map(v => v.toFixed(3)), ...l.cm.map(m => (m.vMin * 3.6).toFixed(1)), ...l.cm.map(m => (m.brake ? m.brake.s.toFixed(0) : '')),
      (l.stats.vmax * 3.6).toFixed(1), l.stats.maxBrake.toFixed(2), l.stats.maxLat.toFixed(2)].join(','));
  }
  return lines.join('\n') + '\n';
}

const esc = (s) => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
export function toGPX(session) {
  const pts = session.samples.map(s => `<trkpt lat="${s.lat.toFixed(7)}" lon="${s.lon.toFixed(7)}">${Number.isFinite(s.alt) ? `<ele>${s.alt.toFixed(1)}</ele>` : ''}<time>${new Date(s.t).toISOString()}</time>${Number.isFinite(s.spd) || Number.isFinite(s.hdg) ? `<extensions>${Number.isFinite(s.spd) ? `<speed>${s.spd.toFixed(2)}</speed>` : ''}${Number.isFinite(s.hdg) ? `<course>${s.hdg.toFixed(1)}</course>` : ''}</extensions>` : ''}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Lap Logger" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${esc(session.name)}</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>\n`;
}

// Google Earth 用（ラップごとのライン。ベストラップは太線）
export function toKML(res) {
  const col = (i) => ['ff3c8cff', 'ff3da5ff', 'ffff8a3d', 'ff7ad46a', 'ffb36bff', 'ff57d3ff'][i % 6];
  const lapPm = res.laps.filter(l => l.ch).map((l, i) => {
    const ch = l.ch, coords = [];
    for (let g = 0; g < ch.lat.length; g += 2) coords.push(`${ch.lon[g].toFixed(7)},${ch.lat[g].toFixed(7)},0`);
    const isBest = l === res.best;
    return `<Placemark><name>L${l.no} ${fmtLap(l.time)}${isBest ? ' ★' : ''}</name><visibility>${isBest ? 1 : 0}</visibility><Style><LineStyle><color>${isBest ? 'ff0000ff' : col(i)}</color><width>${isBest ? 4 : 2}</width></LineStyle></Style><LineString><tessellate>1</tessellate><coordinates>${coords.join(' ')}</coordinates></LineString></Placemark>`;
  }).join('\n');
  const sf = res.sf ? `<Placemark><name>S/F</name><Style><LineStyle><color>ffffffff</color><width>5</width></LineStyle></Style><LineString><coordinates>${res.sf.a.lon},${res.sf.a.lat},0 ${res.sf.b.lon},${res.sf.b.lat},0</coordinates></LineString></Placemark>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(res.session.name)}</name>\n${sf}\n${lapPm}\n</Document></kml>\n`;
}
