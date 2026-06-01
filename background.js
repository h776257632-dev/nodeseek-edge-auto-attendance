const ALARM_NAME = "nodeseek_auto_attendance_alarm";
const BOARD_URL = "https://www.nodeseek.com/board";

const DEFAULT_SETTINGS = {
  enabled: true,
  hour: 9,
  minute: 10,
  autoWhenVisit: true,
  openTabOnAlarm: true,
  notify: true
};

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getSettings() {
  const data = await chrome.storage.local.get(["settings"]);
  return Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
}

function isNodeseekUrl(url) {
  return typeof url === "string" && /^https:\/\/www\.nodeseek\.com\//.test(url);
}

function isSuccessLike(data) {
  const msg = String(data?.message || "");
  return data?.success === true ||
    msg.includes("已完成签到") ||
    msg.includes("请勿重复操作") ||
    msg.includes("今天已完成签到");
}

async function saveLog(result) {
  const logItem = {
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
    logs: logs.slice(0, 50)
  });

  return logItem;
}

async function notify(title, message) {
  const settings = await getSettings();
  if (!settings.notify) return;

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
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") return tab;
    } catch (e) {
      throw e;
    }
    await sleep(300);
  }

  return await chrome.tabs.get(tabId);
}

async function findReusableNodeseekTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.nodeseek.com/*" });
  if (tabs.length > 0) {
    const activeTab = tabs.find(t => t.active) || tabs[0];
    return activeTab;
  }
  return null;
}

async function ensureNodeseekTab(createIfMissing = true, active = true) {
  let tab = await findReusableNodeseekTab();

  if (!tab && createIfMissing) {
    tab = await chrome.tabs.create({
      url: BOARD_URL,
      active
    });
  }

  if (!tab) {
    return null;
  }

  if (!isNodeseekUrl(tab.url || "")) {
    await chrome.tabs.update(tab.id, { url: BOARD_URL, active });
    tab = await waitTabComplete(tab.id);
  } else {
    tab = await waitTabComplete(tab.id);
  }

  return tab;
}

async function injectAttendanceInPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

      // 稍等一下，确保页面登录态、Service Worker、站点脚本都初始化完成。
      await sleep(1200);

      const url = "/api/attendance?random=true";
      let httpStatus = 0;
      let rawText = "";
      let data = null;

      try {
        const res = await fetch(url, {
          method: "POST",
          credentials: "include",
          headers: {
            "accept": "application/json"
          }
        });

        httpStatus = res.status;
        rawText = await res.text();

        try {
          data = JSON.parse(rawText);
        } catch (e) {
          data = null;
        }

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
    }
  });

  return results && results[0] ? results[0].result : {
    ok: false,
    error: "没有拿到页面执行结果"
  };
}

async function runAttendance(options = {}) {
  const {
    source = "manual",
    force = false,
    createTab = true,
    activeTab = true,
    tabId = null
  } = options;

  const settings = await getSettings();

  if (!settings.enabled && !force) {
    const result = {
      ok: false,
      skipped: true,
      reason: "插件已禁用",
      source
    };
    await saveLog(result);
    return result;
  }

  const doneKey = `done_${todayKey()}`;
  const doneState = await chrome.storage.local.get([doneKey]);

  if (doneState[doneKey] && !force) {
    const result = {
      ok: true,
      skipped: true,
      reason: "今天已经尝试过签到",
      source
    };
    await saveLog(result);
    return result;
  }

  let tab = null;

  try {
    if (tabId) {
      tab = await chrome.tabs.get(tabId);
      if (!isNodeseekUrl(tab.url || "")) {
        if (!createTab) {
          const result = {
            ok: false,
            skipped: true,
            reason: "当前页面不是 NodeSeek 页面",
            source
          };
          await saveLog(result);
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
      const result = {
        ok: false,
        skipped: true,
        reason: "没有可用的 NodeSeek 页面",
        source
      };
      await saveLog(result);
      return result;
    }

    const pageResult = await injectAttendanceInPage(tab.id);

    const result = Object.assign({}, pageResult, {
      source,
      tabId: tab.id
    });

    if (result.ok) {
      await chrome.storage.local.set({
        [doneKey]: {
          time: new Date().toISOString(),
          source,
          result
        }
      });

      const msg = result.data?.message || "签到完成";
      await notify("NodeSeek 签到", msg);
    } else {
      const msg = result.data?.message || result.error || `HTTP ${result.httpStatus || 0}`;
      await notify("NodeSeek 签到可能失败", msg);
    }

    await saveLog(result);
    return result;
  } catch (err) {
    const result = {
      ok: false,
      source,
      error: String(err && err.message || err)
    };
    await saveLog(result);
    await notify("NodeSeek 签到请求异常", result.error);
    return result;
  }
}

async function scheduleAlarm() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_NAME);

  if (!settings.enabled) {
    await chrome.storage.local.set({ nextAlarmAt: "" });
    return;
  }

  const now = new Date();
  const next = new Date();
  next.setHours(Number(settings.hour) || 9, Number(settings.minute) || 10, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  chrome.alarms.create(ALARM_NAME, {
    when: next.getTime(),
    periodInMinutes: 24 * 60
  });

  await chrome.storage.local.set({
    nextAlarmAt: next.toLocaleString()
  });

  console.log("[NodeSeek] 下一次定时尝试:", next.toLocaleString());
}

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(["settings"]);
  if (!data.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
  await scheduleAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarm();
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;

  const settings = await getSettings();

  if (!settings.openTabOnAlarm) {
    const result = {
      ok: false,
      skipped: true,
      reason: "定时已触发，但未开启到点打开页面签到",
      source: "alarm"
    };
    await saveLog(result);
    return;
  }

  await runAttendance({
    source: "alarm",
    force: false,
    createTab: true,
    activeTab: true
  });

  await scheduleAlarm();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
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
      const result = await runAttendance({
        source: message.source || "visit",
        force: Boolean(message.force),
        createTab: false,
        activeTab: false,
        tabId: sender?.tab?.id || null
      });
      sendResponse(result);
      return;
    }

    if (message?.type === "GET_STATE") {
      const data = await chrome.storage.local.get(["settings", "lastResult", "logs", "nextAlarmAt"]);
      sendResponse({
        settings: Object.assign({}, DEFAULT_SETTINGS, data.settings || {}),
        lastResult: data.lastResult || null,
        logs: Array.isArray(data.logs) ? data.logs : [],
        nextAlarmAt: data.nextAlarmAt || ""
      });
      return;
    }

    if (message?.type === "SAVE_SETTINGS") {
      const settings = Object.assign({}, DEFAULT_SETTINGS, message.settings || {});
      await chrome.storage.local.set({ settings });
      await scheduleAlarm();
      const data = await chrome.storage.local.get(["nextAlarmAt"]);
      sendResponse({ ok: true, settings, nextAlarmAt: data.nextAlarmAt || "" });
      return;
    }

    if (message?.type === "RESET_TODAY") {
      const doneKey = `done_${todayKey()}`;
      await chrome.storage.local.remove([doneKey]);
      sendResponse({ ok: true, removed: doneKey });
      return;
    }

    sendResponse({ ok: false, error: "unknown message type" });
  })();

  return true;
});
