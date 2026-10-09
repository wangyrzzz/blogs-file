const {writeArticle}=require('./compose.cjs');
const articles=[{
file:'使用Serverless云函数处理图片.md',scope:'对象存储事件驱动的通用架构；图片核心示例使用 Node.js 与 sharp，云 SDK 适配点单独说明',
replace:[['不要让客户端把大文件先传到业务服务器再转发。更合理的链路是：','当业务允许客户端直传且希望减少中转带宽时，可以采用下面链路；需要同步审查或特殊网络控制时，服务端中转仍可能合理：'],['凭证应限制有效期、对象前缀、大小和 Content-Type。','凭证应限制有效期和对象范围；Content-Type、大小等约束是否能由签名策略强制执行取决于具体上传方式，上传后仍须检查实际对象和解码结果。']],
body:`## 上传完成之后还有一条可靠处理链

业务记录应在签发上传凭证时创建，保存租户、源对象键、预期用途和处理版本。客户端上传成功只是对象到达存储，图片可能仍然无效、过大或等待处理。前端应查询业务状态，而不是把对象存储返回 200 直接等价为图片可使用。

对象存储事件通常需要按可重复、可能乱序的方式处理。以 AWS 为例，[S3 与 Lambda 集成文档](https://docs.aws.amazon.com/lambda/latest/dg/with-s3.html)说明了事件触发以及写回同一桶可能造成循环的问题。其他云厂商的事件字段、重试策略和确认方式各不相同，不能把通用伪代码当作真实 SDK 事件结构。

## 原图与结果必须隔离

可以使用 originals/ 和 derived/ 前缀，只让 originals/ 的创建事件触发函数。更强隔离可以使用不同桶与权限。结果对象键应包含源对象身份和处理配方版本，例如 sourceVersion/recipe-v3/thumbnail.webp。这样升级压缩质量或尺寸后，不会让旧缓存继续返回同一个 URL 下的旧字节。

同一个对象键被覆盖时，只以 key 作为幂等键不够，因为它可能对应不同版本的源图。优先使用对象版本号或可靠事件身份，再结合 recipe version。ETag 不应被普遍当作内容 MD5，分段上传和存储配置可能改变其含义。需要内容哈希时应明确计算算法与读取成本。

## 幂等不是先查有没有结果文件

两个函数实例可能同时看到文件不存在，随后都开始解码。目标键固定可以让最终内容收敛，却不防重复计算和重复计费，也不保护“结果状态已成功但对象未完整生成”的窗口。应使用条件创建的任务记录、租约或数据库唯一键，让并发执行只有一个获得处理权。

~~~sql
CREATE TABLE image_job (
  tenant_id VARCHAR(64) NOT NULL,
  source_key VARCHAR(512) NOT NULL,
  source_version VARCHAR(128) NOT NULL,
  recipe_version VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL,
  owner_token VARCHAR(64) NULL,
  lease_until TIMESTAMP NULL,
  output_key VARCHAR(512) NULL,
  attempts INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL,
  PRIMARY KEY (tenant_id,source_key,source_version,recipe_version)
);
~~~

字段长度与字符集会影响 MySQL 索引长度，这里是逻辑表结构示意；真实部署可用固定长度的身份摘要作为主键，并保留原始字段用于审计和碰撞核验。租约释放与完成更新应比较 owner_token，防止超时旧实例覆盖新实例的状态。已经生成但尚未写成功状态的结果可以在重试时核验并复用。

## 文件大小和像素大小是两道限制

一个压缩后只有几 MB 的文件可能解码成数亿像素。RGBA 原始像素大约需要 width×height×4 字节，处理库还可能分配额外缓冲。动画包含多帧，单帧尺寸合法也可能总工作量过大。入口先限制对象字节数，下载时再限制实际读取字节，解码器再限制像素与页数，不能只检查扩展名。

SVG 不是普通的被动像素容器，可能包含外部资源和复杂渲染行为。若业务只需要用户头像，可以直接不接受 SVG 与动画，缩小攻击和兼容面。文件名、Content-Type 和真实文件头要交叉验证，识别后重新编码输出，而不是把不可信文件直接公开。

## 核心转换函数

下面代码只负责已受控下载的 Buffer 转换，云事件解析、对象下载、任务认领和上传由外层适配。sharp 的输入限制与选项依据[构造器文档](https://sharp.pixelplumbing.com/api-constructor/)核对，依赖与原生运行库应在云函数目标架构中打包验证。

~~~javascript
import sharp from 'sharp';

const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);

export async function makeThumbnail(source) {
  if (!Buffer.isBuffer(source)) throw new TypeError('source must be a Buffer');
  if (source.length === 0 || source.length > MAX_SOURCE_BYTES) {
    throw new Error('SOURCE_SIZE_REJECTED');
  }
  const inputOptions = {
    limitInputPixels: MAX_PIXELS,
    failOn: 'warning',
    animated: false
  };
  const metadata = await sharp(source, inputOptions).metadata();
  if (!ALLOWED_FORMATS.has(metadata.format)) {
    throw new Error('FORMAT_REJECTED');
  }
  if ((metadata.pages ?? 1) !== 1) throw new Error('ANIMATION_REJECTED');
  if (!metadata.width || !metadata.height ||
      metadata.width * metadata.height > MAX_PIXELS) {
    throw new Error('PIXEL_LIMIT_REJECTED');
  }
  const { data, info } = await sharp(source, inputOptions)
    .rotate()
    .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80, effort: 4 })
    .toBuffer({ resolveWithObject: true });
  if (info.width > 800 || info.height > 800 || data.length === 0) {
    throw new Error('OUTPUT_VALIDATION_FAILED');
  }
  return {
    bytes: data,
    contentType: 'image/webp',
    width: info.width,
    height: info.height,
    size: data.length
  };
}
~~~

rotate 用于按输入方向信息自动校正，输出尺寸应按校正后的图像验证。默认不保留所有源元数据通常有助于去除不必要的定位信息，但具体元数据行为仍按锁定版本测试。带透明通道的 PNG 转 WebP 时要验证透明边缘；若改为 JPEG，需要明确背景填充色，不能让透明区域意外变黑。

调用前把完整对象下载到内存仍然可能占较多资源，所以对象下载适配器必须有字节上限与超时，不能仅检查事件声称的 size。批事件也不要无界 Promise.all 同时处理数百张大图。把单实例并发控制在经过测量的水平，避免函数内存因并发解码成倍增长。

## 外层处理流程

~~~javascript
// storage、jobs、events 是项目适配器；下面是控制流伪代码。
export async function processImageEvent(event) {
  const source = events.parseAndValidate(event);
  if (!source.key.startsWith('originals/')) return { ignored: true };
  const identity = jobs.identity(source, 'thumbnail-v3');
  const claim = await jobs.tryClaim(identity);
  if (!claim.acquired) return { duplicateOrBusy: true };
  try {
    const bytes = await storage.readBounded(source, MAX_SOURCE_BYTES);
    const result = await makeThumbnail(bytes);
    const outputKey = jobs.outputKey(identity);
    await storage.putCompleteObject(outputKey, result.bytes, result.contentType);
    await jobs.markSuccessIfOwner(identity, claim.ownerToken, outputKey, result);
    return { completed: true };
  } catch (failure) {
    await jobs.recordFailureIfOwner(identity, claim.ownerToken, failure);
    throw failure;
  }
}
~~~

拒绝非法图片属于不可重试业务失败，应记录明确原因并按事件系统语义结束处理；网络超时或存储暂时错误才进入有限重试。上面的外层片段将失败统一抛出以展示失败传播，生产适配器必须补充分型，否则坏文件会被平台重复执行到最大重试次数。批量事件是否支持部分失败也要按云厂商能力处理。

## 性能与成本一起量

记录下载、元数据解析、解码缩放、编码、上传和状态更新的分段耗时。提高内存配置可能同时获得更多 CPU，运行更快并降低总计费时间，不能只看每 GB 秒单价。冷启动、原生库加载、跨区域流量和对象存储请求同样影响成本。

质量 80 不代表对所有图片都最优，文字截图、照片、透明图标需要不同质量评估。可以建立固定样本集，比较尺寸、视觉质量和处理时长，再决定配方。输出 URL 带配方版本后，回滚就是切回旧版本结果，而不是在同一个 Key 下不断覆盖并清缓存。

## 前端状态与人工恢复

状态建议区分 UPLOADING、QUEUED、PROCESSING、SUCCEEDED、REJECTED、RETRYABLE_FAILED、FAILED。前端展示进度或可重试提示，不要在未成功前缓存结果 404。下载和查看接口仍要验证租户与对象归属，预签名 URL 是短期访问能力，不应无限期共享。

死信记录应包含源对象版本、配方、最后错误和尝试次数，避免把完整私有 URL 或凭证写入日志。人工重试使用同一个业务身份或显式新配方，不应无条件创建第二份业务记录。保留源图多久也需要策略：它关系到重新生成、申诉、成本和隐私删除，不能仅由存储默认生命周期决定。`,
lab:'准备 JPEG 方向样本、透明 PNG、动画、损坏文件和超像素图片。所有样本使用测试桶，验收同时记录对象、任务状态和输出尺寸，避免只看函数返回成功。',
cases:[
['IMG-01','正常缩略图','有效单帧 JPEG 在字节与像素限制内','生成 800 像素边界的 WebP','输出非空、尺寸合规且视觉内容完整','业务结果需要验证实际解码与输出而不是只判断函数未抛错'],
['IMG-02','重复事件','同一源版本和配方被投递两次','并发认领任务','只有约定执行者处理，结果和状态可复用','事件系统重复投递要求条件写而不是先查后写'],
['IMG-03','源对象覆盖','对象键不变但版本变化','再次触发处理','生成对应新版本结果而不错误命中旧幂等记录','对象键不一定唯一标识一份不可变内容'],
['IMG-04','伪造 Content-Type','载荷不是图片但扩展名为 jpg','执行文件识别与转换','明确拒绝且不公开原始载荷','文件名与请求头不是可信内容证明'],
['IMG-05','超像素输入','压缩字节不大但解码像素超过阈值','运行受限解码','在受控资源范围拒绝','压缩大小无法代表解码内存需求'],
['IMG-06','动画输入','文件有多帧但单帧大小合法','按头像单帧策略处理','明确拒绝或按单独产品规则处理','总帧数会扩大工作量，不能只看宽高'],
['IMG-07','EXIF 方向','样本通过方向标签表达旋转','转换并检查视觉方向','输出方向正确且尺寸按旋转后计算','元数据方向与像素排列不一定一致'],
['IMG-08','透明背景','PNG 边缘包含透明像素','转换 WebP 后在深浅底色检查','透明边缘符合视觉要求','格式转换除了尺寸还有 alpha 与颜色语义'],
['IMG-09','上传后状态失败','结果对象已写入但状态提交失败','重试同一任务并核验已有结果','最终状态可恢复且不产生错误重复业务记录','对象存储与状态库之间不是一个本地事务'],
['IMG-10','递归触发','函数将结果写回对象存储','观察事件过滤范围','derived 输出不会再次触发相同处理','触发前缀与输出位置隔离可避免处理循环'],
['IMG-11','批量内存压力','事件批次含多张大图','按有界并发处理并测峰值','不会因无界同时解码耗尽内存','函数内并发会乘上单图缓冲成本'],
['IMG-12','死信恢复','暂时失败超过重试上限','修复依赖后从死信重新驱动','保留身份与配方，最终结果可追溯','人工恢复也必须遵守幂等与状态所有权']
],end:'## 把函数当作可靠工作者\n\nServerless 提供弹性执行环境，可靠性来自不可变源身份、受控解码、条件认领、分型重试和可查询状态。把这些边界独立出来后，切换云厂商或图片库通常只影响适配层，而不需要重写整个业务流程。',refs:[['AWS：S3 事件与 Lambda','https://docs.aws.amazon.com/lambda/latest/dg/with-s3.html'],['sharp 输入限制与构造器','https://sharp.pixelplumbing.com/api-constructor/']]},
{
file:'html动态渲染并转出PDF.md',scope:'受信任模板生成 HTML，使用 Playwright Chromium 渲染；外部 URL 与任意用户 HTML 需要额外网络隔离',
replace:[['简单静态 HTML：可以使用 wkhtmltopdf 等传统工具；','既有静态模板：可评估已有传统转换工具的维护状态和 CSS 能力，新项目不要忽略其浏览器内核与维护限制；'],['LoadState.NETWORKIDLE','WaitUntilState.DOMCONTENTLOADED'],['table, tr, img {','tr, img {']],
body:`## PDF 是一份应当可重建的业务快照

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

生产排查应保存脱敏的输入快照摘要、模板版本、浏览器版本、字体清单、控制台错误与失败截图。敏感完整合同不宜无期限存入普通日志。固定环境后仍要在浏览器或字体升级时做回归，因为分页算法与字形度量变化都可能改变总页数。`,
lab:'以固定订单数据生成零行、单页和多页样本，检查文本、页数与页面截图。示例是渲染核心，不附虚构的性能数字；实际并发上限应以目标容器资源测量。',
cases:[
['PDF-01','中文字体','镜像包含约定中文字体','渲染包含中文、生僻字和英文的模板','字形可见且没有方框或意外替代','fonts.ready 只证明加载状态，不证明全部字符视觉正确'],
['PDF-02','特殊字符','订单名称包含尖括号、引号和与号','经过模板转义后渲染','文本原样展示且不成为 HTML 结构','输入转义保护模板边界与页面语义'],
['PDF-03','多页表格','明细超过一页','导出并逐页检查表头和行内容','表头按需求重复，行无不可接受截断','分页正确性需要实际页面验证'],
['PDF-04','超长行','单条备注高度超过一页','按长文本策略渲染','拆分或限制行为明确，没有静默丢内容','break-inside 不能无条件满足大于页面的元素'],
['PDF-05','图片失败','样本包含无法解码图片','等待解码后尝试导出','任务明确失败或使用约定占位图','网络或 DOM 完成不代表图片已经可打印'],
['PDF-06','异步页面完成','另一模板需要脚本绘制图表','以业务标记等待并限制总时间','图表完整后才导出，超时有明确错误','固定 sleep 与 networkidle 不构成业务就绪证明'],
['PDF-07','内网资源访问','输入尝试引用未授权地址','在网络隔离和路由策略下渲染','请求被阻止且不能读取内部服务','浏览器渲染服务不能成为任意网络访问代理'],
['PDF-08','并发内存压力','多个长文档同时排队','逐步增加受控并发并记录峰值','并发和队列有上限，超载任务被可控处理','浏览器 context 隔离不等于资源成本为零'],
['PDF-09','浏览器崩溃','任务处于 PROCESSING','终止测试浏览器并触发恢复','资源释放、租约可恢复且任务不会永久悬挂','异步状态机需要覆盖执行进程消失'],
['PDF-10','重复生成','同一订单版本和模板被请求两次','按任务身份认领或复用结果','不会产生互相冲突的业务文件记录','可重建身份应包含所有影响输出的关键版本'],
['PDF-11','模板升级','保持订单数据不变只升级模板或字体','进行文本和视觉回归','差异可解释且金额、页数等硬约束通过','渲染环境变化会影响布局，不能只测接口返回 200'],
['PDF-12','下载越权','用户获得其他租户的文件 ID','调用下载接口或申请签名 URL','授权检查拒绝','文件已经生成不意味着任何知道地址的人都可读取']
],end:'## 稳定输出的基础\n\nHTML 转 PDF 应以固定数据快照、受控资源、明确完成条件和可回归的页面样本为基础。把浏览器当成需要隔离与监督的工作进程，才能让导出功能在长文档、异常输入和并发任务下持续可靠。',refs:[['Playwright page.pdf','https://playwright.dev/docs/api/class-page#page-pdf'],['本地延伸：图片处理','使用Serverless云函数处理图片.md']]}
];
for(const a of articles)console.log(writeArticle(a));
