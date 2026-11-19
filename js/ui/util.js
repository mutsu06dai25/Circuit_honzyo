// UI 共通ヘルパー
export const $ = (id) => document.getElementById(id);
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const svg = (p, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${p}</svg>`;
export const ICON = {
  timer: svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6M12 2v3"/>'),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>'),
  chart: svg('<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  play: svg('<path d="M7 4l13 8-13 8z" fill="currentColor"/>'),
  pause: svg('<path d="M7 4h4v16H7zM14 4h4v16h-4z" fill="currentColor"/>'),
  rec: svg('<circle cx="12" cy="12" r="7" fill="currentColor"/>'),
  share: svg('<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v14"/>'),
  edit: svg('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  upload: svg('<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M7 9l5-5 5 5M12 4v12"/>'),
  flag: svg('<path d="M4 22V4M4 4h13l-2 4 2 4H4"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  sat: svg('<path d="M13 7l4 4M6 14l4 4M9.5 9.5l5 5"/><path d="M14 4l6 6-3 3-6-6zM4 14l6 6-3 3-6-6z" transform="translate(0 -3)"/>'),
  map: svg('<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>'),
  sparkle: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>'),
  gps: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="7"/>'),
  battery: svg('<rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 11v2"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  more: svg('<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>'),
  weather: svg('<path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 7 18z"/>'),
};
export const LOGO = `<svg class="logo" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#e3120b"/><path d="M8 21c-2-5 1-10 6-10 3 0 4 2 7 2 3 0 4 3 3 5-1 3-5 4-8 3-3-1-6 2-8 0z" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/><circle cx="21" cy="13" r="2.4" fill="#fff"/></svg>`;

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// 下から出るシート。actions: [{label, value, primary, danger}]。戻り値: 押されたボタンの value（閉じたら null）
export function sheet({ title = '', html = '', actions = [{ label: '閉じる', value: null }], onOpen } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet';
    dlg.innerHTML = `<div class="sheet-body">${title ? `<h2>${esc(title)}</h2>` : ''}<div class="sheet-content">${html}</div>
      ${actions.length ? `<div class="sheet-actions">${actions.map((a, i) => `<button class="btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}</div>`;
    document.body.appendChild(dlg);
    let done = false;
    const finish = (v) => { if (done) return; done = true; try { dlg.close(); } catch (e) { /* 無視 */ } dlg.remove(); resolve(v); };
    dlg.addEventListener('click', (e) => {
      const b = e.target.closest('.sheet-actions button[data-i]');
      if (b) { const a = actions[+b.dataset.i]; finish(typeof a.value === 'function' ? a.value(dlg) : a.value); return; }
      if (e.target === dlg) finish(null);
    });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    dlg.showModal();
    if (onOpen) onOpen(dlg, finish);
  });
}
export async function confirmSheet(msg, okLabel = 'OK', danger = false) {
  const v = await sheet({ html: `<p>${esc(msg)}</p>`, actions: [{ label: 'キャンセル', value: false }, { label: okLabel, value: true, primary: !danger, danger }] });
  return v === true;
}

// ファイルを保存（スマホでは共有メニューも使える）
export async function saveFile(name, text, type, { share = false } = {}) {
  const blob = new Blob([text], { type });
  if (share && navigator.canShare) {
    try {
      const file = new File([blob], name, { type });
      if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
export const canShareFiles = () => !!(navigator.canShare && (() => { try { return navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }); } catch (e) { return false; } })());

export function safeName(s) { return String(s || 'session').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80); }

// 速度などのカラースケール（青→シアン→緑→黄→赤）
const STOPS = [[0, [48, 86, 214]], [0.25, [36, 180, 220]], [0.5, [60, 200, 90]], [0.75, [245, 205, 40]], [1, [230, 50, 40]]];
export function heat(t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) if (t <= STOPS[i][0]) {
    const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i]; const f = (t - a) / (b - a);
    return `rgb(${ca.map((c, j) => Math.round(c + (cb[j] - c) * f)).join(',')})`;
  }
  return 'rgb(230,50,40)';
}
export function gColor(g) { // 前後G: 減速=赤, 加速=緑
  const m = Math.min(1, Math.abs(g) / 0.8);
  if (g < -0.08) return `rgb(${Math.round(150 + 105 * m)},${Math.round(110 - 70 * m)},${Math.round(110 - 70 * m)})`;
  if (g > 0.05) return `rgb(${Math.round(110 - 80 * m)},${Math.round(150 + 70 * m)},${Math.round(110 - 40 * m)})`;
  return 'rgb(170,170,170)';
}
export function deltaColor(d) { // タイム差の傾き: 縮めている=緑, 失っている=赤
  const m = Math.min(1, Math.abs(d) / 0.004);
  return d < 0 ? `rgba(47,212,124,${0.25 + 0.75 * m})` : `rgba(255,84,104,${0.25 + 0.75 * m})`;
}

// ラップ時間の読み上げ用テキスト
export function speechLap(sec) {
  const m = Math.floor(sec / 60), s = sec - m * 60;
  const ss = s.toFixed(2).split('.');
  return `${m ? `${m}分` : ''}${+ss[0]}秒${ss[1]}`;
}
export function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP'; u.rate = 1.15;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch (e) { /* 無視 */ }
}
