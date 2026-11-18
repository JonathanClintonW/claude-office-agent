/**
 * Procedural lo-fi background music written bar by bar from a seed. Pure and deterministic
 * (engine.ts plays the notes); every 8 bars a new key and progression start, so it never loops exactly.
 */

export type Mood = 'day' | 'night';
export type Voice = 'keys' | 'bass' | 'lead' | 'kick' | 'snare' | 'hat';

/** One note on the 16-step grid of a 4/4 bar. Drums have `midi` 0. */
export interface NoteEvent {
  voice: Voice;
  /** 0..15 (sixteenth notes). */
  step: number;
  /** Length in steps. */
  length: number;
  midi: number;
  /** 0..1 */
  velocity: number;
}

export interface Song {
  seed: number;
  mood: Mood;
  bpm: number;
  /** MIDI note of the key's tonic (major scale). */
  key: number;
  /** One chord per bar, as scale degrees (0 = I). Four bars, repeated. */
  progression: readonly number[];
}

export const STEPS_PER_BAR = 16;
export const BARS_PER_SONG = 8;
export const MAJOR = [0, 2, 4, 5, 7, 9, 11] as const;
/** Major pentatonic degrees: the melody stays on these, so it never clashes. */
const PENTATONIC = [0, 1, 2, 4, 5] as const;

/** Common, generic progressions (scale degrees); chord progressions are building blocks, not tunes. */
export const PROGRESSIONS: readonly (readonly number[])[] = [
  [0, 5, 3, 4],
  [1, 4, 0, 5],
  [5, 3, 0, 4],
  [0, 3, 1, 4],
  [3, 4, 2, 5],
  [0, 2, 3, 4],
];
/** Tonics around F3..A3, comfortable for warm keys. */
const KEYS = [53, 55, 57, 58, 60] as const;

/** Small deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(r() * list.length))]!;

/** MIDI note of scale degree `deg` (may exceed 6: next octave) in a major key. */
export function degreeNote(key: number, deg: number): number {
  const oct = Math.floor(deg / 7);
  const d = ((deg % 7) + 7) % 7;
  return key + MAJOR[d]! + 12 * oct;
}

/** The song for section `section` (8 bars each) of a seeded stream of music. */
export function songFor(seed: number, section: number, mood: Mood): Song {
  const r = prng(seed * 7919 + section * 104729 + (mood === 'night' ? 17 : 0));
  return { seed: Math.floor(r() * 2 ** 31), mood, bpm: mood === 'night' ? 64 + Math.floor(r() * 6) : 78 + Math.floor(r() * 8), key: pick(r, KEYS), progression: pick(r, PROGRESSIONS) };
}

/** The four notes of the seventh chord on `deg`, voiced around middle C. */
export function chordNotes(song: Song, deg: number): number[] {
  return [0, 2, 4, 6].map((i) => degreeNote(song.key, deg + i));
}

/** All notes of bar `bar` (0-based within the song) on the 16-step grid. */
export function composeBar(song: Song, bar: number): NoteEvent[] {
  const r = prng(song.seed + bar * 31337);
  const deg = song.progression[bar % song.progression.length]!;
  const out: NoteEvent[] = [];
  const night = song.mood === 'night';

  // Keys: the chord, held for the bar or played as two halves with a soft push.
  const chord = chordNotes(song, deg);
  const rhythm = pick(r, night ? [[[0, 16]], [[0, 10], [10, 6]]] : [[[0, 8], [8, 8]], [[0, 6], [6, 10]], [[0, 16]], [[0, 10], [10, 6]]]);
  for (const [step, length] of rhythm) for (const midi of chord) out.push({ voice: 'keys', step: step!, length: length!, midi, velocity: night ? 0.38 : 0.45 });

  // Bass: the chord root an octave or two down, with a fifth or a pickup now and then.
  const root = degreeNote(song.key, deg) - 12;
  out.push({ voice: 'bass', step: 0, length: night ? 12 : 6, midi: root, velocity: 0.7 });
  if (!night) {
    out.push({ voice: 'bass', step: 8, length: 4, midi: r() < 0.5 ? root : root + 7, velocity: 0.6 });
    if (r() < 0.5) out.push({ voice: 'bass', step: 14, length: 2, midi: root + 12, velocity: 0.45 });
  }

  // Melody: sparse pentatonic notes above the chord.
  const notes = night ? 1 + Math.floor(r() * 3) : 2 + Math.floor(r() * 5);
  const steps = new Set<number>();
  while (steps.size < notes) steps.add(pick(r, night ? [0, 4, 8, 12, 6, 10] : [0, 2, 3, 4, 6, 7, 8, 10, 11, 12, 14]));
  let prev = 7 + Math.floor(r() * 3);
  for (const step of [...steps].sort((a, b) => a - b)) {
    // Small steps up or down the pentatonic scale make a singable line.
    prev = Math.max(5, Math.min(12, prev + pick(r, [-2, -1, -1, 0, 1, 1, 2])));
    const oct = Math.floor(prev / 5);
    const midi = degreeNote(song.key, PENTATONIC[prev % 5]! + 7 * oct);
    out.push({ voice: 'lead', step, length: pick(r, [2, 2, 3, 4]), midi, velocity: night ? 0.3 : 0.4 });
  }

  // Beat.
  if (!night) {
    const kicks = pick(r, [[0, 7, 10], [0, 8, 10], [0, 6, 8]]);
    for (const step of kicks) out.push({ voice: 'kick', step, length: 1, midi: 0, velocity: step === 0 ? 0.9 : 0.7 });
    for (const step of [4, 12]) out.push({ voice: 'snare', step, length: 1, midi: 0, velocity: 0.55 });
  }
  for (let step = 0; step < STEPS_PER_BAR; step += 2) {
    if (night && step % 4 === 0) continue; // off-beat hats only at night
    out.push({ voice: 'hat', step, length: 1, midi: 0, velocity: (step % 4 === 0 ? 0.35 : 0.22) * (night ? 0.6 : 1) });
  }
  return out;
}

export function midiHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}
