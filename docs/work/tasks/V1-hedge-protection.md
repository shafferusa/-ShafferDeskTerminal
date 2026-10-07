# Task V1: hedge request states, recommendation source, Investment Strategy IDs, protection allocation, linkage

Owner request sections: **1** (first four bullets), **2** (all), and the hedge parts of **8** ("Test hedge
reconnection against current exposure, including positions changed or closed while waiting. Receiving a
recommendation must never execute it automatically.").

Your workspace: `$SP/v1` (port 8811 demo, 8812 normal mode). Migration id: **4**.

## Files you own
- `server/core/hedge.js`, `server/data/demo-hedge.js`, `test/core/hedge.test.js`, new `test/core/protection.test.js`
- `web/views/hedge.js`, `web/views/strategy.js`
- Hedge / Strategy parts of: `server/data/ports.js`, `server/data/shaffer.js`, `server/data/shaffer-contract.js`,
  `server/data/index.js`
- Regions of shared files: `server/core/packages.js` (`analyzeProtection`, the `appendHedge` handling, the
  `extra-protection` / `over-protection` checks, and where legs get `purpose` / `hedgeLinkId`);
  `server/core/accounting.js` (open-position rows: relationship fields only); `server/api.js` (hedge, analytics and
  `/api/demo/*fixture*` routes); `web/views/accounting.js` (the pills on a position row only);
  `web/views/strategy-detail.js` (a "Linked to" relationships block only); `web/views/data.js` (hedge fixture
  wording only); `web/app.js` (the top-bar connection chips and the "N to review" chip only).

## What is wrong today (seen by the owner in screenshots)
- The hedge review queue says "recommendation ready, 4 packages" while the top bar says "Analytics Lab: awaiting".
  Those packages come from the demo fixture, but the queue row does not say so.
- The demo fixture answers requests that are incomplete (no investment Strategy, holding period or objective).
- The hedge popup's leg table clips its right-hand columns (collateral, notional, margin are cut off).
- The awaiting popup lists what is missing but the form to complete it is a collapsed side panel.
- For a new trade, every hedge held in the Account is passed as `existingHedges` and counted as protection.

## What to build

### A. One explicit request state, plus connection, plus source
Give every hedge request a derived `state` (returned by every route that returns a request, the queue and prompts):
`incomplete` (required context missing: say which), `awaiting_connection` (complete, Shaffer Hedge unavailable),
`ready_for_analysis` (complete, service reachable, not yet answered or being asked), `recommendation_ready`,
`executing` (a package was confirmed and has working legs), `executed`, `dismissed`, `closed` (the position it was
for no longer exists), `error`. Completeness and connection are separate facts: show both when both apply.
- An incomplete request is stored and shown but is NOT sent to the service or answered by the fixture. Completing
  it ("Other, defined by the Strategy on the server" remains a valid objective) sends it when a service is there.
- Every stored response records its source: `{ kind: 'shaffer-hedge' | 'demo-fixture' | 'test-fixture', label,
  version (the service's model/run/version id if it gave one, else null and shown as "not supplied"), receivedAt,
  exposureAsOf, and a fingerprint of the exposure it was computed against }`. Freshness is derived, never stored
  as a claim: `current` (exposure unchanged since receivedAt), `stale` (position quantity, hedges or scope changed
  since; say what changed), and separately whether the source is reachable now ("cached: Shaffer Hedge is not
  reachable now").
- The queue row, the popup header, the position pill and the strategy page must show source, received time,
  version and freshness. With the demo fixture the words "demo fixture, not Shaffer Hedge" appear on the queue row
  and in the popup. The top bar must not contradict the queue: keep "Analytics Lab: awaiting" (true) and add a
  visible, separate indication when the demo fixture is what is answering hedge requests.
- Reconnection: a waiting request is refreshed in place against exposure as it is at that moment. If the position
  grew or shrank, the request's primary amount reflects it. If the position was closed, the request becomes
  `closed` with a reason and is not sent. A stale recommendation cannot be executed until refreshed. Nothing is
  ever executed on receipt.

### B. Completing a request
In the popup (and from the queue), when the request is incomplete the completion form is the main content, not a
collapsed aside: investment Strategy, intended holding period, hedge objective, scope. "Save request" stores it;
the state then moves on visibly. Keep "What was sent" available.

### C. Investment Strategies by stable ID
- `investmentStrategy` is `{ id, name, resolved: true, source, version? }` when chosen from the list that
  Analytics Lab supplies (`analytics.strategies()`), and `{ id: null, name, resolved: false }` when typed while the
  list is unavailable. An unresolved name is labelled as unresolved wherever it appears (Strategies page, popup,
  queue, strategy detail, accounting) and is never silently treated as an ID.
- When the list is available, offer to resolve an unresolved name to a listed Strategy; the user confirms the
  match (an exact-name match may be suggested, never applied automatically). Stored IDs are what is sent.
- Investment Strategies and execution templates (collar, spread, ...) stay separate concepts in data and labels.
- In demo mode, the labelled fixture may supply a small fictional Strategy list with IDs so this path can be
  exercised; in normal mode the list is awaiting until the service exists.

### D. Protection: context, allocation, no double counting
- The request sends the Account's positions and hedges as context. It no longer asserts that every hedge in the
  Account protects the new trade. Each hedge sent is tagged with what the Terminal actually knows:
  `linked` (explicitly linked to this primary: executed from this position's hedge request, or a hedge leg in the
  same strategy instance), `template` (protection proposed inside the execution template being built),
  `allocated_elsewhere` (allocated to another position; say how much capacity is left), `unassessed` (held in the
  Account, no link and no assessment).
- Analytics Lab decides applicability and sizing for anything not explicitly linked. Its response may carry a
  protection assessment: allocations of existing hedge positions to the exposure (hedge position, protected
  position, units or capacity allocated, basis `shared`, note) and a list of hedges it judged unrelated. The
  Terminal stores, displays and validates these; it does not compute them.
- New table (migration 4) for protection allocations: hedge position, protected position (and strategy instance),
  units, basis (`explicit_link` | `template` | `service`), source (and request id), status (`active` | `released` |
  `expired`), timestamps. Explicit links and template protection create allocations when their legs fill, and
  release them when the hedge or the primary is closed or the hedge expires.
- Validation: the units allocated from one hedge across all positions never exceed that hedge's capacity (contracts
  x deliverable for options; state the rule you use for other kinds, and where capacity has no unit measure say so
  and require the service's allocation to carry one). An allocation that would over-allocate, refers to a position
  in another Book, or to an expired or closed hedge is rejected with a specific message and shown as rejected.
- Display per position: linked protection, service-identified shared protection (with source and time), protection
  allocated elsewhere, unrelated hedges, and, when hedges are held in the Account but nothing has assessed them,
  the words **"Protection assessment unavailable."** Remaining exposure is computed only from allocations that
  exist; unassessed hedges are never counted.
- The preview's protection check (`analyzeProtection`) works from these allocations and the template's own legs.
  It must still stop accidental duplicate protection inside one strategy instance (template collar plus a hedge
  package put), sized against the remaining exposure and explained; and it must not treat unassessed Account hedges
  as protection.
- The demo fixture (labelled) plays the service for demos: it may return allocations for hedges on the same
  underlying using a simple illustrative rule, stated as illustrative. Add a demo-only way to load a scripted
  response (packages and protection assessment) so tests and the browser harness can control the "service"; it is
  labelled `test-fixture` everywhere.

### E. Shared identifiers
Primary trades, hedge requests, hedge legs, borrowings and financing legs must be traceable to each other through
stored identifiers (strategy instance id, hedge request id, the leg/position a financing leg funds). Show these
relationships on the position row and the strategy detail ("Financing for Long 300 BRVO", "Hedge leg of request
HDG-..., protects Long 300 BRVO"). A financing leg or hedge leg never generates its own post-trade hedge request,
and re-running any step never creates a second request for the same primary (idempotent on the primary).

### F. Popup legs
Replace the clipped table: every leg's quantity, quote or indicative terms, premium or price, fees, margin,
collateral and financing requirement must be readable without horizontal clipping at 1440, 1024 and 390 wide
(responsive leg details: stacked labelled fields per leg, or a table that reflows). Totals and the Execute /
Inspect / Dismiss controls stay visible (sticky) while the legs scroll. Keep one snapshot and leg-derived totals.

## Tests (engine level, `test/core/protection.test.js` and `hedge.test.js`)
Use a scripted test fixture for the service. Cover at least: unrelated hedge in the Account (not counted, "assessment
unavailable" until assessed, "unrelated" after); partial coverage (linked put on part of the position: remaining
exposure is the difference); a shared hedge allocated by the service across two positions (capacity not exceeded;
an over-allocation is rejected); opposite-direction exposure (a put linked to a long does not protect a short in
the same name); expired protection (released at expiry, exposure unprotected again); protection already in a
template (collar) with a hedge package then requested; incomplete request not sent; state transitions; source and
freshness (stale after the position changes); reconnection after the position grew, shrank, and was closed;
no second request for the same primary; a financing leg creates no request; nothing executes on receipt.
Work expected numbers out by hand in comments.

## Browser check
Marketplace buy -> popup (incomplete -> complete -> recommendation ready -> execute); the queue; fixture off
(awaiting) then on; Strategies page with a Strategy chosen by ID and one typed; a position with linked protection
and one with an unassessed Account hedge; light and dark; 1440, 1024 and 390 wide; once in normal mode.
