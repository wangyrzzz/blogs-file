# Seata 2.0 自定义异常变成 `try to proceed invocation error` 的排查与处理

> 阅读范围：围绕 Seata 2.0 相关异常包装现象建立诊断流程；未获得真实项目依赖树，不指认某个补丁必然修复。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


在部分 Spring Cloud 与 Seata 2.0 的组合中，`@GlobalTransactional` 方法抛出业务自定义异常后，调用方看到的可能不是原始异常，而是：

```text
java.lang.RuntimeException: try to proceed invocation error
    at io.seata.spring.annotation.AdapterInvocationWrapper.proceed(...)
```

这会影响统一异常处理器返回业务提示，也容易让排查者误以为业务代码没有抛出正确异常。处理这类问题时，第一步不是直接改异常类型，而是确认原始异常是否仍存在于 `cause` 链中，以及当前依赖组合是否命中了已知缺陷。

## 最小重现场景

```java
@GlobalTransactional
public void createOrder(CreateOrderCommand command) {
    if (!stockService.hasEnough(command.sku(), command.quantity())) {
        throw new BusinessException("stock.insufficient");
    }
    orderRepository.create(command);
}
```

如果回滚成功，但上层只能收到包装后的 RuntimeException，应保留完整堆栈，特别是 `getCause()` 和异常链，不要只打印 `getMessage()`。

## 为什么会丢失业务提示

Seata 会通过拦截器包装全局事务方法，在目标方法抛出异常后执行回滚和事务完成逻辑。某些版本的调用适配层在重新抛出异常时使用了通用的 `RuntimeException` 文本，导致外层看到的是包装异常。

因此要区分两种情况：

1. 原始 `BusinessException` 还在 `cause` 中，只是统一异常处理器没有解包；
2. 适配层确实丢失了原始异常，只剩通用包装异常。

可以先用以下方式遍历异常链：

```java
Throwable current = exception;
while (current != null) {
    log.error("type={}, message={}",
            current.getClass().getName(), current.getMessage());
    current = current.getCause();
}
```

## 排查步骤

### 1. 确认版本矩阵

记录 Spring Boot、Spring Cloud、Spring Cloud Alibaba、Seata 客户端和 Server 的完整版本。不要只写“用了 Seata 2.0”，因为 Spring 代理、JDK、事务模式和依赖传递都会影响实际行为。

### 2. 确认异常发生位置

让业务方法在事务入口内直接抛出一个确定的自定义异常，再逐层观察：业务方法、Seata 拦截器、Controller 全局异常处理器。若不经过 Seata 时异常正常，经过 `@GlobalTransactional` 后才被包装，问题范围就集中在事务拦截链。

### 3. 检查统一异常处理器

处理器应识别顶层业务异常以及经过白名单包装的业务异常；未知包装仍返回系统错误，不能仅凭 cause 深处出现业务类型就无条件解包。解包逻辑要有深度上限，避免异常链异常造成循环或过度遍历。

### 4. 检查回滚结果

异常提示恢复并不代表分布式事务一定正确。需要同时查看 Seata Server 日志、分支事务状态、数据库回滚结果和重试记录，确认“提示正确”和“数据回滚成功”分别成立。

## 处理策略

### 优先升级到包含修复的兼容版本

先查当前 Seata 版本的发布说明和相关 Issue，确认是否已经有针对异常包装的修复，并用完整版本组合做回归。升级时客户端和 Server 的兼容性、代理模式、事务表结构和回滚日志都要验证。

### 暂时解包 Cause

如果原始业务异常仍然存在，可以在统一异常处理层提取业务异常并返回稳定错误码：

```java
@ExceptionHandler(Exception.class)
public ResponseEntity<ApiError> handle(Throwable ex) {
    BusinessFailure business = KnownWrapperResolver.resolve(ex).orElse(null);
    if (business != null) {
        return ResponseEntity.badRequest()
                .body(new ApiError(business.code()));
    }
    log.error("unexpected error", ex);
    return ResponseEntity.internalServerError()
            .body(new ApiError("system.error"));
}
```

这里使用后文的白名单解析器，业务异常类型和访问方法按项目定义对应。这只是展示层补救，不能修复拦截器已经丢失原始异常的情况，也不能把任意底层异常伪装成业务异常。

### 评估版本回退

如果升级暂时不可行，可以在隔离环境验证兼容的旧版本。回退前要确认 Spring Cloud 依赖、事务模式、数据库表结构和客户端协议都支持，不能只把一个 Seata 依赖改成旧版本。旧版本可能包含其他安全或稳定性问题，应设置明确的升级计划。

## 不要这样处理

- 统一把所有 `RuntimeException` 的消息改成业务提示；
- 丢弃完整 cause 和回滚日志；
- 为了保留异常文本而关闭全局事务；
- 只验证接口返回，不验证分支事务是否真的回滚；
- 直接复制网上针对另一套版本的拦截器源码。


## 先限制结论，再定位问题

公开的[Seata Issue 6488](https://github.com/apache/incubator-seata/issues/6488)记录过同样的异常文本，讨论场景甚至涉及未显式添加全局事务注解的方法。这能证明该现象值得沿代理链调查，却不能证明所有相同文本都有同一原因，更不能仅根据 Issue 已关闭断言自己的依赖组合已修复。

我们需要把现象分成四个独立问题：业务最初抛出了什么；哪个适配层增加了包装；原始对象是否仍在 cause 或 suppressed 中；全局事务最终处于什么状态。接口提示变成通用错误，只是最上层观察。数据回滚失败、异常信息被覆盖和统一处理器分类错误，可以分别存在，也可能同时发生。

## 最小复现矩阵怎样设计

固定一个最小业务异常，分别在没有代理、只有 Spring 本地事务、只有全局事务、叠加 RPC、叠加统一处理器时抛出。每次只增加一个层次。若直接在复杂订单流程里修改多个依赖，很难确认哪一步真正改变了异常形态。

| 维度 | 必须记录的内容 | 为什么影响结论 |
| --- | --- | --- |
| JDK | 完整 vendor 与版本 | 反射、代理与字节码环境 |
| Boot/Framework | 实际解析版本 | 方法拦截与异常包装 |
| Cloud/Alibaba | BOM 与传递依赖 | Client 版本可能被覆盖 |
| Seata Client/Server | 分别记录 | 协议与事务能力不等同 |
| 事务模式 | AT、TCC、Saga 等 | 回滚机制不同 |
| 调用路径 | 本地、Feign、Dubbo | 远程边界改变异常契约 |
| 数据源 | 是否代理、实际连接 | 本地分支是否真正注册 |

构建文件写的版本不是最终运行版本。使用依赖树检查重复 Seata 模块，查看可执行 Jar 内实际库文件，必要时打印 AdapterInvocationWrapper 等实际类的加载来源。命令中的过滤坐标要按项目 groupId 调整，不要把某一时期的包名前缀当成所有版本通用规则。

~~~bash
./mvnw dependency:tree -Dverbose > dependency-tree.txt
./mvnw help:effective-pom > effective-pom.xml
jar tf application.jar > application-entries.txt
~~~

PowerShell 下执行 Maven 参数时应按实际 shell 引用规则加引号。输出文件可能包含私有仓库地址和内部坐标，提交到公开 Issue 前应脱敏，但不要删掉诊断所需的完整版本与调用顺序。

## 观察异常链而不是只打印 message

常见包装包括 InvocationTargetException、CompletionException、ExecutionException 和框架适配异常。getMessage 只代表当前层文本，不能说明原始业务异常消失。cause 链有可能循环或非常深，诊断代码需要按对象身份防环，并设置深度限制。

~~~java
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;

public final class FailureChain {
    public static void inspect(Throwable failure,
            java.util.function.Consumer<String> output) {
        Set<Throwable> seen=Collections.newSetFromMap(new IdentityHashMap<>());
        Throwable current=failure;
        int depth=0;
        while (current!=null && depth<16 && seen.add(current)) {
            output.accept("depth="+depth
                    +", type="+current.getClass().getName()
                    +", suppressed="+current.getSuppressed().length);
            current=current.getCause();
            depth++;
        }
        if (current!=null) output.accept("chain truncated or cyclic");
    }
}
~~~

上面只输出类型和结构，适合不暴露异常内容的诊断摘要；服务端仍应在受控日志中记录完整堆栈。suppressed 可能包含清理阶段或回滚阶段失败，它们不一定是主 cause。不能因为最深层文本看起来像业务提示，就丢弃上层的全局回滚失败信息。

## 安全解包应该是明确映射

统一处理器可以穿过已确认的传输包装，但不能无条件遍历任意异常直到找到 BusinessException。举例来说，上层代表事务系统状态不确定，底层恰好有库存不足异常，此时只向用户返回“库存不足”会掩盖需要人工恢复的数据风险。

下面示例仅允许标准反射与 Future 包装。对于 Seata 适配包装，需要根据已经确认的精确类和版本增加规则；不要通过 message 等于某个英文字符串来授权解包。

~~~java
import java.lang.reflect.InvocationTargetException;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;

public final class KnownWrapperResolver {
    public static Optional<BusinessFailure> resolve(Throwable original) {
        Set<Throwable> seen=Collections.newSetFromMap(new IdentityHashMap<>());
        Throwable current=original;
        for (int depth=0; current!=null && depth<8 && seen.add(current); depth++) {
            if (current instanceof BusinessFailure business) {
                return Optional.of(business);
            }
            if (!isAllowedWrapper(current)) return Optional.empty();
            current=current.getCause();
        }
        return Optional.empty();
    }
    private static boolean isAllowedWrapper(Throwable value) {
        return value instanceof InvocationTargetException
            || value instanceof CompletionException
            || value instanceof ExecutionException;
    }
}
~~~

BusinessFailure 是项目定义的业务异常。这份解析器故意不宣称已经修复 Seata：若实际顶层只是通用 RuntimeException，仍需检查它由谁创建、是否可安全映射。直接放行所有 RuntimeException 等于失去白名单。更根本的处理是修复适配层或采用已验证兼容版本，使异常契约在边界保持清楚。

## 回滚验证要建立数据证据

AT 模式下，可以设计订单表与库存表两个分支：订单创建成功、库存扣减后故意抛异常，再验证两边业务状态恢复。记录 XID、分支 ID、异常时间、TC 决议和重试轨迹。undo_log 是诊断线索，但“表里有记录”或“表里没有记录”都不能独立证明成功，因为它涉及本地事务提交与后续清理时机。

TCC 需要检查 Try 预留、Confirm/Cancel 幂等与空回滚；Saga 则需要检查补偿执行与不可补偿副作用。不要拿 AT 的 undo_log 检查清单去证明所有事务模式正确。业务返回失败后，系统可能仍在异步重试回滚，验收应等待明确终态或记录超时进入人工处理，而不是只在返回后立即查询一次。

~~~text
测试案例 transaction-wrapper-01
  initial: order absent, stock available=10
  action: create order, reserve 2, throw known business failure
  observe:
    requestId and XID are recorded
    original exception type is preserved or explicitly mapped
    global transaction reaches a known rollback outcome
    order does not remain as a successful order
    stock returns to the domain-defined pre-transaction state
    retrying the same request does not create duplicate side effects
  evidence:
    sanitized stack trace
    exact dependency tree
    branch logs and database snapshots
~~~

这是验收格式而不是实测报告。真实业务若采用“订单保留但状态置为失败”的模型，就应修改数据预期，不能机械要求所有行都消失。验证对象始终是领域不变量，而非某张表恰好为空。

## 升级、回退和补丁的决策

升级前保存最小复现与完整依赖锁定结果，阅读对应版本发布说明和变更代码，再验证 Client、Server、Spring 与数据源代理组合。不要仅改一个 jar 版本，留下其他模块继续使用旧版本。回退同样需要检查表结构、协议兼容和已经产生的未完成事务。

临时展示层补救应记录适用版本、解包类型、撤销条件和监控指标。若以后框架已经恢复原始异常，补救逻辑不应继续广泛捕获并改变新异常。不要为保留错误文本关闭全局事务，也不要吞掉异常后正常返回以绕开包装；这样可能让事务走向提交。

长期看，跨服务错误适合稳定错误码与明确结果模型，而不是序列化整个 Java 异常对象。调用者需要区分业务拒绝、依赖不可达和结果不确定。只有把这三类状态分开，重试策略才不会因为一个模糊的英文包装消息而做出错误决定。

## 统一处理器的选择也会改变最终现象

同一个包装异常在两个服务里得到不同响应，不一定是 Seata 使用了不同逻辑，也可能是 MVC 异常解析器选择不同。Spring 可以匹配顶层异常，也可以匹配 cause 中的异常；在同一个 Advice 内，顶层匹配通常优先，但多个 Advice 之间还受优先级影响。高优先级 Advice 的 cause 匹配可以先于低优先级 Advice 的顶层匹配，因此不能只阅读某一个 `@ExceptionHandler` 就判断实际响应。[Spring Framework 异常映射说明](https://docs.spring.io/spring-framework/reference/6.2/web/webmvc/mvc-controller/ann-exceptionhandler.html)

定位时可以给处理器增加不包含敏感信息的诊断字段，例如处理器名称、入口异常类型和最终错误码。用同一条已保存的异常结构分别覆盖业务 Advice、框架通用 Advice 和兜底处理器，确认是谁最终写出了响应。若团队要求仅允许白名单解包，就要检查较高优先级的业务类型处理器是否已经直接命中 cause，从而绕过统一分类规则；这需要调整处理器组织方式，而不是继续加一个永远没有执行机会的工具方法。

还要把同步代理调用与异步任务完成区分开。事务方法提交一个线程池任务后正常返回，任务稍后再抛业务异常，这个异常并不是原同步调用栈中尚未处理的失败。不能期待展示层识别该异常后，已经结束的事务就自动倒退回滚。若要求任务结果参与同一业务决议，应设计明确的等待与超时边界，或者使用独立任务状态和补偿流程；仅复制 XID 到另一个线程也不能替代完整的事务生命周期设计。

一个有区分力的实验是先让业务方法同步抛出固定错误，再改成提交后延迟失败，并分别记录代理返回时间、任务失败时间和全局事务终态。若前者包装、后者只在工作线程日志出现，说明两种故障来自不同边界，不能归并成同一个“异常丢失”缺陷。对外响应也应随真实结果建模：已明确拒绝的请求可返回业务错误，已接受的异步任务应返回任务标识，结果未知则提供查询或恢复路径。

## 故障注入与验收实验

这里没有真实应用依赖树，因此实验关注定位路径而非声称已发现唯一根因。每个用例同时验证异常形态、接口契约和事务数据，缺少任意一类证据都不能宣布完整修复。

### SEATA-01：无代理基线

实验前提是同一个方法直接抛已知业务异常。执行绕开事务和 RPC 代理调用。

通过条件是记录最原始异常类型与业务码。这里的判断依据是没有基线就无法确认包装在哪一层发生。

### SEATA-02：本地事务对照

实验前提是保持业务方法不变只增加本地事务。执行再次调用并观察堆栈。

通过条件是区分 Spring 代理行为与全局事务行为。这里的判断依据是逐层增加机制才能缩小责任范围。

### SEATA-03：全局事务包装

实验前提是固定 Client 与 Server 版本。执行增加全局事务后抛相同异常。

通过条件是记录新增包装层及原异常是否保留。这里的判断依据是同样的显示文本不能取代完整 cause 链证据。

### SEATA-04：未注解方法

实验前提是Bean 因其他方法或配置受到代理。执行从未标注全局事务的方法抛异常。

通过条件是确认该方法实际经过哪些拦截器。这里的判断依据是代理作用范围不能只看当前方法上的一个注解。

### SEATA-05：原始原因丢失

实验前提是适配层只创建新通用异常而不保留 cause。执行展示层解析。

通过条件是明确判定无法从已丢失对象恢复业务信息。这里的判断依据是消息映射不能重建框架没有保存的原始异常。

### SEATA-06：白名单外包装

实验前提是未知运行时异常内部包住业务异常。执行调用安全解包器。

通过条件是保留系统错误分类并记录根因。这里的判断依据是任意 cause 中有业务类型不代表顶层失败可被安全忽略。

### SEATA-07：循环链保护

实验前提是人工构造异常环或较深链条。执行诊断遍历。

通过条件是在深度上限或重复对象处终止。这里的判断依据是诊断工具本身也需要可控资源和终止条件。

### SEATA-08：AT 数据回滚

实验前提是订单和库存分支已产生受控修改。执行抛异常后观察 TC 与最终业务表。

通过条件是事务达到明确终态且领域数据恢复。这里的判断依据是接口提示恢复与真实回滚成功是独立验收项。

### SEATA-09：回滚过程失败

实验前提是注入分支回滚暂时不可达。执行记录主异常与 suppressed 或附加事务错误。

通过条件是系统保留恢复状态而非仅返回普通业务拒绝。这里的判断依据是回滚失败可能比最初业务异常更影响后续处理。

### SEATA-10：远程边界

实验前提是业务异常通过 RPC 或 HTTP 返回。执行比较服务端 cause 与客户端收到的契约。

通过条件是明确哪些信息跨边界保留，哪些仅留服务端日志。这里的判断依据是远程调用不是原始 Java 异常对象的无损传递保证。

### SEATA-11：版本替换

实验前提是有一份可重复失败的依赖锁定组合。执行只按兼容计划升级并重跑相同场景。

通过条件是异常和事务同时符合预期，保留前后依赖证据。这里的判断依据是Issue 关闭或版本号变大不等价于当前环境已修复。

### SEATA-12：重复请求

实验前提是第一次失败后客户端不知道最终结果。执行使用同一业务请求 ID 再次调用。

通过条件是没有重复订单或不可逆副作用。这里的判断依据是异常包装修复不能代替请求幂等设计。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "Seata 2.0自定义异常变try to proceed invocation error问题",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "SEATA-01",
      "scenario": "无代理基线",
      "given": "同一个方法直接抛已知业务异常",
      "when": "绕开事务和 RPC 代理调用",
      "then": "记录最原始异常类型与业务码"
    },
    {
      "id": "SEATA-02",
      "scenario": "本地事务对照",
      "given": "保持业务方法不变只增加本地事务",
      "when": "再次调用并观察堆栈",
      "then": "区分 Spring 代理行为与全局事务行为"
    },
    {
      "id": "SEATA-03",
      "scenario": "全局事务包装",
      "given": "固定 Client 与 Server 版本",
      "when": "增加全局事务后抛相同异常",
      "then": "记录新增包装层及原异常是否保留"
    },
    {
      "id": "SEATA-04",
      "scenario": "未注解方法",
      "given": "Bean 因其他方法或配置受到代理",
      "when": "从未标注全局事务的方法抛异常",
      "then": "确认该方法实际经过哪些拦截器"
    },
    {
      "id": "SEATA-05",
      "scenario": "原始原因丢失",
      "given": "适配层只创建新通用异常而不保留 cause",
      "when": "执行展示层解析",
      "then": "明确判定无法从已丢失对象恢复业务信息"
    },
    {
      "id": "SEATA-06",
      "scenario": "白名单外包装",
      "given": "未知运行时异常内部包住业务异常",
      "when": "调用安全解包器",
      "then": "保留系统错误分类并记录根因"
    },
    {
      "id": "SEATA-07",
      "scenario": "循环链保护",
      "given": "人工构造异常环或较深链条",
      "when": "执行诊断遍历",
      "then": "在深度上限或重复对象处终止"
    },
    {
      "id": "SEATA-08",
      "scenario": "AT 数据回滚",
      "given": "订单和库存分支已产生受控修改",
      "when": "抛异常后观察 TC 与最终业务表",
      "then": "事务达到明确终态且领域数据恢复"
    },
    {
      "id": "SEATA-09",
      "scenario": "回滚过程失败",
      "given": "注入分支回滚暂时不可达",
      "when": "记录主异常与 suppressed 或附加事务错误",
      "then": "系统保留恢复状态而非仅返回普通业务拒绝"
    },
    {
      "id": "SEATA-10",
      "scenario": "远程边界",
      "given": "业务异常通过 RPC 或 HTTP 返回",
      "when": "比较服务端 cause 与客户端收到的契约",
      "then": "明确哪些信息跨边界保留，哪些仅留服务端日志"
    },
    {
      "id": "SEATA-11",
      "scenario": "版本替换",
      "given": "有一份可重复失败的依赖锁定组合",
      "when": "只按兼容计划升级并重跑相同场景",
      "then": "异常和事务同时符合预期，保留前后依赖证据"
    },
    {
      "id": "SEATA-12",
      "scenario": "重复请求",
      "given": "第一次失败后客户端不知道最终结果",
      "when": "使用同一业务请求 ID 再次调用",
      "then": "没有重复订单或不可逆副作用"
    }
  ]
}
```

## 真正完成修复的标准

原始错误能够被正确分类，客户端得到稳定契约，事务状态和业务数据都符合预期，并且升级或回退有复现证据。只把 try to proceed invocation error 换成一条友好文案，最多完成了展示层的一部分工作。

## 参考资料与继续阅读

- [Seata 官方仓库 Issue 6488](https://github.com/apache/incubator-seata/issues/6488)
- [本地延伸：异常国际化](i18n多语言异常提示.md)
- [本地延伸：Spring 事务](Spring%20事务/Spring%20事务.md)
