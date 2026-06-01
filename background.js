const ATTENDANCE_ALARM_NAME = "nodeseek_attendance_alarm";
const BOARD_URL = "https://www.nodeseek.com/board";

const DEFAULT_SETTINGS = {
  attendance: {
    enabled: true,
    autoWhenVisit: true,
    openTabOnAlarm: false,
    notify: true,
    hour: 9,
    minute: 10
  },
  comment: {
    enabled: true,
    autoFillDraft: true,
    dailyDraftLimit: 5,
    dailySendLimit: 3,
    startTime: "09:00",
    endTime: "23:30",
    pauseOnRiskHours: 72,
    comments: [
      "感谢分享",
      "学习了，感谢",
      "收藏看看",
      "支持一下",
      "这个信息有用，感谢",
      "先 mark 一下",
      "感谢楼主分享",
      "路过学习一下"
    ]
  }
};

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!patch || typeof patch !== "object") return out;
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object") {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function todayKey() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("-");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseTimeToMinutes(s) {
  const m = String(s || "").match(/^(\d{1,2}):(\d{1,2})$/);
  if (!m) return null;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const min = Math.max(0, Math.min(59, Number(m[2])));
  return h * 60 + min;
}

function inTimeWindow(start, end) {
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = parseTimeToMinutes(start);
  const e = parseTimeToMinutes(end);
  if (s === null || e === null) return true;
  if (s <= e) return cur >= s && cur <= e;
  return cur >= s || cur <= e;
}

function isNodeseekUrl(url) {
  return typeof url === "string" && /^https:\/\/www\.nodeseek\.com\//.test(url);
}

function isAttendanceSuccessLike(data) {
  const msg = String(data?.message || "");
  return data?.success === true ||
    msg.includes("已完成签到") ||
    msg.includes("请勿重复操作") ||
    msg.includes("今天已完成签到");
}

function isRiskLike(result) {
  const msg = String(result?.data?.message || result?.message || result?.rawText || "");
  return result?.httpStatus === 403 ||
    result?.httpStatus === 429 ||
    msg.toLowerCase().includes("high risk") ||
    msg.includes("高风险") ||
    msg.includes("风险");
}

async function getSettings() {
  const data = await chrome.storage.local.get(["settings"]);
  return deepMerge(DEFAULT_SETTINGS, data.settings || {});
}

async function setSettings(settings) {
  const merged = deepMerge(DEFAULT_SETTINGS, settings || {});
  await chrome.storage.local.set({ settings: merged });
  await scheduleAttendanceAlarm();
  return merged;
}

async function saveLog(type, result) {
  const logItem = {
    type,
    time: new Date().toLocaleString(),
    isoTime: new Date().toISOString(),
    date: todayKey(),
    result
  };

  const data = await chrome.storage.local.get(["logs"]);
  const logs = Array.isArray(data.logs) ? data.logs : [];
  logs.unshift(logItem);

  await chrome.storage.local.set({
    lastResult: logItem,
    logs: logs.slice(0, 80)
  });

  return logItem;
}

async function notify(title, message) {
  const settings = await getSettings();
  if (!settings.attendance.notify) return;

  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message: String(message || "")
    });
  } catch (e) {
    console.log("[NodeSeek] 通知失败:", e);
  }
}

async function waitTabComplete(tabId, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await sleep(300);
  }
  return await chrome.tabs.get(tabId);
}

async function findReusableNodeseekTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.nodeseek.com/*" });
  return tabs.find(t => t.active) || tabs[0] || null;
}

async function ensureNodeseekTab(createIfMissing = true, active = true) {
  let tab = await findReusableNodeseekTab();

  if (!tab && createIfMissing) {
    tab = await chrome.tabs.create({ url: BOARD_URL, active });
  }

  if (!tab) return null;

  if (!isNodeseekUrl(tab.url || "")) {
    await chrome.tabs.update(tab.id, { url: BOARD_URL, active });
  } else if (active) {
    await chrome.tabs.update(tab.id, { active: true });
  }

  return await waitTabComplete(tab.id);
}

async function executeInMainWorld(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func,
    args
  });

  return results && results[0] ? results[0].result : {
    ok: false,
    error: "没有拿到页面执行结果"
  };
}

async function getPauseState() {
  const data = await chrome.storage.local.get(["pauseUntil"]);
  const pauseUntil = Number(data.pauseUntil || 0);
  return {
    pauseUntil,
    paused: pauseUntil > Date.now(),
    pauseUntilText: pauseUntil > 0 ? new Date(pauseUntil).toLocaleString() : ""
  };
}

async function setRiskPause(hours, reason) {
  const h = Math.max(1, Number(hours || 72));
  const pauseUntil = Date.now() + h * 3600 * 1000;
  await chrome.storage.local.set({
    pauseUntil,
    pauseReason: reason || "risk"
  });
  return pauseUntil;
}

async function clearPause() {
  await chrome.storage.local.remove(["pauseUntil", "pauseReason"]);
}

async function getCounter(name, date = todayKey()) {
  const key = `${name}_${date}`;
  const data = await chrome.storage.local.get([key]);
  return Number(data[key] || 0);
}

async function incCounter(name, date = todayKey()) {
  const key = `${name}_${date}`;
  const old = await getCounter(name, date);
  const next = old + 1;
  await chrome.storage.local.set({ [key]: next });
  return next;
}

async function hasPostRecord(name, postId, date = todayKey()) {
  const key = `${name}_${date}`;
  const data = await chrome.storage.local.get([key]);
  const obj = data[key] || {};
  return Boolean(obj[String(postId)]);
}

async function setPostRecord(name, postId, value, date = todayKey()) {
  const key = `${name}_${date}`;
  const data = await chrome.storage.local.get([key]);
  const obj = data[key] || {};
  obj[String(postId)] = value || { time: new Date().toISOString() };
  await chrome.storage.local.set({ [key]: obj });
  return obj;
}

async function runAttendance(options = {}) {
  const { source = "manual", force = false, createTab = true, activeTab = true, tabId = null } = options;
  const settings = await getSettings();
  const pause = await getPauseState();

  if (pause.paused && !force) {
    const result = { ok: false, skipped: true, reason: `已暂停到 ${pause.pauseUntilText}`, source };
    await saveLog("attendance", result);
    return result;
  }

  if (!settings.attendance.enabled && !force) {
    const result = { ok: false, skipped: true, reason: "签到已禁用", source };
    await saveLog("attendance", result);
    return result;
  }

  const doneKey = `attendance_done_${todayKey()}`;
  const doneState = await chrome.storage.local.get([doneKey]);

  if (doneState[doneKey] && !force) {
    const result = { ok: true, skipped: true, reason: "今天已经尝试过签到", source };
    await saveLog("attendance", result);
    return result;
  }

  let tab = null;

  try {
    if (tabId) {
      tab = await chrome.tabs.get(tabId);
      if (!isNodeseekUrl(tab.url || "")) {
        if (!createTab) {
          const result = { ok: false, skipped: true, reason: "当前页面不是 NodeSeek 页面", source };
          await saveLog("attendance", result);
          return result;
        }
        tab = await ensureNodeseekTab(true, activeTab);
      } else {
        tab = await waitTabComplete(tab.id);
      }
    } else {
      tab = await ensureNodeseekTab(createTab, activeTab);
    }

    if (!tab || !tab.id) {
      const result = { ok: false, skipped: true, reason: "没有可用的 NodeSeek 页面", source };
      await saveLog("attendance", result);
      return result;
    }

    const pageResult = await executeInMainWorld(tab.id, async () => {
      await new Promise(resolve => setTimeout(resolve, 1200));
      let httpStatus = 0;
      let rawText = "";
      let data = null;

      try {
        const res = await fetch("/api/attendance?random=true", {
          method: "POST",
          credentials: "include",
          headers: { "accept": "application/json" }
        });

        httpStatus = res.status;
        rawText = await res.text();

        try { data = JSON.parse(rawText); } catch (e) { data = null; }

        const msg = String(data && data.message || "");
        const ok = data && (
          data.success === true ||
          msg.includes("已完成签到") ||
          msg.includes("请勿重复操作") ||
          msg.includes("今天已完成签到")
        );

        return {
          ok: Boolean(ok),
          httpStatus,
          data,
          rawText,
          pageHref: location.href,
          pageTitle: document.title,
          runContext: "page-main-world"
        };
      } catch (err) {
        return {
          ok: false,
          httpStatus,
          data,
          rawText,
          error: String(err && err.message || err),
          pageHref: location.href,
          pageTitle: document.title,
          runContext: "page-main-world"
        };
      }
    });

    const result = Object.assign({}, pageResult, { source, tabId: tab.id });

    if (result.ok) {
      await chrome.storage.local.set({
        [doneKey]: { time: new Date().toISOString(), source, result }
      });
      await notify("NodeSeek 签到", result.data?.message || "签到完成");
    } else if (isRiskLike(result)) {
      const pauseUntil = await setRiskPause(settings.comment.pauseOnRiskHours, "attendance risk");
      result.pauseUntil = new Date(pauseUntil).toLocaleString();
      await notify("NodeSeek 已暂停", `检测到风险提示，暂停到 ${result.pauseUntil}`);
    }

    await saveLog("attendance", result);
    return result;
  } catch (err) {
    const result = { ok: false, source, error: String(err && err.message || err) };
    await saveLog("attendance", result);
    return result;
  }
}

async function scheduleAttendanceAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(ATTENDANCE_ALARM_NAME);

  if (!settings.attendance.enabled) {
    await chrome.storage.local.set({ nextAttendanceAlarmAt: "" });
    return;
  }

  const now = new Date();
  const next = new Date();
  next.setHours(Number(settings.attendance.hour) || 9, Number(settings.attendance.minute) || 10, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);

  chrome.alarms.create(ATTENDANCE_ALARM_NAME, {
    when: next.getTime(),
    periodInMinutes: 24 * 60
  });

  await chrome.storage.local.set({ nextAttendanceAlarmAt: next.toLocaleString() });
}

function pickRandomComment(pool) {
  const arr = (Array.isArray(pool) ? pool : [])
    .map(s => String(s || "").trim())
    .filter(Boolean);
  if (arr.length === 0) return "感谢分享";
  return arr[Math.floor(Math.random() * arr.length)];
}

async function generateCommentDraft(postId) {
  const settings = await getSettings();
  const pause = await getPauseState();

  if (!settings.comment.enabled) {
    return { ok: false, skipped: true, reason: "评论助手已禁用" };
  }

  if (pause.paused) {
    return { ok: false, skipped: true, reason: `已暂停到 ${pause.pauseUntilText}` };
  }

  const draftCount = await getCounter("comment_draft_count");
  if (draftCount >= Number(settings.comment.dailyDraftLimit || 0)) {
    return { ok: false, skipped: true, reason: "今日草稿生成数量已达上限", draftCount };
  }

  if (postId && await hasPostRecord("comment_drafted_posts", postId)) {
    return { ok: false, skipped: true, reason: "这个帖子今天已经生成过草稿", postId };
  }

  const content = pickRandomComment(settings.comment.comments);
  const count = await incCounter("comment_draft_count");

  if (postId) {
    await setPostRecord("comment_drafted_posts", postId, {
      time: new Date().toISOString(),
      content
    });
  }

  const result = { ok: true, postId, content, draftCount: count };
  await saveLog("comment-draft", result);
  return result;
}

async function sendComment(options = {}) {
  const { tabId, postId, content, force = false } = options;
  const settings = await getSettings();
  const pause = await getPauseState();

  if (!settings.comment.enabled && !force) {
    const result = { ok: false, skipped: true, reason: "评论助手已禁用" };
    await saveLog("comment-send", result);
    return result;
  }

  if (pause.paused && !force) {
    const result = { ok: false, skipped: true, reason: `已暂停到 ${pause.pauseUntilText}` };
    await saveLog("comment-send", result);
    return result;
  }

  if (!inTimeWindow(settings.comment.startTime, settings.comment.endTime) && !force) {
    const result = {
      ok: false,
      skipped: true,
      reason: `当前不在允许发送时间段 ${settings.comment.startTime} - ${settings.comment.endTime}`
    };
    await saveLog("comment-send", result);
    return result;
  }

  const normalizedContent = String(content || "").trim();
  const nPostId = Number(postId);

  if (!nPostId || !normalizedContent) {
    const result = { ok: false, reason: "缺少 postId 或评论内容" };
    await saveLog("comment-send", result);
    return result;
  }

  const sendCount = await getCounter("comment_send_count");
  if (sendCount >= Number(settings.comment.dailySendLimit || 0) && !force) {
    const result = { ok: false, skipped: true, reason: "今日确认发送数量已达上限", sendCount };
    await saveLog("comment-send", result);
    return result;
  }

  if (await hasPostRecord("comment_sent_posts", nPostId) && !force) {
    const result = { ok: false, skipped: true, reason: "这个帖子今天已经发送过评论", postId: nPostId };
    await saveLog("comment-send", result);
    return result;
  }

  try {
    const result = await executeInMainWorld(tabId, async (pid, text) => {
      let httpStatus = 0;
      let rawText = "";
      let data = null;

      try {
        const res = await fetch("/api/content/new-comment", {
          method: "POST",
          credentials: "include",
          headers: {
            "accept": "application/json",
            "content-type": "application/json"
          },
          body: JSON.stringify({
            content: text,
            mode: "new-comment",
            postId: Number(pid)
          })
        });

        httpStatus = res.status;
        rawText = await res.text();

        try { data = JSON.parse(rawText); } catch (e) { data = null; }

        const msg = String(data && data.message || "");
        const ok = data && data.success === true;

        return {
          ok: Boolean(ok),
          httpStatus,
          data,
          rawText,
          pageHref: location.href,
          pageTitle: document.title,
          runContext: "page-main-world"
        };
      } catch (err) {
        return {
          ok: false,
          httpStatus,
          data,
          rawText,
          error: String(err && err.message || err),
          pageHref: location.href,
          pageTitle: document.title,
          runContext: "page-main-world"
        };
      }
    }, [nPostId, normalizedContent]);

    result.postId = nPostId;
    result.content = normalizedContent;

    if (result.ok) {
      const count = await incCounter("comment_send_count");
      await setPostRecord("comment_sent_posts", nPostId, {
        time: new Date().toISOString(),
        content: normalizedContent,
        result
      });
      result.sendCount = count;
      await notify("NodeSeek 评论已发送", normalizedContent.slice(0, 40));
    } else if (isRiskLike(result)) {
      const pauseUntil = await setRiskPause(settings.comment.pauseOnRiskHours, "comment risk");
      result.pauseUntil = new Date(pauseUntil).toLocaleString();
      await notify("NodeSeek 已暂停", `检测到风险提示，暂停到 ${result.pauseUntil}`);
    }

    await saveLog("comment-send", result);
    return result;
  } catch (err) {
    const result = { ok: false, postId: nPostId, error: String(err && err.message || err) };
    await saveLog("comment-send", result);
    return result;
  }
}

async function getState() {
  const data = await chrome.storage.local.get([
    "settings",
    "lastResult",
    "logs",
    "nextAttendanceAlarmAt",
    "pauseUntil",
    "pauseReason",
    `comment_draft_count_${todayKey()}`,
    `comment_send_count_${todayKey()}`
  ]);

  const settings = deepMerge(DEFAULT_SETTINGS, data.settings || {});
  const pause = await getPauseState();

  return {
    settings,
    lastResult: data.lastResult || null,
    logs: Array.isArray(data.logs) ? data.logs : [],
    nextAttendanceAlarmAt: data.nextAttendanceAlarmAt || "",
    pause,
    today: {
      date: todayKey(),
      draftCount: Number(data[`comment_draft_count_${todayKey()}`] || 0),
      sendCount: Number(data[`comment_send_count_${todayKey()}`] || 0)
    }
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(["settings"]);
  if (!data.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  await scheduleAttendanceAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAttendanceAlarm();
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ATTENDANCE_ALARM_NAME) return;

  const settings = await getSettings();
  if (settings.attendance.openTabOnAlarm) {
    await runAttendance({
      source: "alarm",
      force: false,
      createTab: true,
      activeTab: true
    });
  } else {
    const result = {
      ok: false,
      skipped: true,
      reason: "定时已触发，但未开启到点打开页面签到",
      source: "alarm"
    };
    await saveLog("attendance", result);
  }

  await scheduleAttendanceAlarm();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === "GET_STATE") {
        sendResponse(await getState());
        return;
      }

      if (message?.type === "SAVE_SETTINGS") {
        const settings = await setSettings(message.settings || {});
        sendResponse({ ok: true, settings, state: await getState() });
        return;
      }

      if (message?.type === "DO_ATTENDANCE") {
        const result = await runAttendance({
          source: message.source || "popup",
          force: Boolean(message.force),
          createTab: message.createTab !== false,
          activeTab: message.activeTab !== false,
          tabId: message.tabId || null
        });
        sendResponse(result);
        return;
      }

      if (message?.type === "DO_ATTENDANCE_FROM_CONTENT") {
        const settings = await getSettings();
        if (!settings.attendance.autoWhenVisit) {
          sendResponse({ ok: false, skipped: true, reason: "访问页面自动签到未启用" });
          return;
        }
        const result = await runAttendance({
          source: message.source || "visit",
          force: false,
          createTab: false,
          activeTab: false,
          tabId: sender?.tab?.id || null
        });
        sendResponse(result);
        return;
      }

      if (message?.type === "GENERATE_COMMENT_DRAFT") {
        const result = await generateCommentDraft(message.postId);
        sendResponse(result);
        return;
      }

      if (message?.type === "SEND_COMMENT") {
        const result = await sendComment({
          tabId: sender?.tab?.id || message.tabId,
          postId: message.postId,
          content: message.content,
          force: Boolean(message.force)
        });
        sendResponse(result);
        return;
      }

      if (message?.type === "CLEAR_PAUSE") {
        await clearPause();
        sendResponse({ ok: true, state: await getState() });
        return;
      }

      if (message?.type === "RESET_TODAY") {
        const date = todayKey();
        await chrome.storage.local.remove([
          `attendance_done_${date}`,
          `comment_draft_count_${date}`,
          `comment_send_count_${date}`,
          `comment_drafted_posts_${date}`,
          `comment_sent_posts_${date}`
        ]);
        sendResponse({ ok: true, removedDate: date, state: await getState() });
        return;
      }

      if (message?.type === "CLEAR_LOGS") {
        await chrome.storage.local.remove(["logs", "lastResult"]);
        sendResponse({ ok: true, state: await getState() });
        return;
      }

      sendResponse({ ok: false, error: "unknown message type" });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
  })();

  return true;
});
