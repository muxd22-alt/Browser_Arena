// Cross-language conformance runner.
//
//   node spec/verify.js
//
// Checks every .s1b evaluator against spec/golden.json. The Unity and Godot
// evaluators are checked the same way in their own CI jobs; this script is the
// JS side, and it is the definition of "agreeing".

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unpackBrain, decide, verifyBrain, brainBytes } from '../sdk/js/s1.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const goldenPath = join(here, 'golden.json');

if (!existsSync(goldenPath)) {
  console.error('spec/golden.json missing. Run: node spec/make-golden.js');
  process.exit(1);
}

const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
const specs = new Map();
const index = JSON.parse(readFileSync(join(root, 'games/index.json'), 'utf8'));
for (const g of index.games) {
  specs.set(g.id, JSON.parse(readFileSync(join(root, 'games', g.dir, 'game.s1.json'), 'utf8')));
}

let checked = 0;
let failed = 0;

for (const g of golden.brains) {
  const brain = unpackBrain(Buffer.from(g.brain_b64, 'base64'));
  const spec = specs.get(golden.spec_id);
  if (spec) {
    try {
      verifyBrain(brain, spec);
    } catch (e) {
      console.error(`FAIL ${g.name}: ${e.message}`);
      failed++;
    }
    const size = brainBytes(brain);
    if (size > spec.budget_bytes) {
      console.error(`FAIL ${g.name}: ${size} B exceeds budget ${spec.budget_bytes} B`);
      failed++;
    }
  }
  for (const c of g.cases) {
    const d = decide(brain, c.f, c.arch, c.ctx);
    checked++;
    if (d.action !== c.action) {
      console.error(`FAIL ${g.name} arch=${c.arch} ctx=${c.ctx}: got ${c.action}, want ${c.action_name}`);
      failed++;
    } else if (Math.abs(d.score - c.score) > 1e-4) {
      console.error(`FAIL ${g.name} arch=${c.arch} ctx=${c.ctx}: score ${d.score} != ${c.score}`);
      failed++;
    }
  }
  console.log(`ok ${g.name.padEnd(16)} ${String(g.bytes).padStart(5)} B  ${g.cases.length} cases`);
}

// Also check the brains actually on disk, not just the ones baked into the file.
for (const [id, spec] of specs) {
  const entry = index.games.find((g) => g.id === id);
  for (const b of entry.brains ?? []) {
    if (!b.file) continue;
    const p = join(root, 'games', entry.dir, 'brains', b.file);
    if (!existsSync(p)) { console.log(`skip ${b.file} (not built yet)`); continue; }
    const brain = unpackBrain(new Uint8Array(readFileSync(p)));
    verifyBrain(brain, spec);
    const ok = brainBytes(brain) <= spec.budget_bytes;
    console.log(`ok disk ${b.file.padEnd(16)} ${String(brainBytes(brain)).padStart(5)} B  ${ok ? 'in budget' : 'OVER BUDGET'}`);
    if (!ok) failed++;
    checked++;
  }
}

console.log(`\n${checked} cases checked, ${failed} failures`);
process.exit(failed ? 1 : 0);