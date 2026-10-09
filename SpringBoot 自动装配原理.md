# Spring Boot 自动装配原理

> 阅读范围：Spring Boot 3 的自动配置与 Spring Framework 6；示例使用 Boot 3 风格 imports 注册。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


Spring Boot 的自动装配解决了一个问题：当项目引入某个 Starter 并满足相应条件时，框架可以自动创建常用 Bean 和默认配置，让开发者只需要覆盖业务差异部分。理解自动装配后，遇到“为什么这个 Bean 会出现”“为什么配置没有生效”时，才能从条件、优先级和配置绑定入手排查。

## 入口：`@SpringBootApplication`

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

## `@EnableAutoConfiguration` 做了什么

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
        RedisTemplate<String, Object> template = new RedisTemplate<>();
        template.setConnectionFactory(factory);
        return template;
    }
}
```

真正的源码还会包含连接工厂、序列化器和条件组合，示例只用于理解结构。

## 条件注解

自动装配依赖条件注解控制是否生效：

- `@ConditionalOnClass`：classpath 中有指定类；
- `@ConditionalOnMissingClass`：classpath 中没有指定类；
- `@ConditionalOnBean`：容器中已有某个 Bean；
- `@ConditionalOnMissingBean`：容器中没有指定 Bean；
- `@ConditionalOnProperty`：配置属性满足条件；
- `@ConditionalOnWebApplication`：当前是 Web 应用。

最常见的扩展方式是 `@ConditionalOnMissingBean`：框架提供默认实现，业务声明同类型 Bean 后，默认实现让位给业务实现。

## Starter 与自动配置的关系

Starter 本质上是依赖聚合包，负责把一组常用依赖放入 classpath；自动配置模块负责声明和注册 Bean。引入 Starter 不代表每个功能都无条件开启，最终是否装配还要看条件注解和配置属性。

排查某个 Bean 从哪里来，可以使用：

```bash
java -jar app.jar --debug
```

启动日志中的 Condition Evaluation Report 会列出匹配成功和不匹配的条件。也可以通过 Actuator 的 `/actuator/conditions` 查看条件报告，前提是端点已经安全暴露。

## 配置绑定

自动配置通常用 `@ConfigurationProperties` 绑定配置：

```java
@ConfigurationProperties("demo.client")
public class ClientProperties {
    private Duration timeout = Duration.ofSeconds(2);
    private URI endpoint;
}
```

配置类应提供合理默认值、校验规则和清晰的属性命名。优先使用类型化配置，不要在业务代码中到处调用 `Environment.getProperty` 并自行转换字符串。

## 自动配置的顺序与覆盖

自动配置可能依赖其他 Bean，因此会使用 `@AutoConfigureAfter`、`@AutoConfigureBefore` 等机制表达顺序。顺序只能解决配置类之间的依赖，不能修复循环依赖、Bean 类型冲突或错误的条件设计。

业务覆盖自动配置通常有三种方式：提供同类型 Bean、关闭某项自动配置，或使用专门的配置属性。直接复制框架内部配置类到业务项目里往往会带来升级负担，应优先使用公开扩展点。

## 自定义自动配置

一个 Boot 3 风格的自定义自动配置至少包括：

1. 自动配置类；
2. `@AutoConfiguration` 和条件注解；
3. 可选的 `@ConfigurationProperties`；
4. `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`；
5. 针对有依赖、无依赖、已有 Bean 和属性开关的测试。

不要在自动配置中无条件创建线程池、连接池或定时任务。资源型 Bean 应允许配置关闭、设置上限，并在应用停止时正确释放。

## 常见误区

- 把组件扫描范围当成自动装配范围；
- 只看依赖声明，不看条件评估报告；
- 通过调整 Bean 名称掩盖类型冲突；
- 忽略 Spring Boot 2 与 3 的注册文件和 Jakarta 包变化；
- 在自动配置中执行网络请求、数据库初始化等不可控副作用。


## 从候选类到 Bean 是几道独立关口

自动配置出问题时可以沿四个关口排查：Jar 是否真正进入运行 classpath，候选文件是否打入 Jar，配置类条件是否成立，Bean 是否因为已有实现而退让。只看到 Maven 依赖存在，最多通过第一关的一部分；依赖还可能是 test scope、被排除或没有进入最终镜像。

组件扫描依赖包路径，自动配置依赖候选注册机制。Starter 通常只是依赖集合，真正的默认行为放在 autoconfigure 模块。分开以后，业务可以不使用 Starter 而直接引入模块，也可以让多个 Starter 复用同一份自动配置。Spring Boot 官方的[自定义自动配置文档](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)说明了条件、imports 与测试方式；使用 Boot 3 时应查对应版本文档，不能照抄新大版本新增 API。

## 做一个不隐藏网络副作用的客户端 Starter

下面设计一个目录服务客户端。它有 endpoint 和 timeout 属性，默认实现只保存配置，真正网络访问发生在显式业务调用中。这样应用启动是否成功由配置和依赖决定，不会因为构造 Bean 时访问远程系统而卡住整个容器。示例目录结构如下，包名需要在真实项目中保持一致。

~~~text
catalog-client-api/
  src/main/java/example/catalog/CatalogClient.java
catalog-client-autoconfigure/
  src/main/java/example/catalog/CatalogProperties.java
  src/main/java/example/catalog/DefaultCatalogClient.java
  src/main/java/example/catalog/CatalogAutoConfiguration.java
  src/main/resources/META-INF/spring/
    org.springframework.boot.autoconfigure.AutoConfiguration.imports
catalog-client-starter/
  pom.xml
catalog-client-autoconfigure/src/test/java/example/catalog/
  CatalogAutoConfigurationTests.java
~~~

为了让读者能关注装配，接口只提供描述配置的方法。生产接口应改成明确的领域请求和响应，并在实现里加入受控连接池、超时和关闭行为；这部分不属于候选配置发现机制本身。

~~~java
package example.catalog;

public interface CatalogClient {
    String describe();
}
~~~

~~~java
package example.catalog;

import java.net.URI;
import java.time.Duration;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@Validated
@ConfigurationProperties(prefix = "demo.catalog")
public class CatalogProperties {
    @NotNull
    private URI endpoint = URI.create("https://catalog.example.invalid");
    @NotNull
    private Duration timeout = Duration.ofSeconds(2);
    public URI getEndpoint() { return endpoint; }
    public void setEndpoint(URI endpoint) { this.endpoint=endpoint; }
    public Duration getTimeout() { return timeout; }
    public void setTimeout(Duration timeout) { this.timeout=timeout; }
    public void validateForClient() {
        if (timeout==null || timeout.isZero() || timeout.isNegative()) {
            throw new IllegalArgumentException("demo.catalog.timeout must be positive");
        }
        if (endpoint==null || !"https".equalsIgnoreCase(endpoint.getScheme())) {
            throw new IllegalArgumentException("demo.catalog.endpoint must use https");
        }
    }
}
~~~

~~~java
package example.catalog;

import java.net.URI;
import java.time.Duration;

public final class DefaultCatalogClient implements CatalogClient {
    private final URI endpoint;
    private final Duration timeout;
    public DefaultCatalogClient(URI endpoint, Duration timeout) {
        this.endpoint=endpoint;
        this.timeout=timeout;
    }
    @Override public String describe() {
        return endpoint.getHost()+":"+timeout.toMillis();
    }
}
~~~

~~~java
package example.catalog;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;

@AutoConfiguration
@ConditionalOnClass(CatalogClient.class)
@ConditionalOnProperty(prefix="demo.catalog", name="enabled",
        havingValue="true", matchIfMissing=true)
@EnableConfigurationProperties(CatalogProperties.class)
public class CatalogAutoConfiguration {
    @Bean
    @ConditionalOnMissingBean(CatalogClient.class)
    CatalogClient catalogClient(CatalogProperties properties) {
        properties.validateForClient();
        return new DefaultCatalogClient(properties.getEndpoint(),properties.getTimeout());
    }
}
~~~

imports 文件必须包含全限定类名，不能写 Bean 方法名，也不能依赖 IDE 自动扫描资源。文件内容只有一行：

~~~text
example.catalog.CatalogAutoConfiguration
~~~

Starter 的 POM 聚合 API、自动配置模块以及需要的依赖。版本通过 BOM 或统一父项目管理，不要在文章中虚构一个可下载的业务 artifact 版本。发布前检查最终 Jar 中 imports 是否存在，并用一个独立消费者项目验证，避免测试因为直接导入配置类而掩盖打包问题。

## 条件不是普通运行时 if

条件在配置解析和 Bean 定义处理过程中评估，有自己的时机。ConditionalOnMissingBean 依赖当时已处理的定义，因此适合用在有顺序保障的自动配置上。随意在业务扫描类之间用条件相互猜测，容易形成顺序敏感行为。自动配置先后顺序决定定义处理，不直接决定所有 Bean 实例化顺序，实例依赖仍由容器解析。

Optional SDK 的类条件应隔离在合适配置边界，避免还没判断条件就因为方法签名引用缺失类型而发生加载错误。方法返回具体 Bean 类型通常有助于条件推断，但当这个类型是可选依赖时，要把相关配置隔离到受类条件保护的配置单元。测试中移除 classpath 比仅设置 enabled=false 更能发现这类问题。

## 用 ApplicationContextRunner 验证退让

下面测试片段假设已添加 Boot test、AssertJ 和 JUnit 5 依赖，并与主项目使用同一 Boot 3 依赖管理。它不会启动完整 Web 服务器，只验证一组配置产生什么容器结果。

~~~java
package example.catalog;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import static org.assertj.core.api.Assertions.assertThat;

class CatalogAutoConfigurationTests {
    private final ApplicationContextRunner runner=new ApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(CatalogAutoConfiguration.class));
    @Test void createsDefault() {
        runner.run(context -> assertThat(context).hasSingleBean(CatalogClient.class));
    }
    @Test void canBeDisabled() {
        runner.withPropertyValues("demo.catalog.enabled=false")
            .run(context -> assertThat(context).doesNotHaveBean(CatalogClient.class));
    }
    @Test void userBeanWins() {
        runner.withUserConfiguration(UserConfiguration.class).run(context -> {
            assertThat(context).hasSingleBean(CatalogClient.class);
            assertThat(context.getBean(CatalogClient.class).describe()).isEqualTo("custom");
        });
    }
    @Test void rejectsInvalidTimeout() {
        runner.withPropertyValues("demo.catalog.timeout=-1s")
            .run(context -> assertThat(context).hasFailed());
    }
    @Configuration(proxyBeanMethods=false)
    static class UserConfiguration {
        @Bean CatalogClient customCatalogClient() { return () -> "custom"; }
    }
}
~~~

还应加入 FilteredClassLoader 场景验证可选 API 缺失，以及资源打包集成测试验证 imports。ContextRunner 直接指定配置时，无法证明消费者从 Jar 候选文件发现了该配置；两层测试有不同职责。

## 配置错误应该尽早暴露

类型化 Duration 支持带单位配置，但业务还要校验正数和上限。URI 类型绑定成功不代表它是允许的协议或地址。密码等敏感属性不能出现在 describe、toString 或启动日志中。配置元数据改善 IDE 提示，不替代运行时校验。属性改名需要兼容窗口与弃用说明，否则升级 Starter 会悄悄使用默认值。

资源型 Bean 应由明确的所有者关闭。如果客户端借用了业务提供的线程池，关闭客户端时不能误关共享池；如果自己创建线程池，就要在容器停止时释放。设置 enabled=false 后不应残留背景线程，反复启动关闭 ContextRunner 是发现这类泄漏的实用方法。

## 条件报告比试错排除更有效

Bean 缺失时先找候选类是否出现，再看 negative matches；Bean 重复时检查用户配置、手动 Import 和组件扫描是否重复引入；配置不生效时查看实际 PropertySource 与绑定结果。不要通过开启 Bean 同名覆盖来隐藏类型冲突。Actuator 条件端点可能暴露系统结构，应按环境权限开放，而不是作为公开健康接口。

## 故障注入与验收实验

将默认开启、关闭开关、用户覆盖、缺少依赖和非法属性视为互相独立的装配分支。测试报告要记录 Bean 数量、实际类型、条件结果与容器关闭后的资源状态。

### AUTO-01：默认装配

实验前提是API 与自动配置模块都在 classpath。执行不提供自定义 Bean 启动最小上下文。

通过条件是只有一个默认 CatalogClient。这里的判断依据是候选发现与条件共同决定默认实现是否建立。

### AUTO-02：属性关闭

实验前提是依赖保持不变。执行设置 demo.catalog.enabled=false。

通过条件是不创建默认客户端且不启动后台资源。这里的判断依据是功能开关应关闭行为而不只是隐藏一个注入入口。

### AUTO-03：业务覆盖

实验前提是业务显式定义 CatalogClient。执行加载相同自动配置。

通过条件是业务实例保留且默认实例退让。这里的判断依据是MissingBean 是可替换默认实现的核心扩展点。

### AUTO-04：可选类型缺失

实验前提是通过过滤类加载器移除 API 或 SDK。执行尝试加载受类条件保护的配置。

通过条件是没有缺失类型链接错误，相关功能不装配。这里的判断依据是条件必须放在足够早且不会提前引用缺失类型的边界。

### AUTO-05：非法时长

实验前提是timeout 绑定成负 Duration。执行创建默认客户端。

通过条件是启动明确失败并指出属性错误。这里的判断依据是类型转换成功不代表业务取值合法。

### AUTO-06：非法地址

实验前提是endpoint 使用不允许的协议。执行配置校验。

通过条件是客户端创建前失败而非首次请求时才发现。这里的判断依据是配置边界应提前拒绝无法使用的资源参数。

### AUTO-07：imports 漏打包

实验前提是测试直接导入配置能成功。执行删除实验 Jar 的候选资源后由独立消费者启动。

通过条件是集成测试发现自动配置不再被自动发现。这里的判断依据是直接指定配置类的单元测试不能证明资源打包正确。

### AUTO-08：扫描与导入重叠

实验前提是自动配置包被业务组件扫描覆盖。执行同时启用手动 Import 与候选发现。

通过条件是定位重复定义来源并移除不必要入口。这里的判断依据是装配机制应保持单一清楚入口而不是靠覆盖开关掩盖。

### AUTO-09：配置优先级

实验前提是文件与环境变量提供不同 timeout。执行查看运行绑定值与条件报告。

通过条件是结果符合项目约定的 PropertySource 优先级。这里的判断依据是源码默认值不是部署后最终生效配置。

### AUTO-10：资源关闭

实验前提是客户端实现拥有专用线程池。执行反复创建和关闭测试上下文。

通过条件是线程数量回落且共享业务池不被误关。这里的判断依据是资源所有权决定谁负责销毁，自动配置也必须遵守生命周期。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "SpringBoot 自动装配原理",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "AUTO-01",
      "scenario": "默认装配",
      "given": "API 与自动配置模块都在 classpath",
      "when": "不提供自定义 Bean 启动最小上下文",
      "then": "只有一个默认 CatalogClient"
    },
    {
      "id": "AUTO-02",
      "scenario": "属性关闭",
      "given": "依赖保持不变",
      "when": "设置 demo.catalog.enabled=false",
      "then": "不创建默认客户端且不启动后台资源"
    },
    {
      "id": "AUTO-03",
      "scenario": "业务覆盖",
      "given": "业务显式定义 CatalogClient",
      "when": "加载相同自动配置",
      "then": "业务实例保留且默认实例退让"
    },
    {
      "id": "AUTO-04",
      "scenario": "可选类型缺失",
      "given": "通过过滤类加载器移除 API 或 SDK",
      "when": "尝试加载受类条件保护的配置",
      "then": "没有缺失类型链接错误，相关功能不装配"
    },
    {
      "id": "AUTO-05",
      "scenario": "非法时长",
      "given": "timeout 绑定成负 Duration",
      "when": "创建默认客户端",
      "then": "启动明确失败并指出属性错误"
    },
    {
      "id": "AUTO-06",
      "scenario": "非法地址",
      "given": "endpoint 使用不允许的协议",
      "when": "执行配置校验",
      "then": "客户端创建前失败而非首次请求时才发现"
    },
    {
      "id": "AUTO-07",
      "scenario": "imports 漏打包",
      "given": "测试直接导入配置能成功",
      "when": "删除实验 Jar 的候选资源后由独立消费者启动",
      "then": "集成测试发现自动配置不再被自动发现"
    },
    {
      "id": "AUTO-08",
      "scenario": "扫描与导入重叠",
      "given": "自动配置包被业务组件扫描覆盖",
      "when": "同时启用手动 Import 与候选发现",
      "then": "定位重复定义来源并移除不必要入口"
    },
    {
      "id": "AUTO-09",
      "scenario": "配置优先级",
      "given": "文件与环境变量提供不同 timeout",
      "when": "查看运行绑定值与条件报告",
      "then": "结果符合项目约定的 PropertySource 优先级"
    },
    {
      "id": "AUTO-10",
      "scenario": "资源关闭",
      "given": "客户端实现拥有专用线程池",
      "when": "反复创建和关闭测试上下文",
      "then": "线程数量回落且共享业务池不被误关"
    }
  ]
}
```

## 从黑盒变成可解释的默认配置

自动装配本质上是候选发现、条件评估和默认 Bean 退让的组合。一个成熟 Starter 应能解释为什么装配、为什么不装配、怎样覆盖、错误怎样暴露以及资源怎样关闭，而不只是“引入依赖后能启动”。

## 参考资料与继续阅读

- [Spring Boot：创建自动配置](https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html)
- [本地延伸：IoC 与 AOP](IoC%20%26%20AOP/IoC%20%26%20AOP.md)
