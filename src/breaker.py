"""
A spend cap that actually stops: counts what each LLM response cost from its
own usage numbers, and refuses the next call -- before it is made -- once the
total reaches your cap. No billing pipeline in between, so no lag.

Dependency-free. Copy this file into your project.

    breaker = Breaker(cap_usd=20, prices={"my-model": Price(input=3, output=15)})
    res = breaker.run("my-model", lambda: client.messages.create(...))

Prices are dollars per million tokens. Set them from your provider's price
page: a wrong price here is a wrong cap.
"""
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional


@dataclass
class Price:
    input: float
    output: float
    cache_write: Optional[float] = None
    cache_read: Optional[float] = None


class BudgetExceeded(Exception):
    def __init__(self, spent: float, cap: float):
        super().__init__(f"Spend cap reached: ${spent:.4f} of ${cap:.2f}. Refusing further calls.")
        self.spent, self.cap = spent, cap


class MemoryStore:
    def __init__(self, start: float = 0.0):
        self.value = start
    def get(self) -> float:
        return self.value
    def set(self, total: float) -> None:
        self.value = total


def _get(u: Any, name: str, default=None):
    if isinstance(u, dict):
        return u.get(name, default)
    return getattr(u, name, default)


class Breaker:
    def __init__(self, cap_usd: float, prices: Dict[str, Price], store=None, on_trip: Optional[Callable[[float], None]] = None):
        if not cap_usd > 0:
            raise ValueError("cap_usd must be a positive number of dollars")
        self.cap, self.prices, self.store, self.on_trip = cap_usd, prices, store or MemoryStore(), on_trip
        self._tripped = False

    @property
    def spent(self) -> float:
        return self.store.get()

    def cost(self, model: str, u: Any) -> float:
        """Dollars for one response. Unknown models raise: counting them as free would defeat the point."""
        p = self.prices.get(model)
        if p is None:
            raise KeyError(f'No price for model "{model}". Add it to prices -- an unpriced model would never trip the breaker.')
        read = p.cache_read if p.cache_read is not None else p.input
        write = p.cache_write if p.cache_write is not None else p.input
        created = 0
        if _get(u, "prompt_tokens") is not None:          # OpenAI Chat Completions
            details = _get(u, "prompt_tokens_details") or {}
            cached = _get(details, "cached_tokens", 0) or 0
            inp, out = _get(u, "prompt_tokens") - cached, _get(u, "completion_tokens", 0) or 0
        elif _get(u, "input_tokens_details") is not None:  # OpenAI Responses
            cached = _get(_get(u, "input_tokens_details"), "cached_tokens", 0) or 0
            inp, out = (_get(u, "input_tokens", 0) or 0) - cached, _get(u, "output_tokens", 0) or 0
        else:                                              # Anthropic Messages
            inp = _get(u, "input_tokens", 0) or 0
            cached = _get(u, "cache_read_input_tokens", 0) or 0
            created = _get(u, "cache_creation_input_tokens", 0) or 0
            out = _get(u, "output_tokens", 0) or 0
        return (inp * p.input + cached * read + created * write + out * p.output) / 1e6

    def check(self, estimate_usd: float = 0.0) -> None:
        s = self.spent
        if s >= self.cap or s + estimate_usd > self.cap:
            raise BudgetExceeded(s, self.cap)

    def record(self, model: str, usage: Any) -> float:
        total = self.spent + self.cost(model, usage)
        self.store.set(total)
        if total >= self.cap and not self._tripped:
            self._tripped = True
            if self.on_trip:
                self.on_trip(total)
        return total

    def run(self, model: str, call: Callable[[], Any], usage: Optional[Callable[[Any], Any]] = None, estimate_usd: float = 0.0):
        """check -> call -> record. The call is never made once the cap is reached."""
        self.check(estimate_usd)
        r = call()
        u = usage(r) if usage else _get(r, "usage")
        if u is None:
            raise ValueError("The response carried no usage numbers, so its cost cannot be counted. Pass usage=.")
        self.record(model, u)
        return r
