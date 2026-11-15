// Run with `node tests/run.cjs`. CHROME_PATH can override the Chrome executable.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const files = new Set(["/tests/cancel.html", "/tests/cancel.test.js", "/cancel.js", "/reminder.js"]);
const server = http.createServer((req, res) => {
  if (!files.has(req.url)) { res.writeHead(404).end(); return; }
  res.setHeader("Content-Type", req.url.endsWith(".html") ? "text/html" : "text/javascript");
  res.end(fs.readFileSync(path.join(root, req.url)));
});
server.listen(0, "127.0.0.1", () => {
  const tempRoot = process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir();
  fs.mkdirSync(tempRoot, { recursive: true });
  const profile = fs.mkdtempSync(path.join(tempRoot, "sns-cancel-tests-"));
  const chrome = process.env.CHROME_PATH || (process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "google-chrome");
  execFile(chrome, ["--headless=new", "--disable-gpu", "--no-first-run",
    `--user-data-dir=${profile}`, "--virtual-time-budget=10000", "--dump-dom",
    `http://127.0.0.1:${server.address().port}/tests/cancel.html`,
  ], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
    server.close();
    const result = stdout.match(/<pre id="results">([\s\S]*?)<\/pre>/)?.[1];
    console.log(result || stderr || String(error));
    process.exitCode = !error && stdout.includes('data-result="passed"') ? 0 : 1;
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  });
});
