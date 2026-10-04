/**
 * A spend cap that actually stops: counts what each LLM response cost from its
 * own usage numbers, and refuses the next call — before it is made — once the
 * total reaches your cap. No billing pipeline in between, so no lag.
 *
 * Dependency-free. Copy this file into your project.
 *
 *   const breaker = new Breaker({ capUsd: 20, prices: { "my-model": { input: 3, output: 15 } } });
 *   const res = await breaker.run("my-model", () => client.messages.create({ ... }));
 *
 * Prices are dollars per million tokens. Set them from your provider's price
 * page: a wrong price here is a wrong cap.
 */

export type Price = { input: number; output: number; cacheWrite?: number; cacheRead?: number };

/** Anthropic Messages, OpenAI Chat Completions and OpenAI Responses usage objects. */
export type Usage = {
  input_tokens?: number; output_tokens?: number;
  cache_creation_input_tokens?: number; cache_read_input_tokens?: number;
  prompt_tokens?: number; completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
};

export interface Store { get(): number; set(total: number): void }
export const memoryStore = (start = 0): Store => { let v = start; return { get: () => v, set: (x) => { v = x; } }; };

export class BudgetExceeded extends Error {
  constructor(public spent: number, public cap: number) {
    super(`Spend cap reached: $${spent.toFixed(4)} of $${cap.toFixed(2)}. Refusing further calls.`);
    this.name = "BudgetExceeded";
  }
}

export class Breaker {
  readonly cap: number;
  private prices: Record<string, Price>;
  private store: Store;
  private onTrip?: (spent: number) => void;
  private tripped = false;

  constructor(o: { capUsd: number; prices: Record<string, Price>; store?: Store; onTrip?: (spent: number) => void }) {
    if (!(o.capUsd > 0)) throw new Error("capUsd must be a positive number of dollars");
    this.cap = o.capUsd; this.prices = o.prices; this.store = o.store ?? memoryStore(); this.onTrip = o.onTrip;
  }

  get spent() { return this.store.get(); }

  /** Dollars for one response. Unknown models throw: counting them as free would defeat the point. */
  cost(model: string, u: Usage): number {
    const p = this.prices[model];
    if (!p) throw new Error(`No price for model "${model}". Add it to prices — an unpriced model would never trip the breaker.`);
    const read = p.cacheRead ?? p.input, write = p.cacheWrite ?? p.input;
    let input: number, cached: number, created = 0, output: number;
    if (u.prompt_tokens !== undefined) {
      // OpenAI Chat Completions: prompt_tokens includes the cached ones.
      cached = u.prompt_tokens_details?.cached_tokens ?? 0;
      input = u.prompt_tokens - cached;
      output = u.completion_tokens ?? 0;
    } else if (u.input_tokens_details) {
      // OpenAI Responses: input_tokens includes the cached ones.
      cached = u.input_tokens_details.cached_tokens ?? 0;
      input = (u.input_tokens ?? 0) - cached;
      output = u.output_tokens ?? 0;
    } else {
      // Anthropic Messages: cache reads and writes are reported separately from input_tokens.
      input = u.input_tokens ?? 0;
      cached = u.cache_read_input_tokens ?? 0;
      created = u.cache_creation_input_tokens ?? 0;
      output = u.output_tokens ?? 0;
    }
    return (input * p.input + cached * read + created * write + output * p.output) / 1e6;
  }

  /** Throw if spending `estimateUsd` more would pass the cap. Call before making a request. */
  check(estimateUsd = 0) {
    const s = this.spent;
    if (s >= this.cap || s + estimateUsd > this.cap) throw new BudgetExceeded(s, this.cap);
  }

  /** Add a response's cost. Returns the new total; trips the breaker if it has reached the cap. */
  record(model: string, usage: Usage): number {
    const total = this.spent + this.cost(model, usage);
    this.store.set(total);
    if (total >= this.cap && !this.tripped) { this.tripped = true; this.onTrip?.(total); }
    return total;
  }

  /** check → call → record. The call is never made once the cap is reached. */
  async run<T>(model: string, call: () => Promise<T>, opts: { usage?: (r: T) => Usage | undefined; estimateUsd?: number } = {}): Promise<T> {
    this.check(opts.estimateUsd ?? 0);
    const r = await call();
    const usage = opts.usage ? opts.usage(r) : (r as unknown as { usage?: Usage }).usage;
    if (!usage) throw new Error("The response carried no usage numbers, so its cost cannot be counted. Pass opts.usage.");
    this.record(model, usage);
    return r;
  }
}
