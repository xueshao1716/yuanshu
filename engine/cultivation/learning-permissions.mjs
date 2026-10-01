export const LEARNING_SCOPE='knowledge:approved-cultivation';
// Reviewing evidence is not permission to disclose it to a model.
export const learningAllowed=(policy,design)=>policy?.dataScopes?.includes(LEARNING_SCOPE)===true&&
  design?.permissions?.dataScopes?.includes(LEARNING_SCOPE)===true;
