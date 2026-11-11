# Restock prices

Weekly Australian supermarket prices for [Restock](https://github.com/d-plenty/Restock): Coles, Woolworths,
Aldi and Costco. One file per shop with products, sizes, barcodes (where the shop shows them) and price history.
Restock's **Judge deals from day one** uses it to know a product's usual price and usual sale price straight away.

Not affiliated with any shop. Read [NOTICE-DATA.md](NOTICE-DATA.md) before using the data.

## The files

| Path | What's in it |
|---|---|
| `latest/<shop>.json.gz` | Every product seen in the last 90 days, with its prices for the last year. Restock's import format (`restock-export`, the same as the server's Data tab). This is what phones download. |
| `latest/<shop>-details.json.gz` | Extra facts per product: category, the shop's unit price text and a link. |
| `history/<shop>/<year>.json.gz` | Prices older than a year, by product. |
| `STATUS.md` | The last run: how many products each shop returned, and whether it worked. |

Shops: `woolworths`, `coles`, `aldi`, `costco`. A price is only written when it changes (price, was-price,
special, member-only or promo), so the files stay small. Sizes are also given as `qty` + `qty_unit` (`g`, `ml`
or `ea`), so per-litre and per-kilo prices can be compared.

## How it's collected

The collector in `collector/` runs once a week, on **Thursday at 1:00 am** (Brisbane time), a day after Coles'
and Woolworths' weekly specials start on Wednesday. On **Friday at 1:00 am** it tries again, but only for a shop
that failed or returned far fewer products than last time.

- It reads the same public pages each shop's own website uses. No accounts and no sign-ins.
- One request at a time, with a pause of about 1.5 seconds between requests. A full run takes a few hours.
- It says who it is in every request (`RestockPrices/1.0`, with a link here).
- If a shop refuses (a robot check or "too many requests"), it stops that shop and tries again next time. It
  never tries to get around a shop's checks.
- Stock isn't collected: it's only meaningful for your own branch, which each phone checks itself.

## Running it (Docker)

Use `compose.yaml` (in Dockge: **+ Compose**, name it `restock-prices`, paste it in). Fill in `GITHUB_TOKEN`
with a fine-grained token for this repository only, with **Contents: read and write**. Without a token it
still collects, and keeps the files in its volume under `/data/out`.

```
docker exec restock-prices node collect.mjs run              # all shops now
docker exec restock-prices node collect.mjs run coles        # one shop now
docker exec restock-prices node collect.mjs probe coles      # one page, saved to /data/probe, to see what a shop sends
docker logs restock-prices                                   # what it did
```

| Setting | Default | |
|---|---|---|
| `SHOPS` | `woolworths,coles,aldi,costco` | which shops to collect |
| `RUN_DAY` / `RUN_TIME` | `thu` / `01:00` | when (the container's `TZ`) |
| `RETRY_DAY` | `fri` | the retry for a shop that failed or came back short |
| `DELAY_MS` | `1500` | pause between requests to a shop |
| `GIT_REPO` | `d-plenty/restock-prices` | where to push |

## Licence

The collector's code is GPL-3.0 (see `LICENSE`). The data has no licence from this project: see
[NOTICE-DATA.md](NOTICE-DATA.md).
