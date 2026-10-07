// Controllers: the things that turn features into action indices.
//
// Everything downstream of this file only cares about the interface
// `decide(arena, unit) -> actionIndex`, which is what makes the league
// format-agnostic. A brain, the scripted bot, a random walk, and the human
// playing in the browser are all interchangeable opponents.

import { decide, gateContext, CTX_DEFAULT, ramp } from '../../../sdk/js/s1.js';
import { ACTIONS, CAPTURE, TICK_RATE } from './arena.js';

const fbuf = new Float64Array(16);
const ACTION_INDEX = Object.fromEntries(ACTIONS.map((n, i) => [n, i]));

/**
 * Scripted baseline: rule-based, hand-written, never learns. This is the bar a
 * fresh brain has to clear to be worth shipping. Also useful as the replay
 * opponent when measuring "did we actually reach human level".
 */
export function scriptedController(unit) {
  const a = this.arena;
  const f = a.observe(unit, fbuf);
  const A = ACTION_INDEX;
  const vis = f[1] > 0;
  const enemies = a.enemiesOf(unit).length;
  const hurt = f[2] < -0.25;
  // Use the real capture radius, not a threshold on objective_dist. A fuzzy
  // feature threshold makes bots park short of the point and stalemate.
  const onPoint = Math.hypot(unit.x - CAPTURE.x, unit.y - CAPTURE.y) <= CAPTURE.r + 8;

  // Empty is the only reason to stand still: walking while reloading is free.
  if (unit.ammo === 0 || unit.reloading > 0) return A.reload;

  if (vis && hurt && enemies >= 2) return A.retreat;
  if (vis && unit.cd <= 0 && enemies >= 2) return A.use_ability;
  if (vis && !onPoint) return A.peek;

  // No line of sight. Hold the point if we own it, otherwise push.
  // We own the point and nobody is in range: sit on it. Wandering off is how
  // you hand the objective back.
  if (onPoint) return A.hold;
  return A.advance;
}

/** Random walk. Floor of the ladder, and a sanity check that the sim actually has skill gradient. */
export function randomController() {
  return Math.floor(this.rng() * 7);
}

/** Empty brain: fires the first action always. Proves the tensor plumbing before any learning happens. */
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
    const arch = archetypeFor ? archetypeFor(unit) : 0;
    let act = decide(brain, f, arch, ctx).action;

    if (humanizer) {
      // Reaction lag: hold the previous action until the humanizer says the
      // switch may happen now. Deterministic per unit so matches replay.
      const gate = humanizer.reactionGate(unit, act, this.tick);
      if (!gate) act = unit.lastApplied ?? act;
      else unit.lastApplied = act;
      act = humanizer.distort(act, arch, this.rng);
    }
    unit.arch = arch;
    unit.ctxSnapshot = ctx;
    unit.features = Array.from(f.slice(0, brain.nF));
    return act;
  };
}

/**
 * The difficulty dial. One parameter drives reaction delay, aim error, and
 * mistake rate, so the same champion feels easy on low and superhuman on
 * high. Aim error is applied by the controller as a persistent angular bias,
 * which is a stand-in for a real aim model the game would own.
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
    aimErrDeg: L * 7,
    reactionGate(unit, act, tick) {
      let st = state.get(unit.id);
      if (!st) { st = { pending: act, since: tick }; state.set(unit.id, st); }
      if (act === st.pending) return true;
      if (tick - st.since >= this.reactionTicks) { st.pending = act; st.since = tick; return true; }
      return false;
    },
    distort(act, arch, rng) {
      // Snipers are steadier; entries are twitchier. Archetype modulates the
      // mistake rate so the humanizer is not uniform across the roster.
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