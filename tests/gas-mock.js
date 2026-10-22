// 簡易的 Google Apps Script 模擬環境：
// 儲存格的值會真的存起來；格式類的方法不做事，但會檢查範圍是否超出工作表、二維陣列大小是否吻合。

/** 任何方法都回傳自己，用來模擬 builder 與不需要驗證的物件 */
function chain() {
  const proxy = new Proxy(function () {}, {
    get: (_, key) => (key === 'then' ? undefined : () => proxy),
    apply: () => proxy
  });
  return proxy;
}

function colToNumber(letters) {
  return letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

function withFallback(target) {
  return new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key];
      if (typeof key === 'symbol' || key === 'then') return undefined;
      return () => proxyOf(obj);
    }
  });
}
const proxies = new WeakMap();
function proxyOf(obj) {
  if (!proxies.has(obj)) proxies.set(obj, withFallback(obj));
  return proxies.get(obj);
}

class MockRange {
  constructor(sheet, row, col, numRows, numCols) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1) throw new Error(`範圍無效 ${row},${col},${numRows},${numCols}`);
    if (row + numRows - 1 > sheet.maxRows || col + numCols - 1 > sheet.maxCols) {
      throw new Error(`範圍超出工作表「${sheet.name}」：列 ${row}+${numRows}，欄 ${col}+${numCols}（最大 ${sheet.maxRows}x${sheet.maxCols}）`);
    }
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  checkGrid(arr, what) {
    if (arr.length !== this.numRows || arr.some(r => r.length !== this.numCols)) {
      throw new Error(`${what} 大小不符：需要 ${this.numRows}x${this.numCols}，收到 ${arr.length}x${arr[0] && arr[0].length}`);
    }
    return proxyOf(this);
  }
  getSheet() { return proxyOf(this.sheet); }
  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet.get(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getValue() { return this.sheet.get(this.row, this.col); }
  setValues(values) {
    this.checkGrid(values, 'setValues');
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.set(this.row + r, this.col + c, v)));
    return proxyOf(this);
  }
  setValue(v) { this.sheet.set(this.row, this.col, v); return proxyOf(this); }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this.sheet.set(this.row + r, this.col + c, '');
    return proxyOf(this);
  }
  insertCheckboxes() {
    for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this.sheet.set(this.row + r, this.col + c, false);
    return proxyOf(this);
  }
  setBackgrounds(a) { return this.checkGrid(a, 'setBackgrounds'); }
  setFontColors(a) { return this.checkGrid(a, 'setFontColors'); }
  setFontWeights(a) { return this.checkGrid(a, 'setFontWeights'); }
  setNumberFormats(a) { return this.checkGrid(a, 'setNumberFormats'); }
  merge() { this.sheet.merges.push([this.row, this.col, this.numRows, this.numCols]); return proxyOf(this); }
}

class MockSheet {
  constructor(name) {
    Object.assign(this, { name, maxRows: 1000, maxCols: 26, cells: new Map(), merges: [] });
  }
  get(r, c) { const v = this.cells.get(r + ',' + c); return v === undefined ? '' : v; }
  set(r, c, v) { if (v === '' || v == null) this.cells.delete(r + ',' + c); else this.cells.set(r + ',' + c, v); }
  getName() { return this.name; }
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const m = a.match(/^([A-Z]+)(\d+)?(?::([A-Z]+)(\d+)?)?$/);
      if (!m) throw new Error('無法解析範圍 ' + a);
      const c1 = colToNumber(m[1]), r1 = Number(m[2] || 1);
      const c2 = m[3] ? colToNumber(m[3]) : c1;
      const r2 = m[3] ? Number(m[4] || this.maxRows) : r1;
      return proxyOf(new MockRange(this, r1, c1, r2 - r1 + 1, c2 - c1 + 1));
    }
    return proxyOf(new MockRange(this, a, b, c || 1, d || 1));
  }
  getLastRow() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(',')[0])); return m; }
  getLastColumn() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(',')[1])); return m; }
  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxCols; }
  insertRowsAfter(after, n) { this.maxRows += n; return proxyOf(this); }
  insertColumnsAfter(after, n) { this.maxCols += n; return proxyOf(this); }
  protect() { return chain(); }
}

class MockSpreadsheet {
  constructor() {
    this.sheets = [new MockSheet('工作表1')];
    this.tz = 'America/Los_Angeles';
    this.toasts = [];
  }
  getSheets() { return this.sheets.map(proxyOf); }
  getSheetByName(name) { const s = this.sheets.find(x => x.name === name); return s ? proxyOf(s) : null; }
  insertSheet(name, index) {
    if (this.sheets.some(s => s.name === name)) throw new Error('工作表名稱重複：' + name);
    const sheet = new MockSheet(name);
    this.sheets.splice(index, 0, sheet);
    return proxyOf(sheet);
  }
  deleteSheet(sheet) {
    this.sheets = this.sheets.filter(s => s.name !== sheet.getName());
    if (!this.sheets.length) throw new Error('不能刪除最後一張工作表');
  }
  getSpreadsheetTimeZone() { return this.tz; }
  setSpreadsheetTimeZone(tz) { this.tz = tz; }
  toast(msg) { this.toasts.push(msg); }
}

function formatDate(date, tz, pattern) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map(p => [p.type, p.value]));
  const map = { yyyy: parts.year, MM: parts.month, dd: parts.day, HH: parts.hour, mm: parts.minute,
    M: String(Number(parts.month)), d: String(Number(parts.day)) };
  return pattern.replace(/yyyy|MM|dd|HH|mm|M|d/g, t => map[t]);
}

function createGas() {
  const ss = new MockSpreadsheet();
  const triggers = [];
  const globals = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => proxyOf(ss),
      newDataValidation: chain,
      newConditionalFormatRule: chain,
      newRichTextValue: chain,
      newTextStyle: chain,
      getUi: chain,
      BorderStyle: { SOLID_MEDIUM: 'SOLID_MEDIUM' }
    },
    Utilities: { formatDate },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      deleteTrigger: () => {},
      newTrigger: (name) => { triggers.push(name); return chain(); }
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    Session: { getEffectiveUser: chain }
  };
  return { ss, triggers, globals };
}

module.exports = { createGas };
