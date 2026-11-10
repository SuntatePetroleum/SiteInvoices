# Sunstate Site Invoices

One app for the paperwork that comes into Sunstate sites:

- **Supplier invoices:** site staff photograph them and send them to the office, filed under
  their site.
- **Fuel delivery dockets:** drivers or site staff photograph the bill of lading. It is filed
  under the site the fuel went to, or under every site for a split load.

The office sees both per site (an **Invoices** tab and a **Fuel dockets** tab), downloads them as
PDFs (one at a time, or everything new as a ZIP with a folder per site), then marks them
processed.

When someone adds a photo, the app reads the details with Claude and fills them in: supplier,
number, date and total for an invoice; supplier (IOR / Viva Energy / Other), docket number,
delivery date and, on a driver's phone, the delivery site(s) for a docket. People check the
highlighted details before sending.

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
5. **Put it on the phones.** Open the app link in Safari → pick the site (or *I'm a delivery
   driver* on a driver's phone) → Share → *Add to Home Screen*. It installs with the Sunstate
   icon.

Bookmark the `#/office` address on office computers.

## Settings (in `wrangler.toml`)

| Setting | What it does |
| --- | --- |
| `INVOICES` R2 bucket | Where photos and details are stored (`sunstate-invoices`). |
| `DOCKETS_URL` | The old Fuel Dockets app: bringing its dockets across, and reading photos until this app has its own key. |
| `AUTOFILL` | `on` reads photos automatically; `off` turns it off. |
| `AUTOFILL_MODEL` (optional var) | Claude model for reading photos. Default `claude-sonnet-4-6`, the same one Fuel Dockets uses. |

Secrets (set in the dashboard, never in this file):

- `OFFICE_PIN`, `STAFF_PIN`: passcodes. Changing either signs every device out.
- `ANTHROPIC_API_KEY` (optional): a Claude API key for reading photos. Without it the app
  borrows the old Fuel Dockets app's Claude connection, so add it before switching that app off.

## Moving off the old Fuel Dockets app

1. Office → **Manage sites** → *Old Fuel Dockets app*: link each location name the drivers typed
   to its site (the app suggests matches, e.g. "Goomborian" → Goomboorian), then tap
   **Bring across**. Old dockets are filed under their sites, marked processed. Running it again
   only adds what is missing, so it is safe to repeat after drivers have stopped using the old app.
2. Add the `ANTHROPIC_API_KEY` secret (above).
3. The old app can then be switched off. Remove `DOCKETS_URL` from `wrangler.toml` at the same
   time.

## How it works

- **Site phones:** pick the site once (remembered on the phone). The home screen has *Supplier
  invoice* and *Fuel delivery docket*; the camera button asks which. A docket starts filed under
  the phone's site; add more sites for a split load.
- **Driver phones:** choose *I'm a delivery driver*. The camera goes straight to a docket, and the
  delivery site(s) are read off the docket (check them before sending). The home screen lists
  what that phone has sent.
- **Sending:** photos are shrunk on the phone first (about 0.5 MB a page), so uploads are quick on
  mobile data. If the signal drops, *Try again* carries on without re-sending pages that already
  went through. If the same invoice or docket number from the same supplier was sent in the last
  two months (for a docket, to any of its sites), the app asks before sending it again.
- **Office:** the home screen shows how many invoices and dockets are new across all sites (last
  three months), with *Download all new (ZIP)*. After a download the app offers to mark them
  processed. Open a site, pick the Invoices or Fuel dockets tab, then any month; filter New / All
  / Processed, open one to see the pages full size, fix the details, download its PDF, change its
  status or delete it.
- **Storage layout** in the bucket:
  `invoices/<site>/<YYYY-MM>/<id>/…` and `dockets/<site>/<YYYY-MM>/<id>/…` (`p1.jpg`, `p2.jpg`, …
  `meta.json`), plus `config/sites.json` and `config/suppliers.json`. Months are by upload date
  (Brisbane time). A split-load docket is stored once per site.

R2's free allowance is 10 GB, roughly 20,000 pages, before any charge applies.

## Run it on your own computer

Needs Node.js 22 or later. No packages to install.

```
node server.mjs 8787
```

Then open http://localhost:8787. The test server keeps everything in memory and pretends to be
the old Fuel Dockets app (three sample locations, and a photo reader that always returns the
same invoice or docket details). `OFFICE_PIN=1234 node server.mjs` tries the passcode screen.

## Files

- `index.js`: the Worker: API, passcodes, storage, photo reading and the old Fuel Dockets import.
- `ui.html`: the whole app screen (HTML, styles and script in one file), including the PDF and
  ZIP builders used for downloads.
- `symbol-*.png`, `icon-*.png`, `apple-touch-icon.png`, `favicon-64.png`: the Sunstate symbol
  and home-screen icons.
- `server.mjs`, `loader.mjs`, `sample-docket.jpg`: the local test server.
