import { lazy, Suspense } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import type { FrontendExtension } from '@/extensions/types'
const Page = lazy(() => import('@/pages/Indicators').then(m => ({ default: m.Indicators })))
function IndicatorsPage() { return <Suspense fallback={<div className="p-6 text-muted">加载指标…</div>}><Page /></Suspense> }
const extension: FrontendExtension = {
  id: 'chart.indicators', apiVersion: 1,
  routes: [{ id: 'indicators', path: '/indicators', component: IndicatorsPage }],
  navigation: [{ id: 'indicators', routeId: 'indicators', label: '指标', icon: SlidersHorizontal }],
}
export default extension
