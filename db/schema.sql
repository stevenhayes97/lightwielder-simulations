-- Lightwielder Simulations: roster / versioned stats / gear schema (SQLite 3)
-- Applied idempotently by app/server.py on every startup.
-- To add a stat: add the column to character_stats, add it to the item_modifiers.stat
-- CHECK list, and add a line for it in v_effective_stats below.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Story timeline. Stat versions and gear spans are pinned to these points;
-- `sequence` defines the order (leave gaps, e.g. 10, 20, 30, to insert later).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS story_points (
    id          INTEGER PRIMARY KEY,
    sequence    INTEGER NOT NULL UNIQUE,
    label       TEXT    NOT NULL,                 -- "Prologue", "Book 1, Ch. 3"
    arc         TEXT,                             -- optional book / arc / act grouping
    description TEXT
);

-- ---------------------------------------------------------------------------
-- Character roster: identity info that rarely changes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS characters (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    epithet     TEXT,                             -- title / nickname
    class       TEXT,
    subclass    TEXT,
    race        TEXT,
    faction     TEXT,
    alignment   TEXT,
    role        TEXT CHECK (role IN ('protagonist','ally','antagonist','neutral','npc')),
    status      TEXT NOT NULL DEFAULT 'alive' CHECK (status IN ('alive','dead','missing','unknown')),
    age         INTEGER,
    bio         TEXT,
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_characters_updated
AFTER UPDATE ON characters FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
BEGIN
    UPDATE characters SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ---------------------------------------------------------------------------
-- Versioned base stats: one row per character per story point.
-- These are innate numbers; gear is layered on top in v_effective_stats.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS character_stats (
    id              INTEGER PRIMARY KEY,
    character_id    INTEGER NOT NULL REFERENCES characters(id)   ON DELETE CASCADE,
    story_point_id  INTEGER NOT NULL REFERENCES story_points(id) ON DELETE RESTRICT,
    hp              INTEGER NOT NULL DEFAULT 10,
    strength        INTEGER NOT NULL DEFAULT 10,
    intelligence    INTEGER NOT NULL DEFAULT 10,
    stamina         INTEGER NOT NULL DEFAULT 10,
    change_reason   TEXT,                         -- why the stats moved ("trained", "wounded")
    notes           TEXT,
    UNIQUE (character_id, story_point_id)
);

-- ---------------------------------------------------------------------------
-- Gear catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    category      TEXT NOT NULL DEFAULT 'misc'
                  CHECK (category IN ('weapon','armor','shield','accessory','consumable','tool','misc')),
    subtype       TEXT,                           -- "battle axe", "plate", "ring"
    slot          TEXT CHECK (slot IN ('main_hand','off_hand','two_hand','head','chest','hands',
                                       'legs','feet','cloak','neck','ring','belt','none')),
    rarity        TEXT NOT NULL DEFAULT 'common'
                  CHECK (rarity IN ('common','uncommon','rare','epic','legendary','artifact','unique')),
    damage        TEXT,                           -- "1d12+2" or a flat number
    damage_type   TEXT,                           -- slashing / piercing / radiant ...
    armor_rating  INTEGER NOT NULL DEFAULT 0,
    weight        REAL,
    value         INTEGER,
    req_strength  INTEGER,                        -- minimum strength to wield effectively
    description   TEXT,
    lore          TEXT
);

-- ---------------------------------------------------------------------------
-- Buffs / debuffs granted by an item (many per item). Negative amount = debuff.
-- Rows with a `condition` are situational and excluded from computed totals.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS item_modifiers (
    id         INTEGER PRIMARY KEY,
    item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    stat       TEXT NOT NULL CHECK (stat IN ('hp','strength','intelligence','stamina',
                                             'armor','attack','damage','speed','resistance')),
    mod_type   TEXT NOT NULL DEFAULT 'flat' CHECK (mod_type IN ('flat','percent')),
    amount     REAL NOT NULL,
    condition  TEXT,                              -- "vs undead", "in darkness"
    notes      TEXT
);

-- ---------------------------------------------------------------------------
-- Who holds what, over a span of the story: from `from_story_point_id`
-- up to (not including) `until_story_point_id`; NULL until = still held.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS character_equipment (
    id                    INTEGER PRIMARY KEY,
    character_id          INTEGER NOT NULL REFERENCES characters(id)   ON DELETE CASCADE,
    item_id               INTEGER NOT NULL REFERENCES items(id)        ON DELETE CASCADE,
    from_story_point_id   INTEGER NOT NULL REFERENCES story_points(id) ON DELETE RESTRICT,
    until_story_point_id  INTEGER          REFERENCES story_points(id) ON DELETE RESTRICT,
    equipped              INTEGER NOT NULL DEFAULT 1 CHECK (equipped IN (0,1)),  -- 0 = carried / stashed
    quantity              INTEGER NOT NULL DEFAULT 1,
    notes                 TEXT
);

-- ---------------------------------------------------------------------------
-- Loadouts: pre-built gear sets for "what if" comparisons (Loadout Lab).
-- character_id NULL = generic loadout usable by any character.
-- These don't affect the story timeline; character_equipment does that.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS loadouts (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL,
    character_id  INTEGER REFERENCES characters(id) ON DELETE CASCADE,
    purpose       TEXT,                           -- "siege", "stealth", "travel"
    description   TEXT,
    notes         TEXT
);

CREATE TABLE IF NOT EXISTS loadout_items (
    id          INTEGER PRIMARY KEY,
    loadout_id  INTEGER NOT NULL REFERENCES loadouts(id) ON DELETE CASCADE,
    item_id     INTEGER NOT NULL REFERENCES items(id)    ON DELETE CASCADE,
    equipped    INTEGER NOT NULL DEFAULT 1 CHECK (equipped IN (0,1)),  -- 0 = carried in pack
    quantity    INTEGER NOT NULL DEFAULT 1,
    notes       TEXT
);

-- ---------------------------------------------------------------------------
-- Generic buffs / debuffs (injury, exhaustion, blessings...) with the same
-- modifier shape as items. Applied on top of a loadout in the Loadout Lab.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS effects (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'debuff' CHECK (kind IN ('buff','debuff','mixed')),
    category     TEXT,                            -- injury / fatigue / magic / morale / environment
    severity     TEXT CHECK (severity IN ('minor','moderate','severe','critical')),
    description  TEXT,
    notes        TEXT
);

CREATE TABLE IF NOT EXISTS effect_modifiers (
    id         INTEGER PRIMARY KEY,
    effect_id  INTEGER NOT NULL REFERENCES effects(id) ON DELETE CASCADE,
    stat       TEXT NOT NULL CHECK (stat IN ('hp','strength','intelligence','stamina',
                                             'armor','attack','damage','speed','resistance')),
    mod_type   TEXT NOT NULL DEFAULT 'flat' CHECK (mod_type IN ('flat','percent')),
    amount     REAL NOT NULL,
    condition  TEXT,
    notes      TEXT
);

CREATE INDEX IF NOT EXISTS idx_loadouts_char ON loadouts(character_id);
CREATE INDEX IF NOT EXISTS idx_loadout_items ON loadout_items(loadout_id);
CREATE INDEX IF NOT EXISTS idx_effect_mods   ON effect_modifiers(effect_id);
CREATE INDEX IF NOT EXISTS idx_stats_char ON character_stats(character_id);
CREATE INDEX IF NOT EXISTS idx_equip_char ON character_equipment(character_id);
CREATE INDEX IF NOT EXISTS idx_mods_item  ON item_modifiers(item_id);

-- ---------------------------------------------------------------------------
-- Effective stats for every (character, story point) from the character's first
-- stat version onward. Base stats carry forward from the latest version at or
-- before that point; gear is whatever equipped spans cover that point.
--   effective = round((base + sum(flat * qty)) * (1 + sum(percent) / 100))
-- armor's base is the sum of equipped items' armor_rating.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_effective_stats;
CREATE VIEW v_effective_stats AS
WITH pts AS (
    SELECT c.id AS character_id, sp.id AS story_point_id, sp.sequence, sp.label,
           (SELECT cs.id FROM character_stats cs JOIN story_points s2 ON s2.id = cs.story_point_id
             WHERE cs.character_id = c.id AND s2.sequence <= sp.sequence
             ORDER BY s2.sequence DESC LIMIT 1) AS stats_id
    FROM characters c CROSS JOIN story_points sp
),
base AS (SELECT * FROM pts WHERE stats_id IS NOT NULL),
active AS (
    SELECT b.character_id, b.story_point_id, ce.item_id, ce.quantity
    FROM base b
    JOIN character_equipment ce ON ce.character_id = b.character_id AND ce.equipped = 1
    JOIN story_points f         ON f.id = ce.from_story_point_id
    LEFT JOIN story_points u    ON u.id = ce.until_story_point_id
    WHERE f.sequence <= b.sequence AND (u.id IS NULL OR u.sequence > b.sequence)
),
mods AS (
    SELECT a.character_id, a.story_point_id, m.stat,
           SUM(CASE WHEN m.mod_type = 'flat'    THEN m.amount * a.quantity ELSE 0 END) AS flat,
           SUM(CASE WHEN m.mod_type = 'percent' THEN m.amount              ELSE 0 END) AS pct
    FROM active a
    JOIN item_modifiers m ON m.item_id = a.item_id
    WHERE IFNULL(m.condition, '') = ''
    GROUP BY a.character_id, a.story_point_id, m.stat
),
g AS (  -- one row per stat version, one column pair per stat
    SELECT character_id, story_point_id,
        SUM(CASE WHEN stat='hp'           THEN flat END) AS hp_f,           SUM(CASE WHEN stat='hp'           THEN pct END) AS hp_p,
        SUM(CASE WHEN stat='strength'     THEN flat END) AS strength_f,     SUM(CASE WHEN stat='strength'     THEN pct END) AS strength_p,
        SUM(CASE WHEN stat='intelligence' THEN flat END) AS intelligence_f, SUM(CASE WHEN stat='intelligence' THEN pct END) AS intelligence_p,
        SUM(CASE WHEN stat='stamina'      THEN flat END) AS stamina_f,      SUM(CASE WHEN stat='stamina'      THEN pct END) AS stamina_p,
        SUM(CASE WHEN stat='armor'        THEN flat END) AS armor_f,        SUM(CASE WHEN stat='armor'        THEN pct END) AS armor_p,
        SUM(CASE WHEN stat='attack'       THEN flat END) AS attack_f,       SUM(CASE WHEN stat='attack'       THEN pct END) AS attack_p,
        SUM(CASE WHEN stat='damage'       THEN flat END) AS damage_f,       SUM(CASE WHEN stat='damage'       THEN pct END) AS damage_p,
        SUM(CASE WHEN stat='speed'        THEN flat END) AS speed_f,        SUM(CASE WHEN stat='speed'        THEN pct END) AS speed_p,
        SUM(CASE WHEN stat='resistance'   THEN flat END) AS resistance_f,   SUM(CASE WHEN stat='resistance'   THEN pct END) AS resistance_p
    FROM mods GROUP BY character_id, story_point_id
),
armor_base AS (
    SELECT a.character_id, a.story_point_id, SUM(i.armor_rating * a.quantity) AS armor
    FROM active a JOIN items i ON i.id = a.item_id
    GROUP BY a.character_id, a.story_point_id
)
SELECT
    b.character_id,
    c.name           AS character_name,
    b.story_point_id,
    b.sequence,
    b.label          AS story_point,
    b.stats_id,                                   -- the stat version in effect
    (cs.story_point_id = b.story_point_id) AS is_snapshot,  -- 1 if a stat version is recorded at this exact point
    CAST(ROUND((cs.hp           + IFNULL(g.hp_f,0))           * (1 + IFNULL(g.hp_p,0)/100.0))           AS INTEGER) AS hp,
    CAST(ROUND((cs.strength     + IFNULL(g.strength_f,0))     * (1 + IFNULL(g.strength_p,0)/100.0))     AS INTEGER) AS strength,
    CAST(ROUND((cs.intelligence + IFNULL(g.intelligence_f,0)) * (1 + IFNULL(g.intelligence_p,0)/100.0)) AS INTEGER) AS intelligence,
    CAST(ROUND((cs.stamina      + IFNULL(g.stamina_f,0))      * (1 + IFNULL(g.stamina_p,0)/100.0))      AS INTEGER) AS stamina,
    CAST(ROUND((IFNULL(ab.armor,0) + IFNULL(g.armor_f,0))     * (1 + IFNULL(g.armor_p,0)/100.0))        AS INTEGER) AS armor,
    CAST(ROUND(IFNULL(g.attack_f,0)     * (1 + IFNULL(g.attack_p,0)/100.0))     AS INTEGER) AS attack,
    CAST(ROUND(IFNULL(g.damage_f,0)     * (1 + IFNULL(g.damage_p,0)/100.0))     AS INTEGER) AS damage,
    CAST(ROUND(IFNULL(g.speed_f,0)      * (1 + IFNULL(g.speed_p,0)/100.0))      AS INTEGER) AS speed,
    CAST(ROUND(IFNULL(g.resistance_f,0) * (1 + IFNULL(g.resistance_p,0)/100.0)) AS INTEGER) AS resistance
FROM base b
JOIN characters      c  ON c.id  = b.character_id
JOIN character_stats cs ON cs.id = b.stats_id
LEFT JOIN g             ON g.character_id  = b.character_id AND g.story_point_id  = b.story_point_id
LEFT JOIN armor_base ab ON ab.character_id = b.character_id AND ab.story_point_id = b.story_point_id;
