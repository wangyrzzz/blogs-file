const fs=require('node:fs'); const path=require('node:path');
const root=path.resolve(__dirname,'..');
for(const file of fs.readdirSync(root).filter(x=>x.endsWith('.md'))){
 let s=fs.readFileSync(path.join(root,file),'utf8');
 s=s.replaceAll('先记录这一前提下的正常结果，再执行','执行')
 .replaceAll('。观察时需要同时保留操作前后的状态，不能仅凭最后一次请求没有抛出异常判定通过。','。')
 .replaceAll('。如果结果不符合预期，应先核对输入、时序与实际运行版本，再定位实现差异；把失败样本保留下来，才能区分偶然调度和稳定缺陷。','。');
 if(file==='基于Gitlab的CI_CD.md')s=s.replaceAll('/^v[0-9]+.[0-9]+.[0-9]+$/','/^v[0-9]+[.][0-9]+[.][0-9]+$/');
 if(file==='Loki日志系统替代ELK.md'||file==='轻量级日志traceId方案TLog.md')s=s.replace(/~~~json\n([\s\S]*?)\n~~~/g,(all,code)=>code.trim().split('\n').length>1?'~~~jsonl\n'+code+'\n~~~':all);
 s=s.replace('文中的实验结果是按机制推导的验收预期，不冒充生产压测或本机实测数据。','故障实验给出机制推导的验收预期，性能数据需在目标环境测量。');
 fs.writeFileSync(path.join(root,file),s);
}
const labDir=path.join(__dirname,'java-labs');fs.mkdirSync(labDir,{recursive:true});
const wanted=['LockInventoryLab','ConcurrentMapLab','InitializationLab','LoaderIdentityLab','LocalSnowflake','OrderRoute'];
for(const file of fs.readdirSync(root).filter(x=>x.endsWith('.md'))){
 const s=fs.readFileSync(path.join(root,file),'utf8');
 for(const m of s.matchAll(/~~~java\n([\s\S]*?)\n~~~/g)){
  for(const name of wanted){if(new RegExp('public (?:final )?class '+name+'\\b').test(m[1]))fs.writeFileSync(path.join(labDir,name+'.java'),m[1]);}
 }
}
console.log('Polished 24 articles; extracted standalone Java examples.');
