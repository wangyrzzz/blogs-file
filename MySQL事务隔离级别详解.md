# MySQL 事务隔离级别详解

> 阅读范围：MySQL 8.0/8.4 的 InnoDB；SQL 标准现象与数据库实现分别讨论。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


事务隔离级别用于控制并发事务之间能看到什么数据。隔离性越强，通常需要更多锁或版本管理，吞吐和并发度可能下降。理解隔离级别时，要同时区分 SQL 标准定义和 InnoDB 的具体实现。

## 三个并发问题

- 脏读：事务读到了另一个事务尚未提交的数据；
- 不可重复读：同一事务两次读取同一行，结果不同；
- 幻读：同一事务按条件查询两次，第二次多出或少了符合条件的行。

## 四种隔离级别

| 隔离级别 | 脏读 | 不可重复读 | 幻读（标准定义） |
| --- | --- | --- | --- |
| READ UNCOMMITTED | 可能 | 可能 | 可能 |
| READ COMMITTED | 避免 | 可能 | 可能 |
| REPEATABLE READ | 避免 | 避免 | 可能 |
| SERIALIZABLE | 避免 | 避免 | 避免 |

MySQL InnoDB 默认使用 `REPEATABLE READ`。在这个级别下，普通快照读依靠 MVCC，当前读依靠记录锁和间隙锁，在常见场景中可以避免很多幻读，但不能把它简单理解成所有 SQL 都绝不会出现范围结果变化。

查看当前会话隔离级别：

```sql
SELECT @@transaction_isolation;
```

设置当前会话的隔离级别：

```sql
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
```

## MVCC 与两类读取

普通 `SELECT` 通常是快照读。InnoDB 根据事务的 Read View 读取符合可见性规则的历史版本，不需要给读取的记录加排他锁。

`SELECT ... FOR UPDATE`、`SELECT ... FOR SHARE`、`UPDATE` 和 `DELETE` 属于当前读，需要读取最新版本，并可能加记录锁、间隙锁或 Next-Key Lock。

因此，分析两次 SELECT 必须说明读取语义。当前读本身不会刷新已经建立的普通快照；事务自己的写入却对后续读取可见，混合这些操作时不能再把结果理解为数据库在某个历史时刻的完整照片。

## 用两个会话理解隔离

先准备数据：

```sql
CREATE TABLE account (
  id BIGINT PRIMARY KEY,
  balance DECIMAL(12, 2) NOT NULL
) ENGINE = InnoDB;

INSERT INTO account(id, balance) VALUES (1, 100.00);
```

在会话 A 开启事务并修改但不提交：

```sql
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
START TRANSACTION;
UPDATE account SET balance = 50.00 WHERE id = 1;
```

会话 B 在 `READ UNCOMMITTED` 下查询，可能看到 50；在 `READ COMMITTED` 或更高隔离级别下，只能看到已提交版本。会话 A 执行 `ROLLBACK` 后，B 再查询即可验证脏读与否。

在 `READ COMMITTED` 下，事务 A 第一次查询后，事务 B 提交了对同一行的修改，A 第二次普通查询可能看到新值，这就是不可重复读。将 A 的隔离级别调整为 `REPEATABLE READ`，两次快照读通常会保持一致。

## 幻读和间隙锁

假设事务 A 使用条件 `salary = 500` 查询，事务 B 插入一条同样满足条件的记录。若 A 只是普通快照读，两次读取使用同一个 Read View，通常看不到 B 新提交的行；若 A 使用当前读，InnoDB 会根据索引范围加锁，阻止其他事务在锁定范围内插入，锁的具体范围取决于访问路径；没有合适索引也可能通过更大范围的锁阻止插入。

没有合适索引时，锁范围和扫描成本都可能变大。间隙锁还可能导致插入等待，因此需要在并发写入场景中观察锁等待和死锁，而不是只看 SQL 是否返回正确结果。

## 选择建议

- `READ COMMITTED`：希望减少间隙锁影响，能接受同一事务前后读取不同版本；
- `REPEATABLE READ`：多数 InnoDB 业务的默认选择，适合稳定快照读取；
- `SERIALIZABLE`：对一致性要求极高且并发量可控的场景，需评估锁等待；
- `READ UNCOMMITTED`：只适合极少数允许脏读的统计或监控场景。

隔离级别不能替代业务校验。例如扣库存仍应有条件更新、版本号或行锁；转账仍要在合理事务边界内完成，并设置超时和死锁重试。

## 常见排查命令

```sql
SHOW ENGINE INNODB STATUS;
SELECT * FROM performance_schema.data_locks;
SELECT * FROM performance_schema.data_lock_waits;
```

结合执行计划和索引结构，确认事务到底锁了哪些记录和范围。长事务会延迟历史版本清理，也可能阻塞 DDL 和大量写入，应用应及时提交或回滚。


## 把隔离现象还原成一张时间表

先约定一个实验环境：两个终端连接同一个测试数据库，所有表都使用 InnoDB，关闭客户端自动重连，并让终端显示连接 ID。每组实验开始前结束上一组事务。很多“隔离级别失效”其实是两个窗口连了不同实例，或者客户端每条语句都自动提交。还要区分设置当前会话与设置下一事务：会话级配置影响后续事务，不能在一个活动事务中临时切换后再把前后结果当成同一个实验。

以下建表语句只应在专用实验库执行。金额用整数分，避免把浮点误差混入并发问题。初始化独立列 version，用来观察同一行经历了多少次成功写入。

~~~sql
CREATE DATABASE IF NOT EXISTS isolation_lab;
USE isolation_lab;
CREATE TABLE wallet (
  id BIGINT NOT NULL PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  balance_cents BIGINT NOT NULL,
  version BIGINT NOT NULL DEFAULT 0,
  KEY idx_tenant_balance (tenant_id, balance_cents)
) ENGINE=InnoDB;
INSERT INTO wallet VALUES
  (1, 10, 10000, 0),
  (2, 10, 20000, 0),
  (3, 20, 30000, 0);
SELECT CONNECTION_ID(), @@autocommit, @@transaction_isolation;
~~~

以 RC 的不可重复读为例，顺序必须是 A 读、B 写并提交、A 再读，而不是把两个终端的大段脚本同时粘贴。后者没有控制交错，某次恰好相同的结果不能证明可重复读。

~~~sql
-- A1
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
START TRANSACTION;
SELECT balance_cents, version FROM wallet WHERE id=1;

-- B1，切换到第二个终端
START TRANSACTION;
UPDATE wallet
SET balance_cents=9000, version=version+1
WHERE id=1;
COMMIT;

-- A2，回到第一个终端
SELECT balance_cents, version FROM wallet WHERE id=1;
COMMIT;

-- 重置后，把 A1 的 READ COMMITTED 换成 REPEATABLE READ 再跑
~~~

RC 下 A2 应看到 B1 的提交，RR 下普通查询继续使用首次一致性读的视图。这里“首次”非常关键：一般的 START TRANSACTION 并不立即冻结快照。如果 A 开启事务后尚未读取，B 已提交，然后 A 第一次读，那么 A 看到新值完全合理。需要在事务起点建立一致性快照时，应在适用隔离级别下研究 WITH CONSISTENT SNAPSHOT，并验证具体存储引擎行为。[InnoDB 隔离级别文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)是这些读取规则的直接依据。

## Read View 不是复制整张表

MVCC 并不是每个事务复制一份数据库。可以把一条记录理解为当前版本加上一条可追溯的历史版本链，而 Read View 提供“哪些事务的修改对我可见”的判断条件。读到最新版本不符合条件时，就沿历史记录找到可见版本。实际实现涉及隐藏事务信息和 undo 记录，文章中的版本链图是逻辑示意，并非磁盘结构的逐字还原。

~~~text
当前记录: balance=8000, writer=T30
    |
历史版本: balance=9000, writer=T20
    |
历史版本: balance=10000, writer=T10

读视图建立时 T20 已提交、T30 仍活动:
  排除 T30 -> 读取 T20 的 9000
新读视图建立时 T30 已提交:
  读取 T30 的 8000
~~~

事务会看到自己的修改，所以“快照稳定”不能被理解成事务内读到的所有东西永远冻结。一笔事务先读到旧版本，再更新其中一行，后续查询会同时呈现自己的新值与其他记录的旧版本。这种组合可能从未作为全库的真实时刻存在。报表需要一致的只读快照，业务写入需要基于当前状态进行约束，两种目的应分别建模。

长事务的另一个影响是历史版本保留。一个只读查询迟迟不结束，也可能延缓旧版本清理，使 undo 历史增长。看到磁盘增长时，不应只找高频 UPDATE，还应检查长时间存活的事务、连接池遗留事务，以及报表是否占用业务主库。把查询切成分页后，每页独立事务会降低持有时间，但也放弃了整份报表的单一快照；这需要产品明确接受。

## 当前读与业务不变量

库存不为负是一个业务不变量，可以直接编码进写语句。先 SELECT 再在 Java 中判断，再按旧值覆盖，是把原子决策拆成了多次操作。即使普通 SELECT 使用 RR，也没有阻止其他事务在两次操作之间改变库存。

~~~sql
CREATE TABLE inventory (
  sku VARCHAR(64) PRIMARY KEY,
  available BIGINT NOT NULL,
  version BIGINT NOT NULL DEFAULT 0
) ENGINE=InnoDB;
INSERT INTO inventory VALUES ('SKU-001', 5, 0);

START TRANSACTION;
UPDATE inventory
SET available = available - 3,
    version = version + 1
WHERE sku = 'SKU-001' AND available >= 3;
-- 应用立即读取 affected rows；1 表示扣减成功，0 表示未满足条件。
-- 若还有订单写入，放在同一数据库事务内。
COMMIT;
~~~

另一种情况是业务确实需要读出多列再计算，才考虑 FOR UPDATE。锁定后要尽快完成，不能在持有库存锁时等待用户确认或调用耗时不确定的支付接口。两个库存同时扣减时统一按 sku 排序加锁，能减少相反顺序造成的死锁，但不保证永不死锁。数据库仍可能因为二级索引、外键等路径形成等待环。

死锁重试应从事务入口开始，而不是只重跑最后一条失败 SQL。失败前读出的版本和中间结果可能已经过期。若事务包含外部副作用，必须先设计幂等和补偿，否则数据库回滚后重试可能重复发短信、重复扣远程额度。对于锁等待超时，也要确认异常后应用是否明确回滚整笔事务，不能假设所有错误都自动产生相同回滚范围。

## 用索引解释锁的几何范围

记录锁锁的是索引记录，间隙锁保护索引区间，next-key lock 可以理解为记录与前一个间隙的组合。唯一索引的完整等值条件命中现存记录，通常比非唯一范围扫描锁得更窄；查不存在的记录、只使用复合唯一索引的一部分列，又是不同情况。不要把“where 有主键”替换成“所有条件都只锁一行”的口号。

~~~sql
-- A：在 RR 下锁定租户 10 的一个余额区间
START TRANSACTION;
SELECT id, balance_cents
FROM wallet
WHERE tenant_id=10 AND balance_cents BETWEEN 5000 AND 15000
FOR UPDATE;

-- B：根据实际索引区间，插入可能等待
START TRANSACTION;
INSERT INTO wallet VALUES (4, 10, 12000, 0);

-- 第三个观察连接
SELECT ENGINE_TRANSACTION_ID, OBJECT_NAME, INDEX_NAME,
       LOCK_TYPE, LOCK_MODE, LOCK_STATUS, LOCK_DATA
FROM performance_schema.data_locks
WHERE OBJECT_SCHEMA='isolation_lab';
SELECT * FROM performance_schema.data_lock_waits;

-- 最后在 A 和 B 各自执行 ROLLBACK，保证实验资源释放
~~~

这里故意不承诺一份固定的 LOCK_DATA 输出：数据分布、索引访问路径和版本细节会影响具体记录。验收目标应是明确谁阻塞谁、阻塞由哪个 SQL 造成、事务结束后是否解除。没有索引并不会让间隙锁机制凭空消失，它可能使扫描和锁定范围显著扩大。正确排查方法是把执行计划、索引定义与锁等待放在一起分析。

## 应用框架会改变实验边界

Spring 事务常见误区包括同类自调用没有经过代理、异常被内部 catch 后正常返回、方法实际运行在线程池另一线程、连接来自不同数据源，以及外层已有事务使内层隔离设置没有按照预想生效。数据库文档说明的是已生效事务的行为，不能替应用证明事务确实开启。排查时在同一连接查询 CONNECTION_ID 和隔离级别，结合事务日志确认开始与结束。

切换全局默认隔离级别还涉及连接池已有连接。不要只改服务器参数就认为所有应用连接同时改变。生产变更应先审计依赖稳定快照的查询、范围锁保护的业务规则、复制配置和死锁重试策略，再使用新连接灰度。RC 可能降低某些范围锁冲突，却不会自动修复丢失更新，也不会让所有业务更快。

## 写偏差：没有覆盖同一行也可能破坏规则

前面的库存例子主要讨论同一行竞争。另一种更难察觉的问题是写偏差：两个事务读取同一个业务范围，各自修改不同记录，因此没有直接的行覆盖冲突，却共同破坏了跨行约束。比如值班系统要求至少一名医生在线，A 和 B 都看到两人在线，随后各自把自己设为离线。只给每条医生记录加 version，无法让两个不同记录上的更新互相检测。

在 InnoDB RR 下，不能仅凭普通快照读就断言这样的跨行决策被串行化。可选处理包括把值班小组抽象为一个可锁定的聚合根，所有相关变更先锁定同一小组记录；也可以在适用情况下对参与判断的范围使用锁定读，但必须验证索引、范围和执行顺序。SERIALIZABLE 可以提供更强的并发约束，却仍要处理死锁与业务重试。

~~~sql
CREATE TABLE duty_group (
  id BIGINT PRIMARY KEY,
  name VARCHAR(64) NOT NULL
) ENGINE=InnoDB;
CREATE TABLE duty_member (
  group_id BIGINT NOT NULL,
  doctor_id BIGINT NOT NULL,
  on_duty TINYINT NOT NULL,
  PRIMARY KEY(group_id,doctor_id)
) ENGINE=InnoDB;
INSERT INTO duty_group VALUES (1,'night');
INSERT INTO duty_member VALUES (1,101,1),(1,102,1);

-- 所有改变组内值班状态的入口都遵守此协议。
START TRANSACTION;
SELECT id FROM duty_group WHERE id=1 FOR UPDATE;
SELECT doctor_id FROM duty_member
WHERE group_id=1 AND on_duty=1 FOR UPDATE;
-- 应用确认仍有其他值班人员后，才更新自己的状态。
-- 没有满足条件时回滚，不能忽略判断结果继续提交。
UPDATE duty_member SET on_duty=0 WHERE group_id=1 AND doctor_id=101;
COMMIT;
~~~

示例省略了应用条件分支，不能把最后的 UPDATE 无条件执行当作完整值班规则。关键在于所有写入口都先竞争相同聚合根，并在获得锁后基于当前读判断。若后台脚本绕过这一协议，规则依然会失效。由此也能看出，隔离级别、锁协议和领域约束必须一起评审，数据库选项不能替代对业务不变量的定义。

## NOWAIT 与 SKIP LOCKED：把等待策略写进业务

锁冲突不一定只能等待到超时。MySQL 8.0/8.4 的锁定读可以使用 NOWAIT，在遇到所需行锁不可获取时立即报错；SKIP LOCKED 则跳过已经被锁住的行。这两种选项只处理相应行锁等待，并不能保证 SQL 不受元数据锁、I/O 或其他因素影响。尤其是 SKIP LOCKED 返回的集合可能不完整，官方将队列式任务认领列为适用场景，不能把它用于要求完整范围判断的余额核算。[锁定读文档](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html)

设想三个消费者共同处理导出任务。普通 FOR UPDATE 可能让它们都等待同一条队首记录；如果任务允许独立执行，可以在短事务里认领不同记录，提交后再生成文件。下面使用独立实验表展示认领阶段，任务处理本身不应占据这笔数据库事务。

~~~sql
CREATE TABLE export_job (
  id BIGINT PRIMARY KEY,
  status VARCHAR(16) NOT NULL,
  claim_token VARCHAR(64) NULL,
  lease_until DATETIME(3) NULL,
  KEY idx_job_status_id(status, id)
) ENGINE=InnoDB;
INSERT INTO export_job(id,status) VALUES (1,'READY'),(2,'READY');

START TRANSACTION;
SELECT id FROM export_job
WHERE status='READY'
ORDER BY id LIMIT 1
FOR UPDATE SKIP LOCKED;
-- 应用使用上一步返回的 ID；没有返回行时不执行 UPDATE。
UPDATE export_job
SET status='RUNNING', claim_token=?,
    lease_until=TIMESTAMPADD(SECOND,60,NOW(3))
WHERE id=? AND status='READY';
COMMIT;
~~~

问号由预编译参数提供，claim_token 应为每次认领生成的唯一值。任务完成时，更新必须同时匹配 ID、RUNNING 状态和本次 claim_token；否则旧消费者暂停很久后恢复，可能覆盖已经由新消费者重新认领的结果。租约只允许系统判断何时可以考虑回收，它不会自动停止旧进程，也不会阻止旧进程继续上传文件。因此外部产物还需要幂等命名、版本或其他所有权检查。

SKIP LOCKED 也不保证公平。某条任务长期被占用，后续任务可能持续绕过它，导致队首饥饿。除吞吐量外，还应监控最老 READY 任务年龄、租约超时次数和重复完成拒绝数。若返回空集，含义可能是当前没有可认领任务，也可能是候选全部被锁住；不能把一次空查询当作整个队列已经彻底清空的证明。

## 保存点与隐式提交会改变事务边界

SAVEPOINT 允许撤销同一事务中的一部分修改，但不创建一个可以独立提交的嵌套事务。RELEASE SAVEPOINT 只是移除保存点，并不会提交这部分数据。回滚到保存点也不能被理解为此前占用的行锁全部释放；InnoDB 对锁释放有专门规则，排查时应查看真实等待关系。[保存点文档](https://dev.mysql.com/doc/refman/8.0/en/savepoint.html)

这对于批量导入很重要：逐条建立保存点可以在可恢复的单行错误后继续处理，但整批仍属于外层事务。保留十万行成功结果直到最后才提交，依旧可能形成长事务。若改成每千行提交，则失败时只能回滚当前批次，已经提交的前几批必须依靠业务批次号补偿或继续执行。性能与回滚范围的改变应作为接口契约说明，而不是藏在数据库工具的默认选项里。

另外，ALTER TABLE、普通 CREATE TABLE 等语句可能隐式提交活动事务。把建表、造数、并发实验和 ROLLBACK 粘成一段脚本，可能让实验者误以为所有变更都会撤销。实验初始化应先完成并提交，再开启只包含目标 DML 的事务。临时表语句也存在特殊规则，不能用“带 TEMPORARY 就完全可回滚”概括。[隐式提交文档](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html)

## 故障注入与验收实验

下面每个场景都在独立测试库运行。把 A、B 两个连接的语句编号、提交点、读到的余额和等待时长放在同一时间线上，才能解释差异。

### ISO-01：未提交修改的可见性

实验前提是余额为 10000，A 已写为 9000 但尚未提交。执行B 分别用 RU 与 RC 普通查询，随后让 A 回滚。

通过条件是RU 可以观察到未提交值，RC 不读取该未提交版本。这里的判断依据是可见性与是否最终提交是两件事，脏读的风险在回滚后尤其明显。

### ISO-02：首次一致性读时机

实验前提是A 使用 RR 仅开启事务，尚未查询 wallet。执行B 更新并提交后，A 执行第一次普通 SELECT。

通过条件是A 的首次快照包含 B 已提交的修改。这里的判断依据是通常在首次一致性读建立读视图，事务开始语句本身不等价于冻结所有数据。

### ISO-03：RC 的语句快照

实验前提是A 已在 RC 事务读取初值，B 可以修改同一行。执行B 提交新值后让 A 再次普通查询。

通过条件是A 第二次查询看到新的已提交值。这里的判断依据是RC 的一致性读按语句建立新视图，不能用两次查询结果不变作为业务校验锁。

### ISO-04：RR 的稳定快照

实验前提是A 已在 RR 下完成第一次普通查询。执行B 提交新值，A 先普通查询再 FOR UPDATE。

通过条件是普通查询沿用原视图，锁定读读取当前可锁定版本。这里的判断依据是同一事务可以存在不同读取语义，锁定读不会自动刷新原先的普通读视图。

### ISO-05：范围锁阻塞插入

实验前提是租户余额索引存在，A 已在 RR 锁定测试区间。执行B 在区间内插入并用第三连接查询等待关系。

通过条件是能找到 B 等待 A 的证据，A 结束后 B 才继续。这里的判断依据是范围保护通过索引锁实现，需要观察等待关系而非猜测某个 SQL 是否加锁。

### ISO-06：条件扣库存

实验前提是可用库存为 5，两个事务各申请 3。执行并发执行 available>=3 的条件 UPDATE。

通过条件是恰好一个扣减成功，另一操作影响行数为 0。这里的判断依据是判断和扣减位于同一原子写语句，不能忽略返回的影响行数。

### ISO-07：死锁恢复

实验前提是两条钱包记录存在，A 与 B 采用相反更新顺序。执行交错执行两个更新以形成等待环，然后按入口重试失败事务。

通过条件是至少一方被选为死锁受害者，重试后资金不变量仍成立。这里的判断依据是死锁是并发控制的一种可恢复结果，重试范围应覆盖整笔逻辑事务。

### ISO-08：连接池事务遗漏

实验前提是应用手动开启事务且首个查询已建立视图。执行模拟异常路径遗漏回滚，观察连接归还和再次借出行为。

通过条件是框架或连接池清理事务，下一业务请求不继承未结束状态。这里的判断依据是事务生命周期属于连接，线程方法返回并不天然等价于数据库提交。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "MySQL事务隔离级别详解",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "ISO-01",
      "scenario": "未提交修改的可见性",
      "given": "余额为 10000，A 已写为 9000 但尚未提交",
      "when": "B 分别用 RU 与 RC 普通查询，随后让 A 回滚",
      "then": "RU 可以观察到未提交值，RC 不读取该未提交版本"
    },
    {
      "id": "ISO-02",
      "scenario": "首次一致性读时机",
      "given": "A 使用 RR 仅开启事务，尚未查询 wallet",
      "when": "B 更新并提交后，A 执行第一次普通 SELECT",
      "then": "A 的首次快照包含 B 已提交的修改"
    },
    {
      "id": "ISO-03",
      "scenario": "RC 的语句快照",
      "given": "A 已在 RC 事务读取初值，B 可以修改同一行",
      "when": "B 提交新值后让 A 再次普通查询",
      "then": "A 第二次查询看到新的已提交值"
    },
    {
      "id": "ISO-04",
      "scenario": "RR 的稳定快照",
      "given": "A 已在 RR 下完成第一次普通查询",
      "when": "B 提交新值，A 先普通查询再 FOR UPDATE",
      "then": "普通查询沿用原视图，锁定读读取当前可锁定版本"
    },
    {
      "id": "ISO-05",
      "scenario": "范围锁阻塞插入",
      "given": "租户余额索引存在，A 已在 RR 锁定测试区间",
      "when": "B 在区间内插入并用第三连接查询等待关系",
      "then": "能找到 B 等待 A 的证据，A 结束后 B 才继续"
    },
    {
      "id": "ISO-06",
      "scenario": "条件扣库存",
      "given": "可用库存为 5，两个事务各申请 3",
      "when": "并发执行 available>=3 的条件 UPDATE",
      "then": "恰好一个扣减成功，另一操作影响行数为 0"
    },
    {
      "id": "ISO-07",
      "scenario": "死锁恢复",
      "given": "两条钱包记录存在，A 与 B 采用相反更新顺序",
      "when": "交错执行两个更新以形成等待环，然后按入口重试失败事务",
      "then": "至少一方被选为死锁受害者，重试后资金不变量仍成立"
    },
    {
      "id": "ISO-08",
      "scenario": "连接池事务遗漏",
      "given": "应用手动开启事务且首个查询已建立视图",
      "when": "模拟异常路径遗漏回滚，观察连接归还和再次借出行为",
      "then": "框架或连接池清理事务，下一业务请求不继承未结束状态"
    }
  ]
}
```

## 落地结论

先用条件更新、唯一约束和清楚的事务边界保护业务规则，再决定读侧需要什么一致性。隔离级别的选择必须能回答三个具体问题：我读的是哪一个版本，我锁住的是哪一段索引，失败以后从哪里重新开始。把这三个问题讲清楚，比背诵四级隔离表更能解决生产事故。

## 参考资料与继续阅读

- [MySQL 8.4：事务隔离级别](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)
- [本地延伸：Spring 事务](Spring%20事务/Spring%20事务.md)
