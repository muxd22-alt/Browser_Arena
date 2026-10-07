// Generate the seed recordings that bootstrap the pipeline.
//
// Until real players submit .s1d files, imitation has nothing to fit. This
// writes a scripted-policy recording, correctly tagged src:"scripted" so the
// trainer knows it is not human data and the showcase page does not claim
// hours of human play that never happened. Drop real human recordings in
// games/arena/data/human/ and the next run picks them up automatically.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMatch } from './src/match.js';
import { scriptedController, randomController, brainController, humanizer } from './src/controllers.js';
import { unpackBrain } from '../../sdk/js/s1.js';

const here = dirname(fileURLToPath(import.meta.url));

export function recordSeed(matches = 6, { out = join(here, 'data', 'scripted-seed.s1d'), spec } = {}) {
  const lines = [];
  for (let s = 1; s <= matches; s++) {
    // Alternate sides so the recording is not all "blue behavior".
    const scriptedIsBlue = s % 2 === 1;
    const { recording } = runMatch({
      seed: 1000 + s,
      blue: scriptedIsBlue ? scriptedController : randomController,
      red: scriptedIsBlue ? randomController : scriptedController,
      record: { src: 'scripted', which: scriptedIsBlue ? 'blue' : 'red' },
    });
    lines.push(recording);
  }
  const text = lines.join('');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  return { out, matches, bytes: text.length };
}

// A humanized-controller recording. Used to check that the humanizer does not
// break the pipeline, and to give the trainer data with noise in it.
export function recordHumanized(matches = 6, brain, { out = join(here, 'data', 'humanized.s1d') } = {}) {
  if (!brain) throw new Error('recordHumanized needs a brain');
  const ctl = brainController(brain, { gated: true, humanizer: humanizer(0.35, 99) });
  const chunks = [];
  for (let s = 1; s <= matches; s++) {
    const { recording } = runMatch({
      seed: 3000 + s,
      blue: ctl,
      red: scriptedController,
      record: { src: 'selfplay', which: 'blue' },
    });
    chunks.push(recording);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, chunks.join(''));
  return { out, matches };
}

/**
 * Make sure the game has at least one recording, so `trainer/run.js` works on a
 * fresh clone. Generated data is not committed: it is a few hundred KB of
 * scripted behaviour that anyone can reproduce in a second.
 */
export async function bootstrapData(gameDir) {
  const dataDir = join(gameDir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, 'scripted-seed.s1d');
  if (existsSync(target)) return { created: false, path: target };
  const r = recordSeed(6);
  return { created: true, path: r.out, matches: r.matches };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const spec = JSON.parse(readFileSync(join(here, 'game.s1.json'), 'utf8'));
  const a = recordSeed(Number(process.argv[2] ?? 6));
  console.log('wrote', a.out, `${a.matches} matches, ${a.bytes} bytes`);
  const champPath = join(here, 'brains', 'champion.s1b');
  if (existsSync(champPath)) {
    const brain = unpackBrain(new Uint8Array(readFileSync(champPath)));
    const b = recordHumanized(6, brain);
    console.log('wrote', b.out, `${b.matches} matches`);
  } else {
    console.log('no champion.s1b yet; run `node trainer/run.js` first');
  }
}