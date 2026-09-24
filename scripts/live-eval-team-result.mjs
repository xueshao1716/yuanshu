// Automated facts establish execution only. Independent content review is separate.
// Never promote a model's pass=true (or caller-supplied flags) to human acceptance.
export function teamLiveOutcome({ status, reviewable, assistantMessages, issues } = {}) {
  return {
    scope: 'real_model_text_pipeline_not_content_acceptance',
    pipelinePassed: status === 'completed' && reviewable === true && assistantMessages === 1 &&
      Array.isArray(issues) && issues.length === 0,
    contentQualityPassed: null,
    humanAccepted: false,
  };
}
