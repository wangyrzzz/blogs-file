# WebSocket 长连接会话设计

> 阅读范围：RFC 6455 WebSocket 与 Spring Servlet 服务；可靠通知作为应用层协议设计。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


WebSocket 在一次 HTTP 握手后升级为全双工长连接，适合实时通知、在线协作、行情推送和设备状态上报。它解决的是“连接和消息实时性”，并不会自动解决认证、离线消息、集群广播和可靠投递。

## 连接生命周期

```text
握手 -> 鉴权 -> 建立会话 -> 心跳/收发消息 -> 断开 -> 重连或结束
```

握手阶段完成来源校验和身份解析，连接建立后把用户、设备、租户和会话 ID 绑定在服务端上下文中。不要在每条消息里重复信任客户端传来的用户 ID。

## Spring Boot 服务端示例

```java
@Component
public class NotificationHandler extends TextWebSocketHandler {
    private final ConcurrentMap<String, WebSocketSession> sessions = new ConcurrentHashMap<>();

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        sessions.put(session.getId(), session);
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message)
            throws IOException {
        // 校验消息类型、大小和用户权限后再执行业务逻辑
        session.sendMessage(new TextMessage("ack"));
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        sessions.remove(session.getId());
    }
}
```

示例中的内存 Map 只适合单实例或本地演示。生产环境要限制连接数、单条消息大小和发送队列，避免慢客户端阻塞处理线程。

## 心跳和断线重连

客户端和服务端都应设置心跳策略。心跳只证明连接仍然可用，不代表业务消息已经被消费。客户端重连采用指数退避和随机抖动，避免服务端故障恢复时所有客户端同时重连。

重连后需要重新鉴权、重新订阅，并携带最后确认的消息序号。如果业务要求不丢消息，服务端应提供离线补偿接口，而不是只依赖 WebSocket 缓冲。

## 消息可靠性

每条消息建议包含：

```json
{
  "messageId": "m-10001",
  "type": "ORDER_STATUS_CHANGED",
  "version": 12,
  "occurredAt": "2026-09-14T10:00:00Z",
  "data": {}
}
```

客户端确认后，服务端才可以清理需要可靠投递的消息。消费端应根据 `messageId` 或版本号去重，旧版本消息不能覆盖新状态。

## 集群部署

当用户连接分布在多个实例时，实例 A 不能直接向实例 B 上的会话发送消息。常见方案是使用 Redis Pub/Sub、消息队列或专门的 WebSocket 网关做跨实例广播：

```text
业务服务 -> 事件总线 -> 所有 WebSocket 节点
                                  -> 本节点连接
```

广播内容应包含用户或租户路由信息，节点只向本地匹配的会话发送。Redis Pub/Sub 适合实时广播，但不保证离线补偿；需要可靠历史消息时，应使用持久化队列或数据库记录。

## 鉴权与安全

WebSocket 握手要校验 Token、Origin、租户和资源权限。Token 不要通过 URL 长期传递，以免出现在访问日志中；连接建立后要考虑 Token 过期和主动下线。对消息内容做长度、格式和频率限制，禁止把客户端内容直接拼成 SQL、脚本或日志格式。

## 优雅关闭和监控

服务滚动发布时先停止接收新连接，再向旧连接发送关闭通知，给客户端留出重连时间。监控当前连接数、连接建立失败、断开原因、心跳超时、发送队列长度、消息延迟和广播失败。


## 从通知需求推导会话模型

一个用户可能同时登录手机、浏览器和多个标签页，因此 userId 到单个连接的 Map 往往不够。至少需要 sessionId 到本地连接对象，以及用户到多个 sessionId 的反向索引。租户身份应在握手认证后固定到服务端会话，不能允许客户端在后续消息中改写 tenantId 来切换数据范围。

连接对象只能由所在进程直接操作，不能把 WebSocketSession 序列化进 Redis 期望其他节点拿出来发送。跨节点保存的是路由元数据，例如用户在哪个 node、会话代际和过期时间。真实 socket、发送队列和线程资源仍在本节点。WebSocket 的帧与关闭行为由[RFC 6455](https://www.rfc-editor.org/info/rfc6455/)定义，离线补偿与业务 ACK 则需要额外协议。

## 握手认证与浏览器限制

浏览器 WebSocket API 通常不能像普通 fetch 一样自由设置任意 Authorization Header。可以使用安全 Cookie、短期一次性连接票据或连接后受限认证流程，但每种方式有不同约束。Cookie 会自动携带，必须校验 Origin 并考虑跨站 WebSocket 劫持；URL 票据容易进入访问日志，必须短时、一次性且脱敏。不要把长期 Token 直接放入查询字符串。

连接后认证的方案要限制未认证连接的存活时间和数量，在认证完成前不允许订阅业务频道。认证失败就关闭，不能先加入全局用户连接表。Token 在长连接存活期间可能到期，账户也可能被封禁，需要明确定时复核、失效事件通知或最大会话时长。

## 应用协议需要版本与明确 ACK

帧到达浏览器不代表页面已经更新，服务端 send 返回也不等于用户已看到消息。对于可靠通知，至少定义消息 ID、流序号、协议版本、类型和业务时间。ACK 应说明确认到哪个连续序号，而不是只随意回一个字符串。

~~~json
{
  "protocolVersion": 1,
  "type": "ORDER_CHANGED",
  "streamId": "tenant-demo:user-42",
  "sequence": "105",
  "messageId": "evt-105",
  "occurredAt": "2026-09-30T10:00:00Z",
  "data": {"orderId":"order-1","status":"SHIPPED","version":7}
}
~~~

~~~json
{
  "protocolVersion": 1,
  "type": "ACK",
  "streamId": "tenant-demo:user-42",
  "lastContiguousSequence": "105"
}
~~~

序号以字符串表达，避免前端整数精度问题。客户端先收到 105、缺少 104 时不能确认已连续处理到 105，否则恢复时会跳过缺失消息。服务端也不能相信客户端 ACK 任意未来序号，要限制在已授权且已发送范围内。订单状态还可以携带领域 version，防止旧通知覆盖新状态。

## 发送需要串行化与背压

多个业务线程同时向同一个会话发送，可能违反底层会话的并发发送限制。Spring 提供 ConcurrentWebSocketSessionDecorator 这类包装，但它并不是无限可靠消息队列。发送时间和缓冲上限达到后应执行明确策略，慢客户端不能拖垮整个节点。

~~~java
import java.io.IOException;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.*;

public final class BoundedNotificationHandler extends TextWebSocketHandler {
    private final ConcurrentHashMap<String,WebSocketSession> sessions=new ConcurrentHashMap<>();
    @Override
    public void afterConnectionEstablished(WebSocketSession raw) {
        // 握手认证结果应在此之前建立；这里只演示发送边界。
        WebSocketSession bounded=new ConcurrentWebSocketSessionDecorator(
                raw,5000,256*1024);
        sessions.put(raw.getId(),bounded);
    }
    public boolean push(String sessionId,String payload) throws IOException {
        WebSocketSession session=sessions.get(sessionId);
        if (session==null || !session.isOpen()) return false;
        try {
            session.sendMessage(new TextMessage(payload));
            return true; // 仅表示发送调用完成，不代表业务 ACK。
        } catch (IOException | RuntimeException failure) {
            sessions.remove(sessionId,session);
            try { session.close(CloseStatus.SERVER_ERROR); }
            catch (IOException closeFailure) { failure.addSuppressed(closeFailure); }
            throw failure;
        }
    }
    @Override
    public void afterConnectionClosed(WebSocketSession session,CloseStatus status) {
        sessions.remove(session.getId());
    }
}
~~~

以上片段省略注册器、认证和可靠存储，不能直接称为完整生产网关。不同消息类型需要不同背压政策：行情快照可合并成最新值，聊天和订单通知不能无声丢弃，应转由离线补偿；控制命令则可能直接拒绝过载。消息队列按条数限制还不够，一条巨大载荷也可能耗尽内存，需要同时按字节和时间限制。

## 心跳与业务在线不是同一件事

协议 Ping/Pong 检测连接活性，浏览器应用脚本通常不直接控制协议 Ping 帧，可另外定义应用心跳。应用心跳需要防重复计时器：每次重连创建新连接时清理旧定时器，否则一个页面可能同时运行多套重连和心跳逻辑。

代理、负载均衡和 NAT 都有空闲超时，心跳周期需要小于整条路径中允许的空闲时间，并留出抖动余量。太频繁会提高移动端耗电和网络成本，太稀疏则发现断线很慢。页面退到后台后定时器可能被节流，因此服务端不能用严格几秒没收到浏览器定时消息就认定用户行为异常。

## 重连恢复的竞态

常见错误是先拉历史，再订阅实时。在两步之间产生的事件可能既不在历史响应里，也没被实时订阅接住。反过来先订阅再拉历史，会出现重复，但重复可以通过 messageId 和 sequence 去重。也可以由服务端提供一个带水位的统一恢复协议，把历史与实时衔接明确化。

~~~text
客户端记录 lastContiguousSequence=100
  -> 重新鉴权并建立订阅
  -> 服务端确定恢复水位 H=108
  -> 按顺序补发 (100,108]
  -> 缓存恢复期间到达的实时消息
  -> 去重后继续发送 >108 的消息

若 101 已超出保留期:
  -> 返回 RESYNC_REQUIRED
  -> 客户端拉取权威快照与新水位
  -> 从新水位继续，而不是假装全部补齐
~~~

消息保留期和客户端离线时长必须匹配。离线半年后要求补齐全部通知，成本可能高于直接同步当前状态。业务应区分“事件历史不可遗漏”和“页面最终状态正确”，前者需要持久事件存储，后者往往可以用快照加版本恢复。

## 多实例路由和连接迁移

Redis Pub/Sub 可把通知广播到各节点，但断开订阅期间的消息不会自动补发。持久 MQ 提供更强恢复基础，却仍要设计节点路由与用户会话多端扇出。一个消息只由某个消费组中的一个节点收到，未必恰好是持有用户连接的节点；消费组和广播语义不能混用。

用户重连到新节点时，旧节点可能稍后才处理关闭回调。若它无条件删除“用户在线位置”，会把新连接的路由记录一并删掉。路由清理需要比较 sessionId 或 generation，只有记录仍属于自己时才能移除。该竞态与租约持有者条件删除很类似，但这里还要支持同一用户多个合法会话。

## 发布与容量估算

滚动发布先使节点停止接收新连接，再向现有客户端发出可识别关闭并留出恢复时间，最终强制结束剩余会话。readiness 变化主要影响新流量，不会自动迁移已有 socket。应用终止宽限期、负载均衡连接排空时间和客户端退避需要协同。

容量不能只看连接数。每连接协议状态、缓冲、认证信息、心跳任务和业务订阅都占资源。假设十万连接每个额外缓冲 64 KiB，仅缓冲理论上就超过 6 GiB。设置上限并不代表每连接立即分配，但估算峰值时要考虑极端慢客户端同时积压。监控消息延迟、排队字节、ACK 落后水位、断开原因和恢复失败率，比只看“在线人数”更能发现可靠性问题。

## 连续序号与业务版本不要互相替代

会话流序号回答通知顺序和补发位置，订单 version 回答某个订单的状态更新先后。一个用户可能在同一流中收到多张订单的事件，因此不能拿某张订单的 version 当成全流水位。反过来，全流序号更大，也不必然允许覆盖所有业务对象的当前版本，补发和不同事件类型仍可能交错。

客户端可以维护两个状态：lastContiguousSequence 用于恢复流，entityVersionById 用于避免旧实体状态覆盖新值。消息已去重但对应业务对象已被本地更新时，可以推进连续水位而不重复覆盖对象。若需要展示每一个事件历史，则应另存事件列表，不能仅保留最终实体快照。

多端 ACK 也要定义范围。一部手机确认了消息，不代表另一个浏览器已经收到。如果服务端按用户只保存一个 ACK 水位，会影响其他设备恢复。可以按设备保存水位，也可以让每个客户端自己携带水位并由服务端验证。前者更便于管理，后者减少服务端状态，但两者都需要处理水位过期与异常跳跃。

消息压缩可能降低带宽，也可能提高 CPU 和内存负担。大规模连接下应测量典型载荷与峰值积压，不能默认所有小型 JSON 都从压缩获益。连接级安全配置、压缩字典与敏感数据处理也应按照部署环境审查。把连接数、每秒消息数和每条平均字节量同时纳入容量模型，才能比较网络瓶颈与应用处理瓶颈。

## 客户端重连也需要一个状态机

客户端可以显式区分 DISCONNECTED、CONNECTING、AUTHENTICATING、RECOVERING、OPEN 和 CLOSING。网络恢复事件、定时重试和用户主动刷新可能同时触发连接，因此只能有一个当前连接代际。新连接建立后，旧连接迟到的 onclose 不能把整个客户端重新改成断线状态，更不能启动第二套重连定时器。

每次连接创建一个 generation，回调先检查自己是否仍是当前代际。主动退出登录应停止重连并清理认证信息，不能把服务端正常关闭都理解成需要无限重试。认证失败、权限撤销与暂时网络错误属于不同分类，只有后者适合自动退避重连。

~~~text
DISCONNECTED -- retry timer --> CONNECTING
CONNECTING -- handshake accepted --> AUTHENTICATING
AUTHENTICATING -- identity accepted --> RECOVERING
RECOVERING -- snapshot/replay complete --> OPEN
OPEN -- network lost --> DISCONNECTED
OPEN -- user logout --> CLOSING --> DISCONNECTED(no automatic retry)
AUTHENTICATING -- invalid credentials --> DISCONNECTED(wait for user action)

Every callback checks connectionGeneration before mutating shared state.
Every timer belongs to one generation and is cleared when that generation ends.
Business messages are not applied before recovery establishes its watermark.
~~~

页面刷新会丢失内存水位，是否写入浏览器持久存储取决于隐私与多账号切换规则。水位应按租户、用户和设备空间隔离，退出后清理，避免新账号沿用旧账号位置。持久化水位过新或被篡改时，服务端仍要校验，不应允许跳过必须同步的数据。

最终一致的页面往往可以采用“先展示缓存快照，再连接并恢复”的体验，但要标记数据新鲜度，避免用户在旧状态上执行已不允许的操作。任何取消、付款等写动作仍通过权威接口校验，不能因为刚收到一条 WebSocket 状态就放弃服务端条件判断。

无论使用原生 WebSocket、STOMP 还是其他上层封装，都需要弄清订阅确认、业务 ACK、心跳与重连的具体语义。上层协议可以减少实现代码，却不会自动解决应用的水位、数据权限和过期历史问题。验收应观察真实断网、后台休眠与多标签页场景，而不是只在同一局域网连续发送几条消息。

## 故障注入与验收实验

用两个节点与一个可控制网络的客户端验证迁移。测试明确区分 TCP 连通、WebSocket 帧发送、客户端处理和持久 ACK 四个阶段。

### WS-01：多端登录

实验前提是同一用户建立浏览器和手机连接。执行向用户发送一条通知。

通过条件是按产品规则投递所有授权会话而不互相覆盖。这里的判断依据是用户到连接通常是一对多关系。

### WS-02：Origin 校验

实验前提是浏览器自动携带认证 Cookie。执行从未授权来源发起握手。

通过条件是服务端拒绝不受信来源。这里的判断依据是Cookie 自动携带并不意味着握手来自可信页面。

### WS-03：过期会话

实验前提是连接建立后 Token 到期或账号失效。执行继续订阅敏感资源。

通过条件是按策略关闭或重新认证，不能无限保留旧权限。这里的判断依据是长连接生命周期通常超过一次登录检查的有效范围。

### WS-04：并发发送

实验前提是多个线程向同一会话推送。执行使用受控发送包装并施加并发。

通过条件是帧顺序与异常处理符合策略，没有无界缓冲。这里的判断依据是底层 socket 对象不应被任意并发写入。

### WS-05：慢客户端

实验前提是客户端停止读取但保持连接。执行持续发送至队列边界。

通过条件是触发合并、断开或补偿策略，节点内存有上限。这里的判断依据是连接活着不代表消费速度足够。

### WS-06：缺口 ACK

实验前提是客户端收到 103 但没有 102。执行尝试确认连续序号到 103。

通过条件是客户端或服务端检测缺口并要求恢复。这里的判断依据是连续确认代表此前所有序号已经处理。

### WS-07：断线补发

实验前提是客户端最后确认 100，服务端已有后续事件。执行断线后连接另一节点并恢复。

通过条件是缺失事件补齐且重复被去重。这里的判断依据是连接迁移不能依赖旧节点的内存发送队列。

### WS-08：历史实时交接

实验前提是历史读取期间仍有新消息产生。执行按恢复水位衔接实时流。

通过条件是没有落在两步之间的消息被遗漏。这里的判断依据是历史与订阅的竞态需要协议层水位或去重处理。

### WS-09：保留期不足

实验前提是客户端水位早于最旧可用消息。执行发起恢复请求。

通过条件是明确返回需要全量同步的状态。这里的判断依据是无法补齐时不能伪造成功 ACK。

### WS-10：旧节点清理

实验前提是用户新会话已登记在另一节点。执行旧节点延迟执行关闭清理。

通过条件是新路由仍存在且不被旧会话删除。这里的判断依据是路由删除必须核对当前所有权或会话代际。

### WS-11：滚动发布

实验前提是节点持有大量长期连接。执行停止接收新连接并按宽限期关闭。

通过条件是客户端带抖动恢复，业务事件可补偿。这里的判断依据是readiness 不会自动把已建立连接迁移到新节点。

### WS-12：消息越权

实验前提是客户端合法登录但没有订单访问权限。执行在消息中指定其他租户订单。

通过条件是拒绝订阅或操作并记录审计。这里的判断依据是握手认证只证明身份，消息级资源授权仍然必要。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "WebSocket长连接会话",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "WS-01",
      "scenario": "多端登录",
      "given": "同一用户建立浏览器和手机连接",
      "when": "向用户发送一条通知",
      "then": "按产品规则投递所有授权会话而不互相覆盖"
    },
    {
      "id": "WS-02",
      "scenario": "Origin 校验",
      "given": "浏览器自动携带认证 Cookie",
      "when": "从未授权来源发起握手",
      "then": "服务端拒绝不受信来源"
    },
    {
      "id": "WS-03",
      "scenario": "过期会话",
      "given": "连接建立后 Token 到期或账号失效",
      "when": "继续订阅敏感资源",
      "then": "按策略关闭或重新认证，不能无限保留旧权限"
    },
    {
      "id": "WS-04",
      "scenario": "并发发送",
      "given": "多个线程向同一会话推送",
      "when": "使用受控发送包装并施加并发",
      "then": "帧顺序与异常处理符合策略，没有无界缓冲"
    },
    {
      "id": "WS-05",
      "scenario": "慢客户端",
      "given": "客户端停止读取但保持连接",
      "when": "持续发送至队列边界",
      "then": "触发合并、断开或补偿策略，节点内存有上限"
    },
    {
      "id": "WS-06",
      "scenario": "缺口 ACK",
      "given": "客户端收到 103 但没有 102",
      "when": "尝试确认连续序号到 103",
      "then": "客户端或服务端检测缺口并要求恢复"
    },
    {
      "id": "WS-07",
      "scenario": "断线补发",
      "given": "客户端最后确认 100，服务端已有后续事件",
      "when": "断线后连接另一节点并恢复",
      "then": "缺失事件补齐且重复被去重"
    },
    {
      "id": "WS-08",
      "scenario": "历史实时交接",
      "given": "历史读取期间仍有新消息产生",
      "when": "按恢复水位衔接实时流",
      "then": "没有落在两步之间的消息被遗漏"
    },
    {
      "id": "WS-09",
      "scenario": "保留期不足",
      "given": "客户端水位早于最旧可用消息",
      "when": "发起恢复请求",
      "then": "明确返回需要全量同步的状态"
    },
    {
      "id": "WS-10",
      "scenario": "旧节点清理",
      "given": "用户新会话已登记在另一节点",
      "when": "旧节点延迟执行关闭清理",
      "then": "新路由仍存在且不被旧会话删除"
    },
    {
      "id": "WS-11",
      "scenario": "滚动发布",
      "given": "节点持有大量长期连接",
      "when": "停止接收新连接并按宽限期关闭",
      "then": "客户端带抖动恢复，业务事件可补偿"
    },
    {
      "id": "WS-12",
      "scenario": "消息越权",
      "given": "客户端合法登录但没有订单访问权限",
      "when": "在消息中指定其他租户订单",
      "then": "拒绝订阅或操作并记录审计"
    }
  ]
}
```

## 实时通道与可靠状态各司其职

WebSocket 负责低延迟传递，持久消息与快照负责恢复。连接归属、授权、背压和水位协议设计清楚以后，节点重启与网络断开就成为可处理的日常事件，而不再意味着消息无法解释地消失。

## 参考资料与继续阅读

- [RFC 6455 WebSocket](https://www.rfc-editor.org/info/rfc6455/)
- [本地延伸：消息队列](消息队列/消息队列.md)
