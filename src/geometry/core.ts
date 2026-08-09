import type loadManifold from 'manifold-3d'
import { CONNECTOR_PROFILE, pinDiameterFor, springCellSize } from '../connectorProfile'
import { weldStlPositions } from '../stl'
import type { Bounds, ConnectorPosition, FitLevel, GeneratorSettings } from '../types'

export type GeometryModule = Awaited<ReturnType<typeof loadManifold>>
export type ManifoldSolid = InstanceType<GeometryModule['Manifold']>
export const FIT_LEVELS: FitLevel[] = [19, 20, 21]

type CoreSettings = Pick<GeneratorSettings, 'blockCount' | 'fitLevel'>

export function unitScaleFor(unit: GeneratorSettings['sourceUnit']) {
  return unit === 'inch' ? 25.4 : 1
}

export function boundsOfScaled(positions: Float32Array, scale = 1): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i + axis] * scale
      min[axis] = Math.min(min[axis], value)
      max[axis] = Math.max(max[axis], value)
    }
  }
  return { min, max }
}

export function createSourceManifold(wasm: GeometryModule, positions: Float32Array, scale: number) {
  const welded = weldStlPositions(positions, scale)
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: welded.vertices, triVerts: welded.indices })
  return { source: new wasm.Manifold(mesh), bounds: boundsOfIndexedMesh(welded.vertices, welded.indices), removedTriangles: welded.removedTriangles }
}

function boundsOfIndexedMesh(vertices: Float32Array, indices: Uint32Array): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const vertexIndex of indices) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = vertices[vertexIndex * 3 + axis]
      min[axis] = Math.min(min[axis], value)
      max[axis] = Math.max(max[axis], value)
    }
  }
  return { min, max }
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

export function planConnectors(source: ManifoldSolid, bounds: Bounds, blockCount: number) {
  const plans: ConnectorPosition[][] = []
  const { min, max } = bounds
  const p = CONNECTOR_PROFILE
  const socketDepth = p.pinHeightMm + p.socketExtraDepthMm
  const depthOffsets = [-p.pinEmbedMm * 0.9, 0.05]
  for (let depth = 0.8; depth < socketDepth; depth += 0.8) depthOffsets.push(depth)
  depthOffsets.push(socketDepth - 0.05)

  for (let interfaceIndex = 1; interfaceIndex < blockCount; interfaceIndex += 1) {
    const z = min[2] + ((max[2] - min[2]) * interfaceIndex) / blockCount
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

export function addMalePin(wasm: GeometryModule, block: ManifoldSolid, pin: ConnectorPosition, fitLevel: FitLevel) {
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

export function addSpringSocket(wasm: GeometryModule, block: ManifoldSolid, pin: ConnectorPosition) {
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

export function generateBlocksCore(
  wasm: GeometryModule,
  source: ManifoldSolid,
  bounds: Bounds,
  settings: CoreSettings,
  onBlock: (block: { solid: ManifoldSolid; index: number; topConnectorCount: number; bottomConnectorCount: number }) => void,
) {
  const blockHeight = (bounds.max[2] - bounds.min[2]) / settings.blockCount
  if (blockHeight < CONNECTOR_PROFILE.pinHeightMm + CONNECTOR_PROFILE.roofThicknessMm) {
    throw new Error('블록 한 층이 결합부보다 얇습니다. 블록 수를 줄이거나 출력 크기를 키워 주세요.')
  }
  const connectors = planConnectors(source, bounds, settings.blockCount)
  const margin = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) * 0.02 + 1
  for (let index = 0; index < settings.blockCount; index += 1) {
    const lower = bounds.min[2] + ((bounds.max[2] - bounds.min[2]) * index) / settings.blockCount
    const upper = bounds.min[2] + ((bounds.max[2] - bounds.min[2]) * (index + 1)) / settings.blockCount
    const cutter = wasm.Manifold.cube([bounds.max[0] - bounds.min[0] + margin * 2, bounds.max[1] - bounds.min[1] + margin * 2, upper - lower], false)
      .translate(bounds.min[0] - margin, bounds.min[1] - margin, lower)
    let block = source.intersect(cutter)
    cutter.delete()
    if (index < settings.blockCount - 1) for (const pin of connectors[index]) block = addMalePin(wasm, block, pin, settings.fitLevel)
    if (index > 0) for (const pin of connectors[index - 1]) block = addSpringSocket(wasm, block, pin)
    try {
      onBlock({
        solid: block,
        index,
        topConnectorCount: index < settings.blockCount - 1 ? connectors[index].length : 0,
        bottomConnectorCount: index > 0 ? connectors[index - 1].length : 0,
      })
    } finally {
      block.delete()
    }
  }
  return connectors
}

export function createFitCouponPair(wasm: GeometryModule, level: FitLevel) {
  const p = CONNECTOR_PROFILE
  const width = 14
  const baseHeight = 3
  const femaleHeight = p.pinHeightMm + p.socketExtraDepthMm + p.roofThicknessMm
  let male = wasm.Manifold.cube([width, width, baseHeight], true).translate(0, 0, baseHeight / 2)
  male = addMalePin(wasm, male, { x: 0, y: 0, z: baseHeight }, level)
  let female = wasm.Manifold.cube([width, width, femaleHeight], true).translate(0, 0, femaleHeight / 2)
  female = addSpringSocket(wasm, female, { x: 0, y: 0, z: 0 })
  const printableFemale = female.rotate(180, 0, 0).translate(0, 0, femaleHeight)
  female.delete()
  return { male, female: printableFemale }
}
