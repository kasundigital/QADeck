# QADeck

QADeck is a self-hosted, Docker-first web QA platform. Add projects, configure test logins, run background crawls or no-code browser scenarios, and review functional, visual, responsive and accessibility issues with screenshots, video and Playwright traces.

## QADeck v0.4

### Projects and execution

- Multi-project dashboard
- Persistent background test queue
- Dedicated Playwright worker container
- Tests continue when the QADeck browser tab is closed
- Live progress while a report is open
- Automatic recovery/re-queue of interrupted worker jobs
- Persistent SQLite data and QA artifacts in a Docker volume
- Optional recurring QA crawls per project

### Login testing

- Encrypted username/password storage
- Unlimited additional login fields per project
- Extra fields can represent company code, branch, tenant, domain, PIN, organization and similar inputs
- Additional fields support text/password/dropdown mode
- Optional CSS selector for unusual login forms
- Automatic matching by label/name/placeholder when a selector is not supplied

### Browser and functional QA

- Real headless Chromium using Playwright
- Same-origin safe crawler
- Read-only crawl mode avoids destructive-looking links
- HTTP 4xx/5xx detection
- Browser console error detection
- Uncaught JavaScript error detection
- Failed network request detection
- Broken image detection
- Horizontal overflow/responsive issue detection
- Full-page screenshots

### Responsive QA

Per project, select any combination of:

- Desktop — 1440 × 900
- Laptop — 1366 × 768
- Tablet — 768 × 1024
- Mobile — 390 × 844
- Small mobile — 360 × 800

QADeck repeats the configured crawl against each selected viewport.

### Visual regression

- First successful screenshot becomes the visual baseline
- Future runs compare current screenshots against the baseline
- Pixel-change percentage
- Baseline / Current / Diff links
- Visual-regression issues when the configured threshold is exceeded
- Approve the current screenshot as the new baseline from the report

### Accessibility

QADeck uses Axe in the browser to detect accessibility violations and records them as QA issues with affected selectors and severity.

### Debugging evidence

- Browser video recording
- Playwright trace recording
- Screenshots on crawled pages
- Screenshots on failed scenario steps
- Persistent run history

### No-code scenarios

Each project can contain reusable functional workflows. Supported steps currently include:

- Visit URL
- Click
- Fill field
- Select option
- Check checkbox
- Uncheck checkbox
- Expect text
- Expect URL
- Wait
- Screenshot

Scenario jobs run through the same background worker and report Pass / Fail / Skipped step results per configured viewport.

### Scheduled QA

A project can automatically queue a full QA crawl every:

- 15 minutes
- 30 minutes
- 1 hour
- 6 hours
- 12 hours
- 24 hours
- 7 days

The scheduler lives in the background worker, so QADeck does not need to be open in a browser. A scheduled crawl is not queued while another run for the same project is already queued or running.

> **Safety model:** automatic crawl jobs remain intentionally read-only. Scenario jobs may click buttons and submit forms because those actions are explicitly configured by the QADeck user. Use staging/test accounts for scenarios that create, edit or delete data.

## Architecture

```text
Browser
   |
   v
QADeck Web  ----> SQLite queue/database <---- QADeck Worker
   |                                         |
   |                                         +--> Scheduler
   |                                         +--> Safe crawler
   |                                         +--> Scenario runner
   |                                         +--> Visual regression
   |                                         +--> Axe accessibility
   |                                         +--> Trace / video
   |
   +------------ reports/artifacts <---------+
```

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

Check services:

```bash
docker compose ps
```

- `qadeck` — web dashboard/API
- `qadeck-worker` — persistent background Playwright worker and scheduler

Open:

```text
http://SERVER-IP:3000
```

Logs:

```bash
docker compose logs -f qadeck
docker compose logs -f qadeck-worker
```

## Updating an existing installation

```bash
cd /opt/QADeck
git pull
docker compose up -d --build
```

The existing `qadeck_data` volume is preserved. QADeck applies additive SQLite migrations on startup, so existing projects and run history are retained.

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3000` | QADeck HTTP port |
| `QADECK_ADMIN_EMAIL` | `admin@example.com` | Dashboard login email |
| `QADECK_ADMIN_PASSWORD` | `change-this-password` | Dashboard login password |
| `SESSION_SECRET` | development fallback | Session signing secret |
| `CREDENTIALS_KEY` | development fallback | Encrypts target-site login data |
| `MAX_PAGES_PER_RUN` | `20` | Maximum pages crawled per selected viewport |
| `PAGE_TIMEOUT_MS` | `20000` | Browser/step timeout |
| `WORKER_POLL_MS` | `1500` | Worker queue polling interval |
| `WORKER_STALE_MINUTES` | `2` | Stale-run recovery threshold |
| `SCHEDULE_CHECK_MS` | `30000` | How often the worker checks for due scheduled crawls |
| `VISUAL_DIFF_THRESHOLD_PCT` | `0.25` | Percentage of changed pixels before a visual issue is reported |

## CI validation

The repository includes a GitHub Actions workflow that installs dependencies, performs Node syntax checks and runs a SQLite migration smoke test on pushes and pull requests to `main`.

## Next useful expansions

- Browser interaction recorder that converts manual actions into scenarios
- Multiple named test roles per project (admin/staff/customer)
- Notification channels for failed/successful scheduled runs
- API request/assertion steps
- Performance and Web Vitals budgets
- GitHub/deployment-triggered regression runs
- Parallel worker concurrency controls
- Flaky-test detection and retry policy
- AI-assisted exploratory testing and issue summaries

## License

No license has been selected yet.
