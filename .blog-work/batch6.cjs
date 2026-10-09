const {writeArticle}=require('./compose.cjs');
const articles=[{
file:'Spring Boot 3原生日志traceId方案.md',scope:'Spring Boot 3 的 Servlet 应用与 SLF4J MDC；自定义日志关联不等于完整分布式追踪',
body:`## 先明确“原生”的含义

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

结构化日志建议包括 timestamp、level、service、version、traceId、errorCode 和耗时。业务 ID 可以保留，但不要把每个 traceId 变成指标标签或 Loki 标签，否则高基数会放大成本。一次请求里的所有日志都打印相同 ID，只证明关联字段存在，不证明日志没有丢失、不证明 Span 完整，也不证明系统时钟一致。`,
lab:'测试同时覆盖入口、线程池、HTTP 和 MQ 四个边界。使用单线程池重复处理不同请求，可以更容易发现上下文污染；用有界等待收集日志，避免靠固定 sleep 判断异步完成。',
cases:[
['TRACE-01','缺失 Header','HTTP 请求没有关联字段','调用正常接口并读取响应与业务日志','响应和日志共享一个新生成 ID','入口负责建立上下文，不能让缺失值沿下游扩散'],
['TRACE-02','恶意 Header','输入含控制字符或超过长度限制','通过容器允许的测试方式提交 Header','拒绝或替换非法值，日志保持一条完整记录','关联字段仍是外部输入，必须防止日志注入与资源滥用'],
['TRACE-03','异常提前返回','Controller 主动抛业务异常','紧接着在同一工作线程处理另一个请求','前一异常可关联，后一请求不继承其 ID','正常和异常路径都必须结束上下文作用域'],
['TRACE-04','嵌套作用域','线程已有父 traceId','进入子作用域后关闭','关闭后恢复父值而不是无条件移除','恢复旧上下文才能支持嵌套和调用者线程执行策略'],
['TRACE-05','线程池复用','两个请求提交到单线程执行器','依次执行带不同 ID 的任务','每个任务只看到自己的捕获值','工作线程长期存在，不能依赖线程退出清理 MDC'],
['TRACE-06','公共池遗漏','业务部分使用默认 CompletableFuture 公共池','与显式装饰执行器的任务对照','识别未传播的路径并改用受控执行器','声明一个装饰器不代表所有异步任务自动使用它'],
['TRACE-07','任务拒绝','执行器队列已满','提交额外任务并捕获拒绝结果','提交边界有可关联失败日志且不假装任务已执行','工作线程未运行时无法替调用方记录执行上下文'],
['TRACE-08','HTTP 透传','下游服务也按相同 Header 契约接收','通过实际注册的客户端调用下游','两服务日志可按同一 ID 关联','拦截器代码存在与实例真正生效是两件事'],
['TRACE-09','MQ 重试','消息存在稳定 messageId 并重投','执行失败后重试消费','日志能区分相同业务消息的不同尝试','traceId 不能替代幂等键或投递次数'],
['TRACE-10','响应式切线程','WebFlux 链包含线程切换','比较直接 MDC 与匹配的上下文传播方案','跨线程后仍按契约恢复且没有串线','响应式上下文不等同于普通线程本地存储'],
['TRACE-11','标准追踪共存','应用已经有 Micrometer Tracing','移除重复 ID 生成器并检查日志平台','日志 ID 能直接定位标准追踪记录','两套独立标识会破坏检索关联，需要统一生成责任'],
['TRACE-12','定时任务入口','任务不是由 HTTP 请求触发','连续执行两次定时作业','每次有明确任务关联 ID 且结束后清理','无父请求的入口必须自己定义上下文生命周期']
],end:'## 轻量方案的终点\n\nFilter、MDC 与传播适配器能够解决日志关联。需要分析父子调用、采样和拓扑时，应把生成与传播责任交给标准追踪组件，保留统一日志字段。不要让自定义 Header 逐步长成一套无人维护的追踪协议。',refs:[['Spring Boot Tracing','https://docs.spring.io/spring-boot/reference/actuator/tracing.html'],['W3C Trace Context','https://www.w3.org/TR/trace-context/'],['本地延伸：TLog','轻量级日志traceId方案TLog.md']]},
{
file:'轻量级日志traceId方案TLog.md',scope:'以 TLog 官方项目为接入入口，适配能力按实际 artifact 和版本核对；手工 MDC 示例为边界补充',
replace:[['.filter(id -> id.length() <= 64)','.filter(id -> id.length() <= 64 && id.matches("[A-Za-z0-9._-]+"))'],['TLog 这类日志增强组件通常通过 MDC、AOP 或上下文传递，将 TraceId 自动写入日志，并在调用线程、线程池和消息消费之间传递。','TLog 通过自身上下文、日志增强和相应适配模块提供关联能力；不能据此假设任意 MDC 键、任意线程池或任意 MQ 客户端都已自动接入。']],
body:`## 接入之前先画一张边界清单

TLog 的优势是减少常见调用链的关联代码，但真正的接入单位不是“一个 Spring Boot 项目”，而是每一种入口和出口。一个项目可能同时有 MVC、定时任务、Feign、Dubbo、自建线程池、消息消费和手写 OkHttp。只验证 Controller 日志带 ID，覆盖的是其中一条路径。

官方项目维护多个集成模块，具体列表、依赖坐标与兼容要求应查看[TLog 官方仓库](https://github.com/dromara/TLog)及所选 tag。不要因为 README 展示了某种客户端，就断言公司所用的新大版本已经兼容。尤其是 Boot 2 到 Boot 3 的 Jakarta 变化、日志框架升级和 HTTP 客户端替换，都可能影响适配器实际挂载。

建议建一张接入表，列出边界、实际 Bean、适配模块、传播字段、清理位置和验证方法。缺少适配的边界再补手工桥接，而不是先加一个全局 Filter 生成第二套 ID。

| 边界 | 必须查清的问题 | 验证证据 |
| --- | --- | --- |
| HTTP 入口 | 可信上游、字段名、生成责任 | 响应与入口日志一致 |
| Feign/HTTP 出口 | 实际客户端是否安装拦截器 | 下游收到的 Header |
| Dubbo | attachment 的写入读取路径 | 提供者关联日志 |
| 线程池 | 提交时捕获还是执行时捕获 | 单线程复用测试 |
| MQ | 生产与消费 Header 的契约 | 重试和异常日志 |
| 定时作业 | 没有父上下文时由谁建 ID | 每次执行独立关联 |

## 不把 TLog 标签和 MDC 字段混为一谈

某个日志输出扩展能自动打印 TLog 标签，不代表 MDC.get("traceId") 一定有值。反过来，MDC 里有 traceId，也不证明框架出站适配器从这个键取值。要从所选版本的公开 API 和适配器实现核实真正的上下文来源。前文的 Filter 与 TaskDecorator 是手工 MDC 方案，不应未经确认就与 TLog 自动入口同时启用。

如果采集平台统一使用 traceId 字段，而框架输出字段名称不同，可以在日志编码层做明确映射。映射只改变输出格式，传播仍然由原框架上下文负责。若日志拼装阶段又生成一个随机值，检索会出现每条日志不同 ID 的严重错误。

下面 XML 只是 MDC 格式演示，使用 TLog 专用转换器时应替换为版本文档指定的转换规则。不要将示例 pattern 当成已经完成 TLog 上下文安装。

~~~xml
<configuration>
  <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
    <encoder>
      <pattern>%d{yyyy-MM-dd'T'HH:mm:ss.SSSXXX} %-5level [%thread] traceId=%X{traceId:-none} %logger{36} - %msg%n</pattern>
    </encoder>
  </appender>
  <root level="INFO">
    <appender-ref ref="CONSOLE"/>
  </root>
</configuration>
~~~

## 跨线程传播的正确时机

上下文应在提交任务时捕获。如果直到工作线程执行时才读取，读到的是工作线程自己的旧数据或空数据。捕获的数据还要有独立快照，不能把可变 Map 引用交给多个并发任务继续修改。执行结束恢复旧值的原因不仅是防串线，还包括 CallerRunsPolicy 在提交线程同步执行的情况。

对于 TLog，应优先使用该版本提供的线程包装或上下文 API；手工复制 MDC 不一定复制了 TLog 的全部内部状态。框架封装已有传播后，再套一层自己生成 ID 的包装，可能覆盖父上下文。需要的不是装饰器越多越好，而是每个边界只有一个清晰的所有者。

### 可用于检验 MDC 污染的测试骨架

以下 Java 片段针对 MDC 语义，运行需项目已有 SLF4J 与实际日志实现。把 wrap 替换为实际 TLog 传播包装后，可以用同样断言验证接入。示例不依赖某个未经核实的 TLog 方法名。

~~~java
import java.util.Map;
import java.util.concurrent.*;
import org.slf4j.MDC;

public class ContextIsolationLab {
    static Runnable wrap(Runnable work) {
        Map<String,String> captured=MDC.getCopyOfContextMap();
        return () -> {
            Map<String,String> old=MDC.getCopyOfContextMap();
            try {
                if (captured==null) MDC.clear();
                else MDC.setContextMap(captured);
                work.run();
            } finally {
                if (old==null) MDC.clear();
                else MDC.setContextMap(old);
            }
        };
    }
    static void require(String expected) {
        String actual=MDC.get("traceId");
        if (!java.util.Objects.equals(expected,actual)) {
            throw new AssertionError("expected="+expected+", actual="+actual);
        }
    }
    public static void main(String[] args) throws Exception {
        try (ExecutorService pool=Executors.newSingleThreadExecutor()) {
            MDC.put("traceId","request-a");
            Future<?> a=pool.submit(wrap(() -> require("request-a")));
            MDC.put("traceId","request-b");
            Future<?> b=pool.submit(wrap(() -> require("request-b")));
            MDC.clear();
            a.get(); b.get();
            pool.submit(() -> require(null)).get();
            MDC.put("traceId","parent");
            try {
                wrap(() -> { throw new IllegalStateException("test failure"); }).run();
            } catch (IllegalStateException expected) {
                require("parent");
            } finally { MDC.clear(); }
        }
    }
}
~~~

## 一条业务链需要哪些日志

以订单创建为例，入口记录请求接受、下游库存记录扣减结果、异步通知记录发送尝试、MQ 消费记录业务提交。每个阶段都应携带稳定的业务 requestId 或 messageId，并与 traceId 分开。客户端重试可能产生新 traceId，但它仍是同一业务幂等请求；一次 traceId 下又可能有多条不同消息。

~~~json
{"service":"order","event":"request.accepted","traceId":"demo-a","requestId":"req-1"}
{"service":"inventory","event":"stock.reserved","traceId":"demo-a","reservationId":"r-1"}
{"service":"order","event":"event.published","traceId":"demo-a","messageId":"m-1"}
{"service":"notification","event":"consume.completed","traceId":"demo-a","messageId":"m-1","attempt":2}
~~~

这些是示意日志，不是运行记录。真实日志中还应有时间、级别、实例版本和明确耗时单位。不同主机时钟可能偏移，按日志时间排序只能辅助理解，不能代替业务版本与消息因果关系。堆栈最好保存在一个结构化事件中，避免采集器把多行异常拆散后失去关联。

## 外部 ID 的信任与长度

攻击者可以指定一个合法形状的 traceId，因此它不能当作鉴权凭证，也不能据此直接开放全部日志查询。对外反馈 traceId 时，日志平台仍需按服务、租户和访问权限过滤。公网边界可以重新生成内部关联 ID，同时记录受限的外部请求标识，以免用户任意合并不同请求的日志。

长度和字符白名单能防日志注入，但还要处理重复 Header、大小写和代理覆盖规则。禁止把 Token 或用户输入正文拼进 traceId。指标系统不应按每个 traceId 分组，Loki 标签也不应承载这些高基数值；放在结构化正文中，通过低基数服务标签缩小范围后检索更合适。

## 从日志关联迁移到标准追踪

TLog 适合回答“这次请求有哪些日志”。要回答“哪一个下游调用占了 800 毫秒”“哪里发生重试”“父子 Span 关系是什么”，就需要标准追踪数据。迁移时可以先统一日志字段，再在少量服务启用 Micrometer 或 OpenTelemetry，验证传播协议与采样；不要让两套系统都独立生成主 traceId。

采样只影响部分追踪记录是否导出，不必等价于业务日志是否记录。用户拿到一个 ID 却查不到 trace，可能因为采样、导出失败或数据过期，不能直接断言请求没经过服务。迁移验收要覆盖未采样请求的日志检索，明确日志与 trace 的不同保留周期。

运维上保留接入覆盖率：已验证入口数、已验证异步边界数、缺少 ID 日志比例、非法上游 ID 次数、传播失败率和采集丢失。统计缺失比例时应排除启动日志等没有请求上下文的合理场景，否则指标会长期告警却没有行动价值。`,
lab:'先保留一条完整 HTTP→异步→RPC→MQ 样本，再逐边界故障注入。所有版本结论应写入项目接入表，不把框架名称当成全链路已经覆盖的证据。',
cases:[
['TLOG-01','实际模块覆盖','项目同时使用两种 HTTP 客户端','逐个客户端调用下游并查看接收字段','只对真正验证过的客户端标记已接入','框架支持列表与项目实际 Bean 是否安装适配器需要分别核对'],
['TLOG-02','MDC 字段误解','日志转换器已经输出 TLog 标签','同时读取 MDC 并检查适配器上下文来源','明确字段映射关系，不假定两个容器天然相同','输出标签、MDC 与框架上下文是不同层面的实现'],
['TLOG-03','重复入口生成','已有 TLog 入口又注册自定义 UUID Filter','对照入口、业务与出站 ID','系统仅有一个主关联 ID 生成责任','两套互相覆盖的生成器会制造看似正常却无法串联的日志'],
['TLOG-04','提交时捕获','任务排队等待而父线程已切换请求','让工作线程稍后执行任务','任务仍使用提交时的上下文','执行时读取线程本地值不能代表原提交者'],
['TLOG-05','异常后清理','任务在单线程池中抛异常','随后执行不带上下文的任务','后续任务没有前一个请求 ID','异常路径是线程复用污染最容易遗漏的入口'],
['TLOG-06','调用者线程执行','拒绝策略允许任务回到调用线程运行','执行嵌套任务后继续父请求日志','父上下文被恢复而非被子任务清空','恢复旧值优于简单清空，能够兼容嵌套执行'],
['TLOG-07','MQ 重复消费','同一消息有两次投递尝试','分别记录 traceId、messageId、attempt','能够辨认消息因果和重试次数','日志关联不能替代业务幂等或投递状态'],
['TLOG-08','定时入口','后台作业没有 HTTP 父上下文','连续运行两个批次','批次拥有独立关联范围且不会复用残留','每种入口都要定义上下文开始和结束'],
['TLOG-09','日志字段解析','日志输出包含 JSON 与异常堆栈','采集后查询 traceId 和错误码','字段仍能独立查询且堆栈不丢失','应用打印正确不代表采集器解析和存储也正确'],
['TLOG-10','版本升级','升级 Boot、日志框架或客户端其中之一','重跑所有已登记传播边界','明确哪些适配仍有效，哪些需要变更','自动集成依赖具体版本兼容关系'],
['TLOG-11','标准追踪迁移','灰度服务同时关联日志和 Span','按响应 ID 查询日志和追踪后端','两类记录能关联且未采样情形有解释','日志保留与追踪采样是不同策略'],
['TLOG-12','日志查询越权','用户知道另一个租户的 traceId','通过日志查询入口尝试访问','仍被租户和平台权限约束拒绝','可猜到或可指定的关联 ID 不具备访问授权能力']
],end:'## 接入完成的判断\n\nTLog 接入完成应意味着每个入口、出口和异步边界都验证过生成、传播、恢复与采集。依赖加入成功只是开始，能够用一条真实业务线索跨越全部边界定位问题，才是日志关联方案的实际价值。',refs:[['TLog 官方仓库','https://github.com/dromara/TLog'],['Spring Boot Tracing','https://docs.spring.io/spring-boot/reference/actuator/tracing.html'],['本地延伸：轻量 Filter 与 MDC','Spring%20Boot%203原生日志traceId方案.md']]}
];
for(const a of articles)console.log(writeArticle(a));
