# MySQL 执行计划分析

> 阅读范围：MySQL 8.0/8.4；示例围绕订单检索，实际计划由数据和统计信息决定。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


SQL 能返回正确结果，不代表执行效率足够好。`EXPLAIN` 可以把优化器选择的访问路径展示出来，帮助我们判断查询顺序、索引命中情况、预计扫描行数和额外操作。

## 获取执行计划

```sql
EXPLAIN
SELECT id, name
FROM user
WHERE tenant_id = 10 AND status = 'ACTIVE'
ORDER BY created_at DESC
LIMIT 20;
```

`EXPLAIN` 主要是估算，不会像普通 `SELECT` 一样返回查询结果。需要关注真实执行耗时时，可以使用适用于当前版本的 `EXPLAIN ANALYZE`，但它会实际执行语句，生产环境使用前必须确认语句不会产生不希望的写入或锁影响。

## 重要字段

| 字段 | 含义 |
| --- | --- |
| `id` | 每个 SELECT 的标识和执行层级 |
| `select_type` | SIMPLE、PRIMARY、SUBQUERY、UNION、DERIVED 等查询类型 |
| `table` | 当前访问的表或派生结果 |
| `partitions` | 命中的分区 |
| `type` | 访问方式，反映扫描范围和索引使用方式 |
| `possible_keys` | 优化器认为可能使用的索引 |
| `key` | 实际选择的索引 |
| `key_len` | 实际使用的索引长度 |
| `ref` | 与索引比较的列或常量 |
| `rows` | 预计读取行数 |
| `filtered` | 过滤后保留的行比例 |
| `Extra` | 额外的排序、临时表、覆盖索引等信息 |

`possible_keys` 不为 NULL 不代表一定使用索引；最终是否使用要看 `key`。`rows` 是估算值，不是精确结果，应结合表统计信息和实际执行验证。

## type 访问类型

常见访问类型大致从好到差为：

```text
system -> const -> eq_ref -> ref -> range -> index -> ALL
```

- `const`：通过主键或唯一索引定位到至多一行；
- `eq_ref`：连接时通过主键或唯一索引匹配一行；
- `ref`：普通索引等值匹配，可能返回多行；
- `range`：索引范围扫描，如 `>、<、BETWEEN、IN`；
- `index`：扫描整棵索引；
- `ALL`：全表扫描。

`ALL` 不一定绝对错误，小表全表扫描可能比随机回表更快；但在大表、高并发或返回行数很少的场景中，需要重点检查。

## Extra 中的信号

- `Using index`：覆盖索引，查询列都可以从索引取得，不需要回表；
- `Using where`：读取后还要根据条件过滤；
- `Using index condition`：启用了索引条件下推；
- `Using temporary`：需要临时表，常见于复杂分组或排序；
- `Using filesort`：排序没有直接使用索引顺序；
- `Using join buffer`：使用了连接缓冲或相应连接算法，应结合算法名称与实际行数分析，不能单凭此字段断言没有索引。

`Using filesort` 不是指一定使用磁盘，也不是看到它就必须加索引。要结合数据量、排序字段、过滤选择性和实际耗时判断。

## 联合索引与最左匹配

假设有索引：

```sql
CREATE INDEX idx_user_tenant_status_time
ON user(tenant_id, status, created_at);
```

它适合从 `tenant_id` 开始的等值、范围和排序组合。若只按 `status` 查询，通常不能充分使用这个索引；若在 `tenant_id` 上先使用范围条件，后续列的排序和筛选能力也可能受到影响。

联合索引顺序应结合选择性、等值条件、范围条件和排序需求设计，而不是简单把字段按表结构顺序拼起来。

## 一个完整的分析流程

1. 先确认 SQL 的业务结果和数据量；
2. 查看 `EXPLAIN` 的 `type`、`key`、`rows`、`Extra`；
3. 检查过滤、连接、排序和分组字段是否有合适索引；
4. 确认索引没有被函数、隐式类型转换或前置通配符破坏；
5. 用代表性数据测试优化前后的实际耗时；
6. 上线后观察慢查询、锁等待和资源使用，而不只看一份计划。

例如下面的写法可能让普通索引失效：

```sql
WHERE DATE(created_at) = '2026-09-14'
```

更容易使用时间索引的写法是：

```sql
WHERE created_at >= '2026-09-14 00:00:00'
  AND created_at <  '2026-09-15 00:00:00'
```

## 统计信息与计划变化

优化器依赖索引统计信息。数据分布变化、参数不同、表增长和版本升级都可能让计划发生变化。查询慢时不能只保存一份旧 `EXPLAIN` 结果，应结合当前数据量、参数和数据库配置复核。


## 建立可以反复比较的订单实验

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
WHERE tenant_id=28 AND status='PAID'
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

出现退化时先保存现有计划和统计，再考虑 ANALYZE TABLE。立即更新统计可能改变证据，也可能影响其他查询。如果临时需要 hint，应限定到经过验证的 SQL，记录生效版本与移除条件。索引回滚也不是删除新索引那么简单：其他新上线查询可能已经依赖它。发布记录应把 SQL 改写、索引 DDL、应用版本和验证参数绑定起来。

## 索引上线也需要评估写入代价

一条查询加速后，其他写入可能变慢。每增加一个二级索引，插入、删除和索引列更新都需要维护更多结构，还会增加日志、缓存与备份体积。覆盖索引如果把很长的展示字段也纳入，可能用更大的总体成本换取一次查询的少量回表减少。评审时应把读频率、写频率、字段更新频率与索引大小放在一起。

可先在测试副本比较索引空间和写入延迟，再评估上线 DDL 的锁、I/O 与复制影响。即使使用在线 DDL，也不能保证对所有版本、表结构和操作类型都完全无阻塞。维护窗口、磁盘余量与回滚路径需要根据具体算法验证，不要仅凭 ONLINE 这个词放松观察。

~~~sql
-- 只读观察：查看目标表索引和空间估算。
SHOW INDEX FROM plan_lab.orders;
SELECT table_schema, table_name, table_rows,
       data_length, index_length, data_free
FROM information_schema.tables
WHERE table_schema='plan_lab' AND table_name='orders';

-- 候选索引的查询端收益应与写入端代价一起记录。
EXPLAIN FORMAT=JSON
SELECT id, created_at
FROM plan_lab.orders
WHERE tenant_id=10 AND status='PENDING'
ORDER BY created_at DESC,id DESC
LIMIT 20;
~~~

索引重复也要谨慎判断。一个三列索引可能覆盖两列前缀查询，但较短索引更窄，某些高频扫描仍可能受益；唯一索引还承担约束，不能仅因访问路径被覆盖就删除。先确认依赖查询、约束职责和实际使用情况，再做灰度变更。版本支持的不可见索引可以帮助评估部分查询计划变化，但它仍然占用存储并参与写入维护，不能用它模拟“彻底不存在”的全部成本。

执行计划优化因此是闭环工程：先证明读瓶颈，设计候选访问路径，再比较读写总体成本，最后观察上线后的参数分布与计划变化。保留原始计划和测试数据生成方法，可以让下一次版本升级有可重复的比较基线。

## 一对多连接先确认是否真的需要每个匹配行

订单与订单明细是一对多关系。如果页面只想展示“包含某种商品的订单”，直接 JOIN 明细会让同一订单出现多次。事后加 DISTINCT 可以恢复某些投影的去重效果，却可能增加不必要的中间行和去重工作。若还在 JOIN 后直接 LIMIT，分页限制的对象可能已经变成连接行，导致每页实际订单数不足。这个问题首先属于结果语义，不能单纯靠给明细表加索引解决。

可以用下面的辅助表，在同一订单放入两条满足筛选条件的明细，再比较不同写法。外部业务键是否全局唯一，应在表结构与租户约束中明确；示例仍将租户纳入关联条件。

~~~sql
CREATE TABLE order_item (
  id BIGINT PRIMARY KEY,
  tenant_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  sku VARCHAR(64) NOT NULL,
  KEY idx_item_order_sku(tenant_id, order_id, sku)
) ENGINE=InnoDB;
INSERT INTO order_item VALUES
  (1,10,1,'SKU-A'),(2,10,1,'SKU-A');

EXPLAIN ANALYZE
SELECT o.id, o.created_at
FROM orders o
WHERE o.tenant_id=10
  AND EXISTS (
    SELECT 1 FROM order_item i
    WHERE i.tenant_id=o.tenant_id
      AND i.order_id=o.id
      AND i.sku='SKU-A'
  )
ORDER BY o.created_at DESC,o.id DESC
LIMIT 20;
~~~

EXISTS 表达的是至少存在一个符合条件的明细，不要求把全部明细展开到输出。MySQL 可能根据语句形态采用半连接等转换，不能将相关子查询文字上位于内层直接解读为必定逐行低效执行。具体转换条件和策略可参考[半连接与反连接优化文档](https://dev.mysql.com/doc/refman/8.4/en/semijoins-antijoins.html)。仍需比较实际节点、loops 和扫描行数，不能把“所有 JOIN 都改成 EXISTS”变成另一条调优口诀。

索引顺序也需要围绕驱动方向考虑。已先筛出少量订单时，按租户、订单和 SKU 查明细很自然；如果 SKU 极少出现，先从 SKU 找订单可能更合适，此时另一个索引顺序可能有竞争力。增加索引之前先估算两边候选集合大小，并分别选择常见 SKU 与罕见 SKU 验证。演示只有两条明细用于证明重复语义，测性能需要填充有代表性的明细分布。

## 外连接过滤位置与聚合粒度一起核对

如果产品要列出全部订单并附带已支付退款总额，没有退款的订单也必须保留。LEFT JOIN 后在 WHERE 写退款表的 status='PAID'，会把没有匹配退款的空扩展行过滤掉；把该条件放入 ON，则表达仅匹配已支付退款，同时保留订单侧行。两种写法都可能执行很快，但它们回答的是不同业务问题。

连接两张一对多子表还会放大金额。某订单有三条商品明细、两条退款记录，同时直接连接可能产生六个中间行。如果随后 SUM 订单金额或退款金额，就可能重复计算。修复方式通常是先把每张子表聚合到订单粒度，再按订单连接，或者在相互独立的查询中取得所需汇总。聚合后中间结果是否物化、是否使用临时表，再交给执行计划评估；不能用一个看起来更好的 type 掩盖错误总额。

审查聚合 SQL 时，可以先写下每个算子输入和输出的唯一键：订单主表以订单 ID 唯一，明细以明细 ID 唯一，退款汇总以订单 ID 唯一。若连接后预期唯一的订单 ID 不再唯一，应先解释重复从哪里来。对于 COUNT，也要区分统计连接行、统计非空匹配项和统计不同订单数，三个表达式在外连接下可能得到完全不同结果。

性能验收最好附上一组专门覆盖语义边界的数据：没有明细、多个相同 SKU、没有退款、多笔退款以及跨租户相同业务编号。先核对列表、总数、汇总值和分页顺序，再比较耗时。这样执行计划分析才不会为了减少一次排序或一次扫描，悄悄把业务问题改成更容易计算的另一个问题。

## 故障注入与验收实验

实验重点是比较同一查询在不同数据分布和访问路径下的工作量。每次只改变一个条件，记录计划、参数、返回行数及环境，不把示例中的预期当作固定优化器输出。

### PLAN-01：缺少复合索引

实验前提是订单表只有创建时间索引且目标租户状态稀疏。执行保存原始计划后增加租户、状态、时间复合索引。

通过条件是确认扫描候选行和实际耗时是否下降，结果集合保持一致。这里的判断依据是索引优化必须同时验证性能和语义，优化器不承诺固定选中某个名称。

### PLAN-02：覆盖与回表

实验前提是同一筛选条件分别读取 id 和额外的大 remark 字段。执行两组投影并比较实际算子工作。

通过条件是能区分索引内返回与回表读取，记录网络结果大小。这里的判断依据是减少回表不等于减少所有成本，大字段传输也可能成为主要开销。

### PLAN-03：参数倾斜

实验前提是大租户占多数数据，小租户只有少量行。执行对两个租户运行完全相同的 SQL 模板。

通过条件是保留各自估算行数、实际行数和选择的路径。这里的判断依据是一个参数的优化结论不应不经验证推广到全部租户。

### PLAN-04：函数条件改写

实验前提是created_at 有索引且样本覆盖多个日期。执行比较 DATE(created_at) 与半开时间范围查询。

通过条件是返回同一业务日期数据，并比较扫描范围。这里的判断依据是改写需要保留时区和边界语义，尤其不能把日期末尾写成模糊的最后一毫秒。

### PLAN-05：深分页

实验前提是固定数据集存在超过多页的相同创建时间。执行比较 OFFSET 与双字段游标分页。

通过条件是游标无重复遗漏，排序相同且访问工作量得到解释。这里的判断依据是只保留时间或只保留 id 的游标可能改变原排序契约。

### PLAN-06：排序成本

实验前提是筛选后只有少量行但计划出现 filesort。执行保留原方案并与强制排序索引的实验方案比较。

通过条件是根据总耗时和扫描行数选择方案而非按文字打分。这里的判断依据是额外排序可在内存完成，避免排序可能付出更多扫描成本。

### PLAN-07：连接放大

实验前提是外层租户查询返回许多行，内层每次查少量记录。执行检查 EXPLAIN ANALYZE 的 loops 与每轮行数。

通过条件是能估算累计内层工作，定位重复查找是否成为瓶颈。这里的判断依据是单次查找很快并不意味着执行上万次后总成本仍小。

### PLAN-08：冷热缓存

实验前提是数据库参数、数据与 SQL 均保持一致。执行分别记录首次访问与重复访问的延迟分布。

通过条件是明确标注缓存状态，避免将预热收益当成索引收益。这里的判断依据是数据库缓冲、操作系统页缓存及并发负载都会影响实际耗时。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "MySQL执行计划分析",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "PLAN-01",
      "scenario": "缺少复合索引",
      "given": "订单表只有创建时间索引且目标租户状态稀疏",
      "when": "保存原始计划后增加租户、状态、时间复合索引",
      "then": "确认扫描候选行和实际耗时是否下降，结果集合保持一致"
    },
    {
      "id": "PLAN-02",
      "scenario": "覆盖与回表",
      "given": "同一筛选条件分别读取 id 和额外的大 remark 字段",
      "when": "执行两组投影并比较实际算子工作",
      "then": "能区分索引内返回与回表读取，记录网络结果大小"
    },
    {
      "id": "PLAN-03",
      "scenario": "参数倾斜",
      "given": "大租户占多数数据，小租户只有少量行",
      "when": "对两个租户运行完全相同的 SQL 模板",
      "then": "保留各自估算行数、实际行数和选择的路径"
    },
    {
      "id": "PLAN-04",
      "scenario": "函数条件改写",
      "given": "created_at 有索引且样本覆盖多个日期",
      "when": "比较 DATE(created_at) 与半开时间范围查询",
      "then": "返回同一业务日期数据，并比较扫描范围"
    },
    {
      "id": "PLAN-05",
      "scenario": "深分页",
      "given": "固定数据集存在超过多页的相同创建时间",
      "when": "比较 OFFSET 与双字段游标分页",
      "then": "游标无重复遗漏，排序相同且访问工作量得到解释"
    },
    {
      "id": "PLAN-06",
      "scenario": "排序成本",
      "given": "筛选后只有少量行但计划出现 filesort",
      "when": "保留原方案并与强制排序索引的实验方案比较",
      "then": "根据总耗时和扫描行数选择方案而非按文字打分"
    },
    {
      "id": "PLAN-07",
      "scenario": "连接放大",
      "given": "外层租户查询返回许多行，内层每次查少量记录",
      "when": "检查 EXPLAIN ANALYZE 的 loops 与每轮行数",
      "then": "能估算累计内层工作，定位重复查找是否成为瓶颈"
    },
    {
      "id": "PLAN-08",
      "scenario": "冷热缓存",
      "given": "数据库参数、数据与 SQL 均保持一致",
      "when": "分别记录首次访问与重复访问的延迟分布",
      "then": "明确标注缓存状态，避免将预热收益当成索引收益"
    }
  ]
}
```

## 调优记录应该能让别人复查

一份合格记录至少包含查询目的、原 SQL 与参数、表结构、数据分布、优化前后计划、结果一致性证据和写入侧代价。无法给出这些材料时，“快了十倍”只是一个未经限定的数字。让计划解释工作量，让实验解释收益，再让上线监控证明收益仍然存在。

## 参考资料与继续阅读

- [MySQL：EXPLAIN 输出](https://dev.mysql.com/doc/refman/8.4/en/explain-output.html)
- [本地延伸：MySQL 索引](MySQL索引详解/MySQL索引详解.md)
