// Writes docs/COVERAGE.md from the product catalog, so the published coverage report can never
// drift from what the Terminal itself reports on its Instruments > Coverage tab.
//   npm run coverage
import { writeFileSync } from 'node:fs';
import { catalogSummary } from '../server/core/catalog.js';

const LEVEL = { full: 'Full lifecycle', partial: 'Partly manual', manual: 'Manual inputs', planned: 'Not implemented' };
const { products, families, counts, total } = catalogSummary();
const groups = new Map();
for (const p of products) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p); }
const esc = (s) => String(s || '').replace(/\|/g, '\\|');

let md = `# Implementation coverage

Generated from \`server/core/catalog.js\` by \`npm run coverage\`. The same list, with filters, is on the
Terminal's **Instruments > Coverage** tab.

Listing a product here is not a claim that market data exists for it. Coverage describes what the
paper engine does with an instrument once it is registered and priced. Prices, option chains,
borrow availability, repo rates and model marks come from Shaffer MarketData and Analytics Lab;
until those are connected every instrument is registered and priced by hand (always labelled as
manual), or exercised in the isolated demo environment.

| Level | Products | What it means |
|---|---:|---|
| Full lifecycle | ${counts.full} | Orders, fills, settlement, accounting and scheduled lifecycle events are simulated automatically from the contract terms. |
| Partly manual | ${counts.partial} | Trading, settlement and accounting are automatic. Some lifecycle events or contract features are recorded by hand, as the note for each product says. |
| Manual inputs | ${counts.manual} | The instrument can be held and accounted for, but its valuation and cash flows are entered by hand. |
| Not implemented | ${counts.planned} | Listed for completeness; cannot be traded. |
| **Total** | **${total}** | |

`;
for (const [group, list] of groups) {
  md += `## ${group}\n\n| Product | Engine family | Level | What is simulated, and what is not |\n|---|---|---|---|\n`;
  for (const p of list) md += `| ${esc(p.name)} | ${esc(families[p.family]?.label || p.family)} | ${LEVEL[p.support] || p.support} | ${esc(p.note)} |\n`;
  md += '\n';
}
writeFileSync(new URL('../docs/COVERAGE.md', import.meta.url), md);
console.log(`docs/COVERAGE.md written: ${total} products (${counts.full} full, ${counts.partial} partly manual, ${counts.manual} manual inputs).`);
