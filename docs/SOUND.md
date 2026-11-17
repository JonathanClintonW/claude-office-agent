# Sound: music and effects

The office can play calm background music, sound effects for office events and a quiet
keyboard ambience. Sound is **off by default**. Turn it on with **Sound** in the top bar, and
set music, effects and volume under **Settings → Sound**.

Code: `packages/ui/src/audio/engine.ts` (synthesis and scheduling), `music.ts` (the composer),
`cues.ts` (which sound goes with what), `useSound.ts` (settings and page visibility). Tests:
`packages/ui/test/sound.test.ts`.

## How it is made

- **Synthesized in the page.** Everything is generated with the Web Audio API: oscillators,
  filtered noise and envelopes. There are no audio files or samples, nothing is downloaded,
  and nothing needs a network connection or a change to the content security policy.
- **Original music.** `music.ts` writes an endless lo-fi loop bar by bar from a seed: a
  seventh chord on warm keys, a bass line on the chord root, a sparse melody on the major
  pentatonic scale, and a soft beat with a lazy swing. Every 8 bars a new song starts in
  another key with another common chord progression, so it never loops exactly.
- **Day and night.** At night (the office lighting's night mode) the music is slower, has no
  kick or snare, and plays fewer melody notes.
- **Spatial.** Effects are panned left or right by where they happen on screen.

## What you hear

Real cues follow observed agent state only. Simulated cues follow the office animation and say
nothing about real work.

| Sound | When | Source |
| --- | --- | --- |
| Door chime (ding-dong) | A new session, subagent or teammate walks in | Real |
| Rising arpeggio | A turn finished or a subagent completed | Real |
| Two soft pings | An agent now waits for a permission decision or an answer | Real |
| Falling notes | An agent failed | Real |
| Low bonk | A tool call failed | Real |
| Paper whoosh | A verified delegation, task handoff or completion flies between desks | Real |
| Keyboard typing | Agents at their desks running an edit, a shell command or another tool; more typists, more typing | Real |
| Softer door chime | A simulated visitor comes in | Simulated |
| Coffee machine gurgle | Someone (agent or visitor) gets a coffee | Simulated |
| Flush | Someone leaves the restroom | Simulated |
| Soft blips | A simulated template speech line appears | Simulated |
| Music | Always, while music is on | Generated |

Agents already in the office when it opens make no sound. History replays are silent.

## Behavior

- **Off means off.** Until sound is switched on, no audio context exists. Switched off, the
  context is suspended and the scheduler stops, so it costs no CPU.
- **Browsers need a click.** Audio can only start after a click or key press. Switching sound
  on is one. If sound was left on, the first click or key press of a visit starts it.
- **Hidden page.** The music fades out while the page or panel is hidden (background timers
  are throttled) and comes back when it is shown again. Effects still play, so you can hear
  an agent asking for permission while you work elsewhere.
- **Not too much at once.** Each effect has a minimum gap between plays (`MIN_GAP_MS` in
  `cues.ts`), and at most 6 effects start within any one second.
- **Volume.** The slider is applied on a curve (volume to the power 1.5), so low settings stay usable.

## Verifying

```bash
npx vitest run --project ui sound
```
