/**
 * Office sound synthesized in the page with the Web Audio API: no audio files, nothing downloaded,
 * no network. Nothing is created until sound is on and a click or key press unlocks it (`unlock()`).
 * Sound off suspends the context; a hidden page fades the music (timers are throttled) but still
 * plays effects so a permission prompt can be heard.
 */
import { MAX_PER_SECOND, MIN_GAP_MS, type SfxKind } from './cues';
import { BARS_PER_SONG, composeBar, midiHz, songFor, STEPS_PER_BAR, type Mood, type NoteEvent, type Song } from './music';

export type { SfxKind } from './cues';

export interface SoundOptions {
  /** Master switch. */
  on: boolean;
  music: boolean;
  /** Sound effects and the typing ambience. */
  effects: boolean;
  /** 0..1 */
  volume: number;
}

/** What the office scene needs: one-shot effects and the current activity level. */
export interface SoundSink {
  /** One effect; `pan` from -1 (left) to 1 (right). Rate-limited per kind. */
  play(kind: SfxKind, pan?: number): void;
  /** How many agents are typing at their desks right now, and whether it is night (music mood). */
  ambience(typing: number, night: boolean): void;
}

/** Scheduler period and how far ahead notes are scheduled (s). */
const TICK_MS = 100;
const LOOKAHEAD_S = 0.6;
/** Typing goes quiet when the scene stops reporting (e.g. the office view is hidden). */
const AMBIENCE_STALE_MS = 4_000;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function defaultContext(): AudioContext | undefined {
  const C = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  return C ? new C({ latencyHint: 'playback' }) : undefined;
}

export class SoundEngine implements SoundSink {
  private ctx?: AudioContext;
  private master?: GainNode;
  private sfxBus?: GainNode;
  private ambBus?: GainNode;
  private musicBus?: GainNode;
  private noise?: AudioBuffer;
  private opts: SoundOptions = { on: false, music: true, effects: true, volume: 0.5 };
  private hidden = false;
  private timer?: ReturnType<typeof setInterval>;
  private lastPlayed = new Map<SfxKind, number>();
  private recent: number[] = [];
  // music
  private mood: Mood = 'day';
  private readonly seed = Math.floor(Math.random() * 1e9);
  private section = 0;
  private bar = BARS_PER_SONG;
  private song?: Song;
  private nextBarAt = 0;
  // typing ambience
  private typing = 0;
  private typingAt = -Infinity;
  private nextClickAt = 0;
  private ambPans?: AudioNode[];

  constructor(
    private readonly create: () => AudioContext | undefined = defaultContext,
    private readonly clock: () => number = () => Date.now(),
    private readonly rand: () => number = Math.random,
  ) {}

  get options(): Readonly<SoundOptions> {
    return this.opts;
  }

  /** The AudioContext state, or 'none' before sound was ever switched on (diagnostics, tests). */
  get state(): AudioContextState | 'none' {
    return this.ctx?.state ?? 'none';
  }

  configure(o: Partial<SoundOptions>): void {
    this.opts = { ...this.opts, ...o, volume: clamp(o.volume ?? this.opts.volume, 0, 1) };
    this.apply();
  }

  /** Call from a click or key press: creates the audio graph (first time) and resumes it. */
  unlock(): void {
    if (!this.opts.on) return;
    if (!this.ctx) {
      const ctx = this.create();
      if (!ctx) return; // no Web Audio here: stay silent
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0;
      // A gentle low-pass keeps everything soft and lo-fi.
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 5_000;
      this.master.connect(tone).connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = 1.6;
      this.sfxBus.connect(this.master);
      this.ambBus = ctx.createGain();
      this.ambBus.gain.value = 0.7;
      this.ambBus.connect(this.master);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().then(() => this.apply());
    this.apply();
  }

  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.apply();
  }

  play(kind: SfxKind, pan = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.opts.on || !this.opts.effects || ctx.state !== 'running' || !this.sfxBus) return;
    const now = this.clock();
    if (now - (this.lastPlayed.get(kind) ?? -Infinity) < MIN_GAP_MS[kind]) return;
    this.recent = this.recent.filter((t) => now - t < 1_000);
    if (this.recent.length >= MAX_PER_SECOND) return;
    this.lastPlayed.set(kind, now);
    this.recent.push(now);
    this.effect(kind, ctx.currentTime + 0.01, this.panned(this.sfxBus, clamp(pan, -1, 1)));
  }

  ambience(typing: number, night: boolean): void {
    this.typing = clamp(Math.floor(typing), 0, 8);
    this.typingAt = this.clock();
    const mood: Mood = night ? 'night' : 'day';
    if (mood !== this.mood) {
      this.mood = mood;
      this.bar = BARS_PER_SONG; // the next bar starts a new song in the new mood
    }
  }

  /** Stop everything and release the audio device (tests, teardown). */
  dispose(): void {
    this.stopLoop();
    void this.ctx?.close();
    this.ctx = undefined;
    this.musicBus = undefined;
  }

  private apply(): void {
    const ctx = this.ctx;
    if (!this.opts.on) {
      this.stopLoop();
      this.stopMusic();
      if (ctx?.state === 'running') void ctx.suspend();
      return;
    }
    if (!ctx || !this.master) return; // waiting for unlock() on a user gesture
    if (ctx.state === 'suspended') void ctx.resume();
    const v = this.opts.volume;
    this.master.gain.setTargetAtTime(v ** 1.5, ctx.currentTime, 0.05);
    if (this.opts.music && !this.hidden) this.startMusic();
    else this.stopMusic();
    if (!this.timer) this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private startMusic(): void {
    const ctx = this.ctx!;
    if (this.musicBus) return;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.setValueAtTime(0, ctx.currentTime);
    this.musicBus.gain.linearRampToValueAtTime(1, ctx.currentTime + 1.5);
    this.musicBus.connect(this.master!);
    this.nextBarAt = ctx.currentTime + 0.1;
  }

  private stopMusic(): void {
    const bus = this.musicBus;
    if (!bus || !this.ctx) return;
    this.musicBus = undefined;
    bus.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
    // Notes already scheduled die out on the faded bus; drop it once they are done.
    setTimeout(() => bus.disconnect(), 4_000);
  }

  private tick(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (this.musicBus) {
      if (this.nextBarAt < now) this.nextBarAt = now + 0.05; // after a stall, continue cleanly
      while (this.nextBarAt < now + LOOKAHEAD_S) this.scheduleBar(this.nextBarAt);
    }
    const typing = this.opts.effects && this.clock() - this.typingAt < AMBIENCE_STALE_MS ? this.typing : 0;
    if (typing > 0) {
      if (this.nextClickAt < now) this.nextClickAt = now + 0.02;
      while (this.nextClickAt < now + LOOKAHEAD_S) {
        this.keyClick(this.nextClickAt);
        // Typists type in short bursts; more of them fill the gaps.
        const pause = this.rand() < 0.12 ? 0.4 + this.rand() * 0.9 : 0.07 + this.rand() * 0.12;
        this.nextClickAt += pause / Math.sqrt(typing);
      }
    }
  }

  private scheduleBar(t: number): void {
    if (!this.song || this.bar >= BARS_PER_SONG) {
      this.song = songFor(this.seed, this.section++, this.mood);
      this.bar = 0;
    }
    const song = this.song;
    const step = 60 / song.bpm / 4;
    for (const n of composeBar(song, this.bar)) {
      const swing = n.step % 2 === 1 ? step * 0.14 : 0; // lazy lo-fi swing
      this.note(n, t + n.step * step + swing, n.length * step);
    }
    this.bar++;
    this.nextBarAt = t + STEPS_PER_BAR * step;
  }

  private note(n: NoteEvent, t: number, dur: number): void {
    const out = this.musicBus;
    if (!out) return;
    const hz = midiHz(n.midi);
    switch (n.voice) {
      case 'keys':
        // Soft electric-piano-like tone: a warm body plus a quiet bell an octave up.
        this.tone(out, 'triangle', hz, t, dur + 0.4, n.velocity * 0.1, 0.015, 1_400, { detune: 4 });
        this.tone(out, 'sine', hz * 2, t, 0.6, n.velocity * 0.025, 0.005, 3_000);
        break;
      case 'bass':
        this.tone(out, 'triangle', hz, t, dur, n.velocity * 0.3, 0.01, 450);
        break;
      case 'lead':
        this.tone(out, 'sine', hz, t, dur + 0.2, n.velocity * 0.14, 0.02, 2_200, { vibrato: true });
        break;
      case 'kick': {
        const ctx = this.ctx!;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.frequency.setValueAtTime(130, t);
        osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
        g.gain.setValueAtTime(n.velocity * 0.5, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
        osc.connect(g).connect(out);
        osc.start(t);
        osc.stop(t + 0.3);
        break;
      }
      case 'snare':
        this.noiseHit(out, t, 0.16, n.velocity * 0.12, 'bandpass', 1_800, { q: 0.8 });
        this.tone(out, 'triangle', 190, t, 0.08, n.velocity * 0.05, 0.002, 1_000);
        break;
      case 'hat':
        this.noiseHit(out, t, 0.035, n.velocity * 0.06, 'highpass', 7_000);
        break;
    }
  }

  private effect(kind: SfxKind, t: number, out: AudioNode): void {
    switch (kind) {
      case 'arrive': // ding-dong at the door
        this.tone(out, 'sine', 880, t, 0.7, 0.2, 0.005, 6_000);
        this.tone(out, 'sine', 659.25, t + 0.2, 0.9, 0.18, 0.005, 6_000);
        break;
      case 'visitor': // a softer, lower door chime
        this.tone(out, 'sine', 659.25, t, 0.6, 0.1, 0.005, 5_000);
        this.tone(out, 'sine', 523.25, t + 0.22, 0.8, 0.09, 0.005, 5_000);
        break;
      case 'done': // a short rising arpeggio
        [72, 76, 79, 84].forEach((m, i) => this.tone(out, 'triangle', midiHz(m), t + i * 0.07, 0.4, 0.12, 0.005, 5_000));
        break;
      case 'attention': // two gentle pings
        this.tone(out, 'square', 1_046.5, t, 0.2, 0.05, 0.004, 2_400);
        this.tone(out, 'square', 1_046.5, t + 0.17, 0.25, 0.05, 0.004, 2_400);
        break;
      case 'failed': // a falling minor third
        this.tone(out, 'triangle', 392, t, 0.3, 0.14, 0.01, 2_000);
        this.tone(out, 'triangle', 311.13, t + 0.2, 0.5, 0.14, 0.01, 2_000);
        break;
      case 'toolFail': // a small low bonk
        this.tone(out, 'sine', 220, t, 0.22, 0.12, 0.004, 1_500, { glideTo: 150 });
        break;
      case 'handoff': // paper whoosh
        this.noiseHit(out, t, 0.35, 0.07, 'bandpass', 500, { q: 2, sweepTo: 3_000, attack: 0.08 });
        break;
      case 'coffee': // the machine gurgles and hisses
        this.noiseHit(out, t, 1.2, 0.015, 'highpass', 4_000, { attack: 0.2 });
        for (let i = 0; i < 8; i++) this.noiseHit(out, t + 0.1 + this.rand() * 1.1, 0.07, 0.06, 'lowpass', 450 + this.rand() * 200);
        break;
      case 'coin': // two quick bright notes
        this.tone(out, 'square', 988, t, 0.07, 0.025, 0.003, 6_000);
        this.tone(out, 'square', 1319, t + 0.07, 0.22, 0.025, 0.003, 6_000);
        break;
      case 'flush':
        this.noiseHit(out, t, 1.3, 0.08, 'lowpass', 2_500, { sweepTo: 250, attack: 0.15 });
        break;
      case 'chatter': {
        // A few soft blips: someone is talking (simulated template speech).
        const n = 3 + Math.floor(this.rand() * 3);
        for (let i = 0; i < n; i++) this.tone(out, 'sine', 480 + this.rand() * 340, t + i * 0.08, 0.07, 0.035, 0.005, 3_000, { glideTo: 560 + this.rand() * 340 });
        break;
      }
    }
  }

  private keyClick(t: number): void {
    const out = this.ambBus;
    if (!out) return;
    // A few fixed positions across the room (no new panner per click).
    if (!this.ambPans) this.ambPans = [-0.4, -0.2, 0, 0.2, 0.4].map((p) => this.panned(out, p, false));
    const space = this.rand() < 0.1;
    const dest = this.ambPans[Math.floor(this.rand() * this.ambPans.length)]!;
    if (space) this.noiseHit(dest, t, 0.03, 0.05, 'bandpass', 900, { q: 1.5 });
    else this.noiseHit(dest, t, 0.018, 0.035 + this.rand() * 0.03, 'bandpass', 2_500 + this.rand() * 1_500, { q: 1.2 });
  }

  /** One enveloped oscillator through a low-pass filter. */
  private tone(
    out: AudioNode,
    type: OscillatorType,
    hz: number,
    t: number,
    dur: number,
    peak: number,
    attack: number,
    cutoff: number,
    o: { detune?: number; glideTo?: number; vibrato?: boolean } = {},
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(hz, t);
    if (o.glideTo) osc.frequency.exponentialRampToValueAtTime(o.glideTo, t + dur);
    if (o.detune) osc.detune.setValueAtTime(o.detune, t);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(cutoff, t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.setTargetAtTime(0.0001, t + attack, Math.max(0.02, dur / 3));
    osc.connect(f).connect(g).connect(out);
    if (o.vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 5;
      depth.gain.value = 6;
      lfo.connect(depth).connect(osc.detune);
      lfo.start(t);
      lfo.stop(t + dur + 0.6);
    }
    osc.start(t);
    osc.stop(t + dur + 0.6);
  }

  /** A filtered burst of white noise. */
  private noiseHit(
    out: AudioNode,
    t: number,
    dur: number,
    peak: number,
    type: BiquadFilterType,
    freq: number,
    o: { q?: number; sweepTo?: number; attack?: number } = {},
  ): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer();
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (o.sweepTo) f.frequency.exponentialRampToValueAtTime(o.sweepTo, t + dur);
    if (o.q !== undefined) f.Q.value = o.q;
    const g = ctx.createGain();
    if (o.attack) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + o.attack);
    } else g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, this.rand() * 0.5);
    src.stop(t + dur + 0.05);
  }

  private noiseBuffer(): AudioBuffer {
    if (!this.noise) {
      const ctx = this.ctx!;
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = this.rand() * 2 - 1;
      this.noise = buf;
    }
    return this.noise;
  }

  /** `out`, panned left or right when the browser supports it (a one-shot panner is released after its sound). */
  private panned(out: AudioNode, pan: number, oneShot = true): AudioNode {
    const ctx = this.ctx!;
    if (!pan || typeof ctx.createStereoPanner !== 'function') return out;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    p.connect(out);
    if (oneShot) setTimeout(() => p.disconnect(), 4_000);
    return p;
  }
}

let shared: SoundEngine | undefined;

/** The page's one sound engine (music keeps playing across views). */
export function soundEngine(): SoundEngine {
  return (shared ??= new SoundEngine());
}
