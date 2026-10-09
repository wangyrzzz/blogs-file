const {writeArticle}=require('./compose.cjs');
const articles=[{
file:'类加载器详解.md',scope:'JDK 21 的 classpath、类身份和生命周期；模块访问控制与加载隔离分别说明',
body:`## 把加载、连接和初始化拆成可观察事件

类加载器的讨论经常把几个不同问题混为一谈：字节码是否找到、类型是否定义、依赖是否解析、静态初始化是否成功。一个类已经有 Class 对象，并不代表静态代码块已运行。Class.forName(name,false,loader) 可以请求加载而不触发初始化；Class.forName(name,true,loader) 则要求初始化。访问编译期常量可能被调用者内联，不能用它证明被引用类完成了初始化。

准备阶段与初始化阶段也不同。普通静态字段先有默认值，随后在初始化逻辑中执行显式赋值；具有 ConstantValue 属性的常量还需要按规范单独理解。解析允许按实现策略延迟，不能把所有符号引用都必须在一次初始化之前解析完成当作普遍事实。[JVM 规范第五章](https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-5.html)给出了加载、连接、初始化以及错误状态的正式边界。

~~~java
public class InitializationLab {
    static final class Target {
        static final int CONSTANT = 7;
        static int runtimeValue = initialize();
        static int initialize() {
            System.out.println("Target initialized");
            return 42;
        }
    }
    public static void main(String[] args) throws Exception {
        String name = InitializationLab.class.getName() + "$Target";
        ClassLoader loader = InitializationLab.class.getClassLoader();
        System.out.println("step 1: " + Target.CONSTANT);
        Class<?> type = Class.forName(name, false, loader);
        System.out.println("step 2: " + type.getName());
        System.out.println("step 3: before initialization");
        Class.forName(name, true, loader);
        System.out.println("step 4: " + Target.runtimeValue);
    }
}
~~~

不要用调试器的表达式求值随意读取静态字段后再判断初始化时机，因为求值本身可能触发行为。实验首先看无调试器运行的输出，再用类加载日志辅助观察。JDK 9 之后可用统一日志选项查看类加载和卸载，具体标签与输出按运行版本核对；不要把 JDK 8 的参数原样用于所有版本。

## 用同一份字节码制造两个不同类型

下面示例不需要真正部署插件目录，直接从应用资源读取一个嵌套类的字节码，再交给两个独立加载器定义。为了清楚展示类型身份，只对目标类型绕过父加载器，其余类仍沿通常委派路径查找。它是实验加载器，不是完整插件框架。

~~~java
import java.io.InputStream;
import java.io.IOException;

public class LoaderIdentityLab {
    public static class Payload {
        public Payload() {}
        public String value() { return "hello"; }
    }
    static final class IsolatedLoader extends ClassLoader {
        private final String target;
        private final byte[] bytes;
        IsolatedLoader(String target, byte[] bytes) {
            super(LoaderIdentityLab.class.getClassLoader());
            this.target=target;
            this.bytes=bytes.clone();
        }
        @Override
        protected Class<?> loadClass(String name, boolean resolve)
                throws ClassNotFoundException {
            synchronized (getClassLoadingLock(name)) {
                Class<?> type=findLoadedClass(name);
                if (type==null) {
                    if (name.equals(target)) {
                        type=defineClass(name,bytes,0,bytes.length);
                    } else {
                        type=super.loadClass(name,false);
                    }
                }
                if (resolve) resolveClass(type);
                return type;
            }
        }
    }
    public static void main(String[] args) throws Exception {
        String name=Payload.class.getName();
        String resource="/"+name.replace('.','/')+".class";
        byte[] bytes;
        try (InputStream input=LoaderIdentityLab.class.getResourceAsStream(resource)) {
            if (input==null) throw new IOException("missing resource: "+resource);
            bytes=input.readAllBytes();
        }
        Class<?> first=new IsolatedLoader(name,bytes).loadClass(name);
        Class<?> second=new IsolatedLoader(name,bytes).loadClass(name);
        Object value=first.getConstructor().newInstance();
        System.out.println("same name="+first.getName().equals(second.getName()));
        System.out.println("same class="+(first==second));
        System.out.println("assignable="+second.isInstance(value));
        try {
            second.cast(value);
            throw new AssertionError("unexpected cast success");
        } catch (ClassCastException expected) {
            System.out.println("different defining loaders: cast rejected");
        }
    }
}
~~~

输出应表现为同名但不同 Class。这里故意只调用公共构造器，避免把嵌套类私有访问和 nestmate 规则混进主实验。生产中看到“X cannot be cast to X”，先打印双方的加载器与 CodeSource；两个 X 的字符一样，不代表它们的运行时身份相同。

## 插件 API 应该由谁加载

一个可维护的插件系统通常把共享接口放在宿主父加载器可见的位置，让插件实现依赖同一份 API 类型。若插件把接口也打包并由自己的子加载器定义，宿主获得的实现对象就不一定能转换为宿主接口。依赖隔离的目标是隔离实现细节，同时共享交流契约，而不是隔离所有类。

插件私有依赖可以按包名单选择优先从插件加载，但 JDK 核心类、共享接口和关键框架类型通常仍应交给父加载器。盲目 child-first 会让日志、JSON、注解甚至异常类型各自出现多份，问题远比一个依赖冲突复杂。包级白名单与资源查找顺序都需要测试，META-INF/services 资源也可能来自多处。

## SPI 与线程上下文加载器

ServiceLoader 的接口类型和实现资源可能处在不同可见范围内。默认查找路径、显式传入加载器，以及模块化服务声明应分别核实。框架在线程池里切换 contextClassLoader 时，需要在 finally 恢复原值，否则下一个任务可能错误地寻找另一插件的实现。

~~~java
ClassLoader previous = Thread.currentThread().getContextClassLoader();
try {
    Thread.currentThread().setContextClassLoader(pluginLoader);
    ServiceLoader<MyPlugin> plugins = ServiceLoader.load(MyPlugin.class, pluginLoader);
    for (MyPlugin plugin : plugins) {
        plugin.execute();
    }
} finally {
    Thread.currentThread().setContextClassLoader(previous);
}
~~~

上面是集成片段，MyPlugin 和 pluginLoader 由宿主定义。不要为了让 ServiceLoader 找到实现，把插件加载器永久挂在全局线程池线程上；这个引用也可能阻止整个插件卸载。线程上下文加载器是查找路径的桥梁，不会改变已经定义的类的身份。

## 初始化失败是另一类故障

静态初始化第一次失败可能出现 ExceptionInInitializerError，后续主动使用可能看到 NoClassDefFoundError，提示类无法初始化。这时“Jar 明明在”并不矛盾，类文件存在但初始化状态已经失败。排查要找最早的异常，而不是只对最后一次报错做依赖补齐。静态块里访问数据库、读取不存在文件或启动线程，都会让故障在初始化阶段提前发生。

NoSuchMethodError 通常提示编译时与运行时方法签名不一致，UnsupportedClassVersionError 提示字节码版本高于运行时支持，ClassNotFoundException 常见于显式加载找不到目标。把所有问题都归类为“少一个 Jar”，容易越加依赖越混乱。记录实际启动命令、classpath、模块参数、容器共享目录和依赖树，再确认真实加载来源。

## 关闭加载器不等于卸载类

URLClassLoader.close 主要释放其资源，不会使所有类立即消失。加载器、类和实例仍被线程、静态注册表、监听器或缓存引用时，GC 无法回收相应对象图。插件卸载应先停止任务、注销回调、关闭连接、移除宿主索引，再释放加载器引用。System.gc 只是请求，不能作为卸载的确定性业务 API。

堆转储中的引用链通常比不断调大 Metaspace 上限更有用。重复加载卸载同一插件，并观察旧加载器数量是否持续增长，可以较早发现泄漏。模块系统解决的是可读性、导出和反射访问控制，类加载隔离解决的是命名空间，两者相关但不能互相替代。加载不可信字节码也不能仅靠自定义 ClassLoader 当作完整安全沙箱。`,
lab:'先分别运行初始化与类身份两个独立程序，再进入插件和容器实验。保留 JDK 版本、类名、定义加载器、CodeSource 和第一次异常堆栈。',
cases:[
['LOADER-01','常量不触发初始化','目标类有编译期常量和静态输出','只读取常量再读取运行期静态字段','两个操作表现出不同初始化时机','常量可能被内联，不能据此推断类已主动初始化'],
['LOADER-02','显式初始化开关','类尚未主动使用','比较 Class.forName 的 false 和 true 参数','加载与初始化事件能够分开观察','获得 Class 对象不必然执行静态初始化逻辑'],
['LOADER-03','双加载器身份','相同字节码由两个加载器定义','比较 Class 并执行跨类型 cast','名称相同而类型不同，转换被拒绝','定义加载器是类型身份的一部分'],
['LOADER-04','共享接口重复','宿主与插件各自定义同名 API 接口','让插件对象传回宿主并转换','复现类型不兼容并通过共享父级 API 修复','插件边界需要统一交流契约的类型来源'],
['LOADER-05','父优先依赖','父加载器中已有目标依赖版本','仅重写 findClass 后请求同名类','父加载器的类优先被返回','保留 loadClass 委派逻辑时子目录同名文件不一定被读取'],
['LOADER-06','上下文恢复','共享线程执行两个不同插件任务','第一个任务切换加载器后抛异常','第二个任务看到原上下文加载器','finally 恢复同时保护正确查找路径和加载器生命周期'],
['LOADER-07','静态初始化失败','静态初始化有一个确定失败条件','首次主动使用失败后再次使用该类','保存首次根因并解释后续初始化相关错误','后续错误可能只反映此前失败状态而不是新的缺失依赖'],
['LOADER-08','方法签名不一致','编译与运行加载不同版本依赖','调用仅新版本存在的方法','通过实际加载来源定位 NoSuchMethodError','源码依赖声明不能证明运行时选中了相同 Jar'],
['LOADER-09','资源路径冲突','多个 Jar 提供同名服务描述文件','分别查看资源枚举与加载实现','能解释实际发现的实现来源及顺序','类查找和资源查找都参与 SPI，不能只检查 class 文件'],
['LOADER-10','卸载泄漏','插件注册了后台线程与宿主监听器','关闭加载器但先不注销资源，再按正确流程卸载','旧引用链可被定位，正确清理后具备回收条件','关闭文件句柄和解除整个对象图引用是不同生命周期操作']
],end:'## 排错顺序\n\n先确认哪个阶段失败，再确认类来自哪里、由谁定义、为什么仍被引用。生命周期、类型身份和引用链三个维度基本覆盖了类加载器问题的主干，避免把所有异常都归为依赖缺失。',refs:[['JVM 21 规范：加载、连接、初始化','https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-5.html'],['本地延伸：Java 内存区域','Java内存区域详解/Java内存区域详解.md']]},
{
file:'SpringBoot 自动装配原理.md',scope:'Spring Boot 3 的自动配置与 Spring Framework 6；示例使用 Boot 3 风格 imports 注册',
replace:[['return new RedisTemplate<>();','RedisTemplate<String, Object> template = new RedisTemplate<>();\n        template.setConnectionFactory(factory);\n        return template;']],
body:`## 从候选类到 Bean 是几道独立关口

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

Bean 缺失时先找候选类是否出现，再看 negative matches；Bean 重复时检查用户配置、手动 Import 和组件扫描是否重复引入；配置不生效时查看实际 PropertySource 与绑定结果。不要通过开启 Bean 同名覆盖来隐藏类型冲突。Actuator 条件端点可能暴露系统结构，应按环境权限开放，而不是作为公开健康接口。`,
lab:'将默认开启、关闭开关、用户覆盖、缺少依赖和非法属性视为互相独立的装配分支。测试报告要记录 Bean 数量、实际类型、条件结果与容器关闭后的资源状态。',
cases:[
['AUTO-01','默认装配','API 与自动配置模块都在 classpath','不提供自定义 Bean 启动最小上下文','只有一个默认 CatalogClient','候选发现与条件共同决定默认实现是否建立'],
['AUTO-02','属性关闭','依赖保持不变','设置 demo.catalog.enabled=false','不创建默认客户端且不启动后台资源','功能开关应关闭行为而不只是隐藏一个注入入口'],
['AUTO-03','业务覆盖','业务显式定义 CatalogClient','加载相同自动配置','业务实例保留且默认实例退让','MissingBean 是可替换默认实现的核心扩展点'],
['AUTO-04','可选类型缺失','通过过滤类加载器移除 API 或 SDK','尝试加载受类条件保护的配置','没有缺失类型链接错误，相关功能不装配','条件必须放在足够早且不会提前引用缺失类型的边界'],
['AUTO-05','非法时长','timeout 绑定成负 Duration','创建默认客户端','启动明确失败并指出属性错误','类型转换成功不代表业务取值合法'],
['AUTO-06','非法地址','endpoint 使用不允许的协议','执行配置校验','客户端创建前失败而非首次请求时才发现','配置边界应提前拒绝无法使用的资源参数'],
['AUTO-07','imports 漏打包','测试直接导入配置能成功','删除实验 Jar 的候选资源后由独立消费者启动','集成测试发现自动配置不再被自动发现','直接指定配置类的单元测试不能证明资源打包正确'],
['AUTO-08','扫描与导入重叠','自动配置包被业务组件扫描覆盖','同时启用手动 Import 与候选发现','定位重复定义来源并移除不必要入口','装配机制应保持单一清楚入口而不是靠覆盖开关掩盖'],
['AUTO-09','配置优先级','文件与环境变量提供不同 timeout','查看运行绑定值与条件报告','结果符合项目约定的 PropertySource 优先级','源码默认值不是部署后最终生效配置'],
['AUTO-10','资源关闭','客户端实现拥有专用线程池','反复创建和关闭测试上下文','线程数量回落且共享业务池不被误关','资源所有权决定谁负责销毁，自动配置也必须遵守生命周期']
],end:'## 从黑盒变成可解释的默认配置\n\n自动装配本质上是候选发现、条件评估和默认 Bean 退让的组合。一个成熟 Starter 应能解释为什么装配、为什么不装配、怎样覆盖、错误怎样暴露以及资源怎样关闭，而不只是“引入依赖后能启动”。',refs:[['Spring Boot：创建自动配置','https://docs.spring.io/spring-boot/reference/features/developing-auto-configuration.html'],['本地延伸：IoC 与 AOP','IoC%20%26%20AOP/IoC%20%26%20AOP.md']]}
];
for(const a of articles)console.log(writeArticle(a));
