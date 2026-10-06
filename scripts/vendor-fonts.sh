#!/usr/bin/env bash
# Descarga una sola vez las fuentes Atkinson Hyperlegible Next y Mono (variables, subconjunto latin)
# desde el registro npm y las copia en src/fonts/ (§8.3). Los archivos resultantes se versionan:
# el paquete sin conexión no descarga nada.
#
# Requisitos: pnpm, curl, tar, openssl. `npm` no está en el PATH del equipo de desarrollo, por eso
# se usa `pnpm view` para resolver la URL y la integridad del paquete.
set -euo pipefail

VERSION="5.3.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/src/fonts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for bin in pnpm curl tar openssl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "Falta la orden «$bin» en el PATH." >&2; exit 2; }
done

mkdir -p "$DEST"

# vendor <paquete> <prefijo de archivo> <estilos…>
vendor() {
  local pkg="$1" base="$2"
  shift 2
  local url integrity expected actual dir
  url="$(pnpm view "${pkg}@${VERSION}" dist.tarball)"
  integrity="$(pnpm view "${pkg}@${VERSION}" dist.integrity)"
  case "$integrity" in
    sha512-*) expected="${integrity#sha512-}" ;;
    *) echo "Integridad inesperada para ${pkg}: ${integrity}" >&2; exit 3 ;;
  esac

  echo "Descargando ${pkg}@${VERSION}…"
  curl -fsSL "$url" -o "$TMP/pkg.tgz"
  actual="$(openssl dgst -sha512 -binary "$TMP/pkg.tgz" | base64 -w0)"
  if [ "$actual" != "$expected" ]; then
    echo "La suma sha512 de ${pkg} no coincide con el registro. Se aborta." >&2
    exit 4
  fi

  dir="$TMP/$base"
  mkdir -p "$dir"
  tar xzf "$TMP/pkg.tgz" -C "$dir"
  for style in "$@"; do
    local file="${base}-latin-wght-${style}.woff2"
    cp "$dir/package/files/$file" "$DEST/$file"
    echo "  src/fonts/$file"
  done
  cp "$dir/package/LICENSE" "$DEST/OFL-${base}.txt"
  echo "  src/fonts/OFL-${base}.txt"
  rm -f "$TMP/pkg.tgz"
}

vendor "@fontsource-variable/atkinson-hyperlegible-next" "atkinson-hyperlegible-next" normal italic
vendor "@fontsource-variable/atkinson-hyperlegible-mono" "atkinson-hyperlegible-mono" normal

echo "Fuentes copiadas en src/fonts/. Recuerda versionarlas."
