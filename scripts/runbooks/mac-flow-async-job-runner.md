# Mac Async Job Runner for OB1 Flow Hero Regen

Use this path when an OB1 Flow hero regeneration job may exceed the synchronous
`mac-codex` bridge window. It launches the job on Greg's Mac, returns quickly
with a job id and PID, and lets a later status check capture completion proof.

This is for long-running Mac-side shell work only. Do not use it for browser/UI
automation unless a current task explicitly authorizes Mac fallback.

## Launch

From the cortextOS repo on the VM:

```bash
node scripts/mac-async-job.js launch \
  'cd "$HOME/work/ob1-app" && bash scripts/weekly-hero-cron.sh' \
  --prefix ob1-flow-hero \
  --proof-dir output/mac-async-jobs
```

The command returns JSON like:

```json
{
  "jobId": "mac-ob1-flow-hero-20260615214512-abcdef",
  "pid": 12345,
  "proof": {
    "latestPath": "output/mac-async-jobs/latest.json",
    "jobPath": "output/mac-async-jobs/mac-ob1-flow-hero-20260615214512-abcdef.json"
  }
}
```

Remote files are written on the Mac under:

```text
~/.mac-async-jobs/<jobId>/cmd.sh
~/.mac-async-jobs/<jobId>/log
~/.mac-async-jobs/<jobId>/pid
~/.mac-async-jobs/<jobId>/exit_code
```

## Status

Poll by job id:

```bash
node scripts/mac-async-job.js status mac-ob1-flow-hero-20260615214512-abcdef \
  --proof-dir output/mac-async-jobs
```

States:

- `running`: PID is still alive on the Mac.
- `done`: `exit_code` exists; `exitCode` is the command exit code.
- `missing`: the remote job directory is absent.
- `unknown`: PID is absent/dead and `exit_code` is missing.

Every status check rewrites `output/mac-async-jobs/latest.json` and the per-job
JSON file. If the job finished nonzero, the local proof includes
`failureReason`, for example `remote command exited 2`.

## Failure Triage

If status is `done` with a nonzero exit code, or `unknown`, inspect the remote
log without rerunning the job:

```bash
ssh gregs-mac 'tail -n 120 ~/.mac-async-jobs/<jobId>/log'
```

Attach or cite the local proof JSON plus relevant log tail in the task report.
Do not raise the synchronous mac-codex timeout to work around long Flow jobs.

## Cleanup

Leave remote job folders in place until the task/report is accepted. After that,
cleanup is explicit and by job id:

```bash
ssh gregs-mac 'rm -rf ~/.mac-async-jobs/<jobId>'
```

Do not bulk-delete `~/.mac-async-jobs` unless Greg or orchestrator explicitly
approves it.
