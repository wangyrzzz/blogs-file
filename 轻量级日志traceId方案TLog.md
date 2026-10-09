# 轻量级日志 TraceId 方案：TLog 实践思路

> 阅读范围：以 TLog 官方项目为接入入口，适配能力按实际 artifact 和版本核对；手工 MDC 示例为边界补充。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


在微服务环境中，一次用户请求可能经过网关、订单服务、库存服务和消息消费者。没有关联标识时，排查问题只能依靠时间和线程名猜测。TraceId 的作用就是把同一条业务链路上的日志串起来。

TLog 通过自身上下文、日志增强和相应适配模块提供关联能力；不能据此假设任意 MDC 键、任意线程池或任意 MQ 客户端都已自动接入。具体注解和配置项会随版本变化，本文重点说明设计边界和使用方式。

## TraceId 应该解决什么问题

一个合格的链路标识至少应满足：

- 一次入口请求生成一个稳定的 TraceId；
- 下游 HTTP/RPC 调用能够透传；
- 异步任务和消息消费不会错误复用上一个线程的标识；
- 请求结束后清理上下文，避免线程池线程污染；
- 日志格式可被采集系统解析和检索。

TraceId 用于定位链路，不等于业务订单号。订单号可以作为业务字段额外打印，但不能拿业务 ID 代替链路 ID。

## 日志格式

推荐让 TraceId 成为结构化字段，而不是只拼在一段文本中：

```xml
<pattern>%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level traceId=%X{traceId} %logger - %msg%n</pattern>
```

如果日志进入 Loki、ELK 或其他采集系统，优先输出 JSON，并把 `traceId`、`spanId`、服务名、环境和版本作为独立字段。这样既能检索，也不会因为日志正文格式变化导致解析失败。

## 入口生成与清理

当系统没有完整的分布式追踪组件时，可以在 Web 入口使用过滤器生成 TraceId：

```java
@Component
public class TraceIdFilter extends OncePerRequestFilter {
    private static final String HEADER = "X-Trace-Id";

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain chain)
            throws ServletException, IOException {
        String traceId = Optional.ofNullable(request.getHeader(HEADER))
                .filter(id -> id.length() <= 64 && id.matches("[A-Za-z0-9._-]+"))
                .orElseGet(() -> UUID.randomUUID().toString().replace("-", ""));
        try (MDC.MDCCloseable ignored = MDC.putCloseable("traceId", traceId)) {
            response.setHeader(HEADER, traceId);
            chain.doFilter(request, response);
        }
    }
}
```

`try/finally` 或 `MDCCloseable` 很重要。Servlet 容器和线程池都会复用线程，如果不清理 MDC，下一次请求可能打印上一次请求的 TraceId。

## 线程池与异步任务

MDC 是线程本地数据，提交任务时不会自动进入线程池工作线程。可以使用 `TaskDecorator` 复制并在执行完成后恢复上下文：

```java
public class MdcTaskDecorator implements TaskDecorator {
    @Override
    public Runnable decorate(Runnable task) {
        Map<String, String> parent = MDC.getCopyOfContextMap();
        return () -> {
            Map<String, String> previous = MDC.getCopyOfContextMap();
            try {
                if (parent == null) MDC.clear(); else MDC.setContextMap(parent);
                task.run();
            } finally {
                if (previous == null) MDC.clear(); else MDC.setContextMap(previous);
            }
        };
    }
}
```

对于消息队列，生产者把 TraceId 放到消息 Header，消费者取出后建立新的消费上下文。消费链路可以沿用原 TraceId，也可以生成新的 SpanId；关键是明确约定并避免把 Header 中的任意内容直接当成可信身份。

## TLog 与完整链路追踪的区别

TLog 或自定义 MDC 方案适合快速解决“日志关联”问题，成本低、侵入小；它不一定提供完整的 Span、采样、拓扑和耗时分析。如果需要跨服务调用耗时、错误传播和链路拓扑，应考虑 Micrometer Tracing、OpenTelemetry 等标准方案。

两者可以并存：由追踪组件生成 TraceId，由日志框架打印 TraceId；业务日志只负责补充订单号、用户 ID 等业务维度，不重复实现一套上下文协议。

## 常见坑

- 把完整 Token、手机号或身份证号写入日志；
- 从外部请求直接接受过长或包含控制字符的 TraceId；
- 异步任务没有传递上下文，或者传递后没有清理；
- 只在应用日志中打印，却没有让网关、MQ 和采集系统保留字段；
- 以 TraceId 代替幂等键，导致重试请求无法正确识别。


## 接入之前先画一张边界清单

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

~~~jsonl
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

运维上保留接入覆盖率：已验证入口数、已验证异步边界数、缺少 ID 日志比例、非法上游 ID 次数、传播失败率和采集丢失。统计缺失比例时应排除启动日志等没有请求上下文的合理场景，否则指标会长期告警却没有行动价值。

## 故障注入与验收实验

先保留一条完整 HTTP→异步→RPC→MQ 样本，再逐边界故障注入。所有版本结论应写入项目接入表，不把框架名称当成全链路已经覆盖的证据。

### TLOG-01：实际模块覆盖

实验前提是项目同时使用两种 HTTP 客户端。执行逐个客户端调用下游并查看接收字段。

通过条件是只对真正验证过的客户端标记已接入。这里的判断依据是框架支持列表与项目实际 Bean 是否安装适配器需要分别核对。

### TLOG-02：MDC 字段误解

实验前提是日志转换器已经输出 TLog 标签。执行同时读取 MDC 并检查适配器上下文来源。

通过条件是明确字段映射关系，不假定两个容器天然相同。这里的判断依据是输出标签、MDC 与框架上下文是不同层面的实现。

### TLOG-03：重复入口生成

实验前提是已有 TLog 入口又注册自定义 UUID Filter。执行对照入口、业务与出站 ID。

通过条件是系统仅有一个主关联 ID 生成责任。这里的判断依据是两套互相覆盖的生成器会制造看似正常却无法串联的日志。

### TLOG-04：提交时捕获

实验前提是任务排队等待而父线程已切换请求。执行让工作线程稍后执行任务。

通过条件是任务仍使用提交时的上下文。这里的判断依据是执行时读取线程本地值不能代表原提交者。

### TLOG-05：异常后清理

实验前提是任务在单线程池中抛异常。执行随后执行不带上下文的任务。

通过条件是后续任务没有前一个请求 ID。这里的判断依据是异常路径是线程复用污染最容易遗漏的入口。

### TLOG-06：调用者线程执行

实验前提是拒绝策略允许任务回到调用线程运行。执行嵌套任务后继续父请求日志。

通过条件是父上下文被恢复而非被子任务清空。这里的判断依据是恢复旧值优于简单清空，能够兼容嵌套执行。

### TLOG-07：MQ 重复消费

实验前提是同一消息有两次投递尝试。执行分别记录 traceId、messageId、attempt。

通过条件是能够辨认消息因果和重试次数。这里的判断依据是日志关联不能替代业务幂等或投递状态。

### TLOG-08：定时入口

实验前提是后台作业没有 HTTP 父上下文。执行连续运行两个批次。

通过条件是批次拥有独立关联范围且不会复用残留。这里的判断依据是每种入口都要定义上下文开始和结束。

### TLOG-09：日志字段解析

实验前提是日志输出包含 JSON 与异常堆栈。执行采集后查询 traceId 和错误码。

通过条件是字段仍能独立查询且堆栈不丢失。这里的判断依据是应用打印正确不代表采集器解析和存储也正确。

### TLOG-10：版本升级

实验前提是升级 Boot、日志框架或客户端其中之一。执行重跑所有已登记传播边界。

通过条件是明确哪些适配仍有效，哪些需要变更。这里的判断依据是自动集成依赖具体版本兼容关系。

### TLOG-11：标准追踪迁移

实验前提是灰度服务同时关联日志和 Span。执行按响应 ID 查询日志和追踪后端。

通过条件是两类记录能关联且未采样情形有解释。这里的判断依据是日志保留与追踪采样是不同策略。

### TLOG-12：日志查询越权

实验前提是用户知道另一个租户的 traceId。执行通过日志查询入口尝试访问。

通过条件是仍被租户和平台权限约束拒绝。这里的判断依据是可猜到或可指定的关联 ID 不具备访问授权能力。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "轻量级日志traceId方案TLog",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "TLOG-01",
      "scenario": "实际模块覆盖",
      "given": "项目同时使用两种 HTTP 客户端",
      "when": "逐个客户端调用下游并查看接收字段",
      "then": "只对真正验证过的客户端标记已接入"
    },
    {
      "id": "TLOG-02",
      "scenario": "MDC 字段误解",
      "given": "日志转换器已经输出 TLog 标签",
      "when": "同时读取 MDC 并检查适配器上下文来源",
      "then": "明确字段映射关系，不假定两个容器天然相同"
    },
    {
      "id": "TLOG-03",
      "scenario": "重复入口生成",
      "given": "已有 TLog 入口又注册自定义 UUID Filter",
      "when": "对照入口、业务与出站 ID",
      "then": "系统仅有一个主关联 ID 生成责任"
    },
    {
      "id": "TLOG-04",
      "scenario": "提交时捕获",
      "given": "任务排队等待而父线程已切换请求",
      "when": "让工作线程稍后执行任务",
      "then": "任务仍使用提交时的上下文"
    },
    {
      "id": "TLOG-05",
      "scenario": "异常后清理",
      "given": "任务在单线程池中抛异常",
      "when": "随后执行不带上下文的任务",
      "then": "后续任务没有前一个请求 ID"
    },
    {
      "id": "TLOG-06",
      "scenario": "调用者线程执行",
      "given": "拒绝策略允许任务回到调用线程运行",
      "when": "执行嵌套任务后继续父请求日志",
      "then": "父上下文被恢复而非被子任务清空"
    },
    {
      "id": "TLOG-07",
      "scenario": "MQ 重复消费",
      "given": "同一消息有两次投递尝试",
      "when": "分别记录 traceId、messageId、attempt",
      "then": "能够辨认消息因果和重试次数"
    },
    {
      "id": "TLOG-08",
      "scenario": "定时入口",
      "given": "后台作业没有 HTTP 父上下文",
      "when": "连续运行两个批次",
      "then": "批次拥有独立关联范围且不会复用残留"
    },
    {
      "id": "TLOG-09",
      "scenario": "日志字段解析",
      "given": "日志输出包含 JSON 与异常堆栈",
      "when": "采集后查询 traceId 和错误码",
      "then": "字段仍能独立查询且堆栈不丢失"
    },
    {
      "id": "TLOG-10",
      "scenario": "版本升级",
      "given": "升级 Boot、日志框架或客户端其中之一",
      "when": "重跑所有已登记传播边界",
      "then": "明确哪些适配仍有效，哪些需要变更"
    },
    {
      "id": "TLOG-11",
      "scenario": "标准追踪迁移",
      "given": "灰度服务同时关联日志和 Span",
      "when": "按响应 ID 查询日志和追踪后端",
      "then": "两类记录能关联且未采样情形有解释"
    },
    {
      "id": "TLOG-12",
      "scenario": "日志查询越权",
      "given": "用户知道另一个租户的 traceId",
      "when": "通过日志查询入口尝试访问",
      "then": "仍被租户和平台权限约束拒绝"
    }
  ]
}
```

## 异步写日志与异步执行业务是两种边界

业务代码在请求线程调用 logger，日志组件再把事件交给后台线程写入文件，这与业务代码把 Runnable 提交到线程池不同。前一种情况应由日志实现于事件创建或进入队列前固定关联字段，后一种情况需要在提交业务任务时捕获业务上下文。把两者混为一谈，容易出现日志文件中有值，而业务任务发出的下游请求仍没有传播字段的情况。

验收异步日志时，可以让请求 A 产生一条日志后立即清理 MDC，再让请求 B 使用同一个线程，最后等待日志队列排空。输出中的第一条日志仍应属于 A。若自定义编码器在后台写入时才读取当前线程 MDC，它读取的通常是日志线程的上下文，无法代表原业务调用。结构化日志字段应取自日志事件所携带的上下文快照，具体捕获时机需要结合实际日志框架验证。

队列满时的丢弃、阻塞和降级策略也会影响排障。低优先级日志允许丢弃时，应有可观测的丢弃数量；关键业务状态不能只存在于一条可能丢失的 INFO 日志中。审计事件或业务结果需要独立的可靠记录。关闭服务前等待日志刷新只能降低正常退出的尾部丢失，无法保证强制终止、磁盘故障和采集故障下的完整性。因此缺少某条日志只能作为线索，不能直接证明某段代码从未执行。

## 批量任务如何选择关联粒度

一个导入作业处理十万个订单时，把全部记录放在同一个 traceId 下虽然容易检索整个批次，却会使单次问题查询返回过多结果。反过来，每处理一条日志就创建新 ID，又会失去同一订单的处理过程。可以保留稳定的 jobId 表示整批作业，为每次分片执行保存 executionId，并让每个业务处理范围拥有自己的关联上下文。字段各司其职，查询时先定位批次，再缩小到某次执行和某条订单。

重试时延续哪些标识要提前定义。业务 jobId 和 itemId 通常保持稳定，attempt 随重试增加，单次执行的上下文则按选定策略新建或延续。若采用新上下文，记录 previousExecutionId 或 parentRequestId 来表达来源，而不是把所有历史调用强行拼成一个长期不结束的请求。对于 TLog 原生关联和标准追踪之间的桥接，来源字段只是查询关系，不能冒充追踪系统已经建立了父子 Span。

批量消费者还要防止“一个消息污染整个批次”。应在逐项处理前安装对应上下文，在该项结束时恢复批次上下文；失败后继续处理下一项也必须经过清理路径。如果框架只在批次入口安装一次 Header，就需要确认批内消息是否确实来自同一业务范围。来自不同上游的消息不应共享偶然取到的第一条消息标识。

## 在滚动升级期间保持日志可检索

日志字段改名属于采集契约变化。假设旧版本输出 trace_id，新版本输出 traceId，滚动发布期间两种格式会同时存在。可以先让采集层同时识别两种输入并归一化，再发布应用，最后在旧实例完全退出且旧日志超过所需检索窗口后移除兼容规则。若先把查询模板改成只看新字段，旧实例即使持续正常打印也会在面板里看似失联。

字段兼容还包括空值、类型与编码。把数字形态的关联标识按数字解析，可能丢失前导零或精度；应将它作为字符串保存。异常日志与普通日志都要经过同一字段映射，不能只验证一行成功日志。升级验收应拿真实格式的脱敏样本走完整采集链，检查解析、存储、查询和响应头关联，而不仅是在开发环境看控制台。

排查一条不完整链路时，可按入口是否生成、出口是否携带、下游是否读取、日志事件是否捕获、采集是否保留的顺序逐段核对。每一步都保留一个可观察的边界证据，便能区分传播失败与日志丢失。不要先同时调整多个拦截器；那样即使问题消失，也难以判断哪个环节起作用，更容易留下双重生成或重复清理的新问题。

## 接入完成的判断

TLog 接入完成应意味着每个入口、出口和异步边界都验证过生成、传播、恢复与采集。依赖加入成功只是开始，能够用一条真实业务线索跨越全部边界定位问题，才是日志关联方案的实际价值。

## 参考资料与继续阅读

- [TLog 官方仓库](https://github.com/dromara/TLog)
- [Spring Boot Tracing](https://docs.spring.io/spring-boot/reference/actuator/tracing.html)
- [本地延伸：轻量 Filter 与 MDC](Spring%20Boot%203原生日志traceId方案.md)
