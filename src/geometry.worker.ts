/// <reference lib="webworker" />

import Module from 'manifold-3d'
import { CONNECTOR_PROFILE, pinDiameterFor, springCellSize } from './connectorProfile'
import type { Bounds, ConnectorPosition, FitLevel, GeneratedFile, GeneratorSettings, WorkerRequest, WorkerResponse } from './types'

const scope = self as unknown as DedicatedWorkerGlobalScope
const fitLevels: FitLevel[] = [19, 20, 21]
let sourcePositions: Float32Array | null = null
let sourceName = 'model'

function post(message: WorkerResponse, transfer?: Transferable[]) { scope.postMessage(message, transfer ?? []) }
function fail(message: string) { post({ type: 'ERROR', message }) }

function boundsOf(positions: Float32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis], positions[i + axis])
      max[axis] = Math.max(max[axis], positions[i + axis])
    }
  }
  return { min, max }
}

function isBinaryStl(buffer: ArrayBuffer) {
  if (buffer.byteLength < 84) return false
  const triangleCount = new DataView(buffer).getUint32(80, true)
  return 84 + triangleCount * 50 === buffer.byteLength
}

function parseBinary(buffer: ArrayBuffer) {
  const view = new DataView(buffer)
  const triangleCount = view.getUint32(80, true)
  const positions = new Float32Array(triangleCount * 9)
  let offset = 84
  let target = 0
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    offset += 12
    for (let vertex = 0; vertex < 3; vertex += 1) {
      positions[target++] = view.getFloat32(offset, true)
      positions[target++] = view.getFloat32(offset + 4, true)
      positions[target++] = view.getFloat32(offset + 8, true)
      offset += 12
    }
    offset += 2
  }
  return positions
}

function parseAscii(buffer: ArrayBuffer) {
  const values: number[] = []
  for (const match of new TextDecoder().decode(buffer).matchAll(/vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g)) {
    values.push(Number(match[1]), Number(match[2]), Number(match[3]))
  }
  if (!values.length || values.length % 9 || values.some(Number.isNaN)) throw new Error('유효한 ASCII 또는 Binary STL 파일을 읽을 수 없습니다.')
  return new Float32Array(values)
}

function makeSourceMesh(wasm: Awaited<ReturnType<typeof Module>>, positions: Float32Array) {
  const vertices: number[] = []
  const indices: number[] = []
  const known = new Map<string, number>()
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]
    const y = positions[i + 1]
    const z = positions[i + 2]
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`
    let index = known.get(key)
    if (index === undefined) {
      index = vertices.length / 3
      known.set(key, index)
      vertices.push(x, y, z)
    }
    indices.push(index)
  }
  return new wasm.Mesh({ numProp: 3, vertProperties: new Float32Array(vertices), triVerts: new Uint32Array(indices) })
}

function pointInside(point: [number, number], loops: number[][][]) {
  let inside = false
  for (const loop of loops) {
    for (let i = 0, previous = loop.length - 1; i < loop.length; previous = i++) {
      const a = loop[i]
      const b = loop[previous]
      if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside
    }
  }
  return inside
}

function cross(a: [number, number], b: [number, number], c: [number, number]) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function segmentsIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]) {
  const epsilon = 1e-7
  const abC = cross(a, b, c)
  const abD = cross(a, b, d)
  const cdA = cross(c, d, a)
  const cdB = cross(c, d, b)
  const between = (value: number, edgeA: number, edgeB: number) => value >= Math.min(edgeA, edgeB) - epsilon && value <= Math.max(edgeA, edgeB) + epsilon
  const onSegment = (p: [number, number], q: [number, number], r: [number, number]) => Math.abs(cross(p, q, r)) <= epsilon && between(r[0], p[0], q[0]) && between(r[1], p[1], q[1])
  if (onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b)) return true
  return (abC > 0) !== (abD > 0) && (cdA > 0) !== (cdB > 0)
}

function footprintFits(center: [number, number], loops: number[][][]) {
  const cell = springCellSize()
  const halfX = cell.width / 2 + CONNECTOR_PROFILE.edgeSafetyMm
  const halfY = cell.depth / 2 + CONNECTOR_PROFILE.edgeSafetyMm
  const rectangle: [number, number][] = [
    [center[0] - halfX, center[1] - halfY],
    [center[0] + halfX, center[1] - halfY],
    [center[0] + halfX, center[1] + halfY],
    [center[0] - halfX, center[1] + halfY],
  ]
  if (!pointInside(center, loops) || !rectangle.every((point) => pointInside(point, loops))) return false
  for (const loop of loops) {
    for (const point of loop) {
      if (point[0] >= center[0] - halfX && point[0] <= center[0] + halfX && point[1] >= center[1] - halfY && point[1] <= center[1] + halfY) return false
    }
    for (let loopIndex = 0; loopIndex < loop.length; loopIndex += 1) {
      const edgeA = loop[loopIndex] as [number, number]
      const edgeB = loop[(loopIndex + 1) % loop.length] as [number, number]
      for (let rectangleIndex = 0; rectangleIndex < rectangle.length; rectangleIndex += 1) {
        if (segmentsIntersect(edgeA, edgeB, rectangle[rectangleIndex], rectangle[(rectangleIndex + 1) % rectangle.length])) return false
      }
    }
  }
  return true
}

function connectorPlan(source: any, bounds: Bounds, settings: GeneratorSettings) {
  const plans: ConnectorPosition[][] = []
  const { min, max } = bounds
  const p = CONNECTOR_PROFILE
  const socketDepth = p.pinHeightMm + p.socketExtraDepthMm
  const depthOffsets = [-p.pinEmbedMm * 0.9, 0.05]
  for (let depth = 0.8; depth < socketDepth; depth += 0.8) depthOffsets.push(depth)
  depthOffsets.push(socketDepth - 0.05)

  for (let interfaceIndex = 1; interfaceIndex < settings.blockCount; interfaceIndex += 1) {
    const z = min[2] + ((max[2] - min[2]) * interfaceIndex) / settings.blockCount
    const sections = depthOffsets.map((offset) => {
      const section = source.slice(z + offset)
      const polygons = section.toPolygons() as number[][][]
      section.delete()
      return polygons
    })
    const plan: ConnectorPosition[] = []
    const centerX = (min[0] + max[0]) / 2
    const centerY = (min[1] + max[1]) / 2
    const firstX = centerX + Math.ceil((min[0] - centerX) / p.connectorPitchMm) * p.connectorPitchMm
    const firstY = centerY + Math.ceil((min[1] - centerY) / p.connectorPitchMm) * p.connectorPitchMm
    for (let x = firstX; x <= max[0]; x += p.connectorPitchMm) {
      for (let y = firstY; y <= max[1]; y += p.connectorPitchMm) {
        if (sections.every((loops) => loops.length > 0 && footprintFits([x, y], loops))) {
          if (plan.length >= 160) throw new Error('한 분할면의 결합부가 160개를 넘습니다. 출력 크기나 블록 수를 줄여 주세요.')
          plan.push({ x, y, z })
        }
      }
    }
    if (!plan.length) throw new Error(`분할면 ${interfaceIndex}에 스프링 소켓 전체를 안전하게 배치할 공간이 없습니다. 블록 수를 줄이거나 출력 크기를 키워 주세요.`)
    plans.push(plan)
  }
  return plans
}

function addMalePin(wasm: any, block: any, pin: ConnectorPosition, fitLevel: FitLevel) {
  const p = CONNECTOR_PROFILE
  const radius = pinDiameterFor(fitLevel) / 2
  const root = wasm.Manifold.cylinder(p.pinEmbedMm, radius + p.pinRootReliefMm, radius + p.pinRootReliefMm, 32)
    .translate(pin.x, pin.y, pin.z - p.pinEmbedMm)
  const collar = wasm.Manifold.cylinder(p.pinRootCollarHeightMm, radius + p.pinRootReliefMm, radius, 32)
    .translate(pin.x, pin.y, pin.z)
  const shaft = wasm.Manifold.cylinder(p.pinHeightMm - p.pinLeadInMm - p.pinRootCollarHeightMm, radius, radius, 32)
    .translate(pin.x, pin.y, pin.z + p.pinRootCollarHeightMm)
  const lead = wasm.Manifold.cylinder(p.pinLeadInMm, radius, radius * 0.74, 32)
    .translate(pin.x, pin.y, pin.z + p.pinHeightMm - p.pinLeadInMm)
  const rooted = root.add(collar)
  const body = rooted.add(shaft)
  const shape = body.add(lead)
  root.delete()
  collar.delete()
  rooted.delete()
  shaft.delete()
  body.delete()
  lead.delete()
  const next = block.add(shape)
  block.delete()
  shape.delete()
  return next
}

function addSpringSocket(wasm: any, block: any, pin: ConnectorPosition) {
  const p = CONNECTOR_PROFILE
  const cell = springCellSize()
  const socketDepth = p.pinHeightMm + p.socketExtraDepthMm
  const cavity = wasm.Manifold.cube([cell.width, cell.depth, socketDepth + 0.08], false)
    .translate(pin.x - cell.width / 2, pin.y - cell.depth / 2, pin.z - 0.04)
  const entrance = wasm.Manifold.cube([cell.width + 0.5, cell.depth + 0.5, p.socketLeadInMm + 0.04], false)
    .translate(pin.x - (cell.width + 0.5) / 2, pin.y - (cell.depth + 0.5) / 2, pin.z - 0.04)
  const socketVoid = cavity.add(entrance)
  cavity.delete()
  entrance.delete()
  let next = block.subtract(socketVoid)
  block.delete()
  socketVoid.delete()
  block = next

  const beamStart = pin.z + p.socketLeadInMm * 0.45
  const beamLength = socketDepth - p.socketLeadInMm * 0.45 + 0.25
  const leftBeam = wasm.Manifold.cube([p.springThicknessMm, p.springBeamWidthMm, beamLength], false)
    .translate(pin.x - p.springGapMm / 2 - p.springThicknessMm, pin.y - p.springBeamWidthMm / 2, beamStart)
  const rightBeam = wasm.Manifold.cube([p.springThicknessMm, p.springBeamWidthMm, beamLength], false)
    .translate(pin.x + p.springGapMm / 2, pin.y - p.springBeamWidthMm / 2, beamStart)
  const springs = leftBeam.add(rightBeam)
  leftBeam.delete()
  rightBeam.delete()
  next = block.add(springs)
  block.delete()
  springs.delete()
  return next
}

function binaryStl(mesh: { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array }) {
  const triangles = mesh.triVerts.length / 3
  const buffer = new ArrayBuffer(84 + triangles * 50)
  const view = new DataView(buffer)
  view.setUint32(80, triangles, true)
  let offset = 84
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const ids = [mesh.triVerts[triangle * 3], mesh.triVerts[triangle * 3 + 1], mesh.triVerts[triangle * 3 + 2]]
    const points = ids.map((id) => [mesh.vertProperties[id * mesh.numProp], mesh.vertProperties[id * mesh.numProp + 1], mesh.vertProperties[id * mesh.numProp + 2]])
    const ux = points[1][0] - points[0][0]
    const uy = points[1][1] - points[0][1]
    const uz = points[1][2] - points[0][2]
    const vx = points[2][0] - points[0][0]
    const vy = points[2][1] - points[0][1]
    const vz = points[2][2] - points[0][2]
    const length = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) || 1
    view.setFloat32(offset, (uy * vz - uz * vy) / length, true)
    view.setFloat32(offset + 4, (uz * vx - ux * vz) / length, true)
    view.setFloat32(offset + 8, (ux * vy - uy * vx) / length, true)
    offset += 12
    for (const vertex of points) {
      view.setFloat32(offset, vertex[0], true)
      view.setFloat32(offset + 4, vertex[1], true)
      view.setFloat32(offset + 8, vertex[2], true)
      offset += 12
    }
    view.setUint16(offset, 0, true)
    offset += 2
  }
  return buffer
}

function exportFile(manifold: any, name: string): GeneratedFile {
  const result = manifold.getMesh()
  return { name, buffer: binaryStl(result), triangles: result.triVerts.length / 3 }
}

async function generate(settings: GeneratorSettings) {
  if (!sourcePositions) throw new Error('먼저 STL 파일을 불러와 주세요.')
  post({ type: 'PROGRESS', message: '여러 깊이에서 결합부 안전 영역을 분석하고 있습니다…' })
  const wasm = await Module()
  wasm.setup()
  const scaledPositions = new Float32Array(sourcePositions.length)
  for (let index = 0; index < sourcePositions.length; index += 1) scaledPositions[index] = sourcePositions[index] * settings.objectScale
  const bounds = boundsOf(scaledPositions)
  const source = new wasm.Manifold(makeSourceMesh(wasm, scaledPositions))
  const margin = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) * 0.02 + 1
  const blockHeight = (bounds.max[2] - bounds.min[2]) / settings.blockCount
  if (blockHeight < CONNECTOR_PROFILE.pinHeightMm + CONNECTOR_PROFILE.roofThicknessMm) {
    source.delete()
    throw new Error('블록 한 층이 결합부보다 얇습니다. 블록 수를 줄이거나 출력 크기를 키워 주세요.')
  }
  const files: GeneratedFile[] = []
  try {
    const connectors = connectorPlan(source, bounds, settings)
    for (let index = 0; index < settings.blockCount; index += 1) {
      post({ type: 'PROGRESS', message: `블록 ${index + 1}/${settings.blockCount} 생성 중…` })
      const lower = bounds.min[2] + ((bounds.max[2] - bounds.min[2]) * index) / settings.blockCount
      const upper = bounds.min[2] + ((bounds.max[2] - bounds.min[2]) * (index + 1)) / settings.blockCount
      const cutter = wasm.Manifold.cube([bounds.max[0] - bounds.min[0] + margin * 2, bounds.max[1] - bounds.min[1] + margin * 2, upper - lower], false)
        .translate(bounds.min[0] - margin, bounds.min[1] - margin, lower)
      let block = source.intersect(cutter)
      cutter.delete()
      if (index < settings.blockCount - 1) for (const pin of connectors[index]) block = addMalePin(wasm, block, pin, settings.fitLevel)
      if (index > 0) for (const pin of connectors[index - 1]) block = addSpringSocket(wasm, block, pin)
      const name = `${sourceName.replace(/\.stl$/i, '')}_block_${String(index + 1).padStart(2, '0')}.stl`
      files.push(exportFile(block, name))
      block.delete()
    }
    post({ type: 'GENERATION_COMPLETE', files, connectors }, files.map((file) => file.buffer))
  } finally {
    source.delete()
  }
}

async function generateFitTest() {
  post({ type: 'PROGRESS', message: '19·20·21 맞춤 테스트 조각을 만들고 있습니다…' })
  const wasm = await Module()
  wasm.setup()
  const files: GeneratedFile[] = []
  const p = CONNECTOR_PROFILE
  const width = 14
  const baseHeight = 3
  const femaleHeight = p.pinHeightMm + p.socketExtraDepthMm + p.roofThicknessMm
  for (const level of fitLevels) {
    let male = wasm.Manifold.cube([width, width, baseHeight], true).translate(0, 0, baseHeight / 2)
    male = addMalePin(wasm, male, { x: 0, y: 0, z: baseHeight }, level)
    files.push(exportFile(male, `fit_${level}_male_${pinDiameterFor(level).toFixed(1)}mm.stl`))
    male.delete()

    let female = wasm.Manifold.cube([width, width, femaleHeight], true).translate(0, 0, femaleHeight / 2)
    female = addSpringSocket(wasm, female, { x: 0, y: 0, z: 0 })
    const printableFemale = female.rotate(180, 0, 0).translate(0, 0, femaleHeight)
    female.delete()
    female = printableFemale
    files.push(exportFile(female, `fit_${level}_female_spring.stl`))
    female.delete()
  }
  post({ type: 'FIT_TEST_COMPLETE', files }, files.map((file) => file.buffer))
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    if (event.data.type === 'LOAD_STL') {
      post({ type: 'PROGRESS', message: 'STL 모델을 읽고 있습니다…' })
      const positions = isBinaryStl(event.data.buffer) ? parseBinary(event.data.buffer) : parseAscii(event.data.buffer)
      sourcePositions = positions.slice()
      sourceName = event.data.name
      const mesh = { name: sourceName, triangles: positions.length / 9, bounds: boundsOf(positions), positions }
      post({ type: 'STL_LOADED', mesh }, [positions.buffer])
    } else if (event.data.type === 'GENERATE_BLOCKS') {
      await generate(event.data.settings)
    } else if (event.data.type === 'GENERATE_FIT_TEST') {
      await generateFitTest()
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : '형상 생성 중 오류가 발생했습니다.')
  }
}
