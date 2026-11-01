import { lazy, Suspense } from 'react'
import { BarChart3 } from 'lucide-react'
import type { FrontendExtension } from '@/extensions/types'

const Page = lazy(() => import('./VolumeAnalysis'))
function VolumeAnalysisPage() {
  return <Suspense fallback={<div className="p-6 text-muted">加载量能分析…</div>}><Page /></Suspense>
}

const extension: FrontendExtension = {
  id: 'analysis.volume', apiVersion: 1,
  routes: [{ id: 'volume-analysis', path: '/volume-analysis', component: VolumeAnalysisPage }],
  navigation: [{ id: 'volume-analysis', routeId: 'volume-analysis', label: '量能分析', icon: BarChart3 }],
}
export default extension
