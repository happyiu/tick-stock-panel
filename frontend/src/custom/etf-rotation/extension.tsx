import { lazy, Suspense } from 'react'
import { Repeat2 } from 'lucide-react'
import type { FrontendExtension } from '@/extensions/types'

const Page = lazy(() => import('./Page'))
function RotationPage() {
  return <Suspense fallback={<div className="p-6 text-muted">加载ETF轮动…</div>}><Page /></Suspense>
}
const extension: FrontendExtension = {
  id: 'research.etf-rotation', apiVersion: 1,
  routes: [{ id: 'etf-rotation', path: '/etf-rotation', component: RotationPage }],
  navigation: [{ id: 'etf-rotation', routeId: 'etf-rotation', label: 'ETF轮动', icon: Repeat2, order: 510 }],
}
export default extension
