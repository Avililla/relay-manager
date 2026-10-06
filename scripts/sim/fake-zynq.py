#!/usr/bin/env python3
"""Consola Zynq simulada sobre un pty (solo stdlib, sin socat). W1-A, SPEC §10.2.

Crea un pty, lo pone en modo raw, deja un symlink en --link (p. ej. /run/relay-manager/sim/ttyV0) y hace de placa:
  --stage boot      : FSBL -> U-Boot (cuenta atras, se para si recibe una tecla) -> Linux -> login
  --stage login     : ya arrancada, contesta con "<host> login:" al recibir Enter
  --stage shell     : shell root, eco de lo que se teclea
  --stage uboot     : parada en el prompt "Zynq> "
  --stage bitreader : imprime el banner de BITReader_Tool y el resultado
  --stage silent    : no dice nada nunca
  --stage garbage   : bytes aleatorios (baudios mal puestos)
Enter en cualquier consola "viva" reimprime el prompt. 'reboot' en el shell (o 'boot' en U-Boot) vuelve a arrancar.
Varias instancias = varios puertos (un FT4232H de 4 consolas = 4 procesos).
--speed multiplica los retardos (0 = instantaneo, para pruebas). --tick N escribe una linea del kernel cada N s
(demostraciones de captura continua; 0 = nunca).
"""
import argparse
import os
import pty
import random
import select
import signal
import sys
import time
import tty

p = argparse.ArgumentParser(description="Consola Zynq simulada sobre un pty")
p.add_argument("--link", required=True, help="ruta del symlink al pty (p. ej. $XDG_RUNTIME_DIR/relay-manager-sim/ttyV0)")
p.add_argument("--stage", default="boot",
               choices=["boot", "login", "shell", "uboot", "bitreader", "silent", "garbage"])
p.add_argument("--host", default="equipo-uart0", help="nombre de host que muestra el prompt")
p.add_argument("--autoboot", type=int, default=3, help="segundos de la cuenta atras de U-Boot")
p.add_argument("--speed", type=float, default=1.0, help="multiplicador de retardos (0 = instantaneo)")
p.add_argument("--tick", type=float, default=0.0, help="segundos entre lineas periodicas del kernel (0 = nunca)")
a = p.parse_args()

master, slave = pty.openpty()
tty.setraw(slave)  # sin eco ni ICANON en el lado "placa"; serialport pone raw igualmente
# Mantener 'slave' abierto evita EIO en el master cuando la app cierra el puerto (soltar/retomar).
link = os.path.abspath(a.link)
os.makedirs(os.path.dirname(link), exist_ok=True)
try:
    os.unlink(link)
except FileNotFoundError:
    pass
os.symlink(os.ttyname(slave), link)
os.chmod(os.ttyname(slave), 0o660)


def cleanup(*_):
    try:
        if os.path.islink(link) and os.readlink(link) == os.ttyname(slave):
            os.unlink(link)
    finally:
        sys.exit(0)


for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
    signal.signal(sig, cleanup)
print(f"{link} -> {os.ttyname(slave)} ({a.stage})", flush=True)


def pause(seconds: float):
    if seconds and a.speed:
        time.sleep(seconds * a.speed)


at_line_start = True  # si lo ultimo escrito termina en salto de linea (las lineas periodicas no dejan huecos)


def out(s: str, delay: float = 0.0):
    global at_line_start
    try:
        os.write(master, s.replace("\n", "\r\n").encode())
        if s:
            at_line_start = s.endswith("\n")
    except OSError:
        pass
    pause(delay)


def raw(b: bytes):
    global at_line_start
    try:
        os.write(master, b)
        if b:
            at_line_start = b.endswith((b"\n", b"\r"))
    except OSError:
        pass


def read_key(timeout: float) -> bytes:
    r, _, _ = select.select([master], [], [], max(0.0, timeout))
    if not r:
        return b""
    try:
        return os.read(master, 1024)
    except OSError:
        return b""


FSBL = ("\nXilinx First Stage Boot Loader\nRelease 2022.2   Jan  1 2024-00:00:00\nSilicon Version 3.1\n"
        "Boot mode is QSPI\nHandoff Address: 0x04000000\n")
UBOOT = "\n\nU-Boot 2022.01 (Jan 01 2024 - 00:00:00 +0000)\n\nCPU:   Zynq 7z020\nModel: Zynq board (simulada)\nDRAM:  ECC disabled 1 GiB\n"
LINUX = ["[    0.000000] Booting Linux on physical CPU 0x0",
         "[    0.000000] Linux version 5.15.36-xilinx-v2022.2 (oe-user@oe-host) #1 SMP PREEMPT",
         "[    2.104512] Freeing unused kernel memory: 1024K",
         "INIT: Entering runlevel: 5"]
started = time.monotonic()


def boot() -> str:
    out(FSBL, 0.3)
    out(UBOOT, 0.3)
    for i in range(a.autoboot, 0, -1):
        out(f"\rHit any key to stop autoboot: {i} ")
        if read_key(1.0 * (a.speed or 0.01)):
            out("\rHit any key to stop autoboot: 0 \nZynq> ")
            return "uboot"
    out("\rHit any key to stop autoboot: 0 \nStarting kernel ...\n\n", 0.2)
    for line in LINUX:
        out(line + "\n", 0.15)
    out(f"\nPetaLinux 2022.2 {a.host} ttyPS0\n\n{a.host} login: ")
    return "login"


stage = a.stage
if stage == "boot":
    stage = boot()
elif stage == "bitreader":
    out("BITReader_Tool v1.0\n---------- BEGIN eMMC0\n...\n---------- END eMMC0\nRESULTADO: OK\n")

line = b""
next_tick = time.monotonic() + a.tick if a.tick > 0 else None
while True:
    if stage == "garbage":
        raw(bytes(random.getrandbits(8) for _ in range(32)))
        pause(0.5)
        read_key(0 if a.speed else 0.05)
        continue
    wait = 1.0
    if next_tick is not None:
        wait = max(0.0, min(wait, next_tick - time.monotonic()))
    data = read_key(wait)
    if next_tick is not None and time.monotonic() >= next_tick:
        next_tick += a.tick
        if stage in ("login", "shell", "password"):
            # Como printk: salta de linea solo si el cursor esta a media linea (tras un prompt), nunca linea en blanco.
            out(("" if at_line_start else "\n") + f"[{time.monotonic() - started + 3:12.6f}] {a.host}: heartbeat\n")
    if not data or stage in ("silent", "bitreader"):
        continue
    for ch in data:
        c = bytes([ch])
        if stage in ("shell", "login", "uboot") and c not in (b"\r", b"\n"):
            raw(c)  # eco (getty, U-Boot y el shell hacen eco; la contrasena no)
        if c in (b"\r", b"\n"):
            cmd = line.decode(errors="replace").strip()
            line = b""
            if stage == "login":
                if cmd:
                    out("\nPassword: " if cmd == "root" else f"\nLogin incorrect\n{a.host} login: ")
                    stage = "password" if cmd == "root" else "login"
                else:
                    out(f"\n{a.host} login: ")
            elif stage == "password":
                out(f"\nroot@{a.host}:~# ")
                stage = "shell"
            elif stage == "shell":
                if cmd == "reboot":
                    out("\nThe system is going down for reboot NOW!\n", 0.5)
                    stage = boot()
                else:
                    out(("\n" + ("sh: " + cmd + ": not found\n" if cmd else "")) + f"root@{a.host}:~# ")
            elif stage == "uboot":
                if cmd == "boot":
                    out("\n")
                    stage = boot()
                else:
                    out(("\nUnknown command '" + cmd + "' - try 'help'\n" if cmd else "\n") + "Zynq> ")
        elif c in (b"\x7f", b"\x08"):
            line = line[:-1]
        else:
            line += c
