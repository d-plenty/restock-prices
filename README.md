# Restock prices

Australian supermarket prices for [Restock](https://github.com/d-plenty/Restock): Coles, Woolworths, Aldi and
Costco, collected every Thursday and added to every night from the prices Restock phones send back. One file per
shop with products, sizes, barcodes (where the shop shows them) and price history. Restock's **Judge new items
from day one** (Settings → Prices and deals) uses it to know a product's usual price and usual sale price straight
away. Phones download only the shops they use, for 8 weeks, 6 months or 12 months, weekly or every day.

Not affiliated with any shop. Read [NOTICE-DATA.md](NOTICE-DATA.md) before using the data.

## The files

| Path | What's in it |
|---|---|
| `window/<shop>-56d.json.gz`, `-182d`, `-365d` | **What phones download** (Restock 0.9.13 and later): every product's price changes over the last 8 weeks, 6 months or 12 months, by the shop's product number. No names or pictures, so they're small. Format `restock-window`: `products: { "<product number>": [[day, cents, flags], …] }`, `day` counted from `from` (day 0 is the price already in force), flags 1 = on special, 2 = member price. |
| `window/index.json` | Each window file's size and product count, for the app's size guide; `to` (the day it was last published, every night) and `full` (its last Thursday collection), so phones know when there's something new. |
| `latest/<shop>.json.gz` | Every product seen in the last 90 days, with its prices for the last year and its name, size, barcode and picture. Restock's import format (`restock-export`, the same as the server's Data tab). Restock 0.9.12 and earlier download this. |
| `latest/<shop>-details.json.gz` | Extra facts per product: category, the shop's unit price text and a link. |
| `history/<shop>/<year>.json.gz` | Prices older than a year, by product. |
| `STATUS.md` | The last run: how many products each shop returned, whether it worked, how many prices came from the price helper phone and from phones, last night's prices from phones (and how many are waiting for a second phone), and the size of each day-one download. |

Shops: `woolworths`, `coles`, `aldi`, `costco`. A price is only written when it changes (price, was-price,
special, member-only or promo), so the files stay small. Sizes are also given as `qty` + `qty_unit` (`g`, `ml`
or `ea`), so per-litre and per-kilo prices can be compared.

## How it's collected

The collector in `collector/` runs once a week, on **Thursday at 1:00 am** (Brisbane time), a day after Coles'
and Woolworths' weekly specials start on Wednesday. On **Friday at 1:00 am** it tries again, but only for a shop
that failed or returned far fewer products than last time.

- **Woolworths** comes from [hotprices.org](https://hotprices.org), the open-source tracker that already publishes Woolworths' prices every day (one download, with months of past prices). **Coles** comes from the public pages Coles' own website uses, and from hotprices.org for that run when Coles turns the collector away. **Costco** comes from the public pages its website uses. **Aldi** comes from Aldi's public search, word by word across the range.
- No accounts and no sign-ins.
- One request at a time, with a pause of about 1.5 seconds between requests. A full run takes a few hours.
- It says who it is in every request (`RestockPrices/1.0`, with a link here).
- If a shop refuses (a robot check or "too many requests"), it stops that shop and tries again next time. It
  never tries to get around a shop's checks.
- Stock isn't collected: it's only meaningful for your own branch, which each phone checks itself.
- **A price helper phone** (Restock 0.9.11 and later) can add to Coles and Woolworths: a spare Android phone
  left on its charger searches about 500 everyday things through the week, the first page of results each
  time, about one search every 10 minutes, and sends the products and shelf prices it saw to the collector's
  helper address (port 8790, with `HELPER_KEY`). They're folded in at the next run, on the days they were seen.
  When the same product has a price from the shop's own pages (or the helper phone) and from hotprices.org on
  the same day, the shop's own reading is kept: it has the "was" price, special and member flags, which
  hotprices.org's files don't.

## Prices from phones (Shared prices)

Restock 0.9.14 and later send the shelf prices their searches and price checks read from Coles, Woolworths, Aldi
and Costco here, to `https://<this address>/share/prices`, unless the person turned **Shared prices** off
(Settings → Privacy and sharing; it was called Send prices back in 0.9.14). Only what the shop's website said:
never a price typed in by hand, never a price synced from another of the household's phones (0.10.0), and nothing
about the person, just a random number per install.

There's no key (a free app can't keep one secret), so every price is checked instead:
- each phone can send 200 times and 20,000 prices a day, and each internet address 600 times (counted in memory; the address is never written down);
- products are tidied as the helper phone's are: sensible prices, the last fortnight only;
- **every night at 3:00 am** (`NIGHTLY_TIME`) they're added to the shops' history and the files are published. A phone never replaces the collector's or the helper phone's own reading for a day, and never renames a product the collector knows;
- a price far from the last known one (under 35% or over 2.5 times it), or a product the collector hasn't seen, waits until a second phone sends the same price, for up to 14 days.

They wait in `/data/phones/<shop>.ndjson` (and `<shop>-held.ndjson`) until then. Every post is logged
(`docker logs restock-prices`), for example `share: 34 coles prices from a phone (12 posts, 410 prices today)`,
and STATUS.md's **From phones** column shows what the last nightly run added.

## Feedback from the app

Restock's **Settings → Send feedback** (on phones, the web page and the iPhone web app) sends here, to
`https://<this address>/feedback`: what it's about, the message, up to 3 screenshots, diagnostics (unless the person
turned them off) and an email only if they want a reply. A phone can send 5 a day.

- Each message is kept in its own folder in the volume: `/data/feedback/<when>-<id>/` (`feedback.json` and the screenshots).
- **Read them at `https://<this address>/feedback/inbox`**. The browser asks for a password: any user name, and
  `FEEDBACK_PASSWORD` from the container's settings. Open one to see its screenshots and diagnostics, and mark it done.
- Nothing is sent anywhere else.
- Email addresses in the inbox are marked so Cloudflare's *Email Address Obfuscation* leaves them alone. If you
  still see `[email protected]`, turn that off for this site (Cloudflare: **Scrape Shield → Email Address
  Obfuscation**).

## Running it (Docker)

Use `compose.yaml` (in Dockge: **+ Compose**, name it `restock-prices`, paste it in). In Dockge's **.env** box put:

```
GITHUB_TOKEN=
HELPER_KEY=
FEEDBACK_PASSWORD=
```

each followed by its value: `GITHUB_TOKEN` a fine-grained token for this repository only, with **Contents: read
and write** (without one it still collects, and keeps the files in its volume under `/data/out`); `HELPER_KEY`
any long password, typed into the price helper phone too; `FEEDBACK_PASSWORD` the password for the feedback inbox.
Port 8790 takes the price helper's uploads, the prices phones send back and the app's feedback: put it behind your reverse proxy with HTTPS
(for example `https://restock-prices.plenty.family`).

```
docker exec restock-prices node collect.mjs run              # all shops now
docker exec restock-prices node collect.mjs run coles        # one shop now
docker exec restock-prices node collect.mjs probe coles      # one page, saved to /data/probe, to see what a shop sends
docker exec restock-prices node collect.mjs inbox            # add the helper phone's and phones' prices now, and publish (it does this every night)
docker logs restock-prices                                   # what it did
```

| Setting | Default | |
|---|---|---|
| `SHOPS` | `woolworths,coles,aldi,costco` | which shops to collect |
| `RUN_DAY` / `RUN_TIME` | `thu` / `01:00` | when (the container's `TZ`) |
| `RETRY_DAY` | `fri` | the retry for a shop that failed or came back short |
| `DELAY_MS` | `1500` | pause between requests to a shop |
| `GIT_REPO` | `d-plenty/restock-prices` | where to push |
| `WOOLWORTHS_SOURCE` | `hotprices` | `site` reads Woolworths' own pages instead (Woolworths turns those away) |
| `COLES_SOURCE` | `auto` | `auto`: Coles' site, hotprices.org if Coles blocks it. `site` or `hotprices` for one only |
| `ALDI_WORDS` | a list of about 120 | the words Aldi is searched with |
| `HELPER_KEY` | (none) | turns on the price helper's uploads; the phone sends it as its key |
| `HELPER_PORT` | `8790` | the port for the price helper, prices from phones and feedback |
| `NIGHTLY_TIME` | `03:00` | when phones' prices go in and the day-one files are published again |
| `FEEDBACK_PASSWORD` | (none) | the password for `/feedback/inbox` (feedback is still taken without one, just not readable) |

If the container was off at run time (a TrueNAS update or a power cut), it runs as soon as it starts again, any day up to the next run.

## Licence

The collector's code is GPL-3.0 (see `LICENSE`). The data has no licence from this project: see
[NOTICE-DATA.md](NOTICE-DATA.md).
