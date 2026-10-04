# OVERNIGHT

**What your bill does while you sleep.**

A budget **alert** is not a **cap**. Between the moment your spending passes the line and the moment
someone actually stops it, the meter keeps running — through billing data that arrives hours late,
an email nobody reads until morning, and the ten minutes it takes to find the thing and kill it.

OVERNIGHT plays that night on a clock. Pick what runs away, pick what is meant to stop it, and watch
the fare climb past your budget.

**Live:** https://overnight-PENDING.vercel.app

---

## The default night

An agent stuck in a loop from 23:40 — six requests a minute, resending its growing conversation
each time — with a **$100** budget, asleep from 23:30 to 07:30:

| What is meant to stop it | What the night costs |
| --- | --- |
| Azure budget alert | **$6,391** |
| AWS Budgets alert | **$1,799** — 18× the budget |
| Google Cloud budget alert | $1,799 |
| Vercel spend alert | $1,799 |
| Vercel, with pausing turned on | $122 |
| LLM provider spend limit (best case) | $100 |
| A breaker in your own code | **$100** |

Three very different alerting systems cost exactly the same — because all three alerts land while
you are asleep. The real cap on an alert is your alarm clock.

A leaked API key run at a 2M-tokens-a-minute limit is worse: **$14,850** against an AWS alert,
**$51,250** against Azure, $280 with Vercel pausing, $100 with a breaker.

## Where the delays come from

Each provider's own documentation, linked in the page beside the number it produced:

- **AWS Budgets** refreshes up to three times a day, roughly 8–12 hours apart, and alerts follow that
  cadence. Modelled as 0–12 hours. ([docs](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html))
- **Azure** budgets do not stop consumption; cost data typically arrives within 8–24 hours and budgets
  are evaluated once a day. Modelled as 8–48 hours. ([docs](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets))
- **Google Cloud** alerts-only budgets do not cap spending, and alerts can take several hours. Modelled
  as 3–8 hours — that range is our assumption. Spend-cap budgets exist in preview for some services.
  ([docs](https://cloud.google.com/billing/docs/how-to/budgets))
- **Vercel** checks spend every few minutes; it can pause production deployments if you turn that on,
  but not AI Gateway or v0 usage. Modelled as 2–10 minutes. ([docs](https://vercel.com/docs/spend-management))
- **Anthropic and OpenAI** let you set organization or project spend limits. How quickly they are
  enforced is not documented, so they are modelled as instant — the best case.

These are models of the documented typical and worst cases, not measurements of your account.
Scenario prices are examples; set your own.

## The fix that has no lag

`src/breaker.ts` and `src/breaker.py`: a dependency-free spend breaker for LLM calls. It counts the
cost of each response from its own `usage` numbers — Anthropic and OpenAI shapes, cached tokens
included — and refuses the next call **before it is made** once the total reaches your cap.

```ts
const breaker = new Breaker({ capUsd: 20, prices: { "my-model": { input: 3, output: 15 } } });
const res = await breaker.run("my-model", () => client.messages.create({ /* … */ }));
```

```python
breaker = Breaker(cap_usd=20, prices={"my-model": Price(input=3, output=15)})
res = breaker.run("my-model", lambda: client.messages.create(...))
```

Unpriced models are refused, not counted as free; a response without usage numbers is an error;
share one store between workers and they share one cap. Tested: a runaway agent loop stops within one
request of the cap, and once tripped no further call is made.

## Build

```bash
npm install
npm test        # 81 assertions: the model, and the breaker in TypeScript and Python
npm run build   # → dist/
```

Prompted by Simon Willison's
[case for default hard budget caps](https://simonwillison.net/2026/Oct/3/default-hard-budget-caps/)
and [the thread](https://news.ycombinator.com/item?id=49949235) under it: everyone agreed alerts
arrive late; nobody had put a number on how late, or what it costs.

MIT.
