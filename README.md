# ExamenNeural: buscador de manuales

Página web para buscar al instante en todos los PDFs de la capacitación a la vez.

- Busca mientras escribís (milisegundos, incluso con miles de páginas).
- No importan **tildes ni mayúsculas**, y tolera errores de tipeo.
- Prefijos: `neur` encuentra «neuronal».
- Frase exacta: `"red neuronal"` · Excluir: `red -social`.
- **🧠 Modo Significado**: escribís la pregunta con tus palabras y encuentra los fragmentos que hablan de eso aunque usen otras palabras (combina significado + palabras exactas). La primera vez descarga un modelo de ~118 MB que queda guardado en el navegador; funciona todo en el dispositivo y no genera respuestas: solo ordena fragmentos de los manuales.
- Filtro por documento, con la cantidad de coincidencias en cada uno.
- Al tocar un resultado se ve la página completa con las palabras resaltadas; **‹ ›** cambia de página, **⤓** salta a la siguiente coincidencia y **Abrir PDF** abre el original en esa página.
- Atajos (en computadora): `/` buscar · `↑ ↓` moverse · `Enter` abrir · `n` siguiente coincidencia · `← →` cambiar de página · `Esc` cerrar.

## Cómo cargar los PDFs (dos opciones)

### Opción A: subirlos al repo (quedan online para cualquier dispositivo)
1. Desde el celular, entrá a github.com → este repo → carpeta **`pdfs/`** → **Add file → Upload files** y elegí los PDFs.
2. Al hacer *commit* en `main`, GitHub Actions extrae el texto (`tools/build_index.py`) y publica la página automáticamente.
3. Una sola vez: **Settings → Pages → Source: GitHub Actions**.

### Opción B: cargarlos directamente en el navegador
Abrí la página, tocá **📁 PDFs → Agregar PDFs** y elegí los archivos del celular. Se procesan en el dispositivo y quedan guardados en ese navegador (no se suben a ningún lado).

## Probarlo en la computadora
```bash
pip install pymupdf
python tools/build_index.py      # genera data/index.json a partir de pdfs/
npm install --no-save @huggingface/transformers@3.8.1 --onnxruntime-node-install-cuda=skip
node tools/build_embeddings.mjs  # genera data/chunks.json y data/embeddings.bin (modo Significado)
python -m http.server 8000      # abrir http://localhost:8000
```

> Si algún PDF es escaneado (solo imágenes, sin texto), el script lo avisa y esas páginas no van a aparecer en las búsquedas.
