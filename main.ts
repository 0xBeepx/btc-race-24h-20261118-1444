// BTC race bot v2: range dip-buyer on cbBTC 1-minute bars (agent-fun/bars-replay/v1).
//
// Thesis: over a single day BTC usually swings ~1-2% inside a slow range.
// The bot only buys after the price has fallen well below its own recent
// high (a dip inside the range, not a chase), then sells when the price
// climbs back to the top of that range, or at a small take-profit /
// stop-loss. It never shorts, never uses leverage, never holds through a
// freefall: a wide stop, a hold cap and a drawdown halt bound the damage.
//
// Round-2 revision (Argon strategy, folded in after round-1 grid):
// - Rolling high from candle BODIES (max(open, close)), not the highest
//   wick: a single Orca MEV wick must not set the anchor.
// - Cold start: the dip trigger arms once bars_seen >= min(90, WINDOW),
//   using whatever window history exists, instead of waiting a full WINDOW.
// - Zero-trade fallback: at bar 1140 with 0 buys, DIP loosens 40%; at bar
//   1320 with 0 buys, a forced qualification trade fires on a quiet up
//   close (close > prev close, ATR_5 < 15 bps) with TP +35 / SL -35 bps
//   or a 5-bar hold. The race needs >= 1 trade.
// - End of window: no new entries after bar 1380 unless still 0 trades.
// - Optional confirmation layer (knobs below, off by default): 2-state
//   dip-armed entry, SMA_180 slope guard, stale-exit stop tightening,
//   ATR_5 entry block, re-entry gate after an exit.
//
// Rules, all in bar time (no clock, no network, no files, no randomness):
// - Reference: the rolling high of the last WINDOW_BARS candle bodies.
// - Entry (flat, not cooling down, not halted, cold-start passed):
//   close < rolling high * (1 - DIP_PCT%).
// - Exit (holding): take-profit when the position value >= cost * (1 + TP),
//   stop-loss when value <= cost * (1 - SL) (then a COOLDOWN_BARS pause),
//   or the close back within TOP_PCT% of the rolling high (sold into the
//   range top), or after MAX_HOLD_BARS bars held.
// - Drawdown guard: equity below DD_GUARD_PCT% of its peak flattens the
//   position and halts trading for the rest of the window (the race needs
//   max drawdown <= 25%).
// - Size: the whole cash balance on every buy (one asset, one position,
//   long only). Every order caps slippage at MAX_SLIPPAGE_BPS past the
//   close it was decided on.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- tuning constants (round-1 winner + round-2 guards) ---
const WINDOW_BARS = 450; // rolling-high window, bars
const DIP_PCT = 1.3; // entry: close this far below the rolling high, %
const TOP_PCT = 0.03; // exit: close back within this of the rolling high, %
const TP_BPS = 150; // take-profit, bps over cost
const SL_BPS = 120; // stop-loss, bps under cost
const MAX_HOLD_BARS = 720; // longest a position is held, bars
const COOLDOWN_BARS = 15; // bars to wait after a stop-loss before buying again
const DD_GUARD_PCT = 88; // halt if equity falls below this % of its peak
const MAX_SLIPPAGE_BPS = 150; // per-order slippage cap past the deciding close
// Trend filter: only buy dips while the close sits at or above its own
// TREND_BARS-bar average (a dip inside an uptrend, not a falling knife in
// a downtrend). 0 disables the filter.
const TREND_BARS = 720; // trend-filter window, bars (0 = off)

// --- round-2 confirmation knobs (0 = off) ---
const CONFIRM_MODE = 1; // 0 = buy on the dip at once; 1 = 2-state armed + confirm
const CONFIRM_BARS = 1; // consecutive up closes needed while armed (mode 1)
const CONFIRM_CEIL_BPS = 30; // bounce may not eat more than this of the dip edge, bps
const SLOPE_GUARD = 1; // 1 = block entries while SMA_180 falls faster than -45 bps / 30 bars
const STALE_EXIT_BARS = 0; // 0 = off; else tighten SL to 45 bps once held this long and down > 25 bps
const ATR_BLOCK = 1; // 1 = block entries while ATR_5 / close > 28 bps
const REENTRY_GATE = 1; // 1 = after an exit, re-enter only above SMA_60 or on a fresh 60-bar dip

// --- mandatory guards (not grid knobs) ---
const COLD_START_BARS = 90; // arm the dip trigger once this many bars are seen
const ZERO_TRADE_BAR = 1140; // loosen DIP 40% from here if still 0 buys
const QUAL_BAR = 1320; // forced qualification trade from here if still 0 buys
const QUAL_ATR_BPS = 15; // qualification trade needs ATR_5 under this, bps
const QUAL_TP_BPS = 35; // qualification trade take-profit, bps
const QUAL_SL_BPS = 35; // qualification trade stop-loss, bps
const QUAL_HOLD_BARS = 5; // qualification trade max hold, bars
const LAST_ENTRY_BAR = 1380; // no new entries after this bar unless 0 trades

// --- state, kept across batches ---
const opens: number[] = []; // open prices in USDC, oldest first
const highs: number[] = []; // high prices in USDC, oldest first
const lows: number[] = []; // low prices in USDC, oldest first
const closes: number[] = []; // close prices in USDC, oldest first
let holdSince = -1; // seq of the first batch the current position was seen in
let cooldownUntil = -1; // seq before which no new entry is taken
let halted = false; // set by the drawdown guard, never cleared
let peakEquity = 0n; // highest equity seen, quote units
let buysSent = 0; // buy orders sent (for the zero-trade fallback)
let dipArmed = false; // 2-state entry: a dip is armed
let anchorHigh = 0; // rolling high recorded when the dip armed
let confirmStreak = 0; // consecutive up closes while armed
let reentryBlocked = false; // waiting for the re-entry condition after an exit
let qualPosition = false; // current position is a forced qualification trade

function rollingHighBody(window: number): number {
  let high = -Infinity;
  const n = Math.min(window, closes.length);
  const start = closes.length - n;
  for (let i = start; i < closes.length; i++) {
    const body = opens[i] > closes[i] ? opens[i] : closes[i];
    if (body > high) high = body;
  }
  return high;
}

function sma(window: number): number {
  const n = Math.min(window, closes.length);
  let sum = 0;
  for (let i = closes.length - n; i < closes.length; i++) sum += closes[i];
  return sum / n;
}

// SMA(window) as it stood `lag` bars ago.
function smaAt(window: number, lag: number): number {
  const end = closes.length - lag;
  const n = Math.min(window, end);
  let sum = 0;
  for (let i = end - n; i < end; i++) sum += closes[i];
  return sum / n;
}

// Mean (high - low) over the last 5 bars, in USDC.
function atr5(): number {
  const n = Math.min(5, closes.length);
  let sum = 0;
  for (let i = closes.length - n; i < closes.length; i++) sum += highs[i] - lows[i];
  return sum / n;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const scale = state.symbols.get(SYMBOL)!.price_scale;
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) {
        opens.push(Number(bar.o) / 10 ** scale);
        highs.push(Number(bar.h) / 10 ** scale);
        lows.push(Number(bar.l) / 10 ** scale);
        closes.push(Number(bar.c) / 10 ** scale);
      }
    }

    // Equity peak tracking, at the latest close.
    if (state.equity > peakEquity) peakEquity = state.equity;

    const held = state.positions.get(SYMBOL);
    if (held !== undefined && holdSince === -1) holdSince = state.seq;

    // Drawdown guard: flatten and halt for the rest of the window.
    if (held !== undefined && peakEquity > 0n && state.equity * 100n < peakEquity * BigInt(DD_GUARD_PCT)) {
      halted = true;
      holdSince = -1;
      qualPosition = false;
      const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [sell];
    }

    if (held !== undefined) {
      // --- exits ---
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const high = rollingHighBody(WINDOW_BARS);
      const close = closes[closes.length - 1];
      const heldBars = state.seq - holdSince;
      const tp = qualPosition ? QUAL_TP_BPS : TP_BPS;
      let sl = qualPosition ? QUAL_SL_BPS : SL_BPS;
      const maxHold = qualPosition ? QUAL_HOLD_BARS : MAX_HOLD_BARS;
      if (STALE_EXIT_BARS > 0 && !qualPosition && heldBars >= STALE_EXIT_BARS) {
        // Unrealized return in bps (signed, truncated): (value - cost) / cost * 10000.
        const unrealBps = Number((value - cost) * 10000n / cost);
        if (unrealBps < -25) sl = 45; // time-decay stop: cut the bleed early
      }
      const takeProfit = value * 10000n >= cost * BigInt(10000 + tp);
      const stopLoss = value * 10000n <= cost * BigInt(10000 - sl);
      const backAtTop = !qualPosition && close >= high * (1 - TOP_PCT / 100);
      const heldTooLong = heldBars >= maxHold;
      if (takeProfit || stopLoss || backAtTop || heldTooLong) {
        if (stopLoss) cooldownUntil = state.seq + COOLDOWN_BARS;
        if (REENTRY_GATE === 1) reentryBlocked = true;
        holdSince = -1;
        qualPosition = false;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // --- entry ---
    if (state.warmingUp || halted) return [];
    if (state.seq < cooldownUntil) return [];
    const barsSeen = closes.length;
    const coldStart = Math.min(COLD_START_BARS, WINDOW_BARS);
    if (barsSeen < coldStart) return [];
    const close = closes[closes.length - 1];
    const prevClose = closes.length > 1 ? closes[closes.length - 2] : close;

    // Zero-trade fallback: loosen the dip once the window is 5h in.
    let dipPct = DIP_PCT;
    if (barsSeen >= ZERO_TRADE_BAR && buysSent === 0) dipPct = DIP_PCT * 0.6;

    // End of window: no new entries in the last hour unless still 0 trades.
    if (barsSeen > LAST_ENTRY_BAR && buysSent > 0) return [];

    // Forced qualification trade: quiet up close, tiny TP/SL, 5-bar hold.
    if (barsSeen >= QUAL_BAR && buysSent === 0) {
      if (close > prevClose && (atr5() / close) * 10000 < QUAL_ATR_BPS) {
        qualPosition = true;
        buysSent++;
        const buy: BuyInput = {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        return [buy];
      }
      return [];
    }

    // Trend filter: only buy dips while the close sits at or above its own
    // TREND_BARS-bar average.
    if (TREND_BARS > 0 && close < sma(TREND_BARS)) return [];

    // Slope guard: block entries while the 3h SMA_180 trend falls fast.
    if (SLOPE_GUARD === 1 && closes.length > 180) {
      const now = sma(180);
      const then = smaAt(180, 30);
      if ((now - then) / then < -0.0045) return [];
    }

    // ATR block: skip entries in a volatility spike.
    if (ATR_BLOCK === 1 && atr5() / close > 0.0028) return [];

    // Re-entry gate: after an exit, wait for price above SMA_60 or a fresh
    // 60-bar dip before buying again.
    if (REENTRY_GATE === 1 && reentryBlocked) {
      const freshDip = close < rollingHighBody(60) * (1 - (0.85 * dipPct) / 100);
      if (close <= sma(60) && !freshDip) return [];
      reentryBlocked = false;
    }

    const high = rollingHighBody(WINDOW_BARS);
    if (CONFIRM_MODE === 0) {
      if (close < high * (1 - dipPct / 100)) {
        buysSent++;
        const buy: BuyInput = {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: state.cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        };
        return [buy];
      }
      return [];
    }

    // 2-state entry: arm on the dip, buy only on a confirmed bounce that
    // has not eaten more than CONFIRM_CEIL_BPS of the edge.
    const dipped = close < high * (1 - dipPct / 100);
    if (!dipped) {
      dipArmed = false;
      return [];
    }
    if (!dipArmed) {
      dipArmed = true;
      anchorHigh = high;
      confirmStreak = 0;
    }
    if (close >= anchorHigh * (1 - (dipPct - CONFIRM_CEIL_BPS / 100) / 100)) {
      dipArmed = false; // bounce ate the edge; wait for a fresh dip
      return [];
    }
    if (close > prevClose) confirmStreak++;
    else confirmStreak = 0;
    if (confirmStreak >= CONFIRM_BARS) {
      dipArmed = false;
      buysSent++;
      const buy: BuyInput = {
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: state.cash,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      };
      return [buy];
    }
    return [];
  },
});
