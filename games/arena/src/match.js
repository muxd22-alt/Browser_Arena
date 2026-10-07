// Match runner: the bridge between Arena and any controller.
//
// The only interesting part is that decisions happen on a fixed cadence
// (every DECISION_EVERY ticks) and everything else is the game's own update
// loop. That is the entire integration cost described in the docs.
//
// createMatch is the live form used by the browser; runMatch is the headless
// form used by the trainer. They share one implementation on purpose: a
// showcase that behaves differently from the trained game is worse than no
// showcase.

import { Arena, DECISION_EVERY } from './arena.js';
import { Recorder } from '../../../sdk/js/s1d.js';

const fbuf = new Float64Array(16);

export function createMatch({
  seed = 1,
  blue,
  red,
  seconds,
  teamSize = 3,
  record = null,      // { src, which }
} = {}) {
  const arena = new Arena({ seed, blue, red, seconds, teamSize });
  const teams = { blue: blue, red: red };
  const rec = record ? new Recorder({ src: record.src }) : null;
  const recTeam = record?.which === 'red' ? 'red' : 'blue';
  const proto = { arena, rng: arena.rng, tick: 0 };

  function decideAll() {
    for (const u of arena.units) {
      if (!u.alive) continue;
      const a = teams[u.team].call(proto, u);
      arena.act(u, a);
      if (rec && u.team === recTeam) {
        rec.step(arena.tick, u.id, u.arch ?? 0, u.features ?? arena.observe(u, fbuf), u.ctx ?? 0, a,
          u.recordSrc ?? record.src);
      }
    }
  }

  function tick() {
    proto.tick = arena.tick;
    if (arena.tick % DECISION_EVERY === 0) decideAll();
    arena.step();
    proto.tick = arena.tick;
  }

  return {
    arena,
    proto,
    tick,
    decideAll,
    result: () => arena.result(),
    finished: () => arena.finished(),
    recorder: rec,
    recording() {
      if (!rec) return null;
      const r = arena.result();
      rec.end(arena.tick, r.win, r.score, { kills: r.kills });
      return rec.toText();
    },
  };
}

export function runMatch({
  seed = 1,
  blue,
  red,
  seconds,
  teamSize = 3,
  record = null,
  onTick = null,
} = {}) {
  const m = createMatch({ seed, blue, red, seconds, teamSize, record });
  while (!m.finished()) {
    m.tick();
    if (onTick) onTick(m.arena);
  }
  return { arena: m.arena, result: m.result(), recording: m.recording() };
}