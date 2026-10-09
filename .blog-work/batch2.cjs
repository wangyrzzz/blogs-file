const {writeArticle}=require('./compose.cjs');
const common='https://redis.io/docs/latest/develop/data-types/';
const articles=[{
file:'Redis 5 种基本数据类型详解.md',scope:'Redis 7.x 的经典命令语义；较新版本的编码和字段过期能力需另行核对',
body:`## 从访问方式推导模型：一个购物系统的五种状态

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

多租户命名空间只是一道组织边界，权限还要在应用或 Redis ACL 中落实。用户可控字符串进入 Key 前应限制长度、字符和拼接规则，避免产生无法追踪的大量 Key。删除大 Key 可以研究 UNLINK 等机制，但异步释放不意味着内存立刻归还系统；实际效果仍受对象结构和分配器影响。`,
lab:'所有命令使用 shop:demo 或专用测试标签。先记录 TYPE、TTL、元素个数和 MEMORY USAGE，再改变一个数据维度。对涉及计费、库存的演练只使用模拟数据。',
cases:[
['TYPE-01','覆盖与过期','String 已设置短 TTL','普通 SET 覆盖后查询 TTL，再与显式设置过期的写法对照','明确观察覆盖后的生命周期，不出现意外永久缓存','值更新与过期策略必须作为一个写入契约共同设计'],
['TYPE-02','首次计数崩溃窗口','计数 Key 尚不存在','对比 INCR 后中断与 Lua 组合 INCR/EXPIRE','脚本路径不会在正常成功后留下无 TTL 的初始计数','两个独立命令之间允许进程退出，单次脚本可缩小该窗口'],
['TYPE-03','购物车并发增量','同一 SKU 初始数量为 2','两个客户端各执行一次 HINCRBY 加一','最终数量为 4，无旧 JSON 快照互相覆盖','局部原子增量避免了应用层读改写的丢失更新'],
['TYPE-04','浏览历史限长','用户持续查看超过一百次商品','重复 LPUSH 与 LTRIM，并读取列表长度','列表保留最近一百条且重复浏览行为符合产品定义','顺序保存和去重是独立要求，List 只自然提供前者'],
['TYPE-05','消费者崩溃','任务已从 ready 移动到 processing','中断消费者，再执行超时任务恢复逻辑','任务能够重新认领且重复副作用被业务 ID 阻止','处理中列表提供恢复线索，但不会自动完成幂等与所有权管理'],
['TYPE-06','重复点赞','点赞关系集合初始为空','并发多次 SADD 同一用户并汇总返回值','成员只有一个，新增返回值总数为一','把 SADD 结果用于判断本次是否新建关系比先读后写可靠'],
['TYPE-07','相同分值名次','两个用户拥有相同 score','读取排名并按产品选择的并列规则转换','明确区分集合下标和业务并列名次','底层排序规则不等价于竞赛或稠密名次规则'],
['TYPE-08','扫描中的修改','一个较大的 Hash 正在被持续更新','用 HSCAN 迭代并记录重复 field','调用方允许重复且不声称拿到了固定时刻快照','渐进扫描降低单次阻塞，不提供快照隔离'],
['TYPE-09','跨槽组合操作','Cluster 中两个队列 Key 没有共同 hash tag','尝试需要同槽的多键操作并与合理标签对照','失败被识别为路由限制，调整后仍保持分布均衡','原子多键能力有槽位边界，把所有数据强塞同槽又会造成热点'],
['TYPE-10','淘汰后的业务后果','缓存与幂等记录拥有不同可丢失性','在隔离实例模拟内存压力并观察两类数据丢失结果','缓存可重建，业务幂等状态有独立持久保护','同样的 Redis Key 丢失，对不同业务意味着完全不同的风险']
],end:'## 选型落到操作上\n\n先写出最频繁的三个读取和三个更新，再选择能用有界命令完成它们的数据类型。容量测试应覆盖最大对象，故障测试应覆盖数据丢失后的业务后果。把这两件事做完，五种类型的选择通常会比记忆应用场景表更清楚。',refs:[['Redis 数据类型','https://redis.io/docs/latest/develop/data-types/'],['本地延伸：Redis 持久化','Redis持久化机制/Redis持久化机制.md']]},
{
file:'Redis 3 种特殊数据类型详解.md',scope:'Bitmap、HyperLogLog 与 GEO 的建模和容量分析；GEOSEARCH 需 Redis 6.2 或以上',
replace:[['位置计算精确，范围模型有限','地理编码与球面距离近似，范围模型有限'],['BITCOUNT\` 适合统计总量，不等同于去重用户数','BITCOUNT\` 统计置位数量；当每个用户唯一对应一个 offset 时，它可以表示该范围内精确去重人数']],
body:`## 同一个活动为什么需要三种模型

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
BITOP AND activity:demo:intersection \
  activity:demo:sign:20260929:bucket0 \
  activity:demo:sign:20260930:bucket0
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
PFMERGE activity:demo:uv:week \
  activity:demo:uv:20260929 activity:demo:uv:20260930
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
GEOADD activity:demo:stores \
  116.397 39.908 store-a \
  116.407 39.918 store-b \
  116.417 39.928 store-c
GEOPOS activity:demo:stores store-a store-b
GEODIST activity:demo:stores store-a store-b km
GEOSEARCH activity:demo:stores \
  FROMLONLAT 116.400 39.900 BYRADIUS 5 km \
  ASC COUNT 20 WITHDIST WITHCOORD
ZREM activity:demo:stores store-c
~~~

附近直线距离与实际通行距离不同。隔河的门店可能直线很近、开车很远，配送范围也可能由多边形或道路网络决定。GEO 可以先筛候选，再把少量候选交给地图服务做路线计算。COUNT ANY 与要求精确最近若干候选的语义也要区分，不能仅为提速更换选项却保持旧的“最近”承诺。

移动设备还需要位置新鲜度。GEO member 本身不自动携带最后更新时间和独立 TTL，可以用伴随时间索引或数据库状态过滤超时成员，但两份索引之间又出现一致性问题。删除 GEO 位置时也要删除伴随状态，恢复时能重新对账。单次查到一个坐标，只能证明曾经上报过，不能证明设备此刻仍在那里。

## 从特殊结构回到运维边界

三种结构都可能形成大 Key 或热 Key。位图按周期拆分、HLL 限制维度、GEO 按合理地域分区，各自都改变查询成本。分区后跨区域附近搜索要处理边界，否则人在分界线旁边会漏掉另一侧的门店。为每个结构记录可恢复来源：签到账本、访问事件流、门店数据库。Redis 丢失后如果无法恢复，而业务又要求精确历史，就不能把它仅当临时加速层。

监控也应该按结构设计。Bitmap 关注最大 offset 和字符串大小；HLL 关注 Key 数量及误差抽样；GEO 关注热点区域查询耗时、成员数和过期位置比例。只看总体命中率，会遗漏这些完全不同的风险。`,
lab:'签到、UV、附近门店分别建立独立样本。计算预期值时使用业务账本、精确 Set 或人工确认的坐标，不能用被验证结构的输出再验证自己。',
cases:[
['SPECIAL-01','稀疏 offset','同样只有十个签到用户，编号分布不同','分别使用连续编号和较大但受控的稀疏编号置位','内存随最大 offset 增长而非仅随人数增长','位图保留到最高位之间的空间，稀疏性会抵消空间优势'],
['SPECIAL-02','重复签到','用户当日位值初始为零','重复执行 SETBIT 并读取旧位返回值','首次旧值为零，后续旧值为一，统计不重复增长','位状态能提供重复线索，但奖励副作用仍需独立幂等'],
['SPECIAL-03','跨时区日期','活动以固定业务时区划分自然日','在 UTC 日期变化而业务日期未变化时提交签到','Key 仍归属同一业务日期','日期边界由领域规则确定，服务器默认时区不能偷偷改变签到口径'],
['SPECIAL-04','月度日历','九月与十月各有一张用户位图','检查月末和下月第一天并计算连续签到','没有把两个不同日期映射到同一业务位','offset 与日期的映射必须有明确的月份范围'],
['SPECIAL-05','HLL 误差','相同输入分别进入精确 Set 和 HLL','按多个数量级运行误差脚本','输出真实相对误差并明确其统计性质','标准误差不是每一个样本的绝对最大偏差'],
['SPECIAL-06','跨天 UV 合并','同一用户在两天都出现','比较每日计数相加与结构合并计数','周口径不会故意把同一成员跨天算成两人','去重操作应发生在一致成员空间中，而不是对最终数字简单求和'],
['SPECIAL-07','删除需求','业务新增删除单个访客贡献的要求','检查 HLL 是否能定位并移除该用户','承认无法精确删除并选择重算或其他模型','不可枚举的概率结构不能承担可撤销的精确成员账本'],
['SPECIAL-08','坐标顺序','门店坐标来自可核实的数据源','交换经纬度并检查范围和实际落点','非法坐标被拒绝，合法但错误的点能被导入校验发现','数值范围校验只能发现一部分坐标语义错误'],
['SPECIAL-09','位置过期','设备停止上报但 GEO 中仍有坐标','推进业务时间并执行附近在线设备查询','过期设备被新鲜度条件过滤','GEO 保存位置，不自动理解在线状态或成员级过期'],
['SPECIAL-10','分区边界','两个门店分处地域分区边界两侧','从边界附近查询同一半径内候选','结果包含两侧符合条件门店且能去重','按地域拆分降低单 Key 压力，却必须补齐跨分区检索']
],end:'## 选择前的三个判断\n\n需要精确成员状态，选择可映射到稳定编号的 Bitmap；只需要近似去重规模，评估 HLL；需要位置候选，使用 GEO 并补齐坐标与新鲜度约定。每种结构都用某种限制换取效率，先接受限制，再享受效率。',refs:[['Redis 数据类型与命令入口',common],['本地延伸：Redis 基本类型','Redis%205%20种基本数据类型详解.md']]}
];
for(const a of articles)console.log(writeArticle(a));
