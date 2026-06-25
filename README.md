# Interview Agent —— 会调工具的 AI 面试官

一个 **VS Code 插件**，里面住着一个**会调工具的 AI 面试官**。学生打开自己的项目，和 Agent 对话：

- 学生讲自己做了什么
- Agent **主动调用工具去翻代码、核对**学生的说法
- 基于真实代码证据，给出**有杀伤力的追问**
- 帮学生在真面试前发现自己项目的薄弱点

> 把"被动背项目话术"变成"主动被 Agent 追问锤炼"，且追问基于你**真实的代码**，不是 LLM 凭空想象。

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
| 5 | 协议层 + 系统提示 + 会话管理 + 入口 | 🚧 开发中 |
| 6 | VS Code 插件外壳（TS） | ⏳ 待开发 |
| 7 | 联调与调优 | ⏳ 待开发 |

---

## 项目结构

```
interview-agent/
├── agent/                         # Python Agent 内核（核心）
│   ├── __init__.py
│   ├── agent_loop.py              # Agent 循环（ReAct）
│   ├── llm_client.py              # OpenAI 兼容客户端 + FakeLLM
│   ├── history.py                 # 历史摘要/裁剪
│   ├── tools/                     # 工具（可插拔）
│   │   ├── base.py                # Tool 接口 + ToolRegistry
│   │   ├── builtin.py             # list_directory / search_code / read_file
│   │   └── __main__.py            # 工具装配验证脚本
│   └── tests/                     # 测试（第 1-3 层，用 FakeLLM）
│       ├── test_tools.py
│       ├── test_history.py
│       ├── test_llm_client.py
│       └── test_agent_loop.py
├── pyproject.toml                 # Python 项目配置（依赖、pytest、ruff）
├── .gitignore
└── README.md
```

---

## 环境要求

- **Python ≥ 3.12**
- 操作系统：Windows / macOS / Linux

## 安装

```bash
git clone https://github.com/Daisy-HHY/interview-agent.git
cd interview-agent
pip install -e ".[dev]"
```

## 运行测试

Agent 内核的全部逻辑都通过 `FakeLLM`（零费用、完全确定）测试，无需真实 API key：

```bash
pytest
```

## 代码检查

```bash
ruff check agent/
```

---

## 核心设计要点

- **统一 `Tool` 接口**：所有工具（内置 / 未来 MCP）都实现 `name`/`schema`/`execute` 三契约。Agent 循环只认接口不认实现，加减工具 / MCP 化 / 场景扩展都不改循环。
- **ReAct 循环**：LLM 在每一步"先想再调工具"，工具结果作为 Observation 喂回去，直到它直接回答。
- **三层历史防线**：工具返回时精炼 → 老结果摘要 → token 上限硬裁剪，防止对话历史爆炸。
- **错误自愈**：工具失败不杀循环，把错误当 Observation 喂回 LLM，让它自我纠正。
- **FakeLLM 测试**：核心循环全部用假 LLM 测，零费用、确定、能覆盖所有行为分支。

---

## License

MIT
