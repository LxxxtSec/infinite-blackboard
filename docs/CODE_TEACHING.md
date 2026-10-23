# 代码与教学黑板（0.6 新增）

> 状态：增量能力。原有「Agent 外置黑板」的节点、游标、Digest、Lint、Hook 语义完全不变；
> 本文件只描述额外叠加的一层数据与界面。设计基线仍见 [`BLACKBOARD_DESIGN.md`](BLACKBOARD_DESIGN.md)。

## 1. 它解决什么问题

内核 LPE 这类 PoC/exp 的学习难点有两个：

1. **整体**：一条链由「攻击面 → 触发 → 原语 → 泄露 → 喷洒 → 覆写 → 提权 → 影响」构成，只看单点代码看不出它们如何咬合。
2. **局部**：每一段代码为什么这么写、哪一行是危险点、失败路径在哪里，需要逐行讲。

因此黑板上额外记录：

| 实体 | 事件 | 作用 |
|---|---|---|
| 代码文件 | `file` | 路径、语言、行数、内容 hash |
| 代码单元 | `node`（`type: "unit"`） | 函数/结构体/枚举/宏，带 `file / startLine / endLine / tags / calls` |
| 攻击阶段 | `node`（`type: "stage"`） | `phase` 取 `entry…cleanup`，用 `step-before` 串成链 |
| 讲解 | `lesson` | 大局 / 分步 / 逐行，绑定单元或行号，记录代码 hash |
| 学生提问 / 回答 | `request` / `reply` | 画布提问 → Agent 读取 → 写回答案 |

代码本身**不进入事件日志**：黑板只存锚点与 hash，查看时从项目文件读取。这样日志不会被源码撑大，代码改动也能被检测出来（`stale-lessons`）。

## 2. 快速开始

页面优先（推荐给学生/老师）：

```bash
blackboard init --title "Android 内核 LPE 教学"
blackboard serve --open
# 打开页面 → 顶栏「导入」：填 git 地址或上传 zip
# 同一个弹窗里继续编辑「函数作用 / 攻击链 / 讲解」
```

命令行等价流程：

```bash
# 1) 在包含 PoC 的项目根目录初始化黑板
blackboard init --title "Android 内核 LPE 教学"

# 2) 学生只需要把 zip 或仓库地址交给 Agent
blackboard code import ./poc                       # 已有本地目录
blackboard code import ~/Downloads/poc.zip          # 压缩包（放进 .flow/sources/）
blackboard code import https://github.com/a/b.git   # git 仓库（浅克隆）
#   --dest <名字> 指定 .flow/sources/ 下的目录名；--refresh 重新拉取

# 3) Agent 分析后写回：函数作用 + 这份 PoC 自己的攻击链
blackboard annotate --file roles.json
blackboard chain import chain.json --replace

# 4) 导入讲解（由你的教学 skill 产出 lesson JSON，见第 4 节）
blackboard teach import lesson-overview.json
blackboard teach import lesson-vuln-free.json

# 5) 打开画布：教学视图 + 代码/讲解/提问面板
blackboard serve --open

# 6) 看覆盖率与质量提示
blackboard coverage
blackboard lint
```

学生提问闭环：

```bash
# 学生：画布上选中代码行 → 提交问题（POST /api/request）
# Agent：
blackboard requests                 # 看待答问题
blackboard reply rq1 --text "锁只保护临界区，不保护对象在锁外的生命周期。"
blackboard digest                   # 自己的摘要里也会出现待答提问与未讲单元
```

## 3. 命令行

| 命令 | 说明 |
|---|---|
| `code import <文件\|目录> [--chain] [--lang c] [--json]` | 解析并入库；重复执行只更新变化 |
| `code ls [--file <path>] [--tag leak] [--all] [--json]` | 列出代码单元 |
| `file show <path> [--lines 10-40] [--json]` | 打印代码窗口（路径相对黑板根） |
| `file ls` | 列出已导入文件 |
| `teach import <lesson.json\|-> [--json]` | 校验并导入讲解包（`-` 从 stdin 读） |
| `teach ls [--level line]` / `teach show <id>` | 查看讲解；`show` 输出 Markdown |
| `annotate <unit> --role "作用"` / `annotate --file roles.json` | 写函数在整条 PoC 中的作用（按 id 或 `file:symbol`） |
| `chain import <chain.json\|-> [--replace]` / `chain ls` / `chain clear` | 写入 Agent 分析后的攻击链；`--replace` 替换启发式草稿 |
| `learn <unit> [--undo]` | 学生标记/取消学习完毕 |
| `ask "问题" [--unit u12] [--file path --lines 10-20]` | 记录学生提问（命令行侧） |
| `reply <request-id> --text "…" \| --file reply.md` | 回答提问 |
| `requests [--open] [--json]` | 查看提问与回答 |
| `coverage [--json]` | 覆盖率、过期讲解、行级批注统计 |

原有命令保持不变；`node add stage|primitive|vuln|mitigation|concept` 可以直接写教学语义节点，`link` 使用新增关系（下表）。

## 4. 讲解包 schema

```json
{
  "schema": "blackboard.lesson.v1",
  "level": "line",
  "title": "逐行读 vuln_free：一个 refcount 竞态 + 悬垂指针",
  "difficulty": "advanced",
  "skill": { "name": "kernel-lpe-teach", "version": "0.1.0" },
  "target": {
    "file": "vuln_demo.c",
    "lines": [{ "start": 69, "end": 86 }]
  },
  "summary": "先分清锁保护了什么，再找出锁没保护什么。",
  "sections": [
    { "heading": "阅读顺序", "body": "1. …\n2. …", "refs": ["vuln_demo.c:69-86"] }
  ],
  "lineNotes": [
    { "file": "vuln_demo.c", "line": 80, "kind": "danger", "note": "refcnt-- == 0 不是原子操作" }
  ],
  "concepts": [
    { "term": "UAF", "explain": "对象释放后仍被引用……" }
  ],
  "prerequisites": ["了解 mutex 的加锁范围"],
  "exercises": [
    { "prompt": "为什么检查必须放在锁内？", "answer": "两个线程可能同时读到 refcnt==1 并通过检查。" }
  ]
}
```

字段约定：

- `level`：`overview`（整块黑板的大局）、`unit`（一个单元/一组行）、`line`（逐行，通常带 `lineNotes`）。
- `target`：三选一 —— `{ "board": true }`、`{ "unit": "u12" }`、`{ "file": "...", "lines": [{start,end}] }`。
- `lineNotes[].kind`：`note` / `key` / `danger` / `payload` / `check`。
- `sections[].body`、`summary`、`answer` 是 Markdown（前端用内置轻量渲染器，不注入 HTML）。
- `refs` 是自由字符串（`u12`、`file:10-20`），仅供阅读。

导入时黑板会：

1. 校验 `target` 指向已导入的文件/单元，行号不越界（不通过则**拒绝导入**并列出行号）；
2. 用当前文件 hash 填充 `codeHashes`；
3. 生成 `ls1`、`ls2`… 追加 `lesson` 事件。

**过期检测**：之后重新 `code import` 时若文件 hash 变化，`blackboard coverage` / `lint` 会报告 `stale-lessons`，原讲解不会被删除或改写。重新生成后导入即可。

## 4.0 宏查询表

宏不画在画布上（没有调用关系，容易成为孤立卡片）。顶栏「宏 N」打开查询表：

- 左列可搜索宏名 / 作用 / 来源，按文件与行号排序；
- 右侧显示**定义代码（含上下 2 行上下文，高亮宏本体）**、**它代表什么（role）**、**来源 / 讲解（detail）**；
- 「在代码面板打开」可跳到完整文件与逐行讲解。

给宏补作用与来源：

```json
{
  "vuln_demo.c:VULN_IOC_ALLOC": {
    "role": "虚构驱动的分配 ioctl 命令号",
    "detail": "来源：vuln_demo.c 顶部手写 ABI；真实目标需按厂商 ioctl 表核对。"
  }
}
```

`annotate --file` 的值可以是字符串（只写 role）或 `{role, detail}` 对象；key 仍支持 id / 唯一符号 / `文件:符号`。

## 4.1 函数作用与学习进度

**函数作用（Agent 写）**：每个代码单元有一个 `role` 字段，显示在卡片标题上方、Inspector 与代码面板里。

```bash
blackboard annotate leak_kernel_pointer --role "泄露：从悬垂对象读回字段，换算内核基址"
blackboard annotate --file roles.json       # { "exploit.c:leak_kernel_pointer": "…" }
```

- `annotate` 支持短 id、唯一符号、或 `文件:符号`（同名函数在两个文件里时用这种写法）。
- 一行讲清「它在整条 PoC 里干什么」，不要写「这是一个函数」。
- 建议 Agent 先看代码再批量写 `roles.json`；`blackboard digest` 会显示未标注的单元。

**学习进度（学生写）**：选中函数后点「学习完毕」，卡片会出现绿色 ✓、进度显示 `已学 N/M`。

```bash
blackboard learn u18            # 或 blackboard learn leak_kernel_pointer
blackboard learn u18 --undo
```

状态写入 `patch` 事件（`learned / learnedAt`），会出现在 digest 的 `学完 X/Y`、Agent context 的 `teaching.learned` 与未讲解列表里。离线导出只读，不能改进度。

## 4.2 攻击链由 Agent 定义（不套固定步骤）

每个 PoC 的攻击路径不同，所以阶段标题和 `phase` 都是**自由文本**，顺序由 `step-before` 决定；内置的 `entry…cleanup` 只是可选提示，不是约束。

**阶段粒度按手法聚合，不按单个动作拆：** 一个阶段代表一个可独立命名的利用手法/原语，同一技术流程里的准备、堆布局、对象喷洒、泄漏/读取应放在同一个阶段。例如 KernelSnitch 流程同时包含堆布局和 mm_struct 泄露，就不应拆成两个阶段；通常 4-8 个阶段。每个函数只归入一个主阶段，避免同一函数在多个阶段重复出现。

```json
{
  "stages": [
    { "title": "确认攻击面：虚构 ioctl 驱动", "phase": "recon", "units": ["vuln_demo.c:vuln_free"] },
    { "title": "触发竞态", "phase": "race-window", "units": ["trigger_race"] },
    { "title": "拿到悬垂句柄", "phase": "uaf-primitive", "units": ["keep_freed_object_handle"] }
  ]
}
```

```bash
blackboard chain import chain.json --replace   # 替换之前 --chain 生成的草稿
blackboard chain ls
blackboard chain clear                         # 清空（阶段标记 removed）
```

- `units` 支持 id、唯一符号或 `文件:符号`；顺序即链的顺序。
- `blackboard code import --chain` 只是**启发式草稿**（按函数名/调用打标签），Agent 分析后应当用 `chain import --replace` 覆盖。
- UI 里自定义 `phase` 会原样显示；侧栏「攻击链」按 `step-before` 排序。

## 5. 覆盖率与语义

- 覆盖率分母是「可讲解单元」：`function`、`struct`、`enum`、`file`；宏不算（宏不画在画布上，改用顶栏「宏 N」查询表，避免无连线的孤立卡片）。
- 一个单元被覆盖 = 有讲解以它为 `unit` 目标，或有讲解的行范围与它重叠。
- `coverage` 输出：整体比例、按文件统计、讲解数/过期数、行级批注数、待答提问数。
- `lint` 只在**存在代码单元**时追加教学检查：缺文件、行号越界、未讲解单元、过期讲解、逐行讲解没有行批注、待答提问、阶段没有实现单元。旧黑板的 lint 输出不变。

## 5.0 导出功能模块

顶栏「导出」→ 选择分组（攻击阶段 / 文件）→ 下载：

- **draw.io**：`模块总览`（纯模块卡片，不画交叉箭头）+ 每个模块一页（函数卡片和模块内调用边）+ 独立的 `跨模块调用` 列表页。总览卡片显示调用/被调用次数。
- **XMind**：多 Sheet，`攻击链总览` + 每个攻击阶段一张 Sheet；总览是项目 → 模块 → 函数，分 Sheet 是阶段 → 函数；函数备注包含作用、文件行号、学习状态和调用目标。
- 选中阶段或进入阶段教学后，导出菜单可勾选「只导出当前阶段（当前页面）」；draw.io 只出该模块页，XMind 只出该阶段 Sheet。

接口：`GET /api/export/drawio?group=stage|file`、`GET /api/export/xmind?group=stage|file`。XMind 使用现代 JSON 格式（XMind 2020+）。

## 5.0.1 函数讲解与代码范围

- 选中函数时，讲解优先级为：`target.unit` 函数级 → 窄行范围 → 文件级 → 全局总览；
- 没有函数级 lesson 时，右侧会明确标注「文件级」并提示当前函数还没有单独讲解；
- 可点「让 Agent 讲解本函数」提交请求，Prompt 要求 Agent 写入 `target.unit`，生成后自动成为首选；
- 代码区默认只显示当前函数行，可切「整文件」；点击文件外行内批注会自动展开整文件。

## 5.0.1 阶段教学

- 单击画布上的攻击链阶段，或左栏「攻击链」行的靶心按钮，进入**阶段教学**模式。
- 画布只保留：该阶段节点 + 所有通过 `implements` 绑定到它的代码单元，以及这些单元之间的调用关系。
- 顶部徽标显示「阶段教学 · 阶段名 · N 个函数 · 先基础后入口」，点「从 #1 开始」会打开第一个函数的代码+讲解，点「退出」回到整条攻击链。
- 推荐顺序：按阶段函数之间的 `calls` 做后序遍历，**被调用者先看，调用者/入口最后**；没有调用关系的函数按文件行号排序。
- 函数按调用深度分列：**调用者靠左、被调用者靠右**，和全局教学层次一致；没有调用关系的函数按文件行号放入同层网格。
- 每个函数卡片右上角有 `#1–#N` 编号；左栏「本阶段学习顺序」按同一顺序列出。
- 阶段函数可以继续单击查看作用、双击/「查看实现」打开代码+讲解。
- 进入阶段教学会自动切到「教学」视图，并清除之前的锁定聚焦。

## 5.1 左侧（攻击链）与右侧（Agent 对话）

**攻击链不是固定模板**：`chain.json` 由 Agent 分析代码后写，标题和 phase 都是自由文本。`blackboard code import --chain` 只是按函数名/调用打标签的启发式草稿，分析完成后应该用 `chain import --replace` 替换。示例里的 `recon / race-window / uaf-primitive / infoleak / heap-groom` 就是自定义阶段。

**右侧对话栏**（默认在宽屏打开，可收起）：

- 学生在输入框提问；若选中了代码单元，问题会自动带上这个单元（`unitId` + 文件/行号）。
- 右上角齿轮选择运行方式：
  - **外部轮询**（默认）：提交后写一条 `request` 事件；Claude Code / Codex 用 `blackboard requests` 读取，用 `blackboard reply` 写回；SSE 实时刷新。
  - **模型 API**：OpenAI 兼容的 base URL / model / key，服务端流式回答，展示 reasoning 摘要与「停止」；回答结束写回 `reply`。
  - **本地 Agent CLI**：命令模板必须含 `{prompt}`（Claude / Codex / Pi / OMP / 任意 CLI），服务端在 macOS/Linux 通过 `/bin/sh -lc`、Windows 通过 PowerShell `-Command` 启动，解析 JSONL/纯文本、流式展示思考/工具步骤；停止会杀掉进程树。Pi / OMP 预设已经带 `--mode json --thinking high --no-session`；思考事件取决于模型是否支持 reasoning。
- 密钥只存在本机 `.flow/agent.json`（0600），不会下发浏览器；流式中断会保存已生成部分并标记 `stopped`。
- 离线导出的 HTML 里可以查看历史对话，但不能继续提问。

## 5.2 项目制

```bash
blackboard serve --projects ./projects
```

- `./projects/<id>/` 每个目录是一块独立黑板；顶栏「项目」列出项目并可新建/切换。
- 新建项目只有空黑板，不会带示例数据。
- 导入代码后，网页显示「等待 Agent 分析」：Agent 写回函数作用 / 攻击链 / 讲解后，画布才展开（也可点「先查看代码」临时绕过）。
- 左侧导航与右侧对话栏都可拖动分隔线调宽，双击恢复默认。

## 6. 画布

- 顶栏新增 **教学** 视图（仅当黑板有代码/阶段时出现）；有代码的黑板默认打开教学视图。
- 教学视图只显示「链 + 代码 + 讲解锚点」相关节点，避免旧语义干扰。
- 教学视图有三种布局（工具栏「层次 / 链路 / 文件」，可用 `?layout=hierarchy|chain|files` 分享）：
  - **层次（默认）**：入口/整体在左上；被调用函数逐层向右、向下展开，所以最右/最下的是最基础、应该先学的函数；从右往左看就是「谁调用了它」。每一层会折成多行，避免扁平调用图拉成一条竖线。
  - **链路**：攻击阶段纵向排成一列，实现单元向右分支，被调用函数再向右分支；同一节点只放置一次，其余关系画成虚线跨线。
  - **文件**：每个 `.c/.h` 文件一个虚线框，函数在框内按「调用者在前、被调用者在后」的紧凑网格排列；文件框按行排布，避免一列到底。
- **跨文件调用**：文件与文件之间的 `calls` 用虚线 + 被调用函数名标注（如 `heap.c —spray_msg()→ utils.c`），文件框标题同时显示 `→ utils.c ×2` 这类摘要。
- 侧栏「文件依赖」列出跨文件调用（调用 ×N）与 `#include`（引用），点击代码单元即可跳转。
- 单击代码单元：直接打开 **代码 / 讲解 / 提问** 面板并定位到实现（Inspector 也有「查看实现」）。代码来自 `/api/file`（离线导出用内嵌代码）。
- 拖动节点只改变你的本地视图；点左下「重置布局」会按当前布局模式重新排布并 fitView 全图。
  - 点击行选择范围，Shift 点击扩展；行内批注显示为圆点，悬停看内容。
  - 讲解面板包含 Markdown 正文、概念、练习（答案折叠）、逐行批注（可跳行）。
  - 提问面板：提交后写入 `request` 事件，Agent 在 `digest`/`context`/`requests` 中看到。
- 侧栏新增：攻击链、文件依赖、未讲解单元、学生提问；原「待验证/发现/未连接」在有教学数据时仍保留。
- 顶栏显示覆盖率与待答提问数；`⌘K` 搜索包含代码单元与文件路径。

## 7. HTTP 接口（新增）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/file?path=<相对路径>&start=<n>&end=<n>` | 读取代码窗口（最多 4000 行，路径限制在黑板根内） |
| POST | `/api/request` | 学生提问；需要 `Content-Type: application/json` + `X-Blackboard-Request: <snapshot.requestToken>` |

`requestToken` 是**每进程随机值**，随 `/api/graph` 与 SSE 快照下发；服务仍只绑定 `127.0.0.1`，没有账号体系。跨站表单无法读取 token，跨站 JSON fetch 会触发预检而被拒绝。离线导出为只读，不提供提问。

## 8. 关系与节点

新增节点类型：`unit`、`stage`、`primitive`、`mitigation`、`concept`、`answer`。
新增关系：`calls`、`includes`、`data-flow`、`implements`、`enables`、`bypasses`、`step-before`、`part-of`、`explains`。

方向约定不变：`link <from> <to> --rel X` 读作 **from X to**。

- `unit --calls--> unit`：代码调用（导入时自动建，只解析到已知函数）；
- `unit --implements--> stage`：这个单元实现了哪个攻击阶段；
- `stage --step-before--> stage`：攻击链顺序；
- `primitive --enables--> stage`、`mitigation --bypasses--> stage`：利用原语/缓解措施与阶段的关系；
- `lesson` 不建边，它用 `target` 直接锚定代码，避免把教学内容混入逻辑图。

## 9. 兼容与边界

- **旧黑板零影响**：没有 `file`/`lesson`/`request` 事件时，`digest`、`context`、`lint`、快照、导出都保持原输出；旧节点类型与命令不变。
- **代码必须在黑板根目录内**：否则 serve/export 无法读取，导入会给出明确错误（把黑板建在包含 PoC 的项目里即可）。
- **不执行代码**：解析器只做文本锚定与启发式标签（`leak`、`spray`、`escalate` 等），不会编译、运行或验证漏洞；阶段链只是建议，可由 Agent/教师改。
- **不内嵌 LLM**：讲解由外部教学 skill 生成并导入；黑板只负责锚定、版本、覆盖率与展示。
- **安全**：代码与讲解可能包含敏感信息；`.flow/` 自带 `.gitignore`。导出会内嵌被引用的代码，分享前请确认内容。

## 10. 示例

[`examples/kernel-lpe-demo/`](../examples/kernel-lpe-demo/) 是一份**合成的** Android 内核 LPE 教学样例（虚构驱动 `/dev/vuln_demo`，不可运行、不可利用），包含：

- `exploit.c`：入口/触发/原语/泄露/喷洒/覆写/提权/影响/清理；
- `vuln_demo.c`：带 refcount 竞态与悬垂指针的虚构驱动（含 BUG 注释）；
- `lesson-overview.json`：整条链的大局讲解；
- `lesson-vuln-free.json`、`lesson-leak.json`：两组逐行讲解（含行级批注）。

```bash
cp -r examples/kernel-lpe-demo /tmp/lpe-demo && cd /tmp/lpe-demo
blackboard init --title "内核 LPE 教学示例"
blackboard code import .
blackboard annotate --file roles.json
blackboard chain import chain.json
blackboard teach import lesson-overview.json
blackboard teach import lesson-vuln-free.json
blackboard teach import lesson-leak.json
blackboard coverage
blackboard serve --open
```
