# Desarrollo de Relay Manager

Guía para trabajar en el código: preparar el entorno, el banco simulado, las pruebas, las convenciones y cómo publicar una versión. La arquitectura está en [ARQUITECTURA.md](ARQUITECTURA.md).

---

## 1. Entorno

El equipo de desarrollo es un Ubuntu 24.04 x86_64 **con** Internet (el de destino no la tiene).

| Herramienta | Versión | Para qué |
|---|---|---|
| Node.js | 22.23.2 (`engines`: ≥ 22.12 y < 23) | todo; es también la versión que viaja en el paquete |
| pnpm | 12.5.1 (fijado en `packageManager`) | dependencias y órdenes |
| python3 | la del sistema | consolas simuladas (`scripts/sim/fake-zynq.py`, solo biblioteca estándar) |
| Docker con la imagen `ubuntu:24.04` | | pruebas del paquete y la imagen Docker |
| Google Chrome (`/usr/bin/google-chrome`) o Chromium | | prueba de extremo a extremo |
| git | | la revisión se graba en el paquete |

Con nvm: `nvm install 22.23.2`. Para pnpm: `corepack enable` (usa la versión de `packageManager`) o instálalo aparte.

```bash
pnpm install          # también ejecuta prisma generate (postinstall)
```

Si falta `src/generated/` (pnpm se salta el `postinstall` cuando nada ha cambiado), ejecuta `pnpm db:generate`.

---

## 2. Arrancar en desarrollo

### 2.1 Con el banco simulado (recomendado)

```bash
pnpm dev:sim
```

1. Arranca el banco simulado: 4 consolas Zynq falsas (`ttyV0`…`ttyV3`, en `$XDG_RUNTIME_DIR/relay-manager-sim`, o en `.data/sim` si esa variable no existe) y dos placas Devantech simuladas (dS378 en `127.0.0.2` y ETH008 en `127.0.0.3`, con anuncios UDP).
2. Arranca el servidor de desarrollo (`RM_DEV=1 tsx server.ts`) con las variables que necesita para verlos.
3. Muestra el banner con las direcciones y el **código de configuración**. Abre la dirección, completa /setup y crea tu administrador.

Ctrl+C para todo: el servidor y los simuladores.

**Datos de ejemplo.** Con el servidor **parado**:

```bash
pnpm dev:seed
```

Importa en `.data/` dos equipos de ejemplo con sus consolas asignadas a las consolas simuladas, un tercer equipo sin relés con una consola sin asignar y una placa dS378 con la alimentación en el canal 1, y crea los usuarios `admin` (administrador) y `operador`. La contraseña es `RM_DEV_PASSWORD` (el script imprime los accesos al terminar). Después, `pnpm dev:sim` de nuevo. `dev:seed` se puede repetir: omite lo que ya existe.

### 2.2 Sin simuladores

```bash
pnpm dev
```

Es `RM_DEV=1 tsx server.ts`: Next en modo desarrollo dentro del servidor propio, en el puerto 3200, con los datos en `.data/` y el fichero `config.env` opcional en la raíz del repositorio (ignorado por git). En desarrollo el controlador de relés `simulated` está permitido por defecto.

Para empezar de cero: detén el servidor y borra `.data/`.

**Archivos** usa `~/tftp` (se crea al arrancar) salvo que definas `RM_FILES_DIR` (por ejemplo `RM_FILES_DIR=.data/tftp pnpm dev`). Las pruebas (Vitest, E2E, manuales) usan siempre carpetas temporales: nunca tocan tu `~/tftp`.

### 2.3 Varios servidores a la vez

Cada servidor necesita su puerto, su carpeta de compilación y sus datos:

```bash
RM_PORT=3301 RM_NEXT_DIST_DIR=.next-yo RM_DATA_DIR=.data-yo pnpm dev
```

`RM_NEXT_DIST_DIR` solo se aplica con `RM_DEV=1`. `next dev` con otra carpeta reescribe `tsconfig.json` (`include`) y crea `next-env.d.ts`: **no subas esos cambios** (`git checkout -- tsconfig.json; rm -f next-env.d.ts`). Las carpetas `.data*` y `.next*` están en `.gitignore`.

### 2.4 Órdenes de la CLI en desarrollo

Todas las órdenes de [OPERACION.md](OPERACION.md#7-referencia-de-la-línea-de-órdenes) funcionan con `RM_DEV=1 tsx server.ts <orden>` (o `node_modules/.bin/tsx`):

```bash
pnpm doctor                                   # = RM_DEV=1 tsx server.ts doctor
RM_DEV=1 pnpm exec tsx server.ts user list
RM_DEV=1 pnpm exec tsx server.ts setup-token
```

`RM_LOG_LEVEL=debug` muestra cada sonda de descubrimiento y las pilas de error.

---

### 2.5 Perfil del proyecto en desarrollo

En desarrollo el perfil se busca en `<repositorio>/perfil` (git lo ignora); `RM_PROFILE_DIR` elige otra carpeta. Sin
perfil, la aplicación arranca con los valores genéricos y sin plantillas. Para probar con el ejemplo genérico:

```bash
cp -r examples/perfil-ejemplo perfil         # o: RM_PROFILE_DIR=$PWD/examples/perfil-ejemplo pnpm dev:sim
pnpm dev:sim
RM_DEV=1 tsx server.ts plantillas comprobar   # valida plantillas/ y perfil.env sin tocar la base de datos
```

Para trabajar con el perfil real de un proyecto, apunta `RM_PROFILE_DIR` a su carpeta (fuera del repositorio) o
enlázala como `perfil`. Cómo se escribe un perfil: [PERFIL.md](PERFIL.md). Precedencia: variables del proceso >
`config.env` > `perfil.env` > valores por defecto.

## 3. Simuladores

### 3.1 El banco completo: `pnpm sim`

```bash
pnpm sim                         # consolas y placas
pnpm sim:consoles                # solo consolas
pnpm sim:relays                  # solo placas
node scripts/sim/bench.mjs --config mi-banco.json
```

Lee `scripts/sim/bench.json`, arranca un proceso por consola y por placa (con su salida prefijada, `[zynq ttyV0]`, `[dS378 127.0.0.2]`) e imprime las variables para el servidor:

```
RM_SERIAL_EXTRA_GLOBS=<carpeta>/ttyV*
RM_RELAY_DISCOVERY_BROADCASTS=127.255.255.255
RM_RELAY_SCAN_CIDRS=127.0.0.0/29
RM_RELAY_SCAN_PORTS=18080,18081
RM_RELAY_SIMULATE=1
```

Al pararlo (Ctrl+C) detiene todos los procesos y borra los enlaces de las consolas.

### 3.1b Accesos simulados: cables JTAG, `hw_server` y Ethernet

`bench.json` también define `jtag` (cables JTAG falsos) y `tcpTargets` (destinos Ethernet que responden con un *banner* y repiten lo recibido). El banco escribe los cables en `<simDir>/sys/bus/usb/devices` y añade al entorno `RM_JTAG_SYS_ROOT=<simDir>/sys` y `RM_HW_SERVER=scripts/sim/fake-hw-server.mjs`.

- `scripts/sim/fake-hw-server.mjs`: acepta `-s tcp:<host>:<puerto>`, `-p<n>` y `-e "set jtag-port-filter <serie>"`, imprime una cabecera como la real (`****** Xilinx hw_server v2099.1 (simulado)`) y escucha en el puerto; cada cliente recibe `fake-hw_server port=<p> jtag-port-filter=<serie> gdb=<n>` y después el eco de sus líneas. `RM_HW_SERVER` puede apuntar a un script `.mjs`: el servidor lo lanza con su propio Node.
- `scripts/sim/fake-jtag-cable.mjs plug|unplug|list --root <dir> --serial <serie> [--port <p>] [--xilinx]`: conecta y desconecta cables falsos en caliente (con el servidor en marcha, aparecen en ≤ 2 s). Como biblioteca: `plugCable`, `unplugCable`.
- Las pruebas usan `SysfsFixture` (`test/fixtures/sysfs`), que ya crea `bus/usb/devices` y tiene `addXilinxPlatformCable()` y `addDigilentHs3()`.
- `scripts/sim/fake-ssh-server.mjs` («Enviar a equipo»): un servidor SSH de equipo hecho con `ssh2` (JavaScript puro), usuario y contraseña `root`/`root`, SFTP sobre el sistema de ficheros real y `exec` (`scp -t <carpeta>` emulado; cualquier otra orden con `sh -c` en su carpeta personal, con `HOME`). `--no-sftp` se comporta como dropbear sin `sftp-server`, `--no-scp` y `--no-checksum` quitan `scp` y `sha256sum`/`md5sum`. Para probarlo en desarrollo, arráncalo y pon en un acceso Ethernet «Sin switch: dirección IP» `127.0.0.1` y su puerto:

  ```bash
  node scripts/sim/fake-ssh-server.mjs --port 2222 --home /tmp/equipo [--no-sftp]
  ```

  Como biblioteca: `createFakeSshServer({ home, sftp, scp, checksum, noExec, writeDelayMs, diskFullAfter, reportFree, hostKey })` (tipos en `fake-ssh-server.d.mts`). `src/server/files/send/transfer-openssh.test.ts` repite las pruebas contra el OpenSSH real de la máquina (un `sshd` sin privilegios en un puerto libre, con clave), si está instalado.

### 3.1c Red de equipos simulada: switch TP-Link y adaptador de red

- `scripts/sim/fake-tplink-switch.mjs`: un TL-SG108E v3 falso hecho con las páginas reales del switch (`test/fixtures/tplink-sg108e-v3`, capturadas con peticiones de solo lectura y sin credenciales), con sus bloques de datos generados desde un modelo y las rutas `.cgi` de sus formularios aplicadas a ese modelo (VLAN 802.1Q, PVID, guardar, copia). La sesión va por IP de origen, como en el real, y cada petición suma paquetes al puerto del «servidor» (para la comprobación del puerto de subida). Con la emulación de bloqueo, si ese puerto se quedara sin acceso a la gestión, el switch deja de responder. `admin`/`admin`.

  ```bash
  node scripts/sim/fake-tplink-switch.mjs --port 18099 [--host 127.0.0.1] [--ports 8] [--client-port 1] [--links 1,4] [--vlan1-readonly] [--no-lockout]
  ```

  Controles de prueba (no existen en el real): `GET /__sim/state`, `/__sim/link?port=4&up=1`, `/__sim/client?port=3`, `/__sim/fail?path=/vlanPvidSet.cgi&n=1` (corta las siguientes peticiones a esa ruta) y `/__sim/reset`. Como biblioteca: `createFakeSwitch(opts)` (tipos en `fake-tplink-switch.d.mts`).
- `scripts/sim/fake-net-adapter.mjs plug|unplug --root <dir> [--ifname enxfake0] [--mac …] [--no-carrier] [--pci]`: adaptadores de red falsos en un sysfs (`<dir>/class/net`), USB (ASIX AX88179A) o PCI. Con el servidor: `RM_NET_SYS_ROOT=<dir>`. Como biblioteca: `plugAdapter`, `setCarrier`, `unplugAdapter`.
- Para usarlos en desarrollo: `RM_NET_SYS_ROOT=<dir> RM_NET_HOST=off RM_NET_SWITCH_HTTP_PORT=18099`. En Sistema › Red de equipos elige el adaptador falso («Usar esta», paso 1); como no tiene direcciones, «Buscar el switch» no puede salir por él: escribe la IP del switch (`127.0.0.1`) y pulsa «Probar esta IP» (paso 2). Las pruebas con un núcleo de verdad (`pnpm test:net`, `scripts/nettest/`) montan el PC del banco completo en un contenedor aislado. Con `RM_NET_HOST=off` nunca se cambia la red de tu equipo: la página muestra las órdenes `ip` que ejecutaría.

### 3.2 Consola Zynq falsa: `scripts/sim/fake-zynq.py`

Crea un pty y lo enlaza en `--link`. Opciones:

| Opción | Por defecto | Qué hace |
|---|---|---|
| `--link <ruta>` | obligatoria | enlace simbólico al pty |
| `--stage` | `boot` | `boot` (FSBL → cuenta atrás de U-Boot → Linux → `login:`), `login`, `shell` (con eco; `reboot` vuelve a arrancar), `uboot` (`Zynq>`), `bitreader`, `silent`, `garbage` |
| `--host <nombre>` | `equipo-uart0` | nombre de host del prompt |
| `--autoboot <s>` | 3 | segundos de la cuenta atrás de U-Boot (interrumpible con una tecla) |
| `--speed <factor>` | 1 | multiplicador de los retardos (0 = instantáneo, para pruebas) |
| `--tick <s>` | 0 | líneas periódicas del núcleo (para probar la captura) |

Los bytes que el pty emite antes de que el servidor abra el puerto se pierden: arranca el servidor antes que la consola si quieres capturar el primer arranque.

### 3.3 Placa Devantech simulada: `scripts/sim/devantech-sim.mjs`

Sin dependencias. Como orden:

```bash
node scripts/sim/devantech-sim.mjs --model dS378 --host 127.0.0.2 --http 18080 --ascii 17123 --udp --mac 00:04:a3:00:00:01
```

Opciones: `--model`, `--host`, `--hostname`, `--http`, `--ascii`, `--eth`, `--udp`, `--udp-port`, `--reply-to` (por defecto `127.255.255.255`), `--udp-unicast`, `--var` (variable dScript), `--user`/`--pass` (HTTP ETH), `--tcp-pass`, `--latency`, `--fail-rate`, `--mac`, `--pulse` (canales que se comportan como pulso), `--announce-ip`.

Emula la aplicación estándar dS (`/index.xml`, `/index.htm`, `/dscript.cgi`), el protocolo ASCII TCP, el HTTP y el TCP binario de las ETH, y el respondedor UDP 30303 (con un campo `0x7F` propio del simulador que lleva el puerto HTTP y solo se atiende con `RM_RELAY_SIMULATE=1`).

Como biblioteca, para las pruebas: `createSimulator(opts)` devuelve `{ stop(), state(), setRelay(n, on), ports, announce() }` (tipos en `devantech-sim.d.mts`).

---

## 4. Pruebas y comprobaciones

| Orden | Qué hace |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint (0 errores y 0 avisos) |
| `pnpm test` | Vitest: pruebas unitarias y de integración. Sin red, sin hardware y sin root. Las que necesitan `python3` se saltan si no está. |
| `pnpm test:watch` | Vitest en modo vigilancia |
| `pnpm db:check` | falla si `schema.prisma` y las migraciones no coinciden |
| `pnpm build` | `prisma generate`, `next build` y el servidor con esbuild (`build/server.js`). La tabla de rutas no debe tener rutas estáticas (`○` o `●`). |
| `pnpm test:e2e` | prueba de extremo a extremo con el navegador del sistema (`scripts/e2e/smoke.mjs`, `playwright-core`), sin interfaz; `RM_E2E_CHROME` elige el navegador (por defecto `/usr/bin/google-chrome`). Guarda capturas en `test-results/e2e/`. |
| `pnpm test:bundle` | prueba del paquete en `ubuntu:24.04 --network none` (apartado [8](#8-publicar-una-versión)) |
| `pnpm test:net` | red de equipos con un núcleo Linux real (`scripts/nettest/`): un contenedor `--privileged --network none` (nunca toca la red del anfitrión; la primera vez construye la imagen `relay-manager-nettest:local`, `ubuntu:24.04` con `iproute2`) con un switch VLAN hecho con un puente Linux, dos «equipos» en espacios de red distintos con la **misma** IP 192.168.1.10 y una tarjeta de laboratorio falsa con la ruta por defecto. El código de la aplicación (`planHost`, `runIpCommands`, `TcpForward`) prepara las VLAN y cada reenvío llega solo a su equipo, y «Enviar a equipo» (el servicio de envíos con las rutas reales, contra un servidor SSH simulado en cada equipo, con SFTP en uno y solo scp en el otro) deja el fichero solo en el equipo de su puerto; comprueba también que la tabla principal y la tarjeta del laboratorio no cambian, que una segunda pasada no hace nada, el cambio de la dirección de gestión y que al desactivar no queda nada. Necesita Docker. |

- Una sola prueba: `pnpm vitest run src/server/serial/matcher.test.ts`.
- La prueba de HMR en desarrollo es lenta y solo corre con `RM_TEST_DEV=1`: `RM_TEST_DEV=1 pnpm vitest run test/integration/dev-hmr.test.ts`.
- El ZIP real de más de 4 GiB (ZIP64 con un fichero disperso de 4,1 GiB; necesita ~4,5 GB libres) solo corre con `RM_TEST_BIG=1`: `RM_TEST_BIG=1 pnpm vitest run src/server/files/zip.test.ts`. Las demás pruebas de Archivos (rutas, subidas, `ENOSPC`, 200 MB en *streaming*, `Range`, ZIP64 forzado, tar.gz) corren siempre.
- Las pruebas **nunca** usan puertos fijos (puerto 0 o aleatorio) ni dispositivos reales: usan el sysfs simulado (`test/fixtures/sysfs`), `SerialPortMock` y ptys.
- Red de equipos: las pruebas unitarias cubren el plan de direcciones, la disposición del switch (con 300 pares de estados aleatorios que nunca pierden la gestión), el analizador de las páginas reales del switch, el planificador de órdenes `ip` y su validación, el controlador y la vuelta atrás contra el switch falso, y el servicio completo con un modelo del núcleo (`src/server/equipnet/testing/fake-kernel.ts`). La prueba de extremo a extremo (paso 5a2) prepara el switch falso desde la tarjeta del Banco y elige un puerto del switch en el asistente, con `RM_NET_HOST=off`.
- Ayudas compartidas en `test/helpers`: `createTestDb()` (SQLite temporal con las migraciones reales), `fakeRuntime()`, `fakeBus()`, `fakeAudit()`, `postWithOrigin()` (todo POST de integración debe llevar `Origin`), etc.
- **Marcadores de proyecto** (`test/marcadores.test.ts`, dentro de `pnpm test`): falla si algún fichero que git subiría contiene el nombre de un proyecto (apartado [9](#9-configuración-del-proyecto-fuera-del-repositorio)).
- **TDD** para la lógica de negocio: la prueba se escribe primero y debe fallar antes de implementar.

Antes de subir cambios: `pnpm typecheck && pnpm lint && pnpm test && pnpm db:check`, y `pnpm build` si tocas páginas o el servidor.

---

## 5. Convenciones

**Código**

- TypeScript estricto: prohibido `any` (usa `unknown` y estrecha) y `@ts-ignore`.
- zod (`import { z } from "zod"`) valida toda entrada: server actions, parámetros y consultas de rutas, JSON leído de disco o de la base de datos, e importaciones.
- Los contratos compartidos (DTO, enums, WebSocket, eventos) están en `src/lib/contracts/`. Cambiarlos afecta a varias áreas: hazlo con cuidado y de forma aditiva.
- Identificadores, comentarios y tipo/ámbito del commit en inglés; **todo lo que lee una persona en español** (interfaz, errores, CLI, `doctor`, instalador, registro del servidor y documentación), con mayúscula solo al principio y con tildes completas. Sin rayas largas en la interfaz.
- Los textos de la interfaz viven en `src/lib/i18n/<área>.ts`. Plurales con `plural(n, {one, other})` y fechas con `Intl.DateTimeFormat("es-ES")` (`src/lib/i18n/format.ts`). Un mensaje de error dice qué ha pasado **y qué hacer**.
- Versiones fijadas: no actualices dependencias sin una razón y una revisión (Next depende de una variable privada para el modo *standalone*).

**Servidor**

- Estado solo en el registro de ejecución (`getRuntime()`), nunca en variables de módulo del lado Next ([ARQUITECTURA.md](ARQUITECTURA.md#3-grafos-de-módulos-y-registro-de-ejecución)). Nada de efectos al importar.
- La interfaz no importa `@/server/{serial,relays,ops,boot,http,db,cli}`: la lógica pura compartida va en `src/lib/serial` y `src/lib/relays`. ESLint lo comprueba.
- Cada mutación es una server action en `src/actions/*.ts` con `defineAction(schema, { auth, auditDenied? }, handler)`, que recibe **un objeto JSON** (nunca `FormData`) y devuelve `ActionResult`. Los errores de negocio son `DomainError` con su código (`NOT_FOUND`, `NOT_HOLDER`, `RESERVED_BY_OTHER`, `VALIDATION`…) y `fieldErrors` con rutas completas (`consoles.2.binding`).
- Las lecturas de las páginas son funciones de `src/server/queries/*` (`server-only`). Las rutas de API usan `defineRoute` y **no** modifican estado.
- Cualquier comprobación de visibilidad de un equipo pasa por `src/server/access.ts`.
- Todo lo relevante se audita (`rt.audit.record`), con un `detail` sin secretos.
- Registro con `rt.log.child("<componente>")`: mensajes en español, nunca contraseñas, secretos, códigos, cookies ni lo tecleado en una consola.
- Las fechas se guardan y se transmiten en UTC ISO-8601; el navegador las muestra en su zona.

**Git**

- Conventional Commits con la descripción en español, por ejemplo `feat(serial): reconexión inmediata al volver a conectar el adaptador`.
- Nunca `push --force` a `main` ni a ramas compartidas.

---

## 6. Base de datos

El esquema está en `prisma/schema.prisma`; las migraciones, en `prisma/migrations/`. En producción las aplica un runner propio al arrancar (con copia previa), no la CLI de Prisma.

Para cambiar el esquema:

1. Edita `prisma/schema.prisma`.
2. Con el servidor de desarrollo parado: `pnpm db:new <nombre_en_minúsculas>` (crea la migración contra `.data/relay-manager.db` sin aplicarla).
3. Revisa el SQL generado. Si la migración redefine tablas, el runner ya desactiva las claves ajenas durante la migración y comprueba la integridad al final.
4. `pnpm db:check` y `pnpm test`.
5. Sube el esquema y la migración juntos.

**Nunca edites una migración ya publicada.** Una base de datos con una migración que el programa no conoce no arranca (código 4); por eso `rollback` necesita la copia `pre-upgrade`.

Los triggers de auditoría (solo inserción) no están en las migraciones: los crea `src/server/db/invariants.ts` en cada arranque. El código no trae plantillas: vienen de los ficheros `plantillas/*.json` del perfil (`syncProfileTemplates()`, en cada arranque después de la semilla, con «Recargar plantillas» y con `relay-manager plantillas recargar`; formato en [PERFIL.md](PERFIL.md#3-plantillas-plantillasjson)). El esquema JSON `docs/plantilla.schema.json` se genera desde `TemplateFileJsonSchema` (`src/lib/contracts/template-file.ts`) y una prueba de Vitest falla si no coinciden: si cambias el formato, regenéralo y súbelo junto al cambio.

---

## 7. Añadir un controlador de relés

Los controladores viven en `src/server/relays/drivers/`. Pasos:

1. **Contrato.** Añade el id a `DRIVER_IDS` en `src/lib/contracts/enums.ts` y, si necesita opciones propias, amplía `BoardOptionsSchema` en `src/lib/contracts/relays.ts` (campos opcionales). El controlador se guarda como texto: no hace falta migración.
2. **Implementación.** Crea `src/server/relays/drivers/<id>.ts` con la interfaz `RelayDriver` de `src/server/relays/types.ts`:
   - `capabilities(board)`: `absoluteSet`, `toggle`, `pulse` (`native`/`emulated`), rango de pulso y relés máximos;
   - `detect(host, ports, ctx)`: **solo lectura**. Toda escritura de una sonda pasa por `assertSafeProbe`/`assertSafeHttpProbe` (`src/server/relays/discovery/safety.ts`); añade allí las reglas de tu protocolo (qué bytes y rutas nunca se envían al detectar);
   - `readState(board, signal)`: `boolean[]` con el número **físico** de relés (índice 0 = canal 1);
   - `setRelay(board, canal, on, signal)` y `pulse(board, canal, ms, signal)`; si el hardware solo conmuta, emula el encendido absoluto (leer, comparar, conmutar), como `ds-http`;
   - errores con `RelayDriverError` y su tipo (`unreachable`, `timeout`, `auth`, `protocol`, `unsupported`, `nack`, `config`). Solo `unreachable` y `timeout` marcan la placa como sin conexión.
   - Usa los transportes de `src/server/relays/transport/` (HTTP sin redirecciones y con límite de 64 KiB; TCP de conversación corta). El controlador ya serializa las llamadas por placa y verifica cada escritura.
3. **Registro.** Añádelo en `src/server/relays/registry.ts` (creación, orden de preferencia y `autodetect`). Si el escaneo de subred debe reconocerlo, amplía `src/server/relays/discovery/scan.ts`.
4. **Modelos.** Los modelos y su número de relés, en `src/server/relays/pure/models.ts` y `src/lib/relays/models.ts`.
5. **Interfaz.** Capacidades en `src/lib/relays/capabilities.ts`; nombre en `src/lib/i18n/status.ts`; ayuda y errores en `src/lib/i18n/relays.ts`; campos propios en `src/components/boards/board-form-model.ts` y `board-form.tsx`.
6. **Pruebas.** Añade el protocolo a `scripts/sim/devantech-sim.mjs` (o un simulador propio) y pruebas en `src/server/relays/drivers/drivers.test.ts` (escritura, lectura, pulso, errores) y `safety.test.ts` (ninguna sonda de detección envía una orden de escritura).

---

## 8. Publicar una versión

1. Sube la versión en `package.json` (semver) y revisa estas guías.
2. Comprobaciones: `pnpm typecheck && pnpm lint && pnpm test && pnpm db:check && pnpm build`, y `pnpm test:e2e`.
3. Construye el paquete (con Internet, la primera vez descarga Node 22.23.2 de nodejs.org y lo verifica con `SHASUMS256.txt`; se guarda en `~/.cache/relay-manager/`):

   ```bash
   pnpm bundle                  # bash scripts/build-bundle.sh: paquete, con typecheck, lint y tests
   pnpm bundle --docker         # además la imagen Docker
   pnpm image                   # paquete + imagen, sin tests
   ```

   Opciones de `scripts/build-bundle.sh`: `--skip-tests`, `--docker` y `--perfil <carpeta>` (mete ese perfil en el paquete como `perfil/`; sin ella, el paquete no lleva perfil y nunca lleva `tools/` ni nada de un proyecto). Con `PNPM_OFFLINE=1`, `pnpm install` no usa la red. Si faltan las fuentes en `src/fonts/`, `pnpm fonts:vendor` las descarga una vez (se versionan). La construcción falla si el paquete lleva datos locales o secretos, o si ocupa más de 120 MB.
4. Prueba el paquete (necesita Docker y la imagen `ubuntu:24.04` en local; `RM_TEST_IMAGE` elige otra):

   ```bash
   pnpm test:bundle                              # modo portátil sin red: arranque, acceso, SSE, WS, doctor, reinicio
   bash scripts/test-bundle.sh --systemd         # además instalación nativa, actualización, rollback y desinstalación
   bash scripts/test-bundle.sh --docker          # además la imagen: raíz de solo lectura, sin capacidades
   bash scripts/test-bundle.sh --only-systemd    # solo systemd (también --only-docker)
   bash scripts/test-bundle.sh --rebuild         # reconstruye el paquete antes
   ```

5. Entrega (todo en `dist/`):

   | Fichero | Para |
   |---|---|
   | `relay-manager-<versión>-linux-x64.tar.gz` y `.sha256` | servicio y portátil |
   | `relay-manager-image-<versión>.tar.gz` y `.sha256` | Docker |
   | `compose.yaml` y `99-relay-manager.rules` | Docker (anfitrión) |

6. Crea el commit y la etiqueta `v<versión>`.

Nunca construyas el paquete en un árbol con cambios de otras personas a medias: `build-bundle.sh` borra y regenera `.next/`, `build/` y `dist/`. Si hace falta, usa una copia (`git worktree add`).

---

## 9. Configuración del proyecto fuera del repositorio

El repositorio es genérico: nada de un proyecto concreto (nombres, plantillas, scripts, direcciones de su red) se
sube nunca. Dos protecciones:

**`.gitignore`.** Ignora siempre las carpetas y ficheros donde vive la configuración de un proyecto, para que no se
puedan añadir por accidente:

| Regla | Qué cubre |
|---|---|
| `/perfil/`, `/perfil-*/`, `/relay-manager-perfil-*/` | un perfil copiado o enlazado dentro del repositorio |
| `/plantillas/`, `/tools/`, `/herramientas/` | plantillas y scripts sueltos de un proyecto |
| `/*.env`, `**/perfil.env` | `config.env`, `perfil.env` y similares (salvo `!/examples/**/perfil.env`: el perfil de ejemplo genérico sí se versiona) |
| `/.marcadores-proyecto` | la lista local de marcadores (abajo) |
| `/docs/**/*.pdf`, `/manuales/`, `/rm-manuales-*/` | PDF de manuales y carpetas de trabajo de las capturas |

**Comprobación de marcadores** (`test/marcadores.test.ts`, corre en `pnpm test`). Recorre todos los ficheros que git
subiría (los versionados y los nuevos no ignorados) y falla si alguna línea coincide con un marcador de proyecto,
indicando fichero y línea. Los marcadores son una lista genérica pequeña incluida en la prueba (un nombre de empresa y
el prefijo de una red privada 172.x) más los del fichero **`.marcadores-proyecto`** en la raíz del repositorio, que
git ignora: así cada equipo añade los nombres de su proyecto sin publicarlos. Formato: una expresión regular por línea
(sin distinguir mayúsculas), `#` para comentarios y `!<ruta>` para saltarse un fichero o carpeta (por prefijo):

```text
# .marcadores-proyecto (no se sube)
mi-proyecto
\bbanco-x\b
10\.20\.30\.
!pnpm-lock.yaml
```

Cuando empieces a trabajar con un proyecto, crea ese fichero con sus nombres, sus claves de consola, sus hosts y los
prefijos de su red; si la prueba falla, mueve lo marcado al perfil del proyecto.

## 10. Manuales del proyecto

Los manuales en PDF (usuario y administrador, con capturas) son de cada proyecto y viven en su perfil
(`<perfil>/manuales/`), no aquí. El repositorio solo tiene las herramientas genéricas de `scripts/manuales/`:

| Guion | Qué hace |
|---|---|
| `entorno.mjs` | banco simulado (sysfs y `/dev` falsos, consolas Zynq, placas Devantech, cables JTAG, `hw_server`, switch y red de equipos) y servidor compilado con datos vacíos; `--perfil` carga un perfil y `--manuales` toma los nombres de host de `<manuales>/banco.json` |
| `contenedor.mjs` / `red-equipos.sh` | el mismo entorno dentro de Docker con red propia, para que la red de equipos salga «Lista» (monta el perfil y los manuales en solo lectura) |
| `capturas.mjs` | ejecuta las etapas de `<manuales>/etapas.mjs` (que exporta `STAGES`; importa `navegador.mjs` de aquí con `process.env.RM_REPO`) y deja los PNG en `<dir>/shots` |
| `optimizar.mjs` | PNG → JPEG en `<manuales>/img` (solo las que citan los HTML) |
| `generar.mjs` | HTML → PDF con Chrome: numeración, índice, referencias y llamadas; `<manuales>/manuales.json` (opcional) da el nombre del producto y de los PDF; las fuentes salen de `src/fonts/` |

```bash
pnpm build
node scripts/manuales/capturas.mjs --manuales <perfil>/manuales --contenedor --dir /tmp/rm-capturas
node scripts/manuales/optimizar.mjs --manuales <perfil>/manuales /tmp/rm-capturas/shots
node scripts/manuales/generar.mjs --manuales <perfil>/manuales --out dist/manuales
```

`capturas.mjs` usa como perfil la carpeta que contiene a `--manuales` (si tiene `perfil.env` o `plantillas/`) o el de
`--perfil`. Los PDF y las carpetas de trabajo nunca se suben (`dist/`, `/tmp` y las reglas del apartado 9). Cada
perfil documenta en su `manuales/README.md` cómo regenerar los suyos.

