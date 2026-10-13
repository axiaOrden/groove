/**
 * MP3 (and other audio) import: file validation, decoding and metadata.
 *
 * The important decision here is what "the decoded song" is, and it has three parts:
 *
 *   - the **`AudioBuffer`** the game plays from — owned by the audio engine, never transferred;
 *   - **copies** of its first two channels, for analysis. `decodeAudioData` gives out views into
 *     the buffer's own memory, and the analysis worker takes its PCM as *transferable*, which
 *     detaches the underlying `ArrayBuffer`. Handing the live views over would silently empty the
 *     buffer the game is about to play. So the channels are copied, once, and the copy is what
 *     travels to the worker;
 *   - the **original `File`**, kept for storage, because transcoding is optional and lossy (see
 *     OggExport).
 *
 * Decoding itself is done by the browser's own codec, which is what makes "supports MP3" true
 * without shipping a decoder: every browser that can play an MP3 in an `<audio>` tag can decode it
 * here, and everything it cannot decode fails with `NotSupportedError`, which is reported as a
 * readable message instead of a stack trace.
 */

import type { AnalysisOptions } from '../analysis/types';

/** Extensions we accept. The browser's decoder has the final say; this is just a fast, honest gate. */
export const ACCEPTED_EXTENSIONS = [
  '.mp3',
  '.m4a',
  '.aac',
  '.mp4',
  '.wav',
  '.ogg',
  '.oga',
  '.opus',
  '.flac',
  '.webm',
] as const;

export const ACCEPT_MIME = 'audio/*';

/** Capacities above this are refused: decoding has to hold PCM plus a copy in memory. */
export const MAX_FILE_BYTES = 60 * 1024 * 1024;

/** Shorter than this and there is nothing to chart (matches `MIN_ANALYZABLE_MS`). */
export const MIN_IMPORT_MS = 3000;

export type ImportErrorCode =
  | 'empty-file'
  | 'too-large'
  | 'unsupported-type'
  | 'decode-failed'
  | 'context-unavailable'
  | 'too-short';

export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(message: string, code: ImportErrorCode, options?: { cause?: unknown }) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    if (options && 'cause' in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export interface FileFacts {
  name: string;
  sizeBytes: number;
  type: string;
  lastModified: number;
}

export interface DecodedSong {
  file: File;
  facts: FileFacts;
  buffer: AudioBuffer;
  /** Mono-or-stereo copies of the buffer's channels, safe to transfer to the worker. */
  analysisChannels: Float32Array[];
  sampleRate: number;
  channelCount: number;
  durationMs: number;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

export function describeFile(file: File): FileFacts {
  return {
    name: file.name,
    sizeBytes: file.size,
    type: file.type || 'unknown',
    lastModified: file.lastModified || 0,
  };
}

/**
 * Cheap pre-flight checks, so an obviously wrong file fails instantly instead of after a decode
 * attempt. `null` means "go ahead and try to decode".
 */
export function validateAudioFile(file: File): ImportError | null {
  if (!file || file.size === 0) {
    return new ImportError('That file is empty (0 bytes).', 'empty-file');
  }
  if (file.size > MAX_FILE_BYTES) {
    return new ImportError(
      `That file is ${formatBytes(file.size)}; the import limit is ${formatBytes(MAX_FILE_BYTES)}. ` +
        'Trim it or re-encode at a lower bitrate.',
      'too-large',
    );
  }
  const extension = extensionOf(file.name);
  const typeLooksAudio = file.type === '' || file.type.startsWith('audio/') || file.type === 'video/mp4';
  const extensionLooksAudio = (ACCEPTED_EXTENSIONS as readonly string[]).includes(extension);
  if (!typeLooksAudio && !extensionLooksAudio) {
    return new ImportError(
      `“${file.name}” does not look like audio (type ${file.type || 'unknown'}). ` +
        `Supported types: ${ACCEPTED_EXTENSIONS.join(', ')}.`,
      'unsupported-type',
    );
  }
  return null;
}

export interface DecodeOptions {
  context: BaseAudioContext;
  onProgress?: (ratio: number, detail: string) => void;
  /** Longest side of the analysis copy; longer audio is analysed as-is (no resampling). */
  minDurationMs?: number;
}

/**
 * Decode a file with the Web Audio API and produce the copies the analysis needs.
 *
 * `decodeAudioData` detaches the `ArrayBuffer` it is given, so the `File` (not a buffer) is the
 * thing that must be kept if the original is wanted later.
 */
export async function decodeAudioFile(file: File, options: DecodeOptions): Promise<DecodedSong> {
  const failure = validateAudioFile(file);
  if (failure) throw failure;

  const context = options.context;
  if (!context) {
    throw new ImportError('No AudioContext is available to decode with.', 'context-unavailable');
  }

  options.onProgress?.(0.05, `reading ${file.name}`);
  let encoded: ArrayBuffer;
  try {
    encoded = await file.arrayBuffer();
  } catch (cause) {
    throw new ImportError(`Could not read “${file.name}” from disk.`, 'decode-failed', { cause });
  }

  options.onProgress?.(0.2, 'decoding audio');
  let buffer: AudioBuffer;
  try {
    buffer = await decodeAudioData(context, encoded);
  } catch (cause) {
    throw new ImportError(
      `Could not decode “${file.name}”. The file may be corrupt, DRM-protected, or in a format ` +
        'this browser cannot play (try MP3, M4A, WAV, OGG or FLAC).',
      'decode-failed',
      { cause },
    );
  }

  const durationMs = buffer.duration * 1000;
  if (durationMs < MIN_IMPORT_MS) {
    throw new ImportError(
      `That song is only ${formatDuration(durationMs)} long. A chart needs at least ` +
        `${formatDuration(MIN_IMPORT_MS)} of music.`,
      'too-short',
    );
  }

  // Copies, deliberately: the worker transport transfers (detaches) these buffers, and the game
  // still has to be able to play the original.
  const channelCount = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const analysisChannels: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    analysisChannels.push(new Float32Array(buffer.getChannelData(channel)));
  }

  options.onProgress?.(0.35, 'audio decoded');
  return {
    file,
    facts: describeFile(file),
    buffer,
    analysisChannels,
    sampleRate: buffer.sampleRate,
    channelCount: buffer.numberOfChannels,
    durationMs,
  };
}

/**
 * `decodeAudioData` has two historical call shapes (promise and callback). Safari only recently
 * gained the promise form in every version we care about, so the callback form is passed as a
 * fallback and the promise result is preferred.
 */
function decodeAudioData(context: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    let settled = false;
    const done = (buffer: AudioBuffer): void => {
      if (!settled) {
        settled = true;
        resolve(buffer);
      }
    };
    const failed = (error: DOMException | Error | null): void => {
      if (!settled) {
        settled = true;
        reject(error ?? new Error('decodeAudioData failed'));
      }
    };
    try {
      const maybePromise = context.decodeAudioData(data, done, failed) as Promise<AudioBuffer> | undefined;
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(done).catch(failed);
      }
    } catch (error) {
      failed(error as Error);
    }
  });
}

/**
 * Re-open stored audio bytes as an `AudioBuffer` (used when a saved song is loaded from the
 * library rather than imported again).
 */
export async function decodeAudioBlob(blob: Blob, context: BaseAudioContext): Promise<AudioBuffer> {
  const data = await blob.arrayBuffer();
  try {
    return await decodeAudioData(context, data);
  } catch (cause) {
    throw new ImportError('Stored audio could not be decoded; the library entry may be damaged.', 'decode-failed', { cause });
  }
}

/** Which delays analysis options are implied by the sample rate (kept here so callers agree). */
export function analysisOptionsFor(_sampleRate: number): Partial<AnalysisOptions> | undefined {
  // The analysis works at the buffer's own rate: the STFT is size-based, and every timestamp it
  // emits is in milliseconds, so no resampling is needed and none is done (resampling would cost
  // quality and time for nothing).
  return undefined;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
