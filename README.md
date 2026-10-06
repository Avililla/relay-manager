# Relay Manager

**Relay Manager** es una aplicación web para bancos de integración y pruebas de hardware. Desde el navegador da acceso compartido a las **consolas serie** de los equipos bajo prueba, que llegan al equipo del banco por adaptadores USB-serie, y controla, si las hay, las **placas de relés Devantech** que alimentan o reinician esos equipos.

El programa es **genérico**: lo propio de cada proyecto (nombre del laboratorio, plantillas de equipo, una segunda carpeta compartida, un script de descarga, la IP de los equipos…) va en un **perfil** aparte, fuera del repositorio y del paquete. Cómo se escribe uno: [docs/PERFIL.md](docs/PERFIL.md); hay un ejemplo genérico en [examples/perfil-ejemplo/](examples/perfil-ejemplo/).

Varias personas pueden mirar la misma consola a la vez, pero solo quien tiene el equipo **reservado** puede escribir en ella. El servidor graba continuamente todo lo que sale por cada consola, aunque nadie la esté mirando, y registra en la auditoría quién hizo qué. Está pensado para una red de laboratorio **sin conexión a Internet**: se instala desde un paquete que lo lleva todo dentro (incluido Node.js), como servicio de systemd, en modo portátil o con Docker.

## Funciones

- **Banco:** todos los equipos de un vistazo, con el estado de cada consola, la última línea recibida, los relés y quién tiene cada equipo reservado, en directo.
- **Consolas en el navegador** (xterm): varias a la vez en columnas, cuadrícula o pestañas; historial al abrir; búsqueda, copia, teclas especiales y BREAK.
- **Reservas de un clic** con cuenta atrás, renovación al escribir, aviso antes de caducar y liberación forzada por un administrador (con motivo).
- **Soltar y retomar puertos** para usar BITReader_Tool, picocom o `hw_server` sobre el mismo puerto, con duración opcional.
- **Captura continua** a disco con marcas de tiempo, rotación, compresión, retención por días y por tamaño, pausa automática si falta disco y descarga desde la consola.
- **Plantillas** de equipo, definidas en ficheros JSON del perfil (de solo lectura en la aplicación, con «Recargar plantillas» y esquema JSON para el editor) o creadas en la propia aplicación, y **asistente de nuevo equipo**: consolas y relés, asignación de adaptadores agrupados por dispositivo USB, «Asignar en orden», vista previa en directo e identificación pasiva de cada puerto.
- **Descubrimiento automático** de adaptadores USB-serie (conexión en caliente, reconexión sin perder la asignación) y de placas Devantech (anuncios UDP, búsqueda y escaneo de solo lectura).
- **Accesos de red por equipo** para trabajar en paralelo desde cada PC: un puerto TCP fijo (3201–3230) por cable **JTAG** (un `hw_server` por cable, filtrado por su número de serie, para xsdb/xsct, Vivado o Vitis), por **consola serie** (`nc`/`telnet` sobre la misma consola que la web, escritura solo con reserva) y para la **Ethernet** del equipo (reenvío TCP, por ejemplo `ssh -p`). Se abren al reservar el equipo; estado, conexiones y órdenes para copiar en la pestaña «Accesos»; mapa de puertos del banco en Sistema.
- **Red de equipos:** todos los equipos tienen la misma IP; cada uno va a un puerto de un switch TP-Link Easy Smart y su acceso Ethernet se elige por el **número de puerto**. La aplicación encuentra el switch en un adaptador USB-Ethernet dedicado, lo prepara con un clic («Preparar switch»: una VLAN por puerto, con vista previa, comprobación del puerto del servidor, copia y vuelta atrás si algo falla) y mantiene sola sus interfaces VLAN y su enrutamiento propio, sin tocar nunca la red del laboratorio ([OPERACION.md](docs/OPERACION.md#312-red-de-equipos), [INSTALACION.md](docs/INSTALACION.md#17-red-de-equipos-switch-y-adaptador-usb)).
- **Cables:** inventario de cables JTAG, adaptadores USB-serie y adaptadores de red con nombre («JTAG-07», el de la pegatina): se etiquetan conectándolos con el diálogo abierto y después se eligen por nombre en el asistente y en los ajustes.
- **Archivos:** una carpeta compartida del servidor, **tftp** (`~/tftp`), y una segunda opcional que define el perfil (por ejemplo «Compartida» en `~/compartida`), con un selector arriba, para subir ficheros desde el PC (arrastrar y soltar, varios a la vez, progreso, reanudación de fragmentos, nombres repetidos) y descargarlos (con reanudación), carpetas y selecciones como `.zip` o `.tar.gz` generados al vuelo, nuevas carpetas, cambiar nombre, mover y borrar; en directo entre usuarios y auditado. **Enviar a equipo** (clic derecho en un archivo): lo copia por SSH desde el servidor a la memoria de un equipo reservado, por la misma ruta que su acceso Ethernet (su puerto del switch o su IP), con SFTP o scp, progreso, verificación SHA-256 y usuario/contraseña/ruta recordados (la contraseña, cifrada). **Copiar a una carpeta del servidor** (solo administradores): a un pendrive u otra carpeta del propio servidor, eligiendo la unidad y la carpeta en un diálogo, con verificación sha256; si el servicio no puede escribir allí, **como administrador (sudo)** con la contraseña del usuario que instaló la aplicación, mediante un ayudante de root aparte y aislado (`relay-manager-rootcopy`). Con esa contraseña también se **montan y expulsan pendrives** desde la web (el PC del banco no los monta solo; un ayudante de montaje mínimo, `relay-manager-rootmount`, en `/media/<usuario>/<etiqueta>`, solo dispositivos extraíbles), se **ven carpetas protegidas** (solo nombres y tamaños) y la sesión **no vuelve a pedirla durante 5 minutos** («Olvidar permisos»). **Descargas** (opcional, desactivado por defecto): ejecuta en el servidor el script de descarga del perfil (`<script> <aplicación> <versión> -o <salida.zip> [-x]`) y deja el `.zip` en la carpeta compartida, una descarga a la vez, con registro en directo y «Cancelar».
- **Relés opcionales:** placas dS (ASCII TCP o HTTP) y ETH, con verificación de cada cambio, pulsos y confirmación para los relés de alimentación. Todo funciona igual con cero placas.
- **Usuarios y roles:** los roles deciden qué equipos ve cada usuario.
- **Auditoría** de solo inserción con filtros y exportación CSV.
- **Sistema:** ajustes, copias de seguridad diarias y manuales, exportación e importación de la configuración, y comprobaciones de salud.
- **Seguridad:** primer arranque con código de un solo uso, filtro de Origin, WebSocket autenticado, sesiones revalidadas cada 30 s y TLS opcional.
- **Interfaz en español**, temas Oscuro (por defecto), Claro, Sistema y Rosa (el tema se guarda en la cuenta de cada usuario: el mismo en cualquier PC), y fuentes Atkinson Hyperlegible incluidas.

## Inicio rápido (desarrollo)

Necesitas Node 22.23.2, pnpm 12.5.1 y python3 (para las consolas simuladas). Detalles en [docs/DESARROLLO.md](docs/DESARROLLO.md).

```bash
pnpm install
pnpm dev:sim
```

`pnpm dev:sim` arranca un **banco simulado** (cuatro consolas Zynq falsas, dos placas Devantech simuladas, dos cables JTAG falsos con un `hw_server` simulado y un destino Ethernet de prueba) y el servidor de desarrollo. Abre la dirección que imprime (por ejemplo `http://localhost:3200`), escribe el **código de configuración** que aparece en el banner del servidor y crea tu administrador.

Para tener equipos de ejemplo ya creados, para el servidor, ejecuta `pnpm dev:seed` y vuelve a `pnpm dev:sim`; el script imprime los usuarios que crea.

## Inicio rápido (instalación sin conexión)

1. En el equipo de desarrollo: `pnpm bundle` genera `dist/relay-manager-<versión>-linux-x64.tar.gz` y su `.sha256`.
2. Cópialos al equipo del banco (Ubuntu 24.04 x86_64) y comprueba: `sha256sum -c relay-manager-*.tar.gz.sha256`.
3. Descomprime en un disco ext4: `tar xzf relay-manager-*.tar.gz && cd relay-manager-*-linux-x64`.
4. Instala el servicio: `sudo ./install.sh` (con `--perfil <carpeta>` para instalar también el perfil de tu proyecto). Muestra las direcciones y el código de configuración.
5. Abre la dirección en el navegador y completa la configuración inicial. Todo el detalle (portátil, Docker, TLS, actualizar, volver atrás) está en [docs/INSTALACION.md](docs/INSTALACION.md).

## Documentación

| Guía | Contenido |
|---|---|
| [docs/INSTALACION.md](docs/INSTALACION.md) | Instalación sin conexión: servicio, portátil y Docker; TLS; actualizar, volver atrás y desinstalar; red; todas las variables `RM_*` |
| [docs/OPERACION.md](docs/OPERACION.md) | Uso diario y administración; capturas; copias y restauración; referencia de la línea de órdenes; `doctor`; solución de problemas |
| [docs/PERFIL.md](docs/PERFIL.md) | Cómo escribir el perfil de un proyecto: `perfil.env`, plantillas en JSON (esquema en [docs/plantilla.schema.json](docs/plantilla.schema.json)), script de descarga y manuales |
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | Procesos, módulos, datos, protocolos, seguridad y decisiones de diseño |
| [docs/DESARROLLO.md](docs/DESARROLLO.md) | Entorno, simuladores, pruebas, convenciones, controladores de relés y publicación |

## Tecnologías

| Capa | Tecnología |
|---|---|
| Servidor | Node 22, un único proceso con servidor HTTP/HTTPS propio, WebSocket (`ws`) y SSE |
| Web | Next.js 16 (App Router, React 19, Server Components y server actions), Tailwind CSS 4, Radix UI, xterm.js 5 |
| Datos | SQLite con Prisma 7 y `better-sqlite3`; migraciones aplicadas por un runner propio al arrancar |
| Autenticación | NextAuth 5 (credenciales, JWT) |
| Hardware | `serialport` 13 (descubrimiento por sysfs); controladores Devantech por HTTP y TCP; descubrimiento UDP 30303 |
| Validación | zod 4 |
| Pruebas | Vitest, `playwright-core` con el Chrome del sistema, pruebas del paquete en Docker sin red |
| Empaquetado | esbuild, traza `nft` de Next, Node 22.23.2 incluido, systemd, udev y Docker |

## Órdenes

| Orden | Qué hace |
|---|---|
| `pnpm dev` | Servidor de desarrollo (`RM_DEV=1 tsx server.ts`), puerto 3200, datos en `.data/` |
| `pnpm dev:sim` | Banco simulado y servidor de desarrollo |
| `pnpm dev:seed` | Carga equipos, una placa y dos usuarios de ejemplo en `.data/` (con el servidor parado) |
| `pnpm sim` | Solo el banco simulado; imprime las variables para el servidor |
| `pnpm sim:consoles` / `pnpm sim:relays` | Solo las consolas o solo las placas simuladas |
| `pnpm build` | Cliente Prisma, `next build` y el servidor con esbuild (`build/server.js`) |
| `pnpm start` | Arranca lo compilado en modo portátil con datos en `.data/` |
| `pnpm bundle` | Paquete sin conexión en `dist/` (`--skip-tests`, `--docker`, `--perfil <carpeta>`) |
| `pnpm image` | Paquete e imagen Docker, sin pruebas |
| `pnpm test` / `pnpm test:watch` | Pruebas unitarias y de integración (Vitest) |
| `pnpm test:e2e` | Prueba de extremo a extremo en el navegador |
| `pnpm test:bundle` | Prueba del paquete en `ubuntu:24.04` sin red |
| `pnpm test:net` | Prueba de la red de equipos con un núcleo Linux real, en un contenedor aislado |
| `pnpm lint` / `pnpm typecheck` | ESLint y TypeScript |
| `pnpm db:generate` | Genera el cliente Prisma |
| `pnpm db:new <nombre>` | Crea una migración nueva |
| `pnpm db:check` | Comprueba que el esquema y las migraciones coinciden |
| `pnpm doctor` | Diagnóstico en modo desarrollo |
| `pnpm fonts:vendor` | Descarga una vez las fuentes a `src/fonts/` (ya están versionadas) |

## Estructura del proyecto

```
server.ts               entrada del proceso: órdenes y arranque
src/app/                páginas y rutas de API (Next.js)
src/actions/            server actions (todas las modificaciones)
src/components/         interfaz: shell, terminal, formularios, pantallas
src/lib/                contratos compartidos (zod), textos en español, lógica pura de serie y relés
src/server/             servidor: arranque, configuración, HTTP, auth, serie, relés, archivos, red de equipos, dominio, copias, CLI
prisma/                 esquema y migraciones
scripts/                empaquetado, pruebas del paquete, simuladores y semilla de desarrollo
packaging/              lanzador, instalador, unidad systemd, regla udev y Docker
examples/perfil-ejemplo/ perfil de ejemplo genérico (perfil.env, plantillas, script de descarga)
test/                   ayudas de pruebas, sysfs simulado e integración
docs/                   documentación
```

## Licencia y créditos

Licencia MIT: consulta [LICENSE](LICENSE). Autores: **Alejandro Ávila Marcos** (autor original) y **Jose Duro Gómez** (versiones 2 y 3). Hecho para el **equipo de desarrollo de Valdepeñas**. La licencia exige mantener visible la atribución al autor original en los trabajos derivados, su documentación y su interfaz (en la aplicación, en Sistema → Acerca de).

La versión 2.0 adaptó Relay Manager a los bancos de integración: consolas primero, relés opcionales, instalación sin conexión y funcionamiento multiusuario. La 3.0 separa del programa todo lo propio de un proyecto, que pasa a un perfil externo.

Las fuentes Atkinson Hyperlegible Next y Mono se distribuyen con su licencia SIL Open Font License en `src/fonts/`.
