#!/usr/bin/env node
/**
 * feeds-dedup
 * -----------
 * Fetches a list of RSS feeds, removes near-duplicate headlines
 * (the same story reported by many publishers), and writes:
 *
 *   public/<filename>.xml   clean RSS 2.0 feed, one per source
 *   public/index.html       readable page listing every feed
 *
 * Feeds live in feeds.json. To add one, add an entry:
 *
 *   {
 *     "filename": "my-feed",     -> becomes public/my-feed.xml
 *     "title": "My Feed",
 *     "description": "What it covers",
 *     "keywords": ["single word", "some phrase"],
 *     "exclude": ["noise", "junk"]  -> optional, appends -noise -junk
 *   }
 *
 * Keywords are matched exactly as typed (phrases stay phrases).
 * Need full control (operators, site: filters, non-Google sources)?
 * Set "url" instead of "keywords" and it is used as-is.
 *
 * Usage: npm start   (or: node dedup.js)
 */

const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG_FILE = path.join(__dirname, 'feeds.json');
const OUTPUT_DIR = path.join(__dirname, 'public');

// Used to turn keywords into a Google News search URL for feeds that
// do not define their own "url".
const GOOGLE_NEWS_SEARCH = 'https://news.google.com/rss/search';
const GOOGLE_NEWS_LOCALE = { hl: 'en-IN', gl: 'IN', ceid: 'IN:en' };

// Where the site is published. Used to build absolute URLs in feeds.opml.
// If you rename the repository, update this.
const SITE_URL = 'https://pratapnayakin.github.io/feeds-dedup';

// Items older than this many days are dropped. Google News fills low-volume
// feeds with years-old articles. 365 removes multi-year filler while keeping
// low-volume topics usable; override per feed with "maxAgeDays" (e.g. 30 for
// high-volume topics).
const MAX_AGE_DAYS = 365;

// Words too common to help tell two headlines apart.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or',
  'is', 'was', 'are', 'were', 'by', 'with', 'from', 'as', 'into', 'over', 'after',
]);

// Two headlines count as the same story when they share at least this
// fraction of their meaningful words (0 = nothing matches, 1 = identical).
// 0.45, tuned from run data: catches reworded duplicates of big news cycles.
// Raise it if genuinely different stories start merging.
const SIMILARITY_THRESHOLD = 0.45;

// How many headlines per feed the index page shows. The full list stays in
// each XML feed; the index is a scannable summary so the file stays small.
const INDEX_HEADLINES_PER_FEED = 10;

// Per-feed fetch guard. Pure Node, no library option needed.
// TIMEOUT per attempt, RETRIES extra tries on fail or timeout.
const FETCH_TIMEOUT_MS = 15000;
const FETCH_RETRIES = 2;

// ---------------------------------------------------------------------------
// Feed URLs
// ---------------------------------------------------------------------------

/**
 * Resolves the URL for one feed. An explicit "url" always wins;
 * otherwise the keywords become: "a" OR "b" OR "c" on Google News.
 * An optional "exclude" list appends -term filters (keyword feeds only).
 * Multi-word terms are quoted: -"gold rate", not -gold rate.
 */
function buildFeedUrl(feed) {
  if (feed.url) return feed.url;
  if (!Array.isArray(feed.keywords) || feed.keywords.length === 0) {
    throw new Error('feed needs either "keywords" or "url"');
  }
  let query = feed.keywords.map((keyword) => `"${keyword}"`).join(' OR ');
  if (Array.isArray(feed.exclude) && feed.exclude.length > 0) {
    const parts = feed.exclude.map((term) => {
      const t = String(term || '').trim();
      return t.includes(' ') ? `-"${t}"` : `-${t}`;
    });
    query += ' ' + parts.join(' ');
  }
  const params = new URLSearchParams({ q: query, ...GOOGLE_NEWS_LOCALE });
  return `${GOOGLE_NEWS_SEARCH}?${params}`;
}

/**
 * True for Google News URLs. Publisher-strip applies only here.
 * Generic RSS (custom sites) keeps its hyphens intact.
 */
function isGoogleNewsUrl(url) {
  return String(url || '').includes('news.google.com');
}

/**
 * Parse one URL with timeout. Rejects if parser takes too long.
 * Uses Promise.race so no dependency on parser timeout options.
 */
function parseWithTimeout(parser, url) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`fetch timeout after ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS);
  });
  const fetch = parser.parseURL(url).finally(() => {
    if (timer) clearTimeout(timer);
  });
  return Promise.race([fetch, timeout]);
}

/**
 * Fetches with retry. Retries on network fail or timeout.
 * Throws last error after all attempts, caller logs [fail].
 */
async function fetchWithRetry(parser, url) {
  let lastErr = null;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      return await parseWithTimeout(parser, url);
    } catch (err) {
      lastErr = err;
      // small backoff: 1s, 2s. Keeps hourly run fast but tolerant.
      if (attempt < FETCH_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/**
 * Fails fast on config mistakes. Call once in main before fetching.
 * Checks duplicate filenames and unknown bundle sources.
 */
function validateConfig(feeds, bundles) {
  const seen = new Set();
  for (const feed of feeds) {
    if (!feed.filename) throw new Error('feed missing "filename"');
    if (seen.has(feed.filename)) throw new Error(`duplicate filename "${feed.filename}"`);
    seen.add(feed.filename);
    if (!feed.url && (!Array.isArray(feed.keywords) || feed.keywords.length === 0)) {
      throw new Error(`feed "${feed.filename}" needs either "keywords" or "url"`);
    }
  }
  const names = new Set([...seen, ...(bundles || []).map((b) => b.filename)]);
  for (const bundle of bundles || []) {
    for (const src of bundle.sources || []) {
      if (!seen.has(src)) throw new Error(`bundle "${bundle.filename}" unknown source "${src}"`);
    }
    if (names.has(bundle.filename) && seen.has(bundle.filename)) {
      throw new Error(`bundle filename "${bundle.filename}" collides with feed filename`);
    }
  }
}

// ---------------------------------------------------------------------------
// Headline comparison
// ---------------------------------------------------------------------------

/**
 * Light stemmer: strips common English suffixes so "arrested"/"arrest" and
 * "outages"/"outage" compare as the same word. A heuristic, not linguistics.
 * No "es" rule on purpose: for headline words (outages, issues, cases,
 * releases) the "e" belongs to the stem, so stripping bare "s" is correct.
 * Non-Latin words (Odia) never match these suffixes, so they pass through.
 * Guard: keeps exceptions intact (news, business) and never returns a
 * stem shorter than 3 chars (sing stays sing, not s).
 */
const STEM_EXCEPTIONS = new Set(['news', 'business', 'status', 'this', 'does']);
function stem(word) {
  if (STEM_EXCEPTIONS.has(word)) return word;
  const out = word.replace(/(ing|ed|s)$/, '');
  return out.length >= 3 ? out : word;
}

/**
 * Turns a headline into a Set of meaningful lowercase words.
 * Strips trailing " - Publisher" only for Google News titles.
 * Generic RSS keeps hyphens, else "Rourkela - Power cut" would break.
 */
function extractTokens(title, stripPublisher = true) {
  const input = String(title || '');
  const withoutPublisher = stripPublisher
    ? input.replace(/\s*-\s*[^-]+$/, '')
    : input;
  const lowered = withoutPublisher.toLowerCase();
  const words = lowered
    // drop punctuation (Unicode-aware). \p{M} keeps combining marks - Odia
    // and other Indic vowel signs are marks, not letters, and would
    // otherwise be stripped, corrupting every word.
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    .map(stem)
    .filter((word) => word.length > 2);
  return new Set(words);
}

/**
 * Sorensen-Dice score: how much two word-sets overlap.
 * 0 = nothing in common, 1 = identical.
 */
function similarityScore(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let matches = 0;
  for (const token of setA) {
    if (setB.has(token)) matches++;
  }
  return (2 * matches) / (setA.size + setB.size);
}

/** True when `tokens` matches any headline we already accepted. */
function isDuplicate(tokens, acceptedSets) {
  return acceptedSets.some(
    (seen) => similarityScore(tokens, seen) >= SIMILARITY_THRESHOLD
  );
}

/**
 * Drops items older than `maxAgeDays`. Items with a missing or unparseable
 * date are kept - we do not discard content we cannot date.
 */
function filterByAge(items, maxAgeDays) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  return items.filter((item) => {
    const date = new Date(item.pubDate || item.isoDate || '');
    return Number.isNaN(date.getTime()) || date.getTime() >= cutoff;
  });
}

/**
 * Keeps only items whose title contains any of the filter words
 * (case-insensitive). Slices a broad source down to one topic, e.g. an
 * Odia-language agency filtered to Rourkela. No "filter" field = keep all.
 */
function filterByTitle(items, filterWords) {
  if (!Array.isArray(filterWords) || filterWords.length === 0) return items;
  const words = filterWords.map((word) => String(word).toLowerCase());
  return items.filter((item) => {
    const title = String(item.title || '').toLowerCase();
    return words.some((word) => title.includes(word));
  });
}

/** Milliseconds since epoch for sorting, or 0 when the item has no usable date. */
function dateValue(item) {
  const date = new Date(item.pubDate || item.isoDate || '');
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

// Characters that must be escaped inside XML/HTML, mapped to their
// named entities (e.g. the ampersand maps to "amp").
const XML_ENTITIES = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' };

/** Escapes text so it is safe inside both XML and HTML. */
function escapeText(unsafe) {
  return String(unsafe || '').replace(
    /[&<>"']/g,
    (char) => `&${XML_ENTITIES[char]};`
  );
}

/** Short human date, e.g. "Sep 13". Empty string for missing dates. */
function shortDate(dateString) {
  const date = new Date(dateString);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Age badge for index rows, e.g. " (6d old)". Empty when fresh or dateless. */
function ageLabel(dateString) {
  const t = new Date(dateString).getTime();
  if (Number.isNaN(t)) return '';
  const days = Math.floor((Date.now() - t) / 86400000);
  return days > 3 ? ` (${days}d old)` : '';
}

/** Publisher name from a Google News title suffix, e.g. " - The Hindu". */
function publisherOf(item) {
  if (!isGoogleNewsUrl(item.link)) return '';
  const m = String(item.title || '').match(/\s*-\s*([^-]+)$/);
  return m ? m[1].trim() : '';
}

/** Builds one RSS 2.0 channel from a feed config and its unique items. */
function buildRssXml(feed, items) {
  // Self link for validators and readers. Base feeds carry filename,
  // bundles are passed with filename too, so prefer SITE_URL + filename.
  const selfUrl = feed.filename ? `${SITE_URL}/${feed.filename}.xml` : (feed.link || SITE_URL + '/');
  const itemsXml = items
    .map((item) => {
      // Fallback chain: pubDate -> isoDate -> now. Avoids empty pubDate
      // which some readers reject. Same chain as dateValue().
      const pub = item.pubDate || item.isoDate || new Date().toUTCString();
      return `
    <item>
      <title>${escapeText(item.title)}</title>
      <link>${escapeText(item.link)}</link>
      <guid isPermaLink="false">${escapeText(item.guid || item.link)}</guid>
      <pubDate>${escapeText(pub)}</pubDate>
      <description>${escapeText(item.contentSnippet || item.content || '')}</description>
    </item>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeText(feed.title)}</title>
    <link>${escapeText(feed.link || 'https://news.google.com')}</link>
    <atom:link href="${escapeText(selfUrl)}" rel="self" type="application/rss+xml" />
    <description>${escapeText(feed.description)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${itemsXml}
  </channel>
</rss>`;
}

// Category grouping for the index page. Order here = order on the page.
// "full" categories span the full width (breaking bundles on top).
const CATEGORIES = [
  { label: 'Breaking', accent: '#c62828', full: true, filenames: ['rourkela-breaking', 'odisha-breaking', 'ai-breaking', 'webdev-breaking'] },
  { label: 'Rourkela', accent: '#e86a17', full: false, filenames: ['rourkela', 'rourkela-crime', 'rourkela-accident', 'rourkela-weather', 'rourkela-exams', 'rourkela-govt', 'rourkela-power', 'rourkela-health', 'satya-alert'] },
  { label: 'Odisha', accent: '#2e7d32', full: false, filenames: ['odisha', 'bhubaneswar-crime', 'odisha-crime', 'odisha-accident', 'odisha-weather', 'odisha-exams', 'odisha-govt', 'odisha-power', 'odisha-health', 'oshb'] },
  { label: 'Tech and Jobs', accent: '#1565c0', full: false, filenames: ['ai-models', 'ai-safety', 'ai-pricing', 'ai-industry', 'webdev-frontend', 'webdev-backend', 'webdev-devops', 'webdev-security', 'india-jobs', 'global-remote-jobs'] },
  { label: 'India and World', accent: '#6a1b9a', full: false, filenames: ['india-breaking', 'world-breaking', 'bengaluru-power'] },
];

/** One feed card: title, description, top headlines. */
function renderFeedCard(result) {
  const feed = result.feed;
  const shown = result.items.slice(0, INDEX_HEADLINES_PER_FEED);
  const rows = shown
    .map((item) => {
      const pub = item.pubDate || item.isoDate || '';
      const publisher = publisherOf(item);
      const meta = [publisher, `${shortDate(pub)}${ageLabel(pub)}`].filter(Boolean).join(' | ');
      return `
          <li>
            <a class="headline" href="${escapeText(item.link)}">${escapeText(item.title)}</a>
            ${meta ? `<span class="meta">${escapeText(meta)}</span>` : ''}
          </li>`;
    })
    .join('');

  return `
        <section class="feed">
          <h3>
            <a href="${escapeText(feed.filename)}.xml">${escapeText(feed.title)}</a>
            <span class="count">top ${shown.length} of ${result.items.length} unique</span>
          </h3>
          <p class="desc">${escapeText(feed.description)}</p>
          <ul>${rows}
          </ul>
        </section>`;
}

/** One category block: header plus a grid of feed cards. Empty feeds are hidden. */
function renderCategory(cat, results) {
  const nonEmpty = results.filter((r) => r.items.length > 0);
  if (nonEmpty.length === 0) return '';
  const cards = nonEmpty.map(renderFeedCard).join('\n');
  return `
      <section class="category" style="--cat:${cat.accent}">
        <h2>${escapeText(cat.label)}</h2>
        <div class="grid${cat.full ? ' full' : ''}">${cards}
        </div>
      </section>`;
}

/** Builds the readable index page: masthead, grouped categories, feed cards. */
function buildIndexHtml(results) {
  const byFilename = {};
  for (const result of results) byFilename[result.feed.filename] = result;

  const sections = [];
  for (const cat of CATEGORIES) {
    const catResults = cat.filenames.map((f) => byFilename[f]).filter(Boolean);
    if (catResults.length > 0) {
      const html = renderCategory(cat, catResults);
      if (html) sections.push(html);
    }
  }
  // Safety net: any feed not listed above still appears.
  const known = new Set(CATEGORIES.flatMap((c) => c.filenames));
  const leftovers = results.filter((r) => !known.has(r.feed.filename));
  if (leftovers.length > 0) {
    const html = renderCategory({ label: 'More', accent: '#607d8b', full: false }, leftovers);
    if (html) sections.push(html);
  }

  const updated = new Date().toUTCString();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Deduped RSS feeds for Rourkela, Odisha, AI and web dev. Same story, many publishers, one headline.">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%23e86a17'/><circle cx='10' cy='22' r='3' fill='white'/><path d='M6 14a10 10 0 0 1 10 10' stroke='white' stroke-width='3' fill='none' stroke-linecap='round'/><path d='M6 7a17 17 0 0 1 17 17' stroke='white' stroke-width='3' fill='none' stroke-linecap='round'/></svg>">
  <title>Rourkela Odisha Deduped Feeds</title>
  <style>
    :root {
      --bg: #fafafa;
      --fg: #1a1a1a;
      --muted: #6b7280;
      --card: #ffffff;
      --border: #e5e7eb;
      --accent: #e86a17;
      --font-head: Georgia, 'Times New Roman', serif;
      --font-body: system-ui, -apple-system, 'Segoe UI', sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #101418;
        --fg: #e7e9ec;
        --muted: #9aa3ad;
        --card: #171c22;
        --border: #262d35;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--font-body);
      background: var(--bg);
      color: var(--fg);
      line-height: 1.5;
    }
    .wrap { max-width: 74rem; margin: 0 auto; padding: 0 1.25rem 4rem; }
    .masthead { padding: 2rem 0 1.25rem; border-bottom: 1px solid var(--border); }
    .brand { font-family: var(--font-head); font-size: 1.9rem; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
    .tagline { color: var(--muted); margin: 0.25rem 0 0; }
    .mast-row { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; justify-content: space-between; margin-top: 0.9rem; }
    .updated { color: var(--muted); font-size: 0.9rem; }
    .subscribe {
      display: inline-block;
      background: var(--accent);
      color: #fff;
      text-decoration: none;
      padding: 0.45rem 0.95rem;
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: 600;
    }
    .category { margin-top: 2.25rem; }
    .category h2 {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.95rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin: 0 0 0.75rem;
    }
    .category h2::before { content: ''; width: 5px; height: 1.05em; background: var(--cat); border-radius: 2px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 1.25rem; }
    @media (min-width: 900px) {
      .grid { grid-template-columns: 1fr 1fr; }
      .grid.full { grid-template-columns: 1fr; }
    }
    .feed { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 1rem 1.1rem; }
    .feed h3 { margin: 0 0 0.15rem; font-size: 1.05rem; }
    .feed h3 a { color: var(--fg); text-decoration: none; }
    .feed h3 a:hover { text-decoration: underline; }
    .feed .count { color: var(--muted); font-size: 0.8rem; font-weight: normal; margin-left: 0.4rem; }
    .feed .desc { color: var(--muted); font-size: 0.85rem; margin: 0 0 0.6rem; }
    .feed ul { list-style: none; margin: 0; padding: 0; }
    .feed li { padding: 0.5rem 0; border-top: 1px solid var(--border); }
    .feed li:first-child { border-top: 0; }
    .feed li a.headline { color: var(--fg); text-decoration: none; font-family: var(--font-head); font-size: 0.98rem; line-height: 1.35; }
    .feed li a.headline:hover { text-decoration: underline; }
    .feed .meta { display: block; color: var(--muted); font-size: 0.78rem; margin-top: 0.15rem; }
    footer { margin-top: 3rem; color: var(--muted); font-size: 0.85rem; text-align: center; }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="masthead">
      <h1 class="brand">Deduped News</h1>
      <p class="tagline">Same story, many publishers - one headline.</p>
      <div class="mast-row">
        <span class="updated">Updated ${escapeText(updated)}</span>
        <a class="subscribe" href="feeds.opml">Subscribe to all feeds</a>
      </div>
    </header>
    ${sections.join('\n')}
    <footer>Generated by feeds-dedup. Personal project, view-only.</footer>
  </div>
</body>
</html>`;
}

/**
 * Builds an OPML 2.0 subscription list from the feed config. RSS readers
 * can import this single file instead of adding each feed URL by hand.
 * Derived from config alone, so it is valid even if a fetch fails.
 */
function buildOpml(feeds, bundles) {
  const outlines = feeds.concat(bundles)
    .map((feed) => {
      const xmlUrl = `${SITE_URL}/${feed.filename}.xml`;
      return `    <outline type="rss" text="${escapeText(feed.title)}" title="${escapeText(feed.title)}" xmlUrl="${escapeText(xmlUrl)}" htmlUrl="${escapeText(SITE_URL + '/')}"/>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>feeds-dedup</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${outlines}
  </body>
</opml>`;
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

/**
 * Merges the deduped items of a bundle's source feeds into one list.
 * Cross-dedupes across sources (the same story in two feeds collapses),
 * sorts newest-first, and caps the length.
 */
function buildBundleItems(bundle, resultsByFilename) {
  const seen = [];
  const merged = [];
  for (const filename of bundle.sources || []) {
    const result = resultsByFilename[filename];
    if (!result) continue; // source failed this run - the bundle skips it
    for (const item of result.items) {
      // Per-item decision: only Google News links get publisher-strip.
      // Mixed bundles (Google + custom RSS) stay correct.
      const strip = isGoogleNewsUrl(item.link);
      const tokens = extractTokens(item.title || '', strip);
      if (!isDuplicate(tokens, seen)) {
        seen.push(tokens);
        merged.push(item);
      }
    }
  }
  merged.sort((a, b) => dateValue(b) - dateValue(a));
  const maxItems = Number.isFinite(bundle.maxItems) ? bundle.maxItems : 100;
  return merged.slice(0, maxItems);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Loads and validates feeds.json. */
function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read feeds.json: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`feeds.json is not valid JSON: ${err.message}`);
  }
}

/** Fetches one feed, drops off-topic and old items, dedupes, returns the result (no writing). */
async function processFeed(feed, parser) {
  const url = buildFeedUrl(feed);
  const strip = isGoogleNewsUrl(url);
  const parsed = await fetchWithRetry(parser, url);

  const titleFiltered = filterByTitle(parsed.items, feed.filter);
  const titleDropped = parsed.items.length - titleFiltered.length;

  const maxAgeDays = Number.isFinite(feed.maxAgeDays)
    ? feed.maxAgeDays
    : MAX_AGE_DAYS;
  const recentItems = filterByAge(titleFiltered, maxAgeDays);
  const ageDropped = titleFiltered.length - recentItems.length;

  // Newest first, so the freshest version of each story wins dedup and the
  // output order stays stable across runs (less re-notify churn in readers).
  recentItems.sort((a, b) => dateValue(b) - dateValue(a));

  const acceptedSets = [];
  const uniqueItems = [];
  for (const item of recentItems) {
    const tokens = extractTokens(item.title || '', strip);
    if (!isDuplicate(tokens, acceptedSets)) {
      acceptedSets.push(tokens);
      uniqueItems.push(item);
    }
  }
  return { feed, items: uniqueItems, total: parsed.items.length, ageDropped, titleDropped };
}

async function main() {
  const config = loadConfig();
  const feeds = Array.isArray(config.feeds) ? config.feeds : [];
  const bundles = Array.isArray(config.bundles) ? config.bundles : [];
  // Fail fast on typos: duplicate filenames, unknown bundle sources.
  validateConfig(feeds, bundles);
  if (feeds.length === 0) {
    console.log('No feeds found in feeds.json - nothing to do.');
    return;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const parser = new Parser();
  const results = [];

  // The subscription list comes from config alone, so it is written even
  // if every feed fetch below fails.
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'feeds.opml'),
    buildOpml(feeds, bundles),
    'utf8'
  );

  for (const feed of feeds) {
    const startedAt = Date.now();
    try {
      const result = await processFeed(feed, parser);
      results.push(result);

      fs.writeFileSync(
        path.join(OUTPUT_DIR, `${feed.filename}.xml`),
        buildRssXml(feed, result.items),
        'utf8'
      );

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const ageNote = result.ageDropped > 0 ? ` (-${result.ageDropped} old)` : '';
      const offNote = result.titleDropped > 0 ? ` (-${result.titleDropped} off-topic)` : '';
      console.log(
        `[ok]   ${String(feed.title).padEnd(18)} ` +
          `${String(result.total).padStart(3)}${offNote}${ageNote} -> ${String(result.items.length).padStart(3)} unique  (${seconds}s)`
      );
    } catch (err) {
      console.error(`[fail] ${feed.title || feed.filename}: ${err.message}`);
    }
  }

  // Bundles merge the deduped output of their source feeds into one XML.
  const resultsByFilename = {};
  for (const result of results) {
    resultsByFilename[result.feed.filename] = result;
  }

  const bundleResults = [];
  for (const bundle of bundles) {
    const items = buildBundleItems(bundle, resultsByFilename);
    fs.writeFileSync(
      path.join(OUTPUT_DIR, `${bundle.filename}.xml`),
      buildRssXml({ ...bundle, link: SITE_URL + '/' }, items),
      'utf8'
    );
    const totalIn = (bundle.sources || []).reduce(
      (sum, f) => sum + (resultsByFilename[f] ? resultsByFilename[f].items.length : 0),
      0
    );
    bundleResults.push({ feed: bundle, items, total: totalIn, ageDropped: 0 });
    console.log(
      `[ok]   ${String(bundle.title).padEnd(18)} ` +
        `${String(totalIn).padStart(3)} -> ${String(items.length).padStart(3)} merged`
    );
  }

  if (results.length + bundleResults.length > 0) {
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'index.html'),
      buildIndexHtml(results.concat(bundleResults)),
      'utf8'
    );
  }

  const totalIn = results.reduce((sum, r) => sum + r.total, 0);
  const totalOut = results.reduce((sum, r) => sum + r.items.length, 0);
  console.log(`\nDone: ${totalIn} items -> ${totalOut} unique. Output in public/`);

  // HTTP keep-alive sockets keep the event loop alive after the work is
  // done, so the process would hang here without an explicit exit.
  process.exit(0);
}

// Only run the pipeline when executed directly (node dedup.js / npm start).
// Requiring this file (e.g. from tests) must not trigger a fetch run.
if (require.main === module) {
  main().catch((err) => {
    console.error('Script failed:', err.message);
    process.exit(1);
  });
}

// Exported for tests.
module.exports = {
  extractTokens,
  similarityScore,
  isDuplicate,
  filterByAge,
  filterByTitle,
  escapeText,
  shortDate,
  ageLabel,
  publisherOf,
  buildRssXml,
  buildFeedUrl,
  buildBundleItems,
  isGoogleNewsUrl,
  validateConfig,
};
