import Module from 'manifold-3d'
import { CONNECTOR_PROFILE, pinDiameterFor } from '../src/connectorProfile'
import { createFitCouponPair, FIT_LEVELS, generateBlocksCore, planConnectors, unitScaleFor } from '../src/geometry/core'
import type { Bounds } from '../src/types'

const wasm = await Module()
wasm.setup()
if (unitScaleFor('mm') !== 1 || unitScaleFor('inch') !== 25.4) throw new Error('Production unit conversion is incorrect')

const coupons = FIT_LEVELS.map((level) => {
  const { male, female } = createFitCouponPair(wasm, level)
  try {
    if (male.status() !== 'NoError' || female.status() !== 'NoError') throw new Error(`Fit ${level} produced an invalid manifold`)
    const maleMesh = male.getMesh()
    const femaleMesh = female.getMesh()
    if (!maleMesh.triVerts.length || !femaleMesh.triVerts.length) throw new Error(`Fit ${level} produced an empty mesh`)
    const diameter = pinDiameterFor(level)
    return {
      level,
      diameter: +diameter.toFixed(1),
      totalInterference: +(diameter - CONNECTOR_PROFILE.springGapMm).toFixed(2),
      perBeamDeflection: +((diameter - CONNECTOR_PROFILE.springGapMm) / 2).toFixed(3),
      maleTriangles: maleMesh.triVerts.length / 3,
      femaleTriangles: femaleMesh.triVerts.length / 3,
      maleVolume: +male.volume().toFixed(2),
      femaleVolume: +female.volume().toFixed(2),
    }
  } finally {
    male.delete()
    female.delete()
  }
})

const cubeBounds: Bounds = { min: [-20, -20, -20], max: [20, 20, 20] }
const cubeSource = wasm.Manifold.cube([40, 40, 40], true)
const cubeBlocks: Array<{ index: number; triangles: number; hasMale: boolean; hasFemale: boolean; volume: number }> = []
try {
  generateBlocksCore(wasm, cubeSource, cubeBounds, { blockCount: 3, fitLevel: 19 }, ({ solid, index, topConnectorCount, bottomConnectorCount }) => {
    const mesh = solid.getMesh()
    if (solid.status() !== 'NoError' || !mesh.triVerts.length) throw new Error(`Cube block ${index + 1} is invalid`)
    cubeBlocks.push({
      index: index + 1,
      triangles: mesh.triVerts.length / 3,
      hasMale: topConnectorCount > 0,
      hasFemale: bottomConnectorCount > 0,
      volume: +solid.volume().toFixed(2),
    })
  })
} finally {
  cubeSource.delete()
}
if (cubeBlocks.length !== 3 || !cubeBlocks[1].hasMale || !cubeBlocks[1].hasFemale) throw new Error('Production core must create a three-way cube with both connector types on the middle block')

const cylinderBounds: Bounds = { min: [-20, -20, 0], max: [20, 20, 20] }
const cylinder = wasm.Manifold.cylinder(20, 20, 20, 96)
let cylinderConnectorCount = 0
try {
  cylinderConnectorCount = planConnectors(cylinder, cylinderBounds, 2)[0].length
} finally {
  cylinder.delete()
}
if (!cylinderConnectorCount) throw new Error('Production planner found no safe cylinder connectors')

const thinNeckBounds: Bounds = { min: [-4, -20, 0], max: [4, 20, 20] }
const thinNeck = wasm.Manifold.cube([8, 40, 20], true).translate(0, 0, 10)
let thinNeckRejected = false
try {
  planConnectors(thinNeck, thinNeckBounds, 2)
} catch (error) {
  if (error instanceof Error && error.message.includes('안전하게 배치할 공간이 없습니다')) thinNeckRejected = true
  else throw error
} finally {
  thinNeck.delete()
}
if (!thinNeckRejected) throw new Error('Production planner should reject a thin-neck model')

console.log(JSON.stringify({
  status: 'NoError',
  profileVersion: CONNECTOR_PROFILE.profileVersion,
  springGap: CONNECTOR_PROFILE.springGapMm,
  coupons,
  regressions: {
    productionCore: true,
    unitScaling: true,
    cubeThreeWay: cubeBlocks,
    cylinderSafeConnectorCount: cylinderConnectorCount,
    thinNeckRejected,
  },
}))
