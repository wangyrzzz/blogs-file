const fs=require('node:fs');const path=require('node:path');
const additions={
'3种常用的缓存读写策略详解.md':`## 多级缓存中的版本与失效广播

本地缓存可以降低网络延迟，却让一个逻辑对象产生许多副本。应用实例 A 更新数据库并删除 Redis 后，实例 B 的本地缓存仍可能返回旧值。仅监听 Redis Key 过期通知也不是可靠失效协议，因为通知可能丢失，订阅者重启期间也不会自动补发。需要强于短 TTL 的一致性时，使用可重放事件、版本校验或读侧权威检查，并明确失效消息丢失后的最长收敛时间。

版本可以是数据库中随业务更新递增的字段。读者将版本和快照一起缓存，写者发送失效版本。接收方若当前版本更高，可以忽略旧事件；若当前版本较低，就删除或刷新。事件顺序不可靠时，这种比较有助于避免倒退。但缓存不存在时仍需要决定如何保存高水位，否则旧回填可能在淘汰之后再次进入。高水位本身的 TTL、容量和恢复也成为系统状态的一部分。

不要把数据库更新时间当成天然严格版本。两次更新可能落在相同时间精度内，不同数据库节点时钟也可能不一致。业务 version 必须在权威写入时原子推进，缓存构建又要从同一个数据快照获得它。若快照由多张表组成，一个主表 version 未必覆盖关联表变化，需要聚合版本或明确的依赖失效机制。

## 恢复阶段的缓存预热

Redis 恢复以后，空缓存会让数据库继续承受较高流量。全量预热则可能扫描大量冷数据，把本来还能工作的数据库拖慢。更合理的办法是按近期访问热度、关键业务和容量预算预热，并对每批回源设置并发和速度上限。预热任务与用户请求共享数据库资源时，应有低优先级预算，不能与在线交易争抢全部连接。

热点逻辑过期模型保留旧值和刷新时间，允许读取旧快照同时由一个执行者刷新。它适合可容忍短暂过期的数据，但刷新持续失败时必须有最大陈旧时间。超过阈值后是返回错误、隐藏字段还是改读权威来源，应由业务决定。永远返回旧值会把依赖故障伪装成正常服务。

~~~yaml
cache_policy_example:
  object: product-detail
  authority: relational-database
  version_source: aggregate-version-in-authoritative-transaction
  read_modes:
    catalog_browse: bounded-staleness
    checkout_validation: authoritative-read
    writer_read_after_update: authoritative-read-until-version-visible
  invalidation:
    delivery: durable-outbox-consumer
    replay: idempotent-delete-or-version-check
    reconciliation: compare-sampled-cache-and-database-versions
  recovery:
    origin_concurrency: separately-budgeted
    warmup_order: recent-hot-objects-first
    negative_cache: only-confirmed-not-found
    stale_limit: explicitly-defined-by-business
~~~

这不是任何框架的现成配置，而是设计评审用的策略表。把同一对象在不同操作下的读模式写出来，可以避免开发者在结算接口复用一个只适合展示页的缓存方法。方法名也应体现语义，例如 findDisplaySnapshot 与 loadForSettlement，比统一叫 getProduct 更不容易被误用。

最后要防止缓存键泄露数据边界。相同商品编号可能在不同租户有不同售价，Key 必须包含影响内容的租户、语言或渠道维度。维度越多，命中率与容量越需要重新评估；遗漏维度可能造成跨用户数据混淆，加入所有请求字段则又会把缓存退化成每次请求一个新 Key。选择维度的依据是它是否真正影响缓存结果。
`,
'ConcurrentHashMap 源码分析.md':`## 安全发布与值对象不可变性

把一个新对象放进 ConcurrentHashMap 后，其他线程通过对应映射读取到它，可以依赖容器公开的可见性契约观察插入前建立的状态。但这不意味着插入之后对对象的普通字段修改也自动获得同步。比如 UserProfile 在放入 Map 后被另一个线程直接修改昵称和等级，读者可能看见缺少一致性约束的组合。容器保护的是映射关系，value 的后续生命周期仍需自己的规则。

一种简单设计是把 value 定义成不可变 record，每次更新创建完整新对象并通过 replace 或 compute 原子替换。这样读取者拿到的是一份内部一致的对象。若对象非常大、更新频繁，复制成本可能不可接受，可以改用锁保护的可变聚合或拆分字段，但要重新定义哪些字段必须一起变化，不能仅凭每个字段各自原子就认为整体规则成立。

~~~java
record Profile(String name,int level,long version) {}

ConcurrentHashMap<String,Profile> profiles=new ConcurrentHashMap<>();
profiles.put("user-42",new Profile("Alice",1,0));
profiles.compute("user-42",(key,current) -> {
    if (current==null) throw new IllegalStateException("profile missing");
    return new Profile(current.name(),current.level()+1,current.version()+1);
});

Profile expected=profiles.get("user-42");
Profile replacement=new Profile("Alice Chen",expected.level(),expected.version()+1);
boolean changed=profiles.replace("user-42",expected,replacement);
// changed=false 时需重新读取和处理冲突，不能假装更新成功。
~~~

这段 replace 使用 value 的相等语义，record 会比较字段；若业务需要区分内容相同但历史不同的状态，version 应参与比较。不要在 compute 里同时更新另一个 Map 并假设两张表形成事务，任何中间异常都可能留下部分结果。

## 性能实验避免把测试工具当瓶颈

多个工作线程争抢同一个原子计数器来记录每次操作，会在被测 Map 外又制造热点。每次操作打印日志也会让 I/O 成为主导。正式基准应使用成熟基准框架、预热、独立进程和合适统计方法，并根据真实业务分别测试读多写少、同 Key 热点、均匀 Key、扩容阶段与大 value。

初始容量更大通常减少扩容，却会增加数组内存和缓存压力，不能越大越好。读多写少且配置整体替换的场景，有时用不可变 Map 加原子引用发布更容易保证整表一致快照；它与 ConcurrentHashMap 的逐 Key 更新提供不同语义。需要有序范围检索时，应评估有序并发结构，而不是遍历 CHM 后每次全量排序。

还要关注对象分配和 GC。不断构造短命 Key、装箱数字或替换大对象，会增加应用层成本，这些不一定出现在 Map 方法自身的热点里。性能结论应同时保留堆分配、线程等待和 CPU 证据，避免把任何延迟都归因于 synchronized 或 CAS。
`,
'乐观锁、悲观锁和CAS.md':`## 重试策略需要描述停止条件

乐观锁失败后无上限重试，会把业务热点变成数据库和 CPU 热点。停止条件至少可以来自尝试次数、总耗时和上游剩余预算。对人工编辑页面，直接返回版本冲突并让用户合并修改，往往比自动覆盖更符合意图；对可重新计算的库存申请，可以有限重试；对已经触发外部扣款的流程，先查询幂等结果更重要。

退避时间加入随机抖动，可以减少同一批失败者同步再次竞争，但它不改变业务正确性。不能认为睡眠后就必然拿到锁或版本仍然有效。每次尝试都要重新读取必要状态，重新计算业务结果，再提交带条件的写入。记录冲突次数时区分真实版本变化、资源缺失和业务条件不足，避免把正常库存不足算成数据库异常。

~~~java
// 领域伪代码：repository 与 command 由业务项目提供。
UpdateResult updateWithBudget(Command command,long deadlineNanos) {
    int maxAttempts=3;
    for (int attempt=1;attempt<=maxAttempts;attempt++) {
        if (System.nanoTime()>=deadlineNanos) return UpdateResult.timeout();
        Snapshot current=repository.load(command.resourceId());
        if (current==null) return UpdateResult.notFound();
        ProposedChange proposed=domainRules.calculate(current,command);
        if (!proposed.allowed()) return UpdateResult.rejected();
        if (repository.compareAndUpdate(current.version(),proposed)==1) {
            return UpdateResult.success();
        }
        metrics.recordConflict(attempt);
        if (attempt<maxAttempts) {
            backoffWithinDeadline(attempt,deadlineNanos);
        }
    }
    return UpdateResult.conflict();
}
~~~

这个方法只有在 calculate 没有不可重复外部副作用时才适合自动重试。若它发送短信或调用支付，就应把副作用移到成功提交后的可靠事件中，或者以独立幂等键保护。网络异常也不能简单与 affected rows=0 等价：前者可能表示结果未知，需要查询或由数据库幂等约束收敛。

## 公平性、饥饿和延迟分布

互斥锁可能让线程等待，CAS 可能让某个线程反复失败，两者都需要关注尾延迟与饥饿。总体吞吐提高但少数请求始终抢不到资源，对于交互接口可能不可接受。公平锁可以改善某些排队特征，却不保证操作系统调度和整个业务链绝对公平，通常还会付出吞吐成本。

无锁算法不意味着所有线程都保证在固定步数内完成。讨论 lock-free、wait-free 等进度性质时，应限定到具体算法，不能因为用了一个 AtomicReference 就声称整个服务无等待。算法内部的内存分配、日志、远程调用和回调代码都可能阻塞。

数据库层同样需要超时和取消策略。请求客户端已经离开，不代表数据库事务自动结束；应用应正确传播取消或及时关闭资源，并确保连接归还前提交或回滚。否则一个被用户放弃的请求仍可能持锁，影响之后大量正常请求。并发控制的设计范围应覆盖资源获得、业务执行、异常和释放四个阶段。
`,
'基于Redis的snowflake id优化.md':`## 把唯一性检查分成编码验证和故障验证

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
`,
'基于Gitlab的CI_CD.md':String.raw`## 让发布清单与镜像内容一起流转

构建脚本不应仅输出一个可变标签。可以在镜像推送成功后读取实际 digest，生成 dotenv 供后续 Job 使用，同时保存 JSON 清单用于人工审计。dotenv 中不要写秘密，只放产物地址和非敏感元数据。下游部署必须消费同一流水线传来的清单，而不是重新按标签猜测 digest。

下面是镜像已在受控构建环境中完成推送后的发布记录片段。变量由 Runner 或构建系统提供，命令需要在具有 Docker CLI 且能查询相应镜像的环境中运行；它不负责配置 dind，也不授予任何额外权限。

~~~bash
#!/usr/bin/env bash
set -euo pipefail

test -n "$CI_REGISTRY_IMAGE"
test -n "$CI_COMMIT_SHA"
test -n "$CI_PIPELINE_ID"

image_tag="$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"
docker pull "$image_tag"
release_image="$(docker image inspect --format '{{index .RepoDigests 0}}' "$image_tag")"
case "$release_image" in
  *@sha256:*) ;;
  *) echo 'registry digest unavailable' >&2; exit 1 ;;
esac
printf 'RELEASE_IMAGE=%s\n' "$release_image" > release.env

# JSON 应通过可靠序列化器生成，避免 shell 拼接任意字符串。
export RELEASE_IMAGE="$release_image"
node <<'NODE'
const fs=require('node:fs');
const manifest={
  commit:process.env.CI_COMMIT_SHA,
  pipelineId:process.env.CI_PIPELINE_ID,
  image:process.env.RELEASE_IMAGE,
  createdAt:new Date().toISOString(),
  verificationStatus:'awaiting-deployment-verification'
};
fs.writeFileSync('release-manifest.json',JSON.stringify(manifest,null,2)+'\n');
NODE
~~~

示例构建环境同时需要 Node，实际团队可以用 Python、jq 或构建工具的原生输出实现同样目标。多架构镜像需要确认记录的是期望的 manifest list digest 还是某个平台 digest，不要把本机拉取的平台结果误当成全部平台发布身份。

## 手工发布也应遵守同一套约束

紧急修复常常绕开日常路径，直接在终端执行 kubectl set image。若团队允许应急操作，仍应记录提交、镜像、配置、操作者与验证结果，并把最终状态同步回声明式配置来源，否则下一次自动部署可能又覆盖应急修改。手工操作不是免除审计和回滚要求的理由。

环境保护可以要求审批，但审批本身不验证代码或数据库兼容性。审批者应该看到具体镜像、变更摘要、迁移阶段和验证证据，而不是只有一个绿色按钮。流水线中任何可变输入都应在发布前冻结或记录，确保批准的是实际将要部署的内容。

## 依赖供应链与可重建性

固定基础镜像 digest 可以防标签漂移，但并不自动固定 Maven 下载的所有依赖。快照版本、动态版本范围和不受控镜像仓库仍会影响产物。业务允许时使用确定依赖版本与受控仓库，保留依赖清单和漏洞扫描结果。扫描发现问题后也需要评估实际暴露面与升级兼容，不能把扫描报告本身当成修复完成。

构建机器的时区、文件编码和默认 locale 也可能进入测试与产物。把这些设置显式化，能减少“本地成功、Runner 失败”的歧义。需要严格可复现构建时，还要控制归档时间戳、生成文件顺序和构建元数据；仅把源码 checkout 到同一提交，并不能保证字节完全一致。
`,
'Redis 3 种特殊数据类型详解.md':`## 把统计口径写进 Key 与元数据

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
`,
'分库分表实战.md':`## 路由元数据本身也是关键数据

采用逻辑桶映射后，路由表决定请求去哪里，它的错误可能影响全部数据。路由变更应有版本、校验和、审批记录与分发确认，客户端缓存应明确刷新策略。不能在多个配置中心各维护一份独立映射，再希望它们永远一致。服务启动时可检查路由版本与可访问分片集合，发现缺片时按业务契约拒绝相关操作。

迁移期间可以在请求日志记录 routeVersion、logicalBucket 和 physicalShard，用于解释同一订单为何在不同阶段访问不同位置。不要记录敏感完整 SQL 参数。旧路由实例未下线时，源片的写入栅栏应拒绝过期写者，避免新旧两边都认为自己是权威。只推送新配置却不限制旧写入，是常见的数据分叉原因。

~~~json
{
  "routeVersion": 7,
  "logicalBucketCount": 1024,
  "mappingPolicy": "explicit-bucket-to-physical-shard",
  "migration": {
    "bucket": 42,
    "source": "ds0.orders_0002",
    "target": "ds2.orders_0002",
    "phase": "VALIDATING",
    "writeAuthority": "source",
    "sourceFenceVersion": 6,
    "targetAppliedPosition": "recorded-change-stream-position",
    "rollbackRule": "do-not-switch-without-reconciling-new-writes"
  }
}
~~~

这不是某个中间件现成配置，而是路由控制面应掌握的信息示例。位点的实际格式随 CDC 产品变化，迁移状态也必须由可信控制流程推进。不要让业务请求传一个 routeVersion 就能自行选择历史分片，客户端可见版本只能辅助兼容，最终路由仍由服务端决定。

## 备份恢复需要按业务整体演练

每片都有备份，不意味着恢复后得到同一业务时刻。跨片事件在不同时间完成，独立恢复点可能造成一边有订单、一边没有对应投影。恢复计划应定义可接受的时间差、事件重放和业务对账方式。对于要求一致快照的分析，可以从受控同步管道建立专用快照，而不是随意组合各片最新备份。

Schema 变更也有中间态：部分分片已加列、部分尚未完成。应用需要兼容这一阶段，迁移执行器记录每片状态，失败后可从未完成片继续。把所有 DDL 一次提交到每片而不记录结果，会使运维无法判断哪些片成功、哪些片需要重试。扩容带来的不是只有存储空间，还有成倍的变更和恢复管理责任。
`,
'WebSocket长连接会话.md':`## 客户端重连也需要一个状态机

客户端可以显式区分 DISCONNECTED、CONNECTING、AUTHENTICATING、RECOVERING、OPEN 和 CLOSING。网络恢复事件、定时重试和用户主动刷新可能同时触发连接，因此只能有一个当前连接代际。新连接建立后，旧连接迟到的 onclose 不能把整个客户端重新改成断线状态，更不能启动第二套重连定时器。

每次连接创建一个 generation，回调先检查自己是否仍是当前代际。主动退出登录应停止重连并清理认证信息，不能把服务端正常关闭都理解成需要无限重试。认证失败、权限撤销与暂时网络错误属于不同分类，只有后者适合自动退避重连。

~~~text
DISCONNECTED -- retry timer --> CONNECTING
CONNECTING -- handshake accepted --> AUTHENTICATING
AUTHENTICATING -- identity accepted --> RECOVERING
RECOVERING -- snapshot/replay complete --> OPEN
OPEN -- network lost --> DISCONNECTED
OPEN -- user logout --> CLOSING --> DISCONNECTED(no automatic retry)
AUTHENTICATING -- invalid credentials --> DISCONNECTED(wait for user action)

Every callback checks connectionGeneration before mutating shared state.
Every timer belongs to one generation and is cleared when that generation ends.
Business messages are not applied before recovery establishes its watermark.
~~~

页面刷新会丢失内存水位，是否写入浏览器持久存储取决于隐私与多账号切换规则。水位应按租户、用户和设备空间隔离，退出后清理，避免新账号沿用旧账号位置。持久化水位过新或被篡改时，服务端仍要校验，不应允许跳过必须同步的数据。

最终一致的页面往往可以采用“先展示缓存快照，再连接并恢复”的体验，但要标记数据新鲜度，避免用户在旧状态上执行已不允许的操作。任何取消、付款等写动作仍通过权威接口校验，不能因为刚收到一条 WebSocket 状态就放弃服务端条件判断。

无论使用原生 WebSocket、STOMP 还是其他上层封装，都需要弄清订阅确认、业务 ACK、心跳与重连的具体语义。上层协议可以减少实现代码，却不会自动解决应用的水位、数据权限和过期历史问题。验收应观察真实断网、后台休眠与多标签页场景，而不是只在同一局域网连续发送几条消息。
`
};
function append(file,extra){const p=path.resolve(__dirname,'..',file);let s=fs.readFileSync(p,'utf8');if(!s.includes(extra.split('\n')[0]))s=s.replace('\n## 故障注入与验收实验','\n'+extra+'\n## 故障注入与验收实验');fs.writeFileSync(p,s);}
for(const [file,extra]of Object.entries(additions))append(file,extra);
module.exports={append};
