#!/usr/bin/env bash
# Runs INSIDE the Debian 12 systemd test container (--network none) as root. Upgrade compatibility of a native install:
#   upgrade-chain.sh <escenario> <versión base> [<versión intermedia>…] <versión nueva>
# Scenarios:
#   sintetico  the base version gets representative data (users by CLI; a relay board, equipment with consoles, relays
#              and accesses, cables, a role and lab settings through `relay-manager config import`; files in Archivos;
#              «Red de equipos» NetworkManager and sysctl drop-ins), and before the last upgrade config.env gets the keys
#              of an older version that the profile's migraciones-config.txt renames (each with a sample value)
#   real       RM_TEST_REAL_SNAPSHOT (mounted at /snapshot): relay-manager.db (from `relay-manager backup`),
#              config.env.txt and optionally rootcopy.env.txt of a real installation are put in place over the base
#              version (masked values «***» keep what the installer wrote); the engineer account is the RM_SUDO_USER
#              of that config (else the /home/<usuario> of RM_FILES_DIR)
# After every upgrade: service active, /api/health and login, every row of the database still there and unchanged
# (columns that still exist), config.env and rootcopy.env keep every key and value (renamed keys under the new name),
# Archivos with the same files/modes/owners, drop-ins, udev, sysctl and NetworkManager files, root helper sockets and
# the pre-upgrade copies; on the last one also the profile's templates (source=file, no duplicates), the second folder
# with its BindPaths= and `relay-manager doctor` without failures.
# Bundles in /bundles/relay-manager-<versión>-linux-x64.tar.gz; helpers in /t.
#   RM_TEST_PROFILE  profile folder for the last install.sh (--perfil); "" = the new bundle's perfil/ (installed by
#                    install.sh because a 2.x installation has none)
set -euo pipefail
SCEN=$1
shift
VERS=("$@")
[ "${#VERS[@]}" -ge 2 ] || { echo "Uso: upgrade-chain.sh <sintetico|real> <base> [<intermedias>…] <nueva>" >&2; exit 2; }
BASE=${VERS[0]}
NEW=${VERS[${#VERS[@]} - 1]}
DATA=/var/lib/relay-manager
CONF=/etc/relay-manager/config.env
RCENV=/etc/relay-manager/rootcopy.env
DROPINS=/etc/systemd/system/relay-manager.service.d
NMF=/etc/NetworkManager/conf.d/90-relay-manager-red-equipos.conf
SYSCTLF=/etc/sysctl.d/60-relay-manager.conf
W=/root/upgrade
PW='upgrade-password-1'
PW2='upgrade-password-2'
PY=(python3 /t/upgrade-db.py)
mkdir -p "$W"

ok() { printf '[ OK ] %s\n' "$*"; }
note() { printf '[INFO] %s\n' "$*"; }
fail() {
  printf '[FALLO] %s\n' "$*"
  echo "----- journal -----"
  journalctl -u relay-manager -n 40 --no-pager || true
  exit 1
}
extract() { # VERSION → prints the extracted directory
  local d="/root/pkg-$1"
  rm -rf "$d"
  mkdir -p "$d"
  tar -xzf "/bundles/relay-manager-$1-linux-x64.tar.gz" -C "$d" --strip-components=1
  printf '%s' "$d"
}
active() { [ "$(systemctl is-active relay-manager)" = active ]; }
wait_active() {
  for _ in $(seq 1 60); do
    if active && /opt/relay-manager/current/node/bin/node -e "fetch('$URL/api/health').then(r=>r.json()).then(j=>process.exit(j.ok===true?0:1),()=>process.exit(1))"; then return 0; fi
    sleep 1
  done
  return 1
}
conf_get() { sed -n "s/^[[:space:]]*\(export[[:space:]]\+\)\?$2=//p" "$1" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"; }
conf_keys() { sed -n 's/^[[:space:]]*\(export[[:space:]]\+\)\?\([A-Z][A-Z0-9_]*\)=.*/\2/p' "$1" | sort -u; }
conf_put() { # FILE KEY VALUE: replaces the active line, else appends
  if grep -q "^[[:space:]]*$2=" "$1"; then
    sed -i "s|^[[:space:]]*$2=.*|$2=$3|" "$1"
  else
    printf '%s=%s\n' "$2" "$3" >>"$1"
  fi
}
manifest() { # DIR → "path mode owner:group size sha" per entry (the folder itself included)
  (cd "$1" && find . -printf '%P\t%m\t%u:%g\t%s\t%y\n' | sort | while IFS=$'\t' read -r p m o s y; do
    h=-
    [ "$y" != f ] || h=$(sha256sum -- "${p:-.}" | cut -c1-16)
    printf '%s %s %s %s %s\n' "${p:-.}" "$m" "$o" "$s" "$h"
  done)
}
login() { # USER PASSWORD
  /opt/relay-manager/current/node/bin/node /t/login-check.mjs "$URL" "$1" "$2" >"$W/login.txt" 2>&1 || { cat "$W/login.txt"; fail "login de $1 con $(current)"; }
  ok "login de $1: $(cat "$W/login.txt")"
}
current() { basename "$(readlink -f /opt/relay-manager/current)"; }

echo "== escenario $SCEN: ${VERS[*]} ($(. /etc/os-release; echo "$PRETTY_NAME"))"
declare -A PKG
for v in "${VERS[@]}"; do PKG[$v]=$(extract "$v"); done
PN=${PKG[$NEW]}
PROFILE_OPT=()
PROF_SRC=""
if [ -n "${RM_TEST_PROFILE:-}" ]; then
  PROFILE_OPT=(--perfil "$RM_TEST_PROFILE")
  PROF_SRC=$RM_TEST_PROFILE
elif [ -d "$PN/perfil" ]; then
  PROF_SRC=$PN/perfil
fi
note "perfil de la versión nueva: ${PROF_SRC:-ninguno}"

# The engineer account that runs install.sh with sudo (as on the bench): admin of the machine with a password.
ENG=ingeniero
FILES_ARG=()
if [ "$SCEN" = real ]; then
  [ -f /snapshot/relay-manager.db ] && [ -f /snapshot/config.env.txt ] || fail "faltan /snapshot/relay-manager.db o /snapshot/config.env.txt"
  e=$(conf_get /snapshot/config.env.txt RM_SUDO_USER)
  f=$(conf_get /snapshot/config.env.txt RM_FILES_DIR)
  if [ -z "$e" ]; then case "$f" in /home/*/*) e=$(echo "$f" | cut -d/ -f3) ;; esac; fi
  [ -z "$e" ] || ENG=$e
fi
ENG_HOME=/home/$ENG
id "$ENG" >/dev/null 2>&1 || useradd -m -s /bin/bash "$ENG"
chmod 0750 "$ENG_HOME"
usermod -aG sudo "$ENG"
printf '%s:%s\n' "$ENG" 'sudo-del-ingeniero-1' | chpasswd
as_eng() { setpriv --reuid="$ENG" --regid="$ENG" --init-groups "$@"; }
if [ "$SCEN" = real ] && [ -n "$f" ]; then
  case "$f" in "$ENG_HOME"/*) as_eng mkdir -p "$f" ;; *) mkdir -p "$f" ;; esac
  FILES_ARG=(--files-dir "$f")
fi
mkdir -p /etc/NetworkManager/conf.d

# 1. Base version -----------------------------------------------------------------------------------------------
SUDO_USER=$ENG "${PKG[$BASE]}/install.sh" --yes "${FILES_ARG[@]}" --red-equipos-mac 02:00:00:00:00:0a --red-equipos-arp-estricto \
  >"$W/install-$BASE.txt" 2>&1 || { cat "$W/install-$BASE.txt"; fail "install.sh $BASE"; }
PORT=$(conf_get "$CONF" RM_PORT)
URL="http://127.0.0.1:${PORT:-3200}"
wait_active || fail "el servicio $BASE no arranca"
ok "instalación de $BASE como $ENG"
FILES=$(conf_get "$CONF" RM_FILES_DIR)
[ -n "$FILES" ] && [ -d "$FILES" ] || fail "install.sh $BASE no deja RM_FILES_DIR"

if [ "$SCEN" = real ]; then
  systemctl stop relay-manager
  install -m 0640 -o relay-manager -g relay-manager /snapshot/relay-manager.db "$DATA/relay-manager.db"
  rm -f "$DATA/relay-manager.db-wal" "$DATA/relay-manager.db-shm"
  apply_env() { # SNAPSHOT_FILE TARGET: every active KEY=VALUE, masked values («***») left as the installer wrote them
    local k v n=0
    while IFS= read -r k; do
      v=$(conf_get "$1" "$k")
      case "$v" in *'***'*) note "$k enmascarada en $(basename "$1"): se deja la del instalador"; continue ;; esac
      conf_put "$2" "$k" "$v"
      n=$((n + 1))
    done < <(conf_keys "$1")
    note "$(basename "$1"): $n claves aplicadas a $2"
  }
  apply_env /snapshot/config.env.txt "$CONF"
  if [ -f /snapshot/rootcopy.env.txt ]; then
    [ -f "$RCENV" ] || fail "la versión $BASE no tiene $RCENV y la instantánea sí"
    apply_env /snapshot/rootcopy.env.txt "$RCENV"
    systemctl restart relay-manager-rootcopy.socket 2>/dev/null || true
  fi
  systemctl start relay-manager
  wait_active || fail "el servicio $BASE no arranca con la base de datos real"
  ok "instantánea real en $BASE: $("${PY[@]}" users "$DATA/relay-manager.db" | wc -l) usuarios"
else
  relay-manager user create admin --admin --password-stdin <<<"$PW" >/dev/null
  relay-manager user create tecnico --name "Técnico de pruebas" --password-stdin <<<"$PW2" >/dev/null
  # The CLI runs as the service user: the file goes where it can read it.
  "${PY[@]}" seed-json "$DATA/relay-manager.db" /tmp/seed.json
  chmod 0644 /tmp/seed.json
  systemctl stop relay-manager
  relay-manager config import /tmp/seed.json >"$W/import.txt" 2>&1 || { cat "$W/import.txt"; fail "config import en $BASE"; }
  systemctl start relay-manager
  wait_active || fail "el servicio $BASE no arranca tras importar"
  as_eng sh -c "umask 002; mkdir -p '$FILES/firmware' && head -c 200000 /dev/urandom > '$FILES/firmware/imagen.bin' && printf 'notas\n' > '$FILES/notas.txt'"
  login admin "$PW"
  ok "datos de prueba en $BASE: $(tr '\n' ' ' <"$W/import.txt" | cut -c1-160)"
fi

snapshot_state() { # → $W/before.*: what every later upgrade must keep
  "${PY[@]}" dump "$DATA/relay-manager.db" "$W/before.db.json"
  cp -a "$CONF" "$W/before.config.env"
  if [ -f "$RCENV" ]; then cp -a "$RCENV" "$W/before.rootcopy.env"; else rm -f "$W/before.rootcopy.env"; fi
  manifest "$FILES" >"$W/before.files.txt"
  (cd "$DROPINS" 2>/dev/null && ls -1) >"$W/before.dropins.txt" || true
  for f in "$NMF" "$SYSCTLF" /etc/udev/rules.d/99-relay-manager.rules; do
    if [ -f "$f" ]; then cp -a "$f" "$W/before.$(basename "$f")"; fi
  done
}

# RENAMED[old]=new from the profile's migraciones-config.txt (what install.sh applies).
declare -A RENAMED=()
if [ -n "$PROF_SRC" ] && [ -f "$PROF_SRC/migraciones-config.txt" ]; then
  while read -r a b rest; do
    case "$a" in "" | "#"*) continue ;; esac
    RENAMED[$a]=$b
  done <"$PROF_SRC/migraciones-config.txt"
fi

check_upgrade() { # FROM TO
  local from=$1 to=$2 k v nv
  [ "$(current)" = "$to" ] || fail "current no apunta a $to"
  wait_active || fail "el servicio no está activo tras actualizar a $to"
  "${PY[@]}" compare "$W/before.db.json" "$DATA/relay-manager.db" >"$W/compare.txt" 2>&1 || { cat "$W/compare.txt"; fail "$from → $to: la base de datos ha perdido o cambiado datos"; }
  ok "$from → $to: base de datos intacta ($(cut -c1-300 "$W/compare.txt"))"
  # config.env: every key keeps its value (renamed ones under the new name, the old name no longer active).
  local lost=()
  while IFS= read -r k; do
    v=$(conf_get "$W/before.config.env" "$k")
    if [ -n "${RENAMED[$k]:-}" ] && [ "$to" = "$NEW" ]; then
      nv=$(conf_get "$CONF" "${RENAMED[$k]}")
      [ "$nv" = "$v" ] || lost+=("$k→${RENAMED[$k]} (=${nv:-vacío})")
      [ -z "$(conf_get "$CONF" "$k")" ] || lost+=("$k sigue activa")
    else
      [ "$(conf_get "$CONF" "$k")" = "$v" ] || lost+=("$k (antes «$v», ahora «$(conf_get "$CONF" "$k")»)")
    fi
  done < <(conf_keys "$W/before.config.env")
  [ "${#lost[@]}" = 0 ] || { diff "$W/before.config.env" "$CONF" || true; fail "$from → $to: config.env: ${lost[*]}"; }
  ok "$from → $to: config.env conserva sus $(conf_keys "$W/before.config.env" | wc -l) claves (nuevas: $(comm -13 <(conf_keys "$W/before.config.env") <(conf_keys "$CONF") | tr '\n' ' '))"
  if [ -f "$W/before.rootcopy.env" ]; then
    [ -f "$RCENV" ] || fail "$from → $to: falta $RCENV"
    while IFS= read -r k; do
      [ "$(conf_get "$RCENV" "$k")" = "$(conf_get "$W/before.rootcopy.env" "$k")" ] || { diff "$W/before.rootcopy.env" "$RCENV" || true; fail "$from → $to: rootcopy.env cambió $k"; }
    done < <(conf_keys "$W/before.rootcopy.env")
    ok "$from → $to: rootcopy.env conserva sus valores"
  fi
  manifest "$FILES" >"$W/after.files.txt"
  diff "$W/before.files.txt" "$W/after.files.txt" >"$W/files.diff" || { cat "$W/files.diff"; fail "$from → $to: Archivos ($FILES) ha cambiado"; }
  ok "$from → $to: Archivos $FILES igual ($(wc -l <"$W/after.files.txt") entradas, $(stat -c '%a %U:%G' "$FILES"))"
  while IFS= read -r k; do
    [ -f "$DROPINS/$k" ] || fail "$from → $to: falta el drop-in $DROPINS/$k"
  done <"$W/before.dropins.txt"
  for f in "$NMF" "$SYSCTLF" /etc/udev/rules.d/99-relay-manager.rules; do
    if [ -f "$W/before.$(basename "$f")" ]; then
      [ -f "$f" ] || fail "$from → $to: falta $f"
      [ "$f" = /etc/udev/rules.d/99-relay-manager.rules ] || cmp -s "$f" "$W/before.$(basename "$f")" || fail "$from → $to: $f ha cambiado"
    fi
  done
  ok "$from → $to: drop-ins ($(tr '\n' ' ' <"$W/before.dropins.txt")), regla udev, $(basename "$NMF") y $(basename "$SYSCTLF") conservados"
  for s in relay-manager-rootcopy.socket relay-manager-rootmount.socket; do
    if [ -f "/etc/systemd/system/$s" ] || [ -f "${PKG[$to]}/systemd/$s" ]; then
      [ "$(systemctl is-enabled "$s" 2>/dev/null)" = enabled ] || fail "$from → $to: $s no está habilitado"
      [ "$(systemctl is-active "$s" 2>/dev/null)" = active ] || fail "$from → $to: $s no está activo"
    fi
  done
  ls "$DATA"/backups/relay-manager-*-pre-upgrade-"$from"-to-"$to".db >/dev/null 2>&1 || fail "$from → $to: falta la copia pre-upgrade de la base de datos"
  snap=$(find /etc/relay-manager/backups -mindepth 1 -maxdepth 1 -type d -name "config-*-pre-upgrade-$from-to-$to" -print -quit 2>/dev/null || true)
  [ -n "$snap" ] || fail "$from → $to: falta la copia de config.env previa"
  cmp -s "$snap/config.env" "$W/before.config.env" || fail "$from → $to: la copia de config.env no es la de antes"
  ok "$from → $to: copias pre-upgrade de la base de datos y de config.env; sockets del ayudante activos"
}

snapshot_state
PREV=$BASE
for v in "${VERS[@]:1}"; do
  if [ "$v" = "$NEW" ] && [ "$SCEN" = sintetico ]; then
    # config.env as a later 2.x left it: the keys the profile renames, with sample values.
    if [ "${#RENAMED[@]}" = 0 ]; then
      note "el perfil no trae migraciones-config.txt: no se prueban claves renombradas"
    else
      for k in $(printf '%s\n' "${!RENAMED[@]}" | sort); do
        case "${RENAMED[$k]}" in
          *_DIR) val=$ENG_HOME/carpeta-anterior
            as_eng sh -c "mkdir -p '$val/apps' && printf 'export\n' > '$val/apps/app-1.0.zip' && printf 'hola\n' > '$val/leeme.txt'"
            manifest "$val" | awk '$5 != "-" {print $1, $5}' >"$W/before.extra.txt" ;;
          *_ENABLED) val=1 ;;
          *_URL) val=http://127.0.0.1:9/repositorio ;;
          *_PASSWORD) val='Clave-de-prueba-9' ;;
          *_USER) val=descargas ;;
          *) val=valor-de-prueba ;;
        esac
        printf '%s=%s\n' "$k" "$val" >>"$CONF"
      done
      note "claves antiguas añadidas a config.env: $(printf '%s ' "${!RENAMED[@]}")"
      cp -a "$CONF" "$W/before.config.env"
    fi
  fi
  [ "$v" = "$NEW" ] && opt=("${PROFILE_OPT[@]}") || opt=()
  SUDO_USER=$ENG "${PKG[$v]}/install.sh" --yes "${opt[@]}" >"$W/install-$v.txt" 2>&1 || { cat "$W/install-$v.txt"; fail "actualización $PREV → $v"; }
  grep -E "claves renombradas|Perfil del proyecto|Segunda carpeta" "$W/install-$v.txt" | sed 's/^/    /' || true
  check_upgrade "$PREV" "$v"
  if [ "$SCEN" = sintetico ]; then login admin "$PW"; login tecnico "$PW2"; fi
  snapshot_state
  PREV=$v
done

# 2. Only the new version: profile, second folder, doctor -----------------------------------------------------------
if [ -n "$PROF_SRC" ] && [ -d "$PROF_SRC/plantillas" ]; then
  "${PY[@]}" templates "$DATA/relay-manager.db" "$PROF_SRC/plantillas" >"$W/tpl.txt" 2>&1 || { cat "$W/tpl.txt"; fail "plantillas del perfil"; }
  ok "$(cat "$W/tpl.txt")"
fi
EXTRA=$(conf_get "$CONF" RM_FILES_EXTRA_DIR)
if [ -n "$EXTRA" ]; then
  [ -d "$EXTRA" ] || fail "RM_FILES_EXTRA_DIR=$EXTRA no existe"
  grep -qx "BindPaths=$EXTRA" "$DROPINS"/*.conf || { cat "$DROPINS"/*.conf; fail "falta BindPaths=$EXTRA en los drop-ins"; }
  if [ -f "$W/before.extra.txt" ]; then
    [ "$EXTRA" = "$ENG_HOME/carpeta-anterior" ] || fail "la segunda carpeta es $EXTRA (se esperaba la de la clave antigua, $ENG_HOME/carpeta-anterior)"
    manifest "$EXTRA" | awk '$5 != "-" {print $1, $5}' | grep -Fxf "$W/before.extra.txt" | cmp -s - "$W/before.extra.txt" || fail "la segunda carpeta ha perdido ficheros"
  fi
  ok "segunda carpeta $EXTRA ($(stat -c '%a %U:%G' "$EXTRA")) con BindPaths="
else
  note "sin segunda carpeta"
fi
if [ "$SCEN" = real ]; then
  # One account of the copy gets a known password (the real ones are unknown), then logs in.
  U=$(python3 -c "import sqlite3;print(sqlite3.connect('file:$DATA/relay-manager.db?mode=ro',uri=True).execute('select username from User where disabled=0 order by isAdmin desc, username limit 1').fetchone()[0])")
  relay-manager user reset-password "$U" --password-stdin <<<"$PW" >/dev/null || fail "user reset-password $U"
  login "$U" "$PW"
fi
set +e
relay-manager doctor >"$W/doctor.txt" 2>&1
rc=$?
set -e
grep -vE '^\[ OK \]' "$W/doctor.txt" | grep -E '^\[' | sed 's/^/    doctor: /'
if grep -q '^\[FALLO\]' "$W/doctor.txt"; then
  BAD=$(grep '^\[FALLO\]' "$W/doctor.txt" | grep -vE "${RM_TEST_DOCTOR_EXPECTED:-^$}" || true)
  [ -z "$BAD" ] || fail "doctor (código $rc) con fallos: $BAD"
fi
if grep -q 'Variable no permitida' "$W/doctor.txt"; then fail "doctor: el perfil usa variables que esta versión no admite"; fi
ok "doctor $NEW: código $rc, sin fallos inesperados"
echo "== escenario $SCEN superado: ${VERS[*]}"
