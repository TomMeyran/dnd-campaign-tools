// ─── MACHINE-SPECIFIC CONFIGURATION (demo stub) ──────────────────────────────
// This is the self-contained demo build. It ships NO secrets.
//   - PORT can be overridden with the PORT env var (e.g. set PORT=4000).
//   - DISCORD_BOT_SECRET / DM_KEY are intentionally empty here: with no secret,
//     Discord player-link delivery is disabled and the DM role is only granted
//     from localhost — never via a guessable hardcoded key.
// To run your own instance, set the CAMPAIGN_* env vars before launching.

module.exports = {
  PORT: process.env.PORT || 3000,
  DISCORD_BOT_SECRET: process.env.CAMPAIGN_BOT_SECRET || '',
  DM_KEY: process.env.CAMPAIGN_DM_KEY || '',
};
