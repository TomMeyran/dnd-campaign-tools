# How to add the README screenshots

The README references three images in this `docs/` folder. Until they exist,
the image links in the README show as broken — so add them before sharing the
repo. Takes about 3 minutes.

## Steps

1. Start the demo:

   ```bash
   npm install
   npm start
   ```

2. Capture each screen (Windows: **Win + Shift + S**) and save into this folder
   with these exact names:

   | File | What to capture | URL |
   | --- | --- | --- |
   | `docs/map.png` | The map / atlas with the hex grid and a town opened | <http://localhost:3000> |
   | `docs/npc-tool.png` | An NPC character sheet or a monster stat block | <http://localhost:3000/npcs/npc_tool.html> |
   | `docs/character.png` | The character-creation sheet with some fields filled | (open a character in the NPC tool) |

3. Commit them:

   ```bash
   git add docs/map.png docs/npc-tool.png docs/character.png
   git commit -m "docs: add README screenshots"
   git push
   ```

## Tips for good portfolio screenshots

- Use a wide browser window so the tools have room to breathe.
- Fill in some data first — an empty tool looks unfinished.
- Consider a short GIF of the live-sync in action (a change in one tab appearing
  in another). Tools like ScreenToGif make this easy; save it as `docs/demo.gif`
  and add `![demo](docs/demo.gif)` near the top of the README for maximum impact.

You can delete this file once the screenshots are in place.
