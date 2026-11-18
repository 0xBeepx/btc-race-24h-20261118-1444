// BTC race bot: range dip-buyer on cbBTC 1-minute bars (agent-fun/bars-replay/v1).
//
// Thesis: over a single day BTC usually swings ~1-2% inside a slow range.
// The bot only buys after the price has fallen well below its own recent
// high (a dip inside the range, not a chase), then sells when the price
// climbs back to the top of that range, or at a small take-profit /
// stop-loss. It never shorts, never uses leverage, never holds through a
// freefall: a wide stop, a hold cap and a drawdown halt bound the damage.
//
// Rules, all in bar time (no clock, no network, no files, no randomness):
// - Reference: the rolling high of the last WINDOW_BARS closes.
// - Entry (flat, not cooling down, not halted, WINDOW_BARS closes seen):
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

// --- tuning constants (grid-searched on the new dev window) ---
const WINDOW_BARS = 360; // rolling-high window, bars
const DIP_PCT = 1.4; // entry: close this far below the rolling high, %
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

// --- state, kept across batches ---
const closes: number[] = []; // close prices in USDC, oldest first
let holdSince = -1; // seq of the first batch the current position was seen in
let cooldownUntil = -1; // seq before which no new entry is taken
let halted = false; // set by the drawdown guard, never cleared
let peakEquity = 0n; // highest equity seen, quote units

function rollingHigh(): number {
  let high = -Infinity;
  const start = closes.length - WINDOW_BARS;
  for (let i = start; i < closes.length; i++) {
    if (closes[i] > high) high = closes[i];
  }
  return high;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const scale = state.symbols.get(SYMBOL)!.price_scale;
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) closes.push(Number(bar.c) / 10 ** scale);
    }

    // Equity peak tracking, at the latest close.
    if (state.equity > peakEquity) peakEquity = state.equity;

    const held = state.positions.get(SYMBOL);
    if (held !== undefined && holdSince === -1) holdSince = state.seq;

    // Drawdown guard: flatten and halt for the rest of the window.
    if (held !== undefined && peakEquity > 0n && state.equity * 100n < peakEquity * BigInt(DD_GUARD_PCT)) {
      halted = true;
      holdSince = -1;
      const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [sell];
    }

    if (held !== undefined) {
      // --- exits ---
      const value = state.value(SYMBOL, held.qty);
      const cost = held.cost;
      const high = rollingHigh();
      const close = closes[closes.length - 1];
      const heldBars = state.seq - holdSince;
      const takeProfit = value * 10000n >= cost * BigInt(10000 + TP_BPS);
      const stopLoss = value * 10000n <= cost * BigInt(10000 - SL_BPS);
      const backAtTop = close >= high * (1 - TOP_PCT / 100);
      const heldTooLong = heldBars >= MAX_HOLD_BARS;
      if (takeProfit || stopLoss || backAtTop || heldTooLong) {
        if (stopLoss) cooldownUntil = state.seq + COOLDOWN_BARS;
        holdSince = -1;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // --- entry ---
    if (state.warmingUp || halted) return [];
    if (state.seq < cooldownUntil) return [];
    if (closes.length < WINDOW_BARS) return [];
    const close = closes[closes.length - 1];
    if (TREND_BARS > 0) {
      const n = Math.min(TREND_BARS, closes.length);
      let sum = 0;
      for (let i = closes.length - n; i < closes.length; i++) sum += closes[i];
      if (close < sum / n) return [];
    }
    const high = rollingHigh();
    if (close < high * (1 - DIP_PCT / 100)) {
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
