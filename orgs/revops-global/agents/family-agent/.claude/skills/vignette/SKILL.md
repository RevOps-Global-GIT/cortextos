# Vignette Pipeline Skill

Daily stop-motion scene for the Estate App home page hero.

---

## Architecture

- **Source**: `public/vignettes/YYYY-MM-DD.json` committed to RevOps-Global-GIT/ob1-app
- **Component**: `app/components/DailyVignette.tsx` with `variant="hero"` on Estate home
- **Rendered fields**: `title` (hero heading), `beat` (caption), `image` (filename relative to `/vignettes/`)
- **Fallback**: If JSON missing or `title`/`image` absent → renders `DailyVignetteHeroFallback` (standard hero card with greeting)

## JSON Format

```json
{
  "version": 1,
  "date": "YYYY-MM-DD",
  "character": "chunk",
  "image": "YYYY-MM-DD-chunk.jpg",
  "title": "Clean Title Case Here",
  "beat": "Clean beat prose. No pronoun prefix.",
  "signals": {
    "season": "spring",
    "time_of_day": "day",
    "condition": "clear",
    "temp_f": 52,
    "weekday": "SAT"
  }
}
```

**Git note**: `public/vignettes/` is in `.gitignore` but files are tracked. Use `git add -f public/vignettes/YYYY-MM-DD.json`.

---

## Broken Title Fix Protocol

**Symptoms**: Wrong/broken text appears as the Estate home hero heading (below the date).

1. Identify committed JSON:
   ```bash
   cd /home/cortextos/ob1-app && git show HEAD:public/vignettes/YYYY-MM-DD.json
   ```
2. Check for broken patterns (see 8-Check below)
3. Rewrite `title` and `beat` with clean copy
4. Stage + commit + push:
   ```bash
   git checkout -b fix/vignette-title-MMDD
   git add -f public/vignettes/YYYY-MM-DD.json
   git commit -m "fix(vignette): clean broken-pattern title YYYY-MM-DD"
   git push origin fix/vignette-title-MMDD
   gh pr create --base main ...
   ```
5. After deploy, verify production:
   ```bash
   curl https://ob1.revopsglobal.com/vignettes/YYYY-MM-DD.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['title'], '|', d.get('beat',''))"
   ```

---

## 8-Check Rules (applied to title + beat)

Reject if any pattern found:

| Check | Pattern |
|-------|---------|
| title_case_and | ` and ` between noun phrases (no verb) |
| at_temperature | `at [number]F` or `at [number]C` in title |
| at_day | `at [weekday]` in title |
| pronoun_prefix | beat starts with "He/She/It has/is/was/has been" |
| not_title_case | any word in title not capitalized |
| metadata | emoji, `!`, source/model tags |
| hedging | "might", "could", "may want to consider" |

---

## Detection SQL (estate_insights broken rows)

```sql
SELECT id, title, dismissed, expires_at FROM estate_insights
WHERE dismissed = false AND expires_at > now()
  AND (
    (title ~ ' and ' AND title ~ ' [A-Z][a-z]')
    OR title ~* ' at \d+[fF]'
    OR title ~* ' at (monday|tuesday|wednesday|thursday|friday|saturday|sunday)'
    OR body ~* '^(he|she|it) has '
    OR body ~* '^(he|she|it) (is|was|has been)'
  );
```

Run against `hubauzvpxuparrvqjytt` (ob1-app prod). If count > 0, dismiss + insert replacements via Supabase MCP. Rollback: `UPDATE estate_insights SET dismissed=false WHERE id IN (...)`.

---

## Contamination Risk

The vignette generator uses the live `estate_insights` primary row as narrative context at generation time. If a broken-pattern insight is live during the daily generation window (~02:00 UTC), its copy will appear in the vignette `title` and `beat`. Path A critic gate (PR #135) prevents new broken rows from landing; run Path B cleanup to dismiss any pre-Path-A legacy rows.
