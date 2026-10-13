# Development Guide

## Repository structure

```text
.
|-- frontend/
|   |-- index.html              application document
|   |-- src/                    TypeScript application code
|   |   |-- analysis/           DSP and worker analysis
|   |   |-- audio/              Web Audio playback and demo synthesis
|   |   |-- chart/              chart model, generation, and validation
|   |   |-- content/            built-in demo composition data
|   |   |-- game/               gameplay, judgment, scoring, and input state
|   |   |-- import/             browser audio import workflow
|   |   |-- renderer/           Three.js rendering and framing
|   |   |-- storage/            IndexedDB and localStorage adapters
|   |   `-- ui/                 application UI and touch/orientation behavior
|   |-- tests/                  Vitest unit and DOM tests
|   |-- tsconfig.json
|   |-- vite.config.ts
|   `-- vitest.config.ts
|-- test-assets/                reproducible synthetic audio fixtures
|-- docs/                       maintained project documentation
|-- PHASE*_NOTES.md             preserved milestone design/verification notes
|-- package.json                npm workspace entry point
`-- package-lock.json           reproducible dependency lock
```

`frontend/dist/`, all `node_modules/` directories, `.freebuff/`, reports, local environment files, and personal/imported audio are local artifacts and are not source files.

## Local workflow

Install exactly the locked dependency graph:

```bash
npm ci
```

Start the development server:

```bash
npm run dev
```

Vite listens on `127.0.0.1:5173` by default. To test another device on the LAN, explicitly pass `--host 0.0.0.0`; do not expose the development server to the public internet.

The application exposes `window.SevenKeys` in the browser console for diagnostics and local QA. `window.SevenKeys.state()`, `.layout()`, and `.diagnostics()` are read-oriented helpers; `.start()`, `.pause()`, `.resume()`, `.restart()`, `.seek(ms)`, and `.openImport()` assist manual testing.

## Tests and validation

Run the complete automated suite once:

```bash
npm test
```

During development, use:

```bash
npm run test:watch
```

Type-check all included source, tests, and Vite/Vitest configuration:

```bash
npm run typecheck
```

Validate the deployable bundle:

```bash
npm run build
npm run preview
```

The build writes only to `frontend/dist/`. Review its contents before deployment. The preview command is a local verifier, not a production server.

The fixture-analysis suite reads WAV files under `test-assets/`. Those files are synthetic and reproducible. Regenerate them only when intentionally updating analysis ground truth:

```bash
python3 test-assets/make_fixtures.py
```

That optional step requires FFmpeg with `libmp3lame`. Regeneration may change encoded MP3 bytes across FFmpeg versions; do not regenerate during an unrelated change.

## Coding conventions

- Keep strict TypeScript checks passing and prefer explicit domain types over unchecked object shapes.
- Preserve layer boundaries: analysis is pure DSP; audio owns time; gameplay owns judgments; rendering presents state; storage validates persisted input.
- Derive judgments from the audio timeline, never `Date`, wall-clock timers, or render-frame counts.
- Keep analysis and chart generation deterministic for identical samples, settings, seed, and algorithm version.
- Treat files, IndexedDB records, chart JSON, MIME labels, and URLs as untrusted input.
- Add or update focused tests for behavior changes, including edge cases and pause/seek timing where applicable.
- Keep phase notes as historical milestone records. Put current operational guidance in `README.md` and `docs/`.
- Do not commit generated builds, dependency directories, logs, environment secrets, imported songs, or ad hoc analysis output.

## Troubleshooting

### Audio does not start

Browsers commonly suspend `AudioContext` until a user interaction. Use the on-screen start/import action rather than invoking playback automatically. Check that the tab is audible and that the OS has not interrupted or backgrounded mobile audio.

### MP3 decoding fails

Confirm the file is a valid supported audio stream, not merely renamed with an `.mp3` suffix. Codec support comes from the browser. Try a current desktop Chromium, Firefox, or Safari release and inspect the import error shown in the UI.

### Songs are not retained

The browser may deny IndexedDB in a private session, embedded webview, restricted profile, or quota-constrained device. The UI falls back to in-memory storage, which disappears on reload. Inspect site storage permissions and available quota.

### Mobile input or layout is wrong

Use landscape orientation. Add `?touch=1` to force touch layout and inspect `window.SevenKeys.layout()` in remote developer tools. Ensure browser zoom is at its default and test `pointercancel` paths such as calls and OS gestures.

### Tests cannot find fixtures

Run tests from the repository root and ensure the allow-listed WAV fixtures remain in `test-assets/`. `npm test` uses the root workspace script and resolves the expected relative paths.

### A clean install or build differs

Use the Node version required by `package.json` and `npm ci` with the committed lockfile. Remove local build output through normal file management if necessary, but do not edit generated bundles to fix source problems.
