# 基于 Redis 的 Snowflake ID 优化方案

> 阅读范围：经典 41/10/12 位布局及 Redis 节点协调；不承诺租约模型在任意暂停与故障切换下绝对唯一。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


Snowflake 适合在应用本地高性能生成趋势递增的 64 位 ID，但它依赖机器时钟和 Worker ID 的唯一性。实际部署中，多实例扩缩容、容器重建和时钟回拨都可能造成重复或异常 ID。Redis 可以用来解决 Worker ID 分配和节点租约问题，但不建议让每一次发号都访问 Redis。

## Snowflake 的基本结构

经典 Snowflake 通常把一个 `long` 拆成四部分：

```text
符号位 | 时间戳差值 | 机器标识 | 序列号
```

以 1 位符号位、41 位毫秒时间戳、10 位 Worker ID、12 位序列号为例：

- 41 位时间戳可使用约 69 年；
- 10 位 Worker ID 支持 1024 个节点；
- 12 位序列号表示同一节点同一毫秒最多生成 4096 个 ID。

具体位数不是固定标准，应根据部署规模、生命周期和峰值 QPS 重新计算。

## Redis 应该放在哪一层

最常见的优化方式是：

1. 服务启动时向 Redis 申请一个 Worker ID；
2. 同时写入节点实例、过期时间和租约信息；
3. 应用进程在内存中使用 Worker ID 本地发号；
4. 后台线程定期续租；
5. 实例停止或租约过期后，Worker ID 才能重新分配。

这样 Redis 主要承担节点协调，健康租约内的单次发号可以是本地操作。但失去租约安全性后必须停止发号，不能承诺 Redis 故障完全不影响业务。

## Worker ID 分配

可以使用自增序列配合租约：

```text
INCR snowflake:worker:sequence
```

不能仅对序列取模就宣布分配成功：取模会绕回仍在使用的节点。必须对候选 Worker ID 做原子排他占用并核对持有者，且协调存储故障恢复仍有额外约束。更稳妥的方式是用 Lua 脚本完成“扫描空闲 ID、登记实例、设置 TTL”的原子操作，避免多个实例同时拿到同一个 ID。

登记信息至少包含实例 ID、进程启动时间、IP、租约过期时间和应用名。实例重启时不要只按 IP 判断身份，因为同一台机器上可能同时运行多个容器。

## 时钟回拨处理

生成 ID 时记录上一次时间戳 `lastTimestamp`：

- 当前时间大于上次时间：重置序列号；
- 当前时间等于上次时间：序列号递增；
- 当前时间小于上次时间：说明发生回拨。

回拨处理不能只写一句“等待时间追上”。建议按回拨幅度区分：小幅回拨可以等待到上次时间，大幅回拨则拒绝发号并告警，避免生成不可预测的 ID。不要通过 Redis 时间简单掩盖本机时钟问题，根因仍应交给 NTP、虚拟化平台和运维系统处理。

## 序列号溢出

同一毫秒内序列号达到最大值时，应等待下一毫秒，而不是循环覆盖：

```java
if (timestamp == lastTimestamp) {
    sequence = (sequence + 1) & sequenceMask;
    if (sequence == 0) {
        timestamp = waitNextMillis(lastTimestamp);
    }
} else {
    sequence = 0;
}
```

高峰期如果频繁等待，说明位分配或节点数量不适合当前流量。可以增加序列位、拆分业务域，或采用号段模式，而不是无限重试。

## 不要把 Redis 发号当成万能方案

如果业务只需要全局唯一，Redis 自增、数据库号段或 UUID 都可能更合适；如果需要严格连续编号，Snowflake 本身就不是合适选择。Snowflake 的 ID 具有趋势递增特性，但不保证严格连续，也不建议直接暴露其中的业务信息。

Redis 集群切换、租约误过期、应用长时间 GC 暂停都要纳入故障演练。若 Worker ID 被错误复用，时间戳和序列号完全相同的情况下可能产生重复，因此租约续期失败应及时让实例停止发号或切换到明确的故障模式。

## 上线前检查清单

- Worker ID 是否在所有实例间唯一；
- 扩缩容、重启和网络分区时是否会重复分配；
- 时钟回拨是否会被发现并告警；
- 序列号溢出时是否有上限和监控；
- Redis 不可用时，已运行实例是否能安全降级；
- ID 是否会进入数据库主键、缓存键和外部接口，长度与符号是否兼容。


## 先算容量，再讨论优化

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

监控至少包括活跃 worker 数、申请冲突、剩余租约安全时间、续租耗时、回拨幅度、拒绝发号数、同毫秒容量耗尽与数据库唯一键冲突。出现重复时保存解码后的 epoch、worker、序列和实例身份，而不是只保存一长串数字。

## 把唯一性检查分成编码验证和故障验证

生成一百万个 ID 放进 Set，能发现本次运行内的重复，却不能证明系统跨机器、跨重启和跨故障切换一直正确。首先测试编码性质：worker 与 sequence 解码是否还原输入、时间是否在范围内、每个 worker 的同毫秒序列是否覆盖合法范围。然后测试生命周期性质：重复分配、续租超时、重启回拨和协调节点故障。这两类测试的前提不同，应分别报告。

下面的 Java 片段可与前文 LocalSnowflake 放在同一目录编译。它只证明固定时钟下本地编码与拒绝策略，不证明 Redis 协调安全性。Clock.fixed 每次返回同一时刻，便于稳定地触发序列耗尽。

~~~java
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.Set;

public class SnowflakeEncodingLab {
    public static void main(String[] args) {
        long epoch=Instant.parse("2026-01-01T00:00:00Z").toEpochMilli();
        long now=epoch+123456789L;
        Clock fixed=Clock.fixed(Instant.ofEpochMilli(now),ZoneOffset.UTC);
        LocalSnowflake generator=new LocalSnowflake(17,epoch,fixed,() -> {});
        Set<Long> generated=new HashSet<>();
        for (int sequence=0;sequence<4096;sequence++) {
            long id=generator.nextId();
            if (!generated.add(id)) throw new AssertionError("duplicate id");
            if (LocalSnowflake.workerOf(id)!=17) throw new AssertionError("worker");
            if (LocalSnowflake.sequenceOf(id)!=sequence) throw new AssertionError("sequence");
            if (generator.timeOf(id)!=now) throw new AssertionError("time");
        }
        try {
            generator.nextId();
            throw new AssertionError("expected capacity rejection");
        } catch (IllegalStateException expected) {
            System.out.println("4096 unique ids; overflow rejected");
        }
    }
}
~~~

这里的空 LeaseGuard 只服务隔离编码实验，生产中绝不能照抄为真实租约策略。将协调安全性与编码安全性分开，能够防止一个本地测试通过的生成器被误宣传成完整分布式解决方案。

## 号段与时间型 ID 的可恢复性比较

数据库号段在领取时通过事务推进高水位，实例获得一段不会再分配给他人的区间。它可以容忍本机时钟变化，但实例崩溃后未使用数字通常浪费，号段续领服务也可能成为可用性依赖。Snowflake 在健康节点上无需每段续领，代价是时间与 worker 生命周期更复杂。UUID 则减少集中协调，代价可能是长度、索引局部性和展示格式。

严格连续编号还需要处理事务回滚、撤销与审计，不能由“唯一且趋势递增”替代。财务凭证等领域可能要求编号有独立状态和作废记录，允许看得见的空洞比偷偷复用号码更可审计。技术 ID 与业务编号分开后，存储主键可以选择适合性能的方案，业务单号则按领域规则管理。

最终应在接口文档中明确：ID 是否跨租户唯一、是否跨环境唯一、是否允许公开、是否可据此排序、是否可以出现空洞。测试环境和生产使用同一 epoch 与 worker 空间时，如果数据最终会汇总到一起，还要保证环境命名空间隔离。唯一性范围是业务契约，不能默认从一个 long 类型推断出来。

## 故障注入与验收实验

对生成器使用可控制的时钟，对租约协调使用隔离 Redis。并发采样只证明被测运行没有发现重复，暂停、重启与故障切换必须单独建模验证。

### ID-01：同毫秒容量

实验前提是固定 Clock 在一个毫秒且 worker 不变。执行连续请求超过 4096 个 ID。

通过条件是前 4096 个唯一，随后拒绝或按明确策略等待。这里的判断依据是序列空间有限，不能通过位掩码回绕继续发号。

### ID-02：小幅回拨

实验前提是生成器已经记录较新的 lastMillis。执行将测试时钟向后移动少量毫秒。

通过条件是出现明确拒绝或有界等待，不能默默回退时间。这里的判断依据是同一 worker 重用时间片会威胁唯一性。

### ID-03：节点并发申请

实验前提是多个实例同时申请相同候选 worker。执行并发执行 SET NX 并记录 instance token。

通过条件是同一主节点正常运行时最多一个申请成功。这里的判断依据是申请必须原子占用，INCR 后取模不构成排他所有权。

### ID-04：旧持有者续租

实验前提是旧租约已结束且新实例拥有该 worker。执行旧实例携带旧 token 执行续租脚本。

通过条件是脚本返回失败且不延长新实例租约。这里的判断依据是比较持有者能防止过期客户端修改当前所有者状态。

### ID-05：旧持有者释放

实验前提是新旧实例曾先后使用同一 worker。执行旧实例延迟执行释放脚本。

通过条件是新实例的租约仍存在。这里的判断依据是无条件 DEL 会删除他人租约，释放同样需要所有权检查。

### ID-06：续租响应丢失

实验前提是续租请求可能到达 Redis 但响应被丢弃。执行让本地安全截止时间推进至失效。

通过条件是实例停止发号并暴露不确定租约状态。这里的判断依据是网络超时既不能证明执行失败，也不能证明可以继续工作。

### ID-07：长暂停复用

实验前提是旧实例检查后暂停，新实例重新获得 worker。执行恢复旧实例并验证下游代际或拒绝机制。

通过条件是能说明旧实例怎样被阻止，否则标记设计不满足该故障模型。这里的判断依据是检查和使用之间的暂停窗口不能仅靠后台心跳消除。

### ID-08：重启与回拨

实验前提是实例已发过某时间片，内存状态随后丢失。执行重启并把时钟设置到之前时间。

通过条件是保护机制阻止历史时间空间被再次使用。这里的判断依据是单进程 lastMillis 不会自动跨重启保存。

### ID-09：前端精度

实验前提是ID 大于 Number 的安全整数上界。执行通过 JSON 字符串传入浏览器再原样回传。

通过条件是每一位数字保持不变。这里的判断依据是存储唯一性正确也可能在传输层被浮点转换破坏。

### ID-10：时间位耗尽

实验前提是测试时钟接近 epoch 加可表达上限。执行推进到时间范围之外。

通过条件是拒绝生成而不是溢出符号位或覆盖其他字段。这里的判断依据是位分配决定系统寿命，边界检查必须是显式逻辑。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "基于Redis的snowflake id优化",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "ID-01",
      "scenario": "同毫秒容量",
      "given": "固定 Clock 在一个毫秒且 worker 不变",
      "when": "连续请求超过 4096 个 ID",
      "then": "前 4096 个唯一，随后拒绝或按明确策略等待"
    },
    {
      "id": "ID-02",
      "scenario": "小幅回拨",
      "given": "生成器已经记录较新的 lastMillis",
      "when": "将测试时钟向后移动少量毫秒",
      "then": "出现明确拒绝或有界等待，不能默默回退时间"
    },
    {
      "id": "ID-03",
      "scenario": "节点并发申请",
      "given": "多个实例同时申请相同候选 worker",
      "when": "并发执行 SET NX 并记录 instance token",
      "then": "同一主节点正常运行时最多一个申请成功"
    },
    {
      "id": "ID-04",
      "scenario": "旧持有者续租",
      "given": "旧租约已结束且新实例拥有该 worker",
      "when": "旧实例携带旧 token 执行续租脚本",
      "then": "脚本返回失败且不延长新实例租约"
    },
    {
      "id": "ID-05",
      "scenario": "旧持有者释放",
      "given": "新旧实例曾先后使用同一 worker",
      "when": "旧实例延迟执行释放脚本",
      "then": "新实例的租约仍存在"
    },
    {
      "id": "ID-06",
      "scenario": "续租响应丢失",
      "given": "续租请求可能到达 Redis 但响应被丢弃",
      "when": "让本地安全截止时间推进至失效",
      "then": "实例停止发号并暴露不确定租约状态"
    },
    {
      "id": "ID-07",
      "scenario": "长暂停复用",
      "given": "旧实例检查后暂停，新实例重新获得 worker",
      "when": "恢复旧实例并验证下游代际或拒绝机制",
      "then": "能说明旧实例怎样被阻止，否则标记设计不满足该故障模型"
    },
    {
      "id": "ID-08",
      "scenario": "重启与回拨",
      "given": "实例已发过某时间片，内存状态随后丢失",
      "when": "重启并把时钟设置到之前时间",
      "then": "保护机制阻止历史时间空间被再次使用"
    },
    {
      "id": "ID-09",
      "scenario": "前端精度",
      "given": "ID 大于 Number 的安全整数上界",
      "when": "通过 JSON 字符串传入浏览器再原样回传",
      "then": "每一位数字保持不变"
    },
    {
      "id": "ID-10",
      "scenario": "时间位耗尽",
      "given": "测试时钟接近 epoch 加可表达上限",
      "when": "推进到时间范围之外",
      "then": "拒绝生成而不是溢出符号位或覆盖其他字段"
    }
  ]
}
```

## 优化的前提是可证明的身份边界

Redis 协调减少了每次发号的网络成本，但把正确性集中到 worker 生命周期。先明确允许多长暂停、协调存储怎样故障、worker 怎样复用，再决定本地发号是否合适。若这些条件无法建立，号段或独立发号服务可能更容易解释和维护。

## 参考资料与继续阅读

- [Redis 分布式锁与租约限制](https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/)
- [本地延伸：分库分表](分库分表实战.md)
