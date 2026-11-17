// Connects the sound engine to the settings, the page visibility and the first user gesture.
import { useEffect } from 'react';
import { useSettings } from '../settings';
import { soundEngine, type SoundEngine } from './engine';

/** Turn sound on from a click or key handler (browsers only start audio inside a user gesture). */
export function enableSound(): void {
  const e = soundEngine();
  e.configure({ on: true });
  e.unlock();
}

export function useSound(): SoundEngine {
  const [s] = useSettings();
  const engine = soundEngine();

  useEffect(() => engine.configure({ on: s.sound, music: s.music, effects: s.soundEffects, volume: s.volume }), [engine, s.sound, s.music, s.soundEffects, s.volume]);

  // Sound was left on last time: start it on the first click or key press of this visit.
  useEffect(() => {
    if (!s.sound) return;
    const unlock = () => engine.unlock();
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
    };
  }, [engine, s.sound]);

  useEffect(() => {
    const onVisibility = () => engine.setHidden(document.hidden);
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [engine]);

  return engine;
}
