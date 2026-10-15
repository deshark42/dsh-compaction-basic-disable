import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, blockedPackage, commandPackage, disableBasicCompaction, gateService, presetPackage } from '../src/index.js';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function middleware() {
  const registrations = [];
  const services = new Map();
  apply({
    on(event, handler, options) { registrations.push({ event, handler, options }); },
    reflect: { provide(key, value) {
      assert.equal(registrations.length, 1, 'register the hook before releasing its gate');
      services.set(key, value);
    } },
  });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].event, 'internal/config');
  assert.deepEqual(registrations[0].options, { global: true });
  assert.equal(services.get(gateService).blockedPackage, blockedPackage);
  assert.ok(Object.isFrozen(services.get(gateService)));
  return registrations[0].handler;
}

test('disables the backend and its dependent command across nested Cordis groups without mutating input', () => {
  const command = { id: 'command-compact', name: commandPackage };
  const other = { name: 'billion-context', config: { auto: true } };
  const rows = freeze([
    { id: 'renamed-backend', name: blockedPackage, disabled: false, config: { auto: true } },
    { name: 'cordis:group', group: true, config: [
      command,
      { name: 'cordis:group', group: true, config: [{ name: blockedPackage }] },
    ] },
    other,
    { name: blockedPackage + '-other' },
  ]);
  const before = structuredClone(rows);
  const result = disableBasicCompaction(rows);
  assert.deepEqual(rows, before);
  assert.equal(result[0].disabled, true);
  assert.equal(result[1].config[1].config[0].disabled, true);
  assert.deepEqual(result[0].config, { auto: true });
  assert.deepEqual(result[1].config[0], { ...command, disabled: true },
    'disable the command instead of leaving it waiting for the absent backend');
  assert.equal(result[2], other, 'other compression engines remain untouched');
  assert.equal(result[3].disabled, undefined, 'match package names exactly');
  assert.deepEqual(disableBasicCompaction(result), result);
});

test('does not interpret arbitrary plugin configuration arrays as entry groups', () => {
  const rows = freeze([{ name: 'other-plugin', config: [{ name: blockedPackage }] }]);
  assert.equal(disableBasicCompaction(rows)[0], rows[0]);
});

test('preserves empty and opaque entries for the Loader to validate', () => {
  assert.deepEqual(disableBasicCompaction([]), []);
  const rows = [null, undefined, 'opaque', { group: true, config: null }];
  assert.deepEqual(disableBasicCompaction(rows), rows);
});

test('transforms the resolved preset config and preserves future official settings', () => {
  const handler = middleware();
  const raw = freeze({ doNotUse: true });
  const expression = { __jsExpr: 'process.platform === "win32"' };
  const resolved = freeze({ id: 'future-mode', futureSetting: { enabled: true }, plugins: [
    { name: blockedPackage },
    { name: 'future-tool', disabled: expression, config: { newOption: 42 } },
  ] });
  let nextCalls = 0;
  const result = handler.call({ entry: { options: { name: presetPackage } } }, raw, () => {
    nextCalls++;
    return resolved;
  });
  assert.equal(nextCalls, 1);
  assert.equal(result.plugins[0].disabled, true);
  assert.equal(result.plugins[1], resolved.plugins[1]);
  assert.equal(result.futureSetting, resolved.futureSetting);
  assert.equal(resolved.plugins[0].disabled, undefined);
});

test('leaves non-preset, absent-entry and malformed-preset configs unchanged', () => {
  const handler = middleware();
  const config = { plugins: [{ name: blockedPackage }] };
  for (const receiver of [{}, { entry: { options: { name: 'other-plugin' } } }]) {
    assert.equal(handler.call(receiver, {}, () => config), config);
  }
  const receiver = { entry: { options: { name: presetPackage } } };
  for (const value of [null, undefined, {}, { plugins: 'opaque' }]) {
    assert.equal(handler.call(receiver, {}, () => value), value);
  }
});

test('propagates downstream config errors instead of silently masking them', () => {
  const handler = middleware();
  const error = new Error('fixture config resolution failed');
  assert.throws(() => handler.call({}, {}, () => { throw error; }), error);
});
