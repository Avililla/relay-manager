#!/usr/bin/env bash
# Desinstala Relay Manager (§9.6).
#   sudo ./uninstall.sh            quita el programa, el servicio y la regla udev; conserva los datos, la
#                                  configuración y el perfil del proyecto (/etc/relay-manager/perfil)
#   sudo ./uninstall.sh --purge    además borra /var/lib/relay-manager, /etc/relay-manager (con el perfil) y el usuario
set -euo pipefail

PURGE=0
YES=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --yes) YES=1 ;;
    -h | --help)
      echo "Uso: sudo ./uninstall.sh [--purge] [--yes]"
      exit 0
      ;;
    *)
      echo "Opción desconocida: $arg" >&2
      exit 2
      ;;
  esac
done
[ "$(id -u)" = 0 ] || exec sudo -- "$0" "$@"

if [ "$PURGE" = 1 ] && [ "$YES" = 0 ] && [ -t 0 ]; then
  read -r -p "Se borrarán la base de datos, las copias, las capturas, la configuración y el perfil del proyecto. ¿Continuar? [s/N] " answer || answer=""
  case "$answer" in s | S | si | Si | SI | sí | Sí | SÍ) ;; *)
    echo "Cancelado: no se ha borrado nada"
    exit 1
    ;;
  esac
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now relay-manager 2>/dev/null || true
  # «Copiar como administrador (sudo)»: the root helper and its socket.
  systemctl disable --now relay-manager-rootcopy.socket relay-manager-rootcopy.service 2>/dev/null || true
  # «Montar / Expulsar» pendrives: the mount helper and its socket (what is mounted stays mounted).
  systemctl disable --now relay-manager-rootmount.socket relay-manager-rootmount.service 2>/dev/null || true
fi
# "Red de equipos": what the service created at run time, and only that: links named rmv<número>, the management
# addresses marked by its rules (table 20000), rules whose table is 20000-24094 and whose preference is the app's
# (1000-5094, or 20000-24094 in older versions), and routing tables 20000-24094. Never another address, table or rule.
if command -v ip >/dev/null 2>&1; then
  n=0
  for dev in $(ip -o link show 2>/dev/null | awk -F': ' '{ sub(/@.*/, "", $2); print $2 }' | grep -E '^rmv[0-9]{1,4}$' || true); do
    ip link del dev "$dev" 2>/dev/null && n=$((n + 1)) || true
  done
  rules=$(ip -4 rule show 2>/dev/null | awk '{ p = $1; sub(/:$/, "", p); t = ""; f = ""; for (i = 2; i < NF; i++) { if ($i == "lookup" || $i == "table") t = $(i + 1); if ($i == "from") f = $(i + 1) }
             if (p ~ /^[0-9]+$/ && t ~ /^[0-9]+$/ && ((p + 0 >= 1000 && p + 0 <= 5094) || (p + 0 >= 20000 && p + 0 <= 24094)) && t + 0 >= 20000 && t + 0 <= 24094) print p, t, f }')
  a=0
  while read -r pref table from; do
    [ "$table" = 20000 ] && [ -n "$from" ] && [ "$from" != all ] || continue
    from=${from%/32}
    while read -r adev acidr; do
      [ -n "$adev" ] || continue
      ip addr del "$acidr" dev "$adev" 2>/dev/null && a=$((a + 1)) || true
    done < <(ip -o -4 addr show 2>/dev/null | awk -v ip="$from" '{ split($4, c, "/"); if (c[1] == ip) print $2, $4 }')
  done <<<"$rules"
  r=0
  while read -r pref table from; do
    [ -n "$pref" ] || continue
    ip -4 rule del pref "$pref" table "$table" 2>/dev/null && r=$((r + 1)) || true
  done <<<"$rules"
  for table in $(ip -4 route show table all 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "table" && $(i + 1) ~ /^[0-9]+$/ && $(i + 1) + 0 >= 20000 && $(i + 1) + 0 <= 24094) print $(i + 1) }' | sort -u); do
    ip -4 route flush table "$table" 2>/dev/null || true
  done
  if [ "$n" -gt 0 ] || [ "$r" -gt 0 ] || [ "$a" -gt 0 ]; then
    echo "Red de equipos: quitadas $n interfaces rmv*, $r reglas de encaminamiento y $a direcciones de gestión de la aplicación"
  fi
fi
NM_DROPIN=/etc/NetworkManager/conf.d/90-relay-manager-red-equipos.conf
if [ -f "$NM_DROPIN" ]; then
  rm -f "$NM_DROPIN"
  if command -v nmcli >/dev/null 2>&1; then
    nmcli general reload conf >/dev/null 2>&1 || true
  elif command -v systemctl >/dev/null 2>&1; then
    systemctl reload NetworkManager >/dev/null 2>&1 || true
  fi
  echo "NetworkManager: quitado $NM_DROPIN"
fi
SYSCTL_DROPIN=/etc/sysctl.d/60-relay-manager.conf
if [ -f "$SYSCTL_DROPIN" ]; then
  rm -f "$SYSCTL_DROPIN"
  echo "ARP estricto: quitado $SYSCTL_DROPIN (los valores actuales siguen hasta reiniciar; para volver ya a los de Linux: sudo sysctl -w net.ipv4.conf.all.arp_ignore=0 net.ipv4.conf.all.arp_announce=0)"
fi

FILES_DIR=""
EXTRA_DIR=""
if [ -f /etc/relay-manager/config.env ]; then
  FILES_DIR="$(sed -n 's/^[[:space:]]*RM_FILES_DIR=//p' /etc/relay-manager/config.env | tail -n 1 | tr -d "\"'")"
  # The second folder of Archivos: install.sh writes it here whenever the profile names one.
  EXTRA_DIR="$(sed -n 's/^[[:space:]]*RM_FILES_EXTRA_DIR=//p' /etc/relay-manager/config.env | tail -n 1 | tr -d "\"'")"
fi
rm -f /etc/systemd/system/relay-manager.service /etc/udev/rules.d/99-relay-manager.rules /usr/local/bin/relay-manager
rm -f /etc/systemd/system/relay-manager.service.d/archivos.conf
rmdir /etc/systemd/system/relay-manager.service.d 2>/dev/null || true
rm -f /etc/systemd/system/relay-manager-rootcopy.socket /etc/systemd/system/relay-manager-rootcopy.service
rm -f /etc/systemd/system/relay-manager-rootcopy.service.d/rutas.conf
rmdir /etc/systemd/system/relay-manager-rootcopy.service.d 2>/dev/null || true
# The helper's generated configuration and its count of failed passwords (nothing of the users' data).
rm -f /etc/relay-manager/rootcopy.env
rm -rf /var/lib/relay-manager-rootcopy /run/relay-manager-rootcopy
# The mount helper: its units, any local drop-in and its state (the mount folders it created); never a mounted stick.
rm -f /etc/systemd/system/relay-manager-rootmount.socket /etc/systemd/system/relay-manager-rootmount.service
rm -rf /etc/systemd/system/relay-manager-rootmount.service.d
rm -rf /var/lib/relay-manager-rootmount /run/relay-manager-rootmount
if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload 2>/dev/null || true; fi
if command -v udevadm >/dev/null 2>&1; then udevadm control --reload 2>/dev/null || true; fi
rm -rf /opt/relay-manager

if [ "$PURGE" = 1 ]; then
  rm -rf /var/lib/relay-manager /etc/relay-manager
  if id relay-manager >/dev/null 2>&1; then userdel relay-manager 2>/dev/null || true; fi
  if getent group relay-manager >/dev/null 2>&1; then groupdel relay-manager 2>/dev/null || true; fi
  if getent group relay-files >/dev/null 2>&1; then groupdel relay-files 2>/dev/null || true; fi
  echo "Relay Manager desinstalado; datos, configuración, perfil del proyecto y usuario borrados."
  case "$FILES_DIR" in
    "" | /var/lib/relay-manager/*) ;;
    *) [ ! -d "$FILES_DIR" ] || echo "La carpeta de Archivos $FILES_DIR se conserva (son ficheros de los usuarios); bórrala a mano si ya no hace falta." ;;
  esac
  case "$EXTRA_DIR" in
    "" | /var/lib/relay-manager/*) ;;
    *) [ ! -d "$EXTRA_DIR" ] || echo "La segunda carpeta de Archivos $EXTRA_DIR se conserva (son ficheros de los usuarios); bórrala a mano si ya no hace falta." ;;
  esac
else
  echo "Relay Manager desinstalado. Se conservan los datos en /var/lib/relay-manager y la configuración en /etc/relay-manager"
  [ ! -d /etc/relay-manager/perfil ] || echo "Se conserva también el perfil del proyecto: /etc/relay-manager/perfil"
  [ -z "$FILES_DIR" ] || echo "Se conserva también la carpeta de Archivos: $FILES_DIR"
  [ -z "$EXTRA_DIR" ] || echo "Se conserva también la segunda carpeta de Archivos: $EXTRA_DIR"
  echo "(para borrarlos: sudo ./uninstall.sh --purge)."
fi
