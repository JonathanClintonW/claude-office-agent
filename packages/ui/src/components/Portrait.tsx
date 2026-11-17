import type { Agent } from '@agent-office/core';
import { drawCharacter, lookFor, type Pose } from '../office/pixelArt';

const cache = new Map<string, string>();

/** The agent's own office sprite as an image (same look as in the scene). */
export function portraitUrl(agent: Pick<Agent, 'key' | 'kind' | 'sessionId'>, pose: Pose = 'stand'): string | undefined {
  const role = agent.kind === 'session' ? 'session' : agent.kind === 'teammate' ? 'teammate' : 'subagent';
  const key = `${agent.key}|${role}|${pose}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit || undefined;
  try {
    const url = drawCharacter(lookFor(agent.key, role, agent.sessionId), pose).toDataURL();
    cache.set(key, url);
    return url;
  } catch {
    cache.set(key, ''); // no canvas (e.g. tests): render the frame without a sprite
    return undefined;
  }
}

export function Portrait({ agent, scale = 2, pose }: { agent: Pick<Agent, 'key' | 'kind' | 'sessionId'>; scale?: number; pose?: Pose }) {
  const url = portraitUrl(agent, pose);
  return (
    <span className="portrait" style={{ width: 16 * scale + 8, height: 24 * scale + 8 }} aria-hidden>
      {url ? <img src={url} width={16 * scale} height={24 * scale} alt="" draggable={false} /> : null}
    </span>
  );
}
