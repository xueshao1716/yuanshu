import { isDeepStrictEqual } from 'node:util';

export const IMAGE_EXPERIMENT = {
  id: 'image-identity-v1',
  title: '同一图片的在线预览与本地副本',
  observation: '用户反馈一张生成图片展示两次；排查发现在线预览与下载后的本地副本使用不同地址。',
  evidence: '由该问题构造的固定隔离样例，执行当前图片整理函数；不读取用户会话，不调用生图服务。',
  problem: '地址不同导致同一轮交付重复展示；直接按文件名去重又可能误删不同图片。',
  hypothesis: '仅在有明确成功下载记录和本地交付记录时关联两个地址，可消除重复并保留缺少关联证据的图片。',
  intervention: '对相同输入比较原样展示基线与当前图片整理函数，检查完整图片序列、消息保留及输入不变性。',
  expectation: '成功下载样例从两张变为一张本地图；反例中的独立图片和跨轮展示全部保留。',
  falsification: '重复未消除，或下载失败、工具未完成、不同图片、跨轮展示中任一图片被错误隐藏，或原始输入被修改。',
  scope: '仅支持已列出的图片地址整理场景。不是完整 OPHIS 复现，不代表真实模型效果、训练提速或因果机制已证明。',
};

export function imageExperimentCases() {
  const remote = 'https://images.example.invalid/generated/image.png';
  const other = 'https://other.example.invalid/generated/image.png';
  const target = 'D:/pi-workspace/生成物/图片/实验样例.png';
  const local = '/api/ws/file?path=' + encodeURIComponent('生成物/图片/实验样例.png');
  const tool = { name: 'bash', running: false, isError: false,
    args: { command: `curl -sL -o "${target}" "${remote}"` }, output: 'download complete' };
  const msg = (images, tools = []) => ({ role: 'assistant', text: '实验样例', images, tools });
  const row = (id, label, kind, input, expected) => ({ id, label, kind, input, expected });
  return [
    row('download-alias', '成功下载：在线图与副本合为本地图', 'positive', [msg([remote, local], [tool])], [local]),
    row('signed-path', '相同本地路径的不同签名', 'positive', [msg([local, local + '&sig=old'])], [local]),
    row('failed-download', '下载失败：两张预览均保留', 'counterexample', [msg([remote, local], [{ ...tool, isError: true }])], [remote, local]),
    row('running-download', '工具未完成：不提前合并', 'counterexample', [msg([remote, local], [{ ...tool, running: true }])], [remote, local]),
    row('distinct-images', '同名但不同来源的图片', 'counterexample', [msg([remote, other])], [remote, other]),
    row('separate-turns', '不同用户轮次中的同一图片', 'counterexample', [msg([local]), { role: 'user', text: '再展示' }, msg([local])], [local, local]),
    row('missing-delivery', '没有本地交付记录：保留在线图', 'counterexample', [msg([remote], [tool])], [remote]),
    row('ambiguous-command', '只有相邻地址：不推断下载关系', 'counterexample',
      [msg([remote, local], [{ ...tool, args: { command: `echo "${remote}" "${target}"` } }])], [remote, local]),
  ];
}

const images = rows => rows.flatMap(row => row.images || []);
const withoutImages = rows => rows.map(({ images, ...rest }) => rest);

export function measureImageExperiment(normalize) {
  return imageExperimentCases().map(({ input, expected, ...definition }) => {
    const original = structuredClone(input);
    let output = [], error = null;
    try { output = normalize(input); if (!Array.isArray(output)) throw new Error('结果不是消息数组'); }
    catch (e) { error = String(e.message || e).slice(0, 200); output = []; }
    const actual = images(output);
    const inputUnchanged = isDeepStrictEqual(input, original);
    const messagesPreserved = isDeepStrictEqual(withoutImages(output), withoutImages(original));
    return { ...definition, beforeCount: images(original).length, afterCount: actual.length,
      expected, actual, inputUnchanged, messagesPreserved, error,
      passed: !error && inputUnchanged && messagesPreserved && isDeepStrictEqual(actual, expected) };
  });
}

// Derive the conclusion from measurements, never from a submitted PASS label.
export function checkedImageMeasurements(rows) {
  const definitions = imageExperimentCases();
  return definitions.map((def, i) => {
    const row = rows[i];
    const passed = row?.id === def.id && row.inputUnchanged === true && row.messagesPreserved === true && !row.error
      && isDeepStrictEqual(row.actual, def.expected) && row.afterCount === def.expected.length
      && row.beforeCount === images(def.input).length;
    return { ...row, id: def.id, label: def.label, kind: def.kind, passed };
  });
}

export function imageMeasurementsSupported(rows) {
  return Array.isArray(rows) && rows.length === imageExperimentCases().length && checkedImageMeasurements(rows).every(row => row.passed);
}
