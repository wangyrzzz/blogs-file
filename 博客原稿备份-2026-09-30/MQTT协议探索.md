# MQTT 协议探索：从发布订阅到可靠消息

MQTT 是一种轻量级发布/订阅协议，常用于物联网、设备遥测和网络条件不稳定的场景。客户端不直接互相连接，而是与 Broker 建立连接，通过 Topic 发布和订阅消息。

## 一、核心角色和消息流

```text
设备 A --publish--> Broker --deliver--> 订阅者 B
设备 C --publish--> Broker --deliver--> 订阅者 D
```

发布者和订阅者可以彼此不知道对方。Broker 负责认证、Topic 匹配、消息转发、会话和部分离线消息存储。

Topic 是分层字符串，例如：

```text
tenant/{tenantId}/device/{deviceId}/telemetry
tenant/{tenantId}/device/{deviceId}/command
```

`+` 匹配一层，`#` 匹配多层。通配订阅非常方便，但权限和消息量也要严格限制。

## 二、QoS 的含义

- QoS 0：最多一次，消息可能丢失，不等待确认；
- QoS 1：至少一次，可能重复，需要消费者幂等；
- QoS 2：恰好一次，交互和状态开销更高，实际使用要评估 Broker 与客户端支持。

QoS 不是端到端业务事务。即使 Broker 按 QoS 1 投递，消费者写数据库失败后仍然需要重试、去重和死信处理。

## 三、Retain、Session 和遗嘱

Retain 表示 Broker 为某个 Topic 保存最后一条消息，新订阅者订阅后可以立即收到它，适合设备在线状态或配置快照，不适合不断变化的大量遥测数据。

持久会话可以让客户端断线后恢复订阅和部分离线消息，但必须设置合理的过期时间，否则离线消息会堆积。Last Will and Testament（遗嘱消息）可以在客户端异常断开时由 Broker 发布离线状态，常用于设备在线状态维护。

## 四、设备消息的幂等设计

每条业务消息应包含设备 ID、消息 ID、产生时间、数据版本和业务类型：

```json
{
  "messageId": "m-20260914-0001",
  "deviceId": "device-01",
  "occurredAt": "2026-09-14T10:00:00Z",
  "version": 42,
  "payload": {"temperature": 26.4}
}
```

消费者用 `messageId` 或设备序列号去重。对于控制命令，还要设计命令状态、过期时间和响应 Topic，避免设备重连后执行已经失效的命令。

## 五、连接与心跳

MQTT 连接通过 Keep Alive 检测异常断线。客户端应实现指数退避重连，避免网络故障时大量设备同时打满 Broker。重连后要确认订阅是否恢复、会话是否过期，以及是否需要重新上报设备状态。

服务端不能只依赖 TCP 连接数判断设备在线。应结合连接事件、遗嘱消息和业务心跳，并设置“最后在线时间”的容忍窗口。

## 六、安全设计

生产环境优先使用 TLS，设备使用独立身份和凭证，不要所有设备共享一个账号。ACL 应限制设备只能发布自己的遥测 Topic、订阅被授权的命令 Topic；平台管理端和设备端的权限模型应分开。

Topic、Payload 和日志中可能含有个人信息或位置数据，必须按数据分类要求处理。Broker 管理端口和客户端端口也要隔离，禁止公网直接暴露管理接口。

## 七、Java 客户端示例

以常见 MQTT 客户端库为例，代码重点是连接、订阅和发布，实际 API 以所选客户端版本为准：

```java
MqttClient client = new MqttClient(brokerUrl, clientId);
MqttConnectOptions options = new MqttConnectOptions();
options.setAutomaticReconnect(true);
options.setCleanStart(false);
options.setKeepAliveInterval(30);

client.connect(options);
client.subscribe("tenant/t1/device/+/telemetry", 1);
client.publish("tenant/t1/device/d1/command", payload, 1, false);
```

回调中不要直接执行长时间数据库操作。可以先快速确认消息，再投递到受控线程池；否则网络回调线程阻塞会影响同一客户端的其他消息。

## 八、监控指标

重点监控连接数、连接建立失败、订阅数、入站/出站消息量、QoS 重传、离线队列、消息延迟、消费失败和 Broker 磁盘使用量。对设备命令还应监控发送后未收到响应的超时数量。

## 总结

MQTT 的协议很轻，但可靠业务需要补上身份、Topic 规划、消息幂等、离线策略、命令状态和监控。先定义消息契约与失败处理，再选择 QoS 和会话选项，系统才不会把“收到消息”误当成“业务已经成功”。
