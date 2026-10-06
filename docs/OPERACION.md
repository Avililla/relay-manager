# Operación de Relay Manager

Guía de uso diario y de administración. La instalación está en [INSTALACION.md](INSTALACION.md) y el diseño interno en [ARQUITECTURA.md](ARQUITECTURA.md).

En los ejemplos, `relay-manager` es la orden instalada como servicio. En modo portátil usa `./bin/relay-manager` desde la carpeta del paquete, y en Docker `docker compose exec relay-manager relay-manager`.

---

## 1. Conceptos

| Término | Qué es |
|---|---|
| **Equipo** | Una unidad bajo prueba (por ejemplo «Equipo A #01»). Tiene de 0 a 16 consolas y de 0 a 32 relés. |
| **Plantilla** | Un modelo de equipo (consolas y relés típicos), definido en un fichero del perfil (`plantillas/*.json`) o creado en la web. Al crear un equipo se **copia**: cambiar la plantilla después no cambia los equipos ya creados. |
| **Consola** | Un canal UART del equipo (por ejemplo `UART0` o `UART1`), conectado por un adaptador USB-serie. |
| **Puerto serie** | El dispositivo `/dev/ttyUSB…` o `/dev/ttyACM…` de un adaptador. |
| **Placa de relés** | Una placa Devantech en la red del laboratorio. Es **opcional**: todo funciona sin placas. |
| **Reserva** | Quién puede escribir en las consolas y actuar sobre los relés de un equipo. Todos los que ven el equipo pueden **ver** sus consolas; solo quien lo tiene reservado puede **escribir**. |
| **Soltar puerto** | Cerrar temporalmente un puerto serie para usarlo con otra herramienta (picocom, BITReader_Tool, `hw_server`). |
| **Captura** | El registro continuo en disco de todo lo que sale por cada consola, aunque nadie la esté mirando. |
| **Acceso** | Un puerto TCP fijo del servidor (rango 3201–3230) para trabajar con un equipo desde tu PC: **JTAG** (un `hw_server` por cable), **consola serie** por TCP (la misma consola que ves en la web) o **Ethernet** (reenvío a la IP del equipo, por ejemplo SSH). |
| **Cable etiquetado** | Un cable JTAG, un adaptador USB-serie o un adaptador de red USB con nombre («JTAG-07», «ETH-01», el de su pegatina) en **Cables**. Al configurar un equipo se elige por su nombre. |
| **Red de equipos** | Todos los equipos tienen la **misma IP** en su Ethernet (la «IP de los equipos», por ejemplo 192.168.1.10). Cada uno va a un puerto de un switch pequeño (TP-Link Easy Smart), cada puerto es su propia VLAN y el servidor llega a cada uno por separado con un adaptador USB-Ethernet dedicado. En el acceso Ethernet de un equipo solo se elige su **puerto del switch** (apartado [3.12](#312-red-de-equipos)). |
| **Archivos** | La carpeta compartida del servidor del banco (por defecto `~/tftp` de quien lo instaló) para subir ficheros desde tu PC y descargarlos: imágenes, bitstreams, registros. Desde ahí también se puede **enviar un archivo a un equipo** por SSH (apartado [2.9](#29-archivos-intercambiar-ficheros-con-el-servidor)). |

---

## 2. Uso diario

### 2.1 El Banco

La página principal (**Banco**) muestra una tarjeta por equipo visible:

- el nombre, la plantilla y el número de serie;
- una línea por consola: estado, adaptador, velocidad («115200 8N1»), un indicador de recepción y la última línea recibida;
- el estado de los relés, solo si el equipo tiene relés (aquí son de solo lectura);
- el estado de la reserva.

Arriba hay filtros por plantilla, una búsqueda por nombre o número de serie (la tecla `/` la activa) y los interruptores «Solo míos» y «Solo libres».

Todo se actualiza en directo. El indicador de la barra superior dice «En vivo»; si se pierde la conexión con el servidor pasa a «Reconectando…» y, tras unos segundos, «Sin conexión con el servidor»: entonces los valores se muestran como no actualizados, y al volver la conexión la página se sincroniza sola.

### 2.2 Reservar

- **Reservar** es un clic, en la tarjeta del Banco o en la cabecera del equipo. La flecha junto al botón permite reservar con un motivo (opcional, hasta 120 caracteres).
- La reserva dura **30 minutos** por defecto (se cambia en Sistema → Reservas). La cuenta atrás aparece en el chip «Tuyo · mm:ss».
- **Escribir en una consola o usar un relé la mantiene viva** (como mucho una renovación por minuto). Tener la pestaña abierta **no** la renueva.
- **Mantener** la renueva a mano. **Liberar** la suelta.
- Cuando quedan **5 minutos** (configurable) aparece el aviso «Tu reserva expira pronto» y un chip en la barra superior; el título de la pestaña empieza por «(Expira m:ss)».
- Al caducar, los terminales pasan a **solo lectura** y aparece «Tu reserva ha expirado» con el botón «Reservar».
- Un equipo reservado por otra persona muestra «Reservado por …», hasta qué hora y el motivo.

**Forzar liberación (administradores).** En un equipo reservado por otra persona, el administrador ve «Forzar liberación…». Hay que escribir un motivo, que se registra en la auditoría y se muestra al usuario afectado. La casilla «Reservar para mí a continuación» (marcada por defecto) reserva el equipo justo después. Los administradores **no** pueden escribir en consolas reservadas por otro: primero fuerzan la liberación.

Si se desactiva a un usuario, o pierde el acceso a un equipo, sus reservas se liberan solas en menos de 30 segundos.

### 2.3 Consolas

Abre un equipo desde el Banco («Abrir consolas» o «Ver consolas»). Cada consola se muestra en un panel con su terminal.

- **Solo lectura.** Sin reserva ves la salida en directo y el historial reciente, pero lo que tecleas no se envía: aparece «Reserva el equipo para escribir» con el botón «Reservar». Nunca se pierde una tecla sin avisar.
- **Historial.** Al abrir una consola se reproduce lo último que envió (256 KiB por defecto), aunque nadie la estuviera mirando.
- **Diseño.** En la barra inferior: «Columnas», «Cuadrícula» o «Pestañas», y el tamaño de letra. Los paneles se pueden redimensionar; la aplicación recuerda el diseño por equipo.
- **Barra de cada panel:**
  - «Buscar» en la salida;
  - «Copiar selección» (también Ctrl+Shift+C, o Ctrl+C con texto seleccionado);
  - «Descargar captura» (apartado [2.6](#26-capturas));
  - «Teclas»: envía Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+W, Ctrl+T, Esc, Tabulador inverso y **BREAK** (útil cuando el navegador se queda con esas combinaciones);
  - «Maximizar» (dentro de la página; Esc sigue llegando a la consola);
  - «⋯»: «Soltar puerto…», «Retomar puerto», «Borrar historial» y «Guardar lo visible» (descarga en un `.txt` lo que muestra el terminal).
- **Teclado:** Ctrl+Alt+1…9 lleva el foco al panel N; Ctrl+Alt+Intro maximiza o restaura el panel; Esc restaura un panel maximizado cuando el foco está fuera del terminal; **Mayús+Tab** siempre sale del terminal.
- **Pegar** más de 4 KiB pide confirmación y se envía por partes.
- La tecla **Intro** envía lo que tenga configurado la consola (`CR` por defecto, o `LF`, o `CR LF`).
- Mientras tienes la reserva y un terminal abierto en escritura, cerrar la pestaña pide confirmación (protege contra un Ctrl+W tecleado para el shell).
- «Mi cuenta» → Preferencias: tema (oscuro por defecto, claro, el del sistema o rosa), tamaño de letra del terminal, líneas de historial y modo para lector de pantalla. **El tema se guarda en tu cuenta**: lo ves igual en cualquier PC y navegador, desde la primera carga de la página, y si lo cambias con otra pestaña u otro PC abiertos con tu usuario, cambia también allí al momento. Cada usuario tiene el suyo. La página de acceso muestra el tema del último usuario que entró en ese navegador. Las demás preferencias se guardan en cada navegador. Al actualizar desde una versión anterior, la primera vez que entras se guarda en tu cuenta el tema que tenías elegido en ese navegador.

**Estados de una consola:**

| Estado | Significado |
|---|---|
| Abierta / Recibiendo | El servidor tiene el puerto abierto (y está llegando texto). |
| Sin adaptador asignado | La consola no tiene puerto: asígnalo en Ajustes del equipo o en Descubrimiento. |
| Adaptador desconectado | El adaptador no está conectado. Al volver a conectarlo, la consola se reabre sola en unos segundos. |
| En uso por otro programa | Otro programa (picocom, BITReader_Tool…) tiene el puerto. |
| Sin permiso (grupo dialout) | El servicio no puede abrir el dispositivo: mira [Solución de problemas](#solución-de-problemas). |
| Puerto soltado | Alguien lo ha soltado para otra herramienta. |

Si hay demasiadas pestañas con la misma consola aparece «Demasiadas sesiones abiertas: cierra otras pestañas» con «Reintentar» (límite: 4 por usuario y consola, 32 por usuario y 256 en total).

### 2.4 Soltar y retomar un puerto

La aplicación mantiene abiertos todos los puertos asignados, para grabar la captura continua. Para usar otra herramienta sobre el mismo puerto (BITReader_Tool, picocom, `hw_server`):

1. Reserva el equipo.
2. En el panel de la consola: «⋯» → «Soltar puerto…» y elige la duración: 15 min, 30 min, 1 h, 4 h o «Hasta retomarlo». Para todas las consolas a la vez: «⋯» de la cabecera del equipo → «Soltar todos los puertos…».
3. El puerto queda libre: ábrelo con tu herramienta (tu usuario debe estar en `dialout`).
4. Al terminar, cierra tu herramienta y pulsa «Retomar puerto». Si elegiste una duración, la aplicación lo retoma sola al acabar.

Mientras el puerto está soltado no hay captura ni terminal en directo, y la captura registra la marca «puerto soltado». Pueden soltar y retomar quien tiene la reserva y, si el equipo está **libre**, un administrador.

Un puerto soltado sigue soltado aunque se desconecte y vuelva a conectar el adaptador o se reinicie el servidor.

### 2.5 Relés

Si el equipo tiene relés, aparecen en la columna «Relés» del espacio de trabajo (y como pestaña «Relés» en pantallas estrechas):

- **Interruptor** para encender o apagar. Mientras se aplica muestra «Aplicando…»; la aplicación comprueba en la placa que el relé ha cambiado. Si no cambia, lo explica (por ejemplo, el relé está configurado como pulso en la placa).
- Si el estado es desconocido («?»), hay dos botones: «Encender» y «Apagar».
- Los relés de tipo **reinicio** tienen un botón «Pulso» (la duración aparece en su ayuda).
- Los relés con **confirmación** (por ejemplo la alimentación) piden confirmar antes de apagar o pulsar.
- «Pulso emulado» avisa de que la placa no tiene pulso propio: si el servidor se detiene a mitad del pulso, el relé puede quedar cambiado.
- «Último estado HH:MM» indica que la placa no responde ahora.
- Solo quien tiene la reserva puede actuar («Reserva el equipo para actuar»).

Un equipo sin relés no muestra nada de esto.

### 2.6 Capturas

Cada consola asignada graba **siempre** lo que recibe, aunque nadie la esté mirando, así que los arranques quedan registrados.

**Dónde.** `/var/lib/relay-manager/consoles/<id de la consola>/` (portátil: `./data/consoles/`; Docker: `/data/consoles/` en el volumen). Cada carpeta tiene un `meta.json` con el equipo y la consola, y los ficheros del día.

**Ficheros:**

- `AAAA-MM-DD.log`, uno por día **UTC**. Si pasa del tamaño máximo por fichero, sigue en `AAAA-MM-DD.1.log`, `.2.log`…
- Los días anteriores se comprimen a `.log.gz`.
- `AAAA-MM-DD.input.log`, solo con la captura de entrada en modo «Texto completo» (ver abajo).

**Formato:**

```
# relay-manager captura v1 · equipo "Equipo A #07" (clx…) · consola UART0 (cly…)
# 2026-09-23T10:00:00.000Z abierto /dev/ttyUSB2 115200 8N1
[2026-09-23T10:00:01.123Z] U-Boot 2022.01 (Jan 01 2024 - 00:00:00 +0000)
[2026-09-23T10:00:05.000Z] >>> ingeniero: 5 bytes
[2026-09-23T10:05:00.000Z] --- puerto soltado por admin (hasta 10:35 UTC) ---
```

Cada línea empieza por la hora UTC de su primer carácter. Los finales `CR LF` pasan a `LF`; los códigos de color y los bytes no válidos se guardan tal cual. Las líneas `---` marcan sucesos: apertura, desconexión, puerto soltado o retomado, historial borrado, arranque y parada del servidor.

**Lo que se teclea.** Sistema → Consolas → «Captura de entrada»:

- **Solo marcas (recomendado):** una línea `>>> usuario: N bytes` por ráfaga de teclas. **Nunca** se guarda el texto tecleado (podría ser una contraseña).
- **Texto completo:** el `.log` sigue teniendo solo las marcas, y el texto va a un fichero aparte `.input.log`. Esos ficheros solo los pueden ver y descargar los administradores, porque pueden contener contraseñas.

**Descargar.** En el panel de la consola, «Descargar captura» lista los ficheros (el más reciente primero). Puede descargarlos cualquiera que vea el equipo. Cada descarga queda en la auditoría.

**Retención** (Sistema → Consolas):

| Ajuste | Por defecto |
|---|---|
| Días que se conservan | 30 |
| Tamaño máximo total | 2048 MB |
| Tamaño máximo por fichero | 64 MB |

Cada hora (y al llenarse un fichero) se borran los ficheros más antiguos que el límite de días. Si el total supera el máximo, se borran primero los ficheros antiguos de la consola **que más ocupa**: una consola muy habladora nunca borra los arranques de otra más tranquila. El fichero en uso no se borra nunca.

**Tamaño orientativo:** una consola a 115200 baudios escribiendo sin parar genera cerca de 1 GB al día; con el límite de 2 GB caben unos 2 días de una consola así, o meses de arranques normales.

**Disco lleno.** Si el espacio libre baja de 512 MiB (o del 2 % del disco, lo que sea mayor), la captura se **pausa** en todas las consolas: los administradores ven «Captura en pausa» en la barra superior y en Sistema → Salud. Las consolas se siguen viendo en directo. La captura se reanuda sola cuando hay 1 GiB más libre que ese umbral.

Borrar un equipo no borra sus capturas: desaparecen con la retención.

### 2.7 Accesos de red: JTAG, consolas y Ethernet desde tu PC

Cada ingeniero trabaja con su equipo desde su propio PC y **en paralelo** con los demás: cada cable JTAG, cada consola serie y la Ethernet de cada equipo tienen su propio puerto TCP en el servidor del banco (por defecto del 3201 al 3230; el 3200 es la web). La pestaña **Accesos** del equipo los lista con:

- la **dirección** que usas desde tu PC: la IP con la que has abierto la web y el puerto del acceso (por ejemplo `192.0.2.97:3201`), con un botón para copiarla;
- el **estado**: Abierto, Cerrado (sin reserva), Arrancando, Cable no conectado, Falta hw_server, Sin configurar, Puerto ocupado o Error, con la causa y qué hacer;
- quién está **conectado** (IP de origen; en consolas y Ethernet, también los bytes);
- la **orden** que hay que escribir, lista para copiar:

| Tipo | Desde tu PC |
|---|---|
| JTAG | En xsdb o xsct: `connect -host 192.0.2.97 -port 3201`. En Vivado: Open Hardware Manager → Open target → Open New Target → *Remote server* `192.0.2.97` puerto `3201`, o en la consola Tcl `connect_hw_server -url 192.0.2.97:3201`. En Vitis, el mismo host y puerto en la conexión de destino. |
| Consola serie | `nc 192.0.2.97 3203` (o `telnet 192.0.2.97 3203`). Ves lo mismo que en la web: primero el historial reciente y después en directo. |
| Ethernet | `ssh -p 3205 root@192.0.2.97` si el destino es el puerto 22 (y `scp -P 3205 …`); para otro servicio, la dirección `192.0.2.97:3205`. El usuario (`root` por defecto) se cambia en el acceso, en «Avanzado». |

**Cuándo están abiertos.** Por defecto, solo mientras el equipo está **reservado** («Solo con reserva»): al reservarlo se abren los puertos y arrancan los `hw_server`; al liberarlo (o al caducar la reserva) se cierran las conexiones y se paran. Un acceso marcado **«Siempre»** está abierto aunque nadie tenga la reserva. En la pestaña, «Reserva el equipo para abrir los accesos» y el botón «Reservar» lo recuerdan.

**Las sesiones remotas mantienen la reserva.** Mientras haya una conexión abierta en cualquier acceso del equipo (xsdb o Vivado conectados a su `hw_server`, `nc` o `telnet` en una consola, `ssh` por Ethernet), la reserva se renueva sola con la misma cadencia que al escribir en una consola, aunque nadie toque la web. Así una sesión de depuración larga no pierde la reserva ni se le para el `hw_server`. En la barra de reserva aparece «1 sesión remota» (el detalle dice, por ejemplo, «JTAG SEC: en uso por xsdb/Vivado desde 172.16.0.5»), y el aviso de caducidad las menciona. **Liberar** o **Forzar liberación** con sesiones abiertas pide confirmación y lista qué sesiones se cortarán («se cerrará») y cuáles pasan a solo lectura (consolas «Siempre»). Cierra xsdb, `nc` o `ssh` al terminar: si no, el equipo sigue reservado.

**Consolas por TCP.** Es la **misma** consola que la web (el servidor no abre el puerto serie dos veces): lo que escribes por `nc` aparece en la web y en la captura (con la marca `>>> tcp <IP>`), y lo que sale de la placa lo ven todos. Escribir necesita la reserva del equipo, igual que en la web: en un acceso «Siempre» sin reserva la conexión es de **solo lectura** y avisa con una línea `*** … ***`. El texto se envía tal cual (Intro de `nc` es LF; U-Boot y Linux lo aceptan). Si alguien suelta el puerto («Soltar puerto») la conexión sigue abierta, avisa y se reanuda al retomarlo. Escribir por TCP renueva la reserva como escribir en la web.

**JTAG.** Cada acceso JTAG tiene **su** `hw_server`, limitado a **su** cable por el número de serie, así que dos personas pueden depurar dos placas a la vez sin verse. Si desconectas el cable, el acceso pasa a «Cable no conectado» y `hw_server` se para; al volver a conectarlo (en cualquier puerto USB) arranca solo. Las conexiones JTAG se ven en la lista de conectados unos segundos después (el servidor las lee del sistema cada 5 s) y sin bytes.

**Ethernet.** El servidor reenvía el puerto a la IP y el puerto del equipo configurados en sus ajustes (por ejemplo `192.168.1.10:22`). «No responde» indica que el equipo no contesta en ese momento (apagado o sin red). Una conexión abierta renueva la reserva (ver arriba). Para copiar un archivo que ya está en la carpeta de Archivos, no hace falta `scp` desde tu PC: «Enviar a equipo…» lo copia desde el servidor por esta misma Ethernet (apartado [2.9](#29-archivos-intercambiar-ficheros-con-el-servidor)).

Con la **red de equipos** (apartado [3.12](#312-red-de-equipos)) el acceso no apunta a una IP sino a un **puerto del switch**, y la tarjeta lo dice así: «Puerto 3 del switch · enlace activo · 192.168.1.10:22 · alcanzable». Aunque todos los equipos tengan la misma IP, cada acceso llega solo al equipo de su puerto. Si el acceso está en «Sin red de equipos», la causa dice qué falta (red sin activar, adaptador desconectado, el servidor aún no tiene la VLAN de ese puerto…); «sin enlace» es que no hay nada conectado en ese puerto del switch o el equipo está apagado.

**Seguridad.** Los accesos no piden usuario ni contraseña: cualquiera que alcance el puerto por la red del laboratorio puede conectarse mientras están abiertos. Por eso por defecto solo se abren con la reserva, cada conexión queda en la **auditoría** (IP de origen, duración y bytes) y hay un máximo de conexiones por acceso (`RM_ACCESS_MAX_CONNECTIONS`, 8 por defecto). Si un mismo PC abre y cierra conexiones sin parar, solo se auditan 20 por minuto y acceso (el registro del servicio lo avisa). Cualquiera que llegue al puerto de una consola serie ve su salida y, con el equipo reservado por alguien, puede escribir: usa «Solo con reserva» y el cortafuegos del laboratorio para limitar quién llega a 3201-3230.

### 2.8 Actividad de un equipo

La pestaña **Actividad** del equipo muestra su historial: reservas, sesiones de consola, relés, cambios de configuración. «Cargar más» trae eventos anteriores. Los usuarios que no son administradores no ven las direcciones IP.

### 2.9 Archivos: intercambiar ficheros con el servidor

**Archivos** (en la barra lateral, para todos los usuarios) son una o dos carpetas del servidor del banco que todos los usuarios con sesión pueden usar para **subir** ficheros desde su PC y **descargarlos** en cualquier otro: por ejemplo, subir `BOOT.BIN` o `image.ub` desde el PC de desarrollo para cargarlos desde el servidor, o bajarse un registro. No arranca ningún servidor TFTP; lo único que toca los equipos es **«Enviar a equipo…»** (más abajo), que copia un archivo por SSH a un equipo que tienes reservado.

**Una o dos carpetas: «tftp» y la segunda carpeta compartida.** **tftp** (`~/tftp`) está siempre. Si el perfil o `config.env` le dan nombre a una **segunda carpeta compartida** (`RM_FILES_EXTRA_NAME`, por ejemplo «Compartida» en `~/compartida`; su carpeta es `RM_FILES_EXTRA_DIR` y la línea que la describe en el selector, `RM_FILES_EXTRA_HINT`), arriba de la página aparece un selector para cambiar de una a otra; sin nombre (o con `RM_FILES_EXTRA_ENABLED=0`) solo se ve tftp. Las dos funcionan igual: subir, descargar (también como .zip o .tar.gz), nueva carpeta, cambiar nombre, mover, borrar, enviar a equipo y copiar a una carpeta del servidor. Mover solo es dentro de la misma carpeta. La dirección dice en cuál estás: `/archivos?ruta=imágenes/v2` es tftp y `/archivos?raiz=extra&ruta=entregas` es la segunda carpeta (su identificador interno es siempre `extra`, se llame como se llame).

**Dónde están en el servidor.** Los administradores ven la ruta completa bajo el título («Carpeta en el servidor», con botón para copiarla). Por defecto:

| Instalación | tftp | Segunda carpeta (si tiene nombre) |
|---|---|---|
| Servicio (`install.sh`) | `/home/<usuario>/tftp` del usuario que ejecutó el instalador con `sudo`; si se instaló directamente como root, `/var/lib/relay-manager/tftp` | la que indique el perfil, creada por `install.sh` (por defecto `/home/<usuario>/<nombre>`; se cambia con `--extra-dir`), o `/var/lib/relay-manager/<nombre>` |
| Portátil y desarrollo | `~/tftp` del usuario que arranca el programa | `~/<nombre>` (por ejemplo `~/compartida`) |
| Docker | `/files` dentro del contenedor, que es la carpeta del anfitrión montada en `compose.yaml` (por defecto `~/tftp`) | `/extra` (la carpeta del anfitrión `RM_FILES_EXTRA_HOST_DIR`) |

Se cambian con `RM_FILES_DIR` y `RM_FILES_EXTRA_DIR` ([INSTALACION.md](INSTALACION.md#16-archivos-las-carpetas-compartidas)). Lo que se copie a esas carpetas por otros medios (por ejemplo con `cp` en el servidor) también aparece en la página.

**Navegar.** La línea de ruta («Archivos / imágenes / v2») lleva a cada carpeta; la flecha sube un nivel. Cada carpeta tiene su dirección (`/archivos?ruta=imágenes/v2`, o con `raiz=extra`), así que se puede guardar como marcador o pasar a un compañero. La tabla se ordena por nombre, tamaño o fecha (las carpetas siempre primero) y el cuadro «Filtrar por nombre» busca sin distinguir mayúsculas ni tildes. Arriba a la derecha se ve el **espacio libre** del disco del servidor.

**Subir.**

- Arrastra uno o varios ficheros desde el explorador de tu PC a cualquier parte de la página (aparece «Suelta los archivos para subirlos a …»), o pulsa **«Subir archivos»** y elige varios.
- Se suben a la carpeta que estás viendo. El panel **Subidas** (abajo a la derecha) muestra cada fichero con su progreso, la velocidad y el tiempo que falta; «×» cancela uno y «↻» reintenta uno que falló. «Quitar las terminadas» limpia el panel. Las subidas siguen aunque cambies de carpeta o de página dentro de la aplicación; si cierras o recargas la pestaña, el navegador avisa y se cancelan.
- **Nombre repetido.** Si ya existe un fichero con el mismo nombre, se pregunta qué hacer: **Reemplazar**, **Conservar ambos** (el nuevo se guarda como `nombre (1).ext`) u **Omitir**, con la opción «Hacer lo mismo con los N archivos». Con `RM_FILES_DELETE=admins`, reemplazar es como borrar: solo lo ven los administradores. Si otra persona sube el mismo nombre a la vez, nunca se sobrescribe: el tuyo se guarda como `nombre (1).ext` y el panel lo indica («Guardado como …»).
- Tamaño máximo por fichero: 4 GiB por defecto (`RM_FILES_MAX_UPLOAD_MB`; la página lo indica). No se pueden soltar carpetas: sube sus ficheros o comprímelas antes.
- Si el disco del servidor se llena durante una subida, se cancela con el mensaje «No hay espacio en el disco del servidor…» y no queda nada a medias. Antes de empezar también se comprueba que cabe.
- Un fichero solo aparece en la carpeta cuando ha llegado entero: mientras se sube se escribe en un fichero oculto `.rm-upload-….part` en la misma carpeta, que se borra si la subida se cancela o se abandona (15 min sin avanzar).

**Descargar.** Pulsa el nombre del fichero o el botón de descarga. Si se corta una descarga grande, el navegador puede reanudarla.

**Descargar una carpeta o varios elementos.** El botón de descarga de una carpeta, y **«Descargar»** con varias filas marcadas, abren el menú **«Descargar como»**:

| Formato | Para qué |
|---|---|
| **ZIP (.zip)** | Se abre con doble clic en Windows. No comprime (las imágenes y bitstreams ya suelen estarlo), así que empieza al momento y no carga el servidor. Admite ficheros y archivos de más de 4 GiB (ZIP64). |
| **TAR.GZ (.tar.gz)** | El habitual en Linux (`tar -xzf lote.tar.gz`). Comprime con gzip mientras se descarga y conserva los permisos (por ejemplo, los scripts ejecutables), las fechas, los nombres largos y las carpetas vacías. |

La primera opción del menú es la última que elegiste («la última vez»; se recuerda en este navegador). El archivo se llama como la carpeta (`imágenes.zip`, `imágenes.tar.gz`); con varios elementos, como la carpeta que estás viendo. Se genera mientras se descarga, sin copias en el servidor: si cancelas la descarga, el servidor deja de leer. Dentro van las rutas relativas, las subcarpetas (también las vacías) y las fechas de cada fichero.

Los enlaces simbólicos que salen de la carpeta de Archivos (o están rotos), los enlaces a carpetas y los ficheros especiales **no** se incluyen: el archivo lleva entonces un `_OMITIDOS.txt` en la raíz con la lista y el motivo de cada uno.

**Organizar.** «Nueva carpeta»; en el menú «⋯» de cada fila, **Cambiar nombre**, **Mover** (eliges la carpeta de destino) y **Borrar**. Con varias filas marcadas, «Descargar», «Mover» y «Borrar» actúan sobre todas. Borrar pide confirmación y borra las carpetas con todo su contenido, para todos: no hay papelera. Un administrador puede limitar el borrado a los administradores con `RM_FILES_DELETE=admins`.

**Menú de cada fila.** El botón «⋯» de la fila y el **clic derecho** sobre ella abren el mismo menú: en un archivo, **Descargar**, **Enviar a equipo…**, **Copiar a una carpeta del servidor…** (solo administradores), **Cambiar nombre**, **Mover** y **Borrar**; en una carpeta, **Abrir la carpeta**, **Cambiar nombre**, **Mover** y **Borrar**.

**Enviar a equipo.** Copia un archivo de la carpeta a la memoria de un equipo por SSH, sin pasar por tu PC: por ejemplo, un `BOOT.BIN` o un ejecutable a `/root` de la unidad que estás probando.

1. Clic derecho en el archivo (o «⋯») → **«Enviar a equipo…»**. Con varios archivos marcados, clic derecho en uno de ellos o el botón **«Enviar a equipo»** de la barra de la selección los envía todos.
2. El diálogo lista los equipos que ves y que tienen **acceso Ethernet**, con por dónde se llega a cada uno («Puerto 3 del switch · enlace activo» o `192.168.1.10:22`) y su reserva («Reservado por ti», «Reservado por …», «Libre» o «Acceso «Siempre»»). Si no se le puede enviar, lo dice debajo («Reserva el equipo para enviarle archivos.», la VLAN del puerto aún no está lista…). Se elige solo el que tienes reservado.
3. **Usuario** (por defecto `root`), **Contraseña** (por defecto `root`) y **Ruta de destino** (por defecto `~`, la carpeta personal de ese usuario en el equipo). La ruta puede ser `~`, `~/carpeta`, una ruta absoluta (`/mnt/sd`) o relativa a la carpeta personal. Si es una **carpeta** que existe, el archivo conserva su nombre dentro; si no, es el **nombre** que tendrá en el equipo (su carpeta debe existir). Terminada en `/` tiene que ser una carpeta. Con varios archivos, tiene que ser una carpeta. Si ya existe un archivo con ese nombre, se **reemplaza** (como hace `scp`).
4. **«Recordar para este equipo»** guarda el usuario, la contraseña y la ruta para la próxima vez (para todos los usuarios de ese equipo). La contraseña se guarda **cifrada** en el servidor y nunca vuelve al navegador: la siguiente vez el campo aparece vacío con «(guardada)»; déjalo vacío para usarla o escribe otra para cambiarla. **«Olvidar lo guardado»** la borra, y enviar con la casilla sin marcar también. Solo se guarda si el usuario y la contraseña funcionan.
5. **«Enviar».** El progreso aparece en el panel **Envíos** (abajo a la derecha, encima de Subidas): cada archivo con su equipo, `usuario@ruta`, por dónde va, el progreso, la velocidad y el tiempo que falta, y «×» para cancelar. Al terminar dice **Enviado · verificado (SHA-256)** si el equipo tiene `sha256sum` (o `md5sum`) y la suma coincide, o **no verificable** si no tiene ninguno (el tamaño se comprueba siempre). El envío sigue en el servidor aunque cambies de página o cierres la pestaña; al volver a Archivos se ve cómo ha ido.

Cómo llega: desde el **servidor del banco**, por la misma ruta que el acceso Ethernet del equipo (por su puerto del switch, aunque todos los equipos tengan la misma IP, o por su IP y puerto), al puerto SSH del equipo (el destino del acceso, normalmente el 22). No usa el puerto del acceso (3201–3230) ni tu PC. Se usa SFTP si el equipo lo tiene; si no (por ejemplo dropbear sin `sftp-server`), el protocolo de `scp`. Se escribe primero en un temporal oculto (`.rm-send-….part`) junto al destino y se renombra al final: si se cancela o falla, no queda nada a medias. Un archivo ejecutable llega con permisos 755; los demás, 644.

**Quién puede enviar:** quien tiene el equipo **reservado**, o cualquiera si su acceso Ethernet está en **«Siempre»** (la misma regla que el propio acceso SSH). Si se libera o caduca la reserva durante un envío, se cancela («Se ha liberado la reserva del equipo: envío cancelado.»). Mientras dura un envío, la reserva se renueva sola. Cada usuario tiene como mucho **3 envíos a la vez** (los demás esperan en cola) y el servidor 8.

**Huella SSH.** Como todos los equipos tienen la misma IP, no se comprueba la clave del equipo como hace `ssh` con `known_hosts`: se guarda la huella de cada equipo y, si cambia de un envío a otro (por ejemplo porque se ha reinstalado), el envío se hace igual pero la fila avisa: «La huella SSH del equipo ha cambiado desde el último envío (antes …, ahora …)». El diálogo muestra la huella conocida.

**Errores frecuentes:**

| Mensaje | Qué hacer |
|---|---|
| Usuario o contraseña incorrectos. | Corrige el usuario o la contraseña (si estaba guardada, escribe la buena y marca «Recordar»). |
| El equipo no responde por su Ethernet (puerto N del switch sin enlace)… | El equipo está apagado o no hay cable en ese puerto del switch. |
| El equipo no responde por su Ethernet (…): puede que esté apagado o arrancando. | Espera a que arranque Linux; comprueba la IP en sus ajustes. |
| El equipo responde por su Ethernet pero no acepta SSH en el puerto 22… | El servidor SSH del equipo no está arrancado (o el acceso apunta a otro puerto). |
| Sin permiso para escribir en «/…» en el equipo (usuario …). | Elige otra ruta o entra con un usuario que pueda escribir ahí. |
| No queda espacio en el equipo (quedan … y el archivo ocupa …). | Libera espacio en el equipo o envíalo a otra partición. |
| La carpeta «…» no existe en el equipo. | Créala antes o corrige la ruta. |
| El equipo no tiene SFTP ni scp… | Ese equipo no admite copias por SSH. |
| Reserva el equipo para enviarle archivos. | Resérvalo en el Banco (o pide a quien lo tiene que lo libere). |

**Copiar a una carpeta del servidor (administradores).** Copia archivos de la carpeta a otra carpeta del **propio servidor del banco**, sobre todo a un **pendrive** conectado a él. Si el servicio no puede escribir allí, lo hace **como administrador (sudo)** con la contraseña del usuario que instaló la aplicación: es un `sudo cp`, nada más. Los demás usuarios no ven la opción.

1. Clic derecho en el archivo (o «⋯») → **«Copiar a una carpeta del servidor…»**. Con varios archivos marcados, clic derecho en uno de ellos o el botón **«Copiar al servidor»** de la barra de la selección (como mucho 20 a la vez). Las carpetas no se copian.
2. **Unidades USB y discos**: los pendrives y discos montados (en `/media`, `/run/media`, `/mnt`, o cualquier disco extraíble o USB), con su etiqueta, su sistema de ficheros (`vfat`, `exfat`, `ext4`…), dónde está montado, el espacio libre y, si toca, **Extraíble**, **Solo lectura** o **Solo como administrador** (el servicio no puede entrar: lo normal en un pendrive que monta el escritorio). Pulsa una para ir a ella. Debajo, los pendrives **conectados pero sin montar** (lo normal en el PC del banco con Debian sin escritorio, donde un pendrive «solo se monta con sudo»), con su etiqueta, sistema de ficheros, tamaño y modelo, y el botón **«Montar»** (ver «Montar y expulsar un pendrive», más abajo). Un pendrive montado bajo `/media` tiene **«Expulsar»**. El diálogo empieza en el primer pendrive (aunque solo se pueda abrir como administrador: entonces pide la contraseña para verlo) o, si no hay ninguno, en el primer disco o en `/`.
3. **Carpetas**: la línea de ruta (`/` y cada carpeta) y un cuadro con la ruta completa que se puede escribir (Intro o **«Ir»**); la flecha sube un nivel. Primero las carpetas y después, en gris, los archivos que ya hay (nombre y tamaño: solo para que sepas qué hay; no se abren); **«Mostrar carpetas ocultas»** enseña lo que empieza por punto. Si entras en una carpeta que el servicio no puede leer, el diálogo dice **«Esta carpeta necesita permisos de administrador»** y pide la contraseña (ver «Permisos de administrador», más abajo). Debajo, el **Destino** (la carpeta que estás viendo) con **«El servicio puede escribir aquí»** o **«Solo como administrador (sudo)»** y el espacio libre. Las carpetas del sistema y las de Relay Manager (`/etc`, `/usr`, `/boot`, `/var/lib/relay-manager`…) se pueden ver pero no se copia en ellas («No se puede copiar aquí: …»).
4. **«Nueva carpeta»** crea una carpeta dentro del destino (como administrador si hace falta) y entra en ella.
5. **Si ya existe un archivo con el mismo nombre**: **Reemplazar** (se sustituye el del destino; nunca una carpeta), **Conservar ambos** (la copia se guarda como `nombre (1).ext`; es la opción por defecto) u **Omitir** (no se copia ese archivo).
6. **Copiar como administrador (sudo) · usuario `<nombre>`.** Aparece cuando el servicio no puede escribir en el destino (o no puede abrirlo). Solo pide la **Contraseña**: la del usuario con sudo de ese equipo (el que instaló la aplicación), y solo si esta sesión no tiene ya permisos de administrador. No se guarda en ningún sitio. Si la página no usa HTTPS, el diálogo avisa de que la contraseña viaja sin cifrar por la red del laboratorio (un administrador puede activar HTTPS con `sudo ./install.sh --tls-selfsigned`). En una carpeta que el servicio no puede abrir, **«Ver como administrador»** muestra sus subcarpetas con esa contraseña. En una carpeta donde el servicio sí puede escribir, el interruptor permite copiar igualmente como administrador (el archivo queda entonces del dueño de la carpeta).
7. **«Copiar aquí»** (o **«Copiar como administrador»**). Una contraseña incorrecta se dice en el campo y no se copia nada.

El progreso aparece en el panel **Copias** (abajo a la derecha, con Envíos y Subidas): cada archivo con su destino, el progreso, la velocidad, el tiempo que falta y «×» para cancelar; las copias como administrador llevan la marca **sudo · `<usuario>`**. Al terminar: **Copiado** con **Verificado (sha256)** (se vuelve a leer la copia y se compara con el original), **Reemplazado** si sustituyó uno, «Guardado como «…»» si se usó otro nombre, u **Omitido** («Ya existía: no se ha copiado.»). Se escribe primero en un temporal oculto (`.rm-copy-….part`) junto al destino y se renombra al final: si se cancela o falla, no queda nada a medias. Cada administrador tiene como mucho 2 copias a la vez (el servidor, 3); las demás esperan en cola. La copia sigue en el servidor aunque cierres la pestaña.

La copia queda con permisos `rw-r--r--` (0644): como el servicio, es del usuario del servicio; como administrador, del **dueño de la carpeta de destino** (en un pendrive del escritorio, ese usuario). En un pendrive FAT, exFAT o NTFS los permisos los pone el montaje: lo que monta la aplicación queda del usuario con sudo y del grupo `relay-files` (`rw-rw-r--`).

**Permisos de administrador (5 minutos).** La primera vez que algo del diálogo necesita sudo (ver una carpeta protegida, copiar como administrador, nueva carpeta, montar o expulsar) se pide la contraseña. Si es correcta, **esta sesión del navegador** queda con permisos de administrador **5 minutos**: el diálogo muestra «Permisos de administrador hasta HH:MM» y ya no vuelve a pedirla (las carpetas protegidas se ven directamente, y copiar, crear carpetas, montar y expulsar van como administrador sin preguntar). **«Olvidar permisos»** los quita al momento; pasados los 5 minutos (o al cerrar la sesión de la aplicación) se vuelve a pedir la contraseña. El permiso es solo de esa sesión: otro navegador, otro usuario de la web o una sesión nueva no lo tienen. La contraseña no se guarda: el servidor solo guarda un permiso firmado que caduca, y nunca lo envía al navegador. Como administrador se pueden **ver** carpetas de todo el sistema (nombres, tamaños y fechas, nunca el contenido de un archivo), pero se sigue **escribiendo** solo donde está permitido (no en `/etc`, `/usr`… ni fuera de `RM_COPY_ROOT_PATHS`).

**Montar y expulsar un pendrive.** En el PC del banco, si al conectar un pendrive no lo monta el escritorio, el diálogo lo lista en **Unidades USB y discos** como «sin montar»:

1. **«Montar»** pide la contraseña de sudo (si la sesión no tiene ya permisos de administrador). El pendrive se monta en `/media/<usuario>/<etiqueta>` (o con su UUID si no tiene etiqueta) y el diálogo entra en él. Se monta siempre sin permitir ejecutar programas ni ficheros de dispositivo (`nosuid,nodev,noexec`).
2. En FAT, exFAT y NTFS (lo normal en un pendrive) se monta para el usuario con sudo y el grupo `relay-files`: el **servicio puede escribir** directamente («El servicio puede escribir aquí») y el usuario del escritorio también. En ext4, xfs y otros de Linux, los permisos son los del propio disco: lo normal es copiar como administrador.
3. **«Expulsar»** (junto al pendrive montado) vacía la caché al disco, lo desmonta y borra la carpeta vacía de `/media`. Espera a que el panel de copias diga «Copiado» antes. Si dice que está en uso, cierra lo que tengas abierto en el pendrive (una terminal en esa carpeta, por ejemplo) y repite. Después ya se puede quitar.

Solo se montan dispositivos **extraíbles o USB**; nunca el disco del sistema ni ninguno con algo montado fuera de `/media` (el diálogo dice por qué, en gris, si un dispositivo no se puede montar). Solo se expulsa lo montado en `/media` o `/run/media`.

Dónde se puede copiar como administrador: por defecto solo dentro de `/media`, `/run/media` y `/mnt` (`RM_COPY_ROOT_PATHS`). En modo portátil, desarrollo y Docker no hay copia como administrador (el diálogo dice por qué). Instalación y seguridad: [INSTALACION.md](INSTALACION.md#18-copiar-a-una-carpeta-del-servidor-el-ayudante-de-root).

| Mensaje | Qué hacer |
|---|---|
| Contraseña incorrecta para «…». | Escribe la contraseña de ese usuario en el servidor (la de `sudo`). |
| Demasiados intentos con una contraseña incorrecta: espera N min. | Tras 5 contraseñas incorrectas en 10 minutos, la copia como administrador se bloquea 10 minutos. |
| «…» no es administrador de este equipo: no está en ninguno de los grupos sudo, wheel, admin (RM_COPY_SUDO_GROUPS). | El usuario configurado no tiene sudo: `sudo /opt/relay-manager/current/install.sh --sudo-user <usuario con sudo> --yes`. |
| La cuenta root no tiene contraseña (lo normal en Debian y Ubuntu, que usan sudo)… | Se instaló como root: vuelve a ejecutar el instalador con `--sudo-user <usuario con sudo>`. |
| La cuenta «…» está bloqueada… | Desbloquéala (`sudo passwd -u <usuario>`) o usa otro usuario con `--sudo-user`. |
| Como administrador solo se copia dentro de /media, /run/media o /mnt (RM_COPY_ROOT_PATHS). | Elige una carpeta de un pendrive o de `/mnt`, o amplía `RM_COPY_ROOT_PATHS` y vuelve a ejecutar `install.sh`. |
| «…» es una carpeta del sistema o de Relay Manager: no se copia ahí. | Esas carpetas están protegidas siempre. Elige otra. |
| El destino es de solo lectura. / Ese disco está montado en solo lectura. | El disco está montado en solo lectura (o el pendrive tiene el seguro puesto). |
| Ese nombre no es válido en el disco de destino (FAT y exFAT no admiten : ? * < > \| " ni \\). | Cambia el nombre del archivo en Archivos y vuelve a copiarlo. |
| No hay espacio en el destino… | Libera espacio en el pendrive o usa otro. |
| El ayudante de copia como administrador no responde (relay-manager-rootcopy.socket). | `sudo systemctl enable --now relay-manager-rootcopy.socket` o vuelve a ejecutar `install.sh`; `sudo relay-manager doctor` lo comprueba. |
| Esta carpeta necesita permisos de administrador. | El servicio no puede leerla: escribe la contraseña de sudo para verla (se recuerda 5 minutos en esta sesión). |
| Los permisos de administrador han caducado: escribe la contraseña otra vez. | Pasaron los 5 minutos (o pulsaste «Olvidar permisos», o se cerró la sesión). |
| El pendrive está en uso: cierra lo que tengas abierto en él. | Algo del servidor tiene abierto un archivo o una carpeta del pendrive. Ciérralo y vuelve a pulsar «Expulsar». |
| No se monta: parte de un disco del sistema / no es extraíble. | Solo se montan pendrives y discos USB. Un disco interno se monta a mano (`sudo mount`) en `/mnt`. |
| Montar y expulsar no está disponible (relay-manager-rootmount.socket). | `sudo systemctl enable --now relay-manager-rootmount.socket` o vuelve a ejecutar `install.sh`. |

**Descargas (script de descarga del perfil).** Opcional y **desactivada por defecto**: aparece solo si el perfil (o `config.env`) la activa con `RM_EXPORT_ENABLED=1` y le da un script con `RM_EXPORT_DOWNLOADER` (normalmente en `herramientas/` del perfil; [PERFIL.md](PERFIL.md)). El botón de Archivos lleva el título `RM_EXPORT_TITLE` (por defecto «Ejecutar script de descarga…») y abre un diálogo con la explicación `RM_EXPORT_DESCRIPTION`. Sirve para que cualquier usuario traiga al servidor, sin abrir una terminal, lo que el script descargue (por ejemplo, desde un repositorio de artefactos) empaquetado en un `.zip`. El servidor lo ejecuta siempre igual:

```
bash <script> <aplicación> <versión> -o <salida.zip> [-x]
```

1. **Aplicación** y **Versión** (las etiquetas son `RM_EXPORT_APP_LABEL` y `RM_EXPORT_VERSION_LABEL`; por defecto «Aplicación» y «Versión»): solo letras, números y `. _ + -`.
2. **Casilla opcional** con la etiqueta `RM_EXPORT_EXTRACT_LABEL`: si está marcada, se añade `-x` (qué hace lo decide el script). Sin esa variable, la casilla no aparece.
3. **Nombre del zip**: opcional; por defecto `<aplicación>-<versión>_exports.zip`. Si ya existe uno con ese nombre, el nuevo se guarda como `nombre (1).zip`: nunca se sobrescribe.
4. **Carpeta de destino**: dentro de la carpeta que indica `RM_EXPORT_ROOT` (la segunda carpeta compartida si está activa; si no, tftp); por defecto, la que estás viendo.
5. **«Descargar».** El panel con el nombre `RM_EXPORT_NAME` (por defecto **«Descargas»**) muestra el estado (en cola, con su posición; descargando; terminada; error; cancelada) y el **registro en directo** del script (lo que imprimiría en la terminal). **«Cancelar»** detiene el script y todo lo que haya lanzado. Al terminar, el zip aparece en la carpeta y el panel tiene un enlace para descargarlo.

Cualquier usuario con sesión puede lanzar una descarga (queda en la auditoría); ve las suyas y los administradores, todas. Va **una a la vez** en el servidor: las demás esperan en cola (como mucho 3 por usuario y 10 en total). Una descarga que tarda más de 60 minutos se cancela (`RM_EXPORT_TIMEOUT_MIN`). El script trabaja en una carpeta propia del servicio (fuera de las carpetas compartidas) que se borra al terminar; el zip se copia después a la carpeta de destino. Si `config.env` define `RM_EXPORT_USER` y `RM_EXPORT_PASSWORD`, el script las recibe como `EXPORT_USER` y `EXPORT_PASSWORD` o con los nombres que fije el perfil (y `RM_EXPORT_URL`, si está definida); esas credenciales nunca llegan al navegador y la contraseña se tacha del registro.

**Si falla.** El registro muestra exactamente lo que imprime el script; una salida distinta de 0 es un error («Error» en el panel, con su código de salida). Qué significa cada mensaje depende del script: lo explica el README del perfil que lo trae. Sistema › Salud y `doctor` tienen la comprobación con el nombre `RM_EXPORT_NAME`, que avisa si falta el script (o no se puede leer), si faltan `bash` o `setpriv` y, con `RM_EXPORT_URL`, si esa dirección no responde en 3 s. Los programas que necesite el propio script los comprueba el script.

**En directo.** Si otra persona sube, renombra o borra algo en la carpeta que estás viendo, la lista se actualiza sola. Lo que se copia al servidor por otros medios aparece al volver a la pestaña, cada 30 s o con el botón «Actualizar».

**Quién puede hacer qué.** Cualquier usuario con sesión ve, sube, descarga, crea carpetas, renombra, mueve y borra (salvo `RM_FILES_DELETE=admins`); enviar a un equipo, solo con su reserva (o con su acceso Ethernet en «Siempre»); copiar a una carpeta del servidor (y montar o expulsar pendrives), solo los administradores; la descarga con el script del perfil, cualquiera. Todo queda en la **auditoría** (categoría «Archivos»: quién, en qué carpeta (tftp o la segunda carpeta), qué fichero y su tamaño, desde qué IP; en los montajes, el dispositivo, dónde y con qué usuario sudo; en las descargas, la aplicación, la versión, el resultado y el zip; en los envíos, además el equipo, `usuario@ruta`, por dónde, el protocolo, el resultado, si se verificó y la huella SSH; en las copias a carpetas del servidor, el destino, si fue como administrador y con qué usuario sudo, el resultado y la suma sha256; nunca una contraseña). No hay permisos por carpeta: es un espacio compartido de todo el banco, así que no dejes ahí nada que no deba ver cualquier usuario.

**Enlaces simbólicos.** Un enlace dentro de la carpeta que apunta a otro sitio de la misma carpeta funciona con normalidad. Uno que sale de ella (o está roto) aparece como «No disponible» y no se puede abrir: la página nunca da acceso a nada fuera de la carpeta.

---

## 3. Administración

Los administradores ven en la barra lateral los grupos **Hardware** (Descubrimiento, Placas de relés, Plantillas), **Acceso** (Usuarios, Roles) y **Administración** (Auditoría, Sistema).

### 3.1 Usuarios

**Usuarios → Nuevo:** usuario (2 a 32 caracteres: minúsculas, números, punto, guion o guion bajo), nombre, correo opcional, contraseña (mínimo 10 caracteres, máximo 72 bytes, distinta del usuario; «Generar» crea una), administrador, roles y «Debe cambiar la contraseña al entrar» (activado por defecto).

En la ficha de un usuario: «Restablecer contraseña…», «Desactivar» / «Activar» y «Eliminar…».

- Desactivar, eliminar o restablecer la contraseña **cierra sus sesiones** (también consolas y actualizaciones en directo abiertas) en menos de 30 segundos. Desactivar y eliminar liberan además sus reservas.
- Cambiar sus roles o su condición de administrador **no** le saca de la sesión: el cambio se aplica al momento.
- No puedes desactivarte ni eliminarte a ti mismo. El **último administrador activo** no se puede eliminar, desactivar ni dejar de ser administrador.

Desde la línea de órdenes (funciona con el servicio en marcha y sin conexión a Internet):

```bash
sudo relay-manager user list
sudo relay-manager user create ana --name "Ana Pérez"          # pide la contraseña dos veces
sudo relay-manager user create jefa --admin
sudo relay-manager user reset-password ana                      # pide la contraseña nueva
sudo relay-manager user reset-password ana --generate           # genera una y la muestra una sola vez
sudo relay-manager user disable ana
sudo relay-manager user enable ana
sudo relay-manager user set-admin ana on
```

Tras `reset-password`, el usuario tiene que cambiar la contraseña al entrar.

### 3.2 Roles

Los roles limitan qué equipos ve cada usuario:

- Un equipo **sin roles** es visible para todos los usuarios.
- Un equipo **con roles** solo lo ven los usuarios que tienen alguno de esos roles, y los administradores.

**Roles → Nuevo:** nombre, descripción, miembros y equipos. El panel «Efecto» avisa, por ejemplo, de los equipos que dejarían de ser visibles para todos. Si un usuario pierde el acceso a un equipo que tenía reservado, la reserva se libera en menos de 30 segundos.

### 3.3 Plantillas

El código no trae plantillas propias. Las plantillas salen de dos sitios:

- **Del perfil** (`plantillas/*.json`, un fichero por plantilla; el formato está en [PERFIL.md](PERFIL.md)). Se cargan al arrancar el servidor, con el botón **«Recargar plantillas»** de la página Plantillas (solo administradores; queda en la auditoría) o con `relay-manager plantillas recargar` (apartado [7](#7-referencia-de-la-línea-de-órdenes)). Llevan la etiqueta **«Fichero»** y son de **solo lectura** en la web («Definida en plantillas/<fichero>.json»): para cambiarlas se edita el fichero y se recarga. **«Duplicar»** crea una copia local editable. Si el fichero desaparece del perfil, la plantilla queda **«Retirada»**: no se borra, los equipos creados con ella siguen igual, el asistente ya no la ofrece y un administrador puede eliminarla. Si un fichero tiene errores, su plantilla no cambia y el error (fichero y ruta dentro del JSON) sale en el informe de «Recargar plantillas», en el registro del arranque y en la comprobación «Perfil» de Sistema › Salud.
- **Locales**, creadas en la web («Nueva plantilla» o «Duplicar»): se editan y se eliminan aquí.

Sin ninguna plantilla, la página lo explica: «Añade ficheros .json a plantillas/ del perfil (<carpeta>) y pulsa «Recargar plantillas», o crea una plantilla aquí». Qué plantillas hay depende del perfil instalado; por ejemplo, el perfil de ejemplo del repositorio (`examples/perfil-ejemplo`) trae «Equipo con 2 consolas» y «Equipo con relés». Como ilustración, una plantilla «Equipo A» podría tener:

| Plantilla | Consolas | Relés | Accesos |
|---|---|---|---|
| Equipo A | `UART0` y `UART1`, 115200 8N1 | ninguno | `JTAG0` y `JTAG1` (JTAG, un cable por placa), `SERIE0` → consola `UART0`, `SERIE1` → consola `UART1` (serie por TCP) y `ETH` (Ethernet al puerto 22 del equipo, por un **puerto del switch** que se elige en cada equipo) |

Los puertos de los accesos se dan al crear cada equipo.

**Al actualizar desde 2.x.** Las plantillas que venían predefinidas en la versión 2 pasan a ser plantillas locales normales, editables, con todos sus valores: no se pierde nada. Si el perfil trae un fichero con la misma clave (`key`), en la siguiente carga la plantilla queda **vinculada** a ese fichero (pasa a «Fichero», con los valores del fichero); las que no tengan fichero siguen siendo locales.

Revisa el número de consolas, sus nombres y la velocidad reales. En el editor de una plantilla local (los mismos campos que el fichero de una plantilla del perfil):

- nombre, descripción y patrón de nombre de los equipos (por ejemplo `Equipo A #{nn}` → «Equipo A #08»);
- interfaces USB que se saltan al asignar puertos en orden (por ejemplo la del JTAG);
- consolas: clave (`UART0`), etiqueta, velocidad y formato, qué envía Intro, eco local y, en opciones avanzadas, expresiones para reconocer el nombre de host;
- relés: clave, etiqueta, tipo (alimentación, reinicio, modo, genérico), confirmación y pulso por defecto;
- accesos: clave, nombre, tipo (JTAG, Serie, Ethernet), apertura («Solo con reserva» o «Siempre»), la consola de cada acceso serie, el destino de Ethernet («Puerto del switch (se elige en cada equipo)» o «Sin switch: dirección IP», con IP, puerto y usuario SSH) y, opcionalmente, la etiqueta del cable JTAG;
- «Marcar como revisada» quita el aviso «Revisar».

Acciones: «Guardar», «Duplicar» y «Eliminar» en las locales; «Duplicar» en las del perfil, y además «Eliminar» si están «Retiradas». **Editar o eliminar una plantilla no cambia los equipos ya creados** (al crear un equipo, la plantilla se copia).

También puedes corregir una plantilla local al crear un equipo: el último paso del asistente ofrece guardar en ella las consolas y relés ajustados (con una plantilla del perfil, esa opción no aparece: se cambia su fichero).

### 3.4 Nuevo equipo (asistente)

Banco → «Nuevo equipo». Conecta antes los adaptadores USB del equipo.

1. **Plantilla.** Las plantillas no retiradas, en su orden (con «Revisar» si procede), o «En blanco». Viene elegida la primera.
2. **Consolas y relés.** Ajusta el número, las claves y las etiquetas.
3. **Conexiones.** A la derecha aparecen los puertos detectados, agrupados por adaptador USB (y «Puertos virtuales y del sistema» si los hay).
   - Elige un adaptador y pulsa **«Asignar en orden»**: sus puertos se asignan por orden de interfaz (A, B, C, D…) a las consolas sin asignar, saltando las interfaces que indique la plantilla. Revisa el resultado.
   - También puedes elegir el puerto de cada consola a mano.
   - **«Vista previa en directo»** muestra lo que sale por cada puerto del adaptador: enciende el equipo y mira los mensajes de arranque para saber qué puerto es cuál.
   - **«Identificar»** escucha 3 segundos cada puerto, **sin enviar nada**, y dice qué ve (U-Boot, Linux arrancando, «login:», línea de órdenes, sin datos, datos ilegibles…) y el nombre de host si lo reconoce. Si los nombres de host encajan con la plantilla, ofrece «Ordenar según nombre de host».
   - Para cada consola eliges cómo se reconoce su puerto en el futuro (apartado [3.6](#36-descubrimiento)).
   - Los relés se asignan a un canal de una placa, o se omiten. Sin placas registradas, los relés se omiten.
   - Se pueden dejar consolas sin asignar y asignarlas después.
4. **Accesos.** Los accesos de la plantilla, con el **puerto** que tendrán (el siguiente libre del rango, «3206 (automático)»; puedes escribir otro). Para cada JTAG, elige el **cable** de la lista por su nombre: primero los etiquetados, conectados y libres; después los que usa otro equipo, los desconectados y, al final, los conectados «Sin etiqueta». Si el cable aún no tiene nombre, «Etiquetar un cable nuevo» abre el mismo diálogo que Cables (apartado [3.10](#310-cables)). Cada acceso serie apunta a una consola del equipo. Cada Ethernet se elige de una lista de **puertos del switch** de la red de equipos: «Puerto 2 del switch · enlace activo · libre», «Puerto 3 del switch · sin enlace · Equipo A #02»… (un puerto que ya es de otro equipo no se puede elegir). Si acabas de conectar el cable del equipo al switch, el asistente lo nota y propone «Acabas de conectar algo al puerto 4» con el botón «Usar el puerto 4». La IP (la «IP de los equipos» de la red de equipos), el puerto (22, o `RM_EQUIPNET_EQUIPMENT_PORT`) y el usuario SSH (`root`) están en «Avanzado». Para un equipo que no va por el switch, elige «Sin switch: dirección IP» y escribe su IP y su puerto. «Añadir JTAG», «Añadir consola serie» y «Añadir Ethernet» añaden más.
5. **Nombre y acceso.** Nombre sugerido según el patrón (por ejemplo «Equipo A #08»), número de serie, descripción y roles.
6. **Revisión.** Resumen de consolas, relés y accesos (con sus puertos). Si has cambiado las consolas, los relés o los accesos respecto a la plantilla, la casilla «Guardar estas consolas y relés en la plantilla «…»» los guarda en ella (y le quita el aviso «Revisar»); solo con plantillas locales.

«Crear equipo» te lleva a su espacio de trabajo; las consolas empiezan a grabar en ese momento.

### 3.5 Ajustes de un equipo

En el equipo, pestaña **Ajustes** (solo administradores): identidad, acceso (roles), consolas (con su puerto, «Cambiar…», «Desvincular» y modo de reconocimiento), relés, **accesos de red** (los mismos campos que en el asistente, más «Activo») y «Eliminar equipo». Un único botón «Guardar cambios» aplica todo. Al cambiar un acceso, sus conexiones se cierran y se vuelve a abrir con la nueva configuración.

Si otra persona tiene el equipo reservado, se avisa de que guardar cambios de consolas reabre sus puertos, y el borrado está bloqueado hasta forzar la liberación.

### 3.6 Descubrimiento

**Puertos serie.** Lista los adaptadores USB-serie detectados, agrupados por dispositivo (etiqueta, ubicación USB, `VID:PID`, número de serie) con sus puertos (`ttyUSBn`, ruta `by-id` y estado: Libre, Asignado a…, En uso por otro programa, Sin permiso). Los adaptadores aparecen solos al conectarlos (marcados «Nuevo»).

Acciones por puerto: «Vista previa», «Identificar», «Asignar a equipo…» (asigna los puertos del adaptador a las consolas libres de un equipo) y «Enviar retorno de carro».

**Cómo se reconoce el puerto de una consola:**

| Modo | Cuándo |
|---|---|
| **Seguir al adaptador (nº de serie)** | Por defecto si el adaptador tiene número de serie único (FTDI). La consola sigue al adaptador aunque lo cambies de puerto USB o de equipo. |
| **Seguir al puerto USB** | Adaptadores sin número de serie, o con el mismo número repetido (muchos CH340). La consola sigue al **conector USB físico**: no muevas el adaptador de conector. |
| **Ruta fija** | Puertos virtuales o integrados (`ttyS*`). |

La aplicación nunca usa `ttyUSB0`, `ttyUSB1`… para reconocer un adaptador, porque esos números cambian al reconectar.

**Enviar retorno de carro.** «Identificar» nunca escribe. Si un equipo no muestra nada hasta que se pulsa Intro, un administrador puede enviar **un único** retorno de carro a un puerto libre y sin asignar. Pide confirmación: en una pantalla de contraseña puede contar como intento fallido. No se envía si hay una cuenta atrás de U-Boot en curso. Se desactiva con `RM_SERIAL_ALLOW_POKE=0`.

Los adaptadores que parecen JTAG (Digilent y similares) se ocultan en los selectores; «Mostrar JTAG» los enseña.

**Adaptadores de red.** La pestaña lista las tarjetas de red físicas del servidor, en directo al conectarlas: nombre (por ejemplo «ETH-01» si está etiquetado), fabricante y modelo, interfaz, MAC, conector USB, enlace y velocidad, y sus direcciones. La tarjeta con la ruta por defecto (la del laboratorio) y las inalámbricas salen como «No seleccionable» con el motivo; las que ya están en otra red o no son USB llevan un aviso. La interfaz de la red de equipos se elige en Sistema › Red de equipos (apartado [3.12](#312-red-de-equipos)) y lleva aquí la marca «Red de equipos». Mientras no hay ninguna elegida, aparece también la tarjeta **«Hay adaptadores de red sin configurar»** con el enlace «Configurar red de equipos»: solo avisa, no busca nada ni cambia nada.

**Placas de relés.** «Placas detectadas» reúne todas las placas vistas desde que arrancó el servidor:

- **UDP pasivo:** el servidor escucha los anuncios de las placas en el puerto UDP 30303. Solo escucha: nunca contacta con la placa por esto.
- **«Buscar placas (UDP)»:** envía una petición de descubrimiento a la dirección de difusión de cada red local y consulta (solo lectura) las placas que responden.
- **«Escanear subred…»:** recorre las redes indicadas (por defecto la /24 de cada interfaz) con peticiones HTTP/TCP de solo lectura. Solo cuando lo pides, y queda en la auditoría.

Ninguna búsqueda actúa nunca sobre un relé. Estados de cada resultado:

- **Nueva** → «Añadir» abre el formulario de placa ya relleno.
- **Registrada: <nombre>** → «Ver».
- **IP cambiada:** una placa conocida (misma MAC) anuncia otra IP. La aplicación **no** cambia la IP sola; «Actualizar IP» lo hace tras confirmar.
- **No alcanzable:** la placa responde por UDP pero está en otra subred, típicamente con su IP de fábrica (`192.168.0.123` los dS, `192.168.0.200` los ETH). Añade temporalmente una IP secundaria de esa subred a la interfaz del equipo, configura la placa y quítala:

  ```bash
  sudo ip addr add 192.168.0.10/24 dev enp3s0
  # … configura la IP definitiva de la placa desde su página web …
  sudo ip addr del 192.168.0.10/24 dev enp3s0
  ```

  Si las respuestas UDP llegan por una interfaz distinta de la esperada, el filtro de ruta inversa del núcleo puede descartarlas (`sysctl net.ipv4.conf.all.rp_filter`; `2` es el modo flexible).

### 3.7 Placas de relés

**Placas de relés** lista las placas registradas con su estado (Conectada, Sin respuesta desde…, Desactivada). Con 0 placas, los equipos funcionan igual.

**Añadir una placa:** desde Descubrimiento («Añadir») o «Añadir manualmente». Campos: nombre, controlador, dirección, puertos y número de relés (se deduce del modelo).

| Controlador | Para |
|---|---|
| Devantech dS (ASCII TCP) | dS378 y resto de la serie dS con el puerto ASCII 17123 activo (recomendado para dS). Encendido/apagado absoluto y pulso nativo. |
| Devantech dS (HTTP) | Serie dS usando su página web. Solo conmuta: la aplicación lee, compara y conmuta. El pulso es emulado. Necesita la «variable dScript» (`toggleVar`), que se aprende de la página de la placa o se escribe a mano. |
| Devantech ETH | ETH002, ETH008, ETH484, ETH8020 (TCP 17494; escritura opcional por HTTP con usuario y contraseña). |
| Simulada | Solo con `RM_RELAY_SIMULATE=1`, para demostraciones. |

**«Probar conexión»** consulta la placa en modo solo lectura y propone los valores («Usar estos valores»). Es obligatorio antes de guardar una placa nueva.

En el detalle de una placa: mapa de canales (qué equipo usa cada relé), «Editar», «Probar», «Refrescar», «Desactivar»/«Activar» y «Eliminar». **Eliminar una placa desvincula sus relés de los equipos; nunca borra equipos.**

La contraseña de la placa se guarda en la base de datos y nunca se envía al navegador.

### 3.8 Auditoría

**Auditoría** registra todo lo relevante: accesos y fallos de acceso, configuración inicial, usuarios, roles, equipos, plantillas, placas, reservas (incluidas las caducadas y las liberadas por el sistema), sesiones de consola (con duración y bytes), soltar/retomar/borrar historial, BREAK, relés, descubrimientos, descargas de capturas y copias, Archivos (subidas, descargas, carpetas nuevas, cambios de nombre, movimientos, borrados, envíos a equipos, datos de acceso SSH recordados u olvidados, copias a carpetas del servidor —`files.copy`, con el destino, si fue como administrador (`asRoot`) y el usuario sudo que la autorizó, el resultado y la suma sha256; también las contraseñas incorrectas y los intentos de quien no es administrador, como «Denegado»— y carpetas creadas desde ese diálogo, `files.copy.mkdir`), ajustes y operaciones denegadas. Las contraseñas, secretos y códigos nunca aparecen: se sustituyen por `[oculto]`.

- Filtros: periodo (Todo, Hoy, 7 días, 30 días, Personalizado), categoría, usuario, equipo y resultado. Los filtros quedan en la dirección de la página, así que se pueden guardar como marcador.
- «Exportar CSV» descarga lo filtrado (separador `;`, compatible con hojas de cálculo en español).
- Los eventos no se pueden modificar ni borrar. Se conservan **365 días** (Sistema → General → Auditoría).

### 3.9 Sistema

| Pestaña | Qué se configura |
|---|---|
| General | Nombre del laboratorio (por defecto «Relay Manager», o el `RM_LAB_NAME` del perfil al crear la base de datos), texto de la franja superior (opcional, por ejemplo una marca de clasificación) y retención de la auditoría |
| Reservas | Duración de la reserva y aviso antes de caducar |
| Consolas | Retención de capturas, tamaños máximos, captura de la entrada; estado y tamaño actual de la captura |
| Copias | Copia diaria, hora y cuántas se conservan; lista de copias con descarga; exportar e importar configuración |
| Salud | Las comprobaciones de `doctor`, agrupadas, con «Volver a comprobar» |
| Accesos | El rango de puertos y la dirección de escucha, `hw_server` (ruta, versión, cómo se encontró), el **mapa de puertos** de todo el banco (puerto → equipo, acceso, tipo, estado y conexiones, en directo) y los cables JTAG conectados con dónde se usan |
| Red de equipos | En pasos: elegir la interfaz del switch, buscar el switch por ella y prepararlo; después el estado del servidor y del switch, los puertos, la configuración del switch (con vista previa, restaurar y quitar), los ajustes, los avisos, los restos de versiones anteriores y las instrucciones para configurarlo a mano (apartado [3.12](#312-red-de-equipos)) |
| Acerca de | Versión, modo, rutas de datos, tamaños, direcciones para compartir, licencia y créditos |

### 3.10 Cables

**Cables** (menú Hardware) es el inventario de cables con nombre: pestañas **Cables JTAG**, **Adaptadores USB-serie** y **Adaptadores de red**. La idea es etiquetar cada cable **una vez**, pegarle una pegatina con su nombre, y a partir de ahí elegirlo por nombre al configurar los equipos.

**«Etiquetar un cable»:**

1. Pulsa el botón y, con el diálogo abierto, **conecta el cable**. El servidor lo detecta en unos segundos (es el que aparece nuevo respecto a lo que ya estaba conectado). Si conectas varios a la vez, elige cuál. También puedes elegir uno que ya estaba conectado y aún no tiene etiqueta.
2. Escribe el **nombre**: se propone el siguiente libre («JTAG-01», «JTAG-02»…; «USB-01» para los adaptadores). Notas opcionales.
3. «Guardar etiqueta», o «Guardar y etiquetar otro» para seguir con el siguiente cable sin cerrar el diálogo.

En la tabla: nombre, número de serie (o identidad del adaptador), producto, si está **conectado ahora**, cuándo se vio por última vez y **dónde se usa** (equipo y acceso o consola). «Editar» cambia el nombre y las notas; «Borrar etiqueta» solo quita el nombre (los accesos que usan el cable siguen funcionando). Debajo, «Conectados sin etiqueta» con un botón «Etiquetar» para cada uno. Todo queda en la auditoría.

Un **cable JTAG** se identifica por su número de serie (el mismo que usa `hw_server`), así que da igual el puerto USB donde lo conectes. Un **adaptador USB-serie** se identifica por `VID:PID:número de serie` si es único, o si no por el conector USB. Un **adaptador de red USB** se identifica por su **MAC** y recibe «ETH-01», «ETH-02»…; el de la red de equipos se etiqueta solo al preparar el switch si aún no tenía nombre. Donde se muestran cables y adaptadores (Descubrimiento, selectores, accesos, Sistema) aparece primero el nombre y después el número de serie.

«Volver a escanear» fuerza una nueva lectura de los cables JTAG (normalmente se detectan solos cada 2 s). La pestaña **Cables JTAG** de Descubrimiento muestra lo mismo que está conectado ahora.

### 3.11 Accesos de red (administración)

- **Crear:** en el asistente (paso «Accesos»), desde la plantilla, o en Ajustes del equipo. Cada acceso tiene clave, nombre, tipo, **puerto** (vacío = el siguiente libre del rango), **apertura** («Solo con reserva» o «Siempre»), «Activo» y, según el tipo, el cable JTAG, la consola o el destino Ethernet.
- **Puertos:** del rango `RM_ACCESS_PORTS` (por defecto 3201–3230), únicos en todo el banco, nunca el de la web. Al guardar se comprueba que no los usa otro programa del servidor; si alguien lo ocupa después, el acceso pasa a «Puerto ocupado» y se reintenta cada 10 s. El mapa completo está en Sistema → Accesos.
- **Un cable, un acceso:** un cable JTAG solo puede estar en un acceso (dos `hw_server` sobre el mismo cable se estorban).
- **`hw_server`:** hace falta en el servidor (apartado 5.5 de [INSTALACION.md](INSTALACION.md#55-accesos-jtag-hw_server-y-cables)). Se arranca uno por acceso JTAG abierto, con `-s tcp::<puerto> -p0 -e "set jtag-port-filter <serie>"`, se reinicia solo si termina (1, 2, 5, 10 y 30 s) y su salida va al registro (`relay-manager logs`, componente `jtag`). Si un `hw_server` local del servidor (por ejemplo el de BITReader_Tool) tiene ya el cable, el del acceso no lo verá: usa uno u otro.
- **Auditoría:** apertura y cierre de cada acceso, fallos, y cada conexión (IP de origen, duración y bytes), en la categoría «Accesos»; etiquetas de cables en «Cables».

### 3.12 Red de equipos

En muchos bancos todos los equipos salen de fábrica con la **misma IP** en su Ethernet (por ejemplo 192.168.1.10). Esa «IP de los equipos» **no tiene valor por defecto**: un administrador la escribe en Sistema › Red de equipos › Ajustes › «Direcciones» (o la trae el perfil con `RM_EQUIPNET_EQUIPMENT_IP`, que solo se aplica la primera vez, al crear la configuración de la red de equipos). Mientras no esté escrita, los accesos Ethernet por el switch no tienen destino. Para llegar a cada uno por separado, el banco usa un switch gestionable pequeño (TP-Link Easy Smart: TL-SG105E, TL-SG108E, TL-SG116E…) conectado a un adaptador USB-Ethernet del servidor, dedicado a esto:

- el **puerto 1** del switch va al adaptador USB del servidor (la tarjeta del laboratorio sigue igual y no se toca nunca);
- cada equipo va a **su** puerto, del 2 al 8;
- el switch separa los puertos (cada puerto es su propia VLAN, la 100 + el número de puerto) y el servidor tiene una interfaz por puerto; así cada acceso Ethernet llega solo al equipo de su puerto, aunque todos tengan la misma IP.

Para quien usa el banco no cambia nada: su acceso Ethernet («ETH») funciona como cualquier otro (`ssh -p <puerto del acceso> root@<IP del banco>`).

**Primera vez: elegir la interfaz, buscar el switch y prepararlo.** Conecta el adaptador USB al servidor y su cable al puerto 1 del switch. La aplicación **no cambia nada ni busca nada** en la red del servidor hasta que un administrador elige la interfaz (tampoco al arrancar): en el Banco y en Descubrimiento solo aparece la tarjeta **«Hay adaptadores de red sin configurar»** con el enlace «Configurar red de equipos», que lleva a Sistema › Red de equipos. Allí, en tres pasos:

1. **«Elige la interfaz del switch».** Una tabla con **todas** las tarjetas de red físicas del servidor: interfaz (y su etiqueta, «ETH-01»), MAC, tipo (USB con fabricante, modelo y conector; PCI; inalámbrica), enlace y velocidad, direcciones IPv4, si lleva la ruta por defecto y su estado en NetworkManager («-» si no se sabe); debajo, plegadas, «N interfaces virtuales más (solo lectura)» (Docker, puentes, VPN…). La de la ruta por defecto (la del laboratorio) y las inalámbricas **no se pueden elegir** y dicen por qué. «Usar esta» abre un diálogo que dice exactamente qué va a pasar: «Se añade 192.168.0.250/24 a enx… (sin ruta de red y con su propia regla) para hablar con el switch» (o, si la interfaz ya tiene una dirección en la red del switch, «Se usa la dirección … que ya tiene: no se le añade nada»), «Al preparar el switch (paso 3) se crean sobre ella las interfaces VLAN rmv102, rmv103…» y «No se toca ninguna otra interfaz, ni la ruta por defecto, ni la tabla de rutas principal». Una interfaz que ya está en otra red (por ejemplo la tarjeta del PC que está en 192.168.1.x) o que no es USB lleva un aviso y solo se puede elegir marcando además «Entiendo el aviso: esta es la interfaz conectada al puerto 1 del switch». La interfaz elegida queda «En uso»; «Dejar de usar» quita de ella lo que puso la aplicación (dirección de gestión, interfaces `rmv*`, sus reglas y tablas) y nada más.
2. **«Busca el switch».** Solo por la interfaz elegida: «Buscar el switch» recorre su red de gestión (192.168.0.0/24 de fábrica, como mucho una /22) saliendo siempre desde su dirección de gestión; o escribe la IP en «O escribe la IP del switch» y pulsa «Probar esta IP» (una sola conexión). El switch encontrado se guarda: «Switch TL-SG108E en 192.168.0.99 · el usuario y la contraseña funcionan».
3. **«Prepara el switch».** «Preparar el switch…» abre un único diálogo:
   1. lo que va a quedar, en palabras: «Puerto 1: este servidor», «Puertos 2 a 8: un equipo cada uno, aislados entre sí», la IP de los equipos y que se entra por SSH (puerto 22);
   2. la **contraseña del switch**, ya rellenada con la de fábrica («admin») si no hay otra guardada;
   3. «Detalles» (opcional): lee el switch **sin cambiar nada** y enseña cada cambio en orden y una tabla puerto por puerto «Ahora / Después», y comprueba a qué puerto del switch está conectado el servidor;
   4. **«Preparar switch»**: con ese clic (y solo entonces) se guarda la configuración, se etiqueta el adaptador («ETH-01»), se crean las VLAN del servidor en la interfaz elegida y se configura el switch paso a paso, con una barra de progreso. Al terminar: «Switch preparado: cada puerto lleva a su equipo.».

Cada paso lleva «Hecho» o «Pendiente»; el cuarto, «Estado», es el de siempre (ver más abajo).

Después ya no hay que hacer nada más: el servidor mantiene sus interfaces solo (también si se desconecta y se vuelve a conectar el adaptador o se reinicia el servidor), y en cada equipo solo se elige su puerto del switch (apartado [3.4](#34-nuevo-equipo-asistente)).

**Qué garantiza la aplicación:**

- nada cambia en la red del servidor hasta que eliges la interfaz, y después **solo** esa: la tarjeta del laboratorio, cualquier otra tarjeta, la ruta por defecto y la tabla de rutas principal **no se tocan nunca**; todo va en interfaces propias (`rmv102`, `rmv103`…) sobre la interfaz elegida, con reglas y tablas de rutas propias;
- si otra tarjeta del servidor ya está en la red de los equipos (192.168.1.0/24, incluso con su propio 192.168.1.10 detrás), funciona igual: cada acceso llega al equipo de su puerto y el resto del tráfico del servidor a esa red sigue saliendo por esa tarjeta. La aplicación lo muestra como **aviso**, no como error, y nunca usa una dirección que el servidor ya tenga;
- el switch **solo se cambia tras un clic explícito** (y en Sistema, además, marcando «He revisado los cambios»); buscarlo y la vista previa solo leen;
- antes de cambiar nada comprueba, con los contadores de paquetes del switch, que el servidor está en el puerto 1; si está en otro, no deja seguir («Este servidor está conectado al puerto 3 del switch, no al 1»). Si no lo puede comprobar, pide confirmarlo marcando una casilla;
- guarda antes una **copia** de la configuración del switch y su configuración de VLAN;
- cambia el switch paso a paso y comprueba cada paso leyéndolo; el orden nunca deja al servidor sin acceso a la gestión del switch. Si un paso falla, vuelve a dejar el switch como estaba;
- al final guarda la configuración en la memoria del switch (sobrevive a un corte de luz).

Algunos firmware no dejan quitar puertos de la VLAN 1. Si pasa, el resultado lo avisa: los equipos siguen aislados entre sí (lo que envía cada uno entra en su propia VLAN), pero reciben las difusiones de la red de gestión del switch.

**Sistema › Red de equipos** (solo administradores), además de los tres pasos:

- **Avisos:** situaciones que funcionan pero conviene saber: «La red de los equipos (192.168.1.0/24) también está en enp4s0 (192.168.1.5/24)…», lo mismo con la red de gestión del switch, y el aviso de ARP (apartado 17 de [INSTALACION.md](INSTALACION.md#17-red-de-equipos-switch-y-adaptador-usb)). Al guardar los ajustes o preparar el switch salen también como aviso emergente.
- **Restos de una versión anterior:** lo que dejó en la red del servidor una versión anterior de la aplicación en interfaces que no has elegido (por ejemplo la dirección 192.168.0.250 en otro adaptador USB, con su regla), con las órdenes exactas para quitarlo como root y el botón **«Quitar restos»**. La aplicación nunca los quita sola.
- **Servidor:** el estado de sus interfaces VLAN («Lista», «Sin permiso para cambiar la red», «Adaptador no conectado», «Falta la orden ip»…), la causa y, si el servicio no tiene permiso, las **órdenes pendientes** (`sudo ip …`) con un botón para copiarlas; «Comprobar ahora». Si NetworkManager podría quitar las direcciones del adaptador, un aviso con la orden que hay que ejecutar una vez (`sudo relay-manager red-equipos <MAC>`).
- **Switch:** modelo, hardware, firmware, «Probar conexión» y, si alguien cambió el switch a mano, «El switch no coincide con lo que configuró la aplicación» con las diferencias (se comprueba cada minuto).
- **Puertos del switch:** por puerto, su uso (este servidor o equipo), su VLAN, el **enlace** (en directo), qué equipo lo tiene asignado, la dirección del servidor en esa VLAN y si la VLAN está lista en el servidor. «Lista» incluye una comprobación con el propio núcleo (`ip route get`): si otra regla de enrutamiento del servidor mandara el tráfico por otra tarjeta, la VLAN no está lista y lo dice («… saldría por enp4s0, no por rmv102 …»).
- **Configuración del switch:** «Configurar el switch» (vista previa con todos los cambios, casilla «He revisado los cambios» y «Aplicar»), «Restaurar configuración anterior» (vuelve a la configuración de VLAN 802.1Q que tenía el switch antes del último cambio de la aplicación; la VLAN por puertos de fábrica no se restaura, para eso está la copia), «Quitar VLAN» (deja el switch plano, todos los puertos se ven) y «Descargar la copia del switch» (el fichero de copia del propio switch, que se restaura desde su página web; contiene sus credenciales).
- **Ajustes:** el tipo de switch («TP-Link Easy Smart» o «Manual (configuro yo el switch)»), su IP, usuario y contraseña (la contraseña nunca se muestra), número de puertos, el puerto de este servidor (subida, 1) y «Red de equipos activa en el servidor» (solo con una interfaz elegida). La interfaz no está aquí: se elige en el paso 1. En «Direcciones»: la IP de los equipos (sin valor por defecto, por ejemplo 192.168.1.10) y su prefijo (/24), la dirección del servidor para la gestión del switch (192.168.0.250/24), la base de VLAN (100) y el desplazamiento de las direcciones del servidor en cada VLAN (200: puerto 3 → 192.168.1.203; si el servidor ya tiene esa dirección en otra tarjeta, ese puerto usa la siguiente libre después del último, por ejemplo 192.168.1.209). Que otra tarjeta del servidor esté en la misma red es solo un aviso. Son **errores** solo los choques de direcciones: la IP del switch la tiene el propio servidor («La IP del switch (192.168.0.99) la tiene este servidor en enx…», con la orden para quitarla), la dirección de gestión ya la tiene otra interfaz o es la del switch, o la IP de los equipos es una dirección del propio servidor.
- **Instrucciones para configurarlo a mano:** las VLAN que hay que crear y, por puerto, su PVID y de qué VLAN es miembro con y sin etiqueta. Con el tipo «Manual», o si el switch no es un TP-Link Easy Smart, se configura con esto desde su propia web.

**Salud.** Sistema → Salud añade (solo con el servidor en marcha) «Interfaz de la red de equipos» (conectada, enlace, velocidad; sin elegir: «Hay adaptadores de red sin configurar»), «Red del servidor (VLAN)» (con las órdenes pendientes o la VLAN que no pasa la comprobación de rutas), «Permiso CAP_NET_ADMIN», «NetworkManager» (si falta la exclusión), «Redes repetidas en el servidor» (otra tarjeta en la red de los equipos o del switch; aviso si además falta el ARP estricto), «Restos de la red de equipos» (lo que dejó una versión anterior), «Switch de los equipos» (conectado, firmware y diferencias) y «Puertos del switch» (con enlace, asignados y asignados sin enlace). También con `doctor`: «ARP con redes repetidas».

**Auditoría** (categoría «Red de equipos»): «Red de equipos cambiada» (qué ajustes, la interfaz elegida o dejada con el aviso que se confirmó, los avisos al guardar y los restos quitados; de la contraseña solo que cambió), «Red del servidor actualizada» (las órdenes `ip` ejecutadas), «Búsqueda de switch», «Switch preparado para los equipos», «Configuración anterior del switch restaurada», «VLAN del switch quitadas» (cada una con la lista de cambios, y como error si falló) y «Copia del switch descargada».

---

## 4. Copias de seguridad y restauración

### 4.1 Copias automáticas

- **Diaria:** a partir de las 03:00 (hora local del equipo), una vez al día. Se conservan las 14 últimas (Sistema → Copias). Si hay poco espacio (menos de dos veces el tamaño de la base de datos más 512 MiB) o la captura está en pausa por disco lleno, se omite con un aviso en Salud.
- **Antes de migrar** la base de datos (`pre-migrate`) y **antes de actualizar** (`pre-upgrade-<anterior>-to-<nueva>`, la hace `install.sh`): se conservan las 5 últimas de cada tipo.
- **Antes de restaurar** (`pre-restore`): la hace `restore`; se conservan 5.

Las copias están en `/var/lib/relay-manager/backups/` con nombres como `relay-manager-20260923T020000Z-daily.db` y un `.json` al lado con la versión y las migraciones. Son copias consistentes aunque el servidor esté escribiendo, y se verifican al crearlas.

### 4.2 Copia manual

- En la web: Sistema → Copias → «Crear copia ahora». Desde la misma tabla se descargan o eliminan.
- En la línea de órdenes (con el servicio en marcha):

  ```bash
  sudo relay-manager backup
  ```

  Imprime la ruta del fichero creado. Las copias manuales no se borran solas.

### 4.3 Restaurar

Solo desde la línea de órdenes, con el servicio **detenido**:

```bash
sudo systemctl stop relay-manager
sudo relay-manager restore relay-manager-20260923T020000Z-daily.db   # por nombre, desde backups/
sudo relay-manager restore /media/usb/copia.db                       # o por ruta
sudo systemctl start relay-manager
```

`restore`:

1. se niega si el servidor está en marcha («Detén el servicio antes de restaurar…»);
2. copia la copia elegida junto a la base de datos y comprueba su integridad;
3. pide confirmación (salvo con `--yes`);
4. guarda la base de datos actual como copia `pre-restore` y la sustituye.

Si la copia es de una versión anterior, el servidor aplica las migraciones al arrancar. Una ruta se importa primero a `backups/` como `…-import.db`.

Para volver a una versión anterior del programa, usa `sudo relay-manager rollback` ([INSTALACION.md](INSTALACION.md#9-volver-a-una-versión-anterior)).

### 4.4 Lo que no entra en las copias

Las copias contienen la base de datos (usuarios, equipos, plantillas, placas, reservas, ajustes y auditoría). **No** contienen:

- `/etc/relay-manager/` (`config.env` y certificados): cópialo aparte, por ejemplo `sudo tar czf relay-manager-etc.tar.gz /etc/relay-manager`;
- las capturas de consola (`consoles/`);
- la carpeta de **Archivos** (`RM_FILES_DIR`): son ficheros de los usuarios, cópiala aparte si hace falta;
- el secreto de sesión (`auth-secret`): si se pierde, se genera otro y los usuarios vuelven a entrar.

Para guardar copias fuera del equipo, copia periódicamente `/var/lib/relay-manager/backups/` a otro disco.

### 4.5 Exportar e importar la configuración

La configuración (plantillas, roles, placas **sin contraseñas** y equipos con sus asignaciones de puertos, sin usuarios) se puede pasar de un banco a otro en JSON:

- Web: Sistema → Copias → «Exportar configuración (JSON)» e «Importar configuración…». La importación enseña primero un informe de lo que haría.
- Línea de órdenes:

  ```bash
  sudo relay-manager config export /tmp/banco.json
  sudo relay-manager config import /tmp/banco.json --dry-run     # solo informa
  sudo systemctl stop relay-manager
  sudo relay-manager config import /tmp/banco.json
  sudo systemctl start relay-manager
  ```

Lo que ya existe con el mismo nombre se omite y se informa. La importación por línea de órdenes necesita el servicio detenido; la de la web no.

Las plantillas exportadas llevan su origen (`source`: local o del fichero, y `sourceFile`). Al importar, todas se crean como plantillas **locales** (también se aceptan ficheros de la versión 2, con `builtin`, que se ignora); en la siguiente carga del perfil, las que tengan la misma clave que un fichero de `plantillas/` quedan vinculadas a él.

---

## 5. Hora del sistema

Las capturas, la auditoría y las cuentas atrás usan la hora del servidor, así que conviene sincronizarla con una fuente de hora del laboratorio.

**Con systemd-timesyncd** (viene con Ubuntu):

```bash
sudo mkdir -p /etc/systemd/timesyncd.conf.d
printf '[Time]\nNTP=198.51.100.1\n' | sudo tee /etc/systemd/timesyncd.conf.d/laboratorio.conf
sudo systemctl restart systemd-timesyncd
timedatectl timesync-status
```

**Con chrony** (si está instalado; en un equipo sin conexión, trae el `.deb` en USB):

```bash
echo "server 198.51.100.1 iburst" | sudo tee /etc/chrony/sources.d/laboratorio.sources
sudo chronyc reload sources
chronyc tracking
```

(cambia `198.51.100.1` por la fuente de hora de tu laboratorio). `doctor` avisa si hay un servidor NTP configurado y el reloj no está sincronizado, y **falla** si la hora del sistema es anterior a la fecha de compilación del programa (pila del reloj agotada): corrígela con `sudo timedatectl set-time "2026-09-24 10:00:00"`.

---

## 6. Simuladores contra el servicio

Para probar el servicio instalado sin hardware se pueden usar los simuladores del repositorio (no vienen en el paquete). Copia al equipo `scripts/sim/fake-zynq.py` (necesita `python3`) y `scripts/sim/devantech-sim.mjs`, en una carpeta que el usuario `relay-manager` pueda leer (por ejemplo `/opt/rm-sim`, no dentro de `/home`), y ejecuta los ejemplos desde ella.

El servicio usa un `/tmp` privado, así que los simuladores de consola deben crear sus enlaces en `/run/relay-manager/sim` y ejecutarse **como el usuario del servicio**:

```bash
sudo install -d -o relay-manager -g relay-manager -m 0750 /run/relay-manager/sim
sudo -u relay-manager python3 fake-zynq.py --link /run/relay-manager/sim/ttyV0 --stage boot --host equipo-a-01-uart0 &
sudo -u relay-manager python3 fake-zynq.py --link /run/relay-manager/sim/ttyV1 --stage login --host equipo-a-01-uart1 &
```

En `/etc/relay-manager/config.env`:

```
RM_SERIAL_EXTRA_GLOBS=/run/relay-manager/sim/ttyV*
```

y `sudo relay-manager restart`. Los puertos aparecen en Descubrimiento, en el grupo «Puertos virtuales y del sistema».

Etapas de `fake-zynq.py` (`--stage`): `boot` (FSBL, cuenta atrás de U-Boot, Linux y `login:`), `login`, `shell`, `uboot`, `bitreader`, `silent` y `garbage`. Otras opciones: `--autoboot <s>`, `--speed <factor>` (0 = instantáneo) y `--tick <s>` (líneas periódicas del núcleo).

Simulador de placa Devantech con el Node del paquete:

```bash
/opt/relay-manager/current/node/bin/node devantech-sim.mjs --model dS378 --host 127.0.0.2 --http 18080 --ascii 17123
```

Añádela en Placas de relés con el controlador «Devantech dS (ASCII TCP)», dirección `127.0.0.2` y puerto TCP `17123`.

---

## 7. Referencia de la línea de órdenes

Uso: `relay-manager <orden> [opciones]`. `relay-manager help` muestra la lista. Los mensajes están en español.

En la instalación como servicio, las órdenes que tocan datos se ejecutan como el usuario `relay-manager`: si las lanzas con otro usuario, el lanzador pide `sudo`.

| Orden | Qué hace |
|---|---|
| `start` | Inicia el servidor en primer plano (la orden por defecto; es la que usa el servicio). |
| `doctor [--json] [--problems]` | Diagnóstico de solo lectura (apartado [8](#8-relay-manager-doctor)). `--json` da el resultado en JSON; `--problems` muestra solo avisos y fallos. |
| `setup-token` | Muestra el código de configuración inicial. Si ya está completada, lo dice. |
| `user list` | Lista los usuarios con su estado y último acceso. |
| `user create <usuario> [--name <nombre>] [--admin] [--password-stdin]` | Crea un usuario. Pide la contraseña dos veces, o la lee de la primera línea de la entrada con `--password-stdin`. Un administrador creado así completa la configuración inicial. |
| `user reset-password <usuario> [--password-stdin \| --generate]` | Cambia la contraseña y cierra sus sesiones; deberá cambiarla al entrar. `--generate` crea una aleatoria y la muestra una vez. |
| `user enable <usuario>` / `user disable <usuario>` | Activa o desactiva. Desactivar cierra sus sesiones y libera sus reservas. |
| `user set-admin <usuario> on\|off` | Da o quita el rol de administrador. |
| `backup [--label <etiqueta>]` | Copia de seguridad; imprime la ruta. Etiqueta por defecto `manual` (también admite `daily`, `import`, `portable`, `pre-migrate`, `pre-restore` y `pre-upgrade-<a>-to-<b>`). |
| `restore <nombre\|ruta> [--yes]` | Restaura una copia (servicio detenido). Pide confirmación salvo con `--yes`. |
| `config export [<fichero>]` | Exporta la configuración en JSON (sin fichero, a la salida estándar). |
| `config import <fichero> [--dry-run]` | Importa la configuración (servicio detenido); `--dry-run` solo informa. |
| `plantillas recargar` | Carga ahora las plantillas de `plantillas/` del perfil en la base de datos (lo mismo que «Recargar plantillas» en la web y que el arranque), con el servidor en marcha o parado. Imprime un informe: creadas, actualizadas, vinculadas (plantillas locales con la misma clave que un fichero), retiradas (su fichero ya no está) y errores, cada uno con su fichero y la ruta dentro del JSON (por ejemplo `plantillas/equipo-a.json: consoles[1].key: Clave repetida: UART0`). Sale con código 1 si algún fichero tiene errores. |
| `plantillas comprobar` | Solo valida los ficheros del perfil (`perfil.env` y `plantillas/*.json`), sin tocar la base de datos; mismo informe de errores y mismo código de salida. Útil antes de copiar un perfil al servidor. |
| `migrate [--dry-run]` | Aplica las migraciones pendientes con copia previa (servicio detenido). `--dry-run` solo informa, sin crear nada. El servidor ya migra al arrancar. |
| `ping [--quiet]` | Comprueba que el servidor responde en `/api/health`. |
| `version` | Muestra la versión, la revisión, la fecha de compilación y la versión de Node. |
| `status` | Estado del servicio (`systemctl status`). Solo del lanzador. |
| `restart` | Reinicia el servicio. Solo del lanzador. |
| `logs` | Registro del servicio en directo (`journalctl -u relay-manager -f`). Solo del lanzador. |
| `rollback [--to <versión>] [--yes]` | Vuelve a una versión instalada anterior (solo servicio). |
| `help` | La ayuda. |

**Códigos de salida:**

| Código | Significado |
|---|---|
| 0 | Correcto |
| 1 | Error, o `doctor` con algún fallo |
| 2 | Uso incorrecto, configuración no válida o puerto no disponible |
| 3 | La migración falló (la base de datos queda como estaba y se conserva la copia) |
| 4 | La base de datos tiene migraciones que esta versión no conoce |
| 5 | Otro proceso del servidor usa el mismo directorio de datos |

---

## 8. `relay-manager doctor`

`sudo relay-manager doctor` revisa el equipo y la instalación **sin cambiar nada**: no crea directorios, base de datos ni secreto. Cada línea empieza por `[ OK ]`, `[AVISO]`, `[FALLO]` o `[INFO]`, con una pista (`→`) cuando hay algo que hacer. Termina con `N fallo(s), M aviso(s)`. Sale con código 1 solo si hay algún fallo. La misma lista está en Sistema → Salud (con algunas comprobaciones más del servidor en marcha).

| Comprobación | Qué mira |
|---|---|
| Node.js, Módulos nativos | La versión de Node y que cargan `better-sqlite3` y `serialport`. |
| Errores no controlados | (Solo en Salud) errores internos desde el arranque. |
| Directorio de datos | Que se puede escribir y el espacio libre (aviso por debajo de 1 GiB, fallo por debajo de 200 MiB). |
| Propietario de los datos | Que todo lo que hay en el directorio de datos es del usuario del servicio. Si falla: `sudo chown -R relay-manager:relay-manager /var/lib/relay-manager`. |
| Secreto de sesión | Que `auth-secret` existe con permisos 0600. |
| Base de datos, Migraciones | Integridad, número de usuarios y migraciones pendientes o desconocidas. |
| Copias de seguridad | Que hay una copia diaria de menos de 48 h (si está activada), o que se omitió por falta de espacio. |
| Captura de consolas | Tamaño y si está en pausa por disco. |
| Carpeta de archivos | Que la carpeta de Archivos existe, que el servicio puede escribir en ella y el espacio libre (aviso por debajo de 1 GiB, fallo por debajo de 200 MiB). En el servicio, si la carpeta está en `/home`, `doctor` no la puede ver desde fuera de la unidad y lo dice como `[INFO]`: la comprobación real está en Sistema → Salud. |
| Perfil | La carpeta del perfil (`RM_PROFILE_DIR`; [PERFIL.md](PERFIL.md)): `[INFO]` si no hay perfil (se usan los valores genéricos), `[ OK ]` «<carpeta>: N plantillas», `[FALLO]` con cada error de `perfil.env` o de una plantilla (fichero y ruta dentro del JSON) y `[AVISO]` por cada variable de `perfil.env` que un perfil no puede definir («Variable no permitida en perfil.env: X»), o si `RM_PROFILE_DIR` apunta a una carpeta que no existe. |
| Segunda carpeta compartida | (Si tiene nombre, `RM_FILES_EXTRA_NAME`) lo mismo que «Carpeta de archivos» para la segunda carpeta. |
| Descargas (nombre de `RM_EXPORT_NAME`) | `[INFO]` si está desactivada; si no, que el script existe y se puede leer, que hay `bash` y `setpriv` y, con `RM_EXPORT_URL`, que esa dirección responde en 3 s. Solo avisos. |
| Copia como administrador (sudo) | Que el ayudante de root responde y que su usuario con sudo puede autenticar (existe, tiene sudo, tiene contraseña, hay `python3` o `perl`): «Ayudante listo: contraseña de <usuario> (sudo); escribe en /media, /run/media, /mnt». En el servicio, un problema es un aviso con la orden para arreglarlo; en portátil, desarrollo y Docker sale como `[INFO]` (no hay ayudante). |
| Grupo dialout | Que el proceso pertenece a `dialout`. |
| Puertos serie USB | Cuántos adaptadores hay y si alguno no se puede abrir (permisos, Docker). |
| Latencia FTDI | Que los FTDI tienen latencia 1 (regla udev instalada). |
| Detección de adaptadores | Si la detección es inmediata (inotify) o solo por sondeo cada 2 s. |
| ModemManager | Aviso si está activo y falta la regla udev. |
| brltty | Aviso si está instalado (se apropia de los CH340/CH341). |
| Consolas, Placas de relés, Escucha UDP 30303 | (Solo en Salud) consolas abiertas o con problemas, placas conectadas y el estado de la escucha UDP. |
| hw_server (JTAG) | Dónde está `hw_server` (y su versión) o por qué no se encuentra. Sin él, los accesos JTAG no se abren. |
| Cables JTAG | Los cables conectados (nombre y número de serie) y si el usuario del servicio puede abrirlos en `/dev/bus/usb` (regla udev). |
| Puertos de los accesos | En `doctor`, qué puertos del rango `RM_ACCESS_PORTS` están ocupados (por el propio servidor si está en marcha, o por otro programa); en Salud, cuántos están asignados y cuántos quedan libres. |
| Accesos de los equipos | (Solo en Salud) accesos abiertos, conexiones y accesos con problemas. |
| Interfaces de red, Ruta por defecto | Las IPv4 con su difusión y la dirección de la aplicación en cada una; sin ruta por defecto, el descubrimiento UDP solo llega a las redes conectadas directamente. |
| ARP con redes repetidas | Si una interfaz de la red de equipos (`rmv*`) comparte red con otra tarjeta del servidor (por ejemplo 192.168.1.x) y falta el ARP estricto (`arp_ignore=1`, `arp_announce=2`), un aviso con la opción `--red-equipos-arp-estricto` del instalador ([INSTALACION.md](INSTALACION.md#176-otra-tarjeta-del-servidor-en-1921681x)). |
| Certificado TLS | (Con HTTPS) que se puede leer, no ha caducado y cubre las IP del equipo. |
| Sincronización horaria, Hora del sistema | NTP (apartado [5](#5-hora-del-sistema)) y que la hora no es anterior a la compilación. |
| Servicio systemd, Puerto HTTP | (Solo `doctor`) si el servicio está activo y quién usa el puerto. |

Si falta una herramienta del sistema para una comprobación, sale como `[INFO]`. En Docker, ModemManager, brltty, NTP y systemd salen como «No comprobable desde el contenedor».

---

## Solución de problemas

| Síntoma | Causa | Solución |
|---|---|---|
| No aparece ningún puerto serie | El adaptador no se detecta | `lsusb` y `dmesg \| tail` al conectarlo. Mira `sudo relay-manager doctor`. |
| Los puertos aparecen «Sin permiso (grupo dialout)» | Falta la regla udev o el usuario no está en `dialout` | Reinstala con `install.sh` (pone la regla y el grupo) o `sudo usermod -aG dialout relay-manager` y `sudo relay-manager restart`. En modo portátil, tu usuario debe estar en `dialout`. |
| Los `ttyACM*` no llegan a U-Boot o se cortan | ModemManager les envía comandos AT | Instala la regla udev (la marca para que ModemManager la ignore) o `sudo systemctl disable --now ModemManager`. |
| Un adaptador CH340/CH341 aparece y desaparece | brltty se lo apropia | `sudo apt remove brltty` o, sin conexión, `sudo systemctl mask brltty-udev.service` y reconecta. |
| Docker: no se ven los puertos o salen «Sin permiso» | Falta el montaje `/dev:/hostdev:ro`, `RM_SERIAL_DEV_ROOT`, la regla de cgroup o el grupo | Revisa `compose.yaml` ([INSTALACION.md](INSTALACION.md#103-por-qué-está-configurado-así)): `DIALOUT_GID`, `device_cgroup_rules` (añade el *major* de `ttyXRUSB*`/`ttyCH*USB*`) y la regla udev del anfitrión. |
| Consola «En uso por otro programa» | picocom, BITReader_Tool, `hw_server` u otra instancia tiene el puerto | Cierra ese programa; la consola se reabre sola. Para usarlos a propósito, «Soltar puerto» primero. |
| Salida con caracteres raros | Velocidad o formato incorrectos, o dos programas leyendo el mismo puerto | Comprueba la velocidad en Ajustes del equipo («Identificar» dice «Datos ilegibles (¿velocidad?)»). Asegúrate de que ningún programa lee el puerto a la vez (`sudo fuser -v /dev/ttyUSB2`). |
| Consola en silencio mientras se depura por JTAG | BITReader_Tool o `hw_server` ha parado la CPU por JTAG | Es lo esperado: no hay nada que mostrar. La salida vuelve cuando la CPU continúa. |
| La consola no responde al teclado | Sin reserva, o la reserva caducó | Reserva el equipo. El panel lo indica con «Solo lectura». |
| «Demasiadas sesiones abiertas» | Demasiadas pestañas con la misma consola | Cierra pestañas y pulsa «Reintentar». |
| No se encuentran placas de relés | Otra subred, cortafuegos o placa sin DHCP | Prueba «Escanear subred…»; abre UDP 30303 en el cortafuegos; para placas con IP de fábrica usa una IP secundaria (apartado [3.6](#36-descubrimiento)). |
| Un relé «no cambió de estado» | El canal está configurado como pulso o lo gobierna una ecuación en la placa | Revisa la configuración del relé en la página web de la placa. |
| Una placa aparece «IP cambiada» | La placa (misma MAC) anuncia otra IP | Confirma que es la tuya y pulsa «Actualizar IP». |
| Las horas no cuadran o `doctor` avisa de NTP | Reloj sin sincronizar | Apartado [5](#5-hora-del-sistema). |
| «Captura en pausa: poco espacio en disco» | Queda poco disco libre | Libera espacio o baja los límites en Sistema → Consolas; la captura se reanuda sola. Revisa también `backups/`. |
| Olvido de la contraseña de administrador | | `sudo relay-manager user list` para ver el usuario y `sudo relay-manager user reset-password <usuario>`. Si está desactivado: `user enable`; si ya no es administrador: `user set-admin <usuario> on`. |
| «Nueva versión instalada» en el navegador | Se ha actualizado el servidor | Pulsa «Recargar». |
| La página no carga tras actualizar o reiniciar | El servicio no ha arrancado | `relay-manager status`, `relay-manager logs` y `sudo relay-manager doctor`. |
| El servicio no arranca: «Otra instancia usa …» (código 5) | Hay otro servidor (portátil, manual o contenedor) con los mismos datos | Detén el otro. Un `server.pid` antiguo tras un corte de luz **no** bloquea el arranque. |
| El servicio no arranca: código 4 | La base de datos es de una versión más nueva | `sudo relay-manager rollback` a esa versión, o restaura la copia `pre-upgrade`. |
| El navegador dice «Navegador no compatible» | Navegador antiguo | [INSTALACION.md](INSTALACION.md#12-navegadores). |
| Tras activar HTTPS nadie tiene sesión | La cookie de sesión cambia de nombre con HTTPS | Es normal: vuelve a entrar. |
| Un acceso está «Cerrado» | El equipo no está reservado (apertura «Solo con reserva») | Reserva el equipo; los accesos se abren al momento. |
| Un acceso JTAG dice «Falta hw_server» | No se encuentra `hw_server` en el servidor | Instala Vivado Lab en `/tools/Xilinx` u `/opt/Xilinx` o define `RM_HW_SERVER` ([INSTALACION.md](INSTALACION.md#55-accesos-jtag-hw_server-y-cables)); comprueba con `doctor`. |
| Un acceso JTAG dice «Cable no conectado» | El cable elegido no está conectado al servidor | Conéctalo (cualquier puerto USB): el acceso se abre solo. En Cables se ve qué cable es por su nombre. |
| Un acceso JTAG está en «Error» y se reintenta | `hw_server` termina al arrancar | Mira `relay-manager logs` (componente `jtag`): permisos del cable (`doctor`, regla udev), firmware de la Platform Cable (`install_drivers`) u otro `hw_server` con el cable. |
| xsdb conecta al acceso JTAG pero `jtag targets` no muestra el cable | El filtro de `hw_server` no coincide con el nombre que da tu versión al cable | Prueba `RM_HW_SERVER_FILTER_FORMAT={vendor}/{serial}` en `config.env` y reinicia el servicio ([INSTALACION.md](INSTALACION.md#55-accesos-jtag-hw_server-y-cables)). Comprueba también que no hay otro `hw_server` (por ejemplo uno de Vivado en el 3121) con el cable. |
| Un acceso está en «Error»: «fuera del rango de accesos» | Se cambió `RM_ACCESS_PORTS` después de crear el acceso | Elige un puerto del rango nuevo en los ajustes del equipo. |
| El equipo no se libera solo aunque nadie use la web | Hay una sesión remota abierta (xsdb, `nc`, `ssh`) que renueva la reserva | Mira «sesiones remotas» en la barra de reserva o en la pestaña Accesos y ciérrala; un administrador puede forzar la liberación. |
| Un acceso dice «Puerto ocupado» | Otro programa del servidor usa ese puerto | `sudo ss -ltnp 'sport = :3203'` para ver cuál; ciérralo o cambia el puerto del acceso en Ajustes. |
| Por `nc` la consola dice «Solo lectura» | El equipo no está reservado (acceso «Siempre») | Reserva el equipo en la web: la conexión pasa a escritura sin reconectar. |
| Desde el PC no se conecta a un acceso abierto | Cortafuegos del laboratorio o del servidor | Deben estar permitidos los puertos 3201–3230 (apartado 13 de [INSTALACION.md](INSTALACION.md#13-red-y-cortafuegos)). |
| Archivos: «La carpeta de archivos … no existe» o «no está disponible» | `RM_FILES_DIR` apunta a una carpeta que no existe o que el servicio no ve | En el servicio: `sudo /opt/relay-manager/current/install.sh --files-dir <ruta> --yes` (crea la carpeta, sus permisos y el acceso de systemd). En Docker, revisa el montaje de `/files`. Sistema → Salud («Carpeta de archivos») dice qué falla. |
| Archivos: «El servidor no tiene permiso para modificar …» | La carpeta (o una subcarpeta creada a mano) no tiene escritura para el grupo `relay-files` | Como dueño de la carpeta: `chgrp -R relay-files <carpeta> && chmod -R g+rwX <carpeta>` y `find <carpeta> -type d -exec chmod g+s {} +`. |
| Archivos: en el servidor no puedo modificar lo que sube la web | Tu usuario aún no tiene el grupo `relay-files` | `install.sh` te añade al grupo: cierra la sesión y vuelve a entrar (`id` debe mostrar `relay-files`). |
| Archivos › Copiar: «Solo como administrador» en un pendrive | El escritorio monta los pendrives para su usuario (FAT, exFAT y NTFS no dejan escribir a nadie más) | Es lo normal: usa «Copiar como administrador (sudo)» con la contraseña del usuario que instaló la aplicación. |
| Archivos › Copiar: «La copia como administrador no está disponible» | Modo portátil, Docker, el ayudante no responde o su usuario no tiene sudo o contraseña | El mensaje dice cuál y qué orden ejecutar; Sistema → Salud («Copia como administrador (sudo)»). |
| Archivos: «No hay espacio en el disco del servidor» | El disco de la carpeta está casi lleno | Borra ficheros que ya no hagan falta (desde Archivos o en el servidor). La subida se reintenta con «↻». |
| Un acceso Ethernet dice «Sin red de equipos» | La red de equipos no está activa o el servidor aún no tiene la VLAN de ese puerto | La causa lo dice. Sistema › Red de equipos: si pone «Sin permiso para cambiar la red», ejecuta las órdenes pendientes o da el permiso al servicio ([INSTALACION.md](INSTALACION.md#17-red-de-equipos-switch-y-adaptador-usb)); si una VLAN «no pasa la comprobación», revisa con `ip rule` qué regla se adelanta. |
| «La VLAN del puerto N no está lista: el servidor ya no tiene su dirección …» | La dirección de esa VLAN desapareció (alguien la quitó, o el adaptador se desconectó) | La aplicación no lo intenta por otra tarjeta; la vuelve a poner sola en unos segundos si tiene permiso. Si no, ejecuta las órdenes pendientes. |
| Acceso Ethernet por el switch «sin enlace» | No hay nada conectado en ese puerto del switch, o el equipo está apagado | Comprueba el cable y el número de puerto (la lista de puertos del switch muestra el enlace en directo). |
| «Buscar el switch» no lo encuentra | La interfaz elegida no es la del puerto 1, no tiene enlace, aún no tiene dirección de gestión (sin permiso), o el switch no está en 192.168.0.0/24 | Comprueba el cable y la interfaz del paso 1. Escribe la IP del switch y pulsa «Probar esta IP» (apartado 17 de [INSTALACION.md](INSTALACION.md#17-red-de-equipos-switch-y-adaptador-usb)). |
| Al guardar: «La red 192.168.1.0/24 ya la usa … en este servidor» | Versión anterior: trataba como error que otra tarjeta estuviera en la red de los equipos | Actualiza: ahora es solo un aviso. |
| «La dirección de gestión 192.168.0.250 ya la tiene … (la dejó una versión anterior…)» | Una versión anterior puso esa dirección en otro adaptador USB | «Quitar restos» en Sistema › Red de equipos, y vuelve a elegir la interfaz. |
| «El switch no coincide con lo que configuró la aplicación» | Alguien cambió el switch a mano, o se apagó antes de guardar | Revisa las diferencias y pulsa «Configurar el switch». |
