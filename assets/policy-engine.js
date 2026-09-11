/**
 * FIRSTLIGHT policy evidence engine.
 *
 * This module is intentionally UI-agnostic. It turns evidence and time context
 * into a display state without making a legal eligibility decision for the user.
 */

export const POLICY_STAGES = Object.freeze({
  ANNOUNCED: "announced",
  ADOPTED: "adopted",
  SIGNED: "signed",
  EFFECTIVE: "effective",
  SUSPENDED: "suspended",
  EXPIRED: "expired",
  UNCERTAIN: "uncertain"
});

export const TRUTH_STATES = Object.freeze({
  YES: "yes",
  NO: "no",
  MAYBE: "maybe",
  CONFLICT: "conflict"
});

export const PASSPORTS = Object.freeze([
  ["DZA", "Algeria", "North Africa"], ["EGY", "Egypt", "North Africa"],
  ["LBY", "Libya", "North Africa"], ["MAR", "Morocco", "North Africa"],
  ["ESH", "Sahrawi Arab Democratic Republic / Western Sahara", "North Africa"],
  ["TUN", "Tunisia", "North Africa"],
  ["BEN", "Benin", "West Africa"], ["BFA", "Burkina Faso", "West Africa"],
  ["CPV", "Cabo Verde", "West Africa"], ["CIV", "Côte d’Ivoire", "West Africa"],
  ["GMB", "The Gambia", "West Africa"], ["GHA", "Ghana", "West Africa"],
  ["GIN", "Guinea", "West Africa"], ["GNB", "Guinea-Bissau", "West Africa"],
  ["LBR", "Liberia", "West Africa"], ["MLI", "Mali", "West Africa"],
  ["MRT", "Mauritania", "West Africa"], ["NER", "Niger", "West Africa"],
  ["NGA", "Nigeria", "West Africa"], ["SEN", "Senegal", "West Africa"],
  ["SLE", "Sierra Leone", "West Africa"], ["TGO", "Togo", "West Africa"],
  ["CMR", "Cameroon", "Central Africa"], ["CAF", "Central African Republic", "Central Africa"],
  ["TCD", "Chad", "Central Africa"], ["COG", "Republic of the Congo", "Central Africa"],
  ["COD", "DR Congo", "Central Africa"], ["GNQ", "Equatorial Guinea", "Central Africa"],
  ["GAB", "Gabon", "Central Africa"], ["STP", "São Tomé and Príncipe", "Central Africa"],
  ["BDI", "Burundi", "East Africa & islands"], ["COM", "Comoros", "East Africa & islands"],
  ["DJI", "Djibouti", "East Africa & islands"], ["ERI", "Eritrea", "East Africa & islands"],
  ["ETH", "Ethiopia", "East Africa & islands"], ["KEN", "Kenya", "East Africa & islands"],
  ["MDG", "Madagascar", "East Africa & islands"], ["MUS", "Mauritius", "East Africa & islands"],
  ["RWA", "Rwanda", "East Africa & islands"], ["SYC", "Seychelles", "East Africa & islands"],
  ["SOM", "Somalia", "East Africa & islands"], ["SSD", "South Sudan", "East Africa & islands"],
  ["SDN", "Sudan", "East Africa & islands"], ["TZA", "Tanzania", "East Africa & islands"],
  ["UGA", "Uganda", "East Africa & islands"],
  ["AGO", "Angola", "Southern Africa"], ["BWA", "Botswana", "Southern Africa"],
  ["SWZ", "Eswatini", "Southern Africa"], ["LSO", "Lesotho", "Southern Africa"],
  ["MWI", "Malawi", "Southern Africa"], ["MOZ", "Mozambique", "Southern Africa"],
  ["NAM", "Namibia", "Southern Africa"], ["ZAF", "South Africa", "Southern Africa"],
  ["ZMB", "Zambia", "Southern Africa"], ["ZWE", "Zimbabwe", "Southern Africa"],
  ["OTHER", "Outside Africa / verify", "Other"]
].map(([code, name, region]) => Object.freeze({ code, name, region })));

const PASSPORT_GROUPS = Object.freeze({
  EAC: ["BDI", "COD", "KEN", "RWA", "SOM", "SSD", "TZA", "UGA"],
  ECOWAS: ["BEN", "CPV", "CIV", "GMB", "GHA", "GIN", "GNB", "LBR", "NGA", "SEN", "SLE", "TGO"],
  SADC: ["AGO", "BWA", "COM", "COD", "SWZ", "LSO", "MDG", "MWI", "MUS", "MOZ", "NAM", "SYC", "ZAF", "TZA", "ZMB", "ZWE"],
  IGAD: ["DJI", "ERI", "ETH", "KEN", "SOM", "SSD", "SDN", "UGA"],
  AFR: PASSPORTS.filter((passport) => passport.code !== "OTHER").map((passport) => passport.code)
});

export function passportName(code) {
  return PASSPORTS.find((passport) => passport.code === code)?.name || "Selected";
}

const DAY_MS = 86_400_000;

function atStartOfDay(value) {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function daysBetween(from, to) {
  return Math.ceil((atStartOfDay(to) - atStartOfDay(from)) / DAY_MS);
}

export function relativeDateLabel(dateValue, now = new Date()) {
  if (!dateValue) return "Date not published";
  const days = daysBetween(now, dateValue);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days > 1) return `In ${days} days`;
  if (days === -1) return "Yesterday";
  return `${Math.abs(days)} days ago`;
}

export function formatCheckedAt(value) {
  if (!value) return "Never checked";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short"
  }).format(new Date(value));
}

function hasSourceConflict(item) {
  return item.evidence?.conflict === true;
}

function allSourcesUnavailable(item) {
  const sources = item.evidence?.sources || [];
  return sources.length > 0 && sources.every((source) => source.available === false);
}

function hasAuthoritativeSource(item) {
  return (item.evidence?.sources || []).some(
    (source) => source.available !== false && ["official", "gazette"].includes(source.authority)
  );
}

export function evaluatePolicy(item, now = new Date()) {
  const currentTime = new Date(now);
  const effectiveAt = item.timeline?.effectiveAt
    ? new Date(item.timeline.effectiveAt)
    : null;
  const endsAt = item.timeline?.endsAt ? new Date(item.timeline.endsAt) : null;
  const recheckAt = item.evidence?.recheckAt
    ? new Date(item.evidence.recheckAt)
    : null;

  const base = {
    policyStage: item.policyStage,
    effectiveAt: item.timeline?.effectiveAt || null,
    checkedAt: item.evidence?.checkedAt || null,
    sourceCount: item.evidence?.sources?.length || 0,
    canPromiseEligibility: false
  };

  if (hasSourceConflict(item)) {
    return {
      ...base,
      truthState: TRUTH_STATES.CONFLICT,
      displayState: "Authorities disagree",
      reason: "Relevant sources make incompatible claims. Treat the policy as unresolved.",
      nextAction: "Recheck both issuing authorities before planning or selling travel."
    };
  }

  if (allSourcesUnavailable(item)) {
    return {
      ...base,
      truthState: TRUTH_STATES.MAYBE,
      displayState: "Source removed — recheck",
      reason: "The previously observed source is no longer available.",
      nextAction: "Find a current issuing-authority source; do not infer continuity."
    };
  }

  if (!hasAuthoritativeSource(item)) {
    return {
      ...base,
      truthState: TRUTH_STATES.MAYBE,
      displayState: "Authority not verified",
      reason: "No available official source supports this signal.",
      nextAction: "Verify with the issuing authority before relying on it."
    };
  }

  if (
    item.policyStage === POLICY_STAGES.SUSPENDED ||
    item.policyStage === POLICY_STAGES.EXPIRED ||
    (endsAt && currentTime > endsAt)
  ) {
    return {
      ...base,
      truthState: TRUTH_STATES.NO,
      displayState:
        item.policyStage === POLICY_STAGES.SUSPENDED ? "Suspended" : "Expired",
      reason: "The observed benefit is not currently live.",
      nextAction: "Do not present this as an available traveller benefit."
    };
  }

  if (recheckAt && currentTime > recheckAt) {
    return {
      ...base,
      truthState: TRUTH_STATES.MAYBE,
      displayState: "Evidence stale — recheck",
      reason: "The evidence has passed its review-by time.",
      nextAction: "Refresh the authoritative source before acting."
    };
  }

  if (item.evidence?.volatile === true) {
    return {
      ...base,
      truthState: TRUTH_STATES.MAYBE,
      displayState: "Live price — recheck now",
      reason: "This carrier-page observation is time-sensitive inventory, not a held fare.",
      nextAction: "Reprice the complete itinerary before taking payment or committing suppliers."
    };
  }

  if (
    effectiveAt &&
    currentTime < effectiveAt
  ) {
    return {
      ...base,
      truthState: TRUTH_STATES.MAYBE,
      displayState: `${titleCase(item.policyStage)} — future effect`,
      reason: `The policy is recorded, but does not take effect until ${formatDate(
        effectiveAt
      )}.`,
      nextAction: "Monitor implementation; do not represent it as live eligibility."
    };
  }

  if (item.policyStage !== POLICY_STAGES.EFFECTIVE) {
    return {
      ...base,
      truthState: TRUTH_STATES.MAYBE,
      displayState: titleCase(item.policyStage),
      reason: "The policy has not been observed in an effective state.",
      nextAction: "Wait for an effective notice and recheck entry conditions."
    };
  }

  return {
    ...base,
    truthState: TRUTH_STATES.YES,
    displayState: "Effective — source current",
    reason: "A current official source supports the policy state at the checked time.",
    nextAction: "Use as a planning signal and independently confirm before departure.",
    canPromiseEligibility: false
  };
}

export function evaluateWindow(item, now = new Date()) {
  const opensAt = item.window?.opensAt ? new Date(item.window.opensAt) : null;
  const closesAt = item.window?.closesAt ? new Date(item.window.closesAt) : null;
  const currentTime = new Date(now);

  if (opensAt && currentTime < opensAt) {
    return {
      state: "opens",
      label: `Opens ${relativeDateLabel(opensAt, currentTime).toLowerCase()}`,
      days: daysBetween(currentTime, opensAt)
    };
  }
  if (closesAt && currentTime <= closesAt) {
    const days = daysBetween(currentTime, closesAt);
    return {
      state: "live",
      label: days === 0 ? "Closes today" : `${days} day${days === 1 ? "" : "s"} left`,
      days
    };
  }
  if (closesAt && currentTime > closesAt) {
    return { state: "closed", label: "Window closed", days: 0 };
  }
  return { state: "monitor", label: "No fixed window", days: null };
}

export function formatDate(value) {
  if (!value) return "Not published";
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(value));
}

export function titleCase(value = "") {
  return value
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function passportView(item, passportCode) {
  let view = item.passportImpact?.[passportCode];
  if (!view && passportCode !== "OTHER") {
    const group = ["EAC", "ECOWAS", "SADC", "IGAD", "AFR"].find(
      (code) => PASSPORT_GROUPS[code]?.includes(passportCode) && item.passportImpact?.[code]
    );
    if (group) view = item.passportImpact[group];
  }
  view ||= item.passportImpact?.default;
  if (!view) {
    return {
      relevance: "verify",
      scoreDelta: 0,
      note: "Passport-specific impact not modelled."
    };
  }
  return view;
}

export function adjustedScore(item, passportCode) {
  const delta = passportView(item, passportCode).scoreDelta || 0;
  return Math.max(0, Math.min(100, item.arbitrageScore + delta));
}

export function compareOpportunities(a, b, passportCode) {
  return adjustedScore(b, passportCode) - adjustedScore(a, passportCode);
}
