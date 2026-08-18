# QADeck

QADeck is a self-hosted, Docker-first web QA console. Add a web project, optionally provide a test login, start a QA run, and review detected issues with screenshots from one dashboard.

## Current MVP

- Multi-project dashboard
- Persistent background test queue
- Dedicated Playwright worker container
- Tests continue when the QADeck browser tab is closed
- Live run progress while the report page is open
- Optional encrypted per-project login credentials
- Real Chromium testing with Playwright
- Same-origin safe crawler
- Avoids links with destructive-looking paths (delete, remove, logout, destroy, etc.)
- HTTP 4xx/5xx detection
- Browser console error detection
- Uncaught JavaScript error detection
- Failed network request detection
- Broken image detection
- Horizontal overflow detection
- Full-page screenshot for every visited page
- Run history and issue reports
- Protected QADeck admin login
- Persistent SQLite database and screenshot storage in a Docker volume
- Interrupted/stale worker jobs are automatically re-queued after recovery

> **Safety:** The MVP is intentionally read-only after login. It follows normal GET links but does not submit discovered forms or click arbitrary buttons. Project-specific workflow/scenario testing will be added as a separate controlled feature.

## Architecture

```text
Browser
   |
   v
QADeck Web  ----> SQLite queue/database <---- QADeck Worker
   |                                         |
   |                                         v
   |                                   Playwright Chromium
   |                                         |
   +---------- screenshots/results <---------+
```

Clicking **Run QA in background** only creates a queued database job. The `qadeck-worker` container picks it up and runs the browser test independently of the web interface. You can close QADeck and return later. While a run report is open it refreshes automatically to show new pages, issues and screenshots.

## Docker quick start

```bash
git clone https://github.com/kasundigital/QADeck.git
cd QADeck
cp .env.example .env
```

Edit `.env` and set strong values:

```env
QADECK_ADMIN_EMAIL=admin@example.com
QADECK_ADMIN_PASSWORD=use-a-strong-password
SESSION_SECRET=use-a-long-random-secret
CREDENTIALS_KEY=use-a-different-long-random-secret
```

Start QADeck:

```bash
docker compose up -d --build
```

You should see two services:

```bash
docker compose ps
```

- `qadeck` — web dashboard/API
- `qadeck-worker` — persistent background Playwright worker

Open:

```text
http://SERVER-IP:3000
```

Health check:

```text
http://SERVER-IP:3000/health
```

Follow logs:

```bash
docker compose logs -f qadeck
docker compose logs -f qadeck-worker
```

## Updating an existing installation

```bash
cd QADeck
git pull
docker compose up -d --build
```

The existing `qadeck_data` Docker volume is preserved. QADeck automatically adds the new queue/progress database fields when it starts.

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3000` | QADeck HTTP port inside the web container |
| `QADECK_ADMIN_EMAIL` | `admin@example.com` | Dashboard login email |
| `QADECK_ADMIN_PASSWORD` | `change-this-password` | Dashboard login password |
| `SESSION_SECRET` | development fallback | Session signing secret |
| `CREDENTIALS_KEY` | development fallback | Encrypts stored target-site passwords |
| `MAX_PAGES_PER_RUN` | `20` | Maximum pages crawled per QA run |
| `PAGE_TIMEOUT_MS` | `20000` | Browser timeout per page |
| `WORKER_POLL_MS` | `1500` | How often the background worker checks the queue |
| `WORKER_STALE_MINUTES` | `2` | Age after which an interrupted running job can be recovered |

## Planned next phases

1. Visual scenario builder: navigate, click, fill, select, upload and assert.
2. Recorder that converts a human browser session into a reusable scenario.
3. Multiple test roles per project (admin/staff/customer).
4. Mobile/tablet/desktop viewport profiles.
5. Video and Playwright trace capture on failure.
6. Scheduled runs and notifications.
7. Multiple parallel workers and concurrency controls.
8. GitHub/deployment-triggered regression runs.
9. AI exploratory testing as an optional layer on top of deterministic tests.

## License

No license has been selected yet.
