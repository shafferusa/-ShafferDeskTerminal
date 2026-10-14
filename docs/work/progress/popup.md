# popup: hedge popup race (SB:hedge:reconnection flake)
## Done
- Race proven: new case SB:hedge:prompt-race (test/system/cases/hedge.mjs, browser part hedgePromptRace in test/system/lib/browser-cases.mjs) holds the /api/hedge/prompts answer while the prompt is created and announced; on the old web/app.js the popup never opened (before.log).
- Fix in web/app.js: checkPrompts() serialises checks, remembers a refresh that arrives during an in-flight check and checks again after; slow check every 10 s (+ on tab shown); EventSource onopen checks (first) / bumps (reconnect); a CLOSED stream is reopened after 3 s; promptsShown set prevents the same prompt twice.
- hedge area browser: reconnection 47 checks, prompt-race 18 checks, both passed (after.log).
- npm test 811/811; npm run test:system:browser 3x: 39/39 each (sys1-3.log); npm run test:browser -- --family=templates: 30 scenarios, no failures (blocked steps are the specs' expected refusals) (templates.log).
## In progress
- none
## Next
- report
