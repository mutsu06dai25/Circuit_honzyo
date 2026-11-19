// セッション一覧・読み込み・セッション情報
import * as C from '../core.js';
import * as IO from '../io.js';
import * as S from '../store.js';
import { makeDemoSession } from '../demo.js';
import { $, esc, toast, sheet, confirmSheet, saveFile, safeName, ICON } from './util.js';

let app = null;
export function initSessions(ctx) {
  app = ctx;
  $('fileImport').addEventListener('change', onImport);
  $('btnDemo').addEventListener('click', makeDemo);
  $('sessionList').addEventListener('click', onListClick);
}

function thumbSVG(sum) {
  if (!sum || !sum.thumb) return `<span style="width:28px;height:28px;color:var(--muted);display:block">${ICON.flag}</span>`;
  const t = sum.thumb, pad = 6, w = t.w + pad * 2, h = t.h + pad * 2;
  const d = t.pts.map((p, i) => `${i ? 'L' : 'M'}${(p[0] + pad).toFixed(1)} ${(p[1] + pad).toFixed(1)}`).join('') + 'Z';
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet"><path d="${d}" fill="none" stroke="var(--fg2)" stroke-width="${Math.max(w, h) / 22}" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="${Math.max(w, h) / 60}" stroke-linejoin="round"/></svg>`;
}

export async function render() {
  const list = await S.listSessions();
  const el = $('sessionList');
  if (!list.length) {
    el.innerHTML = `<div class="empty"><div style="font-size:16px;font-weight:700;color:var(--fg)">まだ走行データがありません</div>
      <p>「計測」タブで記録するか、ほかのロガーのファイルを読み込んでください。<br>まずはデモデータで分析画面を試せます。</p>
      <button class="btn primary" id="emptyDemo">${ICON.sparkle} デモデータで試す</button></div>`;
    $('emptyDemo').onclick = makeDemo;
    return;
  }
  const groups = new Map();
  for (const s of list) {
    const tid = s.trackId || 'unknown';
    if (!groups.has(tid)) groups.set(tid, []);
    groups.get(tid).push(s);
  }
  el.innerHTML = [...groups.entries()].map(([tid, arr]) => {
    const tr = app.trackById(tid);
    const best = arr.filter(s => s.summary && s.summary.best).reduce((b, s) => (!b || s.summary.best < b.summary.best ? s : b), null);
    return `<section class="track-group"><h3>${esc(tr ? tr.name : 'コース未判定')} <small>${arr.length} セッション${best ? ` ・ ベスト ${C.fmtLap(best.summary.best)}` : ''}</small></h3>
      <div class="sess-list">${arr.map(s => {
        const i = s.info || {}, sum = s.summary;
        const tags = [i.vehicle, i.tires, i.weather, i.temp ? `${i.temp}℃` : '', i.surface].filter(Boolean);
        return `<div class="card sess" data-id="${s.id}">
          <div class="thumb">${thumbSVG(sum)}</div>
          <div style="min-width:0"><div class="ttl">${esc(s.name)}${s.recording ? ' <span class="tag red">記録中断</span>' : ''}${s.demo ? ' <span class="tag">デモ</span>' : ''}</div>
            <div class="meta">${new Date(s.startedAt).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} ・ ${C.fmtDur(s.duration)}${s.hasMotion ? ' ・ センサー' : ''}</div>
            <div class="row" style="gap:10px;margin-top:2px"><span class="best">${sum && sum.best ? C.fmtLap(sum.best) : '<span class="muted" style="font-size:14px">未解析</span>'}</span>${sum && sum.best ? `<span class="meta">${sum.valid}/${sum.laps} 周${sum.theoretical ? ` ・ 理論 ${C.fmtLap(sum.theoretical)}` : ''}</span>` : ''}</div>
            ${tags.length ? `<div class="chips" style="margin-top:4px">${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}</div>
          <div class="actions"><button class="btn sm primary" data-act="open">${ICON.chart} 分析</button><button class="btn sm" data-act="edit">${ICON.edit} 情報</button><button class="btn sm" data-act="export">${ICON.share} 書き出し</button><span class="spacer"></span><button class="btn sm ghost danger" data-act="del" aria-label="削除">${ICON.trash}</button></div>
        </div>`;
      }).join('')}</div></section>`;
  }).join('');
}

async function onListClick(e) {
  const card = e.target.closest('.sess'); if (!card) return;
  const id = card.dataset.id;
  const b = e.target.closest('button[data-act]');
  const act = b ? b.dataset.act : 'open';
  if (act === 'open') return app.openAnalysis(id);
  if (act === 'edit') { if (await editInfo(id)) render(); return; }
  if (act === 'export') return exportSession(id);
  if (act === 'del') {
    const s = await S.getSession(id);
    if (await confirmSheet(`「${s.name}」を削除しますか？元に戻せません。`, '削除する', true)) { await S.deleteSession(id); app.sessionDeleted(id); render(); toast('削除しました'); }
  }
}

async function exportSession(id) {
  const s = await S.getSession(id);
  const base = safeName(s.name);
  const items = [
    ['生データ CSV（GPS）', () => saveFile(`${base}.csv`, IO.toCSV(s), 'text/csv', { share: true })],
    ['GPX（GPS 軌跡）', () => saveFile(`${base}.gpx`, IO.toGPX(s), 'application/gpx+xml', { share: true })],
    ['JSON（センサー含む全データ・再読込用）', () => saveFile(`${base}.json`, JSON.stringify(s), 'application/json', { share: true })],
  ];
  const v = await sheet({ title: '書き出し・共有', html: `<div class="menu-list">${items.map((it, i) => `<button class="btn" data-x="${i}">${ICON.share} ${esc(it[0])}</button>`).join('')}</div><p class="hint">解析済みのデータ（速度・G・ライン）は分析画面の書き出しから出せます。</p>`, actions: [{ label: '閉じる', value: null }], onOpen: (dlg, finish) => dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => finish(+b.dataset.x)) });
  if (v !== null && v !== undefined) items[v][1]();
}

// ---------- セッション情報の編集（Open-Meteo で天気の自動取得も） ----------
const WCODE = { 0: '快晴', 1: '晴れ', 2: '晴れ時々曇り', 3: '曇り', 45: '霧', 48: '霧', 51: '霧雨', 53: '霧雨', 55: '霧雨', 61: '小雨', 63: '雨', 65: '強い雨', 71: '雪', 73: '雪', 75: '雪', 80: 'にわか雨', 81: 'にわか雨', 82: '強いにわか雨', 95: '雷雨', 96: '雷雨', 99: '雷雨' };
export async function editInfo(id) {
  const s = await S.getSession(id);
  const i = s.info || {};
  const f = (k, label, ph = '', type = 'text') => `<label>${label}<input type="${type}" data-f="${k}" value="${esc(i[k])}" placeholder="${esc(ph)}"></label>`;
  const v = await sheet({
    title: 'セッション情報',
    html: `<div class="form-grid">
      <label class="full">セッション名<input type="text" data-f="__name" value="${esc(s.name)}"></label>
      ${f('vehicle', '車両', 'ND ロードスター')}${f('tires', 'タイヤ', 'RE-71RS')}${f('pressure', '空気圧', '温間 F230 / R220')}${f('driver', 'ドライバー')}
      ${f('weather', '天気')}${f('temp', '気温（℃）', '', 'number')}${f('humidity', '湿度（%）', '', 'number')}${f('surface', '路面', 'ドライ')}
      ${f('setup', 'セットアップ', '減衰・車高など')}${f('wind', '風', '')}
      <label class="full">メモ<textarea data-f="notes">${esc(i.notes)}</textarea></label></div>
      <div class="row" style="margin-top:10px"><button class="btn sm" id="wxBtn">${ICON.weather} 天気・気温を自動取得</button><span class="hint" id="wxMsg" style="margin:0">走行地点と時刻を Open-Meteo（気象API）に送って取得します</span></div>`,
    actions: [{ label: 'キャンセル', value: null }, { label: '保存', primary: true, value: (dlg) => { const out = {}; dlg.querySelectorAll('[data-f]').forEach(el => { out[el.dataset.f] = el.value; }); return out; } }],
    onOpen: (dlg) => {
      dlg.querySelector('#wxBtn').onclick = async () => {
        const msg = dlg.querySelector('#wxMsg');
        msg.textContent = '取得中…';
        try {
          const w = await fetchWeather(s);
          const set = (k, val) => { const el = dlg.querySelector(`[data-f="${k}"]`); if (el && val !== undefined && val !== null && val !== '') el.value = val; };
          set('weather', w.weather); set('temp', w.temp); set('humidity', w.humidity); set('wind', w.wind);
          msg.textContent = `取得しました（${w.time}）`;
        } catch (e) { msg.textContent = '取得できませんでした: ' + e.message; }
      };
    },
  });
  if (!v) return false;
  const name = v.__name; delete v.__name;
  if (name) s.name = name;
  s.info = { ...i, ...v };
  await S.saveSession(s);
  app.prefs.lastInfo = { ...(app.prefs.lastInfo || {}), vehicle: s.info.vehicle, tires: s.info.tires, pressure: s.info.pressure, driver: s.info.driver, setup: s.info.setup };
  app.savePrefs();
  toast('保存しました');
  return true;
}
async function fetchWeather(s) {
  const p = s.samples[Math.floor(s.samples.length / 2)];
  if (!p) throw new Error('位置がありません');
  const t = new Date(s.startedAt);
  const ageDays = (Date.now() - t.getTime()) / 86400e3;
  const lat = p.lat.toFixed(3), lon = p.lon.toFixed(3);
  const hourly = 'temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m';
  const day = t.toISOString().slice(0, 10);
  const url = ageDays < 6
    ? `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${hourly}&past_days=7&forecast_days=1&timezone=UTC&wind_speed_unit=ms`
    : `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${day}&end_date=${day}&hourly=${hourly}&timezone=UTC&wind_speed_unit=ms`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const times = j.hourly.time.map(x => Date.parse(x + 'Z'));
  let k = 0; times.forEach((tt, i) => { if (Math.abs(tt - t.getTime()) < Math.abs(times[k] - t.getTime())) k = i; });
  const h = j.hourly;
  return {
    temp: h.temperature_2m[k] != null ? h.temperature_2m[k].toFixed(1) : '',
    humidity: h.relative_humidity_2m[k] != null ? String(Math.round(h.relative_humidity_2m[k])) : '',
    weather: WCODE[h.weather_code[k]] || '',
    wind: h.wind_speed_10m[k] != null ? `${h.wind_speed_10m[k].toFixed(1)} m/s` : '',
    time: new Date(times[k]).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
  };
}

// ---------- 読み込み ----------
async function onImport(e) {
  let lastId = null, n = 0;
  for (const f of e.target.files) {
    try {
      const text = await f.text();
      if (/\.json$/i.test(f.name) || /^\s*\{/.test(text.slice(0, 50))) {
        const j = JSON.parse(text);
        if (Array.isArray(j.sessions)) { await app.restoreBackup(j); n += j.sessions.length; continue; }
        if (!Array.isArray(j.samples)) throw new Error('対応していない JSON です');
        j.id = j.id || S.newId();
        delete j.truth;
        await S.saveSession(j); lastId = j.id; n++;
        continue;
      }
      const r = IO.parseFile(text, f.name);
      const samples = r.samples.filter(p => Number.isFinite(p.t));
      if (samples.length < 5) throw new Error('有効な位置データがありません');
      const ses = { id: S.newId(), name: f.name.replace(/\.[^.]+$/, ''), startedAt: samples[0].t, samples, motion: [], trackId: null, meta: { imported: f.name, format: r.format }, info: {} };
      app.ensureTrack(ses);
      await S.saveSession(ses); lastId = ses.id; n++;
      toast(`${f.name}: ${r.format} ${samples.length} 点を読み込みました`);
    } catch (err) { toast(`${f.name}: ${err.message}`, 5000); }
  }
  e.target.value = '';
  app.sessionsChanged();
  render();
  if (n > 1) toast(`${n} 件読み込みました`);
  if (lastId && n === 1) app.openAnalysis(lastId);
}

async function makeDemo() {
  toast('デモデータを作成中…', 1500);
  await new Promise(r => setTimeout(r, 30));
  const day = 86400e3;
  const base = Date.now() - 3 * day;
  const mk = async (opts) => {
    const s = makeDemoSession(opts);
    delete s.truth;
    s.id = S.newId();
    await S.saveSession(s);
    return s;
  };
  await mk({ laps: 7, rateHz: 1, seed: 21, skill: 0.985, name: 'デモ: 1本目（練習）', startDate: base, info: { vehicle: 'デモカー', tires: 'ラジアル', pressure: '冷間 200/200', weather: '晴れ', temp: '14', surface: 'ドライ', notes: '架空コースのデモデータ（スマホ GPS 1Hz 相当）' } });
  const s2 = await mk({ laps: 8, rateHz: 1, seed: 11, skill: 1.0, name: 'デモ: 2本目', startDate: base + 2 * 3600e3, info: { vehicle: 'デモカー', tires: 'ラジアル', pressure: '温間 230/225', weather: '晴れ', temp: '16', surface: 'ドライ', notes: 'ブレーキを奥に。T1 の立ち上がりを意識' } });
  app.sessionsChanged();
  render();
  app.openAnalysis(s2.id);
}
