// Writes docs/COVERAGE.md from the product catalog, so the published coverage report can never
// drift from what the Terminal itself reports on its Instruments > Coverage tab. The report keeps
// two dimensions apart for every product: lifecycle support (what the paper engine simulates) and
// pricing coverage (where the product's price comes from). It also lists the built-in settlement
// calendars, read from server/quant/calendar.js.
//   npm run coverage
import { writeFileSync } from 'node:fs';
import { catalogSummary } from '../server/core/catalog.js';
import { CALENDARS, COUNTRY_CALENDAR, CURRENCY_CALENDAR } from '../server/quant/calendar.js';

const LEVEL = { full: 'Full lifecycle', partial: 'Partly manual', manual: 'Manual inputs', planned: 'Not implemented' };
const BASIS = { quoted: 'Market quote', model: 'Model mark', contractual: 'No price needed', manual: 'Valued by hand' };
const { products, families, counts, pricing, pricingLabels, total } = catalogSummary();
const groups = new Map();
for (const p of products) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p); }
const esc = (s) => String(s || '').replace(/\|/g, '\\|');
const basisName = (id) => BASIS[id] || id;

let md = `# Implementation coverage

Generated from \`server/core/catalog.js\` by \`npm run coverage\`. The same list, with filters, is on the
Terminal's **Instruments > Coverage** tab.

Two separate things are stated for every product, and neither implies the other. **Lifecycle
support** is what the paper engine does with an instrument once it is registered and priced: orders,
fills, settlement, accounting and lifecycle events. **Pricing coverage** is where the product's
price comes from: a market quote from Shaffer MarketData, a dealer or model mark from Shaffer
Analytics Lab, no price at all (the position is carried at principal plus accrued), or a value
entered by hand. A product can have a fully simulated lifecycle and no price source yet, or a price
source and a lifecycle that is partly recorded by hand.

Listing a product here is not a claim that market data exists for it. The pricing column names the
source a price is expected from, not whether prices are arriving: that is reported dataset by
dataset on the Terminal's **Data connection** page, and instrument by instrument in the registry.
Until Shaffer MarketData and Analytics Lab are connected every instrument is registered and priced
by hand (always labelled as manual), or exercised in the isolated demo environment.

## Lifecycle support

| Level | Products | What it means |
|---|---:|---|
| Full lifecycle | ${counts.full} | Orders, fills, settlement, accounting and scheduled lifecycle events are simulated automatically from the contract terms. |
| Partly manual | ${counts.partial} | Trading, settlement and accounting are automatic. Some lifecycle events or contract features are recorded by hand, as the note for each product says. |
| Manual inputs | ${counts.manual} | The instrument can be held and accounted for, but its valuation and cash flows are entered by hand. |
| Not implemented | ${counts.planned} | Listed for completeness; cannot be traded. |
| **Total** | **${total}** | |

## Pricing coverage

| Pricing basis | Products | What it means |
|---|---:|---|
${Object.keys(pricing).map((id) => `| ${basisName(id)} | ${pricing[id]} | ${esc(pricingLabels[id])}. |`).join('\n')}
| **Total** | **${total}** | |

`;
for (const [group, list] of groups) {
  md += `## ${group}\n\n| Product | Engine family | Lifecycle | Pricing | Lifecycle: what is simulated, and what is not |\n|---|---|---|---|---|\n`;
  for (const p of list) md += `| ${esc(p.name)} | ${esc(families[p.family]?.label || p.family)} | ${LEVEL[p.support] || p.support} | ${basisName(p.pricing)} | ${esc(p.note)} |\n`;
  md += '\n';
}

const countriesOf = (id) => Object.keys(COUNTRY_CALENDAR).filter((c) => COUNTRY_CALENDAR[c] === id && c !== 'UK');
const currenciesOf = (id) => Object.keys(CURRENCY_CALENDAR).filter((c) => CURRENCY_CALENDAR[c] === id);
const usedFor = (id) => {
  if (id === 'US') return 'Venues in US and instruments in a US market view, except debt securities';
  if (id === 'USBOND') return 'Debt securities on a US venue or in a US market view';
  if (id === 'USD') return 'US dollar payments; every spot FX value date must also be a US dollar banking day';
  if (id === 'WEEKEND') return 'Any venue country or currency with no calendar in this table';
  if (id === 'ALLDAYS') return 'Digital assets';
  return [countriesOf(id).length ? `Venues in ${countriesOf(id).join(', ')}` : '', currenciesOf(id).length ? `${currenciesOf(id).join(', ')} payments` : ''].filter(Boolean).join('; ');
};
md += `## Settlement calendars

Settlement dates and payment dates are worked out on the Terminal's own rule-based calendars, listed
below from \`server/quant/calendar.js\`, until Shaffer MarketData supplies market calendars. An
instrument's calendar is the one named in its own terms, else the calendar of its listing-venue
country (an instrument in a US market view with no country recorded uses the US calendars), else
the payment calendar of its settlement or trading currency. For a euro-area venue the TARGET closing
days are used; any further closing days of its exchange are not included. A spot FX value date uses
the payment calendars of both currencies and must also be a US dollar banking day.

| Calendar | What it covers | Used for |
|---|---|---|
${Object.values(CALENDARS).map((c) => `| ${c.id} | ${esc(c.label)} | ${esc(usedFor(c.id))} |`).join('\n')}

Payment calendar by currency: ${Object.entries(CURRENCY_CALENDAR).map(([ccy, id]) => `${ccy} uses ${id}`).join(', ')}.

Any other market or currency has no calendar and falls back to weekends only (the WEEKEND calendar).
The fallback is never silent: the instrument states it, and every trade preview that works out a
date on it carries a warning. Rule-based calendars cannot know one-off closures; those, and local
holidays for a market on the fallback, are entered by hand under **Settings > Market calendars**.
`;
writeFileSync(new URL('../docs/COVERAGE.md', import.meta.url), md);
console.log(`docs/COVERAGE.md written: ${total} products. Lifecycle: ${counts.full} full, ${counts.partial} partly manual, ${counts.manual} manual inputs. Pricing: ${Object.keys(pricing).map((id) => `${pricing[id]} ${basisName(id).toLowerCase()}`).join(', ')}.`);
