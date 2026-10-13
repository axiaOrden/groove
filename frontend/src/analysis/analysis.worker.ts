/**
 * Analysis Web Worker.
 *
 * The worker exists for one reason: analysing a 4-minute track takes ~1.5 s of pure CPU (FFT over
 * ~18k frames), and doing that on the main thread freezes the renderer, the import UI and the
 * progress bar it is supposed to be updating. The analysis itself is a pure function of the sample
 * arrays (see MusicAnalyzer), so moving it off-thread changes nothing about its results — the
 * worker is a transport, not a second implementation.
 *
 * Protocol (structured clone, plus `ArrayBuffer` transfer for the PCM so a 40 MB stereo decode is
 * not copied):
 *
 *   main → worker   { type: 'analyze', requestId, sampleRate, channels: Float32Array[], options? }
 *   worker → main   { type: 'progress', requestId, progress: { stage, ratio, detail? } }
 *   worker → main   { type: 'result',   requestId, result: AnalysisResult }
 *   worker → main   { type: 'error',    requestId, message: string }
 *
 * Chromium/Firefox/Safari all support module workers (`new Worker(url, { type: 'module' })`) in
 * 2026; `AnalysisClient` still knows how to run the same function on the main thread, both as a
 * fallback for exotic environments and so tests can exercise the pipeline in Node.
 */

import { analyzeSong } from './MusicAnalyzer';
import type { AnalysisOptions, AnalysisResult } from './types';
import type { AnalysisProgress } from './MusicAnalyzer';

export interface AnalyzeRequest {
  type: 'analyze';
  requestId: number;
  sampleRate: number;
  /** Decoded PCM, one array per channel; transferred, so the sender's copies are detached. */
  channels: Float32Array[];
  options?: Partial<AnalysisOptions>;
}

export type AnalysisWorkerRequest = AnalyzeRequest;

export type AnalysisWorkerResponse =
  | { type: 'progress'; requestId: number; progress: AnalysisProgress }
  | { type: 'result'; requestId: number; result: AnalysisResult }
  | { type: 'error'; requestId: number; message: string };

/** The worker body, exported so it can be driven directly in tests without a Worker. */
export function handleAnalyzeRequest(
  request: AnalyzeRequest,
  post: (response: AnalysisWorkerResponse) => void,
): void {
  try {
    const result = analyzeSong(
      { channels: request.channels, sampleRate: request.sampleRate, options: request.options },
      {
        onProgress: (progress) => post({ type: 'progress', requestId: request.requestId, progress }),
      },
    );
    post({ type: 'result', requestId: request.requestId, result });
  } catch (error) {
    post({
      type: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

interface WorkerScopeLike {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<AnalysisWorkerRequest>) => void) | null;
  document?: unknown;
}

// Register the handler only in a real worker scope. Guarded three ways (no `self`, no
// `postMessage`, or a `document` present) so that importing this module from a main-thread bundle
// or from Node — as the tests do — cannot hijack the page's message handling.
const scope =
  typeof globalThis !== 'undefined' ? (globalThis as unknown as WorkerScopeLike) : undefined;

if (scope && typeof scope.postMessage === 'function' && scope.document === undefined) {
  scope.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
    const request = event.data;
    if (!request || request.type !== 'analyze') return;
    handleAnalyzeRequest(request, (response) => scope.postMessage(response));
  };
}
