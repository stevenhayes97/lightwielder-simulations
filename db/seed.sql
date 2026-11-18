-- Placeholder sample data for trying out the UI. Safe to delete from the UI
-- (or start fresh with: python app/server.py --reset).
INSERT INTO story_points (id, sequence, label, arc, description) VALUES
 (1, 10, 'Prologue',       'Book 1', 'Sample: where the story opens'),
 (2, 20, 'Chapter 5',      'Book 1', 'Sample: first real fight'),
 (3, 30, 'Chapter 12',     'Book 1', 'Sample: aftermath of a setback');

INSERT INTO characters (id, name, title, class, race, role, status, age, bio) VALUES
 (1, 'Sample Hero',    'the Untested', 'Warrior', 'Human', 'protagonist', 'alive', 19, 'Placeholder protagonist.'),
 (2, 'Sample Mentor',  'Greycloak',    'Mage',    'Elf',   'ally',        'alive', 240, 'Placeholder mentor.'),
 (3, 'Sample Villain', NULL,           'Rogue',   'Human', 'antagonist',  'alive', 41, 'Placeholder antagonist.');

INSERT INTO factions (id, name, kind, description) VALUES
 (1, 'Example Order', 'order', 'Sample: the knightly order the heroes serve'),
 (2, 'Example Cult',  'cult',  'Sample: the shadowy antagonists');

UPDATE characters SET nickname = 'Grey' WHERE id = 2;
UPDATE characters SET suffix = 'III', title = 'the Hollow' WHERE id = 3;

-- Rank & faction versions. The mentor is secretly turned by Chapter 5 and
-- openly defects in Chapter 12; the hero is promoted along the way.
INSERT INTO character_affiliations (character_id, story_point_id, faction_id, rank, secret_faction_id, change_reason) VALUES
 (1, 1, 1, 'Squire',      NULL, 'Starting rank'),
 (1, 2, 1, 'Knight',      NULL, 'Knighted after the first fight'),
 (2, 1, 1, 'Archmage',    NULL, 'Starting rank'),
 (2, 2, 1, 'Archmage',    2,    'Secretly turned by the cult'),
 (2, 3, 2, 'Herald',      NULL, 'Betrayed the Order openly'),
 (3, 2, 2, 'High Priest', NULL, 'First appearance');

INSERT INTO character_stats (character_id, story_point_id, hp, strength, intelligence, stamina, change_reason) VALUES
 (1, 1, 20, 11,  9, 10, 'Starting stats'),
 (1, 2, 28, 13,  9, 12, 'Trained over the winter'),
 (1, 3, 22, 12, 10, 11, 'Wounded, but wiser'),
 (2, 1, 18,  7, 17,  8, 'Starting stats'),
 (2, 3, 15,  6, 18,  7, 'Aging; drained by a ward'),
 (3, 2, 24, 12, 14, 13, 'First appearance');

INSERT INTO items (id, name, category, subtype, slot, rarity, damage, damage_type, armor_rating, weight, value, req_strength, description) VALUES
 (1, 'Sample Battle Axe', 'weapon', 'battle axe', 'two_hand', 'uncommon', '1d12', 'slashing', 0, 7, 40, 12, 'Heavy, hits hard.'),
 (2, 'Sample Plate Armor','armor',  'plate',      'chest',    'common',   NULL,   NULL,       8, 40, 150, 13, 'Protective but tiring.'),
 (3, 'Sample Sage Ring',  'accessory','ring',     'ring',     'rare',     NULL,   NULL,       0, 0.1, 300, NULL, 'Sharpens the mind.');

INSERT INTO item_modifiers (item_id, stat, mod_type, amount, condition, notes) VALUES
 (1, 'strength',     'flat',    2,   NULL,        'Momentum of a heavy weapon'),
 (1, 'damage',       'flat',    3,   NULL,        NULL),
 (1, 'damage',       'flat',    4,   'vs undead', 'Situational: excluded from totals'),
 (2, 'hp',           'percent', 10,  NULL,        NULL),
 (2, 'stamina',      'flat',   -2,   NULL,        'Heavy to wear'),
 (2, 'speed',        'flat',   -1,   NULL,        NULL),
 (3, 'intelligence', 'flat',    3,   NULL,        NULL);

INSERT INTO character_equipment (character_id, item_id, from_story_point_id, until_story_point_id, equipped, notes) VALUES
 (1, 1, 2, NULL, 1, 'Picked up in chapter 5'),
 (1, 2, 2, 3,    1, 'Lost in chapter 12'),
 (2, 3, 1, NULL, 1, NULL);

INSERT INTO items (id, name, category, subtype, slot, rarity, damage, damage_type, armor_rating, weight, value, req_strength, description) VALUES
 (4, 'Sample Shortbow',     'weapon', 'bow',     'two_hand', 'common', '1d6', 'piercing', 0, 2, 25, NULL, 'Light ranged weapon.'),
 (5, 'Sample Leather Armor','armor',  'leather', 'chest',    'common', NULL,  NULL,       3, 10, 45, NULL, 'Quiet and flexible.'),
 (6, 'Sample Longsword',    'weapon', 'sword',   'main_hand','common', '1d8', 'slashing', 0, 3, 30, 10, 'Reliable blade.'),
 (7, 'Sample Kite Shield',  'shield', 'kite',    'off_hand', 'common', NULL,  NULL,       2, 6, 20, 11, NULL);

INSERT INTO item_modifiers (item_id, stat, mod_type, amount, notes) VALUES
 (4, 'attack', 'flat',  1, NULL),
 (5, 'speed',  'flat',  1, NULL),
 (6, 'attack', 'flat',  1, NULL),
 (6, 'damage', 'flat',  1, NULL),
 (7, 'resistance', 'flat', 1, NULL);

INSERT INTO loadouts (id, name, character_id, purpose, description) VALUES
 (1, 'Heavy Assault',  1,    'frontline', 'Sample: axe and plate'),
 (2, 'Sword & Board',  1,    'defensive', 'Sample: sword, shield, plate'),
 (3, 'Light Scout',    1,    'stealth',   'Sample: bow and leather'),
 (4, 'Generic Militia', NULL, 'any',      'Sample generic kit anyone can use');

INSERT INTO loadout_items (loadout_id, item_id, equipped, quantity) VALUES
 (1, 1, 1, 1), (1, 2, 1, 1),
 (2, 6, 1, 1), (2, 7, 1, 1), (2, 2, 1, 1),
 (3, 4, 1, 1), (3, 5, 1, 1), (3, 6, 0, 1),
 (4, 6, 1, 1), (4, 5, 1, 1);

INSERT INTO effects (id, name, kind, category, severity, description) VALUES
 (1, 'Injured (arm)',  'debuff', 'injury',  'moderate', 'Sample: wounded sword arm'),
 (2, 'Exhausted',      'debuff', 'fatigue', 'moderate', 'Sample: days without rest'),
 (3, 'Well Rested',    'buff',   'fatigue', 'minor',    'Sample: a full night''s sleep'),
 (4, 'Blessed',        'buff',   'magic',   'minor',    'Sample: protective blessing');

INSERT INTO effect_modifiers (effect_id, stat, mod_type, amount, condition) VALUES
 (1, 'strength', 'flat',    -3,  NULL),
 (1, 'attack',   'flat',    -2,  NULL),
 (2, 'stamina',  'percent', -50, NULL),
 (2, 'speed',    'flat',    -2,  NULL),
 (2, 'intelligence','flat', -1,  NULL),
 (3, 'stamina',  'flat',     2,  NULL),
 (4, 'hp',       'percent',  10, NULL),
 (4, 'resistance','flat',    2,  'vs dark magic');

INSERT INTO character_effects (character_id, effect_id, from_story_point_id, until_story_point_id, cause) VALUES
 (1, 1, 3, NULL, 'Sample: arm wound taken in chapter 12'),
 (2, 2, 2, 3,    'Sample: exhausted holding the ward');
