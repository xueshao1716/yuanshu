# 写真人像陪伴：预览版验收

日期：2026-09-26。范围仅《系统2.txt》第1项。

## 产物和来源

- 请求通道：元枢已配置 aieyra-image，模型别名 gpt-image-2.5-sunburst。别名是请求事实，不代表对上游底层模型的独立认证。
- 生成方式：imagegen 自带 CLI，generate 母图，再 edit 同图提取人物。无自制绘图 API 包装、无凭据入库。
- 提示词：`portrait-safe-preview-prompt.txt`、`portrait-cutout-prompt.txt`；`portrait-source-prompt.txt` 保留被拒绝的原设定。
- 母图：`output/imagegen/yuanshu-staircase-source.png`，941×1672 RGB。
- 编辑原始返回：`output/imagegen/yuanshu-cutout-green.png`，941×1672 RGBA。文件名来自原绿底计划，但实际返回透明背景；全透明像素占68.25%。
- 网页母图：`frontend/public/assets/portraits/yuanshu-staircase-v1.webp`，941×1672，67,042字节，不裁切；使用 React 静态资源白名单，免鉴权加载。
- 网页立绘：`frontend/public/assets/portraits/yuanshu-cutout-v1.webp`，432×768 RGBA，33,866字节；保留服务端alpha、裁空白边缘并缩小。未使用黑底色键试验产物。
- 可复现转换：`python scripts/prepare-portrait-assets.py`，断言透明通道、解码、尺寸及体积。

## 已验证

- TDD：先得到3项新契约失败，再接入后通过。原6项公仔测试保持通过。
- 隔离 `npm run verify`：2200/2200测试通过，类型检查和构建通过（新增素材契约之前的完整运行）。
- 新增素材契约进一步检查两个WebP随构建打包及预览文字。
- Impeccable changed-file detect：无发现。保持原设计token、44px面板触控目标、焦点样式。
- 实际Chrome，1440×900和390×844，均通过：素材解码、既存roam偏好下保持静止、不翻转、面板不越界且无横向溢出、下载、打开完整图、旧皮肤偏好保留、ESC关闭并归还焦点、减少动态、拖动保存、两类图片加载失败回退。页面脚本错误0。
- 截图保留在 `tmp/portrait-browser/`；测试用临时静态端口和模拟API，未操作真实会话。
- 主目录合并后隔离验证：2244/2244，类型检查和构建通过。随后静态路径回归先红后绿，4/4；路径修正后再次类型检查、线上构建、双尺寸浏览器测试和设计检测通过。
- 正式服务发现 `/portraits/` 被鉴权拦截，改为现有 `/assets/portraits/` 静态入口，未修改鉴权规则。8787 的首页与两张图片免鉴权请求均为200，SHA256与本次构建一致，无需重启。

## 明确未完成或未宣称

- 当前是全覆盖黑衣与平底鞋的替代预览；原文镂空/薄丝袜/无鞋设定未实现。
- 当前会话view_image返回“不支持图像输入”，因此人物一致性、面部、手部、发丝边缘和整体美观**未经过人工/视觉验收**。不得称为最终形象定稿。
- 仅网页内可选陪伴皮肤，不是Windows独立透明桌宠；没有替换默认皮肤、系统身份或情绪表现。
- 不重启后端、不重新打包原生客户端、不推送远端；本项不进入第2–7项。

## 附带诊断（不在本项修复范围）

Impeccable当前版本不读取 `.impeccable/config.json` 中的 `ignoreRules`、`_comment`；本次未修改该配置。
