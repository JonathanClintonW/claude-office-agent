// Local display settings. Nothing here is sent to any model.
import { enableSound } from '../audio/useSound';
import { DepartmentRules } from '../components/DepartmentRules';
import { useSettings, type OfficeSettings } from '../settings';
import type { ViewProps } from './types';

export function SettingsView(_props: ViewProps) {
  const [s, update] = useSettings();
  return (
    <section className="page settings" aria-label="Settings">
      <h2>Settings</h2>
      <p className="muted small">Stored locally in this browser/webview. They change only how the office is drawn and simulated.</p>
      <div className="settings-grid">
        <label className="ctl">
          <span>Animation FPS</span>
          <select value={s.animationFps} onChange={(e) => update({ animationFps: Number(e.target.value) as OfficeSettings['animationFps'] })}>
            <option value={15}>15 (lowest CPU)</option>
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
        </label>
        <label className="ctl">
          <span>Idle activity</span>
          <select value={s.idleFrequency} onChange={(e) => update({ idleFrequency: e.target.value as OfficeSettings['idleFrequency'] })}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </label>
        <label className="ctl check" title="People with a lavender visitor badge walk in, check in at reception, look around, chat and leave. They are a local simulation, never agents.">
          <input type="checkbox" checked={s.visitors} onChange={(e) => update({ visitors: e.target.checked })} />
          <span>Simulated visitors</span>
        </label>
        <label className="ctl check">
          <input type="checkbox" checked={s.roomLabels} onChange={(e) => update({ roomLabels: e.target.checked })} />
          <span>Room labels</span>
        </label>
        <label className="ctl check">
          <input type="checkbox" checked={s.minimap} onChange={(e) => update({ minimap: e.target.checked })} />
          <span>Mini-map</span>
        </label>
        <label className="ctl check">
          <input type="checkbox" checked={s.reduceMotion} onChange={(e) => update({ reduceMotion: e.target.checked })} />
          <span>Reduce motion</span>
        </label>
      </div>
      <h3>Sound</h3>
      <p className="muted small">
        Music and effects are made in this page with the Web Audio API: no audio files, nothing downloaded. Effects follow real events
        (an agent arrives, finishes, needs permission or an answer, fails) and the office animation (coffee, restroom, small talk,
        visitors).
      </p>
      <div className="settings-grid">
        <label className="ctl check">
          <input
            type="checkbox"
            checked={s.sound}
            onChange={(e) => {
              update({ sound: e.target.checked });
              if (e.target.checked) enableSound();
            }}
          />
          <span>Sound</span>
        </label>
        <label className="ctl check">
          <input type="checkbox" checked={s.music} disabled={!s.sound} onChange={(e) => update({ music: e.target.checked })} />
          <span>Music</span>
        </label>
        <label className="ctl check">
          <input type="checkbox" checked={s.soundEffects} disabled={!s.sound} onChange={(e) => update({ soundEffects: e.target.checked })} />
          <span>Sound effects</span>
        </label>
        <label className="ctl">
          <span>Volume</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(s.volume * 100)}
            disabled={!s.sound}
            aria-valuetext={`${Math.round(s.volume * 100)}%`}
            onChange={(e) => update({ volume: Number(e.target.value) / 100 })}
          />
        </label>
      </div>
      <h3>Departments</h3>
      <p className="muted small">
        Local rules that seat agents in department rooms. They match real observed fields (agent type, directory, name); they are a
        convenience, not a verified Claude role.
      </p>
      <DepartmentRules />
    </section>
  );
}
