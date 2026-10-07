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
  WALLS, DECOR, NODES, BASES, ARENA_W, ARENA_H, TICK_RATE, ACTIONS, CONTEXTS,
  CAPTURES_TO_WIN, FLAG_GRAB_R,
} from '../games/arena/src/arena.js';
import {
  brainController, scriptedController, randomController, scriptedHumanized,
  humanizer as humanizerFactory,
} from '../games/arena/src/controllers.js';
import { createMatch } from '../games/arena/src/match.js';

const $ = (id) => document.getElementById(id);

// Team identity is carried by colour everywhere: ships, bullets, lines, and the
// HUD. Two teams that are hard to tell apart in a firefight are the single
// worst readability failure in a game like this.
const TEAM = {
  blue: { line: '#4cc2ff', deep: '#1d6fa5', glow: '#bde9ff', name: 'BLUE' },
  red: { line: '#ff7a4c', deep: '#a53a1c', glow: '#ffd0bd', name: 'RED' },
};
const CONTEXT_COLORS = ['#ff9f43', '#4c9aff', '#ffd166', '#7ee787'];

const state = {
  index: null, entry: null, spec: null, metrics: null,
  brains: new Map(), match: null,
  brainKey: null, side: 'blue', selected: null,
  paused: false, speed: 1, acc: 0, last: 0,
  recorder: null, recordText: null, recordingOn: false,
  keys: new Set(), mouse: { x: ARENA_W / 2, y: ARENA_H / 2, down: false },
  lastResult: null, sprites: new Map(),
};

const featBuf = new Float64Array(32);

// ---------------------------------------------------------------------------
// sprites
// ---------------------------------------------------------------------------

const SPRITE_FILES = [
  'ship_entry', 'ship_sniper', 'ship_support',
  'rock_a', 'rock_b', 'rock_c',
  'bullet', 'bullet_glow', 'exhaust', 'explosion', 'shield',
  'wall_a', 'wall_b', 'wall_c', 'wall_d',
  'block_a', 'block_b', 'block_c',
  'solar_blue', 'solar_red', 'dish', 'dome_a', 'dome_b', 'dome_c', 'tower', 'mast',
];

async function loadSprites() {
  await Promise.all(SPRITE_FILES.map((name) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { state.sprites.set(name, img); resolve(); };
    img.onerror = () => resolve();
    img.src = `../assets/sprites/${name}.png`;
  })));
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

async function boot() {
  const status = $('status');
  let index;
  try {
    index = await fetchJson('../games/index.json');
  } catch {
    status.className = 'status error';
    status.textContent = 'could not load games/index.json';
    return showServeHint();
  }
  state.index = index;
  const sel = $('game-select');
  sel.innerHTML = '';
  for (const g of state.index.games) {
    const o = document.createElement('option');
    o.value = g.dir;
    o.textContent = g.title ?? g.id;
    sel.appendChild(o);
  }
  sel.onchange = () => loadGame(sel.value);
  await loadSprites();
  installInput();
  await loadGame(sel.value);
  requestAnimationFrame(frame);
}

function showServeHint() {
  const box = document.createElement('div');
  box.className = 'panel';
  box.innerHTML = `<div class="error" style="padding:12px">
    This page loads game data with <code>fetch()</code>, which browsers block on
    <code>file://</code>. Run <code>npm run serve</code> and open
    <code>http://localhost:8080/docs/</code>.</div>`;
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
        state.brains.set(entry.label, { kind: 'brain', brain, header });
        label = `${entry.label} · ${header.bytes} B`;
      } catch (e) {
        label = `${entry.label} (unavailable)`;
      }
    } else {
      state.brains.set(entry.label, { kind: entry.controller });
    }
    addOption(blueSel, entry.label, label);
    addOption(redSel, entry.label, label);
  }

  const champ = state.entry.brains.find((b) => b.file === 'champion.s1b');
  state.brainKey = champ ? champ.label : state.entry.brains[0].label;
  blueSel.value = 'you';
  redSel.value = state.brainKey;
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
// the showcase shows a mixed squad rather than a lone unit in a void.
function humanController() {
  return function (unit) {
    const a = this.arena;
    const f = a.observe(unit, featBuf);
    unit.features = Array.from(f.slice(0, state.spec.features.length));
    unit.arch = mirroredSlot(unit);
    unit.recordSrc = 'human';
    unit.isHuman = true;
    // A human gets a wider firing cone than a bot. The same cone that makes a
    // bot precise makes a mouse feel like a lottery.
    unit.aimCone = 0.55;

    const gateBrain = state.brains.get(state.brainKey)?.brain;
    const [p, adv] = a.gateInputs(unit, f);
    unit.ctx = gateBrain?.gated ? gateContext(gateBrain, p, adv, unit.ctx, unit.ctxSince) : 1;

    if (unit.id !== state.selected) {
      unit.lastHuman = 'escort';
      a.steerTo(unit, a.objectiveFor(unit).x, a.objectiveFor(unit).y, 0.85);
      unit.wantsFire = false;
      return ACTIONS.indexOf('advance');
    }

    // Mouse aims. Left click fires. No auto-fire: the shot is the player's.
    unit.aimAngle = Math.atan2(state.mouse.y - unit.y, state.mouse.x - unit.x);
    unit.aimX = state.mouse.x;
    unit.aimY = state.mouse.y;
    unit.wantsFire = state.mouse.down;

    if (state.keys.has('KeyQ') && unit.cd <= 0) {
      unit.lastHuman = 'ability';
      unit.wantsFire = false;
      return ACTIONS.indexOf('use_ability');
    }
    if (state.keys.has('KeyR') && unit.ammo < 8) {
      unit.lastHuman = 'reload';
      unit.wantsFire = false;
      return ACTIONS.indexOf('reload');
    }

    let dx = 0, dy = 0;
    if (state.keys.has('KeyW') || state.keys.has('ArrowUp')) dy -= 1;
    if (state.keys.has('KeyS') || state.keys.has('ArrowDown')) dy += 1;
    if (state.keys.has('KeyA') || state.keys.has('ArrowLeft')) dx -= 1;
    if (state.keys.has('KeyD') || state.keys.has('ArrowRight')) dx += 1;

    // Space bar holds position: zero movement intent, and it deliberately
    // overrides any WASD input so "hold" always wins over "move".
    if (state.keys.has('Space')) {
      unit.lastHuman = 'hold';
      a.moveIntent(unit, unit.x, unit.y, 0);
      return ACTIONS.indexOf('hold');
    }

    if (dx === 0 && dy === 0) {
      unit.lastHuman = 'anchor';
      a.moveIntent(unit, unit.x, unit.y, 0);
      return ACTIONS.indexOf('hold');
    }

    const mag = Math.hypot(dx, dy);
    const { unit: enemy } = a.nearestEnemy(unit);
    const ex = enemy ? enemy.x - unit.x : 0;
    const ey = enemy ? enemy.y - unit.y : 0;
    const em = Math.hypot(ex, ey) || 1;
    const facing = (dx / mag) * (ex / em) + (dy / mag) * (ey / em);

    if (facing > 0.55) {
      unit.lastHuman = 'push';
      a.steerTo(unit, a.objectiveFor(unit).x, a.objectiveFor(unit).y, 1);
      return ACTIONS.indexOf('advance');
    }
    if (facing < -0.55) {
      unit.lastHuman = 'fall back';
      a.steerTo(unit, unit.x - (ex / em) * 70, unit.y - (ey / em) * 70, 1);
      return ACTIONS.indexOf('retreat');
    }
    unit.lastHuman = 'strafe';
    a.steerTo(unit, unit.x - (ey / em) * 50, unit.y + (ex / em) * 50, 0.9);
    return ACTIONS.indexOf('peek');
  };
}

function mirroredSlot(u) {
  const teamSize = state.spec.sim?.team_size ?? 3;
  return (u.team === 'blue' ? u.idx : teamSize - 1 - u.idx) % state.spec.archetypes.length;
}

function teamController(label) {
  const entry = state.brains.get(label);
  if (!entry) return scriptedController;
  if (entry.kind === 'scripted') return scriptedController;
  if (entry.kind === 'random') return randomController;
  if (entry.kind === 'human') return scriptedHumanized(Number($('humanize').value) / 100, 7);
  const level = Number($('humanize').value) / 100;
  return brainController(entry.brain, {
    gated: entry.brain.gated,
    humanizer: level > 0 ? humanizerRef(level, 7) : null,
    archetypeFor: mirroredSlot,
  });
}

// One shared humanizer instance per side keeps its reaction state per unit.
let hzCache = new Map();
function humanizerRef(level, seed) {
  const key = `${level}:${seed}`;
  if (!hzCache.has(key)) hzCache.set(key, humanizerFactory(level, seed));
  return hzCache.get(key);
}
function sideController(value) {
  const mateCtl = value === 'you' ? teamController(state.brainKey) : teamController(value);
  if (value !== 'you') return mateCtl;
  const human = humanController();
  return function (unit) {
    const r = mateCtl.call(this, unit);
    unit.isHuman = false;
    return unit.idx === 0 ? human.call(this, unit) : r;
  };
}

// ---------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------

function restart() {
  if (!state.spec) return;
  const side = $('side-select').value;
  hzCache = new Map();
  state.recorder = state.recordingOn ? new Recorder({ src: 'human', spec: state.spec }) : null;
  state.match = createMatch({
    seed: 1 + Math.floor(Math.random() * 100000),
    blue: sideController($('blue-ctl').value),
    red: sideController($('red-ctl').value),
    teamSize: state.spec.sim?.team_size ?? 3,
    seconds: state.spec.sim?.match_seconds ?? 120,
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
    while (state.acc >= 1 && guard++ < 60) {
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
  const mine = r.win === 0 ? 'stalemate'
    : ((r.win > 0) === (state.side === 'blue') ? 'you take it' : 'you lose it');
  ov.innerHTML = `<div><div style="font-size:22px">${r.score[0]} &ndash; ${r.score[1]}</div>
    <div class="hint">${mine} &middot; ${r.kills[0]}&ndash;${r.kills[1]} kills &middot; first to ${CAPTURES_TO_WIN} takes it</div>
    <div style="margin-top:12px"><button id="btn-again">Play again</button></div></div>`;
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

function sprite(name) {
  const img = state.sprites.get(name);
  return img && img.complete && img.naturalWidth ? img : null;
}

function drawSprite(name, x, y, scale = 1, rot = 0, tint = null) {
  const img = sprite(name);
  const w = (img ? img.naturalWidth : 32) * scale;
  const h = (img ? img.naturalHeight : 32) * scale;
  g.save();
  g.translate(x, y);
  if (rot) g.rotate(rot);
  if (img) g.drawImage(img, -w / 2, -h / 2, w, h);
  else { g.fillStyle = '#4a5768'; g.fillRect(-w / 2, -h / 2, w, h); }
  if (tint) {
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = tint;
    g.globalAlpha = 0.55;
    g.fillRect(-w / 2, -h / 2, w, h);
  }
  g.restore();
}

function draw() {
  const a = state.match.arena;
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#080b10';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.scale(SCALE, SCALE);

  // starfield, deterministic
  g.fillStyle = 'rgba(255,255,255,0.10)';
  for (let i = 0; i < 90; i++) {
    const x = ((i * 137.5) % 640);
    const y = ((i * 271.3) % 400);
    g.fillRect(x, y, 1, 1);
  }

  drawDecor();
  drawBases();
  drawWalls();
  drawLines();
  drawFlags();
  drawBullets();
  drawUnits();
  drawFx();

  g.restore();
  drawHud(a);
}

function drawDecor() {
  for (const d of DECOR) {
    drawSprite(d.s, d.x, d.y, d.scale, d.r, 'rgba(120,150,190,0.25)');
  }
  for (const n of NODES) {
    g.fillStyle = 'rgba(255,255,255,0.045)';
    g.beginPath();
    g.arc(n.x, n.y, 2.2, 0, Math.PI * 2);
    g.fill();
  }
}

function drawBases() {
  for (const key of ['blue', 'red']) {
    const b = BASES[key];
    const t = TEAM[key];
    g.save();
    g.beginPath();
    g.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    g.fillStyle = key === 'blue' ? 'rgba(76,194,255,0.10)' : 'rgba(255,122,76,0.10)';
    g.fill();
    g.setLineDash([6, 5]);
    g.strokeStyle = t.line;
    g.globalAlpha = 0.75;
    g.lineWidth = 1.6;
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
    g.fillStyle = t.line;
    g.font = 'bold 9px ui-monospace, monospace';
    g.textAlign = 'center';
    g.fillText(key === 'blue' ? 'HOME' : 'ENEMY', b.x, b.y - b.r - 5);
    g.restore();
  }
}

const WALL_SPRITES = ['block_a', 'wall_a', 'block_b', 'wall_c', 'block_c', 'wall_d'];

function drawWalls() {
  WALLS.forEach((w, i) => {
    const name = WALL_SPRITES[i % WALL_SPRITES.length];
    const img = sprite(name);
    const sw = img ? img.naturalWidth : 40;
    const sh = img ? img.naturalHeight : 40;
    const s = Math.max(w.w / sw, w.h / sh) * 1.15;
    drawSprite(name, w.x + w.w / 2, w.y + w.h / 2, s, 0, 'rgba(140,165,200,0.35)');
    // Solid silhouette so cover reads at a glance even at small zoom.
    g.fillStyle = 'rgba(10,14,20,0.55)';
    g.fillRect(w.x, w.y, w.w, w.h);
    g.strokeStyle = 'rgba(150,180,215,0.35)';
    g.lineWidth = 1;
    g.strokeRect(w.x + 0.5, w.y + 0.5, w.w - 1, w.h - 1);
  });
}

// Dotted lines, one colour per team. Each unit draws the line to whatever it is
// shooting at; the selected unit also draws its whole firing cone, so the aim
// rules are visible instead of mysterious.
function drawLines() {
  const a = state.match.arena;
  for (const u of a.units) {
    if (!u.alive) continue;
    const t = TEAM[u.team];
    const target = a.visibleEnemies(u)[0];
    if (target) {
      g.save();
      g.setLineDash([2, 6]);
      g.lineWidth = 1.4;
      g.strokeStyle = t.line;
      g.globalAlpha = 0.75;
      g.beginPath();
      g.moveTo(u.x, u.y);
      g.lineTo(target.x, target.y);
      g.stroke();
      g.restore();
    }
  }
  const sel = a.units.find((u) => u.id === state.selected);
  if (sel && sel.alive) {
    const t = TEAM[sel.team];
    g.save();
    g.setLineDash([4, 5]);
    g.lineWidth = 1.6;
    g.strokeStyle = t.glow;
    g.globalAlpha = 0.8;
    g.beginPath();
    g.moveTo(sel.x, sel.y);
    g.lineTo(sel.aimX, sel.aimY);
    g.stroke();
    // firing cone
    g.globalAlpha = 0.12;
    g.fillStyle = t.line;
    g.beginPath();
    g.moveTo(sel.x, sel.y);
    g.arc(sel.x, sel.y, 220, sel.aimAngle - sel.aimCone, sel.aimAngle + sel.aimCone);
    g.closePath();
    g.fill();
    g.restore();
  }
}

function drawFlags() {
  const a = state.match.arena;
  for (const key of ['blue', 'red']) {
    const f = a.flags[key];
    if (f.state === 'returned') continue;
    const t = TEAM[key];
    const bob = Math.sin(state.match.arena.tick / 9) * 2;
    g.save();
    g.strokeStyle = t.line;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(f.x, f.y + 12);
    g.lineTo(f.x, f.y - 12 + bob);
    g.stroke();
    g.fillStyle = t.line;
    g.beginPath();
    g.moveTo(f.x, f.y - 12 + bob);
    g.lineTo(f.x + 13, f.y - 7 + bob);
    g.lineTo(f.x, f.y - 2 + bob);
    g.closePath();
    g.fill();
    g.globalAlpha = 0.28;
    g.beginPath();
    g.arc(f.x, f.y, FLAG_GRAB_R, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
}

function drawBullets() {
  const a = state.match.arena;
  for (const b of a.bullets) {
    const t = TEAM[b.team];
    g.save();
    g.translate(b.x, b.y);
    g.rotate(Math.atan2(b.vy, b.vx));
    g.globalAlpha = 0.55;
    drawSprite('bullet_glow', -7, 0, 0.55);
    g.globalAlpha = 1;
    // Tracer: a short capsule in the firing team's colour, so a blue round and
    // a red round are never mistaken for each other in a crossfire.
    g.fillStyle = t.glow;
    g.fillRect(-9, -1.1, 11, 2.2);
    g.fillStyle = t.line;
    g.fillRect(-8, -0.6, 10, 1.2);
    g.restore();
  }
  void a;
}

function drawUnits() {
  const a = state.match.arena;
  for (const u of a.units) {
    if (!u.alive) {
      g.save();
      g.globalAlpha = 0.25;
      drawSprite('explosion', u.x, u.y, 0.6);
      g.restore();
      continue;
    }
    const t = TEAM[u.team];
    const arch = mirroredSlot(u);
    const shipName = arch === 2 ? 'ship_sniper' : arch === 1 ? 'ship_support' : 'ship_entry';

    // shield bubble
    if (u.shield > 0) drawSprite('shield', u.x, u.y, 1.1, 0, 'rgba(126,231,135,0.5)');

    g.save();
    g.translate(u.x, u.y);
    g.rotate(u.aimAngle + Math.PI / 2);
    drawSprite('exhaust', -10, 0, 0.8, Math.PI);
    drawSprite(shipName, 0, 0, 0.62, 0, t.deep);
    g.restore();

    // context ring: which mood the gate picked
    g.strokeStyle = CONTEXT_COLORS[u.ctx] ?? '#555';
    g.lineWidth = 2.5;
    g.beginPath();
    g.arc(u.x, u.y, 13, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, u.hp) / 100);
    g.stroke();

    if (u.id === state.selected) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(u.x, u.y, 17, 0, Math.PI * 2);
      g.stroke();
    }
    if (u.carrying) {
      g.fillStyle = t.glow;
      g.beginPath();
      g.arc(u.x, u.y - 20, 3.4, 0, Math.PI * 2);
      g.fill();
    }

    g.font = '9px ui-monospace, monospace';
    g.textAlign = 'center';
    g.fillStyle = t.glow;
    g.fillText((ACTIONS[u.lastAction] ?? '?').slice(0, 4), u.x, u.y + 25);
    if (u.reloading > 0) {
      g.fillStyle = '#ffd166';
      g.fillText('RLD', u.x, u.y + 35);
    }
  }
  void a;
}

function drawFx() {
  for (const f of state.match.arena.fx) {
    if (f.kind === 'boom' && f.t < 14) {
      drawSprite('explosion', f.x, f.y, 0.6 + f.t * 0.22, f.t, 'rgba(255,200,120,0.8)');
    } else if (f.kind === 'impact' && f.t < 5) {
      g.save();
      g.globalAlpha = 1 - f.t / 5;
      g.fillStyle = '#ffd9a0';
      g.beginPath();
      g.arc(f.x, f.y, 2.4 + f.t, 0, Math.PI * 2);
      g.fill();
      g.restore();
    } else if (f.kind === 'capture' && f.t < 40) {
      const t = TEAM[f.team];
      g.save();
      g.globalAlpha = 1 - f.t / 40;
      g.strokeStyle = t.line;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(f.x, f.y, 20 + f.t * 2.5, 0, Math.PI * 2);
      g.stroke();
      g.restore();
    }
  }
}

function drawHud(a) {
  const blue = a.teams.blue.score;
  const red = a.teams.red.score;
  const left = Math.max(0, a.maxTicks - a.tick) / TICK_RATE;
  g.save();
  g.font = 'bold 13px ui-monospace, monospace';
  g.textAlign = 'left';
  g.fillStyle = TEAM.blue.line;
  g.fillText(`BLUE ${blue}`, 14, 22);
  g.textAlign = 'right';
  g.fillStyle = TEAM.red.line;
  g.fillText(`${red} RED`, canvas.width - 14, 22);
  g.textAlign = 'center';
  g.fillStyle = 'rgba(255,255,255,0.6)';
  g.font = '12px ui-monospace, monospace';
  g.fillText(`${left.toFixed(0)}s`, canvas.width / 2, 22);
  g.textAlign = 'left';
  g.font = '11px ui-monospace, monospace';
  g.fillStyle = 'rgba(255,255,255,0.45)';
  g.fillText(`kills ${a.teams.blue.kills}-${a.teams.red.kills}`, 14, 38);
  // flag pips
  for (let i = 0; i < CAPTURES_TO_WIN; i++) {
    g.fillStyle = i < blue ? TEAM.blue.line : 'rgba(255,255,255,0.18)';
    g.fillRect(canvas.width / 2 - 26 + i * 10, 30, 7, 7);
    g.fillStyle = i < red ? TEAM.red.line : 'rgba(255,255,255,0.18)';
    g.fillRect(canvas.width / 2 + 20 - i * 10, 30, 7, 7);
  }
  g.restore();
}

function renderLegend() {
  const box = $('legend');
  box.innerHTML = '';
  const item = (color, html) => {
    const d = document.createElement('div');
    d.innerHTML = `<span class="swatch" style="background:${color}"></span>${html}`;
    box.appendChild(d);
  };
  item(TEAM.blue.line, 'blue team &middot; lines, tracers, flags');
  item(TEAM.red.line, 'red team &middot; never the same colour');
  CONTEXTS.forEach((c, i) => item(CONTEXT_COLORS[i], `gate: ${c}`));
  item('#7ee787', 'shield');
  item('#ffd166', 'reloading');
  const note = document.createElement('div');
  note.innerHTML = '<b>Faint dots</b> mark the navigation lanes. The label under a unit is its intent.';
  box.appendChild(note);
}

// ---------------------------------------------------------------------------
// x-ray
// ---------------------------------------------------------------------------

function renderXray(unit) {
  const box = $('xray');
  const entry = state.brains.get(state.brainKey);
  if (!entry || entry.kind !== 'brain') {
    box.innerHTML = '<p class="empty">Pick a trained brain on the blue side to enable X-ray.</p>';
    return;
  }
  const brain = entry.brain;
  const a = state.match.arena;
  const f = a.observe(unit, featBuf);
  const arch = mirroredSlot(unit);
  const x = explain(brain, f, arch, unit.ctx, state.spec.features);
  const scores = scoreAll(brain, f, arch, unit.ctx);
  const all = state.spec.actions.map((n, i) => ({ n, i, s: scores[i] })).sort((p, q) => q.s - p.s);

  const mine = unit.team === state.side;
  const role = mine ? (unit.idx === 0 ? 'you' : 'AI teammate') : 'opponent';

  const chips = all.map((c) =>
    `<span class="chip${c.i === x.action ? ' win' : ''}"><b>${c.n}</b> ${c.s.toFixed(1)}</span>`).join('');

  const rows = x.terms.slice().sort((p, q) => Math.abs(q.contrib) - Math.abs(p.contrib)).map((t) => {
    const pct = Math.min(50, (Math.abs(t.contrib) / Math.max(1e-6, Math.abs(x.score))) * 50);
    const style = t.contrib >= 0
      ? `left:50%;width:${pct}%;background:var(--accent)`
      : `right:50%;width:${pct}%;background:var(--red)`;
    return `<div class="row">
      <div class="top"><span class="name">${t.feature}</span>
        <span class="num">${t.value.toFixed(2)} &times; ${t.weight} = ${t.contrib.toFixed(2)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="${style}"></div></div>
    </div>`;
  }).join('');

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
    : '<div class="mark">this brain has no gate</div>';

  const flagBits = [];
  flagBits.push(`flag: ${a.flags[unit.team].state}`);
  const theirs = a.flags[unit.team === 'blue' ? 'red' : 'blue'];
  flagBits.push(`enemy flag: ${theirs.state}`);

  box.innerHTML = `
    <h3>${unit.team === 'blue' ? 'Blue' : 'Red'} unit ${unit.idx}</h3>
    <div class="who">${role} &middot; archetype <b>${state.spec.archetypes[arch]}</b> &middot;
      context <b>${CONTEXTS[unit.ctx]}</b> &middot; hp ${Math.round(unit.hp)}</div>
    <div class="chips"><span class="chip">${flagBits.join(' &middot; ')}</span></div>
    <div class="chips">${chips}</div>
    <p class="hint">Score for <b>${state.spec.actions[x.action]}</b> is
      ${x.score.toFixed(2)}, ${(all[0].s - all[1].s).toFixed(2)} clear of <b>${all[1].n}</b>.
      Archetype bias ${x.bias.toFixed(1)}.</p>
    ${rows}
    <div class="gate">
      <b>gate</b>: pressure ${p.toFixed(2)}, advantage ${adv.toFixed(2)}
      <div class="ramp">${bands}</div>
      dwell ${brain.minDwellTicks} ticks, held ${unit.ctxSince}
</div>`;
}

// ---------------------------------------------------------------------------
// panels
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
  const rows = ratings.map(([name, elo]) =>
    `<tr class="${name === 'champion' ? 'top' : ''}"><td>${name}</td><td class="num">${elo}</td>
      <td class="num ci">${name === 'champion' ? 'live' : ''}</td></tr>`).join('');
  const line = (label, x) => `<tr><td>${label}</td><td class="num">${(x.win_rate * 100).toFixed(0)}%</td>
    <td class="num ci">${(x.ci[0] * 100).toFixed(0)}&ndash;${(x.ci[1] * 100).toFixed(0)}</td>
    <td class="num ci">${x.wins}W ${x.losses}L ${x.draws}D</td></tr>`;

  box.innerHTML = `
    <table><tr><th>contender</th><th class="num">elo</th><th class="num"></th></tr>${rows}</table>
    <table style="margin-top:14px">
      <tr><th>champion matchup</th><th class="num">win rate</th><th class="num">95% CI</th><th class="num"></th></tr>
      ${line('vs champion (this run)', m.series.vs_champion)}
      ${line('vs scripted bot', m.series.vs_scripted)}
      ${line('vs human-level scripted', m.series.vs_humanized)}
      ${line('vs random', m.series.vs_random)}
    </table>
    <p class="hint">${m.promoted ? 'Promoted this run.' : 'Not promoted this run.'}
      ${new Date(m.generated_at).toLocaleString()} &middot;
      champion ${m.champion_bytes} B of a ${m.budget_bytes} B budget.</p>`;

  const curve = m.difficulty_curve ?? [];
  prog.innerHTML = '<h3 style="font-size:13px;margin:6px 0">Difficulty dial</h3>' +
    curve.map((c) => `<div class="meter">
      <div class="label"><span>${c.level === 0 ? 'superhuman' : `opponent humanized ${Math.round(c.level * 100)}%`}</span>
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
        <div class="ci">all normalized to [-1, 1]; the last four are the capture-the-flag state</div></dd>
      <dt>actions</dt><dd><div class="tags">${s.actions.map((a) => `<span>${a}</span>`).join('')}</div>
        <div class="ci">discrete intents; your own controllers do the steering</div></dd>
      <dt>contexts</dt><dd><div class="tags">${s.contexts.map((c) => `<span>${c}</span>`).join('')}</div>
        <div class="ci">chosen by the gate from ${s.gate.inputs.join(' and ')}</div></dd>
      <dt>archetypes</dt><dd><div class="tags">${s.archetypes.map((a) => `<span>${a}</span>`).join('')}</div></dd>
      <dt>reward</dt><dd>${Object.entries(s.reward).map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', ')}</dd>
      <dt>budget</dt><dd>${s.budget_bytes} B per brain &middot; match ${s.sim?.match_seconds}s @ ${s.sim?.tick_rate} Hz,
        decision every ${((s.sim?.tick_rate ?? 20) * (s.sim?.decision_every ?? 4)) / 1000}s,
        first to ${s.sim?.captures_to_win} captures</dd>
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
      const mine = state.match.arena.units.filter((u) => u.team === state.side && u.alive);
      if (!mine.length) return;
      const i = mine.findIndex((u) => u.id === state.selected);
      state.selected = mine[(i + 1) % mine.length].id;
      renderXray(mine.find((u) => u.id === state.selected));
    }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
  });
  addEventListener('keyup', (e) => state.keys.delete(e.code));
  addEventListener('blur', () => { state.keys.clear(); state.mouse.down = false; });

  // The mouse both aims and fires. Left button down = firing this frame.
  canvas.addEventListener('mousemove', (ev) => {
    const p = canvasPos(ev);
    state.mouse.x = p.x;
    state.mouse.y = p.y;
  });
  canvas.addEventListener('mousedown', (ev) => {
    if (ev.button === 0) state.mouse.down = true;
    const p = canvasPos(ev);
    state.mouse.x = p.x;
    state.mouse.y = p.y;
    const hit = pickUnit(p.x, p.y);
    if (hit) {
      state.selected = hit.id;
      renderXray(hit);
    }
  });
  addEventListener('mouseup', (ev) => { if (ev.button === 0) state.mouse.down = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  $('humanize').oninput = () => {
    const v = Number($('humanize').value);
    $('humanize-out').textContent = v === 0 ? 'superhuman'
      : v < 25 ? 'brutal' : v < 50 ? 'hard' : v < 75 ? 'fair' : 'easy';
    restart();
  };
  $('humanize-out').textContent = 'superhuman';

  $('side-select').onchange = () => { state.side = $('side-select').value; restart(); };
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

function canvasPos(ev) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((ev.clientX - rect.left) / rect.width) * ARENA_W,
    y: ((ev.clientY - rect.top) / rect.height) * ARENA_H,
  };
}

function pickUnit(x, y) {
  let best = null, bd = 20;
  for (const u of state.match.arena.units) {
    if (!u.alive) continue;
    const d = Math.hypot(u.x - x, u.y - y);
    if (d < bd) { bd = d; best = u; }
  }
  return best;
}

function finishRecording() {
  if (!state.recorder) return;
  state.recordText = state.recorder.toText();
  $('btn-download').disabled = false;
  const human = (state.recordText.match(/"src":"human"/g) || []).length;
  $('record-status').innerHTML = `${human} human decisions captured. Drop it in
    <code>games/arena/data/human/</code> and open a PR.`;
  state.recordingOn = false;
  $('btn-record').classList.remove('on');
  $('btn-record').textContent = 'Start recording';
}

boot();

setInterval(() => {
  if (!state.match) return;
  const u = state.match.arena.units.find((x) => x.id === state.selected);
  if (u && u.alive) renderXray(u);
}, 250);