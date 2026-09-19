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
 */
function buildFeedUrl(feed) {
  if (feed.url) return feed.url;
  if (!Array.isArray(feed.keywords) || feed.keywords.length === 0) {
    throw new Error('feed needs either "keywords" or "url"');
  }
  let query = feed.keywords.map((keyword) => `"${keyword}"`).join(' OR ');
  if (Array.isArray(feed.exclude) && feed.exclude.length > 0) {
    query += ' ' + feed.exclude.map((term) => `-${term}`).join(' ');
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
 */
function stem(word) {
  return word.replace(/(ing|ed|s)$/, '');
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
    .map(stem);
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

/** Builds one RSS 2.0 channel from a feed config and its unique items. */
function buildRssXml(feed, items) {
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
<rss version="2.0">
  <channel>
    <title>${escapeText(feed.title)}</title>
    <link>${escapeText(feed.link || 'https://news.google.com')}</link>
    <description>${escapeText(feed.description)}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${itemsXml}
  </channel>
</rss>`;
}

/** Builds the readable index page listing every feed and its headlines. */
function buildIndexHtml(results) {
  const sections = results
    .map((result) => {
      const rows = result.items
        .map((item) => {
          const pub = item.pubDate || item.isoDate || '';
          return `
          <li>
            <a href="${escapeText(item.link)}">${escapeText(item.title)}</a>
            <time>${escapeText(shortDate(pub))}</time>
          </li>`;
        })
        .join('');

      return `
      <section>
        <h2>
          <a href="${escapeText(result.feed.filename)}.xml">${escapeText(result.feed.title)}</a>
          <small>${result.items.length} of ${result.total} stories</small>
        </h2>
        <p>${escapeText(result.feed.description)}</p>
        <ul>${rows}
        </ul>
      </section>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Deduped feeds</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      max-width: 46rem;
      margin: 0 auto;
      padding: 2rem 1.25rem 4rem;
      line-height: 1.5;
      color: #1a1a1a;
      background: #fafafa;
    }
    h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
    .updated { color: #777; margin-top: 0; }
    .opml { color: #777; font-size: 0.9rem; margin-top: 0.25rem; }
    .opml a { color: inherit; }
    section { margin-top: 2.5rem; }
    h2 { font-size: 1.15rem; margin-bottom: 0.25rem; }
    h2 a { color: inherit; text-decoration: none; }
    h2 a:hover { text-decoration: underline; }
    h2 small { font-weight: normal; color: #777; margin-left: 0.5rem; }
    section > p { color: #555; margin-top: 0; }
    ul { list-style: none; padding: 0; margin: 1rem 0 0; }
    li {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      padding: 0.5rem 0;
      border-bottom: 1px solid #e5e5e5;
    }
    li a { color: #1a1a1a; }
    time { color: #777; white-space: nowrap; font-size: 0.9rem; }
  </style>
</head>
<body>
  <main>
    <h1>Deduped news feeds</h1>
    <p class="updated">Same story, many publishers - one headline. Updated ${escapeText(new Date().toUTCString())}.</p>
    <p class="opml">Subscribe to every feed at once: <a href="feeds.opml">feeds.opml</a> (import into any RSS reader)</p>
    ${sections}
  </main>
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
  buildRssXml,
  buildFeedUrl,
  buildBundleItems,
  isGoogleNewsUrl,
  validateConfig,
};
