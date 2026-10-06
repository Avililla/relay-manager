#!/usr/bin/env bash
# Punto de entrada del contenedor de las capturas (contenedor.mjs). Corre como root DENTRO del contenedor, que tiene
# su propio espacio de red (nunca --network host): monta una red de equipos de verdad y arranca entorno.mjs con el
# usuario de fuera y solo CAP_NET_ADMIN, para que la aplicación prepare sus VLAN como en un banco real.
#
# Reproduce el PC del banco (como scripts/nettest/inside.sh):
#   enp3s0            tarjeta del laboratorio (dummy, 192.0.2.97/24, ruta por defecto): la aplicación no la toca
#   enp4s0            segunda tarjeta de la placa en la red de los equipos (veth, 192.168.1.203/24) con otro aparato
#                     en 192.168.1.10 detrás (espacio de red «otra»): la red de equipos convive con ella (un aviso)
#   enx00e04c680a1f   otro adaptador USB, sin cable (dummy), con 192.168.0.250/24, su tabla 20000 y su regla: los
#                     restos de la búsqueda automática de una versión anterior («Quitar restos»)
#   enx08beac3882ce   adaptador USB-Ethernet (veth) ─── puerto 1 del switch (espacio de red «sw»)
#   switch            puente Linux con VLAN 802.1Q: puerto 1 con etiqueta 102-108 y la gestión (VLAN 1) en
#                     192.168.0.99, donde escucha la web del TL-SG108E simulado (switch-sim.mjs)
#   puertos 2 a 5     un «equipo» cada uno (espacios de red eq2…eq5), todos con 192.168.1.10 y un servidor SSH
#                     simulado (scripts/sim/fake-ssh-server.mjs: root/root, SFTP, scp y sha256sum) para «Enviar a
#                     equipo…»; su /root es una carpeta propia dentro del contenedor (/equipos/eqN) y escribe despacio
#                     (--write-delay) para que se vea el progreso del envío
#
# Variables: RM_NODE (node), RM_UID, RM_GID, RM_REPO y RM_CTR_DIR (carpeta de las capturas). Argumentos: los de
# entorno.mjs.
set -euo pipefail
NODE="${RM_NODE:?}"
REPO="${RM_REPO:?}"
DIR="${RM_CTR_DIR:?}"
USB_IF=enx08beac3882ce
USB_MAC=08:be:ac:38:82:ce
LAB_IF=enp3s0
LAB_MAC=3c:ec:ef:6a:21:90
OTHER_IF=enp4s0
OTHER_MAC=3c:ec:ef:6a:21:91
OLD_IF=enx00e04c680a1f
OLD_MAC=00:e0:4c:68:0a:1f
SWITCH_IP=192.168.0.99
EQUIPOS=(2 3 4 5)

ip link set lo up
# Tarjeta del laboratorio, con la ruta por defecto (la de Docker sigue para los puertos publicados: 172.17.0.0/16).
ip link add "$LAB_IF" address "$LAB_MAC" type dummy
ip addr add 192.0.2.97/24 dev "$LAB_IF"
ip link set "$LAB_IF" up
ip route replace default via 192.0.2.1 dev "$LAB_IF"

# Segunda tarjeta en 192.168.1.0/24, con otro 192.168.1.10 detrás.
ip netns add otra
ip link add "$OTHER_IF" address "$OTHER_MAC" type veth peer name o1 netns otra
ip addr add 192.168.1.203/24 dev "$OTHER_IF"
ip link set "$OTHER_IF" up
ip netns exec otra ip link set lo up
ip netns exec otra ip addr add 192.168.1.10/24 dev o1
ip netns exec otra ip link set o1 up

# Adaptador USB con los restos de una versión anterior (sin cable).
ip link add "$OLD_IF" address "$OLD_MAC" type dummy
ip addr add 192.168.0.250/24 dev "$OLD_IF" noprefixroute
ip link set "$OLD_IF" up
ip route add 192.168.0.0/24 dev "$OLD_IF" table 20000
ip rule add from 192.168.0.250/32 lookup 20000 pref 20000

# Adaptador USB ↔ puerto 1 del switch.
ip netns add sw
ip link add "$USB_IF" address "$USB_MAC" type veth peer name swp1 netns sw
ip link set "$USB_IF" up
S="ip netns exec sw"
$S ip link set lo up
$S sysctl -qw net.ipv4.ip_unprivileged_port_start=0
$S ip link add br0 type bridge vlan_filtering 1
$S ip link set swp1 master br0
for n in 2 3 4 5 6 7 8; do $S bridge vlan add dev swp1 vid "10$n"; done
$S ip addr add "$SWITCH_IP/24" dev br0
$S ip link set br0 up
$S ip link set swp1 up

# Un equipo por puerto: la misma IP en todos, cada uno con su servidor SSH (su /root, solo dentro del contenedor).
FAKE_SSH="$REPO/scripts/sim/fake-ssh-server.mjs"
for n in "${EQUIPOS[@]}"; do
  ip netns add "eq$n"
  ip link add "swp$n" netns sw type veth peer name eth0 netns "eq$n"
  $S ip link set "swp$n" master br0
  $S bridge vlan del dev "swp$n" vid 1
  $S bridge vlan add dev "swp$n" vid "10$n" pvid untagged
  $S ip link set "swp$n" up
  E="ip netns exec eq$n"
  $E ip link set lo up
  $E ip addr add 192.168.1.10/24 dev eth0
  $E ip link set eth0 up
  mkdir -p "/equipos/eq$n"
  $E unshare -m sh -c 'mount --bind "$1" /root && exec "$2" "$3" --host 192.168.1.10 --port 22 --home /root --name "$4" --write-delay 10' \
    sh "/equipos/eq$n" "$NODE" "$FAKE_SSH" "eq$n" >>"$DIR/equipos-ssh.log" 2>&1 &
done

DROP=(setpriv --reuid="$RM_UID" --regid="$RM_GID" --init-groups --inh-caps=+net_admin --ambient-caps=+net_admin)
$S "${DROP[@]}" "$NODE" "$REPO/scripts/manuales/switch-sim.mjs" --host "$SWITCH_IP" --port 80 --sock "$DIR/switch.sock" \
  --links 1,2,4,5 >>"$DIR/switch.log" 2>&1 &
for _ in $(seq 50); do [ -S "$DIR/switch.sock" ] && break; sleep 0.1; done

exec "${DROP[@]}" "$NODE" "$REPO/scripts/manuales/entorno.mjs" "$@"
