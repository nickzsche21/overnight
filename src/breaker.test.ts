import { Breaker, BudgetExceeded, memoryStore } from "./breaker";

let pass = 0;
const fails: string[] = [];
const ok = (n: string, c: boolean) => { if (c) pass++; else fails.push(n); };
const near = (n: string, a: number, b: number, tol = 1e-12) => ok(`${n} (got ${a}, want ${b})`, Math.abs(a - b) <= tol);
const throws = async (n: string, f: () => unknown, kind?: new (...a: never[]) => Error) => {
  try { await f(); fails.push(`${n} (did not throw)`); } catch (e) { ok(n, kind ? e instanceof kind : true); }
};

const prices = { m: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } };

async function main() {
  const b = new Breaker({ capUsd: 1, prices });
  near("Anthropic usage, with cache", b.cost("m", { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 10000 }),
    (1000 * 3 + 500 * 15 + 2000 * 3.75 + 10000 * 0.3) / 1e6);
  near("OpenAI chat: cached tokens are inside prompt_tokens", b.cost("m", { prompt_tokens: 12000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 10000 } }),
    (2000 * 3 + 10000 * 0.3 + 500 * 15) / 1e6);
  near("OpenAI responses: same, under input_tokens_details", b.cost("m", { input_tokens: 12000, output_tokens: 500, input_tokens_details: { cached_tokens: 10000 } }),
    (2000 * 3 + 10000 * 0.3 + 500 * 15) / 1e6);
  near("no cache prices means cache tokens bill at the input price", new Breaker({ capUsd: 1, prices: { x: { input: 2, output: 4 } } }).cost("x", { input_tokens: 0, cache_read_input_tokens: 1e6 }), 2);
  await throws("an unpriced model is refused, not counted as free", () => b.cost("nope", { input_tokens: 1 }));
  await throws("a cap of zero is refused", () => new Breaker({ capUsd: 0, prices }));

  // A runaway agent: each turn resends a longer conversation.
  let calls = 0, turn = 0, trippedAt = -1;
  const agent = new Breaker({ capUsd: 5, prices, onTrip: (s) => { trippedAt = s; } });
  const fakeCall = async () => { calls++; turn++; return { usage: { input_tokens: 8000 + turn * 2000, output_tokens: 1000 } }; };
  let stoppedBy: unknown = null;
  for (let i = 0; i < 10_000; i++) {
    try { await agent.run("m", fakeCall); } catch (e) { stoppedBy = e; break; }
  }
  ok("the loop is stopped by BudgetExceeded", stoppedBy instanceof BudgetExceeded);
  const last = 3 * (8000 + turn * 2000) / 1e6 + 15 * 1000 / 1e6;
  ok(`it stops within one request of the cap ($${agent.spent.toFixed(4)})`, agent.spent >= 5 && agent.spent < 5 + last);
  ok(`onTrip fired once, at the crossing ($${trippedAt.toFixed(4)})`, trippedAt >= 5);
  const before = calls;
  await throws("once tripped, run() refuses", () => agent.run("m", fakeCall), BudgetExceeded);
  ok("and does not make the call", calls === before);

  // Refuse before spending, using an estimate.
  const e = new Breaker({ capUsd: 1, prices });
  e.record("m", { input_tokens: 300_000 }); // $0.90
  await throws("a request whose estimate would pass the cap is refused up front", () => e.check(0.2), BudgetExceeded);
  ok("a smaller one is allowed", (() => { try { e.check(0.05); return true; } catch { return false; } })());

  // Two workers sharing one store share one cap.
  const shared = memoryStore();
  const w1 = new Breaker({ capUsd: 1, prices, store: shared }), w2 = new Breaker({ capUsd: 1, prices, store: shared });
  w1.record("m", { input_tokens: 200_000 }); w2.record("m", { input_tokens: 200_000 });
  near("a shared store adds both workers' spend", shared.get(), 1.2, 1e-9);
  await throws("so either one refuses", () => w1.check(), BudgetExceeded);

  await throws("a response without usage is an error, not free", () => new Breaker({ capUsd: 1, prices }).run("m", async () => ({})));

  console.log(fails.length ? `✗ ${fails.length} failed of ${pass + fails.length}` : `✓ ${pass} assertions pass`);
  for (const f of fails) console.log("  ✗", f);
  process.exit(fails.length ? 1 : 0);
}
main();
