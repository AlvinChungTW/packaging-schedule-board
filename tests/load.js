// 把 src/Code.gs 載入到獨立的 vm 環境，可額外注入模擬的 Apps Script 全域物件
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE_PATH = path.join(__dirname, '..', 'src', 'Code.gs');

function loadCode(globals = {}) {
  const context = vm.createContext({ console, module: { exports: {} }, ...globals });
  vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), context, { filename: 'Code.gs' });
  return context;
}

module.exports = { loadCode };
