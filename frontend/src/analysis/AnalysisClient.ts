/**
 * Main-thread client for the analysis worker.
 *
 * One `AnalysisClient` owns at most one in-flight request; `analyze()` returns a promise that
 * resolves with the `AnalysisResult` (or rejects with a readable error) and reports progress
 * meanwhile. Two transports:
 *
 *   - **worker** (preferred): a module worker created from `analysis.worker.ts`. The PCM channels
 *     are *transferred*, not copied, so a big decode costs no extra memory.
 *   - **inline** (fallback): the identical `analyzeSong` function runs on the main thread, yielding
 *     nothing and blocking until done. Used when `Worker`/module workers are unavailable (older
 *     Safari, `file://`, some embedded webviews) and by the Node test suite. The UI is told which
 *     transport ran so it can say "analysis may freeze the page" honestly instead of silently
 *     hanging.
 *
 * The worker is created lazily and terminated after each run: a second analysis creates a fresh
 * worker, which keeps the memory (an 18k-frame feature set is tens of MB) from being pinned between
 * imports.
 */

import { analyzeSong } from './MusicAnalyzer';
import type { AnalysisProgress } from './MusicAnalyzer';
import type { AnalysisWorkerResponse } from './analysis.worker';
import type { AnalysisOptions, AnalysisResult } from './types';

export type { AnalysisProgress };

export type AnalysisTransport = 'worker' | 'inline';

export interface AnalysisClientResult {
  result: AnalysisResult;
  transport: AnalysisTransport;
}

export interface AnalyzeRequestOptions {
  sampleRate: number;
  channels: Float32Array[];
  options?: Partial<AnalysisOptions>;
  onProgress?: (progress: AnalysisProgress) => void;
  /** Force the inline path (tests, or a user preference for debugging). */
  forceInline?: boolean;
  signal?: AbortSignal;
}

export function supportsAnalysisWorker(): boolean {
  return typeof Worker === 'function' && typeof URL !== 'undefined';
}

export class AnalysisClient {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private busy = false;

  /**
   * Analyse decoded PCM. Resolves with the result and which transport produced it.
   *
   * The input channels are detached when the worker transport is used (they are transferred), so
   * callers must not reuse them afterwards; the decoded `AudioBuffer` the game plays from is a
   * separate copy and is never touched.
   */
  async analyze(request: AnalyzeRequestOptions): Promise<AnalysisClientResult> {
    if (this.busy) throw new Error('an analysis is already running');
    if (typeof request.sampleRate !== 'number' || !(request.sampleRate > 0)) {
      throw new Error('sampleRate must be a positive number');
    }
    if (request.channels.length === 0) throw new Error('no audio channels to analyse');

    if (request.forceInline || !supportsAnalysisWorker()) {
      return { result: this.analyzeInline(request), transport: 'inline' };
    }

    this.busy = true;
    try {
      const result = await this.analyzeInWorker(request);
      return { result, transport: 'worker' };
    } finally {
      this.busy = false;
    }
  }

  /** Terminate the worker and cancel the in-flight analysis, if any. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
  }

  private analyzeInline(request: AnalyzeRequestOptions): AnalysisResult {
    request.onProgress?.({ stage: 'prepare', ratio: 0 });
    const result = analyzeSong(
      { channels: request.channels, sampleRate: request.sampleRate, options: request.options },
      { onProgress: request.onProgress },
    );
    request.onProgress?.({ stage: 'done', ratio: 1 });
    return result;
  }

  private analyzeInWorker(request: AnalyzeRequestOptions): Promise<AnalysisResult> {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    let worker: Worker;
    try {
      worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      // A browser that cannot create a module worker still gets a working import (on the main
      // thread), so the failure mode is a slow page, not a broken feature.
      return Promise.resolve(this.analyzeInline(request));
    }
    this.worker = worker;

    return new Promise<AnalysisResult>((resolve, reject) => {
      const cleanup = (): void => {
        worker.terminate();
        if (this.worker === worker) this.worker = null;
        request.signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new Error('analysis cancelled'));
      };
      if (request.signal?.aborted) {
        onAbort();
        return;
      }
      request.signal?.addEventListener('abort', onAbort, { once: true });

      worker.onerror = (event) => {
        cleanup();
        reject(new Error(`analysis worker failed: ${event.message || 'unknown error'}`));
      };
      worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
        const message = event.data;
        if (!message || message.requestId !== requestId) return;
        if (message.type === 'progress') {
          request.onProgress?.(message.progress);
          return;
        }
        cleanup();
        if (message.type === 'result') resolve(message.result);
        else reject(new Error(message.message));
      };

      // Transfer the PCM so the worker does not have to copy it.
      worker.postMessage(
        {
          type: 'analyze',
          requestId,
          sampleRate: request.sampleRate,
          channels: request.channels,
          options: request.options,
        },
        request.channels.map((channel) => channel.buffer),
      );
    });
  }
}
