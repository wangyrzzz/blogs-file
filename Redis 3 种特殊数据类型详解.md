# Redis 3 种特殊数据类型详解

> 阅读范围：Bitmap、HyperLogLog 与 GEO 的建模和容量分析；GEOSEARCH 需 Redis 6.2 或以上。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


除了 String、List、Hash、Set 和 Sorted Set 这 5 种常用类型，Redis 还提供了 Bitmap、HyperLogLog 和 GEO 等特殊能力。它们并不都是独立的底层类型：Bitmap 基于 String 的位操作，GEO 基于 Sorted Set 的编码结果，HyperLogLog 则是一种概率统计结构。

## Bitmap：用位保存状态

Bitmap 把一个 String 当作位数组，每个 offset 只保存 0 或 1。适合记录用户签到、是否点赞、设备在线标记等二值状态。

```redis
SETBIT sign:2026-09-14 1001 1
GETBIT sign:2026-09-14 1001
BITCOUNT sign:2026-09-14
```

相关命令还有 `BITOP AND|OR|XOR|NOT`。Bitmap 的空间优势来自一个 bit 表示一个状态，但 offset 很大且稀疏时，仍可能产生较大的中间空间，设计 Key 和 offset 时要评估范围。

### 使用注意

- 明确 offset 与用户 ID 的映射，避免不同业务复用同一位图；
- 按日期或业务周期拆分 Key，避免单个 Key 无限增长；
- `BITCOUNT` 统计置位数量；当每个用户唯一对应一个 offset 时，它可以表示该范围内精确去重人数；
- 对敏感业务状态设置过期或归档策略。

## HyperLogLog：估算基数

HyperLogLog 用很小的内存估算集合中不同元素的数量，标准误差约为 0.81%。它只返回近似值，不保存可枚举的原始成员，因此不能回答“哪些用户访问过”。

```redis
PFADD uv:2026-09-14 user-1 user-2 user-3
PFCOUNT uv:2026-09-14
PFMERGE uv:week uv:2026-09-08 uv:2026-09-09 uv:2026-09-10
```

适合统计网站 UV、活动参与人数等数量级较大且允许误差的指标，不适合余额、库存或需要精确名单的场景。对多个 HLL 做合并时，要确认时间范围和业务维度没有重复计算问题。

## GEO：地理空间索引

GEO 用经纬度表示成员位置，Redis 会把地理编码写入 Sorted Set 的 score，从而支持距离计算和附近搜索。

```redis
GEOADD store:locations 116.397 39.908 store-1
GEOSEARCH store:locations FROMLONLAT 116.40 39.90 BYRADIUS 5 km ASC COUNT 20
GEODIST store:locations store-1 store-2 km
```

旧版本常见的 `GEORADIUS` 和 `GEORADIUSBYMEMBER` 在较新 Redis 中已经由 `GEOSEARCH` 等命令取代，具体支持情况应以部署版本为准。

### 经纬度限制

经度范围约为 `-180` 到 `180`，纬度范围约为 `-85.05112878` 到 `85.05112878`。输入顺序是“经度、纬度”，写反后结果可能看起来正常但位置完全错误。

GEO 适合附近门店、附近设备和配送范围查询，不是完整的 GIS 系统。复杂多边形、道路距离、坐标纠偏和海量历史轨迹仍需要专门的地理数据库或地图服务。

## 三种结构对比

| 类型 | 核心能力 | 结果是否精确 | 典型场景 |
| --- | --- | --- | --- |
| Bitmap | 位状态、位运算 | 精确 | 签到、点赞、在线标记 |
| HyperLogLog | 基数估算 | 近似 | UV、去重访问量 |
| GEO | 距离与附近搜索 | 地理编码与球面距离近似，范围模型有限 | 附近的人、门店、设备 |

## 容量和运维注意事项

特殊结构仍然受 Redis 内存、持久化和主从复制影响。大规模 Bitmap 需要估算最大 offset，HLL 需要按周期控制 Key 数量，GEO 需要控制成员更新频率和查询半径。对大 Key、慢查询、内存碎片和过期策略应纳入监控。


## 同一个活动为什么需要三种模型

假设业务运营一场线下活动，需要回答三个问题：某个用户今天是否签到、整周大约有多少独立访客、用户附近有哪些门店。第一个问题要求精确成员状态，第二个只需要规模估计，第三个需要空间距离。把它们全部做成 Set 可以解决部分问题，但无法自然表达地理检索，而且会为只要数量的指标保存大量成员。

我们首先定义口径。签到按业务时区划分自然日，访客按统一匿名标识或账号归一化，门店坐标按同一坐标系统录入。任何数据结构都不能修复输入口径不一致：同一人在多个设备的匿名 ID 会被计为多个访客；坐标系统混用会让附近门店看似排序正确、实际位置却偏移。[Redis 数据类型文档](https://redis.io/docs/latest/develop/data-types/)提供结构入口，具体口径由业务负责。

## Bitmap：省空间的前提是编号足够紧凑

最大 offset 为 N 时，需要的载荷约为 floor(N/8)+1 字节，而不是活跃人数除以八。100 万个连续用户大约需要 125000 字节；只有十个用户、但最大 ID 为十亿，也可能把字符串扩展到约 125 MB。实际内存还有 Key 与对象开销。直接拿 Snowflake ID 当 offset 通常既浪费空间，也可能超过命令允许范围。

可以给用户分配一个稳定、紧凑的内部序号，但映射自身要保存和维护。用户删除后回收序号，可能让历史位图把新用户误认成旧用户，因此编号复用必须与历史保留策略联动。另一种做法是按用户 ID 分桶：bucket=floor(id/bucketSize)，offset=id%bucketSize。分桶控制单 Key 大小，却会增加汇总时访问的 Key 数量。

~~~redis
SETBIT activity:demo:sign:20260930:bucket0 42 1
SETBIT activity:demo:sign:20260930:bucket0 43 1
GETBIT activity:demo:sign:20260930:bucket0 42
BITCOUNT activity:demo:sign:20260930:bucket0
STRLEN activity:demo:sign:20260930:bucket0
MEMORY USAGE activity:demo:sign:20260930:bucket0
EXPIRE activity:demo:sign:20260930:bucket0 7776000
~~~

SETBIT 会返回原来的位值，因此可以判断是否首次签到，但把“首次签到后发奖励”拆成两步仍然有故障窗口。位已经置一、奖励还没发时进程崩溃，重试可能认为已处理；奖励发了、响应丢失时重复请求又可能尝试发放。真正的奖励应以用户、活动、日期组成唯一业务键落入可靠账本，位图只承担快速查询或派生统计。

### 每日一张与每用户一张

每日位图适合统计日活和两天交集，用户月度位图适合展示日历。前者的 offset 是用户编号，后者的 offset 是本月第几天减一。不能把这两个维度混用后直接 BITOP。跨月连续签到还需要查询上月末尾；闰年和时区转换属于日期逻辑，位操作不会自动理解。

~~~redis
SETBIT activity:demo:user42:sign:202609 0 1
SETBIT activity:demo:user42:sign:202609 1 1
SETBIT activity:demo:user42:sign:202609 29 1
GETBIT activity:demo:user42:sign:202609 29
BITCOUNT activity:demo:user42:sign:202609
BITOP AND activity:demo:intersection   activity:demo:sign:20260929:bucket0   activity:demo:sign:20260930:bucket0
EXPIRE activity:demo:intersection 60
~~~

交集结果是临时派生 Key，也要设定过期。多 Key 操作在 Cluster 中受同槽约束，需要预先设计 hash tag 或在应用层合并。不能为了让某一次跨天运算原子执行，就把全部用户和全部日期永久放到同一个槽位。

## HyperLogLog：误差应该成为接口契约

HLL 估计不同元素的数量，不能枚举成员，也不能查某个用户是否出现。标准误差约 0.81% 是统计意义的尺度，不是每一次结果都必然位于真实值正负 0.81% 内。小样本、数据分布和具体算法细节会影响单次偏差。报表上若展示到个位数字，却不说明估算性质，会给用户错误的精确感。

单个 HLL 的密集表示载荷量级约 12 KiB，实际内存还要加对象开销；小基数可能使用更紧凑的表示。因此“固定 12 KB”是便于理解的上界量级说法，不是 MEMORY USAGE 必然返回的常数。如果创建一百万个很细维度的 HLL，Key 数量本身就足以造成较大成本。结构省空间不代表维度可以无限增加。

~~~redis
PFADD activity:demo:uv:20260929 user-42 user-43 user-44
PFADD activity:demo:uv:20260930 user-43 user-45
PFCOUNT activity:demo:uv:20260929
PFCOUNT activity:demo:uv:20260929 activity:demo:uv:20260930
PFMERGE activity:demo:uv:week   activity:demo:uv:20260929 activity:demo:uv:20260930
PFCOUNT activity:demo:uv:week
EXPIRE activity:demo:uv:week 7776000
~~~

周 UV 不能把每天 PFCOUNT 相加，因为跨天用户会重复。合并的是估计结构中的去重信息，口径仍必须一致。不能把账号 ID、手机号和设备 ID 混为同一个元素空间；也不要把日期前缀拼进用户元素后再合并，否则同一人跨天会变成不同成员。需要按隐私要求删除某个人的历史贡献时，HLL 不支持精确减去该成员，应重新计算或改用可撤销的数据模型。

### 一个可复现的误差测量脚本

以下 Python 示例使用 redis-py，依赖在自己的实验虚拟环境中安装并锁定版本。它在隔离前缀中同时写精确 Set 与 HLL，以相同输入比较结果。脚本打印真实执行值，不在文章里编造误差百分比。为了让内存测试不过度影响共享服务，示例只测试几个受控规模。

~~~python
import os
import random
import redis

client = redis.Redis.from_url(os.environ['REDIS_LAB_URL'])
random.seed(20260930)
for size in (100, 1000, 10000, 100000):
    exact_key = f'activity:demo:hll-check:{size}:exact'
    hll_key = f'activity:demo:hll-check:{size}:hll'
    client.delete(exact_key, hll_key)
    values = [f'user-{i}' for i in range(size)]
    random.shuffle(values)
    for start in range(0, size, 500):
        batch = values[start:start + 500]
        with client.pipeline(transaction=False) as pipe:
            pipe.sadd(exact_key, *batch)
            pipe.pfadd(hll_key, *batch)
            pipe.execute()
    exact = client.scard(exact_key)
    estimate = client.pfcount(hll_key)
    error = (estimate - exact) / exact
    print({'size': size, 'exact': exact,
           'estimate': estimate, 'relative_error': error,
           'exact_bytes': client.memory_usage(exact_key),
           'hll_bytes': client.memory_usage(hll_key)})
    client.expire(exact_key, 3600)
    client.expire(hll_key, 3600)
~~~

## GEO：先统一坐标，再讨论附近

GEOADD 的顺序是经度、纬度。坐标范围检查能发现纬度写成 116 的明显错误，却发现不了两个都落在合法范围内的错序。门店导入需要记录坐标来源和坐标系统。Redis 不替你把 GCJ-02、BD-09 与 WGS84 互相转换，混合输入必须在应用层或地图服务侧统一。

~~~redis
GEOADD activity:demo:stores   116.397 39.908 store-a   116.407 39.918 store-b   116.417 39.928 store-c
GEOPOS activity:demo:stores store-a store-b
GEODIST activity:demo:stores store-a store-b km
GEOSEARCH activity:demo:stores   FROMLONLAT 116.400 39.900 BYRADIUS 5 km   ASC COUNT 20 WITHDIST WITHCOORD
ZREM activity:demo:stores store-c
~~~

附近直线距离与实际通行距离不同。隔河的门店可能直线很近、开车很远，配送范围也可能由多边形或道路网络决定。GEO 可以先筛候选，再把少量候选交给地图服务做路线计算。COUNT ANY 与要求精确最近若干候选的语义也要区分，不能仅为提速更换选项却保持旧的“最近”承诺。

移动设备还需要位置新鲜度。GEO member 本身不自动携带最后更新时间和独立 TTL，可以用伴随时间索引或数据库状态过滤超时成员，但两份索引之间又出现一致性问题。删除 GEO 位置时也要删除伴随状态，恢复时能重新对账。单次查到一个坐标，只能证明曾经上报过，不能证明设备此刻仍在那里。

## 从特殊结构回到运维边界

三种结构都可能形成大 Key 或热 Key。位图按周期拆分、HLL 限制维度、GEO 按合理地域分区，各自都改变查询成本。分区后跨区域附近搜索要处理边界，否则人在分界线旁边会漏掉另一侧的门店。为每个结构记录可恢复来源：签到账本、访问事件流、门店数据库。Redis 丢失后如果无法恢复，而业务又要求精确历史，就不能把它仅当临时加速层。

监控也应该按结构设计。Bitmap 关注最大 offset 和字符串大小；HLL 关注 Key 数量及误差抽样；GEO 关注热点区域查询耗时、成员数和过期位置比例。只看总体命中率，会遗漏这些完全不同的风险。

## 把统计口径写进 Key 与元数据

一个 UV 数字只有结合去重身份、时间窗口、业务过滤和算法版本才有意义。账号 UV、设备 UV 与匿名访客 UV 不能直接比较；按 UTC 日切与按北京时间日切也不等价。建议在指标定义中保存这些信息，并在 Key 命名中只保留有助于隔离的稳定维度，详细定义放到指标目录，避免 Key 变成无法维护的长字符串。

同样，签到位图需要记录编号映射版本，GEO 需要记录坐标系统和位置更新时间来源。数据结构都很快，但没有定义的快数字往往比慢查询更危险，因为它会被下游报表反复使用。变更口径时使用新版本并保留一段重叠对照，不要直接覆盖旧 Key 后把历史曲线拼接起来。

~~~json
{
  "metricDefinition": {
    "name": "campaign-weekly-unique-visitors",
    "identity": "normalized-account-id",
    "timezone": "Asia/Shanghai",
    "window": "calendar-week",
    "algorithm": "redis-hyperloglog",
    "definitionVersion": "v2",
    "exclusions": ["internal-test-accounts", "known-automation"],
    "deletionPolicy": "rebuild-from-retained-source-events",
    "presentation": "approximate-count",
    "validation": "sample-against-exact-set-with-same-input"
  },
  "locationDefinition": {
    "coordinateSystem": "explicitly-normalized-before-write",
    "distanceMeaning": "geographic-proximity-not-road-distance",
    "freshnessSource": "server-accepted-position-timestamp",
    "expiredMemberPolicy": "exclude-and-clean-up"
  }
}
~~~

这是一份业务定义示例，Redis 不会自动读取其中的字段并执行过滤。过滤必须在写入之前一致完成，或者从同一可靠事件源重算。对 HLL 而言，错误加入一个成员后不能简单删除，因此输入治理比事后修正更重要。

恢复演练可以先清空一个专用测试周期的派生数据，再从账本或事件重建，与原结果对照。Bitmap 应逐位或分块核验，HLL 应比较同口径估计与精确样本，GEO 应比较成员坐标与业务有效性。不能对三种结构都只做一个 GET 字符串相等测试，因为它们的编码、近似语义和恢复目标不同。

若业务没有可恢复来源，就应明确 Redis 在这里承担主存储责任，重新评估持久化、备份和数据删除流程。结构本身省空间不意味着恢复可以省略。任何指标只要被用于结算或权限判断，都应先确认概率误差、数据延迟和丢失风险是否仍能被接受。

## 故障注入与验收实验

签到、UV、附近门店分别建立独立样本。计算预期值时使用业务账本、精确 Set 或人工确认的坐标，不能用被验证结构的输出再验证自己。

### SPECIAL-01：稀疏 offset

实验前提是同样只有十个签到用户，编号分布不同。执行分别使用连续编号和较大但受控的稀疏编号置位。

通过条件是内存随最大 offset 增长而非仅随人数增长。这里的判断依据是位图保留到最高位之间的空间，稀疏性会抵消空间优势。

### SPECIAL-02：重复签到

实验前提是用户当日位值初始为零。执行重复执行 SETBIT 并读取旧位返回值。

通过条件是首次旧值为零，后续旧值为一，统计不重复增长。这里的判断依据是位状态能提供重复线索，但奖励副作用仍需独立幂等。

### SPECIAL-03：跨时区日期

实验前提是活动以固定业务时区划分自然日。执行在 UTC 日期变化而业务日期未变化时提交签到。

通过条件是Key 仍归属同一业务日期。这里的判断依据是日期边界由领域规则确定，服务器默认时区不能偷偷改变签到口径。

### SPECIAL-04：月度日历

实验前提是九月与十月各有一张用户位图。执行检查月末和下月第一天并计算连续签到。

通过条件是没有把两个不同日期映射到同一业务位。这里的判断依据是offset 与日期的映射必须有明确的月份范围。

### SPECIAL-05：HLL 误差

实验前提是相同输入分别进入精确 Set 和 HLL。执行按多个数量级运行误差脚本。

通过条件是输出真实相对误差并明确其统计性质。这里的判断依据是标准误差不是每一个样本的绝对最大偏差。

### SPECIAL-06：跨天 UV 合并

实验前提是同一用户在两天都出现。执行比较每日计数相加与结构合并计数。

通过条件是周口径不会故意把同一成员跨天算成两人。这里的判断依据是去重操作应发生在一致成员空间中，而不是对最终数字简单求和。

### SPECIAL-07：删除需求

实验前提是业务新增删除单个访客贡献的要求。执行检查 HLL 是否能定位并移除该用户。

通过条件是承认无法精确删除并选择重算或其他模型。这里的判断依据是不可枚举的概率结构不能承担可撤销的精确成员账本。

### SPECIAL-08：坐标顺序

实验前提是门店坐标来自可核实的数据源。执行交换经纬度并检查范围和实际落点。

通过条件是非法坐标被拒绝，合法但错误的点能被导入校验发现。这里的判断依据是数值范围校验只能发现一部分坐标语义错误。

### SPECIAL-09：位置过期

实验前提是设备停止上报但 GEO 中仍有坐标。执行推进业务时间并执行附近在线设备查询。

通过条件是过期设备被新鲜度条件过滤。这里的判断依据是GEO 保存位置，不自动理解在线状态或成员级过期。

### SPECIAL-10：分区边界

实验前提是两个门店分处地域分区边界两侧。执行从边界附近查询同一半径内候选。

通过条件是结果包含两侧符合条件门店且能去重。这里的判断依据是按地域拆分降低单 Key 压力，却必须补齐跨分区检索。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "Redis 3 种特殊数据类型详解",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "SPECIAL-01",
      "scenario": "稀疏 offset",
      "given": "同样只有十个签到用户，编号分布不同",
      "when": "分别使用连续编号和较大但受控的稀疏编号置位",
      "then": "内存随最大 offset 增长而非仅随人数增长"
    },
    {
      "id": "SPECIAL-02",
      "scenario": "重复签到",
      "given": "用户当日位值初始为零",
      "when": "重复执行 SETBIT 并读取旧位返回值",
      "then": "首次旧值为零，后续旧值为一，统计不重复增长"
    },
    {
      "id": "SPECIAL-03",
      "scenario": "跨时区日期",
      "given": "活动以固定业务时区划分自然日",
      "when": "在 UTC 日期变化而业务日期未变化时提交签到",
      "then": "Key 仍归属同一业务日期"
    },
    {
      "id": "SPECIAL-04",
      "scenario": "月度日历",
      "given": "九月与十月各有一张用户位图",
      "when": "检查月末和下月第一天并计算连续签到",
      "then": "没有把两个不同日期映射到同一业务位"
    },
    {
      "id": "SPECIAL-05",
      "scenario": "HLL 误差",
      "given": "相同输入分别进入精确 Set 和 HLL",
      "when": "按多个数量级运行误差脚本",
      "then": "输出真实相对误差并明确其统计性质"
    },
    {
      "id": "SPECIAL-06",
      "scenario": "跨天 UV 合并",
      "given": "同一用户在两天都出现",
      "when": "比较每日计数相加与结构合并计数",
      "then": "周口径不会故意把同一成员跨天算成两人"
    },
    {
      "id": "SPECIAL-07",
      "scenario": "删除需求",
      "given": "业务新增删除单个访客贡献的要求",
      "when": "检查 HLL 是否能定位并移除该用户",
      "then": "承认无法精确删除并选择重算或其他模型"
    },
    {
      "id": "SPECIAL-08",
      "scenario": "坐标顺序",
      "given": "门店坐标来自可核实的数据源",
      "when": "交换经纬度并检查范围和实际落点",
      "then": "非法坐标被拒绝，合法但错误的点能被导入校验发现"
    },
    {
      "id": "SPECIAL-09",
      "scenario": "位置过期",
      "given": "设备停止上报但 GEO 中仍有坐标",
      "when": "推进业务时间并执行附近在线设备查询",
      "then": "过期设备被新鲜度条件过滤"
    },
    {
      "id": "SPECIAL-10",
      "scenario": "分区边界",
      "given": "两个门店分处地域分区边界两侧",
      "when": "从边界附近查询同一半径内候选",
      "then": "结果包含两侧符合条件门店且能去重"
    }
  ]
}
```

## 选择前的三个判断

需要精确成员状态，选择可映射到稳定编号的 Bitmap；只需要近似去重规模，评估 HLL；需要位置候选，使用 GEO 并补齐坐标与新鲜度约定。每种结构都用某种限制换取效率，先接受限制，再享受效率。

## 参考资料与继续阅读

- [Redis 数据类型与命令入口](https://redis.io/docs/latest/develop/data-types/)
- [本地延伸：Redis 基本类型](Redis%205%20种基本数据类型详解.md)
