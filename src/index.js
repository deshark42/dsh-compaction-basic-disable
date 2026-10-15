export const name = 'compaction-basic-disable-policy';
export const blockedPackage = '@deepseek-ai/dsh-compaction-basic';
export const presetPackage = '@deepseek-ai/dsh-agent-preset';
export const gateService = 'localBasicCompactionPolicy';

/** Return a detached policy overlay without changing the original preset rows. */
export function disableBasicCompaction(rows) {
  return rows.map(row => {
    if (!row || typeof row !== 'object') return row;
    if (row.name === blockedPackage) return { ...row, disabled: true };
    if (row.group && Array.isArray(row.config)) {
      return { ...row, config: disableBasicCompaction(row.config) };
    }
    return row;
  });
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  // Preset entries must inject the gate: sibling imports may finish out of order.
  ctx.on('internal/config', function (_raw, next) {
    const config = next();
    if (this.entry?.options.name !== presetPackage) return config;
    if (!Array.isArray(config?.plugins)) return config;
    return { ...config, plugins: disableBasicCompaction(config.plugins) };
  }, { global: true });

  // Publish only after the middleware is registered; Cordis owns both lifetimes.
  ctx.reflect.provide(gateService, Object.freeze({ blockedPackage }));
}
