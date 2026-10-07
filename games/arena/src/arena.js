// The reference game for System One: a small tactical arena.
//
// The point of this file is that it is *ordinary game code*. It has walls,
// weapons, line of sight, a capture point, and no knowledge of System One
// beyond filling a feature vector and handling an action index. Swap it for a
// Unity scene or a Godot level and nothing else in the pipeline changes.
//
// Determinism: every random draw goes through the seeded rng, so a match is
// fully reproducible from (seed, configs). The trainer depends on that.

import { decide, gateContext, ramp, CTX_DEFAULT } from '../../../sdk/js/s1.js';

export const TICK_RATE = 20;          // sim ticks per second
export const DECISION_EVERY = 4;     // a decision every 200ms
export const MATCH_SECONDS = 60;
export const ARENA_W = 640;
export const ARENA_H = 400;

// Blockers: axis-aligned boxes the units cannot walk through and cannot see
// through. These double as the cover geometry referenced by cover_dist.
// Blockers: axis-aligned boxes the units cannot walk through and cannot see
// through. These double as the cover geometry referenced by cover_dist.
//
// Each side wall is split into two blocks so there is always a 60px lane to
// walk through. A wall that fully seals an approach turns every match into a
// stalemate, which is a level-design bug rather than an AI problem.
export const WALLS = [
  { x: 150, y: 70, w: 16, h: 100 },
  { x: 150, y: 230, w: 16, h: 100 },
  { x: 474, y: 70, w: 16, h: 100 },
  { x: 474, y: 230, w: 16, h: 100 },
  { x: 292, y: 96, w: 56, h: 16 },
  { x: 292, y: 288, w: 56, h: 16 },
];

export const CAPTURE = { x: 320, y: 200, r: 42 };

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ACTION = {
  advance: 0, hold: 1, peek: 2, retreat: 3, rotate: 4, use_ability: 5, reload: 6,
};
export const ACTIONS = ['advance', 'hold', 'peek', 'retreat', 'rotate', 'use_ability', 'reload'];
export const CONTEXTS = ['execute', 'default', 'hold', 'save'];
export const ARCHETYPES = ['entry', 'support', 'sniper'];

const SPEED = 62;          // px/s at full intent
export const RADIUS = 9;
const MAX_HP = 100;
const MAG_SIZE = 6;
const RELOAD_TICKS = 40;
const ABILITY_COOLDOWN = 100;
const SIGHT = 260;
const CAPTURE_RATE = 1;    // progress per tick per unit in the zone
const DECAY = 0.35;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }

// Segment vs axis-aligned box overlap. Used for both movement blocking and
// line of sight; good enough at this scale and cheap.
function segHitsBox(x1, y1, x2, y2, b, pad = 0) {
  const bx1 = b.x - pad, by1 = b.y - pad, bx2 = b.x + b.w + pad, by2 = b.y + b.h + pad;
  if (x1 >= bx1 && x1 <= bx2 && y1 >= by1 && y1 <= by2) return true;
  if (x2 >= bx1 && x2 <= bx2 && y2 >= by1 && y2 <= by2) return true;
  // Liang-Barsky
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - bx1, bx2 - x1, y1 - by1, by2 - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue; }
    const r = q[i] / p[i];
    if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

export function lineOfSight(ax, ay, bx, by) {
  for (const w of WALLS) if (segHitsBox(ax, ay, bx, by, w)) return false;
  return true;
}

export class Arena {
  /**
   * @param {object} opts
   * @param {number} opts.seed
   * @param {object} opts.blue  { name, brain?, archetype?, src? }
   * @param {object} opts.red   same
   * @param {number} [opts.seconds]
   */
  constructor({ seed = 1, blue, red, seconds = MATCH_SECONDS, teamSize = 3 } = {}) {
    this.rng = mulberry32(seed >>> 0);
    this.tick = 0;
    this.maxTicks = seconds * TICK_RATE;
    this.teamSize = teamSize;
    this.capture = { owner: -1, progress: 0 };
    this.log = [];
    this.events = [];
    this.teams = {
      blue: { name: blue?.name ?? 'blue', cfg: blue ?? {}, score: 0, kills: 0 },
      red: { name: red?.name ?? 'red', cfg: red ?? {}, score: 0, kills: 0 },
    };
    this.units = [];
    let uid = 0;
    for (const team of ['blue', 'red']) {
      const n = team === 'blue' ? teamSize : teamSize;
      for (let i = 0; i < n; i++) {
        this.units.push(this.spawn(team, i, uid++));
      }
    }
  }

  spawn(team, i, uid) {
    const x = team === 'blue' ? 40 + i * 26 : ARENA_W - 40 - i * 26;
    const y = ARENA_H / 2 + (i - 1) * 70 + (this.rng() - 0.5) * 12;
    return {
      id: uid,
      team,
      idx: i,
      x, y,
      aimX: team === 'blue' ? CAPTURE.x : 0,
      aimY: team === 'blue' ? CAPTURE.y : ARENA_H,
      hp: MAX_HP,
      ammo: MAG_SIZE,
      reloading: 0,
      cd: 0,
      shield: 0,
      alive: true,
      ctx: CTX_DEFAULT,
      ctxSince: 0,
      lastAction: ACTION.hold,
      damageTaken: 0,
      damageDealt: 0,
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

  // Distance to the nearest wall edge, clamped. cover_dist wants "how close am
  // I to something I can hide behind", so this is edge distance.
  coverDistance(u) {
    let best = Infinity;
    for (const w of WALLS) {
      const dx = Math.max(w.x - u.x, 0, u.x - (w.x + w.w));
      const dy = Math.max(w.y - u.y, 0, u.y - (w.y + w.h));
      best = Math.min(best, Math.hypot(dx, dy));
    }
    // Arena border counts as cover too.
    best = Math.min(best, u.x, ARENA_W - u.x, u.y, ARENA_H - u.y);
    return best;
  }

  canSee(u, o) {
    return dist(u.x, u.y, o.x, o.y) <= SIGHT && lineOfSight(u.x, u.y, o.x, o.y);
  }

  visibleEnemies(u) {
    return this.enemiesOf(u).filter((o) => this.canSee(u, o));
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

    out[0] = 1 - 2 * clamp(ne.d / SIGHT, 0, 1);                       // enemy_dist
    out[1] = vis.length > 0 ? 1 : -1;                                  // enemy_visible
    out[2] = 2 * clamp(u.hp / MAX_HP, 0, 1) - 1;                       // hp
    out[3] = 2 * clamp(u.ammo / MAG_SIZE, 0, 1) - 1;                   // ammo
    out[4] = 1 - 2 * clamp(this.coverDistance(u) / 160, 0, 1);        // cover_dist
    out[5] = 1 - 2 * clamp(dist(u.x, u.y, CAPTURE.x, CAPTURE.y) / 360, 0, 1); // objective_dist
    out[6] = 2 * clamp(allies / Math.max(1, this.teamSize - 1), 0, 1) - 1;     // allies_alive
    out[7] = 1 - 2 * clamp(enemies / Math.max(1, this.teamSize), 0, 1);         // enemies_alive
    out[8] = u.cd <= 0 ? 1 : -1;                                       // ability_ready
    const left = 1 - this.tick / this.maxTicks;
    out[9] = 2 * clamp(left, 0, 1) - 1;                                // time_left
    return out;
  }

  // Gate inputs live on the same feature vector, which is why the gate costs
  // no extra bytes of game-specific code on the engine side.
  gateInputs(u, f) {
    const pressure = 0.5 * (f[1] * 0.5 + 0.5) + 0.5 * ramp(f[0]);      // threat near me
    const advantage = 0.5 * (f[6] - f[7]) + 0.5 * f[2];                 // bodies vs hp
    return [clamp(pressure * 2 - 1, -1, 1), clamp(advantage, -1, 1)];
  }

  // -------------------------------------------------------------------------
  // Contract 1: action dispatch. Intent -> the game's own controllers.
  // -------------------------------------------------------------------------
  act(u, a) {
    const name = ACTIONS[a] ?? 'hold';
    u.lastAction = a;
    switch (name) {
      case 'advance': this.moveIntent(u, CAPTURE.x, CAPTURE.y, 1.0, this.nearestEnemy(u).unit); break;
      case 'hold': this.moveIntent(u, u.x, u.y, 0); break;
      case 'peek': this.peek(u); break;
      case 'retreat': this.retreat(u); break;
      case 'rotate': this.rotate(u); break;
      case 'use_ability':
        if (u.cd <= 0) { u.cd = ABILITY_COOLDOWN; u.shield = 24; this.chargeToward(u, CAPTURE.x, CAPTURE.y, 1.0); }
        break;
      case 'reload':
        // Only *start* a reload. Re-arming the timer on every reissued intent
        // makes a reloading unit reload forever, since the decision cadence is
        // shorter than the reload.
        if (u.ammo < MAG_SIZE && u.reloading <= 0) u.reloading = RELOAD_TICKS;
        break;
      default: break;
    }
  }

  moveIntent(u, tx, ty, scale = 1, lead = null) {
    let ax = tx - u.x, ay = ty - u.y;
    if (lead) { ax += (lead.x - u.x) * 0.35; ay += (lead.y - u.y) * 0.35; }
    const m = Math.hypot(ax, ay) || 1;
    u.aimX = tx; u.aimY = ty;
    u.intentX = (ax / m) * scale;
    u.intentY = (ay / m) * scale;
    u.moving = scale > 0.05;
  }

  chargeToward(u, tx, ty, scale) { this.moveIntent(u, tx, ty, scale); }

  peek(u) {
    const { unit: e } = this.nearestEnemy(u);
    if (!e) return this.moveIntent(u, u.x, u.y, 0);
    // Step sideways out of cover, keeping the enemy roughly in front.
    const dx = e.x - u.x, dy = e.y - u.y;
    const m = Math.hypot(dx, dy) || 1;
    const sx = -dy / m, sy = dx / m;
    const dir = (u.id % 2 === 0) ? 1 : -1;
    this.moveIntent(u, u.x + sx * dir * 40, u.y + sy * dir * 40, 0.85, e);
  }

  retreat(u) {
    const { unit: e } = this.nearestEnemy(u);
    if (!e) return this.moveIntent(u, u.x, u.y, 0);
    const dx = u.x - e.x, dy = u.y - e.y;
    const m = Math.hypot(dx, dy) || 1;
    // Back toward the nearest wall, away from the threat.
    let best = null, bd = Infinity;
    for (const w of WALLS) {
      const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
      const d = dist(u.x, u.y, cx, cy);
      if (d < bd) { bd = d; best = { x: cx, y: cy }; }
    }
    const tx = best ? best.x : u.x + dx / m * 60;
    const ty = best ? best.y : u.y + dy / m * 60;
    this.moveIntent(u, tx, ty, 1.0);
    u.aimX = e.x; u.aimY = e.y;
  }

  rotate(u) {
    // Swap with the most exposed ally: move to their flank.
    const allies = this.alliesOf(u);
    if (!allies.length) return this.moveIntent(u, CAPTURE.x, CAPTURE.y, 1.0);
    let target = allies[0], worst = -1;
    for (const a of allies) {
      const { d } = this.nearestEnemy(a);
      const exposed = a.ammo < 2 ? a.hp / 10 + d / 10 : d / 40;
      if (exposed > worst) { worst = exposed; target = a; }
    }
    const dx = target.x - u.x, dy = target.y - u.y;
    const m = Math.hypot(dx, dy) || 1;
    this.moveIntent(u, target.x - (dx / m) * 46, target.y - (dy / m) * 46, 1.0);
  }

  // -------------------------------------------------------------------------
  // tick
  // -------------------------------------------------------------------------
  step() {
    this.tick++;
    const dt = 1 / TICK_RATE;

    for (const u of this.units) {
      if (!u.alive) continue;
      u.ctxSince++;
      if (u.reloading > 0) { u.reloading--; if (u.reloading === 0) u.ammo = MAG_SIZE; }
      if (u.cd > 0) u.cd--;
      if (u.shield > 0) u.shield--;

      // Movement from the last dispatched intent.
      const ix = u.intentX ?? 0, iy = u.intentY ?? 0;
      const im = Math.hypot(ix, iy);
      if (im > 0.05) this.moveWithSlide(u, ix / im, iy / im, SPEED * dt);

      // Firing: only if we chose a combat intent and we can see someone.
      if (u.ammo > 0 && u.reloading <= 0 && u.lastAction !== ACTION.retreat && u.lastAction !== ACTION.reload) {
        const targets = this.visibleEnemies(u);
        if (targets.length) {
          const t = targets[0];
          // Base hit chance from range; cover_dist-style protection on the target.
          const d = dist(u.x, u.y, t.x, t.y);
          const p = clamp(0.62 - 0.35 * (d / SIGHT), 0.06, 0.75);
          const blocked = !lineOfSight(u.x, u.y, t.x, t.y);
          if (!blocked && this.rng() < p) {
            this.applyDamage(t, 14 + this.rng() * 6, u);
          }
          u.ammo--;
          if (u.ammo === 0) u.reloading = RELOAD_TICKS;
        }
      }
    }

    // Objective.
    let blueIn = 0, redIn = 0;
    for (const u of this.units) {
      if (!u.alive) continue;
      if (dist(u.x, u.y, CAPTURE.x, CAPTURE.y) <= CAPTURE.r) {
        if (u.team === 'blue') blueIn++; else redIn++;
      }
    }
    if (blueIn > 0 && redIn === 0) this.capture.progress += (CAPTURE_RATE * blueIn) / this.maxTicks * 12;
    else if (redIn > 0 && blueIn === 0) this.capture.progress -= (CAPTURE_RATE * redIn) / this.maxTicks * 12;
    else this.capture.progress *= 1 - DECAY * dt;
    this.capture.progress = clamp(this.capture.progress, -1, 1);
    this.capture.owner = this.capture.progress > 0.999 ? 0 : this.capture.progress < -0.999 ? 1 : -1;

    this.separate();
    return this;
  }

  applyDamage(target, amount, source) {
    const dealt = target.shield > 0 ? amount * 0.35 : amount;
    target.hp -= dealt;
    target.damageTaken += dealt;
    source.damageDealt += dealt;
    this.events.push({ t: this.tick, kind: 'hit', src: source.id, dst: target.id, amt: dealt });
    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      this.teams[source.team].kills++;
      this.events.push({ t: this.tick, kind: 'kill', src: source.id, dst: target.id });
    }
  }

  // Walk with wall sliding. A bot that gets stuck on a crate forever is a
  // property of the navmesh, not of the policy, so the game layer absorbs it:
  // try the full step, then each axis alone, then hold for this tick.
  moveWithSlide(u, dx, dy, step) {
    const tx = clamp(u.x + dx * step, RADIUS, ARENA_W - RADIUS);
    const ty = clamp(u.y + dy * step, RADIUS, ARENA_H - RADIUS);
    if (!this.blocked(u.x, u.y, tx, ty)) { u.x = tx; u.y = ty; return true; }
    if (!this.blocked(u.x, u.y, tx, u.y)) { u.x = tx; return true; }
    if (!this.blocked(u.x, u.y, u.x, ty)) { u.y = ty; return true; }
    return false;
  }

  blocked(x1, y1, x2, y2) {
    for (const w of WALLS) if (segHitsBox(x1, y1, x2, y2, w, RADIUS)) return true;
    return false;
  }

  separate() {
    const alive = this.units.filter((u) => u.alive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.001;
        const min = RADIUS * 2;
        if (d < min) {
          const push = (min - d) / 2;
          a.x -= (dx / d) * push; a.y -= (dy / d) * push;
          b.x += (dx / d) * push; b.y += (dy / d) * push;
        }
      }
    }
    // Separation and spawning can shove a unit inside geometry. A unit whose
    // center is inside a wall can never satisfy a collision test again, so it
    // would be frozen for the rest of the match. Evict it along the shortest
    // exit axis. Cheap insurance that keeps the sim honest.
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

  // Score at end of match. Win takes the capture zone, kills are the tiebreak.
  result() {
    const blue = this.teams.blue.kills * 2 + (this.capture.owner === 0 ? 3 : 0);
    const red = this.teams.red.kills * 2 + (this.capture.owner === 1 ? 3 : 0);
    let win = 0;
    if (blue > red) win = 1;
    else if (red > blue) win = -1;
    return {
      win, score: [blue, red],
      kills: [this.teams.blue.kills, this.teams.red.kills],
      capture: this.capture.owner,
      ticks: this.tick,
      blueHp: this.units.filter((u) => u.team === 'blue').reduce((s, u) => s + u.hp, 0),
      redHp: this.units.filter((u) => u.team === 'red').reduce((s, u) => s + u.hp, 0),
    };
  }

  finished() { return this.tick >= this.maxTicks; }

  runToEnd() {
    while (!this.finished()) this.step();
    return this.result();
  }

  snapshot() {
    return {
      tick: this.tick,
      capture: { ...this.capture },
      units: this.units.map((u) => ({
        id: u.id, team: u.team, x: u.x, y: u.y, hp: u.hp, ammo: u.ammo,
        alive: u.alive, ctx: u.ctx, lastAction: u.lastAction, reloading: u.reloading > 0,
        shield: u.shield > 0, aimX: u.aimX, aimY: u.aimY,
      })),
      events: this.events.slice(-24),
    };
  }
}

export { ramp, decide, gateContext, CTX_DEFAULT };