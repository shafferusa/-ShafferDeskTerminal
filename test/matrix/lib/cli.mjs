// Shared command line for run-api.mjs and run-browser.mjs.
//
//   --family=equity[,fund]   only these spec files
//   --product=adr[,etf]      only these products
//   --workers=1              scenarios run at once (browser level only; default 1)
//   --headed, --slow=ms      browser level: show the browser, slow every action down
//   --keep                   browser level: keep screenshots of the last screen of each scenario

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { family: null, product: null, workers: 1, headed: false, slow: 0, keep: false };
  for (const a of argv) {
    const [k, v] = a.replace(/^--/, '').split('=');
    if (k === 'family') out.family = v;
    else if (k === 'product') out.product = v;
    else if (k === 'workers') out.workers = Math.max(1, Number(v) || 1);
    else if (k === 'headed') out.headed = true;
    else if (k === 'slow') out.slow = Number(v) || 0;
    else if (k === 'keep') out.keep = true;
    else throw new Error(`Unknown option ${a}. See test/matrix/README.md.`);
  }
  return out;
}

/** Run `job(item)` over items with at most `n` running at once, keeping the input order of results. */
export async function pool(items, n, job) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await job(items[i], i);
    }
  }));
  return out;
}
