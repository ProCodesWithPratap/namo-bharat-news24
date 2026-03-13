require('dotenv').config();

const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const { createClient } = require('redis');
const multer = require('multer');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const scryptAsync = promisify(crypto.scrypt);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';
const FORCE_HTTPS = String(process.env.FORCE_HTTPS || '').toLowerCase() === 'true';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || (!IS_PROD ? crypto.randomBytes(32).toString('hex') : '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/namo_bharat_news24';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const REDIS_REQUIRED = String(process.env.REDIS_REQUIRED || (IS_PROD ? 'true' : 'false')).toLowerCase() === 'true';
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(PUBLIC_DIR, 'uploads'));
const MAILBOX_LOG = path.join(DATA_DIR, 'dev-mailbox.log');
const ONE_MB = 1024 * 1024;
const MAX_IMAGE_SIZE = 3 * ONE_MB;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15_000);
const MAX_JSON_BODY = process.env.MAX_JSON_BODY || '256kb';
const SESSION_COOKIE_NAME = 'nbn24.sid';
const PASSWORD_MIN_LENGTH = 10;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const RESET_TOKEN_TTL_SEC = 30 * 60;
const PREAUTH_TTL_SEC = 5 * 60;
const APP_NAME = 'Namo Bharat News 24';
const DEFAULT_ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase() || 'admin';
const DEFAULT_ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || 'admin@namo-bharat-news24.local').trim().toLowerCase();
const DEFAULT_ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const BOOTSTRAP_ADMIN_FILE = path.join(DATA_DIR, 'bootstrap-admin.txt');
const REQUIRE_EXPLICIT_ADMIN_PASSWORD = String(process.env.REQUIRE_EXPLICIT_ADMIN_PASSWORD || 'true').toLowerCase() !== 'false';
const AUDIT_LOG_LIMIT = 300;
const STARTED_AT = new Date();
let isReady = false;


if (IS_PROD && !SESSION_SECRET) {
  throw new Error('SESSION_SECRET is required in production');
}
for (const dir of [DATA_DIR, PUBLIC_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

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

app.disable('x-powered-by');
app.set('trust proxy', 1);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: String(process.env.PGSSLMODE || '').toLowerCase() === 'require' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.PGPOOL_MAX || 12),
  idleTimeoutMillis: 20_000
});

const redisClient = createClient({ url: REDIS_URL });
let redisAvailable = false;
const localPreAuthStore = new Map();
redisClient.on('error', (error) => {
  if (REDIS_REQUIRED || IS_PROD) console.error('Redis error:', error?.message || error);
});

class RedisSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.client = options.client;
    this.prefix = options.prefix || 'sess:';
  }

  get(sid, callback = () => undefined) {
    this.client.get(this.prefix + sid)
      .then((value) => callback(null, value ? JSON.parse(value) : null))
      .catch((error) => callback(error));
  }

  set(sid, sess, callback = () => undefined) {
    const ttlMs = sess?.cookie?.expires
      ? Math.max(new Date(sess.cookie.expires).getTime() - Date.now(), 1_000)
      : 1000 * 60 * 60 * 2;
    this.client.set(this.prefix + sid, JSON.stringify(sess), { PX: ttlMs })
      .then(() => callback(null))
      .catch((error) => callback(error));
  }

  touch(sid, sess, callback = () => undefined) {
    const ttlMs = sess?.cookie?.expires
      ? Math.max(new Date(sess.cookie.expires).getTime() - Date.now(), 1_000)
      : 1000 * 60 * 60 * 2;
    this.client.pExpire(this.prefix + sid, ttlMs)
      .then(() => callback(null))
      .catch((error) => callback(error));
  }

  destroy(sid, callback = () => undefined) {
    this.client.del(this.prefix + sid)
      .then(() => callback(null))
      .catch((error) => callback(error));
  }
}

const sessionStore = REDIS_REQUIRED
  ? new RedisSessionStore({ client: redisClient, prefix: 'sess:' })
  : new session.MemoryStore();

const cspDirectives = {
  defaultSrc: ["'self'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  objectSrc: ["'none'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
  imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
  fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
  connectSrc: ["'self'"],
  workerSrc: ["'self'", 'blob:']
};
if (IS_PROD) cspDirectives.upgradeInsecureRequests = [];

app.use(helmet({
  contentSecurityPolicy: { directives: cspDirectives },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(express.json({ limit: MAX_JSON_BODY }));
app.use(express.urlencoded({ extended: false, limit: MAX_JSON_BODY }));

app.use(session({
  store: sessionStore,
  secret: SESSION_SECRET,
  name: SESSION_COOKIE_NAME,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: IS_PROD || FORCE_HTTPS,
    maxAge: 1000 * 60 * 60 * 2
  }
}));


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

app.use((req, res, next) => {
  if (req.path === '/healthz' || req.path === '/readyz') return next();
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  if (FORCE_HTTPS && !req.secure && forwardedProto !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
  }
  next();
});

app.use((req, res, next) => {
  if (
    req.path === '/admin' ||
    req.path.startsWith('/admin/') ||
    req.path.startsWith('/api/admin') ||
    req.path.startsWith('/api/auth') ||
    req.path === '/api/login' ||
    req.path === '/api/logout'
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use('/uploads', express.static(UPLOAD_DIR, {
  fallthrough: false,
  index: false,
  maxAge: IS_PROD ? '7d' : 0,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (IS_PROD) res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  }
}));
app.use(express.static(PUBLIC_DIR, {
  index: false,
  maxAge: IS_PROD ? '1h' : 0,
  setHeaders(res, filePath) {
    if (/\.(css|js|png|jpg|jpeg|webp|svg|woff2?)$/i.test(filePath) && IS_PROD) {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  }
}));
app.use('/admin', express.static(PUBLIC_DIR, {
  index: false,
  maxAge: IS_PROD ? '1h' : 0
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again later.' },
  keyGenerator: (req) => `${req.ip}:${sanitizeText(req.body.username, '', 80).toLowerCase()}`
});

const sensitiveLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down.' }
});

const allowedImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeExt = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) ? ext : '.bin';
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_SIZE, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!allowedImageTypes.has(file.mimetype)) {
      return cb(new Error('Only PNG, JPG, WEBP or GIF images are allowed'));
    }
    cb(null, true);
  }
});

const ROLE_PERMISSIONS = {
  superadmin: ['*'],
  editor: ['content.manage', 'reporters.read', 'payments.read'],
  operations: ['reporters.read', 'reporters.manage', 'payments.read'],
  finance: ['payments.read', 'payments.manage', 'reporters.read'],
  viewer: ['reporters.read', 'payments.read']
};
const ALL_ROLES = Object.keys(ROLE_PERMISSIONS);

const defaultSettings = {
  siteName: 'Namo Bharat News 24',
  tagline: 'तथ्य स्पष्ट, विचार निष्पक्ष',
  logo: '',
  favicon: '',
  primaryColor: '#c4171e',
  backgroundColor: '#f7f4ef',
  breakingText: 'बड़ी खबर: बिहार और झारखंड की राजनीति, रोजगार, शिक्षा और स्थानीय खबरों पर Namo Bharat News 24 की लगातार नज़र।',
  contactEmail: 'editor@namo-bharat-news24.local',
  footerText: '© 2026 Namo Bharat News 24. सभी अधिकार सुरक्षित।',
  heroArticleId: '',
  selectedCity: 'पटना',
  editorName: 'प्रधान संपादक, Namo Bharat News 24',
  officeAddress: 'पटना, बिहार',
  visibleSections: {
    'राष्ट्रीय': true,
    'बिहार': true,
    'झारखंड': true,
    'क्रिकेट': true,
    'व्यापार': true,
    'मनोरंजन': true,
    'शिक्षा': true,
    'धर्म': true
  }
};

function defaultCategories() {
  return Object.keys(defaultSettings.visibleSections).map((name, index) => ({
    id: `cat-${index + 1}`,
    name,
    enabled: true
  }));
}

function stripTags(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function sanitizeText(value, fallback = '', max = 180) {
  const clean = stripTags(value).slice(0, max).trim();
  return clean || fallback;
}
function escapeHtml(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function safeImageUrl(value, fallback = '') {
  const clean = sanitizeImageUrl(value, fallback);
  return escapeHtml(clean || fallback);
}
function sanitizeParagraph(value, fallback = '', max = 3000) {
  const clean = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, max)
    .trim();
  return clean || fallback;
}
function sanitizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  return fallback;
}
function sanitizeColor(value, fallback) {
  const clean = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(clean) ? clean : fallback;
}
function sanitizeEmail(value, fallback = '') {
  const clean = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? clean : fallback;
}
function sanitizePhone(value, fallback = '') {
  const clean = String(value || '').replace(/[^0-9+\-\s]/g, '').trim().slice(0, 25);
  return clean || fallback;
}
function sanitizeDate(value, fallback = new Date().toISOString().slice(0, 10)) {
  const clean = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean;
  const parsed = new Date(clean);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString().slice(0, 10);
}
function sanitizeDateTime(value, fallback = new Date().toISOString()) {
  const parsed = new Date(String(value || '').trim());
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}
function sanitizeRole(value, fallback = 'viewer') {
  const clean = String(value || '').trim().toLowerCase();
  return ALL_ROLES.includes(clean) ? clean : fallback;
}
function sanitizeImageUrl(value, fallback = '') {
  const clean = String(value || '').trim();
  if (!clean) return fallback;
  if (/^\/uploads\/[a-zA-Z0-9._-]+$/.test(clean)) return clean;
  if (/^https:\/\/[^\s]+$/i.test(clean)) return clean;
  return fallback;
}
function toMoneyNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Number(num.toFixed(2))) : fallback;
}
function hasStrongPassword(password) {
  const value = String(password || '');
  return value.length >= PASSWORD_MIN_LENGTH
    && /[a-z]/.test(value)
    && /[A-Z]/.test(value)
    && /\d/.test(value)
    && /[^A-Za-z0-9]/.test(value);
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(String(password), salt, 64);
  return `${salt}:${Buffer.from(derived).toString('hex')}`;
}
async function verifyPassword(password, storedHash) {
  const [salt, hashHex] = String(storedHash || '').split(':');
  if (!salt || !hashHex) return false;
  const derived = await scryptAsync(String(password), salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  const actual = Buffer.from(derived);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
async function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function permissionsForRole(role) {
  return ROLE_PERMISSIONS[sanitizeRole(role, 'viewer')] || [];
}
function hasPermission(user, permission) {
  const permissions = permissionsForRole(user?.role);
  return permissions.includes('*') || permissions.includes(permission);
}

function summarizeText(value = '', max = 220) {
  const clean = sanitizeParagraph(value, '', max + 40).replace(/\n+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max).trim()}…` : clean;
}
function topKeywords(message = '') {
  const stop = new Set(['the','and','for','with','that','this','from','have','your','about','into','after','today','what','show','tell','news','latest','please','admin','article','draft','public','assistant','aaj','kya','hai','aur','par','ki','ke','का','की','के','और','एक','में','से','पर','यह','क्या','बताओ','खबर','समाचार','news']);
  return Array.from(new Set(
    sanitizeParagraph(message, '', 500)
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word && word.length >= 3 && !stop.has(word))
  )).slice(0, 8);
}
async function buildPublicAssistantReply(message = '') {
  const prompt = sanitizeParagraph(message, '', 500);
  const [settings, articles] = await Promise.all([getSettings(), listArticles()]);
  const keywords = topKeywords(prompt);
  const ranked = articles
    .map((article) => {
      const haystack = [article.title, article.category, article.location, article.summary, article.content].join(' ').toLowerCase();
      const score = keywords.reduce((sum, word) => sum + (haystack.includes(word) ? 2 : 0), 0)
        + (article.trending ? 1 : 0)
        + (article.featured ? 1 : 0);
      return { article, score };
    })
    .sort((a, b) => b.score - a.score || new Date(b.article.publishedAt) - new Date(a.article.publishedAt));
  const selected = ranked.filter((item) => item.score > 0).slice(0, 3).map((item) => item.article);
  const fallback = articles.slice(0, 3);
  const pool = selected.length ? selected : fallback;
  if (!pool.length) {
    return `${settings.siteName}: अभी न्यूज़रूम में कोई प्रकाशित खबर उपलब्ध नहीं है। पहले कुछ खबरें जोड़ें, फिर दोबारा पूछें।`;
  }
  const lines = [];
  lines.push(`${settings.siteName} सहायक`);
  if (prompt) lines.push(`सवाल: ${summarizeText(prompt, 140)}`);
  lines.push('');
  pool.forEach((article, index) => {
    lines.push(`${index + 1}. ${article.title}`);
    lines.push(`   सेक्शन: ${article.category || 'सामान्य'} | स्थान: ${article.location || '—'} | समय: ${new Date(article.publishedAt).toLocaleString('en-IN')}`);
    lines.push(`   सार: ${summarizeText(article.summary || article.content || '', 180)}`);
  });
  const categories = Array.from(new Set(pool.map((item) => item.category).filter(Boolean)));
  lines.push('');
  lines.push(`फोकस: ${categories.join(', ') || 'सामान्य समाचार'}`);
  lines.push('पूछ सकते हैं: बिहार की खबरें, राजनीति सार, ट्रेंडिंग 3 खबरें, किसी जिले की खबरें।');
  return lines.join('\n');
}
async function buildAdminAssistantReply(message = '', context = {}, user = {}) {
  const prompt = sanitizeParagraph(message, '', 800);
  const article = normalizeArticle(context?.articleDraft || {}, {});
  const [articles, reporters, payments] = await Promise.all([
    listArticles(),
    hasPermission(user, 'reporters.read') ? listReporters() : Promise.resolve([]),
    hasPermission(user, 'payments.read') ? listPayments() : Promise.resolve([])
  ]);
  const paidTotal = payments.filter((item) => item.status === 'paid').reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const pendingPayments = payments.filter((item) => item.status !== 'paid').length;
  const inactiveReporters = reporters.filter((item) => String(item.status || '').toLowerCase() !== 'active').length;
  const latestArticles = articles.slice(0, 5);
  const lines = [];
  lines.push(`Admin AI briefing for ${user.fullName || user.username || 'team'}`);
  lines.push(`Role: ${user.role || 'viewer'}`);
  lines.push('');
  if (article.title || article.summary || article.content) {
    const seoTitle = article.title ? `${article.title} | ${article.location || 'Bihar Jharkhand News'}`.slice(0, 68) : 'Draft title missing';
    const metaDescSource = article.summary || article.content;
    const metaDescription = summarizeText(metaDescSource, 155) || 'Draft summary missing.';
    lines.push('Article draft review');
    lines.push(`- Headline: ${article.title || 'Missing title'}`);
    lines.push(`- SEO title: ${seoTitle}`);
    lines.push(`- Meta description: ${metaDescription}`);
    lines.push(`- Quality flags: ${article.title ? 'title ok' : 'missing title'}, ${article.summary ? 'summary ok' : 'missing summary'}, ${article.content.length >= 120 ? 'content depth ok' : 'content too thin'}`);
    lines.push(`- Rewrite angle: ${article.category || 'General'} desk, ${article.location || 'local'} focus, one strong factual lead, one service takeaway.`);
    lines.push('');
  }
  lines.push('Operations snapshot');
  lines.push(`- Published articles: ${articles.length}`);
  lines.push(`- Active reporters: ${Math.max(reporters.length - inactiveReporters, 0)} / ${reporters.length}`);
  lines.push(`- Paid collections: ₹${paidTotal.toFixed(2)}`);
  lines.push(`- Pending payment items: ${pendingPayments}`);
  lines.push('');
  lines.push('Priority actions');
  lines.push(`1. ${pendingPayments ? 'Clear pending payments and verify references.' : 'Payments are clean; keep reconciliation daily.'}`);
  lines.push(`2. ${inactiveReporters ? `Review ${inactiveReporters} inactive reporters and update status.` : 'Reporter roster looks active; keep district coverage balanced.'}`);
  lines.push(`3. ${latestArticles.length ? `Promote: ${latestArticles[0].title}` : 'Add fresh homepage stories.'}`);
  if (prompt) {
    lines.push('');
    lines.push(`Prompt focus: ${summarizeText(prompt, 180)}`);
    const keywords = topKeywords(prompt);
    if (keywords.length) lines.push(`Detected keywords: ${keywords.join(', ')}`);
  }
  lines.push('Suggested asks: headline rewrite, SEO pack, risk review, homepage priorities, district coverage gaps.');
  return lines.join('\n');
}

function normalizeArticle(input = {}, existing = {}) {
  return {
    id: sanitizeText(existing.id || input.id || crypto.randomUUID(), crypto.randomUUID(), 64),
    title: sanitizeText(input.title, existing.title || '', 180),
    category: sanitizeText(input.category, existing.category || 'राष्ट्रीय', 40),
    location: sanitizeText(input.location, existing.location || 'पटना', 60),
    author: sanitizeText(input.author, existing.author || 'Namo Bharat News 24', 80),
    summary: sanitizeParagraph(input.summary, existing.summary || '', 260),
    content: sanitizeParagraph(input.content, existing.content || '', 5000),
    image: sanitizeImageUrl(input.image, existing.image || ''),
    publishedAt: sanitizeDateTime(input.publishedAt, existing.publishedAt || new Date().toISOString()),
    featured: sanitizeBoolean(input.featured, existing.featured || false),
    trending: sanitizeBoolean(input.trending, existing.trending || false)
  };
}
function normalizeReporter(input = {}, existing = {}) {
  return {
    id: sanitizeText(existing.id || input.id || crypto.randomUUID(), crypto.randomUUID(), 64),
    fullName: sanitizeText(input.fullName, existing.fullName || '', 100),
    designation: sanitizeText(input.designation, existing.designation || 'District Reporter', 80),
    district: sanitizeText(input.district, existing.district || '', 80),
    state: sanitizeText(input.state, existing.state || 'Bihar', 80),
    mobile: sanitizePhone(input.mobile, existing.mobile || ''),
    email: sanitizeEmail(input.email, existing.email || ''),
    joinDate: sanitizeDate(input.joinDate, existing.joinDate || new Date().toISOString().slice(0, 10)),
    status: sanitizeText(input.status, existing.status || 'active', 30).toLowerCase(),
    idCardNo: sanitizeText(input.idCardNo, existing.idCardNo || `NBN-${Date.now().toString().slice(-6)}`, 40),
    letterNo: sanitizeText(input.letterNo, existing.letterNo || `LTR-${Date.now().toString().slice(-6)}`, 40),
    address: sanitizeParagraph(input.address, existing.address || '', 240),
    photo: sanitizeImageUrl(input.photo, existing.photo || ''),
    notes: sanitizeParagraph(input.notes, existing.notes || '', 400)
  };
}
function normalizePayment(input = {}, existing = {}) {
  return {
    id: sanitizeText(existing.id || input.id || crypto.randomUUID(), crypto.randomUUID(), 64),
    reporterId: sanitizeText(input.reporterId, existing.reporterId || '', 64),
    amount: toMoneyNumber(input.amount, existing.amount || 0),
    type: sanitizeText(input.type, existing.type || 'joining-fee', 50),
    status: sanitizeText(input.status, existing.status || 'paid', 30).toLowerCase(),
    date: sanitizeDate(input.date, existing.date || new Date().toISOString().slice(0, 10)),
    mode: sanitizeText(input.mode, existing.mode || 'online', 30),
    reference: sanitizeText(input.reference, existing.reference || '', 60),
    notes: sanitizeParagraph(input.notes, existing.notes || '', 260)
  };
}

async function query(sql, params = []) {
  return pool.query(sql, params);
}
async function one(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}
async function many(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS articles (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      published_at TIMESTAMPTZ NOT NULL,
      featured BOOLEAN NOT NULL DEFAULT FALSE,
      trending BOOLEAN NOT NULL DEFAULT FALSE,
      data JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);

    CREATE TABLE IF NOT EXISTS reporters (
      id TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      district TEXT,
      state TEXT,
      status TEXT,
      join_date DATE,
      data JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reporters_status ON reporters(status);

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL,
      date DATE NOT NULL,
      type TEXT,
      status TEXT,
      amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      data JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payments_reporter_id ON payments(reporter_id);
    CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(date DESC);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      password_hash TEXT NOT NULL,
      require_password_change BOOLEAN NOT NULL DEFAULT FALSE,
      password_changed_at TIMESTAMPTZ,
      failed_login_count INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      last_login_at TIMESTAMPTZ,
      totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      totp_secret TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      at TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor_user_id TEXT,
      actor_username TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_at ON audit_logs(at DESC);

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_password_reset_user_id ON password_reset_tokens(user_id);
  `);

  const adminCount = await one(`SELECT COUNT(*)::int AS count FROM users`);
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
    await fsp.writeFile(BOOTSTRAP_ADMIN_FILE, `Bootstrap admin created
username=${DEFAULT_ADMIN_USERNAME}
email=${DEFAULT_ADMIN_EMAIL}
password=${bootstrapPassword}
`, 'utf8');
    console.warn(`Bootstrap admin created. Credentials stored at ${BOOTSTRAP_ADMIN_FILE}. Username=${DEFAULT_ADMIN_USERNAME}, password=${maskSecret(bootstrapPassword)}`);
  }

  const settingsCount = await one(`SELECT COUNT(*)::int AS count FROM settings`);
  if (!settingsCount || settingsCount.count === 0) {
    for (const [key, value] of Object.entries(defaultSettings)) {
      await query(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)`, [key, JSON.stringify(value)]);
    }
  }

  const categoriesCount = await one(`SELECT COUNT(*)::int AS count FROM categories`);
  if (!categoriesCount || categoriesCount.count === 0) {
    for (const category of defaultCategories()) {
      await query(`INSERT INTO categories (id, name, enabled) VALUES ($1, $2, $3)`, [category.id, category.name, category.enabled]);
    }
  }

  const articleCount = await one(`SELECT COUNT(*)::int AS count FROM articles`);
  if (!articleCount || articleCount.count === 0) {
    const seeds = [
      normalizeArticle({
        title: 'पटना में शिक्षा सुधार पर बड़ी बैठक, कई ज़िलों के लिए नई योजना',
        category: 'बिहार',
        location: 'पटना',
        author: 'डेस्क रिपोर्ट',
        summary: 'राज्य स्तर की समीक्षा में विद्यालय ढांचा, शिक्षक उपस्थिति और डिजिटल पढ़ाई पर ज़ोर दिया गया।',
        content: 'पटना में हुई उच्चस्तरीय बैठक में शिक्षा सुधार, छात्र उपस्थिति, डिजिटल लैब और शिक्षक प्रशिक्षण पर चर्चा हुई। कई ज़िलों में नई निगरानी व्यवस्था लागू करने की तैयारी बताई गई।',
        featured: true,
        trending: true
      }),
      normalizeArticle({
        title: 'झारखंड में युवा रोजगार अभियान के लिए नए कौशल केंद्र शुरू',
        category: 'झारखंड',
        location: 'रांची',
        author: 'राज्य ब्यूरो',
        summary: 'कौशल प्रशिक्षण, स्थानीय उद्योग और भर्ती समन्वय को जोड़ने की तैयारी।',
        content: 'रांची और आसपास के क्षेत्रों में नए कौशल केंद्रों की शुरुआत की गई है। लक्ष्य यह है कि स्थानीय युवाओं को उद्योग की ज़रूरत के हिसाब से प्रशिक्षण दिया जाए और भर्ती प्रक्रिया तेज हो।',
        featured: false,
        trending: true
      }),
      normalizeArticle({
        title: 'राष्ट्रीय राजनीति में आज की 10 बड़ी बातें',
        category: 'राष्ट्रीय',
        location: 'नई दिल्ली',
        author: 'नेशनल डेस्क',
        summary: 'संसद, राज्यों और नीति से जुड़ी प्रमुख हलचल पर एक नज़र।',
        content: 'राष्ट्रीय राजनीति में आज संसद की कार्यवाही, राज्य स्तरीय बैठकों और कई नई घोषणाओं ने सुर्खियां बटोरीं। पूरी रिपोर्ट में हर अहम बिंदु शामिल है।',
        featured: true,
        trending: false
      })
    ];
    for (const article of seeds) {
      await insertArticle(article);
    }
    await setSetting('heroArticleId', seeds[0].id);
  }
}

async function setSetting(key, value) {
  await query(`
    INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `, [key, JSON.stringify(value)]);
}
async function getSettings() {
  const rows = await many(`SELECT key, value FROM settings`);
  const settings = { ...defaultSettings };
  for (const row of rows) settings[row.key] = row.value;
  settings.visibleSections = { ...defaultSettings.visibleSections, ...(settings.visibleSections || {}) };
  return settings;
}
async function listCategories(includeDisabled = true) {
  const rows = await many(`SELECT id, name, enabled FROM categories ORDER BY name ASC`);
  const items = rows.map((row) => ({ id: row.id, name: row.name, enabled: row.enabled }));
  return includeDisabled ? items : items.filter((item) => item.enabled);
}
async function listArticles() {
  const rows = await many(`SELECT id, category, published_at, featured, trending, data FROM articles ORDER BY published_at DESC`);
  return rows.map((row) => ({ id: row.id, category: row.category, publishedAt: new Date(row.published_at).toISOString(), featured: row.featured, trending: row.trending, ...row.data }));
}
async function listReporters() {
  const rows = await many(`SELECT id, full_name, district, state, status, join_date, data FROM reporters ORDER BY full_name ASC`);
  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    district: row.district,
    state: row.state,
    status: row.status,
    joinDate: row.join_date ? new Date(row.join_date).toISOString().slice(0, 10) : '',
    ...row.data
  }));
}
async function listPayments() {
  const rows = await many(`SELECT id, reporter_id, date, type, status, amount, data FROM payments ORDER BY date DESC, id DESC`);
  return rows.map((row) => ({
    id: row.id,
    reporterId: row.reporter_id,
    date: row.date ? new Date(row.date).toISOString().slice(0, 10) : '',
    type: row.type,
    status: row.status,
    amount: Number(row.amount),
    ...row.data
  }));
}
async function listUsers(includeSecrets = false) {
  const rows = await many(`
    SELECT id, username, email, full_name, role, active, require_password_change, password_changed_at,
           failed_login_count, locked_until, last_login_at, totp_enabled, created_at
           ${includeSecrets ? ', password_hash, totp_secret' : ''}
    FROM users
    ORDER BY created_at ASC
  `);
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    email: row.email || '',
    fullName: row.full_name,
    role: row.role,
    active: row.active,
    requirePasswordChange: row.require_password_change,
    passwordChangedAt: row.password_changed_at ? new Date(row.password_changed_at).toISOString() : '',
    failedLoginCount: Number(row.failed_login_count || 0),
    lockedUntil: row.locked_until ? new Date(row.locked_until).toISOString() : '',
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : '',
    totpEnabled: row.totp_enabled,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : '',
    ...(includeSecrets ? { passwordHash: row.password_hash, totpSecret: row.totp_secret || '' } : {})
  }));
}
async function findUserByUsername(username, includeSecrets = true) {
  const fieldExtra = includeSecrets ? ', password_hash, totp_secret' : '';
  const row = await one(`
    SELECT id, username, email, full_name, role, active, require_password_change, password_changed_at,
           failed_login_count, locked_until, last_login_at, totp_enabled, created_at
           ${fieldExtra}
    FROM users WHERE username = $1
  `, [String(username || '').toLowerCase()]);
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email || '',
    fullName: row.full_name,
    role: row.role,
    active: row.active,
    requirePasswordChange: row.require_password_change,
    passwordChangedAt: row.password_changed_at ? new Date(row.password_changed_at).toISOString() : '',
    failedLoginCount: Number(row.failed_login_count || 0),
    lockedUntil: row.locked_until ? new Date(row.locked_until).toISOString() : '',
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : '',
    totpEnabled: row.totp_enabled,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : '',
    ...(includeSecrets ? { passwordHash: row.password_hash, totpSecret: row.totp_secret || '' } : {})
  };
}
async function findUserById(id, includeSecrets = false) {
  const fieldExtra = includeSecrets ? ', password_hash, totp_secret' : '';
  const row = await one(`
    SELECT id, username, email, full_name, role, active, require_password_change, password_changed_at,
           failed_login_count, locked_until, last_login_at, totp_enabled, created_at
           ${fieldExtra}
    FROM users WHERE id = $1
  `, [id]);
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email || '',
    fullName: row.full_name,
    role: row.role,
    active: row.active,
    requirePasswordChange: row.require_password_change,
    passwordChangedAt: row.password_changed_at ? new Date(row.password_changed_at).toISOString() : '',
    failedLoginCount: Number(row.failed_login_count || 0),
    lockedUntil: row.locked_until ? new Date(row.locked_until).toISOString() : '',
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : '',
    totpEnabled: row.totp_enabled,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : '',
    ...(includeSecrets ? { passwordHash: row.password_hash, totpSecret: row.totp_secret || '' } : {})
  };
}
async function listAuditLogs(limit = AUDIT_LOG_LIMIT) {
  const rows = await many(`SELECT id, at, actor_user_id, actor_username, action, target_type, target_id, details, ip FROM audit_logs ORDER BY at DESC LIMIT $1`, [limit]);
  return rows.map((row) => ({
    id: row.id,
    at: new Date(row.at).toISOString(),
    actorUserId: row.actor_user_id || '',
    actorUsername: row.actor_username || '',
    action: row.action,
    targetType: row.target_type || '',
    targetId: row.target_id || '',
    details: row.details || '',
    ip: row.ip || ''
  }));
}
async function addAuditLog(req, action, targetType = '', targetId = '', details = '') {
  const actorUserId = req?.currentUser?.id || req?.session?.userId || '';
  const actorUsername = req?.currentUser?.username || req?.session?.username || 'system';
  await query(`
    INSERT INTO audit_logs (id, actor_user_id, actor_username, action, target_type, target_id, details, ip)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [
    crypto.randomUUID(),
    actorUserId,
    actorUsername,
    sanitizeText(action, 'unknown', 120),
    sanitizeText(targetType, '', 40),
    sanitizeText(targetId, '', 64),
    sanitizeParagraph(details, '', 320),
    sanitizeText(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '', '', 120)
  ]);
}
async function loadSnapshot(user) {
  const [settings, categories, articles, reporters, payments] = await Promise.all([
    getSettings(),
    listCategories(true),
    listArticles(),
    hasPermission(user, 'reporters.read') ? listReporters() : Promise.resolve([]),
    hasPermission(user, 'payments.read') ? listPayments() : Promise.resolve([])
  ]);
  const payload = { settings, categories, articles, reporters, payments };
  if (hasPermission(user, 'users.manage')) payload.users = await listUsers(false);
  else payload.users = [];
  payload.auditLogs = hasPermission(user, 'users.manage') ? await listAuditLogs() : [];
  return payload;
}
async function insertArticle(article) {
  const data = { ...article };
  delete data.id; delete data.category; delete data.publishedAt; delete data.featured; delete data.trending;
  await query(`
    INSERT INTO articles (id, category, published_at, featured, trending, data)
    VALUES ($1, $2, $3::timestamptz, $4, $5, $6::jsonb)
  `, [article.id, article.category, article.publishedAt, article.featured, article.trending, JSON.stringify(data)]);
}
async function updateArticle(article) {
  const data = { ...article };
  delete data.id; delete data.category; delete data.publishedAt; delete data.featured; delete data.trending;
  await query(`
    UPDATE articles
    SET category = $2, published_at = $3::timestamptz, featured = $4, trending = $5, data = $6::jsonb
    WHERE id = $1
  `, [article.id, article.category, article.publishedAt, article.featured, article.trending, JSON.stringify(data)]);
}
async function insertReporter(reporter) {
  const data = { ...reporter };
  delete data.id; delete data.fullName; delete data.district; delete data.state; delete data.status; delete data.joinDate;
  await query(`
    INSERT INTO reporters (id, full_name, district, state, status, join_date, data)
    VALUES ($1, $2, $3, $4, $5, $6::date, $7::jsonb)
  `, [reporter.id, reporter.fullName, reporter.district, reporter.state, reporter.status, reporter.joinDate, JSON.stringify(data)]);
}
async function updateReporter(reporter) {
  const data = { ...reporter };
  delete data.id; delete data.fullName; delete data.district; delete data.state; delete data.status; delete data.joinDate;
  await query(`
    UPDATE reporters SET full_name=$2, district=$3, state=$4, status=$5, join_date=$6::date, data=$7::jsonb WHERE id=$1
  `, [reporter.id, reporter.fullName, reporter.district, reporter.state, reporter.status, reporter.joinDate, JSON.stringify(data)]);
}
async function insertPayment(payment) {
  const data = { ...payment };
  delete data.id; delete data.reporterId; delete data.date; delete data.type; delete data.status; delete data.amount;
  await query(`
    INSERT INTO payments (id, reporter_id, date, type, status, amount, data)
    VALUES ($1, $2, $3::date, $4, $5, $6, $7::jsonb)
  `, [payment.id, payment.reporterId, payment.date, payment.type, payment.status, payment.amount, JSON.stringify(data)]);
}
async function updatePayment(payment) {
  const data = { ...payment };
  delete data.id; delete data.reporterId; delete data.date; delete data.type; delete data.status; delete data.amount;
  await query(`
    UPDATE payments SET reporter_id=$2, date=$3::date, type=$4, status=$5, amount=$6, data=$7::jsonb WHERE id=$1
  `, [payment.id, payment.reporterId, payment.date, payment.type, payment.status, payment.amount, JSON.stringify(data)]);
}
async function buildBackupJson() {
  return {
    exportedAt: new Date().toISOString(),
    settings: await getSettings(),
    categories: await listCategories(true),
    articles: await listArticles(),
    reporters: await listReporters(),
    payments: await listPayments(),
    users: await listUsers(false),
    auditLogs: await listAuditLogs(1000)
  };
}
async function issueCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  return req.session.csrfToken;
}
function requireCsrf(req, res, next) {
  const token = req.get('x-csrf-token') || req.body?.csrfToken || '';
  if (!req.session?.csrfToken || token !== req.session.csrfToken) {
    return res.status(403).json({ message: 'Invalid CSRF token' });
  }
  next();
}
async function resolveCurrentUser(req) {
  if (!req.session?.userId) return null;
  return findUserById(req.session.userId, false);
}
async function requireAuth(req, res, next) {
  try {
    const user = await resolveCurrentUser(req);
    if (!user || !user.active) return res.status(401).json({ message: 'Authentication required' });
    req.currentUser = user;
    next();
  } catch (error) {
    next(error);
  }
}
function requirePermission(permission) {
  return async (req, res, next) => {
    try {
      const user = req.currentUser || await resolveCurrentUser(req);
      if (!user || !user.active) return res.status(401).json({ message: 'Authentication required' });
      if (!hasPermission(user, permission)) return res.status(403).json({ message: 'Permission denied' });
      req.currentUser = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}
function issueSessionUser(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      resolve();
    });
  });
}
async function createPendingPreAuth(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const payload = JSON.stringify({ userId });
  if (redisAvailable) {
    await redisClient.set(`preauth:${token}`, payload, { EX: PREAUTH_TTL_SEC });
  } else {
    localPreAuthStore.set(token, { payload, expiresAt: Date.now() + PREAUTH_TTL_SEC * 1000 });
  }
  return token;
}
async function consumePendingPreAuth(token) {
  const key = `preauth:${token}`;
  if (redisAvailable) {
    const raw = await redisClient.get(key);
    if (!raw) return null;
    await redisClient.del(key);
    try { return JSON.parse(raw); } catch { return null; }
  }
  const entry = localPreAuthStore.get(token);
  if (!entry) return null;
  localPreAuthStore.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  try { return JSON.parse(entry.payload); } catch { return null; }
}
async function sendMail({ to, subject, text, html }) {
  const smtpHost = process.env.SMTP_HOST;
  if (!smtpHost) {
    const line = `\n[${new Date().toISOString()}] TO:${to}\nSUBJECT:${subject}\n${text}\n`;
    await fsp.appendFile(MAILBOX_LOG, line, 'utf8');
    return { queued: true, preview: `local-log:${MAILBOX_LOG}` };
  }
  const transport = nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined
  });
  await transport.sendMail({
    from: process.env.SMTP_FROM || DEFAULT_ADMIN_EMAIL,
    to,
    subject,
    text,
    html
  });
  return { queued: true };
}
function printShell(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="hi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  body{font-family:Arial,Helvetica,sans-serif;background:#f6f4ef;color:#111;margin:0;padding:24px}
  .card{max-width:880px;margin:0 auto;background:#fff;border:1px solid #ddd;padding:24px}
  h1,h2,h3,p{margin:0 0 12px}
  .row{display:flex;gap:24px;flex-wrap:wrap}
  .col{flex:1 1 260px}
  .photo{width:140px;height:170px;object-fit:cover;border:1px solid #bbb;background:#eee}
  .meta{padding:12px;background:#fafafa;border:1px solid #eee}
  .id-card{width:360px;border:2px solid #b30f17;border-radius:16px;padding:18px;background:#fff}
  .id-top{display:flex;gap:12px;align-items:center;margin-bottom:16px}
  .seal{font-weight:800;color:#b30f17}
  .muted{color:#555}
  .signature{margin-top:32px;border-top:1px solid #999;padding-top:8px;width:220px}
  @media print{body{background:#fff;padding:0}.card{border:none;max-width:none}}
  </style></head><body>${bodyHtml}</body></html>`;
}

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'namo-bharat-news24', env: NODE_ENV, uptimeSec: Math.round(process.uptime()), startedAt: STARTED_AT.toISOString() });
});

app.get('/readyz', async (req, res) => {
  if (!isReady) return res.status(503).json({ ok: false, checks: { app: 'starting' } });
  try {
    await pool.query('SELECT 1');
    const checks = { app: 'ready', postgres: 'ok', redis: 'optional-offline' };
    if (redisAvailable) {
      const pong = await redisClient.ping();
      checks.redis = pong;
      return res.json({ ok: pong === 'PONG', checks });
    }
    return res.json({ ok: !REDIS_REQUIRED, checks });
  } catch (error) {
    return res.status(503).json({ ok: false, checks: { app: 'degraded' }, message: error?.message || 'dependency check failed' });
  }
});
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/favicon.ico', async (_req, res) => {
  try {
    const settings = await getSettings();
    const iconPath = sanitizeImageUrl(settings.favicon || settings.logo, '');
    if (!iconPath || !iconPath.startsWith('/uploads/')) return res.status(204).end();
    const absolutePath = path.join(UPLOAD_DIR, path.basename(iconPath));
    if (!fs.existsSync(absolutePath)) return res.status(404).end();
    return res.sendFile(absolutePath);
  } catch (_error) {
    return res.status(404).end();
  }
});

app.get('/api/site', async (req, res) => {
  try {
    const [settings, categories, articles] = await Promise.all([getSettings(), listCategories(false), listArticles()]);
    res.json({ settings, categories, articles });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to load site data', requestId: req.requestId });
  }
});

app.post('/api/assistant/public', sensitiveLimiter, async (req, res) => {
  try {
    const reply = await buildPublicAssistantReply(req.body?.message || '');
    res.json({ ok: true, reply });
  } catch (_error) {
    res.status(500).json({ message: 'Assistant failed' });
  }
});

app.get('/api/admin/session', async (req, res) => {
  try {
    const user = await resolveCurrentUser(req);
    if (!user || !user.active) return res.json({ authenticated: false, csrfToken: await issueCsrfToken(req) });
    req.currentUser = user;
    res.json({
      authenticated: true,
      csrfToken: await issueCsrfToken(req),
      passwordNeedsRotation: Boolean(user.requirePasswordChange),
      user: { id: user.id, username: user.username, email: user.email, fullName: user.fullName, role: user.role, totpEnabled: user.totpEnabled },
      permissions: permissionsForRole(user.role)
    });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to read session' });
  }
});

app.post('/api/login', loginLimiter, async (req, res, next) => {
  try {
    const username = sanitizeText(req.body.username, '', 40).toLowerCase();
    const password = String(req.body.password || '');
    const totp = sanitizeText(req.body.totp, '', 20);
    const preAuthToken = sanitizeText(req.body.preAuthToken, '', 120);

    if (preAuthToken) {
      const pending = await consumePendingPreAuth(preAuthToken);
      if (!pending?.userId) return res.status(401).json({ message: '2FA session expired. Please login again.' });
      const user = await findUserById(pending.userId, true);
      if (!user || !user.active || !user.totpEnabled || !user.totpSecret) {
        return res.status(401).json({ message: '2FA verification failed' });
      }
      const validTotp = authenticator.verify({ token: totp, secret: user.totpSecret });
      if (!validTotp) {
        await addAuditLog(req, 'auth.2fa_failed', 'user', user.id, 'Incorrect TOTP token');
        return res.status(401).json({ message: 'Invalid 2FA code' });
      }
      await issueSessionUser(req, user);
      req.currentUser = user;
      const csrfToken = await issueCsrfToken(req);
      await addAuditLog(req, 'auth.login_success', 'user', user.id, 'Login successful with 2FA');
      return res.json({
        ok: true,
        csrfToken,
        passwordNeedsRotation: Boolean(user.requirePasswordChange),
        user: { id: user.id, username: user.username, email: user.email, fullName: user.fullName, role: user.role, totpEnabled: true },
        permissions: permissionsForRole(user.role)
      });
    }

    const user = await findUserByUsername(username, true);
    if (!user || !user.active) {
      await addAuditLog(req, 'auth.login_failed', 'user', username, 'Unknown or inactive user');
      return res.status(401).json({ message: 'Invalid username or password' });
    }
    const now = Date.now();
    if (user.lockedUntil && new Date(user.lockedUntil).getTime() > now) {
      return res.status(423).json({ message: 'Account temporarily locked. Try again later.' });
    }
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      const failedCount = Number(user.failedLoginCount || 0) + 1;
      const lockIso = failedCount >= MAX_LOGIN_FAILURES ? new Date(now + LOCK_WINDOW_MS).toISOString() : null;
      await query(`UPDATE users SET failed_login_count=$2, locked_until=$3::timestamptz WHERE id=$1`, [user.id, lockIso ? 0 : failedCount, lockIso]);
      await addAuditLog(req, 'auth.login_failed', 'user', user.id, 'Incorrect password');
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    if (user.totpEnabled && user.totpSecret) {
      const token = await createPendingPreAuth(user.id);
      await addAuditLog(req, 'auth.2fa_challenge', 'user', user.id, 'Password verified, waiting for TOTP');
      return res.json({ requiresTwoFactor: true, preAuthToken: token, message: 'Enter your 2FA code to continue.' });
    }

    await query(`UPDATE users SET failed_login_count=0, locked_until=NULL, last_login_at=now() WHERE id=$1`, [user.id]);
    await issueSessionUser(req, user);
    req.currentUser = user;
    const csrfToken = await issueCsrfToken(req);
    await addAuditLog(req, 'auth.login_success', 'user', user.id, 'Login successful');
    res.json({
      ok: true,
      csrfToken,
      passwordNeedsRotation: Boolean(user.requirePasswordChange),
      user: { id: user.id, username: user.username, email: user.email, fullName: user.fullName, role: user.role, totpEnabled: user.totpEnabled },
      permissions: permissionsForRole(user.role)
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/logout', requireAuth, async (req, res, next) => {
  try {
    await addAuditLog(req, 'auth.logout', 'user', req.currentUser.id, 'Logout');
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie(SESSION_COOKIE_NAME);
      res.json({ ok: true, requestId: req?.requestId || undefined });
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/request-password-reset', sensitiveLimiter, async (req, res) => {
  try {
    const identity = sanitizeText(req.body.identity, '', 120).toLowerCase();
    const user = (await one(`
      SELECT id, username, email, full_name, active FROM users
      WHERE lower(username) = $1 OR lower(coalesce(email, '')) = $1
      LIMIT 1
    `, [identity]));
    if (user && user.active && user.email) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = await sha256(rawToken);
      await query(`DELETE FROM password_reset_tokens WHERE user_id = $1 OR expires_at < now()`, [user.id]);
      await query(`
        INSERT INTO password_reset_tokens (token_hash, user_id, expires_at)
        VALUES ($1, $2, now() + interval '30 minutes')
      `, [tokenHash, user.id]);
      const resetUrl = `${APP_URL}/admin?reset_token=${encodeURIComponent(rawToken)}`;
      await sendMail({
        to: user.email,
        subject: `${APP_NAME} password reset`,
        text: `Hello ${sanitizeText(user.full_name, 'User', 80)},\n\nUse this link to reset your password: ${resetUrl}\n\nThis link expires in 30 minutes.`,
        html: `<p>Hello ${escapeHtml(user.full_name)},</p><p>Use this link to reset your password:</p><p><a href="${escapeHtml(resetUrl)}">${escapeHtml(resetUrl)}</a></p><p>This link expires in 30 minutes.</p>`
      });
      await addAuditLog(req, 'auth.password_reset_requested', 'user', user.id, 'Password reset mail queued');
      return res.json({ ok: true, message: 'If the account exists, reset instructions have been sent.', ...(IS_PROD ? {} : { devResetUrl: resetUrl }) });
    }
    res.json({ ok: true, message: 'If the account exists, reset instructions have been sent.' });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to request password reset' });
  }
});

app.post('/api/auth/reset-password', sensitiveLimiter, async (req, res) => {
  try {
    const token = sanitizeText(req.body.token, '', 120);
    const newPassword = String(req.body.newPassword || '');
    if (!token) return res.status(400).json({ message: 'Reset token is required' });
    if (!hasStrongPassword(newPassword)) return res.status(400).json({ message: 'Password must be at least 10 characters and include uppercase, lowercase, number and symbol' });

    const tokenHash = await sha256(token);
    const row = await one(`
      SELECT prt.user_id, u.username
      FROM password_reset_tokens prt
      JOIN users u ON u.id = prt.user_id
      WHERE prt.token_hash = $1
        AND prt.used_at IS NULL
        AND prt.expires_at > now()
      LIMIT 1
    `, [tokenHash]);
    if (!row) return res.status(400).json({ message: 'Reset token is invalid or expired' });

    const passwordHash = await hashPassword(newPassword);
    await query(`
      UPDATE users
      SET password_hash = $2, require_password_change = FALSE, password_changed_at = now(),
          failed_login_count = 0, locked_until = NULL
      WHERE id = $1
    `, [row.user_id, passwordHash]);
    await query(`UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1`, [tokenHash]);
    await addAuditLog(req, 'auth.password_reset_completed', 'user', row.user_id, 'Password reset completed');
    res.json({ ok: true, requestId: req?.requestId || undefined });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to reset password' });
  }
});

app.post('/api/auth/change-password', requireAuth, requireCsrf, sensitiveLimiter, async (req, res) => {
  try {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');
    const totp = sanitizeText(req.body.totp, '', 20);
    const fullUser = await findUserById(req.currentUser.id, true);
    const validCurrentPassword = await verifyPassword(currentPassword, fullUser.passwordHash);
    if (!validCurrentPassword) return res.status(400).json({ message: 'Current password is incorrect' });
    if (fullUser.totpEnabled && fullUser.totpSecret && !authenticator.verify({ token: totp, secret: fullUser.totpSecret })) {
      return res.status(400).json({ message: 'Valid 2FA code required' });
    }
    if (!hasStrongPassword(newPassword)) return res.status(400).json({ message: 'New password must be at least 10 characters and include uppercase, lowercase, number and symbol' });

    const passwordHash = await hashPassword(newPassword);
    await query(`
      UPDATE users SET password_hash = $2, require_password_change = FALSE, password_changed_at = now(),
                       failed_login_count = 0, locked_until = NULL
      WHERE id = $1
    `, [fullUser.id, passwordHash]);
    await addAuditLog(req, 'auth.password_changed', 'user', fullUser.id, 'Self password change');
    res.json({ ok: true, requestId: req?.requestId || undefined });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to change password' });
  }
});

app.get('/api/auth/setup-2fa', requireAuth, sensitiveLimiter, async (req, res) => {
  try {
    const user = await findUserById(req.currentUser.id, true);
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(user.username, APP_NAME, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauth);
    req.session.pendingTotpSecret = secret;
    res.json({ ok: true, secret, qrDataUrl, manualCode: secret, issuer: APP_NAME });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to prepare 2FA setup' });
  }
});

app.post('/api/auth/enable-2fa', requireAuth, requireCsrf, sensitiveLimiter, async (req, res) => {
  try {
    const token = sanitizeText(req.body.token, '', 20);
    const secret = req.session.pendingTotpSecret || '';
    if (!secret) return res.status(400).json({ message: 'No 2FA setup in progress' });
    const valid = authenticator.verify({ token, secret });
    if (!valid) return res.status(400).json({ message: 'Invalid verification code' });
    await query(`UPDATE users SET totp_enabled = TRUE, totp_secret = $2 WHERE id = $1`, [req.currentUser.id, secret]);
    req.session.pendingTotpSecret = null;
    await addAuditLog(req, 'auth.2fa_enabled', 'user', req.currentUser.id, '2FA enabled');
    res.json({ ok: true, requestId: req?.requestId || undefined });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to enable 2FA' });
  }
});

app.post('/api/auth/disable-2fa', requireAuth, requireCsrf, sensitiveLimiter, async (req, res) => {
  try {
    const password = String(req.body.password || '');
    const token = sanitizeText(req.body.token, '', 20);
    const user = await findUserById(req.currentUser.id, true);
    const validPassword = await verifyPassword(password, user.passwordHash);
    if (!validPassword) return res.status(400).json({ message: 'Password is incorrect' });
    if (!user.totpEnabled || !user.totpSecret || !authenticator.verify({ token, secret: user.totpSecret })) {
      return res.status(400).json({ message: 'Invalid 2FA code' });
    }
    await query(`UPDATE users SET totp_enabled = FALSE, totp_secret = NULL WHERE id = $1`, [user.id]);
    await addAuditLog(req, 'auth.2fa_disabled', 'user', user.id, '2FA disabled');
    res.json({ ok: true, requestId: req?.requestId || undefined });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to disable 2FA' });
  }
});

app.post('/api/admin/assistant', requireAuth, requireCsrf, sensitiveLimiter, async (req, res) => {
  try {
    const reply = await buildAdminAssistantReply(req.body?.message || '', req.body?.context || {}, req.currentUser || {});
    res.json({ ok: true, reply });
  } catch (_error) {
    res.status(500).json({ message: 'Assistant failed' });
  }
});

app.get('/api/admin/site-data', requireAuth, async (req, res) => {
  try {
    const data = await loadSnapshot(req.currentUser);
    res.json({
      ...data,
      currentUser: { id: req.currentUser.id, username: req.currentUser.username, email: req.currentUser.email, fullName: req.currentUser.fullName, role: req.currentUser.role, requirePasswordChange: req.currentUser.requirePasswordChange, totpEnabled: req.currentUser.totpEnabled },
      permissions: permissionsForRole(req.currentUser.role),
      csrfToken: await issueCsrfToken(req)
    });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to load admin data' });
  }
});

app.get('/api/admin/system-status', requireAuth, requirePermission('users.manage'), async (req, res) => {
  try {
    const counts = {
      users: await one(`SELECT COUNT(*)::int AS count FROM users`),
      articles: await one(`SELECT COUNT(*)::int AS count FROM articles`),
      reporters: await one(`SELECT COUNT(*)::int AS count FROM reporters`),
      payments: await one(`SELECT COUNT(*)::int AS count FROM payments`)
    };
    res.json({
      ok: true,
      runtime: { node: process.version, env: NODE_ENV, appUrl: APP_URL },
      storage: { database: 'PostgreSQL', sessions: 'Redis', uploads: UPLOAD_DIR },
      mail: { configured: Boolean(process.env.SMTP_HOST), devLog: MAILBOX_LOG },
      counts: {
        users: counts.users.count,
        articles: counts.articles.count,
        reporters: counts.reporters.count,
        payments: counts.payments.count
      }
    });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to read system status' });
  }
});

app.get('/api/admin/backup.json', requireAuth, requirePermission('users.manage'), async (req, res) => {
  try {
    const dump = await buildBackupJson();
    await addAuditLog(req, 'backup.export_json', 'backup', 'json', 'JSON backup downloaded');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="namo-bharat-news24-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.end(JSON.stringify(dump, null, 2));
  } catch (_error) {
    res.status(500).json({ message: 'Failed to create backup' });
  }
});

app.put('/api/admin/site-data', requireAuth, requirePermission('content.manage'), requireCsrf, (req, _res, next) => {
  req.url = '/api/settings';
  next();
});

app.put('/api/settings', requireAuth, requirePermission('content.manage'), requireCsrf, async (req, res) => {
  try {
    const current = await getSettings();
    const incoming = req.body || {};
    const visibleSections = typeof incoming.visibleSections === 'object' && incoming.visibleSections ? incoming.visibleSections : {};
    const nextSettings = {
      ...current,
      siteName: sanitizeText(incoming.siteName, current.siteName, 80),
      tagline: sanitizeText(incoming.tagline, current.tagline, 120),
      primaryColor: sanitizeColor(incoming.primaryColor, current.primaryColor),
      backgroundColor: sanitizeColor(incoming.backgroundColor, current.backgroundColor),
      breakingText: sanitizeParagraph(incoming.breakingText, current.breakingText, 300),
      contactEmail: sanitizeEmail(incoming.contactEmail, current.contactEmail),
      footerText: sanitizeParagraph(incoming.footerText, current.footerText, 220),
      heroArticleId: sanitizeText(incoming.heroArticleId, current.heroArticleId, 64),
      selectedCity: sanitizeText(incoming.selectedCity, current.selectedCity, 40),
      editorName: sanitizeText(incoming.editorName, current.editorName, 80),
      officeAddress: sanitizeText(incoming.officeAddress, current.officeAddress, 120),
      visibleSections: { ...current.visibleSections }
    };
    for (const [key, value] of Object.entries(visibleSections)) {
      const safeKey = sanitizeText(key, '', 40);
      if (safeKey) nextSettings.visibleSections[safeKey] = Boolean(value);
    }
    for (const [key, value] of Object.entries(nextSettings)) {
      await setSetting(key, value);
    }
    await addAuditLog(req, 'settings.updated', 'settings', 'site', 'Site settings updated');
    res.json({ ok: true, settings: nextSettings });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to save settings' });
  }
});

app.post('/api/upload/logo', requireAuth, requirePermission('content.manage'), requireCsrf, sensitiveLimiter, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'Logo file is required' });
    const logo = `/uploads/${req.file.filename}`;
    await setSetting('logo', logo);
    await setSetting('favicon', logo);
    await addAuditLog(req, 'settings.logo_uploaded', 'settings', 'logo', logo);
    res.json({ ok: true, logo, url: logo, settings: await getSettings() });
  } catch (_error) {
    res.status(500).json({ message: 'Logo upload failed' });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    res.json(await listCategories(true));
  } catch (_error) {
    res.status(500).json({ message: 'Failed to load categories' });
  }
});

app.post('/api/categories', requireAuth, requirePermission('content.manage'), requireCsrf, async (req, res) => {
  try {
    const name = sanitizeText(req.body.name, '', 40);
    if (!name) return res.status(400).json({ message: 'Category name is required' });
    const duplicate = await one(`SELECT id FROM categories WHERE lower(name)=lower($1)`, [name]);
    if (duplicate) return res.status(400).json({ message: 'Category already exists' });
    const id = crypto.randomUUID();
    await query(`INSERT INTO categories (id, name, enabled) VALUES ($1, $2, TRUE)`, [id, name]);
    const settings = await getSettings();
    settings.visibleSections[name] = true;
    await setSetting('visibleSections', settings.visibleSections);
    await addAuditLog(req, 'category.created', 'category', id, name);
    res.json({ ok: true, category: { id, name, enabled: true } });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to create category' });
  }
});

app.put('/api/categories/:id', requireAuth, requirePermission('content.manage'), requireCsrf, async (req, res) => {
  try {
    const existing = await one(`SELECT id, name, enabled FROM categories WHERE id=$1`, [req.params.id]);
    if (!existing) return res.status(404).json({ message: 'Category not found' });
    const newName = sanitizeText(req.body.name, existing.name, 40);
    const enabled = req.body.enabled !== undefined ? Boolean(req.body.enabled) : existing.enabled;
    const duplicate = await one(`SELECT id FROM categories WHERE lower(name)=lower($1) AND id <> $2`, [newName, req.params.id]);
    if (duplicate) return res.status(400).json({ message: 'Category already exists' });

    await query(`UPDATE categories SET name=$2, enabled=$3 WHERE id=$1`, [req.params.id, newName, enabled]);
    if (existing.name !== newName) {
      await query(`
        UPDATE articles
        SET category = $2, data = jsonb_set(data, '{category}', to_jsonb($2::text), true)
        WHERE category = $1
      `, [existing.name, newName]);
      const settings = await getSettings();
      settings.visibleSections[newName] = settings.visibleSections[existing.name] ?? true;
      delete settings.visibleSections[existing.name];
      await setSetting('visibleSections', settings.visibleSections);
    }
    await addAuditLog(req, 'category.updated', 'category', req.params.id, `${existing.name} -> ${newName}`);
    res.json({ ok: true, category: { id: req.params.id, name: newName, enabled } });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to update category' });
  }
});

app.delete('/api/categories/:id', requireAuth, requirePermission('content.manage'), requireCsrf, async (req, res) => {
  try {
    const existing = await one(`SELECT id, name FROM categories WHERE id=$1`, [req.params.id]);
    if (!existing) return res.status(404).json({ message: 'Category not found' });
    await query(`DELETE FROM categories WHERE id=$1`, [req.params.id]);
    await query(`DELETE FROM articles WHERE category = $1`, [existing.name]);
    const settings = await getSettings();
    delete settings.visibleSections[existing.name];
    const remainingArticles = await listArticles();
    if (settings.heroArticleId && !remainingArticles.some((item) => item.id === settings.heroArticleId)) {
      settings.heroArticleId = remainingArticles[0]?.id || '';
    }
    await setSetting('visibleSections', settings.visibleSections);
    await setSetting('heroArticleId', settings.heroArticleId);
    await addAuditLog(req, 'category.deleted', 'category', req.params.id, existing.name);
    res.json({ ok: true, requestId: req?.requestId || undefined });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to delete category' });
  }
});

app.get('/api/articles', async (req, res) => {
  try {
    res.json(await listArticles());
  } catch (_error) {
    res.status(500).json({ message: 'Failed to load articles' });
  }
});

app.post('/api/articles', requireAuth, requirePermission('content.manage'), requireCsrf, sensitiveLimiter, upload.single('image'), async (req, res) => {
  try {
    const image = req.file ? `/uploads/${req.file.filename}` : '';
    const article = normalizeArticle({ ...req.body, image });
    if (!article.title || !article.content) return res.status(400).json({ message: 'Title and content are required' });
    await insertArticle(article);
    const settings = await getSettings();
    if (!settings.heroArticleId) await setSetting('heroArticleId', article.id);
    await addAuditLog(req, 'article.created', 'article', article.id, article.title);
    res.json({ ok: true, article });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to create article' });
  }
});

app.put('/api/articles/:id', requireAuth, requirePermission('content.manage'), requireCsrf, sensitiveLimiter, upload.single('image'), async (req, res) => {
  try {
    const all = await listArticles();
    const existing = all.find((item) => item.id === req.params.id);
    if (!existing) return res.status(404).json({ message: 'Article not found' });
    const article = normalizeArticle({ ...req.body, image: req.file ? `/uploads/${req.file.filename}` : existing.image }, existing);
    article.id = existing.id;
    await updateArticle(article);
    await addAuditLog(req, 'article.updated', 'article', article.id, article.title);
    res.json({ ok: true, article });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to update article' });
  }
});

app.delete('/api/articles/:id', requireAuth, requirePermission('content.manage'), requireCsrf, async (req, res) => {
  try {
    const existing = await one(`SELECT id FROM articles WHERE id=$1`, [req.params.id]);
    if (!existing) return res.status(404).json({ message: 'Article not found' });
    await query(`DELETE FROM articles WHERE id=$1`, [req.params.id]);
    const settings = await getSettings();
    if (settings.heroArticleId === req.params.id) {
      const articles = await listArticles();
      await setSetting('heroArticleId', articles[0]?.id || '');
    }
    await addAuditLog(req, 'article.deleted', 'article', req.params.id, 'Article removed');
    res.json({ ok: true, requestId: req?.requestId || undefined });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to delete article' });
  }
});

app.get('/api/reporters', requireAuth, requirePermission('reporters.read'), async (req, res) => {
  try {
    res.json(await listReporters());
  } catch (_error) {
    res.status(500).json({ message: 'Failed to load reporters' });
  }
});

app.post('/api/reporters', requireAuth, requirePermission('reporters.manage'), requireCsrf, sensitiveLimiter, upload.single('photo'), async (req, res) => {
  try {
    const reporter = normalizeReporter({ ...req.body, photo: req.file ? `/uploads/${req.file.filename}` : '' });
    if (!reporter.fullName || !reporter.designation || !reporter.district || !reporter.mobile) {
      return res.status(400).json({ message: 'Name, designation, district and mobile are required' });
    }
    await insertReporter(reporter);
    await addAuditLog(req, 'reporter.created', 'reporter', reporter.id, reporter.fullName);
    res.json({ ok: true, reporter });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to create reporter' });
  }
});

app.put('/api/reporters/:id', requireAuth, requirePermission('reporters.manage'), requireCsrf, sensitiveLimiter, upload.single('photo'), async (req, res) => {
  try {
    const all = await listReporters();
    const existing = all.find((item) => item.id === req.params.id);
    if (!existing) return res.status(404).json({ message: 'Reporter not found' });
    const reporter = normalizeReporter({ ...req.body, photo: req.file ? `/uploads/${req.file.filename}` : existing.photo }, existing);
    reporter.id = existing.id;
    await updateReporter(reporter);
    await addAuditLog(req, 'reporter.updated', 'reporter', reporter.id, reporter.fullName);
    res.json({ ok: true, reporter });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to update reporter' });
  }
});

app.delete('/api/reporters/:id', requireAuth, requirePermission('reporters.manage'), requireCsrf, async (req, res) => {
  try {
    const existing = await one(`SELECT id, full_name FROM reporters WHERE id=$1`, [req.params.id]);
    if (!existing) return res.status(404).json({ message: 'Reporter not found' });
    await query(`DELETE FROM payments WHERE reporter_id=$1`, [req.params.id]);
    await query(`DELETE FROM reporters WHERE id=$1`, [req.params.id]);
    await addAuditLog(req, 'reporter.deleted', 'reporter', req.params.id, existing.full_name);
    res.json({ ok: true, requestId: req?.requestId || undefined });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to delete reporter' });
  }
});

app.get('/api/payments', requireAuth, requirePermission('payments.read'), async (req, res) => {
  try {
    res.json(await listPayments());
  } catch (_error) {
    res.status(500).json({ message: 'Failed to load payments' });
  }
});

app.post('/api/payments', requireAuth, requirePermission('payments.manage'), requireCsrf, async (req, res) => {
  try {
    const payment = normalizePayment(req.body);
    const reporter = await one(`SELECT id FROM reporters WHERE id=$1`, [payment.reporterId]);
    if (!reporter) return res.status(400).json({ message: 'Valid reporter is required' });
    if (!payment.amount || payment.amount <= 0) return res.status(400).json({ message: 'Valid amount is required' });
    await insertPayment(payment);
    await addAuditLog(req, 'payment.created', 'payment', payment.id, `${escapeHtml(payment.type)} ${payment.amount}`);
    res.json({ ok: true, payment });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to create payment' });
  }
});

app.put('/api/payments/:id', requireAuth, requirePermission('payments.manage'), requireCsrf, async (req, res) => {
  try {
    const all = await listPayments();
    const existing = all.find((item) => item.id === req.params.id);
    if (!existing) return res.status(404).json({ message: 'Payment not found' });
    const payment = normalizePayment(req.body, existing);
    const reporter = await one(`SELECT id FROM reporters WHERE id=$1`, [payment.reporterId]);
    if (!reporter) return res.status(400).json({ message: 'Valid reporter is required' });
    if (!payment.amount || payment.amount <= 0) return res.status(400).json({ message: 'Valid amount is required' });
    payment.id = existing.id;
    await updatePayment(payment);
    await addAuditLog(req, 'payment.updated', 'payment', payment.id, `${escapeHtml(payment.type)} ${payment.amount}`);
    res.json({ ok: true, payment });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to update payment' });
  }
});

app.delete('/api/payments/:id', requireAuth, requirePermission('payments.manage'), requireCsrf, async (req, res) => {
  try {
    const existing = await one(`SELECT id FROM payments WHERE id=$1`, [req.params.id]);
    if (!existing) return res.status(404).json({ message: 'Payment not found' });
    await query(`DELETE FROM payments WHERE id=$1`, [req.params.id]);
    await addAuditLog(req, 'payment.deleted', 'payment', req.params.id, 'Payment removed');
    res.json({ ok: true, requestId: req?.requestId || undefined });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to delete payment' });
  }
});

app.get('/api/admin/users', requireAuth, requirePermission('users.manage'), async (req, res) => {
  try {
    res.json(await listUsers(false));
  } catch (_error) {
    res.status(500).json({ message: 'Failed to load users' });
  }
});

app.post('/api/admin/users', requireAuth, requirePermission('users.manage'), requireCsrf, sensitiveLimiter, async (req, res) => {
  try {
    const username = sanitizeText(req.body.username, '', 40).toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
    const email = sanitizeEmail(req.body.email, '');
    const fullName = sanitizeText(req.body.fullName, '', 80);
    const role = sanitizeRole(req.body.role, 'viewer');
    const password = String(req.body.password || '');
    const active = req.body.active !== false && String(req.body.active).toLowerCase() !== 'false';
    if (!username || !fullName || !email) return res.status(400).json({ message: 'Username, full name and email are required' });
    if (!hasStrongPassword(password)) return res.status(400).json({ message: 'Strong password required' });
    const duplicate = await one(`SELECT id FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($2)`, [username, email]);
    if (duplicate) return res.status(400).json({ message: 'Username or email already exists' });
    const passwordHash = await hashPassword(password);
    const id = crypto.randomUUID();
    await query(`
      INSERT INTO users (id, username, email, full_name, role, active, password_hash, require_password_change, password_changed_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, now())
    `, [id, username, email, fullName, role, active, passwordHash]);
    await addAuditLog(req, 'user.created', 'user', id, username);
    res.json({ ok: true, user: await findUserById(id, false) });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to create user' });
  }
});

app.put('/api/admin/users/:id', requireAuth, requirePermission('users.manage'), requireCsrf, async (req, res) => {
  try {
    const existing = await findUserById(req.params.id, false);
    if (!existing) return res.status(404).json({ message: 'User not found' });
    const fullName = sanitizeText(req.body.fullName, existing.fullName, 80);
    const email = sanitizeEmail(req.body.email, existing.email || '');
    const role = sanitizeRole(req.body.role, existing.role);
    const active = req.body.active !== undefined ? Boolean(req.body.active) : existing.active;
    await query(`
      UPDATE users SET full_name=$2, email=$3, role=$4, active=$5 WHERE id=$1
    `, [existing.id, fullName, email, role, active]);
    await addAuditLog(req, 'user.updated', 'user', existing.id, existing.username);
    res.json({ ok: true, user: await findUserById(existing.id, false) });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to update user' });
  }
});

app.post('/api/admin/users/:id/reset-password', requireAuth, requirePermission('users.manage'), requireCsrf, sensitiveLimiter, async (req, res) => {
  try {
    const existing = await findUserById(req.params.id, false);
    if (!existing) return res.status(404).json({ message: 'User not found' });
    const newPassword = String(req.body.newPassword || '');
    if (!hasStrongPassword(newPassword)) return res.status(400).json({ message: 'Strong password required' });
    const passwordHash = await hashPassword(newPassword);
    await query(`
      UPDATE users
      SET password_hash=$2, require_password_change=TRUE, password_changed_at=now(),
          failed_login_count=0, locked_until=NULL, totp_enabled=FALSE, totp_secret=NULL
      WHERE id=$1
    `, [existing.id, passwordHash]);
    await addAuditLog(req, 'user.password_reset_by_admin', 'user', existing.id, existing.username);
    res.json({ ok: true, requestId: req?.requestId || undefined });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to reset password' });
  }
});

app.delete('/api/admin/users/:id', requireAuth, requirePermission('users.manage'), requireCsrf, async (req, res) => {
  try {
    if (req.currentUser.id === req.params.id) return res.status(400).json({ message: 'You cannot delete your own account' });
    const existing = await findUserById(req.params.id, false);
    if (!existing) return res.status(404).json({ message: 'User not found' });
    await query(`DELETE FROM users WHERE id=$1`, [req.params.id]);
    await addAuditLog(req, 'user.deleted', 'user', req.params.id, existing.username);
    res.json({ ok: true, requestId: req?.requestId || undefined });
  } catch (_error) {
    res.status(500).json({ message: 'Failed to delete user' });
  }
});

app.get('/admin/reporter/:id/joining-letter', requireAuth, requirePermission('reporters.read'), async (req, res) => {
  const reporters = await listReporters();
  const reporter = reporters.find((item) => item.id === req.params.id);
  if (!reporter) return res.status(404).send('Reporter not found');
  const settings = await getSettings();
  const html = printShell(`Joining Letter - ${escapeHtml(reporter.fullName)}`, `
    <div class="card">
      <h1>${escapeHtml(settings.siteName)}</h1>
      <p class="muted">${escapeHtml(settings.officeAddress)} | ${escapeHtml(settings.contactEmail)}</p>
      <hr>
      <h2>नियुक्ति पत्र / Joining Letter</h2>
      <p>पत्र संख्या: <strong>${escapeHtml(reporter.letterNo)}</strong></p>
      <p>दिनांक: <strong>${escapeHtml(reporter.joinDate)}</strong></p>
      <p>प्रिय <strong>${escapeHtml(reporter.fullName)}</strong>,</p>
      <p>आपको <strong>${escapeHtml(reporter.designation)}</strong> के रूप में ${escapeHtml(reporter.district)}, ${escapeHtml(reporter.state)} क्षेत्र के लिए नियुक्त किया जाता है। आप संस्था की संपादकीय नीति, कानूनी दिशानिर्देश और रिपोर्टिंग अनुशासन का पालन करेंगे।</p>
      <p>आपकी नियुक्ति स्थिति: <strong>${escapeHtml(reporter.status)}</strong></p>
      <div class="signature">अधिकृत हस्ताक्षर<br>${escapeHtml(settings.editorName)}</div>
    </div>
  `);
  res.send(html);
});

app.get('/admin/reporter/:id/id-card', requireAuth, requirePermission('reporters.read'), async (req, res) => {
  const reporters = await listReporters();
  const reporter = reporters.find((item) => item.id === req.params.id);
  if (!reporter) return res.status(404).send('Reporter not found');
  const settings = await getSettings();
  const html = printShell(`ID Card - ${escapeHtml(reporter.fullName)}`, `
    <div class="card"><div class="id-card">
      <div class="id-top">
        ${settings.logo ? `<img src="${safeImageUrl(settings.logo)}" alt="logo" style="width:56px;height:56px;border-radius:50%;object-fit:cover;">` : `<div style="width:56px;height:56px;border-radius:50%;background:#b30f17;color:#fff;display:grid;place-items:center;font-weight:800;">NB</div>`}
        <div><div class="seal">${escapeHtml(settings.siteName)}</div><div class="muted">${escapeHtml(settings.tagline)}</div></div>
      </div>
      <div class="row">
        <div class="col">
          ${reporter.photo ? `<img class="photo" src="${safeImageUrl(reporter.photo)}" alt="photo">` : `<div class="photo"></div>`}
        </div>
        <div class="col">
          <h2>${escapeHtml(reporter.fullName)}</h2>
          <p><strong>${escapeHtml(reporter.designation)}</strong></p>
          <p>ID No: <strong>${escapeHtml(reporter.idCardNo)}</strong></p>
          <p>District: <strong>${escapeHtml(reporter.district)}</strong></p>
          <p>State: <strong>${escapeHtml(reporter.state)}</strong></p>
          <p>Mobile: <strong>${escapeHtml(reporter.mobile)}</strong></p>
        </div>
      </div>
    </div></div>
  `);
  res.send(html);
});

app.get('/admin/payment/:id/receipt', requireAuth, requirePermission('payments.read'), async (req, res) => {
  const payments = await listPayments();
  const reporters = await listReporters();
  const payment = payments.find((item) => item.id === req.params.id);
  if (!payment) return res.status(404).send('Payment not found');
  const reporter = reporters.find((item) => item.id === payment.reporterId);
  const settings = await getSettings();
  const html = printShell(`Payment Receipt - ${escapeHtml(payment.id)}`, `
    <div class="card">
      <h1>${escapeHtml(settings.siteName)}</h1>
      <p class="muted">Payment Receipt</p>
      <div class="meta">
        <p>Receipt ID: <strong>${escapeHtml(payment.id)}</strong></p>
        <p>Date: <strong>${escapeHtml(payment.date)}</strong></p>
        <p>Reporter: <strong>${escapeHtml(reporter?.fullName || 'Unknown')}</strong></p>
        <p>Type: <strong>${escapeHtml(payment.type)}</strong></p>
        <p>Mode: <strong>${escapeHtml(payment.mode)}</strong></p>
        <p>Status: <strong>${escapeHtml(payment.status)}</strong></p>
        <p>Amount: <strong>₹${Number(payment.amount || 0).toFixed(2)}</strong></p>
        <p>Reference: <strong>${escapeHtml(payment.reference || '-')}</strong></p>
      </div>
      <div class="signature">Accounts Approval<br>${escapeHtml(settings.editorName)}</div>
    </div>
  `);
  res.send(html);
});

app.use((error, req, res, _next) => {
  console.error(`[${req?.requestId || 'n/a'}]`, error?.stack || error);
  if (res.headersSent) return;
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: `Upload too large. Max ${MAX_IMAGE_SIZE / ONE_MB} MB.`, requestId: req?.requestId || '' });
    }
    return res.status(400).json({ message: error.message, requestId: req?.requestId || '' });
  }
  if (String(error?.message || '').includes('Only PNG')) {
    return res.status(400).json({ message: error.message, requestId: req?.requestId || '' });
  }
  const status = error?.statusCode || error?.status || 500;
  const message = status >= 500 ? 'Internal server error' : (error?.message || 'Request failed');
  res.status(status).json({ message, requestId: req?.requestId || '' });
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

async function start() {
  if (REDIS_REQUIRED) {
    await redisClient.connect();
    redisAvailable = true;
  } else {
    try {
      await redisClient.connect();
      redisAvailable = true;
      console.log('Redis connected.');
    } catch (error) {
      redisAvailable = false;
      console.warn(`Redis unavailable, using in-memory sessions/preauth in ${NODE_ENV}: ${error.message}`);
    }
  }
  await migrate();
  const server = app.listen(PORT, '0.0.0.0', () => {
    isReady = true;
    console.log(`Namo Bharat News 24 running on http://'0.0.0.0':${PORT}`);
  });

  const shutdown = async (signal) => {
    console.log(`Received ${signal}. Shutting down cleanly...`);
    isReady = false;
    server.close(() => undefined);
    try { await pool.end(); } catch {}
    if (redisAvailable) {
      try { await redisClient.quit(); } catch {}
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
start().catch((error) => {
  console.error('Startup failed:', error);
  process.exit(1);
});
