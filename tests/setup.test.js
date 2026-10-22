// 用模擬的試算表跑一次完整流程：建置 → 勾選備料 → 修改狀態
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCode } = require('./load');
const { createGas } = require('./gas-mock');

function freshSetup() {
  const gas = createGas();
  const code = loadCode(gas.globals);
  code.setup();
  const sheet = name => gas.ss.sheets.find(s => s.name === name);
  return { gas, code, sheet };
}

/** 在 ① 找出某張工單的列號 */
function orderRow(orders, wo) {
  for (let r = 2; r <= orders.getLastRow(); r++) if (orders.get(r, 2) === wo) return r;
  throw new Error('找不到工單 ' + wo);
}

test('setup 建立五張工作表並刪除空白的預設工作表', () => {
  const { gas } = freshSetup();
  assert.deepEqual(gas.ss.sheets.map(s => s.name), ['工單排程', '工作日曆', '包裝備料清單', '甘特圖', '選項設定']);
  assert.equal(gas.ss.tz, 'Asia/Taipei');
  assert.deepEqual(gas.triggers, ['onEditInstalled', 'refreshAll']);
});

test('setup 後自動欄位、備料清單、甘特圖都有內容', () => {
  const { sheet } = freshSetup();
  const orders = sheet('工單排程');
  const packing = orderRow(orders, 'WO-0001');
  assert.ok(orders.get(packing, 16), '包裝開始應有值');
  assert.ok(orders.get(packing, 12) !== '', '包裝中的工單應自動填入開始日');
  assert.equal(orders.get(orderRow(orders, 'WO-0000'), 19), '✔ 完成');
  assert.equal(orders.get(orderRow(orders, 'WO-0008'), 19), '－ 未排入');

  const prep = sheet('包裝備料清單');
  const wos = [];
  for (let r = 3; prep.get(r, 3) !== ''; r++) wos.push(prep.get(r, 3));
  assert.equal(wos.length, 8);
  assert.deepEqual(wos.slice(0, 3), ['WO-0001', 'WO-0003', 'WO-0002']); // 外包品 1.5 插在第二批前面
  assert.equal(wos[wos.length - 1], 'WO-0008');

  const gantt = sheet('甘特圖');
  assert.equal(gantt.get(4, 1), 'WO-0001');
  assert.equal(gantt.get(4 + 8, 1), '現場包材數');

  const cal = sheet('工作日曆');
  assert.ok(cal.getLastRow() > 120);
});

test('在備料清單勾選已備料，會寫回工單排程', () => {
  const { code, sheet } = freshSetup();
  const ss = code.SpreadsheetApp.getActiveSpreadsheet();
  const prep = sheet('包裝備料清單');
  let row = 3;
  while (prep.get(row, 3) !== 'WO-0002') row++;
  prep.set(row, 2, true);
  code.onEditInstalled({ source: ss, range: ss.getSheetByName('包裝備料清單').getRange(row, 2) });

  const orders = sheet('工單排程');
  const r = orderRow(orders, 'WO-0002');
  assert.equal(orders.get(r, 14), true);
  assert.equal(orders.get(r, 19), '🟢 已備料');
});

test('包裝中的工單改成完成，下一張接著排並自動更新', () => {
  const { code, sheet } = freshSetup();
  const ss = code.SpreadsheetApp.getActiveSpreadsheet();
  const orders = sheet('工單排程');
  const r = orderRow(orders, 'WO-0001');
  orders.set(r, 7, '完成');
  code.onEditInstalled({ source: ss, range: ss.getSheetByName('工單排程').getRange(r, 7) });

  const prep = sheet('包裝備料清單');
  assert.equal(prep.get(3, 3), 'WO-0003');
  assert.equal(orders.get(r, 19), '✔ 完成');
});

test('日期以 Date 物件讀入時也能正確換算', () => {
  const { code, sheet } = freshSetup();
  const orders = sheet('工單排程');
  const r = orderRow(orders, 'WO-0004');
  // 試算表回傳的日期是台北時間午夜
  orders.set(r, 5, new Date('2020-01-02T00:00:00+08:00'));
  code.refreshAll();
  const prep = sheet('包裝備料清單');
  let row = 3;
  while (prep.get(row, 3) !== 'WO-0004') row++;
  assert.equal(prep.get(row, 10), code.module.exports.serialFromYmd(2020, 1, 2));
});

test('同一份試算表重複執行 setup 會被擋下', () => {
  const { code } = freshSetup();
  assert.throws(() => code.setup(), /已經建置過/);
});
