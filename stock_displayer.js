/* stock_displayer.js — Stock-X frontend.
 *
 * Talks to the local stock_finder.py backend:
 *   GET /api/search?q=...
 *   GET /api/chart?symbol=...&range=...&interval=...
 * Renders a price chart (Chart.js), a live quote header, a stats grid,
 * and a plain-language "how is it doing" verdict derived from the data.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const input = $("symbolInput");
  const goBtn = $("goBtn");
  const suggestBox = $("suggest");
  const rangeChips = $("rangeChips");
  const statusEl = $("status");
  const quoteEl = $("quote");
  const verdictEl = $("verdict");
  const statsEl = $("stats");

  const RANGE_INTERVAL = {
    "1d": "5m", "5d": "15m", "1mo": "1d", "6mo": "1d",
    "ytd": "1d", "1y": "1d", "5y": "1wk", "max": "1mo",
  };
  const RANGE_LABEL = {
    "1d": "today", "5d": "the last 5 days", "1mo": "the last month",
    "6mo": "the last 6 months", "ytd": "year-to-date", "1y": "the last year",
    "5y": "the last 5 years", "max": "its full history",
  };

  let currentRange = "1mo";
  let currentSymbol = "";
  let chart = null;
  let searchTimer = null;
  let activeSuggest = -1;
  let suggestItems = [];

  function fmtMoney(v, currency) {
    if (v == null || isNaN(v)) return "—";
    const abs = Math.abs(v);
    const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : 4;
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency", currency: currency || "USD",
        minimumFractionDigits: digits, maximumFractionDigits: digits,
      }).format(v);
    } catch (_) {
      return v.toFixed(2);
    }
  }
  function fmtNum(v) {
    if (v == null || isNaN(v)) return "—";
    if (Math.abs(v) >= 1e12) return (v / 1e12).toFixed(2) + "T";
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(2) + "K";
    return Math.round(v).toLocaleString("en-US");
  }
  function fmtPct(v) {
    if (v == null || isNaN(v)) return "—";
    return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  }
  function setStatus(msg, isErr) {
    statusEl.textContent = msg || "";
    statusEl.classList.toggle("err", !!isErr);
  }

  async function api(path) {
    const resp = await fetch(path);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `Request failed (${resp.status})`);
    return data;
  }

  function closeSuggest() {
    suggestBox.classList.remove("open");
    suggestBox.innerHTML = "";
    suggestItems = [];
    activeSuggest = -1;
  }
  function renderSuggest(results) {
    suggestItems = results;
    if (!results.length) return closeSuggest();
    suggestBox.innerHTML = results
      .map(
        (r, i) => `<div class="item" data-i="${i}">
            <span class="sym">${r.symbol}</span>
            <span class="nm">${r.name || ""}</span>
            <span class="ex">${r.exchange || ""}</span>
          </div>`
      )
      .join("");
    suggestBox.classList.add("open");
    activeSuggest = -1;
    [...suggestBox.querySelectorAll(".item")].forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick(results[+el.dataset.i].symbol);
      });
    });
  }
  function highlightSuggest(dir) {
    const items = [...suggestBox.querySelectorAll(".item")];
    if (!items.length) return;
    activeSuggest = (activeSuggest + dir + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle("active", i === activeSuggest));
  }
  function pick(symbol) {
    input.value = symbol;
    closeSuggest();
    load(symbol);
  }

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 1) return closeSuggest();
    searchTimer = setTimeout(async () => {
      try {
        const data = await api("/api/search?q=" + encodeURIComponent(q));
        renderSuggest(data.results || []);
      } catch (_) {
        closeSuggest();
      }
    }, 180);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); highlightSuggest(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlightSuggest(-1); }
    else if (e.key === "Enter") {
      if (activeSuggest >= 0 && suggestItems[activeSuggest]) {
        pick(suggestItems[activeSuggest].symbol);
      } else {
        closeSuggest();
        load(input.value.trim());
      }
    } else if (e.key === "Escape") {
      closeSuggest();
    }
  });
  document.addEventListener("click", (e) => {
    if (!suggestBox.contains(e.target) && e.target !== input) closeSuggest();
  });

  goBtn.addEventListener("click", () => { closeSuggest(); load(input.value.trim()); });

  rangeChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    currentRange = chip.dataset.range;
    [...rangeChips.children].forEach((c) => c.classList.toggle("active", c === chip));
    if (currentSymbol) load(currentSymbol);
  });

  async function load(symbolRaw) {
    const symbol = (symbolRaw || "").trim().toUpperCase();
    if (!symbol) { setStatus("Enter a stock symbol first.", true); return; }
    currentSymbol = symbol;
    setStatus(`Fetching ${symbol} (${RANGE_LABEL[currentRange]})…`);
    try {
      const interval = RANGE_INTERVAL[currentRange] || "1d";
      const data = await api(
        `/api/chart?symbol=${encodeURIComponent(symbol)}` +
        `&range=${currentRange}&interval=${interval}`
      );
      if (!data.points || !data.points.length) {
        throw new Error(`No price data for ${symbol} over ${RANGE_LABEL[currentRange]}.`);
      }
      render(data);
      setStatus(
        `${data.symbol} · ${data.points.length} data points · ` +
        `updated ${new Date().toLocaleTimeString()}`
      );
    } catch (err) {
      setStatus(err.message || "Something went wrong.", true);
    }
  }

  function analyze(data) {
    const pts = data.points;
    const closes = pts.map((p) => p.c);
    const first = closes[0];
    const last = closes[closes.length - 1];
    const live = data.regularMarketPrice != null ? data.regularMarketPrice : last;

    const periodChange = last - first;
    const periodPct = first ? (periodChange / first) * 100 : 0;

    const prevClose = data.previousClose != null ? data.previousClose : closes[closes.length - 2];
    const dayChange = prevClose != null ? live - prevClose : null;
    const dayPct = prevClose ? (dayChange / prevClose) * 100 : null;

    let hi = -Infinity, lo = Infinity, sum = 0;
    for (const c of closes) { hi = Math.max(hi, c); lo = Math.min(lo, c); sum += c; }
    const avg = sum / closes.length;

    const sma = (arr, n) => {
      if (arr.length < n) return null;
      let s = 0;
      for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
      return s / n;
    };
    const smaShort = sma(closes, Math.max(5, Math.floor(closes.length * 0.1)));
    const smaLong = sma(closes, Math.max(20, Math.floor(closes.length * 0.4)));

    let vSum = 0, vCount = 0;
    for (let i = 1; i < closes.length; i++) {
      const r = (closes[i] - closes[i - 1]) / closes[i - 1];
      vSum += r; vCount++;
    }
    const meanR = vCount ? vSum / vCount : 0;
    let varSum = 0;
    for (let i = 1; i < closes.length; i++) {
      const r = (closes[i] - closes[i - 1]) / closes[i - 1];
      varSum += (r - meanR) ** 2;
    }
    const vol = vCount ? Math.sqrt(varSum / vCount) * 100 : 0;

    const drawFromHigh = hi ? ((live - hi) / hi) * 100 : 0;
    const upFromLow = lo ? ((live - lo) / lo) * 100 : 0;

    return {
      live, first, last, periodChange, periodPct, dayChange, dayPct,
      hi, lo, avg, smaShort, smaLong, vol, drawFromHigh, upFromLow,
    };
  }

  function verdict(a, data) {
    let score = 0;
    if (a.periodPct > 0) score += a.periodPct > 10 ? 2 : 1;
    if (a.periodPct < 0) score += a.periodPct < -10 ? -2 : -1;
    if (a.smaShort && a.smaLong) score += a.smaShort > a.smaLong ? 1 : -1;
    if (a.live > a.avg) score += 1; else score -= 1;
    if (a.drawFromHigh > -3) score += 1;
    if (a.upFromLow < 3) score -= 1;

    let cls, head, body;
    const label = RANGE_LABEL[currentRange];
    const trendWord =
      a.smaShort && a.smaLong
        ? (a.smaShort > a.smaLong ? "the short-term average is above the long-term average (uptrend)"
                                  : "the short-term average is below the long-term average (downtrend)")
        : "the trend is still forming";

    if (score >= 3) {
      cls = "bull";
      head = `📈 ${data.symbol} looks strong over ${label}`;
      body = `Up ${fmtPct(a.periodPct)} across the window, trading ${fmtPct(((a.live - a.avg) / a.avg) * 100)} vs its average, ` +
             `and ${a.drawFromHigh > -3 ? "right near its period high" : "holding well off its lows"}. ` +
             `Momentum check: ${trendWord}. Volatility is ${a.vol.toFixed(2)}% per step.`;
    } else if (score <= -3) {
      cls = "bear";
      head = `📉 ${data.symbol} looks weak over ${label}`;
      body = `Down ${fmtPct(a.periodPct)} across the window and ${a.drawFromHigh < -10 ? "well below" : "below"} its period high ` +
             `(${fmtPct(a.drawFromHigh)} from the top). Momentum check: ${trendWord}. ` +
             `Volatility is ${a.vol.toFixed(2)}% per step.`;
    } else {
      cls = "flat";
      head = `➖ ${data.symbol} is mixed / range-bound over ${label}`;
      body = `Net move of ${fmtPct(a.periodPct)} with no decisive direction. ${trendWord[0].toUpperCase() + trendWord.slice(1)}. ` +
             `It's ${fmtPct(a.upFromLow)} above the period low and ${fmtPct(a.drawFromHigh)} from the high.`;
    }
    verdictEl.className = "verdict show " + cls;
    verdictEl.innerHTML = `<h3>${head}</h3><p>${body}</p>`;
  }

  function renderQuote(data, a) {
    const cur = data.currency;
    $("qSymbol").textContent = data.symbol;
    $("qName").textContent = data.shortName || "";
    $("qExch").textContent = data.exchangeName ? "· " + data.exchangeName : "";
    $("qPrice").textContent = fmtMoney(a.live, cur);

    const deltaEl = $("qDelta");
    if (a.dayChange != null) {
      const up = a.dayChange >= 0;
      deltaEl.className = "delta " + (up ? "up" : "down");
      deltaEl.textContent =
        `${up ? "▲" : "▼"} ${fmtMoney(Math.abs(a.dayChange), cur)} (${fmtPct(a.dayPct)}) today`;
    } else {
      const up = a.periodChange >= 0;
      deltaEl.className = "delta " + (up ? "up" : "down");
      deltaEl.textContent = `${up ? "▲" : "▼"} ${fmtPct(a.periodPct)} over ${RANGE_LABEL[currentRange]}`;
    }
    quoteEl.classList.add("show");
  }

  function renderStats(data, a) {
    const cur = data.currency;
    const upDown = (v) => (v >= 0 ? "up" : "down");
    const items = [
      { label: "Price", val: fmtMoney(a.live, cur) },
      { label: `Change (${currentRange.toUpperCase()})`, val: fmtPct(a.periodPct), cls: upDown(a.periodPct) },
      { label: "Period high", val: fmtMoney(a.hi, cur) },
      { label: "Period low", val: fmtMoney(a.lo, cur) },
      { label: "Period average", val: fmtMoney(a.avg, cur) },
      { label: "From high", val: fmtPct(a.drawFromHigh), cls: upDown(a.drawFromHigh) },
      { label: "Off the low", val: fmtPct(a.upFromLow), cls: upDown(a.upFromLow) },
      { label: "Volatility / step", val: a.vol.toFixed(2) + "%" },
      { label: "52-wk high", val: fmtMoney(data.fiftyTwoWeekHigh, cur) },
      { label: "52-wk low", val: fmtMoney(data.fiftyTwoWeekLow, cur) },
      { label: "Day high", val: fmtMoney(data.regularMarketDayHigh, cur) },
      { label: "Day low", val: fmtMoney(data.regularMarketDayLow, cur) },
      { label: "Volume", val: fmtNum(data.regularMarketVolume) },
      { label: "Prev close", val: fmtMoney(data.previousClose, cur) },
    ];
    statsEl.innerHTML = items
      .map(
        (it) =>
          `<div class="stat"><div class="label">${it.label}</div>` +
          `<div class="val ${it.cls || ""}">${it.val}</div></div>`
      )
      .join("");
  }

  function renderChart(data, a) {
    const up = a.periodChange >= 0;
    const color = up ? "#16c784" : "#ea3943";
    const fill = up ? "rgba(22,199,132,.12)" : "rgba(234,57,67,.12)";
    const points = data.points.map((p) => ({ x: p.t * 1000, y: p.c }));

    const ctx = $("chart").getContext("2d");
    if (chart) chart.destroy();

    const unit =
      currentRange === "1d" ? "hour"
      : currentRange === "5d" ? "day"
      : (currentRange === "5y" || currentRange === "max") ? "year"
      : "month";

    const intraday = currentRange === "1d" || currentRange === "5d";
    const fmtTime = (ms) =>
      new Date(ms).toLocaleString(
        "en-US",
        intraday
          ? { hour: "numeric", minute: "2-digit" }
          : { month: "short", day: "numeric" }
      );
    const roundRect = (c, x, y, w, h, r) => {
      if (c.roundRect) { c.beginPath(); c.roundRect(x, y, w, h, r); return; }
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    };

    const dragCompare = {
      id: "dragCompare",
      afterInit(c) {
        const state = { active: false, anchor: null, current: null };
        c.$drag = state;
        const canvas = c.canvas;

        const nearestIndex = (clientX) => {
          const pts = c.getDatasetMeta(0).data;
          if (!pts.length) return null;
          const rect = canvas.getBoundingClientRect();
          const area = c.chartArea;
          const x = Math.min(Math.max(clientX - rect.left, area.left), area.right);
          let best = 0, bestDist = Infinity;
          for (let i = 0; i < pts.length; i++) {
            const d = Math.abs(pts[i].x - x);
            if (d < bestDist) { bestDist = d; best = i; }
          }
          return best;
        };

        const onDown = (e) => {
          const idx = nearestIndex(e.clientX);
          if (idx == null) return;
          state.active = true;
          state.anchor = idx;
          state.current = idx;
          canvas.style.cursor = "ew-resize";
          c.draw();
        };
        const onMove = (e) => {
          if (!state.active) return;
          state.current = nearestIndex(e.clientX);
          c.draw();
        };
        const onUp = () => {
          if (!state.active) return;
          state.active = false;
          state.anchor = state.current = null;
          canvas.style.cursor = "";
          c.draw();
        };

        state._canvas = canvas;
        state._handlers = { onDown, onMove, onUp };
        canvas.addEventListener("pointerdown", onDown);
        canvas.addEventListener("pointermove", onMove);
        canvas.addEventListener("pointerleave", onUp);
        window.addEventListener("pointerup", onUp);
      },
      afterDestroy(c) {
        const state = c.$drag;
        if (!state || !state._handlers) return;
        const { onDown, onMove, onUp } = state._handlers;
        const canvas = state._canvas;
        if (canvas) {
          canvas.removeEventListener("pointerdown", onDown);
          canvas.removeEventListener("pointermove", onMove);
          canvas.removeEventListener("pointerleave", onUp);
        }
        window.removeEventListener("pointerup", onUp);
      },
      beforeTooltipDraw(c) {
        return !(c.$drag && c.$drag.active);
      },
      afterDraw(c) {
        const s = c.$drag;
        if (!s || !s.active || s.anchor == null || s.current == null) return;
        if (s.anchor === s.current) return;

        const dctx = c.ctx;
        const area = c.chartArea;
        const ds = c.data.datasets[0].data;
        const meta = c.getDatasetMeta(0).data;
        const aPt = meta[s.anchor], cPt = meta[s.current];
        const aVal = ds[s.anchor].y, cVal = ds[s.current].y;
        const diff = cVal - aVal;
        const pct = aVal ? (diff / aVal) * 100 : 0;
        const up = diff >= 0;
        const col = up ? "#16c784" : "#ea3943";
        const x1 = Math.min(aPt.x, cPt.x), x2 = Math.max(aPt.x, cPt.x);

        dctx.save();

        dctx.fillStyle = up ? "rgba(22,199,132,.10)" : "rgba(234,57,67,.10)";
        dctx.fillRect(x1, area.top, x2 - x1, area.bottom - area.top);

        dctx.strokeStyle = "rgba(139,148,167,.8)";
        dctx.lineWidth = 1;
        dctx.setLineDash([4, 4]);
        for (const px of [aPt.x, cPt.x]) {
          dctx.beginPath();
          dctx.moveTo(px, area.top);
          dctx.lineTo(px, area.bottom);
          dctx.stroke();
        }
        dctx.setLineDash([]);

        for (const p of [aPt, cPt]) {
          dctx.beginPath();
          dctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          dctx.fillStyle = col;
          dctx.fill();
          dctx.lineWidth = 2;
          dctx.strokeStyle = "#0e131c";
          dctx.stroke();
        }

        const arrow = up ? "▲" : "▼";
        const valTxt = `${arrow} ${fmtMoney(Math.abs(diff), data.currency)} (${fmtPct(pct)})`;
        const t1 = Math.min(ds[s.anchor].x, ds[s.current].x);
        const t2 = Math.max(ds[s.anchor].x, ds[s.current].x);
        const timeTxt = `${fmtTime(t1)} – ${fmtTime(t2)}`;

        dctx.font = "600 13px system-ui, -apple-system, sans-serif";
        const pad = 9, gap = 9, boxH = 26;
        const wVal = dctx.measureText(valTxt).width;
        const wTime = dctx.measureText(timeTxt).width;
        const boxW = pad * 2 + wVal + gap + wTime;
        let bx = (x1 + x2) / 2 - boxW / 2;
        bx = Math.min(Math.max(bx, area.left), area.right - boxW);
        const by = area.top + 6;

        roundRect(dctx, bx, by, boxW, boxH, 6);
        dctx.fillStyle = "#1b212e";
        dctx.fill();
        dctx.strokeStyle = "#283041";
        dctx.lineWidth = 1;
        dctx.stroke();

        dctx.textBaseline = "middle";
        dctx.fillStyle = col;
        dctx.fillText(valTxt, bx + pad, by + boxH / 2);
        dctx.fillStyle = "#8b94a7";
        dctx.fillText(timeTxt, bx + pad + wVal + gap, by + boxH / 2);

        dctx.restore();
      },
    };

    chart = new Chart(ctx, {
      type: "line",
      plugins: [dragCompare],
      data: {
        datasets: [
          {
            label: data.symbol,
            data: points,
            borderColor: color,
            backgroundColor: fill,
            fill: true,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBackgroundColor: color,
            tension: 0.15,
          },
          {
            label: "Average",
            data: [{ x: points[0].x, y: a.avg }, { x: points[points.length - 1].x, y: a.avg }],
            borderColor: "rgba(139,148,167,.7)",
            borderWidth: 1,
            borderDash: [6, 6],
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: "#1b212e",
            borderColor: "#283041",
            borderWidth: 1,
            padding: 10,
            callbacks: {
              title: (items) =>
                new Date(items[0].parsed.x).toLocaleString("en-US", {
                  dateStyle: "medium",
                  timeStyle: currentRange === "1d" || currentRange === "5d" ? "short" : undefined,
                }),
              label: (item) =>
                item.datasetIndex === 0
                  ? "  " + fmtMoney(item.parsed.y, data.currency)
                  : "  avg " + fmtMoney(item.parsed.y, data.currency),
            },
          },
        },
        scales: {
          x: {
            type: "time",
            time: { unit },
            grid: { color: "rgba(40,48,65,.5)" },
            ticks: { color: "#8b94a7", maxRotation: 0, autoSkipPadding: 20 },
          },
          y: {
            position: "right",
            grid: { color: "rgba(40,48,65,.5)" },
            ticks: { color: "#8b94a7", callback: (v) => fmtMoney(v, data.currency) },
          },
        },
      },
    });
  }

  function render(data) {
    const a = analyze(data);
    renderQuote(data, a);
    renderChart(data, a);
    verdict(a, data);
    renderStats(data, a);
  }

  input.value = "AAPL";
  load("AAPL");
})();

