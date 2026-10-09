const {writeArticle}=require('./compose.cjs');
const articles=[{
file:'基于Gitlab的CI_CD.md',scope:'GitLab CI/CD 的 Linux 容器 Runner 示例；生产 Runner、镜像 digest 与 Kubernetes 凭证须由项目配置',
replace:[['docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"','printf \'%s\' "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"'],['/^v\\\\d+\\\\.\\\\d+\\\\.\\\\d+$/','/^v[0-9]+\\.[0-9]+\\.[0-9]+$/']],
body:`## 一次发布应该有一个可追溯身份

源码提交、Jar、镜像和部署记录需要形成一条可追溯链。提交 SHA 是源码标识，不完全等价于镜像内容：基础镜像标签可变、依赖可变、构建时间进入产物都可能使同一源码产生不同结果。生产部署最好记录镜像 digest，并保存构建工具、依赖锁定和配置版本。

流水线通过并不代表发布成功。前者证明指定 Job 完成，后者还需要服务就绪、关键业务路径与运行指标符合要求。GitLab 的[CI YAML 参考](https://docs.gitlab.com/ci/yaml/)说明 stages、needs、rules 和 artifacts 等字段语义；项目应通过自己的 GitLab 版本执行 CI Lint，避免把文档中新语法用于较旧实例。

## 先让合并请求只验证，再让受保护版本发布

workflow 控制是否创建流水线，Job rules 控制任务是否进入流水线。二者不能混用。一个推送同时产生分支和合并请求流水线，可能重复消耗 Runner；生产 Job 若只凭分支名字判断，还可能在不符合保护要求的上下文出现。

下面配置是可审查的骨架，需要配置 BUILD_IMAGE、IMAGE_BUILDER_IMAGE、DEPLOY_IMAGE 为团队验证过并按 digest 固定的镜像。DEPLOY_IMAGE 需要包含 kubectl，镜像构建步骤采用已有远程构建服务或受控构建脚本，避免把 privileged dind 当成无条件默认。

~~~yaml
workflow:
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
    - if: '$CI_COMMIT_TAG'
    - if: '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
    - when: never

stages: [verify, package, image, deploy]

variables:
  MAVEN_OPTS: "-Dmaven.repo.local=.m2/repository"

default:
  interruptible: true

verify:
  stage: verify
  image: $BUILD_IMAGE
  script:
    - ./mvnw -B -ntp verify
  cache:
    key:
      files: [pom.xml, .mvn/wrapper/maven-wrapper.properties]
    paths: [.m2/repository/]
  artifacts:
    when: always
    expire_in: 7 days
    reports:
      junit: target/surefire-reports/TEST-*.xml

package:
  stage: package
  image: $BUILD_IMAGE
  needs: [verify]
  script:
    - ./mvnw -B -ntp -DskipTests package
    - test -f target/application.jar
  artifacts:
    expire_in: 14 days
    paths: [target/application.jar]

build_image:
  stage: image
  image: $IMAGE_BUILDER_IMAGE
  needs:
    - job: package
      artifacts: true
  script:
    - ./ci/build-image.sh target/application.jar "$CI_COMMIT_SHA"
    - test -s release.env
  artifacts:
    reports:
      dotenv: release.env
    paths: [release-manifest.json]
    expire_in: 30 days

deploy_production:
  stage: deploy
  image: $DEPLOY_IMAGE
  interruptible: false
  needs:
    - job: build_image
      artifacts: true
  resource_group: production
  environment:
    name: production
  rules:
    - if: '$CI_COMMIT_TAG =~ /^v[0-9]+\.[0-9]+\.[0-9]+$/ && $CI_COMMIT_REF_PROTECTED == "true"'
      when: manual
    - when: never
  allow_failure: false
  script:
    - test -n "$RELEASE_IMAGE"
    - kubectl -n production set image deployment/order-service order="$RELEASE_IMAGE"
    - kubectl -n production rollout status deployment/order-service --timeout=180s
    - ./ci/verify-release.sh "$CI_COMMIT_SHA"
~~~

脚本 build-image.sh 和 verify-release.sh 是项目必须实现的集成点，不能仅创建空文件让 Job 变绿。前者应构建并推送镜像、取得 digest、输出 RELEASE_IMAGE 和清单；后者应核对线上版本与关键只读探测。示例假设 Maven finalName 为 application，多模块项目要改为真实产物路径并保存各模块测试报告。

needs 建立的是 DAG 依赖，任务可以绕过不相关阶段等待，因此所有必要门禁必须显式进入依赖链。加入扫描 Job 后，如果部署只依赖镜像构建而没有依赖扫描，就可能在扫描完成前部署。不要只看 stages 从左到右的视觉顺序判断是否安全。

## 缓存命中可以失败，产物关联不能模糊

缓存用于加速，可以为空、过期或未命中。构建必须在空缓存下仍能完成。Artifacts 代表当前流水线的产物，后续 Job 应取同一条依赖链传下来的 Jar，而不是去某个共享目录抓“最近修改的文件”。测试报告即使失败也应保存，方便解释为何阻断发布。

Maven 缓存 key 仅按根 pom 变化可能不足以覆盖多模块和构建环境变化，实际可加入 JDK、架构和依赖锁定策略。缓存不是供应链信任边界，来自不可信分支的可写缓存不能随意与生产受保护 Job 共享。依赖校验和、仓库来源与下载审计也要纳入设计。

## 密钥保护不能只靠 Mask

Masked 变量减少直接日志泄漏，但不能阻止运行在 Job 中的恶意脚本读取并外传变量。Protected 控制在哪些引用上可用，也需要结合受保护 Runner、环境权限和合并请求信任策略。来自外部贡献的代码默认不应获得生产凭证。

优先使用短期身份或工作负载身份，让部署权限限制到目标命名空间和资源类型。不要给一个只更新 Deployment 镜像的 Job 集群管理员权限。不要打印 env 全量排错；只输出无敏感的必要变量名和是否存在。构建缓存与 artifacts 也不能包含配置中的密码。

## 数据库变更决定能否回滚

镜像回滚很快，但数据库已经删除列或重写数据后，旧镜像可能无法启动。expand/contract 的核心是先增加兼容结构，再发布双兼容代码，迁移数据并观察，最后才删除旧结构。每一步都有单独验收和回滚窗口，而不是在同一个部署脚本里先 drop 再启动。

~~~json
{
  "releaseId": "v1.2.3",
  "commit": "record-the-actual-commit-sha",
  "image": "registry.example.invalid/order@sha256:record-the-real-digest",
  "configurationRevision": "config-17",
  "schemaPhase": "expand",
  "previousRelease": "v1.2.2",
  "verification": {"status":"pending","report":"release-check.json"}
}
~~~

该 JSON 是清单格式示例，值必须来自真实构建。不能把配置版本遗漏后只记录镜像，否则同一个镜像配上不同配置就可能产生不同故障。回滚应选择已知历史清单，并再次做 rollout 与业务验证。resource_group 限制生产任务并发，有助于避免新旧发布互相覆盖，但不自动选择最新正确版本，排队顺序与过时流水线处置仍要约定。

## 三类失败分开排查

构建失败看 JDK、Maven、依赖仓库、锁文件和操作系统；镜像失败看构建上下文、注册表权限、网络与 manifest；部署失败看实际镜像、拉取权限、启动日志、探针、Service 与运行配置。kubectl 命令成功只是 API 接受了变更，不是服务已经健康。

失败发布证据应包括 Job ID、commit、digest、事件时间线、Pod 状态和脱敏日志。不要在自动重试里重复执行非幂等数据库迁移。只读验证失败也不能无限回滚重发，先停止扩大影响，明确当前运行状态，再按发布清单恢复。`,
lab:'在测试项目中验证规则与依赖图，在测试命名空间验证发布。每个实验保存实际 Pipeline 和 Job 结果，文章中的清单与配置不表示已经在你的 GitLab 运行过。',
cases:[
['CI-01','合并请求规则','提交来自普通开发分支','创建合并请求流水线','执行验证但不会获得生产发布权限','流水线来源与保护规则共同决定任务边界'],
['CI-02','空缓存构建','删除专用测试缓存引用','执行完整 Maven 构建','能下载依赖并成功完成','缓存应是加速层，不能成为正确构建的唯一来源'],
['CI-03','失败测试报告','一个测试用例确定失败','运行 verify Job','流水线阻断且 JUnit 报告可查看','失败路径也要保留证据，不能只保存成功产物'],
['CI-04','产物追溯','两条流水线同时构建不同提交','分别进入镜像构建阶段','各自使用自己的 Jar 与 commit','共享目录中的最新文件不提供流水线隔离'],
['CI-05','扫描门禁','镜像扫描是必要发布条件','让扫描失败而镜像构建成功','部署仍被阻止','needs 依赖必须包含全部门禁而非仅靠 stage 名称'],
['CI-06','受保护标签','普通分支能制造类似版本字符串','尝试触发生产 Job','非受保护引用无法使用生产权限','标签格式是命名规则，不单独构成授权'],
['CI-07','变量泄漏','任务获得受限测试秘密','检查日志、缓存和 artifacts','没有敏感值进入持久输出','Mask 不是对恶意代码的完整保护'],
['CI-08','并发发布','两个生产流水线同时到达部署','观察 resource_group 队列','部署串行且过时版本按规则处理','发布锁解决并发覆盖但不替代版本顺序策略'],
['CI-09','readiness 失败','新镜像进程启动但健康接口失败','等待 rollout 与业务探测','发布被标记失败并保留 Pod 事件','API 接受变更不等于应用具备服务能力'],
['CI-10','数据库兼容','新版本处于 expand 阶段','滚回上一镜像并访问关键路径','旧版本仍能使用当前结构','数据库向后兼容是镜像回滚可用的前提'],
['CI-11','构建内容变化','基础镜像标签指向发生变化','比较同源码构建的镜像 digest','清单能揭示实际内容差异','提交 SHA 不能单独证明整个构建输入不变'],
['CI-12','恢复验证','已选定上一稳定发布清单','恢复镜像和匹配配置后重新探测','线上版本、健康与业务指标都符合预期','回滚操作执行完仍需验证恢复结果']
],end:'## 发布能力的衡量方式\n\n能自动部署只是起点。真正成熟的流水线可以解释产物来自哪里、为什么允许发布、失败停在哪一步，以及用哪份完整清单恢复。让这些证据随每次发布产生，比把全部命令压进一个长脚本更可靠。',refs:[['GitLab CI YAML 参考','https://docs.gitlab.com/ci/yaml/'],['Kubernetes Service 与工作负载协作','https://kubernetes.io/docs/concepts/services-networking/service/']]},
{
file:'Loki日志系统替代ELK.md',scope:'Loki 的标签流与 LogQL；以 2026-09-30 核对到的官方生命周期为准，新接入使用受支持采集器',
replace:[['生产环境可根据平台选择 Grafana Alloy、Promtail 或其他 OpenTelemetry Collector；具体组件版本应以当前部署方案为准。','新接入优先评估 Grafana Alloy 或受支持的 OpenTelemetry 采集路径。Promtail 已在 2026 年 3 月 2 日结束生命周期，不应继续作为新部署默认方案。'],['统计错误率：','统计错误日志数量（不是错误率）：']],
body:`## “替代”必须从查询需求开始

如果运维主要按服务、环境、时间和 traceId 定位问题，Loki 的标签筛选与正文过滤通常符合习惯；如果经常做跨大量字段的复杂全文分析、任意维度检索和审计取证，就需要逐条评估能力与成本。不能简单宣称 Loki 永远比 ELK 便宜，也不能把“没有为所有正文建索引”理解为查询没有成本。

本文的迁移设计先保留五类真实查询：指定请求排障、某服务错误趋势、业务单号搜索、长时间异常检索和审计导出。用同一日志样本、相同时间范围和并发查询进行对照，再测存储、计算、对象存储请求与运维成本。仅比较日志压缩后的磁盘大小，会遗漏查询计算和网络费用。

## 标签组合决定流数量

Loki 将具有相同标签集合的日志组织为流。service、environment 等低基数字段适合候选标签，traceId、orderId 与用户 ID 通常应留在正文或受支持的结构化元数据中。标签的风险不只看单个字段不同值数量，还看组合数量与随时间变化的速度。[官方标签文档](https://grafana.com/docs/loki/latest/get-started/labels/)解释了这种索引模型。

假设 20 个服务、3 个环境、5 个区域，理论组合为 300；加入每请求唯一的 traceId 后，组合可能接近请求数量。大量短小流增加内存、索引与小块存储压力，也会让查询扇出更大。这个乘法只是容量估算，真实流数量取决于哪些组合实际发生，应该用实际观测校正。

Pod 名称是否当标签也应按环境规模评估，不能一概称为低基数。大规模频繁滚动发布会产生大量新 Pod 值。保留必要定位维度，同时使用结构化字段容纳变化频繁的实例信息，避免为了查询方便把所有 Kubernetes 标签都导入。

## 采集器生命周期需要更新

截至本文核对时间，Promtail 已于 2026 年 3 月 2 日结束生命周期，官方建议迁移到 Alloy 或其他受支持客户端。[Promtail 官方说明](https://grafana.com/docs/loki/latest/send-data/promtail/)提供了这一结论。历史文章里的 Promtail 配置可以帮助理解采集流程，但不能不加说明地当作新生产方案。

采集器读取文件时需要保存位置，处理容器重启、文件轮转和缓冲重放。日志写入成功、采集器读到、发送成功、Loki 接受以及可查询，是多个不同阶段。某个阶段的计数增加不能证明最终不丢失。可以使用具有唯一事件 ID 的 canary 日志端到端核对。

## 结构化日志先保证一条记录可解析

一行一个 JSON 对应用和采集器都更容易处理。异常堆栈作为字符串字段保存，避免多行被拆散。时间字段带明确时区，耗时统一单位，错误码与 message 分开。脱敏尽量在应用源头完成，采集端的补充处理不应成为唯一保护。

~~~json
{"timestamp":"2026-09-30T10:00:00.123Z","level":"INFO","service":"order","environment":"test","event":"request.completed","duration_ms":18,"traceId":"trace-a","status":200}
{"timestamp":"2026-09-30T10:00:01.123Z","level":"ERROR","service":"order","environment":"test","event":"request.completed","duration_ms":1200,"traceId":"trace-b","status":503,"errorCode":"DEPENDENCY_TIMEOUT"}
{"timestamp":"2026-09-30T10:00:02.123Z","level":"INFO","service":"inventory","environment":"test","event":"stock.reserved","duration_ms":12,"traceId":"trace-a","reservationId":"reserve-1"}
~~~

这些是示意数据。真正日志中不应包含长期 Token、完整证件号或任意请求体。traceId 可以公开作为客服线索，但访问日志平台仍需鉴权，不能让知道一个 ID 的用户跨租户读取数据。

## LogQL 从缩小范围开始

先选服务与环境，再缩短时间范围，最后解析 JSON 和过滤字段。正文字符串过滤通常比复杂正则更直接。若每条日志格式一致，可用字段条件表达语义，避免通过搜索 ERROR 单词把用户输入中的普通文本误算成系统错误。

~~~logql
{service="order", environment="test"} |= "DEPENDENCY_TIMEOUT"

{service="order", environment="test"}
  | json
  | traceId="trace-b"

{service="order", environment="test"}
  | json
  | __error__=""
  | duration_ms > 500

sum by (service) (
  count_over_time(
    {environment="test"} | json | __error__="" | level="ERROR" [5m]
  )
)
~~~

错误数量和错误率不同。分母如果是全部日志行，就得到“错误日志占比”，不一定是请求失败率，因为一次请求可以打多行日志。应只统计每个请求唯一的 request.completed 事件，或直接使用请求指标。下面表达的是已定义完成事件的失败比例，仍需处理没有流量时分母为零的展示策略。

~~~logql
sum by (service) (
  count_over_time(
    {environment="test"} | json | __error__=""
      | event="request.completed" | status >= 500 [5m]
  )
)
/
sum by (service) (
  count_over_time(
    {environment="test"} | json | __error__=""
      | event="request.completed" [5m]
  )
)
~~~

JSON 解析失败会产生错误标记，需要统计并处理，而不是默默把不符合格式的日志从指标中排除后宣布错误率下降。提取 duration 后计算分位数还要注意单位和样本质量。日志指标适合补充分析，核心 SLO 通常更适合直接由应用指标记录。

## 持久性从故障时间线理解

WAL 可以帮助 ingester 在某些崩溃场景恢复已接收日志，但不保护应用尚未刷新、采集器尚未读取或缓冲已经丢失的数据。对象存储可靠也不意味着采集链可靠。副本数、写入确认和节点故障域需要一起配置，单机演示不应被误写成高可用生产架构。

日志过期涉及 Loki 保留策略和对象存储生命周期，二者不能随意各自删除一部分数据。对象存储先删除仍被索引引用的块，会影响查询；保留配置错误也可能使数据无限累积。审计日志如果要求不可篡改，应使用相应的存储与访问控制能力，不能因为系统名叫日志平台就默认满足。

## 一个迁移评估清单

~~~yaml
dataset:
  source: sanitized-production-like-sample
  time_window: fixed-24-hours
  required_fields: [timestamp, service, environment, traceId, level]
queries:
  - name: trace_lookup
    scope: one-service-15-minutes
    verify: all-known-event-ids-are-returned
  - name: error_trend
    scope: one-environment-24-hours
    verify: completed-request-denominator-is-consistent
  - name: incident_search
    scope: selected-services-7-days
    verify: query-budget-and-result-completeness
reliability:
  inject: [collector-restart, network-outage, ingestion-throttle]
  verify: [buffer-recovery, duplicate-accounting, missing-event-rate]
cost:
  include: [compute, storage, object-requests, network, operator-time]
cutover:
  prerequisite: comparison-approved-with-recorded-evidence
  rollback: preserve-old-pipeline-and-query-access
~~~

这是评估规格而非已完成结果。双写期间还要防止重复采集同一容器文件，否则计数翻倍可能被误认为业务增长。对于每个迁移查询，记录旧语法、新语法、边界差异和可接受耗时。某类查询迁移后成本过高时，可以保留专用检索路径，不必强迫所有需求只用一个平台。

## 告警与平台自监控

查询告警要定义无数据、查询错误和真正无错误的差别。采集停了时错误日志数量为零，并不表示系统健康。配置 canary、采集丢弃计数、发送重试、Loki 拒绝请求和对象存储错误，才能区分业务安静与监控失明。

租户隔离需要可信网关注入租户信息，不能让任意客户端自行指定平台租户 Header。Grafana 的用户权限、数据源凭证和 Loki 接口暴露范围都要检查。日志里可能包含比业务接口更多内部信息，因此检索权限也应按最小可见范围配置。`,
lab:'使用带唯一事件 ID 的固定日志样本比较旧平台与 Loki。测量查询延迟、完整性、采集故障恢复与总成本，不把空查询结果当作系统无错误。',
cases:[
['LOKI-01','低基数标签','仅服务、环境和区域作为标签','导入固定样本并记录活跃流数','流数量与实际维度组合可解释','标签索引成本来自实际流而非单条日志大小'],
['LOKI-02','高基数对照','在隔离环境准备同一批日志','将 traceId 临时作为标签并对照资源使用','观察流碎片与成本增加后恢复合理模型','请求唯一值会把一条连续流拆成大量短流'],
['LOKI-03','JSON 解析','样本同时包含合法与损坏 JSON','执行字段查询并统计解析错误','错误样本被显式发现而非悄悄消失','字段过滤前提是结构正确，解析失败需要单独观测'],
['LOKI-04','数量与比例','一个请求产生多条日志','比较错误行占比与完成事件失败率','明确两种统计口径不同','日志行数不能天然代表请求总数'],
['LOKI-05','堆栈保留','应用产生带多层 cause 的异常','经过采集与查询后查看完整事件','堆栈与 traceId 保持关联','多行拆分可能让关键根因与主事件分离'],
['LOKI-06','采集器重启','采集器已读到文件中间位置','重启后继续写日志并对比事件 ID','按位置与缓冲机制解释重复和缺失','进程重启恢复能力取决于持久状态而非日志平台名称'],
['LOKI-07','网络中断','Loki 暂时不可达','持续写日志至受控缓冲并恢复网络','已承诺保留的事件最终可查且缓冲有上限','可靠发送需要处理积压与过载，不是无限内存排队'],
['LOKI-08','长范围查询','同一查询可以选择十五分钟或七天','分别执行并记录扫描与延迟','为常用查询选择可接受的范围和预算','不索引全部正文意味着宽范围过滤需要更多读取工作'],
['LOKI-09','保留策略','测试租户有短期保留要求','推进到期并检查索引与对象数据','按配置一致清理且查询行为可解释','对象存储生命周期与平台保留策略必须协同'],
['LOKI-10','采集停止告警','应用仍运行但采集链停止','检查业务错误计数与 canary','平台告警监控失明而不宣布错误归零','无数据和没有错误是不同状态'],
['LOKI-11','租户伪造','客户端能构造租户 Header','尝试访问非授权日志范围','可信入口覆盖或拒绝伪造身份','数据源权限和租户路由都需要真实信任边界'],
['LOKI-12','迁移回退','新旧平台并行且查询映射已保存','模拟新查询路径不可用','能恢复旧检索路径并解释重复采集','切换前保留证据和回退入口降低一次性迁移风险']
],end:'## 以真实查询决定迁移\n\nLoki 的价值取决于标签模型是否符合检索习惯，以及采集、存储和查询链是否可恢复。先把常用问题转换成可比较的查询与指标，再讨论替代范围，才能得到属于自己业务的成本结论。',refs:[['Loki 标签模型','https://grafana.com/docs/loki/latest/get-started/labels/'],['Promtail 生命周期','https://grafana.com/docs/loki/latest/send-data/promtail/'],['本地延伸：TraceId','Spring%20Boot%203原生日志traceId方案.md']]}
];
for(const a of articles)console.log(writeArticle(a));
