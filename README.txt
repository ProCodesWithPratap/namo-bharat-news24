NAMO BHARAT NEWS 24 — Launch Bundle v6

This is the next hard upgrade:
- PostgreSQL for application data
- Redis for session storage and short-lived 2FA pre-auth state
- password reset token flow with email support
- TOTP 2FA for admin accounts
- role-based multi-admin access
- audit logs
- responsive public site and admin panel
- Docker + docker-compose + nginx split for app / media / database / cache

--------------------------------------------------
DEFAULT LOGIN
--------------------------------------------------
Username: admin
Password: <set-your-own-password>

Change it immediately after first login.

--------------------------------------------------
FASTEST WAY TO RUN (Docker)
--------------------------------------------------
1. Copy .env.example to .env
2. Edit SESSION_SECRET and ADMIN_* values
3. Run:
   docker compose up --build
4. Open:
   http://localhost
5. Admin:
   http://localhost/admin

--------------------------------------------------
LOCAL RUN WITHOUT DOCKER
--------------------------------------------------
You need:
- Node 22+
- PostgreSQL
- Redis

1. Copy .env.example to .env
2. Set DATABASE_URL and REDIS_URL for your machine
3. Run:
   npm install
   npm start
4. Open:
   http://localhost:3000
5. Admin:
   http://localhost:3000/admin

--------------------------------------------------
PASSWORD RESET
--------------------------------------------------
- On the login page, click "Forgot password"
- Enter username or email
- If SMTP is configured, an email is sent
- If SMTP is NOT configured, the reset link is written to:
  data/dev-mailbox.log

--------------------------------------------------
2FA
--------------------------------------------------
- Login
- Open Security tab
- Click "Start 2FA setup"
- Scan QR in Google Authenticator / Microsoft Authenticator / Aegis etc.
- Enter the generated code and enable 2FA

--------------------------------------------------
WHAT THIS UPGRADE CHANGES
--------------------------------------------------
Earlier builds stored data in local files or lighter storage.
This build moves the app to:
- PostgreSQL tables for settings, categories, articles, reporters, payments, users, audit logs, reset tokens
- Redis for sessions
- stronger account controls
- reset flow
- TOTP 2FA
- isolated Docker services

--------------------------------------------------
IMPORTANT NOTES
--------------------------------------------------
- This is a strong production-style architecture jump, but still not a giant enterprise platform.
- For internet-facing launch, you should still:
  - put HTTPS/TLS in front
  - set a strong SESSION_SECRET
  - use a real domain
  - configure SMTP
  - rotate default admin credentials
  - keep Docker host and OS updated
  - back up PostgreSQL and uploaded media
- Nginx is included, but TLS certificates are not included in this package.

--------------------------------------------------
PROJECT FILES
--------------------------------------------------
server.js            backend
public/index.html    public site
public/admin.html    admin panel
public/admin.js      admin logic
public/styles.css    site/admin styling
docker-compose.yml   app + postgres + redis + nginx
Dockerfile           app image
nginx.conf           reverse proxy config
.env.example         environment template


Elite hardening changes in this bundle:
- no hard-coded default admin password in UI or bootstrap flow
- production config validation for HTTPS, Redis, PostgreSQL and session secret
- generated request IDs and safer global error responses
- request timeout guard and graceful shutdown hooks
- SVG uploads disabled to reduce XSS risk
- public site rendering switched away from unsafe dynamic HTML in key areas
- bootstrap credentials written once to data/bootstrap-admin.txt on first startup


--------------------------------------------------
9.8+ PRODUCTION PUSH IN THIS BUNDLE
--------------------------------------------------
Added in this upgrade:
- /healthz and /readyz endpoints for liveness and dependency readiness
- PM2 ecosystem file for managed process restarts
- GitHub Actions CI for syntax and smoke checks
- basic node:test smoke suite
- healthcheck helper script for Docker and external monitors
- backup manifest helper for data and uploads inventory
- stronger .env production examples (HTTPS-first, no weak sample password)
- nginx hardening headers and timeout tuning
- .gitignore for secrets, uploads, and runtime data

--------------------------------------------------
RECOMMENDED PRODUCTION CHECKLIST
--------------------------------------------------
1. Set a real domain in APP_URL
2. Use HTTPS end-to-end or terminate TLS at a trusted reverse proxy
3. Replace all demo credentials and database passwords
4. Configure SMTP for reset emails
5. Run backups for PostgreSQL, Redis persistence, and uploads
6. Monitor /readyz from your uptime system
7. Review audit logs regularly
8. Keep OS, Docker images, Node, PostgreSQL, and Redis updated

--------------------------------------------------
USEFUL COMMANDS
--------------------------------------------------
npm run lint:basic
npm test
npm run healthcheck
npm run backup:manifest

With PM2:
pm install -g pm2
pm2 start ecosystem.config.js
pm2 save
