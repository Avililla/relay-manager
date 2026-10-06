# Instalación de Relay Manager

Esta guía explica cómo instalar Relay Manager en un equipo **sin conexión a Internet**. Todo lo necesario viaja en el paquete: el programa, su propio Node.js, las fuentes y las migraciones de la base de datos. En el equipo de destino no se descarga nada, ni al instalar ni al ejecutar.

Hay tres formas de instalarlo:

| Forma | Cuándo usarla |
|---|---|
| **Servicio del sistema (systemd)** | La forma recomendada para el banco. Arranca sola, se reinicia si falla y se actualiza con copia previa. |
| **Modo portátil** | Pruebas rápidas o equipos sin systemd. Se descomprime y se ejecuta en primer plano. |
| **Docker** | Si el equipo ya usa Docker y prefieres contenedores. |

Lo propio de cada proyecto (nombre del laboratorio, plantillas de equipo, segunda carpeta compartida, script de descarga…) no va en el paquete: va en un **perfil** aparte que se instala con él (apartado [20](#20-perfil-del-proyecto); cómo escribirlo, en [PERFIL.md](PERFIL.md)). Sin perfil, la aplicación funciona con valores genéricos.

El uso diario y la administración están en [OPERACION.md](OPERACION.md). El diseño interno está en [ARQUITECTURA.md](ARQUITECTURA.md).

---

## 1. Requisitos

**Equipo de destino (el del banco):**

- Ubuntu 24.04 o Debian 12 (bookworm) x86_64, u otra distribución Linux x86_64 con glibc 2.29 o superior (Debian 12 trae glibc 2.36 y el núcleo 6.1; notas en el apartado [18.4](#184-debian-12-bookworm)).
- systemd para la instalación como servicio. Sin systemd, usa el modo portátil o Docker.
- Un disco con formato Linux (ext4) para descomprimir el paquete. FAT y exFAT no sirven: pierden los enlaces simbólicos del paquete.
- Unos 700 MB libres en `/opt` para el programa (se guardan hasta 3 versiones), más el espacio de datos en `/var/lib`. Las capturas de consola ocupan hasta 2 GB por defecto (se puede cambiar).
- Los adaptadores USB-serie de las consolas conectados a **este** equipo.
- Para los **accesos JTAG** (opcional): los cables JTAG USB (Digilent JTAG-HS2/HS3/SMT, Xilinx Platform Cable USB II…) conectados a este equipo y **`hw_server`** instalado en él. Basta con **Vivado Lab** (gratuito y mucho más ligero que Vivado o Vitis, que también sirven). Sin `hw_server`, las consolas por TCP y los accesos Ethernet funcionan igual; los JTAG muestran «Falta hw_server».
- Para la **red de equipos** (opcional, apartado [17](#17-red-de-equipos-switch-y-adaptador-usb)): un adaptador USB-Ethernet dedicado, un switch TP-Link Easy Smart (TL-SG105E, TL-SG108E, TL-SG116E…) y la orden `ip` (paquete `iproute2`, ya instalado en Ubuntu 24.04). Puede convivir con otra tarjeta del servidor en la misma red que los equipos (apartado [17.6](#176-otra-tarjeta-del-servidor-en-1921681x)).
- Para **«Copiar como administrador (sudo)»** en Archivos (opcional, apartado [18](#18-copiar-a-una-carpeta-del-servidor-el-ayudante-de-root)): `python3` o `perl` para comprobar la contraseña (Debian y Ubuntu traen los dos; `perl-base` siempre está) y un usuario con `sudo` y contraseña.
  Para **«Montar» y «Expulsar»** pendrives desde la web: nada más (usa `mount`, `umount` y `blkid`, que siempre están).
- Para las **Descargas** del perfil (opcional, apartado [19](#19-descargas-script-de-descarga-del-perfil)): `bash` y `setpriv` (paquete `util-linux`, siempre instalado) y lo que necesite el script del perfil, que debe traer o comprobar sus propias dependencias (su README las lista).
- Para Docker: Docker Engine con el plugin `docker compose`, ya instalados.

**Navegadores de los puestos:** Chrome o Edge 111 o superior, Firefox 128 o superior, Safari 16.4 o superior. Un navegador más antiguo muestra el aviso «Navegador no compatible». Para actualizar Firefox sin conexión, mira el apartado [12](#12-navegadores).

---

## 2. Qué llevar al equipo sin conexión

Los ficheros salen del equipo de desarrollo (mira «Publicar una versión» en [DESARROLLO.md](DESARROLLO.md#8-publicar-una-versión)). Cópialos en un USB o en una carpeta compartida.

| Instalación | Ficheros |
|---|---|
| Servicio o portátil | `relay-manager-<versión>-linux-x64.tar.gz` y `relay-manager-<versión>-linux-x64.tar.gz.sha256` |
| Docker | `relay-manager-image-<versión>.tar.gz`, `relay-manager-image-<versión>.tar.gz.sha256`, `compose.yaml` y `99-relay-manager.rules` |

---

## 3. Comprobar los ficheros

En la carpeta donde están los ficheros:

```bash
sha256sum -c relay-manager-3.0.0-linux-x64.tar.gz.sha256
# Docker:
sha256sum -c relay-manager-image-3.0.0.tar.gz.sha256
```

Cada línea debe terminar en `La suma coincide` (o `OK`). Si no, vuelve a copiar el fichero.

El paquete lleva dentro otra lista de sumas (`SHA256SUMS`). `install.sh` la comprueba antes de instalar nada.

---

## 4. Descomprimir el paquete

Descomprímelo en un disco ext4, por ejemplo en tu carpeta personal:

```bash
tar xzf relay-manager-3.0.0-linux-x64.tar.gz
cd relay-manager-3.0.0-linux-x64
```

Contenido:

```
relay-manager-3.0.0-linux-x64/
  node/                    Node.js 22.23.2 (solo el ejecutable y su licencia)
  app/                     la aplicación
  bin/relay-manager        el lanzador (todas las órdenes)
  install.sh  uninstall.sh
  systemd/relay-manager.service
  udev/99-relay-manager.rules
  docker/Dockerfile  docker/compose.yaml
  docs/                    estas guías
  LEEME-INSTALACION.md     copia de esta guía
  config.env.example       todas las variables, comentadas
  perfil/                  solo si el paquete se generó con --perfil (apartado 20)
  VERSION  BUILDINFO  SHA256SUMS
```

---

## 5. Instalación como servicio (recomendada)

### 5.1 Instalar

Desde la carpeta descomprimida:

```bash
sudo ./install.sh
```

Opciones:

| Opción | Efecto |
|---|---|
| `--port N` | Puerto HTTP(S), de 1024 a 65535 (por defecto 3200). Se guarda como `RM_PORT` en `/etc/relay-manager/config.env`. |
| `--files-dir RUTA` | Carpeta de **Archivos** (intercambio de ficheros desde la web). Por defecto, en la primera instalación, `/home/<usuario>/tftp` del usuario que ejecuta `sudo`; si se ejecuta directamente como root, `/var/lib/relay-manager/tftp`. Se guarda como `RM_FILES_DIR`. Apartado [16](#16-archivos-las-carpetas-compartidas). |
| `--extra-dir RUTA` | Segunda carpeta compartida de Archivos (raíz `extra`), solo si el perfil la define (`RM_FILES_EXTRA_NAME`). Por defecto, en la primera instalación, la `RM_FILES_EXTRA_DIR` del perfil (con `~` = la carpeta personal del usuario que ejecuta `sudo`), o `/home/<usuario>/<nombre>`; si no hay usuario, `/var/lib/relay-manager/<nombre>`. Se guarda como `RM_FILES_EXTRA_DIR`. Apartado [16](#16-archivos-las-carpetas-compartidas). |
| `--perfil DIR` | Instala ese perfil en `/etc/relay-manager/perfil` (el anterior queda como `perfil.anterior-<fecha>`). Sin la opción, se instala el `perfil/` del paquete solo si aún no hay ninguno. Apartado [20](#20-perfil-del-proyecto). |
| `--tls-selfsigned` | Genera un certificado autofirmado y activa HTTPS (apartado [7](#7-https-opcional)). |
| `--red-equipos-mac MAC` | NetworkManager deja en paz el adaptador USB del switch (además de las interfaces `rmv*`). Apartado [17.4](#174-networkmanager). |
| `--red-equipos-arp-estricto` | Cuando otra tarjeta del servidor está en la red de los equipos: `arp_ignore=1` y `arp_announce=2` en `/etc/sysctl.d/60-relay-manager.conf` (se aplica al momento). Apartado [17.6](#176-otra-tarjeta-del-servidor-en-1921681x). |
| `--sudo-user USUARIO` | Usuario con sudo cuya contraseña autoriza **«Copiar como administrador (sudo)»** en Archivos. Por defecto, en la primera instalación, el que ejecuta `sudo ./install.sh` (el dueño de `~/tftp`); al actualizar se conserva. Se guarda como `RM_SUDO_USER`. Apartado [18](#18-copiar-a-una-carpeta-del-servidor-el-ayudante-de-root). |
| `--no-start` | Instala sin arrancar el servicio. |
| `--yes` | No pide confirmación al actualizar o reinstalar. |

El instalador se vuelve a ejecutar con `sudo` si no lo lanzas como root.

**Comprobaciones previas.** Antes de tocar nada, `install.sh` comprueba:

- las sumas de `SHA256SUMS`;
- que el paquete está en un disco Linux (los enlaces simbólicos siguen ahí);
- que el equipo es x86_64 con glibc 2.29 o superior;
- que el sistema arranca con systemd;
- que el Node incluido carga los módulos nativos;
- que no instalas una versión **anterior** a la instalada (para eso existe `rollback`, apartado [9](#9-volver-a-una-versión-anterior)).

Si una comprobación falla, el mensaje dice qué hacer y no se cambia nada.

### 5.2 Qué crea

| Ruta | Qué es |
|---|---|
| usuario y grupo `relay-manager` | Usuario de sistema sin shell. Se añade al grupo `dialout` para abrir los puertos serie y a `relay-files` para la carpeta de Archivos. |
| grupo `relay-files` | Comparten la carpeta de Archivos el servicio y el usuario dueño de la carpeta. |
| `/opt/relay-manager/releases/<versión>/` | El programa. Se guardan las 3 versiones más recientes. |
| `/opt/relay-manager/current` | Enlace a la versión activa. |
| `/usr/local/bin/relay-manager` | Enlace al lanzador: todas las órdenes (`relay-manager help`). |
| `/etc/relay-manager/config.env` | Configuración (root:relay-manager, 0640). Se crea solo si no existe, con todo comentado. |
| `/etc/relay-manager/tls/` | Certificado y clave, solo con `--tls-selfsigned`. |
| `/etc/relay-manager/backups/` | Copias de `config.env` y `tls/` hechas por el instalador antes de cambiarlos. |
| `/var/lib/relay-manager/` | Datos del servicio (0750): base de datos, secreto de sesión, copias de seguridad y capturas. |
| `/etc/udev/rules.d/99-relay-manager.rules` | Regla udev para los adaptadores USB-serie (ver abajo). |
| `/etc/systemd/system/relay-manager.service` | La unidad systemd, habilitada al arranque. Tiene la capacidad `CAP_NET_ADMIN` para la red de equipos (apartado [17](#17-red-de-equipos-switch-y-adaptador-usb)). |
| `/etc/NetworkManager/conf.d/90-relay-manager-red-equipos.conf` | Solo si NetworkManager está instalado: le dice que no gestione las interfaces `rmv*` de la red de equipos (y el adaptador USB, con `--red-equipos-mac`). Se conserva al actualizar. |
| `/etc/sysctl.d/60-relay-manager.conf` | Solo con `--red-equipos-arp-estricto`: ARP estricto (`arp_ignore=1`, `arp_announce=2`) para cuando otra tarjeta está en la red de los equipos. Se conserva al actualizar. |
| `/home/<usuario>/tftp` (o la de `--files-dir`) | Carpeta de **Archivos** «tftp»: `<usuario>:relay-files`, permisos 2775. El `<usuario>` y el servicio entran en el grupo `relay-files` (apartado [16](#16-archivos-las-carpetas-compartidas)). |
| `/home/<usuario>/<nombre>` (o la de `--extra-dir`) | Solo si el perfil define la segunda carpeta (`RM_FILES_EXTRA_NAME`, por ejemplo «Compartida» en `/home/<usuario>/compartida`): igual que la anterior. |
| `/etc/relay-manager/perfil/` | El perfil del proyecto, si se instaló (root:relay-manager, ficheros 0640, carpetas 0750, `herramientas/*.sh` 0750). Apartado [20](#20-perfil-del-proyecto). |
| `/etc/systemd/system/relay-manager.service.d/archivos.conf` | *Drop-in* que da al servicio acceso a esas carpetas (y solo a ellas) sin quitar el resto del aislamiento. No existe si todas están dentro de `/var/lib/relay-manager`. |
| `/etc/systemd/system/relay-manager-rootcopy.socket` y `.service` | El **ayudante de root** de «Copiar como administrador (sudo)»: el socket (habilitado al arranque) y el servicio que systemd arranca con la primera conexión. Apartado [18](#18-copiar-a-una-carpeta-del-servidor-el-ayudante-de-root). |
| `/etc/relay-manager/rootcopy.env` | Configuración del ayudante (root:root, 0644), generada desde `config.env` en cada instalación: el usuario con sudo, sus grupos y dónde puede escribir root. |
| `/etc/systemd/system/relay-manager-rootcopy.service.d/rutas.conf` | Solo si `RM_COPY_ROOT_PATHS` tiene carpetas además de `/media`, `/run/media` y `/mnt`: las abre en el aislamiento del ayudante. |
| `/var/lib/relay-manager-rootcopy/` | Estado del ayudante (root, 0700): el recuento de contraseñas incorrectas, la clave con la que firma los permisos de administrador de 5 minutos (`token.key`, 0600) y los permisos olvidados antes de caducar. |
| `/etc/systemd/system/relay-manager-rootmount.socket` y `.service` | El **ayudante de montaje** de «Montar» y «Expulsar» pendrives: socket `root:root` 0600 (solo el ayudante de copia llega a él) y el servicio que systemd arranca con la primera conexión. Apartado [18.5](#185-montar-y-expulsar-pendrives). |
| `/var/lib/relay-manager-rootmount/` | Estado del ayudante de montaje (root, 0700): las carpetas de `/media` que ha creado. |
| `/media` | Se crea (0755 root) si no existe: ahí se montan los pendrives. |

Estructura de los datos:

```
/var/lib/relay-manager/
  relay-manager.db (+ -wal, -shm)   base de datos SQLite
  auth-secret                       secreto de sesión, generado al primer arranque (0600)
  setup-token                       código de configuración inicial, solo mientras está pendiente (0600)
  .instance-lock                    bloqueo de instancia (mientras el servidor funciona)
  server.pid                        informativo
  backups/                          copias de seguridad de la base de datos
  consoles/<id de consola>/         capturas continuas de cada consola
```

**La regla udev** hace tres cosas con los adaptadores `ttyUSB*` y `ttyACM*`:

- les da el grupo `dialout` y permisos 0660;
- le dice a ModemManager que los ignore (si no, envía comandos AT a los `ttyACM` y detiene la cuenta atrás de U-Boot);
- pone la latencia de los adaptadores FTDI a 1 ms, para que la consola responda al momento.

El instalador la recarga y la aplica a los adaptadores ya conectados.

### 5.3 Primer acceso y código de configuración

Al terminar, `install.sh`:

1. arranca el servicio y espera a que responda;
2. muestra las direcciones para abrir en el navegador, una por cada IPv4 del equipo, por ejemplo `http://198.51.100.10:3200`;
3. muestra el **código de configuración** (algo como `7KQM-X2PD-9HVA-RT4C`);
4. muestra los avisos del diagnóstico, si los hay.

Abre cualquiera de las direcciones: la aplicación te lleva a **/setup**. Escribe el código (da igual mayúsculas, minúsculas, espacios o guiones) y crea el administrador (usuario, nombre y contraseña de al menos 10 caracteres). Al terminar entras directamente en el Banco.

Si has perdido el código:

```bash
sudo relay-manager setup-token
```

El código también aparece en el registro del servicio al arrancar (`relay-manager logs`). Solo sirve una vez: cuando existe un administrador, `/setup` deja de estar disponible.

También puedes crear el primer administrador desde la línea de órdenes; eso cierra la configuración inicial igual:

```bash
sudo relay-manager user create jefa --admin --name "Nombre Apellido"
```

### 5.4 Comprobar la instalación

```bash
relay-manager status          # estado del servicio (systemctl status)
sudo relay-manager doctor     # diagnóstico completo, en español
relay-manager logs            # registro en directo (Ctrl+C para salir)
```

`doctor` termina con un resumen `N fallo(s), M aviso(s)`. Los avisos no impiden trabajar; los fallos sí. En [OPERACION.md](OPERACION.md#8-relay-manager-doctor) se explica cada comprobación.

### 5.5 Accesos JTAG: hw_server y cables

Los accesos JTAG de los equipos (apartado 3.11 de [OPERACION.md](OPERACION.md#311-accesos-de-red-administración)) arrancan un `hw_server` por cable, cada uno en su puerto. Para que funcionen:

1. **Instala Vivado Lab** (o Vivado/Vitis) en `/tools/Xilinx` o en `/opt/Xilinx`, con su instalador sin conexión. El servicio lo encuentra solo: busca `hw_server` en `/tools/Xilinx`, `/opt/Xilinx`, `/tools/AMDDesignTools` y `/opt/AMDDesignTools` (las dos estructuras de carpetas: `<raíz>/<producto>/<versión>/bin` y, desde 2025, `<raíz>/<versión>/<producto>/bin`) y se queda con la versión más nueva. Si está en otro sitio, indícalo en `/etc/relay-manager/config.env`:

   ```bash
   RM_HW_SERVER=/ruta/a/Vivado_Lab/2024.2/bin/hw_server
   ```

   El servicio no ve `/home` (`ProtectHome`): no instales Vivado Lab en una carpeta personal si lo va a usar el servicio.
2. **Permisos de los cables.** La regla udev del paquete (`/etc/udev/rules.d/99-relay-manager.rules`) da al grupo `dialout` acceso a los cables Digilent (FTDI con descriptor «Digilent» o VID 1443), Xilinx (VID 03fd) y FTDI que se anuncian como «JTAG». `install.sh` la instala y la aplica; si conectaste los cables antes, desconéctalos y vuelve a conectarlos. La **Platform Cable USB II** necesita además su firmware: ejecuta una vez el `install_drivers` de Xilinx (`<Vivado Lab>/data/xicom/cable_drivers/lin64/install_script/install_drivers/install_drivers`).
3. **Comprueba** con `sudo relay-manager doctor`: las líneas «hw_server (JTAG)» y «Cables JTAG» dicen qué se ha encontrado y si falta algún permiso.

Cada `hw_server` se arranca así (sin shell), con el número de serie del cable como filtro y los puertos GDB (3000-3005) desactivados:

```
hw_server -s tcp::<puerto> -p0 -e "set jtag-port-filter <número de serie>"
```

- `-s tcp::<puerto>`: escucha en ese puerto en todas las interfaces (o en `RM_ACCESS_BIND`).
- `-p0`: desactiva los servidores GDB (3000-3005), que chocarían entre instancias (UG908, *Standard hw_server Options*).
- `jtag-port-filter`: según UG908 (*Advanced Options*) admite una lista separada por comas de identificadores **completos o parciales** del puerto JTAG. `hw_server` llama a los cables `Digilent/<serie>` o `Xilinx/<serie>`, y Digilent documenta el filtro con series parciales (`set jtag-port-filter 210205,210249`), así que el servidor pasa el número de serie tal como lo da sysfs. Si con tu versión de `hw_server` el cable no aparece, cambia el formato con `RM_HW_SERVER_FILTER_FORMAT` (por ejemplo `{vendor}/{serial}`, donde `{vendor}` es `Digilent` o `Xilinx`).
- **Compruébalo una vez por tipo de cable:** reserva el equipo y, desde un PC, `xsdb -eval "connect -host <servidor> -port <puerto>; jtag targets"` debe mostrar **solo** el cable de ese acceso. `doctor` lo recuerda en la línea «hw_server (JTAG)».

Su `HOME` y su `TMPDIR` son `/var/lib/relay-manager/xilinx`, y su salida va al registro del servicio (`relay-manager logs`, componente `jtag`).

### 5.6 Herramientas interactivas (picocom, minicom, BITReader_Tool)

El servicio ya pertenece a `dialout`. Si además quieres usar `picocom` u otras herramientas con **tu** usuario (tras «Soltar puerto» en la aplicación), añádelo al grupo y vuelve a iniciar sesión:

```bash
sudo usermod -aG dialout "$USER"
```

---

## 6. Modo portátil

Sirve para probar sin instalar nada. Todo queda dentro de la carpeta del paquete.

```bash
tar xzf relay-manager-3.0.0-linux-x64.tar.gz
cd relay-manager-3.0.0-linux-x64
./bin/relay-manager
```

- Funciona en primer plano. Se detiene con **Ctrl+C**.
- Los datos van a `./data` y la configuración, opcional, a `./config.env` (copia `config.env.example` y descomenta lo que necesites).
- Al arrancar muestra las direcciones y el código de configuración.
- **No lo ejecutes como root**: se niega («No ejecutes el modo portátil como root…»). Usa un usuario del grupo `dialout` para que pueda abrir los puertos serie (`sudo usermod -aG dialout "$USER"` y vuelve a iniciar sesión).
- Los ficheros se crean sin permiso de lectura para otros usuarios del equipo.
- Todas las órdenes funcionan igual con `./bin/relay-manager <orden>` (por ejemplo `./bin/relay-manager doctor`).
- La carpeta de **Archivos** es `~/tftp` del usuario que lo arranca (se crea si no existe); cámbiala con `RM_FILES_DIR` en `./config.env`.
- «Copiar a una carpeta del servidor» funciona solo donde puede escribir tu usuario: no hay **«Copiar como administrador (sudo)»**, porque el ayudante de root solo lo instala `install.sh` (el diálogo lo explica).

**Pasar los datos del modo portátil a la instalación como servicio.** Ejecuta `sudo ./install.sh` desde **la misma carpeta** donde funcionó el modo portátil (con el servidor portátil detenido). Si el servicio aún no tiene base de datos, el instalador copia `./data/relay-manager.db` a `/var/lib/relay-manager/backups/relay-manager-<fecha>-portable.db` y te dice la orden para usarla:

```bash
sudo systemctl stop relay-manager
sudo relay-manager restore relay-manager-<fecha>-portable.db
sudo systemctl start relay-manager
```

Si la base de datos está en otra carpeta, `restore` también acepta una ruta (con el servicio detenido): `sudo relay-manager restore /ruta/a/relay-manager.db`. Las sesiones abiertas se pierden, porque el secreto de sesión es otro: basta con volver a entrar.

---

## 7. HTTPS (opcional)

Por defecto la aplicación usa HTTP sin cifrar, pensado para la red cerrada del laboratorio. Para activar HTTPS con un certificado autofirmado:

```bash
sudo ./install.sh --tls-selfsigned
```

- Genera `/etc/relay-manager/tls/cert.pem` y `key.pem` (RSA 3072, válido 10 años). El certificado incluye el nombre del equipo, `localhost`, `127.0.0.1` y todas sus IPv4.
- Rellena `RM_TLS_CERT` y `RM_TLS_KEY` en `config.env`.
- Las direcciones pasan a ser `https://<ip>:<puerto>`. Las consolas (WebSocket) y las actualizaciones en directo usan el mismo puerto y se cifran también.
- Al activarlo, la cookie de sesión cambia de nombre: **todos los usuarios tienen que volver a entrar**.
- Si cambian las IP del equipo, vuelve a ejecutar `sudo ./install.sh --tls-selfsigned` desde el paquete para regenerar el certificado. `doctor` avisa cuando el certificado no cubre alguna IP.

**Aceptar el certificado en los navegadores.** El navegador avisará de que el certificado no es de confianza. Puedes aceptar la excepción en cada puesto o, mejor, importar `cert.pem` como autoridad de confianza:

- Firefox: Ajustes → Privacidad y seguridad → Certificados → Ver certificados → Autoridades → Importar, y marca «Confiar en esta CA para identificar sitios web».
- Chrome/Edge en Linux: Configuración → Privacidad y seguridad → Seguridad → Gestionar certificados → Autoridades → Importar.

Copia `cert.pem` a los puestos con un USB (es público; **nunca** copies `key.pem`).

**Certificado propio.** Si el laboratorio tiene su propia autoridad, copia su certificado y clave a `/etc/relay-manager/tls/` (clave con permisos 0640 root:relay-manager), apunta `RM_TLS_CERT` y `RM_TLS_KEY` a ellos en `config.env` y reinicia: `sudo relay-manager restart`.

**Volver a HTTP:** comenta `RM_TLS_CERT` y `RM_TLS_KEY` en `config.env` y reinicia.

---

## 8. Actualizar

### 8.1 Servicio

1. Copia y comprueba el paquete nuevo (apartados 2 a 4).
2. Desde la carpeta nueva:

   ```bash
   sudo ./install.sh
   ```

El instalador, en este orden:

1. detiene el servicio;
2. copia la versión nueva a `/opt/relay-manager/releases/<versión>`;
3. hace una copia de la base de datos con la versión nueva: `backups/relay-manager-<fecha>-pre-upgrade-<anterior>-to-<nueva>.db`. Si esta copia falla, lo deja todo como estaba y termina con «no se ha cambiado nada»;
4. guarda `config.env` y `tls/` en `/etc/relay-manager/backups/config-<fecha>-pre-upgrade-<anterior>-to-<nueva>/`;
5. cambia `current` a la versión nueva y arranca. Al arrancar, el servidor aplica las migraciones pendientes de la base de datos.

La versión anterior se conserva para poder volver a ella. Las pestañas del navegador que estaban abiertas muestran «Nueva versión instalada»: pulsa «Recargar».

Reinstalar la misma versión también detiene el servicio antes de copiar, pero no hace copia de la base de datos. Instalar una versión anterior está bloqueado: usa `rollback`.

**Actualizar desde 2.x.** La 3.0 saca del programa todo lo propio de un proyecto y lo lleva al perfil (apartado [20](#20-perfil-del-proyecto)). Para que todo siga igual, instala a la vez el perfil de tu proyecto: `sudo ./install.sh --perfil <carpeta del perfil>`. Al actualizar no se pierde nada:

- las plantillas que venían predefinidas pasan a ser plantillas **locales**, editables, con su clave; si el perfil trae un fichero con la misma clave, la plantilla se **vincula** sola al arrancar (pasa a «Fichero» y toma los valores del fichero). Las que no tengan fichero siguen locales. No se borra ninguna plantilla y los equipos no se tocan;
- las variables de la carpeta del proyecto de 2.x ya no existen (si siguen en `config.env`, solo dan un aviso): la segunda carpeta se define ahora con `RM_FILES_EXTRA_NAME` y `RM_FILES_EXTRA_DIR` (en el perfil o en `config.env`). Sus ficheros se quedan donde estaban: pon en `RM_FILES_EXTRA_DIR` la ruta de siempre (o `install.sh --extra-dir <ruta>`);
- la descarga con script deja de venir en el paquete: la activa el perfil (`RM_EXPORT_ENABLED=1` y su script en `herramientas/`, apartado [19](#19-descargas-script-de-descarga-del-perfil));
- el nombre del laboratorio y la «IP de los equipos» de la red de equipos conservan su valor (`RM_LAB_NAME` y `RM_EQUIPNET_EQUIPMENT_IP` solo se usan al crearlos por primera vez).

### 8.2 Docker

```bash
docker compose down
docker load -i relay-manager-image-<nueva>.tar.gz
RM_VERSION=<nueva> docker compose run --rm relay-manager backup --label pre-upgrade-<anterior>-to-<nueva>
RM_VERSION=<nueva> docker compose up -d
```

Si usas el fichero `.env` del apartado [10.2](#102-cargar-la-imagen-y-arrancar), cambia allí `RM_VERSION` en lugar de ponerlo delante de cada orden.

---

## 9. Volver a una versión anterior

### 9.1 Servicio

```bash
sudo relay-manager rollback                 # a la versión instalada más reciente distinta de la actual
sudo relay-manager rollback --to 2.0.0      # a una versión concreta
sudo relay-manager rollback --to 2.0.0 --yes  # sin preguntar
```

`rollback` detiene el servicio y pregunta a la versión de destino si entiende la base de datos actual:

- **Si la entiende** (la actualización no añadió migraciones), cambia de versión **sin tocar los datos**. No se pierde nada.
- **Si no la entiende**, busca la copia `pre-upgrade-<destino>-to-<actual>` que hizo el instalador. Te dice la fecha de esa copia y que **se perderán los cambios hechos después**, pide confirmación (salvo con `--yes`), restaura la copia y arranca. Si no existe esa copia, se niega: volver atrás sin ella no es seguro.

Al final comprueba que el servicio responde.

`rollback` no restaura `config.env` ni `tls/`. Si la actualización los cambió, recupéralos a mano desde `/etc/relay-manager/backups/config-<fecha>-pre-upgrade-<destino>-to-<actual>/`:

```bash
sudo cp -a /etc/relay-manager/backups/config-<fecha>-pre-upgrade-<destino>-to-<actual>/config.env /etc/relay-manager/config.env
sudo relay-manager restart
```

### 9.2 Docker

```bash
docker compose down
RM_VERSION=<anterior> docker compose run --rm relay-manager migrate --dry-run
```

- Si no aparece «Migraciones desconocidas para esta versión», arranca directamente: `RM_VERSION=<anterior> docker compose up -d`.
- Si aparece, restaura antes la copia previa a la actualización:

  ```bash
  RM_VERSION=<anterior> docker compose run --rm relay-manager restore relay-manager-<fecha>-pre-upgrade-<anterior>-to-<nueva>.db --yes
  RM_VERSION=<anterior> docker compose up -d
  ```

---

## 10. Docker (alternativa)

### 10.1 Paso 0: la regla udev en el anfitrión

El contenedor no gestiona udev: los permisos de los adaptadores, el aviso a ModemManager y la latencia FTDI los pone el **anfitrión**. Instala la regla que viaja junto a `compose.yaml`:

```bash
sudo install -m 0644 99-relay-manager.rules /etc/udev/rules.d/
sudo udevadm control --reload
sudo udevadm trigger --action=change --subsystem-match=tty --subsystem-match=usb-serial
```

Sin ella, ModemManager envía comandos AT a los `ttyACM*` y rompe el autoarranque de U-Boot. La regla también da acceso a los cables JTAG (apartado [5.5](#55-accesos-jtag-hw_server-y-cables)); para ellos usa `--subsystem-match=usb` en el `trigger`.

**Accesos JTAG en Docker (opcional, no probado con cables reales).** El contenedor necesita ver los cables USB y la instalación de Xilinx del anfitrión. En `compose.yaml` descomenta:

```yaml
      - /dev/bus/usb:/dev/bus/usb:ro
      - /tools/Xilinx:/tools/Xilinx:ro
```

La regla de cgroup `c 189:* rw` ya está puesta. Si `hw_server` no está en `/tools/Xilinx` u `/opt/Xilinx`, define `RM_HW_SERVER` en `/data/config.env`. La imagen es un Ubuntu 24.04 mínimo: si a tu versión de `hw_server` le falta alguna biblioteca, usa la instalación como servicio.

### 10.2 Cargar la imagen y arrancar

```bash
docker load -i relay-manager-image-3.0.0.tar.gz
getent group dialout | cut -d: -f3      # número del grupo dialout del anfitrión (20 en Ubuntu)
```

Crea un fichero `.env` junto a `compose.yaml` (Docker Compose lo lee solo):

```
RM_VERSION=3.0.0
DIALOUT_GID=20
RM_PORT=3200
TZ=Europe/Madrid
RM_FILES_HOST_DIR=/home/<usuario>/tftp
FILES_GID=1000
# opcionales: el perfil (se monta en /perfil, solo lectura) y la segunda carpeta (en /extra)
RM_PROFILE_HOST_DIR=/home/<usuario>/perfil
RM_FILES_EXTRA_HOST_DIR=/home/<usuario>/compartida
```

`RM_FILES_HOST_DIR` es la carpeta del anfitrión para **Archivos** (por defecto `~/tftp` de quien lanza `docker compose`) y `FILES_GID` el número de su grupo (`id -g`). Créala antes y dale escritura al grupo con el bit setgid, para que lo que suba el contenedor siga siendo de ese grupo:

```bash
mkdir -p ~/tftp && chmod 2775 ~/tftp && id -g
```

`RM_PROFILE_HOST_DIR` es la carpeta del perfil del proyecto en el anfitrión (por defecto `./perfil`, junto a `compose.yaml`), montada en `/perfil` en solo lectura (apartado [20](#20-perfil-del-proyecto)); si no existe, la aplicación usa los valores genéricos. `RM_FILES_EXTRA_HOST_DIR` es la segunda carpeta compartida, montada en `/extra`; solo se usa si el perfil la define (`RM_FILES_EXTRA_NAME`). Créala igual que la de tftp.

Y arranca:

```bash
docker compose up -d
docker compose logs relay-manager        # direcciones y código de configuración
docker compose exec relay-manager relay-manager setup-token
```

Abre `http://<ip del anfitrión>:3200` y completa /setup como en el apartado [5.3](#53-primer-acceso-y-código-de-configuración).

### 10.3 Por qué está configurado así

| Ajuste de `compose.yaml` | Motivo |
|---|---|
| `network_mode: host` | El descubrimiento de placas usa difusión UDP al puerto 30303, que no atraviesa una red puente de Docker. También deja la aplicación en `http://<ip>:3200` sin mapear puertos. |
| `/dev:/hostdev:ro` y `RM_SERIAL_DEV_ROOT=/hostdev` | Los adaptadores que se conectan después de arrancar aparecen solos (con `devices:` solo se verían los que existían al arrancar). El montaje es de solo lectura, pero los dispositivos de carácter se siguen abriendo para leer y escribir. La aplicación muestra y guarda las rutas como `/dev/...`. |
| `device_cgroup_rules` `c 188:* rw` y `c 166:* rw` | Permiten abrir `ttyUSB*` (major 188) y `ttyACM*` (major 166). |
| `group_add: ["${DIALOUT_GID}"]` | El usuario del contenedor (uid 10001) necesita el grupo `dialout` **del anfitrión**. |
| `cap_drop: [ALL]`, `no-new-privileges`, `read_only: true` | Se quitan todas las capacidades y el sistema de ficheros es de solo lectura. Solo se escribe en `/data` (el volumen) y `/tmp`. |
| `cap_add: [NET_ADMIN, SETUID, SETGID, KILL]` | Red de equipos (apartado [17](#17-red-de-equipos-switch-y-adaptador-usb)). Docker solo da capacidades a root, así que el contenedor arranca como root y el lanzador pasa enseguida al usuario `relay-manager` (uid 10001, con sus grupos) con `setpriv`, conservando **solo** `CAP_NET_ADMIN`; `SETUID` y `SETGID` sirven únicamente para ese cambio, y `KILL` para que el init del contenedor (root) pueda reenviar `SIGTERM` al servidor. Con `network_mode: host`, `NET_ADMIN` permite crear las interfaces VLAN en el adaptador del anfitrión. Si no usas la red de equipos, quita `NET_ADMIN` (lo demás funciona igual y la web muestra las órdenes para root). La imagen incluye `iproute2`. |
| `init: true` | Un proceso init recoge los procesos hijos. |
| volumen `relay-data` en `/data` | Base de datos, secreto, código de configuración, copias, capturas y `config.env`. |
| `/media:/media:rslave` (comentado) | «Copiar a una carpeta del servidor» hacia los pendrives del anfitrión. En Docker solo se copia como el usuario del contenedor: no hay «como administrador (sudo)», porque el contenedor no tiene el root del anfitrión. La carpeta de destino tiene que dejar escribir al grupo `FILES_GID`; `rslave` hace que se vean también los pendrives montados después de arrancar. |
| `${RM_FILES_HOST_DIR}:/files` y `group_add` `FILES_GID` | Archivos: la carpeta del anfitrión montada en `/files` (el valor por defecto de `RM_FILES_DIR` en Docker). El contenedor escribe con el grupo del dueño de la carpeta: los ficheros subidos quedan `664`, del usuario 10001 y de ese grupo, y el dueño los puede modificar y borrar. Sin el montaje, `/files` es un volumen anónimo. |

**Otros adaptadores.** Los `ttyXRUSB*` (Exar) y `ttyCH*USB*` (WCH) tienen un número *major* dinámico. Míralo con `ls -l /dev/ttyXRUSB0` (el primer número antes de la coma) y añade una línea `- "c <major>:* rw"` a `device_cgroup_rules`. Si falta, la consola muestra «Sin permiso» y `doctor` sugiere la regla.

### 10.4 Operación con Docker

| Tarea | Orden |
|---|---|
| Diagnóstico | `docker compose exec relay-manager relay-manager doctor` |
| Código de configuración | `docker compose exec relay-manager relay-manager setup-token` |
| Restablecer una contraseña | `docker compose exec relay-manager relay-manager user reset-password <usuario>` |
| Copia de seguridad (con el servicio en marcha) | `docker compose run --rm relay-manager backup` |
| Sacar una copia del volumen | `docker compose cp relay-manager:/data/backups/<nombre>.db .` |
| Restaurar (con el servicio **detenido**) | `docker compose stop` y `docker compose run --rm relay-manager restore <nombre> --yes` |
| Importar configuración (con el servicio **detenido**) | `docker compose run --rm -v "$PWD/config.json:/import/config.json:ro" relay-manager config import /import/config.json` |

`restore` y `config import` se niegan mientras el servidor funciona: el bloqueo de instancia detecta el otro contenedor.

**Configuración.** Las variables `RM_*` se pueden poner en la sección `environment:` de `compose.yaml`, o en `/data/config.env` dentro del volumen (`docker compose cp config.env relay-manager:/data/config.env` y `docker compose restart`). `RM_PORT`, `RM_DATA_DIR` y `RM_SERIAL_DEV_ROOT` ya los fija el contenedor y el entorno tiene prioridad sobre el fichero: el puerto se cambia en `.env` (`RM_PORT=`) y `docker compose up -d`.

Dentro del contenedor, las comprobaciones de ModemManager, brltty, NTP y systemd salen como `[INFO] No comprobable desde el contenedor`: revísalas en el anfitrión.

Los simuladores de consola (ptys) no se pueden abrir desde el contenedor. Para demostraciones con Docker, usa adaptadores reales o el controlador de relés `simulated` (`RM_RELAY_SIMULATE=1`).

---

## 11. Desinstalar

Desde la carpeta de cualquier paquete descomprimido (o con `sudo /opt/relay-manager/current/uninstall.sh`):

```bash
sudo ./uninstall.sh            # quita el programa, el servicio, la regla udev y el enlace; conserva los datos
sudo ./uninstall.sh --purge    # además borra /var/lib/relay-manager, /etc/relay-manager y el usuario
```

También quita el ayudante de «Copiar como administrador (sudo)»: `relay-manager-rootcopy.socket` y `.service` (detenidos y deshabilitados), su *drop-in* `rutas.conf`, `/etc/relay-manager/rootcopy.env` y `/var/lib/relay-manager-rootcopy`, y el ayudante de montaje (`relay-manager-rootmount.socket` y `.service` y `/var/lib/relay-manager-rootmount`). Un pendrive que siga montado queda montado. Las carpetas de Archivos (tftp y la segunda carpeta) no se tocan nunca, tampoco con `--purge`.

También quita lo que la red de equipos creó en el sistema, y solo eso: las interfaces `rmv<número>`, las direcciones de gestión de la aplicación (las que marcan sus reglas de la tabla 20000, por ejemplo 192.168.0.250), las reglas cuya tabla es 20000 a 24094 y cuya preferencia es la de la aplicación (1000 a 5094, o 20000 a 24094 de versiones anteriores), las tablas 20000 a 24094, el *drop-in* de NetworkManager y el de ARP estricto (`/etc/sysctl.d/60-relay-manager.conf`; los valores siguen hasta reiniciar).

`--purge` pide confirmación (o `--yes` para no preguntar). Sin `--purge`, los datos siguen en `/var/lib/relay-manager` y la configuración en `/etc/relay-manager`: una instalación posterior los vuelve a usar.

La carpeta de **Archivos** no se borra nunca (ni con `--purge`) si está fuera de `/var/lib/relay-manager`: son ficheros de los usuarios. El *drop-in* `relay-manager.service.d/archivos.conf` sí se borra. `--purge` borra también el grupo `relay-files`: los ficheros conservan su número; si te molesta: `sudo chgrp -R "$(id -gn <usuario>)" /home/<usuario>/tftp`.

---

## 12. Navegadores

La aplicación necesita Firefox 128, Chrome/Edge 111 o Safari 16.4 como mínimo.

**Actualizar Firefox (snap) sin conexión:**

1. En un equipo con Internet: `snap download firefox`. Descarga dos ficheros, `firefox_<n>.snap` y `firefox_<n>.assert`.
2. Cópialos al puesto sin conexión.
3. Instálalos:

   ```bash
   sudo snap ack firefox_*.assert
   sudo snap install firefox_*.snap
   ```

**Alternativa:** instala Chromium o Google Chrome 111 o superior desde un paquete `.deb` traído en USB (`sudo apt install ./google-chrome-stable_*.deb`).

Si `snap install` pide otros snaps (base o de contenido), descárgalos también con `snap download <nombre>` y instálalos antes con `snap ack` + `snap install`. Con el `.deb` de Chrome, si `apt` pide dependencias, tráelas también en el USB.

Sobre HTTP sin cifrar, algunas funciones del navegador no están disponibles; la aplicación ya lo tiene en cuenta (por ejemplo, «Copiar» usa un método alternativo).

---

## 13. Red y cortafuegos

| Tráfico | Dirección | Para qué |
|---|---|---|
| TCP `RM_PORT` (3200) | entrada, desde los puestos del laboratorio | interfaz web, actualizaciones en directo (SSE) y consolas (WebSocket), todo por un único puerto |
| TCP `RM_ACCESS_PORTS` (3201–3230) | entrada, desde los puestos del laboratorio | accesos de red de los equipos: un puerto fijo por acceso (JTAG con `hw_server`, consolas serie por TCP, reenvío Ethernet) |
| TCP a la IP de cada equipo (por ejemplo 22) | salida | reenvío de los accesos Ethernet (con la red de equipos, solo por la VLAN de su puerto en la interfaz elegida) |
| TCP 80 al switch de los equipos | salida, por la interfaz elegida | red de equipos: leer y configurar el switch (y buscarlo en su red de gestión, solo cuando un administrador pulsa «Buscar el switch») |
| UDP 30303 | entrada | anuncios de las placas Devantech y respuestas a «Buscar placas (UDP)» |
| UDP 30303 (difusión) | salida | «Buscar placas (UDP)», solo cuando un administrador lo pulsa |
| TCP 80, 17123, 17494 | salida, hacia las placas | control de los relés (HTTP, ASCII y binario ETH) |
| TCP a los puertos de `RM_RELAY_SCAN_PORTS` | salida | «Escanear subred…», solo cuando un administrador lo pide |

Con `ufw`:

```bash
sudo ufw allow from 198.51.100.0/24 to any port 3200 proto tcp
sudo ufw allow from 198.51.100.0/24 to any port 3201:3230 proto tcp
sudo ufw allow 30303/udp
```

(cambia la red y el puerto por los tuyos).

**Red del laboratorio con puertos restringidos (3200–3230).** La interfaz web usa **un** puerto TCP de entrada: el 3200 por defecto (o cualquiera del rango con `--port`). La web, las actualizaciones en directo y las consolas en el navegador van todas por él. Los **accesos de red** de los equipos (JTAG, consolas por TCP y Ethernet, para trabajar desde el PC de cada ingeniero en paralelo) usan el resto del rango, 3201–3230 (`RM_ACCESS_PORTS`): cada acceso tiene su puerto fijo, que se asigna al crear el equipo y se ve en su pestaña «Accesos». Con 30 puertos caben, por ejemplo, 6 equipos con 5 accesos cada uno. Solo están abiertos mientras el equipo está reservado (salvo los marcados «Siempre»). Lo único que queda fuera del rango es el descubrimiento de placas Devantech por UDP 30303: si ese puerto no está permitido, las placas no aparecen solas en Descubrimiento, pero se pueden encontrar con «Escanear subred…» (conexiones salientes) o darlas de alta escribiendo su IP. Las consolas serie no usan la red.

**Puertos por debajo de 1024** (por ejemplo 80 o 443). `install.sh --port` no los acepta, porque el servicio no tiene privilegios. Si los necesitas, añade un complemento a la unidad:

```bash
sudo systemctl edit relay-manager
```

con este contenido:

```ini
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
```

Después pon `RM_PORT=443` (o el que sea) en `/etc/relay-manager/config.env` y reinicia: `sudo relay-manager restart`.

**Mover los datos a otro disco.** El servicio solo puede escribir en `/var/lib/relay-manager`. Si cambias `RM_DATA_DIR`, `RM_BACKUP_DIR` o `RM_CAPTURE_DIR` a otra ruta, añade también un complemento con `sudo systemctl edit relay-manager`:

```ini
[Service]
ReadWritePaths=/srv/relay-manager-datos
```

y deja la carpeta con el propietario del servicio: `sudo install -d -o relay-manager -g relay-manager -m 0750 /srv/relay-manager-datos`. Si la carpeta no es del usuario del servicio, `doctor` falla en «Propietario de los datos»; si falta el complemento `ReadWritePaths`, el servicio no arranca y `relay-manager logs` muestra un error de sistema de ficheros de solo lectura.

---

## 14. Referencia de configuración

Todas las variables son opcionales. Se leen de:

1. el entorno del proceso (tiene prioridad);
2. el fichero de configuración: `/etc/relay-manager/config.env` (servicio), `<paquete>/config.env` (portátil) o `/data/config.env` (Docker);
3. el `perfil.env` del perfil del proyecto, solo para las variables del perfil (apartado [20](#20-perfil-del-proyecto));
4. los valores por defecto.

El formato es `VARIABLE=valor`, una por línea. Un valor no válido detiene el arranque con un mensaje que nombra la variable (código de salida 2). Una variable `RM_*` desconocida en el fichero solo produce un aviso. Tras cambiar el fichero: `sudo relay-manager restart`, y comprueba con `sudo relay-manager doctor`.

`config.env.example` en el paquete tiene todas las variables comentadas.

**Perfil del proyecto** (apartado [20](#20-perfil-del-proyecto))

| Variable | Por defecto | Valores |
|---|---|---|
| `RM_PROFILE_DIR` | servicio: `/etc/relay-manager/perfil`; portátil: `<paquete>/perfil`; Docker: `/perfil`; desarrollo: `<repositorio>/perfil` | carpeta del perfil. Solo en el entorno del proceso o en `config.env` (nunca en `perfil.env`). Si no existe, valores genéricos |
| `RM_LAB_NAME` | `Relay Manager` | nombre del laboratorio, solo al crear los ajustes por primera vez (después se cambia en Sistema › Ajustes) |


**Red y sesiones**

| Variable | Por defecto | Valores |
|---|---|---|
| `RM_HOST` | `0.0.0.0` | dirección IPv4/IPv6 o nombre de host donde escucha |
| `RM_PORT` | `3200` | puerto HTTP(S) |
| `RM_TLS_CERT`, `RM_TLS_KEY` | sin definir | rutas del certificado y la clave; las dos o ninguna |
| `RM_SESSION_MAX_AGE_H` | `12` | caducidad de la sesión por inactividad, 1 a 168 horas (la duración máxima absoluta es 72 h, o este valor si es mayor) |
| `RM_AUTH_SECRET` | se genera en `<datos>/auth-secret` | secreto de las sesiones, 32 caracteres o más; se rechazan valores de ejemplo como `changeme` |
| `RM_SETUP_TOKEN` | aleatorio | código de configuración inicial fijo (automatización); al menos 16 caracteres sin contar espacios ni guiones |
| `RM_LOG_LEVEL` | `info` | `debug`, `info`, `warn` o `error` |

**Datos**

| Variable | Por defecto | Valores |
|---|---|---|
| `RM_DATA_DIR` | según el modo (`/var/lib/relay-manager`, `<paquete>/data`, `/data`) | directorio de datos |
| `RM_DB_FILE` | `$RM_DATA_DIR/relay-manager.db` | base de datos |
| `RM_BACKUP_DIR` | `$RM_DATA_DIR/backups` | copias de seguridad |
| `RM_CAPTURE_DIR` | `$RM_DATA_DIR/consoles` | capturas de consola |
| `RM_ALLOW_UNKNOWN_MIGRATIONS` | `0` | `1` = arrancar aunque la base de datos sea de una versión más nueva (no recomendado) |
| `RM_ALLOW_ROOT` | `0` | `1` = permitir el modo portátil como root (solo pruebas en contenedores) |

**Consolas serie**

| Variable | Por defecto | Valores |
|---|---|---|
| `RM_SERIAL_DEV_ROOT` | `/dev` | raíz de los dispositivos (`/hostdev` en Docker) |
| `RM_SERIAL_SYS_ROOT` | `/sys` | raíz de sysfs (solo pruebas) |
| `RM_SERIAL_EXTRA_GLOBS` | vacío | rutas extra separadas por comas, con comodines solo en el último componente; solo bajo `/dev/`, `/run/relay-manager/`, `/run/user/` o `<datos>/sim/` (simuladores) |
| `RM_SERIAL_INCLUDE_BUILTIN` | `0` | `1` = listar también los puertos serie integrados (`ttyS*`, `ttyAMA*`) |
| `RM_SERIAL_HIDE_JTAG` | `1` | ocultar en los selectores los puertos que parecen JTAG |
| `RM_SERIAL_SCAN_INTERVAL_MS` | `2000` | sondeo de adaptadores, 500 a 60000 ms |
| `RM_SERIAL_SETTLE_MS` | `800` | espera de estabilización al conectar un adaptador, 0 a 10000 ms |
| `RM_SERIAL_ALLOW_POKE` | `1` | `0` = quitar la acción «Enviar retorno de carro» |
| `RM_SERIAL_HISTORY_KB` | `256` | historial en memoria por consola, 16 a 4096 KiB |
| `RM_CAPTURE_ENABLED` | `1` | `0` = no guardar capturas de consola en disco |

**Placas de relés**

| Variable | Por defecto | Valores |
|---|---|---|
| `RM_RELAY_POLL_MS` | `5000` | lectura periódica de placas conectadas, 1000 a 60000 ms |
| `RM_RELAY_OFFLINE_POLL_MS` | `15000` | lectura de placas sin respuesta, 5000 a 300000 ms |
| `RM_RELAY_TIMEOUT_MS` | `1500` | tiempo máximo por petición, 200 a 10000 ms |
| `RM_RELAY_PASSIVE_DISCOVERY` | `1` | escuchar los anuncios UDP 30303 |
| `RM_RELAY_DISCOVERY_PORT` | `30303` | puerto UDP de descubrimiento (solo pruebas) |
| `RM_RELAY_DISCOVERY_BROADCASTS` | la difusión de cada interfaz de red local | direcciones IPv4 de difusión, separadas por comas |
| `RM_RELAY_SCAN_CIDRS` | la /24 de cada interfaz | redes para el escaneo, separadas por comas, cada una /22 o menor |
| `RM_RELAY_SCAN_PORTS` | `80` | puertos del escaneo, hasta 4 |
| `RM_RELAY_SIMULATE` | `0` (`1` en desarrollo) | permitir el controlador `simulated` |

**Accesos de red**

| Variable | Por defecto | Valores |
|---|---|---|
| `RM_ACCESS_PORTS` | `3201-3230` | rango de puertos TCP de los accesos (`inicio-fin`, 1024 a 65535, como mucho 1000 puertos); `RM_PORT` nunca se asigna aunque esté dentro |
| `RM_ACCESS_BIND` | `0.0.0.0` | dirección donde escuchan los accesos |
| `RM_ACCESS_MAX_CONNECTIONS` | `8` | conexiones simultáneas por acceso de consola o Ethernet, 1 a 64 |
| `RM_HW_SERVER` | se busca solo | ruta de `hw_server` (o, para pruebas, un script `.mjs` como `scripts/sim/fake-hw-server.mjs`); sin definir: `XSCT`, `VITIS`, `XILINX_VITIS`, `XILINX_VIVADO`, el `PATH` y las carpetas de instalación habituales, la versión más nueva |
| `RM_HW_SERVER_FILTER_FORMAT` | `{serial}` | valor de `set jtag-port-filter` de cada `hw_server`: `{serial}` es el número de serie del cable y `{vendor}` es `Digilent` o `Xilinx` (por ejemplo `{vendor}/{serial}`); ver el apartado 5.5 |
| `RM_JTAG_SYS_ROOT` | el de `RM_SERIAL_SYS_ROOT` | raíz de sysfs para detectar los cables JTAG (pruebas y simulador) |

**Red de equipos**

| Variable | Por defecto | Valores |
|---|---|---|
| `RM_NET_HOST` | `apply` | `apply` = el servicio prepara sus interfaces VLAN, direcciones y rutas (necesita `CAP_NET_ADMIN`); `off` = nunca cambia la red del servidor y la web solo muestra las órdenes para ejecutarlas a mano |
| `RM_NET_SYS_ROOT` | el de `RM_SERIAL_SYS_ROOT` | raíz de sysfs para detectar los adaptadores de red (pruebas y simuladores) |
| `RM_NET_IP_BIN` | se busca solo | ruta de la orden `ip` (por defecto `/usr/sbin/ip`, `/sbin/ip`, `/usr/bin/ip` o `/bin/ip`) |
| `RM_NET_ALLOW_NON_USB` | `0` | `1` = una tarjeta que no es USB se elige sin la confirmación extra (hardware especial o pruebas); la tarjeta con la ruta por defecto nunca se permite |
| `RM_NET_SWITCH_HTTP_PORT` | `80` | puerto HTTP de la gestión del switch (solo simuladores) |
| `RM_NET_POLL_MS` | `10000` | lectura del enlace de los puertos del switch, 2000 a 300000 ms |
| `RM_EQUIPNET_EQUIPMENT_IP` | (sin valor) | «IP de los equipos» inicial, solo cuando se crea la red de equipos por primera vez (por ejemplo `192.168.1.10`); sin ella, se configura en Sistema › Red de equipos |
| `RM_EQUIPNET_EQUIPMENT_PORT` | `22` | puerto por defecto de los accesos Ethernet nuevos y de «Enviar a equipo» cuando el acceso no tiene puerto |

**Archivos**

| Variable | Por defecto | Valores |
|---|---|---|
| `RM_FILES_DIR` | servicio: la que escribe `install.sh` (`/home/<usuario>/tftp`, o `/var/lib/relay-manager/tftp`); portátil y desarrollo: `~/tftp`; Docker: `/files` | carpeta que la página Archivos deja subir y descargar a todos los usuarios con sesión. No puede ser una carpeta del sistema (`/`, `/etc`, `/home`…), ni contener los datos, las copias, las capturas o el programa |
| `RM_FILES_ENABLED` | `1` | `0` = quitar la página y su API |
| `RM_FILES_MAX_UPLOAD_MB` | `4096` | tamaño máximo de cada fichero subido, 1 a 1048576 MiB |
| `RM_FILES_DELETE` | `users` | quién puede borrar: `users` (cualquiera con sesión; queda en la auditoría) o `admins` |
| `RM_FILES_EXTRA_NAME` | (sin valor: no hay segunda carpeta) | nombre de la segunda carpeta compartida (raíz `extra`), por ejemplo `Compartida`; sin él no existe |
| `RM_FILES_EXTRA_ENABLED` | `1` si hay nombre | `0` = quitarla aunque el perfil la defina |
| `RM_FILES_EXTRA_DIR` | servicio: la que escribe `install.sh` (`/home/<usuario>/<nombre>`, o `/var/lib/relay-manager/<nombre>`); portátil y desarrollo: `~/<nombre>`; Docker: `/extra` | su carpeta (`~/` = carpeta personal). Mismas reglas que `RM_FILES_DIR`; además, no puede ser esa carpeta ni estar una dentro de la otra |
| `RM_FILES_EXTRA_HINT` | «Segunda carpeta compartida (<carpeta>)» | una línea que la describe en el selector de carpetas |

**Archivos › Descargas** (script de descarga del perfil; apartado [19](#19-descargas-script-de-descarga-del-perfil))

| Variable | Por defecto | Valores |
|---|---|---|
| `RM_EXPORT_ENABLED` | `0` | `1` = activar las descargas (necesita `RM_EXPORT_DOWNLOADER`) |
| `RM_EXPORT_DOWNLOADER` | (ninguno) | ruta del script (se ejecuta con `bash`); relativa = a la carpeta del perfil, por ejemplo `herramientas/descarga.sh` |
| `RM_EXPORT_TIMEOUT_MIN` | `60` | tiempo máximo de una descarga, 1 a 1440 minutos; después se cancela |
| `RM_EXPORT_ROOT` | `extra` si hay segunda carpeta; si no, `tftp` | carpeta donde queda el zip: `extra` o `tftp` |
| `RM_EXPORT_NAME` | `Descargas` | nombre corto (panel, auditoría, Salud) |
| `RM_EXPORT_TITLE` | `Ejecutar script de descarga…` | título del botón, del menú y del diálogo |
| `RM_EXPORT_DESCRIPTION` | una frase genérica | párrafo del diálogo |
| `RM_EXPORT_APP_LABEL` / `RM_EXPORT_VERSION_LABEL` | `Aplicación` / `Versión` | etiquetas de los dos campos |
| `RM_EXPORT_EXTRACT_LABEL` | (sin valor: sin casilla) | etiqueta de la casilla opcional que pasa `-x` al script |
| `RM_EXPORT_USER` | (vacío) | usuario del repositorio de artefactos; se pasa al script como `EXPORT_USER` (o el nombre de `RM_EXPORT_ENV_USER`; solo si tiene valor) |
| `RM_EXPORT_PASSWORD` | (vacío) | su contraseña; se pasa como `EXPORT_PASSWORD` (o `RM_EXPORT_ENV_PASSWORD`; solo si tiene valor). Mejor en `config.env` (root:relay-manager 0640) que en el perfil: nunca va al navegador, al registro ni a la auditoría |
| `RM_EXPORT_URL` | (sin valor: no se pasa) | dirección del repositorio de artefactos (por ejemplo `https://artefactos.example:8082/repositorio`): se pasa al script como `EXPORT_URL` (o `RM_EXPORT_ENV_URL`) y Salud y `doctor` comprueban si responde (HEAD, 3 s; solo aviso) |
| `RM_EXPORT_ENV_USER` / `RM_EXPORT_ENV_PASSWORD` / `RM_EXPORT_ENV_URL` | `EXPORT_USER` / `EXPORT_PASSWORD` / `EXPORT_URL` | nombres de esas variables en el entorno del script (los suele fijar el perfil, según lo que espere su script) |
| `RM_EXPORT_ENV_EXTRA` | (ninguna) | variables fijas para las herramientas del script: `NOMBRE=valor` separadas por espacios |


**Archivos › Copiar a una carpeta del servidor** (solo administradores; apartado [18](#18-copiar-a-una-carpeta-del-servidor-el-ayudante-de-root))

| Variable | Por defecto | Valores |
|---|---|---|
| `RM_COPY_ENABLED` | `1` | `0` = quitar la opción de la web y de la API (el ayudante de root también la rechaza) |
| `RM_COPY_ROOTS` | `/` | carpetas que se pueden recorrer y en las que se puede copiar, rutas absolutas separadas por comas |
| `RM_COPY_DENY` | (vacío) | carpetas donde nunca se copia, **además** de las que siempre están prohibidas: `/proc`, `/sys`, `/dev`, `/run` (salvo `/run/media`), `/boot`, `/etc`, `/usr`, `/bin`, `/sbin`, `/lib*`, `/var/lib/relay-manager`, `/var/lib/relay-manager-rootcopy`, `/opt/relay-manager`, los datos, copias, capturas, programa y configuración de la aplicación, y `/` misma |
| `RM_COPY_ROOT_PATHS` | `/media,/run/media,/mnt` | dónde puede escribir el ayudante de root («como administrador»). Nunca `/` ni una carpeta del sistema. Tras cambiarla, vuelve a ejecutar `install.sh` (ajusta el ayudante y su aislamiento de systemd) |
| `RM_SUDO_USER` | servicio: el que escribe `install.sh` (quien lo ejecutó con `sudo`, o root); portátil y desarrollo: el usuario que arranca el programa | el usuario con sudo cuya contraseña autoriza la copia como administrador. Cámbialo con `install.sh --sudo-user <usuario>`: el ayudante usa su propia copia en `/etc/relay-manager/rootcopy.env`, no la de `config.env` |
| `RM_COPY_SUDO_GROUPS` | `sudo,wheel,admin` | grupos que dan permiso de administrador en el equipo (los usa el ayudante, vía `install.sh`) |
| `RM_COPY_HELPER_SOCKET` | servicio: `/run/relay-manager-rootcopy/rootcopy.sock`; otros modos: ninguno | socket del ayudante (solo para pruebas o instalaciones especiales) |
| `RM_COPY_TEST_REMOVABLE` | (vacío) | **solo pruebas**: un `/dev/loopN` que la lista de unidades trata como pendrive. El ayudante de montaje tiene su propio interruptor de pruebas (`RM_ROOTMOUNT_TEST_LOOP` en un *drop-in* de su unidad); en un banco real no se usan |

**Solo en el entorno del proceso** (en el fichero se ignoran con un aviso; el servicio, el lanzador y la imagen Docker ya los fijan): `RM_MODE` (`native`, `portable`, `docker` o `dev`), `RM_DEV`, `RM_CONFIG` (ruta del fichero de configuración) y `RM_APP_DIR`.

---

## 15. Si algo falla durante la instalación

Empieza siempre por el diagnóstico y el registro:

```bash
sudo relay-manager doctor
relay-manager logs
```

| Síntoma | Causa probable | Solución |
|---|---|---|
| «El paquete está incompleto o dañado (SHA256SUMS no coincide)» | copia incompleta | vuelve a copiar el `.tar.gz` y comprueba la suma (apartado 3) |
| «Extrae el .tar.gz en un disco Linux (ext4), no en FAT/exFAT» | paquete descomprimido en un USB FAT/exFAT | descomprímelo en tu carpeta personal |
| «Este sistema no arranca con systemd» | contenedor, WSL o sistema sin systemd | usa el modo portátil o Docker |
| «El servicio no responde tras 60 s» | puerto ocupado, configuración no válida o disco sin permisos | lee las 50 líneas de registro que muestra el instalador y ejecuta `sudo relay-manager doctor` |
| «El puerto 3200 ya está en uso» | otro programa en ese puerto | `sudo ./install.sh --port 3201` (o cambia `RM_PORT`) |
| El servicio se detiene con código 2 | valor no válido en `config.env` | el registro nombra la variable; corrígela y `sudo relay-manager restart` |
| El servicio se detiene con código 4 | la base de datos es de una versión más nueva | vuelve a esa versión o restaura la copia `pre-upgrade` (apartado 9) |
| No aparecen los adaptadores | falta la regla udev, ModemManager o brltty | mira «Solución de problemas» en [OPERACION.md](OPERACION.md#solución-de-problemas) |
| Archivos: «La carpeta de archivos … no existe» o sin permiso | `RM_FILES_DIR` cambiado a mano sin ajustar permisos ni el *drop-in* de systemd | `sudo /opt/relay-manager/current/install.sh --files-dir <ruta> --yes` (apartado 16) |
| Archivos: la segunda carpeta no aparece o «no disponible» | el perfil no define `RM_FILES_EXTRA_NAME` (o no se instaló el perfil), `RM_FILES_EXTRA_ENABLED=0`, o `RM_FILES_EXTRA_DIR` cambiado a mano | instala el perfil (`--perfil`, apartado 20) o `sudo /opt/relay-manager/current/install.sh --extra-dir <ruta> --yes` (apartado 16) |
| Salud o `doctor`: «Perfil» falla | un fichero del perfil no es válido (el mensaje nombra el fichero y el campo, por ejemplo `plantillas/equipo-a.json: consoles[1].key: Clave repetida: UART0`) | corrige ese fichero, compruébalo con `sudo relay-manager plantillas comprobar` y pulsa «Recargar plantillas» (o `sudo relay-manager plantillas recargar`); apartado [20](#20-perfil-del-proyecto) |
| Aviso «Variable no permitida en perfil.env: X» | `perfil.env` solo acepta las variables del perfil | pásala a `config.env` |
| «Montar» no aparece o dice que no está disponible | `relay-manager-rootmount.socket` parado o versión anterior de la unidad | `sudo systemctl enable --now relay-manager-rootmount.socket` o vuelve a ejecutar `install.sh` (apartado 18.5) |
| Red de equipos: «Sin permiso para cambiar la red» | El servicio no tiene `CAP_NET_ADMIN` (modo portátil, unidad antigua o Docker sin `cap_add`) | Apartado [17.3](#173-permisos) |
| Red de equipos: «La red 192.168.1.0/24 ya la usa … en este servidor» al guardar | Versión anterior (lo trataba como error) | Actualiza: ahora es un aviso (apartado [17.6](#176-otra-tarjeta-del-servidor-en-1921681x)) |
| Red de equipos: una tarjeta que no es la del switch tiene 192.168.0.250 | La dejó la búsqueda automática de una versión anterior | Apartado [17.7](#177-actualizar-desde-la-versión-anterior-restos-en-otra-tarjeta) |

---

## 16. Archivos: las carpetas compartidas

La página **Archivos** ([OPERACION.md](OPERACION.md#29-archivos-intercambiar-ficheros-con-el-servidor)) deja a los usuarios subir ficheros desde su PC a una carpeta del servidor y descargarlos: **tftp** (`RM_FILES_DIR`, `~/tftp`) y, si el perfil la define, una **segunda carpeta compartida** (raíz `extra`, con el nombre de `RM_FILES_EXTRA_NAME`, por ejemplo «Compartida» en `~/compartida`; ahí llegan también las descargas del perfil, apartado [19](#19-descargas-script-de-descarga-del-perfil)). No es un servidor TFTP ni lo arranca: es solo la carpeta (que puede ser, si quieres, la misma que sirve un `tftpd` que ya tengas). Todo lo de este apartado vale igual para las dos: mismo grupo, mismos permisos y el mismo *drop-in* de systemd.

**Dónde (tftp).** `RM_FILES_DIR` (apartado [14](#14-referencia-de-configuración)):

| Instalación | Carpeta por defecto |
|---|---|
| Servicio | `install.sh` usa `/home/<usuario>/tftp` del usuario que lo ejecuta con `sudo` (el que ve la página como su `~/tftp`). Si lo ejecutas como root sin `sudo`, `/var/lib/relay-manager/tftp`. Lo escribe en `/etc/relay-manager/config.env`; al actualizar se conserva. |
| Portátil y desarrollo | `~/tftp` del usuario que arranca el programa. |
| Docker | `/files`, montado desde `RM_FILES_HOST_DIR` del anfitrión (apartado [10.2](#102-cargar-la-imagen-y-arrancar)). |

**Dónde (segunda carpeta).** Solo existe si `RM_FILES_EXTRA_NAME` tiene valor (normalmente en el perfil). `RM_FILES_EXTRA_DIR`: en el servicio, `install.sh` la lee del perfil (con `~` = la carpeta personal del usuario que lo ejecuta con `sudo`), la crea y la escribe en `config.env` si aún no estaba; si no hay usuario, `/var/lib/relay-manager/<nombre>`; en portátil y desarrollo, `~/<nombre>`; en Docker, `/extra` (montada desde `RM_FILES_EXTRA_HOST_DIR`). No puede ser la carpeta tftp ni estar una dentro de la otra. `RM_FILES_EXTRA_ENABLED=0` la quita.

**Cambiarlas en el servicio.** No edites solo `config.env`: vuelve a ejecutar el instalador, que ajusta todo (permisos, grupo y acceso de systemd) y reinicia el servicio:

```bash
sudo /opt/relay-manager/current/install.sh --files-dir /home/ana/tftp --yes
sudo /opt/relay-manager/current/install.sh --extra-dir /home/ana/compartida --yes
```

**Permisos (servicio).** El servicio corre como `relay-manager` y el ingeniero con su propio usuario; los dos tienen que poder leer y escribir en la carpeta. Para eso comparten un grupo propio, `relay-files` (no el grupo `relay-manager`, que lee la base de datos, las copias y `config.env`):

- la carpeta queda `<usuario>:relay-files` con permisos `2775` (el bit *setgid* hace que todo lo que se cree dentro sea del grupo `relay-files`);
- el `<usuario>` y el usuario del servicio entran en el grupo `relay-files` (el usuario, al cerrar la sesión y volver a entrar);
- lo que sube la web queda `664` (y las carpetas `2775`), así que el usuario lo puede modificar y borrar desde el servidor;
- si ya había ficheros en la carpeta, el instalador les pone el grupo `relay-files` con escritura para el grupo (solo la primera vez que se configura esa carpeta). Todo lo que hace dentro de una carpeta de un usuario lo hace **como ese usuario**, no como root, y sin seguir enlaces;
- la ruta se usa en su forma real (`realpath`) y se rechazan las que tienen `.`, `..` o espacios;
- con el paquete `acl` instalado, además pone una ACL por defecto para que las subcarpetas que crees a mano también tengan escritura para el grupo. Sin `acl`, si creas una subcarpeta a mano y la web no puede escribir en ella: `chmod g+w <subcarpeta>`.

**El aislamiento de systemd.** La unidad tiene `ProtectSystem=strict` (todo en solo lectura salvo `/var/lib/relay-manager`) y `ProtectHome=yes` (el servicio no ve `/home`). Para las carpetas de Archivos el instalador escribe un *drop-in* que abre **solo esas carpetas**:

```ini
# /etc/systemd/system/relay-manager.service.d/archivos.conf  (las dos carpetas en /home)
[Service]
ProtectHome=tmpfs
BindPaths=/home/ana/tftp
BindPaths=/home/ana/compartida
```

Con `ProtectHome=tmpfs` el servicio ve un `/home` vacío y dentro solo las carpetas montadas: el resto de carpetas personales siguen ocultas. Para una carpeta fuera de `/home` (por ejemplo `/srv/tftp`) el *drop-in* lleva `ReadWritePaths=/srv/tftp` (junto a lo de la otra carpeta). Todo lo demás de la unidad no cambia. Compruébalo con `systemctl show -p ProtectHome,BindPaths,ReadWritePaths relay-manager`.

**Comprobar.** Sistema → Salud («Carpeta de archivos») dice si existe, si el servicio puede escribir y el espacio libre. `sudo relay-manager doctor` lo comprueba desde fuera del servicio: si la carpeta está en `/home`, no puede entrar (las carpetas personales de Ubuntu son `0750`) y lo muestra como `[INFO]`, que es lo esperado.

**Seguridad.** Cualquier usuario con sesión puede leer, subir y borrar en la carpeta (el borrado se puede limitar a administradores con `RM_FILES_DELETE=admins`); todo queda en la auditoría. La web nunca da acceso a nada fuera de la carpeta: rechaza `..` y rutas absolutas, y no sigue enlaces simbólicos que salgan de ella. Aun así, no uses como carpeta de Archivos una carpeta con información que no deba ver cualquier usuario del banco, y deja la escritura directa en ella (por SSH) solo a usuarios de confianza.

---

## 17. Red de equipos: switch y adaptador USB

Todos los equipos tienen la misma IP en su Ethernet (por ejemplo 192.168.1.10). Esa «IP de los equipos» no tiene valor por defecto: se configura en Sistema › Red de equipos, o la trae el perfil del proyecto (`RM_EQUIPNET_EQUIPMENT_IP`, apartado [20](#20-perfil-del-proyecto)). La red de equipos deja llegar a cada uno por separado desde su acceso Ethernet: cada equipo va a su propio puerto de un switch TP-Link Easy Smart, cada puerto es una VLAN, y el servidor tiene una interfaz por puerto en la tarjeta que un administrador elige (normalmente un adaptador USB-Ethernet dedicado). La aplicación no cambia ni busca nada en la red del servidor hasta que se elige esa tarjeta, y después solo cambia esa. El uso está en el apartado 3.12 de [OPERACION.md](OPERACION.md#312-red-de-equipos). Es opcional: sin ella todo lo demás funciona igual.

### 17.1 Conexiones

```
  red del laboratorio ── tarjeta del laboratorio (enp3s0)  ┐
                                                           ├─ servidor del banco
  switch puerto 1 ────── adaptador USB-Ethernet (ETH-01)   ┘
  switch puertos 2..8 ── Ethernet de cada equipo (uno por puerto)
```

- La tarjeta del laboratorio sigue como siempre: la aplicación **nunca** la toca, ni la ruta por defecto ni la tabla de rutas principal.
- Un adaptador **USB**-Ethernet dedicado (por ejemplo ASIX AX88179) al **puerto 1** del switch. No le configures ninguna dirección de otra red. En Sistema › Red de equipos se elige de la lista de tarjetas (paso 1): la de la ruta por defecto no se puede elegir nunca, y una con direcciones de otra red o que no es USB solo con una confirmación expresa.
- La Ethernet de cada equipo a un puerto del 2 al 8 (el número se elige después en cada equipo).
- El switch tiene su gestión en `192.168.0.1` de fábrica (en el banco de desarrollo estaba en `192.168.0.99`), usuario y contraseña `admin`. Al elegir la tarjeta, la aplicación le añade la dirección `192.168.0.250/24` para hablar con él (configurable; si la tarjeta ya tiene una dirección en esa red y ninguna otra tarjeta está en ella, usa esa y no añade nada), y «Buscar el switch» lo busca en esa red **solo por esa tarjeta**; también puedes escribir su IP. Ninguna dirección del servidor puede ser la IP del switch: si la tarjeta tiene 192.168.0.99 (la del switch), la aplicación lo dice con la orden para quitarla. No hace falta cambiar nada en el switch antes: «Preparar switch» activa la VLAN 802.1Q y lo configura.

### 17.2 Qué hace en el servidor

Por cada puerto de equipo `n` crea una interfaz VLAN `rmv<100+n>` (`rmv102` … `rmv108`) sobre la tarjeta elegida, con la dirección `192.168.1.<200+n>/24` (o la siguiente libre si el servidor ya tiene esa en otra tarjeta) sin ruta de red (`noprefixroute`), una tabla de rutas propia (`20000 + VLAN`) con solo `192.168.1.0/24 dev rmv<VLAN>` y `unreachable default` (si falta la primera, falla en vez de salir por otra tarjeta) y una regla «lo que sale de esa dirección usa esa tabla», con preferencia `1000 + VLAN`. La dirección de gestión (`192.168.0.250`) va igual, con la tabla 20000 y la preferencia 1000. Así la tabla principal no cambia y el resto del tráfico del servidor no se ve afectado. Todo se comprueba y se repara solo al arrancar, cada 15 s y al conectar el adaptador, y se verifica con `ip route get`; al desactivar la red de equipos se quitan las VLAN, y con «Dejar de usar» también la dirección de gestión.

Lo hace con la orden `ip` (paquete `iproute2`), sin shell, y solo acepta órdenes sobre las interfaces `rmv*`, la tarjeta elegida y sus tablas 20000 a 24094; cualquier orden que nombre otra tarjeta se rechaza. El reenvío de cada acceso sale con la dirección de su VLAN; si esa dirección ya no está, la conexión falla («La VLAN del puerto N no está lista…») en vez de salir por otra tarjeta.

### 17.3 Permisos

Cambiar la red necesita la capacidad `CAP_NET_ADMIN`:

- **Servicio (systemd):** la unidad ya la tiene (`AmbientCapabilities=CAP_NET_ADMIN` y `CapabilityBoundingSet=CAP_NET_ADMIN`; el resto del aislamiento no cambia). `ip` la hereda del servicio; a `hw_server` se le quita al lanzarlo (`setpriv`). Si no quieres darla, quita esas dos líneas con `sudo systemctl edit relay-manager` (`AmbientCapabilities=` y `CapabilityBoundingSet=` vacíos): solo deja de funcionar la preparación automática del servidor.
- **Docker:** `compose.yaml` ya tiene `cap_add: [NET_ADMIN, SETUID, SETGID, KILL]` con `network_mode: host` (apartado [10.3](#103-por-qué-está-configurado-así)). La imagen incluye `iproute2`.
- **Modo portátil y desarrollo:** el programa corre con tu usuario, sin esa capacidad. Sistema › Red de equipos muestra «Sin permiso para cambiar la red» y las órdenes `sudo ip …` que faltan, con un botón para copiarlas; ejecútalas como root y pulsa «Comprobar ahora». Con `RM_NET_HOST=off` la aplicación no intenta nunca cambiar la red y solo muestra esas órdenes.

«Buscar el switch» solo sale por una dirección de la tarjeta elegida (nunca por la red del laboratorio). Sin permiso, esa dirección no se puede añadir: escribe la IP del switch y pulsa «Probar esta IP», o ejecuta las órdenes pendientes que muestra la página.

### 17.4 NetworkManager

Si NetworkManager gestiona el adaptador USB, puede quitarle las direcciones (por ejemplo al fallar su DHCP). La forma menos invasiva de evitarlo es un fichero de configuración que solo excluye esas interfaces:

- `install.sh` instala `/etc/NetworkManager/conf.d/90-relay-manager-red-equipos.conf` con `unmanaged-devices=interface-name:rmv*` (si NetworkManager está instalado) y recarga su configuración sin reiniciarlo.
- La columna «NetworkManager» del paso 1 dice cómo ve NetworkManager cada tarjeta (con `nmcli`, solo lectura; «-» si no se sabe).
- Para excluir también el adaptador elegido (Sistema › Red de equipos lo pide con su MAC):

  ```bash
  sudo relay-manager red-equipos 08:be:ac:38:82:ce     # añade mac:<MAC> al fichero y recarga NetworkManager
  sudo relay-manager red-equipos --quitar             # vuelve a dejar solo las interfaces rmv*
  ```

  o, al instalar, `sudo ./install.sh --red-equipos-mac 08:be:ac:38:82:ce`.
- Con systemd-networkd o netplan no hace falta nada: no tocan interfaces que no están en su configuración.

### 17.5 Si algo falla

| Síntoma | Causa probable | Solución |
|---|---|---|
| «Buscar el switch» no lo encuentra | La tarjeta elegida no es la del puerto 1 o no tiene enlace, el servicio no tiene permiso para poner su dirección, o el switch no está en `192.168.0.0/24` | Comprueba el cable al puerto 1 y la tarjeta del paso 1. Escribe la IP del switch y pulsa «Probar esta IP». Si la gestión del switch está en otra red, cambia «Dirección del servidor para la gestión del switch» en «Direcciones». |
| «La IP del switch (192.168.0.99) la tiene este servidor en …» | Una tarjeta del servidor tiene la misma dirección que el switch (configurada a mano o por NetworkManager) | Quítala con la orden que da el mensaje (`sudo ip addr del 192.168.0.99/24 dev <tarjeta>`) y, si vuelve, revisa la conexión de NetworkManager de esa tarjeta. |
| «La dirección de gestión 192.168.0.250 ya la tiene …» | Resto de una versión anterior, u otra tarjeta con esa dirección | «Quitar restos» o apartado [17.7](#177-actualizar-desde-la-versión-anterior-restos-en-otra-tarjeta); o cambia la dirección de gestión en «Direcciones». |
| «La VLAN N no pasa la comprobación: … saldría por …» | Otra regla de enrutamiento del servidor (VPN…) se adelanta a la de la aplicación | `ip rule` muestra cuál; quítala o dale una preferencia mayor que 5094. |
| Aviso «La red de los equipos (192.168.1.0/24) también está en …» | Otra tarjeta del servidor está en esa red | Nada que hacer; para el ARP, apartado [17.6](#176-otra-tarjeta-del-servidor-en-1921681x). |
| «El switch no acepta el usuario o la contraseña» | La contraseña del switch no es `admin` | Escríbela en el diálogo o en Sistema › Red de equipos. |
| «Sin permiso para cambiar la red» | Falta `CAP_NET_ADMIN` | Apartado [17.3](#173-permisos). |
| «Este servidor está conectado al puerto N del switch, no al 1» | El cable del adaptador está en otro puerto | Muévelo al puerto 1 (o cambia «Puerto de este servidor (subida)»). La aplicación no aplica nada hasta que coincidan. |
| «El switch no coincide con lo que configuró la aplicación» | Alguien lo cambió a mano, o se apagó antes de guardar | Pulsa «Configurar el switch»: la vista previa enseña qué se corrige. |
| Aviso de que el firmware no deja quitar puertos de la VLAN 1 | Limitación de algunos firmware Easy Smart | Los equipos siguen aislados entre sí; si quieres el aislamiento completo, actualiza el firmware del switch y vuelve a configurarlo. |
| Las VLAN desaparecen del servidor | El adaptador se desconectó, o NetworkManager le quitó las direcciones | Al reconectarlo se preparan solas en unos segundos; para NetworkManager, apartado [17.4](#174-networkmanager). |
| Otro modelo de switch | No es un TP-Link Easy Smart | Tipo de switch «Manual» y sigue las «Instrucciones para configurarlo a mano» de Sistema › Red de equipos. |

### 17.6 Otra tarjeta del servidor en 192.168.1.x

Es habitual que el PC del banco ya tenga, además de la tarjeta del laboratorio (por ejemplo 172.x, con la ruta por defecto), **otra tarjeta en 192.168.1.0/24**, la misma red que los equipos, e incluso con otro aparato en 192.168.1.10 detrás. Funciona igual y no hay que cambiar la IP de los equipos:

```
  red del laboratorio (172.x) ── enp3s0 (ruta por defecto)      ┐
  otra red 192.168.1.x ───────── enp4s0 (p. ej. 192.168.1.5)     ├─ PC del banco
  switch puerto 1 (192.168.0.99) ─ adaptador USB (ETH-01)        ┘
  switch puertos 2..8 ── equipos, todos 192.168.1.10
```

- En el paso 1 eliges el adaptador USB. `enp3s0` no se puede elegir (ruta por defecto); `enp4s0` solo con una confirmación expresa, porque ya está en otra red.
- La aplicación llega a cada equipo **solo** por su VLAN: cada `rmv<VLAN>` tiene su propia dirección, sin ruta de red (`noprefixroute`), una tabla propia con `192.168.1.0/24 dev rmv<VLAN>` y `unreachable default`, y la regla «lo que sale de esta dirección usa esta tabla». La tabla principal no cambia: lo que el servidor manda a 192.168.1.10 por su cuenta (sin la dirección de una VLAN) sigue saliendo por `enp4s0`, como antes.
- Las direcciones de las VLAN nunca son una que el servidor ya tenga en otra tarjeta: si `enp4s0` tiene 192.168.1.203, el puerto 3 usa la siguiente libre después de la del último puerto (192.168.1.209).
- Al guardar sale un **aviso**, no un error: «La red de los equipos (192.168.1.0/24) también está en enp4s0 (192.168.1.5/24). Funciona igual…». Queda en Sistema › Red de equipos («Avisos») y en Salud («Redes repetidas en el servidor»).
- **ARP.** Linux, por defecto (`arp_ignore=0`), contesta a una pregunta ARP por cualquiera de sus direcciones en cualquier tarjeta. Si otro aparato de la red de `enp4s0` preguntara por 192.168.1.202 (la dirección de la VLAN del puerto 2), el servidor le contestaría por `enp4s0`. Los accesos funcionan igual, pero ese aparato se confundiría. Para evitarlo, instala con la opción `--red-equipos-arp-estricto`: escribe `/etc/sysctl.d/60-relay-manager.conf` con `net.ipv4.conf.all.arp_ignore = 1` (solo contesta por la tarjeta que tiene la dirección preguntada) y `net.ipv4.conf.all.arp_announce = 2` (en sus preguntas ARP usa una dirección de la misma tarjeta) y lo aplica al momento. En un servidor normal no cambia nada más. Se conserva al actualizar y se borra al desinstalar (los valores siguen hasta reiniciar; para volver ya a los de Linux: `sudo sysctl -w net.ipv4.conf.all.arp_ignore=0 net.ipv4.conf.all.arp_announce=0`). El servicio nunca escribe en `/proc/sys`; solo el instalador, como root, y solo con esa opción. `doctor` y Salud («ARP con redes repetidas») avisan si hace falta.
- Con `rp_filter` estricto (`net.ipv4.conf.all.rp_filter=1`, el de Ubuntu es 2) también funciona: la comprobación del origen de las respuestas usa la misma regla por dirección.
- Las reglas de la aplicación tienen preferencia 1000 (gestión) y 1000 + VLAN (1002 a 5094): antes que la tabla principal (32766) y que las reglas que suelen añadir otros programas (Tailscale 5210 a 5270, WireGuard o NetworkManager justo por debajo de la primera regla que haya). Solo afectan a paquetes que salen de las direcciones propias de la aplicación. Aun así, cada 15 s la aplicación comprueba con `ip route get 192.168.1.10 from <dirección de la VLAN>` que el núcleo usa de verdad la VLAN; si otra regla se adelanta, esa VLAN deja de estar lista y lo dice.

### 17.7 Actualizar desde la versión anterior (restos en otra tarjeta)

Las versiones anteriores buscaban el switch solas en el primer adaptador USB libre con enlace y le ponían la dirección `192.168.0.250/24` (con la regla de preferencia 20000 y la tabla 20000), aunque no fuera el del switch. La versión actual no vuelve a hacerlo, y lo que quedó se muestra en Sistema › Red de equipos, «Restos de una versión anterior», con las órdenes exactas y el botón **«Quitar restos»**; nunca se quita solo. Si prefieres hacerlo a mano en el PC del banco:

```bash
ip -br addr                                            # ¿alguna tarjeta con 192.168.0.250/24 que no deba tenerla?
ip rule                                                # reglas de la aplicación: tabla 20000..24094
ip route show table all | grep -E 'table 2[0-4][0-9]{3}'
ip -d link show | grep rmv                             # interfaces VLAN de la aplicación

sudo ip addr del 192.168.0.250/24 dev <interfaz>
sudo ip rule del pref 20000 from 192.168.0.250/32 lookup 20000
sudo ip route flush table 20000
# y, solo si no hay interfaz elegida: cada regla de preferencia 20000-24094 o 1000-5094 cuya tabla sea
# 20000-24094 (sudo ip rule del pref <pref> lookup <tabla>), sus tablas (sudo ip route flush table 20102 …)
# y cada interfaz rmv* (sudo ip link del rmv102 …)
```

Después elige la interfaz del switch (paso 1). Las reglas de la versión anterior en la interfaz elegida (preferencia = tabla) se cambian solas a las nuevas.

---

## 18. Copiar a una carpeta del servidor: el ayudante de root

En **Archivos**, los administradores pueden copiar ficheros de la carpeta a cualquier carpeta permitida del propio servidor del banco, sobre todo a un **pendrive** ([OPERACION.md](OPERACION.md#29-archivos-intercambiar-ficheros-con-el-servidor)). Si el servicio puede escribir en el destino, copia él. Si no (lo normal en un pendrive que monta el escritorio), el diálogo ofrece **«Copiar como administrador (sudo)»**: como un `sudo cp`, con la **contraseña del usuario que instaló la aplicación**. No se pregunta ningún nombre de usuario. Con la misma contraseña se ven carpetas que el servicio no puede leer y se **montan y expulsan pendrives** (apartado [18.5](#185-montar-y-expulsar-pendrives)); después, la sesión del navegador no la vuelve a pedir durante 5 minutos.

### 18.1 Qué instala `install.sh`

- `relay-manager-rootcopy.socket`: el socket `/run/relay-manager-rootcopy/rootcopy.sock`, `root:relay-manager` 0660, habilitado al arranque. Solo el usuario del servicio puede conectar.
- `relay-manager-rootcopy.service`: el ayudante (`/opt/relay-manager/current/app/rootcopy.js` con el Node incluido). systemd lo arranca con la primera conexión y se cierra solo tras 2 minutos sin uso.
- `/etc/relay-manager/rootcopy.env` (root:root, 0644): la configuración del ayudante, que `install.sh` genera desde `config.env` en cada ejecución: `RM_SUDO_USER`, `RM_COPY_SUDO_GROUPS`, `RM_COPY_ROOT_PATHS` y, si están, `RM_COPY_ROOTS`, `RM_COPY_DENY` y `RM_COPY_ENABLED`. No lo edites: cambia `config.env` y vuelve a ejecutar `sudo /opt/relay-manager/current/install.sh --yes`.
- `relay-manager-rootcopy.service.d/rutas.conf`: solo si `RM_COPY_ROOT_PATHS` tiene carpetas además de `/media`, `/run/media` y `/mnt`.
- `relay-manager-rootmount.socket` y `relay-manager-rootmount.service`: el ayudante de montaje (el mismo `app/rootcopy.js`, con el argumento `mount`), socket `/run/relay-manager-rootmount/rootmount.sock` `root:root` 0600. Lee el mismo `rootcopy.env`.
- En la unidad del servicio, `ReadWritePaths=-/media -/run/media -/mnt`: el servicio puede escribir ahí **si los permisos se lo permiten** (el `-` ignora las carpetas que no existen).

**El usuario con sudo.** `install.sh` guarda como `RM_SUDO_USER` el usuario que lo ejecuta con `sudo` (variable `SUDO_USER`, el mismo que es dueño de `~/tftp`); si lo ejecutas directamente como root, `root`. Al actualizar se conserva. Para cambiarlo:

```bash
sudo /opt/relay-manager/current/install.sh --sudo-user ana --yes
```

Tiene que ser root o estar en uno de los grupos `sudo`, `wheel` o `admin` (`RM_COPY_SUDO_GROUPS`), con contraseña y sin la cuenta bloqueada. Si no, el instalador avisa («Copia como administrador (sudo): … Arréglalo con sudo ./install.sh --sudo-user <usuario con sudo>») y la web explica por qué no está disponible. Solo se usan las cuentas locales de `/etc/passwd`, `/etc/group` y `/etc/shadow` (no LDAP ni otros servicios de NSS).

### 18.2 Seguridad

- **El servicio no pasa nunca a root.** Sigue con `NoNewPrivileges` y todo su aislamiento; lo único nuevo es que puede escribir en `/media`, `/run/media` y `/mnt` cuando los permisos se lo permiten.
- **El ayudante es otra unidad**, con lo mínimo: las capacidades `CAP_DAC_OVERRIDE`, `CAP_DAC_READ_SEARCH`, `CAP_CHOWN` y `CAP_FOWNER`, sin red (`PrivateNetwork`, solo sockets Unix), todo el sistema en solo lectura salvo `/media`, `/run/media`, `/mnt` y lo que añada `rutas.conf`, `/home` en solo lectura, filtro de llamadas al sistema y `NoNewPrivileges`. No usa `MemoryDenyWriteExecute` porque rompe el JIT de Node.
- **Cada operación pide la contraseña** de `RM_SUDO_USER`, y el ayudante la comprueba él mismo contra `/etc/shadow` con el `crypt(3)` del sistema (yescrypt, sha512, sha256 o bcrypt), a través de `python3` o, si no hay, `perl`, pasándola por la entrada estándar. La cuenta sale de su propia configuración (de root), nunca de lo que le diga el servicio. 5 contraseñas incorrectas en 10 minutos bloquean la copia como administrador 10 minutos. La contraseña no se guarda, no se registra y no aparece en la auditoría.
- **El ayudante no lee ningún fichero de origen**: el servicio lee el fichero de la carpeta de Archivos (con sus propios permisos) y le envía los bytes; el ayudante solo los escribe.
- **El destino se vuelve a comprobar como root**: su ruta real, la lista de carpetas prohibidas (las del sistema y las de la aplicación) y que esté dentro de `RM_COPY_ROOT_PATHS`; se abre sin seguir enlaces simbólicos. Se escribe en un temporal oculto (`.rm-copy-….part`), se verifica con sha256 y se renombra. El fichero queda del **dueño de la carpeta de destino** (el usuario del escritorio, en un pendrive), con permisos `rw-r--r--` (0644).
- Montar y expulsar los hace **otro ayudante** con todavía menos (apartado [18.5](#185-montar-y-expulsar-pendrives)).
- **Permisos de 5 minutos.** Con la contraseña correcta, el ayudante devuelve un permiso firmado (HMAC-SHA256 con una clave suya, `token.key` en su estado, 0600) que caduca a los 5 minutos y va ligado a esa sesión de la web y a ese usuario de la web. El servicio lo guarda en memoria y lo presenta en las siguientes operaciones de esa sesión; **nunca llega al navegador**. «Olvidar permisos» lo anula también en el ayudante. Un permiso caducado, anulado, falsificado o de otra sesión se rechaza y la web vuelve a pedir la contraseña; no cuenta como intento fallido.
- **Ver como administrador.** Con la contraseña (o el permiso) el ayudante lista cualquier carpeta de `RM_COPY_ROOTS` salvo `/proc`, `/sys`, `/dev` y los estados de los ayudantes: solo nombres, tamaños y fechas. Nunca abre un fichero para leerlo. Escribir sigue limitado a `RM_COPY_ROOT_PATHS` y a la lista prohibida.

Más detalle en [ARQUITECTURA.md](ARQUITECTURA.md) (apartado 9.5 y decisión D44).

### 18.3 Comprobar

`sudo relay-manager doctor` y Sistema → Salud tienen la comprobación **«Copia como administrador (sudo)»**: `[ OK ] Ayudante listo: contraseña de <usuario> (sudo); escribe en /media, /run/media, /mnt`, o un aviso con el motivo y la orden para arreglarlo (el socket no responde, la cuenta no tiene sudo o no tiene contraseña, no hay `python3` ni `perl`). En modo portátil, desarrollo y Docker sale como `[INFO]`: ahí no hay ayudante.

```bash
systemctl status relay-manager-rootcopy.socket           # debe estar «active (listening)»
ls -l /run/relay-manager-rootcopy/rootcopy.sock          # srw-rw---- root relay-manager
journalctl -u relay-manager-rootcopy -n 20               # qué hizo el ayudante (sin contraseñas)
sudo systemctl enable --now relay-manager-rootcopy.socket   # si no está activo
```

Si se bloquea por contraseñas incorrectas y no quieres esperar los 10 minutos: `sudo rm /var/lib/relay-manager-rootcopy/intentos.json`.

Para anular de golpe todos los permisos de 5 minutos que estén vivos (por ejemplo, tras cambiar la contraseña de sudo): `sudo rm /var/lib/relay-manager-rootcopy/token.key` (se genera otra en el siguiente uso).

### 18.4 Debian 12 (bookworm)

- glibc 2.36 y núcleo 6.1: el paquete funciona sin cambios (el instalador exige glibc 2.29 o superior).
- Las contraseñas de `/etc/shadow` son **yescrypt** (`$y$`); el ayudante las comprueba con el `crypt(3)` del sistema (`libcrypt.so.1`), igual que `sudo`. `python3` viene instalado y `perl-base` siempre está.
- El escritorio monta los pendrives en `/media/<usuario>/<etiqueta>`, con el usuario del escritorio como dueño y la carpeta `/media/<usuario>` solo para él. En FAT, exFAT y NTFS los permisos los decide el montaje, así que **ningún otro usuario puede escribir**, tampoco el servicio: en un pendrive, usa **«Copiar como administrador (sudo)»**. El fichero copiado queda del usuario del escritorio, que lo puede usar con normalidad.
- **Sin escritorio** (o sin sesión gráfica abierta, lo normal en el PC del banco), nadie monta el pendrive: «solo se monta con sudo». Desde la 2.4 se monta desde la propia web: **«Montar»** en el diálogo (apartado [18.5](#185-montar-y-expulsar-pendrives)).
- Si al instalar Debian le diste contraseña a root, root puede autenticar, pero la aplicación usa siempre `RM_SUDO_USER` (quien ejecutó `sudo ./install.sh`). Si root no tiene contraseña (en Ubuntu siempre está bloqueada), el mensaje es «La cuenta root no tiene contraseña (lo normal en Debian y Ubuntu, que usan sudo)…»: instala con `sudo` desde tu usuario o usa `--sudo-user`.
- Si tu usuario aún no está en el grupo `sudo` (Debian no lo añade si root tiene contraseña): `su -c 'usermod -aG sudo <usuario>'`, cierra la sesión y vuelve a entrar.
- Si en ese equipo no hay `sudo` y se instala como root (`su -c ./install.sh`), no hay `SUDO_USER`: `RM_SUDO_USER` queda en `root` y el diálogo pide la contraseña de root (válida si root la tiene). Para usar la de tu usuario: `su -c './install.sh --sudo-user <usuario>'` con ese usuario en el grupo `sudo`.
- systemd 252 (el de bookworm) no conoce `RestartSteps=` ni `RestartMaxDelaySec=` de la unidad del servicio: las ignora con un aviso y reinicia siempre a los 3 s (`RestartSec=`), sin la espera creciente. `udevadm verify` tampoco existe (llega con systemd 253). Todo lo demás, incluido el aislamiento del ayudante (`ProtectProc=`, `ProcSubset=`, `SystemCallFilter=`), funciona igual; las pruebas del paquete instalan, actualizan, copian como administrador (yescrypt, sha512 y sha256) y desinstalan en Debian 12 con systemd.

### 18.5 Montar y expulsar pendrives

En el PC del banco (Debian 12 sin escritorio, o sin nadie con la sesión gráfica abierta) un pendrive conectado no se monta solo: hace falta `sudo mount`. El diálogo «Copiar a una carpeta del servidor» lo hace desde la web: en **Unidades USB y discos** lista los dispositivos extraíbles **sin montar** con **«Montar»**, y los montados en `/media` con **«Expulsar»**, con la misma contraseña de `RM_SUDO_USER` (o el permiso de 5 minutos de la sesión).

**Cómo funciona.**

1. El servicio lista los dispositivos sin privilegios: `/sys/block` (el disco, si es extraíble o cuelga de USB, sus particiones, tamaño y modelo) y la base de datos de udev (`/run/udev/data`, `/dev/disk/by-label`, `by-uuid`) para la etiqueta y el sistema de ficheros.
2. «Montar» → el ayudante de copia (`relay-manager-rootcopy`) comprueba la contraseña o el permiso y pasa la petición al **ayudante de montaje** (`relay-manager-rootmount`), que lo vuelve a comprobar todo por su cuenta:
   - el dispositivo tiene que ser `/dev/sdX[N]`, `/dev/mmcblkNpM` o `/dev/nvmeNnMpK`, **extraíble o USB**, sin `holders` (LVM, RAID, cifrado), sin nada de ese disco montado fuera de `/media`, `/run/media` o `/mnt` ni usado como *swap* (así nunca el disco del sistema: `/`, `/boot`, `/var`, `/home`…), no montado ya; un disco con particiones no se monta entero;
   - lee el sistema de ficheros con `blkid -p` y monta con `mount` en `/media/<RM_SUDO_USER>/<etiqueta>` (o su UUID; `-2`, `-3`… si ya existe), siempre con `nosuid,nodev,noexec`;
   - **FAT, exFAT y NTFS** (lo normal en un pendrive): `uid=<usuario con sudo>,gid=relay-files,umask=0002,dmask=0002,fmask=0113`. El usuario del escritorio y el servicio (grupo `relay-files`) pueden escribir; los ficheros quedan `rw-rw-r--`. NTFS se monta solo con el controlador del núcleo `ntfs3` (Debian 12 y Ubuntu 24.04 lo traen); nunca con ntfs-3g ni exfat-fuse (`mount -i`): un proceso FUSE viviría en la unidad del ayudante y moriría con ella al cerrarse.
   - **ext4, xfs, f2fs** (btrfs no: un clon del disco del sistema podría asomar el sistema bajo `/media`): con sus propios permisos (normalmente solo root escribe en la raíz): se copia «como administrador». ISO 9660 y UDF, en solo lectura.
3. «Expulsar» → `sync`, `umount` (si está en uso, lo dice y no fuerza nada) y borra la carpeta vacía de `/media`. Solo lo montado bajo `/media` o `/run/media` de un dispositivo extraíble.

Si `/media/<usuario>` no existe, se crea (0755 root). Si existe y es solo para ese usuario (como la deja el escritorio, 0750 con ACL), el ayudante añade una ACL de lectura para el grupo `relay-files` si `setfacl` (paquete `acl`) está instalado; si no, el servicio no llega al pendrive y se copia «como administrador».

**Por qué otro ayudante, y sin aislamiento de montaje.** El ayudante de copia corre con `ProtectSystem=strict` y el resto de su aislamiento: eso le da su **propio espacio de montaje**, y lo que se montara dentro no se vería nunca fuera (ni en el sistema ni en el servicio). `MountFlags=shared` no lo arregla: con cualquier otra opción de aislamiento de ficheros, systemd ya ha cortado la propagación hacia el sistema. Además, con `CAP_SYS_ADMIN` dentro de ese espacio se podría volver a montar en escritura lo que `ProtectSystem` deja en solo lectura: el límite duro del ayudante de copia dejaría de serlo. Por eso montar lo hace una unidad aparte, `relay-manager-rootmount`, **sin espacio de montaje propio** (sin `ProtectSystem`, `PrivateTmp`, `PrivateDevices`…) y a cambio con lo mínimo:

- solo la capacidad `CAP_SYS_ADMIN` (montar), sin capacidades ambientales, `NoNewPrivileges`;
- `DevicePolicy=closed` con `DeviceAllow=block-sd rw`, `block-mmc rw` y `block-blkext rw` (pendrives, tarjetas SD y NVMe por USB): ningún otro dispositivo;
- sin red (`RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`), filtro de llamadas al sistema `@system-service @mount` sin `@swap`, `@reboot`, `@raw-io`, `@module`, `@debug`…;
- socket `/run/relay-manager-rootmount/rootmount.sock` **`root:root` 0600**: ni el servicio ni los usuarios llegan a él; solo el ayudante de copia, después de comprobar la contraseña o el permiso;
- activado por socket y se cierra solo tras 2 minutos sin uso; su estado (las carpetas que ha creado) en `/var/lib/relay-manager-rootmount` (0700).

Los montajes se hacen en el espacio de montaje del sistema, así que `findmnt`, el escritorio y el servicio los ven al momento (el servicio recibe los montajes nuevos bajo `/media` porque systemd hace su espacio de montaje esclavo del sistema). Eso necesita que `/` tenga propagación compartida, que es lo que deja systemd al arrancar (`findmnt -n -o PROPAGATION /` dice `shared`). Dentro de un contenedor Docker no lo es (`private`): allí, `mount --make-rshared /` antes de arrancar los servicios (las pruebas del paquete lo hacen).

**Comprobar.**

```bash
systemctl status relay-manager-rootmount.socket                # «active (listening)»
ls -l /run/relay-manager-rootmount/rootmount.sock              # srw------- root root
journalctl -u relay-manager-rootmount -n 20                    # qué montó y desmontó
findmnt /media/<usuario>/<etiqueta>                            # opciones del montaje
```

Las pruebas del paquete montan un pendrive simulado (una imagen FAT en un dispositivo *loop*, con un interruptor solo de pruebas), copian como administrador y como el servicio, y lo expulsan, en Ubuntu 24.04 y Debian 12 con systemd.

---

## 19. Descargas (script de descarga del perfil)

Con **Descargas**, cualquier usuario con sesión ejecuta en el servidor un script del perfil que descarga una aplicación (por ejemplo, de un repositorio de artefactos) y la deja como `.zip` en una carpeta de Archivos ([OPERACION.md](OPERACION.md#29-archivos-intercambiar-ficheros-con-el-servidor)). **Está desactivada por defecto** y el paquete no trae ningún script: la activa el perfil del proyecto (apartado [20](#20-perfil-del-proyecto)):

```
RM_EXPORT_ENABLED=1
RM_EXPORT_DOWNLOADER=herramientas/descarga.sh     # relativa a la carpeta del perfil
RM_EXPORT_ROOT=extra                              # el zip queda en la segunda carpeta (o tftp)
RM_EXPORT_NAME=Descargas                          # y, si quieres, TITLE, DESCRIPTION y las etiquetas
```

Activada sin script (o con un script que no existe), Salud y `doctor` lo marcan como fallo. Los textos del botón, del diálogo y de los campos salen de `RM_EXPORT_TITLE`, `RM_EXPORT_DESCRIPTION`, `RM_EXPORT_APP_LABEL`, `RM_EXPORT_VERSION_LABEL` y `RM_EXPORT_EXTRACT_LABEL` (apartado [14](#14-referencia-de-configuración)).

**Contrato del script.** Se ejecuta así:

```bash
bash <script> <aplicación> <versión> -o <salida.zip> [-x]
```

- `<aplicación>` y `<versión>`: lo que escribe el usuario; solo letras, números y `. _ + -`, sin `-` ni `.` al principio;
- `-o <salida.zip>`: dónde debe dejar el zip (dentro de su carpeta de trabajo);
- `-x`: solo si el usuario marca la casilla opcional (existe si el perfil define `RM_EXPORT_EXTRACT_LABEL`); qué significa lo decide el script;
- salida 0 = bien (el zip tiene que existir); cualquier otro código = error. Lo que escribe en la salida estándar y de error se ve en directo en la web.

**Requisitos en el servidor.** `bash` y `setpriv` (siempre están en Ubuntu y Debian). Lo demás (por ejemplo `curl`, `zip` o `python3`) depende del script: **el script debe traer o comprobar sus propias dependencias** y el README del perfil, listarlas. Sistema → Salud y `doctor` tienen la comprobación con el nombre de `RM_EXPORT_NAME` («Descargas»): informativa si está desactivada; si está activada, que el script existe y se puede leer, que están `bash` y `setpriv` y, solo si `RM_EXPORT_URL` tiene valor, si esa dirección responde (HEAD, 3 s). Todo son avisos, nunca un fallo del servicio.

**Red.** Si el script descarga de otro servidor, el equipo del banco tiene que llegar a él. La unidad del servicio no limita las conexiones salientes (`RestrictAddressFamilies` incluye IPv4 e IPv6 y no hay `IPAddressDeny`), así que no hay nada que abrir en systemd; solo el cortafuegos del laboratorio, si lo hay. `RM_EXPORT_URL`, si tiene valor, se pasa al script en su entorno (como `EXPORT_URL` o el nombre de `RM_EXPORT_ENV_URL`).

**Credenciales.** `RM_EXPORT_USER` y `RM_EXPORT_PASSWORD`, si tienen valor, se pasan al script como `EXPORT_USER` y `EXPORT_PASSWORD` (o con los nombres que fije el perfil en `RM_EXPORT_ENV_USER` y `RM_EXPORT_ENV_PASSWORD`). Ponlas en `/etc/relay-manager/config.env` (root:relay-manager 0640: solo root y el servicio lo leen), no en el perfil. La contraseña nunca llega al navegador y se tacha (`********`) del registro que se ve en la web. Un script que escriba credenciales dentro de sí mismo o las pase en la línea de órdenes las deja a la vista de quien lea el perfil o mire `ps`: evítalo.

**Cómo se ejecuta.** Una descarga a la vez en el servidor (cola de 10, 3 por usuario), como el usuario del servicio, con `bash` y los argumentos como lista (sin intérprete de órdenes en medio), **sin las capacidades del servicio** (`setpriv` le quita `CAP_NET_ADMIN`), en una carpeta de trabajo propia `/var/lib/relay-manager/descargas/<id>` (0700, solo del servicio; nunca dentro de una carpeta compartida, cuyo dueño podría cambiarla por un enlace mientras el script trabaja) que es también su directorio actual, su `HOME` y su `TMPDIR`, con un entorno mínimo (`PATH` del sistema, idioma, `CI=true`, las variables fijas de `RM_EXPORT_ENV_EXTRA` y, si tienen valor, las credenciales y la URL; nada más de la configuración del servicio). Cancelar o pasar de `RM_EXPORT_TIMEOUT_MIN` (60 min) termina el script y todo lo que haya lanzado (el grupo de procesos entero). Al terminar bien, el zip se copia (abierto sin seguir enlaces) a la carpeta elegida de `RM_EXPORT_ROOT` sin sobrescribir nada (`nombre (1).zip`), con permisos 664 y el grupo `relay-files`, y la carpeta de trabajo se borra. Se audita como `files.export` (quién, aplicación, versión, resultado, zip).

---

## 20. Perfil del proyecto

El programa es genérico. Lo propio de cada proyecto va en un **perfil**: una carpeta que vive **fuera** del repositorio y del paquete, y que se instala junto al programa. Sin perfil, todo funciona con valores genéricos (nombre «Relay Manager», sin plantillas, sin segunda carpeta, sin Descargas).

```
<perfil>/
  perfil.env          valores por defecto del proyecto (solo las variables de la tabla de abajo)
  plantillas/*.json   una plantilla de equipo por fichero
  herramientas/       scripts del proyecto (por ejemplo, el de Descargas), citados desde perfil.env
  manuales/           opcional: fuentes de los manuales del proyecto (la aplicación no los usa)
  README.md           opcional: qué es, qué necesita el script, etc.
```

Cómo escribir uno (formato de las plantillas, su esquema JSON `docs/plantilla.schema.json`, errores y ejemplos): [PERFIL.md](PERFIL.md). El repositorio trae un perfil de ejemplo genérico en `examples/perfil-ejemplo/`.

### 20.1 Dónde está

`RM_PROFILE_DIR` (solo en el entorno del proceso o en `config.env`, nunca en `perfil.env`):

| Instalación | Carpeta por defecto |
|---|---|
| Servicio | `/etc/relay-manager/perfil` |
| Portátil | `<carpeta del paquete>/perfil` |
| Docker | `/perfil`, montada en solo lectura desde `RM_PROFILE_HOST_DIR` del anfitrión (por defecto `./perfil`, junto a `compose.yaml`; apartado [10.2](#102-cargar-la-imagen-y-arrancar)) |
| Desarrollo | `<repositorio>/perfil` (git la ignora: la configuración de un proyecto nunca se sube) |

Si la carpeta no existe, no hay perfil: valores genéricos, y la comprobación «Perfil» de Salud y `doctor` lo dice como información. Si `RM_PROFILE_DIR` está puesta a mano y la carpeta no existe, es un aviso.

### 20.2 Precedencia y variables

De más a menos prioridad: **variables del proceso > `config.env` > `perfil.env` > valores por defecto**. Así el perfil fija los valores del proyecto y el administrador de cada banco puede cambiar cualquiera en su `config.env`.

`perfil.env` solo acepta las variables del perfil; cualquier otra se ignora con el aviso «Variable no permitida en perfil.env: X». Las rutas relativas (`RM_EXPORT_DOWNLOADER`) son relativas a la carpeta del perfil.

| Variable | Qué es | Por defecto |
|---|---|---|
| `RM_LAB_NAME` | nombre del laboratorio, solo al crear los ajustes por primera vez | «Relay Manager» |
| `RM_FILES_EXTRA_NAME` | nombre de la segunda carpeta compartida (raíz `extra`) | sin valor: no hay segunda carpeta |
| `RM_FILES_EXTRA_ENABLED` | `0` la quita | `1` si hay nombre |
| `RM_FILES_EXTRA_DIR` | su carpeta (`~/` = carpeta personal) | servicio `/home/<usuario>/<nombre>` (lo resuelve `install.sh`); portátil y desarrollo `~/<nombre>`; Docker `/extra` |
| `RM_FILES_EXTRA_HINT` | descripción de una línea en el selector de carpetas | «Segunda carpeta compartida (<carpeta>)» |
| `RM_EXPORT_ENABLED` | activa Descargas (apartado [19](#19-descargas-script-de-descarga-del-perfil)) | `0` |
| `RM_EXPORT_DOWNLOADER` | el script (relativo = a la carpeta del perfil) | ninguno |
| `RM_EXPORT_TIMEOUT_MIN` | tiempo máximo de una descarga | `60` |
| `RM_EXPORT_ROOT` | dónde queda el zip: `extra` o `tftp` | `extra` si hay segunda carpeta; si no, `tftp` |
| `RM_EXPORT_NAME` | nombre corto (panel, auditoría, Salud) | «Descargas» |
| `RM_EXPORT_TITLE` | título del botón, del menú y del diálogo | «Ejecutar script de descarga…» |
| `RM_EXPORT_DESCRIPTION` | párrafo del diálogo | una frase genérica |
| `RM_EXPORT_APP_LABEL` / `RM_EXPORT_VERSION_LABEL` | etiquetas de los campos | «Aplicación» / «Versión» |
| `RM_EXPORT_EXTRACT_LABEL` | etiqueta de la casilla `-x` | sin valor: sin casilla |
| `RM_EXPORT_URL` | dirección que se pasa al script (y que comprueba Salud) | sin valor |
| `RM_EXPORT_USER` / `RM_EXPORT_PASSWORD` | credenciales para el script (mejor en `config.env`) | sin valor |
| `RM_EXPORT_ENV_USER` / `RM_EXPORT_ENV_PASSWORD` / `RM_EXPORT_ENV_URL` | nombres con los que el script recibe usuario, contraseña y URL | `EXPORT_USER` / `EXPORT_PASSWORD` / `EXPORT_URL` |
| `RM_EXPORT_ENV_EXTRA` | variables fijas para el script (`NOMBRE=valor …`) | ninguna |
| `RM_EQUIPNET_EQUIPMENT_IP` | «IP de los equipos» inicial de la red de equipos, solo al crearla por primera vez | sin valor: se configura en Sistema › Red de equipos |
| `RM_EQUIPNET_EQUIPMENT_PORT` | puerto por defecto de los accesos Ethernet y de «Enviar a equipo» | `22` |

### 20.3 Instalarlo

**Servicio.** `install.sh --perfil <carpeta>` copia el perfil a `/etc/relay-manager/perfil` (root:relay-manager, ficheros 0640, carpetas 0750, `herramientas/*.sh` 0750); el que hubiera queda como `/etc/relay-manager/perfil.anterior-<fecha>`:

```bash
sudo ./install.sh --perfil /media/usb/perfil-mi-proyecto
```

Sin `--perfil`: si el paquete lleva un `perfil/` y en `/etc/relay-manager/perfil` aún no hay ninguno, se instala ese; si ya hay uno, se conserva (actualizar el programa nunca cambia el perfil). `install.sh` lee además del perfil `RM_FILES_EXTRA_*` para crear la segunda carpeta (apartado [16](#16-archivos-las-carpetas-compartidas)).

**Paquete con el perfil dentro.** En el equipo de desarrollo, `bash scripts/build-bundle.sh --perfil <carpeta>` (o `pnpm bundle -- --perfil <carpeta>`) lo mete en el paquete como `perfil/`. El paquete por defecto no lleva ninguno.

**Portátil.** Copia la carpeta del perfil como `perfil/` dentro de la carpeta del paquete (o define `RM_PROFILE_DIR`).

**Docker.** Pon la carpeta en `RM_PROFILE_HOST_DIR` (apartado [10.2](#102-cargar-la-imagen-y-arrancar)); se monta en `/perfil` en solo lectura.

### 20.4 Plantillas del perfil

Cada `plantillas/*.json` es una plantilla de equipo con una clave estable (`key`). Se sincronizan con la base de datos en cada arranque, con el botón **«Recargar plantillas»** de la página Plantillas (administradores) y con la línea de órdenes:

```bash
sudo relay-manager plantillas comprobar   # solo valida los ficheros, sin tocar la base de datos
sudo relay-manager plantillas recargar    # valida y sincroniza (con el servidor en marcha o parado)
```

Las dos imprimen un informe y terminan con código 1 si algún fichero tiene errores. Las plantillas de fichero se ven en la web con la etiqueta «Fichero» y en solo lectura («Definida en plantillas/x.json»); «Duplicar» crea una copia local editable. Si se borra un fichero, su plantilla queda «Retirada» (no se borra ni se toca ningún equipo). Las reglas completas están en [PERFIL.md](PERFIL.md); al actualizar desde 2.x, mira el apartado [8.1](#81-servicio).
