#!/bin/sh
# Restringe el file picker del cliente LibreChat a Excel (.xlsx/.xls).
# "Upload to Provider" viene hardcoded a image/pdf/video en el bundle; este script
# reescribe el atributo accept en los assets compilados al arrancar el contenedor.
set -eu

EXCEL_ACCEPT='.xlsx,.xls,.xlsm'

ASSETS_DIR="/app/client/dist/assets"
if [ ! -d "$ASSETS_DIR" ]; then
  echo "[sg-excel-picker] No hay $ASSETS_DIR; se omite el patch"
  exit 0
fi

patched=0
for f in "$ASSETS_DIR"/index.*.js; do
  [ -f "$f" ] || continue
  # Copia escribible si el archivo es de solo lectura por capa de imagen
  if [ ! -w "$f" ]; then
    tmp="${f}.sgtmp"
    cp "$f" "$tmp"
    mv "$tmp" "$f"
  fi

  python3 - "$f" "$EXCEL_ACCEPT" <<'PY' || true
import sys
path, excel = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8", errors="ignore") as fh:
    s = fh.read()
orig = s

# Google / OpenRouter: image+pdf+video+audio
s = s.replace(
    "image/*,.heif,.heic,.pdf,application/pdf,video/*,audio/*",
    excel,
)
# Otros providers documento+imagen
s = s.replace(
    "image/*,.heif,.heic,.pdf,application/pdf",
    excel,
)
# Solo PDF
s = s.replace(
    ".pdf,application/pdf",
    excel,
)
# Solo imagen
s = s.replace(
    "image/*,.heif,.heic",
    excel,
)

# accept vacío antes del click (File Search / permissive / default) → Excel
# Evitar tocar el reset posterior p.current.accept=``, tras click.
needle = "p.current.accept=``,p.current.click()"
repl = f"p.current.accept=`{excel}`,p.current.click()"
s = s.replace(needle, repl)
# Variante con comillas simples en algunos builds
needle2 = "p.current.accept='',p.current.click()"
repl2 = f"p.current.accept='{excel}',p.current.click()"
s = s.replace(needle2, repl2)

if s != orig:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(s)
    print(f"[sg-excel-picker] Patched {path}")
    sys.exit(0)
print(f"[sg-excel-picker] Sin cambios en {path}")
sys.exit(0)
PY
  patched=$((patched + 1))
done

echo "[sg-excel-picker] Archivos revisados: $patched"
