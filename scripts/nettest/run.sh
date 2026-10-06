#!/usr/bin/env bash
# Prueba con un núcleo Linux real de la "Red de equipos" (pnpm test:net):
#   un contenedor aislado (--network none, nunca toca la red del anfitrión) con un switch VLAN simulado (puente Linux
#   con vlan_filtering) y dos "equipos" en espacios de red distintos con la MISMA IP 192.168.1.10. El código de la
#   aplicación (planHost + iproute + TcpForward) prepara las VLAN y cada reenvío llega a su equipo.
set -euo pipefail
cd "$(dirname "$0")/../.."
IMAGE=relay-manager-nettest:local
NODE_DIR="${RM_NETTEST_NODE_DIR:-$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")}"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "==> Construyendo la imagen de prueba $IMAGE (ubuntu:24.04 + iproute2)"
  printf 'FROM ubuntu:24.04\nRUN apt-get update && apt-get install -y --no-install-recommends iproute2 && rm -rf /var/lib/apt/lists/*\n' \
    | docker build -q -t "$IMAGE" - >/dev/null
fi
exec docker run --rm --privileged --network none \
  -v "$PWD":/repo:ro -v "$NODE_DIR":/opt/node:ro \
  -e PATH=/opt/node/bin:/usr/sbin:/usr/bin:/sbin:/bin -e HOME=/tmp -e TMPDIR=/tmp \
  -w /repo "$IMAGE" bash /repo/scripts/nettest/inside.sh
