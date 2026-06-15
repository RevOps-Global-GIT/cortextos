#!/usr/bin/env node
/**
 * mac-async-job.js — fire-and-forget job runner on Greg's Mac over SSH.
 *
 * Launches a shell command on the Mac detached via nohup, capturing PID, a
 * combined stdout/stderr log, and an exit-code marker under
 * ~/.mac-async-jobs/<jobId>/ on the Mac. A later `status` call reports whether
 * the job is still running, finished (with exit code), or missing — without
 * holding the SSH connection open for the job's lifetime.
 *
 * The job command is base64-encoded before transport so arbitrary shell text
 * (quotes, newlines, $) survives intact and cannot break out of the remote
 * wrapper. The generated jobId uses a restricted charset and is the only value
 * interpolated into the remote command unescaped.
 *
 * Usage:
 *   node scripts/mac-async-job.js launch "<shell command>" [--prefix <slug>] [--proof-dir <dir>]
 *   node scripts/mac-async-job.js status <jobId> [--proof-dir <dir>]
 *
 * Both commands write <proof-dir>/latest.json plus a per-job JSON proof file
 * (default: output/mac-async-jobs). Status proof includes failureReason for
 * nonzero, missing, or unknown completion states.
 *
 * Pure helpers (no I/O) are exported for unit testing via createRequire.
 */

'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const { mkdirSync, writeFileSync } = require('fs');
const { join } = require('path');

const SSH_HOST = process.env.MAC_SSH_HOST || 'gregs-mac';
const JOB_ROOT = '$HOME/.mac-async-jobs';
const DEFAULT_PROOF_DIR = process.env.MAC_ASYNC_PROOF_DIR || 'output/mac-async-jobs';

// ---------------------------------------------------------------------------
// Pure helpers (exported, unit-tested)
// ---------------------------------------------------------------------------

/** Restricted charset so jobId is always safe to interpolate into a shell command. */
function sanitizePrefix(prefix) {
  const slug = String(prefix || 'job')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'job';
}

/** jobId = mac-<prefix>-<YYYYMMDDhhmmss>-<6 hex>. Deterministic given now+rand. */
function makeJobId(prefix, now = new Date(), rand = crypto.randomBytes(3).toString('hex')) {
  const ts = now
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14); // YYYYMMDDhhmmss
  return `mac-${sanitizePrefix(prefix)}-${ts}-${rand}`;
}

/**
 * Remote command that detaches the job and records pid/log/exit_code.
 * `command` is embedded as base64 and decoded into a script file on the Mac.
 */
function buildLaunchRemoteCmd(jobId, command) {
  if (!/^mac-[a-z0-9-]+$/.test(jobId)) {
    throw new Error(`unsafe jobId: ${jobId}`);
  }
  const b64 = Buffer.from(String(command), 'utf8').toString('base64');
  const setup = [
    `export JOB_DIR="${JOB_ROOT}/${jobId}"`,
    `mkdir -p "$JOB_DIR"`,
    `printf '%s' '${b64}' | base64 --decode > "$JOB_DIR/cmd.sh"`,
  ].join(' && ');
  // The launch line backgrounds with "&" — it must NOT be chained with "&&"
  // afterward, because a trailing "... & && ..." is a shell parse error in zsh
  // (Greg's Mac login shell) and bash alike. Wrap the background launch + pid
  // capture in a { ...; } group so the surrounding && chain stays valid; $!
  // inside the group still resolves to the nohup pid we just backgrounded.
  const launch =
    `{ nohup bash -lc 'bash "$JOB_DIR/cmd.sh"; echo $? > "$JOB_DIR/exit_code"' > "$JOB_DIR/log" 2>&1 & echo $! > "$JOB_DIR/pid"; }`;
  return `${setup} && ${launch} && echo "JOBID=${jobId} PID=$(cat "$JOB_DIR/pid")"`;
}

/** Remote command that reports the job's current state. */
function buildStatusRemoteCmd(jobId) {
  if (!/^mac-[a-z0-9-]+$/.test(jobId)) {
    throw new Error(`unsafe jobId: ${jobId}`);
  }
  return [
    `JOB_DIR="${JOB_ROOT}/${jobId}"`,
    `if [ ! -d "$JOB_DIR" ]; then echo "STATE=missing"; exit 0; fi`,
    `PID="$(cat "$JOB_DIR/pid" 2>/dev/null || true)"`,
    `if [ -f "$JOB_DIR/exit_code" ]; then echo "STATE=done EXIT=$(cat "$JOB_DIR/exit_code") PID=$PID";`,
    `elif [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then echo "STATE=running PID=$PID";`,
    `else echo "STATE=unknown PID=$PID"; fi`,
  ].join('\n');
}

/** Parse `JOBID=<id> PID=<n>` from launch stdout. */
function parseLaunchOutput(stdout) {
  const text = String(stdout || '');
  const jobId = (text.match(/JOBID=(\S+)/) || [])[1] || null;
  const pidRaw = (text.match(/PID=(\d+)/) || [])[1];
  return { jobId, pid: pidRaw ? Number(pidRaw) : null };
}

/** Parse `STATE=<s> [EXIT=<n>] [PID=<n>]` from status stdout. */
function parseStatusOutput(stdout) {
  const text = String(stdout || '');
  const state = (text.match(/STATE=(\w+)/) || [])[1] || 'unknown';
  const exitRaw = (text.match(/EXIT=(-?\d+)/) || [])[1];
  const pidRaw = (text.match(/PID=(\d+)/) || [])[1];
  return {
    state,
    exitCode: exitRaw !== undefined ? Number(exitRaw) : null,
    pid: pidRaw ? Number(pidRaw) : null,
  };
}

function remoteJobPath(jobId, fileName) {
  if (!/^mac-[a-z0-9-]+$/.test(jobId)) {
    throw new Error(`unsafe jobId: ${jobId}`);
  }
  return `~/.mac-async-jobs/${jobId}/${fileName}`;
}

function failureReasonForStatus(status) {
  if (status.state === 'done' && status.exitCode !== 0) {
    return `remote command exited ${status.exitCode}`;
  }
  if (status.state === 'missing') {
    return 'remote job directory missing';
  }
  if (status.state === 'unknown') {
    return 'remote job state unknown; pid is absent or no longer running and exit_code is missing';
  }
  return null;
}

function buildProofRecord(action, result, extra = {}) {
  const jobId = result.jobId;
  const status = {
    state: result.state || (action === 'launch' ? 'launched' : 'unknown'),
    exitCode: result.exitCode ?? null,
    pid: result.pid ?? null,
  };
  return {
    generatedAt: new Date().toISOString(),
    action,
    sshHost: SSH_HOST,
    jobRoot: '~/.mac-async-jobs',
    jobId,
    pid: status.pid,
    state: status.state,
    exitCode: status.exitCode,
    failureReason: failureReasonForStatus(status),
    remote: jobId ? {
      commandPath: remoteJobPath(jobId, 'cmd.sh'),
      logPath: remoteJobPath(jobId, 'log'),
      pidPath: remoteJobPath(jobId, 'pid'),
      exitCodePath: remoteJobPath(jobId, 'exit_code'),
    } : null,
    ...extra,
  };
}

function writeProofRecord(record, proofDir = DEFAULT_PROOF_DIR) {
  mkdirSync(proofDir, { recursive: true });
  const latestPath = join(proofDir, 'latest.json');
  const jobPath = record.jobId ? join(proofDir, `${record.jobId}.json`) : null;
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(latestPath, payload);
  if (jobPath) writeFileSync(jobPath, payload);
  return { latestPath, jobPath };
}

function parseOption(rest, flag, fallback) {
  const idx = rest.indexOf(flag);
  if (idx === -1) return { value: fallback, args: rest };
  const value = rest[idx + 1] || fallback;
  return {
    value,
    args: rest.filter((_, i) => i !== idx && i !== idx + 1),
  };
}

// ---------------------------------------------------------------------------
// Impure SSH layer
// ---------------------------------------------------------------------------

function sshRun(remoteCmd, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-n', '-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new', SSH_HOST, remoteCmd];
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let timer;
    let timedOut = false;
    if (timeout) {
      timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    }
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return reject(new Error(`ssh timed out after ${timeout}ms`));
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (code !== 0) {
        const e = new Error(`ssh exited ${code}: ${stderr.slice(0, 500)}`);
        e.stderr = stderr;
        return reject(e);
      }
      resolve(Buffer.concat(out).toString('utf8').trim());
    });
  });
}

async function launchJob(command, { prefix = 'job' } = {}) {
  const jobId = makeJobId(prefix);
  const out = await sshRun(buildLaunchRemoteCmd(jobId, command));
  const parsed = parseLaunchOutput(out);
  return { jobId, ...parsed };
}

async function getJobStatus(jobId) {
  const out = await sshRun(buildStatusRemoteCmd(jobId));
  return parseStatusOutput(out);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv) {
  const [sub, ...rest] = argv;
  if (sub === 'launch') {
    const parsedPrefix = parseOption(rest, '--prefix', 'job');
    const parsedProof = parseOption(parsedPrefix.args, '--proof-dir', DEFAULT_PROOF_DIR);
    const prefix = parsedPrefix.value;
    const args = parsedProof.args;
    const command = args.join(' ');
    if (!command) throw new Error('launch requires a command');
    const res = await launchJob(command, { prefix });
    const proof = buildProofRecord('launch', res, { commandPreview: command.slice(0, 500) });
    const proofPaths = writeProofRecord(proof, parsedProof.value);
    console.log(JSON.stringify({ ...res, proof: proofPaths }));
    return;
  }
  if (sub === 'status') {
    const parsedProof = parseOption(rest, '--proof-dir', DEFAULT_PROOF_DIR);
    const jobId = parsedProof.args[0];
    if (!jobId) throw new Error('status requires a jobId');
    const res = await getJobStatus(jobId);
    const withJob = { jobId, ...res };
    const proof = buildProofRecord('status', withJob);
    const proofPaths = writeProofRecord(proof, parsedProof.value);
    console.log(JSON.stringify({ ...withJob, failureReason: proof.failureReason, proof: proofPaths }));
    return;
  }
  throw new Error(`unknown subcommand: ${sub || '(none)'} — use launch|status`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message || String(e));
    process.exit(1);
  });
}

module.exports = {
  sanitizePrefix,
  makeJobId,
  buildLaunchRemoteCmd,
  buildStatusRemoteCmd,
  parseLaunchOutput,
  parseStatusOutput,
  failureReasonForStatus,
  buildProofRecord,
  writeProofRecord,
  SSH_HOST,
  JOB_ROOT,
  DEFAULT_PROOF_DIR,
};
