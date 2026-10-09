# Redis 3 种特殊数据类型详解

除了 String、List、Hash、Set 和 Sorted Set 这 5 种常用类型，Redis 还提供了 Bitmap、HyperLogLog 和 GEO 等特殊能力。它们并不都是独立的底层类型：Bitmap 基于 String 的位操作，GEO 基于 Sorted Set 的编码结果，HyperLogLog 则是一种概率统计结构。

## 一、Bitmap：用位保存状态

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
- `BITCOUNT` 适合统计总量，不等同于去重用户数；
- 对敏感业务状态设置过期或归档策略。

## 二、HyperLogLog：估算基数

HyperLogLog 用很小的内存估算集合中不同元素的数量，标准误差约为 0.81%。它只返回近似值，不保存可枚举的原始成员，因此不能回答“哪些用户访问过”。

```redis
PFADD uv:2026-09-14 user-1 user-2 user-3
PFCOUNT uv:2026-09-14
PFMERGE uv:week uv:2026-09-08 uv:2026-09-09 uv:2026-09-10
```

适合统计网站 UV、活动参与人数等数量级较大且允许误差的指标，不适合余额、库存或需要精确名单的场景。对多个 HLL 做合并时，要确认时间范围和业务维度没有重复计算问题。

## 三、GEO：地理空间索引

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

## 四、三种结构对比

| 类型 | 核心能力 | 结果是否精确 | 典型场景 |
| --- | --- | --- | --- |
| Bitmap | 位状态、位运算 | 精确 | 签到、点赞、在线标记 |
| HyperLogLog | 基数估算 | 近似 | UV、去重访问量 |
| GEO | 距离与附近搜索 | 位置计算精确，范围模型有限 | 附近的人、门店、设备 |

## 五、容量和运维注意事项

特殊结构仍然受 Redis 内存、持久化和主从复制影响。大规模 Bitmap 需要估算最大 offset，HLL 需要按周期控制 Key 数量，GEO 需要控制成员更新频率和查询半径。对大 Key、慢查询、内存碎片和过期策略应纳入监控。

## 总结

Bitmap 解决“某个位置是否为 1”，HyperLogLog 解决“有多少个不同元素”，GEO 解决“哪些成员离某个位置更近”。它们都用空间或精度换性能，使用前必须先确认业务真正需要的是状态、近似计数还是地理范围。
