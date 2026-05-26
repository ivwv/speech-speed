(function () {
  'use strict';

  function getTabId(sender) {
    return sender && sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : undefined;
  }

  function setBadge(tabId, text) {
    const options = { text };
    if (tabId !== undefined) options.tabId = tabId;
    chrome.action.setBadgeText(options);
  }

  function setBadgeColor(tabId, color) {
    const options = { color };
    if (tabId !== undefined) options.tabId = tabId;
    chrome.action.setBadgeBackgroundColor(options);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const tabId = getTabId(sender);

    if (msg.type === 'iconState') {
      if (msg.state === 'idle' || msg.state === 'disabled' || msg.state === 'waiting') {
        setBadge(tabId, '');
      } else if (msg.state === 'error') {
        setBadge(tabId, '!');
        setBadgeColor(tabId, '#dc2626');
      }
      sendResponse({ ok: true });
    } else if (msg.type === 'updateBadge') {
      const speed = Number(msg.speed);
      if (Number.isFinite(speed)) {
        setBadge(tabId, speed.toFixed(1) + 'x');
        setBadgeColor(tabId, '#4b5563');
      }
      sendResponse({ ok: true });
    }
    return true;
  });

  chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setBadgeText({ text: '' });
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      setBadge(tabId, '');
    }
  });
})();
