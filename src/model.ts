/**
 * What a runaway costs between the moment it starts and the moment it stops.
 *
 * The argument of the whole page is one subtraction: a budget *alert* fires
 * when billing data catches up, a person reads it when they wake, and only
 * then does the spending stop. Everything between crossing your threshold and
 * that moment is paid for. Time is in minutes from the start of the runaway;
 * money in US dollars.
 */

/* ── how fast money leaves ────────────────────────────────────────────────── */

export type Param = { key: string; label: string; unit: string; value: number; step: number; min: number };

export type Scenario = {
  id: string;
  label: string;
  story: string;
  params: Param[];
  /** Dollars per minute, t minutes after it started, given the params. */
  rate: (t: number, p: Record<string, number>) => number;
};

const P = (key: string, label: string, unit: string, value: number, step = 1, min = 0): Param => ({ key, label, unit, value, step, min });

export const SCENARIOS: Scenario[] = [
  {
    id: "agent",
    label: "Agent stuck in a loop",
    story: "A coding or research agent retries the same step all night. Every turn resends the whole conversation, so each request costs more than the last until it hits the context window.",
    params: [
      P("agents", "agents running", "", 1, 1, 1),
      P("rpm", "requests per minute, each", "/min", 6, 1, 0),
      P("base", "first request", "tokens", 8000, 1000),
      P("growth", "context added per turn", "tokens", 2000, 500),
      P("window", "context window", "tokens", 200000, 10000),
      P("out", "output per request", "tokens", 1000, 100),
      P("pin", "input price", "$ / M tokens", 3, 0.25),
      P("pout", "output price", "$ / M tokens", 15, 0.25),
    ],
    rate: (t, p) => {
      // Turn n has input base + n·growth, capped at the window.
      const n = Math.floor(t * p.rpm);
      const input = Math.min(p.base + n * p.growth, p.window);
      return p.agents * p.rpm * (input * p.pin + p.out * p.pout) / 1e6;
    },
  },
  {
    id: "key",
    label: "Leaked API key",
    story: "A key ends up in a public repo or a client bundle. Whoever finds it runs it as hard as your rate limit allows.",
    params: [
      P("tpm", "your output-token rate limit", "tokens / min", 2_000_000, 100_000),
      P("pout", "output price", "$ / M tokens", 15, 0.25),
    ],
    rate: (_t, p) => (p.tpm * p.pout) / 1e6,
  },
  {
    id: "recursion",
    label: "Function calling itself",
    story: "A serverless function triggers itself — a bucket event that writes to the same bucket, a queue consumer that re-enqueues. Invocations double every round until they hit your concurrency limit.",
    params: [
      P("concurrency", "concurrency limit", "at once", 1000, 100, 1),
      P("seconds", "duration of one run", "s", 1, 0.1, 0.01),
      P("memory", "memory", "GB", 1, 0.25, 0.125),
      P("perMillion", "price per million invocations", "$", 0.2, 0.01),
      P("gbSecond", "price per GB-second", "$", 0.0000166667, 0.000001),
    ],
    rate: (t, p) => {
      const generation = (t * 60) / p.seconds;
      const running = Math.min(p.concurrency, Math.pow(2, generation));
      const perSecond = running / p.seconds;
      return 60 * perSecond * (p.perMillion / 1e6 + p.memory * p.seconds * p.gbSecond);
    },
  },
  {
    id: "gpu",
    label: "GPU boxes left on",
    story: "A training run finished at midnight. The instances did not.",
    params: [P("count", "instances", "", 8, 1, 1), P("hourly", "price per instance", "$ / hour", 4, 0.1)],
    rate: (_t, p) => (p.count * p.hourly) / 60,
  },
  {
    id: "egress",
    label: "Hotlinked file / scraper",
    story: "Something big on your storage gets linked from a busy site, or a crawler finds it and never stops.",
    params: [P("gbh", "data out", "GB / hour", 500, 10), P("perGb", "egress price", "$ / GB", 0.09, 0.01)],
    rate: (_t, p) => (p.gbh * p.perGb) / 60,
  },
];

export const defaults = (s: Scenario) => Object.fromEntries(s.params.map((x) => [x.key, x.value]));

/** Cumulative cost, minute by minute, for `minutes` minutes. cost[i] is the total after i minutes. */
export function curve(s: Scenario, p: Record<string, number>, minutes: number): Float64Array {
  const out = new Float64Array(minutes + 1);
  for (let i = 1; i <= minutes; i++) {
    // Midpoint of each minute: exact for constant rates, close for the curves.
    out[i] = out[i - 1] + s.rate(i - 0.5, p);
  }
  return out;
}

export const at = (c: Float64Array, t: number) => {
  if (t <= 0) return 0;
  if (t >= c.length - 1) return c[c.length - 1];
  const i = Math.floor(t), f = t - i;
  return c[i] + (c[i + 1] - c[i]) * f;
};

/** First minute the total reaches `amount`, or null if it never does. */
export function crossing(c: Float64Array, amount: number): number | null {
  for (let i = 1; i < c.length; i++) {
    if (c[i] >= amount) {
      const f = (amount - c[i - 1]) / (c[i] - c[i - 1] || 1);
      return i - 1 + f;
    }
  }
  return null;
}

/* ── what stops it ────────────────────────────────────────────────────────── */

export type Guard = {
  id: string;
  label: string;
  /** alert: a person must act. stop: the platform stops it. */
  kind: "alert" | "stop";
  /** Minutes between crossing the threshold and the alert or stop: [soonest, latest]. */
  lag: [number, number];
  /** A few words verbatim from the provider's documentation. */
  quote: string;
  /** What the documentation says, in our words. */
  says: string;
  url: string;
  caveat?: string;
};

export const GUARDS: Guard[] = [
  {
    id: "aws", label: "AWS Budgets alert", kind: "alert", lag: [0, 12 * 60],
    quote: "Updates typically occur 8–12 hours after the previous update.",
    says: "Budget data refreshes up to three times a day, and alerts go out on that cadence — so an alert can trail the spending by up to half a day.",
    url: "https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html",
  },
  {
    id: "azure", label: "Azure budget alert", kind: "alert", lag: [8 * 60, 48 * 60],
    quote: "Resources aren't affected, and your consumption isn't stopped.",
    says: "Cost data typically arrives within 8 to 24 hours, and budgets are evaluated against it once every 24 hours.",
    url: "https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets",
    caveat: "8–24 hours for the data, then up to 24 more until the next evaluation.",
  },
  {
    id: "gcp", label: "Google Cloud budget alert", kind: "alert", lag: [3 * 60, 8 * 60],
    quote: "the budget doesn't automatically set a hard cap on spending.",
    says: "Usage takes time to reach Cloud Billing, and the first alert can take several hours. Spend-cap budgets exist in preview for some services.",
    url: "https://cloud.google.com/billing/docs/how-to/budgets",
    caveat: "Google says “several hours”; modelled here as 3–8.",
  },
  {
    id: "vercel-alert", label: "Vercel spend alert", kind: "alert", lag: [2, 10],
    quote: "This check happens every few minutes.",
    says: "Spend is checked periodically rather than continuously, so notifications and webhooks can land several minutes after you cross the amount.",
    url: "https://vercel.com/docs/spend-management",
  },
  {
    id: "vercel-pause", label: "Vercel, with pausing on", kind: "stop", lag: [2, 10],
    quote: "Setting a spend amount does not stop usage on its own.",
    says: "Turn on Pause Production Deployments and Vercel pauses your projects when the amount is reached — a few minutes late, because of the same periodic check.",
    url: "https://vercel.com/docs/spend-management",
    caveat: "Pausing does not cover AI Gateway or v0 usage billed to your team.",
  },
  {
    id: "org-limit", label: "LLM provider spend limit", kind: "stop", lag: [0, 0],
    quote: "Spend limits set a maximum monthly cost an organization can incur",
    says: "Anthropic enforces a monthly spend limit per organization, configurable per workspace; OpenAI lets you configure spend limits for an organization or project.",
    url: "https://docs.anthropic.com/en/api/rate-limits",
    caveat: "How fast the limit bites is not documented, so it is modelled as instant — the best case. It is monthly, so it only helps if it is near what you would actually lose.",
  },
  {
    id: "breaker", label: "A breaker in your own code", kind: "stop", lag: [0, 0],
    quote: "Refuses the next request once the total reaches your cap.",
    says: "Counts the cost of every response from its own usage numbers as it arrives. No billing pipeline in between, so no lag.",
    url: "#fix",
  },
];

/* ── the night ────────────────────────────────────────────────────────────── */

export type Night = {
  /** Clock minutes after midnight on the first evening; may exceed 1440 for the next morning. */
  start: number;   // the runaway begins
  sleep: number;   // you fall asleep
  wake: number;    // you wake up
  /** Minutes from waking to reading the alert, and from reading it to stopping the thing. */
  read: number;
  fix: number;
  threshold: number;
};

export type Outcome = {
  guard: Guard;
  crossAt: number | null;   // minutes after start
  noticeAt: number | null;  // alert arrives (alert kind), or platform stops (stop kind)
  stopAt: number | null;
  cost: number;             // what it cost by the time it stopped (or by the horizon)
  stopped: boolean;
};

const HORIZON = 72 * 60;

/** When a person actually acts on an alert that arrives `arrive` minutes after the runaway started. */
export function actAt(arrive: number, n: Night): number {
  const clock = n.start + arrive;
  // Asleep between sleep and wake (sleep may be before or after the start).
  const asleep = clock >= n.sleep && clock < n.wake;
  const readAt = asleep ? n.wake + n.read : clock + n.read;
  return readAt - n.start + n.fix;
}

export function outcome(c: Float64Array, g: Guard, n: Night, which: "soonest" | "typical" | "latest" = "typical"): Outcome {
  const cross = crossing(c, n.threshold);
  if (cross === null) return { guard: g, crossAt: null, noticeAt: null, stopAt: null, cost: c[c.length - 1], stopped: false };
  const lag = which === "soonest" ? g.lag[0] : which === "latest" ? g.lag[1] : (g.lag[0] + g.lag[1]) / 2;
  const notice = cross + lag;
  const stop = g.kind === "stop" ? notice : actAt(notice, n);
  const end = Math.min(stop, c.length - 1);
  return { guard: g, crossAt: cross, noticeAt: notice, stopAt: stop, cost: at(c, end), stopped: stop <= c.length - 1 };
}

export function simulate(s: Scenario, p: Record<string, number>, n: Night) {
  const c = curve(s, p, HORIZON);
  return { curve: c, outcomes: GUARDS.map((g) => ({ g, soonest: outcome(c, g, n, "soonest"), typical: outcome(c, g, n, "typical"), latest: outcome(c, g, n, "latest") })) };
}

export const HOURS = HORIZON / 60;

/** "23:40", wrapping past midnight, with a +1 for the next day. */
export function clock(minutesAfterMidnight: number): string {
  const day = Math.floor(minutesAfterMidnight / 1440);
  const m = ((Math.round(minutesAfterMidnight) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}${day > 0 ? ` +${day}` : ""}`;
}

export function money(x: number): string {
  if (x >= 1e6) return `$${(x / 1e6).toFixed(2)}M`;
  if (x >= 10_000) return `$${Math.round(x).toLocaleString("en-US")}`;
  return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
