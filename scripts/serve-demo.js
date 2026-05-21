import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { resolveDataRoot } from "../src/config.js";
import { createRepository } from "../src/data/repository.js";

const root = resolve(import.meta.dirname, "..");
const preferredPort = 4173;
const dataRoot = resolveDataRoot({
  argv: process.argv.slice(2),
  env: process.env,
  fallback: join(root, "data"),
});
const repository = createRepository({ dataRoot });

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function resolveRequestPath(url) {
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const requested = pathname === "/" ? "/demo/index.html" : pathname;
  const filePath = normalize(join(root, requested));

  if (!filePath.startsWith(root)) {
    return null;
  }

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    return filePath;
  }

  return null;
}

function createDemoServer(port) {
  const server = createServer(async (request, response) => {
    if (await handleApiRequest(request, response)) return;

    const filePath = resolveRequestPath(request.url);

    if (!filePath) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE" && port < preferredPort + 20) {
      createDemoServer(port + 1);
      return;
    }
    throw error;
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Northstar demo running at http://127.0.0.1:${port}`);
    console.log(`Data directory: ${dataRoot}`);
  });
}

createDemoServer(preferredPort);

async function handleApiRequest(request, response) {
  const url = new URL(request.url, "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;

  try {
    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      sendJson(response, 200, repository.getBootstrap());
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/task-nodes") {
      sendJson(response, 200, { nodes: repository.listTaskNodes() });
      return true;
    }

    if (request.method === "PUT" && url.pathname === "/api/task-nodes") {
      const body = await readJsonBody(request);
      sendJson(response, 200, { nodes: repository.saveTaskNodes(body.nodes) });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/api/library") {
      sendJson(response, 200, { library: repository.getLibrary() });
      return true;
    }

    const markdownMatch = url.pathname.match(/^\/api\/library\/([^/]+)\/([^/]+)\/markdown$/);
    if (request.method === "PUT" && markdownMatch) {
      const [, kind, id] = markdownMatch.map(decodeURIComponent);
      const body = await readJsonBody(request);
      sendJson(response, 200, { item: repository.updateMarkdown(kind, id, body.markdown) });
      return true;
    }

    sendJson(response, 404, { error: "API route not found" });
    return true;
  } catch (error) {
    sendJson(response, error.statusCode ?? 500, { error: error.message });
    return true;
  }
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
  }

  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}
