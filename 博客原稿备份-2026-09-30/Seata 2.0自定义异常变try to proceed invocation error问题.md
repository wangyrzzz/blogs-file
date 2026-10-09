# Seata 2.0 自定义异常变成 `try to proceed invocation error` 的排查与处理

在部分 Spring Cloud 与 Seata 2.0 的组合中，`@GlobalTransactional` 方法抛出业务自定义异常后，调用方看到的可能不是原始异常，而是：

```text
java.lang.RuntimeException: try to proceed invocation error
    at io.seata.spring.annotation.AdapterInvocationWrapper.proceed(...)
```

这会影响统一异常处理器返回业务提示，也容易让排查者误以为业务代码没有抛出正确异常。处理这类问题时，第一步不是直接改异常类型，而是确认原始异常是否仍存在于 `cause` 链中，以及当前依赖组合是否命中了已知缺陷。

## 一、最小重现场景

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

## 二、为什么会丢失业务提示

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

## 三、排查步骤

### 1. 确认版本矩阵

记录 Spring Boot、Spring Cloud、Spring Cloud Alibaba、Seata 客户端和 Server 的完整版本。不要只写“用了 Seata 2.0”，因为 Spring 代理、JDK、事务模式和依赖传递都会影响实际行为。

### 2. 确认异常发生位置

让业务方法在事务入口内直接抛出一个确定的自定义异常，再逐层观察：业务方法、Seata 拦截器、Controller 全局异常处理器。若不经过 Seata 时异常正常，经过 `@GlobalTransactional` 后才被包装，问题范围就集中在事务拦截链。

### 3. 检查统一异常处理器

处理器应优先判断业务异常和 cause 链，不能因为顶层类型是 `RuntimeException` 就直接返回系统错误。解包逻辑要有深度上限，避免异常链异常造成循环或过度遍历。

### 4. 检查回滚结果

异常提示恢复并不代表分布式事务一定正确。需要同时查看 Seata Server 日志、分支事务状态、数据库回滚结果和重试记录，确认“提示正确”和“数据回滚成功”分别成立。

## 四、处理策略

### 优先升级到包含修复的兼容版本

先查当前 Seata 版本的发布说明和相关 Issue，确认是否已经有针对异常包装的修复，并用完整版本组合做回归。升级时客户端和 Server 的兼容性、代理模式、事务表结构和回滚日志都要验证。

### 暂时解包 Cause

如果原始业务异常仍然存在，可以在统一异常处理层提取业务异常并返回稳定错误码：

```java
@ExceptionHandler(Throwable.class)
public ResponseEntity<ApiError> handle(Throwable ex) {
    BusinessException business = findCause(ex, BusinessException.class);
    if (business != null) {
        return ResponseEntity.badRequest()
                .body(new ApiError(business.getCode()));
    }
    log.error("unexpected error", ex);
    return ResponseEntity.internalServerError()
            .body(new ApiError("system.error"));
}
```

这只是展示层补救，不能修复拦截器已经丢失原始异常的情况，也不能把任意底层异常伪装成业务异常。

### 评估版本回退

如果升级暂时不可行，可以在隔离环境验证兼容的旧版本。回退前要确认 Spring Cloud 依赖、事务模式、数据库表结构和客户端协议都支持，不能只把一个 Seata 依赖改成旧版本。旧版本可能包含其他安全或稳定性问题，应设置明确的升级计划。

## 五、不要这样处理

- 统一把所有 `RuntimeException` 的消息改成业务提示；
- 丢弃完整 cause 和回滚日志；
- 为了保留异常文本而关闭全局事务；
- 只验证接口返回，不验证分支事务是否真的回滚；
- 直接复制网上针对另一套版本的拦截器源码。

## 总结

`try to proceed invocation error` 是异常包装链的现象，排查重点是版本矩阵、cause 链、统一异常处理器和真实回滚结果。优先升级到兼容修复版本；若原始异常仍在 cause 中，可以在边界层安全解包；如果原始信息已经丢失，则需要针对具体依赖版本处理，而不能只修改业务异常类。
