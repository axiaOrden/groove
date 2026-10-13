# Architecture

## System shape

Groove is currently a static Vite single-page application. `frontend/index.html` provides the document shell, `frontend/src/main.ts` creates `GameApp`, and `GameApp` coordinates the audio, chart, engine, renderer, input, import, storage, and UI layers. There is no runtime server API or server database.

```text
index.html -> main.ts -> GameApp
                         |-- audio/       audio clock and playback
                         |-- analysis/    DSP, tempo/beat analysis, worker boundary
                         |-- chart/       chart types, generation, parsing, validation
                         |-- game/        input state, judgment, score, simulation
                         |-- renderer/    Three.js scene, highway, notes, effects
                         |-- import/      file decoding, import flow, optional OGG export
                         |-- storage/     IndexedDB song library and local preferences
                         `-- ui/          panels, HUD, overlays, orientation and touch
```

## Web Audio timing

`audio/AudioEngine.ts` owns the `AudioContext`, decoded `AudioBuffer`, buffer source, gain, and playback lifecycle. `audio/PlaybackTimeline.ts` maps `AudioContext.currentTime` to song time while accounting for pause, resume, seek, and chart offset. Gameplay reads this audio-derived clock; render frames do not define judgment time. This keeps visual frame-rate variation from changing note timing.

The browser initially suspends audio until a user gesture. The UI creates or resumes the context from an interaction before playback or decoding. `audio/DemoSynth.ts` generates the built-in original track with `OfflineAudioContext`, so no bundled demo recording is required.

## Music import and decoding

`import/MusicImport.ts` validates the selected blob, reads its bytes, and asks a `BaseAudioContext` to decode it. `import/ImportFlow.ts` sequences decoding, analysis, generation, validation, and optional persistence while reporting progress. `import/OggExport.ts` provides optional browser-side OGG transcoding through `wasm-media-encoders`.

The local file is processed in the browser. There is no upload endpoint. Decoding support ultimately depends on the browser's media codecs even when the file has an MP3 name or MIME type.

## Analysis and worker processing

`analysis/AnalysisClient.ts` is the asynchronous boundary. It normally creates the module worker in `analysis/analysis.worker.ts`, sends the decoded channel samples, receives progress, and returns an `AnalysisResult`. If workers are unavailable or fail to start, it can run the same analysis inline.

`MusicAnalyzer.ts` orchestrates pure DSP modules:

- `Fft.ts` supplies frequency-domain transforms.
- `OnsetDetector.ts` derives band-aware spectral flux and onset candidates.
- `TempoEstimator.ts` evaluates tempo and phase candidates.
- `BeatGrid.ts` measures alignment, beat coverage, bar phase, and section confidence.
- `EnergyProfile.ts` identifies energy levels and quiet ranges.

The analysis layer is deterministic for the same decoded samples and options. It does not use render timing or the live audio clock.

## Beatmap generation

`chart/ChartGenerator.ts` turns measured onsets, beat evidence, energy, and section confidence into chart events. Candidate selection avoids inventing dense grid notes where the audio does not support them. Musical-role heuristics map register and metric position to seven lanes, with spacing, chord, density, and playability constraints. The seed and generator version are recorded for reproducibility.

`ChartTypes.ts` defines the versioned beatmap shape. `ChartValidator.ts` is the trust boundary for generated, stored, or externally supplied charts. `PatternParser.ts` supports the authored built-in pattern, while `demoChart.ts` supplies the built-in chart. Generated charts currently use the seven-lane `normal` difficulty only.

## Rendering and gameplay

`game/GameEngine.ts` advances gameplay from song time and coordinates judgments and misses. `JudgmentEngine.ts` applies timing windows; `ScoreManager.ts` maintains score, combo, accuracy, and counts; `LanePressTracker.ts` prevents duplicate logical presses; and `InputManager.ts` translates keyboard and pointer state into lane transitions.

The renderer is deliberately separate from scoring. `renderer/SceneManager.ts` owns the Three.js scene and frame-loop integration. `CameraFraming.ts` and `Layout.ts` calculate responsive geometry. `LaneRenderer.ts`, `NoteRenderer.ts`, and `EffectRenderer.ts` display the highway, chart state, and feedback. A dropped or delayed frame changes presentation but not the audio-clock judgment calculation.

## Input and judgment

Keyboard input maps `A S D Space J K L` to lanes 0–6 and ignores repeat events. Touch uses pointer events through `ui/TouchSurface.ts`; each pointer owns at most one lane, enabling chords and independent holds. Moving a pointer changes its lane through explicit release/press transitions. Cancellation and leaving the playable area release state to avoid stuck holds.

The engine compares a press or release song time with chart-note time. PERFECT, GOOD, BAD, and MISS windows are centralized in game configuration and are tested independently of rendering.

## Storage and persistence

`storage/SongLibrary.ts` uses an IndexedDB database named `seven-keys` with separate `songs` and `audio` object stores. Song records contain chart notes, tempo/grid values, compact diagnostics, validation data, and metadata; the audio store holds the optional original or transcoded blob. Keeping blobs separate makes library listing inexpensive. Writes span both stores in one transaction.

`storage/SongRecord.ts` encodes, decodes, versions, and validates persisted records. Stored records are treated as untrusted input when read. If IndexedDB is unavailable, a memory implementation preserves the workflow for the current session only. `storage/SettingsStore.ts` stores small versioned preferences in `localStorage` and tolerates access failures.

Browser storage belongs to the site's origin and local browser profile. It is not a shared application database and never reaches the static hosting server.
