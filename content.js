(async function () {
  try {
    // 避免一个页面反复触发。
    if (window.__NODESEEK_ATTENDANCE_VISIT_TRIGGERED__) return;
    window.__NODESEEK_ATTENDANCE_VISIT_TRIGGERED__ = true;

    // 等页面稳定后再交给后台注入到 MAIN world 执行。
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: "DO_ATTENDANCE_FROM_CONTENT",
        source: "visit",
        force: false
      }, result => {
        if (chrome.runtime.lastError) {
          console.log("[NodeSeek] 自动签到消息失败:", chrome.runtime.lastError.message);
          return;
        }
        console.log("[NodeSeek] 页面访问触发签到结果:", result);
      });
    }, 3000);
  } catch (e) {
    console.log("[NodeSeek] content script error:", e);
  }
})();
