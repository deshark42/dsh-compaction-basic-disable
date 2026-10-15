# dsh-compaction-basic-disable

独立的 DSH 插件：禁用 `@deepseek-ai/dsh-compaction-basic`，而不复制或覆盖整份官方预设。插件自身不写回配置；安装时由 DSH 更新目标 profile 的依赖和 bundle 声明。

## 禁用范围

- 当前官方 base 配置中的宿主后端条目 `compaction-basic`。
- 官方 Web 的 standard、ptc、minimal、cordis 四个预设内，按包名匹配到的 basic compaction 后端，包括嵌套 Cordis 分组。
- 后端不被实例化，因此其手动压缩、上下文阈值自动压缩、模型报上下文超限后的压缩重试恢复都不可用。
- 不单独禁用 `/compact`。没有后端时命令可能因依赖未满足而不注册；命令是否可见不作为验证依据。
- 禁用压缩不会扩大模型的上下文窗口。超限后可能直接报错，需要新开会话或减少上下文。

## 机制与升级边界

[插件源码](./src/index.js)在 Cordis 的 `internal/config` 中间件阶段，读取当次解析出的预设配置，只给目标后端添加 `disabled: true`。不原地修改输入，不写回配置，不复制预设快照，因此官方以后新增的工具和配置字段会继续保留。

[Bundle 声明](./dsh.bundle.patch.yml)只插入策略插件、禁用宿主条目，并为当前四个预设条目设置 `inject: [localBasicCompactionPolicy]`。策略先注册中间件，再提供该服务；即使动态导入顺序颠倒，预设也必须等策略就绪后才能注册。策略加载失败时，受保护的预设会保持等待，而不是无保护启动。

注意：

1. 依赖名称含 internal 的框架配置钩子，并非 DSH 官方的全局排除开关。升级后必须复测，不能保证跨版本永远兼容。
2. 当前四个预设原本没有条目级 inject。Cordis 补丁会替换该列表，不会合并；若这些条目已有或未来新增依赖，需手动合并依赖，集成测试会检查官方声明的变化。
3. 新增或自定义预设若使用相同的 agent-preset 声明插件，也会被中间件处理，但还需为其条目添加上述依赖门闩，不能只依靠声明顺序。其他声明机制不在保障范围内。
4. 只递归处理标准的 group/config 条目树，不扫描任意插件自己的配置。
5. 这是加载期策略，不承诺卸载或热重载时立刻改写已运行的预设修订。首次安装或卸载后建议完整重启 DSH，并检查新挂载的预设。

## 开发与验证

Node.js >= 22.16，使用 pnpm。插件自身没有运行时依赖，也无需编译；官方开发依赖固定到已验证的 DSH/Cordis 版本，锁文件保证安装可复现。

```sh
pnpm install --frozen-lockfile
pnpm run check
# 仅运行无需开发依赖的纯逻辑测试：
node --test test/policy.test.js
```

集成测试读取开发依赖内的真实官方预设，使用真实 Cordis Loader、AgentPreset、BasicCompactionEngine 和手动命令模块。验证：

- 不启用策略时四个压缩后端均正常实例化并注册自动处理逻辑；
- 策略导入故意延迟时，后端仍被禁用且没有实例，自动压缩注册方法不会被调用；
- 新增官方字段、工具和原有预设禁用状态不会丢失；
- 策略缺失时预设不会绕过门闩启动；
- 移除策略后可恢复基线，配置持久化写入数为 0。

**测试边界：**预设注册服务、模型/会话/命令等宿主服务和无关插件使用替身；不发送模型请求，不实际压缩历史，也不是对运行中的真实 Web 会话作端到端验证。测试不读取或改写用户 profile。

当前验证目标：DSH `0.2.1-alpha.3`、Cordis `4.0.5-alpha.2`、Cordis Loader `1.0.6-alpha.2`。

## 安装到 Web profile

安装会修改目标 profile，操作前请先备份。本插件 bundle 应位于官方 base/Web bundles 之后。当前通过本地 link 安装，不需要发布到 npm，也无需先安装仓库的开发依赖。

```sh
git clone https://github.com/deshark42/dsh-compaction-basic-disable.git
cd dsh-compaction-basic-disable
dsh plugin --profile web add "link:$PWD"
```

使用 link 安装后请保留此克隆目录；不要在仍启用插件时移动或删除它。

然后核对 profile 的依赖包含 `@local/dsh-compaction-basic-disable`，且 `dsh.profile.bundles` 中将它排在官方 bundles 后面。不要再手动复制整份预设，不要另加隐藏 /compact 的补丁。

完整重启 DSH 后，对新挂载预设检查 basic 后端条目为禁用且没有实例，同时确认其自动监听器未注册。仅看 /compact 消失或配置文件中的文字不够。此仓库测试通过也不等于当前运行会话已经禁用压缩。

卸载时移除本插件的 profile 依赖和 bundle 项，再重启；无需还原任何官方预设快照。若手动给自定义预设添加过门闩，也需一并移除。

## 仓库结构

- [src/index.js](./src/index.js)：无构建的 ESM 插件及纯配置转换函数。
- [dsh.bundle.patch.yml](./dsh.bundle.patch.yml)：最小加载声明及当前预设依赖门闩。
- [test/policy.test.js](./test/policy.test.js)：纯函数和中间件单元测试。
- [test/loader.test.js](./test/loader.test.js)：真实加载器和官方预设的隔离集成测试。
- [package.json](./package.json)：包导出、DSH bundle 元数据与开发命令。

## 许可证

[MIT](./LICENSE) © 2026 deshark42。
