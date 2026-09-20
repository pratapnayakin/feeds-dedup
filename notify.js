#!/usr/bin/env node
/**
 * notify.js
 * ---------
 * Sends push notifications for new items in feeds marked "notify": true.
 *
 * Reads the generated public/<filename>.xml files (already deduped and
 * age-filtered by dedup.js), compares item GUIDs against the last run's
 * state, and POSTs new items to ntfy.sh topics.
 *
 * State lives in .notify-state.json, restored from the GitHub Actions
 * cache before this runs and saved after. First run primes the state
 * and sends nothing, so you do not get a flood of old headlines.
 *
 * Usage: node notify.js   (run after node dedup.js)
 */

const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');

const CONFIG_FILE = path.join(__dirname, 'feeds.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATE_FILE = path.join(__dirname, '.notify-state.json');
const NTFY_BASE = 'https://ntfy.sh';
const TOPIC_PREFIX = 'pn-broadcast-';
const MAX_PER_FEED_PER_RUN = 5;

/** Loads feeds.json. */
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

/** Loads last-run state, or {} when missing or unreadable. */
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** Writes state back for the next run. */
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

/** Items whose GUID is not in the seen set. */
function freshItems(items, seen) {
  return items.filter((item) => !seen.has(item.guid || item.link));
}

/** POSTs one headline to an ntfy.sh topic. */
async function postToNtfy(topic, feedTitle, item) {
  const body = `${item.title}\n\n${item.link}`;
  const res = await fetch(`${NTFY_BASE}/${topic}`, {
    method: 'POST',
    body,
    headers: {
      Title: feedTitle,
      Priority: 'default',
    },
  });
  if (!res.ok) throw new Error(`ntfy ${topic} returned ${res.status}`);
}

async function main() {
  const config = loadConfig();
  // Bundles are notified too, so check feeds and bundles together.
  const notifyFeeds = (config.feeds || []).concat(config.bundles || []).filter((f) => f.notify);
  if (notifyFeeds.length === 0) {
    console.log('No feeds marked "notify" - nothing to do.');
    return;
  }

  const state = loadState();
  const parser = new Parser();

  for (const feed of notifyFeeds) {
    const xmlPath = path.join(PUBLIC_DIR, `${feed.filename}.xml`);
    if (!fs.existsSync(xmlPath)) {
      console.log(`[skip] ${feed.filename}: no generated xml this run`);
      continue;
    }

    const parsed = await parser.parseString(fs.readFileSync(xmlPath, 'utf8'));
    const items = parsed.items || [];
    const seen = new Set(state[feed.filename] || []);

    // First time this feed is notified: record everything, send nothing.
    if (!state[feed.filename]) {
      state[feed.filename] = items.map((i) => i.guid || i.link);
      console.log(`[prime] ${feed.filename}: ${items.length} items recorded, no notifications`);
      continue;
    }

    const fresh = freshItems(items, seen);
    if (fresh.length === 0) {
      console.log(`[ok]   ${feed.filename}: no new items`);
      continue;
    }

    const topic = feed.topic || TOPIC_PREFIX + feed.filename;
    const toSend = fresh.slice(0, MAX_PER_FEED_PER_RUN);
    for (const item of toSend) {
      await postToNtfy(topic, feed.title, item);
      console.log(`[sent] ${feed.filename} -> ${topic}: ${String(item.title).slice(0, 60)}`);
    }

    // Record all fresh GUIDs (sent or capped) so capped ones do not
    // re-notify on the next run. Keep the last 500 per feed.
    const allGuids = fresh.map((i) => i.guid || i.link);
    state[feed.filename] = [...seen, ...allGuids].slice(-500);
  }

  saveState(state);
  console.log('Notify state saved.');
}

// Only run when executed directly. Requiring this file (e.g. from tests)
// must not trigger a fetch or a send.
if (require.main === module) {
  main().catch((err) => {
    console.error('notify.js failed:', err.message);
    process.exit(1);
  });
}

// Exported for tests.
module.exports = { freshItems };