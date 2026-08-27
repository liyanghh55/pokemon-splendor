/* =====================================================================
 * Pokémon Splendor — AI opponent
 * ---------------------------------------------------------------------
 * Evaluation-based, evolution-aware 1-ply search.
 *
 * Splendor strategy baked in:
 *   - Victory Points dominate, with extra urgency near the 18 finish line.
 *   - "Bonus" cards are an engine: each permanent discount compounds, so
 *     they're valued for both their VP and the discounts they grant.
 *   - Evolution is a FREE action (end of turn) → after every candidate main
 *     action we also apply the best evolution, so the search naturally
 *     rewards building evolvable chains and cashing them in for cheap VP.
 *   - Reaching toward affordable high-VP cards ("proximity") is rewarded so
 *     the AI takes the right balls instead of hoarding.
 *
 * Public:
 *   AI.chooseTurn(state, opts)  -> { action, discards:[color], evolution:{fromId,toId}|null }
 *   AI.playTurn(state, opts)    -> applies the plan to `state` (incl. endTurn)
 * ===================================================================== */
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require('./engine.js') : root.Engine);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AI = api;
})(this, function (E) {
  'use strict';
  const { COLORS, ALL_TOKENS, FIELD_TIERS } = E;

  const DIFF = {
    easy:   { evoBias: 0.4, noise: 6,   proximity: 0.5, deny: 0,  beliefs: 1, proactivePokedex: false, queueAware: false },
    normal: { evoBias: 0.8, noise: 1.5, proximity: 1.0, deny: 0,  beliefs: 1, proactivePokedex: false, queueAware: false },
    hard:   { evoBias: 1.0, noise: 0,   proximity: 1.0, deny: 10, beliefs: 4, proactivePokedex: true, queueAware: true },
  };

  // Eval weights — SPSA-tuned via self-play (test/tune.js). The tuned set beats the original hand-set
  // weights at EVERY player count (2p 62%, 3p 40.7% vs 33.3 fair, 4p 31.7% vs 25 fair) and still
  // crushes greedy (88%). VP scale fixed at 100 (anchor); the rest relative. test/tune.js re-tunes vs
  // whatever is here. (Original hand values: vpEnd45 lastRound70 cards16 rl14 bonus4 coh5/3 distinct3
  // overstack3 tok1.0/.35/1.6 purple2 reserve.5 prox11/.4 proxBonus1.5 proxEvo.7 rlProx6/3 gapDiv1.4 evo6 deny1.)
  const DEFAULT_W = {
    vpEnd: 41.475, lastRound: 66.966, cards: 17.529, rl: 13.512, bonus: 4.436,
    coh1: 5.053, coh2: 3.138, distinct: 3.225, overstack: 3.276,
    tok1: 0.92, tok2: 0.357, tokPen: 1.514, purple: 1.969, reserve: 0.572,
    prox: 8.617, prox2: 0.435, proxBonus: 1.418, proxEvo: 0.586, rlProxE: 5.655, rlProxL: 3.161, gapDiv: 1.417,
    evo: 6.211, denyMul: 1.023,
    // --- expansion terms (hand-set, A/B-validated; only active when the expansion is on) ---
    megaTok: 14,    // holding the Mega token (max 1; required for the Megas win)
    megaCover: 5,   // per colour with ≥1 bonus (the win needs ALL five colours)
    megaOwn: 18,    // owning ≥1 Mega in play (win requirement, beyond its VP)
    megaProx: 9,    // proximity to an achievable Mega on offer (base owned)
    pokedex: 3,     // each held POKÉDEX ≈ 2 bankable wildcard balls
  };
  let W = Object.assign({}, DEFAULT_W);
  const ROUTE_PAIRS = [
    ['杰尼龟', '独角虫', 10], ['凯西', '喇叭芽', 7],
    ['小火龙', '尼多兰', 7], ['走路草', '鬼斯', 4],
    ['迷你龙', '绿毛虫', 6], ['绿毛虫', '小拳石', 7],
    ['迷你龙', '隆隆石', 5],
  ];

  // ---- static position evaluation from player `pid`'s perspective ----
  function evalState(s, pid, cfg) {
    const p = s.players[pid];
    const b = E.bonuses(s, p);
    const vp = E.scoreOf(s, p);
    let score = 0;

    score += vp * 100;                                   // VP is king (fixed anchor scale)
    const winVP = s.megasEnabled ? 20 : (s.winScore || 18);
    if (vp >= winVP - 7) score += (vp - (winVP - 7)) * W.vpEnd;   // endgame push, relative to the real target
    if (s.lastRound) score += vp * W.lastRound;          // race hard once final round is on

    // engine: owned bonus cards + total discount power are highly valued so
    // the AI keeps capturing rather than hoarding tokens.
    const cards = p.board.length;
    score += cards * W.cards;
    // 神兽/稀有 (rare/legend) anchor a colour high-score flow: 2 same-colour discounts
    // (+2VP for legend). Owning them is worth extra beyond a normal card.
    let rlOwned = 0;
    for (const id of p.board) { const t = s.byId[id].tier; if (t === 'rare' || t === 'legend') rlOwned++; }
    score += rlOwned * W.rl;                             // specials anchor a colour flow (2 same-colour discounts, can't be blocked)
    let totalBonus = 0;
    const bvals = [];
    for (const c of COLORS) { totalBonus += b[c]; bvals.push(b[c]); }
    score += totalBonus * W.bonus;
    // colour COHERENCE (高分流): a deep primary + a moderate secondary colour are what
    // unlock the expensive same-colour high-VP cards. Reward concentration over a flat
    // 1-of-each spread, but keep ≥2 colours (2-colour high cards) and lightly punish hoarding.
    bvals.sort((x, y) => y - x);
    score += Math.min(bvals[0], 4) * W.coh1 + Math.min(bvals[1], 3) * W.coh2;
    const distinct = bvals.filter(v => v > 0).length;
    score += Math.min(distinct, 2) * W.distinct;
    if (bvals[0] > 5) score -= (bvals[0] - 5) * W.overstack;   // mild anti-overstack

    // tokens: concave value with a real anti-hoard penalty past 8 so the AI
    // converts tokens into cards instead of sitting at the 10 limit.
    const toks = E.tokenTotal(p);
    score += Math.min(toks, 5) * W.tok1 + Math.max(0, Math.min(toks, 8) - 5) * W.tok2;
    score -= Math.max(0, toks - 8) * W.tokPen;
    score += p.tokens.purple * W.purple;                 // master balls are flexible
    // Reserving is a tempo cost: keep its value low so the AI only reserves when
    // the search proves it sets up a strong capture (or grabs a master when stuck).
    score += p.reserve.length * W.reserve;

    // proximity: reward being close to capturing the single most attractive
    // scoring card (field or hand). Weighted highly so the AI takes the RIGHT
    // balls toward a high-VP target instead of grabbing 0-VP junk.
    const early = s.round <= 6;
    const targets = [];
    for (const tier of E.fieldTiers(s)) for (const id of s.field[tier]) if (id) targets.push(id); // incl. Pokémart rows
    for (const id of p.reserve) targets.push(id);
    let bestProx = 0, prox2 = 0;
    for (const id of targets) {
      const card = s.byId[id];
      // evolved potential: a cheap card (御五家 3-2) that evolves into VP is worth reaching for
      let evoVP = 0;
      if (card.evolvesTo) { const t = DBfind(s, card.evolvesTo); if (t) evoVP = Math.max(0, t.vp - (card.vp || 0)); }
      // Pokémart effect worth (the card's ability, beyond VP/bonus)
      let effW = 0;
      if (E.isPokemart(card) && card.effect) {
        if (card.effect === 'discard_buy') continue;          // paid with cards, not balls — not a token target
        effW = card.effect === 'colorless_master' ? 2 * W.purple   // 图鉴 = 2 bankable wildcards
             : card.effect === 'free' ? 2                          // 技能机 free take
             : card.effect === 'copy_free' ? 2.5                   // 神奇糖果 assoc + free take
             : card.effect === 'copy' ? 1 : 1;                     // 进化石 / 药水
      }
      if (!card.vp && card.tier !== 'rare' && evoVP <= 0 && effW <= 0) continue;
      let gap = card.cost.purple || 0;
      for (const c of COLORS) gap += Math.max(0, (card.cost[c] || 0) - b[c] - p.tokens[c]);
      let worth = (card.vp || 0) + (card.bonusCount || 1) * W.proxBonus + evoVP * W.proxEvo + effW;
      if (card.tier === 'rare' || card.tier === 'legend') worth += early ? W.rlProxE : W.rlProxL; // engine anchor, esp. early
      const v = worth / (1 + gap * W.gapDiv);
      if (v > bestProx) { prox2 = bestProx; bestProx = v; } else if (v > prox2) prox2 = v;
    }
    score += (bestProx + prox2 * W.prox2) * W.prox * (cfg ? cfg.proximity : 1);  // top-2 → coherent multi-card lineup

    // opponent denial: lines that cut the strongest opponent's proximity to a big card
    // (e.g. capturing/reserving the card they were about to buy) are rewarded. Encodes the
    // "slow other players down / reserve what they need" principle in a 1-ply eval.
    if (cfg && cfg.deny) {
      let oppMax = 0;
      for (let q = 0; q < s.numPlayers; q++) {
        if (q === pid) continue;
        const op = s.players[q], ob = E.bonuses(s, op);
        let oprox = 0;
        for (const tier of actionTiers(s)) for (const id of s.field[tier]) {
          if (!id) continue; const card = s.byId[id];
          const rl = card.tier === 'rare' || card.tier === 'legend';
          if ((card.vp || 0) < 2 && !rl) continue;
          let gap = card.cost.purple || 0;
          for (const c of COLORS) gap += Math.max(0, (card.cost[c] || 0) - ob[c] - op.tokens[c]);
          const v = ((card.vp || 0) + (rl ? 3 : 0)) / (1 + gap * 1.4);
          if (v > oprox) oprox = v;
        }
        if (oprox > oppMax) oppMax = oprox;
      }
      score -= oppMax * cfg.deny * W.denyMul;
    }

    // Evolution potential: a caught Pokémon whose next form is available and
    // roughly affordable is nearly-free VP next turn.  Only one evolution is
    // allowed per turn, so hard AI discounts the second and later queued line
    // instead of pretending every ready evolution can resolve at once.
    const evoQueue = [];
    for (const id of p.board) {
      const card = s.byId[id];
      if (!card.evolvesTo || !card.evoCost) continue;
      let avail = false;
      for (const tier of FIELD_TIERS) for (const fid of s.field[tier]) if (fid && s.byId[fid].name === card.evolvesTo) avail = true;
      for (const rid of p.reserve) if (s.byId[rid].name === card.evolvesTo) avail = true;
      if (!avail) continue;
      // Evolution is paid only by discounts (bonuses), not tokens: reward chains
      // whose evo color is already (nearly) covered by owned discounts.
      const need = Math.max(0, card.evoCost.count - b[card.evoCost.color]);
      const tgt = DBfind(s, card.evolvesTo);
      const gain = tgt ? Math.max(0, tgt.vp - card.vp) : 1;
      evoQueue.push((gain * W.evo) / (1 + need));
    }
    evoQueue.sort((a, b) => b - a);
    for (let i = 0; i < evoQueue.length; i++) {
      const queueWeight = cfg && cfg.queueAware && !s.megasEnabled ? Math.pow(0.55, i) : 1;
      score += evoQueue[i] * queueWeight;
    }

    // --- Pokémart: held POKÉDEX cards are 2 bankable wildcards each ---
    if (s.pokemartEnabled) {
      let dex = 0;
      for (const id of p.board) { const c = s.byId[id]; if (E.isPokemart(c) && c.effect === 'colorless_master') dex++; }
      score += dex * W.pokedex;
    }

    // --- Megas: the WIN CONDITION changes (20 VP + ≥1 bonus of EVERY colour +
    // ≥1 Mega in play; unqualified players cannot win at all). Value the pieces. ---
    if (s.megasEnabled) {
      const ownMega = p.board.some(id => s.byId[id].tier === 'mega');
      let covered = 0;
      for (const c of COLORS) if (b[c] > 0) covered++;
      score += (p.megaToken || 0) * W.megaTok;
      score += covered * W.megaCover;
      if (ownMega) score += W.megaOwn;
      // proximity to an achievable Mega on offer (we own its base Pokémon)
      let mp = 0;
      for (const mid of (s.megaOffer || [])) {
        const m = s.byId[mid];
        let baseVp = -1;
        for (const id of p.board) { const c = s.byId[id]; if (c.name === m.megaFrom) { baseVp = c.vp || 0; break; } }
        if (baseVp < 0) continue;
        let gap = 0;
        for (const c of COLORS) gap += Math.max(0, (m.cost[c] || 0) - b[c] - p.tokens[c]);
        if (p.megaToken < 1) gap += 2;                    // still need the token ≈ a full turn away
        const worth = Math.max(0, (m.vp || 0) - baseVp) + (m.bonusCount || 1) + 4; // +4: win-critical piece
        const v = worth / (1 + gap * W.gapDiv);
        if (v > mp) mp = v;
      }
      score += mp * W.megaProx;
      // last-round reality check: only a QUALIFIED player can win under Megas
      if (s.lastRound && vp >= 20 && covered === 5 && ownMega) score += W.lastRound * 6;
    }

    if (cfg && cfg.noise) score += (E._noise ? E._noise() : 0) * cfg.noise;
    return score;
  }

  // best (highest-VP) card of a given species among all cards — for estimating
  // evolution VP gain. Cached per state.
  function DBfind(s, name) {
    if (!s._byName) {
      s._byName = {};
      for (const id in s.byId) { const c = s.byId[id]; if (!s._byName[c.name] || c.vp > s._byName[c.name].vp) s._byName[c.name] = c; }
    }
    return s._byName[name];
  }

  // ---- complete action planner -------------------------------------------------
  // Engine.legalActions intentionally stays compact for generic callers. The AI
  // expands PokéMart choices here so search can compare association colours,
  // POKÉDEX spending, discard payments and free-card chains instead of silently
  // ignoring those cards. The same planner also exposes takeMega to headless play.
  const actionTiers = (s) => E.fieldTiers ? E.fieldTiers(s) : FIELD_TIERS;
  function copyTargets(s, p) {
    const seen = {}, out = [];
    for (const id of p.board) {
      const color = E.effBonusColor(s, p, id);
      if (color && !seen[color]) { seen[color] = true; out.push(id); }
    }
    return out;
  }
  function pokedexSpends(s, p, card, cfg) {
    const dex = p.board.filter(id => E.isPokemart(s.byId[id]) && s.byId[id].effect === 'colorless_master');
    let min = -1, bestPurple = Infinity; const plans = [];
    const canPreserveForMega = cfg && cfg.proactivePokedex && s.megasEnabled && p.megaToken > 0;
    for (let n = 0; n <= dex.length; n++) {
      const payment = E.computePayment(s, p, card, n * 2);
      if (!payment.ok) continue;
      if (min < 0) { min = n; bestPurple = payment.pay.purple; plans.push(dex.slice(0, n)); continue; }
      // Do not guess the Mega route here: a free PokéMart chain may capture
      // the required base. captureActions verifies the complete simulated line.
      if (canPreserveForMega && payment.pay.purple < bestPurple) {
        plans.push(dex.slice(0, n)); bestPurple = payment.pay.purple;
      }
    }
    return min < 0 ? null : { plans, required: min };
  }
  function combinations(ids, count, limit) {
    const out = [], cur = []; limit = limit || 24;
    function walk(at) {
      if (out.length >= limit) return;
      if (cur.length === count) { out.push(cur.slice()); return; }
      for (let i = at; i <= ids.length - (count - cur.length); i++) { cur.push(ids[i]); walk(i + 1); cur.pop(); }
    }
    walk(0); return out;
  }
  function sacrificeValue(s, id) {
    const card = s.byId[id]; if (!card) return 1e9;
    let value = (card.vp || 0) * 120 + (card.bonusCount || 1) * 22;
    if (card.evolvesTo) value += 18;
    if (card.tier === 'rare' || card.tier === 'legend') value += 45;
    if (E.isPokemart(card)) {
      if (card.effect === 'colorless_master') value += 24;
      else if (card.effect === 'double') value += 30;
      else value += 16;
    }
    return value;
  }
  function freeCardValue(s, card) {
    let value = (card.vp || 0) * 100 + (card.bonusCount || 1) * 20;
    if (card.evolvesTo) { const to = DBfind(s, card.evolvesTo); if (to) value += Math.max(0, to.vp - card.vp) * 22; }
    if (E.isPokemart(card)) {
      const effect = { free: 55, copy_free: 50, double: 36, copy: 24, colorless_master: 20, discard_buy: 18 }[card.effect] || 0;
      value += effect;
    }
    return value;
  }
  function freePlans(s, p, parent, depth, seen) {
    depth = depth || 0; seen = seen || {};
    if (depth > 4) return [{}];
    const out = [], candidates = [];
    for (const tier of E.freeTiers(parent)) for (const id of (s.field[tier] || [])) {
      if (!id || seen[id]) continue;
      const card = s.byId[id];
      if (!E.freeTakeable(s, p, card)) continue;
      candidates.push(id);
    }
    candidates.sort((a, b) => freeCardValue(s, s.byId[b]) - freeCardValue(s, s.byId[a]) || String(a).localeCompare(String(b)));
    for (const id of candidates) {
      const card = s.byId[id];
      const assoc = E.isPokemart(card) && (card.effect === 'copy' || card.effect === 'copy_free') ? copyTargets(s, p) : [null];
      if (!assoc.length) continue;
      const nested = E.isPokemart(card) && (card.effect === 'free' || card.effect === 'copy_free')
        ? freePlans(s, p, card, depth + 1, Object.assign({}, seen, { [id]: true })) : [{}];
      for (const target of assoc) for (const sub of nested) {
        const freeOpts = Object.assign({}, sub);
        if (target) freeOpts.copyTargetId = target;
        out.push({ freeTakeId: id, freeOpts });
        if (out.length >= 24) return out;
      }
    }
    return out.length ? out : [{}];
  }
  function immediateMegaAfter(s, action) {
    const c = E.clone(s), r = E.applyAction(c, action);
    return !!(r.ok && E.megaEvolveOptions(c, c.players[c.turn]).length);
  }
  function captureActions(s, p, id, cfg) {
    const card = s.byId[id]; if (!card) return [];
    if (E.isPokemart(card) && card.effect === 'discard_buy') {
      const ep = card.effectParam, owned = p.board.filter(bid => E.effBonusColor(s, p, bid) === ep.discardColor);
      owned.sort((a, b) => sacrificeValue(s, a) - sacrificeValue(s, b) || String(a).localeCompare(String(b)));
      return combinations(owned, ep.discardCount, 96)
        .sort((a, b) => a.reduce((v, x) => v + sacrificeValue(s, x), 0) - b.reduce((v, x) => v + sacrificeValue(s, x), 0))
        .slice(0, 24)
        .map(discardCards => ({ type: 'capture', cardId: id, opts: { discardCards } }));
    }
    const spendInfo = pokedexSpends(s, p, card, cfg); if (spendInfo === null) return [];
    const assoc = (card.effect === 'copy' || card.effect === 'copy_free') ? copyTargets(s, p) : [null];
    if (!assoc.length) return [];
    const free = (card.effect === 'free' || card.effect === 'copy_free') ? freePlans(s, p, card) : [{}];
    const required = [], proactive = [];
    for (let si = 0; si < spendInfo.plans.length; si++) {
      const spend = spendInfo.plans[si], isProactive = spend.length > spendInfo.required;
      for (const target of assoc) for (const fp of free) {
        const opts = Object.assign({}, spend.length ? { spendPokedex: spend } : {}, fp);
        if (target) opts.copyTargetId = target;
        const action = { type: 'capture', cardId: id, opts };
        if (isProactive) {
          if (proactive.length < 8 && immediateMegaAfter(s, action)) proactive.push(action);
        } else if (required.length < 32) required.push(action);
      }
    }
    // Keep the normal action space intact while reserving a small explicit beam
    // for purple-preserving lines; otherwise a 24-way free chain can crowd them out.
    return required.concat(proactive);
  }
  function legalActions(s, cfg) {
    if (!s || s.phase !== 'play' || s.acted) return [];
    cfg = cfg || DIFF.hard;
    const p = s.players[s.turn];
    const acts = E.legalActions(s).filter(a => a.type !== 'capture');
    if (s.megasEnabled && p.megaToken < 1 && s.supply.megaToken > 0 && !acts.some(a => a.type === 'takeMega'))
      acts.push({ type: 'takeMega' });
    const ids = [];
    for (const tier of actionTiers(s)) for (const id of (s.field[tier] || [])) if (id) ids.push(id);
    for (const id of p.reserve) ids.push(id);
    for (const id of ids) acts.push(...captureActions(s, p, id, cfg));
    return acts;
  }

  // ---- best end-of-turn evolution (by static eval) on a clone ----
  function bestEvolution(s, pid, cfg) {
    const opts = E.evolutionOptions(s, s.players[pid]);
    if (!opts.length) return null;
    const base = evalState(s, pid, null);
    let best = null, bestScore = base;
    for (const o of opts) {
      const c = E.clone(s);
      const r = E.actionEvolve(c, o.fromId, o.toId);
      if (!r.ok) continue;
      const route = megaEvolutionRouteBonus(s, pid, o.toId);
      const sc = evalState(c, pid, null) + (cfg ? cfg.evoBias : 1) * 8 + route; // small intrinsic bonus: free VP/action
      if (sc > bestScore) { bestScore = sc; best = o; }
    }
    return best;
  }
  // score a full line: state already has the main action applied; manage
  // discards + evolution on a clone and return the resulting eval.
  function scoreLine(s, pid, cfg) {
    const c = E.clone(s);
    const neededFirstMega = c.megasEnabled && !c.players[pid].board.some(id => c.byId[id].tier === 'mega');
    manage(c, cfg);
    const completedFirstMega = neededFirstMega && c.players[pid].board.some(id => c.byId[id].tier === 'mega');
    const triggered = winningPosition(c, c.players[pid]);
    const r = E.endTurn(c);
    let score = evalState(c, pid, cfg);
    // An action that satisfies the full victory condition is qualitatively
    // different from merely gaining more VP.  This is especially important in
    // Mega mode, where 30 points without a Mega still cannot end the game.
    if (triggered) score += 100000;
    // `manage` treats the first Mega as a contested, binary qualification
    // objective. Mirror that priority in root scoring so a setup action that
    // unlocks the first Mega is not rejected merely because it spends/buries
    // more material than an ordinary capture.
    if (completedFirstMega) score += 10000;
    if (r && r.gameover) score += c.winner === pid ? 1000000 : -1000000;
    // Once the final round has begun, merely crossing the trigger no longer
    // ends the game early.  Avoid paying a large tactical penalty for a threat
    // that the normal score/denial evaluation already represents correctly.
    else if ((!c.lastRound || cfg.blockFinalThreats) && !c.megasEnabled)
      score -= immediateWinThreats(c, pid) * 260;
    return score;
  }

  // ---- best end-of-turn MEGA evolution (Megas expansion; shares the one
  // evolution-per-turn slot with normal evolution — manage() picks the better).
  function bestMegaEvolution(s, pid, cfg) {
    if (!s.megasEnabled) return null;
    const opts = E.megaEvolveOptions(s, s.players[pid]);
    if (!opts.length) return null;
    let best = null, bestScore = -Infinity;
    for (const o of opts) {
      const c = E.clone(s);
      const r = E.actionMegaEvolve(c, o.megaId, o.fromId);
      if (!r.ok) continue;
      const sc = evalState(c, pid, null) + (cfg ? cfg.evoBias : 1) * 8;
      if (sc > bestScore) { bestScore = sc; best = o; }
    }
    return best ? { opt: best, score: bestScore } : null;
  }

  // perform end-of-turn management (discard to 10, then best evolution) on `s`.
  // returns { discards:[color], evolution:{fromId,toId}|null, megaEvolution:{megaId,fromId}|null }
  function manage(s, cfg) {
    const pid = s.turn;
    const p = s.players[pid];
    const plan = { discards: [], evolution: null, megaEvolution: null };
    // discard greedily, choosing the color whose removal best preserves value
    while (E.needsDiscard(s, p)) {
      let bestColor = null, bestScore = -Infinity;
      for (const col of ALL_TOKENS) {
        if (!p.tokens[col]) continue;
        const c = E.clone(s);
        c.players[pid].tokens[col]--; c.supply[col]++;
        // value the resulting position *including* the evolution we could still do
        const sc = evalWithEvo(c, pid, cfg);
        if (sc > bestScore) { bestScore = sc; bestColor = col; }
      }
      if (bestColor == null) break;
      E.actionDiscard(s, bestColor); plan.discards.push(bestColor);
    }
    // one evolution per turn: normal vs MEGA. The FIRST Mega is a hard priority:
    // it is a win-condition requirement and the offer is contested — a greedy
    // per-turn eval keeps deferring it (pays balls now, buries the base) and ends
    // up out-scoring yet UNQUALIFIED. Once a Mega is owned, compare by eval.
    const evo = bestEvolution(s, pid, cfg);
    const mega = bestMegaEvolution(s, pid, cfg);
    let useMega = false;
    if (mega) {
      const ownsMega = p.board.some(id => s.byId[id].tier === 'mega');
      if (!ownsMega || !evo) useMega = true;
      else {
        const c = E.clone(s); E.actionEvolve(c, evo.fromId, evo.toId);
        useMega = mega.score > evalState(c, pid, null) + (cfg ? cfg.evoBias : 1) * 8;
      }
    }
    if (useMega) {
      E.actionMegaEvolve(s, mega.opt.megaId, mega.opt.fromId);
      plan.megaEvolution = { megaId: mega.opt.megaId, fromId: mega.opt.fromId };
    } else if (evo) {
      E.actionEvolve(s, evo.fromId, evo.toId); plan.evolution = { fromId: evo.fromId, toId: evo.toId };
    }
    return plan;
  }

  function evalWithEvo(s, pid, cfg) {
    let best = evalState(s, pid, cfg);
    const evo = bestEvolution(s, pid, cfg);
    if (evo) {
      const c = E.clone(s); E.actionEvolve(c, evo.fromId, evo.toId);
      best = Math.max(best, evalState(c, pid, cfg) + (winningPosition(c, c.players[pid]) ? 100000 : 0));
    }
    const mega = bestMegaEvolution(s, pid, cfg);
    if (mega) {
      const c = E.clone(s); E.actionMegaEvolve(c, mega.opt.megaId, mega.opt.fromId);
      best = Math.max(best, evalState(c, pid, cfg) + (winningPosition(c, c.players[pid]) ? 100000 : 0));
    }
    return best;
  }

  function megaEvolutionRouteBonus(s, pid, toId) {
    if (!s.megasEnabled) return 0;
    const p = s.players[pid];
    if (p.board.some(id => s.byId[id].tier === 'mega')) return 0;
    const target = s.byId[toId];
    if (!s.megaOffer.some(id => s.byId[id].megaFrom === target.name)) return 0;
    const vp = E.scoreOf(s, p), b = E.bonuses(s, p);
    const readyToFinishRoute = vp >= 16 || COLORS.every(c => b[c] > 0);
    return readyToFinishRoute ? 25 : 10;
  }

  function winningPosition(s, p) {
    if (!s.megasEnabled) return E.scoreOf(s, p) >= (s.winScore || E.WIN_SCORE);
    if (E.scoreOf(s, p) < E.MEGA_WIN_SCORE) return false;
    const b = E.bonuses(s, p);
    return COLORS.every(c => b[c] > 0) && p.board.some(id => s.byId[id].tier === 'mega');
  }

  // Public, one-turn threat model used after each candidate line.  It checks the
  // guide's two common finishes together: buy a scoring card, and use the free
  // end-of-turn evolution window.  Opponents' hidden reserves are intentionally
  // excluded; only visible information may influence the decision.
  function immediateWinThreats(s, pid) {
    const target = s.winScore || E.WIN_SCORE;
    let threats = 0;
    for (let q = 0; q < s.numPlayers; q++) {
      if (q === pid) continue;
      const op = s.players[q], vp = E.scoreOf(s, op), b = E.bonuses(s, op);
      let captureGain = 0, evolutionGain = 0;
      for (const tier of FIELD_TIERS) for (const id of (s.field[tier] || [])) {
        if (!id) continue;
        const card = s.byId[id];
        if (E.canAfford(s, op, card)) captureGain = Math.max(captureGain, card.vp || 0);
        for (const fromId of op.board) {
          const from = s.byId[fromId];
          if (!from.evolvesTo || !from.evoCost || from.evolvesTo !== card.name) continue;
          if (b[from.evoCost.color] >= from.evoCost.count)
            evolutionGain = Math.max(evolutionGain, Math.max(0, (card.vp || 0) - (from.vp || 0)));
        }
      }
      if (vp + captureGain + evolutionGain >= target) threats++;
    }
    return threats;
  }

  function strategyActionBonus(s, a, pid) {
    if (!a || a.type !== 'capture') return 0;
    const p = s.players[pid], card = s.byId[a.cardId];
    if (!card || E.isPokemart(card)) return 0;
    let value = 0;
    const owned = new Set(p.board.map(id => s.byId[id].name));
    const visible = new Set();
    for (const tier of FIELD_TIERS) for (const id of (s.field[tier] || [])) if (id) visible.add(s.byId[id].name);
    for (const pair of ROUTE_PAIRS) {
      if (card.name === pair[0] && owned.has(pair[1])) value += pair[2];
      else if (card.name === pair[1] && owned.has(pair[0])) value += pair[2];
      else if (card.name === pair[0] && visible.has(pair[1])) value += pair[2] * 0.25;
      else if (card.name === pair[1] && visible.has(pair[0])) value += pair[2] * 0.25;
    }
    return value;
  }

  function publicHash(s, pid, salt) {
    let h = (2166136261 ^ (salt || 0)) >>> 0;
    function add(v) {
      const str = String(v == null ? '' : v);
      for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    }
    add(s.round); add(s.turn); add(pid); add(s.phase); add(s.lastRound);
    for (const c of ALL_TOKENS) add(s.supply[c]);
    for (const tier of actionTiers(s)) {
      add(tier); for (const id of (s.field[tier] || [])) add(id || '-');
    }
    for (let q = 0; q < s.numPlayers; q++) {
      const p = s.players[q]; add(q);
      for (const c of ALL_TOKENS) add(p.tokens[c]);
      for (const id of p.board) add(id);
      for (const id of p.buried) add(id);
      if (q === pid) for (const id of p.reserve) add(id);
      else for (const id of p.reserve) add((s.byId[id] || {}).tier || 'hidden');
    }
    for (const id of (s.megaOffer || [])) add(id);
    return h >>> 0;
  }

  // Build a reproducible information-set sample.  Visible cards and the acting
  // player's own reserve stay fixed; ordered decks and opponents' hidden reserve
  // identities are pooled by tier, sorted, then re-dealt.  Sorting before the
  // shuffle makes the result invariant to the engine's real hidden order.
  function beliefState(s, pid, salt) {
    const d = E.clone(s), base = publicHash(s, pid, salt);
    for (const tier of actionTiers(d)) {
      const pool = (d.decks[tier] || []).filter(id => typeof id === 'string');
      const slots = [];
      for (let q = 0; q < d.numPlayers; q++) {
        if (q === pid) continue;
        for (let i = 0; i < d.players[q].reserve.length; i++) {
          const id = d.players[q].reserve[i], card = d.byId[id];
          if (card && card.tier === tier) { pool.push(id); slots.push([q, i]); }
        }
      }
      pool.sort();
      let th = 2166136261;
      for (let i = 0; i < tier.length; i++) { th ^= tier.charCodeAt(i); th = Math.imul(th, 16777619); }
      E.shuffle(pool, E.makeRng((base ^ th) >>> 0));
      for (const slot of slots) d.players[slot[0]].reserve[slot[1]] = pool.pop();
      d.decks[tier] = pool;
    }
    return d;
  }

  // ---- choose the whole turn (1-ply eval search) ----
  function chooseTurn(s, opts) {
    opts = opts || {};
    const cfg = Object.assign({}, DIFF[opts.difficulty || 'hard'], opts.config || {});
    const pid = s.turn;
    const acts = legalActions(s, cfg);
    if (!acts.length) return { action: null, discards: [], evolution: null };

    // deterministic-ish noise per call (so 'easy' varies without Math.random in engine)
    let seed = (s.round * 131 + s.turn * 17 + acts.length * 7) >>> 0;
    E._noise = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed / 4294967296) - 0.5; };

    // Mega discipline (1-ply only; the deep search handles this via lookahead):
    // qualification is BINARY — without a Mega you cannot win at all, and the offer
    // is contested. A greedy eval always prefers "one more capture" and defers the
    // Mega forever, so the FIRST Mega is an OVERRIDE, not an eval competitor:
    // the moment a Mega we own the base of is affordable, spend the turn on the
    // token (manage() then mega-evolves the same turn). Mirrors the policy that
    // play-tested strongest; further Megas compete on eval like everything else.
    const pMe = s.players[pid];
    if (s.megasEnabled && !pMe.board.some(id => s.byId[id].tier === 'mega')) {
      const tokenAct = acts.find(a => a.type === 'takeMega');
      if (tokenAct) {
        for (const mid of (s.megaOffer || [])) {
          const m = s.byId[mid];
          if (pMe.board.some(id => s.byId[id].name === m.megaFrom) && E.canAfford(s, pMe, m)) {
            E._noise = null;
            const c0 = E.clone(s); E.applyAction(c0, tokenAct);
            const mp0 = manage(c0, cfg);
            return { action: tokenAct, discards: mp0.discards, evolution: mp0.evolution, megaEvolution: mp0.megaEvolution };
          }
        }
      }
    }
    const views = [], beliefCount = opts.beliefs != null ? opts.beliefs : cfg.beliefs;
    for (let i = 0; i < Math.max(1, beliefCount || 1); i++) views.push(beliefState(s, pid, i + 1));
    let best = null, bestScore = -Infinity;
    for (const a of acts) {
      if (a.type === 'takeMega') continue;   // token-taking is handled by the override above
      let total = 0, valid = true;
      for (const view of views) {
        const c = E.clone(view);
        const r = E.applyAction(c, a);
        if (!r.ok) { valid = false; break; }
        total += scoreLine(c, pid, cfg);
      }
      if (!valid) continue;
      const sc = total / views.length + strategyActionBonus(s, a, pid);
      if (sc > bestScore) { bestScore = sc; best = a; }
    }
    E._noise = null;
    if (!best) best = acts[0];

    // recompute the concrete discard + evolution plan on the real chosen line
    const c = E.clone(s);
    E.applyAction(c, best);
    const mp = manage(c, cfg);
    return { action: best, discards: mp.discards, evolution: mp.evolution, megaEvolution: mp.megaEvolution };
  }

  // ---- apply a chosen plan to the live state (used headless; UI animates) ----
  function playTurn(s, opts) {
    const plan = chooseTurn(s, opts);
    if (plan.action) E.applyAction(s, plan.action);
    else E.actionPass(s); // no legal main action available
    for (const col of plan.discards) E.actionDiscard(s, col);
    if (plan.megaEvolution) E.actionMegaEvolve(s, plan.megaEvolution.megaId, plan.megaEvolution.fromId);
    else if (plan.evolution) E.actionEvolve(s, plan.evolution.fromId, plan.evolution.toId);
    const r = E.endTurn(s);
    return { plan, endTurn: r };
  }

  return { chooseTurn, playTurn, evalState, bestEvolution, bestMegaEvolution, manage, legalActions, beliefState, publicHash, DIFF,
           DEFAULT_W, getWeights: () => Object.assign({}, W),
           setWeights: (w) => { W = Object.assign({}, DEFAULT_W, w); } };
});
