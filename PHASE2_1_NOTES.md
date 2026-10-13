# Phase 2.1 — Beat tracking, role-aware lanes, and diagnostics

Phase 2 produced a working MP3 → playable chart proof of concept. Tested on a real song it was
playable but the notes did not consistently correspond to the musical events expected of them, the
reported beat confidence was too low to be actionable, and the diagnostics lived in a floating
window over the gameplay. Phase 2.1 fixes those three things and nothing else: one difficulty
(Normal), no YouTube, no backend, no visual redesign.

Everything below is measured, not claimed. Where a number comes from a unit test or the fixture
suite it says so; where it comes from a browser run it says which file was used.

---

## 1. What was wrong

### 1.1 The confidence number measured the wrong thing

Phase 2 reported

```
beatConfidence = (captured / chance - 1) / 4
```

where `captured` was the share of the **onset-envelope energy** a grid landed on and `chance` was
the share of **frames** a grid of that density covers. Those two quantities are not on the same
scale: onset energy is concentrated into short attacks, so a grid whose phase is audibly correct
still captures only a few percent of the envelope. The ratio therefore saturates near 1 and the
panel reported `0.16` — "no better than chance" — for a grid that was visibly correct on the
timeline. On the user's own test song (Kenshi Yonezu — IRIS OUT, reported after phase 2):
BPM 134.99, 330 beats, 1324 onsets, 474 notes, confidence 0.16, and the warning *"best beat grid
aligns with only 8 % of onset energy"*.

### 1.2 Notes were placed by the grid, not by the music

`buildCandidates` created grid slots at 1, 2 or 4 subdivisions per beat and weighted them by metric
position and loudness. On a track the detector found busy, four slots per beat existed whether or
not the music had anything in them, and they competed with real onsets for the same density budget.
Measured on a synthetic control (a drum track with a kick on every beat and a hat on every
off-beat), phase 2's rule produced **47 grid-only notes out of 79**, against 32 real events.

### 1.3 Lanes were chosen by register alone, and SPACE was accidental

Band-aware placement (bass left, lead right) is right as far as it goes, but the middle lane was
simply "wherever the walk happened to land", so SPACE — the key a player reads as *the beat* — had
no meaning.

---

## 2. The new measurements (`src/analysis/BeatGrid.ts`)

```
alignment = share of the track's onset strength within a beat's tolerance window
chance    = 2 · tolerance / beatMs        (what a randomly phased grid would score)
confidence = (alignment - chance) / (1 - chance)          clamped to 0..1
```

`tolerance = clamp(beatMs / 8, 15 ms, 75 ms)` — an eighth of a beat, so 62.5 ms at 120 BPM, just
outside the PERFECT window (45 ms).

The metric separates phases that the old ratio could not. Measured on the 128 BPM fixture
(`tests/fixture-analysis.test.ts`, a synthetic track with a kick on every beat and a hat on every
off-beat):

| grid phase | alignment | confidence |
|---|---:|---:|
| correct | 0.553 | 0.403 |
| an eighth late | 0.012 | 0.000 |
| a quarter late | 0.119 | 0.000 |
| half a beat late | 0.266 | 0.022 |

A quarter-beat phase error — the failure mode that makes a chart unplayable while looking fine on
a timeline — collapses the metric to chance level, which is exactly what the panel now reports.

Two further measurements come from the same module:

- **Bar phase** (`estimateBarPhase`): which of the four beat positions carries the accents, from the
  onset strength at each position with a bonus for low-frequency onsets (kicks play downbeats in most
  of this repertoire). It returns a `margin`, so an ambiguous bar is visible rather than hidden:
  the fixture comes out `phase 0, margin 0.36`; the real song below comes out `phase 2, margin 0.01`,
  i.e. *the downbeat is not audible in this track* — stated, not guessed.
- **Per-section confidence** (`measureSections`): the same alignment measured in eight-bar windows,
  with `-1` for windows that hold too few onsets to judge (a pad-only intro or a free-time passage
  is *unknown*, not *bad*).

### Half/double-time, and the offbeat rescue

Octave choice still uses the phase-2 ranking (coverage floor, excess against chance, tempo prior),
but two things changed:

- each rejected candidate now reports **its own measured alignment**, so the diagnostics table shows
  *why* the chosen tempo won instead of asserting it. On the real song: chosen 130.54 BPM at 43 %
  alignment, half-time 65.41 at 17 %, 108.17 at 25 %;
- a new **offbeat rescue**: if the onsets align measurably better half a beat later, the grid is
  shifted. A grid locked onto the "and" of every beat has a perfect tempo and a half-beat-wrong
  phase, which is the single most damaging failure for a chart.

### Section thresholds are relative

A fixed "weak pulse" threshold flags *every* section of a moderately-supported track. Measured on
the real song: the whole track scores 0.235, so a fixed 0.25 threshold marked 132 s of 215 s as
weak and discarded the grid everywhere — technically safe, practically a waste of a grid that was
right for most of the song. Sections are now compared with the rest of the track
(`max(0.10, confidence · 0.6)`), which reduced that to 2 sections / 29 s.

---

## 3. The new chart generator (`src/chart/ChartGenerator.ts`)

### 3.1 The grid only claims the beat

- Grid candidates are **one per beat**, never subdivisions. Everything between two beats must be a
  detected onset. (Phase 2: four per beat.)
- A grid candidate's weight is scaled by the grid's measured confidence, so an untrustworthy grid
  contributes almost nothing.
- No grid candidates at all inside a weak-pulse section — the requirement to *not* force the song
  onto an unreliable fixed grid, implemented from a measurement rather than a constant.
- No grid candidates when the local onset rate is already at or above the chart's target density:
  a grid pulse is for sparse passages, not a second layer on top of a busy one.

### 3.2 Roles, and what each lane means

Every candidate carries a role derived from three measurable things — position relative to the beat,
spectral band, strength:

| role | lane(s) | what it is on the track |
|---|---|---|
| `downbeat` | **SPACE** (3) | the accented beat of the bar |
| `kick` | **SPACE** (3) | a loud low/broad attack on a beat |
| `low` | **A** (0) | low percussion away from the accents |
| `high` | **L** (6) | high percussion away from the accents |
| `supporting` | **S** (1) / **K** (5) | on-beat or eighth-note events without a strong low end |
| `melodic` | **D** (2) / **J** (4) | mid/high events off the grid |
| `syncopation` | **D** (2) / **J** (4) | onsets that fall between the beats |
| `beat` | S/K/D/J/A/L | a grid beat with no onset on it (never SPACE) |

SPACE is rationed: only accents (`downbeat`, `kick`), capped at `maxSpaceRatio` (0.34) of the chart,
never twice inside one beat, and never filled by the lane-coverage pass. Each role has a fallback
ladder so a busy passage loses fewer notes to spacing, and the *first two* lanes of a ladder are the
meaning while the rest are a lower-scored fallback — without that gap the walk happily drifts low
percussion into the right hand.

**This is a heuristic, not instrument recognition.** No separation or classifier runs anywhere in
this project. "Kick" means "a strong low-frequency attack on a beat", which is a kick drum in most
of this repertoire and a bass note or low tom in some of it; "melodic" means "a mid/high event away
from the beat", which may be a lead stab, a vocal chop or a snare ghost note. What the mapping does
guarantee is that the *shape* of the music is preserved: accents to the centre key, register
spreading left to right, syncopation to the inner keys.

### 3.3 Reportable statistics

`ChartStats` gained `spaceCount`, `spaceRatio`, `roleCounts`, `gridOnlyNotes` and
`lowConfidenceNotes`, so "why is this chart like this" is answerable from the data rather than by
listening.

---

## 4. Diagnostics that live in the workflow (`src/ui/DiagnosticsPanel.ts`)

The floating window is gone. The report is now part of the import panel:

- **summary** (always visible after an import): BPM, beat length, first beat, **grid alignment with
  its chance baseline**, confidence, bar phase and margin, phase-2 coverage/excess kept for
  side-by-side comparison, counts, durations, SPACE share, grid-only notes, notes in weak-pulse
  sections, tempo candidates;
- **warnings directly under the numbers**, deduplicated (the import pipeline merges analysis and
  chart warnings, so the same message used to appear twice);
- **per-section pulse quality** as a sentence naming the weakest windows;
- **Advanced diagnostics** (`<details>`): the shared timeline, the tempo candidate table with each
  candidate's alignment, the role distribution, why candidates were dropped;
- the timeline is beats (downbeats brighter) / onsets coloured by spectral band / notes with SPACE
  drawn taller, plus low-energy shading, weak-pulse shading, a selectable eight-second window and a
  playhead;
- **preview**: play the selected section with optional beat ticks and note blips, which is the only
  way to check alignment by ear. It uses its own `AudioContext` (`src/audio/SectionPreview.ts`) and
  schedules every click on the audio clock, so it can never disturb a run and never depends on
  `requestAnimationFrame` for timing.

Diagnostics **reopen for saved songs** without re-analysing anything: the record stores the tempo,
the alignment numbers, the bar phase, the section list and the chart. The onset list and the
loudness curve are deliberately *not* stored (see `src/storage/SongRecord.ts`), so the timeline shows
"detected onsets: not stored" and an empty onset row rather than a fabricated one; the audio is
decoded on demand only when the preview is played.

---

## 5. Measured results

### 5.1 Browser run on a real MP3 (non-demo)

File: `test-assets/real-nightlife.mp3` (7.0 MB, 215.2 s), imported through the real UI path in
Chromium, analysis in the Web Worker.

| | value |
|---|---:|
| estimated BPM | 130.54 (beat 459.62 ms, first beat 22.56 ms) |
| detected onsets / beats | 1988 / 469 |
| **grid alignment** | **42.7 %** (chance 25 %) → **confidence 0.235** |
| phase-2 metric on the same run | coverage 10.5 %, excess 1.51 → **0.13** |
| bar phase | 2 of 4, margin 0.01 (ambiguous — reported as such) |
| sections / weak-pulse sections | 15 / 2 (29 s, below the 14 % relative floor) |
| generated notes | 588 · 2.73 notes/s · 5/s peak · duration 215.2 s |
| notes on SPACE | 91 (16 % of the chart) |
| grid-only notes | **0** |
| lane distribution (A S D SPACE J K L) | 81 / 84 / 84 / 91 / 82 / 83 / 83 |
| roles | kick 167, high 148, downbeat 121, supporting 113, syncopation 16, melodic 15, low 8 |
| analysis time | 5.6–6.1 s (20 175 frames, 10.67 ms hop) |

Alignment of the generated chart against the audio, computed in the browser from the same data:

| | notes |
|---|---:|
| within 45 ms of a detected onset | **100 %** (median 0 ms, p90 7 ms) |
| within 45 ms of a grid beat | 62.4 % |
| within 100 ms of a grid beat | 67.2 % |
| more than 120 ms from any beat (genuine off-beat events) | 191 of 588 |
| SPACE notes within 60 ms of a beat | **91 of 91 (100 %)** |

The 37 % of notes that are not on a beat are the off-beat events the detector found; phase 2's rule
would have put notes on grid positions with nothing behind them instead (see 5.2).

### 5.2 Before/after on a controlled input

Same synthetic summary (120 BPM, kick on every beat, hat on every off-beat, generated chart settings
identical, seed 7), phase-2 candidate rule versus phase-2.1:

| | phase 2 | phase 2.1 |
|---|---:|---:|
| notes | 79 | 32 |
| grid-only notes | 47 (59 %) | **0** |
| notes on a detected onset | 32 | **32 (100 %)** |
| notes/s | 4.0 | 1.6 |
| SPACE share | n/a (no meaning) | 0 (the fixture has no accents strong enough) |

### 5.3 Fixtures with a known answer (`tests/fixture-analysis.test.ts`)

| fixture | expected | detected | phase error | alignment / confidence |
|---|---|---|---:|---|
| rx128 | 128 BPM, beat 0 at 0 ms | 128.03 | +10.9 ms | 0.553 / 0.40 |
| rx96 | 96 BPM (not 192) | 95.93 | +20.6 ms | 0.459 / 0.29 |
| dense | 140 BPM, 16th hats + off-beat kicks | 140.05 | +45.6 ms | 0.527 / 0.37 |
| quiet | 128 BPM at −30 dBFS | 127.97 | +7.9 ms | 0.534 / 0.38 |
| silence | nothing to find | no onsets, confidence 0, one low-energy range | — | — |

The `dense` phase error is stated rather than tuned away: that fixture has a hat on every sixteenth
*and* a kick and a snare on every off-beat, so it is deliberately metrically ambiguous, and 45.6 ms
is 0.11 of a beat (inside a sixteenth). It is the hardest case in the suite and the honest answer is
"about a tenth of a beat late".

### 5.4 Browser acceptance walkthrough

1. Import the real MP3 → analysis in the worker, results and diagnostics rendered in the panel.
2. "Play this chart" → 588 notes, song time advanced exactly 4000 ms over 4 s of wall clock, misses
   accumulated as notes passed unattended (43 → 55 over 4 s at 2.7 notes/s), no console errors.
3. Diagnostics rebuilt for the **saved** song in ~0.4 s with no re-analysis, including the timeline
   and the tempo table.
4. Section preview: eight seconds of music with 17 beat ticks and 15 note blips scheduled on the
   audio clock; the playhead advanced and the source stopped at the section end.
5. "Start demo chart" still plays the hand-authored demo (150 BPM, 231 notes) — the phase-2 game path
   is untouched.

**Synchronisation caveat, reported rather than hidden:** the engine's `driftMs` metric (audio clock
versus `performance.now()` since the start anchor) read −1429 ms during that run, because the shared
`AudioContext` idled while the file was decoded and analysed. Song time is derived from the audio
clock and playback is scheduled on it, so the chart stays locked to the music — the miss counts
above track the note times to within one note — but the metric measures wall-clock divergence, not
audio desynchronisation, and a future calibration screen should say so.

---

## 6. Tests

320 tests, 24 files (`npm test`). New in phase 2.1:

- `tests/fixture-analysis.test.ts` (9) — ground truth for the fixtures, the alignment metric's
  phase discrimination, the bar phase, and the "unknown, not bad" section rule;
- `tests/chart-roles.test.ts` (10) — SPACE only on accents that are on a beat and never on every
  beat, low percussion left / high percussion right, syncopation to D/J, no lane repeated back to
  back, a low-confidence track charted from onsets only (and `gridOnlyNotes === 0`), determinism,
  and validation across seeds;
- `tests/helpers/wav.ts` — a reusable fixture reader.

Changed: the analysis version expectation (1.1.0), the loud/quiet dynamics test (it now compares the
two halves of *one* performance — the old version compared two different signals, and because onset
strength is gated relative to each track's own level the "quiet" file produced *more* detected onsets
(120 vs 82), so it was measuring the detector rather than the generator), and the beat-alignment
assertions in `chart-generation.test.ts` (notes are now expected on events first, beats second:
`onsetAlignRatio > 0.8`, `beatAlignRatio > 0.4`).

**Passing tests do not mean the chart is musically right.** The fixtures are synthetic; the musical
claim rests on §5.1, which is a measurement of *alignment*, not of taste, and on listening.

---

## 7. Limitations, and what would improve this most

1. **One global tempo for the whole track.** There is no beat tracker that can follow a tempo change
   or a rubato section; the grid is fitted once and sections can only be *marked* weak. A dynamic
   programming beat tracker (HMM over beat candidates with a tempo-drift model, or the standard DBN
   of Krebs et al.) is the single biggest available improvement, and it would replace both the phase
   fit and the section logic.
2. **Onset detection is a single-band log-flux with adaptive peak picking.** It misses soft attacks
   inside dense mixes and over-reports percussive texture. A mel-band flux with a small trained
   onset classifier, or at least a per-band re-onset check, would raise the input quality for
   everything downstream.
3. **Roles are register-plus-metre heuristics, not instruments.** Real source separation
   (a Demucs-class model via ONNX/WASM, on the analysis side only) would turn `kick`/`melodic` into
   actual drum/bass/vocal assignment and would make SPACE and the outer lanes mean what they claim.
4. **Tempo octave choice is still a ranking, not a decision.** Alignment now makes the rejected
   candidates visible, but the choice itself should be made by comparing grids *and* their
   correlation with the low-band envelope over time.
5. **The generator has no automatic quality metric.** Alignment and density are reported, but
   nothing scores "does this feel like a chart". A cheap objective pair — onset coverage versus
   density, plus a playability term (hand travel between consecutive notes, same-finger repeats) —
   would let generator settings be compared without listening to every song.
6. **Section windows are coarse** (eight bars, ~15 s here), so a four-bar breakdown inside a good
   section is not detected.
7. **Bar phase is unreliable when the accent is not low-frequency** (margin 0.01 on the real song).
   This only affects which accents get SPACE, so it is cosmetic, but it should be reported as
   unreliable — which it now is.
8. **No loudness-based dynamics smoothing:** density follows detected onsets, so a section with many
   quiet events can still read as "busy". The intensity curve from phase 2 is used for the density
   budget but not for selecting between competing onsets.
9. **Stored songs lose the onset list and the loudness curve** by design, so their diagnostics show
   the timeline without the onset row and no low-energy shading. Storing a decimated version (one
   onset per note plus a per-second loudness summary) would close that gap for a few hundred bytes.
10. **The section preview is not the gameplay clock** and is not intended to be: it exists to judge
    alignment by ear. Playing the generated chart remains the only test of the *feel* of the chart.

---

## 8. Reproducing the numbers

```bash
npm install
npm test                 # 320 tests, includes the fixture ground truth
npm run typecheck
npm run build

# the real-song run: start the dev server and import the fixture through the real path
npm run dev              # then, in the console:
#   await window.SevenKeys.importUrl('/@fs/<repo>/test-assets/real-nightlife.mp3')
#   window.SevenKeys.diagnostics()      # the numbers in §5.1
#   window.SevenKeys.state()            # playback, misses, drift
```

`window.SevenKeys.diagnostics()` returns the serialisable report (the decoded audio buffer is
replaced by `hasAudio`); `SevenKeys.state().diagnosticsPreview` reports the section-preview state.
