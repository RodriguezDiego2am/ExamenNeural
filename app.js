/* Buscador de manuales: búsqueda full‑text sobre PDFs, 100% en el navegador. */
'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  q: $('q'), clear: $('clear'), status: $('status'), results: $('results'), empty: $('empty'), help: $('help'),
  docFilter: $('docFilter'), fuzzy: $('fuzzy'), manageBtn: $('manageBtn'), modeKw: $('modeKw'), modeSem: $('modeSem'),
  viewer: $('viewer'), vDoc: $('vDoc'), vPage: $('vPage'), vText: $('vText'), vPrev: $('vPrev'), vNext: $('vNext'),
  vMarkNext: $('vMarkNext'), vOpen: $('vOpen'), vClose: $('vClose'),
  manage: $('manage'), mClose: $('mClose'), drop: $('drop'), fileInput: $('fileInput'), progress: $('progress'),
  progressBar: $('progressBar'), progressText: $('progressText'), docList: $('docList'), clearLocal: $('clearLocal'),
};

if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

/* ---------- Normalización (misma longitud que el original, para poder resaltar) ---------- */
const foldCache = new Map();
function foldChar(c) {
  let r = foldCache.get(c);
  if (r === undefined) {
    r = c.normalize('NFD')[0].toLowerCase();
    if (r.length !== 1) r = c;
    foldCache.set(c, r);
  }
  return r;
}
const fold = (s) => s.replace(/[^\x00-\x40\x5b-\x7f]/g, foldChar);

const STOP = new Set(('de la que el en y a los del se las por un para con no una su al lo como mas pero sus le ya o ' +
  'este si porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ' +
  'ni contra otros ese eso ante ellos e esto mi antes algunos que unos yo otro otras otra el tanto esa estos mucho ' +
  'cual poco ella estar estas algunas algo nosotros es son fue ser sera the of and to in is').split(' '));

function processTerm(term) {
  const t = fold(term);
  if (t.length < 2 && !/\d/.test(t)) return null;
  if (STOP.has(t)) return null;
  return t;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const B = '(?<![\\p{L}\\p{N}])'; // inicio de palabra

/* ---------- Estado ---------- */
let docs = [];        // {key, name, source:'repo'|'local', file?, blob?, pages:[texto]}
let pageRefs = [];    // id -> {d, p}
let mini = null;
let current = { hits: [], shown: 0, regexes: [] };
let sel = -1;
let searchSeq = 0;
let mode = (() => { try { return localStorage.getItem('modo') === 'sem' ? 'sem' : 'kw'; } catch { return 'kw'; } })();
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
const sem = { ok: false, loading: null, chunks: null, E: null, dim: 384, model: null };
const foldedCache = new Map();
const foldedPage = (d, p) => {
  const k = d + ':' + p;
  let f = foldedCache.get(k);
  if (f === undefined) { f = fold(docs[d].pages[p - 1]); foldedCache.set(k, f); }
  return f;
};

function newIndex() {
  return new MiniSearch({
    fields: ['t'],
    storeFields: ['d', 'p'],
    processTerm,
    extractField: (doc, field) => (field === 't' ? docs[doc.d].pages[doc.p - 1] : doc[field]),
  });
}

async function addDocsToIndex(fromDoc) {
  const batch = [];
  for (let d = fromDoc; d < docs.length; d++) {
    docs[d].pages.forEach((_, i) => {
      const id = pageRefs.length;
      pageRefs.push({ id, d, p: i + 1 });
      batch.push(pageRefs[id]);
    });
  }
  await mini.addAllAsync(batch, { chunkSize: 200 });
}

async function rebuildIndex() {
  pageRefs = [];
  foldedCache.clear();
  mini = newIndex();
  await addDocsToIndex(0);
  refreshDocUI();
  runSearch();
}

/* ---------- Almacenamiento local (IndexedDB) ---------- */
const DB_NAME = 'buscador-manuales';
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('docs', { keyPath: 'key' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbAll() {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const r = db.transaction('docs').objectStore('docs').getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  } catch (e) { console.warn('IndexedDB no disponible', e); return []; }
}
async function dbOp(fn) {
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('docs', 'readwrite');
      fn(tx.objectStore('docs'));
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    return true;
  } catch (e) { console.warn('No se pudo guardar', e); return false; }
}

/* ---------- Carga inicial ---------- */
async function loadRepoIndex() {
  try {
    const r = await fetch('data/index.json', { cache: 'no-cache' });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.docs || []).map((x) => ({ key: 'r:' + x.file, name: x.name, file: x.file, source: 'repo', pages: x.pages }));
  } catch { return []; }
}

async function init() {
  const [repo, local] = await Promise.all([loadRepoIndex(), dbAll()]);
  const localDocs = local.map((x) => ({ key: x.key, name: x.name, blob: x.blob, source: 'local', pages: x.pages }));
  docs = [...repo, ...localDocs];
  await rebuildIndex();
}

/* ---------- Búsqueda ---------- */
function parseQuery(raw) {
  const phrases = [], excludes = [], words = [];
  const rest = raw.replace(/"([^"]*)"?/g, (_, ph) => {
    const ws = fold(ph).split(/[\s\p{P}]+/u).filter(Boolean);
    if (ws.length) phrases.push(ws);
    return ' ';
  });
  for (const w of rest.split(/\s+/)) {
    if (!w) continue;
    if (w.startsWith('-') && w.length > 1) excludes.push(fold(w.slice(1)));
    else words.push(w);
  }
  return { phrases, excludes, words };
}

function runSearch() {
  const raw = els.q.value.trim();
  els.clear.hidden = !raw;
  sel = -1;
  const hasDocs = docs.length > 0;
  els.empty.hidden = hasDocs;
  els.help.hidden = !hasDocs || !!raw;
  if (!raw || !mini) {
    searchSeq++;
    current = { hits: [], shown: 0, regexes: [] };
    els.results.innerHTML = '';
    updateFilterCounts(null);
    els.status.textContent = statusIdle();
    return;
  }
  const t0 = performance.now();
  const { phrases, excludes, words } = parseQuery(raw);
  const terms = [...words, ...phrases.flat()].join(' ');
  const fuzzy = els.fuzzy.checked ? (term) => (term.length > 4 ? 0.2 : false) : false;
  const opts = { prefix: (term) => term.length >= 2, fuzzy, combineWith: 'AND' };

  let hits = terms ? mini.search(terms, opts) : [];
  let partial = false;
  if (!hits.length && terms.split(/\s+/).length > 1 && !phrases.length) {
    hits = mini.search(terms, { ...opts, combineWith: 'OR' });
    partial = hits.length > 0;
  }

  const phraseRes = phrases.map((ws) => new RegExp(B + ws.map(escRe).join('[\\s\\p{P}]+'), 'u'));
  const exclRes = excludes.filter(Boolean).map((w) => new RegExp(B + escRe(w), 'u'));
  const accept = (h) => {
    if (!phraseRes.length && !exclRes.length) return true;
    const f = foldedPage(h.d, h.p);
    return phraseRes.every((re) => re.test(f)) && !exclRes.some((re) => re.test(f));
  };
  hits = hits.filter(accept);
  if (mode === 'sem') {
    // Las palabras pesan fuerte solo si la página las tiene todas; si no, coincidencias parciales con menos peso
    runSemantic(raw, { kwHits: hits, kwWeight: partial ? 0.25 : 1, accept, regexes: buildRegexes(hits, phrases) });
    return;
  }
  searchSeq++; // invalida una búsqueda semántica en curso

  updateFilterCounts(hits);
  const dsel = els.docFilter.value;
  const shownHits = dsel === '' ? hits : hits.filter((h) => String(h.d) === dsel);
  const regexes = buildRegexes(shownHits, phrases);

  current = { hits: shownHits, shown: 0, regexes };
  els.results.innerHTML = '';
  renderMore();

  const ms = Math.round(performance.now() - t0);
  const nDocs = new Set(shownHits.map((h) => h.d)).size;
  els.status.textContent = shownHits.length
    ? `${shownHits.length} página${shownHits.length === 1 ? '' : 's'} en ${nDocs} documento${nDocs === 1 ? '' : 's'}` +
      (partial ? ' · ⚠️ ninguna página tiene todas las palabras: mostrando coincidencias parciales' : '') + ` · ${ms} ms`
    : 'Sin resultados' + (els.fuzzy.checked ? '' : ' (probá activar «Tolerar errores»)');
}

/* ---------- Búsqueda por significado (embeddings, 100% en el navegador) ---------- */
function ensureSem() {
  if (sem.ok) return Promise.resolve();
  if (sem.loading) return sem.loading;
  sem.loading = (async () => {
    const [cr, er] = await Promise.all([fetch('data/chunks.json', { cache: 'no-cache' }), fetch('data/embeddings.bin', { cache: 'no-cache' })]);
    if (!cr.ok || !er.ok) throw new Error('faltan los datos semánticos en el sitio');
    const meta = await cr.json();
    const repoSig = docs.filter((d) => d.source === 'repo').map((d) => d.name + ':' + d.pages.length).join('|');
    if (meta.sig !== repoSig) throw new Error('el índice semántico está desactualizado (se regenera solo al publicar)');
    sem.chunks = meta.chunks; sem.dim = meta.dim;
    sem.E = new Int8Array(await er.arrayBuffer());
    const T = await import(TRANSFORMERS_URL);
    T.env.allowLocalModels = false;
    sem.model = await T.pipeline('feature-extraction', meta.model, {
      dtype: 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress' && /\.onnx$/.test(p.file || '') && mode === 'sem')
          els.status.textContent = `Descargando el modelo de significado (solo la primera vez): ${Math.round(p.progress)}% de ${Math.round(p.total / 1e6)} MB`;
      },
    });
    sem.ok = true;
  })().catch((e) => { sem.loading = null; throw e; });
  return sem.loading;
}

async function runSemantic(raw, ctx) {
  const seq = ++searchSeq;
  els.status.textContent = sem.ok ? '🔎 Buscando por significado…' : 'Cargando la búsqueda por significado…';
  try { await ensureSem(); } catch (e) {
    console.error(e);
    if (seq === searchSeq) {
      showHits(ctx.kwHits, ctx.regexes);
      els.status.textContent = '⚠️ No se pudo usar la búsqueda por significado (' + (e.message || e) + '). Mostrando búsqueda por palabras.';
    }
    return;
  }
  if (seq !== searchSeq) return;
  const t0 = performance.now();
  const q = raw.replace(/["]/g, ' ').replace(/(^|\s)-\S+/g, ' ').trim() || raw;
  const v = (await sem.model('query: ' + q, { pooling: 'mean', normalize: true })).data;
  if (seq !== searchSeq) return;

  const { chunks, E, dim } = sem;
  const best = new Map(); // página -> {score, chunk}
  for (let i = 0; i < chunks.length; i++) {
    let s = 0;
    const o = i * dim;
    for (let j = 0; j < dim; j++) s += v[j] * E[o + j];
    const [d, p, a, b] = chunks[i];
    const k = d + ':' + p;
    const cur = best.get(k);
    if (!cur || s > cur.score) best.set(k, { d, p, score: s, chunk: [a, b] });
  }
  let semHits = [...best.values()].filter(ctx.accept).sort((x, y) => y.score - x.score).slice(0, 150);

  // Fusión por ranking recíproco: significado + palabras
  const K = 10, fused = new Map();
  semHits.forEach((h, r) => fused.set(h.d + ':' + h.p, { d: h.d, p: h.p, chunk: h.chunk, terms: [], f: 1 / (K + r) }));
  ctx.kwHits.slice(0, 150).forEach((h, r) => {
    const k = h.d + ':' + h.p;
    const x = fused.get(k) || { d: h.d, p: h.p, terms: [], f: 0 };
    x.terms = h.terms; x.f += ctx.kwWeight / (K + r);
    fused.set(k, x);
  });
  const all = [...fused.values()].sort((a, b) => b.f - a.f).slice(0, 120);
  showHits(all, ctx.regexes);
  els.results.dataset.q = raw;
  const ms = Math.round(performance.now() - t0);
  els.status.textContent = `🧠 ${current.hits.length} resultados ordenados por significado · ${ms} ms`;
}

function showHits(all, regexes) {
  updateFilterCounts(all);
  const dsel = els.docFilter.value;
  const hits = dsel === '' ? all : all.filter((h) => String(h.d) === dsel);
  current = { hits, shown: 0, regexes };
  sel = -1;
  els.results.innerHTML = '';
  renderMore();
}

function setMode(m) {
  mode = m;
  try { localStorage.setItem('modo', m); } catch {}
  els.modeKw.classList.toggle('on', m === 'kw');
  els.modeSem.classList.toggle('on', m === 'sem');
  if (m === 'sem' && docs.length) ensureSem().catch(() => {});
  runSearch();
}

// Regex de resaltado: palabras realmente encontradas + frases
function buildRegexes(hits, phrases) {
  const matched = new Set();
  for (const h of hits.slice(0, 300)) for (const t of h.terms) matched.add(t);
  const regexes = [];
  if (matched.size) {
    const alt = [...matched].sort((a, b) => b.length - a.length).map(escRe).join('|');
    regexes.push(new RegExp(B + '(?:' + alt + ')(?![\\p{L}\\p{N}])', 'gu'));
  }
  for (const ws of phrases) regexes.push(new RegExp(B + ws.map(escRe).join('[\\s\\p{P}]+'), 'gu'));
  return regexes;
}

function statusIdle() {
  if (mode === 'sem' && !sem.ok) return sem.loading ? 'Cargando la búsqueda por significado…' : statusBase();
  return statusBase();
}
function statusBase() {
  if (!docs.length) return 'Sin documentos cargados';
  const pages = docs.reduce((a, d) => a + d.pages.length, 0);
  return `${docs.length} documentos · ${pages} páginas indexadas`;
}

function findRanges(text, regexes) {
  const ranges = [];
  for (const re of regexes) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (!m[0].length) { re.lastIndex++; continue; }
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push(r.slice());
  }
  return out;
}

function highlight(text, ranges, start, end, collapse) {
  let html = '', pos = start;
  const norm = (s) => escHtml(collapse ? s.replace(/\s+/g, ' ') : s);
  for (const [a, b] of ranges) {
    if (b <= start || a >= end) continue;
    html += norm(text.slice(pos, Math.max(a, pos))) + '<mark>' + norm(text.slice(Math.max(a, start), Math.min(b, end))) + '</mark>';
    pos = Math.min(b, end);
  }
  return html + norm(text.slice(pos, end));
}

function snippets(h) {
  const { d, p } = h;
  const text = docs[d].pages[p - 1];
  const ranges = findRanges(foldedPage(d, p), current.regexes);
  if (h.chunk) {
    const [cs, ce] = h.chunk;
    const first = ranges.find(([a]) => a >= cs && a < ce);
    let s = first && first[0] > cs + 250 ? first[0] - 100 : cs;
    if (s > cs) { const sp = text.indexOf(' ', s); if (sp > 0 && sp < s + 20) s = sp + 1; }
    let e = Math.min(ce, s + 380);
    if (e < ce) { const sp = text.lastIndexOf(' ', e); if (sp > s + 300) e = sp; }
    return [(s > 0 ? '…' : '') + highlight(text, ranges, s, e, true) + (e < text.length ? '…' : '')];
  }
  if (!ranges.length) return [escHtml(text.slice(0, 200).replace(/\s+/g, ' ')) + '…'];
  // Elegir la ventana con más palabras distintas resaltadas
  const W = 220;
  const f = foldedPage(d, p);
  const windows = ranges.map(([a]) => {
    const distinct = new Set(ranges.filter(([x]) => x >= a && x < a + W).map(([x, y]) => f.slice(x, y)));
    return { a, score: distinct.size };
  });
  windows.sort((x, y) => y.score - x.score || x.a - y.a);
  const picked = [];
  for (const w of windows) {
    if (picked.length >= 2) break;
    if (picked.some((q) => Math.abs(q - w.a) < W)) continue;
    picked.push(w.a);
  }
  picked.sort((x, y) => x - y);
  return picked.map((a) => {
    let s = Math.max(0, a - 70), e = Math.min(text.length, a + W - 70);
    if (s > 0) { const sp = text.lastIndexOf(' ', s); s = sp > s - 20 && sp >= 0 ? sp + 1 : s; }
    if (e < text.length) { const sp = text.indexOf(' ', e); e = sp >= 0 && sp < e + 20 ? sp : e; }
    return (s > 0 ? '…' : '') + highlight(text, ranges, s, e, true) + (e < text.length ? '…' : '');
  });
}

function renderMore() {
  els.results.querySelector('.more')?.remove();
  const PAGE = 40;
  const frag = document.createDocumentFragment();
  const end = Math.min(current.hits.length, current.shown + PAGE);
  for (let i = current.shown; i < end; i++) {
    const h = current.hits[i];
    const li = document.createElement('li');
    li.dataset.i = i;
    li.innerHTML = `<div class="rhead"><span class="rdoc">${escHtml(docs[h.d].name)}</span><span class="rpage">pág. ${h.p}</span></div>` +
      snippets(h).map((s) => `<div class="snip">${s}</div>`).join('');
    frag.appendChild(li);
  }
  current.shown = end;
  if (end < current.hits.length) {
    const more = document.createElement('li');
    more.className = 'more';
    more.innerHTML = `<button class="ghost">Mostrar más (${current.hits.length - end} restantes)</button>`;
    frag.appendChild(more);
  }
  els.results.appendChild(frag);
}

function updateFilterCounts(hits) {
  const counts = new Map();
  if (hits) for (const h of hits) counts.set(h.d, (counts.get(h.d) || 0) + 1);
  for (const opt of els.docFilter.options) {
    if (opt.value === '') { opt.textContent = hits ? `Todos los documentos (${hits.length})` : 'Todos los documentos'; continue; }
    const d = +opt.value;
    opt.textContent = docs[d].name + (hits ? ` (${counts.get(d) || 0})` : '');
  }
}

function refreshDocUI() {
  const prev = els.docFilter.value;
  els.docFilter.innerHTML = '<option value="">Todos los documentos</option>' +
    docs.map((d, i) => `<option value="${i}">${escHtml(d.name)}</option>`).join('');
  els.docFilter.value = prev && +prev < docs.length ? prev : '';
  els.docList.innerHTML = docs.map((d, i) =>
    `<li><span class="dname">${escHtml(d.name)}</span><span class="dmeta">${d.pages.length} pág. · ${d.source === 'repo' ? 'web' : 'este dispositivo'}` +
    (d.source === 'local' ? ` <button class="ghost" data-del="${i}" title="Quitar">🗑</button>` : '') + '</span></li>').join('');
  els.clearLocal.hidden = !docs.some((d) => d.source === 'local');
  els.empty.hidden = docs.length > 0;
}

/* ---------- Visor ---------- */
let view = null; // {d, p, markIdx}
function openViewer(h) {
  view = { d: h.d, p: h.p, chunk: h.chunk || null, markIdx: -1 };
  renderViewer();
  if (!els.viewer.open) els.viewer.showModal();
  const s = els.vText.querySelector('.semhl');
  if (s) s.scrollIntoView({ block: 'center' }); else nextMark();
}
function renderViewer() {
  const { d, p } = view;
  const doc = docs[d];
  els.vDoc.textContent = doc.name;
  els.vPage.textContent = `· pág. ${p} de ${doc.pages.length}`;
  const text = doc.pages[p - 1] || '';
  const ranges = findRanges(foldedPage(d, p), current.regexes);
  const c = view.chunk;
  els.vText.innerHTML = !text ? '<i>(Página sin texto: puede ser una imagen escaneada)</i>'
    : c ? highlight(text, ranges, 0, c[0], false) + '<span class="semhl">' + highlight(text, ranges, c[0], c[1], false) + '</span>' + highlight(text, ranges, c[1], text.length, false)
    : highlight(text, ranges, 0, text.length, false);
  els.vText.scrollTop = 0;
  els.vPrev.disabled = p <= 1;
  els.vNext.disabled = p >= doc.pages.length;
  els.vMarkNext.hidden = !ranges.length;
  const url = doc.source === 'repo' ? encodeURI(doc.file) : (doc.blobUrl ||= doc.blob ? URL.createObjectURL(doc.blob) : '');
  els.vOpen.hidden = !url;
  if (url) els.vOpen.href = url + '#page=' + p;
  view.markIdx = -1;
}
function nextMark() {
  const marks = els.vText.querySelectorAll('mark');
  if (!marks.length) return;
  marks[view.markIdx]?.classList.remove('cur');
  view.markIdx = (view.markIdx + 1) % marks.length;
  const m = marks[view.markIdx];
  m.classList.add('cur');
  m.scrollIntoView({ block: 'center' });
}
function turnPage(delta) {
  const np = view.p + delta;
  if (np < 1 || np > docs[view.d].pages.length) return;
  view.p = np;
  view.chunk = null;
  renderViewer();
}

/* ---------- Carga de PDFs desde el dispositivo ---------- */
function cleanText(t) {
  return t.replace(/­/g, '').replace(/(\p{L})-\n(\p{L})/gu, '$1$2').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function extractPdf(file, onPage) {
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    pages.push(cleanText(tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('')));
    page.cleanup();
    onPage(i, pdf.numPages);
  }
  await pdf.destroy();
  return pages;
}

async function ingest(files) {
  files = [...files].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!files.length) return;
  if (!window.pdfjsLib) { alert('No se pudo cargar el lector de PDF.'); return; }
  els.progress.hidden = false;
  const errors = [];
  const firstNew = docs.length;
  let replaced = false;
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    const name = f.name.replace(/\.pdf$/i, '');
    try {
      const pages = await extractPdf(f, (i, n) => {
        els.progressBar.style.width = ((k + i / n) / files.length * 100).toFixed(1) + '%';
        els.progressText.textContent = `${k + 1}/${files.length} · ${name} · pág. ${i}/${n}`;
      });
      const rec = { key: 'l:' + name + ':' + f.size, name, pages, blob: f, added: Date.now() };
      await dbOp((s) => s.put(rec));
      const existing = docs.findIndex((d) => d.key === rec.key);
      const doc = { key: rec.key, name, blob: f, source: 'local', pages };
      if (existing >= 0) { docs[existing] = doc; replaced = true; } else docs.push(doc);
    } catch (e) {
      console.error(e);
      errors.push(`${f.name}: ${e.message || e}`);
    }
  }
  els.progressText.textContent = 'Indexando…';
  if (replaced) await rebuildIndex();
  else { await addDocsToIndex(firstNew); refreshDocUI(); runSearch(); }
  els.progress.hidden = true;
  els.progressBar.style.width = '0';
  if (errors.length) alert('No se pudieron leer:\n' + errors.join('\n'));
}

/* ---------- Eventos ---------- */
let timer;
els.q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runSearch, mode === 'sem' ? 300 : 90); });
els.modeKw.addEventListener('click', () => setMode('kw'));
els.modeSem.addEventListener('click', () => setMode('sem'));
els.docFilter.addEventListener('change', runSearch);
els.fuzzy.addEventListener('change', runSearch);
els.clear.addEventListener('click', () => { els.q.value = ''; runSearch(); els.q.focus(); });

els.results.addEventListener('click', (e) => {
  if (e.target.closest('.more')) { renderMore(); return; }
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  openViewer(current.hits[+li.dataset.i]);
});

function setSel(i) {
  const items = els.results.querySelectorAll('li[data-i]');
  if (!items.length) return;
  items[sel]?.classList.remove('sel');
  sel = Math.max(0, Math.min(items.length - 1, i));
  items[sel].classList.add('sel');
  items[sel].scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', (e) => {
  if (els.viewer.open) {
    if (e.key === 'ArrowLeft') turnPage(-1);
    else if (e.key === 'ArrowRight') turnPage(1);
    else if (e.key === 'n' || e.key === 'Enter') { e.preventDefault(); nextMark(); }
    return;
  }
  if (els.manage.open) return;
  const inInput = document.activeElement === els.q;
  if (e.key === '/' && !inInput) { e.preventDefault(); els.q.focus(); els.q.select(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(sel + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(sel - 1); }
  else if (e.key === 'Enter' && current.hits.length) {
    e.preventDefault();
    openViewer(current.hits[sel >= 0 ? sel : 0]);
    els.q.blur();
  } else if (e.key === 'Escape' && inInput && els.q.value) { e.preventDefault(); els.q.value = ''; runSearch(); }
});

els.vPrev.addEventListener('click', () => turnPage(-1));
els.vNext.addEventListener('click', () => turnPage(1));
els.vMarkNext.addEventListener('click', nextMark);
els.vClose.addEventListener('click', () => els.viewer.close());
els.viewer.addEventListener('close', () => { if (matchMedia('(pointer:fine)').matches) els.q.focus(); });

els.manageBtn.addEventListener('click', () => els.manage.showModal());
els.mClose.addEventListener('click', () => els.manage.close());
els.fileInput.addEventListener('change', () => { ingest(els.fileInput.files).finally(() => { els.fileInput.value = ''; }); });
els.drop.addEventListener('dragover', (e) => { e.preventDefault(); els.drop.classList.add('over'); });
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (e) => { e.preventDefault(); els.drop.classList.remove('over'); ingest(e.dataTransfer.files); });
els.docList.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  const d = docs[+b.dataset.del];
  if (!confirm(`¿Quitar «${d.name}»?`)) return;
  await dbOp((s) => s.delete(d.key));
  docs.splice(+b.dataset.del, 1);
  await rebuildIndex();
});
els.clearLocal.addEventListener('click', async () => {
  if (!confirm('¿Borrar todos los PDFs cargados en este dispositivo?')) return;
  await dbOp((s) => s.clear());
  docs = docs.filter((d) => d.source !== 'local');
  await rebuildIndex();
});

init().then(() => { if (mode === 'sem') setMode('sem'); }).catch((e) => { console.error(e); els.status.textContent = 'Error al cargar: ' + e.message; });
