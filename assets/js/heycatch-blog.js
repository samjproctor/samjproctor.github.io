/**
 * HeyCatch Blog Integration for Notebook Studio
 * Follows https://heycatch.ai/blog-agents.md exactly:
 * - Publishable read-only key sent exclusively via ?key= query parameter (no custom headers)
 * - Short 60-second cache revalidation with stale-if-error fallback and single 429 Retry-After retry
 * - Pagination loop fetching all articles (limit=50, offset += 50 until offset >= total)
 * - HTML sanitisation preserving h2[id] for Table of Contents and stripping script/style/iframe/on*/javascript:
 * - Automatic Table of Contents inserted right after Key takeaways list (or top of content_html)
 * - Dynamic <title>, meta description, Open Graph, Twitter, absolute canonical URL, JSON-LD, and lang/dir="rtl"
 */

export const HEYCATCH_API_KEY = 'hck_lv_c8fc952c1efb370b5f7aa1f4';
export const HEYCATCH_API_BASE = 'https://api.heycatch.ai/v1';
export const PRODUCTION_ORIGIN = 'https://samjproctor.github.io';
const CACHE_TTL_MS = 60 * 1000; // 60 seconds (within the 60-300s revalidation window)

export function getSiteBasePath() {
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/notebook-studio-website')) {
    return '/notebook-studio-website';
  }
  return '';
}

const ALLOWED_TAGS = new Set([
  'H2', 'H3', 'H4', 'H5', 'H6',
  'P', 'UL', 'OL', 'LI',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION',
  'BLOCKQUOTE', 'A', 'STRONG', 'B', 'EM', 'I', 'CODE', 'PRE',
  'HR', 'BR', 'SPAN', 'SUP', 'SUB', 'DEL', 'FIGURE', 'FIGCAPTION', 'IMG'
]);

const ALLOWED_ATTRS = new Set([
  'id', 'href', 'title', 'target', 'rel',
  'colspan', 'rowspan', 'scope', 'src', 'alt', 'width', 'height', 'loading', 'lang', 'dir'
]);

const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur']);

function getCache(cacheKey) {
  try {
    const raw = sessionStorage.getItem(cacheKey);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function setCache(cacheKey, data) {
  try {
    sessionStorage.setItem(cacheKey, JSON.stringify({
      timestamp: Date.now(),
      data
    }));
  } catch (_) {
    // Ignore storage quota errors
  }
}

/**
 * Fetch from HeyCatch API with ?key= query param ONLY (no custom headers).
 * Handles 429 Retry-After once, caches for 60s, and falls back to last good cached data on error.
 */
async function heycatchFetch(endpointPath, params = {}) {
  const url = new URL(`${HEYCATCH_API_BASE}${endpointPath}`);
  url.searchParams.set('key', HEYCATCH_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }
  const requestUrl = url.toString();
  const cacheKey = `hc_blog_${requestUrl}`;
  const cached = getCache(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { status: 200, data: cached.data, fromCache: true };
  }

  async function attemptFetch() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      // Strictly simple GET with no custom headers
      const res = await fetch(requestUrl, { signal: controller.signal });
      clearTimeout(timeoutId);
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  try {
    let res = await attemptFetch();

    // Handle 429 Too Many Requests: wait Retry-After seconds, then try once more
    if (res.status === 429) {
      const retryAfterHeader = res.headers.get('Retry-After');
      const waitSec = Math.min(Math.max(parseInt(retryAfterHeader || '2', 10) || 2, 1), 15);
      await new Promise((resolve) => setTimeout(resolve, waitSec * 1000));
      res = await attemptFetch();
    }

    if (res.status === 404) {
      return { status: 404, data: null };
    }

    if (res.status === 403 || res.status === 401) {
      return { status: res.status, data: null };
    }

    if (!res.ok) {
      if (cached) return { status: 200, data: cached.data, stale: true };
      return { status: res.status, data: null };
    }

    const data = await res.json();
    setCache(cacheKey, data);
    return { status: 200, data };
  } catch (_) {
    if (cached) {
      return { status: 200, data: cached.data, stale: true };
    }
    return { status: 0, data: null };
  }
}

/**
 * Fetch EVERY published article by looping offset += 50 until all articles are retrieved.
 */
export async function fetchAllArticles() {
  const limit = 50;
  let offset = 0;
  const allArticles = [];
  let total = 0;

  while (true) {
    const res = await heycatchFetch('/articles', { limit, offset });
    if (res.status !== 200 || !res.data || !Array.isArray(res.data.articles)) {
      if (allArticles.length > 0) break;
      return { ok: false, status: res.status, articles: [], total: 0 };
    }

    const batch = res.data.articles;
    total = typeof res.data.total === 'number' ? res.data.total : batch.length;
    allArticles.push(...batch);

    offset += limit;
    if (batch.length === 0 || allArticles.length >= total || batch.length < limit) {
      break;
    }
  }

  return { ok: true, status: 200, articles: allArticles, total };
}

/**
 * Fetch a single article by slug (URL-encoded).
 */
export async function fetchArticleBySlug(slug) {
  const encodedSlug = encodeURIComponent(slug);
  return heycatchFetch(`/articles/${encodedSlug}`);
}

/**
 * Sanitise content_html before insertion.
 * Uses DOMPurify if loaded, plus a strict DOM whitelist walker that keeps headings (including h2[id]),
 * paragraphs, lists, tables, links, blockquotes, strong, em, and code, while dropping script, style,
 * iframe, on* attributes, and javascript:/data: URLs.
 */
let domPurifyPromise = null;
async function getDOMPurify() {
  if (!domPurifyPromise) {
    domPurifyPromise = import('https://esm.sh/dompurify@3.1.7')
      .then((mod) => mod.default || mod)
      .catch(() => null);
  }
  return domPurifyPromise;
}

export async function sanitizeArticleHtml(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') return '';

  let htmlToParse = rawHtml;
  const DOMPurify = await getDOMPurify();
  if (DOMPurify && typeof DOMPurify.sanitize === 'function') {
    htmlToParse = DOMPurify.sanitize(rawHtml, {
      ALLOWED_TAGS: Array.from(ALLOWED_TAGS).map((t) => t.toLowerCase()),
      ALLOWED_ATTR: Array.from(ALLOWED_ATTRS),
      ALLOW_DATA_ATTR: false
    });
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${htmlToParse}</div>`, 'text/html');
  const root = doc.body.firstElementChild;

  function cleanNode(node) {
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName.toUpperCase();
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IFRAME' || tag === 'OBJECT' || tag === 'EMBED' || tag === 'FORM') {
          child.remove();
          continue;
        }
        if (!ALLOWED_TAGS.has(tag)) {
          // Unwrap disallowed formatting container while cleaning its children, or drop if unsafe
          cleanNode(child);
          while (child.firstChild) {
            node.insertBefore(child.firstChild, child);
          }
          child.remove();
          continue;
        }

        // Clean attributes
        const attrs = Array.from(child.attributes);
        for (const attr of attrs) {
          const name = attr.name.toLowerCase();
          const val = (attr.value || '').trim();
          if (name.startsWith('on') || !ALLOWED_ATTRS.has(name)) {
            child.removeAttribute(attr.name);
            continue;
          }
          if (name === 'href' || name === 'src') {
            const lowerVal = val.toLowerCase().replace(/\s+/g, '');
            if (lowerVal.startsWith('javascript:') || lowerVal.startsWith('vbscript:') || lowerVal.startsWith('data:text/html')) {
              child.removeAttribute(attr.name);
              continue;
            }
          }
          if (name === 'id' && tag !== 'H2' && tag !== 'H3' && tag !== 'H4') {
            child.removeAttribute('id');
          }
        }

        if (tag === 'A') {
          const href = child.getAttribute('href') || '';
          if (/^https?:\/\//i.test(href) && !href.startsWith(PRODUCTION_ORIGIN)) {
            child.setAttribute('rel', 'noopener noreferrer');
          }
        }

        cleanNode(child);
      } else if (child.nodeType === Node.COMMENT_NODE) {
        child.remove();
      }
    }
  }

  if (root) {
    cleanNode(root);
    return root.innerHTML;
  }
  return '';
}

/**
 * Format ISO date (e.g. "2026-10-14") into readable date (e.g. "October 14, 2026").
 */
export function formatPublishedDate(dateStr) {
  if (!dateStr) return '';
  try {
    const iso = dateStr.length === 10 ? `${dateStr}T00:00:00Z` : dateStr;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC'
    });
  } catch (_) {
    return dateStr;
  }
}

/**
 * Build a DocumentFragment from sanitised HTML and inject the Table of Contents
 * in the exact position specified in Step 3:
 * - Under a "Table of contents" heading
 * - Right after the Key takeaways list (the list following <h2>Key takeaways</h2>) and before the rest of content_html;
 *   with no takeaways, above content_html.
 * - One link per <h2> in content_html that has an id, except id="faq", in order: heading's text linking to #<id>.
 * - Never rename or re-slug an id.
 * - If no heading qualifies, leave the Table of contents out.
 */
export function buildArticleFragmentWithToc(sanitizedHtml) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = sanitizedHtml;

  // Read qualifying <h2> headings from the sanitised HTML we render
  const allH2s = Array.from(wrapper.querySelectorAll('h2'));
  const tocItems = [];

  for (const h2 of allH2s) {
    const rawId = h2.getAttribute('id');
    if (!rawId) continue;
    if (rawId.trim().toLowerCase() === 'faq') continue;
    const text = (h2.textContent || '').trim();
    if (!text) continue;
    tocItems.push({ id: rawId, text });
  }

  if (tocItems.length > 0) {
    const tocNav = document.createElement('nav');
    tocNav.className = 'blog-toc';
    tocNav.setAttribute('aria-label', 'Table of contents');

    const tocHeading = document.createElement('h2');
    tocHeading.className = 'blog-toc-title';
    tocHeading.textContent = 'Table of contents';
    tocNav.appendChild(tocHeading);

    const tocList = document.createElement('ol');
    tocList.className = 'blog-toc-list';

    for (const item of tocItems) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.setAttribute('href', `#${item.id}`);
      a.textContent = item.text;
      li.appendChild(a);
      tocList.appendChild(li);
    }
    tocNav.appendChild(tocList);

    // Find <h2>Key takeaways</h2> (which has no id) and its following list
    const keyTakeawaysH2 = allH2s.find(
      (h) => !h.getAttribute('id') && (h.textContent || '').trim().toLowerCase() === 'key takeaways'
    );

    if (keyTakeawaysH2) {
      let insertAfterEl = keyTakeawaysH2;
      let nextEl = keyTakeawaysH2.nextElementSibling;
      while (nextEl && (nextEl.tagName === 'UL' || nextEl.tagName === 'OL')) {
        insertAfterEl = nextEl;
        break;
      }
      insertAfterEl.insertAdjacentElement('afterend', tocNav);
    } else {
      wrapper.insertBefore(tocNav, wrapper.firstChild);
    }
  }

  return wrapper;
}

/**
 * Set head tags for an article page per Step 4:
 * - <title> from article.title
 * - <meta name="description"> from article.meta_description
 * - og:title, og:description, og:type="article", twitter:description
 * - Absolute <link rel="canonical" href="https://<production domain>/blog/<slug>">
 * - JSON-LD script in <head> with every '<' written as '\u003c'
 */
export function updateArticleHeadMeta(article) {
  const slug = encodeURIComponent(article.slug || '');
  const canonicalUrl = `${PRODUCTION_ORIGIN}/blog/${slug}`;
  const title = article.title || 'Blog — Notebook Studio';
  const metaDesc = article.meta_description || '';

  document.title = title;

  function setMeta(selector, attrName, attrValue, contentValue) {
    let el = document.head.querySelector(selector);
    if (!el) {
      el = document.createElement('meta');
      el.setAttribute(attrName, attrValue);
      document.head.appendChild(el);
    }
    el.setAttribute('content', contentValue);
  }

  setMeta('meta[name="robots"]', 'name', 'robots', 'index, follow');
  setMeta('meta[name="description"]', 'name', 'description', metaDesc);
  setMeta('meta[property="og:title"]', 'property', 'og:title', title);
  setMeta('meta[property="og:description"]', 'property', 'og:description', metaDesc);
  setMeta('meta[property="og:type"]', 'property', 'og:type', 'article');
  setMeta('meta[property="og:url"]', 'property', 'og:url', canonicalUrl);
  setMeta('meta[name="twitter:description"]', 'name', 'twitter:description', metaDesc);

  let canonicalEl = document.head.querySelector('link[rel="canonical"]');
  if (!canonicalEl) {
    canonicalEl = document.createElement('link');
    canonicalEl.setAttribute('rel', 'canonical');
    document.head.appendChild(canonicalEl);
  }
  canonicalEl.setAttribute('href', canonicalUrl);

  // Remove any previous article JSON-LD
  const existingLd = document.getElementById('heycatch-article-jsonld');
  if (existingLd) existingLd.remove();

  if (article.jsonLd && typeof article.jsonLd === 'object' && Object.keys(article.jsonLd).length > 0) {
    const ldCopy = { ...article.jsonLd };
    if (!ldCopy.url) {
      ldCopy.url = canonicalUrl;
      ldCopy.mainEntityOfPage = canonicalUrl;
    }
    const ldScript = document.createElement('script');
    ldScript.type = 'application/ld+json';
    ldScript.id = 'heycatch-article-jsonld';
    ldScript.textContent = JSON.stringify(ldCopy).replace(/</g, '\\u003c');
    document.head.appendChild(ldScript);
  }
}

/**
 * Toggle the "Blog" link in the main navigation:
 * Hidden while total === 0, visible when total > 0.
 */
export async function initBlogNavigation() {
  const navItems = document.querySelectorAll('.nav-blog-item');
  if (navItems.length === 0) return;

  const res = await heycatchFetch('/articles', { limit: 1, offset: 0 });
  const hasArticles = res.status === 200 && res.data && typeof res.data.total === 'number' && res.data.total > 0;

  navItems.forEach((el) => {
    if (hasArticles) {
      el.removeAttribute('hidden');
    } else {
      el.setAttribute('hidden', '');
    }
  });
}

/**
 * Render the /blog index inside `mountEl`.
 * Strict adherence to Step 3:
 * - One entry per article: title (linking to /blog/{slug}), published date, and read time. Nothing else (no meta_description excerpt).
 * - If empty: render "No articles yet".
 */
export async function renderBlogIndexPage(mountEl, { basePath = getSiteBasePath(), onNavigateSlug = null } = {}) {
  mountEl.innerHTML = `
    <div class="section-header" style="margin-bottom: 2.5rem;">
      <div class="eyebrow-pill">Notebook Studio Journal</div>
      <h1 class="section-title">Blog</h1>
    </div>
    <div id="blog-list-region" aria-live="polite" class="blog-index-region">
      <p class="blog-loading-text">Loading articles…</p>
    </div>
  `;

  const listRegion = mountEl.querySelector('#blog-list-region');
  const result = await fetchAllArticles();

  if (!result.ok || result.articles.length === 0) {
    listRegion.innerHTML = `
      <div class="blog-empty-state">
        <p>No articles yet</p>
      </div>
    `;
    return;
  }

  // Optional query-parameter pagination (/blog?page=2) if total > 50, while still fetching all
  const params = new URLSearchParams(window.location.search);
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(result.articles.length / pageSize));
  const currentPage = Math.min(Math.max(parseInt(params.get('page') || '1', 10) || 1, 1), totalPages);
  const pageArticles = result.articles.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const ul = document.createElement('ul');
  ul.className = 'blog-index-list';

  for (const article of pageArticles) {
    const li = document.createElement('li');
    li.className = 'blog-index-item';

    // Optional featured/hero image ONLY if non-empty URL (Step 3: do not add placeholder if empty)
    const imageUrl = (article.hero_image_url || article.featured_image || '').trim();
    if (imageUrl) {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = article.title || '';
      img.className = 'blog-index-image';
      img.loading = 'lazy';
      li.appendChild(img);
    }

    const link = document.createElement('a');
    const encodedSlug = encodeURIComponent(article.slug || article.id || '');
    const href = `${basePath}/blog/${encodedSlug}`;
    link.href = href;
    link.className = 'blog-index-link';
    link.textContent = article.title || 'Untitled article';

    if (typeof onNavigateSlug === 'function') {
      link.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onNavigateSlug(article.slug || article.id);
      });
    }

    const metaDiv = document.createElement('div');
    metaDiv.className = 'blog-meta';

    const pubDate = article.published || article.published_at || '';
    if (pubDate) {
      const timeEl = document.createElement('time');
      timeEl.setAttribute('datetime', pubDate);
      timeEl.textContent = formatPublishedDate(pubDate);
      metaDiv.appendChild(timeEl);
    }

    if (typeof article.read_time === 'number' && article.read_time > 0) {
      if (metaDiv.childNodes.length > 0) {
        const sep = document.createElement('span');
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '•';
        metaDiv.appendChild(sep);
      }
      const rtSpan = document.createElement('span');
      rtSpan.textContent = `${article.read_time} min read`;
      metaDiv.appendChild(rtSpan);
    }

    li.appendChild(link);
    li.appendChild(metaDiv);
    ul.appendChild(li);
  }

  listRegion.innerHTML = '';
  listRegion.appendChild(ul);

  if (totalPages > 1) {
    const pager = document.createElement('nav');
    pager.className = 'blog-pagination';
    pager.setAttribute('aria-label', 'Blog pagination');
    for (let p = 1; p <= totalPages; p++) {
      const pageLink = document.createElement('a');
      pageLink.href = p === 1 ? `${basePath}/blog` : `${basePath}/blog?page=${p}`;
      pageLink.className = p === currentPage ? 'btn btn-primary' : 'btn btn-secondary';
      pageLink.textContent = `Page ${p}`;
      pager.appendChild(pageLink);
    }
    listRegion.appendChild(pager);
  }
}

/**
 * Render a single article (/blog/{slug}) inside `mountEl`.
 * Strict adherence to Step 3 & Step 4:
 * - Title as the page's only <h1>, with published date and read time near it. Nothing else under title (no subtitle).
 * - Sanitised content_html with Table of Contents injected right after Key takeaways list (or top of content_html).
 * - Language & RTL handling when article.language differs from site language ('en').
 * - Unknown slug (404): renders the site's 404 state.
 */
export async function renderBlogArticlePage(mountEl, slug, { basePath = getSiteBasePath(), onBackToIndex = null } = {}) {
  mountEl.innerHTML = `
    <div class="blog-article-loading" aria-live="polite">
      <p class="blog-loading-text">Loading article…</p>
    </div>
  `;

  const res = await fetchArticleBySlug(slug);

  if (res.status === 404 || !res.data || !res.data.article) {
    document.title = 'Page Not Found — Notebook Studio';
    mountEl.innerHTML = `
      <div class="blog-404-card">
        <div class="eyebrow-pill">404 • Page Not Found</div>
        <h1 style="font-size: clamp(2rem, 1.5rem + 2vw, 3rem); font-weight: 900; margin-bottom: 0.75rem;">
          This article could not be found.
        </h1>
        <p style="color: var(--text-secondary); margin-bottom: 1.75rem;">
          The article you requested does not exist or may have moved.
        </p>
        <div style="display: flex; flex-wrap: wrap; gap: 0.85rem; justify-content: center;">
          <a href="${basePath}/blog" class="btn btn-primary">Back to Blog</a>
          <a href="${basePath}/" class="btn btn-secondary">Notebook Studio Home</a>
        </div>
      </div>
    `;
    return { found: false, status: 404 };
  }

  const article = res.data.article;
  updateArticleHeadMeta(article);

  const sanitizedHtml = await sanitizeArticleHtml(article.content_html || '');
  const contentWithToc = buildArticleFragmentWithToc(sanitizedHtml);

  const articleEl = document.createElement('article');
  articleEl.className = 'blog-article';

  // Language & RTL support (Step 4)
  const lang = (article.language || '').trim();
  if (lang && lang.toLowerCase() !== 'en') {
    articleEl.setAttribute('lang', lang);
    const baseLang = lang.toLowerCase().split('-')[0];
    if (RTL_LANGS.has(baseLang)) {
      articleEl.setAttribute('dir', 'rtl');
    }
  }

  // Back link
  const backWrap = document.createElement('div');
  backWrap.className = 'blog-back-row';
  const backLink = document.createElement('a');
  backLink.href = `${basePath}/blog`;
  backLink.className = 'blog-back-link';
  backLink.textContent = '← Back to Blog';
  if (typeof onBackToIndex === 'function') {
    backLink.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      onBackToIndex();
    });
  }
  backWrap.appendChild(backLink);
  articleEl.appendChild(backWrap);

  // Header: ONLY <h1> title + published date & read time near it (NO subtitle or meta_description!)
  const headerEl = document.createElement('header');
  headerEl.className = 'blog-article-header';

  const h1 = document.createElement('h1');
  h1.className = 'blog-article-title';
  h1.textContent = article.title || '';

  const metaDiv = document.createElement('div');
  metaDiv.className = 'blog-meta';

  const pubDate = article.published || article.published_at || '';
  if (pubDate) {
    const timeEl = document.createElement('time');
    timeEl.setAttribute('datetime', pubDate);
    timeEl.textContent = formatPublishedDate(pubDate);
    metaDiv.appendChild(timeEl);
  }

  if (typeof article.read_time === 'number' && article.read_time > 0) {
    if (metaDiv.childNodes.length > 0) {
      const sep = document.createElement('span');
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '•';
      metaDiv.appendChild(sep);
    }
    const rtSpan = document.createElement('span');
    rtSpan.textContent = `${article.read_time} min read`;
    metaDiv.appendChild(rtSpan);
  }

  headerEl.appendChild(h1);
  headerEl.appendChild(metaDiv);
  articleEl.appendChild(headerEl);

  // Optional featured/hero image ONLY if non-empty URL (Step 3)
  const heroUrl = (article.hero_image_url || article.featured_image || '').trim();
  if (heroUrl) {
    const heroImg = document.createElement('img');
    heroImg.src = heroUrl;
    heroImg.alt = article.title || '';
    heroImg.className = 'blog-article-hero-image';
    articleEl.appendChild(heroImg);
  }

  // Body content_html + Table of Contents
  const proseDiv = document.createElement('div');
  proseDiv.className = 'blog-prose';
  while (contentWithToc.firstChild) {
    proseDiv.appendChild(contentWithToc.firstChild);
  }
  articleEl.appendChild(proseDiv);

  mountEl.innerHTML = '';
  mountEl.appendChild(articleEl);
  return { found: true, status: 200, article };
}
