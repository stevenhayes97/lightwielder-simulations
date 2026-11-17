"""End-to-end API tests: run with `python -m unittest discover tests`."""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app"))
os.environ["LW_QUIET"] = "1"
import server  # noqa: E402


class ApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.db = os.path.join(cls.tmp.name, "test.db")
        server.init_db(cls.db)
        cls.srv = server.make_server(cls.db, "127.0.0.1", 0)
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.tmp.cleanup()

    def call(self, method, path, body=None, expect=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(req) as r:
                status, payload = r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            status, payload = e.code, json.loads(e.read() or b"null")
        if expect is not None:
            self.assertEqual(status, expect, payload)
        return payload

    def post(self, table, body):
        return self.call("POST", f"/api/{table}", body, expect=201)

    # ------------------------------------------------------------------
    def test_meta_describes_schema(self):
        meta = self.call("GET", "/api/meta", expect=200)
        self.assertEqual(set(meta), set(server.TABLES))
        cols = {c["name"]: c for c in meta["characters"]["columns"]}
        self.assertIn("dead", cols["status"]["options"])
        eq = {c["name"]: c for c in meta["character_equipment"]["columns"]}
        self.assertTrue(eq["equipped"]["boolean"])
        self.assertEqual(eq["item_id"]["fk"]["table"], "items")
        stats = {c["name"] for c in meta["character_stats"]["columns"]}
        self.assertTrue({"hp", "strength", "intelligence", "stamina"} <= stats)

    def test_crud_roundtrip(self):
        c = self.post("characters", {"name": "Crud Test", "class": "Ranger"})
        self.assertEqual(c["status"], "alive")
        u = self.call("PUT", f"/api/characters/{c['id']}", {"class": "Knight", "epithet": ""}, expect=200)
        self.assertEqual(u["class"], "Knight")
        self.assertIsNone(u["epithet"])
        found = self.call("GET", "/api/characters?q=crud", expect=200)
        self.assertIn(c["id"], [r["id"] for r in found])
        self.call("DELETE", f"/api/characters/{c['id']}", expect=200)
        self.call("GET", f"/api/characters/{c['id']}", expect=404)

    def test_constraint_errors_are_400(self):
        self.call("POST", "/api/characters", {"name": "X", "status": "zombie"}, expect=400)
        self.call("POST", "/api/characters", {"class": "no name"}, expect=400)
        self.call("POST", "/api/character_stats", {"character_id": 99999, "story_point_id": 99999}, expect=400)
        self.call("POST", "/api/characters", {"name": "X", "bogus": 1}, expect=400)
        self.call("GET", "/api/nope", expect=404)
        self.call("GET", "/api/characters?order=evil;drop", expect=400)

    def test_story_point_in_use_cannot_be_deleted_and_cascade(self):
        sp = self.post("story_points", {"sequence": 500, "label": "Locked"})
        c = self.post("characters", {"name": "Cascade"})
        st = self.post("character_stats", {"character_id": c["id"], "story_point_id": sp["id"]})
        self.call("POST", "/api/character_stats", {"character_id": c["id"], "story_point_id": sp["id"]}, expect=400)  # UNIQUE
        self.call("DELETE", f"/api/story_points/{sp['id']}", expect=400)
        self.call("DELETE", f"/api/characters/{c['id']}", expect=200)
        self.call("GET", f"/api/character_stats/{st['id']}", expect=404)
        self.call("DELETE", f"/api/story_points/{sp['id']}", expect=200)

    def test_effective_stats_math(self):
        p1 = self.post("story_points", {"sequence": 1010, "label": "E1"})
        p2 = self.post("story_points", {"sequence": 1020, "label": "E2"})
        p3 = self.post("story_points", {"sequence": 1030, "label": "E3"})
        c = self.post("characters", {"name": "Math"})
        self.post("character_stats", {"character_id": c["id"], "story_point_id": p1["id"],
                                      "hp": 100, "strength": 10, "intelligence": 8, "stamina": 12})
        axe = self.post("items", {"name": "Axe", "category": "weapon", "armor_rating": 0})
        plate = self.post("items", {"name": "Plate", "category": "armor", "armor_rating": 6})
        self.post("item_modifiers", {"item_id": axe["id"], "stat": "strength", "amount": 3})
        self.post("item_modifiers", {"item_id": axe["id"], "stat": "strength", "amount": 50, "condition": "vs undead"})
        self.post("item_modifiers", {"item_id": plate["id"], "stat": "hp", "mod_type": "percent", "amount": 10})
        self.post("item_modifiers", {"item_id": plate["id"], "stat": "stamina", "amount": -2})
        # axe held from E2 onward; plate only during E2 (lost at E3); a stashed axe doesn't count
        self.post("character_equipment", {"character_id": c["id"], "item_id": axe["id"], "from_story_point_id": p2["id"]})
        self.post("character_equipment", {"character_id": c["id"], "item_id": plate["id"],
                                          "from_story_point_id": p2["id"], "until_story_point_id": p3["id"]})
        self.post("character_equipment", {"character_id": c["id"], "item_id": axe["id"],
                                          "from_story_point_id": p1["id"], "equipped": 0})

        sheet = self.call("GET", f"/api/characters/{c['id']}/sheet", expect=200)
        eff = {e["story_point"]: e for e in sheet["effective"]}
        self.assertTrue({"E1", "E2", "E3"} <= set(eff))
        self.assertEqual((eff["E1"]["strength"], eff["E1"]["hp"], eff["E1"]["armor"]), (10, 100, 0))
        self.assertEqual((eff["E2"]["strength"], eff["E2"]["hp"], eff["E2"]["stamina"], eff["E2"]["armor"]), (13, 110, 10, 6))
        self.assertEqual((eff["E3"]["strength"], eff["E3"]["hp"], eff["E3"]["stamina"], eff["E3"]["armor"]), (13, 100, 12, 0))
        self.assertEqual(eff["E1"]["is_snapshot"], 1)
        self.assertEqual(eff["E3"]["is_snapshot"], 0)  # base carried forward from E1
        self.assertEqual(len(sheet["equipment"]), 3)

        isheet = self.call("GET", f"/api/items/{axe['id']}/sheet", expect=200)
        self.assertEqual(len(isheet["modifiers"]), 2)
        self.assertEqual(len(isheet["holders"]), 2)

    def test_simulate_loadouts_and_effects(self):
        p1 = self.post("story_points", {"sequence": 2010, "label": "S1"})
        p2 = self.post("story_points", {"sequence": 2020, "label": "S2"})
        c = self.post("characters", {"name": "Sim"})
        self.post("character_stats", {"character_id": c["id"], "story_point_id": p1["id"],
                                      "hp": 50, "strength": 10, "intelligence": 10, "stamina": 20})
        mace = self.post("items", {"name": "Mace", "category": "weapon", "slot": "main_hand", "req_strength": 9})
        greatsword = self.post("items", {"name": "Greatsword", "category": "weapon", "slot": "two_hand", "req_strength": 14})
        mail = self.post("items", {"name": "Mail", "category": "armor", "slot": "chest", "armor_rating": 5})
        self.post("item_modifiers", {"item_id": mace["id"], "stat": "strength", "amount": 1})
        self.post("item_modifiers", {"item_id": mace["id"], "stat": "damage", "amount": 9, "condition": "vs constructs"})
        self.post("item_modifiers", {"item_id": greatsword["id"], "stat": "damage", "amount": 4})
        self.post("item_modifiers", {"item_id": mail["id"], "stat": "stamina", "mod_type": "percent", "amount": -10})

        mine = self.post("loadouts", {"name": "Mace & Mail", "character_id": c["id"]})
        self.post("loadout_items", {"loadout_id": mine["id"], "item_id": mace["id"]})
        self.post("loadout_items", {"loadout_id": mine["id"], "item_id": mail["id"]})
        gen = self.post("loadouts", {"name": "Generic Greatsword"})  # no character = generic
        self.assertIsNone(gen["character_id"])
        self.post("loadout_items", {"loadout_id": gen["id"], "item_id": greatsword["id"]})
        self.post("loadout_items", {"loadout_id": gen["id"], "item_id": mace["id"]})  # slot clash with two-hander
        self.post("loadout_items", {"loadout_id": gen["id"], "item_id": mail["id"], "equipped": 0})  # carried: no effect

        injured = self.post("effects", {"name": "Injured", "kind": "debuff"})
        self.post("effect_modifiers", {"effect_id": injured["id"], "stat": "strength", "amount": -3})
        tired = self.post("effects", {"name": "Tired", "kind": "debuff"})
        self.post("effect_modifiers", {"effect_id": tired["id"], "stat": "stamina", "mod_type": "percent", "amount": -40})
        self.call("POST", "/api/effects", {"name": "Bad", "kind": "curse"}, expect=400)

        # story gear: mail from S2 on
        self.post("character_equipment", {"character_id": c["id"], "item_id": mail["id"], "from_story_point_id": p2["id"]})

        q = (f"/api/simulate?character_id={c['id']}&story_point_id={p2['id']}"
             f"&loadouts={mine['id']},{gen['id']}&effects={injured['id']},{tired['id']}&current=1&bare=1")
        sim = self.call("GET", q, expect=200)
        self.assertEqual(sim["base"]["story_point_id"], p1["id"])  # carried forward
        cols = {c_["label"]: c_ for c_ in sim["columns"]}
        self.assertEqual(list(cols), ["No gear", "Story gear @ S2", "Mace & Mail", "Generic Greatsword"])
        bare, story, mm, gs = (cols[k]["stats"] for k in cols)
        self.assertEqual((bare["strength"], bare["stamina"]), (7, 12))          # 10-3 ; 20*(1-0.4)
        self.assertEqual((story["stamina"], story["armor"]), (10, 5))           # 20*(1-0.5)
        self.assertEqual((mm["strength"], mm["stamina"], mm["armor"]), (8, 10, 5))
        self.assertEqual((gs["damage"], gs["armor"], gs["strength"]), (4, 0, 8))
        self.assertEqual([s["condition"] for s in cols["Mace & Mail"]["situational"]], ["vs constructs"])
        warns = " | ".join(cols["Generic Greatsword"]["warnings"])
        self.assertIn("Greatsword needs 14 STR", warns)
        self.assertIn("Two-handed", warns)
        # the injury (-3 STR) drops strength below the mace's requirement
        self.assertEqual(cols["Mace & Mail"]["warnings"], ["Mace needs 9 STR (has 8)"])

        # with no effects, story-gear column must agree with the SQL view
        sim2 = self.call("GET", f"/api/simulate?character_id={c['id']}&story_point_id={p2['id']}&current=1", expect=200)
        view = [r for r in self.call("GET", f"/api/effective_stats?character_id={c['id']}") if r["story_point_id"] == p2["id"]][0]
        for s in server.BASE_STATS + server.GEAR_STATS:
            self.assertEqual(sim2["columns"][0]["stats"][s], view[s], s)

        self.call("GET", "/api/simulate", expect=400)
        lsheet = self.call("GET", f"/api/loadouts/{gen['id']}/sheet", expect=200)
        self.assertEqual(len(lsheet["items"]), 3)
        esheet = self.call("GET", f"/api/effects/{tired['id']}/sheet", expect=200)
        self.assertEqual(esheet["modifiers"][0]["amount"], -40)
        # deleting a character removes its personal loadouts but not generic ones
        self.call("DELETE", f"/api/characters/{c['id']}", expect=200)
        self.call("GET", f"/api/loadouts/{mine['id']}", expect=404)
        self.call("GET", f"/api/loadouts/{gen['id']}", expect=200)

    def test_sql_round_matches_sqlite(self):
        conn = server.connect(":memory:")
        for x in (2.5, 3.5, -2.5, 0.5, 30.8, -0.49, 12.5):
            self.assertEqual(server.sql_round(x), conn.execute("SELECT CAST(ROUND(?) AS INTEGER)", (x,)).fetchone()[0], x)

    def test_static_ui_served(self):
        with urllib.request.urlopen(self.base + "/") as r:
            self.assertIn(b"Lightwielder", r.read())
        self.call("GET", "/../server.py", expect=404)


class SeedTest(unittest.TestCase):
    def test_seed_loads(self):
        with tempfile.TemporaryDirectory() as d:
            db = os.path.join(d, "s.db")
            server.init_db(db, seed=True)
            server.init_db(db, seed=True)  # idempotent: no duplicate insert errors
            conn = server.connect(db)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM characters").fetchone()[0], 3)
            hero = conn.execute("SELECT hp, strength FROM v_effective_stats WHERE character_id=1 AND story_point_id=2").fetchone()
            self.assertEqual(tuple(hero), (31, 15))
            conn.close()


if __name__ == "__main__":
    unittest.main()
