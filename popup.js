const $ = id => document.getElementById(id);

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

function showResult(obj) {
  $("result").textContent = JSON.stringify(obj, null, 2);
}

function setStatus(text, ok = true) {
  $("status").textContent = text;
  $("status").className = ok ? "small ok" : "small bad";
}

async function loadState() {
  try {
    const state = await sendMessage({ type: "GET_STATE" });
    const settings = state.settings || {};

    $("enabled").checked = !!settings.enabled;
    $("autoWhenVisit").checked = !!settings.autoWhenVisit;
    $("openTabOnAlarm").checked = !!settings.openTabOnAlarm;
    $("notify").checked = !!settings.notify;
    $("hour").value = Number(settings.hour ?? 9);
    $("minute").value = Number(settings.minute ?? 10);

    $("nextAlarm").textContent = state.nextAlarmAt
      ? `下一次定时尝试：${state.nextAlarmAt}`
      : "下一次定时尝试：未设置";

    if (state.lastResult) {
      setStatus(`最近一次：${state.lastResult.time}`);
      showResult(state.lastResult.result);
    } else {
      setStatus("还没有签到记录");
      showResult({});
    }
  } catch (e) {
    setStatus(`读取失败：${e.message}`, false);
  }
}

async function saveSettings() {
  const settings = {
    enabled: $("enabled").checked,
    autoWhenVisit: $("autoWhenVisit").checked,
    openTabOnAlarm: $("openTabOnAlarm").checked,
    notify: $("notify").checked,
    hour: Math.max(0, Math.min(23, Number($("hour").value || 9))),
    minute: Math.max(0, Math.min(59, Number($("minute").value || 10)))
  };

  const res = await sendMessage({
    type: "SAVE_SETTINGS",
    settings
  });

  setStatus("设置已保存");
  showResult(res);
  await loadState();
}

async function sign(force) {
  $("signBtn").disabled = true;
  $("forceBtn").disabled = true;
  setStatus(force ? "正在强制重试，会打开或复用 NodeSeek 页面..." : "正在签到，会打开或复用 NodeSeek 页面...");

  try {
    const res = await sendMessage({
      type: "DO_ATTENDANCE",
      source: force ? "popup_force" : "popup",
      force,
      createTab: true,
      activeTab: true
    });

    if (res.ok) {
      setStatus("签到完成或今日已签到");
    } else {
      setStatus("签到可能失败，请看返回信息", false);
    }

    showResult(res);
    await loadState();
  } catch (e) {
    setStatus(`请求失败：${e.message}`, false);
  } finally {
    $("signBtn").disabled = false;
    $("forceBtn").disabled = false;
  }
}

async function resetToday() {
  const res = await sendMessage({ type: "RESET_TODAY" });
  setStatus("已清除今日本地记录");
  showResult(res);
  await loadState();
}

$("saveBtn").addEventListener("click", saveSettings);
$("signBtn").addEventListener("click", () => sign(false));
$("forceBtn").addEventListener("click", () => sign(true));
$("resetBtn").addEventListener("click", resetToday);

loadState();
