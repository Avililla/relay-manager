#!/usr/bin/env bash
# Runs inside the test container (root netns = the bench PC). Builds the bench PC of the lab as reported:
#   - labnic   (dummy):  the lab network 172.20.5.50/16 with the default route (never touched);
#   - othernic (veth):   ANOTHER network on 192.168.1.0/24 (the equipment subnet!), the PC is 192.168.1.203 there and
#                        a host 192.168.1.10 answers "otra-red" behind it (never touched; its traffic must still go there);
#   - usbeth0  (veth):   the new USB adapter, wired to port 1 of a fake TL-SG108E (a VLAN-filtering bridge in netns
#                        "switch", management 192.168.0.99 untagged in VLAN 1, with the fake switch web on port 80);
#   - eq2, eq3:          two equipment on switch ports 2 and 3, both 192.168.1.10, answering "VLAN 102" / "VLAN 103",
#                        each with an SSH server on 2222 (eq3 without SFTP) for «Enviar a equipo»;
#   - usbold  (dummy):   a USB adapter with the management address an older version left (192.168.0.250 + its rule);
#   - rp_filter=1 (strict) on all and default, so every VLAN interface inherits it.
# Then host-vlans.ts (the planner and `ip` runner alone) and bench-pc.ts (the whole service, as in production).
set -euo pipefail
ip link set lo up
sysctl -qw net.ipv4.conf.all.rp_filter=1 net.ipv4.conf.default.rp_filter=1

# Lab NIC with the default route.
ip link add labnic type dummy
ip addr add 172.20.5.50/16 dev labnic
ip link set labnic up
ip route add default via 172.20.0.1 dev labnic

# The other network on 192.168.1.0/24, with its own 192.168.1.10.
ip netns add otra
ip link add othernic type veth peer name o1
ip link set o1 netns otra
ip addr add 192.168.1.203/24 dev othernic
ip link set othernic up
ip netns exec otra ip link set lo up
ip netns exec otra ip addr add 192.168.1.10/24 dev o1
ip netns exec otra ip link set o1 up

# Switch: bridge with VLAN filtering in netns "switch"; its management (192.168.0.99) on the bridge itself, VLAN 1.
ip netns add switch
ip netns add eq2
ip netns add eq3
ip link add usbeth0 type veth peer name swup0
ip link set swup0 netns switch
ip link set usbeth0 up
S="ip netns exec switch"
$S ip link set lo up
$S ip link add br0 type bridge vlan_filtering 1
$S ip link set br0 up
$S ip addr add 192.168.0.99/24 dev br0
$S ip link set swup0 master br0
$S ip link set swup0 up
# Uplink (port 1): VLAN 1 untagged pvid (management), 102/103 tagged.
$S bridge vlan add dev swup0 vid 102
$S bridge vlan add dev swup0 vid 103
for n in 2 3; do
  ip link add "sw$n" type veth peer name "eth$n"
  ip link set "sw$n" netns switch
  ip link set "eth$n" netns "eq$n"
  $S ip link set "sw$n" master br0
  $S bridge vlan del dev "sw$n" vid 1
  $S bridge vlan add dev "sw$n" vid "10$n" pvid untagged
  $S ip link set "sw$n" up
  ip netns exec "eq$n" ip link set lo up
  ip netns exec "eq$n" ip addr add 192.168.1.10/24 dev "eth$n"
  ip netns exec "eq$n" ip link set "eth$n" up
done

# Another USB adapter (it will get the leftover of an older version before bench-pc.ts).
ip link add usbold type dummy
ip link set usbold up

PIDS=()
for n in 2 3; do
  ip netns exec "eq$n" node -e "require('net').createServer((c)=>{c.on('error',()=>{});c.end('VLAN 10$n\n')}).listen(22,'192.168.1.10')" &
  PIDS+=("$!")
done
ip netns exec otra node -e "require('net').createServer((c)=>{c.on('error',()=>{});c.end('otra-red\n')}).listen(22,'192.168.1.10')" &
PIDS+=("$!")
# «Enviar a equipo»: an SSH server (ssh2, pure JavaScript) on 2222 in each "192.168.1.10", root/root, each with its own
# home: eq2 with SFTP, eq3 without SFTP (the scp protocol, like dropbear without sftp-server), and the other network's.
for n in 2 3; do
  ip netns exec "eq$n" node /repo/scripts/sim/fake-ssh-server.mjs --host 192.168.1.10 --port 2222 --home "/tmp/eq$n-home" --name "eq$n" \
    $([ "$n" = 3 ] && echo --no-sftp) >"/tmp/ssh-eq$n.log" 2>&1 &
  PIDS+=("$!")
done
ip netns exec otra node /repo/scripts/sim/fake-ssh-server.mjs --host 192.168.1.10 --port 2222 --home /tmp/otra-home --name otra >/tmp/ssh-otra.log 2>&1 &
PIDS+=("$!")
$S node /repo/scripts/sim/fake-tplink-switch.mjs --host 192.168.0.99 --port 80 --client-port 1 --ports 8 --links 1,2,3 >/tmp/fake-switch.log 2>&1 &
PIDS+=("$!")
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
sleep 0.8

# Fake sysfs: what the hardware is (the kernel's interfaces are virtual in the container).
SYS=/tmp/fake-sys
node --input-type=module -e "
import { plugAdapter } from '/repo/scripts/sim/fake-net-adapter.mjs'
import fs from 'node:fs'
const mac = (n) => fs.readFileSync('/sys/class/net/' + n + '/address', 'utf8').trim()
plugAdapter('$SYS', { ifname: 'labnic', mac: mac('labnic'), pci: true, port: '1' })
plugAdapter('$SYS', { ifname: 'othernic', mac: mac('othernic'), pci: true, port: '2' })
plugAdapter('$SYS', { ifname: 'usbeth0', mac: mac('usbeth0'), port: '3' })
plugAdapter('$SYS', { ifname: 'usbold', mac: mac('usbold'), port: '4', carrier: false })
"

echo "== Planificador y órdenes ip (host-vlans.ts)"
/repo/node_modules/.bin/tsx /repo/scripts/nettest/host-vlans.ts
echo
# What an older version left on that other USB adapter: its management address and its rule (pref = table 20000).
ip addr add 192.168.0.250/24 dev usbold noprefixroute
ip route add 192.168.0.0/24 dev usbold table 20000
ip rule add from 192.168.0.250/32 lookup 20000 pref 20000
echo "== Servicio completo en el PC del banco (bench-pc.ts)"
RM_NETTEST_SYS=$SYS /repo/node_modules/.bin/tsx /repo/scripts/nettest/bench-pc.ts
