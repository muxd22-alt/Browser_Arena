// Imitation: fit a brain to .s1d recordings with ridge-regularized least
// squares, one-vs-rest per context.
//
// Why OLS and not backprop: the policy is already linear in the features, so
// imitation is a linear system. It converges in milliseconds, has no learning
// rate to tune, and gives an exact answer instead of a noisy one. The
// expensive part of the pipeline is self-play, not the fit.

import { specHash } from '../sdk/js/s1.js';
import { dataset } from '../sdk/js/s1d.js';

/**
 * Solve (X^T X + lambda I) w = X^T y for one output by Gaussian elimination
 * with partial pivoting. n is tiny (contexts * actions * features <= ~300
 * unknowns split per action), so dense elimination is the right call.
 */
export function ridgeSolve(X, y, lambda) {
  const n = X.length, d = X[0].length;
  const A = Array.from({ length: d }, () => new Float64Array(d + 1));
  for (let i = 0; i < n; i++) {
    const xi = X[i];
    const yi = y[i];
    for (let r = 0; r < d; r++) {
      const xr = xi[r];
      if (xr === 0) continue;
      const row = A[r];
      for (let c = r; c < d; c++) row[c] += xr * xi[c];
      row[d] += xr * yi;
    }
  }
  for (let r = 0; r < d; r++) A[r][r] += lambda;
  for (let c = 0; c < d; c++) {
    let piv = c;
    for (let r = c + 1; r < d; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) continue;
    const t = A[c]; A[c] = A[piv]; A[piv] = t;
    const p = A[c][c];
    for (let k = c; k <= d; k++) A[c][k] /= p;
    for (let r = 0; r < d; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f === 0) continue;
      for (let k = c; k <= d; k++) A[r][k] -= f * A[c][k];
    }
  }
  const w = new Float32Array(d);
  for (let r = 0; r < d; r++) w[r] = A[r][d];
  return w;
}

/**
 * @param {object} spec        game.s1.json
 * @param {Array}  recordings  parsed .s1d objects
 * @param {object} opts
 * @returns {{brain, accuracy, coverage}} int8-ready weights plus honest stats
 */
export function imitate(spec, recordings, opts = {}) {
  const {
    lambda = 0.6,
    humanWeight = 3,
    scriptedWeight = 2,
    selfplayWeight = 1,
    minPerContext = 24,
    minPerArchetype = 24,
  } = opts;

  const nF = spec.features.length;
  const nA = spec.actions.length;
  const nC = spec.contexts.length;
  const nArch = spec.archetypes.length;
  const ds = dataset(recordings, { humanWeight, scriptedWeight, selfplayWeight });

  const brain = {
    hash: specHash(spec), nF, nA, nC, nArch,
    gateCount: 4, gated: true,
    w: new Float32Array(nC * nA * nF),
    archBias: new Float32Array(nArch * nA),
    thresholds: Float32Array.from([
      spec.gate.thresholds[0], spec.gate.thresholds[1],
      spec.gate.thresholds[2], spec.gate.thresholds[3],
    ]),
    scale: new Float32Array(nF).fill(1),
    biasScale: 1,
  };
  brain.minDwellTicks = Math.round((spec.gate.min_dwell_s ?? 0.5) * (spec.sim?.tick_rate ?? 20));

  if (ds.n === 0) {
    return { brain, accuracy: 0, coverage: { contexts: 0, archetypes: 0 }, samples: 0, bySource: ds.bySource };
  }

  // One-vs-rest: for each action we fit a hyperplane separating the samples
  // that took it from the samples that did not. Every action sees *all* rows in
  // its group, which is what makes the argmax over actions meaningful. Fitting
  // each action against only its own positives would produce scores that are
  // not comparable.
  const byContext = Array.from({ length: nC }, () => []);
  const byArchetype = Array.from({ length: nArch }, () => []);
  for (let i = 0; i < ds.n; i++) {
    const f = ds.X[i];
    byContext[ds.ctx[i] | 0].push({ f, y: ds.Y[i] });
    byArchetype[ds.arch[i] | 0].push({ f, y: ds.Y[i] });
  }
  const all = [];
  for (let i = 0; i < ds.n; i++) all.push({ f: ds.X[i], y: ds.Y[i] });

  // Pooled fit is the fallback for sparse groups: it gives every action a sane
  // ranking even when a context or archetype has almost no data.
  const pooledW = [];
  for (let a = 0; a < nA; a++) {
    pooledW.push(ridgeSolve(all.map((r) => r.f), all.map((r) => (r.y === a ? 1 : -1)), lambda));
  }

  let correct = 0, counted = 0;
  const contextSeen = new Set();

  for (let c = 0; c < nC; c++) {
    const group = byContext[c];
    if (group.length < minPerContext) {
      for (let a = 0; a < nA; a++) {
        const base = (c * nA + a) * nF;
        for (let i = 0; i < nF; i++) brain.w[base + i] = pooledW[a][i];
      }
      continue;
    }
    contextSeen.add(c);
    const X = group.map((r) => r.f);
    for (let a = 0; a < nA; a++) {
      const y = group.map((r) => (r.y === a ? 1 : -1));
      const w = ridgeSolve(X, y, lambda);
      const base = (c * nA + a) * nF;
      for (let i = 0; i < nF; i++) brain.w[base + i] = w[i];
    }
  }

  // Archetype bias: a per-role action preference. Solved on the same rows with
  // a constant column, so the intercept alone carries the preference and the
  // slope part stays available if a role genuinely wants different features.
  for (let ar = 0; ar < nArch; ar++) {
    const group = byArchetype[ar];
    if (group.length < minPerArchetype) continue;
    const X = group.map((r) => [1, ...r.f]);
    for (let a = 0; a < nA; a++) {
      const y = group.map((r) => (r.y === a ? 1 : -1));
      const w = ridgeSolve(X, y, lambda);
      brain.archBias[ar * nA + a] = w[0];
    }
  }

  // Report accuracy on held-out-by-construction fit, i.e. argmax agreement on
  // the training set. Enough to catch a broken fit, not a claim of quality.
  for (let i = 0; i < ds.n; i++) {
    const f = ds.X[i];
    const c = ds.ctx[i] | 0;
    const ar = ds.arch[i] | 0;
    let best = -1, bs = -Infinity;
    for (let a = 0; a < nA; a++) {
      let s = brain.archBias[ar * nA + a] * brain.scale[0];
      const base = (c * nA + a) * nF;
      for (let k = 0; k < nF; k++) s += f[k] * brain.w[base + k] * brain.scale[k];
      if (s > bs) { bs = s; best = a; }
    }
    if (best === ds.Y[i]) correct++;
    counted++;
  }

  return {
    brain,
    accuracy: counted ? correct / counted : 0,
    samples: ds.n,
    bySource: ds.bySource,
    coverage: {
      contexts: contextSeen.size,
      archetypes: nArch,
      sparseContexts: nC - contextSeen.size,
    },
  };
}