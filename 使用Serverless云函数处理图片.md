# 使用 Serverless 云函数处理图片

> 阅读范围：对象存储事件驱动的通用架构；图片核心示例使用 Node.js 与 sharp，云 SDK 适配点单独说明。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


图片上传、缩略图生成、格式转换和内容审核都属于计算密集型或突发型任务。把这些任务放进 Serverless 云函数，可以按调用量付费，并且不需要长期维护一组专门的图片处理服务器。

## 推荐的整体架构

当业务允许客户端直传且希望减少中转带宽时，可以采用下面链路；需要同步审查或特殊网络控制时，服务端中转仍可能合理：

```text
客户端 -> 获取临时上传凭证 -> 对象存储
                              |
                              -> 事件触发云函数
                                  -> 校验图片
                                  -> 生成缩略图/转换格式
                                  -> 写回对象存储
                                  -> 更新业务状态
```

业务服务只负责签发短期上传凭证、保存业务记录和查询处理结果。原图、处理图和临时文件放在对象存储中，避免占用应用容器磁盘。

## 使用预签名 URL 上传

典型流程如下：

1. 客户端向业务服务申请上传凭证，并提交文件名、大小、业务类型；
2. 业务服务校验登录身份和文件类型，生成唯一对象键；
3. 客户端使用短期 URL 直接上传对象存储；
4. 上传完成后回调业务服务，或由对象存储事件触发函数；
5. 业务服务通过对象键查询处理状态。

对象键不要直接使用用户传入的文件名，建议使用租户、业务 ID、随机值和扩展名组合。凭证应限制有效期和对象范围；Content-Type、大小等约束是否能由签名策略强制执行取决于具体上传方式，上传后仍须检查实际对象和解码结果。

## 函数处理逻辑

下面是与具体云厂商无关的伪代码：

```javascript
export async function handler(event) {
  for (const record of event.objects) {
    const objectKey = record.key;
    if (!isAllowedImage(objectKey, record.contentType, record.size)) {
      await markFailed(objectKey, 'unsupported image');
      continue;
    }

    const source = await storage.get(objectKey);
    const metadata = await image.readMetadata(source);
    if (metadata.width > 10000 || metadata.height > 10000) {
      await markFailed(objectKey, 'image is too large');
      continue;
    }

    const thumbnail = await image.resize(source, { width: 800, format: 'webp' });
    await storage.put(`${objectKey}/thumbnail.webp`, thumbnail);
    await markSucceeded(objectKey);
  }
}
```

真实实现应使用云厂商提供的事件结构和 SDK。函数要支持重复触发：处理前先检查目标对象或业务状态，使用对象版本号、事件 ID 或幂等记录防止重复生成。

## 超时、内存与临时目录

图片处理的内存和 CPU 往往影响最大。应使用真实图片样本压测不同尺寸，记录下载、解码、处理和上传分别耗时。函数临时目录通常有大小上限，处理大图时要避免一次性加载多个原图。

如果单个文件处理时间超过函数上限，可以把任务拆成队列消息，或改用容器任务、批处理作业。Serverless 适合短时、可重试、可水平扩展的任务，不适合无限时长的交互式处理。

## 安全边界

文件扩展名和 Content-Type 都不能作为唯一的安全判断依据。处理前要读取文件头，限制像素数量，防止压缩炸弹和超大图片耗尽内存；对 SVG、带脚本的图片和外部资源引用应单独限制。原图和结果图的访问权限也要分开，公开访问时使用 CDN 和防盗链。

函数权限采用最小化原则：只允许读指定原图前缀、写指定结果前缀和更新必要的状态表，不要给函数整个对象存储桶的删除权限。

## 失败重试与状态机

建议为业务记录设计明确状态：`UPLOADING`、`PROCESSING`、`SUCCESS`、`FAILED`。函数失败时保留可重试原因和次数，采用指数退避；超过重试上限后进入死信或人工处理队列。

“上传成功”不等于“图片处理成功”。前端展示时应根据处理状态决定是否展示结果 URL，避免在函数尚未完成时缓存一个不存在的地址。

## 成本与可观测性

记录函数版本、请求 ID、对象键、处理时长、内存使用、重试次数和结果状态。监控冷启动、错误率、超时率和队列积压。成本优化通常来自缩短下载链路、减少重复处理、合理选择图片格式和设置生命周期规则，而不是简单降低函数内存。


## 上传完成之后还有一条可靠处理链

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

死信记录应包含源对象版本、配方、最后错误和尝试次数，避免把完整私有 URL 或凭证写入日志。人工重试使用同一个业务身份或显式新配方，不应无条件创建第二份业务记录。保留源图多久也需要策略：它关系到重新生成、申诉、成本和隐私删除，不能仅由存储默认生命周期决定。

## 故障注入与验收实验

准备 JPEG 方向样本、透明 PNG、动画、损坏文件和超像素图片。所有样本使用测试桶，验收同时记录对象、任务状态和输出尺寸，避免只看函数返回成功。

### IMG-01：正常缩略图

实验前提是有效单帧 JPEG 在字节与像素限制内。执行生成 800 像素边界的 WebP。

通过条件是输出非空、尺寸合规且视觉内容完整。这里的判断依据是业务结果需要验证实际解码与输出而不是只判断函数未抛错。

### IMG-02：重复事件

实验前提是同一源版本和配方被投递两次。执行并发认领任务。

通过条件是只有约定执行者处理，结果和状态可复用。这里的判断依据是事件系统重复投递要求条件写而不是先查后写。

### IMG-03：源对象覆盖

实验前提是对象键不变但版本变化。执行再次触发处理。

通过条件是生成对应新版本结果而不错误命中旧幂等记录。这里的判断依据是对象键不一定唯一标识一份不可变内容。

### IMG-04：伪造 Content-Type

实验前提是载荷不是图片但扩展名为 jpg。执行文件识别与转换。

通过条件是明确拒绝且不公开原始载荷。这里的判断依据是文件名与请求头不是可信内容证明。

### IMG-05：超像素输入

实验前提是压缩字节不大但解码像素超过阈值。执行运行受限解码。

通过条件是在受控资源范围拒绝。这里的判断依据是压缩大小无法代表解码内存需求。

### IMG-06：动画输入

实验前提是文件有多帧但单帧大小合法。执行按头像单帧策略处理。

通过条件是明确拒绝或按单独产品规则处理。这里的判断依据是总帧数会扩大工作量，不能只看宽高。

### IMG-07：EXIF 方向

实验前提是样本通过方向标签表达旋转。执行转换并检查视觉方向。

通过条件是输出方向正确且尺寸按旋转后计算。这里的判断依据是元数据方向与像素排列不一定一致。

### IMG-08：透明背景

实验前提是PNG 边缘包含透明像素。执行转换 WebP 后在深浅底色检查。

通过条件是透明边缘符合视觉要求。这里的判断依据是格式转换除了尺寸还有 alpha 与颜色语义。

### IMG-09：上传后状态失败

实验前提是结果对象已写入但状态提交失败。执行重试同一任务并核验已有结果。

通过条件是最终状态可恢复且不产生错误重复业务记录。这里的判断依据是对象存储与状态库之间不是一个本地事务。

### IMG-10：递归触发

实验前提是函数将结果写回对象存储。执行观察事件过滤范围。

通过条件是derived 输出不会再次触发相同处理。这里的判断依据是触发前缀与输出位置隔离可避免处理循环。

### IMG-11：批量内存压力

实验前提是事件批次含多张大图。执行按有界并发处理并测峰值。

通过条件是不会因无界同时解码耗尽内存。这里的判断依据是函数内并发会乘上单图缓冲成本。

### IMG-12：死信恢复

实验前提是暂时失败超过重试上限。执行修复依赖后从死信重新驱动。

通过条件是保留身份与配方，最终结果可追溯。这里的判断依据是人工恢复也必须遵守幂等与状态所有权。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "使用Serverless云函数处理图片",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "IMG-01",
      "scenario": "正常缩略图",
      "given": "有效单帧 JPEG 在字节与像素限制内",
      "when": "生成 800 像素边界的 WebP",
      "then": "输出非空、尺寸合规且视觉内容完整"
    },
    {
      "id": "IMG-02",
      "scenario": "重复事件",
      "given": "同一源版本和配方被投递两次",
      "when": "并发认领任务",
      "then": "只有约定执行者处理，结果和状态可复用"
    },
    {
      "id": "IMG-03",
      "scenario": "源对象覆盖",
      "given": "对象键不变但版本变化",
      "when": "再次触发处理",
      "then": "生成对应新版本结果而不错误命中旧幂等记录"
    },
    {
      "id": "IMG-04",
      "scenario": "伪造 Content-Type",
      "given": "载荷不是图片但扩展名为 jpg",
      "when": "执行文件识别与转换",
      "then": "明确拒绝且不公开原始载荷"
    },
    {
      "id": "IMG-05",
      "scenario": "超像素输入",
      "given": "压缩字节不大但解码像素超过阈值",
      "when": "运行受限解码",
      "then": "在受控资源范围拒绝"
    },
    {
      "id": "IMG-06",
      "scenario": "动画输入",
      "given": "文件有多帧但单帧大小合法",
      "when": "按头像单帧策略处理",
      "then": "明确拒绝或按单独产品规则处理"
    },
    {
      "id": "IMG-07",
      "scenario": "EXIF 方向",
      "given": "样本通过方向标签表达旋转",
      "when": "转换并检查视觉方向",
      "then": "输出方向正确且尺寸按旋转后计算"
    },
    {
      "id": "IMG-08",
      "scenario": "透明背景",
      "given": "PNG 边缘包含透明像素",
      "when": "转换 WebP 后在深浅底色检查",
      "then": "透明边缘符合视觉要求"
    },
    {
      "id": "IMG-09",
      "scenario": "上传后状态失败",
      "given": "结果对象已写入但状态提交失败",
      "when": "重试同一任务并核验已有结果",
      "then": "最终状态可恢复且不产生错误重复业务记录"
    },
    {
      "id": "IMG-10",
      "scenario": "递归触发",
      "given": "函数将结果写回对象存储",
      "when": "观察事件过滤范围",
      "then": "derived 输出不会再次触发相同处理"
    },
    {
      "id": "IMG-11",
      "scenario": "批量内存压力",
      "given": "事件批次含多张大图",
      "when": "按有界并发处理并测峰值",
      "then": "不会因无界同时解码耗尽内存"
    },
    {
      "id": "IMG-12",
      "scenario": "死信恢复",
      "given": "暂时失败超过重试上限",
      "when": "修复依赖后从死信重新驱动",
      "then": "保留身份与配方，最终结果可追溯"
    }
  ]
}
```

## 任务完成与发布结果应分成两步

假设一张商品主图需要生成列表缩略图、详情大图和分享卡片。三个输出分别完成时，不能仅凭第一个文件上传成功就把整项任务标记为可用。可以先给每个变体记录独立结果，再由发布步骤验证必需变体齐全，最后原子更新业务记录中的结果清单。前端只读取已发布的清单，便不会遇到部分页面显示新图、另一些页面引用尚未生成文件的情况。

结果清单至少保存源版本、配方版本、各变体对象键、实际宽高、字节数和内容类型。生成阶段使用不可变对象键，发布阶段只切换一条业务引用。这样计算与可见性解耦：任务失败可以继续补齐缺失变体，业务仍使用上一版完整结果；配方回滚也不必覆盖同一批文件。若某个变体是可选项，应在清单中明确缺失原因和替代规则，不能让调用者根据文件是否存在猜测任务状态。

租约到期后的旧工作者还可能完成上传，因此仅保护数据库状态不足以保护共享输出。设计输出键时，可以把尝试身份纳入暂存路径，再由持有当前所有权的工作者发布清单；或者在存储能力允许时使用受版本条件约束的写入。前者会产生未被引用的临时文件，需要后台回收，但能避免旧尝试覆盖新尝试。回收只处理超出保护窗口且未被任何有效清单引用的对象，不能在任务仍可能重试时按创建时间直接删除。

## 删除操作必须阻止后续重试重新发布

用户删除图片时，正在执行的云函数不会因为数据库记录被删而自动停止。若只删除对象，稍后的重试可能再次上传结果；若只删除业务记录，原图和衍生图又可能继续占用存储或被既有链接访问。因此删除应作为状态机中的正式事件处理：先记录删除标记或资源代次，使认领与发布步骤都拒绝旧代次；再异步清理源对象、派生对象以及不再引用的暂存对象。

删除标记的保留窗口要覆盖事件延迟、死信重放和人工补偿窗口。否则标记过早消失后，一条旧事件可能被误认为新任务。为同一业务位置重新上传图片时生成新的资源身份，不要复用被删除版本的任务键。对于 CDN、版本化对象和备份，分别定义失效与保留方式，因为删除当前业务引用不能等价于所有副本立即消失。这里的重点是让产品承诺、存储策略和实际处理链保持一致。

## 用队列容量控制突发流量

图片任务的到达速率与处理能力不匹配时，弹性扩容仍可能受到下游下载带宽、数据库连接数或租户配额限制。可以先测量代表性图片的平均处理时间与较慢分位，再估算所需并发。假设隔离测试中每秒到达二十张图，单张平均耗时半秒，那么仅从平均工作量计算，约十个同时处理的工作槽才能跟上到达速率；这只是容量估算，尚未包含冷启动、长尾、大图和失败重试的余量。

生产监控除了队列长度，还应关注最老任务年龄。队列里一百张普通小图与一百张超大图的工作量不同，只按条数扩容容易判断失真。可以按用途或尺寸分队列，让头像任务不必排在大型海报后面；也可以按租户设置并发预算，避免单个批量导入占满全部工作槽。被延后的任务保持排队状态，并给用户合理的等待提示，不能反复触发同一任务制造更多竞争。

压测时应固定输入样本和配方，分别改变函数资源与并发上限，记录单位成功图片的总成本。将对象请求、出口流量、重试和长期结果存储纳入计算，才能识别真正昂贵的环节。如果下载已经成为瓶颈，增加编码线程未必提高吞吐；如果失败来自数据库连接耗尽，继续增加函数实例可能让成功率更低。

## 把函数当作可靠工作者

Serverless 提供弹性执行环境，可靠性来自不可变源身份、受控解码、条件认领、分型重试和可查询状态。把这些边界独立出来后，切换云厂商或图片库通常只影响适配层，而不需要重写整个业务流程。

## 参考资料与继续阅读

- [AWS：S3 事件与 Lambda](https://docs.aws.amazon.com/lambda/latest/dg/with-s3.html)
- [sharp 输入限制与构造器](https://sharp.pixelplumbing.com/api-constructor/)
