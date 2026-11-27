# LINE 記帳機器人

群組裡丟「(日期) 品項 金額」→ 自動記到 Google 試算表，可查今日／本週／本月花費。

## 架構
- `loader.gs`：貼在 Google Apps Script 裡（只貼一次），部署成網頁應用程式當 LINE Webhook
- `bot.js`：主程式。loader 每次執行時從這個 repo 下載（快取 5 分鐘）

## 更新程式
改 `bot.js` → push 到 `main`，約 5～10 分鐘後生效。
想立刻生效：Apps Script 編輯器選 `clearCache` 執行。

## 設定
Apps Script「專案設定 → 指令碼屬性」：`LINE_TOKEN` = Channel access token

⚠️ 這個 repo 的程式會以你的 Google 帳號身分執行，不要給別人寫入權限，也不要把 token 寫進程式。
