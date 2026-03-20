(function () {
  'use strict';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'iconState') {
      if (msg.state === 'idle') {
        chrome.action.setBadgeText({ text: '' });
      }
      sendResponse({ ok: true });
    } else if (msg.type === 'updateBadge') {
      const speedText = msg.speed.toFixed(1) + 'x';
      chrome.action.setBadgeText({ text: speedText });
      chrome.action.setBadgeBackgroundColor({ color: '#4b5563' }); // 灰色角标，匹配图片
      sendResponse({ ok: true });
    }
    return true;
  });

  chrome.runtime.onInstalled.addListener(() => {
    chrome.action.setBadgeText({ text: '' });
  });
})();
