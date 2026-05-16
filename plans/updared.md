# Federal Register K-12 Monitor — Web App Build Plan

## Overview

Build a public-facing web app that:
1. Displays daily Federal Register K-12 education updates in a structured executive summary format
2. Provides a Claude-powered natural language search box so visitors can query across the **full archive** — not just a browser-side subset
3. Requires no traditional database — GitHub acts as the data store
4. Updates automatically each day without any manual intervention

---

## Architecture

```
[Cowork Scheduled Task] → validates + commits to → [GitHub Repo / data/updates.json]
                                                              ↓
                                               [Netlify — static frontend]
                                                    ↙              ↘
                                          [User Browser]   [Netlify Function: /api/search]
                                          (sends query       (fetches full archive,
                                           string only)       filters, calls Claude)
                                                                      ↓
                                                          [Anthropic Claude API]
```

**Key design decisions:**
- The browser sends **only the user's query string** to the serverless function — never the data
- The Netlify function fetches `updates.json` server-side, does retrieval, and manages the token budget before calling Claude
- This means Claude always has access to the full archive regardless of query type
- `ANTHROPIC_API_KEY` is a Netlify environment variable — never exposed to the browser

**Stack:**
- **Frontend:** Single `index.html` (vanilla HTML/CSS/JS, no framework)
- **Hosting:** Netlify (free tier, deploys automatically from GitHub)
- **Data store:** `data/updates.json` in the GitHub repo — one JSON array, one object per daily entry
- **Search backend:** Single Netlify Function (`netlify/functions/search.js`) that fetches the archive and proxies to Claude
- **Config:** `netlify.toml` with redirect rule mapping `/api/search` → `/.netlify/functions/search`

---

## Repository Structure

```
federal-register-k12/
├── index.html                        # Full frontend — displays updates + search UI
├── netlify/
│   └── functions/
│       └── search.js                 # Netlify Function — fetches archive + Claude proxy
├── data/
│   └── updates.json                  # The "database" — grows by ~1-5 entries per day
├── netlify.toml                      # Netlify config + redirect rules
└── README.md                         # Setup instructions
```

---

## Schema Contract

This is the authoritative field definition. Every entry in `updates.json` must conform exactly. The daily task validates against this before committing.

### Entry Schema

```typescript
{
  id: string,                  // REQUIRED. Format: "{dateFound}_{docNumber}" e.g. "2026-05-14_ED-2026-OPE-0042"
                               // Deterministic — prevents duplicates if task runs twice
  dateFound: string,           // REQUIRED. ISO 8601 date: "YYYY-MM-DD"
  weekOf: string,              // REQUIRED. Format: "Month D" e.g. "May 9"
  docNumber: string,           // REQUIRED. Federal Register document number e.g. "ED-2026-OPE-0042"
                               // Use "UNKNOWN-{dateFound}-{index}" if not available
  title: string,               // REQUIRED. Full document title
  agency: string,              // REQUIRED. Full agency name(s), joined with " + " if multiple
  documentType: string,        // REQUIRED. Exactly one of:
                               //   "NPRM" | "Final Rule" | "Notice" | "Proposed Priority" | "Final Priority"
  categoryType: string,        // REQUIRED. e.g. "Grant Competition" | "Information Collection" |
                               //   "Public Meeting" | "Guidance" | "Rulemaking"
  regulatoryStage: string,     // REQUIRED. Free text e.g. "Grant competition open" | "Comment period open"
  commentDeadline: string,     // REQUIRED. ISO 8601 date "YYYY-MM-DD", or "TBD", or "N/A"
  effectiveDate: string,       // REQUIRED. ISO 8601 date "YYYY-MM-DD", or "TBD", or "N/A"
  k12Relevance: string,        // REQUIRED. 1-2 sentences explaining K-12 connection
  summary: string,             // REQUIRED. 3-5 sentences summarizing the document
  context: string,             // REQUIRED. Web research findings — press coverage, reactions, context
  federalRegisterLink: string, // REQUIRED. Full URL to the Federal Register document
  executiveSummaryBullets: string[]  // REQUIRED. Array of 1-3 strings used in the executive summary
                                     // Must have at least 1 item
}
```

### Validation Rules

All fields marked REQUIRED must be present and non-empty strings (or non-empty arrays for `executiveSummaryBullets`).

`documentType` must be exactly one of the five allowed values — no variations.

`dateFound`, `commentDeadline`, and `effectiveDate` (when not "TBD" or "N/A") must match `YYYY-MM-DD`.

`id` must be unique across the entire `updates.json` array.

---

## Data Format

### `data/updates.json`

A single JSON array. Each daily run appends validated new objects. Initialize the file with `[]` before the first commit.

```json
[
  {
    "id": "2026-05-14_ED-2026-OPE-0042",
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

Single-page app with three sections. Vanilla HTML/CSS/JS — no framework, no build step.

### Header
- Site title: "Federal Register K-12 Monitor"
- Subtitle: "Daily tracking of federal education policy affecting K-12 schools"

### Section 1: Latest Report
- On page load, fetch `/data/updates.json`
- Find all entries matching the most recent `dateFound`
- Display as "Latest Report — [date]"
- Format:
  - **Executive Summary** block — bullet points from `executiveSummaryBullets` across all entries for that date
  - Expandable detail cards, one per entry, showing all fields

### Section 2: Search / Ask Claude
- Text input: placeholder = *"Ask anything — e.g. 'tell me notices about Vermont' or 'any NPRMs with upcoming deadlines?'"*
- Submit button: "Ask"
- Streaming response area below
- Disclaimer: "Answers are based on entries logged in this tracker."
- The browser sends **only the query string** to `/api/search`:

```javascript
async function handleSearch(query) {
  const response = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query })   // query string only — no data payload
  });

  // Stream the response into the UI
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  responseArea.textContent = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // Parse SSE chunks and extract text delta
    const chunk = decoder.decode(value);
    const lines = chunk.split("\n").filter(l => l.startsWith("data:"));
    for (const line of lines) {
      try {
        const json = JSON.parse(line.slice(5));
        if (json.type === "content_block_delta") {
          responseArea.textContent += json.delta.text;
        }
      } catch {}
    }
  }
}
```

### Section 3: Full Archive
- Accordion grouped by week (`weekOf` field), newest first
- Each week shows entry count and expands to show compact entry cards
- Each card links to the Federal Register document

---

## File 2: `netlify/functions/search.js`

This function does everything: fetches the full archive, filters it, builds a token-budgeted context, and streams Claude's response back.

```javascript
// netlify/functions/search.js

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const ipMap = new Map();

// Token budget: estimate ~400 tokens per entry. Target max 80,000 tokens of context.
// This allows roughly 200 entries before truncation kicks in.
const MAX_ENTRIES_IN_CONTEXT = 200;
const GITHUB_RAW_URL = process.env.UPDATES_JSON_URL;
// Set UPDATES_JSON_URL in Netlify env vars to the raw GitHub URL of data/updates.json
// e.g. https://raw.githubusercontent.com/alexharwin/federal-register-k12/main/data/updates.json

exports.handler = async function(event, context) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  // Rate limiting by IP
  const ip = event.headers["x-forwarded-for"] || event.requestContext?.identity?.sourceIp || "unknown";
  const now = Date.now();
  const record = ipMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + RATE_LIMIT_WINDOW_MS; }
  record.count++;
  ipMap.set(ip, record);
  if (record.count > RATE_LIMIT_MAX) {
    return { statusCode: 429, body: JSON.stringify({ error: "Too many requests. Please wait a moment." }) };
  }

  const { query } = JSON.parse(event.body);
  if (!query) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing query" }) };
  }

  // Fetch full archive server-side
  const archiveRes = await fetch(GITHUB_RAW_URL);
  const allEntries = await archiveRes.json();

  // Server-side retrieval: keyword filter across all text fields
  const synonyms = {
    "special needs": "special education",
    "dept of ed": "department of education",
    "doe": "department of education",
    "dol": "department of labor",
  };

  const queryLower = query.toLowerCase();
  let searchTerms = [queryLower];
  for (const [alias, canonical] of Object.entries(synonyms)) {
    if (queryLower.includes(alias)) searchTerms.push(canonical);
  }

  const fields = ["title", "agency", "summary", "context", "k12Relevance",
                  "documentType", "categoryType", "regulatoryStage", "weekOf"];

  let matches = allEntries.filter(entry =>
    searchTerms.some(term =>
      fields.some(field => (entry[field] || "").toLowerCase().includes(term))
    )
  );

  // Fallback: broad/analytical queries — send most recent entries up to token budget
  if (matches.length === 0) {
    matches = [...allEntries].sort((a, b) => b.dateFound.localeCompare(a.dateFound))
                             .slice(0, MAX_ENTRIES_IN_CONTEXT);
  } else {
    // Cap at budget even for matched sets
    matches = matches.slice(0, MAX_ENTRIES_IN_CONTEXT);
  }

  // Format entries as readable context
  const contextText = matches.map(e => `
---
ID: ${e.id}
Date: ${e.dateFound} (Week of ${e.weekOf})
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
Answer the user's question based only on the logged Federal Register entries provided.
Be specific. Cite document titles and dates. Flag anything with upcoming deadlines.
If the provided entries don't contain enough information to answer fully, say so — do not draw on outside knowledge.
When entries span a long period, note any patterns or trends you observe across them.`;

  const userMessage = `Here are the relevant logged Federal Register entries (${matches.length} of ${allEntries.length} total):\n\n${contextText}\n\n---\n\nUser question: ${query}`;

  // Call Anthropic API with streaming
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

  // Stream Anthropic SSE response back to browser
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Transfer-Encoding": "chunked",
    },
    body: anthropicRes.body,
    isBase64Encoded: false,
  };
};
```

---

## File 3: `netlify.toml`

```toml
[build]
  publish = "."
  functions = "netlify/functions"

[[redirects]]
  from = "/api/search"
  to = "/.netlify/functions/search"
  status = 200

[[headers]]
  for = "/data/updates.json"
  [headers.values]
    Cache-Control = "public, max-age=300"
```

---

## File 4: Daily Task — JSON Construction + Validation + GitHub Commit

Add this to the end of the Cowork scheduled task, after the chat report is delivered. The task must build a `new_entries` list of dicts during the daily run (one dict per qualifying document), then this block validates and commits them.

```python
import json
import base64
import urllib.request
import re
import os
from datetime import date, datetime

GITHUB_TOKEN = os.environ["GITHUB_TOKEN"]
GITHUB_REPO = os.environ["GITHUB_REPO"]   # e.g. "alexharwin/federal-register-k12"
FILE_PATH = "data/updates.json"
BRANCH = "main"

ALLOWED_DOC_TYPES = {"NPRM", "Final Rule", "Notice", "Proposed Priority", "Final Priority"}
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
REQUIRED_FIELDS = [
    "id", "dateFound", "weekOf", "docNumber", "title", "agency",
    "documentType", "categoryType", "regulatoryStage", "commentDeadline",
    "effectiveDate", "k12Relevance", "summary", "context",
    "federalRegisterLink", "executiveSummaryBullets"
]

def validate_entry(entry, existing_ids):
    errors = []
    for field in REQUIRED_FIELDS:
        val = entry.get(field)
        if val is None or val == "" or val == []:
            errors.append(f"Missing or empty field: {field}")
    if entry.get("documentType") not in ALLOWED_DOC_TYPES:
        errors.append(f"Invalid documentType: {entry.get('documentType')}")
    for date_field in ["dateFound", "commentDeadline", "effectiveDate"]:
        val = entry.get(date_field, "")
        if val not in ("TBD", "N/A") and not DATE_PATTERN.match(val):
            errors.append(f"Invalid date format in {date_field}: {val}")
    if entry.get("id") in existing_ids:
        errors.append(f"Duplicate id: {entry.get('id')}")
    if not isinstance(entry.get("executiveSummaryBullets"), list) or len(entry.get("executiveSummaryBullets", [])) < 1:
        errors.append("executiveSummaryBullets must be a list with at least 1 item")
    return errors

def make_id(entry):
    doc = re.sub(r"[^a-zA-Z0-9\-]", "_", entry.get("docNumber", "UNKNOWN"))
    return f"{entry['dateFound']}_{doc}"

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

def commit_updated_json(updated_data, sha):
    content_bytes = json.dumps(updated_data, indent=2).encode("utf-8")
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

# --- Run validation and commit ---
# new_entries must be built during the daily run as a list of dicts
# Each dict should conform to the schema above

current_data, sha = get_current_json()
existing_ids = {e["id"] for e in current_data}

valid_entries = []
for entry in new_entries:
    # Ensure id is set deterministically
    if not entry.get("id"):
        entry["id"] = make_id(entry)
    errors = validate_entry(entry, existing_ids)
    if errors:
        print(f"SKIPPING entry '{entry.get('title', 'unknown')}' due to validation errors: {errors}")
    else:
        valid_entries.append(entry)
        existing_ids.add(entry["id"])

if valid_entries:
    updated = current_data + valid_entries
    commit_updated_json(updated, sha)
    print(f"Committed {len(valid_entries)} new entries to GitHub.")
else:
    print("No valid new entries to commit today.")
```

---

## Environment Variables

### Netlify Dashboard → Site Settings → Environment Variables

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `UPDATES_JSON_URL` | `https://raw.githubusercontent.com/{username}/federal-register-k12/main/data/updates.json` |

### Cowork Scheduled Task Secrets

| Variable | Value |
|---|---|
| `GITHUB_TOKEN` | GitHub personal access token (repo write scope) |
| `GITHUB_REPO` | `{username}/federal-register-k12` |

---

## Initial Setup Steps (in order)

1. **Create GitHub repo** — name it `federal-register-k12`, set to public
2. **Initialize `data/updates.json`** — commit a file containing the 4 existing entries from the May 9 week, formatted per the schema above. The file must be valid JSON — start with the array containing those 4 entries.
3. **Add all project files** — `index.html`, `netlify/functions/search.js`, `netlify.toml`
4. **Deploy to Netlify** — connect the GitHub repo at netlify.com → "Add new site" → "Import from Git". It deploys automatically.
5. **Set environment variables** in Netlify dashboard
6. **Generate GitHub personal access token** — github.com → Settings → Developer settings → Personal access tokens (classic) → check `repo` scope
7. **Update Cowork scheduled task** — add the validation + commit block above, and set `GITHUB_TOKEN` and `GITHUB_REPO` as task environment secrets

---

## Cost Estimates (monthly, low traffic)

| Item | Cost |
|---|---|
| Netlify hosting | Free |
| GitHub | Free |
| Claude Haiku (search queries, ~500 entries context) | ~$0.002 per query |
| Anthropic API (daily monitor task) | ~$0.05–0.10/day |

Set a $20/month account spending limit in Anthropic Console as a safety ceiling.

---

## Future Enhancements (out of scope for initial build)

- Email subscription for new entries (Resend or Buttondown)
- Week-by-week trend charts (Chart.js, inline in `index.html`)
- Topic filter buttons (Special Education, Grants, Rulemaking, etc.)
- If archive grows beyond ~500 entries, replace keyword filter with server-side TF-IDF or move to a lightweight vector store (sqlite-vss or Cloudflare Vectorize)
