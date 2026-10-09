const {writeArticle}=require('./compose.cjs');
const articles=[{
file:'Spring Cloud基于k8s服务发现组成异构语言微服务.md',scope:'Kubernetes Service/DNS 与 Spring Cloud Kubernetes 两条发现路径；Java 使用 Boot 3.2+ 的 RestClient 示例',
body:`## 先选择地址来源，再配置客户端

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
    SKU string \`json:"sku"\`
    Available int64 \`json:"available"\`
    Version string \`json:"version"\`
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
kubectl -n business get endpointslice \
  -l kubernetes.io/service-name=inventory-service -o yaml
kubectl -n business describe pod inventory-service-demo
kubectl -n business logs deployment/inventory-service --tail=100
kubectl -n business get networkpolicy
~~~

先判断没有地址、地址错误还是地址不可达。EndpointSlice 空时检查 selector 和就绪；DNS 正确但连接超时时检查网络策略、CNI 与端口；连接成功但 404 时检查路径和网关改写；5xx 时进入应用依赖和线程池。为所有错误统一增加超时时间，会把不同层问题隐藏得更深。

NetworkPolicy 是否执行取决于集群网络实现，DNS egress 也可能需要单独允许。API 发现路径则需要 ServiceAccount 的最小 list/watch 权限，命名空间范围要受限。两类授权都不替代业务资源授权。跨集群调用应通过明确入口和身份验证，不应把内部 Pod 地址当成稳定对外契约。`,
lab:'先让 Java 直接访问 Service DNS，再决定是否增加 DiscoveryClient。对 selector、端口、探针和策略逐个注入错误，保留每层观察而不是一次修改全部 YAML。',
cases:[
['K8S-01','正常异构调用','Go 服务有两个 ready 副本且 Service 标签匹配','Java 通过服务名查询库存','按契约解析 SKU、整数库存和字符串版本','跨语言互通依赖协议契约而非共同使用某个 Java 框架'],
['K8S-02','selector 错配','Service 存在但 selector 不匹配 Pod','检查 EndpointSlice 并发起调用','发现没有可用后端而非误判 DNS 失败','服务对象创建成功与后端选择成功是两件事'],
['K8S-03','端口错配','应用只监听 8080，targetPort 指向其他端口','比较 Pod 直连与 Service 访问','定位转发端口配置错误','容器声明端口不替应用真正打开监听 socket'],
['K8S-04','就绪摘除','一个实例仍 Running 但 readiness 失败','观察 EndpointSlice 与新请求流量','新流量不按正常就绪路径分配给失败实例','Running 是进程状态，不等价于可接业务流量'],
['K8S-05','启动保护','初始化时间超过普通活性周期','比较有无 startupProbe','慢启动在允许窗口内不被反复重启','startup 与 liveness 的职责应分离'],
['K8S-06','网络策略','调用方 DNS 可解析但 egress 被限制','逐层检查 DNS 与业务端口许可','定位策略拒绝并只放行所需路径','服务发现成功不能证明数据网络连通'],
['K8S-07','API 权限','使用 DiscoveryClient 的 ServiceAccount 权限不足','读取发现日志并检查授权','识别 API list/watch 失败而非增加全局管理员权限','API 发现需要受限权限，普通 DNS 路径则不必相同授权'],
['K8S-08','连接偏斜','客户端复用少量长期连接','比较各提供者连接数与请求数','解释不均衡与连接复用的关系','Service 负载分配不保证逐请求完美轮询'],
['K8S-09','新枚举兼容','新提供者返回旧客户端未知状态','执行跨版本契约测试','客户端按约定降级或明确拒绝而非隐式误判','接口演进要覆盖异构语言的反序列化差异'],
['K8S-10','超时重试预算','网关和客户端均可能重试','让提供者延迟超过下游预算','总尝试数和耗时仍受上游预算限制','多层独立重试容易形成乘法放大'],
['K8S-11','滚动升级','新旧提供者同时服务','发布兼容字段并观察就绪和终止过程','旧客户端仍工作且请求不会全部同时中断','部署兼容窗口需要协议与探针共同配合'],
['K8S-12','跨租户输入','客户端可构造任意 tenant 参数','携带未授权租户查询请求','提供者按认证上下文拒绝','内部网络和服务发现不能替代业务权限判断']
],end:'## 共同基础设施与语言边界\n\nKubernetes 提供稳定名称和运行实例信息，Spring Cloud 可以提供 Java 侧抽象，真正跨语言的是协议和数据契约。先把这三个层次分开，再决定哪里做负载均衡、认证与重试，系统会更容易部署和排查。',refs:[['Kubernetes Service','https://kubernetes.io/docs/concepts/services-networking/service/'],['Spring Cloud Kubernetes DiscoveryClient','https://docs.spring.io/spring-cloud-kubernetes/reference/discovery-client.html'],['本地延伸：Dubbo 3','Dubbo3探索.md']]},
{
file:'Dubbo3探索.md',scope:'Dubbo 3 的 RPC 契约与治理；Triple 跨语言示例采用 IDL 思路，具体配置按所选版本核实',
body:`## 远程方法调用最重要的区别是结果可能未知

本地方法抛异常通常可以沿同一进程调用栈理解，远程调用超时却可能发生在服务端提交之后。消费者看到失败，并不等于提供者没有执行。网络中断、响应丢失和序列化失败都可能让业务结果处于不确定状态。创建订单接口必须提供幂等键与结果查询，不能把 timeout 一律转换为“订单未创建”。

注册中心是控制面，业务调用是数据面。控制面短时不可达时，客户端可能继续使用缓存地址；但实例变化无法及时同步，持续时间越长风险越高。注册成功也不证明消费者能访问提供者注册地址，容器把不可路由网卡地址注册出去就是典型问题。

## 从代理到提供者的完整路径

可以把调用拆成代理封装、路由筛选、集群容错、负载均衡、连接与编解码、提供者线程调度、业务执行、结果返回。不同版本具体类名和顺序会调整，排查应围绕可观察阶段，而不是依赖一份旧源码行号。Dubbo 官方的[协议说明](https://dubbo.apache.org/en/overview/what/core-features/protocols/)可用于确认协议能力与选型入口。

~~~text
业务线程
  -> 接口代理：参数变成调用描述
  -> 路由：按服务、版本、分组、标签筛选候选
  -> 集群策略：决定失败后是否再次尝试
  -> 负载均衡：选择一个候选实例
  -> 传输与序列化
  -> 提供者接收与排队
  -> 业务方法与数据库事务
  -> 编码结果、返回响应

观察点：候选数、目标地址、attempt、排队耗时、业务耗时、结果码。
~~~

线程池排队也是超时的一部分。若业务执行只需要 20 毫秒，却在队列里等了 900 毫秒，单纯优化 SQL 并不能解决主要延迟。超时后服务端也未必自动取消已经开始的数据库动作，应区分取消请求、线程中断与实际业务终止。

## Java 接口与跨语言 IDL

Java-only 服务可以共享接口与 DTO 包，但应避免将 JPA/MyBatis 实体、懒加载对象或任意 Throwable 暴露为远程契约。共享包应尽量稳定而小，不能顺带把提供者实现、数据库驱动和大量内部依赖传给消费者。

跨语言调用应明确使用双方可理解的 IDL、编码和错误模型。Triple 可以支持面向 gRPC 生态的互通，但 Java 接口方式与 protobuf IDL 方式不能无条件混为一谈。下面 proto 展示创建与查询订单的契约，服务端代码生成和 Dubbo 集成按选定版本执行。

~~~proto
syntax = "proto3";
package example.order.v1;
option java_multiple_files = true;
option java_package = "example.order.v1";

service OrderService {
  rpc CreateOrder(CreateOrderRequest) returns (CreateOrderResponse);
  rpc GetOrder(GetOrderRequest) returns (GetOrderResponse);
}
message CreateOrderRequest {
  string tenant_id = 1;
  string idempotency_key = 2;
  string sku = 3;
  int32 quantity = 4;
  int64 expected_price_cents = 5;
}
message CreateOrderResponse {
  string order_id = 1;
  string status = 2;
  BusinessError error = 3;
}
message GetOrderRequest {
  string tenant_id = 1;
  string order_id = 2;
}
message GetOrderResponse {
  string order_id = 1;
  string status = 2;
  int64 total_cents = 3;
  BusinessError error = 4;
}
message BusinessError {
  string code = 1;
  string message = 2;
  string correlation_id = 3;
}
~~~

这个契约中的 tenant_id 是业务参数，不是可信身份。提供者必须与认证上下文核对，防止用户直接指定其他租户。expected_price_cents 表示调用方预期，而最终价格由服务端校验。字段编号发布后不要复用，删除字段应保留编号约束；枚举新增值、默认零值和字段 presence 都要在各语言客户端测试。

## 幂等键应该绑定请求内容

单独保存“这个 key 出现过”不够：同一 key 如果对应不同 SKU 或数量，应返回冲突而不是误把第一笔结果当成第二笔。可以保存规范化请求摘要、状态和最终结果，在同一权威事务里建立唯一记录。处理中重复请求可以等待有限时间或返回可查询状态，不能并发重复执行业务。

~~~sql
CREATE TABLE rpc_request_dedup (
  tenant_id VARCHAR(64) NOT NULL,
  request_key VARCHAR(128) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL,
  order_id VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL,
  PRIMARY KEY (tenant_id, request_key)
);
~~~

去重记录的保留时间应覆盖客户端允许的重试窗口。过早删除会让旧请求重新创建订单，永久保留又有存储和隐私成本。生成哈希时字段顺序、数字规范和缺省值要固定，不能直接依赖任意 JSON 字符串序列化顺序。

## 超时预算与重试放大

上游总预算两秒，不能给三个串行下游各两秒。预算应扣除已消耗时间、排队和响应处理余量。重试之前重新计算剩余时间，只有还能完成一次有意义尝试才继续。设置 retries 时也要核对它表示附加重试次数还是总尝试次数，不能凭名字猜测。

假设三层每层最多尝试三次，最深层在最坏情况下可能收到二十七次调用。这个计算是理论放大上界，不是所有请求必然发生的结果，但足以说明需要统一策略。读请求也不一定安全：查询接口若有审计扣费或隐式状态改变，同样要按实际副作用判断。

~~~text
入口预算：2000 ms
接收与业务校验：预留 100 ms
库存调用：最多 700 ms，含一次受控重试
订单持久化：预留 600 ms
返回与余量：预留 300 ms
未分配缓冲：300 ms

这些是示例预算；用真实 P99 与故障恢复时间重新分配。
~~~

Failover 适合某些可重试调用，Failfast 适合及时暴露单次失败；其他策略也各有语义，不应仅为了“成功率更高”切换容错模式。默认重试若作用于没有幂等保护的写接口，可能把一个网络故障转变为重复订单。

## 灰度不是随机挑一个新实例

稳定灰度可按租户或用户哈希选择版本，使同一业务流程在兼容窗口内保持一致。版本、分组和标签分别承担什么含义，应团队统一，避免有人把环境放进 version、有人放进 group，最后订阅不到地址。必须存在无灰度标签时的清楚回退规则，而不是没有候选就静默落到任意环境。

提供者滚动下线时应先撤销可用状态，等待地址传播并排空请求，再关闭进程。注册缓存和长连接会延迟流量完全停止，所以单纯删除注册记录不是瞬间切断一切调用。对于长时间请求，终止宽限期和客户端预算要匹配。

## 注册发现与 Kubernetes 的组合

可以让 Dubbo 使用自己的注册发现体系，也可以在明确支持的场景下通过 Kubernetes 服务名与协议端口连接。Service DNS 通常给的是服务虚拟地址，不等价于注册中心提供的接口级元数据、版本与标签。若同时启用多个来源，要明确优先级和治理归属，否则排错会出现配置改了但调用仍走旧地址。

负载均衡也不总等于请求均匀：长连接、权重、预热和慢实例都会影响分布。不要只看各实例 QPS 是否完全一样，应该看单位资源压力和尾延迟。一个实例业务耗时升高时，重试可能把压力扩散到所有实例，需要结合并发限制、熔断和隔离。

日志应记录服务、方法、目标、版本、attempt、耗时和稳定错误码，避免默认打印完整敏感 DTO。链路追踪可以区分客户端等待和提供者业务耗时，指标可以揭示持续趋势，日志提供具体失败上下文。三者互补，单条异常堆栈很难解释整个调用路径。`,
lab:'使用一个消费者和两个提供者，固定接口与数据，逐个注入超时、地址错误和版本不兼容。对写接口同时记录幂等表和业务表，避免只看消费者返回结果。',
cases:[
['RPC-01','正常双提供者','两实例暴露相同服务契约','连续调用并记录目标地址与耗时','结果一致且能解释实际路由分布','框架代理之外仍有明确的远程地址与传输路径'],
['RPC-02','注册地址不可达','提供者注册了消费者无法访问的地址','检查注册元数据并从消费网络测试端口','定位数据通路失败而非误判未注册','控制面可见不保证业务端口可达'],
['RPC-03','响应丢失','提供者已经提交订单','丢弃返回响应后重试同一幂等键','返回原订单而不重复创建','超时表示调用方不知道结果，不代表服务端没有执行'],
['RPC-04','幂等键冲突','某 key 已对应一份 SKU 和数量','使用相同 key 提交不同请求体','明确返回冲突而不是复用错误结果','幂等身份必须绑定规范化请求内容'],
['RPC-05','队列超时','提供者业务线程池排队严重','比较排队与业务执行时间','识别主要等待位置并限制并发','方法执行快不等于整个 RPC 快'],
['RPC-06','多层重试','网关和消费者都允许多次尝试','令最深依赖持续超时','记录总尝试数并按统一预算收敛','每层局部合理的重试可组合成整体流量放大'],
['RPC-07','旧客户端新字段','提供者新增兼容可选字段','由未升级消费者调用','保持旧客户端可用且未知字段按编码规则处理','兼容性要通过跨版本组合测试证明'],
['RPC-08','未知枚举','新增状态值进入响应','让旧语言客户端解析','明确降级或兼容错误，不把未知状态当默认成功','各语言代码生成对未知值的处理可能不同'],
['RPC-09','灰度稳定性','路由按租户标签选择版本','同一租户多次请求及跨服务调用','保持约定灰度范围且不越过环境边界','灰度需要稳定分桶和标签传播契约'],
['RPC-10','提供者下线','实例有正在执行的请求','按注册撤销、排空、关闭顺序停止','已有请求有处理窗口，新流量逐步停止','注册传播和连接生命周期使下线不是瞬时动作'],
['RPC-11','发现源冲突','同时配置注册中心与 Service DNS','逐项检查实际选中地址','能指出唯一权威来源或清楚优先级','两套地址系统不应互相覆盖而没有可观测解释'],
['RPC-12','跨租户伪造','DTO 带调用方可控 tenant_id','提交与身份不匹配的租户值','提供者拒绝并记录权限事件','跨语言契约里的字段不自动成为可信身份声明']
],end:'## 把远程边界放回设计中心\n\nDubbo 3 提供调用和治理机制，业务仍要定义结果不确定时如何查询、重试怎样幂等、契约怎样演进。先把这些问题讲清楚，再调整协议、注册中心和负载均衡，配置才有可验证的依据。',refs:[['Dubbo 协议说明','https://dubbo.apache.org/en/overview/what/core-features/protocols/'],['本地延伸：Kubernetes 异构服务','Spring%20Cloud基于k8s服务发现组成异构语言微服务.md']]}
];
for(const a of articles)console.log(writeArticle(a));
