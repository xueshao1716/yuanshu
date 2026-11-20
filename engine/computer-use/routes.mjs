import { isLocalMaintenanceApproval } from '../maintenance-approval.mjs';

// 2026-11-20 放权：查看状态、停止可以远程（手机）做——鉴权已由全局令牌把关；
// 开授权（grant / 选窗口 / 读窗口）仍只在本机页面，避免远端在你不在电脑前时打开桌面控制。
export function createComputerRoutes({service,json,readBody}) {
  const handle = (work, localOnly = true) => async (res,req) => {
    res.setHeader?.('Cache-Control','no-store');
    if(localOnly && !isLocalMaintenanceApproval(req)) return json(res,403,{error:'开启电脑操作授权只允许在运行元枢的电脑上操作本机页面；手机上可以查看、批准单步和停止'});
    try {return json(res,200,await work(req));}
    catch(e){return json(res,400,{error:e.message});}
  };
  return [
    ['GET','/api/computer/status',handle(()=>service.status(),false)],
    ['GET','/api/computer/windows',handle(async()=>({windows:await service.windows()}))],
    ['POST','/api/computer/grant',handle(async req=>service.grant(await readBody(req,0.01)))],
    ['POST','/api/computer/target',handle(async req=>service.selectWindow(await readBody(req,0.01)))],
    ['POST','/api/computer/stop',handle(()=>service.stop(),false)],
    ['POST','/api/computer/observe',handle(async req=>service.observe((await readBody(req,0.01))?.sessionId))],
  ];
}
