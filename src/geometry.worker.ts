/// <reference lib="webworker" />

import Module from 'manifold-3d'
import type { Bounds, ConnectorPosition, GeneratedFile, GeneratorSettings, WorkerRequest, WorkerResponse } from './types'

const scope = self as unknown as DedicatedWorkerGlobalScope
let sourcePositions: Float32Array | null = null
let sourceName = 'model'

function post(message: WorkerResponse, transfer?: Transferable[]) { scope.postMessage(message, transfer ?? []) }
function fail(message: string) { post({ type: 'ERROR', message }) }

function boundsOf(positions: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = Math.min(min[axis], positions[i + axis]); max[axis] = Math.max(max[axis], positions[i + axis])
  }
  return { min, max }
}

function isBinaryStl(buffer: ArrayBuffer) {
  if (buffer.byteLength < 84) return false
  const triangleCount = new DataView(buffer).getUint32(80, true)
  return 84 + triangleCount * 50 === buffer.byteLength
}

function parseBinary(buffer: ArrayBuffer) {
  const view = new DataView(buffer); const triangleCount = view.getUint32(80, true); const positions = new Float32Array(triangleCount * 9)
  let offset = 84; let target = 0
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    offset += 12
    for (let vertex = 0; vertex < 3; vertex += 1) { positions[target++] = view.getFloat32(offset, true); positions[target++] = view.getFloat32(offset + 4, true); positions[target++] = view.getFloat32(offset + 8, true); offset += 12 }
    offset += 2
  }
  return positions
}

function parseAscii(buffer: ArrayBuffer) {
  const values: number[] = []
  for (const match of new TextDecoder().decode(buffer).matchAll(/vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g)) values.push(Number(match[1]), Number(match[2]), Number(match[3]))
  if (!values.length || values.length % 9 || values.some(Number.isNaN)) throw new Error('유효한 ASCII 또는 Binary STL 파일을 읽을 수 없습니다.')
  return new Float32Array(values)
}

function makeSourceMesh(wasm: Awaited<ReturnType<typeof Module>>, positions: Float32Array) {
  const vertices: number[] = []; const indices: number[] = []; const known = new Map<string, number>()
  // STL repeats vertices per triangle. Weld exactly matching vertices before handing it to Manifold.
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]; const y = positions[i + 1]; const z = positions[i + 2]
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`
    let index = known.get(key)
    if (index === undefined) { index = vertices.length / 3; known.set(key, index); vertices.push(x, y, z) }
    indices.push(index)
  }
  return new wasm.Mesh({ numProp: 3, vertProperties: new Float32Array(vertices), triVerts: new Uint32Array(indices) })
}

function pointInside(point: [number, number], loops: number[][][]) {
  let inside = false
  for (const loop of loops) for (let i = 0, previous = loop.length - 1; i < loop.length; previous = i++) {
    const a = loop[i]; const b = loop[previous]
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
  }
  return inside
}

function distanceToEdges(point: [number, number], loops: number[][][]) {
  let distance = Infinity
  for (const loop of loops) for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i]; const b = loop[(i + 1) % loop.length]; const dx = b[0] - a[0]; const dy = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)))
    distance = Math.min(distance, Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy)))
  }
  return distance
}

function connectorPlan(source: any, bounds: Bounds, settings: GeneratorSettings) {
  const plans: ConnectorPosition[][] = []
  const { min, max } = bounds
  const requiredMargin = settings.pinDiameter / 2 + settings.socketClearance + 0.5
  for (let interfaceIndex = 1; interfaceIndex < settings.blockCount; interfaceIndex += 1) {
    const z = min[2] + ((max[2] - min[2]) * interfaceIndex) / settings.blockCount
    const sections = [-settings.pinHeight * 0.55, 0, settings.pinHeight * 0.55].map((offset) => {
      const section = source.slice(z + offset); const polygons = section.toPolygons() as number[][][]; section.delete(); return polygons
    })
    const plan: ConnectorPosition[] = []
    const centerX = (min[0] + max[0]) / 2; const centerY = (min[1] + max[1]) / 2
    const firstX = centerX + Math.ceil((min[0] - centerX) / settings.pinPitch) * settings.pinPitch
    const firstY = centerY + Math.ceil((min[1] - centerY) / settings.pinPitch) * settings.pinPitch
    for (let x = firstX; x <= max[0]; x += settings.pinPitch) for (let y = firstY; y <= max[1]; y += settings.pinPitch) {
      const point: [number, number] = [x, y]
      if (sections.every((loops) => pointInside(point, loops) && distanceToEdges(point, loops) >= requiredMargin)) plan.push({ x, y, z })
    }
    plans.push(plan)
  }
  return plans
}

function binaryStl(mesh: { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array }) {
  const triangles = mesh.triVerts.length / 3; const buffer = new ArrayBuffer(84 + triangles * 50); const view = new DataView(buffer); view.setUint32(80, triangles, true)
  let offset = 84
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const ids = [mesh.triVerts[triangle * 3], mesh.triVerts[triangle * 3 + 1], mesh.triVerts[triangle * 3 + 2]]
    const p = ids.map((id) => [mesh.vertProperties[id * mesh.numProp], mesh.vertProperties[id * mesh.numProp + 1], mesh.vertProperties[id * mesh.numProp + 2]])
    const ux = p[1][0] - p[0][0]; const uy = p[1][1] - p[0][1]; const uz = p[1][2] - p[0][2]; const vx = p[2][0] - p[0][0]; const vy = p[2][1] - p[0][1]; const vz = p[2][2] - p[0][2]
    const length = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) || 1
    view.setFloat32(offset, (uy * vz - uz * vy) / length, true); view.setFloat32(offset + 4, (uz * vx - ux * vz) / length, true); view.setFloat32(offset + 8, (ux * vy - uy * vx) / length, true); offset += 12
    for (const vertex of p) { view.setFloat32(offset, vertex[0], true); view.setFloat32(offset + 4, vertex[1], true); view.setFloat32(offset + 8, vertex[2], true); offset += 12 }
    view.setUint16(offset, 0, true); offset += 2
  }
  return buffer
}

async function generate(settings: GeneratorSettings) {
  if (!sourcePositions) throw new Error('먼저 STL 파일을 불러와 주세요.')
  post({ type: 'PROGRESS', message: 'Initializing the robust geometry engine…' })
  const wasm = await Module(); wasm.setup()
  const bounds = boundsOf(sourcePositions); const source = new wasm.Manifold(makeSourceMesh(wasm, sourcePositions))
  const connectors = connectorPlan(source, bounds, settings)
  const margin = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) * 0.02 + 1
  const files: GeneratedFile[] = []
  try {
    for (let index = 0; index < settings.blockCount; index += 1) {
      post({ type: 'PROGRESS', message: `Creating watertight block ${index + 1} of ${settings.blockCount}…` })
      const lower = bounds.min[2] + ((bounds.max[2] - bounds.min[2]) * index) / settings.blockCount
      const upper = bounds.min[2] + ((bounds.max[2] - bounds.min[2]) * (index + 1)) / settings.blockCount
      const cutter = wasm.Manifold.cube([bounds.max[0] - bounds.min[0] + margin * 2, bounds.max[1] - bounds.min[1] + margin * 2, upper - lower], false).translate(bounds.min[0] - margin, bounds.min[1] - margin, lower)
      let block = source.intersect(cutter); cutter.delete()
      // Lower blocks carry pins on top. Upper blocks receive matching cylindrical sockets underneath.
      if (index < settings.blockCount - 1) for (const pin of connectors[index]) {
        const shape = wasm.Manifold.cylinder(settings.pinHeight + 0.6, settings.pinDiameter / 2, settings.pinDiameter / 2, 24).translate(pin.x, pin.y, pin.z - 0.6)
        const next = block.add(shape); block.delete(); shape.delete(); block = next
      }
      if (index > 0) for (const pin of connectors[index - 1]) {
        const radius = settings.pinDiameter / 2 + settings.socketClearance
        const shape = wasm.Manifold.cylinder(settings.pinHeight + 0.2, radius, radius, 24).translate(pin.x, pin.y, pin.z - 0.02)
        const next = block.subtract(shape); block.delete(); shape.delete(); block = next
      }
      const result = block.getMesh(); const buffer = binaryStl(result); const triangles = result.triVerts.length / 3; block.delete()
      files.push({ name: `${sourceName.replace(/\.stl$/i, '')}_block_${String(index + 1).padStart(2, '0')}.stl`, buffer, triangles })
    }
  } finally { source.delete() }
  post({ type: 'GENERATION_COMPLETE', files, connectors }, files.map((file) => file.buffer))
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    if (event.data.type === 'LOAD_STL') {
      post({ type: 'PROGRESS', message: 'STL geometry is being parsed in the worker…' })
      const positions = isBinaryStl(event.data.buffer) ? parseBinary(event.data.buffer) : parseAscii(event.data.buffer)
      sourcePositions = positions.slice(); sourceName = event.data.name
      const mesh = { name: sourceName, triangles: positions.length / 9, bounds: boundsOf(positions), positions }
      post({ type: 'STL_LOADED', mesh }, [positions.buffer])
    }
    if (event.data.type === 'GENERATE_BLOCKS') await generate(event.data.settings)
  } catch (error) { fail(error instanceof Error ? error.message : 'Geometry generation failed.') }
}
