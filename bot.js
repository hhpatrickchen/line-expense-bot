/**
 * LINE 記帳機器人 主程式（由 Apps Script 的 loader 自動下載執行）
 * 改這個檔案 push 到 GitHub，約 5～10 分鐘後機器人自動換新版，不用重新部署。
 * 注意：這裡不要放任何密碼或 token。
 */

const SHEET_NAME = '記帳';
const TZ = 'Asia/Taipei';
const HEADER = ['日期', '記錄時間', '聊天室ID', '使用者ID', '名字', '品項', '金額'];
const HELP =
  '📒 記帳機器人用法\n' +
  '記帳（日期可省略＝今天）：\n' +
  '  漢堡王 447\n' +
  '  11/7 牛奶 331\n' +
  '  11/20 全聯1627 玉米片 起司\n' +
  '  （品項、金額可以換行寫）\n' +
  '查詢：今日、本週、上週、本月、上月\n' +
  '查某天：11/20\n' +
  '刪除：刪除（刪掉你最後一筆）';

// 數字後面接這些字 → 是數量／時間，不是金額
const QTY_UNITS = '條|個|包|盒|顆|斤|兩|瓶|罐|片|份|袋|入|支|隻|件|串|把|粒|杯|碗|盤|根|張|本|台|雙|公斤|公克|克|kg|g|ml|l|點|號|樓|歲|人|次|天|週|周|月|年|分|秒|小時|%';

// ---------- 入口 ----------
function handlePost(e) {
  if (!e || !e.postData) return ContentService.createTextOutput('請由 LINE 觸發，不要手動執行');
  const body = JSON.parse(e.postData.contents);
  (body.events || []).forEach(function (ev) {
    try {
      handleEvent(ev);
    } catch (err) {
      console.error(err);
    }
  });
  return ContentService.createTextOutput('OK');
}

function handleEvent(ev) {
  if (ev.type !== 'message' || ev.message.type !== 'text') return;
  const src = ev.source;
  const chatId = src.groupId || src.roomId || src.userId;
  const text = ev.message.text.trim();
  const reply = buildReply(chatId, src, text);
  if (reply) replyMessage(ev.replyToken, reply); // 一般聊天不回應
}

function buildReply(chatId, src, text) {
  const cmd = text.replace(/\s+/g, '');
  if (['今日', '今天', '今日花費'].includes(cmd)) return dayReport(chatId, today());
  if (['本週', '這週', '本周', '這周', '週報'].includes(cmd)) return weeklyReport(chatId, 0);
  if (['上週', '上周'].includes(cmd)) return weeklyReport(chatId, -1);
  if (['本月', '這個月', '月報'].includes(cmd)) return monthlyReport(chatId, 0);
  if (['上月', '上個月'].includes(cmd)) return monthlyReport(chatId, -1);
  if (['刪除', '取消', '撤銷'].includes(cmd)) {
    const row = deleteLast(chatId, src.userId);
    return row ? '🗑 已刪除：' + md(row.date) + ' ' + row.item + ' ' + fmt(row.amount) : '你還沒有紀錄可以刪';
  }
  if (['說明', 'help', '幫助'].includes(cmd)) return HELP;

  // 只打日期 → 查那天
  const onlyDate = parseLeadingDate(cmd);
  if (onlyDate && !onlyDate.rest) return dayReport(chatId, onlyDate.date);

  const p = parseExpense(text);
  if (!p) return null;
  addExpense(p.date, chatId, src.userId, displayName(src), p.item, p.amount);
  const dayTotal = sum(fetchRows(chatId, p.date, p.date));
  const label = p.date === today() ? '今日' : md(p.date) + ' 當日';
  return '✅ ' + md(p.date) + ' ' + p.item + '\n💰 ' + fmt(p.amount) + ' 元\n' + label + '累計：' + fmt(dayTotal) + ' 元';
}

// ---------- 解析 ----------
/** 開頭的日期：11/4、11／4、2025/11/4、11月4日 → yyyy-MM-dd */
function parseLeadingDate(text) {
  const m = text.match(/^\s*(?:(\d{4})\s*[\/／\-.年]\s*)?(\d{1,2})\s*[\/／月]\s*(\d{1,2})\s*[日號]?(?!\d)/);
  if (!m) return null;
  const mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  let y = m[1] ? Number(m[1]) : Number(today().slice(0, 4));
  let date = y + '-' + pad(mo) + '-' + pad(d);
  if (!m[1] && date > today()) date = (y - 1) + '-' + pad(mo) + '-' + pad(d); // 沒寫年份又在未來 → 去年
  return { date: date, rest: text.slice(m[0].length).trim() };
}

/**
 * 解析一則記帳訊息，支援：
 *   漢堡王 447 / 梅花豬兩塊 1000 / 買菜1000\n高麗菜\n地瓜
 *   11/4 全聯156 絞肉 蘿蔔糕粉 / 11/22 牛奶、牛肉\n867 / 11/8\n豬五花3條 1047
 * 一則訊息有多個金額時會加總。
 */
function parseExpense(text) {
  let date = today();
  let body = text.trim();
  const d = parseLeadingDate(body);
  if (d) {
    date = d.date;
    body = d.rest;
  }

  const amounts = [];
  const re = /([$＄]\s*)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(元|塊|塊錢)?/g;
  const unitRe = new RegExp('^\\s*(?:' + QTY_UNITS + ')', 'i');
  let cleaned = body;
  let m;
  while ((m = re.exec(body)) !== null) {
    const value = parseFloat(m[2].replace(/,/g, ''));
    const after = body.slice(m.index + m[0].length);
    const hasMoneyMark = !!(m[1] || (m[3] && m[3] !== '塊') || (m[3] === '塊' && value >= 10));
    const isQty = !m[1] && !m[3] && unitRe.test(after);
    const isQtyBlock = m[3] === '塊' && value < 10; // 「3塊」多半是數量
    const glued = /[A-Za-z]$/.test(body.slice(0, m.index)); // 型號如 A4
    if (isQty || isQtyBlock || glued || !(value > 0)) continue;
    if (!hasMoneyMark && value < 1) continue;
    amounts.push(value);
    cleaned = cleaned.replace(m[0], ' ');
  }
  if (!amounts.length) return null;

  const item = cleaned
    .split(/[\s、,，;；\/]+/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s; })
    .join('、');
  if (!item) return null; // 只有數字不記

  return { date: date, item: item, amount: amounts.reduce(function (a, b) { return a + b; }, 0) };
}

// ---------- 試算表 ----------
function sheet() {
  const ss = getSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADER);
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@'); // 日期存成文字，避免被自動轉格式
  } else if (sh.getRange(1, 1).getValue() !== '日期') {
    migrateOldSheet(sh);
  }
  return sh;
}

/** 舊版（沒有日期欄）→ 新版：前面插一欄日期，用記錄時間補上 */
function migrateOldSheet(sh) {
  sh.insertColumnBefore(1);
  sh.getRange(1, 1, 1, HEADER.length).setValues([HEADER]);
  sh.getRange('A:A').setNumberFormat('@');
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    const times = sh.getRange(2, 2, n, 1).getValues();
    sh.getRange(2, 1, n, 1).setValues(times.map(function (t) { return [t[0] ? ymd(new Date(t[0])) : '']; }));
  }
}

function getSpreadsheet() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SHEET_ID');
  if (!id) {
    id = SpreadsheetApp.create('LINE 記帳').getId();
    props.setProperty('SHEET_ID', id);
  }
  return SpreadsheetApp.openById(id);
}

function addExpense(date, chatId, userId, name, item, amount) {
  sheet().appendRow([date, new Date(), chatId, userId, name, item, amount]);
}

function allRows() {
  const sh = sheet();
  const n = sh.getLastRow() - 1;
  if (n <= 0) return [];
  return sh.getRange(2, 1, n, HEADER.length).getValues().map(function (r, i) {
    const date = r[0] instanceof Date ? ymd(r[0]) : String(r[0]);
    return { row: i + 2, date: date, chatId: r[2], userId: r[3], name: r[4], item: r[5], amount: Number(r[6]) };
  });
}

/** 取 [from, to] 日期（含頭尾，yyyy-MM-dd）的紀錄，依日期排序 */
function fetchRows(chatId, from, to) {
  return allRows()
    .filter(function (r) { return r.chatId === chatId && r.date >= from && r.date <= to; })
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.row - b.row; });
}

function deleteLast(chatId, userId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const rows = allRows();
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].chatId === chatId && rows[i].userId === userId) {
        sheet().deleteRow(rows[i].row);
        return rows[i];
      }
    }
    return null;
  } finally {
    lock.releaseLock();
  }
}

// ---------- 日期工具（字串 yyyy-MM-dd，台北時間） ----------
function pad(n) { return (n < 10 ? '0' : '') + n; }
function ymd(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function today() { return ymd(new Date()); }
function toDate(s) { return new Date(s + 'T12:00:00+08:00'); }
function addDays(s, n) { return ymd(new Date(toDate(s).getTime() + n * 86400000)); }
function weekday(s) { return Number(Utilities.formatDate(toDate(s), TZ, 'u')); } // 1=一 … 7=日
function md(s) { return Number(s.slice(5, 7)) + '/' + Number(s.slice(8, 10)); }
const WK = ['', '一', '二', '三', '四', '五', '六', '日'];

// ---------- 報表 ----------
function fmt(n) {
  return Number.isInteger(n)
    ? n.toLocaleString('en-US')
    : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function sum(rows) {
  return rows.reduce(function (a, r) { return a + r.amount; }, 0);
}
function personLines(rows) {
  const t = {};
  rows.forEach(function (r) { t[r.name] = (t[r.name] || 0) + r.amount; });
  const list = Object.keys(t).sort(function (a, b) { return t[b] - t[a]; });
  if (list.length < 2) return [];
  return ['—— 每人 ——'].concat(list.map(function (k) { return k + '：' + fmt(t[k]); }));
}

function dayReport(chatId, date) {
  const rows = fetchRows(chatId, date, date);
  const title = '📅 ' + md(date) + '（' + WK[weekday(date)] + '）' + (date === today() ? ' 今日' : '') + '花費';
  if (!rows.length) return title + '\n沒有紀錄';
  const lines = [title];
  rows.forEach(function (r) { lines.push('・' + r.item + ' ' + fmt(r.amount) + '（' + r.name + '）'); });
  lines.push('合計：' + fmt(sum(rows)) + ' 元');
  return lines.concat(personLines(rows)).join('\n');
}

function rangeReport(chatId, title, from, to, daysForAvg) {
  const rows = fetchRows(chatId, from, to);
  const head = title + ' ' + md(from) + '～' + md(to);
  if (!rows.length) return head + '\n沒有紀錄';
  const perDay = {};
  rows.forEach(function (r) { perDay[r.date] = (perDay[r.date] || 0) + r.amount; });
  const lines = [head];
  Object.keys(perDay).sort().forEach(function (d) {
    lines.push(md(d) + '（' + WK[weekday(d)] + '）' + fmt(perDay[d]));
  });
  const total = sum(rows);
  lines.push('合計：' + fmt(total) + ' 元');
  lines.push('日均：' + fmt(Math.round(total / daysForAvg)) + ' 元');
  return lines.concat(personLines(rows)).join('\n');
}

function weeklyReport(chatId, offset) {
  const t = today();
  const from = addDays(t, -(weekday(t) - 1) + offset * 7);
  const to = addDays(from, 6);
  const days = offset === 0 ? weekday(t) : 7;
  return rangeReport(chatId, '📊 ' + (offset === 0 ? '本週' : '上週'), from, to, days);
}

function monthlyReport(chatId, offset) {
  const t = today();
  let y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7)) + offset;
  if (m < 1) { m += 12; y -= 1; }
  const from = y + '-' + pad(m) + '-01';
  const nextFirst = (m === 12 ? y + 1 : y) + '-' + pad(m === 12 ? 1 : m + 1) + '-01';
  const to = addDays(nextFirst, -1);
  const days = offset === 0 ? Number(t.slice(8, 10)) : Number(to.slice(8, 10));
  return rangeReport(chatId, '🗓 ' + m + '月', from, to, days);
}

// ---------- LINE API ----------
function token() {
  return PropertiesService.getScriptProperties().getProperty('LINE_TOKEN');
}

function lineGet(path) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/' + path, {
    headers: { Authorization: 'Bearer ' + token() },
    muteHttpExceptions: true,
  });
  return res.getResponseCode() === 200 ? JSON.parse(res.getContentText()) : null;
}

function displayName(src) {
  let p = null;
  if (src.type === 'group') p = lineGet('group/' + src.groupId + '/member/' + src.userId);
  else if (src.type === 'room') p = lineGet('room/' + src.roomId + '/member/' + src.userId);
  else p = lineGet('profile/' + src.userId);
  return p ? p.displayName : '某人';
}

function replyMessage(replyToken, text) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token() },
    payload: JSON.stringify({ replyToken: replyToken, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) console.error('LINE reply 失敗 ' + res.getResponseCode() + ' ' + res.getContentText());
}

// ---------- 測試用（在編輯器選這個函式按執行） ----------
function testToken() {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    headers: { Authorization: 'Bearer ' + token() },
    muteHttpExceptions: true,
  });
  Logger.log(res.getResponseCode() + ' ' + res.getContentText());
}
