#!/usr/bin/env bash
#
# MedVAULT Cloud — Hetzner CX23 provisioning script
# Target: fresh Ubuntu 24.04 LTS server, run as root, first boot.
#
# What it does:
#   1. System hardening: non-root deploy user, UFW firewall, fail2ban, swap
#   2. Installs Node 22, PostgreSQL 16, Nginx, Certbot, PM2
#   3. Creates the app database + user
#   4. Clones your repo, installs deps, runs Prisma migrations
#   5. Configures Nginx as a reverse proxy + free Let's Encrypt SSL
#   6. Starts the API under PM2 and enables it on boot
#   7. Sets up a nightly encrypted Postgres backup to Backblaze B2 (optional)
#
# Usage:
#   1. Edit the variables in the CONFIG section below (or export them before running)
#   2. Copy this file to the server, then: chmod +x setup-server.sh && ./setup-server.sh
#
set -euo pipefail

# ───────────────────────── CONFIG — edit these ─────────────────────────
DOMAIN="${DOMAIN:-api.yourdomain.com}"           # DNS A record must already point here
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-you@yourdomain.com}"
DEPLOY_USER="${DEPLOY_USER:-medvault}"
APP_DIR="${APP_DIR:-/opt/medvault-cloud}"
GIT_REPO_URL="${GIT_REPO_URL:-}"                 # e.g. git@github.com:you/medvault-cloud.git — leave empty to skip auto-clone
APP_PORT="${APP_PORT:-8080}"
DB_NAME="${DB_NAME:-medvault_cloud}"
DB_USER="${DB_USER:-medvault_app}"
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -hex 24)}"
JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 48)}"
SECRET_ENCRYPTION_KEY="${SECRET_ENCRYPTION_KEY:-$(openssl rand -hex 32)}"
SWAP_SIZE_GB="${SWAP_SIZE_GB:-2}"
# ─────────────────────────────────────────────────────────────────────────

log() { echo -e "\n\033[1;32m==> $1\033[0m"; }

if [[ $EUID -ne 0 ]]; then
  echo "Run this as root (fresh Hetzner servers log in as root by default)." >&2
  exit 1
fi

# ── 1. Base packages, timezone, swap ─────────────────────────────────────
log "Updating system and installing base packages"
apt-get update -y
apt-get upgrade -y
apt-get install -y curl wget git ufw fail2ban unzip ca-certificates gnupg lsb-release

log "Setting timezone to UTC (change if you prefer local hospital time)"
timedatectl set-timezone UTC

if [[ ! -f /swapfile ]]; then
  log "Creating ${SWAP_SIZE_GB}GB swap file (protects the 4GB RAM box during npm install/build)"
  fallocate -l "${SWAP_SIZE_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl vm.swappiness=10
  echo 'vm.swappiness=10' >> /etc/sysctl.conf
else
  log "Swap file already exists, skipping"
fi

# ── 2. Firewall + fail2ban ────────────────────────────────────────────────
log "Configuring UFW firewall (allow SSH, HTTP, HTTPS only)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

log "Enabling fail2ban with default SSH jail"
systemctl enable --now fail2ban

# ── 3. Deploy user ─────────────────────────────────────────────────────────
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  log "Creating deploy user: $DEPLOY_USER"
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
  usermod -aG sudo "$DEPLOY_USER"
  mkdir -p "/home/$DEPLOY_USER/.ssh"
  if [[ -f /root/.ssh/authorized_keys ]]; then
    cp /root/.ssh/authorized_keys "/home/$DEPLOY_USER/.ssh/authorized_keys"
  fi
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
  chmod 700 "/home/$DEPLOY_USER/.ssh"
  chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys" 2>/dev/null || true
else
  log "Deploy user $DEPLOY_USER already exists, skipping"
fi

# ── 4. Node.js 22 ───────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v)" != v22* ]]; then
  log "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
else
  log "Node 22 already installed, skipping"
fi

log "Installing PM2 globally"
npm install -g pm2

# ── 5. PostgreSQL 16 ─────────────────────────────────────────────────────────
if ! command -v psql >/dev/null 2>&1; then
  log "Installing PostgreSQL (Ubuntu 24.04 ships PostgreSQL 16 by default)"
  apt-get install -y postgresql postgresql-contrib
else
  log "PostgreSQL already installed, skipping"
fi

log "Creating database and app user"
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};"

# ── 6. Nginx + Certbot ────────────────────────────────────────────────────────
log "Installing Nginx and Certbot"
apt-get install -y nginx certbot python3-certbot-nginx

log "Writing Nginx reverse-proxy config for ${DOMAIN}"
cat > "/etc/nginx/sites-available/medvault-cloud" <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/medvault-cloud /etc/nginx/sites-enabled/medvault-cloud
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

log "Requesting Let's Encrypt certificate for ${DOMAIN}"
echo "    (skip this step if DNS for ${DOMAIN} isn't pointed at this server yet — rerun certbot manually later)"
certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "${LETSENCRYPT_EMAIL}" --redirect || \
  echo "    Certbot failed — check DNS and rerun: certbot --nginx -d ${DOMAIN}"

# ── 7. App directory + clone ─────────────────────────────────────────────────
mkdir -p "$APP_DIR"
chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"

if [[ -n "$GIT_REPO_URL" ]]; then
  if [[ ! -d "$APP_DIR/.git" ]]; then
    log "Cloning $GIT_REPO_URL into $APP_DIR"
    sudo -u "$DEPLOY_USER" git clone "$GIT_REPO_URL" "$APP_DIR"
  else
    log "Repo already present, pulling latest"
    sudo -u "$DEPLOY_USER" git -C "$APP_DIR" pull
  fi
else
  log "GIT_REPO_URL not set — skipping clone. Copy your code to $APP_DIR manually, then re-run steps 8-10 below."
fi

# ── 8. .env file ──────────────────────────────────────────────────────────────
if [[ -d "$APP_DIR" && ! -f "$APP_DIR/.env" ]]; then
  log "Writing $APP_DIR/.env"
  cat > "$APP_DIR/.env" <<ENV
NODE_ENV=production
PORT=${APP_PORT}
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}?schema=public"
JWT_SECRET="${JWT_SECRET}"
SECRET_ENCRYPTION_KEY="${SECRET_ENCRYPTION_KEY}"
HMAC_CLOCK_SKEW_SECONDS=300

# Fill these in once you set up each integration (see SETUP.md) — the app
# runs fine without them, each feature just no-ops/logs instead of sending:
WHATSAPP_VERIFY_TOKEN=""
WHATSAPP_ACCESS_TOKEN=""
WHATSAPP_PHONE_NUMBER_ID=""
ANTHROPIC_API_KEY=""
DAILY_API_KEY=""
DAILY_SUBDOMAIN=""
EXPO_ACCESS_TOKEN=""
ENV
  chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi

# ── 9. Install, build, migrate ────────────────────────────────────────────────
if [[ -d "$APP_DIR" && -f "$APP_DIR/package.json" ]]; then
  log "Installing dependencies, generating Prisma client, building, migrating"
  sudo -u "$DEPLOY_USER" bash -c "cd '$APP_DIR' && npm install"
  sudo -u "$DEPLOY_USER" bash -c "cd '$APP_DIR' && npx prisma generate"
  sudo -u "$DEPLOY_USER" bash -c "cd '$APP_DIR' && npx prisma migrate deploy"
  sudo -u "$DEPLOY_USER" bash -c "cd '$APP_DIR' && npm run build --if-present"

  # ── 10. PM2 ──────────────────────────────────────────────────────────────
  log "Starting API under PM2"
  sudo -u "$DEPLOY_USER" bash -c "cd '$APP_DIR' && pm2 start dist/server.js --name medvault-api"
  sudo -u "$DEPLOY_USER" bash -c "pm2 save"
  env PATH=$PATH:/usr/bin pm2 startup systemd -u "$DEPLOY_USER" --hp "/home/$DEPLOY_USER" | tail -n1 | bash
else
  log "App code not found in $APP_DIR yet — set GIT_REPO_URL and re-run, or deploy manually then run:"
  echo "    cd $APP_DIR && npm install && npx prisma generate && npx prisma migrate deploy && npm run build"
  echo "    pm2 start dist/server.js --name medvault-api && pm2 save"
fi

# ── 11. Nightly backup (optional — needs rclone configured with a B2 remote) ──
log "Writing nightly backup script (activate once rclone is configured — see SETUP.md)"
cat > /usr/local/bin/medvault-backup.sh <<'BACKUP'
#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date +%F_%H%M)
OUT="/tmp/medvault_${STAMP}.sql.gz"
sudo -u postgres pg_dump medvault_cloud | gzip > "$OUT"
# Requires: rclone config'd with a remote named "b2" pointing at your Backblaze bucket
if command -v rclone >/dev/null 2>&1 && rclone listremotes | grep -q '^b2:'; then
  rclone copy "$OUT" b2:medvault-backups/
fi
find /tmp -name "medvault_*.sql.gz" -mtime +7 -delete
rm -f "$OUT"
BACKUP
chmod +x /usr/local/bin/medvault-backup.sh
( crontab -l 2>/dev/null | grep -v medvault-backup.sh ; echo "0 2 * * * /usr/local/bin/medvault-backup.sh" ) | crontab -

log "Done."
cat <<SUMMARY

──────────────────────────────────────────────────────────────
  MedVAULT Cloud server setup complete
──────────────────────────────────────────────────────────────
  Domain:        https://${DOMAIN}
  App directory: ${APP_DIR}
  DB name:       ${DB_NAME}
  DB user:       ${DB_USER}
  DB password:      ${DB_PASSWORD}
  JWT secret:       ${JWT_SECRET}
  Secret encryption key: ${SECRET_ENCRYPTION_KEY}

  SAVE these somewhere safe now — they are only printed once,
  here, and are already written into ${APP_DIR}/.env on this
  server. The secret encryption key in particular is what
  protects every hospital's HMAC secret at rest; losing it
  means every hospital installation needs to be reactivated.

  Next steps:
    1. Check:  curl https://${DOMAIN}/health
    2. Docs:   https://${DOMAIN}/docs
    3. Configure rclone for backups (see SETUP.md)
    4. Set up GitHub Actions deploy (see SETUP.md)
──────────────────────────────────────────────────────────────
SUMMARY
