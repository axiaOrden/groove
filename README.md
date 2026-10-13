# Groove

Groove is a browser-based rhythm game inspired by classic falling-note games. It combines a Three.js note highway with Web Audio timing, keyboard and mobile multi-touch input, local audio import, in-browser analysis, and deterministic automatic chart generation at three difficulties.

The current milestone is a local-first prototype. It has no backend, accounts, public chart library, or server-side audio processing. Imported music stays in the player's browser unless the player deliberately moves it elsewhere.

## Current features

- Three playable difficulties generated from **one** analysis of the imported song:
  **Easy — 4 keys** (`A S K L`), **Normal — 5 keys** (`A S SPACE K L`), **Hard — 7 keys** (`A S D SPACE J K L`).
- Tap, chord, and hold notes at every lane count, with difficulty-specific note density, spacing, chord and hold budgets. Hard is the original seven-key chart, reproduced note for note.
- Audio-clock-based judgments, score, accuracy, combo, pause, restart, calibration, speed, and chart offset.
- Weighted scoring: Easy ×1.0, Normal ×1.5, Hard ×2.0, with accuracy normalised independently of the multiplier.
- A reachable maximum score: the HUD and results show the score of a flawless run, so a perfect run reads 100.00 %.
- High scores stored separately per song and difficulty, versioned and recorded with the weight they were earned at.
- A three-colour lane language (colour 1 / colour 2 / orange for Space) with two selectable themes, saved on the device.
- Keyboard play with simultaneous key support.
- Landscape mobile layout with multi-touch, lane-to-lane sliding, orientation guidance, and fullscreen controls at all three lane counts.
- A synthesized, original built-in demo track and chart (the hand-authored seven-key chart, presented as Hard).
- Local audio selection, decoding, analysis in a Web Worker, three-chart generation, validation, and diagnostics.
- Deterministic onset-, beat-, section-, and role-aware chart generation.
- Local song, chart, analysis metadata, high scores, and optional audio persistence in IndexedDB.
- Switching difficulty during play without re-analysing or re-decoding the audio.
- Small player preferences in `localStorage`.
- Automated tests for timing, judgment, scoring, layout, input, import, analysis, generation, difficulty charts, and persistence.

Earlier seven-key charts are treated as **Hard** when migrating saved data; their other difficulties can be regenerated from the stored audio (see [Phase 3 notes](PHASE3_NOTES.md#5-migration-details)).

## Screenshots

Screenshots have not yet been added.

- Desktop gameplay — _placeholder_
- Mobile landscape gameplay — _placeholder_
- Import and analysis diagnostics — _placeholder_

## Technology

- TypeScript 5
- Vite 8
- Three.js
- Web Audio API and OfflineAudioContext
- Web Workers
- IndexedDB and localStorage
- Vitest and jsdom
- `wasm-media-encoders` for optional OGG export/transcoding

The application is a static single-page frontend. It currently requires no runtime backend or database server.

## Requirements

- Node.js 22.12 or newer
- npm (the repository includes `package-lock.json`)
- A modern browser with Web Audio, WebGL, ES modules, Web Workers, and IndexedDB
- Optional: Python 3 and FFmpeg only when regenerating the synthetic audio fixtures

## Install and run

From the repository root:

```bash
npm ci
npm run dev
```

Vite serves the app at `http://127.0.0.1:5173` by default. For a phone on the same network:

```bash
npm run dev --workspace seven-keys -- --host 0.0.0.0 --port 5173
```

Open `http://<computer-lan-ip>:5173/` on the phone. Add `?touch=1` to force the touch layout for debugging.

## Commands

All commands below run from the repository root and are defined in the root workspace package.

| Command | Purpose |
|---|---|
| `npm run dev` | Start the Vite development server |
| `npm test` | Run the Vitest suite once |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run typecheck` | Type-check source, configuration, and tests without emitting files |
| `npm run build` | Type-check and create the production bundle in `frontend/dist/` |
| `npm run preview` | Preview an existing production build locally |

For a reproducible clean install use `npm ci`; use `npm install` when intentionally changing dependencies.

## Controls

| Difficulty | Lanes | Keys | Score weight |
|---|---|---|---|
| Easy | 4 | A S K L | ×1.0 |
| Normal | 5 | A S Space K L | ×1.5 |
| Hard | 7 | A S D Space J K L | ×2.0 |

The active mapping follows the chart: Space is lane 2 on Normal and lane 3 on Hard, and it is not a lane at all on Easy (pressing it there does nothing, and it never scrolls the page).

Lane colours follow the same table. Every lane is drawn in one of **three** colours — colour 1, colour 2, and orange for Space — with an exact pattern per difficulty (`1 2 1 O 1 2 1` on Hard, `1 2 O 2 1` on Normal, `1 2 1 2` on Easy), applied to the falling notes, hold heads and trails, receptors, lane strips, key strip and touch pads. Two themes are offered in the ready panel: **White · Blue · Orange** (default) and **Green · Red · Orange**; the choice is stored in `localStorage`.

Press and hold a key through a hold note's tail. Keyboard auto-repeat is ignored, and simultaneous keys form chords. Pause, restart, and fullscreen controls are available in the HUD.

On a landscape phone or tablet, touch the column corresponding to a lane. Multiple fingers support chords; keep a finger down for a hold. Dragging a held finger into another lane releases the old lane and presses the new one. A fast sweep judges only the lane where the pointer event lands, rather than every crossed lane. Moving above the playable area or receiving `pointercancel` releases the lane. Portrait mode displays a rotate-device overlay.

## Import and chart generation

1. Open the import panel and choose an audio file from the local device.
2. The browser validates and decodes the file into an AudioBuffer.
3. A Web Worker analyzes spectral flux, onsets, tempo candidates, beat alignment, energy, and section confidence. Browsers without module-worker support fall back to inline analysis.
4. The deterministic generator runs **once per difficulty** from that single analysis — its own lane count, lane mapping, density, spacing, chord and hold budgets — and every chart is validated on its own. Hard is generated from the import seed itself, so its seven-key chart is the same one earlier builds produced; Easy and Normal hash the seed with their own name.
5. The panel shows the analysis, then a difficulty card per chart with its lane count, estimated notes, notes per second, score weight, and maximum theoretical score. Pick one to play it; the others stay available with the song.
6. Optionally save the song locally. Depending on the selected storage option, the original file or an OGG transcode may be stored alongside the charts and metadata.

The three charts are not the same chart with lanes hidden: with the same event timeline, Easy selects fewer events and maps its accents onto S/K (a four-lane layout has no centre key), while Hard keeps the full seven-key chart — the same notes, timings and lanes as the seven-key chart before this milestone — at the highest density. No difficulty ever places more than the original two-note chord. Charts are deterministic for the same file, seed, and generator version, and every generated note is tied to a detected onset or a beat-grid slot the analysis supports — no notes are added just to raise difficulty.

No upload occurs and the application does not contact a music service. Analysis quality is heuristic: tempo ambiguity, quiet passages, unusual meters, and heavily compressed recordings can produce imperfect charts.

## Browser storage and privacy

IndexedDB stores imported song metadata, generated notes, compact analysis diagnostics, and—when the player chooses to retain it—the encoded audio blob. Data is isolated by browser profile and site origin; it is not shared between users, browsers, devices, domains, or private and normal browsing modes. Clearing site data removes it. Storage quotas and eviction policies are browser-controlled.

Small preferences are stored in `localStorage`. If IndexedDB cannot be opened, Groove falls back to memory storage and imported songs last only for the current page session.

Treat imported files as untrusted and only use audio you are permitted to use. Production hosting should use HTTPS; browser media policies may require a user gesture before audio starts, and mobile browsers can suspend audio when backgrounded or interrupted.

## Known limitations

- The maximum score shown is the score of a flawless run of that chart at its difficulty weight (see [Phase 3.1 notes](PHASE3_1_NOTES.md#5-maximum-score-correction)). It is reachable, but it is not "2× on every note": the combo multiplier ramps up from ×1.0, so a long chart has a proportionally higher maximum than a short one with the same notes per second.
- Songs imported before this milestone have a Hard chart only until their other difficulties are regenerated from the stored audio (or the file is imported again).
- Automatic analysis and chart generation are heuristic and may require future editing tools. The analysis finds onsets, tempo, and energy — it is not instrument transcription. A difficult tempo estimate or a quiet passage affects all three difficulties equally.
- There is no chart editor, export UI, public library, account system, multiplayer, or backend.
- Imported data is local to one browser origin and has no synchronization or backup.
- Mobile play requires landscape space; embedded webviews and private modes may limit storage or audio behavior.
- WebGL/Web Audio performance, touch latency, storage quotas, and OGG encoding support vary by browser and device.
- Automated tests cover pure logic and DOM behavior, but there is no committed cross-browser end-to-end suite.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [Roadmap](docs/ROADMAP.md)
- [Phase 1 notes](PHASE1_NOTES.md)
- [Phase 1.5 notes](PHASE1_5_NOTES.md)
- [Phase 1.6 notes](PHASE1_6_NOTES.md)
- [Phase 2.1 notes](PHASE2_1_NOTES.md)
- [Phase 3 notes](PHASE3_NOTES.md)

## Roadmap

Difficulty modes are implemented: one analysis produces Easy, Normal, and Hard charts that are saved with the song and switchable without re-analysis, with weighted scoring and per-difficulty high scores. Later work may include assisted chart editing, per-difficulty regeneration and export/import controls, accessibility and performance polish, and—only after separate design and security work—a public chart service. See [docs/ROADMAP.md](docs/ROADMAP.md) for completed and planned scope.

## License

No software license has been selected or granted. Until a license file is added, the repository is source-available for inspection but normal copyright restrictions apply; do not assume permission to copy, modify, redistribute, or deploy it. The synthetic test fixtures are generated by this repository, while user-imported and third-party audio remain subject to their own rights.
