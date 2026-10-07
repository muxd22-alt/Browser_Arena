// System One showcase.
//
// Everything on this page runs the same modules the trainer runs: the same
// evaluator, the same arena, the same .s1b bytes. The only thing that changes
// between controllers is which function turns a feature vector into an index.

import {
  unpackBrain, explain, scoreAll, verifyBrain, gateContext, readBrainHeader,
} from '../sdk/js/s1.js';
import { Recorder } from '../sdk/js/s1d.js';
import {
  WALLS, CAPTURE, ARENA_W, ARENA_H, TICK_RATE, ACTIONS, CONTEXTS,
} from '../games/arena/src/arena.js';
import { brainController, scriptedController, randomController, humanizer } from '../games/arena/src/controllers.js';
import { createMatch } from '../games/arena/src/match.js';

const $ = (id) => document.getElementById(id);
const CONTEXT_COLORS = ['#ff9f43', '#4c9aff', '#ffd166', '#7ee787'];

const state = {
  index: null,
  entry: null,
  spec: null,
  metrics: null,
  brains: new Map(),     // value -> { kind, brain?, header?, controller label }
  match: null,
  brainKey: null,
  side: 'blue',
  selected: null,
  paused: false,
  speed: 1,
  acc: 0,
  last: 0,
  recording: null,
  recordText: null,
  keys: new Set(),
  lastResult: null,
};

const featBuf = new Float64Array(16);

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot() {
  const status = $('status');
  try {
    state.index = await fetchJson('../games/index.json');
  } catch (e) {
    status.className = 'status error';
    status.textContent = 'could not load games/index.json';
    return showServeHint();
  }
  const sel = $('game-select');
  sel.innerHTML = '';
  for (const g of state.index.games) {
    const o = document.createElement('option');
    o.value = g.dir;
    o.textContent = g.title ?? g.id;
    sel.appendChild(o);
  }
  sel.onchange = () => loadGame(sel.value);
  installInput();
  await loadGame(sel.value);
  requestAnimationFrame(frame);
}

function showServeHint() {
  const box = document.createElement('div');
  box.className = 'teach';
  box.style.gridColumn = '1 / -1';
  box.innerHTML = `<div class="overlay-error error" style="padding:12px">
    This page loads game data with <code>fetch()</code>, which browsers block on <code>file://</code>.
    Run <code>npm run serve</code> and open <code>http://localhost:8080/docs/</code>.
  </div>`;
  document.querySelector('main').prepend(box);
}

async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

async function loadGame(dir) {
  state.entry = state.index.games.find((g) => g.dir === dir) ?? state.index.games[0];
  state.spec = await fetchJson(`../games/${dir}/game.s1.json`);
  state.metrics = await fetchJson(`../games/${dir}/metrics.json`).catch(() => null);
  state.brains.clear();

  const blueSel = $('blue-ctl');
  const redSel = $('red-ctl');
  blueSel.innerHTML = '';
  redSel.innerHTML = '';

  const addOption = (sel, value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };

  addOption(blueSel, 'you', 'you + 2 AI teammates');
  addOption(redSel, 'you', 'you + 2 AI teammates');

  for (const entry of state.entry.brains) {
    let label = entry.label;
    if (entry.file) {
      try {
        const buf = new Uint8Array(await (await fetch(`../games/${dir}/brains/${entry.file}`)).arrayBuffer());
        const brain = unpackBrain(buf);
        verifyBrain(brain, state.spec);
        const header = readBrainHeader(buf);
        state.brains.set(entry.label, { kind: 'brain', brain, header, file: entry.file });
        label = `${entry.label} - ${header.bytes} B`;
      } catch (e) {
        label = `${entry.label} (missing)`;
      }
    } else {
      state.brains.set(entry.label, { kind: entry.controller });
    }
    addOption(blueSel, entry.label, label);
    addOption(redSel, entry.label, label);
  }

  const champ = state.entry.brains.find((b) => b.file === 'champion.s1b');
  state.brainKey = champ ? champ.label : state.entry.brains[0].label;
  const defaultBrain = [...state.brains.keys()].find((k) => k === 'scripted') ?? state.brainKey;
  blueSel.value = 'you';
  redSel.value = state.brainKey ?? defaultBrain;
  state.side = 'blue';

  blueSel.onchange = () => restart();
  redSel.onchange = () => restart();
  renderSpec();
  renderLadder();
  restart();
}

// ---------------------------------------------------------------------------
// controllers
// ---------------------------------------------------------------------------

// The player's unit. Two AI teammates come from the brain on the same side, so
// the showcase shows what a mixed squad looks like.
function humanController() {
  return function (unit) {
    const a = this.arena;
    const f = a.observe(unit, featBuf);
    unit.features = Array.from(f.slice(0, state.spec.features.length));
    unit.arch = unit.id % state.spec.archetypes.length;
    unit.recordSrc = 'human';

    if (unit.id !== state.selected) {
      unit.lastHuman = 'hold';
      a.moveIntent(unit, unit.x, unit.y, 0);
      return ACTIONS.indexOf('hold');
    }

    // Gate the human's own view too, so the x-ray panel and the recording use
    // the same context the trainer would have labelled this frame with.
    const [p, adv] = a.gateInputs(unit, f);
    const gateBrain = state.brains.get(state.brainKey);
    unit.ctx = gateBrain?.brain?.gated
      ? gateContext(gateBrain.brain, p, adv, unit.ctx, unit.ctxSince)
      : 1;

    if (state.keys.has('KeyQ') && unit.cd <= 0) {
      unit.lastHuman = 'use_ability';
      return ACTIONS.indexOf('use_ability');
    }
    if (state.keys.has('KeyR') && unit.ammo < 6) {
      unit.lastHuman = 'reload';
      return ACTIONS.indexOf('reload');
    }

    let dx = 0, dy = 0;
    if (state.keys.has('KeyW') || state.keys.has('ArrowUp')) dy -= 1;
    if (state.keys.has('KeyS') || state.keys.has('ArrowDown')) dy += 1;
    if (state.keys.has('KeyA') || state.keys.has('ArrowLeft')) dx -= 1;
    if (state.keys.has('KeyD') || state.keys.has('ArrowRight')) dx += 1;
    const mag = Math.hypot(dx, dy);

    if (mag === 0) {
      unit.lastHuman = 'hold';
      a.moveIntent(unit, unit.x, unit.y, 0);
      unit.aimX = a.nearestEnemy(unit).unit?.x ?? CAPTURE.x;
      unit.aimY = a.nearestEnemy(unit).unit?.y ?? CAPTURE.y;
      return ACTIONS.indexOf('hold');
    }

    // Map a stick direction onto the nearest intent, and aim at whatever is
    // visible. The recording therefore contains the same action vocabulary the
    // brains use.
    const { unit: enemy } = a.nearestEnemy(unit);
    const toEnemyX = enemy ? enemy.x - unit.x : CAPTURE.x - unit.x;
    const toEnemyY = enemy ? enemy.y - unit.y : CAPTURE.y - unit.y;
    const em = Math.hypot(toEnemyX, toEnemyY) || 1;
    const facing = (dx / mag) * (toEnemyX / em) + (dy / mag) * (toEnemyY / em);
    unit.aimX = enemy ? enemy.x : CAPTURE.x;
    unit.aimY = enemy ? enemy.y : CAPTURE.y;
    if (facing > 0.35) {
      unit.lastHuman = 'advance';
      a.moveIntent(unit, CAPTURE.x, CAPTURE.y, 1, enemy);
      return ACTIONS.indexOf('advance');
    }
    if (facing < -0.45) {
      unit.lastHuman = 'retreat';
      a.moveIntent(unit, unit.x - (toEnemyX / em) * 70, unit.y - (toEnemyY / em) * 70, 1);
      return ACTIONS.indexOf('retreat');
    }
    unit.lastHuman = 'peek';
    const sx = -toEnemyY / em * 40, sy = toEnemyX / em * 40;
    a.moveIntent(unit, unit.x + sx, unit.y + sy, 0.9, enemy);
    return ACTIONS.indexOf('peek');
  };
}

// Wrap a brain so one unit can be swapped for the human.
function teamController(label, sideKey) {
  const entry = state.brains.get(label);
  if (!entry) return scriptedController;
  if (entry.kind === 'scripted') return scriptedController;
  if (entry.kind === 'random') return randomController;

  const level = Number($('humanize').value) / 100;
  const hz = level > 0 ? humanizer(level, 7) : null;
  const ctl = brainController(entry.brain, {
    gated: entry.brain.gated,
    humanizer: hz,
    archetypeFor: (u) => u.id % state.spec.archetypes.length,
  });
  if (!hz) {
    const wrapped = function (unit) {
      unit.features = unit.features ?? Array.from(this.arena.observe(unit, featBuf).slice(0, entry.brain.nF));
      unit.arch = unit.id % state.spec.archetypes.length;
      unit.recordSrc = 'selfplay';
      return ctl.call(this, unit);
    };
    return wrapped;
  }
  return ctl;
}

// Side value -> controller. 'you' means human for unit 0, brain for the rest.
function sideController(value, isHumanSide) {
  const brainCtl = value === 'you' ? brainCtlFor(state.brainKey) : teamController(value, isHumanSide);
  if (value !== 'you') return brainCtl;
  const human = humanController();
  return function (unit) {
    if (unit.idx === 0) {
      if (state.selected == null) state.selected = unit.id;
      return human.call(this, unit);
    }
    return brainCtl.call(this, unit);
  };
}

function brainCtlFor(label) {
  const entry = state.brains.get(label);
  if (!entry || entry.kind !== 'brain') return scriptedController;
  const level = Number($('humanize').value) / 100;
  return brainController(entry.brain, {
    gated: entry.brain.gated,
    humanizer: level > 0 ? humanizer(level, 7) : null,
    archetypeFor: (u) => u.id % state.spec.archetypes.length,
  });
}

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------

function restart() {
  if (!state.spec) return;
  const side = $('side-select').value;
  const blue = sideController($('blue-ctl').value, true);
  const red = sideController($('red-ctl').value, false);
  state.recorder = state.recordingOn ? new Recorder({ src: 'human', spec: state.spec }) : null;
  state.match = createMatch({
    seed: 1 + Math.floor(Math.random() * 100000),
    blue, red,
    teamSize: state.spec.sim?.team_size ?? 3,
    seconds: state.spec.sim?.match_seconds ?? 60,
    record: state.recorder ? { src: 'human', which: side } : null,
  });
  state.selected = state.match.arena.units.find((u) => u.team === side)?.id ?? 0;
  state.lastResult = null;
  $('overlay').classList.add('hidden');
  renderLegend();
}

function frame(ts) {
  requestAnimationFrame(frame);
  if (!state.match) return;
  const dt = state.last ? Math.min(0.25, (ts - state.last) / 1000) : 0;
  state.last = ts;
  if (!state.paused) {
    state.acc += dt * TICK_RATE * state.speed;
    let guard = 0;
    while (state.acc >= 1 && guard++ < 40) {
      state.match.tick();
      state.acc -= 1;
    }
    if (state.match.finished() && !state.lastResult) {
      state.lastResult = state.match.result();
      showResult(state.lastResult);
    }
  }
  draw();
}

function showResult(r) {
  const ov = $('overlay');
  const blue = r.win > 0 ? 'Blue wins' : r.win < 0 ? 'Red wins' : 'Draw';
  const mine = r.win === 0 ? 'you held the field' : ($('side-select').value === 'blue' ? 'you won' : 'you lost');
  ov.innerHTML = `<div><div>${blue}</div><div class="hint">${r.score[0]} &ndash; ${r.score[1]} &middot; ${mine}</div>
    <div style="margin-top:10px"><button id="btn-again">Play again</button></div></div>`;
  ov.classList.remove('hidden');
  ov.querySelector('#btn-again').onclick = restart;
  if (state.recordingOn) finishRecording();
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

const canvas = $('canvas');
const g = canvas.getContext('2d');
const SCALE = canvas.width / ARENA_W;

function draw() {
  const a = state.match.arena;
  g.save();
  g.scale(SCALE, SCALE);
  g.clearRect(0, 0, ARENA_W, ARENA_H);

  g.fillStyle = '#0b0f14';
  g.fillRect(0, 0, ARENA_W, ARENA_H);

  // capture zone
  const capColor = a.capture.owner === 0 ? 'rgba(76,154,255,0.22)'
    : a.capture.owner === 1 ? 'rgba(255,107,107,0.22)' : 'rgba(255,255,255,0.06)';
  g.fillStyle = capColor;
  g.beginPath();
  g.arc(CAPTURE.x, CAPTURE.y, CAPTURE.r, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.lineWidth = 1;
  g.stroke();

  // capture progress bar
  if (Math.abs(a.capture.progress) > 0.001) {
    g.fillStyle = a.capture.progress > 0 ? '#4c9aff' : '#ff6b6b';
    const w = 160 * Math.abs(a.capture.progress);
    g.fillRect(CAPTURE.x - w / 2, CAPTURE.y - CAPTURE.r - 9, w, 4);
  }

  // walls
  g.fillStyle = '#26313f';
  for (const w of WALLS) g.fillRect(w.x, w.y, w.w, w.h);

  const sel = a.units.find((u) => u.id === state.selected);

  // line of sight for the selected unit
  if (sel && sel.alive) {
    g.strokeStyle = 'rgba(126,231,135,0.13)';
    for (const o of a.enemiesOf(sel)) {
      if (a.canSee(sel, o)) {
        g.beginPath();
        g.moveTo(sel.x, sel.y);
        g.lineTo(o.x, o.y);
        g.stroke();
      }
    }
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.setLineDash([4, 4]);
    g.beginPath();
    g.moveTo(sel.x, sel.y);
    g.lineTo(sel.aimX, sel.aimY);
    g.stroke();
    g.setLineDash([]);
  }

  for (const u of a.units) {
    if (!u.alive) {
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.beginPath();
      g.arc(u.x, u.y, 5, 0, Math.PI * 2);
      g.fill();
      continue;
    }
    const col = u.team === 'blue' ? '#4c9aff' : '#ff6b6b';

    if (u.id === state.selected) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(u.x, u.y, 13, 0, Math.PI * 2);
      g.stroke();
    }
    if (u.shield > 0) {
      g.strokeStyle = 'rgba(126,231,135,0.7)';
      g.beginPath();
      g.arc(u.x, u.y, 12, 0, Math.PI * 2);
      g.stroke();
    }
    // context ring
    g.strokeStyle = CONTEXT_COLORS[u.ctx] ?? '#555';
    g.lineWidth = 2.5;
    g.beginPath();
    g.arc(u.x, u.y, 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (u.hp / 100));
    g.stroke();

    g.fillStyle = col;
    g.beginPath();
    g.arc(u.x, u.y, 8, 0, Math.PI * 2);
    g.fill();

    // archetype tick marks
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 1;
    for (let k = 0; k < 3; k++) {
      const ang = -Math.PI / 2 + (k - 1) * 0.5;
      g.beginPath();
      g.moveTo(u.x + Math.cos(ang) * 9, u.y + Math.sin(ang) * 9);
      g.lineTo(u.x + Math.cos(ang) * 12, u.y + Math.sin(ang) * 12);
      g.stroke();
    }

    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.font = '9px ui-monospace, monospace';
    g.textAlign = 'center';
    g.fillText((ACTIONS[u.lastAction] ?? '?').slice(0, 4), u.x, u.y + 22);
    if (u.reloading > 0) {
      g.fillStyle = '#ffd166';
      g.fillText('RLD', u.x, u.y + 32);
    }
  }
  g.restore();

  // HUD
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.font = '12px ui-monospace, monospace';
  g.textAlign = 'left';
  const t = Math.max(0, state.match.arena.maxTicks - state.match.arena.tick) / TICK_RATE;
  g.fillText(`t=${(state.match.arena.tick / TICK_RATE).toFixed(1)}s  left=${t.toFixed(0)}s  kills=${a.teams.blue.kills}-${a.teams.red.kills}`, 12, 20);
}

function renderLegend() {
  const box = $('legend');
  box.innerHTML = '';
  const item = (color, html) => {
    const d = document.createElement('div');
    d.innerHTML = `<span class="swatch" style="background:${color}"></span>${html}`;
    box.appendChild(d);
  };
  item('#4c9aff', 'blue');
  item('#ff6b6b', 'red');
  item(CONTEXT_COLORS[0], `${CONTEXTS[0]}`);
  item(CONTEXT_COLORS[1], `${CONTEXTS[1]}`);
  item(CONTEXT_COLORS[2], `${CONTEXTS[2]}`);
  item(CONTEXT_COLORS[3], `${CONTEXTS[3]}`);
  item('#7ee787', 'shield up');
  item('#ffd166', 'reloading');
  const note = document.createElement('div');
  note.innerHTML = '<b>Labels under a unit</b> are its current intent.';
  box.appendChild(note);
}

// ---------------------------------------------------------------------------
// x-ray
// ---------------------------------------------------------------------------

function renderXray(unit) {
  const box = $('xray');
  const brain = state.brains.get(state.brainKey)?.brain;
  if (!brain) {
    box.innerHTML = '<p class="empty">No brain loaded.</p>';
    return;
  }
  const a = state.match.arena;
  const f = a.observe(unit, featBuf);
  const arch = unit.id % state.spec.archetypes.length;
  const x = explain(brain, f, arch, unit.ctx, state.spec.features);
  const scores = scoreAll(brain, f, arch, unit.ctx);
  const all = state.spec.actions.map((n, i) => ({ n, i, s: scores[i] }))
    .sort((p, q) => q.s - p.s);

  const humanSide = $('side-select').value;
  const role = unit.team === humanSide
    ? (unit.idx === 0 ? 'you control this one' : 'AI teammate')
    : 'opponent';

  const best = all[0].s - all[1].s;
  const chips = all.map((c) =>
    `<span class="chip${c.i === x.action ? ' win' : ''}"><b>${c.n}</b> ${c.s.toFixed(1)}</span>`).join('');

  const rows = x.terms.slice()
    .sort((p, q) => Math.abs(q.contrib) - Math.abs(p.contrib))
    .map((t) => {
      const pct = Math.min(50, Math.abs(t.contrib) / Math.max(1e-6, Math.abs(x.score)) * 50);
      const style = t.contrib >= 0
        ? `left:50%;width:${pct}%;background:var(--accent)`
        : `right:50%;width:${pct}%;background:var(--red)`;
      return `<div class="row">
        <div class="top"><span class="name">${t.feature}</span>
          <span class="num">${t.value.toFixed(2)} &times; ${t.weight} = ${t.contrib.toFixed(2)}</span></div>
        <div class="bar-track"><div class="bar-fill" style="${style}"></div></div>
      </div>`;
    }).join('');

  // gate ramp: bands across the pressure axis, with this unit's position on it
  const [p, adv] = a.gateInputs(unit, f);
  const th = brain.thresholds;
  const pos = (v) => Math.max(0, Math.min(100, ((v + 1) / 2) * 100));
  const band = (from, to, color, label) => {
    const l = pos(from), r = pos(to);
    return `<div class="line" style="left:${l}%;width:${Math.max(0, r - l)}%;background:${color};opacity:.5"></div>
      <div class="mark" style="left:${(l + r) / 2}%">${label}</div>`;
  };
  const bands = brain.gated
    ? band(-1, th[2], CONTEXT_COLORS[3], 'save')
      + band(th[2], th[0], CONTEXT_COLORS[2], 'hold / default')
      + band(th[0], 1, CONTEXT_COLORS[0], 'execute')
      + `<div class="mark" style="left:${pos(p)}%;color:#fff">&#9679; you</div>`
    : '<div class="mark">this brain has no gate; every frame is context "default"</div>';

  box.innerHTML = `
    <h3>${unit.team === 'blue' ? 'Blue' : 'Red'} unit ${unit.idx}</h3>
    <div class="who">${role} &middot; archetype <b>${state.spec.archetypes[arch]}</b> &middot;
      context <b>${CONTEXTS[unit.ctx]}</b> &middot; hp ${Math.round(unit.hp)}</div>
    <div class="chips">${chips}</div>
    <p class="hint">Score for <b>${state.spec.actions[x.action]}</b> is
      ${x.score.toFixed(2)}, ${best.toFixed(2)} clear of <b>${state.spec.actions[all[1].i]}</b>.
      Archetype bias ${x.bias.toFixed(1)}.</p>
    ${rows}
    <div class="gate">
      <b>gate</b>: pressure ${p.toFixed(2)}, advantage ${adv.toFixed(2)}
      <div class="ramp">${bands}</div>
      dwell ${brain.minDwellTicks} ticks, current context held ${unit.ctxSince} ticks
    </div>`;
}

// ---------------------------------------------------------------------------
// panels: ladder, spec
// ---------------------------------------------------------------------------

function renderLadder() {
  const box = $('ladder');
  const prog = $('progress');
  const m = state.metrics;
  if (!m) {
    box.innerHTML = '<p class="hint">No metrics.json yet. Run <code>node trainer/run.js</code>.</p>';
    prog.innerHTML = '';
    return;
  }
  const ratings = Object.entries(m.ladder).sort((a, b) => b[1] - a[1]);
  const rows = ratings.map(([name, elo], i) =>
    `<tr class="${name === 'champion' ? 'top' : ''}"><td>${name}</td>
     <td class="num">${elo}</td><td class="num ci">${name === 'champion' ? 'live' : ''}</td></tr>`).join('');

  const s = m.series;
  const line = (label, x) => `<tr><td>${label}</td>
    <td class="num">${(x.win_rate * 100).toFixed(0)}%</td>
    <td class="num ci">${(x.ci[0] * 100).toFixed(0)}&ndash;${(x.ci[1] * 100).toFixed(0)}</td>
    <td class="num ci">${x.wins}W ${x.losses}L ${x.draws}D</td></tr>`;

  box.innerHTML = `
    <table>
      <tr><th>contender</th><th class="num">elo</th><th class="num"></th></tr>
      ${rows}
    </table>
    <table style="margin-top:14px">
      <tr><th>champion matchup</th><th class="num">win rate</th><th class="num">95% CI</th><th class="num"></th></tr>
      ${line('vs champion (this run)', s.vs_champion)}
      ${line('vs scripted bot', s.vs_scripted)}
      ${line('vs humanized scripted', s.vs_humanized)}
      ${line('vs random', s.vs_random)}
    </table>
    <p class="hint">${m.promoted ? 'Promoted this run.' : 'Not promoted this run.'}
      Last run ${new Date(m.generated_at).toLocaleString()}.
      Champion ${m.champion_bytes} B of a ${m.budget_bytes} B budget.</p>`;

  const curve = m.difficulty_curve ?? [];
  prog.innerHTML = '<h3 style="font-size:13px;margin:6px 0">Difficulty dial</h3>' +
    curve.map((c) => `<div class="meter">
      <div class="label"><span>${c.level === 0 ? 'superhuman' : `humanizer ${Math.round(c.level * 100)}%`}</span>
        <span>${(c.winRate * 100).toFixed(0)}% vs scripted</span></div>
      <div class="track"><div class="fill" style="width:${Math.round(c.winRate * 100)}%"></div></div>
      <div class="label"><span class="ci">95% CI ${(c.lo * 100).toFixed(0)}&ndash;${(c.hi * 100).toFixed(0)}%</span></div>
    </div>`).join('');
}

function renderSpec() {
  const s = state.spec;
  $('spec').innerHTML = `
    <dl>
      <dt>game</dt><dd>${s.title ?? s.id} <code>${s.id}</code></dd>
      <dt>summary</dt><dd>${state.entry?.summary ?? ''}</dd>
      <dt>features</dt><dd><div class="tags">${s.features.map((f) => `<span>${f}</span>`).join('')}</div>
        <div class="ci">all normalized to [-1, 1]</div></dd>
      <dt>actions</dt><dd><div class="tags">${s.actions.map((a) => `<span>${a}</span>`).join('')}</div>
        <div class="ci">discrete intents; your own controllers do the steering</div></dd>
      <dt>contexts</dt><dd><div class="tags">${s.contexts.map((c) => `<span>${c}</span>`).join('')}</div>
        <div class="ci">chosen by the gate from ${s.gate.inputs.join(' and ')}</div></dd>
      <dt>archetypes</dt><dd><div class="tags">${s.archetypes.map((a) => `<span>${a}</span>`).join('')}</div></dd>
      <dt>reward</dt><dd>${Object.entries(s.reward).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', ')}</dd>
      <dt>budget</dt><dd>${s.budget_bytes} B per brain &middot; match ${s.sim?.match_seconds}s @ ${s.sim?.tick_rate} Hz,
        decision every ${(s.sim?.tick_rate * s.sim?.decision_every) / 1000}s</dd>
    </dl>`;
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

function installInput() {
  addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    state.keys.add(e.code);
    if (e.code === 'Tab') {
      e.preventDefault();
      if (!state.match) return;
      const a = state.match.arena;
      const mine = a.units.filter((u) => u.team === $('side-select').value && u.alive);
      if (!mine.length) return;
      const i = mine.findIndex((u) => u.id === state.selected);
      state.selected = mine[(i + 1) % mine.length].id;
      renderXray(a.units.find((u) => u.id === state.selected));
    }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
  });
  addEventListener('keyup', (e) => state.keys.delete(e.code));
  addEventListener('blur', () => state.keys.clear());

  canvas.addEventListener('click', (ev) => {
    if (!state.match) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * ARENA_W;
    const y = ((ev.clientY - rect.top) / rect.height) * ARENA_H;
    let best = null, bd = 22;
    for (const u of state.match.arena.units) {
      const d = Math.hypot(u.x - x, u.y - y);
      if (u.alive && d < bd) { bd = d; best = u; }
    }
    if (best) {
      state.selected = best.id;
      renderXray(best);
    }
  });

  $('humanize').oninput = () => {
    const v = Number($('humanize').value);
    $('humanize-out').textContent = v === 0 ? 'superhuman' : v < 25 ? 'brutal' : v < 50 ? 'hard' : v < 75 ? 'fair' : 'easy';
    restart();
  };
  $('humanize-out').textContent = 'superhuman';

  $('side-select').onchange = () => restart();
  $('btn-pause').onclick = () => {
    state.paused = !state.paused;
    $('btn-pause').textContent = state.paused ? 'Resume' : 'Pause';
    $('btn-pause').classList.toggle('on', state.paused);
  };
  $('btn-step').onclick = () => { state.paused = true; $('btn-pause').textContent = 'Resume'; state.match.tick(); };
  $('btn-reset').onclick = () => restart();
  $('btn-speed').onclick = () => {
    state.speed = state.speed === 1 ? 2 : state.speed === 2 ? 4 : 1;
    $('btn-speed').textContent = `${state.speed}\u00d7`;
  };

  $('btn-record').onclick = () => {
    state.recordingOn = !state.recordingOn;
    $('btn-record').classList.toggle('on', state.recordingOn);
    $('btn-record').textContent = state.recordingOn ? 'Recording: play a full match' : 'Start recording';
    $('btn-download').disabled = true;
    $('record-status').textContent = state.recordingOn ? 'every decision on your side is being logged' : '';
    restart();
  };
  $('btn-download').onclick = () => {
    if (!state.recordText) return;
    const blob = new Blob([state.recordText], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `arena-${Date.now()}.s1d`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
}

function finishRecording() {
  if (!state.recorder) return;
  state.recordText = state.recorder.toText();
  $('btn-download').disabled = false;
  const lines = state.recordText.trim().split('\n').length - 1;
  const human = (state.recordText.match(/"src":"human"/g) || []).length;
  $('record-status').innerHTML = `${human} human decisions captured. Drop it in
    <code>games/arena/data/human/</code> and open a PR.`;
  state.recordingOn = false;
  $('btn-record').classList.remove('on');
  $('btn-record').textContent = 'Start recording';
}

boot();

// Keep the x-ray panel live for the selected unit.
setInterval(() => {
  if (!state.match) return;
  const u = state.match.arena.units.find((x) => x.id === state.selected);
  if (u && u.alive) renderXray(u);
}, 250);