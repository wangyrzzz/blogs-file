const {writeArticle}=require('./compose.cjs');
const articles=[{
file:'3种常用的缓存读写策略详解.md',scope:'数据库是权威数据源的业务缓存；Write Behind 单独讨论持久化责任',
replace:[['因此对强一致场景还需要串行化、延迟双删、订阅数据库变更日志或改用更严格的架构。','延迟双删和订阅变更通常只是收敛手段，不提供无条件强一致。要求强一致时需要限制读写路径、串行化关键操作或直接读取权威存储。'],['只有缓存和数据库都成功时才返回成功。','对外成功语义由这一访问层定义：至少应保证权威存储已按契约写入，并明确缓存更新失败后的失效与补偿。两次写入不会因改名为 Through 就自动成为原子事务。']],
body:`## 从价格页面开始定义允许的旧数据

商品列表展示价格可以允许数秒延迟，但结算价格必须由下单服务重新计算；库存展示可以用估计值，真正扣库存必须在权威写路径做条件判断。这样，同一个字段在不同操作里会有不同一致性要求。缓存设计不能只问“商品是否需要缓存”，而应问“这一次读取会导致什么业务决定”。

一致性预算可以写成可验收规则：详情页最多接受一段明确时间的旧标题，提交订单后本人读应看见新订单状态，扣款与余额校验不得依赖可能滞后的快照。这不是给所有缓存配置同一个 TTL，而是把读取入口分级。遇到更新后的立即读取，可以让写方暂时读主库，或携带版本要求；读副本也存在复制延迟，绕过 Redis 并不天然等于读到最新。

## 三条竞态时间线

### 先删除再提交

~~~text
t1  写请求 W 删除缓存，数据库仍为 v1
t2  读请求 R 缓存未命中，从数据库读到 v1
t3  R 将 v1 写回缓存
t4  W 提交数据库 v2
t5  后续请求命中缓存 v1，直到失效或补偿发生
~~~

这个窗口容易理解：删除发生时权威数据尚未更新，读者回填旧值完全符合它当时的观察。把删除移动到事务提交后，可以去掉这一常见窗口，但还有另一条更隐蔽的交错。

### 先提交再删除，仍有慢读回填

~~~text
t1  R 未命中缓存，从数据库读到 v1，随后暂停
t2  W 提交数据库 v2
t3  W 删除缓存
t4  R 恢复执行，把之前拿到的 v1 写入缓存
t5  数据库与缓存重新出现不一致
~~~

这里删除已经成功，重试删除失败并不能覆盖这个场景。延迟第二次删除可能把 v1 再移除，但必须知道慢读最长会暂停多久。GC 暂停、网络阻塞和长事务很难提供绝对上界，所以“睡 500 毫秒再删”只能在给定延迟分布下减少概率，不能成为数学上的强一致证明。

### 并发写直接更新缓存

~~~text
t1  W1 提交数据库 v2
t2  W2 提交数据库 v3
t3  W2 把缓存更新为 v3
t4  W1 的缓存更新因网络延迟刚到达，缓存回退到 v2
~~~

缓存中带版本并只允许版本前进，可以限制这类覆盖。但实现需要原子比较，而且要处理缓存已被淘汰、旧写者不知道版本以及多个字段快照拼装不一致的问题。单纯在 JSON 里增加 version，并不会让普通 SET 自动拒绝旧版本。

## 一份能够讨论失败的旁路缓存伪代码

下面刻意把“缓存读取失败”和“未命中”区分开，并让回源有并发限制。接口是领域伪代码，需要连接自己的 Redis、数据库和指标实现。它表达控制流，不是可直接粘贴编译的完整框架项目。

~~~java
ProductView findProduct(String tenant, String id) {
    String key = productKey(tenant, id);
    CacheRead cached;
    try {
        cached = cache.read(key);
    } catch (CacheUnavailable failure) {
        metrics.increment("cache_read_error");
        return originWithBudget(tenant, id);
    }
    if (cached.isNegative()) {
        return ProductView.notFound();
    }
    if (cached.isPresent()) {
        return cached.value();
    }
    return singleFlight.execute(key, () -> {
        CacheRead second = cache.bestEffortRead(key);
        if (second.isPresent()) return second.value();
        ProductView loaded = originWithBudget(tenant, id);
        try {
            if (loaded.isNotFound()) {
                cache.writeNegative(key, shortNegativeTtl());
            } else {
                cache.write(key, loaded, jitteredTtl());
            }
        } catch (CacheUnavailable failure) {
            metrics.increment("cache_fill_error");
        }
        return loaded;
    });
}

ProductView originWithBudget(String tenant, String id) {
    if (!originPermits.tryAcquire()) {
        throw new TemporarilyUnavailable("origin capacity exhausted");
    }
    try {
        return repository.findFromAuthoritativeSource(tenant, id);
    } finally {
        originPermits.release();
    }
}
~~~

singleFlight 若只在一个进程内实现，只能合并该进程的请求，多实例仍可同时回源。使用分布式互斥时又要处理租约、等待超时、持有者故障和锁释放。不要为了缓存回填引入无限等待：用户请求有总预算，拿不到锁时应选择读旧值、有限回源或快速失败。

空值缓存要区分“确实不存在”与“查询失败”。数据库超时不是不存在，若把异常转换为空值缓存，会把一个暂时依赖故障扩大成持续的业务缺失。创建新商品后也要删除此前的空值标记，否则新数据会在负缓存 TTL 内不可见。

## 删除失败如何变成可恢复任务

在数据库事务提交后调用 DEL，是一个跨系统动作。业务提交成功、进程却在 DEL 前退出时，单纯注册内存回调不具备持久性。Outbox 的核心是把“需要失效哪个逻辑对象”与业务写入放在同一本地事务内，后台读取事件再处理缓存。这样至少不会因为进程重启忘记失效意图。

~~~sql
CREATE TABLE cache_outbox (
  event_id VARCHAR(64) PRIMARY KEY,
  aggregate_type VARCHAR(32) NOT NULL,
  aggregate_id VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  aggregate_version BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  processed_at DATETIME(3) NULL,
  attempts INT NOT NULL DEFAULT 0,
  KEY idx_pending (processed_at, created_at)
);

START TRANSACTION;
UPDATE product
SET title='New title', version=version+1
WHERE id=100 AND tenant_id=10;
INSERT INTO cache_outbox
  (event_id, aggregate_type, aggregate_id, tenant_id,
   aggregate_version, created_at)
VALUES ('event-demo-001', 'product', '100', '10', 2, NOW(3));
COMMIT;
~~~

这段 SQL 的 product 表由业务系统提供，事件 ID 必须由实际唯一生成器产生。消费者应允许重复 DEL，因为删除本身天然适合幂等重放；先删成功、后标记完成之间崩溃，再删一次通常无害。反过来先标记完成再删，崩溃会遗漏工作。并行消费需要任务认领机制，不能让所有工作者无限扫描同一批行。

CDC 可以减少应用显式写事件的侵入，但仍需解决订阅位点、事件延迟、重放和表到缓存 Key 的映射。一个商品缓存可能聚合品牌、库存和促销，多表变化都要影响它。只监听 product 表可能留下关联字段旧值。删除队列积压应作为一致性指标，而不只是消息系统的吞吐指标。

## Through 与 Behind 的工程代价

Read Through 的价值在于统一加载逻辑，使多个应用不必各自实现回填；它仍要定义加载超时、并发合并和错误传播。Write Through 需要明确写入顺序与成功条件：数据库成功但缓存失败，是返回失败并要求幂等重试，还是返回成功同时可靠失效？这个选择影响用户体验和重试压力，必须由统一访问层承担，而不是留给每个业务调用方猜测。

Write Behind 的数据安全取决于“返回成功之前已经持久保存了什么”。如果只有内存缓存变更，掉电后就可能丢失已确认写入。若先可靠记录日志再确认，缓存更多像可重建视图，后续写库是投影过程。异步合并也有语义要求：把计数增量相加通常合理，把订单状态只保留最后一条可能丢掉必须执行的中间动作。

同一个 Key 的乱序重放需要版本或序列保护，跨 Key 的原子业务不能只靠独立刷新。刷库失败时，系统要展示积压时间、最旧事件年龄和恢复速率。仅报告“队列长度一万”不够，因为一万条可能是一秒流量，也可能是三天无法处理的坏数据。

## 一次缓存故障如何传导到数据库

假设总读流量 Q=10000 次每秒，正常命中率 h=99%，数据库回源约为 Q×(1-h)=100 次每秒。Redis 故障后若全部旁路，回源突然扩大到一百倍。数据库没有为这个峰值预留容量，连接池排队会拉长事务，超时重试又继续放大流量。快速失败与限流此时是保护权威数据源的必要选择。

热 Key 与大 Key 不同：一个小字符串可以每秒被读几十万次，一个巨大 Hash 可能一天只读一次。前者关注热点分布、请求合并和本地副本，后者关注单次工作量、网络与拆分。多级缓存降低远程访问，却扩大失效范围，本地副本必须有版本、短 TTL 或失效通知。任何增加缓存层数的方案，都应该重新画一次更新传播时间线。`,
lab:'使用栅栏或可控暂停精确安排读写交错，不用随机 sleep 作为唯一同步方法。对照数据库版本、缓存版本、失效事件位点与返回值，先证明问题存在，再验证补偿能否收敛。',
cases:[
['CACHE-01','先删后写窗口','数据库和缓存都是 v1','暂停写事务，让读者在删除后、提交前完成回填','稳定复现缓存 v1 与数据库 v2 的分歧','删除时间早于权威数据更新时，正常回源也会重新写入旧数据'],
['CACHE-02','慢读覆盖删除','读者已经取到 v1 但尚未 SET','让写者提交 v2 并删除缓存后再恢复读者','观察到旧值重新出现，补偿策略最终移除它','先写库后删缓存减少常见竞态，但不排除旧读取延迟回填'],
['CACHE-03','提交后进程退出','业务更新与 Outbox 在同一事务提交','在进程执行 DEL 前强制终止并重启消费者','失效任务仍存在且最终完成删除','持久记录失效意图能跨越应用内存回调的崩溃窗口'],
['CACHE-04','重复失效','同一事件可能被重复投递','连续处理两次相同 DEL 任务','数据库不被重复更新，缓存保持可重建状态','失效消费者应围绕幂等删除设计而非重复执行业务写入'],
['CACHE-05','负缓存与创建','某商品被记录为不存在','创建该商品后按约定失效负缓存','新商品能够在承诺时间内被读到','空值标记也是缓存状态，需要参与写路径失效'],
['CACHE-06','缓存全面不可用','数据库只能承受受控回源并发','关闭测试 Redis 并持续施加读流量','回源并发不超过预算，过载请求明确失败或降级','缓存旁路不能把全部峰值无条件转移到数据库'],
['CACHE-07','热点同步过期','大量请求读取同一即将失效商品','使 TTL 到期并并发请求','回源次数受到合并机制限制，等待请求有超时','击穿治理应同时控制数据库压力与请求尾延迟'],
['CACHE-08','回源查询失败','缓存未命中且数据库查询超时','触发负缓存分支并检查实际写入','不把依赖错误写成业务不存在','错误和缺失具有不同恢复语义，混淆会持续掩盖真实数据'],
['CACHE-09','异步写回丢失','Write Behind 已对外确认部分写入','在刷库前停止进程并从可靠日志恢复','明确列出可恢复与不可恢复写入，符合成功承诺','返回成功的时刻决定系统已经承担的持久性责任'],
['CACHE-10','聚合缓存失效','商品详情包含品牌表中的名称','只修改品牌后检查所有关联商品缓存','关联字段也在一致性预算内更新','失效映射必须覆盖所有数据依赖，不能只盯主表']
],end:'## 缓存策略的验收标准\n\n除了命中率，还应验收旧数据的最长可接受时间、失效积压年龄、回源保护和恢复能力。三种模式分配的是读写责任，真正的可靠性来自失败后仍能解释并恢复数据的机制。',refs:[['Redis 数据结构基础','https://redis.io/docs/latest/develop/data-types/'],['本地延伸：Redis 持久化','Redis持久化机制/Redis持久化机制.md']]},
{
file:'基于Redis的snowflake id优化.md',scope:'经典 41/10/12 位布局及 Redis 节点协调；不承诺租约模型在任意暂停与故障切换下绝对唯一',
replace:[['这样 Redis 只承担节点注册和租约协调，单次生成 ID 仍然是内存操作，延迟稳定，也不会因为 Redis 短暂抖动导致所有业务无法发号。','这样 Redis 主要承担节点协调，健康租约内的单次发号可以是本地操作。但失去租约安全性后必须停止发号，不能承诺 Redis 故障完全不影响业务。'],['拿到序列后，对 Worker ID 数量取模，并把最终分配结果写入带 TTL 的实例键。','不能仅对序列取模就宣布分配成功：取模会绕回仍在使用的节点。必须对候选 Worker ID 做原子排他占用并核对持有者，且协调存储故障恢复仍有额外约束。']],
body:`## 先算容量，再讨论优化

一个正数 long 通常保留符号位，剩下的位数分配给相对时间、节点和毫秒内序列。41 位毫秒时间表示约 69.7 年，不是从 1970 年重新获得 69.7 年，而是从你选定的 epoch 开始计算。改变 epoch 会改变整个命名空间，不能在滚动发布时让新旧实例随意使用不同起点。

10 位节点支持 1024 个编码，12 位序列支持同节点同毫秒 4096 个值。乘以每秒一千毫秒得到的是理论编码容量，不是实际服务保证的 QPS。时钟精度、线程竞争、对象分配、输出队列和 CPU 调度都会降低吞吐。业务需要的是峰值下可接受的延迟与唯一性，不是纸面最大数字。

多个节点的 ID 大体按时间有序，但并不构成全局线性顺序。A 节点时钟略快，较晚生成的 B 节点 ID 可能更小；同毫秒不同 worker 位也影响排序。不要用 ID 大小证明跨服务事件先后，审计顺序应使用可靠事件时间与业务版本。

## Redis 租约至少包含三个不同身份

Worker ID 是编码空间中的短编号，instance token 是本次进程的随机身份，lease deadline 是本实例允许工作的安全期限。IP、Pod 名称和主机名只能帮助运维定位，不能替代随机持有者标识，因为容器会重建，地址会复用，同一机器也可能有多个进程。

申请一个候选节点可以使用 SET NX PX。成功后，续租和释放都必须比较 instance token，防止旧实例误操作新实例的租约。下面 Lua 只说明同一个 Redis 主节点上的原子条件操作；它不解决复制丢写、主从切换或不受限暂停问题。

~~~lua
-- renew.lua
-- KEYS[1]: snowflake:worker:17
-- ARGV[1]: instance token
-- ARGV[2]: lease ttl in milliseconds
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
return redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
~~~

~~~lua
-- release.lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
~~~

~~~text
STARTING -> ACQUIRING -> ACTIVE
ACTIVE -> RENEWING -> ACTIVE
ACTIVE -> LEASE_UNCERTAIN -> STOPPED
ACTIVE -> CLOCK_UNSAFE -> STOPPED
ACTIVE -> SHUTTING_DOWN -> RELEASED

STOPPED 不应直接靠一个布尔变量恢复到 ACTIVE。
重新工作需要重新验证 worker、租约和历史时间边界。
~~~

续租响应丢失时，客户端不知道 Redis 是否执行了续租。安全策略应宁可拒绝发号，也不把不确定成功当作成功。截止时间要保守地从请求开始前的单调时间计算，减去安全余量，而不是收到响应后再无条件延长整个 TTL；否则网络延迟会被错误计入可工作时间。Redis 的[分布式锁文档](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)解释了租约有效期和复制故障的一些基础限制，但发号唯一性仍需要自己的证明。

## 一个容易忽略的暂停反例

旧实例检查租约尚有效，随后发生长暂停；Redis 上租约到期，新实例拿到相同 worker；旧实例恢复，在真正提交发号之前没有被外部阻断。即使后台续租线程随后发现失效，旧实例已经可能生成一批 ID。把检查放得更靠近发号可以缩短窗口，但在允许任意长暂停的模型中，检查和使用之间仍存在间隙。

Fencing token 可以让下游拒绝旧持有者写入，但只有下游实际比较并拒绝过期代际才有效。把 token 放在日志里不产生保护；只把 worker 租约换个名字也不会让 64 位 ID 自动携带代际。若将代际编码到 ID，需要重新分配位数并处理代际回绕。如果最终数据库有唯一键，它能防止重复值落库，却不能保证发号 API 从不返回重复值。

更强要求下可以使用不自动复用的静态 worker 分配、具备明确一致性保证的协调服务，或数据库号段。号段把一段已持久保留的数字交给实例，本地消耗时不依赖时钟，但崩溃后未用完的号段通常需要作废；业务应接受空洞。这里的选择是容量、可用性与证明成本的权衡。

## 一个可审查的本地生成器

下面 Java 21 示例只实现“worker 已安全分配”的本地部分。遇到时钟回拨或序列耗尽直接拒绝，由上层按预算处理，避免示例隐藏无限自旋。LeaseGuard 是外部注入的安全检查接口；代码不声称这个检查本身足以解决前述任意暂停反例。

~~~java
import java.time.Clock;
import java.util.Objects;

public final class LocalSnowflake {
    public interface LeaseGuard {
        void ensureUsable();
    }
    private static final long WORKER_MAX = (1L << 10) - 1;
    private static final long SEQUENCE_MAX = (1L << 12) - 1;
    private static final long TIME_MAX = (1L << 41) - 1;
    private final Clock clock;
    private final LeaseGuard lease;
    private final long worker;
    private final long epochMillis;
    private long lastMillis = -1;
    private long sequence;

    public LocalSnowflake(long worker, long epochMillis,
                          Clock clock, LeaseGuard lease) {
        if (worker < 0 || worker > WORKER_MAX) {
            throw new IllegalArgumentException("worker out of range");
        }
        this.worker = worker;
        this.epochMillis = epochMillis;
        this.clock = Objects.requireNonNull(clock);
        this.lease = Objects.requireNonNull(lease);
    }

    public synchronized long nextId() {
        lease.ensureUsable();
        long now = clock.millis();
        long delta = Math.subtractExact(now, epochMillis);
        if (delta < 0 || delta > TIME_MAX) {
            throw new IllegalStateException("time outside epoch range");
        }
        if (now < lastMillis) {
            throw new IllegalStateException("clock moved backwards");
        }
        long nextSequence = now == lastMillis ? sequence + 1 : 0;
        if (nextSequence > SEQUENCE_MAX) {
            throw new IllegalStateException("millisecond capacity exhausted");
        }
        sequence = nextSequence;
        lastMillis = now;
        return (delta << 22) | (worker << 12) | sequence;
    }

    public static long workerOf(long id) {
        return (id >>> 12) & WORKER_MAX;
    }
    public static long sequenceOf(long id) {
        return id & SEQUENCE_MAX;
    }
    public long timeOf(long id) {
        return (id >>> 22) + epochMillis;
    }
}
~~~

从系统时钟抽象为 Clock，是为了测试回拨和同毫秒容量，不是为了绕开真实时钟问题。生产若选择等待下一毫秒，应使用有界等待、处理中断，并避免所有线程持锁空转。小回拨等待要纳入接口 P99，大回拨应立即进入不健康状态。不能把 lastMillis 简单设置为当前较小值继续工作，否则同一 worker 的时间与序列空间可能重用。

实例重启后内存中的 lastMillis 丢失。新进程即使抢到了同一 worker，也可能在时钟回拨期间重用旧时间片。因此需要持久高水位、延迟复用、代际编码或不复用分配等额外约束。仅对正在运行的单进程做一百万次唯一性测试，验证不到重启后的问题。

## ID 进入接口和数据库后的问题

Java long 的整数可以超过 JavaScript Number 的安全整数范围。前后端通过 JSON 交换时，用字符串表达 ID，避免浏览器解析后悄悄改变末尾数字。数据库列应选择匹配的有符号 BIGINT，并防止框架把它转成浮点。CSV、电子表格导出也要考虑科学计数法和精度截断。

趋势递增主键有利于某些索引插入模式，但不意味着把时间排序、创建时间和主键混为一体。公开 ID 可能泄露大致生成时间和业务规模，若产品不希望暴露这些信息，可使用单独的外部随机标识。唯一 ID 与连续业务单号更是不同概念：后者常常有按日重置、审计和补号规则，不能直接拿 Snowflake 替代。

监控至少包括活跃 worker 数、申请冲突、剩余租约安全时间、续租耗时、回拨幅度、拒绝发号数、同毫秒容量耗尽与数据库唯一键冲突。出现重复时保存解码后的 epoch、worker、序列和实例身份，而不是只保存一长串数字。`,
lab:'对生成器使用可控制的时钟，对租约协调使用隔离 Redis。并发采样只证明被测运行没有发现重复，暂停、重启与故障切换必须单独建模验证。',
cases:[
['ID-01','同毫秒容量','固定 Clock 在一个毫秒且 worker 不变','连续请求超过 4096 个 ID','前 4096 个唯一，随后拒绝或按明确策略等待','序列空间有限，不能通过位掩码回绕继续发号'],
['ID-02','小幅回拨','生成器已经记录较新的 lastMillis','将测试时钟向后移动少量毫秒','出现明确拒绝或有界等待，不能默默回退时间','同一 worker 重用时间片会威胁唯一性'],
['ID-03','节点并发申请','多个实例同时申请相同候选 worker','并发执行 SET NX 并记录 instance token','同一主节点正常运行时最多一个申请成功','申请必须原子占用，INCR 后取模不构成排他所有权'],
['ID-04','旧持有者续租','旧租约已结束且新实例拥有该 worker','旧实例携带旧 token 执行续租脚本','脚本返回失败且不延长新实例租约','比较持有者能防止过期客户端修改当前所有者状态'],
['ID-05','旧持有者释放','新旧实例曾先后使用同一 worker','旧实例延迟执行释放脚本','新实例的租约仍存在','无条件 DEL 会删除他人租约，释放同样需要所有权检查'],
['ID-06','续租响应丢失','续租请求可能到达 Redis 但响应被丢弃','让本地安全截止时间推进至失效','实例停止发号并暴露不确定租约状态','网络超时既不能证明执行失败，也不能证明可以继续工作'],
['ID-07','长暂停复用','旧实例检查后暂停，新实例重新获得 worker','恢复旧实例并验证下游代际或拒绝机制','能说明旧实例怎样被阻止，否则标记设计不满足该故障模型','检查和使用之间的暂停窗口不能仅靠后台心跳消除'],
['ID-08','重启与回拨','实例已发过某时间片，内存状态随后丢失','重启并把时钟设置到之前时间','保护机制阻止历史时间空间被再次使用','单进程 lastMillis 不会自动跨重启保存'],
['ID-09','前端精度','ID 大于 Number 的安全整数上界','通过 JSON 字符串传入浏览器再原样回传','每一位数字保持不变','存储唯一性正确也可能在传输层被浮点转换破坏'],
['ID-10','时间位耗尽','测试时钟接近 epoch 加可表达上限','推进到时间范围之外','拒绝生成而不是溢出符号位或覆盖其他字段','位分配决定系统寿命，边界检查必须是显式逻辑']
],end:'## 优化的前提是可证明的身份边界\n\nRedis 协调减少了每次发号的网络成本，但把正确性集中到 worker 生命周期。先明确允许多长暂停、协调存储怎样故障、worker 怎样复用，再决定本地发号是否合适。若这些条件无法建立，号段或独立发号服务可能更容易解释和维护。',refs:[['Redis 分布式锁与租约限制','https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/'],['本地延伸：分库分表','分库分表实战.md']]}
];
for(const a of articles)console.log(writeArticle(a));
