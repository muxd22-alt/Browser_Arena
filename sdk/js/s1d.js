// Contract 2: the recording format (.s1d). One JSON object per line.
//
//   {"t":1042,"u":3,"arch":1,"f":[...],"ctx":1,"a":2,"src":"human"}
//   {"t":1042,"end":{"win":1,"score":[12,9]}}
//
// Any engine can emit this with a single fprintf. The trainer never needs
// more than features, context, archetype, action, and the source tag.

export const SRC = { HUMAN: 'human', SCRIPTED: 'scripted', SELFPLAY: 'selfplay' };

export class Recorder {
  constructor({ src = SRC.SCRIPTED, spec = null, meta = null } = {}) {
    this.lines = [];
    this.src = src;
    this.header = { kind: 's1d', s1: 1 };
    if (spec) this.header.game = { id: spec.id, features: spec.features, actions: spec.actions, contexts: spec.contexts };
    if (meta) this.header.meta = meta;
  }

  // u: stable unit index (stable across frames), t: tick.
  step(t, u, arch, f, ctx, a, src) {
    this.lines.push(JSON.stringify({ t, u, arch, f: round(f), ctx, a, src: src ?? this.src }));
  }

  end(t, win, score, extra = {}) {
    this.lines.push(JSON.stringify({ t, end: { win, score, ...extra } }));
  }

  toText() {
    return [JSON.stringify(this.header), ...this.lines, ''].join('\n');
  }
}

function round(f) {
  const out = new Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.round(f[i] * 1000) / 1000;
  return out;
}

// Splits a recording into decision steps and the terminal record.
export function parseS1d(text) {
  const steps = [];
  let end = null;
  let header = null;
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const obj = JSON.parse(line);
    if (obj.kind === 's1d') { header = obj; continue; }
    if (obj.end) { end = { ...obj.end, t: obj.t ?? obj.end.t ?? 0 }; continue; }
    steps.push(obj);
  }
  return { header, steps, end };
}

export function readS1dArray(f32) {
  // For engine-side use where a whole buffer arrives at once.
  return parseS1d(new TextDecoder().decode(f32));
}

// Aggregate a set of parsed recordings into arrays the trainer can fit on.
// Human data is weighted higher by replication factor, not by a magic
// constant inside the solver.
export function dataset(recordings, { humanWeight = 3, selfplayWeight = 1, scriptedWeight = 2 } = {}) {
  const weights = { [SRC.HUMAN]: humanWeight, [SRC.SCRIPTED]: scriptedWeight, [SRC.SELFPLAY]: selfplayWeight };
  const X = [], Y = [], CTX = [], ARCH = [], W = [], META = [];
  for (const rec of recordings) {
    for (const s of rec.steps) {
      const w = weights[s.src] ?? 1;
      for (let k = 0; k < w; k++) {
        X.push(s.f);
        Y.push(s.a);
        CTX.push(s.ctx);
        ARCH.push(s.arch ?? 0);
        W.push(w);
      }
    }
  }
  return {
    X, Y, ctx: CTX, arch: ARCH, weight: W,
    n: X.length,
    bySource: (() => {
      const c = { human: 0, scripted: 0, selfplay: 0 };
      for (const r of recordings) for (const s of r.steps) c[s.src] = (c[s.src] ?? 0) + 1;
      return c;
    })(),
  };
}

export function summary(parsedList) {
  let steps = 0;
  const bySource = { human: 0, scripted: 0, selfplay: 0 };
  let ticks = 0;
  for (const p of parsedList) {
    steps += p.steps.length;
    ticks = Math.max(ticks, p.steps.length ? p.steps[p.steps.length - 1].t : 0);
    for (const s of p.steps) bySource[s.src] = (bySource[s.src] ?? 0) + 1;
  }
  return { matches: parsedList.length, steps, bySource, maxTick: ticks };
}