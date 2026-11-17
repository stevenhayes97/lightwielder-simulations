-- Placeholder sample data for trying out the UI. Safe to delete from the UI
-- (or start fresh with: python app/server.py --reset).
INSERT INTO story_points (id, sequence, label, arc, description) VALUES
 (1, 10, 'Prologue',       'Book 1', 'Sample: where the story opens'),
 (2, 20, 'Chapter 5',      'Book 1', 'Sample: first real fight'),
 (3, 30, 'Chapter 12',     'Book 1', 'Sample: aftermath of a setback');

INSERT INTO characters (id, name, epithet, class, race, faction, role, status, age, bio) VALUES
 (1, 'Sample Hero',    'the Untested', 'Warrior', 'Human', 'Example Order', 'protagonist', 'alive', 19, 'Placeholder protagonist.'),
 (2, 'Sample Mentor',  'Greycloak',    'Mage',    'Elf',   'Example Order', 'ally',        'alive', 240, 'Placeholder mentor.'),
 (3, 'Sample Villain', NULL,           'Rogue',   'Human', 'Example Cult',  'antagonist',  'alive', 41, 'Placeholder antagonist.');

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
