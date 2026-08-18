# QADeck

QADeck is a self-hosted, Docker-first web QA console. Add a web project, optionally provide a test login, run a safe browser crawl, and review detected issues with screenshots from one dashboard.

## Current MVP

- Multi-project dashboard
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

> **Safety:** The MVP is intentionally read-only after login. It follows normal GET links but does not submit discovered forms or click arbitrary buttons. Project-specific workflow/scenario testing will be added as a separate controlled feature.

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

Open:

```text
http://SERVER-IP:3000
```

Health check:

```text
http://SERVER-IP:3000/health
```

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3000` | QADeck HTTP port inside the container |
| `QADECK_ADMIN_EMAIL` | `admin@example.com` | Dashboard login email |
| `QADECK_ADMIN_PASSWORD` | `change-this-password` | Dashboard login password |
| `SESSION_SECRET` | development fallback | Session signing secret |
| `CREDENTIALS_KEY` | development fallback | Encrypts stored target-site passwords |
| `MAX_PAGES_PER_RUN` | `20` | Maximum pages crawled per QA run |
| `PAGE_TIMEOUT_MS` | `20000` | Browser timeout per page |

## Planned next phases

1. Visual scenario builder: navigate, click, fill, select, upload and assert.
2. Recorder that converts a human browser session into a reusable scenario.
3. Multiple test roles per project (admin/staff/customer).
4. Mobile/tablet/desktop viewport profiles.
5. Video and Playwright trace capture on failure.
6. Scheduled runs and notifications.
7. Worker queue for parallel projects.
8. GitHub/deployment-triggered regression runs.
9. AI exploratory testing as an optional layer on top of deterministic tests.

## License

No license has been selected yet.
