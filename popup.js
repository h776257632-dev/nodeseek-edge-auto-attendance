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

let currentState = null;

function poolToText(arr) {
  return (Array.isArray(arr) ? arr : []).join("\n");
}

function textToPool(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

function getSettingsFromForm() {
  return {
    attendance: {
      enabled: $("attEnabled").checked,
      autoWhenVisit: $("attAutoVisit").checked,
      openTabOnAlarm: $("attOpenTab").checked,
      notify: $("notify").checked,
      hour: Math.max(0, Math.min(23, Number($("attHour").value || 9))),
      minute: Math.max(0, Math.min(59, Number($("attMinute").value || 10)))
    },
    comment: {
      enabled: $("comEnabled").checked,
      autoFillDraft: $("comAutoFill").checked,
      dailyDraftLimit: Math.max(0, Math.min(99, Number($("dailyDraftLimit").value || 5))),
      dailySendLimit: Math.max(0, Math.min(99, Number($("dailySendLimit").value || 3))),
      startTime: $("startTime").value || "09:00",
      endTime: $("endTime").value || "23:30",
      pauseOnRiskHours: Math.max(1, Math.min(168, Number($("pauseHours").value || 72))),
      comments: textToPool($("commentPool").value)
    }
  };
}

function setFormFromSettings(settings) {
  const a = settings.attendance || {};
  const c = settings.comment || {};

  $("attEnabled").checked = !!a.enabled;
  $("attAutoVisit").checked = !!a.autoWhenVisit;
  $("attOpenTab").checked = !!a.openTabOnAlarm;
  $("notify").checked = !!a.notify;
  $("attHour").value = Number(a.hour ?? 9);
  $("attMinute").value = Number(a.minute ?? 10);

  $("comEnabled").checked = !!c.enabled;
  $("comAutoFill").checked = !!c.autoFillDraft;
  $("dailyDraftLimit").value = Number(c.dailyDraftLimit ?? 5);
  $("dailySendLimit").value = Number(c.dailySendLimit ?? 3);
  $("startTime").value = c.startTime || "09:00";
  $("endTime").value = c.endTime || "23:30";
  $("pauseHours").value = Number(c.pauseOnRiskHours ?? 72);
  $("commentPool").value = poolToText(c.comments || []);
}

async function loadState() {
  try {
    currentState = await sendMessage({ type: "GET_STATE" });
    setFormFromSettings(currentState.settings || {});

    $("nextAlarm").textContent = currentState.nextAttendanceAlarmAt
      ? `下一次签到定时：${currentState.nextAttendanceAlarmAt}`
      : "下一次签到定时：未设置";

    const pauseText = currentState.pause?.paused
      ? `已暂停到：${currentState.pause.pauseUntilText}`
      : "未暂停";

    setStatus(`今日：草稿 ${currentState.today?.draftCount || 0} 条，确认发送 ${currentState.today?.sendCount || 0} 条；${pauseText}`, !currentState.pause?.paused);

    showResult({
      today: currentState.today,
      pause: currentState.pause,
      nextAttendanceAlarmAt: currentState.nextAttendanceAlarmAt,
      lastResult: currentState.lastResult,
      recentLogs: (currentState.logs || []).slice(0, 10)
    });
  } catch (e) {
    setStatus(`读取失败：${e.message}`, false);
  }
}

async function saveSettings() {
  const settings = getSettingsFromForm();
  const res = await sendMessage({ type: "SAVE_SETTINGS", settings });
  setStatus("设置已保存");
  showResult(res);
  await loadState();
}

async function signNow() {
  $("signBtn").disabled = true;
  setStatus("正在签到，会打开或复用 NodeSeek 页面...");
  try {
    const res = await sendMessage({
      type: "DO_ATTENDANCE",
      source: "popup",
      force: false,
      createTab: true,
      activeTab: true
    });
    setStatus(res.ok ? "签到完成或今日已签到" : (res.reason || res.error || res.data?.message || "签到可能失败"), !!res.ok);
    showResult(res);
    await loadState();
  } catch (e) {
    setStatus(`签到失败：${e.message}`, false);
  } finally {
    $("signBtn").disabled = false;
  }
}

async function resetToday() {
  const res = await sendMessage({ type: "RESET_TODAY" });
  setStatus("已清除今日本地记录");
  showResult(res);
  await loadState();
}

async function clearPause() {
  const res = await sendMessage({ type: "CLEAR_PAUSE" });
  setStatus("已解除暂停");
  showResult(res);
  await loadState();
}

async function clearLogs() {
  const res = await sendMessage({ type: "CLEAR_LOGS" });
  setStatus("日志已清空");
  showResult(res);
  await loadState();
}

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

$("saveAttBtn").addEventListener("click", saveSettings);
$("saveComBtn").addEventListener("click", saveSettings);
$("signBtn").addEventListener("click", signNow);
$("resetTodayBtn").addEventListener("click", resetToday);
$("clearPauseBtn").addEventListener("click", clearPause);
$("clearLogsBtn").addEventListener("click", clearLogs);

loadState();
