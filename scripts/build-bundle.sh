#!/usr/bin/env bash
# Paquete sin conexión de Relay Manager (§9.3):
#   pnpm bundle   =  bash scripts/build-bundle.sh [--skip-tests] [--docker] [--perfil DIR]
# Resultado: dist/relay-manager-<versión>-linux-x64.tar.gz (+ .sha256) y, con --docker,
# dist/relay-manager-image-<versión>.tar.gz, dist/compose.yaml y dist/99-relay-manager.rules.
# --perfil DIR: el perfil del proyecto (perfil.env, plantillas/, herramientas/…) va dentro del paquete como perfil/
# (lo usan el modo portátil y install.sh; con --docker también se copia a dist/perfil, junto a compose.yaml). La imagen
# Docker nunca lo lleva dentro. Sin --perfil, el paquete es genérico: sin perfil. El nombre del paquete no cambia:
# un paquete con perfil sobrescribe al genérico de la misma versión en dist/.
# Se ejecuta en el equipo de desarrollo (Ubuntu 24.04 x86_64 con Internet); el destino no necesita nada.
set -euo pipefail
cd "$(dirname "$0")/.."

SKIP_TESTS=0
WITH_DOCKER=0
PROFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-tests) SKIP_TESTS=1 ;;
    --docker) WITH_DOCKER=1 ;;
    --perfil)
      [ $# -ge 2 ] || { echo "Falta la carpeta tras --perfil" >&2; exit 2; }
      PROFILE=$2
      shift
      ;;
    --perfil=*) PROFILE=${1#--perfil=} ;;
    -h | --help)
      echo "Uso: bash scripts/build-bundle.sh [--skip-tests] [--docker] [--perfil DIR]"
      exit 0
      ;;
    *)
      echo "Opción desconocida: $1" >&2
      exit 2
      ;;
  esac
  shift
done
# Relative to where it was run from (the script works from the repo root).
if [ -n "$PROFILE" ]; then
  [ -d "$PROFILE" ] || { echo "--perfil $PROFILE: no existe esa carpeta" >&2; exit 2; }
  PROFILE="$(cd "$PROFILE" && pwd -P)"
  [ -f "$PROFILE/perfil.env" ] || [ -d "$PROFILE/plantillas" ] ||
    { echo "--perfil $PROFILE no parece un perfil: le faltan perfil.env y la carpeta plantillas/" >&2; exit 2; }
fi

NODE_VERSION="22.23.2"
ARCH="linux-x64"
MAX_TARBALL_MB=120
VERSION="$(node -p "require('./package.json').version")"
GIT_REV="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)"
EPOCH="$(date +%s)"
NAME="relay-manager-${VERSION}-${ARCH}"
OUT="dist/${NAME}"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/relay-manager"
export NEXT_TELEMETRY_DISABLED=1 CHECKPOINT_DISABLE=1 PRISMA_HIDE_UPDATE_MESSAGE=1
# Dev-only switches must never reach a production build.
unset RM_DEV RM_NEXT_DIST_DIR

step() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2
  exit 1
}

# Secret guard (steps 6b and 11b): the bundle must never carry runtime data or local config. The profile (perfil/, only
# with --perfil) is the project's on purpose, credentials of its scripts included: not looked at.
secret_guard() {
  local found
  found="$(find "$OUT" -path "$OUT/perfil" -prune -o \( -name auth-secret -o -name setup-token -o -name .instance-lock -o -name '*.db' -o -name '*.db-wal' \
    -o -name 'config.env' -o -path '*/data' -o -path '*/.data*' -o -path '*/.next-*' \) -print)"
  if [ -n "$found" ]; then
    printf '%s\n' "$found" >&2
    die "El paquete contiene datos locales o secretos (ver la lista): no se publica"
  fi
}

step "1/13 Dependencias (lockfile)"
# shellcheck disable=SC2086 # PNPM_OFFLINE adds a flag on purpose
pnpm install --frozen-lockfile ${PNPM_OFFLINE:+--offline}
compgen -G "src/fonts/*.woff2" >/dev/null || die "Faltan las fuentes en src/fonts/: ejecuta pnpm fonts:vendor"

step "2/13 Cliente Prisma y comprobaciones"
pnpm prisma generate
pnpm db:check
if [ "$SKIP_TESTS" = 0 ]; then
  pnpm typecheck
  pnpm lint
  pnpm test
else
  echo "    (--skip-tests: sin typecheck, lint ni tests)"
fi

step "3/13 next build"
rm -rf .next
RM_BUILD_ID="${VERSION}-${GIT_REV}-${EPOCH}" pnpm next build

step "4/13 Servidor (esbuild)"
RM_BUILD_REV="$GIT_REV" node scripts/esbuild.server.mjs

step "5/13 Montaje de app/"
rm -rf "$OUT" "dist/${NAME}.tar.gz" "dist/${NAME}.tar.gz.sha256"
mkdir -p "$OUT"
cp -a .next/standalone "$OUT/app"
cp -a .next/static "$OUT/app/.next/static"
if [ -d public ]; then cp -a public "$OUT/app/public"; else mkdir -p "$OUT/app/public"; fi
mkdir -p "$OUT/app/prisma"
cp -a prisma/migrations "$OUT/app/prisma/"
cp build/server.js build/server.js.map build/rootcopy.js "$OUT/app/"

step "6/13 Dependencias del servidor (nft)"
node scripts/trace-server.mjs build/server.js "$OUT/app"
rm -f "$OUT"/app/.env*
secret_guard

step "7/13 Poda"
(
  cd "$OUT/app/node_modules"
  rm -rf .pnpm/typescript@* typescript .pnpm/@img+* .pnpm/sharp@* sharp @img .pnpm/node_modules/sharp .pnpm/node_modules/@img .pnpm/node_modules/typescript
)
for d in "$OUT"/app/node_modules/.pnpm/@serialport+bindings-cpp@*/node_modules/@serialport/bindings-cpp/prebuilds/*; do
  [ -e "$d" ] || continue
  [ "$(basename "$d")" = "$ARCH" ] || rm -rf "$d"
done
rm -f "$OUT"/app/node_modules/.pnpm/@serialport+bindings-cpp@*/node_modules/@serialport/bindings-cpp/prebuilds/"$ARCH"/*musl*
find "$OUT/app/node_modules" -xtype l -delete

step "8/13 Node.js ${NODE_VERSION} (oficial, sha256 verificado, en caché)"
mkdir -p "$CACHE"
TARBALL="node-v${NODE_VERSION}-${ARCH}.tar.xz"
SUMS="$CACHE/SHASUMS256-${NODE_VERSION}.txt"
if [ ! -f "$CACHE/$TARBALL" ] || [ ! -f "$SUMS" ]; then
  curl -fsSLo "$CACHE/$TARBALL.part" "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}"
  curl -fsSLo "$SUMS" "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  mv "$CACHE/$TARBALL.part" "$CACHE/$TARBALL"
fi
(cd "$CACHE" && grep " ${TARBALL}\$" "$(basename "$SUMS")" | sha256sum --quiet -c -) || die "La suma sha256 de $TARBALL no coincide (borra $CACHE y repite)"
mkdir -p "$OUT/node"
tar -xJf "$CACHE/$TARBALL" -C "$OUT/node" --strip-components=1 "node-v${NODE_VERSION}-${ARCH}/bin/node" "node-v${NODE_VERSION}-${ARCH}/LICENSE"

step "9/13 Ficheros de instalación"
install -D -m 0755 packaging/linux/relay-manager "$OUT/bin/relay-manager"
install -m 0755 packaging/linux/install.sh packaging/linux/uninstall.sh "$OUT/"
install -D -m 0644 packaging/linux/relay-manager.service "$OUT/systemd/relay-manager.service"
install -D -m 0644 packaging/linux/relay-manager-rootcopy.socket "$OUT/systemd/relay-manager-rootcopy.socket"
install -D -m 0644 packaging/linux/relay-manager-rootcopy.service "$OUT/systemd/relay-manager-rootcopy.service"
# «Montar / Expulsar» pendrives: the mount helper (same app/rootcopy.js, argument "mount").
install -D -m 0644 packaging/linux/relay-manager-rootmount.socket "$OUT/systemd/relay-manager-rootmount.socket"
install -D -m 0644 packaging/linux/relay-manager-rootmount.service "$OUT/systemd/relay-manager-rootmount.service"
install -D -m 0644 packaging/linux/99-relay-manager.rules "$OUT/udev/99-relay-manager.rules"
install -m 0644 packaging/linux/config.env.example "$OUT/config.env.example"
install -D -m 0644 packaging/docker/Dockerfile "$OUT/docker/Dockerfile"
install -D -m 0644 packaging/docker/compose.yaml "$OUT/docker/compose.yaml"
if compgen -G "docs/*.md" >/dev/null; then
  mkdir -p "$OUT/docs"
  cp docs/*.md "$OUT/docs/"
  # The JSON Schema of the template files (plantillas/*.json), linked from the profile guide.
  if [ -f docs/plantilla.schema.json ]; then cp docs/plantilla.schema.json "$OUT/docs/"; fi
  [ -f docs/INSTALACION.md ] && cp docs/INSTALACION.md "$OUT/LEEME-INSTALACION.md"
else
  echo "    Aviso: docs/ ausente (la documentación la escribe W3-D); el paquete sale sin guías"
fi

# The project profile (--perfil): as it is (modes kept), without version-control leftovers. A generic bundle has
# none, and never project scripts under app/.
if [ -n "$PROFILE" ]; then
  mkdir -p "$OUT/perfil"
  tar -C "$PROFILE" --exclude=.git --exclude=.gitignore --exclude=.gitattributes --exclude=.hg --exclude=.svn \
    --exclude='*~' --exclude='*.swp' --exclude=.DS_Store -cf - . | tar -C "$OUT/perfil" -xpf -
  echo "    perfil/: $PROFILE ($(find "$OUT/perfil/plantillas" -mindepth 1 -maxdepth 1 -name '*.json' 2>/dev/null | wc -l) plantillas)"
fi
[ ! -e "$OUT/app/tools" ] || die "app/tools/ no debe ir en el paquete (los scripts del proyecto van en el perfil)"
[ -n "$PROFILE" ] || [ ! -e "$OUT/perfil" ] || die "El paquete genérico no debe llevar perfil/"

step "10/13 Metadatos"
printf '%s\n' "$VERSION" >"$OUT/VERSION"
printf 'version=%s\nrev=%s\nnode=%s\nbuilt=%s\nperfil=%s\n' "$VERSION" "$GIT_REV" "$NODE_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$([ -n "$PROFILE" ] && basename "$PROFILE" || echo no)" >"$OUT/BUILDINFO"
(cd "$OUT" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum) >"$OUT/SHA256SUMS"

step "11/13 Prueba rápida"
ABS_OUT="$(cd "$OUT" && pwd)"
"$OUT/node/bin/node" -e "
  const r = require('module').createRequire('$ABS_OUT/app/server.js');
  new (r('better-sqlite3'))(':memory:').close();
  r('serialport');
  console.log('    módulos nativos: ok');
" || die "El node incluido no carga better-sqlite3 o serialport desde app/node_modules"
SMOKE_DATA="$(mktemp -d)"
RM_DATA_DIR="$SMOKE_DATA" "$OUT/bin/relay-manager" version
[ -z "$(ls -A "$SMOKE_DATA")" ] || die "version ha creado ficheros en el directorio de datos"
if [ -n "$PROFILE" ]; then
  # The embedded profile, as portable mode finds it (perfil/ next to app/): its templates must be valid.
  RM_DATA_DIR="$SMOKE_DATA" "$OUT/bin/relay-manager" plantillas comprobar | sed 's/^/    /' ||
    die "El perfil tiene errores (relay-manager plantillas comprobar): corrígelo antes de empaquetarlo"
  for s in "$OUT"/perfil/herramientas/*.sh; do
    [ -e "$s" ] || continue
    bash -n "$s" || die "perfil/herramientas/$(basename "$s") no es bash válido"
  done
  rm -rf "${SMOKE_DATA:?}"/*
fi
rmdir "$SMOKE_DATA"
secret_guard

step "12/13 Tarball"
tar -C dist -czf "dist/${NAME}.tar.gz" "$NAME"
(cd dist && sha256sum "${NAME}.tar.gz" >"${NAME}.tar.gz.sha256")
SIZE_MB=$(($(stat -c %s "dist/${NAME}.tar.gz") / 1024 / 1024))
du -sh "$OUT" "dist/${NAME}.tar.gz"
[ "$SIZE_MB" -lt "$MAX_TARBALL_MB" ] || die "El tarball ocupa ${SIZE_MB} MB (máximo ${MAX_TARBALL_MB} MB)"

# iproute2 for the image ("Red de equipos": the app runs `ip`; ubuntu:24.04 has no iproute2). The .deb files are
# downloaded once on this machine (with Internet) from the Ubuntu archive, checked against the SHA256 apt gives, and
# cached in build/debs-cache/, so later builds are offline. The image build itself stays offline (--network none).
DEBS_CACHE="build/debs-cache"
fetch_iproute_debs() {
  local manifest="$DEBS_CACHE/SHA256SUMS"
  if [ -f "$manifest" ] && (cd "$DEBS_CACHE" && sha256sum --quiet -c SHA256SUMS) 2>/dev/null; then
    echo "    iproute2: .deb en caché ($DEBS_CACHE)"
    return 0
  fi
  docker image inspect ubuntu:24.04 >/dev/null 2>&1 || docker pull ubuntu:24.04 >/dev/null ||
    die "No se puede obtener la imagen ubuntu:24.04 para descargar iproute2 (hace falta Internet la primera vez)"
  rm -rf "$DEBS_CACHE"
  mkdir -p "$DEBS_CACHE"
  docker run --rm -v "$PWD/$DEBS_CACHE":/out -e UIDGID="$(id -u):$(id -g)" ubuntu:24.04 bash -euo pipefail -c '
      apt-get update -qq >/dev/null
      apt-get install -y -qq --no-install-recommends --print-uris iproute2 | grep "^'"'"'http" >/out/uris.txt
      cd /out
      # The SHA256 of each package comes from the signed archive index (apt-cache show), not from the download.
      while read -r url file size sum; do
        pkg=${file%%_*}
        ver=${file#*_}
        ver=${ver%_*.deb}
        ver=${ver//%3a/:}
        sha=$(apt-cache show "$pkg=$ver" | awk "/^SHA256:/ { print \$2; exit }")
        [ -n "$sha" ]
        apt-get download -qq -o APT::Sandbox::User=root "$pkg=$ver" >/dev/null
        printf "%s  %s\n" "$sha" "$file"
      done </out/uris.txt >/out/SHA256SUMS
      rm -f /out/uris.txt
      chown -R "$UIDGID" /out' ||
    die "No se pudieron descargar los paquetes de iproute2 para la imagen Docker (¿sin Internet?). La imagen necesita la orden ip para la red de equipos: repite con conexión (se guardan en $DEBS_CACHE)."
  (cd "$DEBS_CACHE" && sha256sum --quiet -c SHA256SUMS) || die "Las sumas SHA256 de los .deb de iproute2 no coinciden: borra $DEBS_CACHE y repite"
  grep -q ' iproute2_' "$DEBS_CACHE/SHA256SUMS" || die "Falta iproute2 entre los .deb descargados ($DEBS_CACHE)"
  for f in "$DEBS_CACHE"/*.deb; do dpkg-deb --info "$f" >/dev/null 2>&1 || die "Paquete dañado: $f"; done
  echo "    iproute2: $(grep -c '\.deb$' "$DEBS_CACHE/SHA256SUMS") .deb descargados y verificados"
}

if [ "$WITH_DOCKER" = 1 ]; then
  step "13/13 Imagen Docker"
  fetch_iproute_debs
  # Only in the Docker build context (after the tarball: the offline bundle does not carry them).
  rm -rf "$OUT/docker/debs"
  mkdir -p "$OUT/docker/debs"
  cp "$DEBS_CACHE"/*.deb "$OUT/docker/debs/"
  # The profile (and anything local) never reaches the image nor the build context: compose.yaml mounts it at /perfil.
  printf 'perfil\ndata\nconfig.env\n' >"$OUT/.dockerignore"
  # No network: the image is built from the bundle only (no apt), so it also builds on an offline host.
  docker build --network none -f "$OUT/docker/Dockerfile" -t "relay-manager:${VERSION}" "$OUT"
  docker save "relay-manager:${VERSION}" | gzip -1 >"dist/relay-manager-image-${VERSION}.tar.gz"
  cp "$OUT/docker/compose.yaml" dist/compose.yaml
  # compose.yaml mounts ./perfil (RM_PROFILE_HOST_DIR): the bundle's profile next to it, or none.
  rm -rf dist/perfil
  if [ -d "$OUT/perfil" ]; then cp -a "$OUT/perfil" dist/perfil; fi
  cp "$OUT/udev/99-relay-manager.rules" dist/99-relay-manager.rules
  (cd dist && sha256sum "relay-manager-image-${VERSION}.tar.gz" >"relay-manager-image-${VERSION}.tar.gz.sha256")
  du -sh "dist/relay-manager-image-${VERSION}.tar.gz"
else
  step "13/13 Imagen Docker omitida (usa --docker)"
fi

step "Listo: dist/${NAME}.tar.gz"
