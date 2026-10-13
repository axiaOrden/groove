/**
 * Import panel — the phase 2 workflow, in the order the brief asks for it:
 *
 *   1. pick a file → 2. decode → 3. analyse (progress) → 4. show the analysis →
 *   5. generate + preview the count → 6. play it → 7. save it locally.
 *
 * The panel owns no analysis or chart logic: it calls `importSongFile` (which is DOM-free and
 * tested in Node) and renders the result. Everything that can fail — an unreadable file, a
 * browser that cannot decode it, a song with no detectable pulse, a chart that fails validation,
 * a full private-mode database — surfaces as a readable message in `#import-error` rather than a
 * thrown exception or a silent no-op.
 */

import type { AnalysisClient } from '../analysis/AnalysisClient';
import type { Beatmap } from '../chart/ChartTypes';
import { prepareBeatmap } from '../chart/ChartValidator';
import type { SongStore, SongSummary } from '../storage/SongLibrary';
import { chartOf, type SongRecord } from '../storage/SongRecord';
import { decodeAudioBlob, formatBytes, formatDuration, ImportError } from '../import/MusicImport';
import { canTranscodeToOgg } from '../import/ImportFlow';
import { estimateOggBytes } from '../import/OggExport';
import { importSongFile, type ImportOutcome, type ImportProgress } from '../import/ImportFlow';
import type { EnergyProfile } from '../analysis/types';
import { gridBeats } from '../analysis/TempoEstimator';
import { buildDiagnostics, type DiagnosticsData } from './DiagnosticsPanel';
import { el, setHidden, setText } from './dom';

export interface PlayableSong {
  chart: Beatmap;
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
  generating: 'generating the chart',
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
  private readonly libraryList = el('library-list');
  private readonly libraryNote = el('library-note');

  private outcome: ImportOutcome | null = null;
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
    this.libraryList.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest('button[data-action]') as HTMLButtonElement | null;
      const row = target?.closest('[data-song-id]') as HTMLElement | null;
      if (!button || !row) return;
      const id = row.dataset.songId ?? '';
      if (button.dataset.action === 'play') void this.playFromLibrary(id);
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

  async playFromLibrary(id: string): Promise<void> {
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
      const context = await this.deps.getContext();
      const buffer = await decodeAudioBlob(loaded.audio, context);
      const chart = chartOf(loaded.record);
      this.deps.onPlay({
        chart,
        buffer,
        record: loaded.record,
        fromLibrary: true,
        source: 'library',
        diagnostics: buildDiagnostics({
          source: `${loaded.record.title} (from the library, no re-analysis)`,
          chart,
          stats: loaded.record.chart.stats,
          chartWarnings: loaded.record.analysis.warnings,
        }),
      });
    } catch (error) {
      this.setError(describeError(error));
    } finally {
      this.busy = false;
    }
  }

  /**
   * Reopen the diagnostics for a song that is already saved.
   *
   * No analysis is repeated: the record holds the tempo, the grid numbers, the measured alignment
   * and the chart, so the report and the timeline can be rebuilt from the database alone. The audio
   * is only decoded when the song was stored with its bytes, and even then it is decoded for the
   * section preview, never re-analysed.
   */
  async showLibraryDiagnostics(id: string): Promise<void> {
    this.setError(null);
    try {
      const loaded = await this.deps.store.load(id);
      if (!loaded) {
        this.setError('That song is no longer in the library.');
        return;
      }
      const chart = chartOf(loaded.record);
      const blob = loaded.audio;
      // The report has to be *visible*: this panel's results section is where the diagnostics live,
      // and for a song reopened from the library no import happened in this session.
      this.renderStoredSummary(loaded.record, chart);
      this.deps.onDiagnostics(
        buildDiagnostics({
          source: `${loaded.record.title} (from the library, no re-analysis)`,
          analysis: storedAnalysisView(loaded.record),
          onsetsStored: false,
          chart,
          stats: loaded.record.chart.stats,
          chartWarnings: loaded.record.analysis.warnings,
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
        }),
      );
    } catch (error) {
      this.setError(describeError(error));
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
    this.libraryList.innerHTML = summaries
      .map((summary) => {
        const format = summary.audio.transcoded ? 'OGG (converted)' : summary.audio.format.toUpperCase();
        const audio = summary.audio.stored ? `${format} · ${formatBytes(summary.audio.bytes)}` : 'audio not stored';
        const flag = summary.validationOk ? '' : ' <span class="warn-tag">chart failed validation</span>';
        return (
          `<div class="library-row" data-song-id="${escapeHtml(summary.id)}">` +
          `<div class="library-info"><strong>${escapeHtml(summary.title)}</strong>` +
          `<span>${formatDuration(summary.durationMs)} · ${summary.bpm.toFixed(1)} BPM · ${summary.noteCount} notes · ${audio}${flag}</span></div>` +
          `<div class="library-actions">` +
          `<button type="button" class="btn btn-small" data-action="play"${summary.audio.stored ? '' : ' disabled'}>Play</button>` +
          `<button type="button" class="btn btn-ghost btn-small" data-action="diagnostics">Diagnostics</button>` +
          `<button type="button" class="btn btn-ghost btn-small" data-action="delete">Delete</button>` +
          '</div></div>'
        );
      })
      .join('');
  }

  private playImported(): void {
    const outcome = this.outcome;
    if (!outcome) {
      this.setError('Import a song first.');
      return;
    }
    let chart: Beatmap;
    try {
      chart = prepareBeatmap(outcome.chart);
    } catch (error) {
      this.setError(describeError(error));
      return;
    }
    this.deps.onPlay({
      chart,
      buffer: outcome.buffer,
      record: outcome.record,
      fromLibrary: false,
      source: 'import',
      diagnostics: buildDiagnostics({
        source: outcome.record.title,
        analysis: outcome.analysis,
        chart,
        stats: outcome.stats,
        validation: outcome.validation,
        chartWarnings: outcome.warnings.filter((warning) => warning.startsWith('no ') || warning.includes('chord')),
        audio: outcome.buffer,
      }),
    });
  }

  private emitDiagnostics(outcome?: ImportOutcome): void {
    if (outcome) {
      this.deps.onDiagnostics(
        buildDiagnostics({
          source: outcome.record.title,
          analysis: outcome.analysis,
          chart: outcome.chart,
          stats: outcome.stats,
          validation: outcome.validation,
          chartWarnings: outcome.warnings,
          audio: outcome.buffer,
        }),
      );
      return;
    }
    if (this.outcome) this.emitDiagnostics(this.outcome);
  }

  private renderOutcome(outcome: ImportOutcome): void {
    setProgress({ stage: 'done', ratio: 1, detail: outcome.saved ? 'saved to this device' : 'ready to play' });
    setHidden(this.results, false);
    setText(this.analyzedTitle, `· ${outcome.record.title}`);
    this.renderStats({
      bpm: outcome.analysis.bpm,
      confidence: outcome.analysis.beatConfidence,
      alignment: outcome.analysis.beatAlignRatio,
      beatCount: outcome.analysis.beats.length,
      onsetCount: outcome.analysis.onsets.length,
      noteCount: outcome.stats.noteCount,
      peakNotesPerSecond: outcome.stats.peakNotesPerSecond,
      notesPerSecond: outcome.stats.notesPerSecond,
      analysisMs: outcome.analysis.analysisMs,
      framesAnalyzed: outcome.analysis.framesAnalyzed,
    });

    // Only the non-diagnostic notice stays here: the analysis and chart warnings are listed inside
    // the diagnostics section, directly under the numbers they are about (phase 2.1). Repeating
    // them above it just makes the panel noisier without adding information.
    const messages: string[] = [];
    if (outcome.ogg) {
      messages.push(
        `Converted to OGG Vorbis (${formatBytes(outcome.ogg.bytes)}) — the original is no longer the stored copy.`,
      );
    }
    setHidden(this.warnings, messages.length === 0);
    this.warnings.textContent = messages.join('\n');
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
  private renderStoredSummary(record: SongRecord, chart: Beatmap): void {
    setHidden(this.progressWrap, true);
    setHidden(this.results, false);
    setText(this.analyzedTitle, `· ${record.title} (saved chart, no re-analysis)`);
    this.renderStats({
      bpm: record.bpm,
      confidence: record.beatConfidence,
      alignment: record.analysis.beatAlignRatio,
      beatCount: record.analysis.beatCount,
      onsetCount: 0,
      noteCount: chart.notes.length,
      peakNotesPerSecond: record.chart.stats.peakNotesPerSecond,
      notesPerSecond: record.chart.stats.notesPerSecond || (record.durationMs > 0 ? (chart.notes.length / record.durationMs) * 1000 : 0),
      analysisMs: record.analysis.analysisMs,
      framesAnalyzed: record.analysis.framesAnalyzed,
    });
    setHidden(this.warnings, true);
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
