import { isLocalMaintenanceApproval } from '../maintenance-approval.mjs';

export function createComputerRoutes({service,json,readBody}) {
  const handle = work => async (res,req) => {
    res.setHeader?.('Cache-Control','no-store');
    if(!isLocalMaintenanceApproval(req)) return json(res,403,{error:'电脑操作只允许在运行元枢的电脑上使用本机页面；不接受远程或代理请求'});
    try {return json(res,200,await work(req));}
    catch(e){return json(res,400,{error:e.message});}
  };
  return [
    ['GET','/api/computer/status',handle(()=>service.status())],
    ['GET','/api/computer/windows',handle(async()=>({windows:await service.windows()}))],
    ['POST','/api/computer/grant',handle(async req=>service.grant(await readBody(req,0.01)))],
    ['POST','/api/computer/target',handle(async req=>service.selectWindow(await readBody(req,0.01)))],
    ['POST','/api/computer/stop',handle(()=>service.stop())],
    ['POST','/api/computer/observe',handle(async req=>service.observe((await readBody(req,0.01))?.sessionId))],
  ];
}
