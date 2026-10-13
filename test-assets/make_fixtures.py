#!/usr/bin/env python3
"""Generate the Phase 2 analysis fixtures.

These are *ground-truth* audio files: every tone is placed at an exact millisecond, so the
analysis pipeline's BPM / beat / onset output can be compared against a known answer instead of
against a hand-wave. They are deliberately small (a few hundred kB each) and are encoded to MP3
by ffmpeg afterwards, so the browser sees a real, decoded-from-MP3 signal.

    python3 test-assets/make_fixtures.py

Writes 16-bit PCM WAV files next to this script and then encodes them to .mp3 with libmp3lame.
The musical tracks are simple but structured (kick/snare/hat, bass, pad, melody) so the analyser
has accents and phrasing to work with, not just a metronome.

Known answers (asserted by frontend/tests/fixture-analysis.test.ts; see PHASE2_1_NOTES.md):
    rx128   128 BPM, 4/4, beat 0 at 0 ms, beat period 468.75 ms   (stereo)
    rx96     96 BPM, 4/4, beat 0 at 0 ms, beat period 625 ms
    dense   140 BPM with 16th hats and off-beat kicks
    quiet   128 BPM at about -30 dBFS (variable intensity)
    silence 5 s of digital silence
    short   0.35 s of tone (too short to analyse)
"""

import math
import os
import struct
import subprocess
import wave

RATE = 44100
HERE = os.path.dirname(os.path.abspath(__file__))


class Rng:
    """Deterministic whitespace noise (mulberry32), so fixtures are byte-identical across runs."""

    def __init__(self, seed: int) -> None:
        self.state = seed & 0xFFFFFFFF

    def next(self) -> float:
        self.state = (self.state + 0x6D2B79F5) & 0xFFFFFFFF
        t = self.state
        t = (t ^ (t >> 15)) * (t | 1) & 0xFFFFFFFF
        t ^= (t + ((t ^ (t >> 7)) * (t | 61) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return (((t ^ (t >> 14)) & 0xFFFFFFFF)) / 4294967296.0

    def bipolar(self) -> float:
        return self.next() * 2.0 - 1.0


class Track:
    """A mono float buffer with additive instruments, rendered at exact sample positions."""

    def __init__(self, duration_ms: float) -> None:
        self.n = int(RATE * duration_ms / 1000.0)
        self.buf = [0.0] * self.n
        self.rng = Rng(0x5EED)

    def add(self, start_ms: float, samples, gain: float = 1.0) -> None:
        start = int(RATE * start_ms / 1000.0)
        for i, value in enumerate(samples):
            index = start + i
            if 0 <= index < self.n:
                self.buf[index] += value * gain

    # ------------------------------------------------------------- instruments ---

    def kick(self, at_ms: float, gain: float = 1.0) -> None:
        length = int(0.16 * RATE)
        out = []
        for i in range(length):
            t = i / RATE
            env = math.exp(-t * 22.0)
            freq = 52.0 + 55.0 * math.exp(-t * 60.0)
            out.append(math.sin(2 * math.pi * freq * t) * env)
        self.add(at_ms, out, gain)

    def snare(self, at_ms: float, gain: float = 1.0) -> None:
        length = int(0.13 * RATE)
        out = []
        for i in range(length):
            t = i / RATE
            env = math.exp(-t * 34.0)
            noise = self.rng.bipolar()
            body = math.sin(2 * math.pi * 190.0 * t) * 0.5
            out.append((noise * 0.8 + body) * env)
        self.add(at_ms, out, gain)

    def hat(self, at_ms: float, gain: float = 1.0) -> None:
        length = int(0.045 * RATE)
        out = []
        previous = 0.0
        for i in range(length):
            t = i / RATE
            env = math.exp(-t * 90.0)
            # Crude high-pass: difference of consecutive noise samples.
            noise = self.rng.bipolar()
            out.append((noise - previous) * 0.5 * env)
            previous = noise
        self.add(at_ms, out, gain)

    def tone(self, at_ms: float, duration_ms: float, freq: float, gain: float = 1.0, decay: float = 6.0) -> None:
        length = int(RATE * duration_ms / 1000.0)
        out = []
        for i in range(length):
            t = i / RATE
            env = math.exp(-t * decay)
            out.append(
                (math.sin(2 * math.pi * freq * t)
                 + 0.35 * math.sin(4 * math.pi * freq * t)
                 + 0.12 * math.sin(6 * math.pi * freq * t)) * env
            )
        self.add(at_ms, out, gain)

    def pad(self, at_ms: float, duration_ms: float, freqs, gain: float = 0.2) -> None:
        length = int(RATE * duration_ms / 1000.0)
        out = []
        attack = int(0.08 * RATE)
        release = int(0.25 * RATE)
        for i in range(length):
            t = i / RATE
            env = 1.0
            if i < attack:
                env = i / attack
            elif i > length - release:
                env = max(0.0, (length - i) / release)
            value = sum(math.sin(2 * math.pi * f * t) for f in freqs)
            out.append(value / len(freqs) * env)
        self.add(at_ms, out, gain)

    # ------------------------------------------------------------------- write ---

    def scaled(self, peak: float = 0.92) -> list:
        current = max((abs(v) for v in self.buf), default=0.0)
        factor = (peak / current) if current > 0 else 0.0
        return [v * factor for v in self.buf]


def write_wav(path: str, samples, channels: int = 1) -> None:
    with wave.open(path, 'wb') as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        frames = bytearray()
        for value in samples:
            clipped = max(-1.0, min(1.0, value))
            encoded = struct.pack('<h', int(round(clipped * 32767)))
            frames.extend(encoded * channels)
        wav.writeframes(bytes(frames))


def encode(wav_path: str, mp3_path: str, bitrate: str = '192k') -> None:
    subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error', '-i', wav_path, '-codec:a', 'libmp3lame',
         '-b:a', bitrate, mp3_path],
        check=True,
    )
    size = os.path.getsize(mp3_path)
    print(f'  {os.path.basename(mp3_path)}: {size / 1024:.0f} kB')


def musical_track(bpm: float, bars: int, melody: bool = True, quiet: bool = False, last_bar_silent: bool = False) -> Track:
    """Kick on every beat, snare on 2 and 4, hats on eighths, bass + pad per bar."""
    beat_ms = 60000.0 / bpm
    bar_ms = beat_ms * 4
    track = Track(bar_ms * bars)
    scale = [110.0, 130.81, 146.83, 164.81, 196.0, 220.0]
    for bar in range(bars):
        start = bar * bar_ms
        if last_bar_silent and bar == bars - 1:
            continue
        # A quiet first bar (pad only) exercises "do not place notes in low-energy sections".
        intro = bar == 0
        for beat in range(4):
            at = start + beat * beat_ms
            if not intro and (beat % 2 == 0 or beat == 3):
                track.kick(at, 1.0 if beat == 0 else 0.85)
            if not intro and beat in (1, 3):
                track.snare(at, 0.7)
            for eighth in (0.0, 0.5):
                if not intro:
                    track.hat(at + eighth * beat_ms, 0.25 if eighth else 0.4)
        root = scale[bar % len(scale)]
        if not intro:
            track.tone(start, beat_ms * 0.9, root / 2, 0.5, decay=5.0)          # bass
            track.tone(start + 2 * beat_ms, beat_ms * 0.9, root / 2 * 1.5, 0.35, decay=5.0)
        track.pad(start, bar_ms, [root, root * 1.25, root * 1.5], 0.16 if intro else 0.13)
        if melody and bar >= 2 and not intro:
            for step in range(8):
                freq = scale[(bar * 3 + step * 2) % len(scale)] * 2
                if step % 3 == 0:
                    track.tone(start + step * beat_ms / 2, beat_ms * 0.42, freq, 0.3, decay=7.0)
    gain = 0.03 if quiet else 1.0
    return track, gain


def main() -> None:
    print('writing fixtures to', HERE)

    # 128 BPM reference: 12 bars = 22.5 s, one quiet intro bar, one silent tail bar, stereo.
    track, gain = musical_track(128.0, 12, melody=True, last_bar_silent=True)
    samples = [v * gain for v in track.scaled()]
    wav = os.path.join(HERE, 'rx128.wav')
    write_wav(wav, samples, channels=2)
    encode(wav, os.path.join(HERE, 'rx128.mp3'))

    # 96 BPM: a second unambiguous tempo, mono, 8 bars = 20 s.
    track, gain = musical_track(96.0, 8, melody=True)
    write_wav(os.path.join(HERE, 'rx96.wav'), [v * gain for v in track.scaled()])
    encode(os.path.join(HERE, 'rx96.wav'), os.path.join(HERE, 'rx96.mp3'))

    # Dense 140 BPM: 16th hats + off-beat kicks, to exercise density limiting.
    beat_ms = 60000.0 / 140.0
    dense = Track(beat_ms * 4 * 8)
    for bar in range(8):
        start = bar * beat_ms * 4
        for sixteenth in range(16):
            dense.hat(start + sixteenth * beat_ms / 4, 0.35 if sixteenth % 4 else 0.5)
        for beat in range(4):
            dense.kick(start + beat * beat_ms, 0.9)
            dense.kick(start + beat * beat_ms + beat_ms / 2, 0.6)  # off-beat kicks
            dense.snare(start + beat * beat_ms + beat_ms / 2, 0.5)
        dense.tone(start, beat_ms * 2, 110.0 / 2, 0.4, decay=3.0)
    write_wav(os.path.join(HERE, 'dense.wav'), dense.scaled())
    encode(os.path.join(HERE, 'dense.wav'), os.path.join(HERE, 'dense.mp3'))

    # Very quiet but identical music: variable intensity / low-energy handling.
    track, gain = musical_track(128.0, 8, melody=True)
    write_wav(os.path.join(HERE, 'quiet.wav'), [v * gain for v in track.scaled()])
    encode(os.path.join(HERE, 'quiet.wav'), os.path.join(HERE, 'quiet.mp3'))

    # Edge cases: silence, and a file too short to analyse.
    write_wav(os.path.join(HERE, 'silence.wav'), [0.0] * int(RATE * 5))
    encode(os.path.join(HERE, 'silence.wav'), os.path.join(HERE, 'silence.mp3'), '96k')

    tone = Track(350.0)
    tone.tone(0.0, 340.0, 440.0, 0.8, decay=0.0)
    write_wav(os.path.join(HERE, 'short.wav'), tone.scaled())
    encode(os.path.join(HERE, 'short.wav'), os.path.join(HERE, 'short.mp3'), '96k')

    print('done')


if __name__ == '__main__':
    main()
