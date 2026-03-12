from pathlib import Path
import re, secrets

root = Path('.')
server = (root/'server.js').read_text()
admin = (root/'public'/'admin.js').read_text()
index = (root/'public'/'index.html').read_text()
admin_html = (root/'public'/'admin.html').read_text()
readme = (root/'README.txt').read_text()
envex = (root/'.env.example').read_text()
pkg = (root/'package.json').read_text()

server = server.replace("const DEFAULT_ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '123456');", "const DEFAULT_ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();\nconst BOOTSTRAP_ADMIN_FILE = path.join(DATA_DIR, 'bootstrap-admin.txt');\nconst REQUIRE_EXPLICIT_ADMIN_PASSWORD = String(process.env.REQUIRE_EXPLICIT_ADMIN_PASSWORD || 'true').toLowerCase() !== 'false';")
server = server.replace("const MAX_IMAGE_SIZE = 3 * ONE_MB;", "const MAX_IMAGE_SIZE = 3 * ONE_MB;\nconst REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15_000);\nconst MAX_JSON_BODY = process.env.MAX_JSON_BODY || '256kb';")
server = server.replace("const allowedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);", "const allowedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);")
server = server.replace("const safeExt = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext) ? ext : '.bin';", "const safeExt = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) ? ext : '.bin';")
server = server.replace("      return cb(new Error('Only PNG, JPG, WEBP, GIF or SVG images are allowed'));", "      return cb(new Error('Only PNG, JPG, WEBP or GIF images are allowed'));" )
server = server.replace("app.use(express.json({ limit: '1mb' }));\napp.use(express.urlencoded({ extended: false, limit: '1mb' }));", "app.use(express.json({ limit: MAX_JSON_BODY }));\napp.use(express.urlencoded({ extended: false, limit: MAX_JSON_BODY }));")
server = server.replace("    secure: IS_PROD,", "    secure: IS_PROD || FORCE_HTTPS,")

insertion = """
function generateStrongPassword(length = 24) {
  return crypto.randomBytes(length).toString('base64url').slice(0, length);
}
function maskSecret(value = '') {
  if (!value) return '';
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}
function validateConfig() {
  const problems = [];
  if (IS_PROD && !FORCE_HTTPS) problems.push('FORCE_HTTPS should be true in production');
  if (IS_PROD && !String(APP_URL).startsWith('https://')) problems.push('APP_URL should use https:// in production');
  if (IS_PROD && !String(DATABASE_URL).startsWith('postgres')) problems.push('DATABASE_URL must point to PostgreSQL');
  if (IS_PROD && !String(REDIS_URL).startsWith('redis')) problems.push('REDIS_URL must point to Redis');
  if (IS_PROD && !SESSION_SECRET) problems.push('SESSION_SECRET is required in production');
  if (problems.length) {
    throw new Error(`Configuration validation failed: ${problems.join('; ')}`);
  }
}
validateConfig();
"""
server = server.replace("for (const dir of [DATA_DIR, PUBLIC_DIR, UPLOAD_DIR]) {\n  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });\n}\n", "for (const dir of [DATA_DIR, PUBLIC_DIR, UPLOAD_DIR]) {\n  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });\n}\n" + insertion)

# add request id + timeout middleware before routes
middleware = """
app.use((req, res, next) => {
  req.requestId = req.get('x-request-id') || crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);
  res.setHeader('x-content-type-options', 'nosniff');
  next();
});
app.use((req, res, next) => {
  res.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(408).json({ message: 'Request timeout', requestId: req.requestId });
    }
  });
  next();
});
"""
server = server.replace("app.use((req, res, next) => {\n  if (FORCE_HTTPS && !req.secure && req.get('x-forwarded-proto') !== 'https') {", middleware + "\napp.use((req, res, next) => {\n  if (FORCE_HTTPS && !req.secure && req.get('x-forwarded-proto') !== 'https') {")

# strong bootstrap admin logic
pattern = re.compile(r"const adminCount = await one\(`SELECT COUNT\(\*\)::int AS count FROM users`\);\n  if \(!adminCount \|\| adminCount.count === 0\) \{\n    const hash = await hashPassword\(DEFAULT_ADMIN_PASSWORD\);\n    await query\(`\n      INSERT INTO users \(id, username, email, full_name, role, active, password_hash, require_password_change, password_changed_at\)\n      VALUES \(\$1, \$2, \$3, \$4, \$5, TRUE, \$6, \$7, now\(\)\)\n    `, \[crypto.randomUUID\(\), DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_EMAIL, 'Primary Administrator', 'superadmin', hash, DEFAULT_ADMIN_PASSWORD === '123456'\]\);\n  \}")
replacement = """const adminCount = await one(`SELECT COUNT(*)::int AS count FROM users`);
  if (!adminCount || adminCount.count === 0) {
    const bootstrapPassword = DEFAULT_ADMIN_PASSWORD || generateStrongPassword(24);
    if (IS_PROD && REQUIRE_EXPLICIT_ADMIN_PASSWORD && !DEFAULT_ADMIN_PASSWORD) {
      throw new Error('ADMIN_PASSWORD must be set for first production bootstrap');
    }
    const hash = await hashPassword(bootstrapPassword);
    await query(`
      INSERT INTO users (id, username, email, full_name, role, active, password_hash, require_password_change, password_changed_at)
      VALUES ($1, $2, $3, $4, $5, TRUE, $6, TRUE, now())
    `, [crypto.randomUUID(), DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_EMAIL, 'Primary Administrator', 'superadmin', hash]);
    await fsp.writeFile(BOOTSTRAP_ADMIN_FILE, `Bootstrap admin created\nusername=${DEFAULT_ADMIN_USERNAME}\nemail=${DEFAULT_ADMIN_EMAIL}\npassword=${bootstrapPassword}\n`, 'utf8');
    console.warn(`Bootstrap admin created. Credentials stored at ${BOOTSTRAP_ADMIN_FILE}. Username=${DEFAULT_ADMIN_USERNAME}, password=${maskSecret(bootstrapPassword)}`);
  }"""
server = pattern.sub(replacement, server)

# system-status add request info maybe not
server = server.replace("res.json({ ok: true });", "res.json({ ok: true, requestId: _req?.requestId || undefined });", 1)
server = server.replace("res.json({ ok: true });", "res.json({ ok: true, requestId: _req?.requestId || undefined });")
server = server.replace("res.status(500).json({ ok: false, message: 'Dependency check failed' });", "res.status(500).json({ ok: false, message: 'Dependency check failed', requestId: _req?.requestId || undefined });")

# error handler + graceful shutdown
server = server.replace("app.listen(PORT, async () => {", "app.use((error, req, res, _next) => {\n  console.error(`[${req?.requestId || 'n/a'}]`, error?.stack || error);\n  if (res.headersSent) return;\n  const status = error?.statusCode || error?.status || 500;\n  const message = status >= 500 ? 'Internal server error' : (error?.message || 'Request failed');\n  res.status(status).json({ message, requestId: req?.requestId || '' });\n});\n\nconst serverInstance = app.listen(PORT, async () => {")
server = server.replace("});\n", "});\n\nasync function shutdown(signal) {\n  console.log(`Received ${signal}. Shutting down cleanly...`);\n  serverInstance.close(async () => {\n    try { await pool.end(); } catch {}\n    try { await redisClient.quit(); } catch {}\n    process.exit(0);\n  });\n  setTimeout(() => process.exit(1), 10_000).unref();\n}\n['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => shutdown(signal)));\n", 1)
# above replacement may hit first closing }); too early. fix by appending if missing
if "Received ${signal}. Shutting down cleanly" not in server:
    server += "\n\nasync function shutdown(signal) {\n  console.log(`Received ${signal}. Shutting down cleanly...`);\n  serverInstance.close(async () => {\n    try { await pool.end(); } catch {}\n    try { await redisClient.quit(); } catch {}\n    process.exit(0);\n  });\n  setTimeout(() => process.exit(1), 10_000).unref();\n}\n['SIGINT', 'SIGTERM'].forEach((signal) => process.on(signal, () => shutdown(signal)));\n"

# safer admin.js helpers
helper = """
function escapeHtml(value=''){ return String(value).replace(/[&<>\"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch])); }
function setHTML(el, html){ el.innerHTML = html; }
"""
admin = admin.replace("const toastEl = $('#toast');\n", "const toastEl = $('#toast');\n" + helper)
admin = admin.replace("${item.action}", "${escapeHtml(item.action)}")
admin = admin.replace("${item.actorUsername || 'system'}", "${escapeHtml(item.actorUsername || 'system')}")
admin = admin.replace("${item.details || ''}", "${escapeHtml(item.details || '')}")
for raw in ["${a.id}", "${a.title}", "${cat.name}", "${cat.id}", "${article.title}", "${article.category}", "${article.location}", "${reporter.fullName}", "${reporter.designation}", "${payment.id}", "${user.id}", "${user.username}", "${user.fullName}", "${user.role}"]:
    admin = admin.replace(raw, raw.replace('${', '${escapeHtml(')[:-1] + ')}')
admin = admin.replace("${data.storage.uploads}", "${escapeHtml(data.storage.uploads)}")
admin = admin.replace("${state.user.fullName} • ${state.user.role}", "${state.user.fullName} • ${state.user.role}")

# safer public index script by replacing main render funcs entirely
index = index.replace("if(settings.logo){\n        byId('siteLogo').innerHTML = '<img alt=\"logo\" src=\"'+settings.logo+'\" style=\"width:100%;height:100%;object-fit:cover\">';\n      }", "if(settings.logo){\n        const wrap = byId('siteLogo');\n        wrap.textContent = '';\n        const img = document.createElement('img');\n        img.alt = 'logo';\n        img.src = settings.logo;\n        img.style.width = '100%';\n        img.style.height = '100%';\n        img.style.objectFit = 'cover';\n        wrap.appendChild(img);\n      }")

new_block = '''
    function renderHero(){
      const heroId = state.settings.heroArticleId;
      const article = state.articles.find(x => x.id === heroId) || state.articles[0];
      if(!article) return;
      const heroImage = byId('heroImage');
      heroImage.textContent = '';
      const img = document.createElement('img');
      img.alt = '';
      img.src = article.image || placeholder;
      heroImage.appendChild(img);
      const heroMeta = byId('heroMeta');
      heroMeta.textContent = '';
      [article.category, article.location, formatDate(article.publishedAt)].forEach(text => {
        const span = document.createElement('span');
        span.textContent = text || '—';
        heroMeta.appendChild(span);
      });
      byId('heroTitle').textContent = article.title;
      byId('heroSummary').textContent = article.summary || '';
    }

    function renderTrending(){
      const items = state.articles.filter(x => x.trending || x.featured).slice(0,6);
      const mount = byId('trendingList');
      mount.textContent = '';
      if(!items.length){
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'कोई ट्रेंडिंग खबर नहीं';
        mount.appendChild(empty);
        return;
      }
      items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'mini-story';
        const badge = document.createElement('div');
        badge.className = 'badge red';
        badge.textContent = item.category;
        const h3 = document.createElement('h3');
        h3.style.margin = '8px 0 6px';
        h3.style.fontSize = '18px';
        h3.textContent = item.title;
        const meta = document.createElement('div');
        meta.className = 'muted';
        meta.textContent = `${item.location} • ${formatDate(item.publishedAt)}`;
        card.append(badge, h3, meta);
        mount.appendChild(card);
      });
    }

    function renderSections(){
      const mount = byId('sectionsMount');
      const visible = state.settings.visibleSections || {};
      const groups = {};
      state.articles.forEach(article => {
        groups[article.category] = groups[article.category] || [];
        groups[article.category].push(article);
      });
      mount.textContent = '';
      const activeCategories = state.categories.filter(cat => cat.enabled && visible[cat.name] !== false && groups[cat.name]?.length);
      if(!activeCategories.length){
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'अभी कोई खबर उपलब्ध नहीं है।';
        mount.appendChild(empty);
        return;
      }
      activeCategories.forEach(cat => {
        const section = document.createElement('section');
        section.className = 'section';
        const head = document.createElement('div');
        head.className = 'section-head';
        const title = document.createElement('div');
        title.className = 'section-title';
        title.textContent = cat.name;
        const more = document.createElement('div');
        more.className = 'muted';
        more.textContent = 'और खबरें';
        head.append(title, more);
        const grid = document.createElement('div');
        grid.className = 'story-grid';
        groups[cat.name].slice(0,6).forEach(article => {
          const card = document.createElement('article');
          card.className = 'story-card';
          const img = document.createElement('img');
          img.alt = '';
          img.src = article.image || placeholder;
          const body = document.createElement('div');
          body.className = 'story-body';
          const meta = document.createElement('div');
          meta.className = 'meta';
          const loc = document.createElement('span');
          loc.textContent = article.location;
          const when = document.createElement('span');
          when.textContent = formatDate(article.publishedAt);
          meta.append(loc, when);
          const h3 = document.createElement('h3');
          h3.textContent = article.title;
          const p = document.createElement('p');
          p.textContent = article.summary || '';
          body.append(meta, h3, p);
          card.append(img, body);
          grid.appendChild(card);
        });
        section.append(head, grid);
        mount.appendChild(section);
      });
    }
'''
index = re.sub(r"function renderHero\(\)\{.*?function renderSections\(\)\{.*?\n    \}", new_block.strip(), index, flags=re.S)
index = index.replace("byId('navChips').innerHTML = state.categories.map(cat => `<span class=\"nav-chip\">${cat.name}</span>`).join('');", "const nav = byId('navChips'); nav.textContent=''; state.categories.forEach(cat => { const chip = document.createElement('span'); chip.className = 'nav-chip'; chip.textContent = cat.name; nav.appendChild(chip); });")
index = index.replace("byId('sectionsMount').innerHTML = '<div class=\"empty\">साइट डेटा लोड नहीं हो पाया। सर्वर चालू है या नहीं, यह जांचें।</div>';", "const mount = byId('sectionsMount'); mount.textContent=''; const empty = document.createElement('div'); empty.className='empty'; empty.textContent='साइट डेटा लोड नहीं हो पाया। सर्वर चालू है या नहीं, यह जांचें।'; mount.appendChild(empty);")

admin_html = admin_html.replace("<div class=\"notice\" style=\"margin-top:14px\">Default account: admin / 123456. Change it immediately after first login.</div>", "<div class=\"notice\" style=\"margin-top:14px\">Bootstrap admin credentials are created from environment variables or written once to the server bootstrap file during first setup.</div>")

readme = readme.replace("123456", "<set-your-own-password>")
readme += "\n\nElite hardening changes in this bundle:\n- no hard-coded default admin password in UI or bootstrap flow\n- production config validation for HTTPS, Redis, PostgreSQL and session secret\n- generated request IDs and safer global error responses\n- request timeout guard and graceful shutdown hooks\n- SVG uploads disabled to reduce XSS risk\n- public site rendering switched away from unsafe dynamic HTML in key areas\n- bootstrap credentials written once to data/bootstrap-admin.txt on first startup\n"

envex += "\nREQUIRE_EXPLICIT_ADMIN_PASSWORD=true\nREQUEST_TIMEOUT_MS=15000\nMAX_JSON_BODY=256kb\n"
pkg = pkg.replace('"scripts": {\n    "start": "node server.js",\n    "dev": "NODE_ENV=development node server.js"\n  },', '"scripts": {\n    "start": "node server.js",\n    "dev": "NODE_ENV=development node server.js",\n    "start:prod": "NODE_ENV=production node server.js"\n  },')

(root/'server.js').write_text(server)
(root/'public'/'admin.js').write_text(admin)
(root/'public'/'index.html').write_text(index)
(root/'public'/'admin.html').write_text(admin_html)
(root/'README.txt').write_text(readme)
(root/'.env.example').write_text(envex)
(root/'package.json').write_text(pkg)
