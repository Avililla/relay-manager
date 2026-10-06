#!/usr/bin/env bash
# Instalador y actualizador sin conexión de Relay Manager (§9.6).
#   sudo ./install.sh [--perfil DIR] [--port N] [--files-dir RUTA] [--extra-dir RUTA] [--red-equipos-mac MAC]
#                     [--red-equipos-arp-estricto] [--sudo-user USUARIO] [--no-start] [--tls-selfsigned] [--yes]
# Estructura: /opt/relay-manager/releases/<versión> + current -> releases/<versión>
#             /etc/relay-manager/config.env    /etc/relay-manager/perfil (plantillas y valores del proyecto)
#             /var/lib/relay-manager (datos del servicio)
set -euo pipefail

PREFIX=/opt/relay-manager
RELEASES="$PREFIX/releases"
CONF_DIR=/etc/relay-manager
CONF="$CONF_DIR/config.env"
# The project profile («perfil»): perfil.env, plantillas/, herramientas/ (the app reads it; RM_PROFILE_DIR overrides).
PROFILE_DIR="$CONF_DIR/perfil"
TLS_DIR="$CONF_DIR/tls"
DATA_DIR=/var/lib/relay-manager
SVC_USER=relay-manager
# "Archivos": the folder's group. Its own group, so the engineer who owns the folder shares it with the service
# without getting the relay-manager group (which reads the database, the backups and config.env).
FILES_GROUP=relay-files
UNIT=/etc/systemd/system/relay-manager.service
RULE=/etc/udev/rules.d/99-relay-manager.rules
LINK=/usr/local/bin/relay-manager
DROPIN_DIR=/etc/systemd/system/relay-manager.service.d
DROPIN="$DROPIN_DIR/archivos.conf"
NM_DROPIN=/etc/NetworkManager/conf.d/90-relay-manager-red-equipos.conf
SYSCTL_DROPIN=/etc/sysctl.d/60-relay-manager.conf
# «Copiar como administrador (sudo)»: the root helper (socket-activated), its own configuration (root-owned: the service
# cannot change who authenticates nor where root writes) and the drop-in with the extra RM_COPY_ROOT_PATHS.
RC_SOCKET=/etc/systemd/system/relay-manager-rootcopy.socket
RC_UNIT=/etc/systemd/system/relay-manager-rootcopy.service
RC_DROPIN_DIR=/etc/systemd/system/relay-manager-rootcopy.service.d
RC_DROPIN="$RC_DROPIN_DIR/rutas.conf"
RC_CONF="$CONF_DIR/rootcopy.env"
# «Montar / Expulsar» pendrives: the mount helper (socket-activated, root:root 0600: only the copy helper reaches it, after
# checking the sudo password or token). It has NO private mount namespace, so its mounts reach the host and the service.
RM_SOCKET=/etc/systemd/system/relay-manager-rootmount.socket
RM_UNIT=/etc/systemd/system/relay-manager-rootmount.service

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mAviso:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2
  exit 1
}
usage() {
  cat <<'EOF'
Uso: sudo ./install.sh [--perfil DIR] [--port N] [--files-dir RUTA] [--extra-dir RUTA] [--red-equipos-mac MAC]
                       [--red-equipos-arp-estricto] [--sudo-user USUARIO] [--no-start] [--tls-selfsigned] [--yes]

  --perfil DIR       perfil del proyecto (perfil.env, plantillas/, herramientas/): se copia en
                     /etc/relay-manager/perfil y el anterior se guarda como perfil.anterior-<fecha>. Sin esta
                     opción se conserva el instalado; si no hay ninguno y el paquete trae perfil/, se instala ese
  --port N           puerto HTTP(S) (1024 a 65535; se guarda en /etc/relay-manager/config.env)
  --files-dir RUTA   carpeta de «Archivos» (intercambio de ficheros con los PC). Por defecto, la carpeta tftp
                     del usuario que ejecuta sudo (/home/<usuario>/tftp) o /var/lib/relay-manager/tftp
  --extra-dir RUTA   segunda carpeta de «Archivos» (solo si el perfil o config.env le dan nombre con
                     RM_FILES_EXTRA_NAME). Por defecto, RM_FILES_EXTRA_DIR del perfil (~ = el usuario que ejecuta
                     sudo) o /var/lib/relay-manager/<nombre>
  --red-equipos-mac MAC
                     MAC del adaptador USB-Ethernet conectado al switch de los equipos: NetworkManager lo deja en
                     paz (igual que «sudo relay-manager red-equipos <MAC>»; las interfaces rmv* siempre)
  --red-equipos-arp-estricto
                     cuando otra tarjeta del servidor está en la misma red que los equipos (p. ej. 192.168.1.x):
                     el servidor solo contesta ARP por la interfaz que tiene cada dirección (arp_ignore=1,
                     arp_announce=2 en /etc/sysctl.d/60-relay-manager.conf; se aplica al momento)
  --sudo-user USUARIO
                     usuario con sudo cuya contraseña autoriza «Copiar como administrador (sudo)» en Archivos.
                     Por defecto, quien ejecuta sudo ./install.sh (se guarda como RM_SUDO_USER)
  --no-start         instala sin arrancar el servicio
  --tls-selfsigned   genera un certificado autofirmado y activa HTTPS
  --yes              no pide confirmación al actualizar
EOF
}

ORIG_ARGS=("$@")
PORT=""
FILES_DIR_ARG=""
EXTRA_DIR_ARG=""
PROFILE_ARG=""
NET_MAC=""
ARP_STRICT=0
SUDO_ACCOUNT_ARG=""
START=1
TLS=0
YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      PORT=$2
      shift 2
      ;;
    --port=*)
      PORT=${1#--port=}
      shift
      ;;
    --files-dir)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      FILES_DIR_ARG=$2
      shift 2
      ;;
    --files-dir=*)
      FILES_DIR_ARG=${1#--files-dir=}
      shift
      ;;
    --extra-dir)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      EXTRA_DIR_ARG=$2
      shift 2
      ;;
    --extra-dir=*)
      EXTRA_DIR_ARG=${1#--extra-dir=}
      shift
      ;;
    --perfil)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      PROFILE_ARG=$2
      shift 2
      ;;
    --perfil=*)
      PROFILE_ARG=${1#--perfil=}
      shift
      ;;
    --red-equipos-mac)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      NET_MAC=$2
      shift 2
      ;;
    --red-equipos-mac=*)
      NET_MAC=${1#--red-equipos-mac=}
      shift
      ;;
    --red-equipos-arp-estricto) ARP_STRICT=1; shift ;;
    --sudo-user)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      SUDO_ACCOUNT_ARG=$2
      shift 2
      ;;
    --sudo-user=*)
      SUDO_ACCOUNT_ARG=${1#--sudo-user=}
      shift
      ;;
    --no-start) START=0; shift ;;
    --tls-selfsigned) TLS=1; shift ;;
    --yes) YES=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *)
      echo "Opción desconocida: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done
if [ -n "$NET_MAC" ]; then
  NET_MAC="${NET_MAC,,}"
  [[ "$NET_MAC" =~ ^[0-9a-f]{2}(:[0-9a-f]{2}){5}$ ]] || die "--red-equipos-mac: MAC no válida (usa el formato aa:bb:cc:dd:ee:ff)"
fi
valid_user() { [[ "$1" =~ ^[a-z_][a-z0-9_.-]{0,31}$ ]]; }
if [ -n "$SUDO_ACCOUNT_ARG" ]; then
  valid_user "$SUDO_ACCOUNT_ARG" || die "--sudo-user: nombre de usuario no válido"
fi
if [ -n "$PORT" ]; then
  [[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] ||
    die "--port debe estar entre 1024 y 65535 (para un puerto menor usa un drop-in con CAP_NET_BIND_SERVICE, ver INSTALACION.md)"
fi

# A folder path from --files-dir or config.env: absolute, a safe alphabet (it goes into a systemd drop-in), and no
# "." or ".." segment anywhere (a trailing "/.." included): it is canonicalised later with realpath.
valid_files_dir() {
  [[ "$1" =~ ^/[A-Za-z0-9._@+/-]+$ ]] || return 1
  case "$1/" in */./* | */../* | *//*) return 1 ;; esac
  return 0
}
if [ -n "$FILES_DIR_ARG" ]; then
  FILES_DIR_ARG="${FILES_DIR_ARG%/}"
  valid_files_dir "$FILES_DIR_ARG" ||
    die "--files-dir debe ser una ruta absoluta con letras, números y . _ @ + - / (sin espacios, sin «.» ni «..»)"
fi
if [ -n "$EXTRA_DIR_ARG" ]; then
  EXTRA_DIR_ARG="${EXTRA_DIR_ARG%/}"
  valid_files_dir "$EXTRA_DIR_ARG" ||
    die "--extra-dir debe ser una ruta absoluta con letras, números y . _ @ + - / (sin espacios, sin «.» ni «..»)"
fi
# --perfil: an existing folder that looks like a profile (perfil.env and/or plantillas/). Checked before sudo, so a
# typo fails at once (sudo keeps the working directory, so a relative path works the same after it).
if [ -n "$PROFILE_ARG" ]; then
  [ -d "$PROFILE_ARG" ] || die "--perfil $PROFILE_ARG: no existe esa carpeta"
  PROFILE_ARG="$(cd "$PROFILE_ARG" && pwd -P)"
  [ -f "$PROFILE_ARG/perfil.env" ] || [ -d "$PROFILE_ARG/plantillas" ] ||
    die "--perfil $PROFILE_ARG no parece un perfil: le faltan perfil.env y la carpeta plantillas/"
  [ "$PROFILE_ARG" != "$PROFILE_DIR" ] || die "--perfil: $PROFILE_DIR ya es el perfil instalado (indica la carpeta de la que copiarlo)"
fi

[ "$(id -u)" = 0 ] || exec sudo -- "$0" "${ORIG_ARGS[@]}"

SRC="$(cd "$(dirname "$0")" && pwd -P)"
[ -f "$SRC/VERSION" ] || die "Ejecuta install.sh desde la carpeta del paquete extraído"
VERSION="$(cat "$SRC/VERSION")"
TMP="$RELEASES/$VERSION.tmp"

# ---------------------------------------------------------------------------
say "Comprobaciones previas (Relay Manager $VERSION)"
(cd "$SRC" && sha256sum --quiet -c SHA256SUMS) || die "El paquete está incompleto o dañado (SHA256SUMS no coincide): vuelve a copiarlo"
[ -L "$SRC/app/node_modules/next" ] || die "Extrae el .tar.gz en un disco Linux (ext4), no en FAT/exFAT"
[ "$(uname -m)" = x86_64 ] || die "Este paquete es para Linux x86_64 (este equipo es $(uname -m))"
GLIBC="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')"
[ -n "$GLIBC" ] && [ "$(printf '%s\n2.29\n' "$GLIBC" | sort -V | head -n 1)" = 2.29 ] ||
  die "Se necesita glibc 2.29 o superior (este sistema tiene ${GLIBC:-desconocida})"
if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
  die "Este sistema no arranca con systemd: usa Docker o el modo portátil (./bin/relay-manager)"
fi
if [ "$TLS" = 1 ]; then command -v openssl >/dev/null 2>&1 || die "--tls-selfsigned necesita openssl"; fi
"$SRC/node/bin/node" -e "require('module').createRequire('$SRC/app/server.js')('better-sqlite3')" ||
  die "El node incluido no carga los módulos nativos en este sistema"
if ! command -v python3 >/dev/null 2>&1 && ! command -v perl >/dev/null 2>&1; then
  warn "No hay python3 ni perl: «Copiar como administrador (sudo)» no podrá comprobar contraseñas (sudo apt install python3)"
fi

CUR=""
if [ -L "$PREFIX/current" ] && [ -d "$(readlink -f "$PREFIX/current")" ]; then
  CUR="$(basename "$(readlink -f "$PREFIX/current")")"
fi
if [ -n "$CUR" ] && [ "$CUR" != "$VERSION" ] && [ "$(printf '%s\n%s\n' "$VERSION" "$CUR" | sort -V | head -n 1)" = "$VERSION" ]; then
  die "Versión anterior a la instalada ($CUR): usa sudo relay-manager rollback --to $VERSION"
fi
if [ -n "$CUR" ] && [ "$YES" = 0 ] && [ -t 0 ]; then
  if [ "$CUR" = "$VERSION" ]; then msg="Se reinstalará Relay Manager $VERSION"; else msg="Se actualizará Relay Manager de $CUR a $VERSION (con copia de seguridad previa)"; fi
  read -r -p "$msg. ¿Continuar? [s/N] " answer || answer=""
  case "$answer" in s | S | si | Si | SI | sí | Sí | SÍ) ;; *) die "Cancelado: no se ha cambiado nada" ;; esac
fi

# ---------------------------------------------------------------------------
say "Usuario y directorios"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
  echo "    usuario $SVC_USER creado"
fi
usermod -aG dialout "$SVC_USER"
# Only the top directory: the server creates backups/ and consoles/ itself, owned by the service user (§2.5).
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$DATA_DIR"
install -d -m 0755 "$CONF_DIR" "$PREFIX" "$RELEASES"

set_conf() { # KEY VALUE: replaces the active KEY= line, else uncomments the first "#KEY=", else appends.
  local key=$1 val=$2
  if grep -qE "^[[:space:]]*$key=" "$CONF"; then
    sed -i -E "s|^[[:space:]]*$key=.*|$key=$val|" "$CONF"
  elif grep -qE "^#[[:space:]]*$key=" "$CONF"; then
    sed -i -E "0,/^#[[:space:]]*$key=.*/s||$key=$val|" "$CONF"
  else
    printf '%s=%s\n' "$key" "$val" >>"$CONF"
  fi
}
NEW_CONF=0
if [ ! -f "$CONF" ]; then
  install -m 0640 -o root -g "$SVC_USER" "$SRC/config.env.example" "$CONF"
  NEW_CONF=1
  echo "    creado $CONF (todo comentado: valores por defecto)"
fi

# "Archivos": the folder shared with the engineers' PCs. An explicit --files-dir wins; an upgrade keeps the configured
# one; a first install uses the tftp folder in the home of the admin who ran sudo (SUDO_USER), or the data dir.
conf_active() { sed -n "s/^[[:space:]]*$1=//p" "${CONF_MIG:-$CONF}" | tail -n 1 | tr -d "\"'"; }
CONF_MIG="" # config.env with the profile's renamed keys (see migraciones-config.txt below), until step 4c writes it
FILES_BEFORE="$(conf_active RM_FILES_DIR)"
FILES_OWNER=""
SUDO_HOME=""
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
  SUDO_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6 || true)"
  if [ -z "$SUDO_HOME" ] || [ "$SUDO_HOME" = / ] || [ ! -d "$SUDO_HOME" ] || ! [[ "$SUDO_HOME" =~ ^/[A-Za-z0-9._@+/-]+$ ]]; then SUDO_HOME=""; fi
fi
if [ -n "$FILES_DIR_ARG" ]; then
  FILES_DIR="$FILES_DIR_ARG"
elif [ -n "$FILES_BEFORE" ]; then
  FILES_DIR="${FILES_BEFORE%/}"
elif [ -n "$SUDO_HOME" ]; then
  FILES_DIR="$SUDO_HOME/tftp"
else
  FILES_DIR="$DATA_DIR/tftp"
fi
valid_files_dir "$FILES_DIR" || die "RM_FILES_DIR=$FILES_DIR: usa una ruta absoluta sin espacios ni «.»/«..» (o --files-dir <ruta>)"
# Canonical path (symlinks of the existing part resolved): what the checks, config.env and the drop-in use.
FILES_DIR="$(realpath -m -- "$FILES_DIR")"
valid_files_dir "$FILES_DIR" || die "La carpeta de archivos $FILES_DIR (ruta real) tiene caracteres no admitidos"
case "$FILES_DIR" in
  / | /home | /root | /etc | /etc/* | /usr | /usr/* | /var | /var/lib | /tmp | /opt | /srv | /run | /proc | /proc/* | /sys | /sys/* | /dev | /dev/* | \
    "$DATA_DIR" | "$DATA_DIR/backups" | "$DATA_DIR/backups/"* | "$DATA_DIR/consoles" | "$DATA_DIR/consoles/"* | "$PREFIX" | "$PREFIX/"*)
    die "Carpeta de archivos no válida: $FILES_DIR (usa una carpeta propia, p. ej. /home/<usuario>/tftp)"
    ;;
esac
case "$DATA_DIR/" in "$FILES_DIR"/*) die "La carpeta de archivos $FILES_DIR contiene los datos del servicio: elige otra" ;; esac
# Its owner: the one of an existing folder; else the user whose home holds it (who ran sudo, or /home/<usuario>/…).
# Everything done inside a folder a user owns is done AS that user: root never follows a link they could plant.
dir_owner() { # DIR → the user that acts inside it ("" = root acts)
  local d=$1 o="" h_user
  if [ -d "$d" ]; then
    o="$(stat -c %U -- "$d")"
    # root-owned: root acts (only root writes there); owned by the service user: it acts as itself.
    case "$o" in root | UNKNOWN) o="" ;; esac
  elif [ -n "$SUDO_HOME" ] && [ "${d#"$SUDO_HOME"/}" != "$d" ]; then
    o="$SUDO_USER"
  else
    case "$d" in
      /home/*/*)
        h_user="$(echo "$d" | cut -d/ -f3)"
        if id "$h_user" >/dev/null 2>&1; then o="$h_user"; fi
        ;;
    esac
  fi
  printf '%s' "$o"
}
FILES_OWNER="$(dir_owner "$FILES_DIR")"

# The project profile this run leaves in place: --perfil, else the installed one, else (first install) the bundle's
# perfil/. RM_PROFILE_DIR in config.env (another folder) is what the service reads instead: its values count then.
PROFILE_SRC="" # what step 4d copies into $PROFILE_DIR ("" = nothing)
if [ -n "$PROFILE_ARG" ]; then
  PROFILE_SRC="$PROFILE_ARG"
elif [ ! -e "$PROFILE_DIR" ] && [ -d "$SRC/perfil" ]; then
  PROFILE_SRC="$SRC/perfil"
fi
PROFILE_CONF="$(conf_active RM_PROFILE_DIR)"
PROFILE_CONF="${PROFILE_CONF%/}"
if [ -n "$PROFILE_CONF" ] && [ "$PROFILE_CONF" != "$PROFILE_DIR" ]; then
  PROFILE_READ="$PROFILE_CONF"
  [ -z "$PROFILE_SRC" ] || warn "config.env tiene RM_PROFILE_DIR=$PROFILE_CONF: el servicio leerá ese perfil, no el que se copia en $PROFILE_DIR"
elif [ -n "$PROFILE_SRC" ]; then
  PROFILE_READ="$PROFILE_SRC"
else
  PROFILE_READ="$PROFILE_DIR"
fi
# Renamed keys of config.env: the profile may list them in migraciones-config.txt («CLAVE_VIEJA CLAVE_NUEVA» per line,
# RM_* names only, # comments), so a config.env written for an older version keeps working after an upgrade. Computed
# here into a temporary file that conf_active reads from now on (so the folders below see the renamed keys); config.env
# itself changes in step 4c, after the copy of 4b. Only keys change, never values, which are not printed.
MIG_LIST="$PROFILE_READ/migraciones-config.txt"
if [ "$NEW_CONF" = 0 ] && [ -f "$MIG_LIST" ]; then
  mig_sed=""
  while read -r old new rest; do
    case "$old" in "" | "#"*) continue ;; esac
    if [[ ! "$old" =~ ^RM_[A-Z0-9_]+$ ]] || [[ ! "$new" =~ ^RM_[A-Z0-9_]+$ ]] || [ -n "$rest" ]; then
      warn "$MIG_LIST: línea no válida («$old $new $rest»): se ignora (usa «CLAVE_VIEJA CLAVE_NUEVA»)"
      continue
    fi
    mig_sed+="s/^\([[:space:]]*\(export[[:space:]]\+\)\?\)$old=/\1$new=/;"
  done <"$MIG_LIST"
  if [ -n "$mig_sed" ]; then
    CONF_MIG="$(mktemp)" # 0600 root (config.env may hold a password); removed on exit (trap, replaced further down)
    trap '[ -z "$CONF_MIG" ] || rm -f "$CONF_MIG"' EXIT
    if ! sed -e "$mig_sed" "$CONF" >"$CONF_MIG"; then
      warn "No se pudieron aplicar las migraciones de $MIG_LIST a $CONF: se deja como está"
      rm -f "$CONF_MIG"
      CONF_MIG=""
    elif cmp -s "$CONF" "$CONF_MIG"; then
      rm -f "$CONF_MIG"
      CONF_MIG=""
    fi
  fi
fi

profile_get() { # KEY → its value in the profile's perfil.env (dotenv, parsed like the app does); "" when unset
  [ -f "$PROFILE_READ/perfil.env" ] || return 0
  "$SRC/node/bin/node" -e '
    const v = require("util").parseEnv(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]
    if (v !== undefined) process.stdout.write(v)' "$PROFILE_READ/perfil.env" "$1" 2>/dev/null || true
}
conf_or_profile() { # KEY → config.env wins over the profile (as in the app)
  local v
  v="$(conf_active "$1")"
  [ -n "$v" ] || v="$(profile_get "$1")"
  printf '%s' "$v"
}

# "Archivos": the second shared folder (root "extra"), only when it has a name (RM_FILES_EXTRA_NAME, usually from the
# profile) and is not turned off. Same rules as the tftp folder: --extra-dir wins, an upgrade keeps the configured one,
# else RM_FILES_EXTRA_DIR of the profile («~» = the home of whoever ran sudo, else of the tftp folder's owner, else the
# data dir), else <datos>/<nombre>. The result goes into config.env, so the service and this script agree.
EXTRA_NAME="$(conf_or_profile RM_FILES_EXTRA_NAME)"
EXTRA_ON=0
if [ -n "$EXTRA_NAME" ]; then
  case "$(conf_or_profile RM_FILES_EXTRA_ENABLED)" in 0 | false) ;; *) EXTRA_ON=1 ;; esac
fi
EXTRA_BEFORE="$(conf_active RM_FILES_EXTRA_DIR)"
EXTRA_BEFORE="${EXTRA_BEFORE%/}"
EXTRA_DIR=""
EXTRA_OWNER=""
if [ "$EXTRA_ON" = 1 ]; then
  if [ -n "$EXTRA_DIR_ARG" ]; then
    EXTRA_DIR="$EXTRA_DIR_ARG"
  elif [ -n "$EXTRA_BEFORE" ]; then
    EXTRA_DIR="$EXTRA_BEFORE"
  else
    EXTRA_DIR="$(profile_get RM_FILES_EXTRA_DIR)"
    case "$EXTRA_DIR" in
      "~" | "~/"*)
        rest="${EXTRA_DIR#\~}"
        if [ -n "$SUDO_HOME" ]; then
          EXTRA_DIR="$SUDO_HOME$rest"
        else
          case "$FILES_DIR" in
            /home/*/*) EXTRA_DIR="/home/$(echo "$FILES_DIR" | cut -d/ -f3)$rest" ;;
            *) EXTRA_DIR="$DATA_DIR/$(basename "${rest:-/$EXTRA_NAME}")" ;;
          esac
        fi
        ;;
      "") EXTRA_DIR="$DATA_DIR/$EXTRA_NAME" ;;
    esac
    EXTRA_DIR="${EXTRA_DIR%/}"
  fi
  valid_files_dir "$EXTRA_DIR" || die "RM_FILES_EXTRA_DIR=$EXTRA_DIR (segunda carpeta, «$EXTRA_NAME»): usa una ruta absoluta sin espacios ni «.»/«..» (o --extra-dir <ruta>)"
  EXTRA_DIR="$(realpath -m -- "$EXTRA_DIR")"
  valid_files_dir "$EXTRA_DIR" || die "La segunda carpeta $EXTRA_DIR (ruta real) tiene caracteres no admitidos"
  case "$EXTRA_DIR" in
    / | /home | /root | /etc | /etc/* | /usr | /usr/* | /var | /var/lib | /tmp | /opt | /srv | /run | /proc | /proc/* | /sys | /sys/* | /dev | /dev/* | \
      "$DATA_DIR" | "$DATA_DIR/backups" | "$DATA_DIR/backups/"* | "$DATA_DIR/consoles" | "$DATA_DIR/consoles/"* | "$PREFIX" | "$PREFIX/"*)
      die "Segunda carpeta no válida: $EXTRA_DIR (usa una carpeta propia, p. ej. /home/<usuario>/compartida)"
      ;;
  esac
  case "$DATA_DIR/" in "$EXTRA_DIR"/*) die "La segunda carpeta $EXTRA_DIR contiene los datos del servicio: elige otra" ;; esac
  case "$EXTRA_DIR/" in "$FILES_DIR"/*) die "La segunda carpeta $EXTRA_DIR no puede ser la de archivos ($FILES_DIR) ni estar dentro de ella" ;; esac
  case "$FILES_DIR/" in "$EXTRA_DIR"/*) die "La carpeta de archivos $FILES_DIR no puede estar dentro de la segunda carpeta $EXTRA_DIR" ;; esac
  EXTRA_OWNER="$(dir_owner "$EXTRA_DIR")"
elif [ -n "$EXTRA_DIR_ARG" ]; then
  die "--extra-dir: no hay segunda carpeta (RM_FILES_EXTRA_NAME no está en el perfil ni en config.env, o RM_FILES_EXTRA_ENABLED=0)"
fi

# «Copiar como administrador (sudo)»: whose password authorises a copy as root. An explicit --sudo-user wins; an upgrade
# keeps the configured one; a first install uses the admin who ran sudo (the owner of ~/tftp), else root.
SUDO_BEFORE="$(conf_active RM_SUDO_USER)"
COPY_GROUPS="$(conf_active RM_COPY_SUDO_GROUPS)"
COPY_GROUPS="${COPY_GROUPS:-sudo,wheel,admin}"
if [ -n "$SUDO_ACCOUNT_ARG" ]; then
  SUDO_ACCOUNT="$SUDO_ACCOUNT_ARG"
  id "$SUDO_ACCOUNT" >/dev/null 2>&1 || die "--sudo-user: el usuario $SUDO_ACCOUNT no existe en este equipo"
elif [ -n "$SUDO_BEFORE" ]; then
  SUDO_ACCOUNT="$SUDO_BEFORE"
elif [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] && valid_user "$SUDO_USER"; then
  SUDO_ACCOUNT="$SUDO_USER"
else
  SUDO_ACCOUNT=root
fi
valid_user "$SUDO_ACCOUNT" || die "RM_SUDO_USER=$SUDO_ACCOUNT no es un nombre de usuario válido (usa --sudo-user)"
[[ "$COPY_GROUPS" =~ ^[a-z_][a-z0-9_.-]*(,[a-z_][a-z0-9_.-]*)*$ ]] || die "RM_COPY_SUDO_GROUPS=$COPY_GROUPS: usa nombres de grupo separados por comas"
sudo_capable() { # USER: root, or a member of one of RM_COPY_SUDO_GROUPS
  [ "$(id -u "$1" 2>/dev/null)" = 0 ] && return 0
  local g
  for g in $(id -nG "$1" 2>/dev/null); do
    case ",$COPY_GROUPS," in *",$g,"*) return 0 ;; esac
  done
  return 1
}
SUDO_PROBLEM=""
if ! id "$SUDO_ACCOUNT" >/dev/null 2>&1; then
  SUDO_PROBLEM="el usuario $SUDO_ACCOUNT no existe"
elif ! sudo_capable "$SUDO_ACCOUNT"; then
  SUDO_PROBLEM="$SUDO_ACCOUNT no está en ninguno de los grupos $COPY_GROUPS"
elif [ "$SUDO_ACCOUNT" = root ]; then
  case "$(getent shadow root 2>/dev/null | cut -d: -f2)" in
    "" | "!"* | "*"*) SUDO_PROBLEM="la cuenta root no tiene contraseña (lo normal con sudo): usa --sudo-user <usuario con sudo>" ;;
  esac
fi
# Where root may write, and the lists for the helper: they go into a systemd drop-in, so a safe alphabet; checked now,
# before anything is stopped or copied.
path_list_ok() { [[ "$1" =~ ^/[A-Za-z0-9._@+/-]*(,/[A-Za-z0-9._@+/-]*)*$ ]] && case ",$1,/" in *"/./"* | *"/../"* | *"/.,"* | *"/..,"* | *"//"*) false ;; *) true ;; esac; }
ROOT_PATHS="$(conf_active RM_COPY_ROOT_PATHS | tr -d ' ')"
ROOT_PATHS="${ROOT_PATHS:-/media,/run/media,/mnt}"
COPY_ROOTS="$(conf_active RM_COPY_ROOTS | tr -d ' ')"
COPY_DENY="$(conf_active RM_COPY_DENY | tr -d ' ')"
path_list_ok "$ROOT_PATHS" || die "RM_COPY_ROOT_PATHS=$ROOT_PATHS: usa rutas absolutas separadas por comas (letras, números y . _ @ + - /)"
case ",$ROOT_PATHS," in
*",/,"* | *",/etc,"* | *",/etc/"* | *",/usr,"* | *",/usr/"* | *",/boot,"* | *",/boot/"* | *",/var/lib/relay-manager,"* | *",/var/lib/relay-manager/"* | \
  *",/var/lib/relay-manager-rootcopy,"* | *",/var/lib/relay-manager-rootcopy/"* | *",/opt/relay-manager,"* | *",/opt/relay-manager/"*)
  die "RM_COPY_ROOT_PATHS=$ROOT_PATHS: root solo puede escribir en carpetas concretas (por defecto /media,/run/media,/mnt), nunca en / ni en carpetas del sistema" ;;
esac
[ -z "$COPY_ROOTS" ] || path_list_ok "$COPY_ROOTS" || die "RM_COPY_ROOTS=$COPY_ROOTS: usa rutas absolutas separadas por comas"
[ -z "$COPY_DENY" ] || path_list_ok "$COPY_DENY" || die "RM_COPY_DENY=$COPY_DENY: usa rutas absolutas separadas por comas"
case "$(conf_active RM_COPY_ENABLED)" in 0 | false) COPY_ON=0 ;; *) COPY_ON=1 ;; esac

# The certificate is generated now, into a private temporary directory, so an openssl failure changes nothing. It is
# installed (and config.env edited) only after the pre-upgrade backup and the configuration copy below.
TLS_NEW=""
cleanup_tls_new() { [ -z "$TLS_NEW" ] || rm -rf "$TLS_NEW"; [ -z "$CONF_MIG" ] || rm -f "$CONF_MIG"; }
trap cleanup_tls_new EXIT
if [ "$TLS" = 1 ]; then
  say "Certificado TLS autofirmado"
  TLS_NEW="$(mktemp -d)"
  chmod 0700 "$TLS_NEW"
  HOST="$(hostname)"
  SAN="DNS:$HOST,DNS:localhost,IP:127.0.0.1"
  for ip in $(hostname -I 2>/dev/null); do
    case "$ip" in *:*) ;; *) SAN="$SAN,IP:$ip" ;; esac
  done
  openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "/CN=$HOST" -addext "subjectAltName=$SAN" \
    -keyout "$TLS_NEW/key.pem" -out "$TLS_NEW/cert.pem" 2>/dev/null || die "openssl no pudo generar el certificado"
  echo "    generado (SAN: $SAN); se instalará tras la copia de seguridad"
fi

# ---------------------------------------------------------------------------
# 1. Never replace files under a running server, whatever the versions.
if [ -f "$UNIT" ]; then
  say "Deteniendo el servicio"
  systemctl stop relay-manager || true
fi
if [ -f "$RC_SOCKET" ]; then
  systemctl stop relay-manager-rootcopy.socket relay-manager-rootcopy.service 2>/dev/null || true
fi
if [ -f "$RM_SOCKET" ]; then
  systemctl stop relay-manager-rootmount.socket relay-manager-rootmount.service 2>/dev/null || true
fi

# 2. Copy the release; drop portable leftovers.
say "Copiando la versión $VERSION"
rm -rf "$TMP"
cp -a "$SRC" "$TMP"
# The bundle's perfil/ is never part of a release: the service reads $PROFILE_DIR (step 4d), and the profile's
# scripts may carry credentials that a world-readable release must not.
rm -rf "$TMP/data" "$TMP/config.env" "$TMP/perfil"
chown -R root:root "$TMP"

# 3-4. Pre-upgrade backup, taken with the copied release (never the extracted tarball) as the service user.
if [ -f "$DATA_DIR/relay-manager.db" ] && [ -n "$CUR" ] && [ "$CUR" != "$VERSION" ]; then
  say "Copia de seguridad previa a la actualización ($CUR → $VERSION)"
  if ! setpriv --reuid="$SVC_USER" --regid="$SVC_USER" --init-groups \
    env RM_MODE=native RM_CONFIG="$CONF" RM_APP_DIR="$TMP/app" NODE_ENV=production \
    "$TMP/node/bin/node" "$TMP/app/server.js" backup --label "pre-upgrade-$CUR-to-$VERSION"; then
    rm -rf "$TMP"
    systemctl start relay-manager || true
    die "No se pudo crear la copia previa a la actualización; no se ha cambiado nada"
  fi
fi

# 4b. Copy of the configuration (config.env and tls/) before anything edits it: on an upgrade, and whenever this run
#     changes an existing configuration (--port, --tls-selfsigned, --files-dir, --extra-dir, --sudo-user). Root only (the
#     TLS key is in it). The profile has its own copy (perfil.anterior-<fecha>, step 4d).
CONF_BACKUPS="$CONF_DIR/backups"
if [ "$NEW_CONF" = 0 ] && { { [ -n "$CUR" ] && [ "$CUR" != "$VERSION" ]; } || [ -n "$CONF_MIG" ] || [ -n "$PORT" ] || [ "$TLS" = 1 ] || [ "$FILES_DIR" != "$FILES_BEFORE" ] || { [ "$EXTRA_ON" = 1 ] && [ "$EXTRA_DIR" != "$EXTRA_BEFORE" ]; } || [ "$SUDO_ACCOUNT" != "$SUDO_BEFORE" ]; }; then
  if [ -n "$CUR" ] && [ "$CUR" != "$VERSION" ]; then label="pre-upgrade-$CUR-to-$VERSION"; else label="pre-install-$VERSION"; fi
  snap="$CONF_BACKUPS/config-$(date -u +%Y%m%dT%H%M%SZ)-$label"
  say "Copia de la configuración en $snap"
  # Like the step 4 backup: a failed copy leaves nothing half done and the service running again.
  if ! {
    install -d -m 0700 -o root -g root "$CONF_BACKUPS" &&
      rm -rf "$snap" &&
      mkdir -m 0700 "$snap" &&
      cp -a "$CONF" "$snap/config.env" &&
      { [ ! -d "$TLS_DIR" ] || cp -a "$TLS_DIR" "$snap/tls"; }
  }; then
    rm -rf "$snap" "$TMP"
    systemctl start relay-manager || true
    die "No se pudo copiar la configuración; no se ha cambiado nada"
  fi
  # Keep the 5 newest copies.
  mapfile -t SNAPS < <(find "$CONF_BACKUPS" -mindepth 1 -maxdepth 1 -type d -name 'config-*' -printf '%f\n' | sort)
  if [ "${#SNAPS[@]}" -gt 5 ]; then
    for old in "${SNAPS[@]:0:${#SNAPS[@]}-5}"; do rm -rf "${CONF_BACKUPS:?}/$old"; done
  fi
fi

# 4c. Configuration edits, now that the previous state is saved.
if [ -n "$CONF_MIG" ]; then
  # Same file (owner and mode kept): its content replaced.
  renamed=$({ diff "$CONF" "$CONF_MIG" || true; } | sed -n 's/^> [[:space:]]*\(export[[:space:]]\+\)\?\(RM_[A-Z0-9_]*\)=.*/\2/p' | sort -u | tr '\n' ' ')
  cat "$CONF_MIG" >"$CONF"
  rm -f "$CONF_MIG"
  CONF_MIG=""
  echo "    claves renombradas en $CONF (migraciones-config.txt del perfil): ${renamed% }"
fi
if [ "$FILES_DIR" != "$FILES_BEFORE" ]; then
  set_conf RM_FILES_DIR "$FILES_DIR"
  echo "    RM_FILES_DIR=$FILES_DIR en $CONF"
fi
if [ "$EXTRA_ON" = 1 ] && [ "$EXTRA_DIR" != "$EXTRA_BEFORE" ]; then
  set_conf RM_FILES_EXTRA_DIR "$EXTRA_DIR"
  echo "    RM_FILES_EXTRA_DIR=$EXTRA_DIR en $CONF (segunda carpeta, «$EXTRA_NAME»)"
fi
if [ -n "$PORT" ]; then
  set_conf RM_PORT "$PORT"
  echo "    RM_PORT=$PORT en $CONF"
fi
if [ "$SUDO_ACCOUNT" != "$SUDO_BEFORE" ]; then
  set_conf RM_SUDO_USER "$SUDO_ACCOUNT"
  echo "    RM_SUDO_USER=$SUDO_ACCOUNT en $CONF (su contraseña autoriza «Copiar como administrador (sudo)»)"
fi
if [ "$TLS" = 1 ]; then
  install -d -m 0750 -o root -g "$SVC_USER" "$TLS_DIR"
  install -m 0644 -o root -g root "$TLS_NEW/cert.pem" "$TLS_DIR/cert.pem"
  install -m 0640 -o root -g "$SVC_USER" "$TLS_NEW/key.pem" "$TLS_DIR/key.pem"
  set_conf RM_TLS_CERT "$TLS_DIR/cert.pem"
  set_conf RM_TLS_KEY "$TLS_DIR/key.pem"
  echo "    certificado instalado en $TLS_DIR/cert.pem"
fi

# 4d. The project profile: copied (without VCS leftovers, links resolved) into a new folder, then swapped in; the one
#     it replaces is kept aside, root only (its scripts may carry credentials), the 5 newest. root:relay-manager: the
#     service reads it and cannot change it.
if [ -n "$PROFILE_SRC" ]; then
  say "Perfil del proyecto: $PROFILE_SRC → $PROFILE_DIR"
  PNEW="$CONF_DIR/.perfil.nuevo.$$"
  rm -rf "$PNEW"
  if ! {
    install -d -m 0750 -o root -g "$SVC_USER" "$PNEW" &&
      tar -C "$PROFILE_SRC" -h --exclude=.git --exclude=.gitignore --exclude=.gitattributes --exclude=.hg --exclude=.svn \
        --exclude='*~' --exclude='*.swp' -cf - . | tar -C "$PNEW" --no-same-owner --no-same-permissions -xf -
  }; then
    rm -rf "$PNEW" "$TMP"
    systemctl start relay-manager || true
    die "No se pudo copiar el perfil $PROFILE_SRC; no se ha cambiado nada"
  fi
  chown -R -h root:"$SVC_USER" "$PNEW"
  find "$PNEW" -type d -exec chmod 0750 {} +
  find "$PNEW" -type f -exec chmod 0640 {} +
  if [ -d "$PNEW/herramientas" ]; then find "$PNEW/herramientas" -type f -name '*.sh' -exec chmod 0750 {} +; fi
  if [ -e "$PROFILE_DIR" ]; then
    old="$CONF_DIR/perfil.anterior-$(date +%Y%m%d-%H%M%S)"
    rm -rf "$old"
    mv "$PROFILE_DIR" "$old"
    chown root:root "$old"
    chmod 0700 "$old"
    echo "    el perfil anterior queda en $old"
    mapfile -t OLDP < <(find "$CONF_DIR" -mindepth 1 -maxdepth 1 -type d -name 'perfil.anterior-*' -printf '%f\n' | sort)
    if [ "${#OLDP[@]}" -gt 5 ]; then
      for o in "${OLDP[@]:0:${#OLDP[@]}-5}"; do rm -rf "${CONF_DIR:?}/$o"; done
    fi
  fi
  mv "$PNEW" "$PROFILE_DIR"
  n=$(find "$PROFILE_DIR/plantillas" -mindepth 1 -maxdepth 1 -type f -name '*.json' ! -name '.*' ! -name '_*' 2>/dev/null | wc -l)
  echo "    instalado: $([ -f "$PROFILE_DIR/perfil.env" ] && echo "perfil.env, ")$n plantillas"
elif [ -d "$PROFILE_DIR" ]; then
  echo "    Perfil del proyecto: se conserva $PROFILE_DIR$([ -d "$SRC/perfil" ] && echo " (el del paquete se instala con --perfil ./perfil)")"
fi

# 5. Portable data next to the extracted bundle: offered as a backup to restore.
if [ -f "$SRC/data/relay-manager.db" ] && [ ! -f "$DATA_DIR/relay-manager.db" ]; then
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  name="relay-manager-$ts-portable.db"
  install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$DATA_DIR/backups"
  if "$TMP/node/bin/node" -e "
      const r = require('module').createRequire('$TMP/app/server.js');
      const D = r('better-sqlite3');
      const db = new D(process.argv[1], { readonly: true, fileMustExist: true });
      db.backup(process.argv[2]).then(() => db.close(), (e) => { console.error(e.message); process.exit(1) });
    " "$SRC/data/relay-manager.db" "$DATA_DIR/backups/$name"; then
    chown "$SVC_USER:$SVC_USER" "$DATA_DIR/backups/$name"
    chmod 0640 "$DATA_DIR/backups/$name"
    echo "    Datos del modo portátil copiados en $DATA_DIR/backups/$name"
    echo "    Para usarlos: sudo relay-manager restore $name"
  else
    warn "No se pudieron copiar los datos del modo portátil ($SRC/data)"
  fi
fi

# 6. Atomic switch.
say "Activando la versión $VERSION"
if [ -d "$RELEASES/$VERSION" ]; then
  rm -rf "$RELEASES/$VERSION.old"
  mv "$RELEASES/$VERSION" "$RELEASES/$VERSION.old"
fi
mv "$TMP" "$RELEASES/$VERSION"
rm -rf "$RELEASES/$VERSION.old"
ln -sfn "releases/$VERSION" "$PREFIX/current"
ln -sfn "$PREFIX/current/bin/relay-manager" "$LINK"

# 7. udev rule and unit.
install -m 0644 "$SRC/udev/99-relay-manager.rules" "$RULE"
if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload 2>/dev/null || warn "udevadm control --reload ha fallado"
  udevadm trigger --action=change --subsystem-match=tty --subsystem-match=usb-serial --subsystem-match=usb 2>/dev/null || warn "udevadm trigger ha fallado"
else
  warn "udevadm no está disponible: la regla se aplicará al reiniciar"
fi
install -m 0644 "$SRC/systemd/relay-manager.service" "$UNIT"

# 7'. «Copiar como administrador (sudo)»: the root helper's units and its own configuration, root:root 0644 (the service
#     reads config.env but cannot write it nor this file: who authenticates and where root writes is decided here).
say "Copia como administrador (sudo): usuario $SUDO_ACCOUNT"
install -m 0644 "$SRC/systemd/relay-manager-rootcopy.socket" "$RC_SOCKET"
install -m 0644 "$SRC/systemd/relay-manager-rootcopy.service" "$RC_UNIT"
tmp="$RC_CONF.tmp.$$"
{
  echo "# Generado por install.sh a partir de config.env: no lo edites (cambia config.env y vuelve a ejecutar install.sh)."
  echo "# Ayudante «Copiar como administrador (sudo)» (relay-manager-rootcopy). Solo root puede cambiarlo."
  echo "RM_COPY_ENABLED=$COPY_ON"
  echo "RM_SUDO_USER=$SUDO_ACCOUNT"
  echo "RM_COPY_SUDO_GROUPS=$COPY_GROUPS"
  echo "RM_COPY_ROOT_PATHS=$ROOT_PATHS"
  [ -z "$COPY_ROOTS" ] || echo "RM_COPY_ROOTS=$COPY_ROOTS"
  [ -z "$COPY_DENY" ] || echo "RM_COPY_DENY=$COPY_DENY"
} >"$tmp"
chown root:root "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$RC_CONF"
# Folders beyond /media, /run/media and /mnt: the unit's ReadWritePaths= gets them too (systemd is the hard limit).
EXTRA_RW=""
IFS=, read -r -a _rp <<<"$ROOT_PATHS"
for p in "${_rp[@]}"; do
  case "$p" in /media | /run/media | /mnt) ;; *) EXTRA_RW="$EXTRA_RW -$p" ;; esac
done
if [ -n "$EXTRA_RW" ]; then
  install -d -m 0755 "$RC_DROPIN_DIR"
  printf '# Generado por install.sh (RM_COPY_ROOT_PATHS). No lo edites.\n[Service]\nReadWritePaths=%s\n' "${EXTRA_RW# }" >"$RC_DROPIN"
  chmod 0644 "$RC_DROPIN"
else
  rm -f "$RC_DROPIN"
  rmdir "$RC_DROPIN_DIR" 2>/dev/null || true
fi
echo "    $RC_CONF (escribe en $ROOT_PATHS)"
[ -z "$SUDO_PROBLEM" ] || warn "Copia como administrador (sudo): $SUDO_PROBLEM. Arréglalo con sudo ./install.sh --sudo-user <usuario con sudo>"
# 7''. «Montar / Expulsar» pendrives (the mount helper reads the same rootcopy.env: RM_SUDO_USER, RM_COPY_ENABLED). It
#      mounts under /media/<RM_SUDO_USER>/<etiqueta>: /media must exist (a minimal Debian may lack it).
install -m 0644 "$SRC/systemd/relay-manager-rootmount.socket" "$RM_SOCKET"
install -m 0644 "$SRC/systemd/relay-manager-rootmount.service" "$RM_UNIT"
if [ ! -e /media ]; then
  install -d -m 0755 -o root -g root /media
  echo "    creada /media (puntos de montaje de los pendrives)"
fi
echo "    Montar y expulsar pendrives: relay-manager-rootmount (en /media/$SUDO_ACCOUNT/<etiqueta>)"

# 7a. "Red de equipos": NetworkManager must leave the app's VLAN interfaces (rmv*) alone, and the adapter wired to the
#     equipment switch when its MAC is known. A keyfile drop-in (nothing else of NetworkManager changes; no restart).
if [ -d /etc/NetworkManager ]; then
  if [ -n "$NET_MAC" ]; then
    "$PREFIX/current/bin/relay-manager" red-equipos "$NET_MAC" | sed 's/^/    /'
  elif [ ! -f "$NM_DROPIN" ]; then
    "$PREFIX/current/bin/relay-manager" red-equipos --quitar | sed 's/^/    /'
  else
    echo "    NetworkManager: se conserva $NM_DROPIN"
  fi
elif [ -n "$NET_MAC" ]; then
  echo "    NetworkManager no está instalado: --red-equipos-mac no hace falta"
fi
# 7a'. ARP when another NIC of the server is on the equipment network (only with --red-equipos-arp-estricto; the
#      service never writes /proc/sys itself): answer ARP only for the addresses of the interface it arrives on.
if [ "$ARP_STRICT" = 1 ]; then
  tmp="$SYSCTL_DROPIN.tmp.$$"
  {
    echo "# Relay Manager (Red de equipos): ARP estricto (install.sh --red-equipos-arp-estricto)."
    echo "# Otra tarjeta del servidor está en la red de los equipos: el servidor solo contesta ARP por la interfaz"
    echo "# que tiene la dirección preguntada y usa en sus peticiones ARP una dirección de esa misma interfaz."
    echo "# Se borra al desinstalar."
    echo "net.ipv4.conf.all.arp_ignore = 1"
    echo "net.ipv4.conf.all.arp_announce = 2"
  } >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$SYSCTL_DROPIN"
  if command -v sysctl >/dev/null 2>&1 && sysctl -q -p "$SYSCTL_DROPIN" >/dev/null 2>&1; then
    echo "    ARP estricto: $SYSCTL_DROPIN (aplicado)"
  else
    warn "no se pudo aplicar $SYSCTL_DROPIN ahora: se aplicará al reiniciar"
  fi
elif [ -f "$SYSCTL_DROPIN" ]; then
  echo "    ARP estricto: se conserva $SYSCTL_DROPIN"
fi

# 7b. "Archivos": the folder (group relay-files, setgid 2775: the service and its owner both read and write) and the
#     systemd sandbox. ProtectSystem=strict leaves only StateDirectory writable and ProtectHome=yes hides /home: a
#     drop-in opens exactly these folders (ProtectHome=tmpfs + BindPaths= for home folders, ReadWritePaths= elsewhere).
#     Two folders: tftp (RM_FILES_DIR) and, when the profile names it, the second one (RM_FILES_EXTRA_DIR).
getent group "$FILES_GROUP" >/dev/null 2>&1 || groupadd --system "$FILES_GROUP"
usermod -aG "$FILES_GROUP" "$SVC_USER"
as_user() { # USER CMD…: runs a command as that user (with the group just added), or as root when USER is ""
  local u=$1
  shift
  if [ -n "$u" ]; then
    setpriv --reuid="$u" --regid="$(id -g "$u")" --init-groups "$@"
  else
    "$@"
  fi
}
setup_shared_dir() { # DIR OWNER BEFORE LABEL
  local dir=$1 owner=$2 before=$3 label=$4
  say "Carpeta $label: $dir"
  if [ -n "$owner" ] && [[ " $(id -nG "$owner" 2>/dev/null) " != *" $FILES_GROUP "* ]]; then
    usermod -aG "$FILES_GROUP" "$owner"
    echo "    $owner añadido al grupo $FILES_GROUP: cierra la sesión y vuelve a entrar para modificar lo que suba la web"
  fi
  if [ ! -d "$dir" ]; then
    if [ -n "$owner" ]; then
      as_user "$owner" mkdir -p "$dir" || die "$owner no puede crear $dir"
    else
      install -d -m 2775 -o "$SVC_USER" -g "$FILES_GROUP" "$dir"
    fi
    echo "    creada"
  fi
  [ -d "$dir" ] && [ ! -L "$dir" ] || die "$dir no es una carpeta"
  as_user "$owner" chgrp -h "$FILES_GROUP" "$dir" || die "No se puede dar el grupo $FILES_GROUP a $dir"
  as_user "$owner" chmod 2775 "$dir" || die "No se pueden cambiar los permisos de $dir"
  if [ "$dir" != "$before" ] && [ -n "$owner" ]; then
    # A folder that already had files: the service must be able to rename, replace and delete them. Done as the owner,
    # so it only touches what the owner could change anyway (links are skipped, never followed).
    as_user "$owner" find -P "$dir" -mindepth 1 -type d -exec chgrp "$FILES_GROUP" {} + -exec chmod g+rwxs {} + 2>/dev/null || true
    as_user "$owner" find -P "$dir" -mindepth 1 -type f -exec chgrp "$FILES_GROUP" {} + -exec chmod g+rw {} + 2>/dev/null || true
  elif [ "$dir" != "$before" ] && [ -n "$(find "$dir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "    la carpeta ya tenía contenido: si la web no puede modificar algo, dale el grupo $FILES_GROUP con escritura (chgrp -R $FILES_GROUP y chmod -R g+rwX)"
  fi
  if command -v setfacl >/dev/null 2>&1; then
    # Folders created later by hand also get group write (default ACL); without acl the setgid bit keeps the group.
    as_user "$owner" setfacl -m "g:$FILES_GROUP:rwx,d:g:$FILES_GROUP:rwx" "$dir" 2>/dev/null || true
  fi
  echo "    ${owner:-$(stat -c %U -- "$dir")}:$FILES_GROUP, 2775"
}
setup_shared_dir "$FILES_DIR" "$FILES_OWNER" "$FILES_BEFORE" "de archivos (tftp)"
SHARED_DIRS=("$FILES_DIR")
if [ "$EXTRA_ON" = 1 ]; then
  setup_shared_dir "$EXTRA_DIR" "$EXTRA_OWNER" "$EXTRA_BEFORE" "«$EXTRA_NAME» (segunda carpeta)"
  SHARED_DIRS+=("$EXTRA_DIR")
fi
# The systemd sandbox opens exactly these folders: home folders with ProtectHome=tmpfs + BindPaths= (the service sees an
# empty /home with only them), others with ReadWritePaths=; inside the data dir (StateDirectory) nothing is needed.
HOME_BINDS=()
RW_PATHS=()
for d in "${SHARED_DIRS[@]}"; do
  case "$d/" in
    "$DATA_DIR"/*) ;;
    /home/* | /root/* | /run/user/*) HOME_BINDS+=("$d") ;;
    *) RW_PATHS+=("$d") ;;
  esac
done
if [ "${#HOME_BINDS[@]}" -eq 0 ] && [ "${#RW_PATHS[@]}" -eq 0 ]; then
  rm -f "$DROPIN"
else
  install -d -m 0755 "$DROPIN_DIR"
  {
    echo "# Generado por install.sh (Archivos: RM_FILES_DIR y RM_FILES_EXTRA_DIR). No lo edites: usa install.sh --files-dir / --extra-dir."
    if [ "${#HOME_BINDS[@]}" -gt 0 ]; then
      echo "# ProtectHome=yes ocultaría /home: el servicio ve un /home vacío (tmpfs) con solo estas carpetas montadas."
    fi
    if [ "${#RW_PATHS[@]}" -gt 0 ]; then
      echo "# ProtectSystem=strict deja todo en solo lectura salvo los datos del servicio y estas carpetas."
    fi
    echo "[Service]"
    if [ "${#HOME_BINDS[@]}" -gt 0 ]; then
      echo "ProtectHome=tmpfs"
      for d in "${HOME_BINDS[@]}"; do echo "BindPaths=$d"; done
    fi
    for d in "${RW_PATHS[@]}"; do echo "ReadWritePaths=$d"; done
  } >"$DROPIN"
  chmod 0644 "$DROPIN"
fi
systemctl daemon-reload
systemctl enable relay-manager >/dev/null 2>&1
systemctl enable relay-manager-rootcopy.socket >/dev/null 2>&1
systemctl enable relay-manager-rootmount.socket >/dev/null 2>&1

# 8. Keep the 3 newest releases (never the current one or the previous one).
mapfile -t ALL < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '*.tmp' ! -name '*.old' -printf '%f\n' | sort -V)
KEEP=3
if [ "${#ALL[@]}" -gt "$KEEP" ]; then
  for old in "${ALL[@]:0:${#ALL[@]}-KEEP}"; do
    if [ "$old" != "$VERSION" ] && [ "$old" != "$CUR" ]; then
      rm -rf "${RELEASES:?}/$old"
      echo "    versión antigua $old borrada"
    fi
  done
fi

if [ "$START" = 0 ]; then
  say "Instalado sin arrancar. Para arrancar: sudo systemctl start relay-manager"
  exit 0
fi

# ---------------------------------------------------------------------------
say "Arrancando el servicio"
systemctl start relay-manager-rootcopy.socket || warn "No se pudo activar relay-manager-rootcopy.socket: «Copiar como administrador (sudo)» no estará disponible"
systemctl start relay-manager-rootmount.socket || warn "No se pudo activar relay-manager-rootmount.socket: «Montar» y «Expulsar» pendrives no estarán disponibles"
systemctl start relay-manager
ok=0
for _ in $(seq 1 60); do
  if "$LINK" ping --quiet >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done
if [ "$ok" != 1 ]; then
  journalctl -u relay-manager -n 50 --no-pager || true
  die "El servicio no responde tras 60 s: revisa el registro de arriba y ejecuta sudo relay-manager doctor"
fi

conf_value() { sed -n "s/^[[:space:]]*$1=//p" "$CONF" | tail -n 1 | tr -d "\"'"; }
PORT_NOW="$(conf_value RM_PORT)"
PORT_NOW="${PORT_NOW:-3200}"
SCHEME=http
[ -n "$(conf_value RM_TLS_CERT)" ] && SCHEME=https
say "Relay Manager $VERSION en marcha. Abre en el navegador:"
urls=0
for ip in $(hostname -I 2>/dev/null); do
  case "$ip" in *:*) ;; *)
    echo "    $SCHEME://$ip:$PORT_NOW"
    urls=$((urls + 1))
    ;;
  esac
done
[ "$urls" -gt 0 ] || echo "    $SCHEME://127.0.0.1:$PORT_NOW   (sin interfaz de red local: solo desde este equipo)"
ACC_NOW="$(conf_value RM_ACCESS_PORTS)"
echo "    Accesos de red de los equipos (JTAG, consolas, Ethernet): puertos TCP ${ACC_NOW:-3201-3230}"
echo "    Carpeta de Archivos (subidas y descargas desde la web): $FILES_DIR"
if [ "$EXTRA_ON" = 1 ]; then echo "    Segunda carpeta de Archivos, «$EXTRA_NAME»: $EXTRA_DIR"; fi
if [ -d "$PROFILE_DIR" ]; then echo "    Perfil del proyecto: $PROFILE_DIR"; else echo "    Sin perfil del proyecto: valores genéricos (sudo ./install.sh --perfil <carpeta>)"; fi
echo "    Copiar a una carpeta del servidor como administrador (sudo): contraseña de $SUDO_ACCOUNT; escribe en $ROOT_PATHS"
[ -n "$CUR" ] && [ "$CUR" != "$VERSION" ] && echo "    Versión anterior conservada: $CUR (sudo relay-manager rollback)"

TOKEN_OUT="$("$LINK" setup-token 2>/dev/null || true)"
if [ -n "$TOKEN_OUT" ] && [[ "$TOKEN_OUT" != *completada* ]]; then
  echo
  echo "========================================================================"
  echo " Configuración inicial pendiente: abre /setup y usa este código"
  echo " Código de configuración:   $TOKEN_OUT"
  echo " (se puede volver a mostrar con: sudo relay-manager setup-token)"
  echo "========================================================================"
fi

echo
say "Diagnóstico (solo avisos y fallos)"
"$LINK" doctor --problems || true
