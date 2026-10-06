#!/usr/bin/env bash
# Script de descarga de ejemplo para Relay Manager («Descargas»).
# Contrato: descarga-ejemplo.sh <aplicación> <versión> -o <salida.zip> [-x]
# Lo ejecuta el servidor con bash, sin shell intermedio, en una carpeta de trabajo propia (HOME y TMPDIR) y con un
# entorno mínimo. Lo que escribe en la salida estándar y de error aparece en el registro de la descarga.
# Un script real descargaría la aplicación; este solo crea un .zip pequeño, sin red (python3, o zip, o un zip vacío).
# La aplicación «fallo» termina con error (para probar cómo se ve un fallo).
set -euo pipefail

app="${1:?falta la aplicación}"
version="${2:?falta la versión}"
shift 2
out=""
extra=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="${2:?falta la ruta de -o}"; shift 2 ;;
    -x) extra=1; shift ;;
    *) echo "[ERROR] Opción desconocida: $1" >&2; exit 2 ;;
  esac
done
[ -n "$out" ] || { echo "[ERROR] Falta -o <salida.zip>" >&2; exit 2; }

if [ "$app" = "fallo" ]; then
  echo "[ERROR] La aplicación «fallo» no existe (error de prueba)" >&2
  exit 3
fi

echo "Preparando ${app} ${version}…"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf '%s %s\n' "$app" "$version" > "$work/VERSION.txt"
[ "$extra" = 1 ] && printf 'Fichero extra (opción -x)\n' > "$work/EXTRA.txt"
if command -v python3 >/dev/null 2>&1; then
  python3 - "$out" "$work" <<'PY'
import os, sys, zipfile
out, work = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w") as z:
    for name in sorted(os.listdir(work)):
        z.write(os.path.join(work, name), name)
PY
elif command -v zip >/dev/null 2>&1; then
  (cd "$work" && zip -q -r "$out" .)
else
  # Un .zip vacío válido: solo el registro final (22 bytes).
  printf 'PK\005\006\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000' > "$out"
fi
echo "Creado $(basename "$out")"
