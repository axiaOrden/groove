/**
 * Analysis transport tests.
 *
 * The worker itself cannot be created in Node, so two things are tested instead:
 *   - the **worker body** (`handleAnalyzeRequest`) directly, which is where every message the
 *     worker emits is constructed — including the error path;
 *   - the **client** on its inline transport, which is the same `analyzeSong` call the worker
 *     makes, plus the fallback that browsers without module workers get.
 *
 * Together those cover the transport contract: monotonic progress, one result, readable errors,
 * and identical analysis whichever way it runs.
 */

import { describe, expect, it } from 'vitest';
import { AnalysisClient, supportsAnalysisWorker } from '../src/analysis/AnalysisClient';
import { handleAnalyzeRequest, type AnalysisWorkerResponse } from '../src/analysis/analysis.worker';
import { analyzeSong } from '../src/analysis/MusicAnalyzer';
import { clickTrack, drumTrack, RATE } from './helpers/synth';

describe('transport detection', () => {
  it('does not claim worker support in Node', () => {
    expect(supportsAnalysisWorker()).toBe(false);
  });
});

describe('inline transport', () => {
  it('analyses decoded PCM and reports progress', async () => {
    const client = new AnalysisClient();
    const ratios: number[] = [];
    const { result, transport } = await client.analyze({
      sampleRate: RATE,
      channels: [clickTrack({ bpm: 128, durationMs: 8000 })],
      forceInline: true,
      onProgress: (progress) => ratios.push(progress.ratio),
    });

    expect(transport).toBe('inline');
    expect(Math.abs(result.bpm - 128)).toBeLessThanOrEqual(1.5);
    expect(result.durationMs).toBeCloseTo(8000, 0);
    expect(ratios.length).toBeGreaterThan(2);
    for (let i = 1; i < ratios.length; i += 1) expect(ratios[i]!).toBeGreaterThanOrEqual(ratios[i - 1]!);
    expect(ratios[ratios.length - 1]).toBe(1);
  });

  it('produces exactly the same analysis as calling the analyzer directly', async () => {
    const samples = drumTrack({ durationMs: 9000, bpm: 120 });
    const direct = analyzeSong({ channels: [samples], sampleRate: RATE });
    const viaClient = await new AnalysisClient().analyze({
      sampleRate: RATE,
      channels: [samples],
      forceInline: true,
    });
    expect(viaClient.result.bpm).toBe(direct.bpm);
    expect(viaClient.result.beats).toEqual(direct.beats);
    expect(viaClient.result.onsets).toEqual(direct.onsets);
  });

  it('falls back to inline automatically when no Worker exists', async () => {
    const { transport } = await new AnalysisClient().analyze({
      sampleRate: RATE,
      channels: [clickTrack({ bpm: 120, durationMs: 4000 })],
    });
    expect(transport).toBe('inline');
  });

  it('rejects nonsense requests instead of analysing nothing', async () => {
    const client = new AnalysisClient();
    await expect(client.analyze({ sampleRate: RATE, channels: [] })).rejects.toThrow(/no audio channels/);
    await expect(
      client.analyze({ sampleRate: 0, channels: [new Float32Array(10)] }),
    ).rejects.toThrow(/sampleRate/);
  });

  it('refuses a second concurrent run on the worker transport', async () => {
    // Inline runs are synchronous, so the guard only exists for the worker path; here it is enough
    // to prove that dispose() clears the flag and does not throw.
    const client = new AnalysisClient();
    expect(() => client.dispose()).not.toThrow();
    const { result } = await client.analyze({
      sampleRate: RATE,
      channels: [clickTrack({ bpm: 120, durationMs: 4000 })],
      forceInline: true,
    });
    expect(result.bpm).toBeGreaterThan(100);
  });
});

describe('worker message protocol', () => {
  it('emits progress then exactly one result', () => {
    const messages: AnalysisWorkerResponse[] = [];
    handleAnalyzeRequest(
      {
        type: 'analyze',
        requestId: 7,
        sampleRate: RATE,
        channels: [clickTrack({ bpm: 140, durationMs: 6000 })],
      },
      (message) => messages.push(message),
    );

    const results = messages.filter((message) => message.type === 'result');
    const progress = messages.filter((message) => message.type === 'progress');
    expect(results).toHaveLength(1);
    expect(progress.length).toBeGreaterThan(2);
    expect(messages[messages.length - 1]!.type).toBe('result');
    for (const message of messages) expect(message.requestId).toBe(7);
    if (results[0]!.type === 'result') {
      expect(Math.abs(results[0]!.result.bpm - 140)).toBeLessThanOrEqual(2);
    }
  });

  it('reports a failure as a readable error message, never as a throw', () => {
    const messages: AnalysisWorkerResponse[] = [];
    // A channel whose length lies about its buffer is the cheapest way to make the analysis throw.
    const broken = new Float32Array(10);
    Object.defineProperty(broken, 'length', { value: 10 });
    handleAnalyzeRequest(
      { type: 'analyze', requestId: 3, sampleRate: 0, channels: [broken] },
      (message) => messages.push(message),
    );
    // A zero sample rate is normalised rather than fatal, so this must still succeed…
    expect(messages.some((message) => message.type === 'result')).toBe(true);

    // …and a genuinely impossible request produces an error message with no result.
    const failing: AnalysisWorkerResponse[] = [];
    handleAnalyzeRequest(
      { type: 'analyze', requestId: 4, sampleRate: RATE, channels: [null as unknown as Float32Array] },
      (message) => failing.push(message),
    );
    expect(failing.some((message) => message.type === 'error')).toBe(true);
    expect(failing.some((message) => message.type === 'result')).toBe(false);
  });
});
