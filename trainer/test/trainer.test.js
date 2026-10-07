import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ridgeSolve, imitate } from '../imitate.js';
import { wilson, promotionDecision, updateElo, eloExpected, series, ladder } from '../league.js';
import { evolve, brainToVector, vectorToBrain, quantize } from '../evolve.js';
import { parseS1d, Recorder } from '../../sdk/js/s1d.js';
import { unpackBrain, specHash, brainBytes } from '../../sdk/js/s1.js';
import { scriptedController, randomController, brainController, humanizer } from '../../games/arena/src/controllers.js';
import { runMatch } from '../../games/arena/src/match.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const spec = JSON.parse(readFileSync(join(root, 'games/arena/game.s1.json'), 'utf8'));

test('ridgeSolve recovers a known linear system', () => {
  // y = 2x0 - 3x1 + 1. The design matrix has no intercept, so the constant is
  // not identifiable; the slopes are, and that is what drives the argmax.
  const X = [[1, 0], [0, 1], [1, 1], [1, -1], [2, 1], [-1, 2]];
  const w = ridgeSolve(X, X.map(([a, b]) => 2 * a - 3 * b), 1e-9);
  assert.ok(Math.abs(w[0] - 2) < 1e-3, `w0=${w[0]}`);
  assert.ok(Math.abs(w[1] + 3) < 1e-3, `w1=${w[1]}`);
  for (const [a, b] of X) {
    const pred = a * w[0] + b * w[1];
    assert.ok(Math.abs(pred - (2 * a - 3 * b)) < 1e-3, `residual for [${a},${b}]`);
  }
});

test('ridgeSolve stays finite on a singular system', () => {
  const X = [[1, 1], [1, 1], [1, 1]];
  const w = ridgeSolve(X, [1, 1, 1], 1.0);
  assert.ok(w.every(Number.isFinite), 'singular system must not produce NaN');
});

test('imitate returns a brain that matches the spec layout and beats chance', () => {
  const chunks = [];
  for (let s = 1; s <= 4; s++) {
    const { recording } = runMatch({
      seed: 500 + s, blue: scriptedController, red: randomController,
      record: { src: 'scripted', which: 'blue' },
    });
    chunks.push(recording);
  }
  const parsed = chunks.map(parseS1d);
  const out = imitate(spec, parsed, { lambda: 0.5 });
  assert.equal(out.brain.nF, spec.features.length);
  assert.equal(out.brain.nA, spec.actions.length);
  assert.equal(out.brain.nC, spec.contexts.length);
  assert.equal(out.brain.hash, specHash(spec));
  assert.ok(out.samples > 500, `expected plenty of samples, got ${out.samples}`);
  assert.ok(out.accuracy > 0.4, `argmax agreement ${out.accuracy} should beat 1/7`);
  // The imitation brain must actually be usable as a controller.
  const ctl = brainController(out.brain);
  const r = runMatch({ seed: 9, blue: ctl, red: scriptedController }).result;
  assert.ok(Number.isFinite(r.blueHp));
  const packed = quantize(spec, out.brain);
  assert.ok(brainBytes(packed) <= spec.budget_bytes);
});

test('imitate survives an empty dataset', () => {
  const out = imitate(spec, []);
  assert.equal(out.samples, 0);
  assert.equal(out.accuracy, 0);
  assert.ok(out.brain.w.length > 0);
});

test('imitate weights human data more heavily than self-play', () => {
  const mk = (src, action) => {
    const r = new Recorder({ src });
    for (let i = 0; i < 40; i++) r.step(i, 0, 0, [0.5, 1, 0.5, 0.5, 0, 0, 0, 0, 1, 0], 1, action);
    return parseS1d(r.toText());
  };
  const out = imitate(spec, [mk('human', 6), mk('selfplay', 0)], { lambda: 0.2 });
  // With human "reload" data and self-play "advance" data, the heavier human
  // weight should pull the fit toward reload.
  const ctx = 1;
  const base = (ctx * spec.actions.length + 6) * spec.features.length;
  const advBase = (ctx * spec.actions.length + 0) * spec.features.length;
  assert.ok(out.brain.w[base + 3] > out.brain.w[advBase + 3],
    'ammo weight should favor reload under human weighting');
});

test('wilson interval brackets the point estimate and handles edges', () => {
  const a = wilson(30, 60);
  assert.ok(a.lo < a.p && a.p < a.hi);
  assert.ok(a.lo > 0.3 && a.hi < 0.7, `tight interval expected, got ${a.lo}-${a.hi}`);
  const none = wilson(0, 0);
  assert.equal(none.lo, 0);
  assert.equal(none.hi, 1);
  // At the extremes the Wilson interval is asymmetric: a perfect record still
  // has some doubt attached, which is the whole reason to use it over a
  // binomial interval.
  const all = wilson(20, 20);
  assert.ok(all.lo > 0.8 && all.lo < 1, `lo=${all.lo}`);
  assert.ok(all.hi > 0.99 && all.hi <= 1, `hi=${all.hi}`);
  const none2 = wilson(0, 20);
  assert.ok(Math.abs(none2.hi - 0.1611) < 1e-3, `hi=${none2.hi}`);
  assert.equal(none2.lo, 0);
});

test('elo is symmetric and moves toward the winner', () => {
  assert.ok(Math.abs(eloExpected(1000, 1000) - 0.5) < 1e-9);
  const [a, b] = updateElo(1000, 1000, 1);
  assert.ok(a > 1000 && b < 1000);
  assert.ok(Math.abs((a - 1000) + (b - 1000)) < 1e-9, 'elo transfer must be zero-sum');
});

test('promotion refuses a coin flip and accepts a clear win', () => {
  const coinflip = {
    matches: 200, wins: 100, losses: 100, draws: 0, winRate: 0.5,
    ci: wilson(100, 200), avgScoreDiff: 0,
  };
  const d1 = promotionDecision(coinflip, coinflip, coinflip);
  assert.equal(d1.promote, false);
  assert.match(d1.reasons.join(' '), /Wilson lower bound/);

  const clear = {
    matches: 200, wins: 140, losses: 60, draws: 0, winRate: 0.7,
    ci: wilson(140, 200), avgScoreDiff: 3,
  };
  const d2 = promotionDecision(clear, clear, clear);
  assert.equal(d2.promote, true, d2.reasons.join('; '));

  const smallN = { ...clear, matches: 10 };
  assert.equal(promotionDecision(smallN, clear, clear, { minMatches: 60 }).promote, false);
});

test('promotion blocks a candidate that regresses against the scripted bar', () => {
  const strong = { matches: 100, wins: 70, losses: 30, draws: 0, winRate: 0.7, ci: wilson(70, 100), avgScoreDiff: 2 };
  const weak = { matches: 100, wins: 30, losses: 70, draws: 0, winRate: 0.3, ci: wilson(30, 100), avgScoreDiff: -2 };
  const d = promotionDecision(strong, weak, strong);
  assert.equal(d.promote, false);
  assert.match(d.reasons.join(' '), /regressed/);
});

test('evolve is monotonic and returns a legal brain', () => {
  const start = unpackBrain(Buffer.from(
    JSON.parse(readFileSync(join(root, 'spec/golden.json'), 'utf8'))
      .brains.find((b) => b.name === 'random-gated').brain_b64, 'base64'));
  const out = evolve(spec, start, {
    generations: 4, population: 4, seeds: 1, opponents: [randomController],
    onGeneration: null,
  });
  assert.equal(out.history.length, 5);
  let prev = -Infinity;
  for (const h of out.history) {
    assert.ok(h.best >= prev - 1e-9, 'best fitness must never regress');
    prev = h.best;
  }
  assert.equal(out.brain.nF, spec.features.length);
  assert.ok(brainBytes(out.brain) <= spec.budget_bytes);
  const r = runMatch({ seed: 2, blue: brainController(out.brain), red: randomController }).result;
  assert.ok(Number.isFinite(r.blueHp));
});

test('vector roundtrip preserves a brain through quantization', () => {
  const b = quantize(spec, {
    hash: specHash(spec),
    nF: spec.features.length, nA: spec.actions.length,
    nC: spec.contexts.length, nArch: spec.archetypes.length,
    gateCount: 4, gated: true,
    w: Float32Array.from({ length: 4 * 7 * 10 }, (_, i) => (i % 251) - 125),
    archBias: Float32Array.from({ length: 3 * 7 }, (_, i) => i - 10),
    thresholds: Float32Array.from([0.3, 0.1, -0.3, -0.1]),
    scale: Float32Array.from({ length: 10 }, () => 1),
    biasScale: 1,
    minDwellTicks: 12,
  });
  const back = vectorToBrain(spec, brainToVector(b));
  for (let i = 0; i < b.w.length; i++) assert.equal(back.w[i], b.w[i], `weight ${i}`);
  for (let i = 0; i < b.thresholds.length; i++) assert.equal(back.thresholds[i], b.thresholds[i]);
  assert.equal(back.nF, b.nF);
  assert.equal(back.minDwellTicks, b.minDwellTicks);
});

test('ladder ranks the scripted bot above random', () => {
  const board = ladder(spec, [
    { name: 'scripted', controller: scriptedController },
    { name: 'random', controller: randomController },
  ], { matches: 12 });
  const byName = Object.fromEntries(Object.entries(board.ratings));
  assert.ok(byName.scripted > byName.random, JSON.stringify(board.ratings));
});

test('series reports both sides so mirror bias cannot inflate a result', () => {
  const brain = unpackBrain(Buffer.from(
    JSON.parse(readFileSync(join(root, 'spec/golden.json'), 'utf8'))
      .brains.find((b) => b.name === 'champion').brain_b64, 'base64'));
  const s = series(spec, brain, scriptedController, { matches: 20, bothSides: true });
  assert.equal(s.matches, 20);
  assert.ok(s.ci.lo >= 0 && s.ci.hi <= 1);
});

test('the humanizer changes play but keeps it legal', () => {
  const brain = unpackBrain(Buffer.from(
    JSON.parse(readFileSync(join(root, 'spec/golden.json'), 'utf8'))
      .brains.find((b) => b.name === 'champion').brain_b64, 'base64'));
  const clean = runMatch({ seed: 4, blue: brainController(brain), red: scriptedController }).result;
  const sloppy = runMatch({
    seed: 4, blue: brainController(brain, { humanizer: humanizer(1, 3) }), red: scriptedController,
  }).result;
  assert.notDeepEqual(clean, sloppy, 'the difficulty dial must actually change the match');
  const a = runMatch({ seed: 4, blue: brainController(brain, { humanizer: humanizer(0.5, 3) }), red: scriptedController }).result;
  assert.ok(Number.isFinite(a.blueHp));
});