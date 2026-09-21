# Room chat implementation notes

## Deviations

- 计划以 `AGENT_PROTOCOL_VERSION === 5` 为基线；实现时仓库实际版本已经是 6。聊天契约保持独立，没有加入 Agent request/action/frame union，也没有修改版本号或 Agent 文档。以 `packages/cli/src/agent-protocol.test.ts` 和全量测试作为回归证据。
- 根目录 `pnpm` 在当前环境中因 pnpm 11.5.0 registry signature 无法验证而拒绝启动。为避免跳过验证，改用锁文件内已安装的 `tsc`、`vitest`、`vite` 和 `playwright` 二进制执行等价的分包检查；未修改包管理器配置或锁文件。

## Final outcome

已打通共享契约、服务端权威校验/限流/广播、client-core、交互式 CLI 与 Web 桌面侧栏/移动抽屉。聊天不写入 Schema、不改变 revision、不进入游戏事件或 Agent 协议；服务端不保存历史，两端内存最多保留 50 条。

验证证据：

- shared、client-core、server、CLI、Web 的 TypeScript 检查全部通过。
- 所有 134 个单元/进程/集成测试通过；其中需要本地 IPC/监听端口的 CLI 与 Agent 测试在允许本地监听的环境中复跑通过。
- Web 生产构建通过。
- Playwright 桌面与移动端共 6 个多人 E2E 用例通过；首个用例已覆盖大厅内两名玩家双向聊天、服务端回显、开局、重连和无障碍检查，桌面截图基线已更新。
