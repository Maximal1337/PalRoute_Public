// Canvas map renderer. Markers are projected from world coordinates over an
// optional base image. Draw order: routes under markers, beacons last.
import { BASE_MAP } from './basemap.js';
import { kindColor, kindRadius, kindZ, modeColor, ui } from './palette.js';
import { boundsOf, Projection } from './projection.js';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 60;
const HIT_RADIUS = 11; // screen px

/** Read on each call, so an OS setting change applies without a reload. */
const reducedMotionQuery =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
function prefersReducedMotion() {
  return reducedMotionQuery?.matches ?? false;
}

export class MapView {
  constructor(canvas, { onSelect, onHover } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.projection = new Projection(null);

    this.pois = [];
    this.poiById = new Map();
    this.visible = [];
    this.hiddenKinds = new Set();
    this.route = null;      // { legs: [...] }
    this.tourStops = [];    // ordered POIs
    this.selectedId = null;
    this.hoveredId = null;
    this.startBeaconId = null;
    this.unlockedBeacons = new Set();
    /** Beacons the current answer actually teleports through. */
    this.usedBeacons = new Set();
    this.baseImage = null;
    this.baseImageOpacity = 0.92;
    this.showLabels = false;
    // Off by default when a base image is present.
    this.showGrid = false;
    this.showOffMap = true;
    this.showUnmatched = true;
    this.matchedIds = null;  // Set of ids matching current filters, or null

    this.view = { cx: 0, cy: 0, zoom: 1 };
    this.onSelect = onSelect ?? (() => {});
    this.onHover = onHover ?? (() => {});

    this._pointers = new Map();
    this._pinchDist = 0;
    this._raf = 0;
    this._dragMoved = false;

    this._bindEvents();
    this._observeResize();
  }

  // ---------------------------------------------------------------- data

  setProjectionTransform(transform) {
    this.projection.setTransform(transform);
    this.requestDraw();
  }

  setPois(pois) {
    // Sorted once, so drawing is a straight walk.
    this.pois = [...pois].sort((a, b) => kindZ(b.kind) - kindZ(a.kind));
    this.poiById = new Map(this.pois.map((p) => [p.poi_id, p]));
    this._recomputeVisible();
    this.requestDraw();
  }

  setMatched(ids) {
    this.matchedIds = ids ? new Set(ids) : null;
    this._recomputeVisible();
    this.requestDraw();
  }

  setRoute(route) {
    this.route = route;
    this.startBeaconId = route?.start_beacon?.poi_id ?? null;
    this.tourStops = [];
    this.requestDraw();
  }

  setTour(tour) {
    this.tourStops = tour?.stops?.map((s) => s.poi) ?? [];
    this.route = tour?.routes?.length
      ? { legs: tour.routes.flatMap((r) => r?.legs ?? []) }
      : null;
    this.startBeaconId = tour?.start_beacon?.poi_id ?? null;
    this.requestDraw();
  }

  clearRoutes() {
    this.route = null;
    this.tourStops = [];
    this.startBeaconId = null;
    this.usedBeacons = new Set();
    this.requestDraw();
  }

  setUnlockedBeacons(ids) {
    this.unlockedBeacons = new Set(ids);
    this.requestDraw();
  }

  /** Beacons the current answer teleports through. */
  setUsedBeacons(ids) {
    // Ids that are not beacons are rejected.
    const set = new Set();
    for (const id of ids ?? []) {
      const kind = this.poiById?.get(id)?.kind;
      if (kind === 'fast_travel' || kind === 'palbox') set.add(id);
    }
    this.usedBeacons = set;
    this.requestDraw();
  }

  setSelected(id) {
    const changed = this.selectedId !== id;
    this.selectedId = id;
    if (changed) this._updateSelectionAnimation();
    this.requestDraw();
  }

  /**
   * Run a continuous redraw only while something is selected. The map is
   * otherwise drawn on demand.
   */
  _updateSelectionAnimation() {
    const wants = this.selectedId !== null && !prefersReducedMotion();
    if (wants && !this._animRaf) {
      const tick = () => {
        if (this.selectedId === null || prefersReducedMotion()) {
          this._animRaf = 0;
          return;
        }
        this._animRaf = requestAnimationFrame(tick);
        this.draw();
      };
      this._animRaf = requestAnimationFrame(tick);
    } else if (!wants && this._animRaf) {
      cancelAnimationFrame(this._animRaf);
      this._animRaf = 0;
      this.requestDraw();
    }
  }

  /**
   * Marker for the selected POI: a rotating dashed ring and an outward ping.
   * Falls back to a static ring under prefers-reduced-motion.
   */
  _drawSelectionRing(ctx, s, r) {
    const R = r + 9;
    if (prefersReducedMotion()) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(s.x, s.y, R, 0, Math.PI * 2);
      ctx.strokeStyle = ui.accent;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.restore();
      return;
    }

    const t = performance.now() / 1000;

    // Outward ping, fading as it grows.
    const phase = (t % 1.6) / 1.6;
    ctx.save();
    ctx.beginPath();
    ctx.arc(s.x, s.y, R + phase * 16, 0, Math.PI * 2);
    ctx.strokeStyle = ui.accent;
    ctx.globalAlpha = 0.5 * (1 - phase);
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Rotating the context spins the dash pattern with the path.
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(t * 1.1);
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.strokeStyle = ui.accent;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([7, 7]);
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }

  toggleKind(kind, off) {
    if (off) this.hiddenKinds.add(kind);
    else this.hiddenKinds.delete(kind);
    this._recomputeVisible();
    this.requestDraw();
  }

  setOption(key, value) {
    if (key === 'labels') this.showLabels = value;
    if (key === 'grid') this.showGrid = value;
    if (key === 'offmap') { this.showOffMap = value; this._recomputeVisible(); }
    if (key === 'unmatched') { this.showUnmatched = value; this._recomputeVisible(); }
    this.requestDraw();
  }

  /** True when this POI projects outside the base image. */
  _isOffMap(poi) {
    if (!this.baseImage) return false;
    const w = this.baseImage.naturalWidth || BASE_MAP.width;
    const h = this.baseImage.naturalHeight || BASE_MAP.height;
    const m = this.projection.worldToMap(poi.world.x, poi.world.y);
    return m.x < 0 || m.y < 0 || m.x > w || m.y > h;
  }

  /** Number of POIs projecting outside the base image. */
  offMapCount() {
    if (!this.baseImage) return 0;
    return this.pois.reduce((n, p) => n + (this._isOffMap(p) ? 1 : 0), 0);
  }

  setBaseImage(img) {
    const had = this.baseImage !== null;
    this.baseImage = img;
    // Reframe on first image, unless the user has already panned or zoomed.
    if (img && !had) this._refitIfUntouched();
    this.requestDraw();
  }

  setBaseImageOpacity(v) {
    this.baseImageOpacity = Math.min(Math.max(v, 0), 1);
    this.requestDraw();
  }

  _recomputeVisible() {
    this.visible = this.pois.filter((p) => {
      if (this.hiddenKinds.has(p.kind)) return false;
      if (!this.showUnmatched && this.matchedIds && !this.matchedIds.has(p.poi_id)) return false;
      if (!this.showOffMap && this._isOffMap(p)) return false;
      return true;
    });
  }

  // ---------------------------------------------------------------- view

  get size() {
    return { w: this.canvas.clientWidth || 1, h: this.canvas.clientHeight || 1 };
  }

  toScreen(mx, my) {
    const { w, h } = this.size;
    const { cx, cy, zoom } = this.view;
    return { x: (mx - cx) * zoom + w / 2, y: (my - cy) * zoom + h / 2 };
  }

  toMapSpace(sx, sy) {
    const { w, h } = this.size;
    const { cx, cy, zoom } = this.view;
    return { x: (sx - w / 2) / zoom + cx, y: (sy - h / 2) / zoom + cy };
  }

  projectPoi(p) {
    const m = this.projection.worldToMap(p.world.x, p.world.y);
    return this.toScreen(m.x, m.y);
  }

  /** Frame the base image rather than the POI extent. */
  fitBaseMap(padding = 24) {
    if (!this.baseImage) return false;
    const w = this.baseImage.naturalWidth || BASE_MAP.width;
    const h = this.baseImage.naturalHeight || BASE_MAP.height;
    const { w: vw, h: vh } = this.size;
    this.view.zoom = Math.min(
      Math.max(Math.min((vw - padding * 2) / w, (vh - padding * 2) / h), MIN_ZOOM),
      MAX_ZOOM,
    );
    this.view.cx = w / 2;
    this.view.cy = h / 2;
    this.requestDraw();
    return true;
  }

  fit(pois = this.visible.length ? this.visible : this.pois, padding = 60) {
    // The default view frames the base image.
    if (pois === this.visible || pois === this.pois) {
      if (this.fitBaseMap()) return;
    }
    if (!pois.length) return;
    const b = boundsOf(pois, this.projection);
    const { w, h } = this.size;
    const bw = Math.max(b.maxX - b.minX, 1e-6);
    const bh = Math.max(b.maxY - b.minY, 1e-6);
    const zoom = Math.min((w - padding * 2) / bw, (h - padding * 2) / bh);
    this.view.zoom = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
    this.view.cx = (b.minX + b.maxX) / 2;
    this.view.cy = (b.minY + b.maxY) / 2;
    this.requestDraw();
  }

  zoomBy(factor, anchor) {
    this._userAdjusted = true;
    const { w, h } = this.size;
    const ax = anchor?.x ?? w / 2;
    const ay = anchor?.y ?? h / 2;
    const before = this.toMapSpace(ax, ay);
    const next = Math.min(Math.max(this.view.zoom * factor, MIN_ZOOM), MAX_ZOOM);
    if (next === this.view.zoom) return;
    this.view.zoom = next;
    const after = this.toMapSpace(ax, ay);
    // Keeps the point under the cursor fixed while zooming.
    this.view.cx += before.x - after.x;
    this.view.cy += before.y - after.y;
    this.requestDraw();
  }

  panBy(dxScreen, dyScreen) {
    this._userAdjusted = true;
    this.view.cx -= dxScreen / this.view.zoom;
    this.view.cy -= dyScreen / this.view.zoom;
    this.requestDraw();
  }

  focusOn(poi, { zoom } = {}) {
    this._userAdjusted = true;
    const m = this.projection.worldToMap(poi.world.x, poi.world.y);
    this.view.cx = m.x;
    this.view.cy = m.y;
    if (zoom) this.view.zoom = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
    this.requestDraw();
  }

  /** Frame a set of POIs. */
  frame(pois, padding = 90) {
    if (!pois?.length) return;
    if (pois.length === 1) return this.focusOn(pois[0], { zoom: Math.max(this.view.zoom, 1.5) });
    this.fit(pois, padding);
  }

  // ------------------------------------------------------------- events

  _bindEvents() {
    const c = this.canvas;

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this._pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      this._dragMoved = false;
      if (this._pointers.size === 1) c.dataset.dragging = 'true';
    });

    c.addEventListener('pointermove', (e) => {
      const prev = this._pointers.get(e.pointerId);

      if (!prev) {
        this._updateHover(e.offsetX, e.offsetY);
        return;
      }

      const cur = { x: e.offsetX, y: e.offsetY };
      this._pointers.set(e.pointerId, cur);

      if (this._pointers.size === 2) {
        const [a, b] = [...this._pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (this._pinchDist > 0) {
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          this.zoomBy(dist / this._pinchDist, mid);
        }
        this._pinchDist = dist;
        this._dragMoved = true;
        return;
      }

      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) this._dragMoved = true;
      this.panBy(dx, dy);
    });

    const endPointer = (e) => {
      const had = this._pointers.delete(e.pointerId);
      if (this._pointers.size < 2) this._pinchDist = 0;
      if (this._pointers.size === 0) {
        c.dataset.dragging = 'false';
        // A press that did not become a drag counts as a click.
        if (had && !this._dragMoved) {
          const hit = this._hitTest(e.offsetX, e.offsetY);
          this.onSelect(hit ?? null);
        }
      }
    };
    c.addEventListener('pointerup', endPointer);
    c.addEventListener('pointercancel', endPointer);
    c.addEventListener('pointerleave', () => {
      this.hoveredId = null;
      this.canvas.dataset.hovering = 'false';
      this.onHover(null, null);
      this.requestDraw();
    });

    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        // Normalised, since trackpads report much smaller deltas than wheels.
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0016));
        this.zoomBy(factor, { x: e.offsetX, y: e.offsetY });
      },
      { passive: false },
    );

    c.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.zoomBy(1.8, { x: e.offsetX, y: e.offsetY });
    });
  }

  _observeResize() {
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(this.canvas.parentElement ?? this.canvas);
    this._resize();
  }

  _dpr() {
    return Math.min(window.devicePixelRatio || 1, 2.5);
  }

  /**
   * Single handler for a size change, whichever source detected it.
   */
  _resize() {
    if (this._syncBackingSize()) this._refitIfUntouched();
    this.requestDraw();
  }

  _refitIfUntouched() {
    if (this._userAdjusted) return;
    if (!this.pois.length && !this.baseImage) return;
    this.fit();
  }

  /**
   * Re-syncs the canvas backing store to the element size and device ratio.
   * Called every frame, since layout may not have run at construction time.
   */
  _syncBackingSize() {
    const dpr = this._dpr();
    const { w, h } = this.size;
    const wantW = Math.round(w * dpr);
    const wantH = Math.round(h * dpr);
    if (this.canvas.width === wantW && this.canvas.height === wantH) return false;
    this.canvas.width = wantW;
    this.canvas.height = wantH;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  _updateHover(sx, sy) {
    const hit = this._hitTest(sx, sy);
    const id = hit?.poi_id ?? null;
    this.canvas.dataset.hovering = hit ? 'true' : 'false';
    if (id !== this.hoveredId) {
      this.hoveredId = id;
      this.onHover(hit, hit ? { x: sx, y: sy } : null);
      this.requestDraw();
    } else if (hit) {
      this.onHover(hit, { x: sx, y: sy });
    }
  }

  _hitTest(sx, sy) {
    let best = null;
    let bestD = HIT_RADIUS * HIT_RADIUS;
    // Reverse draw order, so the topmost marker is picked first.
    for (let i = this.visible.length - 1; i >= 0; i--) {
      const p = this.visible[i];
      const s = this.projectPoi(p);
      const dx = s.x - sx;
      const dy = s.y - sy;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // -------------------------------------------------------------- render

  requestDraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.draw();
    });
  }

  /**
   * POIs projecting outside the base image, grouped into labelled frames.
   * The World Tree is a separate in-game map with its own coordinate space.
   */
  _offMapGroups() {
    if (!this.baseImage) return [];
    const w = this.baseImage.naturalWidth || BASE_MAP.width;
    const h = this.baseImage.naturalHeight || BASE_MAP.height;
    const outside = [];
    for (const p of this.visible) {
      const m = this.projection.worldToMap(p.world.x, p.world.y);
      if (m.x < 0 || m.y < 0 || m.x > w || m.y > h) outside.push({ p, m });
    }
    if (outside.length < 3) return [];

    // Region name from a token shared across the ids, after the kind prefix.
    const tokens = new Map();
    for (const { p } of outside) {
      const rest = p.poi_id.startsWith(`${p.kind}_`)
        ? p.poi_id.slice(p.kind.length + 1)
        : p.poi_id;
      for (const seg of rest.split('_')) {
        if (seg.length < 5) continue;
        if (/^\d+$/.test(seg) || /^[0-9a-f]{8,}$/i.test(seg)) continue;
        tokens.set(seg, (tokens.get(seg) ?? 0) + 1);
      }
    }
    const top = [...tokens.entries()].sort((a, b) => b[1] - a[1])[0];
    // A token must cover a quarter of the group to name it.
    const label =
      top && top[1] >= outside.length * 0.25
        ? top[0]
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/(tree|island|land)$/i, ' $1')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b\w/g, (c) => c.toUpperCase())
        : 'Off-map';

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { m } of outside) {
      if (m.x < minX) minX = m.x;
      if (m.y < minY) minY = m.y;
      if (m.x > maxX) maxX = m.x;
      if (m.y > maxY) maxY = m.y;
    }
    return [{ label, count: outside.length, minX, minY, maxX, maxY }];
  }

  _drawOffMapFrames(ctx) {
    for (const g of this._offMapGroups()) {
      const pad = 26;
      const tl = this.toScreen(g.minX - pad, g.minY - pad);
      const br = this.toScreen(g.maxX + pad, g.maxY + pad);
      const w = br.x - tl.x;
      const h = br.y - tl.y;
      if (w < 8 || h < 8) continue;

      ctx.save();
      ctx.fillStyle = 'rgba(110,168,254,.05)';
      ctx.strokeStyle = 'rgba(110,168,254,.38)';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([7, 5]);
      const r = Math.min(10, w / 4, h / 4);
      ctx.beginPath();
      ctx.roundRect(tl.x, tl.y, w, h, r);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);

      const fs = Math.max(10, Math.min(13, h / 14));
      ctx.font = `600 ${fs}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(160,200,255,.9)';
      ctx.fillText(`${g.label} — separate map (${g.count})`, tl.x + 2, tl.y - 5);
      ctx.restore();
    }
  }

  draw() {
    const resized = this._syncBackingSize();
    const ctx = this.ctx;
    const { w, h } = this.size;
    ctx.clearRect(0, 0, w, h);

    // Refit on every resize until the user pans or zooms.
    if (resized) this._refitIfUntouched();

    if (this.baseImage) this._drawBaseImage(ctx);
    if (this.showGrid) this._drawGrid(ctx, w, h);
    // Drawn behind the routes.
    if (this.showOffMap) this._drawOffMapFrames(ctx);
    this._drawRoute(ctx);
    this._drawMarkers(ctx);
    this._drawTourOrder(ctx);
  }

  /**
   * Draws the base image at its own extent in map space. The projection emits
   * image pixels, so only the view transform is applied.
   */
  _drawBaseImage(ctx) {
    const img = this.baseImage;
    const w = img.naturalWidth || BASE_MAP.width;
    const h = img.naturalHeight || BASE_MAP.height;
    const tl = this.toScreen(0, 0);
    const br = this.toScreen(w, h);

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // Muted so markers and routes stay legible over it.
    ctx.globalAlpha = this.baseImageOpacity;
    ctx.translate(tl.x, tl.y);
    ctx.scale((br.x - tl.x) / w, (br.y - tl.y) / h);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  _drawGrid(ctx, w, h) {
    const upm = this.projection.mapUnitsPerMetre();
    // Round distance nearest 110 screen px.
    const targetPx = 110;
    const rawMetres = targetPx / (this.view.zoom * upm);
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(rawMetres, 1e-6))));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= rawMetres) ?? pow * 10;
    const stepMap = step * upm;
    const stepPx = stepMap * this.view.zoom;
    if (stepPx < 12) return;

    const topLeft = this.toMapSpace(0, 0);
    const startX = Math.floor(topLeft.x / stepMap) * stepMap;
    const startY = Math.floor(topLeft.y / stepMap) * stepMap;

    ctx.save();
    ctx.strokeStyle = ui.lineSoft;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (let x = startX; ; x += stepMap) {
      const s = this.toScreen(x, 0).x;
      if (s > w) break;
      if (s >= 0) { ctx.moveTo(Math.round(s) + 0.5, 0); ctx.lineTo(Math.round(s) + 0.5, h); }
    }
    for (let y = startY; ; y += stepMap) {
      const s = this.toScreen(0, y).y;
      if (s > h) break;
      if (s >= 0) { ctx.moveTo(0, Math.round(s) + 0.5); ctx.lineTo(w, Math.round(s) + 0.5); }
    }
    ctx.stroke();
    ctx.restore();

    this._gridStepMetres = step;
    this._gridStepPx = stepPx;
  }

  /** Scale-bar readout for the UI layer. */
  get scale() {
    return { metres: this._gridStepMetres ?? 0, px: this._gridStepPx ?? 0 };
  }

  _drawRoute(ctx) {
    const legs = this.route?.legs;
    if (!legs?.length) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Glow underlay, drawn first.
    for (const leg of legs) {
      const a = this.projectPoi(leg.from);
      const b = this.projectPoi(leg.to);
      ctx.strokeStyle = modeColor(leg.mode);
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = 9;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (const leg of legs) {
      const a = this.projectPoi(leg.from);
      const b = this.projectPoi(leg.to);
      const teleport = leg.mode === 'teleport';
      ctx.strokeStyle = modeColor(leg.mode);
      ctx.globalAlpha = leg.estimated && !teleport ? 0.72 : 1;
      ctx.lineWidth = teleport ? 3 : 2.4;
      // Teleport legs are dashed and thicker.
      ctx.setLineDash(teleport ? [9, 6] : leg.mode === 'portal' ? [3, 4] : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();

      if (teleport) this._drawTeleportGlyph(ctx, a, b);
    }
    ctx.restore();
  }

  _drawTeleportGlyph(ctx, a, b) {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 34) return;
    ctx.save();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.translate(mx, my);
    ctx.rotate(Math.atan2(b.y - a.y, b.x - a.x));
    ctx.fillStyle = modeColor('teleport');
    ctx.strokeStyle = ui.bg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-5, -5);
    ctx.lineTo(5, 0);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }

  _drawMarkers(ctx) {
    const { w, h } = this.size;
    const zoomBoost = Math.min(1 + Math.log10(Math.max(this.view.zoom, 0.1)) * 0.35, 2.2);
    const labels = [];

    for (const p of this.visible) {
      const s = this.projectPoi(p);
      if (s.x < -40 || s.y < -40 || s.x > w + 40 || s.y > h + 40) continue;

      const dimmed =
        this.matchedIds !== null && !this.matchedIds.has(p.poi_id);
      const selected = p.poi_id === this.selectedId;
      const hovered = p.poi_id === this.hoveredId;
      const isStart = p.poi_id === this.startBeaconId;
      const unlocked = this.unlockedBeacons.has(p.poi_id);
      const used = this.usedBeacons.has(p.poi_id);
      // Used beacons draw larger and are never dimmed.
      const r = Math.max(kindRadius(p.kind) * zoomBoost, 2) * (used ? 1.55 : 1);

      ctx.save();
      ctx.globalAlpha = dimmed && !used ? 0.22 : 1;

      if (used) {
        // Bloom in the teleport colour.
        const glow = ctx.createRadialGradient(s.x, s.y, r * 0.4, s.x, s.y, r + 13);
        glow.addColorStop(0, 'rgba(212,116,240,.55)');
        glow.addColorStop(1, 'rgba(212,116,240,0)');
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 13, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();
      } else if (unlocked && !dimmed) {
        // Unlocked but unused: a faint halo.
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 5, 0, Math.PI * 2);
        ctx.fillStyle = kindColor('fast_travel');
        ctx.globalAlpha = 0.16;
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // Drop shadow, for contrast over the base image.
      ctx.shadowColor = 'rgba(0,0,0,.85)';
      ctx.shadowBlur = 4;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = kindColor(p.kind);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = 'rgba(10,12,18,.9)';
      ctx.stroke();

      // Ring marking a POI with no source elevation.
      if (p.z_estimated && !dimmed) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = ui.warn;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      if (used) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 4.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#f0a8ff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      if (isStart) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 9, 0, Math.PI * 2);
        ctx.strokeStyle = kindColor('fast_travel');
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      if (hovered && !selected) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2);
        ctx.strokeStyle = ui.fgMuted;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.restore();

      // Outside the save/restore, so marker state does not affect it.
      if (selected) this._drawSelectionRing(ctx, s, r);

      // Used beacons are always labelled.
      if (this.showLabels || selected || hovered || isStart || used) {
        labels.push({
          text: p.name,
          x: s.x,
          y: s.y - r - 6,
          strong: selected || isStart || used,
        });
      }
    }

    this._drawLabels(ctx, labels);
  }

  _drawLabels(ctx, labels) {
    if (!labels.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    // Skip a label whose box collides with one already placed.
    const placed = [];
    for (const l of labels) {
      ctx.font = `${l.strong ? '650 ' : '500 '}12px ui-sans-serif, system-ui, sans-serif`;
      const wdt = ctx.measureText(l.text).width;
      const box = { x1: l.x - wdt / 2 - 3, y1: l.y - 14, x2: l.x + wdt / 2 + 3, y2: l.y + 2 };
      const clash = placed.some(
        (q) => !(box.x2 < q.x1 || box.x1 > q.x2 || box.y2 < q.y1 || box.y1 > q.y2),
      );
      if (clash && !l.strong) continue;
      placed.push(box);

      ctx.lineWidth = 3;
      ctx.strokeStyle = ui.bg;
      ctx.globalAlpha = 0.85;
      ctx.strokeText(l.text, l.x, l.y);
      ctx.globalAlpha = 1;
      ctx.fillStyle = l.strong ? ui.fg : ui.fgMuted;
      ctx.fillText(l.text, l.x, l.y);
    }
    ctx.restore();
  }

  _drawTourOrder(ctx) {
    if (!this.tourStops.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '650 10px ui-monospace, monospace';
    const { w, h } = this.size;

    this.tourStops.forEach((p, i) => {
      const s = this.projectPoi(p);
      if (s.x < -20 || s.y < -20 || s.x > w + 20 || s.y > h + 20) return;
      // Badges are hidden for large tours at low zoom.
      if (this.tourStops.length > 150 && this.view.zoom < 0.6) return;

      const r = 8;
      ctx.beginPath();
      ctx.arc(s.x, s.y - 14, r, 0, Math.PI * 2);
      ctx.fillStyle = ui.surface1;
      ctx.fill();
      ctx.strokeStyle = ui.accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = ui.fg;
      ctx.fillText(String(i + 1), s.x, s.y - 13.5);
    });
    ctx.restore();
  }
}
