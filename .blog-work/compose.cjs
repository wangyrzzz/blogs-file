const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const bases = JSON.parse(fs.readFileSync(path.join(__dirname,'bases.json'),'utf8').replace(/^\uFEFF/,''));
function writeArticle(a) {
  let base = bases[a.file].replace(/\r/g,'').replace(/\n## 总结[\s\S]*$/,'').replace(/^## [一二三四五六七八九十]+、/gm,'## ');
  for (const [from,to] of a.replace || []) base = base.replaceAll(from,to);
  const introEnd = base.indexOf('\n');
  base = base.slice(0,introEnd) + '\n\n> 阅读范围：' + a.scope + '。文中的实验结果是按机制推导的验收预期，不冒充生产压测或本机实测数据。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。\n' + base.slice(introEnd);
  let body = base + '\n\n' + a.body.trim() + '\n\n## 故障注入与验收实验\n\n' + a.lab + '\n';
  for (const c of a.cases) {
    const [id,title,given,action,expected,reason] = c;
    body += `\n### ${id}：${title}\n\n实验前提是${given}。先记录这一前提下的正常结果，再执行${action}。观察时需要同时保留操作前后的状态，不能仅凭最后一次请求没有抛出异常判定通过。\n\n通过条件是${expected}。这里的判断依据是${reason}。如果结果不符合预期，应先核对输入、时序与实际运行版本，再定位实现差异；把失败样本保留下来，才能区分偶然调度和稳定缺陷。\n`;
  }
  body += '\n## 将实验变成可复用的验收规格\n\n下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。\n\n```json\n';
  body += JSON.stringify({subject:a.file.replace(/\.md$/,''),verificationMode:'integration-with-controlled-faults',resultStatus:'not-executed-in-this-article',cases:a.cases.map(([id,title,given,action,expected])=>({id,scenario:title,given,when:action,then:expected}))},null,2);
  body += '\n```\n\n' + (a.end || '') + '\n\n## 参考资料与继续阅读\n\n';
  body += a.refs.map(([label,url])=>`- [${label}](${url})`).join('\n') + '\n';
  fs.writeFileSync(path.join(root,a.file), body, 'utf8');
  return {file:a.file,chars:Array.from(body).length,nonWhitespace:Array.from(body.replace(/\s/g,'')).length};
}
module.exports = {writeArticle};
