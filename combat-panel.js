// ─── SHARED COMBAT PANELS (initiative + attacks) ─────────────────────────────
// A self-contained module for the MAP TOOL (atlas). It renders the same docked
// INITIATIVE and ATTACKS side windows the NPC tool has, driven entirely by the
// shared server combat state (/api/combat + SSE 'combat'). The NPC tool keeps its
// own inline version; both read the same state, so they stay in sync.
//
// Host page must define, before this runs:
//   window.CombatPanel.config = {
//     isDM: <bool>,
//     myCharacterId: '<npcId or "">',   // the player's own character (for the attacks panel)
//     diceRoll: <optional DiceRoll module for the attacks panel's roll buttons>
//   }
// The host feeds SSE 'combat' events by calling window.CombatPanel.ingest(state).
(function () {
  'use strict';
  if (window.CombatPanel && window.CombatPanel._built) return;

  const cfg = (window.CombatPanel && window.CombatPanel.config) || {};
  const IS_DM = !!cfg.isDM;
  const MY_ID = cfg.myCharacterId || '';
  const DR = cfg.diceRoll || window.DiceRoll || null;
  // Which docked panels this host wants: 'init', 'attacks', or 'both' (default).
  // Atlas uses 'init'; the town map tool uses 'attacks'.
  const PANELS = cfg.panels || 'both';
  const WANT_INIT = PANELS === 'both' || PANELS === 'init';
  const WANT_ATK  = PANELS === 'both' || PANELS === 'attacks';

  let state = { combatants: [], activeIdx: 0, round: 1, active: false };
  let saveTimer = null;

  function intFrom(v) { const m = String(v == null ? '' : v).match(/-?\d+/); return m ? parseInt(m[0], 10) : 0; }
  function slug(raw) { return (raw || '').toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, ''); }

  function normalize(s) {
    const combatants = (Array.isArray(s.combatants) ? s.combatants : []).map(c => ({
      ...c, conditions: Array.isArray(c.conditions) ? c.conditions : [], attacks: Array.isArray(c.attacks) ? c.attacks : []
    }));
    return {
      combatants,
      activeIdx: Math.max(0, Math.min(combatants.length ? combatants.length - 1 : 0, parseInt(s.activeIdx, 10) || 0)),
      round: Math.max(1, parseInt(s.round, 10) || 1),
      active: !!s.active
    };
  }

  // DM writes the whole state; players never write it here (they can't run combat).
  function saveState() {
    if (!IS_DM) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fetch('/api/combat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state }) }).catch(() => {});
    }, 120);
  }

  // ── turn logic (mirrors the NPC tool) ──
  const isLiving = c => !(c && c.hp !== null && c.hp !== undefined && c.hp <= 0);
  const initKey = c => (c.init === null || c.init === undefined) ? -Infinity : c.init;   // no-score → bottom
  function sortCombat() {
    const active = state.combatants[state.activeIdx];
    state.combatants.sort((a, b) => (initKey(b) - initKey(a)));
    if (active) state.activeIdx = Math.max(0, state.combatants.indexOf(active));
  }
  function step(dir) {
    if (!IS_DM || !state.combatants.length) return;
    const n = state.combatants.length;
    if (!state.combatants.some(isLiving)) return;
    let idx = state.activeIdx, guard = 0;
    do {
      idx += dir;
      if (idx >= n) { idx = 0; state.round++; }
      else if (idx < 0) { idx = n - 1; state.round = Math.max(1, state.round - 1); }
      guard++;
    } while (!isLiving(state.combatants[idx]) && guard <= n);
    state.activeIdx = idx; render(); saveState();
  }
  function startCombat() {
    if (!IS_DM || !state.combatants.length) return;
    sortCombat(); state.active = true; state.round = 1; state.activeIdx = 0;
    if (state.combatants[0] && state.combatants[0].hp !== null && state.combatants[0].hp <= 0) step(1);
    render(); saveState();
  }
  function endCombat() { if (!IS_DM) return; state.active = false; render(); saveState(); }
  function removeCombatant(npcId) {
    if (!IS_DM) return;
    const i = state.combatants.findIndex(c => c.npcId === npcId);
    if (i < 0) return;
    state.combatants.splice(i, 1);
    // Removing an earlier entry shifts the active index down by one — keep the highlight
    // on the same creature (then clamp).
    if (i < state.activeIdx) state.activeIdx--;
    if (state.activeIdx >= state.combatants.length) state.activeIdx = 0;
    render(); saveState();
  }
  function editInit(cell, idx) {
    const c = state.combatants[idx]; if (!c) return;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.className = 'cp-init-edit'; inp.value = c.init;
    cell.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    const commit = (save) => {
      if (done) return; done = true;
      if (save) { const v = parseInt(inp.value, 10); if (Number.isFinite(v)) c.init = v; sortCombat(); saveState(); }
      render();
    };
    inp.addEventListener('blur', () => commit(true));
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); });
  }

  // ── mutual exclusion between the two docked panels ──
  function closeOthers(keep) {
    const ip = document.getElementById('cp-init-panel'), ap = document.getElementById('cp-atk-panel');
    if (keep !== 'init' && ip) ip.classList.add('cp-collapsed');
    if (keep !== 'atk' && ap) ap.classList.add('cp-collapsed');
  }

  // ── build the docked panels ──
  function build() {
    if (document.getElementById('cp-init-panel')) return;
    const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

    if (WANT_INIT) {
      const initP = document.createElement('div');
      initP.id = 'cp-init-panel'; initP.className = 'cp-panel cp-collapsed';
      initP.innerHTML =
        '<button class="cp-handle cp-handle-init" title="Show / hide initiative">⚑<span>INITIATIVE</span></button>' +
        '<div class="cp-inner">' +
        '  <div class="cp-head"><span>Initiative</span><span class="cp-round">Round <span id="cp-round-num">1</span></span></div>' +
        '  <div class="cp-controls" id="cp-controls"></div>' +
        '  <div class="cp-list" id="cp-init-list"></div>' +
        '</div>';
      document.body.appendChild(initP);
      initP.querySelector('.cp-handle').addEventListener('click', () => {
        const opening = initP.classList.contains('cp-collapsed');
        initP.classList.toggle('cp-collapsed');
        if (opening) closeOthers('init');
      });
    }

    if (WANT_ATK) {
      const atkP = document.createElement('div');
      atkP.id = 'cp-atk-panel'; atkP.className = 'cp-panel cp-collapsed';
      // Always docked above the ROLLS panel (bottom:118 vs ROLLS at bottom:16).
      atkP.innerHTML =
        '<button class="cp-handle cp-handle-atk" title="Show / hide attacks">⚔<span>ATTACKS</span></button>' +
        '<div class="cp-inner">' +
        '  <div class="cp-head"><span id="cp-atk-title">Attacks</span></div>' +
        '  <div class="cp-list" id="cp-atk-list"></div>' +
        '</div>';
      document.body.appendChild(atkP);
      atkP.querySelector('.cp-handle').addEventListener('click', () => {
        const opening = atkP.classList.contains('cp-collapsed');
        atkP.classList.toggle('cp-collapsed');
        if (opening) closeOthers('atk');
      });
    }
  }

  function render() {
    build();
    renderAttacks();   // attacks panel renders independently of the init panel
    const list = document.getElementById('cp-init-list');
    const roundEl = document.getElementById('cp-round-num');
    const controls = document.getElementById('cp-controls');
    if (!list) return;   // no init panel on this host (attacks-only) — attacks already rendered
    if (roundEl) roundEl.textContent = state.round;

    if (controls) {
      controls.innerHTML = '';
      if (IS_DM) {
        if (!state.active) {
          const s = mkBtn('▶ Start', 'cp-start', startCombat); controls.appendChild(s);
        } else {
          controls.appendChild(mkBtn('◀ Prev', '', () => step(-1)));
          controls.appendChild(mkBtn('Next ▶', '', () => step(1)));
          controls.appendChild(mkBtn('End', 'cp-end', endCombat));
        }
      } else {
        controls.appendChild(elText('div', 'cp-controls-ro', state.active ? 'Combat in progress' : 'No combat active'));
      }
    }

    list.innerHTML = '';
    if (!state.combatants.length) {
      list.innerHTML = '<div class="cp-empty">No combatants yet.</div>';
      return;
    }
    state.combatants.forEach((c, i) => {
      const dead = c.hp !== null && c.hp !== undefined && c.hp <= 0;
      const isActive = state.active && i === state.activeIdx;
      const row = document.createElement('div');
      row.className = 'cp-row' + (isActive ? ' cp-active' : '') + (dead ? ' cp-dead' : '') + (c.isPlayer ? ' cp-player' : '') + hpClass(c);

      const noScore = (c.init === null || c.init === undefined);   // player who hasn't rolled yet
      const initEl = document.createElement('span');
      initEl.className = 'cp-init' + (IS_DM ? '' : ' cp-readonly') + (noScore ? ' cp-noscore' : '');
      initEl.textContent = noScore ? '—' : c.init;
      if (IS_DM) { initEl.title = noScore ? 'No score yet — click to set (reorders)' : 'Click to edit — reorders'; initEl.addEventListener('click', () => editInit(initEl, i)); }
      row.appendChild(initEl);

      const nameWrap = document.createElement('div'); nameWrap.className = 'cp-name-wrap';
      const nameEl = document.createElement('span'); nameEl.className = 'cp-name'; nameEl.textContent = c.name;
      nameEl.title = c.name + (c.isPlayer ? ' (player)' : '');
      nameWrap.appendChild(nameEl);
      const tag = hpTag(c);
      if (tag) nameWrap.appendChild(tag);
      const conds = condDots(c.conditions);
      if (conds) nameWrap.appendChild(conds);
      row.appendChild(nameWrap);

      const hpEl = document.createElement('span');
      hpEl.className = 'cp-hp' + (dead ? ' cp-hp-zero' : '');
      hpEl.textContent = (c.hp === null || c.hp === undefined) ? '' : (dead ? '✖ 0' : c.hp + (c.hpMax ? '/' + c.hpMax : ''));
      row.appendChild(hpEl);

      if (IS_DM) {
        const rm = document.createElement('button'); rm.className = 'cp-remove'; rm.textContent = '✕'; rm.title = 'Remove from combat';
        rm.addEventListener('click', () => removeCombatant(c.npcId));
        row.appendChild(rm);
      }
      list.appendChild(row);
    });
  }

  // ── HP indicators (Part 5): bloodied ≤50%, dying ≤10% (and not dead at 0) ──
  function hpStatus(c) {
    if (c.hp === null || c.hp === undefined || !c.hpMax || c.hpMax <= 0) return '';
    if (c.hp <= 0) return '';                       // dead is handled separately (greyed)
    const pct = c.hp / c.hpMax;
    if (pct <= 0.10) return 'dying';
    if (pct <= 0.50) return 'bloodied';
    return '';
  }
  function hpClass(c) { const s = hpStatus(c); return s ? ' cp-' + s : ''; }
  function hpTag(c) {
    const s = hpStatus(c); if (!s) return null;
    const t = document.createElement('span'); t.className = 'cp-hptag cp-tag-' + s;
    t.textContent = s === 'dying' ? 'dying' : 'bloodied'; t.title = s === 'dying' ? 'At or below 10% HP' : 'At or below 50% HP';
    return t;
  }

  // ── conditions (Part 6): colored dots on init rows (colours mirror the NPC tool) ──
  const CONDITION_COLORS = {
    blinded: '#5a6b8c', charmed: '#d46aa8', deafened: '#7d7d7d', frightened: '#9c6ad4',
    grappled: '#b5852a', incapacitated: '#8a8a8a', invisible: '#4aa6c0', paralyzed: '#c0522a',
    petrified: '#6b7a6b', poisoned: '#4a9c4a', prone: '#a08040', restrained: '#c08a3a',
    stunned: '#c0a040', unconscious: '#3a4a6a', exhaustion: '#8a4a4a'
  };
  function condName(id) { return id ? id.charAt(0).toUpperCase() + id.slice(1) : ''; }
  function condDots(conds) {
    if (!Array.isArray(conds) || !conds.length) return null;
    const wrap = document.createElement('span'); wrap.className = 'cp-cond-dots';
    conds.forEach(id => {
      const dot = document.createElement('span'); dot.className = 'cp-cond-dot';
      dot.style.background = CONDITION_COLORS[id] || '#888'; dot.title = condName(id);
      wrap.appendChild(dot);
    });
    return wrap;
  }

  // ── minimal dice roller (posts to the shared roll log; no dice-roll.js dependency) ──
  function rollExpression(expr) {
    if (expr == null) return null;
    const terms = String(expr).toLowerCase().match(/[+-]?\s*(\d*d\d+|\d+)/g);
    if (!terms) return null;
    let total = 0, pieces = [], found = false;
    terms.forEach(raw => {
      let t = raw.replace(/\s+/g, ''); const sign = t[0] === '-' ? -1 : 1; t = t.replace(/^[+-]/, '');
      const dm = t.match(/^(\d*)d(\d+)$/);
      if (dm) { found = true; const nn = parseInt(dm[1] || '1', 10), sides = parseInt(dm[2], 10);
        if (nn > 0 && nn <= 100 && sides > 0) { let rs = []; for (let i = 0; i < nn; i++) rs.push(1 + Math.floor(Math.random() * sides));
          const sub = rs.reduce((a, b) => a + b, 0) * sign; total += sub; pieces.push((sign < 0 ? '-' : '') + nn + 'd' + sides + '[' + rs.join(',') + ']'); } }
      else { const v = parseInt(t, 10); if (!isNaN(v)) { total += v * sign; pieces.push((sign < 0 ? '-' : '+') + v); found = true; } }
    });
    return found ? { total, detail: pieces.join(' ').replace(/^\+/, '') } : null;
  }
  // A d20 check that honours advantage/disadvantage ('adv'/'disadv'), mirroring DiceRoll.d20Check
  // so attack rolls in this panel get the same behaviour as the sheet's rolls.
  function d20(mod, mode) {
    var m = parseInt(mod, 10) || 0;
    var rolls, kept;
    if (mode === 'adv' || mode === 'disadv') {
      rolls = [1 + Math.floor(Math.random() * 20), 1 + Math.floor(Math.random() * 20)];
      kept = mode === 'adv' ? Math.max(rolls[0], rolls[1]) : Math.min(rolls[0], rolls[1]);
    } else { rolls = [1 + Math.floor(Math.random() * 20)]; kept = rolls[0]; }
    var d20txt = rolls.length > 1 ? ('d20[' + rolls.join(',') + '→' + kept + ']') : ('d20[' + kept + ']');
    return { total: kept + m, detail: d20txt + (m ? (m > 0 ? ' +' + m : ' ' + m) : ''), nat20: kept === 20, nat1: kept === 1 };
  }
  function emitRoll(who, action, total, detail, extra, mode) {
    var payload = { who, action, total, detail, extra: extra || null, mode: (mode === 'adv' || mode === 'disadv') ? mode : null };
    if (DR && DR.emit) { DR.emit(payload); return; }
    fetch('/api/roll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).catch(() => {});
  }

  // ── attacks panel (Part 3) ──
  // Which combatant's attacks to show:
  //   player → their own character (MY_ID);
  //   DM     → the ACTIVE combatant, but only if it's a monster/NPC (empty on player turns).
  function attacksSubject() {
    if (!state.combatants.length) return null;
    if (!IS_DM) {
      if (!MY_ID) return null;
      return state.combatants.find(c => slug(c.npcId) === slug(MY_ID)) || null;
    }
    if (!state.active) return null;
    const c = state.combatants[state.activeIdx];
    if (!c || c.isPlayer) return null;   // DM's panel is empty during player turns
    return c;
  }

  // ── attack-usage ranking (mirrors the NPC tool) ──
  // Featured cap per category; the most-used up to this many weapons/spells/others float to a
  // "Most used" section on top, the rest scroll below. Usage is the last-100 window the server
  // keeps per character. Tracked roll per category: weapon → attack-bonus button (or damage if
  // no bonus), spell → damage, trait/other → attack bonus if present else damage.
  const ATK_FEATURED_PER_CAT = 5;
  let _atkUsage = [];         // [{name,source,ts}] for the current attacks subject
  let _atkUsageFor = null;    // npcId the buffer was loaded for
  const _atkMode = {};        // remembered adv/dis per attack name (sticky across re-renders)
  function trackedButtonKind(a) {
    if (a.source === 'spell')  return a.damage ? 'dmg' : (a.heal ? 'heal' : (a.bonus ? 'atk' : null));
    if (a.bonus)  return 'atk';
    if (a.damage) return 'dmg';
    return null;
  }
  function atkUseCount(name) { let n = 0; for (const e of _atkUsage) if (e.name === name) n++; return n; }
  function loadAtkUsage(npcId) {
    if (!npcId) { _atkUsage = []; _atkUsageFor = null; renderAttacks(); return; }
    if (_atkUsageFor === npcId) return;                 // already have it
    _atkUsageFor = npcId;
    fetch('/api/attack-usage/' + encodeURIComponent(npcId)).then(r => r.json())
      .then(d => { if (_atkUsageFor === npcId) { _atkUsage = Array.isArray(d.events) ? d.events : []; renderAttacks(); } })
      .catch(() => {});
  }
  function recordAtkUse(npcId, a) {
    if (!npcId || !a || !a.name) return;
    _atkUsage.push({ name: a.name, source: a.source || 'trait', ts: Date.now() });
    while (_atkUsage.length > 100) _atkUsage.shift();
    fetch('/api/attack-usage', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ npcId: npcId, name: a.name, source: a.source || 'trait' }) }).catch(() => {});
    renderAttacks();
  }

  function renderAttacks() {
    const box = document.getElementById('cp-atk-list');
    const title = document.getElementById('cp-atk-title');
    if (!box) return;
    const subj = attacksSubject();
    if (title) title.textContent = subj ? subj.name : 'Attacks';
    // Load this subject's usage window on demand (re-renders when it arrives).
    if (subj && subj.npcId && _atkUsageFor !== slug(subj.npcId)) { loadAtkUsage(slug(subj.npcId)); }
    box.innerHTML = '';
    const usable = subj ? (subj.attacks || []).filter(a => !a.disabled) : [];
    if (!usable.length) {
      box.innerHTML = '<div class="cp-empty">' + (subj ? 'No attacks available.' : (IS_DM ? 'No active monster this turn.' : 'Your attacks appear here in combat.')) + '</div>';
      return;
    }
    const who = subj.name;
    const npcId = subj.npcId ? slug(subj.npcId) : '';

    // rank each category by usage, feature top-N, keep the rest (original order)
    const cats = { weapon: [], spell: [], trait: [] };
    usable.forEach((a, i) => { (cats[a.source] || cats.trait).push({ a, i }); });
    const featured = [], rest = [];
    ['weapon', 'spell', 'trait'].forEach(src => {
      const entries = cats[src]; if (!entries.length) return;
      const ranked = entries.slice().sort((x, y) => {
        const d = atkUseCount(y.a.name) - atkUseCount(x.a.name);
        return d !== 0 ? d : (x.i - y.i);
      });
      const top = ranked.slice(0, ATK_FEATURED_PER_CAT);
      const topSet = new Set(top.map(e => e.i));
      top.forEach(e => featured.push(e.a));
      entries.filter(e => !topSet.has(e.i)).forEach(e => rest.push(e.a));
    });

    const addCard = a => {
      const card = document.createElement('div');
      card.className = 'cp-atk-card cp-atk-' + (a.source || 'weapon');
      const nameEl = document.createElement('div'); nameEl.className = 'cp-atk-name'; nameEl.textContent = a.name;
      const uses = atkUseCount(a.name);
      if (uses) { const u = document.createElement('span'); u.className = 'cp-atk-uses'; u.textContent = '×' + uses; u.title = 'Used ' + uses + '× in the last 100 rolls'; nameEl.appendChild(u); }
      card.appendChild(nameEl);
      const btns = document.createElement('div'); btns.className = 'cp-atk-btns';
      const tracked = trackedButtonKind(a);
      if (a.bonus) {
        const b = document.createElement('button'); b.className = 'cp-use'; b.textContent = a.bonus; b.title = 'Roll to hit (hover for advantage / disadvantage)';
        // Route to-hit through DiceRoll.trigger so it gets the shared adv/disadv hover picker and
        // the chosen mode rides into the roll + the rolls log. Falls back to a plain roll if the
        // shared roller isn't present.
        if (DR && DR.trigger) {
          DR.trigger(b, { d20: true, who: () => who, roll: (mode) => {
            _atkMode[a.name] = mode;      // remember adv/dis so it STICKS across panel re-renders
            if (tracked === 'atk') recordAtkUse(npcId, a);
            const r = d20(intFrom(a.bonus), mode);
            return { action: a.name + ' — attack', total: r.total, detail: r.detail, extra: r.nat20 ? 'Critical hit!' : r.nat1 ? 'Critical miss!' : null };
          }});
          // The panel re-renders on every combat update (new button element each time), so
          // re-apply this attack's remembered adv/dis mode + its green/red colour after wiring.
          var savedMode = _atkMode[a.name];
          if (savedMode === 'adv' || savedMode === 'disadv') {
            b._drMode = savedMode;
            b.classList.add(savedMode === 'adv' ? 'dr-mode-adv' : 'dr-mode-disadv');
          }
        } else {
          b.addEventListener('click', () => { if (tracked === 'atk') recordAtkUse(npcId, a); const r = d20(intFrom(a.bonus)); emitRoll(who, a.name + ' — attack', r.total, r.detail, r.nat20 ? 'Critical hit!' : r.nat1 ? 'Critical miss!' : null); });
        }
        btns.appendChild(b);
      }
      if (a.damage) {
        const b = document.createElement('button'); b.className = 'cp-use'; b.textContent = a.damage + (a.dmgType ? ' ' + a.dmgType : ''); b.title = 'Roll damage';
        b.addEventListener('click', () => { if (tracked === 'dmg') recordAtkUse(npcId, a); const r = rollExpression(a.damage); if (r) emitRoll(who, a.name + ' — damage', r.total, r.detail, a.dmgType || null); });
        btns.appendChild(b);
      }
      if (a.heal) {
        const b = document.createElement('button'); b.className = 'cp-use'; b.textContent = '♥ ' + a.heal; b.title = 'Roll healing';
        b.addEventListener('click', () => { if (tracked === 'heal') recordAtkUse(npcId, a); const r = rollExpression(a.heal); if (r) emitRoll(who, a.name + ' — healing', r.total, r.detail, a.heal); });
        btns.appendChild(b);
      }
      (a.extras || []).forEach(ex => {
        const b = document.createElement('button'); b.className = 'cp-use'; b.textContent = ex.title; b.title = 'Roll ' + ex.dice;
        b.addEventListener('click', () => { const r = rollExpression(ex.dice); if (r) emitRoll(who, a.name + ' — ' + ex.title, r.total, r.detail, null); });
        btns.appendChild(b);
      });
      if (a.save && !a.damage && !a.heal) { const s = document.createElement('span'); s.className = 'cp-atk-save'; s.textContent = a.save; btns.appendChild(s); }
      card.appendChild(btns);
      box.appendChild(card);
    };

    if (rest.length) { const h = document.createElement('div'); h.className = 'cp-atk-section'; h.textContent = 'Most used'; box.appendChild(h); }
    featured.forEach(addCard);
    if (rest.length) { const h = document.createElement('div'); h.className = 'cp-atk-section cp-atk-section-more'; h.textContent = 'More attacks'; box.appendChild(h); rest.forEach(addCard); }
  }

  // ── helpers ──
  function mkBtn(text, cls, fn) { const b = document.createElement('button'); b.className = 'cp-btn ' + (cls || ''); b.textContent = text; b.addEventListener('click', fn); return b; }
  function elText(tag, cls, text) { const e = document.createElement(tag); e.className = cls; e.textContent = text; return e; }

  // ── public API + wiring ──
  function ingest(s) { state = normalize(s); _stateSig = JSON.stringify(state); render(); }
  function load() {
    fetch('/api/combat').then(r => {
      const tag = r.headers.get('ETag');
      if (tag) _combatEtag = tag;                 // seed the conditional-poll validator
      return r.json();
    }).then(d => { if (d && d.state) ingest(d.state); }).catch(() => {});
  }

  // ── polling fallback (initiative + attacks) ────────────────────────────────
  // Combat state (which drives BOTH the initiative and attacks panels) normally arrives live
  // via the 'combat' SSE event. SSE can be buffered/dropped over the Cloudflare tunnel, so we
  // also poll /api/combat as a safety net. Guards against thrashing and clobbering edits:
  //   • only ingest when the server state actually CHANGED (signature compare), so an unchanged
  //     poll is a no-op — no re-render, no flicker;
  //   • skip while the DM is mid-edit (an init input is focused, or this DM just saved) so the
  //     poll never overwrites an in-progress change with its own stale echo.
  //   • ADAPTIVE INTERVAL: when the SSE stream is provably healthy (the host page
  //     heard from it recently, via window.SSEHealth) the poll backs off to
  //     COMBAT_POLL_SLOW; if the stream goes quiet it drops back to COMBAT_POLL_FAST.
  //     Same safety net, a fraction of the requests.
  //   • CONDITIONAL REQUEST: the server ETags /api/combat, so an unchanged poll
  //     comes back 304 with no body and we skip the JSON parse entirely.
  var _stateSig = JSON.stringify(state);
  var _combatPollTimer = null;
  var COMBAT_POLL_FAST = 4000;    // SSE looks dead → keep the net tight
  var COMBAT_POLL_SLOW = 20000;   // SSE is delivering → just a backstop
  var _combatEtag = null;

  // How long to wait before the next poll, based on SSE health.
  function combatPollDelay() {
    var h = window.SSEHealth;
    return (h && typeof h.isHealthy === 'function' && h.isHealthy())
      ? COMBAT_POLL_SLOW : COMBAT_POLL_FAST;
  }

  function combatPollTick() {
    var editing = document.querySelector('.cp-init-edit');            // DM typing an init value
    var busy = IS_DM && (editing || saveTimer);                       // ...or a save is in flight
    var done = function () { _combatPollTimer = setTimeout(combatPollTick, combatPollDelay()); };
    if (busy) { done(); return; }
    var opts = _combatEtag ? { headers: { 'If-None-Match': _combatEtag } } : undefined;
    fetch('/api/combat', opts).then(function (r) {
      var tag = r.headers.get('ETag');
      if (tag) _combatEtag = tag;
      if (r.status === 304) { done(); return; }      // unchanged → nothing to do
      return r.json().then(function (d) {
        if (d && d.state) {
          var sig = JSON.stringify(normalize(d.state));
          if (sig !== _stateSig) ingest(d.state);   // changed → apply (and refresh the sig)
        }
        done();
      });
    }, done);
  }
  function startCombatPolling() {
    if (_combatPollTimer) return;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { clearTimeout(_combatPollTimer); _combatPollTimer = null; }
      else if (!_combatPollTimer) { load(); _combatPollTimer = setTimeout(combatPollTick, combatPollDelay()); }
    });
    _combatPollTimer = setTimeout(combatPollTick, combatPollDelay());
  }

  window.CombatPanel = Object.assign(window.CombatPanel || {}, {
    _built: true,
    config: cfg,
    ingest: ingest,
    getState: () => state,
    render: render,
    _internal: { normalize, sortCombat, step, startCombat, endCombat, removeCombatant, isLiving, attacksSubject }
  });

  const CSS = [
    '.cp-panel{position:fixed;right:0;z-index:3950;display:flex;align-items:flex-end;font-family:system-ui,Segoe UI,sans-serif;transition:transform .25s ease}',
    // Collapsed handles stack adjacently up the right edge, bottom→top: ROLLS (dice-roll.js,
    // bottom:16, 120px tall → occupies 16–136), then ATTACKS directly above it (bottom:136,
    // 120px → 136–256), then INITIATIVE directly above that (bottom:256). The INITIATIVE handle
    // is taller (150px) so the upright 10-letter word fits; it's on top so the extra height
    // grows upward into empty space and doesn't shove the others.
    '#cp-atk-panel{bottom:136px}#cp-init-panel{bottom:256px}',
    '.cp-panel.cp-collapsed{transform:translateX(calc(100% - 34px))}',
    // Collapsed: hide the content so the panel is just a fixed-height handle tab and never
    // covers the panels stacked above/below it, no matter how many rows are in the list.
    '.cp-panel.cp-collapsed .cp-inner{display:none}',
    '.cp-panel.cp-collapsed .cp-handle{align-self:flex-end;height:120px}',
    '#cp-init-panel.cp-collapsed .cp-handle{height:150px}',   // taller so "INITIATIVE" fits
    '.cp-handle{align-self:stretch;width:34px;border:none;border-radius:6px 0 0 6px;cursor:pointer;font-size:16px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:10px 0;box-shadow:-2px 0 10px rgba(0,0,0,.4)}',
    '.cp-handle-init{background:#2a1408;color:#f0c86a}.cp-handle-atk{background:#3a1410;color:#f0b46a}',
    '.cp-handle span{writing-mode:vertical-rl;text-orientation:upright;font-size:9px;letter-spacing:2px}',
    '.cp-handle-init span{color:#c8a052}.cp-handle-atk span{color:#c88a52}',
    '.cp-inner{width:268px;max-height:62vh;background:#140f06;border:1px solid #4a3410;border-right:none;border-radius:6px 0 0 6px;display:flex;flex-direction:column;box-shadow:-4px 0 24px rgba(0,0,0,.5)}',
    '#cp-atk-panel .cp-inner{border-color:#4a2a1a;background:#17100a}',
    '.cp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;background:#0e0a04;color:#f0c86a;font-family:Cinzel,serif;font-size:.8rem;letter-spacing:.05em;border-bottom:1px solid #4a3410}',
    '#cp-atk-panel .cp-head{color:#f0b46a;border-color:#4a2a1a}',
    '.cp-round-num,#cp-round-num{font-variant-numeric:tabular-nums;font-weight:700;color:#ffe08a}',
    '.cp-controls{display:flex;gap:6px;padding:7px 10px;border-bottom:1px solid #2e2410}',
    '.cp-controls-ro{font-size:.7rem;color:#8a7040;font-style:italic;padding:2px 0}',
    '.cp-btn{flex:1;background:#2a1e0c;color:#e8c96a;border:1px solid #6a4a10;border-radius:4px;font-family:Cinzel,serif;font-size:.68rem;letter-spacing:.04em;padding:5px 0;cursor:pointer}',
    '.cp-btn:hover{background:#3a2a10;color:#fff}',
    '.cp-btn.cp-start{background:#2a4a2a;border-color:#3a6a3a;color:#b8f0b8}.cp-btn.cp-start:hover{background:#3a6a3a}',
    '.cp-btn.cp-end{background:#4a2020;border-color:#6a3030;color:#f0b8b8}',
    '.cp-list{overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:4px}',
    '.cp-empty{color:#8a7040;font-size:.72rem;font-style:italic;padding:12px 6px;text-align:center}',
    '.cp-row{display:flex;align-items:center;gap:8px;background:#1c1509;border:1px solid #2e2410;border-left:3px solid #6a5a2a;border-radius:4px;padding:5px 8px}',
    '.cp-row.cp-active{background:linear-gradient(90deg,rgba(200,160,40,.32),rgba(120,90,20,.14));border-left-color:#ffd23a;box-shadow:0 0 0 1px rgba(255,210,58,.35) inset}',
    '.cp-row.cp-dead{opacity:.45;filter:grayscale(.7)}',
    '.cp-row.cp-player{border-left-color:#4a7ad0}.cp-row.cp-active.cp-player{border-left-color:#ffd23a}',
    '.cp-init{font-variant-numeric:tabular-nums;font-weight:700;font-size:.95rem;color:#ffe08a;min-width:26px;text-align:center;cursor:text}',
    '.cp-init.cp-readonly{cursor:default}',
    '.cp-init.cp-noscore{color:#7a6a3a;font-weight:400}',
    '.cp-init-edit{width:40px;font-size:.9rem;text-align:center;background:#0e0a04;border:1px solid #6a4a10;color:#ffe08a;border-radius:3px}',
    '.cp-name-wrap{flex:1;display:flex;align-items:center;gap:5px;min-width:0}',
    '.cp-name{font-family:Cinzel,serif;font-size:.74rem;color:#e8d9b0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.cp-row.cp-active .cp-name{color:#fff6d8}',
    '.cp-hp{font-size:.66rem;color:#9a8a5a;font-variant-numeric:tabular-nums;white-space:nowrap}.cp-hp.cp-hp-zero{color:#d08070}',
    '.cp-remove{background:none;border:none;color:#8a6a4a;cursor:pointer;font-size:.85rem;line-height:1;opacity:.6;padding:0 2px}.cp-remove:hover{opacity:1;color:#d08070}',
    // attacks panel cards
    '.cp-atk-card{background:#22160d;border:1px solid #34220f;border-left:3px solid #7a4a2a;border-radius:4px;padding:6px 8px}',
    '.cp-atk-card.cp-atk-weapon{border-left-color:#b06a2a}.cp-atk-card.cp-atk-trait{border-left-color:#8a5ac8}.cp-atk-card.cp-atk-spell{border-left-color:#3a6ad0}',
    '.cp-atk-name{font-family:Cinzel,serif;font-size:.74rem;color:#e8c9a0;margin-bottom:4px;display:flex;align-items:center;gap:2px}',
    '.cp-atk-uses{margin-left:auto;font-family:Crimson Pro,serif;font-size:.62rem;color:#8a6a4a;flex-shrink:0}',
    '.cp-atk-section{font-family:Cinzel,serif;font-size:.58rem;letter-spacing:.1em;text-transform:uppercase;color:#a07850;padding:4px 2px 2px;border-bottom:1px solid #34220f;margin-top:2px}',
    '.cp-atk-section.cp-atk-section-more{color:#7a5a3a;margin-top:6px}',
    '.cp-atk-btns{display:flex;flex-wrap:wrap;gap:4px}',
    '.cp-use{background:#2a1e0c;color:#e8c96a;border:1px solid #6a4a10;border-radius:3px;font-size:.62rem;letter-spacing:.04em;padding:2px 8px;cursor:pointer;font-family:Cinzel,serif}.cp-use:hover{background:#3a2a10;color:#fff}',
    '.cp-atk-save{font-size:.66rem;color:#9ab4e8;background:rgba(60,90,180,.14);border:1px solid rgba(90,130,210,.4);border-radius:8px;padding:1px 7px}',
    // bloodied / dying tags
    '.cp-hptag{font-size:.52rem;text-transform:uppercase;letter-spacing:.06em;padding:1px 5px;border-radius:7px;font-family:Cinzel,serif;flex-shrink:0}',
    '.cp-tag-bloodied{background:rgba(180,30,30,.22);border:1px solid #b83030;color:#ff8a7a}',
    '.cp-tag-dying{background:rgba(40,0,10,.7);border:1px solid #5a1020;color:#c04050}',
    '.cp-row.cp-bloodied{border-left-color:#b83030}',
    '.cp-row.cp-dying{border-left-color:#5a1020}.cp-row.cp-dying .cp-hp{color:#c04050}',
    '.cp-row.cp-active.cp-bloodied,.cp-row.cp-active.cp-dying{border-left-color:#ffd23a}',
    // condition dots
    '.cp-cond-dots{display:inline-flex;gap:2px;flex-shrink:0}',
    '.cp-cond-dot{width:8px;height:8px;border-radius:50%;display:inline-block;box-shadow:0 0 0 1px rgba(0,0,0,.35)}'
  ].join('\n');

  build();
  load();
  startCombatPolling();   // SSE-fallback poll so initiative + attacks stay live over the tunnel
})();
