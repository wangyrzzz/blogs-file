const fs=require('node:fs');const path=require('node:path');
const root=path.resolve(__dirname,'..');const dest=path.join(__dirname,'java-labs');
fs.mkdirSync(dest,{recursive:true});
const names=['LockInventoryLab','ConcurrentMapLab','InitializationLab','LoaderIdentityLab','LocalSnowflake','OrderRoute','SnowflakeEncodingLab'];
for(const file of fs.readdirSync(root).filter(f=>f.endsWith('.md'))){
 const article=fs.readFileSync(path.join(root,file),'utf8');
 for(const m of article.matchAll(/~~~java\n([\s\S]*?)\n~~~/g)){
  for(const name of names)if(new RegExp('public (?:final )?class '+name+'\\b').test(m[1]))fs.writeFileSync(path.join(dest,name+'.java'),m[1]);
 }
}
