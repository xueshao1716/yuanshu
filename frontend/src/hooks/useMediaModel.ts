import { useEffect, useState } from 'react'
import type { Model } from '../types'
import { mediaModels, modelKey, selectMediaModel } from '../../../shared/model-selection.mjs'

export function useMediaModel(models: Model[], kind: 'image' | 'video') {
  const choices: Model[] = mediaModels(models, kind)
  const [selection, setSelection] = useState<string | null>(() => choices[0] ? modelKey(choices[0]) : null)
  const firstKey = choices[0] ? modelKey(choices[0]) : null
  useEffect(() => { if (selection === null && firstKey) setSelection(firstKey) }, [selection, firstKey])
  const selectedModel: Model | undefined = selectMediaModel(models, kind, selection)
  return { choices, selection: selection || '', setSelection, selectedModel, modelKey }
}
