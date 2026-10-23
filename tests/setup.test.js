// 用模擬的試算表跑完整流程：建置 → 勾選備料 → 修改狀態 → 新增工單
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCode } = require('./load');
const { createGas } = require('./gas-mock');

function freshSetup() {
  const gas = createGas();
  const code = loadCode(gas.globals);
  code.setup();
  const ss = code.SpreadsheetApp.getActiveSpreadsheet();
  const sheet = name => gas.ss.sheets.find(s => s.name === name);
  const COL = code.module.exports.COL;
  return { gas, code, ss, sheet, COL };
}

/** 在 ① 找出某張工單的列號 */
function orderRow(orders, wo) {
  for (let r = 2; r <= orders.getLastRow(); r++) if (orders.get(r, 2) === wo) return r;
  throw new Error('找不到工單 ' + wo);
}

/** 在 ③ 找出某張工單的列號 */
function prepRow(prep, wo) {
  for (let r = 3; prep.get(r, 3) !== ''; r++) if (prep.get(r, 3) === wo) return r;
  throw new Error('備料清單找不到工單 ' + wo);
}

function edit(code, ss, sheetName, row, col) {
  code.onEditInstalled({ source: ss, range: ss.getSheetByName(sheetName).getRange(row, col) });
}

const NEW_ORDER = {
  customer: '甲公司', model: 'PS-500', wo: 'WO-1001', orderNo: 'SO-1001', qty: '250',
  ship: '2030-01-15', method: '自製', status: '未開工', asmDone: '', testDone: '',
  seqMode: 'last', seq: '', hours: '', hoursAuto: true, note: ''
};

test('setup 建立七張工作表、刪除空白預設工作表、放置按鍵', () => {
  const { gas, sheet } = freshSetup();
  assert.deepEqual(gas.ss.sheets.map(s => s.name),
    ['工單排程', '工作日曆', '包裝備料清單', '甘特圖', '客戶清單', '機型清單', '選項設定']);
  assert.equal(gas.ss.tz, 'Asia/Taipei');
  assert.deepEqual(gas.triggers, ['onEditInstalled', 'refreshAll']);
  assert.equal(sheet('工單排程').images.length, 1);
  assert.equal(sheet('包裝備料清單').images.length, 1);
});

test('setup 後自動欄位、備料清單、甘特圖都有內容', () => {
  const { sheet, COL } = freshSetup();
  const orders = sheet('工單排程');
  const packing = orderRow(orders, 'WO-0001');
  assert.ok(orders.get(packing, COL.START), '包裝開始應有值');
  assert.ok(orders.get(packing, COL.FIXED_DATE) !== '', '包裝中的工單應自動填入開始日');
  assert.equal(orders.get(orderRow(orders, 'WO-0000'), COL.LIGHT), '✔ 完成');
  assert.equal(orders.get(orderRow(orders, 'WO-0008'), COL.LIGHT), '－ 未排入');

  const prep = sheet('包裝備料清單');
  const wos = [];
  for (let r = 3; prep.get(r, 3) !== ''; r++) wos.push(prep.get(r, 3));
  assert.equal(wos.length, 8);
  assert.deepEqual(wos.slice(0, 3), ['WO-0001', 'WO-0003', 'WO-0002']); // 外包品 1.5 插在第二批前面
  assert.equal(wos[wos.length - 1], 'WO-0008');
  assert.equal(prep.get(3, 6), '甲公司');
  assert.equal(prep.get(3, 7), 'PS-500');

  const gantt = sheet('甘特圖');
  assert.equal(gantt.get(4, 1), 'WO-0001');
  assert.equal(gantt.get(4, 2), 'PS-500');
  assert.equal(gantt.get(4 + 8, 1), '現場包材數');

  assert.ok(sheet('工作日曆').getLastRow() > 120);
});

test('包裝時段數空白時，依機型的每時段包裝數量自動計算', () => {
  const { sheet, COL } = freshSetup();
  const orders = sheet('工單排程');
  const hours = wo => orders.get(orderRow(orders, wo), COL.HOURS);
  const note = wo => orders.notes.get(orderRow(orders, wo) + ',' + COL.HOURS) || '';
  assert.equal(hours('WO-0001'), 2);    // 200 ÷ 100
  assert.equal(hours('WO-0003'), 1.5);  // 80 ÷ 60 = 1.33 → 1.5
  assert.equal(hours('WO-0007'), 4);    // 500 ÷ 125
  assert.match(note('WO-0001'), /^自動計算/);
  assert.equal(hours('WO-0004'), 3.5);  // 手動填寫的不動
  assert.equal(note('WO-0004'), '');
  assert.equal(hours('WO-0008'), '');   // 機型沒設定包裝數量
});

test('改數量會重算；手動改時段數後不再自動；清空則恢復自動', () => {
  const { code, ss, sheet, COL } = freshSetup();
  const orders = sheet('工單排程');
  const r = orderRow(orders, 'WO-0002');

  orders.set(r, COL.QTY, 420);
  edit(code, ss, '工單排程', r, COL.QTY);
  assert.equal(orders.get(r, COL.HOURS), 4.5); // 420 ÷ 100 = 4.2 → 4.5

  orders.set(r, COL.HOURS, 3);
  edit(code, ss, '工單排程', r, COL.HOURS);
  assert.equal(orders.get(r, COL.HOURS), 3);
  assert.equal(orders.notes.get(r + ',' + COL.HOURS), undefined);

  orders.set(r, COL.QTY, 100);
  edit(code, ss, '工單排程', r, COL.QTY);
  assert.equal(orders.get(r, COL.HOURS), 3, '手動值不應被覆蓋');

  orders.set(r, COL.HOURS, '');
  edit(code, ss, '工單排程', r, COL.HOURS);
  assert.equal(orders.get(r, COL.HOURS), 1);
});

test('在備料清單勾選已備料，會寫回工單排程', () => {
  const { code, ss, sheet, COL } = freshSetup();
  const prep = sheet('包裝備料清單');
  const row = prepRow(prep, 'WO-0002');
  prep.set(row, 2, true);
  edit(code, ss, '包裝備料清單', row, 2);

  const orders = sheet('工單排程');
  const r = orderRow(orders, 'WO-0002');
  assert.equal(orders.get(r, COL.PREPPED), true);
  assert.equal(orders.get(r, COL.LIGHT), '🟢 已備料');
});

test('包裝中的工單改成完成，下一張接著排並自動更新', () => {
  const { code, ss, sheet, COL } = freshSetup();
  const orders = sheet('工單排程');
  const r = orderRow(orders, 'WO-0001');
  orders.set(r, COL.STATUS, '完成');
  edit(code, ss, '工單排程', r, COL.STATUS);

  assert.equal(sheet('包裝備料清單').get(3, 3), 'WO-0003');
  assert.equal(orders.get(r, COL.LIGHT), '✔ 完成');
});

test('新增工單：寫在最後一列、排到隊伍最後、自動算時段數', () => {
  const { code, sheet, COL } = freshSetup();
  const res = code.addWorkOrder(NEW_ORDER);
  assert.equal(res.ok, true, JSON.stringify(res.errors));

  const orders = sheet('工單排程');
  const r = orderRow(orders, 'WO-1001');
  assert.equal(r, 11); // 範例資料佔第 2～10 列
  assert.equal(orders.get(r, COL.CUSTOMER), '甲公司');
  assert.equal(orders.get(r, COL.SEQ), 7);      // 未完成工單最大順序 6 + 1
  assert.equal(orders.get(r, COL.HOURS), 2.5);  // 250 ÷ 100
  assert.match(orders.notes.get(r + ',' + COL.HOURS), /^自動計算/);
  assert.ok(orders.get(r, COL.LIGHT), '新增後應立即重算燈號');

  const prep = sheet('包裝備料清單');
  assert.ok(prepRow(prep, 'WO-1001') > 3);
});

test('新增工單：資料有誤時不寫入並回傳原因', () => {
  const { code, sheet } = freshSetup();
  const orders = sheet('工單排程');
  const before = orders.getLastRow();

  const dup = code.addWorkOrder({ ...NEW_ORDER, wo: 'wo-0001' });
  assert.equal(dup.ok, false);
  assert.match(dup.errors.join(), /已經存在/);

  const wrongModel = code.addWorkOrder({ ...NEW_ORDER, model: 'CB-20' });
  assert.match(wrongModel.errors.join(), /不屬於客戶/);

  const noHours = code.addWorkOrder({ ...NEW_ORDER, model: 'PS-500', customer: '甲公司', hoursAuto: false, hours: '' });
  assert.match(noHours.errors.join(), /包裝時段數/);

  assert.equal(orders.getLastRow(), before);
});

test('新增工單：開頭是 = 的文字不會變成公式', () => {
  const { code, sheet, COL } = freshSetup();
  const res = code.addWorkOrder({ ...NEW_ORDER, wo: 'WO-2001', note: '=IMPORTXML("http://x")' });
  assert.equal(res.ok, true);
  const orders = sheet('工單排程');
  assert.equal(orders.get(orderRow(orders, 'WO-2001'), COL.NOTE), '\'=IMPORTXML("http://x")');
});

test('新增工單視窗：資料以 JSON 嵌入並跳脫 <、>', () => {
  const { code, ss } = freshSetup();
  const html = code.newOrderHtml_({ customers: ['</script><script>alert(1)</script>'], models: [],
    statuses: [], methods: [], existingWos: [], defaultStatus: '未開工' });
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.ok(html.includes('\\u003c/script\\u003e'));
  assert.ok(!html.includes('__DATA__'));

  const data = code.newOrderDialogData_(ss);
  assert.deepEqual([...data.customers], ['甲公司', '乙科技', '丙電子']);
  assert.ok(data.existingWos.includes('WO-0001'));
});

test('改客戶清單或機型清單會重新套用機型選單並重算', () => {
  const { code, ss, sheet, COL } = freshSetup();
  const models = sheet('機型清單');
  models.set(2, 3, 50); // PS-500 每時段改成 50 台
  edit(code, ss, '機型清單', 2, 3);
  const orders = sheet('工單排程');
  assert.equal(orders.get(orderRow(orders, 'WO-0001'), COL.HOURS), 4); // 200 ÷ 50
});

test('日期以 Date 物件讀入時也能正確換算', () => {
  const { code, sheet, COL } = freshSetup();
  const orders = sheet('工單排程');
  const r = orderRow(orders, 'WO-0004');
  // 試算表回傳的日期是台北時間午夜
  orders.set(r, COL.SHIP, new Date('2020-01-02T00:00:00+08:00'));
  code.refreshAll();
  const prep = sheet('包裝備料清單');
  assert.equal(prep.get(prepRow(prep, 'WO-0004'), 11), code.module.exports.serialFromYmd(2020, 1, 2));
});

test('同一份試算表重複執行 setup 會被擋下', () => {
  const { code } = freshSetup();
  assert.throws(() => code.setup(), /已經建置過/);
});

test('重新編號：包裝順序變成 1～N，備料清單的先後不變', () => {
  const { code, ss, sheet, COL } = freshSetup();
  const prep = sheet('包裝備料清單');
  const listOrder = () => { const w = []; for (let r = 3; prep.get(r, 3) !== ''; r++) w.push(prep.get(r, 3)); return w; };
  const before = listOrder();

  assert.equal(code.renumber_(ss), 7);
  const orders = sheet('工單排程');
  const seq = wo => orders.get(orderRow(orders, wo), COL.SEQ);
  assert.deepEqual(['WO-0001', 'WO-0003', 'WO-0002', 'WO-0004', 'WO-0005', 'WO-0006', 'WO-0007'].map(seq),
    [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(seq('WO-0008'), '');  // 未排入的不動
  assert.equal(seq('WO-0000'), 0);   // 完成的不動
  assert.deepEqual(listOrder(), before);

  // 新工單排到最後 = 8
  assert.equal(code.addWorkOrder(NEW_ORDER).ok, true);
  assert.equal(orders.get(orderRow(orders, 'WO-1001'), COL.SEQ), 8);
});
