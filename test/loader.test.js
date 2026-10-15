import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import { EntryTree, Group, Loader } from '@deepseek-ai/cordis-plugin-loader';
import AgentPreset from '@deepseek-ai/dsh-agent-preset';
import { auditRows } from '@deepseek-ai/dsh-agent-preset-registry';
import * as Compact from '@deepseek-ai/dsh-command-compact';
import Basic from '@deepseek-ai/dsh-compaction-basic';
import { load } from 'js-yaml';
import * as Policy from '@local/dsh-compaction-basic-disable';

const require = createRequire(import.meta.url);
const packageName = '@local/dsh-compaction-basic-disable';
const baseUrl = require.resolve('@deepseek-ai/dsh-web-app/package.json');
const warnings = [];
const warn = (...args) => warnings.push(args);
const parse = path => load(readFileSync(path, 'utf8'), { schema: entryListSchema });
const bundle = parse(new URL('../dsh.bundle.patch.yml', import.meta.url));
const officialRows = applyEntryPatches([], ['standard', 'ptc', 'minimal', 'cordis'].flatMap(id =>
  parse(require.resolve('@deepseek-ai/dsh-web-app/presets/' + id + '.patch.yml'))), warn);
assert.equal(officialRows.length, 4);
assert.deepEqual(warnings, []);

function restoreBackendFlag(rows, originals) {
  return rows.map((row, index) => {
    const original = originals[index];
    if (row.name === Policy.blockedPackage || row.name === Policy.commandPackage) {
      const restored = { ...row };
      if (Object.hasOwn(original, 'disabled')) restored.disabled = original.disabled;
      else delete restored.disabled;
      return restored;
    }
    if (row.group && Array.isArray(row.config)) {
      return { ...row, config: restoreBackendFlag(row.config, original.config) };
    }
    return row;
  });
}

test('bundle adds dependency gates without snapshots or changes to existing preset disables', () => {
  const rows = structuredClone(officialRows);
  rows[1].disabled = true;
  for (const row of rows) {
    assert.equal(row.inject, undefined,
      'official entry.inject changed: merge its new requirements into the bundle before upgrading');
  }
  const host = { id: 'compaction-basic', name: Policy.blockedPackage };
  const hostCommand = { id: 'command-compact', name: Policy.commandPackage };
  const actual = applyEntryPatches([host, hostCommand, ...rows], bundle, warn);
  assert.equal(actual.find(row => row.id === host.id).disabled, true);
  assert.equal(actual.find(row => row.id === hostCommand.id).disabled, true);
  for (const original of rows) {
    const patched = actual.find(row => row.id === original.id);
    assert.deepEqual(patched.config, original.config);
    assert.deepEqual(patched.inject, [Policy.gateService]);
    assert.equal(patched.disabled, original.disabled);
  }
  assert.deepEqual(warnings, []);
});

async function runScenario(t, { enabled = false, missingPolicy = false, upgrade = false } = {}) {
  const ctx = new Context();
  ctx.baseUrl = baseUrl;
  const errors = [];
  ctx.logger.exporter({ export(message) {
    if (message.type === 'error') errors.push(message.args.map(String).join(' '));
  } });
  const mounts = [];
  const commands = [];
  let writes = 0;
  let automaticRegistrations = 0;
  const register = Basic.prototype._registerAutomaticCompaction;
  const registrationSpy = t.mock.method(Basic.prototype, '_registerAutomaticCompaction', function () {
    automaticRegistrations++;
    return register.call(this);
  });
  const noop = () => {};
  class MemoryTree extends EntryTree {
    write() { writes++; }
    async import(name) {
      if (name === 'cordis:group') return { inject: ['loader'], apply: Group };
      if (name === Policy.presetPackage) return AgentPreset;
      if (name === Policy.blockedPackage) return Basic;
      if (name === '@deepseek-ai/dsh-command-compact') return Compact;
      if (name === packageName) {
        // Declaration order alone is insufficient: finish the policy import last.
        await new Promise(resolve => setImmediate(resolve));
        return Policy;
      }
      return noop;
    }
  }
  let root;
  try {
    await ctx.registry.plugin(Loader, { baseUrl });
    for (const name of ['llm', 'tokenMeter', 'sessions']) ctx.reflect.provide(name, {});
    ctx.reflect.provide('commands', { register(command) {
      commands.push(command);
      return () => {};
    } });
    ctx.reflect.provide('agentPresets', { async register(config) {
      const tree = new MemoryTree(ctx);
      await tree.root.update(config.plugins);
      await tree.await();
      mounts.push({ config, tree });
      return () => tree.root.stop();
    } });
    const declarations = structuredClone(officialRows);
    if (upgrade) for (const row of declarations) {
      row.config.description = 'future official preset update';
      row.config.plugins.push({ id: 'future-tool', name: 'future:official-tool', config: { value: 42 } });
    }
    const before = structuredClone(declarations);
    let entries = [
      { id: 'compaction-basic', name: Policy.blockedPackage, disabled: true },
      { id: 'command-compact', name: Policy.commandPackage, disabled: true },
      ...declarations,
    ];
    if (enabled) entries = applyEntryPatches(entries, bundle, warn);
    if (missingPolicy) entries = entries.filter(row => row.name !== packageName);
    root = new MemoryTree(ctx);
    await root.root.update(entries);
    await root.await();
    assert.deepEqual(declarations, before, 'raw official declarations must not be changed');
    assert.equal(writes, 0, 'no persistent configuration writes');
    assert.deepEqual(errors, [], 'do not accept silently failed plugin lifecycles');
    if (missingPolicy) {
      assert.equal(mounts.length, 0, 'required policy gate fails closed');
      assert.equal(automaticRegistrations, 0);
      assert.equal(commands.length, 0);
      return;
    }
    assert.equal(mounts.length, 4);
    for (const { config, tree } of mounts) {
      assert.deepEqual(await auditRows(tree), { failed: [], pending: [] },
        `${config.id} must be usable by the real preset registry`);
      const backend = [...tree.entries()].find(entry => entry.options.name === Policy.blockedPackage);
      const command = [...tree.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-command-compact');
      assert.ok(backend);
      assert.ok(command);
      const original = before.find(row => row.config.id === config.id).config;
      if (enabled) {
        assert.equal(backend.disabled, true);
        assert.equal(backend.fiber, undefined, 'backend must never be instantiated');
        assert.equal(command.disabled, true);
        assert.equal(command.fiber, undefined, 'the manual command must not wait for a nonexistent service');
        assert.deepEqual({ ...config, plugins: restoreBackendFlag(config.plugins, original.plugins) }, original);
      } else {
        assert.equal(backend.disabled, false);
        assert.equal(backend.fiber.state, 2, 'baseline uses a running real BasicCompactionEngine');
      }
      if (upgrade) {
        assert.equal(config.description, 'future official preset update');
        assert.equal(config.plugins.at(-1).config.value, 42);
      }
    }
    assert.equal(automaticRegistrations, enabled ? 0 : 4,
      'disabling the backend also prevents threshold and overflow recovery listener registration');
    assert.equal(commands.length, enabled ? 0 : 4);
  } finally {
    root?.root.stop();
    for (const { tree } of mounts) tree.root.stop();
    await ctx.fiber.dispose();
    registrationSpy.mock.restore();
  }
}

test('real readiness audit rejects a settled command waiting for compaction', async () => {
  const ctx = new Context();
  ctx.baseUrl = baseUrl;
  let tree;
  class CommandTree extends EntryTree {
    async import(name) {
      assert.equal(name, Policy.commandPackage);
      return Compact;
    }
  }
  try {
    await ctx.registry.plugin(Loader, { baseUrl });
    ctx.reflect.provide('commands', { register() { throw new Error('command must not start'); } });
    tree = new CommandTree(ctx);
    await tree.root.update([{ id: 'command-compact', name: Policy.commandPackage }]);
    await tree.await();
    assert.deepEqual(await auditRows(tree), {
      failed: [],
      pending: ['command-compact (@deepseek-ai/dsh-command-compact): waiting for compaction'],
    });
  } finally {
    tree?.root.stop();
    await ctx.fiber.dispose();
  }
});

test('baseline instantiates all four real official compaction backends', t => runScenario(t));
test('policy prevents backend instances and automatic listener registration despite delayed import', t =>
  runScenario(t, { enabled: true }));
test('future official fields and tools survive the runtime overlay', t =>
  runScenario(t, { enabled: true, upgrade: true }));
test('a missing policy provider prevents presets from starting unprotected', t =>
  runScenario(t, { enabled: true, missingPolicy: true }));
test('removing the policy restores baseline compaction activation', t => runScenario(t));
