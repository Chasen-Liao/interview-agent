/**
 * Webview 面试视图管理。
 *
 * Extension Host 只做三件事：
 * - 把 Webview 的聊天消息转成 Python Agent 请求
 * - 把 Python Agent 通知转发给 Webview
 * - 读取/保存模型配置并在必要时重启 Python 子进程
 */

import { randomBytes } from "crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import { basename, extname, join } from "path";
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
import { locatePython } from "./pythonLocator";

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
  vscodePythonPath?: string;
  scriptPath: string;
  /** 被面试的项目根（工具翻代码的根）。 */
  workspace: string;
  workspaceName: string;
  hasWorkspace: boolean;
  /** agent 包所在根（PYTHONPATH 用），通常 = bundled-agent 根。 */
  pythonPathRoot: string;
  /** 打包进插件的 Python 依赖清单。 */
  requirementsPath: string;
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
  workspaceName: string;
  workspacePath: string;
  hasWorkspace: boolean;
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
  | { type: "pickResume" }
  | { type: "installDependencies" }
  | { type: "checkDependencies" }
  | { type: "listSessions" }
  | { type: "newSession" }
  | { type: "resumeSession"; session: string }
  | { type: "deleteSession"; session: string }
  | { type: "openSettings" }
  | { type: "updateConfig"; config: WebviewConfigUpdate };

export interface ResumeParseResult {
  fileName: string;
  content: string;
  truncated: boolean;
}

interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  preview: string;
}

interface DisplayMessage {
  role: "user" | "assistant";
  content: string;
}

const RESUME_MAX_CHARS = 80_000;

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
    this.postSessions(webviewView.webview);

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
      if (msg.type === "pickResume") {
        void this.pickResume(webview);
        return;
      }
      if (msg.type === "installDependencies") {
        this.installDependencies(webview);
        return;
      }
      if (msg.type === "checkDependencies") {
        this.checkDependencies(webview);
        return;
      }
      if (msg.type === "listSessions") {
        this.postSessions(webview);
        return;
      }
      if (msg.type === "newSession") {
        this.newSession(webview);
        return;
      }
      if (msg.type === "resumeSession") {
        this.resumeSession(webview, msg.session);
        return;
      }
      if (msg.type === "deleteSession") {
        this.deleteSession(webview, msg.session);
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

  /** 通过 VS Code 文件选择器读取简历附件。 */
  private async pickResume(webview: Webview): Promise<void> {
    const selected = await window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        "简历文件": ["pdf", "docx", "txt", "md", "markdown"],
      },
      title: "选择简历文件",
    });
    const file = selected?.[0];
    if (!file) {
      return;
    }

    try {
      void webview.postMessage({ type: "resumeStatus", message: "正在读取简历..." });
      const options = this.buildOptions();
      const pythonLookup = locatePython({
        configuredPath: options.pythonPath,
        workspacePath: options.workspace,
        vscodePythonPath: options.vscodePythonPath,
        requireOpenAI: false,
      });
      const resume = await parseResumeFile(file.fsPath, {
        ocr: (pdfPath) => runResumeOcr({
          filePath: pdfPath,
          pythonPath: pythonLookup.pythonPath,
          scriptPath: join(options.pythonPathRoot, "agent", "resume_ocr.py"),
          pythonPathRoot: options.pythonPathRoot,
        }),
        onStatus: (message) => {
          void webview.postMessage({ type: "resumeStatus", message });
        },
      });
      void webview.postMessage({
        type: "resumePicked",
        resume,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      void webview.postMessage({
        type: "resumeError",
        message: `读取简历失败：${message}`,
      });
    }
  }

  /** 在 VS Code Terminal 中显式安装 Agent 依赖。 */
  private installDependencies(webview: Webview): void {
    const options = this.buildOptions();
    const pythonLookup = locatePython({
      configuredPath: options.pythonPath,
      workspacePath: options.workspace,
      vscodePythonPath: options.vscodePythonPath,
      requireOpenAI: false,
    });
    const command = buildInstallCommand(pythonLookup.pythonPath, options.requirementsPath);
    const logger = getDebugChannel();
    logger.appendLine(`[deps] ${command}`);
    const terminal = window.createTerminal("Interview Agent 依赖安装");
    terminal.show();
    terminal.sendText(command);
    void webview.postMessage({
      type: "dependencyStatus",
      message: "已在 Terminal 启动依赖安装。安装完成后点击重新检测或重新开始面试。",
      command,
      canInstall: true,
    });
  }

  /** 重新检测真实模式运行依赖。 */
  private checkDependencies(webview: Webview): void {
    const options = this.buildOptions();
    const pythonLookup = locatePython({
      configuredPath: options.pythonPath,
      workspacePath: options.workspace,
      vscodePythonPath: options.vscodePythonPath,
      requireOpenAI: !options.demoMode,
    });
    if (pythonLookup.error) {
      this.postDependencyError(webview, pythonLookup.error, pythonLookup.pythonPath);
      return;
    }
    void webview.postMessage({
      type: "dependencyStatus",
      message: "",
      canInstall: false,
    });
  }

  /** 读取目标工作区本地历史会话并发给 Webview。 */
  private postSessions(webview: Webview): void {
    const options = this.buildOptions();
    void webview.postMessage({
      type: "sessions",
      sessions: listSessionSummaries(options.workspace),
      current: this.sessionId,
    });
  }

  private newSession(webview: Webview): void {
    this.restartAgent();
    void webview.postMessage({ type: "sessionNew", session: this.sessionId });
    this.postSessions(webview);
  }

  private resumeSession(webview: Webview, session: string): void {
    const options = this.buildOptions();
    const loaded = loadSessionMessages(options.workspace, session);
    this.disposeAgent();
    this.sessionId = session;
    void webview.postMessage({
      type: "sessionLoaded",
      session,
      messages: loaded,
    });
    this.postSessions(webview);
  }

  private deleteSession(webview: Webview, session: string): void {
    const options = this.buildOptions();
    deleteSessionFile(options.workspace, session);
    if (session === this.sessionId) {
      this.restartAgent();
      void webview.postMessage({ type: "sessionNew", session: this.sessionId });
    }
    this.postSessions(webview);
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
    if (!options.hasWorkspace || !options.workspace) {
      void webview.postMessage({
        method: "error",
        params: {
          session: this.sessionId,
          message: "请先打开要面试的目标项目文件夹，再开始面试。",
        },
      });
      return false;
    }

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

    if (!options.model.trim()) {
      void webview.postMessage({
        method: "error",
        params: {
          session: this.sessionId,
          message: "还未配置模型名。请填写 interview.model 后再开始面试。",
        },
      });
      return false;
    }

    const pythonLookup = locatePython({
      configuredPath: options.pythonPath,
      workspacePath: options.workspace,
      vscodePythonPath: options.vscodePythonPath,
      requireOpenAI: !options.demoMode,
    });

    const logger = getDebugChannel();
    for (const line of pythonLookup.diagnostics) {
      logger.appendLine(line);
    }
    logger.appendLine(
      `[llm] ${options.demoMode ? "Demo Mode（固定脚本）" : "真实模型"} model=${options.model} baseUrl=${options.baseUrl || "OpenAI 默认"}`,
    );
    if (!options.demoMode && pythonLookup.error) {
      this.postDependencyError(webview, pythonLookup.error, pythonLookup.pythonPath);
      return false;
    }
    void webview.postMessage({
      type: "dependencyStatus",
      message: "",
      canInstall: false,
    });

    this.agent = new AgentClient({
      pythonPath: pythonLookup.pythonPath,
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
      if (n.method === "done" || n.method === "cancelled") {
        this.postSessions(webview);
      }
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
      workspaceName: options.workspaceName,
      workspacePath: options.workspace,
      hasWorkspace: options.hasWorkspace,
    };
    void webview.postMessage({ type: "config", config });
  }

  private postDependencyError(
    webview: Webview,
    message: string,
    pythonPath?: string,
  ): void {
    const options = this.buildOptions();
    const command = buildInstallCommand(
      pythonPath || options.pythonPath,
      options.requirementsPath,
    );
    void webview.postMessage({
      type: "dependencyStatus",
      message,
      command,
      canInstall: true,
    });
    void webview.postMessage({
      method: "error",
      params: { session: this.sessionId, message },
    });
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

interface ResumeParseOptions {
  onStatus?: (message: string) => void;
  ocr?: (filePath: string) => Promise<string>;
  pdfText?: (filePath: string) => Promise<string>;
}

interface ResumeOcrInput {
  filePath: string;
  pythonPath: string;
  scriptPath: string;
  pythonPathRoot: string;
}

/** 读取并解析简历附件，返回可注入首轮上下文的纯文本。 */
export async function parseResumeFile(
  filePath: string,
  options: ResumeParseOptions = {},
): Promise<ResumeParseResult> {
  const ext = extname(filePath).toLowerCase();
  let raw = "";

  if ([".txt", ".md", ".markdown"].includes(ext)) {
    raw = readFileSync(filePath, "utf-8");
  } else if (ext === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    raw = result.value;
  } else if (ext === ".pdf") {
    if (options.pdfText) {
      raw = await options.pdfText(filePath);
    } else {
      const pdfParse = await importPdfParse();
      const result = await pdfParse(readFileSync(filePath));
      raw = result.text;
    }
    if (!raw.trim() && options.ocr) {
      options.onStatus?.("正在识别扫描版 PDF...");
      raw = await options.ocr(filePath);
    }
  } else {
    throw new Error("当前只支持 .pdf、.docx、.txt、.md、.markdown 简历。");
  }

  const normalized = raw.trim();
  if (!normalized) {
    throw new Error("未从简历附件中提取到文字内容。扫描版 PDF 请改用文本粘贴。");
  }

  return {
    fileName: basename(filePath),
    content: normalized.slice(0, RESUME_MAX_CHARS),
    truncated: normalized.length > RESUME_MAX_CHARS,
  };
}

async function importPdfParse(): Promise<(data: Buffer) => Promise<{ text: string }>> {
  const mod = await import("pdf-parse/lib/pdf-parse.js");
  return (mod.default ?? mod) as unknown as (data: Buffer) => Promise<{ text: string }>;
}

export function buildInstallCommand(pythonPath: string, requirementsPath: string): string {
  if (process.platform === "win32") {
    return `& ${quotePowerShell(pythonPath)} -m pip install -r ${quotePowerShell(requirementsPath)}`;
  }
  return `${quoteShell(pythonPath)} -m pip install -r ${quoteShell(requirementsPath)}`;
}

function quotePowerShell(value: string): string {
  return `"${value.replaceAll('"', '`"')}"`;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runResumeOcr(input: ResumeOcrInput): Promise<string> {
  const { execFile } = await import("child_process");
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const existing = env.PYTHONPATH ?? "";
    env.PYTHONPATH = existing
      ? `${input.pythonPathRoot}${process.platform === "win32" ? ";" : ":"}${existing}`
      : input.pythonPathRoot;
    // OCR 结果含中文，强制 Python stdout 用 UTF-8（脚本内也有 reconfigure 兜底）
    env.PYTHONIOENCODING = "utf-8";

    execFile(
      input.pythonPath,
      [input.scriptPath, input.filePath],
      {
        encoding: "utf-8",
        env,
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(
            `OCR 识别失败。请先安装 Agent 依赖，或改用文本粘贴。${stderr ? `\n${stderr.trim()}` : ""}`,
          ));
          return;
        }
        const text = stdout.trim();
        if (!text) {
          reject(new Error("OCR 未识别到文字。请改用文本粘贴。"));
          return;
        }
        resolve(text);
      },
    );
  });
}

function sessionsDir(workspacePath: string): string {
  return join(workspacePath, ".sessions");
}

function safeSessionId(session: string): string {
  return Array.from(session).filter((c) => /[a-zA-Z0-9_-]/.test(c)).join("");
}

function sessionPath(workspacePath: string, session: string): string {
  return join(sessionsDir(workspacePath), `${safeSessionId(session)}.json`);
}

function listSessionSummaries(workspacePath: string): SessionSummary[] {
  if (!workspacePath) {
    return [];
  }
  const dir = sessionsDir(workspacePath);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readSessionSummary(dir, name))
    .filter((item): item is SessionSummary => Boolean(item))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function readSessionSummary(dir: string, fileName: string): SessionSummary | null {
  try {
    const path = join(dir, fileName);
    const messages = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(messages)) {
      return null;
    }
    const display = toDisplayMessages(messages);
    const last = display.at(-1);
    const stat = statSync(path);
    const id = fileName.slice(0, -".json".length);
    return {
      id,
      title: makeSessionTitle(display, id),
      updatedAt: stat.mtimeMs,
      messageCount: display.length,
      preview: (last?.content || "").slice(0, 80),
    };
  } catch {
    return null;
  }
}

function loadSessionMessages(workspacePath: string, session: string): DisplayMessage[] {
  try {
    const path = sessionPath(workspacePath, session);
    const messages = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(messages) ? toDisplayMessages(messages) : [];
  } catch {
    return [];
  }
}

function deleteSessionFile(workspacePath: string, session: string): void {
  if (!workspacePath) {
    return;
  }
  rmSync(sessionPath(workspacePath, session), { force: true });
}

function toDisplayMessages(messages: Array<Record<string, unknown>>): DisplayMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: String(message.content || ""),
    }))
    .filter((message) => message.content.trim());
}

export function makeSessionTitle(messages: DisplayMessage[], fallback: string): string {
  const firstUser = messages.find((message) => message.role === "user");
  const content = firstUser?.content.trim();
  if (!content) {
    return fallback;
  }
  // 首条消息是「开始面试」的组装文本，固定以「我们开始一场技术面试。」开头，
  // 直接取第一行会让所有会话同名。优先提取岗位 JD 的第一行，标题才有辨识度。
  const jdMatch = content.match(/岗位 JD：\r?\n(.+)/);
  const jdLine = jdMatch?.[1]?.trim();
  if (jdLine) {
    return jdLine.slice(0, 32);
  }
  const firstLine = content.split(/\r?\n/).find((line) => line.trim()) || content;
  return firstLine.slice(0, 32);
}

function getNonce(): string {
  return randomBytes(16).toString("base64");
}

function makeSessionId(): string {
  return `vscode-${Date.now()}`;
}
