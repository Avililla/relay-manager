#!/usr/bin/env bash
# Runs INSIDE a clean ubuntu:24.04 container started with --network none (§11.5 step 2).
#   /dist  (ro)  the bundle tarball and test/smoke-client.cjs
#   $1           bundle name (relay-manager-<ver>-linux-x64)
#   RM_TEST_PROFILE     profile to run with: a folder (copied to perfil/ next to bin/, the portable layout), «-» = none,
#                       empty = the bundle's own perfil/ (if any)
#   RM_TEST_EXPORT_RUN  1 = run the profile's download script (only for scripts that work offline)
set -euo pipefail
NAME="$1"
T=/opt/t
PASSWORD='smoke-password-1'
LOG1=/tmp/server-1.log
LOG2=/tmp/server-2.log

ok() { printf '[ OK ] %s\n' "$*"; }
fail() {
  printf '[FALLO] %s\n' "$*"
  for f in "$LOG1" "$LOG2"; do
    if [ -f "$f" ]; then
      echo "----- $f -----"
      tail -n 60 "$f"
    fi
  done
  exit 1
}

wait_ping() {
  for _ in $(seq 1 120); do
    if ./bin/relay-manager ping --quiet >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

stop_server() { # PID → exits within 8 s with code 0
  local pid=$1 start end code=0
  start=$(date +%s%N)
  kill -TERM "$pid"
  for _ in $(seq 1 80); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -0 "$pid" 2>/dev/null && fail "el servidor sigue vivo 8 s después de SIGTERM"
  wait "$pid" || code=$?
  end=$(date +%s%N)
  [ "$code" = 0 ] || fail "el servidor terminó con código $code tras SIGTERM"
  ok "SIGTERM → salida 0 en $(((end - start) / 1000000)) ms"
}

echo "== Sistema: $(sed -n 's/^PRETTY_NAME="\(.*\)"$/\1/p' /etc/os-release), $(uname -m), red: $(find /sys/class/net -mindepth 1 -maxdepth 1 -printf '%f ')"
mkdir -p "$T"
tar -xzf "/dist/$NAME.tar.gz" -C "$T" --strip-components=1
cd "$T"
sha256sum --quiet -c SHA256SUMS || fail "sha256sum -c SHA256SUMS"
ok "tarball extraído en $T y SHA256SUMS verificado ($(wc -l <SHA256SUMS) ficheros)"
./bin/relay-manager version
# The project profile: the portable mode reads perfil/ next to app/ by itself (no RM_PROFILE_DIR).
case "${RM_TEST_PROFILE:-}" in
  "") ;;
  -) rm -rf perfil ;;
  *)
    rm -rf perfil
    cp -a "$RM_TEST_PROFILE" perfil
    ;;
esac
if [ -d perfil ]; then SMOKE_PROFILE=$T/perfil; else SMOKE_PROFILE=-; fi
penv() { # KEY → its value in perfil/perfil.env (parsed like the app does), "" when unset
  [ -f perfil/perfil.env ] || return 0
  ./node/bin/node -e 'const v = require("util").parseEnv(require("fs").readFileSync("perfil/perfil.env", "utf8"))[process.argv[1]]; if (v !== undefined) process.stdout.write(v)' "$1"
}
if [ -d perfil ]; then
  ok "perfil: $(find perfil/plantillas -mindepth 1 -maxdepth 1 -name '*.json' 2>/dev/null | wc -l) plantillas$([ -f perfil/perfil.env ] && echo ", perfil.env")$([ -n "${RM_TEST_PROFILE:-}" ] && echo " (copiado de la prueba)" || echo " (el del paquete)")"
else
  ok "sin perfil: valores genéricos"
fi

# 2-3. Portable start (as root, so RM_ALLOW_ROOT=1) and ping.
./bin/relay-manager start >"$LOG1" 2>&1 &
PID=$!
wait_ping || fail "ping no responde tras 60 s"
ok "servidor en marcha (pid $PID); ping correcto"
grep -q "configuración inicial pendiente" "$LOG1" || fail "el banner no muestra la configuración pendiente"

# 4. Setup token.
TOKEN=$(./bin/relay-manager setup-token)
[[ "$TOKEN" =~ ^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$ ]] || fail "setup-token devolvió «$TOKEN»"
ok "setup-token: $TOKEN"
[ "$(stat -c %a data/setup-token)" = 600 ] || fail "data/setup-token no tiene permisos 600"

# 5. First admin from the CLI.
./bin/relay-manager user create admin --admin --password-stdin <<<"$PASSWORD" || fail "user create admin"
[ ! -e data/setup-token ] || fail "el fichero setup-token sigue existiendo tras crear el administrador"
ok "administrador creado desde la CLI; setup-token borrado"

# 6. HTTP, auth, Origin gate, SSE and WS checks.
RM_SMOKE_FILE=smoke-portable.bin RM_SMOKE_PROFILE="$SMOKE_PROFILE" RM_SMOKE_EXPORT_RUN="${RM_TEST_EXPORT_RUN:-0}" \
  ./node/bin/node /dist/test/smoke-client.cjs http://127.0.0.1:3200 admin "$PASSWORD" | tee /tmp/smoke.txt ||
  fail "smoke-client"
grep -q "Todas las comprobaciones han pasado" /tmp/smoke.txt || fail "smoke-client"
# Archivos in portable mode: ~/tftp of the user running it (root here), created at start.
SHA=$(sed -n 's/.*archivo=[^ ]* sha256=\([0-9a-f]*\).*/\1/p' /tmp/smoke.txt)
[ -f "$HOME/tftp/smoke-portable.bin" ] || fail "la subida no está en $HOME/tftp"
[ "$(sha256sum "$HOME/tftp/smoke-portable.bin" | cut -d' ' -f1)" = "$SHA" ] || fail "el archivo subido no coincide en el disco"
[ "$(stat -c %a "$HOME/tftp/smoke-portable.bin")" = 664 ] || fail "el archivo subido no tiene permisos 664"
ok "Archivos (portátil): subida en $HOME/tftp con el mismo sha256 y permisos 664"
# The profile's second folder: ~/<RM_FILES_EXTRA_NAME>, or its RM_FILES_EXTRA_DIR with ~ = this user's HOME.
EXTRA_NAME=$(penv RM_FILES_EXTRA_NAME)
if [ -n "$EXTRA_NAME" ] && [ "$(penv RM_FILES_EXTRA_ENABLED)" != 0 ]; then
  EXTRA=$(penv RM_FILES_EXTRA_DIR)
  case "$EXTRA" in "") EXTRA="$HOME/$EXTRA_NAME" ;; "~") EXTRA=$HOME ;; "~/"*) EXTRA="$HOME/${EXTRA#\~/}" ;; esac
  XF=$(sed -n 's/.*extra=\([^ ]*\) sha256=.*/\1/p' /tmp/smoke.txt | head -n 1)
  XSHA=$(sed -n 's/.*extra=[^ ]* sha256=\([0-9a-f]*\).*/\1/p' /tmp/smoke.txt | head -n 1)
  [ -n "$XF" ] && [ -f "$EXTRA/$XF" ] || fail "la subida a la segunda carpeta no está en $EXTRA"
  [ "$(sha256sum "$EXTRA/$XF" | cut -d' ' -f1)" = "$XSHA" ] || fail "el archivo de la segunda carpeta no coincide en el disco"
  ok "segunda carpeta «$EXTRA_NAME» (portátil): $EXTRA, subida con el mismo sha256"
fi
if grep -q '^descarga=' /tmp/smoke.txt; then ok "script de descarga del perfil: $(grep '^descarga=' /tmp/smoke.txt)"; fi
# The profile's templates from the CLI, with the server running: valid, and a reload changes nothing.
./bin/relay-manager plantillas comprobar >/tmp/plantillas.txt 2>&1 || { cat /tmp/plantillas.txt; fail "relay-manager plantillas comprobar"; }
./bin/relay-manager plantillas recargar >>/tmp/plantillas.txt 2>&1 || { cat /tmp/plantillas.txt; fail "relay-manager plantillas recargar"; }
sed 's/^/    /' /tmp/plantillas.txt
ok "plantillas comprobar y recargar (con el servidor en marcha) salen con 0"

# 7. Doctor must exit 0 (warnings allowed).
./bin/relay-manager doctor || fail "doctor terminó con código $?"
ok "doctor sale con 0"

# Data layout and modes (umask 0027).
[ "$(stat -c %a data)" = 750 ] || fail "data/ no tiene permisos 750 ($(stat -c %a data))"
[ "$(stat -c %a data/auth-secret)" = 600 ] || fail "auth-secret no tiene permisos 600"
[ "$(stat -c %a data/relay-manager.db)" = 640 ] || fail "relay-manager.db no tiene permisos 640 ($(stat -c %a data/relay-manager.db))"
ok "permisos: data 750, auth-secret 600, relay-manager.db 640"

# Backup while running (WAL), second instance refused (exit 5).
BK=$(./bin/relay-manager backup) || fail "backup"
[ -f "$BK" ] && [ -f "${BK%.db}.json" ] || fail "backup no creó $BK y su sidecar"
ok "backup en caliente: $(basename "$BK")"
set +e
RM_PORT=3999 ./bin/relay-manager start >/tmp/second.log 2>&1
code=$?
set -e
[ "$code" = 5 ] || fail "una segunda instancia sobre el mismo directorio salió con $code (se esperaba 5)"
ok "segunda instancia → salida 5 ($(tail -n 1 /tmp/second.log))"
set +e
./bin/relay-manager restore "$(basename "$BK")" --yes >/tmp/restore.log 2>&1
code=$?
set -e
[ "$code" = 5 ] || fail "restore con el servidor en marcha salió con $code (se esperaba 5)"
ok "restore con el servidor en marcha → salida 5"

# 8. SIGTERM.
stop_server "$PID"
[ ! -e data/server.pid ] || fail "server.pid sigue existiendo tras la parada"

# «Enviar a equipo»: an equipment whose Ethernet access («Siempre», no reservation needed) is 127.0.0.1:2222, where the
# smoke client runs an SSH server (with the server stopped: config import refuses to run next to it).
cat >/tmp/equipo-envio.json <<'EOF2'
{"format":"relay-manager-config","version":1,"exportedAt":"2026-09-29T00:00:00.000Z","appVersion":"2.1.1",
 "settings":{"labName":"Laboratorio de prueba","bannerText":null},"roles":[],"templates":[],"boards":[],
 "equipment":[{"name":"Equipo envío","serialNumber":null,"description":null,"templateName":null,"roles":[],"consoles":[],"relays":[],
   "accesses":[{"key":"ETH","label":"Ethernet","kind":"tcp","port":3230,"enabled":true,"policy":"always","cableSerial":null,"consoleKey":null,
     "targetHost":"127.0.0.1","targetPort":2222,"targetMode":"ip","switchPort":null,"sshUser":"root"}]}]}
EOF2
./bin/relay-manager config import /tmp/equipo-envio.json >/tmp/import.txt 2>&1 || { cat /tmp/import.txt; fail "config import del equipo de envío"; }
ok "equipo con acceso Ethernet a 127.0.0.1:2222 importado"
# The import set the lab name: what /login shows from now on.
export RM_SMOKE_LAB_NAME="Laboratorio de prueba"

# 9. Restart: data persists, migrations are a no-op.
./bin/relay-manager start >"$LOG2" 2>&1 &
PID=$!
wait_ping || fail "ping no responde tras reiniciar"
grep -q "Migración aplicada" "$LOG2" && fail "el reinicio volvió a aplicar migraciones"
grep -q "configuración inicial pendiente" "$LOG2" && fail "tras reiniciar vuelve a pedir la configuración inicial"
./bin/relay-manager user list >/tmp/users.txt || fail "user list"
grep -q '^admin ' /tmp/users.txt || fail "el usuario admin no persiste"
[ "$(./bin/relay-manager setup-token)" = "La configuración inicial ya está completada" ] || fail "setup-token tras reiniciar"
ok "reinicio: datos persistentes, migraciones sin cambios, configuración completada"
# ssh2 inside build/server.js, offline, without native parts: a real SFTP send to the SSH server of the smoke client.
RM_SMOKE_SEND="Equipo envío|2222|smoke-portable.bin" ./node/bin/node /dist/test/smoke-client.cjs http://127.0.0.1:3200 admin "$PASSWORD" | tee /tmp/smoke-send.txt ||
  fail "smoke-client (enviar a equipo)"
grep -q "Todas las comprobaciones han pasado" /tmp/smoke-send.txt || fail "smoke-client (enviar a equipo)"
ok "Enviar a equipo desde el paquete: SFTP a 127.0.0.1:2222, verificado"
# «Copiar a una carpeta del servidor» in portable mode: as the app's user only (no root helper here: the dialog says why).
mkdir -p /mnt/usb-portatil
RM_SMOKE_COPY='{"file":"smoke-portable.bin","dest":"/mnt/usb-portatil","asRoot":false}' ./node/bin/node /dist/test/smoke-client.cjs http://127.0.0.1:3200 admin "$PASSWORD" | tee /tmp/smoke-copy.txt ||
  fail "smoke-client (copiar a una carpeta del servidor)"
grep -q "root=no .*problema=Solo con la instalación como servicio" /tmp/smoke-copy.txt || fail "la copia como administrador debería decir que solo existe con la instalación como servicio"
[ "$(sha256sum /mnt/usb-portatil/smoke-portable.bin | cut -d' ' -f1)" = "$SHA" ] || fail "la copia no coincide con el original"
[ "$(stat -c %a /mnt/usb-portatil/smoke-portable.bin)" = 644 ] || fail "la copia no tiene permisos 644"
RM_SMOKE_COPY='{"file":"smoke-portable.bin","dest":"/mnt/usb-portatil","asRoot":true,"password":"x","expectStatus":503,"expectMessage":"Solo con la instalación como servicio"}' ./node/bin/node /dist/test/smoke-client.cjs http://127.0.0.1:3200 admin "$PASSWORD" >/tmp/smoke-copy2.txt ||
  { cat /tmp/smoke-copy2.txt; fail "copia como administrador en modo portátil"; }
ok "Copiar a una carpeta del servidor (portátil): /mnt/usb-portatil, sha256 igual, 644; «como administrador» no disponible y explicado"
stop_server "$PID"
echo "== Prueba del paquete superada"
