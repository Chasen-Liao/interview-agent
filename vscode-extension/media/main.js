// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const providers = {
    openai: { model: "gpt-4o-mini", baseUrl: "" },
    deepseek: { model: "deepseek-chat", baseUrl: "https://api.deepseek.com" },
    qwen: {
      model: "qwen-plus",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
    zhipu: {
      model: "glm-4-flash",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    },
    custom: { model: "", baseUrl: "" },
  };

  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const actionBtn = document.getElementById("action");
  const providerEl = document.getElementById("provider");
  const modelEl = document.getElementById("model");
  const baseUrlEl = document.getElementById("baseUrl");
  const apiKeyEl = document.getElementById("apiKey");
  const demoModeEl = document.getElementById("demoMode");
  const saveConfigBtn = document.getElementById("saveConfig");
  const settingsBtn = document.getElementById("settings");
  const configStatusEl = document.getElementById("configStatus");
  const jdEl = document.getElementById("jd");
  const resumeSupplementEl = document.getElementById("resumeSupplement");
  const pickResumeBtn = document.getElementById("pickResume");
  const resumeFileEl = document.getElementById("resumeFile");
  const workspaceInfoEl = document.getElementById("workspaceInfo");
  const startInterviewBtn = document.getElementById("startInterview");
  const setupEl = document.getElementById("setup");

  let currentInterviewerBubble = null;
  let awaiting = false;
  let pendingAfterConfig = null;
  let interviewStarted = false;
  let resumeAttachment = null;
  let workspaceState = { hasWorkspace: false, workspaceName: "", workspacePath: "" };

  function setAwaiting(value) {
    awaiting = value;
    updateActionButton();
  }

  function updateActionButton() {
    if (awaiting) {
      actionBtn.textContent = "■";
      actionBtn.title = "停止";
      actionBtn.setAttribute("aria-label", "停止");
      actionBtn.disabled = false;
      actionBtn.classList.add("is-stop");
      return;
    }
    actionBtn.textContent = "↑";
    actionBtn.title = "发送";
    actionBtn.setAttribute("aria-label", "发送");
    actionBtn.disabled = !inputEl.value.trim();
    actionBtn.classList.remove("is-stop");
  }

  function collectConfig() {
    const config = {
      model: modelEl.value.trim(),
      baseUrl: baseUrlEl.value.trim(),
      demoMode: demoModeEl.checked,
    };
    const apiKey = apiKeyEl.value.trim();
    if (apiKey) {
      config.apiKey = apiKey;
    }
    return config;
  }

  function saveConfig(afterSave) {
    pendingAfterConfig = afterSave || null;
    vscode.postMessage({ type: "updateConfig", config: collectConfig() });
    setStatus("保存中...");
  }

  function startInterview() {
    const jd = jdEl.value.trim();
    if (!jd) {
      appendBubble("error", "出错了", "请先填写岗位 JD。");
      return;
    }
    if (!workspaceState.hasWorkspace) {
      appendBubble("error", "出错了", "请先打开要面试的目标项目文件夹。");
      return;
    }

    const resumeSupplement = resumeSupplementEl.value.trim();
    const resumeParts = [];
    if (resumeAttachment) {
      resumeParts.push(
        `简历附件：${resumeAttachment.fileName}\n${resumeAttachment.content}`,
      );
    }
    if (resumeSupplement) {
      resumeParts.push(`简历补充：\n${resumeSupplement}`);
    }

    const text = [
      "我们开始一场技术面试。",
      "",
      `岗位 JD：\n${jd}`,
      resumeParts.length ? `\n简历：\n${resumeParts.join("\n\n")}` : "",
      `\n当前项目：${workspaceState.workspaceName || "未命名工作区"}`,
      `项目路径：${workspaceState.workspacePath}`,
      "请自动读取当前 VS Code 工作区下的项目情况，先了解项目结构和技术栈，再开始第一轮面试提问。",
    ].join("\n");

    saveConfig(() => {
      interviewStarted = true;
      setupEl.classList.add("is-collapsed");
      sendChat(text, "已提交岗位 JD 和简历，开始面试。");
    });
  }

  function onAction() {
    if (awaiting) {
      vscode.postMessage({ type: "stop" });
      setAwaiting(false);
      return;
    }
    send();
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text || awaiting) {
      return;
    }
    saveConfig(() => sendChat(text, text));
  }

  function sendChat(text, displayText) {
    appendBubble("user", "我", displayText);
    inputEl.value = "";
    setAwaiting(true);
    vscode.postMessage({ type: "chat", text });
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg) {
      return;
    }

    if (msg.type === "config") {
      applyConfig(msg.config);
      return;
    }
    if (msg.type === "configSaved") {
      apiKeyEl.value = "";
      setStatus("已保存");
      const next = pendingAfterConfig;
      pendingAfterConfig = null;
      if (next) {
        next();
      }
      return;
    }
    if (msg.type === "resumePicked") {
      resumeAttachment = msg.resume;
      resumeFileEl.textContent = msg.resume.truncated
        ? `${msg.resume.fileName}（已截取前 80000 字）`
        : msg.resume.fileName;
      return;
    }
    if (msg.type === "resumeError") {
      appendBubble("error", "出错了", msg.message || "读取简历失败");
      return;
    }
    if (msg.type === "prefill") {
      inputEl.value = msg.text || "";
      inputEl.focus();
      updateActionButton();
      return;
    }
    if (typeof msg.method !== "string") {
      return;
    }

    switch (msg.method) {
      case "stream":
        onStream(msg.params);
        break;
      case "tool_call":
        onToolCall(msg.params);
        break;
      case "done":
        onDone();
        break;
      case "error":
        onError(msg.params);
        break;
    }
  });

  function applyConfig(config) {
    modelEl.value = config.model || "gpt-4o-mini";
    baseUrlEl.value = config.baseUrl || "";
    demoModeEl.checked = Boolean(config.demoMode);
    apiKeyEl.placeholder = config.hasApiKey ? "已配置" : "";
    providerEl.value = inferProvider(modelEl.value, baseUrlEl.value);
    workspaceState = {
      hasWorkspace: Boolean(config.hasWorkspace),
      workspaceName: config.workspaceName || "",
      workspacePath: config.workspacePath || "",
    };
    workspaceInfoEl.textContent = workspaceState.hasWorkspace
      ? `自动读取：${workspaceState.workspaceName || workspaceState.workspacePath}`
      : "未打开目标项目文件夹";
    workspaceInfoEl.title = workspaceState.workspacePath || "";
  }

  function inferProvider(model, baseUrl) {
    for (const [key, value] of Object.entries(providers)) {
      if (key !== "custom" && value.model === model && value.baseUrl === baseUrl) {
        return key;
      }
    }
    return "custom";
  }

  function onStream(params) {
    if (!currentInterviewerBubble) {
      currentInterviewerBubble = appendBubble("interviewer", "面试官", "");
      currentInterviewerBubble.classList.add("cursor");
    }
    const body = currentInterviewerBubble.querySelector(".bubble__body");
    body.textContent += params.delta || "";
    scrollToBottom();
  }

  function onToolCall(params) {
    const { tool, phase, args, result } = params;
    if (phase === "start") {
      const bubble = appendBubble("tool", tool, formatArgs(args));
      bubble.classList.add("is-running");
      bubble.dataset.toolId = tool;
      currentInterviewerBubble = null;
    } else {
      const candidates = Array.from(
        messagesEl.querySelectorAll(".bubble--tool.is-running"),
      ).filter((el) => el.dataset.toolId === tool);
      const last = candidates[candidates.length - 1];
      if (last) {
        last.classList.remove("is-running");
        last.querySelector(".bubble__title").textContent = `${tool} 完成`;
        if (result) {
          const resultEl = document.createElement("div");
          resultEl.className = "bubble__result";
          resultEl.textContent = result;
          last.appendChild(resultEl);
        }
      }
    }
    scrollToBottom();
  }

  function onDone() {
    if (currentInterviewerBubble) {
      currentInterviewerBubble.classList.remove("cursor");
      currentInterviewerBubble = null;
    }
    setAwaiting(false);
    inputEl.focus();
  }

  function onError(params) {
    appendBubble("error", "出错了", params.message || "未知错误");
    if (currentInterviewerBubble) {
      currentInterviewerBubble.classList.remove("cursor");
      currentInterviewerBubble = null;
    }
    setAwaiting(false);
  }

  function appendBubble(kind, title, body) {
    const bubble = document.createElement("div");
    bubble.className = `bubble bubble--${kind}`;

    const roleEl = document.createElement("div");
    roleEl.className = "bubble__role bubble__title";
    roleEl.textContent = title;
    bubble.appendChild(roleEl);

    const bodyEl = document.createElement("div");
    bodyEl.className = "bubble__body";
    bodyEl.textContent = body || "";
    bubble.appendChild(bodyEl);

    messagesEl.appendChild(bubble);
    scrollToBottom();
    return bubble;
  }

  function formatArgs(args) {
    if (!args) {
      return "";
    }
    try {
      return JSON.stringify(args);
    } catch {
      return String(args);
    }
  }

  function setStatus(text) {
    configStatusEl.textContent = text;
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  providerEl.addEventListener("change", () => {
    const preset = providers[providerEl.value];
    if (preset && providerEl.value !== "custom") {
      modelEl.value = preset.model;
      baseUrlEl.value = preset.baseUrl;
    }
  });

  modelEl.addEventListener("input", () => {
    providerEl.value = inferProvider(modelEl.value.trim(), baseUrlEl.value.trim());
  });

  baseUrlEl.addEventListener("input", () => {
    providerEl.value = inferProvider(modelEl.value.trim(), baseUrlEl.value.trim());
  });

  saveConfigBtn.addEventListener("click", () => saveConfig());
  settingsBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "openSettings" });
  });
  pickResumeBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "pickResume" });
  });
  startInterviewBtn.addEventListener("click", startInterview);
  actionBtn.addEventListener("click", onAction);

  inputEl.addEventListener("input", updateActionButton);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  vscode.postMessage({ type: "ready" });
  updateActionButton();
  if (!interviewStarted) {
    jdEl.focus();
  }
})();
