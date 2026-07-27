# viz-mcp

An MCP server that renders charts and diagrams as live, interactive UI inside the
chat — not as image URLs. Built on the MCP Apps extension (SEP-1865).

```
npm install
npm run build
npm start          # http://localhost:3000/mcp
```

## What it exposes

Two tools, each bound to its own UI template:

| Tool | UI resource | Renderer |
|---|---|---|
| `render_chart` | `ui://viz/chart-view.html` | ECharts — line, bar, scatter, area |
| `render_diagram` | `ui://viz/graph-view.html` | Cytoscape + dagre — flowcharts, node-link graphs |

`render_chart` takes a `charts` array, not a single chart object. One entry
renders full-width exactly like a single chart always has; 2+ entries render
together as one fixed-cell grid image (2 or 3 columns depending on count, up
to 6 charts) in a single call, instead of calling the tool repeatedly.

Two tools rather than one per chart type. A tool-per-type server puts 25 entries
in the model's tool list and burns context on every request; a discriminated
`kind` field covers the same ground and gives the host exactly two templates to
prefetch and security-review.

## How the live rendering actually works

The host streams tool arguments to the view *before the tool executes*, via
`ui/notifications/tool-input-partial`. That is where the liveness comes from —
not from the tool result, which arrives at the end like any other.

Both views subscribe to three events, in escalating order of authority:

```js
app.ontoolinputpartial = ({ arguments: args }) => { /* incomplete, redraw */ };
app.ontoolinput        = ({ arguments: args }) => { /* complete, not yet run */ };
app.ontoolresult       = (result) => { /* server-validated, authoritative */ };
```

Partial arguments are incompletely-parsed JSON. Every field may be missing or
half-written, so both views treat the payload as untrusted and drop anything
malformed rather than throwing — the next partial supersedes it.

### Charts and diagrams stream differently

This is the part worth understanding before modifying either view.

**Charts append.** ECharts `setOption` merges by default, so re-issuing it with a
longer data array adds points and animates the transition. Nothing already drawn
moves. The chart view simply redraws on every partial.

**Diagrams reflow.** Graph layout is global — add one node and the engine
re-solves the whole graph, so every existing node jumps. Running layout on each
partial produces a diagram that thrashes violently, which reads as broken rather
than live.

The graph view avoids this entirely. While arguments stream, nodes accumulate in
a wrapping pill row — deliberately not a graph. Once the complete argument set
arrives, layout runs **once** against the full node and edge set, and nodes are
revealed in sequence along positions that were already solved. A node that has
appeared never moves again.

Reserve true incremental re-layout for graphs that grow from a live data source
where the final shape genuinely isn't knowable up front. Cytoscape's
`layout.run({ animate: true })` tweens between solutions if you need it.

## Chart styling rules

These are load-bearing, not taste. Each one exists because its absence produced
a visibly broken chart.

**A value x-axis must set `scale: true`.** ECharts defaults it to `false`, which
forces zero into the range — a 1974–2024 series then renders on a 0–2500 axis
with every point crushed into a sliver at the right edge. On top of that, a
*year* domain pins `min`/`max` to `dataMin`/`dataMax`: `scale` alone still rounds
the ends out to the next nice tick (1970–2030) and gives up a fifth of the plot
to margin. Other numeric domains keep the rounding — there the round end is the
clean one.

**The y-axis baseline depends on the mark.** Bars and filled areas encode
magnitude by extent, so they sit on zero (`scale: false`) or the lengths lie.
Lines and scatters encode position, so they fit the data (`scale: true`);
pinning them to zero flattens the shape into a stripe.

**Axis names are laid out beyond `containLabel`.** `containLabel` reserves room
for tick *labels* only, so an axis name needs its own padding on that side of
the grid. The y unit is a horizontal caption above the axis (`nameLocation:
"end"`, `nameRotate: 0`) rather than a rotated centred name: `nameGap` on a
rotated name is measured from the axis line, so it has to clear tick text whose
width isn't known until after layout — the gap that works for `40` puts the
caption on top of `1.8M`, and the gap that clears `1.8M` pushes it off canvas.

**The palette is validated, ordered, and never cycled.** Eight fixed hues, each
mode stepped for its own surface (`PALETTE_LIGHT` / `PALETTE_DARK` — the dark
column is not an automatic flip). Slots are assigned in declaration order; a
ninth series takes muted grey rather than a generated hue that a colourblind
reader can't separate from an earlier slot. The view does **not** use ECharts'
built-in `dark` theme — it ships its own palette and paints an opaque navy
background over whatever surface the host has.

**Everything else:** no smoothing (a spline invents curvature between measured
points); markers only under ~30 points per line; solid hairline gridlines on y
only, never dashed; a legend whenever there are 2+ series and none for one; end
labels on the last point only, and only when there's room (single chart, ≤4
line series). The `Table` button is the chart's WCAG-clean twin and lives
outside `#canvas` so opening it never changes the exported PNG.

### Context budget

Tool results carry a one-line summary in `content` and the full dataset in
`structuredContent`. Only `content` enters the model's context. Skip this split
and a thousand-point chart costs you a thousand points of context on every
subsequent turn.

## Host requirements

This server assumes a host that implements the MCP Apps extension. Roughly
two-thirds of the work in a live-UI setup is host-side:

- Fetch `ui://` resources at connection time and cache them
- Render in a sandboxed iframe with CSP derived from `_meta.ui.csp`
- Bridge `postMessage` to JSON-RPC in both directions
- Stream partial tool arguments to the view as the model emits them
- Route UI-initiated `tools/call` back through the same consent and audit path
  as a direct tool call

`@mcp-ui/client` provides `AppRenderer`, which covers most of this.

## CSP

The views load ECharts, Cytoscape, and dagre from jsDelivr. That domain is
declared in `RESOURCE_DOMAINS` in `src/server.ts` and surfaces to the host as
`_meta.ui.csp.resourceDomains`. Anything not on that list fails silently inside
the iframe — if you swap a CDN, update both the `<script src>` and the list.

Vendoring the libraries into the HTML instead removes the CDN dependency and the
CSP entry, at the cost of a larger resource payload. Worth doing if your hosts
run in restricted network environments.

## Transport

Stateless Streamable HTTP: a fresh server and transport per POST, no session
state, no sticky routing required. This matches the direction of the 2026-07-28
revision, which removes protocol-level sessions and the GET stream endpoint.

If you target that revision, note that clients must also send `Mcp-Method` and
`Mcp-Name` headers on POSTs so gateways can route without inspecting the body.

## Extending

Add a chart type: extend the `kind` enum in `chartSpec`, then handle it in
`toEchartsSeries` in `chart-view.html`.

Change the multi-chart grid: column count and per-cell size are computed
independently in two places that must stay in sync — `chartCanvasSize` in
`server.ts` (sizes the render viewport) and `gridColumns`/`.chart-cell-mount`
in `chart-view.html` (lays out the actual grid).

Add interactivity: the views can call back into the server with
`app.callServerTool({ name, arguments })`. Register the target tool with
`_meta.ui.visibility: ["app"]` to keep it out of the model's tool list — useful
for drill-downs and filters that shouldn't consume model attention.
