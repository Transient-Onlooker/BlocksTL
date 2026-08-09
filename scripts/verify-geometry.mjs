import Module from 'manifold-3d'

const wasm = await Module()
wasm.setup()
const points = [
  [-20, -20, -20], [20, -20, -20], [20, 20, -20], [-20, 20, -20],
  [-20, -20, 20], [20, -20, 20], [20, 20, 20], [-20, 20, 20],
]
const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
const source = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: new Float32Array(points.flat()), triVerts: new Uint32Array(faces.flat()) }))
const lower = -20 / 3
const upper = 20 / 3
const cutter = wasm.Manifold.cube([42, 42, upper - lower], false).translate(-21, -21, lower)
let block = source.intersect(cutter)

const pinDiameter = 6
const pinHeight = 4.8
const radius = pinDiameter / 2
const leadHeight = 1
const body = wasm.Manifold.cylinder(pinHeight - leadHeight + 0.65, radius, radius, 28).translate(0, 0, upper - 0.65)
const lead = wasm.Manifold.cylinder(leadHeight, radius, radius * 0.74, 28).translate(0, 0, upper + pinHeight - leadHeight)
const pin = body.add(lead)
let next = block.add(pin)
block.delete(); block = next

const preload = 0.15
const springThickness = 0.84
const springGap = pinDiameter - preload
const cellWidth = springGap + springThickness * 2 + 1.2
const cellDepth = pinDiameter + 0.7
const socketDepth = pinHeight + 0.35
const cavity = wasm.Manifold.cube([cellWidth, cellDepth, socketDepth + 0.08], false).translate(-cellWidth / 2, -cellDepth / 2, lower - 0.04)
const entrance = wasm.Manifold.cube([cellWidth + 0.5, cellDepth + 0.5, 0.84], false).translate(-(cellWidth + 0.5) / 2, -(cellDepth + 0.5) / 2, lower - 0.04)
const socketVoid = cavity.add(entrance)
next = block.subtract(socketVoid)
block.delete(); block = next

const beamWidth = pinDiameter * 0.56
const beamLength = socketDepth - 0.36 + 0.25
const beamZ = lower + 0.36
const leftBeam = wasm.Manifold.cube([springThickness, beamWidth, beamLength], false).translate(-springGap / 2 - springThickness, -beamWidth / 2, beamZ)
const rightBeam = wasm.Manifold.cube([springThickness, beamWidth, beamLength], false).translate(springGap / 2, -beamWidth / 2, beamZ)
const springs = leftBeam.add(rightBeam)
next = block.add(springs)
block.delete(); block = next

const mesh = block.getMesh()
if (block.status() !== 'NoError' || mesh.triVerts.length === 0) throw new Error('Compliant connector result is invalid')
console.log(JSON.stringify({ status: block.status(), triangles: mesh.triVerts.length / 3, volume: block.volume().toFixed(2), springGap }))

for (const item of [springs, rightBeam, leftBeam, socketVoid, entrance, cavity, pin, lead, body, block, cutter, source]) item.delete()
