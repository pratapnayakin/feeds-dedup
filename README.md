# feeds-dedup

![Update News Feed](https://github.com/pratapnayakin/feeds-dedup/actions/workflows/update.yml/badge.svg)

A self-updating, deduplicated RSS feed service. It fetches news from Google
News search feeds, removes near-duplicate headlines (the same story reported
by many publishers), and publishes one clean RSS 2.0 feed per topic plus a
readable index page - all hosted free on GitHub Pages, refreshed every hour.

No servers, no API keys, no cost.

Personal project, all rights reserved. View-only, no reuse without permission.

---

## Why it exists

Google News reports the same story many times - once per publisher. Follow a
topic and you see the same story from five different newspapers. RSS readers
are the cleanest way to follow news, but they need a feed URL. This project
creates those URLs automatically, keeps them duplicate-free, and refreshes
them hourly - so you never have to search Google News again.

The 30-second pitch: "A script runs every hour on GitHub for free. It reads
a list of topics I care about, fetches the latest news from Google, removes
duplicate stories, and publishes clean RSS feeds to a free website. I
subscribe to those feeds in my RSS reader. Adding a topic is just editing a
text file."

Why these building blocks:

- **RSS** - the oldest, simplest, most universal way to subscribe; every reader supports it
- **Google News** - free, no API key, covers every topic; a query in, an RSS feed out
- **Deduplication** - Google returns the same story once per publisher; the point is "read each story once"
- **GitHub Pages** - free hosting with HTTPS; no server, no domain
- **GitHub Actions** - free scheduled runs; the refresh robot never sleeps
- **OPML** - one file imports ALL feeds into any reader in one click
- **The age filter** - Google fills quiet topics with years-old articles; this keeps feeds relevant
- **A readable web page too** - scan headlines without an RSS reader

---

## Live output

| What | URL |
|---|---|
| Index page (open in a browser - lists every feed and its URL) | https://pratapnayakin.github.io/feeds-dedup/ |
| One-click subscribe (OPML - import into any reader) | https://pratapnayakin.github.io/feeds-dedup/feeds.opml |
| Odisha Breaking (merged bundle - one link for all Odisha alerts) | https://pratapnayakin.github.io/feeds-dedup/odisha-breaking.xml |
| Rourkela Breaking (merged bundle - one link for all Rourkela alerts) | https://pratapnayakin.github.io/feeds-dedup/rourkela-breaking.xml |
| AI Breaking (merged bundle - one link for all AI alerts) | https://pratapnayakin.github.io/feeds-dedup/ai-breaking.xml |
| WebDev Breaking (merged bundle - one link for all web dev and jobs alerts) | https://pratapnayakin.github.io/feeds-dedup/webdev-breaking.xml |

Paste any `.xml` URL into an RSS reader (Feedly, Inoreader, NetNewsWire, ...).
The reader polls it on its normal refresh cycle; the content behind it is
regenerated hourly.

---

## How it works (architecture)

```
GitHub Actions (hourly cron, or on every push, or manual)
        |
        v
   node dedup.js
        |
        |-- 1. reads feeds.json (the feed list - data, not code)
        |-- 2. for each feed: builds/fetches a Google News RSS search URL
        |-- 3. dedupes the headlines (word-overlap scoring, per feed)
        |-- 4. writes public/<filename>.xml  (clean RSS 2.0)
        |-- 5. writes public/<bundle>.xml    (merged feeds, cross-deduped)
        |-- 6. writes public/index.html      (readable index of all feeds)
        |-- 7. writes public/feeds.opml      (one-click subscribe list)
        |
        v
upload-pages-artifact --> deploy-pages
        |
        v
https://pratapnayakin.github.io/feeds-dedup/  -->  your RSS reader
```

Key idea: Google News returns the same story many times (once per publisher).
This pipeline collapses those duplicates so you read each story once.

---

## Project structure

| File | Purpose |
|---|---|
| `feeds.json` | **The only file you edit day-to-day.** List of feeds (keywords or full URLs) plus optional bundles. |
| `dedup.js` | The whole engine: fetch, dedupe, write XML + HTML. ~580 lines, commented. |
| `.github/workflows/update.yml` | The automation: runs the script and deploys to Pages. |
| `package.json` | Declares the single dependency (`rss-parser`) and the `npm start` / `npm test` scripts. |
| `package-lock.json` | Pins exact dependency versions. Required by `npm ci` in the workflow. **Must be committed.** |
| `.gitignore` | Keeps `node_modules/` and `public/` out of git (both are generated/restored). |
| `public/` | Generated output. Never edit, never commit - rebuilt on every run. |

---

## Requirements

- Node.js 18+ and npm (only for running locally; GitHub Actions provides its own Node 22)
- Git and a GitHub account
- A **public** repository (GitHub Pages is free for public repos)
- Nothing else. Google News RSS is free and needs no authentication or API key.

---

## Local setup (from zero)

```bash
git clone https://github.com/pratapnayakin/feeds-dedup.git
cd feeds-dedup
npm install        # restores dependencies from the lock file
npm start          # same as: node dedup.js
npm test           # runs the test suite (no network needed)
```

Console output looks like:

```
[ok]   Rourkela News      100 ->  60 unique  (0.7s)
[ok]   OSHB News           41 ->  36 unique  (0.3s)
...
Done: 318 items -> 205 unique. Output in public/
```

Open `public/index.html` in a browser to inspect the result before it is
deployed.

---

## Configuring feeds (`feeds.json`)

Every feed is an object with four fields, plus optional `exclude` and
`filter` lists. Two ways to define the source:

### Way 1 - keywords (recommended, scalable)

```json
{
  "filename": "oshb",
  "title": "OSHB News",
  "description": "Odisha State Housing Board updates",
  "keywords": ["Odisha State Housing Board", "OSHB"]
}
```

The script builds the Google News search URL for you: every keyword is
wrapped in quotes (exact match) and joined with `OR`, plus the locale
settings (`en-IN`, India). You never touch URL encoding.

### Way 2 - full URL (escape hatch for complex queries)

```json
{
  "filename": "bengaluru-power",
  "title": "Bengaluru Power Cuts",
  "description": "Power cuts and outages in Bengaluru",
  "url": "https://news.google.com/rss/search?q=...&hl=en-IN&gl=IN&ceid=IN:en"
}
```

Use this when the query needs things a flat keyword list cannot express:
AND-groups like `(Bengaluru OR Bangalore) (power cut OR outage)`,
or a non-Google RSS source entirely.
An explicit `url` always wins over `keywords`.

### Rules

- `filename` becomes the output file name (`<filename>.xml`) - keep it short, lowercase, no spaces
- `title` and `description` appear in the XML header and on the index page
- A feed with neither `url` nor `keywords` fails with a clear error message
- Order in the file = order on the index page
- Optional: `"exclude": ["football", "cricket"]` appends `-football -cricket`
  to the search query (keyword feeds only; `url` feeds embed their own exclusions)
- Optional: `"filter": ["Rourkela", "Raurkela"]` keeps only items whose title
  contains one of these words (case-insensitive) - slices a broad source down
  to one topic. Works on any script (e.g. Odia titles).
- Optional: `"maxAgeDays": 30` drops items older than that many days
  (default 365; change `MAX_AGE_DAYS` in `dedup.js` for a global default).
  Items with a missing date are kept.

### Bundles - several feeds merged into one link

A bundle merges the deduped output of other feeds into one extra RSS file,
so you can subscribe to many topics through a single URL:

```json
"bundles": [
  {
    "filename": "odisha-breaking",
    "title": "Odisha Breaking - All Alerts",
    "description": "Every important Odisha story, merged from the category feeds",
    "maxItems": 100,
    "sources": ["odisha", "odisha-crime", "odisha-weather"]
  }
]
```

- `sources` lists the `filename` values of other feeds in this file
- Items are cross-deduped: the same story appearing in two source feeds
  appears once in the bundle
- Sorted newest-first, capped at `maxItems` (default 100)
- A source that failed this run is simply skipped for that run
- Bundles appear on the index page and in `feeds.opml` like normal feeds

To add a feed: edit `feeds.json`, commit, push. The workflow deploys it
automatically. To remove one: delete the entry. The full every-time checklist
(including the RSS reader side) is below.

---

## Adding or removing a feed - the every-time checklist

The git side is automatic after you push; the RSS reader side is always
manual - the site updates, your reader does not.

### When you ADD a feed

1. Edit `feeds.json` - add the entry (keywords or url)
2. Optional but wise: run `npm start` and check `public/index.html`
3. Commit and push to `main`
4. Wait for the green workflow run (~30s) - the new `<filename>.xml` is live
5. **Manually** add `https://pratapnayakin.github.io/feeds-dedup/<filename>.xml`
   to your RSS reader - or re-import `feeds.opml`, which now includes it
   (re-import behavior varies by reader, so check for duplicates)

### When you REMOVE a feed

1. Delete the entry from `feeds.json`
2. Commit and push to `main`
3. The next workflow run rebuilds `public/` from scratch - the old
   `<filename>.xml` will 404
4. **Manually** delete that URL from your RSS reader (or re-import the
   updated `feeds.opml`), or it shows fetch errors on every refresh

---

## How deduplication works

For each feed, items older than the age cutoff (365 days by default,
per-feed via `maxAgeDays`) are dropped first. Survivors are sorted
newest-first so the freshest version of each story wins dedup and the
output order stays stable across runs. Then every headline goes
through:

1. **Strip the publisher tag.** Google News appends ` - Publisher Name` to
   titles. It is removed *for comparison only* (kept in the output).
2. **Tokenize.** Lowercase, drop punctuation, split into words, drop words
   shorter than 3 characters and common stopwords (the, and, from, ...),
   then strip common suffixes (light stemming: `arrested`/`arrest` and
   `outages`/`outage` compare as one word).
3. **Score against every already-accepted headline** using the
   Sorensen-Dice coefficient:

   ```
   score = (2 x shared words) / (words in A + words in B)
   ```

4. **Threshold.** If any score is >= `SIMILARITY_THRESHOLD` (0.45, a constant
   at the top of `dedup.js`), the headline is a duplicate and is dropped.
   Otherwise it is accepted and becomes a new comparison target.

Worked example:

- `"Rourkela Excise Superintendent held with cash - Odisha TV"`
- `"Rourkela Excise Superintendent arrested - New Indian Express"`

After stripping and tokenizing they share most words, score well above 0.45,
and only the first is kept.

**Tuning direction:** lower the threshold -> more aggressive dedup (more
reworded duplicates caught, but risk of merging genuinely different stories).
Raise it -> safer, but more near-duplicates survive. 0.45 is tuned from run
data: it catches reworded duplicates of big news cycles. Going lower starts
merging genuinely different stories (real example: two unrelated "how will
the stock react" headlines share 44% of their words).

---

## How publishing works (`.github/workflows/update.yml`)

Triggers:

- **Every push to `main`** - instant feedback that the pipeline works
- **Hourly** (`cron: 0 * * * *`) - the regular refresh
- **Manual** (`workflow_dispatch`) - "Run workflow" button on the Actions page

Steps on each run: checkout -> setup Node 22 -> `npm ci` -> `node dedup.js`
-> upload `public/` as an artifact -> deploy to GitHub Pages. Takes ~30
seconds.

One-time repo setting (already done for this repo):
**Settings -> Pages -> Build and deployment -> Source: "GitHub Actions"**.
Without it, the `configure-pages` step fails.

---

## Grey areas and known limitations

Read this section honestly - these are the edges of the system.

### Deduplication limits

- **It is similarity-based, not perfect.** Reworded duplicates below the
  threshold survive (real example: five differently-worded headlines about
  the same Rourkela Excise bribe arrest all appeared in one run). Lowering
  the threshold catches more but risks false merges.
- **Light stemming only.** `arrested`/`arrest` and `outages`/`outage` now
  compare as one word, but `held`/`hold` still do not. Reworded headlines
  of the same big story can still slip through - word overlap between
  same-story headlines ranges from near-zero to high, so no threshold
  separates them perfectly.
- **Dedup is per feed, not across feeds.** The same story can appear in both
  the Rourkela feed and the OSHB feed. Each feed is deduped independently.
- **First-seen wins.** Items are processed in the order Google returns them;
  which publisher's headline survives is arbitrary.
- **Empty-token headlines are never duplicates.** A title with no meaningful
  words left after tokenizing is always kept.

### Google News quirks

- **Links are Google redirects** (`news.google.com/rss/articles/...`), not
  direct publisher URLs. They resolve correctly, but they are long and opaque,
  and Google can change their format at any time.
- **Old articles appear - and are now filtered.** For low-volume queries
  Google fills the feed with older results (the OSHB feed once returned
  articles from 2015). Items older than 365 days are dropped automatically;
  override per feed with `maxAgeDays` in `feeds.json` (e.g. 30 for
  high-volume topics). Items with a missing date are kept, and feed order
  still does not equal recency.
- **Some titles contain literal newlines** from the source. Harmless when
  rendered, slightly ugly in the HTML source.
- **Quoted keywords are exact match.** `"OSHB"` will not match `OSHB's`.
  Unquoted keywords match more loosely.

### Feed noise (query design, not code bugs)

- **Acronym collisions.** The bare `OSHB` keyword also matches New Mexico's
  Occupational Health & Safety Bureau and a Ukrainian unit with the same
  abbreviation. Fix by requiring context, e.g. an AND-group in a `url`:
  `("Odisha State Housing Board" OR ("OSHB" AND Odisha))`.
- **Broad keywords pull spam.** Generic terms (sports, security, technology)
  attract streaming-site junk and product pages. Prefer specific phrases.
- **The LLM feed's bare `security` / `vulnerability` terms** let through
  non-AI security product pages. Tighten with AND-groups if it bothers you.

### GitHub Actions quirks

- **Scheduled runs are not exact.** GitHub delays cron runs by minutes during
  peak load. "Hourly" means "roughly hourly".
- **Scheduled workflows get disabled after 60 days** of no activity in a
  public repo. Normal commits keep it alive; if it is disabled, re-enable it
  from the Actions tab.
- **`npm ci` fails without a committed `package-lock.json`.** If you change
  dependencies, run `npm install` locally and commit the updated lock file.
- **A failing feed does not fail the build.** A feed that errors (network
  hiccup, bad query) is logged as `[fail]` in the Actions log and skipped;
  the deploy proceeds and that feed is simply missing from the site until the
  next successful run. Check the log if a feed vanishes.
- **Fetch guard with retry.** Each feed has 15s timeout + 2 retries with backoff. 24 feeds fetched sequentially take ~15-30 seconds per run. A feed that still fails is skipped for that run.

### Operational notes

- `public/` and `node_modules/` are gitignored on purpose. Never commit them.
- `index.html` only contains feeds that succeeded in that particular run.
- On Windows, git prints harmless `LF will be replaced by CRLF` warnings.
  Ignore them.
- Node 20 reached end-of-life in April 2026; the workflow pins Node 22 on
  purpose.

---

## Maintenance cheat sheet

| Task | How |
|---|---|
| Add a feed | Edit `feeds.json` (keywords or url), commit, push |
| Remove a feed | Delete its entry from `feeds.json`, commit, push |
| Force an instant refresh | Actions tab -> "Update News Feed" -> "Run workflow" |
| Make dedup more aggressive | Lower `SIMILARITY_THRESHOLD` in `dedup.js` (e.g. 0.40) |
| Make dedup safer | Raise `SIMILARITY_THRESHOLD` (e.g. 0.65) |
| Ignore more common words | Add to the `STOPWORDS` set in `dedup.js` |
| Exclude noisy terms from a feed | Add an `"exclude"` list to that feed in `feeds.json` |
| Slice a broad source to one topic | Add a `"filter"` list to that feed in `feeds.json` |
| Change refresh frequency | Edit the `cron` line in `.github/workflows/update.yml` |
| Change locale for keyword feeds | Edit `GOOGLE_NEWS_LOCALE` in `dedup.js` |
| Change the age cutoff | Set `maxAgeDays` per feed in `feeds.json`, or `MAX_AGE_DAYS` in `dedup.js` |
| Change what a bundle includes | Edit its `sources` list in `feeds.json` |
| Repo renamed? | Update `SITE_URL` in `dedup.js` (used by `feeds.opml`) |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Workflow red at "Install dependencies" | `package-lock.json` missing or out of sync | Run `npm install` locally, commit the lock file |
| Workflow red at "Setup Pages" | Pages source not set to "GitHub Actions" | Settings -> Pages -> Source: "GitHub Actions", then re-run the job |
| A feed vanished from the site | Its fetch failed that run | Check the Actions log for a `[fail]` line; it returns on the next good run |
| Feed full of old articles | Age cutoff too lenient for that topic | Set `"maxAgeDays": 30` (or lower) on that feed in `feeds.json` |
| Reader notifies for old stories | Every new subscription notifies for all items once; afterwards only unseen IDs notify | Expected on first subscribe; ongoing churn is reduced by newest-first ordering - also check the reader app notification settings |
| Too many duplicate stories | Threshold too high for that topic | Lower `SIMILARITY_THRESHOLD` slightly |
| Genuinely different stories merged | Threshold too low | Raise `SIMILARITY_THRESHOLD` slightly |
| `npm start` says "Cannot read feeds.json" | Running from the wrong directory | Run from the repo root |
| "feeds.json is not valid JSON" | Typo while editing (trailing comma, unquoted string) | Fix the JSON; the error message includes the position |

---

## Quick reference

- Repo: https://github.com/pratapnayakin/feeds-dedup (public)
- Site: https://pratapnayakin.github.io/feeds-dedup/
- Engine: `dedup.js` (Node, single dependency: `rss-parser`)
- Config: `feeds.json` (keywords for simple feeds, `url` for complex ones)
- Subscribe once: import `feeds.opml` into any RSS reader
- Refresh: hourly + on every push to `main`
- Cost: zero
