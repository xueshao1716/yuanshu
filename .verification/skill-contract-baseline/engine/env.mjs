// 环境变量统一入口。
//
// 产品名已统一为「元枢 / Yuanshu」，环境变量前缀从 PI_WEB_* 迁到 YUANSHU_*。
// 但老安装的 shell profile、计划任务、systemd unit 里导出的还是 PI_WEB_*，
// 直接改名会让这些变量被**静默忽略**——端口、监听地址、默认模型悄悄退回默认值，
// 这是最难查的一类故障。所以两个都读，新名优先。
//
// 单独成模块（而不是放在 config.mjs 里）是为了让 engine/ 下的模块也能复用：
// config.mjs 在 import 时会做 resolvePiPackage() 等有副作用的探测，不该被顺带触发。
//
// 文档与新建安装只写 YUANSHU_*；旧名不是"暂存"，是有意长期兼容，别当死代码删掉。

export function env(suffix) {
  // 空白值一律视同未设置：cmd 里 `set VAR= && ...` 会写入一个空格，
  // 当成有效值会让 parseInt 得到 NaN（端口变 null），比"没设置"更难查。
  for (const name of [`YUANSHU_${suffix}`, `PI_WEB_${suffix}`]) {
    const value = process.env[name];
    if (value !== undefined && String(value).trim() !== "") return value;
  }
  return undefined;
}
