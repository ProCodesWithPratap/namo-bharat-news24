const state = {
  authenticated: false,
  csrfToken: '',
  user: null,
  permissions: [],
  filters: { article: '', reporter: '', payment: '', user: '' },
  data: { settings:{}, categories:[], articles:[], reporters:[], payments:[], users:[], auditLogs:[] }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const loginView = $('#loginView');
const adminView = $('#adminView');
const toastEl = $('#toast');
const sidebar = $('#adminSidebar');

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function safe(value = '') { return escapeHtml(value); }
function clear(el){ if(el) el.textContent = ''; }
function text(tag, value, className = '') {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = value;
  return el;
}
function button(label, className, dataset = {}, type = 'button') {
  const el = document.createElement('button');
  el.type = type;
  el.className = className;
  el.textContent = label;
  Object.entries(dataset).forEach(([key, value]) => { el.dataset[key] = value; });
  return el;
}
function inputMatches(input, fields = []) {
  const q = String(input || '').trim().toLowerCase();
  if (!q) return true;
  return fields.some((field) => String(field || '').toLowerCase().includes(q));
}
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(window.toastTimer);
  window.toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2300);
}
function hasPermission(permission) {
  return state.permissions.includes('*') || state.permissions.includes(permission);
}
function fmtMoney(value) {
  return new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', maximumFractionDigits:2 }).format(Number(value || 0));
}

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}
function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}
function passwordPolicyHint(password = '') {
  const value = String(password || '');
  return value.length >= 10 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9]/.test(value);
}

function fmtDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('en-IN', { dateStyle:'medium', timeStyle:'short' }).format(d);
}
async function api(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (!['GET', 'HEAD'].includes(method) && state.csrfToken) headers.set('x-csrf-token', state.csrfToken);
  const res = await fetch(url, { credentials:'same-origin', ...options, headers });
  let data = {};
  try { data = await res.json(); } catch {}
  if (data?.csrfToken) state.csrfToken = data.csrfToken;
  if (!res.ok) throw new Error(data.message || 'Request failed');
  return data;
}
function switchAuth(authenticated) {
  loginView.classList.toggle('hidden', authenticated);
  adminView.classList.toggle('hidden', !authenticated);
}
function formToObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}
function setTab(id) {
  $$('.admin-nav button').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === id));
  $$('.admin-tab').forEach((tab) => tab.classList.toggle('hidden', tab.id !== id));
  if (sidebar && window.innerWidth <= 980) {
    sidebar.classList.remove('open');
    const toggle = $('#sidebarToggleBtn');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }
}
function applySearchBindings() {
  [['#articleSearch', 'article'], ['#reporterSearch', 'reporter'], ['#paymentSearch', 'payment'], ['#userSearch', 'user']].forEach(([selector, key]) => {
    const el = $(selector);
    if (!el || el.dataset.bound === 'true') return;
    el.dataset.bound = 'true';
    el.addEventListener('input', () => {
      state.filters[key] = el.value || '';
      if (key === 'article') fillArticles();
      if (key === 'reporter') fillReporters();
      if (key === 'payment') fillPayments();
      if (key === 'user') fillUsers();
    });
  });
}
function fillDashboard() {
  const { articles, categories, reporters, payments, auditLogs } = state.data;
  $('#kpiArticles').textContent = articles.length;
  $('#kpiCategories').textContent = categories.length;
  $('#kpiReporters').textContent = reporters.length;
  $('#kpiCollections').textContent = fmtMoney(payments.filter((x) => x.status === 'paid').reduce((sum, x) => sum + Number(x.amount || 0), 0));
  const audit = $('#auditPreview');
  clear(audit);
  if (!auditLogs.length) {
    const empty = text('div', 'No audit entries available.', 'empty');
    audit.appendChild(empty);
    return;
  }
  auditLogs.slice(0, 8).forEach((item) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'item';
    const row = document.createElement('div');
    row.className = 'item-row';
    row.append(text('strong', item.action || 'activity'), text('span', fmtDateTime(item.at), 'muted'));
    const meta = text('div', `${item.actorUsername || 'system'} • ${item.details || ''}`, 'muted');
    wrapper.append(row, meta);
    audit.appendChild(wrapper);
  });
}
function rebuildSelect(selectEl, options, selectedValue = '') {
  clear(selectEl);
  options.forEach(({ value, label }) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    selectEl.appendChild(option);
  });
  selectEl.value = selectedValue;
}

function resolveLogoUrl(settings = {}) {
  return settings.logo || settings.logoUrl || settings?.branding?.logo || settings.favicon || '';
}

function applyBranding(settings = {}) {
  const adminLogo = $('#adminBrandLogo');
  const logoUrl = resolveLogoUrl(settings);
  if (adminLogo && logoUrl) {
    adminLogo.textContent = '';
    const img = document.createElement('img');
    img.alt = 'logo';
    img.src = logoUrl;
    img.style.width = '100%';
    img.style.height = '100%';
    img.style.objectFit = 'cover';
    adminLogo.appendChild(img);
  }
  const faviconHref = settings.favicon || logoUrl || '/favicon.ico';
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.href = `${faviconHref}${faviconHref.includes('?') ? '&' : '?'}v=${Date.now()}`;
}

function fillSiteForm() {
  const form = $('#siteSettingsForm');
  const s = state.data.settings;
  form.siteName.value = s.siteName || '';
  form.tagline.value = s.tagline || '';
  form.primaryColor.value = s.primaryColor || '#c4171e';
  form.backgroundColor.value = s.backgroundColor || '#f7f4ef';
  form.selectedCity.value = s.selectedCity || '';
  form.contactEmail.value = s.contactEmail || '';
  form.editorName.value = s.editorName || '';
  form.officeAddress.value = s.officeAddress || '';
  form.breakingText.value = s.breakingText || '';
  form.footerText.value = s.footerText || '';
  rebuildSelect($('#heroArticleId'), state.data.articles.map((article) => ({ value: article.id, label: article.title })), s.heroArticleId || '');
  const sectionToggles = $('#sectionToggles');
  clear(sectionToggles);
  state.data.categories.forEach((cat) => {
    const active = s.visibleSections?.[cat.name] !== false;
    const btn = button(cat.name, `btn ${active ? 'primary' : 'ghost'} toggle-section`, { name: cat.name, active: String(active) });
    sectionToggles.appendChild(btn);
  });
}
function fillCategories() {
  const list = $('#categoryList');
  clear(list);
  if (!state.data.categories.length) {
    list.appendChild(text('div', 'No categories yet.', 'empty'));
  } else {
    state.data.categories.forEach((cat) => {
      const item = document.createElement('div');
      item.className = 'item';
      const row = document.createElement('div');
      row.className = 'item-row';
      const meta = document.createElement('div');
      meta.append(text('strong', cat.name), text('div', cat.enabled ? 'Enabled' : 'Disabled', 'muted'));
      const tools = document.createElement('div');
      tools.className = 'toolbar';
      tools.append(
        button('Rename', 'btn ghost', { action: 'rename-category', id: cat.id }),
        button(cat.enabled ? 'Disable' : 'Enable', 'btn', { action: 'toggle-category', id: cat.id }),
        button('Delete', 'btn', { action: 'delete-category', id: cat.id })
      );
      row.append(meta, tools);
      item.appendChild(row);
      list.appendChild(item);
    });
  }
  rebuildSelect($('#articleCategory'), state.data.categories.map((cat) => ({ value: cat.name, label: cat.name })), $('#articleForm').category.value || '');
}
function fillArticles() {
  const list = $('#articleList');
  clear(list);
  const filtered = state.data.articles.filter((article) => inputMatches(state.filters.article, [article.title, article.category, article.location, article.author, article.summary]));
  if (!filtered.length) {
    list.appendChild(text('div', 'No articles match this search.', 'empty'));
    return;
  }
  filtered.forEach((article) => {
    const item = document.createElement('div');
    item.className = 'item';
    const row = document.createElement('div');
    row.className = 'item-row';
    const meta = document.createElement('div');
    meta.append(
      text('strong', article.title),
      text('div', `${article.category || '—'} • ${article.location || '—'} • ${fmtDateTime(article.publishedAt)}`, 'muted')
    );
    const actions = document.createElement('div');
    actions.className = 'toolbar';
    actions.append(
      button('Edit', 'btn ghost', { action: 'edit-article', id: article.id }),
      button('Delete', 'btn', { action: 'delete-article', id: article.id })
    );
    row.append(meta, actions);
    item.append(row, text('div', article.summary || '', 'muted'));
    list.appendChild(item);
  });
}
function fillReporters() {
  rebuildSelect($('#paymentReporter'), state.data.reporters.map((reporter) => ({ value: reporter.id, label: `${reporter.fullName} — ${reporter.designation}` })), $('#paymentForm').reporterId.value || '');
  const list = $('#reporterList');
  clear(list);
  const filtered = state.data.reporters.filter((reporter) => inputMatches(state.filters.reporter, [reporter.fullName, reporter.designation, reporter.district, reporter.state, reporter.mobile, reporter.email]));
  if (!filtered.length) {
    list.appendChild(text('div', 'No reporters match this search.', 'empty'));
    return;
  }
  filtered.forEach((reporter) => {
    const item = document.createElement('div');
    item.className = 'item';
    const row = document.createElement('div');
    row.className = 'item-row';
    const meta = document.createElement('div');
    meta.append(
      text('strong', reporter.fullName || 'Unknown reporter'),
      text('div', `${reporter.designation || '—'} • ${reporter.district || '—'}, ${reporter.state || '—'} • ${reporter.mobile || '—'}`, 'muted'),
      text('div', `ID: ${reporter.idCardNo || '-'} • Letter: ${reporter.letterNo || '-'}`, 'muted')
    );
    const actions = document.createElement('div');
    actions.className = 'toolbar';
    actions.append(
      button('Edit', 'btn ghost', { action: 'edit-reporter', id: reporter.id }),
      button('Joining letter', 'btn ghost', { action: 'joining-letter', id: reporter.id }),
      button('ID card', 'btn ghost', { action: 'id-card', id: reporter.id }),
      button('Delete', 'btn', { action: 'delete-reporter', id: reporter.id })
    );
    row.append(meta, actions);
    item.appendChild(row);
    list.appendChild(item);
  });
}
function findReporter(id) {
  return state.data.reporters.find((reporter) => reporter.id === id);
}
function fillPayments() {
  const list = $('#paymentList');
  clear(list);
  const filtered = state.data.payments.filter((payment) => {
    const reporter = findReporter(payment.reporterId);
    return inputMatches(state.filters.payment, [reporter?.fullName, payment.type, payment.mode, payment.status, payment.reference, payment.date]);
  });
  if (!filtered.length) {
    list.appendChild(text('div', 'No payments match this search.', 'empty'));
    return;
  }
  filtered.forEach((payment) => {
    const item = document.createElement('div');
    item.className = 'item';
    const row = document.createElement('div');
    row.className = 'item-row';
    const meta = document.createElement('div');
    meta.append(
      text('strong', findReporter(payment.reporterId)?.fullName || 'Unknown reporter'),
      text('div', `${payment.type || '—'} • ${payment.mode || '—'} • ${payment.status || '—'} • ${payment.date || '—'}`, 'muted'),
      text('div', `${fmtMoney(payment.amount)} • Ref: ${payment.reference || '-'}`, 'muted')
    );
    const actions = document.createElement('div');
    actions.className = 'toolbar';
    actions.append(
      button('Edit', 'btn ghost', { action: 'edit-payment', id: payment.id }),
      button('Receipt', 'btn ghost', { action: 'payment-receipt', id: payment.id }),
      button('Delete', 'btn', { action: 'delete-payment', id: payment.id })
    );
    row.append(meta, actions);
    item.appendChild(row);
    list.appendChild(item);
  });
}
function fillUsers() {
  const list = $('#userList');
  clear(list);
  const users = (state.data.users || []).filter((user) => inputMatches(state.filters.user, [user.fullName, user.username, user.email, user.role]));
  if (!users.length) {
    list.appendChild(text('div', 'No team accounts match this search.', 'empty'));
    return;
  }
  users.forEach((user) => {
    const item = document.createElement('div');
    item.className = 'item';
    const row = document.createElement('div');
    row.className = 'item-row';
    const meta = document.createElement('div');
    meta.append(
      text('strong', user.fullName),
      text('div', `${user.username} • ${user.email || '-'} • ${user.role}`, 'muted'),
      text('div', `2FA: ${user.totpEnabled ? 'Enabled' : 'Off'} • Last login: ${fmtDateTime(user.lastLoginAt)}`, 'muted')
    );
    const actions = document.createElement('div');
    actions.className = 'toolbar';
    actions.append(
      button('Edit', 'btn ghost', { action: 'edit-user', id: user.id }),
      button('Reset password', 'btn ghost', { action: 'reset-user-password', id: user.id }),
      button('Delete', 'btn', { action: 'delete-user', id: user.id })
    );
    row.append(meta, actions);
    item.appendChild(row);
    list.appendChild(item);
  });
}
function fillSecurity() {
  $('#twoFactorState').textContent = state.user?.totpEnabled ? '2FA is enabled on this account.' : '2FA is not enabled.';
}
async function refreshSystemStatus() {
  const mount = $('#systemStatus');
  clear(mount);
  if (!hasPermission('users.manage')) {
    mount.textContent = 'System status is available only to superadmin.';
    return;
  }
  const data = await api('/api/admin/system-status');
  [
    ['Database', data.storage.database],
    ['Sessions', data.storage.sessions],
    ['Uploads', data.storage.uploads],
    ['SMTP configured', data.mail.configured ? 'Yes' : 'No (dev log mode)'],
    ['Counts', `users ${Number(data.counts.users || 0)}, articles ${Number(data.counts.articles || 0)}, reporters ${Number(data.counts.reporters || 0)}, payments ${Number(data.counts.payments || 0)}`]
  ].forEach(([label, value]) => {
    const row = document.createElement('div');
    row.append(text('strong', `${label}: `), document.createTextNode(String(value || '—')));
    mount.appendChild(row);
  });
}
async function refreshAdmin() {
  const data = await api('/api/admin/site-data');
  state.data = data;
  state.user = data.currentUser;
  state.permissions = data.permissions || [];
  state.csrfToken = data.csrfToken || state.csrfToken;
  $('#whoami').textContent = `${state.user.fullName} • ${state.user.role}`;
  applyBranding(state.data.settings);
  fillDashboard();
  fillSiteForm();
  bindLogoUploadControls();
  fillCategories();
  fillArticles();
  fillReporters();
  fillPayments();
  fillUsers();
  fillSecurity();
  refreshSystemStatus().catch(() => { $('#systemStatus').textContent = 'Could not load system status.'; });
  applySearchBindings();
}
async function checkSession() {
  const session = await api('/api/admin/session');
  if (!session.authenticated) {
    switchAuth(false);
    const resetToken = new URLSearchParams(location.search).get('reset_token');
    if (resetToken) {
      $('#resetPasswordForm').classList.remove('hidden');
      $('#resetPasswordForm').token.value = resetToken;
    }
    return;
  }
  state.authenticated = true;
  state.csrfToken = session.csrfToken || '';
  state.user = session.user;
  state.permissions = session.permissions || [];
  switchAuth(true);
  await refreshAdmin();
}
function currentArticleContext() {
  const form = $('#articleForm');
  return {
    title: form.title.value || '',
    category: form.category.value || '',
    location: form.location.value || '',
    author: form.author.value || '',
    summary: form.summary.value || '',
    content: form.content.value || ''
  };
}
$$('.admin-nav button').forEach((btn) => btn.addEventListener('click', () => setTab(btn.dataset.tab)));
$('#sidebarToggleBtn')?.addEventListener('click', () => {
  const open = !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  $('#sidebarToggleBtn').setAttribute('aria-expanded', String(open));
});
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    const payload = formToObject(form);
    const data = await api('/api/login', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
    if (data.requiresTwoFactor) {
      $('#totpWrap').classList.remove('hidden');
      form.preAuthToken.value = data.preAuthToken;
      return toast('Password accepted. Enter your 2FA code now.');
    }
    state.authenticated = true;
    state.csrfToken = data.csrfToken || '';
    state.user = data.user;
    state.permissions = data.permissions || [];
    switchAuth(true);
    await refreshAdmin();
    toast('Login successful');
  } catch (err) { toast(err.message); }
});
$('#logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method:'POST' });
    state.authenticated = false;
    state.csrfToken = '';
    switchAuth(false);
    toast('Logged out');
  } catch (err) { toast(err.message); }
});
$('#showResetBtn').addEventListener('click', () => $('#resetRequestForm').classList.remove('hidden'));
$('#hideResetBtn').addEventListener('click', () => $('#resetRequestForm').classList.add('hidden'));
$('#resetRequestForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/auth/request-password-reset', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(formToObject(e.currentTarget)) });
    const box = $('#resetPreview');
    box.classList.remove('hidden');
    box.textContent = data.devResetUrl ? `Dev reset link: ${data.devResetUrl}` : 'If the account exists, reset instructions have been sent.';
    toast('Password reset request accepted');
  } catch (err) { toast(err.message); }
});
$('#resetPasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    await api('/api/auth/reset-password', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(formToObject(form)) });
    form.reset();
    toast('Password updated');
    history.replaceState({}, '', '/admin');
  } catch (err) { toast(err.message); }
});
$('#siteSettingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const form = e.currentTarget;
    const visibleSections = {};
    $$('.toggle-section').forEach((btn) => { visibleSections[btn.dataset.name] = btn.dataset.active !== 'false'; });
    const payload = formToObject(form);
    payload.visibleSections = visibleSections;
    await api('/api/settings', { method:'PUT', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
    await refreshAdmin();
    toast('Site settings saved');
  } catch (err) { toast(err.message); }
});
$('#sectionToggles').addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle-section');
  if (!btn) return;
  const active = btn.dataset.active !== 'false';
  btn.dataset.active = String(!active);
  btn.classList.toggle('primary', !active);
  btn.classList.toggle('ghost', active);
});
function handleLogoUploadClick(e) {
  e.preventDefault();
  console.log('[admin] upload button clicked');

  const input = document.getElementById('logoInput');
  const fileCount = input?.files?.length || 0;
  const file = input && input.files && input.files[0];
  console.log('[admin] selected file count / file name:', fileCount, file?.name || '(none)');

  if (!file) {
    console.log('[admin] no file selected');
    return alert('Please choose a logo file first');
  }

  console.log('[admin] selected file:', file.name);

  const fd = new FormData();
  fd.append('logo', file);

  const csrfToken = state.csrfToken || '';
  console.log('[admin] csrf token found:', csrfToken ? 'yes' : 'no');
  if (!csrfToken) {
    console.warn('[admin] csrf token missing before upload request');
  }

  console.log('[admin] before fetch POST');
  console.log('[admin] sending upload request');

  fetch('/api/upload/logo', {
    method: 'POST',
    credentials: 'same-origin',
    headers: csrfToken ? { 'x-csrf-token': csrfToken } : undefined,
    body: fd
  })
    .then(async (res) => {
      console.log('[admin] upload response status:', res.status);
      const data = await res.json().catch(() => ({}));
      console.log('[admin] upload response body:', data);
      return { res, data };
    })
    .then(async ({ res, data }) => {
      if (!res.ok) throw new Error(data.message || data.error || 'Upload failed');

      if (data.csrfToken) {
        state.csrfToken = data.csrfToken;
      }

      const settingsPayload = data.settings ? data.settings : { logo: data.logo || data.logoUrl || data.url || data?.branding?.logo || '' };
      console.log('[admin] updating local/admin state with:', settingsPayload);

      if (settingsPayload) {
        state.data.settings = { ...state.data.settings, ...settingsPayload };
        applyBranding(state.data.settings);
      }

      if (input) input.value = '';

      try {
        await refreshAdmin();
        console.log('[admin] settings update status: success');
      } catch (refreshErr) {
        console.log('[admin] settings update status: failed', refreshErr);
      }

      toast('Logo uploaded');
    })
    .catch((err) => {
      console.error('[admin] upload failed:', err);
      alert(err.message || 'Upload failed');
    });
}

function bindLogoUploadControls() {
  const btn = document.getElementById('uploadLogoBtn');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', handleLogoUploadClick);
  }

  if (!document.body.dataset.logoUploadDelegatedBound) {
    document.body.dataset.logoUploadDelegatedBound = '1';
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('#uploadLogoBtn');
      if (!btn) return;
      handleLogoUploadClick(e);
    });
  }
}
$('#categoryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    await api('/api/categories', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(formToObject(form)) });
    form.reset();
    await refreshAdmin();
    toast('Category created');
  } catch (err) { toast(err.message); }
});
$('#categoryList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const cat = state.data.categories.find((item) => item.id === btn.dataset.id);
  if (!cat) return;
  try {
    if (btn.dataset.action === 'rename-category') {
      const form = $('#categoryRenameForm');
      form.categoryId.value = cat.id;
      form.name.value = cat.name || '';
      openModal('categoryRenameModal');
      form.name.focus();
      return;
    }
    if (btn.dataset.action === 'toggle-category') {
      await api(`/api/categories/${encodeURIComponent(cat.id)}`, { method:'PUT', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ name: cat.name, enabled: !cat.enabled }) });
    }
    if (btn.dataset.action === 'delete-category') {
      if (!window.confirm(`Delete ${cat.name}?`)) return;
      await api(`/api/categories/${encodeURIComponent(cat.id)}`, { method:'DELETE' });
    }
    await refreshAdmin();
    toast('Category updated');
  } catch (err) { toast(err.message); }
});
$('#articleForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    const fd = new FormData(form);
    if (fd.get('featured') === null) fd.set('featured', 'false');
    if (fd.get('trending') === null) fd.set('trending', 'false');
    const id = fd.get('articleId');
    await api(id ? `/api/articles/${encodeURIComponent(id)}` : '/api/articles', { method: id ? 'PUT' : 'POST', body: fd });
    form.reset();
    form.articleId.value = '';
    await refreshAdmin();
    toast(id ? 'Article updated' : 'Article created');
  } catch (err) { toast(err.message); }
});
$('#resetArticleBtn').addEventListener('click', () => { $('#articleForm').reset(); $('#articleForm').articleId.value = ''; });
$('#articleList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const article = state.data.articles.find((item) => item.id === btn.dataset.id);
  if (!article) return;
  if (btn.dataset.action === 'edit-article') {
    const form = $('#articleForm');
    form.articleId.value = article.id;
    form.title.value = article.title;
    form.category.value = article.category;
    form.location.value = article.location || '';
    form.author.value = article.author || '';
    form.publishedAt.value = new Date(article.publishedAt).toISOString().slice(0, 16);
    form.summary.value = article.summary || '';
    form.content.value = article.content || '';
    form.featured.checked = !!article.featured;
    form.trending.checked = !!article.trending;
    setTab('articlesTab');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return toast('Article loaded into form');
  }
  if (btn.dataset.action === 'delete-article') {
    if (!window.confirm(`Delete "${article.title}"?`)) return;
    try {
      await api(`/api/articles/${encodeURIComponent(article.id)}`, { method:'DELETE' });
      await refreshAdmin();
      toast('Article deleted');
    } catch (err) { toast(err.message); }
  }
});
$('#reporterForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    const fd = new FormData(form);
    const id = fd.get('reporterId');
    await api(id ? `/api/reporters/${encodeURIComponent(id)}` : '/api/reporters', { method: id ? 'PUT' : 'POST', body: fd });
    form.reset();
    form.reporterId.value = '';
    await refreshAdmin();
    toast(id ? 'Reporter updated' : 'Reporter created');
  } catch (err) { toast(err.message); }
});
$('#resetReporterBtn').addEventListener('click', () => { $('#reporterForm').reset(); $('#reporterForm').reporterId.value = ''; });
$('#reporterList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const reporter = state.data.reporters.find((item) => item.id === btn.dataset.id);
  if (!reporter) return;
  if (btn.dataset.action === 'edit-reporter') {
    const form = $('#reporterForm');
    form.reporterId.value = reporter.id;
    form.fullName.value = reporter.fullName || '';
    form.designation.value = reporter.designation || '';
    form.district.value = reporter.district || '';
    form.state.value = reporter.state || '';
    form.mobile.value = reporter.mobile || '';
    form.email.value = reporter.email || '';
    form.joinDate.value = reporter.joinDate || '';
    form.status.value = reporter.status || '';
    form.idCardNo.value = reporter.idCardNo || '';
    form.letterNo.value = reporter.letterNo || '';
    form.address.value = reporter.address || '';
    form.notes.value = reporter.notes || '';
    setTab('reportersTab');
    window.scrollTo({ top: 0, behavior:'smooth' });
    return toast('Reporter loaded into form');
  }
  if (btn.dataset.action === 'joining-letter') return window.open(`/admin/reporter/${encodeURIComponent(reporter.id)}/joining-letter`, '_blank', 'noopener');
  if (btn.dataset.action === 'id-card') return window.open(`/admin/reporter/${encodeURIComponent(reporter.id)}/id-card`, '_blank', 'noopener');
  if (btn.dataset.action === 'delete-reporter') {
    if (!window.confirm(`Delete ${reporter.fullName}? Related payments will also be removed.`)) return;
    try {
      await api(`/api/reporters/${encodeURIComponent(reporter.id)}`, { method:'DELETE' });
      await refreshAdmin();
      toast('Reporter deleted');
    } catch (err) { toast(err.message); }
  }
});
$('#paymentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    const payload = formToObject(form);
    const id = payload.paymentId;
    await api(id ? `/api/payments/${encodeURIComponent(id)}` : '/api/payments', { method: id ? 'PUT' : 'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
    form.reset();
    form.paymentId.value = '';
    await refreshAdmin();
    toast(id ? 'Payment updated' : 'Payment created');
  } catch (err) { toast(err.message); }
});
$('#resetPaymentBtn').addEventListener('click', () => { $('#paymentForm').reset(); $('#paymentForm').paymentId.value = ''; });
$('#paymentList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const payment = state.data.payments.find((item) => item.id === btn.dataset.id);
  if (!payment) return;
  if (btn.dataset.action === 'edit-payment') {
    const form = $('#paymentForm');
    form.paymentId.value = payment.id;
    form.reporterId.value = payment.reporterId;
    form.amount.value = payment.amount;
    form.type.value = payment.type || '';
    form.status.value = payment.status || '';
    form.date.value = payment.date || '';
    form.mode.value = payment.mode || '';
    form.reference.value = payment.reference || '';
    form.notes.value = payment.notes || '';
    setTab('paymentsTab');
    window.scrollTo({ top: 0, behavior:'smooth' });
    return toast('Payment loaded into form');
  }
  if (btn.dataset.action === 'payment-receipt') return window.open(`/admin/payment/${encodeURIComponent(payment.id)}/receipt`, '_blank', 'noopener');
  if (btn.dataset.action === 'delete-payment') {
    if (!window.confirm('Delete this payment?')) return;
    try {
      await api(`/api/payments/${encodeURIComponent(payment.id)}`, { method:'DELETE' });
      await refreshAdmin();
      toast('Payment deleted');
    } catch (err) { toast(err.message); }
  }
});
$('#changePasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    await api('/api/auth/change-password', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(formToObject(form)) });
    form.reset();
    toast('Password changed');
  } catch (err) { toast(err.message); }
});
$('#start2faBtn').addEventListener('click', async () => {
  try {
    const data = await api('/api/auth/setup-2fa');
    $('#twoFactorSetup').classList.remove('hidden');
    const preview = $('#twoFactorPreview');
    clear(preview);
    const qr = document.createElement('img');
    qr.alt = 'QR code';
    qr.src = String(data.qrDataUrl || '');
    preview.appendChild(qr);
    preview.appendChild(text('div', `Manual key: ${data.manualCode || ''}`));
    toast('Scan the QR code in your authenticator app');
  } catch (err) { toast(err.message); }
});
$('#enable2faForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    await api('/api/auth/enable-2fa', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(formToObject(form)) });
    $('#twoFactorSetup').classList.add('hidden');
    form.reset();
    await refreshAdmin();
    toast('2FA enabled');
  } catch (err) { toast(err.message); }
});
$('#disable2faForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    await api('/api/auth/disable-2fa', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(formToObject(form)) });
    form.reset();
    await refreshAdmin();
    toast('2FA disabled');
  } catch (err) { toast(err.message); }
});
$('#userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    const payload = formToObject(form);
    payload.active = form.active.checked;
    if (!payload.userId && !passwordPolicyHint(payload.password || '')) throw new Error('Use 10+ chars with upper, lower, number, symbol');
    const id = payload.userId;
    if (id) {
      delete payload.password;
      delete payload.username;
      await api(`/api/admin/users/${encodeURIComponent(id)}`, { method:'PUT', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
      toast('User updated');
    } else {
      await api('/api/admin/users', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) });
      toast('User created');
    }
    form.reset();
    form.userId.value = '';
    form.username.disabled = false;
    await refreshAdmin();
  } catch (err) { toast(err.message); }
});
$('#resetUserBtn').addEventListener('click', () => {
  const form = $('#userForm');
  form.reset();
  form.userId.value = '';
  form.username.disabled = false;
});
$('#userList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const user = (state.data.users || []).find((item) => item.id === btn.dataset.id);
  if (!user) return;
  if (btn.dataset.action === 'edit-user') {
    const form = $('#userForm');
    form.userId.value = user.id;
    form.fullName.value = user.fullName;
    form.username.value = user.username;
    form.username.disabled = true;
    form.email.value = user.email || '';
    form.role.value = user.role;
    form.active.checked = !!user.active;
    form.password.value = '';
    setTab('teamTab');
    window.scrollTo({ top: 0, behavior:'smooth' });
    return toast('User loaded into form');
  }
  if (btn.dataset.action === 'reset-user-password') {
    const modal = $('#resetPasswordModal');
    const form = $('#resetUserPasswordForm');
    form.userId.value = user.id;
    form.username.value = user.username;
    form.newPassword.value = '';
    form.confirmPassword.value = '';
    openModal('resetPasswordModal');
    form.newPassword.focus();
    return;
  }
  if (btn.dataset.action === 'delete-user') {
    if (!window.confirm(`Delete ${user.username}?`)) return;
    try {
      await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method:'DELETE' });
      await refreshAdmin();
      toast('User deleted');
    } catch (err) { toast(err.message); }
  }
});
$('#resetUserPasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const userId = form.userId.value;
  const newPassword = form.newPassword.value;
  const confirmPassword = form.confirmPassword.value;
  if (newPassword !== confirmPassword) return toast('Passwords do not match');
  if (!passwordPolicyHint(newPassword)) return toast('Use 10+ chars with upper, lower, number, symbol');
  try {
    await api(`/api/admin/users/${encodeURIComponent(userId)}/reset-password`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ newPassword }) });
    closeModal('resetPasswordModal');
    form.reset();
    await refreshAdmin();
    toast('Password reset');
  } catch (err) { toast(err.message); }
});
$('#cancelResetUserPasswordBtn').addEventListener('click', () => {
  closeModal('resetPasswordModal');
  $('#resetUserPasswordForm').reset();
});

$('#categoryRenameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    await api(`/api/categories/${encodeURIComponent(form.categoryId.value)}`, { method:'PUT', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ name: form.name.value }) });
    closeModal('categoryRenameModal');
    form.reset();
    await refreshAdmin();
    toast('Category renamed');
  } catch (err) { toast(err.message); }
});
$('#cancelCategoryRenameBtn').addEventListener('click', () => {
  closeModal('categoryRenameModal');
  $('#categoryRenameForm').reset();
});
document.addEventListener('click', (e) => {
  const modal = e.target.closest('.modal-backdrop');
  if (!modal || e.target.closest('.modal-card')) return;
  modal.classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $$('.modal-backdrop').forEach((modal) => modal.classList.add('hidden'));
    if (sidebar && window.innerWidth <= 980) {
      sidebar.classList.remove('open');
      $('#sidebarToggleBtn')?.setAttribute('aria-expanded', 'false');
    }
  }
});
$('#sidebarToggleBtn')?.addEventListener('click', () => {
  const open = sidebar.classList.toggle('open');
  $('#sidebarToggleBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
});

$('#adminAiQuickActions')?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-prompt]');
  if (!btn) return;
  $('#adminAiMessage').value = btn.dataset.prompt;
});
$('#adminAiUseArticleBtn')?.addEventListener('click', () => {
  const article = currentArticleContext();
  $('#adminAiMessage').value = `Use current article draft. Headline: ${article.title}. Summary: ${article.summary}. Content: ${article.content.slice(0, 1000)}.`;
});
$('#adminAiForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const output = $('#adminAiOutput');
  output.textContent = 'Working...';
  try {
    const data = await api('/api/admin/assistant', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ message: $('#adminAiMessage').value, context: { articleDraft: currentArticleContext() } }) });
    output.textContent = data.reply || 'No response.';
  } catch (err) {
    output.textContent = err.message;
  }
});
const logoInputEl = document.getElementById('logoInput');
const uploadLogoBtnEl = document.getElementById('uploadLogoBtn');
console.log('[admin] logo upload control IDs check', { logoInputFound: Boolean(logoInputEl), uploadLogoBtnFound: Boolean(uploadLogoBtnEl) });

$('#backupBtn').addEventListener('click', () => window.open('/api/admin/backup.json', '_blank', 'noopener'));
checkSession().catch(() => {
  toast('Server not running');
});
