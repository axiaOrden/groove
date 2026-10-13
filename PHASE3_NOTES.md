# Phase 3 — Three difficulties from one analysis, and weighted scoring

Phase 2.1 ended with one good seven-lane chart per imported song. Phase 3 adds the other two
difficulties the roadmap promised: **Easy (4 keys), Normal (5 keys), Hard (7 keys)**, all generated
from a *single* analysis of the audio, kept with the song, switchable without re-analysing anything,
and scored with a difficulty multiplier that leaves accuracy alone.

The seven-key game is untouched: same keys, same highway, same judgment windows, same default
Normal behaviour is now called Hard (see §5). Two-difficulty-subset claims are not made anywhere:
every number below is either a unit-test result or a measurement from a real browser run, and the
file it came from is named.

---

## 1. Implementation summary

| Concern | Where it lives now |
|---|---|
| What a difficulty *is* (lanes, keys, weight, generation budgets) | `chart/Difficulty.ts` |
| Which lane each role may use, per lane count | `chart/LaneProfile.ts` |
| The scoring arithmetic (judgments, weights, maxima, grades) | `chart/ScoreModel.ts` |
| One analysis → three charts, independent and deterministic | `chart/DifficultySet.ts` |
| Lane-count-agnostic event→chart generation | `chart/ChartGenerator.ts` (2.0.0) |
| High-score persistence, versioned per song + difficulty | `storage/ScoreStore.ts` |
| Charts-per-song record (v2) and the v1 migration | `storage/SongRecord.ts` |
| Difficulty selector and per-difficulty play buttons | `ui/ImportPanel.ts` |
| Difficulty switcher in the pause menu | `ui/GameApp.ts` |
| Difficulty, weight and maximum on the results screen | `ui/ResultsScreen.ts` |
| Difficulty/weight/maximum in the HUD | `ui/Hud.ts` |

The pipeline is unchanged in shape, and reuses every stage Phase 2 built:

```
file → validate → decode → analyse once (worker) → generate 3 charts → validate each → save
```

* The analysis is **still run once per import**. `chart/DifficultySet.ts` takes the single
  `AnalysisResult`/`AnalysisSummary` and runs the real generator three times, once per difficulty,
  each with its own lane count, lane profile and budgets.
* **Nothing is copied from Hard and masked.** Easy uses a different lane profile (four lanes have no
  centre key at all) and different density/chord/hold budgets, so it selects a different set of
  events. Measured on the 128 BPM fixture (see §7), Hard keeps 52 notes while Easy keeps 28.
* Analysis diagnostics are preserved untouched: BPM, beat length, first beat, confidence, beat-align
  ratio and chance baseline, grid coverage/excess, tempo candidates, bar phase, per-section pulse
  quality, onset count, warning list. They are stored with the song (record v2) and shown in the same
  diagnostics panel; **nothing here is instrument transcription** — the generator still maps spectral
  and onset heuristics onto keys, and no claim of stem separation is made anywhere.

---

## 2. Difficulty generation strategy

### 2.1 One table of facts (`chart/Difficulty.ts`)

```
difficulty   lanes  keys                 weight  target/s  max/s  note gap  lane gap  chords  holds  SPACE
easy          4     A S K L               1.0      1.6       6      150 ms    200 ms   ≤2 (6%)  ≤10%   0%
normal        5     A S SPACE K L         1.5      2.4       7      110 ms    170 ms   ≤3 (10%) ≤13%   ≤34%
hard          7     A S D SPACE J K L     2.0      3.2       9       90 ms    150 ms   ≤4 (12%) ≤15%   ≤34%
```

Easy's numbers are deliberately conservative: a 150 ms note gap keeps the lane walk a step-at-a-time
pattern instead of a jump across the keyboard, and the chord budget is 6 % of the chart in *chord
notes* (so two-note accents stay occasional). Hard's row is Phase 2.1's generator defaults, so the
seven-key chart a player already knows is preserved; only the label (`hard`) and the maximum chord
size (4 instead of 2) are new.

`maxChordRatio` is spent in **chord notes, not chord events**: one three-note chord adds three notes
to the chart, so a budget counted in events would let a bigger chord silently raise the realised
chord share.

### 2.2 Lane profiles per lane count (`chart/LaneProfile.ts`)

Roles (downbeat / kick / low / high / supporting / melodic / syncopation / beat) keep their Phase 2.1
meaning, but the lanes they may use come from a per-count table rather than from seven-lane constants:

* 7 lanes — unchanged: centre = lane 3 (SPACE), left hand 0-2, right hand 4-6.
* 5 lanes — centre = lane 2 (SPACE), left 0-1, right 3-4.
* 4 lanes — **no centre lane**: `centerLane = null`, and the accent pair S/K (1/2) takes the beat
  roles instead. This is the structural reason Easy cannot be "Hard with three lanes hidden": the
  key Hard uses for the beat does not exist on Easy.

Other lane counts (a hand-edited chart, say) get a symmetric derived profile so the generator is
total, without pretending it is tuned.

### 2.3 Selection, spacing and chords

The stages are the Phase 2.1 stages — build candidates from slots + detected onsets, select against
the intensity-scaled density budget, drop anything in a low-energy section, then assign lanes:

* the density budget is `intensity × targetNotesPerSecond`, capped by the difficulty's `maxNotesPerSecond`;
* each role walks its own preference ladder, falls back to the onset's spectral band, then to every
  lane — a note is only dropped when no lane clears its minimum gap;
* the centre lane is rationed (accents only, one per beat, under the `maxSpaceRatio` budget) and is
  simply never offered on a four-lane chart;
* chords are built by `chooseChordMembers`: members **alternate hands**, prefer the mirrored lane
  inside the chosen hand, and each must clear the per-lane minimum gap. Two-note chords therefore
  come out exactly as they did in Phase 2.1 (one seeded draw), and a four-note accent ends up two
  notes per hand.

**No note is invented to raise difficulty.** Every note starts as a candidate derived from the
analysis (a detected onset, or a beat-grid slot that the beat evidence supports), which is asserted
in `tests/difficulty-charts.test.ts` (`candidatesConsidered ≥ noteCount`).

### 2.4 Determinism

A chart set is a pure function of `(analysis, seed, generator version)`. Each difficulty draws from
its own seed, an FNV-1a hash of `"<seed>:<difficulty>"`, so the three charts are independent but
reproducible, and changing the seed of one does not reshuffle the others. Generator version is
`2.0.0` (bumped because the output of a given seed can differ from Phase 2.1's), the set version is
`3.0.0`, and both are recorded in the chart and in the song record.

---

## 3. Scoring formula

`chart/ScoreModel.ts` is the single definition, shared by the live `ScoreManager`, the chart layer
(which states a chart's theoretical maximum before it is ever played) and the tests.

```
multiplier   = 1 + 0.01 × min(combo, 100)                    → 1.00× … 2.00×
units        = 1 for a tap, 2 for a hold (head + tail)
note score   = round(basePoints[judgment] × units × multiplier × difficultyWeight)
basePoints   = PERFECT 300, GOOD 200, BAD 100, MISS 0
accuracy     = (300·PERFECT + 200·GOOD + 100·BAD) / (300 × judgedNotes)
maxScore     = round(totalUnits × 300 × 2.00 × difficultyWeight)
```

Three properties the brief asked for, and where each is pinned down:

* **Accuracy is independent of the multiplier.** `difficultyWeight` multiplies *points only*;
  judgments, windows, combo and the accuracy denominator are untouched.
  `tests/difficulty-scoring.test.ts` plays the identical judgment sequence at 1.0/1.5/2.0 and asserts
  identical accuracy **and** identical grade.
* **Score is deterministic.** Same inputs, same score: the score manager has no randomness, and
  `Engine.getResults()` is checked for score stability across pause/resume in the same test file.
* **Maximum theoretical score depends on two things.** Note *density* enters through `totalUnits`
  (more notes ⇒ higher maximum, and a hold counts twice), and the difficulty *weight* enters
  linearly. That is why the numbers on the difficulty cards are not simply "notes × 300 × 2":
  on the fixture below, 28 notes ⇒ 17,400 at ×1.0 while 52 notes ⇒ 62,400 at ×2.0.

`maxScore` is deliberately **theoretical**: it assumes the capped 2× multiplier from the first note,
while a real run ramps up from 1× over the first hundred notes. A perfect run of `n` taps therefore
scores `(n + 0.01 · n(n+1)/2) / (2n)` of it — `0.5 + 0.0025·(n+1)` — i.e. ~57 % at 28 notes, ~63 % at
52 notes, approaching 75 % for long charts. That share is a property of the chart's *length*, not of
its difficulty, which is exactly what makes a maximum a fair way to compare charts of different
sizes; `tests/difficulty-scoring.test.ts` asserts the share against that closed form, and asserts it
rises with density.

Weights live in one table (`DIFFICULTY_WEIGHTS`) and are *copied into each score record* rather than
re-derived on read, so retuning the table later cannot rescale history.

---

## 4. Storage changes

### 4.1 Song records: version 2

`SongRecord` now stores `charts: { easy?, normal?, hard? }` instead of a single `chart`. Each entry
keeps everything the picker and the game need without the audio:

```
schemaVersion, difficulty, laneCount, keyLabels, generator{name,version,seed},
noteCount, notes[], stats{...}, maxScore, noteDensity,
validation{ok, errors[], warnings[]}
```

`storage/SongLibrary.ts` bumps the IndexedDB database to **version 2**. The upgrade creates two new
object stores (`scores`, `score-attempts`) in place; every existing song, chart and audio blob is
untouched by the bump, so no migration pass is needed for stored music.

### 4.2 High scores: separate per song *and* difficulty

`storage/ScoreStore.ts` keeps the **best** run per `(songId, difficulty)` under the key
`"<songId>::<difficulty>"`, plus an attempt count. A score entry records `scoreVersion`
(currently 1), the `difficultyWeight` it was earned with, the `generatorVersion` of the chart, score,
maximum, accuracy, grade, max combo, note count and timestamp. Deleting a song deletes its scores
(they would otherwise be unreachable), and the results screen compares a run only with the best of the
*same* difficulty, because scores earned at different weights are not on the same scale.

---

## 5. Migration details

* **Legacy record v1 → v2 (`charts.hard`).** A version-1 record stored a single seven-key chart. That
  chart *is* Hard — same lane count, same key map, and the v1 validator's lane range was 0..6 — so it
  is migrated in place with no conversion, no re-analysis and no change in play. `decodeSongRecord`
  reads `chart` when `charts` is absent and puts it under `hard`.
* **The other difficulties are absent, not faked.** A v1 record carries a note list, not the event
  timeline, so Easy and Normal cannot be generated from it without inventing notes that correspond to
  nothing in the music. Instead the picker shows them as unavailable with an explicit
  *regenerate* action (`ui/ImportPanel.ts`), which re-analyses the **stored audio bytes** once,
  generates the whole set and saves the upgraded record. If the player chose not to keep the audio,
  regeneration is not offered and the panel says the file must be imported again.
* **Old scores.** There is no pre-Phase-3 score store — high scores are new in this milestone, so no
  saved record can be mis-weighted. For robustness, an entry without a weight (a hand-edited or
  truncated record) is read as weight **1.0**, i.e. what it must have been played at, and an entry
  claiming a newer `scoreVersion` is refused with a readable message rather than guessed at.
* **The hand-authored demo chart** is now labelled `hard` (it is the seven-key layout). It has no
  analysis behind it, so it is presented as a single-difficulty set: the switcher is hidden, and the
  demo scores carry Hard's ×2.0 weight.

---

## 6. UI and controls

* After import the panel shows one card per difficulty — **EASY — 4 Keys**, **NORMAL — 5 Keys**,
  **HARD — 7 Keys** — with the key labels, a one-line intent, and lanes / estimated notes /
  notes per second / score weight / maximum theoretical score, plus the stored best for that
  difficulty.
* Selecting a card loads that chart: the highway is rebuilt for the lane count, the key map is
  installed, the HUD key strip and the touch columns are rebuilt, and the camera is re-solved so four
  lanes get four wide columns rather than four narrow ones inside a seven-lane road. **No empty or
  disabled lanes are rendered** — the road is only ever as wide as the chart.
* Keys obey the tables in §2.1 exactly (`A S K L`, `A S SPACE K L`, `A S D SPACE J K L`). A key that
  is not a lane on the current difficulty (D on Easy, SPACE on Easy) never judges; it is still
  `preventDefault`ed so SPACE cannot scroll the page. Switching difficulty releases everything held,
  so no lane survives the switch stuck down.
* Touch is lane-count aware: the columns are rebuilt for 4, 5 or 7 lanes from the same projection the
  highway uses, and taps, multi-touch chords and lane-to-lane swipes work on all three (asserted in
  `tests/difficulty-input.test.ts`, including a swipe across a four-lane surface).
* While playing, the pause menu gains a difficulty switcher (`4 Keys · ×1.0`, `5 Keys · ×1.5`,
  `7 Keys · ×2.0`, current one marked). Switching swaps the chart from memory and restarts the run —
  **the audio is not decoded again and the analysis is not repeated**.
* Styling is unchanged from Phase 2.1 apart from the new cards/rows. Lane *colours* are now keyed to
  the key rather than the lane index, so S is green and L is violet on every difficulty and Hard is
  pixel-identical to before.

---

## 7. Test results

```
cd frontend
npx tsc --noEmit -p tsconfig.json     # clean
npx vitest run                        # 26 files, 379 tests, all passing (~4.9 s)
npm run build                         # tsc + vite build OK (63 modules, 615 ms)
```

The production build emits the pre-existing "chunks larger than 500 kB" advisory (three.js and the
WASM encoder); it is not a new failure and no code-splitting was added in this milestone.

New suites:

| File | Covers |
|---|---|
| `tests/difficulty-charts.test.ts` (17) | 4/5/7-lane generation and validation, per-difficulty metadata, timing locked to onsets/beat grid, every rendered lane used and no lane outside the count, density ordering, chord-size and hold budgets, playable spacing, "not Hard with lanes hidden", determinism + per-difficulty seeds, subset generation, SPACE-vs-SPC-less lane mapping, maximum-score formula, single-chart / legacy sets |
| `tests/difficulty-input.test.ts` (16) | the three key maps, SPACE as lane 2 (Normal) vs lane 3 (Hard), foreign keys suppressed but not judged, layout switch releasing held lanes, 4/5/7 touch columns with no empty lane, taps, multi-finger chords, swipes on four and five lanes, a real engine judging 4- and 5-lane charts, a lane the chart does not have, pause/resume on a weighted run |
| `tests/difficulty-scoring.test.ts` (18) | weights 1.0/1.5/2.0, weight applied to heads and hold tails, accuracy and grade identical at every weight, maximum = units × 300 × 2 × weight, perfect runs reaching their chart's maximum, per-difficulty high-score separation and best-keeping, weight stored rather than re-derived, version refusal, persistence round trip through the library |

Updated suites: `tests/engine.test.ts` (fixture is now explicitly a Hard chart, so its score
assertions carry ×2.0), `tests/song-library.test.ts` (rewritten for the v2 record and extended with
the v1 migration, absent-difficulty and score-with-the-song cases), `tests/chart.test.ts` (the demo
chart is Hard and states a maximum).

Browser verification (Vite dev server + `test-assets/rx128.mp3`, the synthetic 128 BPM fixture):

* Import: one analysis (311 ms over 2,106 frames) produced all three charts — Easy 4 lanes / 28 notes
  / 1.24 notes·s⁻¹ / ×1.0 / 17,400; Normal 5 / 46 / 2.04 / ×1.5 / 41,400; Hard 7 / 52 / 2.31 / ×2.0 /
  62,400. The saved song shows one play button per difficulty.
* Playing Easy: HUD reads `easy · 4 keys`, maximum 17,400, key strip `A S K L` (four pills), four
  touch columns. Playing Normal: `normal · 5 keys` with the subtitle `×1.5`, maximum 41,400, key strip
  `A S SPACE K L`, five touch columns. Live scoring works on that layout: pressing keys mid-run
  produced 9 PERFECT / 7 GOOD at 85.4 % accuracy, and the finished run was stored as the Normal best
  (zero on Hard/Easy, i.e. the scores are genuinely separate per difficulty).
* The pause menu listed all three difficulties with their weights; switching Easy → Hard produced the
  seven-lane highway and seven touch columns with no re-analysis (the chart came from memory) and the
  run restarted automatically.

---

## 8. Known limitations

* **The maximum is theoretical, not attainable.** It assumes the 2× combo multiplier from note one;
  a real run starts at 1×, so a full PERFECT run lands at `0.5 + 0.0025·(n+1)` of it — 57 % on a
  28-note Easy chart, 63 % on a 52-note Hard chart (§3). The UI labels it "maximum score" and the
  notes state the formula, but a player who reads it as a target will be confused until the display
  is changed (a future UI decision, deliberately out of scope here).
* **Legacy songs have Hard only** until regenerated from their stored audio or re-imported; if the
  audio was not kept, the other two difficulties cannot be produced without the original file.
* **Switching difficulty clears the diagnostics panel**, because the panel's numbers (notes on SPACE,
  role counts, notes/second) are per-chart and showing another chart's numbers would be wrong. The
  analysis itself is not re-run and the panel reopens with the right numbers when the chart is opened
  from the import panel or the library.
* **Easy has no centre key**, so the "SPACE means the beat" convention only exists at 5 and 7 lanes;
  on Easy the accents land on S/K. That is a deliberate mapping choice, not a missing lane.
* **Analysis is still onset/spectral heuristic.** Three difficulties of the same heuristics means
  three charts of the same quality: no instrument transcription, no stem separation, and tempo
  ambiguity or a quiet passage affects all three charts equally.
* **Difficulty weights are a balance decision, not a measurement.** 1.0 / 1.5 / 2.0 is the brief's
  starting point; the code stores each score's weight so retuning later does not rewrite history.
* **No per-difficulty visual tuning** (note speed, hold length rendering, judgement text) and no
  chart editor: editing, export and per-difficulty regeneration controls remain future work.
* **Not covered:** cross-browser end-to-end automation, mobile-device testing of the new lane counts
  on real hardware, and a screenshot set. The browser check above is a single Chromium run.
