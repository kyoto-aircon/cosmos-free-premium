// ==UserScript==
// @name         Cosmos Free Premium
// @namespace    https://github.com/kyoto-aircon/cosmos-free-premium
// @version      1.0.1
// @description  Unlocks cosmos.so's client-gated Premium features (custom grid size, canvas mode, bulk export). Server-gated features are NOT bypassed — see README.
// @author       kyoto-aircon
// @license      MIT
// @match        https://www.cosmos.so/*
// @match        https://cosmos.so/*
// @noframes
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * How it works
 * -------------
 * cosmos.so gates several Premium features purely on the client side:
 * Everything reads `useUser().isPremium`, which comes from an Apollo
 * cache entity ("User:<id>", referenced by ROOT_QUERY.me).
 *
 * This script flips that flag to true through three independent paths:
 * No single point of failure, and if cosmos.so changes its internals,
 * the remaining paths (or none) still apply gracefully.
 *
 *   A. Apollo cache patch (primary): polls for the ApolloClient instance
 *      and flips the me entity's isPremium field. Verified to unlock
 *      the gates without any server round-trip.
 *   B. SSR transport patch: Apollo rehydrates from
 *      window[Symbol.for("ApolloSSRDataTransport")] at init; we trap that
 *      array/object and patch me entries before Apollo consumes them.
 *   C. Network patch: fetch/XHR responses from api.cosmos.so/graphql get
 *      data.me.isPremium flipped. Best-effort only: live streaming
 *      responses don't reach Apollo's InMemoryCache, so this covers
 *      edge cases (e.g. refetches writing to cache), not the main path.
 *
 * What this unlocks (client-gated, verified):
 *   - Custom grid size (sm/md/lg)
 *   - Canvas browse mode
 *   - Bulk export of clusters
 *
 * What this can NOT unlock (server-verified; documented in README):
 *   - Premium username claiming
 *   - Upload/element caps
 *   - Collaboration invites
 *   - Other users' premium badges
 */

(function () {
  "use strict";

  const DEBUG = true;
  const TAG = "[cosmos-free-premium]";
  /** Master switch. Every client gate routes through me.isPremium anyway. */
  const ENABLED = true;
  /** Path A: interval in ms for re-asserting the Apollo cache flag. */
  const CACHE_POLL_MS = 3000;

  const log = (...args) => DEBUG && console.info(TAG, ...args);

  // ------------------------------------------------------------------
  // Shared patch logic
  // ------------------------------------------------------------------

  /**
   * Flip data.me.isPremium to true in a parsed GraphQL response body
   * (single or batched). Returns the patched body or null if unchanged.
   */
  function patchResponseBody(text) {
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return null; // not JSON — leave untouched
    }

    const entries = Array.isArray(body) ? body : [body];
    let patched = 0;

    for (const entry of entries) {
      const me = entry && entry.data && entry.data.me;
      if (!me || typeof me !== "object") continue;
      if (me.isPremium === true) continue;
      me.isPremium = true;
      patched++;
    }

    if (patched === 0) return null;
    log(`path C: patched me.isPremium in ${patched} response entr${patched === 1 ? "y" : "ies"}`);
    return JSON.stringify(body);
  }

  /** Patch JSON text; on any failure return the original so the site keeps working. */
  function safePatch(text) {
    if (!ENABLED) return text;
    try {
      return patchResponseBody(text) ?? text;
    } catch (err) {
      console.warn(TAG, "patch failed, passing through", err);
      return text;
    }
  }

  /**
   * Flip me.isPremium to true in an ApolloSSRDataTransport entry.
   * Entry shape: { rehydrate: { <transportId>: { data: { me: {...} } } } }
   */
  function patchTransportEntry(entry) {
    try {
      if (!entry || typeof entry !== "object") return entry;
      const rehydrate = entry.rehydrate;
      if (!rehydrate || typeof rehydrate !== "object") return entry;
      for (const key of Object.keys(rehydrate)) {
        const me = rehydrate[key] && rehydrate[key].data && rehydrate[key].data.me;
        if (me && typeof me === "object" && me.isPremium !== true) {
          me.isPremium = true;
          log("path B: patched transport entry", key);
        }
      }
    } catch (err) {
      console.warn(TAG, "transport entry patch failed", err);
    }
    return entry;
  }

  // ------------------------------------------------------------------
  // Path A: Apollo cache patch (primary)
  // ------------------------------------------------------------------

  try {
    const clientSymbol = Symbol.for("ApolloClientSingleton");
    let asserted = false;

    const assertPremium = () => {
      const client = window[clientSymbol];
      if (!client || !client.cache) return;

      let dump;
      try {
        dump = client.cache.extract();
      } catch {
        return;
      }

      // Current user: the "me" query references the logged-in user's entity.
      // The cache key may carry arguments ("me({...})"), so match both forms.
      const root = dump["ROOT_QUERY"];
      if (!root) return;
      let me = null;
      for (const key of Object.keys(root)) {
        if ((key === "me" || key.startsWith("me(")) && root[key] && root[key].__ref) {
          me = root[key];
          break;
        }
      }
      if (!me) return;

      const entity = dump[me.__ref];
      if (!entity || entity.isPremium !== true) {
        try {
          client.cache.modify({
            id: me.__ref,
            fields: { isPremium: () => true },
          });
          log("path A: set", me.__ref, "isPremium=true", asserted ? "(re-asserted)" : "");
        } catch (err) {
          console.warn(TAG, "path A: cache.modify failed", err);
          return; // keep polling; maybe a partial cache
        }
      }
      asserted = true;
    };

    // Poll: the Apollo client appears whenever the app finishes initializing.
    setInterval(() => {
      if (!ENABLED) return;
      try {
        assertPremium();
      } catch (err) {
        console.warn(TAG, "path A tick failed", err);
      }
    }, CACHE_POLL_MS);
    // Also run eagerly once the document is up.
    setTimeout(() => {
      try {
        assertPremium();
      } catch {}
    }, 0);

    log("path A: watching for Apollo client");
  } catch (err) {
    console.warn(TAG, "path A setup failed", err);
  }

  // ------------------------------------------------------------------
  // Path B: SSR data transport patch (needs @run-at document-start)
  // ------------------------------------------------------------------

  try {
    const transportSymbol = Symbol.for("ApolloSSRDataTransport");

    // Our backing array: SSR scripts do `window[eS] ??= []` and push
    // rehydrate entries into it. We pre-install it with a patching push
    // so every entry gets patched before Apollo consumes the array.
    const backing = [];
    const realPush = Array.prototype.push;
    backing.push = function (...items) {
      for (const item of items) realPush.call(backing, patchTransportEntry(item));
    };

    // `current` tracks the live transport: our backing array until Apollo
    // replaces it with its own pusher object at init time. The getter must
    // return Apollo's object afterwards, or its rehydrate entries are lost.
    let current = backing;

    Object.defineProperty(window, transportSymbol, {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (v) => {
        // Apollo replaces the array with its own pusher object at init
        // time; wrap its push so late-arriving entries get patched too.
        if (v && typeof v === "object" && typeof v.push === "function") {
          const originalPush = v.push;
          v.push = function (...items) {
            for (const item of items) originalPush.call(v, patchTransportEntry(item));
          };
        }
        current = v;
      },
    });

    log("path B: SSR transport trap installed");
  } catch (err) {
    console.warn(TAG, "path B setup failed", err);
  }

  // ------------------------------------------------------------------
  // Path C: network response patch (fetch + XHR)
  // ------------------------------------------------------------------

  // Resolve to an absolute URL so relative requests match too; tolerate
  // invalid inputs by returning a string that never matches.
  const isGraphQlUrl = (url) => {
    if (typeof url !== "string" || !url) return false;
    try {
      const base = typeof location !== "undefined" && location && location.href;
      return new URL(url, base || undefined).href.includes("api.cosmos.so/graphql");
    } catch {
      return false;
    }
  };;

  try {
    const originalFetch = window.fetch;
    window.fetch = function (input) {
      const url = typeof input === "string" ? input : input && input.url;
      const promise = originalFetch.apply(this, arguments);

      if (!isGraphQlUrl(url)) return promise;

      return promise.then((response) => {
        // Pass through non-JSON responses untouched.
        const type = response.headers.get("content-type") || "";
        if (!type.includes("json")) return response;
        // Null-body statuses (204/205/304) forbid Response() constructors
        // with a body; pass them through untouched.
        if (response.status === 204 || response.status === 205 || response.status === 304) {
          return response;
        }

        return response.text().then((text) => {
          const patched = safePatch(text);
          return new Response(patched, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        });
      });
    };
    log("path C: fetch patched");
  } catch (err) {
    console.warn(TAG, "fetch patch failed", err);
  }

  try {
    const responseTextDesc =
      Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "responseText");
    const responseDesc =
      Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, "response");
    if (!responseTextDesc || !responseDesc) {
      log("path C: XHR response getters unavailable; skipping XHR patch");
      return;
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__cfp_isGraphQl = isGraphQlUrl(url);
      return originalOpen.apply(this, [method, url, ...rest]);
    };

    Object.defineProperty(XMLHttpRequest.prototype, "responseText", {
      configurable: true,
      enumerable: true,
      get() {
        const text = responseTextDesc.get.call(this);
        if (!this.__cfp_isGraphQl) return text;
        return safePatch(text);
      },
    });

    Object.defineProperty(XMLHttpRequest.prototype, "response", {
      configurable: true,
      enumerable: true,
      get() {
        const text = responseDesc.get.call(this);
        if (!this.__cfp_isGraphQl) return text;
        return safePatch(text);
      },
    });
    log("path C: XMLHttpRequest patched");
  } catch (err) {
    console.warn(TAG, "XHR patch failed", err);
  }

  // Debug handle.
  window.__COSMOS_FREE_PREMIUM__ = { version: "1.0.1" };
})();
