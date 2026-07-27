'use strict';
const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const initSqlJs = require('sql.js');

const { PORT, DISCORD_BOT_SECRET, DM_KEY } = require('./specificUser');
const BOT_SECRET = DISCORD_BOT_SECRET || '';
const DM_KEY_VALUE = DM_KEY || '';

// DB lives next to the map tool content so existing game state is preserved.
const DB_FILE  = path.join(__dirname, 'map tool', 'map_data.db');

// NPC images are stored in npcs/images/
const IMAGES_DIR = path.join(__dirname, 'npcs', 'images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Note attachments (images / PDFs) are stored in npcs/attachments/
const ATTACH_DIR = path.join(__dirname, 'npcs', 'attachments');
if (!fs.existsSync(ATTACH_DIR)) fs.mkdirSync(ATTACH_DIR, { recursive: true });

// Location map images go into map tool/locations/
const LOCATIONS_IMG_DIR = path.join(__dirname, 'map tool', 'locations');
if (!fs.existsSync(LOCATIONS_IMG_DIR)) fs.mkdirSync(LOCATIONS_IMG_DIR, { recursive: true });

const app    = express();

let db;

//  DATABASE 
async function openDb() {
  const SQL = await initSqlJs({
    locateFile: f => path.join(__dirname, 'node_modules', 'sql.js', 'dist', f)
  });
  db = fs.existsSync(DB_FILE)
    ? new SQL.Database(fs.readFileSync(DB_FILE))
    : new SQL.Database();

  db.run(`CREATE TABLE IF NOT EXISTS town_state (
    town       TEXT PRIMARY KEY,
    player_vis TEXT NOT NULL DEFAULT '{"houses":{},"npcs":{}}',
    npc_edits  TEXT NOT NULL DEFAULT '{}',
    npc_schema TEXT NOT NULL DEFAULT '{}',
    house_pos  TEXT NOT NULL DEFAULT '{}',
    loc_pos    TEXT NOT NULL DEFAULT '{}'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS town_content (
    town              TEXT PRIMARY KEY,
    name              TEXT    NOT NULL DEFAULT '',
    map_image         TEXT    NOT NULL DEFAULT '',
    total_homes       INTEGER NOT NULL DEFAULT 0,
    total_residents   INTEGER NOT NULL DEFAULT 0,
    households        TEXT    NOT NULL DEFAULT '[]',
    town_locations    TEXT    NOT NULL DEFAULT '[]',
    house_map_default TEXT    NOT NULL DEFAULT '{}'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS region_content (
    region               TEXT PRIMARY KEY,
    name                 TEXT NOT NULL DEFAULT '',
    map_image            TEXT NOT NULL DEFAULT '',
    locations            TEXT NOT NULL DEFAULT '[]',
    location_map_default TEXT NOT NULL DEFAULT '{}'
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS npc_sheets (
    npc_id        TEXT PRIMARY KEY,
    name          TEXT NOT NULL DEFAULT '',
    type          TEXT NOT NULL DEFAULT 'character',
    image         TEXT DEFAULT NULL,
    char_data     TEXT NOT NULL DEFAULT '{}',
    monster_data  TEXT NOT NULL DEFAULT '{}',
    notes         TEXT NOT NULL DEFAULT '[]',
    player_notes  TEXT NOT NULL DEFAULT '[]'
  )`);
  try { db.run("ALTER TABLE npc_sheets ADD COLUMN location TEXT NOT NULL DEFAULT ''"); } catch(_) {}
  try { db.run("ALTER TABLE npc_sheets ADD COLUMN premises TEXT NOT NULL DEFAULT ''"); } catch(_) {}
  try { db.run("ALTER TABLE npc_sheets ADD COLUMN in_party INTEGER NOT NULL DEFAULT 0"); } catch(_) {}
  try { db.run("ALTER TABLE town_content ADD COLUMN extra_maps TEXT NOT NULL DEFAULT '[]'"); } catch(_) {}
  try { db.run("ALTER TABLE town_state ADD COLUMN lore_notes TEXT NOT NULL DEFAULT '[]'"); } catch(_) {}

  db.run(`CREATE TABLE IF NOT EXISTS backgrounds (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL UNIQUE,
    skills         TEXT    NOT NULL DEFAULT '[]',
    skill_choice   TEXT    DEFAULT NULL,
    tools          TEXT    NOT NULL DEFAULT '[]',
    tool_choice    TEXT    DEFAULT NULL,
    language_count INTEGER NOT NULL DEFAULT 0,
    feature        TEXT    NOT NULL DEFAULT '',
    feature_desc   TEXT    NOT NULL DEFAULT ''
  )`);
  seedBackgrounds();

  db.run(`CREATE TABLE IF NOT EXISTS equipment (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    category   TEXT    NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    data       TEXT    NOT NULL DEFAULT '{}'
  )`);
  seedEquipment();

  // Races: a reference catalog (name + source + a JSON blob describing the mechanical
  // changes a race applies to a character sheet — ability increases, size, speed,
  // darkvision, granted skills, languages, and racial traits). Searched from the NPC
  // tool's Race field, mirroring the backgrounds/equipment reference tables.
  db.run(`CREATE TABLE IF NOT EXISTS races (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT '',
    data   TEXT NOT NULL DEFAULT '{}'
  )`);
  seedRaces();

  // Feats: same reference-catalog shape as races. The JSON blob describes the feat's
  // mechanical changes and, for half-feats / Skilled / Linguist etc., the choices the
  // player makes (ability, skill, language) — applied via the same Choices machinery.
  db.run(`CREATE TABLE IF NOT EXISTS feats (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT '',
    data   TEXT NOT NULL DEFAULT '{}'
  )`);
  seedFeats();

  // Spells: reference catalog for the sheet's spell search. `level` 0 = cantrip.
  // `desc` is intentionally empty in the built-in seed — spell rules text is not
  // hand-authored (too easy to get dice/saves/ranges subtly wrong). Import verbatim
  // text later via POST /api/spells/import; everything else is searchable meanwhile.
  db.run(`CREATE TABLE IF NOT EXISTS spells (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT    NOT NULL UNIQUE,
    level  INTEGER NOT NULL DEFAULT 0,
    school TEXT    NOT NULL DEFAULT '',
    source TEXT    NOT NULL DEFAULT '',
    data   TEXT    NOT NULL DEFAULT '{}'
  )`);
  seedSpells();

  // Classes: basic reference shape (name, hit die, saves, proficiencies, spellcasting)
  // in the JSON blob — not full per-level tables. Seeded with the 12 PHB classes so the
  // Creation tool has something to edit; custom classes save here too.
  db.run(`CREATE TABLE IF NOT EXISTS classes (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT '',
    data   TEXT NOT NULL DEFAULT '{}'
  )`);
  seedClasses();

  // Players  per-player identity for the (upcoming) player view. Each has a
  // secret link token, an optional Discord delivery target, and an assigned
  // character (npc_id) they control alongside the DM.
  db.run(`CREATE TABLE IF NOT EXISTS players (
    pid            TEXT PRIMARY KEY,
    name           TEXT    NOT NULL DEFAULT '',
    token          TEXT    NOT NULL DEFAULT '',
    discord_channel TEXT   NOT NULL DEFAULT '',
    discord_target TEXT    NOT NULL DEFAULT '',
    character_id   TEXT    NOT NULL DEFAULT '',
    last_seen      INTEGER NOT NULL DEFAULT 0,
    created        INTEGER NOT NULL DEFAULT 0
  )`);
  try { db.run("ALTER TABLE players ADD COLUMN discord_channel TEXT NOT NULL DEFAULT ''"); } catch(_) {}

  // Small key→value store for singleton runtime state that should survive a restart
  // (currently the live combat/initiative tracker). One row per key, JSON value.
  db.run(`CREATE TABLE IF NOT EXISTS kv_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`);

  flush();
}

// ── generic kv_state helpers ──
function kvGet(key, fallback) {
  try { const r = dbGetOne('SELECT value FROM kv_state WHERE key = ?', [key]); return r ? JSON.parse(r.value) : fallback; }
  catch (_) { return fallback; }
}
function kvSet(key, obj) {
  db.run('INSERT OR REPLACE INTO kv_state (key, value) VALUES (?, ?)', [key, JSON.stringify(obj)]);
  flush();
}

function seedBackgrounds() {
  const backgrounds = [
    //  PHB 
    { name: 'Acolyte',                     skills: ['Insight','Religion'],            skill_choice: null,                                                           tools: [],                                           tool_choice: null,                                          language_count: 2, feature: 'Shelter of the Faithful',  feature_desc: 'You and your companions receive free healing and care at a temple of your deity and can live at a modest lifestyle there for free. Those who share your religion will support you, and you can perform the rites of your faith.' },
    { name: 'Charlatan',                   skills: ['Deception','Sleight of Hand'],   skill_choice: null,                                                           tools: ['Disguise kit','Forgery kit'],               tool_choice: null,                                          language_count: 0, feature: 'False Identity',           feature_desc: 'You have a second identity with documentation, established acquaintances, and disguises. You can forge documents including official papers and personal letters, as long as you have seen examples of the relevant handwriting or document type.' },
    { name: 'Criminal',                    skills: ['Deception','Stealth'],           skill_choice: null,                                                           tools: ["Thieves' tools"],                            tool_choice: 'One type of gaming set',                      language_count: 0, feature: 'Criminal Contact',         feature_desc: 'You have a reliable contact who acts as your liaison to a network of criminals. You know how to get messages to and from your contact over great distances through corrupt caravan masters, seedy sailors, and local messengers.' },
    { name: 'Entertainer',                 skills: ['Acrobatics','Performance'],      skill_choice: null,                                                           tools: ['Disguise kit'],                             tool_choice: 'One type of musical instrument',              language_count: 0, feature: 'By Popular Demand',        feature_desc: 'You can always find a place to perform in an inn, tavern, circus, or noble\'s court. You receive free lodging and food of modest or comfortable standard as long as you perform each night. Your performances make you a local figure among those who have seen you.' },
    { name: 'Folk Hero',                   skills: ['Animal Handling','Survival'],    skill_choice: null,                                                           tools: ['Vehicles (land)'],                          tool_choice: "One type of artisan's tools",                 language_count: 0, feature: 'Rustic Hospitality',       feature_desc: 'Since you come from common folk, you fit in among them with ease. You can find a place to hide, rest, or recuperate among commoners, unless you have shown yourself to be a danger to them. They will shield you from the law or others searching for you, though they will not risk their lives for you.' },
    { name: 'Guild Artisan',               skills: ['Insight','Persuasion'],          skill_choice: null,                                                           tools: [],                                           tool_choice: "One type of artisan's tools",                 language_count: 1, feature: 'Guild Membership',         feature_desc: 'As an established guild member, fellow members provide lodging, food, and funeral expenses if needed. If accused of a crime, your guild will support you if a good case can be made for your innocence. You pay dues of 5 gp per month.' },
    { name: 'Hermit',                      skills: ['Medicine','Religion'],           skill_choice: null,                                                           tools: ['Herbalism kit'],                            tool_choice: null,                                          language_count: 1, feature: 'Discovery',                feature_desc: 'Your seclusion gave you access to a unique and powerful discovery  a great truth about the cosmos, the gods, powerful forces of the world, or beings of the planes. It might be damaging information or a significant secret about a powerful organization.' },
    { name: 'Noble',                       skills: ['History','Persuasion'],          skill_choice: null,                                                           tools: [],                                           tool_choice: 'One type of gaming set',                      language_count: 1, feature: 'Position of Privilege',    feature_desc: 'Thanks to your noble birth, people think the best of you. You are welcome in high society and people assume you have the right to be wherever you are. Common folk accommodate you, other nobles treat you as a peer, and you can secure an audience with a local noble if needed.' },
    { name: 'Outlander',                   skills: ['Athletics','Survival'],          skill_choice: null,                                                           tools: [],                                           tool_choice: 'One type of musical instrument',              language_count: 1, feature: 'Wanderer',                 feature_desc: 'You have an excellent memory for maps and geography and can always recall the general layout of terrain and settlements around you. You can find food and fresh water for yourself and up to five others each day, provided the land offers berries, small game, water, and so forth.' },
    { name: 'Sage',                        skills: ['Arcana','History'],              skill_choice: null,                                                           tools: [],                                           tool_choice: null,                                          language_count: 2, feature: 'Researcher',               feature_desc: 'When you try to learn or recall a piece of lore you don\'t know, you often know where and from whom you can obtain it  a library, scriptorium, university, or a learned person. Your DM might rule that the knowledge is inaccessible or that unearthing it requires an adventure.' },
    { name: 'Sailor',                      skills: ['Athletics','Perception'],        skill_choice: null,                                                           tools: ["Navigator's tools",'Vehicles (water)'],     tool_choice: null,                                          language_count: 0, feature: "Ship's Passage",           feature_desc: 'When you need to, you can secure free passage on a sailing ship for yourself and your companions. You might sail on the ship you served on, or another with which you have good relations. In return, you and your companions are expected to assist the crew during the voyage.' },
    { name: 'Soldier',                     skills: ['Athletics','Intimidation'],      skill_choice: null,                                                           tools: ['Vehicles (land)'],                          tool_choice: 'One type of gaming set',                      language_count: 0, feature: 'Military Rank',             feature_desc: 'You have a military rank recognized by soldiers loyal to your former organization. You can invoke your rank to exert influence over other soldiers, requisition simple equipment or horses for temporary use, and gain access to friendly military encampments where your rank is recognized.' },
    { name: 'Urchin',                      skills: ['Sleight of Hand','Stealth'],     skill_choice: null,                                                           tools: ['Disguise kit',"Thieves' tools"],             tool_choice: null,                                          language_count: 0, feature: 'City Secrets',             feature_desc: 'You know the secret patterns and flow of cities and can find passages that others would miss. When not in combat, you and companions you lead can travel between any two locations in a city twice as fast as normal. You know where to find black markets, street gangs, and other criminal elements.' },
    // PHB variants
    { name: 'Gladiator',                   skills: ['Acrobatics','Performance'],      skill_choice: null,                                                           tools: ["Unusual weapon (artisan's tool)"],           tool_choice: 'One type of musical instrument',              language_count: 0, feature: 'By Popular Demand',        feature_desc: 'You can always find a place to perform  arenas, fighting pits, and gladiatorial matches. You receive free lodging and food as long as you fight when asked. (Gladiator variant of Entertainer.)' },
    { name: 'Guild Merchant',              skills: ['Insight','Persuasion'],          skill_choice: null,                                                           tools: ["Navigator's tools"],                         tool_choice: null,                                          language_count: 1, feature: 'Guild Membership',         feature_desc: 'As an established merchant guild member, fellow members provide lodging and food if needed. Guilds wield political power and will support you if accused of a crime. You pay dues of 5 gp per month. (Guild Merchant variant of Guild Artisan.)' },
    { name: 'Knight',                      skills: ['History','Persuasion'],          skill_choice: null,                                                           tools: [],                                           tool_choice: 'One type of gaming set',                      language_count: 1, feature: 'Retainers',                feature_desc: 'You have three retainers loyal to your family who act as attendants or messengers. They are commoners who perform mundane tasks but will not fight for you, enter dangerous areas, or remain if frequently endangered or abused. (Knight variant of Noble.)' },
    { name: 'Pirate',                      skills: ['Athletics','Perception'],        skill_choice: null,                                                           tools: ["Navigator's tools",'Vehicles (water)'],     tool_choice: null,                                          language_count: 0, feature: 'Bad Reputation',           feature_desc: 'If you spend time in a city or town, you can get away with minor criminal offenses such as refusing to pay for food at a tavern or breaking down doors, since most people will not report your activity to the authorities. (Pirate variant of Sailor.)' },
    { name: 'Spy',                         skills: ['Deception','Stealth'],           skill_choice: null,                                                           tools: ["Thieves' tools"],                            tool_choice: 'One type of gaming set',                      language_count: 0, feature: 'Criminal Contact',         feature_desc: 'You have a reliable contact who acts as your liaison to a network of criminals. (Spy variant of Criminal.)' },
    //  SCAG 
    { name: 'City Watch',                  skills: ['Athletics','Insight'],           skill_choice: null,                                                           tools: [],                                           tool_choice: null,                                          language_count: 2, feature: "Watcher's Eye",            feature_desc: 'Your law enforcement background helps you easily locate city watch outposts and criminal dens in any community. You are able to identify official gathering places and know which establishments cater to criminals, though your reception will differ depending on the community.' },
    { name: 'Clan Crafter',                skills: ['History','Insight'],             skill_choice: null,                                                           tools: [],                                           tool_choice: "One type of artisan's tools",                 language_count: 1, feature: 'Respect of the Stout Folk', feature_desc: 'Dwarves hold clan crafters in high regard. You receive complimentary lodging and meals in settlements populated by shield dwarves or gold dwarves, and local residents may compete to provide the finest accommodations for you and your companions. (Language must be Dwarvish if not already known.)' },
    { name: 'Cloistered Scholar',          skills: ['History'],                       skill_choice: 'Choose one more skill from Arcana, Nature, or Religion',       tools: [],                                           tool_choice: null,                                          language_count: 2, feature: 'Library Access',           feature_desc: 'You have unrestricted access to most of your cloister\'s archives. Other libraries throughout the Realms typically extend professional courtesy to you, often granting preferential treatment when seeking their resources. You know your institution\'s staff and organizational structure.' },
    { name: 'Courtier',                    skills: ['Insight','Persuasion'],          skill_choice: null,                                                           tools: [],                                           tool_choice: null,                                          language_count: 2, feature: 'Court Functionary',        feature_desc: 'Your knowledge of how bureaucracies function lets you gain access to the records and inner workings of any noble court or government you encounter. You can identify influential figures and understand current political dynamics, facilitating access to information and favors.' },
    { name: 'Faction Agent',               skills: ['Insight'],                       skill_choice: 'Choose one more skill based on your faction (typically Intelligence, Wisdom, or Charisma based)', tools: [],                  tool_choice: null,                                          language_count: 2, feature: 'Safe Haven',               feature_desc: 'You have a secret network of supporters and operatives who can provide assistance on your adventures. You know secret signs and passwords to identify faction contacts who offer you access to safe houses, free room and board, or assistance finding information. Operatives will not risk their lives for you.' },
    { name: 'Far Traveler',                skills: ['Insight','Perception'],          skill_choice: null,                                                           tools: [],                                           tool_choice: 'One musical instrument or gaming set (likely from your homeland)', language_count: 1, feature: 'All Eyes on You',          feature_desc: 'Your foreign accent, mannerisms, and appearance mark you as an outsider. This curiosity can provide access to nobles, scholars, and merchants interested in your distant homeland, helping you and your companions gain entrance to places otherwise restricted to you.' },
    { name: 'Inheritor',                   skills: ['Survival'],                      skill_choice: 'Choose one more skill from Arcana, History, or Religion',      tools: [],                                           tool_choice: 'One gaming set or musical instrument',        language_count: 1, feature: 'Inheritance',              feature_desc: 'You have a specific item or piece of information passed down to you from a relative or mentor. Work with your DM to establish the inheritance\'s significance and backstory. The DM may use it as a narrative hook for quests or conflicts with those seeking to claim or conceal it.' },
    { name: 'Investigator (SCAG)',         skills: ['Insight','Investigation'],       skill_choice: null,                                                           tools: [],                                           tool_choice: null,                                          language_count: 2, feature: "Watcher's Eye",            feature_desc: 'Your investigator background helps you easily locate city watch outposts and criminal dens in any community. You know which establishments cater to criminals and where law enforcement gathers. (Variant of City Watch  Investigation replaces Athletics.)' },
    { name: 'Knight of the Order',         skills: ['Persuasion'],                    skill_choice: 'Choose one more skill from Arcana, History, Nature, or Religion (depending on your order)', tools: [],                       tool_choice: 'One gaming set or musical instrument',        language_count: 1, feature: 'Knightly Regard',          feature_desc: 'Members of your order and allied sympathizers provide you with shelter, meals, and healing when appropriate. This extends to religious communities (if your order serves a deity), civic supporters, or philosophical allies. Risk of aid may extend to local citizens rallying to a knight in need.' },
    { name: 'Mercenary Veteran',           skills: ['Athletics','Persuasion'],        skill_choice: null,                                                           tools: ['Vehicles (land)'],                          tool_choice: 'One type of gaming set',                      language_count: 0, feature: 'Mercenary Life',           feature_desc: 'You can identify mercenary companies by their emblems and know the names and reputations of their commanders. You can find taverns where mercenaries gather in any region where you speak the local language. Between adventures, you can secure mercenary work to maintain a comfortable lifestyle.' },
    { name: 'Urban Bounty Hunter',         skills: [],                                skill_choice: 'Choose two from Deception, Insight, Persuasion, and Stealth',  tools: [],                                           tool_choice: 'Choose two from gaming set, musical instrument, or thieves\' tools', language_count: 0, feature: 'Ear to the Ground',        feature_desc: 'You are in frequent contact with people in the segment of society that your chosen quarries move through. You have a reliable local contact in any city who shares information about the people and places in that area.' },
    { name: 'Uthgardt Tribe Member',       skills: ['Athletics','Survival'],          skill_choice: null,                                                           tools: [],                                           tool_choice: 'One type of musical instrument or artisan\'s tools', language_count: 1, feature: 'Uthgardt Heritage',        feature_desc: 'You can find twice as much food and water when you forage in any wilderness area. You may call upon the hospitality of your people and those allied with your tribe, including druids, nomadic elves, the Harpers, and First Circle priesthoods.' },
    { name: 'Waterdhavian Noble',          skills: ['History','Persuasion'],          skill_choice: null,                                                           tools: [],                                           tool_choice: 'One gaming set or musical instrument',        language_count: 1, feature: 'Kept in Style',            feature_desc: 'While in Waterdeep or other major cities, your noble house covers your expenses. Your name and signet are sufficient to cover most costs; inns, taverns, and festhalls are glad to record your debt and bill your family estate, granting you a comfortable lifestyle at no cost.' },
    //  Tomb of Annihilation 
    { name: 'Anthropologist',              skills: ['Insight','Religion'],            skill_choice: null,                                                           tools: [],                                           tool_choice: null,                                          language_count: 2, feature: 'Adept Linguist',          feature_desc: 'You can communicate with humanoids who don\'t share a common language with you. After observing them interacting with each other for at least one day, you learn a handful of important words, expressions, and gestures  enough to communicate on a rudimentary level despite the language barrier.' },
    { name: 'Archaeologist',               skills: ['History','Survival'],            skill_choice: null,                                                           tools: [],                                           tool_choice: "Cartographer's tools or navigator's tools",   language_count: 1, feature: 'Historical Knowledge',     feature_desc: 'When you enter a ruin or dungeon, you can determine the original purpose of the builders and identify the monsters likely to be found there. You can also assess the monetary value of art objects more than a century old.' },
    //  Ghosts of Saltmarsh 
    { name: 'Fisher',                      skills: ['History','Survival'],            skill_choice: null,                                                           tools: ['Fishing tackle'],                           tool_choice: null,                                          language_count: 1, feature: 'Harvest the Water',        feature_desc: 'You gain advantage on ability checks using fishing tackle. With access to a body of water that sustains marine life, you can maintain a moderate lifestyle and catch enough food to feed yourself and up to ten other people each day.' },
    { name: 'Marine',                      skills: ['Athletics','Survival'],          skill_choice: null,                                                           tools: ['Vehicles (land)','Vehicles (water)'],        tool_choice: null,                                          language_count: 0, feature: 'Steady',                   feature_desc: 'You can march for extended periods  up to 16 hours each day  before being subject to the effects of a forced march. You can also identify viable coastal landing routes whenever options exist, a useful skill when scouting unfamiliar shores.' },
    { name: 'Shipwright',                  skills: ['History','Perception'],          skill_choice: null,                                                           tools: ["Carpenter's tools",'Vehicles (water)'],     tool_choice: null,                                          language_count: 0, feature: "I'll Patch It!",           feature_desc: 'With carpenter\'s tools and raw wood available, you can repair a water vehicle\'s hull, restoring hit points equal to 5  your proficiency modifier. The same vessel cannot benefit from this repair again until it has been pulled ashore and undergone full repairs.' },
    { name: 'Smuggler',                    skills: ['Athletics','Deception'],         skill_choice: null,                                                           tools: ['Vehicles (water)'],                         tool_choice: null,                                          language_count: 0, feature: 'Down Low',                 feature_desc: 'You have connections within a smuggling network. When in a town or city, you and your companions can stay free of charge at safe houses that provide a poor lifestyle. Your presence at these locations can remain concealed while you stay there.' },
    //  Baldur's Gate: Descent into Avernus 
    { name: 'Faceless',                    skills: ['Deception','Intimidation'],      skill_choice: null,                                                           tools: ['Disguise kit'],                             tool_choice: null,                                          language_count: 1, feature: 'Faceless Persona',         feature_desc: 'You have a public persona  a mask identity  separate from your true self. You can change between your two personalities as often as you wish, using one to hide the other. Those who know you in one identity won\'t connect it to the other unless you expose the link yourself.' },
    //  Mythic Odysseys of Theros 
    { name: 'Athlete',                     skills: ['Acrobatics','Athletics'],        skill_choice: null,                                                           tools: ['Vehicles (land)'],                          tool_choice: null,                                          language_count: 1, feature: 'Echoes of Victory',        feature_desc: 'You have gained a reputation in your region of origin. Within 100 miles of your hometown, there is a 50% chance of finding an admirer willing to provide information and shelter. Between adventures, you can maintain a comfortable lifestyle by competing in athletic events.' },
    //  The Wild Beyond the Witchlight 
    { name: 'Feylost',                     skills: ['Deception','Survival'],          skill_choice: null,                                                           tools: [],                                           tool_choice: 'One type of musical instrument',              language_count: 1, feature: 'Feywild Connection',       feature_desc: 'Your mannerisms and knowledge of fey customs are recognized by natives of the Feywild, who see you as one of their own. Friendly fey creatures encountered there will grant you favor and assistance. (Language must be Elvish, Gnomish, Goblin, or Sylvan.) You also receive the Fey Mark feature  a distinctive physical transformation from your time in the Feywild.' },
    { name: 'Witchlight Hand',             skills: ['Performance','Sleight of Hand'], skill_choice: null,                                                           tools: [],                                           tool_choice: 'Disguise kit or one type of musical instrument', language_count: 1, feature: 'Carnival Companion',       feature_desc: 'Over the years you have earned the friendship of another carnival fixture. Roll a d8 to determine your companion  ranging from fellow performers to magical creatures like blink dogs, sprites, or wisps of light. This companion remains with you while in the carnival but won\'t leave it voluntarily.' },
    //  Van Richten's Guide to Ravenloft 
    { name: 'Haunted One',                 skills: [],                                skill_choice: 'Choose two from Arcana, Investigation, Religion, or Survival', tools: [],                                           tool_choice: null,                                          language_count: 2, feature: 'Heart of Darkness',        feature_desc: 'Those who look into your eyes can see that you have faced unimaginable horror and that you are no stranger to darkness. Commoners will provide you with aid and even take up arms alongside you against enemies, provided you haven\'t proven yourself a danger to them. (One language must be exotic: Abyssal, Celestial, Deep Speech, Draconic, Infernal, Primordial, Sylvan, or Undercommon.)' },
    { name: 'Investigator (VRGR)',         skills: [],                                skill_choice: 'Choose two from Insight, Investigation, or Perception',        tools: ['Disguise kit',"Thieves' tools"],             tool_choice: null,                                          language_count: 0, feature: 'Official Inquiry',         feature_desc: 'You can quickly gain access to crime scenes, eyewitnesses, and official records pertaining to your investigation. Those not involved in your investigation avoid impeding you. You have a reputation with local law enforcement who view you as either a helpful ally or a troublesome obstacle.' },
    //  Eberron: Rising from the Last War 
    { name: 'House Agent',                 skills: ['Investigation','Persuasion'],    skill_choice: null,                                                           tools: [],                                           tool_choice: 'Two proficiencies from your dragonmarked house\'s tool table (e.g. alchemist\'s supplies, tinker\'s tools, forgery kit, thieves\' tools, vehicles)', language_count: 0, feature: 'House Connections',        feature_desc: 'While in a city with a house enclave, you have access to resources and lodging for you and your friends. Your house typically supplies necessary equipment and transportation for assigned missions. Contacts throughout your house can provide assistance depending on your current standing with them.' },
    //  Bigby Presents: Glory of the Giants 
    { name: 'Giant Foundling',             skills: ['Intimidation','Survival'],       skill_choice: null,                                                           tools: [],                                           tool_choice: null,                                          language_count: 1, feature: 'Strike of the Giants',     feature_desc: 'You gain the Strike of the Giants feat, reflecting your giant-influenced upbringing and granting you a powerful combat strike tied to your giant heritage. You also learn the Giant language; the free language choice above is one additional language of your choice.' },
    { name: 'Rune Carver',                 skills: ['History','Perception'],          skill_choice: null,                                                           tools: [],                                           tool_choice: "One set of artisan's tools",                  language_count: 0, feature: 'Rune Shaper',              feature_desc: 'You gain the Rune Shaper feat, granting access to supernatural runecraft abilities originating with giants. You also learn the Giant language  add it to the Proficiencies & Languages section manually.' },
    //  The Book of Many Things 
    { name: 'Rewarded',                    skills: ['Insight','Persuasion'],          skill_choice: null,                                                           tools: [],                                           tool_choice: 'One gaming set',                              language_count: 1, feature: "Fortune's Favor",          feature_desc: 'You gain one feat of your choice from the following: Lucky, Magic Initiate, or Skilled. The chosen feat reflects how your life transformed  whether through magical means, gambling success, or acquired knowledge  after receiving your reward.' },
    { name: 'Ruined',                      skills: ['Stealth','Survival'],            skill_choice: null,                                                           tools: [],                                           tool_choice: 'One gaming set',                              language_count: 1, feature: 'Still Standing',           feature_desc: 'You gain one feat of your choice from the following: Alert, Skilled, or Tough. Alert represents staying vigilant for opportunities, Skilled reflects doubled efforts to reclaim your former status, and Tough demonstrates stoic perseverance through hardship and significant misfortune.' },
    //  Acquisitions Incorporated 
    { name: "Celebrity Adventurer's Scion", skills: ['Perception','Performance'],    skill_choice: null,                                                           tools: ['Disguise kit'],                             tool_choice: null,                                          language_count: 2, feature: 'Name Dropping',            feature_desc: 'You can leverage connections with influential figures throughout the realm to obtain modest support from significant NPCs at the DM\'s discretion. Common people show respect to you, and tales of your famous parent\'s exploits can earn you complimentary meals or lodging.' },
    { name: 'Failed Merchant',             skills: ['Investigation','Persuasion'],    skill_choice: null,                                                           tools: [],                                           tool_choice: "One type of artisan's tools",                 language_count: 1, feature: 'Supply Chain',             feature_desc: 'From your time as a merchant, you retain connections with wholesalers, suppliers, and other merchants and entrepreneurs. You can call upon these connections when looking for items or information, and you know where to find deals and who to talk to in commercial circles.' },
    { name: 'Gambler',                     skills: ['Deception','Insight'],           skill_choice: null,                                                           tools: [],                                           tool_choice: 'One type of gaming set',                      language_count: 1, feature: 'Never Tell Me the Odds',   feature_desc: 'During downtime involving games of chance or tactical planning, you can get a solid sense of which choice is likely the best one and which opportunities seem too good to be true, at the DM\'s determination. Your instincts for probability are keen.' },
    { name: 'Plaintiff',                   skills: ['Medicine','Persuasion'],         skill_choice: null,                                                           tools: [],                                           tool_choice: "One type of artisan's tools",                 language_count: 1, feature: 'Legalese',                 feature_desc: 'You have knowledge of your local legal system and can employ sophisticated legal terminology to intimidate or deceive common folk who lack legal expertise, potentially obtaining favors or special treatment by making your position sound more legally sound than it may actually be.' },
    { name: 'Rival Intern',                skills: ['History','Investigation'],       skill_choice: null,                                                           tools: [],                                           tool_choice: "One type of artisan's tools",                 language_count: 1, feature: 'Inside Informant',         feature_desc: 'You maintain connections to your previous employer or other groups you dealt with during your prior employment. You can reach out to these contacts to obtain information, subject to the DM\'s approval regarding what intelligence becomes available to you.' },
    //  Plane Shift: Amonkhet 
    { name: 'Initiate',                    skills: ['Athletics','Intimidation'],      skill_choice: null,                                                           tools: ['Vehicles (land)'],                          tool_choice: 'One type of gaming set',                      language_count: 0, feature: 'Trial of the Five Gods',   feature_desc: 'You have constant access to training, along with shelter and meals provided by servitor mummies under vizier supervision, in preparation for the five trials. These benefits are conditional  you must obey Naktamun\'s societal norms, train, obey the gods\' orders, and follow vizier instructions.' },
    { name: 'Vizier',                      skills: ['History','Religion'],            skill_choice: null,                                                           tools: [],                                           tool_choice: "One type of artisan's tools and one musical instrument", language_count: 0, feature: 'Voice of Authority',       feature_desc: 'As a representative of your deity, your authority commands respect. Initiates are expected to obey your commands and defer to your judgment. However, abusing this power may result in divine punishment from your god.' },
    { name: 'Dissenter',                   skills: [],                                skill_choice: 'Use Initiate skills (Athletics, Intimidation) or Vizier skills (History, Religion) depending on which background you were before becoming a dissenter', tools: [], tool_choice: 'Use Initiate tools or Vizier tools depending on your base background', language_count: 0, feature: 'Shelter of Dissenters',    feature_desc: 'You can find a place to hide, rest, or recuperate among other dissenters. They will help shield you from those who hunt you, possibly even risking their lives for you. You lose the feature of your base background (Initiate or Vizier) and replace it with this one.' },
  ];
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO backgrounds (name,skills,skill_choice,tools,tool_choice,language_count,feature,feature_desc)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  backgrounds.forEach(b => {
    stmt.run([
      b.name,
      JSON.stringify(b.skills),
      b.skill_choice,
      JSON.stringify(b.tools),
      b.tool_choice,
      b.language_count,
      b.feature,
      b.feature_desc,
    ]);
  });
  stmt.free();

  // Prune orphaned loc_pos keys (visibility entries for location IDs that no longer exist).
  // These arise when a custom location is re-added to the DB under a different ID than its
  // original localStorage ID (e.g., Tumblerock Pass was ID 31 in localStorage, ID 30 in DB).
  try {
    const validIdsByRegion = {};
    dbGetAll('SELECT region, locations FROM region_content').forEach(r => {
      const rawLocs = safeJson(r.locations, []);
      validIdsByRegion[r.region] = new Set((Array.isArray(rawLocs) ? rawLocs : []).map(l => String(l.id)));
    });
    const specialKeys = new Set(['__party__', '__hexgrid__']);
    dbGetAll("SELECT town, loc_pos FROM town_state WHERE town LIKE '%_atlas'").forEach(r => {
      const validIds = validIdsByRegion[r.town.replace(/_atlas$/, '')];
      if (!validIds) return;
      const locPos = safeJson(r.loc_pos, {});
      let changed = false;
      Object.keys(locPos).forEach(k => {
        if (!specialKeys.has(k) && !validIds.has(k)) { delete locPos[k]; changed = true; }
      });
      if (changed) db.run('UPDATE town_state SET loc_pos = ? WHERE town = ?', [JSON.stringify(locPos), r.town]);
    });
  } catch(e) { console.error('locPos migration error:', e); }

  flush();
}

//  DEFAULT EQUIPMENT (seed for the equipment table; consumed by the NPC tool) 
const DEFAULT_EQUIPMENT = {
  weapons:[
    {name:'Club',cost:'1 sp',damage:'1d4',damageType:'bludgeoning',weight:2,type:'simple',properties:'light',edition:'5e'},
    {name:'Dagger',cost:'2 gp',damage:'1d4',damageType:'piercing',weight:1,type:'simple',properties:'finesse, light, thrown (20/60)',edition:'5e'},
    {name:'Greatclub',cost:'2 sp',damage:'1d8',damageType:'bludgeoning',weight:10,type:'simple',properties:'two-handed',edition:'5e'},
    {name:'Handaxe',cost:'5 gp',damage:'1d6',damageType:'slashing',weight:2,type:'simple',properties:'light, thrown (20/60)',edition:'5e'},
    {name:'Javelin',cost:'5 sp',damage:'1d6',damageType:'piercing',weight:2,type:'simple',properties:'thrown (30/120)',edition:'5e'},
    {name:'Light Hammer',cost:'2 gp',damage:'1d4',damageType:'bludgeoning',weight:2,type:'simple',properties:'light, thrown (20/60)',edition:'5e'},
    {name:'Mace',cost:'5 gp',damage:'1d6',damageType:'bludgeoning',weight:4,type:'simple',properties:'',edition:'5e'},
    {name:'Quarterstaff',cost:'2 sp',damage:'1d6',damageType:'bludgeoning',weight:4,type:'simple',properties:'versatile (1d8)',edition:'5e'},
    {name:'Sickle',cost:'1 gp',damage:'1d4',damageType:'slashing',weight:2,type:'simple',properties:'light',edition:'5e'},
    {name:'Spear',cost:'1 gp',damage:'1d6',damageType:'piercing',weight:3,type:'simple',properties:'thrown (20/60), versatile (1d8)',edition:'5e'},
    {name:'Light Crossbow',cost:'25 gp',damage:'1d8',damageType:'piercing',weight:5,type:'simple',properties:'ammunition (80/320), loading, two-handed',edition:'5e'},
    {name:'Dart',cost:'5 cp',damage:'1d4',damageType:'piercing',weight:0.25,type:'simple',properties:'finesse, thrown (20/60)',edition:'5e'},
    {name:'Shortbow',cost:'25 gp',damage:'1d6',damageType:'piercing',weight:2,type:'simple',properties:'ammunition (80/320), two-handed',edition:'5e'},
    {name:'Sling',cost:'1 sp',damage:'1d4',damageType:'bludgeoning',weight:0,type:'simple',properties:'ammunition (30/120)',edition:'5e'},
    {name:'Battleaxe',cost:'10 gp',damage:'1d8',damageType:'slashing',weight:4,type:'martial',properties:'versatile (1d10)',edition:'5e'},
    {name:'Flail',cost:'10 gp',damage:'1d8',damageType:'bludgeoning',weight:2,type:'martial',properties:'',edition:'5e'},
    {name:'Glaive',cost:'20 gp',damage:'1d10',damageType:'slashing',weight:6,type:'martial',properties:'heavy, reach, two-handed',edition:'5e'},
    {name:'Greataxe',cost:'30 gp',damage:'1d12',damageType:'slashing',weight:7,type:'martial',properties:'heavy, two-handed',edition:'5e'},
    {name:'Greatsword',cost:'50 gp',damage:'2d6',damageType:'slashing',weight:6,type:'martial',properties:'heavy, two-handed',edition:'5e'},
    {name:'Halberd',cost:'20 gp',damage:'1d10',damageType:'slashing',weight:6,type:'martial',properties:'heavy, reach, two-handed',edition:'5e'},
    {name:'Lance',cost:'10 gp',damage:'1d12',damageType:'piercing',weight:6,type:'martial',properties:'reach, special',edition:'5e'},
    {name:'Longsword',cost:'15 gp',damage:'1d8',damageType:'slashing',weight:3,type:'martial',properties:'versatile (1d10)',edition:'5e'},
    {name:'Maul',cost:'10 gp',damage:'2d6',damageType:'bludgeoning',weight:10,type:'martial',properties:'heavy, two-handed',edition:'5e'},
    {name:'Morningstar',cost:'15 gp',damage:'1d8',damageType:'piercing',weight:4,type:'martial',properties:'',edition:'5e'},
    {name:'Pike',cost:'5 gp',damage:'1d10',damageType:'piercing',weight:18,type:'martial',properties:'heavy, reach, two-handed',edition:'5e'},
    {name:'Rapier',cost:'25 gp',damage:'1d8',damageType:'piercing',weight:2,type:'martial',properties:'finesse',edition:'5e'},
    {name:'Scimitar',cost:'25 gp',damage:'1d6',damageType:'slashing',weight:3,type:'martial',properties:'finesse, light',edition:'5e'},
    {name:'Shortsword',cost:'10 gp',damage:'1d6',damageType:'piercing',weight:2,type:'martial',properties:'finesse, light',edition:'5e'},
    {name:'Trident',cost:'5 gp',damage:'1d6',damageType:'piercing',weight:4,type:'martial',properties:'thrown (20/60), versatile (1d8)',edition:'5e'},
    {name:'War Pick',cost:'5 gp',damage:'1d8',damageType:'piercing',weight:2,type:'martial',properties:'',edition:'5e'},
    {name:'Warhammer',cost:'15 gp',damage:'1d8',damageType:'bludgeoning',weight:2,type:'martial',properties:'versatile (1d10)',edition:'5e'},
    {name:'Whip',cost:'2 gp',damage:'1d4',damageType:'slashing',weight:3,type:'martial',properties:'finesse, reach',edition:'5e'},
    {name:'Blowgun',cost:'10 gp',damage:'1',damageType:'piercing',weight:1,type:'martial',properties:'ammunition (25/100), loading',edition:'5e'},
    {name:'Hand Crossbow',cost:'75 gp',damage:'1d6',damageType:'piercing',weight:3,type:'martial',properties:'ammunition (30/120), light, loading',edition:'5e'},
    {name:'Heavy Crossbow',cost:'50 gp',damage:'1d10',damageType:'piercing',weight:18,type:'martial',properties:'ammunition (100/400), heavy, loading, two-handed',edition:'5e'},
    {name:'Longbow',cost:'50 gp',damage:'1d8',damageType:'piercing',weight:2,type:'martial',properties:'ammunition (150/600), heavy, two-handed',edition:'5e'},
    {name:'Net',cost:'1 gp',damage:'',damageType:'',weight:3,type:'martial',properties:'special, thrown (5/15)',edition:'5e'},
    {name:'Bastard Sword',cost:'35 gp',damage:'1d10',damageType:'slashing',weight:6,type:'exotic',properties:'versatile (two-handed)',edition:'3.5e'},
    {name:'Dwarven Waraxe',cost:'30 gp',damage:'1d10',damageType:'slashing',weight:8,type:'exotic',properties:'versatile (two-handed)',edition:'3.5e'},
    {name:'Spiked Chain',cost:'25 gp',damage:'2d4',damageType:'piercing',weight:10,type:'exotic',properties:'disarm, reach, trip',edition:'3.5e'},
    {name:'Two-Bladed Sword',cost:'100 gp',damage:'1d8',damageType:'slashing',weight:10,type:'exotic',properties:'double weapon (1d8/1d8)',edition:'3.5e'},
    {name:'Orc Double Axe',cost:'60 gp',damage:'1d8',damageType:'slashing',weight:15,type:'exotic',properties:'double weapon',edition:'3.5e'},
    {name:'Gnome Hooked Hammer',cost:'20 gp',damage:'1d6',damageType:'bludgeoning',weight:6,type:'exotic',properties:'double weapon (1d4 piercing), trip',edition:'3.5e'},
    {name:'Dire Flail',cost:'90 gp',damage:'1d8',damageType:'bludgeoning',weight:10,type:'exotic',properties:'double weapon, disarm',edition:'3.5e'},
    {name:'Sai',cost:'1 gp',damage:'1d4',damageType:'piercing',weight:1,type:'exotic',properties:'disarm',edition:'3.5e'},
    {name:'Kama',cost:'2 gp',damage:'1d6',damageType:'slashing',weight:2,type:'exotic',properties:'trip',edition:'3.5e'},
    {name:'Nunchaku',cost:'2 gp',damage:'1d6',damageType:'bludgeoning',weight:2,type:'exotic',properties:'disarm',edition:'3.5e'},
    {name:'Siangham',cost:'3 gp',damage:'1d6',damageType:'piercing',weight:1,type:'exotic',properties:'',edition:'3.5e'},
    {name:'Bolas',cost:'5 gp',damage:'1d4',damageType:'bludgeoning',weight:2,type:'exotic',properties:'thrown (10/20), trip',edition:'3.5e'},
    {name:'Shuriken',cost:'1 gp',damage:'1d2',damageType:'piercing',weight:0.5,type:'exotic',properties:'thrown (10/30) x5',edition:'3.5e'},
    {name:'Repeating Light Crossbow',cost:'250 gp',damage:'1d8',damageType:'piercing',weight:6,type:'exotic',properties:'ammunition (80/320)',edition:'3.5e'},
    {name:'Repeating Heavy Crossbow',cost:'400 gp',damage:'1d10',damageType:'piercing',weight:12,type:'exotic',properties:'ammunition (120/480)',edition:'3.5e'},
    {name:'Elven Thinblade',cost:'100 gp',damage:'1d8',damageType:'slashing',weight:2,type:'exotic',properties:'finesse',edition:'3.5e'},
    {name:'Elven Courtblade',cost:'150 gp',damage:'1d10',damageType:'slashing',weight:4,type:'exotic',properties:'two-handed, finesse',edition:'3.5e'},
    {name:'Gnome Quickrazor',cost:'100 gp',damage:'1d4',damageType:'piercing',weight:1,type:'exotic',properties:'finesse, light',edition:'3.5e'},
    {name:'Halfling Skiprock',cost:'1 gp',damage:'1d4',damageType:'bludgeoning',weight:0,type:'exotic',properties:'thrown (10/20)',edition:'3.5e'},
    {name:'Dwarven Urgosh',cost:'50 gp',damage:'1d8',damageType:'slashing',weight:12,type:'exotic',properties:'double weapon (1d6 piercing)',edition:'3.5e'},
  ],
  armor:[
    {name:'Padded',cost:'5 gp',ac:11,weight:8,type:'light',strength:0,notes:'Stealth disadvantage',edition:'5e'},
    {name:'Leather',cost:'10 gp',ac:11,weight:10,type:'light',strength:0,notes:'',edition:'5e'},
    {name:'Studded Leather',cost:'45 gp',ac:12,weight:13,type:'light',strength:0,notes:'',edition:'5e'},
    {name:'Hide',cost:'10 gp',ac:12,weight:12,type:'medium',strength:0,notes:'Max Dex +2',edition:'5e'},
    {name:'Chain Shirt',cost:'50 gp',ac:13,weight:20,type:'medium',strength:0,notes:'Max Dex +2',edition:'5e'},
    {name:'Scale Mail',cost:'50 gp',ac:14,weight:45,type:'medium',strength:0,notes:'Max Dex +2; stealth disadvantage',edition:'5e'},
    {name:'Breastplate',cost:'400 gp',ac:14,weight:20,type:'medium',strength:0,notes:'Max Dex +2',edition:'5e'},
    {name:'Half Plate',cost:'750 gp',ac:15,weight:40,type:'medium',strength:0,notes:'Max Dex +2; stealth disadvantage',edition:'5e'},
    {name:'Ring Mail',cost:'30 gp',ac:14,weight:40,type:'heavy',strength:0,notes:'Stealth disadvantage',edition:'5e'},
    {name:'Chain Mail',cost:'75 gp',ac:16,weight:55,type:'heavy',strength:13,notes:'Stealth disadvantage',edition:'5e'},
    {name:'Splint',cost:'200 gp',ac:17,weight:60,type:'heavy',strength:15,notes:'Stealth disadvantage',edition:'5e'},
    {name:'Plate',cost:'1500 gp',ac:18,weight:65,type:'heavy',strength:15,notes:'Stealth disadvantage',edition:'5e'},
    {name:'Shield',cost:'10 gp',ac:2,weight:6,type:'shield',strength:0,notes:'+2 AC bonus',edition:'5e'},
    {name:'Banded Mail',cost:'250 gp',ac:16,weight:35,type:'heavy',strength:0,notes:'Stealth disadvantage [3.5e]',edition:'3.5e'},
    {name:'Mithral Shirt',cost:'1100 gp',ac:13,weight:10,type:'light',strength:0,notes:'Max Dex +6 [3.5e]',edition:'3.5e'},
    {name:'Adamantine Full Plate',cost:'16500 gp',ac:18,weight:50,type:'heavy',strength:0,notes:'Negates critical hits [3.5e]',edition:'3.5e'},
  ],
  utility:[
    {name:'Abacus',cost:'2 gp',weight:2,notes:'',edition:'5e'},
    {name:'Acid (vial)',cost:'25 gp',weight:1,notes:'2d6 acid damage on hit',edition:'5e'},
    {name:"Alchemist's Fire",cost:'50 gp',weight:1,notes:'1d4 fire damage + 1d4/turn until extinguished',edition:'5e'},
    {name:'Antitoxin',cost:'50 gp',weight:0,notes:'Advantage vs. poison for 1 hour',edition:'5e'},
    {name:'Arcane Focus (Crystal)',cost:'10 gp',weight:1,notes:'Channels arcane spells',edition:'5e'},
    {name:'Arcane Focus (Orb)',cost:'20 gp',weight:3,notes:'Channels arcane spells',edition:'5e'},
    {name:'Arcane Focus (Rod)',cost:'10 gp',weight:2,notes:'Channels arcane spells',edition:'5e'},
    {name:'Arcane Focus (Staff)',cost:'5 gp',weight:4,notes:'Channels arcane spells',edition:'5e'},
    {name:'Arcane Focus (Wand)',cost:'10 gp',weight:1,notes:'Channels arcane spells',edition:'5e'},
    {name:'Arrows (20)',cost:'1 gp',weight:1,notes:'Ammunition for bows',edition:'5e'},
    {name:'Backpack',cost:'2 gp',weight:5,notes:'Holds 1 cubic foot / 30 lbs',edition:'5e'},
    {name:'Ball Bearings (1,000)',cost:'1 gp',weight:2,notes:'DC 10 Dex save or fall prone in 10x10 area',edition:'5e'},
    {name:'Barrel',cost:'2 gp',weight:70,notes:'Holds 40 gallons liquid or 4 cubic feet solid',edition:'5e'},
    {name:'Basket',cost:'4 sp',weight:2,notes:'Holds 2 cubic feet / 40 lbs',edition:'5e'},
    {name:'Bedroll',cost:'1 gp',weight:7,notes:'',edition:'5e'},
    {name:'Bell',cost:'1 gp',weight:0,notes:'',edition:'5e'},
    {name:'Blanket',cost:'5 sp',weight:3,notes:'',edition:'5e'},
    {name:'Block and Tackle',cost:'1 gp',weight:5,notes:'Hoists four times normal lifting capacity',edition:'5e'},
    {name:'Blowgun Needles (50)',cost:'1 gp',weight:1,notes:'Ammunition for blowgun',edition:'5e'},
    {name:'Book',cost:'25 gp',weight:5,notes:'Contains written or illustrated content',edition:'5e'},
    {name:'Bottle, Glass',cost:'2 gp',weight:2,notes:'Holds 1.5 pints',edition:'5e'},
    {name:'Bucket',cost:'5 cp',weight:2,notes:'Holds 3 gallons liquid or 0.5 cubic foot solid',edition:'5e'},
    {name:'Caltrops (20)',cost:'1 gp',weight:2,notes:'DC 15 Dex save or stop + 1 piercing damage in 5x5 area',edition:'5e'},
    {name:'Candle',cost:'1 cp',weight:0,notes:'Bright 5 ft, dim 10 ft for 1 hour',edition:'5e'},
    {name:'Case, Crossbow Bolt',cost:'1 gp',weight:1,notes:'Holds 20 bolts',edition:'5e'},
    {name:'Case, Map or Scroll',cost:'1 gp',weight:1,notes:'Holds 10 sheets paper or 5 sheets parchment',edition:'5e'},
    {name:'Chain (10 ft)',cost:'5 gp',weight:10,notes:'10 HP, burst DC 20 Strength',edition:'5e'},
    {name:'Chalk',cost:'1 cp',weight:0,notes:'',edition:'5e'},
    {name:'Chest',cost:'5 gp',weight:25,notes:'Holds 12 cubic feet / 300 lbs',edition:'5e'},
    {name:"Climber's Kit",cost:'25 gp',weight:12,notes:'Pitons, boot tips, gloves, harness; anchor within 25 ft',edition:'5e'},
    {name:'Clothes, Common',cost:'5 sp',weight:3,notes:'',edition:'5e'},
    {name:'Clothes, Costume',cost:'5 gp',weight:4,notes:'',edition:'5e'},
    {name:'Clothes, Fine',cost:'15 gp',weight:6,notes:'',edition:'5e'},
    {name:"Clothes, Traveler's",cost:'2 gp',weight:4,notes:'',edition:'5e'},
    {name:'Component Pouch',cost:'25 gp',weight:2,notes:'Holds spell material components',edition:'5e'},
    {name:'Crossbow Bolts (20)',cost:'1 gp',weight:1.5,notes:'Ammunition for crossbows',edition:'5e'},
    {name:'Crowbar',cost:'2 gp',weight:5,notes:'Advantage on Strength checks for prying',edition:'5e'},
    {name:'Disguise Kit',cost:'25 gp',weight:3,notes:'',edition:'5e'},
    {name:'Druidic Focus (Mistletoe)',cost:'1 gp',weight:0,notes:'Channels druid spells',edition:'5e'},
    {name:'Druidic Focus (Totem)',cost:'1 gp',weight:0,notes:'Channels druid spells',edition:'5e'},
    {name:'Druidic Focus (Staff)',cost:'5 gp',weight:4,notes:'Channels druid spells',edition:'5e'},
    {name:'Druidic Focus (Wand)',cost:'10 gp',weight:1,notes:'Channels druid spells',edition:'5e'},
    {name:'Fishing Tackle',cost:'1 gp',weight:4,notes:'Rod, line, bobbers, hooks, sinkers, lures, netting',edition:'5e'},
    {name:'Flask or Tankard',cost:'2 cp',weight:1,notes:'Holds 1 pint',edition:'5e'},
    {name:'Forgery Kit',cost:'15 gp',weight:5,notes:'',edition:'5e'},
    {name:'Grappling Hook',cost:'2 gp',weight:4,notes:'',edition:'5e'},
    {name:'Hammer',cost:'1 gp',weight:3,notes:'',edition:'5e'},
    {name:'Hammer, Sledge',cost:'2 gp',weight:10,notes:'',edition:'5e'},
    {name:"Healer's Kit",cost:'5 gp',weight:3,notes:'10 uses; stabilize creature at 0 HP',edition:'5e'},
    {name:'Herbalism Kit',cost:'5 gp',weight:3,notes:'',edition:'5e'},
    {name:'Holy Symbol (Amulet)',cost:'5 gp',weight:1,notes:'',edition:'5e'},
    {name:'Holy Symbol (Emblem)',cost:'5 gp',weight:0,notes:'',edition:'5e'},
    {name:'Holy Symbol (Reliquary)',cost:'5 gp',weight:2,notes:'',edition:'5e'},
    {name:'Holy Water',cost:'25 gp',weight:1,notes:'2d6 radiant damage to fiend/undead',edition:'5e'},
    {name:'Hourglass',cost:'25 gp',weight:1,notes:'Measures time passage',edition:'5e'},
    {name:'Hunting Trap',cost:'5 gp',weight:25,notes:'DC 13 Dex save or 1d4 piercing + restrained',edition:'5e'},
    {name:'Ink (1 oz)',cost:'10 gp',weight:0,notes:'',edition:'5e'},
    {name:'Ink Pen',cost:'2 cp',weight:0,notes:'',edition:'5e'},
    {name:'Jug or Pitcher',cost:'2 cp',weight:4,notes:'Holds 1 gallon',edition:'5e'},
    {name:'Ladder (10 ft)',cost:'1 sp',weight:25,notes:'',edition:'5e'},
    {name:'Lamp',cost:'5 sp',weight:1,notes:'Bright 15 ft, dim 30 ft; 6 hours per flask',edition:'5e'},
    {name:'Lantern, Bullseye',cost:'10 gp',weight:2,notes:'Bright 60-ft cone, dim 60 ft; 6 hours',edition:'5e'},
    {name:'Lantern, Hooded',cost:'5 gp',weight:2,notes:'Bright 30 ft, dim 30 ft; lowers to 5-ft radius',edition:'5e'},
    {name:'Lock',cost:'10 gp',weight:1,notes:'Pick DC 15 Dexterity',edition:'5e'},
    {name:'Magnifying Glass',cost:'100 gp',weight:0,notes:'Advantage appraising small items; fire-starting',edition:'5e'},
    {name:'Manacles',cost:'2 gp',weight:6,notes:'Escape DC 20 Dex, break DC 20 Str; 15 HP',edition:'5e'},
    {name:'Mess Kit',cost:'2 sp',weight:1,notes:'Cup, cutlery, cooking pan, plate',edition:'5e'},
    {name:'Mirror, Steel',cost:'5 gp',weight:0.5,notes:'',edition:'5e'},
    {name:'Oil (flask)',cost:'1 sp',weight:1,notes:'Burns 2 rounds, deals 5 fire damage in 5x5 area',edition:'5e'},
    {name:'Paper',cost:'2 sp',weight:0,notes:'',edition:'5e'},
    {name:'Parchment',cost:'1 sp',weight:0,notes:'',edition:'5e'},
    {name:'Perfume',cost:'5 gp',weight:0,notes:'',edition:'5e'},
    {name:"Pick, Miner's",cost:'2 gp',weight:10,notes:'',edition:'5e'},
    {name:'Piton',cost:'5 cp',weight:0.25,notes:'',edition:'5e'},
    {name:"Poisoner's Kit",cost:'50 gp',weight:2,notes:'',edition:'5e'},
    {name:'Poison, Basic',cost:'100 gp',weight:0,notes:'Coats one weapon; DC 10 save or 1d4 poison damage',edition:'5e'},
    {name:'Pole (10 ft)',cost:'5 cp',weight:7,notes:'',edition:'5e'},
    {name:'Pot, Iron',cost:'2 gp',weight:10,notes:'Holds 1 gallon',edition:'5e'},
    {name:'Potion of Healing',cost:'50 gp',weight:0.5,notes:'Restores 2d4+2 HP',edition:'5e'},
    {name:'Pouch',cost:'5 sp',weight:1,notes:'Holds 20 sling bullets or 50 blowgun needles',edition:'5e'},
    {name:'Quiver',cost:'1 gp',weight:1,notes:'Holds 20 arrows',edition:'5e'},
    {name:'Ram, Portable',cost:'4 gp',weight:35,notes:'+4 bonus breaking down doors',edition:'5e'},
    {name:'Rations (1 day)',cost:'5 sp',weight:2,notes:'Dry foods for travel',edition:'5e'},
    {name:'Robes',cost:'1 gp',weight:4,notes:'',edition:'5e'},
    {name:'Rope, Hempen (50 ft)',cost:'1 gp',weight:10,notes:'2 HP, burst DC 17 Strength',edition:'5e'},
    {name:'Rope, Silk (50 ft)',cost:'10 gp',weight:5,notes:'2 HP, burst DC 17 Strength',edition:'5e'},
    {name:'Sack',cost:'1 cp',weight:0.5,notes:'Holds 1 cubic foot / 30 lbs',edition:'5e'},
    {name:"Scale, Merchant's",cost:'5 gp',weight:3,notes:'Balance, pans, weights up to 2 lbs',edition:'5e'},
    {name:'Sealing Wax',cost:'5 sp',weight:0,notes:'',edition:'5e'},
    {name:'Shovel',cost:'2 gp',weight:5,notes:'',edition:'5e'},
    {name:'Signal Whistle',cost:'5 cp',weight:0,notes:'',edition:'5e'},
    {name:'Signet Ring',cost:'5 gp',weight:0,notes:'',edition:'5e'},
    {name:'Sling Bullets (20)',cost:'4 cp',weight:1.5,notes:'Ammunition for slings',edition:'5e'},
    {name:'Soap',cost:'2 cp',weight:0,notes:'',edition:'5e'},
    {name:'Spellbook',cost:'50 gp',weight:3,notes:'Leather tome with 100 blank vellum pages',edition:'5e'},
    {name:'Spikes, Iron (10)',cost:'1 gp',weight:5,notes:'',edition:'5e'},
    {name:'Spyglass',cost:'1000 gp',weight:1,notes:'Magnifies objects to twice size',edition:'5e'},
    {name:'Tent, Two-Person',cost:'2 gp',weight:20,notes:'Portable canvas shelter',edition:'5e'},
    {name:'Tinderbox',cost:'5 sp',weight:1,notes:'Lights torch as action, other fires in 1 minute',edition:'5e'},
    {name:'Torch',cost:'1 cp',weight:1,notes:'Bright 20 ft, dim 20 ft for 1 hour; 1 fire damage as weapon',edition:'5e'},
    {name:'Vial',cost:'1 gp',weight:0,notes:'Holds 4 ounces',edition:'5e'},
    {name:'Waterskin',cost:'2 sp',weight:5,notes:'Holds 4 pints (full weight)',edition:'5e'},
    {name:'Whetstone',cost:'1 cp',weight:1,notes:'',edition:'5e'},
    {name:"Alchemist's Frost",cost:'20 gp',weight:1,notes:'1d6 cold damage, creates slippery surface [3.5e]',edition:'3.5e'},
    {name:'Smokestick',cost:'20 gp',weight:0.5,notes:'Instant smoke cloud, 10-ft radius [3.5e]',edition:'3.5e'},
    {name:'Sunrod',cost:'2 gp',weight:1,notes:'Bright light 30 ft, dim 60 ft for 6 hours [3.5e]',edition:'3.5e'},
    {name:'Tanglefoot Bag',cost:'50 gp',weight:4,notes:'Entangles target on hit, DC 15 Str to break free [3.5e]',edition:'3.5e'},
    {name:'Thunderstone',cost:'30 gp',weight:1,notes:'DC 15 Fort save or deafened 1 hour in 10-ft burst [3.5e]',edition:'3.5e'},
    {name:'Tindertwig',cost:'1 gp',weight:0,notes:'Strike to ignite as free action [3.5e]',edition:'3.5e'},
    {name:'Everburning Torch',cost:'110 gp',weight:1,notes:'Permanent light effect [3.5e]',edition:'3.5e'},
    {name:'Marbles (bag)',cost:'1 sp',weight:2,notes:'Scatter on floor; creatures must pass balance check [3.5e]',edition:'3.5e'},
    {name:'Universal Solvent',cost:'50 gp',weight:0,notes:'Dissolves sovereign glue or similar adhesive [3.5e]',edition:'3.5e'},
  ]
};

function seedEquipment() {
  const existing = dbGetOne('SELECT COUNT(*) AS n FROM equipment', []);
  if (existing && existing.n > 0) return;
  const stmt = db.prepare('INSERT INTO equipment (category, sort_order, data) VALUES (?,?,?)');
  ['weapons','armor','utility'].forEach(cat => {
    (DEFAULT_EQUIPMENT[cat] || []).forEach((item, i) => stmt.run([cat, i, JSON.stringify(item)]));
  });
  stmt.free();
}

// D&D 5e races (2014 ruleset). Each entry is self-contained (subraces are separate
// selectable entries with their full ability set) so applying one needs no merging.
//   ability        { str,dex,con,int,wis,cha } fixed ability-score increases
//   abilityChoice  human/half-elf style "choose +N to X abilities" note (text)
//   size, speed, darkvision (ft; 0 = none)
//   skills         granted skill proficiencies (ticked on the sheet)
//   languages      known languages;  languageChoice = extra languages to pick
//   traits         [{ name, desc }] racial features appended to Features & Traits
const RACES = [
  //  PHB
  { name:'Dwarf (Hill)', source:'PHB', ability:{con:2,wis:1}, size:'Medium', speed:25, darkvision:60, skills:[], languages:['Common','Dwarvish'], languageChoice:0, traits:[
    { name:'Dwarven Resilience', desc:'Advantage on saving throws against poison, and resistance to poison damage.' },
    { name:'Dwarven Combat Training', desc:'Proficiency with battleaxe, handaxe, light hammer, and warhammer.' },
    { name:'Tool Proficiency', desc:"Proficiency with one artisan's tool: smith's, brewer's, or mason's tools." },
    { name:'Stonecunning', desc:'Double proficiency bonus on History checks related to the origin of stonework.' },
    { name:'Dwarven Toughness', desc:'Your hit point maximum increases by 1, and by 1 every time you gain a level.' },
    { name:'Speed', desc:'Your speed is not reduced by wearing heavy armor.' },
  ]},
  { name:'Dwarf (Mountain)', source:'PHB', ability:{str:2,con:2}, size:'Medium', speed:25, darkvision:60, skills:[], languages:['Common','Dwarvish'], languageChoice:0, traits:[
    { name:'Dwarven Resilience', desc:'Advantage on saving throws against poison, and resistance to poison damage.' },
    { name:'Dwarven Combat Training', desc:'Proficiency with battleaxe, handaxe, light hammer, and warhammer.' },
    { name:'Dwarven Armor Training', desc:'Proficiency with light and medium armor.' },
    { name:'Stonecunning', desc:'Double proficiency bonus on History checks related to the origin of stonework.' },
    { name:'Speed', desc:'Your speed is not reduced by wearing heavy armor.' },
  ]},
  { name:'Elf (High)', source:'PHB', ability:{dex:2,int:1}, size:'Medium', speed:30, darkvision:60, skills:['Perception'], languages:['Common','Elvish'], languageChoice:1, traits:[
    { name:'Fey Ancestry', desc:'Advantage on saving throws against being charmed; magic can\'t put you to sleep.' },
    { name:'Trance', desc:'You meditate 4 hours instead of sleeping 8, and gain the benefit of a long rest.' },
    { name:'Keen Senses', desc:'Proficiency in the Perception skill.' },
    { name:'Cantrip', desc:'You know one cantrip of your choice from the wizard spell list (Intelligence is the ability).' },
  ]},
  { name:'Elf (Wood)', source:'PHB', ability:{dex:2,wis:1}, size:'Medium', speed:35, darkvision:60, skills:['Perception'], languages:['Common','Elvish'], languageChoice:0, traits:[
    { name:'Fey Ancestry', desc:'Advantage on saving throws against being charmed; magic can\'t put you to sleep.' },
    { name:'Trance', desc:'You meditate 4 hours instead of sleeping 8, and gain the benefit of a long rest.' },
    { name:'Keen Senses', desc:'Proficiency in the Perception skill.' },
    { name:'Mask of the Wild', desc:'You can attempt to hide even when only lightly obscured by natural phenomena.' },
  ]},
  { name:'Elf (Drow)', source:'PHB', ability:{dex:2,cha:1}, size:'Medium', speed:30, darkvision:120, skills:['Perception'], languages:['Common','Elvish'], languageChoice:0, traits:[
    { name:'Fey Ancestry', desc:'Advantage on saving throws against being charmed; magic can\'t put you to sleep.' },
    { name:'Superior Darkvision', desc:'Your darkvision has a range of 120 feet.' },
    { name:'Sunlight Sensitivity', desc:'Disadvantage on attack rolls and Perception (sight) in direct sunlight.' },
    { name:'Drow Magic', desc:'You know dancing lights; at 3rd level faerie fire, at 5th level darkness (Charisma).' },
    { name:'Drow Weapon Training', desc:'Proficiency with rapiers, shortswords, and hand crossbows.' },
    { name:'Keen Senses', desc:'Proficiency in the Perception skill.' },
  ]},
  { name:'Halfling (Lightfoot)', source:'PHB', ability:{dex:2,cha:1}, size:'Small', speed:25, darkvision:0, skills:[], languages:['Common','Halfling'], languageChoice:0, traits:[
    { name:'Lucky', desc:'When you roll a 1 on a d20 attack, ability check, or save, you may reroll and must use the new roll.' },
    { name:'Brave', desc:'Advantage on saving throws against being frightened.' },
    { name:'Halfling Nimbleness', desc:'You can move through the space of any creature larger than you.' },
    { name:'Naturally Stealthy', desc:'You can attempt to hide even when obscured only by a creature at least one size larger.' },
  ]},
  { name:'Halfling (Stout)', source:'PHB', ability:{dex:2,con:1}, size:'Small', speed:25, darkvision:0, skills:[], languages:['Common','Halfling'], languageChoice:0, traits:[
    { name:'Lucky', desc:'When you roll a 1 on a d20 attack, ability check, or save, you may reroll and must use the new roll.' },
    { name:'Brave', desc:'Advantage on saving throws against being frightened.' },
    { name:'Halfling Nimbleness', desc:'You can move through the space of any creature larger than you.' },
    { name:'Stout Resilience', desc:'Advantage on saves against poison, and resistance to poison damage.' },
  ]},
  { name:'Human', source:'PHB', ability:{str:1,dex:1,con:1,int:1,wis:1,cha:1}, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common'], languageChoice:1, traits:[] },
  { name:'Human (Variant)', source:'PHB', ability:{}, choiceAbility:{ pick:2, from:'all', amount:1 }, choiceSkill:{ pick:1, from:'all' }, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common'], languageChoice:1, traits:[
    { name:'Feat', desc:'You gain one feat of your choice (add it manually).' },
  ]},
  { name:'Dragonborn', source:'PHB', ability:{str:2,cha:1}, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Draconic'], languageChoice:0, traits:[
    { name:'Draconic Ancestry', desc:'Choose a dragon type; it sets your breath weapon and damage resistance.' },
    { name:'Breath Weapon', desc:'Action: exhale destructive energy (Dex or Con save, 2d6, scales with level).' },
    { name:'Damage Resistance', desc:'Resistance to the damage type of your draconic ancestry.' },
  ]},
  { name:'Gnome (Forest)', source:'PHB', ability:{int:2,dex:1}, size:'Small', speed:25, darkvision:60, skills:[], languages:['Common','Gnomish'], languageChoice:0, traits:[
    { name:'Gnome Cunning', desc:'Advantage on Int, Wis, and Cha saving throws against magic.' },
    { name:'Natural Illusionist', desc:'You know the minor illusion cantrip (Intelligence is the ability).' },
    { name:'Speak with Small Beasts', desc:'You can communicate simple ideas with Small or smaller beasts.' },
  ]},
  { name:'Gnome (Rock)', source:'PHB', ability:{int:2,con:1}, size:'Small', speed:25, darkvision:60, skills:[], languages:['Common','Gnomish'], languageChoice:0, traits:[
    { name:'Gnome Cunning', desc:'Advantage on Int, Wis, and Cha saving throws against magic.' },
    { name:"Artificer's Lore", desc:'Double proficiency bonus on History checks about magic items, alchemy, or tech devices.' },
    { name:'Tinker', desc:"Proficiency with tinker's tools; you can build tiny clockwork devices." },
  ]},
  { name:'Half-Elf', source:'PHB', ability:{cha:2}, choiceAbility:{ pick:2, from:'all', amount:1 }, choiceSkill:{ pick:2, from:'all' }, size:'Medium', speed:30, darkvision:60, skills:[], languages:['Common','Elvish'], languageChoice:1, traits:[
    { name:'Fey Ancestry', desc:'Advantage on saving throws against being charmed; magic can\'t put you to sleep.' },
    { name:'Skill Versatility', desc:'Proficiency in two skills of your choice (assign via Choices).' },
  ]},
  { name:'Half-Orc', source:'PHB', ability:{str:2,con:1}, size:'Medium', speed:30, darkvision:60, skills:['Intimidation'], languages:['Common','Orc'], languageChoice:0, traits:[
    { name:'Relentless Endurance', desc:'When reduced to 0 HP but not killed, you drop to 1 HP instead (once per long rest).' },
    { name:'Savage Attacks', desc:'On a melee critical hit, roll one of the weapon\'s damage dice one extra time.' },
    { name:'Menacing', desc:'Proficiency in the Intimidation skill.' },
  ]},
  { name:'Tiefling', source:'PHB', ability:{int:1,cha:2}, size:'Medium', speed:30, darkvision:60, skills:[], languages:['Common','Infernal'], languageChoice:0, traits:[
    { name:'Hellish Resistance', desc:'Resistance to fire damage.' },
    { name:'Infernal Legacy', desc:'You know thaumaturgy; at 3rd level hellish rebuke, at 5th level darkness (Charisma).' },
  ]},
  //  Volo's / Mordenkainen's (popular)
  { name:'Aasimar (Protector)', source:"Volo's", ability:{wis:1,cha:2}, size:'Medium', speed:30, darkvision:60, skills:[], languages:['Common','Celestial'], languageChoice:0, traits:[
    { name:'Celestial Resistance', desc:'Resistance to necrotic and radiant damage.' },
    { name:'Healing Hands', desc:'Touch to heal HP equal to your level (once per long rest).' },
    { name:'Light Bearer', desc:'You know the light cantrip (Charisma is the ability).' },
    { name:'Radiant Soul', desc:'From 3rd level: transform to sprout wings (fly 30 ft) and deal extra radiant damage.' },
  ]},
  { name:'Aasimar (Scourge)', source:"Volo's", ability:{con:1,cha:2}, size:'Medium', speed:30, darkvision:60, skills:[], languages:['Common','Celestial'], languageChoice:0, traits:[
    { name:'Celestial Resistance', desc:'Resistance to necrotic and radiant damage.' },
    { name:'Healing Hands', desc:'Touch to heal HP equal to your level (once per long rest).' },
    { name:'Light Bearer', desc:'You know the light cantrip (Charisma is the ability).' },
    { name:'Radiant Consumption', desc:'From 3rd level: emit searing light dealing radiant damage to nearby creatures and yourself.' },
  ]},
  { name:'Aasimar (Fallen)', source:"Volo's", ability:{str:1,cha:2}, size:'Medium', speed:30, darkvision:60, skills:[], languages:['Common','Celestial'], languageChoice:0, traits:[
    { name:'Celestial Resistance', desc:'Resistance to necrotic and radiant damage.' },
    { name:'Healing Hands', desc:'Touch to heal HP equal to your level (once per long rest).' },
    { name:'Light Bearer', desc:'You know the light cantrip (Charisma is the ability).' },
    { name:'Necrotic Shroud', desc:'From 3rd level: unleash spectral wings, frightening nearby foes and dealing extra necrotic damage.' },
  ]},
  { name:'Goliath', source:"Volo's", ability:{str:2,con:1}, size:'Medium', speed:30, darkvision:0, skills:['Athletics'], languages:['Common','Giant'], languageChoice:0, traits:[
    { name:'Stone’s Endurance', desc:'Reaction to reduce damage by 1d12 + your Con modifier (once per short rest).' },
    { name:'Powerful Build', desc:'Count as one size larger for carrying capacity and lifting/pushing/dragging.' },
    { name:'Mountain Born', desc:'Resistance to cold; acclimated to high altitude and cold climates.' },
    { name:'Natural Athlete', desc:'Proficiency in the Athletics skill.' },
  ]},
  { name:'Firbolg', source:"Volo's", ability:{wis:2,str:1}, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Elvish','Giant'], languageChoice:0, traits:[
    { name:'Firbolg Magic', desc:'You can cast detect magic and disguise self once each per short rest (Wisdom).' },
    { name:'Hidden Step', desc:'Bonus action to turn invisible until your next turn (once per short rest).' },
    { name:'Powerful Build', desc:'Count as one size larger for carrying capacity and lifting/pushing/dragging.' },
    { name:'Speech of Beast and Leaf', desc:'You can communicate simple ideas to beasts and plants; advantage on Charisma checks to influence them.' },
  ]},
  { name:'Kenku', source:"Volo's", ability:{dex:2,wis:1}, choiceSkill:{ pick:2, from:['Acrobatics','Deception','Stealth','Sleight of Hand'] }, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Auran'], languageChoice:0, traits:[
    { name:'Expert Forgery', desc:'Advantage on checks to duplicate an object or piece of handwriting you have seen.' },
    { name:'Kenku Training', desc:'Proficiency in two of: Acrobatics, Deception, Stealth, Sleight of Hand (assign via Choices).' },
    { name:'Mimicry', desc:'You can mimic sounds you have heard, including voices (Deception vs Insight to detect).' },
  ]},
  { name:'Lizardfolk', source:"Volo's", ability:{con:2,wis:1}, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Draconic'], languageChoice:0, traits:[
    { name:'Bite', desc:'Natural bite attack dealing 1d6 + Str piercing damage.' },
    { name:'Cunning Artisan', desc:'During a short rest, craft a shield, club, javelin, or darts from creature remains.' },
    { name:'Hold Breath', desc:'You can hold your breath for up to 15 minutes.' },
    { name:'Natural Armor', desc:'When unarmored, your AC is 13 + your Dexterity modifier.' },
    { name:'Hungry Jaws', desc:'Bonus action bite; on a hit gain temporary HP equal to your Con modifier (once per short rest).' },
  ]},
  { name:'Tabaxi', source:"Volo's", ability:{dex:2,cha:1}, size:'Medium', speed:30, darkvision:60, skills:['Perception','Stealth'], languages:['Common'], languageChoice:1, traits:[
    { name:'Feline Agility', desc:'Double your speed until the end of the turn when you move; recharge by staying still one turn.' },
    { name:'Cat’s Claws', desc:'Climbing speed 20 ft; unarmed strikes deal 1d4 slashing.' },
    { name:'Cat’s Talent', desc:'Proficiency in Perception and Stealth.' },
  ]},
  { name:'Bugbear', source:"Volo's", ability:{str:2,dex:1}, size:'Medium', speed:30, darkvision:60, skills:['Stealth'], languages:['Common','Goblin'], languageChoice:0, traits:[
    { name:'Long-Limbed', desc:'Your reach is 5 feet greater on melee attacks on your turn.' },
    { name:'Powerful Build', desc:'Count as one size larger for carrying capacity and lifting/pushing/dragging.' },
    { name:'Sneaky', desc:'Proficiency in the Stealth skill.' },
    { name:'Surprise Attack', desc:'Extra 2d6 damage on a hit against a creature that hasn\'t taken a turn yet in combat.' },
  ]},
  { name:'Goblin', source:"Volo's", ability:{dex:2,con:1}, size:'Small', speed:30, darkvision:60, skills:[], languages:['Common','Goblin'], languageChoice:0, traits:[
    { name:'Fury of the Small', desc:'Once per short rest, add damage equal to your level against a larger creature.' },
    { name:'Nimble Escape', desc:'You can Disengage or Hide as a bonus action on each of your turns.' },
  ]},
  { name:'Hobgoblin', source:"Volo's", ability:{con:2,int:1}, size:'Medium', speed:30, darkvision:60, skills:[], languages:['Common','Goblin'], languageChoice:0, traits:[
    { name:'Martial Training', desc:'Proficiency with two martial weapons and light armor.' },
    { name:'Saving Face', desc:'When you miss, add a bonus to the roll for each ally within 30 ft (up to +5, once per short rest).' },
  ]},
  { name:'Kobold', source:"Volo's", ability:{dex:2,str:-2}, size:'Small', speed:30, darkvision:60, skills:[], languages:['Common','Draconic'], languageChoice:0, traits:[
    { name:'Grovel, Cower, and Beg', desc:'Action to give allies advantage on attacks vs enemies within 10 ft (once per short rest).' },
    { name:'Pack Tactics', desc:'Advantage on attacks against a creature if an ally is within 5 ft of it.' },
    { name:'Sunlight Sensitivity', desc:'Disadvantage on attack rolls and Perception (sight) in direct sunlight.' },
  ]},
  { name:'Orc', source:"Volo's", ability:{str:2,con:1,int:-2}, size:'Medium', speed:30, darkvision:60, skills:['Intimidation'], languages:['Common','Orc'], languageChoice:0, traits:[
    { name:'Aggressive', desc:'Bonus action to move up to your speed toward a hostile creature you can see.' },
    { name:'Powerful Build', desc:'Count as one size larger for carrying capacity and lifting/pushing/dragging.' },
    { name:'Menacing', desc:'Proficiency in the Intimidation skill.' },
  ]},
  { name:'Yuan-ti Pureblood', source:"Volo's", ability:{cha:2,int:1}, size:'Medium', speed:30, darkvision:60, skills:[], languages:['Common','Abyssal','Draconic'], languageChoice:0, traits:[
    { name:'Innate Spellcasting', desc:'You know poison spray; cast animal friendship (snakes) at will and suggestion 1/day (Charisma).' },
    { name:'Magic Resistance', desc:'Advantage on saving throws against spells and other magical effects.' },
    { name:'Poison Immunity', desc:'Immune to poison damage and the poisoned condition.' },
  ]},
  { name:'Triton', source:"Volo's", ability:{str:1,con:1,cha:1}, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Primordial'], languageChoice:0, traits:[
    { name:'Amphibious', desc:'You can breathe air and water.' },
    { name:'Control Air and Water', desc:'Cast fog cloud; at 3rd level gust of wind, at 5th level water walk (Charisma).' },
    { name:'Emissary of the Sea', desc:'You can communicate simple ideas with beasts that can breathe water.' },
    { name:'Guardians of the Depths', desc:'Resistance to cold damage; ignore drawbacks of deep, cold water.' },
    { name:'Swim Speed', desc:'You have a swimming speed of 30 feet.' },
  ]},
  { name:'Githyanki', source:"MToF", ability:{str:2,int:1}, choiceSkill:{ pick:1, from:'all' }, languageChoice:1, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Gith'], traits:[
    { name:'Decadent Mastery', desc:'Proficiency with one skill or one language of your choice (assign via Choices).' },
    { name:'Martial Prodigy', desc:'Proficiency with light and medium armor and shortswords, longswords, and greatswords.' },
    { name:'Githyanki Psionics', desc:'You know mage hand; at 3rd level jump, at 5th level misty step (Intelligence).' },
  ]},
  { name:'Githzerai', source:"MToF", ability:{wis:2,int:1}, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Gith'], languageChoice:0, traits:[
    { name:'Mental Discipline', desc:'Advantage on saving throws against being charmed and frightened.' },
    { name:'Githzerai Psionics', desc:'You know mage hand; at 3rd level shield, at 5th level detect thoughts (Wisdom).' },
  ]},
  //  Eberron: Rising from the Last War
  { name:'Changeling', source:'ERLW', ability:{cha:2}, choiceAbility:{ pick:1, from:['dex','int'], amount:1 }, choiceSkill:{ pick:2, from:['Deception','Insight','Intimidation','Persuasion'] }, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common'], languageChoice:2, traits:[
    { name:'Shapechanger', desc:'Action to change your appearance and voice to another humanoid of your size.' },
    { name:'Changeling Instincts', desc:'Proficiency in two of: Deception, Insight, Intimidation, Persuasion (assign via Choices).' },
  ]},
  { name:'Warforged', source:'ERLW', ability:{con:2}, choiceAbility:{ pick:1, from:['str','dex','int','wis','cha'], amount:1 }, choiceSkill:{ pick:1, from:'all' }, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common'], languageChoice:1, traits:[
    { name:'Constructed Resilience', desc:'Advantage vs poison, resistance to poison; immune to disease, no need to eat/drink/breathe/sleep.' },
    { name:'Sentry’s Rest', desc:'You spend 6 hours in an inactive-but-conscious state to gain a long rest.' },
    { name:'Integrated Protection', desc:'+1 AC; you can integrate armor into your body over an hour.' },
    { name:'Specialized Design', desc:'Proficiency in one skill and one tool of your choice.' },
  ]},
  { name:'Kalashtar', source:'ERLW', ability:{wis:2,cha:1}, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Quori'], languageChoice:1, traits:[
    { name:'Dual Mind', desc:'Advantage on all Wisdom saving throws.' },
    { name:'Mental Discipline', desc:'Resistance to psychic damage.' },
    { name:'Mind Link', desc:'Speak telepathically to any creature you can see within a number of feet equal to 10 × level.' },
    { name:'Severed from Dreams', desc:'Immune to magic that lets others read your dreams; unaffected by dream-based effects.' },
  ]},
  { name:'Shifter (Beasthide)', source:'ERLW', ability:{con:2,str:1}, size:'Medium', speed:30, darkvision:60, skills:[], languages:['Common'], languageChoice:0, traits:[
    { name:'Shifting', desc:'Bonus action to shift for 1 minute, gaining temp HP = level + Con mod (twice per short rest).' },
    { name:'Beasthide Shift', desc:'While shifted, gain +1 AC and extra temporary hit points.' },
  ]},
  { name:'Shifter (Swiftstride)', source:'ERLW', ability:{dex:2,cha:1}, size:'Medium', speed:30, darkvision:60, skills:[], languages:['Common'], languageChoice:0, traits:[
    { name:'Shifting', desc:'Bonus action to shift for 1 minute, gaining temp HP = level + Con mod (twice per short rest).' },
    { name:'Swiftstride Shift', desc:'While shifted, +10 ft speed and you can move 10 ft without provoking opportunity attacks.' },
  ]},
  //  Mythic Odysseys of Theros
  { name:'Leonin', source:'MOoT', ability:{con:2,str:1}, choiceSkill:{ pick:1, from:['Athletics','Intimidation','Perception','Survival'] }, size:'Medium', speed:35, darkvision:60, skills:[], languages:['Common','Leonin'], languageChoice:0, traits:[
    { name:'Claws', desc:'Climbing not required; unarmed strikes deal 1d4 + Str slashing damage.' },
    { name:'Hunter’s Instincts', desc:'Proficiency in one of: Athletics, Intimidation, Perception, Survival (assign via Choices).' },
    { name:'Daunting Roar', desc:'Bonus action to roar; nearby creatures must save or be frightened (once per short rest).' },
  ]},
  { name:'Satyr', source:'MOoT', ability:{cha:2,dex:1}, size:'Medium', speed:35, darkvision:0, skills:['Performance','Persuasion'], languages:['Common','Sylvan'], languageChoice:0, traits:[
    { name:'Ram', desc:'Unarmed strike headbutt dealing 1d4 + Str bludgeoning damage.' },
    { name:'Magic Resistance', desc:'Advantage on saving throws against spells and other magical effects.' },
    { name:'Mirthful Leaps', desc:'Add 1d8 feet to the distance of your long and high jumps.' },
    { name:'Reveler', desc:'Proficiency in Performance and Persuasion, plus one musical instrument.' },
  ]},
  //  The Wildemount / Explorer's Guide to Wildemount
  { name:'Simic Hybrid', source:'GGtR', ability:{con:2}, choiceAbility:{ pick:1, from:['str','dex','int'], amount:1 }, size:'Medium', speed:30, darkvision:60, skills:[], languages:['Common','Elvish'], languageChoice:0, traits:[
    { name:'Animal Enhancement', desc:'Gain an animal adaptation (e.g., swim speed & breathe water, or climbing) at 1st level, another at 5th.' },
  ]},
  { name:'Vedalken', source:'GGtR', ability:{int:2,wis:1}, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Vedalken'], languageChoice:1, traits:[
    { name:'Vedalken Dispassion', desc:'Advantage on Int, Wis, and Cha saving throws.' },
    { name:'Tireless Precision', desc:'Proficiency with one tool; add 1d4 to a proficient ability check (once per rest).' },
    { name:'Partially Amphibious', desc:'You can breathe underwater for up to 1 hour (then 4-hour cooldown).' },
  ]},
  //  Locathah Rising / one-offs commonly used
  { name:'Loxodon', source:'GGtR', ability:{con:2,wis:1}, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Loxodon'], languageChoice:0, traits:[
    { name:'Loxodon Serenity', desc:'Advantage on saving throws against being charmed or frightened.' },
    { name:'Natural Armor', desc:'When unarmored, your AC is 12 + Con modifier (shield allowed).' },
    { name:'Trunk', desc:'Grasp, lift, and manipulate objects; can be used as a snorkel or to spray water.' },
    { name:'Powerful Build', desc:'Count as one size larger for carrying capacity and lifting/pushing/dragging.' },
    { name:'Keen Smell', desc:'Advantage on Perception, Investigation, and Survival checks that rely on smell.' },
  ]},
  { name:'Minotaur', source:'GGtR', ability:{str:2,con:1}, choiceSkill:{ pick:1, from:['Intimidation','Persuasion'] }, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Minotaur'], languageChoice:0, traits:[
    { name:'Horns', desc:'Melee unarmed horn attack dealing 1d6 + Str piercing damage.' },
    { name:'Goring Rush', desc:'After Dashing, make a bonus-action horn attack.' },
    { name:'Hammering Horns', desc:'When you hit with a melee attack, bonus action to shove the target with your horns.' },
    { name:'Imposing Presence', desc:'Proficiency in Intimidation or Persuasion (assign via Choices).' },
  ]},
  //  Feywild races (WBtW / MPMM)
  { name:'Fairy', source:'WBtW', ability:{dex:2,cha:1}, size:'Small', speed:30, darkvision:0, skills:[], languages:['Common','Sylvan'], languageChoice:0, traits:[
    { name:'Flight', desc:'You have a flying speed of 30 feet (not while wearing medium/heavy armor).' },
    { name:'Fairy Magic', desc:'You know druidcraft; at 3rd level faerie fire, at 5th level enlarge/reduce (choose the casting ability).' },
    { name:'Fey Passage', desc:'Advantage on saves against being charmed; magic can\'t put you to sleep (fey ancestry variant).' },
  ]},
  { name:'Harengon', source:'WBtW', ability:{dex:2}, choiceAbility:{ pick:1, from:'all', amount:1 }, size:'Medium', speed:30, darkvision:0, skills:['Perception'], languages:['Common'], languageChoice:1, traits:[
    { name:'Hare-Trigger', desc:'You can add your proficiency bonus to your initiative rolls.' },
    { name:'Leporine Senses', desc:'Proficiency in the Perception skill.' },
    { name:'Lucky Footwork', desc:'When you fail a Dexterity save, reaction to roll a d4 and add it (unless prone).' },
    { name:'Rabbit Hop', desc:'Bonus action to jump a distance equal to 5 × proficiency bonus without provoking (uses per rest = prof).' },
  ]},
  { name:'Owlin', source:'SCC', ability:{dex:2}, choiceAbility:{ pick:2, from:'all', amount:1 }, size:'Medium', speed:30, darkvision:120, skills:['Stealth'], languages:['Common'], languageChoice:2, traits:[
    { name:'Flight', desc:'You have a flying speed of 30 feet (not while wearing medium/heavy armor).' },
    { name:'Silent Feathers', desc:'Proficiency in the Stealth skill.' },
    { name:'Superior Darkvision', desc:'Your darkvision has a range of 120 feet.' },
  ]},
  //  Genasi (EEPC / MPMM)
  { name:'Genasi (Air)', source:'EEPC', ability:{con:2,dex:1}, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Primordial'], languageChoice:0, traits:[
    { name:'Unending Breath', desc:'You can hold your breath indefinitely while not incapacitated.' },
    { name:'Mingle with the Wind', desc:'You can cast levitate once per long rest (Constitution).' },
  ]},
  { name:'Genasi (Earth)', source:'EEPC', ability:{con:2,str:1}, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Primordial'], languageChoice:0, traits:[
    { name:'Earth Walk', desc:'You can move across difficult terrain made of earth or stone without extra movement.' },
    { name:'Merge with Stone', desc:'You can cast pass without trace once per long rest (Constitution).' },
  ]},
  { name:'Genasi (Fire)', source:'EEPC', ability:{con:2,int:1}, size:'Medium', speed:30, darkvision:60, skills:[], languages:['Common','Primordial'], languageChoice:0, traits:[
    { name:'Fire Resistance', desc:'Resistance to fire damage.' },
    { name:'Reach to the Blaze', desc:'You know produce flame; at 3rd level you can cast burning hands once per long rest (Constitution).' },
  ]},
  { name:'Genasi (Water)', source:'EEPC', ability:{con:2,wis:1}, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Primordial'], languageChoice:0, traits:[
    { name:'Acid Resistance', desc:'Resistance to acid damage.' },
    { name:'Amphibious', desc:'You can breathe air and water; swimming speed of 30 feet.' },
    { name:'Call to the Wave', desc:'You know shape water; at 3rd level you can cast create or destroy water once per long rest (Constitution).' },
  ]},
  { name:'Aarakocra', source:'EEPC', ability:{dex:2,wis:1}, size:'Medium', speed:25, darkvision:0, skills:[], languages:['Common','Aarakocra','Auran'], languageChoice:0, traits:[
    { name:'Flight', desc:'You have a flying speed of 50 feet (not while wearing medium/heavy armor).' },
    { name:'Talons', desc:'Unarmed strike deals 1d4 + Str slashing damage.' },
  ]},
  //  Tortle Package
  { name:'Tortle', source:'TTP', ability:{str:2,wis:1}, size:'Medium', speed:30, darkvision:0, skills:[], languages:['Common','Aquan'], languageChoice:0, traits:[
    { name:'Natural Armor', desc:'Your shell gives you a base AC of 17 (no Dex bonus; can\'t wear armor).' },
    { name:'Shell Defense', desc:'Action to withdraw into your shell: +4 AC, advantage on Str/Con saves, but prone and speed 0.' },
    { name:'Claws', desc:'Unarmed strike deals 1d4 + Str slashing damage.' },
    { name:'Hold Breath', desc:'You can hold your breath for up to 1 hour.' },
    { name:'Survival Instinct', desc:'Proficiency in the Survival skill.' },
  ]},
];

// Seed a reference catalog table from a built-in array. Each array entry's listed
// `cols` become real columns; everything else is stored as a JSON `data` blob. Skips
// when the table already has rows unless force:true (reset passes force so custom rows
// are kept and INSERT OR IGNORE only re-adds missing built-ins). Shared by all catalogs.
function seedCatalog(table, cols, arr, force) {
  const existing = dbGetOne(`SELECT COUNT(*) AS n FROM ${table}`, []);
  if (!force && existing && existing.n > 0) return;
  const allCols = [...cols, 'data'];
  const stmt = db.prepare(`INSERT OR IGNORE INTO ${table} (${allCols.join(',')}) VALUES (${allCols.map(() => '?').join(',')})`);
  arr.forEach(entry => {
    const data = { ...entry };
    const vals = cols.map(c => { const v = entry[c]; delete data[c]; return c === 'source' ? (v || '') : v; });
    stmt.run([...vals, JSON.stringify(data)]);
  });
  stmt.free();
}

function seedRaces(force)   { seedCatalog('races',   ['name', 'source'], RACES, force); }

// D&D 5e feats. Same field vocabulary as races so the sheet's Choices machinery is
// reused verbatim:  ability (fixed increase), choiceAbility {pick,from,amount},
// skills (fixed), choiceSkill {pick,from}, languageChoice, prereq (display), desc.
const FEATS = [
  //  PHB
  { name:'Alert', source:'PHB', desc:'+5 bonus to initiative; you can\'t be surprised while conscious; other creatures don\'t gain advantage on attack rolls against you from being hidden.' },
  { name:'Actor', source:'PHB', ability:{cha:1}, desc:'Advantage on Deception and Performance checks when trying to pass as someone else; you can mimic the speech or sounds of others you\'ve heard.' },
  { name:'Athlete', source:'PHB', choiceAbility:{ pick:1, from:['str','dex'], amount:1 }, desc:'Standing from prone costs only 5 ft; climbing costs no extra movement; you make running long/high jumps after moving only 5 ft.' },
  { name:'Charger', source:'PHB', desc:'After you Dash, use a bonus action to make one melee attack or shove; if you moved 10+ ft straight, +5 damage or push 10 ft.' },
  { name:'Crossbow Expert', source:'PHB', desc:'Ignore the loading property of crossbows; no disadvantage on ranged attacks in melee; after a one-handed attack, bonus-action hand-crossbow attack.' },
  { name:'Defensive Duelist', source:'PHB', prereq:'Dex 13+', desc:'When wielding a finesse weapon, use your reaction to add your proficiency bonus to AC against one melee attack.' },
  { name:'Dual Wielder', source:'PHB', desc:'+1 AC while wielding two melee weapons; you can two-weapon fight with non-light weapons; you can draw or stow two one-handed weapons at once.' },
  { name:'Dungeon Delver', source:'PHB', desc:'Advantage on checks to detect secret doors and on saves vs traps; resistance to trap damage; search for traps at normal travel pace.' },
  { name:'Durable', source:'PHB', ability:{con:1}, desc:'When you spend Hit Dice to regain HP, the minimum you regain per die is twice your Constitution modifier (min 2).' },
  { name:'Elemental Adept', source:'PHB', prereq:'Spellcasting', desc:'Choose an element; your spells ignore resistance to that damage type, and you treat any 1 rolled on damage dice of that type as a 2.' },
  { name:'Grappler', source:'PHB', prereq:'Str 13+', desc:'Advantage on attacks against a creature you are grappling; you can use an action to try to pin a grappled creature (restrained).' },
  { name:'Great Weapon Master', source:'PHB', desc:'On a crit or kill with a melee weapon, bonus-action melee attack; before a heavy-weapon attack you may take -5 to hit for +10 damage.' },
  { name:'Healer', source:'PHB', desc:'Using a healer\'s kit to stabilize also restores 1 HP; as an action, spend a use of a healer\'s kit to restore 1d6 + 4 + creature\'s Hit Dice.' },
  { name:'Heavily Armored', source:'PHB', prereq:'Proficiency with medium armor', ability:{str:1}, desc:'You gain proficiency with heavy armor.' },
  { name:'Heavy Armor Master', source:'PHB', prereq:'Proficiency with heavy armor', ability:{str:1}, desc:'While wearing heavy armor, reduce nonmagical bludgeoning/piercing/slashing damage you take by 3.' },
  { name:'Inspiring Leader', source:'PHB', prereq:'Cha 13+', desc:'Spend 10 minutes to inspire up to 6 allies (incl. you); each gains temporary HP equal to your level + your Charisma modifier.' },
  { name:'Keen Mind', source:'PHB', ability:{int:1}, desc:'You always know which way is north and the hours until sunrise/sunset; you can recall anything you\'ve seen or heard within the past month.' },
  { name:'Lightly Armored', source:'PHB', choiceAbility:{ pick:1, from:['str','dex'], amount:1 }, desc:'You gain proficiency with light armor.' },
  { name:'Linguist', source:'PHB', ability:{int:1}, languageChoice:3, desc:'You learn three languages of your choice; you can create written ciphers others can\'t decipher without your key.' },
  { name:'Lucky', source:'PHB', desc:'You have 3 luck points (regained on a long rest). Spend one to roll an extra d20 for an attack, check, or save, or to make an attacker reroll.' },
  { name:'Mage Slayer', source:'PHB', desc:'Reaction attack when an adjacent creature casts; advantage on saves vs their spells; they have disadvantage on concentration saves from your damage.' },
  { name:'Magic Initiate', source:'PHB', desc:'Choose a class: learn two of its cantrips and one 1st-level spell (cast once per long rest without a slot).' },
  { name:'Martial Adept', source:'PHB', desc:'You learn two maneuvers from the Battle Master list and gain one superiority die (d6, regained on a short/long rest).' },
  { name:'Medium Armor Master', source:'PHB', prereq:'Proficiency with medium armor', desc:'No disadvantage on Stealth from medium armor; you can add up to +3 Dex (instead of +2) to AC in medium armor.' },
  { name:'Mobile', source:'PHB', desc:'Speed +10 ft; Dashing ignores difficult terrain; after a melee attack against a creature, you don\'t provoke opportunity attacks from it this turn.' },
  { name:'Moderately Armored', source:'PHB', prereq:'Proficiency with light armor', choiceAbility:{ pick:1, from:['str','dex'], amount:1 }, desc:'You gain proficiency with medium armor and shields.' },
  { name:'Mounted Combatant', source:'PHB', desc:'Advantage on melee attacks vs unmounted creatures smaller than your mount; redirect attacks aimed at your mount to yourself; mount takes no damage on successful Dex saves.' },
  { name:'Observant', source:'PHB', choiceAbility:{ pick:1, from:['int','wis'], amount:1 }, desc:'You can read lips; +5 bonus to passive Perception and passive Investigation.' },
  { name:'Polearm Master', source:'PHB', desc:'After an attack with a glaive/halberd/quarterstaff/spear, bonus-action butt-end attack (1d4); creatures entering your reach provoke an opportunity attack.' },
  { name:'Resilient', source:'PHB', choiceAbility:{ pick:1, from:'all', amount:1 }, desc:'You gain proficiency in saving throws using the chosen ability (tick the save box yourself).' },
  { name:'Ritual Caster', source:'PHB', prereq:'Int or Wis 13+', desc:'You gain a ritual book with two 1st-level ritual spells from a chosen class and can cast ritual spells from it.' },
  { name:'Savage Attacker', source:'PHB', desc:'Once per turn when you roll damage for a melee weapon attack, you can reroll the weapon\'s damage dice and use either total.' },
  { name:'Sentinel', source:'PHB', desc:'Opportunity attacks reduce the target\'s speed to 0; creatures provoke even if they Disengage; when a creature within 5 ft attacks another, you can react to attack it.' },
  { name:'Sharpshooter', source:'PHB', desc:'No disadvantage at long range; your ranged attacks ignore half and three-quarters cover; take -5 to hit for +10 damage.' },
  { name:'Shield Master', source:'PHB', desc:'Bonus-action shove with your shield after an Attack; add shield\'s AC to Dex saves vs effects targeting only you; reaction to take no damage on a successful save.' },
  { name:'Skilled', source:'PHB', choiceSkill:{ pick:3, from:'all' }, desc:'You gain proficiency in any combination of three skills or tools of your choice (skills selectable here; tools add manually).' },
  { name:'Skulker', source:'PHB', prereq:'Dex 13+', desc:'You can hide when only lightly obscured; missing with a ranged attack doesn\'t reveal your position; dim light gives no disadvantage on Perception (sight).' },
  { name:'Spell Sniper', source:'PHB', prereq:'Spellcasting', desc:'Double the range of your attack-roll spells; they ignore half and three-quarters cover; you learn one attack cantrip.' },
  { name:'Tavern Brawler', source:'PHB', choiceAbility:{ pick:1, from:['str','con'], amount:1 }, desc:'Proficiency with improvised weapons; unarmed strike deals 1d4; after hitting with an unarmed strike or improvised weapon, bonus-action grapple attempt.' },
  { name:'Tough', source:'PHB', desc:'Your hit point maximum increases by an amount equal to twice your level (and by 2 each level thereafter).' },
  { name:'War Caster', source:'PHB', prereq:'Spellcasting', desc:'Advantage on concentration saves; you can perform somatic components with weapons/shield in hand; you can cast a spell as an opportunity attack.' },
  { name:'Weapon Master', source:'PHB', choiceAbility:{ pick:1, from:['str','dex'], amount:1 }, desc:'You gain proficiency with four weapons of your choice (simple or martial).' },
  //  Xanathar's / Tasha's (general, non-race-gated)
  { name:'Fey Touched', source:"TCoE", choiceAbility:{ pick:1, from:['int','wis','cha'], amount:1 }, desc:'You learn misty step and one 1st-level divination or enchantment spell; cast each once per long rest without a slot (or with slots).' },
  { name:'Shadow Touched', source:"TCoE", choiceAbility:{ pick:1, from:['int','wis','cha'], amount:1 }, desc:'You learn invisibility and one 1st-level illusion or necromancy spell; cast each once per long rest without a slot (or with slots).' },
  { name:'Telekinetic', source:"TCoE", choiceAbility:{ pick:1, from:['int','wis','cha'], amount:1 }, desc:'You learn mage hand (invisible, +30 ft range); as a bonus action, telekinetically shove a creature 5 ft (Str save).' },
  { name:'Telepathic', source:"TCoE", choiceAbility:{ pick:1, from:['int','wis','cha'], amount:1 }, desc:'You can speak telepathically to any creature within 60 ft; you can cast detect thoughts once per long rest.' },
  { name:'Skill Expert', source:"TCoE", choiceAbility:{ pick:1, from:'all', amount:1 }, choiceSkill:{ pick:1, from:'all' }, desc:'Gain proficiency in one skill; and choose one skill you\'re proficient in to gain expertise (double proficiency — mark it yourself).' },
  { name:'Chef', source:"TCoE", choiceAbility:{ pick:1, from:['con','wis'], amount:1 }, desc:'Proficiency with cook\'s utensils; special food on a short rest restores extra HP; you can bake treats that grant temporary HP.' },
  { name:'Crusher', source:"TCoE", choiceAbility:{ pick:1, from:['str','con'], amount:1 }, desc:'Once per turn when you deal bludgeoning damage, move the target 5 ft; a critical bludgeoning hit gives attackers advantage against it until your next turn.' },
  { name:'Piercer', source:"TCoE", choiceAbility:{ pick:1, from:['str','dex'], amount:1 }, desc:'Once per turn reroll one piercing damage die; on a critical hit with a piercing weapon, roll one additional damage die.' },
  { name:'Slasher', source:"TCoE", choiceAbility:{ pick:1, from:['str','dex'], amount:1 }, desc:'Once per turn when you deal slashing damage, reduce the target\'s speed by 10 ft; a slashing critical imposes disadvantage on its attacks.' },
  { name:'Poisoner', source:"TCoE", desc:'Ignore resistance to poison damage; as a bonus action apply potent poison (DC 14, 2d8 poison, poisoned) to a weapon; proficiency with poisoner\'s kit and can craft potent poison.' },
  { name:'Eldritch Adept', source:"TCoE", prereq:'Spellcasting or Pact Magic', desc:'You learn one Eldritch Invocation of your choice (from those with no other prerequisite).' },
  { name:'Metamagic Adept', source:"TCoE", prereq:'Spellcasting or Pact Magic', desc:'You learn two Metamagic options from the sorcerer list and gain 2 sorcery points to use only for them.' },
  { name:'Gunner', source:"TCoE", ability:{dex:1}, desc:'Proficiency with firearms; you ignore the loading property of firearms; being within 5 ft of a hostile creature doesn\'t impose disadvantage on ranged attacks.' },
  { name:'Fighting Initiate', source:"TCoE", prereq:'Proficiency with a martial weapon', desc:'You learn one Fighting Style option of your choice from the fighter list.' },
];

function seedFeats(force) { seedCatalog('feats', ['name', 'source'], FEATS, force); }

// D&D 5e SRD spells, one per line as:
//   name | level (0 = cantrip) | school | casting time | range | components | duration | classes
// Rules text is deliberately NOT included here — see the spells table comment. Import
// verbatim descriptions later with POST /api/spells/import.
const SPELL_ROWS = `
Acid Splash|0|Conjuration|1 action|60 ft|V,S|Instantaneous|Sorcerer,Wizard
Blade Ward|0|Abjuration|1 action|Self|V,S|1 round|Bard,Sorcerer,Warlock,Wizard
Chill Touch|0|Necromancy|1 action|120 ft|V,S|1 round|Sorcerer,Warlock,Wizard
Dancing Lights|0|Evocation|1 action|120 ft|V,S,M|Concentration, up to 1 minute|Bard,Sorcerer,Wizard
Druidcraft|0|Transmutation|1 action|30 ft|V,S|Instantaneous|Druid
Eldritch Blast|0|Evocation|1 action|120 ft|V,S|Instantaneous|Warlock
Fire Bolt|0|Evocation|1 action|120 ft|V,S|Instantaneous|Sorcerer,Wizard
Friends|0|Enchantment|1 action|Self|S,M|Concentration, up to 1 minute|Bard,Sorcerer,Warlock,Wizard
Guidance|0|Divination|1 action|Touch|V,S|Concentration, up to 1 minute|Cleric,Druid
Light|0|Evocation|1 action|Touch|V,M|1 hour|Bard,Cleric,Sorcerer,Wizard
Mage Hand|0|Conjuration|1 action|30 ft|V,S|1 minute|Bard,Sorcerer,Warlock,Wizard
Mending|0|Transmutation|1 minute|Touch|V,S,M|Instantaneous|Bard,Cleric,Druid,Sorcerer,Wizard
Message|0|Transmutation|1 action|120 ft|V,S,M|1 round|Bard,Sorcerer,Wizard
Minor Illusion|0|Illusion|1 action|30 ft|S,M|1 minute|Bard,Sorcerer,Warlock,Wizard
Poison Spray|0|Conjuration|1 action|10 ft|V,S|Instantaneous|Druid,Sorcerer,Warlock,Wizard
Prestidigitation|0|Transmutation|1 action|10 ft|V,S|Up to 1 hour|Bard,Sorcerer,Warlock,Wizard
Produce Flame|0|Conjuration|1 action|Self|V,S|10 minutes|Druid
Ray of Frost|0|Evocation|1 action|60 ft|V,S|Instantaneous|Sorcerer,Wizard
Resistance|0|Abjuration|1 action|Touch|V,S,M|Concentration, up to 1 minute|Cleric,Druid
Sacred Flame|0|Evocation|1 action|60 ft|V,S|Instantaneous|Cleric
Shillelagh|0|Transmutation|1 bonus action|Touch|V,S,M|1 minute|Druid
Shocking Grasp|0|Evocation|1 action|Touch|V,S|Instantaneous|Sorcerer,Wizard
Spare the Dying|0|Necromancy|1 action|Touch|V,S|Instantaneous|Cleric
Thaumaturgy|0|Transmutation|1 action|30 ft|V|Up to 1 minute|Cleric
Thorn Whip|0|Transmutation|1 action|30 ft|V,S,M|Instantaneous|Druid
True Strike|0|Divination|1 action|30 ft|S|Concentration, up to 1 round|Bard,Sorcerer,Warlock,Wizard
Vicious Mockery|0|Enchantment|1 action|60 ft|V|Instantaneous|Bard
Booming Blade|0|Evocation|1 action|Self (5-ft radius)|S,M|1 round|Sorcerer,Warlock,Wizard
Control Flames|0|Transmutation|1 action|60 ft|S|Instantaneous|Druid,Sorcerer,Wizard
Create Bonfire|0|Conjuration|1 action|60 ft|V,S|Concentration, up to 1 minute|Druid,Sorcerer,Warlock,Wizard
Frostbite|0|Evocation|1 action|60 ft|V,S|Instantaneous|Druid,Sorcerer,Warlock,Wizard
Green-Flame Blade|0|Evocation|1 action|Self (5-ft radius)|S,M|Instantaneous|Sorcerer,Warlock,Wizard
Gust|0|Transmutation|1 action|30 ft|V,S|Instantaneous|Druid,Sorcerer,Wizard
Infestation|0|Conjuration|1 action|30 ft|V,S,M|Instantaneous|Druid,Sorcerer,Warlock,Wizard
Lightning Lure|0|Evocation|1 action|Self (15-ft radius)|V|Instantaneous|Sorcerer,Warlock,Wizard
Magic Stone|0|Transmutation|1 bonus action|Touch|V,S|1 minute|Druid,Warlock
Mind Sliver|0|Enchantment|1 action|60 ft|V|1 round|Sorcerer,Warlock,Wizard
Mold Earth|0|Transmutation|1 action|30 ft|S|Instantaneous|Druid,Sorcerer,Wizard
Primal Savagery|0|Transmutation|1 action|Self|S|Instantaneous|Druid
Sword Burst|0|Conjuration|1 action|Self (5-ft radius)|V|Instantaneous|Sorcerer,Warlock,Wizard
Thunderclap|0|Evocation|1 action|Self (5-ft radius)|S|Instantaneous|Druid,Sorcerer,Warlock,Wizard
Toll the Dead|0|Necromancy|1 action|60 ft|V,S|Instantaneous|Cleric,Warlock,Wizard
Word of Radiance|0|Evocation|1 action|5 ft|V,M|Instantaneous|Cleric
Alarm|1|Abjuration|1 minute|30 ft|V,S,M|8 hours|Ranger,Wizard
Animal Friendship|1|Enchantment|1 action|30 ft|V,S,M|24 hours|Bard,Druid,Ranger
Armor of Agathys|1|Abjuration|1 action|Self|V,S,M|1 hour|Warlock
Arms of Hadar|1|Conjuration|1 action|Self (10-ft radius)|V,S|Instantaneous|Warlock
Bane|1|Enchantment|1 action|30 ft|V,S,M|Concentration, up to 1 minute|Bard,Cleric
Bless|1|Enchantment|1 action|30 ft|V,S,M|Concentration, up to 1 minute|Cleric,Paladin
Burning Hands|1|Evocation|1 action|Self (15-ft cone)|V,S|Instantaneous|Sorcerer,Wizard
Charm Person|1|Enchantment|1 action|30 ft|V,S|1 hour|Bard,Druid,Sorcerer,Warlock,Wizard
Chromatic Orb|1|Evocation|1 action|90 ft|V,S,M|Instantaneous|Sorcerer,Wizard
Color Spray|1|Illusion|1 action|Self (15-ft cone)|V,S,M|1 round|Sorcerer,Wizard
Command|1|Enchantment|1 action|60 ft|V|1 round|Cleric,Paladin
Compelled Duel|1|Enchantment|1 bonus action|30 ft|V|Concentration, up to 1 minute|Paladin
Comprehend Languages|1|Divination|1 action|Self|V,S,M|1 hour|Bard,Sorcerer,Warlock,Wizard
Create or Destroy Water|1|Transmutation|1 action|30 ft|V,S,M|Instantaneous|Cleric,Druid
Cure Wounds|1|Evocation|1 action|Touch|V,S|Instantaneous|Bard,Cleric,Druid,Paladin,Ranger
Detect Evil and Good|1|Divination|1 action|Self|V,S|Concentration, up to 10 minutes|Cleric,Paladin
Detect Magic|1|Divination|1 action|Self|V,S|Concentration, up to 10 minutes|Bard,Cleric,Druid,Paladin,Ranger,Sorcerer,Wizard
Detect Poison and Disease|1|Divination|1 action|Self|V,S,M|Concentration, up to 10 minutes|Cleric,Druid,Paladin,Ranger
Disguise Self|1|Illusion|1 action|Self|V,S|1 hour|Bard,Sorcerer,Wizard
Dissonant Whispers|1|Enchantment|1 action|60 ft|V|Instantaneous|Bard
Divine Favor|1|Evocation|1 bonus action|Self|V,S|Concentration, up to 1 minute|Paladin
Ensnaring Strike|1|Conjuration|1 bonus action|Self|V|Concentration, up to 1 minute|Ranger
Entangle|1|Conjuration|1 action|90 ft|V,S|Concentration, up to 1 minute|Druid
Expeditious Retreat|1|Transmutation|1 bonus action|Self|V,S|Concentration, up to 10 minutes|Sorcerer,Warlock,Wizard
Faerie Fire|1|Evocation|1 action|60 ft|V|Concentration, up to 1 minute|Bard,Druid
False Life|1|Necromancy|1 action|Self|V,S,M|1 hour|Sorcerer,Wizard
Feather Fall|1|Transmutation|1 reaction|60 ft|V,M|1 minute|Bard,Sorcerer,Wizard
Find Familiar|1|Conjuration|1 hour|10 ft|V,S,M|Instantaneous|Wizard
Fog Cloud|1|Conjuration|1 action|120 ft|V,S|Concentration, up to 1 hour|Druid,Ranger,Sorcerer,Wizard
Goodberry|1|Transmutation|1 action|Touch|V,S,M|Instantaneous|Druid,Ranger
Grease|1|Conjuration|1 action|60 ft|V,S,M|1 minute|Wizard
Guiding Bolt|1|Evocation|1 action|120 ft|V,S|1 round|Cleric
Hail of Thorns|1|Conjuration|1 bonus action|Self|V|Concentration, up to 1 minute|Ranger
Healing Word|1|Evocation|1 bonus action|60 ft|V|Instantaneous|Bard,Cleric,Druid
Hellish Rebuke|1|Evocation|1 reaction|60 ft|V,S|Instantaneous|Warlock
Heroism|1|Enchantment|1 action|Touch|V,S|Concentration, up to 1 minute|Bard,Paladin
Hex|1|Enchantment|1 bonus action|90 ft|V,S,M|Concentration, up to 1 hour|Warlock
Hunter's Mark|1|Divination|1 bonus action|90 ft|V|Concentration, up to 1 hour|Ranger
Identify|1|Divination|1 minute|Touch|V,S,M|Instantaneous|Bard,Wizard
Illusory Script|1|Illusion|1 minute|Touch|S,M|10 days|Bard,Warlock,Wizard
Inflict Wounds|1|Necromancy|1 action|Touch|V,S|Instantaneous|Cleric
Jump|1|Transmutation|1 action|Touch|V,S,M|1 minute|Druid,Ranger,Sorcerer,Wizard
Longstrider|1|Transmutation|1 action|Touch|V,S,M|1 hour|Bard,Druid,Ranger,Wizard
Mage Armor|1|Abjuration|1 action|Touch|V,S,M|8 hours|Sorcerer,Wizard
Magic Missile|1|Evocation|1 action|120 ft|V,S|Instantaneous|Sorcerer,Wizard
Protection from Evil and Good|1|Abjuration|1 action|Touch|V,S,M|Concentration, up to 10 minutes|Cleric,Paladin,Warlock,Wizard
Purify Food and Drink|1|Transmutation|1 action|10 ft|V,S|Instantaneous|Cleric,Druid,Paladin
Ray of Sickness|1|Necromancy|1 action|60 ft|V,S|Instantaneous|Sorcerer,Wizard
Sanctuary|1|Abjuration|1 bonus action|30 ft|V,S,M|1 minute|Cleric
Searing Smite|1|Evocation|1 bonus action|Self|V|Concentration, up to 1 minute|Paladin
Shield|1|Abjuration|1 reaction|Self|V,S|1 round|Sorcerer,Wizard
Shield of Faith|1|Abjuration|1 bonus action|60 ft|V,S,M|Concentration, up to 10 minutes|Cleric,Paladin
Silent Image|1|Illusion|1 action|60 ft|V,S,M|Concentration, up to 10 minutes|Bard,Sorcerer,Wizard
Sleep|1|Enchantment|1 action|90 ft|V,S,M|1 minute|Bard,Sorcerer,Wizard
Speak with Animals|1|Divination|1 action|Self|V,S|10 minutes|Bard,Druid,Ranger
Tasha's Hideous Laughter|1|Enchantment|1 action|30 ft|V,S,M|Concentration, up to 1 minute|Bard,Wizard
Tenser's Floating Disk|1|Conjuration|1 action|30 ft|V,S,M|1 hour|Wizard
Thunderous Smite|1|Evocation|1 bonus action|Self|V|Concentration, up to 1 minute|Paladin
Thunderwave|1|Evocation|1 action|Self (15-ft cube)|V,S|Instantaneous|Bard,Druid,Sorcerer,Wizard
Unseen Servant|1|Conjuration|1 action|60 ft|V,S,M|1 hour|Bard,Warlock,Wizard
Witch Bolt|1|Evocation|1 action|30 ft|V,S,M|Concentration, up to 1 minute|Sorcerer,Warlock,Wizard
Wrathful Smite|1|Evocation|1 bonus action|Self|V|Concentration, up to 1 minute|Paladin
Aid|2|Abjuration|1 action|30 ft|V,S,M|8 hours|Cleric,Paladin
Alter Self|2|Transmutation|1 action|Self|V,S|Concentration, up to 1 hour|Sorcerer,Wizard
Animal Messenger|2|Enchantment|1 action|30 ft|V,S,M|24 hours|Bard,Druid,Ranger
Arcane Lock|2|Abjuration|1 action|Touch|V,S,M|Until dispelled|Wizard
Augury|2|Divination|1 minute|Self|V,S,M|Instantaneous|Cleric
Barkskin|2|Transmutation|1 action|Touch|V,S,M|Concentration, up to 1 hour|Druid,Ranger
Beast Sense|2|Divination|1 action|Touch|S|Concentration, up to 1 hour|Druid,Ranger
Blindness/Deafness|2|Necromancy|1 action|30 ft|V|1 minute|Bard,Cleric,Sorcerer,Wizard
Blur|2|Illusion|1 action|Self|V|Concentration, up to 1 minute|Sorcerer,Wizard
Branding Smite|2|Evocation|1 bonus action|Self|V|Concentration, up to 1 minute|Paladin
Calm Emotions|2|Enchantment|1 action|60 ft|V,S|Concentration, up to 1 minute|Bard,Cleric
Cloud of Daggers|2|Conjuration|1 action|60 ft|V,S,M|Concentration, up to 1 minute|Bard,Sorcerer,Warlock,Wizard
Continual Flame|2|Evocation|1 action|Touch|V,S,M|Until dispelled|Cleric,Wizard
Cordon of Arrows|2|Transmutation|1 action|5 ft|V,S,M|8 hours|Ranger
Crown of Madness|2|Enchantment|1 action|120 ft|V,S|Concentration, up to 1 minute|Bard,Sorcerer,Warlock,Wizard
Darkness|2|Evocation|1 action|60 ft|V,M|Concentration, up to 10 minutes|Sorcerer,Warlock,Wizard
Darkvision|2|Transmutation|1 action|Touch|V,S,M|8 hours|Druid,Ranger,Sorcerer,Wizard
Detect Thoughts|2|Divination|1 action|Self|V,S,M|Concentration, up to 1 minute|Bard,Sorcerer,Wizard
Enhance Ability|2|Transmutation|1 action|Touch|V,S,M|Concentration, up to 1 hour|Bard,Cleric,Druid,Sorcerer
Enlarge/Reduce|2|Transmutation|1 action|30 ft|V,S,M|Concentration, up to 1 minute|Sorcerer,Wizard
Enthrall|2|Enchantment|1 action|60 ft|V,S|1 minute|Bard,Warlock
Find Steed|2|Conjuration|10 minutes|30 ft|V,S|Instantaneous|Paladin
Find Traps|2|Divination|1 action|120 ft|V,S|Instantaneous|Cleric,Druid,Ranger
Flame Blade|2|Evocation|1 bonus action|Self|V,S,M|Concentration, up to 10 minutes|Druid
Flaming Sphere|2|Conjuration|1 action|60 ft|V,S,M|Concentration, up to 1 minute|Druid,Wizard
Gentle Repose|2|Necromancy|1 action|Touch|V,S,M|10 days|Cleric,Wizard
Gust of Wind|2|Evocation|1 action|Self (60-ft line)|V,S,M|Concentration, up to 1 minute|Druid,Sorcerer,Wizard
Heat Metal|2|Transmutation|1 action|60 ft|V,S,M|Concentration, up to 1 minute|Bard,Druid
Hold Person|2|Enchantment|1 action|60 ft|V,S,M|Concentration, up to 1 minute|Bard,Cleric,Druid,Sorcerer,Warlock,Wizard
Invisibility|2|Illusion|1 action|Touch|V,S,M|Concentration, up to 1 hour|Bard,Sorcerer,Warlock,Wizard
Knock|2|Transmutation|1 action|60 ft|V|Instantaneous|Bard,Sorcerer,Wizard
Lesser Restoration|2|Abjuration|1 action|Touch|V,S|Instantaneous|Bard,Cleric,Druid,Paladin,Ranger
Levitate|2|Transmutation|1 action|60 ft|V,S,M|Concentration, up to 10 minutes|Sorcerer,Wizard
Locate Animals or Plants|2|Divination|1 action|Self|V,S,M|Instantaneous|Bard,Druid,Ranger
Locate Object|2|Divination|1 action|Self|V,S,M|Concentration, up to 10 minutes|Bard,Cleric,Druid,Paladin,Ranger,Wizard
Magic Mouth|2|Illusion|1 minute|30 ft|V,S,M|Until dispelled|Bard,Wizard
Magic Weapon|2|Transmutation|1 bonus action|Touch|V,S|Concentration, up to 1 hour|Paladin,Wizard
Mirror Image|2|Illusion|1 action|Self|V,S|1 minute|Sorcerer,Warlock,Wizard
Misty Step|2|Conjuration|1 bonus action|Self|V|Instantaneous|Sorcerer,Warlock,Wizard
Moonbeam|2|Evocation|1 action|120 ft|V,S,M|Concentration, up to 1 minute|Druid
Pass without Trace|2|Abjuration|1 action|Self|V,S,M|Concentration, up to 1 hour|Druid,Ranger
Phantasmal Force|2|Illusion|1 action|60 ft|V,S,M|Concentration, up to 1 minute|Bard,Sorcerer,Wizard
Prayer of Healing|2|Evocation|10 minutes|30 ft|V|Instantaneous|Cleric
Protection from Poison|2|Abjuration|1 action|Touch|V,S|1 hour|Cleric,Druid,Paladin,Ranger
Ray of Enfeeblement|2|Necromancy|1 action|60 ft|V,S|Concentration, up to 1 minute|Warlock,Wizard
Rope Trick|2|Transmutation|1 action|Touch|V,S,M|1 hour|Wizard
Scorching Ray|2|Evocation|1 action|120 ft|V,S|Instantaneous|Sorcerer,Wizard
See Invisibility|2|Divination|1 action|Self|V,S,M|1 hour|Bard,Sorcerer,Wizard
Shatter|2|Evocation|1 action|60 ft|V,S,M|Instantaneous|Bard,Sorcerer,Warlock,Wizard
Silence|2|Illusion|1 action|120 ft|V,S|Concentration, up to 10 minutes|Bard,Cleric,Ranger
Spider Climb|2|Transmutation|1 action|Touch|V,S,M|Concentration, up to 1 hour|Sorcerer,Warlock,Wizard
Spike Growth|2|Transmutation|1 action|150 ft|V,S,M|Concentration, up to 10 minutes|Druid,Ranger
Spiritual Weapon|2|Evocation|1 bonus action|60 ft|V,S|1 minute|Cleric
Suggestion|2|Enchantment|1 action|30 ft|V,M|Concentration, up to 8 hours|Bard,Sorcerer,Warlock,Wizard
Warding Bond|2|Abjuration|1 action|Touch|V,S,M|1 hour|Cleric
Web|2|Conjuration|1 action|60 ft|V,S,M|Concentration, up to 1 hour|Sorcerer,Wizard
Zone of Truth|2|Enchantment|1 action|60 ft|V,S|10 minutes|Bard,Cleric,Paladin
Animate Dead|3|Necromancy|1 minute|10 ft|V,S,M|Instantaneous|Cleric,Wizard
Aura of Vitality|3|Evocation|1 action|Self (30-ft radius)|V|Concentration, up to 1 minute|Paladin
Beacon of Hope|3|Abjuration|1 action|30 ft|V,S|Concentration, up to 1 minute|Cleric
Bestow Curse|3|Necromancy|1 action|Touch|V,S|Concentration, up to 1 minute|Bard,Cleric,Wizard
Blinding Smite|3|Evocation|1 bonus action|Self|V|Concentration, up to 1 minute|Paladin
Blink|3|Transmutation|1 action|Self|V,S|1 minute|Sorcerer,Wizard
Call Lightning|3|Conjuration|1 action|120 ft|V,S|Concentration, up to 10 minutes|Druid
Clairvoyance|3|Divination|10 minutes|1 mile|V,S,M|Concentration, up to 10 minutes|Bard,Cleric,Sorcerer,Wizard
Conjure Animals|3|Conjuration|1 action|60 ft|V,S|Concentration, up to 1 hour|Druid,Ranger
Conjure Barrage|3|Conjuration|1 action|Self (60-ft cone)|V,S,M|Instantaneous|Ranger
Counterspell|3|Abjuration|1 reaction|60 ft|S|Instantaneous|Sorcerer,Warlock,Wizard
Create Food and Water|3|Conjuration|1 action|30 ft|V,S|Instantaneous|Cleric,Paladin
Crusader's Mantle|3|Evocation|1 action|Self (30-ft radius)|V|Concentration, up to 1 minute|Paladin
Daylight|3|Evocation|1 action|60 ft|V,S|1 hour|Cleric,Druid,Paladin,Ranger,Sorcerer
Dispel Magic|3|Abjuration|1 action|120 ft|V,S|Instantaneous|Bard,Cleric,Druid,Paladin,Sorcerer,Warlock,Wizard
Elemental Weapon|3|Transmutation|1 action|Touch|V,S|Concentration, up to 1 hour|Paladin
Fear|3|Illusion|1 action|Self (30-ft cone)|V,S,M|Concentration, up to 1 minute|Bard,Sorcerer,Warlock,Wizard
Feign Death|3|Necromancy|1 action|Touch|V,S,M|1 hour|Bard,Cleric,Druid,Wizard
Fireball|3|Evocation|1 action|150 ft|V,S,M|Instantaneous|Sorcerer,Wizard
Fly|3|Transmutation|1 action|Touch|V,S,M|Concentration, up to 10 minutes|Sorcerer,Warlock,Wizard
Gaseous Form|3|Transmutation|1 action|Touch|V,S,M|Concentration, up to 1 hour|Sorcerer,Warlock,Wizard
Glyph of Warding|3|Abjuration|1 hour|Touch|V,S,M|Until dispelled or triggered|Bard,Cleric,Wizard
Haste|3|Transmutation|1 action|30 ft|V,S,M|Concentration, up to 1 minute|Sorcerer,Wizard
Hunger of Hadar|3|Conjuration|1 action|150 ft|V,S,M|Concentration, up to 1 minute|Warlock
Hypnotic Pattern|3|Illusion|1 action|120 ft|S,M|Concentration, up to 1 minute|Bard,Sorcerer,Warlock,Wizard
Lightning Arrow|3|Transmutation|1 bonus action|Self|V,S|Concentration, up to 1 minute|Ranger
Lightning Bolt|3|Evocation|1 action|Self (100-ft line)|V,S,M|Instantaneous|Sorcerer,Wizard
Magic Circle|3|Abjuration|1 minute|10 ft|V,S,M|1 hour|Cleric,Paladin,Warlock,Wizard
Major Image|3|Illusion|1 action|120 ft|V,S,M|Concentration, up to 10 minutes|Bard,Sorcerer,Warlock,Wizard
Mass Healing Word|3|Evocation|1 bonus action|60 ft|V|Instantaneous|Cleric
Meld into Stone|3|Transmutation|1 action|Touch|V,S|8 hours|Cleric,Druid
Nondetection|3|Abjuration|1 action|Touch|V,S,M|8 hours|Bard,Ranger,Wizard
Phantom Steed|3|Illusion|1 minute|30 ft|V,S|1 hour|Wizard
Plant Growth|3|Transmutation|1 action|150 ft|V,S|Instantaneous|Bard,Druid,Ranger
Protection from Energy|3|Abjuration|1 action|Touch|V,S|Concentration, up to 1 hour|Cleric,Druid,Ranger,Sorcerer,Wizard
Remove Curse|3|Abjuration|1 action|Touch|V,S|Instantaneous|Cleric,Paladin,Warlock,Wizard
Revivify|3|Necromancy|1 action|Touch|V,S,M|Instantaneous|Cleric,Paladin
Sending|3|Evocation|1 action|Unlimited|V,S,M|1 round|Bard,Cleric,Wizard
Sleet Storm|3|Conjuration|1 action|150 ft|V,S,M|Concentration, up to 1 minute|Druid,Sorcerer,Wizard
Slow|3|Transmutation|1 action|120 ft|V,S,M|Concentration, up to 1 minute|Sorcerer,Wizard
Speak with Dead|3|Necromancy|1 action|10 ft|V,S,M|10 minutes|Bard,Cleric
Speak with Plants|3|Transmutation|1 action|Self (30-ft radius)|V,S|10 minutes|Bard,Druid,Ranger
Spirit Guardians|3|Conjuration|1 action|Self (15-ft radius)|V,S,M|Concentration, up to 10 minutes|Cleric
Stinking Cloud|3|Conjuration|1 action|90 ft|V,S,M|Concentration, up to 1 minute|Bard,Sorcerer,Wizard
Tongues|3|Divination|1 action|Touch|V,M|1 hour|Bard,Cleric,Sorcerer,Warlock,Wizard
Vampiric Touch|3|Necromancy|1 action|Self|V,S|Concentration, up to 1 minute|Warlock,Wizard
Water Breathing|3|Transmutation|1 action|30 ft|V,S,M|24 hours|Druid,Ranger,Sorcerer,Wizard
Water Walk|3|Transmutation|1 action|30 ft|V,S,M|1 hour|Cleric,Druid,Ranger,Sorcerer
Wind Wall|3|Evocation|1 action|120 ft|V,S,M|Concentration, up to 1 minute|Druid,Ranger
Arcane Eye|4|Divination|1 action|30 ft|V,S,M|Concentration, up to 1 hour|Wizard
Banishment|4|Abjuration|1 action|60 ft|V,S,M|Concentration, up to 1 minute|Cleric,Paladin,Sorcerer,Warlock,Wizard
Blight|4|Necromancy|1 action|30 ft|V,S|Instantaneous|Druid,Sorcerer,Warlock,Wizard
Compulsion|4|Enchantment|1 action|30 ft|V,S|Concentration, up to 1 minute|Bard
Confusion|4|Enchantment|1 action|90 ft|V,S,M|Concentration, up to 1 minute|Bard,Druid,Sorcerer,Wizard
Conjure Minor Elementals|4|Conjuration|1 minute|90 ft|V,S|Concentration, up to 1 hour|Druid,Wizard
Conjure Woodland Beings|4|Conjuration|1 action|60 ft|V,S,M|Concentration, up to 1 hour|Druid,Ranger
Control Water|4|Transmutation|1 action|300 ft|V,S,M|Concentration, up to 10 minutes|Cleric,Druid,Wizard
Death Ward|4|Abjuration|1 action|Touch|V,S|8 hours|Cleric,Paladin
Dimension Door|4|Conjuration|1 action|500 ft|V|Instantaneous|Bard,Sorcerer,Warlock,Wizard
Divination|4|Divination|1 action|Self|V,S,M|Instantaneous|Cleric
Dominate Beast|4|Enchantment|1 action|60 ft|V,S|Concentration, up to 1 minute|Druid,Sorcerer
Fabricate|4|Transmutation|10 minutes|120 ft|V,S|Instantaneous|Wizard
Faithful Hound|4|Conjuration|1 action|30 ft|V,S,M|8 hours|Wizard
Fire Shield|4|Evocation|1 action|Self|V,S,M|10 minutes|Wizard
Freedom of Movement|4|Abjuration|1 action|Touch|V,S,M|1 hour|Bard,Cleric,Druid,Ranger
Giant Insect|4|Transmutation|1 action|30 ft|V,S|Concentration, up to 10 minutes|Druid
Grasping Vine|4|Conjuration|1 bonus action|30 ft|V,S|Concentration, up to 1 minute|Druid,Ranger
Greater Invisibility|4|Illusion|1 action|Touch|V,S|Concentration, up to 1 minute|Bard,Sorcerer,Wizard
Guardian of Faith|4|Conjuration|1 action|30 ft|V|8 hours|Cleric
Hallucinatory Terrain|4|Illusion|10 minutes|300 ft|V,S,M|24 hours|Bard,Druid,Warlock,Wizard
Ice Storm|4|Evocation|1 action|300 ft|V,S,M|Instantaneous|Druid,Sorcerer,Wizard
Locate Creature|4|Divination|1 action|Self|V,S,M|Concentration, up to 1 hour|Bard,Cleric,Druid,Paladin,Ranger,Wizard
Otiluke's Resilient Sphere|4|Evocation|1 action|30 ft|V,S,M|Concentration, up to 1 minute|Wizard
Phantasmal Killer|4|Illusion|1 action|120 ft|V,S|Concentration, up to 1 minute|Wizard
Polymorph|4|Transmutation|1 action|60 ft|V,S,M|Concentration, up to 1 hour|Bard,Druid,Sorcerer,Wizard
Staggering Smite|4|Evocation|1 bonus action|Self|V|Concentration, up to 1 minute|Paladin
Stone Shape|4|Transmutation|1 action|Touch|V,S,M|Instantaneous|Cleric,Druid,Wizard
Stoneskin|4|Abjuration|1 action|Touch|V,S,M|Concentration, up to 1 hour|Druid,Ranger,Sorcerer,Wizard
Wall of Fire|4|Evocation|1 action|120 ft|V,S,M|Concentration, up to 1 minute|Druid,Sorcerer,Wizard
Antilife Shell|5|Abjuration|1 action|Self (10-ft radius)|V,S|Concentration, up to 1 hour|Druid
Awaken|5|Transmutation|8 hours|Touch|V,S,M|Instantaneous|Bard,Druid
Banishing Smite|5|Abjuration|1 bonus action|Self|V|Concentration, up to 1 minute|Paladin
Bigby's Hand|5|Evocation|1 action|120 ft|V,S,M|Concentration, up to 1 minute|Wizard
Circle of Power|5|Abjuration|1 action|Self (30-ft radius)|V|Concentration, up to 10 minutes|Paladin
Cloudkill|5|Conjuration|1 action|120 ft|V,S|Concentration, up to 10 minutes|Sorcerer,Wizard
Commune|5|Divination|1 minute|Self|V,S,M|1 minute|Cleric
Commune with Nature|5|Divination|1 minute|Self|V,S|Instantaneous|Druid,Ranger
Cone of Cold|5|Evocation|1 action|Self (60-ft cone)|V,S,M|Instantaneous|Sorcerer,Wizard
Conjure Elemental|5|Conjuration|1 minute|90 ft|V,S,M|Concentration, up to 1 hour|Druid,Wizard
Conjure Volley|5|Conjuration|1 action|150 ft|V,S,M|Instantaneous|Ranger
Contact Other Plane|5|Divination|1 minute|Self|V|1 minute|Warlock,Wizard
Contagion|5|Necromancy|1 action|Touch|V,S|7 days|Cleric,Druid
Creation|5|Illusion|1 minute|30 ft|V,S,M|Special|Sorcerer,Wizard
Destructive Wave|5|Evocation|1 action|Self (30-ft radius)|V|Instantaneous|Paladin
Dispel Evil and Good|5|Abjuration|1 action|Self|V,S,M|Concentration, up to 1 minute|Cleric,Paladin
Dominate Person|5|Enchantment|1 action|60 ft|V,S|Concentration, up to 1 minute|Bard,Sorcerer,Wizard
Dream|5|Illusion|1 minute|Special|V,S,M|8 hours|Bard,Warlock,Wizard
Flame Strike|5|Evocation|1 action|60 ft|V,S,M|Instantaneous|Cleric
Geas|5|Enchantment|1 minute|60 ft|V|30 days|Bard,Cleric,Druid,Paladin,Wizard
Greater Restoration|5|Abjuration|1 action|Touch|V,S,M|Instantaneous|Bard,Cleric,Druid
Hallow|5|Evocation|24 hours|Touch|V,S,M|Until dispelled|Cleric
Hold Monster|5|Enchantment|1 action|90 ft|V,S,M|Concentration, up to 1 minute|Bard,Sorcerer,Warlock,Wizard
Insect Plague|5|Conjuration|1 action|300 ft|V,S,M|Concentration, up to 10 minutes|Cleric,Druid,Sorcerer
Legend Lore|5|Divination|10 minutes|Self|V,S,M|Instantaneous|Bard,Cleric,Wizard
Mass Cure Wounds|5|Evocation|1 action|60 ft|V,S|Instantaneous|Bard,Cleric,Druid
Mislead|5|Illusion|1 action|Self|S|Concentration, up to 1 hour|Bard,Wizard
Modify Memory|5|Enchantment|1 action|30 ft|V,S|Concentration, up to 1 minute|Bard,Wizard
Passwall|5|Transmutation|1 action|30 ft|V,S,M|1 hour|Wizard
Planar Binding|5|Abjuration|1 hour|60 ft|V,S,M|24 hours|Bard,Cleric,Druid,Wizard
Raise Dead|5|Necromancy|1 hour|Touch|V,S,M|Instantaneous|Bard,Cleric,Paladin
Reincarnate|5|Transmutation|1 hour|Touch|V,S,M|Instantaneous|Druid
Scrying|5|Divination|10 minutes|Self|V,S,M|Concentration, up to 10 minutes|Bard,Cleric,Druid,Warlock,Wizard
Seeming|5|Illusion|1 action|30 ft|V,S|8 hours|Bard,Sorcerer,Warlock,Wizard
Swift Quiver|5|Transmutation|1 bonus action|Touch|V,S,M|Concentration, up to 1 minute|Ranger
Telekinesis|5|Transmutation|1 action|60 ft|V,S|Concentration, up to 10 minutes|Sorcerer,Wizard
Teleportation Circle|5|Conjuration|1 minute|10 ft|V,M|1 round|Bard,Sorcerer,Wizard
Tree Stride|5|Conjuration|1 action|Self|V,S|Concentration, up to 1 minute|Druid,Ranger
Wall of Force|5|Evocation|1 action|120 ft|V,S,M|Concentration, up to 10 minutes|Wizard
Wall of Stone|5|Evocation|1 action|120 ft|V,S,M|Concentration, up to 10 minutes|Druid,Sorcerer,Wizard
Blade Barrier|6|Evocation|1 action|90 ft|V,S|Concentration, up to 10 minutes|Cleric
Chain Lightning|6|Evocation|1 action|150 ft|V,S,M|Instantaneous|Sorcerer,Wizard
Circle of Death|6|Necromancy|1 action|150 ft|V,S,M|Instantaneous|Sorcerer,Warlock,Wizard
Conjure Fey|6|Conjuration|1 minute|90 ft|V,S|Concentration, up to 1 hour|Druid,Warlock
Contingency|6|Evocation|10 minutes|Self|V,S,M|10 days|Wizard
Create Undead|6|Necromancy|1 minute|10 ft|V,S,M|Instantaneous|Cleric,Warlock,Wizard
Disintegrate|6|Transmutation|1 action|60 ft|V,S,M|Instantaneous|Sorcerer,Wizard
Drawmij's Instant Summons|6|Conjuration|1 minute|Touch|V,S,M|Until dispelled|Wizard
Eyebite|6|Necromancy|1 action|Self|V,S|Concentration, up to 1 minute|Bard,Sorcerer,Warlock,Wizard
Find the Path|6|Divination|1 minute|Self|V,S,M|Concentration, up to 1 day|Bard,Cleric,Druid
Flesh to Stone|6|Transmutation|1 action|60 ft|V,S,M|Concentration, up to 1 minute|Warlock,Wizard
Forbiddance|6|Abjuration|10 minutes|Touch|V,S,M|1 day|Cleric
Globe of Invulnerability|6|Abjuration|1 action|Self (10-ft radius)|V,S,M|Concentration, up to 1 minute|Sorcerer,Wizard
Guards and Wards|6|Abjuration|10 minutes|Touch|V,S,M|24 hours|Bard,Wizard
Harm|6|Necromancy|1 action|60 ft|V,S|Instantaneous|Cleric
Heal|6|Evocation|1 action|60 ft|V,S|Instantaneous|Cleric,Druid
Heroes' Feast|6|Conjuration|10 minutes|30 ft|V,S,M|Instantaneous|Cleric,Druid
Magic Jar|6|Necromancy|1 minute|Self|V,S,M|Until dispelled|Wizard
Mass Suggestion|6|Enchantment|1 action|60 ft|V,M|24 hours|Bard,Sorcerer,Warlock,Wizard
Move Earth|6|Transmutation|1 action|120 ft|V,S,M|Concentration, up to 2 hours|Druid,Sorcerer,Wizard
Otiluke's Freezing Sphere|6|Evocation|1 action|300 ft|V,S,M|Instantaneous|Wizard
Otto's Irresistible Dance|6|Enchantment|1 action|30 ft|V|Concentration, up to 1 minute|Bard,Wizard
Planar Ally|6|Conjuration|10 minutes|60 ft|V,S|Instantaneous|Cleric
Programmed Illusion|6|Illusion|1 action|120 ft|V,S,M|Until dispelled|Bard,Wizard
Sunbeam|6|Evocation|1 action|Self (60-ft line)|V,S,M|Concentration, up to 1 minute|Druid,Sorcerer,Wizard
Transport via Plants|6|Conjuration|1 action|10 ft|V,S|1 round|Druid
True Seeing|6|Divination|1 action|Touch|V,S,M|1 hour|Bard,Cleric,Sorcerer,Warlock,Wizard
Wall of Ice|6|Evocation|1 action|120 ft|V,S,M|Concentration, up to 10 minutes|Wizard
Wall of Thorns|6|Conjuration|1 action|120 ft|V,S,M|Concentration, up to 10 minutes|Druid
Wind Walk|6|Transmutation|1 minute|30 ft|V,S,M|8 hours|Druid
Word of Recall|6|Conjuration|1 action|5 ft|V|Instantaneous|Cleric
Arcane Sword|7|Evocation|1 action|60 ft|V,S,M|Concentration, up to 1 minute|Bard,Wizard
Conjure Celestial|7|Conjuration|1 minute|90 ft|V,S|Concentration, up to 1 hour|Cleric
Delayed Blast Fireball|7|Evocation|1 action|150 ft|V,S,M|Concentration, up to 1 minute|Sorcerer,Wizard
Divine Word|7|Evocation|1 bonus action|30 ft|V|Instantaneous|Cleric
Etherealness|7|Transmutation|1 action|Self|V,S|Up to 8 hours|Bard,Cleric,Sorcerer,Warlock,Wizard
Finger of Death|7|Necromancy|1 action|60 ft|V,S|Instantaneous|Sorcerer,Warlock,Wizard
Fire Storm|7|Evocation|1 action|150 ft|V,S|Instantaneous|Cleric,Druid,Sorcerer
Forcecage|7|Evocation|1 action|100 ft|V,S,M|1 hour|Bard,Warlock,Wizard
Mirage Arcane|7|Illusion|10 minutes|Sight|V,S|10 days|Bard,Druid,Wizard
Mordenkainen's Magnificent Mansion|7|Conjuration|1 minute|300 ft|V,S,M|24 hours|Bard,Wizard
Mordenkainen's Sword|7|Evocation|1 action|60 ft|V,S,M|Concentration, up to 1 minute|Bard,Wizard
Plane Shift|7|Conjuration|1 action|Touch|V,S,M|Instantaneous|Cleric,Druid,Sorcerer,Warlock,Wizard
Prismatic Spray|7|Evocation|1 action|Self (60-ft cone)|V,S|Instantaneous|Sorcerer,Wizard
Project Image|7|Illusion|1 action|500 miles|V,S,M|Concentration, up to 1 day|Bard,Wizard
Regenerate|7|Transmutation|1 minute|Touch|V,S,M|1 hour|Bard,Cleric,Druid
Resurrection|7|Necromancy|1 hour|Touch|V,S,M|Instantaneous|Bard,Cleric
Reverse Gravity|7|Transmutation|1 action|100 ft|V,S,M|Concentration, up to 1 minute|Druid,Sorcerer,Wizard
Sequester|7|Transmutation|1 action|Touch|V,S,M|Until dispelled|Wizard
Simulacrum|7|Illusion|12 hours|Touch|V,S,M|Until dispelled|Wizard
Symbol|7|Abjuration|1 minute|Touch|V,S,M|Until dispelled or triggered|Bard,Cleric,Wizard
Teleport|7|Conjuration|1 action|10 ft|V|Instantaneous|Bard,Sorcerer,Wizard
Antimagic Field|8|Abjuration|1 action|Self (10-ft radius)|V,S,M|Concentration, up to 1 hour|Cleric,Wizard
Antipathy/Sympathy|8|Enchantment|1 hour|60 ft|V,S,M|10 days|Druid,Wizard
Clone|8|Necromancy|1 hour|Touch|V,S,M|Instantaneous|Wizard
Control Weather|8|Transmutation|10 minutes|Self (5-mile radius)|V,S,M|Concentration, up to 8 hours|Cleric,Druid,Wizard
Demiplane|8|Conjuration|1 action|60 ft|S|1 hour|Warlock,Wizard
Dominate Monster|8|Enchantment|1 action|60 ft|V,S|Concentration, up to 1 hour|Bard,Sorcerer,Warlock,Wizard
Earthquake|8|Evocation|1 action|500 ft|V,S,M|Concentration, up to 1 minute|Cleric,Druid,Sorcerer
Feeblemind|8|Enchantment|1 action|150 ft|V,S,M|Instantaneous|Bard,Druid,Warlock,Wizard
Glibness|8|Transmutation|1 action|Self|V|1 hour|Bard,Warlock
Holy Aura|8|Abjuration|1 action|Self|V,S,M|Concentration, up to 1 minute|Cleric
Incendiary Cloud|8|Conjuration|1 action|150 ft|V,S|Concentration, up to 1 minute|Sorcerer,Wizard
Maze|8|Conjuration|1 action|60 ft|V,S|Concentration, up to 10 minutes|Wizard
Mind Blank|8|Abjuration|1 action|Touch|V,S|24 hours|Bard,Wizard
Power Word Stun|8|Enchantment|1 action|60 ft|V|Instantaneous|Bard,Sorcerer,Warlock,Wizard
Sunburst|8|Evocation|1 action|150 ft|V,S,M|Instantaneous|Druid,Sorcerer,Wizard
Tsunami|8|Conjuration|1 minute|Sight|V,S|Concentration, up to 6 rounds|Druid
Astral Projection|9|Necromancy|1 hour|10 ft|V,S,M|Special|Cleric,Warlock,Wizard
Foresight|9|Divination|1 minute|Touch|V,S,M|8 hours|Bard,Druid,Warlock,Wizard
Gate|9|Conjuration|1 action|60 ft|V,S,M|Concentration, up to 1 minute|Cleric,Sorcerer,Wizard
Imprisonment|9|Abjuration|1 minute|30 ft|V,S,M|Until dispelled|Warlock,Wizard
Mass Heal|9|Evocation|1 action|60 ft|V,S|Instantaneous|Cleric
Meteor Swarm|9|Evocation|1 action|1 mile|V,S|Instantaneous|Sorcerer,Wizard
Power Word Heal|9|Evocation|1 action|Touch|V,S|Instantaneous|Bard
Power Word Kill|9|Enchantment|1 action|60 ft|V|Instantaneous|Bard,Sorcerer,Warlock,Wizard
Prismatic Wall|9|Abjuration|1 action|60 ft|V,S|10 minutes|Wizard
Shapechange|9|Transmutation|1 action|Self|V,S,M|Concentration, up to 1 hour|Druid,Wizard
Storm of Vengeance|9|Conjuration|1 action|Sight|V,S|Concentration, up to 1 minute|Druid
Time Stop|9|Transmutation|1 action|Self|V|Instantaneous|Sorcerer,Wizard
True Polymorph|9|Transmutation|1 action|30 ft|V,S,M|Concentration, up to 1 hour|Bard,Warlock,Wizard
True Resurrection|9|Necromancy|1 hour|Touch|V,S,M|Instantaneous|Cleric,Druid
Weird|9|Illusion|1 action|120 ft|V,S|Concentration, up to 1 minute|Wizard
Wish|9|Conjuration|1 action|Self|V|Instantaneous|Sorcerer,Wizard
Ceremony|1|Abjuration|1 hour|Touch|V,S,M|Instantaneous|Cleric,Paladin
Chaos Bolt|1|Evocation|1 action|120 ft|V,S|Instantaneous|Sorcerer
Frost Fingers|1|Evocation|1 action|Self (15-ft cone)|V,S|Instantaneous|Wizard
Snare|1|Abjuration|1 minute|Touch|S,M|8 hours|Druid,Ranger,Wizard
Zephyr Strike|1|Transmutation|1 bonus action|Self|V|Concentration, up to 1 minute|Ranger
Guiding Hand|1|Divination|1 action|10 ft|V,S|Concentration, up to 1 hour|Cleric,Wizard
Cause Fear|1|Necromancy|1 action|60 ft|V|Concentration, up to 1 minute|Warlock,Wizard
Distort Value|1|Illusion|1 action|Touch|V,S,M|8 hours|Bard,Sorcerer,Warlock,Wizard
Silvery Barbs|1|Enchantment|1 reaction|60 ft|V|Instantaneous|Bard,Sorcerer,Wizard
Tasha's Bubbling Cauldron|1|Conjuration|1 bonus action|5 ft|V,S,M|10 minutes|Warlock,Wizard
Gift of Alacrity|1|Divination|1 minute|Touch|V,S|8 hours|Wizard
Jim's Magic Missile|1|Evocation|1 action|120 ft|V,S,M|Instantaneous|Sorcerer,Wizard
Wild Cunning|1|Transmutation|1 bonus action|Self|V,S|Instantaneous|Druid,Ranger
Bless Weapon|1|Transmutation|1 action|Touch|V,S|1 minute|Paladin
Immovable Object|2|Transmutation|1 action|Touch|V,S,M|1 minute|Bard,Sorcerer,Wizard
Kinetic Jaunt|2|Transmutation|1 bonus action|Self|S|Concentration, up to 1 minute|Bard,Sorcerer,Wizard
Nathair's Mischief|2|Illusion|1 action|60 ft|V,S,M|Concentration, up to 1 minute|Bard,Sorcerer,Wizard
Pyrotechnics|2|Transmutation|1 action|60 ft|V,S|Instantaneous|Bard,Sorcerer,Wizard
Skywrite|2|Transmutation|1 action|Sight|V,S|Concentration, up to 1 day|Bard,Druid,Wizard
Wither and Bloom|2|Necromancy|1 action|60 ft|V,S,M|Instantaneous|Druid,Sorcerer,Wizard
Wristpocket|2|Conjuration|1 action|Self|S|Concentration, up to 1 hour|Wizard
Earthbind|2|Transmutation|1 action|300 ft|V|Concentration, up to 1 minute|Druid,Sorcerer,Warlock,Wizard
Borrowed Knowledge|2|Divination|1 action|Self|V,S,M|1 hour|Bard,Cleric,Warlock,Wizard
Rime's Binding Ice|2|Evocation|1 action|Self (30-ft cone)|S,M|Instantaneous|Sorcerer,Wizard
Vortex Warp|2|Conjuration|1 action|90 ft|V,S|Instantaneous|Sorcerer,Wizard
Summon Beast|2|Conjuration|1 action|90 ft|V,S,M|Concentration, up to 1 hour|Druid,Ranger
Mind Spike|2|Divination|1 action|60 ft|S|Concentration, up to 1 hour|Sorcerer,Warlock,Wizard
Ashardalon's Stride|3|Transmutation|1 bonus action|Self|V,S|Concentration, up to 1 minute|Ranger,Sorcerer,Wizard
Enemies Abound|3|Enchantment|1 action|120 ft|V,S|Concentration, up to 1 minute|Bard,Sorcerer,Warlock,Wizard
Flame Arrows|3|Transmutation|1 action|Touch|V,S|Concentration, up to 1 hour|Druid,Ranger,Sorcerer,Wizard
Intellect Fortress|3|Abjuration|1 action|30 ft|V|Concentration, up to 1 hour|Bard,Sorcerer,Warlock,Wizard
Life Transference|3|Necromancy|1 action|30 ft|V,S|Instantaneous|Cleric,Wizard
Melf's Minute Meteors|3|Evocation|1 action|120 ft|V,S,M|Concentration, up to 10 minutes|Sorcerer,Wizard
Summon Lesser Demons|3|Conjuration|1 action|60 ft|V,S,M|Concentration, up to 1 hour|Warlock,Wizard
Thunder Step|3|Conjuration|1 action|90 ft|V|Instantaneous|Sorcerer,Warlock,Wizard
Tiny Servant|3|Transmutation|1 minute|Touch|V,S|8 hours|Wizard
Wall of Water|3|Evocation|1 action|60 ft|V,S,M|Concentration, up to 10 minutes|Druid,Sorcerer,Wizard
Wall of Sand|3|Evocation|1 action|90 ft|V,S,M|Concentration, up to 10 minutes|Wizard
Catnap|3|Enchantment|1 action|30 ft|S,M|10 minutes|Bard,Sorcerer,Wizard
Galder's Tower|3|Conjuration|10 minutes|30 ft|V,S,M|24 hours|Wizard
Summon Shadowspawn|3|Conjuration|1 action|90 ft|V,S,M|Concentration, up to 1 hour|Warlock,Wizard
Summon Undead|3|Necromancy|1 action|90 ft|V,S,M|Concentration, up to 1 hour|Warlock,Wizard
Blood Boil|3|Evocation|1 action|60 ft|V,S|Concentration, up to 1 minute|Sorcerer,Warlock,Wizard
Antagonize|3|Enchantment|1 action|60 ft|V,S|Instantaneous|Bard,Cleric,Sorcerer,Warlock,Wizard
Fount of Moonlight|4|Evocation|1 bonus action|Self|V,S|Concentration, up to 1 minute|Bard,Druid,Ranger,Warlock
Charm Monster|4|Enchantment|1 action|30 ft|V,S|1 hour|Bard,Druid,Sorcerer,Warlock,Wizard
Elemental Bane|4|Transmutation|1 action|90 ft|V,S|Concentration, up to 1 minute|Druid,Warlock,Wizard
Watery Sphere|4|Conjuration|1 action|90 ft|V,S,M|Concentration, up to 1 minute|Druid,Sorcerer,Wizard
Summon Aberration|4|Conjuration|1 action|90 ft|V,S,M|Concentration, up to 1 hour|Warlock,Wizard
Summon Construct|4|Conjuration|1 action|90 ft|V,S,M|Concentration, up to 1 hour|Wizard
Summon Elemental|4|Conjuration|1 action|90 ft|V,S,M|Concentration, up to 1 hour|Druid,Ranger,Wizard
Vitriolic Sphere|4|Evocation|1 action|150 ft|V,S,M|Instantaneous|Sorcerer,Wizard
Gravity Sinkhole|4|Evocation|1 action|120 ft|V,S,M|Instantaneous|Wizard
Raulothim's Psychic Lance|4|Enchantment|1 action|120 ft|V|Instantaneous|Bard,Sorcerer,Warlock,Wizard
Storm Sphere|4|Evocation|1 action|150 ft|V,S|Concentration, up to 1 minute|Sorcerer,Wizard
Shadow of Moil|4|Necromancy|1 action|Self|V,S,M|Concentration, up to 1 minute|Warlock
Ego Whip|4|Enchantment|1 action|60 ft|V|Concentration, up to 1 minute|Bard,Sorcerer,Warlock,Wizard
Danse Macabre|5|Necromancy|1 action|60 ft|V,S|Concentration, up to 1 hour|Warlock,Wizard
Enervation|5|Necromancy|1 action|60 ft|V,S|Concentration, up to 1 minute|Sorcerer,Warlock,Wizard
Far Step|5|Conjuration|1 bonus action|Self|V|Concentration, up to 1 minute|Sorcerer,Warlock,Wizard
Holy Weapon|5|Evocation|1 bonus action|Touch|V,S|Concentration, up to 1 hour|Cleric,Paladin
Immolation|5|Evocation|1 action|90 ft|V,S|Concentration, up to 1 minute|Sorcerer,Wizard
Infernal Calling|5|Conjuration|1 minute|90 ft|V,S,M|Concentration, up to 1 hour|Warlock,Wizard
Maelstrom|5|Evocation|1 action|120 ft|V,S,M|Concentration, up to 1 minute|Druid
Negative Energy Flood|5|Necromancy|1 action|60 ft|V,M|Instantaneous|Warlock,Wizard
Skill Empowerment|5|Transmutation|1 action|Touch|V,S|Concentration, up to 1 hour|Bard,Sorcerer,Wizard
Summon Celestial|5|Conjuration|1 action|90 ft|V,S,M|Concentration, up to 1 hour|Cleric,Paladin
Summon Draconic Spirit|5|Conjuration|1 action|60 ft|V,S,M|Concentration, up to 1 hour|Druid,Ranger,Wizard
Transmute Rock|5|Transmutation|1 action|120 ft|V,S,M|Instantaneous|Druid,Wizard
Wrath of Nature|5|Evocation|1 action|120 ft|V,S|Concentration, up to 1 minute|Druid,Ranger
Yolande's Regal Presence|5|Enchantment|1 action|Self (10-ft radius)|V,S,M|Concentration, up to 1 minute|Bard,Wizard
Rary's Telepathic Bond|5|Divination|1 action|30 ft|V,S,M|1 hour|Bard,Wizard
Bones of the Earth|6|Transmutation|1 action|120 ft|V,S|Instantaneous|Druid
Druid Grove|6|Abjuration|10 minutes|Touch|V,S,M|24 hours|Druid
Fizban's Platinum Shield|6|Abjuration|1 action|60 ft|V,S,M|Concentration, up to 1 minute|Sorcerer,Wizard
Investiture of Flame|6|Transmutation|1 action|Self|V,S|Concentration, up to 10 minutes|Druid,Sorcerer,Warlock,Wizard
Investiture of Ice|6|Transmutation|1 action|Self|V,S|Concentration, up to 10 minutes|Druid,Sorcerer,Warlock,Wizard
Investiture of Stone|6|Transmutation|1 action|Self|V,S|Concentration, up to 10 minutes|Druid,Sorcerer,Warlock,Wizard
Investiture of Wind|6|Transmutation|1 action|Self|V,S|Concentration, up to 10 minutes|Druid,Sorcerer,Warlock,Wizard
Mental Prison|6|Illusion|1 action|60 ft|S|Concentration, up to 1 minute|Sorcerer,Warlock,Wizard
Primordial Ward|6|Abjuration|1 action|Self|V,S|Concentration, up to 1 minute|Druid
Scatter|6|Conjuration|1 action|30 ft|V|Instantaneous|Sorcerer,Warlock,Wizard
Soul Cage|6|Necromancy|1 reaction|60 ft|V,S,M|8 hours|Warlock,Wizard
Summon Fiend|6|Conjuration|1 minute|90 ft|V,S,M|Concentration, up to 1 hour|Warlock,Wizard
Tasha's Otherworldly Guise|6|Transmutation|1 bonus action|Self|V,S|Concentration, up to 1 minute|Sorcerer,Warlock,Wizard
Tenser's Transformation|6|Transmutation|1 action|Self|V,S,M|Concentration, up to 10 minutes|Wizard
Gravity Fissure|6|Evocation|1 action|Self (100-ft line)|V,S,M|Instantaneous|Wizard
Create Homunculus|6|Transmutation|1 hour|Touch|V,S,M|Instantaneous|Wizard
Dream of the Blue Veil|7|Conjuration|10 minutes|20 ft|V,S,M|6 hours|Bard,Sorcerer,Warlock,Wizard
Crown of Stars|7|Evocation|1 action|Self|V,S|1 hour|Sorcerer,Warlock,Wizard
Power Word Pain|7|Enchantment|1 action|60 ft|V|Instantaneous|Sorcerer,Warlock,Wizard
Temple of the Gods|7|Conjuration|1 hour|120 ft|V,S,M|24 hours|Cleric
Whirlwind|7|Evocation|1 action|300 ft|V,S,M|Concentration, up to 1 minute|Druid,Sorcerer,Wizard
Draconic Transformation|7|Transmutation|1 bonus action|Self|V,S,M|Concentration, up to 1 minute|Druid,Sorcerer,Wizard
Abi-Dalzim's Horrid Wilting|8|Necromancy|1 action|150 ft|V,S,M|Instantaneous|Sorcerer,Wizard
Illusory Dragon|8|Illusion|1 action|120 ft|S|Concentration, up to 1 minute|Wizard
Maddening Darkness|8|Evocation|1 action|150 ft|V,M|Concentration, up to 10 minutes|Warlock,Wizard
Mighty Fortress|8|Conjuration|1 minute|1 mile|V,S,M|Instantaneous|Wizard
Reality Break|8|Conjuration|1 action|60 ft|V,S,M|Concentration, up to 1 minute|Sorcerer,Wizard
Befuddlement|8|Enchantment|1 action|150 ft|V,S,M|Instantaneous|Bard,Druid,Warlock,Wizard
Mass Polymorph|9|Transmutation|1 action|120 ft|V,S,M|Concentration, up to 1 hour|Bard,Sorcerer,Wizard
Blade of Disaster|9|Conjuration|1 bonus action|60 ft|V,S|Concentration, up to 1 minute|Sorcerer,Warlock,Wizard
Invulnerability|9|Abjuration|1 action|Self|V,S,M|Concentration, up to 10 minutes|Wizard
Psychic Scream|9|Enchantment|1 action|90 ft|S|Instantaneous|Bard,Sorcerer,Warlock,Wizard
Ravenous Void|9|Evocation|1 action|1000 ft|V,S,M|Concentration, up to 1 minute|Wizard
`.trim().split('\n').map(line => {
  const [name, level, school, time, range, components, duration, classes] = line.split('|');
  return { name, level: Number(level), school, source: 'SRD',
           time, range, components, duration,
           classes: (classes || '').split(',').filter(Boolean), desc: '' };
});

function seedSpells(force) { seedCatalog('spells', ['name', 'level', 'school', 'source'], SPELL_ROWS, force); }

// Basic class reference: hit die, the two saving-throw proficiencies, primary ability,
// armor/weapon proficiencies, spellcasting ability (blank = non-caster), and a note.
const CLASSES = [
  { name:'Barbarian', source:'PHB', hitDie:'d12', saves:['STR','CON'], primary:'STR', armor:'Light, medium, shields', weapons:'Simple, martial', spellAbility:'', note:'Rage, Unarmored Defense.' },
  { name:'Bard',      source:'PHB', hitDie:'d8',  saves:['DEX','CHA'], primary:'CHA', armor:'Light', weapons:'Simple, hand crossbows, longswords, rapiers, shortswords', spellAbility:'CHA', note:'Bardic Inspiration; full caster.' },
  { name:'Cleric',    source:'PHB', hitDie:'d8',  saves:['WIS','CHA'], primary:'WIS', armor:'Light, medium, shields', weapons:'Simple', spellAbility:'WIS', note:'Divine Domain; full caster.' },
  { name:'Druid',     source:'PHB', hitDie:'d8',  saves:['INT','WIS'], primary:'WIS', armor:'Light, medium, shields (nonmetal)', weapons:'Clubs, daggers, darts, javelins, maces, quarterstaffs, scimitars, sickles, slings, spears', spellAbility:'WIS', note:'Wild Shape; full caster.' },
  { name:'Fighter',   source:'PHB', hitDie:'d10', saves:['STR','CON'], primary:'STR or DEX', armor:'All armor, shields', weapons:'Simple, martial', spellAbility:'', note:'Fighting Style, Second Wind, Action Surge.' },
  { name:'Monk',      source:'PHB', hitDie:'d8',  saves:['STR','DEX'], primary:'DEX & WIS', armor:'None', weapons:'Simple, shortswords', spellAbility:'', note:'Martial Arts, Ki, Unarmored Defense.' },
  { name:'Paladin',   source:'PHB', hitDie:'d10', saves:['WIS','CHA'], primary:'STR & CHA', armor:'All armor, shields', weapons:'Simple, martial', spellAbility:'CHA', note:'Divine Smite, Lay on Hands; half caster.' },
  { name:'Ranger',    source:'PHB', hitDie:'d10', saves:['STR','DEX'], primary:'DEX & WIS', armor:'Light, medium, shields', weapons:'Simple, martial', spellAbility:'WIS', note:'Favored Enemy; half caster.' },
  { name:'Rogue',     source:'PHB', hitDie:'d8',  saves:['DEX','INT'], primary:'DEX', armor:'Light', weapons:'Simple, hand crossbows, longswords, rapiers, shortswords', spellAbility:'', note:'Sneak Attack, Expertise, Cunning Action.' },
  { name:'Sorcerer',  source:'PHB', hitDie:'d6',  saves:['CON','CHA'], primary:'CHA', armor:'None', weapons:'Daggers, darts, slings, quarterstaffs, light crossbows', spellAbility:'CHA', note:'Sorcery Points, Metamagic; full caster.' },
  { name:'Warlock',   source:'PHB', hitDie:'d8',  saves:['WIS','CHA'], primary:'CHA', armor:'Light', weapons:'Simple', spellAbility:'CHA', note:'Pact Magic, Eldritch Invocations.' },
  { name:'Wizard',    source:'PHB', hitDie:'d6',  saves:['INT','WIS'], primary:'INT', armor:'None', weapons:'Daggers, darts, slings, quarterstaffs, light crossbows', spellAbility:'INT', note:'Spellbook, Arcane Recovery; full caster.' },
];

function seedClasses(force) { seedCatalog('classes', ['name', 'source'], CLASSES, force); }

let _flushTimer = null;
function flush() {
  clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    try { fs.writeFileSync(DB_FILE, Buffer.from(db.export())); }
    catch(e) { console.error('DB flush error:', e); }
  }, 500);
}
function flushSync() {
  clearTimeout(_flushTimer);
  _flushTimer = null;
  if (db) fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}
//  Persistent log file: every boot, crash, and shutdown lands in server.log 
const SERVER_LOG = path.join(__dirname, 'server.log');
function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(SERVER_LOG, line + '\n'); } catch (_) {}
  console.log(line);
}

process.on('exit',    (code) => { try { fs.appendFileSync(SERVER_LOG, `[${new Date().toISOString()}] server process exiting (code ${code})\n`); } catch (_) {} flushSync(); });
process.on('SIGINT',  () => { logLine('server stopping (SIGINT / Ctrl+C)');  flushSync(); process.exit(0); });
process.on('SIGTERM', () => { logLine('server stopping (SIGTERM / killed)'); flushSync(); process.exit(0); });

// Keep the server alive if a request handler ever throws unexpectedly, and log
// the cause instead of letting the process exit (which looked like "server keeps
// dying / empty NPC list"). Newer Node exits on unhandled rejections by default.
process.on('uncaughtException',  (err) => { logLine('uncaughtException  kept running: ' + ((err && err.stack) || err)); });
process.on('unhandledRejection', (err) => { logLine('unhandledRejection  kept running: ' + ((err && err.stack) || err)); });

function safeJson(s, def) { try { return JSON.parse(s); } catch(_) { return def; } }

// Flatten db.exec() result rows into plain objects. Any column named in `jsonCols` is
// parsed from its JSON string and, if `spread` is true, merged up onto the object (its
// own key removed). Shared by the reference-catalog GET endpoints.
function flattenRows(rows, jsonCols = [], spread = true) {
  if (!rows || !rows.length) return [];
  const { columns, values } = rows[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((c, i) => obj[c] = row[i]);
    jsonCols.forEach(k => {
      const parsed = safeJson(obj[k], {});
      if (spread) { delete obj[k]; Object.assign(obj, parsed); }
      else obj[k] = parsed;
    });
    return obj;
  });
}

function dbGetOne(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function dbGetAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

//  TOWN / REGION DB HELPERS 
function loadTown(town) {
  const row = dbGetOne('SELECT * FROM town_state WHERE town = ?', [town]);
  if (!row) return {
    playerVis:      { houses: {}, npcs: {} },
    npcEdits:       {},
    npcSchema:      {},
    housePositions: {},
    locPositions:   {}
  };
  return {
    playerVis:      safeJson(row.player_vis,   { houses: {}, npcs: {} }),
    npcEdits:       safeJson(row.npc_edits,    {}),
    npcSchema:      safeJson(row.npc_schema,   {}),
    housePositions: safeJson(row.house_pos,    {}),
    locPositions:   safeJson(row.loc_pos,      {}),
    loreNotes:      safeJson(row.lore_notes,   []),
  };
}

function saveTown(town, s) {
  db.run(
    `INSERT OR REPLACE INTO town_state (town, player_vis, npc_edits, npc_schema, house_pos, loc_pos, lore_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      town,
      JSON.stringify(s.playerVis      || { houses: {}, npcs: {} }),
      JSON.stringify(s.npcEdits       || {}),
      JSON.stringify(s.npcSchema      || {}),
      JSON.stringify(s.housePositions || {}),
      JSON.stringify(s.locPositions   || {}),
      JSON.stringify(Array.isArray(s.loreNotes) ? s.loreNotes : []),
    ]
  );
  flush();
}

function loadTownContent(town) {
  const row = dbGetOne('SELECT * FROM town_content WHERE town = ?', [town]);
  if (!row) return null;
  return {
    name:            row.name,
    mapImage:        row.map_image,
    totalHomes:      row.total_homes,
    totalResidents:  row.total_residents,
    households:      safeJson(row.households,       []),
    townLocations:   safeJson(row.town_locations,   []),
    houseMapDefault: safeJson(row.house_map_default, {}),
    extraMaps:       safeJson(row.extra_maps,        [])
  };
}

function saveTownContent(town, c) {
  db.run(
    `INSERT OR REPLACE INTO town_content
     (town, name, map_image, total_homes, total_residents, households, town_locations, house_map_default, extra_maps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      town,
      c.name             || '',
      c.mapImage         || '',
      c.totalHomes       || 0,
      c.totalResidents   || 0,
      JSON.stringify(c.households       || []),
      JSON.stringify(c.townLocations    || []),
      JSON.stringify(c.houseMapDefault  || {}),
      JSON.stringify(c.extraMaps        || [])
    ]
  );
  flush();
}

function loadRegionContent(region) {
  const row = dbGetOne('SELECT * FROM region_content WHERE region = ?', [region]);
  if (!row) return null;
  return {
    name:               row.name,
    mapImage:           row.map_image,
    locations:          safeJson(row.locations,            []),
    locationMapDefault: safeJson(row.location_map_default, {})
  };
}

function saveRegionContent(region, c) {
  db.run(
    `INSERT OR REPLACE INTO region_content (region, name, map_image, locations, location_map_default)
     VALUES (?, ?, ?, ?, ?)`,
    [
      region,
      c.name                              || '',
      c.mapImage                          || '',
      JSON.stringify(c.locations          || []),
      JSON.stringify(c.locationMapDefault || {})
    ]
  );
  flush();
}

// Rename all name-keyed entries (visibility, DM edits, schema) when an NPC changes name.
// playerVis.npcs / npcEdits / npcSchema all use { houseId: { npcName: data } }.
function migrateNpcNameInTown(townSlug, oldName, newName) {
  if (!townSlug || !oldName || !newName || oldName === newName) return;
  const state = loadTown(townSlug);
  let changed = false;
  [state.playerVis && state.playerVis.npcs, state.npcEdits, state.npcSchema].forEach(obj => {
    if (!obj) return;
    Object.values(obj).forEach(house => {
      if (house && Object.prototype.hasOwnProperty.call(house, oldName)) {
        house[newName] = house[oldName];
        delete house[oldName];
        changed = true;
      }
    });
  });
  if (changed) saveTown(townSlug, state);
}

function migrateNpcName(townSlug, oldName, newName) {
  migrateNpcNameInTown(townSlug, oldName, newName);
  migrateNpcNameInContent(townSlug, oldName, newName);
}

// Rename the NPC entry inside the town_content households JSON so the map tool
// displays the new name without requiring a static content file edit.
function migrateNpcNameInContent(townSlug, oldName, newName) {
  if (!townSlug || !oldName || !newName || oldName === newName) return;
  const content = loadTownContent(townSlug);
  if (!content || !Array.isArray(content.households)) return;
  let changed = false;
  content.households.forEach(house => {
    if (!Array.isArray(house.npcs)) return;
    house.npcs.forEach(npc => {
      if (npc.name === oldName) { npc.name = newName; changed = true; }
    });
  });
  if (changed) saveTownContent(townSlug, content);
}

//  NPC SHEET DB HELPERS 
// Optimistic-concurrency tag for a sheet's notes. A short, stable hash of the notes
// array: two clients editing the same notes carry the same tag; when one saves, the
// tag changes, so a second (stale) save is detected and rejected (409) instead of
// silently overwriting. Rides along in every sheet payload as `notesSig`.
function notesSig(notes) {
  return crypto.createHash('sha1').update(JSON.stringify(notes || [])).digest('hex').slice(0, 12);
}

function loadNpcSheet(npcId) {
  const row = dbGetOne('SELECT * FROM npc_sheets WHERE npc_id = ?', [npcId]);
  if (!row) return null;
  const notes = safeJson(row.notes, []);
  return {
    npcId:       row.npc_id,
    name:        row.name,
    type:        row.type,
    image:       row.image,
    location:    row.location  || '',
    premises:    row.premises  || '',
    inParty:     !!row.in_party,
    charData:    safeJson(row.char_data,    {}),
    monsterData: safeJson(row.monster_data, {}),
    notes,
    playerNotes: safeJson(row.player_notes, []),
    notesSig:    notesSig(notes),
  };
}

function saveNpcSheet(npcId, data) {
  db.run(
    `INSERT OR REPLACE INTO npc_sheets (npc_id, name, type, image, location, premises, in_party, char_data, monster_data, notes, player_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      npcId,
      data.name        || '',
      data.type        || 'character',
      data.image       || null,
      data.location    || '',
      data.premises    || '',
      data.inParty     ? 1 : 0,
      JSON.stringify(data.charData    || {}),
      JSON.stringify(data.monsterData || {}),
      JSON.stringify(data.notes       || []),
      JSON.stringify(data.playerNotes || []),
    ]
  );
  flush();
}

function listNpcSheets() {
  return dbGetAll('SELECT npc_id, name, type, image, location, premises, in_party FROM npc_sheets ORDER BY name')
    .map(r => ({ npcId: r.npc_id, name: r.name, type: r.type, image: r.image, location: r.location || '', premises: r.premises || '', inParty: !!r.in_party }));
}

// Merge NPC sheets that have a location into the town content so they appear in the map tool.
// NPCs with premises  injected into their matching household.
// NPCs without premises  grouped into a virtual "LocationName NPCs" household at the top.
function injectNpcSheetNpcs(townSlug, content) {
  if (!content || !Array.isArray(content.households)) return;
  const relevant = dbGetAll("SELECT npc_id, name, location, premises FROM npc_sheets WHERE location != '' ORDER BY npc_id")
    .filter(r => slug(r.location || '') === townSlug);
  if (!relevant.length) return;

  const unplaced = [];
  content.households.forEach(house => {
    const houseSlug = slug(house.name || '');
    relevant.filter(r => r.premises && slug(r.premises) === houseSlug).forEach(r => {
      if (!Array.isArray(house.npcs)) house.npcs = [];
      const existing = house.npcs.find(n => n.name === r.name);
      if (existing) { if (!existing.npcId) existing.npcId = r.npc_id; }  // link content-defined NPC to its sheet
      else house.npcs.push({ name: r.name, npcId: r.npc_id });
    });
  });
  relevant.filter(r => !r.premises).forEach(r => {
    unplaced.push({ name: r.name, npcId: r.npc_id });
  });
  if (unplaced.length > 0) {
    const locName = relevant[0].location || townSlug;
    content.households.unshift({
      id: '_loc_npcs',
      name: locName + ' NPCs',
      residents: unplaced.length,
      npcs: unplaced,
      desc: '',
      virtual: true
    });
  }
}

function getAllPlayerNotes() {
  const result = {};
  dbGetAll('SELECT npc_id, name, player_notes FROM npc_sheets').forEach(row => {
    const raw   = safeJson(row.player_notes, []);
    const notes = Array.isArray(raw) ? raw : (raw.notes || []);
    const image = Array.isArray(raw) ? null : (raw.image || null);
    if (notes.length > 0 || image) {
      const entry = { name: row.name, notes, image };
      result[row.npc_id] = entry;
      // Also index by name slug so map-tool lookups match even when npc_id differs from the map NPC name.
      const nameSlug = slug(row.name || '');
      if (nameSlug && nameSlug !== row.npc_id) result[nameSlug] = entry;
    }
  });
  return result;
}

function getAllNpcImages() {
  const result = {};
  dbGetAll('SELECT npc_id, name, image FROM npc_sheets WHERE image IS NOT NULL').forEach(row => {
    result[row.npc_id] = row.image;
    // Also index by name slug so map-tool lookups match even when npc_id differs from the map NPC name.
    const nameSlug = slug(row.name || '');
    if (nameSlug && nameSlug !== row.npc_id) result[nameSlug] = row.image;
  });
  return result;
}

//  DM DETECTION 
function isDM(req) {
  // A browser that authenticated with the DM key (?dmkey=) is the DM anywhere,
  // including over the tunnel. (helpers defined in the PLAYER IDENTITY block)
  if (req._isDmCookie || hasDmCookie(req)) return true;
  // Otherwise only a direct localhost connection is the DM.
  // CF tunnel headers are injected by cloudflared before reaching Express.
  // cloudflared connects from 127.0.0.1, so the IP check must come AFTER these.
  if (req.headers['cf-ray'])           return false;
  if (req.headers['cf-connecting-ip']) return false;
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function dmOnly(req, res, next) {
  if (!isDM(req)) return res.status(403).json({ error: 'DM only' });
  next();
}

function slug(raw) {
  return (raw || '').toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

//  PLAYER IDENTITY 
// A ?key=<token> link identifies a player and drops a signed, HttpOnly cookie so
// the browser stays that player. The cookie is HMAC-signed with a per-install
// secret (auto-generated, kept in a local dotfile the static server won't serve).
const SECRET_FILE = path.join(__dirname, '.player-cookie-secret');
let COOKIE_SECRET;
try { COOKIE_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (_) {}
if (!COOKIE_SECRET) {
  COOKIE_SECRET = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(SECRET_FILE, COOKIE_SECRET); } catch (_) {}
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function signPid(pid) {
  const sig = crypto.createHmac('sha256', COOKIE_SECRET).update(pid).digest('hex').slice(0, 24);
  return pid + '.' + sig;
}
// Signed value for the DM cookie (set once via ?dmkey=<DM_KEY>).
function signDm() { return crypto.createHmac('sha256', COOKIE_SECRET).update('dm-role').digest('hex').slice(0, 32); }
function hasDmCookie(req) {
  const c = parseCookies(req).dm;
  return !!c && c === signDm();
}
function verifyPid(signed) {
  if (!signed) return null;
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const pid = signed.slice(0, i), sig = signed.slice(i + 1);
  const good = crypto.createHmac('sha256', COOKIE_SECRET).update(pid).digest('hex').slice(0, 24);
  if (sig.length !== good.length) return null;
  let diff = 0;
  for (let k = 0; k < sig.length; k++) diff |= sig.charCodeAt(k) ^ good.charCodeAt(k);
  return diff === 0 ? pid : null;
}

function listPlayers()          { return dbGetAll('SELECT * FROM players ORDER BY created'); }
function getPlayer(pid)         { return pid ? dbGetOne('SELECT * FROM players WHERE pid = ?',   [pid]) : null; }
function getPlayerByToken(tok)  { return tok ? dbGetOne('SELECT * FROM players WHERE token = ?', [tok]) : null; }
function touchPlayer(pid) {
  const p = getPlayer(pid);
  if (p && Date.now() - (p.last_seen || 0) > 60000) { db.run('UPDATE players SET last_seen = ? WHERE pid = ?', [Date.now(), pid]); flush(); }
}
// The player driving the current request (from ?key= this request, or the cookie).
function currentPlayer(req) {
  if (req._playerPid) return getPlayer(req._playerPid);
  const pid = verifyPid(parseCookies(req).pid);
  return pid ? getPlayer(pid) : null;
}
// A character sheet may be edited by the DM, or by the single player it is assigned to
// (players[].character_id). The DM always retains full control of every sheet.
function canEditCharacter(req, npcId) {
  if (isDM(req)) return true;
  const p = currentPlayer(req);
  return !!(p && p.character_id && slug(p.character_id) === slug(npcId));
}
// Middleware: allow the DM, or the player this :id character is assigned to.
function dmOrOwner(req, res, next) {
  if (canEditCharacter(req, slug(req.params.id))) return next();
  return res.status(403).json({ error: 'forbidden' });
}
// Middleware: allow the DM, or any identified player (e.g. to post a dice roll).
function dmOrPlayer(req, res, next) {
  if (isDM(req) || currentPlayer(req)) return next();
  return res.status(403).json({ error: 'forbidden' });
}

function publicBaseUrl() { return (tunnelUrl && tunnelUrl.replace(/\/$/, '')) || `http://localhost:${PORT}`; }
// A player's own character sheet in the NPC tool. `?key` sets their PLAYER identity (never DM —
// isDM() is false over the tunnel), and `&npc=<their character>` opens straight onto their sheet
// instead of the whole NPC tool. Omitting &npc (no assigned character) just opens the tool.
function buildPlayerLink(token, characterId) {
  const npc = characterId ? `&npc=${encodeURIComponent(characterId)}` : '';
  return `${publicBaseUrl()}/npcs/npc_tool.html?key=${token}${npc}`;
}
function buildMapLink(token)    { return `${publicBaseUrl()}/nocropi.html?key=${token}`; }          // maps (atlas)

// Live presence: pid  number of open SSE connections (wired when the player
// view lands in a later phase; the DM roster reads it as an online indicator).
const onlinePlayers = new Map();

//  SSE CLIENTS 
const sseClients    = new Map(); // town slug  Set<res>
const npcSseClients = new Set(); // all NPC tool SSE clients

function initSse(res) {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

// Subscribe an SSE response to a client Set: send stream headers, register it, keep
// the connection alive with a heartbeat, and clean up on disconnect. Consolidates the
// identical boilerplate that every SSE route used to repeat.
function subscribeSse(req, res, set) {
  initSse(res);
  res._isDM = isDM(req);   // tag DM connections so player-only broadcasts (Sync players) can skip them
  set.add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
  req.on('close', () => { clearInterval(hb); set.delete(res); });
}

function broadcast(town, data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.get(town)?.forEach(res => { try { res.write(msg); } catch(e) {} });
}

function broadcastNpc(data) {
  const msg   = `data: ${JSON.stringify(data)}\n\n`;
  const npcId = data.npcId ? slug(data.npcId) : null;
  npcSseClients.forEach(c => {
    // Character-specific events (with an npcId) reach the DM and ONLY the player who
    // owns that character; global events (dice rolls, live-reload) reach everyone.
    if (c.pid && npcId) {
      const p = getPlayer(c.pid);
      if (!p || slug(p.character_id || '') !== npcId) return;
    }
    try { c.res.write(msg); } catch (e) {}
  });
}

function broadcastAll(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(clients => {
    clients.forEach(res => { try { res.write(msg); } catch(e) {} });
  });
}

// Fan an event out to EVERY open stream (all town/atlas maps AND the NPC tool).
// Used so the roll log and live-reload can ride each tab's existing main SSE instead
// of opening their own connections -- browsers cap ~6 connections per origin and each
// persistent SSE permanently consumes one, which was starving tabs ("unreachable").
function broadcastEverywhere(data) {
  broadcastAll(data);
  broadcastNpc(data);
}

// Fan out to PLAYER streams only, skipping the DM's own tabs. Atlas connections are
// tagged with res._isDM at subscribe time; NPC-tool clients carry a pid ('' = DM).
// Used by "Sync players" so the DM's tab isn't reloaded out from under them.
function broadcastPlayers(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(clients => clients.forEach(res => { if (!res._isDM) { try { res.write(msg); } catch (e) {} } }));
  npcSseClients.forEach(c => { if (c.pid) { try { c.res.write(msg); } catch (e) {} } });
}

// Fan out to DM streams ONLY (the inverse of broadcastPlayers). A DM stream is a map/atlas
// connection tagged res._isDM, or an NPC-tool client with no pid (''  = the DM). Used for
// hidden rolls, which the DM sees but players must not.
function broadcastDMs(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(clients => clients.forEach(res => { if (res._isDM) { try { res.write(msg); } catch (e) {} } }));
  npcSseClients.forEach(c => { if (!c.pid) { try { c.res.write(msg); } catch (e) {} } });
}

// Push updated player-notes and DM portrait index to all connected map-tool clients.
function broadcastPlayerNotesToAllTowns() {
  broadcastAll({ type: 'playerNotes', npcPlayerNotes: getAllPlayerNotes(), npcImages: getAllNpcImages() });
}

//  TUNNEL URL 
// Set by start.ps1 after cloudflared reports its public URL.
let tunnelUrl = null;

function broadcastTunnelUrl() {
  broadcastAll({ type: 'tunnelUrl', url: tunnelUrl });
}

//  LIVE RELOAD
// Watch ONLY the directories that hold editable tool source (html/js/css) -- and
// NON-recursively. Recursively watching __dirname pulled in node_modules (thousands
// of files); recursive fs.watch over a large tree on Windows is a known source of
// native, unlogged process crashes, and it also fired needlessly on every .db/.log
// write this server makes. Non-recursive per-dir watching avoids all of that.
let reloadTimer = null;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    // Live-reload rides the main per-tab streams (no separate reload SSE connection).
    broadcastEverywhere({ type: 'dr-reload' });
  }, 300);
}
const WATCH_DIRS = [__dirname, path.join(__dirname, 'map tool'), path.join(__dirname, 'npcs')];
for (const dir of WATCH_DIRS) {
  try {
    if (!fs.existsSync(dir)) continue;
    const w = fs.watch(dir, { recursive: false }, (event, filename) => {
      try {
        if (!filename) return;
        const base = path.basename(String(filename));
        if (!/\.(html|js|css)$/i.test(base)) return;          // only code files
        if (/^(server|specificUser)\.js$/i.test(base)) return; // never self-reload
        scheduleReload();
      } catch (e) { console.error('fs.watch handler error:', e); }
    });
    w.on('error', e => console.error(`fs.watch error (${dir}):`, e));
  } catch (e) {
    console.error(`fs.watch could not watch ${dir} (live-reload disabled for it):`, e);
  }
}

//  IMAGE UPLOAD HELPERS 
// Allowed image MIME types  maps to the file extension we'll use on disk.
const MIME_TO_EXT = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/gif': '.gif',  'image/webp': '.webp', 'image/svg+xml': '.svg',
};
// Note attachments allow the same image types PLUS PDF. Kept separate so NPC
// portrait uploads still reject non-image files.
const ATTACH_MIME_TO_EXT = { ...MIME_TO_EXT, 'application/pdf': '.pdf' };

// Parse a base64 data URL and resolve its file extension from an allowed-type map.
// Consolidates the identical parse+validate block the upload handlers used to repeat.
// Returns { ok:true, b64, mime, ext } or { ok:false, status, error }. `label` shapes
// the error text ("image" or "attachment") so messages stay meaningful per endpoint.
function parseDataUrl(dataUrl, mimeToExt, label) {
  if (!dataUrl || typeof dataUrl !== 'string') return { ok: false, status: 400, error: `Missing ${label} data` };
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!m) return { ok: false, status: 400, error: `Invalid ${label} data URL` };
  const mime = m[1].toLowerCase();
  const ext  = mimeToExt[mime];
  if (!ext) return { ok: false, status: 400, error: `Unsupported ${label} type: ${mime}` };
  return { ok: true, b64: m[2], mime, ext };
}

// Returns null on success, 'empty' if the buffer is zero bytes, 'write' on I/O error.
// ASYNC on purpose: a server must never block its event loop on file I/O. Antivirus
// real-time scanning can briefly LOCK a freshly-written image file, which would make a
// synchronous rename() freeze the entire server (every request hangs) until the scan
// releases it -- the "server unreachable, no log" symptom during portrait uploads.
async function atomicWriteFile(b64data, tmpPath, finalPath) {
  const buffer = Buffer.from(b64data, 'base64');
  if (!buffer.length) return 'empty';
  try {
    await fs.promises.writeFile(tmpPath, buffer);
    await fs.promises.rename(tmpPath, finalPath);
    return null;
  } catch(_) {
    try { await fs.promises.unlink(tmpPath); } catch(_) {}
    return 'write';
  }
}

function deleteFile(url, dir, prefix) {
  if (!url) return;
  const basename = path.basename(String(url).split('?')[0]);
  if (!basename.startsWith(prefix)) return;
  try {
    const full = path.join(dir, basename);
    if (fs.existsSync(full)) fs.unlinkSync(full);
  } catch(_) {}
}

function deleteImageFile(imageUrl) {
  if (!imageUrl) return;
  const rel      = imageUrl.replace(/^\//, '').split('/').join(path.sep);
  const basename = path.basename(rel);
  // Never touch files that weren't created by this tool  originals are protected
  if (!basename.startsWith('temp_')) return;
  // Try both the web root and the map tool subfolder (for location images)
  const allowed = __dirname + path.sep;
  [
    path.join(__dirname, rel),
    path.join(__dirname, 'map tool', rel)
  ].forEach(full => {
    const resolved = path.resolve(full);
    if (!resolved.startsWith(allowed)) return;
    try { if (fs.existsSync(resolved)) fs.unlinkSync(resolved); } catch(_) {}
  });
}

//  MIDDLEWARE 
app.use(express.json({ limit: '32mb' }));  // headroom for base64 image/PDF attachments

// API responses must never be cached  otherwise the browser can serve a stale
// isDM / sheet list, making the DM badge and the sidebar disagree.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// Identity from the URL:
//   ?dmkey=<DM_KEY>   marks this browser as the DM (works over the tunnel).
//   ?key=<token>      marks this browser as a specific player.
// Both drop a signed, HttpOnly cookie so the browser keeps that role.
const YEAR = 60 * 60 * 24 * 365;
app.use((req, res, next) => {
  const cookies = [];

  const dmkey = req.query && req.query.dmkey;
  if (dmkey && DM_KEY_VALUE) {
    const a = Buffer.from(String(dmkey)), b = Buffer.from(DM_KEY_VALUE);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      req._isDmCookie = true;
      cookies.push(`dm=${signDm()}; Path=/; Max-Age=${YEAR}; SameSite=Lax; HttpOnly`);
    }
  }

  const key = req.query && req.query.key;
  if (key) {
    const p = getPlayerByToken(String(key));
    if (p) {
      req._playerPid = p.pid;
      cookies.push(`pid=${encodeURIComponent(signPid(p.pid))}; Path=/; Max-Age=${YEAR}; SameSite=Lax; HttpOnly`);
      touchPlayer(p.pid);
    }
  }

  if (cookies.length) res.setHeader('Set-Cookie', cookies);
  next();
});

// Block server-side / sensitive files from being downloaded by anyone. Covers source
// (server.js, specificUser.js, package manifests, the launcher), operational files
// (the SQLite DB — full campaign data + player tokens!, logs, lock, secrets), and any
// dotfile. The static middleware below would otherwise serve these from the web root.
app.use((req, res, next) => {
  const p = req.path;
  if (
    /^\/(server\.js|specificUser\.js|package(-lock)?\.json|start\.ps1)$/i.test(p) ||
    /\.(db|log|lock|ps1|sqlite|sqlite3)$/i.test(p) ||   // DB, logs, lock, scripts anywhere
    /(^|\/)\.[^/]/.test(p) ||                             // any dotfile (.player-cookie-secret, etc.)
    /(^|\/)node_modules\//i.test(p)                       // never expose deps
  ) return res.status(403).end();
  next();
});

// Block player access to DM content files  case-insensitive so Windows NTFS
// case folding can't bypass the check (e.g. /Content/ or /CONTENT/).
app.use((req, res, next) => {
  if (/^\/content\b/i.test(req.path) || /^\/map tool\/content\b/i.test(req.path))
    return res.status(403).end();
  next();
});

// Cache headers helper.
//   Heavy files (images, PDFs  map images, NPC portraits, attachments) are
//    CACHED but REVALIDATED on every use: the browser keeps the bytes and asks
//    "changed?" via ETag/Last-Modified. Unchanged  304 (~200 bytes, instant,
//    cache used). Changed on disk  the new file is sent. So the cache is always
//    used when nothing changed, and always overridden when something did.
//   Everything else (pages, scripts, styles, data) is never cached  always fresh.
function imgHeaders(res, filePath) {
  if (/\.(png|jpg|jpeg|webp|gif|svg|ico|pdf)$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'no-cache');
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }
}

// Serve map tool files at root so existing URLs (/nocropi.html, /map_tool.html,
// /locations/xxx.png, /content/ etc.) keep working unchanged.
app.use(express.static(path.join(__dirname, 'map tool'), { setHeaders: imgHeaders }));

// Serve everything else from the app root (covers /npcs/, /specificUser.js, etc.)
app.use(express.static(__dirname, { setHeaders: imgHeaders }));

//  SHARED ROUTES
app.get('/', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect('/nocropi.html' + qs);
});

app.get('/api/whoami', (req, res) => {
  const dm = isDM(req);
  // A DM is never a player. Only look up player identity for non-DM requests,
  // and never let that lookup throw  otherwise this endpoint would 500 and the
  // NPC tool would fall back to player view for the DM.
  let player = null;
  if (!dm) {
    try {
      const p = currentPlayer(req);
      if (p) player = { pid: p.pid, name: p.name, characterId: p.character_id };
    } catch (_) {}
  }
  res.json({ isDM: dm, player });
});

//  MAP TOOL ROUTES 
app.get('/api/town/:town', (req, res) => {
  const town    = slug(req.params.town);
  if (!town) return res.status(400).json({ error: 'Invalid town name' });
  const state   = loadTown(town);
  const content = loadTownContent(town);
  state.npcPlayerNotes = getAllPlayerNotes();
  state.npcImages      = getAllNpcImages();
  state.tunnelUrl      = tunnelUrl;
  if (content) injectNpcSheetNpcs(town, content);
  res.json({ isDM: isDM(req), content, ...state });
});

app.post('/api/town/:town', dmOnly, (req, res) => {
  const town = slug(req.params.town);
  saveTown(town, req.body);
  const state = loadTown(town);
  state.npcPlayerNotes = getAllPlayerNotes();
  state.npcImages      = getAllNpcImages();
  broadcast(town, state);
  res.json({ ok: true });
});

app.post('/api/town/:town/content', dmOnly, (req, res) => {
  const town = slug(req.params.town);
  saveTownContent(town, req.body);
  res.json({ ok: true });
});

app.post('/api/town/:town/remove-premises', dmOnly, (req, res) => {
  const town      = slug(req.params.town);
  const houseSlug = slug(req.body.houseName || '');
  // location is stored mixed-case so slug-compare in JS (same as injectNpcSheetNpcs)
  const toUpdate = dbGetAll("SELECT npc_id, premises, location FROM npc_sheets WHERE location != ''")
    .filter(r => slug(r.location || '') === town && r.premises && slug(r.premises) === houseSlug)
    .map(r => r.npc_id);
  toUpdate.forEach(id => db.run("UPDATE npc_sheets SET premises = '' WHERE npc_id = ?", [id]));
  if (toUpdate.length > 0) {
    flush();
    broadcast(town, { type: 'npcSheetUpdate' });
  }
  res.json({ ok: true, updated: toUpdate.length });
});

app.get('/api/region/:region', (req, res) => {
  const region = slug(req.params.region);
  const state  = loadTown(region + '_atlas');
  const townsWithContent = [];
  const npcCountByTown   = {};
  // One pass over town_content: collect town slugs and count NPCs from households JSON
  dbGetAll('SELECT town, households FROM town_content').forEach(r => {
    townsWithContent.push(r.town);
    const cnt = safeJson(r.households, []).reduce((s, h) => s + (Array.isArray(h.npcs) ? h.npcs.length : 0), 0);
    if (cnt > 0) npcCountByTown[r.town] = cnt;
  });
  // Also count NPC sheets with location set but no premises (virtual "unplaced" group, not in household JSON)
  dbGetAll("SELECT location FROM npc_sheets WHERE location != '' AND premises = ''").forEach(r => {
    const ts = slug(r.location || '');
    if (ts) npcCountByTown[ts] = (npcCountByTown[ts] || 0) + 1;
  });
  res.json({ isDM: isDM(req), content: loadRegionContent(region), townsWithContent, npcCountByTown, ...state });
});

app.post('/api/region/:region/content', dmOnly, (req, res) => {
  const region = slug(req.params.region);
  saveRegionContent(region, req.body);
  res.json({ ok: true });
});

// SSE stream for a town (map tool)
app.get('/api/events/:town', (req, res) => {
  const town = slug(req.params.town);
  if (!sseClients.has(town)) sseClients.set(town, new Set());
  subscribeSse(req, res, sseClients.get(town));

  const state = loadTown(town);
  state.npcPlayerNotes = getAllPlayerNotes();
  state.npcImages      = getAllNpcImages();
  state.tunnelUrl      = tunnelUrl;
  res.write(`data: ${JSON.stringify(state)}\n\n`);
});

// Called by start.ps1 once cloudflared reports its public URL.
// Only accepts connections from localhost (same machine as the DM).
app.get('/api/tunnel-url', dmOnly, (req, res) => {
  res.json({ url: tunnelUrl });
});

app.post('/api/tunnel-url', (req, res) => {
  if (!isDM(req)) return res.status(403).end();
  const body = req.body || {};
  tunnelUrl = (body.url && typeof body.url === 'string') ? body.url : null;
  broadcastTunnelUrl();
  res.json({ ok: true });
});

//  D&D BEYOND IMPORT 
const DDB_ALIGNMENTS = {
  1:'Lawful Good',2:'Neutral Good',3:'Chaotic Good',
  4:'Lawful Neutral',5:'True Neutral',6:'Chaotic Neutral',
  7:'Lawful Evil',8:'Neutral Evil',9:'Chaotic Evil'
};
const DDB_SKILL_MAP = {
  'athletics':'athletics','acrobatics':'acrobatics',
  'sleight-of-hand':'sleightOfHand','stealth':'stealth',
  'arcana':'arcana','history':'history','investigation':'investigation',
  'nature':'nature','religion':'religion','animal-handling':'animalHandling',
  'insight':'insight','medicine':'medicine','perception':'perception',
  'survival':'survival','deception':'deception','intimidation':'intimidation',
  'performance':'performance','persuasion':'persuasion'
};
const DDB_SAVE_MAP = {
  'strength-saving-throws':'str','dexterity-saving-throws':'dex',
  'constitution-saving-throws':'con','intelligence-saving-throws':'int',
  'wisdom-saving-throws':'wis','charisma-saving-throws':'cha'
};
const DDB_SPELL_ABILITY = {
  'bard':'CHA','cleric':'WIS','druid':'WIS','paladin':'CHA','ranger':'WIS',
  'sorcerer':'CHA','warlock':'CHA','wizard':'INT'
};
const DDB_WEAPON_KEYS = ['weapon','sword','axe','bow','crossbow','hammer','spear',
  'dagger','mace','staff','martial','simple','firearm','lance','pike','rapier',
  'scimitar','shortsword','longsword','handaxe','battleaxe','flail','glaive',
  'greataxe','greatsword','halberd','javelin','longbow','shortbow','sickle',
  'trident','warhammer','whip','blowgun','dart','net'];

const EQ_EXTRA_COLORS = ['#5a4030','#306050','#4a3058','#305840','#583040','#3a4858'];
function stripHtml(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim(); }

// Map a D&D Beyond character's inventory into the sheet's equipment model:
//   { weapons, armor, utility, extraTabs, customCoins }
// Classification: filterType "Weapon" -> weapons, "Armor" -> armor (shield = armorTypeId 4),
// everything else -> utility. Containers (backpack, etc.) become location tabs and items
// carried inside them get that location.
function mapDdbInventory(d) {
  const eq = { weapons: [], armor: [], utility: [], extraTabs: [], customCoins: [] };
  const inv = Array.isArray(d.inventory) ? d.inventory : [];
  let seq = 0;
  const mkId = () => `eqddb_${Date.now().toString(36)}_${++seq}`;

  // 1) Containers -> location tabs; map each container's inventory id to its location key.
  const containerLoc = {};
  inv.forEach(row => {
    const def = row.definition || {};
    if (def.isContainer) {
      const name   = def.name || 'Container';
      const locKey = `container:${name}`;
      if (!eq.extraTabs.find(t => t.type === 'container' && t.name === name)) {
        eq.extraTabs.push({ name, type: 'container', color: EQ_EXTRA_COLORS[eq.extraTabs.length % EQ_EXTRA_COLORS.length] });
      }
      containerLoc[row.id] = locKey;
    }
  });

  // 2) Every item -> its category, carrying its container location.
  inv.forEach(row => {
    const def  = row.definition || {};
    const base = {
      id: mkId(),
      name: def.name || 'Item',
      amount: row.quantity || 1,
      weight: def.weight || 0,
      worn: !!row.equipped,
      location: containerLoc[row.containerEntityId] || '',
    };
    const filter = def.filterType || def.type || '';
    if (filter === 'Weapon') {
      const dmg = def.damage || {};
      eq.weapons.push({ ...base,
        damage:     dmg.diceString || (dmg.diceCount && dmg.diceValue ? `${dmg.diceCount}d${dmg.diceValue}` : (dmg.fixedValue != null ? String(dmg.fixedValue) : '')),
        damageType: (def.damageType || '').toLowerCase(),
        // simple/martial best-effort (categoryId 1=simple, 2=martial); left blank if unknown.
        type:       ({ 1: 'simple', 2: 'martial' }[def.categoryId]) || (/(^|\s)simple/i.test(def.type || '') ? 'simple' : (/(^|\s)martial/i.test(def.type || '') ? 'martial' : (def.magic ? 'magical' : ''))),
        properties: (def.properties || []).map(p => p && p.name).filter(Boolean).join(', '),
      });
    } else if (filter === 'Armor') {
      eq.armor.push({ ...base,
        ac:       def.armorClass != null ? def.armorClass : '',
        type:     ({ 1: 'light', 2: 'medium', 3: 'heavy', 4: 'shield' }[def.armorTypeId]) || '',
        strength: def.strengthRequirement || '',
        notes:    '',
      });
    } else {
      eq.utility.push({ ...base, notes: stripHtml(def.description).slice(0, 200) });
    }
  });
  return eq;
}

function mapDdbCharacter(d) {
  //  All modifiers (race, class, background, item, feat, condition) — D&D Beyond's
  //  source of truth for computed values (racial ASIs, feats, expertise, HP bonuses…).
  const allMods = [];
  ['race','class','background','item','feat','condition'].forEach(k => {
    if (Array.isArray((d.modifiers||{})[k])) allMods.push(...d.modifiers[k]);
  });

  //  Ability scores — the FINAL values exactly as D&D Beyond shows them: base score +
  //  racial / ASI / feat bonuses (from modifiers) + misc bonus, or a full custom override.
  //  This transfers the character AS-IS (including custom tweaks) rather than re-deriving
  //  the scores from race + background.
  const ABIL_SUB = { 1:'strength-score', 2:'dexterity-score', 3:'constitution-score', 4:'intelligence-score', 5:'wisdom-score', 6:'charisma-score' };
  const _base = {}, _bonus = {}, _override = {}, _modBonus = {};
  (d.stats || []).forEach(s => { _base[s.id] = s.value; });
  (d.bonusStats || []).forEach(s => { if (s.value != null) _bonus[s.id] = s.value; });
  (d.overrideStats || []).forEach(s => { if (s.value != null) _override[s.id] = s.value; });
  allMods.forEach(m => {
    if (m && m.type === 'bonus' && typeof m.value === 'number') {
      const id = Object.keys(ABIL_SUB).find(k => ABIL_SUB[k] === m.subType);
      if (id) _modBonus[id] = (_modBonus[id] || 0) + m.value;
    }
  });
  const scoreOf = id => (_override[id] != null) ? _override[id]
    : ((_base[id] != null ? _base[id] : 10) + (_bonus[id] || 0) + (_modBonus[id] || 0));
  const str = scoreOf(1), dex = scoreOf(2), con = scoreOf(3), int = scoreOf(4), wis = scoreOf(5), cha = scoreOf(6);

  //  Class / level 
  const classes    = (d.classes||[]).map(c => `${c.definition?.name||''} ${c.level}`).join(' / ');
  const totalLevel = Math.max(1, (d.classes||[]).reduce((s,c) => s + (c.level||0), 0));
  const profBonus  = Math.ceil(totalLevel / 4) + 1;

  //  Spellcasting 
  let spellClass = '', spellAbility = '';
  for (const c of (d.classes||[])) {
    const key = (c.definition?.name||'').toLowerCase();
    if (DDB_SPELL_ABILITY[key]) { spellClass = c.definition.name; spellAbility = DDB_SPELL_ABILITY[key]; break; }
  }

  //  Skill & save proficiencies from ALL sources (race, class-chosen skills, background,
  //  feats). Expertise is marked so the sheet doubles the bonus.
  const skillProfs = {}, saveProfs = {};
  allMods.forEach(m => {
    if (!m || !m.type) return;
    const sk = DDB_SKILL_MAP[m.subType];
    const sv = DDB_SAVE_MAP[m.subType];
    if (sk) {
      if (m.type === 'proficiency' || m.type === 'half-proficiency' || m.type === 'expertise') skillProfs[`skillProf_${sk}`] = true;
      if (m.type === 'expertise') skillProfs[`skillExp_${sk}`] = true;
    }
    if (sv && m.type === 'proficiency') saveProfs[`saveProf_${sv}`] = true;
  });

  //  Proficiencies & Languages 
  const langs = new Set(), tools = new Set(), weapons = new Set(), armors = new Set();
  allMods.forEach(m => {
    if (!m.type) return;
    const sub   = (m.subType||'').toLowerCase();
    const label = m.friendlySubtypeName || m.subType || '';
    if (m.type === 'language') { langs.add(label); return; }
    if (m.type !== 'proficiency') return;
    if (DDB_SKILL_MAP[sub] || DDB_SAVE_MAP[sub]) return;
    if (!label) return;
    if (sub.includes('armor') || sub.includes('shield')) armors.add(label);
    else if (DDB_WEAPON_KEYS.some(k => sub.includes(k))) weapons.add(label);
    else tools.add(label);
  });
  const profParts = [];
  if (langs.size)   profParts.push(`Languages: ${[...langs].join(', ')}`);
  if (armors.size)  profParts.push(`Armor: ${[...armors].join(', ')}`);
  if (weapons.size) profParts.push(`Weapons: ${[...weapons].join(', ')}`);
  if (tools.size)   profParts.push(`Tools: ${[...tools].join(', ')}`);

  //  HP  final max HP exactly as D&D Beyond computes it: base (hit dice) + CON per
  //  level + flat bonuses, or a full override. Current HP respects damage already taken.
  const conMod = Math.floor((con - 10) / 2);
  let maxHp;
  if (d.overrideHitPoints != null) maxHp = d.overrideHitPoints;
  else {
    maxHp = (d.baseHitPoints || 0) + conMod * totalLevel + (d.bonusHitPoints || 0);
    allMods.forEach(m => { if (m && m.type === 'bonus' && m.subType === 'hit-points-per-level' && typeof m.value === 'number') maxHp += m.value * totalLevel; });
  }
  if (maxHp < 1) maxHp = 1;
  const currHp = Math.max(0, maxHp - (d.removedHitPoints || 0));
  const speed  = d.race?.weightSpeeds?.normal?.walk || 30;

  //  Passive Perception (doubles the proficiency bonus if perception has expertise)
  const wisM = Math.floor((wis - 10) / 2);
  const passivePerception = 10 + wisM + (skillProfs['skillProf_perception'] ? profBonus * (skillProfs['skillExp_perception'] ? 2 : 1) : 0);

  //  Appearance / backstory 
  const traits    = d.traits || {};
  const heightRaw = d.height;
  const heightStr = typeof heightRaw === 'number'
    ? `${Math.floor(heightRaw/12)}'${heightRaw%12}"`
    : (heightRaw || '');
  const weightStr = d.weight ? `${d.weight} lbs` : '';

  const charData = {
    // Freestyle so the sheet keeps D&D Beyond's values AS-IS instead of re-deriving
    // hpMax / profBonus / etc. from the race+background "math" (which would discard
    // custom tweaks). The DM can toggle back to Auto on the sheet if they want.
    freestyle: true,
    str: String(str), dex: String(dex), con: String(con),
    int: String(int), wis: String(wis), cha: String(cha),
    classLevel: classes, race: d.race?.fullName || d.race?.baseName || '',
    background: d.background?.hasCustomBackground
      ? (d.background.customBackground?.name || 'Custom')
      : (d.background?.definition?.name || ''),
    alignment: DDB_ALIGNMENTS[d.alignmentId] || '',
    xp: String(d.currentXp || 0),
    hpMax: String(maxHp), hpCurrent: String(currHp),
    speed: String(speed), profBonus: String(profBonus),
    pp: String(passivePerception),
    profLang: profParts.join('\n'),
    backstory:          traits.backstory         || '',
    personalityTraits:  traits.personalityTraits || '',
    ideals:             traits.ideals            || '',
    bonds:              traits.bonds             || '',
    flaws:              traits.flaws             || '',
    age: String(d.age || ''), height: heightStr, weight: weightStr,
    hair: d.hair || '', eyes: d.eyes || '', skin: d.skin || '',
    // Currency (coins) from D&D Beyond.
    cp: String(d.currencies?.cp || 0), sp: String(d.currencies?.sp || 0),
    ep: String(d.currencies?.ep || 0), gp: String(d.currencies?.gp || 0),
    pp: String(d.currencies?.pp || 0),
    ...(spellClass ? { spellClass, spellAbility } : {}),
    ...skillProfs,
    ...saveProfs,
  };

  const avatar = d.decorations?.avatarUrl || d.avatarUrl || null;
  return { name: d.name || 'Imported Character', charData, avatarUrl: avatar, equipment: mapDdbInventory(d) };
}

// DM or an identified player (a player can only apply the result to their own character,
// which the sheet-save endpoints enforce separately).
app.get('/api/import-ddb/:characterId', dmOrPlayer, async (req, res) => {
  const { characterId } = req.params;
  if (!/^\d+$/.test(characterId))
    return res.status(400).json({ error: 'Invalid character ID  must be the number from the D&D Beyond URL.' });
  try {
    const r = await fetch(
      `https://character-service.dndbeyond.com/character/v5/character/${characterId}`,
      { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } }
    );
    if (r.status === 404) return res.status(404).json({ error: 'Character not found. Check the ID and make sure the character is set to Public on D&D Beyond.' });
    if (r.status === 401 || r.status === 403) return res.status(403).json({ error: 'This character is Private on D&D Beyond. Change the sharing setting to Public and try again.' });
    if (!r.ok) return res.status(502).json({ error: `D&D Beyond returned HTTP ${r.status}.` });
    const json = await r.json();
    if (!json.success || !json.data) return res.status(502).json({ error: 'Unexpected response from D&D Beyond.' });
    res.json(mapDdbCharacter(json.data));
  } catch (e) {
    res.status(502).json({ error: 'Could not reach D&D Beyond. Check your internet connection.' });
  }
});

//  BACKGROUNDS 
app.get('/api/backgrounds', (req, res) => {
  const rows = db.exec('SELECT name,skills,skill_choice,tools,tool_choice,language_count,feature,feature_desc FROM backgrounds ORDER BY name');
  res.json(flattenRows(rows, ['skills', 'tools'], false));   // skills/tools parsed but kept as their own keys
});

// Race catalog for the NPC tool's Race search field. Flattens the JSON blob so the
// client gets { name, source, ability, size, speed, darkvision, skills, languages, ... }.
app.get('/api/races', (req, res) => {
  res.json(flattenRows(db.exec('SELECT name, source, data FROM races ORDER BY name'), ['data']));
});

// Restore any MISSING built-in races (INSERT OR IGNORE). Deliberately does NOT delete or
// overwrite: custom rows, imported data, and edits to official rows are all left intact —
// a reset can only ADD back official entries that were removed, never destroy data.
app.post('/api/races/reset', dmOnly, (req, res) => {
  seedRaces(true);
  flush();
  res.json({ ok: true, count: RACES.length });
});

// Feat catalog for the NPC tool's "Add a feat" search. Flattens the JSON blob like races.
app.get('/api/feats', (req, res) => {
  res.json(flattenRows(db.exec('SELECT name, source, data FROM feats ORDER BY name'), ['data']));
});

app.post('/api/feats/reset', dmOnly, (req, res) => {
  seedFeats(true);   // restore missing built-ins only; never deletes/overwrites (see races/reset)
  flush();
  res.json({ ok: true, count: FEATS.length });
});

// Spell catalog for the sheet's spell search. Optional filters: ?level=3&class=Wizard&q=fire
app.get('/api/spells', (req, res) => {
  let spells = flattenRows(db.exec('SELECT name, level, school, source, data FROM spells ORDER BY level, name'), ['data']);
  const { level, class: cls, q } = req.query;
  if (level !== undefined && level !== '') spells = spells.filter(s => String(s.level) === String(level));
  if (cls) spells = spells.filter(s => (s.classes || []).some(c => c.toLowerCase() === String(cls).toLowerCase()));
  if (q) spells = spells.filter(s => s.name.toLowerCase().includes(String(q).toLowerCase()));
  res.json(spells);
});

app.post('/api/spells/reset', dmOnly, (req, res) => {
  // Restore missing built-in spells only. Critically does NOT delete — imported rules text,
  // damage/scaling data, and the expansion spells live only in the DB, so a delete+reseed
  // would wipe them (the seed holds bare SRD metadata). INSERT OR IGNORE is data-safe.
  seedSpells(true);
  flush();
  res.json({ ok: true, count: SPELL_ROWS.length });
});

// Class catalog (basic reference), flattened like races/feats.
app.get('/api/classes', (req, res) => {
  res.json(flattenRows(db.exec('SELECT name, source, data FROM classes ORDER BY name'), ['data']));
});

app.post('/api/classes/reset', dmOnly, (req, res) => {
  seedClasses(true);   // restore missing built-ins only; never deletes/overwrites (see races/reset)
  flush();
  res.json({ ok: true, count: CLASSES.length });
});

// Fields the catalog is known to use. This is NOT a filter — every field in the payload
// is stored (see below). It exists only so the response can report which incoming field
// names are new/unrecognized, making typos ("dammage") visible instead of silent.
const KNOWN_SPELL_FIELDS = new Set([
  'name','level','school','source','classes',
  'time','range','components','duration','desc',
  'damage','damageType','save','attack','heal','higher',
  'effect','area','confidence','trigger','resave',
  'ritual','concentration','tags',
  'scaleDice','scaleStep','scaleBase',   // structured upcast scaling for the slot dropdown
]);

// Fill in (or extend) the catalog from an external dataset — the intended way to add
// rules text and structured combat data, which the built-in seed deliberately omits.
// Existing spells are updated in place (fields merged onto what's already stored);
// unknown names are inserted.
//
// Every field in the payload is persisted, including ones not listed in
// KNOWN_SPELL_FIELDS — an earlier whitelist silently DROPPED unlisted fields, which
// lost data twice without any error. Unrecognized names are still surfaced in the
// response as `newFields` so a typo can't quietly become a phantom column.
app.post('/api/spells/import', dmOnly, (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : (req.body && req.body.spells);
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Expected an array of spells (or { spells: [...] }).' });
  let updated = 0, inserted = 0, skipped = 0;
  const newFields = new Set();
  const fieldCounts = {};
  incoming.forEach(sp => {
    const name = (sp && sp.name || '').trim();
    if (!name) { skipped++; return; }
    Object.keys(sp).forEach(k => {
      if (sp[k] == null || sp[k] === '') return;
      fieldCounts[k] = (fieldCounts[k] || 0) + 1;
      if (!KNOWN_SPELL_FIELDS.has(k)) newFields.add(k);
    });
    const row = dbGetOne('SELECT name, level, school, source, data FROM spells WHERE name = ?', [name]);
    if (row) {
      // Merge every provided field onto the stored blob (empty/null values are skipped
      // so a sparse payload never blanks out data that's already there).
      const merged = { ...safeJson(row.data, {}) };
      Object.keys(sp).forEach(k => {
        if (['name','level','school','source'].includes(k)) return;   // these are real columns
        if (sp[k] == null || sp[k] === '') return;
        if (Array.isArray(sp[k]) && !sp[k].length) return;
        merged[k] = sp[k];
      });
      db.run('UPDATE spells SET level = ?, school = ?, source = ?, data = ? WHERE name = ?', [
        sp.level != null ? Number(sp.level) : row.level,
        sp.school || row.school,
        sp.source || row.source,
        JSON.stringify(merged), name,
      ]);
      updated++;
    } else {
      const { name: _n, level, school, source, ...data } = sp;
      db.run('INSERT INTO spells (name, level, school, source, data) VALUES (?,?,?,?,?)', [
        name, Number(level) || 0, school || '', source || '', JSON.stringify(data),
      ]);
      inserted++;
    }
  });
  flush();
  const total = dbGetOne('SELECT COUNT(*) AS n FROM spells', []);
  res.json({
    ok: true, updated, inserted, skipped, total: total ? total.n : 0,
    fieldCounts,                              // how many entries carried each field
    newFields: [...newFields],                // field names not in KNOWN_SPELL_FIELDS
    warning: newFields.size
      ? `Stored ${newFields.size} unrecognized field name(s): ${[...newFields].join(', ')}. They were saved — check for typos.`
      : undefined,
  });
});

//  NPC SHEET ROUTES
// A read-only party summary a player may see for OTHER party members: name, portrait,
// class & level, and the notes the DM has explicitly shared with players. Never exposes
// private ability scores, monster data, or DM-only notes.
function partySummarySheet(s) {
  const pn = s.playerNotes;
  const visibleNotes = Array.isArray(pn) ? pn : ((pn && pn.notes) || []);
  return {
    npcId: s.npcId, name: s.name, type: s.type, image: s.image, inParty: !!s.inParty,
    classLevel: (s.charData && s.charData.classLevel) || '',
    visibleNotes,
    readOnly: true,
  };
}

app.get('/api/npc-sheets', (req, res) => {
  const dm  = isDM(req);
  const all = listNpcSheets();
  if (dm) return res.json({ isDM: true, sheets: all });
  // A player sees the whole party: their own character (editable) plus every other
  // party member as a read-only summary. The list is lightweight; details come from
  // /api/npc-sheet/:id (full for their own, summary for the rest).
  const p    = currentPlayer(req);
  const myId = (p && p.character_id) ? slug(p.character_id) : '';
  const sheets = all
    .filter(s => s.inParty || slug(s.npcId) === myId)
    .map(s => ({ npcId: s.npcId, name: s.name, type: s.type, image: s.image, inParty: !!s.inParty, mine: slug(s.npcId) === myId }));
  res.json({ isDM: false, sheets, myCharacterId: myId });
});

app.get('/api/npc-sheet/:id', (req, res) => {
  const npcId = slug(req.params.id);
  const dm    = isDM(req);
  const sheet = loadNpcSheet(npcId);

  if (!dm) {
    // The player's own character → full, editable.
    if (canEditCharacter(req, npcId)) {
      return res.json({ isDM: false, canEdit: true, sheet: sheet || { npcId, name: '', type: 'character', image: null, charData: {}, monsterData: {}, notes: [], playerNotes: [] } });
    }
    // Another party member → read-only summary (name, portrait, class & level, shared notes).
    if (sheet && sheet.inParty) {
      return res.json({ isDM: false, canEdit: false, sheet: partySummarySheet(sheet) });
    }
    // Not a party member (and not theirs) → denied.
    return res.status(403).json({ isDM: false, error: 'Not visible to players' });
  }

  if (!sheet) {
    return res.json({
      isDM: true,
      sheet: { npcId, name: '', type: 'character', image: null, charData: {}, monsterData: {}, notes: [], playerNotes: [] }
    });
  }
  res.json({ isDM: true, sheet });
});

app.post('/api/npc-sheet/:id', dmOrOwner, (req, res) => {
  const npcId    = slug(req.params.id);
  const current  = loadNpcSheet(npcId);
  const oldName  = current?.name || '';
  const newName  = (req.body.name || '').trim();
  const oldImage = current ? (current.image || null) : null;
  const newImage = req.body.image || null;
  const oldLoc   = slug(current?.location || '');
  // Preserve player_notes  it is managed by the /notes and send-portrait-to-players endpoints
  const playerNotes = current ? current.playerNotes : [];
  // Preserve party membership if the client didn't include it in this save.
  const inParty = req.body.inParty !== undefined ? req.body.inParty : (current ? current.inParty : false);
  saveNpcSheet(npcId, { ...req.body, npcId, playerNotes, inParty });
  broadcastNpc({ type: 'sheetUpdate', npcId, sheet: loadNpcSheet(npcId) });
  const newLoc = slug(req.body.location || '');
  const townsToUpdate = new Set([oldLoc, newLoc].filter(Boolean));
  // Migrate name-keyed state and content when the name changed in this save
  if (oldName && newName && oldName !== newName) {
    townsToUpdate.forEach(town => migrateNpcName(town, oldName, newName));
  }
  // Also fix any stale content name whose slug matches this npcId but name diverged
  // (happens when PATCH renamed without a location set, so content was never updated)
  townsToUpdate.forEach(town => {
    const content = loadTownContent(town);
    if (!content || !Array.isArray(content.households)) return;
    let stale = false;
    content.households.forEach(house => {
      if (!Array.isArray(house.npcs)) return;
      house.npcs.forEach(npc => {
        if (npc.name !== newName && slug(npc.name) === npcId) {
          npc.name = newName; stale = true;
        }
      });
    });
    if (stale) saveTownContent(town, content);
  });
  townsToUpdate.forEach(town => broadcast(town, { type: 'npcSheetUpdate' }));
  if (newImage !== oldImage) {
    if (oldImage) deleteFile(oldImage, IMAGES_DIR, 'npcimg_');
    broadcastPlayerNotesToAllTowns();
  }
  res.json({ ok: true });
});

// Name-only rename  uses UPDATE so it can never create a new record
app.patch('/api/npc-sheet/:id/rename', dmOrOwner, (req, res) => {
  const npcId  = slug(req.params.id);
  const name   = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const before = loadNpcSheet(npcId);
  db.run('UPDATE npc_sheets SET name = ? WHERE npc_id = ?', [name, npcId]);
  flush();
  const after = loadNpcSheet(npcId);
  // Migrate visibility, DM edits, and schema from old name to new name in the town
  // Fall back to client-supplied hint when the sheet has no location set yet
  const hint = slug(req.body.town || '');
  const loc = slug(after?.location || before?.location || '') || hint;
  if (loc && before?.name && before.name !== name) {
    migrateNpcName(loc, before.name, name);
  }
  if (after) broadcastNpc({ type: 'sheetUpdate', npcId, sheet: after });
  if (loc) broadcast(loc, { type: 'npcSheetUpdate' });
  res.json({ ok: true });
});

// Image upload  client sends the file as a base64 data URL inside JSON.
// This bypasses multipart parsing entirely: the bytes are read client-side by FileReader,
// sent as a plain text string, and written byte-for-byte to disk here.
// The source file is never touched and the data cannot be corrupted by stream parsing.
app.post('/api/npc-sheet/:id/image', dmOrOwner, async (req, res) => {
  const { dataUrl, filename } = req.body || {};
  const parsed = parseDataUrl(dataUrl, MIME_TO_EXT, 'image');
  if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
  const { b64: b64data, ext } = parsed;

  const npcId = slug(req.params.id);
  // Derive the saved filename from the original uploaded file name, not the NPC name.
  // A timestamp suffix ensures uniqueness so two NPCs using files with identical names
  // never collide, and replacing a portrait always creates a fresh file (old one deleted below).
  const origStem = filename
    ? path.basename(filename, path.extname(filename))
        .toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'portrait'
    : 'portrait';
  const fname     = 'npcimg_' + origStem + '_' + Date.now() + ext;
  const imagePath = `/npcs/images/${fname}`;
  const filePath  = path.join(IMAGES_DIR, fname);
  const tmpPath   = path.join(IMAGES_DIR, '.upload_' + fname + '.' + process.pid + '.part');

  const err = await atomicWriteFile(b64data, tmpPath, filePath);
  if (err === 'empty') return res.status(400).json({ error: 'Empty image' });
  if (err) return res.status(500).json({ error: 'Failed to write image file' });

  const sheet = loadNpcSheet(npcId) || {
    npcId, name: npcId, type: 'character', image: null,
    charData: {}, monsterData: {}, notes: [], playerNotes: []
  };
  const oldImage = sheet.image;
  sheet.image = imagePath;
  // Save first so DB is consistent; delete old file only after save succeeds.
  saveNpcSheet(npcId, sheet);
  if (oldImage && path.basename(oldImage.split('?')[0]) !== fname) deleteFile(oldImage, IMAGES_DIR, 'npcimg_');
  broadcastNpc({ type: 'imageUpdate', npcId, image: imagePath });
  broadcastPlayerNotesToAllTowns();
  res.json({ ok: true, image: imagePath });
});

// Location map image upload  saves image to locations/ and seeds town_content row
app.post('/api/location-map/image', dmOnly, async (req, res) => {
  const { dataUrl, filename, slug: rawSlug, name } = req.body || {};
  const parsed = parseDataUrl(dataUrl, MIME_TO_EXT, 'image');
  if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
  const { b64: b64data, ext: extFromMime } = parsed;
  const townSlug = slug(rawSlug || '');
  if (!townSlug) return res.status(400).json({ error: 'Missing slug' });
  const fname    = 'temp_' + townSlug + '_map_' + Date.now() + extFromMime;
  const filePath = path.join(LOCATIONS_IMG_DIR, fname);
  const imgPath  = 'locations/' + fname;
  const tmpMapPath = filePath + '.' + process.pid + '.part';
  const err = await atomicWriteFile(b64data, tmpMapPath, filePath);
  if (err === 'empty') return res.status(400).json({ error: 'Empty image' });
  if (err) return res.status(500).json({ error: 'Failed to write image file' });
  const existing = loadTownContent(townSlug);
  deleteImageFile(existing && existing.mapImage); // remove previous temp map if any
  saveTownContent(townSlug, {
    name:            (existing && existing.name) || name || townSlug,
    mapImage:        imgPath,
    totalHomes:      existing ? existing.totalHomes      : 0,
    totalResidents:  existing ? existing.totalResidents  : 0,
    households:      existing ? existing.households      : [],
    townLocations:   existing ? existing.townLocations   : [],
    houseMapDefault: existing ? existing.houseMapDefault : {},
    extraMaps:       existing ? existing.extraMaps       : []
  });
  res.json({ ok: true, mapImage: imgPath, slug: townSlug });
});

// Extra (secondary) map image upload for a town.
// Uses a content hash for the filename so uploading the same image twice reuses
// the existing file instead of creating a duplicate.
app.post('/api/town/:town/extra-map', dmOnly, async (req, res) => {
  const town = slug(req.params.town);
  if (!town) return res.status(400).json({ error: 'Invalid town' });
  const { dataUrl } = req.body || {};
  const parsed = parseDataUrl(dataUrl, MIME_TO_EXT, 'image');
  if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
  const { b64: b64data, ext } = parsed;
  const hash     = crypto.createHash('sha256').update(b64data).digest('hex').slice(0, 16);
  const fname    = `map_${town}_${hash}${ext}`;
  const filePath = path.join(LOCATIONS_IMG_DIR, fname);
  const imgPath  = 'locations/' + fname;
  if (!fs.existsSync(filePath)) {
    const tmpPath = filePath + '.' + process.pid + '.part';
    const err = await atomicWriteFile(b64data, tmpPath, filePath);
    if (err === 'empty') return res.status(400).json({ error: 'Empty image' });
    if (err) return res.status(500).json({ error: 'Failed to write image file' });
  }
  res.json({ ok: true, url: imgPath });
});

// "Sync players": push a hard refresh to every open PLAYER tool (atlas + NPC tool),
// skipping the DM's own tabs. Each tool reloads on `dr-reload`, which restarts its SSE +
// polling from a clean state — recovering from any drift: dropped connections, buffered
// tunnels, stale tabs. The DM (who clicks this) isn't reloaded out from under themselves.
app.post('/api/sync-players', dmOnly, (req, res) => {
  broadcastPlayers({ type: 'dr-reload' });
  res.json({ ok: true });
});

app.post('/api/npc-sheet/:id/send-portrait-to-players', dmOnly, (req, res) => {
  const npcId = slug(req.params.id);
  const existing = loadNpcSheet(npcId);
  if (!existing) return res.status(404).json({ error: 'NPC not found' });
  const existingNotes = Array.isArray(existing.playerNotes) ? existing.playerNotes : (existing.playerNotes?.notes || []);
  const newPlayerNotes = { notes: existingNotes, image: req.body.image ?? null };
  db.run('UPDATE npc_sheets SET player_notes = ? WHERE npc_id = ?', [JSON.stringify(newPlayerNotes), npcId]);
  flush();
  broadcastPlayerNotesToAllTowns();
  res.json({ ok: true });
});

// Upload an image/PDF attachment for a single note. Stored atomically under a
// stable per-note name so replacing an attachment overwrites in place.
app.post('/api/npc-sheet/:id/note-attachment', dmOrOwner, async (req, res) => {
  const { noteId, dataUrl, filename } = req.body || {};
  if (noteId === undefined || noteId === null || noteId === '') return res.status(400).json({ error: 'Missing noteId' });
  const parsed = parseDataUrl(dataUrl, ATTACH_MIME_TO_EXT, 'attachment');
  if (!parsed.ok) return res.status(parsed.status).json({ error: parsed.error });
  const { b64, mime, ext } = parsed;

  const npcId   = slug(req.params.id);
  const noteKey = String(noteId).replace(/[^a-z0-9_-]/gi, '');
  if (!noteKey) return res.status(400).json({ error: 'Invalid note ID' });
  const fname   = `att_${npcId}_${noteKey}${ext}`;
  const finalPath = path.join(ATTACH_DIR, fname);
  const tmpPath   = path.join(ATTACH_DIR, '.upload_' + fname + '.' + process.pid + '.' + Date.now() + '.part');

  const err = await atomicWriteFile(b64, tmpPath, finalPath);
  if (err === 'empty') return res.status(400).json({ error: 'Empty file' });
  if (err) return res.status(500).json({ error: 'Failed to write attachment' });
  // Drop any prior attachment for this note with a different extension.
  try {
    fs.readdirSync(ATTACH_DIR)
      .filter(f => f.startsWith(`att_${npcId}_${noteKey}.`) && f !== fname)
      .forEach(f => { try { fs.unlinkSync(path.join(ATTACH_DIR, f)); } catch(_) {} });
  } catch(_) {}

  const type = mime === 'application/pdf' ? 'pdf' : 'image';
  res.json({ ok: true, attachment: { url: `/npcs/attachments/${fname}`, type, name: filename || fname } });
});

app.post('/api/npc-sheet/:id/note-attachment-delete', dmOrOwner, (req, res) => {
  deleteFile(req.body && req.body.url, ATTACH_DIR, 'att_');
  res.json({ ok: true });
});

// Unified notes save  used by BOTH the NPC tool and the map tool. Persists the
// full notes array, derives the player-visible subset (shared notes, attachments
// included), cleans up orphaned attachment files, and broadcasts to both surfaces.
app.post('/api/npc-sheet/:id/notes', dmOrOwner, (req, res) => {
  const npcId = slug(req.params.id);
  const sheet = loadNpcSheet(npcId);
  if (!sheet) return res.status(404).json({ error: 'NPC not found' });

  // Optimistic concurrency: if the client tells us which version it edited from
  // (baseSig) and the notes have changed since (someone else saved first), reject
  // the stale write instead of clobbering their edit. The client re-syncs and
  // re-applies its own change on top. Omitting baseSig keeps older clients working.
  const baseSig = req.body.baseSig;
  if (baseSig != null && baseSig !== sheet.notesSig) {
    return res.status(409).json({ conflict: true, notes: sheet.notes, playerNotes: sheet.playerNotes, sig: sheet.notesSig });
  }

  const notes = (Array.isArray(req.body.notes) ? req.body.notes : []).filter(n => n != null);

  // Remove attachment files that are no longer referenced by any note.
  const oldNotes = (Array.isArray(sheet.notes) ? sheet.notes : []).filter(n => n != null);
  const keepUrls = new Set(notes.map(n => n.attachment && n.attachment.url).filter(Boolean));
  oldNotes.forEach(n => {
    const u = n.attachment && n.attachment.url;
    if (u && !keepUrls.has(u)) deleteFile(u, ATTACH_DIR, 'att_');
  });

  sheet.notes = notes;
  const shared        = notes.filter(n => n.shared);
  const existing      = sheet.playerNotes;
  const existingImage = Array.isArray(existing) ? null : (existing && existing.image) || null;
  sheet.playerNotes   = { notes: shared, image: existingImage };
  saveNpcSheet(npcId, sheet);

  broadcastNpc({ type: 'sheetUpdate', npcId, sheet: loadNpcSheet(npcId) });
  broadcastPlayerNotesToAllTowns();
  const loc = slug(sheet.location || '');
  if (loc) broadcast(loc, { type: 'npcSheetUpdate' });
  res.json({ ok: true, notes: sheet.notes, playerNotes: sheet.playerNotes, sig: notesSig(sheet.notes) });
});

app.delete('/api/npc-sheet/:id', dmOnly, (req, res) => {
  const npcId = slug(req.params.id);
  const sheet = loadNpcSheet(npcId);
  const loc   = slug(sheet?.location || '');
  deleteFile(sheet?.image, IMAGES_DIR, 'npcimg_');
  (Array.isArray(sheet?.notes) ? sheet.notes : []).forEach(n => deleteFile(n.attachment && n.attachment.url, ATTACH_DIR, 'att_'));
  db.run('DELETE FROM npc_sheets WHERE npc_id = ?', [npcId]);
  flush();
  broadcastNpc({ type: 'sheetDeleted', npcId });
  if (loc) broadcast(loc, { type: 'npcSheetUpdate' });
  broadcastPlayerNotesToAllTowns();
  res.json({ ok: true });
});

// Current player-visible notes and DM portrait index  used by map tool on load
app.get('/api/player-npc-notes', (req, res) => {
  res.json({ isDM: isDM(req), npcPlayerNotes: getAllPlayerNotes(), npcImages: getAllNpcImages() });
});

// SSE stream for NPC tool  DM only; contains full unredacted sheet data
// The DM sees every character's live changes; a player sees live changes only for the
// character assigned to them. Each connection is tagged with its identity so broadcastNpc
// can filter. (dmOrPlayer: unassigned players connect but simply receive nothing character-specific.)
app.get('/api/npc-events', dmOrPlayer, (req, res) => {
  initSse(res);
  const entry = { res, pid: isDM(req) ? '' : ((currentPlayer(req) || {}).pid || '') };
  npcSseClients.add(entry);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
  req.on('close', () => { clearInterval(hb); npcSseClients.delete(entry); });
});

//  EQUIPMENT 
// Grouped { weapons, armor, utility }  consumed by the NPC tool autocomplete
// (public read) and the database tool. Writes are DM only.
app.get('/api/equipment', (req, res) => {
  const rows = dbGetAll('SELECT category, data FROM equipment ORDER BY category, sort_order, id');
  const out = { weapons: [], armor: [], utility: [] };
  rows.forEach(r => {
    const item = safeJson(r.data, null);
    if (item && out[r.category]) out[r.category].push(item);
  });
  res.json(out);
});

// Replace the entire equipment set in one shot (matches the tool's edit-all-then-save model).
app.post('/api/equipment', dmOnly, (req, res) => {
  const body = req.body || {};
  const cats = ['weapons', 'armor', 'utility'];
  if (!cats.every(c => Array.isArray(body[c]))) {
    return res.status(400).json({ error: 'weapons/armor/utility arrays required' });
  }
  db.run('DELETE FROM equipment');
  const stmt = db.prepare('INSERT INTO equipment (category, sort_order, data) VALUES (?,?,?)');
  cats.forEach(cat => body[cat].forEach((item, i) => stmt.run([cat, i, JSON.stringify(item)])));
  stmt.free();
  flush();
  res.json({ ok: true });
});

// Reset equipment to the built-in defaults.
app.post('/api/equipment/reset', dmOnly, (req, res) => {
  db.run('DELETE FROM equipment');
  seedEquipment();
  flush();
  res.json({ ok: true });
});

//  GENERIC DATABASE ADMIN (DM only) 
// A raw table browser/editor over every user table in map_data.db. Table and
// column names are validated against the live schema (never interpolated from
// unchecked input), so only real identifiers reach a SQL string.
function dbUserTables() {
  return dbGetAll(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).map(r => r.name);
}
function dbTableColumns(table) {
  return dbGetAll(`PRAGMA table_info("${table}")`).map(c => ({
    name: c.name, type: c.type, pk: !!c.pk, notnull: !!c.notnull, dflt: c.dflt_value
  }));
}
function resolveTable(req, res) {
  const t = req.params.table;
  if (!dbUserTables().includes(t)) { res.status(404).json({ error: 'Unknown table' }); return null; }
  return t;
}
function normalizeCell(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object')  return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

app.get('/api/db/tables', dmOnly, (req, res) => {
  const tables = dbUserTables().map(name => {
    const cnt = dbGetOne(`SELECT COUNT(*) AS n FROM "${name}"`, []);
    return { name, columns: dbTableColumns(name), rowCount: cnt ? cnt.n : 0 };
  });
  res.json({ tables });
});

app.get('/api/db/table/:table', dmOnly, (req, res) => {
  const t = resolveTable(req, res); if (!t) return;
  const columns = dbTableColumns(t);
  res.json({
    table: t,
    columns,
    primaryKeys: columns.filter(c => c.pk).map(c => c.name),
    rows: dbGetAll(`SELECT * FROM "${t}"`)
  });
});

// Insert-or-replace a row (keyed by primary key). Omit an AUTOINCREMENT id to insert new.
app.post('/api/db/table/:table/upsert', dmOnly, (req, res) => {
  const t = resolveTable(req, res); if (!t) return;
  const colNames = dbTableColumns(t).map(c => c.name);
  const row = req.body && req.body.row;
  if (!row || typeof row !== 'object') return res.status(400).json({ error: 'row required' });
  const keys = Object.keys(row).filter(k => colNames.includes(k) && row[k] !== undefined);
  if (!keys.length) return res.status(400).json({ error: 'no valid columns supplied' });
  const sql = `INSERT OR REPLACE INTO "${t}" (${keys.map(k => `"${k}"`).join(',')}) `
            + `VALUES (${keys.map(() => '?').join(',')})`;
  try {
    db.run(sql, keys.map(k => normalizeCell(row[k])));
    flush();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

// Delete a row by its primary-key column values.
app.post('/api/db/table/:table/delete', dmOnly, (req, res) => {
  const t = resolveTable(req, res); if (!t) return;
  const cols = dbTableColumns(t);
  const pks  = cols.filter(c => c.pk).map(c => c.name);
  const key  = req.body && req.body.key;
  if (!key || typeof key !== 'object') return res.status(400).json({ error: 'key required' });
  const whereCols = (pks.length ? pks : cols.map(c => c.name)).filter(c => key[c] !== undefined);
  if (!whereCols.length) return res.status(400).json({ error: 'no key columns supplied' });
  const where = whereCols.map(c => `"${c}" = ?`).join(' AND ');
  try {
    db.run(`DELETE FROM "${t}" WHERE ${where}`, whereCols.map(c => normalizeCell(key[c])));
    flush();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

//  SHARED DICE ROLL LOG 
// A small in-memory ring buffer of recent rolls, streamed over SSE so the dice
// log panel shows the same history live in every open tool (NPC + map tools).
const rollLog = [];            // newest last
const ROLL_LOG_MAX = 200;
let _rollSeq = 0;

function broadcastRoll(entry) {
  // The roll log rides the main per-tab streams (no separate roll SSE connection).
  // A HIDDEN roll goes to DM streams only, so players never receive it over SSE.
  if (entry.hidden) broadcastDMs({ type: 'dr-roll', entry });
  else              broadcastEverywhere({ type: 'dr-roll', entry });
}

// History (oldest→newest is fine; the panel prepends). DM sees everything; players
// never receive hidden rolls (they're stripped from the history for non-DM requests).
app.get('/api/rolls', (req, res) => {
  const dm = isDM(req);
  res.json({ rolls: dm ? rollLog : rollLog.filter(e => !e.hidden) });
});

// Record a completed roll and fan it out. DM or a player may roll; a hidden roll
// (b.hidden) is visible to the DM only. Only the DM may hide a roll — a player can't
// secretly roll, so a player's hidden flag is ignored.
app.post('/api/roll', dmOrPlayer, (req, res) => {
  const b = req.body || {};
  const entry = {
    id:     Date.now() + '-' + (++_rollSeq),
    ts:     Date.now(),
    who:    String(b.who || 'Someone').slice(0, 80),
    action: String(b.action || 'Roll').slice(0, 120),
    mode:   (b.mode === 'adv' || b.mode === 'disadv') ? b.mode : 'normal',
    total:  b.total,
    detail: String(b.detail == null ? '' : b.detail).slice(0, 200),
    extra:  b.extra == null ? null : String(b.extra).slice(0, 200),
    hidden: !!b.hidden && isDM(req),
  };
  rollLog.push(entry);
  if (rollLog.length > ROLL_LOG_MAX) rollLog.shift();
  broadcastRoll(entry);
  res.json({ ok: true, entry });
});

// ─── ATTACK-USAGE TRACKING (per character) ───────────────────────────────────
// The attacks side panel featurises a character's MOST-USED attacks. We keep, per
// character (npcId), a rolling buffer of the last 100 attack-roll events — one event
// per tracked roll (weapon → its attack-bonus button; spell → its damage; other/trait →
// attack bonus if it has one, else damage). The panel tallies names within these 100 to
// rank them. Stored in kv_state under 'attack_usage' as { <npcId>: [{name,source,ts}, …] }.
const ATTACK_USAGE_MAX = 100;
function getAttackUsage() { return kvGet('attack_usage', {}) || {}; }

// Return the last-100 usage buffer for one character (empty array if none). Open to the
// DM and to the player who owns that character (they need it to rank their own panel).
app.get('/api/attack-usage/:npcId', dmOrPlayer, (req, res) => {
  const npcId = slug(req.params.npcId || '');
  if (!npcId) return res.json({ events: [] });
  if (!isDM(req) && !canEditCharacter(req, npcId)) return res.status(403).json({ error: 'forbidden' });
  const all = getAttackUsage();
  res.json({ events: Array.isArray(all[npcId]) ? all[npcId] : [] });
});

// Record one attack-roll usage event for a character. Only the DM or the character's own
// player may record it. Body: { npcId, name, source }. Keeps only the last 100 per character.
app.post('/api/attack-usage', dmOrPlayer, (req, res) => {
  const b = req.body || {};
  const npcId = slug(b.npcId || '');
  if (!npcId) return res.status(400).json({ error: 'npcId required' });
  if (!isDM(req) && !canEditCharacter(req, npcId)) return res.status(403).json({ error: 'forbidden' });
  const evt = {
    name:   String(b.name || '').slice(0, 120),
    source: (b.source === 'weapon' || b.source === 'spell' || b.source === 'trait') ? b.source : 'trait',
    ts:     Date.now()
  };
  if (!evt.name) return res.status(400).json({ error: 'name required' });
  const all = getAttackUsage();
  const buf = Array.isArray(all[npcId]) ? all[npcId] : [];
  buf.push(evt);
  while (buf.length > ATTACK_USAGE_MAX) buf.shift();
  all[npcId] = buf;
  kvSet('attack_usage', all);
  res.json({ ok: true, count: buf.length });
});

// ─── COMBAT / INITIATIVE TRACKER ─────────────────────────────────────────────
// Shared, live combat state (in-memory, like the roll log). One active encounter:
//   { combatants:[{ npcId, name, init, hp, hpMax, isPlayer, conditions:[], attacks:[] }],
//     activeIdx, round, active }
// The DM edits the whole state; a player may update only their own combatant's live
// data (attacks/conditions/hp) so the shared attacks panel stays current across tools.
// Persisted to kv_state so an active encounter survives a server restart (loaded from the
// DB once it's open — see openDb().then(...), because `db` isn't ready at module load).
let combatState = { combatants: [], activeIdx: 0, round: 1, active: false };

function broadcastCombat() { broadcastEverywhere({ type: 'combat', state: combatState }); }
// Combat is small and valuable mid-session, so persist it synchronously — that way even a
// hard kill (no graceful shutdown signal) can't lose the in-progress encounter.
function persistCombat() {
  try {
    db.run('INSERT OR REPLACE INTO kv_state (key, value) VALUES (?, ?)', ['combat', JSON.stringify(combatState)]);
    if (typeof flushSync === 'function') flushSync(); else flush();
  } catch (_) {}
}
function loadCombatFromDb() {
  const saved = kvGet('combat', null);
  if (saved && typeof saved === 'object' && Array.isArray(saved.combatants)) combatState = saved;
}

// Sanitise one combatant's attack list (derived on the client, mirrored here for sync).
function sanitizeAttacks(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 60).map(a => ({
    source:   ['weapon', 'trait', 'spell'].includes(a.source) ? a.source : 'weapon',
    name:     String(a.name || 'Attack').slice(0, 80),
    bonus:    String(a.bonus == null ? '' : a.bonus).slice(0, 12),
    damage:   String(a.damage == null ? '' : a.damage).slice(0, 40),
    dmgType:  String(a.dmgType == null ? '' : a.dmgType).slice(0, 24),
    heal:     String(a.heal == null ? '' : a.heal).slice(0, 40),
    save:     String(a.save == null ? '' : a.save).slice(0, 24),
    extras:   Array.isArray(a.extras) ? a.extras.slice(0, 10).map(e => ({ title: String(e.title || '').slice(0, 40), dice: String(e.dice || '').slice(0, 40) })) : [],
    disabled: !!a.disabled,
    disabledReason: String(a.disabledReason == null ? '' : a.disabledReason).slice(0, 60)
  }));
}
function sanitizeConditions(arr) {
  return Array.isArray(arr) ? arr.slice(0, 20).map(c => String(c || '').slice(0, 24)).filter(Boolean) : [];
}
function sanitizeCombatant(c) {
  return {
    npcId:    String(c.npcId || '').slice(0, 120),
    name:     String(c.name || 'Combatant').slice(0, 80),
    // null init = "hasn't rolled yet" (a player waiting to roll); keep it null, don't
    // collapse to 0 (which would place them at score 0 instead of unscored).
    init:     (c.init === null || c.init === undefined || c.init === '') ? null : (Number.isFinite(+c.init) ? +c.init : 0),
    hp:       (c.hp === null || c.hp === undefined || c.hp === '') ? null : (parseInt(c.hp, 10) || 0),
    hpMax:    (c.hpMax === null || c.hpMax === undefined || c.hpMax === '') ? null : (parseInt(c.hpMax, 10) || 0),
    isPlayer: !!c.isPlayer,
    conditions: sanitizeConditions(c.conditions),
    attacks:  sanitizeAttacks(c.attacks)
  };
}

app.get('/api/combat', (req, res) => { res.json({ state: combatState }); });

// Replace the whole combat state (DM only). The client owns ordering/turn logic and
// posts the resulting state; the server just stores + fans it out.
app.post('/api/combat', dmOnly, (req, res) => {
  const b = req.body && req.body.state ? req.body.state : req.body || {};
  const combatants = Array.isArray(b.combatants) ? b.combatants.slice(0, 60).map(sanitizeCombatant) : [];
  combatState = {
    combatants,
    activeIdx: Math.max(0, Math.min(combatants.length ? combatants.length - 1 : 0, parseInt(b.activeIdx, 10) || 0)),
    round:     Math.max(1, parseInt(b.round, 10) || 1),
    active:    !!b.active
  };
  persistCombat();
  broadcastCombat();
  res.json({ ok: true, state: combatState });
});

// Update just ONE combatant's live data (attacks/conditions/hp/hpMax/name) in place.
// Allowed for the DM or the player who owns that character — so a player's attacks panel
// (spells dropping out of slots, etc.) live-updates for everyone. No reordering here.
app.post('/api/combat/combatant/:id', dmOrOwner, (req, res) => {
  const npcId = slug(req.params.id);
  const i = combatState.combatants.findIndex(c => slug(c.npcId) === npcId);
  if (i < 0) return res.json({ ok: true, notInCombat: true });   // not an error — just not in the order
  const b = req.body || {};
  const c = combatState.combatants[i];
  if (b.attacks !== undefined)    c.attacks    = sanitizeAttacks(b.attacks);
  if (b.conditions !== undefined) c.conditions = sanitizeConditions(b.conditions);
  if (b.hp !== undefined)         c.hp    = (b.hp === null || b.hp === '') ? null : (parseInt(b.hp, 10) || 0);
  if (b.hpMax !== undefined)      c.hpMax = (b.hpMax === null || b.hpMax === '') ? null : (parseInt(b.hpMax, 10) || 0);
  if (b.name !== undefined)       c.name  = String(b.name || c.name).slice(0, 80);
  // A player rolling Initiative sets their own score → the order is re-sorted here (server
  // side) so everyone sees the same placement. The active combatant stays selected.
  if (b.init !== undefined) {
    c.init = (b.init === null || b.init === '') ? null : (parseInt(b.init, 10) || 0);
    reorderCombat();
  }
  persistCombat();
  broadcastCombat();
  res.json({ ok: true });
});

// Sort combatants by init desc (null/no-score to the bottom), keeping the active one
// selected by identity. Shared by the per-combatant init update.
function reorderCombat() {
  const active = combatState.combatants[combatState.activeIdx];
  const key = c => (c.init === null || c.init === undefined) ? -Infinity : c.init;
  combatState.combatants.sort((a, b) => key(b) - key(a));
  if (active) combatState.activeIdx = Math.max(0, combatState.combatants.indexOf(active));
}

// ─── MAP TOKENS ──────────────────────────────────────────────────────────────
// A GLOBAL pool of token definitions (persisted in kv_state), plus per-map instances
// (stored in each map's locPositions['__tokens__'] — town_state for the main map, the
// extra_maps JSON for extra maps). Define a token once from a sheet, drop instances on
// any map. Position/size live on the instance; art/name/owner come from the pool.
//   pool token: { id, npcId, name, image, ownerPid, defaultSizeHexes }
//   instance:   { poolId, q, r, sizeHexes }

function sanitizeToken(t) {
  // No ownerPid: control is derived live from the source sheet's player assignment
  // (canEditCharacter on npcId), so re-assigning a character updates who controls the token.
  return {
    id:       String(t.id || '').slice(0, 60),
    npcId:    String(t.npcId || '').slice(0, 120),
    name:     String(t.name || 'Token').slice(0, 80),
    image:    String(t.image || '').slice(0, 300),
    defaultSizeHexes: Math.max(1, Math.min(6, parseInt(t.defaultSizeHexes, 10) || 1))
  };
}
function getTokenPool() { const p = kvGet('token_pool', []); return Array.isArray(p) ? p : []; }

app.get('/api/tokens', (req, res) => { res.json({ pool: getTokenPool() }); });

// Replace the whole pool (DM only). The client owns add/edit/remove and posts the result.
app.post('/api/tokens', dmOnly, (req, res) => {
  const arr = Array.isArray(req.body && req.body.pool) ? req.body.pool : [];
  const pool = arr.slice(0, 300).map(sanitizeToken).filter(t => t.id);
  kvSet('token_pool', pool);
  broadcastEverywhere({ type: 'tokenPool', pool });
  res.json({ ok: true, pool });
});

// The source character sheet (npcId) a pool token was made from — permission keys off this.
function tokenSourceNpc(poolId) {
  const t = getTokenPool().find(x => x.id === poolId);
  return t ? slug(t.npcId || '') : '';
}

// Move / resize ONE token instance on a specific map. Allowed for the DM, or the player who
// controls the token's SOURCE CHARACTER SHEET — the same per-character mechanism that already
// lets a player edit their own sheet (players[].character_id via canEditCharacter). Body:
// { town, mapIndex, poolId, q, r, sizeHexes }. Broadcasts.
app.post('/api/tokens/move', dmOrPlayer, (req, res) => {
  const b = req.body || {};
  const town     = slug(b.town || '');
  const mapIndex = parseInt(b.mapIndex, 10) || 0;
  const poolId   = String(b.poolId || '');
  if (!town || !poolId) return res.status(400).json({ error: 'town + poolId required' });

  // Permission: DM always; else the requester must control the token's source character sheet.
  if (!canEditCharacter(req, tokenSourceNpc(poolId))) return res.status(403).json({ error: 'forbidden' });

  const q = Number.isFinite(+b.q) ? +b.q : 0;
  const r = Number.isFinite(+b.r) ? +b.r : 0;
  const sizeHexes = (b.sizeHexes === undefined) ? undefined : Math.max(1, Math.min(6, parseInt(b.sizeHexes, 10) || 1));

  // Load the target map's locPositions, update its __tokens__ list, save back.
  let locPos, saver;
  if (mapIndex === 0) {
    const state = loadTown(town);
    locPos = state.locPositions || (state.locPositions = {});
    saver = () => { state.locPositions = locPos; saveTown(town, state); };
  } else {
    const content = loadTownContent(town);
    if (!content || !Array.isArray(content.extraMaps) || !content.extraMaps[mapIndex - 1]) return res.status(404).json({ error: 'no such map' });
    const em = content.extraMaps[mapIndex - 1];
    em.locPositions = em.locPositions || {};
    locPos = em.locPositions;
    saver = () => saveTownContent(town, content);
  }
  const tokens = Array.isArray(locPos['__tokens__']) ? locPos['__tokens__'] : (locPos['__tokens__'] = []);
  let inst = tokens.find(t => t.poolId === poolId);
  if (!inst) { inst = { poolId, q, r, sizeHexes: sizeHexes || 1 }; tokens.push(inst); }
  else { inst.q = q; inst.r = r; if (sizeHexes !== undefined) inst.sizeHexes = sizeHexes; }
  saver();

  // Broadcast a lightweight move event to every tool watching this town.
  broadcastEverywhere({ type: 'tokenMove', town, mapIndex, poolId, q, r, sizeHexes: inst.sizeHexes });
  res.json({ ok: true });
});


// Assign a player to control this character. One player per character: the character
// is first cleared from any other player, then set on this one. DM only.
app.post('/api/npc-sheet/:id/assign', dmOnly, (req, res) => {
  const npcId = slug(req.params.id);
  const pid   = String((req.body && req.body.pid) || '');
  const p     = getPlayer(pid);
  if (!p) return res.status(404).json({ error: 'no such player' });
  listPlayers().forEach(o => {
    if (slug(o.character_id || '') === npcId && o.pid !== pid) db.run('UPDATE players SET character_id = ? WHERE pid = ?', ['', o.pid]);
  });
  db.run('UPDATE players SET character_id = ? WHERE pid = ?', [npcId, pid]);
  // A controlled character must be a party member so the player can see/open it.
  const sheet = loadNpcSheet(npcId);
  if (sheet && !sheet.inParty) saveNpcSheet(npcId, { ...sheet, inParty: true });
  flush();
  broadcastNpc({ type: 'assignmentUpdate', npcId });
  res.json({ ok: true });
});

// Remove any player's assignment to this character. DM only.
app.post('/api/npc-sheet/:id/unassign', dmOnly, (req, res) => {
  const npcId = slug(req.params.id);
  listPlayers().forEach(o => {
    if (slug(o.character_id || '') === npcId) db.run('UPDATE players SET character_id = ? WHERE pid = ?', ['', o.pid]);
  });
  flush();
  broadcastNpc({ type: 'assignmentUpdate', npcId });
  res.json({ ok: true });
});

//  PLAYERS (roster) + DISCORD LINK DELIVERY
function newId(prefix) { return prefix + '_' + crypto.randomBytes(6).toString('hex'); }
function publicPlayer(p) {
  return {
    pid: p.pid, name: p.name,
    discordChannel: p.discord_channel, discordTarget: p.discord_target,
    characterId: p.character_id,
    lastSeen: p.last_seen, created: p.created,
    online: (onlinePlayers.get(p.pid) || 0) > 0,
    link: buildPlayerLink(p.token),        // characters (NPC tool)
    mapLink: buildMapLink(p.token)         // maps (atlas)
  };
}

app.get('/api/players', dmOnly, (req, res) => {
  res.json({
    players: listPlayers().map(publicPlayer),
    hasTunnel: !!tunnelUrl,
    discordConfigured: !!BOT_SECRET,
    // Ready-made DM link for the CURRENT tunnel. The trycloudflare domain changes
    // on every tunnel restart, and cookies are per-domain  so the DM cookie dies
    // with the old domain. Opening this once on the new domain re-authenticates.
    dmLink: (tunnelUrl && DM_KEY_VALUE) ? `${tunnelUrl}/nocropi.html?dmkey=${encodeURIComponent(DM_KEY_VALUE)}` : null,
  });
});

app.post('/api/players', dmOnly, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim() || 'Player';
  const pid = newId('p'), token = crypto.randomBytes(16).toString('hex');
  db.run('INSERT INTO players (pid,name,token,discord_target,character_id,last_seen,created) VALUES (?,?,?,?,?,0,?)',
    [pid, name, token, '', '', Date.now()]);
  flush();
  res.json({ ok: true, player: publicPlayer(getPlayer(pid)) });
});

// DM queues each selected player's private link for the bot to deliver.
// NOTE: must be declared BEFORE the "/:pid" routes, or Express matches this path
// as :pid = "send-links" and returns "no such player".
app.post('/api/players/send-links', dmOnly, (req, res) => {
  if (!BOT_SECRET) return res.status(503).json({ error: 'Discord bot secret not configured (set DISCORD_BOT_SECRET in specificUser.js).' });
  // Refuse to queue anything without a public tunnel: otherwise the links fall back to
  // http://localhost:<port>, which is useless to a remote player (points at THEIR machine)
  // and — if opened locally — grants the DM view (localhost === DM). No tunnel ⇒ no links.
  if (!tunnelUrl) return res.status(409).json({ error: 'No public URL yet — start the Cloudflare tunnel before sending links (otherwise links would be localhost).' });
  const only = Array.isArray(req.body && req.body.pids) ? new Set(req.body.pids) : null;
  let queued = 0; const skipped = [];
  listPlayers().forEach(p => {
    if (only && !only.has(p.pid)) return;
    // Links are delivered to the player's channel; a channel ID is required.
    if (!p.discord_channel) { skipped.push(p.name || p.pid); return; }
    const mention = p.discord_target ? `<@${p.discord_target}> ` : '';
    // Characters link points at the player's OWN character (via &npc); if they have none
    // assigned, still send the map link and a note rather than a bare NPC-tool link.
    const charLine = p.character_id
      ? `\n\nyour character:\n${buildPlayerLink(p.token, p.character_id)}`
      : `\n\n(no character assigned to you yet — ask the DM)`;
    discordOutbox.push({
      id: Date.now() + '-' + (++_dcSeq),
      channel: p.discord_channel,     // where the bot posts the link
      target:  p.discord_target,      // the player's user id (for the mention / optional DM)
      content: `${mention}${p.name || 'Adventurer'} — your private campaign links (do not share them):${charLine}\n\nmap:\n${buildMapLink(p.token)}`,
      ts: Date.now()
    });
    queued++;
  });
  res.json({ ok: true, queued, skipped, hasTunnel: !!tunnelUrl });
});

app.post('/api/players/:pid', dmOnly, (req, res) => {
  const p = getPlayer(req.params.pid);
  if (!p) return res.status(404).json({ error: 'no such player' });
  const b = req.body || {};
  const map = { name: 'name', discordChannel: 'discord_channel', discordTarget: 'discord_target', characterId: 'character_id' };
  Object.keys(map).forEach(k => { if (b[k] !== undefined) db.run(`UPDATE players SET ${map[k]} = ? WHERE pid = ?`, [String(b[k]), p.pid]); });
  flush();
  res.json({ ok: true, player: publicPlayer(getPlayer(p.pid)) });
});

// Rotate a player's link token  invalidates their old link.
app.post('/api/players/:pid/regen', dmOnly, (req, res) => {
  const p = getPlayer(req.params.pid);
  if (!p) return res.status(404).json({ error: 'no such player' });
  db.run('UPDATE players SET token = ? WHERE pid = ?', [crypto.randomBytes(16).toString('hex'), p.pid]);
  flush();
  res.json({ ok: true, player: publicPlayer(getPlayer(p.pid)) });
});

app.delete('/api/players/:pid', dmOnly, (req, res) => {
  db.run('DELETE FROM players WHERE pid = ?', [req.params.pid]);
  flush();
  res.json({ ok: true });
});

// Discord outbox  our server only queues messages; the bot polls and delivers.
const discordOutbox = [];
let _dcSeq = 0;
function botSecretOk(req) {
  if (!BOT_SECRET) return false;
  const got = Buffer.from(String(req.headers['x-bot-secret'] || ''));
  const exp = Buffer.from(BOT_SECRET);
  return got.length === exp.length && crypto.timingSafeEqual(got, exp);
}

// Bot polls for pending messages, then acks the ones it delivered.
app.get('/api/discord/outbox', (req, res) => {
  if (!botSecretOk(req)) return res.status(403).json({ error: 'forbidden' });
  res.json({ messages: discordOutbox });
});
app.post('/api/discord/ack', (req, res) => {
  if (!botSecretOk(req)) return res.status(403).json({ error: 'forbidden' });
  const ids = new Set((req.body && req.body.ids) || []);
  for (let i = discordOutbox.length - 1; i >= 0; i--) if (ids.has(discordOutbox[i].id)) discordOutbox.splice(i, 1);
  res.json({ ok: true, remaining: discordOutbox.length });
});

// Edge cases: turn body-parser and uncaught route errors into clean JSON instead of
// Express's default HTML page (clients call .json() on every response). Must be last,
// after all routes. Handles oversized uploads (413), malformed JSON (400), else 500.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status === 413) return res.status(413).json({ error: 'Request too large (max 32 MB).' });
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: 'Malformed request body.' });
  }
  logLine('request error on ' + req.method + ' ' + req.path + ': ' + ((err && err.stack) || err));
  res.status(status).json({ error: 'Server error.' });
});

//  START (only when run directly; `require('./server')` loads helpers without listening)
module.exports = { mapDdbCharacter };
if (require.main === module)
openDb().then(() => {
  loadCombatFromDb();   // restore an in-progress encounter across restarts
  const httpServer = app.listen(PORT, () => {
    logLine(`server started  pid ${process.pid}, port ${PORT}`);
    console.log(`\n  1. DM map tool  -- http://localhost:${PORT}`);
    console.log(`  2. DM NPC tool  -- http://localhost:${PORT}/npcs/npc_tool.html`);
    console.log(`  3. Players link -- cloudflared tunnel --url http://localhost:${PORT}\n`);
    // Heartbeat: writes a liveness line to server.log every 30s with memory and open
    // client counts. If the process is ever killed silently (no crash handler fires),
    // the last heartbeat pins the moment of death and shows whether memory or client
    // connections were climbing right before it -- turning an invisible kill visible.
    setInterval(() => {
      try {
        const m = process.memoryUsage();
        let town = 0; sseClients.forEach(s => town += s.size);
        logLine(`alive uptime=${Math.round(process.uptime())}s rss=${Math.round(m.rss / 1048576)}MB heap=${Math.round(m.heapUsed / 1048576)}MB clients[maps=${town} npc=${npcSseClients.size}]`);
      } catch (_) {}
    }, 30000).unref();
  });
  // A server that can't bind its port is useless  exit cleanly (so the launcher
  // knows) instead of being kept alive as a non-serving zombie by the handlers above.
  httpServer.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      logLine(`FATAL: port ${PORT} is already in use  another server instance is running. Exiting.`);
    } else {
      logLine('FATAL: server listen error: ' + ((err && err.stack) || err));
    }
    process.exit(1);
  });
}).catch(err => {
  logLine('FATAL: failed to open database: ' + ((err && err.stack) || err));
  process.exit(1);
});
