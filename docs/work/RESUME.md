# Resume note: server integration layer and instrument-detail workspace (started 2026-10-14)

Request: `briefs/OWNER_REQUEST3.txt`. Shared brief: `briefs/BRIEF6.md`. Workers run on Opus 5.5 (owner's choice);
the owner sends "pause" for the usage guard. `LOG.md` lists milestones; `progress/` holds each worker's notes.

Phases (the owner's order): 1 client interfaces, fixture mode, connection states; 2 stable IDs and reference
search; 3 prices, history, FX, reference data; 4 earnings, statements, documents, corporate actions, news;
5 SP3E valuations, signals, risk, Hedge; 6 real-server acceptance (blocked until credentials and contracts exist).

Wave 1 (parallel): D1 server client layer (phases 1 to 3 of the server side, plus the request/response plumbing
for 4 and 5 with fixtures); W1 instrument-detail workspace framework (drawer, full page, header, navigation from
everywhere, product-specific tab framework, trading and hedge integration, as-of view). Wave 2: equity tabs
(E1 overview + price history + earnings; E2 financial statements + filings; E3 corporate actions + news +
analytics & risk + positions), P1 product-specific pages. Wave 3: integration tests of the listed failure modes,
docs (data-contract requirements, integration checklist), final run and report.

**Completeness: about 23.5% of the pass** (last milestone 2026-10-14T14:04Z, p1: p1: swaps and credit (legs pay/receive, reference exposure, financing, collateral and agreement, schedules with next payment, mark in use, manual and supplied marks with provenance, history) and other products (terms and Book records for repo/loan/secloan/manual/cash/spot/crypto/forward); tests green)
