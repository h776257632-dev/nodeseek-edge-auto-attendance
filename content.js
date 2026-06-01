(function () {
  const POST_RE = /\/post-(\d+)-\d+/;

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function getPostId() {
    const m = location.pathname.match(POST_RE);
    return m ? Number(m[1]) : null;
  }

  function css(el, styles) {
    Object.assign(el.style, styles);
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  }

  function findCommentBox() {
    const selectors = [
      "textarea",
      "[contenteditable='true']",
      ".ProseMirror",
      "[role='textbox']"
    ];

    const list = selectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));
    const visible = list.filter(isVisible);

    const scored = visible.map(el => {
      const text = [
        el.getAttribute("placeholder") || "",
        el.getAttribute("aria-label") || "",
        el.className || "",
        el.id || "",
        el.textContent || ""
      ].join(" ").toLowerCase();

      let score = 0;
      if (/评论|回复|comment|reply|输入/.test(text)) score += 5;
      if (el.tagName.toLowerCase() === "textarea") score += 3;
      if (el.isContentEditable) score += 2;
      return { el, score };
    }).sort((a, b) => b.score - a.score);

    return scored[0]?.el || visible[0] || null;
  }

  function fillElement(el, text) {
    if (!el) return false;

    el.focus();

    const tag = el.tagName.toLowerCase();

    if (tag === "textarea" || tag === "input") {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set ||
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(el, text);
      else el.value = text;

      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (el.isContentEditable || el.getAttribute("contenteditable") === "true" || el.classList.contains("ProseMirror")) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      }));
      return true;
    }

    return false;
  }

  async function maybeTriggerAttendance() {
    if (window.__NODESEEK_ATTENDANCE_VISIT_TRIGGERED__) return;
    window.__NODESEEK_ATTENDANCE_VISIT_TRIGGERED__ = true;

    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: "DO_ATTENDANCE_FROM_CONTENT",
        source: "visit"
      }, result => {
        if (chrome.runtime.lastError) return;
        console.log("[NodeSeek 助手] 访问页面触发签到结果:", result);
      });
    }, 3000);
  }

  function createPanel(postId, settings, state) {
    if (document.getElementById("nodeseek-helper-panel")) return;

    const panel = document.createElement("div");
    panel.id = "nodeseek-helper-panel";

    css(panel, {
      position: "fixed",
      right: "18px",
      bottom: "18px",
      width: "320px",
      zIndex: "2147483647",
      background: "#ffffff",
      border: "1px solid #d0d7de",
      borderRadius: "12px",
      boxShadow: "0 8px 28px rgba(0,0,0,.18)",
      fontFamily: "Microsoft YaHei, system-ui, sans-serif",
      color: "#222",
      overflow: "hidden"
    });

    panel.innerHTML = `
      <div style="padding:10px 12px;background:#1f6feb;color:#fff;font-weight:600;display:flex;justify-content:space-between;align-items:center;">
        <span>NodeSeek 评论助手</span>
        <button id="nsh-close" style="background:transparent;border:0;color:#fff;font-size:16px;cursor:pointer;">×</button>
      </div>
      <div style="padding:10px 12px;">
        <div style="font-size:12px;color:#666;margin-bottom:6px;">帖子 ID：${postId}</div>
        <textarea id="nsh-draft" style="width:100%;height:76px;box-sizing:border-box;border:1px solid #ccc;border-radius:8px;padding:8px;resize:vertical;font-size:13px;"></textarea>
        <div id="nsh-status" style="font-size:12px;color:#666;margin:7px 0;line-height:1.5;"></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button id="nsh-generate">换一句</button>
          <button id="nsh-fill">填入草稿</button>
          <button id="nsh-send">确认发送</button>
        </div>
        <div style="margin-top:7px;font-size:12px;color:#999;line-height:1.5;">
          不会自动发送；只有点击“确认发送”才会提交。
        </div>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #nodeseek-helper-panel button {
        border: 0;
        border-radius: 7px;
        padding: 6px 8px;
        cursor: pointer;
        background: #eaeef2;
        color: #222;
        font-size: 12px;
      }
      #nodeseek-helper-panel #nsh-send {
        background: #1f883d;
        color: #fff;
      }
      #nodeseek-helper-panel button:disabled {
        opacity: .55;
        cursor: not-allowed;
      }
    `;
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(panel);

    const draft = panel.querySelector("#nsh-draft");
    const status = panel.querySelector("#nsh-status");
    const btnGenerate = panel.querySelector("#nsh-generate");
    const btnFill = panel.querySelector("#nsh-fill");
    const btnSend = panel.querySelector("#nsh-send");

    function setStatus(text, good = true) {
      status.textContent = text;
      status.style.color = good ? "#666" : "#b42318";
    }

    async function generate(autoFill = false) {
      btnGenerate.disabled = true;
      try {
        const res = await sendMessage({ type: "GENERATE_COMMENT_DRAFT", postId });
        if (!res.ok) {
          setStatus(res.reason || res.error || "生成失败", false);
          return;
        }

        draft.value = res.content;
        setStatus(`已生成草稿；今日草稿 ${res.draftCount} 条`);

        if (autoFill) {
          await fillDraft();
        }
      } catch (e) {
        setStatus(`生成失败：${e.message}`, false);
      } finally {
        btnGenerate.disabled = false;
      }
    }

    async function fillDraft() {
      const text = draft.value.trim();
      if (!text) {
        setStatus("草稿为空", false);
        return;
      }

      const box = findCommentBox();
      const ok = fillElement(box, text);

      if (ok) setStatus("已填入页面评论框，请检查后再确认发送");
      else setStatus("没有找到评论框；可手动复制草稿", false);
    }

    async function confirmSend() {
      const text = draft.value.trim();
      if (!text) {
        setStatus("草稿为空", false);
        return;
      }

      const yes = window.confirm(`确认发送这条评论吗？\n\n${text}`);
      if (!yes) return;

      btnSend.disabled = true;
      setStatus("正在发送...");

      try {
        const res = await sendMessage({
          type: "SEND_COMMENT",
          postId,
          content: text
        });

        if (res.ok) {
          setStatus(`发送成功；今日已发送 ${res.sendCount || ""} 条`);
          btnSend.disabled = true;
        } else {
          setStatus(res.reason || res.error || res.data?.message || "发送失败", false);
        }
      } catch (e) {
        setStatus(`发送失败：${e.message}`, false);
      } finally {
        if (!status.textContent.includes("发送成功")) {
          btnSend.disabled = false;
        }
      }
    }

    panel.querySelector("#nsh-close").onclick = () => panel.remove();
    btnGenerate.onclick = () => generate(false);
    btnFill.onclick = fillDraft;
    btnSend.onclick = confirmSend;

    const pauseText = state.pause?.paused ? `已暂停到 ${state.pause.pauseUntilText}` : "";
    const countText = `今日草稿 ${state.today?.draftCount || 0}/${settings.comment.dailyDraftLimit}，确认发送 ${state.today?.sendCount || 0}/${settings.comment.dailySendLimit}`;
    setStatus(pauseText || countText, !pauseText);

    if (!pauseText && settings.comment.autoFillDraft) {
      setTimeout(() => generate(true), 1200);
    } else if (!pauseText) {
      generate(false);
    }
  }

  async function initCommentAssistant() {
    const postId = getPostId();
    if (!postId) return;

    try {
      const state = await sendMessage({ type: "GET_STATE" });
      const settings = state.settings || {};
      if (!settings.comment?.enabled) return;
      createPanel(postId, settings, state);
    } catch (e) {
      console.log("[NodeSeek 助手] 初始化评论助手失败:", e);
    }
  }

  maybeTriggerAttendance();
  setTimeout(initCommentAssistant, 1800);
})();
