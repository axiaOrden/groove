/**
 * Renders "Neon Circuit" (the built-in demo song) into an AudioBuffer with OfflineAudioContext.
 *
 * Why synthesise instead of shipping an audio file?
 *  - The demo needs to be *original* (README: "Use original artwork, branding, and demo audio").
 *  - The repository stays free of binary music assets, and there is no download step.
 *  - The synthesised track is rendered into a normal AudioBuffer, so it flows through exactly
 *    the same playback/timing path that an uploaded MP3 will use in phase 2.
 *
 * The notes it plays come from the same hand-authored section definitions as the chart
 * (src/content/demoSong.ts), so the demo chart is synchronised with the demo audio by
 * construction rather than by hand-tuned numbers in two places.
 *
 * Determinism: the noise used for drums comes from a seeded PRNG, so the rendered buffer is
 * reproducible (it is not part of the chart-determinism guarantee, just a nicety).
 */

import {
  DEMO_BAR_MS,
  DEMO_DRUM_STEPS,
  DEMO_LEAD_STEPS,
  SECTIONS,
  demoBars,
  demoBarCount,
  demoDegreeHz,
  demoFifthHz,
  demoRootHz,
} from '../content/demoSong';

/** Extra silence after the last bar so the final notes ring out. */
export const DEMO_TRACK_TAIL_MS = 2500;

export interface SynthProgress {
  (ratio: number, label: string): void;
}

/** Deterministic PRNG (mulberry32) so the noise floor is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createNoiseBuffer(ctx: BaseAudioContext, seconds = 2): AudioBuffer {
  const frames = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const random = mulberry32(0x5eed1234);
  for (let i = 0; i < frames; i += 1) {
    data[i] = random() * 2 - 1;
  }
  return buffer;
}

function noiseSource(ctx: BaseAudioContext, noise: AudioBuffer, time: number, duration: number): AudioBufferSourceNode {
  const source = ctx.createBufferSource();
  source.buffer = noise;
  source.loop = true;
  // Offset keeps successive hits from being bit-identical.
  source.start(time, (time * 7.13) % Math.max(0.05, noise.duration - duration - 0.05));
  source.stop(time + duration);
  return source;
}

function kick(ctx: BaseAudioContext, out: AudioNode, time: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(145, time);
  osc.frequency.exponentialRampToValueAtTime(46, time + 0.11);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(0.9, time + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.3);

  osc.connect(gain).connect(out);
  osc.start(time);
  osc.stop(time + 0.32);
}

function snare(ctx: BaseAudioContext, out: AudioNode, time: number, noise: AudioBuffer): void {
  const source = noiseSource(ctx, noise, time, 0.2);
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 1600;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(0.42, time + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.17);

  source.connect(highpass).connect(gain).connect(out);

  const body = ctx.createOscillator();
  body.type = 'triangle';
  body.frequency.setValueAtTime(196, time);
  const bodyGain = ctx.createGain();
  bodyGain.gain.setValueAtTime(0.0001, time);
  bodyGain.gain.exponentialRampToValueAtTime(0.22, time + 0.004);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.1);
  body.connect(bodyGain).connect(out);
  body.start(time);
  body.stop(time + 0.12);
}

function hat(ctx: BaseAudioContext, out: AudioNode, time: number, noise: AudioBuffer, accent: boolean): void {
  const source = noiseSource(ctx, noise, time, 0.06);
  const highpass = ctx.createBiquadFilter();
  highpass.type = 'highpass';
  highpass.frequency.value = 7800;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(accent ? 0.24 : 0.15, time + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + (accent ? 0.07 : 0.045));

  source.connect(highpass).connect(gain).connect(out);
}

function bassPluck(ctx: BaseAudioContext, out: AudioNode, time: number, hz: number, duration: number): void {
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = hz;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(620, time);
  filter.frequency.exponentialRampToValueAtTime(240, time + duration);
  filter.Q.value = 6;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(0.34, time + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + duration * 0.92);

  osc.connect(filter).connect(gain).connect(out);
  osc.start(time);
  osc.stop(time + duration);
}

function pad(ctx: BaseAudioContext, out: AudioNode, time: number, rootHz: number, duration: number): void {
  const ratios = [1, 2 ** (3 / 12), 2 ** (7 / 12)]; // minor triad
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.linearRampToValueAtTime(0.075, time + duration * 0.3);
  gain.gain.linearRampToValueAtTime(0.055, time + duration * 0.75);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1500;
  filter.connect(gain).connect(out);

  ratios.forEach((ratio, index) => {
    const osc = ctx.createOscillator();
    osc.type = index === 0 ? 'triangle' : 'sine';
    osc.frequency.value = rootHz * 2 * ratio;
    osc.detune.value = (index - 1) * 4;
    osc.connect(filter);
    osc.start(time);
    osc.stop(time + duration);
  });
}

function lead(ctx: BaseAudioContext, out: AudioNode, time: number, hz: number, duration: number): void {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(0.19, time + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(3400, time);
  filter.frequency.exponentialRampToValueAtTime(1400, time + duration);
  filter.connect(gain).connect(out);

  [-7, 7].forEach((cents) => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = hz;
    osc.detune.value = cents;
    osc.connect(filter);
    osc.start(time);
    osc.stop(time + duration);
  });
}

export interface RenderDemoOptions {
  sampleRate: number;
  onProgress?: SynthProgress;
}

/** Render the demo song to an AudioBuffer. Never touches the destination device. */
export async function renderDemoTrack(options: RenderDemoOptions): Promise<AudioBuffer> {
  const { sampleRate, onProgress } = options;
  const report = onProgress ?? (() => {});

  if (typeof OfflineAudioContext === 'undefined') {
    throw new Error('OfflineAudioContext is not available in this browser');
  }

  const bars = demoBars();
  const totalMs = demoBarCount() * DEMO_BAR_MS + DEMO_TRACK_TAIL_MS;
  const frames = Math.ceil((totalMs / 1000) * sampleRate);
  const ctx = new OfflineAudioContext(2, frames, sampleRate);

  const master = ctx.createGain();
  master.gain.value = 0.85;
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -12;
  compressor.knee.value = 24;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.006;
  compressor.release.value = 0.18;
  master.connect(compressor).connect(ctx.destination);

  const noise = createNoiseBuffer(ctx);
  const barSec = DEMO_BAR_MS / 1000;
  const drumStepSec = barSec / DEMO_DRUM_STEPS;
  const leadStepSec = barSec / DEMO_LEAD_STEPS;

  report(0.05, 'Composing demo track…');

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index]!;
    const section = SECTIONS[bar.sectionId];
    const barTime = bar.startMs / 1000;
    const rootHz = demoRootHz(bar.barIndex);

    // Drums ------------------------------------------------------------------
    for (let step = 0; step < DEMO_DRUM_STEPS; step += 1) {
      const time = barTime + step * drumStepSec;
      if (section.drums.kick[step] === 'K') kick(ctx, master, time);
      if (section.drums.snare[step] === 'S') snare(ctx, master, time, noise);
      const hatChar = section.drums.hat[step];
      if (hatChar === 'h' || hatChar === 'H') hat(ctx, master, time, noise, hatChar === 'H');
    }

    // Bass / pad -------------------------------------------------------------
    for (let step = 0; step < DEMO_DRUM_STEPS; step += 1) {
      const symbol = section.bass[step];
      if (symbol === '.') continue;
      const hz = symbol === '5' ? demoFifthHz(bar.barIndex, 1) : rootHz;
      bassPluck(ctx, master, barTime + step * drumStepSec, hz, drumStepSec * 0.9);
    }
    if (section.pad) pad(ctx, master, barTime, rootHz, barSec);

    // Lead -------------------------------------------------------------------
    if (section.lead) {
      const tokens = section.lead.trim().split(/\s+/);
      for (let step = 0; step < Math.min(DEMO_LEAD_STEPS, tokens.length); step += 1) {
        const token = tokens[step]!;
        if (token === '.') continue;
        const degree = Number(token);
        if (!Number.isFinite(degree) || degree < 1 || degree > 8) continue;
        lead(ctx, master, barTime + step * leadStepSec, demoDegreeHz(bar.barIndex, degree), leadStepSec * 0.95);
      }
    }

    // Keep the UI responsive while scheduling ~450 nodes.
    if (index % 6 === 5) {
      report(0.05 + (index / bars.length) * 0.45, `Composing demo track… bar ${index + 1}/${bars.length}`);
      await nextTask();
    }
  }

  report(0.5, 'Rendering demo audio…');
  const buffer = await ctx.startRendering();
  report(1, 'Demo track ready');
  return buffer;
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
