// Test harness for cosmos-free-premium.user.js
//
// Loads the userscript into a Node `vm` sandbox with mocked
// window/document/XMLHttpRequest/timers, then exercises the three patch
// paths (A: Apollo cache poll, B: SSR transport trap, C: fetch/XHR).
//
// Run: node tests/run-tests.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERSCRIPT = path.join(__dirname, '..', 'cosmos-free-premium.user.js');
const SRC = fs.readFileSync(USERSCRIPT, 'utf8');

const TRANSPORT = Symbol.for('ApolloSSRDataTransport');
const CLIENT = Symbol.for('ApolloClientSingleton');

/**
 * Load the userscript into a fresh vm sandbox.
 * Returns the sandbox under test plus hooks for driving timers / fetch.
 */
function loadScript() {
  const intervals = [];
  const timeouts = [];
  const logs = [];

  const console = {
    info: (...a) => logs.push(['info', a]),
    warn: (...a) => logs.push(['warn', a]),
  };

  // Mutable fetch state so tests can supply per-test responses.
  const state = { response: null };

  const window = {
    fetch: () => Promise.resolve(state.response),
  };

  // Minimal XHR mock matching the surface the script touches.
  class MockXHR {
    open(method, url) {
      this._method = method;
      this._url = url;
    }
  }
  Object.defineProperty(MockXHR.prototype, 'responseText', {
    get() {
      return this._respText;
    },
    configurable: true,
  });
  Object.defineProperty(MockXHR.prototype, 'response', {
    get() {
      return this._respResponse;
    },
    configurable: true,
  });

  const sandbox = {
    window,
    document: {},
    console,
    Symbol, // host Symbol => shared Symbol.for registry with tests
    Response,
    XMLHttpRequest: MockXHR,
    URL, // browser-global URL constructor (isGraphQlUrl resolves URLs)
    location: { href: 'https://www.cosmos.so/' },
    setInterval(fn, ms) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    setTimeout(fn, ms) {
      timeouts.push({ fn, ms });
      return timeouts.length;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: USERSCRIPT });

  return { sandbox, window, MockXHR, intervals, timeouts, logs, state };
}

const jsonRes = (obj, contentType = 'application/json') =>
  new Response(JSON.stringify(obj), {
    headers: { 'content-type': contentType },
  });

async function fetchText(env, url = 'https://api.cosmos.so/graphql') {
  const res = await env.window.fetch(url);
  return res.text();
}

const results = [];
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`PASS  ${name}`);
  } catch (err) {
    failed++;
    results.push(`FAIL  ${name}\n      ${err.message}`);
  }
}

async function main() {
  // ------------------------------------------------------------------
  // Path C: fetch patch
  // ------------------------------------------------------------------

  await test('C1 fetch: data.me.isPremium:false flipped to true', async () => {
    const env = loadScript();
    env.state.response = jsonRes({ data: { me: { isPremium: false } } });
    const body = JSON.parse(await fetchText(env));
    assert.equal(body.data.me.isPremium, true);
  });

  await test('C2 fetch: batched array responses get each entry flipped', async () => {
    const env = loadScript();
    env.state.response = jsonRes([
      { data: { me: { isPremium: false } } },
      { data: { other: 1 } },
      { data: { me: { isPremium: false } } },
    ]);
    const body = JSON.parse(await fetchText(env));
    assert.ok(Array.isArray(body));
    assert.equal(body[0].data.me.isPremium, true);
    assert.equal(body[2].data.me.isPremium, true);
    assert.deepEqual(body[1], { data: { other: 1 } });
  });

  await test('C3 fetch: non-JSON content-type passes through untouched', async () => {
    const env = loadScript();
    env.state.response = new Response('<html>not json</html>', {
      headers: { 'content-type': 'text/html' },
    });
    const res = await env.window.fetch('https://api.cosmos.so/graphql');
    assert.strictEqual(res, env.state.response, 'expected the original response object');
    assert.equal(await res.text(), '<html>not json</html>');
  });

  await test('C4 fetch: JSON without data.me unchanged', async () => {
    const env = loadScript();
    const original = JSON.stringify({ data: { other: 1 }, errors: [] });
    env.state.response = new Response(original, {
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(await fetchText(env), original);
  });

  await test('C5 fetch: data.me.isPremium already true -> unchanged', async () => {
    const env = loadScript();
    const original = JSON.stringify({ data: { me: { isPremium: true, name: 'x' } } });
    env.state.response = new Response(original, {
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(await fetchText(env), original);
  });

  await test('C6 fetch: malformed JSON passes through unchanged', async () => {
    const env = loadScript();
    const original = 'not json at all {';
    env.state.response = new Response(original, {
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(await fetchText(env), original);
  });

  await test('C7 fetch: patched bodies are re-stringified faithfully', async () => {
    const env = loadScript();
    const input = '{"data":{"me":{"isPremium":false,"name":"x"}},"other":1}';
    const expected = '{"data":{"me":{"isPremium":true,"name":"x"}},"other":1}';
    env.state.response = new Response(input, {
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(await fetchText(env), expected);
  });

  await test('C8 fetch: non-graphql URLs pass through untouched', async () => {
    const env = loadScript();
    env.state.response = jsonRes({ data: { me: { isPremium: false } } });
    const res = await env.window.fetch('https://example.com/api');
    assert.strictEqual(res, env.state.response, 'expected the original response object');
  });

  await test('C9 fetch: me without isPremium field gets flipped to true', async () => {
    const env = loadScript();
    env.state.response = jsonRes({ data: { me: { name: 'x' } } });
    const body = JSON.parse(await fetchText(env));
    assert.equal(body.data.me.isPremium, true);
    assert.equal(body.data.me.name, 'x');
  });

  await test('C10 fetch: original response body not consumed/visible post-patch', async () => {
    const env = loadScript();
    env.state.response = jsonRes({ data: { me: { isPremium: false } } });
    const res = await env.window.fetch('https://api.cosmos.so/graphql');
    const body = JSON.parse(await res.text());
    assert.equal(body.data.me.isPremium, true);
    assert.equal(res.headers.get('content-type'), 'application/json');
  });

  // ------------------------------------------------------------------
  // Path C: XHR patch
  // ------------------------------------------------------------------

  await test('X1 XHR: responseText patched for graphql URL', () => {
    const env = loadScript();
    const xhr = new env.MockXHR();
    xhr.open('GET', 'https://api.cosmos.so/graphql');
    xhr._respText = JSON.stringify({ data: { me: { isPremium: false } } });
    const body = JSON.parse(xhr.responseText);
    assert.equal(body.data.me.isPremium, true);
  });

  await test('X2 XHR: responseText untouched for non-graphql URL', () => {
    const env = loadScript();
    const xhr = new env.MockXHR();
    xhr.open('GET', 'https://api.cosmos.so/other');
    const original = JSON.stringify({ data: { me: { isPremium: false } } });
    xhr._respText = original;
    assert.equal(xhr.responseText, original);
  });

  await test('X3 XHR: response getter patched for graphql URL', () => {
    const env = loadScript();
    const xhr = new env.MockXHR();
    xhr.open('GET', 'https://api.cosmos.so/graphql');
    xhr._respResponse = JSON.stringify({ data: { me: { isPremium: false } } });
    const body = JSON.parse(xhr.response);
    assert.equal(body.data.me.isPremium, true);
  });

  await test('X4 XHR: non-string URL does not crash and passes through', () => {
    const env = loadScript();
    const xhr = new env.MockXHR();
    const reqObj = { toString: () => 'https://api.cosmos.so/graphql' };
    xhr.open('GET', reqObj);
    const original = JSON.stringify({ data: { me: { isPremium: false } } });
    xhr._respText = original;
    // URL was an object (not a string), so the script must pass through.
    assert.equal(xhr.responseText, original);
  });

  // ------------------------------------------------------------------
  // Path B: SSR transport trap
  // ------------------------------------------------------------------

  await test('B1: transport getter returns a stable, truthy backing array', () => {
    const env = loadScript();
    const t1 = env.window[TRANSPORT];
    assert.ok(t1, 'getter returned falsy');
    assert.ok(Array.isArray(t1), 'getter did not return an array');
    const t2 = env.window[TRANSPORT];
    assert.strictEqual(t1, t2, 'getter is not stable');
  });

  await test('B2: pushing a rehydrate entry patches me.isPremium to true', () => {
    const env = loadScript();
    const t = env.window[TRANSPORT];
    const entry = {
      rehydrate: { _R_x: { data: { me: { isPremium: false, name: 'x' } } } },
    };
    t.push(entry);
    assert.equal(t.length, 1);
    assert.strictEqual(t[0], entry, 'entry identity must be preserved (mutated in place)');
    assert.equal(t[0].rehydrate._R_x.data.me.isPremium, true);
  });

  await test('B3: Apollo assignment via setter wraps the new push (late pushes patched)', () => {
    const env = loadScript();
    const apollo = {
      items: [],
      push(...items) {
        this.items.push(...items);
      },
    };
    env.window[TRANSPORT] = apollo;

    // Late push through the NEW object's push must also patch entries.
    const entry = { rehydrate: { _R_y: { data: { me: { isPremium: false } } } } };
    apollo.push(entry);
    assert.equal(apollo.items.length, 1);
    assert.strictEqual(apollo.items[0], entry, 'entry identity must be preserved');
    assert.equal(apollo.items[0].rehydrate._R_y.data.me.isPremium, true);

    // Getter must return Apollo's replacement object post-assignment (B1 fix).
    assert.strictEqual(env.window[TRANSPORT], apollo, 'getter broke after set');
  });

  await test('B4: entries without rehydrate/me pass through without throwing', () => {
    const env = loadScript();
    const t = env.window[TRANSPORT];
    t.push(
      null,
      { foo: 1 },
      { rehydrate: null },
      { rehydrate: { _x: {} } },
      { rehydrate: { _x: { data: {} } } },
      { rehydrate: { _x: { data: { me: null } } } },
      'a plain string',
    );
    assert.equal(t.length, 7);
    assert.deepStrictEqual(t[1], { foo: 1 });
    assert.strictEqual(t[0], null);
    assert.strictEqual(t[6], 'a plain string');
    // Transport must still be usable afterwards.
    t.push({ rehydrate: { _ok: { data: { me: { isPremium: false } } } } });
    assert.equal(t[7].rehydrate._ok.data.me.isPremium, true);
  });

  await test('B5: entry whose me.isPremium is already true is left intact', () => {
    const env = loadScript();
    const t = env.window[TRANSPORT];
    const entry = { rehydrate: { _x: { data: { me: { isPremium: true, name: 'a' } } } } };
    t.push(entry);
    assert.equal(entry.rehydrate._x.data.me.isPremium, true);
    assert.equal(entry.rehydrate._x.data.me.name, 'a');
  });

  await test('B6: multiple args per push are all patched', () => {
    const env = loadScript();
    const t = env.window[TRANSPORT];
    t.push(
      { rehydrate: { a: { data: { me: { isPremium: false } } } } },
      { rehydrate: { b: { data: { me: { isPremium: false } } } } },
    );
    assert.equal(t.length, 2);
    assert.equal(t[0].rehydrate.a.data.me.isPremium, true);
    assert.equal(t[1].rehydrate.b.data.me.isPremium, true);
  });

  // ------------------------------------------------------------------
  // Path A: Apollo cache poll
  // ------------------------------------------------------------------

  await test('A1: registers a 3000ms interval and one eager timeout', () => {
    const env = loadScript();
    assert.equal(env.intervals.length, 1, 'expected exactly one setInterval');
    assert.equal(env.intervals[0].ms, 3000, 'interval is not CACHE_POLL_MS (3000)');
    assert.ok(env.timeouts.length >= 1, 'expected at least one setTimeout');
  });

  await test('A2: no client present -> no crash, no modify call', () => {
    const env = loadScript();
    let modifyCalls = 0;
    env.window[CLIENT] = {
      cache: {
        extract: () => ({ ROOT_QUERY: { me: { __ref: 'User:1' } } }),
        modify: () => {
          modifyCalls++;
        },
      },
    };
    // ...but leave window[CLIENT] unset for this tick
    delete env.window[CLIENT];
    env.intervals[0].fn();
    assert.equal(modifyCalls, 0);
  });

  await test('A3: client present -> extract resolved, modify called with id + flipper', () => {
    const env = loadScript();
    const calls = [];
    let extractCalls = 0;
    env.window[CLIENT] = {
      cache: {
        extract: () => {
          extractCalls++;
          return {
            ROOT_QUERY: { me: { __ref: 'User:123' } },
            'User:123': { isPremium: false },
          };
        },
        modify: (opts) => calls.push(opts),
      },
    };
    env.intervals[0].fn();
    assert.equal(extractCalls, 1, 'cache.extract not called exactly once');
    assert.equal(calls.length, 1, 'cache.modify not called exactly once');
    assert.equal(calls[0].id, 'User:123');
    assert.equal(calls[0].fields.isPremium(), true, 'isPremium flipper must return true');
  });

  await test('A4: me.isPremium already true -> no modify call', () => {
    const env = loadScript();
    const calls = [];
    env.window[CLIENT] = {
      cache: {
        extract: () => ({
          ROOT_QUERY: { me: { __ref: 'User:123' } },
          'User:123': { isPremium: true },
        }),
        modify: (opts) => calls.push(opts),
      },
    };
    env.intervals[0].fn();
    assert.equal(calls.length, 0, 'modify should not be called when already premium');
  });

  await test('A5: broken extract() -> no crash, no modify call', () => {
    const env = loadScript();
    const calls = [];
    env.window[CLIENT] = {
      cache: {
        extract: () => {
          throw new Error('boom');
        },
        modify: (opts) => calls.push(opts),
      },
    };
    env.intervals[0].fn();
    assert.equal(calls.length, 0);
  });

  await test('A6: missing ROOT_QUERY.me.__ref -> no modify call', () => {
    const env = loadScript();
    const calls = [];
    const mk = (dump) => ({
      cache: {
        extract: () => dump,
        modify: (opts) => calls.push(opts),
      },
    });
    env.window[CLIENT] = mk({});
    env.intervals[0].fn();
    env.window[CLIENT] = mk({ ROOT_QUERY: {} });
    env.intervals[0].fn();
    env.window[CLIENT] = mk({ ROOT_QUERY: { me: {} } });
    env.intervals[0].fn();
    env.window[CLIENT] = mk({ ROOT_QUERY: { me: { noRef: true } } });
    env.intervals[0].fn();
    assert.equal(calls.length, 0);
  });

  await test('A6b: dangling __ref still triggers modify (documented behavior)', () => {
    const env = loadScript();
    const calls = [];
    env.window[CLIENT] = {
      cache: {
        extract: () => ({ ROOT_QUERY: { me: { __ref: 'User:missing' } } }),
        modify: (opts) => calls.push(opts),
      },
    };
    env.intervals[0].fn();
    // Not a bug: entity missing from dump means `!entity` -> modify attempted
    // anyway (line: `if (!entity || entity.isPremium !== true)`), which is
    // harmless since Apollo's cache.modify no-ops on missing entities.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 'User:missing');
  });

  await test('A7: cache.modify throwing -> no crash, tick keeps swallowing', () => {
    const env = loadScript();
    let modifyCalls = 0;
    env.window[CLIENT] = {
      cache: {
        extract: () => ({
          ROOT_QUERY: { me: { __ref: 'User:123' } },
          'User:123': { isPremium: false },
        }),
        modify: () => {
          modifyCalls++;
          throw new Error('cache locked');
        },
      },
    };
    env.intervals[0].fn(); // must not throw
    env.intervals[0].fn(); // second tick also must not throw
    assert.equal(modifyCalls, 2);
    const warns = env.logs.filter(([level]) => level === 'warn');
    assert.ok(warns.length >= 2, 'expected a warn per failed tick');
  });

  await test('A8: eager setTimeout callback behaves like a tick', () => {
    const env = loadScript();
    const calls = [];
    env.window[CLIENT] = {
      cache: {
        extract: () => ({
          ROOT_QUERY: { me: { __ref: 'User:77' } },
          'User:77': { isPremium: false },
        }),
        modify: (opts) => calls.push(opts),
      },
    };
    env.timeouts[0].fn();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 'User:77');
  });

  await test('A9: client without cache -> no crash, no modify call', () => {
    const env = loadScript();
    const calls = [];
    env.window[CLIENT] = {
      cache: null,
      modify: (opts) => calls.push(opts),
    };
    env.intervals[0].fn();
    assert.equal(calls.length, 0);
  });

  // ------------------------------------------------------------------
  // Report
  // ------------------------------------------------------------------

  console_out('\n===== RESULTS =====');
  for (const r of results) {
    console_out(r);
  }
  console_out(`\n${passed} passed, ${failed} failed, ${results.length} total`);
  process.exitCode = failed === 0 ? 0 : 1;
}

function console_out(...args) {
  process.stdout.write(args.join(' ') + '\n');
}

main().catch((err) => {
  console_out('HARNESS ERROR: ' + (err && err.stack ? err.stack : err));
  process.exitCode = 1;
});
