// Loads the browser scripts into a Node context (they attach to globalThis.FAS).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
module.exports = function load(files) {
  for (const f of files) vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), { filename: f });
  return globalThis.FAS;
};
