import Module from 'manifold-3d'

const wasm = await Module()
wasm.setup()
const p = [
  [-20, -20, -20], [20, -20, -20], [20, 20, -20], [-20, 20, -20],
  [-20, -20, 20], [20, -20, 20], [20, 20, 20], [-20, 20, 20],
]
const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
const source = new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: new Float32Array(p.flat()), triVerts: new Uint32Array(faces.flat()) }))
const cutter = wasm.Manifold.cube([42, 42, 40 / 3], false).translate(-21, -21, -20)
let block = source.intersect(cutter)
const pin = wasm.Manifold.cylinder(8.6, 3, 3, 24).translate(0, 0, -20 / 3 - 0.6)
let withPin = block.add(pin)
const socket = wasm.Manifold.cylinder(8.2, 3.25, 3.25, 24).translate(0, 0, -20 / 3 - 0.02)
let result = withPin.subtract(socket)
const mesh = result.getMesh()
if (result.status() !== 'NoError' || mesh.triVerts.length === 0) throw new Error('Boolean result is invalid')
console.log(JSON.stringify({ status: result.status(), triangles: mesh.triVerts.length / 3, volume: result.volume().toFixed(2) }))
result.delete(); socket.delete(); withPin.delete(); pin.delete(); block.delete(); cutter.delete(); source.delete()
