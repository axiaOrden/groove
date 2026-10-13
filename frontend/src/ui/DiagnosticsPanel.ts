/**
 * Diagnostics — the import workflow's own analysis report (phase 2.1).
 *
 * Phase 2 put these numbers in a floating window pinned over the bottom-right of the screen. That
 * had two problems: it covered the seven-lane highway, and it was a *different surface* from the
 * workflow it described — you imported a song in one panel and read its analysis in another, or you
 * lost the window entirely when you navigated. The report now lives inside the import panel, under
 * the analysis it belongs to:
 *
 *   - the **summary** (BPM, grid confidence as *measured alignment*, counts, durations) is always
 *     visible after an import, with each warning directly underneath the numbers it is about;
 *   - the **advanced section** is a `<details>` block — deliberately collapsed, because the numbers
 *     are what you read 90 % of the time and the timeline is what you open when something is wrong —
 *     containing the tempo candidates, the per-section pulse quality, why candidates were dropped,
 *     the lane/role distribution and the shared onset/beat/note timeline;
 *   - the same section reopens for a **saved song** from the library (the record stores the tempo,
 *     the grid numbers and the chart, so the timeline can be rebuilt without re-analysing the file).
 *
 * The timeline is the part worth having. Three rows on one time axis — beats, detected onsets (by
 * spectral band) and generated notes (SPACE distinguished from the other six lanes) — plus low-energy
 * shading and a selectable section. A systematic offset shows up as two rows that do not overlap,
 * and the preview below plays the selected section with an optional beat tick and note blips, which
 * is the only way to check alignment by ear rather than by eye.
 */

import type { Beatmap } from '../chart/ChartTypes';
import type { ChartStats, CandidateRole } from '../chart/ChartGenerator';
import type { AnalysisResult, OnsetBand, OnsetEvent, SectionConfidence, TempoCandidate, TimeRange } from '../analysis/types';
import type { ValidationResult } from '../chart/ChartValidator';
import { SectionPreview } from '../audio/SectionPreview';
import { el, setHidden, setText } from './dom';

/** How much of the song one preview plays, and the default selection length. */
const PREVIEW_WINDOW_MS = 8000;

export interface DiagnosticsData {
  source: string;
  bpm: number;
  beatMs: number;
  firstBeatMs: number;
  /** 0..1, derived from the onset alignment (see analysis/BeatGrid.ts). */
  beatConfidence: number;
  /** Share of onset strength within a beat's tolerance window, and the chance baseline. */
  beatAlignRatio: number;
  beatAlignChance: number;
  /** Phase-2 metrics, kept for side-by-side comparison in the panel. */
  gridCoverage: number;
  gridExcess: number;
  barPhase: { phase: number; margin: number; downbeatMs: number };
  beatCount: number;
  onsetCount: number;
  noteCount: number;
  notesPerSecond: number;
  peakNotesPerSecond: number;
  chartDurationMs: number;
  analysisMs: number;
  framesAnalyzed: number;
  hopMs: number;
  tempoCandidates: readonly TempoCandidate[];
  onsetsStored: boolean;
  analysisWarnings: readonly string[];
  chartWarnings: readonly string[];
  validationErrors: readonly string[];
  beats: readonly number[];
  onsets: readonly OnsetEvent[];
  noteTimes: readonly number[];
  noteLanes: readonly number[];
  quiet: readonly TimeRange[];
  sections: readonly SectionConfidence[];
  lowConfidenceRanges: readonly TimeRange[];
  roles: Partial<Record<CandidateRole, number>>;
  spaceRatio: number;
  gridOnlyNotes: number;
  lowConfidenceNotes: number;
  drops: { density: number; silence: number; spacing: number; laneGap: number };
  /** Audio for the section preview; null when only the stored metadata is available. */
  audio: AudioBuffer | null;
  /**
   * Decode-on-demand audio for a stored song.
   *
   * Opening the diagnostics for a saved song must not cost a multi-second MP3 decode: the numbers
   * and the timeline come from the record alone, and the audio is only needed the moment the player
   * presses play. So a stored song passes a loader instead of a buffer, and the panel awaits it
   * lazily (once) inside `playPreview`.
   */
  loadAudio: (() => Promise<AudioBuffer | null>) | null;
}

export interface DiagnosticsInput {
  source: string;
  analysis?: Pick<
    AnalysisResult,
    | 'bpm'
    | 'beatMs'
    | 'firstBeatMs'
    | 'beatConfidence'
    | 'beatAlignRatio'
    | 'beatAlignChance'
    | 'gridCoverage'
    | 'gridExcess'
    | 'barPhase'
    | 'beats'
    | 'onsets'
    | 'tempoCandidates'
    | 'warnings'
    | 'analysisMs'
    | 'framesAnalyzed'
    | 'hopMs'
    | 'durationMs'
    | 'energy'
    | 'sections'
    | 'lowConfidenceRanges'
  >;
  chart: Beatmap;
  stats?: ChartStats;
  validation?: ValidationResult;
  chartWarnings?: readonly string[];
  audio?: AudioBuffer | null;
  loadAudio?: () => Promise<AudioBuffer | null>;
  /**
   * False for a song reopened from the library: the onset list is not persisted, so "0 onsets"
   * would be a lie and the field says "not stored" instead.
   */
  onsetsStored?: boolean;
}

export function buildDiagnostics(input: DiagnosticsInput): DiagnosticsData {
  const analysis = input.analysis;
  const stats = input.stats;
  const noteTimes = input.chart.notes.map((note) => note.timeMs);
  const noteLanes = input.chart.notes.map((note) => note.lane);
  const durationMs = analysis?.durationMs ?? input.chart.durationMs ?? 0;
  const seconds = durationMs > 0 ? durationMs / 1000 : 1;
  return {
    source: input.source,
    bpm: input.chart.bpm,
    beatMs: analysis?.beatMs ?? (input.chart.bpm > 0 ? 60000 / input.chart.bpm : 0),
    firstBeatMs: analysis?.firstBeatMs ?? 0,
    beatConfidence: analysis?.beatConfidence ?? 0,
    beatAlignRatio: analysis?.beatAlignRatio ?? 0,
    beatAlignChance: analysis?.beatAlignChance ?? 0,
    gridCoverage: analysis?.gridCoverage ?? 0,
    gridExcess: analysis?.gridExcess ?? 0,
    barPhase: analysis
      ? { phase: analysis.barPhase.phase, margin: analysis.barPhase.margin, downbeatMs: analysis.barPhase.downbeatMs }
      : { phase: 0, margin: 0, downbeatMs: 0 },
    beatCount: analysis?.beats.length ?? 0,
    onsetCount: analysis?.onsets.length ?? 0,
    noteCount: input.chart.notes.length,
    notesPerSecond: stats?.notesPerSecond ?? noteTimes.length / seconds,
    peakNotesPerSecond: stats?.peakNotesPerSecond ?? 0,
    chartDurationMs: input.chart.durationMs ?? durationMs,
    analysisMs: analysis?.analysisMs ?? 0,
    framesAnalyzed: analysis?.framesAnalyzed ?? 0,
    hopMs: analysis?.hopMs ?? 0,
    tempoCandidates: analysis?.tempoCandidates ?? [],
    onsetsStored: input.onsetsStored ?? true,
    analysisWarnings: analysis?.warnings ?? [],
    chartWarnings: input.chartWarnings ?? [],
    validationErrors: input.validation?.errors.map((issue) => `${issue.code}: ${issue.message}`) ?? [],
    beats: analysis?.beats ?? [],
    onsets: analysis?.onsets ?? [],
    noteTimes,
    noteLanes,
    quiet: analysis?.energy.lowEnergyRanges ?? [],
    sections: analysis?.sections ?? [],
    lowConfidenceRanges: analysis?.lowConfidenceRanges ?? [],
    roles: stats?.roleCounts ?? {},
    spaceRatio: stats?.spaceRatio ?? 0,
    gridOnlyNotes: stats?.gridOnlyNotes ?? 0,
    lowConfidenceNotes: stats?.lowConfidenceNotes ?? 0,
    drops: {
      density: stats?.droppedByDensity ?? 0,
      silence: stats?.droppedBySilence ?? 0,
      spacing: stats?.droppedBySpacing ?? 0,
      laneGap: stats?.droppedByLaneGap ?? 0,
    },
    audio: input.audio ?? null,
    loadAudio: input.loadAudio ?? null,
  };
}

const BAND_COLORS: Record<OnsetBand, string> = {
  low: '#e0a33c',
  mid: '#9a7bd6',
  high: '#4fb8d6',
  broad: '#c9c9d4',
};

export class DiagnosticsPanel {
  private readonly source = el('diag-source');
  private readonly numbers = el('diag-numbers');
  private readonly warnings = el('diag-warnings');
  private readonly canvas = el<HTMLCanvasElement>('diag-timeline');
  private readonly tables = el('diag-tables');
  private readonly lowSections = el('diag-lows');
  private readonly advanced = el<HTMLDetailsElement>('diag-advanced');
  private readonly selectionLabel = el('diag-selection');
  private readonly previewInfo = el('preview-info');
  private readonly previewBeats = el<HTMLInputElement>('preview-beats');
  private readonly previewNotes = el<HTMLInputElement>('preview-notes');
  private readonly preview = new SectionPreview();

  private data: DiagnosticsData | null = null;
  private selectionStartMs = 0;
  private playheadMs: number | null = null;
  private dragging = false;

  constructor() {
    el('btn-diagnostics').addEventListener('click', () => this.toggleAdvanced());
    el('btn-preview-section').addEventListener('click', () => void this.playPreview());
    el('btn-preview-stop').addEventListener('click', () => this.stopPreview());
    this.previewBeats.addEventListener('change', () => this.renderPreviewInfo());
    this.previewNotes.addEventListener('change', () => this.renderPreviewInfo());
    this.canvas.addEventListener('pointerdown', (event) => {
      this.dragging = true;
      this.selectFromPointer(event);
    });
    this.canvas.addEventListener('pointermove', (event) => {
      if (this.dragging) this.selectFromPointer(event);
    });
    window.addEventListener('pointerup', () => {
      this.dragging = false;
    });
    this.advanced.addEventListener('toggle', () => {
      if (this.advanced.open) this.drawTimeline();
    });
    setText(this.source, 'no song analysed');
  }

  get visible(): boolean {
    return this.data !== null;
  }

  get current(): DiagnosticsData | null {
    return this.data;
  }

  /** Show the report for a fresh import or a stored song. */
  show(data: DiagnosticsData): void {
    this.preview.stop();
    this.data = data;
    this.playheadMs = null;
    // A sensible default selection: the first note, so the preview lands where the chart starts.
    const first = data.noteTimes[0] ?? 0;
    this.selectionStartMs = Math.max(0, Math.min(Math.max(0, data.chartDurationMs - PREVIEW_WINDOW_MS), first - 500));
    this.render();
  }

  /** Forget the current song (e.g. the demo chart is loaded). */
  clear(): void {
    this.preview.stop();
    this.data = null;
    this.advanced.open = false;
    setText(this.source, 'no song analysed');
    this.numbers.innerHTML = '';
    this.tables.innerHTML = '';
    this.warnings.textContent = '';
    this.lowSections.textContent = '';
    this.clearCanvas();
  }

  /** Stop any preview audio (called when the import panel closes). */
  stopPreview(): void {
    this.preview.stop();
    el('btn-preview-section').dataset.playing = 'false';
  }

  /**
   * Preview state for the debug snapshot and the automated browser check. The playhead is drawn
   * from an animation frame, so "is it actually playing" is not otherwise observable from outside.
   */
  get previewState(): { playing: boolean; hasAudio: boolean; selectionStartMs: number; playheadMs: number | null } {
    return {
      playing: this.preview.playing,
      hasAudio: this.audio != null,
      selectionStartMs: Math.round(this.selectionStartMs),
      playheadMs: this.playheadMs === null ? null : Math.round(this.playheadMs),
    };
  }

  dispose(): void {
    this.preview.dispose();
  }

  openAdvanced(): void {
    this.advanced.open = true;
    this.drawTimeline();
    this.advanced.scrollIntoView({ block: 'nearest' });
  }

  toggleAdvanced(): void {
    if (!this.data) return;
    if (this.advanced.open) {
      this.advanced.open = false;
      return;
    }
    this.openAdvanced();
  }

  // ------------------------------------------------------------------ render ---

  private render(): void {
    const data = this.data;
    if (!data) {
      this.clear();
      return;
    }
    const alignment = data.beatAlignRatio * 100;
    const chance = data.beatAlignChance * 100;
    setText(
      this.source,
      `${data.source} · ${data.analysisMs} ms over ${data.framesAnalyzed.toLocaleString()} frames · ` +
        `hop ${data.hopMs.toFixed(2)} ms`,
    );

    const rows: Array<[string, string]> = [
      ['BPM', data.bpm.toFixed(2)],
      ['beat length', `${data.beatMs.toFixed(2)} ms`],
      ['first beat', `${data.firstBeatMs.toFixed(2)} ms`],
      ['grid alignment', `${alignment.toFixed(0)}% (chance ${chance.toFixed(0)}%)`],
      ['grid confidence', data.beatConfidence.toFixed(2)],
      ['bar phase', `${data.barPhase.phase} of 4 (margin ${data.barPhase.margin.toFixed(2)})`],
      ['phase-2 coverage', `${(data.gridCoverage * 100).toFixed(0)}% · excess ${data.gridExcess.toFixed(2)}`],
      ['detected beats', data.beatCount.toLocaleString()],
      ['detected onsets', data.onsetsStored ? data.onsetCount.toLocaleString() : 'not stored'],
      ['generated notes', data.noteCount.toLocaleString()],
      ['notes / second', data.notesPerSecond.toFixed(2)],
      ['peak notes / s', String(data.peakNotesPerSecond)],
      ['chart duration', `${(data.chartDurationMs / 1000).toFixed(1)} s`],
      ['notes on SPACE', `${(data.spaceRatio * 100).toFixed(0)}%`],
      ['grid-only notes', String(data.gridOnlyNotes)],
      ['notes in weak-pulse sections', String(data.lowConfidenceNotes)],
      ['tempo candidates', data.tempoCandidates.map((candidate) => candidate.bpm.toFixed(1)).join(', ') || '—'],
    ];
    this.numbers.innerHTML = rows
      .map(([label, value]) => `<div class="diag-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
      .join('');

    // The import pipeline merges the analysis warnings into the chart warnings, so the same message
    // can arrive twice (once as `chart ·`, once as `analysis ·`). Deduplicate on the text: a reader
    // who sees one warning twice stops trusting the list.
    const seen = new Set<string>();
    const messages: string[] = [];
    const push = (prefix: string, message: string): void => {
      if (seen.has(message)) return;
      seen.add(message);
      messages.push(`${prefix} · ${message}`);
    };
    for (const message of data.validationErrors) push('error', message);
    for (const message of data.chartWarnings) push('chart', message);
    for (const message of data.analysisWarnings) push('analysis', message);
    this.warnings.textContent = messages.length > 0 ? messages.join('\n') : 'no warnings';

    this.tables.innerHTML = this.renderTables(data);
    this.lowSections.textContent = this.renderLowSections(data);
    this.selectionLabel.textContent = '';
    this.renderPreviewInfo();
    if (this.advanced.open) this.drawTimeline();
  }

  /**
   * The tempo candidate table is the answer to "why did it pick that BPM". Every rejected octave
   * carries its own measured alignment, so a half-time candidate that aligns as well as the winner
   * is visible rather than hidden behind a single chosen number.
   */
  private renderTables(data: DiagnosticsData): string {
    const candidateRows = data.tempoCandidates
      .map((candidate) => {
        const alignment = candidate.alignment === undefined ? '—' : `${(candidate.alignment * 100).toFixed(0)}%`;
        return (
          `<tr><td>${candidate.bpm.toFixed(2)}</td><td>${alignment}</td><td>${candidate.score.toFixed(2)}</td>` +
          `<td>${escapeHtml(candidate.label ?? (candidate.octaveOf ? `octave of ${candidate.octaveOf}` : ''))}</td></tr>`
        );
      })
      .join('');
    const roleRows = Object.entries(data.roles)
      .filter(([, count]) => (count ?? 0) > 0)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([role, count]) => `<tr><td>${escapeHtml(role)}</td><td>${count}</td></tr>`)
      .join('');
    const drops = data.drops;
    return (
      '<div class="diag-tables-grid">' +
      '<table class="diag-table"><caption>tempo candidates</caption>' +
      '<thead><tr><th>BPM</th><th>align</th><th>score</th><th>role</th></tr></thead>' +
      `<tbody>${candidateRows || '<tr><td colspan="4">—</td></tr>'}</tbody></table>` +
      '<table class="diag-table"><caption>notes per role</caption>' +
      `${roleRows || '<tr><td colspan="2">—</td></tr>'}</table>` +
      '<table class="diag-table"><caption>candidates dropped</caption><tbody>' +
      `<tr><td>density</td><td>${drops.density}</td></tr>` +
      `<tr><td>silence</td><td>${drops.silence}</td></tr>` +
      `<tr><td>spacing</td><td>${drops.spacing}</td></tr>` +
      `<tr><td>lane gap</td><td>${drops.laneGap}</td></tr>` +
      '</tbody></table>' +
      '</div>'
    );
  }

  private renderLowSections(data: DiagnosticsData): string {
    const known = data.sections.filter((section) => section.confidence >= 0);
    if (known.length === 0) return 'Per-section pulse quality: not enough onsets to judge.';
    const weak = known.filter((section) => section.confidence < 0.25);
    const weakest = [...known].sort((a, b) => a.confidence - b.confidence).slice(0, 5);
    const format = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
    return (
      `Per-section pulse quality: ${known.length - weak.length} of ${known.length} bar-groups track the beat` +
      (weak.length > 0
        ? `; the weakest are ${weakest
            .filter((section) => section.confidence < 0.25)
            .map((section) => `${format(section.startMs)}–${format(section.endMs)} (${(section.confidence * 100).toFixed(0)}%)`)
            .join(', ')}. Charts are built from detected onsets only in those ranges.`
        : '.')
    );
  }

  private renderPreviewInfo(): void {
    const data = this.data;
    if (!data) {
      setText(this.previewInfo, '');
      return;
    }
    const from = this.selectionStartMs;
    const to = Math.min(data.chartDurationMs || data.beatMs, from + PREVIEW_WINDOW_MS);
    const beats = Math.max(0, Math.round((to - from) / Math.max(1, data.beatMs)));
    const notes = data.noteTimes.filter((time) => time >= from && time <= to).length;
    const clicks = [this.previewBeats.checked ? `${beats} beat ticks` : null, this.previewNotes.checked ? `${notes} note blips` : null]
      .filter(Boolean)
      .join(' + ');
    const playable = data.audio !== null || data.loadAudio !== null;
    setText(
      this.previewInfo,
      playable
        ? `Selected ${(from / 1000).toFixed(1)}s–${(to / 1000).toFixed(1)}s${clicks ? ` with ${clicks}` : ''}.`
        : 'Audio is not stored for this song; the timeline is still available.',
    );
    el('btn-preview-section').setAttribute('aria-disabled', playable ? 'false' : 'true');
  }

  /** The audio for the preview, decoding it on first use when the song came from the library. */
  private get audio(): AudioBuffer | null {
    if (this.data?.audio) return this.data.audio;
    return null;
  }

  private async ensureAudio(): Promise<AudioBuffer | null> {
    const data = this.data;
    if (!data) return null;
    if (data.audio) return data.audio;
    if (!data.loadAudio) return null;
    setText(this.previewInfo, 'Decoding the audio for the preview…');
    try {
      const buffer = await data.loadAudio();
      // Cached on the panel's own copy: pressing play twice decodes once.
      if (buffer) data.audio = buffer;
      return buffer;
    } catch {
      return null;
    }
  }

  /** Start the section preview: the music, plus clicks on the beats and/or the generated notes. */
  private async playPreview(): Promise<void> {
    const data = this.data;
    if (!data) return;
    const buffer = await this.ensureAudio();
    if (!buffer) {
      this.renderPreviewInfo();
      setText(this.previewInfo, 'The audio for this song is not available, so only the timeline can be inspected.');
      return;
    }
    // The selection may have been changed while the audio was decoding, and the "decoding…"
    // message has to be replaced now that it is in the past.
    this.renderPreviewInfo();
    const from = this.selectionStartMs;
    const to = Math.min(data.chartDurationMs || buffer.duration * 1000, from + PREVIEW_WINDOW_MS);
    el('btn-preview-section').dataset.playing = 'true';
    await this.preview.play({
      buffer,
      startMs: from,
      endMs: to,
      beats: data.beats.length > 0 ? data.beats : gridBeatsFrom(data),
      notes: data.noteTimes,
      noteLanes: data.noteLanes,
      beatClick: this.previewBeats.checked,
      noteClick: this.previewNotes.checked,
      onTime: (songTimeMs) => {
        this.playheadMs = songTimeMs;
        this.drawTimeline();
      },
      onEnded: () => {
        el('btn-preview-section').dataset.playing = 'false';
      },
    });
  }

  // ---------------------------------------------------------------- timeline ---

  private clearCanvas(): void {
    const context = this.canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private selectFromPointer(event: PointerEvent): void {
    const data = this.data;
    if (!data) return;
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    const duration = Math.max(1, data.chartDurationMs || 1);
    this.selectionStartMs = Math.max(0, Math.min(duration - 1000, ratio * duration));
    this.preview.stop();
    this.renderPreviewInfo();
    this.drawTimeline();
  }

  /**
   * Three rows on one time axis, plus the selected section and the playhead.
   *
   * Reading it: if the note row sits consistently left or right of the onset row, the chart is
   * systematically early or late; if notes appear where the onset row is empty, the generator is
   * charting its grid rather than the music (that count is `grid-only notes` above). SPACE notes are
   * drawn taller and in a lighter green because "is SPACE actually on the beat?" is the question a
   * player asks first.
   */
  private drawTimeline(): void {
    const context = this.canvas.getContext('2d');
    const data = this.data;
    if (!context || !data) return;
    const width = this.canvas.width;
    const height = this.canvas.height;
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#080b12';
    context.fillRect(0, 0, width, height);

    const duration = Math.max(1, data.chartDurationMs || 1);
    const x = (timeMs: number): number => Math.max(0, Math.min(width - 1, (timeMs / duration) * width));

    context.fillStyle = 'rgba(120, 130, 160, 0.16)';
    for (const range of data.quiet) {
      context.fillRect(x(range.startMs), 0, Math.max(1, x(range.endMs) - x(range.startMs)), height);
    }
    context.fillStyle = 'rgba(224, 163, 60, 0.10)';
    for (const range of data.lowConfidenceRanges) {
      context.fillRect(x(range.startMs), 0, Math.max(1, x(range.endMs) - x(range.startMs)), height);
    }
    // The selected section, so the preview window is visible before it is played.
    const selectionEnd = Math.min(duration, this.selectionStartMs + PREVIEW_WINDOW_MS);
    context.fillStyle = 'rgba(74, 208, 138, 0.14)';
    context.fillRect(x(this.selectionStartMs), 0, Math.max(1, x(selectionEnd) - x(this.selectionStartMs)), height);

    const rowHeight = height / 3;
    const bar = (timeMs: number, row: number, color: string, barWidth = 1.6, barHeight?: number): void => {
      context.fillStyle = color;
      const top = row * rowHeight + 3;
      context.fillRect(x(timeMs), top, barWidth, barHeight ?? Math.max(3, rowHeight - 7));
    };

    // Row 0 — beats (blue), with downbeats brighter and taller so the bar phase is visible.
    const beatsPerBar = 4;
    data.beats.forEach((timeMs, index) => {
      // The grid starts at index 0 and the bar phase says which of the four positions accents, so
      // "is this beat a downbeat" is just the position matching the phase.
      const downbeat = index % beatsPerBar === data.barPhase.phase;
      bar(timeMs, 0, downbeat ? '#6ba7ff' : '#3d6bb6', downbeat ? 2.4 : 1.4, downbeat ? rowHeight - 5 : rowHeight - 12);
    });
    // Row 1 — onsets, coloured by the band that gained the energy.
    for (const onset of data.onsets) bar(onset.timeMs, 1, BAND_COLORS[onset.band] ?? '#d6a13d', 1.5);
    // Row 2 — generated notes; SPACE (lane 3) is the tall bright one.
    data.noteTimes.forEach((timeMs, index) => {
      const space = data.noteLanes[index] === 3;
      bar(timeMs, 2, space ? '#7cf0b4' : '#4ad08a', space ? 2.6 : 1.5, space ? rowHeight - 5 : rowHeight - 13);
    });

    context.strokeStyle = 'rgba(255,255,255,0.12)';
    context.beginPath();
    for (let row = 1; row < 3; row += 1) {
      context.moveTo(0, row * rowHeight);
      context.lineTo(width, row * rowHeight);
    }
    context.stroke();

    if (this.playheadMs !== null) {
      // Snapped to a half pixel so the line renders as one crisp column instead of a 50 % blend
      // spread over two, which is the difference between "readable" and "vaguely yellowish".
      const playheadX = Math.round(x(this.playheadMs)) + 0.5;
      context.strokeStyle = '#f6c453';
      context.beginPath();
      context.moveTo(playheadX, 0);
      context.lineTo(playheadX, height);
      context.stroke();
    }
  }
}

/** Beats reconstructed from the tempo, for stored songs whose beat list was not persisted. */
function gridBeatsFrom(data: DiagnosticsData): number[] {
  if (!(data.beatMs > 0)) return [];
  const beats: number[] = [];
  for (let time = data.firstBeatMs; time <= data.chartDurationMs; time += data.beatMs) {
    beats.push(time);
    if (beats.length > 100000) break;
  }
  return beats;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
