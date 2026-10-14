// Other products (p1): one Terms and records tab for repos, loans, securities loans, manually valued holdings, currency
// balances, spot assets, digital assets and forwards. The relevant terms from the contract; the Book's records (what
// the paper engine has scheduled, the values entered by hand) as the product's reports; history is the History tab
// where the product has a market price.
import { html } from '../../../vendor/preact-htm.js';
import { isNum } from '../../../lib/core.js';
import { Missing } from '../../../lib/ui.js';
import { registerTabContent } from '../../workspace.js';
import { detailRows, ManualMarks, MarkInUse, pageHref, relatedOf, RelatedPanel, ScheduledPanel, TermsBlock, useFacts, val } from './common.js';

const INTRO = {
  repo: 'A repurchase agreement of this Book: cash against collateral, opened, rolled and closed from Treasury or the Account. It has no market price.',
  loan: 'A loan or deposit of this Book, arranged on the Treasury or Account page. Interest follows the rate terms; it has no market price.',
  secloan: 'A securities loan of this Book: the security lent or borrowed against collateral and a fee. It has no market price of its own.',
  cash: 'A currency balance held as ledger cash.',
  manual: 'Valued by hand: the Shaffer server supplies no price for it. Its valuation history is the values entered here, each labelled as manual.',
  spot: 'A spot asset or commodity, held in its own quantity unit and priced as stated below.',
  crypto: 'A digital asset, held in its own units and priced per unit.',
  forward: 'A bilateral forward: settles on its value date at the agreed price. Marks are under Marks and history.',
};
const ARRANGEMENT = new Set(['repo', 'loan', 'secloan', 'cash']);

function OtherTerms({ inst, detail, sel, asOf, book }) {
  const t = inst.terms || {};
  const facts = useFacts(sel, book);
  const und = inst.underlying;
  const rows = [
    ['Product', inst.support?.productName || inst.productId],
    inst.issuer ? ['Issuer or manager', inst.issuer] : null,
    und ? ['Underlying', html`<a href=${pageHref(und.id)}><span class="sym">${und.symbol || und.name}</span></a> <span class="muted small">${und.symbol ? und.name : ''}</span>`] : null,
    ['Quantity in', t.quantityUnit ? `${inst.qtyLabel} (${t.quantityUnit})` : inst.qtyLabel],
    ARRANGEMENT.has(inst.family) ? null : ['Price quoted', `${t.priceUnits || inst.priceUnits}, ${inst.tradingCcy}`],
    isNum(inst.multiplier) && inst.multiplier !== 1 ? ['Multiplier', `${inst.multiplier} (price units per quantity unit)`] : null,
    inst.family === 'manual' && isNum(t.valuationMaxAgeDays) ? ['Valuation due', `A value older than ${t.valuationMaxAgeDays} days is flagged as stale`] : null,
    ['Venue or counterparty', val(inst.venue || t.counterparty, inst.venueType === 'otc' ? 'OTC, no venue recorded' : 'Not recorded')],
    ['Settlement convention', inst.settlement?.label || html`<${Missing} />`],
    ...detailRows(inst, []),
  ];
  // A forward's mark and the values entered by hand are on its Marks and history tab.
  const priced = !ARRANGEMENT.has(inst.family) && inst.family !== 'forward';
  return html`<div class="stack" data-testid="other-terms">
    <div class="ws-cols"><${TermsBlock} title="Terms" rows=${rows} intro=${INTRO[inst.family] || null} testid="other-contract" />
      <div class="stack">${priced ? html`<${MarkInUse} inst=${inst} detail=${detail} />` : null}
        ${relatedOf(inst) ? html`<${RelatedPanel} inst=${inst} sel=${sel} />` : null}
        ${ARRANGEMENT.has(inst.family) ? html`<p class="note">Open, roll, repay or terminate it from <a href="#/treasury/borrowings">Treasury, Borrowings and lending</a> or the Account page; every event is in <a href="#/accounting/history">Accounting, History</a>.</p>` : null}</div></div>
    ${priced ? html`<${ManualMarks} inst=${inst} detail=${detail} title=${inst.family === 'manual' ? 'Valuations entered by hand' : 'Prices entered by hand'} />` : null}
    <${ScheduledPanel} facts=${facts} inst=${inst} book=${book} asOf=${asOf} />
  </div>`;
}

registerTabContent('other-terms', OtherTerms);
