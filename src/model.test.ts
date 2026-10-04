import { SCENARIOS, GUARDS, defaults, curve, crossing, at, actAt, outcome, simulate, clock, money, type Night } from "./model";

let pass = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean) => { if (c) pass++; else fails.push(n); };
const near = (n: string, a: number, b: number, tol: number) => ok(`${n} (got ${a}, want ${b} ±${tol})`, Math.abs(a - b) <= tol);
const S = (id: string) => SCENARIOS.find((s) => s.id === id)!;
const G = (id: string) => GUARDS.find((g) => g.id === id)!;

/* ── burn rates, by hand ────────────────────────────────────────────────── */
{
  const gpu = S("gpu"), c = curve(gpu, defaults(gpu), 120);
  near("8 GPUs at $4/h cost $32 in an hour", c[60], 32, 1e-9);
  const eg = S("egress"), ce = curve(eg, defaults(eg), 60);
  near("500 GB/h at $0.09 is $45 an hour", ce[60], 45, 1e-9);
  const key = S("key"), ck = curve(key, defaults(key), 10);
  near("2M tokens/min at $15/M is $30 a minute", ck[1], 30, 1e-9);
}
{
  // The agent: each turn resends a longer conversation.
  const a = S("agent"), p = defaults(a);
  near("first minute: 6 requests of 8k in + 1k out", a.rate(0, p), 6 * (8000 * 3 + 1000 * 15) / 1e6, 1e-12);
  ok("the rate accelerates as context accumulates", a.rate(10, p) > a.rate(1, p) * 3);
  const plateau = 6 * (200000 * 3 + 1000 * 15) / 1e6;
  near("then plateaus at the context window ($3.69/min)", a.rate(60, p), plateau, 1e-12);
  near("and stays there", a.rate(600, p), plateau, 1e-12);
  ok("plateau is reached after (200k−8k)/2k = 96 turns, 16 minutes in", a.rate(15.9, p) < plateau && a.rate(16.1, p) === plateau);
  const c = curve(a, p, 8 * 60);
  ok(`a night of it costs over $1,700 (got ${money(c[480])})`, c[480] > 1700 && c[480] < 1800);
  const two = { ...p, agents: 2 };
  near("two agents cost twice as much", curve(a, two, 120)[120], 2 * curve(a, p, 120)[120], 1e-6);
}
{
  const r = S("recursion"), p = defaults(r);
  ok("recursion starts tiny", r.rate(0.001, p) < 0.01);
  const plateau = 60 * (1000 / 1) * (0.2 / 1e6 + 1 * 1 * 0.0000166667);
  near("and saturates at the concurrency limit (~$1.01/min)", r.rate(10, p), plateau, 1e-9);
}

/* ── crossing a threshold ───────────────────────────────────────────────── */
{
  const key = S("key"), c = curve(key, defaults(key), 60);
  near("$30/min crosses $100 at 3⅓ minutes", crossing(c, 100)!, 10 / 3, 1e-9);
  near("interpolation between minutes", at(c, 2.5), 75, 1e-9);
  ok("a threshold never reached returns null", crossing(curve(S("gpu"), { count: 1, hourly: 0.01 }, 60), 1e6) === null);
}

/* ── the person in the loop ─────────────────────────────────────────────── */
{
  const night: Night = { start: 23 * 60 + 40, sleep: 23 * 60 + 30, wake: 24 * 60 + 7 * 60 + 30, read: 15, fix: 10, threshold: 100 };
  near("an alert at night is read after you wake", actAt(1, night), (24 * 60 + 7 * 60 + 30) + 15 - (23 * 60 + 40) + 10, 1e-9);
  const evening: Night = { ...night, start: 20 * 60 };
  near("an alert while you're up is read in 15 minutes", actAt(10, evening), 10 + 15 + 10, 1e-9);
  near("an alert after you wake is read straight away", actAt(12 * 60, night), 12 * 60 + 15 + 10, 1e-9);
}

/* ── guardrails, compared on the same runaway ───────────────────────────── */
{
  const night: Night = { start: 23 * 60 + 40, sleep: 23 * 60 + 30, wake: 24 * 60 + 7 * 60 + 30, read: 15, fix: 10, threshold: 100 };
  const a = S("agent"), sim = simulate(a, defaults(a), night);
  const typ = (id: string) => sim.outcomes.find((o) => o.g.id === id)!.typical.cost;
  near("a breaker in your code stops at the threshold", typ("breaker"), 100, 0.01);
  near("so does an instant provider limit", typ("org-limit"), 100, 0.01);
  ok(`Vercel pausing overshoots by minutes, not hours (${money(typ("vercel-pause"))})`, typ("vercel-pause") > 100 && typ("vercel-pause") < 130);
  ok(`an AWS alert overnight costs far more than the alert amount (${money(typ("aws"))})`, typ("aws") > 1500);
  ok(`an Azure alert costs more again (${money(typ("azure"))})`, typ("azure") > typ("aws"));
  ok("an alert at night costs the same whether it lands at 1am or 6am", Math.abs(sim.outcomes.find((o) => o.g.id === "vercel-alert")!.typical.cost - typ("gcp")) < 1);
  for (const o of sim.outcomes) {
    ok(`${o.g.id}: latest ≥ typical ≥ soonest`, o.latest.cost >= o.typical.cost - 1e-9 && o.typical.cost >= o.soonest.cost - 1e-9);
    ok(`${o.g.id}: never less than the threshold once crossed`, o.typical.cost >= 100 - 1e-6);
  }
  ok("every guardrail cites a source", GUARDS.every((g) => g.url.startsWith("https://") || g.url === "#fix"));
  // Provider documentation is quoted in a phrase, not reproduced: under 15 words each, the rest in our words.
  for (const g of GUARDS) ok(`${g.id}: verbatim quote under 15 words (${g.quote.split(/\s+/).length})`, g.quote.split(/\s+/).length < 15 && g.says.length > 40);
  ok("lags are ordered", GUARDS.every((g) => g.lag[0] <= g.lag[1]));
  const none = outcome(curve(S("gpu"), { count: 1, hourly: 0.001 }, 60), G("aws"), night);
  ok("if the threshold is never reached, nothing is stopped", none.crossAt === null && !none.stopped);
}

/* ── words ──────────────────────────────────────────────────────────────── */
ok("23:40", clock(23 * 60 + 40) === "23:40");
ok("07:30 next day", clock(24 * 60 + 7 * 60 + 30) === "07:30 +1");
ok("money small", money(100) === "$100.00");
ok("money big", money(12345.6) === "$12,346");
ok("money huge", money(2_500_000) === "$2.50M");

console.log(fails.length ? `✗ ${fails.length} failed of ${pass + fails.length}` : `✓ ${pass} assertions pass`);
for (const f of fails) console.log("  ✗", f);
process.exit(fails.length ? 1 : 0);
