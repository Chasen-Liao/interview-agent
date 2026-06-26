/**
 * 插件激活入口（设计第 5、6 节）。
 *
 * 注册 interview.start / interview.askAboutSelection 命令：
 * - interview.start：打开面试面板，spawn Python，接通双向通信
 * - interview.askAboutSelection：对当前选中代码发起提问（设计第 5.3.3 节）
 *
 * 配置读取：apiKey / model / baseUrl / resume / pythonPath（命名空间 interview.*）。
 */

import * as path from "path";
import {
  commands,
  ConfigurationTarget,
  ExtensionContext,
  Uri,
  window,
  workspace,
} from "vscode";
import { InterviewPanel } from "./webviewPanel";

/** interview.* 配置的强类型读取。 */
interface InterviewConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  resume: string;
  pythonPath: string;
}

function readConfig(): InterviewConfig {
  const cfg = workspace.getConfiguration("interview");
  return {
    apiKey: cfg.get<string>("apiKey", ""),
    model: cfg.get<string>("model", "gpt-4o-mini"),
    baseUrl: cfg.get<string>("baseUrl", ""),
    resume: cfg.get<string>("resume", ""),
    pythonPath: cfg.get<string>("pythonPath", "python"),
  };
}

export function activate(context: ExtensionContext): void {
  const htmlBasePath = Uri.joinPath(context.extensionUri, "media");

  // ───────── interview.start ─────────
  const startCmd = commands.registerCommand("interview.start", async () => {
    const cfg = readConfig();
    if (!cfg.apiKey) {
      const choice = await window.showErrorMessage(
        "还未配置 API Key。请在设置里填写 interview.apiKey。",
        "打开设置",
      );
      if (choice === "打开设置") {
        commands.executeCommand("workbench.action.openSettings", "interview.apiKey");
      }
      return;
    }

    const workspaceFolder = workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) {
      window.showErrorMessage("请先打开一个项目文件夹（面试官需要知道你的项目在哪）。");
      return;
    }

    const scriptPath = path.join(workspaceFolder, "agent", "main.py");

    const panel = new InterviewPanel(htmlBasePath, {
      pythonPath: cfg.pythonPath,
      scriptPath,
      workspace: workspaceFolder,
      apiKey: cfg.apiKey,
      model: cfg.model,
      baseUrl: cfg.baseUrl || undefined,
      resume: cfg.resume || undefined,
    });
    panel.open();
  });

  // ───────── interview.askAboutSelection ─────────
  // 对选中代码提问：填入输入框后自动发送（复用 start 打开的面板逻辑）
  const askCmd = commands.registerCommand(
    "interview.askAboutSelection",
    async () => {
      // MVP：等同于 start（选中代码由 Webview 读取时自动注入）
      // 完整版应在面板输入框预填"针对这段代码："，这里先走 start
      commands.executeCommand("interview.start");
    },
  );

  context.subscriptions.push(startCmd, askCmd);
}

export function deactivate(): void {
  // Webview 关闭时 InterviewPanel 自己 dispose AgentClient，无需额外清理
}

// 配置变更类型导出（供未来热重载用）
export type { ConfigurationTarget };
