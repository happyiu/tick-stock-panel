export interface WavePoint { date: string; confirmedAt: string; value: number; label: string }
export interface WavePosition { lastCompleted: string; active: string | null; direction: 'up' | 'down'; status: 'forming' | 'unresolved'; explanation: string }
export interface WaveNode { label: string; start: WavePoint; end: WavePoint; children: WaveNode[]; validation: string; expected?: string }
export interface WaveCandidate { displayDepth?: number; pattern?: string; degree?: number; score?: { total: number; template: number; fibonacci: number; recency: number };  currentPosition?: WavePosition; waveTree?: WaveNode[]; validation?: { level: string; passed: string[]; pending: string[] }; projections?: { ratio: number; value: number; kind: string }[]; provisionalInvalidation?: { date: string; price: number; boundary: number; direction: string }; id: string; direction: string; stage: string; status: string; points: WavePoint[]; rules: string[]; nextCondition: string; invalidation: { value: number | null; direction: string; reason: string } }
export interface WaveAnalysis { dowConfluence?: string; counts?: WaveCandidate[]; status: string; candidates: WaveCandidate[]; invalidated: WaveCandidate[]; issues: string[]; isProvisional?: boolean; coverageStart: string | null; dataThrough: string | null }

export interface WaveBundle { comparison?: WaveComparison; version: string; symbol: string; asset_type: string; asOf: string; periods: Record<string, WaveAnalysis>; coherence: string; snapshotId?: string; saved: boolean }

export interface WaveComparison { status: string; summary: string; reasons: string[]; coverage: { period: string; label: string; bars: number; candidates: number; start: string | null; end: string | null; adjustment: string; provider?: string; stale: boolean }[] }
