import { afterEach, describe, expect, it, vi } from 'vitest';
import { cueForStatus, MAX_PER_SECOND, MIN_GAP_MS, REAL_CUES, SIMULATED_CUES } from '../src/audio/cues';
import { SoundEngine } from '../src/audio/engine';
import { BARS_PER_SONG, chordNotes, composeBar, degreeNote, MAJOR, songFor, STEPS_PER_BAR } from '../src/audio/music';

// ---------------------------------------------------------------- a minimal fake Web Audio API

class Param {
  value = 0;
  setValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number) {
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number) {
    this.value = v;
    return this;
  }
}
class Node {
  connect<T>(n: T): T {
    return n;
  }
  disconnect() {}
}
class FakeContext {
  state: AudioContextState = 'suspended';
  currentTime = 0;
  sampleRate = 8000;
  destination = new Node();
  made: Record<string, number> = {};
  private count(k: string) {
    this.made[k] = (this.made[k] ?? 0) + 1;
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
  createGain() {
    this.count('gain');
    return Object.assign(new Node(), { gain: new Param() });
  }
  createOscillator() {
    this.count('osc');
    return Object.assign(new Node(), { type: 'sine', frequency: new Param(), detune: new Param(), start() {}, stop() {} });
  }
  createBiquadFilter() {
    return Object.assign(new Node(), { type: 'lowpass', frequency: new Param(), Q: new Param() });
  }
  createBufferSource() {
    this.count('noise');
    return Object.assign(new Node(), { buffer: null, start() {}, stop() {} });
  }
  createBuffer(_ch: number, len: number) {
    return { getChannelData: () => new Float32Array(len) };
  }
  createStereoPanner() {
    return Object.assign(new Node(), { pan: new Param() });
  }
}

function setup(opts: { clock?: () => number } = {}) {
  const contexts: FakeContext[] = [];
  const engine = new SoundEngine(
    () => {
      const c = new FakeContext();
      contexts.push(c);
      return c as unknown as AudioContext;
    },
    opts.clock ?? (() => 0),
    () => 0.5,
  );
  return { engine, contexts };
}

afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------- music

describe('procedural music', () => {
  it('is deterministic and changes song every few bars', () => {
    expect(songFor(1, 0, 'day')).toEqual(songFor(1, 0, 'day'));
    expect(composeBar(songFor(1, 0, 'day'), 3)).toEqual(composeBar(songFor(1, 0, 'day'), 3));
    const songs = Array.from({ length: 20 }, (_, i) => songFor(7, i, 'day'));
    expect(new Set(songs.map((s) => `${s.key}|${s.progression.join()}`)).size).toBeGreaterThan(3);
    expect(BARS_PER_SONG).toBeGreaterThan(0);
  });

  it('plays calmer and slower at night', () => {
    for (let i = 0; i < 20; i++) {
      const day = songFor(3, i, 'day');
      const night = songFor(3, i, 'night');
      expect(night.bpm).toBeLessThan(day.bpm);
      for (let bar = 0; bar < BARS_PER_SONG; bar++) {
        const voices = composeBar(night, bar).map((n) => n.voice);
        expect(voices).not.toContain('kick');
        expect(voices).not.toContain('snare');
      }
    }
  });

  it('writes notes in key, in range, on the grid, with the chord root in the bass', () => {
    for (let section = 0; section < 30; section++)
      for (const mood of ['day', 'night'] as const) {
        const song = songFor(11, section, mood);
        const scale = new Set(MAJOR.map((i) => (song.key + i) % 12));
        for (let bar = 0; bar < BARS_PER_SONG; bar++) {
          const notes = composeBar(song, bar);
          const deg = song.progression[bar % song.progression.length]!;
          expect(notes.some((n) => n.voice === 'keys')).toBe(true);
          const firstBass = notes.find((n) => n.voice === 'bass' && n.step === 0)!;
          expect(firstBass.midi % 12).toBe(degreeNote(song.key, deg) % 12);
          for (const n of notes) {
            expect(n.step).toBeGreaterThanOrEqual(0);
            expect(n.step).toBeLessThan(STEPS_PER_BAR);
            expect(n.length).toBeGreaterThanOrEqual(1);
            expect(n.velocity).toBeGreaterThan(0);
            expect(n.velocity).toBeLessThanOrEqual(1);
            if (n.midi === 0) continue; // drums
            expect(scale.has(n.midi % 12), `${n.voice} ${n.midi}`).toBe(true);
            // (The bass may pop up an octave for a short pickup at the end of a bar.)
            const [lo, hi] = n.voice === 'bass' ? [36, 72] : n.voice === 'keys' ? [50, 82] : [60, 92];
            expect(n.midi).toBeGreaterThanOrEqual(lo);
            expect(n.midi).toBeLessThanOrEqual(hi);
          }
        }
        expect(chordNotes(song, 0)).toHaveLength(4);
      }
  });
});

// ---------------------------------------------------------------- cues

describe('sound cues', () => {
  it('maps real status changes, never a first sighting', () => {
    expect(cueForStatus(undefined, 'waiting_permission')).toBeUndefined();
    expect(cueForStatus('working', 'working')).toBeUndefined();
    expect(cueForStatus('working', 'waiting_permission')).toBe('attention');
    expect(cueForStatus('working', 'waiting_input')).toBe('attention');
    expect(cueForStatus('working', 'failed')).toBe('failed');
    expect(cueForStatus('working', 'completed')).toBe('done');
    expect(cueForStatus('idle', 'working')).toBeUndefined();
  });

  it('keeps real and simulated cues apart and rate-limits every kind', () => {
    for (const k of REAL_CUES) expect(SIMULATED_CUES).not.toContain(k);
    for (const k of [...REAL_CUES, ...SIMULATED_CUES]) expect(MIN_GAP_MS[k]).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- engine

describe('SoundEngine', () => {
  it('creates no audio at all while sound is off, and waits for a user gesture when on', () => {
    const { engine, contexts } = setup();
    engine.unlock();
    engine.play('done');
    expect(contexts).toHaveLength(0);
    engine.configure({ on: true });
    engine.play('done');
    expect(contexts).toHaveLength(0); // no gesture yet
    engine.unlock();
    expect(contexts).toHaveLength(1);
    expect(engine.state).toBe('running');
    engine.dispose();
  });

  it('plays effects, rate-limited per kind and overall', () => {
    let now = 0;
    const { engine, contexts } = setup({ clock: () => now });
    engine.configure({ on: true, music: false });
    engine.unlock();
    const ctx = contexts[0]!;
    const made = () => (ctx.made.osc ?? 0) + (ctx.made.noise ?? 0);
    engine.play('done');
    const once = made();
    expect(once).toBeGreaterThan(0);
    engine.play('done'); // too soon
    expect(made()).toBe(once);
    now += MIN_GAP_MS.done + 1;
    engine.play('done');
    expect(made()).toBeGreaterThan(once);
    // A burst of different events: at most MAX_PER_SECOND start within one second.
    now += 5_000;
    let played = 0;
    for (const k of ['arrive', 'done', 'attention', 'failed', 'toolFail', 'handoff', 'visitor', 'coffee', 'flush', 'chatter'] as const) {
      const before = made();
      engine.play(k);
      if (made() > before) played++;
    }
    expect(played).toBe(MAX_PER_SECOND);
    engine.dispose();
  });

  it('stays quiet with effects off, applies the volume, and suspends when switched off', () => {
    const { engine, contexts } = setup();
    engine.configure({ on: true, music: false, effects: false, volume: 0.6 });
    engine.unlock();
    const ctx = contexts[0]!;
    engine.play('arrive');
    expect(ctx.made.osc ?? 0).toBe(0);
    engine.configure({ on: false });
    expect(ctx.state).toBe('suspended');
    expect(engine.options.volume).toBe(0.6);
    engine.configure({ volume: 7 });
    expect(engine.options.volume).toBe(1);
    engine.dispose();
  });

  it('schedules music bars only while music is on and the page is visible', () => {
    vi.useFakeTimers();
    const { engine, contexts } = setup();
    engine.configure({ on: true, music: true, effects: false });
    engine.unlock();
    const ctx = contexts[0]!;
    vi.advanceTimersByTime(250);
    const afterBar = ctx.made.osc ?? 0;
    expect(afterBar).toBeGreaterThan(5);
    // Hidden page: no more bars.
    engine.setHidden(true);
    ctx.currentTime += 30;
    vi.advanceTimersByTime(1_000);
    expect(ctx.made.osc ?? 0).toBe(afterBar);
    engine.setHidden(false);
    vi.advanceTimersByTime(250);
    expect(ctx.made.osc ?? 0).toBeGreaterThan(afterBar);
    engine.dispose();
  });

  it('types along with the agents that are typing, and stops when the office stops reporting', () => {
    vi.useFakeTimers();
    let now = 0;
    const { engine, contexts } = setup({ clock: () => now });
    engine.configure({ on: true, music: false });
    engine.unlock();
    const ctx = contexts[0]!;
    vi.advanceTimersByTime(300);
    expect(ctx.made.noise ?? 0).toBe(0); // nobody typing
    engine.ambience(3, false);
    vi.advanceTimersByTime(300);
    const clicks = ctx.made.noise ?? 0;
    expect(clicks).toBeGreaterThan(0);
    now += 10_000; // no report for a while (office hidden)
    ctx.currentTime += 10;
    vi.advanceTimersByTime(300);
    expect(ctx.made.noise ?? 0).toBe(clicks);
    engine.dispose();
  });

  it('is silent without Web Audio', () => {
    const engine = new SoundEngine(() => undefined);
    engine.configure({ on: true });
    expect(() => {
      engine.unlock();
      engine.play('done');
      engine.ambience(2, true);
    }).not.toThrow();
    expect(engine.state).toBe('none');
  });
});
