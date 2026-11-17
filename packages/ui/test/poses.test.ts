import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentStatus } from '@agent-office/core';
import {
  drawBubble,
  drawCharacter,
  drawScreen,
  drawSpeechBubble,
  lookFor,
  SCREEN_ANIMATION,
  SCREEN_KINDS,
  SIM_SPEECH_STYLE,
  SPRITE_POSES,
  type Pose,
} from '../src/office/pixelArt';
import {
  ACTOR_POSES,
  classifyTool,
  FACES,
  failureKind,
  IDLE_DESK_POSES,
  idleDeskPose,
  idleStandPose,
  looksLikeBuild,
  looksLikeTest,
  seatedFrame,
  spritePose,
  THINKING_DETAIL,
  WORK_MODES,
  workPresentation,
  type WorkInput,
} from '../src/office/poses';

// ------------------------------------------------------------------ fake 2D canvas (jsdom has none)

const pixels = new WeakMap<HTMLCanvasElement, Uint8ClampedArray>();
const realGetContext = HTMLCanvasElement.prototype.getContext;

function fakeGetContext(this: HTMLCanvasElement): CanvasRenderingContext2D {
  const c = this;
  const data = new Uint8ClampedArray(c.width * c.height * 4);
  pixels.set(c, data);
  const ctx = {
    imageSmoothingEnabled: true,
    fillStyle: '#000000' as string,
    fillRect(x: number, y: number, w: number, h: number) {
      const n = parseInt(String(ctx.fillStyle).slice(1), 16);
      for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++) {
          if (xx < 0 || yy < 0 || xx >= c.width || yy >= c.height) continue;
          const i = (yy * c.width + xx) * 4;
          data[i] = (n >> 16) & 255;
          data[i + 1] = (n >> 8) & 255;
          data[i + 2] = n & 255;
          data[i + 3] = 255;
        }
    },
    getImageData(_x: number, _y: number, w: number, h: number) {
      return { data: data.slice(), width: w, height: h };
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = fakeGetContext as unknown as typeof realGetContext;
});
afterAll(() => {
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

const image = (c: HTMLCanvasElement) => {
  const d = pixels.get(c)!;
  return Array.from(d).join(',');
};
const colors = (c: HTMLCanvasElement) => {
  const d = pixels.get(c)!;
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < d.length; i += 4) if (d[i + 3]) out.push([d[i]!, d[i + 1]!, d[i + 2]!]);
  return out;
};

const LOOKS = [lookFor('a', 'session', 's1'), lookFor('b', 'subagent', 's2'), lookFor('c', 'teammate', 's3'), lookFor('dd', 'session', 's4')];
const STATUS_POSES: Pose[] = ['stand_raise', 'stand_cheer', 'stand_slump', 'sit_raise', 'sit_cheer', 'sit_slump', 'think'];
const NEW_POSES: Pose[] = [
  'read',
  'eat',
  'stretch',
  'sit_meeting',
  'sit_meeting_side',
  'present',
  'present_front',
  'present_up',
  'wave',
  'wave1',
  'water',
  'talk_front',
  'sit_read',
  'sit_read1',
  'sit_lean',
  'sit_debug',
  'sit_think',
];

describe('spritePose', () => {
  it('maps every ActorPose and facing to a pose drawCharacter supports', () => {
    for (const pose of ACTOR_POSES)
      for (const face of FACES)
        for (const activity of [undefined, 'plant', 'coffee', 'meeting'])
          for (const frame of [0, 1, 2]) {
            const s = spritePose(pose, face, { activity, frame });
            expect(SPRITE_POSES, `${pose}/${face}`).toContain(s.pose);
            expect(typeof s.flip).toBe('boolean');
            // Simulated activities never borrow poses that signal real status.
            expect(STATUS_POSES).not.toContain(s.pose);
          }
  });

  it('uses dedicated sprites for the new activities', () => {
    expect(spritePose('read', 'up').pose).toBe('read');
    expect(spritePose('eat', 'down').pose).toBe('eat');
    expect(spritePose('stretch', 'down').pose).toBe('stretch');
    expect(spritePose('sit_meeting', 'down').pose).toBe('sit_meeting');
    expect(spritePose('sit_meeting', 'left')).toEqual({ pose: 'sit_meeting_side', flip: true });
    expect(spritePose('sit_meeting', 'up').pose).toBe('sit');
    expect(spritePose('present', 'right')).toEqual({ pose: 'present', flip: false });
    expect(spritePose('present', 'down').pose).toBe('present_front');
    expect(spritePose('present', 'up').pose).toBe('present_up');
    expect(spritePose('wave', 'down', { frame: 0 }).pose).toBe('wave');
    expect(spritePose('wave', 'down', { frame: 1 }).pose).toBe('wave1');
    expect(spritePose('stand', 'left', { activity: 'plant' })).toEqual({ pose: 'water', flip: true });
    expect(spritePose('talk', 'right')).toEqual({ pose: 'side_talk', flip: false });
    expect(spritePose('talk', 'down').pose).toBe('talk_front');
  });

  it('keeps the existing mappings', () => {
    expect(spritePose('stand', 'up')).toEqual({ pose: 'walk_up_0', flip: false });
    expect(spritePose('stand', 'down')).toEqual({ pose: 'stand', flip: false });
    expect(spritePose('stand', 'left')).toEqual({ pose: 'walk_side_0', flip: true });
    expect(spritePose('couch', 'down').pose).toBe('couch');
    expect(spritePose('drink', 'down').pose).toBe('drink');
    expect(spritePose('talk', 'left')).toEqual({ pose: 'side_talk', flip: true });
  });
});

describe('drawCharacter', () => {
  it('draws every sprite pose for every role', () => {
    for (const look of LOOKS)
      for (const pose of SPRITE_POSES) {
        const c = drawCharacter(look, pose);
        expect(c.width).toBe(16);
        expect(c.height).toBe(24);
        expect(colors(c).length, pose).toBeGreaterThan(60);
      }
  });

  it('gives each new pose its own image', () => {
    for (const look of LOOKS) {
      const imgs = new Map(SPRITE_POSES.map((p) => [p, image(drawCharacter(look, p))]));
      for (const p of NEW_POSES)
        for (const q of SPRITE_POSES) if (q !== p) expect(imgs.get(p) === imgs.get(q), `${p} vs ${q}`).toBe(false);
    }
  });

  it('is deterministic', () => {
    for (const p of NEW_POSES) expect(image(drawCharacter(LOOKS[0]!, p))).toBe(image(drawCharacter(LOOKS[0]!, p)));
  });
});

describe('drawScreen', () => {
  it('draws every screen kind and animates the animated ones', () => {
    expect(new Set(SCREEN_KINDS).size).toBe(Object.keys(SCREEN_ANIMATION).length);
    for (const kind of SCREEN_KINDS) {
      const { frames, ms } = SCREEN_ANIMATION[kind];
      expect(ms).toBeGreaterThan(0);
      const imgs = new Set<string>();
      for (let f = 0; f < frames; f++) {
        const c = drawScreen(kind, f, 3);
        expect(colors(c)).toHaveLength(10 * 8); // fully painted
        imgs.add(image(c));
      }
      if (frames > 1) expect(imgs.size, kind).toBeGreaterThan(1);
    }
  });

  it('gives the new screens distinct looks', () => {
    const imgs = SCREEN_KINDS.map((k) => image(drawScreen(k, 1, 3)));
    expect(new Set(imgs).size).toBe(SCREEN_KINDS.length);
  });

  it('never suggests a test outcome while tests run (no green or red)', () => {
    for (let f = 0; f < SCREEN_ANIMATION.test.frames; f++)
      for (const [r, g, b] of colors(drawScreen('test', f, 1))) {
        expect(g > r + 60 && g > b + 60).toBe(false);
        expect(r > g + 80 && r > b + 80).toBe(false);
      }
  });
});

describe('drawSpeechBubble', () => {
  it('draws the simulated style, unlike status bubbles', () => {
    const c = drawSpeechBubble(40, 12);
    expect([c.width, c.height]).toEqual([40, 15]);
    const hex = (v: string) => [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16)].join(',');
    const used = new Set(colors(c).map((x) => x.join(',')));
    expect(used.has(hex(SIM_SPEECH_STYLE.fill))).toBe(true);
    expect(used.has(hex(SIM_SPEECH_STYLE.border))).toBe(true);
    expect(colors(drawBubble('done')).some((x) => x.join(',') === hex(SIM_SPEECH_STYLE.fill))).toBe(false);
    expect(drawSpeechBubble(1, 1).width).toBeGreaterThanOrEqual(12);
  });
});

// ------------------------------------------------------------------ real working states

const work = (over: Partial<WorkInput>) => workPresentation({ status: 'working', ...over });

describe('workPresentation', () => {
  it('maps non-working statuses', () => {
    const by = (status: AgentStatus, extra: Partial<WorkInput> = {}) => workPresentation({ status, ...extra });
    expect(by('waiting_permission')).toEqual({ mode: 'permission', seatedPose: 'sit_raise', screen: 'perm' });
    expect(by('waiting_input')).toEqual({ mode: 'input', seatedPose: 'sit', screen: 'ask' });
    expect(by('failed')).toEqual({ mode: 'failed', seatedPose: 'sit_slump', screen: 'fail' });
    expect(by('completed')).toEqual({ mode: 'finishing', seatedPose: 'sit_cheer', screen: 'done' });
    expect(by('idle')).toEqual({ mode: 'idle', seatedPose: 'sit', screen: 'saver' });
    expect(by('idle', { justFinished: true }).mode).toBe('finishing');
    expect(by('unknown').screen).toBe('noise');
    expect(by('ended').screen).toBe('off');
    // Waiting states win over a running tool.
    expect(by('waiting_permission', { toolName: 'Bash', toolSummary: 'npm test' }).mode).toBe('permission');
  });

  it('chooses the desk animation from the running tool', () => {
    expect(work({ toolName: 'Read' })).toEqual({ mode: 'reading', seatedPose: 'sit_read', screen: 'read' });
    expect(work({ toolName: 'WebFetch' }).mode).toBe('reading');
    for (const t of ['Grep', 'Glob', 'WebSearch']) expect(work({ toolName: t })).toEqual({ mode: 'searching', seatedPose: 'sit_read', screen: 'search' });
    for (const t of ['Edit', 'Write', 'MultiEdit']) expect(work({ toolName: t })).toEqual({ mode: 'editing', seatedPose: 'type0', screen: 'edit' });
    expect(work({ toolName: 'Bash', toolSummary: 'npx vitest run' })).toEqual({ mode: 'testing', seatedPose: 'sit_lean', screen: 'test' });
    expect(work({ toolName: 'Bash', toolSummary: 'Run the unit tests' }).mode).toBe('testing');
    expect(work({ toolName: 'Bash', detail: 'npm test' }).mode).toBe('testing'); // summary falls back to the detail
    expect(work({ toolName: 'Bash', toolSummary: 'ls -la' })).toEqual({ mode: 'command', seatedPose: 'type0', screen: 'terminal' });
    expect(work({ toolName: 'PowerShell', toolSummary: 'npm run build' }).mode).toBe('command');
    expect(work({ toolName: 'Bash', toolSummary: 'npm run build', recentFailure: 'build' })).toEqual({ mode: 'debugging', seatedPose: 'sit_debug', screen: 'debug' });
    expect(work({ toolName: 'Bash', toolSummary: 'npm test', recentFailure: 'test' }).mode).toBe('testing');
    expect(work({ toolName: 'Edit', recentFailure: 'test' }).mode).toBe('editing');
    for (const t of ['Agent', 'Task', 'BashOutput']) expect(work({ toolName: t })).toEqual({ mode: 'waiting', seatedPose: 'sit_lean', screen: 'wait' });
    expect(work({ toolName: 'mcp__github__create_issue' })).toEqual({ mode: 'tool', seatedPose: 'sit', screen: 'code' });
    expect(work({ toolName: 'TodoWrite' }).mode).toBe('tool');
  });

  it('shows debugging after a real failure when no tool runs', () => {
    expect(work({ recentFailure: 'tool' }).mode).toBe('debugging');
    expect(work({ detail: 'Recovering from Bash failure' }).mode).toBe('debugging');
    expect(work({ detail: THINKING_DETAIL, recentFailure: 'test' }).mode).toBe('debugging');
  });

  it("shows thinking only for statusDetail exactly 'Thinking'", () => {
    expect(THINKING_DETAIL).toBe('Thinking');
    expect(work({ detail: 'Thinking' })).toEqual({ mode: 'thinking', seatedPose: 'sit_think', screen: 'think' });
    for (const detail of [undefined, '', 'thinking', 'Thinking…', 'Thinking...', ' Thinking', 'Prompt received', 'Busy (session registry)', 'Started', 'Compacting context'])
      expect(work({ detail }).screen, String(detail)).toBe('busy');
    expect(work({ detail: 'Thinking', stale: true }).screen).toBe('busy');
    expect(work({ detail: 'Thinking', toolName: 'Read' }).screen).toBe('read');
    expect(workPresentation({ status: 'idle', detail: 'Thinking' }).screen).toBe('saver');

    const statuses: AgentStatus[] = ['working', 'waiting_permission', 'waiting_input', 'idle', 'completed', 'failed', 'ended', 'unknown'];
    const details = [undefined, 'Thinking', 'thinking', 'Prompt received', 'Recovering from Edit failure'];
    for (const status of statuses)
      for (const detail of details)
        for (const toolName of [undefined, 'Read', 'Bash'])
          for (const recentFailure of [undefined, 'test'] as const)
            for (const stale of [false, true]) {
              const think = workPresentation({ status, detail, toolName, recentFailure, stale }).screen === 'think';
              expect(think).toBe(status === 'working' && detail === 'Thinking' && !toolName && !recentFailure && !stale);
            }
  });

  it('only uses seated sprite poses and known screens', () => {
    for (const { seatedPose, screen } of Object.values(WORK_MODES)) {
      expect(SPRITE_POSES).toContain(seatedPose);
      expect(seatedPose === 'sit' || seatedPose.startsWith('sit_') || seatedPose.startsWith('type')).toBe(true);
      expect(SCREEN_KINDS).toContain(screen);
    }
  });

  it('animates seated poses over time', () => {
    const seq = (p: Pose, step: number) => new Set(Array.from({ length: 12 }, (_, i) => seatedFrame(p, i * step)));
    expect(seq('type0', 170)).toEqual(new Set(['type0', 'type1']));
    expect(seq('sit_read', 900)).toEqual(new Set(['sit_read', 'sit_read1']));
    expect(seq('sit_raise', 550)).toEqual(new Set(['sit_raise', 'sit']));
    expect(seq('sit_cheer', 300)).toEqual(new Set(['sit_cheer', 'sit']));
    expect(seq('sit_lean', 100)).toEqual(new Set(['sit_lean']));
  });
});

describe('tool classification', () => {
  it('recognizes test runs', () => {
    for (const s of [
      'npm test',
      'npm t',
      'npm run test:unit',
      'pnpm test',
      'yarn test --watch=false',
      'npx vitest run',
      'pytest -q',
      'python -m unittest',
      'go test ./...',
      'cargo test',
      'dotnet test',
      'php artisan test',
      'make test',
      'npx playwright test',
      'Invoke-Pester',
      'Run the unit tests',
      'Run lint and tests',
    ])
      expect(looksLikeTest(s), s).toBe(true);
    for (const s of [undefined, '', 'ls -la', 'git status', 'cat packages/ui/test/a.ts', 'npm run build', 'echo contest', 'mkdir latest'])
      expect(looksLikeTest(s), String(s)).toBe(false);
  });

  it('recognizes builds', () => {
    for (const s of ['npm run build', 'tsc -p .', 'cargo build --release', 'Typecheck the UI', 'go build ./...']) expect(looksLikeBuild(s), s).toBe(true);
    for (const s of ['npm test', 'ls', undefined]) expect(looksLikeBuild(s), String(s)).toBe(false);
  });

  it('classifies tools and failures', () => {
    expect(classifyTool('Read')).toBe('read');
    expect(classifyTool('Grep')).toBe('search');
    expect(classifyTool('Write')).toBe('edit');
    expect(classifyTool('Bash', 'npm test')).toBe('test');
    expect(classifyTool('Bash', 'tsc')).toBe('build');
    expect(classifyTool('Bash', 'ls')).toBe('command');
    expect(classifyTool('Task')).toBe('wait');
    expect(classifyTool('mcp__x__y')).toBe('other');
    expect(classifyTool(undefined)).toBe('other');
    expect(failureKind('Bash', 'npm test')).toBe('test');
    expect(failureKind('PowerShell', 'npm run build')).toBe('build');
    expect(failureKind('Bash', 'git push')).toBe('tool');
    expect(failureKind('Edit')).toBe('tool');
  });
});

// ------------------------------------------------------------------ idle variety

describe('idle variety (neutral poses only)', () => {
  /** Poses that signal a real state: an idle agent must never show them. */
  const REAL: Pose[] = ['sit_raise', 'sit_cheer', 'sit_slump', 'stand_raise', 'stand_cheer', 'stand_slump', 'type0', 'type1', 'sit_read', 'sit_read1', 'sit_think', 'sit_lean', 'sit_debug', 'think'];

  it('cycles through sitting, stretching and sipping at the desk, out of sync per worker', () => {
    const seqs = [0, 1, 2, 3, 4, 5].map((variant) => {
      const seen = new Set<string>();
      const seq: string[] = [];
      for (let t = 0; t < 60_000; t += 100) {
        const p = idleDeskPose(t, { variant });
        expect(IDLE_DESK_POSES).toContain(p);
        expect(REAL).not.toContain(p);
        expect(SPRITE_POSES).toContain(p);
        seen.add(p);
        seq.push(p);
      }
      expect(seen).toEqual(new Set(['sit', 'sit_stretch', 'sit_sip']));
      return seq.join();
    });
    expect(new Set(seqs).size).toBe(seqs.length);
    // mostly just sitting
    const sitting = Array.from({ length: 600 }, (_, i) => idleDeskPose(i * 100, { variant: 7 })).filter((p) => p === 'sit').length;
    expect(sitting / 600).toBeGreaterThan(0.75);
  });

  it('sips after a coffee run and holds still with reduced motion', () => {
    const sips = Array.from({ length: 50 }, (_, i) => idleDeskPose(i * 200, { sipping: true }));
    expect(new Set(sips)).toEqual(new Set(['sit', 'sit_sip']));
    for (let t = 0; t < 30_000; t += 250) expect(idleDeskPose(t, { still: true, variant: 3 })).toBe('sit');
    expect(idleDeskPose(0, { still: true, sipping: true })).toBe('sit_sip');
  });

  it('glances to both sides now and then while standing idle', () => {
    for (const variant of [0, 1, 5]) {
      const seen = new Set<string>();
      for (let t = 0; t < 30_000; t += 100) {
        const sp = idleStandPose(t, variant);
        expect(REAL).not.toContain(sp.pose);
        expect(['stand', 'walk_side_0']).toContain(sp.pose);
        seen.add(`${sp.pose}:${sp.flip}`);
      }
      expect(seen).toEqual(new Set(['stand:false', 'walk_side_0:false', 'walk_side_0:true']));
    }
    for (let t = 0; t < 10_000; t += 250) expect(idleStandPose(t, 2, true)).toEqual({ pose: 'stand', flip: false });
  });
});
