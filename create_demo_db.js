'use strict';
// Run once to populate map_data.db with two example towns and 20 NPCs.
// Re-running this script will RESET the database — all edits will be lost.
const initSqlJs = require('sql.js');
const path = require('path');
const fs   = require('fs');

const DB_FILE = path.join(__dirname, 'nocropi map tool', 'map_data.db');

const millhavenHouseholds = [
  { id: 1, name: 'The Golden Flagon', residents: 0, npcs: [], desc: 'The town\'s main inn and tavern.' },
  { id: 2, name: 'Copperbell Wares',  residents: 0, npcs: [], desc: 'A well-stocked general goods shop.' },
  { id: 3, name: 'Guard Post',        residents: 0, npcs: [], desc: 'The town militia\'s headquarters.' },
  { id: 4, name: 'Ashveil Study',     residents: 0, npcs: [], desc: 'A wizard\'s tower on the edge of town.' },
  { id: 5, name: 'Hammers\' Forge',   residents: 0, npcs: [], desc: 'A busy smithy that supplies the whole region.' },
  { id: 6, name: 'Rosie\'s Bakery',   residents: 0, npcs: [], desc: 'Famous for its honey bread.' },
  { id: 7, name: 'The Temple',        residents: 0, npcs: [], desc: 'A temple to the gods of harvest and travel.' },
  { id: 8, name: 'Harbormaster\'s Office', residents: 0, npcs: [], desc: 'Oversees the river docks and trade permits.' },
];

const thorngateHouseholds = [
  { id: 1, name: 'Town Hall',          residents: 0, npcs: [], desc: 'The seat of local government.' },
  { id: 2, name: 'Nettlespin Potions', residents: 0, npcs: [], desc: 'An alchemist\'s shop packed with vials and curiosities.' },
  { id: 3, name: 'Stonevault Goods',   residents: 0, npcs: [], desc: 'A dwarf-run import and export merchant house.' },
  { id: 4, name: 'The Iron Flagon',    residents: 0, npcs: [], desc: 'A rough-and-ready tavern popular with the garrison.' },
  { id: 5, name: 'Guard Post',         residents: 0, npcs: [], desc: 'Fortified guard station at the main gate.' },
  { id: 6, name: 'Mast\'s Workshop',   residents: 0, npcs: [], desc: 'Carpentry and general repairs.' },
  { id: 7, name: 'The Chapel',         residents: 0, npcs: [], desc: 'A small chapel to the god of stone and endurance.' },
];

const millhavenNpcs = [
  {
    id: 'aldric_brightwood', name: 'Aldric Brightwood', location: 'Millhaven', premises: 'The Golden Flagon',
    charData: {
      appearance: 'A broad-shouldered man in his fifties with a ruddy complexion and a neatly trimmed silver beard. Almost always has a towel draped over one shoulder.',
      personality: 'Jovial and loud, with a memory for every regular\'s favourite drink. Slow to anger but immovable once crossed.',
      motivation: 'Wants to save enough to buy the building he currently rents and pass it to his daughter.',
      background: 'Spent twenty years as a river barge captain before settling down to run the flagon. Knows the waterways north and south better than most maps.'
    }
  },
  {
    id: 'vera_lark', name: 'Vera Lark', location: 'Millhaven', premises: 'The Golden Flagon',
    charData: {
      appearance: 'A half-elf woman in her late thirties with sharp green eyes and copper-streaked hair usually tied back with a piece of string.',
      personality: 'Dry wit, keen observer, and excellent at reading a room. Collects secrets the way others collect coins.',
      motivation: 'She is writing a collection of folk songs and is always looking for unusual stories to set to music.',
      background: 'Travelled the trade roads for a decade before agreeing to Aldric\'s standing offer of room, board, and a regular audience.'
    }
  },
  {
    id: 'mira_copperbell', name: 'Mira Copperbell', location: 'Millhaven', premises: 'Copperbell Wares',
    charData: {
      appearance: 'A halfling woman barely reaching four feet, with bright brown eyes and curly chestnut hair. Her apron pockets are always overflowing with receipts.',
      personality: 'Energetic, precise, and relentlessly cheerful. Has a gift for remembering prices and faces.',
      motivation: 'Expanding her supplier network into the northern hill towns.',
      background: 'Third generation merchant. Her grandmother founded Copperbell Wares. She considers it her sacred duty to outperform every ancestor.'
    }
  },
  {
    id: 'sergeant_dorn', name: 'Sergeant Dorn', location: 'Millhaven', premises: 'Guard Post',
    charData: {
      appearance: 'A stocky dwarf with iron-grey braids and a face that looks as though it has interrupted a lot of fists.',
      personality: 'Blunt and fair. Has no patience for politics or excuses, but considerable patience for a slow investigation.',
      motivation: 'Has quietly been building a case against a smuggling operation using the river docks.',
      background: 'Veteran of two border wars. Retired to civilian guard work because he was tired of following stupid orders from young officers.'
    }
  },
  {
    id: 'elena_ashveil', name: 'Elena Ashveil', location: 'Millhaven', premises: 'Ashveil Study',
    charData: {
      appearance: 'Tall high elf with silver-white hair and pale grey eyes that seem to be looking slightly past whoever she is speaking to.',
      personality: 'Distant and precise. Not unkind, but genuinely distracted by ongoing research.',
      motivation: 'Studying a phenomenon of spatial compression in the local ley lines. Does not yet know what it means.',
      background: 'Left the academy under disputed circumstances. The tower and its library were her compensation arrangement.'
    }
  },
  {
    id: 'finn_hammers', name: 'Finn Hammers', location: 'Millhaven', premises: "Hammers' Forge",
    charData: {
      appearance: 'A young human man, late twenties, with arms like tree trunks and persistent soot on his forehead.',
      personality: 'Earnest and proud of his craft. Prone to long explanations about metallurgy when customers would rather just know the price.',
      motivation: 'Wants to forge a masterwork blade good enough to be displayed at the regional craft fair.',
      background: 'Inherited the forge from his father. Has improved the business significantly by shifting focus from farming tools to fittings and custom hardware.'
    }
  },
  {
    id: 'rosie_plum', name: 'Rosie Plum', location: 'Millhaven', premises: "Rosie's Bakery",
    charData: {
      appearance: 'A round-faced woman in her forties, always dusted with flour, with laugh lines around warm brown eyes.',
      personality: 'Motherly and gossipy in the best sense — a social hub. Knows everything happening in the residential streets.',
      motivation: 'Wants to open a second stall at the weekly market.',
      background: 'Born in Millhaven, has never left for more than two weeks, and has no desire to. Her honey bread recipe is a closely guarded secret.'
    }
  },
  {
    id: 'sister_maren', name: 'Sister Maren', location: 'Millhaven', premises: 'The Temple',
    charData: {
      appearance: 'A tall human woman in her sixties with close-cropped white hair and an expression of permanent gentle attention.',
      personality: 'Calm and listening. Asks more questions than she answers. Rarely judges.',
      motivation: 'The temple roof needs repair. She is diplomatically raising funds without making anyone feel pressured.',
      background: 'Served as a travelling healer for thirty years before settling here. Has delivered roughly a third of the townspeople.'
    }
  },
  {
    id: 'thomas_reed', name: 'Thomas Reed', location: 'Millhaven', premises: '',
    charData: {
      appearance: 'A weathered man in his forties with calloused hands and a cautious, watchful look.',
      personality: 'Quiet and distrustful of strangers. Opens up considerably once trust is established.',
      motivation: 'Trying to secure water rights to an upstream channel before his neighbour does.',
      background: 'Works a small farm on the eastern edge of town. His family has farmed this land for four generations.'
    }
  },
  {
    id: 'old_silas', name: 'Old Silas', location: 'Millhaven', premises: '',
    charData: {
      appearance: 'A wiry old man who smells permanently of fish and river mud. Missing two fingers on his left hand.',
      personality: 'Rambling storyteller. Half of what he says is exaggerated, a quarter is invented, and the remaining quarter is surprisingly accurate.',
      motivation: 'Wants someone to help him write down his life story before he forgets any more of it.',
      background: 'Has fished the river for fifty years. Knows every sandbar, current, and seasonal pattern.'
    }
  },
];

const thorngateNpcs = [
  {
    id: 'mayor_harwick', name: 'Mayor Harwick', location: 'Thorngate', premises: 'Town Hall',
    charData: {
      appearance: 'A portly human man in his late fifties, always in a heavy wool coat regardless of weather. Has a nervous habit of adjusting his collar.',
      personality: 'Cautious administrator who avoids decisions until the last possible moment. Surprisingly decisive once forced.',
      motivation: 'Wants to negotiate a trade agreement with the hill clans without the regional lord finding out.',
      background: 'Former tax assessor who ran for mayor unopposed three elections in a row. Competent at paperwork, less so at people.'
    }
  },
  {
    id: 'agnes_nettlespin', name: 'Agnes Nettlespin', location: 'Thorngate', premises: 'Nettlespin Potions',
    charData: {
      appearance: 'A gnome in her eighties who looks forty. Wears magnifying spectacles on a chain and smells of sulphur and pine.',
      personality: 'Enthusiastic and slightly chaotic. Makes experimental batches alongside the reliable stock and does not always label them clearly.',
      motivation: 'Is on the verge of a breakthrough with a long-duration light potion and needs a rare reagent from the mountains.',
      background: 'Studied at two different academies without graduating from either. Has learned more from practice than either could have taught her.'
    }
  },
  {
    id: 'rorik_stonevault', name: 'Rorik Stonevault', location: 'Thorngate', premises: 'Stonevault Goods',
    charData: {
      appearance: 'A broad dwarf with a copper-streaked black beard and an assessing look that prices everything in a room within seconds of entering.',
      personality: 'Reserved and contractual. Every arrangement has terms. Reliable to the letter, rarely beyond.',
      motivation: 'Expanding into selling mining equipment. Has a business contact in the hill clans but needs someone to carry a message.',
      background: 'Left his clan to establish an independent merchant house. Has succeeded, but the clan still has claims on his early capital.'
    }
  },
  {
    id: 'sable', name: 'Sable', location: 'Thorngate', premises: 'The Iron Flagon',
    charData: {
      appearance: 'A half-orc in their forties, shaved head, forearms covered in faded tattoos. Moves with the easy confidence of someone who has broken up a lot of fights.',
      personality: 'Neutral and professional behind the bar. Off-shift is warmer and surprisingly philosophical.',
      motivation: 'Saving to buy a plot of land outside town. Wants to retire to farming.',
      background: 'Used to work as a caravan guard. Bought out the previous owner\'s debt for a share of the business. Has run it alone for six years.'
    }
  },
  {
    id: 'captain_lyra', name: 'Captain Lyra', location: 'Thorngate', premises: 'Guard Post',
    charData: {
      appearance: 'A lean human woman in her early forties, close-cropped dark hair, always in uniform even off-duty.',
      personality: 'Precise and demanding of her guards, scrupulously fair with civilians. Has a dry sense of humour she almost never shows.',
      motivation: 'Is certain there is a spy reporting garrison movements to someone in the hills. Has not yet identified who.',
      background: 'Decorated veteran reassigned here from a larger posting after reporting a superior officer for graft. Considers it an exile. Does her job anyway.'
    }
  },
  {
    id: 'gregor_mast', name: 'Gregor Mast', location: 'Thorngate', premises: "Mast's Workshop",
    charData: {
      appearance: 'A tall human man with sawdust in his grey hair and a permanent squint from working in dim light.',
      personality: 'Methodical and honest. Charges fair prices and will not be rushed.',
      motivation: 'Wants to build a proper dry-dock for river craft. Has the plans drawn up. Needs a backer.',
      background: 'Trained as a shipwright before moving inland. Applies the same principles to buildings. His work lasts longer than most.'
    }
  },
  {
    id: 'brother_aldric', name: 'Brother Aldric', location: 'Thorngate', premises: 'The Chapel',
    charData: {
      appearance: 'A human man in his thirties, slight build, with a shaved head and calm dark eyes.',
      personality: 'Deliberate and precise. Believes in earned trust. Dislikes rhetoric.',
      motivation: 'Translating an old text found under the chapel floor that appears to predate the town itself.',
      background: 'Came to Thorngate as a travelling monk and stayed when the previous keeper retired. Has been here eight years.'
    }
  },
  {
    id: 'petra_mend', name: 'Petra Mend', location: 'Thorngate', premises: 'The Chapel',
    charData: {
      appearance: 'A compact human woman in her late twenties with ink-stained fingers and a practical short haircut.',
      personality: 'Brisk and reassuring. Prioritises clear information over bedside manner.',
      motivation: 'Wants to establish a proper infirmary separate from the chapel. Needs town hall approval.',
      background: 'Trained as a physician\'s assistant in the capital before following family back to this region.'
    }
  },
  {
    id: 'nessa_oakheart', name: 'Nessa Oakheart', location: 'Thorngate', premises: '',
    charData: {
      appearance: 'A wood elf woman who looks like she dressed in the dark (she often did). Travelworn gear, no ornament, very still in the way of someone used to waiting.',
      personality: 'Selective with words. Observes more than she speaks. Deeply loyal once she considers someone worth the effort.',
      motivation: 'Tracking a series of livestock disappearances in the surrounding hills that the garrison has dismissed.',
      background: 'Has been working the region as an independent guide and occasional scout for three years. No fixed address.'
    }
  },
  {
    id: 'will_harrow', name: 'Will Harrow', location: 'Thorngate', premises: '',
    charData: {
      appearance: 'A young human man, early twenties, with a sunburned nose and the slightly overwhelmed look of someone managing more than he expected.',
      personality: 'Eager to help, quick to apologise, learning to stop apologising so much.',
      motivation: 'His family\'s barley crop failed this season. He is quietly looking for supplementary work.',
      background: 'Inherited a small farm uphill from the town when his parents relocated south. First season managing alone.'
    }
  },
];

async function seed() {
  if (!fs.existsSync(path.join(__dirname, 'node_modules', 'sql.js'))) {
    console.error('Run "npm install" first.');
    process.exit(1);
  }

  const SQL = await initSqlJs({
    locateFile: f => path.join(__dirname, 'node_modules', 'sql.js', 'dist', f)
  });
  const db = new SQL.Database();

  db.run(`CREATE TABLE IF NOT EXISTS town_state (
    town TEXT PRIMARY KEY,
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
    npc_id       TEXT PRIMARY KEY,
    name         TEXT NOT NULL DEFAULT '',
    type         TEXT NOT NULL DEFAULT 'character',
    image        TEXT DEFAULT NULL,
    char_data    TEXT NOT NULL DEFAULT '{}',
    monster_data TEXT NOT NULL DEFAULT '{}',
    notes        TEXT NOT NULL DEFAULT '[]',
    player_notes TEXT NOT NULL DEFAULT '[]',
    location     TEXT NOT NULL DEFAULT '',
    premises     TEXT NOT NULL DEFAULT ''
  )`);

  // Region
  db.run(
    `INSERT OR REPLACE INTO region_content (region, name, map_image, locations, location_map_default)
     VALUES (?, ?, ?, ?, ?)`,
    [
      'nocropi',
      'Example Region',
      '',
      JSON.stringify([
        { id: 1, name: 'Millhaven', type: 'Town', desc: 'A prosperous river market town known for its weekly trade fair.', page: 'map_tool.html?town=millhaven' },
        { id: 2, name: 'Thorngate', type: 'Town', desc: 'A fortified hillside town that guards the mountain passes to the north.', page: 'map_tool.html?town=thorngate' },
      ]),
      JSON.stringify({})
    ]
  );

  // Millhaven town content
  db.run(
    `INSERT OR REPLACE INTO town_content
     (town, name, map_image, total_homes, total_residents, households, town_locations, house_map_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'millhaven', 'Millhaven', '', 80, 320,
      JSON.stringify(millhavenHouseholds),
      JSON.stringify([]),
      JSON.stringify({})
    ]
  );

  // Thorngate town content
  db.run(
    `INSERT OR REPLACE INTO town_content
     (town, name, map_image, total_homes, total_residents, households, town_locations, house_map_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'thorngate', 'Thorngate', '', 45, 180,
      JSON.stringify(thorngateHouseholds),
      JSON.stringify([]),
      JSON.stringify({})
    ]
  );

  // NPCs
  const allNpcs = [...millhavenNpcs, ...thorngateNpcs];
  allNpcs.forEach(npc => {
    db.run(
      `INSERT OR REPLACE INTO npc_sheets
       (npc_id, name, type, image, char_data, monster_data, notes, player_notes, location, premises)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        npc.id,
        npc.name,
        'character',
        null,
        JSON.stringify(npc.charData),
        JSON.stringify({}),
        JSON.stringify([]),
        JSON.stringify([]),
        npc.location,
        npc.premises || ''
      ]
    );
  });

  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
  console.log(`Demo database written to ${DB_FILE}`);
  console.log(`  2 towns: Millhaven (${millhavenNpcs.length} NPCs), Thorngate (${thorngateNpcs.length} NPCs)`);
}

seed().catch(err => { console.error(err); process.exit(1); });
