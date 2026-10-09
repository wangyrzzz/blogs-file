# Loki 日志系统：作为 ELK 的轻量替代方案

ELK 通过 Elasticsearch 建立全文索引，能力强但资源和运维成本较高。Loki 的设计思路是尽量少索引日志正文，只索引少量标签，把日志内容压缩后存储，再通过 LogQL 按标签和文本过滤。它特别适合已经使用 Grafana、Prometheus 的团队。

## 一、Loki 与 ELK 的差异

| 维度 | Loki | ELK |
| --- | --- | --- |
| 核心索引 | 主要索引标签 | 通常对字段和正文建立索引 |
| 查询方式 | LogQL，先按标签缩小范围 | KQL/Lucene 等全文检索 |
| 资源成本 | 一般较低，适合日志聚合 | 能力强但集群成本较高 |
| 适合场景 | 按服务、环境、TraceId 查日志 | 复杂全文检索、丰富字段分析 |
| 运维生态 | Grafana、对象存储 | Elasticsearch、Kibana、Logstash |

Loki 并不是“完全不需要索引”，标签设计不合理同样会造成查询慢和索引膨胀。不要把用户 ID、订单号等高基数字段全部放进标签。

## 二、基本架构

```text
应用日志 -> Agent/Collector -> Loki Distributor
                                  -> Ingester -> 对象存储
Grafana  -> Query Frontend -> Querier -> Loki
```

采集器负责读取容器标准输出或文件并附加标签。生产环境可根据平台选择 Grafana Alloy、Promtail 或其他 OpenTelemetry Collector；具体组件版本应以当前部署方案为准。

## 三、日志输出建议

应用最好输出一行一条的结构化 JSON：

```json
{
  "time":"2026-09-14T10:00:00.123+08:00",
  "level":"INFO",
  "service":"order-service",
  "traceId":"abc123",
  "message":"order created",
  "orderId":"O10001"
}
```

服务名、环境、集群和容器等低基数信息适合做标签；TraceId、订单号更适合留在日志正文或结构化字段中。这样既能按服务定位，也不会为每个业务值创建一组标签流。

## 四、LogQL 查询

按标签筛选并搜索正文：

```logql
{namespace="prod", app="order-service"} |= "timeout"
```

查询某个 TraceId：

```logql
{app="order-service"} | json | traceId="abc123"
```

统计错误率：

```logql
sum by (app) (count_over_time({namespace="prod"} |= "ERROR" [5m]))
```

复杂解析、正则和超长时间范围查询会消耗较多资源，应先用服务和时间范围缩小数据，再进行字段过滤。

## 五、存储和保留策略

日志需要设置保留期、压缩、对象存储生命周期和查询缓存。开发环境保留时间可以很短，生产审计日志则应按合规要求单独存储。Loki 的数据可靠性取决于副本、对象存储和 WAL 配置，不能只看 Grafana 页面是否能打开。

## 六、迁移步骤

1. 梳理现有日志格式和查询习惯；
2. 统一服务名、环境和 TraceId 字段；
3. 选少量服务双写或并行采集；
4. 把常用 Kibana 查询改写成 LogQL；
5. 对查询耗时、存储量、丢日志率和告警结果做对比；
6. 验证完成后再缩减 ELK 流量，不要一开始就删除旧数据。

## 七、常见坑

- 为每个请求参数创建 Loki 标签，导致流数量爆炸；
- 把多行堆栈拆成多个无关联日志，难以恢复异常上下文；
- 只采集容器日志，不保留容器重启前的缓冲和错误日志；
- 无限制查询全量时间范围，拖慢查询节点；
- 未做访问控制，导致日志中的敏感信息被任意读取。

## 总结

Loki 的优势在于用低成本完成“按服务、环境、TraceId 定位问题”的日志能力。它是否适合替代 ELK，取决于团队是否需要复杂全文检索、聚合分析和合规能力。先调整日志格式和标签，再比较真实查询与成本，决策会更可靠。
