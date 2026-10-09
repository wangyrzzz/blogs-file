# ConcurrentHashMap 源码分析

> 阅读范围：以 OpenJDK 8u 的桶级结构讲实现、以 Java 21 API 核对公开契约；源码行号随 tag 变化。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


`ConcurrentHashMap` 是 Java 并发包中常用的线程安全 Map。它的实现随着 JDK 版本变化较大：JDK 7 主要采用分段锁，JDK 8 及之后以数组、CAS、局部 synchronized 和红黑树为核心。本文以 JDK 8 的设计为主，阅读源码时要先确认运行时 JDK 版本。

## 核心结构

JDK 8 中，表结构可以抽象为：

```java
transient volatile Node<K,V>[] table;

static class Node<K,V> {
    final int hash;
    final K key;
    volatile V val;
    volatile Node<K,V> next;
}
```

数组槽位通常保存链表，链表过长且容量达到条件后会树化为红黑树。桶中的节点通过 `volatile` 和 CAS 保证可见性与部分更新的原子性。

## 为什么不允许 null

`ConcurrentHashMap` 不允许 null key 和 null value。并发读取时，`get(key)` 返回 null 可能表示“没有映射”，也可能表示“映射值为 null”，这会造成歧义。禁止 null 让返回值语义保持清晰，也减少并发判断的复杂度。

## get 的读取流程

读取大致经历：

1. 计算 key 的 hash，并做扰动；
2. 根据 `(n - 1) & hash` 定位桶；
3. 读取首节点；
4. 命中则比较 hash 和 key；
5. 未命中则遍历链表或进入树结构查找；
6. 遇到扩容转发节点时，沿新表查找；普通 get 不承担迁移工作。

`get` 不需要锁，依赖数组、节点字段和 value 的可见性保证读到结构上有效的数据。无锁不等于没有成本，热点冲突、长链表和扩容仍会影响延迟。

## put 的流程

简化后的 `putVal` 逻辑如下：

```text
表为空 -> 初始化
桶为空 -> CAS 放入新节点
桶正在扩容 -> 协助扩容
桶非空 -> 对桶头加锁，在链表/树中查找或更新
元素数量达到阈值 -> 尝试扩容或树化
```

空桶使用 CAS，可以避免所有线程在初始化阶段竞争同一把锁；同一个桶发生冲突时，只锁定该桶的头节点，不会阻塞其他桶的更新。`synchronized` 的锁粒度因此比“整张表一把锁”小得多。

## 扩容与协助迁移

容量通常按 2 倍扩展。由于新容量是旧容量的 2 倍，旧桶中的节点迁移到新表时，位置只可能是原下标，或原下标加旧容量。源码把迁移任务拆成区间，多个线程可以通过 `transfer` 协助扩容。

扩容过程中，旧桶会放入 ForwardingNode，读写线程发现它后可以跳转到新表或参与迁移。这种设计缩短了单线程扩容的停顿，但扩容仍然会消耗 CPU 和内存，初始化容量应尽量接近实际规模。

## 链表树化

哈希冲突严重时，链表查询复杂度可能接近 O(n)。JDK 8 在节点数量达到树化阈值、且表容量已经足够大时把链表转成红黑树；如果表还很小，优先扩容而不是树化。节点数量缩小到较低阈值后，树也可能退化为链表，以减少小数据量下的结构开销。

树化不能掩盖糟糕的 hashCode 实现。业务 key 仍应提供稳定、均匀的 `hashCode` 和正确的 `equals`。

## size 与计数

高并发写入时，维护一个简单的全局计数器会产生热点。`ConcurrentHashMap` 使用类似分段计数的思路：低竞争时更新基础计数，高竞争时把增量分散到多个计数单元，读取时汇总。`size()` 是一个瞬时近似视图，不应拿它作为严格的业务锁或库存判断依据。

## 原子复合操作

`putIfAbsent`、`computeIfAbsent`、`merge` 等方法把“检查再更新”封装为更安全的复合操作：

```java
ConcurrentHashMap<String, LongAdder> counts = new ConcurrentHashMap<>();
counts.computeIfAbsent("page-1", key -> new LongAdder()).increment();
```

不要把其他 ConcurrentMap 实现的重试语义套用到这里：ConcurrentHashMap 的 computeIfAbsent 调用是原子的，存在映射时不计算，缺失时由本次调用执行计算。返回 null、抛异常或映射后来被删除，后续调用仍可能再次计算，所以它不是持久化的业务恰好一次执行器。需要严格一次执行的初始化动作，应另外设计锁、状态机或数据库约束。

## 使用边界

- `ConcurrentHashMap` 只保证 Map 操作的并发安全，不保证多个 Map 操作组合后的业务原子性；
- `containsKey` 后再 `put` 可能产生竞态，应使用 `putIfAbsent`；
- 需要全局有序遍历时，它不是合适的数据结构；
- 需要严格一致的库存、余额和扣减逻辑时，应使用数据库约束和事务；
- 读多写少且不修改的配置可考虑不可变 Map，降低并发复杂度。


## 阅读源码先固定三个问题

第一个问题是读者在哪里观察到一条映射；第二个问题是两个写者竞争时谁赢；第三个问题是表在扩容时读写怎样继续。带着这三个问题读 get、putVal 和 transfer，比逐行背诵变量更有效。源码版本需要固定到准确 tag，JDK 7 的 Segment 和 JDK 8 之后的桶级结构不要混在同一张图里。Java 21 的公开并发语义见[ConcurrentHashMap API](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ConcurrentHashMap.html)。

实现细节可以演进，调用方应依赖的是单 Key 操作的原子性、非空读取与对应更新之间的可见性关系，以及迭代和聚合不是整张表一致快照的事实。即使未来内部同步方式变化，这些契约仍是应用正确性的基础。

## hash 扰动与数组位置

数组容量采用二的幂，有利于用位与计算位置。高位参与扰动，是为了让只在高位不同的 hashCode 也能影响较小数组的下标。它不创造信息：如果所有 Key 的 hashCode 都是同一个常数，再复杂的扰动也无法把它们平均分开。

~~~java
// 教学等价表达，不是粘贴某一源码版本的完整实现。
static int spreadForStudy(int hash) {
    return (hash ^ (hash >>> 16)) & 0x7fffffff;
}
static int indexForStudy(int hash, int length) {
    if (length <= 0 || (length & (length - 1)) != 0) {
        throw new IllegalArgumentException("power-of-two length required");
    }
    return spreadForStudy(hash) & (length - 1);
}
~~~

Key 的 equals 与 hashCode 需要在存入后保持稳定。把可变对象字段用于 hashCode，随后修改字段，即使 Map 内部完全线程安全，也可能无法再按新 hash 找回原记录。这是 Key 契约被破坏，不是扩容把元素丢了。通常使用不可变 record 或稳定业务标识更清楚。

## putVal 的三个竞争入口

表尚未初始化时，线程需要协调初始化权；桶为空时，可以尝试 CAS 安装新节点；桶非空时，先识别是否处于迁移状态，否则进入该桶的同步区。获取锁后还要重新确认桶头没有变化，因为从读取桶头到获取锁之间，其他线程可能已经完成结构变化。

~~~text
写入 k,v
  -> 表是否存在？否：协调初始化
  -> 定位桶 i
  -> 桶为空？是：CAS 放入节点；失败则重新观察
  -> 桶为 ForwardingNode？是：帮助迁移并转向新表
  -> 锁住观察到的桶头
       -> 再次检查桶头身份
       -> 遍历链表或查找树节点
       -> 已存在则替换 value，否则增加节点
  -> 释放桶锁
  -> 更新计数，按条件触发树化或扩容
~~~

锁粒度变小不等于写入永远互不阻塞。不同 Key 如果散列到同一个桶，仍会竞争同一结构；在计算函数里执行远程调用，会把网络延迟带进相关桶的更新路径。统计整体 CPU 很空闲但部分请求长时间等待时，应观察 Key 分布和线程栈，不能只增加线程数量。

## 为什么 get 能读到有效结构

节点的 key 和 hash 在构造后保持不变，value、next 以及表元素访问具有对应的可见性安排。读操作可以在写入前后看到合法状态，而不必获取写者的桶锁。但这不意味着读到的是整张表某个统一时刻的状态。先读账户 A 再读账户 B，两次读取之间完全可能发生转账；Map 不会为跨 Key 业务提供事务。

扩容时 ForwardingNode 告诉读者到新表继续找。读者不是必须等待全部迁移完成，也不是 get 遇到迁移就开始搬运节点。写线程参与迁移能够分摊工作，但仍要申请更大数组、分配部分节点并更新结构，扩容不是免费操作。根据实际元素规模预估初始容量，常常比发生抖动后盲目加线程有效。

## transfer 的低位与高位拆分

旧容量为 n，新容量为 2n 时，一个旧桶内元素的新位置只会是 i 或 i+n，因为只多考察 hash 的一个位。迁移可以把链表分成低位组和高位组，再安装到两个新位置。多个线程领取不同区间，不需要所有人重复扫描整张表。

~~~text
old length = 16, old index = 3
hash & 16 == 0 -> new index = 3
hash & 16 != 0 -> new index = 19

迁移完成的旧桶:
  table[3] -> ForwardingNode(nextTable)
新表对应位置:
  nextTable[3]  -> low group
  nextTable[19] -> high group
~~~

sizeCtl 等内部字段在不同阶段可能编码阈值或迁移协调信息，不应简单理解为一直存放一个容量值。阅读这类变量时要先标注状态：未初始化、正常工作、正在扩容。否则把一个阶段的数值解释套用到另一个阶段，会产生“为什么是负数”的困惑。

## 树化阈值不能脱离表容量

JDK 8 的常见常量包含树化阈值 8、反树化阈值 6、最小树化容量 64，但不能据此写出“第八个元素一定立刻变红黑树”的通用判断。触发点还与插入分支、计数方式和表容量有关。小表优先扩容，迁移后的树也可能因为拆分规模变小而退化；删除路径的判断细节应按具体源码阅读。

树化缓解冲突，却不能保证所有恶意 Key 的查找都像理想平衡树一样只比较对数次。Key 是否可比较、hash 是否相同和查找规则都影响代价。测试应构造碰撞 Key 再看实际行为，避免把平均复杂度当成每个输入的硬保证。

## 一个复合操作对照程序

下面代码在 Java 21 可直接放入同名文件运行。它用栅栏强制所有工作者先观察到“尚未存在”，说明安全方法的组合仍然可以构成竞态。第二组使用 putIfAbsent，只将成功建立映射的线程计为获胜者。

~~~java
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

public class ConcurrentMapLab {
    public static void main(String[] args) throws Exception {
        run(false);
        run(true);
    }
    static void run(boolean atomic) throws Exception {
        int workers=8;
        ConcurrentHashMap<String,String> map=new ConcurrentHashMap<>();
        CyclicBarrier barrier=new CyclicBarrier(workers);
        AtomicInteger winners=new AtomicInteger();
        try (ExecutorService pool=Executors.newFixedThreadPool(workers)) {
            List<Future<?>> futures=new ArrayList<>();
            for (int i=0;i<workers;i++) {
                final String owner="worker-"+i;
                futures.add(pool.submit(() -> {
                    boolean absent=!map.containsKey("job-1");
                    barrier.await(5,TimeUnit.SECONDS);
                    if (atomic) {
                        if (map.putIfAbsent("job-1",owner)==null) {
                            winners.incrementAndGet();
                        }
                    } else if (absent) {
                        map.put("job-1",owner);
                        winners.incrementAndGet();
                    }
                    return null;
                }));
            }
            for (Future<?> f:futures) f.get();
        }
        System.out.println("atomic="+atomic+", winners="+winners.get()
                +", mappings="+map.size());
        if (atomic && winners.get()!=1) throw new AssertionError();
        if (!atomic && winners.get()!=workers) throw new AssertionError();
    }
}
~~~

这不是完整任务调度器：进程退出后 Map 会丢失，任务拥有者超时、执行副作用和恢复都没有解决。putIfAbsent 提供的是当前进程内的映射原子建立，不能直接外推为跨实例任务恰好执行一次。

## computeIfAbsent 与缓存加载

计算函数应短小，不修改同一个 Map 的其他映射，更不能形成递归初始化循环。返回 null 不建立映射，下一次调用可能重新计算；抛异常也不会永久缓存失败。若加载需要网络，考虑把 Future 作为值、限制加载并发，并设计失败后移除与重试。否则一个慢加载会让相关竞争持续积压。

Map 中存入 ArrayList 并不会让 ArrayList 自动安全。保护映射与保护 value 内部状态是两回事。可以用不可变对象替换值，使用线程安全 value，或额外同步。频率统计采用 LongAdder 时也要知道并发 sum 的快照边界。

size、isEmpty 和遍历适合监控与近似观察，不能用 size<100 然后 put 来实现严格容量限制。严格上限应使用信号量、锁或其他能够把检查与分配组合的机制。弱一致迭代不抛 ConcurrentModificationException，并不代表已经复制出一份稳定快照。

## 安全发布与值对象不可变性

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

## 故障注入与验收实验

先把公开 API 契约与源码实现细节分开。实验记录 JDK 完整版本，避免在运行时强反射内部结构造成模块访问错误后误判集合行为。

### CHM-01：检查再插入

实验前提是多线程共享空 Map 且拥有同一业务 Key。执行用栅栏让各线程先 containsKey 再 put。

通过条件是可复现多个业务获胜者但 Map 最终只有一条映射。这里的判断依据是单次方法安全不能组合成检查加写入的原子业务。

### CHM-02：原子占位

实验前提是使用相同 Key 和同样线程数量。执行改用 putIfAbsent 并统计返回 null 的次数。

通过条件是只有一个线程获得插入成功结果。这里的判断依据是原子方法把检查与映射建立放进同一并发操作。

### CHM-03：可变 Key

实验前提是Key 的 hashCode 依赖可修改字段。执行插入后修改字段，再尝试读取和删除。

通过条件是能够解释查找失败来自 Key 契约变化。这里的判断依据是并发容器不会跟踪外部对象的哈希变化并自动重新分桶。

### CHM-04：碰撞热点

实验前提是所有 Key 返回同一 hashCode。执行比较均匀 Key 与碰撞 Key 的更新延迟。

通过条件是热点竞争上升且不会被增加工作线程自动解决。这里的判断依据是桶级并发依赖合理散列，同桶操作仍需协调。

### CHM-05：慢计算

实验前提是computeIfAbsent 的函数被受控栅栏阻塞。执行并发访问相关 Key 并检查线程栈。

通过条件是识别计算路径带来的等待，不把它误判为网络线程不足。这里的判断依据是计算函数不是任意耗时副作用的安全容器。

### CHM-06：空结果再加载

实验前提是映射函数首次返回 null。执行再次调用 computeIfAbsent。

通过条件是后续调用可以再次执行函数。这里的判断依据是未建立映射意味着没有持久保存一次加载结果。

### CHM-07：异常后重试

实验前提是首次映射函数抛出受控异常。执行捕获后再次查询同一个 Key。

通过条件是后续调用按当前缺失状态重新计算。这里的判断依据是异常不会自动变成永久失败缓存。

### CHM-08：value 内部竞争

实验前提是多个线程拿到同一个非线程安全 List。执行并发修改 List 并与不可变替换方案比较。

通过条件是明确区分 Map 保护与 value 状态保护。这里的判断依据是容器不会递归赋予任意业务对象线程安全性。

### CHM-09：并发扩容读取

实验前提是初始容量较小且写者持续插入不同 Key。执行读者反复读取已经完成插入的固定映射。

通过条件是固定映射可正确读取，扩容成本通过指标观察。这里的判断依据是转发节点支持读者去新表查找，get 不需要参与搬迁。

### CHM-10：容量控制竞态

实验前提是Map 接近业务数量上限。执行并发执行 size 检查后 put。

通过条件是能复现超过上限并通过独立配额机制修复。这里的判断依据是聚合观察不提供检查加占位的全表事务。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "ConcurrentHashMap 源码分析",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "CHM-01",
      "scenario": "检查再插入",
      "given": "多线程共享空 Map 且拥有同一业务 Key",
      "when": "用栅栏让各线程先 containsKey 再 put",
      "then": "可复现多个业务获胜者但 Map 最终只有一条映射"
    },
    {
      "id": "CHM-02",
      "scenario": "原子占位",
      "given": "使用相同 Key 和同样线程数量",
      "when": "改用 putIfAbsent 并统计返回 null 的次数",
      "then": "只有一个线程获得插入成功结果"
    },
    {
      "id": "CHM-03",
      "scenario": "可变 Key",
      "given": "Key 的 hashCode 依赖可修改字段",
      "when": "插入后修改字段，再尝试读取和删除",
      "then": "能够解释查找失败来自 Key 契约变化"
    },
    {
      "id": "CHM-04",
      "scenario": "碰撞热点",
      "given": "所有 Key 返回同一 hashCode",
      "when": "比较均匀 Key 与碰撞 Key 的更新延迟",
      "then": "热点竞争上升且不会被增加工作线程自动解决"
    },
    {
      "id": "CHM-05",
      "scenario": "慢计算",
      "given": "computeIfAbsent 的函数被受控栅栏阻塞",
      "when": "并发访问相关 Key 并检查线程栈",
      "then": "识别计算路径带来的等待，不把它误判为网络线程不足"
    },
    {
      "id": "CHM-06",
      "scenario": "空结果再加载",
      "given": "映射函数首次返回 null",
      "when": "再次调用 computeIfAbsent",
      "then": "后续调用可以再次执行函数"
    },
    {
      "id": "CHM-07",
      "scenario": "异常后重试",
      "given": "首次映射函数抛出受控异常",
      "when": "捕获后再次查询同一个 Key",
      "then": "后续调用按当前缺失状态重新计算"
    },
    {
      "id": "CHM-08",
      "scenario": "value 内部竞争",
      "given": "多个线程拿到同一个非线程安全 List",
      "when": "并发修改 List 并与不可变替换方案比较",
      "then": "明确区分 Map 保护与 value 状态保护"
    },
    {
      "id": "CHM-09",
      "scenario": "并发扩容读取",
      "given": "初始容量较小且写者持续插入不同 Key",
      "when": "读者反复读取已经完成插入的固定映射",
      "then": "固定映射可正确读取，扩容成本通过指标观察"
    },
    {
      "id": "CHM-10",
      "scenario": "容量控制竞态",
      "given": "Map 接近业务数量上限",
      "when": "并发执行 size 检查后 put",
      "then": "能复现超过上限并通过独立配额机制修复"
    }
  ]
}
```

## 源码阅读的落点

理解空桶 CAS、冲突桶同步和迁移转发，是为了知道竞争在哪里发生。应用层还必须设计 Key 稳定性、value 安全性、跨 Key 原子性和持久化边界。把这些边界分清，ConcurrentHashMap 才能成为可靠的基础构件。

## 参考资料与继续阅读

- [Java 21 ConcurrentHashMap](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ConcurrentHashMap.html)
- [OpenJDK 8u 源码入口](https://github.com/openjdk/jdk8u/blob/master/jdk/src/share/classes/java/util/concurrent/ConcurrentHashMap.java)
- [本地延伸：HashMap](HashMap%20源码分析/HashMap%20源码分析.md)
