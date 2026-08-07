import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Engine, type PoiFilter, type QueryOptions } from '../core/engine.js';
import { DEFAULT_HOST, DEFAULT_PORT, loadExpectations } from '../core/config.js';
import { POI_KINDS, type PoiKind } from '../types.js';
import {
  graphMetaToJson,
  nearestToJson,
  poiToJson,
  routeToJson,
  tourToJson,
  warningsToJson,
} from '../render/json.js';
import { renderMap } from '../render/map.js';
import { fitTransform, holdoutValidate } from '../core/mapTransform.js';

// HTTP API over the shared Engine. Serves JSON only — no HTML, CSS or images.

export interface ServerOptions {
  port?: number;
  host?: string;
  datasetPath?: string;
  heightmapPath?: string;
  /** Origins allowed to call this API beyond localhost. Also read from PALROUTE_CORS_ORIGINS. */
  corsOrigins?: string[];
  /** Requests per window per IP. 0 disables. Also read from PALROUTE_RATE_LIMIT_MAX. */
  rateLimitMax?: number;
  /** Rate-limit window, e.g. '1 minute'. Also read from PALROUTE_RATE_LIMIT_WINDOW. */
  rateLimitWindow?: string;
}

// --- query parsing ---------------------------------------------------------

const CsvKinds = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined))
  .refine(
    (v) => v === undefined || v.every((k) => (POI_KINDS as readonly string[]).includes(k)),
    { message: `kind must be one of: ${POI_KINDS.join(', ')}` },
  )
  .transform((v) => v as PoiKind[] | undefined);

const NumFromString = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : Number(v)))
  .refine((v) => v === undefined || Number.isFinite(v), { message: 'must be a number' });

const IntFromString = NumFromString.transform((v) =>
  v === undefined ? undefined : Math.trunc(v),
);

const BoolFromString = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((v) =>
    v === undefined ? undefined : typeof v === 'boolean' ? v : v === 'true' || v === '1',
  );

/** Beacons arrive as CSV in a query string, or as an array in a JSON body. */
const BeaconList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) =>
    v === undefined ? [] : Array.isArray(v) ? v : v.split(',').map((s) => s.trim()).filter(Boolean),
  );

/** Biomes arrive as CSV on GET or an array in a JSON body. */
const BiomeList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) =>
    v === undefined
      ? undefined
      : (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter((s) => s && s !== 'all'),
  );

const CommonQuery = z.object({
  kind: CsvKinds,
  biome: BiomeList,
  levelMin: IntFromString,
  levelMax: IntFromString,
  search: z.string().optional(),
  // Default is none, not all.
  unlockedBeacons: BeaconList,
  mount: z.string().optional(),
  teleportCost: NumFromString,
  radius: NumFromString,
  minDegree: IntFromString,
  dungeonInteriors: BoolFromString,
  noCache: BoolFromString,
  limit: IntFromString,
});

type CommonQueryInput = z.input<typeof CommonQuery>;
type CommonQueryParsed = z.output<typeof CommonQuery>;

function toFilter(q: CommonQueryParsed): PoiFilter {
  return {
    kinds: q.kind,
    biomes: q.biome,
    levelMin: q.levelMin,
    levelMax: q.levelMax,
    search: q.search,
  };
}

function toQuery(q: CommonQueryParsed): QueryOptions {
  return {
    profile: q.mount,
    radiusMetres: q.radius,
    teleportCostSeconds: q.teleportCost,
    unlockedBeacons: q.unlockedBeacons,
    dungeonInteriors: q.dungeonInteriors,
    minDegree: q.minDegree,
    noCache: q.noCache,
  };
}

/** Merge query string and JSON body so GET and POST behave identically. */
function mergeInput(req: { query: unknown; body?: unknown }): CommonQueryInput {
  const q = (req.query ?? {}) as Record<string, unknown>;
  const b = (req.body ?? {}) as Record<string, unknown>;
  return { ...q, ...b } as CommonQueryInput;
}

// --- server ----------------------------------------------------------------

export async function buildServer(opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      process.env['LOG_LEVEL'] === 'silent'
        ? false
        : { level: process.env['LOG_LEVEL'] ?? 'info' },
  });

  const engine = await Engine.create({
    datasetPath: opts.datasetPath,
    heightmapPath: opts.heightmapPath,
  });

  // Origin allowlist. Localhost is permitted unless disabled.
  const envOrigins = (process.env['PALROUTE_CORS_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowedOrigins = [...(opts.corsOrigins ?? []), ...envOrigins];
  const allowLocalhost = process.env['PALROUTE_CORS_ALLOW_LOCALHOST'] !== 'false';

  await app.register(cors, {
    origin: (origin, cb) => {
      // No Origin header: curl, server-to-server, same-origin.
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (allowLocalhost && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
        return cb(null, true);
      }
      cb(null, false);
    },
    credentials: false,
  });

  if (allowedOrigins.length) {
    app.log.info(`CORS allowlist: ${allowedOrigins.join(', ')}`);
  }

  // Per-IP rate limit, counted in memory. A shared store is needed if replicated.
  const rateMax = opts.rateLimitMax ?? Number(process.env['PALROUTE_RATE_LIMIT_MAX'] ?? 120);
  if (rateMax > 0) {
    await app.register(rateLimit, {
      max: rateMax,
      timeWindow: opts.rateLimitWindow ?? process.env['PALROUTE_RATE_LIMIT_WINDOW'] ?? '1 minute',
      // X-Forwarded-For is only trusted when explicitly enabled.
      keyGenerator: (req) =>
        (process.env['PALROUTE_TRUST_PROXY'] === 'true'
          ? (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
          : undefined) ?? req.ip,
      // statusCode is carried on the object so the error handler can read it.
      errorResponseBuilder: (_req, ctx) => ({
        statusCode: 429,
        error: `Too many requests. Limit is ${ctx.max} per ${ctx.after}.`,
        retry_after_seconds: Math.ceil(ctx.ttl / 1000),
      }),
    });
    app.log.info(`rate limit: ${rateMax} requests per window per IP`);
  }

  // Every response is dynamic, so nothing here is cacheable.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
  });

  // Attaches dataset and terrain metadata to every response.
  const envelope = <T extends object>(payload: T) => ({
    ...payload,
    dataset: {
      game_version: engine.datasetInfo.game_version,
      generated_at: engine.datasetInfo.generated_at,
      poi_count: engine.datasetInfo.poiCount,
    },
    terrain: {
      tier: engine.terrainTier,
      description: engine.terrainDescription,
      banner: engine.terrainBanner,
    },
  });

  const parse = <T extends z.ZodTypeAny>(schema: T, input: unknown) => {
    const r = schema.safeParse(input);
    if (!r.success) {
      const err = new Error(
        r.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; '),
      );
      (err as Error & { statusCode?: number }).statusCode = 400;
      throw err;
    }
    return r.data as z.output<T>;
  };

  // -- discovery ---------------------------------------------------------

  // Exempt from the rate limit — healthchecks and the UI poller hit it on a timer.
  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));

  app.get('/meta', async () =>
    envelope({
      kinds: engine.kinds,
      all_kinds: POI_KINDS,
      biomes: engine.biomes,
      profiles: engine.profilesFile.profiles.map((p) => ({
        name: p.name,
        description: p.description,
        can_fly: p.can_fly,
        v_ground: p.v_ground,
        v_mount: p.v_mount,
        speed_source: p.speed_source,
      })),
      default_profile: engine.profilesFile.default_profile,
      teleport_cost_seconds: engine.profilesFile.teleport_cost_seconds,
      map_open_cost_seconds: engine.profilesFile.map_open_cost_seconds,
      sources: engine.datasetInfo.sources,
      declared_gaps: engine.datasetInfo.declared_gaps,
      // Fitted world->map transform, for clients that project coordinates.
      map_transform: await (async () => {
        try {
          const exp = await loadExpectations();
          const pts = exp.calibration.map((c) => ({
            label: c.label,
            world: c.world,
            map: c.map,
            tolerance: c.tolerance,
          }));
          if (pts.length < 2) return null;
          const fit = fitTransform(pts, 'swap-similarity');
          const holdout = holdoutValidate(pts, 'swap-similarity');
          return {
            model: fit.model,
            params: fit.similarity,
            max_fit_residual: fit.maxFitResidual,
            holdout_performed: holdout.performed,
            holdout_max_residual: holdout.performed ? holdout.maxResidual : null,
          };
        } catch {
          return null;
        }
      })(),
    }),
  );

  // -- POIs --------------------------------------------------------------

  app.get('/pois', async (req) => {
    const q = parse(CommonQuery, mergeInput(req));
    const all = engine.filterPois(toFilter(q));
    const limit = q.limit ?? all.length;
    return envelope({
      total: all.length,
      returned: Math.min(limit, all.length),
      pois: all.slice(0, limit).map(poiToJson),
    });
  });

  app.get<{ Params: { poiId: string } }>('/pois/:poiId', async (req, reply) => {
    const poi = engine.pois.find((p) => p.poi_id === req.params.poiId);
    if (!poi) return reply.code(404).send({ error: `Unknown poi_id "${req.params.poiId}"` });
    return envelope({ poi: poiToJson(poi) });
  });

  app.get('/beacons', async () =>
    envelope({
      beacons: engine
        .filterPois({ kinds: ['fast_travel', 'palbox'] })
        .map(poiToJson),
    }),
  );

  // -- routing -----------------------------------------------------------

  const nearestHandler = async (req: { query: unknown; body?: unknown }) => {
    const q = parse(CommonQuery, mergeInput(req));
    const filter = toFilter(q);
    const { graph, reachable, unreachable, warnings } = await engine.nearest(
      filter,
      toQuery(q),
      q.limit ?? 10,
    );
    return envelope({
      ...nearestToJson(reachable, unreachable, graph, warnings),
      filter_diagnosis: engine.diagnoseEmptyFilter(filter),
    });
  };
  app.get('/nearest', nearestHandler);
  app.post('/nearest', nearestHandler);

  const routeHandler = async (
    req: { params: { poiId: string }; query: unknown; body?: unknown },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    const q = parse(CommonQuery, mergeInput(req));
    try {
      const { graph, route, warnings } = await engine.routeTo(req.params.poiId, toQuery(q));
      return envelope({
        route: routeToJson(route),
        reachable: route !== null,
        graph: graphMetaToJson(graph),
        warnings: warningsToJson(warnings),
      });
    } catch (err) {
      return reply.code(404).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  app.get<{ Params: { poiId: string } }>('/route/:poiId', routeHandler);
  app.post<{ Params: { poiId: string } }>('/route/:poiId', routeHandler);

  const TourQuery = CommonQuery.extend({
    onePer: z.enum(['class_id', 'kind']).optional(),
    withRoutes: BoolFromString,
  });

  const tourHandler = async (req: { query: unknown; body?: unknown }) => {
    const q = parse(TourQuery, mergeInput(req));
    const filter = toFilter(q);
    const { graph, result, warnings, selectionMethod, groupCount } = await engine.tour(
      filter,
      toQuery(q),
      { onePer: q.onePer, withRoutes: q.withRoutes ?? false },
    );
    return envelope({
      ...tourToJson(result, graph, warnings, { selectionMethod, groupCount }),
      filter_diagnosis: engine.diagnoseEmptyFilter(filter),
    });
  };
  app.get('/tour', tourHandler);
  app.post('/tour', tourHandler);

  // -- map overlay -------------------------------------------------------

  const MapQuery = TourQuery.extend({
    target: z.string().optional(),
    format: z.enum(['svg', 'json']).optional(),
  });

  app.get('/map', async (req, reply) => {
    const q = parse(MapQuery, mergeInput(req));
    const exp = await loadExpectations();

    let rendered;
    if (q.target) {
      const { route } = await engine.routeTo(q.target, toQuery(q));
      if (!route) {
        // No route to draw.
        return reply.code(422).send({
          error:
            `No route to "${q.target}" from the supplied beacons, so there is ` +
            `nothing to draw. Pass unlockedBeacons to model your save.`,
          target: q.target,
          unlocked_beacon_count: (q.unlockedBeacons ?? []).length,
        });
      }
      rendered = renderMap({ route }, exp);
    } else {
      const { result } = await engine.tour(toFilter(q), toQuery(q), {
        onePer: q.onePer,
        withRoutes: true,
      });
      rendered = renderMap({ tour: result }, exp);
    }

    if (q.format === 'json') {
      return envelope({ svg: rendered.svg, transform: rendered.transform, bounds: rendered.bounds });
    }
    // Residuals are repeated in headers for `<img>` consumers.
    reply.header('Content-Type', 'image/svg+xml; charset=utf-8');
    reply.header('X-Palroute-Transform-Residual', String(rendered.transform.max_fit_residual));
    reply.header(
      'X-Palroute-Transform-Holdout',
      rendered.transform.holdout.performed
        ? String(rendered.transform.holdout.max_residual)
        : 'not-performed',
    );
    return reply.send(rendered.svg);
  });

  // -- validation --------------------------------------------------------

  app.get('/validate', async () => {
    const { validateDataset } = await import('../datasource/validate.js');
    const { readDataset } = await import('../datasource/normalize.js');
    const { POIS_PATH } = await import('../core/paths.js');
    const dataset = await readDataset(opts.datasetPath ?? POIS_PATH);
    const exp = await loadExpectations();
    return envelope({ report: validateDataset(dataset, exp) });
  });

  // Handles plain objects as well as Errors; plugins throw both.
  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = (err ?? {}) as {
      statusCode?: number;
      message?: string;
      error?: string;
      retry_after_seconds?: number;
    };
    const status = e.statusCode ?? 500;
    const message =
      err instanceof Error ? err.message : (e.error ?? e.message ?? String(err));

    const body: Record<string, unknown> = { error: message };
    if (e.retry_after_seconds !== undefined) {
      body['retry_after_seconds'] = e.retry_after_seconds;
    }
    reply.code(status).send(body);
  });

  return app;
}

export async function startServer(opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = await buildServer(opts);
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;
  try {
    await app.listen({ port, host });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      process.stderr.write(
        `\nPort ${port} is already in use — PalRoute is probably already running.\n` +
          `Open http://${host}:${port} , or stop the other process first.\n\n`,
      );
      process.exit(1);
    }
    throw err;
  }

  process.stdout.write(
    `\n  PalRoute API  ->  http://${host}:${port}\n` +
      `  JSON only. The UI is a separate artefact — see frontend/README.md\n\n`,
  );
  return app;
}

// Direct execution: `node dist/api/server.js` or `tsx src/api/server.ts`.
const invokedDirectly =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));

if (invokedDirectly) {
  startServer({
    port: process.env['PORT'] ? parseInt(process.env['PORT'], 10) : DEFAULT_PORT,
    host: process.env['HOST'] ?? DEFAULT_HOST,
  }).catch((err: unknown) => {
    process.stderr.write(`failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
