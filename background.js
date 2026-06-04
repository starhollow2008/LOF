// Background service worker for osu! Local Favorites
// Handles badge updates and messaging

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'updateBadge') {
    chrome.storage.local.get('favorites', ({ favorites }) => {
      const count = favorites ? Object.keys(favorites).length : 0;
      if (count > 0) {
        chrome.action.setBadgeText({ text: String(count) });
        chrome.action.setBadgeBackgroundColor({ color: '#ff66aa' });
      } else {
        chrome.action.setBadgeText({ text: '' });
      }
    });
    sendResponse({ success: true });
    return true;
  }
});

// Initialize badge on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('favorites', ({ favorites }) => {
    const count = favorites ? Object.keys(favorites).length : 0;
    if (count > 0) {
      chrome.action.setBadgeText({ text: String(count) });
      chrome.action.setBadgeBackgroundColor({ color: '#ff66aa' });
    }
  });
});
