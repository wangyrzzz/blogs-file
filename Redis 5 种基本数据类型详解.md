# Redis 5 种基本数据类型详解

> 阅读范围：Redis 7.x 的经典命令语义；较新版本的编码和字段过期能力需另行核对。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


Redis 对外提供的 5 种经典数据类型是 String、List、Hash、Set 和 Sorted Set。选择数据类型时，应从业务操作倒推，而不是看到“都是键值对”就全部用 String 存 JSON。

## String

String 是二进制安全的字符串，可以保存文本、数字、序列化结果或二进制内容。常用操作包括设置、读取、计数和过期：

```redis
SET user:1:token abc EX 3600 NX
GET user:1:token
INCR article:100:views
```

适合缓存对象、Token、计数器和简单分布式锁。使用 `SET NX EX` 实现锁时还要保存唯一 value，并在释放时通过 Lua 脚本比较 value 后删除，不能直接 `DEL` 别人的锁。

## List

List 适合有序、允许重复的数据。常用命令有 `LPUSH`、`RPUSH`、`LPOP`、`RPOP` 和 `LRANGE`：

```redis
RPUSH queue task-1 task-2
LPOP queue
LRANGE feed:user-1 0 19
```

它可以实现简单队列或时间线，但没有专业消息队列完整的确认、重试、消费组和堆积治理能力。Redis 较新版本对 List 的内部实现不断演进，应用不应依赖具体内部编码。

## Hash

Hash 是 field-value 映射，适合保存对象的多个字段：

```redis
HSET user:1 name "Alice" age 28 status active
HGET user:1 name
HINCRBY user:1 loginCount 1
```

只读取和更新部分字段时，Hash 比把整个对象序列化成 String 更方便。但字段很多或值很大时要评估内存和网络开销，避免把一个巨大对象集中到单个 Key。

## Set

Set 保存无序且不重复的成员，支持判断、交集、并集、差集和随机取样：

```redis
SADD user:1:following user:2 user:3
SISMEMBER user:1:following user:2
SINTER user:1:following user:4:following
```

它适合标签、点赞关系、共同关注和去重集合。数据规模极大且只需要数量估算时，可以考虑 HyperLogLog，而不是把所有成员都放入 Set。

## Sorted Set

Sorted Set 为每个 member 关联一个 score，查询时可以按分值排序和按范围取数据：

```redis
ZADD rank:game 98 player-1 87 player-2
ZRANGE rank:game 0 9 REV WITHSCORES
ZREVRANK rank:game player-1
```

它适合排行榜、延迟任务和按时间排序的索引。相同 score 的成员还会按成员字典序排序，业务需要稳定顺序时应明确设置 score 或增加唯一序列。

## 类型选择对比

| 类型 | 典型操作 | 典型场景 |
| --- | --- | --- |
| String | 整体读写、计数、过期 | 缓存、Token、计数器 |
| List | 两端进出、范围读取 | 简单队列、时间线 |
| Hash | 字段级读写 | 对象属性、购物车 |
| Set | 去重、集合运算 | 标签、关系、共同关注 |
| Sorted Set | 按分数排序和范围查询 | 排行榜、延迟任务 |

## 通用实践

### Key 设计

统一命名空间、业务对象和主键，例如 `prod:order:10001`。Key 中不要放未限制长度的用户输入，也不要为了省字符而牺牲可读性。多租户系统应把租户边界体现在 Key 或访问层中。

### TTL 与大 Key

缓存通常设置过期时间，并为批量写入加入随机偏移。定期检查大 Key、热 Key、阻塞命令和内存碎片；不要对超大集合随意执行 `KEYS`、全量 `HGETALL` 或全量 `SMEMBERS`。

### 一致性与序列化

Redis 是缓存还是主存储必须在架构中明确。使用缓存时设计失效、回源、降级和重建；使用 Redis 作为状态存储时，则要考虑持久化、备份、故障转移和数据恢复。


## 从访问方式推导模型：一个购物系统的五种状态

我们假设系统需要保存商品详情、购物车、最近浏览、点赞关系和排行榜。五种需求虽然都可以序列化成 JSON，却有不同的读写形态。商品详情往往整体读取，购物车需要按 SKU 修改数量，浏览记录需要顺序，点赞需要去重，排行榜需要区间排序。如果所有内容都放进一个大 String，每次修改一个字段都要下载整个对象、反序列化、修改并上传；并发写入还容易互相覆盖。

数据类型选择并非语言对象到 Redis 类型的一一映射，而是把高频业务操作映射到服务器原子命令。一个 Java Map 可能整体序列化为 String，也可能建模成 Hash；一个 Java List 也可能用 ZSet 表达去重后的时间排序。Redis 官方的[数据类型目录](https://redis.io/docs/latest/develop/data-types/)可以查询各类命令入口，以下模型则是面向业务的设计示例。

### String：整体快照和单值原子操作

商品详情快照适合整体替换，但必须有模式版本。字段从数字变为字符串后，旧应用是否仍能读取，需要比缓存 TTL 更早考虑。可以在值中写 schemaVersion，也可以把版本放进 Key。后者更容易隔离新旧格式，却会在发布期同时占用两套内存。

~~~redis
SET shop:demo:product:v1:100 '{"id":"100","name":"Notebook","priceCents":1200}' EX 300
GET shop:demo:product:v1:100
TTL shop:demo:product:v1:100
INCR shop:demo:product:100:views
MGET shop:demo:product:v1:100 shop:demo:product:v1:101
~~~

普通 SET 覆盖已有值时会改变过期状态，不能假设原 TTL 自动保留；需要明确使用保留 TTL 的选项或重新设定 TTL。计数器也要注意“第一次 INCR 后再 EXPIRE”的崩溃窗口：第一次命令成功、进程却在第二次命令前退出，就留下永久 Key。小型 Lua 脚本可以把这两个动作组合到单次执行中。

~~~lua
-- KEYS[1] 是计数器，ARGV[1] 是正整数窗口秒数。
-- 实际入口先校验参数，避免非法 TTL。
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return count
~~~

脚本原子执行意味着其他命令不会插入其中，不意味着脚本中任何后续报错都会回滚已经执行的写入。上线前仍要校验类型和参数，控制脚本工作量，不能在 Lua 里遍历无界集合。

### Hash：购物车局部更新

以用户和租户确定购物车 Key，以 SKU 确定 field，数量作为整数值。这样添加同一 SKU 可以用 HINCRBY，查询全部购物车只适用于有数量上限的场景。购物车中商品价格应在结算时重新从权威来源校验，不能因为缓存里存了一份价格就把它当成结算依据。

~~~redis
HSET shop:{tenant10:user42}:cart SKU-001 2 SKU-002 1
HINCRBY shop:{tenant10:user42}:cart SKU-001 1
HMGET shop:{tenant10:user42}:cart SKU-001 SKU-002
HLEN shop:{tenant10:user42}:cart
HSCAN shop:{tenant10:user42}:cart 0 COUNT 20
EXPIRE shop:{tenant10:user42}:cart 2592000
~~~

Hash 的 field 不自动拥有独立生命周期；某些新版本有字段过期能力，但本文经典模型按整个 Key 的 TTL 设计，避免版本能力混用。一个购物车内数量减为零时，要决定删除字段还是保留零值。该约定影响 HLEN 是否代表商品种类数，也影响前端恢复购物车的行为。负数数量必须在业务边界拒绝，不能仅依赖 Redis 能保存整数。

### List：顺序数据与可靠消费的距离

最近浏览可在左端写入，并用 LTRIM 限制长度。这个结构允许重复，用户反复查看一个商品会产生多条记录。若产品要求“最近浏览的不同商品”，则需要额外去重或改用以时间为 score 的 ZSet，不能把 List 的顺序优势误解成自动去重。

~~~redis
LPUSH shop:demo:user:42:recent product-100
LTRIM shop:demo:user:42:recent 0 99
LRANGE shop:demo:user:42:recent 0 19
RPUSH shop:{jobs}:ready job-001 job-002
LMOVE shop:{jobs}:ready shop:{jobs}:processing LEFT RIGHT
LREM shop:{jobs}:processing 1 job-001
~~~

LMOVE 把任务移动到处理中列表，能缩小“取走后崩溃就丢任务”的窗口，但完整可靠队列还需要任务唯一 ID、处理超时、重投、死信和消费者所有权。任务载荷相同不能作为唯一标识，否则 LREM 可能删除错误的一次投递。Redis Cluster 中相关 Key 要符合相同槽位约束；上面的 hash tag 是为演示同槽操作，不应把所有租户都放入同一个全局槽位。

### Set：关系是否存在优于重复计数

点赞关系可以按文章保存用户集合。SADD 的返回值能区分本次是新增还是已存在，因此比“先 SISMEMBER 再 SADD”更适合并发。若同时维护一个点赞总数 Key，关系更新和总数更新仍是两份状态，必须原子组合或允许重建，否则重复请求会把计数推高。

~~~redis
SADD shop:demo:article:100:likes user-42 user-43
SISMEMBER shop:demo:article:100:likes user-42
SCARD shop:demo:article:100:likes
SSCAN shop:demo:article:100:likes 0 COUNT 20
SREM shop:demo:article:100:likes user-42
~~~

集合交集操作的代价取决于集合大小，不能把“单条命令”理解成常数成本。大集合共同关注适合限制参与集合和结果数，或者异步计算。要求精确名单就不能用 HLL 替代 Set；只要求大致数量时，保存全部成员又可能浪费内存。

### Sorted Set：排序契约必须可解释

ZSet 的 member 唯一，score 可以更新。相同 score 时有字典序规则，但这不等于业务需要的并列名次。顺序名次、竞赛名次和稠密名次是不同产品概念：第一、第二、第二、第四，与第一、第二、第二、第三的区别需要在接口契约中写清楚。

~~~redis
ZADD shop:demo:ranking 100 user-42 100 user-43 98 user-44
ZINCRBY shop:demo:ranking 3 user-44
ZRANGE shop:demo:ranking 0 9 REV WITHSCORES
ZREVRANK shop:demo:ranking user-42
ZCOUNT shop:demo:ranking 100 +inf
ZREM shop:demo:ranking user-44
~~~

score 使用双精度浮点表示。把超大毫秒时间戳、业务金额和序号拼成一个巨大整数，可能超过精确整数范围。需要复合排序时，应评估缩放范围与精度，或把次序编码到 member 并明确比较规则。延迟任务使用时间 score 时还要原子认领：两个消费者各自查询到期成员后再删除，仍会重复执行。

## 网络、复杂度和内存需要一起算

假设平均单值 2 KiB、活跃 Key 一百万，仅载荷就是约 2 GiB，实际还包括 Key 字符串、对象结构、哈希表、分配器碎片及复制缓冲。容量评估不能只把 JSON 长度相加。另一方面，一个 HGETALL 返回 20 MiB，即使服务器遍历很快，也会占用网络、客户端解码与 GC 时间。接口 P99 会受到这些开销共同影响。

Pipeline 可以减少往返等待，但不会把一组命令变成事务。MULTI/EXEC 也不同于关系数据库支持任意回滚的事务。WATCH 可以用于乐观并发控制，但发生冲突就要从读取阶段重新计算，且网络往返较多。批量大小需要限制：一次 pipeline 塞入几十万条命令会提高缓冲压力，不能只追求最大吞吐数字。

SCAN 家族适合渐进遍历，但 COUNT 是工作量提示，不是严格分页大小；扫描期间发生修改时可能出现重复和不稳定视图。业务导出若要求某一时刻的精确全集，不能把 SCAN 游标当成数据库快照。迁移工具要允许重复处理，记录进度，并通过最终校验确认结果。

## 生命周期比命令表更重要

把缓存 Key、会话 Key、幂等 Key 和任务 Key 混在同一个可随意淘汰的实例里，是常见架构问题。缓存被淘汰可以回源，幂等记录被淘汰则可能重新执行业务。先按可丢失性划分数据，再选择持久化和淘汰策略。过期不是精确计时器，不能用 TTL 到期事件作为唯一的业务结算驱动。

多租户命名空间只是一道组织边界，权限还要在应用或 Redis ACL 中落实。用户可控字符串进入 Key 前应限制长度、字符和拼接规则，避免产生无法追踪的大量 Key。删除大 Key 可以研究 UNLINK 等机制，但异步释放不意味着内存立刻归还系统；实际效果仍受对象结构和分配器影响。

## 用 Lua 把购物车数量校验与更新组合起来

HINCRBY 本身原子，但“读取数量、判断上限、再增加”依旧是复合流程。购物车若规定同一 SKU 最多九十九件，可以使用一个短脚本把读取、合法性检查和写入放在同一执行范围内。脚本只处理一个 field，不遍历无界集合，工作量容易控制。

~~~lua
-- KEYS[1]: cart key
-- ARGV[1]: sku
-- ARGV[2]: integer delta, validated by the application
-- ARGV[3]: positive cart ttl in seconds
local delta = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if not delta or delta ~= math.floor(delta) or delta < -99 or delta > 99 then
  return redis.error_reply('INVALID_DELTA')
end
if not ttl or ttl <= 0 or ttl > 2147483647 or ttl ~= math.floor(ttl) then
  return redis.error_reply('INVALID_TTL')
end
local current = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
if not current or current ~= math.floor(current) or current < 0 or current > 99 then
  return redis.error_reply('INVALID_STORED_QUANTITY')
end
local nextQuantity = current + delta
if nextQuantity < 0 or nextQuantity > 99 then
  return redis.error_reply('QUANTITY_OUT_OF_RANGE')
end
if nextQuantity == 0 then
  redis.call('HDEL', KEYS[1], ARGV[1])
else
  redis.call('HSET', KEYS[1], ARGV[1], nextQuantity)
end
redis.call('EXPIRE', KEYS[1], ttl)
return nextQuantity
~~~

这里更新的是购物车意向数量，不是仓库可售库存。加入购物车不能承诺结算一定成功，真正下单仍需在库存权威路径校验。数量为零删除 field，使字段数量能够代表购物车中不同 SKU 的数量；若最后一个 field 被删掉，Key 随之不存在，后续 EXPIRE 返回零是正常情况。

脚本还要面对数据类型错误：若同名 Key 被其他业务写成 String，HGET 会报错，应作为命名空间冲突排查，不要捕获后无条件删除重建。生产调用可使用脚本缓存减少传输，但要处理脚本缓存丢失后的重新加载。连接故障后的重试也要区分增加数量与设定最终数量：重复执行增量会重复增加，网络超时不能直接证明脚本没有执行。

## 数据类型迁移需要同时迁移读写契约

假设旧版购物车保存在 String JSON 中，新版准备改成 Hash。直接在原 Key 上执行 HSET 会得到 WRONGTYPE，先 DEL 再 HSET 又会留下数据消失窗口。更难处理的是滚动发布：新版刚改成 Hash，尚未退出的旧实例仍可能执行 SET，把结构重新覆盖成 String。迁移目标因此不仅是“把数据转过去”，还包括让所有读写方在同一兼容策略下工作。

一种便于回退的方案是使用 v1、v2 两个命名空间：先发布能够读取两种格式的应用，新格式缺失时从权威来源重建；写入策略切换后，再观察旧格式访问量，最后按保留期清理旧 Key。购物车如果本身就是用户状态的唯一存储，不能照搬普通缓存的回源方案，而应为复制过程建立版本号或增量记录，解决复制期间继续写入的问题。

双写也不是天然原子。v1 写成功、v2 写失败时，需要明确哪个版本具有权威性、失败如何补偿，以及读请求是否允许回退。若新旧结构位于不同 Cluster 槽位，不能假设一个 Lua 脚本可以同时修改两者。即便处于同槽，脚本也要限制转换数据大小，避免把一次大对象迁移变成阻塞整个节点的长操作。

临时 Key 构造完成后再 RENAME，可以在合适场景中发布一份完整结构，但它不能解决复制期间的并发更新：旧写入若发生在快照复制之后，切换仍可能丢失该次变化。Redis Cluster 要求源与目标同槽；覆盖已有大对象还可能因为隐式删除产生延迟。相关限制应按 [RENAME 文档](https://redis.io/docs/latest/commands/RENAME/)核对，不能只看到命令复杂度标注就断言切换没有风险。

校验时也不要只比较元素数量。String 中数量为零的 SKU 在 Hash 模型里可能被删除，两个结构的元素个数本来就不同。应先把两种表示还原为同一个业务模型，再比较商品集合、数量、版本与到期时间。TTL 应保留原有的绝对到期意图；若每迁移一次就重新赋予完整生命周期，历史上本应过期的状态会被延长。完成后保留有限回退窗口，并确认旧版本程序已经停止写入，再删除旧格式兼容代码。

## 故障注入与验收实验

所有命令使用 shop:demo 或专用测试标签。先记录 TYPE、TTL、元素个数和 MEMORY USAGE，再改变一个数据维度。对涉及计费、库存的演练只使用模拟数据。

### TYPE-01：覆盖与过期

实验前提是String 已设置短 TTL。执行普通 SET 覆盖后查询 TTL，再与显式设置过期的写法对照。

通过条件是明确观察覆盖后的生命周期，不出现意外永久缓存。这里的判断依据是值更新与过期策略必须作为一个写入契约共同设计。

### TYPE-02：首次计数崩溃窗口

实验前提是计数 Key 尚不存在。执行对比 INCR 后中断与 Lua 组合 INCR/EXPIRE。

通过条件是脚本路径不会在正常成功后留下无 TTL 的初始计数。这里的判断依据是两个独立命令之间允许进程退出，单次脚本可缩小该窗口。

### TYPE-03：购物车并发增量

实验前提是同一 SKU 初始数量为 2。执行两个客户端各执行一次 HINCRBY 加一。

通过条件是最终数量为 4，无旧 JSON 快照互相覆盖。这里的判断依据是局部原子增量避免了应用层读改写的丢失更新。

### TYPE-04：浏览历史限长

实验前提是用户持续查看超过一百次商品。执行重复 LPUSH 与 LTRIM，并读取列表长度。

通过条件是列表保留最近一百条且重复浏览行为符合产品定义。这里的判断依据是顺序保存和去重是独立要求，List 只自然提供前者。

### TYPE-05：消费者崩溃

实验前提是任务已从 ready 移动到 processing。执行中断消费者，再执行超时任务恢复逻辑。

通过条件是任务能够重新认领且重复副作用被业务 ID 阻止。这里的判断依据是处理中列表提供恢复线索，但不会自动完成幂等与所有权管理。

### TYPE-06：重复点赞

实验前提是点赞关系集合初始为空。执行并发多次 SADD 同一用户并汇总返回值。

通过条件是成员只有一个，新增返回值总数为一。这里的判断依据是把 SADD 结果用于判断本次是否新建关系比先读后写可靠。

### TYPE-07：相同分值名次

实验前提是两个用户拥有相同 score。执行读取排名并按产品选择的并列规则转换。

通过条件是明确区分集合下标和业务并列名次。这里的判断依据是底层排序规则不等价于竞赛或稠密名次规则。

### TYPE-08：扫描中的修改

实验前提是一个较大的 Hash 正在被持续更新。执行用 HSCAN 迭代并记录重复 field。

通过条件是调用方允许重复且不声称拿到了固定时刻快照。这里的判断依据是渐进扫描降低单次阻塞，不提供快照隔离。

### TYPE-09：跨槽组合操作

实验前提是Cluster 中两个队列 Key 没有共同 hash tag。执行尝试需要同槽的多键操作并与合理标签对照。

通过条件是失败被识别为路由限制，调整后仍保持分布均衡。这里的判断依据是原子多键能力有槽位边界，把所有数据强塞同槽又会造成热点。

### TYPE-10：淘汰后的业务后果

实验前提是缓存与幂等记录拥有不同可丢失性。执行在隔离实例模拟内存压力并观察两类数据丢失结果。

通过条件是缓存可重建，业务幂等状态有独立持久保护。这里的判断依据是同样的 Redis Key 丢失，对不同业务意味着完全不同的风险。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "Redis 5 种基本数据类型详解",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "TYPE-01",
      "scenario": "覆盖与过期",
      "given": "String 已设置短 TTL",
      "when": "普通 SET 覆盖后查询 TTL，再与显式设置过期的写法对照",
      "then": "明确观察覆盖后的生命周期，不出现意外永久缓存"
    },
    {
      "id": "TYPE-02",
      "scenario": "首次计数崩溃窗口",
      "given": "计数 Key 尚不存在",
      "when": "对比 INCR 后中断与 Lua 组合 INCR/EXPIRE",
      "then": "脚本路径不会在正常成功后留下无 TTL 的初始计数"
    },
    {
      "id": "TYPE-03",
      "scenario": "购物车并发增量",
      "given": "同一 SKU 初始数量为 2",
      "when": "两个客户端各执行一次 HINCRBY 加一",
      "then": "最终数量为 4，无旧 JSON 快照互相覆盖"
    },
    {
      "id": "TYPE-04",
      "scenario": "浏览历史限长",
      "given": "用户持续查看超过一百次商品",
      "when": "重复 LPUSH 与 LTRIM，并读取列表长度",
      "then": "列表保留最近一百条且重复浏览行为符合产品定义"
    },
    {
      "id": "TYPE-05",
      "scenario": "消费者崩溃",
      "given": "任务已从 ready 移动到 processing",
      "when": "中断消费者，再执行超时任务恢复逻辑",
      "then": "任务能够重新认领且重复副作用被业务 ID 阻止"
    },
    {
      "id": "TYPE-06",
      "scenario": "重复点赞",
      "given": "点赞关系集合初始为空",
      "when": "并发多次 SADD 同一用户并汇总返回值",
      "then": "成员只有一个，新增返回值总数为一"
    },
    {
      "id": "TYPE-07",
      "scenario": "相同分值名次",
      "given": "两个用户拥有相同 score",
      "when": "读取排名并按产品选择的并列规则转换",
      "then": "明确区分集合下标和业务并列名次"
    },
    {
      "id": "TYPE-08",
      "scenario": "扫描中的修改",
      "given": "一个较大的 Hash 正在被持续更新",
      "when": "用 HSCAN 迭代并记录重复 field",
      "then": "调用方允许重复且不声称拿到了固定时刻快照"
    },
    {
      "id": "TYPE-09",
      "scenario": "跨槽组合操作",
      "given": "Cluster 中两个队列 Key 没有共同 hash tag",
      "when": "尝试需要同槽的多键操作并与合理标签对照",
      "then": "失败被识别为路由限制，调整后仍保持分布均衡"
    },
    {
      "id": "TYPE-10",
      "scenario": "淘汰后的业务后果",
      "given": "缓存与幂等记录拥有不同可丢失性",
      "when": "在隔离实例模拟内存压力并观察两类数据丢失结果",
      "then": "缓存可重建，业务幂等状态有独立持久保护"
    }
  ]
}
```

## 选型落到操作上

先写出最频繁的三个读取和三个更新，再选择能用有界命令完成它们的数据类型。容量测试应覆盖最大对象，故障测试应覆盖数据丢失后的业务后果。把这两件事做完，五种类型的选择通常会比记忆应用场景表更清楚。

## 参考资料与继续阅读

- [Redis 数据类型](https://redis.io/docs/latest/develop/data-types/)
- [本地延伸：Redis 持久化](Redis持久化机制/Redis持久化机制.md)
