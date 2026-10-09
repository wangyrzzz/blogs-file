const {writeArticle}=require('./compose.cjs');
const articles=[{
file:'乐观锁、悲观锁和CAS.md',scope:'Java 21 原子类、进程内互斥与 MySQL InnoDB 单库并发控制',
replace:[['如果受影响行数为 0，说明版本已经变化，当前更新失败','如果受影响行数为 0，说明本次条件未满足，可能是版本变化，也可能是记录不存在或其他条件不满足，当前更新未成功']],
body:`## 用一笔库存扣减比较三种方案

假设仓库剩余十件商品，两个请求各购买六件。业务不变量是库存不得为负，成功购买数量不能超过初始库存。这个定义比“方法必须线程安全”更具体，因为一个方法可以没有数据竞争，却仍然错误地确认了两笔订单。例如每次读取和每次写入都在独立锁内，但两者之间释放了锁，业务判断仍然会竞争。

无保护的读改写可能让两个请求都读到十，各自写回四，表面上库存没有变负，实际上确认了十二件购买。测试只断言库存大于等于零就会漏掉这种错误。因此并发测试至少要同时记录成功订单数、扣减流水和库存变化，验证守恒关系。

~~~sql
CREATE TABLE stock_lock_lab (
  sku VARCHAR(64) PRIMARY KEY,
  available BIGINT NOT NULL,
  version BIGINT NOT NULL
) ENGINE=InnoDB;
INSERT INTO stock_lock_lab VALUES ('A',10,0);

-- 原子条件扣减：影响行数为一才允许创建成功订单。
UPDATE stock_lock_lab
SET available=available-6, version=version+1
WHERE sku='A' AND available>=6;

-- 乐观版本更新：业务计算基于读到的版本。
UPDATE stock_lock_lab
SET available=4, version=version+1
WHERE sku='A' AND version=0 AND available>=6;

-- 悲观事务：以下语句必须处于同一连接同一事务。
START TRANSACTION;
SELECT available, version FROM stock_lock_lab WHERE sku='A' FOR UPDATE;
-- 应用根据刚读到的值判断，再执行参数化更新。
-- 不要在此处等待用户输入或调用长时间远程接口。
ROLLBACK;
~~~

这三段是对照方案，不能不重置数据就连续运行后比较结果。原子条件更新对简单扣减最直接，版本号更适合检测一组字段是否整体改变，悲观锁适合需要多步骤读取与计算的短事务。选择依据是临界区结构，而不是一看到“读多写少”就固定使用乐观锁。

## 原子性、可见性与互斥不是同一个词

volatile 能为特定读写建立可见性与有序性约束，但 count++ 仍然是读、计算、写三个逻辑步骤。AtomicInteger 的 incrementAndGet 把这个复合操作变为原子更新。synchronized 可以保护包含多个字段的临界区，并建立锁释放到后续获取之间的可见性关系。多个字段若通过不可变对象封装，也可以用 AtomicReference 原子替换整个状态。

CAS 比较引用时比较的是引用身份，不会调用业务 equals 判断对象内容。比较整数包装对象时尤其容易误解：两个数值相同的对象未必是相同引用。原子类的函数式更新方法可能重试计算，所以传入函数应避免发送消息、扣费等不可重复副作用。内存值成功交换之后再调用外部系统，仍存在跨资源失败窗口。

## 一份可运行的进程内对照实验

以下 Java 21 程序分别使用 CAS 和互斥锁扣减库存。它验证守恒关系，不给出“哪一种一定更快”的结论。吞吐测试还需要预热、多个进程 fork、不同冲突分布以及避免把日志输出放进计时区间。

~~~java
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;

public class LockInventoryLab {
    interface Stock {
        boolean take(int amount);
        int remaining();
    }
    static final class CasStock implements Stock {
        private final AtomicInteger value;
        CasStock(int initial) { value = new AtomicInteger(initial); }
        public boolean take(int amount) {
            if (amount <= 0) throw new IllegalArgumentException();
            for (;;) {
                int current = value.get();
                if (current < amount) return false;
                if (value.compareAndSet(current, current-amount)) return true;
                Thread.onSpinWait();
            }
        }
        public int remaining() { return value.get(); }
    }
    static final class MutexStock implements Stock {
        private final ReentrantLock lock = new ReentrantLock();
        private int value;
        MutexStock(int initial) { value = initial; }
        public boolean take(int amount) {
            if (amount <= 0) throw new IllegalArgumentException();
            lock.lock();
            try {
                if (value < amount) return false;
                value -= amount;
                return true;
            } finally { lock.unlock(); }
        }
        public int remaining() {
            lock.lock();
            try { return value; }
            finally { lock.unlock(); }
        }
    }
    static void verify(String name, Stock stock) throws Exception {
        int workers=8;
        int initial=10000;
        AtomicInteger successful=new AtomicInteger();
        CountDownLatch start=new CountDownLatch(1);
        try (ExecutorService pool=Executors.newFixedThreadPool(workers)) {
            List<Future<?>> futures=new ArrayList<>();
            for (int i=0;i<workers;i++) {
                futures.add(pool.submit(() -> {
                    start.await();
                    for (int j=0;j<2000;j++) {
                        if (stock.take(1)) successful.incrementAndGet();
                    }
                    return null;
                }));
            }
            start.countDown();
            for (Future<?> future:futures) future.get();
        }
        if (successful.get()+stock.remaining()!=initial) {
            throw new AssertionError("inventory conservation violated");
        }
        System.out.println(name+": accepted="+successful.get()
                +", remaining="+stock.remaining());
    }
    public static void main(String[] args) throws Exception {
        verify("CAS",new CasStock(10000));
        verify("MUTEX",new MutexStock(10000));
    }
}
~~~

示例 CAS 循环只适用于很短的内存计算。生产请求如果存在预算，应增加重试次数、时间上限或退避策略；对外失败必须与库存不足区分。Thread.onSpinWait 是提示，不保证线程让出 CPU，也不把循环变成公平队列。互斥锁则可能发生等待和调度，公平锁通常也会付出吞吐代价，不能把公平理解为没有性能成本。

## ABA 需要根据历史是否重要来判断

假设一个槽位从 A 变成 B，又回到同一个 A 引用。CAS 看到当前等于预期就可能成功，但这段历史对无锁栈等算法可能至关重要。AtomicStampedReference 将引用和戳一起比较。戳必须在每次相关变化时前进，否则只是增加了一个永远不变的字段。

~~~java
AtomicStampedReference<String> ref = new AtomicStampedReference<>("A", 0);
int[] stamp = new int[1];
String before = ref.get(stamp);
int observedStamp = stamp[0];
ref.compareAndSet("A", "B", 0, 1);
ref.compareAndSet("B", "A", 1, 2);
boolean accepted = ref.compareAndSet(before, "C", observedStamp, observedStamp + 1);
// accepted 应为 false：引用虽然回到 A，版本已经变化。
~~~

版本戳也有范围，理论上会回绕；实际算法需要根据运行周期与变更速率评估。对于只关心当前值的简单计数，不是所有 A→B→A 都构成错误，不能为每个 AtomicInteger 机械增加戳。

## 重试和锁的成本账

乐观失败率升高时，读、计算和更新的成本会被反复支付。若一次计算包含数据库查询或大对象构造，冲突率不高也可能很昂贵。悲观方案把竞争变为等待，却可能延长锁持有时间并形成排队。要比较成功吞吐、失败尝试、CPU、P99 与公平性，不能只比较平均完成时间。

LongAdder 把热点更新分散到多个计数单元，适合统计。并发更新期间 sum 不保证严格原子快照，因此不宜用来执行“剩余额度足够才扣减”。停止更新之后的总和可以用于最终统计。数据库锁与 Java 锁也不在同一边界：一个进程的 synchronized 无法阻止另一实例修改同一行，分布式锁又不能替代数据库约束和幂等账本。

死锁处理应保留等待链和参与 SQL，统一资源顺序，缩短事务，给重试设置随机退避和上限。最后仍要有唯一约束保护订单请求 ID，因为请求超时重发与线程竞争是两个不同来源的重复。`,
lab:'每个场景先定义不变量，再制造受控交错。数据库测试记录提交点；内存测试用栅栏对齐起跑，最终等待全部 Future 完成，并把工作线程异常传回测试线程。',
cases:[
['LOCK-01','丢失更新','库存为十且两个购买量都为六','让两个请求先读到相同库存再覆盖写入','能复现成功订单与库存变化不守恒','只检查库存不为负无法发现旧值覆盖造成的超卖'],
['LOCK-02','条件扣减','同一数据库行只有十件商品','并发执行带 available>=6 的减法更新','一笔成功一笔失败，成功数量与库存变化一致','业务条件应与修改处于同一原子写操作中'],
['LOCK-03','版本冲突','两个请求读取同一 version','分别使用旧版本提交修改','只有一个版本更新成功，另一方明确处理冲突','版本条件提供冲突检测，忽略影响行数会使机制失效'],
['LOCK-04','记录缺失','目标 ID 已被删除','执行版本更新并得到零行','不会一律误报版本冲突或无限重试','零行表示谓词未命中，原因需要按业务语义进一步区分'],
['LOCK-05','锁内异常','线程持有 ReentrantLock','在临界区主动抛异常再启动另一个更新线程','后续线程能够获取锁并完成','finally 释放保护异常路径，正常路径成功不足以验证锁生命周期'],
['LOCK-06','CAS 守恒','多线程共享一个原子库存','并发扣减直到库存耗尽','总成功扣减加剩余库存等于初始值','单次比较交换保护当前值变化，但测试还要验证业务守恒'],
['LOCK-07','ABA 版本戳','线程保存 A 和旧戳，另一线程完成 A 到 B 到 A','分别执行普通引用 CAS 和带戳 CAS','带戳操作拒绝旧历史，普通操作可能接受','当前值相同不能证明期间没有发生过业务重要变化'],
['LOCK-08','LongAdder 读取','多个线程持续累加统计','在累加中读取 sum 并在停止后读取最终值','最终总数正确，不把并发瞬时结果作为严格额度依据','分散计数提高吞吐的同时改变了读取快照语义'],
['LOCK-09','进程边界','两个服务实例各有一把本地锁','同时更新同一数据库资源','本地锁不能保证跨实例互斥，数据库约束仍生效','锁的作用域必须覆盖实际竞争者'],
['LOCK-10','重试副作用','版本冲突之前已发送外部通知','触发完整业务重试并观察通知记录','幂等键阻止重复副作用，或重构为提交后可靠事件','数据库失败不会回滚外部系统已经完成的动作']
],end:'## 用业务不变量选择并发控制\n\n简单单行规则优先考虑条件更新；复杂但短小的临界区可以互斥；低冲突的快照编辑可以用版本检查。CAS、数据库事务和幂等约束往往需要组合，关键是每一层都只承担自己能够保证的范围。',refs:[['MySQL：事务隔离与锁','https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html'],['Java 21 原子类文档','https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/atomic/package-summary.html']]},
{
file:'ConcurrentHashMap 源码分析.md',scope:'以 OpenJDK 8u 的桶级结构讲实现、以 Java 21 API 核对公开契约；源码行号随 tag 变化',
replace:[['遇到扩容转发节点时，协助或转到新表读取。','遇到扩容转发节点时，沿新表查找；普通 get 不承担迁移工作。'],['计算函数可能在竞争环境下被多次尝试，不能在其中执行不可重复的外部副作用。','不要把其他 ConcurrentMap 实现的重试语义套用到这里：ConcurrentHashMap 的 computeIfAbsent 调用是原子的，存在映射时不计算，缺失时由本次调用执行计算。返回 null、抛异常或映射后来被删除，后续调用仍可能再次计算，所以它不是持久化的业务恰好一次执行器。']],
body:`## 阅读源码先固定三个问题

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

size、isEmpty 和遍历适合监控与近似观察，不能用 size<100 然后 put 来实现严格容量限制。严格上限应使用信号量、锁或其他能够把检查与分配组合的机制。弱一致迭代不抛 ConcurrentModificationException，并不代表已经复制出一份稳定快照。`,
lab:'先把公开 API 契约与源码实现细节分开。实验记录 JDK 完整版本，避免在运行时强反射内部结构造成模块访问错误后误判集合行为。',
cases:[
['CHM-01','检查再插入','多线程共享空 Map 且拥有同一业务 Key','用栅栏让各线程先 containsKey 再 put','可复现多个业务获胜者但 Map 最终只有一条映射','单次方法安全不能组合成检查加写入的原子业务'],
['CHM-02','原子占位','使用相同 Key 和同样线程数量','改用 putIfAbsent 并统计返回 null 的次数','只有一个线程获得插入成功结果','原子方法把检查与映射建立放进同一并发操作'],
['CHM-03','可变 Key','Key 的 hashCode 依赖可修改字段','插入后修改字段，再尝试读取和删除','能够解释查找失败来自 Key 契约变化','并发容器不会跟踪外部对象的哈希变化并自动重新分桶'],
['CHM-04','碰撞热点','所有 Key 返回同一 hashCode','比较均匀 Key 与碰撞 Key 的更新延迟','热点竞争上升且不会被增加工作线程自动解决','桶级并发依赖合理散列，同桶操作仍需协调'],
['CHM-05','慢计算','computeIfAbsent 的函数被受控栅栏阻塞','并发访问相关 Key 并检查线程栈','识别计算路径带来的等待，不把它误判为网络线程不足','计算函数不是任意耗时副作用的安全容器'],
['CHM-06','空结果再加载','映射函数首次返回 null','再次调用 computeIfAbsent','后续调用可以再次执行函数','未建立映射意味着没有持久保存一次加载结果'],
['CHM-07','异常后重试','首次映射函数抛出受控异常','捕获后再次查询同一个 Key','后续调用按当前缺失状态重新计算','异常不会自动变成永久失败缓存'],
['CHM-08','value 内部竞争','多个线程拿到同一个非线程安全 List','并发修改 List 并与不可变替换方案比较','明确区分 Map 保护与 value 状态保护','容器不会递归赋予任意业务对象线程安全性'],
['CHM-09','并发扩容读取','初始容量较小且写者持续插入不同 Key','读者反复读取已经完成插入的固定映射','固定映射可正确读取，扩容成本通过指标观察','转发节点支持读者去新表查找，get 不需要参与搬迁'],
['CHM-10','容量控制竞态','Map 接近业务数量上限','并发执行 size 检查后 put','能复现超过上限并通过独立配额机制修复','聚合观察不提供检查加占位的全表事务']
],end:'## 源码阅读的落点\n\n理解空桶 CAS、冲突桶同步和迁移转发，是为了知道竞争在哪里发生。应用层还必须设计 Key 稳定性、value 安全性、跨 Key 原子性和持久化边界。把这些边界分清，ConcurrentHashMap 才能成为可靠的基础构件。',refs:[['Java 21 ConcurrentHashMap','https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ConcurrentHashMap.html'],['OpenJDK 8u 源码入口','https://github.com/openjdk/jdk8u/blob/master/jdk/src/share/classes/java/util/concurrent/ConcurrentHashMap.java'],['本地延伸：HashMap','HashMap%20源码分析/HashMap%20源码分析.md']]}
];
for(const a of articles)console.log(writeArticle(a));
