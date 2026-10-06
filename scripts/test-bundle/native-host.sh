#!/usr/bin/env bash
# Host side of the native (systemd) install test, P2 (§11.5 step 3). Called by scripts/test-bundle.sh --systemd.
# Builds a systemd test image (once, with Internet), fabricates two upgrade bundles from the real one
# (2.0.0 → x.y.z+1 without migrations, x.y.z+2 with a dummy migration) and runs native.sh inside the
# container with --network none.
set -euo pipefail
cd "$(dirname "$0")/../.."
NAME="$1"
# Second argument: the base distribution (ubuntu, the default, or debian = Debian 12 bookworm, the bench PC).
DISTRO="${2:-ubuntu}"
# Third: the project profile to install with install.sh --perfil (a folder under the repo; "" = the bundle's own, if any).
PROFILE="${3:-}"
case "$DISTRO" in
  ubuntu) IMAGE_TAG="relay-manager-systemd-test:24.04"; BUILD_ARGS=() ;;
  debian) IMAGE_TAG="relay-manager-systemd-test:debian12"; BUILD_ARGS=(--build-arg BASE=debian:12 --build-arg EXTRA=python3) ;;
  *) echo "Distribución desconocida: $DISTRO (ubuntu o debian)" >&2; exit 2 ;;
esac
WORK="dist/test/native-$DISTRO"

[ -f "dist/${NAME}.tar.gz" ] || { echo "Falta dist/${NAME}.tar.gz" >&2; exit 1; }
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "    Construyendo $IMAGE_TAG (necesita Internet una vez)"
  docker build -q "${BUILD_ARGS[@]}" -f scripts/test-bundle/systemd.Dockerfile -t "$IMAGE_TAG" scripts/test-bundle >/dev/null
fi

VERSION="${NAME#relay-manager-}"
VERSION="${VERSION%-linux-x64}"
IFS=. read -r MAJ MIN PAT <<<"$VERSION"
V1="$MAJ.$MIN.$((PAT + 1))"
V2="$MAJ.$MIN.$((PAT + 2))"

# Fabricate an upgrade bundle: same files, another version, optionally one more migration.
fabricate() { # VERSION WITH_MIGRATION
  local v=$1 mig=$2 src="dist/$NAME" name="relay-manager-$1-linux-x64" out
  out="$WORK/$name"
  rm -rf "$out"
  mkdir -p "$WORK"
  cp -a "$src" "$out"
  printf '%s\n' "$v" >"$out/VERSION"
  sed -i "s/^version=.*/version=$v/" "$out/BUILDINFO"
  node -e 'const f=process.argv[1];const p=JSON.parse(require("fs").readFileSync(f,"utf8"));p.version=process.argv[2];require("fs").writeFileSync(f,JSON.stringify(p))' \
    "$out/app/package.json" "$v"
  if [ "$mig" = 1 ]; then
    mkdir -p "$out/app/prisma/migrations/20260924000000_upgrade_test"
    printf 'CREATE TABLE "RmUpgradeTest" ("id" INTEGER NOT NULL PRIMARY KEY);\n' >"$out/app/prisma/migrations/20260924000000_upgrade_test/migration.sql"
  fi
  (cd "$out" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum) >"$out/SHA256SUMS"
  tar -C "$WORK" -czf "$WORK/$name.tar.gz" "$name"
  rm -rf "$out"
}
fabricate "$V1" 0
fabricate "$V2" 1
cp "dist/${NAME}.tar.gz" "$WORK/"

# «Montar / Expulsar»: a fake USB stick (vfat, label RMTEST) made here, since the test image has no dosfstools; inside
# the (privileged) container it goes on a loop device. And a fake download script (same contract as a profile's), for
# profiles whose own script needs their network.
MKFS="$(command -v mkfs.vfat || true)"
[ -n "$MKFS" ] || for c in /usr/sbin/mkfs.vfat /sbin/mkfs.vfat; do [ -x "$c" ] && MKFS=$c; done
[ -n "$MKFS" ] || { echo "Falta mkfs.vfat (dosfstools) en este equipo" >&2; exit 1; }
mkdir -p dist/test
rm -f dist/test/usb-rmtest.img
"$MKFS" -C -n RMTEST dist/test/usb-rmtest.img 16384 >/dev/null
[ -f test/fixtures/fake-export-downloader.sh ] || { echo "Falta test/fixtures/fake-export-downloader.sh" >&2; exit 1; }
install -m 0755 test/fixtures/fake-export-downloader.sh dist/test/fake-export-downloader.sh

CID="rm-native-test-$$"
cleanup() { docker rm -f "$CID" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# systemd needs its cgroup tree; the unit's sandboxing (mount namespaces) needs a privileged container.
PROFILE_MOUNT=()
if [ -n "$PROFILE" ]; then PROFILE_MOUNT=(-v "$PWD/$PROFILE":/perfil-prueba:ro); fi
docker run -d --name "$CID" --privileged --cgroupns=host --network none \
  --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:rw "${PROFILE_MOUNT[@]}" \
  -v "$PWD/$WORK":/bundles:ro -v "$PWD/dist/test":/dist/test:ro -v "$PWD/scripts/test-bundle":/t:ro \
  "$IMAGE_TAG" >/dev/null
for _ in $(seq 1 60); do
  state=$(docker exec "$CID" systemctl is-system-running 2>/dev/null || true)
  case "$state" in running | degraded) break ;; esac
  sleep 1
done
echo "    systemd en el contenedor ($DISTRO, $(docker exec "$CID" sh -c '. /etc/os-release; echo "$PRETTY_NAME"')): ${state:-desconocido}"
# Docker starts the container with / "private,slave" and systemd does not make it shared inside a container (a real boot
# does): without shared propagation a mount made by relay-manager-rootmount (host namespace) would not reach the main
# service's sandbox. Same as a real machine from here on.
docker exec "$CID" mount --make-rshared /
docker exec -e RM_SMOKE_SKIP="${RM_SMOKE_SKIP:-}" -e RM_TEST_EXPORT_RUN="${RM_TEST_EXPORT_RUN:-0}" \
  -e RM_TEST_PROFILE="$([ -n "$PROFILE" ] && echo /perfil-prueba)" "$CID" bash /t/native.sh "$VERSION" "$V1" "$V2"
