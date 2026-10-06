#!/usr/bin/env bash
# Docker image checks (scripts/test-bundle.sh --docker). Runs relay-manager:<version> like compose.yaml does
# (init, only NET_ADMIN + SETUID/SETGID/KILL, no-new-privileges, read-only root, tmpfs /tmp, /dev:/hostdev:ro, cgroup
# rules, dialout gid) but with --network none, then checks CapEff (the server: CAP_NET_ADMIN only), ip, ping, setup-token, the CLI admin, the smoke client, doctor
# (host-only checks as info), backup, EROFS in the log and a clean SIGTERM stop.
# $2: the project profile (a folder under the repo, readable by all) mounted at /perfil like compose.yaml does ("" = none).
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION=$1
PROFILE="${2:-}"
TAG="relay-manager:$VERSION"
PW='docker-password-1'
ok() { printf '[ OK ] %s\n' "$*"; }
CID="rm-docker-test-$$"
VOL="rm-docker-test-$$"
fail() {
  printf '[FALLO] %s\n' "$*"
  docker logs --tail 60 "$CID" 2>&1 || true
  exit 1
}
# "Archivos": a host folder mounted at /files like compose.yaml does (setgid 2775, the owner's gid added to the
# container), so uploads land on the host owned by the container user and the host group, writable by both.
FILES_HOST="$(mktemp -d "$PWD/dist/test/archivos.XXXXXX")"
chmod 2775 "$FILES_HOST"
# The second folder of Archivos (/extra), mounted the same way (compose.yaml: RM_FILES_EXTRA_HOST_DIR).
EXTRA_HOST="$(mktemp -d "$PWD/dist/test/extra.XXXXXX")"
chmod 2775 "$EXTRA_HOST"
# The profile (compose.yaml: RM_PROFILE_HOST_DIR → /perfil, read only).
PROFILE_MOUNT=()
SMOKE_PROFILE=-
if [ -n "$PROFILE" ]; then
  PROFILE_MOUNT=(-v "$PWD/$PROFILE":/perfil:ro)
  SMOKE_PROFILE=/perfil
fi
penv() { # KEY → its value in the profile's perfil.env ("" when unset)
  [ -n "$PROFILE" ] && [ -f "$PROFILE/perfil.env" ] || return 0
  node -e 'const v = require("util").parseEnv(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (v !== undefined) process.stdout.write(v)' "$PROFILE/perfil.env" "$1"
}
cleanup() {
  docker rm -f "$CID" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  rm -rf "$FILES_HOST" "$EXTRA_HOST"
}
trap cleanup EXIT

if ! docker image inspect "$TAG" >/dev/null 2>&1; then
  [ -f "dist/relay-manager-image-$VERSION.tar.gz" ] || fail "no existe la imagen $TAG ni dist/relay-manager-image-$VERSION.tar.gz (pnpm image)"
  docker load -i "dist/relay-manager-image-$VERSION.tar.gz"
fi
ok "imagen $TAG ($(docker image inspect -f '{{.Size}}' "$TAG" | awk '{printf "%.0f MB", $1/1024/1024}'))"

docker volume create "$VOL" >/dev/null
docker run -d --name "$CID" --network none --init --cap-drop ALL --cap-add NET_ADMIN --cap-add SETUID --cap-add SETGID --cap-add KILL \
  --security-opt no-new-privileges:true \
  --read-only --tmpfs /tmp:size=64m,mode=1777 -v "$VOL":/data -v /dev:/hostdev:ro \
  --device-cgroup-rule 'c 188:* rw' --device-cgroup-rule 'c 166:* rw' --group-add "$(getent group dialout | cut -d: -f3)" \
  -v "$FILES_HOST":/files -v "$EXTRA_HOST":/extra --group-add "$(id -g)" "${PROFILE_MOUNT[@]}" \
  -v "$PWD/dist/test":/dist/test:ro "$TAG" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$CID" relay-manager ping --quiet >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$CID" relay-manager ping || fail "ping dentro del contenedor"
ok "contenedor en marcha con la raíz de solo lectura"

# PID 1 (init, root) keeps at most NET_ADMIN|SETUID|SETGID|KILL (0x10e0: KILL to forward SIGTERM to the server); the server runs as relay-manager with
# CAP_NET_ADMIN only (ambient, "Red de equipos") and nothing else.
PID1=$(docker exec "$CID" sed -n 's/^CapEff:[[:space:]]*//p' /proc/1/status)
printf '    PID 1 CapEff: %s\n' "$PID1"
[ $((0x$PID1 & ~0x10e0)) = 0 ] || fail "PID 1 tiene capacidades de más ($PID1)"
SRV=$(docker exec "$CID" sh -c 'for p in /proc/[0-9]*; do [ "$p" = "/proc/$$" ] && continue; tr "\0" " " <"$p/cmdline" 2>/dev/null | grep -q "app/server.js start" && echo "$(sed -n "s/^Uid:[[:space:]]*\([0-9]*\).*/\1/p" "$p/status") $(sed -n "s/^CapEff:[[:space:]]*//p" "$p/status") $(sed -n "s/^CapAmb:[[:space:]]*//p" "$p/status")"; done')
printf '%s\n' "$SRV" | sed 's/^/    uid CapEff CapAmb: /'
[ -n "$SRV" ] || fail "no se encuentra el proceso del servidor"
while read -r uid eff amb; do
  [ "$uid" = 10001 ] || fail "el servidor corre con uid $uid (se esperaba 10001, relay-manager)"
  [ "$eff" = 0000000000001000 ] || fail "el servidor tiene CapEff $eff (se esperaba solo CAP_NET_ADMIN, 0000000000001000)"
  [ "$amb" = 0000000000001000 ] || fail "el servidor tiene CapAmb $amb (se esperaba CAP_NET_ADMIN)"
done <<<"$SRV"
ok "capacidades: el servidor (uid 10001) solo tiene CAP_NET_ADMIN; PID 1 como mucho NET_ADMIN, SETUID, SETGID y KILL"
docker exec "$CID" ip -V >/dev/null || fail "la imagen no tiene la orden ip (iproute2)"
ok "iproute2 en la imagen: $(docker exec "$CID" ip -V)"
OUT=$(docker exec "$CID" relay-manager ping 2>&1) || fail "ping desde docker exec (como root, el lanzador pasa a relay-manager): $OUT"
ok "docker exec pasa por el lanzador como relay-manager"

TOKEN=$(docker exec "$CID" relay-manager setup-token)
ok "setup-token: $TOKEN"
docker exec -i "$CID" relay-manager user create admin --admin --password-stdin <<<"$PW" >/dev/null || fail "user create"
printf 'copiado en el anfitrión\n' >"$FILES_HOST/manual.txt"
MSHA=$(sha256sum "$FILES_HOST/manual.txt" | cut -d' ' -f1)
docker exec -e RM_SMOKE_SKIP="${RM_SMOKE_SKIP:-}" -e RM_SMOKE_FILE=smoke-docker.bin -e RM_SMOKE_FILES_EXPECT="manual.txt:$MSHA" \
  -e RM_SMOKE_PROFILE="$SMOKE_PROFILE" -e RM_SMOKE_EXPORT_RUN="${RM_TEST_EXPORT_RUN:-0}" "$CID" \
  node /dist/test/smoke-client.cjs http://127.0.0.1:3200 admin "$PW" | tee /tmp/rm-docker-smoke.$$ || fail "smoke-client"
SHA=$(sed -n 's/.*archivo=[^ ]* sha256=\([0-9a-f]*\).*/\1/p' /tmp/rm-docker-smoke.$$)
XF=$(sed -n 's/.*extra=\([^ ]*\) sha256=.*/\1/p' /tmp/rm-docker-smoke.$$ | head -n 1)
XSHA=$(sed -n 's/.*extra=[^ ]* sha256=\([0-9a-f]*\).*/\1/p' /tmp/rm-docker-smoke.$$ | head -n 1)
DESC=$(grep '^descarga=' /tmp/rm-docker-smoke.$$ || true)
rm -f /tmp/rm-docker-smoke.$$
[ -f "$FILES_HOST/smoke-docker.bin" ] || fail "la subida no está en la carpeta del anfitrión"
[ "$(sha256sum "$FILES_HOST/smoke-docker.bin" | cut -d' ' -f1)" = "$SHA" ] || fail "el archivo subido no coincide en el anfitrión"
[ "$(stat -c '%a %u %g' "$FILES_HOST/smoke-docker.bin")" = "664 10001 $(id -g)" ] || fail "propietario o permisos inesperados: $(stat -c '%a %u %g' "$FILES_HOST/smoke-docker.bin")"
printf x >>"$FILES_HOST/smoke-docker.bin" || fail "el usuario del anfitrión no puede modificar lo que sube la web"
ok "Archivos: subida en la carpeta del anfitrión montada en /files (664, uid 10001, grupo $(id -g)); lo copiado en el anfitrión se descarga"
# The profile: its second folder is /extra (RM_FILES_EXTRA_DIR's Docker default), its templates load from /perfil.
EXTRA_NAME=$(penv RM_FILES_EXTRA_NAME)
if [ -n "$EXTRA_NAME" ] && [ "$(penv RM_FILES_EXTRA_ENABLED)" != 0 ]; then
  [ -n "$XF" ] && [ -f "$EXTRA_HOST/$XF" ] || fail "la subida a «$EXTRA_NAME» no está en la carpeta del anfitrión montada en /extra"
  [ "$(sha256sum "$EXTRA_HOST/$XF" | cut -d' ' -f1)" = "$XSHA" ] || fail "el archivo de /extra no coincide en el anfitrión"
  [ "$(stat -c '%a %u %g' "$EXTRA_HOST/$XF")" = "664 10001 $(id -g)" ] || fail "propietario o permisos inesperados en /extra: $(stat -c '%a %u %g' "$EXTRA_HOST/$XF")"
  ok "segunda carpeta «$EXTRA_NAME»: /extra en el anfitrión (664, uid 10001)"
fi
[ -z "$DESC" ] || ok "script de descarga del perfil en el contenedor: $DESC"
docker exec "$CID" relay-manager plantillas comprobar >/tmp/rm-docker-plantillas.$$ 2>&1 || { cat /tmp/rm-docker-plantillas.$$; fail "relay-manager plantillas comprobar"; }
sed 's/^/    /' /tmp/rm-docker-plantillas.$$
rm -f /tmp/rm-docker-plantillas.$$
ok "perfil $([ -n "$PROFILE" ] && echo "montado en /perfil (solo lectura)" || echo "ausente"): plantillas comprobar sale con 0"
docker exec "$CID" relay-manager doctor >/tmp/rm-docker-doctor.$$ || { cat /tmp/rm-docker-doctor.$$; fail "doctor terminó con código distinto de 0"; }
grep -E 'ModemManager|brltty|Sincronización|systemd|Puertos serie|Grupo dialout|Resumen|fallo' /tmp/rm-docker-doctor.$$ | sed 's/^/    /'
[ "$(grep -c 'No comprobable desde el contenedor' /tmp/rm-docker-doctor.$$)" = 4 ] || fail "doctor no marca como info las 4 comprobaciones del anfitrión"
rm -f /tmp/rm-docker-doctor.$$
ok "doctor en Docker sale con 0; ModemManager, brltty, NTP y systemd: «No comprobable desde el contenedor»"
B=$(docker exec "$CID" relay-manager backup) || fail "backup"
ok "backup con el servicio en marcha: $B"
docker logs "$CID" >/tmp/rm-docker-logs.$$ 2>&1
if grep -q EROFS /tmp/rm-docker-logs.$$; then fail "EROFS en el registro"; fi
rm -f /tmp/rm-docker-logs.$$
ok "sin EROFS en el registro"
start=$(date +%s%N)
docker stop -t 15 "$CID" >/dev/null
end=$(date +%s%N)
[ "$(docker inspect -f '{{.State.ExitCode}}' "$CID")" = 0 ] || fail "el contenedor terminó con código $(docker inspect -f '{{.State.ExitCode}}' "$CID")"
ok "docker stop → salida 0 en $(((end - start) / 1000000)) ms"
echo "== Imagen Docker superada"
