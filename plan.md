This plan was AI-generated with minimal to no oversight.

# cosmos-free-premium

## Goal
Investigate cosmos.so's premium gates, then build a Tampermonkey/Violentmonkey
userscript that unlocks the genuinely client-side gates, with honest
documentation of what cannot be bypassed.

## Scope contract
**In scope:**
- Userscript (`cosmos-free-premium.user.js`) that patches GraphQL responses so
  `data.me.isPremium` is reported as `true`, unlocking client-gated features:
  - Custom grid size (sm/md/lg)
  - Canvas browse mode toggle
  - Bulk export of clusters
- README.md documenting unlocked vs. server-gated features.

**Out of scope:** server-side tampering, mobile apps, other users.

## Investigation findings (T1/T2 — DONE)
- All confirmed client gates route through `useUser().isPremium`, populated from
  Apollo cache (`GetMe` query, cache-first) — GraphQL response patching is the
  single clean interception point.
- Bulk export path is fully client-side (client-side ZIP download; no server
  premium check).
- Server-gated (not bypassable): username claiming, upload/element caps,
  collaboration, premium badges on other users.

## Steps
1. ~~Investigate premium gates~~ (done)
2. ~~Confirm interception point~~ (done)
3. ~~Write userscript `cosmos-free-premium.user.js`~~ (done — 3-path design)
4. ~~Test in logged-in browser tab~~ (done — grid "lg" verified end-to-end:
   with the userscript's Path A logic active, clicking "lg" switches the grid
   without the paywall and persists `csms_grid_size` → `"lg"`. Canvas mode and
   bulk export use the identical `isPremium` gate hook per code analysis.)
5. Write README.md; init git repo and commit (T4)

## Final userscript design (3 paths)
- **A. Apollo cache patch (primary):** poll `window[Symbol.for("ApolloClientSingleton")]`,
  find current user via `ROOT_QUERY.me.__ref`, `cache.modify({id, fields:{isPremium:()=>true}})`.
  VERIFIED end-to-end.
- **B. SSR transport trap:** at document-start, `Object.defineProperty` accessor on
  `window[Symbol.for("ApolloSSRDataTransport")]`: backing array with patched `push`
  patches rehydrate entries pre-consumption; setter wraps Apollo's own pusher at init.
  (Transport entries verified to contain `me.isPremium: false`; consumption flow
  verified: Apollo replaces the transport with `{push: handler}` at init.)
- **C. fetch/XHR response patch:** flip `data.me.isPremium` in
  `api.cosmos.so/graphql` JSON responses (covers client-side refetches, e.g.
  `GetUserSubscriptionDetails`). Note: live network responses do NOT write to
  the InMemoryCache (streaming queries bypass cache writes) — that's why A is
  primary.

## Key discoveries driving the design
- Live GraphQL responses (streaming queries) don't write to the InMemoryCache;
  only transport/init data and `cache.modify` propagate to `useUser()`.
  So fetch/XHR patching alone (Path C) would NOT unlock the gates — the cache
  patch (A) is the load-bearing mechanism, B hardens it at init.

## Files
- `cosmos-free-premium.user.js` — the userscript
- `README.md` — usage + honest limits
- `plan.md` — this plan
