import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const outputDirectory = resolve(process.cwd(), "out");
const port = Number.parseInt(process.env.PORT || "3000", 10);
const host = process.env.HOST || "127.0.0.1";

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
};

async function resolveRequestFile(pathname) {
  const decoded = decodeURIComponent(pathname);
  const requested = resolve(outputDirectory, `.${decoded}`);
  if (requested !== outputDirectory && !requested.startsWith(`${outputDirectory}${sep}`)) return null;

  try {
    const metadata = await stat(requested);
    if (metadata.isDirectory()) return resolve(requested, "index.html");
    return requested;
  } catch {
    if (!extname(requested)) {
      const nestedIndex = resolve(requested, "index.html");
      try {
        await stat(nestedIndex);
        return nestedIndex;
      } catch {
        return null;
      }
    }
    return null;
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    const filePath = await resolveRequestFile(url.pathname);
    if (!filePath) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(filePath)] || "application/octet-stream",
      "Content-Length": body.length,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(body);
  } catch {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Static preview error");
  }
});

server.listen(port, host, () => {
  console.log(`Static portfolio preview available at http://${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
