/**
 * 跨语言端到端集成测试（设计第 5E 节里程碑② 的核心验证）。
 *
 * TS 的 AgentClient spawn 真实 Python 内核，验证跨语言协议闭环。
 * Python 侧用 FakeLLM 包装（注入），不花真实 API 费用。
 *
 * 这证明：TS 序列化的消息 Python 能解析、Python 的通知 TS 能解析，
 * 两端字段命名（snake_case）完全对齐、中文不丢失。
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { spawn } from "child_process";
import { extractLines } from "../src/agentClient";
import { buildChat, buildInit, parse, ParsedNotification } from "../src/protocol";
import { serializeLine } from "../src/agentClient";

const __repo_root = join(dirname(__dirname), "..");
const PYTHON = process.env.PYTHON || "python";

// Python 包装脚本：注入 FakeLLM 后跑真实 main 主循环
const PYTHON_WRAPPER = `
import sys, os
sys.path.insert(0, os.getcwd())
from agent.llm_client import FakeLLM, make_tool_call_response, make_text_response
import agent.session as session_mod
import agent.main as main_mod
_orig = session_mod.SessionStore.__init__
def _patched(self, llm_factory=None):
    fake = FakeLLM([
        make_tool_call_response('list_directory', {'path': '.'}),
        make_text_response('我用工具看了你的项目结构。用了什么技术栈？'),
    ])
    _orig(self, llm_factory=lambda: fake)
session_mod.SessionStore.__init__ = _patched
main_mod.main()
`;

const pythonAvailable = existsSync(join(__repo_root, "agent", "main.py"));

/**
 * 还原 VS Code 扩展进程的真实环境：开发机 shell 里常带 PYTHONUTF8 /
 * PYTHONIOENCODING / LANG（会让 Python 管道默认 UTF-8），但 VS Code 不继承它们。
 * 剥掉之后，中文 Windows 上 Python 管道默认 GBK —— 历史会话乱码的复现条件。
 */
function stripPythonUtf8Vars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  delete clean.PYTHONUTF8;
  delete clean.PYTHONIOENCODING;
  delete clean.LANG;
  delete clean.LC_ALL;
  return clean;
}

describe.skipIf(!pythonAvailable)(
  "跨语言端到端：TS AgentClient ↔ 真实 Python 内核",
  () => {
    it("init + chat → 收到 tool_call + stream + done（协议闭环）", async () => {
      const notifications: ParsedNotification[] = [];

      const proc = spawn(PYTHON, ["-c", PYTHON_WRAPPER], {
        cwd: __repo_root,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...stripPythonUtf8Vars(process.env),
          PYTHONPATH: __repo_root,
        },
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          proc.kill();
          reject(new Error("超时：Python 未在 10s 内回复 done"));
        }, 10000);

        let buf = "";
        proc.stdout.setEncoding("utf-8");
        proc.stdout.on("data", (chunk: string) => {
          buf += chunk;
          const { lines, rest } = extractLines(buf);
          buf = rest;
          for (const line of lines) {
            const n = parse(line);
            if (n) {
              notifications.push(n);
              if (n.method === "done") {
                clearTimeout(timer);
                resolve();
              }
            }
          }
        });
        proc.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        proc.on("exit", (code) => {
          if (notifications.length === 0) {
            clearTimeout(timer);
            reject(new Error(`Python 提前退出，code=${code}`));
          }
        });

        // 用 TS 侧的构造器 + 序列化发消息，验证与 Python 解析对齐
        proc.stdin.write(
          serializeLine(
            buildInit({
              workspace: __repo_root,
              api_key: "sk-fake",
              model: "gpt-4o-mini",
              session: "xlang-test",
            }),
          ),
        );
        proc.stdin.write(
          serializeLine(
            buildChat({ session: "xlang-test", text: "看看我的项目" }),
          ),
        );
      });

      const methods = notifications.map((n) =>
        n.method === "tool_call" ? `tool_call.${n.params.phase}` : n.method,
      );

      // 核心断言：跨语言协议闭环跑通，时序正确
      expect(methods).toContain("tool_call.start");
      expect(methods).toContain("tool_call.end");
      expect(methods).toContain("stream");
      expect(methods[methods.length - 1]).toBe("done");

      // stream 通知含中文回答（验证跨语言中文不丢失）
      const stream = notifications.find((n) => n.method === "stream");
      expect(stream?.params.delta).toContain("技术栈");

      // 中文输入经 stdin → Python → 落盘往返后不乱码。
      // 上面的 spawn 已剥掉 PYTHONUTF8 等变量：中文 Windows 上 Python 管道
      // 默认 GBK，若 main.py 没把 stdin reconfigure 成 UTF-8，
      // "看看我的项目" 会被解码成乱码写进 .sessions/*.json
      //（历史会话标题乱码的根因）。本断言直接守护该修复。
      const sessionFile = readFileSync(
        join(__repo_root, ".sessions", "xlang-test.json"),
        "utf-8",
      );
      expect(sessionFile).toContain("看看我的项目");

      proc.kill();
    }, 15000);
  },
);
