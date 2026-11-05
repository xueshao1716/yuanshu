// A read-only projection of the existing knowledge ledger, never a new growth event.
export function createKnowledgeOverview({aibodyRuntime,knowledgeRuntime}) {
  return async scope=>{
    const overview=aibodyRuntime.overview(scope);
    try{return {...overview,knowledge:{available:true,...await knowledgeRuntime.projection(scope)}};}
    catch{return {...overview,knowledge:{available:false,reason:'knowledge_unavailable'}};}
  };
}
