import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import ModelChannels from './ModelChannels'
import ModelSelect from './ModelSelect'

export default function ModelManager({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return <Dialog.Root open={visible} onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 bg-black/55 z-[var(--pi-z-modal)]" />
      <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(94vw,680px)] max-h-[90dvh] overflow-y-auto bg-pi-bg panel !p-4 z-[var(--pi-z-modal)]">
        <div className="flex items-center justify-between gap-3 mb-2">
          <Dialog.Title className="font-semibold text-pi-text">模型与通道</Dialog.Title>
          <Dialog.Close className="btn-tool touch-hit" aria-label="关闭"><X className="w-4 h-4" /></Dialog.Close>
        </div>
        <Dialog.Description className="text-sm text-pi-dim mb-4">接入服务商并选择模型；单模型调用验证请前往模型中心。</Dialog.Description>
        <ModelChannels />
        <div className="flex items-center gap-3 text-sm text-pi-text"><span>当前模型</span><ModelSelect /></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
