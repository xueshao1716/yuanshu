export function createTaskEvidenceApi({ service, json, onReview }) {
  return {
    list: res => json(res, 200, service.list()),
    get: (res, id) => json(res, 200, service.get(id)),
    async review(res, id, body) {
      const result = service.review(id, body);
      try { await onReview?.(); }
      catch { result.evolutionError = '策略复核失败，请稍后在进化面板重试；验收记录已经保存'; }
      return json(res, 200, result);
    },
  };
}
