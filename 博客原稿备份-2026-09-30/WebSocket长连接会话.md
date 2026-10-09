# WebSocket 长连接会话设计

WebSocket 在一次 HTTP 握手后升级为全双工长连接，适合实时通知、在线协作、行情推送和设备状态上报。它解决的是“连接和消息实时性”，并不会自动解决认证、离线消息、集群广播和可靠投递。

## 一、连接生命周期

```text
握手 -> 鉴权 -> 建立会话 -> 心跳/收发消息 -> 断开 -> 重连或结束
```

握手阶段完成来源校验和身份解析，连接建立后把用户、设备、租户和会话 ID 绑定在服务端上下文中。不要在每条消息里重复信任客户端传来的用户 ID。

## 二、Spring Boot 服务端示例

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

## 三、心跳和断线重连

客户端和服务端都应设置心跳策略。心跳只证明连接仍然可用，不代表业务消息已经被消费。客户端重连采用指数退避和随机抖动，避免服务端故障恢复时所有客户端同时重连。

重连后需要重新鉴权、重新订阅，并携带最后确认的消息序号。如果业务要求不丢消息，服务端应提供离线补偿接口，而不是只依赖 WebSocket 缓冲。

## 四、消息可靠性

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

## 五、集群部署

当用户连接分布在多个实例时，实例 A 不能直接向实例 B 上的会话发送消息。常见方案是使用 Redis Pub/Sub、消息队列或专门的 WebSocket 网关做跨实例广播：

```text
业务服务 -> 事件总线 -> 所有 WebSocket 节点
                                  -> 本节点连接
```

广播内容应包含用户或租户路由信息，节点只向本地匹配的会话发送。Redis Pub/Sub 适合实时广播，但不保证离线补偿；需要可靠历史消息时，应使用持久化队列或数据库记录。

## 六、鉴权与安全

WebSocket 握手要校验 Token、Origin、租户和资源权限。Token 不要通过 URL 长期传递，以免出现在访问日志中；连接建立后要考虑 Token 过期和主动下线。对消息内容做长度、格式和频率限制，禁止把客户端内容直接拼成 SQL、脚本或日志格式。

## 七、优雅关闭和监控

服务滚动发布时先停止接收新连接，再向旧连接发送关闭通知，给客户端留出重连时间。监控当前连接数、连接建立失败、断开原因、心跳超时、发送队列长度、消息延迟和广播失败。

## 总结

WebSocket 设计的重点是会话生命周期、心跳重连、消息幂等、集群路由和权限校验。单机 Map 能快速验证功能，但一旦进入多实例部署，就必须把连接位置和消息可靠性明确建模。
