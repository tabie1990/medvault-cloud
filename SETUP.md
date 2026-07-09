# MedVAULT Cloud — Setup Guide (Hetzner CX23, zero to live in one pass)

Follow these steps in order. By the end, `https://api.yourdomain.com/health` returns
`{"ok":true}` and you have a repeatable deploy path for every future change.

---

## 1. Buy the server

1. Create a Hetzner Cloud account at hetzner.com (separate from Namecheap —
   Namecheap stays your domain registrar only).
2. **New Project** → **Add Server**.
3. Location: Falkenstein, Nuremberg, or Helsinki (cheapest EU tier).
4. Image: **Ubuntu 24.04 LTS**.
5. Type: **Shared vCPU → CX23** (2 vCPU / 4GB RAM / 40GB SSD, ~€7/month).
6. Add your SSH public key (`ssh-keygen -t ed25519` on your own machine first if
   you don't have one, then paste the `.pub` file contents).
7. Name it (e.g. `medvault-cloud-prod`), create, note the public IPv4 address.

## 2. Point your domain at it

In Namecheap's DNS settings for your domain (or a subdomain like
`api.yourdomain.com`): add an **A record**, host `api`, value = the server's
IPv4, TTL automatic. Wait for propagation (`dig api.yourdomain.com` should
return the Hetzner IP) before running Certbot in step 4.

## 3. Push this code to your own GitHub repo

```bash
cd medvault-cloud
git init
git add .
git commit -m "Initial MedVAULT Cloud"
git remote add origin git@github.com:YOUR_ORG/medvault-cloud.git
git push -u origin main
```

If the repo is **private**, the server needs its own way to clone it — see
the deploy key instructions in step 4 before running the script.

## 4. First login and run the setup script

```bash
ssh root@YOUR_SERVER_IP
```

On the server, if the repo is private, set up a deploy key first:

```bash
ssh-keygen -t ed25519 -f /root/.ssh/medvault_deploy -N ""
cat /root/.ssh/medvault_deploy.pub
```

Add that public key to your GitHub repo under **Settings → Deploy keys**
(read-only is enough), then:

```bash
echo -e "Host github.com\n  IdentityFile /root/.ssh/medvault_deploy" >> /root/.ssh/config
```

Now fetch and run the setup script (either `scp` it up, or paste it via
`nano setup-server.sh`):

```bash
chmod +x setup-server.sh
export DOMAIN="api.yourdomain.com"
export LETSENCRYPT_EMAIL="you@yourdomain.com"
export GIT_REPO_URL="git@github.com:YOUR_ORG/medvault-cloud.git"
./setup-server.sh
```

It prints a summary at the end with your generated database password, JWT
secret, and secret-encryption key — **save all three somewhere safe
immediately**, they're only shown once (though they're also already written
into `/opt/medvault-cloud/.env` on the server).

## 5. Verify it's live

```bash
curl https://api.yourdomain.com/health
# {"ok":true,"service":"medvault-cloud-api","node":"v22.x.x"}
```

Open `https://api.yourdomain.com/docs` for the Swagger UI.

At this point the core API is live: hospital registration/sync, appointments,
doctor accounts, patient OTP login, lab providers/orders, telemedicine
sessions. WhatsApp and push notifications work in a safe no-op/logging mode
until you complete steps 7-8 below.

## 6. Set up push-button deploys (GitHub Actions over SSH)

Add `.github/workflows/deploy-api.yml` to your repo:

```yaml
name: Deploy MedVAULT Cloud API
on:
  workflow_dispatch:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy over SSH
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: medvault
          key: ${{ secrets.DEPLOY_SSH_KEY }}
          script: |
            cd /opt/medvault-cloud
            git pull origin main
            npm install
            npx prisma generate
            npx prisma migrate deploy
            npm run build
            pm2 restart medvault-api
```

In GitHub, add under **Settings → Secrets and variables → Actions**:
- `SERVER_HOST` — your server's IP or domain
- `DEPLOY_SSH_KEY` — private key whose public half is in
  `/home/medvault/.ssh/authorized_keys` on the server

Push to `main`, or trigger manually from the Actions tab.

## 7. Set up backups (Backblaze B2)

1. Create a free Backblaze account, make a bucket (e.g. `medvault-backups`),
   generate an Application Key.
2. On the server: `apt-get install -y rclone`, then `rclone config` → new
   remote named `b2`, type `b2`, paste your Key ID and Key.
3. Test: `sudo /usr/local/bin/medvault-backup.sh` (installed by
   `setup-server.sh`, already scheduled nightly via cron). Confirm the dump
   lands in your B2 bucket.

## 8. Set up the WhatsApp Cloud API + AI agent

1. Create a Meta for Developers app at developers.facebook.com, add the
   **WhatsApp** product.
2. Under WhatsApp → Configuration: webhook callback URL =
   `https://api.yourdomain.com/api/v1/whatsapp/webhook`, verify token = a
   value you choose.
3. Subscribe to the `messages` webhook field.
4. Get an Anthropic API key at console.anthropic.com — this powers the agent
   itself (it uses Claude Haiku, the cheapest current model, and only calls
   your existing internal functions — it never gets its own database
   write path).
5. On the server, edit `/opt/medvault-cloud/.env`:
   ```
   WHATSAPP_VERIFY_TOKEN="the value you chose in step 2"
   WHATSAPP_ACCESS_TOKEN="from the Meta app dashboard"
   WHATSAPP_PHONE_NUMBER_ID="from the Meta app dashboard"
   ANTHROPIC_API_KEY="from console.anthropic.com"
   ```
   Then: `pm2 restart medvault-api`.
6. Send a test WhatsApp message to your business number; check
   `pm2 logs medvault-api` to confirm it reached the webhook and the agent
   replied.

**Cost note:** WhatsApp conversations and Claude tokens are both usage-based
and billed separately from your €7/month server — budget for them once you
know real volume, but neither requires new infrastructure.

## 9. Set up telemedicine (Daily.co)

1. Create a free Daily.co account (same provider your offline HMS already
   uses) — free up to 10,000 minutes/month.
2. Get an API key from the Daily dashboard.
3. Add to `.env`: `DAILY_API_KEY="..."` and `DAILY_SUBDOMAIN="yoursubdomain"`,
   then `pm2 restart medvault-api`.
4. Without a key set, `POST /api/v1/telemedicine/sessions` still works and
   returns a clearly-labeled mock room URL — useful for testing the rest of
   the flow before you've set this up.

## 10. Set up push notifications (Expo)

No account strictly required for a basic send — Expo's push service works
without a token for MVP volume. In each mobile app:
```bash
expo install expo-notifications
```
Each app registers its push token on first launch via
`POST /api/v1/notifications/register-device`.

## 11. Go-live checklist

- [ ] `https://api.yourdomain.com/health` returns 200
- [ ] `npx prisma migrate deploy` has run successfully against production
- [ ] Certbot auto-renewal works: `certbot renew --dry-run`
- [ ] Nightly backup has produced at least one file in Backblaze B2
- [ ] GitHub Actions deploy workflow runs green on a test push
- [ ] `ufw status` shows only 22/80/443 open
- [ ] `.env` is not committed to git and file permissions are `600`
- [ ] WhatsApp webhook verified in the Meta dashboard (green checkmark)
- [ ] `GET /api/v1/lab-providers` has a `verificationStatus: 'verified'`
      filter added before real patients can browse it (see README's "not
      built yet" section — this is currently unfiltered)
- [ ] A plan exists for who can update lab order results (currently: any
      authenticated doctor, not just the owning lab — see README)

---

## Ongoing maintenance

- `pm2 logs medvault-api` — live logs
- `pm2 monit` — CPU/memory of the running process
- `sudo -u postgres psql medvault_cloud` — direct DB access
- `git pull && npm install && npx prisma migrate deploy && npm run build && pm2 restart medvault-api`
  — manual deploy if you ever need to skip GitHub Actions
- Watch `free -h` occasionally — if swap usage stays high under *normal*
  load (not just during deploys), that's your signal to upgrade to CX33, not
  before
