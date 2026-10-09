const {writeArticle}=require('./compose.cjs');
const articles=[{
file:'分库分表实战.md',scope:'以订单的两库、每库四表为教学模型；路由程序独立于具体中间件配置版本',
replace:[['spring:\n  shardingsphere:','示意层级_非可直接运行配置:\n  shardingsphere:'],['灰度切换读流量，再切换写流量；','按迁移协议执行切流；切换读写的顺序必须与唯一写入权、增量追平和回滚机制一致，不能机械固定为先读后写；']],
body:`## 没有证据就不要先拆库

单表多少行必须拆分没有普遍阈值。行宽、索引数量、热点比例、查询形态、磁盘和维护窗口都会影响上限。十亿行只读归档与千万行高频热点更新是不同问题。拆分前先回答瓶颈来自随机 I/O、写入日志、锁竞争、连接数、索引不合理还是查询返回过多。

容量预测应该写出假设：日新增订单量、在线保留天数、平均行大小、索引倍率与峰值放大系数。若每天一百万订单、在线保留一年，就是约三亿六千五百万行；这只是行数估计，不能直接换成固定硬件需求。先做归档与索引优化，再评估是否需要水平拆分，通常比一次引入所有分布式复杂度更稳妥。

## 两库四表要避免路由公式相关

这里约定“两库，每库四表”，共八个物理分片。一个常见错误是 db=hash%2、table=hash%4。因为两者相关，只会命中部分组合，并不会均匀使用八张表。正确的简单演示是先计算全局槽 slot=hash%8，再 db=slot/4、table=slot%4。

~~~java
public final class OrderRoute {
    public record Route(int database,int table,int slot) {
        public String physicalTable() {
            return "orders_"+String.format("%04d",table);
        }
    }
    // 教学示例：生产需固定可跨语言重现的 hash 算法与路由版本。
    public static Route route(long userId) {
        int slot=(int)Math.floorMod(userId,8L);
        return new Route(slot/4,slot%4,slot);
    }
    public static void main(String[] args) {
        for (long id=0;id<16;id++) {
            Route route=route(id);
            System.out.printf("user=%d -> ds%d.%s slot=%d%n",
                id,route.database(),route.physicalTable(),route.slot());
        }
    }
}
~~~

用用户 ID 直接取模便于说明，不代表用户分布一定均匀。企业租户可能有一个超级大客户，按 tenant_id 路由会把全部写压力留在一片。反过来按 user_id 分散，则租户全量报表需要跨片。选择分片键是选择主要聚合边界，无法同时让所有查询都只访问一个分片。

## 物理表与路由契约

每个物理库都建立 orders_0000 到 orders_0003，结构和索引一致。SQL 片段仅展示其中一张。主键由全局发号方案提供，user_id 不允许普通更新改变，否则会引发跨分片迁移。

~~~sql
CREATE TABLE orders_0000 (
  id BIGINT NOT NULL,
  tenant_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  request_key VARCHAR(128) NOT NULL,
  status VARCHAR(24) NOT NULL,
  amount_cents BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_request (user_id,request_key),
  KEY idx_user_time (user_id,created_at,id),
  KEY idx_tenant_status (tenant_id,status)
) ENGINE=InnoDB;
~~~

唯一键的业务作用域必须与路由一致。user_id 与 request_key 的组合能保证同一用户请求在其落点内唯一，不能保证 request_key 在所有租户所有用户中全局唯一。全局手机号注册等需求可能需要独立唯一性索引表，并把“保留唯一键”和“创建业务实体”的故障恢复流程一起设计。

| 查询 | 路由范围 | 建议 |
| --- | --- | --- |
| user_id=42 查订单 | 单片 | 核心在线路径 |
| user_id IN (42,43) | 两个候选片 | 按片分组并限制并发 |
| 仅 order_id 查询 | 取决于 ID 路由信息 | 使用路由索引或明确广播预算 |
| 某租户今日总额 | 可能多片 | 建汇总投影或分析系统 |
| 全局按时间深分页 | 全片并归并 | 改为导出任务或游标协议 |

若 ID 编码包含路由信息，必须把编码版本和历史规则一起保存；否则扩容后解码规则变化会使旧订单查不到。把 user_id 作为查询参数也不能完全信任客户端，它还需要与认证数据范围核对。

## 跨片分页的工作量

每片都执行 OFFSET m LIMIT n 再简单拼接，不会得到正确的全局分页。通常需要取各片前 m+n 个候选，再全局排序截取，这会把深分页成本乘上分片数。游标分页可以记录稳定排序键，分别取后续候选并做 k 路归并，但仍需要全局稳定的并列规则。

例如按 created_at DESC,id DESC 排序，每片返回下一批候选，应用使用堆选择全局前 n 条。某片超时怎么办必须写进契约：财务报表不能悄悄返回其余七片并声称完整，面向用户的推荐列表则可能允许标记部分结果。完整性要求决定容错方式，而不是统一吞掉异常。

~~~python
import heapq

def merge_descending(shards, limit):
    # 每个分片已按 (created_at_epoch_ms, id) 降序排序。
    # 示例只做内存归并，查询超时和分页续游标由外层处理。
    heap = []
    for shard_id, rows in enumerate(shards):
        if rows:
            timestamp, order_id, payload = rows[0]
            heapq.heappush(heap, (-timestamp, -order_id, shard_id, 0, payload))
    result = []
    while heap and len(result) < limit:
        neg_time, neg_id, shard_id, index, payload = heapq.heappop(heap)
        result.append((-neg_time, -neg_id, payload))
        next_index = index + 1
        rows = shards[shard_id]
        if next_index < len(rows):
            timestamp, order_id, payload = rows[next_index]
            heapq.heappush(heap, (-timestamp, -order_id, shard_id, next_index, payload))
    return result
~~~

分片后的 COUNT、SUM 和 AVG 也不同。SUM 可以汇总各片和，AVG 应合并总和与总计数，不能简单平均各片平均值。DISTINCT 需要全局去重，ORDER BY 与 LIMIT 需要全局语义。中间件隐藏 SQL 路由，不会让这些代价消失。

## 扩容不是修改一个取模数

slot=userId%8 改为 %16 后，部分旧用户会落到新位置。旧数据还在旧片，读写却按新规则路由，就会出现“新增正常、历史丢失”的假象。稳定逻辑桶加可版本化映射，可以减少规则耦合：先固定大量逻辑桶，再把桶分配到物理实例。迁移仍需要搬数据，但可以按桶逐步执行。

迁移协议应定义源片和目标片谁拥有写入权、全量快照位点、增量同步位置、删除事件、冲突版本和切换状态。双写不是自动保险：一边成功一边失败需要补偿，两个方向同时写还可能产生循环和最后写覆盖。需要单一权威写入或明确冲突规则。

~~~text
PREPARE -> SNAPSHOT_COPY -> CHANGE_CATCHUP -> VALIDATE
VALIDATE -> FENCE_SOURCE_WRITES -> FINAL_CATCHUP -> SWITCH_ROUTE
SWITCH_ROUTE -> OBSERVE -> RETIRE_OLD_COPY

任一阶段失败:
  保留路由版本、位点和当前写入权
  按阶段恢复，不把目标片直接清空重来
~~~

这是示例迁移状态机，不要求所有系统必须停写；无停机方案同样需要证明切换点附近不会丢失或重复。回滚时若新片已接受写入，不能只把路由改回旧片，因为旧片不包含新变更。必须有反向追平或保留一段兼容写入策略。

## 校验不是只对行数

行数相同可能金额不同，简单总和相同也可能两行互相抵消。应按稳定主键区间分块，比较规范化字段摘要，检查新增、修改、删除与边界值；再抽样执行真实业务查询。金额、时间、字符集、NULL 和排序规则必须一致，跨库校验脚本不能因为序列化差异产生假阳性。

校验读取要有一致的观察基准，源和目标持续写入时直接比较可能看到不同时间点。记录同步位点并限制到已追平范围，才能解释差异。敏感数据校验尽量在可信环境完成，不把全量业务数据导出到个人电脑。

## 事务和运维成本会随分片数增长

单分片本地事务仍然简单，跨片转账或订单关联需要重划聚合边界，或引入明确的分布式一致性方案。Outbox 让后续投影可靠，但不会把两个数据库变成一个原子事务。业务补偿必须有自己的状态、幂等键和失败处理。

每个应用实例若为每片创建一个连接池，总连接数约等于应用实例数乘分片数乘每池上限。扩容数据库时应用连接预算也会扩大。Schema 变更、备份、恢复、权限和慢 SQL 分析都需要覆盖全部分片。监控既看总量也看最忙一片，否则平均负载低会掩盖单片过载。`,
lab:'用固定用户 ID 列出全部八个物理组合，再测试常用 SQL 的路由范围。迁移实验至少覆盖新增、修改、删除和切换后回滚，不只做静态全量复制。',
cases:[
['SHARD-01','八片覆盖','两库每库四表都已创建','遍历连续用户 ID 并打印路由','全部八个组合被使用','库表分别使用相关取模公式可能只覆盖部分组合'],
['SHARD-02','路由稳定','不同语言都需要计算同一路由','对边界和负值样本运行相同算法','结果与固定路由版本一致','语言 hash 和取余符号差异可能导致跨客户端错路由'],
['SHARD-03','单片核心查询','请求携带已授权 user_id','查询订单列表并查看实际 SQL','只访问目标分片且使用所需索引','分片收益来自主要请求局部化'],
['SHARD-04','缺少分片键','仅提供订单 ID','执行查询并查看广播或索引路由','成本符合接口预算且没有隐藏全片扫描','全局 ID 唯一不自动意味着可以推导物理位置'],
['SHARD-05','唯一约束边界','相同 request_key 属于不同用户','在不同片插入测试记录','结果符合唯一性作用域而不是误称全局唯一','单片索引只保护其物理约束范围'],
['SHARD-06','全局分页','各片都有相同时间的订单','执行双字段排序并归并多页','无重复遗漏且与全量排序基线一致','分片内排序正确不等于全局排序正确'],
['SHARD-07','平均值合并','各片订单数量差异很大','比较平均片均值与总和除总数','采用加权正确结果','聚合函数需要按可合并语义处理'],
['SHARD-08','直接改取模','旧数据按八槽保存','只将路由改为十六槽后读取历史','复现错路由并明确需要迁移协议','算法变化不会自动搬动已有数据'],
['SHARD-09','增量删除','全量复制后源片发生删除','同步增量并验证目标','目标不会保留幽灵记录','迁移必须包含删除事件而非只有新增和更新'],
['SHARD-10','切换后回滚','目标片已开始接受新写入','尝试按回滚协议恢复旧片','新变更得到追平或明确阻止不安全切回','路由回滚与数据回滚不是同一个动作'],
['SHARD-11','热点租户','一个租户占大多数写流量','比较各片 P99 与资源而非只看平均','识别单片热点并评估独立隔离','取模均匀分配键不保证均匀分配业务负载'],
['SHARD-12','连接预算','多个应用实例为每片建池','按扩容后片数计算并压测连接','总连接不超过数据库预算且池等待受控','分片会把连接池和运维资源成倍扩展']
],end:'## 实战落地的核心\n\n分片方案必须同时解释主要查询怎样定位、唯一性在哪里保证、数据怎样迁移，以及故障后怎样恢复。只有把路由版本和写入权当成正式协议，数据库拆开后才不会把一致性问题分散给每个业务接口。',refs:[['MySQL：执行计划分析基础','https://dev.mysql.com/doc/refman/8.4/en/explain-output.html'],['本地延伸：Snowflake','基于Redis的snowflake%20id优化.md'],['本地延伸：MySQL 索引','MySQL索引详解/MySQL索引详解.md']]},
{
file:'轻量级鉴权框架Sa-Token.md',scope:'Sa-Token 的登录和权限模型，MVC 示例需选择与 Spring Boot 3 匹配的 Starter 并锁定版本',
replace:[['@Configuration\npublic class SaTokenConfigure {\n    @Bean\n    public SaInterceptor saInterceptor() {\n        return new SaInterceptor(handler -> SaRouter.match("/**")\n            .notMatch("/login", "/public/**", "/error")\n            .check(r -> StpUtil.checkLogin()));\n    }\n}','@Configuration\npublic class SaTokenConfigure implements WebMvcConfigurer {\n    @Override\n    public void addInterceptors(InterceptorRegistry registry) {\n        registry.addInterceptor(new SaInterceptor(handler -> SaRouter.match("/**")\n            .notMatch("/login", "/public/**", "/error")\n            .check(r -> StpUtil.checkLogin()))).addPathPatterns("/**");\n    }\n}']],
body:`## 认证、操作权限与数据范围分三次判断

用户能登录，只证明系统接受了其身份；拥有 order:cancel，只证明角色允许取消订单；能否取消订单 100，还需要检查订单属于当前租户、当前用户的数据范围、状态是否允许取消。把第三层省略，是很多“按钮权限齐全却仍然越权”的根因。

Sa-Token 的登录、会话、权限和多框架集成能力可从[官方项目](https://github.com/dromara/Sa-Token)核对。Spring Boot 3 应选择匹配 Jakarta 环境的集成模块，不能把 README 中针对另一 Boot 代际的依赖无条件复制。本文不固定一个未经实际项目回归的版本号，工程需要锁定 BOM 和实际解析依赖。

## 登录成功之前的业务责任

登录入口首先限制请求大小和尝试频率，再查询账户并验证密码哈希，检查账户禁用、风险状态和必要的多因素认证。只有这些检查通过才调用 StpUtil.login。密码哈希应使用带盐、可调工作因子的专用算法，参数由安全基线和实际延迟预算确定，不要用一次 SHA-256 或 MD5 代替密码存储设计。

登录错误对外可以统一提示账号或密码不正确，内部审计则区分失败原因。既要避免暴露账户存在性，也要避免攻击者通过锁定策略批量把别人的账户锁死。限流维度可以结合账户、来源和设备风险，不能只依赖 IP，因为企业 NAT 会让许多正常用户共享地址。

~~~java
// 业务接口伪代码：PasswordVerifier、RiskService 由项目实现。
public LoginResult login(LoginCommand command) {
    loginRateLimiter.check(command.account());
    Account account=accountRepository.findByLoginName(command.account());
    if (account==null || !passwordVerifier.matches(command.password(),account.hash())) {
        audit.loginFailed(command.account());
        throw new BusinessFailure("LOGIN_REJECTED");
    }
    if (!account.enabled()) throw new BusinessFailure("LOGIN_REJECTED");
    riskService.verifyRequiredFactors(account,command);
    StpUtil.login(account.id());
    audit.loginSucceeded(account.id());
    return new LoginResult(StpUtil.getTokenValue());
}
~~~

返回 Token 的传输方式取决于客户端模型。浏览器 Cookie 需要 Secure、HttpOnly、SameSite 与 CSRF 策略，显式 Header 方式需要认真处理 XSS 与脚本可读存储。HttpOnly 能降低脚本直接读取凭证的机会，但不会让页面中的所有请求免于 CSRF；localStorage 使用方便，也不会自动提供抵御 XSS 的隔离。

## MVC 拦截器必须真正注册

一个 SaInterceptor 被声明成普通 Bean，不代表它必然被 MVC HandlerMapping 自动应用。前文采用 WebMvcConfigurer.addInterceptors 显式注册。WebFlux 与网关有不同集成入口，不能照搬 MVC 配置。公共路径白名单应精确到必要接口，并检查路径匹配和编码行为，避免用过宽的 public/** 覆盖了后来新增的管理接口。

注解鉴权同样需要实际拦截器或代理生效。测试应直接请求接口，而不是只反射检查方法上有没有注解。服务内部调用和定时任务还要决定是否需要领域级权限入口，不能认为所有调用都会经过 Web 层。

## 给框架提供权限数据

Sa-Token 的权限判断需要业务提供用户的角色与权限集合。下面是 StpInterface 的典型形态，Repository 是项目业务依赖。返回集合来自可信数据库或受控缓存，不能直接接受客户端提交的 permissions 数组。

~~~java
@Component
public class DatabasePermissionProvider implements StpInterface {
    private final PermissionRepository repository;
    public DatabasePermissionProvider(PermissionRepository repository) {
        this.repository=repository;
    }
    @Override
    public List<String> getPermissionList(Object loginId,String loginType) {
        return repository.findPermissions(loginType,String.valueOf(loginId));
    }
    @Override
    public List<String> getRoleList(Object loginId,String loginType) {
        return repository.findRoles(loginType,String.valueOf(loginId));
    }
}
~~~

loginType 应参与多账号体系隔离，管理员与普通用户相同数字 ID 不应误共享权限。权限缓存的 key 还要考虑租户和权限版本。用户切换当前机构时，不能继续使用上一个机构的数据范围，也不能默认选第一个绑定机构。身份、当前租户选择与允许访问集合应该分别保存和校验。

## 订单取消的完整边界

示例 SQL 把 tenant_id 和状态条件放到更新里，避免读取校验后状态发生变化。用户身份从服务端会话获得，不能从请求 body 的 userId 直接采用。若订单不属于访问范围，可以按统一规则返回不存在或禁止访问，不暴露额外资源信息。

~~~java
@Transactional
public void cancelOrder(String orderId) {
    StpUtil.checkLogin();
    StpUtil.checkPermission("order:cancel");
    String userId=String.valueOf(StpUtil.getLoginId());
    String tenantId=currentTenant.requireAuthorizedTenant(userId);
    Order order=orderRepository.findAuthorized(tenantId,userId,orderId);
    if (order==null) throw new BusinessFailure("ORDER_NOT_ACCESSIBLE");
    int changed=orderRepository.cancelIfPending(tenantId,orderId,order.version());
    if (changed!=1) throw new BusinessFailure("ORDER_STATE_CONFLICT");
    audit.recordOrderCancellation(tenantId,userId,orderId);
}
~~~

~~~sql
UPDATE orders
SET status='CANCELLED', version=version+1
WHERE tenant_id=? AND id=? AND status='PENDING' AND version=?;
~~~

这里只演示单库状态变化。若取消还要释放远程库存和退钱，应通过可靠事件或一致性方案执行，权限框架不会替代业务事务。审计记录若要求与业务一起提交，应写入同事务表或 Outbox；只打一条日志可能因采集失败无法形成完整审计证据。

## 会话存储与强制失效

多实例部署通常需要共享会话状态，登录请求落在 A、后续请求落在 B 时应仍能识别。Redis 不可达时应按业务风险明确拒绝或受限降级，不能因为鉴权存储故障就默认放行。Token 续期要考虑最大生命周期，避免被窃取凭证无限活跃。

修改密码、禁用账号、撤销角色和踢人下线是不同操作。失效范围可能是一个设备、一个 Token、一个账号或某个租户上下文，需要明确审计。权限缓存还未失效时，注销 Token 与撤销权限不一定同时生效；高风险操作可使用短缓存、权限版本或更强的在线校验。

## 网关身份透传的信任链

网关可以清理客户端伪造的内部身份 Header，再写入经过验证的身份上下文；下游还需要通过网络隔离、签名或 mTLS 等方式确认请求来自可信调用方。仅仅把 userId 放进 Header 并命名为 X-Internal-User，不会使它可信。服务之间也应限制受众和权限，不能把用户 Token 当作所有下游服务的万能凭证。

服务账户与用户身份应同时保留：哪个服务代表哪个用户执行了什么操作。异步消息可能脱离用户会话，需要在事件创建时完成授权并限制后续动作，或者在执行时重新验证，两者对应不同业务契约。不要把一个永久管理员 Token 放进所有消费者配置。

## 权限变更也需要发布测试

权限点改名会影响数据库角色绑定、前端按钮和后端注解；新增接口若忘记保护，默认策略应该帮助暴露问题。建立接口清单并测试未登录、权限不足、跨租户、对象不归属和状态冲突，远比只测登录成功更能发现漏洞。

日志不要打印完整 Token。审计可以保存用户、会话摘要、设备标识、操作资源、结果和时间，并限制查看权限。账号删除、注销和数据保留要求应与审计政策协调。权限系统的正确性既依赖框架 API，也依赖这些长期治理规则。`,
lab:'以两个租户、两个普通用户和一个受限管理员建立测试数据。每个接口都验证身份、操作权限和对象归属三个层次，避免所有测试只用超级管理员通过。',
cases:[
['AUTH-01','未登录访问','请求不携带有效凭证','调用受保护订单接口','返回统一未登录契约且业务方法不执行','入口鉴权需要用真实请求证明已生效'],
['AUTH-02','错误密码','账户存在但密码错误','调用登录入口','不创建会话且对外不泄漏账户细节','调用 login 之前的凭证校验属于业务责任'],
['AUTH-03','缺少权限点','用户已登录但没有 order:cancel','请求取消本人订单','操作被拒绝且订单状态不变','登录成功不等价于拥有全部业务操作权限'],
['AUTH-04','跨用户资源','用户有取消权限但订单属于别人','替换路径中的订单 ID','数据范围校验拒绝','按钮级权限不能代替资源归属判断'],
['AUTH-05','跨租户伪造','客户端能修改 tenantId 参数','提交未绑定租户的订单操作','服务端按可信上下文拒绝','租户选择必须在允许集合内而非直接信任输入'],
['AUTH-06','状态竞争','订单初始允许取消但并发进入已发货','执行带版本和状态条件更新','只有合法状态转换成功，冲突明确返回','授权通过不保证资源状态在提交时仍可修改'],
['AUTH-07','多实例会话','登录请求由节点 A 处理','后续请求固定访问节点 B','会话识别一致','共享部署需要统一会话存储和序列化策略'],
['AUTH-08','权限撤销','用户权限被管理员移除','在约定缓存窗口后再次操作','撤销按承诺时间生效并留审计','权限缓存需要明确失效与最大滞后预算'],
['AUTH-09','主动下线','账号有多个设备会话','按策略踢出一个设备或全部设备','失效范围与操作契约一致','Token、设备与账号是不同会话管理层级'],
['AUTH-10','存储故障','共享鉴权存储不可达','访问高风险操作','按明确策略拒绝或受限处理，不自动放行','依赖错误不能被转换成无条件授权'],
['AUTH-11','伪造身份 Header','客户端构造内部用户字段','分别经过网关和尝试直连下游','不可信字段无法覆盖真实身份','身份透传需要验证来源而不是依赖 Header 名称'],
['AUTH-12','审计与隐私','执行登录、改密和订单取消','检查应用日志与审计表','操作可追踪但完整 Token 和密码不出现','可审计性与秘密保护需要同时满足']
],end:'## 轻量框架需要清楚的业务边界\n\nSa-Token 能减少登录和权限判断的样板代码，但账户安全、数据范围、租户选择、状态约束和审计仍由系统设计承担。把三层校验写进实际服务流程，并用普通用户和跨租户场景验证，才算完整接入。',refs:[['Sa-Token 官方项目','https://github.com/dromara/Sa-Token'],['本地延伸：异常国际化','i18n多语言异常提示.md']]}
];
for(const a of articles)console.log(writeArticle(a));
