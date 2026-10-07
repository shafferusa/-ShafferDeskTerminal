# Task V3: confirmation validation, and settlement / calendar configuration

Owner request section **3** from "Keep the single quote snapshot." to its end, and section **4** (all).

Your workspace: `$SP/v3` (port 8831 demo, 8832 normal mode). Migration id: **6** (only if you need one).

## Files you own
- `server/quant/calendar.js`, `server/core/instruments.js`, `server/core/defaults.js`, `server/core/settlement.js`
- New `test/core/confirmation.test.js`, new `test/core/settlement-config.test.js`, `test/core/futures-fx.test.js`
- `web/views/preview.js`, `web/views/settings.js`, `web/views/registry.js`, `web/views/instrument.js`
- Regions of shared files: `server/core/packages.js` (the preview result's per-leg figures and `submit`'s
  `expected` guard); `server/core/orders.js` (what an order stores from its preview, and what a fill records);
  settlement-date and calendar code in `server/products/*.js` (`calendarInfo`, `settleDate`, payment-date
  adjustment; collateral code in swap.js / fx.js / option.js belongs to V2: do not touch); `server/api.js`
  (instrument, calendar and settings routes); `web/views/markets.js` (a calendar badge only);
  `web/views/strategy-detail.js` (the orders / fills table only).

## Part A: confirmation validation (section 3)
Today `packages.submit` accepts `expected: { cash }`, re-prices, and refuses with 409 `preview_changed` if the net
cash moved by more than `fill.maxPreviewDriftPct` (0.5, a code default). The owner's requirements:
1. Keep the single quote snapshot per preview.
2. The threshold is configurable per Book in Settings (and the default stays in `defaults.js`). Separate, named
   tolerances are fine (per-leg price, package cash, quote age); each is editable, each shown in the preview.
3. Validate each leg AND the whole package at confirmation, against what was displayed: price / estimated fill,
   quantity, fees, cash, margin, collateral, financing amount and rate, settlement date, borrow availability, quote
   status and freshness, notional exposure, funding shortfall. A small net cash change must not hide large moves
   in offsetting legs: check legs individually and a gross measure, not only the net.
4. When something changed beyond tolerance or a non-numeric term changed (settlement date, quote status, financing
   terms, a leg no longer available), refuse, return the new preview, and have the screen show exactly what
   changed (was / now, per leg and per total) and require a new confirmation of the new figures. No silent
   re-pricing, no auto-confirm.
5. What was confirmed must reconcile with what executed: each order keeps the confirmed preview figures (price,
   cash, fees, snapshot time); each fill records the difference between its actual figures and the confirmed
   ones, with the reason (for example filled at the ask on the next cycle, within tolerance), so a permitted
   change is an explicit record on the order and visible in the strategy's order table and history. Ledger
   postings must equal the fill; the test proves confirmed -> fill -> ledger reconcile to the cent.
6. The hedge popup's "Execute now" (`web/views/hedge.js`, owned by V1) uses `expectedOf(pv)` from preview.js: keep
   that export working and make it carry whatever your guard needs.

## Part B: settlement and calendars (section 4)
Today `calendarInfo(inst)` picks one calendar per instrument from an explicit `terms.calendar`, the venue country
or the currency; there is no screen control for it; settlement lag comes from Book assumptions by family.
1. Instrument-specific calendars: trading, settlement and payment calendars can each be set per instrument
   (including joint calendars), with the currency calendar(s) applied to payments. `calendarInfo` reports all
   three with their basis. The registry form lets the user set them; the instrument page shows them.
2. Settlement convention configurable per instrument (lag in business days, or same-day, where the product allows)
   and per transaction on the ticket (a stated settlement date or lag for this trade), validated against the
   settlement calendar: a stated date that is not a business day there, or is before trade date, is a calendar
   conflict and blocks the preview with a specific message.
3. Approximate and weekends-only calendars are shown prominently: a visible badge and sentence on the instrument,
   the ticket, the preview leg and the Marketplaces row, not only a tooltip.
4. Borrowing plus immediate spot FX: write engine tests, with hand-worked expectations, that follow one
   "borrow and convert" from execution to repayment and reconcile at each date: the liability and its interest
   start date; cash available to trade and to withdraw in each currency before the FX settles; the pending pay
   and receive obligations and their value date on the joint calendar (include a case where a holiday in one
   currency moves the value date); balances after settlement; interest accrued by day count; repayment of
   principal plus interest leaving zero liability; nothing counted twice. Fix whatever does not reconcile.
5. Tests for 1 to 3 as well (an instrument with its own calendars settling differently from its currency default;
   a per-transaction settlement override; a calendar conflict).

## Browser check
A two-leg package whose legs move in opposite directions between preview and confirm (pin demo quotes or use the
demo feed's movement): the refusal names both legs; re-confirm executes. Settings tolerance edited and persisted.
Registry: set calendars and settlement lag on an instrument; ticket with a settlement override; the weekends-only
badge on an instrument with no calendar. Preview leg table readable at 1440, 1024 and 390 wide with totals and
the confirm controls always visible. Light and dark; normal mode once.
