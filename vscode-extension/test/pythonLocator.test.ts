import { describe, expect, it } from "vitest";
import { buildCandidates, locatePython } from "../src/pythonLocator";

describe("pythonLocator", () => {
  it("候选顺序优先使用显式配置，其次工作区 venv，再到 VS Code Python 设置", () => {
    const candidates = buildCandidates({
      configuredPath: "C:\\custom\\python.exe",
      workspacePath: "D:\\project\\demo",
      vscodePythonPath: "C:\\vscode\\python.exe",
      requireOpenAI: true,
    });

    expect(candidates[0]).toBe("C:\\custom\\python.exe");
    expect(candidates).toContain("D:\\project\\demo\\.venv\\Scripts\\python.exe");
    expect(candidates).toContain("C:\\vscode\\python.exe");
  });

  it("默认 python 不是显式配置时，工作区 venv 优先于系统 python", () => {
    const candidates = buildCandidates({
      configuredPath: "python",
      workspacePath: "D:\\project\\demo",
      requireOpenAI: true,
    });

    expect(candidates[0]).toBe("D:\\project\\demo\\.venv\\Scripts\\python.exe");
    expect(candidates[candidates.length - 1]).toBe("python");
  });

  it("选择第一个 openai 预检通过的解释器", () => {
    const result = locatePython({
      configuredPath: "python",
      workspacePath: "D:\\project\\demo",
      requireOpenAI: true,
      existsPath: () => true,
      runProbe: (pythonPath) => ({
        ok: pythonPath.endsWith(".venv\\Scripts\\python.exe"),
        reason: "No module named openai",
      }),
    });

    expect(result.pythonPath).toBe("D:\\project\\demo\\.venv\\Scripts\\python.exe");
    expect(result.error).toBeUndefined();
  });

  it("所有候选失败时返回可操作的 openai 依赖提示", () => {
    const result = locatePython({
      configuredPath: "python",
      workspacePath: "D:\\project\\demo",
      requireOpenAI: true,
      existsPath: () => true,
      runProbe: () => ({ ok: false, reason: "No module named openai" }),
    });

    expect(result.error).toContain("未找到已安装 openai 依赖");
    expect(result.error).toContain("interview.pythonPath");
    expect(result.error).toContain("Demo Mode");
  });
});
