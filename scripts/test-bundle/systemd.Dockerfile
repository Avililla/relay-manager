# systemd-enabled image for the optional native install test (§11.5 step 3, P2): Ubuntu 24.04 (default) or Debian 12
# (the bench PC: --build-arg BASE=debian:12 --build-arg EXTRA=python3, as a desktop install has it).
# Built once on the dev box (it needs Internet for apt); the test itself runs with --network none.
# Ubuntu stays WITHOUT python3 on purpose: there the root helper checks passwords with perl (perl-base, always there);
# on Debian with python3 (ctypes on libcrypt.so.1). Both paths are exercised.
ARG BASE=ubuntu:24.04
FROM ${BASE}
ARG EXTRA=""
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus udev openssl iproute2 util-linux sudo ca-certificates passwd ${EXTRA} \
 && rm -rf /var/lib/apt/lists/* \
 && systemctl mask getty.target console-getty.service systemd-firstboot.service systemd-networkd-wait-online.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
