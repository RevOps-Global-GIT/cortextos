# Supreme Mentions Triage Capture Contract - 2026-05-22

Leg A should save the raw Slackbot skill output here:

`/home/cortextos/cortextos/orgs/revops-global/agents/analyst/output/supreme-mentions-triage-latest.txt`

Leg B parser command:

```bash
python3 /home/cortextos/cortextos/orgs/revops-global/agents/analyst/scripts/supreme-mentions-triage-ingest.py \
  --input /home/cortextos/cortextos/orgs/revops-global/agents/analyst/output/supreme-mentions-triage-latest.txt \
  --quiet
```

If Leg A has a stronger proof artifact or capture timestamp than the text file mtime, pass them explicitly:

```bash
python3 /home/cortextos/cortextos/orgs/revops-global/agents/analyst/scripts/supreme-mentions-triage-ingest.py \
  --input /home/cortextos/cortextos/orgs/revops-global/agents/analyst/output/supreme-mentions-triage-latest.txt \
  --capture-timestamp 2026-05-22T08:20:00Z \
  --raw-proof-path /path/to/cu-proof.md \
  --quiet
```

Accepted formats:

## JSON

```json
{
  "generated_at": "2026-05-22T08:20:00Z",
  "skill": "Mentions Triage -- What Needs a Reply",
  "items": [
    {
      "source": "action_item",
      "channel_name": "#catalent",
      "sender_name": "Braydon Armula",
      "message_preview": "Could everyone please follow up...",
      "slack_url": "https://supremeopti.slack.com/archives/C07MNTLMENS/p1779375833448479",
      "message_ts": "1779375833.448479",
      "age_seconds": 18000,
      "is_question": true
    }
  ]
}
```

## Markdown/Text

```text
1. [action item in #catalent, 5h ago] Could everyone please follow up...
2. [@-mention in #mpdm-danielle--greg, 1d ago] hi @Greg are you able to join?
- [thread mention in #sampled, 2h ago] Please review the thread. https://supremeopti.slack.com/archives/...
```

Rules:

- Do not write fallback scanner output to this file.
- Do not write PivotPulse or unrelated bot-DM output.
- The file must be freshly captured by Computer Use/Slackbot before each import.
- The importer fails closed when this file is missing or older than 30 minutes.
- Rows are written to `supreme_outstanding_items` with `raw_json.pipe_source = "mentions_triage_skill"` and `scanned_at` equal to the CU capture timestamp. By default that timestamp is the input file mtime.
- The latest/last-sync JSON includes `cu_capture_at`, `raw_proof_path`, and `input_path` so freshness/debugging can prove the import came from the CU capture.
