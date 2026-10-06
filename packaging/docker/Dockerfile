FROM ubuntu:24.04
RUN groupadd --system --gid 10001 relay-manager \
 && useradd --system --uid 10001 --gid relay-manager --home-dir /data --shell /usr/sbin/nologin relay-manager \
 && install -d -o relay-manager -g relay-manager -m 0750 /data \
 && install -d -o relay-manager -g relay-manager -m 2775 /files /extra \
 && install -d -m 0755 /perfil
# iproute2 (the ip command) for "Red de equipos": its .deb files come in the build context (docker/debs, added by
# scripts/build-bundle.sh --docker, SHA256 checked against the Ubuntu archive), so the build needs no network.
COPY docker/debs /tmp/debs
RUN dpkg -i /tmp/debs/*.deb && rm -rf /tmp/debs && ip -V
COPY node /opt/relay-manager/node
COPY app  /opt/relay-manager/app
COPY bin  /opt/relay-manager/bin
COPY VERSION BUILDINFO /opt/relay-manager/
ENV NODE_ENV=production RM_MODE=docker RM_APP_DIR=/opt/relay-manager/app RM_DATA_DIR=/data \
    RM_CONFIG=/data/config.env RM_PORT=3200 RM_SERIAL_DEV_ROOT=/hostdev \
    PATH=/opt/relay-manager/bin:/opt/relay-manager/node/bin:$PATH
# No USER: the launcher starts as root only to switch to relay-manager with setpriv, keeping at most CAP_NET_ADMIN as
# an ambient capability ("Red de equipos"; Docker gives capabilities to root only). compose.yaml: cap_drop ALL +
# cap_add NET_ADMIN, SETUID, SETGID. Without NET_ADMIN (or with --user relay-manager) everything else works the same.
# /files: "Archivos" (RM_FILES_DIR). compose.yaml mounts a host folder there; without a mount it is a volume.
# /perfil: the project profile (read only), mounted by compose.yaml; the image never carries one (a bundle built with
# --perfil has it next to docker/, outside what is copied here). Without a mount: no profile, generic defaults.
# /extra: the second folder of Archivos (RM_FILES_EXTRA_DIR), when the profile names one; compose.yaml mounts it.
VOLUME ["/data", "/files"]
EXPOSE 3200
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["relay-manager","ping"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["relay-manager"]
CMD ["start"]
