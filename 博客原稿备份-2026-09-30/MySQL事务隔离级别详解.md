# MySQL 事务隔离级别详解

事务隔离级别用于控制并发事务之间能看到什么数据。隔离性越强，通常需要更多锁或版本管理，吞吐和并发度可能下降。理解隔离级别时，要同时区分 SQL 标准定义和 InnoDB 的具体实现。

## 一、三个并发问题

- 脏读：事务读到了另一个事务尚未提交的数据；
- 不可重复读：同一事务两次读取同一行，结果不同；
- 幻读：同一事务按条件查询两次，第二次多出或少了符合条件的行。

## 二、四种隔离级别

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

## 三、MVCC 与两类读取

普通 `SELECT` 通常是快照读。InnoDB 根据事务的 Read View 读取符合可见性规则的历史版本，不需要给读取的记录加排他锁。

`SELECT ... FOR UPDATE`、`SELECT ... FOR SHARE`、`UPDATE` 和 `DELETE` 属于当前读，需要读取最新版本，并可能加记录锁、间隙锁或 Next-Key Lock。

因此，“同一事务两次 SELECT 结果一致”只适用于相同的快照读语义；如果中间使用了当前读，或者事务隔离、锁范围不同，结果分析会不同。

## 四、用两个会话理解隔离

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

## 五、幻读和间隙锁

假设事务 A 使用条件 `salary = 500` 查询，事务 B 插入一条同样满足条件的记录。若 A 只是普通快照读，两次读取使用同一个 Read View，通常看不到 B 新提交的行；若 A 使用当前读，InnoDB 会根据索引范围加锁，阻止其他事务在锁定范围内插入，前提是查询能够使用合适的索引。

没有合适索引时，锁范围和扫描成本都可能变大。间隙锁还可能导致插入等待，因此需要在并发写入场景中观察锁等待和死锁，而不是只看 SQL 是否返回正确结果。

## 六、选择建议

- `READ COMMITTED`：希望减少间隙锁影响，能接受同一事务前后读取不同版本；
- `REPEATABLE READ`：多数 InnoDB 业务的默认选择，适合稳定快照读取；
- `SERIALIZABLE`：对一致性要求极高且并发量可控的场景，需评估锁等待；
- `READ UNCOMMITTED`：只适合极少数允许脏读的统计或监控场景。

隔离级别不能替代业务校验。例如扣库存仍应有条件更新、版本号或行锁；转账仍要在合理事务边界内完成，并设置超时和死锁重试。

## 七、常见排查命令

```sql
SHOW ENGINE INNODB STATUS;
SELECT * FROM performance_schema.data_locks;
SELECT * FROM performance_schema.data_lock_waits;
```

结合执行计划和索引结构，确认事务到底锁了哪些记录和范围。长事务会延迟历史版本清理，也可能阻塞 DDL 和大量写入，应用应及时提交或回滚。

## 总结

隔离级别描述的是并发事务之间的可见性和锁行为。理解 MySQL 时要区分快照读、当前读、MVCC、记录锁和间隙锁，再根据冲突概率、业务一致性和吞吐目标选择级别，而不是简单认为“级别越高越好”。
