import test from "node:test";
import assert from "node:assert/strict";
import { messagesToDirectChat, handleWorkshopUiChat, modelKeyFromRequest } from "../../engine/workshop-ui-chat.mjs";

test('workshop explicit model wins over another tab cookie; unknown model is rejected', async () => {
  assert.equal(modelKeyFromRequest({headers:{cookie:'yuanshu-ui-model=other/old'}},{model:'test/current'}),'test/current');
  let code; await handleWorkshopUiChat({json:(_r,c)=>{code=c},getModelList:()=>[],defaultModel:{provider:'test',id:'default'},directChat:()=>{throw Error('must not call')}},{},{model:'missing/model',messages:[{role:'user',content:'hi'}]});
  assert.equal(code,400);
});

test("messagesToDirectChat：系统提示 + 末条用户，中间进历史", () => {
  const got = messagesToDirectChat([
    { role: "system", content: "你是画师" },
    { role: "user", content: "先画首页" },
    { role: "assistant", content: "好" },
    { role: "user", content: "再画设置" },
  ]);
  assert.equal(got.systemHint, "你是画师");
  assert.equal(got.message, "再画设置");
  assert.deepEqual(got.history, [
    { role: "user", content: "先画首页" },
    { role: "assistant", content: "好" },
  ]);
});

test("handleWorkshopUiChat：按 provider/id 选元枢模型，回 OpenAI choices", async () => {
  const flash = { provider: "sensenova", id: "flash", name: "Flash" };
  const glm = { provider: "zhipu", id: "glm-5", name: "GLM" };
  let seen = null;
  const res = { code: 0, body: null };
  await handleWorkshopUiChat({
    json: (r, code, body) => { r.code = code; r.body = body; },
    defaultModel: glm,
    getModelList: () => [glm, flash],
    directChat: async (model, message, history, opts) => {
      seen = { model, message, history, opts };
      return { text: "{\"ok\":true}" };
    },
  }, res, {
    model: "sensenova/flash",
    messages: [{ role: "system", content: "json" }, { role: "user", content: "画一页" }],
  });
  assert.equal(res.code, 200);
  assert.equal(res.body.choices[0].message.content, "{\"ok\":true}");
  assert.equal(seen.model, flash);
  assert.equal(seen.message, "画一页");
  assert.equal(seen.opts.systemHint, "json");
});
