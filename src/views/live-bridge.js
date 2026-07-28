/**
 * Stand-in for @modelcontextprotocol/ext-apps in the browser, used only by
 * the /preview/* routes. Swapped in via an import map so the real
 * chart-view.html / graph-view.html run completely unmodified.
 *
 * Unlike a demo/mock, this pulls real data: it opens a Server-Sent Events
 * connection to /preview/stream, which the server feeds from the actual
 * render_chart / render_diagram tool calls it receives over MCP. So calling
 * the tool from any connected client (including ones like Goose CLI that
 * don't implement MCP Apps and would otherwise show nothing but text)
 * updates this page live.
 */

const params = new URL(import.meta.url).searchParams;
const kind = params.get("kind") === "graph" ? "graph" : "chart";

// The preview page gives every chart its own pane rather than packing a
// multi-chart call into one scrolling frame, so a pane asks for a single
// index out of the render_chart payload. The view itself is untouched — it
// just receives a one-chart argument set and lays it out full size.
const indexParam = params.get("index");
const chartIndex =
  indexParam === null || indexParam === "" ? null : Number.parseInt(indexParam, 10);

function addStatusBadge() {
  const badge = document.createElement("div");
  badge.textContent = "Waiting for a real tool call\u2026";
  Object.assign(badge.style, {
    position: "fixed",
    top: "12px",
    left: "50%",
    transform: "translateX(-50%)",
    padding: "5px 14px",
    borderRadius: "999px",
    background: "#7F77DD",
    color: "#fff",
    font: "12px ui-sans-serif, system-ui, sans-serif",
    boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
    zIndex: 9999,
    transition: "opacity 0.3s ease",
    pointerEvents: "none",
  });
  const mount = () => document.body.appendChild(badge);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
  return badge;
}

export class App {
  constructor(_info, _capabilities) {}

  async connect() {
    const badge = addStatusBadge();

    const apply = (args) => {
      badge.style.opacity = "0";
      this.ontoolinput?.({ arguments: args });
      this.ontoolresult?.({ structuredContent: args });
    };

    // Inside the preview page, data arrives over postMessage rather than a
    // stream of our own. Browsers cap concurrent connections per origin at
    // around six, so one EventSource per pane runs out of sockets the moment
    // a call renders five or six charts \u2014 and the last pane hangs on
    // "Waiting for data" forever, with nothing in the console to show for it.
    // The parent holds one stream per kind and fans payloads out instead.
    if (window.parent && window.parent !== window) {
      window.addEventListener("message", (event) => {
        if (event.origin !== location.origin || event.source !== window.parent) return;
        const msg = event.data;
        if (msg && msg.type === "viz-data") apply(msg.payload);
      });
      // Announce which pane this is; the parent replies with our slice. Sent
      // after the listener is attached so the reply can't be missed, and it
      // covers a frame that finishes loading long after the data arrived.
      window.parent.postMessage(
        { type: "viz-ready", kind, index: chartIndex },
        location.origin,
      );
      return;
    }

    // Opened directly rather than embedded \u2014 keep the standalone page working.
    const source = new EventSource(`/preview/stream?kind=${kind}`);
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        // The graph stream carries every diagram rendered so far. Standalone,
        // show the one this URL asked for, or the most recent.
        if (payload && Array.isArray(payload.diagrams)) {
          const list = payload.diagrams;
          const pick =
            chartIndex !== null && !Number.isNaN(chartIndex)
              ? list[chartIndex]
              : list[list.length - 1];
          if (pick) apply(pick);
          return;
        }
        apply(payload);
      } catch {
        /* half-written frame; the next one supersedes it */
      }
    };
    source.onerror = () => {
      badge.textContent = "Disconnected \u2014 retrying\u2026";
      badge.style.opacity = "0.9";
    };
  }

  setupSizeChangedNotifications() {}
}
