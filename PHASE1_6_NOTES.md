# Seven Keys — Phase 1.6 notes (slide / swipe input)

Phase 1.6 makes the seven touch lanes *continuous*: a finger that stays on the glass can move from
lane to lane, and every column boundary it crosses is judged. Phase 1 tapping, phase 1.5
multi-touch/holds/landscape layout and the whole phase 1 gameplay are untouched — the same
`GameEngine`, `JudgmentEngine`, `ScoreManager`, `PlaybackTimeline`, renderers and HUD are used,
and the desktop camera is still exactly `(0, 7, 9) → (0, 0, -10)`, fov 52.

Scope: slide input, its tests, its documentation. **Not** in scope and untouched: MP3 upload, audio
analysis, chart editor, backend, YouTube.

---

## 1. The slide contract

Everything below is asserted by `frontend/tests/slide-input.test.ts` (20 tests) unless it says
"verified live".

| Gesture | Result |
|---|---|
| `pointerdown` on a column | lane press (phase 1.5 behaviour, unchanged) |
| move inside the same lane | **nothing** — no repeated press, no allocation |
| move into a neighbouring column | release of the lane left + press of the lane arrived in |
| move across several columns in one event | **destination lane only** (see §1.1) |
| move back to a lane already visited | a new press (a lane is not "used up") |
| move out of the column band (up, over the HUD) | release; the finger stays tracked |
| move back onto the columns | a new press, without lifting the finger |
| two fingers on one lane | one press in total; the lane stays down until the **last** finger leaves |
| a second finger arriving on a held lane | lights the pad, judges nothing |
| sliding off a held note | ordinary release ⇒ the hold breaks (existing early-release penalty) |
| `pointerup` / `pointercancel` / `lostpointercapture` | settle whatever lane the pointer currently holds, exactly once |
| key **and** finger on one lane | the lane is freed only when both have let go; neither is judged twice |
| pause, blur, tab hide, orientation change, finish | every lane released, no stuck notes |

### 1.1 Why only the destination lane

A single `pointermove` can span several columns (a fast swipe, a stale-coalescing browser, a
120 Hz panel after a hitch). The chosen rule is **where the finger lands, not the path it took**:
a swipe is not a glissando, so intermediate lanes are never judged. This is the documented default
from the phase 1.6 brief, it keeps the work per event constant, and it is what makes a swipe
*deliberate* — a player who wants three lanes plays three lanes. The alternative (walking every
crossed lane) would machine-gun notes and stray presses on every fast movement.

### 1.2 Why the lane comes from the coordinates, not from `event.target`

`pointerdown` captures the pointer on the column it landed on (`setPointerCapture`). From then on
the browser retargets *every* event of that gesture to the captured element, so:

* `event.target` keeps describing where the finger **started**, not where it is;
* `pointerenter` / `pointerleave` never fire for the columns being crossed;
* `pointerover`/`pointerout` are equally useless for the same reason.

The lane is therefore resolved from `clientX`/`clientY` against the surface's cached column
rectangles (`TouchSurface.laneAtPoint`). This is also the only approach that behaves identically
with and without capture support — and the phase 1.5 tests keep covering the no-capture case.

`pointerdown` itself still uses the event target: the browser computes it from the same geometry,
so the two agree, and going through the DOM keeps "a press can only start on a real column"
true by construction.

---

## 2. Geometry

* Columns tile the full usable width (midpoints between projected lane centres, extended to both
  screen edges): **every pixel maps to the nearest lane, and there is no dead strip**.
* Vertically the band runs from below the measured HUD text block to the bottom of the usable
  area, with ±12 px of slack (`VERTICAL_SLACK_PX`) so a thumb wobbling at the top edge does not
  drop a hold. Crossing that band upwards is the "left the surface" transition.
* On a 800×360 phone that means seven columns ~103 px wide (the two outer ones extend to the
  screen edge, ~143 px) and a band from y ≈ 66 to y = 360.
* The rectangles are stored in **client space** (the same space as `clientX`/`clientY`): the layer
  is `inset: 0` inside `#stage`, so the origin is normally (0, 0), and it is re-read once per
  layout in case the surface ever moves.
* A point outside every column resolves to `null` = "off the surface" (release + keep tracking).

---

## 3. Implementation map

| File | Change |
|---|---|
| [TouchSurface.ts](frontend/src/ui/TouchSurface.ts) | new `laneAtPoint(clientX, clientY)`: allocation-free hit test over the cached rectangles; rectangles are now client-space (origin read once per layout) |
| [InputManager.ts](frontend/src/game/InputManager.ts) | `pointermove` handling; `downPointers` (every finger down on the surface) next to `pointerLanes` (the lane each one holds); `movePointerToLane()` (the whole slide rule); `attachPointer()` takes a `PointerSurface` (`{ root, laneAtPoint }`) and also registers window-level `pointermove`/`pointerup`/`pointercancel`/`lostpointercapture` as an idempotent safety net for platforms without capture |
| [GameApp.ts](frontend/src/ui/GameApp.ts) | hands the surface (not just its element) to `attachPointer`; `debugState().touch.pointersOnLanes` |
| [main.ts](frontend/src/main.ts) | version `0.1.6-phase1.6` |

Unchanged by design: `GameEngine`, `JudgmentEngine`, `ScoreManager`, `PlaybackTimeline`,
`AudioEngine`, `LanePressTracker`, `CameraFraming`, `DeviceProfile`, `OrientationGate`, all
renderers, the HUD, the stylesheet, `index.html` and the chart content. **No CSS or DOM change was
needed for sliding** — the pads already light up per lane, and a slide re-uses that highlight.

---

## 4. Performance

* A `pointermove` costs: one `Set` lookup (to reject pointers we are not tracking — every desktop
  mouse move, every finger that never started on a lane, ends here), then at most one comparison
  per lane, then at most two map operations. **No allocation, no DOM query, no layout read.**
* No coalesced-event walking: with destination-only judgement the newest sample *is* the answer, so
  walking `getCoalescedEvents()` could only add work.
* No debouncing, throttling or animation-based smoothing anywhere in the path — a lane change is
  judged in the same task that received the event.
* The only per-resize cost is one `getBoundingClientRect()` on the surface root (7 style writes +
  1 read per layout, not per move).
* 60 Hz and 120 Hz panels are equivalent: the handler is O(1) in the *number of moves*, not in
  time, and there is no per-frame input poll to quantise a press to a frame.

---

## 5. Timing and judgment are still phase 1

A slide emits the same `onLanePress(lane, songTimeMs)` / `onLaneRelease(lane, songTimeMs)` calls as
a tap, timestamped by reading the **audio clock** (`AudioContext.currentTime` via
`PlaybackTimeline`) inside the event task — not at the next animation frame. Notes are judged by
`JudgmentEngine` against those timestamps, so chart offset, global calibration offset, the timing
windows and the hold early-release penalty all behave exactly as documented in
[GameConfig.ts](frontend/src/game/GameConfig.ts). Sliding out of a hold is a normal release: inside
the 100 ms tail grace it completes, earlier it breaks.

Measured on this machine (dev server, Chrome, 800×360 landscape, synthetic pointer events):

* 45 slide presses, **mean press error +10.2 ms, worst 19.3 ms, all inside PERFECT (≤45 ms)**. That
  bias is the *driver's*: it decides to move at the first animation frame at or after the note
  time (~8 ms of frame quantisation at 60 Hz, plus the callback's position in the frame). Press
  timestamps themselves are taken from the audio clock inside the event task, so input adds no
  quantisation of its own — a real finger's press is timestamped when the event arrives.
* The phase 1.5 measurement of the same pipeline (taps driven the same way) was a −0.4 ms mean with
  a 4.7 ms worst case; slides are within the same envelope.

---

## 6. Tests

`npm test` → **189 tests in 13 files** (164 in 12 at phase 1.5), of which **25 are new here**:
`slide-input.test.ts` (20) plus five hit-test cases in `touch-surface.test.ts` (11 → 16).

| Suite | Covers |
|---|---|
| `slide-input.test.ts` (20) | A→S→D without lifting; A→S→A; repeated movement inside one lane; the boundary pixel belongs to the lane that owns it; a multi-lane jump judges only the destination; two fingers sliding independently; a move for a pointer that never touched down; a second finger sliding into an occupied lane (no duplicate press, one release at the end); one finger leaving while another stays; sliding into a lane a key holds and back out; leaving the surface upward and re-entering on another lane; the vertical slack; `pointercancel` mid-slide; `lostpointercapture` settling once; movement while input is disabled; tab hidden mid-slide; audio-clock timestamps on every transition; **and the real `GameEngine` scoring a three-lane slide plus a hold that is slid away from** |
| `touch-surface.test.ts` (16) | (existing) columns, sizing, HUD clearance, pads, rotation, insets, lighting, interactivity — plus (new) lane centres resolve to their own lane, boundary pixels, `null` above the band, the vertical slack, non-finite coordinates, and hit testing after a rotation |
| `touch-input.test.ts` (22) | unchanged phase 1.5 suite: taps, chords, holds, cancel, capture, focus loss, and the engine-driven tap/hold run |

Not covered automatically: the WebGL renderer, `GameApp` end-to-end, and real hardware touch (§8).

---

## 7. Live verification (this machine, Chrome via the dev server)

Phone landscape, 800×360, `?touch=1`, framing `mobile` (fov 20.7°, lanes 103 px, hit line
295/360). All of the following was driven from the page with real `PointerEvent`s:

* **Deterministic slide trace.** `pointerdown` on A → S → D → S → A: the press/release pairs fire in
  order (0↓ 0↑ 1↓ 1↑ 2↓ 2↑ 1↓ 2↑…), `pointerLanes` follows the finger and the lane count never
  exceeds one. A second finger slides the other way independently, both can occupy one lane (one
  press in total), lifting one leaves the other's lane down, and `pointercancel` clears everything.
* **Off-surface.** Moving to y = 10 (over the HUD) releases the lane while `activePointers` stays 1
  and `pointersOnLanes` drops to 0; moving back onto another column presses it without a lift.
* **A whole chart played by sliding.** One finger, never lifted, 207 boundary crossings
  (leave → arrive) over the 60 s demo chart, with a second finger for chord partners and holds:
  **231/231 PERFECT, 0 GOOD/BAD/MISS, max combo 231, 12/12 holds completed, accuracy 100%,
  score 130,359**, and exactly one stray press (the initial touch, before the first note). The
  session reached the results screen normally.
* **Visuals.** With one finger slid from D to K and a second on A, the two pads are lit and the
  other five are dim; notes are never covered (drop shadows/highlights only).
* **Desktop regression** (1280×720, no query): framing `desktop`, camera `(0,7,9) → (0,0,-10)`,
  fov 52, lanes 99 px, touch layer `display: none`, touch surface not interactive, a real `a`
  key press judged exactly once, and synthetic mouse drags across the (hidden) layer press **no**
  lanes.
* Hit testing agrees with the DOM: `laneAtPoint(centre of A)` = 0, `laneAtPoint(centre of L)` = 6,
  and any point in the HUD band = `null`.

---

## 8. Testing slides on an Android phone

```bash
# on the development machine (Node 22+); run from the repository root
npm install
npm run dev --workspace seven-keys -- --host 0.0.0.0 --port 5173
# (vite prints the LAN address, e.g. http://192.168.1.42:5173/ — open that on the phone)
#   http://192.168.1.42:5173/          normal device detection
#   http://192.168.1.42:5173/?touch=1  force the touch layout (debugging)
```

Note: `npm run dev -- --host …` from the root does **not** work — npm parses `--host`/`--port` as
its own flags. Use the `--workspace` form above, or run `npm run dev -- --host 0.0.0.0 --port 5173`
from inside `frontend/`.

Slide checklist (Chrome and Firefox for Android):

1. Put a thumb in lane **A** (leftmost column, under the `A` pad) and hold it.
2. Without lifting, drag right through **S**, **D**, **Space**, **J**, **K**, **L**. Each pad should
   light up as the thumb enters it and go dark as it leaves — one at a time, in order.
3. Drag back left to **A**: it must press again (a lane is never "used up").
4. Sweep fast across all seven lanes in one motion: only the lane the thumb stops on lights (and
   is judged) — the lanes it flew over do not fire. This is the documented behaviour, not a bug.
5. Chords with movement: hold **A** with the left thumb, then slide the right thumb from **L** to
   **K** while it is down. Both lanes stay lit; **A** must not be released when the right thumb
   moves or lifts.
6. Holds: find a long cyan note (they have visible tails), press its lane and *keep the finger
   still* — the hold must run to the end. Then slide that finger off the lane mid-hold: the hold
   ends (broken) and the lane you arrive in is played normally. Sliding a second finger onto the
   hold's lane must **not** extend or duplicate it.
7. Leave and re-enter: slide the finger up over the score area (the lane must release, the pad goes
   dark), then bring it back down into a lane (it must press again) without lifting.
8. Interruptions during a slide: pause (HUD button), press Home, drag the notification shade down,
   or rotate the phone. On return there must be no lane stuck lit and no phantom miss storm; the
   run resumes with a count-in.
9. Remote-debug (`chrome://inspect`) and check `window.SevenKeys.layout()` for the framing numbers,
   and `window.SevenKeys.state().touch` for `activePointers` / `pointersOnLanes`.
10. Feel check: a swipe should feel like it judges exactly where the finger is, with no lag between
    the pad lighting and the note being hit. If a phone consistently measures late on the results
    screen, raise the global offset in the menu (Phase 2 automates this with a calibration wizard).

---

## 9. Limitations and known issues

* **Destination-only judgement** (§1.1): a fast sweep does not play the lanes it crosses.
  `slide-input.test.ts` pins this so it cannot change by accident.
* A press must *start* on a column. A finger that begins on the HUD and slides down onto a lane
  does nothing (the pointer is not tracked until it lands on a column); only a finger already on
  the surface can slide in from outside the band.
* The 12 px vertical slack is a deliberate tolerance, not a physics model: drifting further up than
  that releases the lane. It keeps a wobbling thumb from breaking a hold.
* A finger resting exactly on a column boundary can alternate lanes if it jitters across it, and
  each crossing is judged (and can count as a stray press). Nothing artificial is added to hide
  this; the columns are ~103 px wide on a phone, so it takes a deliberate wobble.
* Lane alignment is exact at the hit line and approximate higher up the screen (the projected road
  is a trapezoid, the columns are rectangles) — inherited from phase 1.5, and alignment at the hit
  line is what a thumb uses.
* There is no slide *trail* effect: the feedback is the pad highlight (plus the existing
  three.js lane flash on the judgment itself).
* Verified with synthetic pointer events in Chrome on this machine. A physical Android slide test
  (§8) remains the manual step.
* Bundle: 610 kB (156 kB gzip), essentially all three.js; still no code splitting.

## 10. Next phase

Phase 2 (local MP3) needs nothing from this work: decoded audio still feeds the same clock, engine
and framing. The pieces worth extending there are the calibration wizard (touch latency differs
from a keyboard), a per-device note-speed default, and — if slides get their own note type — a
`swipe` chart token in the pattern language plus the judgement rule that goes with it.
