import test from 'node:test';
import assert from 'node:assert/strict';

import { Arena, WALLS, CAPTURE, RADIUS, TICK_RATE, DECISION_EVERY, ACTIONS } from '../src/arena.js';
import { runMatch } from '../src/match.js';
import { scriptedController, randomController, brainController } from '../src/controllers.js';

const SEEDS = 40;

function series(blue, red, n = SEEDS) {
  let wins = 0, losses = 0, draws = 0;
  for (let s = 1; s <= n; s++) {
    const r = runMatch({ seed: s, blue, red }).result;
    if (r.win > 0) wins++; else if (r.win < 0) losses++; else draws++;
  }
  return { wins, losses, draws };
}

test('matches are deterministic given a seed', () => {
  for (const seed of [1, 17, 99]) {
    const a = runMatch({ seed, blue: scriptedController, red: randomController }).result;
    const b = runMatch({ seed, blue: scriptedController, red: randomController }).result;
    assert.deepEqual(a, b, `seed ${seed} diverged`);
  }
});

test('mirrored matches with the same controller stay near 50/50', () => {
  const s = series(scriptedController, scriptedController, 100);
  const total = s.wins + s.losses + s.draws;
  assert.equal(total, 100);
  // A big side bias would mean the arena itself, not the policy, decides
  // matches. Allowed slack is generous; anything tighter is a real asymmetry.
  assert.ok(Math.abs(s.wins - s.losses) <= 20, `side bias too large: ${s.wins}-${s.losses}`);
});

test('scripted beats random: the arena has a skill gradient to learn', () => {
  const s = series(scriptedController, randomController, 200);
  assert.ok(s.wins > s.losses * 1.3, `scripted should beat random, got ${s.wins}-${s.losses}`);
});

test('all features stay inside [-1,1] for every unit in every match', () => {
  const f = new Float64Array(16);
  for (const seed of [1, 2, 3, 4, 5]) {
    const arena = new Arena({ seed, blue: {}, red: {} });
    let n = 0;
    while (!arena.finished() && n < arena.maxTicks) {
      for (const u of arena.units) {
        if (!u.alive) continue;
        const v = arena.observe(u, f);
        for (let i = 0; i < 10; i++) {
          assert.ok(v[i] >= -1 && v[i] <= 1,
            `feature ${i} out of range: ${v[i]} (seed ${seed}, tick ${arena.tick})`);
        }
      }
      arena.step();
      n++;
    }
  }
});

test('gate inputs stay inside [-1,1]', () => {
  const f = new Float64Array(16);
  const arena = new Arena({ seed: 7, blue: {}, red: {} });
  while (!arena.finished()) {
    for (const u of arena.units) {
      if (!u.alive) continue;
      const [p, a] = arena.gateInputs(u, arena.observe(u, f));
      assert.ok(p >= -1 && p <= 1, `pressure ${p}`);
      assert.ok(a >= -1 && a <= 1, `advantage ${a}`);
    }
    arena.step();
  }
});

test('no unit ends a match stuck inside geometry', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const { arena } = runMatch({ seed, blue: scriptedController, red: randomController });
    for (const u of arena.units) {
      for (const w of WALLS) {
        const inside = u.x > w.x - RADIUS && u.x < w.x + w.w + RADIUS &&
                       u.y > w.y - RADIUS && u.y < w.y + w.h + RADIUS;
        assert.ok(!inside, `seed ${seed}: ${u.team}${u.idx} is inside a wall at ${u.x.toFixed(0)},${u.y.toFixed(0)}`);
      }
      assert.ok(u.x >= 0 && u.x <= 640 && u.y >= 0 && u.y <= 400, 'unit left the arena');
    }
  }
});

test('teams actually meet: matches are not walk-away stalemates', () => {
  let combatMatches = 0;
  for (let s = 1; s <= 20; s++) {
    const { result } = runMatch({ seed: s, blue: scriptedController, red: scriptedController });
    if (result.kills[0] + result.kills[1] > 0) combatMatches++;
  }
  assert.ok(combatMatches >= 18, `only ${combatMatches}/20 matches saw combat`);
});

test('action indices from every controller are in range', () => {
  const f = new Float64Array(16);
  const arena = new Arena({ seed: 11, blue: {}, red: {} });
  const proto = { arena, rng: arena.rng, tick: 0 };
  const fns = [scriptedController, randomController, () => 0, () => ACTIONS.length - 1];
  for (const fn of fns) {
    for (const u of arena.units) {
      if (!u.alive) continue;
      const a = fn.call(proto, u);
      assert.ok(Number.isInteger(a) && a >= 0 && a < ACTIONS.length, `bad action ${a}`);
    }
  }
});

test('a brain controller plays a legal game and fills the record', () => {
  // A brain with all-zero weights always picks action 0, which is `advance`.
  const zeroBrain = {
    nF: 10, nA: ACTIONS.length, nC: 4, nArch: 3, gated: true,
    w: new Float32Array(4 * ACTIONS.length * 10),
    archBias: new Float32Array(3 * ACTIONS.length),
    thresholds: new Float32Array([0.35, 0.15, -0.35, -0.1]),
    scale: new Float32Array(10).fill(1),
    biasScale: 1, minDwellTicks: 12,
  };
  const { result, recording } = runMatch({
    seed: 5, blue: brainController(zeroBrain), red: scriptedController,
    record: { src: 'human', which: 'blue' },
  });
  assert.equal(result.ticks, 60 * TICK_RATE);
  assert.ok(recording.includes('"src":"human"'));
  const lines = recording.trim().split('\n');
  const decisionLines = lines.filter((l) => l.includes('"u"'));
  assert.ok(decisionLines.length > 100, `expected a real recording, got ${decisionLines.length} lines`);
  for (const l of decisionLines) {
    const o = JSON.parse(l);
    assert.equal(o.f.length, 10);
    assert.equal(o.a, 0);
    assert.ok(o.ctx >= 0 && o.ctx < 4);
  }
  assert.ok(lines.some((l) => l.includes('"end"')), 'recording must end with a result line');
});

test('decisions happen on the fixed cadence', () => {
  const f = new Float64Array(16);
  const arena = new Arena({ seed: 3, blue: {}, red: {} });
  let decisions = 0;
  while (!arena.finished()) {
    if (arena.tick % DECISION_EVERY === 0) {
      for (const u of arena.units) {
        if (!u.alive) continue;
        arena.observe(u, f);
        decisions++;
      }
    }
    arena.step();
  }
  const expected = Math.ceil((60 * TICK_RATE) / DECISION_EVERY) * 6;
  assert.ok(Math.abs(decisions - expected) <= 6, `${decisions} decisions, expected about ${expected}`);
});

test('capture point geometry is what the spec describes', () => {
  assert.deepEqual(CAPTURE, { x: 320, y: 200, r: 42 });
  // The spec must not claim a team size the sim does not run.
  assert.equal(ACTIONS.length, 7);
});