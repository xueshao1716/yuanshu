// The same public contract is sent to both chat engines. It grants no authority;
// validateDesign and the live identity/policy gates remain authoritative.
export const curriculumItemHint = '非空字符串；分阶段课程请把阶段、标题、内容和过关标准完整写入同一字符串，不要传对象';
const text = (maxLength = 4000) => ({type:'string', minLength:1, maxLength, pattern:'^(?![\\s\\S]*[\\x00-\\x08])[\\s\\S]*\\S[\\s\\S]*$'});
const strings = (minItems = 0) => ({type:'array', items:text(), minItems, maxItems:32, uniqueItems:true});
const object = properties => ({type:'object', additionalProperties:false, properties, required:Object.keys(properties)});
const media = () => object({description:text(), asset:{anyOf:[{type:'null'},
  object({id:text(200), version:{type:'integer', minimum:1, maximum:Number.MAX_SAFE_INTEGER}})]}});
export const CULTIVATION_DESIGN_SCHEMA = object({
  name:text(120), rationale:text(), goals:strings(1),
  curriculum:{...strings(1), description:curriculumItemHint,
    examples:[['阶段1：核对证据；内容：区分事实与假设；过关标准：逐项提供可核查来源']]},
  temporaryExpression:text(), observation:text(), recovery:text(),
  appearance:media(), clothing:media(), voice:media(),
  permissions:object({model:text(200), tools:strings(), dataScopes:strings(), remote:{type:'boolean'},
    costUpperBoundCents:{type:'integer', minimum:0, maximum:Number.MAX_SAFE_INTEGER}}),
  protectedProposalRefs:strings(),
});
