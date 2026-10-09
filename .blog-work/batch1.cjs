const {writeArticle}=require('./compose.cjs');
const articles=[{
file:'MySQL事务隔离级别详解.md',scope:'MySQL 8.0/8.4 的 InnoDB；SQL 标准现象与数据库实现分别讨论',
replace:[['前提是查询能够使用合适的索引','锁的具体范围取决于访问路径；没有合适索引也可能通过更大范围的锁阻止插入'],['因此，“同一事务两次 SELECT 结果一致”只适用于相同的快照读语义；如果中间使用了当前读，或者事务隔离、锁范围不同，结果分析会不同。','因此，分析两次 SELECT 必须说明读取语义。当前读本身不会刷新已经建立的普通快照；事务自己的写入却对后续读取可见，混合这些操作时不能再把结果理解为数据库在某个历史时刻的完整照片。']],
body:`## 把隔离现象还原成一张时间表

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

切换全局默认隔离级别还涉及连接池已有连接。不要只改服务器参数就认为所有应用连接同时改变。生产变更应先审计依赖稳定快照的查询、范围锁保护的业务规则、复制配置和死锁重试策略，再使用新连接灰度。RC 可能降低某些范围锁冲突，却不会自动修复丢失更新，也不会让所有业务更快。`,
lab:'下面每个场景都在独立测试库运行。把 A、B 两个连接的语句编号、提交点、读到的余额和等待时长放在同一时间线上，才能解释差异。',
cases:[
['ISO-01','未提交修改的可见性','余额为 10000，A 已写为 9000 但尚未提交','B 分别用 RU 与 RC 普通查询，随后让 A 回滚','RU 可以观察到未提交值，RC 不读取该未提交版本','可见性与是否最终提交是两件事，脏读的风险在回滚后尤其明显'],
['ISO-02','首次一致性读时机','A 使用 RR 仅开启事务，尚未查询 wallet','B 更新并提交后，A 执行第一次普通 SELECT','A 的首次快照包含 B 已提交的修改','通常在首次一致性读建立读视图，事务开始语句本身不等价于冻结所有数据'],
['ISO-03','RC 的语句快照','A 已在 RC 事务读取初值，B 可以修改同一行','B 提交新值后让 A 再次普通查询','A 第二次查询看到新的已提交值','RC 的一致性读按语句建立新视图，不能用两次查询结果不变作为业务校验锁'],
['ISO-04','RR 的稳定快照','A 已在 RR 下完成第一次普通查询','B 提交新值，A 先普通查询再 FOR UPDATE','普通查询沿用原视图，锁定读读取当前可锁定版本','同一事务可以存在不同读取语义，锁定读不会自动刷新原先的普通读视图'],
['ISO-05','范围锁阻塞插入','租户余额索引存在，A 已在 RR 锁定测试区间','B 在区间内插入并用第三连接查询等待关系','能找到 B 等待 A 的证据，A 结束后 B 才继续','范围保护通过索引锁实现，需要观察等待关系而非猜测某个 SQL 是否加锁'],
['ISO-06','条件扣库存','可用库存为 5，两个事务各申请 3','并发执行 available>=3 的条件 UPDATE','恰好一个扣减成功，另一操作影响行数为 0','判断和扣减位于同一原子写语句，不能忽略返回的影响行数'],
['ISO-07','死锁恢复','两条钱包记录存在，A 与 B 采用相反更新顺序','交错执行两个更新以形成等待环，然后按入口重试失败事务','至少一方被选为死锁受害者，重试后资金不变量仍成立','死锁是并发控制的一种可恢复结果，重试范围应覆盖整笔逻辑事务'],
['ISO-08','连接池事务遗漏','应用手动开启事务且首个查询已建立视图','模拟异常路径遗漏回滚，观察连接归还和再次借出行为','框架或连接池清理事务，下一业务请求不继承未结束状态','事务生命周期属于连接，线程方法返回并不天然等价于数据库提交']
],end:'## 落地结论\n\n先用条件更新、唯一约束和清楚的事务边界保护业务规则，再决定读侧需要什么一致性。隔离级别的选择必须能回答三个具体问题：我读的是哪一个版本，我锁住的是哪一段索引，失败以后从哪里重新开始。把这三个问题讲清楚，比背诵四级隔离表更能解决生产事故。',refs:[['MySQL 8.4：事务隔离级别','https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html'],['本地延伸：Spring 事务','Spring%20事务/Spring%20事务.md']]},
{
file:'MySQL执行计划分析.md',scope:'MySQL 8.0/8.4；示例围绕订单检索，实际计划由数据和统计信息决定',
replace:[['连接的一侧没有有效索引，可能需要检查连接条件','使用了连接缓冲或相应连接算法，应结合算法名称与实际行数分析，不能单凭此字段断言没有索引']],
body:`## 建立可以反复比较的订单实验

优化 SQL 的第一步是固定问题，而不是立刻增加索引。我们需要知道请求携带什么参数、返回多少行、客户端实际消耗多少时间，以及同一模板是否同时服务小租户和大租户。只保存一条去掉参数的慢 SQL，往往会遗漏真正决定执行计划的数据倾斜。以下表结构刻意同时保留筛选、排序和回表字段，便于观察不同访问路径。

~~~sql
CREATE DATABASE IF NOT EXISTS plan_lab;
USE plan_lab;
CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL,
  amount_cents BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  remark VARCHAR(500) NOT NULL DEFAULT '',
  KEY idx_created (created_at)
) ENGINE=InnoDB;

CREATE TABLE digit (n INT PRIMARY KEY);
INSERT INTO digit VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9);
INSERT INTO orders
SELECT x.n+1,
       CASE WHEN MOD(x.n,10)<8 THEN 10 ELSE 20+MOD(x.n,50) END,
       MOD(x.n,10000),
       CASE WHEN MOD(x.n,20)=0 THEN 'PENDING' ELSE 'PAID' END,
       100+MOD(x.n,50000),
       DATE_ADD('2026-01-01', INTERVAL x.n SECOND),
       REPEAT('x', 100)
FROM (
  SELECT a.n+10*b.n+100*c.n+1000*d.n+10000*e.n AS n
  FROM digit a CROSS JOIN digit b CROSS JOIN digit c
  CROSS JOIN digit d CROSS JOIN digit e
) x;
ANALYZE TABLE orders;

EXPLAIN FORMAT=TREE
SELECT id, amount_cents, created_at
FROM orders
WHERE tenant_id=10 AND status='PENDING'
ORDER BY created_at DESC, id DESC
LIMIT 20;
~~~

这份生成器产生十万条演示数据，不代表任何真实电商分布。它有意让租户和状态不均匀，目的是展示“全表平均选择率”无法准确描述每个参数组合。首次执行可能发生磁盘读取，第二次更多命中 Buffer Pool。比较索引前后时应分别保留冷、热场景，并让两组使用相同的投影列、排序语义和返回数量。

## 从树形计划读出工作量

传统 EXPLAIN 适合快速浏览访问类型，树形输出更容易展示算子嵌套。EXPLAIN ANALYZE 会执行支持的语句并报告实际信息，应优先在隔离环境使用。阅读时从叶子向上理解：底层扫描生成行，中间过滤淘汰行，排序或聚合重组结果，顶部限制输出。一个上层只返回 20 行的查询，底层完全可能处理了数万行。[官方输出说明](https://dev.mysql.com/doc/refman/8.4/en/explain-output.html)列出了各字段语义。

例如一个内层索引查找每次返回 3 行，但被外层驱动执行 10000 次，累计工作远比单次 3 行显眼。分析实际行数时必须同时看 loops；某些节点显示的是每轮平均值。时间也有父子包含关系，不能把所有节点的时间简单相加，否则会重复计费。估算 rows 与实际 rows 相差几个数量级，通常提示统计或相关性假设有问题，但还要检查数据是否在采样后发生变化。

常见的优化误判是把 Using index 视为胜利。覆盖索引确实减少回表，但如果扫描了几百万个索引条目，仍可能比精准定位并回表几十次更慢。另一个误判是只看首行延迟：报表工具边读边显示，第一行很快不代表总查询快；反过来，排序节点需要先收集候选行，首行慢却可能在可接受范围内完成全部返回。

## 联合索引要围绕一个明确查询设计

针对上面的查询，可以先尝试下面的索引，而不是为每个列各建一个索引，期待数据库自动拼出最优路径。

~~~sql
CREATE INDEX idx_order_tenant_status_time_id
ON orders(tenant_id, status, created_at, id);

EXPLAIN ANALYZE
SELECT id, amount_cents, created_at
FROM orders
WHERE tenant_id=10 AND status='PENDING'
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- 对照覆盖投影，观察去掉 amount_cents 的影响
EXPLAIN ANALYZE
SELECT id, created_at
FROM orders
WHERE tenant_id=10 AND status='PENDING'
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- 对照参数变化，不能只验证热点租户
EXPLAIN ANALYZE
SELECT id, amount_cents, created_at
FROM orders
WHERE tenant_id=21 AND status='PAID'
ORDER BY created_at DESC, id DESC
LIMIT 20;
~~~

等值条件放在排序列前面，使满足固定租户和状态的条目形成一个可按时间遍历的范围。id 用作稳定排序的第二关键字，避免创建时间相同的记录翻页漂移。InnoDB 二级索引本来就包含主键信息，但在说明排序契约时显式列出 id 更清楚；是否需要显式写入索引定义应结合执行计划判断。

如果查询经常不带 status，前面的索引不一定能同时满足时间排序。给每一种筛选组合建一个索引会增加写放大、空间占用和维护成本。合理方法是按真实查询频率分组，为少数关键路径设计索引，其余低频查询允许有限排序或异步导出。所谓最左前缀不是“后面列完全没用”的万能定理，还存在索引条件下推、覆盖扫描及版本相关优化，最终仍应看实际访问路径。

## 分页、排序与结果语义一起优化

OFFSET 100000 LIMIT 20 即使走索引，也需要跨过大量前置记录。游标分页保存上一页末尾的排序值，再查询其后的数据，通常更适合连续浏览。但它不能天然支持跳到第 5000 页，也不能保证不断有新数据插入时整次浏览是一个静态快照。

~~~sql
SELECT id, amount_cents, created_at
FROM orders
WHERE tenant_id=10
  AND status='PENDING'
  AND (
    created_at < '2026-01-02 00:00:00.000'
    OR (created_at = '2026-01-02 00:00:00.000' AND id < 86401)
  )
ORDER BY created_at DESC, id DESC
LIMIT 20;
~~~

这里保留两列比较，是为了保证时间相同的订单仍有确定顺序。直接改成 id 小于上次 id，只有在业务认可按 id 排序时才等价。数据库调优不能偷偷改变结果集。类似地，把 LEFT JOIN 改成 INNER JOIN 可能显著加快查询，却删除了原本需要返回的无匹配记录，属于错误修复方向。

filesort 是额外排序过程的信号，不意味着必然落磁盘。筛选后只有几十行时，排序成本可能很低；为避免这次排序而选择一个筛选能力很差的索引，反而会扫描更多行。应比较总工作量，而不是消灭某个 Extra 文本。临时表同理，要看实际大小、是否溢出、并发数量和内存预算。

## 索引失效说法需要拆开理解

对索引列使用函数，可能使普通 B+ 树无法直接按原值定位，但函数索引、生成列索引或其他改写可能提供替代路径。隐式转换也不是任意方向都完全相同：字符串列与数字参数比较，可能改变比较语义并影响索引使用。要保留真实字段类型、字符集与参数绑定类型，不能只看日志里显示的一段 SQL 字符串。

LIKE '%phone%' 不具备普通前缀范围查询的条件，却不表示数据库一定不扫描索引；若查询是覆盖投影，仍可能扫描较窄的索引。这样的扫描与高效定位不是一回事。OR 也并非一概禁用索引，优化器可能使用 index merge，但多个分支选择性很差时仍可能选择全表扫描。技术文章应解释具体成本，而不是给出见 OR 就改的口诀。

## 上线后为什么计划又变了

测试环境十万条数据与生产十亿条数据有不同的树高度、缓存命中、排序体量和参数分布。增加索引本身也会占用空间并改变写入延迟。上线要监控查询模板的 P95/P99、扫描行数、返回行数、锁等待和主从延迟，不能只记录一次最短耗时。直方图能帮助描述列分布，但它不是理解任意多列相关性的万能工具。

出现退化时先保存现有计划和统计，再考虑 ANALYZE TABLE。立即更新统计可能改变证据，也可能影响其他查询。如果临时需要 hint，应限定到经过验证的 SQL，记录生效版本与移除条件。索引回滚也不是删除新索引那么简单：其他新上线查询可能已经依赖它。发布记录应把 SQL 改写、索引 DDL、应用版本和验证参数绑定起来。`,
lab:'实验重点是比较同一查询在不同数据分布和访问路径下的工作量。每次只改变一个条件，记录计划、参数、返回行数及环境，不把示例中的预期当作固定优化器输出。',
cases:[
['PLAN-01','缺少复合索引','订单表只有创建时间索引且目标租户状态稀疏','保存原始计划后增加租户、状态、时间复合索引','确认扫描候选行和实际耗时是否下降，结果集合保持一致','索引优化必须同时验证性能和语义，优化器不承诺固定选中某个名称'],
['PLAN-02','覆盖与回表','同一筛选条件分别读取 id 和额外的大 remark 字段','执行两组投影并比较实际算子工作','能区分索引内返回与回表读取，记录网络结果大小','减少回表不等于减少所有成本，大字段传输也可能成为主要开销'],
['PLAN-03','参数倾斜','大租户占多数数据，小租户只有少量行','对两个租户运行完全相同的 SQL 模板','保留各自估算行数、实际行数和选择的路径','一个参数的优化结论不应不经验证推广到全部租户'],
['PLAN-04','函数条件改写','created_at 有索引且样本覆盖多个日期','比较 DATE(created_at) 与半开时间范围查询','返回同一业务日期数据，并比较扫描范围','改写需要保留时区和边界语义，尤其不能把日期末尾写成模糊的最后一毫秒'],
['PLAN-05','深分页','固定数据集存在超过多页的相同创建时间','比较 OFFSET 与双字段游标分页','游标无重复遗漏，排序相同且访问工作量得到解释','只保留时间或只保留 id 的游标可能改变原排序契约'],
['PLAN-06','排序成本','筛选后只有少量行但计划出现 filesort','保留原方案并与强制排序索引的实验方案比较','根据总耗时和扫描行数选择方案而非按文字打分','额外排序可在内存完成，避免排序可能付出更多扫描成本'],
['PLAN-07','连接放大','外层租户查询返回许多行，内层每次查少量记录','检查 EXPLAIN ANALYZE 的 loops 与每轮行数','能估算累计内层工作，定位重复查找是否成为瓶颈','单次查找很快并不意味着执行上万次后总成本仍小'],
['PLAN-08','冷热缓存','数据库参数、数据与 SQL 均保持一致','分别记录首次访问与重复访问的延迟分布','明确标注缓存状态，避免将预热收益当成索引收益','数据库缓冲、操作系统页缓存及并发负载都会影响实际耗时']
],end:'## 调优记录应该能让别人复查\n\n一份合格记录至少包含查询目的、原 SQL 与参数、表结构、数据分布、优化前后计划、结果一致性证据和写入侧代价。无法给出这些材料时，“快了十倍”只是一个未经限定的数字。让计划解释工作量，让实验解释收益，再让上线监控证明收益仍然存在。',refs:[['MySQL：EXPLAIN 输出','https://dev.mysql.com/doc/refman/8.4/en/explain-output.html'],['本地延伸：MySQL 索引','MySQL索引详解/MySQL索引详解.md']]}
];
for(const a of articles) console.log(writeArticle(a));
