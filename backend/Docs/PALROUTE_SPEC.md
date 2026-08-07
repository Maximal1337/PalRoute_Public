# PalRoute — Static POI Routing for Palworld

**Implementation: Node.js + TypeScript, CLI + HTTP API.** A tool that answers two questions over a static, patch-versioned dataset of Palworld world points of interest:

1. *"What is the fastest way to reach POI X, and which fast-travel beacon should I start from?"*
2. *"What is the shortest tour that visits every POI in this set (all alpha bosses, all effigies, one of each instance type)?"*

No live server data. No `/game-data`. No players. Everything is derived from community datasets (optionally from your own pak exports), reproducible from a committed lockfile.

The HTTP API is the primary surface: a local frontend calls it directly. The CLI wraps the same engine, so both return identical answers by construction.

> **Status.** Implemented and passing 79 tests against the real 652-POI dataset. Terrain is **Tier B** (not modelled) — see §3.1. Sections marked ⚠️ record where the real data forced a change from the original spec.

---

## 0. Core idea

The interesting part is **not** Dijkstra over Euclidean distances — on an open map that degenerates into straight lines. The value comes from two things:

- **Teleports as graph edges.** Fast-travel statues and PalBoxes are near-zero-cost edges. "Walk 800 m" vs. "teleport + walk 200 m" becomes a real comparison only when both live in the same graph with the same units.
- **Multi-source Dijkstra.** Do not run N separate searches, one per beacon. Add a virtual super-source with zero-weight edges into every *unlocked* beacon. A single run yields, for every POI in the world, both the travel time and the beacon you should have started from.

Everything else in this spec exists to make those two things correct.

**Implementation note.** The super-source is implicit: rather than materialising an extra node and mutating the graph, every unlocked beacon is seeded into the priority queue at the map-open cost with itself as `origin`, and `origin` propagates along each relaxation. Same result, no graph mutation, and `origin[v]` answers "which beacon" in O(1) without walking `prev` back to the source.

---

## 1. Data layer

The dataset is the hard part and the part most likely to be wrong. The data layer ships with validation, and was built before any pathfinding code.

### 1.1 Sources, in descending order of reliability

| Source | Method | Notes |
|---|---|---|
| Game `.pak` files | FModel / repak / UE4SS to export DataTables and level actors to JSON | Ground truth. Table names drift between patches. Supported via `--pak-dir`. |
| Community datasets | GitHub repos with effigy/alpha/dungeon coordinates | **What ships by default.** |
| Hybrid | Skeleton from community data, overridden by pak exports and a manual overlay | Precedence: `manual > pak > community`. |

**Do not hardcode DataTable names.** [`src/datasource/scan.ts`](src/datasource/scan.ts) walks an arbitrary JSON tree and identifies candidate records by *coordinate field signature* — probing `x/y/z`, `LocationX/Y/Z`, `world_x/y/z`, `PosX/Y/Z` and others, at the record root or inside a nested `Location`/`Translation`/`Position` container. It handles both keyed maps (`{"<guid>": {...}}`) and arrays, and both community JSON and FModel exports. When nothing matches it **fails loudly with a diagnostic naming every probed triple**, rather than returning zero rows.

Every extracted record retains a `source` field (`pak:<file>#<path>`, `community:<repo>/<file>`, `manual`, `synthetic:<reason>`) so bad data is traceable.

#### ⚠️ 1.1a Upstream data is fetched, not vendored

The shipped sources come from [`oMaN-Rod/palworld-save-pal`](https://github.com/oMaN-Rod/palworld-save-pal), which **ships no LICENSE file** — all rights reserved by default. Committing its JSON into this repo would be a licensing risk.

Instead: `npm run data:fetch` downloads into `data/vendor/` (gitignored) and writes [`data/sources.lock.json`](data/sources.lock.json) — URL, **SHA-256**, byte count, row count, fetch timestamp, licence — which **is** committed. The build stays reproducible and every POI keeps traceable provenance, without this repo republishing anyone's data. A hash mismatch on load is a hard error, not a warning.

Coordinates are in **Unreal world units** (1 uu = 1 cm), not map pixels — verified by the calibration check in §1.3.

#### ⚠️ 1.1b What the real data does and does not contain

| Source file | Rows | → kind | Note |
|---|---|---|---|
| `fast_travel_points` (`class=TowerFastTravelPoint`) | 152 | `fast_travel` | has z |
| `fast_travel_points` (`class=UnlockMapPoint`) | 22 | `map_unlock` | **not a teleport** — see below |
| `bosses` (`character_id=BOSS_*`) | 90 | `alpha_boss` | has z, level; named via `l10n/en/pals.json` (100% resolved) |
| `bosses` (`character_id="None"`) | 69 → **36** | `field_boss` | human/NPC bosses; 33 exact duplicates collapsed |
| `effigies` | 153 | `effigy` | coordinates only |
| `map_objects` (`type=dungeon`) | 170 | `dungeon_entrance` | **no z** |
| `map_objects` (`type=predator_pal`) | 29 | `predator` | **no z** |
| `map_objects` (`type=alpha_pal`) | 72 | *dropped* | duplicates `bosses` without z or level |
| — | 0 | `tower_boss`, `palbox`, `dungeon_boss`, `merchant`, `chest`, `ore_node` | **declared gaps** |

Three findings that changed the design:

- **`UnlockMapPoint` is not a teleport.** 22 of the 174 "fast travel points" are fog-of-war obelisks. Folding them into `fast_travel` would invent 22 free teleport endpoints that do not exist in game. They get their own kind and are excluded from the teleport clique.
- **`map_objects` has no `z` at all.** 199 POIs (31%) carry `world_z: null` and `z_estimated: true`. The cost model drops the climb/glide term for them and flags every touching edge `estimated`. Fabricating a Z would silently make cliffs disappear.
- **`bosses.json` contains 33 exact duplicate rows** — identical spawner id, character, level *and* coordinates under different object keys. The normalizer collapses them. Left alone they would be phantom POIs that a "visit every field boss" tour dutifully visits twice. Matching is **exact on coordinates**, never proximity: two bosses legitimately 20 m apart are different POIs, and one spawner name genuinely appears at two different locations. Proximity remains a validator *warning*, where a human decides.

**Declared gaps.** `palbox` is player-placed and cannot come from static data (supply it via `--manual-pois`). `tower_boss` has no coordinates in these sources, and cannot be inferred from the class name because `BP_LevelObject_TowerFastTravelPoint_C` is used for *all* fast travel points. These are recorded on the dataset as `declared_gaps`, so a zero count reads as an acknowledged absence rather than a silent import failure.

### 1.2 Unified node schema

```jsonc
{
  "poi_id": "alpha_boss_81_1_grass_fboss_14",  // stable, unique
  "kind": "alpha_boss",                        // see enum below
  "name": "Anubis",
  "class_id": "BOSS_Anubis",                   // raw game class where applicable
  "level_id": "overworld",                     // graph layer — see §2
  "biome": "grassland",
  "world_x": -142300.0,                        // Unreal units (1 uu = 1 cm)
  "world_y": 83100.0,
  "world_z": 4200.0,                           // NULL when the source has no Z
  "z_estimated": false,                        // true when world_z is null
  "requires": ["flying"],                      // traversal prerequisites, may be empty
  "boss_level": 30,                            // null when not applicable
  "respawn_kind": "timed",                     // timed | once | static | unknown
  "source": "community:palworld-save-pal/bosses.json"
}
```

`kind` enum — original: `fast_travel`, `palbox`, `alpha_boss`, `tower_boss`, `dungeon_entrance`, `dungeon_boss`, `effigy`, `merchant`, `chest`, `ore_node`.
⚠️ Additions forced by the real data: `map_unlock`, `field_boss`, `predator` (rationale in §1.1b). Purely additive — no original member changed meaning.

⚠️ `world_z` is **nullable**, paired with `z_estimated`. Biome is **derived** from spawner-id tokens, not authoritative metadata; POIs with no hint keep `biome: null` rather than being guessed at.

### 1.3 Validation (required, not optional)

`palroute validate` emits a report and **exits non-zero on failure**. Implemented in [`src/datasource/validate.ts`](src/datasource/validate.ts):

- per-kind and per-biome counts against ranges in [`data/expectations.yaml`](data/expectations.yaml)
- duplicate detection: same `kind` within a per-kind radius (warns — near-coincidence is suspicious, not always wrong)
- bounds check: every coordinate inside known world extents
- orphan check: every non-overworld `level_id` is entered through at least one portal
- schema conformance, unique `poi_id`, non-null `source`, finite coordinates
- biome coverage and `z_estimated` fraction against thresholds
- **coordinate-system sanity**: the world→map transform is *fitted* from calibration points and must reproduce them

A check that cannot be performed is reported `skipped` with a reason — never silently counted as a pass.

Current output: **652 POIs**, all checks `pass` except two honest warnings (3 close same-kind pairs; the transform hold-out that cannot be performed with only 2 published calibration points).

---

## 2. Graph model

The world is **not** one flat graph. It is layered.

- **Layers** (`level_id`): `overworld`, plus one synthetic layer per dungeon interior.
- **Walk/fly/swim edges** connect nodes **only within the same `level_id`**. This is *structural*: the spatial index is built per-layer, so a neighbour query cannot return a node from another layer. It is not a filter that could be forgotten.
- **Portal edges** cross layers: `dungeon_entrance → dungeon_interior_root`, at a fixed per-archetype cost covering the loading screen plus estimated interior traversal. Always flagged `estimated`. Exit costs 25% of entry (loading screen only).

⚠️ Dungeon interiors are procedurally generated, so there is nothing static to extract. To keep the layered model real rather than vacuous, [`src/graph/layers.ts`](src/graph/layers.ts) synthesizes one interior root per entrance at graph-build time. These are **never written to `pois.json`** — the dataset holds observed data, the graph holds the model. They carry `source: "synthetic:dungeon-interior"` and `z_estimated: true`.

⚠️ **Islands really are separate.** The overworld splits into **4 connected components** (609 / 134 / 36 / 32 nodes) — Palworld's distinct landmasses, with no walkable link between them. `MIN_DEGREE` guarantees no isolated *node*, but deliberately does **not** bridge components. A target in a component containing none of your unlocked beacons is genuinely unreachable, and the engine emits an `unreachable_components` warning saying exactly that instead of leaving the user puzzled.

### 2.1 Edge construction

Within a layer, a k-nearest-neighbour / radius graph (uniform spatial hash; radius configurable, default 500 m) rather than a complete graph. If a node has fewer than `MIN_DEGREE` (default 3) neighbours in radius, it is connected to its k nearest regardless of distance, and those long edges are **flagged** — carrying their real distance in the note, and marked `estimated`.

Teleport nodes (`fast_travel`, `palbox`) form a clique with weight `TELEPORT_COST` — **only among beacons the player has unlocked** (§5). `map_unlock` is excluded.

---

## 3. Cost model

Edge weight is **seconds**, never metres. Otherwise teleport cost has nothing to compare against.

```
walk:     hypot(dx, dy)/v_ground + max(0, dz)/v_climb + max(0, -dz)/v_glide
fly:      dist3d / v_mount                  (only when a flying mount is configured)
swim:     dist / v_swim * water_penalty     (only for segments crossing water)
teleport: TELEPORT_COST                     (default 20 s: map screen + load)
portal:   DUNGEON_ENTER_COST                (per dungeon archetype)
```

⚠️ When either endpoint has `z_estimated`, the vertical term is **dropped entirely** and the edge is flagged, rather than pretending a fabricated Z.

⚠️ Tier B has no water mask, so the swim branch never fires in the shipped configuration. Stated plainly rather than approximated.

**Movement profiles are configuration, not constants.** `--mount none|direhowl|nitewing|jetragon` changes the answer materially, and there is a test asserting the on-foot and flying routes *differ in structure*, not merely in clock time.

⚠️ **Speed provenance.** The spec requires speeds "sourced from game data where available, measured otherwise, and documented either way." They are **neither** — every profile in [`data/profiles.yaml`](data/profiles.yaml) carries `speed_source: estimate-unverified`, and `palroute profiles` says so. They are order-of-magnitude estimates chosen so the on-foot vs flying comparison behaves sensibly. **Relative comparisons (teleport vs walk) are far less sensitive to these numbers than absolute ETAs are.** Replace them with measured values before trusting an absolute ETA.

### 3.1 Terrain

Two tiers, and the tool is honest about which one is active:

- **Tier A:** landscape heightmap plus water mask, rasterized to an 8 m grid with per-cell passability and slope, 8-connected A* on the grid with per-pair caching. **Implemented** in [`src/graph/terrain.ts`](src/graph/terrain.ts) behind the `TerrainProvider` interface — but it requires a real extracted heightmap, supplied via `--heightmap`. There is deliberately **no synthetic fallback grid**: a fabricated heightmap would earn Tier A labelling on Tier B quality data.
- **Tier B (active by default):** straight line with the Z penalty. Every edge flagged `estimated`, and a prominent banner is printed on **every** CLI response and attached to **every** API response body.

Tier B results are never presented as if cliffs and coastlines were accounted for.

---

## 4. Algorithms

1. **Multi-source Dijkstra.** Implicit super-source → every unlocked beacon at map-open cost. One run produces `dist[]`, `prev[]`, `prevEdge[]` and `origin[]`; for any POI, report both time-to-reach and the originating beacon. A test asserts the result equals N separate single-source runs.
2. **Single-target mode.** Reconstructs the path, prints it leg by leg, marks teleport hops distinctly.
3. **Set-visiting mode.** Pairwise Dijkstra distance matrix, greedy nearest-neighbour seed, then 2-opt. ⚠️ 2-opt recomputes the affected span rather than using the textbook two-boundary-edge delta, because portal edges make the matrix **asymmetric** (`d(i,j) ≠ d(j,i)`) and the shortcut is invalid there. Candidates are accepted only on strict improvement, which is what guarantees §8's "never worse than the seed".
4. **"One of each type" mode.** Groups by `class_id` or `kind`, picks the representative cheapest to reach from the beacon network. **Documented in the output itself** as a greedy simplification of the generalized TSP, not an optimal GTSP solution — the true GTSP would choose representatives and ordering jointly.

**Presentation note:** teleports make optimal tours look "wrong" — the route often returns to a beacon instead of continuing to the next-closest target. The algorithm finds this correctly; the output highlights teleport hops explicitly, with an inline note that this is expected behaviour rather than a bug.

---

## 5. CLI

```bash
palroute data fetch                      # download sources, refresh lockfile
palroute data build                      # normalize -> data/pois.json
palroute validate                        # §1.3 report; non-zero exit on failure
palroute beacons --json > mine.json      # list beacons to build an unlocked set

palroute nearest --kind alpha_boss --biome desert --unlocked-beacons mine.json
palroute to alpha_boss_81_1_grass_fboss_14 --mount none --unlocked-beacons mine.json
palroute tour --kind effigy --biome all --mount nitewing --unlocked-beacons mine.json
palroute tour --one-per class_id --kind alpha_boss

palroute profiles                        # speeds and their provenance
palroute info                            # dataset provenance and declared gaps
palroute serve --port 6969               # start the HTTP API
palroute cache-clear
```

| Flag | Purpose |
|---|---|
| `--kind` | filter by POI kind, comma-separated |
| `--biome` | filter by biome (`all` disables) |
| `--level-range MIN:MAX` | filter by boss level |
| `--search TEXT` | substring match on name or id |
| `--unlocked-beacons FILE` | JSON list of beacon ids; **default is not "all"** |
| `--mount PROFILE` | movement profile |
| `--teleport-cost SECONDS` | override |
| `--radius METRES` | edge-construction radius |
| `--min-degree N` | minimum neighbours per node |
| `--heightmap FILE` | enable Tier A terrain |
| `--format text\|json\|map` | output format |
| `--out FILE` | write to a file |
| `--no-cache` | force graph rebuild |

`--unlocked-beacons` matters more than it looks. Measured on the real dataset, routing to Anubis on foot:

| Beacons unlocked | Start beacon | Total |
|---|---|---|
| 152 (all) | Anubis Dunes | **23 s** |
| 6 | Ancient Ritual Site | **3 m 33 s** |
| 6, on Jetragon | Ancient Ritual Site | **42 s** (different route) |

Treating all beacons as unlocked by default would make the tool wrong for most real users.

---

## 6. Output

- **text:** ordered legs with per-leg and cumulative time, start beacon, teleport hops marked with a distinct glyph, colour and `FAST TRAVEL` label, `estimated` legs marked `[est]`, Tier B banner leading the output.
- **json:** full route with node ids, coordinates, per-edge cost, mode, cumulative cost and estimated flags. Byte-identical to the API payload.
- **map:** SVG overlay in map coordinates, designed to be layered over a map image.

⚠️ **Map calibration.** The transform is **fitted by least squares** from correspondences in `expectations.yaml` — never hardcoded. Two models are available: a 3-parameter `swap-similarity` (axis swap + uniform scale + translation, the structure community converters use) and an unconstrained 6-parameter `affine6`.

Verification is **leave-one-out**: fit on N−1 points, measure error on the held-out one. That needs ≥3 correspondences. Only **2** independent published correspondences exist, so **the hold-out cannot currently be performed** — and the tool says exactly that, in the SVG caption, the CLI stderr, the API response body and an `X-Palroute-Transform-Holdout: not-performed` header. The in-sample residual (**0.22 map units**) proves the coordinate *space* is right, which is the mixup this check exists to catch, but it does not demonstrate generalisation. Adding a third calibration point to `expectations.yaml` enables the real check automatically; a test covers that path.

---

## 7. HTTP API

`npm run serve` (default `http://127.0.0.1:6969`). CORS allows any `localhost`/`127.0.0.1` origin, so a frontend dev server can call it directly.

Every response carries a `dataset` block (game version, generation time, POI count) and a `terrain` block (`tier`, `description`, `banner`). **A frontend cannot render a Tier B number as a modelled one without actively ignoring the payload.**

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness |
| `GET /meta` | kinds, biomes, profiles, sources, declared gaps, costs |
| `GET /pois` | filter POIs (`kind`, `biome`, `levelMin/Max`, `search`, `limit`) |
| `GET /pois/:poiId` | single POI |
| `GET /beacons` | every beacon, for building an unlocked set |
| `GET\|POST /nearest` | rank POIs by time-to-reach |
| `GET\|POST /route/:poiId` | full route + start beacon |
| `GET\|POST /tour` | tour solve (`onePer`, `withRoutes`) |
| `GET /map` | SVG overlay (`target=` or tour filters; `format=json` for metadata) |
| `GET /validate` | live validation report |

Query parameters match the CLI flags in camelCase. `unlockedBeacons` accepts a CSV string on GET or a JSON array on POST — a test asserts both produce identical results. Unknown `kind` → `400` with the valid list; unknown `poi_id` → `404`; a map request for an unreachable target → `422` with the reason, because drawing an overlay for a route that does not exist would look like an answer.

```bash
curl 'http://127.0.0.1:6969/nearest?kind=alpha_boss&limit=5&mount=none&unlockedBeacons=fast_travel_ftpoint4,fast_travel_ftpoint31'
```

---

## 8. Modules

```
src/
  datasource/
    scan.ts           # field-signature discovery, no hardcoded table names
    sources.ts        # source registry + community adapters
    pakExport.ts      # FModel/repak importer, class-prefix classification
    fetch.ts          # download, SHA-256, lockfile, integrity verification
    normalize.ts      # raw -> unified schema, layering, deduplication
    validate.ts       # §1.3 report, non-zero exit on failure
  graph/
    layers.ts         # level_id partitioning, synthetic interiors, portal edges
    terrain.ts        # TerrainProvider: Tier A grid + A*, Tier B fallback
    spatial.ts        # uniform spatial hash (no native deps)
    build.ts          # edge construction, teleport clique, components
    cost.ts           # movement profiles, edge weights in seconds
  solve/
    heap.ts           # binary min-heap, lazy deletion
    dijkstra.ts       # multi-source: dist + prev + origin beacon
    tour.ts           # distance matrix, NN + asymmetric-safe 2-opt, GTSP pick
  render/
    text.ts  json.ts  map.ts
  core/
    engine.ts         # shared query engine (CLI and API sit on this)
    cache.ts          # content-keyed graph cache
    config.ts  paths.ts  mapTransform.ts
  api/server.ts       # Fastify + CORS
  cli.ts  index.ts
data/
  pois.json           # generated
  sources.lock.json   # committed: URLs + SHA-256 + row counts
  vendor/             # fetched, gitignored
  expectations.yaml  profiles.yaml
test/                 # 79 tests
```

⚠️ Runtime is Node ≥20.11 / TypeScript, ESM throughout. Dependencies are deliberately minimal — Fastify, commander, yaml, zod. The spatial hash and binary heap are hand-rolled, and the cache is JSON rather than SQLite, so installation needs **no native build toolchain**.

---

## 9. Acceptance criteria

All verified by `npm test` (79 tests) unless noted.

**Data layer**
- [x] `palroute validate` prints per-kind counts, exits 0 on the shipped dataset, non-zero on a corrupted fixture *(asserted by spawning the real CLI and checking exit codes)*
- [x] Every POI carries a `source`; no record has null coordinates or an unknown `kind`
- [x] Dataset keyed to a game version string; mismatch warns loudly
- [x] Scanner finds renamed tables by field signature, and fails loudly with a diagnostic when it cannot

**Graph**
- [x] No walk edge connects two different `level_id`s *(structural: per-layer spatial index)*
- [x] Every dungeon interior is reachable only through its entrance node *(and severing the portal makes it unreachable)*
- [x] No isolated nodes; long fallback edges are flagged
- [x] `map_unlock` points are never teleport endpoints

**Cost & correctness (toy fixtures, not the real map)**
- [x] Teleport must win: beacons 10 m from start and target, 400 m of walking between → solver teleports
- [x] Walking must win: target 100 m away, nearest beacon 2 km off → solver walks
- [x] The flying profile changes the chosen route relative to on-foot — different *leg structure*, not just a different clock
- [x] Restricting `--unlocked-beacons` to a single beacon changes the reported start beacon and increases total time
- [x] Edge weights are seconds, so teleport and walking are directly comparable

**Solver**
- [x] Multi-source run over the full dataset completes in well under 5 s *(700-node synthetic graph; the real 153-effigy tour runs end to end in 1.4 s)*
- [x] 2-opt never returns a tour worse than the nearest-neighbour seed *(25 randomised layouts)*
- [x] Unreachable targets reported explicitly — every target is either visited or reported, asserted by count
- [x] Multi-source equals N single-source runs

**Output**
- [x] Teleport hops visually distinct in text output
- [x] Tier B prints a prominent banner, leading the output
- [x] Map overlay residual reported — and when the hold-out **cannot** be performed, that is stated rather than implied

---

## 10. Explicit non-goals

- No `/game-data`, no RCON, no live server connection, no player entities.
- No modeling of dungeon interior layouts beyond a per-archetype constant.
- No combat/difficulty modeling — `boss_level` is metadata for filtering, not a routing cost.
- No account for respawn timers in tour ordering (future work).

---

## 11. Known limitations

Stated plainly, because each one changes how much to trust a number:

1. **Terrain is not modelled** (Tier B). Real on-foot times will be longer, often much longer. Tier A works but needs an extracted heightmap.
2. **Movement speeds are unverified estimates.** Absolute ETAs are indicative; relative comparisons are sound.
3. **The map transform's generalisation is unverified** — only 2 independent calibration correspondences are published. Add a third to enable the hold-out.
4. **Biome coverage is 22%.** Only boss spawners carry a biome hint; nothing else is guessed.
5. **31% of POIs have no source Z**, so their edges ignore elevation entirely.
6. **`tower_boss` and `palbox` are empty.** Declared gaps, not import failures.
7. **Upstream data is unlicensed.** Fetched, never redistributed here.

## Quick start

```bash
npm install && npm run data:fetch && npm run data:build && npm run validate && npm run serve
```
