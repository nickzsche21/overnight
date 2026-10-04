import { SCENARIOS, GUARDS, defaults, simulate, at, clock, money, type Night, type Scenario, type Guard } from "./model";
import { SOURCE_TS, SOURCE_PY } from "./sources.gen";

type Kid = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | number | boolean | ((e: Event) => void) | undefined> = {}, ...kids: Kid[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}
const svg = (tag: string, attrs: Record<string, string | number>) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};
const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;

/* ── state ────────────────────────────────────────────────────────────────── */
const hm = (s: string) => { const [a, b] = s.split(":").map(Number); return a * 60 + b; };
const state = {
  scenario: SCENARIOS[0],
  params: defaults(SCENARIOS[0]) as Record<string, number>,
  guard: GUARDS[0],
  threshold: 100,
  start: "23:40", sleep: "23:30", wake: "07:30", read: 15, fix: 10,
};

/** Evening times on the first day, morning times on the next. */
function night(): Night {
  const evening = (t: string) => { const m = hm(t); return m < 12 * 60 ? m + 1440 : m; };
  const start = evening(state.start), sleep = evening(state.sleep);
  let wake = hm(state.wake) + 1440;
  if (wake <= sleep) wake += 1440;
  return { start, sleep, wake, read: state.read, fix: state.fix, threshold: state.threshold };
}

/* ── the meter ────────────────────────────────────────────────────────────── */
function meterText(x: number) {
  const s = x >= 1e6 ? (x / 1e6).toFixed(2) + "M" : x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return s.padStart(10, " ");
}
function setMeter(x: number, ratio: number) {
  const el = $("#meter") as HTMLElement;
  el.textContent = meterText(x);
  el.dataset.level = ratio <= 1.1 ? "ok" : ratio <= 5 ? "warn" : "bad";
}

/* ── the sky band ─────────────────────────────────────────────────────────── */
/* Drawn at the size it is shown, so labels stay readable on a phone instead
   of being shrunk from a desktop-sized drawing. */
let W = 1000, H = 260;
const PAD = 34;
function skyColour(clockMin: number): string {
  const hr = ((clockMin / 60) % 24 + 24) % 24;
  const stops: [number, [number, number, number]][] = [
    [0, [10, 12, 30]], [4.5, [14, 16, 40]], [5.75, [78, 52, 88]], [6.5, [214, 110, 70]], [7.5, [236, 184, 120]],
    [9, [150, 190, 220]], [17, [150, 190, 220]], [18.5, [200, 110, 80]], [19.5, [44, 32, 70]], [21, [12, 14, 34]], [24, [10, 12, 30]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (hr <= stops[i][0]) {
      const [h0, c0] = stops[i - 1], [h1, c1] = stops[i];
      const f = (hr - h0) / (h1 - h0);
      return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * f)).join(",")})`;
    }
  }
  return "rgb(10,12,30)";
}

type Frame = { tEnd: number; reveal: number };
let current: ReturnType<typeof compute> | null = null;

function compute() {
  const n = night();
  const sim = simulate(state.scenario, state.params, n);
  const o = sim.outcomes.find((x) => x.g.id === state.guard.id)!;
  const out = o.typical;
  // The visible window: from an hour before the runaway to an hour after it stops (at least 14 hours).
  const stopAt = out.stopAt ?? 14 * 60;
  const span = Math.max(14 * 60, Math.min(sim.curve.length - 1, stopAt + 60) + 60);
  return { n, sim, o, out, span, from: n.start - 60 };
}

/** Draw the night up to `reveal` (0..1 of the way to the stop). Pure: same inputs, same picture. */
function drawNight(c: ReturnType<typeof compute>, reveal: number) {
  const box = $("#sky") as unknown as SVGSVGElement;
  W = Math.max(340, Math.min(1000, Math.round(box.clientWidth || 1000)));
  H = W < 600 ? 300 : 260;
  box.setAttribute("viewBox", `0 0 ${W} ${H}`);
  box.replaceChildren();
  const x = (clockMin: number) => PAD + ((clockMin - c.from) / c.span) * (W - 2 * PAD);
  const tEnd = (c.out.stopAt ?? c.span - 60) * reveal;
  const maxCost = Math.max(c.out.cost, c.n.threshold * 1.2, 1);
  const y = (cost: number) => H - PAD - (cost / maxCost) * (H - 2 * PAD - 18);

  // Sky: one slice per ten minutes, coloured by the clock.
  const defs = svg("defs", {});
  const grad = svg("linearGradient", { id: "skyg", x1: 0, x2: 1, y1: 0, y2: 0 });
  for (let i = 0; i <= 40; i++) {
    const m = c.from + (c.span * i) / 40;
    grad.append(svg("stop", { offset: `${(i / 40) * 100}%`, "stop-color": skyColour(m) }));
  }
  defs.append(grad); box.append(defs);
  box.append(svg("rect", { x: PAD, y: 8, width: W - 2 * PAD, height: H - PAD - 8, fill: "url(#skyg)", rx: 10 }));

  // You, asleep.
  const s0 = Math.max(c.n.sleep, c.from), s1 = Math.min(c.n.wake, c.from + c.span);
  if (s1 > s0) {
    box.append(svg("rect", { x: x(s0), y: 8, width: x(s1) - x(s0), height: H - PAD - 8, fill: "rgba(0,0,0,.28)" }));
    const zz = svg("text", { x: (x(s0) + x(s1)) / 2, y: 30, "text-anchor": "middle", class: "zz" }); zz.textContent = "you are asleep"; box.append(zz);
  }

  // Hour ticks.
  for (let m = Math.ceil(c.from / 60) * 60; m <= c.from + c.span; m += 60) {
    const hr = ((m / 60) % 24 + 24) % 24;
    if (hr % (W < 600 ? 4 : 2)) continue;
    const t = svg("text", { x: x(m), y: H - 12, "text-anchor": "middle", class: "tick" }); t.textContent = clock(m).slice(0, 5); box.append(t);
  }

  // Threshold line.
  box.append(svg("line", { x1: PAD, x2: W - PAD, y1: y(c.n.threshold), y2: y(c.n.threshold), class: "thresh" }));
  const tl = svg("text", { x: W - PAD - 6, y: y(c.n.threshold) - 6, "text-anchor": "end", class: "thresh-label" }); tl.textContent = `your budget ${money(c.n.threshold)}`; box.append(tl);

  // Cost so far.
  let d = `M ${x(c.n.start)} ${y(0)}`;
  const steps = 240;
  for (let i = 1; i <= steps; i++) {
    const t = (tEnd * i) / steps;
    d += ` L ${x(c.n.start + t).toFixed(1)} ${y(at(c.sim.curve, t)).toFixed(1)}`;
  }
  box.append(svg("path", { d: d + ` L ${x(c.n.start + tEnd)} ${y(0)} Z`, class: "burn-fill" }));
  box.append(svg("path", { d, class: "burn" }));

  // Events, as they are reached.
  const ev = (t: number | null, label: string, cls: string, row: number) => {
    if (t === null || t > tEnd + 1e-6) return;
    const X = x(c.n.start + t);
    box.append(svg("line", { x1: X, x2: X, y1: 8, y2: H - PAD, class: `ev ${cls}` }));
    // In the right half, labels sit to the left of their line so they are not clipped.
    const right = X > W * 0.55;
    const tx = svg("text", { x: right ? X - 5 : X + 5, y: 52 + row * 16, "text-anchor": right ? "end" : "start", class: `ev-label ${cls}` }); tx.textContent = `${label} ${clock(c.n.start + t)}`; box.append(tx);
  };
  ev(0, "starts", "e-start", 0);
  ev(c.out.crossAt, "passes budget", "e-cross", 1);
  if (c.o.g.kind === "alert") ev(c.out.noticeAt, "alert sent", "e-alert", 2);
  ev(c.out.stopAt, "stopped", "e-stop", 3);

  const now = at(c.sim.curve, tEnd);
  setMeter(now, now / c.n.threshold);
  ($("#clock") as HTMLElement).textContent = clock(c.n.start + tEnd);
}

/* ── playing the night ────────────────────────────────────────────────────── */
let playing = 0;
function play() {
  if (!current) return;
  const token = ++playing, t0 = performance.now(), dur = 7000;
  const step = () => {
    if (token !== playing || !current) return;
    const f = Math.min(1, (performance.now() - t0) / dur);
    drawNight(current, 1 - Math.pow(1 - f, 2.2));
    if (f < 1) setTimeout(step, 33); else finish();
  };
  step();
}

function finish() {
  if (!current) return;
  drawNight(current, 1);
  const c = current, out = c.out, g = c.o.g;
  const r = $("#verdict") as HTMLElement;
  if (out.crossAt === null) {
    r.replaceChildren(h("p", { class: "big" }, `It never reaches ${money(c.n.threshold)} in ${72} hours.`), h("p", {}, "Raise the burn, or lower the budget."));
    return;
  }
  const ratio = out.cost / c.n.threshold;
  r.dataset.level = ratio <= 1.1 ? "ok" : ratio <= 5 ? "warn" : "bad";
  r.replaceChildren(
    h("p", { class: "big" }, `Your ${money(c.n.threshold)} budget cost `, h("strong", {}, money(out.cost)), "."),
    h("p", {}, `It passed ${money(c.n.threshold)} at ${clock(c.n.start + out.crossAt)}. `,
      g.kind === "alert"
        ? `${g.label.replace(/ alert$/, "")} sent the alert around ${clock(c.n.start + out.noticeAt!)}${c.n.start + out.noticeAt! < c.n.wake && c.n.start + out.noticeAt! >= c.n.sleep ? ", while you were asleep" : ""}; you stopped it at ${clock(c.n.start + out.stopAt!)}.`
        : `${g.label} stopped it at ${clock(c.n.start + out.stopAt!)}.`,
      ratio > 1.1 ? ` That is ${ratio.toFixed(ratio > 10 ? 0 : 1)}× what you meant to spend.` : ""),
    h("p", { class: "range" }, `Across the documented range of delays: ${money(c.o.soonest.cost)} – ${money(c.o.latest.cost)}.`),
  );
  drawCompare();
}

/* ── the same night, every guardrail ──────────────────────────────────────── */
function drawCompare() {
  if (!current) return;
  const rows = [...current.sim.outcomes].sort((a, b) => b.typical.cost - a.typical.cost);
  const max = Math.max(...rows.map((r) => r.latest.cost), 1);
  const thr = current.n.threshold;
  // When every alert lands while you sleep, they all cost the same: the alarm clock is the real cap.
  const alerts = rows.filter((r) => r.g.kind === "alert" && r.g.id !== "azure");
  const same = alerts.length > 1 && alerts.every((r) => Math.abs(r.typical.cost - alerts[0].typical.cost) < 0.5);
  ($("#insight") as HTMLElement).textContent = same
    ? `Notice that ${alerts.map((r) => r.g.label.replace(/ (budget |spend )?alert$/, "")).join(", ")} all cost the same here. Their alerts arrive minutes or hours apart, but all of them arrive while you are asleep — so what actually stops the spending is your alarm clock.`
    : "";
  ($("#compare") as HTMLElement).replaceChildren(...rows.map((r) => {
    const ratio = r.typical.cost / thr;
    const lvl = ratio <= 1.1 ? "ok" : ratio <= 5 ? "warn" : "bad";
    return h("button", { class: `row${r.g.id === state.guard.id ? " on" : ""}`, onclick: () => { state.guard = r.g; render(true); } },
      h("span", { class: "name" }, r.g.label),
      h("span", { class: "bar" },
        h("span", { class: `range-bar ${lvl}`, style: `left:${(r.soonest.cost / max) * 100}%;width:${Math.max(0.6, ((r.latest.cost - r.soonest.cost) / max) * 100)}%` }),
        h("span", { class: `fill ${lvl}`, style: `width:${Math.max(0.6, (r.typical.cost / max) * 100)}%` })),
      h("span", { class: `amt ${lvl}` }, money(r.typical.cost)));
  }));
}

/* ── controls ─────────────────────────────────────────────────────────────── */
function numberField(label: string, unit: string, value: number, step: number, min: number, onChange: (v: number) => void) {
  const input = h("input", { type: "number", value, step, min, inputmode: "decimal" }) as HTMLInputElement;
  input.addEventListener("input", () => { const v = parseFloat(input.value); if (Number.isFinite(v) && v >= min) onChange(v); });
  return h("label", { class: "field" }, h("span", {}, label), h("span", { class: "in" }, input, unit ? h("em", {}, unit) : null));
}
function timeField(label: string, value: string, onChange: (v: string) => void) {
  const input = h("input", { type: "time", value }) as HTMLInputElement;
  input.addEventListener("input", () => { if (input.value) onChange(input.value); });
  return h("label", { class: "field" }, h("span", {}, label), h("span", { class: "in" }, input));
}

function renderScenario() {
  const s = state.scenario;
  ($("#scenarios") as HTMLElement).replaceChildren(...SCENARIOS.map((x) =>
    h("button", { class: `chip${x.id === s.id ? " on" : ""}`, onclick: () => { state.scenario = x; state.params = defaults(x); renderScenario(); render(true); } }, x.label)));
  ($("#story") as HTMLElement).textContent = s.story;
  ($("#params") as HTMLElement).replaceChildren(...s.params.map((p) =>
    numberField(p.label, p.unit, state.params[p.key], p.step, p.min, (v) => { state.params[p.key] = v; render(false); })));
  const rate = s.rate(60 * 6, state.params) * 60;
  ($("#rate") as HTMLElement).textContent = `≈ ${money(rate)} an hour once it is going`;
}

function renderGuard() {
  const g = state.guard;
  ($("#guards") as HTMLElement).replaceChildren(...GUARDS.map((x) =>
    h("button", { class: `chip${x.id === g.id ? " on" : ""}`, onclick: () => { state.guard = x; renderGuard(); render(true); } }, x.label)));
  ($("#quote") as HTMLElement).replaceChildren(
    h("blockquote", {}, `“${g.quote}”`),
    h("p", {}, g.says),
    h("p", { class: "cite" }, g.url.startsWith("#") ? h("a", { href: g.url }, "the code is below") : h("a", { href: g.url, target: "_blank", rel: "noopener" }, new URL(g.url).hostname + new URL(g.url).pathname.replace(/\/$/, "").slice(0, 60)),
      g.caveat ? ` — ${g.caveat}` : ""),
    h("p", { class: "kind" }, g.kind === "stop" ? "Stops spending by itself." : `Only sends an alert: somebody has to read it and act. Modelled delay ${fmtLag(g.lag)}.`),
  );
}
const fmtLag = (l: [number, number]) => l[1] < 60 ? `${l[0]}–${l[1]} minutes` : `${l[0] / 60}–${l[1] / 60} hours`;

let debounce: ReturnType<typeof setTimeout> | undefined;
function render(animate: boolean) {
  renderGuard();
  current = compute();
  clearTimeout(debounce);
  if (animate) play();
  else debounce = setTimeout(() => { playing++; finish(); }, 120);
  const rate = state.scenario.rate(60 * 6, state.params) * 60;
  ($("#rate") as HTMLElement).textContent = `≈ ${money(rate)} an hour once it is going`;
}

/* ── the fix ──────────────────────────────────────────────────────────────── */
function renderCode() {
  const pre = $("#code") as HTMLElement;
  let lang: "ts" | "py" = "ts";
  const show = () => {
    pre.textContent = lang === "ts" ? SOURCE_TS : SOURCE_PY;
    document.querySelectorAll<HTMLElement>("[data-lang]").forEach((b) => b.classList.toggle("on", b.dataset.lang === lang));
    ($("#dl") as HTMLAnchorElement).href = lang === "ts" ? "breaker.ts" : "breaker.py";
    ($("#dl") as HTMLAnchorElement).textContent = `download breaker.${lang}`;
  };
  document.querySelectorAll<HTMLElement>("[data-lang]").forEach((b) => b.addEventListener("click", () => { lang = b.dataset.lang as "ts" | "py"; show(); }));
  $("#copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(pre.textContent ?? ""); ($("#copy") as HTMLElement).textContent = "copied"; }
    catch { ($("#copy") as HTMLElement).textContent = "select and copy"; }
    setTimeout(() => (($("#copy") as HTMLElement).textContent = "copy"), 1800);
  });
  show();
}

function boot() {
  ($("#night-fields") as HTMLElement).replaceChildren(
    numberField("your budget alert at", "$", state.threshold, 10, 1, (v) => { state.threshold = v; render(false); }),
    timeField("it starts at", state.start, (v) => { state.start = v; render(false); }),
    timeField("you fall asleep", state.sleep, (v) => { state.sleep = v; render(false); }),
    timeField("you wake up", state.wake, (v) => { state.wake = v; render(false); }),
    numberField("minutes to see the alert after waking", "min", state.read, 5, 0, (v) => { state.read = v; render(false); }),
    numberField("minutes to shut it down", "min", state.fix, 5, 0, (v) => { state.fix = v; render(false); }),
  );
  $("#replay").addEventListener("click", () => play());
  renderScenario();
  renderGuard();
  renderCode();
  render(true);
}
boot();
let resized: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => { clearTimeout(resized); resized = setTimeout(() => { if (current && playing) drawNight(current, 1); }, 150); });

export { drawNight, compute, finish };
