// ─── SHARED DICE ROLLER + CROSS-TOOL ROLL LOG ────────────────────────────────
// One self-contained module used by the NPC tool and the map tool. Provides:
//   • dice math (d20 checks with advantage/disadvantage, flat damage expressions)
//   • a reusable "roll trigger" you attach to any element, with a 0.5s-hover
//     advantage/disadvantage picker (green = adv, red = disadv)
//   • a right-docked, slide-in/out log panel shown in every tool
//   • sync: each roll is POSTed to the server, which broadcasts it over SSE so
//     the same log appears live in all open tools.
(function () {
  'use strict';
  if (window.DiceRoll) return;

  // ── dice math ──────────────────────────────────────────────────────────────
  function rollDie(sides) { return 1 + Math.floor(Math.random() * sides); }
  function rollN(n, sides) { var a = []; for (var i = 0; i < n; i++) a.push(rollDie(sides)); return a; }

  // A d20 check/attack/save with the chosen mode. Returns the kept d20, the
  // pair (for adv/disadv), the final total and a human breakdown string.
  //   critFrom: the lowest d20 face that counts as a critical hit (default 20). A weapon with an
  //   expanded crit range passes 19 (crit on 19-20) or 18 (crit on 18-20). `crit` is true when the
  //   kept die is >= critFrom (nat20 stays specifically === 20 for callers that want it).
  function d20Check(modifier, mode, critFrom) {
    var mod = parseInt(modifier, 10) || 0;
    var cf = parseInt(critFrom, 10); if (!(cf >= 2 && cf <= 20)) cf = 20;
    var rolls, kept;
    if (mode === 'adv' || mode === 'disadv') {
      rolls = rollN(2, 20);
      kept = mode === 'adv' ? Math.max(rolls[0], rolls[1]) : Math.min(rolls[0], rolls[1]);
    } else {
      rolls = rollN(1, 20);
      kept = rolls[0];
    }
    var total = kept + mod;
    var d20txt = rolls.length > 1 ? ('d20[' + rolls.join(',') + '→' + kept + ']') : ('d20[' + kept + ']');
    var detail = d20txt + (mod ? (mod > 0 ? ' +' + mod : ' ' + mod) : '');
    return { rolls: rolls, kept: kept, mod: mod, total: total, detail: detail,
             nat20: kept === 20, nat1: kept === 1, crit: kept >= cf, critFrom: cf };
  }

  // Parse & roll a damage-style expression like "2d6+3", "1d8", "1d4+1d6+2".
  // Returns { total, detail } or null when nothing rollable is found.
  //
  // crit === true applies the house critical-hit rule to every DICE term (flat modifiers are
  // untouched — they apply once, never doubled): the dice COUNT is doubled, the dice are rolled,
  // and the FIRST die of the (doubled) term is set to its maximum. e.g. on a crit
  //   2d6 + 3  →  [6(max), r, r, r] + 3   (4 dice, first maxed, +3 once)
  //   1d8 + 3  →  [8(max), r]      + 3
  function rollExpression(expr, crit) {
    if (expr == null) return null;
    var terms = String(expr).toLowerCase().match(/[+-]?\s*(\d*d\d+|\d+)/g);
    if (!terms) return null;
    var total = 0, pieces = [], found = false;
    terms.forEach(function (raw) {
      var t = raw.replace(/\s+/g, '');
      var sign = t[0] === '-' ? -1 : 1;
      t = t.replace(/^[+-]/, '');
      var dm = t.match(/^(\d*)d(\d+)$/);
      if (dm) {
        found = true;
        var n = parseInt(dm[1] || '1', 10);
        var sides = parseInt(dm[2], 10);
        if (n > 0 && n <= 100 && sides > 0) {
          var count = crit ? n * 2 : n;        // crit: double the number of dice
          if (count > 200) count = 200;
          var rs = rollN(count, sides);
          if (crit && rs.length) rs[0] = sides;  // crit: first die is maxed
          var sub = rs.reduce(function (a, b) { return a + b; }, 0) * sign;
          total += sub;
          pieces.push((sign < 0 ? '-' : '') + count + 'd' + sides + '[' + rs.join(',') + ']');
        }
      } else {
        var v = parseInt(t, 10);
        if (!isNaN(v)) { total += v * sign; pieces.push((sign < 0 ? '-' : '+') + v); found = true; }
      }
    });
    if (!found) return null;
    return { total: total, detail: pieces.join(' ').replace(/^\+/, '') };
  }

  function fmtMod(n) { return (n >= 0 ? '+' : '') + n; }

  // ── the actor whose sheet is currently driving rolls (set by the host tool) ──
  var currentActor = 'Someone';
  // Whether the current user is the DM. Only the DM may make a roll hidden (players
  // can't secretly roll). The host tool sets this via DiceRoll.setDM(true/false).
  var isDMUser = false;

  // ── send a completed roll to the shared log ────────────────────────────────
  function emit(entry) {
    entry.who = entry.who || currentActor;
    // Optimistic id-less render happens via the server echo; POST and let SSE
    // deliver the canonical, ordered entry to every tool (including this one).
    fetch('/api/roll', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    }).catch(function () {
      // Offline fallback: render locally so the DM still sees it.
      renderEntry(Object.assign({ id: 'local-' + Date.now(), ts: Date.now() }, entry), true);
    });
  }

  // ── advantage/disadvantage hover picker + click-to-roll ────────────────────
  var MODES = ['adv', 'normal', 'disadv'];
  var MODE_LABEL = { adv: 'Advantage', normal: 'Regular', disadv: 'Disadvantage' };

  function applyModeColor(el, mode) {
    el.classList.remove('dr-mode-adv', 'dr-mode-disadv');
    if (mode === 'adv') el.classList.add('dr-mode-adv');
    else if (mode === 'disadv') el.classList.add('dr-mode-disadv');
  }

  var openMenu = null;
  function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }

  function showModeMenu(el) {
    closeMenu();
    var cur = el._drMode || 'normal';
    var menu = document.createElement('div');
    menu.className = 'dr-mode-menu';
    // Always ordered adv > regular > disadv, excluding the current choice.
    MODES.filter(function (m) { return m !== cur; }).forEach(function (m) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dr-mode-opt dr-mode-opt-' + m;
      b.textContent = MODE_LABEL[m];
      b.addEventListener('click', function (ev) {
        ev.stopPropagation(); ev.preventDefault();
        el._drMode = m; applyModeColor(el, m); closeMenu();
      });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    var r = el.getBoundingClientRect();
    menu.style.left = Math.round(r.left) + 'px';
    menu.style.top = Math.round(r.bottom + 4) + 'px';
    // keep on-screen
    var mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth - 6) menu.style.left = Math.round(window.innerWidth - mr.width - 6) + 'px';
    openMenu = menu;
    var leave = function () { setTimeout(function () { if (openMenu === menu && !menu.matches(':hover') && !el.matches(':hover')) closeMenu(); }, 120); };
    menu.addEventListener('mouseleave', leave);
  }

  // Perform the roll for a trigger and emit it. `hidden` → DM-only entry.
  function doRoll(el, spec, hidden) {
    var mode = spec.d20 ? (el._drMode || 'normal') : 'normal';
    var r = spec.roll(mode);
    if (!r) return;
    emit({
      who: spec.who ? spec.who() : currentActor,
      action: r.action, mode: spec.d20 ? mode : null,
      total: r.total, detail: r.detail, extra: r.extra || null,
      hidden: !!hidden
    });
  }

  // A tiny right-click menu offering "Roll hidden" (DM only). Rolls immediately when picked.
  function showHiddenMenu(el, spec, x, y) {
    closeMenu();
    var menu = document.createElement('div');
    menu.className = 'dr-mode-menu';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'dr-mode-opt dr-mode-opt-hidden';
    b.textContent = '🕶 Roll hidden';
    b.title = 'Roll so only the DM sees the result';
    b.addEventListener('click', function (ev) {
      ev.stopPropagation(); ev.preventDefault();
      closeMenu();
      doRoll(el, spec, true);
    });
    menu.appendChild(b);
    document.body.appendChild(menu);
    menu.style.left = Math.round(x) + 'px';
    menu.style.top = Math.round(y) + 'px';
    var mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth - 6) menu.style.left = Math.round(window.innerWidth - mr.width - 6) + 'px';
    if (mr.bottom > window.innerHeight - 6) menu.style.top = Math.round(window.innerHeight - mr.height - 6) + 'px';
    openMenu = menu;
    var leave = function () { setTimeout(function () { if (openMenu === menu && !menu.matches(':hover')) closeMenu(); }, 2000); };
    menu.addEventListener('mouseleave', leave);
  }

  // Attach roll behaviour to an element.
  //   spec.d20   : true → show adv/disadv picker on hover
  //   spec.roll(mode) → return { action, total, detail, extra } (may do side effects)
  //   spec.who() : optional actor override
  function trigger(el, spec) {
    if (!el || el._drWired) return; el._drWired = true;
    el.classList.add('dr-trigger');
    el._drMode = 'normal';

    el.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      closeMenu();
      doRoll(el, spec, false);
    });

    // Right-click → "Roll hidden" (DM only). Available on EVERY roll trigger.
    el.addEventListener('contextmenu', function (ev) {
      if (!isDMUser) return;              // players can't hide rolls
      ev.preventDefault(); ev.stopPropagation();
      showHiddenMenu(el, spec, ev.clientX, ev.clientY);
    });

    if (spec.d20) {
      var hoverTimer = null;
      el.addEventListener('mouseenter', function () {
        hoverTimer = setTimeout(function () { showModeMenu(el); }, 500);
      });
      el.addEventListener('mouseleave', function () {
        clearTimeout(hoverTimer);
        setTimeout(function () { if (openMenu && !openMenu.matches(':hover')) closeMenu(); }, 150);
      });
    }
  }

  // ── the docked log panel ───────────────────────────────────────────────────
  var listEl = null, panelEl = null;

  function renderEntry(e, prepend) {
    if (!listEl) return;
    if (document.getElementById('dr-entry-' + e.id)) return; // dedupe echoes
    var item = document.createElement('div');
    item.className = 'dr-entry' + (e.mode === 'adv' ? ' dr-e-adv' : e.mode === 'disadv' ? ' dr-e-disadv' : '') + (e.hidden ? ' dr-e-hidden' : '');
    item.id = 'dr-entry-' + e.id;
    var extra = e.extra ? '<div class="dr-e-extra">' + escapeHtml(e.extra) + '</div>' : '';
    // A hidden roll (DM-only) is badged so the DM knows the players didn't see it.
    var hiddenBadge = e.hidden ? '<span class="dr-e-hidden-badge" title="Hidden — players did not see this roll">🕶 hidden</span>' : '';
    item.innerHTML =
      '<div class="dr-e-top"><span class="dr-e-who">' + escapeHtml(e.who || '—') + hiddenBadge + '</span>' +
      '<span class="dr-e-total">' + escapeHtml(String(e.total)) + '</span></div>' +
      '<div class="dr-e-action">' + escapeHtml(e.action || '') +
      (e.mode && e.mode !== 'normal' ? ' <span class="dr-e-mode">(' + (e.mode === 'adv' ? 'adv' : 'dis') + ')</span>' : '') +
      '</div>' +
      '<div class="dr-e-detail">' + escapeHtml(e.detail || '') + '</div>' + extra;
    // Newest always sits on top: live rolls prepend, and history is iterated oldest→newest
    // and prepended too, so the final order is newest-first either way.
    listEl.insertBefore(item, listEl.firstChild);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildPanel() {
    if (document.getElementById('dr-panel')) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    panelEl = document.createElement('div');
    panelEl.id = 'dr-panel';
    panelEl.className = 'dr-collapsed';
    panelEl.innerHTML =
      '<button id="dr-handle" title="Show / hide dice log">🎲<span>ROLLS</span></button>' +
      '<div class="dr-panel-inner">' +
      '  <div class="dr-panel-head"><span>Dice Log</span><button id="dr-clear" title="Clear (local view)">clear</button></div>' +
      '  <div class="dr-list" id="dr-list"></div>' +
      '</div>';
    document.body.appendChild(panelEl);
    listEl = document.getElementById('dr-list');
    document.getElementById('dr-handle').addEventListener('click', function () {
      panelEl.classList.toggle('dr-collapsed');
    });
    document.getElementById('dr-clear').addEventListener('click', function () { if (listEl) listEl.innerHTML = ''; });
  }

  // ── sync with the server (history + live SSE + a polling fallback) ─────────
  // The log fetches /api/rolls and renders each entry; renderEntry() dedupes by id, so
  // fetching the same history repeatedly only ever adds rolls we haven't shown yet.
  function loadHistory() {
    return fetch('/api/rolls').then(function (r) { return r.json(); }).then(function (d) {
      // Oldest→newest so prepending leaves the newest on top; already-shown ids are skipped.
      (d.rolls || []).forEach(function (e) { renderEntry(e, false); });
    }).catch(function () {});
  }

  // Live roll sync PRIMARILY rides the host tool's MAIN SSE stream (DiceRoll.ingestRemote is
  // called per 'dr-roll' event) — that's instant and needs no extra connection. BUT SSE can be
  // buffered or dropped over the Cloudflare tunnel (the same reason the atlas/NPC tools poll
  // their content), and the roll log had no fallback — so a player's roll never appeared for
  // others until a reload. This poll is the safety net: every 2s it re-fetches the history and
  // renders anything SSE missed. Cheap (≤200 short entries, deduped; a poll with nothing new
  // does zero DOM work), and it makes EVERY roll from EVERYONE show up live in just the rolls
  // window — no page refresh. 2s keeps a dropped-SSE roll feeling near-instant; the extra no-op
  // requests when SSE is healthy are negligible at this scale (~a few small GETs/sec, tab-paused
  // when hidden). Rolls poll faster than combat (4s) because they're the most time-sensitive.
  // ADAPTIVE: 2s only matters when SSE isn't delivering. While the stream is
  // provably alive (window.SSEHealth — fed by the host page's heartbeat), rolls
  // already arrive instantly via ingestRemote, so the poll drops to a slow
  // backstop. The moment the stream goes quiet it snaps back to 2s.
  var POLL_MS      = 2000;    // SSE looks dead → near-instant recovery
  var POLL_SLOW_MS = 15000;   // SSE delivering → just a backstop
  var pollTimer = null;
  function pollDelay() {
    var h = window.SSEHealth;
    return (h && typeof h.isHealthy === 'function' && h.isHealthy()) ? POLL_SLOW_MS : POLL_MS;
  }
  function pollTick() {
    loadHistory().then(function () { pollTimer = setTimeout(pollTick, pollDelay()); },
                       function () { pollTimer = setTimeout(pollTick, pollDelay()); });
  }
  function startPolling() {
    if (pollTimer) return;
    // Pause polling while the tab is hidden (no one's watching); resume on focus and catch up.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { clearTimeout(pollTimer); pollTimer = null; }
      else if (!pollTimer) { loadHistory(); pollTimer = setTimeout(pollTick, pollDelay()); }
    });
    pollTimer = setTimeout(pollTick, pollDelay());
  }

  function init() {
    buildPanel();
    loadHistory();
    startPolling();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  var CSS = [
    '#dr-panel{position:fixed;right:0;bottom:16px;z-index:4000;display:flex;align-items:flex-end;font-family:system-ui,Segoe UI,sans-serif;transition:transform .25s ease}',
    '#dr-panel.dr-collapsed{transform:translateX(calc(100% - 34px))}',
    // Collapsed: hide the content so the panel shrinks to just the fixed-height handle tab,
    // never covering the panels stacked above it regardless of how many rolls are logged.
    '#dr-panel.dr-collapsed .dr-panel-inner{display:none}',
    '#dr-panel.dr-collapsed #dr-handle{align-self:flex-end;height:120px}',
    '#dr-handle{align-self:stretch;width:34px;border:none;border-radius:6px 0 0 6px;background:#2a1e0c;color:#e8c96a;cursor:pointer;font-size:16px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:10px 0;box-shadow:-2px 0 10px rgba(0,0,0,.4)}',
    '#dr-handle span{writing-mode:vertical-rl;text-orientation:upright;font-size:9px;letter-spacing:2px;color:#b8924a}',
    '.dr-panel-inner{width:270px;max-height:60vh;background:#140f06;border:1px solid #3a2a0a;border-right:none;border-radius:6px 0 0 6px;display:flex;flex-direction:column;box-shadow:-4px 0 24px rgba(0,0,0,.5)}',
    '.dr-panel-head{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#0e0a04;color:#e8c96a;font-family:Cinzel,serif;font-size:.8rem;letter-spacing:.06em;border-bottom:1px solid #3a2a0a}',
    '#dr-clear{background:none;border:1px solid #3a2a0a;color:#8a6a30;border-radius:3px;font-size:.6rem;padding:2px 7px;cursor:pointer;letter-spacing:.05em}',
    '#dr-clear:hover{color:#e8c96a;border-color:#6a4a10}',
    '.dr-list{overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:5px}',
    '.dr-entry{background:#1c1509;border:1px solid #2e2410;border-left:3px solid #6a5a2a;border-radius:4px;padding:5px 8px}',
    // Advantage → green, disadvantage → red: a thicker coloured rail + a tinted background so an
    // adv/dis roll reads as green/red at a glance (matching the green/red on the roll trigger).
    '.dr-entry.dr-e-adv{border-left-width:4px;border-left-color:#3f9d54;background:linear-gradient(90deg,rgba(63,157,84,.16),rgba(28,21,9,0))}',
    '.dr-entry.dr-e-disadv{border-left-width:4px;border-left-color:#c04a44;background:linear-gradient(90deg,rgba(192,74,68,.16),rgba(28,21,9,0))}',
    '.dr-entry.dr-e-adv .dr-e-mode{color:#5fbf74;font-weight:600}',
    '.dr-entry.dr-e-disadv .dr-e-mode{color:#e07a72;font-weight:600}',
    '.dr-entry.dr-e-adv .dr-e-total{color:#bfe8c8}.dr-entry.dr-e-disadv .dr-e-total{color:#f0c0ba}',
    // hidden roll (DM-only view): muted + a dashed steel-blue rail so it reads as "secret"
    '.dr-entry.dr-e-hidden{border-left-style:dashed;border-left-color:#5a7a9a;background:#141a20;opacity:.92}',
    '.dr-e-hidden-badge{font-size:.56rem;color:#7fa0c0;margin-left:6px;letter-spacing:.04em;font-weight:600;vertical-align:middle}',
    '.dr-e-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}',
    '.dr-e-who{font-family:Cinzel,serif;font-size:.72rem;color:#c8a04a;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dr-e-total{font-size:1.15rem;font-weight:700;color:#f0e6c8;font-variant-numeric:tabular-nums}',
    '.dr-e-action{font-size:.74rem;color:#cbbfa0;margin-top:1px}',
    '.dr-e-mode{color:#8a7a50;font-style:italic}',
    '.dr-e-detail{font-family:Consolas,monospace;font-size:.62rem;color:#7f7050;margin-top:2px;word-break:break-word}',
    '.dr-e-extra{font-size:.66rem;color:#9a8a5a;font-style:italic;margin-top:2px}',
    // trigger + mode colours
    '.dr-trigger{cursor:pointer;border-radius:3px;transition:background .1s,color .1s;position:relative}',
    '.dr-trigger:hover{background:rgba(212,160,23,.18);box-shadow:0 0 0 1px rgba(212,160,23,.4)}',
    '.dr-mode-adv{color:#2f8f47 !important;box-shadow:0 0 0 1px rgba(47,143,71,.6)}',
    '.dr-mode-disadv{color:#b6433f !important;box-shadow:0 0 0 1px rgba(182,67,63,.6)}',
    '.dr-mode-menu{position:fixed;z-index:4100;background:#140f06;border:1px solid #3a2a0a;border-radius:5px;box-shadow:0 6px 20px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden}',
    '.dr-mode-opt{background:none;border:none;text-align:left;padding:6px 14px;font-family:Cinzel,serif;font-size:.7rem;letter-spacing:.04em;cursor:pointer;color:#cbbfa0;white-space:nowrap}',
    '.dr-mode-opt:hover{background:rgba(212,160,23,.15)}',
    '.dr-mode-opt-adv{color:#3f9d54}.dr-mode-opt-disadv{color:#c85a56}',
    '.dr-mode-opt-hidden{color:#7fa0c0}',
    // small round "use" buttons the host tools reuse
    '.dr-use-btn{background:#2a1e0c;color:#e8c96a;border:1px solid #6a4a10;border-radius:3px;font-size:.62rem;letter-spacing:.04em;padding:2px 8px;cursor:pointer;font-family:Cinzel,serif}',
    '.dr-use-btn:hover{background:#3a2a10;color:#fff}'
  ].join('\n');

  // public API
  window.DiceRoll = {
    trigger: trigger,
    emit: emit,
    d20Check: d20Check,
    rollExpression: rollExpression,
    fmtMod: fmtMod,
    setActor: function (name) { currentActor = name || 'Someone'; },
    getActor: function () { return currentActor; },
    // Host tools call this once whoami resolves so only the DM can hide rolls.
    setDM: function (v) { isDMUser = !!v; },
    // Called by the host tool when a roll event arrives on its MAIN SSE stream.
    // The roll log no longer opens its own EventSource: each extra persistent SSE
    // consumes one of the browser's ~6 connections-per-origin, which starved tabs.
    ingestRemote: function (entry) { try { if (entry && entry.id) renderEntry(entry, true); } catch (_) {} }
  };
})();
