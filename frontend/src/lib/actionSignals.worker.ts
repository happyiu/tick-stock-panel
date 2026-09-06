import { buildActionSignals, type ActionSignalInput } from './actionSignals.ts'

interface ActionSignalWorkerRequest {
  requestId: number
  input: ActionSignalInput
}

self.onmessage = (event: MessageEvent<ActionSignalWorkerRequest>) => {
  const { requestId, input } = event.data
  const result = buildActionSignals(input)
  self.postMessage({ requestId, result })
}

export {}
