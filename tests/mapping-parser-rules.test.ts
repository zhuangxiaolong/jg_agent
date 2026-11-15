import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { applyTransform, buildProjectContext, exportCsv, exportXlsx, parseSourceData, suggestMappings, validateAndConvert } from '../packages/second-iteration/src';

test('自选表头、空行与原始行号保留，trim=false 不丢原值', () => {
  const parsed = parseSourceData('资料.csv',Buffer.from('客户导出\n\n编码,名称\n001, A \n\n002,B\n'),{headerRow:2,dataStartRow:3});
  assert.deepEqual(parsed.sourceRowNumbers,[4,6]);
  assert.equal(parsed.rows[0][1],' A ');
  assert.equal(applyTransform(parsed.rows[0][1],{trim:false}),' A ');
  const malformed=parseSourceData('a.csv',Buffer.from('编码\nx,y\n'));
  assert.equal(malformed.preview.structureValid,false);assert.deepEqual(malformed.rows,[['x','y']]);
});

test('受限 DSL 支持拼接、拆分、常量、枚举与单位换算并拒绝脚本', () => {
  const columns=[{key:'a',label:'a',sampleValues:[]},{key:'b',label:'b',sampleValues:[]}];
  assert.equal(applyTransform('',{joinKeys:['a','b'],separator:'-'},['01','02'],columns),'01-02');
  assert.equal(applyTransform('a/b',{splitDelimiter:'/',splitIndex:1,uppercase:true}),'B');
  assert.equal(applyTransform('',{constant:'00001'}),'00001');
  assert.equal(applyTransform('启用',{enumMap:{启用:'1'}}),'1');
  assert.equal(applyTransform('2.5',{multiplier:1000,decimals:0}),'2500');
  assert.throws(()=>applyTransform('未知',{enumMap:{启用:'1'}}),/没有转换规则/);
  assert.throws(()=>applyTransform('x',{script:'process.exit()'}));
});

test('字段规则定位真实源行：重复、类型、日期与枚举阻止通过', () => {
  const parsed=parseSourceData('资料.csv',Buffer.from('编码,数量,日期,状态\n001,2,2026-11-15,A\n\n001,x,2026-02-30,B\n'));
  const mappings=suggestMappings(parsed.preview.columns,['编码','数量','日期','状态']).map((item,index)=>({...item.mapping,status:'confirmed' as const,transformDsl:[{unique:true},{type:'number'},{type:'date'},{allowedValues:['A']}][index]}));
  const result=validateAndConvert(parsed.rows,parsed.preview.columns,mappings,'run',{sourceRowNumbers:parsed.sourceRowNumbers,sheetName:'CSV'});
  assert.equal(result.successCount,1);assert.equal(result.errorCount,4);
  assert.ok(result.issues.every(item=>item.sourceRow===4));
  assert.ok(result.issues.every(item=>item.blocking));
});

test('XLSX 绝对 relationship 与 rich text/公式无缓存/隐藏行得到真实警告', () => {
  const archive=unzipSync(exportXlsx(['编码'],[['001']]));
  archive['xl/_rels/workbook.xml.rels']=strToU8(strFromU8(archive['xl/_rels/workbook.xml.rels']).replace('worksheets/sheet1.xml','/xl/worksheets/sheet1.xml'));
  archive['xl/worksheets/sheet1.xml']=strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><r><t>编</t></r><r><t>码</t></r></is></c></row><row r="3" hidden="1"><c r="A3"><f>1+1</f></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>0001</t></is></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>');
  const parsed=parseSourceData('资料.xlsx',zipSync(archive));
  assert.equal(parsed.preview.columns[0].label,'编码');assert.equal(parsed.rows.at(-1)?.[0],'0001');
  assert.match(parsed.preview.warnings?.join('\n')??'',/没有缓存值/);assert.match(parsed.preview.warnings?.join('\n')??'',/隐藏行已保留/);
  assert.equal(parsed.preview.uncachedFormulaCount,1);assert.match(parsed.preview.warnings?.join('\n')??'',/=1\+1/);
  assert.match(parsed.preview.warnings?.join('\n')??'',/合并单元格/);
});

test('CSV 报告防公式注入，XLSX 使用文本单元格不执行公式', () => {
  assert.match(exportCsv(['编码'],[['=1+1'],['-cmd'],['-1.2']]),/'=1\+1\r\n'-cmd\r\n-1.2/);
  assert.deepEqual(parseSourceData('资料.xlsx',exportXlsx(['编码'],[['=1+1']])).rows,[['=1+1']]);
  assert.equal(parseSourceData('资料.xlsx',exportXlsx(['编码'],[['0001']],'物料&"模板')).preview.sheetName,'物料&"模板');
  assert.throws(()=>exportXlsx(['编码'],[['0001']],'非法/表名'),/工作表名称/);
});

test('项目上下文预算只记录真正装入的来源，并排除被确认新事实替代的旧事实', () => {
  const date='2026-11-14T00:00:00Z';const project={id:'p',name:'样本',systemType:'MES6' as const,productVersions:[],stage:'开发',status:'active' as const,createdAt:date,updatedAt:date};
  const fact=(id:string,content:string)=>({id,projectId:'p',title:id,content,category:'业务',status:'confirmed' as const,sourceRefs:[],createdAt:date,updatedAt:date});
  const result=buildProjectContext(project,[],[fact('old','旧规则'),{...fact('new','新规则'),supersedesFactId:'old'},fact('long','X'.repeat(1000))],[],{budget:200});
  assert.match(result.text,/新规则/);assert.doesNotMatch(result.text,/旧规则|XXXX/);
  assert.deepEqual(result.snapshot.selectedSources.map(item=>item.sourceId),['new']);assert.ok(result.text.length<=200);
});
