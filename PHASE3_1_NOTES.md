# Phase 3.1 — Difficulty rebalance, hold accuracy, lane colours, and a reachable maximum

Phase 3 shipped three difficulties generated from one analysis, and they worked: the tests passed,
the charts were deterministic, the scores were separated per difficulty. Playing them told a
different story. This update is the corrective pass, and it takes the phase 3 priority list
literally:

1. **Hard had become harder than the original seven-key game.**
2. **A long note's trail sometimes did not match its note.**
3. **Lane colours were seven unrelated colours.**
4. **The stated maximum score could not be reached.**

Nothing else was added. There is no visual redesign, no new input scheme, no backend, and no change
to the analysis pipeline.

Everything below is measured. Where a number comes from a test it says which one; where it comes from
the browser it says which file was used and what was read.

---

## 1. Root cause of the increased seven-key difficulty

Phase 3 did three things to the seven-key chart, and only the first two changed the notes:

### 1.1 Hard's maximum chord size was raised from two notes to four

`DEFAULT_SETTINGS`-equivalent for a phase 2.x chart allowed **two** simultaneous notes (a chord was
one partner, chosen on the opposite hand). Phase 3 gave each difficulty a `maxChordSize`, set Hard to
**4**, and rewrote the chord logic to place up to four members. Measured on the parity fixture
(20 s of 120 BPM drums, seed 1234):

| | widest chord | notes |
|---|---|---|
| v0.2.1 baseline | **2** | 59 |
| phase 3 with `maxChordSize: 4` | **4** | 61 |

Four simultaneous notes is the single largest difficulty increase available, because it is the one
constraint a player cannot work around by playing faster.

### 1.2 The chord budget was re-expressed in the wrong unit

Phase 2.x counted chord **events**:

```ts
const maxChords = Math.max(1, Math.floor((candidates.length * maxChordRatio) / 2));
```

Phase 3 replaced that with a budget in chord **notes** and tested it as
`state.chordNoteCount < maxChordNotes`. Because a chord adds its *members* to that counter, and a
two-note chord adds one, the counter grew at half the rate the budget expected. Measured on the
fixture while repairing it: **5 chord events instead of 3**.

### 1.3 Hard stopped using the base seed

Phase 3 generated every difficulty from `deriveDifficultySeed(seed, difficulty)`. That is right for
Easy and Normal — they are new charts — but for Hard it silently replaced the seven-key chart a
player already knew with a differently shaped one drawn from a different RNG stream. On the parity
fixture the draws happened not to change the notes; on a track where tie-breaking matters (chords,
equal-weight candidates) they do.

### 1.4 What was *not* the cause

The analysis pipeline is byte-identical to v0.2.1 (`git diff v0.2.1 -- frontend/src/analysis` is
empty), and the candidate builder, density budget, selection, hold detection, lane walk and coverage
pass were not changed in phase 3 (`buildCandidates`, `selectCandidates`, `holdFor`,
`ensureLaneCoverage` differ only in type annotations). Note **timings, lane distribution, grid
subdivisions, hold logic and the density budget therefore never explained the difference** — the
section's conclusions are the three items above.

---

## 2. What changed to restore the original difficulty

- `chart/Difficulty.ts`: Hard's `generation` block is now the phase 2.1 generator's defaults,
  verbatim, including `maxChordSize: 2`. It is documented as the *definition* of Hard.
- `chart/ChartGenerator.ts`: two chord budgets, in the units each is about —
  `maxChords` (events, the phase 2.x rule) and `maxChordNotes` (notes, so a future larger chord size
  cannot also buy a larger chord share). With two-note chords the event budget alone binds, so the
  realised chord share is exactly `maxChordRatio`, as before.
- `chart/DifficultySet.ts`: `seedForDifficulty` — Easy and Normal hash the base seed, **Hard uses the
  base seed unchanged**.
- `GENERATOR_VERSION` `2.1.0` (the output of a given `(analysis, seed)` is back to what `1.0.0`
  produced for seven keys; `2.0.0` had raised the chord size), `CHART_SET_VERSION` `3.1.0`.

### Easy and Normal, rebalanced as adaptations of that baseline

| | lanes | target n/s | max n/s | min note gap | min lane gap | chord ratio | max chord | hold ratio |
|---|---|---|---|---|---|---|---|---|
| Easy | 4 | 1.5 | 5 | 170 ms | 220 ms | 0.05 | 2 | 0.08 |
| Normal | 5 | 2.2 | 7 | 120 ms | 180 ms | 0.09 | 2 | 0.12 |
| Hard | 7 | 3.2 | 9 | 90 ms | 150 ms | 0.12 | 2 | 0.15 |

Neither Easy nor Normal may place a chord wider than the baseline's two notes, and both keep their
notes further apart than Hard does — which is the honest way to simplify a rhythm chart.

---

## 3. Before/after chart metrics

The parity fixture is deterministic and checked in
(`frontend/tests/fixtures/hard-v0.2.1.json`, produced by the **actual v0.2.1 generator** through
`frontend/scripts/emit-baseline-fixture.mts`; see `frontend/tests/helpers/analysis-fixture.ts`).
All rows use the same analysis and seed 1234.

| 20 s fixture, seed 1234 | notes | n/s | chords | widest chord | holds | min gap | lane changes |
|---|---|---|---|---|---|---|---|
| **v0.2.1 (baseline)** | 59 | 2.95 | 3 | 2 | 0 | 248 ms | 55 |
| **phase 3** (`maxChordSize: 4`, derived seed) | 61 | 3.05 | 2 | **4** | 0 | 248 ms | 55 |
| **phase 3.1 (this build)** | 59 | 2.95 | 3 | 2 | 0 | 248 ms | 55 |

The phase 3.1 row is not "close": `tests/difficulty-parity.test.ts` asserts the note list is
**deep-equal** to the v0.2.1 one — same timings (to 1/1000 ms), same lanes, same types, same order —
and that nothing got denser, wider or faster.

The v0.2.1 row also measured the *differences* the brief asks to record, all of which now compare
equal or favourably: note count 59, notes per second 2.95, chord events 3, widest chord 2, holds 0
(there is no sustain in this fixture), minimum distinct-instant gap 248 ms, minimum same-lane gap
and lane transitions 55.

On the real test file used for phase 3 (`test-assets/rx128.mp3`, import seed 1, read from the
difficulty cards in the browser) the three charts now measure:

| rx128.mp3, seed 1 | notes | notes/s | weight | maximum |
|---|---|---|---|---|
| Easy | 28 | 1.24 | ×1.0 | 9,957 |
| Normal | 37 | 1.64 | ×1.5 | 19,822 |
| Hard | 49 | 2.18 | ×2.0 | 36,750 |

Hard is the v0.2.1-shaped chart (fewer notes at the same target density than the phase 3 one, which
had placed the extra chords), and Easy < Normal < Hard holds for note count, density and maximum.

---

## 4. Root cause of the hold-trail inaccuracy, and the fix

Three separate defects, all in how a hold reached the screen:

1. **Two code paths.** A *falling* hold computed `headZ = min(PAST_VISIBLE_Z, zForTimeToHit(timeToHit))`
   and `tailZ = zForTimeToHit(timeToHit + duration)`; a *held* hold computed `tailZ = min(0, …)` and
   `length = |tailZ|`. Two expressions, two clamps, two anchors — the body could shift at the moment
   the head was hit and there was no single place that guaranteed head, tail and body agreed.
2. **No clipping.** A hold longer than the visible road was **stretched past the spawn plane**. At
   2.5× speed (a 720 ms lead) a 3-second hold is `3 / 0.72 × 24 ≈ 100` world units long on a 24-unit
   road — a trail that runs off through the fog instead of ending at the horizon.
3. **The trail vanished while it was being held.** The past-window guard skipped any note more than
   200 ms behind the hit line unless it was a miss — including a hold whose *head* had just crossed
   the line. A player holding a long note watched its trail disappear under them.

The fix is one pure function, `renderer/Layout.ts` → `holdGeometry`:

```
headZ = clamp(anchoredToLine ? 0 : zForTimeToHit(timeMs - songTimeMs), [-ROAD_LENGTH, PAST_VISIBLE_Z])
tailZ = clamp(zForTimeToHit(endTimeMs - songTimeMs),       [-ROAD_LENGTH, PAST_VISIBLE_Z])
body  = |tailZ - headZ| at (headZ + tailZ) / 2
```

Both states call it; the held state passes `anchoredToLine: true` (the head has been consumed, so the
remaining body runs from the hit line). Both endpoints come from the note's own chart timestamps
through the *same* scroll transform every other note uses, both are clipped to the playfield, and the
body is measured between the two clamped endpoints — so it is connected to both caps by construction.
The `-0` that `zForTimeToHit(0, …)` produces is normalised so geometry objects compare equal. The
`NoteRenderer`'s past-window guard now keeps drawing a hold whose tail is still ahead, and a completed,
broken or interrupted hold still draws nothing (its head is consumed, and the effect layer shows the
feedback).

Nothing is masked with a visual offset: no constant was added to a position, and no separate
"rendering offset" exists.

Verified by:

- `tests/hold-geometry.test.ts` — head/tail equal the transform, body length maps back to the note's
  duration in time, the body spans its two caps to 1e-10, nothing is drawn outside
  `[-ROAD_LENGTH, PAST_VISIBLE_Z]` across 6 speeds × 5 durations × 5 clock offsets × both states,
  the held body anchors at the line and collapses as the tail passes, and identical clock values give
  identical geometry (pause/resume).
- `tests/hold-rendering.test.ts` — the same properties read back out of the `InstancedMesh` matrices
  the renderer actually writes: caps at `headZ`/`tailZ`, body scale exactly `|tailZ − headZ|`, body on
  the note's own lane at 4/5/7 lanes, no jump between the last falling frame and the first held frame,
  nothing drawn for completed/broken/interrupted, and a missed hold as a shrinking cap with no trail.
- The browser: on the demo chart at ~23.4 s the renderer reports `noteBodies: 1` and the trail is
  visible crossing the line in its own lane (screenshot in the preview tab).

---

## 5. Maximum-score correction

Phase 3 computed

```
maxScore = round(totalUnits × 300 × 2.0 × difficultyWeight)
```

— every unit at the *capped* multiplier. No play can do that: the multiplier starts at ×1.0 and only
reaches ×2.0 at combo 100, so a perfect run scored 50 % + 0.25·(n+1) % of its own maximum (57 % on a
28-note Easy chart, 63 % on a 52-note Hard one — the numbers reported at the end of phase 3).

The maximum is now a **simulation of the run**, in the same module and with the same arithmetic:

```
maxScore = perfectRunScore(notes, difficultyWeight)
perfectRunScore: walk the notes in `perfectRunOrder`; award 1 unit PERFECT at combo 1, 2, 3, …
                 capped at 100; add `holdWeight − 1` units for a hold at its head's combo.

perfectRunOrder: chart order (time, lane), with one refinement — inside a chord the holds come last.
```

The refinement is what makes the number an upper bound rather than one arbitrary play. Every note in
a chord is judged in the same instant, so the *set* of combo values it consumes is fixed and the sum
of its heads is the same whatever order it is pressed in — but a hold's tail is scored at its head's
multiplier, so giving the hold head the larger combo of its group is strictly better. Measured on a
three-note chart whose first chord is a hold plus a tap (`tests/difficulty-scoring.test.ts`):
`606 + 612 + 612 + 618 = 2448` when the tap goes first (the maximum), `606 + 606 + 612 + 618 = 2442`
when the hold goes first. Both are perfect runs; neither can exceed the maximum.

Two supporting changes make that exactly reachable:

- `awardPoints` is the single scoring formula, shared by `ScoreManager.pointsFor` and
  `perfectRunScore`, so the maximum and the live score cannot drift.
- A hold's **tail** is scored at the multiplier its head was awarded at (`RuntimeNote.headCombo`,
  `ScoreManager.awardHoldTail(…, comboAtHead)`). Previously the tail used whatever the combo happened
  to be when the tail arrived, which made a hold's value depend on when inside its 100 ms release
  window the player let go, and made the perfect-run total depend on the order the notes were judged.

The result: a flawless run played in the scoring order scores *exactly* the stated maximum.
`tests/difficulty-scoring.test.ts`
plays all three difficulties perfectly through the real `GameEngine` and asserts
`results.score === results.maxScore === chart.maxScore` (accuracy 1, grade S), plus that no run can
exceed it, and `tests/hud-score-percent.test.ts` asserts the HUD's readout reaches `100.00%` and is
clamped there.

The HUD and results screen now show the maximum together with the live percentage (`36,750 · 100.00%`),
and the "max score" the difficulty card states is the same number.

**Historical scores are untouched.** Nothing recomputes a stored entry: `ScoreEntry.maxScore` keeps
the value the run recorded, entries keep the weight they were earned with, and a stored best is
compared only within one song and difficulty.

**One bug the browser found.** Starting the built-in demo from a fresh page load showed
`MAX SCORE 0 · 0.00 %`, because the constructor points `chartValue` at the demo chart directly while
`maxScoreValue` was only ever assigned inside `loadSong` — a path the demo's "start" button skips.
The maximum is now resolved through one `maxScoreFor(chart, difficulty)` helper called wherever a
chart is set (constructor and `loadSong`), and the demo run reads `260,718 · 0.00 %`.

---

## 6. Lane palette

Seven colours became three, defined once in `renderer/Layout.ts`:

```ts
LANE_PALETTES = [
  { id: 'ice',    name: 'White · Blue · Orange', primary: 0xf1f5f9, secondary: 0x3b82f6, space: 0xf59e0b },
  { id: 'signal', name: 'Green · Red · Orange',  primary: 0x34d399, secondary: 0xef4444, space: 0xf59e0b },
]
```

The pattern is per **lane index** and per difficulty, exactly as specified — which is why it is not a
per-key table (K is colour 1 on Easy, where it is the fourth lane, and colour 2 on Hard, where it is
the inner right-hand lane):

| | lanes | pattern |
|---|---|---|
| Hard | 7 | `A S D SPACE J K L` → `1 2 1 O 1 2 1` |
| Normal | 5 | `A S SPACE K L` → `1 2 O 2 1` |
| Easy | 4 | `A S K L` → `1 2 1 2` |

`laneColorsFor(laneCount, palette?)` is read by everything that draws a lane: note caps and hold
bodies (`NoteRenderer`), receptors and lane strips (`LaneRenderer`), the HUD key strip (`Hud`) and the
touch pads (`TouchSurface`). There is no second list of colours anywhere, so no surface can assign a
lane an independent colour, and `tests/lane-palette.test.ts` asserts that every lane colour at every
lane count comes from the active palette.

Pressed, held and missed states stay recognisable without relying on colour: a press raises the
receptor's emissive and the lane strip's opacity, a hold keeps a bright body while the head is
consumed, a miss shrinks the cap over the past-visible window and is drawn in the miss colour with a
ring effect, and a hit flashes the lane. Consumed notes leave the highway entirely.

The theme is picked in the ready panel (`#setting-palette`, options built from the catalogue), applied
immediately to every surface, and stored in `localStorage` through `SettingsStore` (validated against
the catalogue, so a renamed theme falls back to the default). Verified in the browser: with the demo
chart loaded the HUD key strip reads `white, blue, white, orange, white, blue, white`, switching to
*Green · Red · Orange* repaints the strip and the touch pads to `green, red, green, orange, green, red,
green`, and the choice survives a full page reload.

---

## 7. Test results

- **Typecheck**: `tsc --noEmit` clean.
- **Unit/integration tests**: `vitest run` — **31 files, 427 tests, all passing** (was 26 files / 379
  tests at the end of phase 3).
- **Production build**: `vite build` OK; only the pre-existing >500 kB chunk advisory.
- New suites: `difficulty-parity` (7), `hold-geometry` (9), `hold-rendering` (12), `lane-palette`
  (14), `hud-score-percent` (4).
- Updated suites (assertions that encoded the two behaviours this milestone fixed): `difficulty-charts`
  (Hard's seed, the maximum formula), `difficulty-scoring` (a perfect run now *equals* the maximum,
  plus the chord-order upper bound), `difficulty-input` (a perfect four-lane run equals its maximum),
  `scoring` (the maximum for four taps is 303+306+309+312, not 2,400).

Browser verification (dev server, `test-assets/rx128.mp3` imported from the file system):

- Import → analysis → three difficulty cards: Easy 28 notes / 1.24 n/s / ×1.0 / 9,957 · Normal 37 /
  1.64 / ×1.5 / 19,822 · Hard 49 / 2.18 / ×2.0 / 36,750; song saved.
- Played Normal: 5 lanes, key strip and touch columns in the Normal pattern, HUD `normal · 5 keys`
  with `19,822 · 0.00%`.
- Paused, switched to Hard: 7 lanes, Hard pattern, `36,750 · 0.00%`, **no re-analysis** (the switch
  reads the charts already generated).
- Demo chart: 7-lane highway in the specified colours (`A S D SPACE J K L` reading
  white · blue · white · orange · white · blue · white on the receptors, the key strip and the touch
  pads), hold trails crossing the line in their own lanes, `noteBodies: 1` while a hold is in flight,
  and `MAX SCORE 260,718 · 0.00 %` in the HUD.
- Console: no errors (only the vite client and the ready banner).

---

## 8. Remaining limitations

- **Hard's parity is per (analysis, seed).** A song imported *before* this build has a phase-3 Hard
  chart stored with it and will keep playing it until the chart is regenerated. Regenerating Hard
  from the stored audio produces the phase 2.1-shaped chart again, but there is still no per-difficulty
  regeneration UI beyond the import panel's "regenerate" offer for *missing* difficulties.
- **The maximum is an upper bound**, reached by a perfect play that hits every head on time, holds
  every hold to its tail, and presses the taps of a chord before its holds. A perfect run that presses
  a chord's hold first scores a little under it (6 points on the example above, i.e. 99.75 % there and
  a fraction of a percent on a real chart) — so the HUD reads just under 100.00 % for that order. No
  play can exceed the maximum, and the display is clamped at 100.00 % as a guard.
- **Chord size is still a knob** (`maxChordSize`). It is 2 everywhere today; the second budget exists
  so a future milestone can widen an accent without also raising the chord share.
- The lane palette is deliberately three colours. Notes are not distinguished by pitch or band, which
  is a deliberate scope limit — a "notes coloured by register" option would be a new feature, not a
  rebalance.
- Hold visuals are clipped at the spawn plane, which means a hold longer than the lead time simply
  appears from the horizon rather than being previewed in full. With the default lead (1.8 s at 1.0×)
  that affects holds longer than ~1.8 s only.
- Nothing in this milestone changed the analysis pipeline, so a tempo mis-estimate or a quiet passage
  still affects all three difficulties equally.
