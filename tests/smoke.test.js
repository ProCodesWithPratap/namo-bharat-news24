const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const server = fs.readFileSync('server.js', 'utf8');
const adminJs = fs.readFileSync('public/admin.js', 'utf8');
const adminHtml = fs.readFileSync('public/admin.html', 'utf8');
const indexHtml = fs.readFileSync('public/index.html', 'utf8');
const styles = fs.readFileSync('public/styles.css', 'utf8');

test('package has production scripts', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(typeof pkg.scripts.start, 'string');
  assert.equal(typeof pkg.scripts.test, 'string');
  assert.equal(typeof pkg.scripts.healthcheck, 'string');
});

test('nginx proxies app traffic', () => {
  const nginx = fs.readFileSync('nginx.conf', 'utf8');
  assert.match(nginx, /proxy_pass http:\/\/app:3000/);
  assert.match(nginx, /client_max_body_size/);
});

test('env example avoids insecure demo defaults', () => {
  const env = fs.readFileSync('.env.example', 'utf8');
  assert.doesNotMatch(env, /ADMIN_PASSWORD=123456/);
  assert.match(env, /SESSION_SECRET=/);
});

test('server has a single readiness route and assistant endpoints', () => {
  assert.equal((server.match(/app.get\('\/readyz'/g) || []).length, 1);
  assert.match(server, /app.post\('\/api\/assistant\/public'/);
  assert.match(server, /app.post\('\/api\/admin\/assistant'/);
});

test('print views escape dynamic values before sending HTML', () => {
  assert.match(server, /function escapeHtml\(/);
  assert.match(server, /<title>\$\{escapeHtml\(title\)\}<\/title>/);
  assert.match(server, /\$\{escapeHtml\(settings\.siteName\)\}/);
  assert.match(server, /\$\{safeImageUrl\(settings\.logo\)\}/);
  assert.match(server, /\$\{escapeHtml\(payment\.reference \|\| '-'\)\}/);
});

test('admin password reset uses a modal form instead of prompt', () => {
  assert.match(adminHtml, /id="resetPasswordModal"/);
  assert.match(adminJs, /resetUserPasswordForm/);
});

test('admin UI includes AI studio, search filters, and mobile sidebar toggle', () => {
  assert.match(adminHtml, /assistantTab/);
  assert.match(adminHtml, /articleSearch/);
  assert.match(adminHtml, /sidebarToggleBtn/);
  assert.match(adminJs, /adminAiForm/);
  assert.match(adminJs, /sidebar\.classList\.toggle\('open'/);
});

test('public UI includes search and assistant drawer', () => {
  assert.match(indexHtml, /assistantDrawer/);
  assert.match(indexHtml, /publicSearch/);
  assert.match(indexHtml, /api\/assistant\/public/);
});

test('styles include assistant and responsive admin behavior', () => {
  assert.match(styles, /\.assistant-drawer/);
  assert.match(styles, /\.mobile-admin-toggle/);
  assert.match(styles, /\.list-search/);
});


test('assistant builders exist and category rename no longer uses prompt', () => {
  assert.match(server, /async function buildPublicAssistantReply\(/);
  assert.match(server, /async function buildAdminAssistantReply\(/);
  assert.doesNotMatch(adminJs, /window\.prompt\(/);
  assert.match(adminHtml, /id="categoryRenameModal"/);
  assert.match(adminJs, /categoryRenameForm/);
});


test('admin settings save uses /api/settings and server keeps backward-compatible site-data route', () => {
  assert.match(adminJs, /api\('\/api\/settings'/);
  assert.match(server, /app.put\('\/api\/admin\/site-data'/);
  assert.match(server, /app.put\('\/api\/settings'/);
});

test('https redirect middleware handles forwarded proto lists', () => {
  assert.match(server, /split\(','\)\[0\]\.trim\(\)\.toLowerCase\(\)/);
});

test('admin UX hardening includes modal controls and password hints', () => {
  assert.match(adminJs, /function openModal\(/);
  assert.match(adminJs, /function closeModal\(/);
  assert.match(adminJs, /passwordPolicyHint/);
  assert.match(styles, /prefers-reduced-motion/);
});

test('login supports username or email identity', () => {
  assert.match(server, /async function findUserByLoginIdentity\(/);
  assert.match(server, /findUserByEmail\(normalized, includeSecrets\)/);
  assert.match(server, /Invalid username\/email or password/);
});
