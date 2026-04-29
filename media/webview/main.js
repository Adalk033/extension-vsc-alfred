// @ts-check
// Webview principal del chat de Alfred. Habla con el host por postMessage.
// Sin frameworks, sin bundler. Markdown casero (subset) con escape estricto.

(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  /** @type {HTMLDivElement} */ const messagesEl = /** @type any */ (document.getElementById("messages"));
  /** @type {HTMLTextAreaElement} */ const inputEl = /** @type any */ (document.getElementById("input"));
  /** @type {HTMLButtonElement} */ const sendBtn = /** @type any */ (document.getElementById("send-btn"));
  /** @type {HTMLButtonElement} */ const cancelBtn = /** @type any */ (document.getElementById("cancel-btn"));
  /** @type {HTMLButtonElement} */ const newBtn = /** @type any */ (document.getElementById("new-btn"));
  /** @type {HTMLSelectElement} */ const modelSelect = /** @type any */ (document.getElementById("model-select"));
  /** @type {HTMLButtonElement} */ const unloadModelBtn = /** @type any */ (document.getElementById("unload-model-btn"));
  /** @type {HTMLSpanElement} */ const statusDot = /** @type any */ (document.getElementById("status-dot"));
  /** @type {HTMLSpanElement} */ const statusText = /** @type any */ (document.getElementById("status-text"));
  /** @type {HTMLButtonElement} */ const modeChatBtn = /** @type any */ (document.getElementById("mode-chat-btn"));
  /** @type {HTMLButtonElement} */ const modeAgentBtn = /** @type any */ (document.getElementById("mode-agent-btn"));

  const MAX_TOOL_RESULT_CHARS = 4000;

  // Estado en memoria del webview. Persistencia real esta en el host.
  /** @type {Map<string, {raw:string, bodyEl:HTMLElement, root:HTMLElement}>} */
  const liveMessages = new Map();

  /** @type {Map<string, {root: HTMLDetailsElement, badgeEl: HTMLSpanElement, resultBox: HTMLDivElement, resultPre: HTMLPreElement}>} */
  const liveToolBlocks = new Map();

  let streaming = false;
  let currentMode = "chat";
  let backendOnline = false;
  let modelLoaded = false;
  let runCounter = 0;
  let activeRunKey = "run-0";

  // ---------------------------------------------------- Render
  function setEmptyStateIfNeeded() {
    if (messagesEl.querySelector(".msg") || messagesEl.querySelector(".tool-block")) return;
    messagesEl.innerHTML = '<div class="empty-state">Empieza una conversacion con Alfred. Tu pregunta se enviara al backend local.</div>';
  }

  function clearMessages() {
    messagesEl.innerHTML = "";
    liveMessages.clear();
    liveToolBlocks.clear();
    setEmptyStateIfNeeded();
  }

  /**
   * @param {{id:string, role:string, content:string, pending?:boolean}} msg
   */
  function appendMessage(msg) {
    const empty = messagesEl.querySelector(".empty-state");
    if (empty) empty.remove();

    const root = document.createElement("div");
    root.className = `msg ${msg.role}`;
    if (msg.pending) root.classList.add("pending");
    root.dataset.id = msg.id;

    const role = document.createElement("div");
    role.className = "role";
    role.textContent = msg.role === "user" ? "Tu" : msg.role === "assistant" ? "Alfred" : msg.role;

    const body = document.createElement("div");
    body.className = "body";
    body.innerHTML = renderMarkdown(msg.content || "");

    root.appendChild(role);
    root.appendChild(body);
    messagesEl.appendChild(root);
    liveMessages.set(msg.id, { raw: msg.content || "", bodyEl: body, root });
    scrollToBottom();
  }

  function appendToken(messageId, text) {
    const entry = liveMessages.get(messageId);
    if (!entry) return;
    entry.raw += text;
    entry.bodyEl.innerHTML = renderMarkdown(entry.raw);
    scrollToBottom();
  }

  function finishMessage(messageId, opts) {
    const entry = liveMessages.get(messageId);
    if (!entry) return;
    entry.root.classList.remove("pending");
    if (opts && opts.error) {
      entry.root.classList.add("error");
      entry.raw = (entry.raw ? entry.raw + "\n\n" : "") + `**Error:** ${opts.error}`;
      entry.bodyEl.innerHTML = renderMarkdown(entry.raw);
    }
    scrollToBottom();
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------------------------------------------------- Bloques de tools
  function startRun() {
    runCounter += 1;
    activeRunKey = `run-${runCounter}`;
  }

  function callKey(call) {
    const id = call && typeof call.id === "string" && call.id.trim().length > 0
      ? call.id
      : "call_unknown";
    return `${activeRunKey}:${id}`;
  }

  function appendIterationMarker(iteration, phase, finishReason) {
    const empty = messagesEl.querySelector(".empty-state");
    if (empty) empty.remove();

    const marker = document.createElement("div");
    marker.className = "agent-iteration";
    if (phase === "start") {
      marker.textContent = `Iteracion ${iteration + 1} iniciada`;
    } else {
      marker.textContent = finishReason
        ? `Iteracion ${iteration + 1} finalizada (${finishReason})`
        : `Iteracion ${iteration + 1} finalizada`;
    }
    messagesEl.appendChild(marker);
    scrollToBottom();
  }

  function appendToolCall(iteration, call) {
    ensureToolBlock(iteration, call);
    scrollToBottom();
  }

  function appendToolResult(iteration, call, result) {
    const block = ensureToolBlock(iteration, call);
    const isError = !!result && !!result.is_error;

    block.badgeEl.classList.remove("pending", "ok", "error");
    block.badgeEl.classList.add(isError ? "error" : "ok");
    block.badgeEl.textContent = isError ? "error" : "ok";

    block.root.classList.remove("pending");
    block.root.classList.toggle("error", isError);

    block.resultBox.classList.remove("hidden");
    const resultText =
      result && typeof result.content === "string"
        ? truncateResult(result.content)
        : truncateResult(safePrettyJson(result && result.content !== undefined ? result.content : ""));
    block.resultPre.textContent = resultText;

    scrollToBottom();
  }

  function ensureToolBlock(iteration, call) {
    const key = callKey(call);
    const existing = liveToolBlocks.get(key);
    if (existing) return existing;

    const empty = messagesEl.querySelector(".empty-state");
    if (empty) empty.remove();

    const root = document.createElement("details");
    root.className = "tool-block pending";
    root.dataset.callId = typeof call?.id === "string" ? call.id : "call_unknown";

    const summary = document.createElement("summary");
    summary.className = "tool-summary";

    const left = document.createElement("span");
    left.className = "tool-summary-main";

    const nameEl = document.createElement("span");
    nameEl.className = "tool-name";
    nameEl.textContent = typeof call?.name === "string" ? call.name : "unknown_tool";

    const iterEl = document.createElement("span");
    iterEl.className = "tool-iter";
    iterEl.textContent = `iter ${iteration + 1}`;

    const idEl = document.createElement("span");
    idEl.className = "tool-id";
    idEl.textContent = typeof call?.id === "string" ? call.id : "call_unknown";

    left.appendChild(nameEl);
    left.appendChild(iterEl);
    left.appendChild(idEl);

    const badgeEl = document.createElement("span");
    badgeEl.className = "tool-badge pending";
    badgeEl.textContent = "pending";

    summary.appendChild(left);
    summary.appendChild(badgeEl);
    root.appendChild(summary);

    const body = document.createElement("div");
    body.className = "tool-body";

    const argsLabel = document.createElement("div");
    argsLabel.className = "tool-section-label";
    argsLabel.textContent = "args";

    const argsPre = document.createElement("pre");
    argsPre.className = "tool-json";
    argsPre.textContent = safePrettyJson(call && call.arguments !== undefined ? call.arguments : {});

    const resultBox = document.createElement("div");
    resultBox.className = "tool-result hidden";

    const resultLabel = document.createElement("div");
    resultLabel.className = "tool-section-label";
    resultLabel.textContent = "result";

    const resultPre = document.createElement("pre");
    resultPre.className = "tool-json";

    resultBox.appendChild(resultLabel);
    resultBox.appendChild(resultPre);

    body.appendChild(argsLabel);
    body.appendChild(argsPre);
    body.appendChild(resultBox);

    root.appendChild(body);
    messagesEl.appendChild(root);

    const block = { root, badgeEl, resultBox, resultPre };
    liveToolBlocks.set(key, block);
    return block;
  }

  // ---------------------------------------------------- Markdown minimo
  /**
   * Subset de markdown seguro: bloques de codigo cercados, inline code, bold,
   * italic, headings (#-###), listas (-, *, 1.), enlaces, parrafos.
   * Escapa todo el HTML que no genere el propio renderer.
   * @param {string} src
   */
  function renderMarkdown(src) {
    if (!src) return "";

    // 1) Aislar bloques de codigo cercados ```lang\n...\n```
    /** @type {string[]} */
    const codeBlocks = [];
    src = src.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
      const idx = codeBlocks.length;
      const cls = lang ? ` class="language-${escapeAttr(lang)}"` : "";
      codeBlocks.push(`<pre><code${cls}>${escapeHtml(code)}</code></pre>`);
      return `CODEBLOCK${idx}`;
    });

    // 2) Escapar todo el resto
    let out = escapeHtml(src);

    // 3) Inline code `...`
    out = out.replace(/`([^`\n]+?)`/g, (_m, c) => `<code>${c}</code>`);

    // 4) Bold **...** y italic *...*
    out = out.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");

    // 5) Headings al inicio de linea (### -> h3, ## -> h2, # -> h1)
    out = out.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
    out = out.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
    out = out.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

    // 6) Listas: agrupar lineas consecutivas que empiezan por -, * o numero.
    out = groupLists(out);

    // 7) Enlaces [texto](url) - solo http(s)/relative
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, url) => {
      const safe = isSafeUrl(url) ? url : "#";
      return `<a href="${escapeAttr(safe)}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
    });

    // 8) Parrafos: separar por dobles saltos.
    out = out
      .split(/\n{2,}/)
      .map((block) => {
        if (/^\s*<(h\d|ul|ol|pre|blockquote)/.test(block)) return block;
        if (/^CODEBLOCK\d+\s*$/.test(block)) return block;
        return `<p>${block.replace(/\n/g, "<br/>")}</p>`;
      })
      .join("\n");

    // 9) Restaurar bloques de codigo
    out = out.replace(/CODEBLOCK(\d+)/g, (_m, i) => codeBlocks[Number(i)] || "");
    return out;
  }

  /** @param {string} s */
  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  /** @param {string} s */
  function escapeAttr(s) {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  /** @param {string} u */
  function isSafeUrl(u) {
    return /^(https?:|mailto:|#|\/|\.\.?\/)/i.test(u);
  }
  /** @param {string} src */
  function groupLists(src) {
    const lines = src.split("\n");
    /** @type {string[]} */
    const out = [];
    /** @type {null|"ul"|"ol"} */
    let inList = null;
    for (const line of lines) {
      const ulMatch = /^\s*[-*]\s+(.+)$/.exec(line);
      const olMatch = /^\s*\d+\.\s+(.+)$/.exec(line);
      if (ulMatch) {
        if (inList !== "ul") {
          if (inList) out.push(`</${inList}>`);
          out.push("<ul>");
          inList = "ul";
        }
        out.push(`<li>${ulMatch[1]}</li>`);
      } else if (olMatch) {
        if (inList !== "ol") {
          if (inList) out.push(`</${inList}>`);
          out.push("<ol>");
          inList = "ol";
        }
        out.push(`<li>${olMatch[1]}</li>`);
      } else {
        if (inList) {
          out.push(`</${inList}>`);
          inList = null;
        }
        out.push(line);
      }
    }
    if (inList) out.push(`</${inList}>`);
    return out.join("\n");
  }

  // ---------------------------------------------------- Estado UI
  function setStreaming(on) {
    streaming = on;
    sendBtn.disabled = on;
    cancelBtn.disabled = !on;
    modeChatBtn.disabled = on;
    modeAgentBtn.disabled = on;
    modelSelect.disabled = on || modelSelect.options.length === 0;
    unloadModelBtn.disabled = on || !backendOnline || !modelLoaded;
    inputEl.disabled = false;
  }

  function setBackendStatus(ok, reason) {
    statusDot.classList.remove("dot-ok", "dot-ko", "dot-unknown");
    if (ok === null || ok === undefined) {
      statusDot.classList.add("dot-unknown");
      statusText.textContent = "Comprobando backend...";
    } else if (ok) {
      backendOnline = true;
      statusDot.classList.add("dot-ok");
      statusText.textContent = "Backend OK";
      statusText.title = "";
    } else {
      backendOnline = false;
      statusDot.classList.add("dot-ko");
      statusText.textContent = "Backend offline";
      statusText.title = reason || "Abre la app de Alfred";
    }
    unloadModelBtn.disabled = streaming || !backendOnline || !modelLoaded;
  }

  function setModels(models, active, loaded) {
    modelLoaded = !!loaded;
    modelSelect.innerHTML = "";
    if (!models || models.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "(sin modelos)";
      opt.disabled = true;
      modelSelect.appendChild(opt);
      modelSelect.disabled = true;
      unloadModelBtn.disabled = true;
      return;
    }
    modelSelect.disabled = streaming;
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.name;
      opt.textContent = `${m.name}  (${m.size_gb.toFixed(1)} GB)`;
      if (active && m.name === active) opt.selected = true;
      modelSelect.appendChild(opt);
    }
    if (!active && modelSelect.options.length > 0) {
      modelSelect.selectedIndex = -1;
    }
    unloadModelBtn.disabled = streaming || !backendOnline || !modelLoaded;
  }

  function setMode(mode) {
    currentMode = mode === "agent" ? "agent" : "chat";

    const chatActive = currentMode === "chat";
    modeChatBtn.classList.toggle("active", chatActive);
    modeAgentBtn.classList.toggle("active", !chatActive);
    modeChatBtn.setAttribute("aria-pressed", String(chatActive));
    modeAgentBtn.setAttribute("aria-pressed", String(!chatActive));

    inputEl.placeholder =
      currentMode === "agent"
        ? "Modo Agent activo. Describe el objetivo (Enter para enviar)"
        : "Pregunta a Alfred (Enter para enviar, Shift+Enter para nueva linea)";
  }

  // ---------------------------------------------------- Helpers tool blocks
  function safePrettyJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function truncateResult(content) {
    if (content.length <= MAX_TOOL_RESULT_CHARS) {
      return content;
    }
    const omitted = content.length - MAX_TOOL_RESULT_CHARS;
    return `${content.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[... truncado: ${omitted} chars omitidos]`;
  }

  // ---------------------------------------------------- Eventos UI
  sendBtn.addEventListener("click", () => submit());
  cancelBtn.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
  newBtn.addEventListener("click", () => vscode.postMessage({ type: "new-conversation" }));
  modelSelect.addEventListener("change", () => {
    const v = modelSelect.value;
    if (v) vscode.postMessage({ type: "change-model", modelName: v });
  });
  unloadModelBtn.addEventListener("click", () => {
    if (!streaming) vscode.postMessage({ type: "unload-model" });
  });

  modeChatBtn.addEventListener("click", () => {
    if (streaming) return;
    if (currentMode !== "chat") {
      vscode.postMessage({ type: "set-mode", mode: "chat" });
    }
  });

  modeAgentBtn.addEventListener("click", () => {
    if (streaming) return;
    if (currentMode !== "agent") {
      vscode.postMessage({ type: "set-mode", mode: "agent" });
    }
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  inputEl.addEventListener("input", () => {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
  });

  function submit() {
    const text = inputEl.value.trim();
    if (!text || streaming) return;
    vscode.postMessage({ type: "send", text });
    inputEl.value = "";
    inputEl.style.height = "auto";
  }

  // ---------------------------------------------------- Mensajes desde host
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "init":
        clearMessages();
        for (const m of msg.messages || []) appendMessage(m);
        setEmptyStateIfNeeded();
        setModels(msg.models, msg.activeModel, msg.modelLoaded);
        setBackendStatus(msg.backendOk);
        setMode(msg.mode || "chat");
        break;
      case "set-mode":
        setMode(msg.mode || "chat");
        break;
      case "models":
        setModels(msg.models, msg.activeModel, msg.modelLoaded);
        break;
      case "backend-status":
        setBackendStatus(msg.ok, msg.reason);
        break;
      case "history-cleared":
        clearMessages();
        break;
      case "message-append":
        appendMessage(msg.message);
        break;
      case "stream-start":
        startRun();
        setStreaming(true);
        break;
      case "stream-token":
        appendToken(msg.messageId, msg.text);
        break;
      case "stream-done":
        finishMessage(msg.messageId);
        setStreaming(false);
        break;
      case "stream-error":
        finishMessage(msg.messageId, { error: msg.message });
        setStreaming(false);
        break;
      case "agent-iteration":
        appendIterationMarker(msg.iteration, msg.phase, msg.finishReason);
        break;
      case "agent-tool-call":
        appendToolCall(msg.iteration, msg.call);
        break;
      case "agent-tool-result":
        appendToolResult(msg.iteration, msg.call, msg.result);
        break;
    }
  });

  setEmptyStateIfNeeded();
  setMode("chat");
  vscode.postMessage({ type: "ready" });
})();
