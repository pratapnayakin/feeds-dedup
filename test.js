#!/usr/bin/env node
/**
 * Tests for dedup.js - run with: npm test
 * Uses only node:assert - no test framework, no dependencies.
 * Requiring dedup.js does NOT trigger a fetch run (guarded by
 * require.main === module inside dedup.js).
 */

const assert = require('assert');
const {
  extractTokens,
  similarityScore,
  isDuplicate,
  filterByAge,
  filterByTitle,
  escapeText,
  ageLabel,
  publisherOf,
  buildRssXml,
  buildFeedUrl,
  buildBundleItems,
  isGoogleNewsUrl,
  validateConfig,
} = require('./dedup.js');

// --- extractTokens -------------------------------------------------------
// Strips the " - Publisher" tag Google News appends, lowercases, drops
// punctuation, short words and stopwords.
{
  const tokens = extractTokens('Rourkela Excise Superintendent held with cash - Odisha TV');
  assert(tokens.has('rourkela') && tokens.has('excise'), 'keeps meaningful words');
  assert(!tokens.has('with'), 'drops stopwords');
  assert(!tokens.has('odisha') && !tokens.has('tv'), 'strips the publisher tag');
}

// Odia-script titles tokenize (the Unicode-aware regex keeps non-Latin letters)
{
  const tokens = extractTokens('ରାଉରକେଲା ରେ ଖବର');
  assert(tokens.has('ରାଉରକେଲା'), 'tokenizes Odia-script words');
  assert(!tokens.has('ରେ'), 'drops short Odia words');
}

// --- stemming --------------------------------------------------------------
{
  const a = extractTokens('Man arrested in Rourkela theft case');
  const b = extractTokens('Rourkela theft: man arrest by police');
  assert(a.has('arrest') && b.has('arrest'), 'stems suffixes (arrested -> arrest)');

  const c = extractTokens('Power outages reported in city');
  const d = extractTokens('Power outage reported in city');
  assert(c.has('outage') && d.has('outage'), 'stems plurals (outages -> outage, matches outage)');

  const e = extractTokens('Business news update today');
  assert(e.has('business') && e.has('news'), 'keeps exceptions intact (business, news)');

  const f = extractTokens('Sing a song in city');
  assert(f.has('sing'), 'never stems below 3 chars (sing stays sing)');
}

// --- similarityScore -----------------------------------------------------
{
  assert.strictEqual(
    similarityScore(new Set(['a', 'b']), new Set(['a', 'b'])), 1,
    'identical sets score 1'
  );
  assert.strictEqual(
    similarityScore(new Set(['a', 'b']), new Set(['c', 'd'])), 0,
    'disjoint sets score 0'
  );
  assert.strictEqual(
    similarityScore(new Set(), new Set(['a'])), 0,
    'empty set scores 0'
  );
}

// --- isDuplicate ---------------------------------------------------------
{
  const seen = [extractTokens('Rourkela Excise Superintendent held with cash - Odisha TV')];

  // shares rourkela, excise, superintendent: score = 2*3 / (5+4) = 0.67
  const dup = extractTokens('Rourkela Excise Superintendent arrested - New Indian Express');
  assert(isDuplicate(dup, seen), 'near-duplicate headline detected');

  const fresh = extractTokens('Weather office issues heavy rainfall alert for Sundargarh');
  assert(!isDuplicate(fresh, seen), 'different story not flagged');
}

// --- filterByAge ---------------------------------------------------------
{
  const now = Date.now();
  const items = [
    { pubDate: new Date(now - 40 * 24 * 60 * 60 * 1000).toUTCString() }, // 40 days old
    { pubDate: new Date(now - 2 * 24 * 60 * 60 * 1000).toUTCString() },  // 2 days old
    { pubDate: '' }, // missing date
  ];
  const kept = filterByAge(items, 30);
  assert.strictEqual(kept.length, 2, 'drops old items, keeps missing dates');
}

// --- buildFeedUrl --------------------------------------------------------
{
  // keywords mode: quoted, OR-joined, Google News search URL
  const url = buildFeedUrl({ keywords: ['Rourkela', 'Raurkela'] });
  assert(url.startsWith('https://news.google.com/rss/search?'), 'builds a Google News search URL');
  assert(url.includes('%22Rourkela%22'), 'quotes keywords');
  assert(url.includes('OR'), 'joins keywords with OR');

  // the exclude list appends -term filters
  const urlEx = buildFeedUrl({ keywords: ['TypeScript'], exclude: ['football', 'cricket'] });
  assert(urlEx.includes('-football') && urlEx.includes('-cricket'), 'appends exclude terms');

  // multi-word excludes are quoted: -"gold rate", not -gold rate
  const urlPhrase = buildFeedUrl({ keywords: ['Rourkela'], exclude: ['gold rate', 'BikeWale'] });
  assert(urlPhrase.includes('-BikeWale'), 'appends single-word exclude');
  const qPhrase = new URL(urlPhrase).searchParams.get('q');
  assert(qPhrase.includes('-"gold rate"'), 'quotes phrase exclude');

  // an explicit url always wins
  const urlRaw = buildFeedUrl({ keywords: ['ignored'], url: 'https://example.com/rss' });
  assert.strictEqual(urlRaw, 'https://example.com/rss', 'explicit url wins over keywords');

  // neither keywords nor url -> clear error
  assert.throws(() => buildFeedUrl({}), /needs either/, 'fails with a clear error');
}

// --- buildBundleItems ----------------------------------------------------
{
  const resultsByFilename = {
    crime: { items: [
      { title: 'Burglary gang busted in Cuttack', pubDate: 'Wed, 16 Sep 2026 10:00:00 GMT' },
    ]},
    accident: { items: [
      // same story, different wording -> must collapse in the bundle
      { title: 'Cuttack burglary gang busted by police', pubDate: 'Wed, 16 Sep 2026 09:00:00 GMT' },
      { title: 'New market opens in Bhubaneswar', pubDate: 'Thu, 17 Sep 2026 08:00:00 GMT' },
    ]},
  };
  const bundle = { sources: ['crime', 'accident'], maxItems: 100 };

  const items = buildBundleItems(bundle, resultsByFilename);
  assert.strictEqual(items.length, 2, 'cross-dedupes the same story across sources');
  assert.strictEqual(items[0].title, 'New market opens in Bhubaneswar', 'sorts newest-first');

  // a source that failed this run (absent from the map) is skipped
  const partial = buildBundleItems(bundle, { crime: resultsByFilename.crime });
  assert.strictEqual(partial.length, 1, 'skips sources that failed this run');

  // capped at maxItems. Titles share only one word ("story") so each item
  // scores ~0.33 similarity - genuinely distinct, none deduped.
  const many = { items: [] };
  for (let i = 0; i < 150; i++) {
    many.items.push({ title: `Story ${i} alpha${i} beta${i}`, pubDate: 'Wed, 16 Sep 2026 10:00:00 GMT' });
  }
  assert.strictEqual(
    buildBundleItems({ sources: ['a'], maxItems: 100 }, { a: many }).length, 100,
    'caps at maxItems'
  );
}

// --- filterByTitle -------------------------------------------------------
// Keeps only items whose title contains a filter word, case-insensitive.
// No filter list means keep all.
{
  const items = [
    { title: 'Power cut in Rourkela today' },
    { title: 'Cricket match in Cuttack' },
  ];
  const kept = filterByTitle(items, ['rourkela']);
  assert.strictEqual(kept.length, 1, 'keeps matching title only');
  assert.strictEqual(kept[0].title, 'Power cut in Rourkela today', 'keeps correct item');
  assert.strictEqual(filterByTitle(items, []).length, 2, 'empty filter keeps all');
  assert.strictEqual(filterByTitle(items, null).length, 2, 'missing filter keeps all');
}

// --- escapeText ----------------------------------------------------------
// Escapes XML chars so feeds never break on &, <, >, quotes.
{
  assert.strictEqual(
    escapeText('a&b<c>d"e\'f'),
    'a&amp;b&lt;c&gt;d&quot;e&apos;f',
    'escapes all five XML chars'
  );
  assert.strictEqual(escapeText(null), '', 'handles missing text');
}

// --- ageLabel ------------------------------------------------------------
// Flags items older than 3 days so resurfaced old stories read as old.
{
  assert.strictEqual(ageLabel(new Date().toUTCString()), '', 'fresh items get no badge');
  assert.strictEqual(ageLabel(''), '', 'dateless items get no badge');
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toUTCString();
  assert(ageLabel(old).includes('old'), '10-day-old items get an old badge');
}

// --- publisherOf ----------------------------------------------------------
// Google News titles carry " - Publisher"; custom feeds do not.
{
  const gn = { link: 'https://news.google.com/rss/articles/x', title: 'Rourkela power cut - The New Indian Express' };
  assert.strictEqual(publisherOf(gn), 'The New Indian Express', 'extracts publisher from Google News title');

  const custom = { link: 'https://satyanewsalert.in/?p=1', title: 'Odia headline without suffix' };
  assert.strictEqual(publisherOf(custom), '', 'no publisher for custom feeds');

  const noSuffix = { link: 'https://news.google.com/rss/articles/x', title: 'Plain headline without suffix' };
  assert.strictEqual(publisherOf(noSuffix), '', 'no publisher when suffix missing');
}

// --- buildRssXml pubDate fallback ----------------------------------------
// Missing pubDate falls back to isoDate, then to now. Never empty.
{
  const feed = { title: 'T', description: 'D' };
  const withIso = buildRssXml(feed, [
    { title: 'A', link: 'https://example.com/a', isoDate: 'Wed, 16 Sep 2026 10:00:00 GMT' },
  ]);
  assert(withIso.includes('Wed, 16 Sep 2026'), 'uses isoDate when pubDate missing');

  const withNone = buildRssXml(feed, [{ title: 'B', link: 'https://example.com/b' }]);
  assert(!withNone.includes('<pubDate></pubDate>'), 'never writes empty pubDate');
  assert(withNone.includes('<pubDate>'), 'always writes pubDate tag');

  const withName = buildRssXml({ filename: 'rourkela', title: 'T', description: 'D' }, []);
  assert(withName.includes('xmlns:atom'), 'declares atom namespace');
  assert(withName.includes('rel="self"'), 'includes self link for validators');
}

// --- isGoogleNewsUrl + validateConfig ------------------------------------
// Publisher-strip applies only to Google News. Config fails fast on typos.
{
  assert.strictEqual(
    isGoogleNewsUrl('https://news.google.com/rss/search?q=x'),
    true,
    'detects Google News URL'
  );
  assert.strictEqual(
    isGoogleNewsUrl('https://satyanewsalert.in/?feed=rss2'),
    false,
    'custom RSS is not Google News'
  );
  // Generic titles keep hyphens when strip is false.
  const kept = extractTokens('Rourkela - Power cut today', false);
  assert(kept.has('power') && kept.has('cut'), 'generic title keeps hyphen words');

  assert.throws(
    () => validateConfig([{ filename: 'a', keywords: ['x'] }, { filename: 'a', keywords: ['y'] }], []),
    /duplicate filename/,
    'catches duplicate filename'
  );
  assert.throws(
    () => validateConfig([{ filename: 'a', keywords: ['x'] }], [{ filename: 'b', sources: ['missing'] }]),
    /unknown source/,
    'catches unknown bundle source'
  );
  assert.doesNotThrow(
    () => validateConfig([{ filename: 'a', keywords: ['x'] }], [{ filename: 'b', sources: ['a'] }]),
    'accepts valid config'
  );
}

console.log('All tests passed.');
