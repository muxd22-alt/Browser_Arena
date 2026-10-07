// League: Elo ratings, win rates against fixed opponents, and the promotion
// gate.
//
// Promotion is the part worth reading. The pipeline's credibility rests on
// refusing to ship a brain that only looked better, so promotion requires a
// Wilson score lower bound above a margin, not just "more wins than losses".

import { runMatch } from '../games/arena/src/match.js';
import { brainController } from '../games/arena/src/controllers.js';

export const K = 24;

export function eloExpected(rA, rB) {
  return 1 / (1 + 10 ** ((rB - rA) / 400));
}

export function updateElo(rA, rB, scoreA) {
  const ea = eloExpected(rA, rB);
  return [rA + K * (scoreA - ea), rB + K * ((1 - scoreA) - (1 - ea))];
}

/** Wilson score interval at 95%. Correct for the small-N case that naive binomial confidence gets wrong. */
export function wilson(wins, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 1, p: 0 };
  const p = wins / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return { p, lo: Math.max(0, (centre - margin) / d), hi: Math.min(1, (centre + margin) / d) };
}

export function series(spec, brain, opponent, { matches = 40, bothSides = true, humanizeLevel = null, seedBase = 1 } = {}) {
  const opts = { gated: true };
  if (humanizeLevel != null) opts.humanizer = humanizeLevel;
  const ctl = brainController(brain, opts);
  let wins = 0, draws = 0, losses = 0;
  let scoreSum = 0;
  let played = 0;
  const sides = bothSides ? ['blue', 'red'] : ['blue'];
  const per = Math.ceil(matches / sides.length);
  for (const side of sides) {
    for (let i = 0; i < per; i++) {
      const seed = seedBase + i * 7 + (side === 'red' ? 40000 : 0);
      const r = side === 'blue'
        ? runMatch({ seed, blue: ctl, red: opponent }).result
        : runMatch({ seed, blue: opponent, red: ctl }).result;
      const mine = side === 'blue' ? r.win : -r.win;
      scoreSum += (r.score[0] - r.score[1]) * (side === 'blue' ? 1 : -1);
      if (mine > 0) wins++; else if (mine < 0) losses++; else draws++;
      played++;
    }
  }
  const decided = wins + losses;
  const ci = wilson(wins, decided);
  return {
    matches: played, wins, draws, losses,
    winRate: decided ? wins / decided : 0,
    ci,
    avgScoreDiff: scoreSum / played,
  };
}

/**
 * Promotion gate. A candidate must clear the champion over enough matches that
 * the confidence interval excludes a coin flip, and it must not regress badly
 * against the human-replay proxy.
 */
export function promotionDecision(candVsChampion, candVsScripted, championVsScripted, opts = {}) {
  const { minMatches = 60, margin = 0.55, maxRegression = 0.05 } = opts;
  const reasons = [];
  const c = candVsChampion;
  if (c.matches < minMatches) reasons.push(`only ${c.matches} matches (need ${minMatches})`);
  if (c.ci.lo < margin) reasons.push(`Wilson lower bound ${c.ci.lo.toFixed(3)} below ${margin}`);
  if (c.winRate <= 0.5) reasons.push(`win rate ${c.winRate.toFixed(3)} not above 0.5`);
  const regress = championVsScripted.winRate - candVsScripted.winRate;
  if (regress > maxRegression) {
    reasons.push(`regressed vs scripted by ${regress.toFixed(3)} (> ${maxRegression})`);
  }
  return { promote: reasons.length === 0, reasons, regress };
}

export class League {
  constructor() {
    this.ratings = new Map();
    this.history = [];
  }

  rating(name, initial = 1000) {
    if (!this.ratings.has(name)) this.ratings.set(name, { name, rating: initial, played: 0 });
    return this.ratings.get(name);
  }

  submit(name, score) {
    const e = this.rating(name);
    e.rating += score;
    e.played++;
  }

  recordMatch(nameA, nameB, result) {
    const ra = this.rating(nameA);
    const rb = this.rating(nameB);
    const [na, nb] = updateElo(ra.rating, rb.rating, result);
    ra.rating = na; ra.played++;
    rb.rating = nb; rb.played++;
  }

  table() {
    return [...this.ratings.values()].sort((a, b) => b.rating - a.rating);
  }
}

export function ladder(spec, contenders, { matches = 12 } = {}) {
  const lg = new League();
  for (const c of contenders) lg.rating(c.name);
  for (let i = 0; i < contenders.length; i++) {
    for (let j = i + 1; j < contenders.length; j++) {
      const A = contenders[i], B = contenders[j];
      for (let m = 0; m < matches; m++) {
        const seed = 1 + (i * 1000 + j * 100 + m * 13);
        const r = runMatch({ seed, blue: A.controller, red: B.controller }).result;
        // Play each side from equal seeds so nobody benefits from being blue.
        lg.recordMatch(A.name, B.name, r.win > 0 ? 1 : r.win < 0 ? 0 : 0.5);
      }
    }
  }
  return { table: lg.table(), ratings: Object.fromEntries(lg.table().map((e) => [e.name, Math.round(e.rating)])) };
}