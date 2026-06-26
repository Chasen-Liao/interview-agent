/**
 * Webview 面板管理（设计第 5.5 节两跳中转 + 第 5.3.3 节选中代码注入）。
 *
 * 这是 Extension Host 里的"中转站"：
 * - Webview → Host（chat/stop 消息）→ 转成 Request 发给 Python
 * - Python → Host（stream/tool_call/done/error 通知）→ postMessage 给 Webview
 *
 * Host 不放业务逻辑（设计第 5.5 节），只做翻译和转发。
 */

import { randomBytes } from "crypto";
import { Uri, ViewColumn, Webview, WebviewView, window } from "vscode";
import { AgentClient } from "./agentClient";
import { buildChat, buildStop } from "./protocol";

/** 从配置构造 AgentClient 需要的参数。 */
export interface PanelOptions {
  pythonPath: string;
  scriptPath: string;
  workspace: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  resume?: string;
}

export class InterviewPanel {
  private agent: AgentClient;
  private readonly sessionId: string;

  constructor(
    private readonly htmlBasePath: Uri,
    options: PanelOptions,
  ) {
    // 每个 Webview 一个独立会话 id（Python 侧据此隔离历史）
    this.sessionId = `vscode-${Date.now()}`;

    this.agent = new AgentClient({
      pythonPath: options.pythonPath,
      scriptPath: options.scriptPath,
      workspace: options.workspace,
      apiKey: options.apiKey,
      model: options.model,
      baseUrl: options.baseUrl,
      resume: options.resume,
      session: this.sessionId,
    });
  }

  /** 打开 Webview 面板，spawn Python，接通双向通信。 */
  open(): void {
    const panel = window.createWebviewPanel(
      "interviewAgent",
      "Interview Agent",
      // 在活动编辑器列打开，没有活动编辑器则用当前活动列
      window.activeTextEditor?.viewColumn ?? ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.htmlBasePath],
      },
    );

    panel.webview.html = this.buildHtml(panel.webview);

    this.wireMessages(panel.webview);
    this.wireAgent(panel.webview);

    panel.onDidDispose(() => {
      this.agent.dispose();
    });

    // 启动 Python 子进程（内部自动发 init）
    this.agent.start();
  }

  // ──────────────────────────────────────────────
  // Webview → Host：用户的 chat/stop
  // ──────────────────────────────────────────────

  private wireMessages(webview: Webview): void {
    webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      if (msg.type === "chat") {
        const attached = this.readSelection();
        this.agent.send(
          buildChat({
            session: this.sessionId,
            text: msg.text,
            attached_code: attached,
          }),
        );
      } else if (msg.type === "stop") {
        this.agent.send(buildStop(this.sessionId));
      }
    });
  }

  /** 读当前编辑器选中的代码（设计第 5.3.3 节）。 */
  private readSelection(): { file: string; content: string } | undefined {
    const editor = window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    const selection = editor.selection;
    if (selection.isEmpty) {
      return undefined;
    }
    const text = editor.document.getText(selection);
    if (!text.trim()) {
      return undefined;
    }
    return {
      file: editor.document.fileName,
      content: text,
    };
  }

  // ──────────────────────────────────────────────
  // Python → Host → Webview：通知转发
  // ──────────────────────────────────────────────

  private wireAgent(webview: Webview): void {
    this.agent.onNotification((n) => {
      // 透传给前端：通知原样 postMessage（method + params 结构不变）
      void webview.postMessage({ method: n.method, params: n.params });
    });

    this.agent.onError((message) => {
      // 进程级错误也走 error 通知通道，前端红色气泡展示
      void webview.postMessage({
        method: "error",
        params: { session: this.sessionId, message },
      });
    });
  }

  // ──────────────────────────────────────────────
  // HTML 构造 + CSP（设计第 5.5 节 webview 安全）
  // ──────────────────────────────────────────────

  private buildHtml(webview: Webview): string {
    const nonce = getNonce();
    const stylesUri = webview.asWebviewUri(
      Uri.joinPath(this.htmlBasePath, "styles.css"),
    );
    const scriptUri = webview.asWebviewUri(
      Uri.joinPath(this.htmlBasePath, "main.js"),
    );

    // 读 index.html 模板，替换占位符
    // 注：fs 在 extension 上下文可用，这里用同步读取（启动期，可接受）
    // 为避免引入额外依赖，HTML 模板内联在此构造（含 CSP 占位符替换）
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Interview Agent</title>
  <link rel="stylesheet" nonce="${nonce}" href="${stylesUri}" />
</head>
<body>
  <div id="app">
    <div id="messages" class="messages"></div>
    <div class="composer">
      <textarea id="input" class="composer__input" placeholder="和面试官聊聊你的项目…（Enter 发送，Shift+Enter 换行）" rows="2"></textarea>
      <button id="send" class="composer__send" title="发送">发送</button>
      <button id="stop" class="composer__stop" title="中断" disabled>停止</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// ──────────────────────────────────────────────
// 辅助
// ──────────────────────────────────────────────

/** Webview 发给 Host 的消息。 */
type WebviewToHostMessage =
  | { type: "chat"; text: string }
  | { type: "stop" };

/** 生成 CSP nonce（16 字节十六进制）。 */
function getNonce(): string {
  return randomBytes(16).toString("base64");
}

// 保留 WebviewView 类型引用，便于未来改成侧边栏视图（设计第 5.2 节）
export type { WebviewView };
