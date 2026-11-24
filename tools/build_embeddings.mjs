// Genera los vectores semánticos de cada fragmento de los manuales.
// Lee data/index.json y escribe data/chunks.json + data/embeddings.bin (int8, normalizados).
// Uso: npm install @huggingface/transformers@3.8.1 && node tools/build_embeddings.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pipeline, env } from '@huggingface/transformers';

export const MODEL = 'Xenova/multilingual-e5-small';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const TARGET = 700;   // largo aproximado de cada fragmento (caracteres)
const OVERLAP = 150;  // solapamiento entre fragmentos consecutivos

env.allowLocalModels = false;

// Corta una página en fragmentos de ~TARGET caracteres, respetando saltos de línea y espacios.
function chunkPage(text) {
  const out = [];
  if (text.trim().length < 20) return out;
  let s = 0;
  while (s < text.length) {
    let e = Math.min(text.length, s + TARGET);
    if (e < text.length) {
      const nl = text.lastIndexOf('\n', e);
      const sp = text.lastIndexOf(' ', e);
      const cut = nl > s + TARGET * 0.6 ? nl : sp > s + TARGET * 0.6 ? sp : e;
      e = cut;
    }
    out.push([s, e]);
    if (e >= text.length) break;
    let ns = e - OVERLAP;
    const sp = text.indexOf(' ', ns);
    ns = sp > 0 && sp < e ? sp + 1 : ns;
    s = Math.max(ns, s + 1);
  }
  // Unir un último fragmento muy corto con el anterior
  if (out.length > 1 && out[out.length - 1][1] - out[out.length - 1][0] < 200) {
    const last = out.pop();
    out[out.length - 1][1] = last[1];
  }
  return out;
}

const { docs } = JSON.parse(readFileSync(join(DATA, 'index.json'), 'utf8'));
const chunks = [];
const texts = [];
docs.forEach((doc, d) => doc.pages.forEach((page, i) => {
  for (const [s, e] of chunkPage(page)) {
    chunks.push([d, i + 1, s, e]);
    texts.push('passage: ' + doc.name + '. ' + page.slice(s, e).replace(/\s+/g, ' '));
  }
}));
console.log(`${docs.length} documentos, ${chunks.length} fragmentos`);

const extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
const DIM = 384;
const out = new Int8Array(chunks.length * DIM);
const BATCH = 16;
for (let i = 0; i < texts.length; i += BATCH) {
  const t = await extractor(texts.slice(i, i + BATCH), { pooling: 'mean', normalize: true });
  const v = t.data;
  for (let j = 0; j < v.length; j++) out[i * DIM + j] = Math.max(-127, Math.min(127, Math.round(v[j] * 127)));
  if ((i / BATCH) % 10 === 0) process.stdout.write(`\r${Math.min(i + BATCH, texts.length)}/${texts.length}`);
}
console.log();

// Huella de los documentos para detectar si el índice cambió sin regenerar los vectores
const sig = docs.map((x) => x.name + ':' + x.pages.length).join('|');
writeFileSync(join(DATA, 'chunks.json'), JSON.stringify({ model: MODEL, dim: DIM, sig, chunks }));
writeFileSync(join(DATA, 'embeddings.bin'), Buffer.from(out.buffer));
console.log(`OK -> data/chunks.json, data/embeddings.bin (${(out.length / 1e6).toFixed(2)} MB)`);
