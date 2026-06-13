/**
 * Unit tests for scripts/mac-async-job.js
 * Exercises the pure helpers (jobId generation, remote-command construction,
 * output parsing) without touching SSH or the Mac.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  sanitizePrefix,
  makeJobId,
  buildLaunchRemoteCmd,
  buildStatusRemoteCmd,
  parseLaunchOutput,
  parseStatusOutput,
} = require('../../../scripts/mac-async-job.js');

describe('sanitizePrefix', () => {
  it('lowercases and slugifies', () => {
    expect(sanitizePrefix('My Build Job')).toBe('my-build-job');
  });
  it('strips leading/trailing separators and collapses runs', () => {
    expect(sanitizePrefix('__foo!!bar__')).toBe('foo-bar');
  });
  it('falls back to "job" for empty/garbage input', () => {
    expect(sanitizePrefix('')).toBe('job');
    expect(sanitizePrefix('!!!')).toBe('job');
    expect(sanitizePrefix(null)).toBe('job');
  });
  it('caps length to 32 chars', () => {
    expect(sanitizePrefix('a'.repeat(50)).length).toBe(32);
  });
});

describe('makeJobId', () => {
  const fixedNow = new Date('2026-06-13T16:47:23.000Z');
  it('produces a deterministic id given now+rand', () => {
    expect(makeJobId('build', fixedNow, 'abc123')).toBe('mac-build-20260613164723-abc123');
  });
  it('always matches the safe charset regex', () => {
    const id = makeJobId('Weird Prefix!', fixedNow, 'deadbe');
    expect(id).toMatch(/^mac-[a-z0-9-]+$/);
  });
});

describe('buildLaunchRemoteCmd', () => {
  const jobId = 'mac-build-20260613164723-abc123';

  it('rejects an unsafe jobId', () => {
    expect(() => buildLaunchRemoteCmd('mac-build; rm -rf /', 'echo hi')).toThrow(/unsafe jobId/);
  });

  it('base64-encodes the command (no raw command text leaks into the wrapper)', () => {
    const cmd = buildLaunchRemoteCmd(jobId, 'rm -rf "$HOME"/danger && echo done');
    const b64 = Buffer.from('rm -rf "$HOME"/danger && echo done', 'utf8').toString('base64');
    expect(cmd).toContain(b64);
    expect(cmd).not.toContain('rm -rf "$HOME"/danger');
  });

  it('detaches via nohup and records pid/log/exit_code', () => {
    const cmd = buildLaunchRemoteCmd(jobId, 'echo hi');
    expect(cmd).toContain('nohup bash -lc');
    expect(cmd).toContain('echo $? > "$JOB_DIR/exit_code"');
    expect(cmd).toContain('echo $! > "$JOB_DIR/pid"');
    expect(cmd).toContain('> "$JOB_DIR/log" 2>&1 &');
    expect(cmd).toContain(`mac-async-jobs/${jobId}`);
  });

  it('emits a parseable JOBID/PID marker', () => {
    const cmd = buildLaunchRemoteCmd(jobId, 'echo hi');
    expect(cmd).toContain(`echo "JOBID=${jobId} PID=`);
  });

  it('survives a multi-line command with quotes and newlines', () => {
    const tricky = "printf 'a\\nb'\n echo \"$PATH\"";
    const cmd = buildLaunchRemoteCmd(jobId, tricky);
    const b64 = Buffer.from(tricky, 'utf8').toString('base64');
    expect(cmd).toContain(b64);
  });
});

describe('buildStatusRemoteCmd', () => {
  const jobId = 'mac-build-20260613164723-abc123';

  it('rejects an unsafe jobId', () => {
    expect(() => buildStatusRemoteCmd('../escape')).toThrow(/unsafe jobId/);
  });

  it('reports missing/done/running branches', () => {
    const cmd = buildStatusRemoteCmd(jobId);
    expect(cmd).toContain('STATE=missing');
    expect(cmd).toContain('STATE=done EXIT=');
    expect(cmd).toContain('STATE=running PID=');
    expect(cmd).toContain('kill -0 "$PID"');
  });
});

describe('parseLaunchOutput', () => {
  it('extracts jobId and pid', () => {
    expect(parseLaunchOutput('JOBID=mac-build-20260613164723-abc123 PID=4567')).toEqual({
      jobId: 'mac-build-20260613164723-abc123',
      pid: 4567,
    });
  });
  it('returns nulls when markers are absent', () => {
    expect(parseLaunchOutput('garbage')).toEqual({ jobId: null, pid: null });
    expect(parseLaunchOutput('')).toEqual({ jobId: null, pid: null });
  });
});

describe('parseStatusOutput', () => {
  it('parses a done job with exit code', () => {
    expect(parseStatusOutput('STATE=done EXIT=0 PID=4567')).toEqual({
      state: 'done',
      exitCode: 0,
      pid: 4567,
    });
  });
  it('parses a non-zero exit code', () => {
    expect(parseStatusOutput('STATE=done EXIT=137 PID=4567').exitCode).toBe(137);
  });
  it('parses a running job (no exit code)', () => {
    expect(parseStatusOutput('STATE=running PID=4567')).toEqual({
      state: 'running',
      exitCode: null,
      pid: 4567,
    });
  });
  it('parses a missing job', () => {
    expect(parseStatusOutput('STATE=missing')).toEqual({
      state: 'missing',
      exitCode: null,
      pid: null,
    });
  });
  it('defaults to unknown on empty input', () => {
    expect(parseStatusOutput('').state).toBe('unknown');
  });
});
