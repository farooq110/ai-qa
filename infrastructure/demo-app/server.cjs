const http = require("node:http");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const port = Number(process.env.DEMO_APP_PORT ?? 4600);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);
  const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\//, "").replace(/\.\./g, "");
  let body;
  try {
    body = await readFile(path.join(__dirname, file));
  } catch {
    // SPA fallback: extensionless paths render the app shell
    body = await readFile(path.join(__dirname, "index.html"));
  }
  const hasExtension = path.extname(file) !== "";
  const contentType = hasExtension
    ? (contentTypes[path.extname(file)] ?? "application/octet-stream")
    : "text/html; charset=utf-8";
  response.writeHead(200, { "Content-Type": contentType });
  response.end(body);
}).listen(port, () => console.info(`demo target app listening on http://localhost:${port}`));
