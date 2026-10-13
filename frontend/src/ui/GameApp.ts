/**
 * GameApp — wires every layer together and owns the application state machine.
 *
 *   loading -> ready -> playing <-> paused -> results -> (restart | ready)
 *
 * The single requestAnimationFrame loop lives here. It reads the audio clock once per frame
 * and hands that one number to the game engine (rules) and to the renderers (visuals). The
 * rules never see a frame counter, and the renderers never see an input event; both consume
 * the same authoritative song time.
 *
 * Frame work is intentionally ordered: clock -> engine.update -> renderers, so a frame always
 * draws the state produced by the clock reading it just made.
 */

import { WebAudioEngine } from '../audio/AudioEngine';
import { renderDemoTrack } from '../audio/DemoSynth';
import { AnalysisClient } from '../analysis/AnalysisClient';
import { prepareBeatmap } from '../chart/ChartValidator';
import type { Beatmap } from '../chart/ChartTypes';
import { lanesOf } from '../chart/ChartTypes';
import { buildDemoChart } from '../chart/demoChart';
import {
  availableDifficulties,
  chartSetFromCharts,
  defaultDifficultyOf,
  generateChartSet,
  primaryChart,
  type ChartSet,
} from '../chart/DifficultySet';
import { basicStats } from '../chart/ChartGenerator';
import { difficultyProfile, keyLabelsFor, type ChartDifficulty } from '../chart/Difficulty';
import { maxTheoreticalScoreOf } from '../chart/ScoreModel';
import { DEMO_BEAT_MS, DEMO_BPM, SECTIONS } from '../content/demoSong';
import type { GameEvent } from '../game/GameEngine';
import { GameEngine } from '../game/GameEngine';
import { InputManager, keyLayoutFor } from '../game/InputManager';
import type { GameSettings } from '../game/GameConfig';
import type { PlayResults } from '../game/ScoreManager';
import type { ScoreEntry } from '../storage/ScoreStore';
import type { Framing } from '../renderer/CameraFraming';
import { computeFraming } from '../renderer/CameraFraming';
import { EffectRenderer, type EffectKind } from '../renderer/EffectRenderer';
import { LaneRenderer } from '../renderer/LaneRenderer';
import { LANE_COUNT, leadMsForSpeed, setActiveLanePalette } from '../renderer/Layout';
import { NoteRenderer } from '../renderer/NoteRenderer';
import { SceneManager } from '../renderer/SceneManager';
import { openSongLibrary, type SongStore } from '../storage/SongLibrary';
import { SettingsStore } from '../storage/SettingsStore';
import { DiagnosticsPanel, type DiagnosticsData } from './DiagnosticsPanel';

type SerialisableDiagnostics = Omit<DiagnosticsData, 'audio' | 'loadAudio'> & { hasAudio: boolean };

function diagnosticsSnapshot(data: DiagnosticsData | null): SerialisableDiagnostics | null {
  if (!data) return null;
  // Both the decoded buffer and the decode-on-demand closure are dropped: the snapshot has to be
  // readable in a console and serialisable, and `hasAudio` is what the caller actually wants.
  const { audio, loadAudio, ...rest } = data;
  return { ...rest, hasAudio: audio !== null || loadAudio !== null };
}
import { ImportPanel, type PlayableSong } from './ImportPanel';
import { readDeviceProfile, readSafeAreaInsets, type DeviceProfile } from './DeviceProfile';
import { Hud } from './Hud';
import { OrientationGate } from './OrientationGate';
import { Overlay } from './Overlay';
import { ResultsScreen } from './ResultsScreen';
import { TouchSurface } from './TouchSurface';
import { el, setHidden, setText } from './dom';

export type AppState = 'loading' | 'ready' | 'playing' | 'paused' | 'results' | 'error';

/** Beats of 3-2-1 before a fresh chart starts. */
const COUNT_IN_BEATS = 3;
/** Lead-in when resuming a paused run (audio resumes exactly at the frozen position). */
const RESUME_COUNT_IN_MS = 1200;
/** Short lead-in after a seek so the player can see what is coming. */
const SEEK_COUNT_IN_MS = 600;
const MAX_FRAME_DT_SEC = 0.05;
/**
 * How much extra lead the renderer keeps beyond what is actually on screen. Notes past the top
 * edge are culled, but a margin keeps a note from popping in exactly at the edge as the frame
 * advances.
 */
const VISUAL_LEAD_MARGIN_MS = 250;

export class GameApp {
  readonly scene: SceneManager;

  private readonly laneRenderer: LaneRenderer;
  private readonly noteRenderer: NoteRenderer;
  private readonly effectRenderer: EffectRenderer;
  private readonly hud = new Hud();
  private readonly resultsScreen = new ResultsScreen();
  private readonly settings = new SettingsStore();
  private readonly overlay: Overlay;
  private readonly audio = new WebAudioEngine();
  private readonly input: InputManager;
  private readonly touchSurface: TouchSurface;
  private readonly orientationGate: OrientationGate;
  private pressedState = new Array<boolean>(LANE_COUNT).fill(false);

  /**
   * The chart and engine are swappable in phase 2: importing a song replaces both, and the demo
   * chart is kept so "Start demo chart" always means what it says. Everything that consumes a
   * chart goes through these two fields, so there is exactly one current chart at a time.
   */
  private chartValue: Beatmap;
  private engineValue: GameEngine;
  /**
   * Every difficulty of the current song, so switching costs no re-analysis and no reload. The demo
   * chart and a pre-phase-3 saved song have a single entry (Hard), which is why this is partial.
   */
  private chartSetValue: ChartSet;
  private difficultyValue: ChartDifficulty = 'hard';
  /** Best stored run for (song, difficulty), refreshed when a run finishes. */
  private bestScore: ScoreEntry | null = null;
  private readonly demoChart: Beatmap;
  private demoBuffer: AudioBuffer | null = null;
  /** Beat length of the *current* chart, used for the count-in and the HUD. */
  private beatMs = DEMO_BEAT_MS;
  /**
   * Theoretical maximum for the loaded chart, computed once per load. The HUD reads it every frame,
   * so it must not be derived from a fresh engine result each time.
   */
  private maxScoreValue = 0;
  private songSubtitle = '';
  private songSource: 'demo' | 'import' | 'library' = 'demo';
  private readonly analysisClient = new AnalysisClient();
  private readonly diagnosticsPanel = new DiagnosticsPanel();
  private importPanel: ImportPanel | null = null;
  private library: SongStore | null = null;
  private libraryDegradedReason: string | null = null;

  private stateValue: AppState = 'loading';
  private settingsCache: GameSettings;
  private deviceProfile: DeviceProfile;
  private framing: Framing;
  private viewportWidth = 1;
  private viewportHeight = 1;
  private rafId = 0;
  private lastFrameMs = 0;
  private fps = 60;
  private playStartSongMs = 0;
  private countInMs = 0;
  private durationMs = 0;
  private visualLeadMs = 0;
  private pausedByFocus = false;
  private pausedForOrientation = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.demoChart = prepareBeatmap(buildDemoChart());
    this.chartValue = this.demoChart;
    // The demo chart is loaded here directly (the ready panel's "start" path does not go through
    // `loadSong`), so its maximum has to be resolved here too: the HUD shows the score as a share of
    // it, and a stale 0 would read as "0 · 0.00 %" for the whole run.
    this.maxScoreValue = this.maxScoreFor(this.demoChart, this.difficultyValue);
    // The hand-authored demo is a single seven-key chart: no analysis exists for it, so there is
    // nothing to generate the other two difficulties *from*. It is presented as Hard, which is what
    // its seven lanes are.
    this.chartSetValue = chartSetFromCharts({
      songId: this.demoChart.songId,
      title: this.demoChart.title,
      ...(this.demoChart.artist ? { artist: this.demoChart.artist } : {}),
      durationMs: this.demoChart.durationMs ?? 0,
      bpm: this.demoChart.bpm,
      generator: { ...this.demoChart.generator },
      charts: [
        {
          difficulty: 'hard',
          profile: difficultyProfile('hard'),
          chart: this.demoChart,
          stats: basicStats(this.demoChart),
          validation: { ok: true, errors: [], warnings: [] },
          warnings: [],
        },
      ],
    });
    this.difficultyValue = 'hard';
    this.settingsCache = this.settings.get();
    this.deviceProfile = readDeviceProfile(window, el('stage'), window.location?.search ?? '');
    // Publish the layout mode so the stylesheet can compact the HUD; set before the first
    // frame is drawn so there is no flash of the desktop HUD on a phone.
    document.documentElement.dataset.touch = this.deviceProfile.touchLayout ? 'true' : 'false';
    this.framing = computeFraming({
      viewportWidth: window.innerWidth || 1,
      viewportHeight: window.innerHeight || 1,
      insets: this.deviceProfile.safeInsets,
      touchLayout: this.deviceProfile.touchLayout,
    });

    this.scene = new SceneManager(canvas);
    this.laneRenderer = new LaneRenderer(this.scene.world);
    this.noteRenderer = new NoteRenderer(this.scene.world);
    this.effectRenderer = new EffectRenderer(this.scene.world);

    this.engineValue = new GameEngine({
      chart: this.chartValue,
      clock: this.audio,
      globalOffsetMs: this.settingsCache.globalOffsetMs,
    });

    this.touchSurface = new TouchSurface(el('touch-layer'));

    this.overlay = new Overlay(this.settings, {
      onStart: () => void this.startDemo(),
      onOpenImport: () => this.openImportPanel(),
      onPause: () => this.pause(false),
      onResume: () => void this.resume(),
      onRestart: () => void this.restart(),
      onBackToMenu: () => this.backToMenu(),
      onSettingsChange: (settings) => this.applySettings(settings),
    });

    this.orientationGate = new OrientationGate({
      win: window,
      doc: document,
      fullscreenTarget: el('stage'),
      overlay: el('rotate-overlay'),
      fullscreenButtons: [el('btn-fullscreen'), el('btn-fullscreen-ready'), el('btn-fullscreen-rotate')],
      storage: safeLocalStorage(),
      enabled: () => this.deviceProfile.touchLayout,
      onPortraitEntered: () => this.pauseForOrientation(),
      onLandscapeSettled: () => this.settleOrientation(),
    });
    el('btn-portrait-continue').addEventListener('click', () => this.orientationGate.dismiss());

    this.audio.setInterruptionHandler(() => this.pause(true));

    // Difficulty switching from the pause menu: the chart set is already in memory, so this is a
    // chart swap plus a restart, never a re-analysis.
    el('pause-difficulty-options').addEventListener('click', (event) => {
      const button = (event.target as HTMLElement | null)?.closest('button[data-difficulty]') as HTMLButtonElement | null;
      const difficulty = button?.dataset.difficulty;
      if (difficulty === 'easy' || difficulty === 'normal' || difficulty === 'hard') {
        void this.setDifficulty(difficulty);
      }
    });

    this.input = new InputManager(
      {
        nowMs: () => this.audio.getSongTimeMs(),
        onLanePress: (lane, songTimeMs) => {
          if (this.stateValue !== 'playing') return;
          this.handleEvents(this.engine.pressLane(lane, songTimeMs));
        },
        onLaneRelease: (lane, songTimeMs) => {
          if (this.stateValue !== 'playing') return;
          this.handleEvents(this.engine.releaseLane(lane, songTimeMs));
        },
        onLaneVisual: (lane, active) => {
          this.hud.setLaneActive(lane, active);
          this.touchSurface.setLaneActive(lane, active);
        },
        onTogglePause: () => {
          if (this.stateValue === 'playing') this.pause(false);
          else if (this.stateValue === 'paused') void this.resume();
        },
        onRestart: () => {
          if (this.stateValue !== 'loading' && this.stateValue !== 'error') void this.restart();
        },
        onFocusLost: () => this.pause(true),
      },
      window,
      document,
    );

    this.songSubtitle = this.describeDemoChart();
    this.updateSongInfo();
    this.hud.show(false);
    // The player's saved palette is applied before the first frame, so the highway never flashes
    // the default theme after a reload.
    this.applyLanePalette(this.settingsCache.lanePalette);
  }

  // -------------------------------------------------------------- accessors --

  get chart(): Beatmap {
    return this.chartValue;
  }

  get engine(): GameEngine {
    return this.engineValue;
  }

  // -------------------------------------------------------------------- boot --

  async init(): Promise<void> {
    if (!WebAudioEngine.isSupported()) {
      throw new Error('This browser does not support the Web Audio API, which Seven Keys needs for precise timing.');
    }
    this.resize();
    window.addEventListener('resize', this.resizeHandler);
    this.input.attach();
    // The surface (not just its element) is handed over so slides can resolve a point to a lane
    // from the cached column rectangles instead of `event.target`, which pointer capture freezes.
    this.input.attachPointer(this.touchSurface);
    this.orientationGate.start();
    this.stateValue = 'loading';

    // Create the context up-front (still suspended until the player's gesture) so the offline
    // render below happens at exactly the sample rate playback will use.
    const context = this.audio.prepareContext();
    const buffer = await renderDemoTrack({
      sampleRate: context.sampleRate,
      onProgress: (ratio, label) => this.overlay.setLoading(ratio, label),
    });
    this.demoBuffer = buffer;
    this.audio.loadBuffer(buffer);
    this.audio.setVolume(this.settingsCache.volume);
    this.durationMs = buffer.duration * 1000;

    // The song library and the import UI are opened after the demo track is ready, so a database
    // problem (or a browser without IndexedDB) degrades the import feature without delaying play.
    await this.initLibrary();

    this.overlay.setLoading(1, 'Ready to play');
    this.stateValue = 'ready';
    this.overlay.showPanel('ready');
    this.startRenderLoop();
  }

  private async initLibrary(): Promise<void> {
    try {
      const library = await openSongLibrary();
      this.library = library.store;
      this.libraryDegradedReason = library.degradedReason;
      this.importPanel = new ImportPanel({
        client: this.analysisClient,
        store: library.store,
        getContext: () => this.decodeContext(),
        onPlay: (song) => void this.playImported(song),
        onDiagnostics: (data) => {
          this.diagnosticsPanel.show(data);
          // A fresh report is worth reading: open the summary and leave the advanced section as the
          // player left it, rather than making them hunt for the button they just pressed.
          this.diagnosticsPanel.openAdvanced();
        },
        onBack: () => {
          // Leaving the import panel ends any section preview: it is diagnostic audio with its own
          // context and must never outlive the screen it belongs to.
          this.diagnosticsPanel.stopPreview();
          this.overlay.showPanel('ready');
        },
      });
      if (library.degradedReason) this.overlay.setError(library.degradedReason);
    } catch (error) {
      this.libraryDegradedReason = error instanceof Error ? error.message : String(error);
      this.overlay.setError(`The song library is unavailable: ${this.libraryDegradedReason}`);
    }
  }

  /** An AudioContext that is running (or at least exists), for decoding. */
  private async decodeContext(): Promise<BaseAudioContext> {
    try {
      return await this.audio.ensureContext();
    } catch {
      // Safari can refuse a resume outside a gesture; decoding still works on a suspended context.
      return this.audio.prepareContext();
    }
  }

  openImportPanel(): void {
    if (!this.importPanel) {
      this.overlay.setError('Importing is unavailable because the song library could not be opened.');
      return;
    }
    this.overlay.setError(null);
    this.overlay.showPanel('import');
    void this.importPanel.open();
  }

  // ------------------------------------------------------------------- flow ---

  async start(): Promise<void> {
    if (this.stateValue === 'loading' || this.stateValue === 'error') return;
    try {
      await this.audio.ensureContext();
    } catch (error) {
      this.fail(error);
      return;
    }
    // Immersive mode (fullscreen + landscape lock) is only requested from this gesture, and at
    // most once per browser: a rejected or unsupported request is simply ignored.
    void this.orientationGate.requestImmersiveOnce();
    this.resetRun();
    this.beginPlayback(0, COUNT_IN_BEATS * this.beatMs, 'fresh');
  }

  /** Load the hand-authored demo chart and play it (the ready panel's primary button). */
  async startDemo(): Promise<void> {
    if (this.songSource !== 'demo' || !this.demoBuffer) {
      this.loadSong({
        set: this.chartSetValue,
        difficulty: 'hard',
        buffer: this.demoBuffer ?? (await this.renderDemoIfNeeded()),
        record: null,
        fromLibrary: false,
        diagnostics: null,
        source: 'demo',
      });
    }
    await this.start();
  }

  /**
   * Development/QA hook: import audio from a URL exactly as if it had been picked from disk.
   * Used by the automated browser check (a headless browser cannot drive a file picker) and by
   * `window.SevenKeys.importUrl(...)`. Not part of the player-facing workflow — the panel only
   * accepts a local file (`<input type=file>`).
   */
  async importFromUrl(url: string, name?: string): Promise<void> {
    const panel = this.importPanel;
    if (!panel) throw new Error('the import panel is unavailable');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`could not fetch ${url} (HTTP ${response.status})`);
    const blob = await response.blob();
    const fileName = name ?? url.split('/').pop() ?? 'audio.mp3';
    const file = new File([blob], fileName, { type: blob.type || 'audio/mpeg' });
    this.overlay.showPanel('import');
    await panel.open();
    await panel.importFile(file);
  }

  private async renderDemoIfNeeded(): Promise<AudioBuffer> {
    if (this.demoBuffer) return this.demoBuffer;
    const buffer = await renderDemoTrack({
      sampleRate: this.audio.sampleRate,
      onProgress: (ratio, label) => this.overlay.setLoading(ratio, label),
    });
    this.demoBuffer = buffer;
    return buffer;
  }

  /**
   * Swap the current song: chart, engine, audio buffer, HUD text and diagnostics all change
   * together, and the run state is reset exactly as a fresh start does. The input, judgment and
   * timing layers are untouched — they only ever see "the current chart".
   */
  loadSong(song: PlayableSong): void {
    this.chartSetValue = song.set;
    this.difficultyValue = song.difficulty;
    const chart = song.set.charts[song.difficulty]?.chart ?? primaryChart(song.set)?.chart;
    if (!chart) throw new Error('the song has no chart for that difficulty');
    this.chartValue = prepareBeatmap(chart);
    this.engineValue = new GameEngine({
      chart: this.chartValue,
      clock: this.audio,
      globalOffsetMs: this.settingsCache.globalOffsetMs,
    });
    this.audio.loadBuffer(song.buffer);
    this.audio.setVolume(this.settingsCache.volume);
    this.durationMs = song.buffer.duration * 1000;
    this.beatMs = 60000 / this.chartValue.bpm;
    this.maxScoreValue = this.maxScoreFor(this.chartValue, this.difficultyValue);
    this.songSource = song.source ?? (song.fromLibrary ? 'library' : 'import');
    this.songSubtitle = this.describeChart(this.chartValue, this.songSource, song.record !== null);
    this.updateSongInfo();
    if (song.diagnostics) this.diagnosticsPanel.show(song.diagnostics);
    else this.diagnosticsPanel.clear();
    // Lane count, key map, HUD strip and touch columns all follow the chart that is now loaded. This
    // is the single place that decides "how many lanes are we rendering", so nothing can disagree.
    this.applyLaneLayout(this.chartValue);
    this.refreshBestScore();
    this.renderPauseDifficulty();
    this.hud.reset();
    this.noteRenderer.reset();
    this.effectRenderer.clear();
    this.laneRenderer.reset();
    this.stateValue = 'ready';
  }

  /**
   * Point every view and the input layer at a chart's lane count.
   *
   * Cheap and idempotent, so it runs on every load: the renderers rebuild nothing when the count is
   * unchanged, and the camera is re-solved (which the touch columns are derived from) so four lanes
   * get four wide columns instead of four narrow ones in a seven-lane road.
   */
  private applyLaneLayout(chart: Beatmap): void {
    const laneCount = lanesOf(chart);
    const labels = chart.keyLabels ?? keyLabelsFor(laneCount);
    this.laneRenderer.setLaneCount(laneCount);
    this.noteRenderer.setLaneCount(laneCount);
    this.effectRenderer.setLaneCount(laneCount);
    this.hud.setLaneCount(laneCount);
    this.touchSurface.setLaneCount(laneCount, labels);
    this.input.setKeyLayout({ laneCount, keys: difficultyProfile(this.difficultyValue).keys });
    this.pressedState = new Array<boolean>(laneCount).fill(false);
    this.resize();
  }

  /**
   * The maximum score for a chart: the number the chart itself carries when it was generated, or the
   * same formula applied to its notes at the difficulty's weight (`chart/ScoreModel.ts`). A flawless
   * run reaches it, so the HUD's score/max percentage can read 100.00 %.
   */
  private maxScoreFor(chart: Beatmap, difficulty: ChartDifficulty): number {
    return chart.maxScore ?? maxTheoreticalScoreOf(chart.notes, difficultyProfile(difficulty).scoreWeight);
  }

  /**
   * Switch difficulty without re-analysing or re-decoding anything: the chart is already in
   * `chartSetValue`, so this swaps the chart and restarts the run.
   */
  async setDifficulty(difficulty: ChartDifficulty): Promise<void> {
    if (difficulty === this.difficultyValue) return;
    if (!this.chartSetValue.charts[difficulty]) return;
    const buffer = this.audio.currentBuffer;
    if (!buffer) return;
    const wasPlaying = this.stateValue === 'playing' || this.stateValue === 'paused';
    this.audio.pause();
    this.input.setEnabled(false);
    this.touchSurface.setInteractive(false);
    this.loadSong({
      set: this.chartSetValue,
      difficulty,
      buffer,
      record: null,
      fromLibrary: this.songSource === 'library',
      diagnostics: null,
      source: this.songSource,
    });
    this.overlay.showPanel('ready');
    if (wasPlaying) await this.start();
  }

  /** Difficulties available for the current song, for the UI. */
  get availableDifficulties(): ChartDifficulty[] {
    return availableDifficulties(this.chartSetValue);
  }

  get difficulty(): ChartDifficulty {
    return this.difficultyValue;
  }

  get bestScoreValue(): ScoreEntry | null {
    return this.bestScore;
  }

  /** Load the stored best for the current song + difficulty (never throws: scores are optional). */
  private refreshBestScore(): void {
    const scores = this.library?.scores;
    if (!scores) {
      this.bestScore = null;
      return;
    }
    void scores
      .best(this.chartValue.songId, this.difficultyValue)
      .then((entry) => {
        this.bestScore = entry;
      })
      .catch(() => {
        this.bestScore = null;
      });
  }

  /**
   * Persist a finished run. Only songs with an id get a score (the demo chart included: it has one,
   * and "best on the demo" is a real thing to want), and only the best run per difficulty is kept.
   */
  private async recordScore(results: PlayResults): Promise<void> {
    const scores = this.library?.scores;
    if (!scores) return;
    try {
      const submitted = await scores.submit({
        songId: this.chartValue.songId,
        title: this.chartValue.title,
        difficulty: this.difficultyValue,
        difficultyWeight: results.difficultyWeight,
        generatorVersion: this.chartValue.generator.version,
        score: results.score,
        maxScore: results.maxScore,
        accuracy: results.accuracy,
        grade: results.grade,
        maxCombo: results.maxCombo,
        totalNotes: results.totalNotes,
      });
      const previous = this.bestScore;
      this.bestScore = submitted.entry;
      this.resultsScreen.showBest(submitted.entry, submitted.isBest && previous !== null && previous.score < submitted.entry.score);
    } catch {
      // A score that cannot be stored must not spoil the results screen.
    }
  }

  /** Called by the import panel when the player presses "Play this chart". */
  private async playImported(song: PlayableSong): Promise<void> {
    this.loadSong(song);
    await this.start();
  }

  async restart(): Promise<void> {
    if (this.stateValue === 'loading' || this.stateValue === 'error') return;
    this.input.setEnabled(false);
    this.audio.pause();
    await this.start();
  }

  /** Fill the pause panel's difficulty switcher (hidden when the song has only one chart). */
  private renderPauseDifficulty(): void {
    const available = availableDifficulties(this.chartSetValue);
    setHidden(el('pause-difficulty'), available.length < 2);
    const container = el('pause-difficulty-options');
    container.replaceChildren();
    for (const difficulty of available) {
      const profile = difficultyProfile(difficulty);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm btn-small';
      button.dataset.difficulty = difficulty;
      button.dataset.active = difficulty === this.difficultyValue ? 'true' : 'false';
      button.textContent = `${profile.short} · ×${profile.scoreWeight.toFixed(1)}`;
      container.appendChild(button);
    }
  }

  pause(auto: boolean): void {
    if (this.stateValue !== 'playing') return;
    this.audio.pause();
    this.renderPauseDifficulty();
    this.handleEvents(this.engine.pause());
    this.stateValue = 'paused';
    this.pausedByFocus = auto;
    this.input.setEnabled(false);
    this.touchSurface.setInteractive(false); // a paused run takes no note input
    this.overlay.showPanel('pause');
  }

  async resume(): Promise<void> {
    if (this.stateValue !== 'paused') return;
    try {
      await this.audio.ensureContext();
    } catch (error) {
      this.fail(error);
      return;
    }
    const from = Math.max(0, this.audio.getSongTimeMs());
    this.beginPlayback(from, RESUME_COUNT_IN_MS, 'resume');
  }

  backToMenu(): void {
    if (this.stateValue === 'loading' || this.stateValue === 'error') return;
    this.audio.pause();
    this.input.setEnabled(false);
    this.touchSurface.setInteractive(false);
    this.pausedForOrientation = false;
    this.hud.show(false);
    this.hud.reset();
    this.effectRenderer.clear();
    this.laneRenderer.reset();
    this.stateValue = 'ready';
    this.overlay.showPanel('ready');
  }

  /**
   * Move the playhead. Exposed for debug tooling now and reused by the chart editor preview in
   * phase 4: notes skipped over resolve as misses on the next update.
   */
  seekTo(songTimeMs: number): void {
    if (this.stateValue !== 'playing' && this.stateValue !== 'paused') return;
    const wasPlaying = this.stateValue === 'playing';
    this.input.setEnabled(false);
    this.audio.pause();
    if (this.engine.phase === 'playing') {
      this.engine.pause();
      this.engine.drainEvents();
    }
    this.handleEvents(this.engine.seekTo(songTimeMs));
    this.noteRenderer.reset();
    this.effectRenderer.clear();
    this.laneRenderer.reset();

    if (wasPlaying) {
      void this.audio
        .ensureContext()
        .then(() => this.beginPlayback(songTimeMs, SEEK_COUNT_IN_MS, 'seek'))
        .catch((error: unknown) => this.fail(error));
    } else {
      this.overlay.showPanel('pause');
    }
  }

  get state(): AppState {
    return this.stateValue;
  }

  /**
   * Portrait entered on a touch device. Pausing is not a judgement call: the layout is about to
   * change, the touch columns move, and a hold would otherwise be judged against a frozen
   * screen. `pausedForOrientation` makes the matching resume conditional on the layout
   * settling back into landscape.
   */
  private pauseForOrientation(): void {
    if (this.stateValue !== 'playing') return;
    this.pausedForOrientation = true;
    this.pause(true);
  }

  /** The viewport settled after leaving portrait: resume only if the rotation caused the pause. */
  private settleOrientation(): void {
    if (!this.pausedForOrientation) return;
    this.pausedForOrientation = false;
    if (this.stateValue === 'paused' && !this.orientationGate.portrait) void this.resume();
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.diagnosticsPanel.dispose();
    window.removeEventListener('resize', this.resizeHandler);
    this.input.detachPointer();
    this.orientationGate.stop();
    this.input.detach();
    this.laneRenderer.dispose();
    this.noteRenderer.dispose();
    this.effectRenderer.dispose();
    this.scene.dispose();
    this.analysisClient.dispose();
    try {
      this.library?.close();
    } catch {
      /* the database may already be closed by a reload */
    }
    void this.audio.dispose();
  }

  // ------------------------------------------------------------- internals ---

  private beginPlayback(songTimeMs: number, countInMs: number, mode: 'fresh' | 'resume' | 'seek'): void {
    this.countInMs = countInMs;
    this.playStartSongMs = songTimeMs;

    this.engine.setGlobalOffsetMs(this.settingsCache.globalOffsetMs);
    if (mode === 'resume') this.engine.resume();
    else this.engine.begin();

    this.audio.setVolume(this.settingsCache.volume);
    this.audio.play(songTimeMs, { countInMs, beatMs: this.beatMs, countInVolume: 0.35 });

    this.stateValue = 'playing';
    this.pausedByFocus = false;
    this.input.setEnabled(true);
    this.hud.clearLaneStates();
    this.hud.show(true);
    this.overlay.showPanel(null);
    this.touchSurface.clearLanes();
    // The HUD is only laid out now that it is visible, so the columns are measured here.
    this.layoutTouchSurface();
    // Only a touch-first device gets lane columns: on a desktop they would sit invisibly over
    // the highway and turn stray mouse clicks into note presses.
    this.touchSurface.setInteractive(this.deviceProfile.touchLayout);
  }

  private resetRun(): void {
    this.engine.reset();
    this.noteRenderer.reset();
    this.effectRenderer.clear();
    this.laneRenderer.reset();
    this.hud.reset();
  }

  private finishRun(event: Extract<GameEvent, { type: 'finished' }>): void {
    this.stateValue = 'results';
    this.input.setEnabled(false);
    this.touchSurface.setInteractive(false);
    this.pausedForOrientation = false;
    this.audio.pause();
    this.hud.clearLaneStates();
    this.touchSurface.clearLanes();
    this.resultsScreen.render(event.results);
    this.overlay.showPanel('results');
    // Persisting is asynchronous and must never delay the results screen; the best score row fills
    // in when the store answers (see `recordScore`).
    void this.recordScore(event.results);
  }

  private handleEvents(events: readonly GameEvent[]): void {
    if (events.length === 0) return;
    const songTimeMs = this.audio.getSongTimeMs();

    for (const event of events) {
      switch (event.type) {
        case 'judgment': {
          const kind = event.judgment;
          this.hud.popJudgment(kind, event.errorMs);
          this.effectRenderer.spawn(event.lane, kind as EffectKind, songTimeMs, kind === 'perfect' ? 1.25 : 1);
          this.laneRenderer.flashLane(
            event.lane,
            kind === 'perfect' ? 1.3 : kind === 'good' ? 1 : kind === 'bad' ? 0.7 : 0.45,
          );
          this.audio.tick(kind);
          break;
        }
        case 'hold-complete':
          this.hud.popJudgment('hold', null, 'HOLD CLEAR');
          this.effectRenderer.spawn(event.lane, 'hold', songTimeMs, 0.9);
          this.laneRenderer.flashLane(event.lane, 1);
          break;
        case 'hold-broken':
          this.hud.popJudgment('hold', null, 'HOLD BROKEN');
          break;
        case 'stray-press':
        case 'interrupted-hold':
          break;
        case 'finished':
          this.finishRun(event);
          break;
      }
    }
  }

  private tick(dtSec: number): void {
    const songTimeMs = this.audio.getSongTimeMs();

    if (this.stateValue === 'playing') {
      this.handleEvents(this.engine.update(songTimeMs));
    }

    // Visual lead: the player's speed setting, capped to what is actually on screen. On a
    // desktop (and on a landscape phone, where the whole road fits) the cap never binds; on a
    // viewport where the road is cut off by the top edge it stops us submitting notes that
    // cannot be seen to the GPU.
    const leadMs = Math.min(
      leadMsForSpeed(this.settingsCache.noteSpeed),
      this.framing.visibleLeadMs + VISUAL_LEAD_MARGIN_MS,
    );
    this.visualLeadMs = leadMs;
    this.noteRenderer.update(this.engine.notes, songTimeMs, leadMs);
    this.effectRenderer.update(songTimeMs);

    this.input.writePressedState(this.pressedState);
    this.laneRenderer.update(dtSec, this.pressedState);

    if (this.stateValue === 'playing' || this.stateValue === 'paused') {
      this.hud.update({
        snapshot: this.engine.scoreSnapshot,
        songTimeMs: Math.max(0, songTimeMs),
        durationMs: this.durationMs,
        fps: this.fps,
        countInRemainingMs: this.playStartSongMs - songTimeMs,
        beatMs: this.beatMs,
        countInMs: this.countInMs,
        difficulty: this.difficultyValue,
        laneCount: this.chartValue.laneCount ?? LANE_COUNT,
        maxScore: this.maxScoreValue,
      });
    }

    this.scene.render();
  }

  private startRenderLoop(): void {
    this.lastFrameMs = performance.now();
    const loop = (now: number): void => {
      this.rafId = requestAnimationFrame(loop);
      const dtSec = Math.min(MAX_FRAME_DT_SEC, Math.max(0, (now - this.lastFrameMs) / 1000));
      this.lastFrameMs = now;
      if (dtSec > 0) this.fps += (1 / dtSec - this.fps) * 0.08;
      this.tick(dtSec);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private readonly resizeHandler = (): void => this.resize();

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width || window.innerWidth);
    const height = Math.max(1, rect.height || window.innerHeight);
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.scene.resize(width, height);

    // Cutouts follow the orientation, so they are re-read on every resize and folded into the
    // camera solve: on a landscape phone the notch eats one side of the screen, and the lane
    // columns (and the road centre) move to the usable rectangle instead of hiding behind it.
    this.deviceProfile = {
      ...this.deviceProfile,
      safeInsets: readSafeAreaInsets(el('stage'), (node) => getComputedStyle(node)),
    };
    this.framing = computeFraming({
      viewportWidth: width,
      viewportHeight: height,
      insets: this.deviceProfile.safeInsets,
      touchLayout: this.deviceProfile.touchLayout,
      // The lane count of the chart being played decides how wide the road is drawn and how the
      // mobile camera spreads the columns (the touch layer follows the same projection).
      laneCount: this.chartValue.laneCount ?? LANE_COUNT,
    });
    this.scene.applyFraming(this.framing);
    document.documentElement.dataset.framing = this.framing.mode;
    this.layoutTouchSurface();
  }

  /**
   * Put the touch lane columns exactly where the projected lanes are, starting below the HUD's
   * text block so reaching for the score cannot trigger a note.
   */
  private layoutTouchSurface(): void {
    const fallback = this.framing.usable.top + 44;
    const topPx = Math.max(this.framing.usable.top, this.hud.contentBottomPx(fallback)) + 6;
    this.touchSurface.layoutForFraming(this.framing, topPx, this.viewportWidth, this.viewportHeight);
  }

  /** True when lane columns are active (touch-first device and a run in progress). */
  get touchControlsActive(): boolean {
    return this.touchSurface.isInteractive();
  }

  private applySettings(settings: GameSettings): void {
    const paletteChanged = settings.lanePalette !== this.settingsCache.lanePalette;
    this.settingsCache = settings;
    this.engine.setGlobalOffsetMs(settings.globalOffsetMs);
    this.audio.setVolume(settings.volume);
    if (paletteChanged) this.applyLanePalette(settings.lanePalette);
  }

  /**
   * Point every view at a lane palette.
   *
   * Every lane colour in the game comes from one definition (`LANE_PALETTES` in
   * `renderer/Layout`), so "switch theme" is a handful of rebuilds: the highway strips and
   * receptors, the note/hold instance colours, the HUD key strip and the touch pads. Called once at
   * boot and whenever the settings change, never mid-song by itself.
   */
  private applyLanePalette(paletteId: string): void {
    setActiveLanePalette(paletteId);
    this.laneRenderer.setPalette(paletteId);
    this.noteRenderer.setPalette(paletteId);
    this.hud.setPalette(paletteId);
    this.touchSurface.setPalette(paletteId);
  }

  private updateSongInfo(): void {
    setText(el('hud-song-title'), this.chartValue.title);
    setText(el('hud-song-sub'), this.songSubtitle);
  }

  private describeDemoChart(): string {
    const bars = SECTIONS.verse.chart.length;
    return (
      `hard · 7 keys · ${DEMO_BPM} BPM · ${this.demoChart.notes.length} notes · ` +
      `hand-authored demo chart (${bars}-bar loops)`
    );
  }

  private describeChart(chart: Beatmap, source: 'demo' | 'import' | 'library', saved: boolean): string {
    if (source === 'demo') return this.describeDemoChart();
    const origin = source === 'library' ? 'saved chart' : saved ? 'generated from your MP3, saved' : 'generated from your MP3';
    const lanes = lanesOf(chart);
    return (
      `${chart.difficulty} · ${lanes} keys · ×${difficultyProfile(this.difficultyValue).scoreWeight.toFixed(1)} · ` +
      `${chart.bpm.toFixed(2)} BPM · ${chart.notes.length} notes · ${origin}`
    );
  }

  private fail(error: unknown): void {
    this.stateValue = 'error';
    this.input.setEnabled(false);
    const message = error instanceof Error ? error.message : String(error);
    this.overlay.setError(`Something went wrong: ${message}`);
  }

  // ------------------------------------------------------------------ debug --

  /**
   * Structured snapshot for the browser console and the verification hooks.
   */
  debugState(): Record<string, unknown> {
    const snapshot = this.engine.scoreSnapshot;
    const songTimeMs = this.audio.getSongTimeMs();
    return {
      state: this.stateValue,
      song: {
        id: this.chartValue.songId,
        title: this.chartValue.title,
        source: this.songSource,
        bpm: this.chartValue.bpm,
        beatMs: this.beatMs,
        notes: this.chartValue.notes.length,
        difficulty: this.chartValue.difficulty,
        laneCount: lanesOf(this.chartValue),
        keyLabels: this.chartValue.keyLabels ?? keyLabelsFor(lanesOf(this.chartValue)),
        maxScore: this.chartValue.maxScore ?? null,
        generator: this.chartValue.generator,
      },
      /** Difficulty switching: what the current song has, and which one is loaded. */
      difficulties: {
        current: this.difficultyValue,
        available: availableDifficulties(this.chartSetValue),
        visible: availableDifficulties(this.chartSetValue),
        charts: Object.fromEntries(
          availableDifficulties(this.chartSetValue).map((difficulty) => {
            const entry = this.chartSetValue.charts[difficulty]!;
            return [
              difficulty,
              {
                lanes: lanesOf(entry.chart),
                notes: entry.chart.notes.length,
                notesPerSecond: entry.stats.notesPerSecond,
                maxScore: entry.chart.maxScore ?? null,
                scoreWeight: entry.profile.scoreWeight,
                valid: entry.validation.ok,
              },
            ];
          }),
        ),
        best: this.bestScore
          ? { score: this.bestScore.score, accuracy: this.bestScore.accuracy, grade: this.bestScore.grade }
          : null,
      },
      library: {
        available: this.library !== null,
        persistent: this.library?.persistent ?? false,
        degraded: this.libraryDegradedReason,
      },
      // The audio buffer is dropped from the snapshot: `debugState()` is meant to be readable in a
      // console and serialisable, and a multi-megabyte AudioBuffer is neither.
      diagnostics: diagnosticsSnapshot(this.diagnosticsPanel.current),
      diagnosticsPreview: this.diagnosticsPanel.previewState,
      phase: this.engine.phase,
      pausedByFocus: this.pausedByFocus,
      pausedForOrientation: this.pausedForOrientation,
      songTimeMs,
      chartTimeMs: songTimeMs - this.chart.offsetMs,
      durationMs: this.durationMs,
      notes: { total: this.engine.totalNotes, pending: this.engine.pendingNotes },
      score: snapshot.score,
      combo: snapshot.combo,
      maxCombo: snapshot.maxCombo,
      accuracy: snapshot.accuracy,
      counts: snapshot.counts,
      holds: { completed: snapshot.holdCompleted, broken: snapshot.holdBroken, interrupted: snapshot.interruptedHolds },
      strayPresses: snapshot.strayPresses,
      settings: this.settingsCache,
      device: this.deviceProfileDebug(),
      framing: this.framingDebug(),
      touch: {
        interactive: this.touchSurface.isInteractive(),
        activePointers: this.input.activePointers,
        pointersOnLanes: this.input.pointersOnLanes,
        zones: this.touchSurface.zoneRects(),
      },
      renderer: {
        ...this.scene.stats,
        noteCaps: this.noteRenderer.drawnCaps,
        noteBodies: this.noteRenderer.drawnBodies,
        culledFrom: this.noteRenderer.culledFrom,
        effects: this.effectRenderer.activeCount,
      },
      audio: this.audio.metrics(),
    };
  }

  private deviceProfileDebug(): Record<string, unknown> {
    return {
      touchLayout: this.deviceProfile.touchLayout,
      coarsePointer: this.deviceProfile.coarsePointer,
      maxTouchPoints: this.deviceProfile.maxTouchPoints,
      forced: this.deviceProfile.forced,
      safeInsets: this.deviceProfile.safeInsets,
      portrait: this.orientationGate.portrait,
      rotateOverlay: this.orientationGate.showingOverlay,
      fullscreen: this.orientationGate.fullscreen,
      lastImmersive: this.orientationGate.lastImmersive,
    };
  }

  private framingDebug(): Record<string, unknown> {
    return {
      mode: this.framing.mode,
      clamped: this.framing.clamped,
      camera: this.framing.camera,
      usable: this.framing.usable,
      laneCentersPx: this.framing.laneCentersPx,
      laneWidthPx: this.framing.laneWidthPx,
      hitLineYPx: this.framing.hitLineYPx,
      hitLineDepth: this.framing.hitLineDepth,
      visibleLeadMs: this.framing.visibleLeadMs,
      visualLeadMs: this.visualLeadMs,
      viewport: { width: this.viewportWidth, height: this.viewportHeight },
    };
  }

}

/** localStorage can throw on access in private mode; the gate then simply never nags. */
function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
