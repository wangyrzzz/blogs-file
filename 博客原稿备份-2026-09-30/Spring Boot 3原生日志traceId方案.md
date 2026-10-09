# Spring Boot 3 原生日志 TraceId 方案

如果目标只是把同一 HTTP 请求的日志串起来，不一定要引入完整的链路追踪系统。Spring Boot 3 中可以用 Servlet Filter、SLF4J MDC 和日志格式完成一个轻量方案；如果还需要跨服务拓扑、Span 和采样，再接入 Micrometer Tracing 或 OpenTelemetry。

## 一、请求入口生成 TraceId

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

## 二、让日志打印 TraceId

Logback 可以把 MDC 字段放进日志：

```xml
<pattern>%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level traceId=%X{traceId} %logger - %msg%n</pattern>
```

推荐使用 JSON 日志，让 `traceId` 作为独立字段输出。日志采集系统据此检索时，不需要解析一整段文本。

## 三、线程池中的上下文传递

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

## 四、HTTP 和消息传递

使用 `RestClient`、`WebClient` 或 Feign 调用下游时，应把当前 TraceId 放到 `X-Trace-Id` 请求头；消息队列则把它放进 Header。消费者取出后建立新的 MDC 上下文，并在 finally 中清理。

简单的 TraceId 只能关联日志，不能自动表示父子 Span、跨线程耗时和服务拓扑。对跨服务排障有更高要求时，应使用标准追踪上下文，而不是不断扩展自定义 Header。

## 五、异常处理与日志规范

全局异常处理器向客户端返回 TraceId，便于用户把问题反馈给运维；日志记录完整堆栈和业务错误码，但不要把密码、Token、身份证号等敏感信息写入日志。

```json
{
  "code": "SYSTEM_ERROR",
  "message": "系统繁忙，请稍后重试",
  "traceId": "f3a4..."
}
```

## 六、验证方法

可以使用一个请求调用异步任务和下游服务，确认入口日志、线程池日志和下游日志的 TraceId 一致；再并发发送多个请求，确认不同请求之间没有交叉；最后让异常路径提前返回，确认 MDC 已清理。

## 总结

Spring Boot 3 原生日志 TraceId 方案的核心是 Filter 生成、MDC 保存、线程池传播、下游透传和 finally 清理。它适合轻量日志关联；当需求升级到完整分布式追踪时，应平滑迁移到标准的 Micrometer Tracing 或 OpenTelemetry。
