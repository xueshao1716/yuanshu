// Preserve the user's selection while tracking only successful model output.
export function withModelProvenance(writer, requestedModel = null) {
  let actual = null;
  const wrapped = Object.create(writer);
  wrapped.push = (type, data = {}) => {
    if (type === 'model_used' && data.model) actual = data.model;
    if (type === 'model_switched' && data.id) actual = { provider: data.provider || '', id: data.id };
    if (['model_selected', 'model_used', 'model_switched', 'done'].includes(type)) {
      data = { requestedModel, ...data };
      if (type === 'done' && !Object.hasOwn(data, 'model')) data.model = actual;
    }
    return writer.push(type, data);
  };
  return wrapped;
}
