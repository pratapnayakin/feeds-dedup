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
const SIMILARITY_THRESHOLD = 0.55;

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

// ---------------------------------------------------------------------------
// Headline comparison
// ---------------------------------------------------------------------------

/**
 * Turns a headline into a Set of meaningful lowercase words.
 * Strips the trailing " - Publisher" tag Google News appends first.
 */
function extractTokens(title) {
  const withoutPublisher = title.replace(/\s*-\s*[^-]+$/, '').toLowerCase();
  const words = withoutPublisher
    .replace(/[^\w\s]/g, '') // drop punctuation
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
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
    .map(
      (item) => `
    <item>
      <title>${escapeText(item.title)}</title>
      <link>${escapeText(item.link)}</link>
      <guid isPermaLink="false">${escapeText(item.guid || item.link)}</guid>
      <pubDate>${escapeText(item.pubDate)}</pubDate>
      <description>${escapeText(item.contentSnippet || item.content || '')}</description>
    </item>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>${escapeText(feed.title)}</title>
    <link>https://news.google.com</link>
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
        .map(
          (item) => `
          <li>
            <a href="${escapeText(item.link)}">${escapeText(item.title)}</a>
            <time>${escapeText(shortDate(item.pubDate))}</time>
          </li>`
        )
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
function buildOpml(feeds) {
  const outlines = feeds
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
// Main
// ---------------------------------------------------------------------------

/** Loads and validates feeds.json. */
function loadFeeds() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read feeds.json: ${err.message}`);
  }
  try {
    const config = JSON.parse(raw);
    return Array.isArray(config.feeds) ? config.feeds : [];
  } catch (err) {
    throw new Error(`feeds.json is not valid JSON: ${err.message}`);
  }
}

/** Fetches one feed, drops old items, dedupes, returns the result (no writing). */
async function processFeed(feed, parser) {
  const parsed = await parser.parseURL(buildFeedUrl(feed));

  const maxAgeDays = Number.isFinite(feed.maxAgeDays)
    ? feed.maxAgeDays
    : MAX_AGE_DAYS;
  const recentItems = filterByAge(parsed.items, maxAgeDays);
  const ageDropped = parsed.items.length - recentItems.length;

  // Newest first, so the freshest version of each story wins dedup and the
  // output order stays stable across runs (less re-notify churn in readers).
  recentItems.sort((a, b) => dateValue(b) - dateValue(a));

  const acceptedSets = [];
  const uniqueItems = [];
  for (const item of recentItems) {
    const tokens = extractTokens(item.title || '');
    if (!isDuplicate(tokens, acceptedSets)) {
      acceptedSets.push(tokens);
      uniqueItems.push(item);
    }
  }
  return { feed, items: uniqueItems, total: parsed.items.length, ageDropped };
}

async function main() {
  const feeds = loadFeeds();
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
    buildOpml(feeds),
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
      console.log(
        `[ok]   ${String(feed.title).padEnd(18)} ` +
          `${String(result.total).padStart(3)}${ageNote} -> ${String(result.items.length).padStart(3)} unique  (${seconds}s)`
      );
    } catch (err) {
      console.error(`[fail] ${feed.title || feed.filename}: ${err.message}`);
    }
  }

  if (results.length > 0) {
    fs.writeFileSync(
      path.join(OUTPUT_DIR, 'index.html'),
      buildIndexHtml(results),
      'utf8'
    );
  }

  const totalIn = results.reduce((sum, r) => sum + r.total, 0);
  const totalOut = results.reduce((sum, r) => sum + r.items.length, 0);
  console.log(`\nDone: ${totalIn} items -> ${totalOut} unique. Output in public/`);
}

main().catch((err) => {
  console.error('Script failed:', err.message);
  process.exit(1);
});
