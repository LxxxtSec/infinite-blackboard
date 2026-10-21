# macOS 分发说明（arm64 测试版）

当前构建：

- 架构：Apple Silicon（arm64）
- 签名：ad-hoc（`codesign --sign -`）
- 公证：**未公证**
- 数据：不包含任何项目、Agent key 或本机配置

## 接收方安装

1. 打开 `Infinite Blackboard-0.6.0-arm64.dmg`；
2. 把 `Infinite Blackboard.app` 拖到 Applications；
3. 第一次打开：右键 App →「打开」；
4. 如果提示「已损坏」：

```bash
xattr -dr com.apple.quarantine "/Applications/Infinite Blackboard.app"
```

这是未公证应用的 macOS 限制，不是文件损坏。

## 限制

- 仅 Apple Silicon；Intel Mac 需要另建 x64/universal 包；
- 本地 CLI Agent 模式要求对方自行安装并登录 `claude` / `codex` / `pi`；
- API 模式要求对方自行填写 key；
- 要正式公开分发，建议用 Apple Developer ID 签名并 notarize。
