# 使用 Serverless 云函数处理图片

图片上传、缩略图生成、格式转换和内容审核都属于计算密集型或突发型任务。把这些任务放进 Serverless 云函数，可以按调用量付费，并且不需要长期维护一组专门的图片处理服务器。

## 一、推荐的整体架构

不要让客户端把大文件先传到业务服务器再转发。更合理的链路是：

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

## 二、使用预签名 URL 上传

典型流程如下：

1. 客户端向业务服务申请上传凭证，并提交文件名、大小、业务类型；
2. 业务服务校验登录身份和文件类型，生成唯一对象键；
3. 客户端使用短期 URL 直接上传对象存储；
4. 上传完成后回调业务服务，或由对象存储事件触发函数；
5. 业务服务通过对象键查询处理状态。

对象键不要直接使用用户传入的文件名，建议使用租户、业务 ID、随机值和扩展名组合。凭证应限制有效期、对象前缀、大小和 Content-Type。

## 三、函数处理逻辑

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

## 四、超时、内存与临时目录

图片处理的内存和 CPU 往往影响最大。应使用真实图片样本压测不同尺寸，记录下载、解码、处理和上传分别耗时。函数临时目录通常有大小上限，处理大图时要避免一次性加载多个原图。

如果单个文件处理时间超过函数上限，可以把任务拆成队列消息，或改用容器任务、批处理作业。Serverless 适合短时、可重试、可水平扩展的任务，不适合无限时长的交互式处理。

## 五、安全边界

文件扩展名和 Content-Type 都不能作为唯一的安全判断依据。处理前要读取文件头，限制像素数量，防止压缩炸弹和超大图片耗尽内存；对 SVG、带脚本的图片和外部资源引用应单独限制。原图和结果图的访问权限也要分开，公开访问时使用 CDN 和防盗链。

函数权限采用最小化原则：只允许读指定原图前缀、写指定结果前缀和更新必要的状态表，不要给函数整个对象存储桶的删除权限。

## 六、失败重试与状态机

建议为业务记录设计明确状态：`UPLOADING`、`PROCESSING`、`SUCCESS`、`FAILED`。函数失败时保留可重试原因和次数，采用指数退避；超过重试上限后进入死信或人工处理队列。

“上传成功”不等于“图片处理成功”。前端展示时应根据处理状态决定是否展示结果 URL，避免在函数尚未完成时缓存一个不存在的地址。

## 七、成本与可观测性

记录函数版本、请求 ID、对象键、处理时长、内存使用、重试次数和结果状态。监控冷启动、错误率、超时率和队列积压。成本优化通常来自缩短下载链路、减少重复处理、合理选择图片格式和设置生命周期规则，而不是简单降低函数内存。

## 总结

Serverless 图片处理的关键是“对象存储直传、事件异步触发、处理幂等、状态可追踪、安全最小权限”。先把业务流程和失败路径设计清楚，再选择具体云厂商的函数、存储和图片处理组件，迁移成本会更低。
