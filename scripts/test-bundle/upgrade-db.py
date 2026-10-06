#!/usr/bin/env python3
"""Database helper of the upgrade-chain test (scripts/test-bundle/upgrade-chain.sh), run inside the Debian 12 container.

  upgrade-db.py dump DB OUT.json          every table (rows as {column: value}), read-only
  upgrade-db.py compare BEFORE.json DB    the rows of BEFORE are still in DB (columns that still exist); prints a summary
  upgrade-db.py seed-json DB OUT.json     a `relay-manager config import` file with representative data (2.x format)
  upgrade-db.py templates DB PLANTILLAS   templates linked to the profile files: one per file, source=file, no duplicates
  upgrade-db.py users DB                  "username" per line

Tables whose rows legitimately change in an upgrade are compared by count only (AuditEvent, _prisma_migrations,
sqlite_sequence) or checked on their own (EquipmentTemplate: the profile links them to its files; Settings: new
columns, same old values).
"""
import json
import os
import sqlite3
import sys

COUNT_ONLY = {"AuditEvent", "_prisma_migrations", "sqlite_sequence"}
# Columns rewritten on purpose by later versions (their meaning is kept elsewhere).
IGNORED = {("EquipmentTemplate", "*"), ("Settings", "updatedAt")}


def connect(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def tables(c):
    return [r[0] for r in c.execute("select name from sqlite_master where type='table' order by name")]


def columns(c, t):
    return [r[1] for r in c.execute(f'pragma table_info("{t}")')]


def dump(db, out):
    c = connect(db)
    data = {}
    for t in tables(c):
        cols = columns(c, t)
        rows = [dict(zip(cols, r)) for r in c.execute(f'select * from "{t}"')]
        data[t] = {"columns": cols, "rows": rows}
    with open(out, "w") as f:
        json.dump(data, f, default=str)


def key_of(t, row):
    for k in ("id", "A", "migration_name", "name"):
        if k in row:
            return (k, row[k] if k != "A" else (row.get("A"), row.get("B")))
    return ("row", json.dumps(row, sort_keys=True, default=str))


def compare(before_path, db):
    before = json.load(open(before_path))
    c = connect(db)
    now_tables = set(tables(c))
    problems = []
    summary = []
    for t, info in sorted(before.items()):
        if t not in now_tables:
            problems.append(f"{t}: la tabla ya no existe")
            continue
        cols_now = columns(c, t)
        n_now = c.execute(f'select count(*) from "{t}"').fetchone()[0]
        n_before = len(info["rows"])
        if n_now < n_before:
            problems.append(f"{t}: {n_before} filas antes, {n_now} después")
        summary.append(f"{t}={n_before}→{n_now}")
        if t in COUNT_ONLY or (t, "*") in IGNORED or n_before == 0:
            continue
        common = [col for col in info["columns"] if col in cols_now and (t, col) not in IGNORED]
        now_rows = [dict(zip(cols_now, r)) for r in c.execute(f'select * from "{t}"')]
        now_by_key = {key_of(t, r): r for r in now_rows}
        for r in info["rows"]:
            k = key_of(t, r)
            n = now_by_key.get(k)
            if n is None:
                problems.append(f"{t}: falta la fila {k}")
                continue
            for col in common:
                if str(r[col]) != str(n[col]):
                    problems.append(f"{t} {k}: {col} cambió ({str(r[col])[:60]!r} → {str(n[col])[:60]!r})")
    print("filas: " + " ".join(summary))
    if problems:
        print("\n".join(problems[:40]))
        sys.exit(1)


def seed_json(db, out):
    c = connect(db)
    tpl = c.execute("select name from EquipmentTemplate order by position, name limit 1").fetchone()
    tpl_name = tpl[0] if tpl else None
    line = {"baudRate": 115200, "dataBits": 8, "parity": "none", "stopBits": 1, "flowControl": "none"}

    def console(key, label, baud=115200):
        return {"key": key, "label": label, "line": {**line, "baudRate": baud}, "enterMode": "cr", "localEcho": False,
                "hupcl": False, "captureToDisk": True, "identify": {}, "binding": None}

    def relay(label, purpose, board, channel):
        return {"key": None, "label": label, "purpose": purpose, "requireConfirm": purpose == "power",
                "defaultPulseMs": 500 if purpose == "reset" else None, "boardName": board, "channel": channel}

    data = {
        "format": "relay-manager-config", "version": 1, "exportedAt": "2026-09-30T08:00:00.000Z", "appVersion": "2.2.2",
        "settings": {"labName": "Banco de pruebas", "bannerText": "Mantenimiento el viernes"},
        "roles": [{"name": "Integración", "description": "Equipos de integración"}],
        "templates": [],
        "boards": [
            {"name": "Placa simulada 1", "driver": "simulated", "host": "198.51.100.40", "httpPort": 80, "tcpPort": None,
             "model": "dS378", "moduleId": None, "mac": "00:04:a3:11:22:33", "relayCount": 8, "options": {},
             "username": None, "enabled": True, "hasPassword": False},
        ],
        "equipment": [
            {"name": "Equipo prueba 1", "serialNumber": "SN-0001", "description": "Equipo con todo", "templateName": tpl_name,
             "roles": ["Integración"],
             "consoles": [console("UART0", "Consola principal"), console("UART1", "Depuración", 9600)],
             "relays": [relay("Alimentación", "power", "Placa simulada 1", 1), relay("Reset", "reset", "Placa simulada 1", 2)],
             "accesses": [
                 {"key": "SSH", "label": "SSH", "kind": "tcp", "port": 3205, "enabled": True, "policy": "reserved",
                  "cableSerial": None, "consoleKey": None, "targetHost": "192.0.2.50", "targetPort": 22,
                  "targetMode": "ip", "switchPort": None, "sshUser": "root"},
                 {"key": "SERIE", "label": "Consola por red", "kind": "serial", "port": 3203, "enabled": True,
                  "policy": "always", "cableSerial": None, "consoleKey": "UART0", "targetHost": None, "targetPort": None,
                  "targetMode": "ip", "switchPort": None, "sshUser": None},
             ]},
            {"name": "Equipo prueba 2", "serialNumber": None, "description": None, "templateName": None, "roles": [],
             "consoles": [console("UART0", "Consola")], "relays": [relay("Alimentación", "power", "Placa simulada 1", 3)],
             "accesses": []},
        ],
        "cableLabels": [
            {"kind": "jtag", "identity": "000013ca3a2001", "name": "JTAG-01", "notes": "Cable de la mesa 1"},
            {"kind": "serial-adapter", "identity": "0403:6011:FT4ABCDE", "name": "FTDI-01", "notes": None},
        ],
    }
    with open(out, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


def templates(db, plantillas):
    files = sorted(f[:-5] for f in os.listdir(plantillas) if f.endswith(".json") and not f.startswith((".", "_")))
    c = connect(db)
    rows = c.execute("select key, name, source, sourceFile, retiredAt from EquipmentTemplate order by key").fetchall()
    keys = [r[0] for r in rows if r[0] is not None]
    problems = []
    if len(keys) != len(set(keys)):
        problems.append(f"claves repetidas: {keys}")
    names = [r[1] for r in rows]
    if len(names) != len(set(names)):
        problems.append(f"nombres repetidos: {names}")
    for k in files:
        r = [x for x in rows if x[0] == k]
        if not r:
            problems.append(f"falta la plantilla del fichero {k}.json")
        elif r[0][2] != "file" or r[0][3] != f"plantillas/{k}.json" or r[0][4] is not None:
            problems.append(f"{k}: source={r[0][2]} sourceFile={r[0][3]} retiredAt={r[0][4]}")
    print(f"plantillas: {len(rows)} filas; de fichero: {', '.join(files)}")
    if problems:
        print("\n".join(problems))
        sys.exit(1)


def users(db):
    c = connect(db)
    for (u,) in c.execute("select username from User order by username"):
        print(u)


if __name__ == "__main__":
    cmd, *args = sys.argv[1:]
    {"dump": dump, "compare": compare, "seed-json": seed_json, "templates": templates, "users": users}[cmd](*args)
