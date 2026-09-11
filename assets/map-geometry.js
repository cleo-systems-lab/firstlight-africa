/**
 * FIRSTLIGHT map geometry.
 *
 * Pure functions, no DOM: an equal-area projection for the Africa atlas and a
 * collision-aware marker layout. Equal-area over accurate (Ensibuko Form): a
 * country's drawn size follows its real size, so the projection itself never
 * enlarges one region at another's expense.
 */

const RAD = Math.PI / 180;
const GOLDEN_ANGLE = 2.399963229728653;

/**
 * Lambert azimuthal equal-area, equatorial aspect, centred on `lon0`.
 * Returns unit-sphere x/y with y growing north.
 */
export function lambertAzimuthal(lon, lat, lon0 = 20) {
  const lambda = (lon - lon0) * RAD;
  const phi = lat * RAD;
  const k = Math.sqrt(2 / Math.max(1 + Math.cos(phi) * Math.cos(lambda), 1e-12));
  return [k * Math.cos(phi) * Math.sin(lambda), k * Math.sin(phi)];
}

/**
 * Fit every [lon, lat] pair in `points` inside a width × height box with `pad`
 * on each side, centred. `project([lon, lat])` returns [x, y] in box units,
 * y growing downward as SVG expects.
 */
export function fitProjection(points, { width, height, pad = 24, lon0 = 20 } = {}) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [lon, lat] of points) {
    const [x, y] = lambertAzimuthal(lon, lat, lon0);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) [minX, maxX, minY, maxY] = [-1, 1, -1, 1];
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  const offsetX = (width - spanX * scale) / 2;
  const offsetY = (height - spanY * scale) / 2;
  const project = ([lon, lat]) => {
    const [x, y] = lambertAzimuthal(lon, lat, lon0);
    return [round2(offsetX + (x - minX) * scale), round2(offsetY + (maxY - y) * scale)];
  };
  return { project, scale, lon0 };
}

/** Every [lon, lat] vertex of a GeoJSON Polygon or MultiPolygon geometry. */
export function geometryPoints(geometry) {
  if (geometry?.type === "Polygon") return geometry.coordinates.flat();
  if (geometry?.type === "MultiPolygon") return geometry.coordinates.flat(2);
  return [];
}

/**
 * Place markers so no two centres sit closer than `minDistance` (box units).
 * Items are placed in the order given — the first keeps its true position —
 * and a later item that would collide steps outward on a golden-angle spiral
 * until it is clear. Returns [{ id, anchor, at, moved }].
 */
export function layoutMarkers(items, minDistance, { maxSteps = 64 } = {}) {
  const placed = [];
  const isClear = (x, y) => placed.every((spot) => Math.hypot(spot.at[0] - x, spot.at[1] - y) >= minDistance);
  for (const { id, point } of items) {
    const [ax, ay] = point;
    let at = [ax, ay];
    if (!isClear(ax, ay)) {
      for (let step = 1; step <= maxSteps; step += 1) {
        const radius = minDistance * (0.55 + 0.45 * Math.sqrt(step));
        const x = ax + Math.cos(step * GOLDEN_ANGLE) * radius;
        const y = ay + Math.sin(step * GOLDEN_ANGLE) * radius;
        if (isClear(x, y)) {
          at = [x, y];
          break;
        }
      }
    }
    placed.push({ id, anchor: [ax, ay], at, moved: at[0] !== ax || at[1] !== ay });
  }
  return placed.map((spot) => ({ ...spot, at: [round2(spot.at[0]), round2(spot.at[1])] }));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
