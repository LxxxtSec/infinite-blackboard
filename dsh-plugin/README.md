# dsh-plugin-infinite-blackboard

把 **Infinite Blackboard** 接进 DeepSeek Harness：11 个 `blackboard_*` 原生工具 + 会话视图环里的「黑板」标签（内嵌完整教学画布）。

插件本身不实现黑板语义。它调用本仓库（发行版）的 `bin/blackboard.js`，事件日志、教学阶段、代码/讲解、加锁和脱敏仍由发行版负责。

## 安装

先把插件装进目标 profile：

```bash
dsh plugin --profile web add /path/to/infinite-blackboard/dsh-plugin
```

首次安装需重启一次 `dsh web`，然后刷新页面。

插件会按顺序寻找发行版：

1. 配置 `cliPath`
2. 环境变量 `BLACKBOARD_CLI` / `BLACKBOARD_ROOT`
3. 相邻目录 `../bin/blackboard.js`（本仓库的 `dsh-plugin` 布局）
4. `node_modules/blackboard` 或 `node_modules/infinite-blackboard`
5. `PATH` 上的 `blackboard`

最稳妥：安装时或 profile patch 里显式给 `cliPath`：

```yaml
- id: infinite-blackboard
  config:
    cliPath: /Users/me/code/infinite-blackboard/bin/blackboard.js
```

## 界面

会话视图环新增「黑板」标签：

- **画布**：内嵌发行版 `public/` 的完整 Infinite Blackboard 教学画布（阶段、代码、讲解、导出）；
- **列表**：宿主侧快照的轻量只读视图，零端口；
- 每个 board root 一个 viewer 进程，闲置 30 分钟回收；宿主退出或卸载立即释放。

## 工具

`blackboard_brief`、`blackboard_context`、`blackboard_show`、`blackboard_add`、`blackboard_edit`、`blackboard_link`、`blackboard_unlink`、`blackboard_remove`、`blackboard_focus`、`blackboard_checkpoint`、`blackboard_init`。

参数与参考插件一致；`init` 创建 `.flow/`，不是 `.blackboard/`。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `cliPath` | 自动 | 指向 `bin/blackboard.js` |
| `agentId` | 不注入 | 显式设置 `BLACKBOARD_AGENT` |
| `prompt` | `true` | 注册系统提示段落 |
| `timeoutMs` | `30000` | 单次 CLI 超时 |
| `viewerIdleMs` | `1800000` | 画布闲置回收；0 关闭 |

## 注意

- 本插件工具名与 `Fruit-Guardians/Blackboard_Plugin` 相同，**不要同时安装两份**；
- 画布依赖发行版根目录的 `public/`，请使用本仓库的构建产物；
- 插件是本地 link 安装，不会出现在市场索引；已安装 bundle 会出现在「设置 → 插件」。

---

本插件结构参考 [Fruit-Guardians/Blackboard_Plugin](https://github.com/Fruit-Guardians/Blackboard_Plugin)（MIT），并适配 Infinite Blackboard 的 `.flow/`、教学画布与本仓库 CLI。
