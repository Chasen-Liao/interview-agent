# Interview Agent —— 会调工具的 AI 面试官

一个 **VS Code 插件**，里面住着一个**会调工具的 AI 面试官**。求职者打开自己的项目，和 Agent 对话：

- 面试官先了解你的**岗位 JD** 和**项目背景**
- 调用工具**摸清项目用了什么技术栈**（不是逐行抠代码）
- 基于 **JD 要求 ∩ 项目实际技术栈**，针对**技术点**深入提问（原理 / 权衡 / 踩坑）
- 帮你在真面试前发现自己哪里还讲不清、答不准

> 模拟真实面试官的考察方式：不盯着你某行代码挑刺，而是围绕你项目涉及的技术，考察你掌握的深度。

---

## 架构

> **VS Code 插件（TS）spawn 一个 Python 子进程，通过 stdio JSON-RPC 通信。所有 Agent 逻辑在 Python，可独立测试；TS 只做 UI 和编辑器集成。**

```
┌─────────────────────────┐
│  VS Code 插件 (TS)       │  UI、编辑器上下文、子进程管理
└────────────┬────────────┘
             │ stdio (每行一条 JSON-RPC)
             ▼
┌─────────────────────────┐
│  Agent 内核 (Python)     │  Agent 循环 + 工具 + 系统提示
└─────────────────────────┘
```

**为什么这么设计**：Agent 内核本质是个命令行程序，可以脱离 VS Code 用纯 Python 单元测试覆盖（最复杂、最值得测的部分脱离 IDE 也能跑）。

---

## 当前进度

| Phase | 内容 | 状态 |
|---|---|---|
| 0 | 项目脚手架 | ✅ 完成 |
| 1 | 工具层（`list_directory` / `search_code` / `read_file` + 统一 `Tool` 接口） | ✅ 完成 |
| 2 | 历史管理（压缩 + token 限流） | ✅ 完成 |
| 3 | LLM 客户端（`OpenAIClient` + `FakeLLM`） | ✅ 完成 |
| 4 | Agent 循环（ReAct while 循环 + 工具调度 + 安全阀 + 错误恢复） | ✅ 完成 |
| 5 | 协议层 + 系统提示 + 会话管理 + 入口 | ✅ 完成 |
| 6 | VS Code 插件外壳（TS）—— webview + 子进程 + 协议转发 | ✅ 完成 |
| 7 | 联调与调优（错误分类 + 自动重试 + 流式输出 + 参数可配 + 系统提示迭代） | ✅ 完成 |

---

## 项目结构

```
interview-agent/
├── agent/                         # Python Agent 内核（核心）
│   ├── __init__.py
│   ├── agent_loop.py              # Agent 循环（ReAct）
│   ├── llm_client.py              # OpenAI 兼容客户端 + FakeLLM
│   ├── history.py                 # 历史摘要/裁剪
│   ├── protocol.py                # JSON-RPC 收发 + 7 种消息类型
│   ├── prompt_builder.py          # 面试官系统提示组装
│   ├── session.py                 # 会话管理 + 历史落盘
│   ├── main.py                    # stdio 入口（VS Code spawn 它）
│   ├── smoke.py                   # 进程级冒烟脚本（FakeLLM，零费用）
│   ├── tools/                     # 工具（可插拔）
│   │   ├── base.py                # Tool 接口 + ToolRegistry
│   │   ├── builtin.py             # list_directory / search_code / read_file
│   │   └── __main__.py            # 工具装配验证脚本
│   └── tests/                     # 测试（用 FakeLLM，零 API 费用）
├── vscode-extension/              # VS Code 插件外壳（TS）
│   ├── src/
│   │   ├── extension.ts           # 激活入口 + 命令注册
│   │   ├── protocol.ts            # TS 侧协议类型（对齐 Python）
│   │   ├── agentClient.ts         # Python 子进程管理（spawn + stdio）
│   │   ├── webviewPanel.ts        # Webview + postMessage 路由 + CSP
│   │   └── webview/               # 前端（HTML/CSS/JS，纯原生）
│   ├── test/                      # vitest 单测 + 跨语言集成测试
│   └── package.json               # 插件清单（命令/配置）
├── pyproject.toml                 # Python 项目配置（依赖、pytest、ruff）
├── .gitignore
└── README.md
```

---

## 环境要求

- **Python ≥ 3.12**（Agent 内核）
- **Node.js ≥ 18**（VS Code 插件，开发用）
- 操作系统：Windows / macOS / Linux

## 安装

```bash
git clone https://github.com/Daisy-HHY/interview-agent.git
cd interview-agent

# Python 内核
pip install -e ".[dev]"

# VS Code 插件（开发依赖）
cd vscode-extension
npm install
cd ..
```

## 运行测试

### Python 内核

全部逻辑通过 `FakeLLM`（零费用、完全确定）测试，无需真实 API key。**180 个测试**覆盖工具层、历史管理、LLM 客户端（含流式/错误分类/重试）、Agent 循环、协议层、系统提示：

```bash
pytest
```

### VS Code 插件（TS）

```bash
cd vscode-extension
npm test
```

含一个**跨语言端到端测试**：TS 的 AgentClient spawn 真实 Python 内核（注入 FakeLLM），验证 `init/chat` 消息和 `tool_call/stream/done` 通知在 TS↔Python 之间完整闭环。

## 代码检查

```bash
# Python
ruff check agent/

# TypeScript（在 vscode-extension 目录）
npx tsc -p ./ --noEmit
```

---

## 作为 VS Code 插件运行（开发调试）

```bash
cd vscode-extension
npm run compile          # 编译 TS + 复制 webview 资源
```

然后在 VS Code 里按 `F5` 启动 Extension Development Host：
1. 打开一个项目（作为"被面试"的项目，面试官会摸它的技术栈）
2. 命令面板执行 `Interview Agent: 开始面试`
3. 在设置里配置 `interview.*`（见下表）

### 配置项

| 配置项 | 说明 |
|---|---|
| `interview.apiKey` | OpenAI 兼容服务的 API Key（必填，非 demo 模式） |
| `interview.baseUrl` | OpenAI 兼容端点。留空=官方 OpenAI；填可接入 DeepSeek / 智谱 / 通义等 |
| `interview.model` | 模型名（如 `gpt-4o-mini`、`deepseek-chat`、`glm-4-flash`） |
| `interview.resume` | 简历摘要（可选，面试官据此了解你的项目背景） |
| `interview.pythonPath` | Python 解释器路径 |
| `interview.demoMode` | 演示模式：用内置 FakeLLM，零费用体验完整流程（无需 API 额度） |
| `interview.maxSteps` | Agent 单轮循环最大步数（默认 8，安全阀） |
| `interview.maxHistoryTokens` | 对话历史 token 上限（默认 20000） |
| `interview.maxKeptFull` | 历史里保留完整（不压缩）的工具结果数（默认 3） |

### 面试流程

1. **开场**：面试官先问你要**岗位 JD**，并了解你的**项目概况**
2. **摸技术栈**：调用工具摸清项目用了什么框架 / 库 / 模块
3. **技术提问**：基于「JD 要求 ∩ 项目实际技术栈」，针对技术点深入追问（原理 / 权衡 / 踩坑）

---

## 核心设计要点

- **基于 JD+简历的技术面试官**：面试官围绕岗位 JD 要求和求职者项目涉及的技术点提问，考察技术掌握深度；工具用于摸清项目技术栈，而非逐行核对代码。
- **统一 `Tool` 接口**：所有工具（内置 / 未来 MCP）都实现 `name`/`schema`/`execute` 三契约。Agent 循环只认接口不认实现，加减工具 / MCP 化 / 场景扩展都不改循环。
- **ReAct 循环**：LLM 在每一步"先想再调工具"，工具结果作为 Observation 喂回去，直到它直接回答。
- **流式输出**：面试官回答逐字流式显示（`stream=True`），而非整段蹦出；中途断网保留已生成部分。
- **错误分类 + 自动重试**：401/429/断网给不同提示；429/断网/超时指数退避自动重试，401 不重试。
- **三层历史防线**：工具返回时精炼 → 老结果摘要 → token 上限硬裁剪，防止对话历史爆炸。
- **错误自愈**：工具失败不杀循环，把错误当 Observation 喂回 LLM，让它自我纠正。
- **FakeLLM 测试**：核心循环全部用假 LLM 测，零费用、确定、能覆盖所有行为分支。

---

## License

MIT
