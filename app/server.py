#!/usr/bin/env python3
"""Lightwielder Simulations: tiny JSON/CRUD server over SQLite (standard library only).

Usage:
    python app/server.py                 # serve http://127.0.0.1:8000
    python app/server.py --seed          # load sample data if the DB is empty, then serve
    python app/server.py --reset --seed  # delete the DB, recreate, seed
    python app/server.py --init          # create/upgrade schema and exit
Options: --db PATH  --host HOST  --port N
"""
import argparse
import json
import mimetypes
import os
import re
import sqlite3
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCHEMA = os.path.join(ROOT, "db", "schema.sql")
SEED = os.path.join(ROOT, "db", "seed.sql")
STATIC = os.path.join(ROOT, "app", "static")
DEFAULT_DB = os.path.join(ROOT, "data", "lightwielder.db")

# Tables exposed through the API, in nav order, with the column used as a human label.
TABLES = {
    "characters": {"title": "Characters", "label": "name"},
    "character_stats": {"title": "Stat Versions", "label": None},
    "story_points": {"title": "Story Points", "label": "label"},
    "items": {"title": "Items", "label": "name"},
    "item_modifiers": {"title": "Item Modifiers", "label": None},
    "character_equipment": {"title": "Equipment", "label": None},
}
DEFAULT_ORDER = {"story_points": "sequence"}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# --------------------------------------------------------------------------- db

def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path, seed=False):
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = connect(db_path)
    try:
        conn.execute("PRAGMA journal_mode = DELETE")  # keep everything in the single .db file
        with open(SCHEMA, encoding="utf-8") as f:
            conn.executescript(f.read())
        if seed:
            empty = conn.execute("SELECT COUNT(*) FROM characters").fetchone()[0] == 0
            if empty:
                with open(SEED, encoding="utf-8") as f:
                    conn.executescript(f.read())
                print("Loaded sample data from db/seed.sql")
            else:
                print("DB already has characters; skipping seed")
        conn.commit()
    finally:
        conn.close()


_CHECK_IN = re.compile(r"CHECK\s*\(\s*(\w+)\s+IN\s*\(([^)]*)\)\s*\)", re.I)


def table_meta(conn):
    """Describe tables from the live schema so the UI needs no hard-coded columns."""
    meta = {}
    for name, info in TABLES.items():
        sql = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone()[0]
        enums = {}
        for col, values in _CHECK_IN.findall(sql):
            opts = [v.strip().strip("'") for v in values.split(",")]
            enums[col] = [int(o) if o.lstrip("-").isdigit() else o for o in opts]
        fks = {r["from"]: {"table": r["table"], "column": r["to"]}
               for r in conn.execute(f"PRAGMA foreign_key_list({name})")}
        cols = []
        for r in conn.execute(f"PRAGMA table_info({name})"):
            c = {"name": r["name"], "type": (r["type"] or "").upper(), "notnull": bool(r["notnull"]),
                 "default": r["dflt_value"], "pk": bool(r["pk"])}
            if r["name"] in enums:
                if sorted(enums[r["name"]]) == [0, 1]:
                    c["boolean"] = True
                else:
                    c["options"] = enums[r["name"]]
            if r["name"] in fks:
                c["fk"] = fks[r["name"]]
            cols.append(c)
        meta[name] = {"title": info["title"], "label": info["label"], "columns": cols}
    return meta


def columns_of(conn, table):
    return [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")]


def check_table(table):
    if table not in TABLES:
        raise ApiError(HTTPStatus.NOT_FOUND, f"Unknown table '{table}'")


def clean_values(conn, table, body):
    if not isinstance(body, dict):
        raise ApiError(HTTPStatus.BAD_REQUEST, "Body must be a JSON object")
    cols = set(columns_of(conn, table)) - {"id", "created_at", "updated_at"}
    unknown = set(body) - cols - {"id", "created_at", "updated_at"}
    if unknown:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"Unknown column(s): {', '.join(sorted(unknown))}")
    out = {}
    for k, v in body.items():
        if k in cols:
            out[k] = None if v == "" else v
    return out


def list_rows(conn, table, params):
    cols = columns_of(conn, table)
    where, args = [], []
    for k, v in params.items():
        if k in cols:
            if v == "null":
                where.append(f'"{k}" IS NULL')
            else:
                where.append(f'"{k}" = ?')
                args.append(v)
    q = params.get("q")
    if q:
        text_cols = [r["name"] for r in conn.execute(f"PRAGMA table_info({table})")
                     if (r["type"] or "").upper() == "TEXT"]
        if text_cols:
            where.append("(" + " OR ".join(f'"{c}" LIKE ?' for c in text_cols) + ")")
            args += [f"%{q}%"] * len(text_cols)
    order = params.get("order") or DEFAULT_ORDER.get(table, "id")
    if order not in cols:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"Cannot order by '{order}'")
    direction = "DESC" if params.get("dir", "").lower() == "desc" else "ASC"
    sql = f'SELECT * FROM {table}'
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += f' ORDER BY "{order}" {direction}'
    return [dict(r) for r in conn.execute(sql, args)]


def get_row(conn, table, row_id):
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (row_id,)).fetchone()
    if row is None:
        raise ApiError(HTTPStatus.NOT_FOUND, f"{table} #{row_id} not found")
    return dict(row)


def insert_row(conn, table, body):
    vals = clean_values(conn, table, body)
    if vals:
        names = ", ".join(f'"{k}"' for k in vals)
        marks = ", ".join("?" for _ in vals)
        cur = conn.execute(f"INSERT INTO {table} ({names}) VALUES ({marks})", list(vals.values()))
    else:
        cur = conn.execute(f"INSERT INTO {table} DEFAULT VALUES")
    conn.commit()
    return get_row(conn, table, cur.lastrowid)


def update_row(conn, table, row_id, body):
    get_row(conn, table, row_id)
    vals = clean_values(conn, table, body)
    if vals:
        sets = ", ".join(f'"{k}" = ?' for k in vals)
        conn.execute(f"UPDATE {table} SET {sets} WHERE id = ?", list(vals.values()) + [row_id])
        conn.commit()
    return get_row(conn, table, row_id)


def delete_row(conn, table, row_id):
    get_row(conn, table, row_id)
    conn.execute(f"DELETE FROM {table} WHERE id = ?", (row_id,))
    conn.commit()
    return {"deleted": row_id}


def effective_stats(conn, params):
    sql, args = "SELECT * FROM v_effective_stats", []
    if params.get("character_id"):
        sql += " WHERE character_id = ?"
        args.append(params["character_id"])
    sql += " ORDER BY character_id, sequence"
    return [dict(r) for r in conn.execute(sql, args)]


def character_sheet(conn, char_id):
    character = get_row(conn, "characters", char_id)
    stats = [dict(r) for r in conn.execute(
        """SELECT cs.*, sp.label AS story_point, sp.sequence
           FROM character_stats cs JOIN story_points sp ON sp.id = cs.story_point_id
           WHERE cs.character_id = ? ORDER BY sp.sequence""", (char_id,))]
    equipment = [dict(r) for r in conn.execute(
        """SELECT ce.*, i.name AS item_name, i.category, i.slot, i.rarity,
                  f.label AS from_label, f.sequence AS from_sequence,
                  u.label AS until_label, u.sequence AS until_sequence
           FROM character_equipment ce
           JOIN items i ON i.id = ce.item_id
           JOIN story_points f ON f.id = ce.from_story_point_id
           LEFT JOIN story_points u ON u.id = ce.until_story_point_id
           WHERE ce.character_id = ? ORDER BY f.sequence, i.name""", (char_id,))]
    return {"character": character, "stats": stats, "equipment": equipment,
            "effective": effective_stats(conn, {"character_id": char_id})}


def item_sheet(conn, item_id):
    item = get_row(conn, "items", item_id)
    modifiers = list_rows(conn, "item_modifiers", {"item_id": str(item_id)})
    holders = [dict(r) for r in conn.execute(
        """SELECT ce.*, c.name AS character_name, f.label AS from_label, u.label AS until_label
           FROM character_equipment ce JOIN characters c ON c.id = ce.character_id
           JOIN story_points f ON f.id = ce.from_story_point_id
           LEFT JOIN story_points u ON u.id = ce.until_story_point_id
           WHERE ce.item_id = ? ORDER BY f.sequence""", (item_id,))]
    return {"item": item, "modifiers": modifiers, "holders": holders}


# ----------------------------------------------------------------------- http

class Handler(BaseHTTPRequestHandler):
    db_path = DEFAULT_DB
    server_version = "Lightwielder/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("LW_QUIET") != "1":
            super().log_message(fmt, *args)

    def _send(self, status, payload=None, body=None, ctype="application/json"):
        if body is None:
            body = json.dumps(payload, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except json.JSONDecodeError as e:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"Invalid JSON: {e}")

    def _static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        full = os.path.realpath(os.path.join(STATIC, rel))
        if not full.startswith(os.path.realpath(STATIC) + os.sep) or not os.path.isfile(full):
            return self._send(HTTPStatus.NOT_FOUND, {"error": "Not found"})
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        with open(full, "rb") as f:
            self._send(HTTPStatus.OK, body=f.read(), ctype=ctype)

    def _dispatch(self, method):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            if method in ("GET", "HEAD"):
                return self._static(url.path)
            return self._send(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "Method not allowed"})
        parts = [p for p in url.path[len("/api/"):].split("/") if p]
        params = {k: v[-1] for k, v in parse_qs(url.query).items()}
        conn = connect(self.db_path)
        try:
            result, status = self._route(conn, method, parts, params)
            self._send(status, result)
        except ApiError as e:
            self._send(e.status, {"error": e.message})
        except sqlite3.IntegrityError as e:
            self._send(HTTPStatus.BAD_REQUEST, {"error": f"Constraint failed: {e}"})
        except (sqlite3.OperationalError, sqlite3.InterfaceError, sqlite3.ProgrammingError) as e:
            self._send(HTTPStatus.BAD_REQUEST, {"error": str(e)})
        finally:
            conn.close()

    def _route(self, conn, method, parts, params):
        ok = HTTPStatus.OK
        if parts == ["meta"] and method == "GET":
            return table_meta(conn), ok
        if parts == ["effective_stats"] and method == "GET":
            return effective_stats(conn, params), ok
        if len(parts) == 3 and parts[2] == "sheet" and method == "GET":
            row_id = self._id(parts[1])
            if parts[0] == "characters":
                return character_sheet(conn, row_id), ok
            if parts[0] == "items":
                return item_sheet(conn, row_id), ok
        if len(parts) in (1, 2):
            table = parts[0]
            check_table(table)
            if len(parts) == 1:
                if method == "GET":
                    return list_rows(conn, table, params), ok
                if method == "POST":
                    return insert_row(conn, table, self._body()), HTTPStatus.CREATED
            else:
                row_id = self._id(parts[1])
                if method == "GET":
                    return get_row(conn, table, row_id), ok
                if method in ("PUT", "PATCH"):
                    return update_row(conn, table, row_id, self._body()), ok
                if method == "DELETE":
                    return delete_row(conn, table, row_id), ok
        raise ApiError(HTTPStatus.NOT_FOUND, "No such endpoint")

    @staticmethod
    def _id(s):
        if not s.isdigit():
            raise ApiError(HTTPStatus.BAD_REQUEST, f"Bad id '{s}'")
        return int(s)

    def do_GET(self): self._dispatch("GET")
    def do_HEAD(self): self._dispatch("HEAD")
    def do_POST(self): self._dispatch("POST")
    def do_PUT(self): self._dispatch("PUT")
    def do_PATCH(self): self._dispatch("PATCH")
    def do_DELETE(self): self._dispatch("DELETE")


def make_server(db_path, host="127.0.0.1", port=8000):
    handler = type("BoundHandler", (Handler,), {"db_path": db_path})
    return ThreadingHTTPServer((host, port), handler)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--init", action="store_true", help="create/upgrade schema and exit")
    ap.add_argument("--seed", action="store_true", help="load db/seed.sql if there are no characters yet")
    ap.add_argument("--reset", action="store_true", help="delete the DB file first (destroys data!)")
    a = ap.parse_args(argv)

    if a.reset and os.path.exists(a.db):
        os.remove(a.db)
        print(f"Deleted {a.db}")
    init_db(a.db, seed=a.seed)
    if a.init:
        print(f"Schema applied to {a.db}")
        return
    srv = make_server(a.db, a.host, a.port)
    print(f"Lightwielder DB UI on http://{a.host}:{srv.server_address[1]}  (db: {a.db})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    sys.exit(main())
