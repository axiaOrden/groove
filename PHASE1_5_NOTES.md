# Seven Keys — Phase 1.5 notes (mobile touch + landscape gameplay)

Phase 1.5 adds touch input, a landscape-first mobile layout, and orientation/fullscreen handling
to the phase 1 vertical slice. Nothing in the phase 1 gameplay was replaced: the same
`GameEngine`, audio clock, chart, renderer and HUD are used, and a desktop session still gets
byte-identical camera settings (verified: fov 52, camera `(0, 7, 9) → (0, 0, -10)`).

Scope of this phase: touch, layout, orientation, fullscreen, feedback, tests, docs.
**Not** in scope and untouched: MP3 upload, audio analysis, chart editor, backend, YouTube.

---

## 1. Architecture: four new modules, two extended

| Module | Kind | Responsibility |
|---|---|---|
| [LanePressTracker.ts](frontend/src/game/LanePressTracker.ts) | new, pure | who holds each lane: a *set of sources* per lane (`key:KeyA`, `pointer:17`), so two fingers on one lane cannot double-judge and lifting one finger cannot release the other's lane |
| [CameraFraming.ts](frontend/src/renderer/CameraFraming.ts) | new, pure | solves the camera pose and the on-screen lane geometry for any viewport, cutouts, touch/desktop |
| [DeviceProfile.ts](frontend/src/ui/DeviceProfile.ts) | new | touch-first detection, `?touch=` override, display-cutout insets, px parsing |
| [TouchSurface.ts](frontend/src/ui/TouchSurface.ts) | new, DOM | the seven lane columns and pads, positioned from the camera projection |
| [OrientationGate.ts](frontend/src/ui/OrientationGate.ts) | new | portrait gate, fullscreen, orientation lock, settle debounce |
| [InputManager.ts](frontend/src/game/InputManager.ts) | extended | pointer events next to keyboard, one shared press/release pipeline |
| [SceneManager.ts](frontend/src/renderer/SceneManager.ts) | extended | `applyFraming()` sets the solved pose on the camera |
| [GameApp.ts](frontend/src/ui/GameApp.ts) | extended | device profile, framing, resize, orientation pause/resume, audio interruptions, visual-lead cap |

Unchanged by design: `GameEngine`, `JudgmentEngine`, `ScoreManager`, `PlaybackTimeline`,
`AudioEngine`'s clock, `NoteRenderer`, `LaneRenderer`, `EffectRenderer`, `ChartValidator`,
the demo content and the chart data.

```
frontend/src/
  game/     LanePressTracker.ts  (new)      InputManager.ts  (extended)
  renderer/ CameraFraming.ts     (new)      SceneManager.ts  (extended)
  ui/       DeviceProfile.ts     (new)      TouchSurface.ts  (new)
            OrientationGate.ts   (new)      GameApp.ts       (extended)
            Hud.ts (contentBottomPx)        dom.ts (DOM contract)
  main.ts   (debug hooks)                   styles.css (touch layout, rotate gate)
frontend/index.html  (touch layer, rotate overlay, fullscreen buttons, viewport-fit=cover)
frontend/tests/      camera-framing, lane-press-tracker, touch-input, touch-surface,
                     device-profile, orientation-gate      (83 new tests)
```

## 2. Touch input contract

The seven lane keys and seven finger columns feed **one** pipeline: `onLanePress(lane, songTimeMs)`
and `onLaneRelease(lane, songTimeMs)` on the `InputManager`, timestamped from the audio clock at
the moment of the DOM event. There is no synthetic keyboard event anywhere (asserted by a test
that installs a `keydown` spy and plays a note by touch).

* **pointerId → lane** is kept in `InputManager.pointerLanes`, so a release can only ever settle
  the lane that pointer went down on, even if the finger slid sideways.
* **Pointer capture.** `pointerdown` captures the pointer on its lane column
  (`setPointerCapture`, guarded — jsdom and some platforms lack it). Every later event for that
  pointer, including `pointerup`, is delivered to the captured element, which is why a press
  survives a slide and why `pointercancel` can be observed. `lostpointercapture` is treated as a
  release (it also fires right after a normal `pointerup`, where the map entry is already gone —
  releasing an unknown pointer is a no-op).
* **Duplicate presses.** A lane is down while at least one source holds it; a second finger on a
  held lane lights the pad but does *not* re-judge the lane. Keyboard and finger on one lane are
  two holders: the lane goes up only when both let go.
* **Interruption.** `blur`, `visibilitychange(hidden)`, pause, orientation change and disabling
  input all release every lane without emitting a release judgment (a hold is settled as
  interrupted by the engine, never as a break). A finger that is still physically down then gets
  its `pointerup` ignored, because the pointer map was cleared.
* **No page gestures.** `touch-action: none` on the surface, `preventDefault()` on
  `pointerdown`/`pointerup`, `contextmenu` suppressed on the surface, `overscroll-behavior: none`
  and `user-select: none` on `#stage`. Pinch zoom is deliberately *not* disabled globally (meta
  viewport stays zoomable for accessibility); only the gameplay surface owns its gestures.

## 3. Mobile camera framing (`CameraFraming.ts`)

The phase 1 camera left the road in the middle ~43 % of a 2.2:1 phone viewport: ~50 px per lane
and no relationship to any thumb position. The mobile camera is therefore **solved**, not tuned:

* hard **A** — seven lane columns span `LANE_SPREAD` (0.9) of the usable width,
* hard **B** — the hit line sits at `HIT_LINE_FRACTION` (0.82) of the usable height,
* soft **C** — maximise read time, aiming to put the spawn plane at the top of the usable area,
* limit **D** — the vertical fov must stay in 10°…80° and the camera distance in 4…24 world units.
  D may bend C (and is then reported as `clamped`), never A or B.

Camera family: `position (cx, h, u)` looking at `(cx, 0, -k)`; the phase 1 camera is exactly
`h=7, u=9, k=10`. Lane spacing on screen is `LANE_PITCH·f/depthHit`, so A pins `f/depthHit = S`,
and `screenY(0) = H/2 + S·h·k/L` pins `h·k`; keeping the desktop steepness leaves one free
parameter `u`. A and B are therefore *exact* for any `u`, and `u` is bisected for C.

Measured (unit tested and reproduced live in the browser):

| viewport | mode | fov | camera (y, z) | lane px | hit line | read time |
|---|---|---|---|---|---|---|
| 800×360 (20:9 phone) | mobile | 20.7° | 6.38, 12.58 | 103 | 295/360 = 0.82 | 1800 ms (whole road) |
| 667×375 (16:9 phone) | mobile | 15.5° | 10.03, 21.33 | 86 | 307/375 = 0.82 | 1800 ms |
| 1024×768 (tablet) | mobile-clamped | 18.2° | 11.75, 24 (limit D) | 132 | 630/768 = 0.82 | 1800 ms |
| 360×800 (portrait) | mobile-clamped | 47.7° | 17.45, 24 (limit D) | 46 | 656/800 = 0.82 | 1800 ms |
| 1440×700 (desktop) | desktop | 52° | 7, 9 (unchanged) | 96 | 578/700 = 0.83 | 1800 ms (fog) |

Portrait is deliberately imperfect (46 px lanes, fov clamping) — that is what the rotate overlay
is for; the numbers are reported rather than hidden.

Cutouts: the usable rectangle comes from a hidden `env(safe-area-inset-*)` probe per resize, the
road centre is shifted onto the usable centre with a lateral camera move (a parallel translation,
so the perspective is unchanged), and the lane columns are derived from the *final* projection, so
they always line up with the 3D lanes.

The renderer caps its visual lead at `framing.visibleLeadMs + 250 ms` (a no-op on desktop and on a
landscape phone, where the whole road is visible; it stops a clamped viewport submitting notes
that are past the top edge to the GPU).

## 4. Layout, HUD and pads

* `#touch-layer` sits directly above the canvas and *below* `#hud` in document order, so HUD
  buttons keep winning the hit test while the rest of the screen belongs to the lane columns.
* Columns start below the *measured* bottom of the HUD text block (`hud-stats`), so reaching for
  the score cannot trigger a note; each column spans the full height down to the usable bottom.
* Column boundaries are the midpoints between projected lane centres, extended to both screen
  edges: every pixel maps to the nearest lane (no dead strips), and each column contains its lane.
* Pads are a short visual strip (12 % of the height, clamped 34–84 px) pinned to the bottom of each
  column, `pointer-events: none`, so they never cover the notes; the label is the lane letter.
* Touch HUD: compact top band (title, score, clock, counters, progress) with pause/restart/
  fullscreen as small buttons, key-hint pills hidden (the pads already show the letters and light
  up), panels trimmed so the menu, pause and results sheets fit a 360 px-tall landscape screen
  without scrolling.

## 5. Orientation, fullscreen and audio interruptions

* Portrait on a touch device shows the rotate overlay and **pauses** the run; leaving portrait
  resumes automatically **only** if the rotation caused the pause, and only after the viewport has
  settled (debounced ~260 ms, because a rotation fires several resizes).
* "Continue in portrait" dismisses the gate for the session (the clamped portrait layout is
  playable, so the escape hatch is honest).
* Fullscreen + `screen.orientation.lock('landscape')` are requested **once per browser** (a
  persisted flag) from the Start gesture; the buttons stay available. Every outcome is reported as
  a value, never thrown, and never retried in a loop: `entered | exited | already | unsupported |
  rejected | timeout` and `locked | unsupported | rejected | skipped | timeout`. Firefox has no
  lock → `unsupported`; not-fullscreen → `rejected`.
* **`timeout` is a real outcome.** Live verification in this project's preview shell found that
  `requestFullscreen()` can return a promise that *never settles*; awaiting it stranded the whole
  immersive path (the flag was written, no result recorded, the lock never attempted). Requests
  are now bounded (1.2 s) and the result reflects the actual fullscreen state.
* Audio interruptions: a `statechange` on the `AudioContext` that leaves `running` while the
  timeline was advancing pauses the game (call, another app taking audio focus, OS suspension)
  instead of judging against a frozen clock.

## 6. Timing is untouched

Judgments still come from `PlaybackTimeline` evaluated at `AudioContext.currentTime`; touch adds no
frame-based path, no extra latency buffer and no smoothing. Chart offset and the global calibration
offset behave exactly as documented in
[GameConfig.ts](frontend/src/game/GameConfig.ts) (chart offset moves visuals *and* judgment,
global offset moves judgment only). A phone that measures late on the results screen can raise the
global offset from the same menu as on desktop.

## 7. Tests

`npm test` → **164 tests in 12 files**, of which **83 are new** in this phase. The pure suites run
in `node`; the input/layout/orientation suites opt into jsdom with a per-file docblock.

| Suite | Covers |
|---|---|
| `camera-framing.test.ts` (16) | desktop pose is byte-identical; lanes fill 0.9 of the usable width; hit line at 0.82; lane targets ≥ 48 px on phones; monotone even spacing; fov/depth bounds; cutout shift; determinism; NaN safety; **cross-checked against three.js's own projection matrix** |
| `lane-press-tracker.test.ts` (9) | up→down transition once; two fingers on one lane; key+finger on one lane; chords; no source migration; invalid lanes; `releaseAll`/`releaseLane` |
| `touch-input.test.ts` (22) | single touch; chords (2 and 4 fingers); hold + release; `pointercancel`; `lostpointercapture`; several pointers on one lane; keyboard+touch mixing; auto-repeat; capture call; no synthetic key events; nested-target resolution; events outside the surface; focus loss during a hold (no late judgment, stale `pointerup` ignored); hidden tab; disabled input; **and the real `GameEngine` scoring a tap/hold chart driven only by pointer events** |
| `touch-surface.test.ts` (11) | one column per lane with labels; columns contain their lanes; contiguous tiling of the width; target size; clearance below the HUD; pad strip size; rotation/resize relayout; cutouts; per-lane lighting; interactivity |
| `device-profile.test.ts` (10) | touch-layout rule (hybrid laptops stay desktop); `?touch=` parsing; px parsing; env() probe read + probe cleanup |
| `orientation-gate.test.ts` (15) | overlay on portrait/off on landscape; settle debounce and re-entry; non-touch layouts never gate; dismiss; fullscreen enter/exit/unsupported/rejected/**never-settling**; lock outcomes; one-shot flag and no-nag behaviour |

Not covered by automated tests (verified live instead, see below): the WebGL renderer, the
`GameApp` orchestration as a whole, and real hardware touch. Unit tests inject pointer events;
a real finger is exercised by the manual checklist in §9.

## 8. Live verification (this machine, Chrome via the dev server)

* Phone landscape (800×360, `?touch=1`): framing `mobile`, fov 20.7°, lanes 103 px wide, hit line
  at 295/360, canvas and renderer both 800×360 at aspect 2.222, 32 draw calls / 290 triangles.
* **Full chart played through touch events only**: 231/231 PERFECT, 0 GOOD/BAD/MISS, max combo
  231, 12/12 holds completed, 0 broken, 0 stray presses, mean press error −0.4 ms, worst 4.7 ms
  (the audio clock is sampled in the event task, so this is delivery jitter, not input lag).
* Three simultaneous pointers observed during chords; a duplicated double-fire of the same chart
  (two drivers racing) produced 247 presses but still exactly 231 judgments and **zero** strays —
  the duplicate guard working on a real double event.
* Rotate to portrait while playing → rotate overlay visible, state `paused`, framing
  `mobile-clamped`, lane width 46 px; rotate back → overlay hidden, settle debounce, **auto-resumed
  to `playing`** with the clock resuming from the frozen position.
* Desktop regression (1280×720, no query): framing `desktop`, camera `(0,7,9) → (0,0,-10)`, fov 52,
  hit line 595/720, touch layer `display: none`, and a real key press (`a`) judged exactly once.
* Results and ready sheets fit 360 px-tall landscape without scrolling.

## 9. Testing on an Android phone

```bash
# on the development machine (Node 22+)
npm install
npm run dev --workspace seven-keys -- --host 0.0.0.0 --port 5173
# find your LAN address, e.g. 192.168.1.42, then open on the phone:
#   http://192.168.1.42:5173/          (normal detection)
#   http://192.168.1.42:5173/?touch=1  (force the touch layout, useful for debugging)
```

Checklist (Chrome and Firefox for Android):

1. Load in portrait → the rotate overlay appears with a fullscreen button.
2. Tap **Fullscreen** → the browser chrome hides; in Chrome Android the orientation locks to
   landscape. Firefox has no lock API and reports it as unsupported (the overlay says so).
3. Rotate to landscape → gameplay with seven lane columns filling the width; rotation while
   playing pauses the run and resumes it once the viewport settles.
4. Play a chord (e.g. `A`+`K` together) → both lanes light, both notes judge. Put two fingers on
   one lane → it lights once and judges once.
5. Hold a long note (cyan lanes with tails) for its whole length, then slide a finger off the
   column mid-hold → the hold survives the slide (pointer capture) and only a real lift breaks it.
6. Background the app mid-hold (home / notification shade) → the game pauses, no phantom miss
   storm, and a resume works with a fresh count-in.
7. Verify a note *near a cutout* (e.g. a phone with a left-side punch hole in landscape) still
   lines up with its lane column: the road is shifted onto the usable rectangle.
8. Check `window.SevenKeys.layout()` in remote debugging for the framing/zone numbers.

## 10. Limitations and known issues

* Portrait gameplay is supported only as a fallback (46 px lanes, clamped fov); it is not ranked
  or tuned.
* The mobile camera is meaningfully more telephoto than the desktop one (≈15–21° fov on a phone vs
  52° on desktop). That is a direct consequence of "seven lanes fill the usable width" plus "the
  hit line is low"; the road therefore foreshortens less dramatically than on desktop.
* Lane alignment is exact at the hit line and approximate higher up the screen (the projected road
  is a trapezoid, the touch columns are rectangles). Alignment at the hit line is what a thumb uses.
* On an extreme viewport (e.g. 8:1) the framing reports `clamped`: lanes still fill the width while
  the read time drops to ~0.5 s.
* `screen.orientation.lock()` is Chrome-only; Safari and Firefox will not lock (documented, not
  worked around with CSS rotation tricks).
* Stray touch presses are counted but not penalised, as in phase 1.
* The bundle is now 606 kB (155 kB gzip), essentially all three.js; no code splitting yet.
* Verified on desktop Chrome and with synthetic pointer events. A physical Android device test is
  the remaining manual step (§9).

## 11. Next phase

**Phase 1.6 (slide/swipe between lanes)** is built directly on this work: the lane a finger is on
is now resolved from its coordinates against the column rectangles below (`laneAtPoint`), so a
gesture can cross columns and each boundary is judged. Nothing here had to change — the pointer
map, capture, duplicate guard and release paths are all reused. See
[PHASE1_6_NOTES.md](PHASE1_6_NOTES.md).

Phase 2 (local MP3) needs no changes to this work either: decode → `AudioBuffer` →
`AudioEngine.loadBuffer` already feeds the same clock, the same engine and the same framing. The
pieces worth extending there are the calibration wizard (touch latency on a phone is meaningfully
different from a keyboard), the per-device note-speed default, and a landscape-aware settings
layout for the timeline/waveform work in phase 4.
