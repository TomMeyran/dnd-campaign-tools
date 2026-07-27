# D&D Campaign Tools

A self-hosted toolkit for running a tabletop (D&D 5e) campaign as the Dungeon
Master. It bundles an interactive **map / atlas**, a full **NPC & monster
manager**, a **character-creation sheet**, and a shared **dice roller** behind a
single Node server, with live updates pushed to connected browsers.

This repository is a **self-contained demo**: it ships with two pre-built towns
(Millhaven and Thorngate) and 20 example NPCs, so it runs out of the box with no
configuration and no real campaign data.

## Features

- **Map / atlas tool** — pan-and-zoom world and town maps with a hex grid,
  per-location detail views, and DM-controlled visibility (reveal houses, NPCs,
  and notes to players independently).
- **NPC & monster tool** — full 5e character sheets and stat blocks, portrait
  uploads, DM notes, and a per-note "send to players" toggle that surfaces the
  note in the players' map view.
- **Character creation** — guided ability scores, saves, skills, combat stats,
  spellcasting, and backstory, driven by bundled rules data (backgrounds,
  equipment, spell scaling).
- **Dice roller** — shared roller usable from any tool.
- **Live sync** — the tools talk to each other over Server-Sent Events, so a
  change in one view updates the others without a refresh.

## Tech stack

- **Node.js + Express** — single unified server (`server.js`).
- **sql.js** — SQLite database (`nocropi map tool/map_data.db`), no native build
  step required.
- **Vanilla JavaScript / HTML / CSS** — no front-end framework; each tool is a
  self-contained page.
- **Server-Sent Events** — cross-tool live updates.

## Running the demo

Requires **Node.js 18+**.

```bash
npm install        # first time only
node server.js     # or double-click start.bat on Windows
```

Then open:

- DM map / atlas — <http://localhost:3000>
- DM NPC tool — <http://localhost:3000/npcs/npc_tool.html>

To change the port, set the `PORT` environment variable before starting.
To reset the demo data at any time, run `node create_demo_db.js`.

See [HOW_TO_RUN.txt](HOW_TO_RUN.txt) for more detail.

## Optional: exposing the demo to remote players

Out of the box the server is **local only** — no tunnel is required and none is
bundled. If you want players to reach it over the internet, run any HTTP
tunnel that points at `http://localhost:3000`; the app is tunnel-agnostic and
serves player links from whatever public URL you give it. Options:

| Tool | Command | Account needed |
| --- | --- | --- |
| Cloudflare Tunnel | `cloudflared tunnel --url http://localhost:3000` | No (random `*.trycloudflare.com` URL) |
| ngrok | `ngrok http 3000` | Yes (free tier + authtoken) |
| localtunnel | `npx localtunnel --port 3000` | No |

The tunnel binary itself is **not** included in this repo — download it from its
own project. The server treats the DM as anyone connecting from `localhost` and
everyone arriving through the tunnel as a player. Optionally, tell the app its
public URL so player links use it instead of `localhost`:

```bash
curl -X POST http://localhost:3000/api/tunnel-url \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"https://<your-public-url>\"}"
```

## Notes

- The demo runs locally only; there is no player-facing remote tunnel in this
  build.
- No secrets are bundled. The cookie-signing secret is generated automatically
  on first run and kept in a local, git-ignored file. Optional Discord/DM
  features stay disabled unless you provide the relevant `CAMPAIGN_*` environment
  variables.
