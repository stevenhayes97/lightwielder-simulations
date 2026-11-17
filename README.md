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
story_points ──┬──< character_stats >── characters ──< character_equipment >── items ──< item_modifiers
               └────────────── (from / until) ───────────────┘
```

| Table | What it holds |
|---|---|
| `story_points` | The timeline: `sequence` orders it (leave gaps like 10, 20, 30 so you can insert points later), `label`, `arc`. |
| `characters` | Identity: name, epithet, class, subclass, race, faction, alignment, role, status, age, bio, notes. |
| `character_stats` | **Versioned base stats**: one row per character per story point. `hp`, `strength`, `intelligence`, `stamina`, plus `change_reason`. |
| `items` | Gear catalogue: category, slot, rarity, damage + type, armor rating, weight, value, strength requirement, description, lore. |
| `item_modifiers` | Buffs/debuffs per item: target stat, `flat` or `percent`, amount (negative = debuff), optional `condition`. |
| `character_equipment` | Who holds what **over a span of the story**: `from_story_point` up to (not including) `until_story_point`; blank = still held. `equipped` = 0 means carried or stashed, with no effect on stats. |

### Effective stats (`v_effective_stats` view)
For every character at every story point from their first stat version onward:

- **Base** stats come from the most recent stat version at or before that point, so they carry forward until you record a change.
- **Gear** is every *equipped* item whose span covers that point.
- `effective = round((base + Σ flat × quantity) × (1 + Σ percent / 100))`
- Gear-only stats (`armor`, `attack`, `damage`, `speed`, `resistance`) start at 0. Armor also adds each item's `armor_rating`.
- Modifiers with a `condition` (e.g. "vs undead") are situational and **not** added to totals.

The view is plain SQL, so the same numbers are available to any SQLite tool:

```sql
SELECT character_name, story_point, hp, strength, intelligence, stamina, armor
FROM v_effective_stats WHERE story_point = 'Chapter 5';
```

## UI
- **Table views** for every table: search, filters on related records, sortable columns, click a row to edit, **+ New** to create. Forms are built from the live schema, with dropdowns for related records and fixed choice lists.
- **Character sheet** (Characters → *Sheet →*): stat cards at any story point (base + gear), gear held at that point, a progression table with ▲▼ changes, equipment history, and quick **+ Stat version** (copies the latest numbers) and **+ Give item**.
- **Item sheet**: details, modifiers (add/edit inline), and who held it when.
- **Effective Stats**: all characters side by side, filterable by story point.

## Changing the schema
The schema in `db/schema.sql` is applied on every start. New tables and indexes are created, and the view is rebuilt.
`CREATE TABLE IF NOT EXISTS` won't alter a table that already exists, so to **add a column** to an existing table either:
- run `ALTER TABLE ... ADD COLUMN ...` on the DB and add the same column to `schema.sql`, or
- if you only have sample data: `python app/server.py --reset --seed`.

The UI picks up new columns automatically. To **add a new stat**, add the column to `character_stats`,
add its name to the `item_modifiers.stat` CHECK list, add a line in `v_effective_stats`, and add it to
`BASE_STATS` / `STAT_LABEL` at the top of `app/static/app.js`.

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

## Tests
```bash
python -m unittest discover tests
```

## Roadmap ideas
- **Skills** (swordsmanship, archery, horseback, stealth…): a `skills` catalogue plus versioned
  `character_skills (character, skill, story_point, rank)`, with item modifiers able to target skills.
- Abilities/spells, character relationships, time-spanned status effects (curses, blessings), CSV import/export.
