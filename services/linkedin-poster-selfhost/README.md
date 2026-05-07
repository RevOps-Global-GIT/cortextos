# linkedin-poster-selfhost

Self-hosted LinkedIn engagement service running on the Linux server. Uses Playwright persistent browser contexts (one per LinkedIn user) — no external browser-as-a-service needed.

## Architecture

- **HTTP server** (default port 3100) exposes 4 action endpoints + `/health`
- **BrowserManager** owns a single `chromium.launchPersistentContext` per process instance
- **inFlight guard** prevents concurrent LinkedIn actions; 30 s minimum gap between actions
- **Heartbeat loop** (60 s) POSTs browser health + status to `poster_heartbeats` Supabase table

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SUPABASE_URL` | yes | — | Supabase project URL |
| `SUPABASE_KEY` | yes | — | Supabase service-role key |
| `PROFILE_DIR` | no | `/var/lib/linkedin-poster/profiles/default` | Chromium profile directory |
| `USER_ID` | no | `default` | Logical user identifier (used in heartbeat agent_name) |
| `SENDER_NAME` | no | `LinkedIn Poster` | Display name for logs |
| `SENDER_LINKEDIN_ID` | no | `` | LinkedIn member ID (for reference) |
| `PORT` | no | `3100` | HTTP listen port |

## Running

```bash
npm install
npm run build

# Per-user instance
SUPABASE_URL=... SUPABASE_KEY=... \
PROFILE_DIR=/var/lib/linkedin-poster/profiles/greg \
USER_ID=greg \
SENDER_NAME="Greg Harned" \
npm start
```

## Seeding a Login Profile (P2)

The profile directory must contain a valid LinkedIn session. Until the Mac-side login CLI is built (P2), seed manually:

```bash
# On Greg's Mac — launch Chrome with the target profile dir, log in to LinkedIn, then rsync
rsync -av ~/Library/Application\ Support/Google/Chrome/Default/ \
  cortextos-server:/var/lib/linkedin-poster/profiles/greg/
```

## Endpoints

### GET /health
Returns `{ ok: boolean, userId: string }`. HTTP 200 if session is valid, 503 if not.

### POST /comment
```json
{ "postUrl": "https://www.linkedin.com/feed/update/...", "commentText": "Great post!" }
```

### POST /connect
```json
{ "profileUrl": "https://www.linkedin.com/in/someone/", "noteText": "Optional note" }
```

### POST /dm
```json
{ "profileUrl": "https://www.linkedin.com/in/someone/", "messageText": "Hey!" }
```

### POST /post
```json
{ "postText": "My update...", "imagePaths": ["/tmp/img1.jpg"] }
```
`imagePaths` is optional.

## Roadmap

- **P1 (done)**: Scaffold + Playwright actions (postComment, connect, DM, publishPost)
- **P2**: Mac-side login CLI — launch persistent context on Mac, rsync profile to server
- **P3**: Daemon/queue consumer integration, per-user process management, RGOS task routing
