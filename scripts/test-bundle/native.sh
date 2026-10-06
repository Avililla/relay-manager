#!/usr/bin/env bash
# Runs INSIDE the systemd test container (--network none) as root. Arguments: base version, upgrade without
# migrations, upgrade with a dummy migration. Bundles are in /bundles, the smoke client in /dist/test.
#   RM_TEST_PROFILE     a profile folder to install with install.sh --perfil ("" = the bundle's perfil/, if any)
#   RM_TEST_EXPORT_RUN  1 = also run the profile's own download script (offline-capable ones only)
set -euo pipefail
V0=$1
V1=$2
V2=$3
PW='native-password-1'
DATA=/var/lib/relay-manager
OUT=/tmp/out.txt

ok() { printf '[ OK ] %s\n' "$*"; }
fail() {
  printf '[FALLO] %s\n' "$*"
  echo "----- journal -----"
  journalctl -u relay-manager -n 60 --no-pager || true
  exit 1
}
extract() { # VERSION → prints the extracted directory
  local d="/root/pkg-$1"
  rm -rf "$d"
  mkdir -p "$d"
  tar -xzf "/bundles/relay-manager-$1-linux-x64.tar.gz" -C "$d" --strip-components=1
  printf '%s' "$d"
}
mode_owner() { stat -c '%a %U:%G' "$1"; }
expect_mode() { # PATH "MODE USER:GROUP"
  local got
  got=$(mode_owner "$1")
  [ "$got" = "$2" ] || fail "$1: $got (se esperaba $2)"
}
current() { basename "$(readlink -f /opt/relay-manager/current)"; }
# No "cmd | grep -q" under pipefail: grep exits early and the writer gets SIGPIPE (exit 141).
journal_has() {
  journalctl -u relay-manager --no-pager >/tmp/journal.txt 2>&1 || true
  grep -q -- "$1" /tmp/journal.txt
}
has_admin() {
  relay-manager user list >/tmp/users.txt 2>&1 || return 1
  grep -q '^admin ' /tmp/users.txt
}
active() { [ "$(systemctl is-active relay-manager)" = active ]; }

echo "== $(systemctl --version | head -n 1); red: $(find /sys/class/net -mindepth 1 -maxdepth 1 -printf '%f ')"
P0=$(extract "$V0")
P1=$(extract "$V1")
P2=$(extract "$V2")

# An engineer account that runs install.sh with sudo: "Archivos" goes to its ~/tftp (Ubuntu homes are 0750).
ENG=ingeniero
ENG_HOME=/home/$ENG
FILES=$ENG_HOME/tftp
PROF=/etc/relay-manager/perfil
PROFILE_OPT=()
if [ -n "${RM_TEST_PROFILE:-}" ]; then PROFILE_OPT=(--perfil "$RM_TEST_PROFILE"); fi
id "$ENG" >/dev/null 2>&1 || useradd -m -s /bin/bash "$ENG"
chmod 0750 "$ENG_HOME"
as_eng() { setpriv --reuid="$ENG" --regid="$ENG" --init-groups "$@"; }
# «Copiar como administrador (sudo)»: the engineer is the bench's admin (group sudo) with a password; root stays locked
# as in the images (and on a desktop install that uses sudo).
SUDOPW='sudo-del-ingeniero-1'
usermod -aG sudo "$ENG"
set_pw() { # USER PASSWORD [METHOD]
  if [ -n "${3:-}" ]; then printf '%s:%s\n' "$1" "$2" | chpasswd -c "$3"; else printf '%s:%s\n' "$1" "$2" | chpasswd; fi
}
set_pw "$ENG" "$SUDOPW"
smoke() { # BASE_URL SMOKE_FILE [EXPECT] → sets SHA (sha256 of the uploaded file)
  RM_SMOKE_FILE="$2" RM_SMOKE_FILES_EXPECT="${3:-}" RM_SMOKE_PROFILE="${SMOKE_PROFILE:--}" /opt/relay-manager/current/node/bin/node /dist/test/smoke-client.cjs "$1" admin "$PW" >/tmp/smoke.txt 2>&1 ||
    { cat /tmp/smoke.txt; fail "smoke-client contra el servicio"; }
  grep -E '^\[' /tmp/smoke.txt
  SHA=$(sed -n 's/.*archivo=[^ ]* sha256=\([0-9a-f]*\).*/\1/p' /tmp/smoke.txt)
}

# 1. Fresh install -----------------------------------------------------------
SUDO_USER=$ENG "$P0/install.sh" --yes "${PROFILE_OPT[@]}" >"$OUT" 2>&1 || { cat "$OUT"; fail "install.sh $V0"; }
active || fail "el servicio no está activo tras instalar"
grep -q "http://" "$OUT" || fail "install.sh no imprime las URL"
grep -q "Código de configuración:" "$OUT" || fail "install.sh no imprime el código de configuración"
ok "instalación $V0: servicio activo, URL y código de configuración impresos"
sed -n '/Diagnóstico/,$p' "$OUT"
expect_mode "$DATA" "750 relay-manager:relay-manager"
expect_mode "$DATA/relay-manager.db" "640 relay-manager:relay-manager"
expect_mode "$DATA/auth-secret" "600 relay-manager:relay-manager"
expect_mode "$DATA/backups" "750 relay-manager:relay-manager"
expect_mode "$DATA/consoles" "750 relay-manager:relay-manager"
expect_mode "$DATA/setup-token" "600 relay-manager:relay-manager"
expect_mode /etc/relay-manager/config.env "640 root:relay-manager"
[ -f /etc/udev/rules.d/99-relay-manager.rules ] || fail "falta la regla udev"
[ "$(readlink /usr/local/bin/relay-manager)" = /opt/relay-manager/current/bin/relay-manager ] || fail "enlace /usr/local/bin/relay-manager"
[[ " $(id -nG relay-manager) " == *" dialout "* ]] || fail "relay-manager no está en dialout"
ok "estructura: permisos y propietarios de §2.5, regla udev, enlace y grupo dialout"

# The project profile: in /etc/relay-manager/perfil (root:relay-manager, files 640, dirs and herramientas/*.sh 750),
# never in the release (its scripts may carry credentials) nor app/tools/.
HAS_PROFILE=0
if [ -n "${RM_TEST_PROFILE:-}" ] || [ -d "$P0/perfil" ]; then HAS_PROFILE=1; fi
PROFILE_SRC="${RM_TEST_PROFILE:-$P0/perfil}"
check_profile() { # the installed profile: same files as PROFILE_SRC, owners and modes
  expect_mode "$PROF" "750 root:relay-manager"
  local bad
  bad=$(find "$PROF" \( -type d ! -perm 750 \) -o \( -type f -path "$PROF/herramientas/*.sh" ! -perm 750 \) -o \
    \( -type f ! -path "$PROF/herramientas/*.sh" ! -perm 640 \) -o ! -user root -o ! -group relay-manager | head -n 5)
  [ -z "$bad" ] || { ls -laR "$PROF" | head -n 40; fail "permisos o propietarios inesperados en el perfil: $bad"; }
  (cd "$PROFILE_SRC" && find . -type f ! -path './.git/*' ! -path './.hg/*' ! -path './.svn/*' ! -name .gitignore ! -name .gitattributes ! -name '*~' ! -name '*.swp' | sort) >/tmp/perfil-origen.txt
  (cd "$PROF" && find . -type f | sort) >/tmp/perfil-instalado.txt
  cmp -s /tmp/perfil-origen.txt /tmp/perfil-instalado.txt || { diff /tmp/perfil-origen.txt /tmp/perfil-instalado.txt; fail "el perfil instalado no tiene los mismos ficheros que $PROFILE_SRC"; }
}
if [ "$HAS_PROFILE" = 1 ]; then
  check_profile
  grep -q "Perfil del proyecto: $PROF" "$OUT" || { cat "$OUT"; fail "install.sh no informa del perfil"; }
  ok "perfil instalado desde $PROFILE_SRC en $PROF: $(find "$PROF/plantillas" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l) plantillas; 750/640, herramientas/*.sh 750, root:relay-manager"
else
  [ ! -e "$PROF" ] || fail "sin perfil, install.sh ha creado $PROF"
  grep -q "Sin perfil del proyecto" "$OUT" || { cat "$OUT"; fail "install.sh no avisa de que no hay perfil"; }
  ok "sin perfil: valores genéricos"
fi
[ ! -e /opt/relay-manager/current/perfil ] && [ ! -e /opt/relay-manager/current/app/tools ] || fail "la versión instalada lleva perfil/ o app/tools/"
# Effective profile values (config.env wins over perfil.env, as in the app).
pget() { # KEY → config.env, else perfil.env
  local v
  v=$(sed -n "s/^[[:space:]]*$1=//p" /etc/relay-manager/config.env | tail -n 1 | tr -d "\"'")
  if [ -z "$v" ] && [ -f "$PROF/perfil.env" ]; then
    v=$(/opt/relay-manager/current/node/bin/node -e 'const v = require("util").parseEnv(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (v !== undefined) process.stdout.write(v)' "$PROF/perfil.env" "$1")
  fi
  printf '%s' "$v"
}
SMOKE_PROFILE=-
[ "$HAS_PROFILE" = 0 ] || SMOKE_PROFILE=$PROF
# The second folder of Archivos: only when the profile names it; «~» in its RM_FILES_EXTRA_DIR = the sudo user's home.
EXTRA_NAME=$(pget RM_FILES_EXTRA_NAME)
EXTRA_ON=0
EXTRA=""
if [ -n "$EXTRA_NAME" ] && [ "$(pget RM_FILES_EXTRA_ENABLED)" != 0 ]; then
  EXTRA_ON=1
  EXTRA=$(sed -n "s/^[[:space:]]*RM_FILES_EXTRA_DIR=//p" /etc/relay-manager/config.env | tail -n 1)
  [ -n "$EXTRA" ] || fail "install.sh no escribe RM_FILES_EXTRA_DIR en config.env (segunda carpeta «$EXTRA_NAME»)"
  WANT=""
  if [ -f "$PROF/perfil.env" ]; then
    WANT=$(/opt/relay-manager/current/node/bin/node -e 'const v = require("util").parseEnv(require("fs").readFileSync(process.argv[1], "utf8")).RM_FILES_EXTRA_DIR; if (v !== undefined) process.stdout.write(v)' "$PROF/perfil.env")
  fi
  case "$WANT" in "") WANT="$DATA/$EXTRA_NAME" ;; "~") WANT=$ENG_HOME ;; "~/"*) WANT="$ENG_HOME/${WANT#\~/}" ;; esac
  [ "$EXTRA" = "$WANT" ] || fail "RM_FILES_EXTRA_DIR=$EXTRA en config.env (se esperaba $WANT)"
fi
as_owner() { # DIR CMD…: runs CMD as the owner of DIR
  local d=$1
  shift
  setpriv --reuid="$(stat -c %U "$d")" --regid="$(stat -c %G "$d")" --init-groups "$@"
}
systemd-analyze verify /etc/systemd/system/relay-manager.service || fail "systemd-analyze verify"
# udevadm verify exists since systemd 253: Debian 12 (bookworm) has 252.
if udevadm verify --help >/dev/null 2>&1; then
  udevadm verify /etc/udev/rules.d/99-relay-manager.rules >/dev/null || fail "udevadm verify"
  ok "systemd-analyze verify y udevadm verify sin errores"
else
  ok "systemd-analyze verify sin errores (udevadm verify no existe en systemd $(systemctl --version | head -n 1 | awk '{print $2}'))"
fi

# Red de equipos: CAP_NET_ADMIN (and nothing else) for the service; NetworkManager drop-in only where NM exists.
grep -qx 'AmbientCapabilities=CAP_NET_ADMIN' /etc/systemd/system/relay-manager.service || fail "la unidad no da CAP_NET_ADMIN (AmbientCapabilities)"
grep -qx 'CapabilityBoundingSet=CAP_NET_ADMIN' /etc/systemd/system/relay-manager.service || fail "la unidad no limita las capacidades a CAP_NET_ADMIN"
MPID=$(systemctl show -p MainPID --value relay-manager)
[ -n "$MPID" ] && [ "$MPID" != 0 ] || fail "no se encuentra el proceso principal del servicio"
EFF=$(sed -n 's/^CapEff:[[:space:]]*//p' "/proc/$MPID/status")
BND=$(sed -n 's/^CapBnd:[[:space:]]*//p' "/proc/$MPID/status")
[ "$EFF" = 0000000000001000 ] || fail "el servicio tiene CapEff $EFF (se esperaba solo CAP_NET_ADMIN, 0000000000001000)"
[ "$BND" = 0000000000001000 ] || fail "el servicio tiene CapBnd $BND (se esperaba solo CAP_NET_ADMIN)"
NMF=/etc/NetworkManager/conf.d/90-relay-manager-red-equipos.conf
if [ -d /etc/NetworkManager ]; then
  grep -qx 'unmanaged-devices=interface-name:rmv\*' "$NMF" || fail "install.sh no instala $NMF"
  nm_note="drop-in de NetworkManager instalado"
else
  [ ! -e "$NMF" ] || fail "install.sh crea $NMF sin NetworkManager"
  nm_note="sin NetworkManager: drop-in omitido"
fi
ok "servicio con CapEff y CapBnd = CAP_NET_ADMIN (0x1000); $nm_note"
# Own output file: $OUT still holds what install.sh printed (checked below).
NMOUT=$(mktemp)
mkdir -p /etc/NetworkManager/conf.d
relay-manager red-equipos 02:00:00:00:00:0A >"$NMOUT" 2>&1 || { cat "$NMOUT"; fail "relay-manager red-equipos <MAC>"; }
grep -qx 'unmanaged-devices=interface-name:rmv\*;mac:02:00:00:00:00:0a' "$NMF" || { cat "$NMF"; fail "red-equipos no escribe la MAC (en minúsculas)"; }
if relay-manager red-equipos '02:00:00:00:00:0a
[main]' >"$NMOUT" 2>&1; then fail "red-equipos acepta una MAC con salto de línea"; fi
if relay-manager red-equipos 02:00:00:00:00 >"$NMOUT" 2>&1; then fail "red-equipos acepta una MAC incompleta"; fi
grep -q 'MAC no válida' "$NMOUT" || { cat "$NMOUT"; fail "red-equipos no explica la MAC no válida"; }
grep -qx 'unmanaged-devices=interface-name:rmv\*;mac:02:00:00:00:00:0a' "$NMF" || fail "una MAC no válida ha cambiado $NMF"
relay-manager red-equipos --quitar >"$NMOUT" 2>&1 || { cat "$NMOUT"; fail "red-equipos --quitar"; }
grep -qx 'unmanaged-devices=interface-name:rmv\*' "$NMF" || fail "red-equipos --quitar no deja solo rmv*"
relay-manager red-equipos 02:00:00:00:00:01 >"$NMOUT" 2>&1 || { cat "$NMOUT"; fail "relay-manager red-equipos <MAC>"; }
ok "relay-manager red-equipos: MAC en $NMF, --quitar, MAC no válida rechazada"

TOKEN=$(relay-manager setup-token)
ok "setup-token (como root, vía setpriv): $TOKEN"
relay-manager user create admin --admin --password-stdin <<<"$PW" >/dev/null
# Archivos in the engineer's home: folder, config, drop-in, group; a file copied there by hand is downloadable.
grep -q "Carpeta de Archivos (subidas y descargas desde la web): $FILES" "$OUT" || { cat "$OUT"; fail "install.sh no muestra la carpeta de Archivos"; }
grep -qx "RM_FILES_DIR=$FILES" /etc/relay-manager/config.env || fail "RM_FILES_DIR=$FILES no está en config.env"
expect_mode "$FILES" "2775 $ENG:relay-files"
grep -qx "ProtectHome=tmpfs" /etc/systemd/system/relay-manager.service.d/archivos.conf || fail "falta ProtectHome=tmpfs en el drop-in"
grep -qx "BindPaths=$FILES" /etc/systemd/system/relay-manager.service.d/archivos.conf || fail "falta BindPaths=$FILES en el drop-in"
[ "$(systemctl show -p ProtectHome --value relay-manager)" = tmpfs ] || fail "systemd no aplica ProtectHome=tmpfs"
[[ " $(id -nG "$ENG") " == *" relay-files "* ]] || fail "$ENG no está en el grupo relay-files"
[[ " $(id -nG "$ENG") " != *" relay-manager "* ]] || fail "$ENG no debe estar en el grupo relay-manager (lee la base de datos)"
[[ " $(id -nG relay-manager) " == *" relay-files "* ]] || fail "relay-manager no está en el grupo relay-files"
as_eng sh -c "umask 022; printf 'copiado a mano por el ingeniero\n' > $FILES/manual.txt" || fail "el ingeniero no puede escribir en $FILES"
MSHA=$(sha256sum "$FILES/manual.txt" | cut -d' ' -f1)
smoke http://127.0.0.1:3200 smoke-native.bin "manual.txt:$MSHA"
[ -n "$SHA" ] || fail "smoke-client no informa del archivo subido"
if journal_has EROFS; then fail "EROFS en el registro del servicio"; fi
ok "rutas visitadas bajo la unidad sin EROFS en el registro"
expect_mode "$FILES/smoke-native.bin" "664 relay-manager:relay-files"
[ "$(sha256sum "$FILES/smoke-native.bin" | cut -d' ' -f1)" = "$SHA" ] || fail "el archivo subido no coincide en el disco"
[ -z "$(find "$FILES" -name '.rm-upload-*' -print -quit)" ] || fail "quedan temporales de subida en $FILES"
as_eng sh -c "cat $FILES/smoke-native.bin >/dev/null && printf x >> $FILES/smoke-native.bin && mv $FILES/smoke-native.bin $FILES/editado.bin && rm $FILES/editado.bin" ||
  fail "$ENG no puede leer, modificar, renombrar y borrar lo que sube la web"
ok "Archivos: $FILES (2775 $ENG:relay-files, drop-in ProtectHome=tmpfs + BindPaths); subida → 664 relay-manager:relay-files con el mismo sha256; lo copiado a mano se descarga; $ENG lo edita y lo borra"
# The second folder (root "extra"): same group and mode; in a home, its own BindPaths= in the same drop-in.
DROPIN=/etc/systemd/system/relay-manager.service.d/archivos.conf
if [ "$EXTRA_ON" = 1 ]; then
  grep -q "Segunda carpeta de Archivos, «$EXTRA_NAME»: $EXTRA" "$OUT" || { cat "$OUT"; fail "install.sh no muestra la segunda carpeta"; }
  case "$EXTRA/" in
    "$ENG_HOME"/*)
      expect_mode "$EXTRA" "2775 $ENG:relay-files"
      grep -qx "BindPaths=$EXTRA" "$DROPIN" || { cat "$DROPIN"; fail "falta BindPaths=$EXTRA en el drop-in"; }
      ;;
    "$DATA"/*) expect_mode "$EXTRA" "2775 relay-manager:relay-files" ;;
  esac
  [ "$(grep -c '^ProtectHome=tmpfs$' "$DROPIN")" = 1 ] || fail "ProtectHome=tmpfs debe estar una sola vez en el drop-in"
  as_owner "$EXTRA" sh -c "umask 002; printf 'en la segunda carpeta\n' > '$EXTRA/leeme.txt'" || fail "el dueño de $EXTRA no puede escribir en ella"
  ok "segunda carpeta «$EXTRA_NAME»: $EXTRA ($(stat -c '%a %U:%G' "$EXTRA")), RM_FILES_EXTRA_DIR en config.env"
else
  if grep -q '^RM_FILES_EXTRA_DIR=' /etc/relay-manager/config.env; then fail "sin segunda carpeta en el perfil, install.sh escribe RM_FILES_EXTRA_DIR"; fi
  ok "sin segunda carpeta (el perfil no la nombra)"
fi
relay-manager doctor >/tmp/doctor.txt || { cat /tmp/doctor.txt; fail "doctor terminó con código distinto de 0 (sin red ni zip: el script de descarga solo debe avisar)"; }
grep -q "Servicio relay-manager activo" /tmp/doctor.txt || fail "doctor no ve el servicio activo"
grep -q "Carpeta de archivos" /tmp/doctor.txt || { cat /tmp/doctor.txt; fail "doctor no comprueba la carpeta de archivos"; }
ok "doctor (servicio) sale con 0: $(tail -n 1 /tmp/doctor.txt)"
# 1c. «Copiar a una carpeta del servidor»: as the service (ReadWritePaths=/mnt) and «como administrador (sudo)» through
#     the root helper (socket-activated, its own sandbox), authenticated with the engineer's password.
RCS=/run/relay-manager-rootcopy/rootcopy.sock
systemctl is-enabled relay-manager-rootcopy.socket >/dev/null || fail "relay-manager-rootcopy.socket no está habilitado"
[ "$(systemctl is-active relay-manager-rootcopy.socket)" = active ] || fail "relay-manager-rootcopy.socket no está activo"
[ -S "$RCS" ] || fail "no existe el socket $RCS"
expect_mode "$RCS" "660 root:relay-manager"
expect_mode /etc/relay-manager/rootcopy.env "644 root:root"
grep -qx "RM_SUDO_USER=$ENG" /etc/relay-manager/rootcopy.env || { cat /etc/relay-manager/rootcopy.env; fail "rootcopy.env no tiene RM_SUDO_USER=$ENG"; }
grep -qx "RM_SUDO_USER=$ENG" /etc/relay-manager/config.env || fail "config.env no tiene RM_SUDO_USER=$ENG (SUDO_USER de install.sh)"
grep -q "Copiar a una carpeta del servidor como administrador (sudo): contraseña de $ENG" "$OUT" || { cat "$OUT"; fail "install.sh no informa del usuario de sudo"; }
systemd-analyze verify /etc/systemd/system/relay-manager-rootcopy.socket /etc/systemd/system/relay-manager-rootcopy.service || fail "systemd-analyze verify del ayudante"
show() { systemctl show -p "$2" --value "$1"; }
[ "$(show relay-manager-rootcopy.service NoNewPrivileges)" = yes ] && [ "$(show relay-manager-rootcopy.service ProtectSystem)" = strict ] &&
  [ "$(show relay-manager-rootcopy.service PrivateNetwork)" = yes ] && [ "$(show relay-manager-rootcopy.service RestrictAddressFamilies)" = AF_UNIX ] ||
  fail "el ayudante no tiene el aislamiento esperado"
CBS=$(show relay-manager-rootcopy.service CapabilityBoundingSet)
[ "$CBS" = "cap_chown cap_dac_override cap_dac_read_search cap_fowner" ] || fail "CapabilityBoundingSet del ayudante: $CBS"
[ "$(show relay-manager NoNewPrivileges)" = yes ] || fail "el servicio principal debe seguir con NoNewPrivileges"
[ "$(show relay-manager User)" = relay-manager ] || fail "el servicio principal no corre como relay-manager"
ok "ayudante relay-manager-rootcopy: socket 660 root:relay-manager, rootcopy.env 644 root:root (RM_SUDO_USER=$ENG), NoNewPrivileges, ProtectSystem=strict, PrivateNetwork, AF_UNIX, capacidades: $CBS"
NODE=/opt/relay-manager/current/node/bin/node
conn_probe='require("net").connect(process.argv[1]).on("error",(e)=>{console.log(e.code);process.exit(0)}).on("connect",()=>{console.log("CONECTADO");process.exit(0)})'
[ "$(as_eng "$NODE" -e "$conn_probe" "$RCS")" = EACCES ] || fail "$ENG (sin el grupo relay-manager) puede conectar al socket del ayudante"
[ "$(setpriv --reuid=relay-manager --regid=relay-manager --init-groups "$NODE" -e "$conn_probe" "$RCS")" = CONECTADO ] || fail "el usuario del servicio no puede conectar al socket"
ok "solo el usuario del servicio conecta al socket (EACCES para $ENG)"
copy_smoke() { # JSON WHAT → output in /tmp/copy.txt
  RM_SMOKE_COPY="$1" "$NODE" /dist/test/smoke-client.cjs http://127.0.0.1:3200 admin "$PW" >/tmp/copy.txt 2>&1 || { cat /tmp/copy.txt; fail "$2"; }
}
copied_ok() { # PATH "MODE USER:GROUP" SHA
  expect_mode "$1" "$2"
  [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$3" ] || fail "$1 no coincide con el original"
}
install -d -m 0755 -o relay-manager -g relay-manager /mnt/usb-servicio
copy_smoke '{"file":"manual.txt","dest":"/mnt/usb-servicio","asRoot":false}' "copia como el servicio a /mnt"
copied_ok /mnt/usb-servicio/manual.txt "644 relay-manager:relay-manager" "$MSHA"
grep -q 'root=disponible usuario=ingeniero rutas=/media,/run/media,/mnt' /tmp/copy.txt || { cat /tmp/copy.txt; fail "la web no ve el ayudante disponible con el usuario $ENG"; }
ok "copia como el servicio a /mnt (ReadWritePaths): 644 relay-manager, sha256 igual; ayudante disponible para $ENG"
install -d -m 0755 -o root -g root /mnt/usb-root
copy_smoke '{"file":"manual.txt","dest":"/mnt/usb-root","asRoot":false,"expectStatus":403,"expectMessage":"copia como administrador"}' "una carpeta de root sin sudo debería pedir la copia como administrador"
grep -q needsRoot /tmp/copy.txt || fail "la respuesta no ofrece la copia como administrador"
copy_smoke '{"file":"manual.txt","dest":"/mnt/usb-root","asRoot":true,"password":"mala","expectStatus":403,"expectMessage":"Contraseña incorrecta para «ingeniero»"}' "contraseña incorrecta"
[ ! -e /mnt/usb-root/manual.txt ] || fail "con la contraseña incorrecta se ha copiado"
copy_smoke "{\"file\":\"manual.txt\",\"dest\":\"/mnt/usb-root\",\"asRoot\":true,\"password\":\"$SUDOPW\"}" "copia como administrador a una carpeta de root"
copied_ok /mnt/usb-root/manual.txt "644 root:root" "$MSHA"
grep -q 'root=true usuario=ingeniero' /tmp/copy.txt || { cat /tmp/copy.txt; fail "la copia no dice que fue como administrador"; }
[ -z "$(find /mnt/usb-root -name '.rm-copy-*' -print -quit)" ] || fail "quedan temporales en /mnt/usb-root"
ok "carpeta de root: sin sudo → 403 «copia como administrador»; contraseña mala → 403; con la de $ENG → 644 root:root, sha256 igual"
# A desktop automount: /media/<user> only for that user (0750 root + the user's stick 0700): the service cannot even look.
install -d -m 0750 -o root -g root "/media/$ENG"
install -d -m 0700 -o "$ENG" -g "$ENG" "/media/$ENG/USB"
copy_smoke "{\"file\":\"manual.txt\",\"dest\":\"/media/$ENG/USB\",\"asRoot\":false,\"expectStatus\":403,\"expectMessage\":\"copia como administrador\"}" "pendrive del escritorio sin sudo"
copy_smoke "{\"file\":\"manual.txt\",\"dest\":\"/media/$ENG/USB\",\"asRoot\":true,\"password\":\"$SUDOPW\"}" "pendrive del escritorio como administrador"
copied_ok "/media/$ENG/USB/manual.txt" "644 $ENG:$ENG" "$MSHA"
ok "pendrive del escritorio (/media/$ENG/USB 0700 de $ENG): como administrador, el archivo queda de $ENG (644)"
copy_smoke "{\"file\":\"manual.txt\",\"dest\":\"/srv\",\"asRoot\":true,\"password\":\"$SUDOPW\",\"expectStatus\":403,\"expectMessage\":\"RM_COPY_ROOT_PATHS\"}" "fuera de RM_COPY_ROOT_PATHS"
copy_smoke "{\"file\":\"manual.txt\",\"dest\":\"/etc\",\"asRoot\":true,\"password\":\"$SUDOPW\",\"expectStatus\":403,\"expectMessage\":\"carpeta del sistema\"}" "a /etc"
ln -s /etc /mnt/enlace-etc
copy_smoke "{\"file\":\"manual.txt\",\"dest\":\"/mnt/enlace-etc\",\"asRoot\":true,\"password\":\"$SUDOPW\",\"expectStatus\":403,\"expectMessage\":\"carpeta del sistema\"}" "un enlace a /etc"
rm /mnt/enlace-etc
# /etc bind-mounted under /mnt: by its path it is in /mnt, but it is /etc (the helper reads its mountinfo).
mkdir -p /mnt/etc-bind
mount --bind /etc /mnt/etc-bind
systemctl stop relay-manager-rootcopy.service # the next connection starts it again and sees the new mount
copy_smoke "{\"file\":\"manual.txt\",\"dest\":\"/mnt/etc-bind\",\"asRoot\":true,\"password\":\"$SUDOPW\",\"expectStatus\":403,\"expectMessage\":\"montada en otro sitio\"}" "/etc montada en /mnt"
umount /mnt/etc-bind
rmdir /mnt/etc-bind
[ ! -e /srv/manual.txt ] && [ ! -e /etc/manual.txt ] || fail "se ha copiado fuera de lo permitido"
ok "como administrador: fuera de RM_COPY_ROOT_PATHS, /etc, un enlace a /etc y /etc montada en /mnt → 403"
# The three hash formats of /etc/shadow, as the system writes them (chpasswd -c).
for m in SHA512 SHA256 YESCRYPT; do
  set_pw "$ENG" "$SUDOPW" "$m" 2>/dev/null || { echo "    chpasswd -c $m no disponible: se omite"; continue; }
  pfx=$(getent shadow "$ENG" | cut -d: -f2 | cut -d'$' -f2)
  copy_smoke "{\"file\":\"manual.txt\",\"dest\":\"/mnt/usb-root\",\"asRoot\":true,\"password\":\"$SUDOPW\",\"conflict\":\"replace\"}" "copia como administrador con la contraseña en $m"
  echo "    contraseña en \$$pfx\$ ($m): aceptada"
done
relay-manager doctor >/tmp/doctor-rc.txt 2>&1 || true
grep -q "Copia como administrador (sudo)" /tmp/doctor-rc.txt && grep -q "Ayudante listo: contraseña de $ENG" /tmp/doctor-rc.txt || { cat /tmp/doctor-rc.txt; fail "doctor no ve el ayudante listo"; }
relay-manager doctor --json >/tmp/doctor-rc.json 2>/dev/null || true
ok "contraseñas sha512, sha256 y yescrypt aceptadas; doctor: $(grep -o 'Ayudante listo[^"]*' /tmp/doctor-rc.txt | head -n 1)"
# 5 wrong passwords lock it (even the right one) for 10 minutes; the count lives in the helper's state directory.
for i in 1 2 3 4; do
  copy_smoke "{\"file\":\"manual.txt\",\"dest\":\"/mnt/usb-root\",\"asRoot\":true,\"password\":\"mala$i\",\"expectStatus\":403,\"expectMessage\":\"Contraseña incorrecta\"}" "intento $i"
done
copy_smoke '{"file":"manual.txt","dest":"/mnt/usb-root","asRoot":true,"password":"mala5","expectStatus":403,"expectMessage":"Demasiados intentos"}' "el quinto intento debería bloquear"
copy_smoke "{\"file\":\"manual.txt\",\"dest\":\"/mnt/usb-root\",\"asRoot\":true,\"password\":\"$SUDOPW\",\"expectStatus\":403,\"expectMessage\":\"Demasiados intentos\"}" "bloqueado también con la contraseña buena"
expect_mode /var/lib/relay-manager-rootcopy "700 root:root"
expect_mode /var/lib/relay-manager-rootcopy/intentos.json "600 root:root"
rm -f /var/lib/relay-manager-rootcopy/intentos.json # as if the 10 minutes had passed
copy_smoke "{\"file\":\"manual.txt\",\"dest\":\"/mnt/usb-root\",\"asRoot\":true,\"password\":\"$SUDOPW\",\"conflict\":\"keep\"}" "tras el bloqueo"
grep -q 'final=/mnt/usb-root/manual (1).txt' /tmp/copy.txt || { cat /tmp/copy.txt; fail "«Conservar ambos» no da «manual (1).txt»"; }
ok "5 contraseñas incorrectas bloquean (también la buena); intentos.json 600 root; «Conservar ambos» → manual (1).txt"
# Never the password: not in the database, the WAL, the journal nor the helper's state.
if grep -a -q -- "$SUDOPW" "$DATA"/relay-manager.db* /var/lib/relay-manager-rootcopy/* 2>/dev/null; then fail "la contraseña de sudo está en disco"; fi
journalctl --no-pager >/tmp/journal-all.txt 2>&1 || true
if grep -q -- "$SUDOPW" /tmp/journal-all.txt; then fail "la contraseña de sudo está en el registro"; fi
"$NODE" -e "
  const r = require('module').createRequire('/opt/relay-manager/current/app/server.js');
  const db = new (r('better-sqlite3'))('$DATA/relay-manager.db', { readonly: true });
  const rows = db.prepare(\"SELECT outcome, detail FROM AuditEvent WHERE action = 'files.copy'\").all();
  const ok = rows.filter((x) => x.outcome === 'ok' && /\"asRoot\":true/.test(x.detail) && /\"rootUser\":\"$ENG\"/.test(x.detail)).length;
  const denied = rows.filter((x) => x.outcome === 'denied' && /\"code\":\"(AUTH|LOCKED)\"/.test(x.detail)).length;
  console.log(ok + ' ' + denied); process.exit(ok >= 3 && denied >= 6 ? 0 : 1)" >/tmp/audit-rc.txt || { cat /tmp/audit-rc.txt; fail "auditoría files.copy"; }
ok "auditoría files.copy: $(cut -d' ' -f1 /tmp/audit-rc.txt) copias como administrador ($ENG) y $(cut -d' ' -f2 /tmp/audit-rc.txt) contraseñas rechazadas; la contraseña no está en disco ni en el registro"
# Who authenticates is install.sh's decision: a user without sudo, and root without a password, are refused clearly.
id otro >/dev/null 2>&1 || useradd -m -s /bin/bash otro
set_pw otro 'otro-password-1'
"$P0/install.sh" --yes --sudo-user otro >"$OUT" 2>&1 || { cat "$OUT"; fail "install.sh --sudo-user otro"; }
grep -q "otro no está en ninguno de los grupos sudo,wheel,admin" "$OUT" || { cat "$OUT"; fail "install.sh no avisa de que otro no tiene sudo"; }
copy_smoke '{"file":"manual.txt","dest":"/mnt/usb-root","asRoot":true,"password":"otro-password-1","expectStatus":503,"expectMessage":"no es administrador"}' "un usuario sin sudo"
"$P0/install.sh" --yes --sudo-user root >"$OUT" 2>&1 || { cat "$OUT"; fail "install.sh --sudo-user root"; }
grep -q "la cuenta root no tiene contraseña" "$OUT" || { cat "$OUT"; fail "install.sh no avisa de que root no tiene contraseña"; }
copy_smoke '{"file":"manual.txt","dest":"/mnt/usb-root","asRoot":true,"password":"cualquiera","expectStatus":503,"expectMessage":"^La cuenta root no tiene contraseña"}' "root sin contraseña"
"$P0/install.sh" --yes --sudo-user "$ENG" >"$OUT" 2>&1 || { cat "$OUT"; fail "install.sh --sudo-user $ENG"; }
grep -qx "RM_SUDO_USER=$ENG" /etc/relay-manager/rootcopy.env || fail "no se volvió a $ENG"
ok "--sudo-user otro (sin sudo) → «no es administrador»; --sudo-user root (bloqueada) → «La cuenta root no tiene contraseña…»; vuelta a $ENG"

# 1d. «Montar / Expulsar» pendrives through the mount helper (relay-manager-rootmount: socket root:root 0600, CAP_SYS_ADMIN
#     only, NO private mount namespace) and the elevation of «como administrador» (5 min per browser session).
RMS=/run/relay-manager-rootmount/rootmount.sock
systemctl is-enabled relay-manager-rootmount.socket >/dev/null || fail "relay-manager-rootmount.socket no está habilitado"
[ "$(systemctl is-active relay-manager-rootmount.socket)" = active ] || fail "relay-manager-rootmount.socket no está activo"
[ -S "$RMS" ] || fail "no existe el socket $RMS"
expect_mode "$RMS" "600 root:root"
systemd-analyze verify /etc/systemd/system/relay-manager-rootmount.socket /etc/systemd/system/relay-manager-rootmount.service || fail "systemd-analyze verify del ayudante de montaje"
[ "$(show relay-manager-rootmount.service NoNewPrivileges)" = yes ] && [ "$(show relay-manager-rootmount.service RestrictAddressFamilies)" = AF_UNIX ] &&
  [ "$(show relay-manager-rootmount.service ProtectSystem)" = no ] && [ "$(show relay-manager-rootmount.service PrivateTmp)" = no ] &&
  [ "$(show relay-manager-rootmount.service PrivateDevices)" = no ] && [ "$(show relay-manager-rootmount.service DevicePolicy)" = closed ] ||
  fail "el ayudante de montaje no tiene el aislamiento esperado (sin espacio de montaje propio, AF_UNIX, DevicePolicy=closed)"
MCBS=$(show relay-manager-rootmount.service CapabilityBoundingSet)
[ "$MCBS" = cap_sys_admin ] || fail "CapabilityBoundingSet del ayudante de montaje: $MCBS (se esperaba solo cap_sys_admin)"
[ "$(as_eng "$NODE" -e "$conn_probe" "$RMS")" = EACCES ] || fail "$ENG puede conectar al socket del ayudante de montaje"
[ "$(setpriv --reuid=relay-manager --regid=relay-manager --init-groups "$NODE" -e "$conn_probe" "$RMS")" = EACCES ] || fail "el usuario del servicio puede conectar al socket del ayudante de montaje (solo root)"
ok "ayudante relay-manager-rootmount: socket 600 root:root (ni $ENG ni el servicio conectan), solo cap_sys_admin, sin espacio de montaje propio, DevicePolicy=closed"

# Elevated browsing of a root-only folder: the password once, then the session's token (no password), until «Olvidar permisos».
install -d -m 0700 -o root -g root /mnt/secreto
printf 'solo root\n' >/mnt/secreto/secreto.txt
chmod 0600 /mnt/secreto/secreto.txt
api_steps() { # JSON WHAT → output in /tmp/steps.txt
  RM_SMOKE_STEPS="$1" "$NODE" /dist/test/smoke-client.cjs http://127.0.0.1:3200 admin "$PW" >/tmp/steps.txt 2>&1 || { cat /tmp/steps.txt; fail "$2"; }
}
api_steps "$(cat <<EOF_STEPS
[
 {"name":"sin-permiso","path":"/api/files/copy/browse?path=/mnt/secreto","match":["\"needsElevation\":true","\"readable\":false"],"noMatch":"secreto\\\\.txt"},
 {"name":"mala","method":"POST","path":"/api/files/copy/browse","body":{"path":"/mnt/secreto","hidden":false,"password":"mala"},"status":403,"message":"Contraseña incorrecta"},
 {"name":"con-contrasena","method":"POST","path":"/api/files/copy/browse","body":{"path":"/mnt/secreto","hidden":false,"password":"$SUDOPW"},"match":["\"name\":\"secreto\\\\.txt\"","\"asRoot\":true","\"elevation\":\\\\{"]},
 {"name":"reutiliza","path":"/api/files/copy/browse?path=/mnt/secreto","match":["\"name\":\"secreto\\\\.txt\"","\"asRoot\":true"]},
 {"name":"post-sin-contrasena","method":"POST","path":"/api/files/copy/browse","body":{"path":"/mnt/secreto","hidden":false,"password":null},"match":"secreto\\\\.txt"},
 {"name":"info","path":"/api/files/copy/info","match":"\"elevation\":\\\\{"},
 {"name":"olvidar","method":"DELETE","path":"/api/files/copy/elevation","status":204},
 {"name":"otra-vez","path":"/api/files/copy/browse?path=/mnt/secreto","match":"\"needsElevation\":true","noMatch":"secreto\\\\.txt"},
 {"name":"post-sin-permiso","method":"POST","path":"/api/files/copy/browse","body":{"path":"/mnt/secreto","hidden":false,"password":null},"status":403,"match":"\"needsPassword\":true"}
]
EOF_STEPS
)" "navegar como administrador por /mnt/secreto"
ok "carpeta de root 0700: la web pide permisos; con la contraseña lista secreto.txt; la sesión no la vuelve a pedir; «Olvidar permisos» → la pide otra vez"
if grep -a -q -- "$SUDOPW" /var/lib/relay-manager-rootcopy/* 2>/dev/null; then fail "la contraseña de sudo está en el estado del ayudante"; fi
[ -z "$(find /var/lib/relay-manager-rootcopy -type f ! -perm 600 -print -quit)" ] || fail "el estado del ayudante (clave de los permisos) no es 600"

# A fake USB stick: a vfat image (label RMTEST, made on the dev box) on a loop device. A loop device is not removable:
# the test-only hooks (unit Environment= of the mount helper, config.env of the service) name exactly this one.
cp /dist/test/usb-rmtest.img /root/usb.img
LOOP=$(losetup -f)
[ -b "$LOOP" ] || mknod "$LOOP" b 7 "${LOOP#/dev/loop}"
losetup "$LOOP" /root/usb.img || fail "losetup $LOOP"
loop_cleanup() {
  umount "/media/$ENG/RMTEST" 2>/dev/null || true
  losetup -d "$LOOP" 2>/dev/null || true
}
trap loop_cleanup EXIT
mkdir -p /etc/systemd/system/relay-manager-rootmount.service.d
printf '[Service]\nEnvironment=RM_ROOTMOUNT_TEST_LOOP=%s\nDeviceAllow=block-loop rw\n' "$LOOP" >/etc/systemd/system/relay-manager-rootmount.service.d/prueba.conf
printf '\nRM_COPY_TEST_REMOVABLE=%s\n' "$LOOP" >>/etc/relay-manager/config.env
# The desktop-automount simulation above made /media/$ENG 0750 root: the helper keeps such a folder; start clean so it
# creates /media/$ENG (0755) and the service can reach the stick itself.
rm -rf "/media/$ENG"
systemctl daemon-reload
systemctl stop relay-manager-rootmount.service relay-manager-rootcopy.service 2>/dev/null || true
systemctl restart relay-manager
for _ in $(seq 1 30); do relay-manager ping --quiet && break; sleep 1; done
active || fail "el servicio no arranca con RM_COPY_TEST_REMOVABLE"
MP=/media/$ENG/RMTEST
api_steps "$(cat <<EOF_STEPS
[
 {"name":"desmontado","path":"/api/files/copy/info","match":"\"device\":\"$LOOP\""},
 {"name":"mala","method":"POST","path":"/api/files/copy/mount","body":{"device":"$LOOP","password":"mala"},"status":403,"message":"Contraseña incorrecta"},
 {"name":"sin-contrasena","method":"POST","path":"/api/files/copy/mount","body":{"device":"$LOOP","password":null},"status":403,"match":"\"needsPassword\":true"},
 {"name":"montar","method":"POST","path":"/api/files/copy/mount","body":{"device":"$LOOP","password":"$SUDOPW"},"match":["\"mountPoint\":\"$MP\"","\"fsType\":\"vfat\"","\"serviceWritable\":true","\"elevation\":\\\\{"]},
 {"name":"unidad","path":"/api/files/copy/info","match":["\"mountPoint\":\"$MP\"","\"ejectable\":true","\"elevation\":\\\\{"],"noMatch":"\"device\":\"$LOOP\",\"disk\""},
 {"name":"copia-root","method":"POST","path":"/api/files/copy","body":{"paths":["manual.txt"],"destDir":"$MP","conflict":"keep","asRoot":true,"password":null},"status":202,"save":{"j1":"jobs.0.id"}},
 {"name":"copia-root-fin","wait":"copy","id":"\${j1}"},
 {"name":"copia-servicio","method":"POST","path":"/api/files/copy","body":{"paths":["manual.txt"],"destDir":"$MP","conflict":"keep","asRoot":false,"password":null},"status":202,"save":{"j2":"jobs.0.id"}},
 {"name":"copia-servicio-fin","wait":"copy","id":"\${j2}"},
 {"name":"navegar","path":"/api/files/copy/browse?path=$MP","match":["\"readable\":true","\"writable\":true","manual\\\\.txt","manual \\\\(1\\\\)\\\\.txt"]}
]
EOF_STEPS
)" "montar el pendrive y copiar en él"
grep -q " $MP " /proc/1/mountinfo || fail "$MP no está montado en el espacio de montaje del sistema"
grep -q " $MP " "/proc/$(systemctl show -p MainPID --value relay-manager)/mountinfo" || fail "el servicio no ve el montaje $MP (propagación)"
RMPID=$(systemctl show -p MainPID --value relay-manager-rootmount.service)
if [ -n "$RMPID" ] && [ "$RMPID" != 0 ]; then
  [ "$(readlink "/proc/$RMPID/ns/mnt")" = "$(readlink /proc/1/ns/mnt)" ] || fail "el ayudante de montaje tiene un espacio de montaje propio"
  ns_note="mismo espacio de montaje que PID 1"
else
  ns_note="ayudante ya parado (sin comprobar su espacio de montaje)"
fi
grep " $MP " /proc/1/mountinfo | grep -q 'nosuid,nodev,noexec' || { grep " $MP " /proc/1/mountinfo; fail "$MP sin nosuid,nodev,noexec"; }
ENG_UID=$(id -u "$ENG")
for f in "$MP/manual.txt" "$MP/manual (1).txt"; do
  [ "$(stat -c '%u %G %a' "$f")" = "$ENG_UID relay-files 664" ] || fail "$f: $(stat -c '%u %G %a' "$f") (se esperaba $ENG_UID relay-files 664)"
  [ "$(sha256sum "$f" | cut -d' ' -f1)" = "$MSHA" ] || fail "$f no coincide con el original"
done
ok "pendrive $LOOP (vfat RMTEST): contraseña mala → 403; montado en $MP (nosuid,nodev,noexec, $ns_note), visible en el sistema y en el servicio; copias como administrador (sin volver a pedir la contraseña) y como el servicio → $ENG:relay-files 664"
api_steps "$(cat <<EOF_STEPS
[
 {"name":"expulsar-sin-permiso","method":"POST","path":"/api/files/copy/unmount","body":{"mountPoint":"/","password":"$SUDOPW"},"status":[400,403]},
 {"name":"expulsar","method":"POST","path":"/api/files/copy/unmount","body":{"mountPoint":"$MP","password":"$SUDOPW"},"match":["\"mountPoint\":\"$MP\"","\"removedDir\":true"]},
 {"name":"otra-vez-desmontado","path":"/api/files/copy/info","match":"\"device\":\"$LOOP\"","noMatch":"\"mountPoint\":\"$MP\""}
]
EOF_STEPS
)" "expulsar el pendrive"
if grep -q " $MP " /proc/1/mountinfo; then fail "$MP sigue montado tras «Expulsar»"; fi
[ ! -e "$MP" ] || fail "«Expulsar» no borra la carpeta vacía $MP"
"$NODE" -e "
  const r = require('module').createRequire('/opt/relay-manager/current/app/server.js');
  const db = new (r('better-sqlite3'))('$DATA/relay-manager.db', { readonly: true });
  const n = (a) => db.prepare('SELECT COUNT(*) AS n FROM AuditEvent WHERE action = ?').get(a).n;
  const m = n('files.copy.mount'), u = n('files.copy.unmount');
  console.log(m + ' ' + u); process.exit(m >= 1 && u >= 1 ? 0 : 1)" >/tmp/audit-mount.txt || { cat /tmp/audit-mount.txt; fail "auditoría files.copy.mount / files.copy.unmount"; }
journalctl --no-pager >/tmp/journal-all.txt 2>&1 || true
if grep -q -- "$SUDOPW" /tmp/journal-all.txt; then fail "la contraseña de sudo está en el registro"; fi
ok "«Expulsar»: desmontado y carpeta borrada; auditoría (montar/expulsar: $(cat /tmp/audit-mount.txt)); la contraseña no está en el registro"
loop_cleanup
trap - EXIT
rm -f /etc/systemd/system/relay-manager-rootmount.service.d/prueba.conf
rmdir /etc/systemd/system/relay-manager-rootmount.service.d 2>/dev/null || true
sed -i '/^RM_COPY_TEST_REMOVABLE=/d' /etc/relay-manager/config.env

# 1e. The download script: the zip lands in RM_EXPORT_ROOT (the second folder when there is one, else tftp); the work
#     folder /var/lib/relay-manager/descargas/<job> is cleaned. The profile's own script only when it works offline
#     (RM_TEST_EXPORT_RUN=1); then always the fake one (same contract), set in config.env (it wins over perfil.env).
EXPORT_ROOT=$(pget RM_EXPORT_ROOT)
[ -n "$EXPORT_ROOT" ] || { [ "$EXTRA_ON" = 1 ] && EXPORT_ROOT=extra || EXPORT_ROOT=tftp; }
if [ "$EXPORT_ROOT" = extra ]; then EXPORT_DIR=$EXTRA; else EXPORT_DIR=$FILES; fi
export_steps() { # APP VERSION WHAT
  local other=""
  if [ "$EXPORT_ROOT" = extra ]; then other=',{"name":"tftp-aparte","path":"/api/files/list?path=","noMatch":"'"$1"'"}'; fi
  api_steps "$(cat <<EOF_STEPS
[
 {"name":"info","path":"/api/files/export","match":"\"available\":true"},
 {"name":"mal-nombre","method":"POST","path":"/api/files/export","body":{"app":"a;rm -rf /","version":"1.0","extract":false,"zipName":null,"dir":""},"status":400},
 {"name":"descargar","method":"POST","path":"/api/files/export","body":{"app":"$1","version":"$2","extract":false,"zipName":null,"dir":""},"status":202,"save":{"e1":"job.id"}},
 {"name":"fin","wait":"export","id":"\${e1}"},
 {"name":"listado","path":"/api/files/list?root=$EXPORT_ROOT&path=","match":["\"root\":\"$EXPORT_ROOT\"","$1-$2_exports\\\\.zip"],"noMatch":"\\\\.descargas"},
 {"name":"descargas-oculta","path":"/api/files/list?root=$EXPORT_ROOT&path=.descargas","status":[400,404]}$other
]
EOF_STEPS
)" "$3"
  expect_mode "$EXPORT_DIR/$1-$2_exports.zip" "664 relay-manager:relay-files"
  [ ! -e "$EXPORT_DIR/.descargas" ] || fail "el script ha trabajado dentro de $EXPORT_DIR"
  [ -z "$(find /var/lib/relay-manager/descargas -mindepth 1 -print -quit 2>/dev/null)" ] || fail "quedan carpetas de trabajo en /var/lib/relay-manager/descargas"
  as_owner "$EXPORT_DIR" sh -c "cat '$EXPORT_DIR/$1-$2_exports.zip' >/dev/null && rm '$EXPORT_DIR/$1-$2_exports.zip'" || fail "el dueño de $EXPORT_DIR no puede leer y borrar el zip descargado"
}
restart_service() {
  systemctl restart relay-manager
  for _ in $(seq 1 30); do relay-manager ping --quiet && break; sleep 1; done
  active || fail "el servicio no arranca: $1"
}
if [ "$(pget RM_EXPORT_ENABLED)" = 1 ] && [ "${RM_TEST_EXPORT_RUN:-0}" = 1 ]; then
  export_steps demo_perfil 1.0.0 "script de descarga del perfil ($(pget RM_EXPORT_DOWNLOADER))"
  ok "script de descarga del perfil: zip 664 relay-manager:relay-files en $EXPORT_DIR, carpeta de trabajo borrada"
fi
install -d -m 0755 /usr/local/lib/rm-prueba
install -m 0755 /dist/test/fake-export-downloader.sh /usr/local/lib/rm-prueba/fake-export-downloader.sh
printf '\nRM_EXPORT_ENABLED=1\nRM_EXPORT_DOWNLOADER=/usr/local/lib/rm-prueba/fake-export-downloader.sh\n' >>/etc/relay-manager/config.env
restart_service "con RM_EXPORT_DOWNLOADER"
export_steps demo_app 1.2.3 "descarga simulada"
"$NODE" -e "
  const r = require('module').createRequire('/opt/relay-manager/current/app/server.js');
  const db = new (r('better-sqlite3'))('$DATA/relay-manager.db', { readonly: true });
  const n = db.prepare(\"SELECT COUNT(*) AS n FROM AuditEvent WHERE action = 'files.export'\").get().n;
  console.log(n); process.exit(n >= 1 ? 0 : 1)" >/tmp/audit-export.txt || fail "auditoría files.export"
ok "descarga simulada en $EXPORT_ROOT: zip 664 relay-manager:relay-files en $EXPORT_DIR, carpeta de trabajo borrada, auditada; el dueño de la carpeta lo lee y lo borra"
sed -i '/^RM_EXPORT_DOWNLOADER=/d; /^RM_EXPORT_ENABLED=/d' /etc/relay-manager/config.env
restart_service "tras quitar las variables de prueba"

# 1f. The profile from the CLI (as root: run as the service user) and install.sh --perfil: a missing folder or one
#     that is not a profile is refused before anything changes; a new copy moves the old one aside (root only); without
#     --perfil the installed one is kept.
relay-manager plantillas comprobar >/tmp/plantillas.txt 2>&1 || { cat /tmp/plantillas.txt; fail "relay-manager plantillas comprobar"; }
relay-manager plantillas recargar >>/tmp/plantillas.txt 2>&1 || { cat /tmp/plantillas.txt; fail "relay-manager plantillas recargar (con el servicio en marcha)"; }
sed 's/^/    /' /tmp/plantillas.txt
ok "plantillas comprobar y recargar salen con 0"
mkdir -p /root/no-es-perfil
for bad in /no/existe /root/no-es-perfil; do
  set +e
  "$P0/install.sh" --yes --perfil "$bad" >"$OUT" 2>&1
  code=$?
  set -e
  [ "$code" != 0 ] || { cat "$OUT"; fail "install.sh --perfil $bad debería rechazarse"; }
  grep -q "Deteniendo el servicio" "$OUT" && fail "install.sh --perfil $bad llegó a detener el servicio"
done
active || fail "el servicio no sigue activo tras rechazar --perfil"
ok "--perfil con una carpeta que no existe o que no es un perfil se rechaza sin tocar nada"
if [ "$HAS_PROFILE" = 1 ]; then
  n_old=$(find /etc/relay-manager -maxdepth 1 -name 'perfil.anterior-*' | wc -l)
  "$P0/install.sh" --yes --perfil "$PROFILE_SRC" >"$OUT" 2>&1 || { cat "$OUT"; fail "install.sh --perfil $PROFILE_SRC"; }
  OLDP=$(find /etc/relay-manager -maxdepth 1 -name 'perfil.anterior-*' | sort | tail -n 1)
  [ "$(find /etc/relay-manager -maxdepth 1 -name 'perfil.anterior-*' | wc -l)" = $((n_old + 1)) ] && [ -n "$OLDP" ] || { cat "$OUT"; fail "--perfil no guarda el perfil anterior"; }
  expect_mode "$OLDP" "700 root:root"
  grep -q "el perfil anterior queda en $OLDP" "$OUT" || { cat "$OUT"; fail "install.sh no dice dónde queda el perfil anterior"; }
  check_profile
  "$P0/install.sh" --yes >"$OUT" 2>&1 || { cat "$OUT"; fail "install.sh sin --perfil"; }
  grep -q "se conserva $PROF" "$OUT" || { cat "$OUT"; fail "install.sh sin --perfil no dice que conserva el perfil"; }
  [ "$(find /etc/relay-manager -maxdepth 1 -name 'perfil.anterior-*' | wc -l)" = $((n_old + 1)) ] || fail "install.sh sin --perfil ha tocado el perfil"
  [ "$EXTRA_ON" = 0 ] || grep -q "^RM_FILES_EXTRA_DIR=$EXTRA\$" /etc/relay-manager/config.env || fail "reinstalar cambió RM_FILES_EXTRA_DIR"
  active || fail "servicio inactivo tras reinstalar con --perfil"
  ok "install.sh --perfil: el anterior queda en $(basename "$OLDP") (700 root:root); sin --perfil se conserva el instalado"
fi

B=$(relay-manager backup)
expect_mode "$B" "640 relay-manager:relay-manager"
ok "backup como root → fichero del usuario del servicio: $(basename "$B")"
set +e
relay-manager restore "$(basename "$B")" --yes >/dev/null 2>&1
code=$?
set -e
[ "$code" = 5 ] || fail "restore con el servicio en marcha salió con $code (se esperaba 5)"
ok "restore con el servicio en marcha → salida 5"
systemctl stop relay-manager
echo 1 >"$DATA/server.pid" # a stale pid file (after a power cut) belongs to the service user
chown relay-manager:relay-manager "$DATA/server.pid"
systemctl start relay-manager
sleep 1
for _ in $(seq 1 30); do relay-manager ping --quiet && break; sleep 1; done
active || fail "un server.pid obsoleto impide arrancar"
ok "un server.pid obsoleto (pid 1) no impide arrancar"
# Read-only commands on a stopped service leave nothing next to the DB (no -wal/-shm owned by whoever ran them).
systemctl stop relay-manager
side_files() { find "$DATA" -maxdepth 1 \( -name '*.db-wal' -o -name '*.db-shm' -o -name '*.db-journal' \) -printf '%f ' ; }
[ -z "$(side_files)" ] || fail "el servicio parado deja $(side_files)(condición previa)"
relay-manager doctor >/tmp/doctor-stopped.txt 2>&1 || true
relay-manager setup-token >/dev/null 2>&1 || true
[ -z "$(side_files)" ] || fail "doctor/setup-token con el servicio parado crean $(side_files)"
grep -q "Base de datos" /tmp/doctor-stopped.txt || { cat /tmp/doctor-stopped.txt; fail "doctor no ha leído la base de datos parada"; }
systemctl start relay-manager
for _ in $(seq 1 30); do relay-manager ping --quiet && break; sleep 1; done
active || fail "el servicio no arranca tras doctor con el servicio parado"
ok "doctor y setup-token con el servicio parado: ningún -wal/-shm junto a la base de datos"

# 1a. Paths with "." or ".." (a trailing "/.." included) are refused before anything changes.
for bad in "$ENG_HOME/.." "$ENG_HOME/tftp/../.." "/var/lib/relay-manager/." "/srv/a b"; do
  set +e
  "$P0/install.sh" --yes --files-dir "$bad" >"$OUT" 2>&1
  code=$?
  set -e
  [ "$code" != 0 ] || { cat "$OUT"; fail "install.sh --files-dir \"$bad\" debería rechazarse"; }
  grep -q "Deteniendo el servicio" "$OUT" && fail "install.sh --files-dir \"$bad\" llegó a detener el servicio"
done
active || fail "el servicio no sigue activo tras rechazar rutas no válidas"
expect_mode /home "755 root:root"
ok "--files-dir con «.», «..» o espacios se rechaza sin tocar nada"

# 1b. Another folder outside /home: --files-dir writes config.env and a ReadWritePaths= drop-in -------------------
"$P0/install.sh" --yes --files-dir /srv/intercambio >"$OUT" 2>&1 || { cat "$OUT"; fail "install.sh --files-dir /srv/intercambio"; }
grep -qx "RM_FILES_DIR=/srv/intercambio" /etc/relay-manager/config.env || fail "--files-dir no cambió RM_FILES_DIR"
grep -qx "ReadWritePaths=/srv/intercambio" /etc/systemd/system/relay-manager.service.d/archivos.conf || fail "falta ReadWritePaths=/srv/intercambio"
grep -qx "BindPaths=$FILES" /etc/systemd/system/relay-manager.service.d/archivos.conf && fail "el drop-in conserva BindPaths de la carpeta anterior"
# A second folder in the engineer's home stays: ProtectHome=tmpfs + its BindPaths= remain next to ReadWritePaths=.
case "$EXTRA_ON:$EXTRA/" in
  1:"$ENG_HOME"/*)
    grep -qx "BindPaths=$EXTRA" "$DROPIN" || fail "el drop-in perdió BindPaths=$EXTRA"
    [ "$(systemctl show -p ProtectHome --value relay-manager)" = tmpfs ] || fail "ProtectHome debería seguir en tmpfs (la segunda carpeta está en /home)"
    ;;
esac
expect_mode /srv/intercambio "2775 relay-manager:relay-files"
smoke http://127.0.0.1:3200 smoke-srv.bin
expect_mode /srv/intercambio/smoke-srv.bin "664 relay-manager:relay-files"
[ "$(sha256sum /srv/intercambio/smoke-srv.bin | cut -d' ' -f1)" = "$SHA" ] || fail "el archivo subido a /srv/intercambio no coincide"
[ -f "$FILES/manual.txt" ] || fail "cambiar de carpeta no debe tocar la anterior"
ok "install.sh --files-dir /srv/intercambio: config.env, drop-in ReadWritePaths y subida correcta"
"$P0/install.sh" --yes --files-dir "$FILES" >"$OUT" 2>&1 || { cat "$OUT"; fail "install.sh --files-dir $FILES"; }
grep -qx "BindPaths=$FILES" /etc/systemd/system/relay-manager.service.d/archivos.conf || fail "no se volvió a la carpeta del ingeniero"
ok "vuelta a $FILES con install.sh --files-dir"

# 2. Same-version reinstall with TLS -------------------------------------------
"$P0/install.sh" --yes --tls-selfsigned >"$OUT" 2>&1 || { cat "$OUT"; fail "reinstalación $V0"; }
grep -n "Deteniendo el servicio" "$OUT" | head -n 1 >/dev/null || fail "la reinstalación no detiene el servicio"
[ "$(grep -n "Deteniendo el servicio" "$OUT" | cut -d: -f1)" -lt "$(grep -n "Copiando la versión" "$OUT" | cut -d: -f1)" ] ||
  fail "la reinstalación copia ficheros antes de detener el servicio"
[ -z "$(find "$DATA/backups" -name '*pre-upgrade*' -print -quit)" ] || fail "una reinstalación de la misma versión no debe crear copia pre-upgrade"
active || fail "servicio inactivo tras reinstalar"
expect_mode /etc/relay-manager/tls/key.pem "640 root:relay-manager"
expect_mode /etc/relay-manager/tls/cert.pem "644 root:root"
relay-manager ping || fail "ping por HTTPS"
relay-manager doctor --json >/tmp/doctor.json || true
grep -A3 '"net.tls"' /tmp/doctor.json >/tmp/tls.txt || true
grep -q '"ok"' /tmp/tls.txt || fail "doctor: net.tls no es ok"
ok "reinstalación de $V0 con --tls-selfsigned: servicio detenido antes de copiar, HTTPS y net.tls correctos"

# «config export» as root with the service running, into root-only folders (absolute and relative path).
install -d -m 0700 /root/exportes
relay-manager config export /root/exportes/config.json 2>/tmp/cfgexp.txt || { cat /tmp/cfgexp.txt; fail "config export como root con el servicio en marcha"; }
(cd /root/exportes && relay-manager config export relativa.json) 2>>/tmp/cfgexp.txt || { cat /tmp/cfgexp.txt; fail "config export con ruta relativa en /root"; }
for f in /root/exportes/config.json /root/exportes/relativa.json; do
  node_ok=$(/opt/relay-manager/current/node/bin/node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(Array.isArray(j.equipment)?"ok":"no")' "$f")
  [ "$node_ok" = ok ] || fail "$f no es una exportación válida"
  expect_mode "$f" "640 root:root"
done
[ -z "$(find /root/exportes -name '.relay-manager-config.*')" ] || fail "config export deja temporales"
rm -rf /root/exportes
ok "config export como root (servicio en marcha) a una carpeta solo de root, con ruta absoluta y relativa: 640 root:root"

# 3. Upgrade without migrations (regenerating TLS), then rollback without restore
# A config.env written for an older version: the keys the profile renames (migraciones-config.txt, «VIEJA NUEVA»)
# are added under their old names (only those whose new name is not set yet, so the rest of the test is unchanged).
MIG_LIST="$PROF/migraciones-config.txt"
MIG_KEYS=() # "OLD NEW VALUE"
if [ -f "$MIG_LIST" ]; then
  n=0
  while read -r old new rest; do
    case "$old" in "" | "#"*) continue ;; esac
    [ -z "$(sed -n "s/^[[:space:]]*$new=//p" /etc/relay-manager/config.env)" ] || continue
    n=$((n + 1))
    case "$new" in
      *_URL) val="http://127.0.0.1:9/migrado-$n" ;;
      *_ENABLED) val=1 ;;
      *_PASSWORD) val="Clave-Migrada-$n" ;;
      *_DIR) continue ;; # a folder: covered by the upgrade-chain test (it would move the second folder here)
      *) val="migrado-$n" ;;
    esac
    printf '%s=%s\n' "$old" "$val" >>/etc/relay-manager/config.env
    MIG_KEYS+=("$old $new $val")
  done <"$MIG_LIST"
fi
cp -a /etc/relay-manager/config.env /tmp/config.before
CERT_BEFORE=$(sha256sum /etc/relay-manager/tls/cert.pem | cut -d' ' -f1)
"$P1/install.sh" --yes --tls-selfsigned >"$OUT" 2>&1 || { cat "$OUT"; fail "actualización a $V1"; }
[ "$(current)" = "$V1" ] || fail "current no apunta a $V1"
PRE=$(find "$DATA/backups" -name "relay-manager-*-pre-upgrade-$V0-to-$V1.db" -print -quit)
[ -n "$PRE" ] || fail "falta la copia pre-upgrade-$V0-to-$V1"
expect_mode "$PRE" "640 relay-manager:relay-manager"
active || fail "servicio inactivo tras actualizar a $V1"
grep -qx "RM_FILES_DIR=$FILES" /etc/relay-manager/config.env || fail "la actualización cambió RM_FILES_DIR"
grep -qx "BindPaths=$FILES" /etc/systemd/system/relay-manager.service.d/archivos.conf || fail "la actualización perdió el drop-in de Archivos"
if [ "$EXTRA_ON" = 1 ]; then
  grep -qx "RM_FILES_EXTRA_DIR=$EXTRA" /etc/relay-manager/config.env || fail "la actualización cambió RM_FILES_EXTRA_DIR"
  case "$EXTRA/" in "$ENG_HOME"/*) grep -qx "BindPaths=$EXTRA" "$DROPIN" || fail "la actualización perdió BindPaths=$EXTRA" ;; esac
fi
if [ "$HAS_PROFILE" = 1 ]; then check_profile; else [ ! -e "$PROF" ] || fail "la actualización ha creado un perfil"; fi
[ ! -e /opt/relay-manager/current/perfil ] || fail "la versión $V1 instalada lleva perfil/"
ok "actualización $V0 → $V1: copia pre-upgrade hecha con la versión copiada, servicio activo, carpetas de Archivos y perfil conservados"
# The configuration is saved before install.sh edits it (config.env and the TLS files it regenerates).
SNAP=$(find /etc/relay-manager/backups -mindepth 1 -maxdepth 1 -type d -name "config-*-pre-upgrade-$V0-to-$V1" -print -quit 2>/dev/null || true)
[ -n "$SNAP" ] || { cat "$OUT"; fail "falta la copia de config.env y tls/ previa a la actualización"; }
expect_mode /etc/relay-manager/backups "700 root:root"
cmp -s "$SNAP/config.env" /tmp/config.before || fail "la copia de config.env no es la de antes de actualizar"
expect_mode "$SNAP/config.env" "640 root:relay-manager"
[ "$(sha256sum "$SNAP/tls/cert.pem" | cut -d' ' -f1)" = "$CERT_BEFORE" ] || fail "la copia de tls/ no tiene el certificado anterior"
expect_mode "$SNAP/tls/key.pem" "640 root:relay-manager"
[ "$(sha256sum /etc/relay-manager/tls/cert.pem | cut -d' ' -f1)" != "$CERT_BEFORE" ] || fail "--tls-selfsigned no regeneró el certificado"
[ "$(grep -n "Copia de seguridad previa" "$OUT" | cut -d: -f1)" -lt "$(grep -n "certificado instalado" "$OUT" | cut -d: -f1)" ] ||
  fail "el certificado se instala antes de la copia de seguridad previa"
relay-manager ping || fail "ping por HTTPS con el certificado nuevo"
ok "copia de configuración $(basename "$SNAP"): config.env y tls/ anteriores; certificado nuevo instalado después"
if [ "${#MIG_KEYS[@]}" -gt 0 ]; then
  for k in "${MIG_KEYS[@]}"; do
    read -r old new val <<<"$k"
    grep -qx "$new=$val" /etc/relay-manager/config.env || { cat "$OUT"; fail "la actualización no renombró $old a $new (migraciones-config.txt)"; }
    if grep -q "^[[:space:]]*$old=" /etc/relay-manager/config.env; then fail "$old sigue en config.env tras la actualización"; fi
    grep -qx "$old=$val" "$SNAP/config.env" || fail "la copia previa de config.env no tiene $old"
    grep -q "$new" "$OUT" || { cat "$OUT"; fail "install.sh no informa de que renombra $old"; }
    case "$new" in *_PASSWORD) if grep -q -- "$val" "$OUT"; then fail "install.sh imprime el valor de $new"; fi ;; esac
  done
  expect_mode /etc/relay-manager/config.env "640 root:relay-manager"
  if journalctl -u relay-manager --since "-2min" --no-pager 2>/dev/null | grep -q "Variable desconocida"; then fail "el servicio avisa de variables desconocidas tras renombrar"; fi
  # Back to the test's configuration (owner and mode kept).
  for k in "${MIG_KEYS[@]}"; do read -r old new val <<<"$k"; sed -i "/^$new=$(printf '%s' "$val" | sed 's/[\/.]/\\&/g')\$/d" /etc/relay-manager/config.env; done
  ok "config.env antiguo: ${#MIG_KEYS[@]} claves renombradas por migraciones-config.txt del perfil, con su valor (copia previa guardada; valores no impresos)"
else
  ok "el perfil no trae migraciones-config.txt: sin claves que renombrar"
fi
relay-manager rollback --yes >"$OUT" 2>&1 || { cat "$OUT"; fail "rollback a $V0"; }
grep -q "se cambia sin restaurar" "$OUT" || { cat "$OUT"; fail "rollback sin migraciones nuevas no debería restaurar"; }
[ "$(current)" = "$V0" ] || fail "current no apunta a $V0 tras rollback"
has_admin || fail "el usuario admin se ha perdido"
ok "rollback $V1 → $V0 sin restaurar (el destino conoce todas las migraciones); datos intactos"

# 4. Upgrade with a new migration, refused downgrade, rollback with restore ----
"$P2/install.sh" --yes >"$OUT" 2>&1 || { cat "$OUT"; fail "actualización a $V2"; }
[ "$(current)" = "$V2" ] || fail "current no apunta a $V2"
[ -n "$(find "$DATA/backups" -name "relay-manager-*-pre-upgrade-$V0-to-$V2.db" -print -quit)" ] || fail "falta la copia pre-upgrade-$V0-to-$V2"
journal_has "Migración aplicada: 20260924000000_upgrade_test" || fail "no se aplicó la migración nueva"
journal_has "hay una copia pre-upgrade reciente" || fail "la copia pre-migrate no se omitió"
ok "actualización $V0 → $V2: copia pre-upgrade y migración aplicada (pre-migrate omitida por la pre-upgrade)"
set +e
"$P1/install.sh" --yes >"$OUT" 2>&1
code=$?
set -e
if [ "$code" != 1 ] || ! grep -q "Versión anterior a la instalada" "$OUT"; then
  cat "$OUT"
  fail "install.sh $V1 sobre $V2 debería rechazarse"
fi
ok "instalar $V1 sobre $V2 se rechaza: $(grep -o 'Versión anterior.*' "$OUT")"
relay-manager rollback --to "$V0" --yes >"$OUT" 2>&1 || { cat "$OUT"; fail "rollback a $V0 con restauración"; }
grep -q "se restaurará relay-manager-.*-pre-upgrade-$V0-to-$V2.db" "$OUT" || { cat "$OUT"; fail "el rollback no restauró la copia pre-upgrade"; }
[ "$(current)" = "$V0" ] || fail "current no apunta a $V0"
active || fail "servicio inactivo tras el rollback"
/opt/relay-manager/current/node/bin/node -e "
  const r = require('module').createRequire('/opt/relay-manager/current/app/server.js');
  const db = new (r('better-sqlite3'))('$DATA/relay-manager.db', { readonly: true });
  const t = db.prepare(\"SELECT name FROM sqlite_master WHERE name = 'RmUpgradeTest'\").get();
  process.exit(t ? 1 : 0)" || fail "la tabla de la migración nueva sigue en la base de datos restaurada"
has_admin || fail "el usuario admin se ha perdido tras restaurar"
ok "rollback $V2 → $V0 restaurando la copia pre-upgrade (-wal/-shm descartados); datos de antes de actualizar"

# Restore from a path (the launcher copies it as root into backups/ as -import.db, owned by the service user).
EXT=/root/externa.db
cp "$(find "$DATA/backups" -name '*-manual.db' -print -quit)" "$EXT"
systemctl stop relay-manager
relay-manager restore "$EXT" --yes >"$OUT" 2>&1 || { cat "$OUT"; fail "restore desde una ruta"; }
grep -q "Copia importada como relay-manager-.*-import.db" "$OUT" || { cat "$OUT"; fail "el lanzador no importó la ruta"; }
IMP=$(find "$DATA/backups" -name '*-import.db' -print -quit)
expect_mode "$IMP" "640 relay-manager:relay-manager"
expect_mode "$DATA/relay-manager.db" "640 relay-manager:relay-manager"
systemctl start relay-manager
for _ in $(seq 1 30); do relay-manager ping --quiet && break; sleep 1; done
active || fail "el servicio no arranca tras restaurar desde una ruta"
ok "restore desde una ruta (como root): copia importada $(basename "$IMP") del usuario del servicio; servicio activo"

# 5. Uninstall ------------------------------------------------------------------
# What the service would have left of "Red de equipos" (links rmv<n>, rules and tables 20000-24094), next to foreign
# objects that uninstall.sh must not touch.
ip link add rmv102 type veth peer name xpeer102 || fail "no se puede crear una interfaz de prueba rmv102"
ip link add xkeep0 type veth peer name xkeep1
ip addr add 192.168.1.202/24 dev rmv102 noprefixroute
ip link set rmv102 up
ip rule add from 192.168.1.202/32 lookup 20102 pref 20102
ip route replace 192.168.1.0/24 dev rmv102 table 20102
ip rule add from 10.9.9.9/32 lookup 52 pref 20050
ip rule add from 10.9.9.8/32 lookup 20103 pref 30000
"$P0/uninstall.sh" >"$OUT" 2>&1 || { cat "$OUT"; fail "uninstall.sh"; }
ip -o link show >/tmp/links.txt
ip -4 rule show >/tmp/rules.txt
grep -q ' rmv102[@:]' /tmp/links.txt && fail "uninstall.sh deja la interfaz rmv102"
grep -q 'lookup 20102' /tmp/rules.txt && fail "uninstall.sh deja la regla de la tabla 20102"
[ -z "$(ip -4 route show table 20102 2>/dev/null)" ] || fail "uninstall.sh deja rutas en la tabla 20102"
grep -q ' xkeep0[@:]' /tmp/links.txt || fail "uninstall.sh ha borrado una interfaz ajena"
grep -q '^20050:.*lookup 52' /tmp/rules.txt || fail "uninstall.sh ha borrado una regla ajena (tabla 52)"
grep -q '^30000:.*lookup 20103' /tmp/rules.txt || fail "uninstall.sh ha borrado una regla ajena (preferencia 30000)"
[ ! -e /etc/NetworkManager/conf.d/90-relay-manager-red-equipos.conf ] || fail "uninstall.sh deja el drop-in de NetworkManager"
ip link del xkeep0
ip rule del pref 20050
ip rule del pref 30000
ok "uninstall.sh quita solo lo de la red de equipos (rmv*, reglas y tablas 20000-24094) y el drop-in de NetworkManager"
[ ! -e /opt/relay-manager ] && [ ! -e /etc/systemd/system/relay-manager.service ] && [ ! -e /usr/local/bin/relay-manager ] || fail "uninstall.sh deja ficheros del programa"
[ -f "$DATA/relay-manager.db" ] && [ -f /etc/relay-manager/config.env ] || fail "uninstall.sh sin --purge ha borrado datos"
[ ! -e /etc/systemd/system/relay-manager.service.d/archivos.conf ] || fail "uninstall.sh deja el drop-in de Archivos"
[ ! -e /etc/systemd/system/relay-manager-rootcopy.socket ] && [ ! -e /etc/systemd/system/relay-manager-rootcopy.service ] && [ ! -e /etc/relay-manager/rootcopy.env ] ||
  fail "uninstall.sh deja el ayudante de copia como administrador"
[ ! -e /run/relay-manager-rootcopy/rootcopy.sock ] && [ ! -e /var/lib/relay-manager-rootcopy ] || fail "uninstall.sh deja el socket o el estado del ayudante"
[ ! -e /etc/systemd/system/relay-manager-rootmount.socket ] && [ ! -e /etc/systemd/system/relay-manager-rootmount.service ] &&
  [ ! -e /run/relay-manager-rootmount/rootmount.sock ] && [ ! -e /var/lib/relay-manager-rootmount ] || fail "uninstall.sh deja el ayudante de montaje"
[ "$EXTRA_ON" = 0 ] || [ -f "$EXTRA/leeme.txt" ] || fail "uninstall.sh ha borrado la segunda carpeta"
if [ "$HAS_PROFILE" = 1 ]; then
  [ -d "$PROF" ] || fail "uninstall.sh sin --purge ha borrado el perfil"
  grep -q "Se conserva también el perfil del proyecto: $PROF" "$OUT" || { cat "$OUT"; fail "uninstall.sh no dice que conserva el perfil"; }
fi
[ -f /mnt/usb-root/manual.txt ] || fail "uninstall.sh ha borrado archivos copiados"
[ -f "$FILES/manual.txt" ] || fail "uninstall.sh ha borrado la carpeta de Archivos"
ok "uninstall.sh conserva los datos: $(tail -n 2 "$OUT" | head -n 1)"
"$P0/uninstall.sh" --purge --yes >"$OUT" 2>&1 || { cat "$OUT"; fail "uninstall.sh --purge"; }
[ ! -e "$DATA" ] && [ ! -e /etc/relay-manager ] || fail "--purge no borra datos y configuración"
id relay-manager >/dev/null 2>&1 && fail "--purge no borra el usuario"
[ -f "$FILES/manual.txt" ] || fail "--purge no debe borrar la carpeta de Archivos del ingeniero"
case "$EXTRA_ON:$EXTRA/" in
  1:"$ENG_HOME"/*)
    [ -f "$EXTRA/leeme.txt" ] || fail "--purge no debe borrar la segunda carpeta del ingeniero"
    grep -q "La segunda carpeta de Archivos $EXTRA se conserva" "$OUT" || { cat "$OUT"; fail "--purge no avisa de que se conserva la segunda carpeta"; }
    ;;
esac
getent group relay-files >/dev/null && fail "--purge no borra el grupo relay-files"
grep -q "La carpeta de Archivos $FILES se conserva" "$OUT" || { cat "$OUT"; fail "--purge no avisa de que se conserva la carpeta de Archivos"; }
ok "uninstall.sh --purge borra datos, configuración y usuario"
echo "== Instalación nativa superada"
