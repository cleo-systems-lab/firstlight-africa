import {
  PASSPORTS,
  adjustedScore,
  compareOpportunities,
  evaluatePolicy,
  evaluateWindow,
  formatCheckedAt,
  formatDate,
  passportName,
  passportView,
  titleCase
} from "./policy-engine.js";
import { fitProjection, geometryPoints, layoutMarkers } from "./map-geometry.js";

const TYPE_LABELS = {
  visa_change: "Entry shift",
  free_entry: "Free access",
  route_launch: "Route / network",
  stopover_subsidy: "Stopover benefit",
  fare_distortion: "Fare window",
  currency_bargain: "Price stack",
  tax_change: "Tax shift",
  admin_change: "Border friction"
};

const FACTOR_LABELS = {
  accessShift: "Access",
  timing: "Timing",
  savings: "Savings",
  capture: "Capture"
};

// Colour on the map, the rail and the feed means evidence state; these are its words.
const TRUTH_WORDS = { yes: "Current", maybe: "Recheck", conflict: "Disputed", no: "Not live" };

// The atlas viewBox; the equal-area projection is fitted into it once the geometry loads.
const MAP = Object.freeze({ width: 720, height: 680, pad: 22, centreLon: 20 });
// Marker sizes are screen pixels: a marker keeps one size at every width, so a score stays legible.
const MARKER = Object.freeze({ full: 11, compact: 5.5, selected: 12, hitFull: 18, hitCompact: 10, gap: 4 });
// Below this drawing scale the map is an overview and the signal rail under it is the control.
const COMPACT_SCALE = 0.72;
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const STORAGE_PREFIX = "firstlight.";

const appState = {
  opportunities: [],
  map: null,
  registry: null,
  meta: null,
  projection: null,
  countryPaths: new Map(),
  selectedId: null,
  filter: "all",
  audience: "citizens",
  railReady: false,
  clearArmedUntil: 0,
  passport: readStorage(`${STORAGE_PREFIX}passport`, "UGA"),
  saved: new Set(asList(readStorage(`${STORAGE_PREFIX}saved`, []))),
  watched: new Set(asList(readStorage(`${STORAGE_PREFIX}watched`, [])))
};

const els = {
  passport: document.querySelector("#passport-select"),
  mapSvg: document.querySelector("#africa-map"),
  countries: document.querySelector("#country-layer"),
  routes: document.querySelector("#route-layer"),
  markers: document.querySelector("#map-markers"),
  mapProvenance: document.querySelector("#map-provenance"),
  rail: document.querySelector("#signal-rail"),
  focus: document.querySelector("#focus-card"),
  grid: document.querySelector("#opportunity-grid"),
  feed: document.querySelector("#feed-list"),
  capture: document.querySelector("#capture-grid"),
  saved: document.querySelector("#saved-grid"),
  savedCount: document.querySelector("#saved-count"),
  scanGrid: document.querySelector("#scan-grid"),
  sourceRegister: document.querySelector("#source-register"),
  methodCopy: document.querySelector("#method-copy"),
  commonsStats: document.querySelector("#commons-stats"),
  commonsContext: document.querySelector("#commons-context"),
  countryBoard: document.querySelector("#country-board"),
  audienceSwitch: document.querySelector("#audience-switch"),
  exportSignals: document.querySelector("#export-signals"),
  clearDevice: document.querySelector("#clear-device"),
  typeFilters: document.querySelector("#type-filters"),
  signalCount: document.querySelector("#signal-count"),
  recheckCount: document.querySelector("#recheck-count"),
  liveCount: document.querySelector("#live-count"),
  highScore: document.querySelector("#map-high-score"),
  passportNote: document.querySelector("#passport-note"),
  searchTrigger: document.querySelector("#search-trigger"),
  searchKbd: document.querySelector("#search-kbd"),
  searchDialog: document.querySelector("#command-dialog"),
  searchInput: document.querySelector("#command-input"),
  searchResults: document.querySelector("#command-results"),
  closeCommand: document.querySelector("#close-command"),
  toastRegion: document.querySelector("#toast-region"),
  tape: document.querySelector("#signal-tape"),
  tapeLabel: document.querySelector("#tape-label"),
  tapeCopy: document.querySelector("#tape-copy"),
  railStamp: document.querySelector("#rail-stamp"),
  asOf: document.querySelector("#as-of-time")
};

boot();

async function boot() {
  populatePassports();
  labelShortcut();
  bindStaticEvents();
  try {
    const responses = await Promise.all([
      fetch("./data/opportunities.json"),
      fetch("./data/africa-map.json"),
      fetch("./data/source-registry.json")
    ]);
    for (const response of responses) {
      if (!response.ok) throw new Error(`Runtime data request returned ${response.status}`);
    }
    const [payload, map, registry] = await Promise.all(responses.map((response) => response.json()));
    appState.opportunities = payload.opportunities;
    appState.meta = payload.meta;
    appState.map = map;
    appState.registry = registry;
    prepareAtlas();
    appState.selectedId = sortedOpportunities()[0]?.id || null;
    renderAll();
    appState.railReady = true;
    observeMapSize();
  } catch (error) {
    console.error(error);
    els.focus.innerHTML = `<div class="error-panel"><strong>The source-backed snapshot could not be loaded.</strong><br />Try again; no eligibility decision has been made.</div>`;
  }
}

function populatePassports() {
  const groups = new Map();
  for (const passport of PASSPORTS) {
    if (!groups.has(passport.region)) groups.set(passport.region, []);
    groups.get(passport.region).push(passport);
  }
  els.passport.innerHTML = [...groups.entries()]
    .map(([region, passports]) => `<optgroup label="${attr(region)}">${passports
      .map((passport) => `<option value="${attr(passport.code)}">${safe(passport.name)}</option>`)
      .join("")}</optgroup>`)
    .join("");
  if (!PASSPORTS.some((passport) => passport.code === appState.passport)) appState.passport = "UGA";
  els.passport.value = appState.passport;
}

function labelShortcut() {
  const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "";
  if (els.searchKbd) els.searchKbd.textContent = /mac|iphone|ipad|ipod/i.test(platform) ? "⌘ K" : "Ctrl K";
}

function bindStaticEvents() {
  els.passport.addEventListener("change", (event) => {
    appState.passport = event.target.value;
    writeStorage(`${STORAGE_PREFIX}passport`, appState.passport);
    appState.selectedId = sortedOpportunities()[0]?.id || appState.selectedId;
    renderAll();
    announce(`Signals re-ranked for the ${passportName(appState.passport)} passport lens.`);
  });

  els.typeFilters.addEventListener("click", (event) => {
    const button = event.target.closest("[data-type]");
    if (!button) return;
    appState.filter = button.dataset.type;
    els.typeFilters.querySelectorAll("[data-type]").forEach((chip) => {
      const active = chip === button;
      chip.classList.toggle("is-active", active);
      chip.setAttribute("aria-pressed", String(active));
    });
    const available = sortedOpportunities();
    if (!available.some((item) => item.id === appState.selectedId)) appState.selectedId = available[0]?.id || null;
    renderMap(); renderRail(); renderCards(); renderFocus();
  });

  // First tap on a rail chip selects it; a second tap on the selected chip opens its evidence.
  els.rail.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-rail-id]");
    if (!chip) return;
    if (chip.dataset.railId === appState.selectedId) revealFocus();
    else selectOpportunity(chip.dataset.railId);
  });

  document.addEventListener("click", (event) => {
    const selectTarget = event.target.closest("[data-select-id]");
    if (selectTarget) {
      event.preventDefault();
      selectOpportunity(selectTarget.dataset.selectId, selectTarget.dataset.scroll === "true");
      return;
    }
    const saveTarget = event.target.closest("[data-save-id]");
    if (saveTarget) {
      event.preventDefault(); event.stopPropagation(); toggleSet("saved", saveTarget.dataset.saveId); return;
    }
    const watchTarget = event.target.closest("[data-watch-id]");
    if (watchTarget) {
      event.preventDefault(); event.stopPropagation(); toggleSet("watched", watchTarget.dataset.watchId);
    }
  });

  document.addEventListener("keydown", (event) => {
    const selectable = event.target.closest?.("[data-select-id]");
    const tag = event.target.tagName?.toUpperCase();
    if (selectable && !["BUTTON", "A"].includes(tag) && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault(); selectOpportunity(selectable.dataset.selectId, selectable.dataset.scroll === "true");
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault(); openSearch();
    }
  });

  els.searchTrigger.addEventListener("click", openSearch);
  els.closeCommand.addEventListener("click", () => els.searchDialog.close());
  els.searchInput.addEventListener("input", () => renderSearch(els.searchInput.value));
  els.exportSignals.addEventListener("click", exportVisibleSignals);
  els.clearDevice.addEventListener("click", clearDevice);
  els.audienceSwitch.addEventListener("click", (event) => {
    const button = event.target.closest("[data-audience]");
    if (!button) return;
    appState.audience = button.dataset.audience;
    els.audienceSwitch.querySelectorAll("[data-audience]").forEach((candidate) => {
      const active = candidate === button;
      candidate.classList.toggle("is-active", active);
      candidate.setAttribute("aria-pressed", String(active));
    });
    renderCommons();
  });

  const sectionIds = ["overview", "atlas", "feed", "capture", "saved"];
  let navFrame = null;
  const updateNavigation = () => {
    navFrame = null;
    const atEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;
    let activeId = atEnd ? "saved" : "overview";
    if (!atEnd) for (const id of sectionIds) {
      const section = document.getElementById(id);
      if (section && section.getBoundingClientRect().top <= 130) activeId = id;
    }
    document.querySelectorAll("[data-view-link]").forEach((link) => link.classList.toggle("is-active", link.dataset.viewLink === activeId));
  };
  window.addEventListener("scroll", () => {
    if (navFrame === null) navFrame = requestAnimationFrame(updateNavigation);
  }, { passive: true });
  updateNavigation();
}

function renderAll() {
  renderSummary(); renderMap(); renderRail(); renderCards(); renderFocus(); renderFeed();
  renderCapture(); renderSaved(); renderScout(); renderCommons(); renderSources(); renderSearch("");
}

function renderSummary() {
  const now = new Date();
  const evaluations = appState.opportunities.map((item) => evaluatePolicy(item, now));
  els.signalCount.textContent = appState.opportunities.length;
  els.recheckCount.textContent = evaluations.filter((evaluation) => ["maybe", "conflict"].includes(evaluation.truthState)).length;
  els.liveCount.textContent = evaluations.filter((evaluation) => evaluation.truthState === "yes").length;
  els.passportNote.textContent = `Re-ranked for the ${passportName(appState.passport)} passport lens.`;
  const first = sortedOpportunities()[0];
  els.highScore.textContent = first ? `${adjustedScore(first, appState.passport)} / 100` : "—";
  if (!appState.meta) return;

  // The age of the truth is on every screen, and an unreviewed snapshot says so instead of looking current.
  const reviewBy = new Date(appState.meta.reviewBy);
  const horizon = appState.meta.horizonAt ? new Date(appState.meta.horizonAt) : null;
  const state = horizon && now > horizon ? "horizon" : now > reviewBy ? "overdue" : "current";
  els.tape.dataset.state = state;
  els.tapeLabel.textContent = { current: "Source-backed snapshot", overdue: "Snapshot overdue", horizon: "Past its horizon" }[state];
  els.tapeCopy.textContent = {
    current: "Official signals, live market observations and FIRSTLIGHT inferences remain visibly separate.",
    overdue: `This snapshot passed its review date (${formatDate(appState.meta.reviewBy)}, ${lateness(reviewBy, now)}). Recheck every source before acting.`,
    horizon: `Nobody may be checking this snapshot after ${formatDate(appState.meta.horizonAt)}. Treat every signal as unverified.`
  }[state];
  els.asOf.dateTime = appState.meta.checkedAt;
  els.asOf.textContent = `Scan ${formatCheckedAt(appState.meta.checkedAt)} · review by ${formatDate(appState.meta.reviewBy)}`;
  els.railStamp.innerHTML = `SCAN<br />${safe(stampDate(appState.meta.checkedAt))}`;
}

function prepareAtlas() {
  const points = appState.map.features.flatMap((feature) => geometryPoints(feature.geometry));
  for (const item of appState.opportunities) {
    if (item.coordinates) points.push([item.coordinates.lon, item.coordinates.lat]);
    for (const stop of item.route || []) points.push([stop.lon, stop.lat]);
  }
  appState.projection = fitProjection(points, { width: MAP.width, height: MAP.height, pad: MAP.pad, lon0: MAP.centreLon });
  appState.countryPaths = new Map(appState.map.features.map((feature) => [feature, featurePath(feature)]));
}

function project(point) {
  return appState.projection.project([point.lon, point.lat]);
}

function ringPath(ring) {
  return ring.map((vertex, index) => {
    const [x, y] = appState.projection.project(vertex);
    return `${index ? "L" : "M"}${x} ${y}`;
  }).join(" ") + " Z";
}

function featurePath(feature) {
  const coordinates = feature.geometry?.coordinates || [];
  if (feature.geometry?.type === "Polygon") return coordinates.map(ringPath).join(" ");
  if (feature.geometry?.type === "MultiPolygon") return coordinates.flatMap((polygon) => polygon.map(ringPath)).join(" ");
  return "";
}

function renderMap() {
  if (!appState.projection) return;
  const now = new Date();
  const items = sortedOpportunities();
  const byCountry = new Map();
  for (const item of items) {
    const evaluation = evaluatePolicy(item, now);
    const score = adjustedScore(item, appState.passport);
    for (const iso of item.mapCountries || []) {
      const current = byCountry.get(iso);
      if (!current || score > current.score) byCountry.set(iso, { score, truth: evaluation.truthState, id: item.id });
    }
  }
  const selected = new Set(appState.opportunities.find((item) => item.id === appState.selectedId)?.mapCountries || []);
  els.countries.innerHTML = appState.map.features.map((feature) => {
    const iso = feature.properties.iso3;
    const signal = byCountry.get(iso);
    const classes = ["country-shape", signal ? "has-signal" : "is-unmapped", selected.has(iso) ? "is-selected" : ""].filter(Boolean).join(" ");
    const interaction = signal ? `data-select-id="${attr(signal.id)}" tabindex="0" role="button" aria-label="Open ${attr(feature.properties.name)} signal"` : "";
    const tip = signal ? ` · top adjusted signal ${signal.score} · ${TRUTH_WORDS[signal.truth] || signal.truth}` : " · no current signal in this snapshot";
    return `<path class="${classes}" data-truth="${attr(signal?.truth || "unknown")}" ${interaction} d="${appState.countryPaths.get(feature)}"><title>${safe(feature.properties.name)}${tip}</title></path>`;
  }).join("");

  els.routes.innerHTML = items.filter((item) => item.route?.length > 1).map((item) => {
    const points = item.route.map(project);
    const segments = points.slice(1).map((end, index) => {
      const start = points[index];
      const midX = (start[0] + end[0]) / 2;
      const midY = Math.min(start[1], end[1]) - Math.min(44, Math.abs(end[0] - start[0]) * 0.18 + 14);
      return `${index ? "" : `M${start[0]} ${start[1]} `}Q${midX.toFixed(2)} ${midY.toFixed(2)} ${end[0]} ${end[1]}`;
    }).join(" ");
    return `<path class="signal-route ${item.id === appState.selectedId ? "is-selected" : ""}" d="${segments}" />`;
  }).join("");

  renderMarkers(items, now);
  els.mapProvenance.textContent = `${appState.map.provenance.source} · Lambert equal-area projection, so drawn size follows real size · ${appState.map.features.length} geometries · hatched means unobserved, not zero · boundaries do not settle disputed status.`;
}

function renderMarkers(items = sortedOpportunities(), now = new Date()) {
  if (!appState.projection) return;
  const scale = mapScale();
  const compact = scale < COMPACT_SCALE;
  els.mapSvg.classList.toggle("is-compact", compact);
  const radius = compact ? MARKER.compact : MARKER.full;
  const hit = compact ? MARKER.hitCompact : MARKER.hitFull;
  // Rank order decides who keeps a true position, so markers do not jump when the selection changes.
  const layout = layoutMarkers(items.map((item) => ({ id: item.id, point: project(item.coordinates) })), (radius * 2 + MARKER.gap) / scale);
  const byId = new Map(items.map((item) => [item.id, item]));
  const unit = (1 / scale).toFixed(4);
  const drawOrder = [...layout].sort((a, b) => Number(a.id === appState.selectedId) - Number(b.id === appState.selectedId));
  els.markers.innerHTML = drawOrder.map((spot) => {
    const item = byId.get(spot.id);
    const evaluation = evaluatePolicy(item, now);
    const score = adjustedScore(item, appState.passport);
    const isSelected = item.id === appState.selectedId;
    const leader = spot.moved
      ? `<line class="marker-leader" x1="${spot.anchor[0]}" y1="${spot.anchor[1]}" x2="${spot.at[0]}" y2="${spot.at[1]}" /><circle class="marker-anchor" cx="${spot.anchor[0]}" cy="${spot.anchor[1]}" r="${(2.2 / scale).toFixed(2)}" />`
      : "";
    return `<g class="marker-slot" data-truth="${attr(evaluation.truthState)}">${leader}<g class="signal-marker${isSelected ? " is-selected" : ""}" data-select-id="${attr(item.id)}" data-truth="${attr(evaluation.truthState)}" tabindex="${compact ? "-1" : "0"}" role="button" aria-label="${attr(`${item.title}, ranked ${score}, ${evaluation.displayState}`)}" transform="translate(${spot.at[0]} ${spot.at[1]}) scale(${unit})"><circle class="marker-hit" r="${hit}"></circle><circle class="marker-pulse" r="${radius + 4}"></circle><circle class="marker-core" r="${isSelected ? MARKER.selected : radius}"></circle><text y="4.2">${score}</text><title>${safe(item.country)} · ${safe(item.title)} · ${score}</title></g></g>`;
  }).join("");
}

function mapScale() {
  const box = els.mapSvg?.getBoundingClientRect();
  if (!box?.width || !box?.height) return 1;
  return Math.min(box.width / MAP.width, box.height / MAP.height);
}

function observeMapSize() {
  if (!("ResizeObserver" in window) || !els.mapSvg) return;
  let frame = null;
  let lastScale = mapScale();
  new ResizeObserver(() => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const scale = mapScale();
      if (Math.abs(scale - lastScale) < 0.01) return;
      lastScale = scale;
      renderMarkers();
    });
  }).observe(els.mapSvg);
}

function signalBadge(item) {
  const label = { early: "Early signal", new: "Just launched", live: "Live offer", volatile: "Volatile fare", gazette: "Gazette" }[item.signalClass];
  return label ? `<span class="signal-class" data-signal-class="${attr(item.signalClass)}">${label}</span>` : "";
}

function renderRail() {
  const now = new Date();
  const items = sortedOpportunities();
  if (!items.length) {
    els.rail.innerHTML = `<p class="rail-empty">No signals in this layer. Choose another filter.</p>`;
    return;
  }
  els.rail.innerHTML = items.map((item) => {
    const evaluation = evaluatePolicy(item, now);
    const score = adjustedScore(item, appState.passport);
    const selected = item.id === appState.selectedId;
    const word = TRUTH_WORDS[evaluation.truthState] || evaluation.truthState;
    const label = `${item.title}. ${item.country}. Ranked ${score}. ${evaluation.displayState}.${selected ? " Selected: press again to read the evidence." : ""}`;
    return `<button class="rail-chip" type="button" data-rail-id="${attr(item.id)}" data-truth="${attr(evaluation.truthState)}" aria-pressed="${selected}" aria-label="${attr(label)}"><b>${score}</b><span><strong>${safe(item.country)}</strong><small><i>${safe(word)}</i> · ${safe(item.title)}</small></span></button>`;
  }).join("");
  const active = els.rail.querySelector('[aria-pressed="true"]');
  if (active) {
    const left = active.offsetLeft - (els.rail.clientWidth - active.offsetWidth) / 2;
    els.rail.scrollTo({ left: Math.max(0, left), behavior: appState.railReady && motionOK() ? "smooth" : "auto" });
  }
}

function renderCards() {
  const opportunities = sortedOpportunities();
  if (!opportunities.length) {
    els.grid.innerHTML = `<div class="empty-saved"><div><strong>No signals in this layer.</strong><p>Choose another atlas filter.</p></div></div>`;
    return;
  }
  els.grid.innerHTML = opportunities.map((item) => {
    const passport = passportView(item, appState.passport);
    const score = adjustedScore(item, appState.passport);
    return `<article class="opportunity-card ${item.id === appState.selectedId ? "is-selected" : ""}" data-select-id="${attr(item.id)}" tabindex="0"><div class="card-topline"><span class="stage-pill" data-stage="${attr(item.policyStage)}">${safe(titleCase(item.policyStage))}</span>${signalBadge(item)}<span class="card-score">${score}<small>/100</small></span></div><h3>${safe(item.title)}</h3><p class="card-country">${safe(item.country)} · ${safe(TYPE_LABELS[item.type] || item.type)}</p><p class="card-claim">${safe(item.travellerClaim.copy)}</p><div class="card-footer"><span class="passport-relevance">${safe(titleCase(passport.relevance))} passport relevance</span><div class="card-actions"><button class="icon-action ${appState.watched.has(item.id) ? "is-active" : ""}" type="button" data-watch-id="${attr(item.id)}" aria-label="${appState.watched.has(item.id) ? "Stop watching" : "Watch"} ${attr(item.title)}">${bellIcon()}</button><button class="icon-action ${appState.saved.has(item.id) ? "is-active" : ""}" type="button" data-save-id="${attr(item.id)}" aria-label="${appState.saved.has(item.id) ? "Remove saved" : "Save"} ${attr(item.title)}">${bookmarkIcon()}</button></div></div></article>`;
  }).join("");
}

function renderFocus() {
  const item = appState.opportunities.find((candidate) => candidate.id === appState.selectedId);
  if (!item) {
    els.focus.innerHTML = `<div class="error-panel">Choose a signal to inspect its evidence.</div>`;
    return;
  }
  const evaluation = evaluatePolicy(item, new Date());
  const windowState = evaluateWindow(item, new Date());
  const passport = passportView(item, appState.passport);
  const score = adjustedScore(item, appState.passport);
  const sources = item.evidence.sources || [];
  els.focus.innerHTML = `<div class="focus-content"><div class="focus-topline"><span class="type-code">${safe(item.eyebrow)} / ${safe(item.region)}</span><span class="window-pill">${safe(windowState.label)}</span></div>${signalBadge(item)}<h2 id="focus-title" tabindex="-1">${safe(item.title)}</h2><p class="focus-country">${safe(item.country)} · ${safe(item.travellerClaim.copy)}</p><p class="focus-summary">${safe(item.summary)}</p><div class="score-band"><div class="score-ring" style="--score:${score}"><span class="score-value">${score}<small>Arbitrage</small></span></div><div class="factor-list">${Object.entries(item.scoreFactors).map(([key, value]) => `<div class="factor"><span>${safe(FACTOR_LABELS[key] || key)}</span><span class="factor-track"><i style="width:${Number(value)}%"></i></span><b>${Number(value)}</b></div>`).join("")}<p class="score-note">FIRSTLIGHT comparative ranking · not an official rating, saving or eligibility decision.</p></div></div><div class="evidence-box"><div class="evidence-head"><span class="truth-pill" data-truth="${attr(evaluation.truthState)}">${safe(evaluation.truthState)}</span><span class="stage-pill" data-stage="${attr(item.policyStage)}">${safe(titleCase(item.policyStage))}</span></div><strong>${safe(evaluation.displayState)}</strong><p>${safe(evaluation.reason)}</p><p class="checked-line">Effective: ${safe(formatDate(item.timeline.effectiveAt))} · Checked: ${safe(formatCheckedAt(item.evidence.checkedAt))} · Recheck: ${safe(formatCheckedAt(item.evidence.recheckAt))}</p><details class="source-details"><summary>${sources.length} source${sources.length === 1 ? "" : "s"} · inspect provenance</summary><ul>${sources.map((source) => `<li><a href="${attr(sourceUrl(source.url))}" target="_blank" rel="noopener noreferrer"><strong>${safe(source.label)}</strong><span class="source-arrow" aria-hidden="true">↗</span></a><span>${source.available === false ? "Unavailable" : "Available"} · ${safe(titleCase(source.authority))} · observed ${safe(formatCheckedAt(source.observedAt))}</span>${source.note ? `<em>${safe(source.note)}</em>` : ""}</li>`).join("")}</ul><p class="source-egress-note">The named institution is contacted only when you choose its link.</p></details></div><div class="passport-callout"><span>${safe(appState.passport)} lens</span><p>${safe(passport.note)}</p></div><div class="focus-actions"><button class="primary-action" type="button" data-save-id="${attr(item.id)}">${appState.saved.has(item.id) ? "Saved to fieldbook" : "Save to fieldbook"}</button><button class="secondary-action ${appState.watched.has(item.id) ? "is-active" : ""}" type="button" data-watch-id="${attr(item.id)}">${appState.watched.has(item.id) ? "Watching locally" : "Watch quietly"}</button></div></div>`;
}

function renderFeed() {
  const feed = [...appState.opportunities].sort((a, b) => new Date(b.evidence.checkedAt) - new Date(a.evidence.checkedAt));
  els.feed.innerHTML = feed.map((item) => {
    const evaluation = evaluatePolicy(item, new Date());
    return `<article class="feed-item"><time class="feed-time" datetime="${attr(item.evidence.checkedAt)}">${safe(shortChecked(item.evidence.checkedAt))}</time><i class="feed-signal-dot" data-truth="${attr(evaluation.truthState)}" aria-hidden="true"></i><div class="feed-title"><strong>${safe(evaluation.displayState)}</strong><span>${safe(item.country)} · ${safe(TYPE_LABELS[item.type] || item.type)}</span></div><p class="feed-copy">${safe(item.signalClass === "early" ? item.summary : evaluation.nextAction)}</p><button class="feed-open" type="button" data-select-id="${attr(item.id)}" data-scroll="true">Inspect</button></article>`;
  }).join("");
}

function renderCapture() {
  const top = [...appState.opportunities].filter((item) => evaluatePolicy(item, new Date()).truthState !== "no").sort((a, b) => compareOpportunities(a, b, appState.passport)).slice(0, 4);
  els.capture.innerHTML = top.map((item, index) => {
    const evaluation = evaluatePolicy(item, new Date());
    return `<article class="capture-card"><span class="capture-index">0${index + 1}</span><div><strong>${safe(item.captureIdeas[0])}</strong><p>${safe(item.title)} · ${safe(evaluation.nextAction)}</p></div><span class="condition-tag">${evaluation.truthState === "yes" ? "Confirm before sale" : "Conditional only"}</span></article>`;
  }).join("");
}

function renderSaved() {
  const ids = new Set([...appState.saved, ...appState.watched]);
  const items = appState.opportunities.filter((item) => ids.has(item.id));
  els.savedCount.textContent = `${appState.saved.size} saved · ${appState.watched.size} watched`;
  if (!items.length) {
    els.saved.innerHTML = document.querySelector("#empty-saved-template").innerHTML;
    return;
  }
  els.saved.innerHTML = items.map((item) => {
    const modes = [appState.saved.has(item.id) ? "Saved trip" : null, appState.watched.has(item.id) ? "Quiet watch" : null].filter(Boolean);
    return `<article class="saved-item"><strong>${safe(item.title)}</strong><span>${safe(item.country)} · ${safe(modes.join(" + "))}</span><button type="button" data-select-id="${attr(item.id)}" data-scroll="true">Open evidence →</button></article>`;
  }).join("");
}

function renderScout() {
  if (!appState.registry) return;
  els.scanGrid.innerHTML = appState.registry.streams.map((stream, index) => `<article class="scan-card"><span>0${index + 1}</span><div><strong>${safe(stream.name)}</strong><p>${safe(stream.regions)} · every ${Number(stream.cadenceHours)}h</p></div><i>${safe(stream.stage)}</i></article>`).join("") + `<p class="next-scan">Next scheduled source review: <b>${safe(formatCheckedAt(appState.registry.nextScanBy))}</b>. Quiet when nothing material changes.</p>`;
}

function renderCommons() {
  const passports = new Map(PASSPORTS.filter((passport) => passport.code !== "OTHER").map((passport) => [passport.code, passport]));
  const profiles = new Map([...passports].map(([iso, passport]) => [iso, { iso, name: passport.name, actions: [] }]));
  for (const item of appState.opportunities) for (const iso of item.mapCountries || []) {
    if (profiles.has(iso)) profiles.get(iso).actions.push(item);
  }
  const active = [...profiles.values()].filter((profile) => profile.actions.length).map((profile) => {
    const evaluated = profile.actions.map((item) => ({ item, evaluation: evaluatePolicy(item, new Date()) }));
    const entryMoves = evaluated.filter(({ item, evaluation }) => ["visa_change", "free_entry"].includes(item.type) && evaluation.truthState === "yes").length;
    const travelMoves = evaluated.filter(({ item }) => ["route_launch", "fare_distortion", "stopover_subsidy"].includes(item.type)).length;
    const futureMoves = evaluated.filter(({ evaluation }) => evaluation.truthState === "maybe").length;
    const top = [...profile.actions].sort((a, b) => compareOpportunities(a, b, appState.passport))[0];
    const lastAt = profile.actions.reduce((latest, item) => new Date(item.evidence.checkedAt) > new Date(latest) ? item.evidence.checkedAt : latest, profile.actions[0].evidence.checkedAt);
    return { ...profile, entryMoves, travelMoves, futureMoves, top, lastAt, isCluster: travelMoves >= 2 || profile.actions.length >= 3 };
  }).sort((a, b) => Number(b.isCluster) - Number(a.isCluster) || b.actions.length - a.actions.length || a.name.localeCompare(b.name));

  const continentOpenings = new Set(appState.opportunities.filter((item) => ["visa_change", "free_entry"].includes(item.type) && evaluatePolicy(item, new Date()).truthState === "yes").flatMap((item) => item.mapCountries || [])).size;
  const earlySignals = appState.opportunities.filter((item) => item.signalClass === "early").length;
  const clusters = active.filter((profile) => profile.isCluster).length;
  els.commonsStats.innerHTML = `<span><b>${active.length}</b> countries with observed moves</span><span><b>${continentOpenings}</b> current access openings</span><span><b>${earlySignals}</b> official early signals</span><span><b>${clusters}</b> attention clusters</span>`;
  els.commonsContext.textContent = {
    citizens: "Citizen view: what became easier, what remains conditional, and where price or access is shifting.",
    governments: "Government view: observable policy moves worth comparing, adapting or improving—without pretending unlike contexts are identical.",
    providers: "Provider view: the service gap created by each move, with commercial ideas kept conditional on live evidence."
  }[appState.audience];

  els.countryBoard.innerHTML = active.map((profile) => {
    const types = [...new Set(profile.actions.map((item) => TYPE_LABELS[item.type] || titleCase(item.type)))];
    const sharedOnly = profile.actions.every((item) => (item.mapCountries || []).length > 5);
    return `<article class="country-move-card ${profile.isCluster ? "is-cluster" : ""}" data-select-id="${attr(profile.top.id)}" data-scroll="true" tabindex="0" role="button" aria-label="Inspect ${attr(profile.name)} evidence"><div class="country-move-top"><span>${safe(profile.iso)}</span>${profile.isCluster ? `<i>Attention cluster</i>` : sharedOnly ? `<i>Shared framework</i>` : `<i>Observed move</i>`}</div><h3>${safe(profile.name)}</h3><p>${safe(commonsNarrative(profile, appState.audience))}</p><div class="move-tags">${types.slice(0, 3).map((type) => `<span>${safe(type)}</span>`).join("")}</div><div class="country-move-foot"><span>${profile.actions.length} observed move${profile.actions.length === 1 ? "" : "s"}</span><time datetime="${attr(profile.lastAt)}">reviewed ${safe(formatDate(profile.lastAt))}</time></div></article>`;
  }).join("");
}

function commonsNarrative(profile, audience) {
  const types = new Set(profile.actions.map((item) => item.type));
  if (audience === "citizens") {
    const liveOpening = profile.actions.find((item) => ["visa_change", "free_entry"].includes(item.type) && evaluatePolicy(item, new Date()).truthState === "yes");
    return liveOpening ? `Current opening: ${liveOpening.travellerClaim.copy}.` : `Movement signal: ${profile.top.travellerClaim.copy}.`;
  }
  if (audience === "governments") {
    if (types.has("visa_change") && types.has("admin_change")) return "Learning edge: pair formal access reform with simpler arrival operations and publish who qualifies.";
    if (types.has("visa_change")) return "Learning edge: use entry friction as a continental policy lever, then make the operational steps legible.";
    if (types.has("free_entry")) return "Learning edge: time-boxed public access can activate local demand when audience, capacity and inclusion are explicit.";
    if (types.has("route_launch") || types.has("stopover_subsidy")) return "Learning edge: treat air connectivity as public market infrastructure, not only an airline announcement.";
    if (types.has("tax_change")) return "Learning edge: cost changes earn more trust when rates, caps, collection and public purpose are transparent.";
    return "Learning edge: publish the friction being removed and the evidence that citizens can contest.";
  }
  return `Service gap: ${profile.top.captureIdeas?.[0] || "help travellers verify scope, timing and total trip cost before commitment"}.`;
}

function renderSources() {
  const unique = new Map();
  for (const item of appState.opportunities) for (const source of item.evidence.sources || []) {
    if (!unique.has(source.url)) unique.set(source.url, { ...source, uses: 0 });
    unique.get(source.url).uses += 1;
  }
  const sources = [...unique.values()].sort((a, b) => a.label.localeCompare(b.label));
  els.methodCopy.textContent = `${appState.meta.method} ${appState.meta.promotionRule}`;
  els.sourceRegister.innerHTML = `<div class="source-register-head"><strong>${sources.length} inspectable source pages</strong><span>Observed at the published scan time</span></div><ol>${sources.map((source) => `<li><a href="${attr(sourceUrl(source.url))}" target="_blank" rel="noopener noreferrer"><span>${safe(source.label)}</span><b>↗</b></a><small>${safe(titleCase(source.authority))} · ${source.uses} signal${source.uses === 1 ? "" : "s"} · ${safe(formatCheckedAt(source.observedAt))}</small></li>`).join("")}</ol>`;
}

function openSearch() {
  if (!els.searchDialog.open) els.searchDialog.showModal();
  els.searchInput.value = ""; renderSearch(""); requestAnimationFrame(() => els.searchInput.focus());
}

function renderSearch(query) {
  const normalized = query.trim().toLowerCase();
  const results = appState.opportunities.filter((item) => !normalized || [item.title, item.country, item.region, item.summary, item.travellerClaim.copy, ...item.captureIdeas, ...item.tags].join(" ").toLowerCase().includes(normalized)).sort((a, b) => compareOpportunities(a, b, appState.passport));
  els.searchResults.innerHTML = results.length ? results.map((item) => `<button class="command-result" type="button" data-search-select="${attr(item.id)}"><span><strong>${safe(item.title)}</strong>${safe(item.country)} · ${safe(item.travellerClaim.copy)}</span><b>${adjustedScore(item, appState.passport)}</b></button>`).join("") : `<div class="empty-saved"><div><strong>No matching signals.</strong><p>Try a country, corridor, policy type or business angle.</p></div></div>`;
  els.searchResults.querySelectorAll("[data-search-select]").forEach((button) => button.addEventListener("click", () => {
    els.searchDialog.close(); selectOpportunity(button.dataset.searchSelect, true);
  }));
}

function sortedOpportunities() {
  return appState.opportunities.filter((item) => appState.filter === "all" || item.type === appState.filter).sort((a, b) => compareOpportunities(a, b, appState.passport));
}

function selectOpportunity(id, shouldScroll = false) {
  if (!appState.opportunities.some((item) => item.id === id)) return;
  appState.selectedId = id;
  withFocusKept(() => { renderMap(); renderRail(); renderCards(); renderFocus(); });
  if (shouldScroll) document.querySelector("#atlas").scrollIntoView({ behavior: motionOK() ? "smooth" : "auto", block: "start" });
}

function revealFocus() {
  els.focus.scrollIntoView({ behavior: motionOK() ? "smooth" : "auto", block: "start" });
  els.focus.querySelector("#focus-title")?.focus({ preventScroll: true });
}

// Re-rendering replaces the element that had keyboard focus; put focus back on its replacement.
const FOCUS_KEYS = [["selectId", "data-select-id"], ["railId", "data-rail-id"], ["saveId", "data-save-id"], ["watchId", "data-watch-id"]];

function withFocusKept(render) {
  const active = document.activeElement;
  const found = active && active !== document.body ? FOCUS_KEYS.find(([key]) => active.dataset?.[key]) : null;
  const kind = active?.classList?.[0];
  const value = found ? active.dataset[found[0]] : null;
  render();
  if (!found || !kind || document.contains(active)) return;
  document.querySelector(`.${CSS.escape(kind)}[${found[1]}="${CSS.escape(value)}"]`)?.focus({ preventScroll: true });
}

function toggleSet(key, id) {
  const set = appState[key];
  const item = appState.opportunities.find((candidate) => candidate.id === id);
  if (!item) return;
  const isAdding = !set.has(id);
  if (isAdding) set.add(id); else set.delete(id);
  writeStorage(`${STORAGE_PREFIX}${key}`, [...set]);
  withFocusKept(() => { renderCards(); renderFocus(); renderSaved(); });
  announce(key === "saved" ? `${isAdding ? "Saved" : "Removed"} ${item.title}.` : `${isAdding ? "Local watch added for" : "Local watch removed for"} ${item.title}.`);
}

function exportVisibleSignals() {
  const payload = { exportedAt: new Date().toISOString(), passportLens: { code: appState.passport, name: passportName(appState.passport) }, savedIds: [...appState.saved], watchedIds: [...appState.watched], filter: appState.filter, sourceSnapshot: appState.meta, notice: "Plain-text planning intelligence. Recheck issuing authorities and live prices.", opportunities: sortedOpportunities() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = `firstlight-${appState.passport.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.json`; link.click();
  URL.revokeObjectURL(url); announce("Fieldbook and visible signals downloaded as plain-text JSON.");
}

// On an 11-minute borrow the phone goes back to its owner: one deliberate double tap removes
// everything FIRSTLIGHT stored in this browser. The person carrying the risk decides; nothing is automatic.
function clearDevice() {
  if (Date.now() > appState.clearArmedUntil) {
    appState.clearArmedUntil = Date.now() + 4000;
    els.clearDevice.textContent = "Tap again to clear";
    els.clearDevice.classList.add("is-armed");
    setTimeout(() => { if (Date.now() >= appState.clearArmedUntil) disarmClear(); }, 4100);
    return;
  }
  disarmClear();
  try {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // Storage was blocked, so nothing was kept here in the first place.
  }
  appState.saved.clear();
  appState.watched.clear();
  appState.passport = "UGA";
  els.passport.value = appState.passport;
  appState.selectedId = sortedOpportunities()[0]?.id || null;
  renderAll();
  announce("Cleared. FIRSTLIGHT's passport lens, saves and watches are gone from this browser. Files you downloaded are not touched.");
}

function disarmClear() {
  appState.clearArmedUntil = 0;
  els.clearDevice.textContent = "Clear this device";
  els.clearDevice.classList.remove("is-armed");
}

function announce(message) {
  const toast = document.createElement("div");
  toast.className = "toast"; toast.innerHTML = `<strong>FIRSTLIGHT</strong><br />${safe(message)}`; els.toastRegion.append(toast);
  setTimeout(() => toast.remove(), 3200);
}

function motionOK() {
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function lateness(from, to) {
  const hours = Math.max(1, Math.floor((to - from) / 3_600_000));
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function stampDate(value) {
  const date = new Date(value);
  return `${String(date.getUTCDate()).padStart(2, "0")} ${MONTHS[date.getUTCMonth()]}`;
}

function readStorage(key, fallback) {
  try { const value = JSON.parse(localStorage.getItem(key)); return value ?? fallback; } catch { return fallback; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { announce("This browser did not allow local saving."); }
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function shortChecked(value) {
  return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(value));
}

function safe(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function attr(value) { return safe(value).replace(/`/g, "&#96;"); }

function sourceUrl(value) {
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : ""; } catch { return ""; }
}

function bellIcon() { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4" /></svg>`; }
function bookmarkIcon() { return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h12v17l-6-4-6 4V4Z" /></svg>`; }
