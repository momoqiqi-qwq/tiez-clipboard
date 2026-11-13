import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/shared/lib/fileCategories.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText, { exports });
const { parseFileExtensions: parse, readFileCategories: read, matchesFileExtensions: matches } = exports;
assert.deepEqual(Array.from(parse('*.PDF, .docx；XLSX py; pdf，tar.gz /bad * ?')), ['pdf', 'docx', 'xlsx', 'py', 'tar.gz']);
assert.ok(read().length > 10);
assert.deepEqual(Array.from(read('[]')), []);
assert.ok(read('{broken').length > 10);
const categories = read(JSON.stringify([{id:'custom',name:'资料',extensions:['*.PDF','pdf'],icon:'document',visible:false}, {id:'custom',name:'重复',extensions:['py'],icon:'code'}, {id:'bad',name:'空',extensions:['*'],icon:'file'}, null]));
assert.equal(categories.length, 1);
assert.equal(categories[0].visible, false);
assert.deepEqual(Array.from(categories[0].extensions), ['pdf']);
assert.ok(matches({content_type:'file', content:'C:\\a.txt\r\n"C:\\报告.PDF"'}, ['pdf']));
assert.ok(matches({content_type:'file', content:'/tmp/a.tar.gz'}, ['tar.gz']));
assert.ok(!matches({content_type:'text', content:'C:\\报告.pdf'}, ['pdf']));
assert.ok(!matches({content_type:'file', content:'C:\\a.pdf\\b.docx'}, ['pdf']));
assert.ok(!matches({content_type:'file', content:'C:\\a.pdf.bak'}, ['pdf']));
console.log('PASS: extension normalization, compound suffixes, invalid config recovery, duplicate IDs, hidden categories and file path matching');
