# Groove

Groove is a browser-based seven-key rhythm game inspired by classic falling-note games. It combines a Three.js note highway with Web Audio timing, keyboard and mobile multi-touch input, local MP3 import, in-browser audio analysis, and deterministic automatic chart generation.

The current milestone is a local-first prototype. It has no backend, accounts, public chart library, or server-side audio processing. Imported music stays in the player's browser unless the player deliberately moves it elsewhere.

## Current features

- Seven-lane gameplay with tap, chord, and hold notes.
- Audio-clock-based judgments, score, accuracy, combo, pause, restart, calibration, speed, and chart offset.
- Keyboard play with simultaneous key support.
- Landscape mobile layout with multi-touch, lane-to-lane sliding, orientation guidance, and fullscreen controls.
- A synthesized, original built-in demo track and chart.
- Local MP3 selection, decoding, analysis in a Web Worker, Normal chart generation, validation, and diagnostics.
- Deterministic onset-, beat-, section-, and role-aware chart generation.
- Local song, chart, analysis metadata, and optional audio persistence in IndexedDB.
- Small player preferences in `localStorage`.
- Automated tests for timing, judgment, scoring, layout, input, import, analysis, generation, and persistence.

Easy (4 keys), Normal (5 keys), and Hard (7 keys) modes are not implemented yet. The current generated chart is a seven-lane Normal chart.

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

| Lane | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|
| Key | A | S | D | Space | J | K | L |

Press and hold a key through a hold note's tail. Keyboard auto-repeat is ignored, and simultaneous keys form chords. Pause, restart, and fullscreen controls are available in the HUD.

On a landscape phone or tablet, touch the column corresponding to a lane. Multiple fingers support chords; keep a finger down for a hold. Dragging a held finger into another lane releases the old lane and presses the new one. A fast sweep judges only the lane where the pointer event lands, rather than every crossed lane. Moving above the playable area or receiving `pointercancel` releases the lane. Portrait mode displays a rotate-device overlay.

## Import and chart generation

1. Open the import panel and choose an MP3 from the local device.
2. The browser validates and decodes the file into an AudioBuffer.
3. A Web Worker analyzes spectral flux, onsets, tempo candidates, beat alignment, energy, and section confidence. Browsers without module-worker support fall back to inline analysis.
4. The deterministic generator selects musically supported events, assigns seven-lane roles, builds a Normal chart, and validates it.
5. Review the diagnostics, play the chart, and optionally save it locally. Depending on the selected storage option, the original MP3 or an OGG transcode may be stored alongside chart metadata.

No upload occurs and the application does not contact a music service. Analysis quality is heuristic: tempo ambiguity, quiet passages, unusual meters, and heavily compressed recordings can produce imperfect charts.

## Browser storage and privacy

IndexedDB stores imported song metadata, generated notes, compact analysis diagnostics, and—when the player chooses to retain it—the encoded audio blob. Data is isolated by browser profile and site origin; it is not shared between users, browsers, devices, domains, or private and normal browsing modes. Clearing site data removes it. Storage quotas and eviction policies are browser-controlled.

Small preferences are stored in `localStorage`. If IndexedDB cannot be opened, Groove falls back to memory storage and imported songs last only for the current page session.

Treat imported files as untrusted and only use audio you are permitted to use. Production hosting should use HTTPS; browser media policies may require a user gesture before audio starts, and mobile browsers can suspend audio when backgrounded or interrupted.

## Known limitations

- Only the current seven-key mode and one generated Normal difficulty are available.
- Automatic analysis and chart generation are heuristic and may require future editing tools.
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

## Roadmap

The next intended milestone introduces Easy (4 keys), Normal (5 keys), and Hard (7 keys) modes without changing the proven timing foundation. Later work may include assisted chart editing, export/import, accessibility and performance polish, and—only after separate design and security work—a public chart service. See [docs/ROADMAP.md](docs/ROADMAP.md) for completed and planned scope.

## License

No software license has been selected or granted. Until a license file is added, the repository is source-available for inspection but normal copyright restrictions apply; do not assume permission to copy, modify, redistribute, or deploy it. The synthetic test fixtures are generated by this repository, while user-imported and third-party audio remain subject to their own rights.
