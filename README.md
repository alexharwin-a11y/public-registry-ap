# Federal Register K-12 Monitor

Static Netlify app for publishing daily K-12-relevant Federal Register updates from `data/updates.json`, with a Claude-backed archive search endpoint.

## Files

- `index.html` renders the latest report, archive, and search UI.
- `data/updates.json` is the public archive.
- `netlify/functions/search.mjs` loads the archive server-side, retrieves relevant entries, and streams Claude's answer.
- `scripts/commit_daily_updates.py` validates and commits new daily entries to GitHub from the scheduled task.

## Netlify Environment Variables

Set these in Netlify site settings:

- `ANTHROPIC_API_KEY`
- `UPDATES_JSON_URL`, for example `https://raw.githubusercontent.com/YOUR_USER/federal-register-k12/main/data/updates.json`
- `ANTHROPIC_MODEL` optional, defaults to `claude-haiku-4-5-20251001`

## Cowork Task Secrets

Set these where the scheduled task runs:

- `GITHUB_TOKEN`
- `GITHUB_REPO`, for example `YOUR_USER/federal-register-k12`
- `GITHUB_BRANCH` optional, defaults to `main`

In the scheduled task, build a `new_entries` list and call:

```python
from scripts.commit_daily_updates import commit_new_entries

commit_new_entries(new_entries)
```

## Local Development

Copy `.env.example` to `.env` and set:

- `ANTHROPIC_API_KEY`
- `UPDATES_JSON_URL`

Set `UPDATES_JSON_URL` to the raw GitHub URL for `data/updates.json`. Both the local browser UI and local search function will read from that URL.

Run the full local app, including `/api/search`, without needing the Netlify CLI:

```sh
npm run dev
```

The local URL is `http://localhost:8888`.

To test with Netlify's CLI instead, install it and run:

```sh
npm run dev:netlify
```

For static UI work that does not need Claude search:

```sh
npm run dev:static
```

Then open `http://localhost:8888`.
```
