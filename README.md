# System One

One brain format, one recording format, one game spec. The pipeline is shared;
each game plugs in through three small contracts.

The argument in one paragraph: game AI does not fail because the maths is hard,
it fails because every engine, every genre, and every studio ends up writing a
different training stack. System One standardizes the *interface* instead of the
model. The brain is a few hundred bytes of int8 weights, decisions are discrete
tactical intents, and the same file runs in a browser, Unity, and Godot with a
bit-identical evaluator. What is left per game is the one thing that was always
the real work: deciding what the AI should see.

```
GAME (any engine)  ──Contract 1──▶  S1 SDK (~20 lines per engine)
                                       │ observe / act / log
                  ◀──Contract 3──  brain.s1b (tiny binary)
                                       ▲
                    Contract 2: recordings (.s1d), your own ".dem"
                                       │
             TRAINER (Node, GitHub Actions): imitate → self-play → league → promote
                                       │
             SHOWCASE (GitHub Pages): live arena, X-ray, ladder, record-yourself
```

**Live showcase:** <https://muxd22-alt.github.io/Browser_Arena/docs/>
**Live trainer:** the `.github/workflows/evolve.yml` job runs every hour at
`:17`, refreshes `games/arena/brains/champion.s1b`, and republishes the site.

## Contents

- [Quick start](#quick-start)
- [What is actually implemented](#what-is-actually-implemented)
- [Tour: read in this order](#tour-read-in-this-order)
- [The reference game](#the-reference-game)
- [The three contracts](#the-three-contracts)
- [Cross-language parity](#cross-language-parity)
- [Integrating a game](#integrating-a-game)
- [The trainer](#the-trainer)
- [Difficulty](#difficulty)
- [The showcase page](#the-showcase-page)
- [GitHub Pages setup](#github-pages-setup)
- [Repository layout](#repository-layout)
- [Limits worth stating plainly](#limits-worth-stating-plainly)

## Quick start

```bash
npm test              # 38 tests: format, arena invariants, trainer math
npm run demo         # full pipeline: imitate → self-play → league → publish
npm run serve        # http://localhost:8080/docs/
```

`npm run demo` finishes in about ten seconds and prints its own reasoning. It
generates seed data on first run, so a fresh clone needs no setup. The showcase
needs an HTTP origin — browsers block module imports and `fetch()` on
`file://`.

## What is actually implemented

| Piece | Where | State |
|---|---|---|
| Contract 1: spec, schema, spec hash | `spec/game.s1.schema.json`, `sdk/js/s1.js` | done |
| Contract 2: `.s1d` recorder/reader | `sdk/js/s1d.js` | done |
| Contract 3: `.s1b` pack/unpack/evaluate | `sdk/js/s1.js` | done |
| Golden conformance vectors | `spec/golden.json`, `spec/verify.js` | done, 702 cases |
| JS evaluator | `sdk/js/s1.js` | done |
| Unity evaluator | `sdk/unity/S1.cs` | done |
| Godot evaluator | `sdk/godot/s1.gd` | done |
| Reference game | `games/arena/` | done, 3v3 capture the flag |
| Imitation (ridge/OLS) | `trainer/imitate.js` | done |
| Self-play (ES) | `trainer/evolve.js` | done |
| League (Elo + Wilson gate) | `trainer/league.js` | done |
| Difficulty dial | `sdk/js/s1.js` + per-engine ports | done |
| Showcase page | `docs/` | done, five sections |
| Hourly pipeline | `.github/workflows/evolve.yml` | done |

## Tour: read in this order

If you have ten minutes and want the shape of the project:

1. [The three contracts](#the-three-contracts) — the *only* thing every engine
   has to know.
2. [Integrating a game](#integrating-a-game) — the ~20 lines per engine that
   hook you in.
3. [The trainer](#the-trainer) — what `npm run demo` and the hourly job actually
   do, in the order above.
4. [The showcase page](#the-showcase-page) — what the published `.s1b` looks
   like in a browser.
5. [The reference game](#the-reference-game) — the 3v3 capture the flag that
   proves the contracts end to end, including the four bugs the sim fought back
   with.

The [limits](#limits-worth-stating-plainly) section is worth coming back to as
well, regardless of the order above.

## The reference game

Station Run: 3v3 capture the flag in a derelict station. A fixed,
hand-authored map — three lanes, a central pillar, two base bumpers that seal
the centre line so every flag run is also a flank decision. Real projectiles,
no friendly fire, magazines, shields, and a waypoint graph for navigation.

The map is fixed on purpose. A trainer that trains on one map and ships on
another learns the wrong thing, and a visitor arriving at the showcase should
see the same arena every time.

### Four bugs worth naming

The sim fought back, and every one of these looked like "the AI is bad" rather
than "the rules are wrong".

1. **Reload was a trap.** The reload took 45 ticks and the decision cadence is
   4 ticks, so re-arming the timer on every reissued intent meant a unit
   reloaded forever. Then, once fixed, reloading still zeroed the movement
   intent, so a unit stood dead in the open for 45 ticks while a carrier got
   shot. Reloading now keeps walking.

2. **The wall shell was a prison.** Collision used a padded box, and a unit
   resting exactly on the shell counted as *inside* it. Every collision query
   from that spot answered "blocked", so units froze against walls forever. The
   fix is threefold: a strict interior test, an overlap that must have length,
   and a perpendicular fallback so a cornered unit turns it instead of stalling.
   This one alone accounted for most of the side bias.

3. **Defenders broke the flags.** One flag-handling rule said "any unit standing
   on this flag returns it", applied even when nobody was carrying anything. A
   defender loitering near home made the flag vanish for ten seconds.

4. **Array order was a team.** Bullets resolved against the first unit in the
   unit list, and blue units are first. Clumped squads overlap constantly, so
   every exchange went to blue. Separating units had the same flaw: pushes were
   applied as they were computed, making the result depend on storage order.
   Both now resolve independently of order, and the arena test suite asserts the
   map and the waypoint graph are mirror-symmetric so this cannot creep back.

Capture-the-flag also needs four feature slots the old game did not:
`has_flag`, `flag_stolen`, `score_proximity`, and `carrier_dist`. Without them a
linear policy can see hp and line of sight but cannot tell "run the flag home"
from "charge the enemy", because both look like advancing.

## The three contracts

### Contract 1: `game.s1.json`

The only per-game design work. See `games/arena/game.s1.json` for a worked
example: ten normalized feature slots, seven discrete actions, four contexts, a
two-input gate, three archetypes, a 1 KB budget.

Feature slots are fixed and normalized to `[-1,1]`. Actions are discrete
intents, because continuous control is the part that does not transfer between
games, and the brain deliberately stops at the intent boundary: your steering,
aiming, and animation code does the rest.

The spec hash covers everything the tensor layout depends on. Change a feature
name and every previously trained brain refuses to load, loudly, instead of
silently reading the wrong columns.

### Contract 2: `.s1d`

One JSON line per decision. Any engine can emit this in a few lines.

```json
{"kind":"s1d","s1":1,"game":{"id":"arena","features":[...],"actions":[...]}}
{"t":1042,"u":3,"arch":1,"f":[0.4,1,0.8,0.5,-0.2,0.1,0.6,0.4,1,0.7],"ctx":1,"a":2,"src":"human"}
{"t":1200,"end":{"win":1,"score":[12,9],"kills":[3,1]}}
```

`src` is `human`, `scripted`, or `selfplay`. The trainer weights human data
highest, so a human-like baseline is one command away and real play data is
strictly better than a simulator's. Your own sim gives perfect labels and exact
state, which beats any `.dem`.

### Contract 3: `.s1b`

```
header (16 B)  magic "S1B1", spec hash (u32), n_features, n_actions,
               n_contexts, n_archetypes, flags, min_dwell_ticks
body           int8 weights [ctx][action][feature]
               int8 archetype biases [archetype][action]
               int8 gate threshold (when gated)
               float32 feature scales, float32 bias scale
```

The reference arena's gated brain is **493 bytes**, the ungated tier-1 brain is
**196 bytes**, both under the 1 KB budget.

The gate is two ramp inputs into four contexts, with a minimum dwell so the
policy does not thrash. Thresholds are trained alongside the weights, because
hand-tuning them per game is exactly the work this project exists to remove.

## Cross-language parity

The portability claim is not aspirational; it is checked.

```bash
node spec/make-golden.js    # regenerate vectors
node spec/verify.js         # 705 assertions, 0 failures
```

`spec/golden.json` embeds four brains (hand-built, random, tiny, and the live
champion) plus 702 feature cases with expected action and score. The Unity and
GDScript evaluators are literal transcriptions, and a parity test in their own
CI asserts the same vectors. If all three agree on these cases, they agree on
every input, because `decide()` is a fixed number of multiply-adds over a known
layout.

One deliberate quirk is preserved in all three ports: the archetype bias is
scaled by `scale[0]`. It came from the original reference snippet and changing
it would invalidate every existing brain.

## Integrating a game

About twenty lines per engine, then everything else is shared.

```csharp
// Unity
var brain = S1Brain.Load(path, S1Spec.Hash(specJson));
void Tick() {
    if (tick % 4 != 0) return;
    game.Observe(unit, features);                       // fill spec.features.Count floats in [-1,1]
    var ctx = brain.Gate(pressure, advantage, prevCtx, dwell);
    game.Act(unit, brain.Decide(features, archetype, ctx));
    if (recording) recorder.Step(tick, unit.Id, archetype, features, ctx, action);
}
```

```gdscript
# Godot
var brain := S1Brain.load_file("res://brains/champion.s1b", expected_hash)
var ctx := brain.gate(pressure, advantage, prev_ctx, dwell)
game.act(unit, brain.decide(features, archetype, ctx))
```

```js
// JavaScript: the one the website runs
import { decide, gateContext } from './sdk/js/s1.js';
const ctx = gateContext(brain, pressure, advantage, prevCtx, dwell);
const act = decide(brain, features, archetype, ctx).action;
```

Then add `game.s1.json`, drop a `.s1d` in `games/<game>/data/`, and the
trainer picks it up. `games/index.json` makes it appear in the showcase.

## The trainer

Four stages, in the order that makes each one useful.

1. **Imitate.** Ridge-regularized least squares, one-vs-rest per context. The
   policy is already linear in the features, so imitation is a linear system:
   milliseconds, no learning rate, an exact answer instead of a noisy one.
   Sparse contexts fall back to the pooled fit rather than becoming zero rows.

2. **Self-play.** Evolution strategies with antithetic sampling and a 1+lambda
   accept rule, run against the *quantized* int8 brain rather than a float
   precursor. Optimizing something the player never runs is a classic way to
   ship a brain that got worse after packing.

3. **League.** Elo across the roster, win rates from both sides of the ball
   (so mirror bias cannot inflate a result), Wilson intervals rather than
   binomial confidence, which matters at these sample sizes.

4. **Promote.** Only if the candidate's Wilson lower bound clears a margin over
   the champion, the sample size is adequate, and it has not regressed against
   the scripted bar. Otherwise the old champion stays and the run says why:

   ```
   promote: no -> Wilson lower bound 0.393 below 0.55
   ```

A run that refuses to promote is a healthy run. Two of the four runs during
development ended in exactly that message.

The warm start is chosen by measurement, not assumption: imitation is usually
stronger early and evolution later, so the trainer evaluates both and starts
from whichever actually wins.

The same four stages run on every push through `npm test` (smoke) and on the
hour through `.github/workflows/evolve.yml` (full pipeline, publishes the new
champion if promoted).

## Difficulty

Train the brain as strong as you like, then put the **humanizer** on top: one
slider driving reaction delay, aim error, and a mistake rate, with a per-role
bias so snipers stay steadier than entries. The champion's difficulty curve is
published in `metrics.json` and drawn on the showcase page, so "easy to
superhuman" is one number instead of six hand-tuned constants. This is the
difference between AI that is strong and NPCs that feel fair.

## The showcase page

`npm run serve`, then open `http://localhost:8080/docs/`. It needs an HTTP
origin: browsers block module imports and `fetch()` on `file://`.

1. **Live arena.** The real `.s1b` in the visitor's browser, art from the Kenney
   space shooter kit. Swap between random, scripted, human-like, the 196-byte
   tiny table, the imitation fit, and the hourly champion. Same fight, different
   shapes. Blue and red are separated by colour on ships, tracers, dotted target
   lines, flags, and the HUD, because two teams that read the same in a
   firefight is the worst readability failure this kind of game has.
2. **X-ray.** Click any unit for the exact per-feature contribution behind its
   decision, the score gap over the runner-up, and where it sits on the gate's
   thresholds. A linear policy can do this; a network cannot.
3. **Ladder.** Elo, win rates with confidence intervals, and the difficulty
   curve, straight from the last `metrics.json`.
4. **Game chooser.** Reads `games/index.json`, renders any game's spec in plain
   language, swaps the brain.
5. **Teach it.** Play in the browser with WASD and the mouse, download the
   `.s1d`, open a PR. Browsers cannot trigger Actions safely without a token, so
   the PR route is the honest one.

### Controls

`WASD` moves the white-ringed unit. `Space` holds position and overrides WASD.
The mouse sets the firing angle and **left click fires** — nothing fires on its
own, and a shot only lands if an enemy is inside your aim cone. `Q` shields, `R`
reloads, `Tab` hands you another unit. Two AI teammates come from the brain on
your side, so you lead a squad rather than playing alone.

## GitHub Pages setup

The page imports `../sdk/...`, `../games/...`, and `../assets/...` from
`docs/app.js`, so the **whole repo** has to be the site root, not just `docs/`.

Two ways to land on the same site:

- **Pages artifact (default, recommended).** The `evolve.yml` workflow builds
  and uploads the entire repo as the Pages artifact. No manual setting needed;
  the `pages` job in that workflow is the source of truth. Live URL:
  `https://<user>.github.io/<repo>/docs/`.
- **Branch source.** Settings → Pages → Source: *Deploy from a branch* → Branch:
  `main` / `(root)`. The root `index.html` is a meta-refresh to `/docs/`, and
  everything else resolves from there.

Do **not** set Pages source to `main / docs`. With that setting, only the
contents of `docs/` are published, `sdk/`, `games/`, and `assets/` 404, and the
page is stuck on `loading…` because the JS modules fail to import.

## Repository layout

```
system-one/
  spec/       game.s1.schema.json, golden.json, make-golden.js, verify.js, test/
  sdk/        js/s1.js, js/s1d.js, unity/S1.cs, godot/s1.gd
  games/
    index.json
    arena/
      game.s1.json        Contract 1
      src/                the game: arena.js, controllers.js, match.js
      brains/             tiny.s1b, imitated.s1b, candidate.s1b, champion.s1b
      data/               .s1d recordings
      metrics.json        what the showcase reads
  trainer/    imitate.js, evolve.js, league.js, run.js, test/
  docs/       index.html, app.js, style.css, serve.js
  .github/workflows/evolve.yml
```

## Limits worth stating plainly

- This works where decisions are discrete and tactical. Complex perception and
  long-horizon strategy need bigger brains, so keep the tier system: 1 KB
  linear, 4 KB with extra ramps, 16 KB for a small MLP.
- "Universal" means a universal *interface and pipeline*. Each game still needs
  its feature design, which is the real work. The spec schema and the ten-slot
  reference make that as quick as possible; they do not make it automatic.
- The reference game is a small arena, not a production title. It exists to prove
  the contracts end to end. A real game keeps its own sim and only implements
  `Observe` and `Act`.
- A 365-byte linear policy is strong at tactics and weak at strategy. That is
  the honest ceiling of this tier, and the difficulty dial is what covers the
  gap for players.