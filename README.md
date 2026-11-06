# Sunstate Site Invoices

Site staff photograph supplier invoices on their phone and send them to the office. Each invoice
is filed under its site, and the office downloads them as PDFs (one at a time, or every new
invoice at once as a ZIP with a folder per site), then marks them processed.

It sits alongside the **Fuel Dockets** app:

- Staff get one Sunstate home screen with two buttons: *Supplier invoice* (this app) and
  *Fuel delivery docket* (opens Fuel Dockets).
- In the office, each site has an **Invoices** tab and a **Fuel dockets** tab. The dockets tab
  shows that site's dockets straight from Fuel Dockets, with a PDF download per delivery.
- When staff add a photo, the app reads the supplier, invoice number, date and total from it
  using Fuel Dockets' existing Claude connection, so this app needs no API key of its own.
  Staff check the highlighted fields before sending.

It runs as one Cloudflare Worker. Photos and details are stored in an R2 bucket.

## Set it up (about 10 minutes, all in the Cloudflare dashboard)

1. **Create the storage.** R2 Object Storage → Create bucket → name it `sunstate-invoices` →
   Create.
2. **Deploy from GitHub.** Workers & Pages → Create → Import a repository → pick
   `SuntatePetroleum/SiteInvoices`. Keep the project name `siteinvoices` (it must match
   `wrangler.toml`) and the deploy command `npx wrangler deploy`. Deploy.
   Every push to the repository redeploys it.
3. **Lock the office screens.** Open the `siteinvoices` Worker → Settings → Variables and
   Secrets → Add → Type: **Secret** → name `OFFICE_PIN`, value: a passcode of 8+ characters.
   Optional: add a `STAFF_PIN` secret too if you want staff to enter a PIN the first time they
   open the app on a phone. Without `OFFICE_PIN`, anyone with the link can open the office view.
4. **Add your sites.** Open `https://siteinvoices.<your-subdomain>.workers.dev/#/office`, enter
   the passcode → Manage sites → type the sites, one per line → Add.
   Under *Fuel Dockets locations*, link each location name drivers have used in Fuel Dockets
   to its site (the app suggests matches, e.g. "Goomborian" → Goomboorian).
5. **Put it on the site phones.** Open the app link in Safari → pick the site → Share →
   *Add to Home Screen*. It installs with the Sunstate icon.

Bookmark the `#/office` address on office computers.

## Settings (in `wrangler.toml`)

| Setting | What it does |
| --- | --- |
| `INVOICES` R2 bucket | Where photos and details are stored (`sunstate-invoices`). |
| `DOCKETS` service | The Fuel Dockets Worker. `service = "fueldockets"` must match that Worker's name. |
| `DOCKETS_URL` | Where the *Fuel delivery docket* buttons go. |
| `AUTOFILL` | `on` reads invoice photos automatically; `off` turns it off. |
| `AUTOFILL_MODEL` (optional var) | Claude model for reading invoices. Default `claude-sonnet-4-6`, the same one Fuel Dockets uses. |

Secrets (set in the dashboard, never in this file): `OFFICE_PIN`, `STAFF_PIN`. Changing either
signs every device out.

## How it works

- **Staff:** pick the site once (remembered on the phone) → *Supplier invoice* → take a photo of
  each page → check the details → *Send to office*. Photos are shrunk on the phone first
  (about 0.5 MB a page), so uploads are quick on mobile data. If the signal drops, *Try again*
  carries on without re-sending pages that already went through. If the same invoice number
  from the same supplier was already sent from that site in the last two months, staff are
  asked before sending it again.
- **Office:** the home screen shows how many invoices are new across all sites (last three
  months), with *Download all new (ZIP)*. After a download the app offers to mark them
  processed. Open a site to see any month, filter New / All / Processed, open an invoice to see
  the pages full size, fix the details, download its PDF, change its status or delete it.
- **Storage layout** in the bucket:
  `invoices/<site>/<YYYY-MM>/<invoice id>/p1.jpg, p2.jpg, … meta.json`, plus
  `config/sites.json` and `config/suppliers.json`. Months are by upload date (Brisbane time).

R2's free allowance is 10 GB, roughly 20,000 invoice pages, before any charge applies.

## Run it on your own computer

Needs Node.js 22 or later. No packages to install.

```
node dev/server.mjs 8787
```

Then open http://localhost:8787. The test server keeps everything in memory and pretends to be
Fuel Dockets (three sample locations and an invoice reader that always returns the same
details). `OFFICE_PIN=1234 node dev/server.mjs` tries the passcode screen.

## Files

- `src/index.js`: the Worker: API, passcodes, storage and the Fuel Dockets connection.
- `src/ui.html`: the whole app screen (HTML, styles and script in one file), including the PDF
  and ZIP builders used for downloads.
- `src/assets/`: the Sunstate symbol and home-screen icons.
- `dev/`: the local test server.
