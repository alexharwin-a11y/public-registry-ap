const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;
const MAX_QUERY_LENGTH = 500;
const MAX_ENTRIES_IN_CONTEXT = 200;
const MAX_CONTEXT_CHARS = 120_000;
const ARCHIVE_CACHE_MS = 5 * 60 * 1000;
const DEFAULT_MODEL = "claude-3-5-haiku-20241022";

const rateLimitMap = new Map();
let archiveCache = { url: "", fetchedAt: 0, entries: null };

const STOP_WORDS = new Set([
  "about", "after", "again", "against", "all", "also", "and", "any", "are",
  "before", "between", "but", "can", "did", "does", "for", "from", "has",
  "have", "how", "into", "not", "notices", "of", "on", "or", "please",
  "rule", "rules", "show", "tell", "that", "the", "there", "these", "this",
  "to", "upcoming", "was", "were", "what", "when", "which", "with"
]);

const SYNONYMS = {
  "special needs": ["special education", "idea", "disability"],
  "dept of ed": ["department of education", "education department"],
  "doe": ["department of education"],
  "dol": ["department of labor"],
  "nprm": ["notice of proposed rulemaking", "proposed rule", "nprm"],
  "deadline": ["deadline", "comment", "application"],
  "deadlines": ["deadline", "comment", "application"]
};

export default async function handler(request) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const rateLimitError = checkRateLimit(request);
  if (rateLimitError) return rateLimitError;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const query = typeof payload.query === "string" ? payload.query.trim() : "";
  if (!query) return jsonResponse({ error: "Missing query" }, 400);
  if (query.length > MAX_QUERY_LENGTH) {
    return jsonResponse({ error: `Query must be ${MAX_QUERY_LENGTH} characters or fewer` }, 400);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return jsonResponse({ error: "ANTHROPIC_API_KEY is not configured" }, 500);
  }

  let allEntries;
  try {
    allEntries = await fetchArchive(request);
  } catch (error) {
    return jsonResponse({ error: "Could not load update archive", detail: error.message }, 502);
  }

  const matches = retrieveEntries(query, allEntries);
  const contextText = buildContext(matches);
  const systemPrompt = [
    "You are a K-12 education policy assistant for a Federal Register monitoring service.",
    "Answer based only on the logged Federal Register entries provided.",
    "Be specific. Cite document titles and dates.",
    "Flag upcoming comment, application, and effective-date deadlines when present.",
    "If the provided entries do not contain enough information to answer fully, say so clearly.",
    "Do not use outside knowledge."
  ].join(" ");

  const userMessage = [
    `Relevant logged Federal Register entries: ${matches.length} of ${allEntries.length} total.`,
    "",
    contextText || "No matching entries were available.",
    "",
    "---",
    "",
    `User question: ${query}`
  ].join("\n");

  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      stream: true
    })
  });

  if (!anthropicRes.ok || !anthropicRes.body) {
    const detail = await anthropicRes.text().catch(() => "");
    return jsonResponse({ error: "Claude request failed", detail }, 502);
  }

  return new Response(anthropicRes.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no"
    }
  });
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function checkRateLimit(request) {
  const forwarded = request.headers.get("x-forwarded-for") || "";
  const ip =
    request.headers.get("x-nf-client-connection-ip") ||
    forwarded.split(",")[0].trim() ||
    "unknown";
  const now = Date.now();
  const record = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }

  record.count += 1;
  rateLimitMap.set(ip, record);

  if (record.count <= RATE_LIMIT_MAX) return null;

  return jsonResponse({ error: "Too many requests. Please wait a moment." }, 429);
}

async function fetchArchive(request) {
  const archiveUrl = process.env.UPDATES_JSON_URL || new URL("/data/updates.json", request.url).toString();
  const now = Date.now();
  if (
    archiveCache.entries &&
    archiveCache.url === archiveUrl &&
    now - archiveCache.fetchedAt < ARCHIVE_CACHE_MS
  ) {
    return archiveCache.entries;
  }

  const response = await fetch(archiveUrl, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Archive fetch returned ${response.status}`);
  }

  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Archive JSON must be an array");
  }

  archiveCache = { url: archiveUrl, fetchedAt: now, entries: data };
  return data;
}

function retrieveEntries(query, entries) {
  const queryLower = query.toLowerCase();
  const terms = getSearchTerms(queryLower);
  const wantsDeadlines = /\b(deadline|deadlines|due|comment|application|effective)\b/.test(queryLower);

  const scored = entries.map((entry) => ({
    entry,
    score: scoreEntry(entry, queryLower, terms, wantsDeadlines)
  }));

  let matches = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || compareDateDesc(a.entry.dateFound, b.entry.dateFound))
    .map((item) => item.entry);

  if (matches.length === 0) {
    matches = [...entries].sort((a, b) => compareDateDesc(a.dateFound, b.dateFound));
  }

  return matches.slice(0, MAX_ENTRIES_IN_CONTEXT);
}

function getSearchTerms(queryLower) {
  const terms = new Set();
  const words = queryLower
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));

  for (const word of words) terms.add(word);

  for (const [alias, expansions] of Object.entries(SYNONYMS)) {
    if (queryLower.includes(alias)) {
      for (const expansion of expansions) {
        terms.add(expansion);
        for (const piece of expansion.split(/\s+/)) {
          if (piece.length >= 3 && !STOP_WORDS.has(piece)) terms.add(piece);
        }
      }
    }
  }

  return [...terms];
}

function scoreEntry(entry, queryLower, terms, wantsDeadlines) {
  const weightedFields = [
    ["title", 8],
    ["agency", 5],
    ["docNumber", 5],
    ["documentType", 5],
    ["categoryType", 4],
    ["regulatoryStage", 4],
    ["k12Relevance", 3],
    ["summary", 2],
    ["context", 1],
    ["weekOf", 1]
  ];

  let score = 0;
  for (const [field, weight] of weightedFields) {
    const value = String(entry[field] || "").toLowerCase();
    if (!value) continue;
    if (value.includes(queryLower)) score += weight * 4;
    for (const term of terms) {
      if (value.includes(term)) score += weight;
    }
  }

  if (wantsDeadlines && hasUpcomingOrOpenDeadline(entry)) score += 8;
  return score;
}

function hasUpcomingOrOpenDeadline(entry) {
  const joined = [
    entry.commentDeadline,
    entry.effectiveDate,
    entry.regulatoryStage,
    entry.categoryType
  ].join(" ").toLowerCase();

  return !/\bn\/a\b/.test(joined) && /\b(tbd|deadline|comment|application|effective|open)\b/.test(joined);
}

function compareDateDesc(a, b) {
  return String(b || "").localeCompare(String(a || ""));
}

function buildContext(entries) {
  let totalChars = 0;
  const blocks = [];

  for (const entry of entries) {
    const block = [
      "---",
      `ID: ${entry.id || ""}`,
      `Date: ${entry.dateFound || ""} (Week of ${entry.weekOf || ""})`,
      `Title: ${entry.title || ""}`,
      `Agency: ${entry.agency || ""}`,
      `Type: ${entry.documentType || ""} - ${entry.categoryType || ""}`,
      `Regulatory Stage: ${entry.regulatoryStage || ""}`,
      `Comment/Application Deadline: ${entry.commentDeadline || ""}`,
      `Effective Date: ${entry.effectiveDate || ""}`,
      `K-12 Relevance: ${entry.k12Relevance || ""}`,
      `Summary: ${entry.summary || ""}`,
      `Context: ${entry.context || ""}`,
      `Link: ${entry.federalRegisterLink || ""}`
    ].join("\n");

    if (totalChars + block.length > MAX_CONTEXT_CHARS) break;
    blocks.push(block);
    totalChars += block.length;
  }

  return blocks.join("\n\n");
}
