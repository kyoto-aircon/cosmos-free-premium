This README was AI-generated with minimal to no oversight.

# cosmos-free-premium

A [Tampermonkey](https://www.tampermonkey.net/)/[Violentmonkey](https://violentmonkey.github.io/) userscript that unlocks cosmos.so's **client-gated** Premium features.

## What it unlocks

All three features below are gated purely client-side (verified by tracing the
production JavaScript); this userscript unlocks them for real:

| Feature | Status |
|---|---|
| **Custom grid size** (sm/md/lg) | ✅ Unlocked — verified end-to-end |
| **Canvas browse mode** | ✅ Unlocked — same gate mechanism as grid size |
| **Bulk export of clusters** | ✅ Unlocked — same gate mechanism; export runs the real client-side ZIP downloader |

## What it does NOT unlock (server-verified)

Being honest about the limits: anything the server checks server-side cannot
be bypassed by a userscript, and this script does not try.

| Feature | Why it can't be bypassed |
|---|---|
| **Claiming premium-reserved usernames** | Availability is validated via server-side `GetUsernameDetails` / `GetSuggestedUsernames`; the claim flow talks to Stripe billing |
| **Upload/element free-tier caps** | Enforced server-side at upload time |
| **Collaboration on collections** | Invites are re-checked by the server |
| **Other users' premium badges** | Cosmetic flags rendered from server data about other users |

## How it works

cosmos.so gates these features purely by reading `useUser().isPremium`, which
comes from an Apollo Client cache entity (`User:<id>`, referenced by
`ROOT_QUERY.me`). There is no other check — flip that flag and the gates open.

The userscript flips the flag through three independent, surgical paths, so a
site update is unlikely to break all of them at once:

1. **Path A — Apollo cache patch (primary).** Polls for the Apollo client
   (`window[Symbol.for("ApolloClientSingleton")]`), finds the current user via
   `ROOT_QUERY.me.__ref`, and sets `isPremium: true` with `cache.modify`.
   This is the path verified end-to-end: with it active, switching grid size
   to "lg" no longer shows the paywall and actually changes the grid.
2. **Path B — SSR transport patch.** Apollo rehydrates its initial data from
   `window[Symbol.for("ApolloSSRDataTransport")]`. The script runs at
   `document-start` and installs a property trap on that transport, patching
   `me.isPremium` in every rehydration entry before Apollo consumes it.
3. **Path C — network patch.** `fetch`/XHR responses from
   `api.cosmos.so/graphql` get `data.me.isPremium` flipped. Best-effort
   only: live streaming responses don't write to Apollo's cache, so this
   covers edge cases (e.g. refetches that do), not the main path.

Everything is wrapped in try/catch and fails open: if any patch fails, the
original data/response passes through untouched, so the site keeps working.

Only `data.me.isPremium` is modified. Other users' `isPremium` flags (used to
render cosmetic premium badges) are deliberately left alone.

## Install

1. Install Tampermonkey (or Violentmonkey) for your browser.
2. Open Tampermonkey's dashboard → Utilities → paste the contents of
   `cosmos-free-premium.user.js` as a new script (or drag the file in).
3. Open https://www.cosmos.so — the features above are unlocked. Open the
   devtools console to see `[cosmos-free-premium]` logs confirming each path.

## Verified vs inferred

- **Directly verified (Oct 2026, logged-in free account):** clicking the "lg"
  grid option with the patch active switches the grid without the paywall,
  and the choice persists (`csms_grid_size` → `"lg"`).
- **Inferred (same code path, not individually clicked):** canvas browse mode
  and bulk export. Both are gated by the exact same premium hook
  (`isPremium ? run() : showUpsellDialog()`); the export path additionally
  contains no server-side re-check — it's a real client-side ZIP download of
  your own cluster's elements.

## Technical notes

- Tested against cosmos.so app version `2026.1022.13557+sha.4a5becc`
  (Apollo Client 4.x). Path B depends on `Symbol.for("ApolloSSRDataTransport")`
  and Path A on `Symbol.for("ApolloClientSingleton")` — both documented
  Apollo Client integration points, so they should be reasonably stable.
- If cosmos.so changes their gating, the worst case is that a path silently
  stops having an effect; the site is never broken by design.

## Disclaimer

This only changes what your own browser displays/believes about your own
account. It does not and cannot grant server-side premium entitlements, and it
does not interact with other users' accounts. If you find the Premium features
valuable, support Cosmos by subscribing.

## License

MIT
