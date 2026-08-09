export type Bounds = {
  min: [number, number, number]
  max: [number, number, number]
}

export type MeshSummary = {
  name: string
  triangles: number
  bounds: Bounds
  positions: Float32Array
}

export type GeneratorSettings = {
  blockCount: number
  objectScale: number
  pinDiameter: number
  pinPitch: number
  pinHeight: number
  socketClearance: number
}

export type ConnectorPosition = { x: number; y: number; z: number }

export type GeneratedFile = { name: string; buffer: ArrayBuffer; triangles: number }

export type WorkerRequest =
  | { type: 'LOAD_STL'; buffer: ArrayBuffer; name: string }
  | { type: 'GENERATE_BLOCKS'; settings: GeneratorSettings }

export type WorkerResponse =
  | { type: 'PROGRESS'; message: string }
  | { type: 'STL_LOADED'; mesh: MeshSummary }
  | { type: 'GENERATION_COMPLETE'; files: GeneratedFile[]; connectors: ConnectorPosition[][] }
  | { type: 'ERROR'; message: string }
