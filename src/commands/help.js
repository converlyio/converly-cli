/**
 * Help search, help articles and contacting Converly support.
 *
 * The same handlers sit behind the assistant (MCP) tools
 * search_converly_help and contact_converly_support, so the CLI keeps no
 * wording of its own here: it prints the server's assistant_guidance.
 */

import { ApiError, apiRequest } from "../http.js";

const HELP_ORIGIN = "https://help.converly.io";

export async function search({ args, origin }) {
  const q = (args ?? []).join(" ").trim();
  if (!q) {
    throw new Error('Say what to search for, e.g. converly docs search "cookie banner".');
  }
  return apiRequest(origin, "GET", "/help/search", { query: { q } });
}

/** A full help URL, or a path on the help site (`cookie-consent/how-…`). */
export function articleUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${HELP_ORIGIN}/${raw.replace(/^\/+/, "")}`;
}

export async function read({ args, origin }) {
  const url = articleUrl(args?.[0]);
  if (!url) {
    throw new Error("Say which article to read: converly docs read <url from docs search>.");
  }
  return apiRequest(origin, "GET", "/help/article", { query: { url } });
}

export const SUPPORT_KINDS = ["connection_problem", "form_tool_request", "delivery_problem", "question"];

export async function support({ flags, origin }) {
  // The user's yes comes first. Checked before anything is sent, like
  // `flows delete`, so an agent can't send on a whim mid-plan.
  if (flags.yes !== true) {
    throw new Error(
      "Ask the user before contacting Converly support, and send only once they say yes. Re-run with --yes to record that they agreed."
    );
  }
  const kind = typeof flags.kind === "string" ? flags.kind : "";
  if (!SUPPORT_KINDS.includes(kind)) {
    throw new Error(`--kind must be one of ${SUPPORT_KINDS.join(", ")}.`);
  }
  const message = typeof flags.message === "string" ? flags.message.trim() : "";
  if (!message) {
    throw new Error('--message says what happened and what was tried, e.g. --message "Meta connection fails after login".');
  }
  if (message.length > 2000) {
    throw new Error(`--message is ${message.length} characters; keep it to 2,000.`);
  }
  try {
    return await apiRequest(origin, "POST", "/support-requests", {
      body: {
        kind,
        message,
        ...(typeof flags.platform === "string" && { platform_or_tool: flags.platform }),
        ...(typeof flags.site === "string" && { site_id: flags.site }),
        confirmed_with_user: true,
      },
    });
  } catch (err) {
    // A request support refused (limit reached, not sent) answers with
    // assistant_guidance and no error envelope. Say what the server said.
    const guidance = err instanceof ApiError ? err.body?.assistant_guidance : null;
    if (guidance && typeof guidance.text === "string") {
      err.code = guidance.code ?? err.code;
      err.message = guidance.text;
      // Only an unknown outcome is worth retrying (with the same key, so
      // it can't send twice). A refusal or the daily limit is final.
      if (guidance.code !== "support_unknown") {
        err.retryable = false;
        err.idempotencyKey = undefined;
      }
    }
    throw err;
  }
}
