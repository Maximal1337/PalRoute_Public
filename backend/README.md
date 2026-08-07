# PalRoute

Static POI routing for Palworld. Fast-travel beacons are real graph edges, so **"walk 800 m"** and **"teleport + walk 200 m"** compete on the same units — seconds.

Backend (Node + TypeScript) exposing an HTTP API for a local frontend, plus a CLI over the same engine.

Full design rationale, data provenance and limitations: **[PALROUTE_SPEC.md](Docs/PALROUTE_SPEC.md)**.

## Quick start

First run — the dataset is not committed, so these are required, not optional:

```bash
npm install
npm run data:fetch    # download community sources (~240 KB) into data/vendor/
npm run data:build    # normalize into data/pois.json  (652 POIs)
npm run validate      # exits non-zero if anything is wrong
```

Then the API:

```bash
npm run serve         # http://127.0.0.1:6969
```

And the UI in a second terminal, from [`../frontend`](../frontend):

```bash
npm run dev           # http://127.0.0.1:6767
```

**Open 6767, not 6969.** The dev server proxies `/api` to this API, so the browser stays on a single origin and no CORS setup is needed.

**If `npm run serve` exits immediately**, `data/pois.json` is missing — it is gitignored. Run the three build steps above.

### From the parent folder

`npm --prefix` needs no `cd` and works in any shell:

```bash
npm --prefix backend run serve
```

```bash
npm --prefix frontend run dev
```

### Everyday commands

```bash
npm test              # 79 tests
npm run typecheck     # tsc --noEmit
npm run cli -- info   # dataset provenance and declared gaps
```

**This is a JSON API and nothing else** — it serves no HTML, CSS or images. The [UI](../frontend) is a separate artefact with its own lifecycle, deployed independently to a static host or CDN. Keeping them apart is what lets the API scale, containerise and version on its own terms.

### Reaching it from the frontend

The [UI](../frontend) forwards `/api` to this service, so the browser stays on one origin and **no CORS is involved** — nothing to configure here.

If you instead point the UI straight at this API, its origin must be allowlisted; that allowlist is then the security boundary:

```bash
PALROUTE_CORS_ORIGINS=https://your-frontend.vercel.app,https://staging.example.com
```

`localhost` is allowed by default for development; set `PALROUTE_CORS_ALLOW_LOCALHOST=false` in production.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HOST` / `PORT` | `127.0.0.1` / `6969` | Listen address. The image sets `0.0.0.0` |
| `PALROUTE_CORS_ORIGINS` | none | Comma-separated origins allowed to call this API |
| `PALROUTE_CORS_ALLOW_LOCALHOST` | `true` | Set `false` in production |
| `PALROUTE_RATE_LIMIT_MAX` | `120` | Requests per window per IP. `0` disables |
| `PALROUTE_RATE_LIMIT_WINDOW` | `1 minute` | Rate-limit window |
| `PALROUTE_TRUST_PROXY` | `false` | Count `X-Forwarded-For` instead of the socket address. Set `true` only behind a proxy you control |

A tour over 153 targets costs about a second of CPU, so the rate limit exists before this is exposed publicly. `/health` is exempt. The counter is in-memory, which is correct for a single instance and needs a shared store if you replicate.

### Docker

```bash
docker build -t palroute-api .
```

```bash
docker run -d --name palroute-api -p 6969:6969 palroute-api
```

The image fetches and validates the dataset at build time, since licensing prevents shipping the upstream data. It uses **`data fetch --frozen`**, so the build fails if upstream no longer matches the committed lockfile — see [The lockfile](#the-lockfile-and-what-reproducible-means-here) for how to adopt a change.

For an offline build, pass `--build-arg FETCH_DATA=false` and mount a prebuilt dataset at `/app/data`.

**This API speaks plain HTTP and terminates no TLS** — that belongs at the edge, not in a Node process. Behind the UI's `/api` proxy on the same host that is correct and needs nothing. **If the API is reachable from the public internet, do not publish `6969` as-is**: put a reverse proxy with a certificate in front of it, and use `https://` in the frontend's `API_PROXY_PASS`. Full breakdown of the three hops: [frontend README → TLS](../frontend/README.md#tls--nothing-here-terminates-it).

**The first two steps are required, not optional** — neither the raw source data nor the built `data/pois.json` is committed, for licensing reasons. `data:fetch` needs network once (~240 KB); everything after that is offline.

## The lockfile, and what "reproducible" means here

`data/sources.lock.json` **is** committed and pins every input by SHA-256. The upstream repository is not versioned or tagged — it is a `main` branch that can change at any time, without notice — so the lockfile is the only thing that makes two builds comparable.

There are deliberately **two modes**, and the difference matters:

| Command | Behaviour | Use |
|---|---|---|
| `npm run data:fetch` | Downloads whatever upstream serves now and **rewrites the lockfile** | Deliberately adopting new game data |
| `npx tsx src/cli.ts data fetch --frozen` | Verifies each download against the lockfile, **writes nothing on drift**, exits non-zero | Builds, CI, Docker |

Roughly `npm install` versus `npm ci`. To check whether upstream has drifted — the same check the image build runs:

```bash
npm run cli -- data fetch --frozen
```

**The Docker image builds with `--frozen`.** If upstream has moved, the build *fails* rather than quietly baking in different data. That is intended: a failure means upstream changed and someone needs to look, not that the build is broken.

To adopt an upstream change:

```bash
npm run data:fetch && npm run data:build && npm run validate
```

then review and commit `data/sources.lock.json`. Counts live in `data/expectations.yaml`, so a change large enough to fall outside the expected ranges fails validation instead of passing silently.

This is not theoretical. On 2026-08-05, three of six sources changed under a stale lockfile: fast-travel points went 163 → 174 rows, taking the dataset from 641 to 652 POIs and beacons from 141 to 152. Before `--frozen` existed the Docker build accepted that silently.

## API for the frontend

Every response includes a `terrain` block — check `terrain.banner` and show it, because distances are currently **not terrain-modelled**.

```js
const API = 'http://127.0.0.1:6969';

// What can I filter on?
const meta = await (await fetch(`${API}/meta`)).json();
// meta.kinds, meta.biomes, meta.profiles, meta.declared_gaps

// The player's unlocked beacons drive everything. Default is NONE, not all.
const { beacons } = await (await fetch(`${API}/beacons`)).json();
const unlockedBeacons = beacons.slice(0, 6).map(b => b.poi_id);

// Nearest alpha bosses
const near = await (await fetch(`${API}/nearest`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'alpha_boss', limit: 10, mount: 'none', unlockedBeacons }),
})).json();
// near.results[].seconds, .start_beacon.name, .poi

// Full route to one target
const route = await (await fetch(`${API}/route/${poiId}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ unlockedBeacons, mount: 'jetragon' }),
})).json();
// route.route.legs[] — each has mode ('walk'|'fly'|'teleport'|'portal'),
// seconds, cumulative_seconds, estimated

// Tour of every effigy
const tour = await (await fetch(`${API}/tour`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ kind: 'effigy', mount: 'nitewing', unlockedBeacons }),
})).json();
// tour.stops[], tour.unreachable[], tour.optimisation

// SVG overlay, ready to layer on a map image
const svg = await (await fetch(`${API}/map?target=${poiId}&unlockedBeacons=${unlockedBeacons}`)).text();
```

Endpoint table: [spec §7](Docs/PALROUTE_SPEC.md#7-http-api).

### Rendering notes

- **Mark teleport legs distinctly.** Optimal routes often double back to a beacon instead of continuing to the nearest target. That is correct, and users read it as a bug unless the hop is obvious.
- **Respect `estimated`.** A leg with `estimated: true` rests on an assumption, not a modelled path.
- **Handle `unreachable`.** Palworld's landmasses are genuinely disconnected; a target with no unlocked beacon on its island cannot be reached. Look for the `unreachable_components` warning.

## CLI

```bash
npx tsx src/cli.ts beacons --json > mine.json
npx tsx src/cli.ts nearest --kind alpha_boss --unlocked-beacons mine.json --limit 5
npx tsx src/cli.ts to alpha_boss_81_1_grass_fboss_14 --unlocked-beacons mine.json --mount none
npx tsx src/cli.ts tour --kind effigy --unlocked-beacons mine.json --mount nitewing
npx tsx src/cli.ts info        # provenance and declared gaps
npx tsx src/cli.ts profiles    # speeds and how trustworthy they are
```

`data/beacons.example.json` (6 beacons) and `data/beacons.all.json` (all 152) are ready to use.

## Tests

```bash
npm test
```

79 tests covering the spec's acceptance criteria: teleport-vs-walk fixtures, layer isolation, 2-opt monotonicity, unreachability reporting, validation exit codes, graph-cache eviction, and the API contract.

## Credits

PalRoute computes routes; it does not extract game data. Everything it routes over comes from other people's work.

| Source | Used for | Licence |
|---|---|---|
| [oMaN-Rod/palworld-save-pal](https://github.com/oMaN-Rod/palworld-save-pal) | All POI coordinates — fast travel points, Lifmunk effigies, boss spawners, dungeon and predator markers — plus the English name tables for beacons and Pals | **No LICENSE file published.** All rights reserved by default |
| [palworldlol/palworld-coord](https://github.com/palworldlol/palworld-coord) ([write-up](https://blog.palworld.lol/reverse-engineering-palworld-coordinate-system/)) | The two published world↔map correspondences used to *fit and check* PalRoute's map transform. Credit to [palworld.lol](https://palworld.lol) and [cmkb3](https://github.com/cmkb3) for the original reverse engineering | MIT |
| [Pocketpair](https://www.pocketpair.jp/) | Palworld itself. PalRoute is an unofficial fan tool, not affiliated with or endorsed by Pocketpair | — |

**On the unlicensed source:** because `palworld-save-pal` publishes no licence, this repository does **not** redistribute its data. `npm run data:fetch` downloads it to a gitignored directory at build time; only a lockfile of URLs and SHA-256 hashes is committed. If you fork or publish anything built on this, that constraint travels with you — and it is worth asking the upstream maintainer for an explicit licence.

PalRoute's own code is MIT.

## Before you trust a number

Absolute travel times are **indicative, not measured** — terrain is not modelled and the movement speeds are unverified estimates. Relative comparisons (is teleporting faster than walking? does Jetragon change the route?) are sound. Full list: [spec §11](Docs/PALROUTE_SPEC.md#11-known-limitations).
