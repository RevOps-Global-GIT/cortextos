# Vignette Pipeline Skill

Daily stop-motion scene for the Estate App home page hero.

---

## Architecture

- **Source**: `public/vignettes/YYYY-MM-DD.json` committed to RevOps-Global-GIT/ob1-app
- **Component**: `app/components/DailyVignette.tsx` with `variant="hero"` on Estate home
- **Rendered fields**: `title` (hero heading), `beat` (caption), `image` (poster/fallback), `video` (preferred when present)
- **Fallback**: If JSON missing or `title`/`image` absent → renders `DailyVignetteHeroFallback` (standard hero card)

---

## Engine: Primary — generate-daily-vignette.mjs

`ob1-app/scripts/generate-daily-vignette.mjs` is the daily image generator. Runs at ~02:00 PT.

**Pipeline:**
1. Fetches weather signals from Open-Meteo for the Estate (lat 45.8153, lon -122.741)
2. Fetches estate context from Supabase: top insight, priority tasks, egg count, harvests, hive inspections, orchard events, mushroom batches, cottage stays
3. `pickCharacter(signals)` selects chunk / petunia / chunkita based on weather + weekday fallback
4. `composeBeat()` + `composeTitle()` write the prose from character + signals + estate context
5. `composePrompt()` assembles the Wes Anderson Isle of Dogs stop-motion prompt (already contains all style constraints — no external STYLE LOCK needed)
6. Calls `nano-banana-generate.py` via `uv run` with `-i reference/<character>-canonical.png` as character lock
7. Output: `public/vignettes/YYYY-MM-DD-{character}.jpg` + `YYYY-MM-DD.json` sidecar

**Character refs** (canonical PNGs — identity locked):

| Key | File |
|-----|------|
| chunk | `reference/chunk-canonical.png` |
| petunia | `reference/petunia-canonical.png` |
| chunkita | `reference/chunkita-canonical.png` |

Additional canonical PNGs in `/home/cortextos/ob1-app/reference/`: greg, tiffany, dad, mom, alejandro, winston, maple, littlebit, minbit, percy, ducks, chickens.

**Usage:**
```bash
node scripts/generate-daily-vignette.mjs            # today
node scripts/generate-daily-vignette.mjs 2026-05-19 # specific date
node scripts/generate-daily-vignette.mjs --force    # rerender even if present
```

**Env required**: `GEMINI_API_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_OB1_USER_ID`

---

## Engine: Secondary — Veo 3.1 loop video (canonical video path)

Wraps tonight's still into a seamless 8-second loop via `veo-3.1-fast-generate-preview`.

**Inputs:**
- Still image from primary engine (`public/vignettes/YYYY-MM-DD-{character}.jpg`) used as **both start_frame AND last_frame** for seamless looping
- Character-specific motion prompt (NEVER re-specifies appearance — the still locks identity). Motion can range from micro-movements (breathing) to fuller actions (walking, rolling, drinking, investigating a prop) — pick what fits the day's beat:
  - `chunk`: breathing + ear flicks, OR walking toward a bed, OR drinking from puddle, OR ambient still posture with cherry blossom drift
  - `petunia`: calm head tilt + ear flick, OR slow roll in mud, OR sheltering motion if raining, OR rooting in moss
  - `chunkita`: curious head bob, OR small investigative step, OR sniff-and-look-up sequence
  - family members (`greg`, `tiffany`, `dad`, `mom`, `alejandro`, etc.) can appear when narratively appropriate — e.g. Greg's birthday vignette could include Greg + Tiffany + Chunk together; harvest day could include Dad inspecting orchard with Chunkita. Multi-character scenes use multiple `-i` references on the upstream still, then Veo loop motion as usual.

**Pipeline:**
1. `google.genai.Client(api_key=GEMINI_API_KEY).models.generate_videos(...)` with `GenerateVideosSource(prompt, image)` + `GenerateVideosConfig(duration_seconds=8, aspect_ratio="16:9", last_frame=image)`
2. Poll `client.operations.get(op)` every 15s (typically 3 polls / ~45s)
3. Download MP4 from `op.result.generated_videos[0].video.uri` with `&key=API_KEY`
4. ffmpeg crop watermark + scale: `crop=1156:650:62:0,scale=1280:720:flags=lanczos -c:v libx264 -preset slow -crf 28 -pix_fmt yuv420p -movflags +faststart -an`
5. Save to `public/vignettes/YYYY-MM-DD-{character}-loop.mp4`
6. Add `"video"` field to JSON sidecar referencing the MP4

**Reference implementations:**
- `ob1-parents/lib/veo-client.ts` — TypeScript Veo client with Supabase storage upload
- `ob1-app/scripts/generate-hero-loops.py` — Python Veo invocation pattern (see `generate_loop()`)

**Key constraint**: API key. `GEMINI_API_KEY` in `ob1-app/.env.local` is the paid project. Org `secrets.env` key is on a different metering bucket and was 429'd on prepayment as of 2026-05-24. Use the `.env.local` key.

## Engine: Tertiary — Flow via mac-codex (manual fallback only)

Use ONLY if Veo API is down/quota-exhausted AND the daily loop must ship. Uses Greg's 20K Vertex/AI Studio browser credits via labs.google/flow on Greg's Mac. Reference Character via `-p <character>` (Characters library, built from same canonical PNG). Stitch mode with still as start+end frame. Manual operation — slow, non-automated.

---

## Character Continuity Rule (Greg directive 2026-05-23)

- Animals and people **MUST** come from canonical PNG: `-i` flag for nano-banana, Flow Characters `-p` for the tertiary fallback
- Poses, activities, motion, and scenes vary daily — **identity never varies**
- Family members (`greg`, `tiffany`, `dad`, `mom`, `alejandro`, etc.) are valid canonicals — include them when narratively appropriate (birthdays, harvest days, cottage stays, etc.)
- Multi-character scenes allowed — pass multiple `-i` refs (nano-banana supports up to 14)
- No fresh generic characters without the canonical reference — this is what caused the "generic chicken" incident

## Daily Contextual Relevance Rule (Greg directive 2026-05-23)

Every vignette must reference today's real estate signals — not a generic seasonal scene.

`composePrompt()` already pulls from Supabase:
- `estate_insights` top current insight (e.g. "Greg's birthday 5/29, drizzle 5/25-27")
- `maintenance_tasks` priority due within 7d
- `harvest_log` recent + `plantings` ready-to-harvest within 2d
- `egg_production` today's count
- `hive_inspections`, `orchard_events`, `mushroom_batches`, `cottage_stays`

The Veo motion prompt should ALSO weave in context where it adds visual storytelling — e.g.:
- Birthday week → drift birthday-cake confetti past the character; include a tiny May 29 sign prop (as in 2026-05-23-chunk.jpg)
- Egg morning → tiny basket of eggs in foreground rocks subtly
- Drizzle coming → cherry blossom petals shift just before a rain droplet hits the puddle
- Cottage guest arriving → distant warm-lit cottage window flickers on

**Required env for Supabase context fetch**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_OB1_USER_ID`. If estate context returns empty, the generator falls back to generic season copy — that's a **data gap** (Greg needs to populate Estate tables), NOT a code bug.

---

## JSON Format

```json
{
  "version": 1,
  "date": "YYYY-MM-DD",
  "character": "chunk",
  "image": "YYYY-MM-DD-chunk.jpg",
  "video": "YYYY-MM-DD-scene.mp4",
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

**Fields**:
- `image` (required): JPG filename. Used as `<img>` and as `<video poster>` when video is present.
- `video` (optional): MP4 filename. When present, component renders `<video autoPlay muted loop playsInline>` instead of image.
- `title` + `image` both required — if either absent, falls back to static hero card.

**iOS Safari**: `playsInline` required for inline autoplay; `muted` required for autoplay without user gesture.

**Git note**: `public/vignettes/` is in `.gitignore` but files are tracked. Use `git add -f` for both JSON and MP4 files.

---

## Broken Title Fix Protocol

**Symptoms**: Wrong/broken text appears as the Estate home hero heading.

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

Run against `hubauzvpxuparrvqjytt` (ob1-app prod). If count > 0, dismiss + insert replacements via Supabase MCP (generate API is PIN-gated). Rollback: `UPDATE estate_insights SET dismissed=false WHERE id IN (...)`.

---

## Contamination Risk

The generator uses the live `estate_insights` primary row as narrative context. If a broken-pattern row is live at generation time (~02:00 PT), its copy contaminates the vignette `title` and `beat`. Path A critic gate (PR #135) prevents new broken rows; run Path B cleanup to dismiss any pre-Path-A legacy rows.
