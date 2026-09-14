# feeds-dedup - Explained in Plain English

This file explains the whole project without jargon. Read it top to bottom
and you will be able to explain it to anyone - even someone who has never
heard of RSS or GitHub.

---

## The one-sentence version

This project turns Google News into clean, duplicate-free RSS feeds that
update themselves every hour and are hosted for free on GitHub Pages.

---

## Why does this project exist? (the problem it solves)

1. Google News reports the **same story many times** - once for every
   publisher that covered it. If you follow "Rourkela" you see the same
   bribe story from five different newspapers.
2. You want to **read each story once**, not five times.
3. RSS readers (Feedly, Inoreader, NetNewsWire, ...) are the cleanest way
   to follow news - but they need a **feed URL** to subscribe to.
4. This project creates those feed URLs automatically, keeps them
   duplicate-free, and refreshes them every hour - so you never have to
   search Google News again.

---

## The big picture - what happens every hour

```
A robot wakes up (GitHub Actions, free)
        |
        v
1. It reads your feed list (feeds.json) - the topics you care about
2. It asks Google News: "give me the latest articles on each topic"
3. It removes duplicate stories (same story, different publishers)
4. It removes very old articles (Google fills quiet topics with years-old news)
5. It writes clean RSS files + a readable web page
6. It publishes them to your free website (GitHub Pages)
        |
        v
Your RSS reader picks up the new files automatically
```

The whole loop is free, runs without you doing anything, and never needs a
server or a credit card.

---

## Why GitHub? (what GitHub is doing here)

GitHub is not just a place to store code. This project uses three free
things GitHub gives you:

| GitHub feature | What it does here |
|---|---|
| **Git / version control** | Every change to the project is saved with a history. You can always see what changed and undo mistakes. |
| **GitHub Actions** | A free robot that runs your script on a schedule. This is what makes the feeds update every hour. |
| **GitHub Pages** | Free website hosting. This is what serves the feeds to your RSS reader. |

So the entire project runs on GitHub's free tier. That is the whole trick.

---

## The files - what each one is

| File | What it is | Do you touch it? |
|---|---|---|
| `feeds.json` | **Your feed list.** The topics you want news about. | **YES - the only file you edit day-to-day** |
| `dedup.js` | **The engine.** The script that fetches, dedupes, and writes the feeds. | Only if you want to change how it works |
| `.github/workflows/update.yml` | **The schedule.** Tells GitHub when to run the engine (hourly + on every push). | Rarely |
| `package.json` | **The shopping list.** What software the engine needs (`rss-parser`). | Rarely |
| `package-lock.json` | **The receipt.** Exact versions of that software, so the robot installs exactly what you tested. | Never |
| `.gitignore` | **The "do not upload" list.** Keeps generated files out of the repo. | Never |
| `README.md` | **The manual.** The technical, complete documentation. | If you want |
| `EXPLAINED.md` | **This file.** The plain-English version. | If you want |

The files you never touch exist for one reason: so that a brand-new person
(or a fresh robot) can rebuild the whole thing with two commands
(`npm install`, `npm start`).

---

## The idea / brainstorming behind it

Every design choice has a reason:

- **Why RSS?** It is the oldest, simplest, most universal way to subscribe
  to news. Every RSS reader supports it. No app needed - just a URL.
- **Why Google News?** Free, no API key, no sign-up, covers every topic in
  the world. You give it a search query and it returns an RSS feed.
- **Why deduplicate?** Because Google News returns the same story once per
  publisher. The whole point of this project is "read each story once".
- **Why GitHub Pages?** Free hosting with HTTPS. No server to rent, no
  domain to buy.
- **Why GitHub Actions?** Free scheduled runs. The robot that refreshes the
  feeds costs nothing and never sleeps.
- **Why OPML?** One small file that imports ALL feeds into any RSS reader
  in one click - instead of typing four URLs by hand.
- **Why the age filter?** Google fills quiet topics (like OSHB) with
  articles from years ago. The filter drops anything older than a year so
  your feeds stay relevant.
- **Why a readable web page too?** So you (or anyone) can open the site in
  a browser and scan headlines without needing an RSS reader at all.

---

## How to explain it to someone in 30 seconds

> "A script runs every hour on GitHub for free. It reads a list of topics I
> care about, fetches the latest news from Google, removes duplicate
> stories, and publishes clean RSS feeds to a free website. I subscribe to
> those feeds in my RSS reader. Adding a topic is just editing a text file."

That is the whole project. Everything else is detail.

---

## What you see when you open the website

Open https://pratapnayakin.github.io/feeds-dedup/ and you see:

- A heading: "Deduped news feeds"
- When it was last updated
- A link to `feeds.opml` (the one-click subscribe file)
- One section per feed (Rourkela News, OSHB News, Bengaluru Power Cuts,
  LLM and AI News, Lohegaon Tiffin Service)
- Each section shows the story count ("59 of 100 stories") and a list of
  headlines with dates
- Each headline links to the actual article on Google News

The `.xml` files (e.g. `rourkela.xml`) are the machine-readable feeds you
give to your RSS reader. The web page is just a human-friendly view of the
same content.

---

## The grey areas (honest limitations)

These are the edges of the system - know them so you are never surprised:

- **Dedup is word-based, not perfect.** Two differently-worded headlines
  about the same story can both survive. It catches most duplicates, not all.
- **Dedup works within one feed, not across feeds.** The same story can
  appear in both the Rourkela feed and the OSHB feed.
- **Google controls the source.** If Google changes its RSS format or
  rate-limits the robot, feeds can go missing for a run. A failed feed does
  not break the others - it just comes back on the next successful run.
- **Scheduled runs are "roughly" hourly.** GitHub can delay the robot by a
  few minutes during busy times.
- **Scheduled robots pause after 60 days of no activity** in a public repo.
  Normal commits keep it alive.
- **Acronyms can collide.** "OSHB" also matches New Mexico's Occupational
  Health and Safety Bureau. Broad keywords attract noise - that is a query
  design issue, not a code bug.
- **Links are Google redirects.** The article links go through Google's
  redirect service, not directly to the publisher.

---

## The one thing to remember

`feeds.json` is the project. Everything else is machinery that makes it
work. If you can edit a text file, you can run this project.