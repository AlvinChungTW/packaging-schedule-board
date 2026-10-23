const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCode } = require('./load');

const gs = loadCode().module.exports;
const { computeAll, serialFromYmd, weekdayOf, rawNowKey, halfKey, dayLabel, LIGHT, STATUS,
  autoHours, planAutoHours, nextSeq, safeText, isoToSerial, colLetter, validateNewOrder, planRenumber } = gs;

const T = serialFromYmd(2026, 10, 22); // 星期四
const TIMES = { amS: 480, amE: 720, pmS: 780, pmE: 1020, otS: 1050, otE: 1230 };
const at = (h, m = 0) => h * 60 + m;

function order(o) {
  return Object.assign({
    row: 2, orderNo: 'SO', wo: 'WO-' + Math.random(), name: '品名', qty: 1, ship: null, method: '自製',
    status: STATUS.WAITING, asmDone: null, testDone: null, seq: 1, hours: 1,
    fixedSerial: null, fixedLabel: '', prepped: false
  }, o);
}

function run(orders, minutes = at(9), calendar = []) {
  return computeAll({ today: T, nowMinutes: minutes, times: TIMES, yellowAhead: 1, ganttDays: 14, calendar, orders });
}

/** 單一工單指定在某天某時段開始，回傳計算結果 */
function single(dayOffset, label, minutes, extra = {}, calendar = []) {
  return run([order(Object.assign({ fixedSerial: T + dayOffset, fixedLabel: label }, extra))], minutes, calendar).results[0];
}

test('日期序號與星期', () => {
  assert.equal(weekdayOf(T), 4);
  assert.equal(dayLabel(T), '10/22(四)');
  assert.equal(dayLabel(T + 3), '10/25(日)');
});

test('現在時間對應的時段', () => {
  assert.equal(rawNowKey(T, at(7), TIMES), halfKey(T, 0, 0));
  assert.equal(rawNowKey(T, at(9), TIMES), halfKey(T, 0, 0));
  assert.equal(rawNowKey(T, at(10, 30), TIMES), halfKey(T, 0, 1));
  assert.equal(rawNowKey(T, at(12, 30), TIMES), halfKey(T, 1, 0)); // 午休算下午前半
  assert.equal(rawNowKey(T, at(18), TIMES), halfKey(T, 2, 0));
  assert.equal(rawNowKey(T, at(21), TIMES), halfKey(T + 1, 0, 0)); // 加班後算隔天上午
});

test('備料期限：半天前、假日前一天備齊', () => {
  assert.equal(single(0, '下午', at(9)).deadlineText, '10/22(四) 上午');
  assert.equal(single(0, '加班', at(9)).deadlineText, '10/22(四) 下午');
  assert.equal(single(1, '上午', at(9)).deadlineText, '10/22(四) 下午');
  assert.equal(single(2, '上午', at(9)).deadlineText, '10/23(五) 下午'); // 週六
  assert.equal(single(2, '下午', at(9)).deadlineText, '10/23(五) 下午');
  assert.equal(single(4, '上午', at(9)).deadlineText, '10/23(五) 下午'); // 週一
});

test('指定在週日開始會自動順延到週一', () => {
  assert.equal(single(3, '上午', at(9)).startText, '10/26(一) 上午');
});

test('排隊：依順序接續，小數順序可以插隊', () => {
  const res = run([
    order({ row: 2, wo: 'A', seq: 1, hours: 2 }),
    order({ row: 3, wo: 'B', seq: 2, hours: 1.5 }),
    order({ row: 4, wo: 'C', seq: 1.5, hours: 1 })
  ]);
  const by = Object.fromEntries(res.results.map(r => [r.src.wo, r]));
  assert.equal(by.A.startText, '10/22(四) 上午');
  assert.equal(by.A.endText, '10/22(四) 下午');
  assert.equal(by.C.startText, '10/22(四) 加班');
  assert.equal(by.C.endText, '10/22(四) 加班');
  assert.equal(by.B.startText, '10/23(五) 上午');
  assert.equal(by.B.endText, '10/23(五) 下午前半');
  assert.deepEqual([...res.prepList.map(r => r.src.wo)], ['A', 'C', 'B']);
});

test('排隊會跳過週日（週六只有上午、下午）', () => {
  const r = single(2, '上午', at(9), { hours: 3 });
  assert.equal(r.startText, '10/24(六) 上午');
  assert.equal(r.endText, '10/26(一) 上午');
});

test('工作日曆停工：週五停工時，週六的料要在週四備齊', () => {
  const cal = [{ serial: T + 1, am: false, pm: false, ot: false, prep: false }];
  assert.equal(single(2, '上午', at(9), {}, cal).deadlineText, '10/22(四) 下午');
  assert.equal(single(1, '上午', at(9), {}, cal).startText, '10/24(六) 上午');
});

test('工作日曆：取消加班時，加班時段不排包裝', () => {
  const cal = [{ serial: T, am: true, pm: true, ot: false, prep: true }];
  const r = single(0, '下午', at(9), { hours: 2 }, cal);
  assert.equal(r.endText, '10/23(五) 上午');
});

test('包裝中且沒填開始時間：自動記下現在的時段', () => {
  const r = run([order({ status: STATUS.PACKING, hours: 1 })], at(10, 30)).results[0];
  assert.equal(r.stamp.serial, T);
  assert.equal(r.stamp.label, '上午後半');
  assert.equal(r.startText, '10/22(四) 上午後半');
  assert.equal(r.endText, '10/22(四) 下午前半');
});

test('包裝中從昨天開始：下一張接在它後面', () => {
  const res = run([
    order({ row: 2, wo: 'A', seq: 1, hours: 2, status: STATUS.PACKING, fixedSerial: T - 1, fixedLabel: '加班' }),
    order({ row: 3, wo: 'B', seq: 2, hours: 1 })
  ]);
  assert.equal(res.results[0].startText, '10/21(三) 加班');
  assert.equal(res.results[0].endText, '10/22(四) 上午');
  assert.equal(res.results[1].startText, '10/22(四) 下午');
  assert.equal(res.results[0].stamp, null);
});

test('包裝中已超時：下一張從現在開始', () => {
  const res = run([
    order({ row: 2, wo: 'A', seq: 1, hours: 1, status: STATUS.PACKING, fixedSerial: T - 1, fixedLabel: '上午' }),
    order({ row: 3, wo: 'B', seq: 2, hours: 1 })
  ], at(13, 30));
  assert.equal(res.results[1].startText, '10/22(四) 下午');
});

test('外包品指定最早開始時間，不會排在那之前', () => {
  const res = run([
    order({ row: 2, wo: 'A', seq: 1, hours: 1 }),
    order({ row: 3, wo: 'B', seq: 2, hours: 1, fixedSerial: T + 1, fixedLabel: '下午' })
  ]);
  assert.equal(res.results[1].startText, '10/23(五) 下午');
});

test('燈號：早上 9 點', () => {
  assert.equal(single(0, '下午', at(9)).light, LIGHT.NOW);
  assert.equal(single(0, '加班', at(9)).light, LIGHT.NEXT);
  assert.equal(single(1, '上午', at(9)).light, LIGHT.NEXT);
  assert.equal(single(2, '上午', at(9)).light, LIGHT.LATER);
  assert.equal(single(0, '下午', at(9), { prepped: true }).light, LIGHT.PREPPED);
});

test('燈號：下午已過上午的期限 → 逾期', () => {
  assert.equal(single(0, '下午', at(13, 30)).light, LIGHT.OVERDUE);
});

test('燈號：晚上加班時，明天早上的料要在下個備料時段完成', () => {
  assert.equal(single(1, '上午', at(18)).light, LIGHT.OVERDUE); // 期限是今天下午
  assert.equal(single(1, '下午', at(18)).light, LIGHT.NOW);     // 期限是明天上午
  assert.equal(single(2, '上午', at(18)).light, LIGHT.NEXT);    // 週六的料，期限明天下午
});

test('燈號：完成、未排入、缺時段數、工單重複', () => {
  const res = run([
    order({ row: 2, wo: 'D', status: STATUS.DONE }),
    order({ row: 3, wo: 'U', seq: null }),
    order({ row: 4, wo: 'M', seq: 3, hours: null }),
    order({ row: 5, wo: 'X', seq: 4 }),
    order({ row: 6, wo: 'X', seq: 5 })
  ]);
  const lights = res.results.map(r => r.light);
  assert.deepEqual([...lights], [LIGHT.FINISHED, LIGHT.UNQUEUED, LIGHT.MISSING_HOURS, LIGHT.DUPLICATE, LIGHT.DUPLICATE]);
  assert.equal(res.prepList.length, 4); // 完成的不列入
});

test('出貨風險：包裝結束晚於出貨日', () => {
  assert.equal(single(1, '上午', at(9), { ship: T }).shipRisk, true);
  assert.equal(single(1, '上午', at(9), { ship: T + 1 }).shipRisk, false);
});

test('甘特圖：跳過週日、標出現在時段、統計現場包材', () => {
  const res = run([
    order({ row: 2, wo: 'A', seq: 1, hours: 1, prepped: true }),
    order({ row: 3, wo: 'B', seq: 2, hours: 1, fixedSerial: T, fixedLabel: '加班' })
  ]);
  const g = res.gantt;
  assert.ok(g.days.every(d => !d.label.includes('(日)')));
  assert.equal(g.days[0].width, 6);
  assert.equal(g.days.find(d => d.label.includes('(六)')).width, 4);
  assert.equal(g.nowCol, 0);
  // 現在：A 已備料在現場；B 的期限是今天下午，下午開始才算
  assert.equal(g.counts[0], 1);
  assert.equal(g.counts[2], 1);
  assert.equal(g.counts[4], 1); // 加班時 A 已包完，B 在現場
  // B 的最晚備料時段（今天下午）標「備」
  assert.equal(res.gantt.cells[1][2].text, '備');
});

test('自動計算包裝時段數：以 0.5 時段無條件進位', () => {
  assert.equal(autoHours(200, 100), 2);
  assert.equal(autoHours(80, 60), 1.5);
  assert.equal(autoHours(10, 100), 0.5);
  assert.equal(autoHours(101, 100), 1.5);
  assert.equal(autoHours(100, null), null);
  assert.equal(autoHours(0, 100), null);
});

test('planAutoHours：只處理空白或上次自動算的，手動值不動', () => {
  const models = [{ customer: '甲', model: 'A', capacity: 100 }];
  const orders = [
    { row: 2, customer: '甲', model: 'A', qty: 250, hours: null, hoursNote: '' },
    { row: 3, customer: '甲', model: 'A', qty: 250, hours: 9, hoursNote: '' },
    { row: 4, customer: '甲', model: 'A', qty: 300, hours: 2.5, hoursNote: '自動計算：250 台 ÷ 每時段 100 台' },
    { row: 5, customer: '乙', model: 'A', qty: 100, hours: null, hoursNote: '' }
  ];
  const updates = planAutoHours(orders, models);
  assert.deepEqual([...updates].map(u => [u.row, u.hours]), [[2, 2.5], [4, 3]]);
  assert.equal(orders[1].hours, 9);
  assert.equal(orders[3].hours, null); // 乙沒有 A 機型
});

test('nextSeq：未完成工單的最大順序取整數 + 1', () => {
  assert.equal(nextSeq([]), 1);
  assert.equal(nextSeq([{ status: '待包裝', seq: 3 }, { status: '待包裝', seq: 4.5 }, { status: '完成', seq: 9 }]), 5);
  assert.equal(nextSeq([{ status: '待包裝', seq: null }]), 1);
});

test('safeText、isoToSerial、colLetter', () => {
  assert.equal(safeText('=1+1'), "'=1+1");
  assert.equal(safeText('-5'), "'-5");
  assert.equal(safeText('WO-1'), 'WO-1');
  assert.equal(isoToSerial('2026-10-22'), T);
  assert.equal(isoToSerial('2026-02-30'), null);
  assert.equal(isoToSerial('10/22'), null);
  assert.equal(colLetter(12), 'L');
  assert.equal(colLetter(27), 'AA');
});

test('validateNewOrder：正確資料產生一列', () => {
  const ctx = {
    customers: ['甲'], models: [{ customer: '甲', model: 'A', capacity: 100 }],
    statuses: ['未開工', '完成'], methods: ['自製', '外包'], existingWos: ['WO-1'], nextSeq: 4
  };
  const v = validateNewOrder({ customer: '甲', model: 'A', wo: ' WO-2 ', qty: '150', ship: '2026-10-30',
    method: '外包', status: '', seqMode: 'last', hoursAuto: true, note: '第一行\n第二行' }, ctx);
  assert.deepEqual([...v.errors], []);
  assert.equal(v.wo, 'WO-2');
  const row = v.row;
  assert.equal(row.length, 16);
  assert.equal(row[1], 'WO-2');
  assert.equal(row[4], 150);
  assert.equal(row[5], serialFromYmd(2026, 10, 30));
  assert.equal(row[7], '未開工');
  assert.equal(row[10], 4);
  assert.equal(row[11], 1.5);
  assert.equal(row[15], '第一行 第二行');
  assert.match(v.hoursNote, /^自動計算/);
});

test('validateNewOrder：各種錯誤', () => {
  const ctx = {
    customers: ['甲'], models: [{ customer: '甲', model: 'A', capacity: null }],
    statuses: ['未開工'], methods: ['自製'], existingWos: ['WO-1'], nextSeq: 1
  };
  const errs = d => [...validateNewOrder(d, ctx).errors].join('｜');
  assert.match(errs({}), /客戶.*機型.*工單編號.*數量/);
  assert.match(errs({ customer: '乙', model: 'A', wo: 'x', qty: 1 }), /不在客戶清單/);
  assert.match(errs({ customer: '甲', model: 'A', wo: 'wo-1', qty: 1 }), /已經存在/);
  assert.match(errs({ customer: '甲', model: 'A', wo: 'x', qty: 1.5 }), /整數/);
  assert.match(errs({ customer: '甲', model: 'A', wo: 'x'.repeat(31), qty: 1 }), /最多 30/);
  assert.match(errs({ customer: '甲', model: 'A', wo: 'x', qty: 1, ship: '2026-13-01' }), /出貨日/);
  assert.match(errs({ customer: '甲', model: 'A', wo: 'x', qty: 1, status: '亂填' }), /目前狀態/);
  assert.match(errs({ customer: '甲', model: 'A', wo: 'x', qty: 1, seqMode: 'custom', seq: '' }), /指定順序/);
  assert.match(errs({ customer: '甲', model: 'A', wo: 'x', qty: 1, hoursAuto: false, hours: '0.3' }), /0\.5 為單位/);
  // 機型沒有包裝數量又要排入：要求填時段數
  assert.match(errs({ customer: '甲', model: 'A', wo: 'x', qty: 1 }), /請填「包裝時段數」/);
  // 先不排入就不用時段數
  assert.equal(errs({ customer: '甲', model: 'A', wo: 'x', qty: 1, seqMode: 'none' }), '');
});

test('包裝中的工單一律排第一，其他工單接在後面，不會重疊', () => {
  const res = run([
    order({ row: 2, wo: 'A', seq: 1, hours: 1 }),
    order({ row: 3, wo: 'B', seq: 2, hours: 1 }),
    order({ row: 4, wo: 'P', seq: 5, hours: 2, status: STATUS.PACKING, fixedSerial: T, fixedLabel: '上午' })
  ]);
  const by = Object.fromEntries(res.results.map(r => [r.src.wo, r]));
  assert.equal(by.P.startText, '10/22(四) 上午');
  assert.equal(by.P.endText, '10/22(四) 下午');
  assert.equal(by.A.startText, '10/22(四) 加班');
  assert.equal(by.B.startText, '10/23(五) 上午');
  assert.deepEqual([...res.prepList.map(r => r.src.wo)], ['P', 'A', 'B']);
});

test('包裝中但沒填包裝順序，仍然排入隊伍', () => {
  const res = run([
    order({ row: 2, wo: 'A', seq: 1, hours: 1 }),
    order({ row: 3, wo: 'P', seq: null, hours: 1, status: STATUS.PACKING })
  ]);
  const by = Object.fromEntries(res.results.map(r => [r.src.wo, r]));
  assert.notEqual(by.P.light, LIGHT.UNQUEUED);
  assert.equal(by.P.startText, '10/22(四) 上午');
  assert.equal(by.A.startText, '10/22(四) 下午');
});

test('planRenumber：依隊伍先後編成 1、2、3，完成與未排入的不動', () => {
  const plan = planRenumber([
    { row: 2, status: STATUS.WAITING, seq: 10 },
    { row: 3, status: STATUS.DONE, seq: 1 },
    { row: 4, status: STATUS.WAITING, seq: 2.5 },
    { row: 5, status: STATUS.PACKING, seq: 40 },
    { row: 6, status: STATUS.NOT_STARTED, seq: null },
    { row: 7, status: STATUS.TEST, seq: 2.5 }
  ]);
  assert.deepEqual([...plan].map(p => [p.row, p.seq]), [[5, 1], [4, 2], [7, 3], [2, 4]]);
});
