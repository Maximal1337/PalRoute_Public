import fs from 'node:fs/promises';
import type { Dataset, Graph, Poi, PoiKind, ProfilesFile, Route, TourResult } from '../types.js';
import { POI_KINDS } from '../types.js';
import { buildGraph, connectedComponents, isolatedNodes } from '../graph/build.js';
import { resolveTerrain, type TerrainProvider } from '../graph/terrain.js';
import {
  beaconSources,
  multiSourceDijkstra,
  rankNearest,
  reconstructRoute,
  type DijkstraResult,
  type NearestResult,
} from '../solve/dijkstra.js';
import { selectOnePerGroup, solveTour } from '../solve/tour.js';
import { readDataset } from '../datasource/normalize.js';
import { cacheKey, fingerprintPois, readGraphCache, writeGraphCache } from './cache.js';
import { loadProfiles } from './config.js';
import { POIS_PATH } from './paths.js';

// Shared query engine used by both the CLI and the HTTP API.

export interface EngineOptions {
  datasetPath?: string;
  profilesPath?: string;
  heightmapPath?: string;
}

export interface QueryOptions {
  profile?: string;
  radiusMetres?: number;
  teleportCostSeconds?: number;
  /** Default is none, not all. */
  unlockedBeacons?: string[];
  dungeonInteriors?: boolean;
  minDegree?: number;
  noCache?: boolean;
}

/** Sentinel biome value matching POIs that carry no biome at all. */
export const BIOME_NONE = '(none)';

export interface PoiFilter {
  kinds?: PoiKind[];
  /** Biomes to keep; empty means no filtering. `BIOME_NONE` selects POIs with no biome. */
  biomes?: string[];
  /** Inclusive boss-level range. */
  levelMin?: number;
  levelMax?: number;
  /** Substring match on name or poi_id. */
  search?: string;
  levelId?: string;
}

export interface EngineWarning {
  code: string;
  message: string;
}

export class Engine {
  private dataset!: Dataset;
  private profiles!: ProfilesFile;
  private terrain!: TerrainProvider;
  private terrainNote = '';
  private readonly graphs = new Map<string, Graph>();

  private constructor(private readonly opts: EngineOptions) {}

  static async create(opts: EngineOptions = {}): Promise<Engine> {
    const e = new Engine(opts);
    await e.init();
    return e;
  }

  private async init(): Promise<void> {
    const datasetPath = this.opts.datasetPath ?? POIS_PATH;
    try {
      await fs.access(datasetPath);
    } catch {
      throw new Error(
        `Dataset not found at ${datasetPath}.\n` +
          `Build it first:\n  npm run data:fetch\n  npm run data:build`,
      );
    }
    this.dataset = await readDataset(datasetPath);
    this.profiles = await loadProfiles(this.opts.profilesPath);
    const t = await resolveTerrain(this.opts.heightmapPath);
    this.terrain = t.provider;
    this.terrainNote = t.note;
  }

  get datasetInfo(): Omit<Dataset, 'pois'> & { poiCount: number } {
    const { pois, ...rest } = this.dataset;
    return { ...rest, poiCount: pois.length };
  }

  get pois(): Poi[] {
    return this.dataset.pois;
  }

  get profilesFile(): ProfilesFile {
    return this.profiles;
  }

  get terrainDescription(): string {
    return this.terrainNote;
  }

  get terrainTier(): 'A' | 'B' {
    return this.terrain.tier;
  }

  /** Banner text when terrain is not modelled. */
  get terrainBanner(): string | null {
    if (this.terrain.tier === 'A') return null;
    return (
      'TERRAIN NOT MODELLED (Tier B). Distances are straight lines with a Z ' +
      'penalty. Cliffs, water and island separation are ignored, so real travel ' +
      'times will be longer — often much longer on foot.'
    );
  }

  filterPois(f: PoiFilter = {}): Poi[] {
    const search = f.search?.toLowerCase();
    const biomes = f.biomes?.filter((b) => b && b !== 'all');
    return this.dataset.pois.filter((p) => {
      if (f.kinds?.length && !f.kinds.includes(p.kind)) return false;
      if (biomes?.length) {
        const ok =
          p.biome === null ? biomes.includes(BIOME_NONE) : biomes.includes(p.biome);
        if (!ok) return false;
      }
      if (f.levelId && p.level_id !== f.levelId) return false;
      if (f.levelMin !== undefined && (p.boss_level ?? -Infinity) < f.levelMin) return false;
      if (f.levelMax !== undefined && (p.boss_level ?? Infinity) > f.levelMax) return false;
      if (search && !`${p.name} ${p.poi_id}`.toLowerCase().includes(search)) return false;
      return true;
    });
  }

  /** Name the filter responsible for an empty result, by re-counting with each one dropped. */
  diagnoseEmptyFilter(f: PoiFilter): string | null {
    if (this.filterPois(f).length > 0) return null;

    const drops: { label: string; without: PoiFilter }[] = [];
    if (f.kinds?.length) drops.push({ label: 'kind', without: { ...f, kinds: undefined } });
    if (f.biomes?.length) drops.push({ label: 'biome', without: { ...f, biomes: undefined } });
    if (f.levelMin !== undefined || f.levelMax !== undefined) {
      drops.push({ label: 'level range', without: { ...f, levelMin: undefined, levelMax: undefined } });
    }
    if (f.search) drops.push({ label: 'search', without: { ...f, search: undefined } });

    const culprits = drops
      .map((d) => ({ ...d, n: this.filterPois(d.without).length }))
      .filter((d) => d.n > 0);

    if (culprits.length === 0) {
      return 'No POI matches these filters, and relaxing any single one still finds nothing.';
    }

    const best = culprits.sort((a, b) => b.n - a.n)[0]!;

    // No selected kind carries a biome at all.
    if (best.label === 'biome' && f.kinds?.length) {
      const kindsWithBiome = this.dataset.pois.filter(
        (p) => f.kinds!.includes(p.kind) && p.biome !== null,
      ).length;
      if (kindsWithBiome === 0) {
        return (
          `No match: none of the selected kinds carry a biome, so any biome ` +
          `filter excludes all of them. Only boss spawners have biome data — ` +
          `effigies, dungeon entrances and predators have none. Clear the biome ` +
          `filter, or select "${BIOME_NONE}" to target exactly those.`
        );
      }
    }

    return (
      `No match. The ${best.label} filter is the limiting one — dropping it ` +
      `finds ${best.n} POI${best.n === 1 ? '' : 's'}.`
    );
  }

  /** Build (or fetch from cache) the graph for a set of query options. */
  async graphFor(q: QueryOptions = {}): Promise<Graph> {
    const profileName = q.profile ?? this.profiles.default_profile;
    const radiusMetres = q.radiusMetres ?? 500;
    const teleportCost = q.teleportCostSeconds ?? this.profiles.teleport_cost_seconds;
    const unlocked = q.unlockedBeacons ?? [];
    const dungeonInteriors = q.dungeonInteriors !== false;
    const minDegree = q.minDegree ?? 3;

    const key = cacheKey({
      datasetFingerprint: fingerprintPois(this.dataset.pois, this.dataset.game_version),
      profile: profileName,
      radiusMetres,
      teleportCost,
      terrainTier: this.terrain.tier,
      unlockedBeacons: unlocked,
      dungeonInteriors,
      minDegree,
    });

    const memo = this.graphs.get(key);
    if (memo && !q.noCache) return memo;

    if (!q.noCache) {
      const disk = await readGraphCache(key);
      if (disk) {
        this.graphs.set(key, disk);
        return disk;
      }
    }

    const graph = buildGraph({
      pois: this.dataset.pois,
      profiles: this.profiles,
      profileName,
      terrain: this.terrain,
      radiusMetres,
      teleportCostSeconds: teleportCost,
      unlockedBeacons: unlocked,
      dungeonInteriors,
      minDegree,
    });

    this.graphs.set(key, graph);
    if (!q.noCache) await writeGraphCache(key, graph);
    return graph;
  }

  /** Warnings that accompany any answer: empty beacon set, terrain tier, unresolved ids. */
  warningsFor(graph: Graph, q: QueryOptions): EngineWarning[] {
    const out: EngineWarning[] = [];
    if (this.terrainBanner) out.push({ code: 'terrain_tier_b', message: this.terrainBanner });

    if ((q.unlockedBeacons ?? []).length === 0) {
      out.push({
        code: 'no_unlocked_beacons',
        message:
          'No unlocked beacons supplied, so fast travel is unavailable and every ' +
          'route is computed on foot from the target itself. Pass --unlocked-beacons ' +
          '(CLI) or unlockedBeacons (API) to model your actual save.',
      });
    }

    const unknown = (q.unlockedBeacons ?? []).filter((id) => !graph.index.has(id));
    if (unknown.length) {
      out.push({
        code: 'unknown_beacons',
        message: `${unknown.length} unlocked-beacon id(s) not found in the dataset: ${unknown.slice(0, 5).join(', ')}`,
      });
    }

    const isolated = isolatedNodes(graph);
    if (isolated.length) {
      out.push({
        code: 'isolated_nodes',
        message: `${isolated.length} node(s) have no edges — MIN_DEGREE fallback failed to connect them.`,
      });
    }

    if (graph.meta.longFallbackEdges > 0) {
      out.push({
        code: 'long_fallback_edges',
        message:
          `${graph.meta.longFallbackEdges} edge(s) exceed the ${graph.meta.radiusMetres} m ` +
          `construction radius and were added to keep the graph connected. They may ` +
          `cross water or terrain that does not exist as a real route.`,
      });
    }

    // Components with no unlocked beacon are unreachable.
    const comps = connectedComponents(graph);
    if (comps.length > 1) {
      const unlocked = new Set(graph.meta.unlockedBeacons);
      const stranded = comps.filter(
        (c) => !c.some((i) => unlocked.has(graph.nodes[i]!.poi_id)),
      );
      const strandedNodes = stranded.reduce((n, c) => n + c.length, 0);
      if (strandedNodes > 0) {
        out.push({
          code: 'unreachable_components',
          message:
            `The map splits into ${comps.length} disconnected component(s) — separate ` +
            `landmasses with no walkable link. ${stranded.length} of them contain no ` +
            `unlocked beacon, putting ${strandedNodes} POI(s) out of reach entirely. ` +
            `Unlock a beacon on those landmasses to route to them.`,
        });
      }
    }

    return out;
  }

  /** Frontier from every unlocked beacon — one run answers every POI. */
  async frontier(q: QueryOptions = {}): Promise<{ graph: Graph; result: DijkstraResult }> {
    const graph = await this.graphFor(q);
    const sources = beaconSources(graph, this.profiles.map_open_cost_seconds);

    // With no beacons there are no sources and every distance stays Infinity.
    const result = multiSourceDijkstra(graph, sources);
    return { graph, result };
  }

  async nearest(
    filter: PoiFilter,
    q: QueryOptions = {},
    limit = 10,
  ): Promise<{
    graph: Graph;
    reachable: NearestResult[];
    unreachable: Poi[];
    warnings: EngineWarning[];
  }> {
    const { graph, result } = await this.frontier(q);
    const candidates = this.filterPois(filter)
      .map((p) => graph.index.get(p.poi_id))
      .filter((i): i is number => i !== undefined);
    const ranked = rankNearest(graph, result, candidates, limit);
    return { graph, ...ranked, warnings: this.warningsFor(graph, q) };
  }

  async routeTo(
    poiId: string,
    q: QueryOptions = {},
  ): Promise<{ graph: Graph; route: Route | null; warnings: EngineWarning[] }> {
    const { graph, result } = await this.frontier(q);
    const idx = graph.index.get(poiId);
    if (idx === undefined) {
      throw new Error(`Unknown poi_id "${poiId}".`);
    }
    const route = reconstructRoute(graph, result, idx);
    return { graph, route, warnings: this.warningsFor(graph, q) };
  }

  async tour(
    filter: PoiFilter,
    q: QueryOptions = {},
    opts: { onePer?: 'class_id' | 'kind'; withRoutes?: boolean } = {},
  ): Promise<{
    graph: Graph;
    result: TourResult;
    warnings: EngineWarning[];
    selectionMethod?: string;
    groupCount?: number;
  }> {
    const graph = await this.graphFor(q);
    let targets = this.filterPois(filter)
      .map((p) => graph.index.get(p.poi_id))
      .filter((i): i is number => i !== undefined);

    let selectionMethod: string | undefined;
    let groupCount: number | undefined;

    if (opts.onePer) {
      const sel = selectOnePerGroup(
        graph,
        targets,
        opts.onePer,
        this.profiles.map_open_cost_seconds,
      );
      targets = sel.chosen;
      selectionMethod = sel.method;
      groupCount = sel.groups.size;
    }

    const result = solveTour({
      graph,
      targets,
      mapOpenCost: this.profiles.map_open_cost_seconds,
      withRoutes: opts.withRoutes,
    });

    return {
      graph,
      result,
      warnings: this.warningsFor(graph, q),
      selectionMethod,
      groupCount,
    };
  }

  /** Distinct biomes present, for API discovery. */
  get biomes(): string[] {
    return [...new Set(this.dataset.pois.map((p) => p.biome).filter((b): b is string => b !== null))].sort();
  }

  get kinds(): string[] {
    const present = new Set(this.dataset.pois.map((p) => p.kind));
    return POI_KINDS.filter((k) => present.has(k));
  }
}
