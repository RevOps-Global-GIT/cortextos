import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CronScheduler, type ManagedAgent } from '../../../src/daemon/cron-scheduler';
import { readCronState, updateCronFire } from '../../../src/bus/cron-state';
import type { AgentConfig } from '../../../src/types';

/**
 * Tests for the daemon-side cron scheduler. The scheduler is deliberately
 * decoupled from AgentProcess — it depends on the ManagedAgent interface only
 * — so every test drives a FakeAgent that records injections and lets the
 * test control isIdle/isRunning/generation.
 */

class FakeAgent implements ManagedAgent {
  name: string;
  stateDir: string;
  configPath: string;
  timezone?: string;
  generation: number;
  running = true;
  idle = true;
  injects: string[] = [];
  injectReturns = true;

  constructor(name: string, stateDir: string, configPath: string, timezone?: string) {
    this.name = name;
    this.stateDir = stateDir;
    this.configPath = configPath;
    this.timezone = timezone;
    this.generation = 1;
  }

  isRunning(): boolean {
    return this.running;
  }
  isIdle(): boolean {
    return this.idle;
  }
  inject(message: string): boolean {
    if (!this.injectReturns) return false;
    this.injects.push(message);
    return true;
  }
}

let tmpRoot: string;
let stateDir: string;
let configPath: string;
const schedulers: CronScheduler[] = [];

function makeScheduler(opts?: ConstructorParameters<typeof CronScheduler>[0]): CronScheduler {
  const s = new CronScheduler(opts);
  schedulers.push(s);
  return s;
}

const ONE_HOUR = 3_600_000;
const ONE_MINUTE = 60_000;

function writeConfig(config: Partial<AgentConfig>): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function makeAgent(overrides: Partial<FakeAgent> = {}, tz?: string): FakeAgent {
  const agent = new FakeAgent('testagent', stateDir, configPath, tz);
  return Object.assign(agent, overrides);
}

/** Mutable clock, passed to the scheduler via `now` option. */
function makeClock(start: number = Date.parse('2026-04-14T12:00:00Z')) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (value: number) => {
      current = value;
    },
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cron-scheduler-test-'));
  stateDir = join(tmpRoot, 'state');
  mkdirSync(stateDir, { recursive: true });
  configPath = join(tmpRoot, 'config.json');
});

afterEach(() => {
  while (schedulers.length > 0) {
    schedulers.pop()?.stop();
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------- buildSchedule / computeNextFire ----------

describe('CronScheduler: interval cron math', () => {
  it('schedules a new interval cron now + interval when no last_fire exists', () => {
    writeConfig({
      crons: [
        { name: 'heartbeat', interval: '4h', prompt: 'check in' },
      ],
    });

    const clock = makeClock();
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent());

    const sched = scheduler.getSchedule('testagent')!;
    expect(sched).toHaveLength(1);
    expect(sched[0].nextFireAt).toBe(clock.now() + 4 * ONE_HOUR);
  });

  it('anchors next fire on last_fire + interval when cron-state has a record', () => {
    const clock = makeClock();
    const lastFire = new Date(clock.now() - 3 * ONE_HOUR); // 3h ago
    updateCronFire(stateDir, 'heartbeat', '4h');
    // Overwrite with a known timestamp
    writeFileSync(
      join(stateDir, 'cron-state.json'),
      JSON.stringify({
        updated_at: lastFire.toISOString(),
        crons: [
          { name: 'heartbeat', last_fire: lastFire.toISOString(), interval: '4h' },
        ],
      }),
    );

    writeConfig({
      crons: [{ name: 'heartbeat', interval: '4h', prompt: 'check in' }],
    });

    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent());

    const sched = scheduler.getSchedule('testagent')!;
    // last_fire + 4h is 1h in the future (3h ago + 4h)
    expect(sched[0].nextFireAt).toBe(lastFire.getTime() + 4 * ONE_HOUR);
  });

  it('clamps overdue interval fires to now so they fire on the next tick', () => {
    const clock = makeClock();
    const ancientFire = new Date(clock.now() - 24 * ONE_HOUR); // 24h ago
    writeFileSync(
      join(stateDir, 'cron-state.json'),
      JSON.stringify({
        updated_at: ancientFire.toISOString(),
        crons: [
          { name: 'heartbeat', last_fire: ancientFire.toISOString(), interval: '4h' },
        ],
      }),
    );

    writeConfig({
      crons: [{ name: 'heartbeat', interval: '4h', prompt: 'check in' }],
    });

    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent());

    const sched = scheduler.getSchedule('testagent')!;
    // ancientFire + 4h is way in the past; clamped to now
    expect(sched[0].nextFireAt).toBe(clock.now());
  });
});

describe('CronScheduler: cron expression math', () => {
  it('parses a daily expression and picks the next occurrence', () => {
    // Start at 2026-04-14 14:00 UTC; "0 18 * * *" next fire is same day 18:00 UTC
    const clock = makeClock(Date.parse('2026-04-14T14:00:00Z'));
    writeConfig({
      crons: [{ name: 'evening-review', cron: '0 18 * * *', prompt: 'end of day' }],
    });

    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent({}, 'UTC'));

    const sched = scheduler.getSchedule('testagent')!;
    expect(sched[0].nextFireAt).toBe(Date.parse('2026-04-14T18:00:00Z'));
  });

  it('rolls over to the next day when current time is past today\'s fire', () => {
    // 20:00 UTC, "0 18 * * *" → tomorrow 18:00 UTC
    const clock = makeClock(Date.parse('2026-04-14T20:00:00Z'));
    writeConfig({
      crons: [{ name: 'evening-review', cron: '0 18 * * *', prompt: 'end of day' }],
    });

    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent({}, 'UTC'));

    expect(scheduler.getSchedule('testagent')![0].nextFireAt).toBe(
      Date.parse('2026-04-15T18:00:00Z'),
    );
  });

  it('respects the agent timezone', () => {
    // 2026-04-14 14:00 UTC = 07:00 America/Los_Angeles. "0 7 * * *" (LA) → today 07:00 LA = 14:00 UTC.
    // But next() is strictly > currentDate, so we'd get tomorrow 07:00 LA = 2026-04-15 14:00 UTC.
    const clock = makeClock(Date.parse('2026-04-14T14:00:00Z'));
    writeConfig({
      crons: [{ name: 'morning', cron: '0 7 * * *', prompt: 'morning review' }],
    });

    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent({}, 'America/Los_Angeles'));

    expect(scheduler.getSchedule('testagent')![0].nextFireAt).toBe(
      Date.parse('2026-04-15T14:00:00Z'),
    );
  });

  it('never stampedes missed time-anchored fires after an outage', () => {
    // last_fire was 3 days ago at 18:00 UTC; now is 14:00 UTC today.
    // computeNextFire uses max(last_fire, now) as base, so the next "0 18 * * *"
    // is today 18:00 UTC — not one of the three missed past days.
    const clock = makeClock(Date.parse('2026-04-14T14:00:00Z'));
    const threeDaysAgo = Date.parse('2026-04-11T18:00:00Z');
    writeFileSync(
      join(stateDir, 'cron-state.json'),
      JSON.stringify({
        updated_at: new Date(threeDaysAgo).toISOString(),
        crons: [
          {
            name: 'evening-review',
            last_fire: new Date(threeDaysAgo).toISOString(),
            interval: undefined,
          },
        ],
      }),
    );

    writeConfig({
      crons: [{ name: 'evening-review', cron: '0 18 * * *', prompt: 'end of day' }],
    });

    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent({}, 'UTC'));

    expect(scheduler.getSchedule('testagent')![0].nextFireAt).toBe(
      Date.parse('2026-04-14T18:00:00Z'),
    );
  });
});

describe('CronScheduler: once-type crons', () => {
  it('schedules a future fire_at', () => {
    const clock = makeClock();
    const fireAt = new Date(clock.now() + 6 * ONE_HOUR).toISOString();
    writeConfig({
      crons: [
        { name: 'reminder', type: 'once', fire_at: fireAt, prompt: 'remember' },
      ],
    });

    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent());

    expect(scheduler.getSchedule('testagent')).toHaveLength(1);
    expect(scheduler.getSchedule('testagent')![0].nextFireAt).toBe(Date.parse(fireAt));
  });

  it('drops expired once entries at build time', () => {
    const clock = makeClock();
    const pastFire = new Date(clock.now() - ONE_HOUR).toISOString();
    writeConfig({
      crons: [
        { name: 'reminder', type: 'once', fire_at: pastFire, prompt: 'remember' },
      ],
    });

    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent());

    expect(scheduler.getSchedule('testagent')).toHaveLength(0);
  });

  it('removes once entries from the schedule after firing', () => {
    const clock = makeClock();
    const fireAt = new Date(clock.now() + ONE_MINUTE).toISOString();
    writeConfig({
      crons: [
        { name: 'reminder', type: 'once', fire_at: fireAt, prompt: 'remember' },
      ],
    });

    const agent = makeAgent();
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(agent);

    clock.advance(2 * ONE_MINUTE);
    scheduler.tick();

    expect(agent.injects).toEqual(['remember']);
    expect(scheduler.getSchedule('testagent')).toHaveLength(0);
  });
});

// ---------- tick / fire behavior ----------

describe('CronScheduler: tick firing', () => {
  it('injects a recurring cron when it becomes due and advances nextFireAt', () => {
    const clock = makeClock();
    writeConfig({
      crons: [{ name: 'heartbeat', interval: '4h', prompt: 'heartbeat prompt' }],
    });

    const agent = makeAgent();
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(agent);

    // Not yet due
    scheduler.tick();
    expect(agent.injects).toHaveLength(0);

    clock.advance(4 * ONE_HOUR);
    scheduler.tick();

    expect(agent.injects).toEqual(['heartbeat prompt']);
    // nextFireAt advanced to now + 4h
    expect(scheduler.getSchedule('testagent')![0].nextFireAt).toBe(clock.now() + 4 * ONE_HOUR);
  });

  it('writes cron-state.json on a successful fire', () => {
    const clock = makeClock();
    writeConfig({
      crons: [{ name: 'heartbeat', interval: '4h', prompt: 'hi' }],
    });

    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent());

    clock.advance(4 * ONE_HOUR);
    scheduler.tick();

    const state = readCronState(stateDir);
    expect(state.crons).toHaveLength(1);
    expect(state.crons[0].name).toBe('heartbeat');
    expect(state.crons[0].interval).toBe('4h');
  });

  it('does not fire when agent is not running', () => {
    const clock = makeClock();
    writeConfig({
      crons: [{ name: 'heartbeat', interval: '4h', prompt: 'hi' }],
    });

    const agent = makeAgent({ running: false });
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(agent);

    clock.advance(4 * ONE_HOUR);
    scheduler.tick();

    expect(agent.injects).toHaveLength(0);
  });

  it('does not advance nextFireAt when inject fails (retries next tick)', () => {
    const clock = makeClock();
    writeConfig({
      crons: [{ name: 'heartbeat', interval: '4h', prompt: 'hi' }],
    });

    const agent = makeAgent({ injectReturns: false });
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(agent);

    clock.advance(4 * ONE_HOUR);
    const nextBefore = scheduler.getSchedule('testagent')![0].nextFireAt;
    scheduler.tick();

    expect(agent.injects).toHaveLength(0);
    expect(scheduler.getSchedule('testagent')![0].nextFireAt).toBe(nextBefore);

    // Now allow inject to succeed and retry
    agent.injectReturns = true;
    scheduler.tick();
    expect(agent.injects).toEqual(['hi']);
  });
});

// ---------- idle deferral ----------

describe('CronScheduler: idle deferral', () => {
  it('defers injection when agent is busy', () => {
    const clock = makeClock();
    writeConfig({
      crons: [{ name: 'heartbeat', interval: '4h', prompt: 'hi' }],
    });

    const agent = makeAgent({ idle: false });
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(agent);

    clock.advance(4 * ONE_HOUR);
    scheduler.tick();

    expect(agent.injects).toHaveLength(0);
    expect(scheduler.getSchedule('testagent')![0].deferStart).toBe(clock.now());
  });

  it('injects once the agent becomes idle', () => {
    const clock = makeClock();
    writeConfig({
      crons: [{ name: 'heartbeat', interval: '4h', prompt: 'hi' }],
    });

    const agent = makeAgent({ idle: false });
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(agent);

    clock.advance(4 * ONE_HOUR);
    scheduler.tick();
    expect(agent.injects).toHaveLength(0);

    agent.idle = true;
    clock.advance(30_000);
    scheduler.tick();
    expect(agent.injects).toEqual(['hi']);
  });

  it('force-injects after max defer window elapses even if still busy', () => {
    const clock = makeClock();
    writeConfig({
      crons: [{ name: 'heartbeat', interval: '4h', prompt: 'hi' }],
    });

    const agent = makeAgent({ idle: false });
    const scheduler = makeScheduler({
      now: clock.now,
      maxDeferMs: 5 * ONE_MINUTE,
    });
    scheduler.attachAgent(agent);

    clock.advance(4 * ONE_HOUR);
    scheduler.tick(); // start defer
    clock.advance(6 * ONE_MINUTE);
    scheduler.tick(); // past max defer → force inject

    expect(agent.injects).toEqual(['hi']);
  });
});

// ---------- validation / edge cases ----------

describe('CronScheduler: config validation', () => {
  it('skips entries with missing name or prompt', () => {
    writeConfig({
      crons: [
        { name: '', interval: '1h', prompt: 'no name' } as any,
        { name: 'no-prompt', interval: '1h', prompt: '' },
        { name: 'ok', interval: '1h', prompt: 'real prompt' },
      ],
    });

    const clock = makeClock();
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent());

    const sched = scheduler.getSchedule('testagent')!;
    expect(sched).toHaveLength(1);
    expect(sched[0].entry.name).toBe('ok');
  });

  it('deduplicates entries with the same name (first wins)', () => {
    writeConfig({
      crons: [
        { name: 'heartbeat', interval: '1h', prompt: 'first' },
        { name: 'heartbeat', interval: '4h', prompt: 'second' },
      ],
    });

    const clock = makeClock();
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent());

    const sched = scheduler.getSchedule('testagent')!;
    expect(sched).toHaveLength(1);
    expect(sched[0].entry.prompt).toBe('first');
  });

  it('skips entries with neither interval nor cron nor fire_at', () => {
    writeConfig({
      crons: [{ name: 'bad', prompt: 'no timing' } as any],
    });

    const clock = makeClock();
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent());

    expect(scheduler.getSchedule('testagent')).toHaveLength(0);
  });

  it('skips interval entries with unparseable interval strings', () => {
    writeConfig({
      crons: [{ name: 'bad', interval: 'soon', prompt: 'not real' }],
    });

    const clock = makeClock();
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent());

    expect(scheduler.getSchedule('testagent')).toHaveLength(0);
  });

  it('skips cron entries with invalid expressions', () => {
    writeConfig({
      crons: [{ name: 'bad', cron: 'not a cron', prompt: 'bad expr' }],
    });

    const clock = makeClock();
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent());

    expect(scheduler.getSchedule('testagent')).toHaveLength(0);
  });
});

// ---------- reload / detach ----------

describe('CronScheduler: reload and detach', () => {
  it('reload picks up new crons from disk', () => {
    writeConfig({
      crons: [{ name: 'a', interval: '1h', prompt: 'a' }],
    });

    const clock = makeClock();
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent());
    expect(scheduler.getSchedule('testagent')).toHaveLength(1);

    writeConfig({
      crons: [
        { name: 'a', interval: '1h', prompt: 'a' },
        { name: 'b', interval: '2h', prompt: 'b' },
      ],
    });
    scheduler.reload('testagent');

    const sched = scheduler.getSchedule('testagent')!;
    expect(sched).toHaveLength(2);
    expect(sched.map((c) => c.entry.name).sort()).toEqual(['a', 'b']);
  });

  it('reload preserves anchoring on the cron-state last_fire record', () => {
    // Pre-populate cron-state.json with a specific last_fire so we are
    // not dependent on updateCronFire's wall-clock (it uses Date.now(),
    // which the injected test clock doesn't control).
    const clock = makeClock();
    const lastFire = new Date(clock.now() - ONE_HOUR);
    writeFileSync(
      join(stateDir, 'cron-state.json'),
      JSON.stringify({
        updated_at: lastFire.toISOString(),
        crons: [{ name: 'heartbeat', last_fire: lastFire.toISOString(), interval: '4h' }],
      }),
    );
    writeConfig({
      crons: [{ name: 'heartbeat', interval: '4h', prompt: 'hi' }],
    });

    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(makeAgent());
    const initialNext = scheduler.getSchedule('testagent')![0].nextFireAt;
    expect(initialNext).toBe(lastFire.getTime() + 4 * ONE_HOUR);

    // Advance clock (simulating time passing); reload should still see the
    // same last_fire record and produce the same nextFireAt.
    clock.advance(30 * ONE_MINUTE);
    scheduler.reload('testagent');
    expect(scheduler.getSchedule('testagent')![0].nextFireAt).toBe(initialNext);
  });

  it('detachAgent removes the agent from the schedule', () => {
    writeConfig({
      crons: [{ name: 'a', interval: '1h', prompt: 'a' }],
    });

    const scheduler = makeScheduler();
    scheduler.attachAgent(makeAgent());
    expect(scheduler.hasAgent('testagent')).toBe(true);

    scheduler.detachAgent('testagent');
    expect(scheduler.hasAgent('testagent')).toBe(false);
  });

  it('re-attaching with a newer generation replaces the schedule', () => {
    writeConfig({
      crons: [{ name: 'a', interval: '1h', prompt: 'a' }],
    });

    const scheduler = makeScheduler();
    const first = makeAgent();
    scheduler.attachAgent(first);

    const second = makeAgent();
    second.generation = 2;
    scheduler.attachAgent(second);

    expect(scheduler.hasAgent('testagent')).toBe(true);
    expect(scheduler.getSchedule('testagent')).toHaveLength(1);
  });
});

describe('CronScheduler: generation guard', () => {
  it('skips agents whose current generation outran the attached one', () => {
    const clock = makeClock();
    writeConfig({
      crons: [{ name: 'heartbeat', interval: '4h', prompt: 'hi' }],
    });

    const agent = makeAgent();
    const scheduler = makeScheduler({ now: clock.now });
    scheduler.attachAgent(agent);

    // Simulate an out-of-band restart: agent's generation bumped but
    // attachAgent() has not been called yet
    agent.generation = 2;

    clock.advance(4 * ONE_HOUR);
    scheduler.tick();
    expect(agent.injects).toHaveLength(0);

    // After re-attach the scheduler fires normally
    scheduler.attachAgent(agent);
    clock.advance(ONE_MINUTE);
    scheduler.tick();
    // Cron was scheduled relative to now-on-attach (heartbeat+4h), so won't fire immediately
    expect(agent.injects).toHaveLength(0);

    clock.advance(4 * ONE_HOUR);
    scheduler.tick();
    expect(agent.injects).toEqual(['hi']);
  });
});
