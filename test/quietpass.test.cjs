const { test } = require('node:test');
const assert = require('node:assert/strict');
const { QuietPass } = require('../dist/nodes/QuietPass/QuietPass.node.js');
const H = require('../dist/nodes/QuietPass/Helpers.js');
const { QuietPassApi } = require('../dist/credentials/QuietPassApi.credentials.js');

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const result = () => ({
  requestId: ID,
  number: { e164: '+447700900123', valid: true, carrier: 'Example carrier', type: 'mobile', ported: false },
  contact: { sms: { supported: true, assumed: true, basis: 'mobile_line_type' }, whatsapp: { registered: false }, telegram: { registered: null, reason: 'registration_unavailable' } },
  network: { reachable: null, reason: 'network_information_only' },
  billing: { currency: 'GBP', chargedMicros: 50000 },
});
const quote = (changes = {}) => ({ quote: { id: ID, currency: 'GBP', maxMicros: 50000, expiresAt: new Date(Date.now() + 300000).toISOString(), ...changes }, unavailableChecks: [] });

function harness(parameters = {}, responses = [], config = {}) {
  const calls = [];
  const all = { resource: 'phoneNumber', operation: 'check', phone: '+447700900123', defaultCountry: '', checks: H.checks, currency: 'GBP', maximumPrice: '0.05', sourceEventId: 'test:workflow:contact-1:change-1', allowLive: true, maximumTotalPrice: '1.00', options: {}, ...parameters };
  const node = { id: 'fixture', name: 'QuietPass', type: 'n8n-nodes-quietpass.quietPass', typeVersion: 1, position: [0, 0], parameters: all, ...config.node };
  const context = {
    getNode: () => node,
    getInputData: () => config.items || [{ json: { eventId: 'contact-1:change-1' } }],
    getNodeParameter: (name, i, fallback) => {
      const value = Object.hasOwn(all, name) ? all[name] : fallback;
      return typeof value === 'function' ? value(i) : value;
    },
    continueOnFail: () => config.continueOnFail === true,
    helpers: { httpRequestWithAuthentication: async function (credential, options) {
      assert.equal(this, context);
      assert.equal(credential, 'quietPassApi');
      assert.match(options.url, /^https:\/\/quietpass\.com\/v1\//);
      assert.equal(options.disableFollowRedirect, true);
      assert.equal(options.returnFullResponse, true);
      assert.equal(options.ignoreHttpStatusErrors, true);
      assert.equal(options.timeout, 20000);
      assert.equal(options.headers.Authorization, undefined, 'credential injection belongs to n8n');
      calls.push(options);
      if (!responses.length) throw new Error('Unexpected request');
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return r.statusCode ? r : { statusCode: 200, body: r };
    } },
  };
  return { calls, run: () => new QuietPass().execute.call(context), context };
}

test('credentials are masked and tested using only the free wallet endpoint', () => {
  const credential = new QuietPassApi();
  assert.equal(credential.properties[0].typeOptions.password, true);
  assert.equal(credential.test.request.url, '/v1/wallet');
  assert.equal(credential.test.request.disableFollowRedirect, true);
  assert.equal(credential.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
  assert.equal(new QuietPass().description.usableAsTool, true);
});

test('free formatting makes exactly one basic-only request and preserves false and null', async () => {
  const f = harness({ operation: 'format', phone: '07700900123', defaultCountry: 'gb', options: { includeDetails: true } }, [result()]);
  const [[output]] = await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://quietpass.com/v1/phone/check?include_details=true');
  assert.deepEqual(f.calls[0].body, { phone: '07700900123', default_country: 'GB', checks: ['basic_line_type'] });
  assert.equal(output.json.contact.whatsapp.registered, false);
  assert.equal(output.json.contact.telegram.registered, null);
  assert.deepEqual(output.pairedItem, { item: 0 });
});

test('check hides quote/execute plumbing and submits the exact accepted ceiling and stable key', async () => {
  const f = harness({ options: { includeDetails: true } }, [quote({ maxMicros: 20000 }), { ...result(), billing: { currency: 'GBP', chargedMicros: 20000 } }]);
  const [[output]] = await f.run();
  assert.deepEqual(f.calls.map(c => c.url), ['https://quietpass.com/v1/phone/quote', 'https://quietpass.com/v1/phone/execute?include_details=true']);
  assert.deepEqual(f.calls[1].body, { quoteId: ID, maxSpendMicros: 20000 });
  assert.equal(f.calls[1].headers['Idempotency-Key'], H.eventKey('test:workflow:contact-1:change-1'));
  assert.equal(output.json.operation.maxSpendMicros, 20000);
  assert.equal(output.json.contact.sms.assumed, true);
  assert.equal(output.json.contact.whatsapp.registered, false);
  assert.equal(output.json.contact.telegram.registered, null);
});

test('free quote validates currency and cap without executing or requiring paid opt-in', async () => {
  const f = harness({ operation: 'quote', allowLive: false, currency: 'USD' }, [quote({ currency: 'USD' })]);
  const [[output]] = await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(output.json.operation.currency, 'USD');
  assert.equal(output.json.number, undefined);
});

for (const [name, changes] of [
  ['price above cap', { maxMicros: 50001 }], ['currency mismatch', { currency: 'EUR' }],
  ['expired quote', { expiresAt: '2000-01-01T00:00:00Z' }], ['unreadable expiry', { expiresAt: 'bad' }],
  ['invalid quote ID', { id: '../../wallet' }], ['fractional micros', { maxMicros: 0.2 }], ['negative micros', { maxMicros: -1 }],
]) test(`quote rejection: ${name} cannot execute`, async () => {
  const f = harness({}, [quote(changes)]);
  await assert.rejects(f.run(), /quote exceeded your cap, changed currency, or expired/);
  assert.equal(f.calls.length, 1);
});

for (const [name, parameters, pattern] of [
  ['national number without country', { phone: '07700900123' }, /Map a country/],
  ['missing phone', { phone: '' }, /one phone number/],
  ['numeric phone', { phone: 447700900123 }, /as text/],
  ['invalid country', { defaultCountry: 'United Kingdom' }, /two-letter/],
  ['missing checks', { checks: [] }, /at least one supported/],
  ['duplicate checks', { checks: ['sms', 'sms'] }, /without duplicates/],
  ['unsupported check', { checks: ['sim_swap'] }, /supported check/],
  ['negative price', { maximumPrice: '-0.01' }, /maximum price between/],
  ['floating precision', { maximumPrice: '0.0000001' }, /six decimal/],
  ['exponent price', { maximumPrice: '5e-2' }, /maximum price between/],
  ['invalid currency', { currency: 'NZD' }, /GBP, USD, or EUR/],
  ['no event ID', { sourceEventId: '' }, /stable event ID/],
  ['live off', { allowLive: false }, /Enable Allow Live Lookup/],
]) test(`invalid input: ${name} stops before networking`, async () => {
  const f = harness(parameters);
  await assert.rejects(f.run(), pattern);
  assert.equal(f.calls.length, 0);
});

test('international 00 format works without a country', async () => {
  const f = harness({ operation: 'format', phone: '00447700900123' }, [result()]);
  await f.run();
  assert.deepEqual(f.calls[0].body, { phone: '00447700900123', checks: ['basic_line_type'] });
});

test('batch caps are checked before even the first quote', async () => {
  const f = harness({ sourceEventId: i => `test:event-${i}`, maximumTotalPrice: '0.09' }, [], { items: [{ json: {} }, { json: {} }] });
  await assert.rejects(f.run(), /Maximum Total Price/);
  assert.equal(f.calls.length, 0);
  const size = harness({ options: { maximumItems: 1 } }, [], { items: [{ json: {} }, { json: {} }] });
  await assert.rejects(size.run(), /Maximum Input Items/);
  assert.equal(size.calls.length, 0);
});

test('an invalid later item cannot leave an earlier item already charged', async () => {
  const f = harness({ phone: i => i ? '' : '+447700900123', sourceEventId: i => `test:event-${i}` }, [], { items: [{ json: {} }, { json: {} }] });
  await assert.rejects(f.run(), /one phone number/);
  assert.equal(f.calls.length, 0);
});

test('duplicate event IDs stop the entire batch even with Continue On Fail', async () => {
  const f = harness({}, [], { continueOnFail: true, items: [{ json: {} }, { json: {} }] });
  await assert.rejects(f.run(), /share a source event ID/);
  assert.equal(f.calls.length, 0);
});

test('mixed currencies stop the entire paid batch before any request', async () => {
  const f = harness({ currency: i => i ? 'USD' : 'GBP', sourceEventId: i => `test:event-${i}` }, [], { items: [{ json: {} }, { json: {} }] });
  await assert.rejects(f.run(), /same workspace currency/);
  assert.equal(f.calls.length, 0);
});

test('automatic Retry On Fail is rejected for the combined check action', async () => {
  const f = harness({}, [], { node: { retryOnFail: true } });
  await assert.rejects(f.run(), /Turn off Retry On Fail/);
  assert.equal(f.calls.length, 0);
});

test('an uncertain paid request retains original references, never requotes, and sanitizes transport secrets', async () => {
  const secret = new Error('Authorization: Bearer private-test-key phone=PRIVATE_PHONE');
  const f = harness({}, [quote(), secret]);
  await assert.rejects(f.run(), e => {
    assert.match(e.description, new RegExp(ID));
    assert.match(e.description, /qp_n8n_[a-f0-9]{64}/);
    assert.match(e.description, /Get Lookup Result first/);
    assert.doesNotMatch(JSON.stringify(e), /private-test-key|PRIVATE_PHONE/);
    return true;
  });
  assert.equal(f.calls.length, 2);
});

test('Continue On Fail produces an error item with recovery references, never fake contact answers', async () => {
  const f = harness({}, [quote(), new Error('private details')], { continueOnFail: true });
  const [[output]] = await f.run();
  assert.equal(output.json.error.code, 'CONNECTION_UNCERTAIN');
  assert.equal(output.json.operation.quoteId, ID);
  assert.equal(output.json.number, undefined);
  assert.equal(output.json.contact, undefined);
  assert.deepEqual(output.pairedItem, { item: 0 });
});

for (const code of [401, 402, 403, 409, 429, 503]) test(`HTTP ${code} stops the lookup and only exposes safe API error fields`, async () => {
  const f = harness({}, [{ statusCode: code, body: { error: { code: 'SAFE_ERROR', requestId: OTHER, message: 'secret body contents' } } }]);
  await assert.rejects(f.run(), e => {
    assert.match(e.message, /SAFE_ERROR/);
    assert.match(e.message, new RegExp(OTHER));
    assert.doesNotMatch(JSON.stringify(e), /secret body contents/);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test('redirects and malformed API responses do not become success data', async () => {
  for (const response of [{ statusCode: 302, body: {} }, { statusCode: 200, body: '<html>bad</html>' }]) {
    const f = harness({}, [response]);
    await assert.rejects(f.run());
    assert.equal(f.calls.length, 1);
  }
});

test('Get Lookup Result only reads an original settled result without coercing negatives', async () => {
  const f = harness({ operation: 'getResult', quoteId: ID, options: { includeDetails: true } }, [{ state: 'settled', result: result() }]);
  const [[output]] = await f.run();
  assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.calls[0].url, `https://quietpass.com/v1/phone/results/${ID}?include_details=true`);
  assert.equal(output.json.contact.whatsapp.registered, false);
  assert.equal(output.json.contact.telegram.registered, null);
});

for (const state of ['pending', 'not_started', 'expired', 'unexpected']) test(`result state ${state} stops downstream updates`, async () => {
  const f = harness({ operation: 'getResult', quoteId: ID }, [{ state }]);
  await assert.rejects(f.run(), /No new lookup was run/);
  assert.equal(f.calls.length, 1);
});

test('Submit Original Quote reuses exact references on every attempt without a quote call', async () => {
  const operation = { quoteId: ID, maxSpendMicros: 50000, requestKey: H.eventKey('test:workflow:contact-1:change-1'), currency: 'GBP' };
  const f = harness({ operation: 'execute', ...operation }, [result(), result()]);
  await f.run(); await f.run();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal(f.calls[0].url, 'https://quietpass.com/v1/phone/execute');
  assert.equal(f.calls[0].headers['Idempotency-Key'], operation.requestKey);
});

test('untrusted quote paths, keys, and integer caps are rejected without requests', async () => {
  for (const change of [{ quoteId: '//evil.example' }, { requestKey: 'qp_zap_sample' }, { maxSpendMicros: -1 }, { maxSpendMicros: 50000.5 }]) {
    const f = harness({ operation: 'execute', quoteId: ID, requestKey: H.eventKey('test:event'), maxSpendMicros: 50000, ...change });
    await assert.rejects(f.run());
    assert.equal(f.calls.length, 0);
  }
});

test('settlement above cap, wrong currency, or incomplete body is never returned as a successful result', async () => {
  for (const response of [{ ...result(), billing: { currency: 'GBP', chargedMicros: 50001 } }, { ...result(), billing: { currency: 'USD', chargedMicros: 50000 } }, { billing: result().billing }]) {
    const f = harness({}, [quote(), response]);
    await assert.rejects(f.run(), /settlement could not be verified/);
    assert.equal(f.calls.length, 2);
  }
});

test('multiple successful input items retain their own pairing and event references', async () => {
  const f = harness({ sourceEventId: i => `fixture:workflow:event-${i}` }, [quote(), result(), quote({ id: OTHER }), result()], { items: [{ json: {} }, { json: {} }] });
  const [output] = await f.run();
  assert.deepEqual(output.map(o => o.pairedItem), [{ item: 0 }, { item: 1 }]);
  assert.notEqual(f.calls[1].headers['Idempotency-Key'], f.calls[3].headers['Idempotency-Key']);
  assert.equal(output[1].json.operation.quoteId, OTHER);
});

test('maximum parsing uses exact integer micros, including zero and six decimal places', () => {
  assert.equal(H.maximumMicros('0'), 0);
  assert.equal(H.maximumMicros('0.000001'), 1);
  assert.equal(H.maximumMicros('100'), 100000000);
  assert.equal(H.maximumMicros('0.05'), 50000);
  assert.equal(H.eventKey('test:event'), H.eventKey('test:event'));
  assert.notEqual(H.eventKey('test:event'), H.eventKey('test:event2'));
});

test('invalid total-price settings are presented as n8n configuration errors before requests', async () => {
  const f = harness({ maximumTotalPrice: 'not a price' });
  await assert.rejects(f.run(), e => e.name === 'NodeOperationError' && /maximum price/.test(e.message));
  assert.equal(f.calls.length, 0);
});

test('a zero-price quote and zero settlement remain valid without a fabricated charge', async () => {
  const f = harness({ maximumPrice: '0', maximumTotalPrice: '0' }, [quote({ maxMicros: 0 }), { ...result(), billing: { currency: 'GBP', chargedMicros: 0 } }]);
  const [[output]] = await f.run();
  assert.equal(f.calls[1].body.maxSpendMicros, 0);
  assert.equal(output.json.billing.chargedMicros, 0);
});
