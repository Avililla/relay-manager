#!/usr/bin/env bash
# Prueba del paquete sin conexión (§11.5):  pnpm test:bundle  =  bash scripts/test-bundle.sh [opciones]
#   (sin opciones)  modo portátil en ubuntu:24.04 --network none: arranque, ping, setup-token, usuario por CLI,
#                   acceso, Origin, SSE, WS 4004, doctor = 0, SIGTERM < 8 s y reinicio con datos persistentes
#   --systemd       (P2) instalación nativa con systemd: install.sh, actualización, rollback y uninstall.sh
#   --debian        además, Debian 12 (bookworm, el PC del banco): modo portátil y, con --systemd, la instalación nativa
#   --upgrade-chain  actualizaciones en Debian 12 con systemd desde versiones publicadas (scripts/test-bundle/upgrade-chain*):
#                   2.2.2 → 2.3.0 → esta y 2.2.2 → esta con datos de prueba y las claves antiguas que renombra el perfil;
#                   con RM_TEST_REAL_SNAPSHOT=<carpeta> (relay-manager.db + config.env.txt [+ rootcopy.env.txt] de un
#                   banco real, nunca en el repositorio), además 2.3.0 (RM_TEST_REAL_BASE) → esta con esos datos.
#                   Paquetes antiguos en RM_TEST_OLD_BUNDLES (por defecto ../relay-manager-dist/<versión>/);
#                   --only-upgrade-chain: solo esto
#   --docker        imagen Docker: raíz de solo lectura, el servidor solo con CAP_NET_ADMIN, ip, doctor y las mismas comprobaciones HTTP
#   --rebuild       vuelve a construir el paquete aunque exista
#   --perfil DIR    perfil del proyecto con el que se prueba (portátil: copiado en perfil/; servicio: install.sh
#                   --perfil; Docker: montado en /perfil). Por defecto, el que trae el paquete (construido con
#                   build-bundle.sh --perfil) o, si no trae ninguno, examples/perfil-ejemplo
#   --sin-perfil    sin perfil (valores genéricos; solo con un paquete que no trae perfil)
#   RM_TEST_EXPORT_RUN=0|1  ejecutar el script de descarga del perfil (por defecto, 1 solo con examples/perfil-ejemplo:
#                   los de un proyecto suelen necesitar su red)
set -euo pipefail
cd "$(dirname "$0")/.."

RUN_PORTABLE=1
RUN_SYSTEMD=0
RUN_DOCKER=0
RUN_DEBIAN=0
RUN_UPGRADE=0
REBUILD=0
PROFILE_ARG=""
NO_PROFILE=0
while [ $# -gt 0 ]; do
  arg=$1
  shift
  case "$arg" in
    --perfil)
      [ $# -ge 1 ] || { echo "Falta la carpeta tras --perfil" >&2; exit 2; }
      PROFILE_ARG=$1
      shift
      ;;
    --perfil=*) PROFILE_ARG=${arg#--perfil=} ;;
    --sin-perfil) NO_PROFILE=1 ;;
    --systemd) RUN_SYSTEMD=1 ;;
    --debian) RUN_DEBIAN=1 ;;
    --docker) RUN_DOCKER=1 ;;
    --upgrade-chain) RUN_UPGRADE=1 ;;
    --only-upgrade-chain) RUN_UPGRADE=1 RUN_PORTABLE=0 ;;
    --only-systemd) RUN_SYSTEMD=1 RUN_PORTABLE=0 ;;
    --only-docker) RUN_DOCKER=1 RUN_PORTABLE=0 ;;
    --rebuild) REBUILD=1 ;;
    -h | --help)
      sed -n '2,21p' "$0"
      exit 0
      ;;
    *)
      echo "Opción desconocida: $arg" >&2
      exit 2
      ;;
  esac
done

VERSION="$(node -p "require('./package.json').version")"
NAME="relay-manager-${VERSION}-linux-x64"
IMAGE="${RM_TEST_IMAGE:-ubuntu:24.04}"
step() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2
  exit 1
}

# 1. Bundle (built only if missing) and the smoke client (ws and ssh2 inlined).
if [ "$REBUILD" = 1 ] || [ ! -f "dist/${NAME}.tar.gz" ]; then
  step "Construyendo el paquete (no existe dist/${NAME}.tar.gz)"
  bash scripts/build-bundle.sh --skip-tests
fi
step "Cliente de prueba (esbuild)"
mkdir -p dist/test
# ssh2 (the equipment SSH server of «Enviar a equipo») is inlined like ws; its optional native cpu-features stays out.
pnpm exec esbuild scripts/test-bundle/smoke-client.ts --bundle --platform=node --target=node22 --format=cjs \
  --external:cpu-features --outfile=dist/test/smoke-client.cjs --log-level=warning
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "Falta la imagen $IMAGE en el almacén local de Docker"

# The profile under test. PROFILE = a folder of this machine handed to every run ("" = the bundle's own, or none).
EMBEDDED=0
if tar -tzf "dist/${NAME}.tar.gz" "${NAME}/perfil" >/dev/null 2>&1; then EMBEDDED=1; fi
PROFILE=""
if [ "$NO_PROFILE" = 1 ]; then
  [ "$EMBEDDED" = 0 ] || die "--sin-perfil: dist/${NAME}.tar.gz trae perfil/ (constrúyelo sin --perfil)"
  [ -z "$PROFILE_ARG" ] || die "--perfil y --sin-perfil a la vez"
elif [ -n "$PROFILE_ARG" ]; then
  [ -d "$PROFILE_ARG" ] || die "--perfil $PROFILE_ARG: no existe esa carpeta"
  PROFILE="$(cd "$PROFILE_ARG" && pwd -P)"
elif [ "$EMBEDDED" = 0 ]; then
  [ -d examples/perfil-ejemplo ] || die "Falta examples/perfil-ejemplo (o usa --perfil DIR / --sin-perfil)"
  PROFILE="$(cd examples/perfil-ejemplo && pwd -P)"
fi
if [ -z "${RM_TEST_EXPORT_RUN:-}" ]; then
  RM_TEST_EXPORT_RUN=0
  if [ -n "$PROFILE" ] && [ "$PROFILE" = "$(cd examples/perfil-ejemplo 2>/dev/null && pwd -P)" ]; then RM_TEST_EXPORT_RUN=1; fi
fi
export RM_TEST_EXPORT_RUN
# Readable by the containers' users (a copy: the original's modes are left alone).
PROFILE_COPY=""
if [ -n "$PROFILE" ]; then
  PROFILE_COPY="dist/test/perfil-prueba"
  rm -rf "$PROFILE_COPY"
  mkdir -p "$PROFILE_COPY"
  tar -C "$PROFILE" --exclude=.git -cf - . | tar -C "$PROFILE_COPY" -xf -
  chmod -R a+rX "$PROFILE_COPY"
  step "Perfil de la prueba: $PROFILE (ejecutar su script de descarga: $RM_TEST_EXPORT_RUN)"
elif [ "$EMBEDDED" = 1 ]; then
  step "Perfil de la prueba: el del paquete (ejecutar su script de descarga: $RM_TEST_EXPORT_RUN)"
else
  step "Sin perfil (valores genéricos)"
fi
if [ -n "$PROFILE" ]; then
  PORTABLE_PROFILE=(-v "$PWD/$PROFILE_COPY":/perfil-prueba:ro -e RM_TEST_PROFILE=/perfil-prueba)
elif [ "$NO_PROFILE" = 1 ]; then
  PORTABLE_PROFILE=(-e RM_TEST_PROFILE=-)
else
  PORTABLE_PROFILE=(-e RM_TEST_PROFILE=)
fi

# 2. Portable mode in a clean, offline container.
if [ "$RUN_PORTABLE" = 1 ]; then
  step "Modo portátil en $IMAGE --network none"
  docker run --rm --network none -e RM_ALLOW_ROOT=1 -e RM_SMOKE_SKIP="${RM_SMOKE_SKIP:-}" -e RM_TEST_EXPORT_RUN \
    "${PORTABLE_PROFILE[@]}" -v "$PWD/dist":/dist:ro -v "$PWD/scripts/test-bundle":/t:ro \
    "$IMAGE" bash /t/portable.sh "$NAME"
  if [ "$RUN_DEBIAN" = 1 ]; then
    docker image inspect debian:12 >/dev/null 2>&1 || die "Falta la imagen debian:12 en el almacén local de Docker (docker pull debian:12)"
    step "Modo portátil en debian:12 --network none"
    docker run --rm --network none -e RM_ALLOW_ROOT=1 -e RM_SMOKE_SKIP="${RM_SMOKE_SKIP:-}" -e RM_TEST_EXPORT_RUN \
      "${PORTABLE_PROFILE[@]}" -v "$PWD/dist":/dist:ro -v "$PWD/scripts/test-bundle":/t:ro \
      debian:12 bash /t/portable.sh "$NAME"
  fi
fi

# 3. (P2) Native install under systemd.
if [ "$RUN_SYSTEMD" = 1 ]; then
  step "Instalación nativa con systemd (P2)"
  bash scripts/test-bundle/native-host.sh "$NAME" ubuntu "$PROFILE_COPY"
  if [ "$RUN_DEBIAN" = 1 ]; then
    step "Instalación nativa con systemd en Debian 12 (bookworm)"
    bash scripts/test-bundle/native-host.sh "$NAME" debian "$PROFILE_COPY"
  fi
fi

# Upgrades from published versions on Debian 12 (the bench).
if [ "$RUN_UPGRADE" = 1 ]; then
  step "Actualizaciones desde versiones publicadas (Debian 12, systemd)"
  bash scripts/test-bundle/upgrade-chain-host.sh "$NAME" "$PROFILE_COPY"
fi

# Docker image built from the bundle.
if [ "$RUN_DOCKER" = 1 ]; then
  step "Imagen Docker"
  # The profile mounted at /perfil: the test's, else the bundle's (extracted from the tarball), else none.
  DOCKER_PROFILE="$PROFILE_COPY"
  if [ -z "$DOCKER_PROFILE" ] && [ "$EMBEDDED" = 1 ]; then
    DOCKER_PROFILE="dist/test/perfil-paquete"
    rm -rf "$DOCKER_PROFILE" dist/test/perfil-extraido
    mkdir -p dist/test/perfil-extraido
    tar -xzf "dist/${NAME}.tar.gz" -C dist/test/perfil-extraido "${NAME}/perfil"
    mv "dist/test/perfil-extraido/${NAME}/perfil" "$DOCKER_PROFILE"
    rm -rf dist/test/perfil-extraido
    chmod -R a+rX "$DOCKER_PROFILE"
  fi
  bash scripts/test-bundle/docker-host.sh "$VERSION" "$DOCKER_PROFILE"
fi

step "Prueba del paquete superada"
