chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    if (tab && tab.windowId) await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    // 老版本浏览器没有 sidePanel.open，交给 setPanelBehavior 兜底
  }
});
