// Conservative noise filtering, never a truth/verification classifier.
export const modelOnly=entry=>entry.verified!==true&&entry.sources?.length>0&&
  entry.sources.every(s=>s.authority==='model_output');
export function progressOnly(text) {
  if(typeof text!=='string'||text.length>400)return false;
  const progress=/正在.{0,20}(生成|处理|排队|加载)|后台.{0,12}(生成|处理|运行)|稍等|稍后.{0,8}(显示|返回)|working on it|please wait|in progress/i;
  const material=/原因|错误|失败|验证|核查|证据|结果.{0,6}(是|为|[:：])|\d|https?:|```|\b(error|because|measured|verified|failed)\b/i;
  return progress.test(text)&&!material.test(text);
}
export function autoRetrievable(entry,{sessionId,explicit=false}={}) {
  if(explicit)return true;
  if(!modelOnly(entry))return true;
  if(progressOnly(entry.text))return false;
  if(sessionId&&(entry.sessionId===sessionId||entry.sources.some(s=>s.reference?.sessionId===sessionId)))return false;
  return !/\[知识:[a-f0-9]{8,64}\]/i.test(entry.text);
}
