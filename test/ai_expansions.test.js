/* AI expansion + information-set regression tests.
 * Run from the repository root: node test/ai_expansions.test.js */
const assert = require('assert');
const E = require('../js/engine.js');
const AI = require('../js/ai.js');
const VS = require('../js/vsearch.js');
const DB = require('../data/cards.json');
const PM = require('../data/pokemart.json');
const MEGA = require('../data/megas.json');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.stack); }
}
const game = (opts) => E.createGame(DB, Object.assign({ numPlayers: 2, seed: 7123 }, opts || {}));
function loadTokens(p, n) { for (const c of E.ALL_TOKENS) p.tokens[c] = n; }
function place(g, card, slot) {
  for (const tier in g.field) for (let i = 0; i < g.field[tier].length; i++)
    if (g.field[tier][i] === card.id) g.field[tier][i] = null;
  for (const tier in g.decks) g.decks[tier] = g.decks[tier].filter(id => id !== card.id);
  g.field[card.tier][slot || 0] = card.id;
}
function giveCard(g, p, card) {
  for (const tier in g.field) for (let i = 0; i < g.field[tier].length; i++)
    if (g.field[tier][i] === card.id) g.field[tier][i] = null;
  for (const tier in g.decks) g.decks[tier] = g.decks[tier].filter(id => id !== card.id);
  if (!p.board.includes(card.id)) p.board.push(card.id);
}
function applyChecked(g, plan) {
  const main = plan.action ? E.applyAction(g, plan.action) : E.actionPass(g);
  assert.ok(main && main.ok, 'illegal AI main action: ' + JSON.stringify(plan.action) + ' / ' + JSON.stringify(main));
  for (const c of plan.discards || []) if (E.needsDiscard(g, g.players[g.turn]))
    assert.ok(E.actionDiscard(g, c).ok, 'illegal discard ' + c);
  if (!g.evolvedThisTurn && plan.megaEvolution)
    assert.ok(E.actionMegaEvolve(g, plan.megaEvolution.megaId, plan.megaEvolution.fromId).ok, 'illegal Mega evolution');
  if (!g.evolvedThisTurn && plan.evolution)
    assert.ok(E.actionEvolve(g, plan.evolution.fromId, plan.evolution.toId).ok, 'illegal evolution');
  const end = E.endTurn(g); assert.ok(end.ok, 'turn did not end');
}

test('AI action enumeration stops after the main action, including Mega mode', () => {
  const g = game({ megas: true, megaDB: MEGA });
  g.acted = true;
  assert.deepStrictEqual(AI.legalActions(g), []);
});

test('engine pass validation treats taking a Mega token as a legal main action', () => {
  const g = game({ megas: true, megaDB: MEGA }), p = g.players[0];
  for (const c of E.ALL_TOKENS) { g.supply[c] = 0; p.tokens[c] = 0; }
  p.reserve = DB.filter(c => c.tier === 'stage3').slice(0, 3).map(c => c.id);
  const actions = E.legalActions(g);
  assert.deepStrictEqual(new Set(actions.map(a => a.type)), new Set(['takeMega']));
  assert.ok(!E.actionPass(g).ok, 'cannot pass while a Mega token is available');
});

test('AI spends a POKÉDEX when it unlocks an otherwise unaffordable capture', () => {
  const g = game({ pokemart: true, pokemartDB: PM }), p = g.players[0];
  const dex = PM.find(c => c.effect === 'colorless_master');
  giveCard(g, p, dex);
  const target = g.byId[g.field.stage1[0]];
  for (const c of E.ALL_TOKENS) p.tokens[c] = 0;
  let remove = 2;
  for (const c of E.COLORS) {
    p.tokens[c] = target.cost[c] || 0;
    const n = Math.min(remove, p.tokens[c]); p.tokens[c] -= n; remove -= n;
  }
  assert.ok(remove === 0 && !E.canAfford(g, p, target), 'fixture has an exact two-ball gap');
  const action = AI.legalActions(g).find(a => a.type === 'capture' && a.cardId === target.id &&
    a.opts && a.opts.spendPokedex && a.opts.spendPokedex.includes(dex.id));
  assert.ok(action, 'Pokedex-funded action enumerated');
  const c = E.clone(g), r = E.applyAction(c, action);
  assert.ok(r.ok, r.error); assert.ok(c.players[0].board.includes(target.id));
  assert.ok(!c.players[0].board.includes(dex.id), 'Pokedex consumed');
  const fallback = E.legalActions(g).find(a => a.type === 'capture' && a.cardId === target.id);
  assert.ok(fallback && fallback.opts.spendPokedex.length === 1, 'engine fallback is fully parameterised too');
});

test('hard AI can spend an affordable POKÉDEX to preserve Master Ball for an immediate Mega', () => {
  const g = game({ pokemart: true, pokemartDB: PM, megas: true, megaDB: MEGA }), p = g.players[0];
  const dex = PM.find(c => c.effect === 'colorless_master');
  const mega = MEGA.find(c => c.id === 'mg_08');
  const base = DB.find(c => c.name === mega.megaFrom);
  const target = DB.find(c => c.id === 's1_08'); // yellow bonus; costs 2 red + 1 pink
  giveCard(g, p, dex); giveCard(g, p, base); place(g, target);
  p.megaToken = 1; g.supply.megaToken--;
  for (const c of E.ALL_TOKENS) p.tokens[c] = 0;
  for (const [color, count] of [['red', 2], ['yellow', 3], ['purple', 1]]) {
    p.tokens[color] = count; g.supply[color] -= count;
  }

  assert.ok(E.canAfford(g, p, target), 'target is already affordable without the Pokedex');
  assert.ok(!E.megaEvolveOptions(g, p).some(o => o.megaId === mega.id), 'Mega is not affordable before capture');
  const actions = AI.legalActions(g).filter(a => a.type === 'capture' && a.cardId === target.id);
  const normal = actions.find(a => !(a.opts.spendPokedex || []).length);
  const proactive = actions.find(a => (a.opts.spendPokedex || []).includes(dex.id));
  assert.ok(normal && proactive, 'AI compares normal payment with proactive Pokedex spending');
  assert.ok(!AI.legalActions(g, AI.DIFF.normal).some(a => a.type === 'capture' && a.cardId === target.id &&
    (a.opts.spendPokedex || []).length), 'normal AI keeps the simpler minimum-payment action space');

  const withoutDex = E.clone(g);
  assert.ok(E.applyAction(withoutDex, normal).ok);
  assert.strictEqual(withoutDex.players[0].tokens.purple, 0, 'normal payment consumes the only Master Ball');
  assert.ok(!E.megaEvolveOptions(withoutDex, withoutDex.players[0]).some(o => o.megaId === mega.id));

  const withDex = E.clone(g);
  assert.ok(E.applyAction(withDex, proactive).ok);
  assert.strictEqual(withDex.players[0].tokens.purple, 1, 'Pokedex payment preserves the Master Ball');
  assert.ok(!withDex.players[0].board.includes(dex.id), 'spent Pokedex is discarded');
  const option = E.megaEvolveOptions(withDex, withDex.players[0]).find(o => o.megaId === mega.id);
  assert.ok(option, 'new yellow bonus plus the preserved Master Ball unlocks Mega evolution');
  assert.ok(E.actionMegaEvolve(withDex, option.megaId, option.fromId).ok, 'the full capture-to-Mega line is legal');

  // Isolate the two payment variants and verify the planner selects the whole
  // capture -> Mega line, not merely that the low-level action exists.
  for (const tier in g.field) for (let i = 0; i < g.field[tier].length; i++)
    if (g.field[tier][i] !== target.id) g.field[tier][i] = null;
  for (const tier in g.decks) g.decks[tier] = [];
  for (const color of E.ALL_TOKENS) g.supply[color] = 0;
  const plan = AI.chooseTurn(g, { difficulty: 'hard' });
  assert.strictEqual(plan.action.cardId, target.id);
  assert.ok(plan.action.opts.spendPokedex.includes(dex.id), 'hard AI proactively spends the Pokedex');
  assert.ok(plan.megaEvolution && plan.megaEvolution.megaId === mega.id, 'hard AI completes the unlocked Mega');
});

test('AI compares every distinct TM association colour', () => {
  const g = game({ pokemart: true, pokemartDB: PM }), p = g.players[0];
  giveCard(g, p, DB.find(c => c.bonus === 'red'));
  giveCard(g, p, DB.find(c => c.bonus === 'blue'));
  loadTokens(p, 10);
  const tm = PM.find(c => c.effect === 'copy'); place(g, tm);
  const actions = AI.legalActions(g).filter(a => a.type === 'capture' && a.cardId === tm.id);
  const colors = new Set(actions.map(a => E.effBonusColor(g, p, a.opts.copyTargetId)));
  assert.ok(colors.has('red') && colors.has('blue'), 'red and blue association options present');
  for (const a of actions) assert.ok(E.applyAction(E.clone(g), a).ok, 'copy option is executable');
});

test('AI enumerates and executes TM → Rare Candy → Level-1 free chain', () => {
  const g = game({ pokemart: true, pokemartDB: PM }), p = g.players[0];
  giveCard(g, p, DB.find(c => c.bonus === 'red')); loadTokens(p, 10);
  const tm = PM.find(c => c.effect === 'free');
  const candy = PM.find(c => c.effect === 'copy_free');
  place(g, tm); place(g, candy);
  const leaf = g.field.stage1.find(Boolean);
  const action = AI.legalActions(g).find(a => a.type === 'capture' && a.cardId === tm.id &&
    a.opts && a.opts.freeTakeId === candy.id && a.opts.freeOpts && a.opts.freeOpts.freeTakeId === leaf);
  assert.ok(action, 'recursive free plan enumerated');
  const c = E.clone(g), r = E.applyAction(c, action);
  assert.ok(r.ok, r.error);
  assert.ok([tm.id, candy.id, leaf].every(id => c.players[0].board.includes(id)), 'full chain captured');
  const fallback = E.legalActions(g).find(a => a.type === 'capture' && a.cardId === tm.id);
  assert.ok(fallback && fallback.opts && fallback.opts.freeTakeId, 'engine fallback includes a free-card choice');
  assert.ok(E.applyAction(E.clone(g), fallback).ok, 'engine fallback chain is executable');
});

test('REPEL planner includes the lowest-opportunity-cost discard pair', () => {
  const g = game({ pokemart: true, pokemartDB: PM }), p = g.players[0];
  const repel = PM.find(c => c.effect === 'discard_buy'); place(g, repel);
  const color = repel.effectParam.discardColor;
  const cards = DB.filter(c => c.bonus === color).sort((a, b) => (b.vp || 0) - (a.vp || 0));
  p.board = cards.map(c => c.id);
  const low = cards.slice().sort((a, b) => (a.vp || 0) - (b.vp || 0)).slice(0, 2).map(c => c.id);
  const actions = AI.legalActions(g).filter(a => a.type === 'capture' && a.cardId === repel.id);
  assert.ok(actions.some(a => low.every(id => a.opts.discardCards.includes(id))), 'lowest-VP pair survives beam limit');
});

test('AI takes a Mega and evolves immediately when that completes the win condition', () => {
  const g = game({ megas: true, megaDB: MEGA }), p = g.players[0];
  p.board = [];
  const mega = MEGA.find(m => DB.some(c => c.name === m.megaFrom));
  const base = DB.find(c => c.name === mega.megaFrom); giveCard(g, p, base);
  for (const color of E.COLORS) {
    const card = DB.filter(c => c.bonus === color && c.id !== base.id).sort((a, b) => (b.vp || 0) - (a.vp || 0))[0];
    giveCard(g, p, card);
  }
  const high = DB.slice().sort((a, b) => (b.vp || 0) - (a.vp || 0));
  let i = 0; while (E.scoreOf(g, p) < E.MEGA_WIN_SCORE) giveCard(g, p, high[i++]);
  for (const c of E.ALL_TOKENS) p.tokens[c] = mega.cost[c] || 0;
  const plan = AI.chooseTurn(g, { difficulty: 'hard', beliefs: 2 });
  assert.strictEqual(plan.action.type, 'takeMega');
  assert.ok(plan.megaEvolution && plan.megaEvolution.megaId === mega.id, 'winning Mega evolution planned');
  applyChecked(g, plan);
  assert.strictEqual(g.lastRound, true, 'full Mega win condition triggers final round');
});

test('hard AI decisions are invariant to the real hidden deck order', () => {
  const g = game({ numPlayers: 4, seed: 88021 });
  for (let i = 0; i < 10; i++) applyChecked(g, AI.chooseTurn(g, { difficulty: 'hard' }));
  const reversed = E.clone(g);
  for (const tier of E.fieldTiers(reversed)) reversed.decks[tier].reverse();
  assert.deepStrictEqual(AI.chooseTurn(g, { difficulty: 'hard' }), AI.chooseTurn(reversed, { difficulty: 'hard' }));
  const sample = AI.beliefState(g, g.turn, 1);
  for (let q = 0; q < g.numPlayers; q++) assert.strictEqual(sample.players[q].reserve.length, g.players[q].reserve.length);
});

test('VSearch is reproducible and handles a forced-pass child without crashing', () => {
  const normal = game({ seed: 9311 });
  const cfg = { sims: 24, dets: 2, adaptive: false };
  assert.deepStrictEqual(VS.chooseTurn(normal, cfg), VS.chooseTurn(normal, cfg), 'same position, same search result');

  const g = game({ seed: 9412 }); g.winScore = 999;
  for (const c of E.ALL_TOKENS) { g.supply[c] = 0; g.players[0].tokens[c] = 0; g.players[1].tokens[c] = 0; }
  const reserve = DB.filter(c => c.tier === 'stage3').slice(0, 6).map(c => c.id);
  g.players[0].reserve = reserve.slice(0, 3); g.players[1].reserve = reserve.slice(3, 6);
  for (const color of E.COLORS) for (const card of DB.filter(c => c.bonus === color).slice(0, 6))
    if (!g.players[0].board.includes(card.id)) g.players[0].board.push(card.id);
  assert.ok(AI.legalActions(g).length > 0, 'root has captures');
  assert.doesNotThrow(() => VS.chooseTurn(g, { sims: 40, dets: 1, adaptive: false }));
});

test('AI completes every expansion mode for 2/3/4 players with no illegal plans', () => {
  const modes = [
    { name: 'Pokemart', opts: { pokemart: true, pokemartDB: PM } },
    { name: 'Mega', opts: { megas: true, megaDB: MEGA } },
    { name: 'Pokemart+Mega', opts: { pokemart: true, pokemartDB: PM, megas: true, megaDB: MEGA } },
  ];
  for (const mode of modes) for (const np of [2, 3, 4]) {
    const g = game(Object.assign({ numPlayers: np, seed: 99000 + np * 10 + (mode.name === 'Mega' ? 1 : 0) }, mode.opts));
    let plies = 0;
    while (g.phase !== 'gameover' && plies++ < 1200) applyChecked(g, AI.chooseTurn(g, { difficulty: 'hard' }));
    assert.strictEqual(g.phase, 'gameover', `${mode.name} ${np}p finished`);
    if (mode.opts.megas) {
      const w = g.players[g.winner], b = E.bonuses(g, w);
      assert.ok(E.scoreOf(g, w) >= E.MEGA_WIN_SCORE && E.COLORS.every(c => b[c] > 0));
      assert.ok(w.board.some(id => g.byId[id].tier === 'mega'), 'winner owns a Mega');
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
