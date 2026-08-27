# VSCode 插件面试 Agent 优化开发方案

## 1. 背景与目标

当前项目已经实现了 VS Code 插件外壳和 Python Agent 内核，但主要使用方式仍偏开发调试：需要在插件源码项目中启动 Extension Development Host，再打开目标文件夹进行面试。

本次优化目标是把它做成正式可安装的 VS Code 插件：

- 用户打开任意目标项目文件夹后，可直接从 VS Code 扩展库安装 `Interview Agent`。
- 插件安装后在 VS Code 侧边栏或右侧面板提供面试窗口。
- 用户可以在插件中切换模型。
- Agent 的唯一产品功能是与用户交互进行技术面试，不扩展为通用代码助手或通用 Agent 平台。

## 2. 产品边界

### 2.1 保留能力

- 面试开始前收集岗位 JD、简历摘要、项目背景。
- 读取当前 VS Code 工作区代码，识别项目技术栈和关键模块。
- 基于「岗位要求 + 当前项目实际技术栈」进行技术提问、追问和总结。
- 支持模型配置和切换，例如模型名、Base URL、API Key、演示模式。

### 2.2 不做能力

- 不做通用聊天助手。
- 不做自动写代码、改代码、提交代码。
- 不做多 Agent 编排。
- 不做任务管理、项目治理、自动修复等扩展能力。
- 第一版不做复杂账号体系或模型市场。

## 3. 当前实现问题

| 问题 | 现状 | 影响 |
|---|---|---|
| 插件运行依赖源码目录 | 当前通过插件目录往上找 `agent/main.py` | 发布成 `.vsix` 后容易找不到 Python 内核 |
| 主入口像开发工具 | 通过命令打开 `WebviewPanel` | 用户体验不像常驻 Agent 面板 |
| 模型配置主要在设置页 | 已有 `interview.model`、`interview.baseUrl` 等配置 | 用户切换模型不够直观 |
| 功能边界需要收窄 | Agent 能对话，也能调工具查代码 | UI 和提示词需要明确只服务面试 |

## 4. 目标架构

```text
VS Code 插件
├── Activity Bar / Side Bar 面试视图
├── Webview 聊天 UI
├── Extension Host
│   ├── 读取当前工作区路径
│   ├── 读取/保存模型配置
│   └── spawn Python Agent 子进程
└── bundled-agent
    └── agent
        ├── main.py
        ├── session.py
        ├── prompt_builder.py
        └── tools/
```

关键点：

- 插件包内自带 Python Agent 源码。
- Python 子进程读取的是用户当前打开的目标项目。
- VS Code 插件只负责 UI、配置和进程转发。
- Agent 内核继续负责面试逻辑、工具调用和 LLM 通信。

## 5. 开发任务清单

### 5.1 插件打包自包含化

| 任务 | 说明 | 相关文件 |
|---|---|---|
| 新增 Agent 复制脚本 | 发布前把 Python Agent 复制到插件目录下 | [package.json](../../../vscode-extension/package.json) |
| 修改 Agent 路径定位 | 从 `context.extensionUri/bundled-agent/agent/main.py` 启动 | [extension.ts](../../../vscode-extension/src/extension.ts) |
| 调整发布忽略规则 | 排除 Python 测试、缓存、临时文件 | [.vscodeignore](../../../vscode-extension/.vscodeignore) |
| 补打包命令 | 增加 `.vsix` 本地打包命令 | [package.json](../../../vscode-extension/package.json) |

建议插件内运行结构：

```text
vscode-extension/
├── bundled-agent/
│   └── agent/
├── media/
├── out/
└── package.json
```

第一版只内置 Python 源码，不内置 Python 解释器。

### 5.2 改造为侧边栏面试视图

| 任务 | 说明 | 相关文件 |
|---|---|---|
| 注册 Activity Bar 容器 | 新增 `interview-agent` 视图容器 | [package.json](../../../vscode-extension/package.json) |
| 注册 Webview View | 新增面试聊天视图 | [package.json](../../../vscode-extension/package.json) |
| 改造 Webview 管理类 | 从 `WebviewPanel` 改为 `WebviewViewProvider` | [webviewPanel.ts](../../../vscode-extension/src/webviewPanel.ts) |
| 修改命令行为 | 命令面板只聚焦侧边栏面试视图，不新开编辑器 Tab | [extension.ts](../../../vscode-extension/src/extension.ts) |

第一版可以保留现有 `InterviewPanel` 的大部分消息转发逻辑，只替换 VS Code 容器形态。

### 5.3 增加模型切换 UI

| 任务 | 说明 | 相关文件 |
|---|---|---|
| 增加模型配置区 | 在面试窗口顶部展示 Provider、Model、Demo Mode | [index.html](../../../vscode-extension/src/webview/index.html) |
| 增加配置交互 | Webview 向 Extension Host 发送模型配置变更 | [main.js](../../../vscode-extension/src/webview/main.js) |
| 增加样式 | 保持紧凑的侧边栏布局 | [styles.css](../../../vscode-extension/src/webview/styles.css) |
| 保存配置 | 使用 VS Code `workspace.getConfiguration("interview")` 写回配置 | [extension.ts](../../../vscode-extension/src/extension.ts) |

第一版建议支持这些配置：

| 配置项 | 用途 |
|---|---|
| `interview.model` | 当前模型名 |
| `interview.baseUrl` | OpenAI 兼容 Base URL |
| `interview.apiKey` | API Key |
| `interview.demoMode` | 演示模式 |

模型切换规则：

- 面试未开始时，配置立即生效。
- 面试进行中切换模型，从下一轮消息开始生效。
- 如果切换了 `apiKey` 或 `baseUrl`，重启 Python 子进程。
- 第一版不保存多套账号。

### 5.4 固定面试流程 UI

| 任务 | 说明 | 相关文件 |
|---|---|---|
| 增加 JD 输入区 | 面试前粘贴岗位 JD | [index.html](../../../vscode-extension/src/webview/index.html) |
| 增加项目背景输入区 | 可选填写简历摘要或项目背景 | [index.html](../../../vscode-extension/src/webview/index.html) |
| 增加开始面试按钮 | 首次发送时组织成面试上下文 | [main.js](../../../vscode-extension/src/webview/main.js) |
| 保留聊天区 | 继续复用 stream、tool_call、done、error 渲染 | [main.js](../../../vscode-extension/src/webview/main.js) |

首屏推荐布局：

```text
Interview Agent

模型：[gpt-4o-mini v]    Demo Mode [ ]

岗位 JD
[textarea]

简历 / 项目背景
[textarea]

[开始面试]

聊天区
```

### 5.5 保持 Agent 内核面试职责

| 任务 | 说明 | 相关文件 |
|---|---|---|
| 收窄系统提示 | 明确 Agent 只做面试，不做代码修改和通用助手 | [prompt_builder.py](../../../agent/prompt_builder.py) |
| 保持协议简单 | 继续使用 `init/chat/stop`，不新增 Agent 类型 | [protocol.py](../../../agent/protocol.py)、[protocol.ts](../../../vscode-extension/src/protocol.ts) |
| 复用会话管理 | JD、简历、项目背景进入会话上下文 | [session.py](../../../agent/session.py) |
| 保留工具调用 | 只用于理解当前项目技术栈和追问依据 | [builtin.py](../../../agent/tools/builtin.py) |

原则：模型切换是配置能力，不改变 Agent 的产品职责。

### 5.6 测试与验证

| 任务 | 命令或方式 | 验证目标 |
|---|---|---|
| TypeScript 类型检查 | `npx tsc -p ./ --noEmit` | 插件编译通过 |
| VS Code 插件测试 | `npm test` | TS 协议和子进程管理不回归 |
| Python 测试 | `pytest` | Agent 内核行为不回归 |
| Python 代码检查 | `ruff check agent/` | Python 代码风格通过 |
| 插件编译 | `npm run compile` | 生成 `out/` 和 `media/` |
| 插件打包 | `npm run package` | 生成可安装 `.vsix` |
| 手工安装验证 | 安装 `.vsix` 到任意目标项目 | 侧边栏面试窗口可用 |

## 6. 推荐实施顺序

1. 完成插件自包含打包，确保正式安装后能启动 Python Agent。
2. 把 `WebviewPanel` 改成侧边栏 `WebviewViewProvider`。
3. 增加模型选择和配置保存。
4. 增加 JD / 项目背景首屏面试流程。
5. 收窄系统提示，强化“只做面试”的职责边界。
6. 运行测试、类型检查、打包和手工安装验证。

## 7. 第一版验收标准

- 能生成 `.vsix` 插件包。
- 打开任意非本项目的目标文件夹后，可以安装并使用插件。
- VS Code 侧边栏出现 `Interview Agent` 面试视图。
- 用户可以在面板中切换模型配置。
- 用户可以输入岗位 JD 并开始面试。
- Agent 读取的是当前目标项目，而不是插件源码项目。
- Agent 交互内容围绕面试，不提供通用代码助手能力。

## 8. 暂缓事项

以下内容第一版先不做，等插件基本体验稳定后再评估：

- 自动创建 Python venv。
- 自动安装 Python 依赖。
- 多 Provider 账号管理。
- 模型市场或模型推荐。
- 插件市场自动发布流水线。
- 面试报告导出。
- 录音、语音面试或实时语音交互。
