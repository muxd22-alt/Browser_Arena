import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Arena, WALLS, DECOR, NODES, EDGES, BASES, FLAG_HOME, RADIUS,
  TICK_RATE, DECISION_EVERY, ACTIONS, lineOfSight, angleDelta, SPEED, SIGHT,
} from '../src/arena.js';
import { runMatch } from '../src/match.js';
import { scriptedController, randomController, brainController } from '../src/controllers.js';

const N = 40;

function series(blue, red, n = N) {
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

test('the map is fixed, not generated', () => {
  // Every match must start from an identical layout. A trainer that trains on
  // one map and ships on another learns the wrong thing.
  const a = new Arena({ seed: 1, blue: {}, red: {} });
  const b = new Arena({ seed: 999, blue: {}, red: {} });
  for (let i = 0; i < a.units.length; i++) {
    assert.equal(a.units[i].x, b.units[i].x, 'spawn x must not depend on the seed');
    assert.equal(a.units[i].y, b.units[i].y, 'spawn y must not depend on the seed');
  }
  assert.deepEqual(
    [a.flags.blue.x, a.flags.blue.y],
    [b.flags.blue.x, b.flags.blue.y]
  );
  assert.ok(WALLS.length > 0);
  assert.ok(DECOR.length > 0, 'the map needs decoration to read as a place');
});

test('the map is mirror-symmetric about the centre line', () => {
  // Every asymmetry here becomes a permanent, invisible side advantage in the
  // ladder. This is the cheapest possible guard against one sneaking back in.
  const cx = 640 / 2;
  for (const w of WALLS) {
    const mirrored = WALLS.find((o) => Math.abs(o.x + o.w + w.x - 2 * cx) < 0.001 && o.y === w.y && o.h === w.h);
    assert.ok(mirrored, `wall ${JSON.stringify(w)} has no mirror image`);
  }
  assert.deepEqual(BASES.blue.x + BASES.red.x, 2 * cx);
  assert.deepEqual(BASES.blue.y, BASES.red.y);
  assert.deepEqual(FLAG_HOME.blue.x + FLAG_HOME.red.x, 2 * cx);

  // The waypoint graph must mirror too, or one side gets shorter routes.
  const key = (id) => {
    const n = NODES.find((x) => x.id === id);
    return { x: 2 * cx - n.x, y: n.y, id: [...id].reverse().join('') };
  };
  void key;
  const mirrorId = (id) => {
    // Nodes were named <column><row>; the mirror swaps columns A<->E, B<->D.
    const col = id[0];
    const m = { A: 'E', B: 'D', C: 'C', D: 'B', E: 'A' }[col];
    if (id.startsWith('base_')) return id === 'base_b' ? 'base_r' : 'base_b';
    return m + id.slice(1);
  };
  const edgeSet = new Set(EDGES.map(([a, b]) => [a, b].sort().join('|')));
  for (const [a, b] of EDGES) {
    const mirrored = [mirrorId(a), mirrorId(b)].sort().join('|');
    assert.ok(edgeSet.has(mirrored), `edge ${a}-${b} has no mirror edge`);
  }
});

test('no waypoint sits inside solid geometry', () => {
  for (const n of NODES) {
    for (const w of WALLS) {
      const inside = n.x > w.x - RADIUS && n.x < w.x + w.w + RADIUS
        && n.y > w.y - RADIUS && n.y < w.y + w.h + RADIUS;
      assert.ok(!inside, `waypoint ${n.id} is inside or against a wall`);
    }
  }
});

test('no waypoint edge crosses a wall', () => {
  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));
  for (const [a, b] of EDGES) {
    const from = byId[a], to = byId[b];
    assert.ok(from && to, `edge ${a}-${b} references a missing node`);
    assert.ok(lineOfSight(from.x, from.y, to.x, to.y), `edge ${a}-${b} runs through a wall`);
  }
});

test('the waypoint graph is fully connected', () => {
  const adj = Object.fromEntries(NODES.map((n) => [n.id, []]));
  for (const [a, b] of EDGES) { adj[a].push(b); adj[b].push(a); }
  const seen = new Set(['base_b']);
  const queue = ['base_b'];
  while (queue.length) {
    const cur = queue.pop();
    for (const nb of adj[cur]) if (!seen.has(nb)) { seen.add(nb); queue.push(nb); }
  }
  assert.equal(seen.size, NODES.length, `unreachable: ${NODES.map((n) => n.id).filter((n) => !seen.has(n))}`);
});

test('mirrored matches stay near 50/50', () => {
  const s = series(scriptedController, scriptedController, 120);
  // Generous slack. Any large drift means the arena, not the policy, is
  // deciding matches, and the ladder would be reporting phantom skill.
  assert.ok(Math.abs(s.wins - s.losses) <= 25,
    `side bias too large: ${s.wins}-${s.losses} over 120 mirrored matches`);
});

test('scripted beats random: the arena has a skill gradient', () => {
  const s = series(scriptedController, randomController, 120);
  assert.ok(s.wins > s.losses * 2, `scripted should dominate random, got ${s.wins}-${s.losses}`);
  const rev = series(randomController, scriptedController, 120);
  assert.ok(rev.losses > rev.wins * 2, `and from the other side, got ${rev.wins}-${rev.losses}`);
});

test('flags are captured, not just contested', () => {
  let captures = 0;
  for (let s = 1; s <= 60; s++) {
    const r = runMatch({ seed: s, blue: scriptedController, red: scriptedController });
    captures += r.result.score[0] + r.result.score[1];
  }
  assert.ok(captures >= 30, `expected real captures, got ${captures} over 60 matches`);
});

test('a match can be won before the clock runs out', () => {
  let short = 0;
  for (let s = 1; s <= 60; s++) {
    const r = runMatch({ seed: s, blue: scriptedController, red: scriptedController }).result;
    if (r.ticks < 120 * TICK_RATE) short++;
  }
  assert.ok(short > 0, 'reaching 3 captures should end the match early at least sometimes');
});

test('no friendly fire: bullets only ever hit the other team', () => {
  const arena = new Arena({ seed: 11, blue: {}, red: {} });
  // The top lane is the one stretch of the map with nothing overhead, so the
  // shot is not going to be eaten by a wall before it reaches anyone.
  const shooter = arena.units[0];
  shooter.x = 200; shooter.y = 36; shooter.aimAngle = 0;
  const ally = arena.units[1];
  ally.x = shooter.x + 30; ally.y = shooter.y;
  const enemy = arena.units[3];
  enemy.x = shooter.x + 120; enemy.y = shooter.y;

  const allyHp = ally.hp;
  const enemyHp = enemy.hp;
  for (let i = 0; i < 8; i++) {
    shooter.fireCd = 0;
    shooter.reloading = 0;
    shooter.ammo = 8;
    arena.tryFire(shooter);
    arena.stepBullets();
  }
  assert.equal(ally.hp, allyHp, 'a teammate stood in the line and took damage');
  assert.ok(enemy.hp < enemyHp, 'the enemy should have been hit through the teammate');
});

test('a bullet cannot hit its own team even when spawned inside a crowd', () => {
  const arena = new Arena({ seed: 12, blue: {}, red: {} });
  const blue = arena.units[0];
  arena.bullets.push({
    x: blue.x, y: blue.y, vx: 60, vy: 0, team: 'blue', owner: blue.id, life: 40,
  });
  const before = arena.units.filter((u) => u.team === 'blue').map((u) => u.hp);
  arena.stepBullets();
  const after = arena.units.filter((u) => u.team === 'blue').map((u) => u.hp);
  assert.deepEqual(after, before);
});

test('a carrier scores by reaching their own base', () => {
  const arena = new Arena({ seed: 13, blue: {}, red: {} });
  const u = arena.units[0];
  arena.flags.red.state = 'carried';
  arena.flags.red.carrier = u.id;
  u.carrying = true;
  u.x = BASES.blue.x;
  u.y = BASES.blue.y;
  arena.stepFlags();
  assert.equal(arena.teams.blue.score, 1, 'standing on your base with the enemy flag must score');
  assert.equal(arena.flags.red.state, 'returned', 'the flag should respawn after a capture');
});

test('a carrier cannot reach the enemy base and score there', () => {
  const arena = new Arena({ seed: 14, blue: {}, red: {} });
  const u = arena.units[0];
  arena.flags.red.state = 'carried';
  arena.flags.red.carrier = u.id;
  u.carrying = true;
  u.x = BASES.red.x;
  u.y = BASES.red.y;
  arena.stepFlags();
  assert.equal(arena.teams.blue.score, 0, 'the enemy base must not score');
});

test('an owner touching a flag that is simply at home changes nothing', () => {
  const arena = new Arena({ seed: 15, blue: {}, red: {} });
  const u = arena.units[0];
  u.x = FLAG_HOME.blue.x;
  u.y = FLAG_HOME.blue.y;
  arena.stepFlags();
  assert.equal(arena.flags.blue.state, 'home', 'a defender loitering by the flag must not remove it');
  assert.equal(arena.flags.blue.x, FLAG_HOME.blue.x);
});

test('a dropped flag can only be re-grabbed after its protection expires', () => {
  const arena = new Arena({ seed: 16, blue: {}, red: {} });
  const carrier = arena.units[0];   // blue, carrying red
  arena.flags.red.state = 'carried';
  arena.flags.red.carrier = carrier.id;
  carrier.carrying = true;
  carrier.hp = 1;
  arena.applyDamage(carrier, 50, arena.units[3].id);
  assert.equal(arena.flags.red.state, 'dropped');
  assert.equal(arena.flags.red.protect, 40);

  const thief = arena.units[1];
  thief.x = arena.flags.red.x;
  thief.y = arena.flags.red.y;
  arena.stepFlags();
  assert.equal(arena.flags.red.state, 'dropped', 'protection must block an instant re-grab');
});

test('an owner can return their own dropped flag', () => {
  const arena = new Arena({ seed: 17, blue: {}, red: {} });
  // A red unit carrying the blue flag dies: the blue flag hits the deck.
  const redCarrier = arena.units[3];
  arena.flags.blue.state = 'carried';
  arena.flags.blue.carrier = redCarrier.id;
  redCarrier.carrying = true;
  redCarrier.hp = 1;
  arena.applyDamage(redCarrier, 50, arena.units[0].id);
  assert.equal(arena.flags.blue.state, 'dropped');

  const mate = arena.units[1];
  mate.x = arena.flags.blue.x;
  mate.y = arena.flags.blue.y;
  mate.carrying = false;
  arena.stepFlags();
  assert.equal(arena.flags.blue.state, 'returned', 'touching your own dropped flag should return it');
  assert.equal(arena.teams.blue.returns, 1);
});

test('units never end a match frozen inside geometry', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const { arena } = runMatch({ seed, blue: scriptedController, red: randomController });
    for (const u of arena.units) {
      for (const w of WALLS) {
        const inside = u.x > w.x - RADIUS && u.x < w.x + w.w + RADIUS
          && u.y > w.y - RADIUS && u.y < w.y + w.h + RADIUS;
        assert.ok(!inside, `seed ${seed}: ${u.team}${u.idx} stuck in a wall at ${u.x.toFixed(0)},${u.y.toFixed(0)}`);
      }
    }
  }
});

test('units keep moving: no permanent stalls in a long match', () => {
  // Sample positions twice, far apart, and require real displacement for
  // everyone still alive. This is the test that catches a waypoint a unit can
  // never reach: it shows up as a statue, not as an error.
  const { arena } = runMatch({ seed: 21, blue: scriptedController, red: scriptedController });
  const before = arena.units.map((u) => ({ x: u.x, y: u.y, alive: u.alive }));
  for (let i = 0; i < 60; i++) arena.step();
  arena.units.forEach((u, i) => {
    if (!u.alive) return;
    const moved = Math.hypot(u.x - before[i].x, u.y - before[i].y);
    assert.ok(moved > 8,
      `${u.team}${u.idx} barely moved in 3 seconds (${moved.toFixed(1)}px) at ${u.x.toFixed(0)},${u.y.toFixed(0)}`);
  });
});

test('all features stay inside [-1,1]', () => {
  const f = new Float64Array(32);
  const n = 14;
  for (const seed of [1, 2, 3, 4, 5]) {
    const arena = new Arena({ seed, blue: {}, red: {} });
    while (!arena.finished()) {
      for (const u of arena.units) {
        if (!u.alive) continue;
        const v = arena.observe(u, f);
        for (let i = 0; i < n; i++) {
          assert.ok(v[i] >= -1 && v[i] <= 1, `feature ${i} = ${v[i]} (seed ${seed})`);
        }
      }
      arena.step();
    }
  }
});

test('the capture flag features actually respond to game state', () => {
  const f = new Float64Array(32);
  const arena = new Arena({ seed: 19, blue: {}, red: {} });
  const u = arena.units[0];
  const read = () => Array.from(arena.observe(u, f).slice(10, 14));

  const empty = read();
  assert.equal(empty[0], -1, 'has_flag must be -1 when empty-handed');

  arena.flags.red.state = 'carried';
  arena.flags.red.carrier = u.id;
  u.carrying = true;
  const carrying = read();
  assert.equal(carrying[0], 1, 'has_flag must be +1 while carrying');
  assert.ok(carrying[2] !== empty[2], 'score_proximity must react to carrying');

  u.x = BASES.blue.x;
  u.y = BASES.blue.y;
  const atBase = read();
  assert.ok(atBase[2] > carrying[2], 'score_proximity must rise as home gets closer');
});

test('gate inputs stay inside [-1,1]', () => {
  const f = new Float64Array(32);
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

test('action indices from every controller are in range', () => {
  const arena = new Arena({ seed: 11, blue: {}, red: {} });
  const proto = { arena, rng: arena.rng, tick: 0 };
  for (const fn of [scriptedController, randomController, () => 0, () => ACTIONS.length - 1]) {
    for (const u of arena.units) {
      const a = fn.call(proto, u);
      assert.ok(Number.isInteger(a) && a >= 0 && a < ACTIONS.length, `bad action ${a}`);
    }
  }
});

test('a brain controller plays a legal game and fills the record', () => {
  const nF = 14;
  const zeroBrain = {
    nF, nA: ACTIONS.length, nC: 4, nArch: 3, gated: true,
    w: new Float32Array(4 * ACTIONS.length * nF),
    archBias: new Float32Array(3 * ACTIONS.length),
    thresholds: new Float32Array([0.35, 0.15, -0.35, -0.1]),
    scale: new Float32Array(nF).fill(1),
    biasScale: 1, minDwellTicks: 12,
  };
  const { result, recording } = runMatch({
    seed: 5, blue: brainController(zeroBrain), red: scriptedController,
    record: { src: 'human', which: 'blue' },
  });
  assert.ok(result.ticks > 0 && result.ticks <= 120 * TICK_RATE,
    'a match ends at the capture limit or the clock, whichever is first');
  assert.ok(recording.includes('"src":"human"'));
  const lines = recording.trim().split('\n');
  const steps = lines.filter((l) => l.includes('"u"'));
  assert.ok(steps.length > 100);
  for (const l of steps) {
    const o = JSON.parse(l);
    assert.equal(o.f.length, nF);
    assert.equal(o.a, 0);
  }
  assert.ok(lines.some((l) => l.includes('"end"')));
});

test('decisions happen on the fixed cadence', () => {
  const arena = new Arena({ seed: 3, blue: {}, red: {} });
  let decisions = 0;
  while (!arena.finished()) {
    if (arena.tick % DECISION_EVERY === 0) decisions += arena.units.length;
    arena.step();
  }
  const expected = Math.ceil(arena.maxTicks / DECISION_EVERY) * 6;
  assert.ok(Math.abs(decisions - expected) <= 6, `${decisions} vs ${expected}`);
});

test('angle helpers behave', () => {
  assert.ok(Math.abs(angleDelta(0.1, -0.1) - 0.2) < 1e-9);
  // -3.1 and 3.1 are 0.083 radians apart once wrapped, not 6.2.
  assert.ok(Math.abs(angleDelta(-3.1, 3.1) - 0.0832) < 1e-3, 'wraps across +/-pi');
  assert.ok(Math.abs(angleDelta(3.1, -3.1) + 0.0832) < 1e-3);
  assert.ok(SIGHT > 0 && RADIUS > 0);
});

test('the spec matches the geometry', () => {
  assert.equal(ACTIONS.length, 7);
  assert.ok(BASES.blue.x < BASES.red.x, 'blue base is on the left');
  assert.equal(BASES.blue.r, BASES.red.r);
});