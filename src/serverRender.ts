import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer, { type Browser } from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));

async function loadView(file: string): Promise<string> {
  return readFile(join(HERE, "views", file), "utf-8");
}

/**
 * One headless Chromium instance for the whole process, launched lazily and
 * reused across every render_chart / render_diagram call. Reusing it means
 * only the first call pays Chromium's startup cost, and the CDN scripts
 * (echarts/cytoscape/dagre) land in its HTTP cache after the first fetch —
 * every render after that only pays for a fresh tab, not a fresh download.
 */
let browserPromise: Promise<Browser> | null = null;

function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
}

function getBrowser(): Promise<Browser> {
  if (!browserPromise) browserPromise = launchBrowser();
  return browserPromise;
}

/** Called once at server startup so the first real tool call isn't the one paying Chromium's launch cost. */
export function warmRenderBrowser(): void {
  void getBrowser().catch((err) => {
    console.error("failed to pre-launch render browser", err);
  });
}

export async function closeRenderBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}

const EXT_APPS_SPECIFIER =
  "https://cdn.jsdelivr.net/npm/@modelcontextprotocol/ext-apps@1/+esm";

function embedArgs(args: unknown): string {
  // Escaping "<" keeps a value containing e.g. "</script>" from prematurely
  // closing the inline <script> tag it's embedded in below.
  return JSON.stringify(args).replace(/</g, "\\u003c");
}

function wrapForRender(viewHtml: string, args: unknown): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<script>window.__RENDER_ARGS__ = ${embedArgs(args)};</script>
<script type="importmap">
${JSON.stringify({ imports: { [EXT_APPS_SPECIFIER]: "/views/direct-bridge.js" } })}
</script>
</head>
<body style="margin:0;">
${viewHtml}
</body>
</html>`;
}

type RenderOptions = {
  viewFile: "chart-view.html" | "graph-view.html";
  args: unknown;
  width: number;
  height: number;
  /** Port the running Express server is bound to, so /views/direct-bridge.js resolves against our own origin instead of about:blank. */
  port: number;
};

/**
 * Renders a view file headlessly with the given arguments and screenshots
 * just its #canvas element — the same rendering code path a real MCP Apps
 * host runs (echarts/cytoscape included), minus the header/toolbar — so the
 * PNG shipped inline with a tool result always matches what a live host
 * would draw. This is what lets headless clients (CLIs, agents with no MCP
 * Apps support) get a usable image instead of only structured data.
 */
export async function renderViewPNG(options: RenderOptions): Promise<Buffer> {
  const { viewFile, args, width, height, port } = options;
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await page.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "reduce" },
      // Force light theme regardless of the headless browser's default —
      // a light background reads far better once pasted into Excel, docs,
      // or a flow-diagram tool than whatever a chat host's dark mode is.
      { name: "prefers-color-scheme", value: "light" },
    ]);
    // Navigate first so the page has our server's origin — the importmap
    // below points at a same-origin relative path, which about:blank (the
    // default for setContent with no prior navigation) can't resolve.
    await page.goto(`http://127.0.0.1:${port}/healthz`, { waitUntil: "load" });
    // The CDN <script> tags in the view are synchronous (no defer/async), so
    // they block parsing until fetched — "load" already implies they're
    // done, same as networkidle0 would for this page.
    await page.setContent(wrapForRender(await loadView(viewFile), args), {
      waitUntil: "load",
      timeout: 15000,
    });
    await page
      .waitForFunction("window.__renderDone === true", { timeout: 10000 })
      .catch(() => {
        // Best-effort: fall through and screenshot whatever's on screen
        // rather than fail the whole tool call over a slow CDN fetch.
      });
    // Layout (dagre/cose) and echarts both finish synchronously once
    // renderDone flips, but leave a small buffer for a pending repaint.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const canvas = await page.$("#canvas");
    const target = canvas ?? page;
    const buffer = await target.screenshot({ type: "png" });
    return buffer as Buffer;
  } finally {
    await page.close();
  }
}
