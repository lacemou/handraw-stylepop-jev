import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.join(APP_ROOT, "data");
const ASSET_ROOT = path.join(DATA_ROOT, "assets");
const PORT = Number(process.env.PORT || 5175);
const MODEL = "jev-latest";
const CHUNK_SIZE = 60;
const resultCache = new Map();
const pendingRanks = new Map();
const EXTRA_MATCH_THRESHOLD = 0.6;
const PUBLIC_FILES = new Set(["index.html", "app.js", "styles.css"]);

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

function loadStyles() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, "styles.json"), "utf8"));
  } catch {
    throw new Error("Could not read data/styles.json. See the README for the required local data.");
  }

  const styles = data?.styles;
  if (!Array.isArray(styles) || styles.length !== 261) {
    throw new Error("data/styles.json must contain a styles array with exactly 261 entries.");
  }
  return styles;
}

const styles = loadStyles();

function positiveTraits(traits = "") {
  return String(traits)
    .split(/[；;]/)
    .map((part) => part.trim())
    .filter((part) => part && !/(避免|不要|不准|禁止)/.test(part))
    .join("；");
}

function compactStyle(style) {
  return {
    id: style.id,
    name: style.name,
    author: style.author || "",
    group: style.group,
    traits: positiveTraits(style.traits),
  };
}

const compactStyles = styles.map(compactStyle);
const browserStyles = styles.map((style) => ({
  id: style.id,
  name: style.name,
  author: style.author || "",
  group: style.group || "",
  traits: style.traits || "",
  avatar_url: style.avatar_url,
  preview_url: style.preview_url,
}));

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendJavaScript(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function safePath(root, relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;

  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(resolved);
    const relative = path.relative(realRoot, realFile);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      ? realFile
      : null;
  } catch {
    return null;
  }
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function chooseDiverse(ranked, count = 5) {
  const selected = ranked.slice(0, count);
  const bestScore = ranked[0]?.score || 0;
  // Start with the score order. Diversity may replace only the weakest result
  // when the alternative is close enough, then the final list is re-sorted.
  const scoreFloor = Math.max(EXTRA_MATCH_THRESHOLD, bestScore - 0.15);
  const diversitySlack = 0.05;

  for (const candidate of ranked.slice(count)) {
    if (candidate.score < scoreFloor) break;
    if (selected.some((item) => item.group === candidate.group)) continue;

    const weakestIndex = selected.reduce(
      (index, item, itemIndex) => item.score < selected[index].score ? itemIndex : index,
      0,
    );
    if (candidate.score + diversitySlack >= selected[weakestIndex].score) {
      selected[weakestIndex] = candidate;
    }
  }

  return selected
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((item, index) => ({ ...item, rank: index + 1 }));
}

async function rankChunk(query, chunk) {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    const error = new Error("TYPESAFE_API_KEY is not available to the local server");
    error.code = "MISSING_API_KEY";
    throw error;
  }

  const state = {
    request: query,
    styles: chunk,
  };

  const questions = Object.fromEntries(
    chunk.map((style, index) => [
      `style_${style.id}`,
      {
        type: "noul",
        instructions:
          `Is style \`styles[${index}]\` a strong visual match for the user's theme? ` +
          "Judge whether the style's visual language can express the requested subject, action, setting, and emotional tone. " +
          "Use the style name, author, group, and positive visual traits as evidence, but do not match on shared words alone. " +
          "Treat the user's theme as the target and the style profile as the candidate; do not judge personal-avatar fit.",
        criteria: {
          true: "The style has a clear visual affordance for depicting the theme and is a strong, practical match.",
          false: "The style is not a strong match for the theme, or the theme gives no convincing evidence of fit.",
        },
      },
    ]),
  );

  const apiResponse = await fetch("https://api.typesafe.ai/v1/systemone", {
    signal: AbortSignal.timeout(20000),
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, state, questions }),
  });

  const payload = await apiResponse.json().catch(() => ({}));
  if (!apiResponse.ok) {
    const error = new Error(`TypeSafe API request failed with status ${apiResponse.status}`);
    error.code = `TYPESAFE_${apiResponse.status}`;
    throw error;
  }

  return {
    model: payload.model || MODEL,
    usage: payload.usage || {},
    scores: chunk
    .map((style) => ({
      score: Number(payload.answers?.[`style_${style.id}`]?.noul || 0),
      id: style.id,
    }))
  };
}

async function rankWithJev(query) {
  const chunks = [];
  for (let index = 0; index < compactStyles.length; index += CHUNK_SIZE) {
    chunks.push(compactStyles.slice(index, index + CHUNK_SIZE));
  }

  const chunkResults = await Promise.all(chunks.map((chunk) => rankChunk(query, chunk)));
  const scores = new Map(chunkResults.flatMap((chunk) => chunk.scores.map((item) => [item.id, item.score])));
  const ranked = compactStyles
    .map((style) => ({ ...style, score: scores.get(style.id) || 0 }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const usage = chunkResults.reduce(
    (total, chunk) => ({
      input_tokens: total.input_tokens + Number(chunk.usage.input_tokens || 0),
      output_tokens: total.output_tokens + Number(chunk.usage.output_tokens || 0),
    }),
    { input_tokens: 0, output_tokens: 0 },
  );

  return {
    source: "jev",
    model: chunkResults[0]?.model || MODEL,
    batches: chunks.length,
    usage,
    query,
    results: chooseDiverse(ranked, Math.min(8, Math.max(5, ranked.filter(item => item.score >= EXTRA_MATCH_THRESHOLD).length))),
  };
}

async function handleRank(request, response) {
  try {
    const body = await readJsonBody(request);
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (query.length < 1) {
      return sendJson(response, 400, { error: "请输入主题。" });
    }
    if (query.length > 600) {
      return sendJson(response, 400, { error: "需求过长，请压缩成 600 字以内。" });
    }
    if (resultCache.has(query)) return sendJson(response, 200, resultCache.get(query));
    if (!pendingRanks.has(query)) {
      const job = rankWithJev(query).then(result => {
        if (resultCache.size >= 50) resultCache.delete(resultCache.keys().next().value);
        resultCache.set(query, result);
        return result;
      }).finally(() => pendingRanks.delete(query));
      pendingRanks.set(query, job);
    }
    return sendJson(response, 200, await pendingRanks.get(query));
  } catch (error) {
    const status = error.code === "MISSING_API_KEY" ? 503 : 502;
    const message = error.code === "MISSING_API_KEY"
      ? "TYPESAFE_API_KEY is not set in the server environment."
      : error.code?.startsWith("TYPESAFE_")
        ? `TypeSafe API request failed (${error.code.slice("TYPESAFE_".length)}).`
        : "Could not complete style ranking. Check the local server and TypeSafe API connection.";
    return sendJson(response, status, {
      error: message,
      code: error.code || "RANK_FAILED",
    });
  }
}

function serveStatic(request, response, pathname) {
  let root;
  let relativePath;

  if (pathname.startsWith("/assets/")) {
    root = ASSET_ROOT;
    relativePath = pathname.slice("/assets/".length);
  } else {
    relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!PUBLIC_FILES.has(relativePath)) return sendText(response, 404, "Not found");
    root = APP_ROOT;
  }

  const filePath = safePath(root, relativePath);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendText(response, 404, "Not found");
  }

  const extension = path.extname(filePath).toLowerCase();
  const body = fs.readFileSync(filePath);
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPES[extension] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "Content-Length": body.length,
  });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/styles-data.js") {
    const json = JSON.stringify({ styles: browserStyles }).replace(/</g, "\\u003c");
    return sendJavaScript(response, 200, `window.STYLES_DATA = ${json};`);
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, {
      ok: true,
      styles: styles.length,
      model: MODEL,
      keyConfigured: Boolean(process.env.TYPESAFE_API_KEY),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/rank") {
    return handleRank(request, response);
  }

  if (request.method === "GET") return serveStatic(request, response, url.pathname);
  return sendText(response, 405, "Method not allowed");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`261 JEV Reverse Style Field listening at http://127.0.0.1:${PORT}`);
  console.log(`Loaded ${styles.length} styles from local JSON data.`);
  console.log(`TYPESAFE_API_KEY configured: ${Boolean(process.env.TYPESAFE_API_KEY)}`);
});
