const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const rows=[]; const failures=[]; const jsChecks=[];
const generic1='先记录这一前提下的正常结果，再执行';
const generic2='。观察时需要同时保留操作前后的状态，不能仅凭最后一次请求没有抛出异常判定通过。';
const generic3='。如果结果不符合预期，应先核对输入、时序与实际运行版本，再定位实现差异；把失败样本保留下来，才能区分偶然调度和稳定缺陷。';
for(const file of fs.readdirSync(root).filter(x=>x.endsWith('.md'))) {
 const full=path.join(root,file); let s=fs.readFileSync(full,'utf8');
 if(s.includes('\uFFFD'))failures.push({file,invalidUnicodeReplacement:true});
 const clean=s.replaceAll(generic1,'执行').replaceAll(generic2,'。').replaceAll(generic3,'。');
 const body=clean.split('\n## 参考资料与继续阅读')[0].replace(/^# .*\n/,'');
 let fence=null; let code=[]; let lang=''; let block=0; let titleCount=0;
 for(const line of s.split('\n')) {
   const m=line.match(/^(`{3,}|~{3,})(.*)$/);
   if(m && !fence){fence=m[1];lang=m[2].trim();code=[];continue;}
   if(m && fence && m[1][0]===fence[0]){
     block++;
     if(lang==='json'){try{JSON.parse(code.join('\n'));}catch(e){failures.push({file,block,json:e.message});}}
     if(lang==='jsonl'){for(const line of code.filter(x=>x.trim())){try{JSON.parse(line);}catch(e){failures.push({file,block,jsonl:e.message});}}}
     if(lang==='javascript'){
       const test=path.join(__dirname,'syntax-'+rows.length+'-'+block+'.mjs');
       fs.writeFileSync(test,code.join('\n'));
       const syntaxFile=path.join(__dirname,'js-validation.json');
       const checks=fs.existsSync(syntaxFile)?JSON.parse(fs.readFileSync(syntaxFile,'utf8').replace(/^\uFEFF/,'')):[];
       const result=checks.find(x=>x.file===path.basename(test));
       jsChecks.push({file,block,passed:result?.passed===true,method:'node --check via PowerShell'});
     }
     fence=null;continue;
   }
   if(fence)code.push(line);
   else if(/^# /.test(line))titleCount++;
 }
 if(fence)failures.push({file,unclosedFence:fence});
 if(titleCount!==1)failures.push({file,unexpectedTitleCount:titleCount});
 const links=[...s.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)];
 for(const m of links){if(!/^(https?:|#)/.test(m[1])){const target=path.resolve(root,decodeURIComponent(m[1]));if(!fs.existsSync(target))failures.push({file,brokenLink:m[1]});}}
 rows.push({file,characters:[...s].length,nonWhitespace:[...s.replace(/\s/g,'')].length,editedBodyCharacters:[...body].length,editedBodyNonWhitespace:[...body.replace(/\s/g,'')].length,codeBlocks:block});
}
const hashes=JSON.parse(fs.readFileSync(path.join(__dirname,'archive-hashes.json'),'utf8').replace(/^\uFEFF/,''));
for(const h of hashes){const now=crypto.createHash('sha256').update(fs.readFileSync(h.Path)).digest('hex').toUpperCase();if(now!==h.Hash)failures.push({modifiedArchive:h.Path});}
for(const row of rows){if(row.editedBodyNonWhitespace<10000)failures.push({file:row.file,bodyUnder10000:row.editedBodyNonWhitespace});}
if(rows.length!==24)failures.push({unexpectedRootArticleCount:rows.length});
for(const check of jsChecks){if(!check.passed)failures.push({file:check.file,block:check.block,javascriptSyntaxFailedOrUnchecked:true});}
const javaPath=path.join(__dirname,'java-validation.json');
const javaChecks=fs.existsSync(javaPath)?JSON.parse(fs.readFileSync(javaPath,'utf8').replace(/^\uFEFF/,'')):[];
const report={count:rows.length,countingRule:'Unicode characters in body including code, excluding H1, references and all whitespace',minimumBodyCharacters:Math.min(...rows.map(r=>r.editedBodyNonWhitespace)),totalBodyCharacters:rows.reduce((sum,r)=>sum+r.editedBodyNonWhitespace,0),rows,failures,jsChecks,javaChecks,archivedFilesVerified:hashes.length};
fs.writeFileSync(path.join(__dirname,'validation.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
