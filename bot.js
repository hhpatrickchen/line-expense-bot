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
  '【記帳】日期可省略＝今天\n' +
  '  漢堡王 447\n' +
  '  11/7 牛奶 331\n' +
  '  一次記多筆（每行都要有金額）：\n' +
  '  11/20\n  豬肉 300\n  青菜 120\n' +
  '【查詢】\n' +
  '  總計：今日／本週／本月總額\n' +
  '  今日、本週、上週、本月、上月：明細\n' +
  '  11/20：查某天\n' +
  '  查 豬肉：查品項（查 豬 牛＝任一）\n' +
  '  分類：本月各類花費（分類 上月／本週／上週）\n' +
  '【分類設定】\n' +
  '  分類 麥當勞 外食：新增關鍵字\n' +
  '  分類 刪 麥當勞：刪除關鍵字\n' +
  '  分類清單：看自訂的關鍵字\n' +
  '【修改】\n' +
  '  最近：列出最近 10 筆和編號\n' +
  '  刪除 3：刪掉第 3 筆（只打「刪除」＝你的最後一筆）\n' +
  '  改 3 1200：第 3 筆金額改成 1200\n' +
  '  改 3 11/20 豬肉 300：整筆改掉';

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
  let reply;
  try {
    reply = buildReply(chatId, src, text);
  } catch (err) {
    console.error(err);
    reply = '⚠️ 發生錯誤：' + (err && err.message ? err.message : err);
  }
  if (reply) replyMessage(ev.replyToken, reply); // 一般聊天不回應
}

function buildReply(chatId, src, text) {
  const cmd = text.replace(/\s+/g, '');
  if (['總計', '花費', '總覽', '總額'].includes(cmd)) return summaryReport(chatId);
  if (['今日', '今天', '今日花費'].includes(cmd)) return dayReport(chatId, today());
  if (['本週', '這週', '本周', '這周', '週報'].includes(cmd)) return weeklyReport(chatId, 0);
  if (['上週', '上周'].includes(cmd)) return weeklyReport(chatId, -1);
  if (['本月', '這個月', '月報'].includes(cmd)) return monthlyReport(chatId, 0);
  if (['上月', '上個月'].includes(cmd)) return monthlyReport(chatId, -1);
  if (['說明', 'help', '幫助'].includes(cmd)) return HELP;

  // 最近 / 最近20
  const rec = cmd.match(/^最近(\d+)?$/);
  if (rec) return recentReport(chatId, Math.min(Number(rec[1] || 10), 30));

  // 刪除（自己最後一筆）/ 刪除 3（最近清單第 3 筆）
  if (['刪除', '取消', '撤銷'].includes(cmd)) {
    const row = deleteLast(chatId, src.userId);
    return row ? '🗑 已刪除：' + describe(row) : '你還沒有紀錄可以刪';
  }
  const del = cmd.match(/^(?:刪除|刪)(\d+)$/);
  if (del) {
    const row = deleteNth(chatId, Number(del[1]));
    return row ? '🗑 已刪除：' + describe(row) : '找不到第 ' + del[1] + ' 筆，先打「最近」看編號';
  }

  // 改 3 1200 / 改 3 11/20 豬肉 300
  const edit = text.match(/^改\s*(\d+)\s+([\s\S]+)$/);
  if (edit) return editNth(chatId, Number(edit[1]), edit[2].trim());

  // 分類
  if (cmd === '分類清單') return categoryRulesList();
  const cat = text.match(/^分類\s*([\s\S]*)$/);
  if (cat) return categoryCommand(chatId, cat[1].trim());

  // 查品項：「查 豬肉」「查豬肉」
  const q = text.match(/^查\s*(.+)$/);
  if (q) return itemReport(chatId, q[1]);

  // 只打日期 → 查那天
  const onlyDate = parseLeadingDate(cmd);
  if (onlyDate && !onlyDate.rest) return dayReport(chatId, onlyDate.date);

  // 記帳（一筆或多筆）
  const entries = parseEntries(text);
  if (!entries.length) return null;
  const name = displayName(src);
  entries.forEach(function (p) { addExpense(p.date, chatId, src.userId, name, p.item, p.amount); });
  if (entries.length === 1) return '✅ ' + describe(entries[0]);
  const total = entries.reduce(function (a, p) { return a + p.amount; }, 0);
  return ['✅ 記了 ' + entries.length + ' 筆'].concat(entries.map(describe)).concat(['合計：' + fmt(total) + ' 元']).join('\n');
}

function describe(r) {
  return md(r.date) + ' ' + r.item + ' ' + fmt(r.amount);
}

/**
 * 一則訊息 → 一筆或多筆。
 * 規則：去掉開頭日期後，若有 2 行以上且「每一行」都有品項和金額 → 每行一筆（行首也可各自寫日期）；
 * 否則整則訊息當一筆（例如「牛奶、牛肉\n867」「買菜1000\n高麗菜\n地瓜」）。
 */
function parseEntries(text) {
  let date = null;
  let body = text.trim();
  const d = parseLeadingDate(body);
  if (d) { date = d.date; body = d.rest; }
  const lines = body.split(/\n+/).map(function (l) { return l.trim(); }).filter(function (l) { return l; });
  if (lines.length >= 2) {
    const each = lines.map(function (l) {
      const p = parseExpense(l);
      if (p && date && !parseLeadingDate(l)) p.date = date;
      return p;
    });
    if (each.every(function (p) { return p; })) return each;
  }
  const one = parseExpense(text);
  return one ? [one] : [];
}

// ---------- 最近／刪除／修改 ----------
/** 這個聊天室的紀錄，依輸入順序新到舊（第 1 筆＝最新） */
function recentRows(chatId) {
  return allRows().filter(function (r) { return r.chatId === chatId; }).reverse();
}

function recentReport(chatId, n) {
  const rows = recentRows(chatId).slice(0, n);
  if (!rows.length) return '還沒有任何紀錄';
  const lines = ['🧾 最近 ' + rows.length + ' 筆（新→舊）'];
  rows.forEach(function (r, i) { lines.push((i + 1) + '. ' + describe(r) + '（' + r.name + '）'); });
  lines.push('刪除 N／改 N 金額 可修改');
  return lines.join('\n');
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function deleteNth(chatId, n) {
  return withLock(function () {
    const r = recentRows(chatId)[n - 1];
    if (!r) return null;
    sheet().deleteRow(r.row);
    return r;
  });
}

function editNth(chatId, n, rest) {
  return withLock(function () {
    const r = recentRows(chatId)[n - 1];
    if (!r) return '找不到第 ' + n + ' 筆，先打「最近」看編號';
    const before = describe(r);
    const after = { date: r.date, item: r.item, amount: r.amount };
    const num = rest.replace(/[$＄,元]/g, '').trim();
    if (/^\d+(\.\d+)?$/.test(num)) {
      after.amount = parseFloat(num);
    } else {
      const p = parseExpense(rest);
      if (!p) return '看不懂要改成什麼，範例：改 ' + n + ' 1200 或 改 ' + n + ' 11/20 豬肉 300';
      after.item = p.item;
      after.amount = p.amount;
      if (parseLeadingDate(rest)) after.date = p.date;
    }
    const sh = sheet();
    sh.getRange(r.row, 1).setValue(after.date);
    sh.getRange(r.row, 6, 1, 2).setValues([[after.item, after.amount]]);
    return '✏️ 已修改\n' + before + '\n→ ' + describe(after);
  });
}

// ---------- 分類 ----------
const DEFAULT_CATS = {
  '食材': ['全聯', '家樂福', '好市多', '超市', '市場', '買菜', '豬', '牛', '雞', '鴨', '魚', '蝦', '肉', '菜', '蛋', '奶', '豆腐', '豆漿', '米', '麵', '水果', '蘋果', '香蕉', '橘', '菇', '蔥', '蒜', '薑', '玉米', '起司', '泡菜', '冬粉', '地瓜', '四季豆', '洋蔥', '蘿蔔', '糕粉', '麵包', '吐司'],
  '外食': ['漢堡王', '麥當勞', '肯德基', '摩斯', '早餐', '午餐', '晚餐', '宵夜', '便當', '餐廳', '火鍋', '拉麵', '咖啡', '星巴克', '飲料', '手搖', '珍奶', '外送', 'ubereats', 'foodpanda', '小吃', '滷味', '雞排'],
  '日用品': ['衛生紙', '洗衣', '洗髮', '沐浴', '牙膏', '牙刷', '清潔', '垃圾袋', '電池', '日用', '面紙', '洗碗'],
  '交通': ['加油', '油錢', '停車', '捷運', '公車', '高鐵', '台鐵', '火車', '計程車', 'uber', 'etag', '過路'],
  '帳單': ['房租', '水費', '電費', '瓦斯', '網路', '電話費', '手機費', '管理費', '保險'],
  '醫療': ['掛號', '藥', '診所', '醫院', '牙醫'],
  '娛樂': ['電影', '遊戲', '訂閱', 'netflix', 'spotify', '旅遊', '門票'],
};

function customRules() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('CAT_RULES') || '{}'); }
  catch (e) { return {}; }
}
function saveRules(rules) {
  PropertiesService.getScriptProperties().setProperty('CAT_RULES', JSON.stringify(rules));
}

/** 品項 → 分類：自訂關鍵字優先；同類規則取在品項中最早出現（同位置取較長）的關鍵字 */
function categorize(item, rules) {
  const text = String(item).toLowerCase();
  const best = function (pairs) {
    let hit = null;
    pairs.forEach(function (kc) {
      const i = text.indexOf(kc[0].toLowerCase());
      if (i < 0) return;
      if (!hit || i < hit.i || (i === hit.i && kc[0].length > hit.k.length)) hit = { i: i, k: kc[0], c: kc[1] };
    });
    return hit && hit.c;
  };
  const custom = Object.keys(rules).map(function (k) { return [k, rules[k]]; });
  const defaults = [];
  Object.keys(DEFAULT_CATS).forEach(function (c) { DEFAULT_CATS[c].forEach(function (k) { defaults.push([k, c]); }); });
  return best(custom) || best(defaults) || '其他';
}

function categoryCommand(chatId, arg) {
  if (!arg || arg === '本月') return categoryReport(chatId, monthRange(0), '本月');
  if (arg === '上月') return categoryReport(chatId, monthRange(-1), '上月');
  if (arg === '本週' || arg === '本周') return categoryReport(chatId, weekRange(0), '本週');
  if (arg === '上週' || arg === '上周') return categoryReport(chatId, weekRange(-1), '上週');
  const del = arg.match(/^(?:刪|刪除)\s+(\S+)$/);
  const rules = customRules();
  if (del) {
    if (!rules[del[1]]) return '沒有「' + del[1] + '」這個自訂關鍵字';
    delete rules[del[1]];
    saveRules(rules);
    return '🗑 已刪除關鍵字「' + del[1] + '」';
  }
  const set = arg.match(/^(\S+)\s+(\S+)$/);
  if (set) {
    rules[set[1]] = set[2];
    saveRules(rules);
    return '🏷 之後品項有「' + set[1] + '」都算「' + set[2] + '」（舊紀錄也會跟著改）';
  }
  return '用法：分類／分類 上月／分類 麥當勞 外食／分類 刪 麥當勞';
}

function categoryRulesList() {
  const rules = customRules();
  const keys = Object.keys(rules);
  const lines = ['🏷 預設分類：' + Object.keys(DEFAULT_CATS).join('、') + '、其他'];
  if (!keys.length) lines.push('還沒有自訂關鍵字，範例：分類 麥當勞 外食');
  else {
    lines.push('—— 自訂關鍵字 ——');
    keys.forEach(function (k) { lines.push(k + ' → ' + rules[k]); });
  }
  return lines.join('\n');
}

function categoryTotals(rows) {
  const rules = customRules();
  const t = {}, others = {};
  rows.forEach(function (r) {
    const c = categorize(r.item, rules);
    t[c] = (t[c] || 0) + r.amount;
    if (c === '其他') others[r.item] = true;
  });
  const list = Object.keys(t).sort(function (a, b) { return t[b] - t[a]; });
  return { totals: t, list: list, others: Object.keys(others) };
}

function categoryLines(rows) {
  const total = sum(rows);
  const ct = categoryTotals(rows);
  return ct.list.map(function (c) {
    return c + ' ' + fmt(ct.totals[c]) + '（' + Math.round((ct.totals[c] / total) * 100) + '%）';
  });
}

function categoryReport(chatId, range, label) {
  const rows = fetchRows(chatId, range[0], range[1]);
  const head = '🏷 ' + label + '分類 ' + md(range[0]) + '～' + md(range[1]);
  if (!rows.length) return head + '\n沒有紀錄';
  const lines = [head + '（共 ' + fmt(sum(rows)) + ' 元）'].concat(categoryLines(rows));
  const others = categoryTotals(rows).others;
  if (others.length) {
    lines.push('—— 「其他」裡有 ——');
    lines.push(others.slice(0, 8).join('、') + (others.length > 8 ? '…' : ''));
    lines.push('可用「分類 關鍵字 類別」歸類');
  }
  return lines.join('\n');
}

function weekRange(offset) {
  const t = today();
  const from = addDays(t, -(weekday(t) - 1) + offset * 7);
  return [from, addDays(from, 6)];
}
function monthRange(offset) {
  const t = today();
  let y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7)) + offset;
  if (m < 1) { m += 12; y -= 1; }
  const from = y + '-' + pad(m) + '-01';
  const nextFirst = (m === 12 ? y + 1 : y) + '-' + pad(m === 12 ? 1 : m + 1) + '-01';
  return [from, addDays(nextFirst, -1)];
}

// ---------- 定時任務（由 loader 的 cron 每小時呼叫） ----------
function cron() {
  const t = today();
  const hour = Number(Utilities.formatDate(new Date(), TZ, 'H'));
  const props = PropertiesService.getScriptProperties();
  // 每週一 9 點後送上週總結（每週只送一次）
  if (weekday(t) === 1 && hour >= 9 && props.getProperty('LAST_WEEKLY') !== t) {
    props.setProperty('LAST_WEEKLY', t);
    sendWeeklySummaries();
  }
}

function sendWeeklySummaries() {
  const last = weekRange(-1);
  const chats = {};
  allRows().forEach(function (r) { if (r.date >= last[0] && r.date <= last[1]) chats[r.chatId] = true; });
  Object.keys(chats).forEach(function (chatId) {
    pushMessage(chatId, weeklySummary(chatId));
  });
}

function weeklySummary(chatId) {
  const last = weekRange(-1), prev = weekRange(-2);
  const rows = fetchRows(chatId, last[0], last[1]);
  const prevTotal = sum(fetchRows(chatId, prev[0], prev[1]));
  const total = sum(rows);
  const lines = ['📬 上週花費 ' + md(last[0]) + '～' + md(last[1]), '合計：' + fmt(total) + ' 元｜日均 ' + fmt(Math.round(total / 7))];
  if (prevTotal > 0) {
    const diff = total - prevTotal;
    lines.push('比前一週' + (diff >= 0 ? '多 ' : '少 ') + fmt(Math.abs(diff)) + ' 元（' + (diff >= 0 ? '+' : '-') + Math.round(Math.abs(diff) / prevTotal * 100) + '%）');
  }
  lines.push('—— 分類 ——');
  return lines.concat(categoryLines(rows)).concat(personLines(rows)).join('\n');
}

function pushMessage(to, text) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token() },
    payload: JSON.stringify({ to: to, messages: [{ type: 'text', text: text }] }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) console.error('LINE push 失敗 ' + res.getResponseCode() + ' ' + res.getContentText());
}

// ---------- 總計 ----------
function summaryReport(chatId) {
  const t = today();
  const weekFrom = addDays(t, -(weekday(t) - 1));
  const monthFrom = t.slice(0, 8) + '01';
  const rows = fetchRows(chatId, monthFrom < weekFrom ? monthFrom : weekFrom, t);
  const pick = function (from) { return rows.filter(function (r) { return r.date >= from; }); };
  const line = function (label, rs, days) {
    let s = label + '：' + fmt(sum(rs)) + ' 元（' + rs.length + ' 筆）';
    if (days > 1) s += '｜日均 ' + fmt(Math.round(sum(rs) / days));
    return s;
  };
  const monthRows = pick(monthFrom);
  const lines = [
    '💰 花費總覽（' + md(t) + ' 週' + WK[weekday(t)] + '）',
    line('今日', pick(t), 1),
    line('本週', pick(weekFrom), weekday(t)),
    line('本月', monthRows, Number(t.slice(8, 10))),
  ];
  const people = personLines(monthRows);
  if (people.length) lines.push('—— 本月每人 ——');
  return lines.concat(people.slice(1)).join('\n');
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

/** 查某品項在今日／本週／本月的花費。關鍵字用空格分開＝任一符合 */
function itemReport(chatId, query) {
  const keys = query.split(/[\s、,，]+/).filter(function (k) { return k; });
  if (!keys.length) return null;
  const t = today();
  const weekFrom = addDays(t, -(weekday(t) - 1));
  const monthFrom = t.slice(0, 8) + '01';
  const match = function (r) {
    return keys.some(function (k) { return String(r.item).toLowerCase().indexOf(k.toLowerCase()) >= 0; });
  };
  const rows = fetchRows(chatId, monthFrom < weekFrom ? monthFrom : weekFrom, t).filter(match);
  const part = function (from) {
    const rs = rows.filter(function (r) { return r.date >= from; });
    return fmt(sum(rs)) + ' 元（' + rs.length + ' 筆）';
  };
  const lines = ['🔍「' + keys.join('／') + '」花費', '今日：' + part(t), '本週：' + part(weekFrom), '本月：' + part(monthFrom)];
  const monthRows = rows.filter(function (r) { return r.date >= monthFrom; });
  if (monthRows.length) {
    lines.push('—— 本月明細 ——');
    monthRows.forEach(function (r) { lines.push(md(r.date) + ' ' + r.item + ' ' + fmt(r.amount)); });
    if (monthRows.some(function (r) { return String(r.item).indexOf('、') >= 0; })) {
      lines.push('※ 一筆裡有好幾樣東西時，算的是整筆金額');
    }
  }
  return lines.join('\n');
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

// 給 loader 用（定時任務）
globalThis.__bot = { handlePost: handlePost, testToken: testToken, cron: cron };
