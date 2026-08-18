# QADeck automatic deployment

QADeck can automatically deploy the `main` branch to the Docker server after CI passes.

## How it works

```text
Push to main
   -> GitHub Actions validation
   -> SSH to production server
   -> git fetch/reset to origin/main
   -> docker compose up -d --build
   -> /health check
   -> verify qadeck-worker is running
   -> success
```

If the new deployment fails its health checks, the workflow attempts to reset the server checkout to the previous Git commit and rebuild it.

The production checkout is expected at:

```text
/opt/QADeck
```

## 1. Create a dedicated deployment SSH key

Run this on the QADeck server while logged in as the Linux user GitHub Actions should use for deployment:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keygen -t ed25519 -C "qadeck-github-actions" -f ~/.ssh/qadeck_github_actions -N ""
cat ~/.ssh/qadeck_github_actions.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Show the private key and copy the complete output, including the BEGIN/END lines:

```bash
cat ~/.ssh/qadeck_github_actions
```

After the GitHub secret is configured and tested, the local private-key file may be removed from the server. The public key entry must remain in `~/.ssh/authorized_keys`.

The deployment user must be able to run Docker without an interactive sudo password. Verify:

```bash
docker compose version
cd /opt/QADeck
docker compose ps
```

## 2. Record the server SSH host key

From a trusted computer, replace the host/port and run:

```bash
ssh-keyscan -H -p 22 YOUR_SERVER_IP
```

Copy the complete output. QADeck uses strict SSH host-key checking during deployment.

## 3. Add GitHub Actions secrets

In the QADeck GitHub repository open:

**Settings -> Secrets and variables -> Actions -> Secrets -> New repository secret**

Add:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | Server IP or hostname |
| `DEPLOY_USER` | Linux SSH user, for example `root` |
| `DEPLOY_PORT` | SSH port, for example `22` or a custom port |
| `DEPLOY_SSH_KEY` | Complete private key from step 1 |
| `DEPLOY_KNOWN_HOSTS` | Complete `ssh-keyscan` output from step 2 |

## 4. Enable automatic deployment

In the same repository open:

**Settings -> Secrets and variables -> Actions -> Variables -> New repository variable**

Create:

```text
Name: AUTO_DEPLOY_ENABLED
Value: true
```

Deployment remains skipped until this variable is exactly `true`.

## 5. First test

Open **Actions -> QADeck CI & Deploy -> Run workflow** and run it on `main`, or push a commit to `main`.

A successful workflow has two jobs:

```text
validate  -> passed
deploy    -> passed
```

The deploy job verifies both the QADeck web health endpoint and that `qadeck-worker` is running.

## Normal workflow afterwards

No manual server deployment is required:

```text
Code pushed to main
        -> CI passes
        -> production Docker server updates automatically
```

The `.env` file and the `qadeck_data` Docker volume are not replaced by `git reset --hard`, because `.env` is ignored by Git and application data is stored in the Docker volume.
