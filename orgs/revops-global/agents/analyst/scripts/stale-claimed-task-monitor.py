#!/usr/bin/env python3
"""
stale-claimed-task-monitor: detect orch_tasks claimed (status=in_progress) but
not updated for >72h. Alert orchestrator with the offending task list.

Detection-shadow class fix (per analyst-coined rule 2026-05-24): we already
monitor stale crons and stale leases; this closes the gap on tasks that were
claimed but quietly stopped progressing.

Two detection passes:
  1. Age-based (default 72h): per-task dedup, 24h window.
  2. Offline-assignee: any in_progress task whose assignee.running=false fires
     immediately regardless of age. Per orch theta-2026-05-31 follow-up: catches
     the case where a worker agent goes offline cleanly and freezes its whole
     in_progress queue — only the oldest task crosses the 72h threshold and the
     rest stay invisible (incident 2026-05-31 dev offline 10 tasks).

Usage:
  python3 stale-claimed-task-monitor.py                  # default: 72h + offline-assignee
  python3 stale-claimed-task-monitor.py --hours 24       # custom age threshold
  python3 stale-claimed-task-monitor.py --no-offline     # skip offline-assignee pass
  python3 stale-claimed-task-monitor.py --dry-run        # report only

Per orch ask 2026-05-28 after the weekly-signal-diff task quietly stalled 50h.
Offline-assignee pass added 2026-05-31 per orch msg 1780232714689.
Threshold raised 48h→72h 2026-06-03: reduce false-positive churn on multi-day tasks (task 2f134e68).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path("/home/cortextos/cortextos")
SECRETS = REPO_ROOT / "orgs/revops-global/secrets.env"
STATE_DIR = REPO_ROOT / "orgs/revops-global/agents/analyst/state"
LEDGER = STATE_DIR / "stale-claimed-task-ledger.jsonl"
DEDUP_FILE = STATE_DIR / "stale-claimed-task-dedup.json"

DEFAULT_STALE_HOURS = 72
DEFAULT_DEDUP_HOURS = 24


def load_env(path: Path) -> dict:
    env = {}
    if not path.exists():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def supabase_query(env: dict, table: str, params: dict) -> list:
    """REST query Supabase via PostgREST."""
    url = f"{env['RGOS_SUPABASE_URL']}/rest/v1/{table}"
    qs = urllib.parse.urlencode(params, safe=".(),:")
    req = urllib.request.Request(
        f"{url}?{qs}",
        headers={
            "apikey": env["RGOS_SUPABASE_SERVICE_KEY"],
            "Authorization": f"Bearer {env['RGOS_SUPABASE_SERVICE_KEY']}",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def load_dedup() -> dict:
    if not DEDUP_FILE.exists():
        return {}
    try:
        return json.loads(DEDUP_FILE.read_text())
    except json.JSONDecodeError:
        return {}


def save_dedup(d: dict) -> None:
    DEDUP_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = DEDUP_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(d, indent=2))
    os.replace(tmp, DEDUP_FILE)


def append_ledger(report: dict) -> None:
    LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a", encoding="utf-8") as f:
        f.write(json.dumps(report) + "\n")


def fetch_agent_running_map() -> dict[str, bool]:
    """Query cortextos bus list-agents and return {name: running_bool}.

    Returns empty dict on any failure so the offline-assignee pass becomes a
    no-op rather than the script failing entirely.
    """
    try:
        out = subprocess.run(
            ["cortextos", "bus", "list-agents"],
            capture_output=True, text=True, timeout=30, check=False,
        )
        if out.returncode != 0:
            return {}
        agents = json.loads(out.stdout)
        return {a["name"]: bool(a.get("running", False)) for a in agents if a.get("name")}
    except Exception:
        return {}


def notify_orchestrator_age(stale: list, threshold_h: int) -> None:
    """Bus message for age-threshold alerts."""
    lines = [f"stale-claimed-task-monitor: {len(stale)} task(s) in_progress >{threshold_h}h, no update:"]
    for t in stale:
        age_h = t.get("age_hours", "?")
        lines.append(
            f"  - {t.get('id', '?')[:8]}: '{(t.get('title') or '')[:70]}' "
            f"→ {t.get('assigned_to') or 'unassigned'} (age {age_h}h)"
        )
    lines.append("Pattern is detection-shadow class. Recommend ping the assignee or auto-mark blocked.")
    _send_bus_message("\n".join(lines))


def notify_orchestrator_offline(offline: list) -> None:
    """Bus message for offline-assignee alerts (no age threshold)."""
    # Group by assignee for readability
    by_assignee: dict[str, list] = {}
    for t in offline:
        by_assignee.setdefault(t.get("assigned_to") or "unknown", []).append(t)
    lines = [
        f"stale-claimed-task-monitor: {len(offline)} task(s) in_progress with OFFLINE assignee "
        f"(running=false). Frozen until assignee restarts:"
    ]
    for assignee, tasks in by_assignee.items():
        lines.append(f"  {assignee} ({len(tasks)} frozen):")
        for t in tasks[:10]:  # cap per-assignee block
            age_h = t.get("age_hours", "?")
            lines.append(
                f"    - {t.get('id', '?')[:8]}: '{(t.get('title') or '')[:70]}' (age {age_h}h)"
            )
        if len(tasks) > 10:
            lines.append(f"    ... and {len(tasks) - 10} more")
    lines.append("Recommend: restart assignee OR re-lane tasks to a live agent (mind shared-clone collision constraints).")
    _send_bus_message("\n".join(lines))


def _send_bus_message(msg: str) -> None:
    try:
        subprocess.run(
            ["cortextos", "bus", "send-message", "orchestrator", "normal", msg],
            check=False, timeout=30, capture_output=True,
        )
    except Exception as e:
        print(f"[stale-monitor] notify failed: {e}", file=sys.stderr)


def fetch_in_progress_tasks(env: dict) -> list:
    """All in_progress orch_tasks regardless of age (for offline-assignee scan)."""
    return supabase_query(
        env, "orch_tasks",
        {
            "select": "id,title,assigned_to,status,updated_at",
            "status": "eq.in_progress",
            "limit": "500",
        },
    )


def offline_dedup_key(task_id: str, assignee: str | None) -> str:
    """Dedup key for offline-assignee alerts.

    Separate keyspace from age-based dedup (prefixed offline:) so the two passes
    can both alert on the same task without colliding. Includes assignee so that
    if a task is reassigned to a different offline agent, it re-alerts.
    """
    return f"offline:{task_id}:{assignee or 'none'}"


def evaluate_age_pass(
    rows: list, dedup: dict, now_ts: float, dedup_hours: int, dry_run: bool
) -> tuple[list, list]:
    """Pure function: split rows into (all_stale, new_alerts) for age pass.

    Mutates dedup in place when dry_run is False.
    """
    stale: list[dict] = []
    new_alerts: list[dict] = []
    for r in rows:
        tid = r["id"]
        last_alerted = dedup.get(tid, 0)
        if not dry_run and (now_ts - last_alerted) < dedup_hours * 3600:
            continue
        try:
            upd = datetime.fromisoformat(r["updated_at"].replace("Z", "+00:00"))
            age_h = round((datetime.now(timezone.utc) - upd).total_seconds() / 3600, 1)
        except (ValueError, KeyError):
            age_h = None
        item = {
            "id": tid,
            "title": r.get("title"),
            "assigned_to": r.get("assigned_to"),
            "status": r.get("status"),
            "updated_at": r.get("updated_at"),
            "age_hours": age_h,
        }
        stale.append(item)
        if not dry_run:
            new_alerts.append(item)
            dedup[tid] = now_ts
    return stale, new_alerts


def evaluate_offline_pass(
    in_progress_rows: list,
    running_map: dict[str, bool],
    dedup: dict,
    now_ts: float,
    dedup_hours: int,
    dry_run: bool,
) -> tuple[list, list]:
    """Pure function: find tasks whose assignee.running=false."""
    offline: list[dict] = []
    new_alerts: list[dict] = []
    for r in in_progress_rows:
        assignee = r.get("assigned_to")
        if not assignee or assignee not in running_map:
            continue  # unassigned tasks or unknown agents — skip
        if running_map[assignee]:
            continue  # assignee running — not frozen
        # Assignee is offline. Check dedup.
        key = offline_dedup_key(r["id"], assignee)
        last_alerted = dedup.get(key, 0)
        if not dry_run and (now_ts - last_alerted) < dedup_hours * 3600:
            continue
        try:
            upd = datetime.fromisoformat(r["updated_at"].replace("Z", "+00:00"))
            age_h = round((datetime.now(timezone.utc) - upd).total_seconds() / 3600, 1)
        except (ValueError, KeyError):
            age_h = None
        item = {
            "id": r["id"],
            "title": r.get("title"),
            "assigned_to": assignee,
            "status": r.get("status"),
            "updated_at": r.get("updated_at"),
            "age_hours": age_h,
            "reason": "assignee_offline",
        }
        offline.append(item)
        if not dry_run:
            new_alerts.append(item)
            dedup[key] = now_ts
    return offline, new_alerts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=DEFAULT_STALE_HOURS, help="Hours since last update before alerting (age pass)")
    ap.add_argument("--dedup-hours", type=int, default=DEFAULT_DEDUP_HOURS, help="Per-task dedup window for both passes")
    ap.add_argument("--dry-run", action="store_true", help="Report only, do not notify or update dedup")
    ap.add_argument("--no-offline", action="store_true", help="Skip offline-assignee pass (use only age pass)")
    args = ap.parse_args()

    env = load_env(SECRETS)
    if "RGOS_SUPABASE_URL" not in env or "RGOS_SUPABASE_SERVICE_KEY" not in env:
        print(json.dumps({"ok": False, "error": "missing Supabase env"}))
        return 1

    # Age pass
    threshold_iso = datetime.fromtimestamp(time.time() - args.hours * 3600, tz=timezone.utc).isoformat()
    try:
        age_rows = supabase_query(
            env, "orch_tasks",
            {
                "select": "id,title,assigned_to,status,updated_at",
                "status": "eq.in_progress",
                "updated_at": f"lt.{threshold_iso}",
                "limit": "100",
            },
        )
    except urllib.error.HTTPError as e:
        print(json.dumps({"ok": False, "error": f"supabase_http_{e.code}"}))
        return 1
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"supabase_query_{type(e).__name__}"}))
        return 1

    now_ts = time.time()
    dedup = load_dedup() if not args.dry_run else {}

    stale, age_new = evaluate_age_pass(age_rows, dedup, now_ts, args.dedup_hours, args.dry_run)

    # Offline-assignee pass
    offline: list = []
    offline_new: list = []
    if not args.no_offline:
        try:
            in_progress_rows = fetch_in_progress_tasks(env)
        except Exception as e:
            print(f"[stale-monitor] offline pass: in_progress fetch failed: {e}", file=sys.stderr)
            in_progress_rows = []
        running_map = fetch_agent_running_map()
        if in_progress_rows and running_map:
            offline, offline_new = evaluate_offline_pass(
                in_progress_rows, running_map, dedup, now_ts, args.dedup_hours, args.dry_run,
            )

    if age_new:
        notify_orchestrator_age(age_new, args.hours)
    if offline_new:
        notify_orchestrator_offline(offline_new)

    if not args.dry_run:
        save_dedup(dedup)
        append_ledger({
            "run_at": datetime.now(timezone.utc).isoformat(),
            "threshold_hours": args.hours,
            "total_stale": len(age_rows),
            "new_alerts": len(age_new),
            "offline_assignee_alerts": len(offline_new),
        })

    print(json.dumps({
        "ok": True,
        "threshold_hours": args.hours,
        "total_stale": len(age_rows),
        "new_alerts_fired": len(age_new) if not args.dry_run else 0,
        "offline_assignee_alerts": len(offline_new) if not args.dry_run else 0,
        "offline_assignee_tasks": offline,
        "dry_run": args.dry_run,
        "stale_tasks": stale,
    }, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
