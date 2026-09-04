import { Palette } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { getPageSize, setPageSize, useTheme, setTheme, type PageSize, type Theme } from '@/lib/theme'
import { useState } from 'react'

export function SettingsThemePanel() {
  const theme = useTheme()
  const [pageSize, setPageSizeState] = useState<PageSize>(() => getPageSize())

  return (
    <>
      <PageHeader
        title="主题"
        subtitle="管理主题模式和页面显示大小。"
      />

      <section className="rounded-card border border-border bg-surface p-5">
        <div className="flex items-center gap-2 mb-4">
          <Palette className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-medium text-foreground">外观</h3>
        </div>

        <div className="flex items-center justify-between gap-4 py-2">
          <div className="min-w-0">
            <div className="text-sm text-foreground">主题模式</div>
            <div className="text-[11px] text-muted truncate">选择暗色或亮色界面</div>
          </div>
          <select
            aria-label="主题模式"
            value={theme}
            onChange={(e) => setTheme(e.target.value as Theme)}
            className="w-24 h-8 px-1.5 rounded-btn border border-border bg-base text-xs text-foreground"
          >
            <option value="dark">暗色</option>
            <option value="light">亮色</option>
          </select>
        </div>
      </section>

      <section className="rounded-card border border-border bg-surface p-5 mt-6">
        <div className="flex items-center gap-2 mb-4">
          <Palette className="h-4 w-4 text-accent" />
          <h3 className="text-sm font-medium text-foreground">页面大小</h3>
        </div>

        <div className="flex items-center justify-between gap-4 py-2">
          <div className="min-w-0">
            <div className="text-sm text-foreground">页面大小</div>
            <div className="text-[11px] text-muted truncate">大号放大文字和界面布局，图表保持正常交互</div>
          </div>
          <select
            aria-label="页面大小"
            value={pageSize}
            onChange={(e) => {
              const next = e.target.value as PageSize
              setPageSizeState(next)
              setPageSize(next)
            }}
            className="w-24 h-8 px-1.5 rounded-btn border border-border bg-base text-xs text-foreground"
          >
            <option value="standard">标准</option>
            <option value="large">大号</option>
          </select>
        </div>
      </section>
    </>
  )
}
