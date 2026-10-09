const {writeArticle}=require('./compose.cjs');
const articles=[{
file:'MQTT协议探索.md',scope:'MQTT 5.0，并与 3.1.1 的会话选项区分；命令行实验使用支持 MQTT 5 的 Mosquitto 客户端',
replace:[['QoS 2：恰好一次，交互和状态开销更高，实际使用要评估 Broker 与客户端支持。','QoS 2：在相应 MQTT 协议交互范围内提供恰好一次投递语义，交互和状态开销更高；不等于业务副作用只执行一次。'],['```java\nMqttClient client = new MqttClient(brokerUrl, clientId);\nMqttConnectOptions options = new MqttConnectOptions();\noptions.setAutomaticReconnect(true);\noptions.setCleanStart(false);\noptions.setKeepAliveInterval(30);\n\nclient.connect(options);\nclient.subscribe("tenant/t1/device/+/telemetry", 1);\nclient.publish("tenant/t1/device/d1/command", payload, 1, false);\n```','```text\nMQTT 3.1.1：使用对应客户端的 cleanSession 选项。\nMQTT 5.0：使用对应客户端的 Clean Start 与 Session Expiry Interval。\n这两套 API 不能混写；下文给出明确协议版本的命令行实验。\n```'],['可以先快速确认消息，再投递到受控线程池；否则网络回调线程阻塞会影响同一客户端的其他消息。','可将处理交给受控工作队列，但可靠业务不能在仅进入内存队列后就无条件确认。应按客户端能力，在持久接收或业务提交达到契约要求后确认，同时避免长时间阻塞网络回调线程。']],
body:`## 两段投递路径不要合并成一次保证

发布者到 Broker、Broker 到订阅者是两段协议交互。发布者使用 QoS 2，不表示所有订阅者都会以同样 QoS 接收，更不表示订阅者写数据库恰好成功一次。订阅授予的最大 QoS、会话状态、消息过期和客户端实现都会参与结果。正式报文和状态语义应参考[MQTT 5.0 标准](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)。

QoS 0 通常只发送 PUBLISH；QoS 1 需要 PUBACK，丢失确认可能引发重传；QoS 2 使用 PUBLISH、PUBREC、PUBREL、PUBCOMP 协调重复消除。额外交互会增加延迟、连接状态和持久存储压力。对温度遥测，下一条读数可能很快替代上一条，QoS 0 就可能符合产品要求；对开门命令，即使选择 QoS 2，也仍要设计命令幂等与执行结果。

~~~text
QoS 1:
  Publisher -- PUBLISH(packetId=7) --> Broker
  Publisher <-- PUBACK(7) ----------- Broker

QoS 2:
  Publisher -- PUBLISH(packetId=8) --> Broker
  Publisher <-- PUBREC(8) ------------ Broker
  Publisher -- PUBREL(8) ------------> Broker
  Publisher <-- PUBCOMP(8) ----------- Broker

业务层:
  receive -> validate -> persist inbox -> execute -> record result
  协议确认与业务结果确认必须分别定义。
~~~

Packet Identifier 会复用，只在协议会话中的相应范围内有意义，不能直接作为跨天唯一业务消息 ID。DUP 标志也不能成为唯一去重依据，业务应使用稳定 messageId 或设备启动代际与单调序列组成的键。

## Topic 是路由空间，也是一部分权限模型

可以使用 tenant/{tenant}/device/{device}/telemetry、command、command-result 三类主题。设备只能发布自己的遥测和结果，只能订阅自己的命令。平台服务可以拥有跨设备权限，但应限定租户。客户端传来的 tenant 字段不能覆盖从设备凭证得到的租户身份。

加号匹配一个层级，井号用于多层匹配且必须处于允许的位置。订阅过滤器和发布 Topic 是不同对象，不能发布到含通配符的任意过滤器。空层级、大小写和以 $ 开头的系统主题也需要按规范与 Broker ACL 验证。不要把 ACL 设计成只检查字符串是否包含 deviceId，设备 ID 的前后缀可能造成意外跨设备匹配。

共享订阅适合把遥测处理分散到多个后端消费者，但命令应到达特定设备，不能因为共享订阅方便就把设备控制也变成任意一个消费者收到。Broker 集群如何同步会话、持久队列和路由，是产品实现问题，不是 MQTT 标准替每种部署保证的能力。

## Retain、会话和遗嘱的三个时间尺度

Retain 保存主题最近的一条保留消息，新订阅者能获得当前快照。它不是消息历史，订阅者不能据此补齐全部状态变化。使用命令主题 Retain 非常危险：新连接可能收到很早以前的控制指令。若命令必须保留，应在载荷里设置 expiresAt，并让设备在执行前校验，而不是只依赖 Broker 清理。

MQTT 5 将 Clean Start 与 Session Expiry Interval 分开。前者决定连接开始时是否重新建立会话，后者控制断开后状态保留多久。稳定 clientId 才有可能找回自己的会话；每次启动随机 clientId，相当于不断创建新身份。相同 clientId 的两个实例又可能相互踢下线，因此设备身份要与后端消费者扩容策略区别设计。

遗嘱由 Broker 在满足异常断开等条件时发布，可以与 Will Delay 配合抑制短暂抖动。它不是“设备立即离线”的精确事实，网络黑洞需要心跳超时才能发现，旧连接遗嘱还可能与新连接上线消息交错。状态中加入连接代际或版本，可以防旧离线通知覆盖新在线状态。

## 一个可手工复现的本地实验

下面命令只用于本机隔离 Broker，故意没有生产凭证。生产应通过客户端安全配置传入 TLS 和身份信息，不要在共享终端历史里写真实密码。不同客户端版本的选项以其帮助为准，协议版本明确选择 mqttv5。

~~~bash
# 终端 A：订阅设备命令
mosquitto_sub -h 127.0.0.1 -p 1883 -V mqttv5 \
  -i device-demo-01 -t 'tenant/demo/device/01/command' -q 1 -v

# 终端 B：发布一条有业务 ID 的命令，不使用 retain
mosquitto_pub -h 127.0.0.1 -p 1883 -V mqttv5 \
  -t 'tenant/demo/device/01/command' -q 1 \
  -m '{"commandId":"cmd-001","type":"SET_LEVEL","level":20,"expiresAt":"2026-10-01T00:00:00Z"}'

# 发布当前配置快照供新订阅者获取
mosquitto_pub -h 127.0.0.1 -p 1883 -V mqttv5 \
  -t 'tenant/demo/device/01/config' -q 1 -r \
  -m '{"version":3,"reportIntervalSeconds":30}'

# 新建订阅，观察保留消息；完成后用空载荷保留发布清除测试快照
mosquitto_sub -h 127.0.0.1 -p 1883 -V mqttv5 \
  -t 'tenant/demo/device/01/config' -q 1 -C 1 -v
mosquitto_pub -h 127.0.0.1 -p 1883 -V mqttv5 \
  -t 'tenant/demo/device/01/config' -r -n
~~~

命令示例中的固定日期只用于演示格式，实际实验要换成当前时间后的明确期限。过期判断依赖设备时钟，时钟不可信时可以结合服务器签发时刻、相对有效期与时钟同步质量设计保守策略。危险动作不能只靠客户端自报时间决定是否允许。

## 命令状态机与幂等账本

命令可以经历 CREATED、SENT、ACKNOWLEDGED、EXECUTING、SUCCEEDED、FAILED、EXPIRED。MQTT PUBACK 通常只说明相应协议对端确认，不等价于设备执行成功，所以业务状态最好使用独立 result Topic。设备收到重复 commandId 时查询本地持久账本并返回已有结果，不再次执行不可逆动作。

~~~sql
CREATE TABLE device_command_result (
  tenant_id VARCHAR(64) NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  command_id VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL,
  result_code VARCHAR(64) NULL,
  updated_at TIMESTAMP NOT NULL,
  PRIMARY KEY (tenant_id, device_id, command_id)
);
~~~

该表演示平台侧结果唯一约束，设备本地也需要相应可靠记录。设备动作与写本地账本之间仍可能崩溃，涉及实际机械动作时要设计可查询状态、幂等操作或人工确认；协议 QoS 无法替物理世界提供数据库事务。

## 连接风暴与回压

上万设备同时断网再恢复，若每台每秒重连，会把认证、TLS 握手和会话恢复同时压向 Broker。指数退避加入随机抖动，最大间隔与电量策略一起设计。离线队列必须限制条数、字节和消息年龄，过期遥测可以聚合或丢弃，关键结果则进入可靠补偿。

消费回调应限制并发、队列和单消息大小。吞吐不足时尽早回压或受控断开，不能无限放进内存。监控连接数之外，还要看未确认消息、重传、队列年龄、认证失败、每设备异常发布速率和业务命令完成率。一条链路只有当设备执行结果回到平台并被正确关联，才完成业务闭环。`,
lab:'用两个客户端和独立 Broker 分离发布、订阅与业务确认。故障注入应明确发生在发送前、确认前还是业务提交后，不将任何一次“收到消息”直接标记为业务成功。',
cases:[
['MQTT-01','QoS 0 断线','遥测使用最多一次投递','在发送阶段中断连接','允许出现丢失且业务能由后续读数恢复','所选 QoS 必须与允许丢失的业务语义一致'],
['MQTT-02','QoS 1 重传','发布已被接收但确认丢失','恢复连接并观察可能的重复消息','相同业务消息不会重复产生副作用','至少一次交付需要应用层幂等'],
['MQTT-03','QoS 2 与业务失败','协议完成交互后数据库提交失败','重新驱动业务处理','通过持久 inbox 或恢复流程补齐处理','协议恰好一次不等于数据库事务恰好一次'],
['MQTT-04','保留快照','配置主题已有 retain 消息','新建订阅客户端','立即获得最新保留快照而非全部历史','Retain 提供最后状态，不承担事件回放'],
['MQTT-05','删除保留消息','测试主题残留旧配置','发送空载荷保留消息后重新订阅','旧保留快照不再被新订阅获取','清理测试和业务生命周期都需要理解 retain 删除语义'],
['MQTT-06','稳定会话身份','客户端有持久会话和固定 clientId','短暂断线后按约定参数重连','订阅和允许保留的消息按会话契约恢复','随机换 clientId 会失去原会话关联'],
['MQTT-07','重复客户端 ID','两个实例使用同一 clientId','让两者轮流连接','观察接管与断开并识别身份冲突','设备唯一身份不能被水平扩容实例任意共享'],
['MQTT-08','过期命令','离线队列里有已超过期限的动作','设备重连收到命令','设备拒绝执行并报告 EXPIRED','晚到消息可能协议有效但业务已失去时效'],
['MQTT-09','Topic 越权','设备只被授权自身租户与设备路径','尝试发布或订阅其他设备主题','Broker ACL 拒绝并记录审计','载荷自报身份不能替代连接凭证的权限边界'],
['MQTT-10','遗嘱乱序','设备旧连接尚未被判离线而新连接已上线','触发旧遗嘱延迟到达','状态版本阻止旧离线覆盖新在线','在线状态是有时序的业务视图而非单一布尔事件'],
['MQTT-11','重连风暴','大量模拟设备同时断开','比较固定间隔与带抖动退避的重连','握手峰值下降且恢复时间可解释','随机化避免客户端形成同步冲击'],
['MQTT-12','回调过载','业务处理速度低于消息到达速度','持续发布至受控工作队列满','系统执行明确回压或失败策略而非无限增长','网络回调与业务工作需要有界解耦和可靠交接']
],end:'## 协议可靠性与业务可靠性一起设计\n\nTopic、QoS、会话和遗嘱解决通信层的问题；命令 ID、持久账本、期限和结果状态解决业务层的问题。把两层确认分开，才能准确解释设备究竟收到了、接受了，还是已经完成了动作。',refs:[['OASIS MQTT 5.0 标准','https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html'],['本地延伸：消息队列','消息队列/消息队列.md']]},
{
file:'WebSocket长连接会话.md',scope:'RFC 6455 WebSocket 与 Spring Servlet 服务；可靠通知作为应用层协议设计',
body:`## 从通知需求推导会话模型

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

容量不能只看连接数。每连接协议状态、缓冲、认证信息、心跳任务和业务订阅都占资源。假设十万连接每个额外缓冲 64 KiB，仅缓冲理论上就超过 6 GiB。设置上限并不代表每连接立即分配，但估算峰值时要考虑极端慢客户端同时积压。监控消息延迟、排队字节、ACK 落后水位、断开原因和恢复失败率，比只看“在线人数”更能发现可靠性问题。`,
lab:'用两个节点与一个可控制网络的客户端验证迁移。测试明确区分 TCP 连通、WebSocket 帧发送、客户端处理和持久 ACK 四个阶段。',
cases:[
['WS-01','多端登录','同一用户建立浏览器和手机连接','向用户发送一条通知','按产品规则投递所有授权会话而不互相覆盖','用户到连接通常是一对多关系'],
['WS-02','Origin 校验','浏览器自动携带认证 Cookie','从未授权来源发起握手','服务端拒绝不受信来源','Cookie 自动携带并不意味着握手来自可信页面'],
['WS-03','过期会话','连接建立后 Token 到期或账号失效','继续订阅敏感资源','按策略关闭或重新认证，不能无限保留旧权限','长连接生命周期通常超过一次登录检查的有效范围'],
['WS-04','并发发送','多个线程向同一会话推送','使用受控发送包装并施加并发','帧顺序与异常处理符合策略，没有无界缓冲','底层 socket 对象不应被任意并发写入'],
['WS-05','慢客户端','客户端停止读取但保持连接','持续发送至队列边界','触发合并、断开或补偿策略，节点内存有上限','连接活着不代表消费速度足够'],
['WS-06','缺口 ACK','客户端收到 103 但没有 102','尝试确认连续序号到 103','客户端或服务端检测缺口并要求恢复','连续确认代表此前所有序号已经处理'],
['WS-07','断线补发','客户端最后确认 100，服务端已有后续事件','断线后连接另一节点并恢复','缺失事件补齐且重复被去重','连接迁移不能依赖旧节点的内存发送队列'],
['WS-08','历史实时交接','历史读取期间仍有新消息产生','按恢复水位衔接实时流','没有落在两步之间的消息被遗漏','历史与订阅的竞态需要协议层水位或去重处理'],
['WS-09','保留期不足','客户端水位早于最旧可用消息','发起恢复请求','明确返回需要全量同步的状态','无法补齐时不能伪造成功 ACK'],
['WS-10','旧节点清理','用户新会话已登记在另一节点','旧节点延迟执行关闭清理','新路由仍存在且不被旧会话删除','路由删除必须核对当前所有权或会话代际'],
['WS-11','滚动发布','节点持有大量长期连接','停止接收新连接并按宽限期关闭','客户端带抖动恢复，业务事件可补偿','readiness 不会自动把已建立连接迁移到新节点'],
['WS-12','消息越权','客户端合法登录但没有订单访问权限','在消息中指定其他租户订单','拒绝订阅或操作并记录审计','握手认证只证明身份，消息级资源授权仍然必要']
],end:'## 实时通道与可靠状态各司其职\n\nWebSocket 负责低延迟传递，持久消息与快照负责恢复。连接归属、授权、背压和水位协议设计清楚以后，节点重启与网络断开就成为可处理的日常事件，而不再意味着消息无法解释地消失。',refs:[['RFC 6455 WebSocket','https://www.rfc-editor.org/info/rfc6455/'],['本地延伸：消息队列','消息队列/消息队列.md']]}
];
for(const a of articles)console.log(writeArticle(a));
