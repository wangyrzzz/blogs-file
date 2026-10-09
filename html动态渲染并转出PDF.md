# HTML 动态渲染并转换为 PDF

> 阅读范围：受信任模板生成 HTML，使用 Playwright Chromium 渲染；外部 URL 与任意用户 HTML 需要额外网络隔离。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


把 HTML 转成 PDF 常见于合同、对账单、发票和运营报表。难点不在于调用一个转换 API，而在于动态数据、字体、分页、图片、资源加载和安全控制。对于现代 CSS 和 JavaScript 页面，优先使用真正的浏览器内核进行渲染。

## 选择渲染方式

- 既有静态模板：可评估已有传统转换工具的维护状态和 CSS 能力，新项目不要忽略其浏览器内核与维护限制；
- 需要现代 CSS、字体和 JavaScript：使用 Chromium、Playwright 或 Puppeteer；
- 高并发、固定模板：可使用独立渲染服务或浏览器实例池；
- 极高一致性要求：固定浏览器版本、字体包和模板版本，并做视觉回归测试。

浏览器渲染通常比字符串拼接 PDF 更接近用户看到的页面，但资源和进程成本也更高。

## 推荐的渲染流程

1. 服务端根据业务数据生成不可修改的 HTML；
2. 将图片、CSS 和字体使用可信的本地路径或受控 URL；
3. 启动或复用浏览器上下文；
4. 等待数据渲染和字体加载完成；
5. 设置纸张、边距、页眉页脚和背景打印选项；
6. 生成 PDF，校验文件大小和页数后返回或上传对象存储。

## Playwright Java 示例

```java
try (Playwright playwright = Playwright.create();
     Browser browser = playwright.chromium().launch(
             new BrowserType.LaunchOptions().setHeadless(true))) {
    Page page = browser.newPage();
    page.setContent(html, new Page.SetContentOptions()
            .setWaitUntil(WaitUntilState.DOMCONTENTLOADED));
    page.evaluate("document.fonts && document.fonts.ready");
    byte[] pdf = page.pdf(new Page.PdfOptions()
            .setFormat("A4")
            .setPrintBackground(true)
            .setMargin(new Margin().setTop("16mm").setBottom("16mm")));
}
```

示例只展示核心流程。生产环境应复用浏览器进程、限制并发上下文数量，并在超时、浏览器崩溃和页面加载失败时释放资源。具体依赖版本应与项目 JDK 和浏览器驱动匹配。

## 分页控制

通过 CSS 控制分页：

```css
.page-break {
  break-before: page;
}

tr, img {
  break-inside: avoid;
}

@page {
  size: A4;
  margin: 16mm 12mm;
}
```

复杂表格不要只依赖浏览器自动分页，应为表头重复、长文本换行、合计行和跨页规则准备专门模板。中文字体缺失是最常见的“本地正常、服务器乱码”原因之一，部署时要显式安装并验证字体。

## 动态资源与安全

如果 HTML 中引用外部图片、CSS 或接口，渲染结果会受网络和权限影响。推荐提前把资源准备到可信存储，或以内嵌 Data URL 的方式传入。浏览器上下文应限制访问内网地址、云元数据地址和不可信 URL，防止 SSRF。

模板数据要进行 HTML 转义，不能把用户输入直接拼成脚本。PDF 服务应限制单次 HTML 长度、图片像素、渲染超时和并发数，避免恶意内容耗尽 CPU 或内存。

## 异步生成与下载

大文件和复杂报表适合异步生成：业务记录保存 `PENDING`、`PROCESSING`、`SUCCESS`、`FAILED` 状态，任务队列负责执行，成功后返回短期下载地址。下载接口再次校验用户、租户和资源归属，不要把永久对象存储地址直接暴露给客户端。

## 排查空白页和布局错乱

优先确认 HTML 是否包含正确数据，再检查字体、图片响应、浏览器控制台错误和网络请求。若页面依赖前端异步请求，必须等待明确的业务完成标记，而不是盲目 `sleep`。对关键模板保存固定样例并做 PDF 文本和截图对比，能提前发现升级浏览器带来的布局变化。


## PDF 是一份应当可重建的业务快照

一张订单 PDF 应对应明确的数据版本、模板版本、字体版本和渲染环境。若生成时临时请求商品接口、价格接口和客户接口，这些响应可能来自不同时间点，最终文件并不是一个一致业务快照。更可靠的方式是先组装并保存授权后的渲染数据，再交给独立渲染任务。

可重建不一定要求输出字节完全相同。PDF 元数据、内部对象编号或生成时间可能使二进制不同，但文本、页数、金额和布局应符合相同契约。若业务要求签名和长期归档，还需要单独评估签名流程、字体嵌入、归档标准与校验工具，不能把浏览器导出直接称为合规归档文件。

## 等待页面完成需要一个明确条件

networkidle 只描述网络活动，并不证明图表绘制、字体替换和业务计算已经结束；有长连接的页面可能一直不满足它，没有网络请求的异步绘制又可能在它之后发生。服务端生成静态 HTML 时，等待 DOM、字体和所有图片解码通常更可解释。确有页面脚本时，由模板在业务完成后设置明确标记，并为等待设置超时。

Playwright 的[page.pdf 文档](https://playwright.dev/docs/api/class-page#page-pdf)说明 Chromium PDF 输出与打印媒体行为。不要把截图样式和打印样式混用，CSS @media print、@page 以及 printBackground 都会改变输出。

## 先构造安全、稳定的 HTML

下面函数使用文本转义，把订单数据放入固定模板。金额已经是经过业务校验的整数分，格式化采用明确语言和币种。真实项目应校验每个字段长度、行数和授权，不允许调用者直接传入任意脚本或样式。

~~~javascript
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[character]));
}

function formatMoney(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error('invalid amount');
  return new Intl.NumberFormat('zh-CN', {
    style:'currency', currency:'CNY'
  }).format(cents / 100);
}

export function orderHtml(order) {
  if (!Array.isArray(order.lines) || order.lines.length > 500) {
    throw new Error('line count limit exceeded');
  }
  const rows = order.lines.map((line,index) =>
    '<tr><td>'+String(index+1)+'</td><td>'+escapeHtml(line.sku)+'</td>'+
    '<td>'+escapeHtml(line.name)+'</td><td>'+escapeHtml(line.quantity)+'</td>'+
    '<td class="money">'+escapeHtml(formatMoney(line.amountCents))+'</td></tr>'
  ).join('');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'+
    '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; '+
    'style-src &#39;unsafe-inline&#39;; img-src data:; font-src data:">'+
    '<style>'+PRINT_CSS+'</style></head><body>'+
    '<h1>订单明细</h1><p>订单号：'+escapeHtml(order.id)+'</p>'+
    '<table><thead><tr><th>序号</th><th>SKU</th><th>名称</th><th>数量</th><th>金额</th></tr></thead>'+
    '<tbody>'+rows+'</tbody></table>'+
    '<section class="total">合计：'+escapeHtml(formatMoney(order.totalCents))+'</section>'+
    '</body></html>';
}

const PRINT_CSS = [
  '@page { size:A4; margin:16mm 12mm; }',
  'body { font-family:"Noto Sans CJK SC",sans-serif; font-size:10pt; color:#111; }',
  'table { width:100%; border-collapse:collapse; table-layout:fixed; }',
  'thead { display:table-header-group; }',
  'th,td { border:0.2mm solid #bbb; padding:2mm; overflow-wrap:anywhere; }',
  'tr { break-inside:avoid; }',
  '.money { text-align:right; white-space:nowrap; }',
  '.total { margin-top:4mm; break-inside:avoid; font-weight:bold; }'
].join('');
~~~

这份模板在镜像里预装中文字体，外部资源全部禁止，适合受控静态订单。若需要图片，应先从授权来源下载、校验格式和像素，再以内嵌数据或受控本地资源提供。不要把用户可控 URL 直接拼成 img src，让浏览器代替用户访问内网。

金额在现实系统中可能超过 JavaScript 安全整数或需要复杂舍入规则，应使用十进制定点方案；示例显式拒绝不安全整数，不适用于所有金额范围。合计也要与行明细在业务层校验，PDF 渲染器不应该自行重新计算一套不同的财务规则。

## 一个受控 Chromium 渲染核心

下面 Node.js 示例使用 playwright 包，浏览器二进制必须与依赖版本一起固定安装。示例每次启动进程便于理解隔离，生产可通过有界进程池复用浏览器，但每个任务仍创建独立 context。代码禁止网络并关闭页面脚本，适合上面的静态模板。

~~~javascript
import { chromium } from 'playwright';

export async function renderOrderPdf(html) {
  if (Buffer.byteLength(html,'utf8') > 2 * 1024 * 1024) {
    throw new Error('HTML_SIZE_LIMIT');
  }
  const browser = await chromium.launch({ headless:true });
  try {
    const context = await browser.newContext({
      javaScriptEnabled:false,
      locale:'zh-CN',
      timezoneId:'Asia/Shanghai',
      serviceWorkers:'block'
    });
    try {
      await context.route('**/*', route => route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.setContent(html, { waitUntil:'domcontentloaded', timeout:10000 });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images).map(image => {
          if (!image.complete) return image.decode();
          if (image.naturalWidth === 0) throw new Error('image decode failed');
          return Promise.resolve();
        }));
      });
      const pdf = await page.pdf({
        format:'A4',
        printBackground:true,
        preferCSSPageSize:true,
        displayHeaderFooter:true,
        headerTemplate:'<div></div>',
        footerTemplate:'<div style="font-size:8px;width:100%;text-align:center;">'+
          '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
        margin:{ top:'16mm',right:'12mm',bottom:'16mm',left:'12mm' }
      });
      if (pdf.length === 0) throw new Error('EMPTY_PDF');
      return pdf;
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
~~~

关闭网页脚本不妨碍自动化 evaluate 检查文档状态，但不应把这一能力暴露给不可信调用者。等待字体集合就绪也不证明每个中文字符都有正确字形，字体缺失可能使用 fallback，仍需要视觉检查。page.pdf 的进程级卡死不能只依赖普通页面操作超时，生产工作者还应有独立总时限，由监督进程回收失控浏览器。

## 分页需要准备极端样本

不要给整张长表设置 break-inside:avoid，否则表格可能整体被挪到下一页、产生大块空白。对普通行避免拆分通常合理，但单行内容高于一页时，浏览器必须做出分割或溢出选择。超长备注应拆成独立块，或在产品层限制长度，而不是期待 CSS 永远同时满足所有约束。

重复表头使用语义化 thead，合计区单独控制，列宽要考虑长 SKU、英文单词和中文换行。页眉页脚模板的样式与主页面不是任意共享，资源也可能有不同限制，最好保持简单并独立设置字体大小。PDF 页边距要为页脚留空间，不能把内容顶到可打印区域之外。

一个完整样本集包括零行、一行、刚好一页、多页、超长名称、负数或退款金额、特殊字符、缺图片、透明图片和不同字体。截图比较要容忍抗锯齿微差，同时对页数、金额和关键文本做严格断言，避免视觉像素测试漏掉文本被截断或金额错误。

## SSRF 不能只靠 URL 字符串匹配

需要访问外部资源的渲染服务必须考虑重定向、DNS 重新解析、IPv6、内网地址和云元数据端点。仅禁止 URL 包含 127.0.0.1 不足以构成完整防护。更可控的结构是资源下载服务验证来源、网络层限制出口，浏览器只读取准备好的资源包。路由拦截是附加控制，不能替代运行容器的网络隔离。

浏览器进程使用低权限用户和沙箱，不要为了启动方便默认添加关闭沙箱参数。HTML 长度、图片像素、行数、页数、运行时间和并发都要限制。输出 PDF 下载接口再次验证业务归属，短期签名 URL 过期后不能继续成为永久公开文件。

## 异步任务和可重建记录

任务身份可以由订单版本、模板版本、语言、时区和配方组成。同一身份重复请求可以复用已完成结果，新的订单版本则生成新文件。处理中状态要有租约和超时恢复，浏览器崩溃后任务不能永久卡在 PROCESSING。生成成功后先保存完整对象，再以条件更新标记结果，重试能够识别已经存在的有效文件。

生产排查应保存脱敏的输入快照摘要、模板版本、浏览器版本、字体清单、控制台错误与失败截图。敏感完整合同不宜无期限存入普通日志。固定环境后仍要在浏览器或字体升级时做回归，因为分页算法与字形度量变化都可能改变总页数。

## 文字可提取、阅读顺序与物理尺寸

合同的验收还应覆盖“人能看”和“程序能读”两种结果。把整张页面截成图片再嵌入 PDF，虽然能暂时绕开字体布局差异，却会失去原有文字层，影响搜索、复制、辅助阅读和下游对账。正文、订单号和金额应尽量保留为真实文本；图表可以有视觉图形，同时提供可读标题与必要的数据说明。文本提取程序读出的次序也要检查，尤其是使用绝对定位、多栏排版或 CSS 调整视觉顺序的模板。

例如页面左侧是买方信息、右侧是卖方信息，画面正确不表示提取结果一定先读完左栏再读右栏。若归档系统要从 PDF 提取税号，应对固定样本检查字段与值的关系，不能仅断言全文包含两个税号。业务系统已有结构化数据时，更稳妥的做法是保存同版本的结构化快照供机器使用，而不是再从视觉文件反向猜测数据。

Playwright 的 `page.pdf` 提供 `tagged` 和 `outline` 选项，文档标明它们从 1.42 加入；使用前应确认锁定依赖支持。这些选项分别涉及带标签输出与文档大纲，但开启参数不等于模板已经通过完整的可访问性验收。语义标题、表格表头、图片说明和合理的 DOM 顺序仍要由模板提供，输出后还需用实际阅读器检查。[Playwright PDF 参数说明](https://playwright.dev/docs/api/class-page#page-pdf)

另一个容易忽略的差异是屏幕尺寸与纸张尺寸。标签、装订孔和盖章留白通常有明确毫米要求，应优先在打印样式中使用 `mm`、`cm` 或 `pt`，并固定纸张与缩放选项。浏览器窗口上量到的像素不能直接当成打印机上的毫米。对必须套打的表单，准备带标尺的校准页，检查 PDF 页面尺寸，再用实际打印设备按原始大小输出；阅读器的“适合页面”缩放也会改变最后位置。

字体检查除了是否显示方框，还应验证复制出来的字符是否正确、数字是否易混淆、加粗后是否改变换行。对金额和编号，视觉上相似的字形不能替代正确字符。最终验收可保存三类结果：页面图像负责外观，文本提取负责内容与顺序，页面盒尺寸负责纸张几何。三者同时通过，才能说明该模板适合当前归档和打印用途。

## 故障注入与验收实验

以固定订单数据生成零行、单页和多页样本，检查文本、页数与页面截图。示例是渲染核心，不附虚构的性能数字；实际并发上限应以目标容器资源测量。

### PDF-01：中文字体

实验前提是镜像包含约定中文字体。执行渲染包含中文、生僻字和英文的模板。

通过条件是字形可见且没有方框或意外替代。这里的判断依据是fonts.ready 只证明加载状态，不证明全部字符视觉正确。

### PDF-02：特殊字符

实验前提是订单名称包含尖括号、引号和与号。执行经过模板转义后渲染。

通过条件是文本原样展示且不成为 HTML 结构。这里的判断依据是输入转义保护模板边界与页面语义。

### PDF-03：多页表格

实验前提是明细超过一页。执行导出并逐页检查表头和行内容。

通过条件是表头按需求重复，行无不可接受截断。这里的判断依据是分页正确性需要实际页面验证。

### PDF-04：超长行

实验前提是单条备注高度超过一页。执行按长文本策略渲染。

通过条件是拆分或限制行为明确，没有静默丢内容。这里的判断依据是break-inside 不能无条件满足大于页面的元素。

### PDF-05：图片失败

实验前提是样本包含无法解码图片。执行等待解码后尝试导出。

通过条件是任务明确失败或使用约定占位图。这里的判断依据是网络或 DOM 完成不代表图片已经可打印。

### PDF-06：异步页面完成

实验前提是另一模板需要脚本绘制图表。执行以业务标记等待并限制总时间。

通过条件是图表完整后才导出，超时有明确错误。这里的判断依据是固定 sleep 与 networkidle 不构成业务就绪证明。

### PDF-07：内网资源访问

实验前提是输入尝试引用未授权地址。执行在网络隔离和路由策略下渲染。

通过条件是请求被阻止且不能读取内部服务。这里的判断依据是浏览器渲染服务不能成为任意网络访问代理。

### PDF-08：并发内存压力

实验前提是多个长文档同时排队。执行逐步增加受控并发并记录峰值。

通过条件是并发和队列有上限，超载任务被可控处理。这里的判断依据是浏览器 context 隔离不等于资源成本为零。

### PDF-09：浏览器崩溃

实验前提是任务处于 PROCESSING。执行终止测试浏览器并触发恢复。

通过条件是资源释放、租约可恢复且任务不会永久悬挂。这里的判断依据是异步状态机需要覆盖执行进程消失。

### PDF-10：重复生成

实验前提是同一订单版本和模板被请求两次。执行按任务身份认领或复用结果。

通过条件是不会产生互相冲突的业务文件记录。这里的判断依据是可重建身份应包含所有影响输出的关键版本。

### PDF-11：模板升级

实验前提是保持订单数据不变只升级模板或字体。执行进行文本和视觉回归。

通过条件是差异可解释且金额、页数等硬约束通过。这里的判断依据是渲染环境变化会影响布局，不能只测接口返回 200。

### PDF-12：下载越权

实验前提是用户获得其他租户的文件 ID。执行调用下载接口或申请签名 URL。

通过条件是授权检查拒绝。这里的判断依据是文件已经生成不意味着任何知道地址的人都可读取。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "html动态渲染并转出PDF",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "PDF-01",
      "scenario": "中文字体",
      "given": "镜像包含约定中文字体",
      "when": "渲染包含中文、生僻字和英文的模板",
      "then": "字形可见且没有方框或意外替代"
    },
    {
      "id": "PDF-02",
      "scenario": "特殊字符",
      "given": "订单名称包含尖括号、引号和与号",
      "when": "经过模板转义后渲染",
      "then": "文本原样展示且不成为 HTML 结构"
    },
    {
      "id": "PDF-03",
      "scenario": "多页表格",
      "given": "明细超过一页",
      "when": "导出并逐页检查表头和行内容",
      "then": "表头按需求重复，行无不可接受截断"
    },
    {
      "id": "PDF-04",
      "scenario": "超长行",
      "given": "单条备注高度超过一页",
      "when": "按长文本策略渲染",
      "then": "拆分或限制行为明确，没有静默丢内容"
    },
    {
      "id": "PDF-05",
      "scenario": "图片失败",
      "given": "样本包含无法解码图片",
      "when": "等待解码后尝试导出",
      "then": "任务明确失败或使用约定占位图"
    },
    {
      "id": "PDF-06",
      "scenario": "异步页面完成",
      "given": "另一模板需要脚本绘制图表",
      "when": "以业务标记等待并限制总时间",
      "then": "图表完整后才导出，超时有明确错误"
    },
    {
      "id": "PDF-07",
      "scenario": "内网资源访问",
      "given": "输入尝试引用未授权地址",
      "when": "在网络隔离和路由策略下渲染",
      "then": "请求被阻止且不能读取内部服务"
    },
    {
      "id": "PDF-08",
      "scenario": "并发内存压力",
      "given": "多个长文档同时排队",
      "when": "逐步增加受控并发并记录峰值",
      "then": "并发和队列有上限，超载任务被可控处理"
    },
    {
      "id": "PDF-09",
      "scenario": "浏览器崩溃",
      "given": "任务处于 PROCESSING",
      "when": "终止测试浏览器并触发恢复",
      "then": "资源释放、租约可恢复且任务不会永久悬挂"
    },
    {
      "id": "PDF-10",
      "scenario": "重复生成",
      "given": "同一订单版本和模板被请求两次",
      "when": "按任务身份认领或复用结果",
      "then": "不会产生互相冲突的业务文件记录"
    },
    {
      "id": "PDF-11",
      "scenario": "模板升级",
      "given": "保持订单数据不变只升级模板或字体",
      "when": "进行文本和视觉回归",
      "then": "差异可解释且金额、页数等硬约束通过"
    },
    {
      "id": "PDF-12",
      "scenario": "下载越权",
      "given": "用户获得其他租户的文件 ID",
      "when": "调用下载接口或申请签名 URL",
      "then": "授权检查拒绝"
    }
  ]
}
```

## 稳定输出的基础

HTML 转 PDF 应以固定数据快照、受控资源、明确完成条件和可回归的页面样本为基础。把浏览器当成需要隔离与监督的工作进程，才能让导出功能在长文档、异常输入和并发任务下持续可靠。

## 参考资料与继续阅读

- [Playwright page.pdf](https://playwright.dev/docs/api/class-page#page-pdf)
- [本地延伸：图片处理](使用Serverless云函数处理图片.md)
