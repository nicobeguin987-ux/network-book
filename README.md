# Network Book

A private, local-first CRM for your LinkedIn network. Import your `Connections.csv` and every contact is tagged by **industry, geography, seniority and function**. You can browse by company, keep a to-do list, log conversations, and have **Claude draft your outreach**. Follow-ups schedule themselves.

It is a static web app with no server and no build step. Your data lives in your browser (IndexedDB). The only data in this repo is an optional **encrypted** file that only your passphrase can open.

## Features

- **Overview:** your network map by industry, geography, seniority and function, ready-made lists, what's due today, and your latest notes.
- **People:** search plus filters for status, industry, geography, seniority, function, tags, priority and year connected. Bulk-tag people, set their status, or create to-dos for many at once. Export any view to CSV.
- **Companies:** click a company to see everyone you know there. You can set the office location or a tag for all of them at once.
- **Person record:** status, priority, a keep-in-touch reminder, tags, time at the company, email, to-dos, and a conversation log.
- **Activate:** pick a list (priority people, trip, catch-ups due, investors, untouched decision-makers…) and Claude drafts every message in one go. You edit each one, copy it, send it on LinkedIn, then click **Mark as sent**. The message is logged and a follow-up is scheduled.
- **Claude helpers:** a draft for one person, “Tidy up with Claude” (turns rough notes into a clean entry plus to-dos), and a meeting prep brief.
- **Google:** create Gmail drafts and Calendar events with your own Google sign-in. Without it, you get pre-filled Gmail and Calendar pages instead.
- **Keep it current:** re-import a fresh `Connections.csv`. New connections are added, and job or title changes are flagged with a "congratulate" to-do.
- **Backups:** export or restore a JSON file, or create an encrypted `vault.json` for the repo.

Nothing is ever sent on LinkedIn for you. The app has no LinkedIn access: it only reads the CSV you export yourself.

## Privacy model

| What | Where it lives |
|---|---|
| Contacts, notes, to-dos, drafts, edits | Your browser (IndexedDB), on each device you use |
| Anthropic API key, Google client ID | Your browser only. Never in backups unless you tick the box, never in `vault.json` |
| `data/vault.json` (optional) | This repo, encrypted with AES-256-GCM using a key derived from your passphrase (PBKDF2-SHA256, 600,000 iterations). Unreadable without the passphrase |
| Claude requests | Sent from your browser straight to `api.anthropic.com`, with only the facts needed for that draft |
| Google requests | Sent from your browser straight to Gmail and Calendar APIs, with a short-lived token |

The `.gitignore` blocks CSV files, backups and passphrase files, so none of them get committed by mistake. The page sends `noindex` and a strict Content-Security-Policy.

## Getting started

1. **Open the site:** `https://<your-user>.github.io/network-book/`.
2. **Load your data**, using either option:
   - **Unlock:** if `data/vault.json` is in the repo, enter the passphrase.
   - **Import:** on LinkedIn, go to *Settings & Privacy → Data privacy → Get a copy of your data → Download larger data archive*, unzip it and pick `Connections.csv`.
3. **Fill in Settings:** your first name, a line about you, your sign-off, and your next trip.
4. **Add a Claude key** (optional): create one at [console.anthropic.com](https://console.anthropic.com) → *API keys*, set a monthly spend limit, paste it in *Settings → Claude* and click **Save and test**.

### Publish with GitHub Pages

In the repo, go to *Settings → Pages → Build and deployment → Source: Deploy from a branch*, then pick `main` and `/ (root)` and save. The site goes live a minute later.

### Google sign-in (optional)

1. In [Google Cloud Console](https://console.cloud.google.com), create a project.
2. Go to *APIs & Services → Library* and enable the **Gmail API** and the **Google Calendar API**.
3. In *OAuth consent screen*, choose *External*, keep it in *Testing*, and add your own Gmail address as a **test user**.
4. In *Credentials → Create credentials → OAuth client ID*, choose *Web application*. Under **Authorized JavaScript origins**, add:
   - `https://<your-user>.github.io`
   - `http://localhost:8000` (for local use)
5. Copy the client ID into *Settings → Google*, save, and click **Connect Google**.

The client ID is not a secret. While the consent screen is in Testing, only the test users you listed can sign in. Tokens last about an hour and live only in memory.

### Move your data between browsers

- **Backup:** *Settings → Your data → Backup → Download* on one browser, then **Restore** on the other.
- **Encrypted vault:** *Settings → Your data → Encrypted copy for the repo* creates `vault.json`. Commit it as `data/vault.json`, and any browser can unlock it with the passphrase. Your API key is never included.

Changes you make after unlocking stay in that browser. Re-create the vault whenever you want the repo copy refreshed.

## Run it locally

```bash
cd network-book
python3 -m http.server 8000
# open http://localhost:8000
```

ES modules need a web server, so opening `index.html` directly from the file system does not work.

## Project layout

```
index.html          app shell + Content-Security-Policy
css/app.css         design tokens (light and dark) and layout
js/app.js           views, filtering, to-dos, journal, outreach flows
js/classify.js      industry / geography / seniority / function classifier + CSV reader
js/rules-data.js    starter company dictionary and patterns (no personal data)
js/store.js         IndexedDB document store
js/ai.js            Anthropic Messages API client (streaming + JSON helper)
js/google.js        Google Identity Services, Gmail drafts, Calendar events, link fallbacks
js/vault.js         passphrase encryption for data/vault.json
data/vault.json     optional encrypted data bundle
```

## Limitations

- LinkedIn's export has no start dates, locations or industries, so the app infers them. Geography comes from the job title or the company's base. People at global firms start as *Unknown* until you set them, which you can do for a whole company at once. Time at a company comes from re-imports (approximate) or is entered by hand.
- Browser storage can be cleared by the browser or by you. Keep a backup or an up-to-date vault.
- Classification is rule-based and tuned for finance and tech networks in France and the UK. Every field can be edited.
