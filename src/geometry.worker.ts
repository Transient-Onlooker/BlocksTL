/// <reference lib="webworker" />

import Module from 'manifold-3d'
import { pinDiameterFor } from './connectorProfile'
import { boundsOfScaled, createFitCouponPair, createSourceManifold, FIT_LEVELS, generateBlocksCore, unitScaleFor } from './geometry/core'
import { isBinaryStl, parseAsciiStl, parseBinaryStl } from './stl'
import type { BlockPreview, GeneratedFile, GeneratorSettings, WorkerRequest, WorkerResponse } from './types'

const scope = self as unknown as DedicatedWorkerGlobalScope
const wasmPromise = Module().then((wasm) => {
  wasm.setup()
  return wasm
})
let sourcePositions: Float32Array | null = null
let sourceName = 'model'

function post(message: WorkerResponse, transfer?: Transferable[]) { scope.postMessage(message, transfer ?? []) }
function fail(message: string) { post({ type: 'ERROR', message }) }

function sampleSurfacePoints(positions: Float32Array, maxPoints = 160_000) {
  const triangleCount = positions.length / 9
  const targetCount = Math.min(maxPoints, Math.max(12_000, triangleCount * 3))
  let totalArea = 0
  for (let offset = 0; offset < positions.length; offset += 9) {
    const abx = positions[offset + 3] - positions[offset]
    const aby = positions[offset + 4] - positions[offset + 1]
    const abz = positions[offset + 5] - positions[offset + 2]
    const acx = positions[offset + 6] - positions[offset]
    const acy = positions[offset + 7] - positions[offset + 1]
    const acz = positions[offset + 8] - positions[offset + 2]
    totalArea += Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx) / 2
  }
  if (!Number.isFinite(totalArea) || totalArea <= 0) throw new Error('표면적이 없는 STL 모델입니다.')

  const sampled = new Float32Array(targetCount * 3)
  const areaStep = totalArea / targetCount
  let nextArea = areaStep / 2
  let accumulatedArea = 0
  let outputIndex = 0
  for (let offset = 0; offset < positions.length && outputIndex < targetCount; offset += 9) {
    const ax = positions[offset]
    const ay = positions[offset + 1]
    const az = positions[offset + 2]
    const bx = positions[offset + 3]
    const by = positions[offset + 4]
    const bz = positions[offset + 5]
    const cx = positions[offset + 6]
    const cy = positions[offset + 7]
    const cz = positions[offset + 8]
    const abx = bx - ax
    const aby = by - ay
    const abz = bz - az
    const acx = cx - ax
    const acy = cy - ay
    const acz = cz - az
    accumulatedArea += Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx) / 2
    while (nextArea <= accumulatedArea && outputIndex < targetCount) {
      const u = (outputIndex * 0.7548776662466927) % 1
      const v = (outputIndex * 0.5698402909980532 + 0.31) % 1
      const rootU = Math.sqrt(u)
      const wa = 1 - rootU
      const wb = rootU * (1 - v)
      const wc = rootU * v
      const target = outputIndex * 3
      sampled[target] = ax * wa + bx * wb + cx * wc
      sampled[target + 1] = ay * wa + by * wb + cy * wc
      sampled[target + 2] = az * wa + bz * wb + cz * wc
      outputIndex += 1
      nextArea += areaStep
    }
  }
  return outputIndex === targetCount ? sampled : sampled.slice(0, outputIndex * 3)
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

type ExportMesh = { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array }

function rasterProjection(mesh: ExportMesh, horizontalAxis: 0 | 1 | 2, verticalAxis: 0 | 1 | 2, depthAxis: 0 | 1 | 2, near: 'min' | 'max' = 'min', width = 180, height = 132) {
  const values = mesh.vertProperties
  let minHorizontal = Infinity
  let maxHorizontal = -Infinity
  let minVertical = Infinity
  let maxVertical = -Infinity
  let minDepth = Infinity
  let maxDepth = -Infinity
  for (let index = 0; index < values.length; index += mesh.numProp) {
    minHorizontal = Math.min(minHorizontal, values[index + horizontalAxis])
    maxHorizontal = Math.max(maxHorizontal, values[index + horizontalAxis])
    minVertical = Math.min(minVertical, values[index + verticalAxis])
    maxVertical = Math.max(maxVertical, values[index + verticalAxis])
    minDepth = Math.min(minDepth, values[index + depthAxis])
    maxDepth = Math.max(maxDepth, values[index + depthAxis])
  }
  const horizontalSpan = Math.max(maxHorizontal - minHorizontal, 1e-6)
  const verticalSpan = Math.max(maxVertical - minVertical, 1e-6)
  const depthSpan = Math.max(maxDepth - minDepth, 1e-6)
  const padding = 0.07
  const project = (vertexIndex: number) => {
    const base = vertexIndex * mesh.numProp
    return {
      x: padding * width + ((values[base + horizontalAxis] - minHorizontal) / horizontalSpan) * width * (1 - padding * 2),
      y: padding * height + (1 - (values[base + verticalAxis] - minVertical) / verticalSpan) * height * (1 - padding * 2),
      depth: values[base + depthAxis],
    }
  }
  const depthBuffer = new Float32Array(width * height)
  depthBuffer.fill(near === 'min' ? Infinity : -Infinity)
  const plot = (x: number, y: number, depth: number) => {
    const px = Math.max(0, Math.min(width - 1, Math.round(x)))
    const py = Math.max(0, Math.min(height - 1, Math.round(y)))
    const pixel = py * width + px
    if ((near === 'min' && depth < depthBuffer[pixel]) || (near === 'max' && depth > depthBuffer[pixel])) depthBuffer[pixel] = depth
  }

  for (let triangle = 0; triangle < mesh.triVerts.length; triangle += 3) {
    const a = project(mesh.triVerts[triangle])
    const b = project(mesh.triVerts[triangle + 1])
    const c = project(mesh.triVerts[triangle + 2])
    plot(a.x, a.y, a.depth)
    plot(b.x, b.y, b.depth)
    plot(c.x, c.y, c.depth)
    const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y)
    if (Math.abs(denominator) < 1e-5) continue
    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)))
    const maxX = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)))
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)))
    const maxY = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)))
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const wa = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / denominator
        const wb = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / denominator
        const wc = 1 - wa - wb
        if (wa >= -0.002 && wb >= -0.002 && wc >= -0.002) plot(x, y, wa * a.depth + wb * b.depth + wc * c.depth)
      }
    }
  }

  const pixels = new Uint8Array(width * height)
  for (let index = 0; index < depthBuffer.length; index += 1) {
    if (Number.isFinite(depthBuffer[index])) {
      const distanceFromViewer = near === 'min' ? (depthBuffer[index] - minDepth) / depthSpan : (maxDepth - depthBuffer[index]) / depthSpan
      pixels[index] = Math.round(235 - distanceFromViewer * 105)
    }
  }
  return { width, height, pixels }
}

function blockPreview(mesh: ExportMesh, index: number, topConnectorCount: number, bottomConnectorCount: number): BlockPreview {
  return {
    index,
    triangles: mesh.triVerts.length / 3,
    topConnectorCount,
    bottomConnectorCount,
    top: rasterProjection(mesh, 0, 1, 2, 'max'),
    bottom: rasterProjection(mesh, 0, 1, 2, 'min'),
    side: rasterProjection(mesh, 1, 2, 0, 'min'),
  }
}

function exportFile(manifold: any, name: string): GeneratedFile {
  const result = manifold.getMesh()
  return { name, buffer: binaryStl(result), triangles: result.triVerts.length / 3 }
}

async function generate(settings: GeneratorSettings) {
  if (!sourcePositions) throw new Error('먼저 STL 파일을 불러와 주세요.')
  post({ type: 'PROGRESS', message: '여러 깊이에서 결합부 안전 영역을 분석하고 있습니다…' })
  const wasm = await wasmPromise
  const modelScale = settings.objectScale * unitScaleFor(settings.sourceUnit)
  const { source, bounds, removedTriangles } = createSourceManifold(wasm, sourcePositions, modelScale)
  if (removedTriangles) post({ type: 'PROGRESS', message: `면적이 0인 삼각형 ${removedTriangles.toLocaleString()}개를 제거했습니다…` })
  const files: GeneratedFile[] = []
  try {
    post({ type: 'GENERATION_STARTED', blockCount: settings.blockCount })
    const connectors = generateBlocksCore(wasm, source, bounds, settings, ({ solid, index, topConnectorCount, bottomConnectorCount }) => {
      post({ type: 'PROGRESS', message: `블록 ${index + 1}/${settings.blockCount} 생성 중…` })
      const name = `${sourceName.replace(/\.stl$/i, '')}_block_${String(index + 1).padStart(2, '0')}.stl`
      const result = solid.getMesh() as ExportMesh
      files.push({ name, buffer: binaryStl(result), triangles: result.triVerts.length / 3 })
      const preview = blockPreview(result, index, topConnectorCount, bottomConnectorCount)
      post({ type: 'BLOCK_GENERATED', preview }, [preview.top.pixels.buffer, preview.bottom.pixels.buffer, preview.side.pixels.buffer])
    })
    post({ type: 'GENERATION_COMPLETE', files, connectors }, files.map((file) => file.buffer))
  } finally {
    source.delete()
  }
}

async function generateFitTest() {
  post({ type: 'PROGRESS', message: '19·20·21 맞춤 테스트 조각을 만들고 있습니다…' })
  const wasm = await wasmPromise
  const files: GeneratedFile[] = []
  for (const level of FIT_LEVELS) {
    const { male, female } = createFitCouponPair(wasm, level)
    files.push(exportFile(male, `fit_${level}_male_${pinDiameterFor(level).toFixed(1)}mm.stl`))
    male.delete()
    files.push(exportFile(female, `fit_${level}_female_spring.stl`))
    female.delete()
  }
  post({ type: 'FIT_TEST_COMPLETE', files }, files.map((file) => file.buffer))
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    if (event.data.type === 'LOAD_STL') {
      post({ type: 'PROGRESS', message: 'STL 모델을 읽고 있습니다…' })
      const positions = isBinaryStl(event.data.buffer) ? parseBinaryStl(event.data.buffer) : parseAsciiStl(event.data.buffer)
      const previewPositions = sampleSurfacePoints(positions)
      const mesh = { name: event.data.name, triangles: positions.length / 9, bounds: boundsOfScaled(positions), previewPositions }
      sourcePositions = positions
      sourceName = event.data.name
      post({ type: 'STL_LOADED', mesh }, [previewPositions.buffer])
    } else if (event.data.type === 'GENERATE_BLOCKS') {
      await generate(event.data.settings)
    } else if (event.data.type === 'GENERATE_FIT_TEST') {
      await generateFitTest()
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : '형상 생성 중 오류가 발생했습니다.')
  }
}
