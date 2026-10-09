# 基于 GitLab 的 CI/CD 实战

CI/CD 的目标不是把所有命令搬进流水线，而是让代码从提交、构建、测试到发布拥有稳定、可追溯、可回滚的路径。GitLab CI 的核心配置文件是仓库根目录下的 `.gitlab-ci.yml`，Runner 负责执行其中的 Job。

## 一、流水线的基本组成

一个 Job 通常包含镜像、脚本、依赖缓存、产物和执行条件；多个 Job 通过 `stages` 形成阶段顺序：

```yaml
stages:
  - verify
  - package
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

## 二、缓存与产物不是一回事

缓存用于加速下一次流水线，例如 Maven 本地仓库；产物用于把本次构建结果交给后续 Job 或供人工下载。不要把构建目录无条件放进缓存，否则可能把上一次编译结果带进当前构建。

缓存应使用与分支、运行时或锁文件相关的 Key，产物则设置合理的过期时间。发布所需的 Jar、镜像摘要、版本清单等应明确保存，日志和临时文件不必长期保留。

## 三、构建 Docker 镜像

建议将“编译”和“镜像构建”分开，并让镜像标签包含不可变的提交标识：

```yaml
build-image:
  stage: package
  image: docker:27
  services:
    - docker:27-dind
  variables:
    DOCKER_TLS_CERTDIR: "/certs"
  script:
    - docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"
    - docker build --pull -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" .
    - docker push "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"
```

生产环境应部署提交 SHA 或镜像 digest，而不是反复覆盖 `latest`。这样可以准确定位线上版本，也能在回滚时直接使用历史镜像。

## 四、环境变量与密钥

数据库密码、云平台密钥、Kubernetes Token 等必须放在 GitLab 的 CI/CD Variables 中，并根据环境设置保护分支、保护标签和 Mask。不要把密钥写进 `.gitlab-ci.yml`，也不要通过 `echo` 输出完整环境变量。

公开配置可以进入仓库；环境差异配置应在部署阶段注入。对于生产密钥，优先接入 Vault、云密钥管理服务或 Kubernetes Secret，并控制 Runner 的权限范围。

## 五、按分支控制发布

常见策略是：合并请求执行检查，主分支自动构建，生产发布使用受保护标签并需要人工确认：

```yaml
deploy-prod:
  stage: deploy
  script:
    - ./deploy.sh "$CI_COMMIT_SHA"
  rules:
    - if: '$CI_COMMIT_TAG =~ /^v\\d+\\.\\d+\\.\\d+$/'
      when: manual
```

`rules` 应明确写出允许发布的条件。不要只依赖 Job 名称或人为约定，否则容易把测试分支误发到生产环境。

## 六、发布的可回滚性

一次可靠发布至少应具备以下信息：

- 源码提交 SHA、构建时间和依赖版本；
- 镜像地址及 digest；
- 数据库变更版本；
- 配置版本和发布人；
- 健康检查结果与回滚命令。

数据库迁移应优先采用向后兼容的 expand/contract 策略：先增加字段或新表，再发布兼容代码，确认旧版本下线后才删除旧结构。这样可以降低滚动发布期间的兼容风险。

## 七、常见失败原因

流水线慢，通常先检查缓存命中、镜像拉取和是否重复安装依赖；构建在本地成功而 Runner 失败，重点比较 JDK、Maven、Node、系统权限和时区；部署成功但服务不可用，则要继续检查容器启动日志、readiness 探针、Service 和 Ingress，而不能只看 `kubectl apply` 的返回值。

## 总结

GitLab CI/CD 的关键是把质量门禁、不可变构建产物、环境隔离和回滚能力固化下来。配置文件只是入口，真正的成熟度取决于：流水线是否可重复、版本是否可追踪、失败是否能定位、发布是否能安全撤回。
