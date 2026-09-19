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
  buildFeedUrl,
  buildBundleItems,
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
  const seen = [new Set(['rourkela', 'excise', 'superintendent', 'held', 'cash'])];

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

console.log('All tests passed.');
