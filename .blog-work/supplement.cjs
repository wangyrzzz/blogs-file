const fs=require('node:fs'); const path=require('node:path');
const additions={
'MySQL事务隔离级别详解.md':`## 写偏差：没有覆盖同一行也可能破坏规则

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
`,
'MySQL执行计划分析.md':`## 索引上线也需要评估写入代价

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
`,
'Redis 5 种基本数据类型详解.md':`## 用 Lua 把购物车数量校验与更新组合起来

HINCRBY 本身原子，但“读取数量、判断上限、再增加”依旧是复合流程。购物车若规定同一 SKU 最多九十九件，可以使用一个短脚本把读取、合法性检查和写入放在同一执行范围内。脚本只处理一个 field，不遍历无界集合，工作量容易控制。

~~~lua
-- KEYS[1]: cart key
-- ARGV[1]: sku
-- ARGV[2]: integer delta, validated by the application
-- ARGV[3]: positive cart ttl in seconds
local delta = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
if not delta or delta ~= math.floor(delta) then
  return redis.error_reply('INVALID_DELTA')
end
if not ttl or ttl <= 0 or ttl ~= math.floor(ttl) then
  return redis.error_reply('INVALID_TTL')
end
local current = tonumber(redis.call('HGET', KEYS[1], ARGV[1]) or '0')
if not current then
  return redis.error_reply('INVALID_STORED_QUANTITY')
end
local nextQuantity = current + delta
if nextQuantity < 0 or nextQuantity > 99 then
  return redis.error_reply('QUANTITY_OUT_OF_RANGE')
end
if nextQuantity == 0 then
  redis.call('HDEL', KEYS[1], ARGV[1])
else
  redis.call('HSET', KEYS[1], ARGV[1], nextQuantity)
end
redis.call('EXPIRE', KEYS[1], ttl)
return nextQuantity
~~~

这里更新的是购物车意向数量，不是仓库可售库存。加入购物车不能承诺结算一定成功，真正下单仍需在库存权威路径校验。数量为零删除 field，使字段数量能够代表购物车中不同 SKU 的数量；若最后一个 field 被删掉，Key 随之不存在，后续 EXPIRE 返回零是正常情况。

脚本还要面对数据类型错误：若同名 Key 被其他业务写成 String，HGET 会报错，应作为命名空间冲突排查，不要捕获后无条件删除重建。生产调用可使用脚本缓存减少传输，但要处理脚本缓存丢失后的重新加载。连接故障后的重试也要区分增加数量与设定最终数量：重复执行增量会重复增加，网络超时不能直接证明脚本没有执行。
`,
'MQTT协议探索.md':`## MQTT 5 的流量限制与原因码

MQTT 5 不只是把 cleanSession 改成两个参数，还增加了更明确的属性与错误反馈。Receive Maximum 用来限制同时在途的部分 QoS 消息数量，Maximum Packet Size 用来约束报文大小，Message Expiry Interval 表达消息寿命。使用这些能力时要确认 Broker 与客户端真的协商并遵守相应属性，不能只在设备配置中写一个数字。

在途限制与业务工作队列上限是两道边界。协议侧允许十条未确认消息，并不意味着应用可以把已经确认的十万条消息无限缓存在内存中。若先做持久接收再确认，可以把网络确认与慢业务处理解耦，但需要为持久 inbox 设置容量、过期和清理规则。若处理完才确认，则要评估长耗时对连接和吞吐的影响。

错误原因码有助于区分认证失败、未授权主题、配额超限和服务暂时不可用。客户端面对永久凭证错误不应每秒重连，面对暂时不可用则可以退避恢复。把所有失败都当成网络问题，会让一批已撤销设备持续消耗 Broker 资源。设备升级时也要保留最低兼容行为，不能让旧固件误把未知原因码解释成成功。

Topic Alias 可以减少长主题在重复发布中的编码成本，但别名具有连接范围。重连以后不能假定 Broker 仍保留之前的别名映射。优化网络字节数前先保证别名建立和重连恢复正确，否则一个看似无害的压缩优化会制造间歇性协议错误。

~~~json
{
  "devicePolicy": {
    "clientIdentity": "stable-per-device",
    "authenticationFailure": "stop-and-request-credential-repair",
    "temporaryUnavailable": "retry-with-exponential-backoff-and-jitter",
    "expiredCommand": "record-expired-and-do-not-execute",
    "duplicateCommand": "return-persisted-result",
    "sessionLost": "resubscribe-and-report-current-state",
    "topicAliasAfterReconnect": "rebuild-connection-local-mapping"
  }
}
~~~

这份策略是应用设计示例，不是 Broker 的通用配置文件。它把连接级状态、持久业务状态和恢复行为分开，有助于设备团队与平台团队在联调前统一故障处理，而不是上线后靠重启设备碰运气。
`,
'Dubbo3探索.md':`## 压测要区分业务并发与连接并发

同样是一千个并发请求，可能来自一千个独立连接，也可能复用少量 HTTP/2 连接。两者对握手、流控制、线程调度和提供者分布的影响不同。协议选型压测应保留连接模式、载荷大小、序列化格式、压缩与 TLS 设置，不能只记录一个 QPS 数字。

还要把成功吞吐与尝试吞吐分开。若每个用户请求平均重试两次，提供者收到的调用量可能很好看，真正完成的业务却没有增加。统计 user_request_count、rpc_attempt_count、successful_business_count 和 deduplicated_count，可以揭示重试放大和幂等拦截。错误率也应区分业务拒绝与基础设施故障，库存不足不是网络可用性故障。

~~~json
{
  "rpcLoadScenario": {
    "operation": "CreateOrder",
    "transport": "selected-and-recorded-protocol",
    "payloadProfile": "fixed-contract-with-realistic-field-lengths",
    "connectionMode": "persistent-connections",
    "loadPhases": ["warmup", "steady", "provider-delay", "recovery"],
    "counters": [
      "user_request_count",
      "rpc_attempt_count",
      "successful_business_count",
      "deduplicated_count",
      "uncertain_result_count"
    ],
    "latencies": ["client_total", "provider_queue", "provider_business"],
    "invariants": [
      "one-business-result-per-idempotency-key",
      "retry-budget-never-exceeds-parent-deadline",
      "recovery-does-not-create-a-second-traffic-spike"
    ]
  }
}
~~~

这份规格应由实际压测工具适配，不能直接当成 Dubbo 配置。恢复阶段尤其值得关注：慢实例恢复后，积压请求和客户端重试可能同时涌入，导致第二次过载。设置有界队列、拒绝过期请求和限制重试速率，通常比无限增加线程更能缩短恢复时间。

对跨语言 Triple 调用，还要加入消息大小边界、取消传播与流式消费速度测试。一个客户端能成功调用一次 unary 方法，只能证明最小互通，不代表流式、鉴权、网关代理和错误映射都已经兼容。将这些能力逐项列入版本矩阵，才能让协议迁移有清楚范围。
`,
'WebSocket长连接会话.md':`## 连续序号与业务版本不要互相替代

会话流序号回答通知顺序和补发位置，订单 version 回答某个订单的状态更新先后。一个用户可能在同一流中收到多张订单的事件，因此不能拿某张订单的 version 当成全流水位。反过来，全流序号更大，也不必然允许覆盖所有业务对象的当前版本，补发和不同事件类型仍可能交错。

客户端可以维护两个状态：lastContiguousSequence 用于恢复流，entityVersionById 用于避免旧实体状态覆盖新值。消息已去重但对应业务对象已被本地更新时，可以推进连续水位而不重复覆盖对象。若需要展示每一个事件历史，则应另存事件列表，不能仅保留最终实体快照。

多端 ACK 也要定义范围。一部手机确认了消息，不代表另一个浏览器已经收到。如果服务端按用户只保存一个 ACK 水位，会影响其他设备恢复。可以按设备保存水位，也可以让每个客户端自己携带水位并由服务端验证。前者更便于管理，后者减少服务端状态，但两者都需要处理水位过期与异常跳跃。

消息压缩可能降低带宽，也可能提高 CPU 和内存负担。大规模连接下应测量典型载荷与峰值积压，不能默认所有小型 JSON 都从压缩获益。连接级安全配置、压缩字典与敏感数据处理也应按照部署环境审查。把连接数、每秒消息数和每条平均字节量同时纳入容量模型，才能比较网络瓶颈与应用处理瓶颈。
`,
'Loki日志系统替代ELK.md':`## 查询性能与日志新鲜度是两种体验

用户可能抱怨“日志查得慢”，但真正问题是日志还没进入可查询路径。应分别度量事件产生到可查询的延迟，以及一条已存在日志的查询响应时间。前者可能受采集缓冲、写入重试和存储刷新影响，后者更多受时间范围、标签选择、解析和查询资源影响。混用一个指标会使优化方向错误。

可以在 canary 事件中加入递增序号与产生时间，定期从查询端验证最新已见序号。测试环境先确认时钟同步，再计算端到端延迟；若时钟不可靠，优先使用同一控制器记录发送和查询观察时间。缺失序号不能立即判定永久丢失，还要留出正常摄取延迟窗口，并区分迟到、重复和最终缺失。

查询缓存让重复搜索变快，但不替代合理标签和时间范围设计。迁移压测至少要包括第一次查询、重复查询以及不同参数查询，不要只展示缓存最热时的延迟。对于频繁执行的告警和仪表盘，可以研究记录规则或直接应用指标，减少反复扫描相同日志的计算。

对象存储的请求次数也会影响费用和限流。大量碎片流产生小块后，虽然压缩总字节量不大，读取和列举操作仍可能很多。观察单流平均块大小、流生命周期与查询读取量，可以解释为什么把 traceId 从标签移回正文后，平台整体成本反而下降。
`,
'轻量级鉴权框架Sa-Token.md':`## 将授权条件下沉到查询，而不是查完再过滤

分页查询如果先从数据库取二十条，再在 Java 中去掉无权限记录，会出现每页数量不足、总数泄漏和翻页遗漏。更合适的方式是在查询时就加入可信租户与数据范围条件，让列表、总数、导出和详情使用一致规则。权限表达式要参数化，不能把用户输入的部门列表直接拼成 SQL。

~~~sql
SELECT id, status, amount_cents, created_at
FROM orders
WHERE tenant_id = ?
  AND owner_user_id = ?
  AND created_at < ?
ORDER BY created_at DESC, id DESC
LIMIT ?;
~~~

上面只展示本人数据范围；部门共享、上下级组织和委托权限需要独立建模。超级管理员绕过条件的入口尤其要集中，避免某个字符串角色名称被客户端伪造后触发全量访问。导出任务即使异步执行，也必须保存经过验证的范围，或在执行时重新评估授权，不能只保存一个用户 ID 就默认拥有永久导出权。

权限缓存可以使用 permissionVersion 让撤销更容易收敛，但版本变更必须可靠传播，旧会话如何感知新版本要有明确机制。涉及转账、修改安全设置等敏感动作，可以要求近期认证或额外确认；这与普通登录过期不同，不能只要 Token 还有效就允许全部高风险操作。

审计记录应包含“谁以什么身份对哪个资源做了什么、结果怎样”，同时保留必要的策略版本。这样权限规则调整后，仍能解释历史操作当时为什么被允许。审计不应只写“权限校验成功”，因为缺少对象和租户信息的成功日志很难在事故中发挥作用。
`
};
for(const [file,extra] of Object.entries(additions)){
 const p=path.resolve(__dirname,'..',file);let s=fs.readFileSync(p,'utf8');
 if(!s.includes(extra.split('\n')[0]))s=s.replace('\n## 故障注入与验收实验','\n'+extra+'\n## 故障注入与验收实验');
 fs.writeFileSync(p,s);
}
console.log('Added topic-specific advanced sections to eight articles.');
