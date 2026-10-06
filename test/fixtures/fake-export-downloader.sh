#!/bin/bash
# Fake tools/export_downloader.sh for the tests (unit, e2e, bundle): same arguments, no network.
#   <app> <version> [-o out.zip] [-x]
# The mode comes from the application name (the runner passes no environment of its own):
#   fail  → prints "[ERROR] fallo simulado" and exits 3
#   slow  → sleeps 60 s (cancel / timeout tests)
#   leak  → prints the password it got in EXPORT_PASSWORD (the runner must redact it)
#   other → writes the zip (-o) with <app>-<version>/conanfile.py and export.tgz (or src/main.c with -x), exits 0
set -e
[ $# -lt 2 ] && { echo "Usage: $0 <application> <version> [-o output.zip] [-x]"; exit 1; }
APP="$1"
VERSION="$2"
shift 2
OUT="${APP}-${VERSION}_exports.zip"
EXTRACT=false
while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT="$2"; shift 2 ;;
    -x) EXTRACT=true; shift ;;
    *) echo "Usage"; exit 1 ;;
  esac
done
for a in "$APP" "$VERSION" "-o" "$OUT"; do echo "ARG $a"; done
$EXTRACT && echo "ARG -x"
echo "PWD=$PWD"
echo "HOME=$HOME"
echo "EXPORT_USER=${EXPORT_USER:-}"
if [ -n "${EXPORT_PASSWORD:-}" ]; then echo "PSW_SET=yes"; else echo "PSW_SET=no"; fi
echo "ENV_KEYS=$(env | cut -d= -f1 | grep -v '^_$' | sort | tr '\n' ' ')"
case "$APP" in
  fail)
    echo "[ERROR] fallo simulado"
    exit 3
    ;;
  slow)
    trap 'echo "TERM recibido"; exit 143' TERM
    echo "esperando…"
    sleep 60 &
    wait $!
    exit 0
    ;;
  leak)
    echo "curl -u downloader:${EXPORT_PASSWORD:-} http://x"
    echo "la contraseña es ${EXPORT_PASSWORD:-}"
    echo "EXPORT_PASSWORD=${EXPORT_PASSWORD:-}"
    ;;
esac
printf 'Downloading tools...\r 10%%\r 50%%\r100%%\n'
printf '\033[32m✓ Tools configured correctly\033[0m\n'
echo "Creating $OUT..."
STAGE="$(mktemp -d "$PWD/exports_work.XXXXXX")"
mkdir -p "$STAGE/$APP-$VERSION"
echo "from conan import ConanFile" >"$STAGE/$APP-$VERSION/conanfile.py"
if $EXTRACT; then
  mkdir -p "$STAGE/$APP-$VERSION/src"
  echo "int main(void){return 0;}" >"$STAGE/$APP-$VERSION/src/main.c"
else
  echo "tgz" >"$STAGE/$APP-$VERSION/export.tgz"
fi
OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
if command -v python3 >/dev/null 2>&1; then
  python3 - "$STAGE" "$OUT_ABS" <<'PY'
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w") as z:
    for d, _, files in os.walk(stage):
        for f in files:
            full = os.path.join(d, f)
            z.write(full, os.path.relpath(full, stage))
PY
elif command -v zip >/dev/null 2>&1; then
  (cd "$STAGE" && zip -qr "$OUT_ABS" .)
else
  # An empty zip (end of central directory only).
  printf 'PK\005\006\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000' >"$OUT_ABS"
fi
rm -rf "$STAGE"
echo "All available exports packed successfully in $OUT!"
