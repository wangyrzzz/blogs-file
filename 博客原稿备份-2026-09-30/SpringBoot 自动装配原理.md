# Spring Boot 自动装配原理

Spring Boot 的自动装配解决了一个问题：当项目引入某个 Starter 并满足相应条件时，框架可以自动创建常用 Bean 和默认配置，让开发者只需要覆盖业务差异部分。理解自动装配后，遇到“为什么这个 Bean 会出现”“为什么配置没有生效”时，才能从条件、优先级和配置绑定入手排查。

## 一、入口：`@SpringBootApplication`

通常启动类只有一个注解：

```java
@SpringBootApplication
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
```

它是多个注解的组合，核心包括：

- `@SpringBootConfiguration`：标识这是一个 Boot 配置类；
- `@ComponentScan`：扫描组件；
- `@EnableAutoConfiguration`：启用自动装配。

组件扫描负责发现项目中的 `@Component`、`@Service`、`@Configuration` 等类，自动装配负责根据 classpath、配置和已有 Bean 导入框架提供的配置类，两者不是一回事。

## 二、`@EnableAutoConfiguration` 做了什么

`@EnableAutoConfiguration` 通过 ImportSelector 获取候选自动配置类，再交给 Spring 容器处理。Spring Boot 3 使用 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` 列出自动配置类；较早版本常见的是 `META-INF/spring.factories`，不要把两者混为一谈。

一个自动配置类可能类似这样：

```java
@AutoConfiguration
@ConditionalOnClass(RedisTemplate.class)
@ConditionalOnMissingBean(RedisTemplate.class)
@EnableConfigurationProperties(RedisProperties.class)
public class RedisAutoConfiguration {
    @Bean
    RedisTemplate<String, Object> redisTemplate(RedisConnectionFactory factory) {
        return new RedisTemplate<>();
    }
}
```

真正的源码还会包含连接工厂、序列化器和条件组合，示例只用于理解结构。

## 三、条件注解

自动装配依赖条件注解控制是否生效：

- `@ConditionalOnClass`：classpath 中有指定类；
- `@ConditionalOnMissingClass`：classpath 中没有指定类；
- `@ConditionalOnBean`：容器中已有某个 Bean；
- `@ConditionalOnMissingBean`：容器中没有指定 Bean；
- `@ConditionalOnProperty`：配置属性满足条件；
- `@ConditionalOnWebApplication`：当前是 Web 应用。

最常见的扩展方式是 `@ConditionalOnMissingBean`：框架提供默认实现，业务声明同类型 Bean 后，默认实现让位给业务实现。

## 四、Starter 与自动配置的关系

Starter 本质上是依赖聚合包，负责把一组常用依赖放入 classpath；自动配置模块负责声明和注册 Bean。引入 Starter 不代表每个功能都无条件开启，最终是否装配还要看条件注解和配置属性。

排查某个 Bean 从哪里来，可以使用：

```bash
java -jar app.jar --debug
```

启动日志中的 Condition Evaluation Report 会列出匹配成功和不匹配的条件。也可以通过 Actuator 的 `/actuator/conditions` 查看条件报告，前提是端点已经安全暴露。

## 五、配置绑定

自动配置通常用 `@ConfigurationProperties` 绑定配置：

```java
@ConfigurationProperties("demo.client")
public class ClientProperties {
    private Duration timeout = Duration.ofSeconds(2);
    private URI endpoint;
}
```

配置类应提供合理默认值、校验规则和清晰的属性命名。优先使用类型化配置，不要在业务代码中到处调用 `Environment.getProperty` 并自行转换字符串。

## 六、自动配置的顺序与覆盖

自动配置可能依赖其他 Bean，因此会使用 `@AutoConfigureAfter`、`@AutoConfigureBefore` 等机制表达顺序。顺序只能解决配置类之间的依赖，不能修复循环依赖、Bean 类型冲突或错误的条件设计。

业务覆盖自动配置通常有三种方式：提供同类型 Bean、关闭某项自动配置，或使用专门的配置属性。直接复制框架内部配置类到业务项目里往往会带来升级负担，应优先使用公开扩展点。

## 七、自定义自动配置

一个 Boot 3 风格的自定义自动配置至少包括：

1. 自动配置类；
2. `@AutoConfiguration` 和条件注解；
3. 可选的 `@ConfigurationProperties`；
4. `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`；
5. 针对有依赖、无依赖、已有 Bean 和属性开关的测试。

不要在自动配置中无条件创建线程池、连接池或定时任务。资源型 Bean 应允许配置关闭、设置上限，并在应用停止时正确释放。

## 八、常见误区

- 把组件扫描范围当成自动装配范围；
- 只看依赖声明，不看条件评估报告；
- 通过调整 Bean 名称掩盖类型冲突；
- 忽略 Spring Boot 2 与 3 的注册文件和 Jakarta 包变化；
- 在自动配置中执行网络请求、数据库初始化等不可控副作用。

## 总结

Spring Boot 自动装配可以概括为：从候选清单导入配置类，再由条件注解决定是否创建 Bean，最后通过属性绑定和业务 Bean 覆盖形成可扩展的默认配置。遇到问题时按“候选配置类—条件—属性—Bean 覆盖—启动报告”的顺序排查，效率最高。
