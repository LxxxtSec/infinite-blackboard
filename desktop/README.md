# Infinite Blackboard Desktop

一个围绕本地服务的最小 Electron 外壳：

- 启动时在随机本地端口启动 `lib/server.js`；
- BrowserWindow 打开同一个 Web 画布；
- 托盘菜单：打开窗口、打开项目目录、重启服务、退出；
- 退出应用时停止服务；
- 项目数据默认在 `~/blackboard-projects`，可用 `BLACKBOARD_PROJECTS` 覆盖；
- 不改变 CLI、Web、Agent 集成。

## 开发运行

```bash
npm install
npm run desktop:dev
```

## 打包

```bash
npm run desktop:pack   # 目录版，先验证
npm run desktop:dist   # 生成 dmg / zip（macOS）
```

产物在 `desktop/dist/`。

## 注意

- 本机需要能运行 Agent CLI（`claude` / `codex` / `pi` 等），桌面版不会替你安装或登录；
- 从 Finder 启动时应用会尝试读取登录 shell 的 PATH，避免找不到 `pi` 等命令；
- 目前未做代码签名；公开分发前需要 Apple Developer 签名与公证；
- `asar: false` 是为了让上下文里的 `bin/flow.js` 路径仍可被外部 Agent CLI 使用；后续可改成 asarUnpack + 绝对路径注入。
