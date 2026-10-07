// Self-play: evolution strategies over the same .s1b the browser runs.
//
// Two design choices that matter:
//  1. The gate thresholds evolve too. Tuning them by hand is exactly the kind
//     of per-game work System One is supposed to remove.
//  2. Fitness is a league score, not a single match. A policy that wins one
//     seed by being lucky will not survive 30 opponents.

import { cloneBrain, packBrain, unpackBrain, specHash } from '../sdk/js/s1.js';
import { brainController, scriptedController, randomController, humanizer } from '../games/arena/src/controllers.js';
import { runMatch } from '../games/arena/src/match.js';

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function brainToVector(b) {
  return new Float32Array([
    ...b.w, ...b.archBias, ...b.thresholds,
    b.scale[0], b.scale[1], b.scale[2], b.biasScale,
  ]);
}

export function vectorToBrain(spec, v) {
  const nF = spec.features.length, nA = spec.actions.length;
  const nC = spec.contexts.length, nArch = spec.archetypes.length;
  const wN = nC * nA * nF;
  const bN = nArch * nA;
  const tN = 4;
  const b = {
    hash: specHash(spec), nF, nA, nC, nArch, gateCount: tN, gated: true,
    w: new Float32Array(wN),
    archBias: new Float32Array(bN),
    thresholds: new Float32Array(tN),
    scale: new Float32Array(nF).fill(1),
    biasScale: 1,
  };
  let o = 0;
  b.w.set(v.subarray(o, o + wN)); o += wN;
  b.archBias.set(v.subarray(o, o + bN)); o += bN;
  b.thresholds.set(v.subarray(o, o + tN)); o += tN;
  b.scale[0] = v[o++]; b.scale[1] = v[o++]; b.scale[2] = v[o++];
  b.biasScale = v[o++];
  b.minDwellTicks = Math.round((spec.gate.min_dwell_s ?? 0.5) * (spec.sim?.tick_rate ?? 20));
  return b;
}

// Round-trip through the wire format. This is deliberate: evolution operates on
// the exact int8 tensor that ships. Optimizing a float64 vector and then
// quantizing at the end optimizes something the player never runs.
export function quantize(spec, b) {
  const packed = packBrain(b);
  const u = unpackBrain(packed);
  return {
    ...b,
    w: Float32Array.from(u.w),
    archBias: Float32Array.from(u.archBias),
    thresholds: Float32Array.from(u.thresholds),
    scale: Float32Array.from(u.scale),
    biasScale: u.biasScale,
  };
}

export function evaluate(spec, brain, opponents, { seeds = 8, side = 'blue' } = {}) {
  let score = 0, wins = 0, played = 0;
  const ctl = brainController(brain, { gated: brain.gated });
  for (let i = 0; i < opponents.length; i++) {
    for (let s = 0; s < seeds; s++) {
      const seed = 1 + (i * 131 + s * 17 + (side === 'blue' ? 0 : 5000));
      const r = side === 'blue'
        ? runMatch({ seed, blue: ctl, red: opponents[i] }).result
        : runMatch({ seed, blue: opponents[i], red: ctl }).result;
      const mine = side === 'blue' ? r.win : -r.win;
      // Win 1, draw 0.35, loss 0. Margin adds a little signal on drawn matches
      // so evolution can tell a stalemate from a near-win.
      const margin = Math.abs(r.score[0] - r.score[1]);
      score += (mine + 1) / 2 + 0.02 * Math.min(margin, 6);
      if (mine > 0) wins++;
      played++;
    }
  }
  return { score: score / Math.max(1, played), winRate: wins / Math.max(1, played), played };
}

/**
 * ES with antithetic sampling and a 1+lambda accept rule.
 *
 * No gradients exist through the game, so this is gradient-free by necessity.
 * Antithetic pairs (the same noise, negated) halve the variance of the estimate
 * for free, and 1+lambda means the incumbent is only replaced by something that
 * actually scored higher against the same opponents. Sigma anneals: early on
 * the search is still mapping the landscape, late on it should be polishing.
 */
export function evolve(spec, start, opts = {}) {
  const {
    generations = 24,
    population = 8,
    sigma0 = 8,
    seed = 1234,
    opponents = [scriptedController, randomController],
    seeds = 3,
    onGeneration = null,
  } = opts;
  let sigma = sigma0;

  let base = quantize(spec, cloneBrain(start));
  const length = brainToVector(base).length;
  let best = base;
  let bestFit = evaluate(spec, base, opponents, { seeds }).score;
  const history = [{ gen: 0, fitness: bestFit, best: bestFit, accepted: true }];

  for (let g = 1; g <= generations; g++) {
    let pick = null;
    for (let i = 0; i < population; i++) {
      const sign = i % 2 === 0 ? 1 : -1;
      const dir = brainToVector(base);
      const noise = mulberry(seed + g * 977 + (i >> 1) * 31);
      for (let k = 0; k < length; k++) dir[k] += sign * sigma * (noise() * 2 - 1);
      const cand = quantize(spec, vectorToBrain(spec, dir));
      const fit = evaluate(spec, cand, opponents, { seeds }).score;
      if (!pick || fit > pick.fit) pick = { cand, fit };
    }
    let accepted = false;
    if (pick && pick.fit > bestFit) {
      best = pick.cand;
      bestFit = pick.fit;
      base = best;
      accepted = true;
    }
    sigma = Math.max(1.5, sigma * 0.94);
    history.push({ gen: g, fitness: pick ? pick.fit : bestFit, best: bestFit, accepted });
    if (onGeneration) onGeneration({ gen: g, fitness: pick ? pick.fit : bestFit, best: bestFit, accepted, sigma });
  }
  return { brain: best, fitness: bestFit, history };
}

export { humanizer };