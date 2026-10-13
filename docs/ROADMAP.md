# Roadmap

This document separates verified current scope from product direction. Planned items are not commitments and should not be described as available until implemented and tested.

## Completed

### Playable seven-key foundation

- Three.js seven-lane highway and responsive camera framing.
- Original synthesized demo audio and authored demo chart.
- Audio-clock timing, tap/chord/hold judgment, score, accuracy, combo, misses, and results.
- Pause, resume, restart, seek/debug hooks, calibration, speed, and chart offset.
- Keyboard input using `A S D Space J K L`.

### Mobile input and layout

- Landscape-first framing and orientation overlay.
- Multi-touch chords and holds.
- Pointer ownership, cancellation safety, and lane-to-lane slide/swipe input.
- Fullscreen/orientation affordances and device-layout diagnostics.

### Local music workflow

- Local MP3 validation and browser decoding.
- Worker-based onset, tempo, beat-grid, energy, and section analysis with inline fallback.
- Deterministic seven-lane Normal chart generation and validation.
- Role-aware lane placement and measured analysis diagnostics.
- IndexedDB storage of charts, metadata, diagnostics, and optional original/transcoded audio.
- Memory-only fallback when persistent browser storage is unavailable.

### Engineering baseline

- Strict TypeScript configuration.
- Automated unit, DSP fixture, DOM input, layout, import, generation, storage, and timing tests.
- Reproducible npm workspace lockfile and static Vite production build.

## Next milestone

- Define and implement Easy (4-key), Normal (5-key), and Hard (7-key) gameplay/chart modes.
- Preserve existing audio synchronization, judgment semantics, input safety, and deterministic generation.
- Add mode-specific lane mappings, generation constraints, validation, UI selection, and tests.
- Decide how existing seven-lane Normal records migrate or remain compatible.

## Planned, not implemented

### Chart workflow

- Assisted chart editor and manual timing correction.
- Versioned chart import/export user interface.
- Regeneration controls for tempo, seed, density, and difficulty.
- Local library management beyond the current stored-song workflow.

### Quality and accessibility

- Cross-browser end-to-end smoke automation.
- Device performance profiling and lower-power rendering options.
- Keyboard remapping, accessibility review, additional calibration guidance, and visual/audio feedback options.
- Production screenshot set, supported-browser matrix, and formal release checklist.

### Possible online service

- Public chart discovery, accounts, moderation, publishing, and score services.
- YouTube URLs as references through permitted official APIs, not as an audio extraction source.
- Server-side validation, authorization, rate limiting, reporting, and data retention policies.

An online service would be a separate architecture and security milestone. The current static application does not need Laravel, another backend framework, a server database, Docker, or CI/CD infrastructure.

## Decisions still required

- Select a project software license before public redistribution or outside contributions.
- Establish a browser/device support policy and performance floor.
- Decide whether production source maps should be public.
- Define backup/export expectations for browser-local libraries before storage schema changes.
- Establish music and chart-content rights rules before any sharing feature is designed.
