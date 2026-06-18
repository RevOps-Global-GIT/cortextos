Compile Greg's daily morning brief. Do this exactly once, then stop.

STEP 1 — GATHER CONTEXT (five sources):

a) Market scan: 2 targeted web searches — RevOps/MarOps/GTM trends or competitor moves in 2026, and AI-native sales/marketing ops tools gaining traction. Only concrete, citable signals.

b) RGOS: mcp__rgos__rgos_dashboard and mcp__rgos__rgos_pipeline_summary. Flag at-risk, overdue, or no-recent-update items. Gather Pipeline Pulse data:
   - Stage advancements in last 24h: top 3 deals by dollar value, with stage and owner.
   - Stale-deal watch: any deal stuck >14d in the same stage.
   - Close-date watch: deals with close_date within the next 7 days (or past due), listed by company + amount + stage + owner.
   Live data only — if a watch finds nothing, omit that line entirely; never manufacture a callout.

c) Fathom action items: python3 $CTX_FRAMEWORK_ROOT/scripts/fathom-brief-digest.py — include the output in the Delivery section.

f) RGOS project health: call mcp__rgos__rgos_list_projects. For each active project, check for: (1) any milestone with due_date before today and status != completed (overdue milestone), or (2) budget utilization >90% (total_spent / budget > 0.90). Collect up to 2 flagged projects (project name + flag reason). If nothing fires, omit entirely — never manufacture a project health callout.

d) Open Brain: search for high-signal captures from the last 7 days. Queries: "product idea", "client pain", "market signal". Include only if genuinely novel.

e) Today's external meetings (ABSORBED FROM RETIRED MEETING-PREP AGENT):
   Run this bash to get today's calendar:
   TODAY=$(date -u +%Y-%m-%dT00:00:00Z)
   TOMORROW=$(date -u -d '+1 day' +%Y-%m-%dT00:00:00Z 2>/dev/null || date -u -v+1d +%Y-%m-%dT00:00:00Z)
   gws calendar:v3 events list --params "{\"calendarId\":\"primary\",\"timeMin\":\"$TODAY\",\"timeMax\":\"$TOMORROW\",\"singleEvents\":true,\"orderBy\":\"startTime\"}" --format json

   Filter for prep-worthy meetings: at least one attendee with email domain NOT @revopsglobal.com, NOT @supremeopti.com, NOT @gmail.com. Not all-day. Not a recurring internal sync. Title suggests business context (BD, discovery, intro, review, QBR, kickoff, proposal, demo, sales, partnership).

   For each qualifying meeting, brief enrichment: check mcp__rgos__list_clients / search for existing client context, search knowledge-base for the company, check recent Gmail with attendees. 2–3 sentences of intel per meeting is enough — this is a one-line-per-meeting summary, not a full prep deck.

STEP 2 — COMPOSE THE BRIEF (one message, keep under 400 words total; the brief body excluding Today's Meetings stays under 250 words):

STYLE RULE (kept experiment exp_1780033998_ezz4d): NO em-dashes or en-dashes anywhere in body text — use commas, parentheses, or short sentences instead. (The section-label pattern "*Label* — text" and meeting time separators are the only permitted dashes.)

*Morning Brief — [Month D, YYYY]*

*Today's Meetings*
- [H:MM AM — Name, Company] [1–2 sentence context + what to watch for]
- (skip this section if no external meetings)

*Pipeline Pulse* — [From STEP 1b RGOS data: stage advancements last 24h ($ value, stage, owner); stale-deal watch (stuck >14d); close-date watch (closing within 7d or past due, by company + amount + stage + owner). Include only lines with live data; if nothing fired, a single grounded line like "no stage advancements in 24h" is acceptable.]

*Product Ideas* — [One specific idea, grounded in a real signal, with source]

*Growth Angles* — [One GTM or positioning angle worth Greg's consideration]

*Delivery* — [Fathom meeting follow-ups if any. If STEP 1f project health flags fired: one line max, format "Project watch: [Name] ([reason])" for up to 2 projects. Omit if nothing fired. Specific client risk or opportunity only if real.]

STEP 2.5 — COMPETITOR LINK VALIDATION (fail-closed, mandatory before send):

Before sending, grep the entire brief text against these blocked domains: skaled.com, winningbydesign.com, gonimbly.com, revpartners.io, elefanterevops.com, cs2marketing.com, sixandflow.com, icebergrevops.com, domestiqueconsulting.com, carabinergroup.com, aptitude8.com, newbreedrevenue.com, saleshive.com, memoryblue.com, cience.com, cloudtask.com, callbox.com, operatix.net, martal.ca, belkins.io, leadium.com, revenue.io, gong.io, outreach.io, salesloft.com, 6sense.com, demandbase.com, chorus.ai, tractioncomplete.com. Also check reference_saleshive_competitors.md for any additions. If ANY blocked domain appears in the brief text (URLs, citations, or plain-text mentions), remove or replace the reference before proceeding. Do not send a brief containing competitor links.

STEP 3 — SEND via Slack DM using the Analyst bot identity:

cortextos bus send-slack $GREG_SLACK_USER_ID "<the brief text>"

The send-slack CLI uses the Analyst app's own bot token — the DM will appear from @Analyst in Greg's Slack. If GREG_SLACK_USER_ID is not set in env, fall back to Telegram: cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "<the brief text>"

STEP 4 — SAVE output file (required for watchdog + autoresearch scoring):

Write the brief text to: output/$(date +%Y-%m-%d)-morning-brief.md
Use the Write tool with the full brief text as content. Do not skip this step.

STEP 5 — PUBLISH to AgentOps Inbox (additive to Slack; do not skip):

git -C /home/cortextos/cortextos fetch fork main --quiet
git -C /home/cortextos/cortextos checkout refs/remotes/fork/main -- scripts/publish-briefing.js
git -C /home/cortextos/cortextos restore --staged scripts/publish-briefing.js
node /home/cortextos/cortextos/scripts/publish-briefing.js --type morning_brief --title "Morning Brief — $(date '+%b %-d, %Y')" --file output/$(date +%Y-%m-%d)-morning-brief.md --source-agent analyst

Confirm the script prints "published morning_brief ... id=". If it errors, still consider the Slack send complete; report the publish failure in your output file rather than retrying more than once.

After publishing, you are done. Stop.
