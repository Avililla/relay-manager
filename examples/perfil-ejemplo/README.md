# Perfil de ejemplo

Un **perfil** reúne todo lo que es propio de un proyecto y no va en el código de Relay Manager: los valores por
defecto (`perfil.env`), las plantillas de equipos (`plantillas/*.json`) y los scripts del proyecto (`herramientas/`).
Este es un ejemplo genérico para copiarlo y adaptarlo; la referencia completa está en [docs/PERFIL.md](../../docs/PERFIL.md).

```
perfil-ejemplo/
  perfil.env                      valores del proyecto (nombre del laboratorio, segunda carpeta, descargas, red de equipos)
  plantillas/
    equipo-2-consolas.json        «Equipo con 2 consolas»: UART0/UART1, JTAG, serie por TCP y SSH (marcada «Revisar»)
    equipo-con-reles.json         «Equipo con relés»: una consola, alimentación y reset
  herramientas/
    descarga-ejemplo.sh           script de «Descargas»: <aplicación> <versión> -o <salida.zip> [-x]
```

## Dónde se busca el perfil

`RM_PROFILE_DIR` (en el entorno o en `config.env`) o, si no está definida:

| Modo | Carpeta |
|---|---|
| Servicio (systemd) | `/etc/relay-manager/perfil` (la instala `install.sh --perfil <carpeta>`) |
| Portátil | `perfil/` junto a `app/` |
| Docker | `/perfil` (montada desde el anfitrión) |
| Desarrollo | `./perfil` en el repositorio, si existe (está en `.gitignore`) |

Sin perfil, la aplicación usa valores genéricos y no tiene plantillas de fichero (se pueden crear en la web).

## Plantillas

Cada fichero `plantillas/*.json` define una plantilla. El formato está en
[`docs/plantilla.schema.json`](../../docs/plantilla.schema.json); `key` es su identidad (no la cambies). Las plantillas
de fichero se ven en la web como **solo lectura** («Fichero»); «Duplicar» crea una copia editable. Tras cambiar un
fichero: «Recargar plantillas» en Plantillas, o `relay-manager plantillas recargar`. Para validarlas sin cambiar nada:
`relay-manager plantillas comprobar`. Si quitas un fichero, su plantilla queda «Retirada» (los equipos creados con
ella siguen igual).

## Probarlo en desarrollo

```sh
RM_PROFILE_DIR=examples/perfil-ejemplo pnpm dev
```
