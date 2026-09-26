# 2.116.6 日常学习入账发布验收

日期：2026-09-26。范围：发布已批准的学习入账及证据闸门，不新增自主付费探索，不改未发布的心情面板，不实施延后的跨系统集成。

## 代码与隔离

- 功能提交 `b95afec8`，版本及构建提交 `692b0b0e`。
- 在独立 `release/learning-2.116.6` 工作树验收并构建，主目录未提交的 MoodOrb/MoodPanel 源码、测试、Unreleased 日志均未纳入。
- 主目录部署前的完整 frontend/dist 和 CHANGELOG 已备份到 `D:/pi-workspace/.build-cache/release-evidence-2.116.6-20260926/`。
- 发布快照保留最近入口的资源；线上另保留旧资源，避免打开中的页面懒加载断链。没有清空线上 dist。

## 发布副本验收

- `npm run verify`：2197/2197测试通过，50套件，0失败/跳过/取消；类型检查与隔离构建通过。源码指纹 `4844a3f3d2fce8c75a4d573ca158c729a81e29c181e6f0650f05b32142db7a0c`，部署前复读仍为 passed。
- 该干净副本只有26个受控技能；旧主目录2231测试口径含本地额外文件，不混称同一次结果。
- Impeccable 对 LearningIntakePanel、ActivityFeed、Apps 的检测返回空结果。
- 隔离浏览器实测：经验搜索、每20条分页、待提炼任务展开；390px宽度无横向溢出。未声明截图人工视觉验收。
- 源码/版本文件 diff check 通过。生成JS内有15处模板空白行警告，未手改带哈希构建资源。

## 线上验收

- 14:57（本机UTC+8）使用既有重启入口恢复服务；核对重启前活动数为0。
- `/api/frontend-version` 返回 appVersion=2.116.6、version=2116006。
- 首页与线上磁盘 index 相同，149个当前可达JS/CSS资源逐字节HTTP比对通过。
- `/api/agent/events`：60条持久/合并活动，activeCount=0；不等同于60次学习成功。
- `/api/learning-intake/status`：候选125、待补记0、失败0；采集ok=true、running=false、failed=0。候选仅为待提炼引用，不是已验证知识。
- 启动后真实采集记录时间06:59:38Z：scanned=1、succeeded=1、failed=0；这验证了一次后台采集，不等同于长期无人值守验收。
- 持续约54秒的6次健康探测全部成功，耗时10–3483ms；复测无重试。手机公网入口HTTP 200，未登录手机端进行真实交互验收。

## 明确未解决的运行风险

- 首轮上线探测连续超时，事件循环日志确认启动后一次43587ms停顿；随后仍见数秒停顿。重启前旧实例也存在停顿，但尚未证明新旧实例原因相同。
- 第一次资源检查曾出现 ECONNRESET；使用新连接重验149资源和健康探测全部通过。这不能消除长期连接/负载风险。
- 本发布不声称“服务长期稳定问题已修好”，也不声称后台已具备持续无人值守自进化。

## 安装包与远端

- Windows：`D:/pi-workspace/安装包/元枢_2.116.6_x64-setup.exe`，11998244字节，包内ProductVersion/FileVersion均为2.116.6；SHA256=`8244A9B5CC2B749CD65B0CCED506FCD119B8F352F0F299972B1195E20836B167`。NSIS构建退出0，未做安装运行测试，Authenticode未签名。
- Gitee 已推送并回读确认 `692b0b0e2fb47f338ea860c75bbb19dd7aa34f19`。GitHub多次直连出现连接超时、ECONNRESET/低速中断；本机7890代理未监听，尚未完成GitHub同步，不能称双推成功。
- Android：`D:/pi-workspace/安装包/元枢-v2.116.6-arm64.apk`，17385935字节，包内versionName=2.116.6、versionCode=2116006、arm64-v8a；SHA256=`A841EF18676B95ED92775AF525389FB777FCD70BC2365B382C0A31AFB1F3EF35`。Gradle最终退出0，下载缓存单元测试3/3通过，16KB ZIP对齐核验通过，APK v2/v3签名通过。
- Android沿用上一版Android Debug证书（SHA256=`794311754e7420551ff205eef390facea93b051e40b0d58c220512a5ad7bfe33`），不是正式生产证书；没有连接设备，未做真机安装/覆盖升级测试。

### Android独立构建环境修复

- 首次Gradle编译失败于缺失`generated/TauriActivity.kt`，不是业务代码类型错误；后续Context/Activity错误是基类缺失的连锁结果。
- 干净工作树不携带被Git忽略的生成文件，共享Rust缓存本次未在新目录补齐该文件。检查锁定版本为Tauri 2.11.5后，将主目录现有文件与该版本`mobile/android-codegen/TauriActivity.kt`替换包名后的内容逐字比较，完全一致才复制到发布工作树。
- 使用现有`-ResumePackaging`继续Gradle打包和单元测试；未修改第三方缓存、业务源码或伪造构建成功状态。首次失败日志保留在证据目录`android-first-failure.log`。此为本次构建环境恢复，不声称已实现通用的跨工作树缓存自动修复。
- 签名脚本在Windows PowerShell 5.1下读取无BOM脚本中的中文输出路径时返回Bad pathname，确认目标APK未产生后，用PowerShell 7.6.5运行同一脚本成功；签名、版本、对齐与测试结果均已核验后才交付。

## 本地证据

`D:/pi-workspace/.build-cache/release-evidence-2.116.6-20260926/` 保存隔离验证日志、指纹、构建日志、live-verification.json及部署前备份。原始业务正文及凭据未写入发布文档。
