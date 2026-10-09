# Spring Boot 3 原生日志 TraceId 方案

> 阅读范围：Spring Boot 3 的 Servlet 应用与 SLF4J MDC；自定义日志关联不等于完整分布式追踪。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


如果目标只是把同一 HTTP 请求的日志串起来，不一定要引入完整的链路追踪系统。Spring Boot 3 中可以用 Servlet Filter、SLF4J MDC 和日志格式完成一个轻量方案；如果还需要跨服务拓扑、Span 和采样，再接入 Micrometer Tracing 或 OpenTelemetry。

## 请求入口生成 TraceId

```java
@Component
public class TraceIdFilter extends OncePerRequestFilter {
    private static final String HEADER = "X-Trace-Id";

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain)
            throws ServletException, IOException {
        String incoming = request.getHeader(HEADER);
        String traceId = isSafe(incoming)
                ? incoming
                : UUID.randomUUID().toString().replace("-", "");
        try (MDC.MDCCloseable ignored = MDC.putCloseable("traceId", traceId)) {
            response.setHeader(HEADER, traceId);
            chain.doFilter(request, response);
        }
    }

    private boolean isSafe(String value) {
        return value != null && value.length() <= 64
                && value.matches("[A-Za-z0-9._-]+");
    }
}
```

是否信任上游传入的 TraceId 要结合网络边界。来自公网的值应经过长度和字符校验；在安全网关之后，也不要让它成为权限判断依据。

## 让日志打印 TraceId

Logback 可以把 MDC 字段放进日志：

```xml
<pattern>%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level traceId=%X{traceId} %logger - %msg%n</pattern>
```

推荐使用 JSON 日志，让 `traceId` 作为独立字段输出。日志采集系统据此检索时，不需要解析一整段文本。

## 线程池中的上下文传递

MDC 是线程本地变量，`@Async`、`CompletableFuture` 和自定义线程池不会自动复制它。可以为 Spring 线程池配置 `TaskDecorator`：

```java
@Bean
public TaskDecorator taskDecorator() {
    return task -> {
        Map<String, String> captured = MDC.getCopyOfContextMap();
        return () -> {
            Map<String, String> previous = MDC.getCopyOfContextMap();
            try {
                if (captured == null) MDC.clear();
                else MDC.setContextMap(captured);
                task.run();
            } finally {
                if (previous == null) MDC.clear();
                else MDC.setContextMap(previous);
            }
        };
    };
}
```

必须在任务结束时恢复或清理上下文。否则线程池复用时，后一个请求可能带上前一个请求的 TraceId。

## HTTP 和消息传递

使用 `RestClient`、`WebClient` 或 Feign 调用下游时，应把当前 TraceId 放到 `X-Trace-Id` 请求头；消息队列则把它放进 Header。消费者取出后建立新的 MDC 上下文，并在 finally 中清理。

简单的 TraceId 只能关联日志，不能自动表示父子 Span、跨线程耗时和服务拓扑。对跨服务排障有更高要求时，应使用标准追踪上下文，而不是不断扩展自定义 Header。

## 异常处理与日志规范

全局异常处理器向客户端返回 TraceId，便于用户把问题反馈给运维；日志记录完整堆栈和业务错误码，但不要把密码、Token、身份证号等敏感信息写入日志。

```json
{
  "code": "SYSTEM_ERROR",
  "message": "系统繁忙，请稍后重试",
  "traceId": "f3a4..."
}
```

## 验证方法

可以使用一个请求调用异步任务和下游服务，确认入口日志、线程池日志和下游日志的 TraceId 一致；再并发发送多个请求，确认不同请求之间没有交叉；最后让异常路径提前返回，确认 MDC 已清理。


## 先明确“原生”的含义

本文轻量方案使用应用已有的 Filter、MDC 和日志框架，不代表 Spring Boot 默认替所有请求生成自定义 X-Trace-Id。Micrometer Observation、Micrometer Tracing、追踪桥接器和导出器各有职责。观察一个操作、生成 Span、向后端导出链路是不同层次。Boot 的[Tracing 文档](https://docs.spring.io/spring-boot/reference/actuator/tracing.html)介绍标准追踪集成，具体依赖应按 Boot 3 对应小版本选择，不能直接复制其他大版本的 Starter 名称。

如果系统已经有标准追踪，就让其生成 traceId，日志只读取对应上下文。再加一个生成 UUID 的 Filter，可能造成日志里一套 ID、追踪平台里另一套 ID。只有在明确暂不需要 Span 和拓扑时，自定义关联标识才是一个边界清楚的起点。

## 上下文必须按作用域恢复

前面的 putCloseable 片段适合拥有该 MDC 键的顶层入口，关闭时会移除键，并不替你恢复任何嵌套作用域原有值。若同一线程上有嵌套任务、CallerRunsPolicy 或内部调用，需要保存并恢复旧上下文。可以把这一行为收敛到一个小工具，避免每个入口自己写 try/finally。

~~~java
import java.util.HashMap;
import java.util.Map;
import org.slf4j.MDC;

public final class MdcScope implements AutoCloseable {
    private final Map<String,String> previous;
    private MdcScope(Map<String,String> replacement) {
        previous=MDC.getCopyOfContextMap();
        apply(replacement);
    }
    public static MdcScope replace(Map<String,String> captured) {
        return new MdcScope(captured==null ? null : new HashMap<>(captured));
    }
    public static MdcScope withTrace(String traceId) {
        Map<String,String> current=MDC.getCopyOfContextMap();
        Map<String,String> next=current==null ? new HashMap<>() : new HashMap<>(current);
        next.put("traceId",traceId);
        return new MdcScope(next);
    }
    private static void apply(Map<String,String> values) {
        if (values==null || values.isEmpty()) MDC.clear();
        else MDC.setContextMap(values);
    }
    @Override public void close() { apply(previous); }
}
~~~

作用域应在创建它的线程内关闭。把 MdcScope 对象传给另一个线程再 close，会恢复错误线程的上下文。异步任务传递的是创建时捕获的数据副本，而不是一个可以跨线程操作的作用域句柄。复制整个 MDC 还要考虑敏感字段：若其中含用户私密信息，异步任务未必有理由继承，实际工程可只传允许字段。

## 入口过滤器的注册顺序与异步分派

Servlet 请求可能经历普通、异步和错误分派。OncePerRequestFilter 的名称不意味着所有异步线程都会自动带着 MDC。初始链退出后清理是正确的，后续异步执行应通过单独装饰器或分派策略建立上下文。可将已验证 traceId 保存到 request attribute，用于同一请求的再次分派，但不要跨请求复用静态字段保存。

过滤器必须早于希望关联的业务日志，同时考虑认证失败和异常处理日志。若追踪 Filter 排在安全过滤器之后，未登录请求可能在进入它之前已被拒绝。另一方面，不能为了覆盖全部日志而把所有外部 Header 无条件写入 MDC。外部值需要限制长度、字符、重复 Header 策略，必要时由可信网关重新生成。

响应 Header 应在链执行前设置，避免响应提交后再写失效。异常响应体也可包含相同 traceId，但不要把完整异常消息返回客户端。该 ID 是排障线索，不是身份凭证、授权码或幂等键。

## 显式绑定线程池

声明 TaskDecorator Bean 不一定会影响每个自建线程池。应明确将它绑定到实际执行异步业务的 ThreadPoolTaskExecutor。下面片段保留队列和拒绝边界，具体容量通过负载验证调整。

~~~java
@Bean(name="businessExecutor")
public ThreadPoolTaskExecutor businessExecutor() {
    ThreadPoolTaskExecutor executor=new ThreadPoolTaskExecutor();
    executor.setCorePoolSize(4);
    executor.setMaxPoolSize(8);
    executor.setQueueCapacity(200);
    executor.setThreadNamePrefix("business-");
    executor.setTaskDecorator(task -> {
        Map<String,String> captured=MDC.getCopyOfContextMap();
        return () -> {
            try (MdcScope scope=MdcScope.replace(captured)) {
                task.run();
            }
        };
    });
    executor.setRejectedExecutionHandler(new ThreadPoolExecutor.AbortPolicy());
    return executor;
}

// 调用处明确指定线程池，避免落到未装饰的公共池。
CompletableFuture.supplyAsync(() -> orderService.load(orderId),businessExecutor);
~~~

任务异常若封装在 Future 中，装饰器不一定能直接捕获并记录根因，调用方仍要观察 Future 完成状态。任务被拒绝时根本没有进入工作线程，应在提交边界记录失败。定时任务没有请求父上下文，需要每次执行创建新的关联 ID，不能使用上次请求残留数据。

## 同步 HTTP 客户端与消息消费者

下面展示 RestTemplate 风格拦截片段，RestClient 和 Feign 应使用各自扩展点。需要在实际使用的客户端 Bean 上注册，而不是仅写一个从未被引用的拦截器类。

~~~java
ClientHttpRequestInterceptor correlationInterceptor = (request, body, execution) -> {
    String traceId=MDC.get("traceId");
    if (traceId!=null) request.getHeaders().set("X-Trace-Id",traceId);
    return execution.execute(request,body);
};
~~~

请求跨越信任边界时，哪些 Header 可以向外发送由出口策略决定。不要把整个 MDC 序列化成 HTTP Header；用户 ID、Token、内部调试信息都可能被意外传到第三方。也不要把 UUID 随意拼成 W3C traceparent，标准格式还包含版本、span-id 和 flags，并有合法性限制。[W3C Trace Context](https://www.w3.org/TR/trace-context/)定义了标准传播字段。

~~~java
// MQ 集成伪代码：由具体客户端在确认策略允许的位置调用。
void consume(Message message) {
    String incoming=message.header("X-Trace-Id");
    String traceId=isSafe(incoming) ? incoming : newTraceId();
    try (MdcScope scope=MdcScope.withTrace(traceId)) {
        log.info("consume started messageId={} attempt={}",
                message.id(),message.attempt());
        transactionService.applyIdempotently(message);
        message.acknowledge();
    } catch (Exception failure) {
        // 实际日志需在仍有作用域时记录，或显式携带 traceId。
        log.error("consume failed traceId={} messageId={}",
                  traceId,message.id(),failure);
        throw failure;
    }
}
~~~

异步消息可能几小时后消费，同一业务还有多次重试。应同时保留 messageId、attempt 和 causation 信息，不能仅凭相同 traceId 判断发生了一次执行。使用标准追踪时，长时间异步任务可能更适合新 trace 加 Span Link，而非无限延长同一条链；这属于追踪模型，不由 MDC 独自完成。

## Reactor 与虚拟线程要单独验证

WebFlux 在执行过程中可能切换线程，ThreadLocal 不等于 Reactor Context。把 Servlet Filter 示例搬到响应式链路会丢上下文，甚至在错误位置读取旧值。应采用与 Reactor 和追踪库匹配的上下文传播支持。虚拟线程同样不能成为“自动传播任何父上下文”的理由，要确认具体 MDC 实现与任务创建方式，不能把线程模型变化当作上下文协议。

结构化日志建议包括 timestamp、level、service、version、traceId、errorCode 和耗时。业务 ID 可以保留，但不要把每个 traceId 变成指标标签或 Loki 标签，否则高基数会放大成本。一次请求里的所有日志都打印相同 ID，只证明关联字段存在，不证明日志没有丢失、不证明 Span 完整，也不证明系统时钟一致。

## 请求完成日志必须对应真实生命周期

关联 ID 正确之后，仍可能得到错误耗时。同步 Servlet 请求可以在 Filter 的 `finally` 中记录耗时，但控制器返回 `Callable` 或 `DeferredResult` 时，初始过滤链退出通常只说明已经转入异步处理，并不表示响应已经完成。如果这时就写 `request.completed`，日志会把几秒的请求显示成几毫秒，也可能在后续超时之后仍留下“成功完成”的错误结论。Spring MVC 的异步处理会涉及另外的执行线程与分派，应按其生命周期分别记录事件。[Spring MVC 异步请求说明](https://docs.spring.io/spring-framework/reference/6.2/web/webmvc/mvc-ann-async.html)

可以把记录分成入口接受、业务执行结束和响应完成三个事件，它们共享关联 ID，但各自有明确触发点。对于异步接口，在对应拦截回调或 Servlet 异步监听回调中建立临时 MDC 作用域，使用请求属性保存的 ID，然后记录完成、超时或异常。回调线程可能与入口线程不同，因此不要假设它能读取原线程的 MDC，也不要把整个原始请求对象放进长期后台任务以图方便。

正常完成、超时与异常回调可能共同参与一个请求的结束过程。如果指标只允许计一次，应在请求状态中使用原子完成标记，把首次终态记录与清理操作设计成幂等。后续回调可以补充诊断事件，但不能再次累计成功请求数。测试也要包含客户端断开、容器超时以及响应已经部分提交的情况，因为这些路径无法简单映射成一次可随意改写的 JSON 错误响应。

耗时测量建议使用单调时钟的差值，例如 `System.nanoTime()`；日志时间戳继续使用墙上时钟以便跨系统检索。两者用途不同：服务器校时可能改变墙上时间，却不应该让本地调用耗时变成负数。输出时明确字段单位，如 `durationMs`，避免一个服务用纳秒、另一个服务用毫秒，查询时却直接混合聚合。

对一次请求中的多次下游重试，还应记录尝试序号与阶段耗时。相同 traceId 能把它们串起来，但无法自动区分“调用耗时三秒”究竟是单次等待，还是三次一秒的重试。若这些阶段信息已经成为常态需求，就有充分理由采用标准 Span；轻量关联方案仍可继续保留为日志检索字段，迁移时由统一上下文提供其值。

## 故障注入与验收实验

测试同时覆盖入口、线程池、HTTP 和 MQ 四个边界。使用单线程池重复处理不同请求，可以更容易发现上下文污染；用有界等待收集日志，避免靠固定 sleep 判断异步完成。

### TRACE-01：缺失 Header

实验前提是HTTP 请求没有关联字段。执行调用正常接口并读取响应与业务日志。

通过条件是响应和日志共享一个新生成 ID。这里的判断依据是入口负责建立上下文，不能让缺失值沿下游扩散。

### TRACE-02：恶意 Header

实验前提是输入含控制字符或超过长度限制。执行通过容器允许的测试方式提交 Header。

通过条件是拒绝或替换非法值，日志保持一条完整记录。这里的判断依据是关联字段仍是外部输入，必须防止日志注入与资源滥用。

### TRACE-03：异常提前返回

实验前提是Controller 主动抛业务异常。执行紧接着在同一工作线程处理另一个请求。

通过条件是前一异常可关联，后一请求不继承其 ID。这里的判断依据是正常和异常路径都必须结束上下文作用域。

### TRACE-04：嵌套作用域

实验前提是线程已有父 traceId。执行进入子作用域后关闭。

通过条件是关闭后恢复父值而不是无条件移除。这里的判断依据是恢复旧上下文才能支持嵌套和调用者线程执行策略。

### TRACE-05：线程池复用

实验前提是两个请求提交到单线程执行器。执行依次执行带不同 ID 的任务。

通过条件是每个任务只看到自己的捕获值。这里的判断依据是工作线程长期存在，不能依赖线程退出清理 MDC。

### TRACE-06：公共池遗漏

实验前提是业务部分使用默认 CompletableFuture 公共池。执行与显式装饰执行器的任务对照。

通过条件是识别未传播的路径并改用受控执行器。这里的判断依据是声明一个装饰器不代表所有异步任务自动使用它。

### TRACE-07：任务拒绝

实验前提是执行器队列已满。执行提交额外任务并捕获拒绝结果。

通过条件是提交边界有可关联失败日志且不假装任务已执行。这里的判断依据是工作线程未运行时无法替调用方记录执行上下文。

### TRACE-08：HTTP 透传

实验前提是下游服务也按相同 Header 契约接收。执行通过实际注册的客户端调用下游。

通过条件是两服务日志可按同一 ID 关联。这里的判断依据是拦截器代码存在与实例真正生效是两件事。

### TRACE-09：MQ 重试

实验前提是消息存在稳定 messageId 并重投。执行失败后重试消费。

通过条件是日志能区分相同业务消息的不同尝试。这里的判断依据是traceId 不能替代幂等键或投递次数。

### TRACE-10：响应式切线程

实验前提是WebFlux 链包含线程切换。执行比较直接 MDC 与匹配的上下文传播方案。

通过条件是跨线程后仍按契约恢复且没有串线。这里的判断依据是响应式上下文不等同于普通线程本地存储。

### TRACE-11：标准追踪共存

实验前提是应用已经有 Micrometer Tracing。执行移除重复 ID 生成器并检查日志平台。

通过条件是日志 ID 能直接定位标准追踪记录。这里的判断依据是两套独立标识会破坏检索关联，需要统一生成责任。

### TRACE-12：定时任务入口

实验前提是任务不是由 HTTP 请求触发。执行连续执行两次定时作业。

通过条件是每次有明确任务关联 ID 且结束后清理。这里的判断依据是无父请求的入口必须自己定义上下文生命周期。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "Spring Boot 3原生日志traceId方案",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "TRACE-01",
      "scenario": "缺失 Header",
      "given": "HTTP 请求没有关联字段",
      "when": "调用正常接口并读取响应与业务日志",
      "then": "响应和日志共享一个新生成 ID"
    },
    {
      "id": "TRACE-02",
      "scenario": "恶意 Header",
      "given": "输入含控制字符或超过长度限制",
      "when": "通过容器允许的测试方式提交 Header",
      "then": "拒绝或替换非法值，日志保持一条完整记录"
    },
    {
      "id": "TRACE-03",
      "scenario": "异常提前返回",
      "given": "Controller 主动抛业务异常",
      "when": "紧接着在同一工作线程处理另一个请求",
      "then": "前一异常可关联，后一请求不继承其 ID"
    },
    {
      "id": "TRACE-04",
      "scenario": "嵌套作用域",
      "given": "线程已有父 traceId",
      "when": "进入子作用域后关闭",
      "then": "关闭后恢复父值而不是无条件移除"
    },
    {
      "id": "TRACE-05",
      "scenario": "线程池复用",
      "given": "两个请求提交到单线程执行器",
      "when": "依次执行带不同 ID 的任务",
      "then": "每个任务只看到自己的捕获值"
    },
    {
      "id": "TRACE-06",
      "scenario": "公共池遗漏",
      "given": "业务部分使用默认 CompletableFuture 公共池",
      "when": "与显式装饰执行器的任务对照",
      "then": "识别未传播的路径并改用受控执行器"
    },
    {
      "id": "TRACE-07",
      "scenario": "任务拒绝",
      "given": "执行器队列已满",
      "when": "提交额外任务并捕获拒绝结果",
      "then": "提交边界有可关联失败日志且不假装任务已执行"
    },
    {
      "id": "TRACE-08",
      "scenario": "HTTP 透传",
      "given": "下游服务也按相同 Header 契约接收",
      "when": "通过实际注册的客户端调用下游",
      "then": "两服务日志可按同一 ID 关联"
    },
    {
      "id": "TRACE-09",
      "scenario": "MQ 重试",
      "given": "消息存在稳定 messageId 并重投",
      "when": "执行失败后重试消费",
      "then": "日志能区分相同业务消息的不同尝试"
    },
    {
      "id": "TRACE-10",
      "scenario": "响应式切线程",
      "given": "WebFlux 链包含线程切换",
      "when": "比较直接 MDC 与匹配的上下文传播方案",
      "then": "跨线程后仍按契约恢复且没有串线"
    },
    {
      "id": "TRACE-11",
      "scenario": "标准追踪共存",
      "given": "应用已经有 Micrometer Tracing",
      "when": "移除重复 ID 生成器并检查日志平台",
      "then": "日志 ID 能直接定位标准追踪记录"
    },
    {
      "id": "TRACE-12",
      "scenario": "定时任务入口",
      "given": "任务不是由 HTTP 请求触发",
      "when": "连续执行两次定时作业",
      "then": "每次有明确任务关联 ID 且结束后清理"
    }
  ]
}
```

## 轻量方案的终点

Filter、MDC 与传播适配器能够解决日志关联。需要分析父子调用、采样和拓扑时，应把生成与传播责任交给标准追踪组件，保留统一日志字段。不要让自定义 Header 逐步长成一套无人维护的追踪协议。

## 参考资料与继续阅读

- [Spring Boot Tracing](https://docs.spring.io/spring-boot/reference/actuator/tracing.html)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [本地延伸：TLog](轻量级日志traceId方案TLog.md)
