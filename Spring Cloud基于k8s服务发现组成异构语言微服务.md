# Spring Cloud 基于 Kubernetes 服务发现，组成异构语言微服务

> 阅读范围：Kubernetes Service/DNS 与 Spring Cloud Kubernetes 两条发现路径；Java 使用 Boot 3.2+ 的 RestClient 示例。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


在 Java、Go、Python、Node.js 等语言共存的系统中，服务发现不应绑定某一种语言框架。Kubernetes 已经提供了 Service、DNS、EndpointSlice 和健康检查能力，可以把它作为异构微服务的共同基础设施；Spring Cloud 只负责 Java 服务侧的调用和配置适配。

## 整体架构

```text
Java order-service  --HTTP/gRPC-->  Go inventory-service
        |                                  |
        +------ Kubernetes Service --------+
                       |
                   Cluster DNS
```

同一命名空间中，服务可以通过 `inventory-service:8080` 访问；跨命名空间可使用 `inventory-service.business.svc.cluster.local`。客户端不应写 Pod IP，因为 Pod 会重建和漂移。

## 定义 Kubernetes Service

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

## 健康检查

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

## Java 服务调用异构服务

Java 服务可以使用 Spring `RestClient` 或 WebClient 调用 Kubernetes DNS：

```java
RestClient client = RestClient.builder()
        .baseUrl("http://inventory-service.business.svc.cluster.local:8080")
        .build();

InventoryResult result = client.get()
        .uri(uriBuilder -> uriBuilder
                .path("/inventory/{sku}")
                .build(sku))
        .retrieve()
        .body(InventoryResult.class);
```

生产环境应增加连接池、超时、重试边界、熔断和 TraceId 透传。写操作必须配合幂等键，不要因为网络超时就盲目重试扣库存等操作。

## 协议和契约

异构服务之间优先采用明确的 OpenAPI 或 protobuf 契约，统一字段命名、时区、金额精度、错误码和空值语义。接口演进遵循向后兼容：新增字段可选，避免随意修改枚举含义和时间格式。

不要把 Java 异常类名、数据库实体或语言特有的序列化细节直接暴露给其他语言。错误响应应包含稳定错误码、可读消息和 TraceId。

## 是否还需要 Eureka 或注册中心

如果服务都运行在同一个 Kubernetes 集群，Service DNS 通常足以满足基础发现需求。引入额外注册中心前，需要说明它带来的路由、灰度、跨集群或治理能力，并明确谁是地址的权威来源。两套注册中心同时变更时，很容易出现“注册成功但调用走错地址”的问题。

跨集群、跨云或集群外客户端可以通过网关、服务网格或专门的服务发现层解决，不应直接暴露内部 Pod 网络。

## 排查服务不可达

按以下顺序定位：

1. Pod 是否 Running，readiness 是否通过；
2. Service selector 是否选中了 Pod，Endpoints 是否存在；
3. 从调用方 Pod 内解析 DNS 并测试 Service 端口；
4. NetworkPolicy、ServiceMesh 和防火墙是否允许流量；
5. 应用是否监听了正确网卡和端口；
6. Ingress 或 Gateway 是否额外修改了路径和 Host。


## 先选择地址来源，再配置客户端

有两条容易混淆的调用路径。第一条使用普通 HTTP 客户端访问 Service DNS，由 Kubernetes 的 Service 网络机制转发到后端；第二条由 Spring Cloud Kubernetes DiscoveryClient 读取 Kubernetes API 中的服务和实例信息，再配合客户端负载均衡选择地址。两者都可以实现异构服务调用，但权限、缓存、路由和排障路径不同。

直接 DNS 调用并不强制需要 Spring Cloud Kubernetes。只有需要 DiscoveryClient 抽象、实例元数据或相应客户端发现功能时，再引入对应模块。官方[DiscoveryClient 文档](https://docs.spring.io/spring-cloud-kubernetes/reference/discovery-client.html)说明了这种 API 发现路径。不要给一个本来只解析 DNS 的服务额外授予集群 API 广泛读取权限。

~~~text
路径 A：Java HTTP Client -> inventory Service DNS -> ClusterIP -> ready Pod
路径 B：DiscoveryClient -> Kubernetes API -> instance addresses
        Java load balancer -> selected Pod address

两条路径共同依赖：接口协议、网络可达、就绪状态与业务超时。
两条路径不同之处：地址缓存、权限、负载均衡位置与故障观察点。
~~~

Service 的 cluster.local 后缀不是所有集群固定不变的常量，跨命名空间完整地址要使用实际集群域。普通 ClusterIP Service 与 headless Service 的 DNS 行为也不同；后者可能返回多个实例地址，客户端需要正确处理解析结果与刷新。Kubernetes 的[Service 概念文档](https://kubernetes.io/docs/concepts/services-networking/service/)是网络对象语义的依据。

## 一个最小 Go 提供者

下面程序只使用 Go 标准库，提供活性、就绪与库存读取接口。库存数据是固定演示值，不是实际扣减系统。真实服务应在依赖初始化完成后设置 ready，并在终止时先撤销就绪再排空请求。

~~~go
package main

import (
    "encoding/json"
    "log"
    "net/http"
    "strings"
    "time"
)

type Inventory struct {
    SKU string `json:"sku"`
    Available int64 `json:"available"`
    Version string `json:"version"`
}

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/live", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
        _, _ = w.Write([]byte("ok"))
    })
    mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)
    })
    mux.HandleFunc("/inventory/", func(w http.ResponseWriter, r *http.Request) {
        if r.Method != http.MethodGet {
            w.WriteHeader(http.StatusMethodNotAllowed)
            return
        }
        sku := strings.TrimPrefix(r.URL.Path, "/inventory/")
        if sku == "" || len(sku) > 64 {
            http.Error(w, "invalid sku", http.StatusBadRequest)
            return
        }
        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(Inventory{sku, 10, "1"})
    })
    server := &http.Server{
        Addr: ":8080", Handler: mux,
        ReadHeaderTimeout: 3 * time.Second,
        WriteTimeout: 5 * time.Second,
    }
    log.Fatal(server.ListenAndServe())
}
~~~

程序监听所有容器网卡的 8080，而不是仅监听 127.0.0.1。容器能在自身 localhost 访问，不代表其他 Pod 能访问。对有写入能力的服务，权限和幂等应由服务端校验，不能因为 URL 带 internal 就默认可信。

## Deployment、Service 与探针必须对应

镜像名在以下 YAML 中是待替换的私有仓库示例。先构建并推送自己的镜像，再使用真实 digest 固定内容。资源数值仅供初始实验，不能当成容量结论。

~~~yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inventory-service
  namespace: business
spec:
  replicas: 2
  selector:
    matchLabels:
      app: inventory-service
  template:
    metadata:
      labels:
        app: inventory-service
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: inventory
          image: registry.example.invalid/demo/inventory:tested-build
          ports:
            - name: http
              containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 64Mi
            limits:
              memory: 256Mi
          startupProbe:
            httpGet: {path: /live, port: http}
            periodSeconds: 2
            failureThreshold: 30
          readinessProbe:
            httpGet: {path: /ready, port: http}
            periodSeconds: 3
          livenessProbe:
            httpGet: {path: /live, port: http}
            periodSeconds: 10
---
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
      targetPort: http
~~~

readiness 决定是否应接收新流量，liveness 决定是否需要重启，startup 给初始化留出时间。把数据库短暂不可用直接放进 liveness，可能让全部实例同时重启，反而失去恢复能力。readiness 也不能无限依赖所有下游，否则某个共享依赖抖动可能把所有调用方都摘除。探针应体现本服务能否提供约定能力。

## 跨语言契约中的精度和空值

金额用整数最小单位或明确的十进制字符串，不用二进制浮点表示结算值。64 位 ID 和版本号在经过 JavaScript 客户端时可能需要字符串。时间采用带时区偏移或 UTC 的标准格式，空字段和缺失字段要分别定义。Go 的零值、Java 的 null 和 JSON 字段缺失不应被默认当作同一个业务状态。

未知枚举值需要可恢复处理。提供者新增一个状态，旧消费者应能保留原值或返回明确兼容错误，而不是因为反序列化失败导致整个列表不可用。错误响应不要泄漏 Java 类名，统一 code、message 与 traceId。契约测试要让旧消费者对新提供者运行，不能只测试两个同时升级的版本。

## 连接复用会影响实际负载分布

Service 的转发不保证每个业务请求都重新均匀分配。HTTP keep-alive 与 HTTP/2 多路复用可能让同一长连接持续落到一个实例。两个副本 CPU 不均衡，不一定是 selector 错误，也可能是连接级分配。需要结合连接数、每连接并发和流量来源分析，再决定连接池配置、客户端发现或网格策略。

调用超时至少包含连接建立、读取和整个业务请求预算。重试只在明确可重试条件下进行，写操作必须有幂等键。同一次请求若网关、Java 客户端和服务网格都重试，尝试次数会乘法放大。治理责任应明确落到少数层，并保留实际 attempt 指标。

## 按证据定位服务不可达

下面是只读排查命令，命名空间和 selector 按实际环境替换。进入调用 Pod 后使用其已有工具验证 DNS 与 HTTP，避免在生产容器里临时安装整套调试软件。

~~~bash
kubectl -n business get pods -l app=inventory-service -o wide
kubectl -n business get service inventory-service -o yaml
kubectl -n business get endpointslice   -l kubernetes.io/service-name=inventory-service -o yaml
kubectl -n business describe pod inventory-service-demo
kubectl -n business logs deployment/inventory-service --tail=100
kubectl -n business get networkpolicy
~~~

先判断没有地址、地址错误还是地址不可达。EndpointSlice 空时检查 selector 和就绪；DNS 正确但连接超时时检查网络策略、CNI 与端口；连接成功但 404 时检查路径和网关改写；5xx 时进入应用依赖和线程池。为所有错误统一增加超时时间，会把不同层问题隐藏得更深。

NetworkPolicy 是否执行取决于集群网络实现，DNS egress 也可能需要单独允许。API 发现路径则需要 ServiceAccount 的最小 list/watch 权限，命名空间范围要受限。两类授权都不替代业务资源授权。跨集群调用应通过明确入口和身份验证，不应把内部 Pod 地址当成稳定对外契约。

## 滚动发布需要服务发现和应用共同排空

服务发现正确，并不保证更新镜像时没有短暂错误。Pod 开始终止后，EndpointSlice、各节点转发规则、网关连接池和客户端缓存观察到变化的时间并不完全相同。已有长连接也不会因为一次就绪状态变化就立即完成全部业务。需要把“不再接收新请求”和“让已接受请求结束”分开处理，由基础设施传播终止状态，应用配合执行排空。

Kubernetes 的终止流程中，`preStop` 钩子会消耗终止宽限期，随后进程收到终止信号；终止中的 EndpointSlice 地址通常通过 `terminating`、`ready` 等条件表达状态。不能简单理解成发出删除命令后所有消费者立刻得到空地址，也不能把固定等待几秒当作绝对可靠的同步协议。[Kubernetes Pod 终止流程](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)

前面的最小 Go 程序尚未实现完整排空。真实实现应让 `/ready` 读取受并发保护的运行状态，接收终止信号后先进入停止接单状态，再使用 `http.Server.Shutdown` 等机制等待正在执行的请求。超过应用内部截止时间后如何关闭剩余连接也要明确。Java 提供者同样需要验证所用 Boot 版本的优雅停机配置，并确保容器中的实际主进程能够收到信号；镜像入口脚本吞掉信号时，YAML 中再长的宽限期也不能补上应用缺失的行为。

可以从请求预算反推排空配置。假定接口约定最多处理八秒，应用给已接受请求十秒完成窗口，容器宽限期就还需要容纳钩子、信号传播和日志收尾时间。具体数字应由业务延迟与部署环境测量决定。这不是要求所有请求都等待到最大时限，而是避免容器先被强杀，应用才准备提交最后一笔状态。

验收时持续发送带唯一业务请求号的流量，同时滚动替换提供者，统计入口接受数、明确完成数、明确失败数和结果未知数。对只读请求可以观察连接重建是否平滑，对扣库存等写请求则必须查询真实业务结果，再由同一幂等键决定能否重试。仅看发布后两个 Pod 都是 Ready，会漏掉发布过程中的短暂丢失；仅看 HTTP 错误率，又无法区分明确未执行与已经执行但响应丢失。

## 故障注入与验收实验

先让 Java 直接访问 Service DNS，再决定是否增加 DiscoveryClient。对 selector、端口、探针和策略逐个注入错误，保留每层观察而不是一次修改全部 YAML。

### K8S-01：正常异构调用

实验前提是Go 服务有两个 ready 副本且 Service 标签匹配。执行Java 通过服务名查询库存。

通过条件是按契约解析 SKU、整数库存和字符串版本。这里的判断依据是跨语言互通依赖协议契约而非共同使用某个 Java 框架。

### K8S-02：selector 错配

实验前提是Service 存在但 selector 不匹配 Pod。执行检查 EndpointSlice 并发起调用。

通过条件是发现没有可用后端而非误判 DNS 失败。这里的判断依据是服务对象创建成功与后端选择成功是两件事。

### K8S-03：端口错配

实验前提是应用只监听 8080，targetPort 指向其他端口。执行比较 Pod 直连与 Service 访问。

通过条件是定位转发端口配置错误。这里的判断依据是容器声明端口不替应用真正打开监听 socket。

### K8S-04：就绪摘除

实验前提是一个实例仍 Running 但 readiness 失败。执行观察 EndpointSlice 与新请求流量。

通过条件是新流量不按正常就绪路径分配给失败实例。这里的判断依据是Running 是进程状态，不等价于可接业务流量。

### K8S-05：启动保护

实验前提是初始化时间超过普通活性周期。执行比较有无 startupProbe。

通过条件是慢启动在允许窗口内不被反复重启。这里的判断依据是startup 与 liveness 的职责应分离。

### K8S-06：网络策略

实验前提是调用方 DNS 可解析但 egress 被限制。执行逐层检查 DNS 与业务端口许可。

通过条件是定位策略拒绝并只放行所需路径。这里的判断依据是服务发现成功不能证明数据网络连通。

### K8S-07：API 权限

实验前提是使用 DiscoveryClient 的 ServiceAccount 权限不足。执行读取发现日志并检查授权。

通过条件是识别 API list/watch 失败而非增加全局管理员权限。这里的判断依据是API 发现需要受限权限，普通 DNS 路径则不必相同授权。

### K8S-08：连接偏斜

实验前提是客户端复用少量长期连接。执行比较各提供者连接数与请求数。

通过条件是解释不均衡与连接复用的关系。这里的判断依据是Service 负载分配不保证逐请求完美轮询。

### K8S-09：新枚举兼容

实验前提是新提供者返回旧客户端未知状态。执行跨版本契约测试。

通过条件是客户端按约定降级或明确拒绝而非隐式误判。这里的判断依据是接口演进要覆盖异构语言的反序列化差异。

### K8S-10：超时重试预算

实验前提是网关和客户端均可能重试。执行让提供者延迟超过下游预算。

通过条件是总尝试数和耗时仍受上游预算限制。这里的判断依据是多层独立重试容易形成乘法放大。

### K8S-11：滚动升级

实验前提是新旧提供者同时服务。执行发布兼容字段并观察就绪和终止过程。

通过条件是旧客户端仍工作且请求不会全部同时中断。这里的判断依据是部署兼容窗口需要协议与探针共同配合。

### K8S-12：跨租户输入

实验前提是客户端可构造任意 tenant 参数。执行携带未授权租户查询请求。

通过条件是提供者按认证上下文拒绝。这里的判断依据是内部网络和服务发现不能替代业务权限判断。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "Spring Cloud基于k8s服务发现组成异构语言微服务",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "K8S-01",
      "scenario": "正常异构调用",
      "given": "Go 服务有两个 ready 副本且 Service 标签匹配",
      "when": "Java 通过服务名查询库存",
      "then": "按契约解析 SKU、整数库存和字符串版本"
    },
    {
      "id": "K8S-02",
      "scenario": "selector 错配",
      "given": "Service 存在但 selector 不匹配 Pod",
      "when": "检查 EndpointSlice 并发起调用",
      "then": "发现没有可用后端而非误判 DNS 失败"
    },
    {
      "id": "K8S-03",
      "scenario": "端口错配",
      "given": "应用只监听 8080，targetPort 指向其他端口",
      "when": "比较 Pod 直连与 Service 访问",
      "then": "定位转发端口配置错误"
    },
    {
      "id": "K8S-04",
      "scenario": "就绪摘除",
      "given": "一个实例仍 Running 但 readiness 失败",
      "when": "观察 EndpointSlice 与新请求流量",
      "then": "新流量不按正常就绪路径分配给失败实例"
    },
    {
      "id": "K8S-05",
      "scenario": "启动保护",
      "given": "初始化时间超过普通活性周期",
      "when": "比较有无 startupProbe",
      "then": "慢启动在允许窗口内不被反复重启"
    },
    {
      "id": "K8S-06",
      "scenario": "网络策略",
      "given": "调用方 DNS 可解析但 egress 被限制",
      "when": "逐层检查 DNS 与业务端口许可",
      "then": "定位策略拒绝并只放行所需路径"
    },
    {
      "id": "K8S-07",
      "scenario": "API 权限",
      "given": "使用 DiscoveryClient 的 ServiceAccount 权限不足",
      "when": "读取发现日志并检查授权",
      "then": "识别 API list/watch 失败而非增加全局管理员权限"
    },
    {
      "id": "K8S-08",
      "scenario": "连接偏斜",
      "given": "客户端复用少量长期连接",
      "when": "比较各提供者连接数与请求数",
      "then": "解释不均衡与连接复用的关系"
    },
    {
      "id": "K8S-09",
      "scenario": "新枚举兼容",
      "given": "新提供者返回旧客户端未知状态",
      "when": "执行跨版本契约测试",
      "then": "客户端按约定降级或明确拒绝而非隐式误判"
    },
    {
      "id": "K8S-10",
      "scenario": "超时重试预算",
      "given": "网关和客户端均可能重试",
      "when": "让提供者延迟超过下游预算",
      "then": "总尝试数和耗时仍受上游预算限制"
    },
    {
      "id": "K8S-11",
      "scenario": "滚动升级",
      "given": "新旧提供者同时服务",
      "when": "发布兼容字段并观察就绪和终止过程",
      "then": "旧客户端仍工作且请求不会全部同时中断"
    },
    {
      "id": "K8S-12",
      "scenario": "跨租户输入",
      "given": "客户端可构造任意 tenant 参数",
      "when": "携带未授权租户查询请求",
      "then": "提供者按认证上下文拒绝"
    }
  ]
}
```

## 共同基础设施与语言边界

Kubernetes 提供稳定名称和运行实例信息，Spring Cloud 可以提供 Java 侧抽象，真正跨语言的是协议和数据契约。先把这三个层次分开，再决定哪里做负载均衡、认证与重试，系统会更容易部署和排查。

## 参考资料与继续阅读

- [Kubernetes Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- [Spring Cloud Kubernetes DiscoveryClient](https://docs.spring.io/spring-cloud-kubernetes/reference/discovery-client.html)
- [本地延伸：Dubbo 3](Dubbo3探索.md)
