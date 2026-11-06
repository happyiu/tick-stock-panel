import { lazy, Suspense } from 'react'
import { PieChart } from 'lucide-react'
import type { FrontendExtension } from '@/extensions/types'

const Page = lazy(() => import('./AssetAllocation'))
function AssetAllocationPage() {
  return <Suspense fallback={<div className="p-6">加载资产配置…</div>}><Page /></Suspense>
}

const extension: FrontendExtension = {
  id: 'portfolio.asset-allocation',
  apiVersion: 1,
  routes: [{ id: 'asset-allocation', path: '/asset-allocation', component: AssetAllocationPage }],
  navigation: [{ id: 'asset-allocation', routeId: 'asset-allocation', label: '资产配置', icon: PieChart }],
}

export default extension
