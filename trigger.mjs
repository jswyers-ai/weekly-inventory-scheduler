import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const TIME_ZONE = "America/New_York";
export const REPORT_PATH = "/api/inventory-reports/weekly/run";
const REQUEST_TIMEOUT_MS = 90_000;

export class JobError extends Error {}

const calendar = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function localParts(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new JobError("Invalid job date.");
  }
  const parts = Object.fromEntries(calendar.formatToParts(date)
    .filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  return parts;
}

function localMidnight(calendarDate) {
  const wallTime = calendarDate.getTime();
  let candidate = wallTime;
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = localParts(new Date(candidate));
    const observed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const adjustment = wallTime - observed;
    if (adjustment === 0) return new Date(candidate).toISOString();
    candidate += adjustment;
  }
  throw new JobError("Could not resolve the Eastern reporting-period boundary.");
}

export function reportingPeriod(now = new Date()) {
  const p = localParts(now);
  const today = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const daysSinceMonday = (today.getUTCDay() + 6) % 7;
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() - daysSinceMonday);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7);
  const weekStart = start.toISOString().slice(0, 10);
  return {
    weekStart,
    weekEndExclusive: end.toISOString().slice(0, 10),
    from: localMidnight(start),
    to: localMidnight(end),
    timeZone: TIME_ZONE,
    idempotencyKey: `parlor-inventory-weekly-${weekStart}`,
  };
}

function enabled(env) {
  const flag = env.INVENTORY_SCHEDULE_ENABLED;
  if (flag === undefined || flag === "" || flag === "false") return false;
  if (flag === "true") return true;
  throw new JobError("INVENTORY_SCHEDULE_ENABLED must be true or false.");
}

export function loadConfiguration(env) {
  let app;
  try { app = new URL(env.INVENTORY_APP_URL); }
  catch { throw new JobError("Set INVENTORY_APP_URL to the published inventory website's HTTPS origin."); }
  if (app.protocol !== "https:" || app.username || app.password || app.search || app.hash ||
      app.pathname !== "/" || app.port || isIP(app.hostname.replace(/^\[|\]$/g, "")) ||
      app.hostname === "localhost" || app.hostname.endsWith(".localhost") ||
      app.hostname.endsWith(".replit.dev")) {
    throw new JobError("Use a public production HTTPS origin without a path, credentials, query, or custom port.");
  }
  const token = env.INVENTORY_WEEKLY_JOB_TOKEN;
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
    throw new JobError("Configure the dedicated INVENTORY_WEEKLY_JOB_TOKEN securely; use 32–256 base64url characters.");
  }
  return { endpoint: new URL(REPORT_PATH, app).href, token };
}

function withinSendWindow(now) {
  const p = localParts(now);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return weekday === 1 && p.hour >= 7;
}

/**
 * This is a trigger, not a sender. The app must implement the documented
 * authenticated endpoint and durable delivery ledger before activation.
 * Check mode never makes a request, and is not an endpoint-readiness test.
 */
export async function runJob({
  env = process.env,
  now = new Date(),
  check = false,
  request = globalThis.fetch,
  log = console.log,
} = {}) {
  const active = enabled(env);
  if (!active && !check) {
    log("[weekly-inventory] Disabled. No request made.");
    return { status: "disabled" };
  }
  const config = loadConfiguration(env);
  const period = reportingPeriod(now);
  if (check) {
    log("[weekly-inventory] Configuration check only; no request made. Endpoint readiness is NOT verified.");
    log(JSON.stringify({
      endpoint: config.endpoint, scheduleEnabled: active,
      weekStart: period.weekStart, from: period.from, to: period.to, timeZone: TIME_ZONE,
    }));
    return { status: "checked", period };
  }
  if (!withinSendWindow(now)) {
    throw new JobError("Refusing to request a weekly email outside Monday, 7 AM–midnight Eastern. Use --check for a no-send check.");
  }

  let response;
  try {
    response = await request(config.endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.token}`,
        "Idempotency-Key": period.idempotencyKey,
      },
      body: JSON.stringify({
        weekStart: period.weekStart, weekEndExclusive: period.weekEndExclusive,
        from: period.from, to: period.to, timeZone: TIME_ZONE,
      }),
    });
  } catch {
    throw new JobError("Request failed or timed out; delivery status may be unknown. Check the app's delivery ledger before rerunning. No automatic retry was attempted.");
  }
  if (response.status !== 200 || response.redirected) {
    throw new JobError(`App did not confirm delivery (HTTP ${response.status}). Check the app's delivery ledger before rerunning. No automatic retry was attempted.`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(contentType)) {
    throw new JobError("App returned a non-JSON response; delivery was not confirmed. Check the app before rerunning.");
  }
  let result;
  try { result = await response.json(); }
  catch { throw new JobError("App returned invalid JSON; delivery was not confirmed. Check the app before rerunning."); }
  if (!result || !["sent", "already_sent"].includes(result.status) ||
      result.weekStart !== period.weekStart ||
      typeof result.messageId !== "string" || result.messageId.length === 0 ||
      result.messageId.length > 200) {
    throw new JobError("App did not return the required weekly-delivery confirmation. It may be disabled, incomplete, or require review. No automatic retry was attempted.");
  }
  log(result.status === "sent"
    ? `[weekly-inventory] Email provider accepted the ${period.weekStart} report.`
    : `[weekly-inventory] The ${period.weekStart} report was already sent; no duplicate requested.`);
  return { status: result.status, weekStart: period.weekStart };
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== "--check") || args.length > 1) {
    throw new JobError("Usage: node trigger.mjs [--check]");
  }
  return runJob({ check: args.includes("--check") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`[weekly-inventory] ${error instanceof JobError
      ? error.message
      : "Unexpected job failure. Check the app's delivery ledger before rerunning; no automatic retry was attempted."}`);
    process.exitCode = 1;
  });
}
