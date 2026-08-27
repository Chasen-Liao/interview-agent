import { existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

export interface PythonLookupInput {
  configuredPath: string;
  workspacePath?: string;
  vscodePythonPath?: string;
  requireOpenAI: boolean;
  existsPath?: (path: string) => boolean;
  runProbe?: (pythonPath: string, code: string) => ProbeResult;
}

export interface PythonLookupResult {
  pythonPath: string;
  diagnostics: string[];
  error?: string;
}

const DEFAULT_PYTHON = "python";
const REQUIREMENTS_ERROR = [
  "未找到已安装 openai 依赖的 Python 环境。",
  "解决方法任选其一：",
  "1. 在设置 interview.pythonPath 里填写目标项目 venv 的 python 完整路径",
  "2. 用当前解释器执行：pip install openai",
  "3. 勾选 Demo Mode 体验完整流程（不需要 API 和依赖）",
].join("\n");

let cacheKey = "";
let cacheResult: PythonLookupResult | null = null;

export interface ProbeResult {
  ok: boolean;
  reason?: string;
}

export function locatePython(input: PythonLookupInput): PythonLookupResult {
  const key = JSON.stringify(input);
  const canCache = !input.existsPath && !input.runProbe;
  if (canCache && cacheResult && cacheKey === key) {
    return cacheResult;
  }

  const candidates = buildCandidates(input);
  const diagnostics: string[] = [];
  const probeCode = input.requireOpenAI ? "import openai" : "import sys";
  const existsPath = input.existsPath ?? existsSync;
  const runProbe = input.runProbe ?? runPythonProbe;

  for (const candidate of candidates) {
    if (!isRunnableCandidate(candidate, existsPath)) {
      diagnostics.push(`[python] 跳过不存在的解释器：${candidate}`);
      continue;
    }

    const probe = runProbe(candidate, probeCode);
    if (probe.ok) {
      const result = {
        pythonPath: candidate,
        diagnostics: [
          ...diagnostics,
          `[python] 实际使用的解释器：${candidate}`,
        ],
      };
      if (canCache) {
        cacheKey = key;
        cacheResult = result;
      }
      return result;
    }

    diagnostics.push(`[python] ${candidate} 预检失败：${probe.reason || "预检失败"}`);
  }

  const result = {
    pythonPath: candidates[0] || DEFAULT_PYTHON,
    diagnostics,
    error: input.requireOpenAI ? REQUIREMENTS_ERROR : "未找到可启动的 Python 解释器。",
  };
  if (canCache) {
    cacheKey = key;
    cacheResult = result;
  }
  return result;
}

export function buildCandidates(input: PythonLookupInput): string[] {
  const candidates: string[] = [];
  const configured = input.configuredPath.trim() || DEFAULT_PYTHON;

  if (configured !== DEFAULT_PYTHON) {
    candidates.push(configured);
  }
  if (input.workspacePath) {
    candidates.push(
      join(input.workspacePath, ".venv", "Scripts", "python.exe"),
      join(input.workspacePath, ".venv", "bin", "python"),
    );
  }
  if (input.vscodePythonPath?.trim()) {
    candidates.push(input.vscodePythonPath.trim());
  }
  candidates.push(configured);

  return Array.from(new Set(candidates));
}

function isRunnableCandidate(
  candidate: string,
  existsPath: (path: string) => boolean,
): boolean {
  if (!candidate.includes("\\") && !candidate.includes("/")) {
    return true;
  }
  return existsPath(candidate);
}

function runPythonProbe(pythonPath: string, code: string): ProbeResult {
  const probe = spawnSync(pythonPath, ["-c", code], {
    encoding: "utf-8",
    timeout: 5000,
    windowsHide: true,
  });
  if (probe.status === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: (probe.stderr || probe.error?.message || "预检失败").trim(),
  };
}
