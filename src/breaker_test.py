import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from breaker import Breaker, BudgetExceeded, MemoryStore, Price

passed, failed = 0, []
def ok(name, cond):
    global passed
    if cond: passed += 1
    else: failed.append(name)
def near(name, a, b, tol=1e-12):
    ok(f"{name} (got {a}, want {b})", abs(a - b) <= tol)

prices = {"m": Price(input=3, output=15, cache_write=3.75, cache_read=0.3)}
b = Breaker(1, prices)
near("anthropic with cache", b.cost("m", {"input_tokens": 1000, "output_tokens": 500, "cache_creation_input_tokens": 2000, "cache_read_input_tokens": 10000}), (1000*3 + 500*15 + 2000*3.75 + 10000*0.3) / 1e6)
near("openai chat cached inside prompt", b.cost("m", {"prompt_tokens": 12000, "completion_tokens": 500, "prompt_tokens_details": {"cached_tokens": 10000}}), (2000*3 + 10000*0.3 + 500*15) / 1e6)
near("openai responses", b.cost("m", {"input_tokens": 12000, "output_tokens": 500, "input_tokens_details": {"cached_tokens": 10000}}), (2000*3 + 10000*0.3 + 500*15) / 1e6)

class U:  # SDK objects use attributes, not keys
    input_tokens = 1000; output_tokens = 0
near("attribute-style usage objects work", b.cost("m", U()), 3000 / 1e6)

try: b.cost("nope", {"input_tokens": 1}); failed.append("unknown model refused")
except KeyError: passed += 1

calls, turn, tripped = 0, 0, []
agent = Breaker(5, prices, on_trip=tripped.append)
def fake():
    global calls, turn
    calls += 1; turn += 1
    return {"usage": {"input_tokens": 8000 + turn * 2000, "output_tokens": 1000}}
stopped = None
for _ in range(10000):
    try: agent.run("m", fake)
    except BudgetExceeded as e: stopped = e; break
ok("loop stopped by BudgetExceeded", isinstance(stopped, BudgetExceeded))
last = (3 * (8000 + turn * 2000) + 15 * 1000) / 1e6
ok(f"stops within one request of the cap ({agent.spent:.4f})", 5 <= agent.spent < 5 + last)
ok("on_trip fired once", len(tripped) == 1 and tripped[0] >= 5)
before = calls
try: agent.run("m", fake); failed.append("refuses once tripped")
except BudgetExceeded: passed += 1
ok("and makes no call", calls == before)

shared = MemoryStore()
w1, w2 = Breaker(1, prices, store=shared), Breaker(1, prices, store=shared)
w1.record("m", {"input_tokens": 200000}); w2.record("m", {"input_tokens": 200000})
near("shared store", shared.get(), 1.2, 1e-9)
try: w1.check(); failed.append("shared cap refuses")
except BudgetExceeded: passed += 1

print(f"✗ {len(failed)} failed of {passed + len(failed)}" if failed else f"✓ {passed} assertions pass (python)")
for f in failed: print("  ✗", f)
sys.exit(1 if failed else 0)
