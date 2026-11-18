# Lightwielder Simulations

Character roster, versioned stats and gear databases for the Lightwielder story/simulation project.
It's a single SQLite file with a lightweight web UI for create/read/update/delete.

Requires **Python 3.9+** and nothing else: no packages, no build step.

```bash
python app/server.py            # open http://127.0.0.1:8000
```

| Flag | What it does |
|---|---|
| `--seed` | Load the placeholder sample data in `db/seed.sql` if there are no characters yet |
| `--reset` | **Delete** the DB file first (use with `--seed` for a fresh sample) |
| `--init` | Apply the schema and exit (no server) |
| `--db PATH` | Use a different DB file (default `data/lightwielder.db`) |
| `--host`, `--port` | Bind address (default `127.0.0.1:8000`; use `--host 0.0.0.0` to reach it from other devices) |

The database lives at `data/lightwielder.db` and **is committed to git**, so your data travels with the repo.
Commit after editing to keep it. The DB uses journal mode `DELETE`, so that one file holds everything.

## Data model

```
factions ──< character_affiliations >── characters
story_points ──┬──< character_stats >── characters ──< character_equipment >── items ──< item_modifiers
               └────────────── (from / until) ───────────────┘
```

| Table | What it holds |
|---|---|
| `story_points` | The timeline: `sequence` orders it (leave gaps like 10, 20, 30 so you can insert points later), `label`, `arc`, `years_elapsed` (in-world years since the story began; drives ages). |
| `characters` | Identity that doesn't change: name, `suffix` (*IV*, *Jr.*), `nickname`, **class**, subclass, race, appearance (`height`, `build`, `hair`, `eyes`), `personality`, `goals`, alignment, role, status, `age_at_start`, bio, notes. |
| `factions` | Kingdoms, orders, guilds, cults…: name, kind, description. |
| `character_affiliations` | **Versioned rank & faction**: one row per character per story point, like stat versions. `faction` (blank = unaffiliated), `rank`, optional `secret_faction` (true loyalty of a spy or a traitor not yet revealed), `change_reason`. |
| `character_titles` | **Versioned title / epithet** (*the Great*, *Greycloak*): one row per character per story point, carried forward until the next. No row yet = no title; a blank `title` = lost or stripped from that point. `change_reason`. |
| `skills` | Skill catalogue: swordsmanship, history, a language, calling the Light…: name, category, description. |
| `character_skills` | **Versioned skill levels**: one row per character per skill per story point, carried forward. `level`: untrained, novice, skilled, adept, expert, master, legendary. |
| `character_stats` | **Versioned base stats**: one row per character per story point. `hp`, `strength`, `intelligence`, `stamina`, plus `change_reason`. |
| `items` | Gear catalogue: category, slot, `layer` (under / main / over), rarity, damage + type, armor rating, weight, value, strength requirement, description, lore. |
| `item_modifiers` | Buffs/debuffs per item: target stat, `flat` or `percent`, amount (negative = debuff), optional `condition`. |
| `character_equipment` | Who holds what **over a span of the story**: `from_story_point` up to (not including) `until_story_point`; blank = still held. `equipped` = 0 means carried or stashed, with no effect on stats. |
| `loadouts` | Pre-built gear sets for "what if" comparisons. Set `character` for a personal loadout, or leave it blank for a **generic** loadout anyone can use. They don't change the story timeline. |
| `loadout_items` | Items in a loadout (`equipped` 0 = carried in the pack). |
| `effects` | **Generic buffs/debuffs**: injury, exhaustion, blessings… `kind` (buff/debuff/mixed), `category`, `severity`. |
| `effect_modifiers` | The stat changes an effect applies, in the same shape as item modifiers. |
| `character_effects` | **Effects on the story timeline**: e.g. *Injured* from Ch. 7 until (not including) Ch. 9, with a `cause`. Blank `until` = ongoing. Same span rule as equipment. |

### Class vs rank vs faction
**Class** (e.g. *Swordsman*) is who the character is, so it stays on `characters`. **Rank** and **faction** change with the story,
so they're versioned in `character_affiliations`. A version carries forward until the next one, so record one only where
something changes: *Squire → Knight* in Ch. 5, *secretly turned by the cult* in Ch. 5 (public faction unchanged,
`secret_faction` set), *openly defects* in Ch. 12 (new faction and rank). The `v_character_affiliations` view gives the rank and faction in effect for every character at every story point:

```sql
SELECT character_name, rank, faction, secret_faction
FROM v_character_affiliations WHERE story_point = 'Chapter 5';
```

A **title** works the same way, in `character_titles`: a character can start the story without one, earn one in Ch. 5 and lose it in Ch. 12
(a version with a blank title). `v_character_titles` gives the title in effect at every story point.

### Armor layers
Each slot holds one item **per layer**: `under` (mail, padding), `main` (the default; blank means main) and `over`
(surcoat, tabard). Mail hauberk (chest, under) + breastplate (chest, main) + surcoat (chest, over) is a valid set; two
`main` chest pieces still warn in the Loadout Lab. Every layer adds its armor rating and modifiers.

### Skills
`character_skills` works like stat versions, but per skill: record a level where it changes (*Calling the Light*:
untrained in Ch. I, novice in Ch. 9). `v_character_skills` gives every skill's level at every story point; the character
sheet shows the levels at the selected point and the history.

### Ages follow the story (`v_character_ages` view)
Each character stores `age_at_start` once, and each story point can set `years_elapsed`: in-world years since the story began.
`age = age_at_start + years_elapsed`, rounded down, for every character at every point. A blank `years_elapsed` carries forward
from the previous point, so set it only where time passes: a one-year time skip is one edit, and every character ages together.
Negative values work for flashbacks; the age is blank before a character is born.

Older DBs are upgraded automatically on start: `characters.age` is renamed `age_at_start` and `story_points.years_elapsed` is added; `suffix` and `nickname` are added; a fixed `characters.title` (or older `epithet`) becomes a first
`character_titles` version at the character's first stat version, and the column is dropped; and a free-text `characters.faction` is migrated: each value becomes a faction and a
first affiliation version at the character's first stat version, and the old column is dropped.

### Effective stats (`v_effective_stats` view)
For every character at every story point from their first stat version onward:

- **Base** stats come from the most recent stat version at or before that point, so they carry forward until you record a change.
- **Gear** is every *equipped* item whose span covers that point.
- **Effects** are every `character_effects` span covering that point (injuries, exhaustion, blessings…).
- `effective = round((base + Σ flat) × (1 + Σ percent / 100))`, summed over gear and effects (gear flat amounts × quantity)
- Gear-only stats (`armor`, `attack`, `damage`, `speed`, `resistance`) start at 0. Armor also adds each item's `armor_rating`.
- Modifiers with a `condition` (e.g. "vs undead") are situational and **not** added to totals.

The view is plain SQL, so the same numbers are available to any SQLite tool:

```sql
SELECT character_name, story_point, hp, strength, intelligence, stamina, armor
FROM v_effective_stats WHERE story_point = 'Chapter 5';
```

## UI
- **Table views** for every table: search, filters on related records, sortable columns, click a row to edit, **+ New** to create. Forms are built from the live schema, with dropdowns for related records and fixed choice lists.
- **Character sheet** (Characters → *Sheet →*): stat cards at any story point with a base / gear / effects breakdown, gear and effects active at that point,
  **+ Apply effect** to put a buff or debuff on the timeline, effect history, a progression table with ▲▼ changes, equipment history, and quick **+ Stat version** (copies the latest numbers) and **+ Give item**.
- The character sheet shows the **title** in effect at the selected story point and a **title history** (**+ Title version**).
- The character sheet also shows **rank & faction** at the selected story point (including a secret loyalty) and a
  **rank & faction history**. **+ Rank / faction version** copies the latest values so you only change what moved.
- **Faction sheet** (Factions → *Sheet →*): members at any story point (open members, secret members, and traitors inside the faction)
  and a timeline of joins, rank changes, secret turns, reveals and departures.
- **Item sheet**: details, modifiers (add/edit inline), and who held it when.
- **Effective Stats**: all characters side by side, filterable by story point.
- **⚖ Loadout Lab**: pick a character and story point, tick any mix of their loadouts, generic loadouts,
  "story gear at this point" and "no gear", then stack effects (e.g. *Injured* + *Exhausted*).
  **Story effects at this point** (on by default) automatically applies whatever the character is suffering
  at that point in the story. Those effects show as locked "from story" chips, and they're never counted twice if you also tick them. You get a
  side-by-side table with the best value per row in bold and the change from innate stats; hover a value for its breakdown.
  Each column also lists **warnings** (strength requirement not met, two items in one slot, two-hander plus a shield) and
  situational bonuses. Your selections are remembered in the browser.
- Loadout pages can **duplicate** a loadout. A character sheet can **save the gear at the selected story point as a new loadout**.

Lab formula (the same as the view, plus effects):
`round((base + gear flat + effect flat) × (1 + (gear % + effect %) / 100))`. Percentages add together; they don't multiply.

## Changing the schema
The schema in `db/schema.sql` is applied on every start. New tables and indexes are created, and the view is rebuilt.
`CREATE TABLE IF NOT EXISTS` won't alter a table that already exists, so to **add a column** to an existing table either:
- run `ALTER TABLE ... ADD COLUMN ...` on the DB and add the same column to `schema.sql`, or
- if you only have sample data: `python app/server.py --reset --seed`.

The UI picks up new columns automatically. To **add a new stat**, add the column to `character_stats`,
add its name to the `item_modifiers.stat` and `effect_modifiers.stat` CHECK lists, add a line in
`v_effective_stats`, and add it to `BASE_STATS` in `app/server.py` and to `BASE_STATS` / `STAT_LABEL` at the top of `app/static/app.js`.

## API
JSON over HTTP, for scripts and future simulation code:

| | |
|---|---|
| `GET /api/meta` | Tables, columns, foreign keys, enum options |
| `GET /api/<table>?col=val&q=text&order=col&dir=desc` | List / filter / search |
| `GET/PUT/DELETE /api/<table>/<id>`, `POST /api/<table>` | CRUD |
| `GET /api/characters/<id>/sheet` | Character + stat versions + equipment + effective stats |
| `GET /api/items/<id>/sheet` | Item + modifiers + holders |
| `GET /api/effective_stats?character_id=` | The effective stats view |
| `GET /api/affiliations?character_id=&story_point_id=&faction_id=` | Rank & faction per story point (`faction_id` matches public or secret members) |
| `GET /api/titles?character_id=&story_point_id=` | Title per story point |
| `GET /api/characters/<id>/sheet` → `ages` | Age at every story point |
| `GET /api/factions/<id>/sheet` | Faction + members per point + timeline of events |
| `GET /api/loadouts/<id>/sheet`, `GET /api/effects/<id>/sheet` | Loadout + items; effect + modifiers |
| `GET /api/simulate?character_id=&story_point_id=&loadouts=1,2&effects=3,4&current=1&bare=1&story_effects=1` | Loadout Lab comparison (omit `story_point_id` for latest) |

## Tests
```bash
python -m unittest discover tests
```

## Roadmap ideas
- **Skill modifiers**: let item and effect modifiers target skills, not just stats.
- **TODO: rank hierarchy.** Ranks are free text for now. Possible next step: a per-faction `faction_ranks`
  ladder (name + order) so promotions and demotions show up automatically on sheets and faction timelines.
- **TODO: alignment as free-form text.** `characters.alignment` is a one-line field built for labels like
  *Lawful Good*. Replace it, or add a field next to it, with a free-form description of the character's moral outlook
  (beliefs, lines they won't cross, contradictions), shown as a multi-line box. Consider versioning it per story point,
  like titles, so the outlook can shift with the story.
- **TODO: hit locations and lethal wounds.** HP is deliberately low for humans (about 10 is average), and some hits
  should kill outright, whatever the HP. Possible shape: a `body_zones` table (head, neck, heart, torso, arms, legs…)
  with an `instant_death` flag and a damage multiplier, armor that protects specific zones (via `items.slot`), and
  race-level defaults so races can differ (e.g. humans low HP, others hardier or without a vital zone).
- Abilities/spells, character relationships, CSV import/export.
