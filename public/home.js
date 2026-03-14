const placeholder = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><rect width="100%" height="100%" fill="#ddd"/><text x="50%" y="50%" font-size="42" text-anchor="middle" fill="#777" font-family="Arial">Namo Bharat News 24</text></svg>');
const byId = (id) => document.getElementById(id);
const state = { settings: {}, categories: [], articles: [], search: '', chat: [] };
const quickPrompts = [
  'आज की मुख्य खबरों का छोटा सार बताओ',
  'राजनीति और बिहार से जुड़ी खबरें बताओ',
  'रोजगार और शिक्षा अपडेट बताओ',
  'मेरे जिले की खबरें दिखाओ'
];

function formatDate(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'अभी' : new Intl.DateTimeFormat('hi-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}
function scoreArticle(article, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 1;
  return [article.title, article.category, article.subcategory, article.location, article.summary, article.content].join(' ').toLowerCase().includes(q) ? 1 : 0;
}
function filteredArticles() { return state.articles.filter((article) => scoreArticle(article, state.search)); }
function sanitizeImageCandidate(value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  if (/^\/uploads\/[a-zA-Z0-9._-]+$/.test(clean)) return clean;
  if (/^https:\/\/[^\s]+$/i.test(clean)) return clean;
  return '';
}
function firstValidLogo(candidates, fallback = '') {
  for (const candidate of candidates || []) {
    const safe = sanitizeImageCandidate(candidate);
    if (safe) return safe;
  }
  return fallback;
}
function renderSiteLogo(settings) {
  const wrap = byId('siteLogo');
  if (!wrap) return;
  const logoUrl = firstValidLogo([settings.logo, settings.logoUrl, settings?.branding?.logo, settings.favicon], '');
  wrap.textContent = '';
  if (!logoUrl) { wrap.textContent = 'NB'; return; }
  const img = document.createElement('img');
  img.alt = 'logo'; img.src = logoUrl;
  img.addEventListener('error', () => { wrap.textContent = 'NB'; }, { once: true });
  wrap.appendChild(img);
}
function applyTheme(settings) {
  document.documentElement.style.setProperty('--primary', settings.primaryColor || '#c4171e');
  document.documentElement.style.setProperty('--bg', settings.backgroundColor || '#f7f4ef');
  byId('siteName').textContent = settings.siteName || 'Namo Bharat News 24';
  byId('footerSite').textContent = settings.siteName || 'Namo Bharat News 24';
  byId('tagline').textContent = settings.tagline || '';
  byId('breakingText').textContent = settings.breakingText || '';
  byId('contactEmail').textContent = settings.contactEmail || '';
  byId('footerText').textContent = settings.footerText || '';
  byId('officeAddress').textContent = settings.officeAddress || '';
  byId('cityBtn').textContent = settings.selectedCity || 'पटना';
  renderSiteLogo(settings);
}
function renderHero() {
  const heroId = state.settings.heroArticleId;
  const pool = filteredArticles();
  const article = pool.find((item) => item.id === heroId) || pool[0] || state.articles[0];
  if (!article) return;
  const heroCard = document.querySelector('.hero-card');
  const heroImage = byId('heroImage');
  heroImage.textContent = '';
  heroCard?.classList.remove('no-hero-image');
  const hideHeroMedia = () => heroCard?.classList.add('no-hero-image');
  if (article.image) {
    const img = document.createElement('img');
    img.alt = article.title || '';
    img.src = article.image;
    img.addEventListener('error', hideHeroMedia, { once: true });
    heroImage.appendChild(img);
  } else {
    hideHeroMedia();
  }
  const heroMeta = byId('heroMeta');
  heroMeta.textContent = '';
  [article.category, article.subcategory, article.location, formatDate(article.publishedAt)].filter(Boolean).forEach((value) => {
    const span = document.createElement('span');
    span.textContent = value || '—';
    heroMeta.appendChild(span);
  });
  byId('heroTitle').textContent = article.title;
  byId('heroSummary').textContent = article.summary || '';
}
function createAdMedia({ image, link, alt }) {
  const img = document.createElement('img');
  img.src = image; img.alt = alt || 'Advertisement'; img.loading = 'lazy';
  img.addEventListener('error', () => { img.src = placeholder; }, { once: true });
  if (!link) return img;
  const anchor = document.createElement('a');
  anchor.href = link; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer sponsored';
  anchor.appendChild(img); return anchor;
}
function renderAds() {
  const s = state.settings || {};
  const bannerMount = byId('homepageBannerAd');
  const sidebarMount = byId('homepageSidebarAd');
  if (bannerMount) {
    const canShowBanner = !!(s.homepageBannerEnabled && s.homepageBannerImage);
    bannerMount.textContent = '';
    bannerMount.classList.toggle('hidden', !canShowBanner);
    if (canShowBanner) {
      const label = document.createElement('div'); label.className = 'ad-label'; label.textContent = 'Sponsored';
      bannerMount.append(label, createAdMedia({ image: s.homepageBannerImage, link: s.homepageBannerLink, alt: s.homepageBannerAlt }));
    }
  }
  if (sidebarMount) {
    const canShowSidebar = !!(s.homepageSidebarAdEnabled && s.homepageSidebarAdImage);
    sidebarMount.textContent = '';
    sidebarMount.classList.toggle('hidden', !canShowSidebar);
    byId('heroGrid')?.classList.toggle('hero-grid--no-sidebar', !canShowSidebar);
    if (canShowSidebar) {
      const label = document.createElement('div'); label.className = 'ad-label'; label.textContent = 'Sponsored';
      sidebarMount.append(label, createAdMedia({ image: s.homepageSidebarAdImage, link: s.homepageSidebarAdLink, alt: s.homepageSidebarAdAlt }));
    }
  }
}
function renderTrending() {
  const list = byId('trendingList');
  list.textContent = '';
  const items = filteredArticles().filter((item) => item.trending).slice(0, 6);
  byId('heroGrid')?.classList.toggle('hero-grid--no-trending', items.length === 0);
  items.forEach((item) => {
    const row = document.createElement('article'); row.className = 'item';
    const badge = document.createElement('span'); badge.className = 'chip'; badge.textContent = item.subcategory || item.category;
    const h3 = document.createElement('h3'); h3.textContent = item.title;
    row.append(badge, h3); list.appendChild(row);
  });
}
function renderSections() {
  const mount = byId('sectionsMount');
  const visible = state.settings.visibleSections || {};
  const groups = {};
  filteredArticles().forEach((article) => {
    const key = article.category;
    groups[key] = groups[key] || [];
    groups[key].push(article);
  });
  mount.textContent = '';
  const root = state.categories.filter((cat) => !cat.parentId && cat.enabled && visible[cat.name] !== false && groups[cat.name]?.length);
  if (!root.length) {
    const empty = document.createElement('div'); empty.className = 'empty';
    empty.textContent = state.search ? 'इस खोज के लिए कोई खबर नहीं मिली।' : 'अभी कोई खबर उपलब्ध नहीं है।';
    mount.appendChild(empty); return;
  }
  root.forEach((cat) => {
    const section = document.createElement('section'); section.className = 'section';
    const head = document.createElement('div'); head.className = 'section-head';
    const title = document.createElement('div'); title.className = 'section-title'; title.textContent = cat.name;
    const more = document.createElement('div'); more.className = 'muted';
    const subs = state.categories.filter((c) => c.parentId === cat.id).map((c) => c.name);
    more.textContent = subs.length ? `उप-श्रेणियाँ: ${subs.join(', ')}` : 'और खबरें';
    head.append(title, more);
    const grid = document.createElement('div'); grid.className = 'story-grid';
    groups[cat.name].slice(0, 6).forEach((article) => {
      const card = document.createElement('article'); card.className = 'story-card';
      const img = document.createElement('img'); img.alt = ''; img.src = article.image || placeholder;
      img.addEventListener('error', () => { img.src = placeholder; }, { once: true });
      const body = document.createElement('div'); body.className = 'story-body';
      const meta = document.createElement('div'); meta.className = 'meta';
      const loc = document.createElement('span'); loc.textContent = `${article.location || '—'}${article.subcategory ? ` • ${article.subcategory}` : ''}`;
      const when = document.createElement('span'); when.textContent = formatDate(article.publishedAt);
      meta.append(loc, when);
      const h3 = document.createElement('h3'); h3.textContent = article.title;
      const p = document.createElement('p'); p.textContent = article.summary || '';
      body.append(meta, h3, p); card.append(img, body); grid.appendChild(card);
    });
    section.append(head, grid); mount.appendChild(section);
  });
  const shown = filteredArticles().length;
  byId('searchSummary').textContent = state.search ? `"${state.search}" के लिए ${shown} खबरें मिलीं।` : 'सभी खबरें दिख रही हैं।';
}
function renderNav() {
  const nav = byId('navChips'); nav.textContent = '';
  state.categories.filter((c) => c.enabled).forEach((cat) => {
    const chip = document.createElement('button'); chip.className = 'nav-chip'; chip.type = 'button';
    chip.textContent = cat.parentId ? `↳ ${cat.name}` : cat.name;
    chip.addEventListener('click', () => {
      state.search = cat.name; byId('publicSearch').value = cat.name;
      renderHero(); renderTrending(); renderSections();
    });
    nav.appendChild(chip);
  });
}
function renderPromptChips() {
  const wrap = byId('assistantPromptChips'); if (!wrap) return;
  wrap.textContent = '';
  quickPrompts.forEach((prompt) => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn ghost'; btn.dataset.prompt = prompt; btn.textContent = prompt;
    wrap.appendChild(btn);
  });
}
function renderChat() {
  const output = byId('assistantOutput'); output.textContent = '';
  if (!state.chat.length) {
    output.textContent = 'पूछें: आज की मुख्य खबर क्या है? किसी जिले की खबर दिखाओ। राजनीति का सार बताओ।';
    return;
  }
  state.chat.forEach((m) => {
    const bubble = document.createElement('div'); bubble.className = `assistant-msg assistant-${m.role}`;
    bubble.textContent = m.text; output.appendChild(bubble);
  });
  output.scrollTop = output.scrollHeight;
}
async function askAssistant(message) {
  const text = String(message || '').trim();
  if (!text) return;
  state.chat.push({ role: 'user', text });
  state.chat.push({ role: 'bot', text: 'सोच रहा है...' });
  renderChat();
  try {
    const history = state.chat.filter((x) => x.role !== 'bot' || x.text !== 'सोच रहा है...').slice(-8);
    const res = await fetch('/api/assistant/public', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text, history }) });
    const data = await res.json();
    state.chat[state.chat.length - 1] = { role: 'bot', text: data.reply || 'उत्तर उपलब्ध नहीं है।' };
  } catch {
    state.chat[state.chat.length - 1] = { role: 'bot', text: 'सहायक अभी उपलब्ध नहीं है। कृपया थोड़ी देर बाद फिर कोशिश करें।' };
  }
  renderChat();
}
async function loadSite() {
  const res = await fetch('/api/site', { credentials: 'same-origin' });
  const data = await res.json();
  state.settings = data.settings || {};
  state.categories = data.categories || [];
  state.articles = (data.articles || []).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  applyTheme(state.settings);
  renderNav(); renderAds(); renderHero(); renderTrending(); renderSections(); renderPromptChips(); renderChat();
  byId('todayLine').textContent = new Intl.DateTimeFormat('hi-IN', { dateStyle: 'full', timeStyle: 'short' }).format(new Date());
}

byId('publicSearch').addEventListener('input', (e) => {
  state.search = e.target.value || '';
  renderHero(); renderTrending(); renderSections();
});
byId('assistantToggleBtn').addEventListener('click', () => {
  const drawer = byId('assistantDrawer');
  const open = drawer.classList.toggle('hidden') === false;
  byId('assistantToggleBtn').setAttribute('aria-expanded', String(open));
});
byId('assistantCloseBtn').addEventListener('click', () => {
  byId('assistantDrawer').classList.add('hidden');
  byId('assistantToggleBtn').setAttribute('aria-expanded', 'false');
});
byId('assistantClearBtn').addEventListener('click', () => { state.chat = []; renderChat(); byId('assistantMessage').value = ''; });
byId('assistantForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = byId('assistantMessage').value;
  byId('assistantMessage').value = '';
  await askAssistant(message);
});
byId('assistantPromptChips').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-prompt]');
  if (!btn) return;
  byId('assistantMessage').value = btn.dataset.prompt;
  await askAssistant(btn.dataset.prompt);
});
window.addEventListener('resize', renderAds);

loadSite().catch(() => {
  const mount = byId('sectionsMount');
  mount.textContent = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.textContent = 'साइट डेटा लोड नहीं हो पाया। सर्वर चालू है या नहीं, यह जांचें।';
  mount.appendChild(empty);
});
