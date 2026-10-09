# 基于 GitLab 的 CI/CD 实战

> 阅读范围：GitLab CI/CD 的 Linux 容器 Runner 示例；生产 Runner、镜像 digest 与 Kubernetes 凭证须由项目配置。故障实验给出机制推导的验收预期，性能数据需在目标环境测量。示例中的业务接口、域名和凭证须接入自己的隔离实验环境。


CI/CD 的目标不是把所有命令搬进流水线，而是让代码从提交、构建、测试到发布拥有稳定、可追溯、可回滚的路径。GitLab CI 的核心配置文件是仓库根目录下的 `.gitlab-ci.yml`，Runner 负责执行其中的 Job。

## 流水线的基本组成

一个 Job 通常包含镜像、脚本、依赖缓存、产物和执行条件；多个 Job 通过 `stages` 形成阶段顺序：

```yaml
stages:
  - verify
  - package
  - image
  - deploy

variables:
  MAVEN_OPTS: "-Dmaven.repo.local=.m2/repository"

cache:
  key: maven-cache
  paths:
    - .m2/repository

test:
  stage: verify
  image: maven:3.9-eclipse-temurin-17
  script:
    - mvn -B test

package:
  stage: package
  image: maven:3.9-eclipse-temurin-17
  script:
    - mvn -B -DskipTests package
  artifacts:
    expire_in: 7 days
    paths:
      - target/*.jar
```

同一阶段的 Job 默认可以并行；后续阶段只有在前一阶段成功后才会执行。需要严格控制依赖关系时，可以使用 `needs` 减少不必要的等待。

## 缓存与产物不是一回事

缓存用于加速下一次流水线，例如 Maven 本地仓库；产物用于把本次构建结果交给后续 Job 或供人工下载。不要把构建目录无条件放进缓存，否则可能把上一次编译结果带进当前构建。

缓存应使用与分支、运行时或锁文件相关的 Key，产物则设置合理的过期时间。发布所需的 Jar、镜像摘要、版本清单等应明确保存，日志和临时文件不必长期保留。

## 构建 Docker 镜像

建议将“编译”和“镜像构建”分开，并让镜像标签包含不可变的提交标识：

```yaml
build-image:
  stage: image
  image: docker:27
  needs:
    - job: package
      artifacts: true
  services:
    - docker:27-dind
  variables:
    DOCKER_TLS_CERTDIR: "/certs"
  script:
    - printf '%s' "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"
    - docker build --pull -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" .
    - docker push "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"
```

生产环境应部署提交 SHA 或镜像 digest，而不是反复覆盖 `latest`。这样可以准确定位线上版本，也能在回滚时直接使用历史镜像。

## 环境变量与密钥

数据库密码、云平台密钥、Kubernetes Token 等必须放在 GitLab 的 CI/CD Variables 中，并根据环境设置保护分支、保护标签和 Mask。不要把密钥写进 `.gitlab-ci.yml`，也不要通过 `echo` 输出完整环境变量。

公开配置可以进入仓库；环境差异配置应在部署阶段注入。对于生产密钥，优先接入 Vault、云密钥管理服务或 Kubernetes Secret，并控制 Runner 的权限范围。

## 按分支控制发布

常见策略是：合并请求执行检查，主分支自动构建，生产发布使用受保护标签并需要人工确认：

```yaml
deploy-prod:
  stage: deploy
  script:
    - ./deploy.sh "$CI_COMMIT_SHA"
  rules:
    - if: '$CI_COMMIT_TAG =~ /^v[0-9]+\.[0-9]+\.[0-9]+$/'
      when: manual
```

`rules` 应明确写出允许发布的条件。不要只依赖 Job 名称或人为约定，否则容易把测试分支误发到生产环境。

## 发布的可回滚性

一次可靠发布至少应具备以下信息：

- 源码提交 SHA、构建时间和依赖版本；
- 镜像地址及 digest；
- 数据库变更版本；
- 配置版本和发布人；
- 健康检查结果与回滚命令。

数据库迁移应优先采用向后兼容的 expand/contract 策略：先增加字段或新表，再发布兼容代码，确认旧版本下线后才删除旧结构。这样可以降低滚动发布期间的兼容风险。

## 常见失败原因

流水线慢，通常先检查缓存命中、镜像拉取和是否重复安装依赖；构建在本地成功而 Runner 失败，重点比较 JDK、Maven、Node、系统权限和时区；部署成功但服务不可用，则要继续检查容器启动日志、readiness 探针、Service 和 Ingress，而不能只看 `kubectl apply` 的返回值。


## 一次发布应该有一个可追溯身份

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
  rules:
    - if: '$CI_COMMIT_TAG || $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
    - when: never
  script:
    - ./mvnw -B -ntp -DskipTests package
    - test -f target/application.jar
  artifacts:
    expire_in: 14 days
    paths: [target/application.jar]

build_image:
  stage: image
  image: $IMAGE_BUILDER_IMAGE
  rules:
    - if: '$CI_COMMIT_TAG || $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'
    - when: never
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
    - if: '$CI_COMMIT_TAG =~ /^v[0-9]+[.][0-9]+[.][0-9]+$/ && $CI_COMMIT_REF_PROTECTED == "true"'
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

失败发布证据应包括 Job ID、commit、digest、事件时间线、Pod 状态和脱敏日志。不要在自动重试里重复执行非幂等数据库迁移。只读验证失败也不能无限回滚重发，先停止扩大影响，明确当前运行状态，再按发布清单恢复。

## 让发布清单与镜像内容一起流转

构建脚本不应仅输出一个可变标签。可以在镜像推送成功后读取实际 digest，生成 dotenv 供后续 Job 使用，同时保存 JSON 清单用于人工审计。dotenv 中不要写秘密，只放产物地址和非敏感元数据。下游部署必须消费同一流水线传来的清单，而不是重新按标签猜测 digest。

下面是镜像已在受控构建环境中完成推送后的发布记录片段。变量由 Runner 或构建系统提供，命令需要在具有 Docker CLI 且能查询相应镜像的环境中运行；它不负责配置 dind，也不授予任何额外权限。

~~~bash
#!/usr/bin/env bash
set -euo pipefail

test -n "$CI_REGISTRY_IMAGE"
test -n "$CI_COMMIT_SHA"
test -n "$CI_PIPELINE_ID"

image_tag="$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"
docker pull "$image_tag"
release_image="$(docker image inspect --format '{{index .RepoDigests 0}}' "$image_tag")"
case "$release_image" in
  *@sha256:*) ;;
  *) echo 'registry digest unavailable' >&2; exit 1 ;;
esac
printf 'RELEASE_IMAGE=%s\n' "$release_image" > release.env

# JSON 应通过可靠序列化器生成，避免 shell 拼接任意字符串。
export RELEASE_IMAGE="$release_image"
node <<'NODE'
const fs=require('node:fs');
const manifest={
  commit:process.env.CI_COMMIT_SHA,
  pipelineId:process.env.CI_PIPELINE_ID,
  image:process.env.RELEASE_IMAGE,
  createdAt:new Date().toISOString(),
  verificationStatus:'awaiting-deployment-verification'
};
fs.writeFileSync('release-manifest.json',JSON.stringify(manifest,null,2)+'\n');
NODE
~~~

示例构建环境同时需要 Node，实际团队可以用 Python、jq 或构建工具的原生输出实现同样目标。多架构镜像需要确认记录的是期望的 manifest list digest 还是某个平台 digest，不要把本机拉取的平台结果误当成全部平台发布身份。

## 手工发布也应遵守同一套约束

紧急修复常常绕开日常路径，直接在终端执行 kubectl set image。若团队允许应急操作，仍应记录提交、镜像、配置、操作者与验证结果，并把最终状态同步回声明式配置来源，否则下一次自动部署可能又覆盖应急修改。手工操作不是免除审计和回滚要求的理由。

环境保护可以要求审批，但审批本身不验证代码或数据库兼容性。审批者应该看到具体镜像、变更摘要、迁移阶段和验证证据，而不是只有一个绿色按钮。流水线中任何可变输入都应在发布前冻结或记录，确保批准的是实际将要部署的内容。

## 依赖供应链与可重建性

固定基础镜像 digest 可以防标签漂移，但并不自动固定 Maven 下载的所有依赖。快照版本、动态版本范围和不受控镜像仓库仍会影响产物。业务允许时使用确定依赖版本与受控仓库，保留依赖清单和漏洞扫描结果。扫描发现问题后也需要评估实际暴露面与升级兼容，不能把扫描报告本身当成修复完成。

构建机器的时区、文件编码和默认 locale 也可能进入测试与产物。把这些设置显式化，能减少“本地成功、Runner 失败”的歧义。需要严格可复现构建时，还要控制归档时间戳、生成文件顺序和构建元数据；仅把源码 checkout 到同一提交，并不能保证字节完全一致。

## 故障注入与验收实验

在测试项目中验证规则与依赖图，在测试命名空间验证发布。每个实验保存实际 Pipeline 和 Job 结果，文章中的清单与配置不表示已经在你的 GitLab 运行过。

### CI-01：合并请求规则

实验前提是提交来自普通开发分支。执行创建合并请求流水线。

通过条件是执行验证但不会获得生产发布权限。这里的判断依据是流水线来源与保护规则共同决定任务边界。

### CI-02：空缓存构建

实验前提是删除专用测试缓存引用。执行完整 Maven 构建。

通过条件是能下载依赖并成功完成。这里的判断依据是缓存应是加速层，不能成为正确构建的唯一来源。

### CI-03：失败测试报告

实验前提是一个测试用例确定失败。执行运行 verify Job。

通过条件是流水线阻断且 JUnit 报告可查看。这里的判断依据是失败路径也要保留证据，不能只保存成功产物。

### CI-04：产物追溯

实验前提是两条流水线同时构建不同提交。执行分别进入镜像构建阶段。

通过条件是各自使用自己的 Jar 与 commit。这里的判断依据是共享目录中的最新文件不提供流水线隔离。

### CI-05：扫描门禁

实验前提是镜像扫描是必要发布条件。执行让扫描失败而镜像构建成功。

通过条件是部署仍被阻止。这里的判断依据是needs 依赖必须包含全部门禁而非仅靠 stage 名称。

### CI-06：受保护标签

实验前提是普通分支能制造类似版本字符串。执行尝试触发生产 Job。

通过条件是非受保护引用无法使用生产权限。这里的判断依据是标签格式是命名规则，不单独构成授权。

### CI-07：变量泄漏

实验前提是任务获得受限测试秘密。执行检查日志、缓存和 artifacts。

通过条件是没有敏感值进入持久输出。这里的判断依据是Mask 不是对恶意代码的完整保护。

### CI-08：并发发布

实验前提是两个生产流水线同时到达部署。执行观察 resource_group 队列。

通过条件是部署串行且过时版本按规则处理。这里的判断依据是发布锁解决并发覆盖但不替代版本顺序策略。

### CI-09：readiness 失败

实验前提是新镜像进程启动但健康接口失败。执行等待 rollout 与业务探测。

通过条件是发布被标记失败并保留 Pod 事件。这里的判断依据是API 接受变更不等于应用具备服务能力。

### CI-10：数据库兼容

实验前提是新版本处于 expand 阶段。执行滚回上一镜像并访问关键路径。

通过条件是旧版本仍能使用当前结构。这里的判断依据是数据库向后兼容是镜像回滚可用的前提。

### CI-11：构建内容变化

实验前提是基础镜像标签指向发生变化。执行比较同源码构建的镜像 digest。

通过条件是清单能揭示实际内容差异。这里的判断依据是提交 SHA 不能单独证明整个构建输入不变。

### CI-12：恢复验证

实验前提是已选定上一稳定发布清单。执行恢复镜像和匹配配置后重新探测。

通过条件是线上版本、健康与业务指标都符合预期。这里的判断依据是回滚操作执行完仍需验证恢复结果。

## 将实验变成可复用的验收规格

下面的 JSON 是与本文章节对应的验收清单，不是测试执行结果。它可保存为版本库中的测试数据，由团队的集成测试适配器读取。`given` 用来建立前置状态，`when` 对应受控操作，`then` 是必须验证的业务结果；不要把自然语言断言直接当成已经执行过的自动化测试。每次框架升级或架构调整，都应根据真实环境重新运行这些场景，并在外部测试报告中记录观察值。

```json
{
  "subject": "基于Gitlab的CI_CD",
  "verificationMode": "integration-with-controlled-faults",
  "resultStatus": "not-executed-in-this-article",
  "cases": [
    {
      "id": "CI-01",
      "scenario": "合并请求规则",
      "given": "提交来自普通开发分支",
      "when": "创建合并请求流水线",
      "then": "执行验证但不会获得生产发布权限"
    },
    {
      "id": "CI-02",
      "scenario": "空缓存构建",
      "given": "删除专用测试缓存引用",
      "when": "执行完整 Maven 构建",
      "then": "能下载依赖并成功完成"
    },
    {
      "id": "CI-03",
      "scenario": "失败测试报告",
      "given": "一个测试用例确定失败",
      "when": "运行 verify Job",
      "then": "流水线阻断且 JUnit 报告可查看"
    },
    {
      "id": "CI-04",
      "scenario": "产物追溯",
      "given": "两条流水线同时构建不同提交",
      "when": "分别进入镜像构建阶段",
      "then": "各自使用自己的 Jar 与 commit"
    },
    {
      "id": "CI-05",
      "scenario": "扫描门禁",
      "given": "镜像扫描是必要发布条件",
      "when": "让扫描失败而镜像构建成功",
      "then": "部署仍被阻止"
    },
    {
      "id": "CI-06",
      "scenario": "受保护标签",
      "given": "普通分支能制造类似版本字符串",
      "when": "尝试触发生产 Job",
      "then": "非受保护引用无法使用生产权限"
    },
    {
      "id": "CI-07",
      "scenario": "变量泄漏",
      "given": "任务获得受限测试秘密",
      "when": "检查日志、缓存和 artifacts",
      "then": "没有敏感值进入持久输出"
    },
    {
      "id": "CI-08",
      "scenario": "并发发布",
      "given": "两个生产流水线同时到达部署",
      "when": "观察 resource_group 队列",
      "then": "部署串行且过时版本按规则处理"
    },
    {
      "id": "CI-09",
      "scenario": "readiness 失败",
      "given": "新镜像进程启动但健康接口失败",
      "when": "等待 rollout 与业务探测",
      "then": "发布被标记失败并保留 Pod 事件"
    },
    {
      "id": "CI-10",
      "scenario": "数据库兼容",
      "given": "新版本处于 expand 阶段",
      "when": "滚回上一镜像并访问关键路径",
      "then": "旧版本仍能使用当前结构"
    },
    {
      "id": "CI-11",
      "scenario": "构建内容变化",
      "given": "基础镜像标签指向发生变化",
      "when": "比较同源码构建的镜像 digest",
      "then": "清单能揭示实际内容差异"
    },
    {
      "id": "CI-12",
      "scenario": "恢复验证",
      "given": "已选定上一稳定发布清单",
      "when": "恢复镜像和匹配配置后重新探测",
      "then": "线上版本、健康与业务指标都符合预期"
    }
  ]
}
```

## 发布能力的衡量方式

能自动部署只是起点。真正成熟的流水线可以解释产物来自哪里、为什么允许发布、失败停在哪一步，以及用哪份完整清单恢复。让这些证据随每次发布产生，比把全部命令压进一个长脚本更可靠。

## 参考资料与继续阅读

- [GitLab CI YAML 参考](https://docs.gitlab.com/ci/yaml/)
- [Kubernetes Service 与工作负载协作](https://kubernetes.io/docs/concepts/services-networking/service/)
