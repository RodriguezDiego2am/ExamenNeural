#!/usr/bin/env python3
"""Extrae el texto de cada página de los PDFs en pdfs/ y genera data/index.json.

Uso:  python tools/build_index.py [carpeta_pdfs] [salida.json]
Requiere: pip install pymupdf
"""
import json
import re
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
PDF_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "pdfs"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "data" / "index.json"


def clean(text: str) -> str:
    text = text.replace("­", "")                 # guiones blandos
    text = re.sub(r"(\w)-\n(\w)", r"\1\2", text)      # palabras cortadas al final de línea
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def main() -> None:
    docs = []
    pdfs = sorted(PDF_DIR.rglob("*.pdf"), key=lambda p: str(p).lower())
    pdfs += sorted(PDF_DIR.rglob("*.PDF"), key=lambda p: str(p).lower())
    for path in pdfs:
        rel = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.name
        try:
            with pymupdf.open(path) as doc:
                pages = [clean(page.get_text("text")) for page in doc]
        except Exception as exc:  # PDF dañado o protegido
            print(f"!! No se pudo leer {path.name}: {exc}", file=sys.stderr)
            continue
        empty = sum(1 for p in pages if len(p) < 20)
        print(f"{path.name}: {len(pages)} páginas" + (f" ({empty} sin texto, ¿escaneadas?)" if empty else ""))
        docs.append({"name": path.stem, "file": rel, "pages": pages})

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"docs": docs}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    total = sum(len(d["pages"]) for d in docs)
    print(f"\nOK: {len(docs)} PDFs, {total} páginas -> {OUT}")


if __name__ == "__main__":
    main()
