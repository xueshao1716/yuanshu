import { AppProvider } from './store'
import AppLayout from './AppLayout'
import { Toaster } from './components/shell/Toast'
import UpdateNotice from './components/shell/UpdateNotice'
import { CompanionProvider } from './components/xiaoyu/CompanionProvider'

export default function App() {
  return (
    <AppProvider>
      <CompanionProvider>
        <AppLayout />
      </CompanionProvider>
      <UpdateNotice />
      <Toaster />
    </AppProvider>
  )
}
