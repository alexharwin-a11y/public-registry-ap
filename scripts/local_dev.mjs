import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import configHandler from "../netlify/functions/config.mjs";
import searchHandler from "../netlify/functions/search.mjs";

const root = resolve(".");
const port = Number(process.env.PORT || 8888);
const host = process.env.HOST || "127.0.0.1";

await loadDotEnv();

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || `localhost:${port}`}`);

    if (requestUrl.pathname === "/api/search") {
      await handleFunction(req, res, requestUrl, searchHandler);
      return;
    }

    if (requestUrl.pathname === "/api/config") {
      await handleFunction(req, res, requestUrl, configHandler);
      return;
    }

    await serveStatic(res, requestUrl.pathname);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(error.stack || error.message);
  }
});

server.listen(port, host, () => {
  console.log(`Local app running at http://${host}:${port}`);
});

async function handleFunction(req, res, requestUrl, handler) {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readRequestBody(req);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }

  const request = new Request(requestUrl, {
    method: req.method,
    headers,
    body
  });

  const response = await handler(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));

  if (!response.body) {
    res.end();
    return;
  }

  Readable.fromWeb(response.body).pipe(res);
}

async function serveStatic(res, pathname) {
  const cleanPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(join(root, normalize(decodeURIComponent(cleanPath))));

  if (!filePath.startsWith(root)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  try {
    await access(filePath);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  res.writeHead(200, { "content-type": contentType(filePath) });
  createReadStream(filePath).pipe(res);
}

function readRequestBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", rejectBody);
  });
}

async function loadDotEnv() {
  let text;
  try {
    text = await readFile(".env", "utf8");
  } catch {
    return;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

function contentType(filePath) {
  const types = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8"
  };

  return types[extname(filePath).toLowerCase()] || "application/octet-stream";
}
