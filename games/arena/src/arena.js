// The reference game for System One: capture the flag in a derelict station.
//
// The point of this file is that it is *ordinary game code*. It has walls,
// weapons with real projectiles, line of sight, flags, and no knowledge of
// System One beyond filling a feature vector and handling an action index. Swap
// it for a Unity scene or a Godot level and nothing else in the pipeline
// changes.
//
// The map is hand-authored and fixed. No procedural generation: a trainer that
// trains on one map and ships on another learns the wrong thing, and a visitor
// arriving at the showcase should see the same arena every time.
//
// Determinism: every random draw goes through the seeded rng, so a match is
// fully reproducible from (seed, configs). Combat spread is the only stochastic
// part, and the trainer depends on that being reproducible.

import { decide, gateContext, ramp, CTX_DEFAULT } from '../../../sdk/js/s1.js';

export const TICK_RATE = 20;          // sim ticks per second
export const DECISION_EVERY = 4;     // a decision every 200ms
export const MATCH_SECONDS = 120;
export const ARENA_W = 640;
export const ARENA_H = 400;

export const SPEED = 78;              // px/s at full intent
export const RADIUS = 10;
export const MAX_HP = 100;
export const MAG_SIZE = 8;
export const RELOAD_TICKS = 45;
export const ABILITY_COOLDOWN = 120;
export const ABILITY_DURATION = 30;
export const SIGHT = 300;
export const WEAPON_RANGE = 300;
export const BULLET_SPEED = 520;
export const FIRE_COOLDOWN = 10;      // ticks between shots
export const BULLET_DAMAGE = 8;
export const SHOT_SPREAD = 0.055;     // radians, one sigma
export const CAPTURES_TO_WIN = 3;
export const FLAG_RESPAWN = 200;      // ticks
export const DROP_PROTECT = 40;       // ticks a dropped flag is untouchable
export const FLAG_GRAB_R = 22;        // pickup radius, see stepFlags for why

// Blocking geometry. Hand-placed to create three lanes, a central pillar, and
// cover near both bases. Every wall has a matching gap: a wall that fully seals
// an approach turns every match into a stalemate, which is a level-design bug
// rather than an AI problem.
export const WALLS = [
  // inner cover, blue side
  { x: 132, y: 104, w: 56, h: 28 },
  { x: 132, y: 268, w: 56, h: 28 },
  // inner cover, red side
  { x: 452, y: 104, w: 56, h: 28 },
  { x: 452, y: 268, w: 56, h: 28 },
  // central pillar
  { x: 292, y: 168, w: 56, h: 64 },
  // top and bottom centre braces
  { x: 298, y: 72, w: 44, h: 22 },
  { x: 298, y: 306, w: 44, h: 22 },
  // base-side bumpers
  { x: 176, y: 176, w: 20, h: 48 },
  { x: 444, y: 176, w: 20, h: 48 },
];

// Purely visual. Present for decoration and for the eye to read depth; never
// queried by movement, sight, or bullets.
export const DECOR = [
  { s: 'solar_blue', x: 96, y: 96, r: 0, scale: 0.9 },
  { s: 'solar_red', x: 544, y: 96, r: Math.PI, scale: 0.9 },
  { s: 'solar_blue', x: 96, y: 296, r: Math.PI, scale: 0.9 },
  { s: 'solar_red', x: 544, y: 296, r: 0, scale: 0.9 },
  { s: 'dome_a', x: 62, y: 156, r: 0, scale: 1 },
  { s: 'dome_b', x: 60, y: 232, r: 0, scale: 1 },
  { s: 'dome_b', x: 578, y: 156, r: Math.PI, scale: 1 },
  { s: 'dome_a', x: 580, y: 232, r: Math.PI, scale: 1 },
  { s: 'tower', x: 210, y: 34, r: 0, scale: 0.34 },
  { s: 'tower', x: 430, y: 34, r: 0, scale: 0.34 },
  { s: 'dish', x: 232, y: 190, r: -0.5, scale: 0.6 },
  { s: 'dish', x: 408, y: 212, r: 0.5, scale: 0.6 },
  { s: 'mast', x: 168, y: 348, r: 0, scale: 1 },
  { s: 'mast', x: 472, y: 348, r: 0, scale: 1 },
  { s: 'mast', x: 168, y: 40, r: Math.PI, scale: 1 },
  { s: 'mast', x: 472, y: 40, r: Math.PI, scale: 1 },
  { s: 'rock_a', x: 268, y: 118, r: 0.4, scale: 0.34 },
  { s: 'rock_b', x: 372, y: 282, r: -0.8, scale: 0.32 },
  { s: 'rock_c', x: 500, y: 148, r: 1.2, scale: 0.3 },
  { s: 'rock_b', x: 140, y: 236, r: 0.2, scale: 0.3 },
  { s: 'rock_c', x: 596, y: 268, r: -0.3, scale: 0.3 },
];

export const BASES = {
  blue: { x: 66, y: 200, r: 46 },
  red: { x: 574, y: 200, r: 46 },
};
export const FLAG_HOME = { blue: { x: 66, y: 200 }, red: { x: 574, y: 200 } };
export const SPAWN_X = { blue: 52, red: 588 };

// Waypoint graph for navigation. The map is fixed, so a hand-placed lane graph
// beats a general pathfinder: it is exact, cheap, and the trainer sees the same
// routes every match. Nodes are placed in open lanes, never inside geometry.
//
// Lanes: three across (upper, middle, lower) with connectors near each base and
// around the central pillar. The middle lane dead-ends at the pillar on purpose,
// so the graph itself tells a policy to take a flank instead of walking into a
// wall, which is what a pure obstacle-avoidance steer cannot do.
// Lane grid. Five rows (T, U, M, L, B) crossed with five columns, plus one
// node per base. Coordinates are chosen so no node sits inside padded geometry,
// and an edge never spans a chokepoint: the middle row is deliberately cut into
// three separate segments by the two base bumpers and the central pillar, so a
// route has to commit to a flank rather than drift into a dead end.
const ROWS = { T: 36, U: 150, M: 200, L: 250, B: 364 };
// Mirrored about x = 320 so a mirrored match is a genuinely mirrored match. An
// asymmetric lane graph hands one side shorter routes and shows up in the ladder
// as skill that does not exist.
const COLS = { A: 110, B: 250, C: 320, D: 390, E: 530 };

function buildNodes() {
  const n = [];
  const push = (id, x, y) => n.push({ id, x, y });
  for (const [row, y] of Object.entries(ROWS)) {
    for (const [col, x] of Object.entries(COLS)) {
      // The centre column is only open on the outer rows.
      if (col === 'C' && row !== 'T' && row !== 'B') continue;
      push(`${col}${row}`, x, y);
    }
  }
  push('base_b', BASES.blue.x, BASES.blue.y);
  push('base_r', BASES.red.x, BASES.red.y);
  return n;
}

export const NODES = buildNodes();

// Edges are declared, not inferred. Every one of these has been checked to
// clear the padded wall boxes; spec/geometry.test.js enforces that, because a
// single bad edge is a unit that walks into a wall forever.
export const EDGES = [
  // top lane, full width
  ['AT', 'BT'], ['BT', 'CT'], ['CT', 'DT'], ['DT', 'ET'],
  // upper flank, full width
  ['AU', 'BU'], ['BU', 'DU'], ['DU', 'EU'],
  // lower flank, full width
  ['AL', 'BL'], ['BL', 'DL'], ['DL', 'EL'],
  // bottom lane, full width
  ['AB', 'BB'], ['BB', 'CB'], ['CB', 'DB'], ['DB', 'EB'],
  // Middle row. The two base bumpers seal the centre line, so the middle reaches
  // each base only from that base's own side; the enemy middle segment is
  // unreachable on purpose, which is what makes flanking a real decision.
  ['base_b', 'AM'], ['EM', 'base_r'],
  // verticals
  ['AT', 'AU'], ['AU', 'AM'], ['AM', 'AL'], ['AL', 'AB'],
  ['BT', 'BU'], ['BU', 'BM'], ['BM', 'BL'], ['BL', 'BB'],
  ['DT', 'DU'], ['DU', 'DM'], ['DM', 'DL'], ['DL', 'DB'],
  ['ET', 'EU'], ['EU', 'EM'], ['EM', 'EL'], ['EL', 'EB'],
];

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ACTIONS = ['advance', 'hold', 'peek', 'retreat', 'rotate', 'use_ability', 'reload'];
export const ACTION = Object.fromEntries(ACTIONS.map((n, i) => [n, i]));
export const CONTEXTS = ['execute', 'default', 'hold', 'save'];
export const ARCHETYPES = ['entry', 'support', 'sniper'];

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

// Liang-Barsky, with a strict interior test for both endpoints.
  //
  // The endpoints must be tested strictly. A unit resting exactly on the edge
  // of a wall's collision shell is touching, not inside, and if it counts as
  // inside then every collision query from that spot answers "blocked" and the
  // unit can never move again. `evictFromWalls` uses the same strict test, so
  // the two agree exactly at the boundary instead of disagreeing on it.
  function segHitsBox(x1, y1, x2, y2, b, pad = 0) {
    const bx1 = b.x - pad, by1 = b.y - pad, bx2 = b.x + b.w + pad, by2 = b.y + b.h + pad;
    if (x1 > bx1 && x1 < bx2 && y1 > by1 && y1 < by2) return true;
    if (x2 > bx1 && x2 < bx2 && y2 > by1 && y2 < by2) return true;
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - bx1, bx2 - x1, y1 - by1, by2 - y1];
  for (let i = 0; i < 4; i++) {
    // A segment moving parallel to a slab edge that it is exactly touching is
    // not inside the box. Testing `q < 0` instead of `q <= 0` counts a unit
    // resting on a wall's collision shell as colliding, which is a different
    // failure from the one above: it makes the unit unable to move *along* the
    // wall, so it slides nowhere and stalls at the first corner.
    if (p[i] === 0) { if (q[i] <= 1e-9) return false; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  // The overlap has to have length. A segment that starts exactly on the shell
  // and moves away clips the box at a single point, t0 === t1, and treating
  // that as a collision is what pins a unit to the edge of a wall forever.
  return t1 - t0 > 1e-9;
}

export function lineOfSight(ax, ay, bx, by) {
  for (const w of WALLS) if (segHitsBox(ax, ay, bx, by, w)) return false;
  return true;
}

function gauss(rng) {
  // Box-Muller. Only one of the pair is ever used, which is deliberate: half
  // the draws are saved and the seed stream stays easy to reason about.
  const u = Math.max(1e-9, rng());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export class Arena {
  constructor({ seed = 1, blue, red, seconds = MATCH_SECONDS, teamSize = 3 } = {}) {
    this.rng = mulberry32(seed >>> 0);
    // Which side moves and fires first is arbitrary, so it is drawn from the
    // seed rather than fixed. Pinning it to one side hands that side a
    // systematic advantage in every single match, which the ladder then reports
    // as skill.
    this.orderParity = (seed >>> 0) & 1;
    this.tick = 0;
    this.maxTicks = seconds * TICK_RATE;
    this.teamSize = teamSize;
    this.events = [];
    this.bullets = [];
    this.fx = [];
    this.teams = {
      blue: { name: 'blue', cfg: blue ?? {}, score: 0, kills: 0, returns: 0 },
      red: { name: 'red', cfg: red ?? {}, score: 0, kills: 0, returns: 0 },
    };
    this.flags = {
      blue: { team: 'blue', state: 'home', x: FLAG_HOME.blue.x, y: FLAG_HOME.blue.y, carrier: null, timer: 0 },
      red: { team: 'red', state: 'home', x: FLAG_HOME.red.x, y: FLAG_HOME.red.y, carrier: null, timer: 0 },
    };
    this.units = [];
    let uid = 0;
    for (const team of ['blue', 'red']) {
      for (let i = 0; i < teamSize; i++) this.units.push(this.spawn(team, i, uid++));
    }
    // Face everyone at the enemy flag to start.
    for (const u of this.units) {
      const f = FLAG_HOME[u.team === 'blue' ? 'red' : 'blue'];
      u.aimAngle = Math.atan2(f.y - u.y, f.x - u.x);
    }
  }

  spawn(team, i, uid) {
    const x = SPAWN_X[team] + (team === 'blue' ? i * 4 : -i * 4);
    const y = 200 + (i - 1) * 62;
    return {
      id: uid,
      team,
      idx: i,
      x, y,
      aimAngle: team === 'blue' ? 0 : Math.PI,
      aimX: FLAG_HOME[team === 'blue' ? 'red' : 'blue'].x,
      aimY: FLAG_HOME[team === 'blue' ? 'red' : 'blue'].y,
      hp: MAX_HP,
      ammo: MAG_SIZE,
      reloading: 0,
      cd: 0,
      shield: 0,
      fireCd: 0,
      alive: true,
      ctx: CTX_DEFAULT,
      ctxSince: 0,
      arch: i % 3,
      lastAction: ACTION.hold,
      lastHuman: 'hold',
      intentX: 0,
      intentY: 0,
      aimCone: 0.32,
      wantsFire: false,
      damageTaken: 0,
      damageDealt: 0,
      flagsTaken: 0,
      caps: 0,
    };
  }

  teamUnits(team) { return this.units.filter((u) => u.team === team && u.alive); }
  enemiesOf(u) { return this.units.filter((o) => o.team !== u.team && o.alive); }
  alliesOf(u) { return this.units.filter((o) => o.team === u.team && o.alive && o.id !== u.id); }

  nearestEnemy(u) {
    let best = null, bd = Infinity;
    for (const o of this.enemiesOf(u)) {
      const d = dist(u.x, u.y, o.x, o.y);
      if (d < bd) { bd = d; best = o; }
    }
    return { unit: best, d: bd };
  }

  // Distance to the nearest solid edge. cover_dist wants "how close am I to
  // something I can hide behind", so this is edge distance, not center distance.
  coverDistance(u) {
    let best = Infinity;
    for (const w of WALLS) {
      const dx = Math.max(w.x - u.x, 0, u.x - (w.x + w.w));
      const dy = Math.max(w.y - u.y, 0, u.y - (w.y + w.h));
      best = Math.min(best, Math.hypot(dx, dy));
    }
    best = Math.min(best, u.x, ARENA_W - u.x, u.y, ARENA_H - u.y);
    return best;
  }

  canSee(u, o) {
    return dist(u.x, u.y, o.x, o.y) <= SIGHT && lineOfSight(u.x, u.y, o.x, o.y);
  }

  visibleEnemies(u) { return this.enemiesOf(u).filter((o) => this.canSee(u, o)); }

  // Where this unit wants to go: its own base to defend, the enemy flag to
  // steal, or its own flag to return when it holds the enemy one.
  objectiveFor(u) {
    const base = BASES[u.team];
    // Holding the enemy flag: the only thing that matters is getting home.
    // Without this first check a carrier targets the flag it is already
    // carrying and runs to the enemy base to "steal" what it has.
    if (u.carrying) return { kind: 'score', x: base.x, y: base.y };

    const mine = this.flags[u.team];
    const theirs = this.flags[u.team === 'blue' ? 'red' : 'blue'];
    // Our flag is out: recover it, or cut off the carrier.
    if (mine.state === 'carried') {
      const c = this.units.find((x) => x.id === mine.carrier);
      if (c && c.alive) return { kind: 'chase', x: c.x, y: c.y };
      return { kind: 'return', x: mine.x, y: mine.y };
    }
    if (mine.state === 'dropped') return { kind: 'return', x: mine.x, y: mine.y };
    if (theirs.state === 'dropped') return { kind: 'pickup', x: theirs.x, y: theirs.y };
    return { kind: 'steal', x: theirs.x, y: theirs.y };
  }

  // -------------------------------------------------------------------------
  // Contract 1: feature extraction. All ten slots normalized to [-1,1].
  // -------------------------------------------------------------------------
  observe(u, out) {
    const ne = this.nearestEnemy(u);
    const vis = this.visibleEnemies(u);
    let best = vis[0] ?? null, bd = Infinity;
    for (const o of vis) {
      const d = dist(u.x, u.y, o.x, o.y);
      if (d < bd) { bd = d; best = o; }
    }
    const allies = this.alliesOf(u).length;
    const enemies = this.enemiesOf(u).length;
    const obj = this.objectiveFor(u);

    out[0] = 1 - 2 * clamp(ne.d / SIGHT, 0, 1);              // enemy_dist
    out[1] = vis.length > 0 ? 1 : -1;                        // enemy_visible
    out[2] = 2 * clamp(u.hp / MAX_HP, 0, 1) - 1;             // hp
    out[3] = 2 * clamp(u.ammo / MAG_SIZE, 0, 1) - 1;         // ammo
    out[4] = 1 - 2 * clamp(this.coverDistance(u) / 170, 0, 1); // cover_dist
    out[5] = 1 - 2 * clamp(dist(u.x, u.y, obj.x, obj.y) / 380, 0, 1); // objective_dist
    out[6] = 2 * clamp(allies / Math.max(1, this.teamSize - 1), 0, 1) - 1;
    out[7] = 1 - 2 * clamp(enemies / Math.max(1, this.teamSize), 0, 1);
    out[8] = u.cd <= 0 ? 1 : -1;                             // ability_ready
    out[9] = 2 * clamp(1 - this.tick / this.maxTicks, 0, 1) - 1; // time_left

// Capture-the-flag state. These four slots are what make CTF expressible by
    // the same linear policy as everything else. Without them a policy can see
    // hp and line of sight but cannot tell "run the flag home" from "charge the
    // enemy", because both look like advancing.
    const mine = this.flags[u.team];
    const theirs = this.flags[u.team === 'blue' ? 'red' : 'blue'];
    out[10] = u.carrying ? 1 : -1;                            // has_flag

    // +1 while our flag is safe at home, -1 the moment the enemy has it. This
    // is what turns a defender into a returner without a separate action.
    out[11] = (mine.state === 'carried' || mine.state === 'dropped') ? -1 : 1; // flag_stolen

    // How close am I to scoring right now? Only meaningful while carrying, so it
    // is pinned low when empty to stop the weight from meaning anything else.
    const base = BASES[u.team];
    const dHome = dist(u.x, u.y, base.x, base.y);
    out[12] = u.carrying ? 1 - 2 * clamp(dHome / 240, 0, 1) : -1; // score_proximity

    // Distance to the enemy that is carrying our flag, or to their flag if it is
    // loose. Positive when close. Lets a defender commit to an intercept instead
    // of drifting back toward home.
    const threatId = mine.carrier;
    const target = threatId != null
      ? this.units.find((x) => x.id === threatId)
      : (mine.state === 'dropped' ? { x: mine.x, y: mine.y } : null);
    out[13] = target ? 1 - 2 * clamp(dist(u.x, u.y, target.x, target.y) / 300, 0, 1) : -1;
    return out;
  }

  // Gate inputs live on the feature vector, so the gate costs no extra
  // game-specific integration.
  gateInputs(u, f) {
    const pressure = 0.5 * (f[1] * 0.5 + 0.5) + 0.5 * ramp(f[0]);
    const advantage = 0.5 * (f[6] - f[7]) + 0.5 * f[2];
    return [clamp(pressure * 2 - 1, -1, 1), clamp(advantage, -1, 1)];
  }

  // -------------------------------------------------------------------------
  // Contract 1: action dispatch. Intent -> the game's own controllers.
  // -------------------------------------------------------------------------
  act(u, a) {
    u.lastAction = a;
    u.wantsFire = false;
    switch (ACTIONS[a] ?? 'hold') {
      case 'advance': this.intentAdvance(u); break;
      case 'hold': this.intentHold(u); break;
      case 'peek': this.intentPeek(u); break;
      case 'retreat': this.intentRetreat(u); break;
      case 'rotate': this.intentRotate(u); break;
      case 'use_ability': this.intentAbility(u); break;
      case 'reload': this.intentReload(u); break;
      default: break;
    }
  }

  aimAt(u, tx, ty) {
    u.aimAngle = Math.atan2(ty - u.y, tx - u.x);
    u.aimX = tx;
    u.aimY = ty;
  }

  intentAdvance(u) {
    const obj = this.objectiveFor(u);
    const dObj = dist(u.x, u.y, obj.x, obj.y);
    this.aimAt(u, obj.x, obj.y);

    // Close to the objective, go straight at it. Blending in the nearest enemy
    // while standing on the flag pulls the goal point behind the unit, and it
    // orbits the objective forever without ever picking it up.
    if (dObj < 130) {
      this.steerTo(u, obj.x, obj.y, 1);
      return;
    }
    // Far out, lead slightly toward the nearest enemy so advancing is not a
    // blind walk down an empty lane.
    const { unit: e } = this.nearestEnemy(u);
    let tx = obj.x, ty = obj.y;
    if (e) {
      tx = tx * 0.75 + e.x * 0.25;
      ty = ty * 0.75 + e.y * 0.25;
    }
    this.steerTo(u, tx, ty, 1);
  }

  intentHold(u) {
    this.moveIntent(u, u.x, u.y, 0);
    const { unit: e } = this.nearestEnemy(u);
    if (e && this.canSee(u, e)) this.aimAt(u, e.x, e.y);
  }

  // Strafe out of cover while keeping the threat roughly in front. Combat is
  // the reason to peek, not repositioning.
  intentPeek(u) {
    const { unit: e, d } = this.nearestEnemy(u);
    if (!e) return this.intentAdvance(u);
    this.aimAt(u, e.x, e.y);
    const ang = Math.atan2(e.y - u.y, e.x - u.x);
    // Which way to strafe is derived from the unit's slot mirrored across the
    // map, not from a raw id. Keying off the id gives blue and red different
    // strafe patterns in an otherwise mirrored game, which shows up as a fake
    // side advantage in the ladder.
    const slot = u.team === 'blue' ? u.idx : this.teamSize - 1 - u.idx;
    const side = (slot % 2 === 0) ? 1 : -1;
    const strafe = ang + side * Math.PI / 2;
    // Hold ground if already in a good firing spot, otherwise close a little.
    const want = d > WEAPON_RANGE * 0.8 ? 1 : 0.45;
    this.moveIntent(u, u.x + Math.cos(strafe) * 60, u.y + Math.sin(strafe) * 60, want);
  }

  intentRetreat(u) {
    const { unit: e } = this.nearestEnemy(u);
    if (!e) return this.intentHold(u);
    this.aimAt(u, e.x, e.y);
    const dx = u.x - e.x, dy = u.y - e.y;
    const m = Math.hypot(dx, dy) || 1;
    // Back toward the nearest solid edge, away from the threat. Routed, so a
    // cornered unit does not slide along a wall forever.
    let best = null, bd = Infinity;
    for (const w of WALLS) {
      const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
      const d = dist(u.x, u.y, cx, cy);
      if (d < bd) { bd = d; best = { x: cx, y: cy }; }
    }
    const tx = best ? best.x : u.x + (dx / m) * 70;
    const ty = best ? best.y : u.y + (dy / m) * 70;
    this.steerTo(u, tx, ty, 1);
  }

  // Swap with the ally in the worst spot, so the squad does not stack.
  intentRotate(u) {
    const allies = this.alliesOf(u);
    if (!allies.length) return this.intentAdvance(u);
    let target = allies[0], worst = -Infinity;
    for (const a of allies) {
      const { d } = this.nearestEnemy(a);
      const exposed = (a.ammo < 2 ? 2 : 0) + a.hp / 100 + d / 200;
      if (exposed > worst) { worst = exposed; target = a; }
    }
    const dx = target.x - u.x, dy = target.y - u.y;
    const m = Math.hypot(dx, dy) || 1;
    this.steerTo(u, target.x - (dx / m) * 52, target.y - (dy / m) * 52, 1);
  }

  intentAbility(u) {
    if (u.cd <= 0) {
      u.cd = ABILITY_COOLDOWN;
      u.shield = ABILITY_DURATION;
      this.events.push({ t: this.tick, kind: 'ability', unit: u.id });
    }
    this.intentAdvance(u);
  }

  intentReload(u) {
    // Only *start* a reload. Re-arming the timer on every reissued intent makes
    // a reloading unit reload forever, since the decision cadence is shorter
    // than the reload itself.
    if (u.ammo < MAG_SIZE && u.reloading <= 0) u.reloading = RELOAD_TICKS;
    // Reloading is not a reason to stand still. The reload takes 45 ticks, and a
    // unit that stops dead for 45 ticks in the open is a unit that gets shot.
    // Keep walking toward whatever the unit was already trying to do.
    const obj = this.objectiveFor(u);
    this.steerTo(u, obj.x, obj.y, 1);
  }

  moveIntent(u, tx, ty, scale = 1) {
    const ax = tx - u.x, ay = ty - u.y;
    const m = Math.hypot(ax, ay) || 1;
    u.intentX = (ax / m) * scale;
    u.intentY = (ay / m) * scale;
  }

  // -------------------------------------------------------------------------
  // weapons
  // -------------------------------------------------------------------------
  // A unit fires only at a target inside its aim cone. For a bot the controller
  // has already aimed at that target, so the cone is nearly free; for a human it
  // is the whole skill of the gun.
  tryFire(u) {
    if (!u.alive || u.ammo <= 0 || u.reloading > 0 || u.fireCd > 0) return false;
    const targets = this.visibleEnemies(u);
    if (!targets.length) return false;
    let chosen = null, bestOff = Infinity;
    for (const t of targets) {
      if (dist(u.x, u.y, t.x, t.y) > WEAPON_RANGE) continue;
      const a = Math.atan2(t.y - u.y, t.x - u.x);
      const off = Math.abs(angleDelta(a, u.aimAngle));
      if (off < u.aimCone && off < bestOff) { bestOff = off; chosen = t; }
    }
    if (!chosen) return false;
    const spread = gauss(this.rng) * SHOT_SPREAD;
    const a = Math.atan2(chosen.y - u.y, chosen.x - u.x) + spread;
    this.bullets.push({
      x: u.x + Math.cos(a) * (RADIUS + 4),
      y: u.y + Math.sin(a) * (RADIUS + 4),
      vx: Math.cos(a) * BULLET_SPEED,
      vy: Math.sin(a) * BULLET_SPEED,
      team: u.team,
      owner: u.id,
      life: 70,
    });
    u.ammo--;
    u.fireCd = FIRE_COOLDOWN;
    if (u.ammo === 0) u.reloading = RELOAD_TICKS;
    this.fx.push({ kind: 'muzzle', x: u.x, y: u.y, a, t: 0 });
    return true;
  }

  stepBullets() {
    const dt = 1 / TICK_RATE;
    const keep = [];
    for (const b of this.bullets) {
      const nx = b.x + b.vx * dt;
      const ny = b.y + b.vy * dt;

      // Walls stop bullets. Decor never does.
      if (this.blocked(b.x, b.y, nx, ny)) {
        this.fx.push({ kind: 'impact', x: b.x, y: b.y, a: Math.atan2(b.vy, b.vx), t: 0 });
        continue;
      }
      if (nx < 0 || nx > ARENA_W || ny < 0 || ny > ARENA_H) continue;

      // No friendly fire, by construction: the candidate list only ever
      // contains the other team. There is no code path where a bullet can
      // consider hitting its own shooter or its teammates.
      //
      // When two enemies overlap the shot, the nearest one takes it. Scanning
      // for the first match in array order would hand every exchange to blue,
      // because blue units come first in the unit list, and clumped squads
      // overlap constantly.
      let hit = null;
      let hitD = Infinity;
      for (const o of this.units) {
        if (!o.alive || o.team === b.team) continue;
        const d = dist(nx, ny, o.x, o.y);
        if (d > RADIUS + 5 || d >= hitD) continue;
        if (!lineOfSight(b.x, b.y, nx, ny)) continue;
        hit = o;
        hitD = d;
      }
      if (hit) {
        this.applyDamage(hit, BULLET_DAMAGE, b.owner);
        this.fx.push({ kind: 'impact', x: nx, y: ny, a: Math.atan2(b.vy, b.vx), t: 0 });
        continue;
      }
      b.x = nx;
      b.y = ny;
      if (--b.life > 0) keep.push(b);
    }
    this.bullets = keep;
  }

  applyDamage(target, amount, sourceId) {
    const owner = this.units.find((u) => u.id === sourceId);
    const dealt = target.shield > 0 ? amount * 0.35 : amount;
    target.hp -= dealt;
    target.damageTaken += dealt;
    if (owner) owner.damageDealt += dealt;
    this.events.push({ t: this.tick, kind: 'hit', src: sourceId, dst: target.id, amt: dealt });
    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      const src = owner ? owner.team : (target.team === 'blue' ? 'red' : 'blue');
      if (owner) this.teams[src].kills++;
      this.dropFlagFor(target);
      this.fx.push({ kind: 'boom', x: target.x, y: target.y, t: 0 });
      this.events.push({ t: this.tick, kind: 'kill', src: sourceId, dst: target.id });
    }
  }

  // -------------------------------------------------------------------------
  // flags
  // -------------------------------------------------------------------------
  dropFlagFor(u) {
    const f = this.flags[u.team === 'blue' ? 'red' : 'blue'];
    if (f.state === 'carried' && f.carrier === u.id) {
      f.state = 'dropped';
      f.x = u.x;
      f.y = u.y;
      f.carrier = null;
      f.timer = 0;
      f.protect = DROP_PROTECT;
      this.events.push({ t: this.tick, kind: 'flagdrop', flag: f.team, x: f.x, y: f.y });
    }
  }

  stepFlags() {
    // 1. Respawn timers.
    for (const key of ['blue', 'red']) {
      const f = this.flags[key];
      if (f.state !== 'returned') continue;
      if (--f.timer <= 0) {
        f.state = 'home';
        f.x = FLAG_HOME[key].x;
        f.y = FLAG_HOME[key].y;
      }
    }

    // 2. Scoring. A carrier that reaches its own base scores. Checked before
    //    pickup so a unit standing on its own flag while carrying always wins
    //    the point rather than being processed as a pickup.
    for (const u of this.units) {
      if (!u.alive || !u.carrying) continue;
      const base = BASES[u.team];
      if (dist(u.x, u.y, base.x, base.y) > base.r) continue;
      this.teams[u.team].score++;
      u.caps++;
      u.carrying = false;
      const stolen = this.flags[u.team === 'blue' ? 'red' : 'blue'];
      stolen.state = 'returned';
      stolen.carrier = null;
      stolen.timer = FLAG_RESPAWN;
      this.fx.push({ kind: 'capture', x: base.x, y: base.y, team: u.team, t: 0 });
      this.events.push({ t: this.tick, kind: 'capture', team: u.team, score: this.teams[u.team].score });
    }

    // 3. Pickup and return.
    //
    // These are two different rules and conflating them is how a defender
    // standing near their own flag makes it vanish. An owner touching a flag
    // that is merely at home changes nothing at all.
    for (const key of ['blue', 'red']) {
      const f = this.flags[key];
      if (f.state === 'carried') {
        // Keep the flag drawn at the carrier so the renderer needs no special case.
        const c = this.units.find((x) => x.id === f.carrier);
        if (c) { f.x = c.x; f.y = c.y; }
        continue;
      }
      if (f.state === 'dropped' && f.protect > 0) f.protect--;

      const enemy = key === 'blue' ? 'red' : 'blue';
      // Attackers are scanned before defenders, and the scan does not stop at
      // the first unit in range. Scanning in unit order instead means the blue
      // flag is defended-then-attacked while the red flag is attacked-then-
      // defended, so one side loses every contested pickup. That is a pure
      // artifact of array order, and it showed up as a 174-3 capture split.
      let taken = false;
      for (const u of this.units) {
        if (!u.alive || u.team !== enemy) continue;
        if (u.carrying) continue;
        if (f.protect > 0) continue;
        if (dist(u.x, u.y, f.x, f.y) > FLAG_GRAB_R) continue;
        f.state = 'carried';
        f.carrier = u.id;
        u.carrying = true;
        u.flagsTaken++;
        this.events.push({ t: this.tick, kind: 'flagtake', flag: key, unit: u.id });
        taken = true;
        break;
      }
      if (taken) continue;

      // Owner touches a flag that is loose at home: nothing happens. Owner
      // touches their own dropped flag: it goes back.
      if (f.state !== 'dropped') continue;
      for (const u of this.units) {
        if (!u.alive || u.team === enemy) continue;
        if (dist(u.x, u.y, f.x, f.y) > FLAG_GRAB_R) continue;
        this.teams[u.team].returns++;
        f.state = 'returned';
        f.carrier = null;
        f.timer = FLAG_RESPAWN;
        this.events.push({ t: this.tick, kind: 'return', team: u.team });
        break;
      }
    }
  }

  // The defender is the unit closest to the threat. One defender, not three:
  // a whole squad abandoning the objective is how CTF turns into a see-saw.
  isDefender(u) {
    const f = this.flags[u.team];
    if (f.state !== 'carried' && f.state !== 'dropped') return false;
    const slot = (x) => (x.team === 'blue' ? x.idx : this.teamSize - 1 - x.idx);
    let best = null, bd = Infinity, bs = Infinity;
    for (const a of this.teamUnits(u.team)) {
      if (a.carrying) continue;
      const base = BASES[u.team];
      if (Math.hypot(a.x - base.x, a.y - base.y) > 260) continue;
      const d = Math.hypot(a.x - f.x, a.y - f.y);
      // Ties break on mirrored slot, not on array order, so the same unit is
      // chosen on both sides of a mirrored match.
      if (d < bd || (d === bd && slot(a) < bs)) { bd = d; bs = slot(a); best = a; }
    }
    return best === u;
  }

  anyCarrier(team) {
    const f = this.flags[team];
    if (f.state !== 'carried') return false;
    const u = this.units.find((x) => x.id === f.carrier);
    return !!(u && u.alive);
  }

  // -------------------------------------------------------------------------
  // tick
  // -------------------------------------------------------------------------
  step() {
    this.tick++;
    const dt = 1 / TICK_RATE;

    // Alternate which side acts first, offset by a per-match random bit so the
    // advantage does not land on the same team in every match.
    const order = ((this.tick + this.orderParity) % 2 === 0) ? this.units : [...this.units].reverse();

    for (const u of order) {
      if (!u.alive) continue;
      u.ctxSince++;
      if (u.reloading > 0) { u.reloading--; if (u.reloading === 0) u.ammo = MAG_SIZE; }
      if (u.cd > 0) u.cd--;
      if (u.shield > 0) u.shield--;
      if (u.fireCd > 0) u.fireCd--;

      const ix = u.intentX ?? 0, iy = u.intentY ?? 0;
      if (Math.hypot(ix, iy) > 0.05) this.moveWithSlide(u, ix, iy, SPEED * dt);

      // A human pulls the trigger explicitly; a bot fires whenever a target is
      // in the cone. Same code path, one flag apart.
      if (u.isHuman) {
        if (u.wantsFire) this.tryFire(u);
      } else {
        this.tryFire(u);
      }
    }

    this.stepBullets();
    this.stepFlags();
    this.separate();
    for (const f of this.fx) f.t++;
    if (this.fx.length > 90) this.fx = this.fx.slice(-60);
    return this;
  }

  // Walk with wall sliding, and as a last resort slide around the corner.
  //
  // Full step, then each axis, is not enough. A unit pressed against a wall
  // corner with an intent pointing straight into it has no legal step in any of
  // those directions and stands there for the rest of the match. Falling back
  // to a perpendicular turn walks it around the corner instead of freezing it,
  // for two extra collision tests.
  moveWithSlide(u, dx, dy, step) {
    const tx = clamp(u.x + dx * step, RADIUS, ARENA_W - RADIUS);
    const ty = clamp(u.y + dy * step, RADIUS, ARENA_H - RADIUS);
    if (!this.blocked(u.x, u.y, tx, ty)) { u.x = tx; u.y = ty; return true; }
    if (!this.blocked(u.x, u.y, tx, u.y)) { u.x = tx; return true; }
    if (!this.blocked(u.x, u.y, u.x, ty)) { u.y = ty; return true; }

    // Cornered. Turn along the wall. Prefer the side the unit was already
    // sliding toward, so the turn does not oscillate between the two.
    const prefer = u.slide === -1 ? -1 : 1;
    for (const s of [prefer, -prefer]) {
      const cx = clamp(u.x - dy * s * step, RADIUS, ARENA_W - RADIUS);
      const cy = clamp(u.y + dx * s * step, RADIUS, ARENA_H - RADIUS);
      if (this.blocked(u.x, u.y, cx, cy)) continue;
      u.x = cx;
      u.y = cy;
      u.slide = s;
      return true;
    }
    u.slide = 0;
    return false;
  }

  blocked(x1, y1, x2, y2, pad = RADIUS) {
    for (const w of WALLS) if (segHitsBox(x1, y1, x2, y2, w, pad)) return true;
    return false;
  }

  // ---- navigation ----------------------------------------------------------
  //
  // A pure obstacle-avoidance steer has one failure mode that matters: a unit
  // walking straight at a wall slides along it forever. Wall sliding alone does
  // not fix that, because the intent keeps pointing into the wall. The fix is a
  // route: if the direct line is blocked, walk the lane graph instead.
  //
  // Cheap on purpose. One Dijkstra over ~30 nodes, and the result is cached per
  // (goal bucket) for a handful of ticks because the goals are few and static.

  nearestNode(x, y, pad = RADIUS) {
    let best = null, bd = Infinity;
    for (const n of NODES) {
      if (this.blocked(x, y, n.x, n.y, pad)) continue;
      const d = (x - n.x) ** 2 + (y - n.y) ** 2;
      if (d < bd) { bd = d; best = n; }
    }
    if (!best) {
      // Fully boxed in: fall back to the closest node regardless of sight.
      for (const n of NODES) {
        const d = (x - n.x) ** 2 + (y - n.y) ** 2;
        if (d < bd) { bd = d; best = n; }
      }
    }
    return best;
  }

  route(fromX, fromY, toX, toY) {
    // Straight shot: no need for the graph at all.
    if (!this.blocked(fromX, fromY, toX, toY, RADIUS + 2)) return [{ x: toX, y: toY }];

    const start = this.nearestNode(fromX, fromY);
    const goal = this.nearestNode(toX, toY, 0);
    if (!start || !goal) return [{ x: toX, y: toY }];

    // Dijkstra on the declared edge list.
    //
    // Ties are broken by distance to the goal, not by iteration order. Breaking
    // them by array order makes the search depend on where a node happens to be
    // declared, which is not symmetric about the map: one team then consistently
    // gets the exposed flank and the other gets the covered one. Under mirror
    // matches that shows up as a large, entirely artificial side advantage.
    const goalX = goal.x, goalY = goal.y;
    const toGoal = (id) => {
      const n = NODES.find((x) => x.id === id);
      return (n.x - goalX) ** 2 + (n.y - goalY) ** 2;
    };
    const dist = new Map(NODES.map((n) => [n.id, Infinity]));
    const prev = new Map();
    dist.set(start.id, 0);
    const open = new Set(NODES.map((n) => n.id));
    while (open.size) {
      let cur = null, cd = Infinity, cGoal = Infinity;
      for (const id of open) {
        const d = dist.get(id);
        if (d === Infinity) continue;
        const g = toGoal(id);
        if (d < cd || (d === cd && g < cGoal)) { cd = d; cGoal = g; cur = id; }
      }
      if (cur === null) break;
      if (cur === goal.id) break;
      open.delete(cur);
      const node = NODES.find((n) => n.id === cur);
      for (const [a, b] of EDGES) {
        const other = a === cur ? b : b === cur ? a : null;
        if (!other || !open.has(other)) continue;
        const on = NODES.find((n) => n.id === other);
        const nd = cd + Math.hypot(node.x - on.x, node.y - on.y);
        if (nd < dist.get(other)) { dist.set(other, nd); prev.set(other, cur); }
      }
    }
    if (!prev.has(goal.id) && goal.id !== start.id) return [{ x: toX, y: toY }];

    const path = [];
    let cur = goal.id;
    while (cur !== undefined) {
      const n = NODES.find((x) => x.id === cur);
      path.unshift({ x: n.x, y: n.y });
      if (cur === start.id) break;
      cur = prev.get(cur);
    }
    path.shift(); // the first node is where we already are
    path.push({ x: toX, y: toY });
    return path;
  }

  // Steering target for this tick: follow the current waypoint, and recompute the
  // route when the goal moves far enough to matter.
  //
  // Stuck detection is not optional. A waypoint can sit just inside a wall pad,
  // or just beyond a corner, and the unit then pushes into geometry forever
  // while the route keeps handing it the same unreachable point. Watching for
  // "no progress" and skipping the waypoint is what keeps a match from
  // degenerating into four statues.
  steerTo(u, gx, gy, scale = 1) {
    u.navGoalX = gx;
    u.navGoalY = gy;

    const movedEnough = Math.hypot(u.x - u.navLastX, u.y - u.navLastY) > 14;
    if (movedEnough) { u.navStuck = 0; u.navLastX = u.x; u.navLastY = u.y; }
    else u.navStuck = (u.navStuck ?? 0) + 1;

    const needPath = !u.navPath
      || u.navRepath <= 0
      || Math.hypot(gx - u.navGoalPrevX, gy - u.navGoalPrevY) > 40
      || u.navStuck > 8;
    if (needPath) {
      u.navPath = this.route(u.x, u.y, gx, gy);
      u.navWp = 0;
      u.navRepath = 12;
      u.navStuck = 0;
      u.navLastX = u.x;
      u.navLastY = u.y;
      u.navGoalPrevX = gx;
      u.navGoalPrevY = gy;
    }
    u.navRepath--;

    const wpFor = () => u.navPath[Math.min(u.navWp, u.navPath.length - 1)];
    // Skip waypoints already reached.
    while (u.navWp < u.navPath.length - 1 && Math.hypot(u.x - wpFor().x, u.y - wpFor().y) < 26) u.navWp++;
    // Stuck against a waypoint we cannot reach: abandon it and take the next.
    if (u.navStuck > 8 && u.navWp < u.navPath.length - 1) u.navWp++;

    const wp = wpFor();
    this.moveIntent(u, wp.x, wp.y, scale);
    return wp;
  }

  separate() {
    const alive = this.units.filter((u) => u.alive);
    // Accumulate displacements and apply them at the end. Applying each push as
    // it is computed makes the result depend on the order units happen to be
    // stored in, and blue units are stored first, so mirrored matches resolve
    // overlap slightly differently for each side.
    const push = new Map();
    const add = (u, dx, dy) => {
      const p = push.get(u.id) ?? { dx: 0, dy: 0 };
      p.dx += dx;
      p.dy += dy;
      push.set(u.id, p);
    };
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.001;
        const min = RADIUS * 2;
        if (d >= min) continue;
        const amount = (min - d) / 2;
        add(a, -(dx / d) * amount, -(dy / d) * amount);
        add(b, (dx / d) * amount, (dy / d) * amount);
      }
    }
    for (const u of alive) {
      const p = push.get(u.id);
      if (!p) continue;
      u.x += p.dx;
      u.y += p.dy;
    }
    // Separation and spawning can shove a unit inside geometry. A unit whose
    // center is inside a wall can never satisfy a collision test again, so it
    // would be frozen for the rest of the match. Evict along the shortest exit.
    for (const u of alive) this.evictFromWalls(u);
  }

  evictFromWalls(u) {
    for (const w of WALLS) {
      const pad = RADIUS;
      if (u.x <= w.x - pad || u.x >= w.x + w.w + pad) continue;
      if (u.y <= w.y - pad || u.y >= w.y + w.h + pad) continue;
      const left = u.x - (w.x - pad);
      const right = (w.x + w.w + pad) - u.x;
      const up = u.y - (w.y - pad);
      const down = (w.y + w.h + pad) - u.y;
      const m = Math.min(left, right, up, down);
      if (m === left) u.x = w.x - pad;
      else if (m === right) u.x = w.x + w.w + pad;
      else if (m === up) u.y = w.y - pad;
      else u.y = w.y + w.h + pad;
    }
  }

  // Score at the end. Captures first, then kills as the tiebreak. A tie is a
  // draw, and the promotion gate treats draws as no evidence.
  result() {
    const blue = this.teams.blue.score;
    const red = this.teams.red.score;
    const b = blue * 10 + this.teams.blue.kills;
    const r = red * 10 + this.teams.red.kills;
    let win = 0;
    if (b > r) win = 1;
    else if (r > b) win = -1;
    return {
      win, score: [blue, red],
      points: [b, r],
      kills: [this.teams.blue.kills, this.teams.red.kills],
      returns: [this.teams.blue.returns, this.teams.red.returns],
      ticks: this.tick,
      blueHp: this.units.filter((u) => u.team === 'blue').reduce((s, u) => s + u.hp, 0),
      redHp: this.units.filter((u) => u.team === 'red').reduce((s, u) => s + u.hp, 0),
    };
  }

  finished() {
    return this.tick >= this.maxTicks
      || this.teams.blue.score >= CAPTURES_TO_WIN
      || this.teams.red.score >= CAPTURES_TO_WIN;
  }

  runToEnd() {
    while (!this.finished()) this.step();
    return this.result();
  }

  snapshot() {
    return {
      tick: this.tick,
      scores: { blue: this.teams.blue.score, red: this.teams.red.score },
      flags: {
        blue: { state: this.flags.blue.state, x: this.flags.blue.x, y: this.flags.blue.y },
        red: { state: this.flags.red.state, x: this.flags.red.x, y: this.flags.red.y },
      },
      units: this.units.map((u) => ({
        id: u.id, team: u.team, x: u.x, y: u.y, hp: u.hp, ammo: u.ammo,
        alive: u.alive, ctx: u.ctx, lastAction: u.lastAction, reloading: u.reloading > 0,
        shield: u.shield > 0, aimAngle: u.aimAngle, carrying: !!u.carrying,
      })),
    };
  }
}

export function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export { ramp, decide, gateContext, CTX_DEFAULT };