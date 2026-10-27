import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const FIXTURES = path.join(__dirname, "fixtures");

/** Serves tests/fixtures. __FRAME_ORIGIN__ in a page becomes `frameOrigin` (a second, cross-origin server). */
export async function serveFixtures(frameOrigin = ""): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const file = path.join(FIXTURES, pathname === "/" ? "index.html" : pathname);
    if (!file.startsWith(FIXTURES) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    const body = fs.readFileSync(file, "utf8").replaceAll("__FRAME_ORIGIN__", frameOrigin);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Headless browser + throwaway profile/db for tests. Call before importing app modules. */
export function testEnvironment(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "outreach-test-"));
  process.env.OUTREACH_BROWSER_HEADLESS = "1";
  process.env.OUTREACH_BROWSER_PROFILE = path.join(dir, "profile");
  process.env.OUTREACH_DB_PATH = path.join(dir, "test.db");
  if (!process.env.OUTREACH_BROWSER_PATH && fs.existsSync("/opt/pw-browsers/chromium")) {
    process.env.OUTREACH_BROWSER_PATH = "/opt/pw-browsers/chromium";
  }
  const resume = path.join(dir, "resume.pdf");
  fs.writeFileSync(resume, "%PDF-1.4\n% test resume\n");
  return resume;
}
