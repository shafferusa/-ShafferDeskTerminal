# Task V2: paper collateral agreements and clearing terms

Owner request section **3**, first four paragraphs ("Do not hard-code 'TRS posts collateral; CDS does not'" down
to "Never net across separate Books..."). The confirmation-threshold part of section 3 belongs to task V3.

Your workspace: `$SP/v2` (port 8821 demo, 8822 normal mode). Migration id: **5**.

## Files you own
- New `server/core/agreements.js` (wire it in `server/app.js`), new `test/core/collateral.test.js`,
  `test/core/otc.test.js`
- Collateral and margin parts of the OTC plugins: `server/products/swap.js` (swap and cds), `server/products/fx.js`
  (forward), `server/products/option.js` (otcoption). Their settlement-date functions belong to V3: do not touch.
- New `web/views/agreements.js` if you want a dedicated screen component; the "Collateral inventory" tab of
  `web/views/treasury.js`; the collateral section of `web/views/account.js`.
- Regions of shared files: `server/core/orders.js` (the cash / margin / collateral sufficiency check at execution);
  `server/core/engine.js` (the end-of-day pass: a call into your true-up); `server/core/accounting.js` (balance
  sheet lines and Treasury collateral inventory for posted / received collateral); `server/core/packages.js` (only
  where a leg's margin / collateral requirement is added to the preview); `server/api.js` (agreement routes);
  `web/lib/contracts.js` (a "Collateral terms" field group on OTC contract forms).

## Today
`server/products/swap.js` has `terms.initialMarginPct` on swaps: an independent amount posted to `cash.margin` by
`trueUpCollateral`, returned at close. CDS, forwards and OTC options post nothing. That is a product-level
assumption baked into code, which the owner rejects. Futures margin comes from the Book's paper-desk assumptions
(`server/core/defaults.js`); leave futures as they are but describe them as clearing terms in the UI/docs.

## What to build
1. **Agreements as records.** A Book holds paper collateral agreements: id, name, counterparty, kind (`bilateral`
   (CSA-style), `cleared`, `uncollateralized`), covered Accounts/Treasury, netting scope, eligible collateral,
   threshold, minimum transfer amount, independent amount / initial margin requirement, variation margin on or off,
   haircuts, valuation frequency (the engine's end-of-day pass), status. An agreement belongs to exactly one Book.
2. **Every applicable OTC position states its collateral basis explicitly**: an agreement id, or position-level
   terms entered on the ticket, or the explicit choice "Uncollateralized (paper assumption)". Applicable = swap,
   cds, forward and otcoption families (written OTC options and forwards carry counterparty exposure). There is no
   product-specific default in code. A new OTC contract cannot be previewed without one of the three; the preview
   and the position show which applies. Positions that predate this (no basis recorded) are shown as
   "No collateral terms recorded (treated as uncollateralized)", flagged, not silently assumed.
   Keep `terms.initialMarginPct` working as position-level terms for existing data.
3. **Mechanics you implement, driven only by the configured terms:**
   - independent amount / initial margin (percent of notional, or a fixed amount) posted when the position opens and
     trued up when notional changes;
   - variation margin at each end-of-day pass from the netting set's current mark: we post when the set is out of
     the money beyond the threshold, we receive (restricted cash plus a matching liability) when it is in the money
     beyond the threshold; minimum transfer amount respected; haircut applied to non-base-currency cash if the
     agreement says so;
   - netting scope: per position, or all positions under the agreement inside one Account;
   - release / return on reduction, close, maturity, termination; nothing left posted for a closed position;
   - every movement is a ledger event naming the agreement, the positions in the netting set, the requirement and
     the basis mark (with its observation). Missing marks: no fabricated call; the requirement is shown as
     "cannot be valued" and flagged;
   - insufficient cash for a call: the call fails visibly (needs attention, retried), never funded silently; an
     opening trade whose initial requirement cannot be met is blocked in the preview.
4. **Sharing across Accounts** is allowed only through an agreement that explicitly lists those Accounts and a
   posting unit, and each movement records the allocation of the posted or received amount to each Account. No
   implicit sharing. **Never across Books**: validate and test it.
5. **Unsupported rules are named, not ignored.** If an agreement term is recorded but not enforced (for example
   securities as eligible collateral, rehypothecation, interest on collateral, rating-based thresholds, intraday
   calls, dispute handling), the agreement screen and the position say "recorded, not simulated" for that term.
   Decide which terms you implement and list the rest explicitly; do not present an unenforced term as active.
6. **Screens.** Create / edit / close an agreement (Treasury, Collateral tab, plus what an Account needs); choose the
   collateral basis on OTC contract forms; show on each position its basis, requirement, posted / received amounts
   and last movement; show posted and received collateral on balance sheets exactly once (posted margin is our
   asset; collateral received is restricted cash with a matching liability); never spendable.

## Tests (engine level)
Hand-worked numbers in comments. At least: TRS and CDS each under (a) a bilateral agreement with IA and VM,
(b) position-level terms, (c) explicit uncollateralized, proving behaviour follows the terms and not the product;
threshold and minimum transfer amount; per-position versus agreement netting giving different calls for the same
positions; receive side (in the money) creates restricted cash plus liability, not buying power; release on partial
reduction and on close leaves zero posted; a shared agreement across two Accounts records allocations that sum to
the movement; an agreement cannot cover a unit of another Book; a failed call is visible and retried without
double posting; missing mark produces no call and a flag; balance sheet shows each amount once at Account,
Treasury and Book scope.

## Browser check
Create an agreement, trade a swap and a CDS under it from the ticket, advance the demo clock through a mark change
so a call and a return happen, close the positions, confirm nothing remains posted; light and dark; normal mode once.
