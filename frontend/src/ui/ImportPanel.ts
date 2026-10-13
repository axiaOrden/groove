/**
 * Import panel — the import workflow, in the order the brief asks for it:
 *
 *   1. pick a file → 2. decode → 3. analyse (progress) → 4. show the analysis →
 *   5. choose a difficulty → 6. play it → 7. save it locally.
 *
 * The panel owns no analysis or chart logic: it calls `importSongFile` (which is DOM-free and
 * tested in Node) and renders the result. Everything that can fail — an unreadable file, a
 * browser that cannot decode it, a song with no detectable pulse, a chart that fails validation,
 * a full private-mode database — surfaces as a readable message in `#import-error` rather than a
 * thrown exception or a silent no-op.
 *
 * Phase 3 changed step 5 from "press play" to "pick a difficulty". The selector is built from the
 * chart set the import produced, so what each card shows (lane count, note count, notes per second,
 * score weight, theoretical maximum, best score) is read from the chart that will actually be
 * loaded — not from a table of claims about it. Selecting a card starts that chart at that lane
 * count; nothing is re-analysed, and no lane is hidden to simulate a lower difficulty.
 *
 * A song saved before phase 3 has only a Hard chart (see `storage/SongRecord.ts`). Its cards for
 * Easy and Normal are shown as **unavailable with an explicit offer to regenerate**: importing
 * again, or re-running the analysis from the stored audio, is the only way to get those two charts
 * that is honest about where they come from. That path lives here (`regenerateSong`) and is the
 * "safe regeneration" the brief asks for.
 */

import type { AnalysisClient } from '../analysis/AnalysisClient';
import type { Beatmap } from '../chart/ChartTypes';
import { prepareBeatmap } from '../chart/ChartValidator';
import { CHART_DIFFICULTIES, difficultyProfile, isChartDifficulty, type ChartDifficulty } from '../chart/Difficulty';
import {
  availableDifficulties,
  difficultySummary,
  generateChartSet,
  primaryChart,
  type ChartSet,
  type DifficultyChart,
} from '../chart/DifficultySet';
import { formatPercent } from './dom';
import type { SongStore, SongSummary } from '../storage/SongLibrary';
import { chartOf, chartSetOf, primaryChartOf, type SongRecord } from '../storage/SongRecord';
import type { ScoreEntry } from '../storage/ScoreStore';
import { decodeAudioBlob, describeFile, formatBytes, formatDuration, ImportError } from '../import/MusicImport';
import { canTranscodeToOgg } from '../import/ImportFlow';
import { estimateOggBytes } from '../import/OggExport';
import { importSongFile, type ImportOutcome, type ImportProgress } from '../import/ImportFlow';
import type { EnergyProfile } from '../analysis/types';
import { gridBeats } from '../analysis/TempoEstimator';
import { buildDiagnostics, type DiagnosticsData } from './DiagnosticsPanel';
import { el, setHidden, setText } from './dom';

export interface PlayableSong {
  /** Every difficulty this song has, so the pause menu can switch without reloading. */
  set: ChartSet;
  /** Difficulty to open on. */
  difficulty: ChartDifficulty;
  buffer: AudioBuffer;
  record: SongRecord | null;
  diagnostics: DiagnosticsData | null;
  /** True when the record came from the library rather than a fresh import. */
  fromLibrary: boolean;
  /** Where the song came from, for the HUD subtitle and the debug state. */
  source?: 'demo' | 'import' | 'library';
}

export interface ImportPanelDeps {
  client: AnalysisClient;
  store: SongStore;
  /** Called from a user gesture, so the AudioContext may be created/resumed here. */
  getContext: () => Promise<BaseAudioContext>;
  onPlay(song: PlayableSong): void;
  onDiagnostics(data: DiagnosticsData): void;
  onBack(): void;
}

const STAGE_LABELS: Record<ImportProgress['stage'], string> = {
  validating: 'checking the file',
  decoding: 'decoding audio',
  analyzing: 'analysing music',
  generating: 'generating the charts',
  transcoding: 'converting to OGG',
  saving: 'saving',
  done: 'done',
};

export class ImportPanel {
  private readonly fileInput = el<HTMLInputElement>('import-file');
  private readonly dropZone = el('import-drop');
  private readonly fileName = el('import-file-name');
  private readonly titleInput = el<HTMLInputElement>('import-title');
  private readonly seedInput = el<HTMLInputElement>('import-seed');
  private readonly saveInput = el<HTMLInputElement>('import-save');
  private readonly oggInput = el<HTMLInputElement>('import-ogg');
  private readonly oggHint = el('import-ogg-hint');
  private readonly progressWrap = el('import-progress-wrap');
  private readonly errorBox = el('import-error');
  private readonly results = el('import-results');
  private readonly analyzedTitle = el('import-analyzed-title');
  private readonly warnings = el('import-warnings');
  private readonly difficultyOptions = el('difficulty-options');
  private readonly difficultyNote = el('difficulty-note');
  private readonly libraryList = el('library-list');
  private readonly libraryNote = el('library-note');

  private outcome: ImportOutcome | null = null;
  /** Set when the results section is showing a stored song rather than a fresh import. */
  private storedSet: ChartSet | null = null;
  private storedRecord: SongRecord | null = null;
  private busy = false;
  private oggAvailable: boolean | null = null;

  constructor(private readonly deps: ImportPanelDeps) {
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      if (file) void this.importFile(file);
    });
    this.dropZone.addEventListener('dragover', (event) => {
      event.preventDefault();
      this.dropZone.classList.add('dragging');
    });
    this.dropZone.addEventListener('dragleave', () => this.dropZone.classList.remove('dragging'));
    this.dropZone.addEventListener('drop', (event) => {
      event.preventDefault();
      this.dropZone.classList.remove('dragging');
      const file = event.dataTransfer?.files?.[0];
      if (file) void this.importFile(file);
    });
    el('btn-import-play').addEventListener('click', () => void this.playImported());
    el('btn-import-back').addEventListener('click', () => this.deps.onBack());
    el('btn-diagnostics').addEventListener('click', () => this.emitDiagnostics());
    el('import-ogg').addEventListener('change', () => void this.refreshOggHint());
    // One delegated listener for the whole difficulty grid: the cards are re-rendered per song, so
    // binding per card would leak listeners across imports.
    this.difficultyOptions.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest('button[data-difficulty]') as HTMLButtonElement | null;
      if (!button) return;
      const difficulty = button.dataset.difficulty ?? '';
      if (!isChartDifficulty(difficulty)) return;
      if (button.dataset.action === 'regenerate') void this.regenerateStored(difficulty);
      else void this.playDifficulty(difficulty);
    });
    this.libraryList.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest('button[data-action]') as HTMLButtonElement | null;
      const row = target?.closest('[data-song-id]') as HTMLElement | null;
      if (!button || !row) return;
      const id = row.dataset.songId ?? '';
      if (button.dataset.action === 'play') {
        const difficulty = button.dataset.difficulty ?? '';
        void this.playFromLibrary(id, isChartDifficulty(difficulty) ? difficulty : undefined);
      }
      if (button.dataset.action === 'regenerate') {
        const difficulty = button.dataset.difficulty ?? '';
        if (isChartDifficulty(difficulty)) void this.regenerateFromLibrary(id, difficulty);
      }
      if (button.dataset.action === 'diagnostics') void this.showLibraryDiagnostics(id);
      if (button.dataset.action === 'delete') void this.deleteFromLibrary(id);
    });
    this.seedInput.addEventListener('input', () => {
      if (this.outcome) {
        // A different seed is a different chart: the preview must not claim otherwise.
        setText(this.analyzedTitle, `${this.outcome.record.title} (press Import again to regenerate)`);
      }
    });
  }

  /** Show the panel and refresh the library list. */
  async open(): Promise<void> {
    this.setError(null);
    setHidden(this.results, this.outcome === null);
    this.libraryNote.hidden = this.deps.store.persistent === false;
    setText(this.libraryNote, this.deps.store.persistent ? '' : 'Storage is session-only here; songs will not survive a reload.');
    await this.refreshLibrary();
    void this.refreshOggHint();
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** The current import result, if any (used by the app to enable "play"). */
  get lastOutcome(): ImportOutcome | null {
    return this.outcome;
  }

  async importFile(file: File): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.setError(null);
    setHidden(this.results, true);
    setHidden(this.progressWrap, false);
    setText(this.fileName, `${file.name} · ${formatBytes(file.size)}`);
    setProgress({ stage: 'validating', ratio: 0, detail: 'checking the file' });
    el('btn-import-play').setAttribute('disabled', 'true');

    try {
      const context = await this.deps.getContext();
      const outcome = await importSongFile({
        file,
        context,
        client: this.deps.client,
        seed: clampSeed(Number(this.seedInput.value)),
        ...(this.titleInput.value.trim() ? { title: this.titleInput.value.trim() } : {}),
        save: this.saveInput.checked,
        store: this.deps.store,
        transcodeToOgg: this.oggInput.checked,
        onProgress: (progress) => setProgress(progress),
      });
      this.outcome = outcome;
      this.storedSet = null;
      this.storedRecord = null;
      this.renderOutcome(outcome);
      await this.refreshLibrary();
      this.emitDiagnostics(outcome);
    } catch (error) {
      this.outcome = null;
      this.setError(describeError(error));
      setProgress({ stage: 'done', ratio: 0, detail: 'failed' });
    } finally {
      this.busy = false;
      el('btn-import-play').removeAttribute('disabled');
    }
  }

  /** "Play this chart" — the card selected last, defaulting to the workflow's opening difficulty. */
  private async playImported(): Promise<void> {
    const outcome = this.outcome;
    if (!outcome) {
      this.setError('Import a song first.');
      return;
    }
    const opening = primaryChart(outcome.set, outcome.set.charts.hard ? 'hard' : undefined);
    if (opening === null) {
      this.setError('This song has no playable chart.');
      return;
    }
    let chart: Beatmap;
    try {
      chart = prepareBeatmap(opening.chart);
    } catch (error) {
      this.setError(describeError(error));
      return;
    }
    this.deps.onPlay({
      set: { ...outcome.set, charts: { ...outcome.set.charts, [opening.difficulty]: { ...outcome.set.charts[opening.difficulty]!, chart } } },
      difficulty: opening.difficulty,
      buffer: outcome.buffer,
      record: outcome.record,
      fromLibrary: false,
      source: 'import',
      diagnostics: buildDiagnostics({
        source: outcome.record.title,
        analysis: outcome.analysis,
        chart,
        stats: outcome.set.charts[opening.difficulty]!.stats,
        validation: outcome.set.charts[opening.difficulty]!.validation,
        chartWarnings: outcome.warnings,
        audio: outcome.buffer,
      }),
    });
  }

  /** Play one difficulty from the results section (a card in `#difficulty-options`). */
  private async playDifficulty(difficulty: ChartDifficulty): Promise<void> {
    const record = this.storedRecord;
    const set = this.storedSet ?? this.outcome?.set ?? null;
    if (set === null) return;
    const chart = set.charts[difficulty]?.chart;
    if (!chart) {
      this.setError('That difficulty is not available for this song.');
      return;
    }
    if (this.outcome && record === null) {
      // A fresh import still holds its decoded buffer, so playing needs no database round trip.
      this.deps.onPlay({
        set,
        difficulty,
        buffer: this.outcome.buffer,
        record: this.outcome.record,
        fromLibrary: false,
        source: 'import',
        diagnostics: this.diagnosticsFor(this.outcome.record.title, set, difficulty, this.outcome.analysis, this.outcome.buffer, this.outcome.warnings),
      });
      return;
    }
    if (record === null) return;
    await this.playStored(record, difficulty, null);
  }

  async playFromLibrary(id: string, difficulty?: ChartDifficulty): Promise<void> {
    if (this.busy) return;
    this.setError(null);
    this.busy = true;
    try {
      const loaded = await this.deps.store.load(id);
      if (!loaded) {
        this.setError('That song is no longer in the library.');
        return;
      }
      if (!loaded.audio) {
        this.setError(
          `“${loaded.record.title}” was saved without its audio, so it cannot be played. Import the file again to play it.`,
        );
        return;
      }
      this.renderStoredSummary(loaded.record);
      this.deps.onDiagnostics(this.diagnosticsForRecord(loaded.record, loaded.audio, difficulty));
      await this.playStored(loaded.record, difficulty, loaded.audio);
    } catch (error) {
      this.setError(describeError(error));
    } finally {
      this.busy = false;
    }
  }

  /** Decode the stored audio and hand the chosen chart to the game. */
  private async playStored(record: SongRecord, difficulty?: ChartDifficulty, blobHint?: Blob | null): Promise<void> {
    const wanted = difficulty ?? primaryChartOf(record).difficulty;
    const info = record.charts[wanted];
    if (!info) {
      this.setError(
        `“${record.title}” has no ${wanted} chart. It was saved before phase 3 — use “Regenerate ${wanted}” to build ` +
          'it from the stored audio (this re-analyses the song once).',
      );
      return;
    }
    const blob = blobHint ?? (await this.deps.store.load(record.id))?.audio ?? null;
    if (!blob) {
      this.setError(
        `“${record.title}” was saved without its audio, so it cannot be played. Import the file again to play it.`,
      );
      return;
    }
    const context = await this.deps.getContext();
    const buffer = await decodeAudioBlob(blob, context);
    const set = chartSetOf(record, record.analysis.warnings);
    this.deps.onPlay({
      set,
      difficulty: wanted,
      buffer,
      record,
      fromLibrary: true,
      source: 'library',
      diagnostics: this.diagnosticsForRecord(record, blob, wanted),
    });
  }

  /**
   * Reopen the diagnostics for a song that is already saved.
   *
   * No analysis is repeated: the record holds the tempo, the grid numbers, the measured alignment
   * and every chart, so the report and the timeline can be rebuilt from the database alone. The
   * audio is only decoded when the song was stored with its bytes, and even then it is decoded for
   * the section preview, never re-analysed.
   */
  async showLibraryDiagnostics(id: string): Promise<void> {
    this.setError(null);
    try {
      const loaded = await this.deps.store.load(id);
      if (!loaded) {
        this.setError('That song is no longer in the library.');
        return;
      }
      // The report has to be *visible*: this panel's results section is where the diagnostics live,
      // and for a song reopened from the library no import happened in this session.
      this.renderStoredSummary(loaded.record);
      this.deps.onDiagnostics(this.diagnosticsForRecord(loaded.record, loaded.audio));
    } catch (error) {
      this.setError(describeError(error));
    }
  }

  /**
   * Build a missing difficulty from the stored audio.
   *
   * This is the migration path for a phase-2 record (Hard only). It re-runs the analysis **once**
   * on the stored bytes and regenerates the *whole* set, then saves the upgraded record — so the
   * next time the song opens there is no work to do at all. The panel says so before and after,
   * because "this will take a few seconds and re-analyse the song" is something the player deserves
   * to be told.
   */
  private async regenerateStored(difficulty: ChartDifficulty): Promise<void> {
    const record = this.storedRecord ?? this.outcome?.record ?? null;
    if (record === null) return;
    await this.regenerate(record, difficulty);
  }

  private async regenerateFromLibrary(id: string, difficulty: ChartDifficulty): Promise<void> {
    if (this.busy) return;
    const loaded = await this.deps.store.load(id);
    if (!loaded) {
      this.setError('That song is no longer in the library.');
      return;
    }
    await this.regenerate(loaded.record, difficulty);
  }

  private async regenerate(record: SongRecord, difficulty: ChartDifficulty): Promise<void> {
    if (this.busy) return;
    const blob = (await this.deps.store.load(record.id))?.audio ?? null;
    if (!blob) {
      this.setError(
        `“${record.title}” was saved without its audio, so its ${difficulty} chart cannot be rebuilt. Import the file again.`,
      );
      return;
    }
    this.busy = true;
    this.setError(null);
    setHidden(this.progressWrap, false);
    setText(this.fileName, `${record.title} · rebuilding ${difficulty}`);
    setProgress({ stage: 'analyzing', ratio: 0.05, detail: 're-analysing the stored audio' });
    try {
      const context = await this.deps.getContext();
      const buffer = await decodeAudioBlob(blob, context);
      const channels: Float32Array[] = [];
      for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
        // Copies, not views: the worker transport detaches whatever it is given (see MusicImport).
        channels.push(Float32Array.from(buffer.getChannelData(channel)));
      }
      setProgress({ stage: 'analyzing', ratio: 0.2, detail: 'analysing music' });
      const { result: analysis } = await this.deps.client.analyze({
        sampleRate: buffer.sampleRate,
        channels,
        onProgress: (progress) =>
          setProgress({ stage: 'analyzing', ratio: 0.2 + progress.ratio * 0.6, detail: progress.detail ?? 'analysing' }),
      });
      setProgress({ stage: 'generating', ratio: 0.85, detail: 'generating charts' });
      const seed = record.charts.hard?.generator.seed ?? 1;
      const set = generateChartSet(analysis, {
        seed,
        songId: record.id,
        title: record.title,
        ...(record.artist ? { artist: record.artist } : {}),
        charter: 'automatic analysis (phase 3, regenerated)',
        durationMs: analysis.durationMs,
      });
      const primary = primaryChart(set);
      if (primary === null) throw new Error('the regenerated chart set is empty');
      const updated: SongRecord = {
        ...record,
        recordVersion: 2,
        bpm: analysis.bpm,
        beatMs: analysis.beatMs,
        firstBeatMs: analysis.firstBeatMs,
        beatConfidence: analysis.beatConfidence,
        durationMs: Math.round(analysis.durationMs * 1000) / 1000,
        analysis: {
          version: analysis.version,
          analysisMs: analysis.analysisMs,
          framesAnalyzed: analysis.framesAnalyzed,
          hopMs: analysis.hopMs,
          onsetCount: analysis.onsets.length,
          beatCount: analysis.beats.length,
          lowEnergySections: analysis.energy.lowEnergyRanges.length,
          warnings: [...analysis.warnings],
          tempoCandidates: [...analysis.tempoCandidates],
          beatAlignRatio: analysis.beatAlignRatio,
          beatAlignChance: analysis.beatAlignChance,
          gridCoverage: analysis.gridCoverage,
          gridExcess: analysis.gridExcess,
          barPhase: { ...analysis.barPhase, scores: [...analysis.barPhase.scores] },
          sections: analysis.sections.map((section) => ({ ...section })),
          lowConfidenceRanges: analysis.lowConfidenceRanges.map((range) => ({ ...range })),
        },
        charts: Object.fromEntries(
          CHART_DIFFICULTIES.filter((entry) => set.charts[entry] !== undefined).map((entry) => [
            entry,
            chartInfoOf(set.charts[entry]!),
          ]),
        ) as SongRecord['charts'],
        updatedAt: new Date().toISOString(),
      };
      await this.deps.store.save(updated, { id: record.id, blob, mimeType: record.audio.mimeType });
      setProgress({ stage: 'done', ratio: 1, detail: `saved — ${difficulty} is ready` });
      setText(this.fileName, `${record.title} · ${formatBytes(blob.size)}`);
      await this.refreshLibrary();
      this.renderStoredSummary(updated);
    } catch (error) {
      this.setError(`Could not rebuild the ${difficulty} chart: ${describeError(error)}`);
      setProgress({ stage: 'done', ratio: 0, detail: 'failed' });
    } finally {
      this.busy = false;
    }
  }

  async deleteFromLibrary(id: string): Promise<void> {
    try {
      await this.deps.store.remove(id);
      await this.refreshLibrary();
    } catch (error) {
      this.setError(describeError(error));
    }
  }

  async refreshLibrary(): Promise<void> {
    let summaries: SongSummary[] = [];
    try {
      summaries = await this.deps.store.list();
    } catch (error) {
      this.libraryList.innerHTML = `<span class="fine">${describeError(error)}</span>`;
      return;
    }
    if (summaries.length === 0) {
      this.libraryList.innerHTML = '<span class="fine">Nothing saved yet. Imported songs appear here.</span>';
      return;
    }
    const rows = await Promise.all(summaries.map((summary) => this.renderLibraryRow(summary)));
    this.libraryList.innerHTML = rows.join('');
  }

  /** One library row: title, numbers, and a play button per available difficulty. */
  private async renderLibraryRow(summary: SongSummary): Promise<string> {
    const format = summary.audio.transcoded ? 'OGG (converted)' : summary.audio.format.toUpperCase();
    const audio = summary.audio.stored ? `${format} · ${formatBytes(summary.audio.bytes)}` : 'audio not stored';
    const flag = summary.validationOk ? '' : ' <span class="warn-tag">chart failed validation</span>';
    const buttons: string[] = [];
    for (const entry of summary.charts) {
      const best = await this.safeBest(summary.id, entry.difficulty);
      const label = `${entry.difficulty} ${entry.laneCount}K`;
      const title = `${entry.noteCount} notes · ${entry.notesPerSecond.toFixed(2)}/s · max ${entry.maxScore.toLocaleString('en-US')}${
        best ? ` · best ${best.score.toLocaleString('en-US')}` : ''
      }`;
      buttons.push(
        `<button type="button" class="btn btn-small" data-action="play" data-difficulty="${entry.difficulty}" ` +
          `title="${escapeHtml(title)}"${summary.audio.stored ? '' : ' disabled'}>${escapeHtml(label)}</button>`,
      );
    }
    // Missing difficulties are offered as a *regeneration*, never as a hidden-lane imitation.
    for (const difficulty of CHART_DIFFICULTIES) {
      if (summary.difficulties.includes(difficulty)) continue;
      buttons.push(
        `<button type="button" class="btn btn-ghost btn-small" data-action="regenerate" data-difficulty="${difficulty}" ` +
          `title="Build the ${difficulty} chart from the stored audio (re-analyses this song once)"` +
          `${summary.audio.stored ? '' : ' disabled'}>+ ${difficulty}</button>`,
      );
    }
    buttons.push('<button type="button" class="btn btn-ghost btn-small" data-action="diagnostics">Diagnostics</button>');
    buttons.push('<button type="button" class="btn btn-ghost btn-small" data-action="delete">Delete</button>');
    return (
      `<div class="library-row" data-song-id="${escapeHtml(summary.id)}">` +
      `<div class="library-info"><strong>${escapeHtml(summary.title)}</strong>` +
      `<span>${formatDuration(summary.durationMs)} · ${summary.bpm.toFixed(1)} BPM · ${audio}${flag}</span></div>` +
      `<div class="library-actions">${buttons.join('')}</div></div>`
    );
  }

  private async safeBest(songId: string, difficulty: ChartDifficulty): Promise<ScoreEntry | null> {
    try {
      return await this.deps.store.scores.best(songId, difficulty);
    } catch {
      return null;
    }
  }

  private emitDiagnostics(outcome?: ImportOutcome): void {
    if (outcome) {
      const opening = primaryChart(outcome.set) ?? null;
      const entry = opening ? outcome.set.charts[opening.difficulty] : undefined;
      this.deps.onDiagnostics(
        buildDiagnostics({
          source: outcome.record.title,
          analysis: outcome.analysis,
          chart: entry?.chart ?? outcome.chart,
          stats: entry?.stats ?? outcome.stats,
          validation: entry?.validation ?? outcome.validation,
          chartWarnings: outcome.warnings,
          audio: outcome.buffer,
        }),
      );
      return;
    }
    if (this.outcome) this.emitDiagnostics(this.outcome);
  }

  private diagnosticsFor(
    source: string,
    set: ChartSet,
    difficulty: ChartDifficulty,
    analysis: ImportOutcome['analysis'] | null,
    audio: AudioBuffer | null,
    warnings: readonly string[],
  ): DiagnosticsData {
    const entry = set.charts[difficulty];
    return buildDiagnostics({
      source: `${source} · ${difficulty}`,
      ...(analysis ? { analysis } : {}),
      chart: entry?.chart ?? set.charts[primaryChart(set)?.difficulty ?? difficulty]!.chart,
      ...(entry ? { stats: entry.stats, validation: entry.validation } : {}),
      chartWarnings: warnings,
      audio,
    });
  }

  /** Diagnostics for a stored song: numbers from the record, audio decoded only on demand. */
  private diagnosticsForRecord(record: SongRecord, blob: Blob | null, difficulty?: ChartDifficulty): DiagnosticsData {
    const primary = primaryChartOf(record);
    const wanted = difficulty && record.charts[difficulty] ? difficulty : primary.difficulty;
    const chart = chartOf(record, wanted);
    const info = record.charts[wanted]!;
    return buildDiagnostics({
      source: `${record.title} · ${wanted} (from the library, no re-analysis)`,
      analysis: storedAnalysisView(record),
      onsetsStored: false,
      chart,
      stats: info.stats,
      chartWarnings: record.analysis.warnings,
      // Decoded only when the player presses play in the preview: opening the report must be
      // instant even for a ten-minute song.
      ...(blob
        ? {
            loadAudio: async () => {
              const context = await this.deps.getContext();
              return decodeAudioBlob(blob, context);
            },
          }
        : {}),
    });
  }

  private renderOutcome(outcome: ImportOutcome): void {
    setProgress({ stage: 'done', ratio: 1, detail: outcome.saved ? 'saved to this device' : 'ready to play' });
    setHidden(this.results, false);
    setText(this.analyzedTitle, `· ${outcome.record.title}`);
    const opening = primaryChart(outcome.set) ?? null;
    const entry = opening ? outcome.set.charts[opening.difficulty] : undefined;
    this.renderStats({
      bpm: outcome.analysis.bpm,
      confidence: outcome.analysis.beatConfidence,
      alignment: outcome.analysis.beatAlignRatio,
      beatCount: outcome.analysis.beats.length,
      onsetCount: outcome.analysis.onsets.length,
      noteCount: entry?.stats.noteCount ?? 0,
      peakNotesPerSecond: entry?.stats.peakNotesPerSecond ?? 0,
      notesPerSecond: entry?.stats.notesPerSecond ?? 0,
      analysisMs: outcome.analysis.analysisMs,
      framesAnalyzed: outcome.analysis.framesAnalyzed,
    });
    this.renderDifficulties(outcome.record, outcome.set);

    // Only the non-diagnostic notice stays here: the analysis and chart warnings are listed inside
    // the diagnostics section, directly under the numbers they are about. Repeating them above it
    // just makes the panel noisier without adding information.
    const messages: string[] = [];
    if (outcome.ogg) {
      messages.push(
        `Converted to OGG Vorbis (${formatBytes(outcome.ogg.bytes)}) — the original is no longer the stored copy.`,
      );
    }
    const missing = CHART_DIFFICULTIES.filter((difficulty) => outcome.charts[difficulty] === undefined);
    if (missing.length > 0) {
      messages.push(`No chart was saved for: ${missing.join(', ')} (they failed validation on this track).`);
    }
    setHidden(this.warnings, messages.length === 0);
    this.warnings.textContent = messages.join('\n');
  }

  /**
   * Render the difficulty cards.
   *
   * Every number comes from the chart that will actually load, plus the stored best score for that
   * difficulty. Unavailable difficulties (a pre-phase-3 record) are rendered as an explicit offer to
   * regenerate rather than as a disabled control with no explanation.
   */
  private async renderDifficulties(record: SongRecord, set: ChartSet): Promise<void> {
    this.storedRecord = record;
    this.storedSet = set;
    const available = availableDifficulties(set);
    const cards: string[] = [];
    for (const difficulty of CHART_DIFFICULTIES) {
      const profile = difficultyProfile(difficulty);
      const summary = difficultySummary(set, difficulty);
      if (!summary) {
        cards.push(
          `<div class="difficulty-card" data-available="false" data-difficulty="${difficulty}">` +
            `<div class="difficulty-head"><strong>${escapeHtml(profile.title)}</strong><span class="difficulty-keys">${escapeHtml(
              profile.keys.map((key) => key.label).join(' '),
            )}</span></div>` +
            `<p class="difficulty-summary">No chart was generated for this difficulty.</p>` +
            `<div class="difficulty-actions">` +
            `<button type="button" class="btn btn-ghost btn-small" data-action="regenerate" data-difficulty="${difficulty}"${
              record.audio.stored ? '' : ' disabled'
            }>Regenerate from stored audio</button>` +
            `</div></div>`,
        );
        continue;
      }
      const best = await this.safeBest(record.id, difficulty);
      const bestLine = best
        ? `best ${best.score.toLocaleString('en-US')} · ${formatPercent(best.accuracy)} · ${best.grade}` +
          (best.difficultyWeight !== profile.scoreWeight ? ' (older weight)' : '')
        : 'no score yet';
      cards.push(
        `<div class="difficulty-card" data-available="${summary.valid ? 'true' : 'false'}" data-difficulty="${difficulty}">` +
          `<div class="difficulty-head"><strong>${escapeHtml(profile.title)}</strong><span class="difficulty-keys">${escapeHtml(
            profile.keys.map((key) => key.label).join(' '),
          )}</span></div>` +
          `<p class="difficulty-summary">${escapeHtml(profile.summary)}</p>` +
          `<dl class="difficulty-stats">` +
          `<div><dt>lanes</dt><dd>${summary.laneCount}</dd></div>` +
          `<div><dt>notes</dt><dd>${summary.noteCount.toLocaleString('en-US')}</dd></div>` +
          `<div><dt>notes / s</dt><dd>${summary.notesPerSecond.toFixed(2)}</dd></div>` +
          `<div><dt>score weight</dt><dd>×${summary.scoreWeight.toFixed(1)}</dd></div>` +
          `<div><dt>max score</dt><dd>${summary.maxScore.toLocaleString('en-US')}</dd></div>` +
          `</dl>` +
          `<div class="difficulty-best">${escapeHtml(bestLine)}</div>` +
          `<div class="difficulty-actions">` +
          `<button type="button" class="btn btn-primary btn-small" data-difficulty="${difficulty}"${
            summary.valid ? '' : ' disabled'
          }>Play</button>` +
          `</div></div>`,
      );
    }
    this.difficultyOptions.innerHTML = cards.join('');
    const missing = CHART_DIFFICULTIES.filter((difficulty) => !available.includes(difficulty));
    setHidden(this.difficultyNote, missing.length === 0);
    setText(
      this.difficultyNote,
      missing.length === 0
        ? ''
        : `This song only has a chart for: ${available.join(', ')}. “Regenerate” re-analyses the stored audio once ` +
          'and saves the missing difficulties (nothing is invented from the existing chart).',
    );
  }

  /** The summary grid, shared by a fresh import and a song reopened from the library. */
  private renderStats(stats: {
    bpm: number;
    confidence: number;
    alignment: number;
    beatCount: number;
    onsetCount: number;
    noteCount: number;
    peakNotesPerSecond: number;
    notesPerSecond: number;
    analysisMs: number;
    framesAnalyzed: number;
  }): void {
    const set = (id: string, value: string): void => setText(el(id), value);
    set('import-stat-bpm', stats.bpm.toFixed(2));
    set('import-stat-confidence', `${stats.confidence.toFixed(2)} · ${(stats.alignment * 100).toFixed(0)}% on beat`);
    set('import-stat-beats', stats.beatCount.toLocaleString());
    set('import-stat-onsets', stats.onsetCount > 0 ? stats.onsetCount.toLocaleString() : 'not stored');
    set('import-stat-notes', `${stats.noteCount.toLocaleString()} (${stats.peakNotesPerSecond}/s peak)`);
    set('import-stat-density', stats.notesPerSecond.toFixed(2));
    set('import-stat-analysis', `${stats.analysisMs} ms (${stats.framesAnalyzed.toLocaleString()} frames)`);
  }

  /** Summary for a stored song: the record holds every number except the onset list. */
  private renderStoredSummary(record: SongRecord): void {
    setHidden(this.progressWrap, true);
    setHidden(this.results, false);
    setText(this.analyzedTitle, `· ${record.title} (saved, no re-analysis)`);
    const primary = primaryChartOf(record);
    const info = record.charts[primary.difficulty]!;
    this.renderStats({
      bpm: record.bpm,
      confidence: record.beatConfidence,
      alignment: record.analysis.beatAlignRatio,
      beatCount: record.analysis.beatCount,
      onsetCount: 0,
      noteCount: info.noteCount || info.notes.length,
      peakNotesPerSecond: info.stats.peakNotesPerSecond,
      notesPerSecond:
        info.stats.notesPerSecond || (record.durationMs > 0 ? ((info.noteCount || info.notes.length) / record.durationMs) * 1000 : 0),
      analysisMs: record.analysis.analysisMs,
      framesAnalyzed: record.analysis.framesAnalyzed,
    });
    setHidden(this.warnings, true);
    void this.renderDifficulties(record, chartSetOf(record, record.analysis.warnings));
  }

  private async refreshOggHint(): Promise<void> {
    if (!this.oggInput.checked) {
      setText(
        this.oggHint,
        'Off by default: transcoding decodes and re-encodes the audio, which adds a second generation of loss and ' +
          'saves almost no space. The original file is kept when this is off.',
      );
      return;
    }
    if (this.oggAvailable === null) this.oggAvailable = await canTranscodeToOgg();
    if (!this.oggAvailable) {
      this.oggInput.checked = false;
      setText(
        this.oggHint,
        'This browser cannot load the WebAssembly Vorbis encoder, so OGG conversion is unavailable here. ' +
          'The original file will be stored instead.',
      );
      return;
    }
    const durationMs = this.outcome?.analysis.durationMs ?? 0;
    const estimate = durationMs > 0 ? `Estimated size ≈ ${formatBytes(estimateOggBytes(durationMs, 5))}. ` : '';
    setText(
      this.oggHint,
      `${estimate}True Vorbis (not Opus) via Wasm. This decodes and re-encodes, so it adds one more generation of ` +
        'lossy compression; the original MP3 is smaller per unit of quality. Use it only if you need the container.',
    );
  }

  setError(message: string | null): void {
    setHidden(this.errorBox, message === null);
    this.errorBox.textContent = message ?? '';
  }
}

function setProgress(progress: ImportProgress): void {
  setText(el('import-stage'), STAGE_LABELS[progress.stage] ?? progress.stage);
  setText(el('import-status'), progress.detail);
  el('import-progress').style.width = `${Math.min(1, Math.max(0, progress.ratio)) * 100}%`;
}

/**
 * Rebuild the analysis view a stored record can support.
 *
 * Everything the panel shows about the *grid* is in the record; two things are deliberately absent
 * because the record does not store them (see the module header of SongRecord.ts): the onset list
 * and the loudness curve. The beat list is reconstructed from the tempo, and the onset row of the
 * timeline comes out empty rather than wrong.
 */
function storedAnalysisView(record: SongRecord) {
  const info = record.analysis;
  const energy: EnergyProfile = {
    frameDb: [],
    frameMs: info.hopMs,
    peakDb: 0,
    meanDb: 0,
    floorDb: 0,
    activeRanges: [],
    lowEnergyRanges: [],
    intensityByBeat: [],
    onsetsPerSecond: [],
  };
  return {
    bpm: record.bpm,
    beatMs: record.beatMs,
    firstBeatMs: record.firstBeatMs,
    beatConfidence: record.beatConfidence,
    beatAlignRatio: info.beatAlignRatio,
    beatAlignChance: info.beatAlignChance,
    gridCoverage: info.gridCoverage,
    gridExcess: info.gridExcess,
    barPhase: info.barPhase,
    beats: gridBeats(record.beatMs, record.firstBeatMs, record.durationMs),
    onsets: [],
    tempoCandidates: info.tempoCandidates,
    warnings: info.warnings,
    analysisMs: info.analysisMs,
    framesAnalyzed: info.framesAnalyzed,
    hopMs: info.hopMs,
    durationMs: record.durationMs,
    energy,
    sections: info.sections,
    lowConfidenceRanges: info.lowConfidenceRanges,
  };
}

/**
 * Persisted info for a regenerated chart.
 *
 * `SongRecord.chartInfoOf` is the canonical converter (it is what `buildSongRecord` uses); this
 * thin wrapper only exists because the record's own helper is not exported — keeping one converter
 * is more important than avoiding the two lines below, so the shape is spelled out here exactly as
 * the storage layer writes it.
 */
function chartInfoOf(entry: DifficultyChart): NonNullable<SongRecord['charts'][ChartDifficulty]> {
  const laneCount = entry.chart.laneCount ?? 7;
  return {
    schemaVersion: entry.chart.schemaVersion,
    difficulty: entry.chart.difficulty,
    laneCount,
    keyLabels: entry.chart.keyLabels ?? difficultyProfile(entry.difficulty).keys.map((key) => key.label),
    generator: { ...entry.chart.generator },
    noteCount: entry.chart.notes.length,
    notes: entry.chart.notes.map((note) => ({ ...note })),
    stats: { ...entry.stats },
    maxScore: entry.chart.maxScore ?? 0,
    noteDensity: entry.chart.noteDensity ?? entry.stats.notesPerSecond,
    validation: {
      ok: entry.validation.ok,
      errors: entry.validation.errors.map((issue) => `${issue.code}: ${issue.message}`),
      warnings: entry.validation.warnings.map((issue) => `${issue.code}: ${issue.message}`),
    },
  };
}

function clampSeed(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.max(1, Math.min(999999, Math.round(value)));
}

function describeError(error: unknown): string {
  if (error instanceof ImportError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
