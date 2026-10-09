# Redis 5 种基本数据类型详解

Redis 对外提供的 5 种经典数据类型是 String、List、Hash、Set 和 Sorted Set。选择数据类型时，应从业务操作倒推，而不是看到“都是键值对”就全部用 String 存 JSON。

## 一、String

String 是二进制安全的字符串，可以保存文本、数字、序列化结果或二进制内容。常用操作包括设置、读取、计数和过期：

```redis
SET user:1:token abc EX 3600 NX
GET user:1:token
INCR article:100:views
```

适合缓存对象、Token、计数器和简单分布式锁。使用 `SET NX EX` 实现锁时还要保存唯一 value，并在释放时通过 Lua 脚本比较 value 后删除，不能直接 `DEL` 别人的锁。

## 二、List

List 适合有序、允许重复的数据。常用命令有 `LPUSH`、`RPUSH`、`LPOP`、`RPOP` 和 `LRANGE`：

```redis
RPUSH queue task-1 task-2
LPOP queue
LRANGE feed:user-1 0 19
```

它可以实现简单队列或时间线，但没有专业消息队列完整的确认、重试、消费组和堆积治理能力。Redis 较新版本对 List 的内部实现不断演进，应用不应依赖具体内部编码。

## 三、Hash

Hash 是 field-value 映射，适合保存对象的多个字段：

```redis
HSET user:1 name "Alice" age 28 status active
HGET user:1 name
HINCRBY user:1 loginCount 1
```

只读取和更新部分字段时，Hash 比把整个对象序列化成 String 更方便。但字段很多或值很大时要评估内存和网络开销，避免把一个巨大对象集中到单个 Key。

## 四、Set

Set 保存无序且不重复的成员，支持判断、交集、并集、差集和随机取样：

```redis
SADD user:1:following user:2 user:3
SISMEMBER user:1:following user:2
SINTER user:1:following user:4:following
```

它适合标签、点赞关系、共同关注和去重集合。数据规模极大且只需要数量估算时，可以考虑 HyperLogLog，而不是把所有成员都放入 Set。

## 五、Sorted Set

Sorted Set 为每个 member 关联一个 score，查询时可以按分值排序和按范围取数据：

```redis
ZADD rank:game 98 player-1 87 player-2
ZRANGE rank:game 0 9 REV WITHSCORES
ZREVRANK rank:game player-1
```

它适合排行榜、延迟任务和按时间排序的索引。相同 score 的成员还会按成员字典序排序，业务需要稳定顺序时应明确设置 score 或增加唯一序列。

## 六、类型选择对比

| 类型 | 典型操作 | 典型场景 |
| --- | --- | --- |
| String | 整体读写、计数、过期 | 缓存、Token、计数器 |
| List | 两端进出、范围读取 | 简单队列、时间线 |
| Hash | 字段级读写 | 对象属性、购物车 |
| Set | 去重、集合运算 | 标签、关系、共同关注 |
| Sorted Set | 按分数排序和范围查询 | 排行榜、延迟任务 |

## 七、通用实践

### Key 设计

统一命名空间、业务对象和主键，例如 `prod:order:10001`。Key 中不要放未限制长度的用户输入，也不要为了省字符而牺牲可读性。多租户系统应把租户边界体现在 Key 或访问层中。

### TTL 与大 Key

缓存通常设置过期时间，并为批量写入加入随机偏移。定期检查大 Key、热 Key、阻塞命令和内存碎片；不要对超大集合随意执行 `KEYS`、全量 `HGETALL` 或全量 `SMEMBERS`。

### 一致性与序列化

Redis 是缓存还是主存储必须在架构中明确。使用缓存时设计失效、回源、降级和重建；使用 Redis 作为状态存储时，则要考虑持久化、备份、故障转移和数据恢复。

## 总结

String 适合整体值，List 适合顺序，Hash 适合字段，Set 适合去重关系，Sorted Set 适合带分值排序。类型选对只是起点，Key 规划、TTL、并发更新、容量和故障恢复同样决定 Redis 方案能否稳定运行。
