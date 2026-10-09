const {writeArticle}=require('./compose.cjs');
const articles=[{
file:'i18n多语言异常提示.md',scope:'Spring Boot 3、Spring Framework 6 的 MessageSource 与 HTTP 错误契约',
replace:[['this.code = code;\n        this.args = args;','super(code);\n        this.code = code;\n        this.args = args.clone();'],['资源文件的编码、默认语言、缓存时间和不存在 key 的处理方式应在部署环境中明确配置。','除了带地区的文件，还应提供基础 messages.properties；Boot 的消息源自动配置需要满足基础资源等条件。资源编码、默认语言、缓存时间和缺失 key 行为都应明确配置。']],
body:`## 一条异常要服务三类读者

用户需要可理解的提示，客户端程序需要稳定可判断的错误码，运维需要保留根因与调用上下文。把这三个需求都塞进 Exception.getMessage，会让语言切换影响程序分支，也会让数据库错误泄露给用户。比较稳妥的模型是领域异常携带 code 和安全参数，展示层负责语言，日志层保存内部 cause。

错误码不应直接使用数据库异常类名，也不要把每一句翻译都设计成新的业务状态。比如 ORDER_NOT_FOUND 可以对应中文与英文提示，但 HTTP 状态如何选择还要考虑接口语义和资源枚举风险。权限不足时是否返回 403 或隐藏为 404，应统一约定，不能按语言变化。

## 一份稳定响应契约

下面同时提供 code、message、locale、traceId 和字段错误。机器判断只依赖 code；message 是本次请求的展示结果，不适合存入长期工作流作为条件。字段错误里的 field 应是公开 API 字段名，而不是后端实体属性路径或数据库列名。

~~~json
{
  "code": "STOCK_INSUFFICIENT",
  "message": "商品 SKU-001 库存不足，需要 3 件，可用 1 件",
  "locale": "zh-CN",
  "traceId": "demo-correlation-id",
  "fields": [
    {"field":"quantity","code":"STOCK_INSUFFICIENT",
     "message":"申请数量超过可用库存"}
  ]
}
~~~

金额和日期建议在业务数据字段中保留无歧义结构，例如整数分、币种和 ISO 时间，再由展示层按 Locale 格式化。语言偏好不等于时区、币种或国家，英文用户也可能使用人民币，中文用户也可能位于其他时区。不要从 Accept-Language 推导业务结算币种。

## Locale 决策链必须由一处定义

可以采用用户显式偏好、租户默认、请求协商、系统默认的顺序，也可以让请求显式选择优先；重要的是只有一份规则。输入先经过支持语言白名单，避免把任意语言标签变成动态文件路径。Accept-Language 有权重与通配规则，不应该简单取逗号前第一段或手写 split 后忽略 q 值。

以下 JDK 方法演示支持语言协商，使用 en-US 作为明确回退。账号和租户优先级应在调用这个函数前处理。非法 Header 也落到可预测回退，不让提示系统再次抛错。

~~~java
import java.util.List;
import java.util.Locale;

public final class SupportedLocales {
    private static final List<Locale> SUPPORTED=List.of(
        Locale.forLanguageTag("zh-CN"),Locale.forLanguageTag("en-US"));
    private static final Locale DEFAULT=Locale.forLanguageTag("en-US");
    public static Locale fromAcceptLanguage(String header) {
        if (header==null || header.isBlank() || header.length()>512) return DEFAULT;
        try {
            Locale match=Locale.lookup(Locale.LanguageRange.parse(header),SUPPORTED);
            return match==null ? DEFAULT : match;
        } catch (IllegalArgumentException ignored) {
            return DEFAULT;
        }
    }
}
~~~

LocaleContextHolder 是线程上下文，异步任务和 MQ 不会天然拥有原请求语言。发送邮件任务可在创建时保存收件人语言，任务重试沿用同一版本，避免用户切换设置后半个批次中文、半个批次英文。也可以约定执行时读取最新偏好，两者都合理，但要形成稳定产品规则。

## 消息资源与安全格式化

Spring MessageSource 是资源解析入口，资源包回退、格式参数和应用上下文集成见[官方说明](https://docs.spring.io/spring-framework/reference/core/beans/context-introduction.html)。以下文件故意提供基础语言，避免只写地区文件后自动配置没有按预期生效。

~~~properties
# messages.properties：明确的基础回退
ORDER_NOT_FOUND=Order {0} was not found
STOCK_INSUFFICIENT=Item {0} needs {1} units but only {2} are available
SYSTEM_ERROR=The request could not be completed. Please try again later.
VALIDATION_FAILED=Please check the submitted fields
~~~

~~~properties
# messages_zh_CN.properties
ORDER_NOT_FOUND=订单 {0} 不存在
STOCK_INSUFFICIENT=商品 {0} 库存不足，需要 {1} 件，可用 {2} 件
SYSTEM_ERROR=系统暂时无法完成请求，请稍后重试
VALIDATION_FAILED=请检查提交的字段
~~~

MessageFormat 的单引号具有特殊意义，翻译中的撇号需要按其转义规则处理。参数包含大括号通常作为参数值插入，不应该先把参数拼成模板再二次格式化。不要让用户输入成为消息 key 或格式模板。复杂复数、性别和语序可能超出简单占位符能力，需要专门的国际化格式工具和对应测试，不能靠在数字后面统一加英文 s。

~~~java
public final class BusinessFailure extends RuntimeException {
    private final String code;
    private final Object[] arguments;
    public BusinessFailure(String code,Object... arguments) {
        super(code);
        this.code=java.util.Objects.requireNonNull(code);
        this.arguments=arguments==null ? new Object[0] : arguments.clone();
    }
    public String code() { return code; }
    public Object[] arguments() { return arguments.clone(); }
}

public record ErrorBody(String code,String message,String locale,String traceId) {}

// 放在使用构造器注入 MessageSource 的 ControllerAdvice 中。
@ExceptionHandler(BusinessFailure.class)
ResponseEntity<ErrorBody> handleBusiness(BusinessFailure failure,Locale locale) {
    String message;
    try {
        message=messageSource.getMessage(failure.code(),failure.arguments(),locale);
    } catch (NoSuchMessageException | IllegalArgumentException formatFailure) {
        log.warn("error_message_render_failed code={}",failure.code(),formatFailure);
        message=messageSource.getMessage("SYSTEM_ERROR",null,
            "The request could not be completed",locale);
    }
    ErrorBody body=new ErrorBody(failure.code(),message,
        locale.toLanguageTag(),MDC.get("traceId"));
    return ResponseEntity.status(statusFor(failure.code())).body(body);
}
~~~

这里的 statusFor 是项目维护的错误码到 HTTP 状态映射，不能任意从异常文本推断。回退时保留原 code 便于机器识别，同时记录翻译缺失指标。未知异常单独处理：日志保存完整堆栈，对外返回 SYSTEM_ERROR，不遍历任意 cause 后把内部 message 当成可展示文本。

## 翻译文件也需要版本治理

新增错误码时同步更新基础资源、所有支持语言和契约测试。构建阶段检查 key 集合与占位参数编号，运行时统计缺失翻译。检查占位符不能只靠一个过于简单的正则，因为单引号和嵌套格式有语法；重要模板应实际调用 MessageFormat 解析和渲染。

翻译修改一般不改变机器 code，但参数含义变化就是契约变更。例如 {1} 原来是剩余量、后来变为申请量，旧语言包会给出语法正确但语义相反的提示。消息资源与应用版本应一起发布；若采用动态资源服务，需要缓存版本、回滚与失效策略，不能允许半数实例使用不同参数布局。

HTML 页面应继续对最终提示做输出转义，JSON 接口则交给序列化器处理。国际化不提供 XSS 防护，日志模板也不应把未经校验内容当格式字符串。敏感参数应在进入异常对象前就筛选，避免后续日志无意打印其数组。

## 事务失败与展示失败分开

业务方法仍然抛出让事务按规则回滚的异常，国际化发生在 HTTP 或消息展示边界。不要在事务方法里捕获异常、翻译成字符串并正常返回，除非明确设置回滚或采用了不同事务设计。提示翻译失败也不应该反过来改变已经确定的事务结果。

前端若选择自己翻译，可以接收 code 和安全参数；后端若负责翻译，前端应展示 message 并保留 code 做分支。两套语言包同时承担最终展示时，要定义优先级和缺失回退。对客服系统，保存当时展示语言、错误码和 traceId 有助于还原问题，但不应长期保存全部敏感请求载荷。`,
lab:'用固定错误码分别请求中文、英文和未支持语言。断言 HTTP 状态、code 与事务结果不随语言改变，只有展示文本和 locale 按约定变化。',
cases:[
['I18N-01','中文响应','库存异常携带相同安全参数','以 zh-CN 请求接口','中文文本参数顺序正确，code 保持稳定','语言变化只应影响展示层而不改变机器契约'],
['I18N-02','英文响应','与中文实验使用完全相同业务输入','以 en-US 请求接口','英文可读且与中文表达相同数量关系','逐字翻译不能替代参数语义与语序验证'],
['I18N-03','权重协商','Header 同时包含多个语言与 q 值','通过标准解析器协商受支持语言','结果符合优先级和支持列表','简单截取第一项可能忽略语言协商权重'],
['I18N-04','未知语言','用户提交不支持的语言标签','执行消息解析','使用明确基础语言并返回实际 locale','回退规则不能取决于服务器偶然的系统语言'],
['I18N-05','非法 Header','请求头格式不合法或过长','执行 Locale 决策函数','安全回退且接口不因提示系统再次失败','语言输入同样需要边界校验'],
['I18N-06','缺失翻译','某个语言包缺少一个业务 key','触发对应业务异常','按规则回退并留下缺失指标，保留原 code','缺失文本不应破坏客户端错误识别'],
['I18N-07','格式错误','模板包含错误占位或未转义撇号','解析并渲染代表性参数','构建测试发现问题或运行时可控回退','翻译资源具有格式语法，不能只校验文件存在'],
['I18N-08','敏感参数','内部异常包含 SQL 或 Token','映射成对外错误响应','敏感内容不进入 message 或字段错误','展示参数白名单比依靠最后一步脱敏更可靠'],
['I18N-09','异步语言','邮件任务创建时记录收件人语言','切换用户偏好后重试任务','按既定创建时或执行时策略一致渲染','后台任务没有天然 HTTP Locale，必须显式约定来源'],
['I18N-10','事务回滚','业务写入后触发可回滚异常','分别以两种语言调用','数据回滚结果一致且提示各自正确','事务语义不能由翻译文本或语言分支决定'],
['I18N-11','字段路径','接口使用 quantity 而实体使用库存内部字段','触发参数校验','字段错误引用公开 API 名称','内部实现路径不应泄漏为长期客户端契约'],
['I18N-12','前端分支','同一 code 的 message 被翻译人员修改','运行前端错误处理测试','按钮和流程分支仍然正确','机器逻辑应依赖稳定 code 而非文本包含关系']
],end:'## 多语言设计的长期收益\n\n真正稳定的设计会让新增语言主要改变资源文件和测试，不改变库存、订单与权限业务。错误码、参数语义、语言决策和事务结果各有清楚边界，才能避免一个展示需求扩散到所有服务方法。',refs:[['Spring MessageSource 与应用上下文','https://docs.spring.io/spring-framework/reference/core/beans/context-introduction.html'],['本地延伸：Spring 事务','Spring%20事务/Spring%20事务.md']]},
{
file:'Seata 2.0自定义异常变try to proceed invocation error问题.md',scope:'围绕 Seata 2.0 相关异常包装现象建立诊断流程；未获得真实项目依赖树，不指认某个补丁必然修复',
replace:[['处理器应优先判断业务异常和 cause 链，不能因为顶层类型是 `RuntimeException` 就直接返回系统错误。','处理器应识别顶层业务异常以及经过白名单包装的业务异常；未知包装仍返回系统错误，不能仅凭 cause 深处出现业务类型就无条件解包。'],['@ExceptionHandler(Throwable.class)','@ExceptionHandler(Exception.class)']],
body:`## 先限制结论，再定位问题

公开的[Seata Issue 6488](https://github.com/apache/incubator-seata/issues/6488)记录过同样的异常文本，讨论场景甚至涉及未显式添加全局事务注解的方法。这能证明该现象值得沿代理链调查，却不能证明所有相同文本都有同一原因，更不能仅根据 Issue 已关闭断言自己的依赖组合已修复。

我们需要把现象分成四个独立问题：业务最初抛出了什么；哪个适配层增加了包装；原始对象是否仍在 cause 或 suppressed 中；全局事务最终处于什么状态。接口提示变成通用错误，只是最上层观察。数据回滚失败、异常信息被覆盖和统一处理器分类错误，可以分别存在，也可能同时发生。

## 最小复现矩阵怎样设计

固定一个最小业务异常，分别在没有代理、只有 Spring 本地事务、只有全局事务、叠加 RPC、叠加统一处理器时抛出。每次只增加一个层次。若直接在复杂订单流程里修改多个依赖，很难确认哪一步真正改变了异常形态。

| 维度 | 必须记录的内容 | 为什么影响结论 |
| --- | --- | --- |
| JDK | 完整 vendor 与版本 | 反射、代理与字节码环境 |
| Boot/Framework | 实际解析版本 | 方法拦截与异常包装 |
| Cloud/Alibaba | BOM 与传递依赖 | Client 版本可能被覆盖 |
| Seata Client/Server | 分别记录 | 协议与事务能力不等同 |
| 事务模式 | AT、TCC、Saga 等 | 回滚机制不同 |
| 调用路径 | 本地、Feign、Dubbo | 远程边界改变异常契约 |
| 数据源 | 是否代理、实际连接 | 本地分支是否真正注册 |

构建文件写的版本不是最终运行版本。使用依赖树检查重复 Seata 模块，查看可执行 Jar 内实际库文件，必要时打印 AdapterInvocationWrapper 等实际类的加载来源。命令中的过滤坐标要按项目 groupId 调整，不要把某一时期的包名前缀当成所有版本通用规则。

~~~bash
./mvnw dependency:tree -Dverbose > dependency-tree.txt
./mvnw help:effective-pom > effective-pom.xml
jar tf application.jar > application-entries.txt
~~~

PowerShell 下执行 Maven 参数时应按实际 shell 引用规则加引号。输出文件可能包含私有仓库地址和内部坐标，提交到公开 Issue 前应脱敏，但不要删掉诊断所需的完整版本与调用顺序。

## 观察异常链而不是只打印 message

常见包装包括 InvocationTargetException、CompletionException、ExecutionException 和框架适配异常。getMessage 只代表当前层文本，不能说明原始业务异常消失。cause 链有可能循环或非常深，诊断代码需要按对象身份防环，并设置深度限制。

~~~java
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;

public final class FailureChain {
    public static void inspect(Throwable failure,
            java.util.function.Consumer<String> output) {
        Set<Throwable> seen=Collections.newSetFromMap(new IdentityHashMap<>());
        Throwable current=failure;
        int depth=0;
        while (current!=null && depth<16 && seen.add(current)) {
            output.accept("depth="+depth
                    +", type="+current.getClass().getName()
                    +", suppressed="+current.getSuppressed().length);
            current=current.getCause();
            depth++;
        }
        if (current!=null) output.accept("chain truncated or cyclic");
    }
}
~~~

上面只输出类型和结构，适合不暴露异常内容的诊断摘要；服务端仍应在受控日志中记录完整堆栈。suppressed 可能包含清理阶段或回滚阶段失败，它们不一定是主 cause。不能因为最深层文本看起来像业务提示，就丢弃上层的全局回滚失败信息。

## 安全解包应该是明确映射

统一处理器可以穿过已确认的传输包装，但不能无条件遍历任意异常直到找到 BusinessException。举例来说，上层代表事务系统状态不确定，底层恰好有库存不足异常，此时只向用户返回“库存不足”会掩盖需要人工恢复的数据风险。

下面示例仅允许标准反射与 Future 包装。对于 Seata 适配包装，需要根据已经确认的精确类和版本增加规则；不要通过 message 等于某个英文字符串来授权解包。

~~~java
import java.lang.reflect.InvocationTargetException;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ExecutionException;

public final class KnownWrapperResolver {
    public static Optional<BusinessFailure> resolve(Throwable original) {
        Set<Throwable> seen=Collections.newSetFromMap(new IdentityHashMap<>());
        Throwable current=original;
        for (int depth=0; current!=null && depth<8 && seen.add(current); depth++) {
            if (current instanceof BusinessFailure business) {
                return Optional.of(business);
            }
            if (!isAllowedWrapper(current)) return Optional.empty();
            current=current.getCause();
        }
        return Optional.empty();
    }
    private static boolean isAllowedWrapper(Throwable value) {
        return value instanceof InvocationTargetException
            || value instanceof CompletionException
            || value instanceof ExecutionException;
    }
}
~~~

BusinessFailure 是项目定义的业务异常。这份解析器故意不宣称已经修复 Seata：若实际顶层只是通用 RuntimeException，仍需检查它由谁创建、是否可安全映射。直接放行所有 RuntimeException 等于失去白名单。更根本的处理是修复适配层或采用已验证兼容版本，使异常契约在边界保持清楚。

## 回滚验证要建立数据证据

AT 模式下，可以设计订单表与库存表两个分支：订单创建成功、库存扣减后故意抛异常，再验证两边业务状态恢复。记录 XID、分支 ID、异常时间、TC 决议和重试轨迹。undo_log 是诊断线索，但“表里有记录”或“表里没有记录”都不能独立证明成功，因为它涉及本地事务提交与后续清理时机。

TCC 需要检查 Try 预留、Confirm/Cancel 幂等与空回滚；Saga 则需要检查补偿执行与不可补偿副作用。不要拿 AT 的 undo_log 检查清单去证明所有事务模式正确。业务返回失败后，系统可能仍在异步重试回滚，验收应等待明确终态或记录超时进入人工处理，而不是只在返回后立即查询一次。

~~~text
测试案例 transaction-wrapper-01
  initial: order absent, stock available=10
  action: create order, reserve 2, throw known business failure
  observe:
    requestId and XID are recorded
    original exception type is preserved or explicitly mapped
    global transaction reaches a known rollback outcome
    order does not remain as a successful order
    stock returns to the domain-defined pre-transaction state
    retrying the same request does not create duplicate side effects
  evidence:
    sanitized stack trace
    exact dependency tree
    branch logs and database snapshots
~~~

这是验收格式而不是实测报告。真实业务若采用“订单保留但状态置为失败”的模型，就应修改数据预期，不能机械要求所有行都消失。验证对象始终是领域不变量，而非某张表恰好为空。

## 升级、回退和补丁的决策

升级前保存最小复现与完整依赖锁定结果，阅读对应版本发布说明和变更代码，再验证 Client、Server、Spring 与数据源代理组合。不要仅改一个 jar 版本，留下其他模块继续使用旧版本。回退同样需要检查表结构、协议兼容和已经产生的未完成事务。

临时展示层补救应记录适用版本、解包类型、撤销条件和监控指标。若以后框架已经恢复原始异常，补救逻辑不应继续广泛捕获并改变新异常。不要为保留错误文本关闭全局事务，也不要吞掉异常后正常返回以绕开包装；这样可能让事务走向提交。

长期看，跨服务错误适合稳定错误码与明确结果模型，而不是序列化整个 Java 异常对象。调用者需要区分业务拒绝、依赖不可达和结果不确定。只有把这三类状态分开，重试策略才不会因为一个模糊的英文包装消息而做出错误决定。`,
lab:'这里没有真实应用依赖树，因此实验关注定位路径而非声称已发现唯一根因。每个用例同时验证异常形态、接口契约和事务数据，缺少任意一类证据都不能宣布完整修复。',
cases:[
['SEATA-01','无代理基线','同一个方法直接抛已知业务异常','绕开事务和 RPC 代理调用','记录最原始异常类型与业务码','没有基线就无法确认包装在哪一层发生'],
['SEATA-02','本地事务对照','保持业务方法不变只增加本地事务','再次调用并观察堆栈','区分 Spring 代理行为与全局事务行为','逐层增加机制才能缩小责任范围'],
['SEATA-03','全局事务包装','固定 Client 与 Server 版本','增加全局事务后抛相同异常','记录新增包装层及原异常是否保留','同样的显示文本不能取代完整 cause 链证据'],
['SEATA-04','未注解方法','Bean 因其他方法或配置受到代理','从未标注全局事务的方法抛异常','确认该方法实际经过哪些拦截器','代理作用范围不能只看当前方法上的一个注解'],
['SEATA-05','原始原因丢失','适配层只创建新通用异常而不保留 cause','执行展示层解析','明确判定无法从已丢失对象恢复业务信息','消息映射不能重建框架没有保存的原始异常'],
['SEATA-06','白名单外包装','未知运行时异常内部包住业务异常','调用安全解包器','保留系统错误分类并记录根因','任意 cause 中有业务类型不代表顶层失败可被安全忽略'],
['SEATA-07','循环链保护','人工构造异常环或较深链条','执行诊断遍历','在深度上限或重复对象处终止','诊断工具本身也需要可控资源和终止条件'],
['SEATA-08','AT 数据回滚','订单和库存分支已产生受控修改','抛异常后观察 TC 与最终业务表','事务达到明确终态且领域数据恢复','接口提示恢复与真实回滚成功是独立验收项'],
['SEATA-09','回滚过程失败','注入分支回滚暂时不可达','记录主异常与 suppressed 或附加事务错误','系统保留恢复状态而非仅返回普通业务拒绝','回滚失败可能比最初业务异常更影响后续处理'],
['SEATA-10','远程边界','业务异常通过 RPC 或 HTTP 返回','比较服务端 cause 与客户端收到的契约','明确哪些信息跨边界保留，哪些仅留服务端日志','远程调用不是原始 Java 异常对象的无损传递保证'],
['SEATA-11','版本替换','有一份可重复失败的依赖锁定组合','只按兼容计划升级并重跑相同场景','异常和事务同时符合预期，保留前后依赖证据','Issue 关闭或版本号变大不等价于当前环境已修复'],
['SEATA-12','重复请求','第一次失败后客户端不知道最终结果','使用同一业务请求 ID 再次调用','没有重复订单或不可逆副作用','异常包装修复不能代替请求幂等设计']
],end:'## 真正完成修复的标准\n\n原始错误能够被正确分类，客户端得到稳定契约，事务状态和业务数据都符合预期，并且升级或回退有复现证据。只把 try to proceed invocation error 换成一条友好文案，最多完成了展示层的一部分工作。',refs:[['Seata 官方仓库 Issue 6488','https://github.com/apache/incubator-seata/issues/6488'],['本地延伸：异常国际化','i18n多语言异常提示.md'],['本地延伸：Spring 事务','Spring%20事务/Spring%20事务.md']]}
];
for(const a of articles)console.log(writeArticle(a));
