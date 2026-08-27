// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const actionBtn = document.getElementById("action");
  const settingsBtn = document.getElementById("settings");
  const historyToggleBtn = document.getElementById("historyToggle");
  const configStatusEl = document.getElementById("configStatus");
  const dependencyPanelEl = document.getElementById("dependencyPanel");
  const dependencyMessageEl = document.getElementById("dependencyMessage");
  const dependencyCommandEl = document.getElementById("dependencyCommand");
  const installDependenciesBtn = document.getElementById("installDependencies");
  const checkDependenciesBtn = document.getElementById("checkDependencies");
  const jdEl = document.getElementById("jd");
  const resumeSupplementEl = document.getElementById("resumeSupplement");
  const pickResumeBtn = document.getElementById("pickResume");
  const resumeFileEl = document.getElementById("resumeFile");
  const workspaceInfoEl = document.getElementById("workspaceInfo");
  const startInterviewBtn = document.getElementById("startInterview");
  const setupEl = document.getElementById("setup");
  const historyPanelEl = document.getElementById("historyPanel");
  const sessionListEl = document.getElementById("sessionList");
  const newSessionBtn = document.getElementById("newSession");
  const refreshSessionsBtn = document.getElementById("refreshSessions");

  let currentInterviewerBubble = null;
  let awaiting = false;
  let stopping = false;
  let interviewStarted = false;
  let resumeAttachment = null;
  let workspaceState = { hasWorkspace: false, workspaceName: "", workspacePath: "" };

  function setAwaiting(value) {
    awaiting = value;
    updateActionButton();
  }

  function updateActionButton() {
    if (stopping) {
      actionBtn.textContent = "■";
      actionBtn.title = "正在停止";
      actionBtn.setAttribute("aria-label", "正在停止");
      actionBtn.disabled = true;
      actionBtn.classList.add("is-stop");
      return;
    }
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

    interviewStarted = true;
    setupEl.classList.add("is-collapsed");
    sendChat(text, "已提交岗位 JD 和简历，开始面试。");
  }

  function onAction() {
    if (awaiting) {
      stopping = true;
      vscode.postMessage({ type: "stop" });
      updateActionButton();
      return;
    }
    send();
  }

  function send() {
    const text = inputEl.value.trim();
    if (!text || awaiting) {
      return;
    }
    sendChat(text, text);
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
    if (msg.type === "resumePicked") {
      resumeAttachment = msg.resume;
      resumeFileEl.textContent = msg.resume.truncated
        ? `${msg.resume.fileName}（已截取前 80000 字）`
        : msg.resume.fileName;
      setStatus("简历已读取");
      return;
    }
    if (msg.type === "resumeStatus") {
      setStatus(msg.message || "");
      return;
    }
    if (msg.type === "resumeError") {
      appendBubble("error", "出错了", msg.message || "读取简历失败");
      setStatus("");
      return;
    }
    if (msg.type === "dependencyStatus") {
      showDependencyStatus(msg);
      return;
    }
    if (msg.type === "sessions") {
      renderSessions(msg.sessions || [], msg.current || "");
      return;
    }
    if (msg.type === "sessionNew") {
      clearMessages();
      interviewStarted = false;
      setupEl.classList.remove("is-collapsed");
      setStatus("已新建会话");
      jdEl.focus();
      return;
    }
    if (msg.type === "sessionLoaded") {
      clearMessages();
      (msg.messages || []).forEach((item) => {
        appendBubble(
          item.role === "user" ? "user" : "interviewer",
          item.role === "user" ? "我" : "面试官",
          item.content || "",
        );
      });
      interviewStarted = true;
      setupEl.classList.add("is-collapsed");
      setStatus("已继续历史会话");
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
      case "cancelled":
        onCancelled(msg.params);
        break;
      case "error":
        onError(msg.params);
        break;
    }
  });

  function applyConfig(config) {
    workspaceState = {
      hasWorkspace: Boolean(config.hasWorkspace),
      workspaceName: config.workspaceName || "",
      workspacePath: config.workspacePath || "",
    };
    workspaceInfoEl.textContent = workspaceState.hasWorkspace
      ? `自动读取：${workspaceState.workspaceName || workspaceState.workspacePath}`
      : "未打开目标项目文件夹";
    workspaceInfoEl.title = workspaceState.workspacePath || "";
    settingsBtn.title = config.demoMode
      ? "打开设置：当前为 Demo Mode"
      : `打开设置：当前模型 ${config.model || "未配置模型"}`;
  }

  function onStream(params) {
    if (stopping) {
      return;
    }
    if (!currentInterviewerBubble) {
      currentInterviewerBubble = appendBubble("interviewer", "面试官", "");
      currentInterviewerBubble.classList.add("cursor");
    }
    const body = currentInterviewerBubble.querySelector(".bubble__body");
    body.__raw = (body.__raw || "") + (params.delta || "");
    body.innerHTML = renderMarkdown(body.__raw);
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
    stopping = false;
    if (currentInterviewerBubble) {
      currentInterviewerBubble.classList.remove("cursor");
      currentInterviewerBubble = null;
    }
    setAwaiting(false);
    inputEl.focus();
    vscode.postMessage({ type: "listSessions" });
  }

  function onCancelled(params) {
    const partial = params && params.partial ? String(params.partial) : "";
    const bubble = currentInterviewerBubble || appendBubble("interviewer", "面试官", "");
    bubble.classList.remove("cursor");
    const body = bubble.querySelector(".bubble__body");
    const raw = body.__raw || partial;
    const suffix = raw
      ? `\n\n（已停止，生成 ${raw.length} 字）`
      : "（已停止）";
    body.__raw = raw + suffix;
    body.innerHTML = renderMarkdown(body.__raw);
    currentInterviewerBubble = null;
    stopping = false;
    setAwaiting(false);
    inputEl.focus();
    vscode.postMessage({ type: "listSessions" });
  }

  function onError(params) {
    stopping = false;
    appendBubble("error", "出错了", params.message || "未知错误");
    if (!currentInterviewerBubble) {
      setupEl.classList.remove("is-collapsed");
    }
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
    if (kind === "interviewer") {
      // 面试官输出按 Markdown 渲染；渲染器先整体转义再转换，无注入风险
      bodyEl.__raw = body || "";
      bodyEl.innerHTML = renderMarkdown(bodyEl.__raw);
    } else {
      bodyEl.textContent = body || "";
    }
    bubble.appendChild(bodyEl);

    messagesEl.appendChild(bubble);
    scrollToBottom();
    return bubble;
  }

  // ──────────────────────────────────────────────
  // Markdown 渲染（面试官输出）
  // 流程：整体 HTML 转义 → 行级分块（代码块/标题/列表/引用）→ 行内转换。
  // 只输出自己拼的标签，转义过的文本无法注入 HTML。
  // ──────────────────────────────────────────────

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function renderInline(text) {
    // text 已转义。先抽出行内代码，避免内部内容再被粗体/斜体规则处理
    const codeSpans = [];
    let s = text.replace(/`([^`\n]+)`/g, (_m, code) => {
      codeSpans.push(code);
      return `\u0000${codeSpans.length - 1}\u0000`;
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    // 链接不生成 <a>（webview 内导航不可用），以「文本（URL）」呈现
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1（$2）");
    return s.replace(/\u0000(\d+)\u0000/g, (_m, i) =>
      `<code class="md-code">${codeSpans[Number(i)]}</code>`,
    );
  }

  function renderMarkdown(raw) {
    const lines = escapeHtml(raw ?? "").split(/\r?\n/);
    const out = [];
    let listType = null;
    let quoteOpen = false;
    let para = [];

    const closePara = () => {
      if (para.length) {
        out.push(`<p>${para.map(renderInline).join("<br>")}</p>`);
        para = [];
      }
    };
    const closeList = () => {
      if (listType) {
        out.push(`</${listType}>`);
        listType = null;
      }
    };
    const closeQuote = () => {
      if (quoteOpen) {
        out.push("</blockquote>");
        quoteOpen = false;
      }
    };
    const closeAll = () => {
      closePara();
      closeList();
      closeQuote();
    };

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (trimmed.startsWith("```")) {
        closeAll();
        const buf = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith("```")) {
          buf.push(lines[i]);
          i += 1;
        }
        out.push(`<pre class="md-pre"><code>${buf.join("\n")}</code></pre>`);
        continue;
      }
      if (!trimmed) {
        closeAll();
        continue;
      }
      const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeAll();
        out.push(
          `<div class="md-h md-h${heading[1].length}">${renderInline(heading[2])}</div>`,
        );
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        closeAll();
        out.push('<hr class="md-hr" />');
        continue;
      }
      if (trimmed.startsWith("&gt;")) {
        closePara();
        closeList();
        if (!quoteOpen) {
          out.push('<blockquote class="md-quote">');
          quoteOpen = true;
        }
        out.push(`<p>${renderInline(trimmed.replace(/^&gt;\s?/, ""))}</p>`);
        continue;
      }
      const ul = trimmed.match(/^[-*+]\s+(.*)$/);
      if (ul) {
        closePara();
        closeQuote();
        if (listType !== "ul") {
          closeList();
          out.push('<ul class="md-ul">');
          listType = "ul";
        }
        out.push(`<li>${renderInline(ul[1])}</li>`);
        continue;
      }
      const ol = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
      if (ol) {
        closePara();
        closeQuote();
        if (listType !== "ol") {
          closeList();
          out.push('<ol class="md-ol">');
          listType = "ol";
        }
        out.push(`<li>${renderInline(ol[2])}</li>`);
        continue;
      }
      closeList();
      closeQuote();
      para.push(lines[i]);
    }
    closeAll();
    return out.join("");
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

  function showDependencyStatus(status) {
    dependencyPanelEl.classList.toggle("is-hidden", !status.message);
    if (status.message) {
      setupEl.classList.remove("is-collapsed");
    }
    dependencyMessageEl.textContent = status.message || "";
    dependencyCommandEl.textContent = status.command || "";
    dependencyCommandEl.style.display = status.command ? "block" : "none";
    installDependenciesBtn.style.display = status.canInstall ? "inline-flex" : "none";
  }

  function renderSessions(sessions, current) {
    sessionListEl.textContent = "";
    if (!sessions.length) {
      const empty = document.createElement("div");
      empty.className = "session-item__meta";
      empty.textContent = "暂无历史会话";
      sessionListEl.appendChild(empty);
      return;
    }
    sessions.forEach((session) => {
      const item = document.createElement("div");
      item.className = "session-item";

      const top = document.createElement("div");
      top.className = "session-item__top";

      const title = document.createElement("div");
      title.className = "session-item__title";
      title.textContent = session.id === current ? `${session.title}（当前）` : session.title;

      const buttons = document.createElement("div");
      buttons.className = "session-item__buttons";

      const resume = document.createElement("button");
      resume.className = "secondary-button";
      resume.type = "button";
      resume.textContent = "继续";
      resume.addEventListener("click", () => {
        vscode.postMessage({ type: "resumeSession", session: session.id });
      });

      const remove = document.createElement("button");
      remove.className = "secondary-button";
      remove.type = "button";
      remove.textContent = "删除";
      remove.addEventListener("click", () => {
        vscode.postMessage({ type: "deleteSession", session: session.id });
      });

      buttons.append(resume, remove);
      top.append(title, buttons);

      const preview = document.createElement("div");
      preview.className = "session-item__preview";
      preview.textContent = session.preview || "";

      const meta = document.createElement("div");
      meta.className = "session-item__meta";
      meta.textContent = `${new Date(session.updatedAt).toLocaleString()} · ${session.messageCount} 条`;

      item.append(top, preview, meta);
      sessionListEl.appendChild(item);
    });
  }

  function clearMessages() {
    messagesEl.textContent = "";
    currentInterviewerBubble = null;
    stopping = false;
    setAwaiting(false);
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  historyToggleBtn.addEventListener("click", () => {
    historyPanelEl.classList.toggle("is-collapsed");
    vscode.postMessage({ type: "listSessions" });
  });
  settingsBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "openSettings" });
  });
  installDependenciesBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "installDependencies" });
  });
  checkDependenciesBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "checkDependencies" });
  });
  newSessionBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "newSession" });
  });
  refreshSessionsBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "listSessions" });
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
  vscode.postMessage({ type: "listSessions" });
  updateActionButton();
  if (!interviewStarted) {
    jdEl.focus();
  }
})();
