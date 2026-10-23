/**
 * 包裝備料排程工具（Packaging Schedule Board）
 *
 * 使用方式：在 Google 試算表開啟「擴充功能 → Apps Script」，把這個檔案的內容
 * 全部貼進 Code.gs，選擇函式 setup 並按「執行」一次，就會建立所有工作表。
 *
 * 檔案分成五段：
 *   1. 常數設定
 *   2. 排程核心邏輯（純函式，不碰試算表，可以在 Node.js 測試）
 *   3. 試算表讀寫、觸發器
 *   4. 新增工單視窗
 *   5. 一鍵建置
 *
 * 時間表示法：
 *   - 日期用試算表的「日期序號」（1899-12-30 為 0），跟時區無關。
 *   - 每天有 3 個時段（上午、下午、加班），每個時段再分前後半，
 *     「半時段鍵值」= 日期序號 × 6 + 時段 × 2 + 半段。
 *   - 「整時段鍵值」= 日期序號 × 3 + 時段，用來計算備料期限。
 */

// ============================================================
// 1. 常數設定
// ============================================================

var SHEET = {
  ORDERS: '工單排程',
  CALENDAR: '工作日曆',
  PREP: '包裝備料清單',
  GANTT: '甘特圖',
  CUSTOMERS: '客戶清單',
  MODELS: '機型清單',
  SETTINGS: '選項設定'
};
var SHEET_ORDER = [SHEET.ORDERS, SHEET.CALENDAR, SHEET.PREP, SHEET.GANTT,
  SHEET.CUSTOMERS, SHEET.MODELS, SHEET.SETTINGS];

var STATUS = {
  NOT_STARTED: '未開工',
  ASSEMBLY: '組裝中',
  OUTSOURCE: '外包中',
  TEST: '測試中',
  WAITING: '待包裝',
  PACKING: '包裝中',
  DONE: '完成'
};
var STATUS_LIST = ['未開工', '組裝中', '外包中', '測試中', '待包裝', '包裝中', '完成'];
var METHOD_LIST = ['自製', '外包'];
var METHOD_OUTSOURCE = '外包';

var SLOT_NAMES = ['上午', '下午', '加班'];
// 指定開始時段的選項，索引 = 時段 × 2 + 半段
var START_LABELS = ['上午', '上午後半', '下午', '下午後半', '加班', '加班後半'];
var WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六'];

// ① 工單排程的欄位（從 1 起算）
var COL = {
  ORDER_NO: 1, WO: 2, CUSTOMER: 3, MODEL: 4, QTY: 5, SHIP: 6, METHOD: 7, STATUS: 8,
  ASM_DONE: 9, TEST_DONE: 10, SEQ: 11, HOURS: 12, FIXED_DATE: 13, FIXED_SLOT: 14,
  PREPPED: 15, NOTE: 16, START: 17, END: 18, DEADLINE: 19, LIGHT: 20
};
var ORDER_HEADERS = ['訂單編號', '工單編號', '客戶', '機型', '數量', '出貨日', '組裝方式', '目前狀態',
  '組裝預計完成日', '測試預計完成日', '包裝順序', '包裝時段數', '指定開始日', '指定開始時段',
  '已備料', '備註', '包裝開始', '包裝結束', '最晚備料', '燈號'];
var INPUT_COLS = 16;
var AUTO_COLS = 4;
var ORDER_ROWS = 1000;

// ② 工作日曆
var CAL_HEADERS = ['日期', '星期', '上午', '下午', '晚上加班', '備料人員上班', '備註'];

// ③ 包裝備料清單（第 1 列摘要、第 2 列標題、第 3 列起資料）
var PREP_HEADERS = ['燈號', '已備料', '工單編號', '包裝開始', '最晚備料', '客戶', '機型', '數量', '狀態',
  '訂單編號', '出貨日', '來源列'];
var PREP_COL = {
  LIGHT: 1, PREPPED: 2, WO: 3, START: 4, DEADLINE: 5, CUSTOMER: 6, MODEL: 7, QTY: 8,
  STATUS: 9, ORDER_NO: 10, SHIP: 11, SRC: 12
};
var PREP_FIRST_ROW = 3;

// ④ 甘特圖（第 1 列標題、第 2～3 列日期與時段、第 4 列起工單）
var GANTT_FIRST_ROW = 4;
var GANTT_LABEL_COLS = 3;
var GANTT_MAX_ROWS = 300;

// 客戶清單、機型清單
var CUSTOMER_HEADERS = ['客戶名稱', '備註'];
var MODEL_HEADERS = ['客戶名稱', '機型', '每時段包裝數量', '備註'];

// 新增工單的輸入限制
var LIMIT = { TEXT: 30, NOTE: 200, QTY: 100000, HOURS: 200, SEQ: 9999 };

// 包裝時段數由系統自動計算時，儲存格註解以此開頭
var AUTO_NOTE_PREFIX = '自動計算';

var LIGHT = {
  OVERDUE: '🔴 逾期',
  NOW: '🔴 現在備',
  NEXT: '🟡 下時段備',
  LATER: '⚪ 還早',
  PREPPED: '🟢 已備料',
  FINISHED: '✔ 完成',
  UNQUEUED: '－ 未排入',
  MISSING_HOURS: '⚠ 缺時段數',
  OVERFLOW: '⚠ 超出日曆',
  DUPLICATE: '⚠ 工單重複'
};

var COLOR = {
  HEADER_INPUT: '#CFE2F3',
  HEADER_AUTO: '#D9D9D9',
  AUTO_BG: '#F3F3F3',
  RED_BG: '#F4CCCC',
  YELLOW_BG: '#FFF2CC',
  GREEN_BG: '#D9EAD3',
  WARN_BG: '#FCE5CD',
  ASSEMBLY: '#9FC5E8',
  OUTSOURCE: '#B4A7D6',
  TEST: '#FFE599',
  WAIT: '#D9D9D9',
  PACK: '#93C47D',
  PACKING_NOW: '#38761D',
  PREP_MARK: '#CC0000',
  NOW_HEADER: '#F6B26B',
  SUNDAY: '#EFEFEF',
  SATURDAY: '#EEF3FB',
  DONE_FONT: '#999999'
};

// [項目, 預設值, 說明]
var SETTING_ROWS = [
  ['上午開始', '08:00', '時段時間只用來判斷「現在」是哪個時段，格式 HH:MM'],
  ['上午結束', '12:00', ''],
  ['下午開始', '13:00', ''],
  ['下午結束', '17:00', ''],
  ['加班開始', '17:30', ''],
  ['加班結束', '20:30', ''],
  ['黃燈提前時段數', 1, '在最晚備料時段之前，提前幾個「備料人員時段」亮黃燈'],
  ['甘特圖顯示天數', 14, '甘特圖從今天起顯示幾天'],
  ['日曆保留未來天數', 120, '工作日曆會自動延長到今天之後幾天']
];

// 「＋ 新增工單」按鍵圖片（PNG，320×72）
var BUTTON_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAUAAAABICAYAAACHtCxzAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAYpSURBVHhe7dwvbNxmGMfxg4UlVesLSMmkwsCBgcLCSiOFgSNTGjugKunGysI2trKWbayFgVVRwcBYg1r7Vq2ZNm2dpkmZfs6e6M1zts++e3Pz2d9H+kjR+9p+fSA/va//TSZL1laW35Zpmu8mWf4VAKyTssdyaPvR8RWfUVErSd/eStL8QZIWr6dZcQoAPfPTNJsdTg9mOz6/lq7re/nNJC2eVQwGAP2UFkcrB2E51UyLj3MHB4CNMDvsvDze3ju5Os1mP8wfDAA2S5LlL68dzG74nKsshR/X+QAMzLEu5/m8m6tpVryo2BkANpomdo3L4fLWcsWOADAESVY88blXlu6YcMMDwNDpuUGffxNuegAYAy2FL4bfwWzHbwQAQ5Wkxd3zAOTaH4AxuXAt8OwVkvmNAGCIkqw4Ke8I6wFB3wkAQ7e1X3xaftXFdwDA4KX57mSa5ffmOgBg4PR1q0myX9z3HQAwdLr5yx1gAKNEAAIYLQIQwGgRgABGiwAEMFoEIIDRIgABjBYBCGC0CECcfvb4/enTV3+evnn/z+mdw1/m+pt8/s2Hct9vj/6Y6/Oe//jXqerh97/N9e18/XPjcT55OCv313i+D1gWAYiSwk+lkPF9RiGkgFSAKax8VQVbqCkAd787OT/Ol09/neu3fVUKS9//fwnPq66W2RbrQQCOVJt/RiuFntSVwlAB5sfwmgJQ1G6lWanfT7VoBth0nstW3fn6c6urZbbFehCAI9Xmn9GqKgAt9LrMxhYFoOi4vl9h+OrN3wvDT/x5xih/PqG63xSex6Jtw+D3x8flIgBHzK67afkbtitwVOFSNPyH7nqd0FQFQPjP36WaluqLxPgtpuo3CQG4GQjAEbOgU4Wzq8fPfy/bwmCMERpVATCUAGyqZbbFehCAI6elpSq8+2o3RMKgihEaTQGoPoWwxtbMNGzXdjo/sfMgABEDAThyfvmlELLSXV/bbpXQqCuNHQad3QnWDDRst5mq/u5bAGKzEYA9ZuXbY+hSCokwNJrKX99qGssHoLbVjFRBGLZrbHtGsY8B2GZm16ZinAu6IQB7zMq3x9ClVg1As2gJHG5b104AIiYCsMesfPtl8Ethryo0wja/fZWmAOxafQzAuvBvGiv2uaAbArDHrHz7ZegSgPaQMgF4pup3hZrGin0u6IYA7DEr376q8J+uTdl1OKuq4/gxqiwKinWJHTosgTcXAdgDy8yCVgmRvgXgMufjj90FAQhDAPbAugOwil8C61m88P3e8PEYayMAz9T9LtM0VuxzQTcEYI9Z+fZYdC3PZndhAOr5Pyt7Q8T6w/C5jAD0+4SqzmEZsUOn7neZprFinwu6IQB7zMq3x6I3K1R69s7PAK3PwsY+fxW+MdI2uEwYFJph6lh637jtcfoegKtWjHNBNwRgj1n59hgUQFbhg8c2XtivmaK9Hlf3gQR//CpVQaFxw+O0KQIQsRCAPWbl22OwGZ198MAHoOgfW+EYfjQh/E5f2wDUdjajDEtj2kdWu1TfAnCRdY6FbgjAHrPy7avysz+1VQWgCcMrbG8TgD7c7FW3uveM/f6hPi2B/e+KWXXXEhEfAThS+gcOg6QuAMOw1EcK/DGq9vE0y9S+4eyx7jhtigBELAQgSnUBGLb7rz+3DcBFuoZJXQB2PU6XWiWUrJYNW1weAhClugAU3fioCoDLCEDfF1q0BCYA0RUBCGC0CEAAo0UAAhgtAhDAaBGAAEaLAAQwWgQggNE6C8A0f+A7AGDoygCcpvmu7wCAoSsDcCvLb/sOABi8NN+dJOnbW3MdADBwN/bf3Zmokqw48Z0AMFRJWnzc3ju5agH4xG8AAIOVFkdl+JUBmBZ35zYAgMF698V5AP4Xgq/nNwKAgUnzfPvR8RUfgMwCAQxesl/cvxB+VklaPPMbA8BQJFn+0ufeeemuyDQrjv1OALDp9LTL9b38ps+9C6XnAnksBsCQ6LEXvfTh866ypgezHWaCAIZAE7rW4WdVLofT4sgfDAA2hZ5uWbjsbapplt9jNghgk2jWV3u3t2vpmRk9ODjNihd+IADoC834FHznr7nFLh1Y62l9SgYA+kAfNrh2MLvh82pR/Quadrn1QyeHKAAAAABJRU5ErkJggg==';

// ============================================================
// 2. 排程核心邏輯（純函式）
// ============================================================

function serialFromYmd(y, m, d) {
  return Math.round(Date.UTC(y, m - 1, d) / 86400000) + 25569;
}

function ymdFromSerial(serial) {
  var dt = new Date((serial - 25569) * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** "2026-10-23" → 日期序號；格式或日期不合理時回傳 null */
function isoToSerial(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return null;
  var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (y < 2000 || y > 2100) return null;
  var serial = serialFromYmd(y, mo, d);
  var back = ymdFromSerial(serial);
  return back.y === y && back.m === mo && back.d === d ? serial : null;
}

/** 0 = 星期日 … 6 = 星期六（序號 0 是星期六） */
function weekdayOf(serial) {
  return ((serial % 7) + 6) % 7;
}

function dayLabel(serial) {
  var p = ymdFromSerial(serial);
  return p.m + '/' + p.d + '(' + WEEKDAY_NAMES[weekdayOf(serial)] + ')';
}

function colLetter(n) {
  var s = '';
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 沒在工作日曆上的日期，依星期幾套用預設值 */
function defaultDay(serial) {
  var w = weekdayOf(serial);
  if (w === 0) return { am: false, pm: false, ot: false, prep: false };
  if (w === 6) return { am: true, pm: true, ot: false, prep: false };
  return { am: true, pm: true, ot: true, prep: true };
}

function halfKey(serial, slot, half) {
  return serial * 6 + slot * 2 + half;
}

function serialOfHalf(key) {
  return Math.floor(key / 6);
}

function fullOfHalf(key) {
  return Math.floor(key / 2);
}

/** 第一個 >= x 的索引；全部都小於 x 時回傳 arr.length */
function lowerBound(arr, x) {
  var lo = 0, hi = arr.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** "08:30" → 510；也接受一天的小數（試算表時間值） */
function parseTimeText(v) {
  if (typeof v === 'number' && v >= 0 && v < 1) return Math.round(v * 1440);
  var m = String(v == null ? '' : v).trim().match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/**
 * 依現在時間找出所在的半時段（不考慮是否上班）。
 * 時段之間的空檔（例如午休）算下一個時段的前半；加班結束後算隔天上午。
 */
function rawNowKey(today, minutes, times) {
  var ranges = [[times.amS, times.amE], [times.pmS, times.pmE], [times.otS, times.otE]];
  for (var i = 0; i < 3; i++) {
    var s = ranges[i][0], e = ranges[i][1];
    if (minutes < s) return halfKey(today, i, 0);
    if (minutes < e) return halfKey(today, i, minutes >= (s + e) / 2 ? 1 : 0);
  }
  return halfKey(today + 1, 0, 0);
}

/**
 * 產生時間軸：
 *   work = 產線有上班的半時段鍵值（遞增）
 *   prep = 備料人員有上班的整時段鍵值（只有上午、下午）
 */
function buildTimeline(calendarRows, fromSerial, toSerial) {
  var map = {};
  calendarRows.forEach(function (r) { map[r.serial] = r; });
  var dayInfo = function (s) { return map[s] || defaultDay(s); };
  var work = [], prep = [];
  for (var s = fromSerial; s <= toSerial; s++) {
    var d = dayInfo(s);
    var flags = [d.am, d.pm, d.ot];
    for (var i = 0; i < 3; i++) {
      if (flags[i]) work.push(halfKey(s, i, 0), halfKey(s, i, 1));
    }
    if (d.prep) prep.push(s * 3, s * 3 + 1);
  }
  return { work: work, prep: prep, dayInfo: dayInfo };
}

function startText(key) {
  return dayLabel(serialOfHalf(key)) + ' ' + START_LABELS[key % 6];
}

/** 結束顯示「最後佔用的半時段」：佔到後半顯示整個時段名，只佔前半顯示「前半」 */
function endText(key) {
  var slot = Math.floor((key % 6) / 2);
  var name = SLOT_NAMES[slot] + (key % 2 === 1 ? '' : '前半');
  return dayLabel(serialOfHalf(key)) + ' ' + name;
}

function fullSlotText(fullKey) {
  return dayLabel(Math.floor(fullKey / 3)) + ' ' + SLOT_NAMES[fullKey % 3];
}

function lightBackground(light) {
  if (!light) return null;
  if (light.indexOf('🔴') === 0) return COLOR.RED_BG;
  if (light.indexOf('🟡') === 0) return COLOR.YELLOW_BG;
  if (light.indexOf('🟢') === 0) return COLOR.GREEN_BG;
  if (light.indexOf('⚠') === 0) return COLOR.WARN_BG;
  return null;
}

function isEarlyStage(status) {
  return status === STATUS.NOT_STARTED || status === STATUS.ASSEMBLY || status === STATUS.OUTSOURCE;
}

// ---------- 客戶、機型、包裝時段數 ----------

/** 數量 ÷ 每時段包裝數量，以 0.5 時段為單位無條件進位 */
function autoHours(qty, capacity) {
  if (!(qty > 0) || !(capacity > 0)) return null;
  return Math.max(0.5, Math.ceil(qty / capacity * 2 - 1e-9) / 2);
}

function autoHoursNote(qty, capacity) {
  return AUTO_NOTE_PREFIX + '：' + qty + ' 台 ÷ 每時段 ' + capacity + ' 台。直接改數字就會變成手動填寫。';
}

function findModel(models, customer, model) {
  for (var i = 0; i < models.length; i++) {
    if (models[i].customer === customer && models[i].model === model) return models[i];
  }
  return null;
}

function modelsByCustomer(models) {
  var map = {};
  models.forEach(function (m) {
    if (!map[m.customer]) map[m.customer] = [];
    if (map[m.customer].indexOf(m.model) < 0) map[m.customer].push(m.model);
  });
  return map;
}

/**
 * 包裝時段數空白、或上次是系統自動算的，就用機型的每時段包裝數量重算。
 * 會更新 orders 裡的 hours，回傳需要寫回試算表的項目。
 */
function planAutoHours(orders, models) {
  var updates = [];
  orders.forEach(function (o) {
    var isAuto = o.hours == null || String(o.hoursNote || '').indexOf(AUTO_NOTE_PREFIX) === 0;
    if (!isAuto) return;
    var m = findModel(models, o.customer, o.model);
    var cap = m ? m.capacity : null;
    var qty = Number(o.qty);
    var h = autoHours(qty, cap);
    if (h == null) return;
    var note = autoHoursNote(qty, cap);
    if (o.hours !== h || o.hoursNote !== note) updates.push({ row: o.row, hours: h, note: note });
    o.hours = h;
    o.hoursNote = note;
  });
  return updates;
}

/** 新工單排到最後：未完成工單中最大的順序 + 1（取整數） */
function nextSeq(orders) {
  var max = 0;
  orders.forEach(function (o) {
    if (o.status !== STATUS.DONE && o.seq != null && o.seq > max) max = o.seq;
  });
  return Math.floor(max) + 1;
}

/**
 * 包裝隊伍的先後：「包裝中」一律排最前面（不論包裝順序填多少），
 * 其餘依包裝順序由小到大，同順序依列號。
 */
function compareQueue(a, b) {
  var pa = a.status === STATUS.PACKING ? 0 : 1;
  var pb = b.status === STATUS.PACKING ? 0 : 1;
  if (pa !== pb) return pa - pb;
  if (a.seq !== b.seq) {
    if (a.seq == null) return -1;
    if (b.seq == null) return 1;
    return a.seq - b.seq;
  }
  return a.row - b.row;
}

/** 在包裝隊伍中的工單：未完成，且有包裝順序或正在包裝 */
function isQueued(o) {
  return o.status !== STATUS.DONE && (o.seq != null || o.status === STATUS.PACKING);
}

/** 重新編號：隊伍先後不變，包裝順序改成 1、2、3… */
function planRenumber(orders) {
  return orders.filter(isQueued).sort(compareQueue).map(function (o, i) {
    return { row: o.row, seq: i + 1 };
  });
}

/** 開頭是 = + - @ 的文字，加上 ' 避免被試算表當成公式 */
function safeText(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/**
 * 驗證新增工單視窗送來的資料。
 * ctx：customers、models、statuses、methods、existingWos、nextSeq
 * 回傳 { errors, row（寫入 ① 的一列）, hoursNote, wo }
 */
function validateNewOrder(d, ctx) {
  d = d || {};
  var errors = [];
  var raw = function (key) { return d[key] == null ? '' : String(d[key]).trim(); };
  var text = function (key, label, max, required) {
    var v = raw(key).replace(/[\r\n\t]+/g, ' ');
    if (required && !v) errors.push('請填寫「' + label + '」');
    if (v.length > max) errors.push('「' + label + '」最多 ' + max + ' 個字');
    return v;
  };
  var date = function (key, label) {
    var v = raw(key);
    if (!v) return '';
    var s = isoToSerial(v);
    if (s == null) { errors.push('「' + label + '」日期不正確'); return ''; }
    return s;
  };

  var customer = text('customer', '客戶', LIMIT.TEXT, true);
  var model = text('model', '機型', LIMIT.TEXT, true);
  var wo = text('wo', '工單編號', LIMIT.TEXT, true);
  var orderNo = text('orderNo', '訂單編號', LIMIT.TEXT, false);
  var note = text('note', '備註', LIMIT.NOTE, false);

  if (customer && ctx.customers.indexOf(customer) < 0) errors.push('客戶「' + customer + '」不在客戶清單中');
  var modelRow = findModel(ctx.models, customer, model);
  if (customer && model && !modelRow) errors.push('機型「' + model + '」不屬於客戶「' + customer + '」');
  if (wo && ctx.existingWos.some(function (w) { return String(w).toUpperCase() === wo.toUpperCase(); })) {
    errors.push('工單編號「' + wo + '」已經存在');
  }

  var qty = Number(raw('qty'));
  if (!raw('qty')) errors.push('請填寫「數量」');
  else if (!(Number.isInteger(qty) && qty >= 1 && qty <= LIMIT.QTY)) errors.push('「數量」請填 1～' + LIMIT.QTY + ' 的整數');

  var ship = date('ship', '出貨日');
  var asmDone = date('asmDone', '組裝預計完成日');
  var testDone = date('testDone', '測試預計完成日');

  var method = text('method', '組裝方式', LIMIT.TEXT, false);
  if (method && ctx.methods.indexOf(method) < 0) errors.push('「組裝方式」不正確');
  var status = text('status', '目前狀態', LIMIT.TEXT, false) || STATUS.NOT_STARTED;
  if (ctx.statuses.indexOf(status) < 0) errors.push('「目前狀態」不正確');

  var seq = '';
  var seqMode = raw('seqMode') || 'last';
  if (seqMode === 'last') {
    seq = ctx.nextSeq;
  } else if (seqMode === 'custom') {
    var n = Number(raw('seq'));
    if (!raw('seq') || !isFinite(n) || n < 0 || n > LIMIT.SEQ) errors.push('「指定順序」請填 0～' + LIMIT.SEQ + ' 的數字');
    else seq = n;
  } else if (seqMode !== 'none') {
    errors.push('包裝排程的選項不正確');
  }

  var hours = '', hoursNote = '', hoursError = false;
  if (d.hoursAuto === false) {
    var h = Number(raw('hours'));
    if (raw('hours')) {
      if (h > 0 && h <= LIMIT.HOURS && Math.abs(h * 2 - Math.round(h * 2)) < 1e-9) hours = h;
      else { errors.push('「包裝時段數」請以 0.5 為單位，例如 0.5、1、1.5'); hoursError = true; }
    }
  } else if (modelRow) {
    var auto = autoHours(qty, modelRow.capacity);
    if (auto != null) { hours = auto; hoursNote = autoHoursNote(qty, modelRow.capacity); }
  }
  if (seq !== '' && hours === '' && !hoursError) {
    errors.push('要排入包裝，請填「包裝時段數」（或到機型清單設定每時段包裝數量）');
  }

  return {
    errors: errors,
    wo: wo,
    hoursNote: hoursNote,
    row: [safeText(orderNo), safeText(wo), safeText(customer), safeText(model), qty, ship, method, status,
      asmDone, testDone, seq, hours, '', '', false, safeText(note)]
  };
}

// ---------- 排程 ----------

/**
 * 主要計算。input：
 *   today, nowMinutes, times{amS,amE,pmS,pmE,otS,otE}, yellowAhead, ganttDays,
 *   calendar[{serial,am,pm,ot,prep}],
 *   orders[{row,orderNo,wo,customer,model,qty,ship,method,status,asmDone,testDone,seq,hours,
 *           fixedSerial,fixedLabel,prepped}]
 */
function computeAll(input) {
  var today = input.today;
  var nowRaw = rawNowKey(today, input.nowMinutes, input.times);

  var from = today - 30;
  input.orders.forEach(function (o) {
    if (o.fixedSerial != null && o.fixedSerial < from) from = o.fixedSerial;
  });
  var tl = buildTimeline(input.calendar, from, today + 400);
  var W = tl.work, P = tl.prep;

  var nowIdx = lowerBound(W, nowRaw);
  var nowKey = nowIdx < W.length ? W[nowIdx] : nowRaw;
  var nowPrepIdx = lowerBound(P, fullOfHalf(nowRaw));

  var woCount = {};
  input.orders.forEach(function (o) { woCount[o.wo] = (woCount[o.wo] || 0) + 1; });

  var results = input.orders.map(function (o) {
    var r = { src: o, fixedKey: null, startKey: null, lastKey: null, deadlineFull: null,
      deadlineIdx: -1, error: null, stamp: null, light: '', startText: '', endText: '',
      deadlineText: '', shipRisk: false };
    if (o.fixedSerial != null) {
      var li = Math.max(0, START_LABELS.indexOf(o.fixedLabel));
      r.fixedKey = halfKey(o.fixedSerial, Math.floor(li / 2), li % 2);
    } else if (o.status === STATUS.PACKING && nowIdx < W.length) {
      // 狀態改成「包裝中」但沒填開始時間：自動記下現在的時段
      r.fixedKey = nowKey;
      r.stamp = { serial: serialOfHalf(nowKey), label: START_LABELS[nowKey % 6] };
    }
    return r;
  });

  // 排隊：包裝中的排最前面，其餘依包裝順序，前一張結束後才能開始
  var queue = results.filter(function (r) {
    if (!isQueued(r.src)) return false;
    if (!(r.src.hours > 0)) { r.error = LIGHT.MISSING_HOURS; return false; }
    return true;
  }).sort(function (a, b) { return compareQueue(a.src, b.src); });

  var prevLast = -1;
  queue.forEach(function (r) {
    var units = Math.ceil(r.src.hours * 2 - 1e-9);
    var fixedIdx = r.fixedKey != null ? lowerBound(W, r.fixedKey) : -1;
    var s = (r.src.status === STATUS.PACKING && r.fixedKey != null)
      ? fixedIdx
      : Math.max(prevLast + 1, nowIdx, fixedIdx);
    var last = s + units - 1;
    if (last >= W.length) {
      r.error = LIGHT.OVERFLOW;
      prevLast = W.length;
      return;
    }
    r.startKey = W[s];
    r.lastKey = W[last];
    prevLast = last;

    // 最晚備料 = 包裝開始的那個時段之前，備料人員的最後一個時段
    r.deadlineIdx = lowerBound(P, fullOfHalf(r.startKey)) - 1;
    r.deadlineFull = r.deadlineIdx >= 0 ? P[r.deadlineIdx] : null;
  });

  results.forEach(function (r) {
    var o = r.src;
    if (r.startKey != null) {
      r.startText = startText(r.startKey);
      r.endText = endText(r.lastKey);
      r.deadlineText = r.deadlineFull != null ? fullSlotText(r.deadlineFull) : '（無備料時段）';
      r.shipRisk = o.ship != null && serialOfHalf(r.lastKey) > o.ship;
    }
    r.light = lightOf(r, nowPrepIdx, input.yellowAhead, woCount[o.wo] > 1);
  });

  var active = results.filter(function (r) { return r.src.status !== STATUS.DONE; });
  var prepList = active.slice().sort(function (a, b) {
    var as = a.startKey == null ? Infinity : a.startKey;
    var bs = b.startKey == null ? Infinity : b.startKey;
    return as - bs || a.src.row - b.src.row;
  });

  var summary = { red: 0, yellow: 0, onSite: 0 };
  active.forEach(function (r) {
    if (r.light.indexOf('🔴') === 0) summary.red++;
    if (r.light.indexOf('🟡') === 0) summary.yellow++;
    if (r.src.prepped) summary.onSite++;
  });

  return {
    nowKey: nowKey,
    results: results,
    prepList: prepList,
    summary: summary,
    gantt: buildGantt(prepList.slice(0, GANTT_MAX_ROWS), tl, today, input.ganttDays, nowKey)
  };
}

function lightOf(r, nowPrepIdx, yellowAhead, duplicated) {
  var o = r.src;
  if (o.status === STATUS.DONE) return LIGHT.FINISHED;
  if (duplicated) return LIGHT.DUPLICATE;
  if (r.error) return r.error;
  if (!isQueued(o)) return LIGHT.UNQUEUED;
  if (o.prepped) return LIGHT.PREPPED;
  if (r.deadlineIdx < 0) return LIGHT.OVERDUE;
  var diff = r.deadlineIdx - nowPrepIdx;
  if (diff < 0) return LIGHT.OVERDUE;
  if (diff === 0) return LIGHT.NOW;
  if (diff <= yellowAhead) return LIGHT.NEXT;
  return LIGHT.LATER;
}

function buildGantt(rows, tl, today, ganttDays, nowKey) {
  // 從「現在」所在的那天開始（加班結束後就從隔天開始）
  var first = Math.max(today, serialOfHalf(nowKey));
  var days = [], colKeys = [];
  for (var s = first; s < first + ganttDays; s++) {
    var d = tl.dayInfo(s);
    var flags = [d.am, d.pm, d.ot];
    var keys = [], slots = [];
    for (var i = 0; i < 3; i++) {
      if (!flags[i]) continue;
      slots.push({ slot: i, offset: keys.length });
      keys.push(halfKey(s, i, 0), halfKey(s, i, 1));
    }
    if (!keys.length) continue;
    days.push({ serial: s, label: dayLabel(s), offset: colKeys.length, width: keys.length, slots: slots });
    colKeys = colKeys.concat(keys);
  }

  var cells = rows.map(function (r) {
    return colKeys.map(function (c) { return ganttCell(r, c, nowKey); });
  });

  var counts = colKeys.map(function (c) {
    if (c < nowKey) return '';
    var n = 0;
    rows.forEach(function (r) {
      if (r.startKey == null || c > r.lastKey) return;
      if (r.src.prepped || r.deadlineFull == null || c >= r.deadlineFull * 2) n++;
    });
    return n || '';
  });

  return { days: days, colKeys: colKeys, rows: rows, cells: cells, counts: counts,
    nowCol: colKeys.indexOf(nowKey) };
}

function ganttCell(r, c, nowKey) {
  var o = r.src, s = serialOfHalf(c);
  var cell = { bg: null, text: '', font: null, bold: false };
  if (c >= nowKey) {
    if (isEarlyStage(o.status) && o.asmDone != null && s <= o.asmDone) {
      cell.bg = (o.status === STATUS.OUTSOURCE || o.method === METHOD_OUTSOURCE) ? COLOR.OUTSOURCE : COLOR.ASSEMBLY;
    } else if ((isEarlyStage(o.status) || o.status === STATUS.TEST) && o.testDone != null && s <= o.testDone &&
               (o.status === STATUS.TEST || o.asmDone == null || s > o.asmDone)) {
      cell.bg = COLOR.TEST;
    } else if (o.status === STATUS.WAITING && r.startKey != null && c < r.startKey) {
      cell.bg = COLOR.WAIT;
    }
  }
  if (r.startKey != null && c >= r.startKey && c <= r.lastKey) {
    cell.bg = o.status === STATUS.PACKING ? COLOR.PACKING_NOW : COLOR.PACK;
  }
  if (!o.prepped && r.deadlineFull != null && c === r.deadlineFull * 2) {
    cell.text = '備';
    cell.font = COLOR.PREP_MARK;
    cell.bold = true;
    if (!cell.bg) cell.bg = COLOR.RED_BG;
  }
  return cell;
}

// ============================================================
// 3. 試算表讀寫、觸發器
// ============================================================

/** 選單與觸發器呼叫的入口 */
function refreshAll() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    refreshAll_(SpreadsheetApp.getActiveSpreadsheet());
  } finally {
    lock.releaseLock();
  }
}

/** 由 setup 安裝的「編輯時」觸發器，以試算表擁有者身分執行 */
function onEditInstalled(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = e.source || SpreadsheetApp.getActiveSpreadsheet();
    var sheet = e.range.getSheet();
    var name = sheet.getName();
    if (name === SHEET.GANTT) return;
    if (name === SHEET.PREP) syncPrepChecks_(ss, e.range);
    if (name === SHEET.ORDERS) {
      // 手動改了包裝時段數，就不再自動計算（清空則恢復自動）
      if (rangeHasColumn_(e.range, COL.HOURS)) clearAutoNotes_(sheet, e.range);
      if (rangeHasColumn_(e.range, COL.CUSTOMER)) applyModelValidations_(ss);
    }
    if (name === SHEET.CUSTOMERS || name === SHEET.MODELS) applyModelValidations_(ss);
    refreshAll_(ss);
  } finally {
    lock.releaseLock();
  }
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📦 排程工具')
    .addItem('＋ 新增工單', 'showNewOrderDialog')
    .addItem('立即更新', 'menuRefresh')
    .addItem('重新編號包裝順序', 'menuRenumber')
    .addToUi();
}

function menuRenumber() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var count = planRenumber(readOrders_(ss.getSheetByName(SHEET.ORDERS), ss.getSpreadsheetTimeZone())).length;
  if (!count) {
    ss.toast('目前沒有排入包裝的工單', '📦 排程工具', 5);
    return;
  }
  var answer = ui.alert('重新編號包裝順序',
    '會把 ' + count + ' 張排入包裝的工單，依目前的先後重新編成 1～' + count + '。\n' +
    '包裝的先後順序不會改變。要繼續嗎？', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    renumber_(ss);
  } finally {
    lock.releaseLock();
  }
  ss.toast('已重新編號 ' + count + ' 張工單', '📦 排程工具', 5);
}

/** 把包裝順序改成 1、2、3…（完成或未排入的工單不動），回傳編號的張數 */
function renumber_(ss) {
  var sheet = ss.getSheetByName(SHEET.ORDERS);
  var plan = planRenumber(readOrders_(sheet, ss.getSpreadsheetTimeZone()));
  if (!plan.length) return 0;
  var range = sheet.getRange(2, COL.SEQ, sheet.getLastRow() - 1, 1);
  var col = range.getValues();
  plan.forEach(function (p) { col[p.row - 2][0] = p.seq; });
  range.setValues(col);
  refreshAll_(ss);
  return plan.length;
}

function menuRefresh() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    refreshAll();
    ss.toast('排程已更新', '📦 排程工具', 3);
  } catch (err) {
    ss.toast('更新失敗：' + err.message, '📦 排程工具', 8);
  }
}

function refreshAll_(ss) {
  var tz = ss.getSpreadsheetTimeZone();
  var now = nowParts_(tz);
  var settings = readSettings_(ss, tz);

  var calSheet = ss.getSheetByName(SHEET.CALENDAR);
  try {
    ensureCalendar_(calSheet, now.today, settings.keepDays, tz);
  } catch (err) {
    // 工作日曆只有擁有者能改；由其他人觸發時跳過，交給每 30 分鐘的自動更新
  }

  var ordersSheet = ss.getSheetByName(SHEET.ORDERS);
  var orders = readOrders_(ordersSheet, tz);
  planAutoHours(orders, readModels_(ss)).forEach(function (u) {
    ordersSheet.getRange(u.row, COL.HOURS).setValue(u.hours).setNote(u.note);
  });

  var res = computeAll({
    today: now.today,
    nowMinutes: now.minutes,
    times: settings.times,
    yellowAhead: settings.yellowAhead,
    ganttDays: settings.ganttDays,
    calendar: readCalendar_(calSheet, tz),
    orders: orders
  });

  var updated = Utilities.formatDate(new Date(), tz, 'M/d HH:mm');
  writeOrdersAuto_(ordersSheet, res);
  writePrep_(ss.getSheetByName(SHEET.PREP), res, updated);
  writeGantt_(ss.getSheetByName(SHEET.GANTT), res.gantt, updated);
}

// ---------- 讀取 ----------

function nowParts_(tz) {
  var parts = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm').split(' ');
  var d = parts[0].split('-').map(Number);
  var t = parts[1].split(':').map(Number);
  return { today: serialFromYmd(d[0], d[1], d[2]), minutes: t[0] * 60 + t[1] };
}

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function toSerial_(v, tz) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return Math.floor(v);
  if (isDate_(v)) {
    var d = Utilities.formatDate(v, tz, 'yyyy-MM-dd').split('-').map(Number);
    return serialFromYmd(d[0], d[1], d[2]);
  }
  var m = String(v).trim().match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  return m ? serialFromYmd(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

function toNumber_(v) {
  if (typeof v === 'number') return v;
  var s = String(v == null ? '' : v).trim();
  return s !== '' && isFinite(Number(s)) ? Number(s) : null;
}

function readSettings_(ss, tz) {
  var values = ss.getSheetByName(SHEET.SETTINGS).getRange(2, 1, SETTING_ROWS.length, 2).getValues();
  var map = {};
  values.forEach(function (row) { map[String(row[0]).trim()] = row[1]; });
  var def = function (label) {
    return SETTING_ROWS.filter(function (r) { return r[0] === label; })[0][1];
  };
  var get = function (label) {
    return map[label] === undefined || map[label] === '' ? def(label) : map[label];
  };
  var time = function (label) {
    var v = get(label);
    var t = isDate_(v) ? parseTimeText(Utilities.formatDate(v, tz, 'HH:mm')) : parseTimeText(v);
    return isNaN(t) ? parseTimeText(def(label)) : t;
  };
  var num = function (label, min, max) {
    var n = toNumber_(get(label));
    if (n == null) n = toNumber_(def(label));
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  return {
    times: {
      amS: time('上午開始'), amE: time('上午結束'),
      pmS: time('下午開始'), pmE: time('下午結束'),
      otS: time('加班開始'), otE: time('加班結束')
    },
    yellowAhead: num('黃燈提前時段數', 0, 10),
    ganttDays: num('甘特圖顯示天數', 3, 31),
    keepDays: num('日曆保留未來天數', 30, 365)
  };
}

/** 讀取某欄從第 2 列起的非空白值（不重複） */
function readList_(sheet, col) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var out = [];
  sheet.getRange(2, col, last - 1, 1).getValues().forEach(function (row) {
    var v = String(row[0]).trim();
    if (v && out.indexOf(v) < 0) out.push(v);
  });
  return out;
}

function readCustomers_(ss) {
  return readList_(ss.getSheetByName(SHEET.CUSTOMERS), 1);
}

function readModels_(ss) {
  var sheet = ss.getSheetByName(SHEET.MODELS);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, 3).getValues()
    .map(function (row) {
      return { customer: String(row[0]).trim(), model: String(row[1]).trim(), capacity: toNumber_(row[2]) };
    })
    .filter(function (m) { return m.customer && m.model; });
}

function readCalendar_(sheet, tz) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, 6).getValues()
    .map(function (row) {
      return { serial: toSerial_(row[0], tz), am: row[2] === true, pm: row[3] === true,
        ot: row[4] === true, prep: row[5] === true };
    })
    .filter(function (r) { return r.serial != null; });
}

function readOrders_(sheet, tz) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var values = sheet.getRange(2, 1, last - 1, INPUT_COLS).getValues();
  var notes = sheet.getRange(2, COL.HOURS, last - 1, 1).getNotes();
  var orders = [];
  values.forEach(function (v, i) {
    var wo = String(v[COL.WO - 1]).trim();
    if (!wo) return;
    orders.push({
      row: i + 2,
      orderNo: v[COL.ORDER_NO - 1],
      wo: wo,
      customer: String(v[COL.CUSTOMER - 1]).trim(),
      model: String(v[COL.MODEL - 1]).trim(),
      qty: v[COL.QTY - 1],
      ship: toSerial_(v[COL.SHIP - 1], tz),
      method: String(v[COL.METHOD - 1]).trim(),
      status: String(v[COL.STATUS - 1]).trim() || STATUS.NOT_STARTED,
      asmDone: toSerial_(v[COL.ASM_DONE - 1], tz),
      testDone: toSerial_(v[COL.TEST_DONE - 1], tz),
      seq: toNumber_(v[COL.SEQ - 1]),
      hours: toNumber_(v[COL.HOURS - 1]),
      hoursNote: String(notes[i][0] || ''),
      fixedSerial: toSerial_(v[COL.FIXED_DATE - 1], tz),
      fixedLabel: String(v[COL.FIXED_SLOT - 1]).trim(),
      prepped: v[COL.PREPPED - 1] === true
    });
  });
  return orders;
}

function rangeHasColumn_(range, col) {
  return range.getColumn() <= col && col <= range.getColumn() + range.getNumColumns() - 1;
}

function clearAutoNotes_(sheet, range) {
  var first = Math.max(range.getRow(), 2);
  var last = range.getRow() + range.getNumRows() - 1;
  if (last >= first) sheet.getRange(first, COL.HOURS, last - first + 1, 1).clearNote();
}

// ---------- 寫入 ----------

function writeOrdersAuto_(sheet, res) {
  var last = sheet.getLastRow();
  if (last < 2) return;
  var out = [];
  for (var i = 2; i <= last; i++) out.push(['', '', '', '']);
  res.results.forEach(function (r) {
    out[r.src.row - 2] = [r.startText, r.endText, r.deadlineText, r.light];
    if (r.stamp) {
      sheet.getRange(r.src.row, COL.FIXED_DATE).setValue(r.stamp.serial);
      sheet.getRange(r.src.row, COL.FIXED_SLOT).setValue(r.stamp.label);
    }
  });
  sheet.getRange(2, COL.START, out.length, AUTO_COLS).setValues(out);
}

function writePrep_(sheet, res, updated) {
  var s = res.summary;
  sheet.getRange(1, 1).setValue('🔴 ' + s.red + ' 張要備　🟡 ' + s.yellow + ' 張下個時段　' +
    '現場包材 ' + s.onSite + ' 張　（' + updated + ' 更新）');

  var width = PREP_HEADERS.length;
  var maxR = sheet.getMaxRows();
  if (maxR >= PREP_FIRST_ROW) {
    var old = sheet.getRange(PREP_FIRST_ROW, 1, maxR - PREP_FIRST_ROW + 1, width);
    old.clearContent();
    old.clearFormat();
    old.clearDataValidations();
    old.clearNote();
  }
  var list = res.prepList;
  var n = list.length;
  if (!n) {
    sheet.getRange(PREP_FIRST_ROW, 1).setValue('目前沒有未完成的工單');
    return;
  }
  if (PREP_FIRST_ROW + n - 1 > maxR) sheet.insertRowsAfter(maxR, PREP_FIRST_ROW + n - 1 - maxR);

  var values = [], bgs = [];
  list.forEach(function (r) {
    var o = r.src;
    values.push([r.light, o.prepped, o.wo, r.startText || '—', r.deadlineText || '—', o.customer, o.model,
      o.qty, o.status, o.orderNo, o.ship == null ? '' : o.ship, o.row]);
    var bg = lightBackground(r.light);
    var rowBg = [];
    for (var i = 0; i < width; i++) rowBg.push(bg);
    if (r.shipRisk) rowBg[PREP_COL.SHIP - 1] = COLOR.RED_BG;
    bgs.push(rowBg);
  });

  // 工單編號、客戶等設為純文字，避免「0012」被轉成數字
  [PREP_COL.WO, PREP_COL.START, PREP_COL.DEADLINE, PREP_COL.CUSTOMER, PREP_COL.MODEL,
    PREP_COL.STATUS, PREP_COL.ORDER_NO].forEach(function (c) {
    sheet.getRange(PREP_FIRST_ROW, c, n, 1).setNumberFormat('@');
  });
  sheet.getRange(PREP_FIRST_ROW, PREP_COL.SHIP, n, 1).setNumberFormat('m/d');
  sheet.getRange(PREP_FIRST_ROW, PREP_COL.PREPPED, n, 1).insertCheckboxes();
  var range = sheet.getRange(PREP_FIRST_ROW, 1, n, width);
  range.setValues(values);
  range.setBackgrounds(bgs);
  range.setFontSize(12).setVerticalAlignment('middle');
  sheet.getRange(PREP_FIRST_ROW, 1, n, 2).setHorizontalAlignment('center');
  list.forEach(function (r, i) {
    if (r.shipRisk) {
      sheet.getRange(PREP_FIRST_ROW + i, PREP_COL.SHIP).setFontWeight('bold').setFontColor(COLOR.PREP_MARK)
        .setNote('預計包裝結束晚於出貨日');
    }
  });
}

function writeGantt_(sheet, g, updated) {
  var nCols = GANTT_LABEL_COLS + g.colKeys.length;
  var nRows = GANTT_FIRST_ROW + g.rows.length;
  if (sheet.getMaxColumns() < nCols) sheet.insertColumnsAfter(sheet.getMaxColumns(), nCols - sheet.getMaxColumns());
  if (sheet.getMaxRows() < nRows) sheet.insertRowsAfter(sheet.getMaxRows(), nRows - sheet.getMaxRows());

  var all = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns());
  all.breakApart();
  all.clearContent();
  all.clearFormat();

  sheet.getRange(1, 1).setValue('甘特圖（' + updated + ' 更新）').setFontWeight('bold');
  sheet.getRange(1, 4).setRichTextValue(ganttLegend_());

  // 標題列：A～C 跨兩列，日期跨當天所有欄，時段跨前後半兩欄
  ['工單編號', '機型', '狀態'].forEach(function (h, i) {
    sheet.getRange(2, i + 1, 2, 1).merge().setValue(h);
  });
  g.days.forEach(function (d) {
    var col = GANTT_LABEL_COLS + 1 + d.offset;
    sheet.getRange(2, col, 1, d.width).merge().setValue(d.label);
    d.slots.forEach(function (sl) {
      var slotRange = sheet.getRange(3, col + sl.offset, 1, 2).merge().setValue(SLOT_NAMES[sl.slot]);
      if (g.nowCol >= d.offset + sl.offset && g.nowCol < d.offset + sl.offset + 2) {
        slotRange.setBackground(COLOR.NOW_HEADER);
      }
    });
  });
  var header = sheet.getRange(2, 1, 2, nCols);
  header.setFontSize(9).setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.getRange(2, 1, 2, GANTT_LABEL_COLS).setBackground(COLOR.HEADER_INPUT);

  if (!g.rows.length) {
    sheet.getRange(GANTT_FIRST_ROW, 1).setValue('目前沒有未完成的工單');
  } else {
    var values = [], bgs = [], fonts = [], weights = [];
    g.rows.forEach(function (r, i) {
      values.push([r.src.wo, r.src.model, r.src.status]);
      bgs.push([null, null, null]);
      fonts.push([null, null, null]);
      weights.push(['normal', 'normal', 'normal']);
      g.cells[i].forEach(function (c) {
        values[i].push(c.text);
        bgs[i].push(c.bg);
        fonts[i].push(c.font);
        weights[i].push(c.bold ? 'bold' : 'normal');
      });
    });
    values.push(['現場包材數', '', ''].concat(g.counts));
    bgs.push([COLOR.HEADER_AUTO, COLOR.HEADER_AUTO, COLOR.HEADER_AUTO].concat(g.counts.map(function () { return COLOR.AUTO_BG; })));
    fonts.push([null, null, null].concat(g.counts.map(function () { return null; })));
    weights.push(['bold', 'normal', 'normal'].concat(g.counts.map(function () { return 'bold'; })));

    var body = sheet.getRange(GANTT_FIRST_ROW, 1, values.length, nCols);
    body.setNumberFormat('@');
    body.setValues(values);
    body.setBackgrounds(bgs);
    body.setFontColors(fonts);
    body.setFontWeights(weights);
    body.setFontSize(9).setVerticalAlignment('middle');
    sheet.getRange(GANTT_FIRST_ROW, GANTT_LABEL_COLS + 1, values.length, g.colKeys.length).setHorizontalAlignment('center');
  }

  // 每天第一欄加左邊框，方便分辨日期
  var height = GANTT_FIRST_ROW - 1 + Math.max(g.rows.length, 1);
  g.days.forEach(function (d) {
    sheet.getRange(2, GANTT_LABEL_COLS + 1 + d.offset, height, 1)
      .setBorder(null, true, null, null, null, null, '#666666', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  });

  sheet.setColumnWidth(1, 95);
  sheet.setColumnWidth(2, 130);
  sheet.setColumnWidth(3, 60);
  if (g.colKeys.length) sheet.setColumnWidths(GANTT_LABEL_COLS + 1, g.colKeys.length, 18);
}

function ganttLegend_() {
  var items = [
    ['■', COLOR.ASSEMBLY, '組裝 '], ['■', COLOR.OUTSOURCE, '外包組裝 '], ['■', COLOR.TEST, '測試 '],
    ['■', COLOR.WAIT, '待包裝 '], ['■', COLOR.PACK, '包裝 '], ['■', COLOR.PACKING_NOW, '包裝中 '],
    ['備', COLOR.PREP_MARK, '＝最晚備料時段　'], ['■', COLOR.NOW_HEADER, '現在時段']
  ];
  var text = '', marks = [];
  items.forEach(function (it) {
    marks.push([text.length, text.length + it[0].length, it[1]]);
    text += it[0] + it[2];
  });
  var builder = SpreadsheetApp.newRichTextValue().setText(text);
  marks.forEach(function (m) {
    builder.setTextStyle(m[0], m[1], SpreadsheetApp.newTextStyle().setForegroundColor(m[2]).setBold(true).build());
  });
  return builder.build();
}

/** ③ 勾選「已備料」時，寫回 ① 工單排程 */
function syncPrepChecks_(ss, range) {
  if (!rangeHasColumn_(range, PREP_COL.PREPPED)) return;
  var firstRow = Math.max(range.getRow(), PREP_FIRST_ROW);
  var lastRow = range.getRow() + range.getNumRows() - 1;
  if (lastRow < firstRow) return;

  var prep = range.getSheet();
  var orders = ss.getSheetByName(SHEET.ORDERS);
  var rows = prep.getRange(firstRow, 1, lastRow - firstRow + 1, PREP_HEADERS.length).getValues();
  rows.forEach(function (row) {
    var wo = String(row[PREP_COL.WO - 1]).trim();
    var srcRow = Number(row[PREP_COL.SRC - 1]);
    if (!wo || !srcRow) return;
    if (String(orders.getRange(srcRow, COL.WO).getValue()).trim() !== wo) {
      srcRow = findOrderRow_(orders, wo);
      if (!srcRow) return;
    }
    orders.getRange(srcRow, COL.PREPPED).setValue(row[PREP_COL.PREPPED - 1] === true);
  });
}

function findOrderRow_(sheet, wo) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var col = sheet.getRange(2, COL.WO, last - 1, 1).getValues();
  for (var i = 0; i < col.length; i++) {
    if (String(col[i][0]).trim() === wo) return i + 2;
  }
  return 0;
}

/**
 * 依每列的客戶，把「機型」欄的下拉選單限縮成該客戶的機型。
 * 指定 onlyRow 時只更新那一列。
 */
function applyModelValidations_(ss, onlyRow) {
  var orders = ss.getSheetByName(SHEET.ORDERS);
  var first = onlyRow || 2;
  var n = onlyRow ? 1 : orders.getMaxRows() - 1;
  var customers = orders.getRange(first, COL.CUSTOMER, n, 1).getValues();
  var byCustomer = modelsByCustomer(readModels_(ss));
  var allModels = SpreadsheetApp.newDataValidation()
    .requireValueInRange(ss.getSheetByName(SHEET.MODELS).getRange('B2:B'), true)
    .setAllowInvalid(false).setHelpText('請先選客戶，再選機型').build();
  var cache = {};
  var rules = customers.map(function (row) {
    var c = String(row[0]).trim();
    var list = byCustomer[c];
    if (!list || !list.length) return [allModels];
    if (!cache[c]) {
      cache[c] = SpreadsheetApp.newDataValidation().requireValueInList(list.slice(0, 500), true)
        .setAllowInvalid(false).setHelpText('「' + c + '」的機型；要新增機型請到「機型清單」').build();
    }
    return [cache[c]];
  });
  orders.getRange(first, COL.MODEL, n, 1).setDataValidations(rules);
}

/** 工作日曆少於設定天數時，自動往後補，並套用預設的上班時段 */
function ensureCalendar_(sheet, today, keepDays, tz) {
  var last = sheet.getLastRow();
  var lastSerial = last >= 2 ? toSerial_(sheet.getRange(last, 1).getValue(), tz) : null;
  var start = lastSerial == null ? today - 7 : lastSerial + 1;
  var end = today + keepDays;
  if (start > end) return;

  var rows = [], bgs = [];
  for (var s = start; s <= end; s++) {
    var d = defaultDay(s);
    var w = weekdayOf(s);
    rows.push([s, WEEKDAY_NAMES[w], d.am, d.pm, d.ot, d.prep, '']);
    var bg = w === 0 ? COLOR.SUNDAY : (w === 6 ? COLOR.SATURDAY : null);
    bgs.push([bg, bg, bg, bg, bg, bg, bg]);
  }
  var firstRow = Math.max(last, 1) + 1;
  var need = firstRow + rows.length - 1;
  if (need > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), need - sheet.getMaxRows());

  sheet.getRange(firstRow, 1, rows.length, 1).setNumberFormat('yyyy/mm/dd');
  sheet.getRange(firstRow, 3, rows.length, 4).insertCheckboxes();
  var range = sheet.getRange(firstRow, 1, rows.length, CAL_HEADERS.length);
  range.setValues(rows);
  range.setBackgrounds(bgs);
  sheet.getRange(firstRow, 2, rows.length, 5).setHorizontalAlignment('center');
}

// ============================================================
// 4. 新增工單視窗
// ============================================================

/** 按鍵與選單呼叫：開啟新增工單視窗（只能在電腦版使用） */
function showNewOrderDialog() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var html = HtmlService.createHtmlOutput(newOrderHtml_(newOrderDialogData_(ss)))
    .setWidth(620).setHeight(720);
  SpreadsheetApp.getUi().showModalDialog(html, '＋ 新增工單');
}

function orderContext_(ss, orders) {
  var settings = ss.getSheetByName(SHEET.SETTINGS);
  var statuses = readList_(settings, 5);
  var methods = readList_(settings, 6);
  return {
    customers: readCustomers_(ss),
    models: readModels_(ss),
    statuses: statuses.length ? statuses : STATUS_LIST,
    methods: methods.length ? methods : METHOD_LIST,
    existingWos: orders.map(function (o) { return o.wo; }),
    nextSeq: nextSeq(orders)
  };
}

function newOrderDialogData_(ss) {
  var orders = readOrders_(ss.getSheetByName(SHEET.ORDERS), ss.getSpreadsheetTimeZone());
  var ctx = orderContext_(ss, orders);
  return {
    customers: ctx.customers,
    models: ctx.models,
    statuses: ctx.statuses,
    methods: ctx.methods,
    existingWos: ctx.existingWos,
    defaultStatus: STATUS.NOT_STARTED
  };
}

/** 視窗按「新增工單」時呼叫；以操作者本人的身分執行 */
function addWorkOrder(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET.ORDERS);
    var orders = readOrders_(sheet, ss.getSpreadsheetTimeZone());
    var v = validateNewOrder(data, orderContext_(ss, orders));
    if (v.errors.length) return { ok: false, errors: v.errors };

    var row = orders.reduce(function (max, o) { return Math.max(max, o.row); }, 1) + 1;
    if (row > sheet.getMaxRows()) return { ok: false, errors: ['工單排程已經滿了，請聯絡試算表擁有者整理舊資料'] };

    sheet.getRange(row, 1, 1, INPUT_COLS).setValues([v.row]);
    var hoursCell = sheet.getRange(row, COL.HOURS);
    if (v.hoursNote) hoursCell.setNote(v.hoursNote); else hoursCell.clearNote();
    applyModelValidations_(ss, row);

    var warning = '';
    try {
      refreshAll_(ss);
    } catch (err) {
      warning = '排程會在 30 分鐘內自動更新';
    }
    return { ok: true, wo: v.wo, warning: warning };
  } finally {
    lock.releaseLock();
  }
}

/** 產生視窗 HTML；資料以 JSON 嵌入，畫面一律用 textContent 顯示 */
function newOrderHtml_(data) {
  var json = JSON.stringify(data)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return NEW_ORDER_HTML.replace('__DATA__', function () { return json; });
}

var NEW_ORDER_HTML = [
  '<!DOCTYPE html><html><head><base target="_top"><meta charset="utf-8">',
  '<style>',
  'body{font-family:"Microsoft JhengHei","Noto Sans TC",sans-serif;font-size:16px;margin:0;padding:4px 8px;color:#222}',
  '.row{display:flex;gap:14px;margin-bottom:12px}',
  '.field{flex:1;display:flex;flex-direction:column;min-width:0}',
  'label{font-weight:bold;margin-bottom:4px}',
  '.req:after{content:" *";color:#c00}',
  'input,select{font-size:16px;padding:6px 8px;border:1px solid #999;border-radius:4px;background:#fff}',
  'input:focus,select:focus{outline:2px solid #1a73e8}',
  '.hint{font-size:13px;color:#666;margin-top:3px;min-height:16px}',
  '.warn{color:#c00}',
  '.radios{display:flex;gap:16px;align-items:center;flex-wrap:wrap}',
  '.radios label{font-weight:normal;margin:0}',
  '#msg{min-height:24px;margin:6px 0 10px;font-weight:bold}',
  '#msg.err{color:#c00}#msg.ok{color:#2e7d32}',
  '.buttons{display:flex;gap:10px;justify-content:flex-end}',
  'button{font-size:16px;padding:8px 20px;border-radius:4px;border:1px solid #888;background:#fff;cursor:pointer}',
  'button.primary{background:#1a73e8;color:#fff;border-color:#1a73e8}',
  'button:disabled{opacity:.5;cursor:default}',
  '</style></head><body>',
  '<form id="f" autocomplete="off" novalidate>',
  '<div class="row">',
  '  <div class="field"><label class="req" for="customer">客戶</label><select id="customer"></select></div>',
  '  <div class="field"><label class="req" for="model">機型</label><select id="model"></select></div>',
  '</div>',
  '<div class="row">',
  '  <div class="field"><label class="req" for="wo">工單編號</label><input id="wo" maxlength="30"><div class="hint warn" id="woHint"></div></div>',
  '  <div class="field"><label for="orderNo">訂單編號</label><input id="orderNo" maxlength="30"></div>',
  '</div>',
  '<div class="row">',
  '  <div class="field"><label class="req" for="qty">數量</label><input id="qty" type="number" min="1" max="100000" step="1"></div>',
  '  <div class="field"><label for="ship">出貨日</label><input id="ship" type="date"></div>',
  '</div>',
  '<div class="row">',
  '  <div class="field"><label for="method">組裝方式</label><select id="method"></select></div>',
  '  <div class="field"><label for="status">目前狀態</label><select id="status"></select></div>',
  '</div>',
  '<div class="row">',
  '  <div class="field"><label for="asmDone">組裝預計完成日</label><input id="asmDone" type="date"></div>',
  '  <div class="field"><label for="testDone">測試預計完成日</label><input id="testDone" type="date"></div>',
  '</div>',
  '<div class="field" style="margin-bottom:12px"><label>包裝排程</label><div class="radios">',
  '  <label><input type="radio" name="seqMode" value="last" checked> 排到最後</label>',
  '  <label><input type="radio" name="seqMode" value="none"> 先不排入</label>',
  '  <label><input type="radio" name="seqMode" value="custom"> 指定順序</label>',
  '  <input id="seq" type="number" min="0" step="0.1" style="width:90px" disabled>',
  '</div></div>',
  '<div class="row">',
  '  <div class="field"><label for="hours">包裝時段數</label><input id="hours" type="number" min="0.5" step="0.5"><div class="hint" id="hoursHint"></div></div>',
  '  <div class="field"><label for="note">備註</label><input id="note" maxlength="200"></div>',
  '</div>',
  '<div id="msg"></div>',
  '<div class="buttons"><button type="button" id="close">關閉</button><button type="submit" class="primary" id="submit">新增工單</button></div>',
  '</form>',
  '<script>',
  'var DATA = __DATA__;',
  'var hoursManual = false;',
  'function $(id) { return document.getElementById(id); }',
  'function fillSelect(sel, items, placeholder) {',
  '  while (sel.firstChild) sel.removeChild(sel.firstChild);',
  '  if (placeholder !== null) { var p = document.createElement("option"); p.value = ""; p.textContent = placeholder; sel.appendChild(p); }',
  '  items.forEach(function (v) { var o = document.createElement("option"); o.value = v; o.textContent = v; sel.appendChild(o); });',
  '}',
  'function showMsg(cls, lines) {',
  '  var box = $("msg"); box.className = cls;',
  '  while (box.firstChild) box.removeChild(box.firstChild);',
  '  lines.forEach(function (t) { var d = document.createElement("div"); d.textContent = t; box.appendChild(d); });',
  '}',
  'function capacity() {',
  '  var c = $("customer").value, m = $("model").value;',
  '  var hit = DATA.models.filter(function (x) { return x.customer === c && x.model === m; })[0];',
  '  return hit && hit.capacity > 0 ? hit.capacity : 0;',
  '}',
  'function updateHours() {',
  '  if (hoursManual) { $("hoursHint").textContent = "手動填寫（清空可恢復自動計算）"; return; }',
  '  var cap = capacity(), q = Number($("qty").value);',
  '  if (cap && q > 0) {',
  '    $("hours").value = Math.max(0.5, Math.ceil(q / cap * 2 - 1e-9) / 2);',
  '    $("hoursHint").textContent = "自動計算：每時段 " + cap + " 台";',
  '  } else {',
  '    $("hours").value = "";',
  '    $("hoursHint").textContent = !$("model").value ? "" : (cap ? "輸入數量後自動計算" : "這個機型沒有設定每時段包裝數量，請手動填寫");',
  '  }',
  '}',
  'function seqMode() { return document.querySelector("input[name=seqMode]:checked").value; }',
  'fillSelect($("customer"), DATA.customers, "請選擇客戶");',
  'fillSelect($("model"), [], "請先選客戶");',
  'fillSelect($("method"), DATA.methods, "");',
  'fillSelect($("status"), DATA.statuses, null);',
  '$("status").value = DATA.defaultStatus;',
  'if (!DATA.customers.length) showMsg("err", ["請先到「客戶清單」與「機型清單」新增資料"]);',
  '$("customer").addEventListener("change", function () {',
  '  var c = this.value;',
  '  var list = DATA.models.filter(function (m) { return m.customer === c; }).map(function (m) { return m.model; });',
  '  fillSelect($("model"), list, c ? "請選擇機型" : "請先選客戶");',
  '  updateHours();',
  '});',
  '$("model").addEventListener("change", updateHours);',
  '$("qty").addEventListener("input", updateHours);',
  '$("hours").addEventListener("input", function () { hoursManual = this.value !== ""; updateHours(); });',
  '$("wo").addEventListener("input", function () {',
  '  var v = this.value.trim().toUpperCase();',
  '  var dup = v && DATA.existingWos.some(function (w) { return String(w).toUpperCase() === v; });',
  '  $("woHint").textContent = dup ? "這個工單編號已經存在" : "";',
  '});',
  'Array.prototype.forEach.call(document.querySelectorAll("input[name=seqMode]"), function (r) {',
  '  r.addEventListener("change", function () { $("seq").disabled = seqMode() !== "custom"; if (!$("seq").disabled) $("seq").focus(); });',
  '});',
  '$("close").addEventListener("click", function () { google.script.host.close(); });',
  '$("f").addEventListener("submit", function (ev) {',
  '  ev.preventDefault();',
  '  var payload = {',
  '    customer: $("customer").value, model: $("model").value, wo: $("wo").value, orderNo: $("orderNo").value,',
  '    qty: $("qty").value, ship: $("ship").value, method: $("method").value, status: $("status").value,',
  '    asmDone: $("asmDone").value, testDone: $("testDone").value, seqMode: seqMode(), seq: $("seq").value,',
  '    hours: $("hours").value, hoursAuto: !hoursManual, note: $("note").value',
  '  };',
  '  $("submit").disabled = true;',
  '  showMsg("", ["新增中…"]);',
  '  google.script.run',
  '    .withSuccessHandler(function (res) {',
  '      $("submit").disabled = false;',
  '      if (!res.ok) { showMsg("err", res.errors); return; }',
  '      DATA.existingWos.push(res.wo);',
  '      showMsg("ok", ["已新增工單 " + res.wo + (res.warning ? "（" + res.warning + "）" : "") + "，可以繼續輸入下一筆。"]);',
  '      $("wo").value = ""; $("qty").value = ""; $("note").value = ""; $("woHint").textContent = "";',
  '      hoursManual = false; updateHours(); $("wo").focus();',
  '    })',
  '    .withFailureHandler(function (err) {',
  '      $("submit").disabled = false;',
  '      showMsg("err", ["新增失敗：" + (err && err.message ? err.message : err)]);',
  '    })',
  '    .addWorkOrder(payload);',
  '});',
  '</script></body></html>'
].join('\n');

// ============================================================
// 5. 一鍵建置
// ============================================================

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEET.ORDERS)) {
    throw new Error('這份試算表已經建置過了。要重新建置，請建立一份新的空白試算表再執行 setup。');
  }
  ss.setSpreadsheetTimeZone('Asia/Taipei');

  var oldSheets = ss.getSheets();
  SHEET_ORDER.forEach(function (name, i) { ss.insertSheet(name, i); });
  oldSheets.forEach(function (sh) {
    if (sh.getLastRow() === 0 && sh.getLastColumn() === 0) ss.deleteSheet(sh);
  });

  var tz = ss.getSpreadsheetTimeZone();
  var now = nowParts_(tz);

  buildSettingsSheet_(ss.getSheetByName(SHEET.SETTINGS));
  buildCalendarSheet_(ss.getSheetByName(SHEET.CALENDAR), now.today, tz);
  buildCustomersSheet_(ss.getSheetByName(SHEET.CUSTOMERS));
  buildModelsSheet_(ss.getSheetByName(SHEET.MODELS), ss.getSheetByName(SHEET.CUSTOMERS));
  buildOrdersSheet_(ss);
  buildPrepSheet_(ss.getSheetByName(SHEET.PREP));
  buildGanttSheet_(ss.getSheetByName(SHEET.GANTT));
  writeSampleData_(ss, now.today);
  applyModelValidations_(ss);

  installTriggers_(ss);
  applyProtections_(ss);
  refreshAll_(ss);
  ss.setActiveSheet(ss.getSheetByName(SHEET.PREP));
  ss.toast('建置完成！已放入範例資料，可以直接試用。', '📦 排程工具', 10);
}

function styleHeader_(range, color) {
  range.setBackground(color).setFontWeight('bold').setHorizontalAlignment('center')
    .setVerticalAlignment('middle').setWrap(true);
}

/** 在工作表放一個「＋ 新增工單」按鍵（點擊後執行 showNewOrderDialog） */
function insertNewOrderButton_(sheet, column, row) {
  var blob = Utilities.newBlob(Utilities.base64Decode(BUTTON_PNG_BASE64), 'image/png', 'button-new-order.png');
  sheet.insertImage(blob, column, row, 4, 4)
    .setWidth(160).setHeight(36)
    .setAltTextTitle('新增工單')
    .assignScript('showNewOrderDialog');
}

function buildSettingsSheet_(sheet) {
  sheet.setTabColor('#999999');
  sheet.getRange(1, 1, 1, 3).setValues([['項目', '設定值', '說明']]);
  styleHeader_(sheet.getRange(1, 1, 1, 3), COLOR.HEADER_AUTO);
  sheet.getRange(2, 2, 6, 1).setNumberFormat('@');
  sheet.getRange(2, 1, SETTING_ROWS.length, 3).setValues(SETTING_ROWS);

  var lists = [['狀態清單', STATUS_LIST], ['組裝方式', METHOD_LIST], ['指定開始時段（固定）', START_LABELS]];
  lists.forEach(function (l, i) {
    var col = 5 + i;
    sheet.getRange(1, col).setValue(l[0]);
    styleHeader_(sheet.getRange(1, col), COLOR.HEADER_AUTO);
    sheet.getRange(2, col, l[1].length, 1).setValues(l[1].map(function (v) { return [v]; }));
    sheet.setColumnWidth(col, 150);
  });
  sheet.getRange(1, 8).setValue('清單可以往下新增項目，但既有的名稱請不要修改（程式依名稱判斷狀態）。');
  sheet.setColumnWidth(1, 140);
  sheet.setColumnWidth(2, 90);
  sheet.setColumnWidth(3, 360);
  sheet.setFrozenRows(1);
}

function buildCalendarSheet_(sheet, today, tz) {
  sheet.setTabColor('#6AA84F');
  sheet.getRange(1, 1, 1, CAL_HEADERS.length).setValues([CAL_HEADERS]);
  styleHeader_(sheet.getRange(1, 1, 1, CAL_HEADERS.length), COLOR.HEADER_INPUT);
  sheet.getRange(1, 1).setNote('預設：週一～五 上午、下午、晚上加班；週六 上午、下午；週日休息。\n' +
    '國定假日、颱風天、補班日，直接取消或勾選當天的時段即可。');
  sheet.getRange(1, 6).setNote('備料人員只上平日上午、下午。這天不上班就取消勾選，最晚備料時間會自動往前一天推。');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 110);
  sheet.setColumnWidths(2, 5, 90);
  sheet.setColumnWidth(7, 220);
  ensureCalendar_(sheet, today, SETTING_ROWS[8][1], tz);

  var rule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$A2=TODAY()')
    .setBackground(COLOR.YELLOW_BG)
    .setRanges([sheet.getRange('A2:G')])
    .build();
  sheet.setConditionalFormatRules([rule]);
}

function buildCustomersSheet_(sheet) {
  sheet.setTabColor('#8E7CC3');
  sheet.getRange(1, 1, 1, CUSTOMER_HEADERS.length).setValues([CUSTOMER_HEADERS]);
  styleHeader_(sheet.getRange(1, 1, 1, CUSTOMER_HEADERS.length), COLOR.HEADER_INPUT);
  sheet.getRange(1, 1).setNote('在這裡新增客戶，工單排程與新增工單視窗的選單會自動更新。');
  sheet.getRange(2, 1, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 180);
  sheet.setColumnWidth(2, 300);
}

function buildModelsSheet_(sheet, customers) {
  sheet.setTabColor('#8E7CC3');
  sheet.getRange(1, 1, 1, MODEL_HEADERS.length).setValues([MODEL_HEADERS]);
  styleHeader_(sheet.getRange(1, 1, 1, MODEL_HEADERS.length), COLOR.HEADER_INPUT);
  sheet.getRange(1, 1).setNote('每個機型屬於一個客戶。工單排程選了客戶後，機型選單只會列出該客戶的機型。');
  sheet.getRange(1, 3).setNote('一個時段（上午、下午或加班）大約可以包裝幾台。\n' +
    '有填的話，工單的包裝時段數 = 數量 ÷ 這個數字（以 0.5 時段無條件進位）。');
  var n = sheet.getMaxRows() - 1;
  sheet.getRange(2, 1, n, 2).setNumberFormat('@');
  sheet.getRange(2, 1, n, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInRange(customers.getRange('A2:A'), true).setAllowInvalid(false).build());
  sheet.getRange(2, 3, n, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireNumberGreaterThan(0).setAllowInvalid(false).setHelpText('請輸入大於 0 的數字').build());
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(2, 160);
  sheet.setColumnWidth(3, 130);
  sheet.setColumnWidth(4, 260);
}

function buildOrdersSheet_(ss) {
  var sheet = ss.getSheetByName(SHEET.ORDERS);
  var settings = ss.getSheetByName(SHEET.SETTINGS);
  sheet.setTabColor('#3D85C6');
  sheet.getRange(1, 1, 1, ORDER_HEADERS.length).setValues([ORDER_HEADERS]);
  styleHeader_(sheet.getRange(1, 1, 1, INPUT_COLS), COLOR.HEADER_INPUT);
  styleHeader_(sheet.getRange(1, COL.START, 1, AUTO_COLS), COLOR.HEADER_AUTO);
  // 標題列加高，上方放「新增工單」按鍵，標題文字靠下
  sheet.getRange(1, 1, 1, ORDER_HEADERS.length).setVerticalAlignment('bottom');
  sheet.setRowHeight(1, 84);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);

  var notes = {};
  notes[COL.WO] = '必填。一張工單一列；同一張訂單分批包裝，就分成多張工單。';
  notes[COL.CUSTOMER] = '從「客戶清單」選擇。';
  notes[COL.MODEL] = '先選客戶，這裡只會列出該客戶的機型。要新增機型請到「機型清單」。';
  notes[COL.STATUS] = '改成「包裝中」時，如果「指定開始」是空的，系統會自動填入現在的時段。\n改成「完成」後就會離開包裝隊伍。';
  notes[COL.SEQ] = '數字越小越先包裝；「包裝中」的工單一律排最前面。\n' +
    '外包品要插隊時填小數，例如 1.5 會排在 1 和 2 之間，後面的工單自動順延。\n' +
    '空白 = 還沒排入包裝。\n號碼太大或小數太多時，可用選單「📦 排程工具 → 重新編號包裝順序」。';
  notes[COL.HOURS] = '上午、下午、加班各算 1 個時段；半個時段填 0.5。\n' +
    '空白時，系統會用「數量 ÷ 機型的每時段包裝數量」自動計算（儲存格會有「自動計算」註解）。\n直接改數字就變成手動。';
  notes[COL.FIXED_DATE] = '選填。\n・正在包裝的工單：實際開始的日期（狀態改「包裝中」會自動填）。\n・外包品：最早能包裝的日期，系統不會排在這之前。';
  notes[COL.PREPPED] = '包材備好就勾選。也可以在「包裝備料清單」直接勾。';
  notes[COL.START] = '以下四欄由系統自動計算，每次更新都會重算。';
  Object.keys(notes).forEach(function (c) { sheet.getRange(1, Number(c)).setNote(notes[c]); });

  var n = ORDER_ROWS - 1;
  var dv = function () { return SpreadsheetApp.newDataValidation(); };
  sheet.getRange(2, COL.ORDER_NO, n, 4).setNumberFormat('@');
  [COL.SHIP, COL.ASM_DONE, COL.TEST_DONE, COL.FIXED_DATE].forEach(function (c) {
    sheet.getRange(2, c, n, 1).setNumberFormat('m/d')
      .setDataValidation(dv().requireDate().setAllowInvalid(false).setHelpText('請輸入日期，例如 10/24').build());
  });
  sheet.getRange(2, COL.CUSTOMER, n, 1).setDataValidation(
    dv().requireValueInRange(ss.getSheetByName(SHEET.CUSTOMERS).getRange('A2:A'), true).setAllowInvalid(false)
      .setHelpText('請從客戶清單選擇').build());
  sheet.getRange(2, COL.METHOD, n, 1).setDataValidation(
    dv().requireValueInRange(settings.getRange('F2:F20'), true).setAllowInvalid(false).build());
  sheet.getRange(2, COL.STATUS, n, 1).setDataValidation(
    dv().requireValueInRange(settings.getRange('E2:E30'), true).setAllowInvalid(false).build());
  sheet.getRange(2, COL.QTY, n, 1).setDataValidation(
    dv().requireNumberBetween(1, LIMIT.QTY).setAllowInvalid(false).setHelpText('請輸入 1～' + LIMIT.QTY + ' 的數量').build());
  sheet.getRange(2, COL.SEQ, n, 1).setDataValidation(
    dv().requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false).setHelpText('請輸入數字，可用小數插隊，例如 1.5').build());
  var h = colLetter(COL.HOURS) + '2';
  sheet.getRange(2, COL.HOURS, n, 1).setDataValidation(
    dv().requireFormulaSatisfied('=AND(ISNUMBER(' + h + '),' + h + '>0,MOD(' + h + '*2,1)=0)').setAllowInvalid(false)
      .setHelpText('以 0.5 為單位，例如 0.5、1、1.5、2').build());
  sheet.getRange(2, COL.FIXED_SLOT, n, 1).setDataValidation(
    dv().requireValueInList(START_LABELS, true).setAllowInvalid(false).build());
  sheet.getRange(2, COL.PREPPED, n, 1).insertCheckboxes();
  sheet.getRange(2, COL.START, n, AUTO_COLS).setNumberFormat('@').setBackground(COLOR.AUTO_BG);
  sheet.getRange(2, COL.PREPPED, n, 1).setHorizontalAlignment('center');

  var widths = [90, 95, 100, 110, 60, 70, 75, 80, 90, 90, 70, 70, 80, 90, 60, 180, 130, 130, 130, 100];
  widths.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });

  var lightRange = sheet.getRange(2, COL.LIGHT, n, 1);
  var cf = function () { return SpreadsheetApp.newConditionalFormatRule(); };
  sheet.setConditionalFormatRules([
    cf().whenFormulaSatisfied('=$' + colLetter(COL.STATUS) + '2="' + STATUS.DONE + '"').setFontColor(COLOR.DONE_FONT)
      .setRanges([sheet.getRange(2, 1, n, ORDER_HEADERS.length)]).build(),
    cf().whenTextStartsWith('🔴').setBackground(COLOR.RED_BG).setRanges([lightRange]).build(),
    cf().whenTextStartsWith('🟡').setBackground(COLOR.YELLOW_BG).setRanges([lightRange]).build(),
    cf().whenTextStartsWith('🟢').setBackground(COLOR.GREEN_BG).setRanges([lightRange]).build(),
    cf().whenTextStartsWith('⚠').setBackground(COLOR.WARN_BG).setRanges([lightRange]).build()
  ]);

  insertNewOrderButton_(sheet, 1, 1);
}

function buildPrepSheet_(sheet) {
  sheet.setTabColor('#E06666');
  sheet.getRange(1, 1, 1, 7).merge().setFontWeight('bold').setFontSize(12).setVerticalAlignment('middle');
  sheet.setRowHeight(1, 46);
  sheet.getRange(2, 1, 1, PREP_HEADERS.length).setValues([PREP_HEADERS]);
  styleHeader_(sheet.getRange(2, 1, 1, PREP_HEADERS.length), COLOR.HEADER_INPUT);
  sheet.getRange(2, 1, 1, PREP_HEADERS.length).setFontSize(12);
  sheet.getRange(2, PREP_COL.DEADLINE).setNote('包材最晚要在這個時段結束前備好。');
  sheet.setFrozenRows(2);
  var widths = [105, 65, 100, 135, 120, 110, 130, 60, 70, 90, 70, 60];
  widths.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
  sheet.hideColumns(PREP_COL.SRC);
  insertNewOrderButton_(sheet, PREP_COL.QTY, 1);
}

function buildGanttSheet_(sheet) {
  sheet.setTabColor('#F1C232');
  sheet.setFrozenRows(3);
  sheet.setFrozenColumns(GANTT_LABEL_COLS);
}

function writeSampleData_(ss, t) {
  // 範例資料全部是虛構的；日期都相對於今天，讓試用時畫面上有內容
  var customers = [['甲公司', ''], ['乙科技', ''], ['丙電子', '']];
  ss.getSheetByName(SHEET.CUSTOMERS).getRange(2, 1, customers.length, 2).setValues(customers);

  var models = [
    ['甲公司', 'PS-500', 100, '電源供應器'],
    ['甲公司', 'PS-300', 120, '電源供應器'],
    ['乙科技', 'CB-20', 60, '控制主機板'],
    ['乙科技', 'SM-3', 100, '感測模組'],
    ['丙電子', 'DP-7', 60, '顯示面板'],
    ['丙電子', 'BM-12', 50, '電池模組'],
    ['丙電子', 'CS-1', 125, '充電座'],
    ['丙電子', 'EX-4', '', '擴充卡（未設定包裝數量）']
  ];
  ss.getSheetByName(SHEET.MODELS).getRange(2, 1, models.length, 4).setValues(models);

  // 包裝時段數留空的，會依機型的每時段包裝數量自動計算
  var rows = [
    ['SO-0001', 'WO-0001', '甲公司', 'PS-500', 200, t + 2, '自製', STATUS.PACKING, t - 3, t - 1, 1, '', '', '', true, ''],
    ['SO-0002', 'WO-0003', '乙科技', 'CB-20', 80, t + 2, '外包', STATUS.TEST, t - 1, t, 1.5, '', '', '', false, '外包回廠，插隊優先包裝'],
    ['SO-0001', 'WO-0002', '甲公司', 'PS-500', 150, t + 5, '自製', STATUS.WAITING, t - 2, t - 1, 2, '', '', '', false, '被外包品插隊，先擱置'],
    ['SO-0003', 'WO-0004', '乙科技', 'SM-3', 300, t + 6, '自製', STATUS.TEST, t - 1, t + 1, 3, 3.5, '', '', false, '首批包裝較慢，手動調整時段數'],
    ['SO-0004', 'WO-0005', '丙電子', 'DP-7', 60, t + 2, '自製', STATUS.ASSEMBLY, t + 1, t + 2, 4, '', '', '', false, '出貨日很趕'],
    ['SO-0005', 'WO-0006', '丙電子', 'BM-12', 100, t + 9, '外包', STATUS.OUTSOURCE, t + 3, t + 4, 5, '', '', '', false, ''],
    ['SO-0006', 'WO-0007', '丙電子', 'CS-1', 500, t + 10, '自製', STATUS.NOT_STARTED, t + 4, t + 5, 6, '', '', '', false, ''],
    ['SO-0007', 'WO-0008', '丙電子', 'EX-4', 40, t + 14, '自製', STATUS.NOT_STARTED, '', '', '', '', '', '', false, '生管尚未排程'],
    ['SO-0000', 'WO-0000', '甲公司', 'PS-300', 100, t - 1, '自製', STATUS.DONE, t - 5, t - 3, 0, 1, t - 2, '上午', true, '']
  ];
  ss.getSheetByName(SHEET.ORDERS).getRange(2, 1, rows.length, INPUT_COLS).setValues(rows);
}

function installTriggers_(ss) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'onEditInstalled' || f === 'refreshAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onEditInstalled').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('refreshAll').timeBased().everyMinutes(30).create();
}

/**
 * 每次更新都會整個重算的區域：修改前跳出警告（任何人誤改，下次更新也會蓋回）。
 * 人工輸入的工作日曆、選項設定：只有擁有者能改。
 */
function applyProtections_(ss) {
  var orders = ss.getSheetByName(SHEET.ORDERS);
  orders.getRange(1, COL.START, orders.getMaxRows(), AUTO_COLS).protect()
    .setDescription('自動計算欄位（每次更新會重算）').setWarningOnly(true);

  var prep = ss.getSheetByName(SHEET.PREP);
  var prepProtection = prep.protect().setDescription('包裝備料清單（自動產生，只需勾選已備料）').setWarningOnly(true);
  prepProtection.setUnprotectedRanges([prep.getRange('B3:B')]);

  ss.getSheetByName(SHEET.GANTT).protect().setDescription('甘特圖（自動產生）').setWarningOnly(true);

  restrictToOwner_(ss.getSheetByName(SHEET.CALENDAR).protect().setDescription('工作日曆'));
  restrictToOwner_(ss.getSheetByName(SHEET.SETTINGS).protect().setDescription('選項設定'));
}

function restrictToOwner_(protection) {
  protection.addEditor(Session.getEffectiveUser());
  protection.removeEditors(protection.getEditors());
  if (protection.canDomainEdit()) protection.setDomainEdit(false);
}

// 讓 Node.js 測試可以載入（Apps Script 環境沒有 module，這段不會執行）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    STATUS: STATUS, LIGHT: LIGHT, COLOR: COLOR, COL: COL, START_LABELS: START_LABELS,
    AUTO_NOTE_PREFIX: AUTO_NOTE_PREFIX,
    serialFromYmd: serialFromYmd, ymdFromSerial: ymdFromSerial, isoToSerial: isoToSerial,
    weekdayOf: weekdayOf, dayLabel: dayLabel, colLetter: colLetter,
    defaultDay: defaultDay, halfKey: halfKey, lowerBound: lowerBound, parseTimeText: parseTimeText,
    rawNowKey: rawNowKey, buildTimeline: buildTimeline, startText: startText, endText: endText,
    fullSlotText: fullSlotText, computeAll: computeAll,
    autoHours: autoHours, planAutoHours: planAutoHours, nextSeq: nextSeq, safeText: safeText,
    compareQueue: compareQueue, planRenumber: planRenumber,
    validateNewOrder: validateNewOrder, modelsByCustomer: modelsByCustomer
  };
}
