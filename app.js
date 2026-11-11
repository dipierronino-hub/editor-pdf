// Editor PDF — visualizza, annota, firma, riorganizza e corregge PDF nel browser.
// I documenti restano sul dispositivo: nessun caricamento online.
import * as pdfjsLib from './lib/pdf.min.mjs';

const VERSIONE = '2026-11-11a';
const LIB = new URL('./lib/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = LIB + 'pdf.worker.min.mjs';
const { PDFDocument, StandardFonts, rgb, degrees, BlendMode, LineCapStyle } = window.PDFLib;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const viewer = $('#viewer'), pagesEl = $('#pages');

const S = {
  sources: [], pages: [], assets: {}, scale: 1, tool: 'mano', sel: null, pending: null,
  undo: [], redo: [], dirty: false, name: '', hits: {},
  hlColor: '#ffe14d', inkColor: '#1a3fb0', inkW: 1.6,
  tx: { size: 11, font: 'H', bold: false, c: '#000000' },
};
let seq = 1;
const nid = () => 'k' + (seq++) + Math.random().toString(36).slice(2, 7);

/* ---------- messaggi ---------- */
let toastT;
function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms); }
function busy(on, msg) { $('#busy').textContent = msg || 'Un momento…'; $('#busy').classList.toggle('on', !!on); }
let sheetT = 0;
function openSheet(id) { sheetT = performance.now(); $('#' + id).classList.add('on'); }
let txAfter = null;
function closeSheets() { $$('.sheet.on').forEach(s => s.classList.remove('on')); const f = txAfter; txAfter = null; f && f(); }
// il tocco che apre un pannello genera anche un «click» sullo sfondo: va ignorato, altrimenti il pannello si richiude subito
$$('.sheet').forEach(s => s.addEventListener('click', e => { if (e.target === s && performance.now() - sheetT < 500) return; if (e.target === s || e.target.closest('[data-close]')) closeSheets(); }));

/* ---------- apertura ---------- */
async function loadSource(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let password;
  const open = () => pdfjsLib.getDocument({ data: bytes.slice(), password, cMapUrl: LIB + 'cmaps/', cMapPacked: true, standardFontDataUrl: LIB + 'standard_fonts/' }).promise;
  let pdf;
  try { pdf = await open(); }
  catch (e) {
    if (e && e.name === 'PasswordException') {
      password = window.prompt('Questo PDF è protetto. Inserisci la password per aprirlo:');
      if (password == null) throw new Error('Apertura annullata');
      pdf = await open();
    } else throw e;
  }
  const si = S.sources.push({ name: file.name.replace(/\.pdf$/i, ''), bytes, pdf, form: {}, tc: {} }) - 1;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pr = await pdf.getPage(i), vp = pr.getViewport({ scale: 1 });
    out.push({ id: nid(), src: si, idx: i - 1, rot: 0, ann: [], w: vp.width, h: vp.height });
  }
  return out;
}

async function openFiles(files, append) {
  files = [...files].filter(f => /pdf/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (!files.length) return toast('Scegli un file PDF');
  if (!append && S.dirty && !window.confirm('Ci sono modifiche non salvate. Aprire un altro PDF?')) return;
  busy(true, 'Apro il PDF…');
  try {
    const nuove = [];
    for (const f of files) {
      try { nuove.push(...await loadSource(f)); }
      catch (e) { console.error(e); toast('Non riesco ad aprire «' + f.name + '»'); }
    }
    if (!nuove.length) return;
    if (append) { snap(); S.pages.push(...nuove); }
    else {
      S.pages = nuove; S.undo = []; S.redo = []; S.dirty = files.length > 1; S.sel = null; S.hits = {};
      S.name = files[0].name.replace(/\.pdf$/i, '');
      setTool('mano');
    }
    build(append);
    if (!append) { fit(); viewer.scrollTop = 0; }
    else toast(nuove.length + (nuove.length === 1 ? ' pagina aggiunta' : ' pagine aggiunte') + ' in fondo');
  } finally { busy(false); }
}

/* ---------- annulla / ripeti ---------- */
const shot = () => JSON.stringify({ p: S.pages, f: S.sources.map(s => s.form) });
function snap() { S.undo.push(shot()); if (S.undo.length > 60) S.undo.shift(); S.redo = []; S.dirty = true; ui(); }
function restore(j) {
  const o = JSON.parse(j);
  S.pages = o.p; S.sources.forEach((s, i) => { s.form = o.f[i] || {}; });
  S.sel = null; S.dirty = true; build(true);
  if ($('#shPages').classList.contains('on')) thumbs();
}
function undo() { if (!S.undo.length) return; S.redo.push(shot()); restore(S.undo.pop()); }
function redo() { if (!S.redo.length) return; S.undo.push(shot()); restore(S.redo.pop()); }

/* ---------- vista ---------- */
const els = new Map();
const viewDims = p => (p.rot % 180 ? [p.h, p.w] : [p.w, p.h]);
function gMatrix(p) {
  switch (p.rot) {
    case 90: return `matrix(0 1 -1 0 ${p.h} 0)`;
    case 180: return `matrix(-1 0 0 -1 ${p.w} ${p.h})`;
    case 270: return `matrix(0 -1 1 0 0 ${p.w})`;
    default: return '';
  }
}
function b2v(p, x, y) {
  switch (p.rot) { case 90: return [p.h - y, x]; case 180: return [p.w - x, p.h - y]; case 270: return [y, p.w - x]; default: return [x, y]; }
}
function sizeEl(r) {
  const [vw, vh] = viewDims(r.p);
  r.el.style.width = vw * S.scale + 'px'; r.el.style.height = vh * S.scale + 'px';
  r.el.style.setProperty('--s', S.scale);
}

const io = new IntersectionObserver(es => {
  for (const e of es) {
    const r = els.get(e.target.dataset.id); if (!r) continue;
    r.vis = e.isIntersecting;
    if (r.vis) queue(r); else free(r);
  }
}, { root: viewer, rootMargin: '900px 0px' });

function build(keep) {
  const st = viewer.scrollTop, sl = viewer.scrollLeft;
  io.disconnect();
  for (const r of els.values()) { try { r.task && r.task.cancel(); } catch { } }
  els.clear(); pagesEl.textContent = '';
  S.pages.forEach((p, i) => {
    const el = document.createElement('div'); el.className = 'page'; el.dataset.id = p.id;
    const [vw, vh] = viewDims(p);
    const svg = sv('svg', { viewBox: `0 0 ${vw} ${vh}` });
    const g = sv('g'); const m = gMatrix(p); if (m) g.setAttribute('transform', m);
    svg.append(g);
    const forms = document.createElement('div'); forms.className = 'forms';
    const num = document.createElement('div'); num.className = 'num'; num.textContent = i + 1;
    el.append(svg, forms, num);
    const r = { p, el, svg, g, forms, canvas: null, key: null, vis: false };
    els.set(p.id, r); sizeEl(r); bindSvg(r); drawAnn(r);
    pagesEl.append(el); io.observe(el);
  });
  applyToolClass();
  if (keep) { viewer.scrollTop = st; viewer.scrollLeft = sl; }
  ui(); pageInfo();
}

let chain = Promise.resolve();
function queue(r) { chain = chain.then(() => render(r)).catch(e => console.warn(e)); }
async function render(r) {
  const p = r.p;
  if (!r.vis || els.get(p.id) !== r) return;
  const key = S.scale + '|' + p.rot; if (r.key === key) return;
  const proxy = await S.sources[p.src].pdf.getPage(p.idx + 1);
  const [vw, vh] = viewDims(p);
  let ps = S.scale * Math.min(window.devicePixelRatio || 1, 2);
  const maxPx = 5e6; if (vw * vh * ps * ps > maxPx) ps = Math.sqrt(maxPx / (vw * vh));
  const vp = proxy.getViewport({ scale: ps, rotation: (proxy.rotate + p.rot) % 360 });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  r.task = proxy.render({ canvasContext: c.getContext('2d', { willReadFrequently: true }), viewport: vp });
  try { await r.task.promise; } catch { return; }
  if (els.get(p.id) !== r) return;
  if (r.canvas) r.canvas.remove();
  r.el.prepend(c); r.canvas = c; r.key = key;
  if (!r.formsDone) { r.formsDone = true; buildForms(r, proxy).catch(e => console.warn(e)); }
}
function free(r) { if (r.canvas) { r.canvas.width = 0; r.canvas.remove(); r.canvas = null; r.key = null; } }

function setScale(s) {
  s = clamp(s, 0.2, 6); if (!S.pages.length) { S.scale = s; return; }
  const k = s / S.scale, cx = viewer.clientWidth / 2, cy = viewer.clientHeight / 2;
  const nx = (viewer.scrollLeft + cx) * k - cx, ny = (viewer.scrollTop + cy) * k - cy;
  S.scale = s;
  for (const r of els.values()) { sizeEl(r); if (r.vis) queue(r); }
  viewer.scrollLeft = nx; viewer.scrollTop = ny;
  if (S.sel) { const r = els.get(S.sel.pid); r && drawAnn(r); }
}
function fit() {
  if (!S.pages.length) return;
  const maxW = Math.max(...S.pages.map(p => viewDims(p)[0]));
  setScale(Math.min((viewer.clientWidth - 16) / maxW, 1.6));
}
function pageInfo() {
  const el = $('#pginfo'); if (!S.pages.length) { el.classList.remove('on'); return; }
  const top = viewer.getBoundingClientRect().top + viewer.clientHeight / 3;
  let n = 1; const kids = pagesEl.children;
  for (let i = 0; i < kids.length; i++) { if (kids[i].getBoundingClientRect().bottom > top) { n = i + 1; break; } n = i + 1; }
  el.textContent = 'Pagina ' + n + ' di ' + S.pages.length; el.classList.add('on');
}
let piRaf; viewer.addEventListener('scroll', () => { cancelAnimationFrame(piRaf); piRaf = requestAnimationFrame(pageInfo); }, { passive: true });
function goPage(id) { const r = els.get(id); if (r) viewer.scrollTop = r.el.offsetTop - 8; }

/* ---------- annotazioni: disegno a schermo ---------- */
const fontCss = f => f === 'T' ? '"Times New Roman",Times,serif' : f === 'C' ? '"Courier New",Courier,monospace' : 'Arial,Helvetica,sans-serif';
const mctx = document.createElement('canvas').getContext('2d');
function textW(a, line) { mctx.font = `${a.bold ? 'bold ' : ''}${a.size}px ${fontCss(a.font)}`; return mctx.measureText(line).width; }
const lines = a => String(a.text || '').split('\n');
function bbox(a) {
  if (a.t === 'ink') {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of a.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { x: x0 - 2, y: y0 - 2, w: x1 - x0 + 4, h: y1 - y0 + 4 };
  }
  if (a.t === 'text') {
    const ls = lines(a), w = Math.max(8, ...ls.map(l => textW(a, l))), h = ls.length * a.size * 1.2, pad = a.bg ? 3 : 0;
    return { x: a.x - pad, y: a.y - pad, w: w + pad * 2, h: h + pad * 2 };
  }
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}
function textEl(a, x, baseline) {
  const t = sv('text', { 'font-size': a.size, fill: a.c || '#000', 'font-family': fontCss(a.font), 'font-weight': a.bold ? 'bold' : 'normal' });
  t.style.whiteSpace = 'pre';
  lines(a).forEach((l, i) => { const s = sv('tspan', { x, y: baseline + i * a.size * 1.2 }); s.textContent = l; t.append(s); });
  return t;
}
function annEl(a) {
  const e = sv('g', { class: 'ann', 'data-id': a.id });
  if (a.t === 'hl') { const r = sv('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: a.c, opacity: .42 }); r.style.mixBlendMode = 'multiply'; e.append(r); }
  else if (a.t === 'ink') e.append(sv('polyline', { points: a.pts.map(p => p.join(',')).join(' '), fill: 'none', stroke: a.c, 'stroke-width': a.lw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  else if (a.t === 'img') e.append(sv('image', { href: S.assets[a.asset] || '', x: a.x, y: a.y, width: a.w, height: a.h, preserveAspectRatio: 'none' }));
  else if (a.t === 'cover') { e.append(sv('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: a.bg })); if (a.text) e.append(textEl(a, a.tx, a.by)); }
  else if (a.t === 'text') {
    if (a.bg) { const b = bbox(a); e.append(sv('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: a.bg, stroke: '#d9b400', 'stroke-width': .5 })); }
    else { const b = bbox(a); e.append(sv('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: 'transparent' })); }
    e.append(textEl(a, a.x, a.y + a.size * 0.92));
  }
  return e;
}
function drawAnn(r) {
  const g = r.g; g.textContent = '';
  for (const h of (S.hits[r.p.id] || [])) g.append(sv('rect', { class: 'hit', x: h.x, y: h.y, width: h.w, height: h.h }));
  for (const a of r.p.ann) g.append(annEl(a));
  if (S.sel && S.sel.pid === r.p.id) {
    const a = r.p.ann.find(x => x.id === S.sel.id);
    if (a) {
      const el = g.querySelector(`[data-id="${a.id}"]`); el && el.classList.add('sel');
      const b = bbox(a);
      g.append(sv('rect', { class: 'selbox', x: b.x - 1, y: b.y - 1, width: b.w + 2, height: b.h + 2 }));
      if (a.t === 'hl' || a.t === 'img' || a.t === 'cover') g.append(sv('circle', { class: 'handle', cx: b.x + b.w, cy: b.y + b.h, r: 8 / S.scale }));
    }
  }
}
function select(pid, id) {
  const old = S.sel; S.sel = id ? { pid, id } : null;
  if (old) { const r = els.get(old.pid); r && drawAnn(r); }
  if (S.sel) { const r = els.get(pid); r && drawAnn(r); }
  ui();
}
const selAnn = () => { if (!S.sel) return null; const p = S.pages.find(p => p.id === S.sel.pid); return p ? p.ann.find(a => a.id === S.sel.id) : null; };

/* ---------- annotazioni: gesti ---------- */
function pt(r, e) { const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(r.g.getScreenCTM().inverse()); return [q.x, q.y]; }
let drag = null;
function cancelDrag() { if (drag && drag.tmp) drag.tmp.remove(); drag = null; }

function bindSvg(r) {
  const svg = r.svg;
  svg.addEventListener('pointerdown', e => {
    if (e.button > 0 || drag) return;
    const [x, y] = pt(r, e), tool = S.tool;
    if (e.target.classList.contains('handle')) {
      const a = selAnn(); if (!a) return;
      drag = { k: 'resize', r, a, ratio: a.h / a.w, moved: false };
    } else if (tool === 'mano') {
      const ae = e.target.closest('.ann'); if (!ae) return;
      const id = ae.dataset.id, was = S.sel && S.sel.id === id;
      if (!was) { select(r.p.id, id); if (e.pointerType !== 'mouse') return; }
      const a = r.p.ann.find(q => q.id === id);
      drag = { k: 'move', r, a, x, y, moved: false };
    } else if (tool === 'hl' || tool === 'cover') {
      const tmp = sv('rect', { x, y, width: 0, height: 0, fill: tool === 'hl' ? S.hlColor : '#1a73e8', opacity: .35 });
      r.g.append(tmp); drag = { k: 'rect', r, x, y, tmp, tool };
    } else if (tool === 'ink') {
      const tmp = sv('polyline', { fill: 'none', stroke: S.inkColor, 'stroke-width': S.inkW, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', points: `${x},${y}` });
      r.g.append(tmp); drag = { k: 'ink', r, pts: [[x, y]], tmp };
    } else { drag = { k: 'tap', r, x, y }; }
    e.preventDefault();
    try { svg.setPointerCapture(e.pointerId); } catch { }
  });
  svg.addEventListener('pointermove', e => {
    if (!drag || drag.r !== r) return;
    const [x, y] = pt(r, e), d = drag;
    if (d.k === 'move') {
      const dx = x - d.x, dy = y - d.y;
      if (!d.moved) { if (Math.hypot(dx, dy) * S.scale < 4) return; d.moved = true; snap(); }
      const a = d.a; d.x = x; d.y = y;
      if (a.t === 'ink') a.pts = a.pts.map(([px, py]) => [px + dx, py + dy]);
      else { a.x += dx; a.y += dy; if (a.t === 'cover') { a.tx += dx; a.by += dy; } }
      drawAnn(r);
    } else if (d.k === 'resize') {
      if (!d.moved) { d.moved = true; snap(); }
      const a = d.a; a.w = Math.max(6, x - a.x); a.h = a.t === 'img' ? a.w * d.ratio : Math.max(4, y - a.y);
      drawAnn(r);
    } else if (d.k === 'rect') {
      d.tmp.setAttribute('x', Math.min(x, d.x)); d.tmp.setAttribute('y', Math.min(y, d.y));
      d.tmp.setAttribute('width', Math.abs(x - d.x)); d.tmp.setAttribute('height', Math.abs(y - d.y));
    } else if (d.k === 'ink') {
      const l = d.pts[d.pts.length - 1];
      if (Math.hypot(x - l[0], y - l[1]) * S.scale > 1.2) { d.pts.push([+x.toFixed(2), +y.toFixed(2)]); d.tmp.setAttribute('points', d.pts.map(p => p.join(',')).join(' ')); }
    }
  });
  const up = e => {
    if (!drag || drag.r !== r) return;
    const d = drag, [x, y] = pt(r, e); drag = null;
    if (d.tmp) d.tmp.remove();
    if (e.type === 'pointercancel') { drawAnn(r); return; }
    if (d.k === 'rect') {
      const box = { x: Math.min(x, d.x), y: Math.min(y, d.y), w: Math.abs(x - d.x), h: Math.abs(y - d.y) };
      const small = box.w * S.scale < 6 || box.h * S.scale < 6;
      if (d.tool === 'hl') { if (!small) { snap(); r.p.ann.push({ id: nid(), t: 'hl', ...box, c: S.hlColor }); drawAnn(r); } else toast('Trascina sopra il testo da evidenziare'); }
      else correggi(r, small ? null : box, d.x, d.y);
    } else if (d.k === 'ink') {
      if (d.pts.length > 1) { snap(); r.p.ann.push({ id: nid(), t: 'ink', pts: d.pts, c: S.inkColor, lw: S.inkW }); drawAnn(r); }
    } else if (d.k === 'tap') {
      if (S.tool === 'place' && S.pending) placeImg(r, d.x, d.y);
      else if (S.tool === 'text' || S.tool === 'note') nuovoTesto(r, d.x, d.y, S.tool === 'note');
    }
  };
  svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  svg.addEventListener('dblclick', e => { const ae = e.target.closest('.ann'); if (ae && S.tool === 'mano') { select(r.p.id, ae.dataset.id); modifica(); } });
}
viewer.addEventListener('pointerdown', e => {
  if (S.tool !== 'mano' || e.target.closest('.ann,.handle,.forms>*')) return;
  if (S.sel) select(null, null);
  if (Object.keys(S.hits).length) { const ids = Object.keys(S.hits); S.hits = {}; ids.forEach(id => { const r = els.get(id); r && drawAnn(r); }); }
});

/* ---------- testo ---------- */
let txCb = null, txColor = '#000000';
function askText(o, cb, after) {
  $('#txTitle').textContent = o.title; $('#txNote').textContent = o.note || ''; $('#txNote').style.display = o.note ? '' : 'none';
  $('#txVal').value = o.text || ''; $('#txSize').value = +(+o.size).toFixed(1); $('#txFont').value = o.font || 'H'; $('#txBold').checked = !!o.bold;
  txColor = o.c || '#000000'; $$('#shText .sw').forEach(b => b.setAttribute('aria-pressed', b.dataset.c === txColor));
  txCb = cb; txAfter = after || null; openSheet('shText'); setTimeout(() => { $('#txVal').focus(); $('#txVal').select(); }, 60);
}
$$('#shText .sw').forEach(b => b.onclick = () => { txColor = b.dataset.c; $$('#shText .sw').forEach(x => x.setAttribute('aria-pressed', x === b)); });
$('#txOk').onclick = () => {
  const v = { text: $('#txVal').value.replace(/\s+$/, ''), size: clamp(parseFloat($('#txSize').value) || 11, 4, 120), font: $('#txFont').value, bold: $('#txBold').checked, c: txColor };
  closeSheets(); const cb = txCb; txCb = null; cb && cb(v);
};
function nuovoTesto(r, x, y, nota) {
  askText({ title: nota ? 'Nuova nota' : 'Nuovo testo', text: '', ...S.tx }, v => {
    if (!v.text) return;
    S.tx = { size: v.size, font: v.font, bold: v.bold, c: v.c };
    snap(); const a = { id: nid(), t: 'text', x, y: y - v.size * 0.6, ...v }; if (nota) a.bg = '#fff3a6';
    r.p.ann.push(a); drawAnn(r);
  });
}
function modifica() {
  const a = selAnn(); if (!a || (a.t !== 'text' && a.t !== 'cover')) return;
  const r = els.get(S.sel.pid);
  askText({ title: a.t === 'cover' ? 'Correggi testo' : 'Modifica testo', text: a.text, size: a.size, font: a.font, bold: a.bold, c: a.c }, v => {
    if (!v.text && a.t === 'text') return;
    snap(); Object.assign(a, v); r && drawAnn(r);
  });
}

/* ---------- correggi (copri e riscrivi) ---------- */
async function textItems(p) {
  const src = S.sources[p.src]; if (src.tc[p.idx]) return src.tc[p.idx];
  const proxy = await src.pdf.getPage(p.idx + 1), tc = await proxy.getTextContent(), vp = proxy.getViewport({ scale: 1 });
  const items = [];
  for (const i of tc.items) {
    if (!i.str || !i.str.trim()) continue;
    const m = pdfjsLib.Util.transform(vp.transform, i.transform), fh = Math.hypot(m[2], m[3]);
    const flat = m[0] > 0 && Math.abs(m[1]) < 0.02 * Math.abs(m[0]);
    const fam = ((tc.styles[i.fontName] || {}).fontFamily || '').toLowerCase();
    items.push({ str: i.str, x: m[4], by: m[5], w: i.width, fh, flat, font: fam.includes('mono') ? 'C' : (fam.includes('serif') && !fam.includes('sans')) ? 'T' : 'H' });
  }
  return (src.tc[p.idx] = items);
}
const hex = (r, g, b) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
function sampleColors(r, box) {
  const def = { bg: '#ffffff', fg: '#000000' }, c = r.canvas, p = r.p; if (!c) return def;
  try {
    const [vw] = viewDims(p), k = c.width / vw;
    const a = b2v(p, box.x, box.y), b = b2v(p, box.x + box.w, box.y + box.h);
    const x0 = clamp(Math.floor(Math.min(a[0], b[0]) * k), 0, c.width - 1), y0 = clamp(Math.floor(Math.min(a[1], b[1]) * k), 0, c.height - 1);
    const w = clamp(Math.ceil(Math.abs(a[0] - b[0]) * k), 1, c.width - x0), h = clamp(Math.ceil(Math.abs(a[1] - b[1]) * k), 1, c.height - y0);
    const d = c.getContext('2d').getImageData(x0, y0, w, h).data, n = w * h, step = Math.max(1, Math.floor(n / 20000));
    const bins = new Map();
    for (let i = 0; i < n; i += step) { const o = i * 4, key = (d[o] >> 3) << 10 | (d[o + 1] >> 3) << 5 | (d[o + 2] >> 3); const e = bins.get(key); if (e) e[0]++; else bins.set(key, [1, d[o], d[o + 1], d[o + 2]]); }
    let best = null; for (const e of bins.values()) if (!best || e[0] > best[0]) best = e;
    let far = 0, fg = null;
    for (let i = 0; i < n; i += step) { const o = i * 4, dist = Math.abs(d[o] - best[1]) + Math.abs(d[o + 1] - best[2]) + Math.abs(d[o + 2] - best[3]); if (dist > far) { far = dist; fg = [d[o], d[o + 1], d[o + 2]]; } }
    return { bg: hex(best[1], best[2], best[3]), fg: far > 150 && fg ? hex(...fg) : '#000000' };
  } catch { return def; }
}
async function correggi(r, box, x, y) {
  const p = r.p; let it = null;
  if (!box) {
    const items = await textItems(p).catch(() => []);
    it = items.find(i => i.flat && x >= i.x - 2 && x <= i.x + i.w + 2 && y >= i.by - i.fh * 1.05 && y <= i.by + i.fh * 0.35);
    if (!it) return toast('Qui non trovo testo: trascina un riquadro sopra la parte da coprire');
    box = { x: it.x - 1, y: it.by - it.fh * 0.98, w: it.w + 2, h: it.fh * 1.3 };
  }
  const col = sampleColors(r, box);
  const size = it ? it.fh : clamp(box.h * 0.72, 5, 40);
  const tmp = sv('rect', { class: 'selbox', x: box.x, y: box.y, width: box.w, height: box.h }); r.g.append(tmp);
  askText({
    title: 'Correggi', note: it ? 'Scrivi il testo corretto: sostituisce quello selezionato.' : 'Scrivi il testo da mettere nel riquadro. Lascia vuoto per coprire soltanto.',
    text: it ? it.str : '', size, font: it ? it.font : S.tx.font, bold: false, c: col.fg,
  }, v => {
    snap();
    r.p.ann.push({ id: nid(), t: 'cover', ...box, bg: col.bg, tx: it ? it.x : box.x + 1.5, by: it ? it.by : box.y + box.h / 2 + v.size * 0.35, ...v });
    drawAnn(r);
  }, () => tmp.remove());
}

/* ---------- firme e timbri ---------- */
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('editorpdf.' + k) || '[]'); } catch { return []; } },
  set(k, v) { try { localStorage.setItem('editorpdf.' + k, JSON.stringify(v)); return true; } catch { toast('Memoria piena: elimina qualche firma o timbro salvato'); return false; } },
};
function renderLib(kind, elId) {
  const box = $('#' + elId), list = store.get(kind); box.textContent = '';
  if (!list.length) { const n = document.createElement('p'); n.className = 'note'; n.textContent = kind === 'firme' ? 'Nessuna firma salvata su questo dispositivo.' : 'Nessun timbro salvato su questo dispositivo.'; box.append(n); return; }
  for (const it of list) {
    const d = document.createElement('div'); d.className = 'it';
    const b = document.createElement('button'); const im = document.createElement('img'); im.src = it.d; im.alt = kind === 'firme' ? 'Firma salvata' : 'Timbro salvato'; b.append(im);
    b.onclick = () => usaImg(it, kind);
    const x = document.createElement('button'); x.className = 'rm'; x.textContent = '✕'; x.setAttribute('aria-label', 'Elimina');
    x.onclick = () => { store.set(kind, store.get(kind).filter(q => q.id !== it.id)); renderLib(kind, elId); };
    d.append(b, x); box.append(d);
  }
}
function usaImg(it, kind) {
  S.assets[it.id] = it.d; S.pending = { asset: it.id, ratio: it.h / it.w, kind };
  closeSheets(); setTool('place');
}
function placeImg(r, x, y) {
  const pd = S.pending, w = Math.min(pd.kind === 'firme' ? 150 : 130, r.p.w * 0.45), h = w * pd.ratio;
  snap(); const a = { id: nid(), t: 'img', asset: pd.asset, x: x - w / 2, y: y - h / 2, w, h };
  r.p.ann.push(a); S.pending = null; setTool('mano'); select(r.p.id, a.id);
}
// tavoletta firma
const pad = $('#sigpad'), pctx = pad.getContext('2d'); let padDirty = false, padDown = false;
function padReset() { const b = pad.getBoundingClientRect(), k = Math.min(window.devicePixelRatio || 1, 2); pad.width = Math.max(300, b.width * k); pad.height = 200 * k; pctx.lineWidth = 2.6 * k; pctx.lineCap = 'round'; pctx.lineJoin = 'round'; pctx.strokeStyle = '#10226b'; padDirty = false; }
const padPt = e => { const b = pad.getBoundingClientRect(); return [(e.clientX - b.left) * pad.width / b.width, (e.clientY - b.top) * pad.height / b.height]; };
pad.addEventListener('pointerdown', e => { padDown = true; pad.setPointerCapture(e.pointerId); const [x, y] = padPt(e); pctx.beginPath(); pctx.moveTo(x, y); pctx.lineTo(x + .1, y + .1); pctx.stroke(); padDirty = true; e.preventDefault(); });
pad.addEventListener('pointermove', e => { if (!padDown) return; const [x, y] = padPt(e); pctx.lineTo(x, y); pctx.stroke(); });
pad.addEventListener('pointerup', () => { padDown = false; }); pad.addEventListener('pointercancel', () => { padDown = false; });
$('#sigClr').onclick = padReset;
$('#sigOk').onclick = () => {
  if (!padDirty) return toast('Disegna prima la firma nel riquadro');
  const d = pctx.getImageData(0, 0, pad.width, pad.height).data; let x0 = pad.width, y0 = pad.height, x1 = 0, y1 = 0;
  for (let y = 0; y < pad.height; y++) for (let x = 0; x < pad.width; x++) if (d[(y * pad.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const m = 6; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(pad.width, x1 + m); y1 = Math.min(pad.height, y1 + m);
  const c = document.createElement('canvas'); c.width = x1 - x0; c.height = y1 - y0; c.getContext('2d').drawImage(pad, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  const it = { id: 'f' + Date.now().toString(36), d: c.toDataURL('image/png'), w: c.width, h: c.height };
  store.set('firme', [...store.get('firme'), it]); usaImg(it, 'firme');
};
$('#bSign').onclick = () => { renderLib('firme', 'sigLib'); openSheet('shSign'); padReset(); };
$('#bStamp').onclick = () => { renderLib('timbri', 'stLib'); openSheet('shStamp'); };
$('#stAdd').onclick = () => $('#fImg').click();
$('#fImg').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const im = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = URL.createObjectURL(f); });
    const k = Math.min(1, 900 / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    URL.revokeObjectURL(im.src);
    const jpg = /jpe?g/i.test(f.type);
    const it = { id: 't' + Date.now().toString(36), d: jpg ? c.toDataURL('image/jpeg', .88) : c.toDataURL('image/png'), w: c.width, h: c.height };
    store.set('timbri', [...store.get('timbri'), it]); usaImg(it, 'timbri');
  } catch { toast('Non riesco a leggere questa immagine'); }
};

/* ---------- moduli ---------- */
async function buildForms(r, proxy) {
  const p = r.p, src = S.sources[p.src];
  const anns = (await proxy.getAnnotations()).filter(a => a.subtype === 'Widget' && !a.readOnly && !a.hidden && a.fieldName);
  if (!anns.length || els.get(p.id) !== r) return;
  const vp = proxy.getViewport({ scale: 1, rotation: (proxy.rotate + p.rot) % 360 });
  for (const a of anns) {
    const [x0, y0, x1, y1] = pdfjsLib.Util.normalizeRect(vp.convertToViewportRectangle(a.rect));
    const w = x1 - x0, h = y1 - y0, name = a.fieldName, cur = src.form[name];
    let el;
    if (a.fieldType === 'Tx') {
      el = document.createElement(a.multiLine ? 'textarea' : 'input'); if (!a.multiLine) el.type = 'text';
      el.value = cur != null ? cur : (a.fieldValue || ''); if (a.maxLen) el.maxLength = a.maxLen;
      el.onchange = () => { snap(); src.form[name] = el.value; };
    } else if (a.fieldType === 'Btn' && a.checkBox) {
      el = document.createElement('input'); el.type = 'checkbox';
      el.checked = cur != null ? !!cur : (a.fieldValue != null && a.fieldValue !== 'Off' && a.fieldValue === a.exportValue);
      el.onchange = () => { snap(); src.form[name] = el.checked; };
    } else if (a.fieldType === 'Btn' && a.radioButton) {
      el = document.createElement('input'); el.type = 'radio'; el.name = 'rf' + p.src + '_' + name; el.value = a.buttonValue;
      el.checked = cur != null ? cur === a.buttonValue : a.fieldValue === a.buttonValue;
      el.onchange = () => { snap(); src.form[name] = a.buttonValue; };
    } else if (a.fieldType === 'Ch' && a.options) {
      el = document.createElement('select'); if (a.combo) el.append(new Option('', ''));
      for (const o of a.options) el.append(new Option(o.displayValue, o.exportValue));
      const fv = Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue; el.value = cur != null ? cur : (fv || '');
      el.onchange = () => { snap(); src.form[name] = el.value; };
    } else continue;
    const [vw, vh] = viewDims(p);
    el.style.left = x0 / vw * 100 + '%'; el.style.top = y0 / vh * 100 + '%'; el.style.width = w / vw * 100 + '%'; el.style.height = h / vh * 100 + '%';
    el.style.fontSize = `calc(var(--s) * ${Math.min(h * 0.68, 11)}px)`;
    el.setAttribute('aria-label', a.alternativeText || name);
    r.forms.append(el);
  }
}

/* ---------- salvataggio ---------- */
const hexRgb = h => { const n = parseInt(h.slice(1), 16); return rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); };
const FONT = { H: StandardFonts.Helvetica, HB: StandardFonts.HelveticaBold, T: StandardFonts.TimesRoman, TB: StandardFonts.TimesRomanBold, C: StandardFonts.Courier, CB: StandardFonts.CourierBold };

async function buildPdf(pages) {
  const out = await PDFDocument.create(); out.setProducer('Editor PDF'); out.setCreator('Editor PDF');
  const fonts = {}, sets = {}, libs = new Map(), imgs = {};
  let raster = 0;
  const font = async a => { const k = (a.font || 'H') + (a.bold ? 'B' : ''); if (!fonts[k]) { fonts[k] = await out.embedFont(FONT[k] || FONT.H); sets[k] = new Set(fonts[k].getCharacterSet()); } return [fonts[k], sets[k]]; };
  const ok = (set, s) => [...String(s).replace(/\t/g, '    ')].map(ch => set.has(ch.codePointAt(0)) ? ch : '?').join('');
  const getLib = async si => {
    if (libs.has(si)) return libs.get(si);
    const src = S.sources[si]; let doc = null;
    try {
      doc = await PDFDocument.load(src.bytes);
      const keys = Object.keys(src.form);
      if (keys.length) {
        const form = doc.getForm(), L = window.PDFLib;
        for (const k of keys) {
          const v = src.form[k];
          try {
            const f = form.getField(k);
            if (f instanceof L.PDFTextField) f.setText(v ? String(v).replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff€’‘“”–—…•]/g, '?') : '');
            else if (f instanceof L.PDFCheckBox) v ? f.check() : f.uncheck();
            else if (f instanceof L.PDFRadioGroup) f.select(String(v));
            else if (f instanceof L.PDFDropdown || f instanceof L.PDFOptionList) v ? f.select(String(v)) : f.clear();
          } catch (e) { console.warn('campo', k, e); }
        }
        try { form.flatten(); } catch (e) { console.warn(e); try { form.updateFieldAppearances(); } catch { } }
      }
    } catch (e) { console.warn('pdf-lib non legge il file, salvo come immagini', e); doc = null; }
    libs.set(si, doc); return doc;
  };

  for (const p of pages) {
    const src = S.sources[p.src], proxy = await src.pdf.getPage(p.idx + 1), bvp = proxy.getViewport({ scale: 1 });
    const lib = await getLib(p.src);
    let page, toPdf;
    if (lib) {
      const [cp] = await out.copyPages(lib, [p.idx]); page = out.addPage(cp);
      page.setRotation(degrees((proxy.rotate + p.rot) % 360));
      toPdf = (x, y) => bvp.convertToPdfPoint(x, y);
    } else {
      raster++;
      let k = 2; if (p.w * p.h * k * k > 8e6) k = Math.sqrt(8e6 / (p.w * p.h));
      const vp = proxy.getViewport({ scale: k }), c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      await proxy.render({ canvasContext: cx, viewport: vp }).promise;
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .9)); c.width = 0;
      const jpg = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      page = out.addPage([p.w, p.h]); page.drawImage(jpg, { x: 0, y: 0, width: p.w, height: p.h });
      page.setRotation(degrees(p.rot));
      toPdf = (x, y) => [x, p.h - y];
    }
    const fr = (x, y) => { const a = toPdf(x, y), b = toPdf(x + 1, y); return { x: a[0], y: a[1], rotate: degrees(Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI) }; };
    const drawLines = async (a, x, baseline) => {
      const [f, set] = await font(a), ls = lines(a);
      for (let i = 0; i < ls.length; i++) { const t = ok(set, ls[i]); if (t) page.drawText(t, { ...fr(x, baseline + i * a.size * 1.2), size: a.size, font: f, color: hexRgb(a.c || '#000000') }); }
    };
    for (const a of p.ann) {
      if (a.t === 'hl') page.drawRectangle({ ...fr(a.x, a.y + a.h), width: a.w, height: a.h, color: hexRgb(a.c), opacity: .42, blendMode: BlendMode.Multiply });
      else if (a.t === 'ink') {
        const col = hexRgb(a.c);
        for (let i = 1; i < a.pts.length; i++) { const s = toPdf(...a.pts[i - 1]), e = toPdf(...a.pts[i]); page.drawLine({ start: { x: s[0], y: s[1] }, end: { x: e[0], y: e[1] }, thickness: a.lw, color: col, lineCap: LineCapStyle.Round }); }
      } else if (a.t === 'img') {
        const d = S.assets[a.asset]; if (!d) continue;
        if (!imgs[a.asset]) { const bin = Uint8Array.from(atob(d.split(',')[1]), ch => ch.charCodeAt(0)); imgs[a.asset] = d.startsWith('data:image/jpeg') ? await out.embedJpg(bin) : await out.embedPng(bin); }
        page.drawImage(imgs[a.asset], { ...fr(a.x, a.y + a.h), width: a.w, height: a.h });
      } else if (a.t === 'cover') {
        page.drawRectangle({ ...fr(a.x, a.y + a.h), width: a.w, height: a.h, color: hexRgb(a.bg) });
        if (a.text) await drawLines(a, a.tx, a.by);
      } else if (a.t === 'text') {
        if (a.bg) {
          const [f, set] = await font(a), ls = lines(a), w = Math.max(8, ...ls.map(l => f.widthOfTextAtSize(ok(set, l), a.size))), h = ls.length * a.size * 1.2;
          page.drawRectangle({ ...fr(a.x - 3, a.y + h + 3), width: w + 6, height: h + 6, color: hexRgb(a.bg), borderColor: rgb(.85, .7, 0), borderWidth: .5 });
        }
        await drawLines(a, a.x, a.y + a.size * 0.92);
      }
    }
  }
  return { bytes: await out.save(), raster };
}

const outName = suff => (S.name || 'documento').replace(/ - (modificato|estratto)$/i, '') + ' - ' + suff + '.pdf';
async function makeFile(pages, suff) {
  busy(true, 'Preparo il PDF…');
  try {
    await new Promise(r => setTimeout(r, 30));
    const { bytes, raster } = await buildPdf(pages);
    if (raster) toast('Alcune pagine erano protette: sono state salvate come immagini', 5000);
    return new File([bytes], outName(suff), { type: 'application/pdf' });
  } catch (e) { console.error(e); toast('Non sono riuscito a creare il PDF: ' + (e.message || e), 6000); return null; }
  finally { busy(false); }
}
function download(file) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function save() {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const f = await makeFile(S.pages, 'modificato'); if (!f) return;
  download(f); S.dirty = false; toast('Salvato come «' + f.name + '»');
}
async function share() {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const f = await makeFile(S.pages, 'modificato'); if (!f) return;
  if (navigator.canShare && navigator.canShare({ files: [f] })) {
    try { await navigator.share({ files: [f], title: f.name }); S.dirty = false; return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  download(f); S.dirty = false; toast('Condivisione non disponibile qui: ho salvato il file nei Download');
}

/* ---------- pannello pagine ---------- */
const T = { sel: new Set(), run: 0 };
async function thumbs() {
  const box = $('#thumbs'); box.textContent = ''; const run = ++T.run;
  T.sel = new Set([...T.sel].filter(id => S.pages.some(p => p.id === id)));
  const jobs = [];
  S.pages.forEach((p, i) => {
    const b = document.createElement('button'); b.className = 'th'; b.setAttribute('aria-pressed', T.sel.has(p.id));
    const c = document.createElement('canvas'); const [vw, vh] = viewDims(p); const k = Math.min(110 / vw, 150 / vh) * 1.5;
    c.width = Math.round(vw * k); c.height = Math.round(vh * k); c.style.width = c.width / 1.5 + 'px';
    const s = document.createElement('span'); s.textContent = i + 1;
    b.append(c, s); b.onclick = () => { T.sel.has(p.id) ? T.sel.delete(p.id) : T.sel.add(p.id); b.setAttribute('aria-pressed', T.sel.has(p.id)); };
    box.append(b); jobs.push([p, c, k]);
  });
  for (const [p, c, k] of jobs) {
    if (run !== T.run) return;
    try { const proxy = await S.sources[p.src].pdf.getPage(p.idx + 1); await proxy.render({ canvasContext: c.getContext('2d'), viewport: proxy.getViewport({ scale: k, rotation: (proxy.rotate + p.rot) % 360 }) }).promise; } catch { }
  }
}
const need = () => { if (!T.sel.size) { toast('Seleziona prima una o più pagine'); return false; } return true; };
$('#bPages').onclick = () => { T.sel.clear(); openSheet('shPages'); thumbs(); };
$('#pAll').onclick = () => { if (T.sel.size === S.pages.length) T.sel.clear(); else S.pages.forEach(p => T.sel.add(p.id)); $$('#thumbs .th').forEach((b, i) => b.setAttribute('aria-pressed', T.sel.has(S.pages[i].id))); };
$('#pRot').onclick = () => { if (!need()) return; snap(); S.pages.forEach(p => { if (T.sel.has(p.id)) p.rot = (p.rot + 90) % 360; }); build(true); thumbs(); };
$('#pDel').onclick = () => { if (!need()) return; if (T.sel.size >= S.pages.length) return toast('Deve restare almeno una pagina'); snap(); S.pages = S.pages.filter(p => !T.sel.has(p.id)); S.sel = null; build(true); thumbs(); };
$('#pLeft').onclick = () => { if (!need()) return; snap(); const a = S.pages; for (let i = 1; i < a.length; i++) if (T.sel.has(a[i].id) && !T.sel.has(a[i - 1].id)) [a[i - 1], a[i]] = [a[i], a[i - 1]]; build(true); thumbs(); };
$('#pRight').onclick = () => { if (!need()) return; snap(); const a = S.pages; for (let i = a.length - 2; i >= 0; i--) if (T.sel.has(a[i].id) && !T.sel.has(a[i + 1].id)) [a[i + 1], a[i]] = [a[i], a[i + 1]]; build(true); thumbs(); };
$('#pExt').onclick = async () => { if (!need()) return; const f = await makeFile(S.pages.filter(p => T.sel.has(p.id)), 'estratto'); if (f) { download(f); toast('Pagine salvate in «' + f.name + '»'); } };
$('#pGo').onclick = () => { if (!need()) return; const p = S.pages.find(p => T.sel.has(p.id)); closeSheets(); goPage(p.id); };
$('#pAdd').onclick = () => $('#fAdd').click();
$('#fAdd').onchange = async e => { const fs = [...e.target.files]; e.target.value = ''; await openFiles(fs, true); if ($('#shPages').classList.contains('on')) thumbs(); };

/* ---------- cerca ---------- */
async function cerca() {
  const q = $('#q').value.trim().toLowerCase(), box = $('#qRes'); box.textContent = '';
  if (q.length < 2) { box.innerHTML = '<p class="note">Scrivi almeno 2 caratteri.</p>'; return; }
  busy(true, 'Cerco…'); let n = 0;
  try {
    for (let i = 0; i < S.pages.length && n < 200; i++) {
      const p = S.pages[i], items = await textItems(p).catch(() => []);
      const found = items.filter(it => it.str.toLowerCase().includes(q)); if (!found.length) continue;
      for (const it of found) {
        if (++n > 200) break;
        const b = document.createElement('button'); b.className = 'res';
        const sm = document.createElement('small'); sm.textContent = 'Pagina ' + (i + 1); const tx = document.createElement('span'); tx.textContent = it.str.length > 90 ? it.str.slice(0, 90) + '…' : it.str;
        b.append(sm, tx);
        b.onclick = () => {
          S.hits = { [p.id]: found.map(f => ({ x: f.x - 1, y: f.by - f.fh, w: f.w + 2, h: f.fh * 1.3 })) };
          closeSheets(); for (const r of els.values()) drawAnn(r);
          const r = els.get(p.id); if (r) { const [, vy] = b2v(p, it.x, it.by); viewer.scrollTop = r.el.offsetTop + Math.max(0, vy * S.scale - viewer.clientHeight / 3); }
        };
        box.append(b);
      }
    }
  } finally { busy(false); }
  if (!n) box.innerHTML = '<p class="note">Nessun risultato. Se il PDF è una scansione, il testo non si può cercare.</p>';
}
$('#bFind').onclick = () => { openSheet('shFind'); setTimeout(() => $('#q').focus(), 60); };
$('#qGo').onclick = cerca; $('#q').addEventListener('keydown', e => { if (e.key === 'Enter') cerca(); });

/* ---------- strumenti e barra opzioni ---------- */
function applyToolClass() {
  const d = S.tool !== 'mano';
  for (const r of els.values()) r.svg.classList.toggle('draw', d);
  document.body.classList.toggle('drawing', d);
}
function setTool(t) {
  if (t !== 'place') S.pending = null;
  S.tool = t; if (t !== 'mano' && S.sel) select(null, null);
  cancelDrag(); applyToolClass(); ui();
}
$$('#tools [data-tool]').forEach(b => b.onclick = () => setTool(S.tool === b.dataset.tool ? 'mano' : b.dataset.tool));

function sw(colors, cur, on) { return colors.map(c => { const b = document.createElement('button'); b.className = 'sw'; b.style.background = c; b.setAttribute('aria-pressed', c === cur); b.setAttribute('aria-label', 'Colore'); b.onclick = () => { on(c); ui(); }; return b; }); }
function ob(label, fn, cls) { const b = document.createElement('button'); b.className = 'ob' + (cls ? ' ' + cls : ''); b.textContent = label; b.onclick = fn; return b; }
function hint(t) { const s = document.createElement('span'); s.className = 'hint'; s.textContent = t; return s; }
function ui() {
  const has = S.pages.length > 0;
  $('#empty').style.display = has ? 'none' : ''; $('#zoom').classList.toggle('on', has);
  $('#bSave').disabled = $('#bShare').disabled = !has;
  $$('#tools .tool').forEach(b => { b.disabled = !has; });
  $('#bUndo').disabled = !S.undo.length; $('#bRedo').disabled = !S.redo.length;
  $$('#tools [data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === S.tool));
  $('#bSign').setAttribute('aria-pressed', S.tool === 'place' && S.pending && S.pending.kind === 'firme');
  $('#bStamp').setAttribute('aria-pressed', S.tool === 'place' && S.pending && S.pending.kind === 'timbri');
  const nm = $('#docName'); nm.textContent = has ? S.name : 'Editor PDF';
  if (has) { const sm = document.createElement('small'); sm.textContent = S.pages.length + (S.pages.length === 1 ? ' pagina' : ' pagine') + (S.dirty ? ' · modifiche da salvare' : ''); nm.append(sm); }
  const o = $('#opts'); o.textContent = ''; const a = selAnn();
  if (a) {
    const edit = a.t === 'text' || a.t === 'cover';
    if (edit) o.append(ob('Modifica', modifica), ob('A−', () => resizeText(-1)), ob('A+', () => resizeText(1)));
    o.append(ob('Elimina', delSel, 'del'), hint(a.t === 'ink' ? 'Trascina per spostare' : 'Trascina per spostare' + (edit && a.t === 'text' ? '' : ', pallino blu per ridimensionare')));
  } else if (S.tool === 'hl') o.append(hint('Trascina sopra il testo'), ...sw(['#ffe14d', '#9be37a', '#ffa3c4', '#8fd3ff'], S.hlColor, c => S.hlColor = c));
  else if (S.tool === 'ink') o.append(...sw(['#1a3fb0', '#000000', '#c62828'], S.inkColor, c => S.inkColor = c), ...[['Fine', 1], ['Medio', 1.6], ['Grosso', 3]].map(([l, w]) => { const b = ob(l, () => { S.inkW = w; ui(); }); if (S.inkW === w) b.style.borderColor = 'var(--ink)'; return b; }));
  else if (S.tool === 'cover') o.append(hint('Tocca il testo da correggere, oppure trascina un riquadro sopra'));
  else if (S.tool === 'text') o.append(hint('Tocca il punto dove scrivere'));
  else if (S.tool === 'note') o.append(hint('Tocca il punto dove mettere la nota'));
  else if (S.tool === 'place') o.append(hint(S.pending && S.pending.kind === 'firme' ? 'Tocca il punto dove mettere la firma' : 'Tocca il punto dove mettere il timbro'), ob('Annulla', () => setTool('mano')));
  if (has && !o.childNodes.length) o.append(hint('Scegli uno strumento qui sopra. Tocca un’aggiunta per spostarla o eliminarla.'));
  o.classList.toggle('on', has);
}
function delSel() { if (!S.sel) return; const p = S.pages.find(p => p.id === S.sel.pid); if (!p) return; snap(); p.ann = p.ann.filter(a => a.id !== S.sel.id); const r = els.get(p.id); S.sel = null; if (r) { r.p = p; drawAnn(r); } ui(); }
function resizeText(d) { const a = selAnn(); if (!a) return; snap(); a.size = clamp(+(a.size + d * (a.size > 14 ? 1 : .5)).toFixed(1), 4, 120); const r = els.get(S.sel.pid); r && drawAnn(r); }

/* ---------- comandi ---------- */
$('#bOpen').onclick = $('#bOpen2').onclick = () => $('#fOpen').click();
$('#fOpen').onchange = e => { const fs = [...e.target.files]; e.target.value = ''; openFiles(fs, false); };
$('#bSave').onclick = save; $('#bShare').onclick = share;
$('#bUndo').onclick = undo; $('#bRedo').onclick = redo;
$('#zIn').onclick = () => setScale(S.scale * 1.25); $('#zOut').onclick = () => setScale(S.scale / 1.25); $('#zFit').onclick = fit;
document.addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (S.pages.length) save(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#fOpen').click(); }
  else if (typing) return;
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { e.preventDefault(); delSel(); }
  else if (e.key === 'Escape') { closeSheets(); setTool('mano'); }
});
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

// trascinamento file (PC)
let dragN = 0;
window.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragN++; document.body.classList.add('drop'); } });
window.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('drop'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); dragN = 0; document.body.classList.remove('drop'); if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files, S.pages.length > 0 && e.shiftKey); });

// zoom con due dita
let pinch = null; const tdist = e => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
viewer.addEventListener('touchstart', e => { if (e.touches.length === 2 && S.pages.length) { cancelDrag(); pinch = { d: tdist(e), k: 1 }; } }, { passive: true });
viewer.addEventListener('touchmove', e => { if (pinch && e.touches.length === 2) { e.preventDefault(); pinch.k = clamp(tdist(e) / pinch.d, 0.2 / S.scale, 6 / S.scale); pagesEl.style.transform = `scale(${pinch.k})`; } }, { passive: false });
const pinchEnd = () => { if (!pinch) return; const k = pinch.k; pinch = null; pagesEl.style.transform = ''; if (Math.abs(k - 1) > 0.03) setScale(S.scale * k); };
viewer.addEventListener('touchend', pinchEnd); viewer.addEventListener('touchcancel', pinchEnd);
window.addEventListener('resize', () => { if ($('#shSign').classList.contains('on')) return; pageInfo(); });

/* ---------- avvio: file condivisi, apertura da sistema, funzionamento offline ---------- */
$('#ver').textContent = 'Versione ' + VERSIONE;
ui();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn(e));
if ('launchQueue' in window) window.launchQueue.setConsumer(async lp => { if (!lp.files || !lp.files.length) return; const fs = []; for (const h of lp.files) fs.push(await h.getFile()); openFiles(fs, false); });
(async () => {
  if (!new URLSearchParams(location.search).has('shared') || !('caches' in window)) return;
  history.replaceState(null, '', location.pathname);
  try {
    const c = await caches.open('editor-pdf-condivisi'), keys = await c.keys(), fs = [];
    for (const k of keys) { const r = await c.match(k); fs.push(new File([await r.blob()], decodeURIComponent(r.headers.get('x-nome') || 'documento.pdf'), { type: 'application/pdf' })); await c.delete(k); }
    if (fs.length) openFiles(fs, false);
  } catch (e) { console.warn(e); toast('Non sono riuscito a leggere il file condiviso: aprilo con «Apri»'); }
})();

// per le prove automatiche
window.__editor = { S, openFiles, buildPdf, setTool, els };
