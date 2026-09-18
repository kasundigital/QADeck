<p align="center">
  <img src="public/brand/qadeck-logo.svg" alt="QADeck" width="480">
</p>

<p align="center"><strong>Self-hosted web QA automation for browser tests, visual regression, accessibility, scenarios, performance and reports.</strong></p>

# QADeck

QADeck is a self-hosted, Docker-first web QA platform powered by Playwright. It runs background browser/API tests, captures screenshots/video/traces, checks UI regressions, accessibility and performance, and keeps results in one dashboard.

## QADeck v0.6.1

### Software QA Agents
QADeck now includes a background GitHub-aware QA Agent beside the existing Playwright browser QA engine.

- Connect a GitHub repository to each QADeck project
- Public repository analysis without a token; private repository support with an encrypted GitHub token
- Background source review using the existing Docker worker
- Branch/commit analysis
- Pull-request-aware analysis using the PR head and changed files
- Static code-quality and security findings with file/line references
- Checks for likely exposed credentials, command/SQL injection paths, unsafe dynamic execution, wildcard CORS, tracked .env files and container hardening issues
- Automatic browser/API/security test suggestions based on detected application features
- Optional OpenAI-compatible developer summary using the existing AI settings
- Agent history and standalone reports
- JSON report endpoint for integrations
- Create a GitHub Issue directly from a completed Agent report
- CI/deployment trigger support using the existing private project trigger token

To queue a source review from CI/CD:

```json
{
  "agent": true,
  "ref": "main",
  "commit_sha": "GITHUB_SHA"
}
```

For a pull request, include its number:

```json
{
  "agent": true,
  "pr_number": 42,
  "commit_sha": "PR_HEAD_SHA"
}
```

The Agent never modifies source code automatically. Findings and suggested fixes remain reviewable, and GitHub Issue creation is an explicit action.

### Core QA
- Multi-project dashboard and persistent background queue
- Safe same-origin crawl mode
- HTTP 4xx/5xx, JavaScript, console, network and broken-image detection
- Responsive checks across desktop, laptop, tablet and mobile profiles
- Visual regression baselines with current/diff screenshots and baseline approval
- Axe accessibility checks
- Performance/Web Vitals-style metrics: TTFB, load, LCP and CLS with a per-project performance budget
- Full-page screenshots, Playwright traces and browser videos
- Professional compact A4 PDF/print report export from every run
- Scheduled recurring QA runs
- Automatic stale/interrupted run recovery

### PDF reports
Every run report includes an **Export PDF** action. The print-optimized A4 layout removes dashboard navigation and keeps the QA evidence compact while preserving the full report content:
- Project, run type, run status and timestamps
- Run totals and pass/issue counts
- AI summary when available
- Scenario step results including failed-step evidence
- Full issue list with severity, details, URLs and screenshots
- Page/device screenshots
- Accessibility, visual-regression and performance metrics
- Notification delivery history

In Chrome/Chromium, click **Export PDF** and choose **Save as PDF** in the print dialog. Long reports flow across additional A4 pages instead of truncating report data.

### Login and permissions
- Encrypted default project login
- Unlimited additional login fields such as company, branch, tenant or PIN
- Named test roles per project, e.g. Admin, Staff and Customer
- Each role can have its own login URL, credentials and extra login fields
- Scenarios can select a specific role or run without automatic login

### No-code scenarios
Supported steps:
- Visit URL
- Click
- Fill field
- Select option
- Check / uncheck
- Expect text
- Expect URL
- Wait
- Screenshot
- API GET
- API POST
- Expect API status
- Expect JSON value

Scenario steps can retry up to 3 times. A step that fails first and later passes is marked **flaky** in the report.

### Integrations
- Per-project secure HTTP trigger for CI/CD and deployment scripts
- Generic webhooks
- Discord webhooks
- Telegram notifications
- SMTP email notifications
- Optional OpenAI-compatible AI issue summaries
- Parallel worker scaling with Docker Compose

## Architecture

```text
Browser / CI / Scheduler
          |
          v
     QADeck Web
          |
          v
 SQLite queue/database
          |
     +----+----+
     |         |
 Worker 1   Worker N
     |         |
     +----+----+
          |
  Playwright / Axe / Visual diff
          |
 screenshots / video / traces / reports
```

## One-command Docker install

No Git clone and no Docker Compose are required for the normal single-server install.

```bash
docker run -d \
  --name qadeck \
  --restart unless-stopped \
  --init \
  --shm-size=1g \
  -p 3000:3000 \
  -v qadeck_data:/app/data \
  ghcr.io/kasundigital/qadeck:latest
```

Open:

```text
http://SERVER-IP:3000
```

On the first start, QADeck generates a secure admin password and encryption/session secrets and stores them in the persistent `qadeck_data` volume. Get the initial login details with:

```bash
docker logs qadeck
```

You will see:

```text
Login email: admin@qadeck.local
Login password: <generated-password>
```

The container runs both the **QADeck web UI and background QA worker**, so tests continue after you close the browser.

### Use your own admin login

You can provide your own login during the first install:

```bash
docker run -d \
  --name qadeck \
  --restart unless-stopped \
  --init \
  --shm-size=1g \
  -p 3000:3000 \
  -e QADECK_ADMIN_EMAIL=admin@example.com \
  -e QADECK_ADMIN_PASSWORD='CHANGE-THIS-STRONG-PASSWORD' \
  -v qadeck_data:/app/data \
  ghcr.io/kasundigital/qadeck:latest
```

QADeck automatically generates and persists `SESSION_SECRET` and `CREDENTIALS_KEY` when they are not supplied.

### Update the Docker install

Pull the new image and recreate the container. The named volume keeps projects, settings, credentials, reports and screenshots.

```bash
docker pull ghcr.io/kasundigital/qadeck:latest
docker rm -f qadeck

docker run -d \
  --name qadeck \
  --restart unless-stopped \
  --init \
  --shm-size=1g \
  -p 3000:3000 \
  -v qadeck_data:/app/data \
  ghcr.io/kasundigital/qadeck:latest
```

Check status and logs:

```bash
docker ps --filter name=qadeck
docker logs -f qadeck
```

### Docker Compose / multiple workers

For larger installations that need separate web/worker containers or multiple parallel workers:

```bash
git clone https://github.com/kasundigital/QADeck.git
cd QADeck
cp .env.example .env
nano .env
docker compose up -d --build
```

## Parallel workers

The worker service no longer has a fixed container name, so you can scale browser testing:

```bash
docker compose up -d --scale qadeck-worker=3
```

Start conservatively because each Playwright browser worker uses CPU and RAM.

## CI / deployment trigger

Each project page shows a private trigger path:

```text
POST /hooks/projects/PROJECT_ID/run/TRIGGER_TOKEN
```

A normal POST queues a full crawl. To run a saved scenario, send JSON:

```json
{"scenario_id": 123}
```

Regenerate the token from the project page if it is exposed.

## Optional notifications

Project settings support webhook/Discord URL, Telegram chat ID and notification email.

Telegram requires:

```env
TELEGRAM_BOT_TOKEN=
```

Email requires SMTP settings:

```env
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
```

## Optional AI summaries

QADeck can use an OpenAI-compatible chat-completions endpoint after a run:

```env
AI_BASE_URL=
AI_API_KEY=
AI_MODEL=
```

If these are blank, AI summaries are simply disabled and the rest of QADeck works normally.

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3000` | Web dashboard port |
| `MAX_PAGES_PER_RUN` | `20` | Pages per selected viewport |
| `PAGE_TIMEOUT_MS` | `20000` | Browser / scenario timeout |
| `WORKER_POLL_MS` | `1500` | Queue poll interval |
| `WORKER_STALE_MINUTES` | `2` | Interrupted-run recovery threshold |
| `SCHEDULE_CHECK_MS` | `30000` | Scheduled-run check frequency |
| `VISUAL_DIFF_THRESHOLD_PCT` | `0.25` | Visual difference threshold |

## Brand assets

QADeck vector assets used by the application are stored under `public/brand/`:

- `qadeck-logo.svg` — standard wordmark for light backgrounds
- `qadeck-logo-light.svg` — wordmark for dark backgrounds
- `qadeck-icon.svg` — app icon / favicon

## Safety

Automatic crawl mode is intentionally read-only and avoids destructive-looking links. Explicit scenarios can click buttons, submit forms and call APIs, so use staging environments or dedicated QA accounts when scenarios can modify data.

## License

No license has been selected yet.

---

## ☕ Support this project

This project is free and open source. If it helps you, you can support continued development:

<div align="center">
  <a href="https://buymeacoffee.com/kasundigital" target="_blank">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" height="50">
  </a>
</div>
