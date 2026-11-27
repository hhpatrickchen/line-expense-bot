// LINE 記帳機器人 載入器：貼進 Apps Script 一次就好，之後只改 GitHub 上的 bot.js
const CODE_URL = 'https://raw.githubusercontent.com/hhpatrickchen/line-expense-bot/main/bot.js';

function loadBot_() {
  const cache = CacheService.getScriptCache();
  let code = cache.get('bot_code');
  if (!code) {
    const res = UrlFetchApp.fetch(CODE_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('下載 bot.js 失敗：' + res.getResponseCode());
    code = res.getContentText();
    cache.put('bot_code', code, 300); // 快取 5 分鐘
  }
  return new Function(code + '\n;return { handlePost: handlePost, testToken: testToken };')();
}

function doPost(e) { return loadBot_().handlePost(e); }
function testToken() { loadBot_().testToken(); }
function clearCache() { CacheService.getScriptCache().remove('bot_code'); } // 想立刻換新版就執行這個
