# 乐观锁、悲观锁和 CAS

> 阅读范围：Java 21 原子类、进程内互斥与 MySQL InnoDB 单库并发控制。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


并发控制的核心问题是：多个线程或事务同时读写共享数据时，如何避免互相覆盖或产生非法状态。悲观锁和乐观锁是两种思路，CAS（Compare And Swap，比较并交换）则是乐观并发控制的一种底层实现。

## 悲观锁

悲观锁假设冲突很可能发生，因此在访问共享资源前先加锁，让同一时刻只有一个执行者进入临界区。

Java 中的 `synchronized` 和 `ReentrantLock` 都体现了这种思想：

```java
private final Lock lock = new ReentrantLock();

public void update() {
    lock.lock();
    try {
        // 修改共享状态
    } finally {
        lock.unlock();
    }
}
```

数据库中的 `SELECT ... FOR UPDATE`、排他锁和表锁也属于悲观并发控制。它们的优点是冲突发生时逻辑直观，不需要反复重试；缺点是线程或事务会等待，锁粒度不当时还可能造成死锁、长事务和吞吐下降。

## 乐观锁

乐观锁假设冲突不经常发生，读取时不阻塞其他执行者，提交更新时再检查数据是否已经被修改。典型实现是版本号：

```sql
UPDATE account
SET balance = ?, version = version + 1
WHERE id = ? AND version = ?;
```

如果受影响行数为 0，说明本次条件未满足，可能是版本变化，也可能是记录不存在或其他条件不满足，当前更新未成功，业务可以重新读取并重试，或者直接提示冲突。

乐观锁适合冲突概率较低、读多写少或可以安全重试的场景。写竞争激烈时，大量失败重试会消耗 CPU，甚至比加锁更慢。

## CAS 的工作方式

CAS 一次操作包含三个值：

- `V`：内存中的当前值；
- `E`：线程认为的预期值；
- `N`：准备写入的新值。

只有当 `V == E` 时，处理器才会以原子方式把 `V` 更新为 `N`，否则更新失败。Java 中 `AtomicInteger`、`AtomicReference` 等原子类提供了 CAS 能力：

```java
AtomicInteger counter = new AtomicInteger();
counter.incrementAndGet();
```

CAS 失败不会让线程自动阻塞，调用方通常会循环重试。重试次数、退避策略和业务放弃条件需要结合实际冲突率设计。

## CAS 的问题

### ABA 问题

线程 A 读取到值 `A`，线程 B 将它改成 `B` 后又改回 `A`，线程 A 只比较数值时会认为期间没有发生变化。若业务关心中间状态，可以把版本号和数据一起比较，或使用 `AtomicStampedReference`。

### 自旋开销

高冲突下，CAS 循环会持续消耗 CPU。`LongAdder` 通过分散热点计数降低竞争，但它的读取与更新语义和 `AtomicLong` 不完全相同，不能不加判断地替换。

### 只能保护局部状态

CAS 适合保护一个变量或一组可原子替换的引用，不能自动保证“扣库存、写订单、记流水”这类跨资源操作的一致性。后者需要数据库事务、锁、消息或分布式事务方案。

## 如何选择

| 场景 | 更适合的方案 |
| --- | --- |
| 临界区较大且冲突频繁 | 互斥锁或数据库悲观锁 |
| 单行更新、冲突较少 | 版本号乐观锁 |
| 单个计数器或引用替换 | CAS / 原子类 |
| 跨多个资源的业务操作 | 事务、幂等和可靠消息 |
| 需要严格顺序的队列消费 | 单线程串行或分区有序消费 |

锁的选择不能只按“读多写少”机械判断，还要看临界区长度、冲突概率、重试成本和一致性要求。数据库乐观锁更新失败后也必须明确是重试、合并还是返回冲突，不能忽略受影响行数。

## 工程实践

- 释放锁放在 `finally` 中，避免异常导致锁无法释放；
- 事务中不要执行长时间远程调用；
- 分布式锁设置租约、唯一持有者标识和续期机制；
- 乐观锁失败需要监控，持续升高通常说明模型或热点分布有问题；
- 任何重试都要有次数上限和幂等保障。


## 用一笔库存扣减比较三种方案

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

死锁处理应保留等待链和参与 SQL，统一资源顺序，缩短事务，给重试设置随机退避和上限。最后仍要有唯一约束保护订单请求 ID，因为请求超时重发与线程竞争是两个不同来源的重复。

## 重试策略需要描述停止条件

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

## 故障注入与验收实验

每个场景先定义不变量，再制造受控交错。数据库测试记录提交点；内存测试用栅栏对齐起跑，最终等待全部 Future 完成，并把工作线程异常传回测试线程。

### LOCK-01：丢失更新

实验前提是库存为十且两个购买量都为六。执行让两个请求先读到相同库存再覆盖写入。

通过条件是能复现成功订单与库存变化不守恒。这里的判断依据是只检查库存不为负无法发现旧值覆盖造成的超卖。

### LOCK-02：条件扣减

实验前提是同一数据库行只有十件商品。执行并发执行带 available>=6 的减法更新。

通过条件是一笔成功一笔失败，成功数量与库存变化一致。这里的判断依据是业务条件应与修改处于同一原子写操作中。

### LOCK-03：版本冲突

实验前提是两个请求读取同一 version。执行分别使用旧版本提交修改。

通过条件是只有一个版本更新成功，另一方明确处理冲突。这里的判断依据是版本条件提供冲突检测，忽略影响行数会使机制失效。

### LOCK-04：记录缺失

实验前提是目标 ID 已被删除。执行版本更新并得到零行。

通过条件是不会一律误报版本冲突或无限重试。这里的判断依据是零行表示谓词未命中，原因需要按业务语义进一步区分。

### LOCK-05：锁内异常

实验前提是线程持有 ReentrantLock。执行在临界区主动抛异常再启动另一个更新线程。

通过条件是后续线程能够获取锁并完成。这里的判断依据是finally 释放保护异常路径，正常路径成功不足以验证锁生命周期。

### LOCK-06：CAS 守恒

实验前提是多线程共享一个原子库存。执行并发扣减直到库存耗尽。

通过条件是总成功扣减加剩余库存等于初始值。这里的判断依据是单次比较交换保护当前值变化，但测试还要验证业务守恒。

### LOCK-07：ABA 版本戳

实验前提是线程保存 A 和旧戳，另一线程完成 A 到 B 到 A。执行分别执行普通引用 CAS 和带戳 CAS。

通过条件是带戳操作拒绝旧历史，普通操作可能接受。这里的判断依据是当前值相同不能证明期间没有发生过业务重要变化。

### LOCK-08：LongAdder 读取

实验前提是多个线程持续累加统计。执行在累加中读取 sum 并在停止后读取最终值。

通过条件是最终总数正确，不把并发瞬时结果作为严格额度依据。这里的判断依据是分散计数提高吞吐的同时改变了读取快照语义。

### LOCK-09：进程边界

实验前提是两个服务实例各有一把本地锁。执行同时更新同一数据库资源。

通过条件是本地锁不能保证跨实例互斥，数据库约束仍生效。这里的判断依据是锁的作用域必须覆盖实际竞争者。

### LOCK-10：重试副作用

实验前提是版本冲突之前已发送外部通知。执行触发完整业务重试并观察通知记录。

通过条件是幂等键阻止重复副作用，或重构为提交后可靠事件。这里的判断依据是数据库失败不会回滚外部系统已经完成的动作。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "乐观锁、悲观锁和CAS",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "LOCK-01",
      "scenario": "丢失更新",
      "given": "库存为十且两个购买量都为六",
      "when": "让两个请求先读到相同库存再覆盖写入",
      "then": "能复现成功订单与库存变化不守恒"
    },
    {
      "id": "LOCK-02",
      "scenario": "条件扣减",
      "given": "同一数据库行只有十件商品",
      "when": "并发执行带 available>=6 的减法更新",
      "then": "一笔成功一笔失败，成功数量与库存变化一致"
    },
    {
      "id": "LOCK-03",
      "scenario": "版本冲突",
      "given": "两个请求读取同一 version",
      "when": "分别使用旧版本提交修改",
      "then": "只有一个版本更新成功，另一方明确处理冲突"
    },
    {
      "id": "LOCK-04",
      "scenario": "记录缺失",
      "given": "目标 ID 已被删除",
      "when": "执行版本更新并得到零行",
      "then": "不会一律误报版本冲突或无限重试"
    },
    {
      "id": "LOCK-05",
      "scenario": "锁内异常",
      "given": "线程持有 ReentrantLock",
      "when": "在临界区主动抛异常再启动另一个更新线程",
      "then": "后续线程能够获取锁并完成"
    },
    {
      "id": "LOCK-06",
      "scenario": "CAS 守恒",
      "given": "多线程共享一个原子库存",
      "when": "并发扣减直到库存耗尽",
      "then": "总成功扣减加剩余库存等于初始值"
    },
    {
      "id": "LOCK-07",
      "scenario": "ABA 版本戳",
      "given": "线程保存 A 和旧戳，另一线程完成 A 到 B 到 A",
      "when": "分别执行普通引用 CAS 和带戳 CAS",
      "then": "带戳操作拒绝旧历史，普通操作可能接受"
    },
    {
      "id": "LOCK-08",
      "scenario": "LongAdder 读取",
      "given": "多个线程持续累加统计",
      "when": "在累加中读取 sum 并在停止后读取最终值",
      "then": "最终总数正确，不把并发瞬时结果作为严格额度依据"
    },
    {
      "id": "LOCK-09",
      "scenario": "进程边界",
      "given": "两个服务实例各有一把本地锁",
      "when": "同时更新同一数据库资源",
      "then": "本地锁不能保证跨实例互斥，数据库约束仍生效"
    },
    {
      "id": "LOCK-10",
      "scenario": "重试副作用",
      "given": "版本冲突之前已发送外部通知",
      "when": "触发完整业务重试并观察通知记录",
      "then": "幂等键阻止重复副作用，或重构为提交后可靠事件"
    }
  ]
}
```

## 用业务不变量选择并发控制

简单单行规则优先考虑条件更新；复杂但短小的临界区可以互斥；低冲突的快照编辑可以用版本检查。CAS、数据库事务和幂等约束往往需要组合，关键是每一层都只承担自己能够保证的范围。

## 参考资料与继续阅读

- [MySQL：事务隔离与锁](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)
- [Java 21 原子类文档](https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/atomic/package-summary.html)
