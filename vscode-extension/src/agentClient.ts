/**
 * Python 子进程管理（设计第 1.4、1.5、1.7 节）。
 *
 * Extension Host 通过 child_process.spawn 启动 Python 内核，
 * 用 stdio（一行一条 JSON）双向通信。
 *
 * 职责（设计第 5.5 节：Extension Host 是纯转发器）：
 * - send：把 Request 序列化写进 stdin
 * - onNotification：按行读 stdout，解析后回调
 * - 生命周期：进程退出/出错时通知上层，不崩 Extension Host
 */

import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { buildInit, parse, ParsedNotification, Request } from "./protocol";

/** 启动 AgentClient 需要的配置。 */
export interface AgentClientOptions {
  /** Python 解释器路径，如 "python" 或 "python3"。 */
  pythonPath: string;
  /** agent/main.py 的绝对路径。 */
  scriptPath: string;
  /** 学生项目根目录（作为 workspace 传给 Python）。 */
  workspace: string;
  /** OpenAI 兼容 API Key。 */
  apiKey: string;
  /** 模型名。 */
  model: string;
  /** OpenAI 兼容 base URL（留空用官方）。 */
  baseUrl?: string;
  /** 简历摘要（可选）。 */
  resume?: string;
  /** 会话 id（init 时带上，便于 Python 落盘隔离）。 */
  session?: string;
}

/** 进程级错误的回调签名。 */
export type ErrorCallback = (message: string) => void;

export class AgentClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private notificationCallbacks: Array<(n: ParsedNotification) => void> = [];
  private errorCallbacks: Array<ErrorCallback> = [];
  // stdout 可能把一条消息分多次 data 事件投递，需按换行符分帧缓冲
  private stdoutBuffer = "";
  private readonly options: AgentClientOptions;
  private started = false;

  constructor(options: AgentClientOptions) {
    this.options = options;
  }

  /** 启动 Python 子进程并自动发送 init 消息。 */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    // -u：无缓冲，确保流式通知实时推出（设计第 1.6 节缓冲区陷阱）
    this.proc = spawn(
      this.options.pythonPath,
      ["-u", this.options.scriptPath],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    this.wireStdout();
    this.wireStderr();
    this.wireExit();

    // 启动后立即发 init（设计第 1.5.3 节时序：init 是第一条消息）
    this.send(buildInit({
      workspace: this.options.workspace,
      api_key: this.options.apiKey,
      model: this.options.model,
      base_url: this.options.baseUrl,
      resume: this.options.resume,
      session: this.options.session,
    }));
  }

  /** 发送一条 Request 到 Python stdin。 */
  send(msg: Request): void {
    if (!this.proc || !this.proc.stdin.writable) {
      this.emitError("Python 子进程未就绪或已退出");
      return;
    }
    const line = serializeLine(msg);
    this.proc.stdin.write(line);
  }

  /** 注册通知回调（Python → TS 方向）。 */
  onNotification(cb: (n: ParsedNotification) => void): void {
    this.notificationCallbacks.push(cb);
  }

  /** 注册错误回调（进程崩溃、stderr 等）。 */
  onError(cb: ErrorCallback): void {
    this.errorCallbacks.push(cb);
  }

  /** 终止 Python 子进程。 */
  dispose(): void {
    if (!this.proc) {
      return;
    }
    // 优雅关闭：先关 stdin 让 Python 主循环自然退出，再 kill 兜底
    try {
      this.proc.stdin.end();
    } catch {
      // ignore
    }
    this.proc.kill();
    this.proc = null;
    this.started = false;
  }

  // ──────────────────────────────────────────────
  // 内部：stdout 分帧 + 派发
  // ──────────────────────────────────────────────

  private wireStdout(): void {
    if (!this.proc) {
      return;
    }
    this.proc.stdout.setEncoding("utf-8");
    this.proc.stdout.on("data", (chunk: string) => {
      // 按换行符分帧：一行 = 一条消息（用纯函数 extractLines 处理）
      this.stdoutBuffer += chunk;
      const { lines, rest } = extractLines(this.stdoutBuffer);
      this.stdoutBuffer = rest;
      for (const line of lines) {
        this.dispatchLine(line);
      }
    });
  }

  private dispatchLine(line: string): void {
    const notification = parse(line);
    if (notification === null) {
      // 脏数据静默跳过（对应 Python 的容错策略，不崩）
      return;
    }
    for (const cb of this.notificationCallbacks) {
      cb(notification);
    }
  }

  private wireStderr(): void {
    if (!this.proc) {
      return;
    }
    this.proc.stderr.setEncoding("utf-8");
    this.proc.stderr.on("data", (chunk: string) => {
      // Python 的 traceback 走 stderr，转成错误回调（设计第 6.4.1 节）
      // 但不崩，只是上报
      this.emitError(`Python stderr: ${chunk.trim()}`);
    });
  }

  private wireExit(): void {
    if (!this.proc) {
      return;
    }
    this.proc.on("exit", (code, signal) => {
      if (code !== 0 && code !== null) {
        this.emitError(
          `Python 子进程退出，退出码 ${code}（信号 ${signal ?? "无"}）`,
        );
      }
      this.proc = null;
    });
    this.proc.on("error", (err) => {
      // spawn 失败（如 python 不在 PATH）走这里
      this.emitError(`无法启动 Python 子进程：${err.message}`);
    });
  }

  private emitError(message: string): void {
    for (const cb of this.errorCallbacks) {
      cb(message);
    }
  }
}

// ──────────────────────────────────────────────
// 序列化辅助（独立成函数，便于单测）
// ──────────────────────────────────────────────

/** 把 Request 序列化成一行 JSON（含换行）。 */
export function serializeLine(msg: Request): string {
  return JSON.stringify(msg) + "\n";
}

/**
 * 从 stdout 缓冲区提取完整的行（分帧核心）。
 *
 * stdout 的 data 事件可能把一条消息拆成多段投递，也可能一次投多条。
 * 用换行符分帧：返回提取出的完整行列表 + 剩余的半行缓冲。
 *
 * 抽成纯函数便于单测（不依赖真实子进程）。
 *
 * @param buffer 当前缓冲区内容
 * @returns [完整行数组, 剩余缓冲区]
 */
export function extractLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buffer;
  let newlineIndex: number;
  while ((newlineIndex = rest.indexOf("\n")) >= 0) {
    lines.push(rest.slice(0, newlineIndex));
    rest = rest.slice(newlineIndex + 1);
  }
  return { lines, rest };
}
