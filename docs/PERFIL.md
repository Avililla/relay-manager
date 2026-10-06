# Cómo escribir un perfil de Relay Manager

Relay Manager es genérico: el programa no lleva nada de ningún proyecto. Lo propio de cada banco (el nombre del
laboratorio, las **plantillas de equipo**, una **segunda carpeta compartida**, un **script de descarga**, la IP de los
equipos…) va en un **perfil**: una carpeta aparte, fuera del repositorio y del paquete, que cada equipo de trabajo
mantiene (normalmente en su propio repositorio). Esta guía explica cómo escribir uno. Cómo se instala está en
[INSTALACION.md](INSTALACION.md#20-perfil-del-proyecto) y cómo se usan las plantillas en
[OPERACION.md](OPERACION.md).

El repositorio trae un perfil de ejemplo genérico en [`examples/perfil-ejemplo/`](../examples/perfil-ejemplo/): cópialo
como punto de partida.

## 1. Estructura

```
mi-perfil/
  perfil.env                 valores por defecto del proyecto (formato dotenv)
  plantillas/*.json          una plantilla de equipo por fichero
  herramientas/              scripts del proyecto (por ejemplo, el script de descarga)
  manuales/                  fuentes de los manuales del proyecto (opcional; la aplicación no lo usa)
  README.md                  opcional: qué es, quién lo mantiene, qué necesita el script
```

Todo es opcional: un perfil vacío (o sin perfil) da los valores genéricos. De `plantillas/` solo se leen los `*.json`
del primer nivel; los que empiezan por `.` o `_` se ignoran (útil para borradores: `_nueva.json`).

**Dónde lo busca la aplicación** (`RM_PROFILE_DIR`, que solo se puede poner en las variables del proceso o en
`config.env`, nunca en `perfil.env`):

| Modo | Carpeta |
|---|---|
| Servicio (`install.sh`) | `/etc/relay-manager/perfil` (se instala con `sudo ./install.sh --perfil <carpeta>`) |
| Portátil | `<carpeta del paquete>/perfil` |
| Docker | `/perfil` (montada en solo lectura desde `RM_PROFILE_HOST_DIR`, por defecto `./perfil`) |
| Desarrollo | `<repositorio>/perfil`, si existe (git la ignora: nunca se sube por error) |

Si la carpeta no existe, no hay perfil: la aplicación usa los valores genéricos y la comprobación «Perfil» de Salud y
`doctor` lo dice como información. Si `RM_PROFILE_DIR` está puesta y la carpeta no existe, es un aviso.

## 2. `perfil.env`

Fichero `CLAVE=valor` (como `config.env`: comillas opcionales, `#` para comentarios). Solo admite las **claves del
perfil** de la tabla; cualquier otra se ignora con el aviso «Variable no permitida en perfil.env: X» (en Salud,
`doctor` y el registro del arranque). Las rutas relativas (`RM_EXPORT_DOWNLOADER`) son relativas a la carpeta del perfil.

**Precedencia:** variables del proceso > `config.env` (lo que cambia el administrador de cada servidor) > `perfil.env`
> valores por defecto del programa. Así un servidor concreto puede cambiar cualquier valor del perfil sin tocarlo.

| Clave | Qué hace | Sin perfil |
|---|---|---|
| `RM_LAB_NAME` | Nombre del laboratorio. Solo se aplica al crear la base de datos; después se cambia en Sistema › General | «Relay Manager» |
| `RM_FILES_EXTRA_NAME` | Nombre de la **segunda carpeta compartida** de Archivos (raíz `extra`). Sin él no hay segunda carpeta | sin segunda carpeta |
| `RM_FILES_EXTRA_ENABLED` | `0` la quita aunque tenga nombre | `1` si hay nombre |
| `RM_FILES_EXTRA_DIR` | Su carpeta. `~/…` es la carpeta personal del usuario (en el servicio, `install.sh` la resuelve con la del usuario que instala y la escribe en `config.env`) | servicio: `<datos>/<nombre>`; portátil y desarrollo: `~/<nombre>`; Docker: `/extra` |
| `RM_FILES_EXTRA_HINT` | Una línea que la describe en el selector de carpetas | «Segunda carpeta compartida (<carpeta>)» |
| `RM_EXPORT_ENABLED` | `1` activa **Descargas** (el script de descarga) | `0` |
| `RM_EXPORT_DOWNLOADER` | El script (relativo a la carpeta del perfil, por ejemplo `herramientas/descarga.sh`) | ninguno (activado sin script: Salud avisa) |
| `RM_EXPORT_TIMEOUT_MIN` | Tiempo máximo de una descarga, en minutos | `60` |
| `RM_EXPORT_ROOT` | Dónde queda el zip: `extra` o `tftp` | `extra` si hay segunda carpeta; si no, `tftp` |
| `RM_EXPORT_NAME` | Nombre corto (panel, auditoría, Salud) | «Descargas» |
| `RM_EXPORT_TITLE` | Título del botón, del menú y del diálogo | «Ejecutar script de descarga…» |
| `RM_EXPORT_DESCRIPTION` | Párrafo del diálogo | una frase genérica |
| `RM_EXPORT_APP_LABEL` / `RM_EXPORT_VERSION_LABEL` | Etiquetas de los dos campos | «Aplicación» / «Versión» |
| `RM_EXPORT_EXTRACT_LABEL` | Etiqueta de la casilla opcional que añade `-x`; sin ella, la casilla no aparece | sin casilla |
| `RM_EXPORT_URL` | URL del repositorio de artefactos: se pasa al script y Salud comprueba que responde (HEAD, 3 s, solo aviso) | sin definir (ni se pasa ni se comprueba) |
| `RM_EXPORT_USER` / `RM_EXPORT_PASSWORD` | Credenciales del repositorio que se pasan al script. Mejor en `config.env` (0640) que en el perfil | sin definir |
| `RM_EXPORT_ENV_USER` / `RM_EXPORT_ENV_PASSWORD` / `RM_EXPORT_ENV_URL` | Nombres de las variables con las que el script recibe usuario, contraseña y URL (mayúsculas, `A-Z0-9_`, distintos y que no sean del sistema: ni `PATH`, `HOME`, `LD_*`, `RM_*`…). La contraseña se tacha también tras `<nombre>=` en el registro y en el propio script | `EXPORT_USER` / `EXPORT_PASSWORD` / `EXPORT_URL` |
| `RM_EXPORT_ENV_EXTRA` | Variables fijas para las herramientas del script, `NOMBRE=valor` separadas por espacios (hasta 16; valores con letras, números y `. _ : / @ + -`) | ninguna |
| `migraciones-config.txt` | Fichero opcional del perfil (no es una variable): si existe trae `migraciones-config.txt` con líneas `CLAVE_VIEJA CLAVE_NUEVA` (solo claves `RM_*`, `#` para comentarios), `install.sh` renombra esas claves en `config.env` al actualizar, después de guardar una copia | — |
| `RM_EQUIPNET_EQUIPMENT_IP` | «IP de los equipos» inicial de Red de equipos (solo al crearla; después se cambia en Sistema) | sin IP: hay que configurarla |
| `RM_EQUIPNET_EQUIPMENT_PORT` | Puerto por defecto de los accesos Ethernet nuevos y de «Enviar a equipo» | `22` |

Ejemplo:

```bash
# perfil.env del banco «Laboratorio de pruebas»
RM_LAB_NAME="Laboratorio de pruebas"
RM_FILES_EXTRA_NAME=Compartida
RM_FILES_EXTRA_DIR=~/compartida
RM_FILES_EXTRA_HINT="Imágenes y paquetes del proyecto (~/compartida)"
RM_EXPORT_ENABLED=1
RM_EXPORT_DOWNLOADER=herramientas/descarga.sh
RM_EXPORT_TITLE="Descargar paquete…"
RM_EQUIPNET_EQUIPMENT_IP=192.168.1.10
```

## 3. Plantillas (`plantillas/*.json`)

Cada fichero define **una** plantilla de equipo. Los ficheros son la fuente de verdad: la aplicación los copia a su
base de datos al arrancar, con el botón «Recargar plantillas» de la página Plantillas (administradores) y con
`relay-manager plantillas recargar`. En la aplicación salen con el chip «Fichero» y son de solo lectura («Definida en
plantillas/equipo-a.json»); «Duplicar» crea una copia local editable.

### 3.1 Formato

El esquema JSON está en [`docs/plantilla.schema.json`](plantilla.schema.json): con `"$schema"` apuntando a él, VS Code
y otros editores autocompletan y marcan los errores mientras escribes. Las claves desconocidas son un error.

```json
{
  "$schema": "../../relay-manager/docs/plantilla.schema.json",
  "key": "equipo-a",
  "name": "Equipo A",
  "description": "Unidad con dos UART y Ethernet",
  "needsReview": false,
  "position": 0,
  "namePattern": "Equipo A #{nn}",
  "skipInterfaces": [],
  "consoles": [
    {
      "key": "UART0", "label": "UART0",
      "line": { "baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1, "flowControl": "none" },
      "enterMode": "cr", "localEcho": false, "identify": { "hostnameRegex": "uart0" }
    },
    {
      "key": "UART1", "label": "UART1",
      "line": { "baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1, "flowControl": "none" },
      "identify": { "hostnameRegex": "uart1" }
    }
  ],
  "relays": [
    { "key": "POWER", "label": "Alimentación", "purpose": "power", "requireConfirm": true }
  ],
  "accesses": [
    { "key": "JTAG0", "label": "JTAG 0", "kind": "jtag" },
    { "key": "SERIE0", "label": "Serie UART0", "kind": "serial", "consoleKey": "UART0" },
    { "key": "ETH", "label": "Ethernet", "kind": "tcp", "targetMode": "switch", "targetPort": 22, "sshUser": "root" }
  ]
}
```

| Campo | Qué es |
|---|---|
| `key` | **Identidad estable** de la plantilla: minúsculas, números y guiones (`^[a-z0-9][a-z0-9-]{0,39}$`), única entre todos los ficheros. No la cambies: con otra clave es otra plantilla (la anterior queda «Retirada») |
| `name` | Nombre visible (hasta 40 caracteres). Si otra plantilla ya lo usa, se guarda como «<nombre> (<clave>)» con un aviso |
| `description` | Opcional, hasta 300 caracteres |
| `needsReview` | `true` muestra el aviso «Revisar» (valores provisionales que alguien debe comprobar) |
| `position` | Orden en las listas (menor primero); sin él, el orden de los nombres de fichero. El asistente de nuevo equipo propone la primera |
| `namePattern` | Nombre de los equipos nuevos: `{template}`, `{n}`, `{nn}`, `{nnn}` (por defecto `{template} #{nn}`) |
| `skipInterfaces` | Interfaces USB que «Asignar en orden» se salta (por ejemplo, la del JTAG de un adaptador) |
| `consoles[]` | Hasta 16. `key` (mayúsculas, números y `_`, por ejemplo `UART0`), `label`, `line` (`baudRate`, `dataBits` 5–8, `parity` `none`/`even`/`odd`/`mark`/`space`, `stopBits` 1–2, `flowControl` `none`/`rtscts`/`xonxoff`), `enterMode` (`cr`, `lf`, `crlf`), `localEcho`, `identify` (`hostnameRegex`, `bannerRegex`: expresiones para la identificación pasiva) |
| `relays[]` | Hasta 32. `key`, `label`, `purpose` (`power`, `reset`, `mode`, `generic`), `requireConfirm`, `defaultPulseMs` |
| `accesses[]` | Hasta 16, sin puertos (se asignan al crear cada equipo). `key`, `label`, `kind` (`jtag`, `serial`, `tcp`), `policy` (`reserved` o `always`), `consoleKey` (serie: la consola), `targetMode` (`switch`: un puerto del switch de la red de equipos; `ip`: `targetHost`), `targetHost`, `targetPort`, `sshUser`, `cableName` (JTAG, rara vez) |

### 3.2 Errores

Un fichero con errores **no se aplica** (su plantilla, si ya existía, se queda como estaba) y el resto sí. Los errores,
en español, nombran el fichero y el campo:

```
plantillas/equipo-a.json: consoles[1].key: Clave repetida: UART0
plantillas/equipo-b.json: JSON no válido (línea 3, columna 5)
plantillas/equipo-c.json: accesses[2].consoleKey: …
```

Salen en el registro del arranque, en Salud y `doctor` (comprobación «Perfil», en rojo), en el informe de «Recargar
plantillas» y en `relay-manager plantillas recargar` / `comprobar` (que terminan con código 1 si hay alguno).
Antes de instalar un perfil, compruébalo:

```bash
relay-manager plantillas comprobar            # con el perfil instalado, sin tocar la base de datos
RM_DEV=1 RM_PROFILE_DIR=$PWD/mi-perfil pnpm exec tsx server.ts plantillas comprobar   # desde el repositorio
```

### 3.3 Qué hace la sincronización

| Situación | Resultado |
|---|---|
| Fichero válido y ninguna plantilla con esa clave | se crea (origen «Fichero») |
| Ya hay una plantilla «Fichero» con esa clave | se actualizan nombre, descripción, «Revisar», orden y contenido; si estaba retirada, vuelve |
| Hay una plantilla **local** con esa clave (una predefinida de 2.x, o una importada con clave) | se **vincula**: pasa a «Fichero» con los valores del fichero (el informe lo dice: «vinculada») |
| Fichero con errores | su plantilla no se toca; se informa del error |
| Una plantilla «Fichero» cuyo fichero ya no está | queda **«Retirada»**: nunca se borra, sus equipos siguen igual, no se ofrece para equipos nuevos y un administrador la puede eliminar |

Los **equipos nunca cambian**: una plantilla se copia al crear cada equipo. Las plantillas locales con clave que no
tienen fichero siguen siendo locales y editables (no se pierde nada al actualizar desde 2.x).

## 4. Script de descarga (`herramientas/`)

Con `RM_EXPORT_ENABLED=1` y `RM_EXPORT_DOWNLOADER`, Archivos muestra el botón de **Descargas** (`RM_EXPORT_TITLE`).
Cualquier usuario con sesión lo lanza; el servidor ejecuta, una descarga a la vez:

```
bash <script> <aplicación> <versión> -o <salida.zip> [-x]
```

- `<aplicación>` y `<versión>`: letras, números y `. _ + -` (sin `-` ni `.` al principio), hasta 100 caracteres.
- `-o <salida.zip>`: el script debe dejar ahí **un zip** (fichero normal, no un enlace). La aplicación lo copia después a
  la carpeta `RM_EXPORT_ROOT` sin sobrescribir nada (`nombre (2).zip`).
- `-x`: solo si el perfil define `RM_EXPORT_EXTRACT_LABEL` y el usuario marca la casilla; el significado es del script.
- Código de salida 0 = bien; cualquier otro = error. Lo que imprime (stdout y stderr) se ve en directo en el panel, sin
  colores ANSI y con las contraseñas tachadas.
- Se ejecuta como el usuario del servicio, **sin capacidades** (`setpriv`), con una carpeta de trabajo propia y vacía
  como directorio actual, `HOME` y `TMPDIR`, y un **entorno cerrado**: `PATH` del sistema, `LANG`/`LC_ALL`, `CI=true`
  las variables fijas de `RM_EXPORT_ENV_EXTRA` y, solo si están definidas, la URL y las credenciales (por defecto
  `EXPORT_URL`, `EXPORT_USER` y `EXPORT_PASSWORD`; los nombres los elige el perfil con `RM_EXPORT_ENV_*`). Nada más
  de la configuración del servicio.
- «Cancelar» y el tiempo máximo (`RM_EXPORT_TIMEOUT_MIN`) mandan `SIGTERM` a todo el grupo de procesos y `SIGKILL` a
  los 5 s.
- **El script comprueba sus propias dependencias** (por ejemplo `curl` o `zip`) y lo dice en su salida: la aplicación
  solo comprueba que el script existe y se puede leer, y que hay `bash` y `setpriv`. Lista lo que necesita en el
  README del perfil.
- No escribas credenciales dentro del script: léelas de las variables de entorno.

El ejemplo `examples/perfil-ejemplo/herramientas/descarga-ejemplo.sh` cumple el contrato (crea un zip pequeño): sirve
de plantilla y lo usan las pruebas.

## 5. Manuales (`manuales/`)

Opcional, y la aplicación no lo usa. Si el proyecto tiene manuales propios en HTML (con sus capturas), las herramientas
genéricas del repositorio los convierten en PDF y repiten las capturas contra un banco simulado:

```bash
node scripts/manuales/generar.mjs --manuales <perfil>/manuales [--out <carpeta>]
node scripts/manuales/capturas.mjs --manuales <perfil>/manuales --dir /tmp/rm-capturas [--contenedor]
node scripts/manuales/optimizar.mjs --manuales <perfil>/manuales /tmp/rm-capturas/shots
```

La carpeta lleva los `*.html`, `estilo.css`, `img/`, `etapas.mjs` (las etapas de las capturas, que exporta `STAGES`) y,
opcionalmente, `manuales.json` (nombre del producto en la cabecera y nombres de los PDF) y `banco.json` (nombres de host
de las consolas simuladas). Detalles en [DESARROLLO.md](DESARROLLO.md#10-manuales-del-proyecto).

## 6. Instalar y actualizar el perfil

- **Servicio:** `sudo ./install.sh --perfil <carpeta>` lo copia a `/etc/relay-manager/perfil` (root:relay-manager,
  ficheros 0640, carpetas 0750, `herramientas/*.sh` 0750); el anterior queda en `perfil.anterior-<fecha>`. Sin
  `--perfil`, se instala el que lleve el paquete solo si aún no hay ninguno.
- **Paquete con perfil:** `bash scripts/build-bundle.sh --perfil <carpeta>` lo mete como `perfil/` en el paquete.
- **Docker:** pon la carpeta en `RM_PROFILE_HOST_DIR` (se monta en `/perfil`, solo lectura).
- Tras cambiar plantillas: «Recargar plantillas» o `sudo relay-manager plantillas recargar` (sin reiniciar). Tras
  cambiar `perfil.env`: `sudo relay-manager restart`.

## 7. Que no se suba por error

El `.gitignore` del repositorio ignora `perfil/`, `perfil-*/`, `plantillas/`, `herramientas/`, `*.env`, `perfil.env`
(salvo el del ejemplo) y `.marcadores-proyecto`. Además, `pnpm test` incluye una comprobación de marcadores que falla si
cualquier fichero que git subiría contiene el nombre de un proyecto: añade los tuyos al fichero `.marcadores-proyecto`
de tu copia del repositorio ([DESARROLLO.md](DESARROLLO.md#9-configuración-del-proyecto-fuera-del-repositorio)).
