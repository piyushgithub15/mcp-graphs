import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import express from "express";
import { z } from "zod";

import { renderViewPNG, warmRenderBrowser } from "./serverRender.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PORT = Number(process.env.PORT ?? 3000);

export const CHART_VIEW_URI = "ui://viz/chart-view.html";
export const GRAPH_VIEW_URI = "ui://viz/graph-view.html";

/**
 * Domains the sandboxed iframe is allowed to pull scripts from.
 * The host turns this into a Content-Security-Policy. Anything not listed
 * here fails silently inside the iframe, so keep it in sync with the
 * <script src> tags in the view templates.
 */
const RESOURCE_DOMAINS = ["https://cdn.jsdelivr.net"];

const point = z.object({
  x: z.union([z.number(), z.string()]),
  y: z.number(),
});

const chartSpec = z.object({
  kind: z.enum(["line", "bar", "scatter", "area"]),
  title: z.string(),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
  series: z
    .array(
      z.object({
        name: z.string(),
        points: z.array(point),
      }),
    )
    .min(1),
});

const chartInput = {
  charts: z
    .array(chartSpec)
    .min(1)
    .max(6)
    .describe(
      "One entry per chart. Emit 2+ entries to render several charts " +
        "together as a single grid image in one call (e.g. revenue and " +
        "profit side by side) instead of calling render_chart repeatedly.",
    ),
};

const diagramInput = {
  kind: z.enum(["flowchart", "graph"]),
  title: z.string(),
  direction: z.enum(["TB", "LR"]).default("TB"),
  nodes: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        group: z.string().optional(),
      }),
    )
    .min(1),
  edges: z
    .array(
      z.object({
        source: z.string(),
        target: z.string(),
        label: z.string().optional(),
      }),
    )
    .default([]),
};

type ProgressSender = {
  sendNotification: (n: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
  _meta?: { progressToken?: string | number };
};

/**
 * Emits a progress notification if the caller supplied a progressToken.
 * Without a token the spec forbids sending one, so this is a no-op.
 */
async function reportProgress(
  extra: ProgressSender,
  progress: number,
  total: number,
  message: string,
) {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  await extra.sendNotification({
    method: "notifications/progress",
    params: { progressToken, progress, total, message },
  });
}

async function loadView(file: string): Promise<string> {
  return readFile(join(HERE, "views", file), "utf-8");
}

/**
 * Sizes the render viewport for N charts. A single chart keeps the original
 * full-width responsive layout; 2+ charts lay out as a fixed-cell grid (see
 * chart-view.html), so the size here must match that grid's own math or the
 * screenshot clips or leaves dead space.
 *
 * The single-chart viewport is wide enough (and the mount tall enough, see
 * `#canvas.single .chart-cell-mount`) that the exported PNG lands around
 * 1640x800 at deviceScaleFactor 2 — a chart that stays legible pasted into a
 * doc or slide, rather than a 640px thumbnail that has to be upscaled.
 */
function chartCanvasSize(count: number): { width: number; height: number } {
  if (count <= 1) return { width: 820, height: 470 };
  const cols = count <= 4 ? 2 : 3;
  const rows = Math.ceil(count / cols);
  const cellWidth = 480;
  const cellHeight = 300;
  const gap = 16;
  const gridWidth = cols * cellWidth + (cols - 1) * gap;
  const gridHeight = rows * cellHeight + (rows - 1) * gap;
  return { width: gridWidth + 40, height: gridHeight + 100 };
}

type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Headlessly renders the view with these exact arguments and appends it as
 * an inline image content block. This is what makes the chart/diagram a
 * real, portable PNG — pasteable into Excel, a flow-diagram tool, or any
 * other document — for every caller, not just hosts that load the
 * interactive ui:// resource. Best-effort: a render failure logs and falls
 * back to text + structuredContent only, rather than failing the tool call.
 */
async function appendRenderedImage(
  content: ToolResultContent[],
  viewFile: "chart-view.html" | "graph-view.html",
  args: unknown,
  width: number,
  height: number,
): Promise<void> {
  try {
    const png = await renderViewPNG({ viewFile, args, width, height, port: PORT });
    content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
  } catch (err) {
    console.error(`failed to render ${viewFile} to PNG`, err);
  }
}

/**
 * Holds the arguments from the most recent successful render_chart /
 * render_diagram call and fans them out to any /preview/stream listeners.
 * This is plain module state in the long-running Node process — it survives
 * across /mcp requests even though each POST gets its own stateless
 * McpServer/transport pair.
 */
type PreviewKind = "chart" | "graph";
const latestByKind: Partial<Record<PreviewKind, unknown>> = {};
const liveUpdates = new EventEmitter().setMaxListeners(0);

function publishPreview(kind: PreviewKind, args: unknown) {
  latestByKind[kind] = args;
  liveUpdates.emit(kind, args);
}

/**
 * Wraps a view's HTML fragment in a real document and remaps the ext-apps
 * CDN import to /views/live-bridge.js via an import map. The view file
 * itself is served byte-for-byte unmodified — only its module import target
 * changes, so this exercises the exact same rendering code a real MCP host
 * would load. live-bridge.js listens on /preview/stream for real tool-call
 * data instead of simulating any.
 */
function wrapPreview(viewHtml: string, kind: PreviewKind): string {
  const EXT_APPS_SPECIFIER =
    "https://cdn.jsdelivr.net/npm/@modelcontextprotocol/ext-apps@1/+esm";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${kind === "chart" ? "Chart" : "Graph"} preview</title>
<script type="importmap">
${JSON.stringify({ imports: { [EXT_APPS_SPECIFIER]: `/views/live-bridge.js?kind=${kind}` } })}
</script>
</head>
<body style="margin:16px;">
${viewHtml}
</body>
</html>`;
}

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "viz", version: "1.0.0" },
    { capabilities: { resources: {}, tools: {}, logging: {} } },
  );

  registerAppResource(
    server,
    "Chart view",
    CHART_VIEW_URI,
    { description: "Renders a chart that draws itself as data arrives" },
    async () => ({
      contents: [
        {
          uri: CHART_VIEW_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await loadView("chart-view.html"),
          _meta: { ui: { csp: { resourceDomains: RESOURCE_DOMAINS } } },
        },
      ],
    }),
  );

  registerAppResource(
    server,
    "Graph view",
    GRAPH_VIEW_URI,
    { description: "Renders a node-link diagram that reveals as it builds" },
    async () => ({
      contents: [
        {
          uri: GRAPH_VIEW_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await loadView("graph-view.html"),
          _meta: { ui: { csp: { resourceDomains: RESOURCE_DOMAINS } } },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "render_chart",
    {
      title: "Render chart",
      description:
        "Draw one or more line, bar, scatter, or area charts. Emit each " +
        "chart's series array in order; the view plots each point as it " +
        "streams in, so earlier points appear before the argument list is " +
        "complete. Pass 2+ entries in `charts` to render several charts " +
        "together as one grid image instead of calling this tool repeatedly.",
      inputSchema: chartInput,
      _meta: { ui: { resourceUri: CHART_VIEW_URI } },
    },
    async (args, extra) => {
      const totals = args.charts.map((c) =>
        c.series.reduce((n, s) => n + s.points.length, 0),
      );
      const total = totals.reduce((a, b) => a + b, 0);
      await reportProgress(extra as ProgressSender, total, total, "Chart ready");
      publishPreview("chart", args);

      const summary =
        args.charts.length === 1
          ? `Rendered ${args.charts[0].kind} chart "${args.charts[0].title}" with ${args.charts[0].series.length} series and ${total} points.`
          : `Rendered ${args.charts.length} charts (${args.charts
              .map((c) => `"${c.title}"`)
              .join(", ")}) with ${total} total points.`;

      const content: ToolResultContent[] = [
        // Small payload for the model — the view gets the full dataset via
        // structuredContent, which never enters the model's context.
        { type: "text", text: summary },
      ];
      const { width, height } = chartCanvasSize(args.charts.length);
      await appendRenderedImage(content, "chart-view.html", args, width, height);

      return { content, structuredContent: args };
    },
  );

  registerAppTool(
    server,
    "render_diagram",
    {
      title: "Render diagram",
      description:
        "Draw a flowchart or node-link graph. Emit every node before any " +
        "edge. The view solves layout once against the complete node set, " +
        "then reveals nodes in order, so nothing reflows mid-render.",
      inputSchema: diagramInput,
      _meta: { ui: { resourceUri: GRAPH_VIEW_URI } },
    },
    async (args, extra) => {
      const dangling = args.edges.filter(
        (e) =>
          !args.nodes.some((n) => n.id === e.source) ||
          !args.nodes.some((n) => n.id === e.target),
      );

      if (dangling.length > 0) {
        const ids = dangling
          .map((e) => `${e.source}->${e.target}`)
          .join(", ");
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `These edges reference nodes that were not declared: ${ids}. Add the missing nodes and call render_diagram again.`,
            },
          ],
        };
      }

      await reportProgress(
        extra as ProgressSender,
        args.nodes.length,
        args.nodes.length,
        "Layout solved",
      );
      publishPreview("graph", args);

      const content: ToolResultContent[] = [
        {
          type: "text",
          text: `Rendered ${args.kind} "${args.title}" with ${args.nodes.length} nodes and ${args.edges.length} edges.`,
        },
      ];
      await appendRenderedImage(content, "graph-view.html", args, 720, 460);

      return { content, structuredContent: args };
    },
  );

  return server;
}

/**
 * Streamable HTTP entrypoint. One transport per request, no session state —
 * this matches the stateless model the 2026-07-28 revision moves to, and it
 * survives being deployed behind a load balancer without sticky routing.
 */
export function createApp() {
  const app = express();
  app.use(express.json({ limit: "4mb" }));

  app.post("/mcp", async (req, res) => {
    // Temporary diagnostic logging: shows exactly which JSON-RPC methods a
    // connected client actually sends, so we can tell whether it ever asks
    // for the ui:// resources (i.e. whether it implements MCP Apps at all).
    const bodies = Array.isArray(req.body) ? req.body : [req.body];
    for (const b of bodies) {
      if (!b || typeof b !== "object") continue;
      if (b.method === "initialize") {
        console.log(
          "[mcp] initialize, client capabilities:",
          JSON.stringify(b.params?.capabilities),
        );
      } else if (b.method === "tools/call") {
        console.log("[mcp] tools/call:", b.params?.name);
      } else if (b.method === "resources/read") {
        console.log("[mcp] resources/read:", b.params?.uri);
      } else if (b.method) {
        console.log("[mcp] method:", b.method);
      }
    }

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: false,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
      console.error("mcp request failed", err);
    }
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Browser-viewable previews, driven by real tool-call data pushed over
  // Server-Sent Events instead of a real MCP host. Not part of the MCP
  // protocol surface — this is a substitute for a client that doesn't
  // implement the MCP Apps extension (e.g. Goose CLI, which never fetches
  // ui:// resources at all).
  app.get("/views/live-bridge.js", async (_req, res) => {
    res.type("application/javascript").send(await loadView("live-bridge.js"));
  });

  // Served for the headless renders in serverRender.ts — see direct-bridge.js.
  app.get("/views/direct-bridge.js", async (_req, res) => {
    res.type("application/javascript").send(await loadView("direct-bridge.js"));
  });

  app.get("/preview/stream", (req, res) => {
    const kind: PreviewKind = req.query.kind === "graph" ? "graph" : "chart";

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();

    const send = (args: unknown) => res.write(`data: ${JSON.stringify(args)}\n\n`);
    if (latestByKind[kind] !== undefined) send(latestByKind[kind]);

    const onUpdate = (args: unknown) => send(args);
    liveUpdates.on(kind, onUpdate);

    // Keep intermediaries (proxies, load balancers) from closing an idle
    // SSE connection.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);

    req.on("close", () => {
      liveUpdates.off(kind, onUpdate);
      clearInterval(heartbeat);
    });
  });

  // Each view needs the ext-apps import remapped to a different
  // live-bridge.js query param, which an import map can't express for two
  // inline modules in one document. So each view still gets its own
  // document, and /preview lays both out on one page — side by side on wide
  // screens, stacked on narrow ones — instead of switching between tabs.
  app.get("/preview/chart", async (_req, res) => {
    res.type("html").send(wrapPreview(await loadView("chart-view.html"), "chart"));
  });

  app.get("/preview/graph", async (_req, res) => {
    res.type("html").send(wrapPreview(await loadView("graph-view.html"), "graph"));
  });

  app.get("/preview", (_req, res) => {
    res.type("html").send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>viz-mcp preview</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, sans-serif;
    background: #f6f5f2;
    color: #1d1d1b;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #17171a; color: #e8e6e1; }
  }
  header {
    padding: 14px 18px 10px;
    border-bottom: 1px solid rgba(128,128,128,0.25);
  }
  header h1 { margin: 0; font-size: 15px; font-weight: 600; }
  header p { margin: 4px 0 0; font-size: 12px; opacity: 0.6; }
  /* Two independent panes laid out with grid, never stacked on top of each
     other: side by side once there's room, one full-width column below
     that. Each pane has its own scroll/frame area, so nothing bleeds
     into its neighbor even while both are live-updating at once. */
  #panes {
    display: grid;
    grid-template-columns: 1fr;
    gap: 16px;
    padding: 16px;
    box-sizing: border-box;
  }
  @media (min-width: 900px) {
    #panes { grid-template-columns: 1fr 1fr; }
  }
  .pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    border: 1px solid rgba(128,128,128,0.25);
    border-radius: 10px;
    overflow: hidden;
    background: rgba(128,128,128,0.04);
  }
  .pane h2 {
    margin: 0;
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    opacity: 0.6;
    border-bottom: 1px solid rgba(128,128,128,0.2);
  }
  .pane iframe {
    display: block;
    width: 100%;
    height: 480px;
    border: none;
    /* flex-basis:auto (not the flex:1 shorthand's 0%) so the 480px height
       above is actually honored instead of collapsing to the browser's
       default 150px iframe height. */
    flex: 0 1 auto;
  }
</style>
</head>
<body>
<header>
  <h1>viz-mcp preview</h1>
  <p>Live output from real render_chart / render_diagram tool calls — both shown at once, no tab switching.</p>
</header>
<div id="panes">
  <div class="pane">
    <h2>Chart</h2>
    <iframe src="/preview/chart" allow="clipboard-write"></iframe>
  </div>
  <div class="pane">
    <h2>Graph</h2>
    <iframe src="/preview/graph" allow="clipboard-write"></iframe>
  </div>
</div>
</body>
</html>`);
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  warmRenderBrowser();
  createApp().listen(PORT, () => {
    console.log(`viz mcp listening on http://localhost:${PORT}/mcp`);
  });
}
