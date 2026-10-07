import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  unpackBrain, packBrain, decide, explain, scoreAll, specHash, verifyBrain,
  gateContext, brainBytes, CTX_EXECUTE, CTX_DEFAULT, CTX_HOLD, CTX_SAVE,
} from '../../sdk/js/s1.js';
import { Recorder, parseS1d, dataset } from '../../sdk/js/s1d.js';

const here = dirname(fileURLToPath(import.meta.url));
const specDir = resolve(here, '..');
const root = resolve(specDir, '..');
const spec = JSON.parse(readFileSync(join(root, 'games/arena/game.s1.json'), 'utf8'));
const golden = JSON.parse(readFileSync(join(specDir, 'golden.json'), 'utf8'));

function brain(b64) {
  return unpackBrain(Buffer.from(b64, 'base64'));
}

test('spec hash is stable and covers the tensor layout', () => {
  assert.equal(specHash(spec), parseInt(golden.spec_hash, 16));
  const reordered = { ...spec, actions: [...spec.actions].reverse() };
  assert.notEqual(specHash(spec), specHash(reordered));
  const fewerFeatures = { ...spec, features: spec.features.slice(0, -1) };
  assert.notEqual(specHash(spec), specHash(fewerFeatures));
});

test('pack -> unpack roundtrips every field', () => {
  const b = brain(golden.brains[0].brain_b64);
  const again = unpackBrain(packBrain(b));
  assert.equal(again.nF, b.nF);
  assert.equal(again.nA, b.nA);
  assert.equal(again.nC, b.nC);
  assert.equal(again.nArch, b.nArch);
  assert.equal(again.hash, b.hash);
  assert.equal(again.gated, b.gated);
  assert.equal(again.minDwellTicks, b.minDwellTicks);
  for (let i = 0; i < b.w.length; i++) assert.equal(again.w[i], b.w[i]);
  for (let i = 0; i < b.scale.length; i++) assert.equal(again.scale[i], b.scale[i]);
  assert.equal(again.biasScale, b.biasScale);
  assert.equal(again.bytes, brainBytes(b));
});

test('every published brain fits the declared budget', () => {
  for (const g of golden.brains) {
    const b = brain(g.brain_b64);
    assert.ok(brainBytes(b) <= spec.budget_bytes, `${g.name} is ${brainBytes(b)} B > ${spec.budget_bytes} B`);
  }
});

test('decide reproduces the golden vectors', () => {
  let n = 0;
  for (const g of golden.brains) {
    const b = brain(g.brain_b64);
    for (const c of g.cases) {
      const d = decide(b, c.f, c.arch, c.ctx);
      assert.equal(d.action, c.action,
        `${g.name} arch=${c.arch} ctx=${c.ctx} f=[${c.f}] -> got ${d.action}, want ${c.action}`);
      assert.ok(Math.abs(d.score - c.score) < 1e-5,
        `${g.name} score drift: got ${d.score}, want ${c.score}`);
      n++;
    }
  }
  assert.ok(n > 100, `expected a few hundred vectors, got ${n}`);
});

test('decide agrees with scoreAll and explain', () => {
  const b = brain(golden.brains[0].brain_b64);
  const f = golden.brains[0].cases[5].f;
  const arch = 1, ctx = 2;
  const d = decide(b, f, arch, ctx);
  const all = scoreAll(b, f, arch, ctx);
  let best = 0;
  for (let a = 1; a < all.length; a++) if (all[a] > all[best]) best = a;
  assert.equal(d.action, best);
  const x = explain(b, f, arch, ctx, spec.features);
  assert.equal(x.action, d.action);
  const summed = x.bias + x.terms.reduce((s, t) => s + t.contrib, 0);
  assert.ok(Math.abs(summed - d.score) < 1e-4, `explain terms must sum to the score (${summed} vs ${d.score})`);
  assert.equal(x.terms.length, spec.features.length);
  assert.equal(x.terms[0].feature, spec.features[0]);
});

test('a brain trained for another spec refuses to load', () => {
  const b = brain(golden.brains[0].brain_b64);
  assert.ok(verifyBrain(b, spec));
  const alien = { ...spec, id: 'some-other-game' };
  assert.throws(() => verifyBrain(b, alien), /different spec/);
  // Same spec hash, wrong tensor: the layout guards must catch it.
  assert.throws(() => verifyBrain({ ...b, nF: 5 }, spec), /feature count/);
  assert.throws(() => verifyBrain({ ...b, nA: 3 }, spec), /action count/);
  // b is gated, so dropping a context is caught as a missing table.
  assert.throws(() => verifyBrain({ ...b, nC: 2 }, spec), /must cover all/);
  assert.throws(() => verifyBrain({ ...b, nArch: 9 }, spec), /archetype count/);
});

test('lower tiers may collapse the tensor, but not exceed it', () => {
  const tiny = brain(golden.brains.find((g) => g.name === 'tiny-ungated').brain_b64);
  // One shared table, no gate: a valid tier-1 brain for the same spec.
  assert.ok(verifyBrain(tiny, spec));
  assert.equal(tiny.nC, 1);
  assert.equal(tiny.gated, false);
  // More contexts than the game defines is never valid, gated or not.
  assert.throws(() => verifyBrain({ ...tiny, nC: spec.contexts.length + 1 }, spec), /context count/);
  // A gated brain that skips a context is a silent hole: the gate can select a
  // context whose weights were never trained.
  assert.throws(() => verifyBrain({ ...tiny, gated: true, nC: 2 }, spec), /must cover all/);
});

test('corrupt brain files are rejected, not misread', () => {
  const bytes = Buffer.from(golden.brains[0].brain_b64, 'base64');
  const badMagic = Buffer.from(bytes); badMagic[0] = 0x58;
  assert.throws(() => unpackBrain(badMagic), /magic/);
  assert.throws(() => unpackBrain(bytes.subarray(0, 8)), /too short/);
  assert.throws(() => unpackBrain(bytes.subarray(0, bytes.length - 40)), /truncated/);
});

test('gate produces the four contexts and respects dwell time', () => {
  const b = brain(golden.brains[0].brain_b64);
  assert.equal(b.gated, true);
  assert.equal(gateContext(b, 1, 1, -1, 0), CTX_EXECUTE);
  assert.equal(gateContext(b, -1, -1, -1, 0), CTX_SAVE);
  assert.equal(gateContext(b, 0, -1, -1, 0), CTX_HOLD);
  assert.equal(gateContext(b, 0, 1, -1, 0), CTX_DEFAULT);
  // Dwell: a fresh switch request is refused until enough ticks have passed.
  assert.equal(gateContext(b, 1, 1, CTX_HOLD, 1), CTX_HOLD);
  assert.equal(gateContext(b, 1, 1, CTX_HOLD, b.minDwellTicks), CTX_EXECUTE);
});

test('ungated brains ignore the gate', () => {
  const tiny = brain(golden.brains.find((g) => g.name === 'tiny-ungated').brain_b64);
  assert.equal(tiny.gated, false);
  assert.equal(gateContext(tiny, 1, 1, CTX_SAVE, 0), CTX_DEFAULT);
});

test('.s1d roundtrips through text', () => {
  const rec = new Recorder({ src: 'human', spec });
  rec.step(1042, 3, 1, [0.4, 1, 0.8, 0.5, -0.2], 1, 2, 'human');
  rec.end(1200, 1, [12, 9]);
  const parsed = parseS1d(rec.toText());
  assert.equal(parsed.steps.length, 1);
  assert.equal(parsed.steps[0].a, 2);
  assert.equal(parsed.steps[0].src, 'human');
  assert.deepEqual(parsed.steps[0].f, [0.4, 1, 0.8, 0.5, -0.2]);
  assert.equal(parsed.end.win, 1);
  assert.deepEqual(parsed.end.score, [12, 9]);
  assert.equal(parsed.header.game.id, spec.id);
});

test('dataset weights human data above scripted above self-play', () => {
  const mk = (src) => {
    const r = new Recorder({ src });
    r.step(1, 0, 0, new Array(10).fill(0.1), 0, 0);
    return parseS1d(r.toText());
  };
  const ds = dataset([mk('human'), mk('scripted'), mk('selfplay')]);
  assert.equal(ds.n, 3 + 2 + 1);
  assert.deepEqual(ds.bySource, { human: 1, scripted: 1, selfplay: 1 });
});

test('parsing tolerates blank lines and a missing header', () => {
  const parsed = parseS1d('\n\n{"t":1,"u":0,"arch":0,"f":[0],"ctx":0,"a":3,"src":"selfplay"}\n\n{"t":2,"end":{"win":0,"score":[1,1]}}\n');
  assert.equal(parsed.steps.length, 1);
  assert.equal(parsed.steps[0].a, 3);
  assert.equal(parsed.end.win, 0);
});