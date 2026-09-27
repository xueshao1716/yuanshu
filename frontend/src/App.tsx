import { AppProvider } from './store'
import AppLayout from './AppLayout'
import { Toaster } from './components/Toast'
import UpdateNotice from './components/UpdateNotice'
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
