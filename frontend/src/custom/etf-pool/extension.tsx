import { lazy, Suspense } from 'react'
import { Layers } from 'lucide-react'
import type { FrontendExtension } from '@/extensions/types'

const Page = lazy(() => import('@/pages/ETFPool').then(m => ({ default: m.ETFPool })))

function ETFPoolPage() {
  return <Suspense fallback={<div className="p-6 text-muted">加载 ETF 池…</div>}><Page /></Suspense>
}

const extension: FrontendExtension = {
  id: 'catalog.etf-pool',
  apiVersion: 1,
  routes: [{ id: 'etf-pool', path: '/etf-pool', component: ETFPoolPage }],
  navigation: [{ id: 'etf-pool', routeId: 'etf-pool', label: 'ETF池', icon: Layers }],
}

export default extension
