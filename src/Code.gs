/**
 * 包裝備料排程工具（Packaging Schedule Board）
 *
 * 使用方式：在 Google 試算表開啟「擴充功能 → Apps Script」，把這個檔案的內容
 * 全部貼進 Code.gs，選擇函式 setup 並按「執行」一次，就會建立五張工作表。
 *
 * 檔案分成三段：
 *   1. 常數設定
 *   2. 排程核心邏輯（純函式，不碰試算表，可以在 Node.js 測試）
 *   3. 試算表讀寫、建置、觸發器
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
  SETTINGS: '選項設定'
};

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
  ORDER_NO: 1, WO: 2, NAME: 3, QTY: 4, SHIP: 5, METHOD: 6, STATUS: 7,
  ASM_DONE: 8, TEST_DONE: 9, SEQ: 10, HOURS: 11, FIXED_DATE: 12, FIXED_SLOT: 13,
  PREPPED: 14, NOTE: 15, START: 16, END: 17, DEADLINE: 18, LIGHT: 19
};
var ORDER_HEADERS = ['訂單編號', '工單編號', '品名', '數量', '出貨日', '組裝方式', '目前狀態',
  '組裝預計完成日', '測試預計完成日', '包裝順序', '包裝時段數', '指定開始日', '指定開始時段',
  '已備料', '備註', '包裝開始', '包裝結束', '最晚備料', '燈號'];
var INPUT_COLS = 15;
var AUTO_COLS = 4;
var ORDER_ROWS = 1000;

// ② 工作日曆
var CAL_HEADERS = ['日期', '星期', '上午', '下午', '晚上加班', '備料人員上班', '備註'];

// ③ 包裝備料清單（第 1 列摘要、第 2 列標題、第 3 列起資料）
var PREP_HEADERS = ['燈號', '已備料', '工單編號', '包裝開始', '最晚備料', '品名', '數量', '狀態',
  '訂單編號', '出貨日', '來源列'];
var PREP_FIRST_ROW = 3;

// ④ 甘特圖（第 1 列標題、第 2～3 列日期與時段、第 4 列起工單）
var GANTT_FIRST_ROW = 4;
var GANTT_LABEL_COLS = 3;
var GANTT_MAX_ROWS = 300;

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

/** 0 = 星期日 … 6 = 星期六（序號 0 是星期六） */
function weekdayOf(serial) {
  return ((serial % 7) + 6) % 7;
}

function dayLabel(serial) {
  var p = ymdFromSerial(serial);
  return p.m + '/' + p.d + '(' + WEEKDAY_NAMES[weekdayOf(serial)] + ')';
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

/**
 * 主要計算。input：
 *   today, nowMinutes, times{amS,amE,pmS,pmE,otS,otE}, yellowAhead, ganttDays,
 *   calendar[{serial,am,pm,ot,prep}],
 *   orders[{row,orderNo,wo,name,qty,ship,method,status,asmDone,testDone,seq,hours,
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

  // 排隊：依包裝順序，前一張結束後才能開始
  var queue = results.filter(function (r) {
    var o = r.src;
    if (o.status === STATUS.DONE || o.seq == null) return false;
    if (!(o.hours > 0)) { r.error = LIGHT.MISSING_HOURS; return false; }
    return true;
  }).sort(function (a, b) { return a.src.seq - b.src.seq || a.src.row - b.src.row; });

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
  if (o.seq == null) return LIGHT.UNQUEUED;
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
// 3. 試算表讀寫、建置、觸發器
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

/** 由 setup 安裝的「編輯時」觸發器，以試算表擁有者身分執行，所以能寫入鎖定的欄位 */
function onEditInstalled(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = e.source || SpreadsheetApp.getActiveSpreadsheet();
    var name = e.range.getSheet().getName();
    if (name === SHEET.GANTT) return;
    if (name === SHEET.PREP) syncPrepChecks_(ss, e.range);
    refreshAll_(ss);
  } finally {
    lock.releaseLock();
  }
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📦 排程工具')
    .addItem('立即更新', 'menuRefresh')
    .addToUi();
}

function menuRefresh() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  try {
    refreshAll();
    ss.toast('排程已更新', '📦 排程工具', 3);
  } catch (err) {
    ss.toast('只有試算表擁有者能手動更新；系統每 30 分鐘及每次修改後會自動更新。', '📦 排程工具', 8);
  }
}

function refreshAll_(ss) {
  var tz = ss.getSpreadsheetTimeZone();
  var now = nowParts_(tz);
  var settings = readSettings_(ss, tz);

  var calSheet = ss.getSheetByName(SHEET.CALENDAR);
  ensureCalendar_(calSheet, now.today, settings.keepDays, tz);

  var ordersSheet = ss.getSheetByName(SHEET.ORDERS);
  var orders = readOrders_(ordersSheet, tz);

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
  var get = function (label) {
    var def = SETTING_ROWS.filter(function (r) { return r[0] === label; })[0][1];
    return map[label] === undefined || map[label] === '' ? def : map[label];
  };
  var time = function (label) {
    var v = get(label);
    var t = isDate_(v) ? parseTimeText(Utilities.formatDate(v, tz, 'HH:mm')) : parseTimeText(v);
    if (isNaN(t)) t = parseTimeText(SETTING_ROWS.filter(function (r) { return r[0] === label; })[0][1]);
    return t;
  };
  var num = function (label, min, max) {
    var n = toNumber_(get(label));
    if (n == null) n = toNumber_(SETTING_ROWS.filter(function (r) { return r[0] === label; })[0][1]);
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
  var orders = [];
  values.forEach(function (v, i) {
    var wo = String(v[COL.WO - 1]).trim();
    if (!wo) return;
    orders.push({
      row: i + 2,
      orderNo: v[COL.ORDER_NO - 1],
      wo: wo,
      name: v[COL.NAME - 1],
      qty: v[COL.QTY - 1],
      ship: toSerial_(v[COL.SHIP - 1], tz),
      method: String(v[COL.METHOD - 1]).trim(),
      status: String(v[COL.STATUS - 1]).trim() || STATUS.NOT_STARTED,
      asmDone: toSerial_(v[COL.ASM_DONE - 1], tz),
      testDone: toSerial_(v[COL.TEST_DONE - 1], tz),
      seq: toNumber_(v[COL.SEQ - 1]),
      hours: toNumber_(v[COL.HOURS - 1]),
      fixedSerial: toSerial_(v[COL.FIXED_DATE - 1], tz),
      fixedLabel: String(v[COL.FIXED_SLOT - 1]).trim(),
      prepped: v[COL.PREPPED - 1] === true
    });
  });
  return orders;
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
    values.push([r.light, o.prepped, o.wo, r.startText || '—', r.deadlineText || '—', o.name, o.qty,
      o.status, o.orderNo, o.ship == null ? '' : o.ship, o.row]);
    var bg = lightBackground(r.light);
    var rowBg = [];
    for (var i = 0; i < width; i++) rowBg.push(bg);
    if (r.shipRisk) rowBg[9] = COLOR.RED_BG;
    bgs.push(rowBg);
  });

  // 工單編號、品名等設為純文字，避免「0012」被轉成數字
  [3, 4, 5, 6, 8, 9].forEach(function (c) {
    sheet.getRange(PREP_FIRST_ROW, c, n, 1).setNumberFormat('@');
  });
  sheet.getRange(PREP_FIRST_ROW, 10, n, 1).setNumberFormat('m/d');
  sheet.getRange(PREP_FIRST_ROW, 2, n, 1).insertCheckboxes();
  var range = sheet.getRange(PREP_FIRST_ROW, 1, n, width);
  range.setValues(values);
  range.setBackgrounds(bgs);
  range.setFontSize(12).setVerticalAlignment('middle');
  sheet.getRange(PREP_FIRST_ROW, 1, n, 2).setHorizontalAlignment('center');
  list.forEach(function (r, i) {
    if (r.shipRisk) {
      sheet.getRange(PREP_FIRST_ROW + i, 10).setFontWeight('bold').setFontColor(COLOR.PREP_MARK)
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
  ['工單編號', '品名', '狀態'].forEach(function (h, i) {
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
      values.push([r.src.wo, r.src.name, r.src.status]);
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
  var firstCol = range.getColumn(), lastCol = firstCol + range.getNumColumns() - 1;
  if (firstCol > 2 || lastCol < 2) return;
  var firstRow = Math.max(range.getRow(), PREP_FIRST_ROW);
  var lastRow = range.getRow() + range.getNumRows() - 1;
  if (lastRow < firstRow) return;

  var prep = range.getSheet();
  var orders = ss.getSheetByName(SHEET.ORDERS);
  var rows = prep.getRange(firstRow, 1, lastRow - firstRow + 1, PREP_HEADERS.length).getValues();
  rows.forEach(function (row) {
    var wo = String(row[2]).trim();
    var srcRow = Number(row[10]);
    if (!wo || !srcRow) return;
    if (String(orders.getRange(srcRow, COL.WO).getValue()).trim() !== wo) {
      srcRow = findOrderRow_(orders, wo);
      if (!srcRow) return;
    }
    orders.getRange(srcRow, COL.PREPPED).setValue(row[1] === true);
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

// ---------- 一鍵建置 ----------

function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(SHEET.ORDERS)) {
    throw new Error('這份試算表已經建置過了。要重新建置，請建立一份新的空白試算表再執行 setup。');
  }
  ss.setSpreadsheetTimeZone('Asia/Taipei');

  var names = [SHEET.ORDERS, SHEET.CALENDAR, SHEET.PREP, SHEET.GANTT, SHEET.SETTINGS];
  var oldSheets = ss.getSheets();
  names.forEach(function (name, i) { ss.insertSheet(name, i); });
  oldSheets.forEach(function (sh) {
    if (sh.getLastRow() === 0 && sh.getLastColumn() === 0) ss.deleteSheet(sh);
  });

  var tz = ss.getSpreadsheetTimeZone();
  var now = nowParts_(tz);

  buildSettingsSheet_(ss.getSheetByName(SHEET.SETTINGS));
  buildCalendarSheet_(ss.getSheetByName(SHEET.CALENDAR), now.today, tz);
  buildOrdersSheet_(ss.getSheetByName(SHEET.ORDERS), ss.getSheetByName(SHEET.SETTINGS));
  buildPrepSheet_(ss.getSheetByName(SHEET.PREP));
  buildGanttSheet_(ss.getSheetByName(SHEET.GANTT));
  writeSampleData_(ss.getSheetByName(SHEET.ORDERS), now.today);

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

function buildOrdersSheet_(sheet, settings) {
  sheet.setTabColor('#3D85C6');
  sheet.getRange(1, 1, 1, ORDER_HEADERS.length).setValues([ORDER_HEADERS]);
  styleHeader_(sheet.getRange(1, 1, 1, INPUT_COLS), COLOR.HEADER_INPUT);
  styleHeader_(sheet.getRange(1, COL.START, 1, AUTO_COLS), COLOR.HEADER_AUTO);
  sheet.setRowHeight(1, 42);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);

  var notes = {};
  notes[COL.WO] = '必填。一張工單一列；同一張訂單分批包裝，就分成多張工單。';
  notes[COL.STATUS] = '改成「包裝中」時，如果「指定開始」是空的，系統會自動填入現在的時段。\n改成「完成」後就會離開包裝隊伍。';
  notes[COL.SEQ] = '數字越小越先包裝。\n外包品要插隊時填小數，例如 1.5 會排在 1 和 2 之間，後面的工單自動順延。\n空白 = 還沒排入包裝。';
  notes[COL.HOURS] = '上午、下午、加班各算 1 個時段；半個時段填 0.5。';
  notes[COL.FIXED_DATE] = '選填。\n・正在包裝的工單：實際開始的日期（狀態改「包裝中」會自動填）。\n・外包品：最早能包裝的日期，系統不會排在這之前。';
  notes[COL.PREPPED] = '包材備好就勾選。也可以在「包裝備料清單」直接勾。';
  notes[COL.START] = '以下四欄由系統自動計算，請勿修改。';
  Object.keys(notes).forEach(function (c) { sheet.getRange(1, Number(c)).setNote(notes[c]); });

  var n = ORDER_ROWS - 1;
  var dv = function () { return SpreadsheetApp.newDataValidation(); };
  sheet.getRange(2, COL.ORDER_NO, n, 2).setNumberFormat('@');
  [COL.SHIP, COL.ASM_DONE, COL.TEST_DONE, COL.FIXED_DATE].forEach(function (c) {
    sheet.getRange(2, c, n, 1).setNumberFormat('m/d')
      .setDataValidation(dv().requireDate().setAllowInvalid(false).setHelpText('請輸入日期，例如 10/24').build());
  });
  sheet.getRange(2, COL.METHOD, n, 1).setDataValidation(
    dv().requireValueInRange(settings.getRange('F2:F20'), true).setAllowInvalid(false).build());
  sheet.getRange(2, COL.STATUS, n, 1).setDataValidation(
    dv().requireValueInRange(settings.getRange('E2:E30'), true).setAllowInvalid(false).build());
  sheet.getRange(2, COL.SEQ, n, 1).setDataValidation(
    dv().requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false).setHelpText('請輸入數字，可用小數插隊，例如 1.5').build());
  sheet.getRange(2, COL.HOURS, n, 1).setDataValidation(
    dv().requireFormulaSatisfied('=AND(ISNUMBER(K2),K2>0,MOD(K2*2,1)=0)').setAllowInvalid(false)
      .setHelpText('以 0.5 為單位，例如 0.5、1、1.5、2').build());
  sheet.getRange(2, COL.FIXED_SLOT, n, 1).setDataValidation(
    dv().requireValueInList(START_LABELS, true).setAllowInvalid(false).build());
  sheet.getRange(2, COL.PREPPED, n, 1).insertCheckboxes();
  sheet.getRange(2, COL.START, n, AUTO_COLS).setNumberFormat('@').setBackground(COLOR.AUTO_BG);
  sheet.getRange(2, COL.PREPPED, n, 1).setHorizontalAlignment('center');

  var widths = [90, 95, 150, 60, 70, 75, 80, 90, 90, 70, 70, 80, 90, 60, 180, 130, 130, 130, 100];
  widths.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });

  var lightRange = sheet.getRange(2, COL.LIGHT, n, 1);
  var cf = function () { return SpreadsheetApp.newConditionalFormatRule(); };
  sheet.setConditionalFormatRules([
    cf().whenFormulaSatisfied('=$G2="' + STATUS.DONE + '"').setFontColor(COLOR.DONE_FONT)
      .setRanges([sheet.getRange(2, 1, n, ORDER_HEADERS.length)]).build(),
    cf().whenTextStartsWith('🔴').setBackground(COLOR.RED_BG).setRanges([lightRange]).build(),
    cf().whenTextStartsWith('🟡').setBackground(COLOR.YELLOW_BG).setRanges([lightRange]).build(),
    cf().whenTextStartsWith('🟢').setBackground(COLOR.GREEN_BG).setRanges([lightRange]).build(),
    cf().whenTextStartsWith('⚠').setBackground(COLOR.WARN_BG).setRanges([lightRange]).build()
  ]);
}

function buildPrepSheet_(sheet) {
  sheet.setTabColor('#E06666');
  sheet.getRange(1, 1, 1, 10).merge().setFontWeight('bold').setFontSize(12);
  sheet.getRange(2, 1, 1, PREP_HEADERS.length).setValues([PREP_HEADERS]);
  styleHeader_(sheet.getRange(2, 1, 1, PREP_HEADERS.length), COLOR.HEADER_INPUT);
  sheet.getRange(2, 1, 1, PREP_HEADERS.length).setFontSize(12);
  sheet.getRange(2, 5).setNote('包材最晚要在這個時段結束前備好。');
  sheet.setFrozenRows(2);
  var widths = [105, 65, 100, 135, 120, 150, 60, 70, 90, 70, 60];
  widths.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
  sheet.hideColumns(PREP_HEADERS.length);
}

function buildGanttSheet_(sheet) {
  sheet.setTabColor('#F1C232');
  sheet.setFrozenRows(3);
  sheet.setFrozenColumns(GANTT_LABEL_COLS);
}

function writeSampleData_(sheet, t) {
  // 範例資料的日期都相對於今天，讓試用時畫面上有內容
  var rows = [
    ['SO-0001', 'WO-0001', '電源供應器 PS-500', 200, t + 2, '自製', STATUS.PACKING, t - 3, t - 1, 1, 2, '', '', true, ''],
    ['SO-0002', 'WO-0003', '控制主機板 CB-20', 80, t + 2, '外包', STATUS.TEST, t - 1, t, 1.5, 1.5, '', '', false, '外包回廠，插隊優先包裝'],
    ['SO-0001', 'WO-0002', '電源供應器 PS-500（第二批）', 150, t + 5, '自製', STATUS.WAITING, t - 2, t - 1, 2, 2, '', '', false, '被外包品插隊，先擱置'],
    ['SO-0003', 'WO-0004', '感測模組 SM-3', 300, t + 6, '自製', STATUS.TEST, t - 1, t + 1, 3, 3, '', '', false, ''],
    ['SO-0004', 'WO-0005', '顯示面板 DP-7', 60, t + 2, '自製', STATUS.ASSEMBLY, t + 1, t + 2, 4, 1, '', '', false, '出貨日很趕'],
    ['SO-0005', 'WO-0006', '電池模組 BM-12', 100, t + 9, '外包', STATUS.OUTSOURCE, t + 3, t + 4, 5, 2, '', '', false, ''],
    ['SO-0006', 'WO-0007', '充電座 CS-1', 500, t + 10, '自製', STATUS.NOT_STARTED, t + 4, t + 5, 6, 4, '', '', false, ''],
    ['SO-0007', 'WO-0008', '擴充卡 EX-4', 40, t + 14, '自製', STATUS.NOT_STARTED, '', '', '', '', '', '', false, '生管尚未排程'],
    ['SO-0000', 'WO-0000', '電源供應器 PS-300', 100, t - 1, '自製', STATUS.DONE, t - 5, t - 3, 0, 2, t - 2, '上午', true, '']
  ];
  sheet.getRange(2, 1, rows.length, INPUT_COLS).setValues(rows);
}

function installTriggers_(ss) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'onEditInstalled' || f === 'refreshAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onEditInstalled').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('refreshAll').timeBased().everyMinutes(30).create();
}

/** 自動計算的區域只有擁有者能改；觸發器以擁有者身分執行，所以不受影響 */
function applyProtections_(ss) {
  var orders = ss.getSheetByName(SHEET.ORDERS);
  restrictToOwner_(orders.getRange(1, COL.START, ORDER_ROWS, AUTO_COLS).protect()
    .setDescription('自動計算欄位'));

  var prep = ss.getSheetByName(SHEET.PREP);
  var prepProtection = prep.protect().setDescription('包裝備料清單（只開放勾選已備料）');
  prepProtection.setUnprotectedRanges([prep.getRange('B3:B')]);
  restrictToOwner_(prepProtection);

  restrictToOwner_(ss.getSheetByName(SHEET.GANTT).protect().setDescription('甘特圖（自動產生）'));
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
    STATUS: STATUS, LIGHT: LIGHT, COLOR: COLOR, START_LABELS: START_LABELS,
    serialFromYmd: serialFromYmd, ymdFromSerial: ymdFromSerial, weekdayOf: weekdayOf, dayLabel: dayLabel,
    defaultDay: defaultDay, halfKey: halfKey, lowerBound: lowerBound, parseTimeText: parseTimeText,
    rawNowKey: rawNowKey, buildTimeline: buildTimeline, startText: startText, endText: endText,
    fullSlotText: fullSlotText, computeAll: computeAll
  };
}
