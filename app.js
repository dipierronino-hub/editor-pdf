// ninetto-pdf — visualizza, annota, firma, riorganizza e corregge PDF nel browser.
// I documenti restano sul dispositivo: nessun caricamento online.
import * as pdfjsLib from './lib/pdf.min.mjs';

const VERSIONE = '2026-11-13b';
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
  hlColor: '#ffe14d', hlMode: 'h', lnColor: '#c62828', inkColor: '#1a3fb0', inkW: 1.6, whiteColor: '#ffffff',
  shape: { k: 'rect', c: '#c62828', lw: 2 },
  tx: { size: 11, font: 'H', bold: false, c: '#000000' },
};
let seq = 1;
const nid = () => 'k' + (seq++) + Math.random().toString(36).slice(2, 7);

/* ---------- messaggi ---------- */
// toast: tipo dedotto dal testo (errore, conferma, avviso) se non indicato
let toastT;
function toast(msg, ms = 3200, tipo) {
  const t = $('#toast');
  if (!tipo) tipo = /^(non |impossibile|errore)|non riesco|non sono riuscit/i.test(msg) ? 'err' : /^(salvat|pagine salvate|timbro inserit|annullat|ripristinat|copiat|duplicat|\d+ pagin|pagina bianca)/i.test(msg) ? 'ok' : /^(per |attenzione|deve |seleziona|scegli|trascina|qui non|disegna|scrivi)/i.test(msg) ? 'warn' : 'info';
  t.className = tipo; $('#toastMsg').textContent = msg;
  t.querySelector('use').setAttribute('href', tipo === 'ok' ? '#i-check' : tipo === 'err' || tipo === 'warn' ? '#i-warn' : '#i-info');
  requestAnimationFrame(() => t.classList.add('on'));
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), tipo === 'err' ? Math.max(ms, 5000) : ms);
}
// attesa con messaggio e, se serve, barra di avanzamento (frazione 0..1)
function busy(on, msg, frac) {
  $('#busyMsg').textContent = msg || 'Un momento…'; $('#busy').classList.toggle('on', !!on);
  progress(on ? frac : null);
}
function progress(frac, msg) {
  if (msg) $('#busyMsg').textContent = msg;
  const b = $('#busyBar'); if (frac == null) { b.hidden = true; return; }
  b.hidden = false; $('#busyFill').style.width = Math.round(clamp(frac, 0, 1) * 100) + '%';
}
const pausa = () => new Promise(r => setTimeout(r, 0)); // lascia respirare l'interfaccia durante i lavori lunghi
let sheetT = 0;
function openSheet(id) { closeMenus(); sheetT = performance.now(); $('#' + id).classList.add('on'); }
// errori imprevisti: messaggio chiaro invece del silenzio
let errT = 0;
const errore = e => { if (e && /RenderingCancelled|AbortError/.test(e.name || '')) return; console.error(e); if (!e ||Date.now() - errT < 4000) return; errT = Date.now(); busy(false); toast('Si è verificato un errore imprevisto. Se il problema continua, ricarica la pagina.', 6000, 'err'); };
window.addEventListener('error', e => { if (e.error) errore(e.error); });
window.addEventListener('unhandledrejection', e => errore(e.reason));
let txAfter = null;
function closeSheets() { $$('.sheet.on').forEach(s => s.classList.remove('on')); const f = txAfter; txAfter = null; f && f(); }
// il tocco che apre un pannello genera anche un «click» sullo sfondo: va ignorato, altrimenti il pannello si richiude subito
$$('.sheet').forEach(s => s.addEventListener('click', e => { if (e.target === s && performance.now() - sheetT < 500) return; if (e.target === s || e.target.closest('[data-close]')) closeSheets(); }));

/* ---------- apertura ---------- */
// PDF protetti: li sblocco con qpdf (caricato solo quando serve), così restano testo vero e non immagini
const cifrato = u => { const k = [47, 69, 110, 99, 114, 121, 112, 116]; outer: for (let i = u.length - k.length; i >= 0; i--) { for (let j = 0; j < k.length; j++) if (u[i + j] !== k[j]) continue outer; return true; } return false; };
let qpdfPronto;
function caricaQpdf() {
  return qpdfPronto || (qpdfPronto = new Promise((ok, ko) => { const s = document.createElement('script'); s.src = LIB + 'qpdf.js'; s.onload = () => ok(window.Module); s.onerror = () => { qpdfPronto = null; ko(new Error('qpdf non disponibile')); }; document.head.append(s); }));
}
async function sblocca(bytes, password) {
  const crea = await caricaQpdf(), q = await crea({ locateFile: () => LIB + 'qpdf.wasm', noInitialRun: true, print: () => { }, printErr: () => { } });
  q.FS.writeFile('/in.pdf', bytes);
  try { q.callMain(['--decrypt', '--password=' + (password || ''), '/in.pdf', '/out.pdf']); } catch (e) { /* qpdf termina con un'uscita: il risultato si controlla sotto */ }
  const out = q.FS.readFile('/out.pdf'); if (!out || out.length < 100) throw new Error('sblocco non riuscito');
  return new Uint8Array(out);
}

async function loadSource(file) {
  let bytes = new Uint8Array(await file.arrayBuffer());
  let password;
  if (cifrato(bytes)) { const libero = await sblocca(bytes, '').catch(e => { console.warn(e); return null; }); if (libero) bytes = libero; }
  const open = () => pdfjsLib.getDocument({ data: bytes.slice(), password, cMapUrl: LIB + 'cmaps/', cMapPacked: true, standardFontDataUrl: LIB + 'standard_fonts/' }).promise;
  let pdf;
  try { pdf = await open(); }
  catch (e) {
    if (e && e.name === 'PasswordException') {
      password = window.prompt('Questo PDF è protetto. Inserisci la password per aprirlo:');
      if (password == null) throw new Error('Apertura annullata');
      const libero = await sblocca(bytes, password).catch(err => { console.warn(err); return null; });
      if (libero) { bytes = libero; password = undefined; }
      pdf = await open();
    } else throw e;
  }
  const si = S.sources.push({ name: file.name.replace(/\.pdf$/i, ''), bytes, pdf, form: {}, tc: {} }) - 1;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const pr = await pdf.getPage(i), vp = pr.getViewport({ scale: 1 });
    out.push({ id: nid(), src: si, idx: i - 1, rot: 0, ann: [], w: vp.width, h: vp.height });
    if (pdf.numPages > 20 && i % 10 === 0) progress(i / pdf.numPages, 'Apro «' + file.name + '»… pagina ' + i + ' di ' + pdf.numPages);
  }
  return out;
}

/* ---------- documenti recenti (solo su questo dispositivo, in IndexedDB) ---------- */
const REC = {
  db: null, max: 6, maxSize: 40e6,
  open() {
    return this.db || (this.db = new Promise((ok, ko) => {
      if (!('indexedDB' in window)) return ko(new Error('IndexedDB non disponibile'));
      const r = indexedDB.open('ninetto-pdf', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('recenti', { keyPath: 'id' });
      r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
    }));
  },
  async tx(mode, fn) { const db = await this.open(); return new Promise((ok, ko) => { const t = db.transaction('recenti', mode), st = t.objectStore('recenti'), res = fn(st); t.oncomplete = () => ok(res && res.result); t.onerror = () => ko(t.error); }); },
  async list() { try { const l = await this.tx('readonly', st => st.getAll()); return (l || []).sort((a, b) => b.date - a.date); } catch { return []; } },
  async add(file, pages) {
    if (!file || file.size > this.maxSize) return;
    try {
      const id = file.name + '|' + file.size, l = await this.list();
      await this.tx('readwrite', st => { st.put({ id, name: file.name, size: file.size, pages, date: Date.now(), blob: file }); l.filter(x => x.id !== id).slice(this.max - 1).forEach(x => st.delete(x.id)); });
    } catch (e) { console.warn('recenti', e); }
  },
  async del(id) { try { await this.tx('readwrite', st => id ? st.delete(id) : st.clear()); } catch { } },
};
const kb = n => n > 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';
const quando = t => { const d = new Date(t), o = new Date(); const z = n => String(n).padStart(2, '0'); return d.toDateString() === o.toDateString() ? 'oggi alle ' + z(d.getHours()) + ':' + z(d.getMinutes()) : z(d.getDate()) + '/' + z(d.getMonth() + 1) + '/' + d.getFullYear(); };
async function showRecent() {
  const box = $('#recent'), l = await REC.list(); box.textContent = '';
  box.hidden = !l.length; if (!l.length) return;
  const h = document.createElement('h2'); h.innerHTML = '<svg class="ico" style="width:16px;height:16px"><use href="#i-clock"/></svg>Aperti di recente';
  const clr = document.createElement('button'); clr.textContent = 'Svuota elenco'; clr.onclick = async () => { await REC.del(); showRecent(); }; h.append(clr); box.append(h);
  for (const it of l) {
    const b = document.createElement('button'); b.className = 'rec';
    b.innerHTML = '<span class="ri">PDF</span><span class="rt"><b></b><small></small></span><span class="rx" role="button" aria-label="Togli dall\'elenco" title="Togli dall\'elenco"><svg class="ico" style="width:17px;height:17px"><use href="#i-x"/></svg></span>';
    b.querySelector('b').textContent = it.name.replace(/\.pdf$/i, '');
    b.querySelector('small').textContent = (it.pages ? it.pages + (it.pages === 1 ? ' pagina · ' : ' pagine · ') : '') + kb(it.size) + ' · ' + quando(it.date);
    b.onclick = async e => {
      if (e.target.closest('.rx')) { e.stopPropagation(); await REC.del(it.id); showRecent(); return; }
      openFiles([new File([it.blob], it.name, { type: 'application/pdf' })], false);
    };
    box.append(b);
  }
}

async function openFiles(files, append, pos) {
  files = [...files].filter(f => /pdf/i.test(f.type) || /\.pdf$/i.test(f.name));
  if (!files.length) return toast('Scegli un file PDF');
  if (!append && S.dirty && !window.confirm('Ci sono modifiche non salvate. Aprire un altro PDF?')) return;
  busy(true, files.length > 1 ? 'Apro ' + files.length + ' PDF…' : 'Apro «' + files[0].name + '»…');
  try {
    const nuove = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (files.length > 1) progress(i / files.length, 'Apro «' + f.name + '» (' + (i + 1) + ' di ' + files.length + ')…');
      try { const pg = await loadSource(f); nuove.push(...pg); REC.add(f, pg.length); }
      catch (e) {
        console.error(e);
        toast(e && e.message === 'Apertura annullata' ? 'Apertura annullata' : e && e.name === 'PasswordException' ? 'Password errata: non riesco ad aprire «' + f.name + '»' : 'Non riesco ad aprire «' + f.name + '»: il file potrebbe essere danneggiato o non essere un PDF', 6000);
      }
    }
    if (!nuove.length) return;
    if (append) { snap('Aggiungi PDF'); if (pos == null || pos > S.pages.length) pos = S.pages.length; S.pages.splice(pos, 0, ...nuove); }
    else {
      S.pages = nuove; S.undo = []; S.redo = []; S.dirty = files.length > 1; S.sel = null; S.hits = {};
      S.name = files[0].name.replace(/\.pdf$/i, '');
      setTool('mano');
    }
    build(append);
    if (!append) { fit(); viewer.scrollTop = 0; }
    else toast(nuove.length + (nuove.length === 1 ? ' pagina aggiunta' : ' pagine aggiunte') + (pos >= S.pages.length - nuove.length ? ' in fondo' : ' dopo la pagina ' + pos));
  } finally { busy(false); }
}

/* ---------- annulla / ripeti ---------- */
// Ogni modifica salva prima una fotografia dello stato (pagine, aggiunte, campi dei moduli) con una breve descrizione.
// Annulla/Ripristina ricostruiscono solo ciò che è cambiato: se le pagine sono le stesse, si ridisegnano solo le aggiunte (niente sfarfallio).
const shot = l => ({ j: JSON.stringify({ p: S.pages, f: S.sources.map(s => s.form) }), l: l || 'modifica' });
function snap(label) { S.undo.push(shot(label)); if (S.undo.length > 100) S.undo.shift(); S.redo = []; S.dirty = true; ui(); }
function restore(o) {
  const st = JSON.parse(o.j), prima = S.pages.map(p => p.id + ':' + p.rot + ':' + p.src + ':' + p.idx).join(), formPrima = JSON.stringify(S.sources.map(s => s.form));
  S.pages = st.p; S.sources.forEach((s, i) => { s.form = st.f[i] || {}; });
  S.sel = null; S.dirty = true;
  const stessePagine = prima === S.pages.map(p => p.id + ':' + p.rot + ':' + p.src + ':' + p.idx).join() && formPrima === JSON.stringify(S.sources.map(s => s.form));
  if (stessePagine) { for (const p of S.pages) { const r = els.get(p.id); if (r) { r.p = p; drawAnn(r); } } ui(); }
  else build(true);
  if ($('#shPages').classList.contains('on')) thumbs();
}
function undo() { if (!S.undo.length) return toast('Niente da annullare', 1500, 'info'); const o = S.undo.pop(); S.redo.push(shot(o.l)); restore(o); toast('Annullato: ' + o.l, 1600, 'ok'); }
function redo() { if (!S.redo.length) return toast('Niente da ripristinare', 1500, 'info'); const o = S.redo.pop(); S.undo.push(shot(o.l)); restore(o); toast('Ripristinato: ' + o.l, 1600, 'ok'); }

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
    const load = document.createElement('div'); load.className = 'load';
    el.append(load, svg, forms, num);
    const r = { p, el, svg, g, forms, canvas: null, key: null, vis: false };
    els.set(p.id, r); sizeEl(r); bindSvg(r); drawAnn(r);
    pagesEl.append(el); io.observe(el);
  });
  applyToolClass();
  if (keep) { viewer.scrollTop = st; viewer.scrollLeft = sl; }
  ui(); pageInfo(); buildSide();
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
  const ld = r.el.querySelector('.load'); if (ld) ld.remove();
  r.el.prepend(c); r.canvas = c; r.key = key;
  if (!r.formsDone) { r.formsDone = true; buildForms(r, proxy).catch(e => console.warn(e)); }
}
function free(r) { if (r.canvas) { r.canvas.width = 0; r.canvas.remove(); r.canvas = null; r.key = null; } }

// zoom: mantiene fermo il punto indicato (centro dello schermo, cursore o centro delle due dita)
function setScale(s, ax, ay) {
  s = clamp(s, 0.2, 6); if (!S.pages.length) { S.scale = s; return; }
  const vb = viewer.getBoundingClientRect();
  const cx = ax != null ? ax - vb.left : viewer.clientWidth / 2, cy = ay != null ? ay - vb.top : viewer.clientHeight / 2;
  const k = s / S.scale, nx = (viewer.scrollLeft + cx) * k - cx, ny = (viewer.scrollTop + cy) * k - cy;
  S.scale = s;
  for (const r of els.values()) { sizeEl(r); if (r.vis) queue(r); }
  viewer.scrollLeft = nx; viewer.scrollTop = ny;
  if (S.sel) { const r = els.get(S.sel.pid); r && drawAnn(r); }
  $('#zPct').textContent = Math.round(s * 100) + '%';
}
function fit(modo) {
  if (!S.pages.length) return;
  const maxW = Math.max(...S.pages.map(p => viewDims(p)[0]));
  if (modo === 'page') {
    const r = paginaCorrente(), [vw, vh] = viewDims(r ? r.p : S.pages[0]);
    setScale(Math.min((viewer.clientWidth - 24) / vw, (viewer.clientHeight - 40) / vh));
    if (r) goPage(r.p.id);
  } else setScale(Math.min((viewer.clientWidth - (viewer.clientWidth < 600 ? 16 : 48)) / maxW, viewer.clientWidth < 600 ? 1.6 : 2));
}
function paginaCorrente() {
  const top = viewer.getBoundingClientRect().top + viewer.clientHeight / 3; let best = null;
  for (const el of pagesEl.children) { best = el; if (el.getBoundingClientRect().bottom > top) break; }
  return best ? els.get(best.dataset.id) : null;
}
let curPage = 0;
function pageInfo() {
  const on = S.pages.length > 0; $('#nav').classList.toggle('on', on); if (!on) return;
  const r = paginaCorrente(), n = r ? S.pages.indexOf(r.p) + 1 : 1;
  if (document.activeElement !== $('#nNum')) $('#nNum').value = n;
  $('#nNum').max = S.pages.length; $('#nTot').textContent = '/ ' + S.pages.length;
  $('#nPrev').disabled = n <= 1; $('#nNext').disabled = n >= S.pages.length;
  if (n !== curPage) { curPage = n; sideCur(); }
}
let piRaf; viewer.addEventListener('scroll', () => { cancelAnimationFrame(piRaf); piRaf = requestAnimationFrame(pageInfo); }, { passive: true });
function goPage(id, smooth) { const r = els.get(id); if (r) viewer.scrollTo({ top: r.el.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' }); }
const goN = n => { n = clamp(n, 1, S.pages.length); goPage(S.pages[n - 1].id); };
$('#nPrev').onclick = () => goN(curPage - 1);
$('#nNext').onclick = () => goN(curPage + 1);
$('#nNum').addEventListener('change', () => { const n = parseInt($('#nNum').value, 10); if (n) goN(n); $('#nNum').blur(); });
$('#nNum').addEventListener('keydown', e => { if (e.key === 'Enter') $('#nNum').dispatchEvent(new Event('change')); });

/* ---------- miniature laterali (PC e tablet) ---------- */
const SIDE = { run: 0, io: null };
function buildSide() {
  const box = $('#side'); box.textContent = ''; const run = ++SIDE.run;
  if (SIDE.io) SIDE.io.disconnect();
  if (!document.body.classList.contains('side') || !S.pages.length) return;
  SIDE.io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { SIDE.io.unobserve(e.target); sideRender(e.target, run); } }), { root: box, rootMargin: '300px 0px' });
  S.pages.forEach((p, i) => {
    const b = document.createElement('button'); b.className = 'sth'; b.dataset.id = p.id; b.title = 'Vai alla pagina ' + (i + 1);
    const [vw, vh] = viewDims(p), k = Math.min(132 / vw, 180 / vh);
    const ph = document.createElement('div'); ph.className = 'ph'; ph.style.width = Math.round(vw * k) + 'px'; ph.style.height = Math.round(vh * k) + 'px';
    const s = document.createElement('span'); s.textContent = i + 1;
    b.append(ph, s);
    b.onclick = () => { goPage(p.id, true); if (window.innerWidth < 900) toggleSide(false); };
    box.append(b); SIDE.io.observe(b);
  });
  curPage = 0; pageInfo();
}
let sideChain = Promise.resolve();
function sideRender(b, run) {
  sideChain = sideChain.then(async () => {
    if (run !== SIDE.run) return;
    const p = S.pages.find(q => q.id === b.dataset.id); if (!p) return;
    const proxy = await S.sources[p.src].pdf.getPage(p.idx + 1), [vw, vh] = viewDims(p), k = Math.min(132 / vw, 180 / vh), d = Math.min(window.devicePixelRatio || 1, 2);
    const c = document.createElement('canvas'), vp = proxy.getViewport({ scale: k * d, rotation: (proxy.rotate + p.rot) % 360 });
    c.width = Math.round(vp.width); c.height = Math.round(vp.height); c.style.width = Math.round(vw * k) + 'px'; c.style.height = Math.round(vh * k) + 'px';
    await proxy.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    if (run === SIDE.run && b.firstChild) b.firstChild.replaceWith(c);
  }).catch(e => console.warn(e));
}
function sideCur() {
  const id = S.pages[curPage - 1] && S.pages[curPage - 1].id; let cur = null;
  $$('#side .sth').forEach(b => { const on = b.dataset.id === id; b.classList.toggle('cur', on); if (on) cur = b; });
  if (cur) { const box = $('#side'), t = cur.offsetTop, h = cur.offsetHeight; if (t < box.scrollTop || t + h > box.scrollTop + box.clientHeight) box.scrollTo({ top: t - box.clientHeight / 3, behavior: 'smooth' }); }
}
function toggleSide(on) {
  on = on == null ? !document.body.classList.contains('side') : on;
  document.body.classList.toggle('side', on);
  try { localStorage.setItem('editorpdf.side', on ? '1' : '0'); } catch { }
  $('#bSide').setAttribute('aria-pressed', on); buildSide();
}

/* ---------- annotazioni: disegno a schermo ---------- */
const fontCss = f => f === 'T' ? '"Times New Roman",Times,serif' : f === 'C' ? '"Courier New",Courier,monospace' : 'Arial,Helvetica,sans-serif';
const mctx = document.createElement('canvas').getContext('2d');
function textW(a, line) { mctx.font = `${a.bold ? 'bold ' : ''}${a.size}px ${fontCss(a.font)}`; return mctx.measureText(line).width; }
const lines = a => String(a.text || '').split('\n');
function bbox(a) {
  if (a.pts) { // disegno a mano, linee e frecce
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of a.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const m = 2 + (a.lw || 0) / 2 + (a.k === 'arrow' ? (a.lw || 2) * 2.5 : 0);
    return { x: x0 - m, y: y0 - m, w: x1 - x0 + m * 2, h: y1 - y0 + m * 2 };
  }
  if (a.t === 'text') {
    const ls = lines(a), w = Math.max(8, ...ls.map(l => textW(a, l))), h = ls.length * a.size * 1.2, pad = a.bg ? 3 : 0;
    return { x: a.x - pad, y: a.y - pad, w: w + pad * 2, h: h + pad * 2 };
  }
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}
// sottolineato: appena sotto la base del testo; barrato: a metà dell'altezza delle lettere
const hlLineW = a => clamp(a.h * 0.08, 0.8, 2.5);
const hlLineY = a => a.m === 'u' ? a.y + a.h * 0.9 : a.y + a.h * 0.55;
// punta della freccia: due segmenti inclinati di 28° rispetto alla linea
function punta(a) {
  const [[x1, y1], [x2, y2]] = a.pts, ang = Math.atan2(y2 - y1, x2 - x1), L = Math.max(8, a.lw * 4.5), d = 0.49;
  return [[x2 - L * Math.cos(ang - d), y2 - L * Math.sin(ang - d)], [x2, y2], [x2 - L * Math.cos(ang + d), y2 - L * Math.sin(ang + d)]];
}
function textEl(a, x, baseline) {
  const t = sv('text', { 'font-size': a.size, fill: a.c || '#000', 'font-family': fontCss(a.font), 'font-weight': a.bold ? 'bold' : 'normal' });
  t.style.whiteSpace = 'pre';
  lines(a).forEach((l, i) => { const s = sv('tspan', { x, y: baseline + i * a.size * 1.2 }); s.textContent = l; t.append(s); });
  return t;
}
function annEl(a) {
  const e = sv('g', { class: 'ann', 'data-id': a.id });
  const hitw = Math.max(14 / S.scale, (a.lw || 0) + 6); // zona di presa più larga del tratto: selezione precisa anche col dito
  if (a.t === 'hl') {
    if (a.m === 'u' || a.m === 's') { // sottolineato o barrato
      const y = hlLineY(a);
      e.append(sv('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: 'transparent' }), sv('line', { x1: a.x, y1: y, x2: a.x + a.w, y2: y, stroke: a.c, 'stroke-width': hlLineW(a), 'stroke-linecap': 'butt' }));
    } else { const r = sv('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: a.c, opacity: .42 }); r.style.mixBlendMode = 'multiply'; e.append(r); }
  }
  else if (a.t === 'ink') {
    const pts = a.pts.map(p => p.join(',')).join(' ');
    e.append(sv('polyline', { class: 'hitw', points: pts, 'stroke-width': hitw }), sv('polyline', { points: pts, fill: 'none', stroke: a.c, 'stroke-width': a.lw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }
  else if (a.t === 'shape') {
    const st = { fill: 'none', stroke: a.c, 'stroke-width': a.lw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    if (a.k === 'rect') e.append(sv('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: 'transparent', stroke: 'transparent', 'stroke-width': hitw }), sv('rect', { x: a.x, y: a.y, width: a.w, height: a.h, ...st }));
    else if (a.k === 'ellipse') e.append(sv('ellipse', { cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: a.w / 2, ry: a.h / 2, fill: 'transparent', stroke: 'transparent', 'stroke-width': hitw }), sv('ellipse', { cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: a.w / 2, ry: a.h / 2, ...st }));
    else {
      const [[x1, y1], [x2, y2]] = a.pts;
      e.append(sv('line', { class: 'hitw', x1, y1, x2, y2, 'stroke-width': hitw }), sv('line', { x1, y1, x2, y2, ...st }));
      if (a.k === 'arrow') e.append(sv('polyline', { points: punta(a).map(p => p.join(',')).join(' '), ...st }));
    }
  }
  else if (a.t === 'img') e.append(sv('image', { href: S.assets[a.asset] || '', x: a.x, y: a.y, width: a.w, height: a.h, preserveAspectRatio: 'none' }));
  else if (a.t === 'cover') { e.append(sv('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: a.bg })); if (a.text) e.append(textEl(a, a.tx, a.by)); }
  else if (a.t === 'stamp') {
    // timbro: doppia cornice e scritta in grassetto, inclinati attorno al centro
    const cx = a.x + a.w / 2, cy = a.y + a.h / 2, bw = a.h * 0.07, size = Math.min(a.h * 0.46, a.w * 0.84 / (textW({ size: 100, bold: true, font: 'H' }, a.text) / 100));
    const g = sv('g', { transform: `rotate(${a.ang} ${cx} ${cy})`, opacity: .85 });
    g.append(sv('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: 'transparent' }),
      sv('rect', { x: a.x + bw / 2, y: a.y + bw / 2, width: a.w - bw, height: a.h - bw, fill: 'none', stroke: a.c, 'stroke-width': bw }),
      sv('rect', { x: a.x + bw * 2, y: a.y + bw * 2, width: a.w - bw * 4, height: a.h - bw * 4, fill: 'none', stroke: a.c, 'stroke-width': bw * 0.35 }));
    const t = sv('text', { x: cx, y: cy + size * 0.35, 'text-anchor': 'middle', 'font-size': size, 'font-weight': 'bold', 'font-family': fontCss('H'), fill: a.c }); t.textContent = a.text; g.append(t);
    e.append(g);
  }
  else if (a.t === 'text') {
    if (a.bg) { const b = bbox(a); e.append(sv('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: a.bg, stroke: '#d9b400', 'stroke-width': .5 })); }
    else { const b = bbox(a); e.append(sv('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: 'transparent' })); }
    e.append(textEl(a, a.x, a.y + a.size * 0.92));
  }
  return e;
}
function drawAnn(r) {
  const g = r.g; g.textContent = '';
  for (const h of (S.hits[r.p.id] || [])) g.append(sv('rect', { class: h.cur ? 'hit cur' : 'hit', x: h.x, y: h.y, width: h.w, height: h.h, rx: 1.5 }));
  for (const a of r.p.ann) g.append(annEl(a));
  if (S.sel && S.sel.pid === r.p.id) {
    const a = r.p.ann.find(x => x.id === S.sel.id);
    if (a) {
      const el = g.querySelector(`[data-id="${a.id}"]`); el && el.classList.add('sel');
      const b = bbox(a);
      g.append(sv('rect', { class: 'selbox', x: b.x - 1, y: b.y - 1, width: b.w + 2, height: b.h + 2 }));
      const k = 1 / S.scale;
      for (const c of ['nw', 'ne', 'sw', 'se']) {
        const cx = c[1] === 'w' ? b.x : b.x + b.w, cy = c[0] === 'n' ? b.y : b.y + b.h;
        g.append(sv('circle', { class: 'hhit', 'data-c': c, cx, cy, r: (fine ? 12 : 20) * k }), sv('circle', { class: 'handle', 'data-c': c, cx, cy, r: (fine ? 6 : 8) * k }));
      }
      const dx = b.x + b.w / 2, dy = b.y - 20 * k, x = sv('g', { class: 'delx' }); // ✕ rapida sopra l'oggetto
      x.append(sv('circle', { cx: dx, cy: dy, r: 10 * k, fill: '#c62828', stroke: '#fff', 'stroke-width': 1.5 * k }),
        sv('path', { d: `M${dx - 4 * k} ${dy - 4 * k}L${dx + 4 * k} ${dy + 4 * k}M${dx + 4 * k} ${dy - 4 * k}L${dx - 4 * k} ${dy + 4 * k}`, stroke: '#fff', 'stroke-width': 2 * k, 'stroke-linecap': 'round' }));
      g.append(x);
    }
  }
}
const fine = matchMedia('(pointer:fine)').matches; // mouse: maniglie piccole; dito: zone di presa più grandi
function select(pid, id) {
  const old = S.sel; S.sel = id ? { pid, id } : null;
  if (old) { const r = els.get(old.pid); r && drawAnn(r); }
  if (S.sel) { const r = els.get(pid); r && drawAnn(r); }
  ui();
}
const selAnn = () => { if (!S.sel) return null; const p = S.pages.find(p => p.id === S.sel.pid); return p ? p.ann.find(a => a.id === S.sel.id) : null; };

/* ---------- annotazioni: gesti ---------- */
// Ridimensiona dall'angolo trascinato tenendo fermo quello opposto. Immagini, timbri, testi e disegni mantengono le proporzioni.
function ridimensiona(d, x, y) {
  const a = d.a, a0 = d.a0, b0 = d.b0, c = d.c;
  const ax = c[1] === 'w' ? b0.x + b0.w : b0.x, ay = c[0] === 'n' ? b0.y + b0.h : b0.y;
  let nw = Math.abs(x - ax), nh = Math.abs(y - ay), k = 1;
  const libero = a.t === 'hl' || a.t === 'cover' || (a.t === 'shape' && !a.pts); // riquadri: larghezza e altezza indipendenti
  if (libero) { nw = Math.max(nw, 6); nh = Math.max(nh, 4); }
  else { k = Math.max(nw / b0.w, nh / b0.h, 12 / Math.max(b0.w, b0.h)); nw = b0.w * k; nh = b0.h * k; }
  const nx = c[1] === 'w' ? ax - nw : ax, ny = c[0] === 'n' ? ay - nh : ay;
  if (a.t === 'hl' || a.t === 'img' || a.t === 'stamp' || (a.t === 'shape' && !a.pts)) { a.x = nx; a.y = ny; a.w = nw; a.h = nh; }
  else if (a.t === 'cover') { a.x = nx; a.y = ny; a.w = nw; a.h = nh; a.tx = a0.tx + nx - b0.x; a.by = a0.by + ny - b0.y; }
  else if (a.t === 'text') { const pad = a.bg ? 3 : 0; a.size = clamp(+(a0.size * k).toFixed(2), 4, 120); a.x = nx + pad; a.y = ny + pad; }
  else if (a.pts) a.pts = a0.pts.map(([px, py]) => [+(ax + (px - ax) * k).toFixed(2), +(ay + (py - ay) * k).toFixed(2)]); // si scala attorno all'angolo fermo
}
function pt(r, e) { const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(r.g.getScreenCTM().inverse()); return [q.x, q.y]; }
let drag = null;
function cancelDrag() { if (drag && drag.tmp) drag.tmp.remove(); drag = null; }
const NOMI_FORME = { rect: 'Rettangolo', ellipse: 'Ellisse', line: 'Linea', arrow: 'Freccia' };
const nomeAnn = a => !a ? 'elemento' : a.t === 'shape' ? NOMI_FORME[a.k].toLowerCase() : ({ hl: 'evidenziazione', ink: 'disegno', img: 'immagine', stamp: 'timbro', cover: 'correzione', text: a.bg ? 'nota' : 'testo' })[a.t] || 'elemento';
// Maiusc: quadrati e cerchi perfetti, linee a passi di 45°
function vincola(x0, y0, x, y, on) {
  if (!on) return [x, y];
  const dx = x - x0, dy = y - y0;
  if (S.shape.k === 'line' || S.shape.k === 'arrow') { const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, l = Math.hypot(dx, dy); return [x0 + l * Math.cos(ang), y0 + l * Math.sin(ang)]; }
  const m = Math.max(Math.abs(dx), Math.abs(dy)); return [x0 + Math.sign(dx || 1) * m, y0 + Math.sign(dy || 1) * m];
}
// tratto a mano libera: toglie i punti superflui (file più leggero, linea più pulita)
function semplifica(pts, tol) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1], L = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    if (Math.abs((c[0] - a[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (c[1] - a[1])) / L > tol) out.push(b);
  }
  out.push(pts[pts.length - 1]); return out;
}
// evidenziazione «agganciata» alle righe di testo sotto il riquadro: altezza esatta della riga, bordi sulle lettere
async function aggancia(p, box) {
  const items = (await textItems(p).catch(() => [])).filter(i => i.flat && i.x < box.x + box.w && i.x + i.w > box.x && i.by - i.fh * 0.35 >= box.y - i.fh * 0.25 && i.by - i.fh * 0.35 <= box.y + box.h + i.fh * 0.25);
  if (!items.length) return box;
  const y0 = Math.min(...items.map(i => i.by - i.fh * 0.9)), y1 = Math.max(...items.map(i => i.by + i.fh * 0.22));
  const x0 = Math.max(box.x, Math.min(...items.map(i => i.x))), x1 = Math.min(box.x + box.w, Math.max(...items.map(i => i.x + i.w)));
  if (x1 - x0 < 2) return box;
  return { x: +x0.toFixed(2), y: +y0.toFixed(2), w: +(x1 - x0).toFixed(2), h: +(y1 - y0).toFixed(2) };
}

function bindSvg(r) {
  const svg = r.svg;
  svg.addEventListener('pointerdown', e => {
    if (e.button > 0 || drag) return;
    const [x, y] = pt(r, e), tool = S.tool;
    if (e.target.closest('.delx')) { e.preventDefault(); delSel(); return; }
    if (e.target.classList.contains('handle') || e.target.classList.contains('hhit')) {
      const a = selAnn(); if (!a) return;
      drag = { k: 'resize', r, a, c: e.target.dataset.c || 'se', b0: bbox(a), a0: JSON.parse(JSON.stringify(a)), moved: false };
    } else if (tool === 'mano') {
      const ae = e.target.closest('.ann'); if (!ae) return;
      const id = ae.dataset.id, was = S.sel && S.sel.id === id;
      if (!was) { select(r.p.id, id); if (e.pointerType !== 'mouse') return; }
      const a = r.p.ann.find(q => q.id === id);
      drag = { k: 'move', r, a, x, y, moved: false };
    } else if (tool === 'hl' || tool === 'cover' || tool === 'erase' || tool === 'white') {
      const tmp = sv('rect', { x, y, width: 0, height: 0, fill: tool === 'hl' ? S.hlColor : tool === 'erase' ? '#c62828' : tool === 'white' ? '#7a8a93' : '#1a73e8', opacity: .35 });
      r.g.append(tmp); drag = { k: 'rect', r, x, y, tmp, tool };
    } else if (tool === 'ink') {
      const tmp = sv('polyline', { fill: 'none', stroke: S.inkColor, 'stroke-width': S.inkW, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', points: `${x},${y}` });
      r.g.append(tmp); drag = { k: 'ink', r, pts: [[x, y]], tmp };
    } else if (tool === 'shape') {
      const sh = S.shape, st = { fill: 'none', stroke: sh.c, 'stroke-width': sh.lw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: .8 };
      const tmp = sh.k === 'rect' ? sv('rect', st) : sh.k === 'ellipse' ? sv('ellipse', st) : sv('line', { ...st, x1: x, y1: y, x2: x, y2: y });
      r.g.append(tmp); drag = { k: 'shape', r, x, y, x2: x, y2: y, tmp };
    } else { drag = { k: 'tap', r, x, y }; }
    e.preventDefault();
    try { svg.setPointerCapture(e.pointerId); } catch { }
  });
  svg.addEventListener('pointermove', e => {
    if (!drag || drag.r !== r) return;
    const [x, y] = pt(r, e), d = drag;
    if (d.k === 'move') {
      const dx = x - d.x, dy = y - d.y;
      if (!d.moved) { if (Math.hypot(dx, dy) * S.scale < 4) return; d.moved = true; snap('Sposta ' + nomeAnn(d.a)); }
      const a = d.a; d.x = x; d.y = y;
      if (a.pts) a.pts = a.pts.map(([px, py]) => [px + dx, py + dy]);
      else { a.x += dx; a.y += dy; if (a.t === 'cover') { a.tx += dx; a.by += dy; } }
      drawAnn(r);
    } else if (d.k === 'resize') {
      if (!d.moved) { d.moved = true; snap('Ridimensiona ' + nomeAnn(d.a)); }
      ridimensiona(d, x, y);
      drawAnn(r);
    } else if (d.k === 'rect') {
      d.tmp.setAttribute('x', Math.min(x, d.x)); d.tmp.setAttribute('y', Math.min(y, d.y));
      d.tmp.setAttribute('width', Math.abs(x - d.x)); d.tmp.setAttribute('height', Math.abs(y - d.y));
    } else if (d.k === 'ink') {
      const l = d.pts[d.pts.length - 1];
      if (Math.hypot(x - l[0], y - l[1]) * S.scale > 1.2) { d.pts.push([+x.toFixed(2), +y.toFixed(2)]); d.tmp.setAttribute('points', d.pts.map(p => p.join(',')).join(' ')); }
    } else if (d.k === 'shape') {
      [d.x2, d.y2] = vincola(d.x, d.y, x, y, e.shiftKey);
      const b = { x: Math.min(d.x, d.x2), y: Math.min(d.y, d.y2), w: Math.abs(d.x2 - d.x), h: Math.abs(d.y2 - d.y) };
      if (S.shape.k === 'rect') { d.tmp.setAttribute('x', b.x); d.tmp.setAttribute('y', b.y); d.tmp.setAttribute('width', b.w); d.tmp.setAttribute('height', b.h); }
      else if (S.shape.k === 'ellipse') { d.tmp.setAttribute('cx', b.x + b.w / 2); d.tmp.setAttribute('cy', b.y + b.h / 2); d.tmp.setAttribute('rx', b.w / 2); d.tmp.setAttribute('ry', b.h / 2); }
      else { d.tmp.setAttribute('x2', d.x2); d.tmp.setAttribute('y2', d.y2); }
    }
  });
  const up = async e => {
    if (!drag || drag.r !== r) return;
    const d = drag, [x, y] = pt(r, e); drag = null;
    if (d.tmp) d.tmp.remove();
    if (e.type === 'pointercancel') { drawAnn(r); return; }
    if (d.k === 'rect') {
      const box = { x: Math.min(x, d.x), y: Math.min(y, d.y), w: Math.abs(x - d.x), h: Math.abs(y - d.y) };
      const small = box.w * S.scale < 6 || box.h * S.scale < 6;
      if (d.tool === 'hl') {
        if (small) toast('Trascina sopra il testo da evidenziare');
        else { const b2 = await aggancia(r.p, box); snap(S.hlMode === 'u' ? 'Sottolinea' : S.hlMode === 's' ? 'Barrato' : 'Evidenzia'); r.p.ann.push({ id: nid(), t: 'hl', ...b2, c: S.hlMode === 'h' ? S.hlColor : S.lnColor, m: S.hlMode }); drawAnn(r); }
      }
      else if (d.tool === 'white') {
        // bianchetto: rettangolo pieno (bianco o nero); resta selezionabile, spostabile e ridimensionabile finché non salvi
        if (small) toast('Trascina un riquadro sulla parte da coprire');
        else { snap('Bianchetto'); r.p.ann.push({ id: nid(), t: 'cover', ...box, bg: S.whiteColor, tx: box.x, by: box.y, text: '', size: 11, font: 'H', bold: false, c: '#000000' }); drawAnn(r); }
      }
      else if (d.tool === 'erase') cancella(r, small ? null : box, d.x, d.y);
      else correggi(r, small ? null : box, d.x, d.y);
    } else if (d.k === 'ink') {
      if (d.pts.length > 1) { snap('Disegno'); r.p.ann.push({ id: nid(), t: 'ink', pts: semplifica(d.pts, 0.35 / S.scale), c: S.inkColor, lw: S.inkW }); drawAnn(r); }
    } else if (d.k === 'shape') {
      const sh = S.shape, w = Math.abs(d.x2 - d.x), h = Math.abs(d.y2 - d.y);
      if (Math.max(w, h) * S.scale < 8) { toast('Trascina sulla pagina per disegnare la forma'); return; }
      snap(NOMI_FORME[sh.k]);
      const a = { id: nid(), t: 'shape', k: sh.k, c: sh.c, lw: sh.lw };
      if (sh.k === 'rect' || sh.k === 'ellipse') Object.assign(a, { x: Math.min(d.x, d.x2), y: Math.min(d.y, d.y2), w: Math.max(w, 2), h: Math.max(h, 2) });
      else a.pts = [[+d.x.toFixed(2), +d.y.toFixed(2)], [+d.x2.toFixed(2), +d.y2.toFixed(2)]];
      r.p.ann.push(a); drawAnn(r);
    } else if (d.k === 'tap') {
      if (S.tool === 'place' && S.pending) placeImg(r, d.x, d.y);
      else if (S.tool === 'text' || S.tool === 'note') nuovoTesto(r, d.x, d.y, S.tool === 'note');
    }
  };
  svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
  svg.addEventListener('dblclick', e => { const ae = e.target.closest('.ann'); if (ae && S.tool === 'mano') { select(r.p.id, ae.dataset.id); modifica(); } });
}
viewer.addEventListener('pointerdown', e => {
  if (S.tool !== 'mano' || e.target.closest('.ann,.handle,.delx,.forms>*')) return;
  if (S.sel) select(null, null);
  if (Object.keys(S.hits).length) { const ids = Object.keys(S.hits); S.hits = {}; ids.forEach(id => { const r = els.get(id); r && drawAnn(r); }); }
});

/* ---------- testo ---------- */
let txCb = null, txColor = '#000000', txNota = false;
function txColorSet(c) { txColor = c; $$('#shText .sw').forEach(b => b.setAttribute('aria-pressed', b.dataset.c === c)); $('#txCustom').value = c; txPrev(); }
// anteprima dal vivo: carattere, dimensione (a scala di lettura) e colore come verranno nel PDF
function txPrev() {
  const p = $('#txPrev'), v = $('#txVal').value || 'Anteprima del testo', sz = clamp(parseFloat($('#txSize').value) || 11, 4, 120);
  p.textContent = v; p.style.color = txColor; p.style.fontFamily = fontCss($('#txFont').value); p.style.fontWeight = $('#txBold').checked ? 'bold' : 'normal';
  p.style.fontSize = clamp(sz * 1.35, 9, 44) + 'px'; p.style.background = txNota ? '#fff3a6' : '#fff';
}
function askText(o, cb, after) {
  $('#txTitle').textContent = o.title; $('#txNote').textContent = o.note || ''; $('#txNote').style.display = o.note ? '' : 'none';
  $('#txVal').value = o.text || ''; $('#txSize').value = +(+o.size).toFixed(1); $('#txFont').value = o.font || 'H'; $('#txBold').checked = !!o.bold;
  txNota = !!o.nota; txColorSet(o.c || '#000000');
  txCb = cb; txAfter = after || null; openSheet('shText'); setTimeout(() => { $('#txVal').focus(); $('#txVal').select(); }, 60);
}
$$('#shText .sw').forEach(b => b.onclick = () => txColorSet(b.dataset.c));
$('#txCustom').addEventListener('input', e => txColorSet(e.target.value));
['txVal', 'txSize', 'txFont', 'txBold'].forEach(id => { $('#' + id).addEventListener('input', txPrev); $('#' + id).addEventListener('change', txPrev); });
$('#txVal').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#txOk').click(); } });
$('#txOk').onclick = () => {
  const v = { text: $('#txVal').value.replace(/\s+$/, ''), size: clamp(parseFloat($('#txSize').value) || 11, 4, 120), font: $('#txFont').value, bold: $('#txBold').checked, c: txColor };
  closeSheets(); const cb = txCb; txCb = null; cb && cb(v);
};
function nuovoTesto(r, x, y, nota) {
  askText({ title: nota ? 'Nuova nota' : 'Nuovo testo', text: '', ...S.tx, nota }, v => {
    if (!v.text) return toast('Testo vuoto: non ho aggiunto nulla', 2200, 'info');
    S.tx = { size: v.size, font: v.font, bold: v.bold, c: v.c };
    snap(nota ? 'Nota' : 'Testo'); const a = { id: nid(), t: 'text', x, y: y - v.size * 0.6, ...v }; if (nota) a.bg = '#fff3a6';
    r.p.ann.push(a); setTool('mano'); select(r.p.id, a.id); // subito selezionato: si può spostare o ridimensionare
  });
}
function modifica() {
  const a = selAnn(); if (!a || (a.t !== 'text' && a.t !== 'cover')) return;
  const r = els.get(S.sel.pid);
  askText({ title: a.t === 'cover' ? 'Correggi testo' : 'Modifica testo', text: a.text, size: a.size, font: a.font, bold: a.bold, c: a.c, nota: !!a.bg && a.t === 'text' }, v => {
    if (!v.text && a.t === 'text') return;
    snap('Modifica ' + nomeAnn(a)); Object.assign(a, v); r && drawAnn(r);
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
    snap(it ? "Correggi testo" : "Copri e scrivi");
    r.p.ann.push({ id: nid(), t: 'cover', ...box, bg: col.bg, tx: it ? it.x : box.x + 1.5, by: it ? it.by : box.y + box.h / 2 + v.size * 0.35, ...v });
    drawAnn(r);
  }, () => tmp.remove());
}

/* ---------- cancella ---------- */
// Tocco: toglie l'aggiunta (nota, firma, evidenziazione…) o la scritta del PDF che si trova in quel punto.
// Riquadro: cancella tutto quello che c'è dentro. Nel file salvato il contenuto cancellato viene tolto davvero.
async function cancella(r, box, x, y) {
  const p = r.p;
  if (!box) {
    for (let i = p.ann.length - 1; i >= 0; i--) {
      const b = bbox(p.ann[i]);
      if (x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 2 && y <= b.y + b.h + 2) { snap("Cancella " + nomeAnn(p.ann[i])); p.ann.splice(i, 1); drawAnn(r); return; }
    }
    const sc = await scritte(p).catch(e => { console.warn('scritte', e); return []; });
    const dist = b => Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3]));
    const vicine = sc.filter(b => dist(b) <= 2).sort((a, b) => dist(a) - dist(b) || (a[2] - a[0]) * (a[3] - a[1]) - (b[2] - b[0]) * (b[3] - b[1]));
    if (vicine.length) { const b = vicine[0]; box = { x: b[0] - 1, y: b[1], w: b[2] - b[0] + 2, h: b[3] - b[1] }; }
    else {
      const items = await textItems(p).catch(() => []);
      const it = items.find(i => i.flat && x >= i.x - 2 && x <= i.x + i.w + 2 && y >= i.by - i.fh * 1.05 && y <= i.by + i.fh * 0.35);
      if (!it) return toast('Qui non trovo una scritta: trascina un riquadro sopra la parte da cancellare');
      box = { x: it.x - 1, y: it.by - it.fh * 0.98, w: it.w + 2, h: it.fh * 1.3 };
    }
  }
  const col = sampleColors(r, box);
  snap("Cancella");
  const a = { id: nid(), t: 'cover', ...box, bg: col.bg, tx: box.x, by: box.y, text: '', size: 11, font: 'H', bold: false, c: '#000000' };
  p.ann.push(a); select(p.id, a.id); // resta selezionata: con le maniglie agli angoli si aggiusta il riquadro
}

/* ---------- firme e timbri ---------- */
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('editorpdf.' + k) || '[]'); } catch { return []; } },
  set(k, v) { try { localStorage.setItem('editorpdf.' + k, JSON.stringify(v)); return true; } catch { toast('Memoria piena: elimina qualche firma o timbro salvato'); return false; } },
};
const MAX_FIRME = 3;
function renderLib(kind, elId) {
  const box = $('#' + elId), list = store.get(kind), firme = kind === 'firme'; box.textContent = '';
  if (firme) $('#sigCount').textContent = list.length ? `Firme salvate: ${list.length} di ${MAX_FIRME}` : '';
  if (!list.length) { const n = document.createElement('p'); n.className = 'note'; n.style.margin = '0'; n.textContent = firme ? 'Nessuna firma salvata su questo dispositivo.' : 'Nessuna immagine salvata su questo dispositivo.'; box.append(n); return; }
  for (const it of list) {
    const d = document.createElement('div'); d.className = 'it';
    const im = document.createElement('img'); im.src = it.d; im.alt = firme ? 'Firma salvata' : 'Timbro salvato';
    const row = document.createElement('div'); row.className = 'itb';
    const b = document.createElement('button'); b.className = 'btn pri sm'; b.textContent = 'Applica'; b.onclick = () => usaImg(it, kind);
    const x = document.createElement('button'); x.className = 'btn del sm'; x.innerHTML = '<svg class="ico"><use href="#i-trash"/></svg>'; x.setAttribute('aria-label', 'Elimina'); x.title = 'Elimina';
    x.onclick = () => { if (!window.confirm(firme ? 'Eliminare questa firma salvata?' : 'Eliminare questa immagine salvata?')) return; store.set(kind, store.get(kind).filter(q => q.id !== it.id)); renderLib(kind, elId); };
    im.onclick = b.onclick; row.append(b, x); d.append(im, row); box.append(d);
  }
}

/* ---------- timbri rapidi e personalizzati (vettoriali, con data del giorno) ---------- */
const oggi = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${z(d.getDate())}/${z(d.getMonth() + 1)}/${d.getFullYear()}`; };
const TIMBRI = [
  { nome: 'PAGATO', testo: () => 'PAGATO IL ' + oggi(), c: '#1c7c54' },
  { nome: 'PAGATO', testo: () => 'PAGATO IL ' + oggi(), c: '#c62828' },
  { nome: 'COPIA CONFORME', testo: () => 'COPIA CONFORME', c: '#1a3fb0' },
  { nome: 'APPROVATO', testo: () => 'APPROVATO', c: '#1c7c54' },
  { nome: 'ANNULLATO', testo: () => 'ANNULLATO', c: '#c62828' },
  { nome: 'RICEVUTO', testo: () => 'RICEVUTO IL ' + oggi(), c: '#1a3fb0' },
  { nome: 'VISTO', testo: () => 'VISTO', c: '#7c3aed' },
];
// pagina al centro dello schermo e punto corrispondente (in coordinate della pagina)
function paginaAttiva() {
  const vb = viewer.getBoundingClientRect(), cx = vb.left + vb.width / 2, cy = vb.top + vb.height / 2;
  let best = null, bd = 1e9;
  for (const r of els.values()) { const b = r.el.getBoundingClientRect(), d = cy < b.top ? b.top - cy : cy > b.bottom ? cy - b.bottom : 0; if (d < bd) { bd = d; best = r; } }
  if (!best) return null;
  const q = new DOMPoint(cx, cy).matrixTransform(best.g.getScreenCTM().inverse());
  return { r: best, x: clamp(q.x, 40, best.p.w - 40), y: clamp(q.y, 30, best.p.h - 30) };
}
function timbroRapido(t) {
  const pa = paginaAttiva(); if (!pa) return;
  const testo = t.testo(), h = 40, w = Math.min(Math.max(120, testo.length * 12.5), pa.r.p.w * 0.6);
  closeSheets(); setTool('mano'); snap('Timbro');
  // se nello stesso punto c'è già un timbro, il nuovo va sotto (non si sovrappongono)
  let y = pa.y - h / 2;
  for (let k = 0; k < 8 && pa.r.p.ann.some(o => o.t === 'stamp' && Math.abs(o.y - y) < h && Math.abs(o.x + o.w / 2 - pa.x) < w); k++) y += h + 14;
  if (y + h > pa.r.p.h) y = pa.y - h / 2;
  const a = { id: nid(), t: 'stamp', x: pa.x - w / 2, y, w, h, text: testo, c: t.c, ang: -8 };
  pa.r.p.ann.push(a); select(pa.r.p.id, a.id);
  toast('Timbro inserito: trascinalo dove serve');
}
function renderTimbri() {
  const box = $('#qsLib'); box.textContent = '';
  for (const t of TIMBRI) {
    const b = document.createElement('button'); b.className = 'qs'; b.style.color = t.c; b.onclick = () => timbroRapido(t);
    const s1 = document.createElement('span'); s1.textContent = t.testo(); b.append(s1); box.append(b);
  }
}
// pulsanti a scelta singola (colore timbro, colore e spessore firma)
function seg(id, on) { $$('#' + id + ' button').forEach(b => b.onclick = () => { $$('#' + id + ' button').forEach(x => x.setAttribute('aria-pressed', x === b)); on(b); }); }
const segVal = (id, k) => { const b = $('#' + id + ' button[aria-pressed="true"]'); return b ? b.dataset[k] : null; };
seg('csCol', () => { });
$('#csAdd').onclick = () => {
  let t = $('#csText').value.trim().toUpperCase(); if (!t) { $('#csText').focus(); return toast('Scrivi il testo del timbro'); }
  if ($('#csDate').checked) t += ' ' + oggi();
  try { localStorage.setItem('editorpdf.timbroTesto', $('#csText').value.trim()); } catch { }
  timbroRapido({ testo: () => t, c: segVal('csCol', 'c') || '#c62828' });
};
$('#csText').addEventListener('keydown', e => { if (e.key === 'Enter') $('#csAdd').click(); });

function usaImg(it, kind) {
  S.assets[it.id] = it.d; S.pending = { asset: it.id, ratio: it.h / it.w, kind };
  closeSheets(); setTool('place');
  toast(kind === 'firme' ? 'Tocca il punto della pagina dove mettere la firma' : kind === 'immagine' ? 'Tocca il punto della pagina dove mettere l’immagine' : 'Tocca il punto della pagina dove mettere il timbro', 3500, 'info');
}
function placeImg(r, x, y) {
  const pd = S.pending, w = Math.min(pd.kind === 'firme' ? 150 : pd.kind === 'immagine' ? r.p.w * 0.5 : 130, r.p.w * (pd.kind === 'immagine' ? 0.8 : 0.45)), h = w * pd.ratio;
  snap(pd.kind === 'firme' ? 'Firma' : pd.kind === 'immagine' ? 'Immagine' : 'Timbro'); const a = { id: nid(), t: 'img', asset: pd.asset, x: x - w / 2, y: y - h / 2, w, h };
  r.p.ann.push(a); S.pending = null; setTool('mano'); select(r.p.id, a.id);
}
// tavoletta firma: tratti levigati (curve tra i punti medi), colore e spessore a scelta, «togli ultimo tratto»
const pad = $('#sigpad'), pctx = pad.getContext('2d'); let padDown = false, tratti = [], tratto = null, padK = 1;
const sigStyle = () => ({ c: segVal('sigCol', 'c') || '#10226b', w: parseFloat(segVal('sigW', 'w') || 2.6) });
function padReset() { const b = pad.getBoundingClientRect(); padK = Math.min(window.devicePixelRatio || 1, 2); pad.width = Math.max(300, b.width * padK); pad.height = 200 * padK; tratti = []; padDraw(); }
function padDraw() {
  pctx.clearRect(0, 0, pad.width, pad.height);
  // riga guida
  pctx.save(); pctx.strokeStyle = '#d5d9ea'; pctx.lineWidth = 1 * padK; pctx.setLineDash([6 * padK, 5 * padK]); pctx.beginPath(); pctx.moveTo(18 * padK, pad.height * 0.74); pctx.lineTo(pad.width - 18 * padK, pad.height * 0.74); pctx.stroke(); pctx.restore();
  const { c, w } = sigStyle(); pctx.strokeStyle = c; pctx.lineWidth = w * padK; pctx.lineCap = 'round'; pctx.lineJoin = 'round';
  for (const t of tratti) {
    pctx.beginPath(); pctx.moveTo(t[0][0], t[0][1]);
    if (t.length < 3) { const l = t[t.length - 1]; pctx.lineTo(l[0] + .1, l[1] + .1); }
    for (let i = 1; i < t.length - 1; i++) { const mx = (t[i][0] + t[i + 1][0]) / 2, my = (t[i][1] + t[i + 1][1]) / 2; pctx.quadraticCurveTo(t[i][0], t[i][1], mx, my); }
    if (t.length >= 3) { const l = t[t.length - 1]; pctx.lineTo(l[0], l[1]); }
    pctx.stroke();
  }
}
const padPt = e => { const b = pad.getBoundingClientRect(); return [(e.clientX - b.left) * pad.width / b.width, (e.clientY - b.top) * pad.height / b.height]; };
pad.addEventListener('pointerdown', e => { padDown = true; pad.setPointerCapture(e.pointerId); tratto = [padPt(e)]; tratti.push(tratto); padDraw(); e.preventDefault(); });
pad.addEventListener('pointermove', e => { if (!padDown) return; const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]; for (const ev of evs) tratto.push(padPt(ev)); padDraw(); });
pad.addEventListener('pointerup', () => { padDown = false; }); pad.addEventListener('pointercancel', () => { padDown = false; });
seg('sigCol', padDraw); seg('sigW', padDraw);
$('#sigClr').onclick = padReset;
$('#sigBack').onclick = () => { tratti.pop(); padDraw(); };
$('#sigOk').onclick = () => {
  if (!tratti.length) return toast('Disegna prima la firma nel riquadro');
  if (store.get('firme').length >= MAX_FIRME && !window.confirm('Hai già ' + MAX_FIRME + ' firme salvate. Uso questa firma solo per ora, senza salvarla?\n(Per salvarla, elimina prima una di quelle esistenti col cestino.)')) return;
  // ritaglio sui soli tratti (senza la riga guida)
  const g = pctx; pctx.clearRect(0, 0, pad.width, pad.height);
  const { c: col, w } = sigStyle(); pctx.strokeStyle = col; pctx.lineWidth = w * padK; pctx.lineCap = 'round'; pctx.lineJoin = 'round';
  for (const t of tratti) { pctx.beginPath(); pctx.moveTo(t[0][0], t[0][1]); if (t.length < 3) { const l = t[t.length - 1]; pctx.lineTo(l[0] + .1, l[1] + .1); } for (let i = 1; i < t.length - 1; i++) pctx.quadraticCurveTo(t[i][0], t[i][1], (t[i][0] + t[i + 1][0]) / 2, (t[i][1] + t[i + 1][1]) / 2); if (t.length >= 3) pctx.lineTo(t[t.length - 1][0], t[t.length - 1][1]); pctx.stroke(); }
  const d = g.getImageData(0, 0, pad.width, pad.height).data; let x0 = pad.width, y0 = pad.height, x1 = 0, y1 = 0;
  for (let y = 0; y < pad.height; y++) for (let x = 0; x < pad.width; x++) if (d[(y * pad.width + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const m = 6; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(pad.width, x1 + m); y1 = Math.min(pad.height, y1 + m);
  const c = document.createElement('canvas'); c.width = x1 - x0; c.height = y1 - y0; c.getContext('2d').drawImage(pad, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  padDraw();
  const it = { id: 'f' + Date.now().toString(36), d: c.toDataURL('image/png'), w: c.width, h: c.height };
  if (store.get('firme').length < MAX_FIRME) store.set('firme', [...store.get('firme'), it]);
  usaImg(it, 'firme');
};
$('#bSign').onclick = () => { renderLib('firme', 'sigLib'); openSheet('shSign'); padReset(); };
$('#bStamp').onclick = () => { renderTimbri(); renderLib('timbri', 'stLib'); try { $('#csText').value = localStorage.getItem('editorpdf.timbroTesto') || ''; } catch { } openSheet('shStamp'); };
$('#bImg').onclick = () => { imgMode = 'immagine'; $('#fImg').click(); };
$('#stAdd').onclick = () => { imgMode = 'timbri'; $('#fImg').click(); };
$('#sigImp').onclick = () => { imgMode = 'firme'; $('#fImg').click(); };
let imgMode = 'timbri';
// sfondo chiaro → trasparente (firme fotografate su carta, timbri scansionati)
function trasparente(c) {
  const cx = c.getContext('2d'), im = cx.getImageData(0, 0, c.width, c.height), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (l > 225) d[i + 3] = 0; else if (l > 175) d[i + 3] = Math.round(d[i + 3] * (225 - l) / 50);
  }
  cx.putImageData(im, 0, 0);
}
$('#fImg').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const kind = imgMode;
  try {
    const im = await new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = URL.createObjectURL(f); });
    const lato = kind === 'immagine' ? 1800 : 900, k = Math.min(1, lato / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement('canvas');
    c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    URL.revokeObjectURL(im.src);
    const trasp = kind === 'firme' || (kind === 'timbri' && $('#stTrasp').checked);
    if (trasp) trasparente(c);
    const jpg = !trasp && /jpe?g/i.test(f.type);
    const it = { id: (kind === 'firme' ? 'f' : kind === 'immagine' ? 'i' : 't') + Date.now().toString(36), d: jpg ? c.toDataURL('image/jpeg', .9) : c.toDataURL('image/png'), w: c.width, h: c.height };
    if (kind === 'timbri') store.set('timbri', [...store.get('timbri'), it]);
    else if (kind === 'firme' && store.get('firme').length < MAX_FIRME) store.set('firme', [...store.get('firme'), it]);
    usaImg(it, kind);
  } catch { toast('Non riesco a leggere questa immagine: prova con un file JPG o PNG'); }
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
      el.onchange = () => { snap("Compila modulo"); src.form[name] = el.value; };
    } else if (a.fieldType === 'Btn' && a.checkBox) {
      el = document.createElement('input'); el.type = 'checkbox';
      el.checked = cur != null ? !!cur : (a.fieldValue != null && a.fieldValue !== 'Off' && a.fieldValue === a.exportValue);
      el.onchange = () => { snap("Compila modulo"); src.form[name] = el.checked; };
    } else if (a.fieldType === 'Btn' && a.radioButton) {
      el = document.createElement('input'); el.type = 'radio'; el.name = 'rf' + p.src + '_' + name; el.value = a.buttonValue;
      el.checked = cur != null ? cur === a.buttonValue : a.fieldValue === a.buttonValue;
      el.onchange = () => { snap("Compila modulo"); src.form[name] = a.buttonValue; };
    } else if (a.fieldType === 'Ch' && a.options) {
      el = document.createElement('select'); if (a.combo) el.append(new Option('', ''));
      for (const o of a.options) el.append(new Option(o.displayValue, o.exportValue));
      const fv = Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue; el.value = cur != null ? cur : (fv || '');
      el.onchange = () => { snap("Compila modulo"); src.form[name] = el.value; };
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

// --- matrici PDF [a b c d e f]: mm(a,b) = prima a, poi b
const mm = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const covers = p => p.ann.filter(a => a.t === 'cover');
const hitBox = (b, c) => Math.min(b[2], c[2]) - Math.max(b[0], c[0]) > 0 && Math.min(b[3], c[3]) - Math.max(b[1], c[1]) > 0;
// riquadro della copertura nello spazio del PDF
function userBox(bvp, a, m = 1) {
  const pts = [[a.x, a.y], [a.x + a.w, a.y], [a.x, a.y + a.h], [a.x + a.w, a.y + a.h]].map(q => bvp.convertToPdfPoint(q[0], q[1]));
  return [Math.min(...pts.map(q => q[0])) - m, Math.min(...pts.map(q => q[1])) - m, Math.max(...pts.map(q => q[0])) + m, Math.max(...pts.map(q => q[1])) + m];
}

// Stringhe del contenuto PDF → byte (codici dei caratteri)
function strBytes(t) {
  const out = [];
  if (t[0] === '<') { const h = t.slice(1, -1).replace(/[^0-9a-fA-F]/g, ''); for (let k = 0; k < h.length; k += 2) out.push(parseInt((h[k] + (h[k + 1] || '0')), 16)); return out; }
  const E = { n: 10, r: 13, t: 9, b: 8, f: 12 };
  for (let k = 1; k < t.length - 1; k++) {
    let c = t[k];
    if (c !== '\\') { out.push(c.charCodeAt(0) & 255); continue; }
    c = t[++k];
    if (c in E) out.push(E[c]);
    else if (c >= '0' && c <= '7') { let o = c; while (o.length < 3 && t[k + 1] >= '0' && t[k + 1] <= '7') o += t[++k]; out.push(parseInt(o, 8) & 255); }
    else if (c === '\r') { if (t[k + 1] === '\n') k++; }
    else if (c === '\n') { }
    else out.push(c.charCodeAt(0) & 255);
  }
  return out;
}
const hexStr = b => '<' + b.map(v => v.toString(16).padStart(2, '0')).join('') + '>';
const num = v => { const s = (Math.round(v * 1000) / 1000).toString(); return s.includes('e') ? '0' : s; };

// Toglie dal contenuto della pagina le lettere che stanno dentro i riquadri coperti (lettera per lettera:
// se il riquadro copre metà riga, l'altra metà resta). Senza le larghezze del carattere (fontInfo) toglie solo
// le scritte interamente lontane dal bordo; se una scritta a larghezza ignota tocca un riquadro, si ferma (la pagina diventa immagine).
// Restituisce il nuovo contenuto e quante scritte ha modificato.
// Con «onRun» riporta anche, per ogni scritta, il riquadro di ogni lettera (serve al tocco di «Cancella»).
function pulisci(src, boxes, isImage = () => false, fontInfo = () => null, onRun = null) {
  const n = src.length, WS = ' \t\r\n\f\0', DL = '()<>[]{}/%';
  let i = 0, ops = [], ctm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0], tm = tlm;
  let ts = { f: null, fs: 0, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
  const st = [], cuts = [], tolte = new Set(), tenute = new Set(); let bi = -1;
  const dentro = () => { const q = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]]); const b = [Math.min(...q.map(v => v[0])), Math.min(...q.map(v => v[1])), Math.max(...q.map(v => v[0])), Math.max(...q.map(v => v[1]))]; return boxes.some(c => b[0] >= c[0] && b[1] >= c[1] && b[2] <= c[2] && b[3] <= c[3]); };
  const inBox = (x, y) => boxes.some(b => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]);
  const skipStr = () => { let d = 1; i++; while (i < n && d) { const c = src[i]; if (c === '\\') i += 2; else { if (c === '(') d++; else if (c === ')') d--; i++; } } };
  const nums = k => ops.slice(-k).map(o => o.v || 0);
  const nextLine = () => { tlm = mm([1, 0, 0, 1, 0, -ts.tl], tlm); tm = tlm; };
  // els: elementi della scritta (stringhe come testo grezzo, numeri dei TJ); s..e: posizione nel contenuto; pre: operatori da tenere
  const show = (els, s, e, pre) => {
    const M = mm(tm, ctm), fi = ts.f != null ? fontInfo(ts.f) : null, fs = ts.fs, th = ts.th;
    const at = (u, v) => [u * M[0] + v * M[2] + M[4], u * M[1] + v * M[3] + M[5]];
    if (!fi || !fs || !th) {
      // larghezze ignote: se la scritta parte vicino a un riquadro non posso sapere fin dove arriva
      const o = at(0, 0), r = Math.abs(fs) * Math.hypot(M[2], M[3]) * 1.5 + 2;
      if (boxes.some(b => o[1] >= b[1] - r && o[1] <= b[3] + r && o[0] <= b[2] + r)) throw new Error('larghezze del carattere non disponibili');
      return;
    }
    const parts = []; let cur = 0, nIn = 0, nOut = 0;
    for (const el of els) {
      if (typeof el === 'number') { const d = -el / 1000 * fs * th; parts.push({ gap: d }); cur += d; continue; }
      const b = strBytes(el), L = fi.two ? 2 : 1;
      for (let k = 0; k + L <= b.length; k += L) {
        const code = L === 2 ? b[k] << 8 | b[k + 1] : b[k], w0 = fi.w(code);
        const adv = (w0 / 1000 * fs + ts.tc + (L === 1 && code === 32 ? ts.tw : 0)) * th;
        const gw = w0 / 1000 * fs * th, c = at(cur + gw / 2, ts.rise + fs * 0.3), via = inBox(c[0], c[1]);
        via ? nIn++ : nOut++;
        parts.push({ bytes: b.slice(k, k + L), adv, via, u: cur, gw }); cur += adv;
      }
    }
    tm = mm([1, 0, 0, 1, cur, 0], tm);
    if (onRun) onRun(parts.filter(p => p.gap == null).map(p => { const q = [at(p.u, ts.rise - fs * 0.32), at(p.u + p.gw, ts.rise - fs * 0.32), at(p.u, ts.rise + fs * 0.98), at(p.u + p.gw, ts.rise + fs * 0.98)]; return [Math.min(...q.map(v => v[0])), Math.min(...q.map(v => v[1])), Math.max(...q.map(v => v[0])), Math.max(...q.map(v => v[1]))]; }), Math.abs(fs * Math.hypot(M[2], M[3])));
    if (!nIn) return;
    if (!nOut) { cuts.push([s, e, pre]); return; }
    // metà dentro e metà fuori: riscrivo la scritta come TJ, con uno spazio vuoto al posto delle lettere tolte
    const arr = [], tj = g => num(-g * 1000 / (fs * th)); let buf = [], gap = 0;
    for (const p of parts) {
      if (p.gap != null || p.via) { gap += p.gap != null ? p.gap : p.adv; continue; }
      if (gap) { if (buf.length) { arr.push(hexStr(buf)); buf = []; } arr.push(tj(gap)); gap = 0; }
      buf.push(...p.bytes);
    }
    if (buf.length) arr.push(hexStr(buf)); if (gap) arr.push(tj(gap));
    cuts.push([s, e, (pre ? pre + ' ' : '') + '[' + arr.join(' ') + '] TJ']);
  };
  const arrEls = (a, b) => { // elementi di un array TJ
    const out = []; let k = a + 1;
    while (k < b - 1) {
      const c = src[k];
      if (WS.includes(c)) { k++; continue; }
      if (c === '(') { const s0 = k; let d = 1; k++; while (k < b && d) { const ch = src[k]; if (ch === '\\') k += 2; else { if (ch === '(') d++; else if (ch === ')') d--; k++; } } out.push(src.slice(s0, k)); continue; }
      if (c === '<') { const e = src.indexOf('>', k); out.push(src.slice(k, e + 1)); k = e + 1; continue; }
      const s0 = k; while (k < b - 1 && !WS.includes(src[k]) && !DL.includes(src[k])) k++;
      const v = parseFloat(src.slice(s0, k)); if (!isNaN(v)) out.push(v); else if (k === s0) k++;
    }
    return out;
  };
  while (i < n) {
    while (i < n && WS.includes(src[i])) i++;
    if (i >= n) break;
    const c = src[i], start = i;
    if (c === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
    if (c === '(') { skipStr(); ops.push({ s: start, e: i, str: true }); continue; }
    if (c === '<' && src[i + 1] === '<') { let d = 0; do { if (src.startsWith('<<', i)) { d++; i += 2; } else if (src.startsWith('>>', i)) { d--; i += 2; } else if (src[i] === '(') skipStr(); else i++; } while (d && i < n); ops.push({ s: start }); continue; }
    if (c === '<') { const e = src.indexOf('>', i); i = e < 0 ? n : e + 1; ops.push({ s: start, e: i, str: true }); continue; }
    if (c === '[') { let d = 0; do { const ch = src[i]; if (ch === '(') skipStr(); else if (ch === '<' && src[i + 1] !== '<') { const e = src.indexOf('>', i); i = e < 0 ? n : e + 1; } else { if (ch === '[') d++; else if (ch === ']') d--; i++; } } while (d && i < n); ops.push({ s: start, e: i, arr: true }); continue; }
    if (c === '/') { i++; while (i < n && !WS.includes(src[i]) && !DL.includes(src[i])) i++; ops.push({ s: start, name: src.slice(start + 1, i) }); continue; }
    if (DL.includes(c)) { i++; continue; }
    while (i < n && !WS.includes(src[i]) && !DL.includes(src[i])) i++;
    const tok = src.slice(start, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) { ops.push({ s: start, v: parseFloat(tok) }); continue; }
    const last = ops[ops.length - 1];
    switch (tok) {
      case 'q': st.push([ctm, { ...ts }]); break;
      case 'Q': { const t = st.pop(); if (t) { ctm = t[0]; ts = t[1]; } break; }
      case 'cm': ctm = mm(nums(6), ctm); break;
      case 'BT': tlm = tm = [1, 0, 0, 1, 0, 0]; break;
      case 'Td': { const [x, y] = nums(2); tlm = mm([1, 0, 0, 1, x, y], tlm); tm = tlm; break; }
      case 'TD': { const [x, y] = nums(2); ts.tl = -y; tlm = mm([1, 0, 0, 1, x, y], tlm); tm = tlm; break; }
      case 'TL': ts.tl = nums(1)[0]; break;
      case 'Tc': ts.tc = nums(1)[0]; break;
      case 'Tw': ts.tw = nums(1)[0]; break;
      case 'Tz': ts.th = nums(1)[0] / 100; break;
      case 'Ts': ts.rise = nums(1)[0]; break;
      case 'Tf': if (ops.length >= 2 && ops[ops.length - 2].name != null) { ts.f = ops[ops.length - 2].name; ts.fs = nums(1)[0]; } break;
      case 'Tm': tlm = tm = nums(6); break;
      case 'T*': nextLine(); break;
      case 'Tj': if (last && last.str) show([src.slice(last.s, last.e)], last.s, i, ''); break;
      case 'TJ': if (last && last.arr) show(arrEls(last.s, last.e), last.s, i, ''); break;
      case "'": nextLine(); if (last && last.str) show([src.slice(last.s, last.e)], last.s, i, 'T*'); break;
      case '"': { if (ops.length >= 3 && last && last.str) { const [aw, ac] = nums(3); ts.tw = aw; ts.tc = ac; nextLine(); show([src.slice(last.s, last.e)], ops[ops.length - 3].s, i, `${aw} Tw ${ac} Tc T*`); } break; }
      case 'BI': bi = start; break;
      case 'ID': { const m = /[\s]EI(?=[\s]|$)/g; m.lastIndex = i; const r = m.exec(src); i = r ? r.index + 3 : n; if (bi >= 0 && dentro()) cuts.push([bi, i, '']); bi = -1; break; }
      case 'Do': { const o = last; if (o && o.name != null && isImage(o.name)) { if (dentro()) { cuts.push([o.s, i, '']); tolte.add(o.name); } else tenute.add(o.name); } break; }
    }
    ops = [];
  }
  cuts.sort((a, b) => a[0] - b[0]);
  for (let k = cuts.length - 1; k >= 0; k--) { const [s, e, rep] = cuts[k]; src = src.slice(0, s) + rep + ' '.repeat(Math.max(0, e - s - rep.length)) + src.slice(e); }
  return { s: src, n: cuts.length, immagini: [...tolte].filter(x => !tenute.has(x)) };
}
const latin1 = u => { let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return s; };
const unlatin1 = s => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };

function contentRefs(node) {
  const L = window.PDFLib, c = node.get(L.PDFName.of('Contents')); if (!c) return { refs: [], extra: null };
  const o = c instanceof L.PDFRef ? node.context.lookup(c) : c;
  if (o instanceof L.PDFArray) return { refs: o.asArray().filter(r => r instanceof L.PDFRef), extra: c instanceof L.PDFRef ? c : null };
  return { refs: c instanceof L.PDFRef ? [c] : [], extra: null };
}
// Svuota una pagina che non finisce nel file (eliminata o sostituita da un'immagine), così il suo contenuto non resta nascosto nel PDF
function svuota(node) {
  const L = window.PDFLib, { refs, extra } = contentRefs(node);
  refs.forEach(r => node.context.delete(r)); if (extra) node.context.delete(extra);
  for (const k of ['Contents', 'Resources', 'Annots', 'Thumb']) node.delete(L.PDFName.of(k));
}
// Larghezze dei caratteri di un font della pagina (in millesimi di corpo), per sapere dove sta ogni lettera.
// null se non si possono conoscere: in quel caso pulisci() non taglia le scritte a metà.
const STD14 = { helvetica: 'Helvetica', arial: 'Helvetica', arialmt: 'Helvetica', times: 'Times-Roman', timesroman: 'Times-Roman', timesnewroman: 'Times-Roman', timesnewromanps: 'Times-Roman', timesnewromanpsmt: 'Times-Roman', courier: 'Courier', couriernew: 'Courier', couriernewpsmt: 'Courier', symbol: 'Symbol', zapfdingbats: 'ZapfDingbats' };
function fontInfoDa(res) {
  const L = window.PDFLib, N = L.PDFName.of, cache = new Map();
  const fonts = res ? res.lookup(N('Font')) : null;
  const numero = o => (o && o.asNumber ? o.asNumber() : null);
  const leggi = name => {
    const f = fonts instanceof L.PDFDict ? fonts.lookup(N(name)) : null; if (!(f instanceof L.PDFDict)) return null;
    const sub = f.lookup(N('Subtype')), sname = sub instanceof L.PDFName ? sub.asString() : '';
    if (sname === '/Type0') {
      const enc = f.lookup(N('Encoding')); if (!(enc instanceof L.PDFName) || enc.asString() !== '/Identity-H') return null;
      const df = f.lookup(N('DescendantFonts')), d = df instanceof L.PDFArray ? df.lookup(0) : null; if (!(d instanceof L.PDFDict)) return null;
      const dw = numero(d.lookup(N('DW'))) ?? 1000, W = d.lookup(N('W')), m = new Map(), rng = [];
      if (W instanceof L.PDFArray) {
        const v = W.asArray().map(x => (x instanceof L.PDFRef ? d.context.lookup(x) : x));
        for (let k = 0; k < v.length;) {
          const c0 = numero(v[k]);
          if (v[k + 1] instanceof L.PDFArray) { v[k + 1].asArray().forEach((x, j) => m.set(c0 + j, numero(d.context.lookup(x) || x) ?? dw)); k += 2; }
          else { rng.push([c0, numero(v[k + 1]), numero(v[k + 2])]); k += 3; }
        }
      }
      return { two: true, w: c => m.has(c) ? m.get(c) : (rng.find(r => c >= r[0] && c <= r[1]) || [0, 0, dw])[2] };
    }
    const fm = sname === '/Type3' ? f.lookup(N('FontMatrix')) : null, k3 = fm instanceof L.PDFArray ? (numero(fm.lookup(0)) || 0.001) * 1000 : 1;
    const ws = f.lookup(N('Widths')), fc = numero(f.lookup(N('FirstChar'))) ?? 0;
    if (ws instanceof L.PDFArray) {
      const fd = f.lookup(N('FontDescriptor')), miss = fd instanceof L.PDFDict ? numero(fd.lookup(N('MissingWidth'))) ?? 0 : 0;
      const v = ws.asArray().map(x => numero(x instanceof L.PDFRef ? f.context.lookup(x) : x));
      return { two: false, w: c => (v[c - fc] ?? miss) * k3 };
    }
    // i 14 font standard possono non avere le larghezze nel file: le prendo da pdf-lib
    const bf = f.lookup(N('BaseFont')), base = bf instanceof L.PDFName ? bf.asString().slice(1).replace(/^[A-Z]{6}\+/, '') : '';
    const [fam, sty = ''] = base.split(/[-,]/), std = STD14[fam.toLowerCase().replace(/\s/g, '')]; if (!std || sname === '/Type3') return null;
    const b = /bold/i.test(sty), it = /italic|oblique/i.test(sty);
    const nome = std === 'Helvetica' ? 'Helvetica' + (b && it ? '-BoldOblique' : b ? '-Bold' : it ? '-Oblique' : '') : std === 'Times-Roman' ? (b && it ? 'Times-BoldItalic' : b ? 'Times-Bold' : it ? 'Times-Italic' : 'Times-Roman') : std === 'Courier' ? 'Courier' + (b && it ? '-BoldOblique' : b ? '-Bold' : it ? '-Oblique' : '') : std;
    const emb = L.StandardFontEmbedder.for(nome), mw = new Map();
    return { two: false, w: c => { if (!mw.has(c)) { let w = null; try { w = emb.widthOfTextAtSize(String.fromCharCode(c), 1000); } catch { } mw.set(c, w ?? 500); } return mw.get(c); } };
  };
  return name => { if (!cache.has(name)) { let v = null; try { v = leggi(name); } catch (e) { console.warn('font', name, e); } cache.set(name, v); } return cache.get(name); };
}
function contenuto(node, refs = contentRefs(node).refs) {
  const L = window.PDFLib; let s = '';
  for (const r of refs) { const st = node.context.lookup(r); if (!(st instanceof L.PDFRawStream)) throw new Error('contenuto non leggibile'); s += latin1(L.decodePDFRawStream(st).decode()) + '\n'; }
  return s;
}
// Le scritte della pagina come le ha messe chi ha creato il PDF (ogni «campo» è una scritta), con il riquadro di ogni lettera
// in coordinate dello schermo a scala 1. Le scritte con spazi molto larghi in mezzo vengono divise in pezzi.
async function scritte(p) {
  const src = S.sources[p.src]; src.sc = src.sc || {}; if (src.sc[p.idx]) return src.sc[p.idx];
  const L = window.PDFLib;
  if (!src.lib) src.lib = PDFDocument.load(src.bytes, { updateMetadata: false });
  const doc = await src.lib, node = doc.getPages()[p.idx].node, res = node.Resources();
  const vp = (await src.pdf.getPage(p.idx + 1)).getViewport({ scale: 1 }), out = [];
  pulisci(contenuto(node), [], () => false, fontInfoDa(res), (gl, fh) => {
    const v = gl.map(b => { const q = [vp.convertToViewportPoint(b[0], b[1]), vp.convertToViewportPoint(b[2], b[3])]; return [Math.min(q[0][0], q[1][0]), Math.min(q[0][1], q[1][1]), Math.max(q[0][0], q[1][0]), Math.max(q[0][1], q[1][1])]; });
    let pezzo = null;
    for (const b of v) {
      if (b[2] - b[0] < 0.01) continue;
      if (pezzo && b[0] - pezzo[2] < fh * 0.9 && b[0] > pezzo[0] - 1) { pezzo[2] = Math.max(pezzo[2], b[2]); pezzo[1] = Math.min(pezzo[1], b[1]); pezzo[3] = Math.max(pezzo[3], b[3]); }
      else { if (pezzo) out.push(pezzo); pezzo = b.slice(); }
    }
    if (pezzo) out.push(pezzo);
  });
  return (src.sc[p.idx] = out);
}
// Cancella dalla pagina il testo e le annotazioni che stanno sotto le coperture
function cancellaSotto(node, boxes) {
  const L = window.PDFLib, ctx = node.context, { refs, extra } = contentRefs(node);
  if (refs.length) {
    const s = contenuto(node, refs);
    if (s.includes('/ActualText')) throw new Error('testo alternativo presente');
    const N = L.PDFName.of, res = node.Resources(), xo = res ? res.lookup(N('XObject')) : null;
    const isImage = name => { try { const o = xo instanceof L.PDFDict ? xo.lookup(N(name)) : null; return o instanceof L.PDFStream && o.dict.lookup(N('Subtype')) === N('Image'); } catch { return false; } };
    const r = pulisci(s, boxes, isImage, fontInfoDa(res));
    if (r.n) { node.set(N('Contents'), ctx.register(ctx.flateStream(unlatin1(r.s)))); refs.forEach(x => ctx.delete(x)); if (extra) ctx.delete(extra); }
    if (r.immagini.length) { // le immagini cancellate vanno tolte anche dall'elenco delle risorse della pagina (copiato, perché può essere condiviso con altre pagine)
      const res2 = ctx.obj({}), xo2 = ctx.obj({});
      for (const [k, v] of res.entries()) res2.set(k, v);
      for (const [k, v] of xo.entries()) if (!r.immagini.some(nm => N(nm) === k)) xo2.set(k, v);
      res2.set(N('XObject'), xo2); node.set(N('Resources'), res2);
    }
  }
  const an = node.Annots();
  if (an) for (let k = an.size() - 1; k >= 0; k--) {
    const d = an.lookup(k), rc = d instanceof L.PDFDict ? d.lookup(L.PDFName.of('Rect')) : null;
    if (rc instanceof L.PDFArray && rc.size() === 4) { const v = rc.asArray().map(x => (x.asNumber ? x.asNumber() : 0)); const b = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])]; if (boxes.some(c => hitBox(b, c))) an.remove(k); }
  }
}
// Elimina dal file gli oggetti non più collegati a nulla (pagine tolte, immagini e scritte sostituite)
function ripulisci(doc) {
  const L = window.PDFLib, ctx = doc.context, seen = new Set(), stack = [];
  const push = o => { if (o instanceof L.PDFRef) { if (!seen.has(o.tag)) { seen.add(o.tag); const t = ctx.lookup(o); if (t) stack.push(t); } } else if (o) stack.push(o); };
  for (const k of ['Root', 'Info', 'Encrypt']) if (ctx.trailerInfo[k]) push(ctx.trailerInfo[k]);
  while (stack.length) {
    const o = stack.pop();
    if (o instanceof L.PDFDict) for (const [, v] of o.entries()) push(v);
    else if (o instanceof L.PDFArray) for (const v of o.asArray()) push(v);
    else if (o instanceof L.PDFStream) for (const [, v] of o.dict.entries()) push(v);
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}
function compila(doc, vals, appiattisci) {
  const keys = Object.keys(vals || {}); if (!keys.length) return;
  const L = window.PDFLib, form = doc.getForm();
  for (const k of keys) {
    const v = vals[k];
    try {
      const f = form.getField(k);
      if (f instanceof L.PDFTextField) f.setText(v ? String(v).replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff€’‘“”–—…•]/g, '?') : '');
      else if (f instanceof L.PDFCheckBox) v ? f.check() : f.uncheck();
      else if (f instanceof L.PDFRadioGroup) f.select(String(v));
      else if (f instanceof L.PDFDropdown || f instanceof L.PDFOptionList) v ? f.select(String(v)) : f.clear();
    } catch (e) { console.warn('campo', k, e); }
  }
  if (appiattisci) { try { form.flatten(); } catch (e) { console.warn(e); try { form.updateFieldAppearances(); } catch { } } }
}
const haCampi = doc => { try { const af = doc.catalog.getAcroForm(); return !!af && af.getAllFields().length > 0; } catch { return false; } };

// C'è un'immagine che tocca una copertura? Con «tolleraDentro», quelle interamente dentro il riquadro (e non annidate) non contano: verranno tolte dal file.
async function immagineSotto(proxy, boxes, tolleraDentro) {
  const O = pdfjsLib.OPS;
  const IMG = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageMaskXObject, O.paintImageXObjectRepeat, O.paintImageMaskXObjectRepeat, O.paintImageMaskXObjectGroup, O.paintInlineImageXObjectGroup].filter(x => x != null));
  const ol = await proxy.getOperatorList(); let m = [1, 0, 0, 1, 0, 0], depth = 0; const st = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    if (fn === O.save) st.push(m); else if (fn === O.restore) m = st.pop() || m;
    else if (fn === O.transform) m = mm(a, m);
    else if (fn === O.paintFormXObjectBegin) { st.push(m); depth++; if (a && a[0]) m = mm(a[0], m); }
    else if (fn === O.paintFormXObjectEnd) { m = st.pop() || m; depth--; }
    else if (IMG.has(fn)) {
      const q = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]);
      const b = [Math.min(...q.map(v => v[0])), Math.min(...q.map(v => v[1])), Math.max(...q.map(v => v[0])), Math.max(...q.map(v => v[1]))];
      for (const c of boxes) { if (!hitBox(b, c)) continue; if (tolleraDentro && depth === 0 && b[0] >= c[0] && b[1] >= c[1] && b[2] <= c[2] && b[3] <= c[3]) continue; return true; }
    }
  }
  return false;
}
// Pagine in cui una copertura taglia un'immagine (es. scansioni): lì l'unico modo sicuro è rifare la pagina come immagine
async function conImmaginiSotto(pages) {
  const out = [];
  for (const p of pages) {
    const cs = covers(p); if (!cs.length) continue;
    try { const proxy = await S.sources[p.src].pdf.getPage(p.idx + 1), bvp = proxy.getViewport({ scale: 1 }); if (await immagineSotto(proxy, cs.map(a => userBox(bvp, a)), true)) out.push(p.id); }
    catch (e) { console.warn(e); out.push(p.id); }
  }
  return out;
}

async function buildPdf(pages, forza = new Set()) {
  const fonts = {}, sets = {}, libs = new Map(), imgs = {}, riprova = [];
  let raster = 0;
  const used = [...new Set(pages.map(p => p.src))];
  for (const si of used) { let d = null; try { d = await PDFDocument.load(S.sources[si].bytes); } catch (e) { console.warn('pdf-lib non legge il file, salvo come immagini', e); } libs.set(si, d); }
  // il documento «base» resta l'originale (così moduli, segnalibri e proprietà si conservano); gli altri vengono copiati dentro
  let host = used.find(si => libs.get(si) && haCampi(libs.get(si))); if (host === undefined) host = used.find(si => libs.get(si));
  const out = host !== undefined ? libs.get(host) : await PDFDocument.create();
  out.setProducer('ninetto-pdf');
  const orig = new Map();
  for (const si of used) {
    const d = libs.get(si); if (!d) continue;
    const pp = d.getPages(); orig.set(si, pp);
    const tieni = new Set(pages.filter(p => p.src === si && !forza.has(p.id)).map(p => p.idx));
    pp.forEach((pg, i) => { if (!tieni.has(i)) svuota(pg.node); });
    compila(d, S.sources[si].form, si !== host);
  }
  if (host !== undefined) while (out.getPageCount() > 0) out.removePage(0);

  const font = async a => { const k = (a.font || 'H') + (a.bold ? 'B' : ''); if (!fonts[k]) { fonts[k] = await out.embedFont(FONT[k] || FONT.H); sets[k] = new Set(fonts[k].getCharacterSet()); } return [fonts[k], sets[k]]; };
  const ok = (set, s) => [...String(s).replace(/\t/g, '    ')].map(ch => set.has(ch.codePointAt(0)) ? ch : '?').join('');

  let n = 0;
  for (const p of pages) {
    if (pages.length > 3) { progress(n++ / pages.length); if (n % 5 === 0) await pausa(); }
    const src = S.sources[p.src], proxy = await src.pdf.getPage(p.idx + 1), bvp = proxy.getViewport({ scale: 1 });
    const lib = libs.get(p.src), cs = covers(p);
    let page, toPdf;
    if (lib && !forza.has(p.id)) {
      const srcPage = orig.get(p.src)[p.idx];
      if (cs.length) { try { cancellaSotto(srcPage.node, cs.map(a => userBox(bvp, a))); } catch (e) { console.warn('cancellazione non riuscita, rifaccio la pagina come immagine', e); riprova.push(p.id); } }
      if (p.src === host) page = out.addPage(srcPage);
      else { const [cp] = await out.copyPages(lib, [p.idx]); page = out.addPage(cp); }
      page.setRotation(degrees((proxy.rotate + p.rot) % 360));
      toPdf = (x, y) => bvp.convertToPdfPoint(x, y);
    } else {
      raster++;
      let k = 2.5; if (p.w * p.h * k * k > 10e6) k = Math.sqrt(10e6 / (p.w * p.h));
      const vp = proxy.getViewport({ scale: k }), c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      await proxy.render({ canvasContext: cx, viewport: vp }).promise;
      for (const a of cs) { cx.fillStyle = a.bg; cx.fillRect(Math.floor(a.x * k) - 1, Math.floor(a.y * k) - 1, Math.ceil(a.w * k) + 2, Math.ceil(a.h * k) + 2); } // copertura impressa nell'immagine
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', .92)); c.width = 0;
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
    // segmenti in coordinate della pagina (funzionano con qualunque rotazione)
    const seg = (pts, lw, col, chiuso) => {
      for (let i = 1; i < pts.length + (chiuso ? 1 : 0); i++) {
        const s = toPdf(...pts[i - 1]), e = toPdf(...pts[i % pts.length]);
        page.drawLine({ start: { x: s[0], y: s[1] }, end: { x: e[0], y: e[1] }, thickness: lw, color: col, lineCap: LineCapStyle.Round });
      }
    };
    for (const a of p.ann) {
      if (a.t === 'hl' && (a.m === 'u' || a.m === 's')) { const y = hlLineY(a); seg([[a.x, y], [a.x + a.w, y]], hlLineW(a), hexRgb(a.c)); }
      else if (a.t === 'shape') {
        const col = hexRgb(a.c);
        if (a.k === 'rect') seg([[a.x, a.y], [a.x + a.w, a.y], [a.x + a.w, a.y + a.h], [a.x, a.y + a.h]], a.lw, col, true);
        else if (a.k === 'ellipse') { const n = 96, pts = []; for (let i = 0; i < n; i++) { const t = i / n * Math.PI * 2; pts.push([a.x + a.w / 2 + a.w / 2 * Math.cos(t), a.y + a.h / 2 + a.h / 2 * Math.sin(t)]); } seg(pts, a.lw, col, true); }
        else { seg(a.pts, a.lw, col); if (a.k === 'arrow') seg(punta(a), a.lw, col); }
      }
      else if (a.t === 'hl') page.drawRectangle({ ...fr(a.x, a.y + a.h), width: a.w, height: a.h, color: hexRgb(a.c), opacity: .42, blendMode: BlendMode.Multiply });
      else if (a.t === 'ink') {
        const col = hexRgb(a.c);
        for (let i = 1; i < a.pts.length; i++) { const s = toPdf(...a.pts[i - 1]), e = toPdf(...a.pts[i]); page.drawLine({ start: { x: s[0], y: s[1] }, end: { x: e[0], y: e[1] }, thickness: a.lw, color: col, lineCap: LineCapStyle.Round }); }
      } else if (a.t === 'img') {
        const d = S.assets[a.asset]; if (!d) continue;
        if (!imgs[a.asset]) { const bin = Uint8Array.from(atob(d.split(',')[1]), ch => ch.charCodeAt(0)); imgs[a.asset] = d.startsWith('data:image/jpeg') ? await out.embedJpg(bin) : await out.embedPng(bin); }
        page.drawImage(imgs[a.asset], { ...fr(a.x, a.y + a.h), width: a.w, height: a.h });
      } else if (a.t === 'stamp') {
        // stesso disegno dello schermo: cornici e scritta ruotate attorno al centro del timbro
        const cx = a.x + a.w / 2, cy = a.y + a.h / 2, th = a.ang * Math.PI / 180, col = hexRgb(a.c), bw = a.h * 0.07;
        const F = (lx, ly) => { const f = fr(cx + lx * Math.cos(th) - ly * Math.sin(th), cy + lx * Math.sin(th) + ly * Math.cos(th)); return { x: f.x, y: f.y, rotate: degrees(f.rotate.angle - a.ang) }; };
        page.drawRectangle({ ...F(-a.w / 2 + bw / 2, a.h / 2 - bw / 2), width: a.w - bw, height: a.h - bw, borderColor: col, borderWidth: bw, borderOpacity: .85 });
        page.drawRectangle({ ...F(-a.w / 2 + bw * 2, a.h / 2 - bw * 2), width: a.w - bw * 4, height: a.h - bw * 4, borderColor: col, borderWidth: bw * 0.35, borderOpacity: .85 });
        const [f, set] = await font({ font: 'H', bold: true }), t = ok(set, a.text), size = Math.min(a.h * 0.46, a.w * 0.84 / f.widthOfTextAtSize(t, 1)), tw = f.widthOfTextAtSize(t, size);
        page.drawText(t, { ...F(-tw / 2, size * 0.35), size, font: f, color: col, opacity: .85 });
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
  ripulisci(out);
  return { bytes: await out.save(), raster, riprova };
}

// Controllo finale: riapre il PDF prodotto e verifica che sotto le coperture non sia rimasto testo e che fuori non manchi nulla
function voci(tc, vp) {
  const out = [];
  for (const i of tc.items) {
    if (!i.str || !i.str.trim()) continue;
    const m = pdfjsLib.Util.transform(vp.transform, i.transform), fh = Math.hypot(m[2], m[3]);
    out.push({ str: i.str, x: m[4], by: m[5], w: i.width, fh, flat: m[0] > 0 && Math.abs(m[1]) < 0.02 * Math.abs(m[0]) });
  }
  return out;
}
// una lettera tagliata dal bordo del riquadro (con il centro fuori) resta nel file: conta come «sotto» solo una sovrapposizione più larga di mezza lettera
const sotto = (it, a) => it.flat ? (Math.min(it.x + it.w, a.x + a.w) - Math.max(it.x, a.x) > Math.max(1, Math.min(it.w * 0.9, it.fh * 0.5)) && it.by >= a.y - .5 && it.by <= a.y + a.h + .5) : (it.x >= a.x && it.x <= a.x + a.w && it.by >= a.y && it.by <= a.y + a.h);
const nch = list => list.reduce((t, it) => t + it.str.replace(/\s/g, '').length, 0);
async function verifica(bytes, pages, forza) {
  const todo = pages.map((p, i) => [p, i]).filter(([p]) => covers(p).length && !forza.has(p.id)); if (!todo.length) return [];
  const bad = [], doc = await pdfjsLib.getDocument({ data: bytes.slice(), cMapUrl: LIB + 'cmaps/', cMapPacked: true, standardFontDataUrl: LIB + 'standard_fonts/' }).promise;
  try {
    for (const [p, i] of todo) {
      const cs = covers(p), src = S.sources[p.src], po = await src.pdf.getPage(p.idx + 1);
      const prima = voci(await po.getTextContent(), po.getViewport({ scale: 1 })).filter(it => !cs.some(a => sotto(it, a)));
      const pn = await doc.getPage(i + 1), dopoTutte = voci(await pn.getTextContent(), pn.getViewport({ scale: 1, rotation: po.rotate }));
      const mie = [];
      for (const a of p.ann) if (a.text && (a.t === 'cover' || a.t === 'text')) lines(a).forEach((l, k) => mie.push([a.t === 'cover' ? a.tx : a.x, (a.t === 'cover' ? a.by : a.y + a.size * 0.92) + k * a.size * 1.2]));
      const timbri = new Set(p.ann.filter(a => a.t === 'stamp').map(a => a.text));
      const dopo = dopoTutte.filter(it => !timbri.has(it.str) && !mie.some(([x, y]) => Math.abs(it.x - x) < 1.5 && Math.abs(it.by - y) < 1.5));
      const rimasto = dopo.some(it => cs.some(a => sotto(it, a)));
      const fuori = dopo.filter(it => !cs.some(a => sotto(it, a)));
      const bvp = po.getViewport({ scale: 1 }), img = await immagineSotto(pn, cs.map(a => userBox(bvp, a, 0)), false).catch(() => true);
      if (rimasto || img || nch(fuori) < nch(prima)) bad.push(p.id);
    }
  } finally { doc.destroy(); }
  return bad;
}

const outName = suff => (S.name || 'documento').replace(/ - (modificato|estratto)$/i, '') + ' - ' + suff + '.pdf';
async function crea(pages) {
  const forza = new Set(await conImmaginiSotto(pages)); let res;
  for (let giro = 0; giro < 3; giro++) {
    res = await buildPdf(pages, forza);
    const bad = [...res.riprova, ...await verifica(res.bytes, pages, forza)].filter(id => !forza.has(id));
    if (!bad.length) break;
    bad.forEach(id => forza.add(id));
  }
  return { ...res, immagine: forza.size };
}
async function makeFile(pages, suff, nome) {
  busy(true, pages.length > 1 ? 'Preparo il PDF (' + pages.length + ' pagine)…' : 'Preparo il PDF…');
  try {
    await new Promise(r => setTimeout(r, 30));
    const { bytes, raster, immagine } = await crea(pages);
    if (immagine) toast(immagine === 1 ? 'Per cancellare davvero il testo coperto, una pagina è stata salvata come immagine' : 'Per cancellare davvero il testo coperto, ' + immagine + ' pagine sono state salvate come immagine', 6000, 'warn');
    else if (raster) toast('Non sono riuscito a sbloccare il PDF: le pagine sono state salvate come immagini', 6000, 'warn');
    return new File([bytes], nome || outName(suff), { type: 'application/pdf' });
  } catch (e) { console.error(e); toast('Non sono riuscito a creare il PDF: ' + (e.message || e), 6000); return null; }
  finally { busy(false); }
}
function download(file) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function save(nome) {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const f = await makeFile(S.pages, 'modificato', nome); if (!f) return;
  download(f); S.dirty = false; ui(); toast('Salvato come «' + f.name + '» · ' + kb(f.size));
}
function saveAs() {
  $('#nmVal').value = outName('modificato').replace(/\.pdf$/i, ''); openSheet('shName');
  setTimeout(() => { $('#nmVal').focus(); $('#nmVal').select(); }, 60);
}
$('#nmOk').onclick = () => {
  const n = $('#nmVal').value.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\.pdf$/i, '');
  if (!n) { $('#nmVal').focus(); return toast('Scrivi un nome per il file'); }
  closeSheets(); save(n + '.pdf');
};
$('#nmVal').addEventListener('keydown', e => { if (e.key === 'Enter') $('#nmOk').click(); });
// Stampa il documento come verrebbe salvato (con aggiunte e cancellazioni).
// Sul PC il PDF va al visualizzatore del browser (testo nitido); sul telefono, dove un PDF non si può stampare
// da una pagina web, le pagine vengono preparate come immagini ad alta risoluzione (circa 200 dpi) e stampate dalla pagina stessa.
async function stampa() {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const f = await makeFile(S.pages, 'modificato'); if (!f) return;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  if (!mobile) {
    const old = $('#printFrame'); if (old) { URL.revokeObjectURL(old.src); old.remove(); }
    const fr = document.createElement('iframe'); fr.id = 'printFrame';
    fr.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0';
    fr.src = URL.createObjectURL(f);
    fr.onload = () => setTimeout(() => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (e) { console.warn(e); window.open(fr.src, '_blank'); } }, 300);
    document.body.append(fr);
    return;
  }
  busy(true, 'Preparo la stampa…');
  let doc = null;
  try {
    doc = await pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()), cMapUrl: LIB + 'cmaps/', cMapPacked: true, standardFontDataUrl: LIB + 'standard_fonts/' }).promise;
    let box = $('#stampa'); if (!box) { box = document.createElement('div'); box.id = 'stampa'; document.body.append(box); }
    box.textContent = '';
    let pagina = null;
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i), v1 = pg.getViewport({ scale: 1 });
      if (!pagina) pagina = v1;
      let k = 200 / 72; if (v1.width * v1.height * k * k > 16e6) k = Math.sqrt(16e6 / (v1.width * v1.height));
      const vp = pg.getViewport({ scale: k }), c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      await pg.render({ canvasContext: cx, viewport: vp }).promise;
      const blob = await new Promise(r => c.toBlob(r, 'image/png')); c.width = 0;
      const im = new Image(); im.src = URL.createObjectURL(blob); await im.decode().catch(() => { }); box.append(im);
    }
    let st = $('#stampaPagina'); if (!st) { st = document.createElement('style'); st.id = 'stampaPagina'; document.head.append(st); }
    st.textContent = `@page{size:${(pagina.width / 72 * 25.4).toFixed(1)}mm ${(pagina.height / 72 * 25.4).toFixed(1)}mm;margin:0}`;
    busy(false);
    window.addEventListener('afterprint', () => { $$('#stampa img').forEach(i => URL.revokeObjectURL(i.src)); box.textContent = ''; }, { once: true });
    window.print();
  } catch (e) { console.error(e); toast('Non sono riuscito a preparare la stampa: ' + (e.message || e), 6000); }
  finally { busy(false); if (doc) doc.destroy(); }
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
    const gr = document.createElement('i'); gr.className = 'grip'; gr.textContent = '⠿'; gr.title = 'Trascina per spostare la pagina'; presa(gr, b);
    b.dataset.id = p.id; b.append(c, s, gr); b.onclick = () => { T.sel.has(p.id) ? T.sel.delete(p.id) : T.sel.add(p.id); b.setAttribute("aria-pressed", T.sel.has(p.id)); selInfo(); };
    box.append(b); jobs.push([p, c, k]);
  });
  selInfo();
  for (const [p, c, k] of jobs) {
    if (run !== T.run) return;
    try { const proxy = await S.sources[p.src].pdf.getPage(p.idx + 1); await proxy.render({ canvasContext: c.getContext('2d'), viewport: proxy.getViewport({ scale: k, rotation: (proxy.rotate + p.rot) % 360 }) }).promise; } catch { }
  }
}
// Riordino delle miniature: si trascina la maniglia ⠿ (mouse o dito) e la pagina prende posto dove la lasci
function presa(gr, card) {
  let on = false, finito = 0;
  gr.addEventListener('click', e => e.stopPropagation());
  card.addEventListener('click', e => { if (Date.now() - finito < 400) { e.stopPropagation(); e.preventDefault(); } }, true); // il rilascio non deve contare come «tocco» di selezione
  const move = e => {
    if (!on) return;
    const sopra = document.elementsFromPoint(e.clientX, e.clientY).find(n => n.classList && n.classList.contains('th') && n !== card);
    if (!sopra) return;
    // la scheda trascinata non viene mai staccata dalla pagina (altrimenti il gesto si interrompe): si spostano le altre attorno a lei
    const kids = [...card.parentNode.children], ci = kids.indexOf(card), si = kids.indexOf(sopra);
    if (ci < si) card.before(...kids.slice(ci + 1, si + 1)); else card.after(...kids.slice(si, ci));
  };
  const fine = () => {
    if (!on) return; on = false; finito = Date.now(); card.classList.remove('drag');
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', fine); window.removeEventListener('pointercancel', fine);
    const ordine = [...card.parentNode.children].map(n => n.dataset.id);
    if (ordine.some((id, i) => S.pages[i].id !== id)) { snap("Riordina pagine"); S.pages = ordine.map(id => S.pages.find(p => p.id === id)); build(true); }
    [...card.parentNode.children].forEach((n, i) => { n.querySelector('span').textContent = i + 1; });
  };
  gr.addEventListener('pointerdown', e => {
    on = true; card.classList.add('drag'); e.preventDefault(); e.stopPropagation();
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', fine); window.addEventListener('pointercancel', fine);
  });
}
const need = () => { if (!T.sel.size) { toast('Seleziona prima una o più pagine'); return false; } return true; };
// conteggio delle pagine scelte e pulsanti attivi solo quando c'è una selezione
function selInfo() {
  const n = [...T.sel].filter(id => S.pages.some(p => p.id === id)).length;
  $('#pSelInfo').textContent = n ? n + (n === 1 ? ' selezionata' : ' selezionate') : S.pages.length + (S.pages.length === 1 ? ' pagina' : ' pagine');
  $$('#shPages [data-sel]').forEach(b => { b.disabled = !n; });
  $('#pAll').lastChild.textContent = n === S.pages.length && n ? 'Nessuna' : 'Tutte';
}
// nuova «sorgente» da byte PDF creati qui (pagina bianca, pagina duplicata): così ogni pagina resta indipendente nel salvataggio
async function nuovaFonte(bytes, name) {
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice(), cMapUrl: LIB + 'cmaps/', cMapPacked: true, standardFontDataUrl: LIB + 'standard_fonts/' }).promise;
  return S.sources.push({ name, bytes, pdf, form: {}, tc: {} }) - 1;
}
async function paginaBianca() {
  const sel = S.pages.map((p, i) => T.sel.has(p.id) ? i : -1).filter(i => i >= 0), pos = sel.length ? Math.max(...sel) + 1 : S.pages.length;
  const rif = S.pages[Math.max(0, pos - 1)], [w, h] = rif ? viewDims(rif) : [595.28, 841.89];
  busy(true, 'Aggiungo una pagina bianca…');
  try {
    const d = await PDFDocument.create(); d.addPage([w, h]);
    const si = await nuovaFonte(new Uint8Array(await d.save()), 'pagina bianca');
    snap('Pagina bianca'); const p = { id: nid(), src: si, idx: 0, rot: 0, ann: [], w, h };
    S.pages.splice(pos, 0, p); T.sel = new Set([p.id]); build(true); thumbs(); selInfo();
    toast('Pagina bianca aggiunta come pagina ' + (pos + 1));
  } catch (e) { console.error(e); toast('Non sono riuscito ad aggiungere la pagina bianca'); }
  finally { busy(false); }
}
async function duplica() {
  if (!need()) return;
  const scelte = S.pages.filter(p => T.sel.has(p.id));
  busy(true, 'Duplico ' + (scelte.length === 1 ? 'la pagina' : scelte.length + ' pagine') + '…');
  try {
    const libs = new Map(), nuove = new Map();
    for (const p of scelte) {
      if (!libs.has(p.src)) libs.set(p.src, await PDFDocument.load(S.sources[p.src].bytes, { ignoreEncryption: true }));
      const d = await PDFDocument.create(), [cp] = await d.copyPages(libs.get(p.src), [p.idx]); d.addPage(cp);
      const si = await nuovaFonte(new Uint8Array(await d.save()), S.sources[p.src].name);
      nuove.set(p.id, { ...JSON.parse(JSON.stringify(p)), id: nid(), src: si, idx: 0, ann: p.ann.map(a => ({ ...JSON.parse(JSON.stringify(a)), id: nid() })) });
    }
    snap('Duplica pagine');
    const out = []; for (const p of S.pages) { out.push(p); if (nuove.has(p.id)) out.push(nuove.get(p.id)); }
    S.pages = out; T.sel = new Set([...nuove.values()].map(p => p.id)); build(true); thumbs(); selInfo();
    toast(scelte.length === 1 ? 'Pagina duplicata' : scelte.length + ' pagine duplicate');
  } catch (e) { console.error(e); toast('Non sono riuscito a duplicare le pagine: ' + (e.message || e)); }
  finally { busy(false); }
}
$('#pBlank').onclick = paginaBianca;
$('#pDup').onclick = duplica;
$('#pRotL').onclick = () => { if (!need()) return; snap('Ruota pagine'); S.pages.forEach(p => { if (T.sel.has(p.id)) p.rot = (p.rot + 270) % 360; }); build(true); thumbs(); };
$('#bPages').onclick = () => { T.sel.clear(); openSheet('shPages'); thumbs(); selInfo(); };
$('#pAll').onclick = () => { if (T.sel.size === S.pages.length) T.sel.clear(); else S.pages.forEach(p => T.sel.add(p.id)); $$('#thumbs .th').forEach(b => b.setAttribute('aria-pressed', T.sel.has(b.dataset.id))); selInfo(); };
$('#pRot').onclick = () => { if (!need()) return; snap("Ruota pagine"); S.pages.forEach(p => { if (T.sel.has(p.id)) p.rot = (p.rot + 90) % 360; }); build(true); thumbs(); };
$('#pDel').onclick = () => { if (!need()) return; if (T.sel.size >= S.pages.length) return toast('Deve restare almeno una pagina'); snap("Elimina pagine"); S.pages = S.pages.filter(p => !T.sel.has(p.id)); S.sel = null; build(true); thumbs(); };
$('#pLeft').onclick = () => { if (!need()) return; snap("Sposta pagine"); const a = S.pages; for (let i = 1; i < a.length; i++) if (T.sel.has(a[i].id) && !T.sel.has(a[i - 1].id)) [a[i - 1], a[i]] = [a[i], a[i - 1]]; build(true); thumbs(); };
$('#pRight').onclick = () => { if (!need()) return; snap("Sposta pagine"); const a = S.pages; for (let i = a.length - 2; i >= 0; i--) if (T.sel.has(a[i].id) && !T.sel.has(a[i + 1].id)) [a[i + 1], a[i]] = [a[i], a[i + 1]]; build(true); thumbs(); };
$('#pExt').onclick = async () => { if (!need()) return; const f = await makeFile(S.pages.filter(p => T.sel.has(p.id)), 'estratto'); if (f) { download(f); toast('Pagine salvate in «' + f.name + '»'); } };
$('#pGo').onclick = () => { if (!need()) return; const p = S.pages.find(p => T.sel.has(p.id)); closeSheets(); goPage(p.id); };
$('#pAdd').onclick = () => $('#fAdd').click();
$('#fAdd').onchange = async e => {
  const fs = [...e.target.files]; e.target.value = '';
  // se è selezionata una pagina, il nuovo PDF entra subito dopo; altrimenti in fondo
  let pos = null; if ($('#shPages').classList.contains('on') && T.sel.size) pos = Math.max(...S.pages.map((p, i) => T.sel.has(p.id) ? i : -1)) + 1;
  await openFiles(fs, true, pos); if ($('#shPages').classList.contains('on')) thumbs();
};

/* ---------- cerca ---------- */
const F = { hits: [], i: -1 };
async function cerca() {
  const q = $('#q').value.trim().toLowerCase(), box = $('#qRes'); box.textContent = ''; F.hits = []; F.i = -1;
  if (q.length < 2) { box.innerHTML = '<p class="note">Scrivi almeno 2 caratteri.</p>'; return; }
  busy(true, 'Cerco «' + $('#q').value.trim() + '»…'); let n = 0;
  try {
    for (let i = 0; i < S.pages.length && n < 300; i++) {
      if (S.pages.length > 15) progress(i / S.pages.length);
      const p = S.pages[i], items = await textItems(p).catch(() => []);
      const found = items.filter(it => it.str.toLowerCase().includes(q)); if (!found.length) continue;
      for (const it of found) { if (++n > 300) break; F.hits.push({ p, it, found, n: i + 1 }); }
    }
  } finally { busy(false); }
  if (!F.hits.length) { box.innerHTML = '<p class="note">Nessun risultato. Se il PDF è una scansione, il testo non si può cercare.</p>'; return; }
  const head = document.createElement('div'); head.className = 'qnav';
  head.innerHTML = '<b></b><span class="grow"></span><button class="btn sm" id="qPrev"><svg class="ico"><use href="#i-up"/></svg>Precedente</button><button class="btn sm brand" id="qNext">Successivo<svg class="ico"><use href="#i-down"/></svg></button>';
  head.querySelector('b').textContent = F.hits.length + (F.hits.length >= 300 ? '+' : '') + (F.hits.length === 1 ? ' risultato' : ' risultati');
  box.append(head);
  head.querySelector('#qPrev').onclick = () => vaiRisultato(F.i - 1);
  head.querySelector('#qNext').onclick = () => vaiRisultato(F.i + 1);
  F.hits.forEach((h, k) => {
    const b = document.createElement('button'); b.className = 'res';
    const sm = document.createElement('small'); sm.textContent = 'Pagina ' + h.n;
    const tx = document.createElement('span'), s = h.it.str.length > 110 ? h.it.str.slice(0, 110) + '…' : h.it.str, j = s.toLowerCase().indexOf(q);
    if (j >= 0) { const m = document.createElement('mark'); m.textContent = s.slice(j, j + q.length); tx.append(s.slice(0, j), m, s.slice(j + q.length)); } else tx.textContent = s;
    b.append(sm, tx); b.onclick = () => vaiRisultato(k);
    box.append(b);
  });
}
// porta in vista il risultato k (con frecce avanti/indietro anche a pannello chiuso)
function vaiRisultato(k) {
  if (!F.hits.length) return;
  F.i = (k + F.hits.length) % F.hits.length; const h = F.hits[F.i], p = h.p;
  const old = Object.keys(S.hits);
  S.hits = { [p.id]: h.found.map(f => ({ x: f.x - 1, y: f.by - f.fh, w: f.w + 2, h: f.fh * 1.3, cur: f === h.it })) };
  closeSheets(); for (const id of new Set([...old, p.id])) { const r = els.get(id); r && drawAnn(r); }
  const r = els.get(p.id); if (r) { const [, vy] = b2v(p, h.it.x, h.it.by); viewer.scrollTop = r.el.offsetTop + Math.max(0, vy * S.scale - viewer.clientHeight / 3); }
  ui();
}
$('#bFind').onclick = () => { openSheet('shFind'); setTimeout(() => { $('#q').focus(); $('#q').select(); }, 60); };
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
const svgIco = id => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('class', 'ico'); const u = document.createElementNS(NS, 'use'); u.setAttribute('href', '#i-' + id); s.append(u); return s; };
function sw(colors, cur, on) { return colors.map(c => { const b = document.createElement('button'); b.className = 'sw'; b.style.background = c; b.setAttribute('aria-pressed', c === cur); b.setAttribute('aria-label', 'Colore ' + c); b.title = 'Colore'; b.onclick = () => { on(c); ui(); }; return b; }); }
function colpick(cur, on) { const i = document.createElement('input'); i.type = 'color'; i.className = 'colpick'; i.value = cur; i.title = 'Altro colore'; i.setAttribute('aria-label', 'Altro colore'); i.onchange = () => { on(i.value); ui(); }; return i; }
function ob(label, fn, cls, ico, pressed) { const b = document.createElement('button'); b.className = 'ob' + (cls ? ' ' + cls : ''); if (ico) b.append(svgIco(ico)); b.append(label); b.onclick = fn; if (pressed != null) b.setAttribute('aria-pressed', pressed); return b; }
function hint(t, ico) { const s = document.createElement('span'); s.className = 'hint'; if (ico) s.append(svgIco(ico)); s.append(t); return s; }
const grp = (...k) => { const g = document.createElement('div'); g.className = 'grp'; g.append(...k); return g; };
const vs = () => { const d = document.createElement('span'); d.className = 'vs'; return d; };
const SPESSORI = [['Fine', 1], ['Medio', 1.6], ['Grosso', 3]];
function ui() {
  const has = S.pages.length > 0; document.body.classList.toggle('doc', has);
  $('#empty').style.display = has ? 'none' : ''; $('#zoom').classList.toggle('on', has);
  $('#bSave').disabled = $('#bShare').disabled = $('#bPrint').disabled = !has;
  $('#bSide').hidden = !has;
  $$('#mMore [data-need]').forEach(b => { b.disabled = !has; });
  $$('#tools .tool').forEach(b => { b.disabled = !has; });
  $('#bUndo').disabled = !S.undo.length; $('#bRedo').disabled = !S.redo.length;
  $('#bUndo').title = S.undo.length ? 'Annulla: ' + S.undo[S.undo.length - 1].l + ' (Ctrl+Z)' : 'Annulla (Ctrl+Z)';
  $('#bRedo').title = S.redo.length ? 'Ripristina: ' + S.redo[S.redo.length - 1].l + ' (Ctrl+Y)' : 'Ripristina (Ctrl+Y)';
  $$('#tools [data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === S.tool));
  $('#bSign').setAttribute('aria-pressed', S.tool === 'place' && S.pending && S.pending.kind === 'firme');
  $('#bStamp').setAttribute('aria-pressed', S.tool === 'place' && S.pending && S.pending.kind === 'timbri');
  $('#bImg').setAttribute('aria-pressed', S.tool === 'place' && S.pending && S.pending.kind === 'immagine');
  const nm = $('#docName');
  if (has) nm.textContent = S.name; else nm.innerHTML = '<span class="logo-name">ninetto<b>-pdf</b></span>';
  const meta = $('#docMeta'); meta.textContent = '';
  if (has) { if (S.dirty) { const d = document.createElement('i'); d.className = 'dot'; meta.append(d); } meta.append(S.pages.length + (S.pages.length === 1 ? ' pagina' : ' pagine') + (S.dirty ? ' · modifiche da salvare' : ' · tutto salvato')); }
  else meta.textContent = 'Editor PDF · tutto sul tuo dispositivo';
  $('#dirtyDot').hidden = !(has && S.dirty);
  document.title = has ? (S.dirty ? '• ' : '') + S.name + ' – ninetto-pdf' : 'ninetto-pdf';
  const o = $('#opts'); o.textContent = ''; const a = selAnn();
  if (a) {
    const edit = a.t === 'text' || a.t === 'cover';
    o.append(hint(nomeAnn(a)[0].toUpperCase() + nomeAnn(a).slice(1), 'hand'), vs());
    if (edit) o.append(grp(ob('Modifica', modifica, '', 'edit'), ob('A−', () => resizeText(-1)), ob('A+', () => resizeText(1))));
    // ricolora l'elemento selezionato
    const col = a.t === 'cover' ? null : a.t === 'img' ? null : a.t === 'text' || a.t === 'stamp' || a.t === 'ink' || a.t === 'shape' || a.t === 'hl' ? (a.c || '#000000') : null;
    if (col) {
      const palette = a.t === 'hl' && a.m !== 'u' && a.m !== 's' ? ['#ffe14d', '#9be37a', '#ffa3c4', '#8fd3ff'] : ['#000000', '#1a3fb0', '#c62828', '#1c7c54', '#7c3aed'];
      const ric = c => { snap('Colore ' + nomeAnn(a)); a.c = c; const r = els.get(S.sel.pid); r && drawAnn(r); };
      o.append(grp(...sw(palette, col, ric), colpick(col, ric)));
    }
    if (a.t === 'ink' || a.t === 'shape') o.append(grp(...SPESSORI.map(([l, w]) => ob(l, () => { snap('Spessore'); a.lw = w; const r = els.get(S.sel.pid); r && drawAnn(r); ui(); }, '', null, a.lw === w))));
    o.append(vs(), grp(ob('Duplica', dupSel, '', 'copy'), ob('Elimina', delSel, 'del', 'trash')), hint(fine ? 'Trascina per spostare · frecce per spostare di precisione · angoli per ridimensionare' : 'Trascina per spostare · pallini agli angoli per ridimensionare'));
  } else if (S.tool === 'hl') {
    o.append(grp(...[['h', 'Evidenzia'], ['u', 'Sottolinea'], ['s', 'Barrato']].map(([m, l]) => ob(l, () => { S.hlMode = m; ui(); }, '', null, S.hlMode === m))), vs());
    if (S.hlMode === 'h') o.append(grp(...sw(['#ffe14d', '#9be37a', '#ffa3c4', '#8fd3ff'], S.hlColor, c => S.hlColor = c)));
    else o.append(grp(...sw(['#c62828', '#1a3fb0', '#000000', '#1c7c54'], S.lnColor, c => S.lnColor = c), colpick(S.lnColor, c => S.lnColor = c)));
    o.append(hint('Trascina sopra il testo: il segno si aggancia alla riga', 'info'));
  }
  else if (S.tool === 'ink') o.append(grp(...sw(['#1a3fb0', '#000000', '#c62828', '#1c7c54'], S.inkColor, c => S.inkColor = c), colpick(S.inkColor, c => S.inkColor = c)), vs(), grp(...SPESSORI.map(([l, w]) => ob(l, () => { S.inkW = w; ui(); }, '', null, S.inkW === w))), hint('Disegna con il dito, la penna o il mouse', 'info'));
  else if (S.tool === 'shape') {
    const sh = S.shape;
    o.append(grp(...Object.entries(NOMI_FORME).map(([k, l]) => ob(l, () => { sh.k = k; ui(); }, '', null, sh.k === k))), vs(),
      grp(...sw(['#c62828', '#1a3fb0', '#000000', '#1c7c54'], sh.c, c => sh.c = c), colpick(sh.c, c => sh.c = c)), vs(),
      grp(...SPESSORI.map(([l, w]) => ob(l, () => { sh.lw = w * 1.25; ui(); }, '', null, sh.lw === w * 1.25))),
      hint(fine ? 'Trascina sulla pagina · tieni premuto Maiusc per forme regolari' : 'Trascina sulla pagina per disegnare', 'info'));
  }
  else if (S.tool === 'cover') o.append(hint('Tocca il testo da correggere, oppure trascina un riquadro sopra', 'info'));
  else if (S.tool === 'white') o.append(hint('Trascina un riquadro sulla parte da coprire. Colore:', 'info'), grp(...sw(['#ffffff', '#000000'], S.whiteColor, c => S.whiteColor = c)));
  else if (S.tool === 'erase') o.append(hint('Tocca una scritta o un’aggiunta per cancellarla, oppure trascina un riquadro sulla zona da cancellare', 'info'));
  else if (S.tool === 'text') o.append(hint('Tocca il punto dove scrivere', 'info'));
  else if (S.tool === 'note') o.append(hint('Tocca il punto dove mettere la nota', 'info'));
  else if (S.tool === 'place') o.append(hint(S.pending && S.pending.kind === 'firme' ? 'Tocca il punto dove mettere la firma' : S.pending && S.pending.kind === 'immagine' ? 'Tocca il punto dove mettere l’immagine' : 'Tocca il punto dove mettere il timbro', 'info'), ob('Annulla', () => setTool('mano'), '', 'x'));
  if (has && !o.childNodes.length) {
    if (F.hits.length && Object.keys(S.hits).length) o.append(hint('Risultato ' + (F.i + 1) + ' di ' + F.hits.length, 'search'), ob('', () => vaiRisultato(F.i - 1), '', 'up'), ob('', () => vaiRisultato(F.i + 1), '', 'down'), ob('Chiudi ricerca', () => { const ids = Object.keys(S.hits); S.hits = {}; F.hits = []; ids.forEach(id => { const r = els.get(id); r && drawAnn(r); }); ui(); }, '', 'x'));
    else o.append(hint('Scegli uno strumento qui sopra. Tocca un’aggiunta per spostarla, modificarla o eliminarla.', 'info'));
  }
  o.classList.toggle('on', has);
}
function delSel() { if (!S.sel) return; const p = S.pages.find(p => p.id === S.sel.pid); if (!p) return; snap('Elimina ' + nomeAnn(selAnn())); p.ann = p.ann.filter(a => a.id !== S.sel.id); const r = els.get(p.id); S.sel = null; if (r) { r.p = p; drawAnn(r); } ui(); }
function dupSel() {
  const a = selAnn(); if (!a) return; const pid = S.sel.pid, p = S.pages.find(q => q.id === pid); snap('Duplica ' + nomeAnn(a));
  const b = JSON.parse(JSON.stringify(a)); b.id = nid(); const d = 12;
  if (b.pts) b.pts = b.pts.map(([x, y]) => [x + d, y + d]); else { b.x += d; b.y += d; if (b.t === 'cover') { b.tx += d; b.by += d; } }
  p.ann.push(b); select(pid, b.id);
}
function nudge(dx, dy) {
  const a = selAnn(); if (!a) return;
  if (!nudge.t || Date.now() - nudge.t > 800) snap('Sposta ' + nomeAnn(a)); nudge.t = Date.now(); // una sola voce di annulla per una serie di frecce
  if (a.pts) a.pts = a.pts.map(([x, y]) => [x + dx, y + dy]); else { a.x += dx; a.y += dy; if (a.t === 'cover') { a.tx += dx; a.by += dy; } }
  const r = els.get(S.sel.pid); r && drawAnn(r);
}
function resizeText(d) { const a = selAnn(); if (!a) return; snap('Dimensione testo'); a.size = clamp(+(a.size + d * (a.size > 14 ? 1 : .5)).toFixed(1), 4, 120); const r = els.get(S.sel.pid); r && drawAnn(r); }

/* ---------- menu e tema ---------- */
function closeMenus() { $$('.menu.on').forEach(m => m.classList.remove('on')); }
function openMenu(id, anchor) {
  const m = $('#' + id), on = m.classList.contains('on'); closeMenus(); if (on) return;
  m.classList.add('on'); const b = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  let left = Math.min(window.innerWidth - mw - 10, Math.max(10, b.right - mw)), top = b.bottom + 6;
  if (top + mh > window.innerHeight - 10) top = Math.max(10, b.top - mh - 6);
  m.style.left = left + 'px'; m.style.top = top + 'px';
  const first = m.querySelector('button:not(:disabled),a'); first && first.focus({ preventScroll: true });
}
document.addEventListener('pointerdown', e => { if (!e.target.closest('.menu,#bMore,#zPct')) closeMenus(); });
const temaScuro = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
function temaUi() { const s = temaScuro(); $('#themeLbl').textContent = s ? 'Tema chiaro' : 'Tema scuro'; $('#themeIco use').setAttribute('href', s ? '#i-sun' : '#i-moon'); }
function cambiaTema() {
  const t = temaScuro() ? 'light' : 'dark'; document.documentElement.dataset.theme = t;
  try { localStorage.setItem('ninetto.tema', t); } catch { }
  temaUi();
}
$('#bMore').onclick = e => { temaUi(); openMenu('mMore', e.currentTarget); };
$('#mMore').addEventListener('click', e => {
  const b = e.target.closest('[data-m]'); if (!b && e.target.closest('a')) { closeMenus(); return; } if (!b) return; closeMenus();
  const m = b.dataset.m;
  if (m === 'saveas') saveAs(); else if (m === 'print') stampa(); else if (m === 'add') $('#fAdd').click();
  else if (m === 'theme') cambiaTema(); else if (m === 'side') toggleSide(); else if (m === 'keys') openSheet('shKeys');
  else if (m === 'close') chiudi();
});
$('#zPct').onclick = e => openMenu('mZoom', e.currentTarget);
$('#mZoom').addEventListener('click', e => { const b = e.target.closest('[data-z]'); if (!b) return; closeMenus(); const z = b.dataset.z; if (z === 'width' || z === 'page') fit(z); else setScale(parseFloat(z)); });
function chiudi() {
  if (S.dirty && !window.confirm('Ci sono modifiche non salvate. Chiudere comunque il documento?')) return;
  S.pages = []; S.sources = []; S.undo = []; S.redo = []; S.sel = null; S.hits = {}; S.dirty = false; S.name = ''; F.hits = [];
  setTool('mano'); build(false); showRecent();
}

/* ---------- comandi ---------- */
$('#bOpen').onclick = $('#bOpen2').onclick = () => $('#fOpen').click();
$('#fOpen').onchange = e => { const fs = [...e.target.files]; e.target.value = ''; openFiles(fs, false); };
$('#bSave').onclick = () => save(); $('#bShare').onclick = share; $('#bPrint').onclick = stampa;
$('#bUndo').onclick = undo; $('#bRedo').onclick = redo;
$('#bSide').onclick = () => toggleSide();
$('#zIn').onclick = () => setScale(S.scale * 1.25); $('#zOut').onclick = () => setScale(S.scale / 1.25); $('#zFit').onclick = () => fit();
document.addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName), mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 's') { e.preventDefault(); if (S.pages.length) e.shiftKey ? saveAs() : save(); }
  else if (mod && k === 'p') { e.preventDefault(); if (S.pages.length) stampa(); }
  else if (mod && k === 'o') { e.preventDefault(); $('#fOpen').click(); }
  else if (mod && k === 'f') { if (S.pages.length) { e.preventDefault(); $('#bFind').click(); } }
  else if (e.key === 'Escape') { if ($('.menu.on')) closeMenus(); else if ($('.sheet.on')) closeSheets(); else { setTool('mano'); if (S.sel) select(null, null); } }
  else if (typing || $('.sheet.on')) return;
  else if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (mod && k === 'd') { e.preventDefault(); dupSel(); }
  else if (mod && (k === '+' || k === '=')) { e.preventDefault(); setScale(S.scale * 1.2); }
  else if (mod && (k === '-' || k === '_')) { e.preventDefault(); setScale(S.scale / 1.2); }
  else if (mod && k === '0') { e.preventDefault(); fit(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { e.preventDefault(); delSel(); }
  else if (S.sel && e.key.startsWith('Arrow')) { e.preventDefault(); const st = e.shiftKey ? 10 : 1; nudge(e.key === 'ArrowLeft' ? -st : e.key === 'ArrowRight' ? st : 0, e.key === 'ArrowUp' ? -st : e.key === 'ArrowDown' ? st : 0); }
  else if (S.pages.length && (e.key === 'PageDown' || e.key === 'PageUp') && !mod) { e.preventDefault(); goN(curPage + (e.key === 'PageDown' ? 1 : -1)); }
  else if (S.pages.length && e.key === 'Home' && mod) { e.preventDefault(); goN(1); }
  else if (S.pages.length && e.key === 'End' && mod) { e.preventDefault(); goN(S.pages.length); }
});
// Ctrl + rotellina (e pizzico sul touchpad): zoom verso il cursore
let wheelAcc = 1, wheelRaf = 0, wheelPt = null;
viewer.addEventListener('wheel', e => {
  if (!e.ctrlKey || !S.pages.length) return;
  e.preventDefault(); wheelAcc *= Math.exp(-e.deltaY * 0.0022); wheelPt = [e.clientX, e.clientY];
  if (!wheelRaf) wheelRaf = requestAnimationFrame(() => { wheelRaf = 0; const k = wheelAcc; wheelAcc = 1; setScale(S.scale * k, ...wheelPt); });
}, { passive: false });
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

// trascinamento file (PC)
let dragN = 0;
window.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragN++; document.body.classList.add('drop'); } });
window.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('drop'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); dragN = 0; document.body.classList.remove('drop'); if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files, S.pages.length > 0 && e.shiftKey); });

// due dita: zoom e spostamento della pagina; il tratto iniziato col primo dito viene annullato, così non restano segni
let pinch = null;
const tdist = e => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
const tmid = e => [(e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2];
viewer.addEventListener('touchstart', e => { if (e.touches.length === 2 && S.pages.length) { cancelDrag(); const [mx, my] = tmid(e); pinch = { d: tdist(e), k: 1, mx, my }; } }, { passive: true });
viewer.addEventListener('touchmove', e => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const [mx, my] = tmid(e); viewer.scrollLeft -= mx - pinch.mx; viewer.scrollTop -= my - pinch.my; pinch.mx = mx; pinch.my = my;
  pinch.k = clamp(tdist(e) / pinch.d, 0.2 / S.scale, 6 / S.scale); pagesEl.style.transform = Math.abs(pinch.k - 1) > 0.03 ? `scale(${pinch.k})` : '';
}, { passive: false });
const pinchEnd = () => { if (!pinch) return; const k = pinch.k; pinch = null; pagesEl.style.transform = ''; if (Math.abs(k - 1) > 0.03) setScale(S.scale * k); };
viewer.addEventListener('touchend', pinchEnd); viewer.addEventListener('touchcancel', pinchEnd);
window.addEventListener('resize', () => { if ($('#shSign').classList.contains('on')) return; pageInfo(); });

/* ---------- avvio: file condivisi, apertura da sistema, funzionamento offline ---------- */
$('#ver').textContent = 'Versione ' + VERSIONE; $('#ver2').textContent = 'ninetto-pdf · versione ' + VERSIONE + ' · pdf.js, pdf-lib e qpdf (open source)';
try { if (localStorage.getItem('editorpdf.side') !== '0' && window.innerWidth >= 1100) document.body.classList.add('side'); } catch { }
showRecent();
if (matchMedia) matchMedia('(prefers-color-scheme: dark)').addEventListener('change', temaUi);
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
window.__editor = { S, openFiles, buildPdf, crea, setTool, els, select };
