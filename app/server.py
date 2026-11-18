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
import math
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
    "character_affiliations": {"title": "Rank & Faction Versions", "label": None},
    "factions": {"title": "Factions", "label": "name"},
    "story_points": {"title": "Story Points", "label": "label"},
    "items": {"title": "Items", "label": "name"},
    "item_modifiers": {"title": "Item Modifiers", "label": None},
    "character_equipment": {"title": "Equipment", "label": None},
    "character_effects": {"title": "Character Effects", "label": None},
    "loadouts": {"title": "Loadouts", "label": "name"},
    "loadout_items": {"title": "Loadout Items", "label": None},
    "effects": {"title": "Effects", "label": "name"},
    "effect_modifiers": {"title": "Effect Modifiers", "label": None},
}

BASE_STATS = ["hp", "strength", "intelligence", "stamina"]
GEAR_STATS = ["armor", "attack", "damage", "speed", "resistance"]
TWO_OF_OK = {"ring"}  # slots where two items don't conflict
DEFAULT_ORDER = {"story_points": "sequence", "factions": "name"}


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
        migrate_character_faction(conn)
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


def migrate_character_faction(conn):
    """Older DBs kept a free-text `faction` on characters. Move each value into
    `factions` + a first `character_affiliations` version (at the character's
    first stat version, else the earliest story point), then drop the column."""
    if "faction" not in columns_of(conn, "characters"):
        return
    first_point = conn.execute("SELECT id FROM story_points ORDER BY sequence LIMIT 1").fetchone()
    pending = conn.execute("SELECT id, faction FROM characters WHERE IFNULL(TRIM(faction), '') <> ''").fetchall()
    for ch in pending:
        sp = conn.execute(
            """SELECT cs.story_point_id FROM character_stats cs JOIN story_points sp ON sp.id = cs.story_point_id
               WHERE cs.character_id = ? ORDER BY sp.sequence LIMIT 1""", (ch["id"],)).fetchone() or first_point
        if sp is None:
            print("Not migrating characters.faction: add a story point first")
            return
        name = ch["faction"].strip()
        conn.execute("INSERT OR IGNORE INTO factions (name) VALUES (?)", (name,))
        fid = conn.execute("SELECT id FROM factions WHERE name = ?", (name,)).fetchone()[0]
        if not conn.execute("SELECT 1 FROM character_affiliations WHERE character_id = ?", (ch["id"],)).fetchone():
            conn.execute("""INSERT INTO character_affiliations (character_id, story_point_id, faction_id, change_reason)
                            VALUES (?, ?, ?, 'Migrated from character faction')""", (ch["id"], sp[0], fid))
    if sqlite3.sqlite_version_info >= (3, 35, 0):
        conn.execute("ALTER TABLE characters DROP COLUMN faction")
        print(f"Moved characters.faction into factions / character_affiliations ({len(pending)} characters)")
    else:
        conn.execute("UPDATE characters SET faction = NULL")
        print("Moved characters.faction into character_affiliations (SQLite < 3.35 can't drop the old column)")


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


AFFIL_SQL = """SELECT ca.*, sp.label AS story_point, sp.sequence, c.name AS character_name,
                 f.name AS faction, sf.name AS secret_faction
          FROM character_affiliations ca
          JOIN story_points sp ON sp.id = ca.story_point_id
          JOIN characters c ON c.id = ca.character_id
          LEFT JOIN factions f  ON f.id  = ca.faction_id
          LEFT JOIN factions sf ON sf.id = ca.secret_faction_id"""


def affiliations(conn, params):
    """Rank & faction per character per story point (v_character_affiliations)."""
    where, args = [], []
    for k in ("character_id", "story_point_id"):
        if params.get(k):
            where.append(f"{k} = ?")
            args.append(params[k])
    if params.get("faction_id"):  # public or secret members
        where.append("(faction_id = ? OR secret_faction_id = ?)")
        args += [params["faction_id"]] * 2
    sql = "SELECT * FROM v_character_affiliations"
    if where:
        sql += " WHERE " + " AND ".join(where)
    return [dict(r) for r in conn.execute(sql + " ORDER BY sequence, character_name", args)]


def faction_sheet(conn, faction_id):
    """Faction + every version that joins, changes rank in, or leaves it.
    `event`: joined, rank, turned traitor, loyal again, secretly joined, went undercover, revealed, left."""
    faction = get_row(conn, "factions", faction_id)
    rows = [dict(r) for r in conn.execute(
        AFFIL_SQL + """ WHERE ca.character_id IN (SELECT character_id FROM character_affiliations
                                                   WHERE faction_id = ? OR secret_faction_id = ?)
           ORDER BY ca.character_id, sp.sequence""", (faction_id, faction_id))]
    history, prev = [], None
    for r in rows:
        if prev and prev["character_id"] != r["character_id"]:
            prev = None
        was_pub = bool(prev) and prev["faction_id"] == faction_id
        was_sec = bool(prev) and prev["secret_faction_id"] == faction_id
        is_pub, is_sec = r["faction_id"] == faction_id, r["secret_faction_id"] == faction_id
        event = None
        if is_pub:
            if was_sec:
                event = "revealed"           # a secret loyalist now openly joins
            elif not was_pub:
                event = "joined"
            elif prev["secret_faction_id"] != r["secret_faction_id"]:
                event = "turned traitor" if r["secret_faction_id"] else "loyal again"
            elif prev["rank"] != r["rank"]:
                event = "rank"
        elif is_sec:
            if was_pub:
                event = "went undercover"    # publicly left, secretly still loyal
            elif not was_sec:
                event = "secretly joined"    # a spy / sleeper for this faction
        elif was_pub or was_sec:
            event = "left"
        if event:
            history.append({**r, "event": event})
        prev = r
    history.sort(key=lambda r: (r["sequence"], r["character_name"]))
    return {"faction": faction, "history": history,
            "members": affiliations(conn, {"faction_id": faction_id})}


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
    effects = [dict(r) for r in conn.execute(
        """SELECT ce.*, e.name AS effect_name, e.kind, e.category, e.severity,
                  f.label AS from_label, f.sequence AS from_sequence,
                  u.label AS until_label, u.sequence AS until_sequence
           FROM character_effects ce
           JOIN effects e ON e.id = ce.effect_id
           JOIN story_points f ON f.id = ce.from_story_point_id
           LEFT JOIN story_points u ON u.id = ce.until_story_point_id
           WHERE ce.character_id = ? ORDER BY f.sequence, e.name""", (char_id,))]
    affil = [dict(r) for r in conn.execute(AFFIL_SQL + " WHERE ca.character_id = ? ORDER BY sp.sequence", (char_id,))]
    return {"character": character, "stats": stats, "equipment": equipment, "effects": effects,
            "affiliations": affil, "effective": effective_stats(conn, {"character_id": char_id})}


def active_effect_rows(conn, char_id, sequence):
    return conn.execute(
        """SELECT ce.* FROM character_effects ce
           JOIN story_points f ON f.id = ce.from_story_point_id
           LEFT JOIN story_points u ON u.id = ce.until_story_point_id
           WHERE ce.character_id = ? AND f.sequence <= ? AND (u.id IS NULL OR u.sequence > ?)
           ORDER BY f.sequence, ce.id""", (char_id, sequence, sequence)).fetchall()


def item_sheet(conn, item_id):
    item = get_row(conn, "items", item_id)
    modifiers = list_rows(conn, "item_modifiers", {"item_id": str(item_id)})
    holders = [dict(r) for r in conn.execute(
        """SELECT ce.*, c.name AS character_name, f.label AS from_label, u.label AS until_label
           FROM character_equipment ce JOIN characters c ON c.id = ce.character_id
           JOIN story_points f ON f.id = ce.from_story_point_id
           LEFT JOIN story_points u ON u.id = ce.until_story_point_id
           WHERE ce.item_id = ? ORDER BY f.sequence""", (item_id,))]
    loadouts = [dict(r) for r in conn.execute(
        """SELECT DISTINCT l.id, l.name, l.character_id, c.name AS character_name, li.equipped
           FROM loadout_items li JOIN loadouts l ON l.id = li.loadout_id
           LEFT JOIN characters c ON c.id = l.character_id
           WHERE li.item_id = ? ORDER BY l.name""", (item_id,))]
    return {"item": item, "modifiers": modifiers, "holders": holders, "loadouts": loadouts}


def loadout_sheet(conn, loadout_id):
    loadout = get_row(conn, "loadouts", loadout_id)
    items = [dict(r) for r in conn.execute(
        """SELECT li.*, i.name AS item_name, i.category, i.slot, i.rarity, i.armor_rating, i.req_strength
           FROM loadout_items li JOIN items i ON i.id = li.item_id
           WHERE li.loadout_id = ? ORDER BY li.equipped DESC, i.category, i.name""", (loadout_id,))]
    return {"loadout": loadout, "items": items}


def effect_sheet(conn, effect_id):
    sufferers = [dict(r) for r in conn.execute(
        """SELECT ce.*, c.name AS character_name, f.label AS from_label, u.label AS until_label
           FROM character_effects ce JOIN characters c ON c.id = ce.character_id
           JOIN story_points f ON f.id = ce.from_story_point_id
           LEFT JOIN story_points u ON u.id = ce.until_story_point_id
           WHERE ce.effect_id = ? ORDER BY f.sequence, c.name""", (effect_id,))]
    return {"effect": get_row(conn, "effects", effect_id),
            "modifiers": list_rows(conn, "effect_modifiers", {"effect_id": str(effect_id)}),
            "characters": sufferers}


# ------------------------------------------------------------------ simulation

def sql_round(x):
    """Match SQLite ROUND(): half away from zero (Python's round() is banker's)."""
    return int(math.floor(abs(x) + 0.5)) * (1 if x >= 0 else -1)


def _ids(s):
    return [int(x) for x in (s or "").split(",") if x.strip().isdigit()]


def _gear_for(conn, rows):
    """rows: [{item_id, quantity, equipped}] -> enrich with item info + modifiers."""
    out = []
    for r in rows:
        item = conn.execute("SELECT * FROM items WHERE id = ?", (r["item_id"],)).fetchone()
        if item is None:
            continue
        mods = [dict(m) for m in conn.execute("SELECT * FROM item_modifiers WHERE item_id = ?", (r["item_id"],))]
        out.append({"item_id": item["id"], "name": item["name"], "category": item["category"],
                    "slot": item["slot"], "armor_rating": item["armor_rating"] or 0,
                    "req_strength": item["req_strength"], "quantity": r["quantity"] or 1,
                    "equipped": r["equipped"], "modifiers": mods})
    return out


def compute_stats(base, gear, effects):
    """Same formula as v_effective_stats, plus generic effects:
    stat = round((base + gear_flat + effect_flat) * (1 + (gear_pct + effect_pct) / 100))"""
    parts = {s: {"base": base.get(s, 0) if s in BASE_STATS else 0,
                 "gear_flat": 0.0, "gear_pct": 0.0, "effect_flat": 0.0, "effect_pct": 0.0}
             for s in BASE_STATS + GEAR_STATS}
    situational = []
    for g in gear:
        if not g["equipped"]:
            continue
        parts["armor"]["base"] += g["armor_rating"] * g["quantity"]
        for m in g["modifiers"]:
            if m["condition"]:
                situational.append({"source": g["name"], **_mod_view(m)})
            elif m["mod_type"] == "flat":
                parts[m["stat"]]["gear_flat"] += m["amount"] * g["quantity"]
            else:
                parts[m["stat"]]["gear_pct"] += m["amount"]
    for e in effects:
        for m in e["modifiers"]:
            if m["condition"]:
                situational.append({"source": e["name"], **_mod_view(m)})
            elif m["mod_type"] == "flat":
                parts[m["stat"]]["effect_flat"] += m["amount"]
            else:
                parts[m["stat"]]["effect_pct"] += m["amount"]
    stats = {}
    for s, p in parts.items():
        flat = p["base"] + p["gear_flat"] + p["effect_flat"]
        stats[s] = sql_round(flat * (1 + (p["gear_pct"] + p["effect_pct"]) / 100.0))
    return stats, parts, situational


def _mod_view(m):
    return {"stat": m["stat"], "mod_type": m["mod_type"], "amount": m["amount"], "condition": m["condition"]}


def _warnings(gear, strength):
    warns, slots = [], {}
    for g in gear:
        if not g["equipped"]:
            continue
        if g["req_strength"] and strength < g["req_strength"]:
            warns.append(f"{g['name']} needs {g['req_strength']} STR (has {strength})")
        if g["slot"] and g["slot"] != "none":
            slots.setdefault(g["slot"], []).append(g["name"])
    for slot, names in slots.items():
        limit = 2 if slot in TWO_OF_OK else 1
        if len(names) > limit:
            warns.append(f"Slot '{slot}' holds {len(names)} items: {', '.join(names)}")
    hands = sum(len(slots.get(s, [])) for s in ("main_hand", "off_hand"))
    if slots.get("two_hand") and hands:
        warns.append("Two-handed item equipped alongside a one-handed/off-hand item")
    return warns


def simulate(conn, params):
    """Compare loadouts for one character at one story point, with generic effects applied.
    Params: character_id, story_point_id (optional: latest), loadouts=1,2, effects=3,4,
    current=1 to include the gear held at that story point, bare=1 for a no-gear column,
    story_effects=1 to also apply the character_effects active at that story point."""
    if not params.get("character_id", "").isdigit():
        raise ApiError(HTTPStatus.BAD_REQUEST, "character_id is required")
    char = get_row(conn, "characters", int(params["character_id"]))
    sp_param = params.get("story_point_id", "")
    if sp_param.isdigit():
        sp = get_row(conn, "story_points", int(sp_param))
    else:
        sp = conn.execute(
            """SELECT sp.* FROM character_stats cs JOIN story_points sp ON sp.id = cs.story_point_id
               WHERE cs.character_id = ? ORDER BY sp.sequence DESC LIMIT 1""", (char["id"],)).fetchone()
        if sp is None:
            raise ApiError(HTTPStatus.BAD_REQUEST, f"{char['name']} has no stat versions yet")
        sp = dict(sp)
    base_row = conn.execute(
        """SELECT cs.*, sp.label AS story_point FROM character_stats cs
           JOIN story_points sp ON sp.id = cs.story_point_id
           WHERE cs.character_id = ? AND sp.sequence <= ? ORDER BY sp.sequence DESC LIMIT 1""",
        (char["id"], sp["sequence"])).fetchone()
    if base_row is None:
        raise ApiError(HTTPStatus.BAD_REQUEST, f"{char['name']} has no stat version at or before '{sp['label']}'")
    base = dict(base_row)

    def load_effect(eid, source, **extra):
        e = get_row(conn, "effects", eid)
        e["modifiers"] = [dict(m) for m in conn.execute("SELECT * FROM effect_modifiers WHERE effect_id = ?", (eid,))]
        e.update(source=source, **extra)
        return e

    effects = []
    if params.get("story_effects") == "1":
        # every span covering this point counts (two overlapping spans = applied twice, like the view)
        for r in active_effect_rows(conn, char["id"], sp["sequence"]):
            effects.append(load_effect(r["effect_id"], "story", cause=r["cause"], character_effect_id=r["id"]))
    from_story = {e["id"] for e in effects}
    for eid in _ids(params.get("effects")):
        if eid not in from_story:  # already applied by the story; don't double count
            effects.append(load_effect(eid, "manual"))

    columns = []
    if params.get("bare") == "1":
        columns.append({"key": "bare", "label": "No gear", "gear": []})
    if params.get("current") == "1":
        rows = conn.execute(
            """SELECT ce.item_id, ce.quantity, ce.equipped FROM character_equipment ce
               JOIN story_points f ON f.id = ce.from_story_point_id
               LEFT JOIN story_points u ON u.id = ce.until_story_point_id
               WHERE ce.character_id = ? AND f.sequence <= ? AND (u.id IS NULL OR u.sequence > ?)""",
            (char["id"], sp["sequence"], sp["sequence"])).fetchall()
        columns.append({"key": "current", "label": f"Story gear @ {sp['label']}", "gear": _gear_for(conn, rows)})
    for lid in _ids(params.get("loadouts")):
        lo = get_row(conn, "loadouts", lid)
        rows = conn.execute("SELECT item_id, quantity, equipped FROM loadout_items WHERE loadout_id = ?", (lid,)).fetchall()
        columns.append({"key": f"loadout:{lid}", "label": lo["name"], "loadout_id": lid,
                        "generic": lo["character_id"] is None, "gear": _gear_for(conn, rows)})

    for col in columns:
        stats, parts, situational = compute_stats(base, col["gear"], effects)
        col.update(stats=stats, parts=parts, situational=situational,
                   warnings=_warnings(col["gear"], stats["strength"]))
    return {"character": char, "story_point": sp, "base": base,
            "effects": effects, "columns": columns}


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
        if parts == ["affiliations"] and method == "GET":
            return affiliations(conn, params), ok
        if parts == ["simulate"] and method == "GET":
            return simulate(conn, params), ok
        if len(parts) == 3 and parts[2] == "sheet" and method == "GET":
            row_id = self._id(parts[1])
            sheets = {"characters": character_sheet, "items": item_sheet,
                      "loadouts": loadout_sheet, "effects": effect_sheet,
                      "factions": faction_sheet}
            if parts[0] in sheets:
                return sheets[parts[0]](conn, row_id), ok
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
