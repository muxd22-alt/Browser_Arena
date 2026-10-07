// System One SDK (JS).
//
// Contract 3: the brain file (.s1b) + the evaluator.
// Contract 2 helpers live in ./s1d.js.
// Contract 1 helpers (spec hash, feature slots) live here too.
//
// This file is the normative reference for the wire format. The Unity and
// Godot evaluators must reproduce `decide()` bit-for-bit on the golden
// vectors in spec/golden.json.

export const MAGIC = 'S1B1';
export const HEADER_BYTES = 16;

// FNV-1a 32-bit over a UTF-8-ish byte expansion of the string.
export function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h = Math.imul(h ^ (c & 0xff), 0x01000193) >>> 0;
    if (c > 0xff) h = Math.imul(h ^ ((c >> 8) & 0xff), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// The spec hash covers everything the brain's tensor layout depends on.
// Field order is fixed; changing it changes the hash, which makes an old
// brain refuse to load instead of silently reading garbage.
export function specHash(spec) {
  const canonical = JSON.stringify({
    id: spec.id,
    features: spec.features,
    actions: spec.actions,
    contexts: spec.contexts,
    archetypes: spec.archetypes,
    gate: { inputs: spec.gate.inputs },
  });
  return fnv1a32(canonical);
}

export function brainBytes(b) {
  return (
    HEADER_BYTES +
    b.nC * b.nA * b.nF + // weights, int8
    b.nArch * b.nA + // archetype bias, int8
    b.gateCount + // gate thresholds, int8
    b.nF * 4 + // feature scales, float32
    4 // bias scale, float32
  );
}

export function brainFitsBudget(b, spec) {
  return brainBytes(b) <= (spec.budget_bytes ?? Infinity);
}

// ---------------------------------------------------------------------------
// pack / unpack
// ---------------------------------------------------------------------------

// Layout (little endian):
//   0  magic[4]        "S1B1"
//   4  hash   u32      spec hash
//   8  nF     u8
//   9  nA     u8
//   10 nC     u8
//   11 nArch  u8
//   12 flags  u16      bit0 = gated
//   14 dwell  u16      gate minimum dwell, in sim ticks
//   16 w      i8 [nC][nA][nF]
//   .. archBias i8 [nArch][nA]
//   .. thresh    i8 [gateCount]
//   .. scale     f32 [nF]
//   .. biasScale f32
export function packBrain(b) {
  const nF = b.nF, nA = b.nA, nC = b.nC, nArch = b.nArch, g = b.gateCount;
  const buf = new ArrayBuffer(brainBytes(b));
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  for (let i = 0; i < 4; i++) u8[i] = MAGIC.charCodeAt(i);
  dv.setUint32(4, b.hash >>> 0, true);
  u8[8] = nF; u8[9] = nA; u8[10] = nC; u8[11] = nArch;
  dv.setUint16(12, b.gated ? 1 : 0, true);
  dv.setUint16(14, Math.max(0, Math.min(65535, b.minDwellTicks ?? 0)), true);
  let o = HEADER_BYTES;
  const w = b.w, ab = b.archBias, th = b.thresholds;
  for (let i = 0; i < w.length; i++) u8[o + i] = clampI8(w[i]);
  o += nC * nA * nF;
  for (let i = 0; i < ab.length; i++) u8[o + i] = clampI8(ab[i]);
  o += nArch * nA;
  for (let i = 0; i < th.length; i++) u8[o + i] = clampI8(th[i]);
  o += g;
  for (let i = 0; i < nF; i++) { dv.setFloat32(o, b.scale[i], true); o += 4; }
  dv.setFloat32(o, b.biasScale, true);
  return u8;
}

export function unpackBrain(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < HEADER_BYTES) throw new Error('s1b: too short');
  for (let i = 0; i < 4; i++) {
    if (u8[i] !== MAGIC.charCodeAt(i)) throw new Error('s1b: bad magic');
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const hash = dv.getUint32(4, true);
  const nF = u8[8], nA = u8[9], nC = u8[10], nArch = u8[11];
  const gated = (dv.getUint16(12, true) & 1) === 1;
  const nW = nC * nA * nF;
  const nB = nArch * nA;
  const gateCount = gated ? 4 : 1;
  const need = HEADER_BYTES + nW + nB + gateCount + nF * 4 + 4;
  if (u8.length < need) throw new Error('s1b: truncated body');
  let o = HEADER_BYTES;
  const w = new Int8Array(nW);
  for (let i = 0; i < nW; i++) w[i] = (u8[o + i] << 24) >> 24;
  o += nW;
  const archBias = new Int8Array(nB);
  for (let i = 0; i < nB; i++) archBias[i] = (u8[o + i] << 24) >> 24;
  o += nB;
  const thresholds = new Int8Array(gateCount);
  for (let i = 0; i < gateCount; i++) thresholds[i] = (u8[o + i] << 24) >> 24;
  o += gateCount;
  const scale = new Float32Array(nF);
  for (let i = 0; i < nF; i++) { scale[i] = dv.getFloat32(o, true); o += 4; }
  const biasScale = dv.getFloat32(o, true);
  return {
    hash, nF, nA, nC, nArch, gateCount, gated, w, archBias, thresholds, scale, biasScale,
    minDwellTicks: dv.getUint16(14, true),
    bytes: u8.length,
  };
}

export function verifyBrain(brain, spec) {
  const h = specHash(spec);
  if (brain.hash !== h) {
    throw new Error(
      `s1b: brain trained for a different spec (brain ${brain.hash.toString(16)}, spec ${h.toString(16)})`
    );
  }
  if (brain.nF !== spec.features.length) throw new Error('s1b: feature count mismatch');
  if (brain.nA !== spec.actions.length) throw new Error('s1b: action count mismatch');
  if (brain.gated && brain.nC !== spec.contexts.length) {
    throw new Error(`s1b: a gated brain must cover all ${spec.contexts.length} contexts, got ${brain.nC}`);
  }
  // Lower tiers are allowed to collapse the tensor: an ungated brain may use a
  // single shared table, and a brain may ignore archetypes entirely. What it
  // may not do is claim more contexts or archetypes than the game defines.
  if (!brain.gated && (brain.nC < 1 || brain.nC > spec.contexts.length)) {
    throw new Error('s1b: context count out of range for this spec');
  }
  if (brain.nArch < 1 || brain.nArch > spec.archetypes.length) {
    throw new Error('s1b: archetype count out of range for this spec');
  }
  return true;
}

function clampI8(v) {
  const r = Math.round(v);
  return r < -128 ? -128 : r > 127 ? 127 : r;
}

export function randBrain(spec, { gated = true, rng = Math.random } = {}) {
  const nF = spec.features.length, nA = spec.actions.length;
  const nC = spec.contexts.length, nArch = spec.archetypes.length;
  const w = new Float32Array(nC * nA * nF);
  for (let i = 0; i < w.length; i++) w[i] = (rng() * 2 - 1) * 40;
  const archBias = new Float32Array(nArch * nA);
  for (let i = 0; i < archBias.length; i++) archBias[i] = (rng() * 2 - 1) * 20;
  const thresholds = new Float32Array(gated ? 4 : 1);
  for (let i = 0; i < thresholds.length; i++) thresholds[i] = (rng() * 2 - 1) * 0.9;
  const scale = new Float32Array(nF).fill(1);
  const b = {
    hash: specHash(spec), nF, nA, nC, nArch,
    gateCount: gated ? 4 : 1, gated,
    w, archBias, thresholds, scale, biasScale: 1,
    minDwellTicks: 0,
  };
  return b;
}

export function cloneBrain(b) {
  return {
    hash: b.hash, nF: b.nF, nA: b.nA, nC: b.nC, nArch: b.nArch,
    gateCount: b.gateCount, gated: b.gated,
    w: Float32Array.from(b.w),
    archBias: Float32Array.from(b.archBias),
    thresholds: Float32Array.from(b.thresholds),
    scale: Float32Array.from(b.scale),
    biasScale: b.biasScale,
    minDwellTicks: b.minDwellTicks ?? 0,
  };
}

// ---------------------------------------------------------------------------
// the evaluator (normative)
// ---------------------------------------------------------------------------

// f: features in [-1,1], length >= nF. arch: archetype index. ctx: context index.
export function decide(b, f, arch, ctx) {
  const nA = b.nA, nF = b.nF;
  let best = -1;
  let bestScore = -Infinity;
  const biasScale = b.scale[0];
  const abase = arch * nA;
  for (let a = 0; a < nA; a++) {
    let s = b.archBias[abase + a] * biasScale;
    const row = ((ctx * nA) + a) * nF;
    for (let i = 0; i < nF; i++) s += f[i] * b.w[row + i] * b.scale[i];
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return { action: best, score: bestScore };
}

export function scoreAll(b, f, arch, ctx) {
  const out = new Float32Array(b.nA);
  const biasScale = b.scale[0];
  const abase = arch * b.nA;
  for (let a = 0; a < b.nA; a++) {
    let s = b.archBias[abase + a] * biasScale;
    const row = ((ctx * b.nA) + a) * b.nF;
    for (let i = 0; i < b.nF; i++) s += f[i] * b.w[row + i] * b.scale[i];
    out[a] = s;
  }
  return out;
}

// X-ray: exact per-feature contribution for the chosen action. This is only
// possible because the policy is linear, which is the whole argument for the
// tier-1 format.
export function explain(b, f, arch, ctx, featureNames = []) {
  const nA = b.nA, nF = b.nF;
  const scores = scoreAll(b, f, arch, ctx);
  let best = 0;
  for (let a = 1; a < nA; a++) if (scores[a] > scores[best]) best = a;
  const biasScale = b.scale[0];
  const terms = [];
  let total = b.archBias[arch * nA + best] * biasScale;
  for (let i = 0; i < nF; i++) {
    const contrib = f[i] * b.w[(ctx * nA + best) * nF + i] * b.scale[i];
    total += contrib;
    terms.push({ feature: featureNames[i] ?? `f${i}`, value: f[i], weight: b.w[(ctx * nA + best) * nF + i], contrib });
  }
  return {
    action: best,
    score: total,
    bias: b.archBias[arch * nA + best] * biasScale,
    terms,
    runnerUp: best === 0 ? 1 : best === 1 ? 0 : secondBest(scores, best),
  };
}

function secondBest(scores, best) {
  let s = -1, v = -Infinity;
  for (let a = 0; a < scores.length; a++) {
    if (a === best) continue;
    if (scores[a] > v) { v = scores[a]; s = a; }
  }
  return s;
}

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

// Two ramp inputs (pressure, advantage) -> four contexts. Thresholds are
// trained alongside weights; min_dwell stops the policy thrashing between
// contexts every tick.
export const CTX_EXECUTE = 0, CTX_DEFAULT = 1, CTX_HOLD = 2, CTX_SAVE = 3;

export function ramp(x) {
  if (x <= -1) return 0;
  if (x >= 1) return 1;
  return (x + 1) * 0.5;
}

export function gateContext(b, pressure, advantage, prevCtx, dwellTicks) {
  if (!b.gated) return CTX_DEFAULT;
  const minDwell = b.minDwellTicks ?? 0;
  if (prevCtx >= 0 && dwellTicks < minDwell) return prevCtx;
  const p = pressure, a = advantage;
  const t = b.thresholds;
  if (p > t[0] && a > t[1]) return CTX_EXECUTE;
  if (p < t[2]) return CTX_SAVE;
  if (a < t[3]) return CTX_HOLD;
  return CTX_DEFAULT;
}

export function readBrainHeader(bytes) {
  const b = unpackBrain(bytes);
  return {
    bytes: b.bytes, nF: b.nF, nA: b.nA, nC: b.nC, nArch: b.nArch,
    gated: b.gated, hash: b.hash.toString(16),
  };
}