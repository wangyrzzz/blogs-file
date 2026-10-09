# Spring Cloud 基于 Kubernetes 服务发现，组成异构语言微服务

在 Java、Go、Python、Node.js 等语言共存的系统中，服务发现不应绑定某一种语言框架。Kubernetes 已经提供了 Service、DNS、EndpointSlice 和健康检查能力，可以把它作为异构微服务的共同基础设施；Spring Cloud 只负责 Java 服务侧的调用和配置适配。

## 一、整体架构

```text
Java order-service  --HTTP/gRPC-->  Go inventory-service
        |                                  |
        +------ Kubernetes Service --------+
                       |
                   Cluster DNS
```

同一命名空间中，服务可以通过 `inventory-service:8080` 访问；跨命名空间可使用 `inventory-service.business.svc.cluster.local`。客户端不应写 Pod IP，因为 Pod 会重建和漂移。

## 二、定义 Kubernetes Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: inventory-service
  namespace: business
spec:
  selector:
    app: inventory-service
  ports:
    - name: http
      port: 8080
      targetPort: 8080
```

`selector` 必须与 Deployment Pod 的标签匹配，`targetPort` 必须对应容器实际监听端口。Service 存在不等于后端可用，还要检查 Endpoints、readinessProbe 和网络策略。

## 三、健康检查

readiness 表示实例是否可以接收流量，liveness 表示进程是否需要重启。启动较慢的服务应配置 `startupProbe`，避免应用还在初始化时被误杀：

```yaml
readinessProbe:
  httpGet:
    path: /actuator/health/readiness
    port: 8080
  periodSeconds: 5
startupProbe:
  httpGet:
    path: /actuator/health
    port: 8080
  failureThreshold: 30
  periodSeconds: 5
```

探针访问的端口、管理端口和业务端口必须与容器、Service、Ingress 的实际路由保持一致。只看 YAML 配置不能证明运行时访问成功，应从 Pod 内部、Service 和网关分别验证。

## 四、Java 服务调用异构服务

Java 服务可以使用 Spring `RestClient` 或 WebClient 调用 Kubernetes DNS：

```java
RestClient client = RestClient.builder()
        .baseUrl("http://inventory-service.business.svc.cluster.local:8080")
        .build();

InventoryResult result = client.get()
        .uri(uriBuilder -> uriBuilder
                .path("/internal/inventory/{sku}")
                .build(sku))
        .retrieve()
        .body(InventoryResult.class);
```

生产环境应增加连接池、超时、重试边界、熔断和 TraceId 透传。写操作必须配合幂等键，不要因为网络超时就盲目重试扣库存等操作。

## 五、协议和契约

异构服务之间优先采用明确的 OpenAPI 或 protobuf 契约，统一字段命名、时区、金额精度、错误码和空值语义。接口演进遵循向后兼容：新增字段可选，避免随意修改枚举含义和时间格式。

不要把 Java 异常类名、数据库实体或语言特有的序列化细节直接暴露给其他语言。错误响应应包含稳定错误码、可读消息和 TraceId。

## 六、是否还需要 Eureka 或注册中心

如果服务都运行在同一个 Kubernetes 集群，Service DNS 通常足以满足基础发现需求。引入额外注册中心前，需要说明它带来的路由、灰度、跨集群或治理能力，并明确谁是地址的权威来源。两套注册中心同时变更时，很容易出现“注册成功但调用走错地址”的问题。

跨集群、跨云或集群外客户端可以通过网关、服务网格或专门的服务发现层解决，不应直接暴露内部 Pod 网络。

## 七、排查服务不可达

按以下顺序定位：

1. Pod 是否 Running，readiness 是否通过；
2. Service selector 是否选中了 Pod，Endpoints 是否存在；
3. 从调用方 Pod 内解析 DNS 并测试 Service 端口；
4. NetworkPolicy、ServiceMesh 和防火墙是否允许流量；
5. 应用是否监听了正确网卡和端口；
6. Ingress 或 Gateway 是否额外修改了路径和 Host。

## 总结

Kubernetes Service 和 DNS 可以成为异构微服务共同的服务发现基础。Java 服务只需面向稳定的服务名和契约编程，再补上超时、幂等、健康检查和可观测性，就能避免把整套系统绑在某一个语言框架上。
