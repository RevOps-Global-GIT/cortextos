#!/usr/bin/env python3
"""
Nightly skill QA audit for team-brain .claude/skills/.
Writes report to .cortexos/wiki-publisher/team-brain/docs/skill-health-YYYY-MM-DD.md
and POSTs snapshot row to shared_snapshots in data Supabase.
"""
import os
import re
import json
import datetime
import subprocess
import urllib.request
import urllib.error

REPO_ROOT = os.environ.get("SKILL_QA_REPO_ROOT", "/home/cortextos/.cortexos/wiki-publisher/team-brain")
SKILLS_ROOT = os.path.join(REPO_ROOT, ".claude/skills")
DOCS_DIR = os.path.join(REPO_ROOT, "docs")
PROPOSALS_DIR = os.path.join(REPO_ROOT, ".claude/orchestration/skill-proposals")
PLUGIN_JSON = os.path.join(REPO_ROOT, "plugin.json")
SUPABASE_URL = "https://hubauzvpxuparrvqjytt.supabase.co"

META_CONTAINERS = {"_proposed", "_templates", "_data-analytics", "_gtm-agents", "_tools"}

def get_api_key():
    secrets_path = "/home/cortextos/cortextos/orgs/revops-global/secrets.env"
    with open(secrets_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("SUPABASE_DATA_SERVICE_KEY="):
                return line.split("=", 1)[1].strip()
    return None

def validate_skill(skill_dir, skill_name):
    skill_md = os.path.join(skill_dir, "SKILL.md")
    issues = []
    warnings = []

    if not os.path.exists(skill_md):
        return "critical", ["No SKILL.md found"], []

    with open(skill_md, encoding="utf-8", errors="replace") as f:
        content = f.read()

    # Check frontmatter
    fm_match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
    if not fm_match:
        issues.append("Missing or malformed YAML frontmatter")
    else:
        fm = fm_match.group(1)
        # name: field
        name_match = re.search(r'^name:\s*(.+)$', fm, re.MULTILINE)
        if not name_match:
            issues.append("Missing 'name:' in frontmatter")
        elif name_match.group(1).strip() != skill_name:
            issues.append(f"name: '{name_match.group(1).strip()}' doesn't match dir '{skill_name}'")
        # description:
        desc_match = re.search(r'^description:', fm, re.MULTILINE)
        if not desc_match:
            issues.append("Missing 'description:' in frontmatter")
        else:
            # Check for trigger phrases
            desc_text = content[fm_match.end():]
            if len(desc_text.strip()) < 50:
                warnings.append("Description too short (<50 chars after frontmatter)")

    # Deprecated tool refs
    deprecated = ["Lovable", "v0.dev"]
    for dep in deprecated:
        if dep.lower() in content.lower():
            warnings.append(f"References deprecated tool: {dep}")

    if issues:
        return "critical", issues, warnings
    if warnings:
        return "warning", [], warnings
    return "pass", [], []

def check_proposals():
    proposals = []
    if not os.path.exists(PROPOSALS_DIR):
        return proposals
    for fname in os.listdir(PROPOSALS_DIR):
        if fname.startswith("proposal-") and fname.endswith(".md"):
            fpath = os.path.join(PROPOSALS_DIR, fname)
            # Check it's not in archived subdir
            proposals.append(fname)
    return proposals

def get_plugin_count():
    if not os.path.exists(PLUGIN_JSON):
        return None
    with open(PLUGIN_JSON) as f:
        data = json.load(f)
    skills = data.get("skills", [])
    return len(skills)

def git(*args):
    return subprocess.run(
        ["git", "-C", REPO_ROOT, *args],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    ).stdout.strip()

def commit_and_push_report(report_path, today):
    rel_path = os.path.relpath(report_path, REPO_ROOT)
    dry_run = os.environ.get("SKILL_QA_GIT_DRY_RUN")

    status = git("status", "--porcelain", "--", rel_path)
    if not status:
        print(f"No git changes for {rel_path}; skipping push")
        return

    git("add", rel_path)
    staged = git("diff", "--cached", "--name-only", "--", rel_path)
    if not staged:
        print(f"No staged changes for {rel_path}; skipping push")
        return

    if dry_run:
        print(f"SKILL_QA_GIT_DRY_RUN=1; would commit and push {rel_path} to origin/main")
        git("reset", "--", rel_path)
        return

    commit_cmd = [
        "git",
        "-C",
        REPO_ROOT,
        "-c",
        "user.email=greg@revopsglobal.com",
        "-c",
        "user.name=Greg Harned",
        "commit",
        "-m",
        f"docs(skills): skill health report {today}",
    ]
    subprocess.run(commit_cmd, check=True)
    subprocess.run(["git", "-C", REPO_ROOT, "fetch", "origin", "main"], check=True)
    subprocess.run(["git", "-C", REPO_ROOT, "rebase", "origin/main"], check=True)
    subprocess.run(["git", "-C", REPO_ROOT, "push", "origin", "HEAD:main"], check=True)
    print(f"Pushed {rel_path} to origin/main")

def run_qa():
    today = datetime.date.today().strftime("%Y-%m-%d")

    if not os.path.isdir(SKILLS_ROOT):
        print(f"ERROR: Skills directory not found: {SKILLS_ROOT}")
        return

    skill_dirs = [
        d for d in os.listdir(SKILLS_ROOT)
        if os.path.isdir(os.path.join(SKILLS_ROOT, d)) and d not in META_CONTAINERS
    ]
    skill_dirs.sort()

    results = {}
    counts = {"pass": 0, "warning": 0, "critical": 0}

    for skill_name in skill_dirs:
        skill_path = os.path.join(SKILLS_ROOT, skill_name)
        status, issues, warnings = validate_skill(skill_path, skill_name)
        results[skill_name] = {"status": status, "issues": issues, "warnings": warnings}
        counts[status] += 1

    total = len(skill_dirs)
    proposals = check_proposals()
    plugin_count = get_plugin_count()

    # Build report
    lines = [
        f"# Skill Health Report — {today}",
        "",
        "## Summary",
        "",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Total skills scanned | {total} |",
        f"| Pass | {counts['pass']} |",
        f"| Warnings | {counts['warning']} |",
        f"| Critical | {counts['critical']} |",
    ]
    if plugin_count is not None:
        match_note = "✓" if plugin_count == counts["pass"] + counts["warning"] else f"⚠ plugin.json has {plugin_count}"
        lines.append(f"| Plugin.json count | {plugin_count} {match_note} |")
    lines.append("")

    if counts["critical"] > 0:
        lines += ["## Critical Issues", ""]
        for skill_name, r in results.items():
            if r["status"] == "critical":
                lines.append(f"### `{skill_name}`")
                for issue in r["issues"]:
                    lines.append(f"- {issue}")
                lines.append("")

    if counts["warning"] > 0:
        lines += ["## Warnings", ""]
        for skill_name, r in results.items():
            if r["status"] == "warning":
                lines.append(f"- **{skill_name}**: " + "; ".join(r["warnings"]))
        lines.append("")

    lines += ["## Per-Skill Results", ""]
    lines.append("| Skill | Status | Notes |")
    lines.append("|-------|--------|-------|")
    for skill_name, r in results.items():
        status_icon = {"pass": "✅", "warning": "⚠️", "critical": "❌"}[r["status"]]
        notes = "; ".join(r["issues"] + r["warnings"]) or ""
        lines.append(f"| {skill_name} | {status_icon} {r['status']} | {notes} |")
    lines.append("")

    if proposals:
        lines += ["## Pending Skill Proposals", ""]
        for p in proposals:
            lines.append(f"- {p}")
        lines.append("")

    report_content = "\n".join(lines)
    report_path = os.path.join(DOCS_DIR, f"skill-health-{today}.md")

    os.makedirs(DOCS_DIR, exist_ok=True)
    with open(report_path, "w") as f:
        f.write(report_content)
    print(f"Report written: {report_path}")
    commit_and_push_report(report_path, today)

    # POST to shared_snapshots
    api_key = get_api_key()
    if not api_key:
        print("ERROR: SUPABASE_DATA_SERVICE_KEY not found in secrets.env")
        return

    row_id = f"skill-qa-{today}"
    payload = json.dumps({
        "id": row_id,
        "data": {
            "run_date": today,
            "skills_total": total,
            "pass": counts["pass"],
            "warnings": counts["warning"],
            "critical": counts["critical"],
            "report_path": report_path,
            "snapshot_type": "skill_qa"
        }
    }).encode()

    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/shared_snapshots",
        data=payload,
        headers={
            "apikey": api_key,
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates",
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"Snapshot written: {row_id} (HTTP {resp.status})")
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"ERROR posting snapshot: HTTP {e.code} — {body}")

    # Summary
    print(f"QA complete: {total} skills — {counts['pass']} pass, {counts['warning']} warn, {counts['critical']} critical")
    if counts["critical"] > 0:
        print("ALERT: Critical issues found. Review report.")

if __name__ == "__main__":
    run_qa()
