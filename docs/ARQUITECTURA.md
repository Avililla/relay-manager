# Arquitectura de Relay Manager (3.0)

Este documento explica cómo está construido Relay Manager: el proceso, los módulos, los datos, los protocolos, el modelo de seguridad y las decisiones de diseño. Para instalarlo, mira [INSTALACION.md](INSTALACION.md); para usarlo, [OPERACION.md](OPERACION.md); para trabajar en el código, [DESARROLLO.md](DESARROLLO.md).

---

## 1. Visión general

Relay Manager es una aplicación web para bancos de integración y pruebas de hardware. Hay **una instancia por equipo anfitrión del banco**, y todos los adaptadores USB-serie se conectan a ese anfitrión. Da acceso compartido y seguro a:

- las **consolas serie** de los equipos bajo prueba (UART Zynq por adaptadores USB-serie), con reserva, solo lectura para los demás y captura continua en disco;
- las **placas de relés Devantech** (opcionales), para alimentación, reinicio y modos;
- los **accesos de red** de cada equipo: un puerto TCP fijo por cable JTAG (un `hw_server` supervisado), por consola serie (TCP en bruto sobre la misma consola) y por Ethernet (reenvío TCP), para que cada ingeniero trabaje desde su PC en paralelo; y el inventario de **cables** con nombre;
- **Archivos**: una carpeta del servidor (`RM_FILES_DIR`) para subir ficheros desde el PC y descargarlos, compartida por todos los usuarios, **enviar** un fichero a un equipo por SSH por la misma ruta que su acceso Ethernet y, para los administradores, **copiarlo a una carpeta del propio servidor** (un pendrive), como el servicio o como administrador (sudo);
- la **red de equipos**: todos los equipos tienen la misma IP en su Ethernet; cada uno va a un puerto de un switch TP-Link Easy Smart configurado con una VLAN 802.1Q por puerto, y el servidor llega a cada VLAN por una interfaz VLAN sobre la tarjeta que elige un administrador (un adaptador USB-Ethernet dedicado), con enrutamiento por origen (apartado [6.8](#68-red-de-equipos)).

Tecnologías principales: Node 22, Next.js 16 (App Router, React 19), un servidor HTTP propio, SQLite con Prisma 7 y el adaptador `better-sqlite3`, `serialport` 13, `ws` 8, `ssh2` 1.17 (JavaScript puro), NextAuth 5 (JWT), zod 4 y xterm.js 5 en el navegador.

---

## 2. Modelo de procesos

Todo corre en **un único proceso Node**:

```
node app/server.js start                 (producción: server.ts empaquetado con esbuild)
RM_DEV=1 tsx server.ts                   (desarrollo)
│
├─ boot/main.ts ── órdenes: start (por defecto) | migrate | doctor | setup-token | user | backup
│                  | restore | config | plantillas | ping | version   (solo start arranca Next)
│
├─ boot/start.ts
│   1  loadConfig() → AppConfig; exporta AUTH_SECRET y compañía a process.env
│   2  umask 0027; en portátil se niega a correr como root; logger;
│      bloqueo de instancia (<datos>/.instance-lock, código 5 si está ocupado); directorios 0750
│   3  migraciones (runner propio con better-sqlite3, copia previa, rechaza migraciones desconocidas)
│   4  PrismaClient → invariantes (triggers de auditoría) → datos iniciales (ajustes) → plantillas del perfil
│      (syncProfileTemplates; los errores van al registro, el arranque sigue)
│   5  código de configuración inicial, si está pendiente → <datos>/setup-token (0600)
│   6  servicios: bus → auditoría → ajustes → throttle → sesiones → reservas → serie → relés → red de equipos
│      → accesos → archivos → ops
│   7  setRuntime(rt) → globalThis[Symbol.for("relay-manager.runtime")]
│   8  next({ dev, dir: appDir, httpServer }) ; app.prepare()
│   9  servidor HTTP o HTTPS:
│        'request'  → reescritura de cabeceras reenviadas → filtro de Origin (no GET/HEAD/OPTIONS)
│                     → /api/files/* → rt.files (Archivos, grafo A) ; todo lo demás → Next
│        'upgrade'  → /ws/console/<id>, /ws/preview/<clave> → reescritura → Origin → rt.serial
│                     cualquier otra ruta: se ignora (HMR de Next en desarrollo)
│  10  listen → server.pid (informativo) → banner con las URL de cada IPv4 y el código pendiente
│  11  trabajo de fondo: descubrimiento serie y gestor de consolas (captura continua), sondeo de placas
│      y escucha UDP pasiva, red de equipos (adaptadores, VLAN del servidor, switch; antes que los accesos),
│      accesos (cables JTAG, hw_server, puentes TCP), barrido de reservas,
│      revalidación de sesiones, retención de capturas y de auditoría, copia diaria
│  12  SIGTERM/SIGINT → parada ordenada
│
└─ Next.js (mismo proceso, su propio grafo de módulos): páginas RSC, server actions, route handlers
   y proxy.ts. Los servicios con estado solo se alcanzan con getRuntime().
```

**Parada ordenada** (`boot/shutdown.ts`, idempotente, con un límite duro de 8 s; la unidad systemd da 15 s):

1. `server.close()`.
2. Cierra todos los WebSocket con 1001 «Servidor detenido».
3. Detiene ops, relés (espera como mucho 2 s a las órdenes en curso), accesos (cierra los puertos de acceso con un aviso y para cada `hw_server` con SIGTERM a su grupo de procesos, SIGKILL a los 3 s), red de equipos (cierra la sesión del switch; las interfaces VLAN se quedan para el siguiente arranque), serie (vacía las capturas y cierra los puertos) y reservas.
4. Audita `system.stop` y vacía la cola de auditoría.
5. Cierra las conexiones restantes (SSE, keep-alive).
6. Desconecta Prisma, borra `server.pid`, suelta el bloqueo de instancia y sale con 0.

**Códigos de salida:** 0 correcto; 1 error genérico o fallo de `doctor`; 2 configuración o puerto; 3 migración fallida; 4 base de datos con migraciones desconocidas; 5 bloqueo de instancia ocupado. La unidad systemd no reinicia con 2, 3, 4 ni 5.

---

## 3. Grafos de módulos y registro de ejecución

En el mismo proceso conviven **dos grafos de módulos**:

- **Grafo A** (`server.ts`): esbuild en producción, tsx en desarrollo.
- **Grafo B** (Next): lo empaqueta Next (Turbopack).

Un módulo importado por los dos existe **dos veces**, con su propio estado. Por eso:

1. Todo objeto con estado (cliente Prisma, bus de eventos, cola de auditoría, caché de ajustes, throttle de acceso, registro de sesiones vivas, caché de reservas, descubrimiento serie, gestor de consolas, controlador de relés, socket UDP, servicio de accesos con sus procesos `hw_server` y sockets de escucha, red de equipos con su sesión del switch, temporizadores) vive **solo** en el registro de ejecución, que crea el grafo A en `boot/start.ts`.
2. El código del grafo B (`src/app/**`, `src/actions/**`, `src/server/queries/**`, `src/proxy.ts`, la configuración de NextAuth) llega a ellos **solo** con `getRuntime()`.
3. El grafo B puede importar directamente módulos **sin estado**: `src/lib/**`, `src/server/runtime/{registry,types}.ts`, `errors.ts`, `authz*.ts`, `access.ts`, `request-meta.ts`, `actions/define-*.ts`, `services/*.ts` (funciones de dominio que reciben sus dependencias) y `queries/**`.
4. Nunca se usa `instanceof` entre grafos: una clase cargada en A es otra clase en B. Los errores de dominio se reconocen por forma (`isDomainError`).
5. Ningún módulo de `src/**` tiene efectos al importarse: `next build` importa las rutas sin servidor. Todas las rutas son dinámicas (`force-dynamic` en el layout raíz), así que nada se pre-renderiza en el directorio de la aplicación, que es de solo lectura.
6. ESLint impide que la interfaz (`src/app`, `src/components`, `src/hooks`, `src/actions`) importe `@/server/{serial,relays,ops,boot,http,db,cli,equipnet}`. La lógica pura compartida vive en `src/lib/serial` y `src/lib/relays`.

El registro (`src/server/runtime/registry.ts`):

```ts
const KEY = Symbol.for("relay-manager.runtime")
export function setRuntime(rt: Runtime): void      // solo boot/start.ts
export function tryGetRuntime(): Runtime | undefined
export function getRuntime(): Runtime              // lanza "Los servicios del servidor no están iniciados"
```

`Runtime` (en `src/server/runtime/types.ts`) contiene `config`, `log`, `prisma`, `bus`, `audit`, `settings`, `throttle`, `sessions`, `reservations`, `serial`, `relays`, `accesses`, `equipnet`, `files`, `ops` y un `state` mutable (`setupPending`, contador de errores no controlados).

### 3.1 Estructura del código

```
server.ts                   entrada del proceso (grafo A)
src/server/boot/            main (órdenes), start, shutdown, banner, bloqueo de instancia
src/server/config/          cargador de configuración (RM_*), modos
src/server/http/            cabeceras reenviadas, Origin, upgrade, listen
src/server/db/              cliente Prisma, runner de migraciones, invariantes, datos iniciales
src/server/auth/            NextAuth, secreto, contraseñas, throttle, sesiones vivas, WS, código de configuración
src/server/events/          bus de eventos
src/server/audit/           servicio de auditoría
src/server/settings/        ajustes globales
src/server/serial/          descubrimiento sysfs, gestor de consolas, captura, sondeo, vista previa, WebSocket
src/server/relays/          controladores Devantech, transportes, controlador, descubrimiento UDP/escaneo
src/server/accesses/        accesos: cables JTAG (sysfs), hw_server (búsqueda y supervisor), puente serie-TCP,
                            reenvío TCP, conexiones JTAG (/proc/net/tcp), etiquetas de cables
src/server/files/           Archivos: rutas seguras, subidas por fragmentos, API HTTP propia, ZIP y tar en streaming;
                            send/: «Enviar a equipo» (SSH con ssh2: SFTP o scp, cola, credenciales recordadas);
                            copy/: «Copiar a una carpeta del servidor» (unidades, navegador de carpetas, cola, cliente del ayudante,
                            permisos de administrador de la sesión, montar y expulsar)
                            export/: «Descargas» (cola, proceso del script del perfil, registro)
src/server/rootcopy/        ayudante de root «Copiar como administrador (sudo)» (relay-manager-rootcopy): programa aparte,
                            app/rootcopy.js, que el servicio nunca carga; también los permisos firmados (token.ts)
src/server/rootmount/       ayudante de montaje (relay-manager-rootmount): el mismo app/rootcopy.js con el argumento «mount»
src/server/equipnet/        red de equipos: adaptadores (sysfs), planificador y ejecutor de `ip`, controladores de switch,
                            aplicación del switch paso a paso, credenciales cifradas
src/server/services/        dominio sin estado: reservas, equipos, plantillas, usuarios, roles, config, SSE
src/server/ops/             copias, restauración, salud, doctor, información del sistema
src/server/cli/             órdenes de línea de órdenes
src/server/queries/         lecturas para las páginas (server-only)
src/server/actions/         defineAction / defineRoute
src/actions/                server actions (mutaciones)
src/app/                    páginas y rutas de API
src/components/, src/hooks/ interfaz
src/lib/contracts/          contratos compartidos (zod + tipos): enums, DTO, WS, eventos
src/lib/equipnet/           red de equipos, lógica pura compartida: IPv4, plan de direcciones y VLAN, disposición del switch
src/lib/i18n/               textos en español por área
prisma/                     esquema y migraciones
scripts/                    empaquetado, simuladores, semilla de desarrollo
packaging/                  lanzador, instalador, unidad systemd, regla udev, Docker
```

---

## 4. Configuración

Un único cargador (`src/server/config/load.ts`) lee las variables `RM_*` (más `NODE_ENV`, que fija el lanzador). Precedencia: **entorno del proceso > fichero de configuración > `perfil.env` del perfil del proyecto (apartado [4.1](#41-perfil-del-proyecto)) > valores por defecto del modo**. El fichero se lee con `util.parseEnv`; la unidad systemd no usa `EnvironmentFile=`. Un valor no válido es un `ConfigError` con un mensaje en español que nombra la variable (código 2).

| Modo | Se elige cuando | Fichero | Datos | Aplicación |
|---|---|---|---|---|
| `dev` | `RM_DEV=1` | `<repo>/config.env` | `<repo>/.data` | raíz del repositorio |
| `native` | la unidad o el lanzador lo fijan (aplicación bajo `/opt/relay-manager/releases/`) | `/etc/relay-manager/config.env` | `/var/lib/relay-manager` | `/opt/relay-manager/current/app` |
| `portable` | cualquier otra ubicación del paquete | `<paquete>/config.env` | `<paquete>/data` | `<paquete>/app` |
| `docker` | `RM_MODE=docker` (imagen) | `/data/config.env` | `/data` | `/opt/relay-manager/app` |

El fichero es opcional en todos los modos y nunca decide el modo. La lista completa de variables está en [INSTALACION.md](INSTALACION.md#14-referencia-de-configuración). Antes de cargar Next, `applyConfigEnv` fija `AUTH_SECRET`, `AUTH_TRUST_HOST=true`, `NEXT_TELEMETRY_DISABLED=1` y `NODE_ENV`, y borra `AUTH_URL`/`NEXTAUTH_URL`.

El **secreto de sesión** es `RM_AUTH_SECRET` o `<datos>/auth-secret`; si no existe, `start` genera 32 bytes aleatorios (0600). `doctor`, `setup-token` y `ping` nunca crean nada.

### 4.1 Perfil del proyecto

El código es genérico; lo propio de un proyecto va en un **perfil** externo (guía: [PERFIL.md](PERFIL.md)): `perfil.env` (valores por defecto del proyecto, leído también con `util.parseEnv`), `plantillas/*.json` (una plantilla por fichero, solo el primer nivel; se ignoran los que empiezan por `.` o `_`), `herramientas/` (scripts, por ejemplo el de descarga) y, opcionalmente, `manuales/` y `README.md`, que la aplicación no usa. La carpeta es `RM_PROFILE_DIR` (solo del entorno o de `config.env`): `/etc/relay-manager/perfil` en `native`, `<paquete>/perfil` en `portable`, `/perfil` en `docker` y `<repo>/perfil` en `dev`. Sin carpeta no hay perfil (valores genéricos; `doctor` lo dice como información); con `RM_PROFILE_DIR` explícita y sin carpeta, aviso.

Precedencia completa: **entorno del proceso > `config.env` > `perfil.env` > valores por defecto**. `perfil.env` solo admite las claves del perfil (`RM_LAB_NAME`, `RM_FILES_EXTRA_*`, `RM_EXPORT_*`, `RM_EQUIPNET_EQUIPMENT_IP`, `RM_EQUIPNET_EQUIPMENT_PORT`); cualquier otra se ignora con un aviso («Variable no permitida en perfil.env: X»). Sus rutas relativas se resuelven contra la carpeta del perfil. Las plantillas se validan con `TemplateFileSchema` (`src/lib/contracts/template-file.ts`, objeto estricto; el esquema JSON publicado, `docs/plantilla.schema.json`, se genera de él con `z.toJSONSchema` y una prueba los mantiene iguales), con mensajes en español que nombran fichero y ruta (`plantillas/equipo-a.json: consoles[1].key: Clave repetida: UART0`). `RM_LAB_NAME` y `RM_EQUIPNET_EQUIPMENT_IP` solo se aplican al crear su fila (una base de datos existente conserva sus valores). La comprobación `config.profile` («Perfil») de Salud y `doctor` informa sin perfil, da «<carpeta>: N plantillas» si todo es válido, falla con cada error de las plantillas o de `perfil.env` y avisa de las claves no permitidas. `relay-manager plantillas comprobar` valida sin tocar la base de datos.

---

## 5. Modelo de datos

SQLite (modo WAL) con Prisma 7 y `@prisma/adapter-better-sqlite3`. Las columnas tipo enum son cadenas validadas con zod (`src/lib/contracts/enums.ts`). Las fechas se guardan y se transmiten en UTC ISO-8601.

| Modelo | Contenido |
|---|---|
| `User` | usuario (minúsculas, único), nombre, correo opcional, hash bcrypt (coste 12), `isAdmin`, `disabled`, `mustChangePassword`, `sessionVersion`, último acceso, roles y **tema** (`theme`: `dark`/`light`/`system`/`rosa`, nulo = sin elegir; D39) |
| `Role` | nombre, descripción, usuarios y equipos. Un equipo sin roles es visible para todos |
| `EquipmentTemplate` | clave estable (`equipo-a`; la del fichero del perfil) o nula, nombre, `source` (`local` o `file`), `sourceFile` (`plantillas/equipo-a.json`, relativo al perfil), `retiredAt` («Retirada»), `needsReview` («Revisar»), `spec` (JSON validado: consolas, relés, **accesos** sin puertos, patrón de nombre, interfaces que se saltan) |
| `Equipment` | nombre, número de serie, descripción, orden, plantilla de origen (solo informativa, `SetNull`) y su nombre copiado, roles, consolas, relés y la **reserva** (`reservedById`, `reservedAt`, `reservationExpiresAt`, motivo) |
| `SerialConsole` | equipo, posición, clave (`UART0`), etiqueta, ajustes de línea, Intro (`cr`/`lf`/`crlf`), eco local, `hupcl`, captura, expresiones de identificación; **asignación** (`matchBy` = `adapter`/`usb-port`/`path`, `bindingKey` único, by-id, by-path, VID/PID/serie, interfaz, puerto, ruta USB, ruta literal, etiqueta del adaptador); **puerto soltado** (quién, cuándo, hasta cuándo) |
| `RelayBoard` | nombre, controlador, host, puertos HTTP/TCP, modelo, id de módulo, MAC (única), número **físico** de relés, opciones (JSON: `toggleVar`, transporte…), usuario/contraseña, activa, y caché de estado (conectada, última lectura, último error, estado de los relés) |
| `RelayChannel` | equipo, placa, canal (único por placa), posición, clave, etiqueta, tipo (`power`/`reset`/`mode`/`generic`), confirmación y pulso por defecto |
| `EquipmentAccess` | equipo (`Cascade`), posición, clave (`JTAG_SEC`), etiqueta, tipo (`jtag`/`serial`/`tcp`), **puerto** (único en todo el banco), activo, apertura (`reserved`/`always`), número de serie del cable JTAG, consola (`SetNull` si se borra) y, en Ethernet, `targetMode` (`ip`: destino IP:puerto; `switch`: `switchPort` de la red de equipos, con `targetHost` nulo = la IP de los equipos), `targetPort` y `sshUser` (usuario de las órdenes ssh/scp) |
| `EquipmentSshProfile` | una fila por equipo (`Cascade`) para «Enviar a equipo»: si se recuerda el acceso (`remembered`), usuario, contraseña **cifrada** (AES-256-GCM, clave HKDF del secreto de la aplicación con su propio `info`), ruta de destino y la **huella** de la clave SSH vista en el último acceso correcto (tipo, `SHA256:…`, cuándo) |
| `CableLabel` | tipo (`jtag`/`serial-adapter`/`net-adapter`), identidad (serie del cable JTAG; `vid:pid:serie` o `loc:<ubicación USB>` del adaptador serie; MAC del adaptador de red), nombre (único por tipo), notas, descriptor USB y cuándo se vio por primera y última vez |
| `EquipmentNetwork` | fila única de la red de equipos: activa, búsqueda automática (columna sin uso desde que la tarjeta se elige a mano; se conserva para no migrar), MAC de la tarjeta elegida, controlador del switch (`tplink-easy-smart`/`manual`), IP, usuario y contraseña **cifrada** del switch, modelo y firmware, número de puertos, puerto de subida, base de VLAN, dirección de gestión, IP y prefijo de los equipos, desplazamiento de las direcciones del servidor, la disposición 802.1Q aplicada (para detectar diferencias), la anterior (para restaurarla) y el nombre de la última copia del switch |
| `AuditEvent` | fecha, actor (tipo, id, nombre), IP, acción, resultado (`ok`/`denied`/`error`), equipo, objetivo, detalle JSON. **Solo se añaden filas**: dos triggers SQLite impiden modificar y borrar (salvo la purga por retención) |
| `Settings` | fila única: nombre del laboratorio, franja superior, duración y aviso de reserva, retención y límites de captura, captura de entrada, retención de auditoría, copia diaria, fecha de fin de la configuración inicial |

**Semántica de plantillas: se copian al crear.** Editar una plantilla nunca cambia los equipos existentes. El código no trae plantillas: las define el perfil (apartado [4.1](#41-perfil-del-proyecto)), una por fichero, y `syncProfileTemplates()` las copia a la base de datos al arrancar (después de la semilla), con «Recargar plantillas» (acción de servidor auditada `template.reload`) y con `relay-manager plantillas recargar`. Reglas: fichero válido sin fila con su clave → se crea (`source=file`; si el nombre está ocupado, «<nombre> (<clave>)» con aviso); fila `file` con la clave → se actualizan nombre, descripción, «Revisar», orden, `spec` y `sourceFile`, y se borra `retiredAt`; fila `local` con la clave (las predefinidas de 2.x o una importada con clave) → se **vincula** (pasa a `file` con los valores del fichero); fichero no válido → su fila no se toca y el error (fichero y ruta JSON) va al registro, a `doctor` y al informe; fila `file` sin fichero → `retiredAt` («Retirada»: no se borra nunca, sus equipos siguen igual, no se ofrece en el asistente y se puede eliminar). Las plantillas `file` son de solo lectura en la interfaz («Duplicar» crea una `local` sin clave). La migración `perfil` quitó `builtin` (todas las filas existentes, también las predefinidas de 2.x, quedan `local` con su clave), añadió `source`, `sourceFile` y `retiredAt`, cambió el nombre del laboratorio por defecto a «Relay Manager» y dejó `EquipmentNetwork.equipmentIp` sin valor por defecto (nula hasta que se configure; los valores existentes se conservan). La migración `accesses_and_cables` solo crea tablas (no redefine ninguna), así que no hay riesgo de borrado en cascada. La migración `equipment_network` crea `EquipmentNetwork` y añade las columnas de `EquipmentAccess` con `ALTER TABLE … ADD COLUMN` (sin redefinir la tabla); los accesos existentes quedan en modo `ip`. La migración `equipment_ssh_profile` solo crea `EquipmentSshProfile`. La migración `user_theme` solo hace `ALTER TABLE "User" ADD COLUMN "theme" TEXT` (sin redefinir la tabla, así que ni `_UserRoles` ni las reservas se tocan); los usuarios existentes quedan con el tema nulo.

**Migraciones.** Las genera Prisma en desarrollo y se aplican con un **runner propio** basado en `better-sqlite3` (en el paquete no viaja el motor de Prisma):

- lista `prisma/migrations/*/migration.sql` por orden;
- copia previa (`pre-migrate`) si hay migraciones pendientes y la base de datos ya existía (salvo que haya una `pre-upgrade` de menos de 1 h);
- cada migración va en una transacción con `foreign_keys=OFF` y `foreign_key_check` al final (evita el borrado en cascada silencioso de las tablas redefinidas);
- escribe en `_prisma_migrations` exactamente lo que escribiría Prisma;
- una migración aplicada que este programa no conoce detiene el arranque (código 4); `--dry-run` abre la base de datos en solo lectura.

---

## 6. Servicios

| Servicio (`rt.*`) | Qué hace |
|---|---|
| `bus` | Pub/sub tipado en memoria. Sin persistencia. Un oyente que falla no afecta a los demás. |
| `audit` | Cola secuencial hacia `AuditEvent`; nunca lanza errores hacia quien llama. Oculta cualquier clave que parezca secreta (`pass`, `secret`, `token`, `authorization`, `cookie`, `hash`) como `[oculto]`, limita el detalle a 8 KB y purga cada día a las 04:15 según la retención. |
| `settings` | Caché de la fila `Settings`; publica `settings.changed`. |
| `throttle` | Ventanas de fallos de acceso: 5 en 5 min por IP y usuario (bloqueo 5 min), 20 en 5 min por IP (bloqueo 15 min); código de configuración: 10 por IP y 30 en total cada 10 min. |
| `sessions` | Registro de sesiones vivas (WS y SSE), revalidadas cada 30 s. |
| `reservations` | Reservas con caché; compare-and-set en SQLite (dos reservas simultáneas: un solo ganador); barrido cada 5 s (caducidad) y cada 30 s (usuarios desactivados o sin acceso). |
| `serial` | Descubrimiento, gestor de consolas, captura, identificación, vista previa y el manejador WebSocket. |
| `relays` | Controlador de placas, controladores Devantech y descubrimiento. |
| `accesses` | Accesos de red de los equipos, detección de cables JTAG, `hw_server`, caché de etiquetas de cables (apartado [6.6](#66-accesos-de-red)). |
| `files` | Archivos: la carpeta `RM_FILES_DIR`, sus sesiones de subida, los envíos a equipos, las copias a carpetas del servidor y su API HTTP (apartado [6.7](#67-archivos)). |
| `equipnet` | Red de equipos: adaptadores de red, interfaces VLAN y enrutamiento del servidor, el switch y cómo llega cada acceso Ethernet a su puerto (apartado [6.8](#68-red-de-equipos)). Arranca antes que `accesses`. |
| `ops` | Copias, restauración (solo CLI), comprobaciones de salud e información del sistema. |

### 6.1 Consolas serie

**Descubrimiento.** Se enumera desde **sysfs** (`/sys/class/tty/*/device`), no con `SerialPort.list()`, para que funcione igual en Docker (sin udev). Un sondeo cada 2 s es la referencia; `fs.watch('/dev')` adelanta la detección 300 ms. Un adaptador debe estar estable 800 ms antes de anunciarse (los FT4232H aparecen puerto a puerto). Los puertos se agrupan por dispositivo USB y se ordenan por interfaz (A, B, C, D).

**Identidad de un puerto** (`stableKey`, por orden de preferencia): `usb:<vid>:<pid>:<serie>:if<N>:p<M>` si la serie es única, `path:<ruta USB>:if<N>:p<M>`, `dev:<nombre>` o `virtual:<ruta>`. Nunca `ttyUSBn`. Al reconectar, cada consola vuelve a resolver su asignación contra la lista actual:

- `adapter`: VID + PID + serie + interfaz + puerto (sigue al adaptador aunque cambie de conector);
- `usb-port`: ruta USB física + interfaz + puerto (para adaptadores sin serie única);
- `path`: ruta literal (puertos virtuales o integrados).

El servidor **solo abre rutas de dispositivos descubiertos**: nunca una ruta enviada por un cliente ni sacada de un fichero importado.

**Gestor de consolas.** Mantiene abierto cada puerto asignado y no soltado desde el arranque, con `flock` (otro programa que respete el bloqueo no puede abrirlo). Estados: sin asignar, abriendo, abierta, desconectado, en uso por otro programa, sin permiso, soltado, error. Si falla al abrir, reintenta a 1, 2, 5, 10 y 30 s; cualquier evento de descubrimiento reinicia la espera (por eso un adaptador reconectado se reabre en segundos). Cada consola tiene un historial en memoria de 256 KiB que se envía a quien abre la consola.

**Escritura.** Solo el titular de la reserva, comprobado otra vez en el momento de escribir. Límite de 64 KiB/s por sesión. Intro se traduce al `enterMode` de la consola. Escribir renueva la reserva como mucho una vez por minuto.

**Identificar** es **pasivo**: abre, escucha, clasifica (FSBL, U-Boot, Linux arrancando, login, shell, BITReader, ilegible, silencio) y cierra sin escribir nada. **Enviar retorno de carro** es una acción aparte, solo de administradores, confirmada, auditada, solo sobre puertos libres y sin asignar, y desactivable (`RM_SERIAL_ALLOW_POKE=0`).

### 6.2 Captura continua

Un escritor por consola en `<capturas>/<id de consola>/AAAA-MM-DD[.N].log` (día UTC):

- marca de tiempo al principio de cada línea, `CR LF` → `LF`, bytes intactos;
- marcas de estado (abierto, desconectado, soltado, retomado, borrado, arranque y parada del servidor);
- entrada: por defecto solo marcas `>>> usuario: N bytes`; en modo «Texto completo», el texto va a `.input.log` aparte, visible solo para administradores;
- rotación por tamaño y por día, compresión gzip de días anteriores;
- retención cada hora (y tras cada rotación): por días y por tamaño total, borrando primero de la consola que más ocupa y nunca el fichero activo;
- vigilancia del disco cada 60 s: pausa por debajo de `max(512 MiB, 2 %)`, reanuda con 1 GiB de margen.

### 6.3 Relés

**Controladores** (`src/server/relays/drivers`):

| Controlador | Protocolo | Encendido absoluto | Pulso |
|---|---|---|---|
| `devantech-ds-ascii` | TCP 17123: `SR n on\|off [ms]`, `GR n`, `ST` | sí | nativo (≥ 19 ms) |
| `devantech-ds-http` | `GET /index.xml` y `/dscript.cgi?<toggleVar>=n` | emulado (leer, comparar, conmutar) | emulado |
| `devantech-eth` | TCP 17494 binario (`0x10`, `0x20`, `0x21`, `0x24`, clave `0x79`/`0x7A`); escritura opcional por HTTP `io.cgi` | sí | nativo (pasos de 100 ms) |
| `simulated` | en memoria (solo con `RM_RELAY_SIMULATE=1`) | configurable | configurable |

El número de relés es el **físico**, de la tabla de modelos (respuesta a `ST`, id de módulo UDP o las etiquetas de `/index.xml`), nunca el número de etiquetas `RlyN` (siempre 32). La `toggleVar` de las dS HTTP se aprende de la página de cada placa; no hay valor por defecto.

**Controlador.** Una cola (mutex de promesas) por placa: sondeo, escritura, verificación y refresco pasan por ella. Sondeo cada 5 s (15 s si no responde); con 0 placas no hay temporizadores. Cada escritura se **verifica** leyendo el estado (hasta 5 lecturas cada 150 ms). La reserva se comprueba antes y otra vez dentro de la cola. Un relé con confirmación exige `confirmed: true` para apagar o pulsar.

**Descubrimiento** (protocolo «Discoverer» de Microchip, UDP 30303):

- **Pasivo** (activo por defecto): solo recibe. Acotado: datagramas de más de 1472 bytes descartados, 200 por segundo como máximo, 256 placas conocidas como máximo. Nunca provoca una consulta.
- **Activo** (botón): petición a la difusión dirigida de cada interfaz local (nunca `255.255.255.255`; se saltan `docker*`, `br-*`, `veth*`, VPN…), 3 veces, y consulta de solo lectura a las placas que responden dentro de las redes locales.
- **Escaneo** (botón, auditado): TCP y HTTP de solo lectura sobre redes /22 o menores.
- Todas las sondas son de **solo lectura** por construcción (`safety.ts` rechaza cualquier byte o ruta que pueda actuar un relé).
- La IP es siempre la de origen del datagrama. Un anuncio **nunca** cambia la IP guardada de una placa (UDP se puede falsificar): una MAC conocida en otra IP aparece como «IP cambiada» y un administrador decide.

### 6.4 Reservas

Reglas principales (`src/server/services/reservations.ts`):

- Reservar un equipo libre o caducado es atómico (compare-and-set): de dos peticiones simultáneas gana una; la otra recibe `RESERVED_BY_OTHER`.
- Renovar: botón «Mantener», escritura en consola (como mucho cada 60 s) o uso de relés. Nunca por tener la página abierta.
- Caducidad: barrido cada 5 s. Cada 30 s se liberan las reservas de usuarios desactivados o borrados (`user-removed`) y de quienes han perdido el acceso al equipo (`access-lost`).
- Forzar liberación: solo administradores, con motivo; avisa al titular.
- Todo cambio (incluida una renovación por escritura) se publica con `serverNow`, para que las cuentas atrás de todos sigan la hora del servidor.

### 6.5 Copias y salud

Las copias usan la API de copia en línea de SQLite (segura con WAL), verifican `integrity_check` y escriben un `.json` al lado. La restauración solo existe en la CLI, con el servidor detenido (bloqueo de instancia). Las comprobaciones de salud (`src/server/ops/health.ts`) las comparten `doctor` y Sistema → Salud; las órdenes externas se ejecutan sin shell, con 2 s de límite y un entorno mínimo.


### 6.6 Accesos de red

Cada acceso (`EquipmentAccess`) escucha en **su** puerto del rango `RM_ACCESS_PORTS` (3201–3230 por defecto) en `RM_ACCESS_BIND`, con sockets propios del servicio `rt.accesses`: el servidor HTTP sigue escuchando solo en `RM_PORT`.

**Estado de cada acceso** (en este orden): desactivado → «Cerrado»; algo lo impide aunque se reservara → «Sin configurar» (sin cable, consola, destino o puerto del switch), «Falta hw_server», «Cable no conectado», «Sin consola», «Sin red de equipos»; apertura `reserved` y equipo sin reserva → «Cerrado» (`not-reserved`); si no, se abre: «Arrancando» → «Abierto», o «Puerto ocupado» / «Error» (reintento cada 10 s, o con espera 1–30 s para `hw_server`). Cada cambio se publica como `access.status` (audiencia: el equipo) y se audita (`access.start`, `access.stop`, `access.error`). Las reservas (`onChange`), la detección de cables (sondeo de `<RM_JTAG_SYS_ROOT>/bus/usb/devices` cada `RM_SERIAL_SCAN_INTERVAL_MS`) y las recargas tras guardar un equipo vuelven a evaluar los accesos afectados, cada uno en su propia cola.

**JTAG.** Los cables se detectan por sysfs, sin libusb ni udev: Xilinx (VID 03fd), Digilent (VID 1443 o descriptor «Digilent», como el JTAG-HS2/HS3/SMT sobre FTDI) y FTDI que dicen «JTAG». Se identifican por su número de serie, que es también el filtro de `hw_server`. Por acceso abierto, un `ProcessSupervisor` lanza (sin shell, en su propio grupo de procesos, con `HOME` y `TMPDIR` en `<datos>/xilinx`):

```
hw_server -s tcp:<bind>:<puerto> -p0 -e "set jtag-port-filter <serie>"
```

(`tcp::<puerto>` con `0.0.0.0`). `-p0` desactiva los servidores GDB (puertos 3000–3005, que chocarían entre instancias y quedan fuera del rango del laboratorio). El acceso está «Abierto» cuando el puerto acepta conexiones (hasta 60 s); si el proceso termina se reinicia con espera 1, 2, 5, 10 y 30 s (se reinicia la espera tras 60 s estable). Su salida va al registro (`jtag`). `hw_server` se busca como en BITReader_Tool: `RM_HW_SERVER`, `XSCT`, `VITIS`, `XILINX_VITIS`, `XILINX_VIVADO`, el `PATH` y `/tools/Xilinx`, `/opt/Xilinx`, `~/Xilinx`, `/tools/AMDDesignTools`, `/opt/AMDDesignTools` con las dos estructuras de carpetas, quedándose con la versión más nueva. Como el socket es de `hw_server`, las conexiones se leen de `/proc/net/tcp{,6}` cada 5 s (sin bytes). El filtro es `RM_HW_SERVER_FILTER_FORMAT` (por defecto `{serial}`, el número de serie de sysfs: UG908 admite identificadores parciales; `{vendor}/{serial}` da `Digilent/<serie>` o `Xilinx/<serie>`); un número de serie que no sea `[A-Za-z0-9._:-]` no llega nunca al `-e` (es una línea Tcl de `hw_server`).

**Sesiones remotas y reserva.** En ese mismo sondeo de 5 s, si algún acceso de un equipo reservado tiene una conexión establecida (JTAG por `/proc/net`, consola TCP o reenvío Ethernet), se llama a `reservations.touch(…, "access")`, que renueva la reserva del titular con la cadencia normal (como mucho una vez por minuto, sin auditar). Así una sesión larga de xsdb o Vivado sin tocar la web no pierde la reserva ni ve morir su `hw_server`. La web recibe las conexiones en `access.status`; el `EquipmentProvider` las mantiene en directo y la barra de reserva, el aviso de caducidad y los diálogos de Liberar y Forzar liberación las muestran. Las filas de auditoría de conexión están limitadas a 20 por minuto, acceso e IP de origen. Al arrancar se matan los `hw_server` que quedaran de una ejecución anterior (ficheros `<datos>/run/hw_server-<puerto>.pid`).

**Consola serie por TCP.** Un `SerialBridge` por acceso se suscribe al gestor de consolas como un *tap* (`attachTap`): recibe el final del historial (64 KiB), los mismos bytes que los WebSocket y los cambios de estado, sin contar como espectador y **sin abrir el tty otra vez**. La entrada se escribe tal cual (`writeFromTap`, sin traducir Intro), con límite de 64 KiB/s por conexión, marcas `>>> tcp <IP>` en la captura y renovación de la reserva del titular; solo mientras el equipo está reservado (en un acceso `always` sin reserva la conexión es de solo lectura). Soltar el puerto, perderlo o retomarlo se avisa con líneas `*** … ***`; borrar o reconfigurar la consola cierra la conexión. Un cliente con más de 4 MiB pendientes se desconecta.

**Ethernet.** Un `TcpForward` por acceso conecta cada cliente con `destino:puerto` (`pipe` en ambos sentidos, con contrapresión y medio cierre, 5 s para conectar, *keep-alive*). El tráfico de entrada renueva la reserva como mucho cada 30 s. El destino se prueba al abrir y cada 5 min (y con cada conexión). En modo `switch` el destino es la IP de los equipos y la conexión sale con `localAddress` = la dirección del servidor en la VLAN de ese puerto, que el enrutamiento por origen manda por su interfaz (apartado [6.8](#68-red-de-equipos)); si la VLAN no está lista, el acceso queda en «Sin red de equipos» (`network-missing`) y `rt.equipnet.onRoutesChanged` lo vuelve a evaluar. El estado lleva `network` (puerto, VLAN, enlace, destino, VLAN lista).

**Límites y cierre.** `RM_ACCESS_MAX_CONNECTIONS` conexiones por acceso (serie y Ethernet). Al liberar la reserva (política `reserved`), desactivar, cambiar o borrar un acceso, las conexiones se cierran con un aviso y `hw_server` se para. Cada conexión se audita (`access.connect`/`access.disconnect`, actor «cliente TCP» con la IP, duración y bytes).

**Puertos.** Al crear o editar: los fijos deben estar en el rango, no ser `RM_PORT` ni estar en uso por otro equipo (`port` es único en la tabla) ni por otro programa (prueba de `listen` en el momento de guardar); los vacíos reciben el más bajo libre (misma función pura que la vista previa del asistente, `src/lib/accesses/ports.ts`). Un cable JTAG solo puede estar en un acceso.

**Cables etiquetados.** `CableLabel` da nombre a un cable JTAG (por su serie) o a un adaptador USB-serie (por su identidad). La etiqueta solo se crea para un cable conectado (el descriptor sale de la detección, nunca del cliente). El servicio guarda las etiquetas en caché: las usa para nombrar los cables en los DTO, el nombre de los adaptadores en la instantánea serie (`serial.setAdapterLabels`) y `lastSeenAt`; tras cada cambio publica `cable-labels.changed` y `jtag.changed`.

### 6.7 Archivos

Intercambio de ficheros entre los PC y las carpetas compartidas del anfitrión, sin relación con equipos ni reservas. Código en `src/server/files/` (grafo A, `rt.files`), la página en `src/app/(app)/archivos` y `src/components/files`, lo común en `src/lib/files` y `src/lib/contracts/files.ts`.

**Raíces.** Dos carpetas (`FILES_ROOTS = ["tftp", "extra"]`): **tftp** (`RM_FILES_DIR`, `~/tftp`) y una **segunda carpeta compartida** opcional, la raíz `extra` (`RM_FILES_EXTRA_DIR`), que solo existe si el perfil o `config.env` le dan nombre (`RM_FILES_EXTRA_NAME`; `RM_FILES_EXTRA_ENABLED=0` la quita). Su nombre y su descripción (`RM_FILES_EXTRA_HINT`) vienen de la configuración y llegan a la página con sus datos: no hay ninguna etiqueta fija en el código. Su carpeta por defecto es `~/<nombre>` en portátil y desarrollo, `<datos>/<nombre>` en `native` (salvo la que escribe `install.sh` en `config.env`, la de la carpeta personal del usuario que instala) y `/extra` en Docker; salud: `data.extra`. Hay **un núcleo de Archivos por raíz** (`createFilesCore` con `{id, dir, reserved}`): cada uno con su carpeta real, sus subidas, sus reglas de rutas y sus descriptores, así que nada de lo de abajo cambia por haber dos; una ruta nunca cruza de una raíz a otra (mover es dentro de la raíz). Toda la API lleva la raíz (`root=` en la consulta o `root` en el cuerpo; sin ella, `tftp`; una desconocida, 400) y la página `?raiz=extra&ruta=…`. `files.changed` lleva `root`, la auditoría `detail.root`, y los envíos a equipos y las copias a carpetas del servidor abren el origen en su raíz (`openSource(root, rel)`). La segunda carpeta reserva el nombre `.descargas` en su raíz (fue la carpeta de trabajo de las descargas en las primeras pruebas; hoy trabajan en los datos del servicio): no se lista, no entra en los comprimidos y cualquier operación de un usuario sobre ella responde como si no existiera. Las dos carpetas comparten el grupo `relay-files` y el *drop-in* de systemd (`BindPaths=` de cada una).

**Dónde vive cada operación.**

| Operación | Cómo | Por qué |
|---|---|---|
| Listar (`GET /api/files/list?root=&path=`), descargar (`GET|HEAD /api/files/download?root=&path=`), carpeta o selección comprimida (`GET /api/files/archive?root=&format=zip|tar.gz&dir=&name=…`), subir (`POST /api/files/upload` con `root`, `PUT /api/files/upload/<id>?offset=`, `DELETE /api/files/upload/<id>`) | API HTTP propia del grafo A, atendida en el `'request'` del servidor **antes** de Next | Next limita o copia en memoria los cuerpos de las peticiones que pasan por `proxy.ts` y puede comprimir respuestas (rompe `Content-Length` y `Range`); aquí todo va en *streaming* con contrapresión. |
| Nueva carpeta, cambiar nombre, mover, borrar | *server actions* (`src/actions/files.ts`, `defineAction`) | Mutaciones pequeñas: la convención general. |
| Primer listado de la página | consulta `getFilesPage` (RSC) | La página llega pintada; después el cliente relee `/api/files/list`. |

La API usa la misma autenticación que el WebSocket (cookie, usuario leído de la base de datos, `sessionVersion`, límite de 72 h; `mustChangePassword` → 403) y el filtro de Origin de siempre para POST/PUT/DELETE. Los errores son JSON `{ error, message }` con el mensaje en español (`NO_SPACE` → 507, `TOO_LARGE` → 413, `EXISTS`/`OFFSET` → 409…). `RM_FILES_ENABLED=0` responde 404 y quita la entrada de la navegación de la página.

**Rutas seguras** (`paths.ts`). La ruta del cliente es relativa, con `/`; se rechazan las absolutas, `.`, `..`, los segmentos vacíos y NUL antes de tocar el disco (el parámetro de la URL se decodifica una sola vez). Todo se resuelve contra el `realpath` de la carpeta: los enlaces simbólicos se siguen solo si su destino real sigue dentro; renombrar o borrar un enlace actúa sobre el enlace.

**Sin carreras con quien escribe en la carpeta.** Comprobar una ruta y operar después sobre la misma cadena deja una ventana: el dueño de la carpeta (por SSH) podría cambiar una subcarpeta por un enlace a `/var/lib/relay-manager` entre las dos cosas. Por eso **cada operación se ancla a un descriptor** de la carpeta en la que actúa: la carpeta se abre con `O_DIRECTORY | O_NOFOLLOW`, se comprueba con `/proc/self/fd/<n>` que está dentro, y la operación usa `/proc/self/fd/<n>/<nombre>`, que el núcleo resuelve a través del descriptor abierto (como las llamadas `*at()`, que Node no ofrece), no volviendo a leer la ruta. Así funcionan listar, crear carpetas, renombrar, mover, subir (la carpeta de destino queda abierta toda la subida) y los archivos comprimidos (cada subcarpeta se abre antes de leerla). El borrado de carpetas (`rmTree`) abre cada subcarpeta sin seguir enlaces antes de vaciarla: un cambio a mitad detiene el borrado. Al abrir un fichero para leer se usa `O_NOFOLLOW | O_NONBLOCK` (un FIFO no bloquea), `fstat` (fichero normal) y la comprobación del descriptor. Las pruebas `race.test.ts` hacen el cambio en el peor momento de cada operación. La carpeta nunca puede contener los datos, las copias ni las capturas (lo comprueban el cargador de configuración y el servicio con rutas reales). Los nombres nuevos (`validateNewName`) no admiten `/`, `\`, caracteres de control, espacios al principio o al final, más de 255 bytes ni el prefijo de los temporales.

**Subidas por fragmentos.** `POST` abre una sesión (nombre, tamaño, carpeta y qué hacer si el nombre existe: `fail`, `overwrite` o `rename`) tras comprobar el nombre, el máximo (`RM_FILES_MAX_UPLOAD_MB`), la carpeta de destino y el espacio libre (con 256 MiB de reserva y lo pendiente de otras subidas); crea `.rm-upload-<id>.part` (0600, `O_EXCL`) en la **misma carpeta** de destino. Cada `PUT` escribe un fragmento en su posición (como mucho 64 MiB; el navegador ajusta el tamaño para tardar unos 4 s, así ninguna petición se acerca al `requestTimeout` de 60 s del servidor). Un `offset` distinto de lo recibido responde 409 con `received`, así que un fragmento perdido se reanuda. Con el último: `ftruncate` al tamaño exacto, `fsync`, `fchmod 0664` (el `umask` del servicio es 0027 y el grupo debe poder escribir) y **confirmación atómica**: `rename` para reemplazar (nunca una carpeta) y, si no, enlace duro + `unlink` (no sobrescribe nunca; sin enlaces duros, comprobar y renombrar), probando `nombre (n).ext` si el nombre ya se ha ocupado. `ENOSPC`/`EDQUOT` borran el temporal y responden 507 con el mensaje; el cuerpo de la petición no se destruye para que la respuesta llegue. Sesiones sin actividad 15 min, al cancelar y al parar el servidor: se borra el temporal; al arrancar se borran (en segundo plano, acotado) los `.part` de más de 1 h.

**Descargas.** Un fichero: `Content-Length`, `Content-Disposition` con `filename*` UTF-8, `ETag` débil, `Last-Modified`, `Range` de un intervalo (206/416) e `If-Range`, así que el navegador reanuda las descargas cortadas. Carpetas y selecciones: un archivo generado mientras se envía, sin copias ni búfer completo: **ZIP** (`zip.ts`: ficheros almacenados sin comprimir, descriptores de datos, nombres UTF-8, ZIP64 por entrada cuando el fichero o el desplazamiento pasa de 4 GiB y registro final ZIP64) o **tar.gz** (`tar.ts`: ustar con registros pax para nombres largos o no ASCII y tamaños de más de 8 GiB, comprimido con `node:zlib`). Cada fichero se abre justo antes de escribir su cabecera y se leen como mucho los bytes vistos al abrirlo. Los enlaces que salen de la carpeta, rotos o a carpetas y los ficheros especiales no se incluyen y se listan en `_OMITIDOS.txt`. Si el cliente se va, la tubería se corta y se cierra el fichero en curso. Sin dependencias nuevas: las pruebas extraen los archivos con `unzip`, `tar` y `zipfile` de Python.

**En directo y auditoría.** Cada cambio publica `files.changed` (`dirs`, `change`, `names`, `byName`; audiencia: todos). La página relee la carpeta con ese evento si le afecta, al terminar una subida propia, al volver el foco, tras reconectar el SSE y cada 30 s (lo copiado por otros medios). Se auditan `files.upload` (ruta, tamaño, nombre pedido si cambió, reemplazo), `files.download` (ficheros y archivos comprimidos, con el formato; un `Range` que no empieza en 0 no cuenta), `files.mkdir`, `files.rename`, `files.move` y `files.delete`. El borrado se puede limitar a administradores (`RM_FILES_DELETE=admins`), y entonces también reemplazar al subir; la denegación queda como `auth.denied`. Los mensajes de error no dicen la ruta de la carpeta en el servidor (solo Sistema → Salud, para administradores). Límites: 6 subidas en curso por usuario y 64 en total, 10 000 elementos por listado, 200 000 por archivo comprimido, y una descarga cuyo cliente deja de leer 2 min se corta.

**Enviar a equipo** (`src/server/files/send/`). Copia un fichero de la carpeta a un equipo por SSH desde el propio servidor.

| Módulo | Qué hace |
|---|---|
| `rules.ts` | Puro: quién puede enviar (el titular de la reserva, o cualquiera si el acceso Ethernet es `always`, y solo con el acceso activo; la visibilidad por roles la decide antes `access.ts`) y qué acceso Ethernet se usa si hay varios (activo, luego el de destino 22, luego el primero). |
| `transfer.ts` | Un envío: conexión TCP, sesión SSH, destino, SFTP o scp, verificación, limpieza. Errores tipados (`SendError`) con el mensaje en español. |
| `scp.ts` | El lado que envía del protocolo scp (`C<modo> <tamaño> <nombre>`, datos, `\0`, acuses 0/1/2) sobre el canal de `scp -t <carpeta>`. |
| `remote-cmd.ts` | Las órdenes en el equipo: cada ruta es **absoluta** y va entre comillas simples (`shq`), así que nada se expande ni se toma por una opción; solo `sh` POSIX y applets de busybox. |
| `service.ts` | Lista de equipos, cola, límites, eventos, auditoría, credenciales recordadas y huellas. |

- **Ruta.** La misma que el reenvío del acceso Ethernet (`TcpForward`): se conecta a `destino:puerto` del acceso (el puerto SSH es el `targetPort` del acceso, 22 por defecto) y, en modo `switch`, con `localAddress` = la dirección del servidor en la VLAN de ese puerto (`rt.equipnet.route()`), que el enrutamiento por origen manda por su `rmv<vid>`; `EADDRNOTAVAIL` da el mensaje «La VLAN del puerto N no está lista…» y nunca se reintenta desde otra dirección. Nunca pasa por el puerto público del acceso. El socket TCP se abre aquí (8 s) y se entrega a `ssh2` (`sock`), así los errores de red se distinguen: sin enlace en el puerto del switch, no responde, no acepta SSH (`ECONNREFUSED`).
- **SSH.** Contraseña (y *keyboard-interactive* con la misma contraseña), 20 s para la sesión, *keep-alive* cada 10 s, y un vigilante que corta si en 30 s no avanza nada. **Claves del equipo:** todos tienen la misma IP, así que no se fijan por dirección (`known_hosts` no sirve): se acepta cualquiera, se calcula la huella como OpenSSH (`SHA256:` + base64) y se guarda por equipo tras un acceso correcto; si cambia, el envío sigue y la fila y la auditoría lo avisan.
- **Destino** (`src/lib/files/remote-path.ts`, compartido con el diálogo). `~` y `~/…` (y lo relativo) cuelgan de la carpeta personal (`realpath(".")` por SFTP, o `echo "$HOME"`); lo absoluto va tal cual; se rechazan `~otro`, los caracteres de control y más de 1024 caracteres. Carpeta existente → dentro con su nombre; si no, es el nombre final (su carpeta debe existir; terminada en `/` debe ser carpeta; con varios ficheros, carpeta). Un fichero con ese nombre se reemplaza; una carpeta con ese nombre es un error.
- **SFTP** si el servidor tiene el subsistema: comprueba el espacio (`statvfs@openssh.com` o `df -Pk`), abre `.rm-send-<aleatorio>.part` en la carpeta de destino, escribe con 32 peticiones de 32 KiB en vuelo (contrapresión: se lee el siguiente trozo del fichero cuando hay hueco), `fchmod` 0644 (0755 si el origen es ejecutable), cierra y renombra con `posix-rename@openssh.com` (atómico, reemplaza) o, sin esa extensión, borra el destino y renombra. SFTP v3 no tiene un estado de «disco lleno» (OpenSSH responde `Failure`): tras un fallo de escritura se mira el espacio libre para decirlo. **scp** si no hay SFTP (dropbear sin `sftp-server`): el mismo temporal por `scp -t <carpeta>`, respetando la contrapresión del canal, y después `chmod … && mv -f …`; `scp` no encontrado (127) → «El equipo no tiene SFTP ni scp». **Verificación:** tamaño (`stat` o `wc -c`) y suma `sha256sum` (o `md5sum`) calculada a la vez que se lee el fichero; sin ninguna de las dos (o sin `exec`) es «no verificable». Cancelar, un error o un corte borran el temporal (como mucho 3 s; tras cancelar, la conexión se corta a los 5 s pase lo que pase).
- **Origen.** El fichero se abre con `core.openDownload` (rutas relativas, `O_NOFOLLOW`, comprobación del descriptor) y se lee por posición; si cambia de tamaño mientras se envía, el envío falla. Nombres con saltos de línea o caracteres de control no se envían.
- **Cola y límites.** 3 envíos a la vez por usuario y 8 en el servidor; los demás en cola (hasta 40 pendientes por usuario; como mucho 20 ficheros por petición). La autorización se comprueba al pedir y otra vez al empezar cada envío; `reservations.onChange` cancela los envíos de un equipo cuya reserva pierde el usuario (salvo acceso `always`), y mientras dura un envío se renueva la reserva (`touch`, como las sesiones remotas). La contraseña solo está en memoria mientras queda algún envío de esa petición. Los terminados se guardan 1 h (50 por usuario). Al parar el servidor se cancelan.
- **Credenciales recordadas.** «Recordar para este equipo» guarda usuario, ruta y contraseña (`sealSecret` con `SSH_SECRET_INFO`) solo cuando el acceso ha funcionado; una contraseña `null` en la petición usa la guardada; sin marcar, se olvida. La contraseña nunca sale del servidor (el DTO dice `passwordSaved`), nunca se registra ni se audita.
- **API** (grafo A, con la autenticación y el filtro de Origin de Archivos): `GET /api/files/send/targets` (equipos visibles con acceso Ethernet: ruta, enlace, reserva, si se puede y por qué no, lo recordado sin la contraseña, la huella), `GET|POST|DELETE /api/files/send` (mis envíos, empezar —202—, quitar los terminados), `DELETE /api/files/send/<id>` (cancelar) y `DELETE /api/files/send/profile/<equipo>` (olvidar). El progreso va por el SSE como `files.send` solo al usuario que envía (como mucho cada 0,5 s por envío, velocidad suavizada); la página lee `GET /api/files/send` al abrirse y tras reconectar.
- **Auditoría.** `files.send` (quién, fichero, tamaño, equipo, `usuario@ruta`, por dónde, protocolo, resultado —`enviado`, `error`, `cancelado`— y el error, `verificado (sha256)` o `no verificable`, reemplazado, huella y si cambió; `denied` si no tenía permiso) y `files.send.login` (credencial `guardada`, `conservada` u `olvidada`, usuario y ruta).

**Copiar a una carpeta del servidor** (`src/server/files/copy/` y `src/server/rootcopy/`; solo administradores). Copia ficheros de la carpeta a cualquier carpeta permitida del propio anfitrión, sobre todo a un pendrive. Es lo que pidió el usuario: «que haga el `cp` como `sudo`, solo eso». Como el servicio lo puede hacer él mismo cuando tiene permiso; si no, **«como administrador (sudo)»** a través de un **ayudante de root** aparte, con la contraseña del usuario que instaló la aplicación (no se pregunta ningún nombre de usuario). El servicio no gana nunca privilegios: mantiene `NoNewPrivileges` y su sandbox, lee el origen de su propia carpeta y le **envía los bytes** al ayudante, que solo los escribe.

| Módulo | Qué hace |
|---|---|
| `copy/policy.ts` | Puro (también va en el ayudante): rutas absolutas normalizadas (`normalizeAbs`: sin `.`, `..`, NUL ni caracteres de control), raíces permitidas (`RM_COPY_ROOTS`, `/` por defecto), lista prohibida sobre la **ruta real** (`/proc`, `/sys`, `/dev`, `/run` salvo `/run/media`, `/boot`, `/etc`, `/usr`, `/bin`, `/sbin`, `/lib*`, `/var/lib/relay-manager`, `/var/lib/relay-manager-rootcopy`, `/opt/relay-manager`, más `RM_COPY_DENY` y las carpetas de datos, copias, capturas, aplicación y configuración; nunca `/` misma) y dónde puede escribir root (`RM_COPY_ROOT_PATHS`, por defecto `/media`, `/run/media`, `/mnt`). |
| `copy/mounts.ts` | «Unidades USB y discos»: `/proc/self/mountinfo` (con `\040` y compañía) y sysfs (`/sys/dev/block/<mayor:menor>`: `removable` del disco padre y si cuelga de USB, porque un disco USB dice `removable=0`), etiqueta de `/dev/disk/by-label` (o el nombre del punto de montaje). Ofrece lo montado bajo `/media`, `/run/media` y `/mnt` (no esas carpetas, que la sandbox monta) y cualquier montaje de un dispositivo extraíble o USB; nunca sistemas de ficheros virtuales, `/boot`, `/snap`, Docker. Además, los dispositivos extraíbles **sin montar** (`/sys/block` y sus particiones; tipo, etiqueta y UUID de `/run/udev/data` o `/dev/disk/by-*`; tamaño y modelo de sysfs) y si un montaje se puede expulsar. Solo lee, sin privilegios: montar y expulsar los hace el ayudante de montaje. |
| `copy/safe-dest.ts` | Compartido por el servicio y el ayudante. Abre la carpeta de destino **componente a componente** desde `/` con `O_DIRECTORY \| O_NOFOLLOW` a través del descriptor del componente anterior (`/proc/self/fd/<n>/<nombre>`, como `openat()`) y comprueba que `/proc/self/fd/<n>` es esa ruta real; todo lo demás va por ese descriptor. Escribe en `.rm-copy-<aleatorio>.part` (0600, `O_EXCL`), `fsync`, **vuelve a leer** el temporal y compara su sha256 con lo recibido, `fchmod 0644`, (como root) `fchown` al dueño de la carpeta de destino, y confirma: **Reemplazar** con `rename` (nunca una carpeta; un enlace en el destino se sustituye, no se sigue), **Conservar ambos** con enlace duro + `unlink` probando `nombre (n).ext` (sin enlaces duros, en vfat/exfat, comprobar y renombrar), **Omitir** sin escribir nada. Cancelar o fallar borra el temporal. Nueva carpeta (0755) y lista de subcarpetas (las ocultas, a petición; como mucho 2000). |
| `copy/protocol.ts` | El protocolo del ayudante: una petición por conexión, JSON por líneas (cabecera de 16 KiB como mucho). `ping`; `probe` (autentica, comprueba el destino y opcionalmente lista sus carpetas), `mkdir` y `copy` (`{dir, name, size, conflict, password}`; tras `{"type":"ready"}` llegan exactamente `size` bytes; respuestas `progress`, `verifying` y un `result` o `error` final). Cerrar la conexión cancela. Sin campo de usuario: si llega uno, se ignora. |
| `copy/helper-client.ts` | El lado del servicio: conecta al socket, escribe la cabecera (su búfer se pone a cero después), envía el fichero con contrapresión y lee las líneas. Socket ausente, rechazado o sin permiso = «El ayudante de copia como administrador no responde». |
| `copy/service.ts` | El servicio (`rt.files`): solo administradores, información (unidades, raíces, estado del ayudante), navegador de carpetas (como el servicio, o como root con la contraseña), nueva carpeta, cola, progreso, cancelar y auditoría. |
| `copy/root-status.ts` | Si «como administrador» está disponible y, si no, por qué y qué hacer (lo usan el diálogo y Salud/`doctor`). |
| `rootcopy/auth.ts` | Quién autentica y cómo: la cuenta `RM_SUDO_USER` de la configuración propia del ayudante; `crypt(3)` del sistema; límite de intentos. |
| `rootcopy/server.ts` | El ayudante: autentica cada petición salvo `ping`, vuelve a validar el destino por su cuenta y escribe con `safe-dest.ts`. Dos copias a la vez como mucho; 60 s sin datos cancelan. |
| `rootcopy/main.ts` | Entrada de `app/rootcopy.js`: como root solo por activación de socket, configuración en `/etc/relay-manager/rootcopy.env`, cuentas en `/etc/passwd`, `/etc/group` y `/etc/shadow`, estado en `$STATE_DIRECTORY`; sale a los 2 min sin conexiones. Las variables `RM_ROOTCOPY_*` (pruebas) se ignoran si corre como root. Con el argumento `mount` arranca el ayudante de montaje. |
| `rootcopy/token.ts` | Los permisos de administrador de 5 minutos: HMAC-SHA256 con la clave del ayudante (`token.key`, 0600, en su estado), carga `{sid, wu, iat, exp, jti}`, comprobación en tiempo constante, caducidad absoluta y anulaciones (`revoked.json`) hasta que caducan. |
| `rootmount/` | El ayudante de montaje (`relay-manager-rootmount`, sin espacio de montaje propio): valida el dispositivo (extraíble o USB, nunca un disco con algo montado fuera de `/media`, `/run/media`, `/mnt`, *swap* ni `holders`), `blkid -p`, crea la carpeta en `/media/<RM_SUDO_USER>/`, `mount` con `nosuid,nodev,noexec` (y `uid`/`gid=relay-files`/máscaras en FAT, exFAT y NTFS); `sync` + `umount` + `rmdir` para expulsar. Solo acepta conexiones de root (socket 0600). |

- **Como el servicio.** La ruta del diálogo se normaliza, se resuelve con `realpath` y se comprueba contra las raíces y la lista prohibida; la carpeta se abre sin seguir enlaces (`safe-dest.ts`) y, si el servicio no puede escribir (permisos o montaje de solo lectura), la API responde 403 con `needsRoot: true` y el diálogo ofrece «Copiar como administrador (sudo)». La unidad del servicio añade `ReadWritePaths=-/media -/run/media -/mnt` para esto. El fichero queda del usuario del servicio, 0644.
- **Como administrador.** `POST /api/files/copy` con `asRoot: true` primero hace un `probe` (contraseña y destino) para que una contraseña mala falle antes de encolar nada; después cada copia abre su propia conexión con la contraseña, que solo vive en memoria mientras queda alguna copia de esa petición. El servicio lee el origen con `core.openDownload` (rutas relativas, `O_NOFOLLOW`, descriptor comprobado) y calcula su sha256 mientras lo envía; el resultado del ayudante debe traer la misma suma. Al terminar comprueba que el origen no ha cambiado de tamaño.
- **Cola y límites.** 2 copias a la vez por usuario y 3 en el servidor; las demás en cola (hasta 40 pendientes por usuario; 20 ficheros por petición). Las terminadas se guardan 1 h (50 por usuario). Al parar el servidor se cancelan.
- **API** (grafo A, con la autenticación y el filtro de Origin de Archivos): `GET /api/files/copy/info` (unidades, dispositivos sin montar, si se puede montar y el permiso de la sesión), `GET /api/files/copy/browse?path=&hidden=1` (como el servicio, o por el ayudante si la sesión tiene permiso) y `POST /api/files/copy/browse` (`{path, hidden, password|null}`, como root), `POST /api/files/copy/mkdir` (`{dir, name, asRoot, password|null}`), `POST /api/files/copy/mount`, `POST /api/files/copy/unmount`, `DELETE /api/files/copy/elevation`, `GET|POST|DELETE /api/files/copy` (mis copias, empezar —202—, quitar las terminadas) y `DELETE /api/files/copy/<id>` (cancelar). Los cuerpos con la contraseña se leen con sus búferes puestos a cero; nunca se registran ni se devuelven. Quien no es administrador recibe 403 (y `canCopy` es falso en la página, que no muestra la opción); `RM_COPY_ENABLED=0` responde 404. El progreso va por el SSE como `files.copy`, solo al usuario que copia.
- **Auditoría.** `files.copy` (fichero, tamaño, destino, `asRoot`, `rootUser` —la cuenta sudo que autenticó—, política de nombres, resultado —`copiado`, `omitido`, `cancelado`, `error`—, nombre final, si reemplazó y `verificado (sha256 …)`); `denied` para quien no es administrador y para las contraseñas rechazadas o bloqueadas (con `code`); `files.copy.mkdir`. Nunca la contraseña.

**Permisos de administrador (elevación).** Una contraseña correcta enviada con `issue` y la sesión (`sid` = sha256 de usuario, versión de sesión y hora de acceso; `webUser`) devuelve, además del resultado, un **permiso firmado** por el ayudante que caduca a los 5 minutos (`ELEVATION_TTL_MS`). El servicio lo guarda en memoria por sesión (`Map<sid, {token, expiresAt, userId, rootUser}>`) y **nunca lo envía al navegador** (solo `CopyElevationDTO {until, user}`); en cada operación como administrador de esa sesión (`password: null`) presenta `{token, session}`, y el ayudante comprueba firma, caducidad, sesión, usuario web y anulación. Un permiso que no vale (`TOKEN`) se borra y la API responde 403 `needsPassword`; no cuenta como intento fallido ni espera. `DELETE /api/files/copy/elevation` («Olvidar permisos») lo borra y lo anula en el ayudante (`revoke`). Con permiso, `GET /api/files/copy/browse` de una carpeta que el servicio no puede leer la lista por el ayudante (`op: "list"`: carpetas y ficheros, solo metadatos con `lstat`; nunca abre un fichero; cualquier carpeta de `RM_COPY_ROOTS` salvo `/proc`, `/sys`, `/dev` y los estados de los ayudantes); sin permiso responde `needsElevation` y el diálogo pide la contraseña («Esta carpeta necesita permisos de administrador»). La lista prohibida sigue valiendo para escribir.

**Montar y expulsar** (`POST /api/files/copy/mount {device, password}`, `POST /api/files/copy/unmount {mountPoint, password}`; administradores). El servicio pasa la petición al ayudante de copia, que autentica (contraseña o permiso) y la reenvía al **ayudante de montaje** por su socket `root:root` 0600 (protocolo de una línea, `MountRequest`); este lo vuelve a validar todo y monta en el espacio de montaje del sistema. El montaje llega al servicio por propagación (su espacio de montaje es esclavo del sistema y `/media` está en sus `ReadWritePaths`): en FAT, exFAT y NTFS, con `gid=relay-files` y máscaras de grupo, el servicio escribe en el pendrive él mismo (`serviceWritable`). Se auditan `files.copy.mount` y `files.copy.unmount` (dispositivo, punto de montaje, tipo, `rootUser`, resultado) y `files.copy.elevate` / `files.copy.forget`.

**Descargas** (`src/server/files/export/`; desactivado por defecto: lo activa el perfil con `RM_EXPORT_ENABLED=1` y `RM_EXPORT_DOWNLOADER`, relativo a la carpeta del perfil; cualquier usuario con sesión). Nombre, títulos, textos y etiquetas salen de `RM_EXPORT_NAME`, `RM_EXPORT_TITLE`, `RM_EXPORT_DESCRIPTION`, `RM_EXPORT_APP_LABEL`, `RM_EXPORT_VERSION_LABEL` y `RM_EXPORT_EXTRACT_LABEL` (sin ella no hay casilla `-x`). Ejecuta el script del perfil con el contrato genérico `spawn(bash, [script, app, versión, "-o", <trabajo>/<zip>, ("-x")])`, nunca una cadena de shell, a través de `setpriv --inh-caps=-all --ambient-caps=-all` (sin la `CAP_NET_ADMIN` ambiental del servicio; sin `setpriv` no se ejecuta), con `cwd`, `HOME` y `TMPDIR` = `<datos>/descargas/<id>` (0700, del servicio: dentro de la carpeta compartida su dueño podría cambiar la carpeta por un enlace mientras el script escribe en rutas) y un entorno cerrado: `PATH` del sistema, `LANG`/`LC_ALL`, `CI=true`, las variables fijas de `RM_EXPORT_ENV_EXTRA` (para herramientas que no deben preguntar; nunca por encima de las anteriores) y, solo si están definidas, la URL y las credenciales `RM_EXPORT_URL`/`RM_EXPORT_USER`/`RM_EXPORT_PASSWORD` con los nombres de `RM_EXPORT_ENV_URL`/`RM_EXPORT_ENV_USER`/`RM_EXPORT_ENV_PASSWORD` (por defecto `EXPORT_URL`/`EXPORT_USER`/`EXPORT_PASSWORD`; nombres en mayúsculas, distintos y nunca del sistema: `PATH`, `HOME`, `LD_*`, `BASH_ENV`, `RM_*`…); nada más de `process.env`. Aplicación y versión: `^[A-Za-z0-9_.+-]{1,100}$`, sin `-` ni `.` al principio. **Una a la vez** en el servidor (proceso propio, `detached`: grupo de procesos), cola de 10 (3 por usuario); cancelar o pasar de `RM_EXPORT_TIMEOUT_MIN` manda `SIGTERM` al grupo y `SIGKILL` a los 5 s. El registro (stdout y stderr, partido en `\n` y `\r`, sin secuencias ANSI ni caracteres de control, líneas de 2000 caracteres, las últimas 2000 líneas) se tacha (la contraseña configurada, la que esté escrita en el propio script como `<RM_EXPORT_ENV_PASSWORD>=`, lo que siga a ese `<nombre>=` en el registro y a `--password=` o `-u usuario:`; como mucho 512 KiB por descarga) antes de guardarlo o publicarlo, y va por el SSE como `files.export` (`{job, lines}`, a ese usuario y a los administradores, cada 300 ms como mucho). Con salida 0, el zip (abierto por el descriptor de la carpeta de trabajo con `O_NOFOLLOW`: un fichero normal, no un enlace) se copia a un temporal de la carpeta de destino del núcleo de la raíz `RM_EXPORT_ROOT` (`extra` si la segunda carpeta está activa; si no, `tftp`) y se coloca sin sobrescribir (`nombre (n).zip`), 0664, y publica `files.changed`; la carpeta de trabajo se borra siempre (y al arrancar, las que quedaran). Se guardan las últimas 20 terminadas con su registro (en memoria). API: `GET /api/files/export` (las propias; todas para administradores; con `ExportInfoDTO`), `POST` (202), `DELETE /api/files/export/<id>` (su dueño o un administrador). Auditoría `files.export` (inicio y final: aplicación, versión, `-x`, destino, zip, resultado, código de salida, duración).

**Navegador.** La cola de subidas (`src/lib/files/upload-engine.ts`, sin React, con el transporte XHR inyectado) vive fuera de los componentes: sigue al cambiar de carpeta o de página. Dos subidas a la vez, reintentos con espera ante errores de red y respuesta 5xx, conflicto de nombres resoluble desde el panel. La navegación entre carpetas cambia `?ruta=` con `history.pushState` (Next sincroniza `useSearchParams`) y lee la carpeta por la API, sin pasar por el servidor de páginas.

### 6.8 Red de equipos

Todos los equipos tienen la misma IP (192.168.1.10). Cada uno va a un puerto de un switch TP-Link Easy Smart; cada puerto `n` es la VLAN 802.1Q `base + n` (100 + n), sin etiqueta, y el puerto de subida (1), cableado a la tarjeta del servidor que elige un administrador (un adaptador USB-Ethernet), es miembro con etiqueta de todas ellas y sin etiqueta de la VLAN 1 (gestión del switch). Código en `src/server/equipnet/` (grafo A, `rt.equipnet`), la lógica pura en `src/lib/equipnet/`, los contratos en `src/lib/contracts/equipnet.ts`, la interfaz en `src/components/equipnet/` y `src/app/(app)/sistema/red-equipos`.

| Módulo | Qué hace |
|---|---|
| `sysfs.ts` | Interfaces de red físicas desde `<RM_NET_SYS_ROOT>/class/net` (sin udev): MAC, enlace, velocidad, controlador, bus (`usb`, `pci`, otro) y, si cuelgan de USB, `VID:PID`, fabricante, producto y conector. Las virtuales se listan aparte desde `ip -json link` (solo lectura). Sondeo cada 2 s (conexión en caliente). |
| `nm.ts` | Estado de NetworkManager por interfaz (`nmcli -t -f DEVICE,STATE,CONNECTION device status`, solo lectura, cada 30 s como mucho); vacío sin `nmcli`. |
| `host-plan.ts` | **Planificador puro**: del estado deseado (tarjeta elegida, dirección de gestión propia o ninguna, una VLAN por puerto) y el actual (`ip -json`) saca las órdenes `ip`, qué VLAN están listas y los **restos** (direcciones de gestión de la aplicación en otras interfaces, que no toca salvo petición expresa: `cleanup`). Solo toca enlaces `rmv<vid>`, direcciones en ellos, la dirección de gestión de la tarjeta elegida (reconocida por su regla de la tabla 20000), reglas cuya tabla es 20000–24094 y cuya preferencia es 1000–5094 (o 20000–24094 de versiones anteriores, que se sustituyen) y rutas de esas tablas (cada una con su red y `unreachable default`). Borra rutas antes que direcciones (el núcleo quita las rutas de un dispositivo con su última dirección) y vuelve a poner la ruta tras cambiar una dirección. `validateIpCommand()` es la última barrera: solo esas formas de orden, solo en `rmv*` o la tarjeta elegida (o una de `cleanup` para borrar su dirección de gestión), preferencia igual a `1000 + (tabla − 20000)`, nunca una interfaz de la lista prohibida (la de la ruta por defecto y **todas las no elegidas**) ni la tabla principal. |
| `iproute.ts` | El **único** módulo que cambia la red: `execFile` de `ip` (sin shell, 5 s, entorno mínimo), valida todas las órdenes antes de ejecutar la primera, lee el estado con `ip -json` (sin privilegios), consulta `ip -json route get <destino> from <origen>` para verificar, comprueba `CAP_NET_ADMIN` en `/proc/self/status` y las interfaces con ruta por defecto en `/proc/net/route` e `ipv6_route`. Un `del` de algo que ya no existe cuenta como hecho. |
| `drivers/` | Controladores de switch (`types.ts`: una sesión que lee el estado y aplica una operación 802.1Q cada vez). `tplink-easy-smart.ts` + `tplink-parse.ts` (lee los literales JavaScript de las páginas con un analizador propio, nunca `eval`) y `manual.ts` (sin sesión: solo instrucciones). |
| `switch-runner.ts` | Aplica las operaciones una a una, **verifica cada una leyendo el switch**, comprueba que la gestión sigue accesible y, si un paso falla, vuelve al estado inicial. `detectServerPort()` compara los contadores de paquetes recibidos antes y después de unas lecturas: el puerto que más crece (y claramente más que el segundo) es el del servidor. |
| `secret.ts` | La contraseña del switch en reposo: AES-256-GCM con una clave derivada (HKDF-SHA256) del secreto de la aplicación. |
| `http-client.ts` | HTTP/1.1 mínimo (una petición por conexión, `localAddress`, tiempo y tamaño máximos): el servidor web del switch rechaza parte de lo que envía `fetch`. |
| `index.ts` | El servicio: elección de la interfaz, ajustes (errores y avisos), reconciliación con verificación, restos, sondeo del switch, búsqueda, vista previa, trabajos, rutas para los accesos, salud y eventos. |

**Plan de direcciones** (`src/lib/equipnet/plan.ts`). Puerto `n` → VLAN `v = base + n` → interfaz `rmv<v>` sobre la tarjeta elegida (`addrgenmode none`) con `<red de los equipos> + desplazamiento + n` (192.168.1.200 + n) `noprefixroute`; si el servidor ya tiene esa dirección en cualquier interfaz (o es la de los equipos), ese puerto usa la siguiente libre después de la del último puerto (las demás no se mueven). Tabla `20000 + v` con `<red de los equipos> dev rmv<v>` y `unreachable default` (si falta la primera, la búsqueda falla en esa tabla en vez de seguir a la principal), y la regla `from <esa dirección>/32 lookup 20000+v pref 1000+v`. La dirección de gestión (192.168.0.250/24) va en la tarjeta sin etiqueta con la tabla 20000 y la preferencia 1000; si la tarjeta ya tiene una dirección en la red de gestión y ninguna otra interfaz está en esa red, se usa esa y no se añade nada (esa dirección no tiene regla propia: la decide la tabla principal, por eso solo cuando no hay otra interfaz en esa red). Nada va a la tabla principal: solo el tráfico que sale **de** esas direcciones usa esas tablas, así que el resto del servidor no cambia aunque la red de los equipos coincida con la de otra tarjeta (que incluso puede tener otro 192.168.1.10 detrás). Preferencias 1000–5094: antes que la tabla principal (32766) y que las reglas de otros programas (Tailscale 5210–5270, WireGuard o NetworkManager numeradas justo por debajo de la primera existente); como solo seleccionan las direcciones propias, adelantarse no afecta a nada más. Se valida que la dirección del servidor nunca sea la de los equipos, ni la de red o difusión, que las VLAN estén en 2–4094 y que la red de gestión y la de los equipos no se solapen. Al guardar, otra interfaz en la red de los equipos o en la de gestión es un **aviso** (`warnings`); errores solo los choques de direcciones: la IP del switch es del servidor, la dirección de gestión la tiene otra interfaz o es la del switch, o (activa) la IP de los equipos es del servidor.

**Elección de la interfaz.** Mientras no hay tarjeta elegida, el servicio solo lee (`ip -json`, sysfs, `nmcli`) y **no ejecuta ninguna orden ni sondea el switch**, tampoco al arrancar; la tarjeta pasiva del Banco y Descubrimiento solo enlaza con Sistema. `chooseAdapter()`: la de la ruta por defecto y las inalámbricas, nunca; una con direcciones de otra red o que no es USB (salvo `RM_NET_ALLOW_NON_USB`), solo con `confirmed` (si no, `CONFIRMATION_REQUIRED`); se rechaza si choca una dirección. Al cambiar de tarjeta o dejarla, la anterior se limpia (su dirección de gestión, `rmv*`, reglas y tablas). Los restos que dejaron versiones anteriores (su búsqueda automática ponía 192.168.0.250 en cualquier adaptador USB libre) se muestran con sus órdenes y solo se quitan con «Quitar restos» (`cleanupLeftovers()`).

**Reconciliación.** Con una tarjeta elegida: al arrancar, cada 15 s, al cambiar los adaptadores y al guardar: lee el estado, planifica y, con `RM_NET_HOST=apply` y `CAP_NET_ADMIN`, ejecuta (auditado como `equipnet.host`). Después **verifica** cada VLAN lista con `ip route get <IP de los equipos> from <su dirección>` (debe salir por `rmv<v>`) y la gestión con `ip route get <switch> from <gestión>`; si otra regla se adelanta, la VLAN no está lista y lo dice. Sin permiso, el estado es «Sin permiso para cambiar la red» con las órdenes pendientes. Una tarjeta elegida que desaparece (el núcleo borra sus VLAN) vuelve a prepararse al conectarla; mientras falta no se ejecuta nada. Si la tarjeta pasa a no ser válida (ruta por defecto) o hay un choque de direcciones, no se planifica nada y el estado lo explica.

**Búsqueda.** Solo cuando un administrador pulsa «Buscar el switch» y solo por la tarjeta elegida, desde su dirección de gestión (propia o reutilizada): la IP guardada, 192.168.0.1 y el resto de la red de gestión (como mucho /22; TCP 80 y la huella de la página de acceso de TP-Link), nunca las direcciones del propio servidor; o una sola IP escrita por el administrador (sin dirección de gestión, esa conexión sale sin origen fijo). Mientras dura se pausa el sondeo y se cierra la sesión (el switch ata la sesión a la IP de origen y con ella abierta su portada no es la de acceso). Se abre sesión con las credenciales guardadas o las de fábrica para leer el modelo (solo lectura, y se cierra), y la IP encontrada se guarda.

**Reenvío.** Cada acceso `switch` sale con `localAddress` = la dirección de su VLAN; si el núcleo ya no la tiene (`EADDRNOTAVAIL`), la conexión falla con «La VLAN del puerto N no está lista…» y se pide una reconciliación: nunca sale con otra dirección ni por otra tarjeta. `rp_filter` estricto funciona (la comprobación inversa usa la misma regla por origen; probado con `rp_filter=1`). ARP: con `arp_ignore=0` (Linux por defecto) el servidor contestaría por otra tarjeta de la misma red a las direcciones de las VLAN; el servicio no escribe `sysctl`: lo avisa (`net.arp` en `doctor`/Salud) y `install.sh --red-equipos-arp-estricto` pone `arp_ignore=1` y `arp_announce=2`.

**Switch TP-Link Easy Smart.** Rutas leídas de las páginas de un TL-SG108E v3 real (firmware 1.0.0 Build 20160722) con peticiones de solo lectura; las páginas están en `test/fixtures/tplink-sg108e-v3`:

| Para | Petición |
|---|---|
| Sesión | `POST /logon.cgi` (`username`, `password`, `logon=Login`): responde la página de acceso con `logonInfo[0]` (0 correcto, 1 credenciales), la sesión va por la IP de origen; se confirma leyendo una página; `GET /Logout.htm` la cierra. Una página de acceso en lugar de datos = sesión caducada: se vuelve a entrar una vez. |
| Lectura | `/SystemInfoRpm.htm` (`info_ds`), `/PortSettingRpm.htm` (`spd_act`: enlace y velocidad), `/PortStatisticsRpm.htm` (`pkts`, 4 por puerto), `/Vlan8021QRpm.htm` (`qvlan_ds`, miembros como máscaras), `/Vlan8021QPvidRpm.htm` (`pvid_ds`), `/VlanPortBasicRpm.htm`, `/VlanMtuRpm.htm` |
| 802.1Q | `GET /qvlanSet.cgi?qvlan_en=1&qvlan_mode=Apply` (activarla apaga la VLAN por puertos y la MTU); `?vid=N&vname=…&selType_1..n=0\|1\|2&qvlan_add=Add/Modify` (sin etiqueta, con etiqueta, no miembro); `?selVlans=N&qvlan_del=Delete`; `GET /vlanPvidSet.cgi?pbm=<máscara>&pvid=N` |
| Guardar y copia | `POST /savingconfig.cgi` (`action_op=save`); `GET /config_back.cgi?btnBackup=Backup+Config` |

Las rutas de escritura salen de los formularios y scripts de esas páginas (no se enviaron al switch real durante el desarrollo); cada escritura se verifica leyendo, así que un firmware distinto se detecta. Un controlador nuevo implementa `SwitchSession` y se registra en `drivers/index.ts`.

**Aplicar sin quedarse fuera** (`src/lib/equipnet/switch-layout.ts`). La disposición objetivo deja el puerto de subida sin etiqueta en la VLAN 1 con PVID 1 durante todo el proceso. `planSwitchOps()` ordena: activar 802.1Q → **añadir** miembros (cada VLAN recibe la unión de lo que tiene y lo que tendrá) → PVID → miembros **finales** (las bajas; la VLAN 1 la última) → borrar VLAN sobrantes → guardar. Así un PVID siempre apunta a una VLAN de la que el puerto ya es miembro. Una prueba aleatoria (300 pares de estados) comprueba que siempre llega al objetivo sin perder la gestión. Si el firmware no deja cambiar la VLAN 1, esa última baja se omite con un aviso.

**Vista previa y trabajos.** La vista previa lee el switch, calcula el objetivo (preparar, restaurar la disposición anterior o quitar las VLAN), comprueba LAG, que no se pierde la gestión y el puerto del servidor, y devuelve los cambios en español, la tabla por puerto y un `planId` (hash del estado actual y el objetivo, válido 10 min). Aplicar exige ese `planId`, `confirmed: true` y, si el puerto del servidor no se pudo comprobar, `uplinkConfirmed`; si el switch cambió entretanto, se rechaza. El trabajo corre en segundo plano (progreso por `equipnet.changed`): copia del switch en `<datos>/equipnet/switch-<fecha>.cfg` (0600, se guardan 5), guarda el estado 802.1Q anterior, aplica y verifica, y en caso de fallo vuelve atrás. «Preparar switch» (paso 3) es el mismo trabajo tras guardar los ajustes (con el clic como confirmación) y etiquetar el adaptador; exige una tarjeta elegida.

**Sondeo del switch.** Solo con una tarjeta elegida. Cada `RM_NET_POLL_MS` (10 s) lee el enlace de los puertos (y guarda cuándo subió cada uno, para «Acabas de conectar algo al puerto N»); cada 6 lecturas, el modelo y la disposición 802.1Q, que compara con la aplicada (diferencias). Los cambios de enlace y de VLAN lista avisan a los accesos.

---

## 7. Protocolo WebSocket

Rutas en el **mismo puerto** HTTP(S):

- `GET /ws/console/<consoleId>`: terminal de una consola;
- `GET /ws/preview/<stableKey>?baud=<n>`: vista previa de un puerto libre (solo administradores, nunca escribe).

**Apertura.** El enrutador de `upgrade` reescribe las cabeceras reenviadas y exige un `Origin` igual a `<esquema>://<Host>` (si no, HTTP 403 sin upgrade). Después autentica la cookie de sesión (solo la cabecera `cookie`), vuelve a leer el usuario de la base de datos (existe, activo, misma `sessionVersion`, menos de 72 h desde el acceso) y comprueba que puede ver la consola. El servidor resuelve la ruta y los ajustes de línea desde la base de datos; **nunca** abre una ruta enviada por el cliente.

**Servidor → cliente (texto JSON):**

| `t` | Cuándo |
|---|---|
| `hello` | primer mensaje: consola, modo `ro`/`rw`, estado, ajustes de línea, espectadores, `serverNow` |
| `history-end` | tras el historial (enviado en trozos binarios de 64 KiB) |
| `status` | cambia el estado de la consola |
| `mode` | cambia la reserva (`reserved`, `released`, `expired`, `reserved-by-other`, `force-released`) |
| `viewers` | cambian los espectadores |
| `gap` | un cliente lento se ha saltado bytes |
| `input-rejected` | entrada rechazada (`not-holder`, `port-not-open`, `rate-limited`, `too-large`) |
| `cleared`, `pong`, `error` | historial borrado, respuesta a `ping`, error no fatal |

Los **binarios** del servidor son bytes recibidos del puerto; los del cliente son teclas (solo se atienden en `rw`). El cliente envía además `{t:"ping"}` cada 20 s y `{t:"break", ms}` (solo el titular).

**Códigos de cierre:**

| Código | Significado | Cliente |
|---|---|---|
| 1000 / 1001 | normal / servidor detenido | 1001: reconecta |
| 4001 | sin sesión | a `/login` |
| 4002 | violación del protocolo | error |
| 4003 | debe cambiar la contraseña | a `/cuenta?cambiar=1` |
| 4004 | no existe o no es visible | «Consola no disponible» |
| 4008 | cliente lento | reconecta al momento |
| 4009 | demasiadas sesiones | «Reintentar», sin reconexión automática |
| 4010 | sesión revocada | a `/login` |
| 4011 | consola borrada o reconfigurada | refresca la página |
| 1011 | error interno | reconecta con espera |

**Límites:** 64 KiB por trama y 64 KiB/s por sesión; 4 sesiones por usuario y consola, 32 por usuario y 256 en total; 30 aperturas por minuto y usuario. Con más de 1 MiB pendiente se dejan de enviar datos (y luego `gap`); con más de 8 MiB durante 10 s, cierre 4008. Ping de protocolo cada 30 s. Un socket que no recibe `hello` en 10 s se destruye. Al cerrar se audita la sesión con su duración y los bytes.

---

## 8. Eventos en directo (SSE)

`GET /api/events` (usuario autenticado; como mucho 8 flujos por usuario). El navegador comparte **un solo flujo** entre pestañas con un `SharedWorker` (`public/events-worker.js`), con un `EventSource` por pestaña como alternativa: así no se agota el límite de 6 conexiones de HTTP/1.1.

Orden al abrir: suscribirse al bus (con búfer) → calcular los equipos visibles → registrar la sesión viva → `hello` (`serverNow`, versión, `buildId`) → vaciar el búfer → deltas. Latido cada 15 s. No hay instantáneas: las páginas se renderizan en el servidor y, tras reconectar, el cliente hace `router.refresh()`.

| Evento | Audiencia |
|---|---|
| `reservation.changed`, `console.status`, `console.activity`, `relay.state` | usuarios que ven ese equipo |
| `equipment.changed` (solo ids), `settings.changed` | todos |
| `access.status` | usuarios que ven ese equipo |
| `serial.changed`, `relay.discovered`, `discovery.progress`, `board.status`, `jtag.changed` | administradores |
| `cable-labels.changed`, `files.changed` | todos |
| `files.send` (un envío a un equipo: estado y progreso) | el usuario que lo envía |
| `files.copy` (una copia a una carpeta del servidor) | el usuario que copia |
| `files.export` (una descarga de «Descargas»: estado y líneas nuevas del registro) | el usuario que la lanzó y los administradores (`userAndAdmins`) |
| `equipnet.changed` (estado completo de la red de equipos: adaptadores, servidor, switch, puertos, búsqueda y trabajo) | administradores |
| `viewer.changed`, `session.revoked`, `toast` | un usuario |
| `account.prefs.changed` (el tema de la cuenta cambió: sus otras pestañas y PC lo aplican al momento) | ese usuario |

Un cambio de `buildId` en `hello` hace que las pestañas abiertas muestren «Nueva versión instalada».

---

## 9. Seguridad

### 9.1 Autenticación y sesiones

- NextAuth 5 con credenciales y **sesiones JWT** en cookie `HttpOnly; SameSite=Lax` (`__Secure-` con TLS). Acceso por **nombre de usuario**.
- La callback `jwt` **vuelve a leer el usuario de la base de datos en cada petición**: un usuario desactivado, borrado o con otra `sessionVersion` pierde la sesión al momento. Caducidad por inactividad de 12 h y máximo absoluto de 72 h.
- Solo cambiar o restablecer la contraseña, desactivar y borrar incrementan `sessionVersion`. Cambiar roles o el rol de administrador no cierra la sesión: se aplica en la siguiente petición.
- **Sesiones vivas.** La callback `jwt` solo corre en peticiones HTTP, así que cada WebSocket y cada flujo SSE se registra en `rt.sessions` y se revalida cada 30 s (y al momento con `viewer.changed` o `session.revoked`). Así también se aplican en menos de 30 s los cambios hechos desde la CLI, que corre en otro proceso. **La caducidad por inactividad de 12 h no se aplica a sockets ya abiertos**; el máximo de 72 h sí.
- Contraseñas con bcrypt (coste 12), de 10 caracteres a 72 bytes. La comprobación usa un hash ficticio cuando el usuario no existe (mismo tiempo) y no revela que un usuario está desactivado hasta comprobar la contraseña.
- **Primer arranque.** `/setup` exige un código de un solo uso (`<datos>/setup-token`, 0600, unos 78 bits, comparación en tiempo constante, con límite de intentos). Reclamar la configuración es atómico: dos envíos simultáneos dan un administrador. `/api/health` no revela si la configuración está pendiente.

### 9.2 Autorización

- `src/server/access.ts` es el **único** punto que responde «¿puede este usuario ver este equipo o esta consola?» (administrador, equipo sin roles o roles en común). Lo usan las acciones, las consultas, el WebSocket, el SSE y el barrido de reservas. Un equipo no visible responde igual que uno inexistente.
- `authz-rules.ts` (puro) decide quién escribe: el titular de la reserva; un administrador solo si el equipo está libre; si otro lo tiene, `RESERVED_BY_OTHER`.
- Cada mutación es una **server action** (`defineAction`) con entrada validada por zod, usuario leído de la base de datos y auditoría de las denegaciones. Cada ruta de API usa `defineRoute` (zod para parámetros y consulta, `Cache-Control: no-store`) y **no modifica estado**. La única excepción es la API de Archivos (subidas en *streaming*), atendida por el grafo A con la autenticación del WebSocket y el filtro de Origin (apartado [6.7](#67-archivos)).

### 9.3 Red

- **Filtro de Origin.** Toda petición que no sea GET/HEAD/OPTIONS sin un `Origin` igual a `<esquema>://<Host>` recibe 403 (`FORBIDDEN_ORIGIN`). Cubre CSRF también desde otros puertos del mismo equipo, que `SameSite=Lax` no aísla.
- **Cabeceras reenviadas.** El servidor borra `Forwarded`, `X-Forwarded-*` y `X-Real-IP` del cliente y las reescribe desde el socket. La IP de la auditoría y del límite de accesos es siempre la del socket. No hay soporte de proxy inverso.
- Cabeceras de seguridad: `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy` y, en producción, una CSP restrictiva (`default-src 'self'`).
- HTTP sin cifrar por defecto; TLS integrado con `RM_TLS_CERT` y `RM_TLS_KEY`.

### 9.4 Auditoría

Tabla de solo inserción con triggers SQLite; la purga por retención desbloquea el trigger dentro de una única transacción. Se audita todo lo de [OPERACION.md](OPERACION.md#38-auditoría), con las claves secretas ocultas a cualquier profundidad. La exportación CSV neutraliza las celdas que empiezan por `=`, `+`, `-`, `@`, tabulador o retorno de carro.

### 9.5 Endurecimiento del servicio

La unidad systemd corre como `relay-manager` (grupos suplementarios `dialout` y `relay-files`), sin capacidades, con `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp` y el resto de protecciones de núcleo; solo escribe en `StateDirectory` (`/var/lib/relay-manager`) y en la carpeta de Archivos. Para esta, `install.sh` genera `relay-manager.service.d/archivos.conf`: si está en `/home`, `ProtectHome=tmpfs` + `BindPaths=<carpeta>` (el servicio ve un `/home` vacío con solo esa carpeta montada); fuera de `/home`, `ReadWritePaths=<carpeta>`; dentro de `/var/lib/relay-manager`, nada. La carpeta es `<usuario>:relay-files 2775`: el servicio y ese usuario comparten el grupo `relay-files` (no el grupo `relay-manager`, que lee los datos). `install.sh` hace lo que toca dentro de la carpeta de un usuario como ese usuario (`setpriv`), nunca como root, y canoniza la ruta rechazando `.` y `..`. No se usan `PrivateDevices` (bloquearía los ttyUSB y `/dev/bus/usb`, que `hw_server` necesita para los cables JTAG) ni `MemoryDenyWriteExecute` (rompe el JIT de V8). Los `hw_server` de los accesos son hijos del servicio con las mismas restricciones; escriben solo en `<datos>/xilinx` y no ven `/home` (`ProtectHome`), por eso Vivado Lab se instala en `/tools/Xilinx` u `/opt/Xilinx`. **Red de equipos:** la unidad da al servicio una sola capacidad, `CAP_NET_ADMIN` (`AmbientCapabilities` y `CapabilityBoundingSet`), para sus interfaces VLAN, direcciones y reglas; `RestrictAddressFamilies` ya incluye `AF_NETLINK` y `ProtectKernelTunables` sigue activo (el servicio no escribe ningún `sysctl`; el ARP estricto opcional lo escribe `install.sh` como root en `/etc/sysctl.d/60-relay-manager.conf`, solo con `--red-equipos-arp-estricto`). Al ser ambiental, la heredan los hijos: `ip` la necesita; a `hw_server` se le quita al lanzarlo (`setpriv --inh-caps=-all --ambient-caps=-all`, de util-linux, cuando el servicio tiene capacidades ambientales). El contenedor Docker arranca como root solo para que el lanzador pase a `relay-manager` con `setpriv` conservando únicamente `CAP_NET_ADMIN` (Docker solo da capacidades a root; `compose.yaml` añade `NET_ADMIN`, `SETUID`, `SETGID` y `KILL` tras `cap_drop: [ALL]`; `KILL` es para que el init, que sigue siendo root, reenvíe `SIGTERM` al servidor); el servidor queda con `CapEff` = `CapAmb` = `0x1000`, con `no-new-privileges` y raíz de solo lectura. Sin `NET_ADMIN`, el servidor corre sin capacidades como antes.

**Copiar a una carpeta del servidor.** El servicio solo gana `ReadWritePaths=-/media -/run/media -/mnt` (el `-` ignora las que no existen) y conserva `NoNewPrivileges`, sin ninguna capacidad nueva. Lo que hace falta como root lo hace **otra unidad**, `relay-manager-rootcopy.service`, activada por `relay-manager-rootcopy.socket`: socket `/run/relay-manager-rootcopy/rootcopy.sock`, `root:relay-manager` 0660 (solo el usuario del servicio puede conectar), en una carpeta propia y no en `/run/relay-manager`, porque al arrancar el servicio systemd cambia el propietario de su `RuntimeDirectory` de forma recursiva y le daría el socket al usuario del servicio. El ayudante corre como root pero con `CapabilityBoundingSet=CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_CHOWN CAP_FOWNER` (abrir cualquier carpeta, leer `/etc/shadow`, dar el fichero al dueño de la carpeta, fijar su modo), sin capacidades ambientales, `NoNewPrivileges`, `PrivateNetwork`, `RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`, `PrivateDevices`, `PrivateTmp`, `ProtectSystem=strict` con `ReadWritePaths=-/media -/run/media -/mnt` (más un *drop-in* `relay-manager-rootcopy.service.d/rutas.conf` con las carpetas extra de `RM_COPY_ROOT_PATHS`; systemd es el límite duro), `ProtectHome=read-only`, `ProtectProc=invisible`, `ProcSubset=pid`, `SystemCallFilter=@system-service` sin `@mount`, `@swap`, `@reboot`, `@raw-io`, `@module`, `@debug`, `@cpu-emulation`, `@obsolete` ni `@clock`, `UMask=0077` y su estado en `StateDirectory=relay-manager-rootcopy` (0700). Tampoco usa `MemoryDenyWriteExecute` (rompe el JIT de V8). Su configuración (`/etc/relay-manager/rootcopy.env`, `root:root` 0644) la escribe `install.sh`: el servicio no puede cambiar quién autentica ni dónde escribe root. Detalle y modelo de amenazas en la decisión D44.

**Montar y expulsar pendrives.** Un montaje hecho dentro del ayudante de copia no serviría: `ProtectSystem=`, `PrivateTmp=`, `PrivateDevices=` y compañía le dan su propio espacio de montaje, esclavo del sistema, y lo que se monta dentro nunca vuelve al sistema ni al servicio. `MountFlags=shared` no lo arregla: con otras opciones de aislamiento de ficheros, systemd ya ha pasado todo a esclavo y no restablece la propagación hacia el sistema. Darle `CAP_SYS_ADMIN` y `@mount` además le permitiría volver a montar en escritura lo que `ProtectSystem` deja en solo lectura (no hay espacio de usuario que bloquee esos montajes): perdería su límite duro. Por eso montar lo hace **una tercera unidad**, `relay-manager-rootmount.service` (activada por `relay-manager-rootmount.socket`, `/run/relay-manager-rootmount/rootmount.sock` **`root:root` 0600** en una carpeta 0700: solo root conecta, en la práctica el ayudante de copia tras autenticar), **sin espacio de montaje propio**: ninguna de `ProtectSystem`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`, `ReadWritePaths`, `ProtectKernel*`, `ProtectControlGroups`, `ProtectProc`, `ProcSubset`, `PrivateNetwork`, `PrivateMounts`, `ProtectHostname`. A cambio: `CapabilityBoundingSet=CAP_SYS_ADMIN` (ninguna otra; sin `CAP_DAC_OVERRIDE`: root solo escribe en lo suyo, `/media`), sin capacidades ambientales, `NoNewPrivileges`, `DevicePolicy=closed` con `DeviceAllow=block-sd rw`, `block-mmc rw` y `block-blkext rw` (control de dispositivos por cgroup, sin espacio de montaje), `RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`, `RestrictNamespaces=yes`, `SystemCallFilter=@system-service @mount` sin `@swap`, `@reboot`, `@raw-io`, `@module`, `@debug`, `@cpu-emulation`, `@obsolete` ni `@clock`, `LockPersonality`, `RestrictRealtime`, `RestrictSUIDSGID`, `UMask=0022` y su estado en `StateDirectory=relay-manager-rootmount` (0700). Ejecuta `blkid`, `mount`, `umount`, `sync` y (si existe) `setfacl` por su ruta absoluta y con `execFile` (lista de argumentos). Sus montajes se ven en todo el sistema; en el servicio, por propagación (su `ReadWritePaths=-/media` es esclavo del sistema). El ayudante de copia no gana nada para esto: solo conecta a ese socket (los sockets no se ven afectados por el `/run` de solo lectura). Las pruebas del paquete comprueban que el ayudante de montaje corre en el espacio de montaje de PID 1 y que el servicio ve el pendrive.

**Descargas.** Sin cambios en la unidad: `RestrictAddressFamilies` ya incluye `AF_INET`/`AF_INET6` y no hay `IPAddressDeny`, así que el script del perfil (hijo del servicio, con sus mismas restricciones y `NoNewPrivileges`) llega a los servidores de la red. Corre sin capacidades (`setpriv` le quita la `CAP_NET_ADMIN` ambiental que heredaría, como a `hw_server`) y escribe solo en `<datos>/descargas/<id>`; el zip lo copia después el servicio a la carpeta de destino. `ProtectHome=tmpfs` le oculta el resto de `/home`.

### 9.6 Bloqueo de instancia

`<datos>/.instance-lock` es una base de datos SQLite con una transacción `EXCLUSIVE` abierta durante toda la vida del servidor. El núcleo suelta el bloqueo cuando el proceso muere (incluso tras un corte de luz), así que un `server.pid` antiguo nunca impide arrancar. Funciona también entre contenedores que comparten el volumen. `start` sale con 5 si está ocupado; `restore`, `config import` y `migrate` se niegan (5) mientras un servidor lo tiene.

### 9.7 Accesos de red

Los puertos de acceso no piden credenciales (xsdb, Vivado, `nc` y `ssh` hablan directamente con el equipo o con `hw_server`). La protección es: red del laboratorio aislada, apertura solo con la reserva por defecto, escritura en consolas solo con reserva, límite de conexiones, auditoría de cada conexión con la IP de origen y `hw_server` sin puertos GDB. Los accesos Ethernet reenvían a la IP configurada por un administrador (o al puerto del switch que eligió); el cliente nunca elige el destino.

### 9.7b Red de equipos

- Cambiar la red del servidor, la configuración del switch, restaurar, quitar las VLAN y descargar la copia del switch son acciones solo de administradores (`defineAction`/`defineRoute` con `auth: "admin"`), auditadas; el evento `equipnet.changed` solo llega a administradores. Los demás usuarios solo ven, en sus accesos, el puerto, el enlace y el destino.
- El switch solo se cambia con un `planId` de una vista previa, `confirmed: true` y el estado del switch igual al de la vista previa. Buscarlo y la vista previa solo leen.
- Nada se cambia en la red del servidor hasta que un administrador elige la tarjeta del switch (acción auditada, con confirmación expresa si la tarjeta está en otra red), y después solo esa tarjeta, sus `rmv*`, sus reglas y sus tablas. Los restos en otras interfaces solo se quitan a petición.
- Las órdenes de red solo se ejecutan tras `validateIpCommand()` (formas fijas, `rmv*` o la tarjeta elegida, tablas 20000–24094, preferencias 1000–5094 y, para borrar, las 20000–24094 antiguas) y nunca nombran la interfaz de la ruta por defecto ni ninguna no elegida; los argumentos son una lista para `execFile`, sin shell.
- La contraseña del switch se guarda cifrada (AES-256-GCM, clave derivada del secreto de la aplicación), nunca se envía al navegador y la auditoría solo dice «cambiada». Las contraseñas SSH recordadas de «Enviar a equipo» igual, con otra clave derivada (otro `info` de HKDF). La copia del switch sí contiene sus credenciales en claro (es el formato del propio switch): 0600 en `<datos>/equipnet/`, fuera de las copias de la base de datos, descarga solo para administradores y auditada.

### 9.8 Decisiones de seguridad pendientes de aprobación

Estas decisiones son razonables para una red de laboratorio cerrada, pero las debe aprobar el **responsable de seguridad del laboratorio**:

| Decisión | Detalle | Alternativa |
|---|---|---|
| HTTP sin cifrar por defecto | Contraseñas y consolas viajan en claro por la red del laboratorio. | TLS integrado (`install.sh --tls-selfsigned` o certificado propio). |
| Ruta de salud pública | `/api/health` responde sin sesión, solo con `{ok, version}`. | Filtrar el puerto en el cortafuegos. |
| Descubrimiento de placas | Escucha UDP 30303 pasiva siempre activa (solo recibe, acotada); difusión y escaneo solo a petición de un administrador y auditados. | `RM_RELAY_PASSIVE_DISCOVERY=0`. |
| Capturas en reposo | Las capturas de consola se guardan sin cifrar en el disco del anfitrión (0640, usuario del servicio), y las puede descargar cualquiera que vea el equipo. Con «Texto completo», lo tecleado (posibles contraseñas) va a `.input.log`, solo para administradores. | Modo «Solo marcas» (por defecto); `RM_CAPTURE_ENABLED=0`; cifrado de disco. |
| Sesiones JWT de 12 h | Sin revocación por token individual; la revocación es por usuario (`sessionVersion`), y los sockets abiertos se revalidan cada 30 s. | `RM_SESSION_MAX_AGE_H` menor. |
| Contraseñas de placas en la base de datos | Las placas ETH necesitan su contraseña en claro para enviarla; se guarda en la base de datos (y en las copias), nunca se envía al navegador ni se exporta. | Placas sin contraseña en una red aislada. |
| Franja de clasificación opcional | El texto de la franja superior es informativo; no controla el acceso. | — |
| Sin proxy inverso | Las cabeceras reenviadas se ignoran siempre; no se puede poner detrás de un proxy. | TLS integrado. |
| Archivos compartidos | Cualquier usuario con sesión lee, sube y borra en la carpeta de Archivos (sin permisos por carpeta); todo queda en la auditoría. Quien pueda escribir directamente en la carpeta del servidor (su dueño, por SSH) podría intentar enlaces simbólicos: la web no los sigue fuera de la carpeta y comprueba cada descriptor abierto. | `RM_FILES_DELETE=admins`; `RM_FILES_ENABLED=0`; una carpeta dedicada. |
| Capacidad de red del servicio | `CAP_NET_ADMIN` ambiental para la red de equipos; la hereda `ip` (a `hw_server` se le quita con `setpriv` al lanzarlo). El código solo la usa en `iproute.ts`, con la validación de órdenes. | Quitarla (`AmbientCapabilities=` vacío) y ejecutar a mano las órdenes que muestra la web, o `RM_NET_HOST=off`. |
| Credenciales del switch | El switch de fábrica usa `admin`/`admin` y su gestión va sin cifrar (HTTP) por el cable del adaptador USB. La copia del switch guarda sus credenciales en claro. | Cambiar la contraseña del switch; la red de gestión solo existe entre el servidor y el switch. |
| Enviar a equipo: credenciales y claves SSH | La contraseña SSH recordada de cada equipo es **compartida** por todos los usuarios que pueden enviarle (se guarda cifrada con una clave derivada del secreto de la aplicación: quien tenga la base de datos **y** `auth-secret`, o sea el servidor, puede leerla). La clave del equipo no se fija (todos tienen la misma IP): un cambio solo se avisa. El servidor del banco puede escribir en los equipos con esas credenciales. | No marcar «Recordar»; contraseñas por equipo distintas de `root`; red de equipos aislada (la VLAN de cada puerto solo llega a su equipo). |
| Copiar como administrador (sudo) | Un administrador de la web que conozca la contraseña del usuario con sudo del anfitrión (`RM_SUDO_USER`) puede escribir como root dentro de `RM_COPY_ROOT_PATHS` (por defecto `/media`, `/run/media`, `/mnt`). La contraseña viaja por la red del laboratorio hasta el servidor (en claro sin HTTPS), no se guarda ni se audita. | HTTPS (`--tls-selfsigned`); `RM_COPY_ROOT_PATHS` más estrecho; `RM_COPY_ENABLED=0`; `sudo systemctl disable --now relay-manager-rootcopy.socket`. |
| Permisos de administrador de 5 minutos | Tras escribir la contraseña de sudo, esa sesión de la web actúa como administrador (ver carpetas protegidas, copiar, crear carpetas, montar, expulsar) 5 minutos sin volver a escribirla. Quien use ese navegador en ese tiempo (o robe la cookie de sesión) también. El permiso no sale del servidor. | «Olvidar permisos» al terminar; cerrar la sesión; `sudo rm /var/lib/relay-manager-rootcopy/token.key` anula todos. |
| Ver como administrador | Con la contraseña (o el permiso) se listan nombres, tamaños y fechas de cualquier carpeta del sistema (salvo `/proc`, `/sys`, `/dev`), por ejemplo `/root` o `/etc`; nunca el contenido de un fichero. | `RM_COPY_ROOTS` más estrecho (también limita lo que se lista). |
| Montar y expulsar pendrives | Un administrador de la web con la contraseña de sudo monta cualquier dispositivo **extraíble o USB** (nunca uno con algo montado fuera de `/media`, `/run/media`, `/mnt`), siempre `nosuid,nodev,noexec`. El ayudante de montaje tiene `CAP_SYS_ADMIN` y no tiene espacio de montaje propio. | `sudo systemctl disable --now relay-manager-rootmount.socket` (el resto sigue igual). |
| Descargas | Si el perfil lo activa, cualquier usuario con sesión ejecuta en el servidor el script del perfil (como el usuario del servicio, sin capacidades, una vez a la vez, auditado). El script es código del proyecto: la aplicación no puede saber qué hace (puede descargar y ejecutar programas, o pasar credenciales en la línea de órdenes, visibles en `ps`). | Revisar el script del perfil antes de instalarlo; credenciales solo en `RM_EXPORT_USER`/`RM_EXPORT_PASSWORD` de `config.env` (0640), nunca dentro del script; `RM_EXPORT_ENABLED=0` en `config.env` lo desactiva aunque el perfil lo active. |
| Accesos de red sin autenticación | Mientras un equipo está reservado (o siempre, si se marca así), cualquiera que alcance su puerto por la red del laboratorio llega a su JTAG, su consola o su Ethernet. Todo queda auditado con la IP. | `RM_ACCESS_BIND` en una interfaz concreta, cortafuegos por origen, o no crear accesos. |

---

## 10. Empaquetado y despliegue

`pnpm bundle` (en el equipo de desarrollo, con Internet) produce `dist/relay-manager-<versión>-linux-x64.tar.gz`. `ssh2` (Enviar a equipo) va dentro de `build/server.js`: es JavaScript puro, y sus dos aceleraciones nativas opcionales (el paquete `cpu-features` y su `sshcrypto.node`) no se compilan (`allowBuilds: false` en `pnpm-workspace.yaml`) ni viajan: esbuild las cambia por un módulo que lanza un error al cargarse, que `ssh2` captura para usar su camino en JavaScript (con los cifrados nativos de Node, más de 150 MiB/s por SFTP en local).

1. `pnpm install --frozen-lockfile`, `prisma generate`, `db:check`, typecheck, lint y tests.
2. `next build` (salida *standalone*) y esbuild de `server.ts` → `build/server.js` (con `better-sqlite3`, `serialport`, `next` y Prisma como externos).
3. Montaje de `app/` y traza de dependencias del servidor con `nft`, conservando los enlaces de pnpm.
4. Guardia de secretos: el paquete no puede llevar `auth-secret`, `setup-token`, `.instance-lock`, `*.db` ni `config.env`.
5. Poda (TypeScript, sharp, binarios nativos de otras arquitecturas).
6. Node 22.23.2 oficial, verificado con su `SHASUMS256.txt`.
7. Lanzador, instalador, unidad, regla udev, Docker, documentación, `VERSION`, `BUILDINFO` y `SHA256SUMS`.
8. Con `--docker`: imagen construida **desde el paquete** sin red (`docker build --network none`) y guardada con `docker save`. Los `.deb` de `iproute2` para `ubuntu:24.04` se descargan en el equipo de desarrollo (comprobados con el SHA256 del archivo de Ubuntu, en caché en `build/debs-cache/`) y se instalan en la imagen.

El ayudante de «Copiar como administrador (sudo)» va aparte, en `build/rootcopy.js` → `app/rootcopy.js`: esbuild lo empaqueta solo con módulos `node:` (el script falla si se cuela cualquier paquete de `node_modules`), así que no carga nada del servidor ni de `node_modules`. Sus dos unidades, y las dos del ayudante de montaje (`relay-manager-rootmount.socket` y `.service`, que ejecutan el mismo `app/rootcopy.js` con el argumento `mount`), van en `systemd/` junto a la del servicio. El paquete no lleva ningún script de proyecto (ni `tools/`): el script de descarga viene en el perfil. `build-bundle.sh --perfil <carpeta>` mete un perfil como `perfil/` en el paquete (por defecto no lleva ninguno); `install.sh --perfil <carpeta>` lo copia a `/etc/relay-manager/perfil` (root:relay-manager, ficheros 0640, carpetas 0750, `herramientas/*.sh` 0750; el anterior queda en `perfil.anterior-<fecha>`) y, sin la opción, instala el del paquete solo si aún no hay ninguno. `install.sh` lee `RM_FILES_EXTRA_*` del perfil para crear la segunda carpeta (con `~` = la carpeta personal del usuario que instala) y escribe `RM_FILES_EXTRA_DIR` en `config.env` si no estaba. En Docker, `compose.yaml` monta el perfil en `/perfil` (solo lectura, `RM_PROFILE_HOST_DIR`) y la segunda carpeta en `/extra` (`RM_FILES_EXTRA_HOST_DIR`).

En el destino no se instala nada con `apt` ni `npm`. Formas de despliegue:

- **Servicio**: `/opt/relay-manager/releases/<versión>` + `current`, unidad systemd, regla udev, datos en `/var/lib/relay-manager`. Actualización con copia previa y cambio atómico; `rollback` sin pérdida de datos cuando la versión de destino conoce todas las migraciones.
- **Portátil**: el paquete descomprimido, datos en `./data`.
- **Docker**: `network_mode: host` (difusión UDP y puertos de los accesos sin mapear), `/dev:/hostdev:ro` con `RM_SERIAL_DEV_ROOT=/hostdev` (conexión en caliente sin udev), reglas de cgroup para los majors 188, 166 y 189 (USB, cables JTAG); montajes opcionales de `/dev/bus/usb` y de la instalación de Xilinx para los accesos JTAG.

El lanzador (`packaging/linux/relay-manager`, sh POSIX) decide el modo por su ubicación, nunca por el fichero de configuración, y ejecuta las órdenes de datos como el usuario del servicio (`setpriv` desde root, `sudo` desde otros usuarios).

---

## 11. Registro de decisiones

| Id | Tema | Decisión |
|---|---|---|
| D1 | Enumeración serie y Docker | Desde sysfs, no con `SerialPort.list()` (solo fuera de Linux). Docker sin udev: `/dev:/hostdev:ro` + `RM_SERIAL_DEV_ROOT=/hostdev`. |
| D2 | Conexión en caliente | Sondeo de `/sys/class/tty` cada 2 s como referencia; `fs.watch('/dev')` adelanta 300 ms; 800 ms de estabilización. |
| D3 | Identificar | Pasivo, nunca escribe. «Enviar retorno de carro» aparte: admin, confirmado, auditado, solo puertos libres sin asignar, desactivable. |
| D4 | Número de relés | El físico, por modelo; nunca contar etiquetas `RlyN`. |
| D5 | Variable dScript | Se aprende por placa de `/index.htm` y se guarda en `options.toggleVar`; sin valor por defecto. |
| D6 | Sintaxis ASCII dS | `SR <n> on\|off [ms]`, `GR <n>`, `ST`, terminadas en `\r\n`. |
| D7 | Asignación de relés | Una fila `RelayChannel` por relé, única por placa y canal. Borrar una placa desvincula; nunca borra equipos. |
| D8 | Modelo de consola | `SerialConsole` con asignación, ajustes de línea, Intro, eco, `hupcl`, captura e identificación. |
| D9 | Plantillas | Se copian al crear; editar una plantilla no cambia equipos existentes. |
| D10 | WebSocket | `/ws/console/<id>` y `/ws/preview/<clave>` en el puerto HTTP; el servidor nunca abre una ruta enviada por el cliente. |
| D11 | Accesos de red | Un puerto TCP fijo por acceso (rango `RM_ACCESS_PORTS`), abiertos por defecto solo con la reserva. JTAG: un `hw_server` por cable filtrado por su serie (el propio `hw_server` escucha: «reservado» = arrancar y parar el proceso). Serie: puente sobre la consola ya abierta, escritura solo con reserva. Sin autenticación en esos puertos: acotado por la red del laboratorio, la reserva y la auditoría. |
| D12 | Cables | Inventario de nombres (`CableLabel`); los accesos guardan la serie del cable, no el nombre, así que renombrar no cambia nada. |
| D13 | Archivos | Una carpeta compartida (`RM_FILES_DIR`, por defecto `~/tftp`) con API HTTP propia del grafo A para subir y descargar en *streaming*; subidas por fragmentos a un temporal en la misma carpeta con confirmación atómica sin sobrescribir; rutas relativas resueltas con `realpath` y comprobación del descriptor; ZIP y tar.gz propios en *streaming*; en el servicio, acceso solo a esa carpeta con un *drop-in* de systemd. |
| D11 | Otros upgrades | Nuestro manejador solo atiende `/ws/*`; el resto (HMR de Next) no se toca. |
| D12 | Configuración | Solo `RM_*` (y `NODE_ENV`), un fichero por modo, un único cargador; entorno > fichero > defecto. Sin `EnvironmentFile=`. |
| D13 | Desarrollo | Solo `RM_DEV=1` activa el modo desarrollo; `NODE_ENV` nunca lo decide. |
| D14 | Formularios | zod; cada acción recibe un objeto JSON (nunca `FormData`); sin react-hook-form. |
| D15 | glibc | Mínimo 2.29. |
| D16 | Puertos | Un único puerto HTTP(S) para web, SSE y WebSocket. |
| D17 | Unidad systemd | Una unidad; capturas bajo `StateDirectory`; misma estructura en servicio, portátil y Docker. |
| D18 | Regla udev | `dialout` 0660, `ID_MM_DEVICE_IGNORE=1`, latencia FTDI 1, guardia de `remove`, enlaces opcionales comentados. |
| D19 | Fuentes | Atkinson Hyperlegible Next y Mono versionadas en `src/fonts/`, cargadas con `next/font/local`. |
| D20 | Descubrimiento de relés | UDP pasivo activo por defecto; UDP activo y escaneo solo a petición y auditados; sondas de solo lectura. |
| D21 | Destinos de difusión | Difusión dirigida de cada interfaz local, nunca `255.255.255.255`; se saltan interfaces virtuales; errores de envío como avisos. |
| D22 | Cambio de IP de una placa | Un anuncio UDP nunca cambia el host guardado: «IP cambiada» + acción auditada «Actualizar IP». |
| D23 | Primer arranque | `/setup` con código de un solo uso en `<datos>/setup-token`, impreso en el registro, en `install.sh` y con `relay-manager setup-token`. |
| D24 | Acceso a consolas | Todos los que ven el equipo pueden ver; solo el titular escribe; reservar es un clic; los administradores fuerzan la liberación y luego reservan. |
| D25 | Reservas | El servidor las aplica en todos los caminos; se renuevan por uso, nunca por tener la pestaña abierta; cuentas atrás con la hora del servidor. |
| D26 | Captura | Continua; «Soltar puerto» libera el tty hasta «Retomar» o hasta el fin del plazo; al reconectar solo se reabren las consolas no soltadas. |
| D27 | Auditoría | Solo inserción (triggers), con retención, exportación CSV y página propia. |
| D28 | Autenticación | `trustHost`, sin `AUTH_URL`, secreto generado, usuario releído en cada petición, 12 h/72 h, acceso por usuario, límite de intentos, restablecimiento por CLI. |
| D29 | Salud | `/api/health` público solo con `{ok, version}`; el detalle, solo para administradores. |
| D30 | Datos antiguos | Sin importación de la base de datos 1.x; sin usuarios de ejemplo. |
| D31 | Transporte | HTTP por defecto; TLS con `RM_TLS_CERT` + `RM_TLS_KEY`; la interfaz funciona en contexto no seguro. |
| D32 | Eventos | Un flujo SSE por navegador compartido con `SharedWorker`; `EventSource` por pestaña como alternativa. |
| D33 | Semántica de relés | Encendido absoluto y pulso; los controladores sin encendido absoluto lo emulan y verifican. |
| D34 | Estado del servidor | Todo el estado vive en el registro `globalThis[Symbol.for("relay-manager.runtime")]`; Next solo lo alcanza con `getRuntime()`. |
| D35 | Navegadores | Chrome/Edge 111+, Firefox 128+, Safari 16.4+; aviso «Navegador no compatible». |
| D36 | Topología | Una instancia por anfitrión del banco; sin serie remota; sin proxy inverso. |
| D37 | Bloqueo de instancia | Bloqueo SQLite exclusivo en `<datos>/.instance-lock`, nunca `server.pid`. |
| D38 | Cabeceras reenviadas y CSRF | Se reescriben desde el socket; toda petición no segura sin `Origin` del mismo origen recibe 403. |
| D39 | Tema | Oscuro por defecto; «Claro», «Sistema» y «Rosa» seleccionables. `data-theme` admite `dark | light | rosa`; Rosa («rosa chicle», de broma pero legible) tiene su bloque `[data-theme="rosa"]` en `globals.css` (color-scheme dark: texto blanco sobre rosa saturado, acentos de golosina y peligro en naranja con rellenos de regaliz oscuro; radios 8/12/16 px; detalles decorativos sin significado —piruleta en la marca, rayas de caramelo, virutas— y sin movimiento con `prefers-reduced-motion`) y paleta xterm propia (`terminalThemeFor`, fondo uva); «Sistema» nunca resuelve a Rosa. **Preferencia de la cuenta**, no del navegador: `User.theme` (nulo = sin elegir), guardado con la acción `setMyTheme` (usuario autenticado, también con cambio de contraseña pendiente; **sin auditoría**, por ser una preferencia estética sin relevancia de seguridad que solo añadiría ruido a un registro de solo inserción) y publicado como `account.prefs.changed` solo a ese usuario. Sin parpadeo: el layout raíz lee el tema del usuario con sesión (`getViewerTheme`, nunca lanza) y pinta `<html data-theme data-theme-user style="color-scheme">` (`htmlThemeAttrs`; «Sistema» se pinta oscuro y el script lo resuelve con `prefers-color-scheme` antes de pintar). El script en línea aplica `pickThemePref`: el tema de la cuenta gana a `localStorage`; `rm-theme` queda como caché para las páginas sin sesión (acceso, configuración) con el tema del último usuario de ese navegador, marcado con `rm-theme-account=1`. Una cuenta sin tema adopta una vez la elección antigua del navegador (un `rm-theme` sin la marca, de ≤ 2.2.0), nunca la caché de otra cuenta. El cambio es optimista (se aplica al momento y vuelve al anterior con un aviso si falla); `ThemeAttrSync` repite la precedencia cuando React vuelve a pintar el layout raíz (`router.refresh`). |
| D40 | Sesiones vivas | WS y SSE registrados y revalidados cada 30 s y con `viewer.changed`/`session.revoked`. |
| D41 | Acceso a equipos | Un único módulo sin estado, `src/server/access.ts`, decide la visibilidad para los dos grafos. |
| D42 | Red de equipos | Misma IP en todos los equipos: una VLAN 802.1Q por puerto de un switch TP-Link Easy Smart y una interfaz VLAN `rmv<vid>` por puerto sobre la tarjeta que **elige un administrador** (nada se toca ni se busca antes, ni al arrancar; la antigua búsqueda automática ponía la dirección de gestión en cualquier adaptador USB libre y se quitó), con enrutamiento por origen (tablas 20000+vid con `unreachable default`, reglas con preferencia 1000+vid, antes de la principal y de Tailscale, `noprefixroute`, verificado con `ip route get`); el reenvío Ethernet elige la VLAN con `localAddress` y falla si falta. Otra tarjeta del servidor en la misma red que los equipos es un aviso, no un error; ARP estricto opcional desde el instalador. Nunca la tabla principal, la ruta por defecto ni otra tarjeta. El switch solo cambia con vista previa y confirmación, en un orden que no pierde la gestión, verificando cada paso y volviendo atrás si falla. Controladores de switch intercambiables (`tplink-easy-smart`, `manual`). NetworkManager: un *drop-in* `unmanaged-devices` (no una regla udev). |
| D43 | Enviar a equipo | SSH desde el servidor con `ssh2` (JavaScript puro, empaquetado sin partes nativas) por la misma ruta que el acceso Ethernet (VLAN del puerto del switch con `localAddress`, o IP:puerto), nunca por el puerto público; SFTP y, sin él, el protocolo scp; temporal + renombrar; verificación con `sha256sum`/`md5sum`; claves del equipo no fijadas (misma IP para todos), huella por equipo con aviso; contraseña recordada cifrada por equipo; la regla de la reserva del acceso SSH. |
| D44 | Copiar a una carpeta del servidor | Solo administradores (oculto y rechazado por el servidor para los demás). Como el servicio cuando puede escribir; si no, **como `sudo cp`**: un ayudante de root aparte (`relay-manager-rootcopy`, activado por socket) autenticado con la contraseña de **una sola cuenta fija**, `RM_SUDO_USER` (quien ejecutó `sudo ./install.sh`, o `--sudo-user`), que debe ser root o miembro de `RM_COPY_SUDO_GROUPS` (sudo, wheel, admin), no estar bloqueada ni caducada; el diálogo solo pide la contraseña. **Modelo de amenazas.** Al socket (`root:relay-manager` 0660) solo llega el usuario del servicio; un servicio comprometido (o un administrador de la web) sigue necesitando la contraseña de esa cuenta, y con ella ya podría usar `sudo`. La cuenta sale de `/etc/relay-manager/rootcopy.env` (`root:root`), nunca de la petición (un campo de usuario se ignora). La contraseña se comprueba con el `crypt(3)` del sistema (libxcrypt: yescrypt `$y$`, sha512 `$6$`, sha256 `$5$`, bcrypt) a través de `python3` (`ctypes` sobre `libcrypt.so.1`, o el módulo `crypt`) o, sin python3, `perl` (`perl-base` siempre está en Debian y Ubuntu), pasándola **por la entrada estándar** (nunca en los argumentos ni en el entorno), con una prueba previa de vectores conocidos y comparación en tiempo constante; root sin contraseña (lo normal con sudo) se rechaza con un mensaje claro. 5 contraseñas malas en 10 min bloquean 10 min (estado en `/var/lib/relay-manager-rootcopy/intentos.json`, 0600, que sobrevive a la reactivación) y cada fallo espera 1,5 s. **El ayudante nunca abre un origen**: el servicio lee el fichero de su carpeta (con sus propias reglas y sus permisos) y le envía los bytes; el diseño inicial le pasaba la ruta de origen (`srcPath`) para que la abriera como root, y enviar los datos elimina de raíz las carreras, los enlaces simbólicos y los enlaces duros del lado del origen (root nunca lee nada que el servicio no pudiera leer). El destino lo vuelve a validar el ayudante: ruta absoluta normalizada → `realpath` → lista prohibida y `RM_COPY_ROOT_PATHS` → apertura componente a componente con `O_NOFOLLOW` por `/proc/self/fd` y comprobación de la ruta abierta; temporal `O_EXCL` + `fsync` + relectura con sha256 + `rename`; el fichero queda del **dueño de la carpeta de destino** (así el usuario del escritorio puede usarlo en el pendrive), modo 0644. (Montar y expulsar, y los permisos de 5 minutos, llegaron después: D44b.) Docker y los modos portátil y de desarrollo no tienen ayudante. **Riesgos que quedan:** quien tenga esa contraseña escribe como root dentro de `RM_COPY_ROOT_PATHS` (es la función); la relectura tras `fsync` lee la caché de páginas, no el soporte; las cadenas de JavaScript no se pueden borrar de memoria (solo se ponen a cero los búferes); solo cuentas locales (`/etc/passwd`, `/etc/group`, `/etc/shadow`; no NSS ni LDAP); FAT y exFAT no admiten algunos nombres (`: ? * < > | " \`), que fallan con un mensaje; sin HTTPS la contraseña viaja sin cifrar por la red del laboratorio (el diálogo lo avisa; `install.sh --tls-selfsigned`); el bloqueo es de la cuenta, no de cada usuario de la web (quien falle 5 veces deja la copia como administrador sin servicio 10 minutos para todos), y las comprobaciones de contraseña van de una en una para que intentos simultáneos no superen el límite. Una carpeta del sistema montada otra vez bajo `RM_COPY_ROOT_PATHS` (`mount --bind /etc /mnt/x`, o el disco del sistema montado entero en `/mnt`) se reconoce por `/proc/self/mountinfo`: los otros nombres de la carpeta en su sistema de ficheros (`aliasesOf`) también pasan por la lista prohibida. |
| D44b | Montar pendrives y permisos de administrador | El PC del banco (Debian 12 sin escritorio) no monta los pendrives: «solo se monta con sudo». **Montar/Expulsar** desde el diálogo de copia y **permisos de 5 minutos** por sesión. **Montaje**: una tercera unidad, `relay-manager-rootmount` (mismo `app/rootcopy.js`, argumento `mount`), activada por socket `root:root` 0600 (solo root conecta: el ayudante de copia, después de autenticar la contraseña de `RM_SUDO_USER` o un permiso), **sin espacio de montaje propio** (un montaje dentro del espacio del ayudante de copia nunca llegaría al sistema ni al servicio, y `MountFlags=shared` no restablece la propagación con otras opciones de aislamiento; dar `CAP_SYS_ADMIN` al ayudante de copia anularía su `ProtectSystem`), solo `CAP_SYS_ADMIN`, `DevicePolicy=closed` + `DeviceAllow` de bloques `sd`/`mmc`/`blkext`, sin red, `@system-service @mount`. Vuelve a validar todo: `/dev/sdX[N]`, `/dev/mmcblkNpM`, `/dev/nvmeNnMpK` (y `/dev/loopN` solo con `RM_ROOTMOUNT_TEST_LOOP`, un `Environment=` de su unidad, en las pruebas), disco extraíble o USB, sin `holders`, sin ninguna partición del disco montada fuera de `/media`, `/run/media`, `/mnt` ni en *swap*, no montado ya, un disco con particiones no se monta entero; tipo con `blkid -p`; carpeta `/media/<RM_SUDO_USER>/<etiqueta saneada>` (solo `[A-Za-z0-9._-]`, carpetas padre reales y de root) creada por él y anotada en su estado; `mount -t <tipo> -o nosuid,nodev,noexec[,uid,gid=relay-files,umask=0002,dmask=0002,fmask=0113]`; expulsar solo puntos de `/media` o `/run/media` de dispositivos que pasan la misma validación, `sync` + `umount` (nunca `-l`) + `rmdir` de la carpeta vacía. Todo con `execFile` y rutas absolutas. **Permisos**: el ayudante de copia firma (HMAC-SHA256, clave de 32 bytes en su estado 0600) `{sid, wu, ru, iat, exp, jti}` con caducidad absoluta de 5 min, ligado a la sesión de la web (`sid` = sha256 de usuario, versión de sesión y hora de acceso: volver a entrar o cambiar la contraseña lo invalida), al usuario de la web y a la cuenta sudo que lo autorizó (`ru`: si cambia `RM_SUDO_USER`, deja de valer; y en cada uso se vuelve a comprobar que esa cuenta sigue con sudo, contraseña y sin bloquear); el servicio lo guarda en memoria y **nunca lo envía al navegador**; «Olvidar permisos» lo anula en el ayudante (`revoked.json` hasta que caduca). Un permiso inválido no cuenta como intento ni espera (solo las contraseñas llevan límite de intentos). Con permiso o contraseña el ayudante **lista** (solo metadatos con `lstat`, nunca abre un fichero) cualquier carpeta de `RM_COPY_ROOTS` salvo `/proc`, `/sys`, `/dev` y los estados de los ayudantes; para escribir siguen la lista prohibida y `RM_COPY_ROOT_PATHS`. **Modelo de amenazas**: un servicio comprometido sigue necesitando la contraseña (o un permiso vivo que solo él conoce y que dura 5 min) para montar; montar exige `CAP_SYS_ADMIN` solo en una unidad mínima que nadie más alcanza; un dispositivo malicioso (un pendrive con un sistema de ficheros manipulado) llega al núcleo igual que con `sudo mount` — el riesgo que ya asume quien monta a mano —, pero nunca con `suid`, dispositivos ni ejecutables; nada se monta fuera de `/media`; el robo de un permiso desde el navegador no es posible (no está allí) y un permiso de otra sesión se rechaza. **Riesgos que quedan**: quien tenga la sesión abierta del administrador durante esos 5 minutos actúa como administrador (cerrar sesión no anula el permiso: caduca solo; «Olvidar permisos» sí); el pendrive FAT/exFAT/NTFS queda legible para cualquier usuario local (`dmask=0002`, `fmask=0113`, como se pidió; `0007`/`0117` lo cerraría); listar como root revela nombres de ficheros de todo el sistema; el núcleo procesa el sistema de ficheros del pendrive. |
| D45 | Segunda carpeta y descarga con script | Una segunda raíz de Archivos (hoy `extra`, ver D46) con todas las operaciones, mismo grupo `relay-files`, 2775, ACL y `BindPaths=` que tftp; un núcleo por raíz y la raíz en la API, los eventos y la auditoría. En ella, un botón ejecuta un **script de descarga** externo con un contrato fijo (`bash <script> <app> <versión> -o <zip> [-x]`): argumentos como lista (nombre y versión con un juego de caracteres cerrado, sin `-` inicial), una ejecución a la vez con cola, grupo de procesos propio (cancelar y el tiempo máximo matan al grupo entero), sin las capacidades del servicio (`setpriv`), carpeta de trabajo propia `<datos>/descargas/<id>` fuera de la carpeta compartida como `cwd`, `HOME` y `TMPDIR`, entorno en lista blanca, registro en directo tachando la contraseña configurada, zip copiado sin sobrescribir y carpeta de trabajo borrada. Credenciales `RM_EXPORT_USER`/`RM_EXPORT_PASSWORD` solo en `config.env`, pasadas con los nombres que fije el perfil (`RM_EXPORT_ENV_*`), nunca al navegador. Las claves antiguas de `config.env` las renombra `install.sh` con la tabla `migraciones-config.txt` del perfil, si la trae. Riesgo que queda: el script es código del proyecto (ver 9.8). |
| D46 | Perfil del proyecto (3.0) | El repositorio y el paquete son **genéricos**: todo lo de un proyecto (nombre del laboratorio, plantillas, segunda carpeta, script de descarga y sus textos, IP de los equipos) sale del código a un **perfil** externo (`RM_PROFILE_DIR`: `/etc/relay-manager/perfil`, `<paquete>/perfil`, `/perfil`, `<repo>/perfil`), con precedencia entorno > `config.env` > `perfil.env` > valores por defecto y una lista cerrada de claves admitidas en `perfil.env`. Las **plantillas son ficheros** (`plantillas/*.json`, una por fichero, clave estable, esquema JSON publicado) y la fuente de verdad: se sincronizan al arrancar, con «Recargar plantillas» y con `relay-manager plantillas recargar`; las de fichero son de solo lectura («Duplicar» para editar), las que pierden su fichero quedan «Retirada» (nunca se borran) y las predefinidas de 2.x pasan a locales y se vinculan solas con el fichero de su clave, así que actualizar no pierde nada. Los equipos nunca cambian (D9). Un fichero con errores no se aplica y se informa con fichero y ruta JSON. «IP de los equipos» deja de tener valor por defecto. Por qué: el mismo programa sirve a varios proyectos sin ramas propias y sin publicar sus datos; `.gitignore` y la prueba de marcadores (`test/marcadores.test.ts`) impiden subir configuración de un proyecto por error. |
