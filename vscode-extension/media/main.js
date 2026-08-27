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
  const sendBtn = document.getElementById("send");
  const stopBtn = document.getElementById("stop");
  const providerEl = document.getElementById("provider");
  const modelEl = document.getElementById("model");
  const baseUrlEl = document.getElementById("baseUrl");
  const apiKeyEl = document.getElementById("apiKey");
  const demoModeEl = document.getElementById("demoMode");
  const saveConfigBtn = document.getElementById("saveConfig");
  const settingsBtn = document.getElementById("settings");
  const configStatusEl = document.getElementById("configStatus");
  const jdEl = document.getElementById("jd");
  const backgroundEl = document.getElementById("background");
  const startInterviewBtn = document.getElementById("startInterview");
  const setupEl = document.getElementById("setup");

  let currentInterviewerBubble = null;
  let awaiting = false;
  let pendingAfterConfig = null;
  let interviewStarted = false;

  function setAwaiting(value) {
    awaiting = value;
    sendBtn.disabled = value;
    stopBtn.disabled = !value;
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

    const background = backgroundEl.value.trim();
    const text = [
      "我们开始一场技术面试。",
      "",
      `岗位 JD：\n${jd}`,
      background ? `\n简历 / 项目背景：\n${background}` : "",
      "\n请基于岗位 JD 和当前 VS Code 工作区项目，先了解项目结构，再开始第一轮面试提问。",
    ].join("\n");

    saveConfig(() => {
      interviewStarted = true;
      setupEl.classList.add("is-collapsed");
      sendChat(text, "已提交岗位 JD 和项目背景，开始面试。");
    });
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
    if (msg.type === "prefill") {
      inputEl.value = msg.text || "";
      inputEl.focus();
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
  startInterviewBtn.addEventListener("click", startInterview);
  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "stop" });
    setAwaiting(false);
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  vscode.postMessage({ type: "ready" });
  if (!interviewStarted) {
    jdEl.focus();
  }
})();
