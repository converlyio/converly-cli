/**
 * Event commands — the read side. Listing recent conversions, checking
 * delivery health, per-event diagnostics.
 */

import { apiRequest } from "../http.js";
import { assertIdSegment } from "./ids.js";
import { hasKnownReason, withReasons } from "../output.js";

export async function list({ flags, origin }) {
  return apiRequest(origin, "GET", "/events", {
    query: {
      site_id: flags.site,
      flow_id: flags.flow,
      email: flags.email,
      status: flags.status,
      occurred_after: flags.since,
      occurred_before: flags.until,
      limit: flags.limit,
    },
  });
}

export async function get({ args, origin }) {
  const event = await apiRequest(
    origin,
    "GET",
    `/events/${assertIdSegment(args[0], "event id")}`
  );
  // A plain `reason` next to each known error_code, for people and agents
  // alike (the code alone, e.g. destination_not_connected, says what but
  // not what to do).
  // The event carries the site KEY; the suggested commands need the site
  // id. Look it up only when there is a reason to show, and never let the
  // lookup fail the command — the placeholder <site_id> is the fallback.
  let site = null;
  if (hasKnownReason(event) && event.site_key) {
    try {
      const sites = await apiRequest(origin, "GET", "/sites", { query: { limit: 100 } });
      const match = (sites?.data ?? []).find((s) => s.site_key === event.site_key);
      site = match?.id ?? null;
    } catch {
      site = null;
    }
  }
  return withReasons(event, { origin, site });
}
