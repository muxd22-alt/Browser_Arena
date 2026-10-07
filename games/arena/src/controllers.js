// Controllers: the things that turn features into action indices.
//
// Everything downstream of this file only cares about the interface
// `decide(arena, unit) -> actionIndex`, which is what makes the league
// format-agnostic. A brain, the scripted bot, a random walk, and the human
// playing in the browser are all interchangeable opponents.

import { decide, gateContext, CTX_DEFAULT, ramp } from '../../../sdk/js/s1.js';
import { ACTIONS, ACTION, TICK_RATE, BASES } from './arena.js';

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

const fbuf = new Float64Array(16);

/**
 * Scripted baseline: rule-based, hand-written, never learns. This is the bar a
 * fresh brain has to clear to be worth shipping, and the replay opponent for
 * "did we actually reach human level".
 *
 * The one non-obvious rule is the defence. A naive "chase the flag carrier"
 * policy is self-defeating: the instant the enemy takes your flag, every unit
 * turns around and walks home, so the enemy takes the other one too and the
 * match becomes a see-saw with no captures. Only units already near their own
 * base react, and only one of them. Everyone else keeps playing the objective.
 */
export function scriptedController(unit) {
  const a = this.arena;
  const f = a.observe(unit, fbuf);
  const A = ACTION;
  const vis = f[1] > 0;
  const enemies = a.enemiesOf(unit).length;
  const hurt = f[2] < -0.3;
  const obj = a.objectiveFor(unit);
  const dObj = dist(unit.x, unit.y, obj.x, obj.y);

  // Empty is not a reason to stop: the reload does not interrupt movement.
  if (unit.ammo === 0) return A.reload;

  // Carrying: the only goal is home.
  if (unit.carrying) {
    if (unit.hp < 22 && vis) return A.retreat;
    return A.advance;
  }

  // Defend, but only from inside our own half and only with one unit. The
  // closest unit to the threat is the defender; everyone else ignores it.
  const mine = a.flags[unit.team];
  if (mine.state === 'carried' || mine.state === 'dropped') {
    const base = BASES[unit.team];
    const near = Math.hypot(unit.x - base.x, unit.y - base.y) < 230;
    if (near && dObj < 120 && a.isDefender(unit)) {
      if (vis && unit.cd <= 0 && enemies >= 2) return A.use_ability;
      return A.advance;
    }
  }

  // Fight back when there is something to fight.
  if (vis && hurt && enemies >= 2) return A.retreat;
  if (vis && unit.cd <= 0 && enemies >= 2) return A.use_ability;
  if (vis && enemies === 1 && dObj < 220) return A.peek;

  return A.advance;
}

/** Random walk. Floor of the ladder, and a check that the sim has a real gradient. */
export function randomController() {
  return Math.floor(this.rng() * 7);
}

/** Fires the first action always. Proves the tensor plumbing before any learning happens. */
export function constantController() {
  return 0;
}

/**
 * A brain-backed controller. Optionally gated, optionally humanized.
 * This is ~20 lines; the same shape ports to C# and GDScript directly.
 */
export function brainController(brain, opts = {}) {
  const { gated = true, humanizer = null, archetypeFor = null } = opts;
  return function (unit) {
    const a = this.arena;
    const f = a.observe(unit, fbuf);

    let ctx = CTX_DEFAULT;
    if (gated && brain.gated) {
      const [p, adv] = a.gateInputs(unit, f);
      ctx = gateContext(brain, p, adv, unit.ctx, unit.ctxSince);
    }
    unit.ctx = ctx;
    const arch = archetypeFor ? archetypeFor(unit) : (unit.arch ?? 0);
    unit.features = Array.from(f.slice(0, brain.nF));
    let act = decide(brain, f, arch, ctx).action;

    const target = a.visibleEnemies(unit)[0] ?? a.nearestEnemy(unit).unit;
    if (target) {
      a.aimAt(unit, target.x, target.y);
    } else {
      const obj = a.objectiveFor(unit);
      a.aimAt(unit, obj.x, obj.y);
    }

    if (humanizer) {
      const gate = humanizer.reactionGate(unit, act, this.tick);
      if (!gate) act = unit.lastApplied ?? act;
      else unit.lastApplied = act;
      act = humanizer.distort(act, arch, this.rng);
    }
    unit.arch = arch;
    unit.ctxSnapshot = ctx;
    return act;
  };
}

/** Scripted bot running through the difficulty dial: the stand-in for a human replay. */
export function scriptedHumanized(level, seed = 1) {
  const hz = humanizer(level, seed);
  const base = scriptedController;
  return function (unit) {
    const raw = base.call(this, unit);
    return hz.distort(hz.reactionGate(unit, raw, this.tick) ? raw : (unit.lastApplied ?? raw), unit.arch ?? 0, this.rng);
  };
}

/**
 * The difficulty dial. One parameter drives reaction delay and mistake rate.
 * Aim error lives in the arena as SHOT_SPREAD applied per team at fire time,
 * which is where a real game would put its own aim model.
 */
export function humanizer(level, seed = 1) {
  const L = Math.max(0, Math.min(1, level));
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const state = new Map();
  return {
    level: L,
    reactionTicks: Math.round(L * 0.8 * TICK_RATE),
    mistakeRate: L * 0.18,
    reactionGate(unit, act, tick) {
      let st = state.get(unit.id);
      if (!st) { st = { pending: act, since: tick }; state.set(unit.id, st); }
      if (act === st.pending) return true;
      if (tick - st.since >= this.reactionTicks) { st.pending = act; st.since = tick; return true; }
      return false;
    },
    distort(act, arch, rng) {
      // Snipers hold their nerve, entries are twitchy.
      const bias = arch === 2 ? 0.5 : arch === 1 ? 0.85 : 1.15;
      if (rng() < this.mistakeRate * bias) {
        let n = Math.floor(rng() * 7);
        if (n === act) n = (n + 1) % 7;
        return n;
      }
      return act;
    },
  };
}