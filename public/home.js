    const placeholder = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><rect width="100%" height="100%" fill="#ddd"/><text x="50%" y="50%" font-size="42" text-anchor="middle" fill="#777" font-family="Arial">Namo Bharat News 24</text></svg>');
    const byId = (id) => document.getElementById(id);
    const state = { settings:{}, categories:[], articles:[], search:'' };

    function formatDate(value){
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? 'अभी' : new Intl.DateTimeFormat('hi-IN',{dateStyle:'medium',timeStyle:'short'}).format(d);
    }
    function scoreArticle(article, query){
      const q = String(query || '').trim().toLowerCase();
      if(!q) return 1;
      return [article.title, article.category, article.location, article.summary, article.content].join(' ').toLowerCase().includes(q) ? 1 : 0;
    }
    function filteredArticles(){
      return state.articles.filter((article) => scoreArticle(article, state.search));
    }

    function sanitizeImageCandidate(value){
      const clean = String(value || '').trim();
      if(!clean) return '';
      if(/^\/uploads\/[a-zA-Z0-9._-]+$/.test(clean)) return clean;
      if(/^https:\/\/[^\s]+$/i.test(clean)) return clean;
      return '';
    }
    function firstValidLogo(candidates, fallback = ''){
      for(const candidate of candidates || []){
        const safe = sanitizeImageCandidate(candidate);
        if(safe) return safe;
      }
      return fallback;
    }
    function renderSiteLogo(settings){
      const wrap = byId('siteLogo');
      if(!wrap) return;
      const logoUrl = firstValidLogo([settings.logo, settings.logoUrl, settings?.branding?.logo, settings.favicon], '');
      wrap.textContent = '';
      if(!logoUrl){
        wrap.textContent = 'NB';
        return;
      }
      const img = document.createElement('img');
      img.alt = 'logo';
      img.src = logoUrl;
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
      img.addEventListener('error', () => {
        wrap.textContent = 'NB';
      }, { once:true });
      wrap.appendChild(img);
    }
    function applyTheme(settings){
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
      const faviconHref = firstValidLogo([settings.favicon, settings.logo, settings.logoUrl, settings?.branding?.logo], '/favicon.ico');
      let link = document.querySelector('link[rel="icon"]');
      if(!link){
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = `${faviconHref}${faviconHref.includes('?') ? '&' : '?'}v=${Date.now()}`;
    }
    function renderHero(){
      const heroId = state.settings.heroArticleId;
      const pool = filteredArticles();
      const article = pool.find((item) => item.id === heroId) || pool[0] || state.articles[0];
      if(!article) return;
      const heroImage = byId('heroImage');
      heroImage.textContent = '';
      const img = document.createElement('img');
      img.alt = '';
      img.src = article.image || placeholder;
      heroImage.appendChild(img);
      const heroMeta = byId('heroMeta');
      heroMeta.textContent = '';
      [article.category, article.location, formatDate(article.publishedAt)].forEach((value) => {
        const span = document.createElement('span');
        span.textContent = value || '—';
        heroMeta.appendChild(span);
      });
      byId('heroTitle').textContent = article.title;
      byId('heroSummary').textContent = article.summary || '';
    }
    function createAdMedia({ image, link, alt }){
      const img = document.createElement('img');
      img.src = image;
      img.alt = alt || 'Advertisement';
      img.loading = 'lazy';
      if (!link) return img;
      const anchor = document.createElement('a');
      anchor.href = link;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer sponsored';
      anchor.appendChild(img);
      return anchor;
    }
    function renderAds(){
      const s = state.settings || {};
      const bannerMount = byId('homepageBannerAd');
      const sidebarMount = byId('homepageSidebarAd');

      if (bannerMount) {
        const canShowBanner = !!(s.homepageBannerEnabled && s.homepageBannerImage);
        bannerMount.textContent = '';
        bannerMount.classList.toggle('hidden', !canShowBanner);
        if (canShowBanner) {
          const label = document.createElement('div');
          label.className = 'ad-label';
          label.textContent = 'Advertisement';
          bannerMount.append(label, createAdMedia({ image: s.homepageBannerImage, link: s.homepageBannerLink, alt: s.homepageBannerAlt }));
        }
      }

      if (sidebarMount) {
        const desktop = window.matchMedia('(min-width: 981px)').matches;
        const canShowSidebar = !!(desktop && s.homepageSidebarAdEnabled && s.homepageSidebarAdImage);
        sidebarMount.textContent = '';
        sidebarMount.classList.toggle('hidden', !canShowSidebar);
        if (canShowSidebar) {
          const label = document.createElement('div');
          label.className = 'ad-label';
          label.textContent = 'Advertisement';
          sidebarMount.append(label, createAdMedia({ image: s.homepageSidebarAdImage, link: s.homepageSidebarAdLink, alt: s.homepageSidebarAdAlt }));
        }
      }
    }

    function renderTrending(){
      const items = filteredArticles().filter((item) => item.trending || item.featured).slice(0, 6);
      const mount = byId('trendingList');
      mount.textContent = '';
      if(!items.length){
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'कोई ट्रेंडिंग खबर नहीं';
        mount.appendChild(empty);
        return;
      }
      items.forEach((item) => {
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
      filteredArticles().forEach((article) => {
        groups[article.category] = groups[article.category] || [];
        groups[article.category].push(article);
      });
      mount.textContent = '';
      const activeCategories = state.categories.filter((cat) => cat.enabled && visible[cat.name] !== false && groups[cat.name]?.length);
      if(!activeCategories.length){
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = state.search ? 'इस खोज के लिए कोई खबर नहीं मिली।' : 'अभी कोई खबर उपलब्ध नहीं है।';
        mount.appendChild(empty);
        return;
      }
      activeCategories.forEach((cat) => {
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
        groups[cat.name].slice(0,6).forEach((article) => {
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
      const shown = filteredArticles().length;
      byId('searchSummary').textContent = state.search ? `"${state.search}" के लिए ${shown} खबरें मिलीं।` : 'सभी खबरें दिख रही हैं।';
    }
    function renderNav(){
      const nav = byId('navChips');
      nav.textContent = '';
      state.categories.forEach((cat) => {
        const chip = document.createElement('button');
        chip.className = 'nav-chip';
        chip.type = 'button';
        chip.textContent = cat.name;
        chip.addEventListener('click', () => {
          state.search = cat.name;
          byId('publicSearch').value = cat.name;
          renderHero();
          renderTrending();
          renderSections();
        });
        nav.appendChild(chip);
      });
    }
    async function askAssistant(message){
      const output = byId('assistantOutput');
      output.textContent = 'सोच रहा है...';
      try {
        const res = await fetch('/api/assistant/public', { method:'POST', credentials:'same-origin', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ message }) });
        const data = await res.json();
        output.textContent = data.reply || 'उत्तर उपलब्ध नहीं है।';
      } catch {
        output.textContent = 'सहायक अभी उपलब्ध नहीं है।';
      }
    }
    async function loadSite(){
      const res = await fetch('/api/site', { credentials:'same-origin' });
      const data = await res.json();
      state.settings = data.settings || {};
      state.categories = data.categories || [];
      state.articles = (data.articles || []).sort((a,b)=>new Date(b.publishedAt)-new Date(a.publishedAt));
      applyTheme(state.settings);
      renderNav();
      renderAds();
      renderHero();
      renderTrending();
      renderSections();
      byId('todayLine').textContent = new Intl.DateTimeFormat('hi-IN',{dateStyle:'full',timeStyle:'short'}).format(new Date());
    }
    byId('publicSearch').addEventListener('input', (e) => {
      state.search = e.target.value || '';
      renderHero();
      renderTrending();
      renderSections();
    });
    byId('assistantToggleBtn').addEventListener('click', () => byId('assistantDrawer').classList.toggle('hidden'));
    byId('assistantCloseBtn').addEventListener('click', () => byId('assistantDrawer').classList.add('hidden'));
    byId('assistantForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      await askAssistant(byId('assistantMessage').value);
    });
    byId('assistantForm').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-prompt]');
      if(!btn) return;
      byId('assistantMessage').value = btn.dataset.prompt;
      await askAssistant(btn.dataset.prompt);
    });
    window.addEventListener('resize', renderAds);
    loadSite().catch(() => {
      const mount = byId('sectionsMount');
      mount.textContent = '';
      const empty = document.createElement('div');
      empty.className='empty';
      empty.textContent='साइट डेटा लोड नहीं हो पाया। सर्वर चालू है या नहीं, यह जांचें।';
      mount.appendChild(empty);
    });
  
