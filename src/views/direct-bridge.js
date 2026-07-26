/**
 * Stand-in for @modelcontextprotocol/ext-apps used only when the server
 * renders a view headlessly (see ../serverRender.ts) to produce the static
 * PNG that ships inline with render_chart / render_diagram tool results.
 *
 * Unlike live-bridge.js (which streams real tool calls over SSE for the
 * /preview dev harness), the arguments are already known up front here —
 * they're embedded on the page as window.__RENDER_ARGS__ before this module
 * loads. connect() just replays them synchronously through the exact same
 * ontoolinput/ontoolresult hooks a real host would call, then flags
 * completion so the headless browser knows it's safe to screenshot.
 */

export class App {
  constructor(_info, _capabilities) {}

  async connect() {
    const args = window.__RENDER_ARGS__;
    this.ontoolinput?.({ arguments: args });
    this.ontoolresult?.({ structuredContent: args });
    window.__renderDone = true;
  }

  setupSizeChangedNotifications() {}
}
