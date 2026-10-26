# Family Blood Pressure Log — GitHub Pages Edition

A small, mobile-first blood-pressure log for a family. The parent-facing interface is intentionally **Simplified Chinese with large text**; developer comments and deployment instructions are in English.

**Hosting:** GitHub Pages (static files)  
**Database and login:** Supabase Auth + PostgREST  
**Build tools:** None. No npm, external JavaScript CDN, or GitHub Actions required.

## 1. Publish the app using GitHub Pages (no terminal needed)

1. Visit [GitHub: New repository](https://github.com/new).
2. Name it `family-bp` (or choose your own), select **Public** if you use GitHub Free, and **leave “Add a README file” unchecked**. Click **Create repository**.
3. Download and **extract** the provided GitHub Pages ZIP. Do **not** upload the ZIP itself into GitHub.
4. In the empty repository's Quick setup screen, click **uploading an existing file**. (If the repository already has files, use **Add file → Upload files** instead.)
5. Drag **all extracted files** to GitHub, including the hidden `.nojekyll` file, `index.html`, all JavaScript/CSS/icon files, `database.sql`, and `README.md`. Commit the files to the `main` branch.
6. Go to **Settings → Pages**. Under **Build and deployment**, select **Deploy from a branch**, select `main` and `/(root)`, then click **Save**.
7. On the same Pages settings screen, click **Visit site** when GitHub shows your published URL.

Example website address (replace both placeholders):

```
https://YOUR_GITHUB_USERNAME.github.io/family-bp/
```

For a different repository name, replace `family-bp` with its actual name. The app supports GitHub Pages project subpaths because **all local file links, the service worker, and the PWA manifest use relative paths**.

You do **not** need GitHub Actions, npm, Node.js, a server, a custom domain, or a paid plan. Updates publish when you commit replacement files to the selected branch.

## 2. Initialize Supabase tables (one time)

1. Open the [Supabase dashboard](https://supabase.com/dashboard/project/bpzbstdnhknmtvhvoegd).
2. Go to **SQL Editor → New query**.
3. Open [`database.sql`](./database.sql) in a plain-text editor and copy the **entire file** into the SQL Editor. The first line must be `BEGIN;`; the last statement is a `SELECT` showing table readiness.
4. Do **not** highlight or run only a section of the SQL. Click **Run** with the whole script pasted.
5. The final result should show `members_ready = true`, `measurements_ready = true`, and `sync_checks_ready = true`.

The SQL creates three tables and row-level security policies. Re-running the file is safe and does not delete existing measurements. **Do not run a snippet that starts with `code text ...`**; this is a column inside a `CREATE TABLE` statement, not a standalone SQL command.

## 3. Configure the Supabase authentication redirect URL

1. In Supabase, go to **Authentication → URL Configuration**.
2. Set **Site URL** to your **exact GitHub Pages website URL**, including the repository path and trailing `/` (for example, `https://YOUR_GITHUB_USERNAME.github.io/family-bp/`).
3. Add the same address in **Redirect URLs**, if required by your email confirmation flow.
4. Save changes.

The website already contains your supplied **Project URL** and **publishable key** in `config.js`. These are public browser settings; never replace them with a secret/service-role key or commit a family login password.

## 4. Create the family login and members

1. Open the published GitHub Pages URL.
2. Select **Create family account**, enter an email address and password, and complete email verification if Supabase requests it.
3. Sign in using the same family account on both parents' phones. The app remembers the logged-in session on each device.
4. Open **Family → Add member** to create Dad, Mom, and any future family members. Choose whether each member regularly takes blood-pressure medication.
5. Each phone can choose its default family member. Everyone using the shared account can view every family member's records.

**Adding a family member requires no SQL, code changes, or redeployment.** A family member is a profile, not a separate login account in this first version.

## 5. Test two-phone sync in mainland China, without a VPN

A successfully loading web page **does not** prove that the Supabase API works.

1. Using normal Wi-Fi and then mobile data, open the site on both an Android phone and an iPhone.
2. Sign into the same family account on both devices.
3. On phone A, open **Settings → Sync test → Write and read** (Chinese UI: **设置 → ① 写入并读取**). Note the six-digit code.
4. On phone B, choose **Read latest code** (Chinese UI: **② 读取最新标记**). Confirm the code matches.
5. Enter a fake/test reading on phone A; switch to the same family member on phone B and refresh. Confirm the reading appears and then delete the test reading.
6. Repeat these steps without a VPN on the networks your parents actually use.

If the page opens but syncing fails, check connectivity to `https://bpzbstdnhknmtvhvoegd.supabase.co` in the same environment. GitHub Pages and Supabase may both have inconsistent reachability from mainland China. Nothing in this repository can guarantee network access.

## 6. Add the app to a phone home screen

- **iPhone (Safari):** open the website → Share → Add to Home Screen.
- **Android (Chrome):** open the website → browser menu → Install app / Add to Home screen.

If you publish an update and a device appears to show the old version, reload while online. Service-worker app-shell caching uses a versioned cache name.

## 7. What's in this repository?

| File | Purpose |
| --- | --- |
| `index.html` | App entry point and relative resource links |
| `styles.css` | Responsive, large-text interface |
| `app.js` | Forms, family member management, history, and charts |
| `api.js` | Supabase Auth/PostgREST and demo backend |
| `config.js` | Public Supabase Project URL and publishable key |
| `database.sql` | One-time PostgreSQL schema and RLS setup |
| `manifest.webmanifest` | Home-screen app metadata and relative scope |
| `sw.js` | Offline caching of the static app shell (never caches Supabase API data) |
| `icon-192.png`, `icon-512.png`, `favicon.svg` | Home-screen and browser icons |
| `.nojekyll` | Stops GitHub Pages from transforming static assets via Jekyll |

## Important limitations

- This is a **shared family login**, not individually restricted family accounts. Everyone using that login can edit and delete records.
- Unsynced measurements are stored on the same device until sync succeeds. **Do not clear browser/site data before syncing.**
- The app can keep a form draft during network failure; it does not guarantee instant cross-device delivery.
- If a new Supabase Free project is inactive for a long period, the project may pause under the current Supabase free-tier policy.
- These files were checked locally, but **a real Supabase SQL execution, GitHub publication, and mainland-China phone test still need to be performed in your accounts**.
