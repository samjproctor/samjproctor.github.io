#!/usr/bin/env node
/**
 * Pre-renders HeyCatch Blog (/blog index, /blog/{slug}/index.html, and sitemap.xml)
 * while preserving live client-side revalidation via assets/js/heycatch-blog.js.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const HEYCATCH_API_KEY = process.env.HEYCATCH_API_KEY || 'hck_lv_c8fc952c1efb370b5f7aa1f4';
const HEYCATCH_API_BASE = process.env.HEYCATCH_API_BASE || 'https://api.heycatch.ai/v1';
const PRODUCTION_ORIGIN = 'https://samjproctor.github.io';
const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur']);

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatPublishedDate(dateStr) {
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
  } catch {
    return dateStr;
  }
}

/**
 * Sanitise content_html and inject Table of Contents right after Key takeaways list
 * (or at the top of content_html if no Key takeaways), linking to each h2[id] except id="faq".
 */
function sanitizeAndInjectToc(rawHtml) {
  if (!rawHtml || typeof rawHtml !== 'string') return '';

  // Strip script, style, iframe, object, embed, inline event handlers, and javascript: URLs
  let cleaned = rawHtml
    .replace(/<(script|style|iframe|object|embed|form)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\b(href|src)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, '$1=$2#$2');

  // Extract qualifying <h2 id="...">headings</h2> (excluding id="faq")
  const h2Regex = /<h2\b([^>]*)>([\s\S]*?)<\/h2>/gi;
  const tocItems = [];
  let match;
  while ((match = h2Regex.exec(cleaned)) !== null) {
    const attrs = match[1] || '';
    const innerHtml = match[2] || '';
    const idMatch = attrs.match(/\bid\s*=\s*(?:"([^"]+)"|'([^']+)')/i);
    const idVal = idMatch ? (idMatch[1] || idMatch[2] || '').trim() : '';
    if (!idVal || idVal.toLowerCase() === 'faq') continue;
    const plainText = innerHtml.replace(/<[^>]+>/g, '').trim();
    if (!plainText) continue;
    tocItems.push({ id: idVal, text: plainText });
  }

  if (tocItems.length === 0) {
    return cleaned;
  }

  const tocLinksHtml = tocItems
    .map((item) => `<li><a href="#${escapeHtml(item.id)}">${escapeHtml(item.text)}</a></li>`)
    .join('\n          ');

  const tocBlock = `<nav class="blog-toc" aria-label="Table of contents">
        <h2 class="blog-toc-title">Table of contents</h2>
        <ol class="blog-toc-list">
          ${tocLinksHtml}
        </ol>
      </nav>`;

  // Place right after Key takeaways list (<h2>Key takeaways</h2> followed by <ul>...</ul> or <ol>...</ol>)
  const takeawaysListRegex = /(<h2(?![^>]*\bid=)[^>]*>\s*Key takeaways\s*<\/h2>\s*<(ul|ol)\b[^>]*>[\s\S]*?<\/\2>)/i;
  if (takeawaysListRegex.test(cleaned)) {
    return cleaned.replace(takeawaysListRegex, `$1\n      ${tocBlock}`);
  }

  return `${tocBlock}\n      ${cleaned}`;
}

async function fetchAllArticles() {
  const limit = 50;
  let offset = 0;
  const all = [];
  let total = 0;

  while (true) {
    const url = `${HEYCATCH_API_BASE}/articles?key=${encodeURIComponent(HEYCATCH_API_KEY)}&limit=${limit}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) break;
    const data = await res.json();
    const batch = Array.isArray(data.articles) ? data.articles : [];
    total = typeof data.total === 'number' ? data.total : batch.length;
    all.push(...batch);
    offset += limit;
    if (batch.length === 0 || all.length >= total || batch.length < limit) break;
  }
  return all;
}

async function fetchFullArticle(slug) {
  const url = `${HEYCATCH_API_BASE}/articles/${encodeURIComponent(slug)}?key=${encodeURIComponent(HEYCATCH_API_KEY)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data && data.article ? data.article : null;
}

function buildArticlePageHtml(article) {
  const slug = encodeURIComponent(article.slug || article.id || '');
  const canonicalUrl = `${PRODUCTION_ORIGIN}/blog/${slug}`;
  const title = escapeHtml(article.title || 'Blog — Notebook Studio');
  const metaDesc = escapeHtml(article.meta_description || '');
  const pubDate = article.published || article.published_at || '';
  const formattedDate = escapeHtml(formatPublishedDate(pubDate));
  const readTime = typeof article.read_time === 'number' && article.read_time > 0 ? `${article.read_time} min read` : '';

  const lang = (article.language || 'en').trim();
  const isCustomLang = lang && lang.toLowerCase() !== 'en';
  const baseLang = lang.toLowerCase().split('-')[0];
  const isRtl = RTL_LANGS.has(baseLang);
  const articleLangAttrs = `${isCustomLang ? ` lang="${escapeHtml(lang)}"` : ''}${isRtl ? ' dir="rtl"' : ''}`;

  let jsonLdScript = '';
  if (article.jsonLd && typeof article.jsonLd === 'object' && Object.keys(article.jsonLd).length > 0) {
    const ldCopy = { ...article.jsonLd };
    if (!ldCopy.url) {
      ldCopy.url = canonicalUrl;
      ldCopy.mainEntityOfPage = canonicalUrl;
    }
    const serialized = JSON.stringify(ldCopy).replace(/</g, '\\u003c');
    jsonLdScript = `\n  <script type="application/ld+json" id="heycatch-article-jsonld">${serialized}</script>`;
  }

  const heroUrl = (article.hero_image_url || article.featured_image || '').trim();
  const heroHtml = heroUrl
    ? `\n        <img src="${escapeHtml(heroUrl)}" alt="${title}" class="blog-article-hero-image">`
    : '';

  const bodyHtml = sanitizeAndInjectToc(article.content_html || '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <meta name="robots" content="index, follow">
  <meta http-equiv="X-Content-Type-Options" content="nosniff">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <title>${title}</title>
  <meta name="description" content="${metaDesc}">
  <link rel="canonical" href="${canonicalUrl}">
  <meta name="apple-itunes-app" content="app-id=6811397092">

  <meta property="og:type" content="article">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${metaDesc}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:description" content="${metaDesc}">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "notebook-studio.com",
    "alternateName": "Notebook Studio",
    "url": "https://www.notebook-studio.com",
    "logo": "https://samjproctor.github.io/notebook-studio-website/assets/icons/app-icon-1024.png",
    "email": "support@notebook-studio.com",
    "sameAs": [
      "https://apps.apple.com/gb/app/notebook-studio-pdf-designer/id6811397092",
      "https://samjproctor.github.io/notebook-studio-website/",
      "https://www.notebook-studio.com"
    ]
  }
  </script>${jsonLdScript}

  <link rel="icon" type="image/svg+xml" href="../../assets/icons/app-logo.svg">
  <link rel="icon" type="image/png" sizes="58x58" href="../../assets/icons/favicon-58.png">
  <link rel="apple-touch-icon" href="../../assets/icons/apple-touch-icon.png">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">

  <link rel="stylesheet" href="../../styles.css">

  <script type="module">
    import { analytics } from 'https://esm.sh/@heycatch/sdk@0.8.3';

    analytics.init({
      projectKey: 'hck_pk_Mr3rc7qC2evDjixgxFK5U9Qc_7A5M3E7',
      requestBatching: false,
      install: {
        framework: 'web',
        agent: 'other',
      },
    });
  </script>
</head>
<body>
  <a href="#main-content" class="skip-link">Skip to main content</a>

  <header class="site-header">
    <div class="container nav-inner">
      <a href="../../index.html" class="brand-lockup" aria-label="Notebook Studio Home">
        <img src="../../assets/icons/app-logo.svg" alt="Notebook Studio App Icon" class="brand-logo" width="40" height="40">
        <span>Notebook Studio</span>
        <span class="brand-badge">iPhone, iPad &amp; Mac</span>
      </a>

      <nav aria-label="Primary Navigation">
        <ul class="nav-links">
          <li><a href="../../index.html#iphone-showcase">App Walkthrough</a></li>
          <li><a href="../../index.html#features">Studio Features</a></li>
          <li><a href="../../index.html#devices">Supported Tablets</a></li>
          <li><a href="../../pricing.html">Pricing ($6.99)</a></li>
          <li class="nav-blog-item"><a href="../../blog" aria-current="page">Blog</a></li>
          <li><a href="../../index.html#faq">FAQ</a></li>
          <li><a href="../../support.html">Support</a></li>
        </ul>
      </nav>

      <div class="nav-actions">
        <button type="button" class="theme-toggle" id="theme-toggle-btn" aria-label="Toggle color theme" title="Toggle light/dark mode">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4"></circle>
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path>
          </svg>
        </button>
        <a href="https://apps.apple.com/gb/app/notebook-studio-pdf-designer/id6811397092" target="_blank" rel="noopener noreferrer" class="btn btn-primary">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.33c.64-.78 1.08-1.86.96-2.94-.93.04-2.06.62-2.72 1.4-.58.68-1.1 1.79-.96 2.84 1.04.08 2.08-.52 2.72-1.3z"/>
          </svg>
          <span>Get the App • $6.99</span>
        </a>
      </div>
    </div>
  </header>

  <main id="main-content" class="section">
    <div class="container blog-shell" id="blog-post-mount">
      <article class="blog-article"${articleLangAttrs}>
        <div class="blog-back-row">
          <a href="../../blog" class="blog-back-link">← Back to Blog</a>
        </div>
        <header class="blog-article-header">
          <h1 class="blog-article-title">${title}</h1>
          <div class="blog-meta">
            ${pubDate ? `<time datetime="${escapeHtml(pubDate)}">${formattedDate}</time>` : ''}
            ${pubDate && readTime ? '<span aria-hidden="true">•</span>' : ''}
            ${readTime ? `<span>${escapeHtml(readTime)}</span>` : ''}
          </div>
        </header>${heroHtml}
        <div class="blog-prose">
          ${bodyHtml}
        </div>
      </article>
    </div>
  </main>

  <footer class="site-footer">
    <div class="container footer-grid">
      <div>
        <div class="brand-lockup" style="margin-bottom: 0.5rem;">
          <img src="../../assets/icons/app-logo.svg" alt="Notebook Studio Logo" class="brand-logo" width="32" height="32" loading="lazy">
          <span>Notebook Studio: PDF Designer</span>
        </div>
        <p>© 2026 notebook-studio.com (Notebook Studio). All rights reserved. • Built for iPhone, iPad &amp; Mac.</p>
        <p style="margin-top: 0.25rem;">
          <a href="../../about.html">About notebook-studio.com</a> · <a href="../../contact.html">Contact</a> · <a href="mailto:support@notebook-studio.com" style="color: var(--brand-accent); font-weight: 600;">support@notebook-studio.com</a>
        </p>
      </div>

      <ul class="footer-links">
        <li><a href="../../index.html">Home</a></li>
        <li><a href="https://apps.apple.com/gb/app/notebook-studio-pdf-designer/id6811397092" target="_blank" rel="noopener noreferrer">App Store ($6.99)</a></li>
        <li><a href="../../pricing.html">Pricing</a></li>
        <li><a href="../../blog">Blog</a></li>
        <li><a href="../../about.html">About notebook-studio.com</a></li>
        <li><a href="../../contact.html">Contact</a></li>
        <li><a href="../../vs/ep-template-studio.html">vs Ep Template Studio</a></li>
        <li><a href="../../support.html">Support Center</a></li>
        <li><a href="../../privacy.html">Privacy Policy</a></li>
      </ul>
    </div>
  </footer>

  <!-- Live 60s revalidation from https://api.heycatch.ai/v1/articles/${slug}?key=hck_lv_c8fc952c1efb370b5f7aa1f4 -->
  <script type="module">
    import {
      getSiteBasePath,
      initBlogNavigation,
      renderBlogArticlePage
    } from '../../assets/js/heycatch-blog.js';

    const root = document.documentElement;
    const toggleBtn = document.getElementById('theme-toggle-btn');
    const savedTheme = localStorage.getItem('ns-theme');
    if (savedTheme === 'light' || savedTheme === 'dark') {
      root.setAttribute('data-theme', savedTheme);
    }
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const current = root.getAttribute('data-theme');
        const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const effectiveDark = current ? current === 'dark' : systemDark;
        const nextTheme = effectiveDark ? 'light' : 'dark';
        root.setAttribute('data-theme', nextTheme);
        localStorage.setItem('ns-theme', nextTheme);
      });
    }

    initBlogNavigation();
    const mountEl = document.getElementById('blog-post-mount');
    const basePath = getSiteBasePath();
    renderBlogArticlePage(mountEl, ${JSON.stringify(article.slug || article.id)}, { basePath });
  </script>
</body>
</html>
`;
}

function buildIndexListHtml(articles, linkPrefix) {
  if (!articles || articles.length === 0) {
    return `<div class="blog-empty-state">
          <p>No articles yet</p>
        </div>`;
  }

  const items = articles
    .map((article) => {
      const slug = encodeURIComponent(article.slug || article.id || '');
      const title = escapeHtml(article.title || 'Untitled article');
      const pubDate = article.published || article.published_at || '';
      const formattedDate = escapeHtml(formatPublishedDate(pubDate));
      const readTime = typeof article.read_time === 'number' && article.read_time > 0 ? `${article.read_time} min read` : '';
      return `<li class="blog-index-item">
            <a href="${linkPrefix}/${slug}" class="blog-index-link">${title}</a>
            <div class="blog-meta">
              ${pubDate ? `<time datetime="${escapeHtml(pubDate)}">${formattedDate}</time>` : ''}
              ${pubDate && readTime ? '<span aria-hidden="true">•</span>' : ''}
              ${readTime ? `<span>${escapeHtml(readTime)}</span>` : ''}
            </div>
          </li>`;
    })
    .join('\n          ');

  return `<ul class="blog-index-list">
          ${items}
        </ul>`;
}

async function main() {
  const rootDir = process.cwd();
  const articles = await fetchAllArticles();
  console.log(`Fetched ${articles.length} article(s) from HeyCatch API.`);

  // 1. Update blog/index.html and blog.html with pre-rendered list
  for (const [relFile, linkPrefix] of [
    ['blog/index.html', '/blog'],
    ['blog.html', '/blog']
  ]) {
    const filePath = path.join(rootDir, relFile);
    let html = await fs.readFile(filePath, 'utf8');
    const listMarkup = buildIndexListHtml(articles, linkPrefix);
    html = html.replace(
      /(<div id="blog-list-region" aria-live="polite" class="blog-index-region">)[\s\S]*?(<\/div>\s*<\/div>\s*<\/main>)/,
      `$1\n        ${listMarkup}\n      $2`
    );
    if (articles.length > 0) {
      html = html.replace(/<li class="nav-blog-item" hidden>/g, '<li class="nav-blog-item">');
    }
    await fs.writeFile(filePath, html, 'utf8');
  }

  // 2. Generate static /blog/{slug}/index.html and /blog/{slug}.html for every published article
  for (const summary of articles) {
    const slug = summary.slug || summary.id;
    if (!slug) continue;
    const fullArticle = (await fetchFullArticle(slug)) || summary;
    const pageHtml = buildArticlePageHtml(fullArticle);

    const slugDir = path.join(rootDir, 'blog', slug);
    await fs.mkdir(slugDir, { recursive: true });
    await fs.writeFile(path.join(slugDir, 'index.html'), pageHtml, 'utf8');

    // Also write blog/<slug>.html (with ../ relative asset paths) so both /blog/<slug> and /blog/<slug>/ return HTTP 200
    const flatHtml = pageHtml
      .replace(/(href|src)="\.\.\/\.\.\//g, '$1="../')
      .replace(/from '\.\.\/\.\.\/assets\/js\/heycatch-blog\.js'/g, "from '../assets/js/heycatch-blog.js'");
    await fs.writeFile(path.join(rootDir, 'blog', `${slug}.html`), flatHtml, 'utf8');
    console.log(`Generated static route for /blog/${slug}`);
  }

  // 3. Ensure shared SEO head & footer markup across all public HTML pages
  const sharedOrgJsonLd = `  <script type="application/ld+json" id="shared-org-jsonld">
  {
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "notebook-studio.com",
    "alternateName": "Notebook Studio",
    "url": "https://www.notebook-studio.com",
    "logo": "https://samjproctor.github.io/notebook-studio-website/assets/icons/app-icon-1024.png",
    "email": "support@notebook-studio.com",
    "sameAs": [
      "https://apps.apple.com/gb/app/notebook-studio-pdf-designer/id6811397092",
      "https://samjproctor.github.io/notebook-studio-website/",
      "https://www.notebook-studio.com"
    ]
  }
  </script>`;

  const pagesToPatch = [
    ['pricing.html', ''],
    ['pricing/index.html', '../'],
    ['support.html', ''],
    ['privacy.html', ''],
    ['remarkable-planner-designer.html', ''],
    ['kindle-scribe-planner-designer.html', ''],
    ['vs/ep-template-studio.html', '../'],
    ['vs/ep-template-studio/index.html', '../../'],
    ['blog/index.html', '../'],
    ['blog.html', ''],
    ['blog/post.html', '../']
  ];

  for (const [relFile, prefix] of pagesToPatch) {
    const filePath = path.join(rootDir, relFile);
    try {
      let html = await fs.readFile(filePath, 'utf8');
      if (!html.includes('name="robots"')) {
        html = html.replace(
          /<meta name="color-scheme" content="light dark">/,
          `<meta name="color-scheme" content="light dark">\n  <meta name="robots" content="index, follow">\n  <meta http-equiv="X-Content-Type-Options" content="nosniff">\n  <meta name="referrer" content="strict-origin-when-cross-origin">`
        );
      }
      if (!html.includes('"@type": "Organization"')) {
        html = html.replace('</head>', `${sharedOrgJsonLd}\n</head>`);
      }
      if (!html.includes('About notebook-studio.com')) {
        html = html.replace(
          /<li><a href="([^"]*privacy\.html)">Privacy Policy<\/a><\/li>/,
          `<li><a href="${prefix}about.html">About notebook-studio.com</a></li>\n        <li><a href="${prefix}contact.html">Contact</a></li>\n        <li><a href="$1">Privacy Policy</a></li>`
        );
      }
      await fs.writeFile(filePath, html, 'utf8');
    } catch {
      // Ignore missing optional file
    }
  }

  // 4. Update sitemap.xml with honest lastmod timestamps from file stats & article updated dates
  async function getFileDate(relFile) {
    try {
      const st = await fs.stat(path.join(rootDir, relFile));
      return st.mtime.toISOString().slice(0, 10);
    } catch {
      return '2026-10-25';
    }
  }

  const sitemapPath = path.join(rootDir, 'sitemap.xml');
  const articleEntries = articles
    .map((a) => {
      const slug = encodeURIComponent(a.slug || a.id || '');
      const lastmod = (a.updated || a.published || '2026-10-25').slice(0, 10);
      return `  <url>
    <loc>${PRODUCTION_ORIGIN}/blog/${slug}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`;
    })
    .join('\n');

  const latestBlogMod = articles.length > 0
    ? (articles[0].updated || articles[0].published || '2026-10-25').slice(0, 10)
    : await getFileDate('blog/index.html');

  const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${PRODUCTION_ORIGIN}/</loc>
    <lastmod>${await getFileDate('index.html')}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${PRODUCTION_ORIGIN}/pricing.html</loc>
    <lastmod>${await getFileDate('pricing.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${PRODUCTION_ORIGIN}/blog</loc>
    <lastmod>${latestBlogMod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>
${articleEntries ? `${articleEntries}\n` : ''}  <url>
    <loc>${PRODUCTION_ORIGIN}/about.html</loc>
    <lastmod>${await getFileDate('about.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${PRODUCTION_ORIGIN}/contact.html</loc>
    <lastmod>${await getFileDate('contact.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${PRODUCTION_ORIGIN}/vs/ep-template-studio.html</loc>
    <lastmod>${await getFileDate('vs/ep-template-studio.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${PRODUCTION_ORIGIN}/remarkable-planner-designer.html</loc>
    <lastmod>${await getFileDate('remarkable-planner-designer.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${PRODUCTION_ORIGIN}/kindle-scribe-planner-designer.html</loc>
    <lastmod>${await getFileDate('kindle-scribe-planner-designer.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${PRODUCTION_ORIGIN}/support.html</loc>
    <lastmod>${await getFileDate('support.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${PRODUCTION_ORIGIN}/privacy.html</loc>
    <lastmod>${await getFileDate('privacy.html')}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.5</priority>
  </url>
</urlset>
`;
  await fs.writeFile(sitemapPath, sitemapXml, 'utf8');
  console.log('Updated sitemap.xml');

  // 5. Ping IndexNow (t_sitemap_fresh)
  try {
    const indexNowKey = '8f4b2e9c1a7d4e6f8b3c5a2d9e1f0a3b';
    const urlList = [
      `${PRODUCTION_ORIGIN}/`,
      `${PRODUCTION_ORIGIN}/blog`,
      `${PRODUCTION_ORIGIN}/about.html`,
      `${PRODUCTION_ORIGIN}/contact.html`,
      ...articles.map((a) => `${PRODUCTION_ORIGIN}/blog/${encodeURIComponent(a.slug || a.id || '')}`)
    ];
    await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: 'samjproctor.github.io',
        key: indexNowKey,
        keyLocation: `${PRODUCTION_ORIGIN}/${indexNowKey}.txt`,
        urlList
      })
    });
    console.log('Pinged IndexNow');
  } catch {
    // Non-fatal
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(0); // Never fail the build on API error
});
