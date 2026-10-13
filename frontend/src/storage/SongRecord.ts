/**
 * The persisted form of an imported song.
 *
 * What is stored, and why exactly this much:
 *
 *   - the **charts** — one entry per difficulty (easy / normal / hard), each with its notes,
 *     generator info, lane count, key labels and validation summary. Together they *are* the
 *     analysis output, so a stored song reopens with **no re-analysis and no regeneration**: picking
 *     a difficulty is a lookup;
 *   - the **tempo and grid numbers** (bpm, beatMs, firstBeatMs, confidence) so a chart can be
 *     rebuilt and re-validated without the audio, and so the editor (phase 4) has the grid;
 *   - **analysis metadata** (version, timings, counts, warnings, tempo candidates, per-section
 *     pulse quality) which is what the diagnostics panel shows for a stored song;
 *   - the **original audio bytes** (or an optional OGG transcode), in a separate object store, so
 *     listing the library does not read megabytes of audio.
 *
 * What is deliberately *not* stored is the full analysis: the per-frame loudness curve, the ~20 000
 * onset envelope samples per minute and the complete onset list. They are inputs to chart
 * generation, and regenerating three charts per song is exactly what the library avoids. Keeping
 * them would multiply the database for no user-visible benefit.
 *
 * ---------------------------------------------------------------- versions and migration --
 *
 * `recordVersion` 2 stores a map of charts. Version 1 (phase 2) stored a single seven-key chart,
 * which is **Hard by definition** — same lane count, same key map — so a v1 record is migrated in
 * place: its chart becomes `charts.hard`, and the other two difficulties are simply *absent*.
 *
 * Absent is not the same as broken, and it is not silently faked: the difficulty picker shows them
 * as unavailable and offers to regenerate them from the stored audio (one extra analysis, labelled
 * as such). That is the "safe regeneration path" the brief asks for when a legacy record does not
 * carry enough information to build the other charts — inventing Easy and Normal from a chart's
 * note list alone (no onsets, no event timeline) would produce notes that correspond to nothing in
 * the music, which is precisely what this project refuses to do.
 *
 * Records are validated on the way out of the database (`decodeSongRecord` + `chartOf` /
 * `chartSetOf`, which run the real `ChartValidator`): IndexedDB contents are untrusted input like
 * any other.
 */

import type { Beatmap, ChartGeneratorInfo, ChartNote, Difficulty } from '../chart/ChartTypes';
import { BEATMAP_SCHEMA_VERSION, isDifficulty, lanesOf } from '../chart/ChartTypes';
import { prepareBeatmap, validateBeatmap } from '../chart/ChartValidator';
import type { ChartStats, GenerationResult } from '../chart/ChartGenerator';
import { GENERATOR_NAME, GENERATOR_VERSION } from '../chart/ChartGenerator';
import {
  CHART_DIFFICULTIES,
  difficultyProfile,
  isChartDifficulty,
  keyLabelsFor,
  type ChartDifficulty,
} from '../chart/Difficulty';
import { primaryChart, type ChartSet, type DifficultyChart, type DifficultyCharts } from '../chart/DifficultySet';
import { maxTheoreticalScoreOf } from '../chart/ScoreModel';
import type { BarPhase, SectionConfidence, TempoCandidate, TimeRange } from '../analysis/types';
import type { AnalysisResult } from '../analysis/types';
import type { ValidationResult } from '../chart/ChartValidator';

/** Bumped when the record shape changes; a newer version is refused with a clear message. */
export const SONG_RECORD_VERSION = 2;

export type StoredAudioFormat = 'mp3' | 'ogg' | 'other';

export interface SongAudioDescriptor {
  format: StoredAudioFormat;
  mimeType: string;
  bytes: number;
  /** True when the bytes are in the database. False when the player chose not to keep them. */
  stored: boolean;
  /** True when an OGG transcode is what is stored rather than the original file. */
  transcoded: boolean;
}

export interface SongAnalysisInfo {
  version: string;
  analysisMs: number;
  framesAnalyzed: number;
  hopMs: number;
  onsetCount: number;
  beatCount: number;
  lowEnergySections: number;
  warnings: string[];
  tempoCandidates: TempoCandidate[];
  // The grid's measured quality, stored so the diagnostics panel can be reopened for a saved song
  // without re-analysing (or even re-decoding) its audio. These are a handful of numbers plus at
  // most 64 section entries, so the reason the full onset list is *not* stored still stands.
  /** Share of onset strength inside a beat's tolerance window, and the chance baseline. */
  beatAlignRatio: number;
  beatAlignChance: number;
  /** Phase-2 metrics, kept for the side-by-side comparison in the panel. */
  gridCoverage: number;
  gridExcess: number;
  /** Which beat of the bar carries the accents. */
  barPhase: BarPhase;
  /** Per-section pulse quality (rebuilt as an empty list for records saved before phase 2.1). */
  sections: SectionConfidence[];
  /** Sections whose pulse is too weak to trust. */
  lowConfidenceRanges: TimeRange[];
}

export interface SongChartInfo {
  schemaVersion: number;
  difficulty: Difficulty;
  /** Lanes this chart renders (4 / 5 / 7); 7 for a migrated phase-2 chart. */
  laneCount: number;
  /** Key label per lane, stored so the chart is self-describing. */
  keyLabels: string[];
  generator: ChartGeneratorInfo;
  noteCount: number;
  notes: ChartNote[];
  stats: ChartStats;
  /** Theoretical maximum score at this chart's difficulty weight. */
  maxScore: number;
  /** Estimated notes per second (from the stats, stored for the picker). */
  noteDensity: number;
  validation: { ok: boolean; errors: string[]; warnings: string[] };
}

/** Charts by difficulty. Partial: a migrated phase-2 record only has `hard`. */
export type StoredCharts = Partial<Record<ChartDifficulty, SongChartInfo>>;

export interface SongRecord {
  recordVersion: number;
  id: string;
  title: string;
  artist?: string;
  fileName: string;
  fileSize: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
  bpm: number;
  beatMs: number;
  firstBeatMs: number;
  beatConfidence: number;
  analysis: SongAnalysisInfo;
  charts: StoredCharts;
  audio: SongAudioDescriptor;
  createdAt: string;
  updatedAt: string;
}

/** Per-difficulty line of the library picker: everything the row shows, without the notes. */
export interface SongDifficultySummary {
  difficulty: ChartDifficulty;
  laneCount: number;
  noteCount: number;
  notesPerSecond: number;
  maxScore: number;
  scoreWeight: number;
  validationOk: boolean;
}

/** The list view: everything except the notes and the audio bytes. */
export interface SongSummary {
  id: string;
  title: string;
  artist?: string;
  durationMs: number;
  bpm: number;
  /** Primary (hardest available) chart's note count, kept for older callers. */
  noteCount: number;
  /** Primary difficulty, kept for older callers. */
  difficulty: Difficulty;
  /** Difficulties this song actually has charts for, easy → hard. */
  difficulties: ChartDifficulty[];
  /** One line per available difficulty. */
  charts: SongDifficultySummary[];
  createdAt: string;
  updatedAt: string;
  audio: SongAudioDescriptor;
  validationOk: boolean;
  warnings: string[];
}

export interface BuildRecordInput {
  id: string;
  title: string;
  artist?: string;
  fileName: string;
  fileSize: number;
  audio: SongAudioDescriptor;
  analysis: AnalysisResult;
  /** Generated chart set (see `chart/DifficultySet.ts`). */
  charts: DifficultyCharts;
  now?: () => Date;
}

export function buildSongRecord(input: BuildRecordInput): SongRecord {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const charts: StoredCharts = {};
  for (const difficulty of CHART_DIFFICULTIES) {
    const entry = input.charts[difficulty];
    if (!entry) continue;
    charts[difficulty] = chartInfoOf(entry);
  }
  return {
    recordVersion: SONG_RECORD_VERSION,
    id: input.id,
    title: input.title,
    ...(input.artist ? { artist: input.artist } : {}),
    fileName: input.fileName,
    fileSize: input.fileSize,
    durationMs: round(input.analysis.durationMs),
    sampleRate: input.analysis.sampleRate,
    channels: input.analysis.channels,
    bpm: input.analysis.bpm,
    beatMs: input.analysis.beatMs,
    firstBeatMs: input.analysis.firstBeatMs,
    beatConfidence: input.analysis.beatConfidence,
    analysis: {
      version: input.analysis.version,
      analysisMs: input.analysis.analysisMs,
      framesAnalyzed: input.analysis.framesAnalyzed,
      hopMs: input.analysis.hopMs,
      onsetCount: input.analysis.onsets.length,
      beatCount: input.analysis.beats.length,
      lowEnergySections: input.analysis.energy.lowEnergyRanges.length,
      warnings: [...input.analysis.warnings],
      tempoCandidates: [...input.analysis.tempoCandidates],
      beatAlignRatio: input.analysis.beatAlignRatio,
      beatAlignChance: input.analysis.beatAlignChance,
      gridCoverage: input.analysis.gridCoverage,
      gridExcess: input.analysis.gridExcess,
      barPhase: { ...input.analysis.barPhase, scores: [...input.analysis.barPhase.scores] },
      sections: input.analysis.sections.map((section) => ({ ...section })),
      lowConfidenceRanges: input.analysis.lowConfidenceRanges.map((range) => ({ ...range })),
    },
    charts,
    audio: { ...input.audio },
    createdAt: now,
    updatedAt: now,
  };
}

/** One generated difficulty → the persisted shape. */
export function chartInfoOf(entry: DifficultyChart): SongChartInfo {
  const chart = entry.chart;
  const laneCount = lanesOf(chart);
  const stats = entry.stats;
  return {
    schemaVersion: chart.schemaVersion,
    difficulty: chart.difficulty,
    laneCount,
    keyLabels: chart.keyLabels ?? keyLabelsFor(laneCount),
    generator: { ...chart.generator },
    noteCount: chart.notes.length,
    notes: chart.notes.map((note) => ({ ...note })),
    stats: { ...stats },
    maxScore: chart.maxScore ?? maxTheoreticalScoreOf(chart.notes, entry.profile.scoreWeight),
    noteDensity: chart.noteDensity ?? round(stats.notesPerSecond),
    validation: {
      ok: entry.validation.ok,
      errors: entry.validation.errors.map((issue) => `${issue.code}: ${issue.message}`),
      warnings: entry.validation.warnings.map((issue) => `${issue.code}: ${issue.message}`),
    },
  };
}

/** Difficulties this record has charts for, in canonical order. */
export function recordDifficulties(record: SongRecord): ChartDifficulty[] {
  return CHART_DIFFICULTIES.filter((difficulty) => record.charts[difficulty] !== undefined);
}

/** The difficulty a record opens on: Hard when present, else the hardest available. */
export function primaryDifficulty(record: SongRecord): ChartDifficulty | null {
  const available = recordDifficulties(record);
  for (const preferred of ['hard', 'normal', 'easy'] as const) {
    if (available.includes(preferred)) return preferred;
  }
  return available[available.length - 1] ?? null;
}

export function storedChart(record: SongRecord, difficulty: ChartDifficulty): SongChartInfo | null {
  return record.charts[difficulty] ?? null;
}

/** Rebuild a playable, validated `Beatmap` for one difficulty. */
export function chartOf(record: SongRecord, difficulty?: ChartDifficulty): Beatmap {
  const wanted = difficulty ?? primaryDifficulty(record);
  if (wanted === null) throw new SongRecordError('The stored song has no chart.');
  const info = record.charts[wanted];
  if (!info) {
    throw new SongRecordError(
      `“${record.title}” has no ${wanted} chart. It was saved before phase 3; import the file again ` +
        '(or regenerate it from the library) to get all three difficulties.',
    );
  }
  const chart: Beatmap = {
    schemaVersion: info.schemaVersion,
    songId: record.id,
    title: record.title,
    difficulty: info.difficulty,
    laneCount: info.laneCount,
    keyLabels: [...info.keyLabels],
    bpm: record.bpm,
    offsetMs: 0,
    generator: { ...info.generator },
    durationMs: record.durationMs,
    noteDensity: info.noteDensity,
    maxScore: info.maxScore,
    notes: info.notes.map((note) => ({ ...note })),
  };
  if (record.artist) chart.artist = record.artist;
  // The validator is the authority, exactly as for a hand-authored or freshly generated chart.
  return prepareBeatmap(chart);
}

/** Every chart of a record as a `ChartSet`, for the game's difficulty switcher. */
export function chartSetOf(record: SongRecord, warnings: readonly string[] = []): ChartSet {
  const charts: DifficultyChart[] = [];
  for (const difficulty of recordDifficulties(record)) {
    const info = record.charts[difficulty]!;
    const profile = difficultyProfile(difficulty);
    try {
      const chart = chartOf(record, difficulty);
      charts.push({
        difficulty,
        profile,
        chart,
        stats: info.stats,
        validation: validateBeatmap(chart),
        warnings: [],
      });
    } catch {
      // A corrupted chart is skipped rather than thrown away silently at this level: the difficulty
      // ends up absent from the set, which is exactly how the UI reports "not available".
      continue;
    }
  }
  return {
    songId: record.id,
    title: record.title,
    ...(record.artist ? { artist: record.artist } : {}),
    durationMs: record.durationMs,
    bpm: record.bpm,
    generator: { ...(record.charts.hard?.generator ?? record.charts.normal?.generator ?? EMPTY_GENERATOR) },
    charts: Object.fromEntries(charts.map((entry) => [entry.difficulty, entry])) as DifficultyCharts,
    warnings: [...warnings],
  };
}

/** The chart a record opens on, rebuilt and validated. */
export function primaryChartOf(record: SongRecord): { difficulty: ChartDifficulty; chart: Beatmap } {
  const wanted = primaryDifficulty(record);
  if (wanted === null) throw new SongRecordError('The stored song has no chart.');
  return { difficulty: wanted, chart: chartOf(record, wanted) };
}

export function summarize(record: SongRecord): SongSummary {
  const difficulties = recordDifficulties(record);
  const primary = primaryDifficulty(record);
  const charts: SongDifficultySummary[] = difficulties.map((difficulty) => {
    const info = record.charts[difficulty]!;
    const profile = difficultyProfile(difficulty);
    return {
      difficulty,
      laneCount: info.laneCount,
      noteCount: info.noteCount || info.notes.length,
      notesPerSecond: info.noteDensity,
      maxScore: info.maxScore,
      scoreWeight: profile.scoreWeight,
      validationOk: validationFor(record, difficulty).ok,
    };
  });
  const primaryInfo = primary === null ? null : record.charts[primary]!;
  const allValid = charts.every((entry) => entry.validationOk);
  return {
    id: record.id,
    title: record.title,
    ...(record.artist ? { artist: record.artist } : {}),
    durationMs: record.durationMs,
    bpm: record.bpm,
    noteCount: primaryInfo ? primaryInfo.noteCount || primaryInfo.notes.length : 0,
    difficulty: primaryInfo ? primaryInfo.difficulty : 'hard',
    difficulties,
    charts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    audio: { ...record.audio },
    validationOk: allValid,
    warnings: [...record.analysis.warnings],
  };
}

/** Validation without throwing, for list views and diagnostics. */
export function validateRecord(record: SongRecord): ValidationResult {
  const difficulties = recordDifficulties(record);
  if (difficulties.length === 0) {
    return {
      ok: false,
      errors: [{ severity: 'error', code: 'no-charts', message: 'the record has no charts' }],
      warnings: [],
    };
  }
  const errors: ValidationResult['errors'] = [];
  const warnings: ValidationResult['warnings'] = [];
  for (const difficulty of difficulties) {
    const result = validationFor(record, difficulty);
    errors.push(...result.errors.map((issue) => ({ ...issue, code: `${difficulty}:${issue.code}` })));
    warnings.push(...result.warnings.map((issue) => ({ ...issue, code: `${difficulty}:${issue.code}` })));
  }
  return { ok: errors.length === 0, errors, warnings };
}

function validationFor(record: SongRecord, difficulty: ChartDifficulty): ValidationResult {
  try {
    return validateBeatmap(chartOf(record, difficulty));
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          severity: 'error',
          code: 'unreadable',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      warnings: [],
    };
  }
}

/** Build a set from a plain `GenerationResult`, used by tests and the demo chart. */
export function difficultyChartOf(
  difficulty: ChartDifficulty,
  generated: Pick<GenerationResult, 'chart' | 'stats' | 'validation' | 'warnings'>,
): DifficultyChart {
  return {
    difficulty,
    profile: difficultyProfile(difficulty),
    chart: generated.chart,
    stats: generated.stats,
    validation: generated.validation,
    warnings: [...generated.warnings],
  };
}

/** JSON round-trip, used for export/import and covered by tests. */
export function encodeSongRecord(record: SongRecord): string {
  return JSON.stringify(record);
}

export class SongRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SongRecordError';
  }
}

/**
 * Parse and validate an untrusted record (from the database, a file, or another build).
 * Throws `SongRecordError` with a message that can be shown to the player.
 */
export function decodeSongRecord(value: unknown): SongRecord {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SongRecordError('The stored song is not a JSON object.');
  }
  const record = parsed as Partial<SongRecord> & { chart?: unknown };
  if (typeof record.recordVersion !== 'number') {
    throw new SongRecordError('The stored song has no record version.');
  }
  if (record.recordVersion > SONG_RECORD_VERSION) {
    throw new SongRecordError(
      `This song was saved by a newer version of the game (record v${record.recordVersion}, ` +
        `this build understands v${SONG_RECORD_VERSION}).`,
    );
  }
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new SongRecordError('The stored song has no id.');
  }
  if (typeof record.title !== 'string' || record.title.length === 0) {
    throw new SongRecordError('The stored song has no title.');
  }
  if (!Number.isFinite(record.bpm) || (record.bpm ?? 0) <= 0) {
    throw new SongRecordError('The stored song has no usable tempo.');
  }
  if (!Number.isFinite(record.beatMs) || (record.beatMs ?? 0) <= 0) {
    throw new SongRecordError('The stored song has no usable beat length.');
  }

  const charts = decodeCharts(record);
  if (Object.keys(charts).length === 0) {
    throw new SongRecordError('The stored song has no chart notes.');
  }

  return {
    recordVersion: record.recordVersion,
    id: record.id,
    title: record.title,
    ...(record.artist ? { artist: record.artist } : {}),
    fileName: typeof record.fileName === 'string' ? record.fileName : 'unknown',
    fileSize: Number.isFinite(record.fileSize) ? (record.fileSize as number) : 0,
    durationMs: Number.isFinite(record.durationMs) ? (record.durationMs as number) : 0,
    sampleRate: Number.isFinite(record.sampleRate) ? (record.sampleRate as number) : 44100,
    channels: Number.isFinite(record.channels) ? (record.channels as number) : 2,
    bpm: record.bpm as number,
    beatMs: record.beatMs as number,
    firstBeatMs: Number.isFinite(record.firstBeatMs) ? (record.firstBeatMs as number) : 0,
    beatConfidence: Number.isFinite(record.beatConfidence) ? (record.beatConfidence as number) : 0,
    analysis: normalizeAnalysis(record.analysis),
    charts,
    audio: {
      format: record.audio?.format ?? 'other',
      mimeType: record.audio?.mimeType ?? 'audio/mpeg',
      bytes: record.audio?.bytes ?? 0,
      stored: record.audio?.stored ?? false,
      transcoded: record.audio?.transcoded ?? false,
    },
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: record.updatedAt ?? record.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Charts from either record shape.
 *
 * A version-1 record has a single `chart`, which is a seven-lane chart and therefore **Hard**; it
 * migrates to `charts.hard`. That is not a guess: the v1 schema stored exactly the seven-lane key
 * map and the validator's lane range was 0..6, so a v1 chart is played on the hard layout with no
 * change of any kind. The other two difficulties are left absent on purpose (see the module header).
 */
function decodeCharts(record: Partial<SongRecord> & { chart?: unknown }): StoredCharts {
  const charts: StoredCharts = {};
  const source = record.charts;
  const legacy = record.chart;
  const entries: Array<[ChartDifficulty, unknown]> = [];
  if (source && typeof source === 'object') {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === null) continue;
      if (!isChartDifficulty(key)) {
        throw new SongRecordError(`The stored song has an unknown difficulty: ${String(key)}`);
      }
      entries.push([key, value]);
    }
  } else if (legacy && typeof legacy === 'object') {
    entries.push(['hard', legacy]);
  }
  for (const [difficulty, value] of entries) {
    const info = decodeChartInfo(value, difficulty);
    if (info === null) continue; // an empty note list: the difficulty is simply not available
    charts[difficulty] = info;
  }
  return charts;
}

function decodeChartInfo(value: unknown, difficulty: ChartDifficulty): SongChartInfo | null {
  const info = value as Partial<SongChartInfo> | null;
  if (!info || typeof info !== 'object') return null;
  if (typeof info.schemaVersion !== 'number' || info.schemaVersion < 1) {
    throw new SongRecordError('The stored chart has no schema version.');
  }
  if (info.schemaVersion > BEATMAP_SCHEMA_VERSION) {
    throw new SongRecordError(
      `The stored chart uses schema v${info.schemaVersion}; this build supports v${BEATMAP_SCHEMA_VERSION}.`,
    );
  }
  if (!isDifficulty(info.difficulty)) {
    throw new SongRecordError(`The stored song has an unknown difficulty: ${String(info.difficulty)}`);
  }
  if (!Array.isArray(info.notes) || info.notes.length === 0) return null;
  const laneCount = Number.isInteger(info.laneCount) && (info.laneCount ?? 0) >= 1 ? (info.laneCount as number) : 7;
  return {
    schemaVersion: info.schemaVersion,
    difficulty: info.difficulty,
    laneCount,
    keyLabels: Array.isArray(info.keyLabels)
      ? info.keyLabels.map((label) => String(label))
      : keyLabelsFor(laneCount),
    generator: normalizeGenerator(info.generator),
    noteCount: info.notes.length,
    notes: info.notes,
    stats: normalizeStats(info.stats, laneCount, info.notes as ChartNote[]),
    maxScore:
      Number.isFinite(info.maxScore) && (info.maxScore ?? 0) > 0
        ? (info.maxScore as number)
        : maxTheoreticalScoreOf(
            info.notes as ChartNote[],
            isChartDifficulty(info.difficulty) ? difficultyProfile(info.difficulty).scoreWeight : 1,
          ),
    noteDensity: Number.isFinite(info.noteDensity)
      ? (info.noteDensity as number)
      : normalizeStats(info.stats, laneCount, info.notes as ChartNote[]).notesPerSecond,
    validation: {
      ok: info.validation?.ok ?? true,
      errors: info.validation?.errors ?? [],
      warnings: info.validation?.warnings ?? [],
    },
  };
}

function normalizeAnalysis(analysis: SongAnalysisInfo | undefined): SongAnalysisInfo {
  return {
    version: analysis?.version ?? 'unknown',
    analysisMs: analysis?.analysisMs ?? 0,
    framesAnalyzed: analysis?.framesAnalyzed ?? 0,
    hopMs: analysis?.hopMs ?? 0,
    onsetCount: analysis?.onsetCount ?? 0,
    beatCount: analysis?.beatCount ?? 0,
    lowEnergySections: analysis?.lowEnergySections ?? 0,
    warnings: analysis?.warnings ?? [],
    tempoCandidates: analysis?.tempoCandidates ?? [],
    // A record written before phase 2.1 has no alignment numbers; zeroing them (rather than
    // inventing a value) keeps the panel honest: "not recorded", not "measured as zero".
    beatAlignRatio: analysis?.beatAlignRatio ?? 0,
    beatAlignChance: analysis?.beatAlignChance ?? 0,
    gridCoverage: analysis?.gridCoverage ?? 0,
    gridExcess: analysis?.gridExcess ?? 0,
    barPhase: {
      phase: analysis?.barPhase?.phase ?? 0,
      scores: analysis?.barPhase?.scores ?? [],
      margin: analysis?.barPhase?.margin ?? 0,
      downbeatMs: analysis?.barPhase?.downbeatMs ?? 0,
    },
    sections: analysis?.sections ?? [],
    lowConfidenceRanges: analysis?.lowConfidenceRanges ?? [],
  };
}

function normalizeGenerator(generator: ChartGeneratorInfo | undefined): ChartGeneratorInfo {
  return {
    name: generator?.name ?? GENERATOR_NAME,
    version: generator?.version ?? GENERATOR_VERSION,
    seed: Number.isFinite(generator?.seed) ? (generator?.seed as number) : 0,
  };
}

/**
 * Stats from an untrusted record.
 *
 * A migrated v1 record has the pre-phase-3 stats shape (no `laneCount` / `maxSimultaneous` /
 * `chordNoteCount`), and a hand-edited record may have none at all. The *derived* numbers are
 * recomputed from the notes rather than trusted, so the picker cannot show a note count that
 * disagrees with the chart it is describing.
 */
function normalizeStats(stats: ChartStats | undefined, laneCount: number, notes: readonly ChartNote[]): ChartStats {
  const laneUsage = new Array<number>(laneCount).fill(0);
  for (const note of notes) {
    if (Number.isInteger(note.lane) && note.lane >= 0 && note.lane < laneCount) {
      laneUsage[note.lane] = (laneUsage[note.lane] ?? 0) + 1;
    }
  }
  const base = stats ?? EMPTY_STATS;
  const noteCount = notes.length;
  return {
    ...EMPTY_STATS,
    ...base,
    noteCount,
    tapCount: notes.filter((note) => note.type !== 'hold').length,
    holdCount: notes.filter((note) => note.type === 'hold').length,
    laneUsage,
    lanesUsed: laneUsage.filter((count) => count > 0).length,
    laneCount,
    chordCount: base.chordCount ?? 0,
    chordNoteCount: base.chordNoteCount ?? 0,
    maxSimultaneous: base.maxSimultaneous ?? 1,
    notesPerSecond: base.notesPerSecond ?? 0,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new SongRecordError(`The stored song is not valid JSON: ${error instanceof Error ? error.message : ''}`);
  }
}

/** Stable id for a file: the same upload re-imported replaces its library entry. */
export function makeSongId(facts: { name: string; sizeBytes: number; lastModified: number }, durationMs: number): string {
  const source = `${facts.name}|${facts.sizeBytes}|${facts.lastModified}|${Math.round(durationMs)}`;
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) >>> 0;
  }
  return `song-${hash.toString(16).padStart(8, '0')}`;
}

/** Title from a file name: strip the extension, collapse separators. */
export function titleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, '');
  const spaced = withoutExtension.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced.length > 0 ? spaced : 'Untitled';
}

const EMPTY_GENERATOR: ChartGeneratorInfo = { name: GENERATOR_NAME, version: GENERATOR_VERSION, seed: 0 };

const EMPTY_STATS: ChartStats = {
  noteCount: 0,
  tapCount: 0,
  holdCount: 0,
  chordCount: 0,
  holdRatio: 0,
  chordRatio: 0,
  notesPerSecond: 0,
  peakNotesPerSecond: 0,
  chartDurationMs: 0,
  firstNoteMs: 0,
  lastNoteEndMs: 0,
  laneUsage: [],
  lanesUsed: 0,
  onOnset: 0,
  onBeat: 0,
  onsetAlignRatio: 0,
  beatAlignRatio: 0,
  candidatesConsidered: 0,
  droppedByDensity: 0,
  droppedBySilence: 0,
  droppedBySpacing: 0,
  droppedByLaneGap: 0,
  droppedByLaneExhausted: 0,
  longGapCount: 0,
  maxGapMs: 0,
  meanGapMs: 0,
  sectionsSkipped: 0,
  laneCount: 0,
  maxSimultaneous: 0,
  chordNoteCount: 0,
  spaceCount: 0,
  spaceRatio: 0,
  roleCounts: {
    downbeat: 0,
    kick: 0,
    low: 0,
    high: 0,
    supporting: 0,
    melodic: 0,
    syncopation: 0,
    beat: 0,
  },
  gridOnlyNotes: 0,
  lowConfidenceNotes: 0,
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Re-exported so callers can name the primary chart of a set without importing two modules. */
export { primaryChart };
