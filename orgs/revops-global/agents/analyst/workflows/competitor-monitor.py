#!/usr/bin/env python3
"""
Competitor Monitoring — Weekly digest for Greg.

Runs every Monday 7am PT via analyst agent cron.

For each competitor/vendor:
  1. Fetch key pages (/, /pricing, /about, /careers) and snapshot text
  2. Diff against last week's snapshot — surface new copy changes
  3. Web search for recent news and LinkedIn activity
  4. Build Telegram digest in two sections: Competitors and Vendors

Snapshots stored in: agents/analyst/data/competitor-snapshots/YYYY-MM-DD/
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser


# ─── Config ───────────────────────────────────────────────────────────────────

COMPETITORS = [
    {"name": "Winning by Design",  "domain": "winningbydesign.com"},
    {"name": "Go Nimbly",          "domain": "gonimbly.com"},
    {"name": "RevPartners",        "domain": "revpartners.io"},
    {"name": "Elefante RevOps",    "domain": "elefanterevops.com"},
    {"name": "CS2",                "domain": "cs2.com"},
    {"name": "Skaled",             "domain": "skaled.com"},
    {"name": "Six & Flow",         "domain": "sixandflow.com"},
    {"name": "Iceberg RevOps",     "domain": "icebergrevops.com"},
    {"name": "Domestique",         "domain": "domestique.co"},
    {"name": "Carabiner Group",    "domain": "carabinergroup.com"},
    {"name": "Aptitude 8",         "domain": "aptitude8.com"},
    {"name": "New Breed",          "domain": "newbreedrevenue.com"},
]

VENDORS = [
    {"name": "MadKudu",   "domain": "madkudu.com"},
    {"name": "Cyndra",    "domain": "cyndra.io"},
    {"name": "LeanData",  "domain": "leandata.com"},
    {"name": "Clari",     "domain": "clari.com"},
]

KEY_PAGES = ["/", "/pricing", "/about", "/careers"]

SNAPSHOT_DIR_BASE = os.path.join(
    os.environ.get("CTX_FRAMEWORK_ROOT", os.path.expanduser("~/cortextos")),
    "orgs", os.environ.get("CTX_ORG", "revops-global"),
    "agents", "analyst", "data", "competitor-snapshots"
)

MAX_PAGE_CHARS = 4000   # truncate fetched text per page
REQUEST_TIMEOUT = 12
SLEEP_BETWEEN_FETCHES = 1.5


# ─── Acquisition history ──────────────────────────────────────────────────────
#
# Two complementary checks run during each scan:
#
#   1. Live redirect check (_fetch_raw + _RedirectResult) — detects domains
#      that 301/302 to a different brand's hostname (e.g. carabinergroup.com
#      → sbigrowth.com).  Suppresses content diff on the destination site.
#
#   2. Known-acquisitions lookup (check_acquisition_history) — cross-references
#      entities that were acquired but still serve their own site.  Downgrades
#      apparent "launch" signals to parent-co PR activity for entities acquired
#      within ACQUISITION_LOOKBACK_DAYS.
#
# How to add entries: edit KNOWN_ACQUISITIONS_FILE (JSON array, see schema
# below) or hard-code entries in KNOWN_ACQUISITIONS_FALLBACK.
#
# Schema per entry:
#   {
#     "entity":       "Carabiner Group",          # monitored competitor name (exact match)
#     "acquired_by":  "SBI Growth Advisory",
#     "acquired_on":  "2024-05-28",               # ISO date
#     "source":       "https://..."               # optional attribution URL
#   }
#
# TODO: replace/supplement with a Crunchbase API lookup when
#       CRUNCHBASE_API_KEY is available in the environment.
#       Pattern: GET https://api.crunchbase.com/api/v4/entities/organizations/{slug}
#                ?user_key={key}&field_ids=acquired_by,short_description
#       Map response.properties.acquired_by.value → acquired_by string and
#       response.properties.ipo_status == "was_acquired" → flag.

KNOWN_ACQUISITIONS_FILE = os.path.join(
    os.environ.get("CTX_FRAMEWORK_ROOT", os.path.expanduser("~/cortextos")),
    "orgs", os.environ.get("CTX_ORG", "revops-global"),
    "agents", "analyst", "data", "known-acquisitions.json"
)

KNOWN_ACQUISITIONS_FALLBACK: list[dict] = [
    {
        "entity": "Carabiner Group",
        "acquired_by": "SBI Growth Advisory",
        "acquired_on": "2024-05-28",
        "source": "https://www.privsource.com/acquisitions/deal/sbi-acquires-revops-as-a-service-provider-carabiner-group-bWSnLZ",
    },
]

# Any entity acquired within this many days is considered "recently acquired"
# and will have its launch signals downgraded.
ACQUISITION_LOOKBACK_DAYS = 730  # ~2 years


def _load_known_acquisitions() -> list[dict]:
    """Load the acquisitions list from file (if present) else fall back to hardcoded list."""
    entries = list(KNOWN_ACQUISITIONS_FALLBACK)
    if os.path.exists(KNOWN_ACQUISITIONS_FILE):
        try:
            with open(KNOWN_ACQUISITIONS_FILE) as f:
                file_entries = json.load(f)
            if isinstance(file_entries, list):
                entries = file_entries + entries
        except Exception as e:
            print(f"  [acquisition-check] failed to load {KNOWN_ACQUISITIONS_FILE}: {e}",
                  file=sys.stderr)
    return entries


def check_acquisition_history(entity_name: str) -> dict | None:
    """Return acquisition metadata if this entity was acquired within the lookback window.

    Returns a dict with keys: entity, acquired_by, acquired_on, source, days_since_acquisition
    or None if not found / outside the lookback window.

    TODO: When CRUNCHBASE_API_KEY is set, supplement the static list with a live
    Crunchbase lookup before falling back to KNOWN_ACQUISITIONS_FALLBACK.
    Pattern:
        key = os.environ.get("CRUNCHBASE_API_KEY")
        if key:
            slug = entity_name.lower().replace(" ", "-")
            url = f"https://api.crunchbase.com/api/v4/entities/organizations/{slug}?user_key={key}&field_ids=acquired_by,ipo_status"
            # parse response.properties.acquired_by.value for acquiring company
    """
    acquisitions = _load_known_acquisitions()
    today = datetime.now(timezone.utc).date()

    for entry in acquisitions:
        if entry.get("entity", "").lower() != entity_name.lower():
            continue
        acquired_on_str = entry.get("acquired_on", "")
        try:
            acquired_date = datetime.strptime(acquired_on_str, "%Y-%m-%d").date()
        except ValueError:
            continue
        days_since = (today - acquired_date).days
        if days_since <= ACQUISITION_LOOKBACK_DAYS:
            return {
                **entry,
                "days_since_acquisition": days_since,
            }
    return None


# ─── HTML → text ──────────────────────────────────────────────────────────────

class TextExtractor(HTMLParser):
    SKIP_TAGS = {"script", "style", "nav", "footer", "head", "noscript", "svg", "img"}

    def __init__(self):
        super().__init__()
        self._skip_depth = 0
        self._current_skip_tag = None
        self.chunks = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() in self.SKIP_TAGS:
            self._skip_depth += 1

    def handle_endtag(self, tag):
        if tag.lower() in self.SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data):
        if self._skip_depth == 0:
            text = data.strip()
            if len(text) > 3:
                self.chunks.append(text)

    def get_text(self):
        return " ".join(self.chunks)


def html_to_text(html: str) -> str:
    p = TextExtractor()
    try:
        p.feed(html)
    except Exception:
        pass
    text = p.get_text()
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text[:MAX_PAGE_CHARS]


# ─── HTTP ─────────────────────────────────────────────────────────────────────

class _RedirectResult:
    """Returned by _fetch_raw when the root page redirects to a different brand domain."""

    def __init__(self, original_url: str, final_url: str, html: str | None):
        self.original_url = original_url
        self.final_url = final_url
        self.html = html

    @property
    def original_hostname(self) -> str:
        return urllib.parse.urlparse(self.original_url).hostname or ""

    @property
    def final_hostname(self) -> str:
        return urllib.parse.urlparse(self.final_url).hostname or ""

    @property
    def is_cross_domain_redirect(self) -> bool:
        """True when the redirect lands on a *different* registered domain."""
        orig = _registered_domain(self.original_hostname)
        final = _registered_domain(self.final_hostname)
        return bool(orig and final and orig != final)


def _registered_domain(hostname: str) -> str:
    """Return the last two labels of a hostname (e.g. 'sbigrowth.com')."""
    if not hostname:
        return ""
    parts = hostname.rstrip(".").split(".")
    return ".".join(parts[-2:]) if len(parts) >= 2 else hostname


def fetch_url(url: str) -> str | None:
    """Fetch URL, following redirects transparently.  Returns HTML string or None."""
    return _fetch_raw(url).html


def _fetch_raw(url: str) -> "_RedirectResult":
    """Fetch URL and return a _RedirectResult capturing any cross-domain redirect."""
    final_url = url
    html: str | None = None
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; RevOpsGlobal-Monitor/1.0)",
            "Accept": "text/html,application/xhtml+xml",
        })
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            final_url = resp.url  # urllib follows redirects; resp.url is the final URL
            charset = "utf-8"
            ct = resp.headers.get("Content-Type", "")
            if "charset=" in ct:
                charset = ct.split("charset=")[-1].strip().split(";")[0].strip()
            html = resp.read().decode(charset, errors="replace")
    except Exception as e:
        print(f"  fetch error ({url}): {e}", file=sys.stderr)
    return _RedirectResult(url, final_url, html)


def web_search(query: str) -> str:
    """Simple DuckDuckGo HTML search — extracts snippet text."""
    encoded = urllib.request.quote(query)
    url = f"https://html.duckduckgo.com/html/?q={encoded}"
    html = fetch_url(url)
    if not html:
        return ""

    # Extract result snippets (DDG wraps them in class="result__snippet")
    snippets = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', html, re.DOTALL)
    clean = []
    for s in snippets[:5]:
        text = re.sub(r"<[^>]+>", "", s).strip()
        if text:
            clean.append(text)
    return " | ".join(clean)


# ─── Snapshots ────────────────────────────────────────────────────────────────

def today_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def snapshot_path(date_str: str, slug: str) -> str:
    return os.path.join(SNAPSHOT_DIR_BASE, date_str, f"{slug}.json")


def load_snapshot(date_str: str, slug: str) -> dict | None:
    path = snapshot_path(date_str, slug)
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def save_snapshot(date_str: str, slug: str, data: dict):
    dir_path = os.path.join(SNAPSHOT_DIR_BASE, date_str)
    os.makedirs(dir_path, exist_ok=True)
    with open(snapshot_path(date_str, slug), "w") as f:
        json.dump(data, f, indent=2)


def find_last_snapshot(slug: str, before_date: str) -> dict | None:
    """Find the most recent snapshot for a slug before the given date."""
    if not os.path.exists(SNAPSHOT_DIR_BASE):
        return None
    dates = sorted(
        [d for d in os.listdir(SNAPSHOT_DIR_BASE)
         if os.path.isdir(os.path.join(SNAPSHOT_DIR_BASE, d)) and d < before_date],
        reverse=True
    )
    for d in dates:
        snap = load_snapshot(d, slug)
        if snap:
            return snap
    return None


def text_hash(text: str) -> str:
    return hashlib.md5(text.encode()).hexdigest()[:8]


def diff_snapshots(old: dict, new: dict) -> list[str]:
    """Returns list of human-readable change notes."""
    changes = []
    for page in KEY_PAGES:
        key = page.replace("/", "_") or "_root"
        old_text = old.get("pages", {}).get(key, "")
        new_text = new.get("pages", {}).get(key, "")
        if not old_text and not new_text:
            continue
        if text_hash(old_text) != text_hash(new_text):
            # Find approximate diff — report words added/removed
            old_words = set(old_text.lower().split())
            new_words = set(new_text.lower().split())
            added = [w for w in (new_words - old_words) if len(w) > 5][:8]
            removed = [w for w in (old_words - new_words) if len(w) > 5][:5]
            label = page if page != "/" else "homepage"
            changes.append(f"{label} changed — new terms: {', '.join(added[:5])}"
                           + (f"; removed: {', '.join(removed[:3])}" if removed else ""))
    return changes


# ─── Telegram ─────────────────────────────────────────────────────────────────

def load_chat_id() -> str | None:
    """Returns chat_id from env var or analyst .env. No bot token needed — routes via bus."""
    chat_id = os.environ.get("CTX_TELEGRAM_CHAT_ID") or os.environ.get("CHAT_ID")
    if chat_id:
        return chat_id
    agent_dir = os.path.join(
        os.environ.get("CTX_FRAMEWORK_ROOT", os.path.expanduser("~/cortextos")),
        "orgs", os.environ.get("CTX_ORG", "revops-global"),
        "agents", "analyst"
    )
    env_path = os.path.join(agent_dir, ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if not line or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == "CHAT_ID" and v.strip().strip("'\""):
                    return v.strip().strip("'\"")
    return None


def load_agent_env_var(name: str) -> str | None:
    value = os.environ.get(name)
    if value:
        return value
    agent_dir = os.path.join(
        os.environ.get("CTX_FRAMEWORK_ROOT", os.path.expanduser("~/cortextos")),
        "orgs", os.environ.get("CTX_ORG", "revops-global"),
        "agents", "analyst"
    )
    env_path = os.path.join(agent_dir, ".env")
    if not os.path.exists(env_path):
        return None
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == name and v.strip().strip("'\""):
                return v.strip().strip("'\"")
    return None


def send_telegram_direct(chat_id: str, text: str) -> bool:
    """Fallback for spawned cron workers that do not own the analyst session lock."""
    bot_token = load_agent_env_var("BOT_TOKEN")
    if not bot_token:
        print("Telegram direct fallback unavailable: BOT_TOKEN not found", file=sys.stderr)
        return False
    try:
        payload = json.dumps({
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "Markdown",
        }).encode("utf-8")
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            if resp.status != 200:
                print(f"Telegram direct fallback error: HTTP {resp.status} {body}", file=sys.stderr)
                return False
        return True
    except Exception as e:
        print(f"Telegram direct fallback error: {e}", file=sys.stderr)
        return False


def send_telegram(chat_id: str, text: str) -> bool:
    """Send via cortextos bus, with direct bot fallback for spawned cron workers."""
    if len(text) > 4000:
        text = text[:3950] + "\n…(truncated)"
    try:
        result = subprocess.run(
            ["cortextos", "bus", "send-telegram", chat_id, text],
            capture_output=True, text=True, timeout=15
        )
        if result.returncode != 0:
            print(f"Telegram send error: {result.stderr.strip()}", file=sys.stderr)
            if "session.lock" in result.stderr:
                return send_telegram_direct(chat_id, text)
            return False
        return True
    except Exception as e:
        print(f"Telegram send error: {e}", file=sys.stderr)
        return False


# ─── Hiring role extraction ──────────────────────────────────────────────────

# Common role title patterns found on /careers pages
ROLE_PATTERNS = [
    r"(?:senior|sr\.?|junior|jr\.?|lead|staff|principal|head of|vp of|director of|manager)?\s*"
    r"(?:revops|revenue operations|sales operations|marketing operations|hubspot|salesforce|"
    r"account executive|sdr|bdr|customer success|solutions engineer|solutions architect|"
    r"consultant|strategist|analyst|developer|engineer|designer|project manager|"
    r"growth|demand gen|content|partnerships|enablement|implementation)"
    r"(?:\s*(?:manager|lead|specialist|coordinator|associate|intern))?",
]


def extract_hiring_roles(careers_text: str) -> list[str]:
    """Extract job role titles from careers page text. Returns up to 8 unique roles."""
    if not careers_text or len(careers_text) < 20:
        return []

    roles = set()
    text_lower = careers_text.lower()

    for pattern in ROLE_PATTERNS:
        matches = re.findall(pattern, text_lower, re.IGNORECASE)
        for m in matches:
            role = m.strip()
            if len(role) > 5 and role not in {"senior", "junior", "lead", "staff", "manager"}:
                roles.add(role.title())

    # Also try to find lines that look like job titles (short lines with title case)
    for line in careers_text.split("."):
        line = line.strip()
        words = line.split()
        if 2 <= len(words) <= 8 and any(kw in line.lower() for kw in
            ["engineer", "manager", "analyst", "consultant", "specialist", "strategist",
             "director", "architect", "developer", "designer", "coordinator",
             "operations", "revops", "hubspot", "salesforce", "account exec",
             "sdr", "bdr", "enablement", "implementation"]):
            role = " ".join(w.strip(",;:()") for w in words if w.strip(",;:()"))
            if 8 < len(role) < 60:
                roles.add(role)

    return sorted(roles)[:8]


# ─── Per-company scan ─────────────────────────────────────────────────────────

def scan_company(company: dict, today: str) -> dict:
    """Fetch pages + news search, return snapshot + summary."""
    name = company["name"]
    domain = company["domain"]
    slug = re.sub(r"[^a-z0-9]", "-", name.lower())

    print(f"  Scanning {name} ({domain})…")

    # ── Redirect check on root page ───────────────────────────────────────────
    # A 301/302 that lands on a different registered domain is an
    # acquisition_redirect signal, NOT a product launch.  Detect this before
    # snapshotting page text so we don't diff content that belongs to a
    # different brand.
    root_result = _fetch_raw(f"https://{domain}/")
    acquisition_redirect: dict | None = None
    if root_result.is_cross_domain_redirect:
        acquisition_redirect = {
            "signal": "acquisition_redirect",
            "original_domain": root_result.original_hostname,
            "redirect_destination": root_result.final_hostname,
            "urgency": "low",
            "note": (
                f"{domain} redirects to {root_result.final_hostname} — "
                "likely an acquisition/brand-consolidation artifact, "
                "not a new product launch. Verify against acquisition history."
            ),
        }
        print(
            f"  [acquisition_redirect] {domain} → {root_result.final_hostname}",
            file=sys.stderr,
        )
    time.sleep(SLEEP_BETWEEN_FETCHES)

    pages = {}
    for path in KEY_PAGES:
        url = f"https://{domain}{path}"
        # Reuse the already-fetched root; fetch the rest normally
        if path == "/":
            html = root_result.html
        else:
            html = fetch_url(url)
            time.sleep(SLEEP_BETWEEN_FETCHES)
        key = path.replace("/", "_") or "_root"
        pages[key] = html_to_text(html) if html else ""

    # News/LinkedIn search
    query = f'"{name}" RevOps site:linkedin.com OR site:techcrunch.com OR site:g2.com 2026'
    news_snippet = web_search(query)
    time.sleep(SLEEP_BETWEEN_FETCHES)

    snapshot = {
        "name": name,
        "domain": domain,
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "pages": pages,
        "news": news_snippet,
    }
    if acquisition_redirect:
        snapshot["acquisition_redirect"] = acquisition_redirect
    save_snapshot(today, slug, snapshot)

    # Diff against last snapshot
    last = find_last_snapshot(slug, today)
    raw_changes = diff_snapshots(last, snapshot) if last else ["(first scan — no diff)"]

    # ── Signal classification ─────────────────────────────────────────────────
    # Priority: live redirect > known acquisition history > plain content diff
    acquisition_info: dict | None = None
    if acquisition_redirect:
        # Cross-domain redirect — suppress content diff, surface as low-urgency signal
        changes = [
            f"[acquisition_redirect] {domain} → {acquisition_redirect['redirect_destination']} "
            "(301/302 cross-domain redirect — classify as acquisition artifact, not launch)"
        ]
    else:
        # Check known-acquisitions list for entities still serving their own site
        acquisition_info = check_acquisition_history(name)
        if acquisition_info and raw_changes and raw_changes != ["(first scan — no diff)"]:
            acq_note = (
                f"[acquisition-downgrade] {name} was acquired by "
                f"{acquisition_info['acquired_by']} on {acquisition_info['acquired_on']} "
                f"({acquisition_info['days_since_acquisition']}d ago) — "
                "page changes likely reflect parent-co activity, not a new competitor launch"
            )
            changes = [acq_note] + [f"  (raw diff suppressed) {c}" for c in raw_changes]
            print(
                f"  [acquisition-downgrade] {name}: acquired {acquisition_info['acquired_on']}; "
                "suppressing launch classification",
                file=sys.stderr,
            )
        else:
            changes = raw_changes

    # Extract hiring roles from careers page text
    careers_text = pages.get("_careers", "")
    hiring_roles = extract_hiring_roles(careers_text) if careers_text.strip() else []

    return {
        "name": name,
        "changes": changes,
        "news": news_snippet[:300] if news_snippet else "",
        "careers_active": bool(careers_text.strip()),
        "hiring_roles": hiring_roles,
        "acquisition_redirect": acquisition_redirect,
        "acquisition_info": acquisition_info,
    }


# ─── Digest formatter ─────────────────────────────────────────────────────────

def format_digest(competitor_results: list[dict], vendor_results: list[dict], today: str) -> str:
    lines = [f"*Competitor Monitor — {today}*\n"]

    lines.append("*COMPETITORS*")
    for r in competitor_results:
        acq_redirect = r.get("acquisition_redirect")
        acq_info = r.get("acquisition_info")
        hiring_roles = r.get("hiring_roles", [])
        hiring = " 🔥 *hiring*" if r["careers_active"] else ""
        lines.append(f"\n*{r['name']}*{hiring}")
        if hiring_roles:
            lines.append(f"  Roles: {', '.join(hiring_roles[:5])}")
        if acq_redirect:
            # Live cross-domain redirect — low-urgency acquisition artifact
            lines.append(
                f"  Signal: [acquisition_redirect] {acq_redirect['original_domain']} "
                f"→ {acq_redirect['redirect_destination']} (low urgency — "
                "301/302 cross-domain, likely acquisition artifact)"
            )
        elif acq_info:
            # Known acquisition — signals downgraded
            lines.append(
                f"  Acquired by {acq_info['acquired_by']} ({acq_info['acquired_on']}, "
                f"{acq_info['days_since_acquisition']}d ago) — signals downgraded"
            )
            changes_str = "; ".join(r["changes"]) if r["changes"] else "no changes detected"
            lines.append(f"  Changes: {changes_str}")
        else:
            changes_str = "; ".join(r["changes"]) if r["changes"] else "no changes detected"
            lines.append(f"  Changes: {changes_str}")
        if r["news"]:
            lines.append(f"  News: {r['news'][:200]}")

    lines.append("\n*VENDORS/PARTNERS*")
    for r in vendor_results:
        changes_str = "; ".join(r["changes"]) if r["changes"] else "no changes"
        lines.append(f"\n*{r['name']}*")
        lines.append(f"  Changes: {changes_str}")
        if r["news"]:
            lines.append(f"  News: {r['news'][:150]}")

    lines.append(f"\n_Snapshots saved to data/competitor-snapshots/{today}/_")
    return "\n".join(lines)


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    today = today_str()
    print(f"=== Competitor Monitor ({today}) ===")

    chat_id = load_chat_id()
    if not chat_id:
        print("ERROR: CHAT_ID not found (checked CTX_TELEGRAM_CHAT_ID, CHAT_ID env vars, analyst .env)", file=sys.stderr)
        sys.exit(1)

    competitor_results = []
    print("\n--- COMPETITORS ---")
    for company in COMPETITORS:
        result = scan_company(company, today)
        competitor_results.append(result)

    vendor_results = []
    print("\n--- VENDORS ---")
    for company in VENDORS:
        result = scan_company(company, today)
        vendor_results.append(result)

    digest = format_digest(competitor_results, vendor_results, today)
    print("\n" + digest)

    ok = send_telegram(chat_id, digest)
    if ok:
        print("\nDigest sent to Telegram.")
    else:
        print("\nERROR: Telegram send failed — digest printed above.", file=sys.stderr)


if __name__ == "__main__":
    main()
