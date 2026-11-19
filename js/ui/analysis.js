// 分析画面
import * as C from '../core.js';
import * as T from '../track.js';
import * as A from '../analysis.js';
import * as IO from '../io.js';
import * as S from '../store.js';
import { $, esc, cssVar, toast, sheet, saveFile, safeName, heat, gColor, deltaColor, ICON } from './util.js';
import { ChartGroup, LineChart, LapBars, drawGG } from './charts.js';
import { TrackMap } from './trackmap.js';

const kmh = C.kmh;
let app = null;
const st = {
  res: null, others: new Map(), lapsByKey: new Map(), otherMeta: [],
  refKey: null, cmpKey: null, sub: 'summary', mapColor: 'speed', mapLayer: 'map', cursor: null, edit: null,
  replay: { playing: false, t: 0, speed: 1, raf: 0, last: 0 },
  group: null, charts: {}, maps: {}, leaflet: null, lapBars: null,
};

export function initAnalysis(ctx) {
  app = ctx;
  $('anaSession').addEventListener('change', (e) => { if (e.target.value) open(e.target.value); });
  $('anaRef').addEventListener('change', (e) => setLaps(e.target.value, st.cmpKey === e.target.value ? '' : st.cmpKey));
  $('anaCmp').addEventListener('change', (e) => selectCmp(e.target.value));
  $('anaExport').addEventListener('click', exportMenu);
  $('anaSubtabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-sub]'); if (b) showSub(b.dataset.sub); });
}

export async function refreshSessionList(selectId) {
  const list = await S.listSessions();
  const sel = $('anaSession');
  const want = selectId || (st.res && st.res.session.id) || '';
  sel.innerHTML = '<option value="">セッションを選択…</option>' + list.map(s => `<option value="${s.id}">${esc(s.name)}｜${new Date(s.startedAt).toLocaleDateString('ja-JP')}${s.summary && s.summary.best ? `｜${C.fmtLap(s.summary.best)}` : ''}</option>`).join('');
  sel.value = want;
  return list;
}

export function onShow() {
  if (!st.res) { refreshSessionList(); $('anaEmpty').hidden = false; $('anaBody').hidden = true; return; }
  if (st.stale) { const sub = st.sub; open(st.res.session.id).then(() => showSub(sub)); return; }
  setTimeout(() => renderSub(), 30);
}
export function currentSessionId() { return st.res ? st.res.session.id : null; }
// 設定変更（コース・G の算出方法など）のあと、次に表示するときに解析し直す
export function invalidate() { st.others.clear(); if (st.res) st.stale = true; }

// ---------- 読み込み ----------
async function analyzeById(id, { merge = true } = {}) {
  const session = await S.getSession(id);
  if (!session) return null;
  const track = app.ensureTrack(session);
  const res = A.analyzeSession(session, track, { gSource: app.prefs.gSource, merge });
  if (res.error) return res;
  let changed = false;
  if (res.modelUpdate) {
    track.model = res.modelUpdate; changed = true;
    if (res.info.rotated !== false && track.best) track.best.ref = null;
    st.others.clear();
  }
  if (res.autoSF && res.model && res.sf && !track.sf) { track.sf = res.sf; track.sfAuto = true; changed = true; }
  if (res.info.built && res.model) {
    track.center = { lat: res.trace.proj.lat0, lon: res.trace.proj.lon0 };
    if (track.id !== 'demo') track.radiusKm = Math.min(track.radiusKm || 3, 3);
    changed = true;
  }
  // 自己ベスト（コースレコード）と予測ラップ用の基準
  if (res.best && res.best.ch && (!track.best || res.best.time < track.best.time - 1e-6 || (track.best.sessionId === session.id && !track.best.ref))) {
    const ch = res.best.ch;
    const sArr = Array.from({ length: ch.t.length }, (_, g) => g * ch.step);
    track.best = { time: res.best.time, sessionId: session.id, lapNo: res.best.no, date: session.startedAt, sessionName: session.name, ref: T.refFromSeries(sArr, ch.t, ch.L, res.best.time, 2) };
    changed = true;
  }
  if (changed) app.saveTrack(track);
  if (JSON.stringify(session.summary || null) !== JSON.stringify(res.summary)) { session.summary = res.summary; S.saveSession(session).then(() => app.sessionsChanged()); }
  return res;
}

export async function open(id) {
  app.showView('analysis', { noRender: true });
  $('anaEmpty').hidden = true; $('anaBody').hidden = false;
  $('anaBody').style.opacity = 0.4;
  await refreshSessionList(id);
  await new Promise(r => setTimeout(r, 16));
  let res;
  try { res = await analyzeById(id); } catch (e) { console.error(e); toast('解析に失敗しました: ' + e.message, 5000); $('anaBody').style.opacity = 1; return; }
  $('anaBody').style.opacity = 1;
  if (!res) return;
  if (res.error) { toast(res.error, 4000); $('anaEmpty').hidden = false; $('anaBody').hidden = true; return; }
  stopReplay();
  st.res = res; st.cursor = null; st.edit = null; st.stale = false;
  st.lapsByKey.clear();
  for (const l of res.laps) st.lapsByKey.set(key(res.session.id, l.no), { lap: l, res });
  for (const [sid, r] of st.others) if (r && !r.error) for (const l of r.laps) st.lapsByKey.set(key(sid, l.no), { lap: l, res: r });
  app.setTrackChip(res.track.name);
  const valid = res.valid.slice().sort((a, b) => a.time - b.time);
  st.refKey = res.best ? key(res.session.id, res.best.no) : null;
  st.cmpKey = valid[1] ? key(res.session.id, valid[1].no) : '';
  const list = await S.listSessions();
  st.otherMeta = list.filter(m => m.id !== res.session.id && m.trackId === res.track.id && !m.recording);
  history.replaceState(null, '', `#analysis/${id}`);
  renderHeader();
  renderSub();
}
const key = (sid, no) => `${sid}:${no}`;
const lapOf = (k) => (k && st.lapsByKey.get(k)) || null;
const ref = () => lapOf(st.refKey);
const cmp = () => lapOf(st.cmpKey);
const lapName = (o) => o ? `${o.res === st.res ? '' : new Date(o.res.session.startedAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) + ' '}L${o.lap.no}` : '';

async function selectCmp(k) {
  if (k && k.startsWith('other:')) {
    const sid = k.split(':')[1];
    let r = st.others.get(sid);
    if (!r) {
      toast('比較セッションを解析中…', 1500);
      r = await analyzeById(sid, { merge: false });
      st.others.set(sid, r);
      if (r && !r.error) for (const l of r.laps) st.lapsByKey.set(key(sid, l.no), { lap: l, res: r });
      // 比較先の解析でコース形状が更新された場合でも、表示中のセッションはそのまま使う
    }
    if (!r || r.error || !r.best) { toast('比較できるラップがありません'); renderHeader(); return; }
    k = key(sid, r.best.no);
  }
  setLaps(st.refKey, k);
}
function setLaps(refKey, cmpKey) {
  st.refKey = refKey; st.cmpKey = cmpKey || '';
  stopReplay(); st.replay.t = 0;
  renderHeader(); renderSub();
}

function renderHeader() {
  const r = st.res;
  const opt = (l, sel) => `<option value="${key(r.session.id, l.no)}" ${sel ? 'selected' : ''} ${l.ch ? '' : 'disabled'}>L${l.no}  ${C.fmtLap(l.time)}${l === r.best ? ' ★' : ''}${l.valid ? '' : ' (無効)'}</option>`;
  $('anaRef').innerHTML = r.laps.length ? r.laps.map(l => opt(l, key(r.session.id, l.no) === st.refKey)).join('') : '<option>周回なし</option>';
  let html = `<option value="">比較なし</option><optgroup label="このセッション">${r.laps.map(l => opt(l, key(r.session.id, l.no) === st.cmpKey)).join('')}</optgroup>`;
  const c = cmp();
  if (st.otherMeta.length) {
    html += `<optgroup label="他のセッションのベストラップ">${st.otherMeta.map(m => {
      const d = new Date(m.startedAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
      const o = st.others.get(m.id);
      const best = o && o.best ? o.best.time : m.summary && m.summary.best;
      return `<option value="other:${m.id}">${d} ${esc(m.name).slice(0, 16)} ${best ? C.fmtLap(best) : '（未解析）'}</option>`;
    }).join('')}</optgroup>`;
  }
  $('anaCmp').innerHTML = html;
  if (c && c.res !== st.res) $('anaCmp').value = `other:${c.res.session.id}`;
}

function showSub(sub) {
  st.sub = sub;
  document.querySelectorAll('#anaSubtabs button').forEach(b => b.classList.toggle('active', b.dataset.sub === sub));
  document.querySelectorAll('#anaBody .subview').forEach(v => v.classList.toggle('active', v.id === `sv-${sub}`));
  if (sub !== 'track') stopReplay();
  renderSub();
  window.scrollTo({ top: 0 });
}
function renderSub() {
  if (!st.res) return;
  const fn = { summary: renderSummary, laps: renderLaps, track: renderTrack, charts: renderCharts, corners: renderCorners, gg: renderGG }[st.sub];
  document.querySelectorAll('#anaSubtabs button').forEach(b => b.classList.toggle('active', b.dataset.sub === st.sub));
  document.querySelectorAll('#anaBody .subview').forEach(v => v.classList.toggle('active', v.id === `sv-${st.sub}`));
  try { fn(); } catch (e) { console.error(e); toast('表示エラー: ' + e.message, 5000); }
}

// ---------- 概要 ----------
function kpi(k, v, s = '', cls = '') { return `<div class="kpi ${cls}"><div class="k">${k}</div><div class="v num">${v}</div><div class="s">${s}</div></div>`; }
function renderSummary() {
  const r = st.res, best = r.best, track = r.track;
  const el = $('sv-summary');
  if (!r.laps.length || !best) {
    el.innerHTML = `<div class="card"><b>周回が検出できませんでした。</b><p class="hint">サーキットを2周以上走ると自動で周回を検出します。うまくいかない場合は「コース」タブで S/F（コントロール）ラインの位置を地図上でタップして設定してください。</p></div>${qualityCard()}`;
    return;
  }
  const valid = r.valid;
  const tb = track.best;
  const pot = r.theoretical ? best.time - r.theoretical : null;
  el.innerHTML = `
    <div class="kpis">
      ${kpi('ベストラップ', C.fmtLap(best.time), `L${best.no} ・ 平均 ${kmh(best.stats.vavg).toFixed(1)} km/h`, 'hero')}
      ${kpi('理論ベスト', r.theoretical ? C.fmtLap(r.theoretical) : '-', pot !== null ? `あと <b class="purple">${pot.toFixed(2)}秒</b> 縮む計算` : '')}
      ${kpi('安定度（ばらつき）', Number.isFinite(r.consistency.sd) ? `±${r.consistency.sd.toFixed(2)}<small>秒</small>` : '-', `${r.consistency.n}周の標準偏差`)}
      ${kpi('最高速', `${kmh(r.perf.vmax).toFixed(1)}<small>km/h</small>`, r.quality.rate < 5 && !r.trace.speedFused ? '1Hz GPS のため低めに出ます' : '')}
      ${kpi('周回', `${valid.length}<small>/ ${r.laps.length}</small>`, `走行 ${C.fmtDur(r.trace.t[r.trace.n - 1])} ・ ${(r.trace.dist[r.trace.n - 1] / 1000).toFixed(1)} km`)}
      ${kpi('最大減速', `${Math.abs(Math.min(...valid.map(l => l.stats.maxBrake))).toFixed(2)}<small>G</small>`, r.gSrc.longSrc === 'sensor' ? 'Gセンサー' : 'GPS 速度から推定')}
      ${kpi('最大横G', `${Math.max(...valid.map(l => l.stats.maxLat)).toFixed(2)}<small>G</small>`, r.gSrc.latSrc === 'gyro' ? 'ジャイロ × 速度' : 'GPS 方位から推定')}
      ${kpi('自己ベスト（このコース）', tb ? C.fmtLap(tb.time) : '-', tb ? `${new Date(tb.date).toLocaleDateString('ja-JP')}${tb.sessionId === r.session.id ? ' ・ このセッション' : ''}` : '')}
    </div>
    <div class="split" style="margin-top:12px">
      <div class="card"><div class="card-title">ラップタイム <span class="muted" style="font-weight:400">（棒をタップで基準ラップに）</span></div><canvas id="lapBars" class="chart" style="border:0;box-shadow:none"></canvas>
        <div class="legend" style="margin-top:6px"><span><span class="dot" style="background:var(--purple)"></span> ベスト</span><span><span class="dot" style="background:var(--ref)"></span> 基準</span><span><span class="dot" style="background:var(--cmp)"></span> 比較</span><span><span class="dot" style="background:var(--line)"></span> 無効（ピット・欠落）</span></div></div>
      <div class="card"><div class="card-title">${ICON.sparkle.replace('<svg', '<svg width="16" height="16"')} タイムを縮められる場所 TOP3 <span class="muted" style="font-weight:400">（ベストラップ vs 区間ベスト）</span></div>${coachHTML()}</div>
    </div>
    <div class="split" style="margin-top:12px">
      <div class="card"><div class="card-title">走り方の内訳（時間の割合）</div>${styleHTML()}${perfHTML()}</div>
      <div>${infoCard()}${qualityCard()}</div>
    </div>`;
  st.lapBars = new LapBars($('lapBars'), { onSelect: (l) => { setLaps(key(r.session.id, l.no), st.cmpKey === key(r.session.id, l.no) ? '' : st.cmpKey); } });
  const rf = ref(), cp = cmp();
  st.lapBars.setData({ laps: r.laps, ref: rf && rf.res === r ? rf.lap : null, cmp: cp && cp.res === r ? cp.lap : null, theoretical: r.theoretical, best });
  el.querySelector('#editInfo')?.addEventListener('click', async () => { const changed = await app.editSessionInfo(r.session.id); if (changed) { const s = await S.getSession(r.session.id); r.session.info = s.info; r.session.name = s.name; renderSummary(); refreshSessionList(); } });
}
function coachHTML() {
  const o = st.res.opportunities;
  if (!o.items || !o.items.length) return '<p class="hint">区間ごとの差がほとんどありません。安定して走れています。</p>';
  return o.items.map((it, i) => `
    <div class="coach-item"><div class="badge">${esc(it.corner.name)}</div>
      <div><b>${esc(it.corner.type)}（${it.corner.dir === 'R' ? '右' : '左'} ${it.corner.angle}°）</b> <span class="muted">— L${it.bestLap.no} の走りでは:</span>
        <ul>${it.notes.length ? it.notes.map(n => `<li>${esc(n)}</li>`).join('') : '<li>大きな違いは見つかりませんでした（ライン・速度の細かな差）</li>'}</ul></div>
      <div class="gain num">−${it.gain.toFixed(2)}s</div></div>`).join('') +
    (o.tips.length ? `<div class="hint" style="margin-top:8px">${o.tips.map(esc).join('<br>')}</div>` : '');
}
function styleRow(label, color, l) {
  if (!l || !l.lap.stats) return '';
  const s = l.lap.stats.style;
  return `<div style="margin:6px 0"><div class="row" style="justify-content:space-between;font-size:12.5px"><span><span class="sw" style="background:${color}"></span> ${esc(label)}</span>
    <span class="muted">加速 ${(s.accel * 100).toFixed(0)}% ・ ブレーキ ${(s.brake * 100).toFixed(0)}% ・ どちらでもない ${(s.neutral * 100).toFixed(0)}%</span></div>
    <div class="style-bar"><span style="width:${s.accel * 100}%;background:var(--throttle)"></span><span style="width:${s.brake * 100}%;background:var(--brake)"></span><span style="width:${s.neutral * 100}%;background:var(--neutral)"></span></div></div>`;
}
function styleHTML() {
  const rf = ref(), cp = cmp();
  return styleRow(`基準 ${lapName(rf)}`, 'var(--ref)', rf) + styleRow(`比較 ${lapName(cp)}`, 'var(--cmp)', cp) +
    '<p class="hint">「どちらでもない」はアクセルもブレーキも弱い時間（惰性・一定速）。少ないほど攻めています。</p>';
}
function perfHTML() {
  const p = st.res.perf;
  const rows = [];
  if (p.accel) rows.push(`<div class="kpi"><div class="k">加速 ${p.accel.from}→${p.accel.to} km/h</div><div class="v num">${p.accel.time.toFixed(2)}<small>秒</small></div><div class="s">${p.accel.dist.toFixed(0)} m（セッション最速）</div></div>`);
  if (p.brake) rows.push(`<div class="kpi"><div class="k">減速 ${p.brake.from}→${p.brake.to} km/h</div><div class="v num">${p.brake.dist.toFixed(1)}<small>m</small></div><div class="s">${p.brake.time.toFixed(2)} 秒（最短距離）</div></div>`);
  return rows.length ? `<div class="card-title" style="margin-top:14px">加速・減速性能</div><div class="grid g2">${rows.join('')}</div>` : '';
}
function infoCard() {
  const i = st.res.session.info || {};
  const items = [['車両', i.vehicle], ['タイヤ', i.tires], ['空気圧', i.pressure], ['天気', i.weather], ['気温', i.temp ? `${i.temp}℃` : ''], ['路面', i.surface], ['ドライバー', i.driver]].filter(x => x[1]);
  return `<div class="card"><div class="card-title">セッション情報 <span class="spacer"></span><button class="btn sm" id="editInfo">${ICON.edit} 編集</button></div>
    ${items.length ? `<div class="chips">${items.map(([k, v]) => `<span class="tag">${k}: ${esc(v)}</span>`).join('')}</div>` : '<p class="hint" style="margin:0">車両・タイヤ・空気圧・天気などを記録しておくと、あとで比べるときに役立ちます。</p>'}
    ${i.notes ? `<p style="margin:8px 0 0;white-space:pre-wrap">${esc(i.notes)}</p>` : ''}</div>`;
}
function qualityCard() {
  const r = st.res, q = r.quality, s = q.sensor;
  const accTxt = Number.isFinite(q.accMedian) ? `${q.accMedian.toFixed(1)} m` : '-';
  return `<div class="card"><div class="card-title">データの品質</div>
    <div class="chips">
      <span class="tag">GPS ${q.rate.toFixed(q.rate < 2 ? 1 : 0)} Hz</span>
      <span class="tag">精度(中央値) ${accTxt}</span>
      <span class="tag">${q.doppler ? 'ドップラー速度' : '位置から速度算出'}</span>
      ${q.gaps ? `<span class="tag red">欠落 ${q.gaps} 回</span>` : ''}
      ${s ? `<span class="tag ${s.long ? '' : 'red'}">加速度 ${s.long ? `向き推定OK ${(s.qLong * 100).toFixed(0)}%` : '推定できず'}</span>` : '<span class="tag">Gセンサーなし</span>'}
      ${s && s.hasGyro ? `<span class="tag ${s.yaw ? '' : 'red'}">ジャイロ ${s.yaw ? `OK ${(s.qYaw * 100).toFixed(0)}%` : '使えず'}</span>` : ''}
      ${r.trace.speedFused ? '<span class="tag purple">速度: GPS+加速度で補完</span>' : ''}
      ${r.info.shift ? `<span class="tag">位置ずれ補正 ${r.info.shift.mag.toFixed(1)} m</span>` : ''}
      ${r.model ? `<span class="tag">コース形状 ${r.model.L.toFixed(0)} m / ${r.model.lapsUsed}周分</span>` : ''}
    </div>
    <p class="hint" style="margin-bottom:0">スマホ GPS の位置誤差は 1〜3m 程度あります。ライン位置の 1m 未満の差は誤差の範囲と考えてください。</p></div>`;
}

// ---------- ラップ（スプリット表） ----------
function renderLaps() {
  const r = st.res, el = $('sv-laps');
  if (!r.laps.length) { el.innerHTML = '<div class="empty">周回がありません。</div>'; return; }
  const cn = r.corners;
  const ns = Math.max(0, ...r.laps.map(l => l.sectors.length));
  const vals = r.valid;
  const colBest = cn.map((_, k) => Math.min(...vals.map(l => l.segTimes[k])));
  const colWorst = cn.map((_, k) => Math.max(...vals.map(l => l.segTimes[k])));
  const secBest = Array.from({ length: ns }, (_, j) => Math.min(...vals.filter(l => l.sectors[j]).map(l => l.sectors[j])));
  const rk = st.refKey, ck = st.cmpKey;
  const cell = (v, b, w) => {
    if (!Number.isFinite(v)) return '<td></td>';
    if (Math.abs(v - b) < 1e-6) return `<td class="c-best">${v.toFixed(2)}</td>`;
    const f = Math.min(1, (v - b) / Math.max(0.15, (w - b)));
    return `<td style="background:color-mix(in srgb, ${f < 0.5 ? 'var(--good)' : 'var(--bad)'} ${Math.round(8 + 22 * Math.abs(f - 0.5) * 2)}%, transparent)">${v.toFixed(2)}</td>`;
  };
  const rows = r.laps.map(l => {
    const k = key(r.session.id, l.no);
    const flags = l.flags.map(f => ({ pit: 'ピット', gap: 'GPS欠落', slow: 'スロー', nomatch: '形状不一致' }[f] || f));
    return `<tr data-k="${k}" class="${l.valid ? '' : 'invalid'} ${k === rk ? 'is-ref' : ''} ${k === ck ? 'is-cmp' : ''}">
      <td><span class="lapno">L${l.no}</span>${l === r.best ? ' <span class="purple">★</span>' : ''}</td>
      <td style="padding:4px 6px"><button class="pickbtn ref ${k === rk ? 'on' : ''}" data-act="ref" title="基準にする">基</button><button class="pickbtn cmp ${k === ck ? 'on' : ''}" data-act="cmp" title="比較にする">比</button></td>
      <td class="t">${C.fmtLap(l.time)}</td>
      <td class="${l === r.best ? '' : 'bad'}">${l === r.best || !r.best ? '' : C.fmtDelta(l.time - r.best.time, 2)}</td>
      ${l.segTimes ? cn.map((_, k2) => l.valid ? cell(l.segTimes[k2], colBest[k2], colWorst[k2]) : `<td>${l.segTimes[k2].toFixed(2)}</td>`).join('') : cn.map(() => '<td></td>').join('')}
      ${Array.from({ length: ns }, (_, j) => l.sectors[j] ? (l.valid && Math.abs(l.sectors[j] - secBest[j]) < 1e-6 ? `<td class="c-best">${l.sectors[j].toFixed(2)}</td>` : `<td>${l.sectors[j].toFixed(2)}</td>`) : '<td></td>').join('')}
      <td>${l.stats ? kmh(l.stats.vmax).toFixed(0) : ''}</td>
      <td>${l.stats ? Math.abs(l.stats.maxBrake).toFixed(2) : ''}</td>
      <td style="text-align:left">${flags.map(f => `<span class="tag red">${f}</span>`).join(' ')}</td></tr>`;
  }).join('');
  const theo = r.theoretical;
  el.innerHTML = `
    <div class="row" style="margin-bottom:8px"><span class="hint" style="margin:0">区間 = 各コーナーを含む区間（直線の中央で区切り）。<b class="purple">紫</b> は全ラップ中の最速区間。</span><span class="spacer"></span>
      <button class="btn sm" id="lapCsv">${ICON.share} ラップ表 CSV</button></div>
    <div class="table-wrap"><table class="tbl" id="splitTbl">
      <thead><tr><th>周</th><th></th><th>タイム</th><th>差</th>${cn.map(c => `<th title="${esc(c.type)}">${esc(c.name)}</th>`).join('')}${Array.from({ length: ns }, (_, j) => `<th>S${j + 1}</th>`).join('')}<th>最高</th><th>減速G</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
      ${theo ? `<tfoot><tr><td><b class="purple">理論</b></td><td></td><td class="t purple">${C.fmtLap(theo)}</td><td></td>${colBest.map(v => `<td class="c-best">${v.toFixed(2)}</td>`).join('')}${secBest.map(v => `<td class="c-best">${Number.isFinite(v) ? v.toFixed(2) : ''}</td>`).join('')}<td></td><td></td><td></td></tr></tfoot>` : ''}
    </table></div>
    <h3>コーナーごとのばらつき <small>有効ラップ ${r.valid.length} 周</small></h3>
    <div class="table-wrap"><table class="tbl"><thead><tr><th>コーナー</th><th>区間 最速</th><th>平均</th><th>最低速度 平均</th><th>ばらつき</th><th>ブレーキ開始 ばらつき</th></tr></thead><tbody>
      ${cn.map((c, k) => { const s = r.cornerStats[k]; return `<tr><td><b>${esc(c.name)}</b> <span class="muted">${c.dir === 'R' ? '右' : '左'}${c.angle}°</span></td><td class="purple">${s.seg ? s.seg.min.toFixed(2) : '-'}</td><td>${s.seg ? s.seg.mean.toFixed(2) : '-'}</td><td>${s.vMin ? kmh(s.vMin.mean).toFixed(1) : '-'}</td><td>${s.vMin ? `±${kmh(s.vMin.sd).toFixed(1)} km/h` : '-'}</td><td>${s.brakeS ? `±${s.brakeS.sd.toFixed(0)} m` : 'ノーブレーキ'}</td></tr>`; }).join('')}
    </tbody></table></div>`;
  el.querySelector('tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-k]'); if (!tr) return;
    const b = e.target.closest('button[data-act]');
    const k = tr.dataset.k;
    if (b && b.dataset.act === 'cmp') setLaps(st.refKey === k ? st.cmpKey : st.refKey, st.cmpKey === k ? '' : k);
    else setLaps(k, st.cmpKey === k ? '' : st.cmpKey);
  });
  $('lapCsv').addEventListener('click', () => saveFile(`${safeName(r.session.name)}_laps.csv`, IO.toLapReportCSV(r), 'text/csv', { share: true }));
}

// ---------- 共通: ラップの描画データ ----------
function posAt(ch, s) { const g = Math.max(0, Math.min(ch.x.length - 1, s / ch.step)); return [C.interpAt(ch.x, g), C.interpAt(ch.y, g)]; }
// 他セッションのラップは自分の座標系に変換
function lapXY(o) {
  const ch = o.lap.ch;
  if (o.res === st.res) return { x: ch.x, y: ch.y };
  if (!o._xy) {
    const p = st.res.trace.proj;
    const x = new Float64Array(ch.lat.length), y = new Float64Array(ch.lat.length);
    for (let i = 0; i < x.length; i++) { const [a, b] = p.toXY(ch.lat[i], ch.lon[i]); x[i] = a; y[i] = b; }
    o._xy = { x, y }; // 相手側も同じコースモデルに位置合わせ済みなので、そのまま重ねられる
  }
  return o._xy;
}
function sceneBase() {
  const r = st.res;
  const sectorsXY = (r.track.sectors || []).map(l => [r.trace.proj.toXY(l.a.lat, l.a.lon), r.trace.proj.toXY(l.b.lat, l.b.lon)]);
  let osm = null;
  if (r.track.osm && r.track.osm.ways) osm = r.track.osm.ways.map(w => { const x = [], y = []; for (const [la, lo] of w.pts) { const [a, b] = r.trace.proj.toXY(la, lo); x.push(a); y.push(b); } return { x, y, width: w.width }; });
  return { model: r.model, corners: r.corners, sectorsXY, osm };
}
function lapColors(o, mode, other) {
  const ch = o.lap.ch, n = ch.v.length;
  const cols = new Array(n);
  if (mode === 'speed') {
    let lo = Infinity, hi = 0; for (const v of ch.v) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let i = 0; i < n; i++) cols[i] = heat(Math.round((ch.v[i] - lo) / (hi - lo || 1) * 14) / 14);
  } else if (mode === 'long') for (let i = 0; i < n; i++) cols[i] = gColor(Math.round(ch.lg[i] * 10) / 10);
  else if (mode === 'lat') for (let i = 0; i < n; i++) cols[i] = heat(Math.round(Math.min(1, Math.abs(ch.la[i]) / 1.2) * 12) / 12);
  else if (mode === 'delta' && other) {
    const d = A.deltaSeries(other.lap, o.lap);
    const w = Math.max(1, Math.round(6 / ch.step));
    for (let i = 0; i < n; i++) { const a = Math.max(0, i - w), b = Math.min(d.length - 1, i + w); const sl = (d[b] - d[a]) / ((b - a) * ch.step || 1); cols[i] = deltaColor(Math.round(sl * 2000) / 2000); }
  } else return null;
  return cols;
}
function markersFor(o, color) {
  const out = [];
  if (!o) return out;
  for (const m of o.lap.cm || []) {
    if (m.brake) { const [x, y] = posAt(o.lap.ch, m.brake.s); out.push({ x, y, type: 'brake', color: cssVar('--brake') }); }
    if (m.sThrottle !== null) { const [x, y] = posAt(o.lap.ch, m.sThrottle); out.push({ x, y, type: 'throttle', color: cssVar('--throttle') }); }
    const [x, y] = posAt(o.lap.ch, m.sApex); out.push({ x, y, type: 'apex', color });
  }
  return out;
}

// ---------- コース ----------
function renderTrack() {
  const r = st.res, el = $('sv-track');
  if (!el.dataset.ready) {
    el.innerHTML = `
      <div class="row" style="margin-bottom:8px">
        <div class="seg" id="mapLayerSeg"><button data-v="map" class="active">${'コース図'}</button><button data-v="sat">航空写真</button></div>
        <select id="mapColor"><option value="speed">色: 速度</option><option value="long">色: ブレーキ／加速</option><option value="lat">色: 横G</option><option value="delta">色: タイム差（比較）</option><option value="plain">色: ラップ別</option></select>
        <span class="spacer"></span>
        <button class="btn sm" id="btnSF">${ICON.flag} S/F 設定</button>
        <button class="btn sm" id="btnSec">${ICON.plus} セクター</button>
        <button class="btn sm ghost" id="btnSecClr">セクター消去</button>
      </div>
      <div class="map-wrap" id="mapWrap">
        <canvas class="trackmap" id="trackCanvas" style="height:min(62vh,560px)"></canvas>
        <div id="leaflet" hidden></div>
        <div class="map-tools"><button class="btn icon-btn" id="mzIn" title="拡大">${ICON.plus}</button><button class="btn icon-btn" id="mzOut" title="縮小">${ICON.minus}</button><button class="btn icon-btn" id="mzFit" title="全体">${ICON.fit}</button></div>
        <div class="map-hint" id="mapHint" hidden></div>
      </div>
      <div class="legend" id="mapLegend" style="margin-top:6px"></div>
      <div class="card" style="margin-top:12px">
        <div class="card-title">リプレイ（2台を同時に走らせて比較）</div>
        <div class="replay"><button class="btn icon-btn" id="rpPlay">${ICON.play}</button>
          <div class="seg" id="rpSpeed"><button data-v="0.5">½×</button><button data-v="1" class="active">1×</button><button data-v="2">2×</button><button data-v="4">4×</button></div>
          <input type="range" id="rpRange" min="0" max="1000" value="0"><span class="num" id="rpTime" style="font-size:18px;min-width:64px;text-align:right">0.0</span></div>
        <div class="readout" id="rpRead"></div>
      </div>
      <h3>ライン位置 <small>基準ライン（全ラップの平均）から右が＋ / 灰色 = 全ラップの走行範囲</small></h3>
      <canvas class="chart" id="cOffTrack"></canvas>
      <p class="hint">「どこを走ったか」をコース上の横位置で比べます。スマホ GPS の誤差（±1〜2m）があるので、大きなライン変化やミス（膨らみ）を見るのに向いています。</p>`;
    el.dataset.ready = '1';
    st.maps.main = new TrackMap($('trackCanvas'), { interactive: true });
    st.maps.main.onTap = onMapTap;
    $('mzIn').onclick = () => (st.mapLayer === 'sat' ? st.leaflet?.zoomIn() : st.maps.main.zoomAt(1.5));
    $('mzOut').onclick = () => (st.mapLayer === 'sat' ? st.leaflet?.zoomOut() : st.maps.main.zoomAt(1 / 1.5));
    $('mzFit').onclick = () => (st.mapLayer === 'sat' ? fitLeaflet() : st.maps.main.reset());
    $('mapColor').onchange = (e) => { st.mapColor = e.target.value; drawTrack(); };
    $('mapLayerSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.mapLayer = b.dataset.v; drawTrack(); };
    $('btnSF').onclick = () => setEdit(st.edit === 'sf' ? null : 'sf');
    $('btnSec').onclick = () => setEdit(st.edit === 'sector' ? null : 'sector');
    $('btnSecClr').onclick = async () => { st.res.track.sectors = []; app.saveTrack(st.res.track); await reanalyze(); toast('セクターを消去しました'); };
    $('rpPlay').onclick = () => (st.replay.playing ? stopReplay() : startReplay());
    $('rpSpeed').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.replay.speed = +b.dataset.v; [...$('rpSpeed').children].forEach(x => x.classList.toggle('active', x === b)); };
    $('rpRange').oninput = (e) => { const T = replayDuration(); st.replay.t = +e.target.value / 1000 * T; updateReplay(); };
    st.offGroup = new ChartGroup();
    st.offChart = st.offGroup.add(new LineChart($('cOffTrack'), { title: 'ライン位置', unit: 'm（右＋）', height: 170, zeroLine: true, symmetric: true, fmt: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` }));
    st.offGroup.onCursor((x) => { st.cursor = x; updateCursorDots(); });
  }
  $('mapColor').value = st.mapColor;
  drawTrack();
}
function drawTrack() {
  const r = st.res, rf = ref(), cp = cmp();
  [...$('mapLayerSeg').children].forEach(b => b.classList.toggle('active', b.dataset.v === st.mapLayer));
  const sat = st.mapLayer === 'sat';
  $('trackCanvas').hidden = sat; $('leaflet').hidden = !sat;
  const mode = st.mapColor;
  const laps = [];
  if (cp && cp.lap.ch) { const xy = lapXY(cp); laps.push({ ...xy, color: cssVar('--cmp'), width: mode === 'plain' || mode === 'delta' ? 3 : 2.2, dash: mode === 'plain' || mode === 'delta' ? null : [6, 5], colors: mode === 'delta' && rf ? lapColors(cp, 'delta', rf) : null }); }
  if (rf && rf.lap.ch) { const xy = lapXY(rf); const cols = mode === 'plain' || mode === 'delta' ? null : lapColors(rf, mode); laps.push({ ...xy, color: cssVar('--ref'), width: 3.2, colors: cols }); }
  const scene = { ...sceneBase(), laps, markers: rf ? markersFor(rf, cssVar('--ref')) : [] };
  const refit = st.maps.main.scene ? st.maps.main.scene.model !== scene.model : true;
  if (!sat) st.maps.main.setScene(scene, { refit });
  else drawLeaflet();
  // 凡例
  let lg = '';
  if (mode === 'speed' && rf) { let lo = Infinity, hi = 0; for (const v of rf.lap.ch.v) { lo = Math.min(lo, v); hi = Math.max(hi, v); } lg = `<span>${kmh(lo).toFixed(0)} km/h</span><span class="grad" style="background:linear-gradient(90deg,${[0, .25, .5, .75, 1].map(heat).join(',')})"></span><span>${kmh(hi).toFixed(0)} km/h</span>`; }
  else if (mode === 'long') lg = `<span>ブレーキ</span><span class="grad" style="background:linear-gradient(90deg,${gColor(-0.8)},${gColor(0)},${gColor(0.8)})"></span><span>加速</span>`;
  else if (mode === 'lat') lg = `<span>0G</span><span class="grad" style="background:linear-gradient(90deg,${[0, .25, .5, .75, 1].map(heat).join(',')})"></span><span>1.2G</span>`;
  else if (mode === 'delta') lg = cp ? `<span style="color:var(--good)">■</span> 比較が速い区間 <span style="color:var(--bad)">■</span> 比較が遅い区間` : '比較ラップを選ぶと区間ごとの速い・遅いを色分けします';
  lg += ` <span><span class="sw ref"></span> 基準 ${lapName(rf)}</span>${cp ? ` <span><span class="sw cmp"></span> 比較 ${lapName(cp)}</span>` : ''}`;
  lg += ` <span><span class="dot" style="background:var(--brake)"></span> ブレーキ開始</span><span>▲ アクセルON</span><span>◆ 最低速度</span>`;
  $('mapLegend').innerHTML = lg;
  // ライン位置グラフ
  if (rf && rf.lap.ch) {
    const m = r.model, ch = rf.lap.ch, xs = Array.from({ length: ch.off.length }, (_, g) => g * ch.step);
    const env = { x: xs, lo: xs.map((_, g) => m.left[g % m.N]), hi: xs.map((_, g) => m.right[g % m.N]), color: cssVar('--grid') };
    const series = [{ x: xs, y: ch.off, color: cssVar('--ref'), label: '基準', width: 2 }];
    if (cp && cp.lap.ch) series.push({ x: xs, y: cp.lap.ch.off, color: cssVar('--cmp'), label: '比較', width: 2 });
    st.offChart.setData({ series, bands: cornerBands(), envelope: env });
    if (st.offGroup.full[1] !== m.L) st.offGroup.setFull(0, m.L); else st.offGroup.draw();
  }
  updateReplay();
}
function cornerBands() { return st.res.corners.map(c => ({ x0: c.s0, x1: c.s1, label: c.name })); }
function setEdit(mode) {
  st.edit = mode;
  $('btnSF').classList.toggle('on', mode === 'sf');
  $('btnSec').classList.toggle('on', mode === 'sector');
  const h = $('mapHint');
  h.hidden = !mode;
  h.textContent = mode === 'sf' ? 'コントロールライン（S/F）の位置をタップしてください' : mode === 'sector' ? 'セクターの区切りにしたい地点をタップしてください' : '';
}
async function onMapTap(x, y) {
  const r = st.res;
  if (st.edit) {
    const tr = r.trace;
    let k = -1, bd = Infinity;
    for (let q = 0; q < tr.n; q++) { const d = (tr.x[q] - x) ** 2 + (tr.y[q] - y) ** 2; if (d < bd) { bd = d; k = q; } }
    if (k < 0 || bd > 40 * 40) { toast('コース上をタップしてください'); return; }
    let kk = k, bv = tr.v[k];
    for (let q = 0; q < tr.n; q++) { if (tr.v[q] <= bv) continue; if ((tr.x[q] - tr.x[k]) ** 2 + (tr.y[q] - tr.y[k]) ** 2 < 36) { kk = q; bv = tr.v[q]; } }
    const line = C.lineAt(tr, kk, 40);
    if (st.edit === 'sf') { r.track.sf = line; r.track.sfAuto = false; toast('S/F ラインを設定しました'); }
    else { r.track.sectors = [...(r.track.sectors || []), line]; toast(`セクターライン ${r.track.sectors.length} を追加しました`); }
    app.saveTrack(r.track);
    setEdit(null);
    await reanalyze();
    return;
  }
  if (!r.model) return;
  const P = T.makeProjector(r.model);
  const p = P.project(x, y);
  if (p.d > 40) return;
  st.cursor = p.s;
  stopReplay();
  updateCursorDots();
  if (st.offGroup) st.offGroup.setCursor(p.s, 'map');
}
async function reanalyze() {
  const id = st.res.session.id;
  const keep = st.sub;
  st.others.clear();
  await open(id);
  showSub(keep);
}

// ---------- 航空写真（Leaflet） ----------
function drawLeaflet() {
  if (typeof L === 'undefined') { $('leaflet').innerHTML = '<div class="empty">地図ライブラリを読み込めませんでした</div>'; return; }
  const r = st.res, rf = ref(), cp = cmp();
  if (!st.leaflet) {
    st.leaflet = L.map('leaflet', { preferCanvas: true, zoomControl: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri' }).addTo(st.leaflet);
    st.leafLayers = L.layerGroup().addTo(st.leaflet);
    st.leaflet.on('click', (e) => { const [x, y] = r.trace.proj.toXY(e.latlng.lat, e.latlng.lng); onMapTap(x, y); });
  }
  setTimeout(() => st.leaflet.invalidateSize(), 50);
  st.leafLayers.clearLayers();
  const ll = (ch) => Array.from(ch.lat, (la, i) => [la, ch.lon[i]]);
  if (cp && cp.lap.ch) L.polyline(ll(cp.lap.ch), { color: cssVar('--cmp'), weight: 3, opacity: 0.95 }).addTo(st.leafLayers);
  if (rf && rf.lap.ch) {
    const cols = lapColors(rf, st.mapColor === 'plain' || st.mapColor === 'delta' ? 'speed' : st.mapColor);
    const ch = rf.lap.ch;
    let seg = [], col = null;
    for (let i = 0; i < ch.lat.length; i += 2) { const p = [ch.lat[i], ch.lon[i]]; if (cols[i] !== col && seg.length) { seg.push(p); L.polyline(seg, { color: col, weight: 4 }).addTo(st.leafLayers); seg = []; } col = cols[i]; seg.push(p); }
    if (seg.length > 1) L.polyline(seg, { color: col, weight: 4 }).addTo(st.leafLayers);
    for (const m of rf.lap.cm || []) if (m.brake) { const g = Math.round(m.brake.s / ch.step); L.circleMarker([ch.lat[g], ch.lon[g]], { radius: 5, color: '#fff', weight: 1.5, fillColor: cssVar('--brake'), fillOpacity: 1 }).addTo(st.leafLayers); }
  }
  if (r.sf) L.polyline([[r.sf.a.lat, r.sf.a.lon], [r.sf.b.lat, r.sf.b.lon]], { color: '#fff', weight: 4 }).addTo(st.leafLayers);
  for (const l of r.track.sectors || []) L.polyline([[l.a.lat, l.a.lon], [l.b.lat, l.b.lon]], { color: '#ffc53d', weight: 4 }).addTo(st.leafLayers);
  if (r.model) r.corners.forEach((c, i) => {
    const m = r.model, q = Math.round(c.sApex / m.step) % m.N, side = c.dir === 'R' ? -1 : 1, o = (side > 0 ? m.right[q] : m.left[q]) + side * 12;
    const [la, lo] = r.trace.proj.toLatLon(m.x[q] + o * m.nx[q], m.y[q] + o * m.ny[q]);
    L.marker([la, lo], { icon: L.divIcon({ className: '', html: `<div class="corner-label">${i + 1}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(st.leafLayers);
  });
  st.leafDots = [];
  if (!st.leafFitted || st.leafFitted !== r.session.id) fitLeaflet();
  updateCursorDots();
}
function fitLeaflet() {
  const r = st.res; if (!st.leaflet || !r.model) return;
  const pts = []; for (let j = 0; j < r.model.N; j += 10) pts.push(r.trace.proj.toLatLon(r.model.x[j], r.model.y[j]));
  st.leaflet.fitBounds(L.latLngBounds(pts), { padding: [20, 20] });
  st.leafFitted = r.session.id;
}

// ---------- カーソル・リプレイ ----------
function dotsAt(sRef, sCmp) {
  const rf = ref(), cp = cmp(), out = [];
  if (cp && cp.lap.ch && Number.isFinite(sCmp)) { const xy = lapXY(cp); const g = Math.max(0, Math.min(xy.x.length - 1, sCmp / cp.lap.ch.step)); out.push({ x: C.interpAt(xy.x, g), y: C.interpAt(xy.y, g), color: cssVar('--cmp'), label: '比較', s: sCmp }); }
  if (rf && rf.lap.ch && Number.isFinite(sRef)) { const xy = lapXY(rf); const g = Math.max(0, Math.min(xy.x.length - 1, sRef / rf.lap.ch.step)); out.push({ x: C.interpAt(xy.x, g), y: C.interpAt(xy.y, g), color: cssVar('--ref'), label: '基準', s: sRef }); }
  return out;
}
function updateCursorDots() {
  const s = st.cursor;
  const dots = s === null ? [] : dotsAt(s, s);
  if (st.maps.main) st.maps.main.setDots(dots);
  if (st.maps.mini) st.maps.mini.setDots(dots);
  if (st.leaflet && st.mapLayer === 'sat') {
    (st.leafDots || []).forEach(d => st.leaflet.removeLayer(d));
    st.leafDots = dots.map(d => { const [la, lo] = st.res.trace.proj.toLatLon(d.x, d.y); return L.circleMarker([la, lo], { radius: 7, color: '#fff', weight: 2, fillColor: d.color, fillOpacity: 1 }).addTo(st.leaflet); });
  }
}
function replayDuration() { const rf = ref(), cp = cmp(); return Math.max(rf ? rf.lap.time : 0, cp ? cp.lap.time : 0) || 1; }
function startReplay() {
  if (!ref()) return;
  if (st.replay.t >= replayDuration() - 0.01) st.replay.t = 0;
  st.replay.playing = true; st.replay.last = performance.now();
  $('rpPlay').innerHTML = ICON.pause;
  const tick = (now) => {
    if (!st.replay.playing) return;
    st.replay.t += (now - st.replay.last) / 1000 * st.replay.speed; st.replay.last = now;
    if (st.replay.t >= replayDuration()) { st.replay.t = replayDuration(); stopReplay(); }
    updateReplay();
    st.replay.raf = requestAnimationFrame(tick);
  };
  st.replay.raf = requestAnimationFrame(tick);
}
function stopReplay() {
  st.replay.playing = false; cancelAnimationFrame(st.replay.raf);
  const b = $('rpPlay'); if (b) b.innerHTML = ICON.play;
}
function updateReplay() {
  const rf = ref(), cp = cmp();
  if (!rf || !rf.lap.ch || !$('rpRange')) return;
  const t = st.replay.t;
  const sR = A.sAtTime(rf.lap.ch, Math.min(t, rf.lap.time));
  const sC = cp && cp.lap.ch ? A.sAtTime(cp.lap.ch, Math.min(t, cp.lap.time)) : NaN;
  if (t > 0 || st.replay.playing) {
    const dots = dotsAt(sR, sC);
    st.maps.main.setDots(dots);
    if (st.leaflet && st.mapLayer === 'sat') { st.cursor = sR; updateCursorDots(); }
    if (st.offGroup) { st.offGroup.cursor = sR; st.offGroup.draw(); }
  }
  $('rpRange').value = Math.round(t / replayDuration() * 1000);
  $('rpTime').textContent = t.toFixed(1);
  const g = (ch, s) => Math.max(0, Math.min(ch.v.length - 1, Math.round(s / ch.step)));
  const items = [['基準 速度', `${kmh(rf.lap.ch.v[g(rf.lap.ch, sR)]).toFixed(0)}<small> km/h</small>`, 'var(--ref)']];
  if (cp && cp.lap.ch) {
    items.push(['比較 速度', `${kmh(cp.lap.ch.v[g(cp.lap.ch, sC)]).toFixed(0)}<small> km/h</small>`, 'var(--cmp)']);
    const gapT = A.timeAtS(cp.lap.ch, sR) - A.timeAtS(rf.lap.ch, sR);
    items.push(['タイム差', C.fmtDelta(gapT, 2), gapT > 0 ? 'var(--bad)' : 'var(--good)']);
    items.push(['距離差', `${(sR - sC).toFixed(0)}<small> m</small>`, '']);
  }
  const corner = st.res.corners.find(c => sR >= c.s0 - 20 && sR <= c.s1 + 20);
  items.push(['位置', `${sR.toFixed(0)}<small> m</small>${corner ? ` ${esc(corner.name)}` : ''}`, '']);
  $('rpRead').innerHTML = items.map(([k, v, c]) => `<div><div class="k">${k}</div><div class="v" style="color:${c || 'inherit'}">${v}</div></div>`).join('');
}

// ---------- グラフ ----------
const CHANNELS = [
  { id: 'speed', name: '速度', unit: 'km/h', h: 190 },
  { id: 'delta', name: 'タイム差（比較−基準）', unit: '秒', h: 130 },
  { id: 'long', name: '前後G（＋加速／−ブレーキ）', unit: 'G', h: 150 },
  { id: 'lat', name: '横G（＋右／−左）', unit: 'G', h: 150 },
  { id: 'off', name: 'ライン位置（右＋）', unit: 'm', h: 140 },
  { id: 'comb', name: '合成G', unit: 'G', h: 130 },
  { id: 'time', name: '経過時間', unit: '秒', h: 120 },
  { id: 'alt', name: '標高（GPS）', unit: 'm', h: 120 },
];
function renderCharts() {
  const r = st.res, el = $('sv-charts');
  if (!el.dataset.ready) {
    el.innerHTML = `
      <div class="sticky-map"><canvas class="trackmap" id="miniMap" style="height:150px"></canvas></div>
      <div class="readout" id="chRead"></div>
      <div class="row" style="margin:6px 0 8px"><div class="chips" id="chChips"></div><span class="spacer"></span>
        <button class="btn sm icon-btn" id="czIn">${ICON.plus}</button><button class="btn sm icon-btn" id="czOut">${ICON.minus}</button><button class="btn sm icon-btn" id="czAll">${ICON.fit}</button></div>
      <div id="chartList"></div>
      <p class="hint">横軸はコース上の距離（S/F から m）。グラフをなぞるとカーソル、2本指でズーム。灰色の帯はコーナー区間。</p>`;
    el.dataset.ready = '1';
    st.maps.mini = new TrackMap($('miniMap'), { interactive: false, compact: true, padding: 10 });
    st.maps.mini.onTap = (x, y) => { if (!st.res.model) return; const p = T.makeProjector(st.res.model).project(x, y); if (p.d < 40) st.group.setCursor(p.s, 'map'); };
    st.group = new ChartGroup();
    st.group.onCursor((x) => { st.cursor = x; updateCursorDots(); updateReadout(); });
    $('czIn').onclick = () => st.group.zoom(0.6);
    $('czOut').onclick = () => st.group.zoom(1 / 0.6);
    $('czAll').onclick = () => st.group.setRange(...st.group.full);
    $('chChips').onclick = (e) => {
      const c = e.target.closest('.chip'); if (!c) return;
      const set = new Set(app.prefs.channels);
      set.has(c.dataset.id) ? set.delete(c.dataset.id) : set.add(c.dataset.id);
      app.prefs.channels = CHANNELS.map(x => x.id).filter(id => set.has(id));
      app.savePrefs();
      buildCharts(); fillCharts();
    };
    buildCharts();
  }
  const rf = ref(), cp = cmp();
  const laps = [];
  if (cp && cp.lap.ch) laps.push({ ...lapXY(cp), color: cssVar('--cmp'), width: 1.8, alpha: 0.9 });
  if (rf && rf.lap.ch) laps.push({ ...lapXY(rf), color: cssVar('--ref'), width: 2.2 });
  const sm = el.querySelector('.sticky-map');
  const head = document.querySelector('.ana-head');
  const headSticky = getComputedStyle(head).position === 'sticky';
  sm.style.top = `${document.querySelector('.topbar').offsetHeight + (headSticky ? head.offsetHeight : 0) + 4}px`;
  st.maps.mini.setScene({ ...sceneBase(), laps, markers: [] }, { refit: true });
  fillCharts();
  updateCursorDots(); updateReadout();
}
function buildCharts() {
  const list = $('chartList');
  list.innerHTML = '';
  st.charts = {};
  st.group.charts = [];
  $('chChips').innerHTML = CHANNELS.map(c => `<span class="chip ${app.prefs.channels.includes(c.id) ? 'on' : ''}" data-id="${c.id}">${c.name.replace(/（.*/, '')}</span>`).join('');
  for (const c of CHANNELS) {
    if (!app.prefs.channels.includes(c.id)) continue;
    const cv = document.createElement('canvas'); cv.className = 'chart'; list.appendChild(cv);
    const fmt = c.id === 'speed' ? (v => v.toFixed(1)) : c.id === 'delta' ? (v => C.fmtDelta(v, 2)) : c.id === 'off' ? (v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`) : c.id === 'alt' || c.id === 'time' ? (v => v.toFixed(1)) : (v => v.toFixed(2));
    st.charts[c.id] = st.group.add(new LineChart(cv, { title: c.name, unit: c.unit, height: c.h, zeroLine: ['delta', 'long', 'lat', 'off'].includes(c.id), symmetric: ['lat', 'off'].includes(c.id), fmt, minSpan: c.id === 'alt' ? 4 : 0 }));
  }
}
function fillCharts() {
  const r = st.res, rf = ref(), cp = cmp();
  if (!rf || !rf.lap.ch) { Object.values(st.charts).forEach(c => c.setData({})); return; }
  const ch = rf.lap.ch, cc = cp && cp.lap.ch ? cp.lap.ch : null;
  const xs = Array.from({ length: ch.t.length }, (_, g) => g * ch.step);
  const xc = cc ? Array.from({ length: cc.t.length }, (_, g) => g * cc.step) : null;
  const refC = cssVar('--ref'), cmpC = cssVar('--cmp');
  const two = (fn, extra = {}) => [{ x: xs, y: fn(ch), color: refC, label: '基準', ...extra }, ...(cc ? [{ x: xc, y: fn(cc), color: cmpC, label: '比較', ...extra }] : [])];
  const bands = cornerBands();
  const bm = (rf.lap.cm || []).filter(m => m.brake).map(m => ({ x: m.brake.s, color: cssVar('--brake'), label: 'B' }));
  const set = {
    speed: () => ({ series: two(c => Array.from(c.v, kmh)), bands, marks: bm }),
    delta: () => ({ series: cc ? [{ x: xs, y: A.deltaSeries(rf.lap, cp.lap), color: cssVar('--fg2'), label: '', width: 1.8, fill: { pos: 'rgba(255,84,104,.28)', neg: 'rgba(47,212,124,.28)' } }] : [], bands }),
    long: () => ({ series: two(c => c.lg), bands, marks: bm }),
    lat: () => ({ series: two(c => c.la), bands }),
    off: () => ({ series: two(c => c.off), bands, envelope: { x: xs, lo: xs.map((_, g) => r.model.left[g % r.model.N]), hi: xs.map((_, g) => r.model.right[g % r.model.N]), color: cssVar('--grid') } }),
    comb: () => ({ series: two(c => c.comb), bands }),
    time: () => ({ series: two(c => c.t), bands }),
    alt: () => ({ series: two(c => c.alt), bands }),
  };
  for (const [id, chart] of Object.entries(st.charts)) chart.setData(set[id]());
  if (st.group.full[1] !== ch.L) st.group.setFull(0, ch.L); else st.group.draw();
}
function updateReadout() {
  const el = $('chRead'); if (!el) return;
  const rf = ref(), cp = cmp();
  if (!rf || !rf.lap.ch) { el.innerHTML = ''; return; }
  const s = st.cursor;
  if (s === null) { el.innerHTML = '<div style="grid-column:1/-1"><div class="k">グラフかコース図をタップすると、その地点の値を表示します</div></div>'; return; }
  const g = (ch) => Math.max(0, Math.min(ch.v.length - 1, Math.round(s / ch.step)));
  const a = rf.lap.ch, b = cp && cp.lap.ch;
  const corner = st.res.corners.find(c => s >= c.s0 - 15 && s <= c.s1 + 15);
  const items = [
    ['位置', `${s.toFixed(0)}<small> m</small>`, ''],
    ['コーナー', corner ? esc(corner.name) : '—', ''],
    ['速度 基準', kmh(a.v[g(a)]).toFixed(1), 'var(--ref)'],
  ];
  if (b) { items.push(['速度 比較', kmh(b.v[g(b)]).toFixed(1), 'var(--cmp)']); const d = A.timeAtS(b, s) - A.timeAtS(a, s); items.push(['タイム差', C.fmtDelta(d, 2), d > 0 ? 'var(--bad)' : 'var(--good)']); }
  items.push(['前後G', a.lg[g(a)].toFixed(2), ''], ['横G', a.la[g(a)].toFixed(2), ''], ['ライン', `${a.off[g(a)] >= 0 ? '+' : ''}${a.off[g(a)].toFixed(1)}<small> m</small>`, '']);
  el.innerHTML = items.map(([k, v, c]) => `<div><div class="k">${k}</div><div class="v" style="color:${c || 'inherit'}">${v}</div></div>`).join('');
}

// ---------- コーナー ----------
function renderCorners() {
  const r = st.res, el = $('sv-corners'), rf = ref(), cp = cmp();
  if (!r.corners.length || !rf || !rf.lap.cm) { el.innerHTML = '<div class="empty">コーナーが検出できていません。</div>'; return; }
  const fmtS = (v) => Number.isFinite(v) ? `${v.toFixed(0)} m` : '—';
  const diff = (a, b, unit, dig = 1, invert = false) => { if (!Number.isFinite(a) || !Number.isFinite(b)) return ''; const d = b - a; if (Math.abs(d) < Math.pow(10, -dig) / 2) return '<span class="muted">±0</span>'; const good = invert ? d < 0 : d > 0; return `<span class="${good ? 'good' : 'bad'}">${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(dig)}${unit}</span>`; };
  el.innerHTML = `<p class="hint" style="margin-top:0">ブレーキ開始・アクセルON は前後Gから自動検出。位置はコース上の距離（S/F からの m）。クリップ位置は「イン側の限界（全ラップで最もイン）」からの距離。</p>` +
    r.corners.map((c, k) => {
      const a = rf.lap.cm[k], b = cp && cp.lap.cm ? cp.lap.cm[k] : null;
      const seg = r.segBest[k];
      const inside = (m) => { const q = Math.round(m.sApex / r.model.step) % r.model.N; return c.dir === 'R' ? r.model.right[q] - m.offApex : m.offApex - r.model.left[q]; };
      const rows = [
        ['区間タイム', a.segTime.toFixed(2) + 's', b ? b.segTime.toFixed(2) + 's' : '', b ? diff(a.segTime, b.segTime, 's', 2, true) : '', seg ? `${seg.time.toFixed(2)}s (L${seg.lap.no})` : ''],
        ['ブレーキ開始', a.brake ? fmtS(a.brake.s) : 'なし', b ? (b.brake ? fmtS(b.brake.s) : 'なし') : '', b && a.brake && b.brake ? diff(a.brake.s, b.brake.s, 'm', 0) : '', ''],
        ['└ 頂点までの距離', a.brake ? fmtS(a.brake.toApex) : '', b && b.brake ? fmtS(b.brake.toApex) : '', '', ''],
        ['進入速度', kmh(a.vEntry).toFixed(1), b ? kmh(b.vEntry).toFixed(1) : '', b ? diff(kmh(a.vEntry), kmh(b.vEntry), '') : '', ''],
        ['最大減速', a.brake ? `${Math.abs(a.brake.maxG).toFixed(2)}G` : '', b && b.brake ? `${Math.abs(b.brake.maxG).toFixed(2)}G` : '', '', ''],
        ['最低速度', `<b>${kmh(a.vMin).toFixed(1)}</b>`, b ? `<b>${kmh(b.vMin).toFixed(1)}</b>` : '', b ? diff(kmh(a.vMin), kmh(b.vMin), '') : '', r.cornerStats[k].vMin ? `${kmh(r.cornerStats[k].vMin.max).toFixed(1)}（最高）` : ''],
        ['クリップ（インまで）', `${inside(a).toFixed(1)} m`, b ? `${inside(b).toFixed(1)} m` : '', b ? diff(inside(a), inside(b), 'm', 1, true) : '', ''],
        ['アクセルON（頂点から）', a.sThrottle !== null ? `${(a.sThrottle - a.sApex) >= 0 ? '+' : ''}${(a.sThrottle - a.sApex).toFixed(0)} m` : '—', b ? (b.sThrottle !== null ? `${(b.sThrottle - b.sApex) >= 0 ? '+' : ''}${(b.sThrottle - b.sApex).toFixed(0)} m` : '—') : '', '', ''],
        ['立ち上がり速度', kmh(a.vExit).toFixed(1), b ? kmh(b.vExit).toFixed(1) : '', b ? diff(kmh(a.vExit), kmh(b.vExit), '') : '', ''],
        ['最大横G', `${a.maxLat.toFixed(2)}G`, b ? `${b.maxLat.toFixed(2)}G` : '', '', ''],
      ];
      const notes = b ? A.cornerDiffNotes(c, a, b) : [];
      return `<div class="card corner-card" data-k="${k}"><canvas data-k="${k}"></canvas><div style="min-width:0">
        <div class="row" style="margin-bottom:6px"><span class="name">${esc(c.name)}</span><span class="tag">${c.dir === 'R' ? '右' : '左'} ${c.angle}° ・ R${c.radius}m ・ ${esc(c.type)}</span><span class="spacer"></span><button class="btn sm" data-goto="${k}">グラフで見る</button></div>
        <div class="table-wrap" style="box-shadow:none"><table class="tbl"><thead><tr><th>指標</th><th><span class="sw ref"></span> 基準</th>${b ? '<th><span class="sw cmp"></span> 比較</th><th>差</th>' : ''}<th>セッション最良</th></tr></thead>
        <tbody>${rows.map(rw => `<tr><td>${rw[0]}</td><td>${rw[1]}</td>${b ? `<td>${rw[2]}</td><td>${rw[3]}</td>` : ''}<td class="muted">${rw[4]}</td></tr>`).join('')}</tbody></table></div>
        ${notes.length ? `<p class="hint">比較ラップは: ${notes.map(esc).join(' ／ ')}</p>` : ''}</div></div>`;
    }).join('');
  // コーナーごとの拡大図
  const base = sceneBase();
  const laps = [];
  if (cp && cp.lap.ch) laps.push({ ...lapXY(cp), color: cssVar('--cmp'), width: 2.4 });
  laps.push({ ...lapXY(rf), color: cssVar('--ref'), width: 2.8 });
  const markers = [...markersFor(rf, cssVar('--ref')), ...(cp ? markersFor(cp, cssVar('--cmp')).filter(m => m.type === 'brake' || m.type === 'apex') : [])];
  el.querySelectorAll('canvas[data-k]').forEach(cv => {
    const k = +cv.dataset.k, c = r.corners[k];
    const tm = new TrackMap(cv, { interactive: false, compact: true, padding: 6 });
    tm.setScene({ ...base, laps, markers, highlightCorner: k });
    requestAnimationFrame(() => tm.focusS(c.s0 - (rf.lap.cm[k].brake ? Math.max(10, c.s0 - rf.lap.cm[k].brake.s + 10) : 25), c.s1 + 25, 5));
  });
  el.querySelectorAll('button[data-goto]').forEach(b => b.onclick = () => {
    const c = r.corners[+b.dataset.goto];
    showSub('charts');
    setTimeout(() => { st.group.focus(c.s0 - 120, c.s1 + 60, 0); st.group.setCursor(c.sApex); }, 60);
  });
}

// ---------- G-G ----------
function renderGG() {
  const r = st.res, el = $('sv-gg'), rf = ref(), cp = cmp();
  if (!rf || !rf.lap.ch) { el.innerHTML = '<div class="empty">ラップがありません。</div>'; return; }
  const usage = (o) => { const c = o.lap.ch; let s = 0, n = 0; for (let i = 0; i < c.comb.length; i++) if (Math.abs(c.la[i]) > 0.3 || c.lg[i] < -0.2) { s += c.comb[i] / r.gripMax; n++; } return n ? s / n : 0; };
  el.innerHTML = `<div class="split"><div class="card gg-wrap"><div class="card-title">G-G ダイアグラム（摩擦円） <span class="spacer"></span><span class="legend"><span><span class="sw ref"></span> 基準</span>${cp ? '<span><span class="sw cmp"></span> 比較</span>' : ''}<span style="color:var(--purple)">┅ セッションの限界 ${r.gripMax.toFixed(2)}G</span></span></div><canvas id="ggCanvas"></canvas>
      <p class="hint">外周に沿って点が多いほどタイヤのグリップを使い切っています。ブレーキから旋回へ斜めにつながる（トレイルブレーキ）形が理想です。</p></div>
    <div class="card"><div class="card-title">グリップの使い方</div>
      <div class="grid g2">
        <div class="kpi"><div class="k">グリップ使用率（基準）</div><div class="v num">${(usage(rf) * 100).toFixed(0)}<small>%</small></div><div class="s">ブレーキ・旋回中の平均（限界比）</div></div>
        ${cp ? `<div class="kpi"><div class="k">グリップ使用率（比較）</div><div class="v num">${(usage(cp) * 100).toFixed(0)}<small>%</small></div><div class="s">${lapName(cp)}</div></div>` : ''}
        <div class="kpi"><div class="k">最大合成G</div><div class="v num">${rf.lap.stats.maxComb.toFixed(2)}<small>G</small></div><div class="s">${lapName(rf)}</div></div>
        <div class="kpi"><div class="k">G の算出元</div><div class="v" style="font-size:15px;font-family:inherit;font-weight:700;margin-top:6px;white-space:normal;line-height:1.3">${r.gSrc.longSrc === 'sensor' ? '加速度センサー' : 'GPS'} / ${r.gSrc.latSrc === 'gyro' ? 'ジャイロ' : 'GPS'}</div><div class="s">前後 / 横</div></div>
      </div>
      <h3>ラップ別の走り方</h3>
      <div class="table-wrap" style="box-shadow:none"><table class="tbl"><thead><tr><th>周</th><th>タイム</th><th>加速</th><th>ブレーキ</th><th>どちらでもない</th><th>最大減速</th><th>最大横G</th></tr></thead><tbody>
      ${r.laps.filter(l => l.stats).map(l => `<tr class="${l.valid ? '' : 'invalid'}"><td>L${l.no}${l === r.best ? ' <span class="purple">★</span>' : ''}</td><td>${C.fmtLap(l.time)}</td><td>${(l.stats.style.accel * 100).toFixed(0)}%</td><td>${(l.stats.style.brake * 100).toFixed(0)}%</td><td>${(l.stats.style.neutral * 100).toFixed(0)}%</td><td>${Math.abs(l.stats.maxBrake).toFixed(2)}</td><td>${l.stats.maxLat.toFixed(2)}</td></tr>`).join('')}
      </tbody></table></div></div></div>`;
  const sets = [];
  if (cp && cp.lap.ch) sets.push({ lat: cp.lap.ch.la, lon: cp.lap.ch.lg, color: cssVar('--cmp'), stride: 2 });
  sets.push({ lat: rf.lap.ch.la, lon: rf.lap.ch.lg, color: cssVar('--ref'), stride: 2 });
  requestAnimationFrame(() => drawGG($('ggCanvas'), sets, { gripMax: r.gripMax }));
}

// ---------- 書き出し ----------
async function exportMenu() {
  const r = st.res; if (!r) return;
  const base = safeName(r.session.name);
  const items = [
    ['解析データ CSV（ラップ×距離ごとの速度・G・ライン）', () => saveFile(`${base}_analysis.csv`, IO.toAnalysisCSV(r), 'text/csv', { share: true })],
    ['ラップ表 CSV（区間タイム・最低速度・ブレーキ位置）', () => saveFile(`${base}_laps.csv`, IO.toLapReportCSV(r), 'text/csv', { share: true })],
    ['KML（Google Earth でライン表示）', () => saveFile(`${base}.kml`, IO.toKML(r), 'application/vnd.google-earth.kml+xml', { share: true })],
    ['GPX（GPS 軌跡）', () => saveFile(`${base}.gpx`, IO.toGPX(r.session), 'application/gpx+xml', { share: true })],
    ['生データ CSV（GPS）', () => saveFile(`${base}.csv`, IO.toCSV(r.session), 'text/csv', { share: true })],
    ['JSON（センサー含む全データ・再読込用）', () => saveFile(`${base}.json`, JSON.stringify(r.session), 'application/json', { share: true })],
  ];
  const v = await sheet({ title: '書き出し・共有', html: `<div class="menu-list">${items.map((it, i) => `<button class="btn" data-x="${i}">${ICON.share} ${esc(it[0])}</button>`).join('')}</div><p class="hint">CSV をこのチャットに貼ってもらえれば、さらに詳しく分析できます。</p>`, actions: [{ label: '閉じる', value: null }], onOpen: (dlg, finish) => dlg.querySelectorAll('[data-x]').forEach(b => b.onclick = () => finish(+b.dataset.x)) });
  if (v !== null && v !== undefined) items[v][1]();
}
