// The hourly pipeline: imitate -> self-play -> league -> promote -> publish.
//
//   node trainer/run.js [--games=12] [--seeds=4] [--fast]
//
// Runs for every game listed in games/index.json. Each game contributes its own
// spec, its own brains, and its own recordings; the trainer itself is generic.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { specHash, packBrain, unpackBrain, randBrain, cloneBrain, brainBytes, verifyBrain } from '../sdk/js/s1.js';
import { parseS1d } from '../sdk/js/s1d.js';
import { imitate } from './imitate.js';
import { evolve, quantize, evaluate } from './evolve.js';
import { series, promotionDecision, ladder, wilson } from './league.js';
import { scriptedController, randomController, brainController } from '../games/arena/src/controllers.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  })
);

function readSpec(gameDir) {
  return JSON.parse(readFileSync(join(gameDir, 'game.s1.json'), 'utf8'));
}

function loadRecordings(gameDir) {
  const out = [];
  const dataDir = join(gameDir, 'data');
  if (!existsSync(dataDir)) return out;
  for (const f of readdirSync(dataDir)) {
    if (f.endsWith('.s1d')) out.push({ file: f, ...parseS1d(readFileSync(join(dataDir, f), 'utf8')) });
  }
  return out;
}

// Load a brain, but refuse to accept one that does not belong to this spec. A
// stale or hand-edited file should be replaced, not silently trained against:
// that is the failure mode the spec hash exists to prevent.
function loadBrain(path, spec) {
  if (!existsSync(path)) return null;
  const brain = unpackBrain(new Uint8Array(readFileSync(path)));
  try {
    verifyBrain(brain, spec);
    return brain;
  } catch (e) {
    log(`  ! ignoring ${path}: ${e.message}`);
    return null;
  }
}

// A deliberately small brain for the size-tier demo: one context, no gate.
// Shows what a single linear table buys for ~150 bytes.
function makeTiny(spec) {
  const nF = spec.features.length, nA = spec.actions.length;
  const b = {
    hash: specHash(spec), nF, nA, nC: 1, nArch: spec.archetypes.length,
    gateCount: 1, gated: false,
    w: new Float32Array(nA * nF),
    archBias: new Float32Array(spec.archetypes.length * nA),
    thresholds: new Float32Array([0]),
    scale: new Float32Array(nF).fill(1),
    biasScale: 1,
    minDwellTicks: 0,
  };
  // Hand-set weights: "back off when hurt, push when healthy and close".
  const set = (a, w) => { for (let i = 0; i < nF; i++) b.w[a * nF + i] = w[i] ?? 0; };
  const zero = new Array(nF).fill(0);
  set(0, [...zero, 25, 12, 30, 0, 15, -20]);                        // advance
  set(1, [-10, -6, -12, 5, 0, 0, 14, 6, 0, 0]);                    // hold
  set(2, [18, 10, 0, 8, 12, 0, 0, 0, 0, 0]);                       // peek
  set(3, [-38, -8, -34, 0, 20, 0, 0, 0, 0, 0]);                    // retreat
  set(4, [4, 0, 0, 0, 6, 8, 10, 0, 0, 0]);                         // rotate
  set(5, [8, 14, -18, 0, 0, 0, 0, 10, 40, 0]);                     // use_ability
  set(6, [-14, 0, 0, -46, 0, 0, 0, 0, 0, 0]);                      // reload
  return b;
}

function publishBrain(path, brain) {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = packBrain(brain);
  writeFileSync(path, bytes);
  return bytes.length;
}

function ensureBaselineBrains(gameDir, spec) {
  const brainsDir = join(gameDir, 'brains');
  mkdirSync(brainsDir, { recursive: true });
  const files = {};
  const tinyPath = join(brainsDir, 'tiny.s1b');
  files.tiny = existsSync(tinyPath) ? tinyPath : (publishBrain(tinyPath, makeTiny(spec)), tinyPath);
  const champPath = join(brainsDir, 'champion.s1b');
  const existing = loadBrain(champPath, spec);
  if (!existing) {
    publishBrain(champPath, quantize(spec, randBrain(spec, { gated: true, rng: mulberry(7) })));
  }
  return { brainsDir, tinyPath, champPath, files };
}

function mulberry(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function trainGame(gameDir, log) {
  const spec = readSpec(gameDir);
  const id = spec.id;
  log(`\n=== ${id} ===`);
  const { brainsDir, champPath } = ensureBaselineBrains(gameDir, spec);

  // 1. Imitate ------------------------------------------------------------
  let recs = loadRecordings(gameDir);
  if (recs.length === 0) {
    // A fresh clone has no recordings. Ask the game to make its own seed data
    // rather than skipping the imitate stage, so the pipeline always exercises
    // all four stages.
    try {
      const mod = await import(pathToFileURL(join(gameDir, 'record.js')).href);
      if (typeof mod.bootstrapData === 'function') {
        const r = mod.bootstrapData(gameDir);
        if (r.created) log(`record: generated ${r.matches} seed matches in data/`);
        recs = loadRecordings(gameDir);
      }
    } catch (e) {
      log(`record: no bootstrap available (${e.message})`);
    }
  }
  let imitated = null;
  if (recs.length) {
    imitated = imitate(spec, recs);
    publishBrain(join(brainsDir, 'imitated.s1b'), imitated.brain);
    log(`imitate: ${imitated.samples} weighted samples from ${recs.length} file(s) ` +
        `[${Object.entries(imitated.bySource).map(([k, v]) => `${k}:${v}`).join(' ')}] ` +
        `argmax-agreement=${(imitated.accuracy * 100).toFixed(1)}% ` +
        `contexts-fit=${imitated.coverage.contexts}/${spec.contexts.length}`);
  } else {
    log('imitate: no recordings, skipping (drop .s1d files in data/)');
  }

  // 2. Self-play ----------------------------------------------------------
  const champion = loadBrain(champPath, spec);
  const opponents = [scriptedController, randomController];

  // Warm start from whichever of imitation / the current champion is actually
  // stronger against the same opponents. Imitation usually wins early on and
  // evolution usually wins later, and picking wrong wastes the whole run.
  const warmPool = [];
  if (imitated) warmPool.push({ name: 'imitated', brain: imitated.brain });
  warmPool.push({ name: 'champion', brain: champion });
  let startName = warmPool[0].name;
  let startBrain = warmPool[0].brain;
  let startFit = -Infinity;
  for (const w of warmPool) {
    const f = evaluate(spec, w.brain, opponents, { seeds: 4 }).score;
    log(`evolve: warm start ${w.name} fitness ${f.toFixed(3)}`);
    if (f > startFit) { startFit = f; startName = w.name; startBrain = w.brain; }
  }

  const evol = evolve(spec, startBrain, {
    generations: Number(argv.generations ?? 24),
    population: Number(argv.population ?? 8),
    sigma0: Number(argv.sigma ?? 8),
    seeds: Number(argv.seeds ?? 3),
    seed: Number(argv.seed ?? 20240),
    opponents,
  });
  publishBrain(join(brainsDir, 'candidate.s1b'), evol.brain);
  const accepted = evol.history.filter((h) => h.accepted).length;
  log(`evolve: from ${startName}, ${evol.history.length - 1} generations, ${accepted} accepted, ` +
      `fitness ${evol.history[0].fitness.toFixed(3)} -> ${evol.fitness.toFixed(3)}`);

  // 3. League -------------------------------------------------------------
  const matches = Number(argv.matches ?? 60);
  const candVsChampion = series(spec, evol.brain, brainCtl(champion), { matches });
  const champVsScripted = series(spec, champion, scriptedController, { matches: matches / 2 });
  const candVsScripted = series(spec, evol.brain, scriptedController, { matches: matches / 2 });
  const candVsRandom = series(spec, evol.brain, randomController, { matches: matches / 4 });
  const candVsHuman = series(spec, evol.brain, scriptedController, {
    matches: matches / 4, humanizeOpponent: 0.4,
  });

  log(`league: vs champion ${fmt(candVsChampion)}`);
  log(`league: vs scripted ${fmt(candVsScripted)} (champion ${champVsScripted.winRate.toFixed(3)})`);
  log(`league: vs random ${fmt(candVsRandom)}`);
  log(`league: vs humanized scripted ${fmt(candVsHuman)}`);

  // 4. Promote ------------------------------------------------------------
  const decision = promotionDecision(candVsChampion, candVsScripted, champVsScripted, {
    minMatches: matches,
  });
  let promoted = false;
  if (decision.promote) {
    publishBrain(champPath, evol.brain);
    promoted = true;
    log(`promote: YES (champion updated)`);
  } else {
    log(`promote: no -> ${decision.reasons.join('; ')}`);
  }

  // Ladder for the showcase page.
  const finalists = [
    { name: 'champion', controller: brainCtl(promoted ? evol.brain : champion) },
    { name: 'candidate', controller: brainCtl(evol.brain) },
    { name: 'imitated', controller: imitated ? brainCtl(imitated.brain) : brainCtl(champion) },
    { name: 'scripted', controller: scriptedController },
    { name: 'random', controller: randomController },
  ].filter((c) => c.name !== 'imitated' || imitated);
  const board = ladder(spec, finalists, { matches: Number(argv.ladder ?? 10) });
  log(`ladder: ${board.table.map((e) => `${e.name}:${Math.round(e.rating)}`).join('  ')}`);

  // Difficulty curve for the "human-level progress" meter.
  const curve = [0, 0.25, 0.5, 0.75, 1].map((lv) => {
    const s = series(spec, promoted ? evol.brain : champion, scriptedController, {
      matches: 24, humanizeOpponent: lv > 0 ? lv : null,
    });
    return { level: lv, winRate: +s.winRate.toFixed(3), lo: +s.ci.lo.toFixed(3), hi: +s.ci.hi.toFixed(3) };
  });

  return { spec, brainsDir, champion: promoted ? evol.brain : champion, bytes: brainBytes(evol.brain), promoted, decision, series: { candVsChampion, champVsScripted, candVsScripted, candVsRandom, candVsHuman }, board, curve, imitated: imitated ? { accuracy: imitated.accuracy, samples: imitated.samples, bySource: imitated.bySource } : null, generations: evol.history };
}

function brainCtl(brain) {
  return brainController(brain, { gated: true });
}

function fmt(s) {
  return `${s.wins}W ${s.losses}L ${s.draws}D win=${s.winRate.toFixed(3)} [${s.ci.lo.toFixed(2)}-${s.ci.hi.toFixed(2)}]`;
}

// --- main ------------------------------------------------------------------

const log = (s) => process.stdout.write(s + '\n');

const indexPath = join(root, 'games', 'index.json');
const index = existsSync(indexPath)
  ? JSON.parse(readFileSync(indexPath, 'utf8'))
  : { games: [] };

const started = Date.now();
const results = [];
for (const entry of index.games) {
  const gameDir = join(root, 'games', entry.dir);
  if (!existsSync(join(gameDir, 'game.s1.json'))) {
    log(`skip ${entry.dir}: no game.s1.json`);
    continue;
  }
  results.push({ entry, out: await trainGame(gameDir, log) });
}

// Publish the metrics the showcase page reads.
for (const { entry, out } of results) {
  const metricsPath = join(root, 'games', entry.dir, 'metrics.json');
  writeFileSync(metricsPath, JSON.stringify({
    game: out.spec.id,
    generated_at: new Date().toISOString(),
    champion_bytes: out.bytes,
    budget_bytes: out.spec.budget_bytes,
    promoted: out.promoted,
    promotion: out.decision,
    imitation: out.imitated,
    series: {
      vs_champion: strip(out.series.candVsChampion),
      vs_scripted: strip(out.series.candVsScripted),
      champion_vs_scripted: strip(out.series.champVsScripted),
      vs_random: strip(out.series.candVsRandom),
      vs_humanized: strip(out.series.candVsHuman),
    },
    ladder: out.board.ratings,
    difficulty_curve: out.curve,
    generations: out.generations.map((g) => ({ gen: g.gen, best: +(g.best ?? 0).toFixed(4) })),
  }, null, 2));
  log(`\nwrote ${metricsPath}`);
}

function strip(s) {
  return { matches: s.matches, wins: s.wins, losses: s.losses, draws: s.draws, win_rate: +s.winRate.toFixed(3), ci: [+s.ci.lo.toFixed(3), +s.ci.hi.toFixed(3)] };
}

log(`\ndone in ${((Date.now() - started) / 1000).toFixed(1)}s`);