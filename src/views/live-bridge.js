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
    const source = new EventSource(`/preview/stream?kind=${kind}`);

    source.onmessage = (event) => {
      let args;
      try {
        args = JSON.parse(event.data);
      } catch {
        return;
      }
      badge.style.opacity = "0";
      this.ontoolinput?.({ arguments: args });
      this.ontoolresult?.({ structuredContent: args });
    };

    source.onerror = () => {
      badge.textContent = "Disconnected \u2014 retrying\u2026";
      badge.style.opacity = "0.9";
    };
  }

  setupSizeChangedNotifications() {}
}
