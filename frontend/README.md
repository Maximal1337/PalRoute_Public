# PalRoute — frontend

Interactive map UI for the PalRoute routing engine. **An independently deployable static artefact** — HTML, CSS and ES modules, no build step, no runtime, no Node in production.

It talks to the [PalRoute API](../backend) over HTTP and knows nothing else about it. The two deploy separately: this to a static host or CDN, the API to a container.

## Local development

Two terminals. The API first — see the [backend README](../backend) for its one-time dataset build:

```bash
npm --prefix ../backend run serve
```

Then this UI:

```bash
npm run dev
```

Open **http://127.0.0.1:6767**. The API is on 6969, but you never open it: `server.js` proxies `/api` there, so the browser stays on a single origin and no CORS setup is needed.

It is a **development server only** and not part of the deployed artefact. In production the files are served by nginx, Vercel, or whatever you point at this folder.

If the page loads but says the API is unreachable, the backend is not running — or its dataset was never built, which makes `npm run serve` exit immediately.

## Deployment

The API address lives in exactly one file, [`scripts/config.js`](scripts/config.js), so the same files deploy anywhere.

**The browser only ever talks to this origin.** `/api` is forwarded to the backend by whatever serves these files — nginx in the shipped image, the dev server locally. No CORS is involved, and the API's real address never reaches the browser, so it can be firewalled to the frontend alone.

### TLS — nothing here terminates it

**This project configures TLS nowhere.** nginx listens on `:80`, Fastify speaks plain HTTP, and there is no certificate anywhere. That is deliberate — TLS belongs at the edge, not inside a Node process — but it means you must supply it. Three hops, three different answers:

| Hop | Protocol | Why |
|---|---|---|
| browser → this service | **HTTPS required** | The only public hop. Without it the traffic is readable and the browser marks the site insecure |
| nginx → API, same host | HTTP is fine | Docker's internal network; the traffic never leaves the machine. Encrypting it buys nothing and costs certificate management |
| nginx/Vercel → API, **different host** | **HTTPS required** | This crosses the public internet |

On **Vercel** the first hop is handled for you — HTTPS is automatic, nothing to configure. Self-hosting means either a certificate plus `listen 443 ssl` in `nginx.conf`, or putting Caddy/Traefik in front, which obtain one themselves.

**The trap when the API is on another host.** An HTTP API fails differently depending on which shape you picked:

- **With the `/api` rewrite** it appears to work. The browser only ever sees HTTPS to your frontend, and the rewrite happens server-side, so no mixed-content rule fires — **but the leg from your frontend host to your API travels in clear text.**
- **Calling the API directly** (`apiBase: 'http://…'`) fails outright. An HTTPS page cannot `fetch` an HTTP URL; browsers block it as mixed content, with no workaround.

Both are fixed the same way: give the API a certificate and use `https://` in `API_PROXY_PASS` or `apiBase`.

`X-Forwarded-Proto` is already forwarded by the generated proxy config, so the API can tell what scheme the client originally used.

### Docker

```bash
docker build -t palroute-ui .
```

```bash
docker run -d --name palroute-ui -p 8080:80 -e API_BASE=/api -e API_PROXY_PASS=https://your-api.example.com/ palroute-ui
```

Open **http://localhost:8080**. An nginx image with no Node in it. Both variables are read at container start — `API_BASE` rewrites `config.js`, `API_PROXY_PASS` generates the nginx `/api/` location — so **one image serves every environment** rather than baking an API URL in at build time.

To point it at an API container on the same machine, reach the host rather than `localhost` (which inside a container means the container itself):

```bash
docker run -d --name palroute-ui -p 8080:80 -e API_BASE=/api -e API_PROXY_PASS=http://host.docker.internal:6969/ palroute-ui
```

Stop and remove both:

```bash
docker rm -f palroute-api palroute-ui
```

There is deliberately no compose file. The two services share nothing but an HTTP contract, so running both is just running both — build and start each from its own repo.

### Vercel (optional)

`vercel.json` handles routing and caching. There is no build command — it is already static. Vercel has no proxy of its own configured, so add the rewrite yourself:

```json
{ "source": "/api/:path*", "destination": "https://your-api.example.com/:path*" }
```

It ships without that line on purpose: a rewrite pointing at a host that does not exist yet fails as a 502 on every query, which is harder to diagnose than the plain "API not reachable through this origin" you get without it.

### Calling the API cross-origin instead

Supported, but not the default. Set `apiBase` to the API's own URL and allowlist this frontend on the backend:

```bash
PALROUTE_CORS_ORIGINS=https://your-frontend.vercel.app
```

Be aware this costs a CORS preflight: the app POSTs `application/json`, which is never a "simple request", so every query is preceded by an `OPTIONS` round trip.

### Overriding at runtime

`?api=https://host` or `localStorage.setItem('palroute.api', '…')` take precedence over `config.js` — for pointing a deployed UI at a local API while debugging, without a redeploy.

## Layout

```
pages/index.html     single page — the map is the app
css/
  reset.css          minimal reset
  theme.css          design tokens (colours, spacing, type)
  layout.css         app shell + responsive breakpoints
  components.css     panels, fields, buttons, result rows
  map.css            canvas overlays, legend, tooltip
scripts/
  main.js            bootstrap and event wiring
  api.js             API client + failure diagnosis
  map.js             canvas renderer — pan, zoom, hit-testing, routes
  basemap.js         map image + its derived placement calibration
  projection.js      world -> image-pixel projection
  ui.js              results-panel rendering
  palette.js         canvas colours, read from the CSS variables
  format.js          duration/distance formatting
  config.js          API address — the one file that changes per environment
data/                the base map image (WebP) — community-made, see Credits
server.js            DEV ONLY: static server + /api proxy, not deployed
Dockerfile           nginx image, no Node
nginx.conf           routing + cache headers for that image
vercel.json          routing, caching and the /api rewrite for Vercel
```

Only `pages/`, `css/`, `scripts/` and `data/` are ever public. `server.js`, `Dockerfile` and the rest are build/dev files and are not served.

## The three modes

Pick a mode, set your filters and unlocked beacons, press **Run**. All three answer a different question, and all three are solved on the backend — the browser never computes a route.

### Nearest — *"what can I get to quickly?"*

Ranks every POI matching your filters by travel time, and tells you **which beacon serves each one**. This is the one-run-answers-everything mode: the backend seeds a single Dijkstra from every unlocked beacon at once, so one pass yields both the time and the originating beacon for all 652 POIs.

- **Needs:** unlocked beacons (with none, nothing is reachable).
- **Gives:** up to 40 ranked results, each showing the time and the `⇒ beacon` to fast travel to. Unreachable matches are listed separately rather than dropped.
- **Use it for:** "which alpha boss can I farm right now?", "what's near me on this island?"

### Route — *"how do I get to this specific place?"*

The full leg-by-leg path to one target. **Click any POI on the map** to pick a target — that switches to Route mode and runs automatically — or select one from a Nearest result.

- **Needs:** a selected target, plus unlocked beacons.
- **Gives:** the start beacon, total time, and every leg with its mode (walk / fly / swim / fast travel / dungeon portal), per-leg and cumulative time.
- **Use it for:** "what's the fastest way to Anubis, and where do I teleport from?"

### Tour — *"visit all of these in the best order"*

The shortest route visiting **every** POI matching your filters. The backend builds a pairwise distance matrix, seeds with nearest-neighbour, then improves with 2-opt — the summary reports both numbers so you can see what the optimisation bought.

- **Needs:** filters that select a sensible set, plus unlocked beacons. 153 effigies solves in about a second; the approach is stated as adequate for 50–150 targets.
- **Gives:** an ordered itinerary with fast-travel hops shown as their own steps, arrival times, and any unreachable targets listed explicitly.
- **`--one-per`:** group by kind or class and visit one representative of each. Documented in the output as a *greedy simplification* of the generalized TSP, not an optimal solution to it — a slightly farther representative can sometimes shorten the whole tour.
- **Use it for:** "collect every Lifmunk effigy", "one of each alpha".

### Filters

**Kind** and **Biome** are both multi-select — Ctrl/⌘-click or drag for several, nothing selected means no filter. Each option shows how many POIs it holds.

**Most POIs have no biome.** It is derived from spawner-id tokens, so effigies, dungeon entrances and predators never carry one, and most fast-travel points and field bosses do not either — 506 of 652 in total. Combining a biome with those kinds therefore matches *nothing*, permanently — no amount of adjusting the other controls helps. Select **(no biome)** to target them instead.

Filters combine with AND, so an empty result names the filter responsible ("Kind is the limiting filter — clearing it finds 153") rather than leaving a silently grey map. **Reset filters** clears all four at once.

### Things worth knowing

**Unlocked beacons are the biggest lever.** Default is none, matching the backend. Six beacons gives a genuinely different answer than forty — on foot, Anubis is 23 s away with all 152 unlocked and 3 m 33 s with six. Your selection persists in `localStorage`.

**Expect routes to double back.** A tour that returns to a beacon instead of continuing to the nearest target is usually correct — the teleport is faster than the walk. That is why fast-travel hops are styled so loudly.

**Filtering is client-side; routing is not.** Changing a filter only re-highlights markers. Anything that changes a route goes to the backend, because the graph and the solver live there.

**Clear** removes the drawn route, the beacon highlights and the results, but leaves your filters, mount and beacons alone. It is "undraw that", not "start over".

## The map

A 1000×1000 community-made map image of the Palpagos Islands ships in `data/`. POIs are drawn over it from world coordinates: the backend serves the world→map transform it **fitted** from calibration points (never hardcoded) on `/meta`, and `basemap.js` composes that with an image placement derived by correlating POI density against land density. See the comments there before touching those constants — the obvious metric ("maximise POIs on land") demonstrably prefers a wrong answer.

**Those constants belong to that one file.** They are scale, offset and axis flip in *its* pixels, so any other image — different resolution, crop or projection — puts every marker in the wrong place. *Use a different map image* loads your own and *Display → Align base map* re-derives the placement by hand, but replacing the shipped image is a re-calibration, not a file swap. That is why it is committed rather than fetched.

**Off-map regions.** Palworld's World Tree is a separate map with its own coordinate space, so its 36 POIs cannot sit on a Palpagos image. They keep their own layout inside a labelled frame; untick *Off-map regions* to hide them. Routes to them still work either way.

## What the visuals mean

These are not decoration — they carry the backend's honesty guarantees through to the screen:

| Cue | Meaning |
|---|---|
| **Bright purple bloom, always labelled** | A beacon **this answer actually uses**. A tour of 153 effigies uses 68 of 152 unlocked — these are the ones to go find |
| **Faint purple halo** | Unlocked but unused by this answer |
| **Dashed magenta line, arrow glyph** | Fast-travel hop. Routes often double back to a beacon instead of continuing to the nearest target; that is correct, and the styling exists so it does not read as a bug |
| **Dotted amber line** | Dungeon portal — a fixed per-archetype constant, not a modelled path |
| `est` **chip / faded line** | Cost rests on an assumption, not a modelled path |
| **Dashed amber ring on a marker** | No source elevation; routes through it ignore climb entirely |
| **Rotating dashed ring + outward ping** | The currently selected POI — what you last clicked, on the map or in the results. Motion is what makes it findable among hundreds of static dots. Falls back to a plain ring under `prefers-reduced-motion` |
| **Magenta ring** | The beacon this route starts from |
| **Dashed frame with a label** | A separate map the base image does not cover |
| **Footnote under the results** | Terrain is not modelled (Tier B). Real on-foot times will be longer, often much longer on foot |

## Controls

Drag to pan · scroll or pinch to zoom · click a POI to route to it · double-click to zoom in.
Click a legend entry to show/hide that POI kind.

Clicking a **results row** selects and centres that POI, marking it with the animated ring — including the fast-travel hop rows, which select the beacon you need to find.

| Key | Action |
|---|---|
| <kbd>Enter</kbd> | Run |
| <kbd>Shift</kbd>+<kbd>Esc</kbd> | Clear the drawn answer |
| <kbd>Esc</kbd> | Close drawers |
| <kbd>F</kbd> | Fit map to view |
| <kbd>+</kbd> / <kbd>−</kbd> | Zoom |

## Pointing at a different backend

```
http://127.0.0.1:6767/?api=http://127.0.0.1:9000
```

Or set `localStorage.setItem('palroute.api', 'http://…')`. The backend's CORS rule allows any localhost origin.

## Debugging

`window.__palroute` exposes `{ map, state, api, run, boot }` from the console.

## Credits

PalRoute is an unofficial fan tool, not affiliated with or endorsed by Pocketpair. Palworld and all related assets are the property of Pocketpair.

The base map image in `data/` is **community-made fan art**, not PalRoute's work and **not covered by this repository's MIT licence**, which applies to the source code only. It is bundled because the placement calibration is fitted to that exact file and the UI is unusable without a map underneath it. If you hold rights to the image and want it gone, open an issue and it will be removed.

POI coordinates are **not** in this repository — the backend downloads them at build time from the sources listed in its [Credits](../backend/README.md#credits).
