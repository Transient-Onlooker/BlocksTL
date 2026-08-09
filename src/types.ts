export type Bounds = {
  min: [number, number, number]
  max: [number, number, number]
}

export type MeshSummary = {
  name: string
  triangles: number
  bounds: Bounds
  previewPositions: Float32Array
}

export type FitLevel = 19 | 20 | 21

export type GeneratorSettings = {
  blockCount: number
  objectScale: number
  fitLevel: FitLevel
}

export type ConnectorPosition = { x: number; y: number; z: number }

export type GeneratedFile = { name: string; buffer: ArrayBuffer; triangles: number }

export type QaProjection = { width: number; height: number; pixels: Uint8Array }

export type BlockPreview = {
  index: number
  triangles: number
  topConnectorCount: number
  bottomConnectorCount: number
  top: QaProjection
  bottom: QaProjection
  side: QaProjection
}

export type WorkerRequest =
  | { type: 'LOAD_STL'; buffer: ArrayBuffer; name: string }
  | { type: 'GENERATE_BLOCKS'; settings: GeneratorSettings }
  | { type: 'GENERATE_FIT_TEST' }

export type WorkerResponse =
  | { type: 'PROGRESS'; message: string }
  | { type: 'STL_LOADED'; mesh: MeshSummary }
  | { type: 'GENERATION_STARTED'; blockCount: number }
  | { type: 'BLOCK_GENERATED'; preview: BlockPreview }
  | { type: 'GENERATION_COMPLETE'; files: GeneratedFile[]; connectors: ConnectorPosition[][] }
  | { type: 'FIT_TEST_COMPLETE'; files: GeneratedFile[] }
  | { type: 'ERROR'; message: string }
