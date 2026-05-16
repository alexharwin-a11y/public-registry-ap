# Federal Register K-12 Monitor — Web App Build Plan

## Overview

Build a public-facing web app that:
1. Displays daily Federal Register K-12 education updates in a structured executive summary format
2. Provides a Claude-powered natural language search box so visitors can query across all logged updates
3. Requires no traditional database — GitHub acts as the data store
4. Updates automatically each day without any manual intervention

---

## Architecture

```
[Cowork Scheduled Task] → commits to → [GitHub Repo / updates.json]
                                                 ↓
                                    [Vercel — static frontend]
                                         ↙           ↘
                               [User Browser]   [Vercel Serverless Function]
                                                         ↓
                                               [Anthropic Claude API]
```

**Stack:**
- **Frontend:** Single `index.html` (vanilla HTML/CSS/JS, no framework)
- **Hosting:** Vercel (free tier, deploys automatically from GitHub)
- **Data store:** `data/updates.json` in the GitHub repo — one JSON array, one object per daily entry
- **Search backend:** Single Vercel serverless function (`/api/search`) that proxies Claude API calls
- **API key security:** `ANTHROPIC_API_KEY` stored as a Vercel environment variable, never in the frontend

---

## Repository Structure

```
federal-register-k12/
├── index.html                  # Full frontend — displays updates + search UI
├── api/
│   └── search.js               # Vercel serverless function — Claude API proxy
├── data/
│   └── updates.json            # The "database" — grows by ~1-5 entries per day
├── vercel.json                 # Vercel config
└── README.md                   # Setup instructions
```

---

## Data Format

### `data/updates.json`

A single JSON array. Each daily run appends new objects. If there are no new items on a given day, nothing is appended.

```json
[
  {
    "id": "2026-05-14-ED-2026-OPE-0042",
    "dateFound": "2026-05-14",
    "weekOf": "May 9",
    "docNumber": "ED-2026-OPE-0042",
    "title": "Ready to Learn Television Programming",
    "agency": "Dept. of Education + Dept. of Health & Human Services",
    "documentType": "Notice",
    "categoryType": "Grant Competition",
    "regulatoryStage": "Grant competition open — new grantee preference",
    "commentDeadline": "TBD",
    "effectiveDate": "N/A",
    "k12Relevance": "Funds educational TV and digital media for preK–Grade 2 students.",
    "summary": "ED and HHS reopened the Ready to Learn grant with a competitive preference for new grantees, following termination of the prior CPB/PBS grant in 2025.",
    "context": "CPB/PBS had their RTL grant terminated in 2025. The new preference structure effectively sidelines PBS KIDS. Public media advocates have formally objected.",
    "federalRegisterLink": "https://www.federalregister.gov/documents/2026/05/14/...",
    "executiveSummaryBullets": [
      "Ready to Learn reopened with explicit preference against prior grantee PBS KIDS — public media groups objected formally.",
      "No equivalent production/distribution network exists outside public broadcasting."
    ]
  }
]
```

---

## File 1: `index.html`

Build a single-page app with three sections:

### Header
- Site title: "Federal Register K-12 Monitor"
- Subtitle: "Daily tracking of federal education policy affecting K-12 schools"
- Clean, professional styling — no framework, inline CSS

### Section 1: Latest Update (top of page)
- On page load, fetch `data/updates.json`
- Find the most recent `dateFound` value
- Display all entries from that date as "Today's Report" (or "Latest Report — [date]")
- Format:
  - **Executive Summary** block with bullet points (pulled from `executiveSummaryBullets` array)
  - Below that, expandable detail cards — one per entry — showing all fields

### Section 2: Search / Ask Claude
- Prominent text input: placeholder = *"Ask anything — e.g. 'tell me notices about Vermont' or 'any NPRMs with upcoming deadlines?'"*
- Submit button: "Ask"
- Below the input, a response area where Claude's answer streams in
- Small disclaimer under the box: "Answers are based on entries logged in this tracker."

### Section 3: Full Archive
- Collapsible accordion grouped by week (using the `weekOf` field)
- Each week shows a summary count ("4 items") and expands to show all entries for that week
- Within each week, entries are displayed as compact cards

### Search Logic (client-side, before calling Claude)

```javascript
async function handleSearch(query) {
  const data = await fetchUpdates(); // cached after first load

  // 1. Keyword pre-filter
  const queryLower = query.toLowerCase();
  const synonyms = {
    "special needs": "special education",
    "dept of ed": "department of education",
    "doe": "department of education",
    "dol": "department of labor",
    "nprm": "nprm",
  };

  // Expand query terms using synonym map
  let searchTerms = [queryLower];
  for (const [alias, canonical] of Object.entries(synonyms)) {
    if (queryLower.includes(alias)) searchTerms.push(canonical);
  }

  // Search across all text fields
  const fields = ["title", "agency", "summary", "context", "k12Relevance",
                  "documentType", "categoryType", "regulatoryStage"];

  let matches = data.filter(entry =>
    searchTerms.some(term =>
      fields.some(field =>
        (entry[field] || "").toLowerCase().includes(term)
      )
    )
  );

  // Fallback: if no keyword matches, send last 60 days of entries
  if (matches.length === 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 60);
    matches = data.filter(e => new Date(e.dateFound) >= cutoff);
  }

  // 2. Send to Claude via serverless function
  const response = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, entries: matches })
  });

  // 3. Stream the response
  const reader = response.body.getReader();
  // ... render streaming text into response area
}
```

---

## File 2: `api/search.js`

Vercel serverless function. Proxies to Anthropic Claude API. Includes rate limiting.

```javascript
// api/search.js

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // max 10 requests per IP per minute
const ipMap = new Map();

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Rate limiting
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const now = Date.now();
  const record = ipMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  record.count++;
  ipMap.set(ip, record);
  if (record.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  }

  const { query, entries } = req.body;

  if (!query || !entries) {
    return res.status(400).json({ error: "Missing query or entries" });
  }

  // Format entries as readable context
  const context = entries.map(e => `
---
Date: ${e.dateFound}
Title: ${e.title}
Agency: ${e.agency}
Type: ${e.documentType} — ${e.categoryType}
Regulatory Stage: ${e.regulatoryStage}
Comment/Application Deadline: ${e.commentDeadline}
Effective Date: ${e.effectiveDate}
K-12 Relevance: ${e.k12Relevance}
Summary: ${e.summary}
Context: ${e.context}
Link: ${e.federalRegisterLink}
  `.trim()).join("\n\n");

  const systemPrompt = `You are a K-12 education policy assistant for a Federal Register monitoring service. 
Answer the user's question based only on the logged Federal Register entries provided below.
Be specific. Cite document titles and dates. Flag anything with upcoming deadlines.
If the entries don't contain enough information to answer, say so clearly.
Do not draw on outside knowledge — only the entries provided.`;

  const userMessage = `Here are the relevant logged Federal Register entries:\n\n${context}\n\n---\n\nUser question: ${query}`;

  // Call Anthropic API
  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      stream: true,
    }),
  });

  // Stream response back to browser
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    res.write(chunk);
  }

  res.end();
}
```

---

## File 3: `vercel.json`

```json
{
  "functions": {
    "api/search.js": {
      "maxDuration": 30
    }
  }
}
```

---

## File 4: GitHub Commit Logic

This is the Python snippet the Cowork scheduled task runs at the end of each daily report to commit new entries to GitHub.

Add this to the end of the scheduled task (after delivering the chat report):

```python
import json
import base64
import urllib.request
import urllib.error
import os
from datetime import date

GITHUB_TOKEN = os.environ["GITHUB_TOKEN"]       # Set in Cowork task secrets
GITHUB_REPO = os.environ["GITHUB_REPO"]         # e.g. "alexharwin/federal-register-k12"
FILE_PATH = "data/updates.json"
BRANCH = "main"

def get_current_json():
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{FILE_PATH}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json"
    })
    with urllib.request.urlopen(req) as r:
        data = json.loads(r.read())
    content = base64.b64decode(data["content"]).decode("utf-8")
    return json.loads(content), data["sha"]

def commit_updated_json(new_entries, current_data, sha):
    if not new_entries:
        return  # Nothing to commit today
    updated = current_data + new_entries
    content_bytes = json.dumps(updated, indent=2).encode("utf-8")
    encoded = base64.b64encode(content_bytes).decode("utf-8")
    payload = json.dumps({
        "message": f"Daily update: {date.today().isoformat()}",
        "content": encoded,
        "sha": sha,
        "branch": BRANCH
    }).encode("utf-8")
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{FILE_PATH}"
    req = urllib.request.Request(url, data=payload, method="PUT", headers={
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json"
    })
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# new_entries = list of dicts built during the daily run (one per qualifying document)
current_data, sha = get_current_json()
commit_updated_json(new_entries, current_data, sha)
```

---

## Environment Variables

Set these in Vercel dashboard under Project → Settings → Environment Variables:

| Variable | Value | Used By |
|---|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key | `api/search.js` |

Set these as secrets in the Cowork scheduled task:

| Variable | Value | Used By |
|---|---|---|
| `GITHUB_TOKEN` | GitHub personal access token (repo write scope) | Daily commit script |
| `GITHUB_REPO` | `your-username/federal-register-k12` | Daily commit script |

---

## Initial Setup Steps

1. **Create GitHub repo** — name it `federal-register-k12`, set to public
2. **Create `data/updates.json`** — initialize with the existing 4 entries from the May 9 week (use the data format above)
3. **Add all files** — `index.html`, `api/search.js`, `vercel.json`
4. **Deploy to Vercel** — connect GitHub repo at vercel.com, it auto-deploys on every push
5. **Set `ANTHROPIC_API_KEY`** in Vercel environment variables
6. **Generate GitHub token** — github.com → Settings → Developer settings → Personal access tokens → repo scope
7. **Update Cowork scheduled task** — add GitHub commit logic and set `GITHUB_TOKEN` / `GITHUB_REPO` secrets

---

## Cost Estimates (monthly, low traffic)

| Item | Cost |
|---|---|
| Vercel hosting | Free |
| GitHub | Free |
| Claude Haiku (search queries) | ~$0.001 per query — negligible |
| Anthropic API (daily monitor task) | ~$0.05–0.10/day |

Set a $20/month account limit in Anthropic Console as a safety ceiling.

---

## Future Enhancements (optional, not in scope now)

- Add a "Subscribe" button that emails users when new entries are posted (Resend or Buttondown)
- Add week-by-week trend charts (Chart.js, inline in index.html)
- Add topic filtering buttons (Special Education, Grants, Rulemaking, etc.)
- Add a "Reporter Tips" section that surfaces items flagged as high-interest
