# 轻量级日志 TraceId 方案：TLog 实践思路

在微服务环境中，一次用户请求可能经过网关、订单服务、库存服务和消息消费者。没有关联标识时，排查问题只能依靠时间和线程名猜测。TraceId 的作用就是把同一条业务链路上的日志串起来。

TLog 这类日志增强组件通常通过 MDC、AOP 或上下文传递，将 TraceId 自动写入日志，并在调用线程、线程池和消息消费之间传递。具体注解和配置项会随版本变化，本文重点说明设计边界和使用方式。

## 一、TraceId 应该解决什么问题

一个合格的链路标识至少应满足：

- 一次入口请求生成一个稳定的 TraceId；
- 下游 HTTP/RPC 调用能够透传；
- 异步任务和消息消费不会错误复用上一个线程的标识；
- 请求结束后清理上下文，避免线程池线程污染；
- 日志格式可被采集系统解析和检索。

TraceId 用于定位链路，不等于业务订单号。订单号可以作为业务字段额外打印，但不能拿业务 ID 代替链路 ID。

## 二、日志格式

推荐让 TraceId 成为结构化字段，而不是只拼在一段文本中：

```xml
<pattern>%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level traceId=%X{traceId} %logger - %msg%n</pattern>
```

如果日志进入 Loki、ELK 或其他采集系统，优先输出 JSON，并把 `traceId`、`spanId`、服务名、环境和版本作为独立字段。这样既能检索，也不会因为日志正文格式变化导致解析失败。

## 三、入口生成与清理

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
                .filter(id -> id.length() <= 64)
                .orElseGet(() -> UUID.randomUUID().toString().replace("-", ""));
        try (MDC.MDCCloseable ignored = MDC.putCloseable("traceId", traceId)) {
            response.setHeader(HEADER, traceId);
            chain.doFilter(request, response);
        }
    }
}
```

`try/finally` 或 `MDCCloseable` 很重要。Servlet 容器和线程池都会复用线程，如果不清理 MDC，下一次请求可能打印上一次请求的 TraceId。

## 四、线程池与异步任务

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

## 五、TLog 与完整链路追踪的区别

TLog 或自定义 MDC 方案适合快速解决“日志关联”问题，成本低、侵入小；它不一定提供完整的 Span、采样、拓扑和耗时分析。如果需要跨服务调用耗时、错误传播和链路拓扑，应考虑 Micrometer Tracing、OpenTelemetry 等标准方案。

两者可以并存：由追踪组件生成 TraceId，由日志框架打印 TraceId；业务日志只负责补充订单号、用户 ID 等业务维度，不重复实现一套上下文协议。

## 六、常见坑

- 把完整 Token、手机号或身份证号写入日志；
- 从外部请求直接接受过长或包含控制字符的 TraceId；
- 异步任务没有传递上下文，或者传递后没有清理；
- 只在应用日志中打印，却没有让网关、MQ 和采集系统保留字段；
- 以 TraceId 代替幂等键，导致重试请求无法正确识别。

## 总结

TraceId 方案的核心不是某个注解，而是入口生成、跨边界传递、线程隔离、结束清理和统一采集。TLog 可以简化这些工作，但仍要结合线程池、消息队列和日志平台做完整验证。
