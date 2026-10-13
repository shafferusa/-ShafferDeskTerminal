# Accounting verification: a worked ledger

This document is the hand-worked ledger behind `test/core/accounting-verification.test.js` (engine level, part of
`npm test`) and the system case `accounting:verification-book` (`npm run test:system:api -- --area=accounting`,
`npm run test:system:browser -- --area=accounting`). Every expected figure below was derived by hand from the inputs
stated here **before** the Terminal was run. It was then written as a literal into `EXPECT` in
`test/system/cases/accounting.mjs`. The "Terminal" column is what the Terminal reported in the run of 2026-10-13. It
was read from the routes, and at browser level also from the Accounting screens.

One discrepancy was found, and it was in the Terminal: the balance sheet translated capital and internal funding at
today's rate (section 9). The Terminal now matches the hand figures at every checkpoint: 1,155 checks at engine level,
1,154 at API level, and 1,405 at browser level, the extra ones being screen reads.

## 1. Inputs

**Book.** "Verification Book", reporting currency USD. Treasury and two Accounts, North and South.

**Paper-desk settings** (stated in full, so nothing rests on a default):
- Commissions: equity 0.01 a share (minimum 1.00 an order), options 0.65 a contract, futures 2.25 a contract. Bonds, FX
  and swaps pay none.
- Settlement: T+1 for US equities, bonds and option premium; T+2 for foreign equities; T+2 for spot FX on both
  currencies' calendars.
- Shorts: collateral 102% of market value, margin hold 30%. Written puts are cash-secured. No dividend withholding.

**Clock.** Monday 2 March to Wednesday 11 March 2026. There is no US, SIFMA, TARGET or Tokyo holiday in that range.
The end-of-day run happens after 17:00 New York time.

**Fixtures.** These stand in for Shaffer MarketData and are labelled "Test fixture".

| Item | Until Fri 6 Mar 10:05 | Afterwards |
|---|---|---|
| EUR/USD | 1.10 | 1.12 |
| USD/JPY | 150 | 160 |

| Instrument | Quote to Fri 6 Mar | Quote from Mon 9 Mar |
|---|---|---|
| VRFY (NYSE, USD) | bid 99.90, ask 100.00, last 99.95 | 101.90 / 102.00 / 101.95 |
| EURF (XETRA, EUR) | 49.90 / 50.00 / 49.95 | 50.40 / 50.50 / 50.45 |
| VRFY 20 Mar 95 put (100 shares) | 1.20 / 1.30 / 1.25 | 0.80 / 0.90 / 0.85 |
| VRFC 6% 6-Mar-2031 note (30/360, coupons 6 Mar and 6 Sep, % of par) | 98.40 / 98.50 / 98.45 | 98.90 / 99.00 / 98.95 |
| V5M6 index future (50 USD a point, initial margin 10,000) | 4,999.75 / 5,000.00 | 5,024.75 / 5,025.00 |

Other fixtures:
- Futures settlement prices: 5,010 on 2 to 5 March, and 5,020 on 6 March.
- IRS (pay 4% fixed, receive VER-3M, notional 1,000,000) is marked per 100 of notional:
  - 0.00 at entry;
  - +1.50 at Monday's end of day, stated as of 27 February, so the mark is stale;
  - +1.00 from Friday 10:05, a current mark.

  The marks are positive, so the swap is in North's favour. Quote fixtures refuse negative values (section 10), which
  is why North is on the winning side.
- Borrow of VRFY: available, with a fee of 1.00% a year on market value (ACT/360).
- Collateral agreement "CSA Verification Bank", bilateral, covering North:
  - independent amount: 2% of notional;
  - variation margin: yes;
  - threshold: 0;
  - minimum transfer: 0;
  - netting: per position.

## 2. The steps

| Checkpoint | When | What happens |
|---|---|---|
| C0 | Mon 10:00 | Capital comes in: 2,000,000 USD and 100,000 EUR into Treasury. Treasury funds North (900,000 USD) and South (500,000 USD and 60,000 EUR). North transfers 50,000 USD to South. |
| C1 | Mon 10:00 | North borrows 300,000 USD from a bank: 6.00% ACT/360, so 50.00 a day. The bank charges a 250.00 arrangement fee, recorded as a fee on the loan. Treasury borrows 30,000,000 JPY at 1.46% ACT/365 (1,200 JPY a day) and sells it at once for 200,000 USD at 150, value Wed 4 Mar. North buys 1,000 VRFY. South sells 500 VRFY short against a borrow. North buys 100,000 face of the note between coupons. South writes 2 puts. North buys 2 futures. South buys 1,000 EURF. North enters the swap at zero upfront under the agreement. |
| C2 | Mon 17:30 | End of day. Futures variation margin is paid. The swap is called on a stale mark. The short's collateral is topped up. |
| C3 | Tue 10:00 | The T+1 trades settle. North repos the note. The refusals of section 6 are tried. |
| C4 | Fri 10:00 | The end-of-day runs of 3, 4 and 5 March catch up. The T+2 trades settle on Wed 4. A dividend of 0.50 a share has ex-date and pay date Thu 5. The note's coupon is paid Fri 6. |
| C5 | Fri 10:05 | EUR/USD moves to 1.12 and USD/JPY to 160. The swap gets a current mark of +1.00. |
| C6 | Fri 10:10 | The put's quote is removed, and EUR/USD is stated as of Wed 4, so the rate is stale. The quote and rate are restored at 10:15. |
| C7 | Fri 17:30 | End of day. |
| C8 | Mon 9 10:00 | The repo is repurchased early. Everything is closed and North's loan is repaid. Treasury buys the yen it needs to repay its loan, value Wed 11. |
| C9 | Wed 11 10:00 | Everything has settled and the yen loan is repaid. |
| C10 | Wed 11 | North and South send everything back to Treasury. |

## 3. Trade-date arithmetic (C1)

**North's loan.** North receives 300,000 USD of cash and owes a 300,000 liability. The 250.00 fee is paid in cash and
goes to Fees. The borrowing register shows `feesToDate` 250.00 on this loan record.

**Treasury's borrow-and-convert.**
- Treasury receives 30,000,000 JPY of settled cash and owes a 30,000,000 JPY liability. At 150 these are worth
  200,000 USD each.
- The conversion to dollars has not settled yet. Treasury is owed 200,000 USD (a receivable) and owes 30,000,000 JPY
  (a payable), both due Wed 4 Mar.
- The conversion is done at the reporting rate, so it creates no dealing cost.

**VRFY long (North).** 1,000 shares at the ask, 100.00, cost 100,000. Commission is 1,000 × 0.01 = 10.00, so North
owes 100,010.00 at settlement. At last 99.95 the shares are worth 99,950, which is unrealized −50.

**VRFY short (South).**
- 500 shares are sold at the bid, 99.90, for 49,950.00. Commission is 5.00, so the proceeds owed to South are
  49,945.00. These will arrive as restricted cash.
- The position is a negative cost of −49,950. Its value is −500 × 99.95 = −49,975, which is unrealized −25.
- The margin hold reserves 0.30 × 500 × 99.95 = 14,992.50 of cash.

**Note (North): quotation, accrued interest and settlement amount.**
- The quote is in percent of par; the multiplier is 0.01.
- Principal: 100,000 × 98.50 / 100 = 98,500.00.
- The trade settles Tue 3 Mar. Days on 30/360 from the last coupon (6 Sep 2025) to settlement:
  360 × 1 + 30 × (3 − 9) + (3 − 6) = 177.
- Accrued interest: 100,000 × 6% × 177 / 360 = 2,950.00.
- Settlement amount: 98,500.00 + 2,950.00 = 101,450.00. The preview states this amount.
- Value at the last price: 98,450 clean, which is unrealized −50. The accrued interest is a separate asset of 2,950.

**Puts (South).** 2 contracts at 1.20 × 100 = 240.00. Commission is 1.30, so South is owed 238.70. The position is a
negative cost of −240. Its value is −2 × 1.25 × 100 = −250, which is unrealized −10. The cash-secured reserve is
2 × 100 × 95 = 19,000.

**Futures (North).** 2 contracts at the ask, 5,000.00. Notional: 2 × 5,000 × 50 = 500,000. Initial margin:
2 × 10,000 = 20,000, moved from cash to margin. Commission: 4.50, paid in cash. Value: 0, since last equals the
reference.

**EURF (South).** 1,000 shares at 50.00 EUR. Commission is 10.00 EUR, so South owes 50,010.00 EUR on Wed 4. Value is
49,950 EUR, which is unrealized −50 EUR, or −55.00 USD at 1.10.

**Swap (North).** Upfront 0. The independent amount is 2% × 1,000,000 = 20,000, moved from cash to margin. The mark is
0, so the value is 0.

**Balance sheets at C1** (liabilities shown positive; EUR at 1.10, JPY at 150):

| Owner | Line | Amount |
|---|---|---|
| Treasury | Cash | 600,000 USD + 40,000 EUR + 30,000,000 JPY |
| | Receivable | 200,000 USD |
| | Payable | 30,000,000 JPY |
| | Borrowed | 30,000,000 JPY |
| North | Cash | 850,000 + 300,000 − 250 − 20,000 − 4.50 − 20,000 = 1,109,745.50 |
| | Margin | 40,000 |
| | Accrued income | 2,950 |
| | Positions | 99,950 + 98,450 + 0 + 0 = 198,400 |
| | Payable | 100,010 + 101,450 = 201,460 |
| | Borrowed | 300,000 |
| South | Cash | 550,000 USD + 60,000 EUR |
| | Receivable | 49,945 + 238.70 = 50,183.70 |
| | Positions | −49,975 − 250 = −50,225 USD; 49,950 EUR |
| | Payable | 50,010 EUR |

| C1, USD | Hand: assets | Hand: liabilities | Hand: net assets | Terminal: net assets |
|---|---:|---:|---:|---:|
| Treasury | 600,000 + 44,000 + 200,000 + 200,000 = 1,044,000.00 | 200,000 + 200,000 = 400,000.00 | 644,000.00 | 644,000.00 |
| North | 1,351,095.50 | 501,460.00 | 849,635.50 | 849,635.50 |
| South | 550,000 + 66,000 + 50,183.70 + 4,720 = 670,903.70 | 55,011.00 | 615,892.70 | 615,892.70 |
| Book | 3,065,999.20 | 956,471.00 | 2,109,528.20 | 2,109,528.20 |

**Results to date at C1.** −471.80, made up of:
- Fees: −250.00.
- Commissions: 10 + 4.50 + 5 + 1.30 + 11.00 (the 10 EUR) = −31.80.
- Unrealized: −50 − 50 − 25 − 10 − 55 = −190.00.

Net assets reconcile: 2,110,000 − 471.80 = 2,109,528.20.

## 4. Consolidation and the elimination

Capital is 2,000,000 USD plus 100,000 EUR at 1.10, which is 2,110,000.

Internal funding, at the rates it was booked at:

| Owner | Funding |
|---|---:|
| Treasury | −1,400,000 USD − 60,000 EUR × 1.10 = −1,466,000 |
| North | 900,000 − 50,000 = +850,000 |
| South | 500,000 + 50,000 + 66,000 = +616,000 |

The three sum to 0. On the worksheet the elimination column reads "eliminated, 1,466,000.00 advanced, 1,466,000.00
received", and the Whole Book funding line is 0. The Terminal shows exactly this from C0 to C9.

The North-to-South transfer of 50,000 changes the two Accounts' funding lines, and nothing else:
- Book P&L at C0 is 0.00, and the owners' P&L adds up to the Book's at every checkpoint.
- Every Book line equals Treasury + North + South, currency by currency. This is checked at every checkpoint.

## 5. Borrowings, interest, fees and collateral: each once

**Borrowing records.** Each borrowing is one record, on its owner's balance sheet:
- At C1 there are three: North's USD loan, Treasury's JPY loan, and South's securities borrow (500 VRFY, worth 49,975).
- From C3 there are four, with North's repo added.
- Treasury's own balance sheet lists only its JPY loan. Its oversight lists the Accounts' records under the same IDs.
- The Book register holds each ID once. In every owner and currency, the accrued interest on the register equals the
  owner's accrued-expense line.

**Interest by day count.** Interest runs from the drawdown date; Monday's end of day counts 0 days.

| Borrowing | Daily | Accrued by C4 (3 days) | Later |
|---|---|---|---|
| North USD loan | 300,000 × 6% / 360 = 50.00 | 150.00 | 200.00 at C7. Repaid Mon 9 after 7 days: 350.00, paid with the principal. |
| Repo (from Tue 3) | 98,372 × 4.5% / 360 = 12.2965 | 2 days: 24.593 → 24.59 | 3 days: 36.89 at C7. Repurchased Mon 9 after 6 days: 73.779 → 73.78. |
| Treasury JPY loan | 30,000,000 × 1.46% / 365 = 1,200 JPY | 3,600 JPY, booked at 150 = 24.00 | 4,800 JPY at C7. Repaid Wed 11 after 9 days: 10,800 JPY. In USD: 3,600 at 150 = 24.00, plus 7,200 at 160 = 45.00, total 69.00. |
| VRFY borrow fee | 500 × 99.95 × 1% / 360 = 1.38819 | 4.1646 → 4.16 | 5.55 at C7. The cover on Mon 9 adds 3 days at 101.95 (4.2479), for 9.8007 → 9.80, paid on return. |

**Collateral.** Each amount sits on one balance sheet:
- **Short collateral.** At Monday's end of day the collateral required is 1.02 × 500 × 99.95 = 50,974.50. Of that,
  49,945 is pending from the sale, so 1,029.50 moves from cash to restricted. On Tuesday the proceeds land: restricted
  cash is 50,974.50, and it equals the "collateral cash" on the borrow record.
- **Swap.** The independent amount of 20,000 is posted (North's margin line). At C2 the stale mark +1.50 gives a value
  of 15,000. The counterparty posts 15,000, held as restricted cash and owed back. This is North's "Cash collateral
  received" liability of 15,000. The call is labelled provisional, because the mark is stale.
- **Swap, Friday.** On Friday's end of day the current mark +1.00 gives a value of 10,000, so 5,000 is returned to the
  counterparty. At the close, 10,000 more is returned and the 20,000 independent amount comes back to North.
- **Futures.** Margin of 20,000 sits in North's margin line until the close.

## 6. What cannot be spent (C3, refused and asserted)

| Attempt | Hand: what is available | Terminal's refusal |
|---|---|---|
| South transfers 520,000 USD | Settled 549,209.20 − reserved 33,992.50 (14,992.50 margin hold + 19,000 put reserve) = 515,216.70. The 50,974.50 of restricted cash is not available. | "South has 515,216.70 USD of settled USD available; 520,000.00 USD requested." |
| South buys 5,200 VRFY | Needs 520,000 + 52.00 commission = 520,052.00, against 515,216.70 free: short by 4,835.30 | Blocked, "short 4,835.30 USD" |
| North transfers 1,050,000 USD | Settled cash is 1,007,657.50. Margin (40,000) and the collateral received (15,000) are excluded. | "North has 1,007,657.50 USD of settled USD available; 1,050,000.00 USD requested." |
| North sells the pledged note | 0 of 100,000 is unencumbered | Blocked |
| North repos for 98,372.01 | See the repo proceeds below | Blocked: "supports at most 98,372.00 USD" |

**Repo proceeds** (Tue 3, collateral valued dirty to the start date):
- Clean value: 100,000 × 98.45 / 100 = 98,450.00. Accrued interest: 2,950.00 (177 days). Worth: 101,400.00.
- Haircut: 2% = 2,028.00, leaving 99,372.00. Less the 1,000 buffer: 98,372.00.

The Terminal's preview reconciliation matches field by field: worth, clean, accrued, haircutAmount, afterHaircut,
buffer and supports.

## 7. Income, costs and FX, each in its own line

| Item | Hand | P&L line |
|---|---|---|
| Dividend on 1,000 VRFY (North) | 1,000 × 0.50 = 500.00 | Dividends |
| Dividend compensation on 500 borrowed VRFY (South) | 500 × 0.50 = 250.00 | Borrowing and funding expenses |
| Coupon on the note | Coupon 3,000 less accrued interest bought 2,950 = 50.00 by C4. After the coupon, 4 more days to the sale's settlement on Tue 10: 66.67. Total 116.67. | Coupon and interest income |
| Borrow fee | 9.80 | Borrowing and funding expenses |
| Funding cost | USD loan 350.00, repo 73.78, yen loan 69.00 | Borrowing and funding expenses |
| Commissions | Mon 2: 31.80. Mon 9: VRFY 10 + futures 4.50 + cover 5 + puts 1.30 + EURF 10 EUR at 1.12 = 11.20, so 32.00. Total 63.80. | Commissions |
| Fee | Loan arrangement fee 250.00 | Fees |

**FX at C5.** FX effects are kept apart from performance:
- EUR:
  - Treasury: 40,000 × 0.02 = 800.00.
  - South: (9,990 cash + 50,000 EURF at cost) × 0.02 = 1,199.80.
  - Total: 1,999.80.
- JPY: the loan 30,000,000 × (1/150 − 1/160) = 12,500.00, plus the accrued 3,600 JPY (booked at 24.00, now 22.50):
  1.50. Total 12,501.50.
- Total FX: 14,501.30. Dealing cost: 0.

The Terminal shows "Translation of EUR balances" 1,999.80, "Translation of JPY balances" 12,501.50, and dealing 0.00.
EURF's local loss of −50 EUR is performance, shown in unrealized P&L at the current rate: −56.00.

## 8. Missing mark and stale rate (C6)

At C6 the put has no price at all, and the EUR/USD rate is two days old.

The put is not valued at any price; it is carried at its cost, −240:
- South's positions are −49,975 − 240 = −50,215 USD.
- Unrealized P&L leaves out the put: 9,819.00, marked incomplete.
- Book NAV is 2,135,135.75, provisional and not complete.

The Terminal names both causes, on the API and on the Book positions screen:
- "VRFY260320P95 (South): no price, so it is carried at cost"
- "EUR: converted at a rate that is not current"

When the quote and a current rate return, the C5 figures come back.

## 9. Checkpoint figures, hand against Terminal

All amounts are in USD. Results are stated at the rates in force when each capital and funding flow was booked.

| | Treasury net assets | North | South | Book net assets | Book results | Terminal Book NA / results |
|---|---:|---:|---:|---:|---:|---:|
| C0 | 644,000.00 | 850,000.00 | 616,000.00 | 2,110,000.00 | 0.00 | 2,110,000.00 / 0.00 |
| C1 | 644,000.00 | 849,635.50 | 615,892.70 | 2,109,528.20 | −471.80 | 2,109,528.20 / −471.80 |
| C2 | 644,000.00 | 865,635.50 | 615,892.70 | 2,125,528.20 | 15,528.20 | 2,125,528.20 / 15,528.20 |
| C3 | 644,000.00 | 865,635.50 | 615,892.70 | 2,125,528.20 | 15,528.20 | same |
| C4 | 643,976.00 | 866,010.91 | 615,638.54 | 2,125,625.45 | 15,625.45 | same |
| C5 | 657,277.50 | 861,010.91 | 616,837.34 | 2,135,125.75 | 25,125.75 | same (before the fix: results 23,125.75) |
| C6 | 657,277.50 | 861,010.91 | 616,847.34 | 2,135,135.75 (provisional) | 25,135.75 | same |
| C7 | 657,270.00 | 861,948.61 | 616,835.95 | 2,136,054.56 | 26,054.56 | same (before the fix: 24,054.56) |
| C8 | 657,270.00 | 864,688.89 | 616,363.20 | 2,138,322.09 | 28,322.09 | same (before the fix: 26,322.09) |
| C9 | 657,232.50 | 864,688.89 | 616,363.20 | 2,138,284.59 | 28,284.59 | same (before the fix: 26,284.59) |
| C10 | 2,138,284.59 | 0.00 | 0.00 | 2,138,284.59 | 28,284.59 | same |

Some of the C2 to C4 movements, worked by hand:
- **C2, North:** +1,000 of futures variation, (5,010 − 5,000) × 50 × 2, and +15,000 of swap value.
- **C4, North:** +500 dividend, +50 coupon income, −174.59 interest.
- **C4, South:** −250 dividend compensation, −4.16 borrow fee.
- **C4, Treasury:** −24.00 of yen interest.

**Book P&L at C5.** Investment P&L is 25,125.75, made up of:

| Line | Amount |
|---|---:|
| Realized | 1,000.00 |
| Dividends | 500.00 |
| Coupon and interest income | 50.00 |
| Borrowing and funding | −452.75 |
| Commissions | −31.80 |
| Fees | −250.00 |
| Unrealized | 9,809.00 |
| FX | 14,501.30 |

**End state (C9).** The Book holds only cash:

| Owner | Cash | Working |
|---|---|---|
| North | 864,688.89 USD | |
| South | 548,737.60 USD + 60,380 EUR | USD: 550,000 − 1,029.50 + 238.70 − 250 − 9.80 − 30.50 − 181.30. The cover of 51,005 was paid from the 50,974.50 restricted plus 30.50 of cash. EUR: 9,990 + 50,390. |
| Treasury | 612,432.50 USD + 40,000 EUR | 800,000 − 187,567.50 paid for 30,010,800 JPY |

The result reconciles exactly, at 2,138,284.59 − 2,110,000.00 = 28,284.59:

| Line | Amount | Made up of |
|---|---:|---|
| Realized | 14,233.00 | futures 2,475; VRFY 1,900; note 400; swap 10,000; short −1,050; puts 60; EURF 400 EUR × 1.12 = 448 |
| Dividends | 500.00 | |
| Coupon | 116.67 | |
| Financing | −752.58 | |
| Commissions | −63.80 | |
| Fees | −250.00 | |
| FX | 14,501.30 | |

The ledger holds no restricted cash, margin, unsettled trade, accrual, position, loan or collateral balance, and no
cash is still reserved. These are asserted from the ledger itself. The integrity read is clean at every checkpoint.

**C10.** The Accounts return all their cash. The Book's net assets and P&L are unchanged. The funding lines carry the
Accounts' results with the opposite sign:
- North: 850,000 − 864,688.89 = −14,688.89.
- South: USD 1,262.40, and EUR 66,000 − 60,380 × 1.12 = −1,625.60, so −363.20.
- Treasury: +15,052.09.

## 10. Discrepancies and observations

1. **Terminal fault, fixed: the balance sheet translated capital and internal funding at today's rate.**
   - **Where:** `server/core/accounting.js`, `balanceSheet`.
   - **What happened:** after EUR/USD moved to 1.12, the Book showed capital of 2,112,000. That is 100,000 EUR at
     today's rate, not the 2,110,000 contributed. "Results to date" lost the 2,000 FX gain on the euros, so the Book
     showed 26,284.59 against a P&L of 28,284.59. South's results showed −836.80 against +363.20.
   - **Why the hand figure is right:** contributed capital is a historical amount. The FX gain on euros held is a
     result, and the P&L statement counts it under "FX effects". The balance sheet's own note says results include FX
     effects.
   - **The fix:** capital and internal funding cells now use the reporting-currency amounts stored on their ledger
     entries. The funding received in Treasury's oversight does the same. The local-currency amounts are unchanged, as
     are assets, liabilities, net assets and the elimination.
   - **Proved by:** checkpoints C5 to C10, and the test "balance sheet: capital and internal funding stay at the rates
     they were booked at". `npm test` is otherwise unchanged by the fix.
2. **Presentation convention, not changed.** Short positions, written options and contracts with a negative value
   reduce the "Positions at market value" asset line. They are not shown as liabilities.
   - At owner level they are held apart: North's column shows +213,400 and South's −50,225 at C2.
   - Gross long and short are reported in Holdings: VRFY long 1,000, short 500, net +500. Net exposure is
     99,950 − 49,975 = 49,975.
   - Net assets are unaffected. GAAP-style presentation would show securities sold short as a liability. Changing this
     would change the published balance-sheet layout that more than 160 product specifications assert, so it is left
     for the owner to decide.
3. **Convention.** A dividend is posted on its pay date. No receivable is recognised between the ex-date and the pay
   date. In this scenario the two dates are the same.
4. **Convention.** For a foreign holding, unrealized P&L is the local gain or loss at today's rate. FX on its cost is
   in FX effects. So EURF's −50 EUR is −56.00 at 1.12, and the 1.00 difference from 1.10 sits in unrealized P&L.
5. **Limitation of the test fixtures, not of the accounting.** `POST /api/demo/fixtures/quote` refuses negative prices.
   An out-of-the-money swap mark therefore cannot be a fixture, and could not be marked stale. Manual marks can be
   negative, but they never go stale. This scenario therefore uses a swap in North's favour, which also exercises cash
   collateral received.
