# 轻量级鉴权框架 Sa-Token 入门与实践

> 阅读范围：Sa-Token 的登录和权限模型，MVC 示例需选择与 Spring Boot 3 匹配的 Starter 并锁定版本。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


Sa-Token 主要解决登录认证、会话管理、权限校验和踢人下线等常见问题。它可以作为 Spring Boot 应用中的鉴权组件使用，也可以在网关、微服务和前后端分离项目中承担不同职责。

## 认证和授权不是一回事

认证回答“你是谁”，例如校验账号密码并创建登录会话；授权回答“你能做什么”，例如判断用户是否拥有 `order:read` 权限或属于 `admin` 角色。工程上应先完成认证，再在接口或服务方法处执行授权检查。

## 基本登录流程

依赖版本应以项目的 Spring Boot 版本和 Sa-Token 官方兼容矩阵为准。核心业务流程通常如下：

```java
// 登录成功后创建会话
StpUtil.login(user.getId());

// 获取当前登录用户
Object loginId = StpUtil.getLoginIdDefaultNull();

// 退出当前会话
StpUtil.logout();
```

密码校验、验证码、账户锁定和风控判断应由业务层完成，不能把“调用 `login`”误认为已经完成了完整的登录安全流程。密码必须使用强哈希算法存储，不能保存明文或可逆密文。

## 接口鉴权

可以对需要登录的路径配置路由拦截器，对公共路径显式放行：

```java
@Configuration
public class SaTokenConfigure implements WebMvcConfigurer {
    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        registry.addInterceptor(new SaInterceptor(handler -> SaRouter.match("/**")
            .notMatch("/login", "/public/**", "/error")
            .check(r -> StpUtil.checkLogin()))).addPathPatterns("/**");
    }
}
```

不同版本的拦截器注册方式可能略有差异，实际项目应以依赖版本的 API 为准。公共接口列表应集中维护，避免在多个 Controller 中散落判断。

## 角色和权限

角色适合表达粗粒度身份，例如 `admin`、`operator`；权限适合表达具体操作，例如 `user:add`、`order:cancel`。在服务方法中执行权限判断：

```java
StpUtil.checkPermission("order:cancel");
StpUtil.checkRole("admin");
```

权限数据建议由统一的权限服务或数据库维护，并考虑缓存失效策略。高风险操作不能只依赖前端按钮隐藏，后端必须再次校验资源归属、租户边界和操作权限。

## Token、Session 与并发登录

Token 是客户端携带的会话凭证，Session 保存服务端的登录状态。生产环境通常需要配置 Redis 作为共享存储，使多个实例可以识别同一登录状态。Token 的保存位置应结合风险选择：浏览器应用要重点防范 XSS、CSRF 和泄露，不能为了方便把长期 Token 暴露在不安全的页面环境中。

对于同一账号的并发登录，可以按需求选择允许多地登录、限制登录数量、顶掉旧会话或禁止重复登录。踢人下线、Token 续期和强制注销都应设计审计日志。

## 微服务中的边界

网关可以完成 Token 解析、基础登录校验和用户上下文传递，但下游服务不能无条件相信客户端自行传入的用户 ID。推荐由网关签发或透传经过验证的身份信息，下游服务仍对本服务的资源权限进行最终判断。

服务间调用可使用内部凭证或 mTLS，不应把用户 Token 当成所有服务的万能通行证。跨服务传递的身份字段要防止被覆盖，并限制可访问的租户和数据范围。

## 异常与安全实践

- 登录失败统一返回模糊提示，避免暴露“用户不存在”还是“密码错误”；
- Token 设置有效期和续期上限，注销后及时失效；
- 对登录、改密、踢人、权限变更记录审计日志；
- 对敏感接口增加限流、验证码或二次认证；
- 未登录与无权限应使用统一错误码，前端不要依赖异常文本判断逻辑。


## 认证、操作权限与数据范围分三次判断

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

日志不要打印完整 Token。审计可以保存用户、会话摘要、设备标识、操作资源、结果和时间，并限制查看权限。账号删除、注销和数据保留要求应与审计政策协调。权限系统的正确性既依赖框架 API，也依赖这些长期治理规则。

## 将授权条件下沉到查询，而不是查完再过滤

分页查询如果先从数据库取二十条，再在 Java 中去掉无权限记录，会出现每页数量不足、总数泄漏和翻页遗漏。更合适的方式是在查询时就加入可信租户与数据范围条件，让列表、总数、导出和详情使用一致规则。权限表达式要参数化，不能把用户输入的部门列表直接拼成 SQL。

~~~sql
SELECT id, status, amount_cents, created_at
FROM orders
WHERE tenant_id = ?
  AND owner_user_id = ?
  AND (created_at < ? OR (created_at = ? AND id < ?))
ORDER BY created_at DESC, id DESC
LIMIT ?;
~~~

游标必须同时携带上一页最后一条记录的 created_at 和 id，两个时间占位符绑定同一值。首屏不带游标条件，后续页面按这两个排序字段共同限定范围；只比较时间会跳过与页末记录创建时间相同、但 ID 更小的订单。业务还应约定翻页期间数据新增或修改的可见性，游标分页本身不提供跨请求快照。

上面只展示本人数据范围；部门共享、上下级组织和委托权限需要独立建模。超级管理员绕过条件的入口尤其要集中，避免某个字符串角色名称被客户端伪造后触发全量访问。导出任务即使异步执行，也必须保存经过验证的范围，或在执行时重新评估授权，不能只保存一个用户 ID 就默认拥有永久导出权。

权限缓存可以使用 permissionVersion 让撤销更容易收敛，但版本变更必须可靠传播，旧会话如何感知新版本要有明确机制。涉及转账、修改安全设置等敏感动作，可以要求近期认证或额外确认；这与普通登录过期不同，不能只要 Token 还有效就允许全部高风险操作。

审计记录应包含“谁以什么身份对哪个资源做了什么、结果怎样”，同时保留必要的策略版本。这样权限规则调整后，仍能解释历史操作当时为什么被允许。审计不应只写“权限校验成功”，因为缺少对象和租户信息的成功日志很难在事故中发挥作用。

## Account-Session、Token-Session 与多标签页机构切换

Sa-Token 区分账号层面的 Account-Session 和令牌层面的 Token-Session，业务数据放在哪一层，会直接影响共享范围。账号共享的昵称缓存与本次登录设备的临时状态，并不是同一种数据。相应入口可在[官方 StpUtil API 文档](https://github.com/dromara/sa-token/blob/dev/sa-token-doc/api/stp-util.md)核对，工程仍应以锁定版本为准。

假设同一用户在电脑与手机同时登录，如果把 currentTenant 放在账号共享会话里，电脑切换机构就可能改变手机下一次请求的默认机构。改放 Token-Session 可以缩小到令牌范围，但同一浏览器多个标签页通常仍共享登录凭证：A 标签页正在编辑机构甲的订单，B 标签页切到机构乙，A 的提交就可能在错误上下文中执行。这个问题即使用户同时拥有两个机构的权限，也仍是严重的业务误操作。

可以让每次请求明确携带页面当前选择的机构，服务端根据登录身份验证该机构属于允许集合，并把验证结果固定到本次请求上下文。这个输入表达用户的操作意图，不承担证明权限的职责。页面提交时还应带上被编辑资源的稳定 ID，后端使用资源所属机构与本次选择交叉校验。上下文发生变化时明确拒绝并要求刷新，比静默改用会话里最新的机构更容易被用户理解。

~~~java
// 业务伪代码：授权服务返回经校验的不可变上下文。
public AuthorizedContext resolveContext(String requestedTenant) {
    StpUtil.checkLogin();
    String loginId = String.valueOf(StpUtil.getLoginId());
    Membership membership = memberships.requireActive(loginId, requestedTenant);
    return new AuthorizedContext(
        loginId, membership.tenantId(), membership.permissionVersion());
}
~~~

后续 Repository 与远程调用使用同一份 AuthorizedContext，不要每到一层又读取一次可能改变的 currentTenant。异步任务也应明确保存任务授权范围，而不是在线程池里重新查找原 HTTP 请求对象。权限缓存以这份上下文中的账号、租户、账号体系和权限版本定位；只按用户 ID 缓存一次权限集合，会把不同机构的授权混在一起。

会话中还应避免保存巨大实体图或长期数据库对象。分布式存储需要序列化与版本兼容，滚动发布时类结构变化可能使另一版本读取失败。优先保存小而明确的标识和必要状态，其他资料由业务服务查询。会话数据格式的变更也要有兼容窗口，不能仅因数据存在 Redis 就假定任何应用版本都能反序列化。

## 注销完成与正在执行的请求是两条时间线

用户点击退出后，系统可以使后续凭证检查失败，但已经通过鉴权、正在执行的请求未必立刻停止。比如管理员撤销权限时，一个批量导出已经进入后台队列；或者账户被禁用时，一笔修改正在数据库提交。权限框架改变登录状态，并不自动回滚所有业务事务，也不会撤销已经发送给外部系统的命令。

首先需要定义撤销承诺。一般资料查询可以接受短时间内完成已授权请求；安全设置、资金操作可能要求在最终写入前再次验证有效授权。重复检查能缩短竞态窗口，却不等于建立了严格原子性：检查通过之后、提交之前仍可能发生撤销。若业务要求撤销与敏感写入严格排序，需要把权限版本、授权记录和业务提交放入可协调的事务或锁协议中，并让所有写入口遵守，而不是简单多调用一次 checkPermission。

对导出任务，可以把创建时的允许范围与策略版本写入任务记录，并在开始执行或提供下载时再次校验。这里要明确选择“创建时授权即允许完成”还是“执行时必须仍有权限”，不同业务可以有不同规则。已经生成的文件也有生命周期，注销 Token 不会自动删除公开对象存储链接；下载入口应执行有效期和访问范围校验，必要时撤销访问能力。

测试应人为暂停在鉴权后、业务提交前，然后撤销权限并恢复请求，观察实际结果是否符合承诺。还要检查注销返回值、共享会话存储变更、权限缓存失效与审计写入各自是否成功。只验证退出后首页跳转到登录页，不能证明后台任务、下载地址与并发中的请求都已经遵守撤销规则。

## 故障注入与验收实验

以两个租户、两个普通用户和一个受限管理员建立测试数据。每个接口都验证身份、操作权限和对象归属三个层次，避免所有测试只用超级管理员通过。

### AUTH-01：未登录访问

实验前提是请求不携带有效凭证。执行调用受保护订单接口。

通过条件是返回统一未登录契约且业务方法不执行。这里的判断依据是入口鉴权需要用真实请求证明已生效。

### AUTH-02：错误密码

实验前提是账户存在但密码错误。执行调用登录入口。

通过条件是不创建会话且对外不泄漏账户细节。这里的判断依据是调用 login 之前的凭证校验属于业务责任。

### AUTH-03：缺少权限点

实验前提是用户已登录但没有 order:cancel。执行请求取消本人订单。

通过条件是操作被拒绝且订单状态不变。这里的判断依据是登录成功不等价于拥有全部业务操作权限。

### AUTH-04：跨用户资源

实验前提是用户有取消权限但订单属于别人。执行替换路径中的订单 ID。

通过条件是数据范围校验拒绝。这里的判断依据是按钮级权限不能代替资源归属判断。

### AUTH-05：跨租户伪造

实验前提是客户端能修改 tenantId 参数。执行提交未绑定租户的订单操作。

通过条件是服务端按可信上下文拒绝。这里的判断依据是租户选择必须在允许集合内而非直接信任输入。

### AUTH-06：状态竞争

实验前提是订单初始允许取消但并发进入已发货。执行带版本和状态条件更新。

通过条件是只有合法状态转换成功，冲突明确返回。这里的判断依据是授权通过不保证资源状态在提交时仍可修改。

### AUTH-07：多实例会话

实验前提是登录请求由节点 A 处理。执行后续请求固定访问节点 B。

通过条件是会话识别一致。这里的判断依据是共享部署需要统一会话存储和序列化策略。

### AUTH-08：权限撤销

实验前提是用户权限被管理员移除。执行在约定缓存窗口后再次操作。

通过条件是撤销按承诺时间生效并留审计。这里的判断依据是权限缓存需要明确失效与最大滞后预算。

### AUTH-09：主动下线

实验前提是账号有多个设备会话。执行按策略踢出一个设备或全部设备。

通过条件是失效范围与操作契约一致。这里的判断依据是Token、设备与账号是不同会话管理层级。

### AUTH-10：存储故障

实验前提是共享鉴权存储不可达。执行访问高风险操作。

通过条件是按明确策略拒绝或受限处理，不自动放行。这里的判断依据是依赖错误不能被转换成无条件授权。

### AUTH-11：伪造身份 Header

实验前提是客户端构造内部用户字段。执行分别经过网关和尝试直连下游。

通过条件是不可信字段无法覆盖真实身份。这里的判断依据是身份透传需要验证来源而不是依赖 Header 名称。

### AUTH-12：审计与隐私

实验前提是执行登录、改密和订单取消。执行检查应用日志与审计表。

通过条件是操作可追踪但完整 Token 和密码不出现。这里的判断依据是可审计性与秘密保护需要同时满足。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "轻量级鉴权框架Sa-Token",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "AUTH-01",
      "scenario": "未登录访问",
      "given": "请求不携带有效凭证",
      "when": "调用受保护订单接口",
      "then": "返回统一未登录契约且业务方法不执行"
    },
    {
      "id": "AUTH-02",
      "scenario": "错误密码",
      "given": "账户存在但密码错误",
      "when": "调用登录入口",
      "then": "不创建会话且对外不泄漏账户细节"
    },
    {
      "id": "AUTH-03",
      "scenario": "缺少权限点",
      "given": "用户已登录但没有 order:cancel",
      "when": "请求取消本人订单",
      "then": "操作被拒绝且订单状态不变"
    },
    {
      "id": "AUTH-04",
      "scenario": "跨用户资源",
      "given": "用户有取消权限但订单属于别人",
      "when": "替换路径中的订单 ID",
      "then": "数据范围校验拒绝"
    },
    {
      "id": "AUTH-05",
      "scenario": "跨租户伪造",
      "given": "客户端能修改 tenantId 参数",
      "when": "提交未绑定租户的订单操作",
      "then": "服务端按可信上下文拒绝"
    },
    {
      "id": "AUTH-06",
      "scenario": "状态竞争",
      "given": "订单初始允许取消但并发进入已发货",
      "when": "执行带版本和状态条件更新",
      "then": "只有合法状态转换成功，冲突明确返回"
    },
    {
      "id": "AUTH-07",
      "scenario": "多实例会话",
      "given": "登录请求由节点 A 处理",
      "when": "后续请求固定访问节点 B",
      "then": "会话识别一致"
    },
    {
      "id": "AUTH-08",
      "scenario": "权限撤销",
      "given": "用户权限被管理员移除",
      "when": "在约定缓存窗口后再次操作",
      "then": "撤销按承诺时间生效并留审计"
    },
    {
      "id": "AUTH-09",
      "scenario": "主动下线",
      "given": "账号有多个设备会话",
      "when": "按策略踢出一个设备或全部设备",
      "then": "失效范围与操作契约一致"
    },
    {
      "id": "AUTH-10",
      "scenario": "存储故障",
      "given": "共享鉴权存储不可达",
      "when": "访问高风险操作",
      "then": "按明确策略拒绝或受限处理，不自动放行"
    },
    {
      "id": "AUTH-11",
      "scenario": "伪造身份 Header",
      "given": "客户端构造内部用户字段",
      "when": "分别经过网关和尝试直连下游",
      "then": "不可信字段无法覆盖真实身份"
    },
    {
      "id": "AUTH-12",
      "scenario": "审计与隐私",
      "given": "执行登录、改密和订单取消",
      "when": "检查应用日志与审计表",
      "then": "操作可追踪但完整 Token 和密码不出现"
    }
  ]
}
```

## 轻量框架需要清楚的业务边界

Sa-Token 能减少登录和权限判断的样板代码，但账户安全、数据范围、租户选择、状态约束和审计仍由系统设计承担。把三层校验写进实际服务流程，并用普通用户和跨租户场景验证，才算完整接入。

## 参考资料与继续阅读

- [Sa-Token 官方项目](https://github.com/dromara/Sa-Token)
- [本地延伸：异常国际化](i18n多语言异常提示.md)
