# Phase 1 notes — playable vertical slice

> Companion to [README.md](README.md) (the product spec). This file records what Phase 1
> actually implements, the decisions taken where the spec left room, and what is deliberately
> still missing. Nothing below claims a feature that is not in the code.

## Status

Phase 1 is **implemented and verified**: a playable seven-lane demo with a hand-authored chart,
a runtime-synthesised original demo track, audio-clock-authoritative timing, judgments, combo,
score, holds, pause/resume/restart, countdown and a results screen. 75 unit tests pass and a
complete on-time playthrough was run in a real browser (see *Verification*).

Out of scope for this phase (and not started): MP3 upload, audio analysis, automatic chart
generation, chart editor, IndexedDB, Laravel backend, YouTube sources.

## Run it (Linux, Node >= 22.12)

```bash
npm install          # from the repository root (npm workspaces)
npm run dev          # http://127.0.0.1:5173
npm test             # 75 Vitest unit tests
npm run typecheck    # tsc --noEmit
npm run build        # production build into frontend/dist
```

`npm run <script>` at the root delegates to the `seven-keys` workspace in `frontend/`, so
`cd frontend && npm run dev` works too. There is no `.env`, no API key and no network access at
runtime: the demo song is synthesised locally with `OfflineAudioContext`.

## Architecture

```
main.ts                     bootstrap + window.SevenKeys debug API
ui/       dom, Hud, Overlay, ResultsScreen, GameApp   (state machine + the single rAF loop)
game/     GameConfig, JudgmentEngine, ScoreManager, GameEngine, InputManager
chart/    ChartTypes (versioned schema), PatternParser, ChartValidator, demoChart
content/  demoSong.ts        hand-authored bars: music + chart patterns (one source of truth)
audio/    AudioSource (interface + precision contract), PlaybackTimeline, DemoSynth, AudioEngine
renderer/ Layout, SceneManager, LaneRenderer, NoteRenderer, EffectRenderer
storage/  SettingsStore      localStorage for small settings only
```

The dependency direction is one-way: `game/` and `chart/` know nothing about Three.js, Web
Audio or the DOM. `GameEngine` receives a `SongClock` (`{ getSongTimeMs() }`) and timestamped
lane presses, which is why the rules are testable in Node and why frame rate cannot affect
scoring.

### Timing (the core decision)

* `PlaybackTimeline` is a pure state machine: `songTimeMs(ctxSec)` is a closed-form function of
  the `AudioContext` clock — anchored at `(anchorSongMs, anchorCtxSec)`, or frozen at an exact
  value. Nothing accumulates frame deltas anywhere in the codebase.
* Pause freezes the timeline and stops the buffer. Resume creates a **new** `AudioBufferSourceNode`
  scheduled to begin at exactly the frozen position, so pause/resume cannot drift. The same code
  path powers `seekTo()`, which is the foundation of the Phase 4 editor preview.
* Negative song time is the count-in: an anchor of `(0 ms, now + 1.2 s)` simply means the first
  audio sample is 1.2 s away, so the lead-in needs no special case in the renderer or the rules.
* Visual note position is `z = -(timeToHitMs / leadMs) * ROAD_LENGTH` — stateless, so at any
  speed the note reaches `z = 0` exactly at its chart time.
* Note speed is visual only. Chart offset shifts visuals *and* judgment. The global calibration
  offset shifts **judgment only** (`judgeTimeMs = songTimeMs - globalOffsetMs`, applied
  identically to presses and miss deadlines). Positive global offset = "my presses land late".
  Documented in `game/GameConfig.ts` and in the UI.

### Judgments, holds and scoring

| Judgment | \|error\| | combo |
|---|---:|---|
| PERFECT | <= 45 ms | +1 |
| GOOD | <= 100 ms | +1 |
| BAD | <= 160 ms | reset |
| MISS | beyond 160 ms | reset |

* A press matches the *closest* pending note in its lane inside the BAD window; anything with no
  match is a counted **stray press** with no penalty.
* Holds: the head is judged like a tap, then the key must stay down until the tail minus a
  100 ms grace window. Releasing early breaks the hold (combo reset, tail score forfeited, head
  score kept). Pausing mid-hold forfeits the tail **without** a combo penalty.
* Score: `round(basePoints * units * multiplier)` with PERFECT 300 / GOOD 200 / BAD 100 / MISS 0,
  `multiplier = 1 + 0.01 * min(combo, 100)` (1.0x at combo 0, 2.0x from combo 100), a tap is 1
  unit and a hold is 2 (head + tail). Combo counts notes, so a completed hold does not add a
  second combo step.
* Accuracy is judgment-weighted and combo independent:
  `(300*P + 200*G + 100*B) / (300 * judgedNotes)`; grades S/A/B/C/D/F at 95/90/80/70/60 %.
* Each note head leaves `pending` exactly once, which is what makes "cannot be judged twice"
  checkable; every note is resolved by the end of a run (misses auto-resolve from the clock).

### Rendering

* Two `InstancedMesh` pools (cap-shaped boxes, hold bodies) with per-instance colour, plus a
  pooled ring-effect layer. All matrices/colours come from preallocated scratch objects: a frame
  allocates nothing.
* Culling is a single advancing pointer from the front plus an early break past the lead time.
  A backwards clock jump (resume/seek) rewinds the pointer.
* 7 lane strips, 8 separators, 2 rails, a hit-line bar and 7 receptors; lane strips and receptors
  animate with a frame-rate independent exponential approach. Pixel ratio is capped at 2.
* Measured in the browser: 27–33 draw calls and 230–350 triangles with 8 notes on screen.

### Demo content

"Neon Circuit" (original, 150 BPM, 36 bars ≈ 57.6 s, 231 notes, 12 holds, 4-bar looped
arrangement). One checked-in definition drives both halves — the synth plays `drums/bass/lead/pad`
and the chart expands the `chart` patterns — so audio and chart cannot drift apart. The chart is
hand-authored, **not** auto-generated: bars use a compact step grid
(`"0 . 2 . 4~2 . . ."`, `"0+3 . . ."`, 16 steps per bar) parsed by `chart/PatternParser.ts` and
asserted by tests to be 16 steps on every bar.

## Verification

Automated (`npm test`, 75 tests): judgment boundaries (45/100/160 inclusive, symmetric),
combo/multiplier/accuracy/hold rules, grade boundaries, pattern parsing, validator errors and
warnings, demo-chart invariants (231 notes, no errors **and** no warnings, deterministic),
timeline freeze/resume continuity, and engine integration — no double judgment, auto-miss timing,
chord independence, hold completion/break/interrupt, pause resume without desync, frame-rate
independence at 5/16/120 ms update steps, and a full perfect demo run through the rules layer.

Manual, in a real browser (`npm run dev`):

| Check | Result |
|---|---|
| `A S D SPACE J K L` incl. chords | 231-note run driven by real key events: **231 PERFECT, 0 GOOD/BAD/MISS**, max combo 231, score 129,873 |
| Results screen | grade **S**, 100.00 % accuracy, max combo 231, 12 holds (11 completed / 1 interrupted), 0 stray presses, 231 notes |
| Pause/resume integrity | a focus-loss pause mid-run interrupted one hold and the run continued to a perfect 231/231 with no misses |
| Console | no errors or failed requests |
| Resize to 720x460 | CSS size, drawing buffer, renderer size and camera aspect (1.5652) all followed the viewport |
| HUD | score, clock, progress, accuracy, per-judgment counters, combo, count-in and lane key pills all live |

Note: the preview panel is throttled to ~30 fps; the render cost above (sub-350 triangles) is not
a frame-rate measurement, and timing correctness is frame-rate independent by construction and by
the 5/16/120 ms test.

## Debug API

```js
SevenKeys.state()      // full structured snapshot (clock, counts, renderer, audio metrics)
SevenKeys.start() / .pause() / .resume() / .restart()
SevenKeys.seek(20000)  // move the playhead (skipped notes resolve as misses)
SevenKeys.app.engine.notes   // runtime notes with per-note status
```

## Limitations and known issues

* One demo chart only (Normal). Difficulty variants belong to the automatic generator (Phase 3),
  so the ready screen has no difficulty picker yet.
* No health/fail state (explicitly optional in the spec) — a run always ends in Results.
* No hit sound per note beyond the synthesised judgment ticks; no bloom/post-processing.
* Key bindings are fixed; remapping is a later-phase feature.
* Stray presses are counted but not penalised (intentional default: `ghostTapPenalty: false`).
* The 588 kB JS bundle (150 kB gzip) is mostly three.js. Code-splitting the renderer is a
  Phase 7 concern.
* Audio always comes from the runtime synthesiser; MP3 upload/decode and the latency calibration
  wizard are Phase 2. The offset slider is the manual equivalent until then.
* Results are local only: no upload, no leaderboard, no anti-cheat story yet (see README).
* `YouTubePlayerSource` is **not** implemented. `audio/AudioSource.ts` documents the interface and
  the guarantee difference (approximate clock, unranked) so Phase 6 cannot accidentally treat a
  YouTube clock as sample-accurate.

## Next phase

Phase 2 — local MP3: file picker with validation (type/size/decode/duration/memory), decode via
`AudioContext.decodeAudioData`, playback through the existing `AudioEngine`, a latency calibration
wizard that measures and writes `globalOffsetMs`, and error handling for unsupported files. The
timeline, engine and renderer need no changes: they already consume a decoded `AudioBuffer`.
