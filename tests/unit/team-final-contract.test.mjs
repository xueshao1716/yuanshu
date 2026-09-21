import test from 'node:test'
import assert from 'node:assert/strict'
import { repairVideoFinal, formatShotSeconds } from '../../scripts/team-final-contract.mjs'

test('shot time rendering adds a unit only when the model omitted it', () => {
  assert.equal(formatShotSeconds(3.5), '3.5s')
  assert.equal(formatShotSeconds('0.0–3.5s'), '0.0–3.5s')
  assert.equal(formatShotSeconds('3.5–6.8秒'), '3.5–6.8秒')
  assert.equal(formatShotSeconds('6.8–10.0'), '6.8–10.0s')
})

test('live final contract repairs omitted quality metadata without inventing shots', () => {
  const result = repairVideoFinal({
    task: '写一个 10 秒飞天舞者视频脚本',
    draft: { consistencyKey: '成年舞者，金红服装与双层飘带，暖金逆光', total_sec: 10, aspect: '9:16' },
    final: { title: '飞天', shots: [{ no: 1, sec: 10, prompt: '舞者起舞' }] },
  })
  assert.equal(result.final.aspect, '9:16')
  assert.equal(result.final.total_sec, 10)
  assert.equal(result.final.consistencyKey, '成年舞者，金红服装与双层飘带，暖金逆光')
  assert.ok(result.final.negative.length >= 5)
  assert.match(result.final.text_handling, /后期/)
  assert.ok(result.final.doNotDo.length >= 3)
  assert.equal(result.final.shots.length, 1)
  assert.ok(result.repairs.includes('终稿补回负面清单'))
})

test('existing concrete metadata is preserved while safety defaults are appended', () => {
  const result = repairVideoFinal({
    final: {
      aspect: '9:16', total_sec: 10, consistencyKey: '锁定人物',
      negative: ['不要水印'], text_handling: '不需要字幕', doNotDo: ['不出现观众'],
      shots: [],
    },
  })
  assert.equal(result.final.consistencyKey, '锁定人物')
  assert.equal(result.final.text_handling, '不需要字幕')
  assert.ok(result.final.negative.includes('不要水印'))
  assert.ok(result.final.doNotDo.includes('不出现观众'))
})
