/**
 * Webview 面试视图管理。
 *
 * Extension Host 只做三件事：
 * - 把 Webview 的聊天消息转成 Python Agent 请求
 * - 把 Python Agent 通知转发给 Webview
 * - 读取/保存模型配置并在必要时重启 Python 子进程
 */

import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import {
  CancellationToken,
  OutputChannel,
  Uri,
  Webview,
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
  commands,
  window,
} from "vscode";
import { AgentClient } from "./agentClient";
import { buildChat, buildStop } from "./protocol";

/** 共享的调试输出通道（整个插件一个，所有 Python 日志都写这里）。 */
let debugChannel: OutputChannel | null = null;
function getDebugChannel(): OutputChannel {
  if (!debugChannel) {
    debugChannel = window.createOutputChannel("Interview Agent", { log: true });
  }
  return debugChannel;
}

/** 从配置构造 AgentClient 需要的参数。 */
export interface PanelOptions {
  pythonPath: string;
  scriptPath: string;
  /** 被面试的项目根（工具翻代码的根）。 */
  workspace: string;
  /** agent 包所在根（PYTHONPATH 用），通常 = bundled-agent 根。 */
  pythonPathRoot: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  resume?: string;
  /** 演示模式：用 FakeLLM，零费用。 */
  demoMode?: boolean;
  maxSteps?: number;
  maxHistoryTokens?: number;
  maxKeptFull?: number;
}

/** 发给 Webview 的配置快照；不回传 API Key 明文。 */
export interface WebviewConfigSnapshot {
  model: string;
  baseUrl: string;
  demoMode: boolean;
  hasApiKey: boolean;
}

/** Webview 发来的配置变更。 */
export interface WebviewConfigUpdate {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  demoMode?: boolean;
}

type WebviewToHostMessage =
  | { type: "ready" }
  | { type: "chat"; text: string }
  | { type: "stop" }
  | { type: "openSettings" }
  | { type: "updateConfig"; config: WebviewConfigUpdate };

export class InterviewViewProvider implements WebviewViewProvider {
  private view: WebviewView | undefined;
  private agent: AgentClient | null = null;
  private sessionId = makeSessionId();

  constructor(
    private readonly htmlBasePath: Uri,
    private readonly buildOptions: () => PanelOptions,
    private readonly saveConfig: (config: WebviewConfigUpdate) => Promise<void>,
  ) {}

  /** 注册给 VS Code 的侧边栏 Webview View 创建入口。 */
  resolveWebviewView(
    webviewView: WebviewView,
    _context: WebviewViewResolveContext,
    _token: CancellationToken,
  ): void {
    this.disposeAgent();
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.htmlBasePath],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);
    this.wireMessages(webviewView.webview);
    this.postConfig(webviewView.webview);

    webviewView.onDidDispose(() => {
      this.disposeAgent();
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
  }

  /** 聚焦面试视图；命令面板入口复用它，不再新开编辑器 Tab。 */
  focus(): void {
    void commands.executeCommand("workbench.view.extension.interview-agent");
    void commands.executeCommand("interview.chatView.focus");
  }

  /** 选中代码提问命令：聚焦面板并预填一条面试追问。 */
  prefillSelectionQuestion(): void {
    this.focus();
    void this.view?.webview.postMessage({
      type: "prefill",
      text: "请针对我当前选中的这段代码进行面试追问。",
    });
  }

  private wireMessages(webview: Webview): void {
    webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      if (msg.type === "ready") {
        this.postConfig(webview);
        return;
      }
      if (msg.type === "chat") {
        if (!this.ensureAgentStarted(webview)) {
          return;
        }
        const attached = this.readSelection();
        this.agent?.send(
          buildChat({
            session: this.sessionId,
            text: msg.text,
            attached_code: attached,
          }),
        );
        return;
      }
      if (msg.type === "stop") {
        this.agent?.send(buildStop(this.sessionId));
        return;
      }
      if (msg.type === "openSettings") {
        void commands.executeCommand("workbench.action.openSettings", "interview");
        return;
      }
      if (msg.type === "updateConfig") {
        void this.handleConfigUpdate(webview, msg.config);
      }
    });
  }

  /** 读当前编辑器选中的代码，作为下一轮面试追问的上下文。 */
  private readSelection(): { file: string; content: string } | undefined {
    const editor = window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return undefined;
    }
    const text = editor.document.getText(editor.selection);
    if (!text.trim()) {
      return undefined;
    }
    return {
      file: editor.document.fileName,
      content: text,
    };
  }

  /**
   * 保存模型配置并重启 Agent。
   *
   * 参数：
   * - config：Webview 发来的模型名、Base URL、API Key 或 Demo Mode 更新
   * 返回值：无；保存成功后把最新配置快照发回 Webview
   */
  private async handleConfigUpdate(
    webview: Webview,
    config: WebviewConfigUpdate,
  ): Promise<void> {
    try {
      await this.saveConfig(config);
      this.restartAgent();
      this.postConfig(webview);
      void webview.postMessage({ type: "configSaved" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      void webview.postMessage({
        method: "error",
        params: { session: this.sessionId, message: `保存配置失败：${message}` },
      });
    }
  }

  /** 按当前配置懒启动 Python Agent；无 API Key 时阻止真实调用。 */
  private ensureAgentStarted(webview: Webview): boolean {
    if (this.agent) {
      return true;
    }

    const options = this.buildOptions();
    if (!options.demoMode && !options.apiKey) {
      void webview.postMessage({
        method: "error",
        params: {
          session: this.sessionId,
          message: "还未配置 API Key。请填写 API Key，或开启 Demo Mode。",
        },
      });
      return false;
    }

    this.agent = new AgentClient({
      pythonPath: options.pythonPath,
      scriptPath: options.scriptPath,
      workspace: options.workspace,
      pythonPathRoot: options.pythonPathRoot,
      apiKey: options.apiKey || "demo",
      model: options.model,
      baseUrl: options.baseUrl,
      resume: options.resume,
      session: this.sessionId,
      demoMode: options.demoMode,
      maxSteps: options.maxSteps,
      maxHistoryTokens: options.maxHistoryTokens,
      maxKeptFull: options.maxKeptFull,
    });
    this.wireAgent(webview);
    this.agent.start();
    return true;
  }

  private wireAgent(webview: Webview): void {
    const logger = getDebugChannel();

    this.agent?.onLog((message) => {
      logger.appendLine(message);
    });

    this.agent?.onNotification((n) => {
      void webview.postMessage({ method: n.method, params: n.params });
    });

    this.agent?.onError((message) => {
      logger.appendLine(`[error] ${message}`);
      void webview.postMessage({
        method: "error",
        params: { session: this.sessionId, message },
      });
    });
  }

  private restartAgent(): void {
    this.disposeAgent();
    this.sessionId = makeSessionId();
  }

  private disposeAgent(): void {
    this.agent?.dispose();
    this.agent = null;
  }

  private postConfig(webview: Webview): void {
    const options = this.buildOptions();
    const config: WebviewConfigSnapshot = {
      model: options.model,
      baseUrl: options.baseUrl ?? "",
      demoMode: Boolean(options.demoMode),
      hasApiKey: Boolean(options.apiKey),
    };
    void webview.postMessage({ type: "config", config });
  }

  private buildHtml(webview: Webview): string {
    const nonce = getNonce();
    const stylesUri = webview.asWebviewUri(
      Uri.joinPath(this.htmlBasePath, "styles.css"),
    );
    const scriptUri = webview.asWebviewUri(
      Uri.joinPath(this.htmlBasePath, "main.js"),
    );
    const template = readFileSync(
      Uri.joinPath(this.htmlBasePath, "index.html").fsPath,
      "utf-8",
    );

    return template
      .replaceAll("${nonce}", nonce)
      .replaceAll("${cspSource}", webview.cspSource)
      .replaceAll("${stylesUri}", String(stylesUri))
      .replaceAll("${scriptUri}", String(scriptUri));
  }
}

function getNonce(): string {
  return randomBytes(16).toString("base64");
}

function makeSessionId(): string {
  return `vscode-${Date.now()}`;
}
