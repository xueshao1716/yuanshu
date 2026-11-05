// Real HTTP request "close" can mean its body was fully consumed; only the
// response closing, an aborted body, or the run manager's synthetic close stops us.
export const knowledgeRequestStopped=(req,res)=>Boolean(req.aborted||
  req.destroyed&&req.complete!==true||res.destroyed||res.writableEnded);

export async function withKnowledgeRequest(req,res,read){
  const controller=new AbortController();
  const stop=()=>controller.abort();
  const close=()=>{if(knowledgeRequestStopped(req,res))stop();};
  req.on('aborted',stop);req.on('close',close);res.on('close',stop);res.on('finish',stop);
  try{
    close();return await read(controller.signal);
  }finally{
    req.removeListener('aborted',stop);req.removeListener('close',close);
    res.removeListener('close',stop);res.removeListener('finish',stop);
  }
}
