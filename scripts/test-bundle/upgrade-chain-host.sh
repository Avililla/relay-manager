#!/usr/bin/env bash
# Host side of the upgrade test on Debian 12 (bench PC). Called by scripts/test-bundle.sh --upgrade-chain.
#   upgrade-chain-host.sh <NAME> [<perfil de la prueba>]
# Each scenario runs in a fresh systemd container (--network none) with upgrade-chain.sh:
#   sintetico: <base> → <intermedias> → nueva     (RM_TEST_UPGRADE_CHAIN, por defecto "2.2.2 2.3.0")
#   sintetico: <base> → nueva                     (la primera de la cadena)
#   real:      RM_TEST_REAL_BASE (2.3.0) → nueva  (solo con RM_TEST_REAL_SNAPSHOT=<carpeta> con relay-manager.db y
#              config.env.txt [y rootcopy.env.txt] de una instalación real; se monta de solo lectura y no se copia)
# The old bundles come from RM_TEST_OLD_BUNDLES (default ../relay-manager-dist/<versión>/), the image is the one of
# native-host.sh (relay-manager-systemd-test:debian12, built once with Internet).
set -euo pipefail
cd "$(dirname "$0")/../.."
NAME="$1"
PROFILE="${2:-}"
VERSION="${NAME#relay-manager-}"
VERSION="${VERSION%-linux-x64}"
IMAGE_TAG="relay-manager-systemd-test:debian12"
OLD="${RM_TEST_OLD_BUNDLES:-$(cd .. && pwd)/relay-manager-dist}"
read -r -a CHAIN <<<"${RM_TEST_UPGRADE_CHAIN:-2.2.2 2.3.0}"
REAL_BASE="${RM_TEST_REAL_BASE:-2.3.0}"
SNAP="${RM_TEST_REAL_SNAPSHOT:-}"
WORK="dist/test/upgrade-chain"

NEW_TGZ="${RM_TEST_NEW_BUNDLE:-dist/${NAME}.tar.gz}" # another build of this version (e.g. a candidate) with RM_TEST_NEW_BUNDLE
[ -f "$NEW_TGZ" ] || { echo "Falta $NEW_TGZ" >&2; exit 1; }
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "    Construyendo $IMAGE_TAG (necesita Internet una vez)"
  docker build -q --build-arg BASE=debian:12 --build-arg EXTRA=python3 -f scripts/test-bundle/systemd.Dockerfile -t "$IMAGE_TAG" scripts/test-bundle >/dev/null
fi
rm -rf "$WORK"
mkdir -p "$WORK"
link_bundle() { # VERSION SOURCE.tar.gz
  [ -f "$2" ] || { echo "Falta el paquete $2 (RM_TEST_OLD_BUNDLES)" >&2; exit 1; }
  ln -f "$2" "$WORK/relay-manager-$1-linux-x64.tar.gz" 2>/dev/null || cp "$2" "$WORK/relay-manager-$1-linux-x64.tar.gz"
}
for v in "${CHAIN[@]}" $([ -n "$SNAP" ] && echo "$REAL_BASE"); do
  [ -f "$WORK/relay-manager-$v-linux-x64.tar.gz" ] || link_bundle "$v" "$OLD/$v/relay-manager-$v-linux-x64.tar.gz"
done
link_bundle "$VERSION" "$NEW_TGZ"

run() { # SCENARIO VERSIONS…
  local cid="rm-upgrade-test-$$-$1" mounts=() state
  if [ -n "$PROFILE" ]; then mounts+=(-v "$PWD/$PROFILE":/perfil-prueba:ro); fi
  if [ "$1" = real ]; then mounts+=(-v "$(cd "$SNAP" && pwd)":/snapshot:ro); fi
  docker rm -f "$cid" >/dev/null 2>&1 || true
  docker run -d --name "$cid" --privileged --cgroupns=host --network none \
    --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:rw "${mounts[@]}" \
    -v "$PWD/$WORK":/bundles:ro -v "$PWD/scripts/test-bundle":/t:ro "$IMAGE_TAG" >/dev/null
  for _ in $(seq 1 60); do
    state=$(docker exec "$cid" systemctl is-system-running 2>/dev/null || true)
    case "$state" in running | degraded) break ;; esac
    sleep 1
  done
  docker exec "$cid" mount --make-rshared /
  local rc=0
  docker exec -e RM_TEST_PROFILE="$([ -n "$PROFILE" ] && echo /perfil-prueba)" -e RM_TEST_DOCTOR_EXPECTED="${RM_TEST_DOCTOR_EXPECTED:-}" \
    "$cid" bash /t/upgrade-chain.sh "$@" || rc=$?
  docker rm -f "$cid" >/dev/null 2>&1 || true
  return "$rc"
}

trap 'docker ps -aq --filter "name=rm-upgrade-test-$$-" | xargs -r docker rm -f >/dev/null 2>&1 || true' EXIT
if [ -n "$SNAP" ]; then
  [ -f "$SNAP/relay-manager.db" ] && [ -f "$SNAP/config.env.txt" ] || { echo "RM_TEST_REAL_SNAPSHOT=$SNAP: faltan relay-manager.db o config.env.txt" >&2; exit 1; }
  echo "    Instantánea real: $REAL_BASE → $VERSION"
  run real "$REAL_BASE" "$VERSION"
else
  echo "    Sin RM_TEST_REAL_SNAPSHOT: no se reproduce una instalación real"
fi
echo "    Cadena: ${CHAIN[*]} → $VERSION"
run sintetico "${CHAIN[@]}" "$VERSION"
if [ "${#CHAIN[@]}" -gt 1 ]; then
  echo "    Directa: ${CHAIN[0]} → $VERSION"
  run sintetico "${CHAIN[0]}" "$VERSION"
fi
