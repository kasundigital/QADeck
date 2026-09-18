<p align="center">
  <img src="public/brand/qadeck-logo.svg" alt="QADeck" width="480">
</p>

<p align="center">
  <strong>Self-hosted web QA automation for browser testing, visual regression, accessibility, scenarios, performance, source review and professional reports.</strong>
</p>

<p align="center">
  Docker-first · Playwright-powered · Background testing · Self-hosted
</p>

# QADeck

QADeck is a self-hosted quality-assurance platform for web applications. Add a project, provide an optional test login, and QADeck can authenticate, crawl the application in a real Chromium browser, test multiple screen sizes, capture evidence, detect problems and keep the results in one dashboard.

QADeck also includes a GitHub-aware QA Agent for source-code review, reusable no-code scenarios for functional testing, scheduled checks, notifications and compact A4 PDF reports.

**Current version: v0.6.1**

---

## Quick start — one Docker command

For a normal installation you do **not** need Git, Docker Compose or a local build.

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
http://YOUR-SERVER-IP:3000
```

QADeck runs both the **web application** and the **background QA worker** inside this all-in-one container. Tests continue running even when you close the browser.

### First login

On the first start, QADeck automatically creates:

- an admin login
- a secure random admin password
- the session signing secret
- the credential-encryption key

These values are stored in the persistent `qadeck_data` volume.

View the initial login details:

```bash
docker logs qadeck
```

Example:

```text
============================================================
 QADeck all-in-one container
 Web UI + background QA worker
============================================================
 Login email: admin@qadeck.local
 Login password: generated-secure-password
 Open: http://YOUR-SERVER-IP:3000
============================================================
```

The generated password is shown during initial setup. Save it somewhere secure.

### Use your own admin login

You can set the login yourself:

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

QADeck will still generate and persist `SESSION_SECRET` and `CREDENTIALS_KEY` automatically if you do not supply them.

### Use a different host port

For example, to expose QADeck on port `8085`:

```bash
-p 8085:3000
```

Then open:

```text
http://YOUR-SERVER-IP:8085
```

---

## Updating QADeck

Your data is stored in the named Docker volume, so recreating the container does not remove projects, reports, screenshots or stored credentials.

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

Check status:

```bash
docker ps --filter name=qadeck
```

View logs:

```bash
docker logs -f qadeck
```

---

## What QADeck can test

### Authenticated website crawling

A project can contain:

- Base URL
- Login URL
- Username/email
- Password
- Additional login fields

Additional login fields can be used for items such as:

- company code
- branch
- tenant
- organization
- domain
- PIN
- dropdown selections

QADeck attempts the login first, keeps the authenticated browser session, then crawls same-origin pages using that session.

The automatic crawler is intentionally conservative. It avoids links that look destructive, such as logout, delete, remove, destroy, purge and similar actions.

### Browser QA

QADeck can detect and record:

- HTTP 4xx and 5xx responses
- failed page navigation
- browser console errors
- uncaught JavaScript errors
- failed network requests
- broken images
- horizontal overflow / responsive layout issues
- page screenshots
- page load timings
- performance-budget problems

### Responsive testing

Configure any combination of:

- Desktop — 1440 × 900
- Laptop — 1366 × 768
- Tablet — 768 × 1024
- Mobile — 390 × 844
- Small mobile — 360 × 800

The configured crawl can be repeated for each selected viewport.

### Visual regression

QADeck can maintain visual baselines and compare later runs against them.

Reports can include:

- baseline screenshot
- current screenshot
- difference image
- changed-pixel percentage
- visual regression finding
- approve-current-as-new-baseline action

### Accessibility

QADeck uses Axe in the browser to detect accessibility issues and records affected elements and severity in the QA report.

### Performance

Per-project performance checks can capture metrics such as:

- TTFB
- page load timing
- LCP
- CLS
- performance score
- configurable performance budget

### Evidence and debugging

Runs can preserve:

- full-page screenshots
- failure screenshots
- Playwright traces
- browser video
- issue details
- run history

---

## No-code scenario testing

The normal crawler is read-only. Use **Scenarios** when you want QADeck to interact with the application and test real workflows.

Available scenario actions include:

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

Example workflow:

```text
Login
  ↓
Open Customers
  ↓
Click Add Customer
  ↓
Fill Name
  ↓
Fill Mobile
  ↓
Save
  ↓
Expect "Customer created"
  ↓
Capture screenshot
```

Scenario steps can retry up to three times. A step that initially fails and later succeeds is shown as **flaky**.

Use dedicated staging/test accounts for scenarios that create, edit or delete data.

---

## Roles and permissions testing

A project can contain multiple named test roles, for example:

- Admin
- Staff
- Technician
- Customer

Each role can have its own:

- login URL
- username
- encrypted password
- additional login fields

Scenarios can run using a selected role or without automatic login.

---

## Background and scheduled QA

QA jobs are stored in a persistent queue and processed by the background worker.

That means you can:

1. start a QA run
2. close QADeck
3. return later
4. see the completed report

QADeck also supports scheduled recurring crawls such as:

- every 15 minutes
- every 30 minutes
- hourly
- every 6 hours
- every 12 hours
- daily
- weekly

Interrupted/stale jobs can be recovered and re-queued.

---

## Software QA Agent

QADeck includes a GitHub-aware background QA Agent in addition to browser testing.

It can:

- connect a GitHub repository to a QADeck project
- inspect public repositories
- inspect private repositories when a GitHub token is configured
- analyze branches and commits
- analyze pull requests and changed files
- report code-quality findings
- report security-related findings
- identify likely exposed credentials
- flag risky dynamic execution
- flag potential SQL/command-injection paths
- flag wildcard CORS
- flag tracked `.env` files
- flag container-hardening concerns
- suggest browser/API/security tests
- generate an optional AI-assisted developer summary
- create a GitHub Issue from a completed QA Agent report

The QA Agent does **not** automatically modify source code.

### Trigger an Agent run from CI/CD

```json
{
  "agent": true,
  "ref": "main",
  "commit_sha": "GITHUB_SHA"
}
```

For a pull request:

```json
{
  "agent": true,
  "pr_number": 42,
  "commit_sha": "PR_HEAD_SHA"
}
```

---

## PDF reports

Every completed QA run includes an **Export PDF** action.

The print-optimized A4 report can include:

- project and run information
- status and timestamps
- issue/pass totals
- AI summary
- scenario step results
- failed-step evidence
- issue severity/category/device
- URLs and technical details
- page screenshots
- accessibility results
- visual regression percentages
- performance metrics
- notification history

Long reports continue across additional A4 pages instead of cutting off the report.

In Chrome/Chromium:

```text
View Report → Export PDF → Save as PDF
```

---

## Notifications and integrations

QADeck supports:

- generic HTTP webhooks
- Discord webhooks
- Telegram notifications
- SMTP email notifications
- secure per-project CI/CD trigger URLs
- optional OpenAI-compatible AI summaries

### Telegram

```env
TELEGRAM_BOT_TOKEN=
```

### SMTP email

```env
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
```

### Optional AI summary

```env
AI_BASE_URL=
AI_API_KEY=
AI_MODEL=
```

If AI settings are blank, QADeck continues to work normally without AI summaries.

---

## CI/CD trigger

Each project can expose a private trigger endpoint:

```text
POST /hooks/projects/PROJECT_ID/run/TRIGGER_TOKEN
```

A normal POST queues a full browser crawl.

To run a saved scenario:

```json
{
  "scenario_id": 123
}
```

Regenerate the project trigger token if it is ever exposed.

---

## Docker architecture

### Recommended: all-in-one container

The published image runs:

```text
┌──────────────────────────────┐
│       QADeck container       │
│                              │
│  Web UI/API                  │
│       │                      │
│       ├── SQLite/database    │
│       │                      │
│  Background worker           │
│       │                      │
│       ├── Playwright         │
│       ├── Axe                │
│       ├── Visual diff        │
│       └── QA Agent           │
└──────────────────────────────┘
             │
             ▼
       qadeck_data volume
```

This is the simplest installation and is recommended for most users.

### Advanced: Docker Compose

For larger installations you can run separate web and worker containers:

```bash
git clone https://github.com/kasundigital/QADeck.git
cd QADeck
cp .env.example .env
nano .env
docker compose up -d --build
```

The Compose deployment uses the same persistent QADeck data volume.

### Multiple parallel workers

For larger environments:

```bash
docker compose up -d --scale qadeck-worker=3
```

Each browser worker uses CPU and RAM, so increase worker count gradually.

---

## Build the image locally

If you prefer not to use GHCR:

```bash
git clone https://github.com/kasundigital/QADeck.git
cd QADeck
docker build -t qadeck:local .
docker run -d \
  --name qadeck \
  --restart unless-stopped \
  --init \
  --shm-size=1g \
  -p 3000:3000 \
  -v qadeck_data:/app/data \
  qadeck:local
```

---

## Important environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | QADeck HTTP port inside the container |
| `QADECK_ADMIN_EMAIL` | `admin@qadeck.local` in all-in-one first setup | Dashboard administrator |
| `QADECK_ADMIN_PASSWORD` | generated on first all-in-one start | Dashboard password |
| `SESSION_SECRET` | generated on first all-in-one start | Session signing secret |
| `CREDENTIALS_KEY` | generated on first all-in-one start | Encrypts stored target credentials |
| `MAX_PAGES_PER_RUN` | `20` | Maximum pages per viewport |
| `PAGE_TIMEOUT_MS` | `20000` | Browser/scenario timeout |
| `WORKER_POLL_MS` | `1500` | Background queue polling interval |
| `WORKER_STALE_MINUTES` | `2` | Interrupted-run recovery threshold |
| `SCHEDULE_CHECK_MS` | `30000` | Scheduled-run check frequency |
| `VISUAL_DIFF_THRESHOLD_PCT` | `0.25` | Visual difference threshold |
| `QADECK_GITHUB_TOKEN` | blank | Optional token for private repos / higher GitHub API limits |
| `AGENT_MAX_FILES` | `80` | QA Agent file-analysis limit |
| `AGENT_MAX_SOURCE_BYTES` | `1800000` | QA Agent source-size limit |

See `.env.example` for the full optional configuration.

---

## Data and security

QADeck stores its runtime data under:

```text
/app/data
```

The recommended Docker command maps this to:

```text
qadeck_data
```

The volume contains the database, QA evidence, screenshots, visual baselines and persistent all-in-one runtime configuration.

Target-site passwords and additional login values are encrypted before they are stored.

For destructive functional tests, always prefer:

- a staging environment
- dedicated QA users
- disposable test records

The generic crawler is intentionally designed to avoid destructive-looking URLs.

---

## Automatic Docker image publishing

The repository's GitHub Actions workflow validates QADeck and publishes successful `main` builds to:

```text
ghcr.io/kasundigital/qadeck:latest
ghcr.io/kasundigital/qadeck:main
ghcr.io/kasundigital/qadeck:sha-COMMIT_SHA
```

Validation includes:

- JavaScript syntax checks
- EJS template compilation
- database migration smoke test
- web health smoke test
- all-in-one runtime smoke test

### Maintainer: first GHCR setup

GitHub may create a new container package as private on its first publish.

To make the public install command work anonymously, set the package to **Public** once:

```text
GitHub Profile
→ Packages
→ qadeck
→ Package settings
→ Change visibility
→ Public
```

---

## Brand assets

QADeck brand assets are stored in:

```text
public/brand/
```

Included:

- `qadeck-logo.svg` — standard logo for light backgrounds
- `qadeck-logo-light.svg` — logo for dark backgrounds
- `qadeck-icon.svg` — application icon / favicon

---

## Troubleshooting

### Container status

```bash
docker ps -a --filter name=qadeck
```

### Logs

```bash
docker logs --tail=200 qadeck
```

### Follow logs live

```bash
docker logs -f qadeck
```

### Health endpoint

```bash
curl http://127.0.0.1:3000/health
```

### Reset everything

> This permanently deletes QADeck data.

```bash
docker rm -f qadeck
docker volume rm qadeck_data
```

Then run the installation command again.

---

## Support

QADeck is free and open source.

If QADeck helps you, you can support continued development:

<p align="center">
  <a href="https://buymeacoffee.com/kasundigital">
    <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" height="50">
  </a>
</p>

---

## License

No license has been selected yet.
