#!/usr/bin/env python3
"""
Fathom Brief Digest — extracts pending action items from recent meetings.

Queries the RGOS Supabase `pending_fathom_meetings` table for meetings
from the last 7 days with incomplete action items. Outputs a formatted
summary suitable for inclusion in the morning brief.

Requires: SUPABASE_RGOS_URL and SUPABASE_RGOS_SERVICE_KEY in environment
(sourced from orgs/revops-global/secrets.env).
"""

import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

def main():
    url = os.environ.get("SUPABASE_RGOS_URL")
    key = os.environ.get("SUPABASE_RGOS_SERVICE_KEY")

    if not url or not key:
        # Try sourcing from secrets.env
        secrets_path = os.path.join(
            os.environ.get("CTX_FRAMEWORK_ROOT", os.path.expanduser("~/cortextos")),
            "orgs",
            os.environ.get("CTX_ORG", "revops-global"),
            "secrets.env",
        )
        if os.path.exists(secrets_path):
            with open(secrets_path) as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#") and "=" in line:
                        k, v = line.split("=", 1)
                        os.environ.setdefault(k.strip(), v.strip().strip("'\""))
            url = os.environ.get("SUPABASE_RGOS_URL")
            key = os.environ.get("SUPABASE_RGOS_SERVICE_KEY")

    if not url or not key:
        print("No Fathom data available (missing Supabase credentials)")
        return

    # Query meetings from last 7 days with pending status
    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    endpoint = (
        f"{url}/rest/v1/pending_fathom_meetings"
        f"?select=title,meeting_date,action_items,summary"
        f"&meeting_date=gte.{cutoff}"
        f"&order=meeting_date.desc"
        f"&limit=10"
    )

    req = urllib.request.Request(
        endpoint,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            meetings = json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"No Fathom data available (query failed: {e})")
        return

    if not meetings:
        print("No recent Fathom meetings with pending action items.")
        return

    # Extract incomplete action items
    output_lines = []
    total_items = 0

    for meeting in meetings:
        title = meeting.get("title", "Untitled")
        date_str = meeting.get("meeting_date", "")
        action_items = meeting.get("action_items") or []

        # Filter to incomplete items only
        pending = [a for a in action_items if not a.get("completed", True)]
        if not pending:
            continue

        # Format date
        try:
            dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
            date_label = dt.strftime("%b %d")
        except (ValueError, AttributeError):
            date_label = "recent"

        output_lines.append(f"*{title}* ({date_label}):")
        for item in pending:
            assignee = item.get("assignee", {}).get("name", "Unassigned")
            desc = item.get("description", "No description")
            output_lines.append(f"  - [{assignee}] {desc}")
            total_items += 1

    if not output_lines:
        print("No pending Fathom action items.")
        return

    print(f"Fathom Action Items ({total_items} pending from {len(output_lines) - total_items} meetings):\n")
    print("\n".join(output_lines))


if __name__ == "__main__":
    main()
