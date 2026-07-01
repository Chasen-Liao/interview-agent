/**
 * Webview 前端逻辑（设计第 5.3、5.5 节）。
 *
 * 通信（设计第 5.5 节两跳）：Webview ←postMessage→ Extension Host ←stdio→ Python。
 * 本文件只负责 postMessage 第一跳 + UI 渲染，不碰子进程。
 *
 * 渲染四类通知：
 * - stream   → 追加到当前面试官气泡（打字效果）
 * - tool_call → 插工具气泡（start→"正在执行"，end→填结果）
 * - done     → 结束本轮，恢复输入框
 * - error    → 红色气泡
 *
 * 设计第 5.7 节原则：界面上显示的必须是真实发生的，不放假动画。
 */

// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  // ───────── DOM ─────────
  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const stopBtn = document.getElementById("stop");

  // ───────── 会话状态 ─────────
  // 当前正在流式输出的面试官气泡（stream 通知追加到这里）
  let currentInterviewerBubble = null;
  // 当前是否正在等待回复（done/error 后恢复 false）
  let awaiting = false;

  // ──────────────────────────────────────────────
  // 发送：用户输入 → postMessage 给 Host
  // ──────────────────────────────────────────────

  function send() {
    const text = inputEl.value.trim();
    if (!text || awaiting) {
      return;
    }
    // 渲染用户气泡
    appendUserMessage(text);
    inputEl.value = "";
    setAwaiting(true);
    // 通知 Host（attached_code 由 Host 从编辑器选中区读，前端只传文本）
    vscode.postMessage({ type: "chat", text });
  }

  function setAwaiting(v) {
    awaiting = v;
    sendBtn.disabled = v;
    stopBtn.disabled = !v;
  }

  // ──────────────────────────────────────────────
  // 接收：Host 的通知 → 渲染
  // ──────────────────────────────────────────────

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg.method !== "string") {
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
        onDone(msg.params);
        break;
      case "error":
        onError(msg.params);
        break;
    }
  });

  function onStream(params) {
    // 第一段文字：新建面试官气泡
    if (!currentInterviewerBubble) {
      currentInterviewerBubble = appendBubble("interviewer", "🤖 面试官", "");
      currentInterviewerBubble.classList.add("cursor");
    }
    // 追加文本（打字效果——MVP 直接拼接，非逐字）
    const body = currentInterviewerBubble.querySelector(".bubble__body");
    body.textContent += params.delta || "";
    scrollToBottom();
  }

  function onToolCall(params) {
    const { tool, phase, args, result } = params;
    if (phase === "start") {
      // 插一个"正在执行"的工具气泡，标记 running
      const bubble = appendBubble("tool", `🔍 ${tool}`, formatArgs(args));
      bubble.classList.add("is-running");
      bubble.dataset.toolId = tool; // 简单标识，end 时按需更新
      bubble._startBubble = bubble;
      currentInterviewerBubble = null; // 工具调用打断当前回答气泡
    } else {
      // end：找最近的同名工具气泡，填结果，去掉 running
      const candidates = messagesEl.querySelectorAll(
        `.bubble--tool.is-running[data-tool-id="${tool}"]`,
      );
      const last = candidates[candidates.length - 1];
      if (last) {
        last.classList.remove("is-running");
        last.querySelector(".bubble__title").textContent = `✅ ${tool} 完成`;
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
    appendBubble("error", "⚠️ 出错了", params.message || "未知错误");
    if (currentInterviewerBubble) {
      currentInterviewerBubble.classList.remove("cursor");
      currentInterviewerBubble = null;
    }
    setAwaiting(false);
  }

  // ──────────────────────────────────────────────
  // DOM 辅助
  // ──────────────────────────────────────────────

  function appendUserMessage(text) {
    appendBubble("user", "👤 我", text);
  }

  /**
   * 创建并追加一个气泡。
   * @param {"user"|"interviewer"|"tool"|"error"} kind
   * @param {string} title 角色标签
   * @param {string} body 正文
   * @returns {HTMLElement}
   */
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

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ──────────────────────────────────────────────
  // 事件绑定
  // ──────────────────────────────────────────────

  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "stop" });
    setAwaiting(false);
  });

  // Enter 发送，Shift+Enter 换行
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // 输入框为固定高度（CSS 控制），内容超出时内部滚动，无需 JS 动态增高

  inputEl.focus();
})();
