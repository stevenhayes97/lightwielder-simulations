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
    years_elapsed REAL,                           -- in-world years since the story's start (0); drives ages.
                                                  -- NULL = same as the previous point; negative = flashback
    description TEXT
);

-- ---------------------------------------------------------------------------
-- Character roster: identity info that rarely changes.
-- Class / subclass are fixed identity ("swordsman"). Rank, faction and title
-- change with the story, so they live in character_affiliations and
-- character_titles (versioned) instead.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS characters (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    suffix      TEXT,                             -- regnal number / generational: "IV", "Jr."
    nickname    TEXT,                             -- what friends call them: "Sandy"
    class       TEXT,
    subclass    TEXT,
    race        TEXT,
    alignment   TEXT,
    role        TEXT CHECK (role IN ('protagonist','ally','antagonist','neutral','npc')),
    status      TEXT NOT NULL DEFAULT 'alive' CHECK (status IN ('alive','dead','missing','unknown')),
    age_at_start INTEGER,                         -- age when the story starts (years_elapsed = 0); see v_character_ages
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
-- Factions: kingdoms, orders, guilds, cults... Members are recorded over time
-- in character_affiliations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS factions (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    kind         TEXT,                            -- kingdom / order / guild / cult / army / house
    description  TEXT,
    notes        TEXT
);

-- ---------------------------------------------------------------------------
-- Versioned rank & faction: one row per character per story point, like
-- character_stats. A version carries forward until the next one, so record a
-- new version only where something changes (promotion, defection, treachery).
--   faction_id         NULL = unaffiliated (exile, deserter, free agent)
--   secret_faction_id  true loyalty when it differs from the public faction
--                      (spy, double agent, traitor not yet revealed)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS character_affiliations (
    id                 INTEGER PRIMARY KEY,
    character_id       INTEGER NOT NULL REFERENCES characters(id)   ON DELETE CASCADE,
    story_point_id     INTEGER NOT NULL REFERENCES story_points(id) ON DELETE RESTRICT,
    faction_id         INTEGER          REFERENCES factions(id)     ON DELETE RESTRICT,
    rank               TEXT,                      -- "Squire", "Knight-Captain", "Herald"
    secret_faction_id  INTEGER          REFERENCES factions(id)     ON DELETE RESTRICT,
    change_reason      TEXT,                      -- "promoted after the siege", "betrayed the Order"
    notes              TEXT,
    UNIQUE (character_id, story_point_id),
    CHECK (secret_faction_id IS NULL OR faction_id IS NULL OR secret_faction_id <> faction_id)
);

-- ---------------------------------------------------------------------------
-- Versioned title / epithet ("the Great", "Greycloak"): one row per character
-- per story point, carried forward until the next version. A character with no
-- row yet has no title; a version with a blank title means the title was lost
-- or stripped from that point on.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS character_titles (
    id              INTEGER PRIMARY KEY,
    character_id    INTEGER NOT NULL REFERENCES characters(id)   ON DELETE CASCADE,
    story_point_id  INTEGER NOT NULL REFERENCES story_points(id) ON DELETE RESTRICT,
    title           TEXT,                         -- NULL = no title from this point on
    change_reason   TEXT,                         -- "earned at the siege", "stripped by the council"
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

-- ---------------------------------------------------------------------------
-- Effects on the story timeline: "injured from Ch. 7 until Ch. 9".
-- Same span rule as character_equipment: from <= point < until (NULL = ongoing).
-- These feed v_effective_stats, the character sheet, and (optionally) the Lab.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS character_effects (
    id                    INTEGER PRIMARY KEY,
    character_id          INTEGER NOT NULL REFERENCES characters(id)   ON DELETE CASCADE,
    effect_id             INTEGER NOT NULL REFERENCES effects(id)      ON DELETE CASCADE,
    from_story_point_id   INTEGER NOT NULL REFERENCES story_points(id) ON DELETE RESTRICT,
    until_story_point_id  INTEGER          REFERENCES story_points(id) ON DELETE RESTRICT,
    cause                 TEXT,                   -- "ambushed at the ford"
    notes                 TEXT
);

CREATE INDEX IF NOT EXISTS idx_char_effects  ON character_effects(character_id);
CREATE INDEX IF NOT EXISTS idx_titles_char   ON character_titles(character_id);
CREATE INDEX IF NOT EXISTS idx_affil_char    ON character_affiliations(character_id);
CREATE INDEX IF NOT EXISTS idx_affil_faction ON character_affiliations(faction_id);
CREATE INDEX IF NOT EXISTS idx_loadouts_char ON loadouts(character_id);
CREATE INDEX IF NOT EXISTS idx_loadout_items ON loadout_items(loadout_id);
CREATE INDEX IF NOT EXISTS idx_effect_mods   ON effect_modifiers(effect_id);
CREATE INDEX IF NOT EXISTS idx_stats_char ON character_stats(character_id);
CREATE INDEX IF NOT EXISTS idx_equip_char ON character_equipment(character_id);
CREATE INDEX IF NOT EXISTS idx_mods_item  ON item_modifiers(item_id);

-- ---------------------------------------------------------------------------
-- Effective stats for every (character, story point) from the character's first
-- stat version onward. Base stats carry forward from the latest version at or
-- before that point; gear is whatever equipped spans cover that point, and
-- effects are whatever character_effects spans cover that point.
--   effective = round((base + sum(flat)) * (1 + sum(percent) / 100))
-- (gear flat amounts are multiplied by quantity)
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
active_effects AS (
    SELECT b.character_id, b.story_point_id, ce.effect_id
    FROM base b
    JOIN character_effects ce   ON ce.character_id = b.character_id
    JOIN story_points f         ON f.id = ce.from_story_point_id
    LEFT JOIN story_points u    ON u.id = ce.until_story_point_id
    WHERE f.sequence <= b.sequence AND (u.id IS NULL OR u.sequence > b.sequence)
),
all_mods AS (
    SELECT a.character_id, a.story_point_id, m.stat, m.mod_type, m.amount, a.quantity AS qty
    FROM active a JOIN item_modifiers m ON m.item_id = a.item_id
    WHERE IFNULL(m.condition, '') = ''
    UNION ALL
    SELECT e.character_id, e.story_point_id, m.stat, m.mod_type, m.amount, 1
    FROM active_effects e JOIN effect_modifiers m ON m.effect_id = e.effect_id
    WHERE IFNULL(m.condition, '') = ''
),
mods AS (
    SELECT character_id, story_point_id, stat,
           SUM(CASE WHEN mod_type = 'flat'    THEN amount * qty ELSE 0 END) AS flat,
           SUM(CASE WHEN mod_type = 'percent' THEN amount       ELSE 0 END) AS pct
    FROM all_mods
    GROUP BY character_id, story_point_id, stat
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


-- ---------------------------------------------------------------------------
-- Rank & faction for every (character, story point) from the character's first
-- affiliation version onward, carried forward like base stats.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_character_affiliations;
CREATE VIEW v_character_affiliations AS
WITH pts AS (
    SELECT c.id AS character_id, c.name AS character_name, sp.id AS story_point_id, sp.sequence, sp.label,
           (SELECT ca.id FROM character_affiliations ca JOIN story_points s2 ON s2.id = ca.story_point_id
             WHERE ca.character_id = c.id AND s2.sequence <= sp.sequence
             ORDER BY s2.sequence DESC LIMIT 1) AS affiliation_id
    FROM characters c CROSS JOIN story_points sp
)
SELECT
    p.character_id,
    p.character_name,
    p.story_point_id,
    p.sequence,
    p.label                               AS story_point,
    p.affiliation_id,                             -- the version in effect
    (ca.story_point_id = p.story_point_id) AS is_snapshot,
    ca.faction_id,
    f.name                                AS faction,
    ca.rank,
    ca.secret_faction_id,
    sf.name                               AS secret_faction,
    ca.change_reason
FROM pts p
JOIN character_affiliations ca ON ca.id = p.affiliation_id
LEFT JOIN factions f  ON f.id  = ca.faction_id
LEFT JOIN factions sf ON sf.id = ca.secret_faction_id;


-- ---------------------------------------------------------------------------
-- Title for every (character, story point) from the character's first title
-- version onward, carried forward like rank & faction. title NULL = none.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_character_titles;
CREATE VIEW v_character_titles AS
WITH pts AS (
    SELECT c.id AS character_id, c.name AS character_name, sp.id AS story_point_id, sp.sequence, sp.label,
           (SELECT ct.id FROM character_titles ct JOIN story_points s2 ON s2.id = ct.story_point_id
             WHERE ct.character_id = c.id AND s2.sequence <= sp.sequence
             ORDER BY s2.sequence DESC LIMIT 1) AS title_id
    FROM characters c CROSS JOIN story_points sp
)
SELECT
    p.character_id,
    p.character_name,
    p.story_point_id,
    p.sequence,
    p.label                                AS story_point,
    p.title_id,                                   -- the version in effect
    (ct.story_point_id = p.story_point_id) AS is_snapshot,
    ct.title,
    ct.change_reason
FROM pts p
JOIN character_titles ct ON ct.id = p.title_id;


-- ---------------------------------------------------------------------------
-- Age of every character at every story point:
--   age = age_at_start + years_elapsed at that point (whole years, rounded down)
-- years_elapsed carries forward from the latest point that sets it (0 if none).
-- age is NULL before the character is born (deep flashbacks).
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_character_ages;
CREATE VIEW v_character_ages AS
WITH pts AS (
    SELECT sp.id AS story_point_id, sp.sequence, sp.label,
           IFNULL((SELECT s2.years_elapsed FROM story_points s2
                    WHERE s2.sequence <= sp.sequence AND s2.years_elapsed IS NOT NULL
                    ORDER BY s2.sequence DESC LIMIT 1), 0) AS years_elapsed
    FROM story_points sp
)
SELECT
    c.id            AS character_id,
    c.name          AS character_name,
    p.story_point_id,
    p.sequence,
    p.label         AS story_point,
    p.years_elapsed,
    CASE WHEN c.age_at_start + p.years_elapsed < 0 THEN NULL
         ELSE CAST(c.age_at_start + p.years_elapsed AS INTEGER) END AS age
FROM characters c CROSS JOIN pts p
WHERE c.age_at_start IS NOT NULL;
